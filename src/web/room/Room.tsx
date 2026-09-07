import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  atom,
  CommentToolbarItem,
  DefaultToolbar,
  DefaultToolbarContent,
  Tldraw,
  useEditor,
} from 'tldraw'
import type { Editor, TLEventInfo, TLStore } from 'tldraw'
import { CanvasComments, CommentTool, commentToolOverrides } from '@tldraw/commenting'
import type { CommentAuthor } from '@tldraw/mentions'
import '@tldraw/commenting/commenting.css'
import { useSync } from '@tldraw/sync'
import { createUserId, UserRecordType } from '@tldraw/tlschema'
import { schema } from '@shared/schema'
import { getJoinCookie, setJoinCookie, syncUserCookie, useUser } from '../lib/user'
import { api } from '../lib/api'
import { assetStore } from '../lib/assetStore'
import { useIsCompact } from '../lib/useMediaQuery'
import { usePanelsTimeline } from '../lib/usePanelSlide'
import { RoomChrome } from './RoomChrome'
import { JoinGate, PendingGate, RoomStatus, hostAutoJoin, type RoomInfo } from './gates'

// Heavy panels split out: AI (react-markdown) and Music (gsap disc) only load
// once a room is connected — the home/landing path never fetches them.
const AIPanel = lazy(() => import('./AIPanel').then((m) => ({ default: m.AIPanel })))
const MusicPanel = lazy(() => import('./MusicPanel').then((m) => ({ default: m.MusicPanel })))

type Theme = 'light' | 'dark'
type CanvasBg = 'none' | 'graph' | 'dots'

const THEME_KEY = 't2.theme'
const CANVAS_BG_KEY = 't2.canvasBg'

function getStoredTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'light'
}

