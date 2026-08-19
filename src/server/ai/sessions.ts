import { atom } from '@tldraw/state'
import { createTLStore } from '@tldraw/editor'
import { TLSyncClient } from '@tldraw/sync-core'
import type { TLPersistentClientSocket, TLSocketRoom, TLSocketStatusChangeEvent, WebSocketMinimal } from '@tldraw/sync-core'
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import {
	Box,
	Editor,
	defaultAddFontsFromNode,
	defaultBindingUtils,
	defaultShapeUtils,
	tipTapDefaultExtensions,
} from 'tldraw'
import type { BoxModel, TLShape, TLShapeId } from 'tldraw'
import { AI_STATE_ID, createDefaultAiState, schema } from '../../shared/schema'
import type { AiState } from '../../shared/schema'
import type { UnknownRecord } from '@tldraw/store'
import type { SessionMeta } from '../sync'
import type { UserInfo } from '../../shared/types'
import { createSessionId } from '../../shared/ids'
import { DEFAULT_MODEL_NAME, isValidModelName } from '../../shared/agent/models'
import type { AgentModelName } from '../../shared/agent/models'
import { convertTldrawShapeToBlurryShape } from '../../shared/agent/format/convertTldrawShapeToBlurryShape'
import {
	convertTldrawIdToSimpleId,
	convertTldrawShapeToFocusedShape,
} from '../../shared/agent/format/convertTldrawShapeToFocusedShape'
import type { AgentAction } from '../../shared/agent/types/AgentAction'
import type { AgentPrompt } from '../../shared/agent/types/AgentPrompt'
import type { ChatHistoryItem } from '../../shared/agent/types/ChatHistoryItem'
import type { ContextItem } from '../../shared/agent/types/ContextItem'
import type { PromptPart } from '../../shared/agent/types/PromptPart'
import type { SimpleShapeId } from '../../shared/agent/types/ids-schema'
import type { BlurryShape } from '../../shared/agent/format/BlurryShape'
import type { AgentLike } from './agent'
import type { AgentActionUtil } from './actions/AgentActionUtil'
import { getAgentActionUtilsRecordForMode } from './actions'
import { AgentHelpers } from './helpers'
import { AgentService } from './service'
import { installDomStubs, makeContainer } from './domStubs'
import { resetStaleAiState } from './lock'

const AI_USER: UserInfo = { id: 'ai', name: 'AI', color: '#3182ed' }
const AI_MODE = 'idling'
const RUN_TIMEOUT_MS = 120_000
const MAX_CONVERSATION = 50
const POLL_MS = 250
// ponytail: cap blurry shapes in the prompt so huge boards stay cheap
const MAX_BLURRY_SHAPES = 40

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms))
}

function readableError(e: unknown): string {
	if (e instanceof Error) return e.message
	// Some providers (AI SDK error rethrow) surface the raw error body as a
	// plain object like { error: { error: { message } } }.
	const anyErr = e as { error?: { error?: { message?: unknown }; message?: unknown }; message?: unknown }
	const m = anyErr?.error?.error?.message ?? anyErr?.error?.message ?? anyErr?.message
	return typeof m === 'string' ? m : String(e)
}

/**
 * Bounds an async generator to a wall-clock timeout (created once, so it's a
 * total-run deadline, not a per-event idle). `source.return()` in finally gives
 * providers a chance to release the stream. An optional signal aborts early.
 */
async function* withTimeout<T>(
	source: AsyncGenerator<T>,
	ms: number,
	signal?: AbortSignal
): AsyncGenerator<T> {
	let timedOutTimer: NodeJS.Timeout | null = null
	const timedOut = new Promise<never>((_, reject) => {
		timedOutTimer = setTimeout(() => reject(new Error('Agent run timed out')), ms)
	})
	const abortHandler = () => { throw new Error('Agent run aborted') }
	const aborted = new Promise<never>((_, reject) => {
		signal?.addEventListener('abort', abortHandler, { once: true })
	})
try {
	while (true) {
		const result = await Promise.race([source.next(), timedOut, aborted])
		if (result.done) break
		yield result.value
	}
} finally {
	if (timedOutTimer) clearTimeout(timedOutTimer)
	if (signal) signal.removeEventListener('abort', abortHandler)
	await (source as any).return?.()
}
}

