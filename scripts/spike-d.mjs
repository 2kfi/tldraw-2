// Spike D — Phase 3: rooms persistence + host keys + restart survival.
// Requires `npm run build` first. Starts the real server on PORT=3052 with a
// fresh temp DATA_DIR, exercises the rooms API (create/get/claim/rename/mine),
// then writes a shape through the real WebSocket sync path, restarts the server
// process, reconnects, and asserts the shape survived the restart.
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 16)
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id)
import { TLSyncClient } from '@tldraw/sync-core'
import { createTLStore } from '@tldraw/editor'
import { atom } from '@tldraw/state'
import { WebSocket } from 'ws'
import { createDefaultAiState, schema } from '../dist/shared/schema.js'
import { createShapeId, toRichText } from '@tldraw/tlschema'

const PORT = 3052
const BASE = `http://localhost:${PORT}`
const WS_BASE = `ws://localhost:${PORT}`
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'tldraw2-spike-d-'))

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

let server
function startServer() {
  server = spawn('node', ['dist/server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: 'ignore',
  })
}

function stopServer() {
  if (server) {
    server.kill('SIGTERM')
    server = null
  }
}

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return
    } catch {
      // server not up yet
    }
    await sleep(100)
  }
  throw new Error('server did not become healthy')
}

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
  restart() {
    /* ponytail: one-shot spike, no reconnect logic needed */
  }
  close() {
    this.ws.close()
  }
}

function connectClient(user, roomId) {
  const store = createTLStore({ schema })
  const ws = new WebSocket(`${WS_BASE}/sync/${roomId}`, {
    headers: { 'x-user-id': user.id, 'x-user-name': user.name, 'x-user-color': user.color },
  })
  const socket = new NodeSocket(ws)
  let loadedResolve
  const loaded = new Promise((r) => (loadedResolve = r))
  const client = new TLSyncClient({
    store,
    socket,
    presence: atom(null),
    presenceMode: atom('full'),
    onLoad: () => loadedResolve(),
    onSyncError: (err) => {
      console.error('sync error', err)
      process.exit(1)
    },
  })
  return { client, store, loaded }
}

const SHAPE_MARK = { x: 500, y: 250, w: 200 }

async function putShape(store) {
  store.put([
    store.schema.types.shape.create({
      id: createShapeId(),
      parentId: 'page:page',
      index: 'a0',
      type: 'geo',
      x: SHAPE_MARK.x,
      y: SHAPE_MARK.y,
      props: {
        geo: 'rectangle',
        dash: 'solid',
        url: '',
        w: SHAPE_MARK.w,
        h: 120,
        growY: 0,
        scale: 1,
        flipX: false,
        flipY: false,
        labelColor: 'black',
        color: 'blue',
        fill: 'none',
        size: 'm',
        font: 'draw',
        align: 'middle',
        verticalAlign: 'middle',
        richText: toRichText('persisted'),
      },
    }),
  ])
  store.put([createDefaultAiState()])
}

async function assertShape(store, label) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const shapes = [...store.query.records('shape').get()]
    if (shapes.some((s) => s.x === SHAPE_MARK.x && s.y === SHAPE_MARK.y && s.props?.w === SHAPE_MARK.w)) {
      console.log(`PASS: ${label}`)
      return
    }
    await sleep(25)
  }
  throw new Error(`FAIL: ${label} — shape not found`)
}

