import express from 'express'
import { createServer } from 'node:http'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import Database from 'better-sqlite3'
import { DATA_DIR, getDb } from './db'
import { createAssetsRouter } from './assets'
import { createRoomsRouter } from './rooms'
import { createMusicRouter } from './music'
import { scanMusicDir } from './music/scanner'
import { RoomManager } from './sync'
import { AgentService } from './ai/service'
import { SessionManager } from './ai/sessions'
import { AGENT_MODEL_DEFINITIONS, isValidModelName } from '../shared/agent/models'
import type { AgentModelProvider } from '../shared/agent/models'
import type { UserInfo } from '../shared/types'

const PORT = Number(process.env.PORT ?? 3000)
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
  console.error(
    `failed to open database at ${DATA_DIR}: ${err instanceof Error ? err.message : err}`
  )
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
    socket.close(1008, 'bad room id')
    return
  }
  const roomId = match[1]!

  // Only rooms created via POST /api/rooms (a `rooms` row) may be joined. A
  // typo'd or hostile id must not materialize a phantom room, its sync tables,
  // or a headless AI session — and this is what surfaces as the "room not
  // found" error in the client.
  const known = db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId)
  if (!known) {
    socket.close(1008, 'room not found')
    return
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

// Models the server can run: the kit's model definitions for any provider whose
// API key is configured, plus OPENAI_DEFAULT_MODEL as a fallback entry so the
// picker is never empty. The session pre-validates the chosen promptModel and
// falls back to DEFAULT_MODEL_NAME when it isn't a runnable definition.
app.get('/api/ai/models', (_req, res) => {
  const configured: Record<AgentModelProvider, boolean> = {
    openai: !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    google: !!process.env.GOOGLE_API_KEY,
  }
  const models: { id: string; name: string; provider: string }[] = Object.entries(
    AGENT_MODEL_DEFINITIONS
  )
    .filter(([, def]) => configured[def.provider])
    .map(([id, def]) => ({ id, name: def.name, provider: def.provider }))
  const envDefault = process.env.OPENAI_DEFAULT_MODEL
  // Only expose a real defined model; an invalid env default (e.g. gpt-4o-mini)
  // must not pollute the picker or become the pre-selected entry.
  if (envDefault && isValidModelName(envDefault) && !models.some((m) => m.id === envDefault)) {
    models.unshift({ id: envDefault, name: envDefault, provider: 'openai' })
  }
  res.json({ models })
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
app.use(createRoomsRouter(db, userFromReq))
app.use(createAssetsRouter(db))
app.use(createMusicRouter(db))

const webDist = path.resolve(import.meta.dirname, '../web')
app.use(express.static(webDist))

// Rescan on boot BEFORE listen so the track list is ready for the first
// client (and so /api/music never races a partially-completed scan).
// A scan failure must not block boot — music is optional.
scanMusicDir(db)
  .then((r) => console.log(`music scan: ${r.tracks.length} track(s) (${r.added} new, ${r.removed} removed)`))
  .catch((err) => console.error('music scan failed', err))
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`listening on :${PORT}`)
    })
  })

// ponytail: fail loudly with a clear line when the port is taken (e.g. the
// :3000 conflict documented in the README) instead of an unhandled error event.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port :${PORT} is already in use — set PORT to a free port (see README)`)
    process.exit(1)
  }
  throw err
})