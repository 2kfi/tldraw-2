import { Suspense, lazy, memo, useEffect, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import type { Editor } from 'tldraw'
import { useValue } from 'tldraw'
import { AI_STATE_ID, MAX_AI_QUEUE_LENGTH, createDefaultAiState } from '../../shared/schema'
import type { AiQueuedPrompt, AiState } from '../../shared/schema'
import type { AiModelInfo, AiModelsResponse } from '../../shared/types'
import { useUser } from '../lib/user'
import { api } from '../lib/api'
import { captureViewportScreenshot, getAiContext } from './aiContext'
import { usePanelSlide } from '../lib/usePanelSlide'
import { useFocusTrap } from '../lib/useFocusTrap'

// react-markdown is the heaviest dep on this path — split it so the panel
// shell (and the room) paint before the parser arrives.
const ReactMarkdown = lazy(() => import('react-markdown'))

const MODEL_KEY = 't2.aiModel'
const SHOT_KEY = 't2.aiScreenshot'
// Single shared default (server advertises its own via defaultModel; this is
// only the pre-fetch fallback): Google-first.
const DEFAULT_MODEL = 'gemini-3.5-flash'

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  google: 'Google',
  anthropic: 'Anthropic',
}

// The agent can create/move/label/delete shapes, draw with the pen, align,
// distribute, stack, recolor, and count shapes — pick suggestions that exercise
// those verbs.
const SUGGESTIONS = ['Draw a flowchart for login', 'Label my shapes', 'Group these by color']

function groupModels(models: AiModelInfo[]): [string, AiModelInfo[]][] {
  const groups = new Map<string, AiModelInfo[]>()
  for (const m of models) {
    const list = groups.get(m.provider)
    if (list) list.push(m)
    else groups.set(m.provider, [m])
  }
  return [...groups.entries()]
}

function BotGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="7" width="14" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7V4.2M12 4.2h1.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="9.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="14.5" cy="12" r="1.2" fill="currentColor" />
      <path d="M9.5 15.4h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 10) return 'now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// Action labels the agent emits look like "**Drew:**" / "**Labeled:**" — render
// the leading bold "Label:" part as a small chip, leave prose emphasis alone.
const markdownComponents: Components = {
  strong({ children }) {
    const first = Array.isArray(children) ? children[0] : children
    if (typeof first === 'string' && first.endsWith(':')) {
      return <span className="ai-chip">{children}</span>
    }
    return <strong>{children}</strong>
  },
}

// Memoized so a streaming flush only re-parses the streaming bubble, not the
// whole conversation. `tick` busts the memo every 30s so "5m ago" advances.
const ChatMessage = memo(function ChatMessage({
  role,
  content,
  name,
  color,
  ts,
  tick,
}: {
  role: string
  content: string
  name?: string
  color?: string
  ts: number
  tick?: number
}) {
  const me = useUser()
  const isUser = role === 'user'
  // Fall back to the local viewer's identity for messages sent before authors
  // were stamped onto conversation entries.
  const author = isUser ? (name ?? me.name) : 'AI'
  return (
    <div className={`ai-msg ai-${role}`}>
      {isUser ? (
        <span className="ai-avatar" style={{ background: color ?? me.color }} aria-hidden="true">
          {author[0] ?? '?'}
        </span>
      ) : (
        <span className="ai-avatar ai-avatar-bot" aria-hidden="true">
          <BotGlyph />
        </span>
      )}
      <div className="ai-msg-main">
        <div className="ai-msg-meta">
          <span className="ai-msg-name">{author}</span>
          <span className="ai-msg-time">{timeAgo(ts)}</span>
        </div>
        <div className="ai-msg-body">
          <Suspense fallback={<p>{content}</p>}>
            <ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>
          </Suspense>
        </div>
      </div>
    </div>
  )
})

