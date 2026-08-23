import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { getJoinCookie, setJoinCookie, setUser, syncUserCookie, useUser, PROFILE_COLORS } from '../lib/user'
import { getHostKey, getHostToken, setHostKey, setHostToken } from '../lib/host'
import { api } from '../lib/api'
import { assetStore } from '../lib/assetStore'
import { useIsCompact } from '../lib/useMediaQuery'
import { AIPanel } from './AIPanel'
import { MusicPanel } from './MusicPanel'
import { AI_STATE_ID } from '../../shared/schema'
import type { AiState } from '../../shared/schema'

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

// Hosts skip the password/approval gate entirely (server-side bypass via
// X-Host-Token); returns a join token or null.
async function hostAutoJoin(roomId: string): Promise<string | null> {
  const token = getHostToken(roomId)
  if (!token) return null
  try {
    const res = await api<{ status: 'ok' | 'pending'; token?: string }>(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'X-Host-Token': token },
    })
    return res.token ?? null
  } catch {
    return null
  }
}

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

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9.5 3.5v17M14.5 3.5v17M3.5 9.5h17M3.5 14.5h17" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M10.5 13.5 20 4.5M20 4.5h-6m6 0v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 4.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5v-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

const BG_OPTIONS: { value: CanvasBg; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'graph', label: 'Graph' },
  { value: 'dots', label: 'Dots' },
]

