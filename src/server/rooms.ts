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

type RoomRow = { id: string; name: string; host_user_id: string | null; host_key_hash: string | null; updated_at: number }

export type RoomInfo = { id: string; name: string; updatedAt: number }

function toInfo(row: RoomRow): RoomInfo {
  return { id: row.id, name: row.name, updatedAt: row.updated_at }
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

// --- request validation ---

const createBody = z.object({ name: z.string().trim().min(1).max(80).optional() })
const renameBody = z.object({ name: z.string().trim().min(1).max(80) })
const claimBody = z.object({ hostKey: z.string().trim().min(1) })
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
      'INSERT INTO rooms (id, name, host_user_id, host_key_hash, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)'
    ).run(roomId, name, hostKeyHash(hostKey, roomId), now, now)
    res.json({ roomId, hostKey, name })
  })

  router.get('/api/rooms/:id', (req, res) => {
    const row = db.prepare('SELECT id, name, host_key_hash, host_user_id, updated_at FROM rooms WHERE id = ?').get(req.params.id) as RoomRow | undefined
    if (!row) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    res.json(toInfo(row))
  })

  router.put('/api/rooms/:id', (req, res) => {
    if (!requireHostToken(req.params.id, req.headers['x-host-token'] as string | undefined)) {
      res.status(401).json({ error: 'host token required' })
      return
    }
    const body = parse(renameBody, req.body, res)
    if (!body) return
    const info = db
      .prepare('UPDATE rooms SET name = ?, updated_at = ? WHERE id = ? RETURNING id, name, host_key_hash, host_user_id, updated_at')
      .get(body.name, Date.now(), req.params.id) as RoomRow | undefined
    if (!info) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    res.json(toInfo(info))
  })

  router.post('/api/rooms/:id/claim', (req, res) => {
    const body = parse(claimBody, req.body, res)
    if (!body) return
    const row = db.prepare('SELECT id, name, host_key_hash, host_user_id, updated_at FROM rooms WHERE id = ?').get(req.params.id) as RoomRow | undefined
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
    res.json({ hostToken: issueHostToken(row.id, user.id), room: toInfo(row) })
  })

  router.post('/api/rooms/mine', (req, res) => {
    const body = parse(mineBody, req.body, res)
    if (!body) return
    const rows = db.prepare('SELECT id, name, host_key_hash, host_user_id, updated_at FROM rooms').all() as RoomRow[]
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