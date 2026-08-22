import { memo, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import type { Editor } from 'tldraw'
import { useValue } from 'tldraw'
import { AI_STATE_ID, createDefaultAiState } from '../../shared/schema'
import type { AiState } from '../../shared/schema'
import type { AiModelInfo, AiModelsResponse } from '../../shared/types'
import { useUser } from '../lib/user'
import { api } from '../lib/api'
import { getAiContext } from './aiContext'
import { usePanelSlide } from '../lib/usePanelSlide'

const MODEL_KEY = 't2.aiModel'
const DEFAULT_MODEL = 'claude-sonnet-4-6'

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
const ChatMessage = memo(function ChatMessage({ role, content, ts }: { role: string; content: string; ts: number; tick?: number }) {
  const me = useUser()
  const isUser = role === 'user'
  return (
    <div className={`ai-msg ai-${role}`}>
      {isUser ? (
        <span className="ai-avatar" style={{ background: me.color }} aria-hidden="true">
          {me.name[0] ?? '?'}
        </span>
      ) : (
        <span className="ai-avatar ai-avatar-bot" aria-hidden="true">
          <BotGlyph />
        </span>
      )}
      <div className="ai-msg-main">
        <div className="ai-msg-meta">
          <span className="ai-msg-name">{isUser ? me.name : 'AI'}</span>
          <span className="ai-msg-time">{timeAgo(ts)}</span>
        </div>
        <div className="ai-msg-body">
          <ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>
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
  // ponytail: aiState is validated by the schema at the sync boundary; the
  // store's branded RecordId types don't know our custom records, so cast here.
  const getAi = () => store.get(AI_STATE_ID as any) as AiState | undefined
  const putAi = (state: AiState) => store.put([state] as any)
  const aiState = useValue('aiState', getAi, [store])
  const [models, setModels] = useState<AiModelInfo[]>([])
  const [modelsFailed, setModelsFailed] = useState(false)
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? '')
  const [input, setInput] = useState('')
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
    const apply = (list: AiModelInfo[]) => {
      if (cancelled) return
      setModels(list)
      // a persisted id that is now chat:false (e.g. embeddings after a filter
      // fix) must fall back — it would render as a selected-but-disabled option
      setModel((prev) => (list.some((m) => m.id === prev && m.chat !== false) ? prev : list.find((m) => m.chat !== false)?.id || DEFAULT_MODEL))
    }
    api<AiModelsResponse>('/api/ai/models/live')
      .then((res) => apply(res.models))
      .catch(() => {
        // Live list unavailable: fall back to the static endpoint behavior.
        api<AiModelsResponse>('/api/ai/models')
          .then((res) => apply(res.models))
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
  const running = aiState?.status === 'pending' || aiState?.status === 'running'
  const lockedByMe = !!aiState?.lockedBy && aiState.lockedBy === me.id
  const lockedByOther = !!aiState?.lockedBy && aiState.lockedBy !== me.id
  const canSubmit = !running && !lockedByOther

  const modelsUnavailable = modelsFailed && models.length === 0
  const modelName = modelsUnavailable
    ? 'models unavailable'
    : models.find((m) => m.id === model)?.name ?? (model || DEFAULT_MODEL)
  const statusLine = aiState?.error
    ? 'Error'
    : running
      ? 'thinking…'
      : lockedByOther
        ? 'busy'
        : 'ready'

  function tsFor(i: number): number {
    if (tsByIndex.current[i] === undefined) tsByIndex.current[i] = Date.now()
    return tsByIndex.current[i]!
  }

  function submit() {
    const text = input.trim()
    if (!text || !canSubmit) return
    const ctx = getAiContext(editor)
    const cur = getAi() ?? createDefaultAiState()
    putAi({
      ...cur,
      lockedBy: me.id,
      lockedByName: me.name,
      status: 'pending',
      streamingText: '',
      error: null,
      conversation: [...cur.conversation, { role: 'user', content: text }],
      prompt: text,
      promptModel: model || null,
      promptSelection: ctx.selection,
      promptViewport: ctx.viewport,
    })
    setInput('')
  }

  async function stop() {
    try {
      await api(`/api/rooms/${roomId}/ai/cancel`, { method: 'POST' })
      const cur = getAi()
      if (cur) putAi({ ...cur, status: 'idle', error: null, streamingText: '', lockedBy: null, lockedByName: null })
    } catch (error) {
      console.error('[ai] cancel request failed:', error)
    }
  }

  function clearConversation() {
    tsByIndex.current = []
    const cur = getAi()
    if (cur) putAi({ ...cur, conversation: [], streamingText: '' })
  }

  function useSuggestion(text: string) {
    setInput(text)
    promptRef.current?.focus()
  }

  const footerStatus = aiState?.error
    ? 'Error: ' + aiState.error
    : lockedByOther
      ? `${aiState?.lockedByName ?? 'Someone'} is using the AI…`
      : ''

  return (
    <aside className="ai-panel" ref={panelRef}>
      <div className="ai-panel-header">
        <div className="ai-panel-title">
          <span className="ai-panel-name">AI assistant</span>
          <div className="ai-title-actions">
            <button className="ai-clear" onClick={clearConversation} disabled={running || conversation.length === 0}>
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

      <div className="ai-chat" ref={chatRef}>
        {conversation.map((m, i) => (
          <ChatMessage key={i} role={m.role} content={m.content} ts={tsFor(i)} tick={tick} />
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
                <ReactMarkdown components={markdownComponents}>{aiState?.streamingText || '…'}</ReactMarkdown>
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

      {footerStatus && <div className={`ai-status${aiState?.error ? ' ai-status-error' : ''}`}>{footerStatus}</div>}

      <div className="ai-footer">
        <div className="ai-row">
          <textarea
            ref={promptRef}
            className="ai-input ai-prompt"
            rows={2}
            value={input}
            placeholder={lockedByOther ? 'The AI is busy…' : 'Message the AI…'}
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