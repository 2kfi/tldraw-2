import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import { DATA_DIR, SESSION_SECRET } from './config'
import { log } from './log'
import { createRoomId } from '../shared/ids'
import type { UserInfo } from '../shared/types'

const HOST_KEY_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SECRET = SESSION_SECRET
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

// --- host tokens (HMAC-SHA256 over roomId + userId + exp + kind, stateless) ---
// kind separates privileges: 'host' grants management APIs, 'join' only proves
// room access (WS gate, DJ caller id). requireHostToken rejects join tokens.

export function issueHostToken(roomId: string, userId: string): string {
  const exp = Date.now() + TOKEN_TTL_MS
  const sig = createHmac('sha256', SECRET).update(`${roomId}.${userId}.${exp}.host`).digest('base64url')
  return `${roomId}.${userId}.${exp}.host.${sig}`
}

/** Validates an X-Host-Token for a room. Returns the token's userId, or null when invalid/expired. */
export function requireHostToken(roomId: string, token: string | undefined): string | null {
  if (!token) return null
  const parts = token.split('.')
  // Legacy 4-part tokens (pre-kind) were host-only — accept for backwards compat.
  if (parts.length === 4) {
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
  if (parts.length !== 5) return null
  const [tokRoom, userId, expStr, kind, sig] = parts
  if (tokRoom !== roomId || kind !== 'host') return null
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now()) return null
  const expected = createHmac('sha256', SECRET).update(`${tokRoom}.${userId}.${exp}.host`).digest('base64url')
  const a = Buffer.from(sig ?? '')
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return userId!
}

// --- join tokens (same stateless HMAC scheme as host tokens, stored in the
// t2join cookie). kind='join' — never accepted by requireHostToken. ---

export function issueJoinToken(roomId: string, userId: string): string {
  const exp = Date.now() + TOKEN_TTL_MS
  const sig = createHmac('sha256', SECRET).update(`${roomId}.${userId}.${exp}.join`).digest('base64url')
  return `${roomId}.${userId}.${exp}.join.${sig}`
}

/** Validates a join token for a room. Accepts join-kind and host-kind (a host
 *  may always join); legacy 4-part tokens count as host. Returns userId or null. */
export function requireJoinToken(roomId: string, token: string | undefined): string | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length === 4) return requireHostToken(roomId, token)
  if (parts.length !== 5) return null
  const [tokRoom, userId, expStr, kind, sig] = parts
  if (tokRoom !== roomId || (kind !== 'join' && kind !== 'host')) return null
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now()) return null
  const expected = createHmac('sha256', SECRET).update(`${tokRoom}.${userId}.${exp}.${kind}`).digest('base64url')
  const a = Buffer.from(sig ?? '')
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return userId!
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