let failed = false
try {
  startServer()
  await waitForHealth()

  // --- host-key API flow ---
  const created = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).then((r) => r.json())
  if (!created.roomId || !created.hostKey || created.name !== 'Untitled board') {
    throw new Error(`bad create response: ${JSON.stringify(created)}`)
  }
  console.log(`PASS: create room -> roomId=${created.roomId} hostKey(len)=${created.hostKey.length}`)

  const info = await fetch(`${BASE}/api/rooms/${created.roomId}`).then((r) => r.json())
  if (info.name !== 'Untitled board' || info.id !== created.roomId || !info.updatedAt) {
    throw new Error(`bad GET room: ${JSON.stringify(info)}`)
  }
  console.log('PASS: GET /api/rooms/:id returns name + updatedAt')

  const wrongClaim = await fetch(`${BASE}/api/rooms/${created.roomId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostKey: 'definitely-wrong-key' }),
  })
  if (wrongClaim.status !== 401) throw new Error(`wrong key claim status ${wrongClaim.status}`)
  console.log('PASS: claim with wrong key -> 401')

  const claim = await fetch(`${BASE}/api/rooms/${created.roomId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': randomUUID() },
    body: JSON.stringify({ hostKey: created.hostKey }),
  }).then((r) => r.json())
  if (!claim.hostToken || claim.room.id !== created.roomId) {
    throw new Error(`bad claim: ${JSON.stringify(claim)}`)
  }
  console.log('PASS: claim with correct key -> hostToken issued')

  const noTokenRename = await fetch(`${BASE}/api/rooms/${created.roomId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'nope' }),
  })
  if (noTokenRename.status !== 401) throw new Error(`rename without token status ${noTokenRename.status}`)
  console.log('PASS: rename without token -> 401')

  const rename = await fetch(`${BASE}/api/rooms/${created.roomId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Host-Token': claim.hostToken },
    body: JSON.stringify({ name: 'Phase 3 board' }),
  }).then((r) => r.json())
  if (rename.name !== 'Phase 3 board') throw new Error(`rename failed: ${JSON.stringify(rename)}`)
  console.log('PASS: rename with token -> ok')

  const mineRight = await fetch(`${BASE}/api/rooms/mine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: [created.hostKey] }),
  }).then((r) => r.json())
  if (!Array.isArray(mineRight) || mineRight.length !== 1 || mineRight[0].roomId !== created.roomId) {
    throw new Error(`mine with right key: ${JSON.stringify(mineRight)}`)
  }
  console.log('PASS: /api/rooms/mine with correct key lists the room')

  const mineWrong = await fetch(`${BASE}/api/rooms/mine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: ['garbage-key'] }),
  }).then((r) => r.json())
  if (!Array.isArray(mineWrong) || mineWrong.length !== 0) {
    throw new Error(`mine with wrong key: ${JSON.stringify(mineWrong)}`)
  }
  console.log('PASS: /api/rooms/mine with wrong key -> empty')

  // --- hardening: 404s, zod 400s, no secret leak, bodiless create ---
  const missingRoom = await fetch(`${BASE}/api/rooms/does-not-exist`)
  if (missingRoom.status !== 404) throw new Error(`GET unknown room status ${missingRoom.status}`)
  console.log('PASS: GET /api/rooms/:id unknown id -> 404')

  const garbageMine = await fetch(`${BASE}/api/rooms/mine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: 'not-an-array' }),
  })
  if (garbageMine.status !== 400) throw new Error(`mine garbage status ${garbageMine.status}`)
  console.log('PASS: POST /api/rooms/mine with garbage body -> zod 400')

  const garbageClaim = await fetch(`${BASE}/api/rooms/${created.roomId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (garbageClaim.status !== 400) throw new Error(`claim empty status ${garbageClaim.status}`)
  console.log('PASS: POST /api/rooms/:id/claim with empty body -> zod 400')

  const bodilessCreate = await fetch(`${BASE}/api/rooms`, { method: 'POST' })
  if (bodilessCreate.status !== 200) throw new Error(`bodiless create status ${bodilessCreate.status}`)
  console.log('PASS: POST /api/rooms with no body -> 200 (default name)')

  const leakCheck = JSON.stringify(mineRight)
  if (leakCheck.includes(created.hostKey)) throw new Error('host key leaked in /api/rooms/mine response')
  console.log('PASS: host key never echoed by /api/rooms/mine')

  // --- restart persistence via the real sync path ---
  const user = { id: randomUUID(), name: 'PersistBot', color: '#4cb05e' }
  const clientA = connectClient(user, created.roomId)
  await Promise.race([clientA.loaded, sleep(10_000).then(() => { throw new Error('client A did not load') })])
  await putShape(clientA.store)
  // give the sync layer time to flush to SQLite
  await sleep(500)
  clientA.client.close()

  console.log('--- restarting server ---')
  stopServer()
  await sleep(500)
  startServer()
  await waitForHealth()

  const clientB = connectClient(user, created.roomId)
  await Promise.race([clientB.loaded, sleep(10_000).then(() => { throw new Error('client B did not load') })])
  await assertShape(clientB.store, 'shape persisted across server restart (SQLiteSyncStorage)')
  clientB.client.close()

  console.log('ALL SPIKE-D CHECKS PASSED')
} catch (err) {
  failed = true
  console.error('FAIL:', err.message)
} finally {
  stopServer()
  rmSync(DATA_DIR, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}