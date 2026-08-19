// Spike H — Phase 7 comments + follow + presence. Runs the REAL server
// (dist/server) on a scratch port and connects two TLSyncClients. Asserts:
// (1) instance_presence round-trips (userName/color visible to the peer),
// (2) a comment thread + comment written by client A syncs to client B
// (comment/comment-thread records registered via the shared schema),
// (3) follow: A sets presence.followingUserId → B observes it; A clears it
// (unfollow) → B observes null.
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { TLSyncClient } from '@tldraw/sync-core'
import { createTLStore } from '@tldraw/editor'
import { atom } from '@tldraw/state'
import { createComment, createCommentId, createCommentThread, createCommentThreadId } from '@tldraw/tlschema'
import { schema } from '../dist/shared/schema.js'

const APP_PORT = 3057
const TMP = '/tmp/opencode/spikeh'
const PAGE_ID = 'page:page'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 16)
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id)

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
    MUSIC_DIR: `${TMP}/music`,
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

function connectClient(roomId, userId, userName, color) {
  const store = createTLStore({ schema })
  const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/sync/${roomId}`, {
    headers: { 'x-user-id': userId, 'x-user-name': userName, 'x-user-color': color },
  })
  const socket = new NodeSocket(ws)
  const presence = atom(`${userId}-presence`, null)
  let loadedResolve
  const loaded = new Promise((r) => (loadedResolve = r))
  const client = new TLSyncClient({
    store,
    socket,
    presence,
    presenceMode: atom('presence-mode', 'full'),
    onLoad: () => loadedResolve(),
    onSyncError: (err) => {
      console.error('client sync error', err)
      process.exit(1)
    },
  })
  return { client, store, loaded, presence }
}

function presenceRecord(userId, userName, color, followingUserId = null) {
  return {
    id: `instance_presence:${userId}`,
    typeName: 'instance_presence',
    userId: `user:${userId}`,
    userName,
    color,
    lastActivityTimestamp: Date.now(),
    followingUserId,
    cursor: null,
    camera: null,
    screenBounds: null,
    selectedShapeIds: [],
    currentPageId: PAGE_ID,
    brush: null,
    scribbles: [],
    chatMessage: '',
    meta: {},
  }
}

function waitFor(fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      let val
      try {
        val = fn()
      } catch {
        val = undefined
      }
      if (val) return resolve(val)
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for condition'))
      setTimeout(poll, 30)
    }
    poll()
  })
}

try {
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

  // Phantom-room gate: rooms must exist via POST /api/rooms before /sync/:id
  // accepts a connection (unknown ids are rejected).
  const created = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/rooms`, { method: 'POST' })).json()
  const roomId = created.roomId
  check('created a room for the presence checks', typeof roomId === 'string' && roomId.length > 0)

  const a = connectClient(roomId, 'spike-a', 'Alpha Fox', '#3182ed')
  const b = connectClient(roomId, 'spike-b', 'Beta Owl', '#4cb05e')
  await Promise.all([
    Promise.race([a.loaded, sleep(10_000).then(() => Promise.reject(new Error('client a did not load')))]) 
  ])
  await Promise.race([b.loaded, sleep(10_000).then(() => Promise.reject(new Error('client b did not load')))])
  check('two clients load', true)

  // --- (1) presence round-trip ---
  a.presence.set(presenceRecord('spike-a', 'Alpha Fox', '#3182ed'))
  b.presence.set(presenceRecord('spike-b', 'Beta Owl', '#4cb05e'))

  const aPresenceAtB = await waitFor(() =>
    (b.store.query.records('instance_presence').get() ?? []).find((p) => p.userId === 'user:spike-a')
  )
  check(
    'presence round-trips (A visible at B with name/color)',
    aPresenceAtB.userName === 'Alpha Fox' && aPresenceAtB.color === '#3182ed',
    JSON.stringify({ userId: aPresenceAtB.userId, userName: aPresenceAtB.userName })
  )

  // --- (2) comments sync ---
  const thread = createCommentThread({
    anchor: { type: 'point', x: 120, y: 80 },
    createdBy: 'user:spike-a',
    pageId: PAGE_ID,
    now: Date.now(),
    meta: {},
  })
  const comment = createComment({
    authorId: 'user:spike-a',
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello from spike-a' }] }] },
    meta: {},
    now: Date.now(),
    pageId: PAGE_ID,
    threadId: thread.id,
  })
  a.store.put([thread, comment])

  const threadAtB = await waitFor(() => b.store.get(thread.id))
  const commentAtB = await waitFor(() => b.store.get(comment.id))
  const bodyText = JSON.stringify(commentAtB.body).includes('hello from spike-a')
  check(
    'comment thread syncs to B',
    threadAtB.typeName === 'comment-thread' && threadAtB.createdBy === 'user:spike-a',
    threadAtB.id
  )
  check(
    'comment syncs to B (author + body)',
    commentAtB.typeName === 'comment' && commentAtB.authorId === 'user:spike-a' && bodyText,
    commentAtB.id
  )
  check('comment record ids use comment:/comment-thread: prefixes', /^comment-thread:/.test(thread.id) && /^comment:/.test(comment.id))

  // --- (3) follow / unfollow via presence.followingUserId ---
  a.presence.set(presenceRecord('spike-a', 'Alpha Fox', '#3182ed', 'user:spike-b'))
  const followAtB = await waitFor(() =>
    (b.store.query.records('instance_presence').get() ?? []).find((p) => p.userId === 'user:spike-a' && p.followingUserId === 'user:spike-b')
  )
  check('follow: B observes A following them', followAtB.followingUserId === 'user:spike-b', `followingUserId=${followAtB.followingUserId}`)

  a.presence.set(presenceRecord('spike-a', 'Alpha Fox', '#3182ed', null))
  const unfollowAtB = await waitFor(() =>
    (b.store.query.records('instance_presence').get() ?? []).find((p) => p.userId === 'user:spike-a' && p.followingUserId === null)
  )
  check('unfollow: B observes A stopped following', unfollowAtB.followingUserId === null)

  a.client.close()
  b.client.close()
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