// ============================================================================
// In-process socket bridge. The AI session is a TLSyncClient inside the server
// process; instead of a loopback ws:// connection (plan §9.3) we pair a
// WebSocketMinimal (server side, for TLSocketRoom) with a TLPersistentClientSocket
// (client side, for TLSyncClient) and forward messages between them.
// ============================================================================

type ServerMessageEvent = { data: string }
type Listener = (event: any) => void

class BridgeClientSocket implements TLPersistentClientSocket<object, object> {
	connectionStatus: 'error' | 'offline' | 'online' = 'online'
	private receive = new Set<(msg: object) => void>()
	private status = new Set<(e: TLSocketStatusChangeEvent) => void>()
	private serverSide: BridgeServerSocket | null = null

	setServer(socket: BridgeServerSocket) {
		this.serverSide = socket
	}
	sendMessage(msg: object) {
		if (this.serverSide && this.connectionStatus === 'online') {
			this.serverSide.deliverFromClient(JSON.stringify(msg))
		}
	}
	onReceiveMessage = (cb: (msg: object) => void) => {
		this.receive.add(cb)
		return () => this.receive.delete(cb)
	}
	onStatusChange = (cb: (e: TLSocketStatusChangeEvent) => void) => {
		this.status.add(cb)
		return () => this.status.delete(cb)
	}
	restart() {
		// ponytail: in-process bridge never drops; a restart is a no-op
	}
	close() {
		this.serverSide?.closeFromClient()
	}
	// bridge internals
	deliverFromServer(data: string) {
		for (const cb of this.receive) cb(JSON.parse(data))
	}
	setStatus(status: 'error' | 'offline' | 'online', reason?: string) {
		this.connectionStatus = status
		const event: TLSocketStatusChangeEvent =
			status === 'error' ? { status, reason: reason ?? 'bridge closed' } : { status }
		for (const cb of this.status) cb(event)
	}
}

class BridgeServerSocket implements WebSocketMinimal {
	readyState = 1
	private listeners: Record<'message' | 'close' | 'error', Set<Listener>> = {
		message: new Set(),
		close: new Set(),
		error: new Set(),
	}
	private clientSide: BridgeClientSocket | null = null

	setClient(socket: BridgeClientSocket) {
		this.clientSide = socket
	}
	addEventListener(type: 'message' | 'close' | 'error', listener: Listener) {
		this.listeners[type].add(listener)
	}
	removeEventListener(type: 'message' | 'close' | 'error', listener: Listener) {
		this.listeners[type].delete(listener)
	}
	send(data: string) {
		this.clientSide?.deliverFromServer(data)
	}
	close(code = 1000, reason = '') {
		if (this.readyState !== 1) return
		this.readyState = 3
		this.clientSide?.setStatus('offline')
		for (const cb of this.listeners.close) cb({ code, reason })
	}
	deliverFromClient(data: string) {
		if (this.readyState !== 1) return
		for (const cb of this.listeners.message) cb({ data } satisfies ServerMessageEvent)
	}
	closeFromClient() {
		this.close(1000, 'client closed')
	}
}

// ============================================================================
// Session
// ============================================================================

interface SessionOptions {
	roomId: string
	db: Database
	service: AgentService
}

export class AiSession {
	private readonly roomId: string
	private readonly db: Database
	private readonly service: AgentService
	private readonly bridgeClient = new BridgeClientSocket()
	private readonly bridgeServer = new BridgeServerSocket()

	private client: TLSyncClient<any, any> | null = null
	// ponytail: TLSyncClient hides its store from the public type; keep a ref to
	// the local store we hand it (get/put are schema-validated at the boundary).
	private syncStore: any = null
	private editor: Editor | null = null
	private agent: AgentLike | null = null
	private utils: Record<string, AgentActionUtil<AgentAction>> | null = null
	private helpers: AgentHelpers | null = null
	private running = false
	private stop = false
	private stopRequested = false
	private runAbort: AbortController | null = null
	private loadedResolve: (() => void) | null = null
	private streamingTimer: NodeJS.Timeout | null = null
	private pendingStreamingText = ''
	private attached = false

