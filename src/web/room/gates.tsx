import { useEffect, useRef, useState } from 'react'
import { getHostToken } from '../lib/host'
import { api } from '../lib/api'

export type RoomInfo = {
  id: string
  name: string
  updatedAt: number
  requiresPassword: boolean
  requireApproval: boolean
}

export type JoinRequest = { userId: string; userName: string; userColor: string; createdAt: number }

// Hosts skip the password/approval gate entirely (server-side bypass via
// X-Host-Token); returns a join token or null.
export async function hostAutoJoin(roomId: string): Promise<string | null> {
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

export function RoomStatus({
  kind,
  detail,
  onRetry,
}: {
  kind: 'checking' | 'missing' | 'failed'
  detail?: string
  onRetry?: () => void
}) {
  return (
    <main id="main-content" className="room-status" tabIndex={-1}>
      {kind === 'checking' && (
        <>
          <div className="room-spinner" />
          <p className="room-muted">Checking room…</p>
        </>
      )}
      {kind === 'missing' && (
        <>
          <p className="room-error">Room not found — it may have been removed, or the link is stale.</p>
          <a className="room-retry" href="#/">
            Create a new board
          </a>
        </>
      )}
      {kind === 'failed' && (
        <>
          <p className="room-error">
            {detail ? `Couldn't reach this room — ${detail}.` : "Couldn't reach this room — check your connection."}
          </p>
          {onRetry && (
            <button className="room-retry" onClick={onRetry}>
              Retry
            </button>
          )}
        </>
      )}
    </main>
  )
}

export function JoinGate({
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
    <main id="main-content" className="room-status" tabIndex={-1}>
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
    </main>
  )
}

export function PendingGate({ roomId, onApproved }: { roomId: string; onApproved: (token: string) => void }) {
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
    <main id="main-content" className="room-status" tabIndex={-1}>
      <div className="room-spinner" />
      <p className="room-muted">Waiting for the host to approve your request…</p>
    </main>
  )
}
