import express from 'express'
import { createServer } from 'node:http'
import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import Database from 'better-sqlite3'
import { DATA_DIR, PORT } from './config'
import { getDb } from './db'
import { log } from './log'
import { createAssetsRouter } from './assets'
import { createRoomsRouter, requireJoinToken } from './rooms'
import { createMusicRouter } from './music'
import { scanMusicDir, lastScanAt } from './music/scanner'
import { RoomManager } from './sync'
import { AgentService } from './ai/service'
import { SessionManager } from './ai/sessions'
import { AGENT_MODEL_DEFINITIONS, compareProviderOrder, isValidModelName, resolveDefaultModelName } from '../shared/agent/models'
import type { AgentModelProvider } from '../shared/agent/models'
import type { UserInfo } from '../shared/types'
import type { AiModelInfo } from '../shared/types'

const app = express()
const server = createServer(app)

// ponytail: one-line security header; nothing else is worth a dependency here.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  next()
})

let db: Database.Database
try {
  db = getDb()
} catch (err) {
  // A locked/unwritable DB must fail loudly at boot, not mid-request.
  log.error(`failed to open database at ${DATA_DIR}: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
const service = new AgentService({
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiBaseUrl: process.env.OPENAI_BASE_URL,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  googleApiKey: process.env.GOOGLE_API_KEY,
})
const sessions = new SessionManager(service, db)
const rooms = new RoomManager(db, {
  onRoomCreated: (roomId, room) => sessions.ensureSession(roomId, room),
  onRoomDestroyed: (roomId) => sessions.destroySession(roomId),
})

const wss = new WebSocketServer({ noServer: true })

const ANON: UserInfo = { id: 'anon', name: 'Guest', color: '#3182ed' }

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (typeof cookieHeader !== 'string') return undefined
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

// Browsers can't set WS headers, so the web client sends identity as a cookie.
// Node spike scripts use x-user-* headers instead.
function userFromReq(req: { headers: Record<string, string | string[] | undefined> }): UserInfo {
  const cookieHeader = req.headers.cookie
  if (typeof cookieHeader === 'string') {
    for (const part of cookieHeader.split(';')) {
      const [key, ...rest] = part.trim().split('=')
      if (key !== 't2user') continue
      try {
        const parsed = JSON.parse(decodeURIComponent(rest.join('=')))
        if (parsed && typeof parsed.id === 'string' && typeof parsed.name === 'string') {
          return { id: parsed.id, name: parsed.name, color: typeof parsed.color === 'string' ? parsed.color : ANON.color }
        }
      } catch {
        // fall through to headers / default
      }
    }
  }
  const h = req.headers as Record<string, string | undefined>
  return {
    id: h['x-user-id'] ?? ANON.id,
    name: h['x-user-name'] ?? ANON.name,
    color: h['x-user-color'] ?? ANON.color,
  }
}

wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = url.pathname.match(/^\/sync\/([a-z0-9]+)$/)
  if (!match) {
    socket.close(4099, 'NOT_FOUND')
    return
  }
  const roomId = match[1]!

  // Only rooms created via POST /api/rooms (a `rooms` row) may be joined. A
  // typo'd or hostile id must not materialize a phantom room, its sync tables,
  // or a headless AI session — and this is what surfaces as the "room not
  // found" error in the client.
  //
  // 4099 is tldraw's TLSyncErrorCloseEventCode: only this code puts the
  // client's useSync into `error` with the reason as the message (any other
  // code just looks like a dropped connection and retries forever). NOT_FOUND
  // vs FORBIDDEN is what the client maps to its not-found / access-denied UI.
  const known = db.prepare('SELECT password_hash FROM rooms WHERE id = ?').get(roomId) as
    | { password_hash: string | null }
    | undefined
  if (!known) {
    log.warn(`room ${roomId}: WS rejected (NOT_FOUND)`)
    socket.close(4099, 'NOT_FOUND')
    return
  }

  // Password-protected rooms require a valid join token for THIS room (the
  // t2join cookie set by POST /api/rooms/:id/join). Public rooms need none.
  if (known.password_hash) {
    if (!requireJoinToken(roomId, readCookie(req.headers.cookie, 't2join'))) {
      log.warn(`room ${roomId}: WS rejected (FORBIDDEN)`)
      socket.close(4099, 'FORBIDDEN')
      return
    }
  }

  rooms.handleConnect(roomId, socket, userFromReq(req))

  socket.on('close', () => rooms.handleDisconnect(roomId))
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/sync/')) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

// Liveness vs readiness: /api/health only proves the process answers; /ready
// proves it can serve rooms (DB writable, music scanned, sessions counted).
// Load balancers / compose `depends_on` should gate on this, not /api/health.
app.get('/ready', (_req, res) => {
  try {
    db.prepare('SELECT 1 AS ok').get()
    accessSync(DATA_DIR, constants.W_OK)
  } catch {
    res.status(503).json({ ready: false, db: 'error' })
    return
  }
  const scannedAt = lastScanAt()
  res.json({
    ready: true,
    db: 'ok',
    scannedAt,
    scanAgeMs: scannedAt === null ? null : Date.now() - scannedAt,
    sessions: sessions.size,
  })
})

// Models the server can run: the kit's model definitions for any provider whose
// API key is configured, ordered Google -> OpenAI-compatible -> Anthropic so the
// picker defaults to the cheapest good setup. Includes defaultModel (the single
// shared default) so the client never guesses: Gemini Flash with GOOGLE_API_KEY,
// else a valid OPENAI_DEFAULT_MODEL, else gpt-5.4-mini.
app.get('/api/ai/models', (_req, res) => {
  const configured: Record<AgentModelProvider, boolean> = {
    openai: !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    google: !!process.env.GOOGLE_API_KEY,
  }
  const models: { id: string; name: string; provider: string }[] = Object.entries(
    AGENT_MODEL_DEFINITIONS
  )
    // lastAuthFailed comes from the boot/live probe — a rejected key must not
    // advertise models here either (keeps the fallback path coherent).
    .filter(([, def]) => configured[def.provider] && !service.lastAuthFailed.includes(def.provider))
    .map(([id, def]) => ({ id, name: def.name, provider: def.provider }))
  const envDefault = process.env.OPENAI_DEFAULT_MODEL
  // Only expose a real defined model; an invalid env default (e.g. gpt-4o-mini)
  // must not pollute the picker or become the pre-selected entry.
  if (envDefault && isValidModelName(envDefault) && !models.some((m) => m.id === envDefault)) {
    try {
      const def = (AGENT_MODEL_DEFINITIONS as Record<string, { provider: string; name: string }>)[envDefault]
      models.push({ id: envDefault, name: def?.name ?? envDefault, provider: def?.provider ?? 'openai' })
    } catch {
      // ponytail: live-only ids are already runnable via /live; skip here
    }
  }
  models.sort((a, b) => compareProviderOrder(a.provider as AgentModelProvider, b.provider as AgentModelProvider))
  const defaultModel = resolveDefaultModelName(process.env as Record<string, string | undefined>)
  res.json({ models, defaultModel })
})

// Models each configured provider actually serves, fetched live at request
// time and merged with the static definitions (which keep their tuned options).
// Best-effort: a failed provider fetch falls back to the static defs with
// liveFailed:true instead of 500ing, and live-only entries carry known:false.
app.get('/api/ai/models/live', async (_req, res) => {
  const { models: live, liveFailed, authFailed } = await service.listLiveModels()
  const configured: Record<AgentModelProvider, boolean> = {
    openai: !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    google: !!process.env.GOOGLE_API_KEY,
  }
  // A key that was actively rejected (401/403/API_KEY_INVALID) must not offer
  // its provider's models — every pick would fail at stream time.
  const rejected = new Set(authFailed)
  const byId = new Map<string, AiModelInfo>()
  for (const [id, def] of Object.entries(AGENT_MODEL_DEFINITIONS)) {
    if (configured[def.provider] && !rejected.has(def.provider))
      byId.set(id, { id, name: def.name, provider: def.provider, known: true })
  }
  for (const m of live) {
    if (!byId.has(m.id)) byId.set(m.id, { id: m.id, name: m.id, provider: m.provider, known: false, chat: m.chat })
  }
  const ordered = [...byId.values()].sort((a, b) =>
    compareProviderOrder(a.provider as AgentModelProvider, b.provider as AgentModelProvider)
  )
  const defaultModel = resolveDefaultModelName(process.env as Record<string, string | undefined>)
  res.json({ models: ordered, liveFailed, authFailed, defaultModel })
})

app.use(express.json())
// malformed JSON bodies (express's json parse throws before zod sees the body)
// must 400 with clean JSON, not express's default HTML stack-trace page
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'invalid JSON body' })
    return
  }
  next(err)
})
app.use(createRoomsRouter(db, userFromReq, { onDeleted: (roomId) => rooms.deleteRoom(roomId) }))
app.use(createAssetsRouter(db))
app.use(createMusicRouter(db, { userFromReq, peekRoom: (roomId) => rooms.peekRoom(roomId) }))

// User-facing AI cancel: aborts the in-flight provider stream and releases the
// room's AI lock. Idempotent — unknown/empty rooms just return ok.
app.post('/api/rooms/:id/ai/cancel', (req, res) => {
  sessions.cancelSession(req.params.id)
  res.json({ ok: true })
})

const webDist = path.resolve(import.meta.dirname, '../web')
// Hashed assets are immutable (cache forever); index.html must always be
// revalidated or clients keep running a stale bundle that references assets
// the next deploy deletes.
app.use(
  express.static(webDist, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
    },
  })
)
const sendIndex = (_req: express.Request, res: express.Response) => {
  res.setHeader('Cache-Control', 'no-cache')
  res.sendFile(path.join(webDist, 'index.html'))
}
// Final fallback: SPA entry for any unmatched GET — except /media/*, where a
// miss is a bad id/traversal probe, not a client route (it must 404, never
// serve index.html with 200).
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (req.path.startsWith('/media/')) {
      res.status(404).json({ error: 'not found' })
      return
    }
    return sendIndex(req, res)
  }
  next()
})

// Rescan on boot BEFORE listen so the track list is ready for the first
// client (and so /api/music never races a partially-completed scan).
// A scan failure must not block boot — music is optional.
scanMusicDir(db)
  .then((r) => log.info(`music scan: ${r.tracks.length} track(s) (${r.added} new, ${r.removed} removed)`))
  .catch((err) => log.error('music scan failed', err))
  .finally(() => {
    server.listen(PORT, () => {
      log.info(`listening on :${PORT}`)
    })
  })

// Best-effort boot check, fully decoupled from listen: warn loudly when a
// configured key is present but the provider rejects it — the #1 "AI doesn't
// work" cause is a bad/placeholder key.
service.listLiveModels().then(({ authFailed }) => {
  if (authFailed.includes('openai'))
    log.warn('OPENAI_API_KEY was rejected by the provider — check the key / OPENAI_BASE_URL in your .env')
  if (authFailed.includes('google'))
    log.warn('GOOGLE_API_KEY was rejected by generativelanguage.googleapis.com — check the key in your .env')
})

// ponytail: fail loudly with a clear line when the port is taken (e.g. the
// :3000 conflict documented in the README) instead of an unhandled error event.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`port :${PORT} is already in use — set PORT to a free port (see README)`)
    process.exit(1)
  }
  throw err
})

// Graceful drain (single instance): stop accepting, close every WS client so
// sync stops writing, drop the in-memory rooms (their AI sessions die with
// them via onRoomDestroyed), WAL-checkpoint, then close the DB. Rooms persist
// per change, so room.close() is the flush — nothing extra to write out.
let shuttingDown = false
function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`received ${signal} — draining (${rooms.size} live room(s))`)
  server.close(() => process.exit(0))
  try {
    wss.close()
  } catch {
    // already closed
  }
  for (const client of wss.clients) {
    try {
      client.close(1001, 'server shutting down')
    } catch {
      // best-effort
    }
  }
  try {
    rooms.closeAll()
  } catch (err) {
    log.error('error closing rooms during shutdown', err)
  }
  try {
    sessions.stop()
  } catch {
    // belt-and-suspenders: closeAll already destroyed every live session
  }
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (err) {
    log.error('WAL checkpoint failed during shutdown', err)
  }
  try {
    db.close()
  } catch {
    // best-effort
  }
  log.info('shutdown complete')
  // Keep-alive sockets can hold server.close()'s callback forever; force the
  // exit rather than hanging the container stop.
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))