	constructor(opts: SessionOptions) {
		this.roomId = opts.roomId
		this.db = opts.db
		this.service = opts.service
		this.bridgeClient.setServer(this.bridgeServer)
		this.bridgeServer.setClient(this.bridgeClient)
	}

	/**
	 * Register the server side of the bridge with the room before the client
	 * sends its 'connect' handshake, then start the poll loop.
	 */
	attach(room: TLSocketRoom<UnknownRecord, SessionMeta>) {
		if (this.attached) return
		this.attached = true
		room.handleSocketConnect({
			sessionId: createSessionId(),
			socket: this.bridgeServer,
			isReadonly: false,
			meta: { user: AI_USER },
		})
		this.runLoop()
	}

	destroy() {
		this.stop = true
		// Abort an in-flight run so the provider stream stops (no more billing)
		// and a re-materialized room can't double-run the same prompt.
		this.runAbort?.abort()
		if (this.streamingTimer) clearTimeout(this.streamingTimer)
		try {
			this.editor?.dispose()
		} catch {
			// ponytail: headless editor teardown is best-effort
		}
		this.bridgeServer.close(1000, 'session destroyed')
		try {
			this.client?.close()
		} catch {
			// best-effort
		}
	}

	/** User-facing cancel: stop the in-flight run and release the lock. The
	 * runPrompt catch sees the aborted signal and returns without writing an
	 * error, so the reset here is what users observe. */
	cancel() {
		this.runAbort?.abort()
		this.stopRequested = true
		this.running = false
		if (this.streamingTimer) {
			clearTimeout(this.streamingTimer)
			this.streamingTimer = null
		}
		this.pendingStreamingText = ''
		const cur = this.getAiState()
		if (cur && (cur.status === 'pending' || cur.status === 'running')) {
			this.putAiState({
				...cur,
				status: 'idle',
				streamingText: '',
				error: null,
				lockedBy: null,
				lockedByName: null,
				prompt: null,
				promptModel: null,
				promptSelection: null,
				promptViewport: null,
			})
		}
	}

	private get store() {
		return this.syncStore
	}

	private getAiState(): AiState | undefined {
		return this.store?.get(AI_STATE_ID as any) as AiState | undefined
	}

	private putAiState(state: AiState) {
		this.store?.put([state] as any)
	}

