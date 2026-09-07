import { useEffect, useRef, useState } from 'react'
import { setUser, useUser } from '../lib/user'
import { allHostKeys, getHostToken, setHostKey, setHostToken } from '../lib/host'
import { api } from '../lib/api'
import { useFocusTrap } from '../lib/useFocusTrap'

type MyBoard = { roomId: string; name: string; updatedAt: number }

function boardLink(roomId: string) {
  return `${location.origin}${location.pathname}#/r/${roomId}`
}

export function Home() {
  const [joinId, setJoinId] = useState('')
  const [boards, setBoards] = useState<MyBoard[] | null>(null)
  const [createPassword, setCreatePassword] = useState('')
  const [requireApproval, setRequireApproval] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Inline dialogs (share-modal pattern) replacing prompt().
  const [renameTarget, setRenameTarget] = useState<MyBoard | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [nameDialogOpen, setNameDialogOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const user = useUser()
  useFocusTrap(dialogRef, renameTarget !== null || nameDialogOpen, () => {
    setRenameTarget(null)
    setNameDialogOpen(false)
  })

  async function refreshBoards() {
    const keys = Object.values(allHostKeys())
    if (keys.length === 0) {
      setBoards([])
      return
    }
    const res = await api<MyBoard[]>('/api/rooms/mine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    })
    setBoards(res)
  }

  useEffect(() => {
    let cancelled = false
    refreshBoards()
      .catch(() => { if (!cancelled) setBoards([]) })
    return () => { cancelled = true }
  }, [])

  async function createRoom() {
    const res = await api<{ roomId: string; hostKey: string }>('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(createPassword ? { password: createPassword } : {}),
        requireApproval,
      }),
    })
    setHostKey(res.roomId, res.hostKey)
    try {
      const claim = await api<{ hostToken: string }>(`/api/rooms/${res.roomId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostKey: res.hostKey }),
      })
      setHostToken(res.roomId, claim.hostToken)
    } catch {
      // key is already stored; a claim can be re-done in the room
    }
    window.location.hash = `/r/${res.roomId}`
  }

  function joinRoom(e: React.FormEvent) {
    e.preventDefault()
    const value = joinId.trim()
    if (!value) return
    const match = value.match(/\/r\/([a-z0-9]+)/i)
    const id = match ? match[1] : value
    window.location.hash = `/r/${id}`
  }

  function openRename(board: MyBoard) {
    setRenameDraft(board.name)
    setRenameTarget(board)
  }

  async function submitRename(e: React.FormEvent) {
    e.preventDefault()
    if (!renameTarget) return
    const token = getHostToken(renameTarget.roomId)
    if (!token) {
      setRenameTarget(null)
      return
    }
    const name = renameDraft.trim()
    if (!name) return
    await api(`/api/rooms/${renameTarget.roomId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Host-Token': token },
      body: JSON.stringify({ name }),
    })
    setRenameTarget(null)
    refreshBoards()
  }

  function submitName(e: React.FormEvent) {
    e.preventDefault()
    const name = nameDraft.trim()
    if (name) {
      setUser({ name })
      window.location.reload()
    }
  }

  // Clipboard API needs a secure context; fall back to execCommand on HTTP.
  async function copyLink(board: MyBoard) {
    const url = boardLink(board.roomId)
    let ok = false
    try {
      await navigator.clipboard.writeText(url)
      ok = true
    } catch {
      const ta = document.createElement('textarea')
      ta.value = url
      document.body.appendChild(ta)
      ta.select()
      ok = document.execCommand('copy')
      ta.remove()
    }
    setCopiedId(ok ? board.roomId : 'error')
    window.setTimeout(() => setCopiedId(null), 1500)
  }

  const dialogOpen = renameTarget !== null || nameDialogOpen

  return (
    <main id="main-content" className="home" tabIndex={-1}>
      <header className="home-hero">
        <span className="home-sticker" aria-hidden="true">live · together</span>
        <p className="home-eyebrow">Shared whiteboard for small crews</p>
        <h1 className="home-wordmark">Sketchparty</h1>
        <p className="home-thesis">Draw together, score it, ask the board.</p>
        <p className="home-sub">
          One link opens a shared canvas with a live soundtrack and an AI that can
          actually draw. Create a room, send the link — that&apos;s the whole setup.
        </p>
      </header>
      <p className="home-section-label" id="home-start-label">Start a board</p>
      <div className="home-actions" role="group" aria-labelledby="home-start-label">
        <form className="home-create" onSubmit={(e) => { e.preventDefault(); createRoom() }}>
          <input
            className="home-input"
            type="password"
            value={createPassword}
            onChange={(e) => setCreatePassword(e.target.value)}
            placeholder="Optional password"
            aria-label="Optional password for the new room"
          />
          <label className="home-check">
            <input type="checkbox" checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} />
            Require host approval
          </label>
          <button className="home-link" type="submit">
            Create a room
          </button>
        </form>
        <form className="home-join" onSubmit={joinRoom}>
          <input
            className="home-input"
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
            placeholder="Or paste a room id"
            aria-label="Room id or link to join"
          />
          <button className="home-link" type="submit">
            Join
          </button>
        </form>
      </div>
      <section className="boards" aria-labelledby="boards-title">
        <h2 className="boards-title" id="boards-title">Your boards</h2>
        {boards === null ? (
          <p className="home-muted">Loading…</p>
        ) : boards.length === 0 ? (
          <p className="home-empty">
            No boards yet. Create your first room above — its link and host key land here.
          </p>
        ) : (
          <ul className="boards-list">
            {boards.map((b) => (
              <li className="board-row" key={b.roomId}>
                <div className="board-info">
                  <span className="board-name">{b.name}</span>
                  <span className="board-meta">
                    {b.roomId} · {new Date(b.updatedAt).toLocaleString()}
                  </span>
                </div>
                <div className="board-actions">
                  {getHostToken(b.roomId) && (
                    <button className="board-btn" onClick={() => openRename(b)}>
                      Rename
                    </button>
                  )}
                  <button className="board-btn" onClick={() => copyLink(b)}>
                    {copiedId === b.roomId ? 'Copied!' : copiedId === 'error' ? 'Copy failed' : 'Copy link'}
                  </button>
                  <a className="board-link" href={boardLink(b.roomId)}>
                    Open
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="home-muted">
        You are <span className="home-user" style={{ color: user.color }}>{user.name}</span>.{' '}
        <a
          className="home-link-inline"
          href="#"
          onClick={(e) => {
            e.preventDefault()
            setNameDraft(user.name)
            setNameDialogOpen(true)
          }}
        >
          Change name
        </a>
      </p>
      {dialogOpen && (
        <div
          className="room-modal-backdrop"
          onClick={() => {
            setRenameTarget(null)
            setNameDialogOpen(false)
          }}
        >
          <div
            className="room-modal"
            role="dialog"
            aria-modal="true"
            aria-label={renameTarget ? 'Rename board' : 'Change display name'}
            tabIndex={-1}
            ref={dialogRef}
            onClick={(e) => e.stopPropagation()}
          >
            {renameTarget ? (
              <form className="home-dialog-form" onSubmit={submitRename}>
                <div className="room-modal-header">
                  <span className="room-modal-title">Rename board</span>
                </div>
                <input
                  className="room-input"
                  value={renameDraft}
                  maxLength={60}
                  autoFocus
                  onChange={(e) => setRenameDraft(e.target.value)}
                  placeholder="Board name"
                  aria-label="Board name"
                />
                <div className="room-share-pw">
                  <button className="room-btn" type="submit" disabled={!renameDraft.trim()}>
                    Save
                  </button>
                  <button className="room-btn" type="button" onClick={() => setRenameTarget(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <form className="home-dialog-form" onSubmit={submitName}>
                <div className="room-modal-header">
                  <span className="room-modal-title">Change display name</span>
                </div>
                <input
                  className="room-input"
                  value={nameDraft}
                  maxLength={24}
                  autoFocus
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="Display name"
                  aria-label="Display name"
                />
                <div className="room-share-pw">
                  <button className="room-btn" type="submit" disabled={!nameDraft.trim()}>
                    Save
                  </button>
                  <button className="room-btn" type="button" onClick={() => setNameDialogOpen(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
