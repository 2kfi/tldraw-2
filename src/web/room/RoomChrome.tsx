import { useEffect, useRef, useState } from 'react'
import { useEditor, useValue } from 'tldraw'
import type { Editor } from 'tldraw'
import { setUser, useUser, PROFILE_COLORS } from '../lib/user'
import { getHostToken, setHostKey, setHostToken, useIsHost } from '../lib/host'
import { api } from '../lib/api'
import { useFocusTrap } from '../lib/useFocusTrap'
import { ShareModal } from './ShareModal'
import { type JoinRequest } from './gates'
import { AI_STATE_ID } from '../../shared/schema'
import type { AiState } from '../../shared/schema'

type Theme = 'light' | 'dark'
type CanvasBg = 'none' | 'graph' | 'dots'

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

export function RoomChrome({
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
  chromeRef,
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
  chromeRef: { current: HTMLDivElement | null }
}) {
  const editor: Editor = useEditor()
  const me = useUser()
  const [claimOpen, setClaimOpen] = useState(false)
  const [claimKey, setClaimKey] = useState('')
  const [claimError, setClaimError] = useState<string | null>(null)
  // Reactive: updates on claim (same tab event + cross-tab storage).
  const isHost = useIsHost(roomId)

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
  const importInputRef = useRef<HTMLInputElement>(null)

  // Import replaces the board — confirm inline (share-modal pattern) instead
  // of window.confirm; failures surface inline instead of window.alert.
  const [importConfirmOpen, setImportConfirmOpen] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const importDialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(importDialogRef, importConfirmOpen || importError !== null, () => {
    setImportConfirmOpen(false)
    setImportError(null)
  })

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
    if (!token) return
    try {
      await api(`/api/rooms/${roomId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Host-Token': token },
        body: JSON.stringify({ userId }),
      })
      refreshPending()
    } catch {
      // the next refresh will show the truth
    }
  }

  function openShare() {
    setProfileOpen(false)
    setMenuOpen(false)
    setPendingOpen(false)
    setShareOpen(true)
  }

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

  function requestImport(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.[0]) return
    setImportConfirmOpen(true)
  }

  function doImport() {
    const file = importInputRef.current?.files?.[0]
    setImportConfirmOpen(false)
    if (!file) {
      if (importInputRef.current) importInputRef.current.value = ''
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
        setImportError(`Import failed: ${err instanceof Error ? err.message : 'invalid file'}`)
      })
    if (importInputRef.current) importInputRef.current.value = ''
  }

  function cancelImport() {
    setImportConfirmOpen(false)
    if (importInputRef.current) importInputRef.current.value = ''
  }

  return (
    <>
      <div ref={chromeRef} className={`room-chrome${panelsOpen ? ' panels-open' : ''}`}>
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
                    <button className="room-btn" onClick={() => approveUser(r.userId)}>
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
      <input ref={importInputRef} type="file" accept=".json,application/json" onChange={requestImport} hidden />
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
      <ShareModal
        roomId={roomId}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        onClaimHost={() => {
          setShareOpen(false)
          setClaimOpen(true)
          setClaimKey('')
        }}
      />
      {(importConfirmOpen || importError !== null) && (
        <div className="room-modal-backdrop" onClick={cancelImport}>
          <div
            className="room-modal"
            role={importError ? 'alertdialog' : 'dialog'}
            aria-modal="true"
            aria-label={importError ? 'Import failed' : 'Confirm import'}
            tabIndex={-1}
            ref={importDialogRef}
            onClick={(e) => e.stopPropagation()}
          >
            {importError !== null ? (
              <>
                <div className="room-modal-header">
                  <span className="room-modal-title">Import failed</span>
                </div>
                <p className="room-share-sub">{importError}</p>
                <button className="room-btn" onClick={() => setImportError(null)}>
                  Close
                </button>
              </>
            ) : (
              <>
                <div className="room-modal-header">
                  <span className="room-modal-title">Replace board?</span>
                </div>
                <p className="room-share-sub">
                  {isSynced
                    ? 'Importing a snapshot will replace all room content including AI history and music queue. Continue?'
                    : 'Importing replaces the current board. Continue?'}
                </p>
                <div className="room-share-pw">
                  <button className="room-btn" onClick={doImport}>
                    Replace board
                  </button>
                  <button className="room-btn" onClick={cancelImport}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