	private async ensureMounted() {
		if (this.editor) return
		installDomStubs()
		const store = createTLStore({ schema })
		const loaded = new Promise<void>((r) => (this.loadedResolve = r))
		const client = new TLSyncClient({
			store,
			socket: this.bridgeClient,
			presence: atom('ai-presence', null),
			presenceMode: atom('ai-presence-mode', 'full'),
			onLoad: () => this.loadedResolve?.(),
			onSyncError: (err) => console.error(`[ai] room ${this.roomId} sync error`, err),
		})
		this.client = client
		this.syncStore = store
		await Promise.race([
			loaded,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('TLSyncClient failed to load within 15s')), 15_000)
			),
		])
		if (!store.get(AI_STATE_ID as any)) {
			store.put([createDefaultAiState()] as any)
		}
		const editor = new Editor({
			store,
			shapeUtils: defaultShapeUtils,
			bindingUtils: defaultBindingUtils,
			tools: [],
			getContainer: () => makeContainer(),
			textOptions: {
				addFontsFromNode: defaultAddFontsFromNode,
				tipTapConfig: { extensions: tipTapDefaultExtensions },
			},
		})
		this.editor = editor
		const agent: AgentLike = {
			editor,
			chatOrigin: { getOrigin: () => ({ x: 0, y: 0 }) },
			schedule: () => {},
			interrupt: () => {},
			requests: { getScheduledRequest: () => null },
			todos: { push: () => {}, update: () => {}, getTodos: () => [] },
		}
		this.agent = agent
		this.utils = getAgentActionUtilsRecordForMode(agent, AI_MODE)
		this.helpers = new AgentHelpers(agent)
	}

	private async runLoop() {
		try {
			await this.ensureMounted()
			while (!this.stop) {
				const aiState = this.getAiState()
				if (aiState?.status === 'pending') {
					await this.runPrompt(aiState)
				} else if (aiState?.status === 'running' && !this.running) {
					// stale lock left behind by a crashed run
					this.putAiState(resetStaleAiState(aiState))
				} else {
					await sleep(POLL_MS)
				}
			}
		} catch (error) {
			console.error(`[ai] room ${this.roomId} session loop error`, error)
		}
	}

	private resolveModel(promptModel: string | null): AgentModelName {
		if (promptModel && isValidModelName(promptModel)) return promptModel
		const envDefault = process.env.OPENAI_DEFAULT_MODEL
		if (envDefault && isValidModelName(envDefault)) return envDefault
		// Fall back to a model for a provider the operator actually configured,
		// so an OpenAI-only (or Google-only) setup works without an env default.
		if (process.env.GOOGLE_API_KEY) return 'gemini-3.5-flash'
		if (process.env.OPENAI_API_KEY) return 'gpt-5.4-mini'
		return DEFAULT_MODEL_NAME
	}

	private buildPrompt(aiState: AiState, modelName: AgentModelName): AgentPrompt {
		const editor = this.editor!
		const contextItems: ContextItem[] = []
		const selectedShapes: SimpleShapeId[] = (aiState.promptSelection ?? []) as SimpleShapeId[]
		for (const simpleId of selectedShapes) {
			const shape = editor.getShape(`shape:${simpleId}` as TLShapeId)
			if (!shape) continue
			try {
				contextItems.push({ type: 'shape', shape: convertTldrawShapeToFocusedShape(editor, shape), source: 'user' })
			} catch {
				// ponytail: skip shapes the converter can't handle
			}
		}

		const viewport = aiState.promptViewport as BoxModel | null
		let blurryShapes: BlurryShape[] = []
		if (viewport) {
			const bounds = new Box(viewport.x, viewport.y, viewport.w, viewport.h)
			const inView = editor
				.getCurrentPageShapes()
				.filter((s: TLShape) => {
					const b = editor.getShapeMaskedPageBounds(s)
					return b && b.collides(bounds)
				})
				.slice(0, MAX_BLURRY_SHAPES)
			blurryShapes = inView
				.map((s) => convertTldrawShapeToBlurryShape(editor, s))
				.filter((b): b is BlurryShape => b !== null)
		}

		const history: ChatHistoryItem[] = aiState.conversation.map((m) => ({
			type: 'prompt',
			promptSource: m.role === 'user' ? 'user' : 'self',
			agentFacingMessage: m.content,
			userFacingMessage: m.content,
			contextItems: [],
			selectedShapes: [],
		}))

		const partTypes: PromptPart['type'][] = [
			'mode',
			'messages',
			'chatHistory',
			'contextItems',
			'selectedShapes',
			'userViewportBounds',
			'blurryShapes',
			'time',
			'modelName',
		]
		return {
			mode: {
				type: 'mode',
				modeType: AI_MODE,
				partTypes,
				actionTypes: Object.keys(this.utils!) as AgentAction['_type'][],
			},
			messages: { type: 'messages', agentMessages: [aiState.prompt ?? ''], requestSource: 'user' },
			chatHistory: { type: 'chatHistory', history },
			contextItems: { type: 'contextItems', items: contextItems, requestSource: 'user' },
			selectedShapes: { type: 'selectedShapes', shapeIds: selectedShapes },
			userViewportBounds: { type: 'userViewportBounds', userBounds: viewport },
			blurryShapes: { type: 'blurryShapes', shapes: blurryShapes },
			time: { type: 'time', time: new Date().toISOString() },
			modelName: { type: 'modelName', modelName },
			// ponytail: the kit's AgentPrompt type requires every part; buildMessages
			// and buildSystemPrompt only read the parts that are present.
		} as unknown as AgentPrompt
	}

	private scheduleStreamingText(text: string) {
		this.pendingStreamingText = text
		if (this.streamingTimer) return
		// write the first chunk immediately, then coalesce follow-ups
		const cur = this.getAiState()
		if (cur && cur.status === 'running') {
			this.putAiState({ ...cur, streamingText: text })
		}
		this.streamingTimer = setTimeout(() => {
			this.streamingTimer = null
			const latest = this.getAiState()
			if (latest) this.putAiState({ ...latest, streamingText: this.pendingStreamingText })
		}, 150)
	}

	private flushStreamingText() {
		if (this.streamingTimer) {
			clearTimeout(this.streamingTimer)
			this.streamingTimer = null
		}
		const cur = this.getAiState()
		if (cur && cur.streamingText !== '') {
			this.putAiState({ ...cur, streamingText: this.pendingStreamingText })
		}
	}

	private async runPrompt(start: AiState) {
		this.running = true
		this.runAbort = new AbortController()
		let assistantText = ''
		try {
			// Check if a cancel was requested during the pending->running window
			if (this.stopRequested) return
			this.stopRequested = false
			this.putAiState({ ...start, status: 'running', streamingText: '', error: null })
			const prompt = this.buildPrompt(start, this.resolveModel(start.promptModel))
			const events = withTimeout(this.service.stream(prompt), RUN_TIMEOUT_MS, this.runAbort.signal)
			for await (const event of events) {
				if (event._type === 'message') {
					assistantText = (event as any).text ?? ''
					this.scheduleStreamingText(assistantText)
					continue
				}
				if (!event.complete) continue
				const util = this.utils?.[event._type]
				if (!util) continue
				try {
					const sanitized = util.sanitizeAction(event, this.helpers!)
					if (sanitized) await util.applyAction(sanitized, this.helpers!, this.runAbort.signal)
				} catch (error) {
					console.error(`[ai] room ${this.roomId} failed to apply ${event._type}`, error)
				}
			}
			this.flushStreamingText()
			const finalText = assistantText.trim() || 'Done.'
			const cur = this.getAiState()!
			if (cur.status === 'pending') {
				// A new prompt queued mid-run: keep it pending and just append this
				// reply. The loop picks the queued prompt up next and runs it fresh,
				// so both prompts end up answered in order.
				this.putAiState({
					...cur,
					conversation: [...cur.conversation, { role: 'assistant' as const, content: finalText }].slice(-MAX_CONVERSATION),
				})
			} else {
				this.putAiState({
					...cur,
					status: 'idle',
					streamingText: '',
					error: null,
					conversation: [...cur.conversation, { role: 'assistant' as const, content: finalText }].slice(-MAX_CONVERSATION),
					lockedBy: null,
					lockedByName: null,
					prompt: null,
					promptModel: null,
					promptSelection: null,
					promptViewport: null,
				})
			}
		} catch (error) {
			if (this.runAbort?.signal.aborted) return
			this.flushStreamingText()
			const cur = this.getAiState() ?? start
			this.putAiState({
				...cur,
				status: 'error',
				streamingText: '',
				error: readableError(error),
				lockedBy: null,
				lockedByName: null,
			})
		} finally {
			this.runAbort = null
			this.running = false
		}
	}
}

// ============================================================================
// Manager
// ============================================================================

export class SessionManager {
	private readonly sessions = new Map<string, AiSession>()

	constructor(
		private readonly service: AgentService,
		private readonly db: Database
	) {}

	/** Called when a room first materializes. Connects the AI client + loop. */
	ensureSession(roomId: string, room: TLSocketRoom<UnknownRecord, SessionMeta>) {
		let session = this.sessions.get(roomId)
		if (!session) {
			session = new AiSession({ roomId, db: this.db, service: this.service })
			this.sessions.set(roomId, session)
		}
		session.attach(room)
		return session
	}

	destroySession(roomId: string) {
		const session = this.sessions.get(roomId)
		if (session) {
			session.destroy()
			this.sessions.delete(roomId)
		}
	}

	/** Idempotent user-facing cancel: no-ops if the room has no live session. */
	cancelSession(roomId: string) {
		this.sessions.get(roomId)?.cancel()
	}

	stop() {
		for (const roomId of [...this.sessions.keys()]) this.destroySession(roomId)
	}
}