function RoomChrome({
  roomId,
  musicOpen,
  onToggleMusic,
  aiOpen,
  onToggleAi,
  panelsOpen,
  isSynced,
  theme,
  onSetTheme,
  bg,
  onSetBg,
}: {
  roomId: string
  musicOpen: boolean
  onToggleMusic: () => void
  aiOpen: boolean
  onToggleAi: () => void
  panelsOpen: boolean
  isSynced: boolean
  theme: Theme
  onSetTheme: (t: Theme) => void
  bg: CanvasBg
  onSetBg: (b: CanvasBg) => void
}) {
  const editor = useEditor()
  const me = useUser()
  const [claimOpen, setClaimOpen] = useState(false)
  const [claimKey, setClaimKey] = useState('')
  const [claimError, setClaimError] = useState<string | null>(null)
  // localStorage + JSON.parse per render; host key only changes on claim.
  const isHost = useMemo(() => getHostKey(roomId) !== null, [roomId])

  // Profile popover state: draft name is local, committed on blur/Enter.
  const [profileOpen, setProfileOpen] = useState(false)
  const [draftName, setDraftName] = useState(me.name)
  useEffect(() => {
    if (profileOpen) setDraftName(me.name)
  }, [profileOpen])

  function commitName() {
    const name = draftName.trim() || me.name
    setUser({ name })
    setDraftName(name)
  }

  const [pendingOpen, setPendingOpen] = useState(false)
  const [pending, setPending] = useState<JoinRequest[] | null>(null)

  const [menuOpen, setMenuOpen] = useState(false)

  const [shareOpen, setShareOpen] = useState(false)
  const [shareInfo, setShareInfo] = useState<RoomInfo | null>(null)
  const [sharePassword, setSharePassword] = useState('')
  const [shareApproval, setShareApproval] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // true while a share-modal request (password/approve) is in flight; blocks
  // double-submits and stale-state races.
  const [shareBusy, setShareBusy] = useState(false)
  const shareModalRef = useRef<HTMLDivElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const shareUrl = window.location.href

  async function refreshPending() {
    const token = getHostToken(roomId)
    if (!token) return
    try {
      setPending(
        await api<JoinRequest[]>(`/api/rooms/${roomId}/pending`, { headers: { 'X-Host-Token': token } })
      )
    } catch {
      setPending([])
    }
  }

  async function approveUser(userId: string) {
    const token = getHostToken(roomId)
    if (!token || shareBusy) return
    setShareBusy(true)
    try {
      await api(`/api/rooms/${roomId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Host-Token': token },
        body: JSON.stringify({ userId }),
      })
      refreshPending()
    } catch {
      // the next refresh will show the truth
    } finally {
      setShareBusy(false)
    }
  }

  async function openShare() {
    setProfileOpen(false)
    setMenuOpen(false)
    setPendingOpen(false)
    setShareOpen(true)
    try {
      const info = await api<RoomInfo>(`/api/rooms/${roomId}`)
      setShareInfo(info)
      setShareApproval(info.requireApproval)
    } catch {
      setShareInfo(null)
    }
    if (getHostToken(roomId)) refreshPending()
  }

  async function saveSharePassword(e: React.FormEvent) {
    e.preventDefault()
    const token = getHostToken(roomId)
    if (!token || shareBusy) return
    setShareBusy(true)
    setShareError(null)
    try {
      const info = await api<RoomInfo>(`/api/rooms/${roomId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Host-Token': token },
        body: JSON.stringify({ password: sharePassword }),
      })
      setShareInfo(info)
      setSharePassword('')
      if (info.requiresPassword && !getJoinCookie()) {
        const t = await hostAutoJoin(roomId)
        if (t) setJoinCookie(t)
      }
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'save failed')
    } finally {
      setShareBusy(false)
    }
  }

  async function toggleShareApproval() {
    const token = getHostToken(roomId)
    if (!token || shareBusy) return
    setShareBusy(true)
    setShareError(null)
    try {
      const info = await api<RoomInfo>(`/api/rooms/${roomId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Host-Token': token },
        body: JSON.stringify({ requireApproval: !shareApproval }),
      })
      setShareInfo(info)
      setShareApproval(info.requireApproval)
      if (info.requiresPassword && !getJoinCookie()) {
        const t = await hostAutoJoin(roomId)
        if (t) setJoinCookie(t)
      }
      if (info.requireApproval) refreshPending()
      else setPending([])
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'save failed')
    } finally {
      setShareBusy(false)
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = shareUrl
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  function claimFromShare() {
    setShareOpen(false)
    setClaimOpen(true)
    setClaimKey('')
  }

  // Escape closes the share modal; focus moves onto the panel when it opens
  // and returns to the previous element when it closes. Tab wraps inside.
  useEffect(() => {
    if (!shareOpen) return
    const prevFocus = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShareOpen(false)
      if (e.key === 'Tab') {
        const modal = shareModalRef.current
        if (!modal) return
        const focusables = modal.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
        )
        if (focusables.length === 0) return
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    shareModalRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      prevFocus?.focus()
    }
  }, [shareOpen])

  // One document-level listener for all three popovers: outside click or Escape
  // closes them. Clicks inside an open popover or on a toggle button are
  // ignored (the toggle's own onClick handles it).
  useEffect(() => {
    function isInsidePopover(target: EventTarget | null): boolean {
      if (!(target instanceof Element)) return false
      return !!(
        target.closest('.room-menu, .room-pending') || target.closest('[data-popover-toggle]')
      )
    }
    function onPointerDown(e: PointerEvent) {
      if (isInsidePopover(e.target)) return
      setProfileOpen(false)
      setMenuOpen(false)
      setPendingOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setProfileOpen(false)
      setMenuOpen(false)
      setPendingOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])


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
    const msg = isSynced
      ? 'Importing a snapshot will replace all room content including AI history and music queue. Continue?'
      : 'Importing replaces the current board. Continue?'
    if (!window.confirm(msg)) {
      e.target.value = ''
      return
    }
    file
      .text()
      .then((text) => {
        const snapshot = JSON.parse(text)
        const tryLoad = () => {
          try {
            editor.loadSnapshot(snapshot)
          } catch (err) {
            if (err instanceof Error && err.message.includes('not ready')) {
              setTimeout(tryLoad, 100)
            } else {
              throw err
            }
          }
        }
        tryLoad()
      })
      .catch((err) => {
        window.alert(`Import failed: ${err instanceof Error ? err.message : 'invalid file'}`)
      })
    e.target.value = ''
  }

  return (
    <>
      <div className={`room-chrome${panelsOpen ? ' panels-open' : ''}`}>
      {isHost ? (
        <>
          <span className="room-badge">You're the host</span>
          <button
            className="room-btn"
            data-popover-toggle
            onClick={() => {
              if (!pendingOpen) {
                setProfileOpen(false)
                setMenuOpen(false)
                refreshPending()
              }
              setPendingOpen((v) => !v)
            }}
            title="Approve pending join requests"
          >
            Pending{pending !== null && pending.length > 0 ? ` (${pending.length})` : ''}
          </button>
          {pendingOpen && (
            <div className="room-pending">
              {pending === null ? (
                <p className="room-muted">Loading…</p>
              ) : pending.length === 0 ? (
                <p className="room-muted">No pending requests.</p>
              ) : (
                pending.map((r) => (
                  <div className="room-pending-item" key={r.userId}>
                    <span className="room-pending-name">{r.userName}</span>
                    <button className="room-btn" onClick={() => approveUser(r.userId)} disabled={shareBusy}>
                      Approve
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </>
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
      <button
        className="room-icon"
        onClick={openShare}
        aria-expanded={shareOpen}
        aria-haspopup="dialog"
        title="Share room"
        aria-label="Share room"
      >
        <ShareIcon />
      </button>
      <button className="room-btn" onClick={exportBoard}>
        Export
      </button>
      <button className="room-btn" type="button" onClick={() => importInputRef.current?.click()}>
        Import
      </button>
      <input ref={importInputRef} type="file" accept=".json,application/json" onChange={importBoard} hidden />
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
      <button
        className="room-icon profile-btn"
        data-popover-toggle
        onClick={() => {
          setMenuOpen(false)
          setPendingOpen(false)
          setProfileOpen((v) => !v)
        }}
        aria-expanded={profileOpen}
        aria-haspopup="dialog"
        aria-label="Edit your profile"
        title="Edit your profile"
      >
        <span className="profile-avatar-sm" style={{ background: me.color }}>
          {me.name[0] ?? '?'}
        </span>
      </button>
      {profileOpen && (
        <div className="room-menu profile-menu" role="dialog" aria-label="Edit your profile">
          <div className="profile-preview">
            <span className="profile-avatar" style={{ background: me.color }}>
              {me.name[0] ?? '?'}
            </span>
            <span className="profile-preview-name">{me.name}</span>
          </div>
          <div className="room-menu-section">
            <label className="room-menu-label" htmlFor="profile-name">
              Display name
            </label>
            <input
              id="profile-name"
              className="room-input profile-name-input"
              value={draftName}
              maxLength={24}
              autoComplete="off"
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName()
              }}
            />
          </div>
          <div className="room-menu-section">
            <span className="room-menu-label" id="profile-color-label">
              Color
            </span>
            <div className="profile-swatches" role="radiogroup" aria-labelledby="profile-color-label">
              {PROFILE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`profile-swatch${me.color === c ? ' selected' : ''}`}
                  style={{ background: c }}
                  onClick={() => setUser({ color: c })}
                  aria-pressed={me.color === c}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
            <label className="profile-custom">
              Custom
              <input
                type="color"
                value={me.color}
                onChange={(e) => setUser({ color: e.target.value })}
                aria-label="Custom color"
              />
            </label>
          </div>
        </div>
      )}
      <button
        className="room-icon room-menu-btn"
        data-popover-toggle
        onClick={() => {
          setProfileOpen(false)
          setPendingOpen(false)
          setMenuOpen((v) => !v)
        }}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label="Canvas settings"
        title="Canvas settings"
      >
        <GridIcon />
      </button>
      {menuOpen && (
        <div className="room-menu" role="menu" aria-label="Canvas settings">
          <div className="room-menu-section">
            <span className="room-menu-label" id="room-menu-theme">
              Theme
            </span>
            <div className="room-seg" role="group" aria-labelledby="room-menu-theme">
              <button
                className={`room-seg-btn${theme === 'light' ? ' active' : ''}`}
                onClick={() => onSetTheme('light')}
                aria-pressed={theme === 'light'}
              >
                Light
              </button>
              <button
                className={`room-seg-btn${theme === 'dark' ? ' active' : ''}`}
                onClick={() => onSetTheme('dark')}
                aria-pressed={theme === 'dark'}
              >
                Dark
              </button>
            </div>
          </div>
          <div className="room-menu-section">
            <span className="room-menu-label" id="room-menu-bg">
              Background
            </span>
            <div className="room-seg" role="group" aria-labelledby="room-menu-bg">
              {BG_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  className={`room-seg-btn${bg === o.value ? ' active' : ''}`}
                  onClick={() => onSetBg(o.value)}
                  aria-pressed={bg === o.value}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      </div>
      {shareOpen && (
        <div className="room-modal-backdrop" onClick={() => setShareOpen(false)}>
          <div
            className="room-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Share room"
            tabIndex={-1}
            ref={shareModalRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="room-modal-header">
              <span className="room-modal-title">Share room</span>
              <button className="room-modal-close" onClick={() => setShareOpen(false)} aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="room-menu-section">
              <span className="room-menu-label">Room link</span>
              <div className="room-share-link">
                <input
                  className="room-input room-share-url"
                  readOnly
                  value={shareUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Room link"
                />
                <button className="room-btn" onClick={copyLink} type="button">
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="room-share-hint">Share this link — it's how others join this room.</p>
            </div>
            {getHostToken(roomId) ? (
              <>
                <div className="room-menu-section">
                  <span className="room-menu-label">Password</span>
                  <p className="room-share-sub">
                    {shareInfo?.requiresPassword
                      ? 'On — a password is required to join.'
                      : 'Off — anyone with the link can join.'}
                  </p>
                  <form className="room-share-pw" onSubmit={saveSharePassword}>
                    <input
                      className="room-input"
                      type="password"
                      value={sharePassword}
                      onChange={(e) => setSharePassword(e.target.value)}
                      placeholder={shareInfo?.requiresPassword ? 'New password (blank to clear)' : 'Set a password'}
                      autoComplete="new-password"
                      aria-label="Room password"
                    />
                    <button className="room-btn" type="submit" disabled={shareBusy}>
                      Save
                    </button>
                  </form>
                </div>
                <label className="room-share-check">
                  <input type="checkbox" checked={shareApproval} onChange={toggleShareApproval} disabled={shareBusy} />
                  <span>Require host approval to join</span>
                </label>
                {shareApproval && (
                  <div className="room-menu-section">
                    <span className="room-menu-label">Pending approvals</span>
                    <div className="room-share-pending">
                      {pending === null ? (
                        <p className="room-share-sub">Loading…</p>
                      ) : pending.length === 0 ? (
                        <p className="room-share-sub">No pending requests.</p>
                      ) : (
                        pending.map((r) => (
                          <div className="room-pending-item" key={r.userId}>
                            <span className="room-pending-name">{r.userName}</span>
                            <button className="room-btn" onClick={() => approveUser(r.userId)} disabled={shareBusy}>
                              Approve
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="room-menu-section">
                  <span className="room-menu-label">Access</span>
                  <p className="room-share-sub">
                    {shareInfo?.requiresPassword
                      ? 'This room has a password — ask the host for it.'
                      : 'This room is open to anyone with the link.'}
                  </p>
                  {shareInfo?.requireApproval && (
                    <p className="room-share-sub">The host approves new joiners.</p>
                  )}
                </div>
                <button className="room-btn" onClick={claimFromShare}>
                  Claim host
                </button>
              </>
            )}
            {shareError && <p className="room-claim-error">{shareError}</p>}
          </div>
        </div>
      )}
    </>
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

type RoomInfo = {
  id: string
  name: string
  updatedAt: number
  requiresPassword: boolean
  requireApproval: boolean
}

type JoinRequest = { userId: string; userName: string; userColor: string; createdAt: number }

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

  switch (phase.phase) {
    case 'checking':
      return (
        <div className="room-status">
          <div className="room-spinner" />
          <p className="room-muted">Checking room…</p>
        </div>
      )
    case 'missing':
      return (
        <div className="room-status">
          <p className="room-error">Room not found — it may have been removed, or the link is stale.</p>
          <a className="room-retry" href="#/">
            Create a new board
          </a>
        </div>
      )
    case 'failed':
      return (
        <div className="room-status">
          <p className="room-error">Couldn't reach this room — check your connection.</p>
          <button
            className="room-retry"
            onClick={() => {
              setPhase({ phase: 'checking' })
              setAttempt((n) => n + 1)
            }}
          >
            Retry
          </button>
        </div>
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
      return <RoomConnected roomId={roomId} onAccessDenied={onAccessDenied} />
  }
}

function JoinGate({
  roomId,
  onJoined,
  onPending,
}: {
  roomId: string
  onJoined: (token: string) => void
  onPending: () => void
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await api<{ status: 'ok' | 'pending'; token?: string }>(`/api/rooms/${roomId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.status === 'ok' && res.token) onJoined(res.token)
      else onPending()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'join failed')
      setSubmitting(false)
    }
  }

  return (
    <div className="room-status">
      <form className="room-claim" onSubmit={submit}>
        <input
          className="room-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Room password"
          autoFocus
        />
        <button className="room-btn" type="submit" disabled={submitting}>
          {submitting ? 'Joining…' : 'Join room'}
        </button>
      </form>
      {error && <p className="room-claim-error">{error}</p>}
    </div>
  )
}

