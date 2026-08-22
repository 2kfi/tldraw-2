import { useEffect, useState } from 'react'
import { setUser, useUser } from '../lib/user'
import { allHostKeys, getHostToken, setHostKey, setHostToken } from '../lib/host'
import { api } from '../lib/api'

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

  async function rename(board: MyBoard) {
    const token = getHostToken(board.roomId)
    if (!token) return
    const name = prompt('Board name', board.name)
    if (!name) return
    await api(`/api/rooms/${board.roomId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Host-Token': token },
      body: JSON.stringify({ name }),
    })
    refreshBoards()
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

  const user = useUser()

  return (
    <div className="home">
      <h1 className="home-title">tldraw-2</h1>
      <p className="home-subtitle">A shared, self-hosted whiteboard.</p>
      <div className="home-actions">
        <form className="home-create" onSubmit={(e) => { e.preventDefault(); createRoom() }}>
          <input
            className="home-input"
            type="password"
            value={createPassword}
            onChange={(e) => setCreatePassword(e.target.value)}
            placeholder="Optional password"
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
          />
          <button className="home-link" type="submit">
            Join
          </button>
        </form>
      </div>
      <section className="boards">
        <h2 className="boards-title">Your boards</h2>
        {boards === null ? (
          <p className="home-muted">Loading…</p>
        ) : boards.length === 0 ? (
          <p className="home-muted">No boards yet — create a room to get a host key.</p>
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
                    <button className="board-btn" onClick={() => rename(b)}>
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
            const name = prompt('Display name', user.name)
            if (name) {
              setUser({ name })
              window.location.reload()
            }
          }}
        >
          Change name
        </a>
      </p>
    </div>
  )
}