export function createRoomsRouter(
  db: Database,
  userFromReq: UserParser,
  hooks: { onDeleted?: (roomId: string) => void } = {}
) {
  const router = Router()

  // Prepared once at setup instead of per request. (PUT /api/rooms/:id keeps an
  // inline prepare — its SET clause is composed from the request body.)
  const insertRoomStmt = db.prepare(
    'INSERT INTO rooms (id, name, host_user_id, host_key_hash, password_hash, require_approval, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)'
  )
  const selectRoomByIdStmt = db.prepare(
    'SELECT id, name, host_key_hash, host_user_id, password_hash, require_approval, updated_at FROM rooms WHERE id = ?'
  )
  const updateRoomHostStmt = db.prepare('UPDATE rooms SET host_user_id = ?, updated_at = ? WHERE id = ?')
  const selectAllRoomsStmt = db.prepare(
    'SELECT id, name, host_key_hash, host_user_id, password_hash, require_approval, updated_at FROM rooms'
  )
  const selectJoinRequestStmt = db.prepare('SELECT approved FROM join_requests WHERE room_id = ? AND user_id = ?')
  const insertJoinRequestStmt = db.prepare(
    `INSERT INTO join_requests (room_id, user_id, user_name, user_color, approved, created_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(room_id, user_id) DO UPDATE SET
       user_name = excluded.user_name, user_color = excluded.user_color,
       approved = 0, created_at = excluded.created_at`
  )
  // ponytail: join_requests grows forever otherwise; approved rows older than a
  // week are pruned lazily on pending reads. Stale *pending* rows (>30d, the
  // requester long gone) go with them — re-requesting is one click.
  const pruneApprovedJoinsStmt = db.prepare(
    `DELETE FROM join_requests WHERE approved = 1 AND created_at < ?`
  )
  const pruneStalePendingJoinsStmt = db.prepare(
    `DELETE FROM join_requests WHERE approved = 0 AND created_at < ?`
  )
  const selectPendingJoinsStmt = db.prepare(
    'SELECT user_id, user_name, user_color, created_at FROM join_requests WHERE room_id = ? AND approved = 0 ORDER BY created_at ASC'
  )
  const approveJoinStmt = db.prepare('UPDATE join_requests SET approved = 1 WHERE room_id = ? AND user_id = ?')

  router.post('/api/rooms', (req, res) => {
    const body = parse(createBody, req.body, res)
    if (!body) return
    const roomId = createRoomId()
    const hostKey = randomHostKey()
    const name = body.name ?? DEFAULT_NAME
    const now = Date.now()
    insertRoomStmt.run(
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
    const row = selectRoomByIdStmt.get(req.params.id) as RoomRow | undefined
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

  // Host-only room delete: drops the per-room sync tables (room_<id>_*), the
  // room's asset rows + files, its join requests, and the rooms row itself,
  // then tells the caller (index.ts) to drop the in-memory room + AI session.
  router.delete('/api/rooms/:id', (req, res) => {
    const roomId = req.params.id
    if (!requireHostToken(roomId, req.headers['x-host-token'] as string | undefined)) {
      res.status(401).json({ error: 'host token required' })
      return
    }
    // Room ids are [a-z0-9]+ (see shared/ids); anything else can neither exist
    // nor be safely interpolated into the DROP TABLE lookup below.
    if (!/^[a-z0-9]+$/.test(roomId)) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    if (!selectRoomByIdStmt.get(roomId)) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    const prefix = `room_${roomId}_`
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?`).all(`${prefix}%`) as {
        name: string
      }[]
    ).filter((t) => t.name.startsWith(prefix))
    for (const t of tables) {
      db.exec(`DROP TABLE IF EXISTS "${t.name.replace(/"/g, '""')}"`)
    }
    // Asset files are best-effort (a missing file must not fail the delete);
    // the DB rows go in one transaction with the room + join-request rows.
    const assetRows = db.prepare('SELECT path FROM assets WHERE room_id = ?').all(roomId) as { path: string }[]
    for (const r of assetRows) {
      try {
        const abs = path.resolve(DATA_DIR, r.path)
        if (abs.startsWith(path.resolve(DATA_DIR) + path.sep)) rmSync(abs, { force: true })
      } catch {
        // best-effort
      }
    }
    db.transaction(() => {
      db.prepare('DELETE FROM assets WHERE room_id = ?').run(roomId)
      db.prepare('DELETE FROM join_requests WHERE room_id = ?').run(roomId)
      db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId)
    })()
    log.info(`room ${roomId} deleted (${tables.length} sync table(s), ${assetRows.length} asset(s))`)
    hooks.onDeleted?.(roomId)
    res.json({ ok: true })
  })

  router.post('/api/rooms/:id/join', (req, res) => {
    const body = parse(joinBody, req.body, res)
    if (!body) return
    const row = selectRoomByIdStmt.get(req.params.id) as RoomRow | undefined
    if (!row) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    // The host never enters their own password or waits for approval.
    const hostUserId = requireHostToken(req.params.id, req.headers['x-host-token'] as string | undefined)
    if (hostUserId) {
      res.json({ status: 'ok', token: issueJoinToken(row.id, hostUserId) })
      return
    }
    const user = userFromReq(req)
    if (row.password_hash) {
      if (!hashMatches(body.password ?? '', row.id, row.password_hash)) {
        res.status(401).json({ error: 'wrong password' })
        return
      }
      if (row.require_approval) {
        const existing = selectJoinRequestStmt.get(row.id, user.id) as { approved: number } | undefined
        if (existing?.approved) {
          res.json({ status: 'ok', token: issueJoinToken(row.id, user.id) })
          return
        }
        insertJoinRequestStmt.run(row.id, user.id, user.name, user.color, Date.now())
        res.json({ status: 'pending' })
        return
      }
    }
    res.json({ status: 'ok', token: issueJoinToken(row.id, user.id) })
  })

  router.get('/api/rooms/:id/join/status', (req, res) => {
    const row = selectRoomByIdStmt.get(req.params.id) as RoomRow | undefined
    if (!row) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    const user = userFromReq(req)
    if (!row.password_hash) {
      res.json({ status: 'ok', token: issueJoinToken(row.id, user.id) })
      return
    }
    const reqRow = selectJoinRequestStmt.get(row.id, user.id) as { approved: number } | undefined
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
    // lazy prune of week-old approved rows (see pruneApprovedJoinsStmt)
    pruneApprovedJoinsStmt.run(Date.now() - 7 * 24 * 60 * 60 * 1000)
    pruneStalePendingJoinsStmt.run(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const rows = selectPendingJoinsStmt.all(req.params.id) as {
      user_id: string
      user_name: string
      user_color: string
      created_at: number
    }[]
    res.json(rows.map((r) => ({ userId: r.user_id, userName: r.user_name, userColor: r.user_color, createdAt: r.created_at })))
  })

  router.post('/api/rooms/:id/approve', (req, res) => {
    if (!requireHostToken(req.params.id, req.headers['x-host-token'] as string | undefined)) {
      res.status(401).json({ error: 'host token required' })
      return
    }
    const body = parse(approveBody, req.body, res)
    if (!body) return
    // Approving into a deleted room must not silently succeed.
    if (!selectRoomByIdStmt.get(req.params.id)) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    // Approving a user who never requested access is a typo'd userId, not a
    // success — the guest would wait on 'pending' forever otherwise.
    const info = approveJoinStmt.run(req.params.id, body.userId)
    if (info.changes === 0) {
      res.status(404).json({ error: 'unknown join request' })
      return
    }
    res.json({ ok: true })
  })

  router.post('/api/rooms/:id/claim', (req, res) => {
    const body = parse(claimBody, req.body, res)
    if (!body) return
    const row = selectRoomByIdStmt.get(req.params.id) as RoomRow | undefined
    if (!row) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    if (!row.host_key_hash || !hashMatches(body.hostKey, row.id, row.host_key_hash)) {
      res.status(401).json({ error: 'invalid host key' })
      return
    }
    const user = userFromReq(req)
    updateRoomHostStmt.run(user.id, Date.now(), row.id)
    res.json({ hostToken: issueHostToken(row.id, user.id), room: toPublicInfo(row) })
  })

  router.post('/api/rooms/mine', (req, res) => {
    const body = parse(mineBody, req.body, res)
    if (!body) return
    const rows = selectAllRoomsStmt.all() as RoomRow[]
    const found: { roomId: string; name: string; updatedAt: number }[] = []
    // ponytail: worst case (no key matches) is still keys × rows sha256s; fine
    // at this scale. Each room can match at most one key, so matched rooms drop
    // out of the pool and findIndex early-exits on first hit.
    let pool = rows.filter((r) => !!r.host_key_hash)
    for (const key of body.keys) {
      const idx = pool.findIndex((row) => hashMatches(key, row.id, row.host_key_hash!))
      if (idx < 0) continue
      const { id: roomId, ...rest } = toInfo(pool[idx]!)
      found.push({ roomId, ...rest })
      pool = pool.filter((_, i) => i !== idx)
    }
    res.json(found)
  })

  return router
}