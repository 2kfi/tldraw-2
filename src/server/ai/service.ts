import { AnthropicProvider, AnthropicProviderOptions, createAnthropic } from '@ai-sdk/anthropic'
import {
	createGoogleGenerativeAI,
	GoogleGenerativeAIProvider,
	GoogleGenerativeAIProviderOptions,
} from '@ai-sdk/google'
import { createOpenAI, OpenAIProvider, OpenAIResponsesProviderOptions } from '@ai-sdk/openai'
import { LanguageModel, ModelMessage, streamText } from 'ai'
import {
	AgentModelDefinition,
	AgentModelName,
	AgentModelProvider,
	getAgentModelDefinition,
	isValidModelName,
	registerLiveModel,
} from '../../shared/agent/models'
import { log } from '../log'
import { DebugPart } from '../../shared/agent/schema/PromptPartDefinitions'
import { AgentAction } from '../../shared/agent/types/AgentAction'
import { AgentPrompt } from '../../shared/agent/types/AgentPrompt'
import { Streaming } from '../../shared/agent/types/Streaming'
import { buildMessages } from './prompt/buildMessages'
import { buildSystemPrompt } from './prompt/buildSystemPrompt'
import { getModelName } from './prompt/getModelName'
import { closeAndParseJson } from './closeAndParseJson'

export interface AgentServiceConfig {
	openaiApiKey?: string
	openaiBaseUrl?: string
	anthropicApiKey?: string
	googleApiKey?: string
}

export class AgentService {
	openai: OpenAIProvider
	anthropic: AnthropicProvider
	google: GoogleGenerativeAIProvider
	private readonly configured: Record<AgentModelProvider, boolean>
	/** Providers rejected on the most recent listLiveModels() — lets sync endpoints stay coherent. */
	lastAuthFailed: AgentModelProvider[] = []
	private readonly openaiApiKey: string | undefined
	private readonly openaiBaseUrl: string | undefined
	private readonly googleApiKey: string | undefined
	private readonly anthropicApiKey: string | undefined

	constructor(config: AgentServiceConfig) {
		this.configured = {
			openai: !!config.openaiApiKey,
			anthropic: !!config.anthropicApiKey,
			google: !!config.googleApiKey,
		}
		this.openaiApiKey = config.openaiApiKey
		this.openaiBaseUrl = config.openaiBaseUrl
		this.googleApiKey = config.googleApiKey
		this.anthropicApiKey = config.anthropicApiKey
		// ponytail: createOpenAI's baseURL accepts any OpenAI-compatible endpoint
		// (OPENAI_BASE_URL); the plan relies on this to work against proxies.
		this.openai = createOpenAI({
			apiKey: config.openaiApiKey ?? 'missing-key',
			baseURL: config.openaiBaseUrl || undefined,
		})
		this.anthropic = createAnthropic({ apiKey: config.anthropicApiKey ?? 'missing-key' })
		this.google = createGoogleGenerativeAI({ apiKey: config.googleApiKey ?? 'missing-key' })
	}

	getModel(modelName: AgentModelName): LanguageModel {
		const modelDefinition = getAgentModelDefinition(modelName)
		const provider = modelDefinition.provider
		// Surface a missing key as a clear setup error (surfaces as the AI's
		// error banner) instead of an opaque upstream 401 auth failure.
		if (!this.configured[provider]) {
			const envVar =
				provider === 'openai'
					? 'OPENAI_API_KEY'
					: provider === 'anthropic'
						? 'ANTHROPIC_API_KEY'
						: 'GOOGLE_API_KEY'
			throw new Error(
				`No ${envVar} configured for model "${modelDefinition.id}" — set the key in the server environment.`
			)
		}
		return this[provider](modelDefinition.id)
	}

