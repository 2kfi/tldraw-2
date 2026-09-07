import { useEffect, useRef, useState } from 'react'
import { getHostToken } from '../lib/host'
import { getJoinCookie, setJoinCookie } from '../lib/user'
import { api } from '../lib/api'
import { useFocusTrap } from '../lib/useFocusTrap'
import { hostAutoJoin, type JoinRequest, type RoomInfo } from './gates'

// Share dialog: owns its fetch + password/approval state. Opened by
// RoomChrome; Escape/Tab handling matches via the shared focus-trap hook.
export function ShareModal({
  roomId,
  open,
  onClose,
  onClaimHost,
}: {
  roomId: string
  open: boolean
  onClose: () => void
  onClaimHost: () => void
}) {
  const [shareInfo, setShareInfo] = useState<RoomInfo | null>(null)
  const [sharePassword, setSharePassword] = useState('')
  const [shareApproval, setShareApproval] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // true while a share-modal request (password/approve) is in flight; blocks
  // double-submits and stale-state races.
  const [shareBusy, setShareBusy] = useState(false)
  const [pending, setPending] = useState<JoinRequest[] | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const shareUrl = window.location.href

  useFocusTrap(modalRef, open, onClose)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setShareError(null)
    api<RoomInfo>(`/api/rooms/${roomId}`)
      .then((info) => {
        if (cancelled) return
        setShareInfo(info)
        setShareApproval(info.requireApproval)
      })
      .catch(() => {
        if (!cancelled) setShareInfo(null)
      })
    if (getHostToken(roomId)) refreshPending()
    else setPending(null)
    return () => {
      cancelled = true
    }
  }, [open, roomId])

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

  if (!open) return null

  return (
    <div className="room-modal-backdrop" onClick={onClose}>
      <div
        className="room-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Share room"
        tabIndex={-1}
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="room-modal-header">
          <span className="room-modal-title">Share room</span>
          <button className="room-modal-close" onClick={onClose} aria-label="Close">
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
            <button className="room-btn" onClick={onClaimHost}>
              Claim host
            </button>
          </>
        )}
        {shareError && <p className="room-claim-error">{shareError}</p>}
      </div>
    </div>
  )
}