function PendingGate({ roomId, onApproved }: { roomId: string; onApproved: (token: string) => void }) {
  const onApprovedRef = useRef(onApproved)
  onApprovedRef.current = onApproved

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const res = await api<{ status: 'pending' | 'approved' | 'ok'; token?: string }>(
          `/api/rooms/${roomId}/join/status`
        )
        if (cancelled) return
        if ((res.status === 'approved' || res.status === 'ok') && res.token) {
          onApprovedRef.current(res.token)
          return
        }
      } catch {
        // transient network error — keep polling
      }
      timer = window.setTimeout(poll, 3000)
    }
    poll()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [roomId])

  return (
    <div className="room-status">
      <div className="room-spinner" />
      <p className="room-muted">Waiting for the host to approve your request…</p>
    </div>
  )
}

function RoomConnected({
  roomId,
  onAccessDenied,
}: {
  roomId: string
  onAccessDenied?: () => void
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

  // A stale join cookie (or one for another room) is rejected by the WS gate;
  // drop back to the join gate instead of offering a dead-end retry.
  const denied = store.status === 'error' && /access denied/i.test(store.error.message)
  useEffect(() => {
    if (denied) onAccessDenied?.()
  }, [denied, onAccessDenied])

  if (store.status === 'loading') {
    return (
      <div className="room-status">
        <div className="room-spinner" />
        <p className="room-muted">Connecting to room…</p>
      </div>
    )
  }

  if (store.status === 'error') {
    if (denied) {
      return (
        <div className="room-status">
          <div className="room-spinner" />
          <p className="room-muted">Checking access…</p>
        </div>
      )
    }
    return (
      <div className="room-status">
        <p className="room-error">Failed to connect: {store.error.message}</p>
        <button className="room-retry" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
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
    <div className="room">
      <div className="room-layout">
        {isCompact && (aiOpen || musicOpen) && <div className="panel-backdrop" onClick={closePanels} />}
        {editor && <AIPanel editor={editor} roomId={roomId} open={aiOpen} onClose={() => setAiOpen(false)} />}
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
              panelsOpen={aiOpen || musicOpen}
              isSynced={isSynced}
              theme={theme}
              onSetTheme={setTheme}
              bg={bg}
              onSetBg={setBg}
            />
          </Tldraw>
        </div>
        {editor && <MusicPanel roomId={roomId} editor={editor} open={musicOpen} onClose={() => setMusicOpen(false)} />}
      </div>
    </div>
  )
}