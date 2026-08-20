import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import { createRoomId } from '../shared/ids'
import type { UserInfo } from '../shared/types'

const HOST_KEY_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SECRET = process.env.SESSION_SECRET ?? 'dev-secret-change-me'
const DEFAULT_NAME = 'Untitled board'

export type UserParser = (req: { headers: Record<string, string | string[] | undefined> }) => UserInfo

type RoomRow = {
  id: string
  name: string
  host_user_id: string | null
  host_key_hash: string | null
  password_hash: string | null
  require_approval: number
  updated_at: number
}

export type RoomInfo = { id: string; name: string; updatedAt: number }

export type RoomPublicInfo = RoomInfo & { requiresPassword: boolean; requireApproval: boolean }

function toInfo(row: RoomRow): RoomInfo {
  return { id: row.id, name: row.name, updatedAt: row.updated_at }
}

function toPublicInfo(row: RoomRow): RoomPublicInfo {
  return { ...toInfo(row), requiresPassword: !!row.password_hash, requireApproval: !!row.require_approval }
}

// --- host keys (SHA-256(hostKey + roomId), only the hash is stored) ---

function randomHostKey(): string {
  let n = 0n
  for (const b of randomBytes(32)) n = (n << 8n) | BigInt(b)
  let s = ''
  do {
    s = HOST_KEY_ALPHABET[Number(n % 62n)]! + s
    n /= 62n
  } while (n > 0n)
  return s
}

function hostKeyHash(hostKey: string, roomId: string): string {
  return createHash('sha256').update(hostKey + roomId).digest('hex')
}

// Room passwords use the same sha256(secret + roomId) scheme as host keys.
const passwordHash = hostKeyHash

function hashMatches(presented: string, roomId: string, stored: string): boolean {
  const a = Buffer.from(hostKeyHash(presented, roomId), 'hex')
  const b = Buffer.from(stored, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

// --- host tokens (HMAC-SHA256 over roomId + userId + exp, stateless) ---

export function issueHostToken(roomId: string, userId: string): string {
  const exp = Date.now() + TOKEN_TTL_MS
  const sig = createHmac('sha256', SECRET).update(`${roomId}.${userId}.${exp}`).digest('base64url')
  return `${roomId}.${userId}.${exp}.${sig}`
}

/** Validates an X-Host-Token for a room. Returns the token's userId, or null when invalid/expired. */
export function requireHostToken(roomId: string, token: string | undefined): string | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [tokRoom, userId, expStr, sig] = parts
  if (tokRoom !== roomId) return null
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now()) return null
  const expected = createHmac('sha256', SECRET).update(`${tokRoom}.${userId}.${exp}`).digest('base64url')
  const a = Buffer.from(sig ?? '')
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return userId!
}

// --- join tokens (same stateless HMAC scheme as host tokens, stored in the
// t2join cookie) ---

export function issueJoinToken(roomId: string, userId: string): string {
  return issueHostToken(roomId, userId)
}

/** Validates a join token for a room. Returns the token's userId, or null when invalid/expired. */
export function requireJoinToken(roomId: string, token: string | undefined): string | null {
  return requireHostToken(roomId, token)
}

// --- request validation ---

const createBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  password: z.string().max(256).optional(),
  requireApproval: z.boolean().optional(),
})
const updateBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  password: z.string().max(256).optional(),
  requireApproval: z.boolean().optional(),
})
const claimBody = z.object({ hostKey: z.string().trim().min(1) })
const joinBody = z.object({ password: z.string().max(256).optional() })
const approveBody = z.object({ userId: z.string().trim().min(1).max(200) })
const mineBody = z.object({ keys: z.array(z.string().trim().min(1)).max(50) })

function parse<T>(schema: z.ZodType<T>, body: unknown, res: { status: (n: number) => { json: (v: unknown) => void } }): T | null {
  // express.json() leaves req.body undefined for bodiless POSTs (the browser's
  // create-room fetch sends none); the create schema's name is optional, so
  // treat an absent body as {}. Required-field schemas (claim/mine/rename) still 400.
  const r = schema.safeParse(body ?? {})
  if (!r.success) {
    res.status(400).json({ error: 'invalid body' })
    return null
  }
  return r.data
}