	/**
	 * Models each configured provider actually serves, fetched at request time
	 * and registered so they're runnable. Best-effort: a failing provider is
	 * skipped (3s timeout); never throws — callers merge with the static
	 * definitions and surface liveFailed.
	 */
	async listLiveModels(): Promise<{
		models: { provider: AgentModelProvider; id: string; chat: boolean }[]
		liveFailed: boolean
		/** Providers whose key was actively rejected (vs unreachable) — their models must not be offered. */
		authFailed: AgentModelProvider[]
	}> {
		const models: { provider: AgentModelProvider; id: string; chat: boolean }[] = []
		let liveFailed = false
		const authFailed: AgentModelProvider[] = []
		// Google-first: cheapest good default, then OpenAI-compatible, then Anthropic.
		if (this.configured.google) {
			try {
				const res = await fetch(
					`https://generativelanguage.googleapis.com/v1beta/models?key=${this.googleApiKey}`,
					{ signal: AbortSignal.timeout(3000) }
				)
				if (res.ok) {
					const body = (await res.json()) as { models?: { name?: string }[] }
					for (const m of body.models ?? []) {
						const id = m.name?.replace(/^models\//, '')
						if (!id) continue
						const chat = isChatModel('google', id)
						if (chat) registerLiveModel(id, 'google')
						models.push({ provider: 'google', id, chat })
					}
				} else {
					liveFailed = true
					if (isAuthRejection(res.status, await res.text().catch(() => ''))) authFailed.push('google')
				}
			} catch {
				liveFailed = true
			}
		}
		if (this.configured.openai) {
			try {
				const base = (this.openaiBaseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
				const res = await fetch(`${base}/models`, {
					headers: { Authorization: `Bearer ${this.openaiApiKey}` },
					signal: AbortSignal.timeout(3000),
				})
				if (res.ok) {
					const body = (await res.json()) as { data?: { id?: string }[] }
					for (const m of body.data ?? []) {
						if (!m.id) continue
						const chat = isChatModel('openai', m.id)
						// only chat models become runnable; the rest are listed for visibility
						if (chat) registerLiveModel(m.id, 'openai')
						models.push({ provider: 'openai', id: m.id, chat })
					}
				} else {
					liveFailed = true
					if (isAuthRejection(res.status, await res.text().catch(() => ''))) authFailed.push('openai')
				}
			} catch {
				liveFailed = true
			}
		}
		// Anthropic exposes a models list (unlike at design time) — probe it so a
		// rejected ANTHROPIC_API_KEY withholds its defs like every other provider.
		const anthropicKey = this.anthropicApiKey
		if (this.configured.anthropic && anthropicKey) {
			try {
				const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
					headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
					signal: AbortSignal.timeout(3000),
				})
				if (res.ok) {
					const body = (await res.json()) as { data?: { id?: string }[] }
					for (const m of body.data ?? []) {
						if (!m.id) continue
						registerLiveModel(m.id, 'anthropic')
						models.push({ provider: 'anthropic', id: m.id, chat: true })
					}
				} else {
					liveFailed = true
					if (isAuthRejection(res.status, await res.text().catch(() => ''))) authFailed.push('anthropic')
				}
			} catch {
				liveFailed = true
			}
		}
		return { models, liveFailed, authFailed: (this.lastAuthFailed = authFailed) }
	}

	async *stream(prompt: AgentPrompt): AsyncGenerator<Streaming<AgentAction>> {
		try {
			for await (const event of this.streamActions(prompt)) {
				yield event
			}
		} catch (error: any) {
			log.error('Stream error:', error)
			throw friendlyStreamError(error)
		}
	}

