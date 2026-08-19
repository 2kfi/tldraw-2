import { useEffect, useMemo, useState } from 'react'
import {
  atom,
  CommentToolbarItem,
  DefaultToolbar,
  DefaultToolbarContent,
  Tldraw,
  useEditor,
  useValue,
} from 'tldraw'
import type { Editor, TLEventInfo, TLStore } from 'tldraw'
import { CanvasComments, CommentTool, commentToolOverrides } from '@tldraw/commenting'
import type { CommentAuthor } from '@tldraw/mentions'
import '@tldraw/commenting/commenting.css'
import { useSync } from '@tldraw/sync'
import { createUserId, UserRecordType } from '@tldraw/tlschema'
import { schema } from '@shared/schema'
import { getUser, syncUserCookie } from '../lib/user'
import { getHostKey, setHostKey, setHostToken } from '../lib/host'
import { api } from '../lib/api'
import { assetStore } from '../lib/assetStore'
import { useIsCompact } from '../lib/useMediaQuery'
import { AIPanel } from './AIPanel'
import { MusicPanel } from './MusicPanel'
import { AI_STATE_ID } from '../../shared/schema'
import type { AiState } from '../../shared/schema'

function DiscIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" />
    </svg>
  )
}

function MindIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9.5 20.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12 3.8a6.4 6.4 0 0 1 6.4 6.4c0 2.3-1.2 4.3-3 5.5v2.3H8.6v-2.3a7 7 0 0 1-3-5.5A6.4 6.4 0 0 1 12 3.8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="7.6" cy="7.4" r="1.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="16.4" cy="7.4" r="1.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7.6" cy="15.2" r="1.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="16.4" cy="15.2" r="1.4" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function RoomChrome({
  roomId,
  musicOpen,
  onToggleMusic,
  aiOpen,
  onToggleAi,
}: {
  roomId: string
  musicOpen: boolean
  onToggleMusic: () => void
  aiOpen: boolean
  onToggleAi: () => void
}) {
  const editor = useEditor()
  const [claimOpen, setClaimOpen] = useState(false)
  const [claimKey, setClaimKey] = useState('')
  const [claimError, setClaimError] = useState<string | null>(null)
  const isHost = getHostKey(roomId) !== null

  // Pulse the mind icon while the AI is thinking (plan 11.2).
  const aiRunning = useValue(
    'aiRunning',
    () => {
      const s = editor.store.get(AI_STATE_ID as any) as AiState | undefined
      return !!s && (s.status === 'pending' || s.status === 'running')
    },
    [editor.store]
  )

  async function claim(e: React.FormEvent) {
    e.preventDefault()
    setClaimError(null)
    try {
      const res = await api<{ hostToken: string }>(`/api/rooms/${roomId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostKey: claimKey.trim() }),
      })
      setHostToken(roomId, res.hostToken)
      setHostKey(roomId, claimKey.trim())
      setClaimOpen(false)
      setClaimKey('')
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'claim failed')
    }
  }

  async function exportBoard() {
    let name = roomId
    try {
      const info = await api<{ name: string }>(`/api/rooms/${roomId}`)
      if (info.name) name = info.name
    } catch {
      // fall back to the room id
    }
    const blob = new Blob([JSON.stringify(editor.getSnapshot(), null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.tldr.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function importBoard(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!window.confirm('Importing replaces the current board. Continue?')) {
      e.target.value = ''
      return
    }
    file
      .text()
      .then((text) => {
        editor.loadSnapshot(JSON.parse(text))
      })
      .catch((err) => {
        window.alert(`Import failed: ${err instanceof Error ? err.message : 'invalid file'}`)
      })
    e.target.value = ''
  }

  return (
    <div className="room-chrome">
      {isHost ? (
        <span className="room-badge">You're the host</span>
      ) : claimOpen ? (
        <form className="room-claim" onSubmit={claim}>
          <input
            className="room-input"
            value={claimKey}
            onChange={(e) => setClaimKey(e.target.value)}
            placeholder="Host key"
          />
          <button className="room-btn" type="submit">
            Claim
          </button>
          <button className="room-btn" type="button" onClick={() => setClaimOpen(false)}>
            Cancel
          </button>
          {claimError && <span className="room-claim-error">{claimError}</span>}
        </form>
      ) : (
        <button className="room-btn" onClick={() => setClaimOpen(true)}>
          Claim host
        </button>
      )}
      <button className="room-btn" onClick={exportBoard}>
        Export
      </button>
      <label className="room-btn">
        Import
        <input type="file" accept=".json,application/json" onChange={importBoard} hidden />
      </label>
      <button
        className="room-icon"
        onClick={onToggleMusic}
        aria-pressed={musicOpen}
        title={musicOpen ? 'Close music' : 'Open music'}
      >
        <DiscIcon />
      </button>
      <button
        className={`room-icon${aiRunning ? ' room-icon-think' : ''}`}
        onClick={onToggleAi}
        aria-pressed={aiOpen}
        title={aiOpen ? 'Close AI assistant' : 'Open AI assistant'}
      >
        <MindIcon />
      </button>
    </div>
  )
}

// The default toolbar omits the comment item (tldraw gates it behind a license
// flag + the @tldraw/commenting plugin). Append it; useCommentingEnabled() is
// true on loopback/dev, which is where this app runs.
function ToolbarWithComments() {
  return (
    <DefaultToolbar>
      <DefaultToolbarContent />
      <CommentToolbarItem />
    </DefaultToolbar>
  )
}

export function Room({ roomId }: { roomId: string }) {
  syncUserCookie()

  const user = getUser()

  // A stale shared link (room row deleted / fresh data volume) would otherwise
  // hit the phantom-room gate and retry forever under the "Connecting…" spinner.
  const [known, setKnown] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    api<{ id: string }>(`/api/rooms/${roomId}`).then(
      () => !cancelled && setKnown(true),
      () => !cancelled && setKnown(false),
    )
    return () => {
      cancelled = true
    }
  }, [roomId])

  if (known === false) {
    return (
      <div className="room-status">
        <p className="room-error">Room not found — it may have been removed, or the link is stale.</p>
        <a className="room-retry" href="#/">
          Create a new board
        </a>
      </div>
    )
  }

  if (known === null) {
    return (
      <div className="room-status">
        <div className="room-spinner" />
        <p className="room-muted">Checking room…</p>
      </div>
    )
  }

  return <RoomConnected roomId={roomId} user={user} />
}

function RoomConnected({ roomId, user }: { roomId: string; user: { id: string; name: string; color: string } }) {
  const store = useSync({
    schema,
    // tldraw's useSync runs `new URL(uri)` with no base — a relative path
    // throws in browsers (Node resolves it, which is why the spikes always
    // passed) and the socket never opens. Resolve to an absolute URL first.
    uri: useMemo(() => new URL(`/sync/${roomId}`, window.location.href).toString(), [roomId]),
    assets: assetStore,
    users: {
      currentUser: atom('currentUser', UserRecordType.create({ id: createUserId(user.id), name: user.name, color: user.color })),
    },
  })

  if (store.status === 'loading') {
    return (
      <div className="room-status">
        <div className="room-spinner" />
        <p className="room-muted">Connecting to room…</p>
      </div>
    )
  }

  if (store.status === 'error') {
    return (
      <div className="room-status">
        <p className="room-error">Failed to connect: {store.error.message}</p>
        <button className="room-retry" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    )
  }

  return <RoomCanvas roomId={roomId} user={user} store={store.store} />
}

function RoomCanvas({
  roomId,
  user,
  store,
}: {
  roomId: string
  user: { id: string; name: string; color: string }
  store: TLStore
}) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const isCompact = useIsCompact()
  const [aiOpen, setAiOpen] = useState(false)
  const [musicOpen, setMusicOpen] = useState(false)

  // Plan 11.3: compact mode is mutually exclusive — opening one closes the
  // other (also cleans up a desktop→compact resize with both left open).
  useEffect(() => {
    if (isCompact && aiOpen && musicOpen) setAiOpen(false)
  }, [isCompact, aiOpen, musicOpen])

  const toggleAi = () => {
    if (isCompact && !aiOpen) setMusicOpen(false)
    setAiOpen((v) => !v)
  }
  const toggleMusic = () => {
    if (isCompact && !musicOpen) setAiOpen(false)
    setMusicOpen((v) => !v)
  }
  const closePanels = () => {
    setAiOpen(false)
    setMusicOpen(false)
  }

  // Comment authors are stamped with the TLUserId (same id as presence), so
  // resolveAuthor can read the author's current name/color from their synced
  // instance_presence. Fall back to a generic name once they leave the room.
  const commenting = useMemo(
    () => ({
      currentUserId: createUserId(user.id),
      resolveAuthor(id: string): CommentAuthor | undefined {
        const presence = store
          .query.records('instance_presence')
          .get()
          .find((r) => r.userId === id) as { userName: string; color: string } | undefined
        if (presence?.userName) return { name: presence.userName, color: presence.color }
        return { name: 'Guest', color: 'var(--color-muted-1)' }
      },
    }),
    [store, user.id]
  )

  // The editor already breaks follow on pan/zoom/wheel; a plain canvas click
  // does not, so do it here (matches the plan's "clicking canvas breaks follow").
  useEffect(() => {
    if (!editor) return
    const handler = (info: TLEventInfo) => {
      if (info.name === 'pointer_down' && info.target === 'canvas') editor.stopFollowingUser()
    }
    editor.on('event', handler)
    return () => {
      editor.off('event', handler)
    }
  }, [editor])

  return (
    <div className="room">
      <div className="room-layout">
        {isCompact && (aiOpen || musicOpen) && <div className="panel-backdrop" onClick={closePanels} />}
        {editor && <AIPanel editor={editor} open={aiOpen} onClose={() => setAiOpen(false)} />}
        <div className="room-canvas">
          <Tldraw
            store={store}
            onMount={setEditor}
            tools={[CommentTool]}
            overrides={[commentToolOverrides]}
            components={{
              Toolbar: ToolbarWithComments,
              InFrontOfTheCanvas: () => <CanvasComments {...commenting} />,
            }}
          >
            <RoomChrome
              roomId={roomId}
              musicOpen={musicOpen}
              onToggleMusic={toggleMusic}
              aiOpen={aiOpen}
              onToggleAi={toggleAi}
            />
          </Tldraw>
        </div>
        {editor && <MusicPanel roomId={roomId} editor={editor} open={musicOpen} onClose={() => setMusicOpen(false)} />}
      </div>
    </div>
  )
}