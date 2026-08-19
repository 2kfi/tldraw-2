import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Editor } from 'tldraw'
import { useValue } from 'tldraw'
import { AI_STATE_ID, createDefaultAiState } from '../../shared/schema'
import type { AiState } from '../../shared/schema'
import type { AiModelsResponse } from '../../shared/types'
import { getUser } from '../lib/user'
import { api } from '../lib/api'
import { getAiContext } from './aiContext'
import { usePanelSlide } from '../lib/usePanelSlide'

const MODEL_KEY = 't2.aiModel'
const DEFAULT_MODEL = 'claude-sonnet-4-6'

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
  const me = getUser()
  const panelRef = useRef<HTMLDivElement>(null)
  usePanelSlide(panelRef, 'left', open)
  // ponytail: aiState is validated by the schema at the sync boundary; the
  // store's branded RecordId types don't know our custom records, so cast here.
  const getAi = () => store.get(AI_STATE_ID as any) as AiState | undefined
  const putAi = (state: AiState) => store.put([state] as any)
  const aiState = useValue('aiState', getAi, [store])
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? '')
  const [input, setInput] = useState('')
  const chatRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    api<AiModelsResponse>('/api/ai/models')
      .then((res) => {
        if (!cancelled) {
          const ids = res.models.map((m) => m.id)
          setModels(ids)
          setModel((prev) => (ids.includes(prev) ? prev : ids[0] || DEFAULT_MODEL))
        }
      })
      .catch(() => { if (!cancelled) setModels([]) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (model) localStorage.setItem(MODEL_KEY, model)
  }, [model])

  useEffect(() => {
    if (!store.get(AI_STATE_ID as any)) putAi(createDefaultAiState())
  }, [store])

  useEffect(() => {
    const el = chatRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [aiState?.conversation, aiState?.streamingText])

  const conversation = aiState?.conversation ?? []
  const running = aiState?.status === 'pending' || aiState?.status === 'running'
  const lockedByMe = !!aiState?.lockedBy && aiState.lockedBy === me.id
  const lockedByOther = !!aiState?.lockedBy && aiState.lockedBy !== me.id
  const canSubmit = !running && !lockedByOther
  const status = aiState?.status

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
    const cur = getAi()
    if (cur) putAi({ ...cur, conversation: [], streamingText: '' })
  }

  const statusText = aiState?.error
    ? 'Error: ' + aiState.error
    : running
      ? aiState?.status === 'pending'
        ? 'Waiting for the AI…'
        : 'AI is working…'
      : lockedByOther
        ? `${aiState?.lockedByName ?? 'Someone'} is using the AI…`
        : ''

  return (
    <aside className="ai-panel" ref={panelRef}>
      <div className="ai-panel-header">
        <div className="ai-panel-title">
          <span>AI assistant</span>
          <span className="ai-title-actions">
            <button className="ai-clear" onClick={clearConversation} disabled={running || conversation.length === 0}>
              Clear
            </button>
            <button className="ai-clear" onClick={onClose} title="Close">
              ✕
            </button>
          </span>
        </div>
        <div className="ai-panel-sub">
          <select
            className="ai-input ai-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {models.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="ai-chat" ref={chatRef}>
        {conversation.map((m, i) => (
          <div key={i} className={`ai-msg ai-${m.role}`}>
            <div className="ai-msg-name">{m.role === 'user' ? me.name : 'AI'}</div>
            <div className="ai-msg-body">
              <ReactMarkdown>{m.content}</ReactMarkdown>
            </div>
          </div>
        ))}
        {running && (
          <div className="ai-msg ai-assistant ai-streaming">
            <div className="ai-msg-name">AI</div>
            <div className="ai-msg-body">
              <ReactMarkdown>{aiState?.streamingText || '…'}</ReactMarkdown>
            </div>
          </div>
        )}
        {!running && conversation.length === 0 && (
          <div className="ai-empty">Ask the AI to draw, label, organize, or explain the board.</div>
        )}
      </div>

      {statusText && <div className={`ai-status${aiState?.error ? ' ai-status-error' : ''}`}>{statusText}</div>}

      <div className="ai-footer">
        <div className="ai-row">
          <textarea
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