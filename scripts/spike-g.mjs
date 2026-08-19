// Spike G — Phase 6 music end-to-end. Generates tiny tagged audio files with
// ffmpeg into <repo>/data/music (a real shared dir, so the scanner runs against
// real files), then runs the REAL server (dist/server) with a fresh temp
// DATA_DIR and MUSIC_DIR pointing at the generated files. Asserts: scan/listing
// with tags + duration + art fallbacks, Range streaming, refresh auth (host
// token), id stability across rescans, and two TLSyncClients syncing the
// musicState record (play → pause → promoted DJ).
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { WebSocket } from 'ws'
import { TLSyncClient } from '@tldraw/sync-core'
import { createTLStore } from '@tldraw/editor'
import { atom } from '@tldraw/state'
import { schema } from '../dist/shared/schema.js'

const APP_PORT = 3055
const MUSIC_DIR = new URL('../data/music/', import.meta.url).pathname
const TMP = '/tmp/opencode/spikeg'
const MUSIC_STATE_ID = 'musicState:global'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 16)
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id)

// ---------------------------------------------------------------------------
// Generate fixtures
// ---------------------------------------------------------------------------
function ff(...args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args])
}

rmSync(MUSIC_DIR, { recursive: true, force: true })
mkdirSync(MUSIC_DIR, { recursive: true })
mkdirSync(`${MUSIC_DIR}/samples`, { recursive: true })
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

// 96×96 accent-square "cover art"
ff('-f', 'lavfi', '-i', 'color=c=0x3182ed:s=96x96', '-frames:v', '1', `${TMP}/art.png`)
// track A: mp3 with tags + embedded cover art
ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-i', `${TMP}/art.png`,
  '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'png', '-id3v2_version', '3',
  '-metadata', 'title=Alpha Wave', '-metadata', 'artist=Spike Band', '-metadata', 'album=Spike EP',
  '-disposition:v', 'attached_pic', `${MUSIC_DIR}/alpha.mp3`)
// samples/cover.jpg → track B (subdir, no embedded art → cover fallback)
ff('-f', 'lavfi', '-i', 'color=c=0x4cb05e:s=96x96', '-frames:v', '1', `${MUSIC_DIR}/samples/cover.jpg`)
ff('-f', 'lavfi', '-i', 'sine=frequency=660:duration=2.5', '-c:a', 'libmp3lame',
  '-metadata', 'title=Beta Beat', '-metadata', 'artist=Spike Band', `${MUSIC_DIR}/samples/beta.mp3`)
// track C: untagged wav (filename-as-title, no art)
ff('-f', 'lavfi', '-i', 'anoisesrc=duration=2:amplitude=0.15', '-c:a', 'pcm_s16le', `${MUSIC_DIR}/gamma.wav`)
// decoy — the scanner must ignore non-audio files
execFileSync('sh', ['-c', `echo "not music" > ${MUSIC_DIR}/notes.txt`])

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'ok ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const app = spawn('node', ['dist/server/index.js'], {
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    DATA_DIR: `${TMP}/data`,
    MUSIC_DIR,
    SESSION_SECRET: 'spike-secret',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
app.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
app.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`))

let serverExit = null
app.on('exit', (code) => {
  serverExit = code
  process.exitCode = 1
})

class NodeSocket {
  constructor(ws) {
    this.ws = ws
    this.connectionStatus = 'offline'
    this.receive = new Set()
    this.status = new Set()
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      for (const cb of this.receive) cb(msg)
    })
    ws.on('open', () => this.setStatus('online'))
    ws.on('close', () => this.setStatus('offline'))
    ws.on('error', () => this.setStatus('error'))
  }
  setStatus(status) {
    this.connectionStatus = status
    for (const cb of this.status) cb({ status })
  }
  sendMessage(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }
  onReceiveMessage(cb) {
    this.receive.add(cb)
    return () => this.receive.delete(cb)
  }
  onStatusChange(cb) {
    this.status.add(cb)
    return () => this.status.delete(cb)
  }
  restart() {}
  close() {
    this.ws.close()
  }
}

function connectClient(roomId, userId) {
  const store = createTLStore({ schema })
  const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/sync/${roomId}`, {
    headers: { 'x-user-id': userId, 'x-user-name': `Spike ${userId}` },
  })
  const socket = new NodeSocket(ws)
  let loadedResolve
  const loaded = new Promise((r) => (loadedResolve = r))
  const client = new TLSyncClient({
    store,
    socket,
    presence: atom(`${userId}-presence`, null),
    presenceMode: atom('full'),
    onLoad: () => loadedResolve(),
    onSyncError: (err) => {
      console.error('client sync error', err)
      process.exit(1)
    },
  })
  return { client, store, loaded }
}

