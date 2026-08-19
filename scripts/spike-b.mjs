// Spike B — TLSocketRoom + SQLiteSyncStorage with the shared schema.
// Hosts a room in-process, runs two server-side TLSyncClients, and checks
// that a custom aiState record written by client 1 arrives on client 2.
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 16)
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id)
import {
  NodeSqliteWrapper,
  SQLiteSyncStorage,
  TLSocketRoom,
  TLSyncClient,
} from '@tldraw/sync-core'
import { createTLStore } from '@tldraw/editor'
import { atom } from '@tldraw/state'
import { WebSocket, WebSocketServer } from 'ws'
import { AI_STATE_ID, createDefaultAiState, schema } from '../dist/shared/schema.js'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// --- server side -------------------------------------------------------------
const db = new Database(':memory:')
const sql = new NodeSqliteWrapper(db, { tablePrefix: 'room_spike_' })
const storage = new SQLiteSyncStorage({ sql })
const room = new TLSocketRoom({ storage, schema, clientTimeout: 30_000 })

const wss = new WebSocketServer({ port: 0 })
wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/sync/spike')) {
    socket.close(1008, 'bad room id')
    return
  }
  room.handleSocketConnect({
    sessionId: randomUUID(),
    socket,
    isReadonly: false,
    meta: { user: { id: randomUUID(), name: 'spike', color: '#3182ed' } },
  })
})
const port = wss.address().port

// --- client side -------------------------------------------------------------
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

function connectClient(name) {
  const store = createTLStore({ schema })
  const ws = new WebSocket(`ws://localhost:${port}/sync/spike`)
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

// --- run ---------------------------------------------------------------------
let failed = false
try {
  const a = connectClient('client-1')
  const b = connectClient('client-2')
  await Promise.race([
    Promise.all([a.loaded, b.loaded]),
    sleep(10_000).then(() => {
      throw new Error('clients did not load within 10s')
    }),
  ])

  const rec = createDefaultAiState()
  a.store.put([{ ...rec, status: 'running', streamingText: 'hello from client 1' }])

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const got = b.store.get(AI_STATE_ID)
    if (got && got.status === 'running' && got.streamingText === 'hello from client 1') break
    await sleep(25)
  }
  const got = b.store.get(AI_STATE_ID)
  const ok = !!got && got.status === 'running' && got.streamingText === 'hello from client 1'
  if (ok) {
    console.log(`PASS: client 2 received aiState from client 1 (${JSON.stringify(got)})`)
  } else {
    failed = true
    console.error(`FAIL: client 2 never saw client 1's aiState (got=${JSON.stringify(got)})`)
  }

  a.client.close()
  b.client.close()
} catch (err) {
  failed = true
  console.error('FAIL:', err.message)
} finally {
  wss.close()
  room.close()
  process.exit(failed ? 1 : 0)
}