export function AIPanel({
  roomId,
  editor,
  open,
  onClose,
}: {
  roomId: string
  editor: Editor
  open: boolean
  onClose: () => void
}) {
  const store = editor.store
  const me = useUser()
  const panelRef = useRef<HTMLDivElement>(null)
  usePanelSlide(panelRef, 'left', open)
  // Focus trap matches the share modal: Escape closes, Tab wraps, focus
  // returns to the toggle when the panel closes.
  useFocusTrap(panelRef, open, onClose)
  // ponytail: aiState is validated by the schema at the sync boundary; the
  // store's branded RecordId types don't know our custom records, so cast here.
  const getAi = () => store.get(AI_STATE_ID as any) as AiState | undefined
  const putAi = (state: AiState) => store.put([state] as any)
  const aiState = useValue('aiState', getAi, [store])
  const [models, setModels] = useState<AiModelInfo[]>([])
  const [modelsFailed, setModelsFailed] = useState(false)
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? '')
  const [serverDefault, setServerDefault] = useState(DEFAULT_MODEL)
  const [input, setInput] = useState('')
  const [includeShot, setIncludeShot] = useState(() => localStorage.getItem(SHOT_KEY) === '1')
  const [resumeText, setResumeText] = useState<string | null>(null)
  // Re-render periodically so relative timestamps ("5m ago") keep advancing.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000)
    return () => window.clearInterval(id)
  }, [open])
  const chatRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  // The conversation has no timestamps; stamp each message on first sight so
  // relative times stay stable across re-renders and streaming.
  const tsByIndex = useRef<number[]>([])

  useEffect(() => {
    let cancelled = false
    const apply = (list: AiModelInfo[], fallback?: string) => {
      if (cancelled) return
      setModels(list)
      if (fallback) setServerDefault(fallback)
      // Prefer the server's shared default over models[0]: the picker and the
      // runner agree, and a persisted id that is now chat:false still falls back.
      const want = fallback ?? list.find((m) => m.chat !== false)?.id ?? DEFAULT_MODEL
      setModel((prev) => (list.some((m) => m.id === prev && m.chat !== false) ? prev : want))
    }
    api<AiModelsResponse>('/api/ai/models/live')
      .then((res) => apply(res.models, res.defaultModel))
      .catch(() => {
        // Live list unavailable: fall back to the static endpoint behavior.
        api<AiModelsResponse>('/api/ai/models')
          .then((res) => apply(res.models, res.defaultModel))
          .catch(() => {
            if (!cancelled) {
              setModels([])
              setModelsFailed(true)
            }
          })
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (model) localStorage.setItem(MODEL_KEY, model)
  }, [model])

  useEffect(() => {
    localStorage.setItem(SHOT_KEY, includeShot ? '1' : '0')
  }, [includeShot])

  useEffect(() => {
    if (!store.get(AI_STATE_ID as any)) putAi(createDefaultAiState())
  }, [store])

  // Follow new content only when already near the bottom — don't yank the
  // scroll position away from someone who scrolled up to read. Skipped while
  // closed: scrollHeight/scrollTop reads force sync layout per stream chunk.
  useEffect(() => {
    if (!open) return
    const el = chatRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [aiState?.conversation, aiState?.streamingText, open])

  const conversation = aiState?.conversation ?? []
  const queue: AiQueuedPrompt[] = Array.isArray((aiState as any)?.queue) ? ((aiState as any).queue as AiQueuedPrompt[]) : []
  const running = aiState?.status === 'pending' || aiState?.status === 'running'
  const queueFull = queue.length >= MAX_AI_QUEUE_LENGTH
  // Queueing stays open while running — submits append instead of overwriting.
  const canSubmit = !queueFull

  const modelsUnavailable = modelsFailed && models.length === 0
  const modelName = modelsUnavailable
    ? 'models unavailable'
    : models.find((m) => m.id === model)?.name ?? (model || serverDefault)
  const statusLine = aiState?.error
    ? 'Error'
    : running
      ? queue.length > 0
        ? `thinking… +${queue.length} queued`
        : 'thinking…'
      : queue.length > 0
        ? `${queue.length} queued`
        : 'ready'

  function tsFor(i: number): number {
    if (tsByIndex.current[i] === undefined) tsByIndex.current[i] = Date.now()
    return tsByIndex.current[i]!
  }

  async function enqueue(textOverride?: string) {
    const text = (textOverride ?? input).trim()
    if (!text || queueFull) return
    const ctx = getAiContext(editor)
    const screenshot = includeShot ? await captureViewportScreenshot(editor) : null
    const cur = getAi() ?? createDefaultAiState()
    const curQueue: AiQueuedPrompt[] = Array.isArray((cur as any).queue) ? [...(cur as any).queue] : []
    if (curQueue.length >= MAX_AI_QUEUE_LENGTH) return
    const item: AiQueuedPrompt = {
      id: crypto.randomUUID(),
      prompt: text,
      promptModel: model || null,
      promptSelection: ctx.selection,
      promptViewport: ctx.viewport,
      includeScreenshot: includeShot,
      ...(screenshot ? { screenshot } : {}),
      by: me.id,
      byName: me.name,
      byColor: me.color,
      queuedAt: Date.now(),
    }
    curQueue.push(item)
    const nextConversation = [...cur.conversation, { role: 'user' as const, content: text, name: me.name, color: me.color }].slice(-50)
    if (cur.status === 'idle' || cur.status === 'error') {
      putAi({
        ...cur,
        lockedBy: me.id,
        lockedByName: me.name,
        status: 'pending',
        streamingText: '',
        error: null,
        conversation: nextConversation,
        prompt: null,
        promptModel: null,
        promptSelection: null,
        promptViewport: null,
        queue: curQueue,
      })
    } else {
      // Single-flight executor keeps running; this just appends in order.
      putAi({ ...cur, status: 'pending', conversation: nextConversation, queue: curQueue })
    }
    setResumeText(null)
    if (textOverride === undefined) setInput('')
  }

  function submit() {
    void enqueue()
  }

  function lastUserText(): string | null {
    for (let i = conversation.length - 1; i >= 0; i--) {
      if (conversation[i]!.role === 'user') return conversation[i]!.content
    }
    return null
  }

  function retry() {
    const text = lastUserText()
    if (text) void enqueue(text)
  }

  function resume() {
    const text = resumeText ?? lastUserText()
    if (text) void enqueue(text)
  }

  async function stop() {
    const text = lastUserText()
    if (text) setResumeText(text)
    try {
      await api(`/api/rooms/${roomId}/ai/cancel`, { method: 'POST' })
      const cur = getAi()
      if (cur) putAi({ ...cur, status: 'idle', error: null, streamingText: '', lockedBy: null, lockedByName: null, prompt: null, promptModel: null, promptSelection: null, promptViewport: null })
    } catch (error) {
      console.error('[ai] cancel request failed:', error)
    }
  }

  function clearConversation() {
    // Explicit: clearing wipes the shared history + pending queue for everyone.
    if (!window.confirm('Clear the AI conversation and pending queue for everyone in this room?')) return
    tsByIndex.current = []
    setResumeText(null)
    const cur = getAi()
    if (cur) putAi({ ...cur, conversation: [], streamingText: '', error: null, status: 'idle', lockedBy: null, lockedByName: null, prompt: null, promptModel: null, promptSelection: null, promptViewport: null, queue: [] })
  }

  function useSuggestion(text: string) {
    setInput(text)
    promptRef.current?.focus()
  }

  const footerStatus = aiState?.error
    ? 'Error: ' + aiState.error
    : queueFull
      ? `Queue is full (${MAX_AI_QUEUE_LENGTH}). Wait for a run to finish.`
      : running && queue.length > 0
        ? `${queue.length} prompt${queue.length === 1 ? '' : 's'} waiting behind this run.`
        : ''

  const showResume = !running && !aiState?.error && !!resumeText && conversation.length > 0

  return (
    <aside className="ai-panel" ref={panelRef} aria-label="AI assistant" tabIndex={-1}>
      <div className="ai-panel-header">
        <div className="ai-panel-title">
          <span className="ai-panel-name">AI assistant</span>
          <div className="ai-title-actions">
            <button className="ai-clear" onClick={clearConversation} disabled={conversation.length === 0 && queue.length === 0} title="Clear the conversation and pending queue for everyone">
              Clear
            </button>
            <button className="ai-close" onClick={onClose} title="Close" aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        <div className="ai-model-row">
          <select
            className="ai-input ai-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Model"
          >
            {modelsUnavailable && (
              <option value="" disabled>
                Models unavailable
              </option>
            )}
            {groupModels(models).map(([provider, list]) => (
              <optgroup key={provider} label={PROVIDER_LABELS[provider] ?? provider}>
                {list.map((m) => (
                  <option key={m.id} value={m.id} disabled={m.chat === false}>
                    {m.known ? m.name : `${m.id} (live)`}
                    {m.chat === false ? ' — unsupported' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span
            className={`ai-statusline${aiState?.error ? ' ai-statusline-error' : running ? ' ai-statusline-thinking' : ''}`}
          >
            {modelName} · {statusLine}
          </span>
        </div>
      </div>

      <div className="ai-chat" ref={chatRef} role="log" aria-live="polite" aria-label="AI conversation">
        {queue.length > 0 && (
          <div className="ai-queue" aria-label="Pending prompts">
            {queue.map((q, i) => (
              <span key={q.id} className={`ai-queue-chip${q.by === me.id ? ' ai-queue-mine' : ''}`} title={`${q.byName ?? 'Someone'} · ${q.prompt}`}>
                <span className="ai-queue-pos">#{i + 1}</span>
                <span className="ai-queue-who">{q.by === me.id ? 'you' : (q.byName ?? 'guest')}</span>
                <span className="ai-queue-text">{q.prompt.slice(0, 40)}{q.prompt.length > 40 ? '…' : ''}</span>
              </span>
            ))}
          </div>
        )}
        {conversation.map((m, i) => (
          <ChatMessage key={i} role={m.role} content={m.content} name={m.name} color={m.color} ts={tsFor(i)} tick={tick} />
        ))}
        {running && (
          <div className="ai-msg ai-assistant ai-streaming">
            <span className="ai-avatar ai-avatar-bot" aria-hidden="true">
              <BotGlyph />
            </span>
            <div className="ai-msg-main">
              <div className="ai-msg-meta">
                <span className="ai-msg-name">AI</span>
                <span className="ai-msg-time">typing…</span>
              </div>
              <div className="ai-msg-body">
                <Suspense fallback={<p>{aiState?.streamingText || '…'}</p>}>
                  <ReactMarkdown components={markdownComponents}>{aiState?.streamingText || '…'}</ReactMarkdown>
                </Suspense>
              </div>
            </div>
          </div>
        )}
        {!running && conversation.length === 0 && (
          <div className="ai-empty">
            <span className="ai-empty-glyph" aria-hidden="true">
              <BotGlyph />
            </span>
            <div className="ai-empty-title">What should we make?</div>
            <p className="ai-empty-sub">Ask me to draw, label, arrange, or explain anything on the board.</p>
            <div className="ai-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="ai-suggest-chip" onClick={() => useSuggestion(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {aiState?.error && (
        <div className="ai-error" role="alert">
          <span className="ai-error-text">That run failed — nothing on the board changed.</span>
          <button className="ai-retry" onClick={retry} disabled={queueFull}>
            Retry
          </button>
        </div>
      )}

      {footerStatus && !aiState?.error && <div className="ai-status">{footerStatus}</div>}

      <div className="ai-footer">
        <label className="ai-shot">
          <input
            type="checkbox"
            checked={includeShot}
            onChange={(e) => setIncludeShot(e.target.checked)}
          />
          Attach screenshot
        </label>
        <div className="ai-row">
          <textarea
            ref={promptRef}
            className="ai-input ai-prompt"
            rows={2}
            value={input}
            placeholder={queueFull ? `Queue full — wait for a run to finish…` : running ? 'Queue another prompt…' : 'Message the AI…'}
            disabled={!canSubmit}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            enterKeyHint="send"
          />
          {running ? (
            <button className="ai-send ai-stop" onClick={stop} disabled={!running}>
              Stop
            </button>
          ) : showResume ? (
            <button className="ai-send ai-resume" onClick={resume} title="Re-send the stopped prompt">
              Resume
            </button>
          ) : (
            <button className="ai-send" onClick={submit} disabled={!canSubmit || !input.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}