export function createRoomsRouter(db: Database, userFromReq: UserParser) {
  const router = Router()

  router.post('/api/rooms', (req, res) => {
    const body = parse(createBody, req.body, res)
    if (!body) return
    const roomId = createRoomId()
    const hostKey = randomHostKey()
    const name = body.name ?? DEFAULT_NAME
    const now = Date.now()
    db.prepare(
      'INSERT INTO rooms (id, name, host_user_id, host_key_hash, password_hash, require_approval, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)'
    ).run(
      roomId,
      name,
      hostKeyHash(hostKey, roomId),
      body.password ? passwordHash(body.password, roomId) : null,
      body.requireApproval ? 1 : 0,
      now,
      now
    )
    res.json({ roomId, hostKey, name })
  })

  router.get('/api/rooms/:id', (req, res) => {
    const row = db
      .prepare('SELECT id, name, host_key_hash, host_user_id, password_hash, require_approval, updated_at FROM rooms WHERE id = ?')
      .get(req.params.id) as RoomRow | undefined
    if (!row) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    res.json(toPublicInfo(row))
  })

  router.put('/api/rooms/:id', (req, res) => {
    if (!requireHostToken(req.params.id, req.headers['x-host-token'] as string | undefined)) {
      res.status(401).json({ error: 'host token required' })
      return
    }
    const body = parse(updateBody, req.body, res)
    if (!body) return
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    if (body.name !== undefined) {
      sets.push('name = ?')
      vals.push(body.name)
    }
    if (body.password !== undefined) {
      // a non-empty password sets the hash; an empty string clears it
      sets.push('password_hash = ?')
      vals.push(body.password ? passwordHash(body.password, req.params.id) : null)
    }
    if (body.requireApproval !== undefined) {
      sets.push('require_approval = ?')
      vals.push(body.requireApproval ? 1 : 0)
    }
    sets.push('updated_at = ?')
    vals.push(Date.now())
    const info = db
      .prepare(
        `UPDATE rooms SET ${sets.join(', ')} WHERE id = ? RETURNING id, name, host_key_hash, host_user_id, password_hash, require_approval, updated_at`
      )
      .get(...(vals as (string | number | null)[]), req.params.id) as RoomRow | undefined
    if (!info) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    res.json(toPublicInfo(info))
  })

  router.post('/api/rooms/:id/join', (req, res) => {
    const body = parse(joinBody, req.body, res)
    if (!body) return
    const row = db
      .prepare('SELECT id, name, host_key_hash, host_user_id, password_hash, require_approval, updated_at FROM rooms WHERE id = ?')
      .get(req.params.id) as RoomRow | undefined
    if (!row) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    const user = userFromReq(req)
    if (row.password_hash) {
      if (!hashMatches(body.password ?? '', row.id, row.password_hash)) {
        res.status(401).json({ error: 'wrong password' })
        return
      }
      if (row.require_approval) {
        const existing = db
          .prepare('SELECT approved FROM join_requests WHERE room_id = ? AND user_id = ?')
          .get(row.id, user.id) as { approved: number } | undefined
        if (existing?.approved) {
          res.json({ status: 'ok', token: issueJoinToken(row.id, user.id) })
          return
        }
        db.prepare(
          `INSERT INTO join_requests (room_id, user_id, user_name, user_color, approved, created_at)
           VALUES (?, ?, ?, ?, 0, ?)
           ON CONFLICT(room_id, user_id) DO UPDATE SET
             user_name = excluded.user_name, user_color = excluded.user_color,
             approved = 0, created_at = excluded.created_at`
        ).run(row.id, user.id, user.name, user.color, Date.now())
        res.json({ status: 'pending' })
        return
      }
    }
    res.json({ status: 'ok', token: issueJoinToken(row.id, user.id) })
  })

  router.get('/api/rooms/:id/join/status', (req, res) => {
    const row = db
      .prepare('SELECT id, name, host_key_hash, host_user_id, password_hash, require_approval, updated_at FROM rooms WHERE id = ?')
      .get(req.params.id) as RoomRow | undefined
    if (!row) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    const user = userFromReq(req)
    if (!row.password_hash) {
      res.json({ status: 'ok', token: issueJoinToken(row.id, user.id) })
      return
    }
    const reqRow = db
      .prepare('SELECT approved FROM join_requests WHERE room_id = ? AND user_id = ?')
      .get(row.id, user.id) as { approved: number } | undefined
    if (reqRow?.approved) {
      res.json({ status: 'approved', token: issueJoinToken(row.id, user.id) })
      return
    }
    res.json({ status: 'pending' })
  })

  router.get('/api/rooms/:id/pending', (req, res) => {
    if (!requireHostToken(req.params.id, req.headers['x-host-token'] as string | undefined)) {
      res.status(401).json({ error: 'host token required' })
      return
    }
    const rows = db
      .prepare(
        'SELECT user_id, user_name, user_color, created_at FROM join_requests WHERE room_id = ? AND approved = 0 ORDER BY created_at ASC'
      )
      .all(req.params.id) as { user_id: string; user_name: string; user_color: string; created_at: number }[]
    res.json(rows.map((r) => ({ userId: r.user_id, userName: r.user_name, userColor: r.user_color, createdAt: r.created_at })))
  })

  router.post('/api/rooms/:id/approve', (req, res) => {
    if (!requireHostToken(req.params.id, req.headers['x-host-token'] as string | undefined)) {
      res.status(401).json({ error: 'host token required' })
      return
    }
    const body = parse(approveBody, req.body, res)
    if (!body) return
    db.prepare('UPDATE join_requests SET approved = 1 WHERE room_id = ? AND user_id = ?').run(req.params.id, body.userId)
    res.json({ ok: true })
  })

  router.post('/api/rooms/:id/claim', (req, res) => {
    const body = parse(claimBody, req.body, res)
    if (!body) return
    const row = db.prepare('SELECT id, name, host_key_hash, host_user_id, password_hash, require_approval, updated_at FROM rooms WHERE id = ?').get(req.params.id) as RoomRow | undefined
    if (!row) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    if (!row.host_key_hash || !hashMatches(body.hostKey, row.id, row.host_key_hash)) {
      res.status(401).json({ error: 'invalid host key' })
      return
    }
    const user = userFromReq(req)
    db.prepare('UPDATE rooms SET host_user_id = ?, updated_at = ? WHERE id = ?').run(user.id, Date.now(), row.id)
    res.json({ hostToken: issueHostToken(row.id, user.id), room: toPublicInfo(row) })
  })

  router.post('/api/rooms/mine', (req, res) => {
    const body = parse(mineBody, req.body, res)
    if (!body) return
    const rows = db.prepare('SELECT id, name, host_key_hash, host_user_id, password_hash, require_approval, updated_at FROM rooms').all() as RoomRow[]
    const found: { roomId: string; name: string; updatedAt: number }[] = []
    for (const key of body.keys) {
      for (const row of rows) {
        if (row.host_key_hash && hashMatches(key, row.id, row.host_key_hash)) {
          const { id: roomId, ...rest } = toInfo(row)
          found.push({ roomId, ...rest })
          break
        }
      }
    }
    res.json(found)
  })

  return router
}