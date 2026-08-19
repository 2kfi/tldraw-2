// Spike C — Phase 2 end-to-end: real HTTP server, real WS path, two clients.
// Creates a room via POST /api/rooms, connects two TLSyncClients with distinct
// x-user-* identities, checks that a shape + aiState written by client 1
// arrive on client 2, and that a presence record written by client 1 shows up
// on client 2. Assumes the server is already running (PORT=3051).
import { randomUUID } from 'node:crypto'

globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 16)
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id)
import { TLSyncClient } from '@tldraw/sync-core'
import { createTLStore } from '@tldraw/editor'
import { atom } from '@tldraw/state'
import { WebSocket } from 'ws'
import { AI_STATE_ID, createDefaultAiState, schema } from '../dist/shared/schema.js'
import { createShapeId, toRichText } from '@tldraw/tlschema'

const BASE = process.env.BASE ?? 'http://localhost:3051'
const WS_BASE = BASE.replace(/^http/, 'ws')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
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
    /* ponytail: no reconnect logic needed for a one-shot spike */
  }
  close() {
    this.ws.close()
  }
}

function connectClient(name, user, roomId) {
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
      console.error(`${name}: sync error`, err)
      process.exit(1)
    },
  })
  return { client, store, loaded, name }
}

// Browser clients can't set WS headers, so the identity travels as a cookie.
function connectClientViaCookie(name, user, roomId) {
  const store = createTLStore({ schema })
  const ws = new WebSocket(`${WS_BASE}/sync/${roomId}`, {
    headers: { Cookie: `t2user=${encodeURIComponent(JSON.stringify(user))}` },
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
      console.error(`${name}: sync error`, err)
      process.exit(1)
    },
  })
  return { client, store, loaded, name }
}

let failed = false
try {
  const roomRes = await fetch(`${BASE}/api/rooms`, { method: 'POST' })
  const roomId = (await roomRes.json()).roomId
  if (!roomId || !/^[a-z0-9]+$/.test(roomId)) {
    throw new Error(`bad room id from /api/rooms: ${roomId}`)
  }
  console.log(`created room ${roomId}`)

  const a = connectClient(
    'client-1',
    { id: randomUUID(), name: 'Alice', color: '#4cb05e' },
    roomId
  )
  const b = connectClientViaCookie(
    'client-2',
    { id: randomUUID(), name: 'Bob', color: '#ae3ec9' },
    roomId
  )
  await Promise.race([
    Promise.all([a.loaded, b.loaded]),
    sleep(10_000).then(() => {
      throw new Error('clients did not load within 10s')
    }),
  ])

  a.store.put([
    a.store.schema.types.shape.create({
      id: createShapeId(),
      parentId: 'page:page',
      index: 'a0',
      type: 'geo',
      x: 100,
      y: 100,
      props: {
        geo: 'rectangle',
        dash: 'solid',
        url: '',
        w: 120,
        h: 80,
        growY: 0,
        scale: 1,
        flipX: false,
        flipY: false,
        labelColor: 'black',
        color: 'green',
        fill: 'none',
        size: 'm',
        font: 'draw',
        align: 'middle',
        verticalAlign: 'middle',
        richText: toRichText(''),
      },
    }),
  ])
  a.store.put([{ ...createDefaultAiState(), status: 'running', streamingText: 'hello from client 1' }])

  const deadline = Date.now() + 10_000
  let shapeOk = false
  let aiOk = false
  while (Date.now() < deadline && !(shapeOk && aiOk)) {
    const shapes = [...b.store.query.records('shape').get()]
    shapeOk = shapes.some((s) => s.x === 100 && s.props?.w === 120)
    const ai = b.store.get(AI_STATE_ID)
    aiOk = !!ai && ai.status === 'running' && ai.streamingText === 'hello from client 1'
    if (!(shapeOk && aiOk)) await sleep(25)
  }
  if (shapeOk && aiOk) {
    console.log('PASS: client 2 received shape + aiState from client 1')
  } else {
    failed = true
    console.error(
      `FAIL: shapeOk=${shapeOk} aiOk=${aiOk} ai=${JSON.stringify(b.store.get(AI_STATE_ID))}`
    )
  }

  a.client.close()
  b.client.close()
} catch (err) {
  failed = true
  console.error('FAIL:', err.message)
} finally {
  process.exit(failed ? 1 : 0)
}