function getStoredBg(): CanvasBg {
  const v = localStorage.getItem(CANVAS_BG_KEY)
  return v === 'graph' || v === 'dots' || v === 'none' ? v : 'dots'
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

type RoomPhase =
  | { phase: 'checking' }
  | { phase: 'missing' }
  | { phase: 'failed' }
  | { phase: 'gate'; info: RoomInfo }
  | { phase: 'pending'; info: RoomInfo }
  | { phase: 'ready'; info: RoomInfo }

export function Room({ roomId }: { roomId: string }) {
  syncUserCookie()

  // Apply the persisted theme on mount so the join gate and status screens
  // match before the editor mounts (RoomCanvas re-applies + can change it).
  useEffect(() => {
    document.documentElement.dataset.theme = getStoredTheme()
  }, [])

  const [phase, setPhase] = useState<RoomPhase>({ phase: 'checking' })
  const [attempt, setAttempt] = useState(0)

  // Room info gates entry: public rooms connect as today; private rooms show
  // the join gate unless a valid join cookie (this room) already exists — the
  // WS server re-validates it, and falls back to the gate if it's rejected.
  useEffect(() => {
    let cancelled = false
    api<RoomInfo>(`/api/rooms/${roomId}`)
      .then(async (info) => {
        if (info.requiresPassword && !getJoinCookie()) {
          const token = await hostAutoJoin(roomId)
          if (cancelled) return
          if (token) setJoinCookie(token)
          else {
            setPhase({ phase: 'gate', info })
            return
          }
        }
        if (!cancelled) setPhase({ phase: 'ready', info })
      })
      .catch((err) => {
        if (!cancelled) {
          if (err?.status === 404) setPhase({ phase: 'missing' })
          else setPhase({ phase: 'failed' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [roomId, attempt])

  const onJoined = useCallback((token: string) => {
    setJoinCookie(token)
    setPhase((p) =>
      p.phase === 'gate' || p.phase === 'pending' ? { phase: 'ready', info: p.info } : p
    )
  }, [])

  const onAccessDenied = useCallback(() => {
    setPhase((p) => (p.phase === 'ready' ? { phase: 'gate', info: p.info } : p))
  }, [])

  // The room vanished mid-session (host deleted it): show the not-found
  // screen instead of a dead-end "failed to connect".
  const onNotFound = useCallback(() => {
    setPhase((p) => (p.phase === 'ready' ? { phase: 'missing' } : p))
  }, [])

  switch (phase.phase) {
    case 'checking':
      return <RoomStatus kind="checking" />
    case 'missing':
      return <RoomStatus kind="missing" />
    case 'failed':
      return (
        <RoomStatus
          kind="failed"
          onRetry={() => {
            setPhase({ phase: 'checking' })
            setAttempt((n) => n + 1)
          }}
        />
      )
    case 'gate':
      return (
        <JoinGate
          roomId={roomId}
          onJoined={onJoined}
          onPending={() => setPhase({ phase: 'pending', info: phase.info })}
        />
      )
    case 'pending':
      return <PendingGate roomId={roomId} onApproved={onJoined} />
    case 'ready':
      return <RoomConnected roomId={roomId} onAccessDenied={onAccessDenied} onNotFound={onNotFound} />
  }
}

function RoomConnected({
  roomId,
  onAccessDenied,
  onNotFound,
}: {
  roomId: string
  onAccessDenied?: () => void
  onNotFound?: () => void
}) {
  const user = useUser()
  // useSync's effect depends on the `users` object identity: a fresh atom each
  // render made the sync client re-create its store on every setState, causing
  // an endless reconnect storm (new storeId per WS attempt). Keep the atom
  // stable and mutate its value so profile edits update presence without
  // reconnecting.
  const currentUser = useMemo(
    () => atom('currentUser', UserRecordType.create({ id: createUserId(user.id), name: user.name, color: user.color })),
    [user.id]
  )
  useEffect(() => {
    currentUser.set(UserRecordType.create({ id: createUserId(user.id), name: user.name, color: user.color }))
  }, [currentUser, user.id, user.name, user.color])
  const store = useSync({
    schema,
    // tldraw's useSync runs `new URL(uri)` with no base — a relative path
    // throws in browsers (Node resolves it, which is why the spikes always
    // passed) and the socket never opens. Resolve to an absolute URL first.
    uri: useMemo(() => new URL(`/sync/${roomId}`, window.location.href).toString(), [roomId]),
    assets: assetStore,
    users: useMemo(() => ({ currentUser }), [currentUser]),
  })

  // A stale join cookie (or one for another room) is rejected by the WS gate
  // with 4099/FORBIDDEN; a deleted room closes with 4099/NOT_FOUND. Both land
  // here as useSync `error` with the reason as the message — route each back
  // to its screen instead of offering a dead-end retry.
  // (frontend-design: name the problem + the next step, never a bare code.)
  const syncError = store.status === 'error' ? store.error.message : null
  const denied = syncError !== null && /FORBIDDEN|NOT_AUTHENTICATED/i.test(syncError)
  const missing = syncError !== null && /NOT_FOUND/i.test(syncError)
  useEffect(() => {
    if (denied) onAccessDenied?.()
    else if (missing) onNotFound?.()
  }, [denied, missing, onAccessDenied, onNotFound])

  if (store.status === 'loading') {
    return <RoomStatus kind="checking" />
  }

  if (store.status === 'error') {
    if (denied) {
      return <RoomStatus kind="checking" />
    }
    if (missing) {
      return <RoomStatus kind="missing" />
    }
    return (
      <RoomStatus kind="failed" detail={store.error.message} onRetry={() => window.location.reload()} />
    )
  }

  return <RoomCanvas roomId={roomId} store={store.store} isSynced={store.status === 'synced-remote'} />
}

function RoomCanvas({
  roomId,
  store,
  isSynced,
}: {
  roomId: string
  store: TLStore
  isSynced: boolean
}) {
  const user = useUser()
  const [editor, setEditor] = useState<Editor | null>(null)
  const isCompact = useIsCompact()
  const [aiOpen, setAiOpen] = useState(false)
  const [musicOpen, setMusicOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(getStoredTheme)
  const [bg, setBg] = useState<CanvasBg>(getStoredBg)
  const backdropRef = useRef<HTMLDivElement>(null)
  const chromeRef = useRef<HTMLDivElement>(null)
  const anyOpen = aiOpen || musicOpen
  // chromeOpen lags anyOpen: the panels-open class stays until the close
  // animation settles so the bar slides home instead of snapping.
  const [chromeOpen, setChromeOpen] = useState(anyOpen)
  useEffect(() => {
    if (anyOpen) setChromeOpen(true)
  }, [anyOpen])
  // One timeline for backdrop+chrome (panels slide alongside via their own
  // matchMedia hook): played on open, reversed on close — resumed, not restarted.
  usePanelsTimeline(backdropRef, chromeRef, anyOpen, () => setChromeOpen(false))

  // Single source of truth for the theme is the `data-theme` attribute on
  // <html>; the control state mirrors it and pushes changes back out.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(CANVAS_BG_KEY, bg)
  }, [bg])

  // Keep tldraw's own color scheme (editor toolbar/colors) in step with ours.
  useEffect(() => {
    editor?.user.updateUserPreferences({ colorScheme: theme })
  }, [editor, theme])

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

  const InFrontOfTheCanvas = useMemo(
    () => () => <CanvasComments {...commenting} />,
    [commenting]
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

  // The dot/grid backgrounds are CSS patterns on the wrapper div; without
  // this they sit still while the canvas pans and zooms underneath. Mirror
  // the camera into CSS vars so the pattern moves in world coordinates.
  const canvasElRef = useRef<HTMLDivElement>(null)
  const bgFollowsCamera = bg !== 'none'
  useEffect(() => {
    if (!editor || !bgFollowsCamera) return
    const el = canvasElRef.current
    if (!el) return
    const update = () => {
      const { x, y, z } = editor.getCamera()
      el.style.setProperty('--grid-px', `${(-x * z).toFixed(2)}px`)
      el.style.setProperty('--grid-py', `${(-y * z).toFixed(2)}px`)
      el.style.setProperty('--grid-z', String(z))
    }
    update()
    return editor.store.listen(update, { source: 'user', scope: 'session' })
  }, [editor, bgFollowsCamera])

  return (
    <main id="main-content" className="room" tabIndex={-1}>
      <div className="room-layout">
        {/* Always mounted so the timeline can fade it; hidden by autoAlpha
            until gsap arrives (inline style), display:none on desktop. */}
        <div
          ref={backdropRef}
          className="panel-backdrop"
          onClick={closePanels}
          aria-hidden={!anyOpen}
          style={{ visibility: 'hidden', opacity: 0 }}
        />
        <Suspense fallback={null}>
          {editor && <AIPanel editor={editor} roomId={roomId} open={aiOpen} onClose={() => setAiOpen(false)} />}
        </Suspense>
        <div
          ref={canvasElRef}
          className={`room-canvas${
            bg === 'graph' ? ' canvas-bg-graph' : bg === 'dots' ? ' canvas-bg-dots' : ''
          }`}
        >
          <Tldraw
            store={store}
            onMount={(ed) => {
              setEditor(ed)
            }}
            tools={[CommentTool]}
            overrides={[commentToolOverrides]}
            components={{
              Toolbar: ToolbarWithComments,
              InFrontOfTheCanvas,
            }}
          >
            <RoomChrome
              roomId={roomId}
              musicOpen={musicOpen}
              onToggleMusic={toggleMusic}
              aiOpen={aiOpen}
              onToggleAi={toggleAi}
              panelsOpen={chromeOpen}
              isSynced={isSynced}
              theme={theme}
              onSetTheme={setTheme}
              bg={bg}
              onSetBg={setBg}
              chromeRef={chromeRef}
            />
          </Tldraw>
        </div>
        <Suspense fallback={null}>
          {editor && <MusicPanel roomId={roomId} editor={editor} open={musicOpen} onClose={() => setMusicOpen(false)} />}
        </Suspense>
      </div>
    </main>
  )
}