function musicState(overrides = {}) {
  return {
    id: MUSIC_STATE_ID,
    typeName: 'musicState',
    currentTrackId: null,
    playing: false,
    startedAt: null,
    positionMs: 0,
    queue: [],
    allowedMemberIds: [],
    updatedBy: 'spike-a',
    ...overrides,
  }
}

try {
  // wait for health
  let healthy = false
  for (let i = 0; i < 60; i++) {
    if (serverExit !== null) throw new Error(`server exited early (${serverExit})`)
    try {
      const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)
      if (res.ok) {
        healthy = true
        break
      }
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  check('server boots', healthy)

  // --- track list ---
  const listRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/music`)
  const list = await listRes.json()
  check('GET /api/music lists 3 tracks (decoy ignored)', Array.isArray(list.tracks) && list.tracks.length === 3, JSON.stringify(list.tracks.map((t) => t.title)))
  check('has scannedAt', typeof list.scannedAt === 'number')

  const alpha = list.tracks.find((t) => t.title === 'Alpha Wave')
  const beta = list.tracks.find((t) => t.title === 'Beta Beat')
  const gamma = list.tracks.find((t) => t.title === 'gamma')
  check('tags read (title/artist/album/duration)', alpha && alpha.artist === 'Spike Band' && alpha.album === 'Spike EP' && alpha.duration > 2.5, JSON.stringify(alpha))
  check('untagged wav falls back to filename', !!gamma && gamma.duration > 1, JSON.stringify(gamma))
  check('subdir track found', !!beta)
  check('embedded art → artUrl', alpha?.artUrl === `/media/art/${alpha.id}`, alpha?.artUrl ?? 'none')
  check('cover.jpg fallback → artUrl', !!beta?.artUrl)
  check('no art → artUrl null', gamma?.artUrl === null)
  check('alias GET /api/music/tracks works', (await (await fetch(`http://127.0.0.1:${APP_PORT}/api/music/tracks`)).json()).tracks.length === 3)

  // --- streaming ---
  const full = await fetch(`http://127.0.0.1:${APP_PORT}/media/track/${alpha.id}`)
  const fullBuf = Buffer.from(await full.arrayBuffer())
  check('GET /media/track/:id → 200 audio/mpeg', full.status === 200 && full.headers.get('content-type') === 'audio/mpeg' && fullBuf.length > 0, `status ${full.status}, ${fullBuf.length} bytes`)

  const ranged = await fetch(`http://127.0.0.1:${APP_PORT}/media/track/${alpha.id}`, { headers: { Range: 'bytes=0-99' } })
  const rangedBuf = Buffer.from(await ranged.arrayBuffer())
  check('Range → 206 with 100 bytes', ranged.status === 206 && ranged.headers.get('content-range')?.startsWith('bytes 0-99/') && rangedBuf.length === 100, `${ranged.status} ${ranged.headers.get('content-range')}`)

  const badId = await fetch(`http://127.0.0.1:${APP_PORT}/media/track/not-a-uuid`)
  check('invalid id → 400', badId.status === 400, String(badId.status))
  const missing = await fetch(`http://127.0.0.1:${APP_PORT}/media/track/00000000-0000-0000-0000-000000000000`)
  check('unknown id → 404', missing.status === 404, String(missing.status))
  const artOk = await fetch(`http://127.0.0.1:${APP_PORT}${beta.artUrl}`)
  check('GET /media/art/:id serves cover art', artOk.status === 200, String(artOk.status))
  const artMissing = await fetch(`http://127.0.0.1:${APP_PORT}/media/art/${gamma.id}`)
  check('art for track without art → 404', artMissing.status === 404, String(artMissing.status))
  const traversal = await fetch(`http://127.0.0.1:${APP_PORT}/media/track/..%2F..%2F..%2Fetc%2Fpasswd`)
  check('path traversal → 400', traversal.status === 400, String(traversal.status))

  // --- refresh auth ---
  const noToken = await fetch(`http://127.0.0.1:${APP_PORT}/api/music/refresh`, { method: 'POST' })
  check('refresh without host token → 401', noToken.status === 401, String(noToken.status))

  const room = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'spike music' }),
  })).json()
  const claim = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/rooms/${room.roomId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': 'host-user', 'x-user-name': 'Host User' },
    body: JSON.stringify({ hostKey: room.hostKey }),
  })).json()
  const hostToken = claim.hostToken
  check('room + claim issues a host token', typeof hostToken === 'string', room.roomId)

  const withToken = await fetch(`http://127.0.0.1:${APP_PORT}/api/music/refresh`, {
    method: 'POST',
    headers: { 'X-Host-Token': hostToken },
  })
  check('refresh with host token → 200, 3 tracks', withToken.status === 200 && (await withToken.json()).tracks.length === 3, String(withToken.status))

  // add a 4th track → rescan picks it up and keeps existing ids stable
  ff('-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:a', 'libmp3lame',
    '-metadata', 'title=Delta Drone', '-metadata', 'artist=Spike Band', `${MUSIC_DIR}/delta.mp3`)
  const refreshed = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/music/refresh`, {
    method: 'POST',
    headers: { 'X-Host-Token': hostToken },
  })).json()
  const alphaAfter = refreshed.tracks.find((t) => t.id === alpha.id)
  check('rescan adds new track (4) and preserves ids', refreshed.tracks.length === 4 && !!alphaAfter && alphaAfter.title === 'Alpha Wave', refreshed.tracks.length + ' tracks')

  // --- two-client musicState sync ---
  const a = connectClient(room.roomId, 'spike-a')
  const b = connectClient(room.roomId, 'spike-b')
  await Promise.all([
    Promise.race([a.loaded, sleep(10_000).then(() => Promise.reject(new Error('client a did not load')))])
  ])
  await Promise.race([b.loaded, sleep(10_000).then(() => Promise.reject(new Error('client b did not load')))])
  const storeA = a.store
  const storeB = b.store

  storeA.put([musicState({ currentTrackId: alpha.id, playing: true, startedAt: Date.now() })])
  await sleep(400)
  let bState = storeB.get(MUSIC_STATE_ID)
  check('client B observes play + track', bState?.playing === true && bState?.currentTrackId === alpha.id, JSON.stringify(bState))

  storeA.put([musicState({ ...storeA.get(MUSIC_STATE_ID), playing: false, startedAt: null, positionMs: 400 })])
  await sleep(300)
  bState = storeB.get(MUSIC_STATE_ID)
  check('client B observes pause + position', bState?.playing === false && bState?.positionMs >= 400, JSON.stringify(bState))

  storeB.put([musicState({ ...storeB.get(MUSIC_STATE_ID), allowedMemberIds: ['dj-user'] })])
  await sleep(300)
  const aState = storeA.get(MUSIC_STATE_ID)
  check('promote (allowedMemberIds) syncs A ← B', (aState?.allowedMemberIds ?? []).includes('dj-user'), JSON.stringify(aState?.allowedMemberIds))
} catch (error) {
  console.error('spike error stack:', error.stack)
  check('spike run', false, error.message)
} finally {
  app.kill('SIGTERM')
  await sleep(300)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map((f) => f.name).join(', '))
  process.exit(1)
}
process.exit(0)