	private async *streamActions(prompt: AgentPrompt): AsyncGenerator<Streaming<AgentAction>> {
		const modelName = getModelName(prompt)
		const model = this.getModel(modelName)

		if (typeof model === 'string') {
			throw new Error('Model is a string, not a LanguageModel')
		}

		const { modelId, provider } = model
		if (!isValidModelName(modelId)) {
			throw new Error(`Model ${modelId} is not in AGENT_MODEL_DEFINITIONS`)
		}

		const modelDefinition = getAgentModelDefinition(modelId)
		const systemPrompt = buildSystemPrompt(prompt)

		// The AI SDK prefers the `system` option (system-in-messages is flagged as
		// an injection risk). Anthropic is the exception: cacheControl breakpoints
		// need a system message, so it keeps one — with the SDK's opt-in flag.
		const usesSystemMessage = provider === 'anthropic.messages'
		const system = usesSystemMessage ? undefined : systemPrompt

		// Prompt messages
		const messages: ModelMessage[] = buildMessages(prompt)
		if (usesSystemMessage) {
			// Anthropic requires explicit cache breakpoints. We set one at the end of
			// the system prompt to cache all system content (which generally changes together).
			messages.unshift({
				role: 'system',
				content: systemPrompt,
				providerOptions: {
					anthropic: { cacheControl: { type: 'ephemeral' } },
				},
			})
		}

		// Check for debug flags and log if enabled
		const debugPart = prompt.debug as DebugPart | undefined
		if (debugPart) {
			if (debugPart.logSystemPrompt) {
				const promptWithoutSchema = buildSystemPrompt(prompt, { withSchema: false })
				log.debug('[DEBUG] System Prompt (without schema):\n', promptWithoutSchema)
			}
			if (debugPart.logMessages) {
				log.debug('[DEBUG] Messages:\n', JSON.stringify(messages, null, 2))
			}
		}

		// Prefill the assistant turn to force the JSON start, where the model allows it.
		// Opus 4.7+ and Sonnet 4.6 reject last-assistant-turn prefills (400), so skip it there.
		// Only anthropic/google providers accept a prefill the parse buffer can rely on;
		// OpenAI continues mid-JSON and never re-emits the prefix, so it must start empty.
		const PREFILL = '{"actions": [{"_type":'
		const canForceResponseStart =
			(provider === 'anthropic.messages' || provider === 'google.generative-ai') &&
			modelDefinition.supportsPrefill
		if (canForceResponseStart) {
			messages.push({
				role: 'assistant',
				content: PREFILL,
			})
		}

		try {
			const result = streamText({
				model,
				system,
				messages,
				allowSystemInMessages: usesSystemMessage,
				maxOutputTokens: modelDefinition.maxOutputTokens ?? 8192,
				// Opus 4.7+ removed `temperature` (and top_p/top_k); sending it returns a 400.
				...(modelDefinition.supportsTemperature ? { temperature: 0 } : {}),
				providerOptions: getProviderOptions(modelDefinition),
				onAbort() {
					log.warn('Stream actions aborted')
				},
				onError: (e) => {
					log.error('Stream text error:', e)
					throw e
				},
			})
			const { textStream } = result

			let buffer = ''
			let cursor = 0
			let maybeIncompleteAction: AgentAction | null = null

			let startTime = Date.now()

			// ponytail: closeAndParseJson is O(n) over the whole buffer, so running
			// it on every streamed chunk is O(n²). Throttle attempts to ~30ms; the
			// final flush below always parses, so trailing actions can't be dropped.
			let lastAttempt = 0
			const processBuffer = (): Streaming<AgentAction>[] => {
				// With a prefill the model continues mid-JSON, so the raw stream is
				// missing its opening `{"actions": [{"_type":` — re-attach it unless
				// the model ignored the prefill and started a fresh object itself.
				const parseInput =
					canForceResponseStart && !/^\s*\{/.test(buffer) ? PREFILL + buffer : buffer
				const partialObject = closeAndParseJson(parseInput)
				if (!partialObject) return []

				const actions = partialObject.actions
				if (!Array.isArray(actions)) return []
				if (actions.length === 0) return []

				const events: Streaming<AgentAction>[] = []
				// If the events list is ahead of the cursor, we know we've completed the current event
				// We can complete the event and move the cursor forward
				while (actions.length > cursor) {
					const action = actions[cursor] as AgentAction
					if (action) {
						// ponytail: temporary diagnostics — creates arriving without a
						// shape silently no-op in applyAction; capture the raw tail.
						if (
							(action as any)._type === 'create' &&
							!(action as any).shape
						) {
							log.warn(
								`streamActions: create without shape; raw tail: ${JSON.stringify(buffer.slice(-600))}`
							)
						}
						events.push({
							...action,
							complete: true,
							time: Date.now() - startTime,
						})
						maybeIncompleteAction = null
					}
					cursor++
				}

				// Now let's check the (potentially new) current event
				// And let's yield it in its (potentially incomplete) state
				const action = actions[cursor - 1] as AgentAction
				if (action) {
					// If we don't have an incomplete event yet, this is the start of a new one
					if (!maybeIncompleteAction) {
						startTime = Date.now()
					}

					maybeIncompleteAction = action

					// Yield the potentially incomplete event
					events.push({
						...action,
						complete: false,
						time: Date.now() - startTime,
					})
				}
				return events
			}

			for await (const text of textStream) {
				buffer += text
				const now = Date.now()
				if (now - lastAttempt < 30) continue
				lastAttempt = now
				for (const event of processBuffer()) {
					yield event
				}
			}

			// Final flush: always parse regardless of the throttle window so the
			// tail of the stream is never skipped.
			for (const event of processBuffer()) {
				yield event
			}

			// If we've finished receiving events, but there's still an incomplete event, we need to complete it.
			// (The assert defeats declaration-site narrowing: all writes to
			// maybeIncompleteAction happen inside processBuffer, so CFA thinks it's
			// still null here and would narrow `if` to never.)
			const incomplete = maybeIncompleteAction as AgentAction | null
			if (incomplete) {
				yield {
					...incomplete,
					complete: true,
					time: Date.now() - startTime,
				}
			}

			// Silent-failure guard: a stream that yields nothing (e.g. all tokens
			// eaten by thinking, or an unparseable shape) must be visible in logs.
			if (cursor === 0) {
				log.warn(
					`streamActions: 0 actions parsed (finish=${await result.finishReason}) model=${modelId}`
				)
			}
			// A token-capped stream truncates mid-JSON; closeAndParseJson auto-closes
			// it and trailing fields (e.g. a create's shape) are silently lost.
			if ((await result.finishReason) === 'length') {
				log.warn(
					`streamActions: output truncated at token limit (${modelDefinition.maxOutputTokens ?? 8192}) — raise maxOutputTokens for ${modelId}`
				)
			}
		} catch (error: any) {
			log.error('streamActions error:', error)
			throw friendlyStreamError(error)
		}
	}
}

type StreamTextProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

// ponytail: keep clearly non-text-generation ids out of the chat picker
// (embeddings, speech, image, moderation, codex, ...). A visible run error
// beats a picker full of models that can't talk; the filter is cheap.
// A provider actively rejecting the key (vs being unreachable): OpenAI 401s,
// Google returns 400 with API_KEY_INVALID in the body.
function isAuthRejection(status: number, bodyText: string): boolean {
	return status === 401 || status === 403 || (status === 400 && /API_KEY/i.test(bodyText))
}

function friendlyStreamError(error: any): Error {
	const status = error?.statusCode
	const body = String(error?.responseBody ?? error?.message ?? '')
	if (isAuthRejection(status ?? 0, body)) {
		return new Error(
			'The AI provider rejected the API key — fix OPENAI_API_KEY / GOOGLE_API_KEY in your server .env (note: docker env_file does not expand ${VARS}).'
		)
	}
	return error
}

function isChatModel(provider: AgentModelProvider, id: string): boolean {
	if (provider === 'google') {
		// Blocklist of non-generateContent families. Everything else that serves
		// text chat over v1beta generateContent passes (gemini-*, gemma-*, …).
		// ponytail: new Google model families may need adding here if they 400.
		return !/embedding|imagen|image|audio|tts|veo|lyria|aqa|nano-banana|\blive\b|computer-use|robotics|deep-research|customtools/i.test(
			id
		)
	}
	return !/embedding|whisper|tts|dall.?e|audio|realtime|moderation|transcrib|translat|speech|image|codex/i.test(id)
}

/**
 * Map a model definition's reasoning preferences to AI SDK provider options.
 * Only the matching provider's options are set; the SDK ignores the rest.
 */
function getProviderOptions(definition: AgentModelDefinition): StreamTextProviderOptions {
	switch (definition.provider) {
		case 'anthropic':
			return {
				anthropic: {
					thinking:
						definition.thinking === 'adaptive' ? { type: 'adaptive' } : { type: 'disabled' },
					...(definition.effort ? { effort: definition.effort } : {}),
				} satisfies AnthropicProviderOptions,
			}
		case 'google':
			return {
				google: {
					thinkingConfig: { thinkingLevel: definition.thinkingLevel },
				} satisfies GoogleGenerativeAIProviderOptions,
			}
		case 'openai':
			return {
				openai: {
					reasoningEffort: definition.reasoningEffort,
				} satisfies OpenAIResponsesProviderOptions,
			}
	}
}