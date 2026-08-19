// Spike F — Phase 5 shared AI, end-to-end. Runs the REAL server (dist/server)
// with the in-process session, pointing OPENAI_BASE_URL at a tiny fake
// OpenAI Responses-API endpoint. A human client (TLSyncClient over ws) submits
// a prompt and observes: pending → running → idle, streamed text, an assistant
// reply, an actual shape created by the agent, and the model list endpoint.
//
// Real providers need no changes here; drop the env keys in and it uses them.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { WebSocket } from 'ws'
import { TLSyncClient } from '@tldraw/sync-core'
import { createTLStore } from '@tldraw/editor'
import { atom } from '@tldraw/state'
import { schema } from '../dist/shared/schema.js'

const AI_STATE_ID = 'aiState:global'
const APP_PORT = 3054

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// Node lacks rAF; tldraw's Store.listen throttles through it.
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 16)
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id)

// ---------------------------------------------------------------------------
// Fake OpenAI Responses API — streams a fixed JSON actions payload in deltas.
// Chunk types are limited to the ones @ai-sdk/openai accepts in its stream
// schema (response.created / output_item.added / output_text.delta / completed).
// ---------------------------------------------------------------------------
const FAKE_PAYLOAD = JSON.stringify({
  actions: [
    {
      _type: 'create',
      intent: 'Create a note',
      shape: {
        _type: 'note',
        color: 'black',
        note: 'Created by the AI',
        shapeId: 'spikef-note',
        text: 'Made by AI',
        x: 100,
        y: 100,
      },
    },
    { _type: 'message', text: 'I made a note for you. **It works.**' },
  ],
})

function startFakeOpenai() {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url.includes('/responses')) {
        res.writeHead(404).end()
        return
      }
      req.resume()
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const events = [
        { type: 'response.created', response: { id: 'fake_resp_1', created_at: Math.floor(Date.now() / 1000), model: 'gpt-5.4-mini' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', phase: 'final_answer' } },
      ]
      const chunk = 14
      for (let i = 0; i < FAKE_PAYLOAD.length; i += chunk) {
        events.push({ type: 'response.output_text.delta', item_id: 'msg_1', delta: FAKE_PAYLOAD.slice(i, i + chunk) })
      }
      events.push({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } })
      // slow stream so the observer can catch the 'running' window
      let i = 0
      const writeNext = () => {
        if (i >= events.length) {
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.write(`data: ${JSON.stringify(events[i++])}\n\n`)
        setTimeout(writeNext, 30)
      }
      writeNext()
    })
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port))
  })
}

// ---------------------------------------------------------------------------
// Human client over a real ws connection
// ---------------------------------------------------------------------------
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

function connectClient(roomId) {
  const store = createTLStore({ schema })
  const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/sync/${roomId}`, {
    headers: { 'x-user-id': 'spike-human', 'x-user-name': 'Spike Human' },
  })
  const socket = new NodeSocket(ws)
  let loadedResolve
  const loaded = new Promise((r) => (loadedResolve = r))
  const client = new TLSyncClient({
    store,
    socket,
    presence: atom('spike-presence', null),
    presenceMode: atom('full'),
    onLoad: () => loadedResolve(),
    onSyncError: (err) => {
      console.error('client sync error', err)
      process.exit(1)
    },
  })
  return { client, store, loaded }
}

async function waitForState(store, pred, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const cur = store.get(AI_STATE_ID)
    if (cur && pred(cur)) return cur
    await sleep(100)
  }
  return null
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'ok ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const fakePort = await startFakeOpenai()
console.log(`fake OpenAI Responses API on :${fakePort}`)

rmSync('/tmp/opencode/spikef-data', { recursive: true, force: true })
const app = spawn('node', ['dist/server/index.js'], {
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    DATA_DIR: '/tmp/opencode/spikef-data',
    OPENAI_API_KEY: 'fake',
    OPENAI_BASE_URL: `http://127.0.0.1:${fakePort}/v1`,
    OPENAI_DEFAULT_MODEL: 'gpt-5.4-mini',
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

  // Phantom-room gate: rooms must exist via POST /api/rooms before /sync/:id
  // accepts a connection (unknown ids are rejected).
  const created = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/rooms`, { method: 'POST' })).json()
  const roomId = created.roomId
  check('created a room for the AI loop', typeof roomId === 'string' && roomId.length > 0)

  // model list
  const modelsRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/ai/models`)
  const { models } = await modelsRes.json()
  check('GET /api/ai/models returns object list', Array.isArray(models) && models.some((m) => m.id === 'gpt-5.4-mini'), JSON.stringify(models))

  // connect + submit
  const human = connectClient(roomId)
  await Promise.race([human.loaded, sleep(10_000).then(() => Promise.reject(new Error('client did not load')))])
  const store = human.store

  let ai = store.get(AI_STATE_ID)
  if (!ai) {
    store.put([
      {
        id: AI_STATE_ID,
        typeName: 'aiState',
        lockedBy: null,
        lockedByName: null,
        status: 'idle',
        streamingText: '',
        conversation: [],
        error: null,
        prompt: null,
        promptModel: null,
        promptSelection: null,
        promptViewport: null,
      },
    ])
    ai = store.get(AI_STATE_ID)
  }

  // submit a prompt
  store.put([
    {
      ...ai,
      lockedBy: 'spike-human',
      lockedByName: 'Spike Human',
      status: 'pending',
      streamingText: '',
      error: null,
      conversation: [...(ai.conversation ?? []), { role: 'user', content: 'Please add a note for me.' }],
      prompt: 'Please add a note for me.',
      promptModel: 'gpt-5.4-mini',
      promptSelection: [],
      promptViewport: { x: -100, y: -100, w: 1000, h: 800 },
    },
  ])

  // observe transitions
  const statuses = []
  let streamedAny = false
  let final = null
  let notes = []
  for (let i = 0; i < 200; i++) {
    await sleep(100)
    const cur = store.get(AI_STATE_ID)
    if (!cur) continue
    if (!statuses.includes(cur.status)) statuses.push(cur.status)
    if (cur.streamingText && !cur.streamingText.startsWith('…')) streamedAny = true
    notes = store.allRecords().filter((r) => r.typeName === 'shape' && r.type === 'note')
    if (cur.status === 'idle' && (statuses.includes('running') || (statuses.includes('pending') && cur.conversation.length >= 1))) {
      final = cur
      break
    }
  }

  check('status went pending → running → idle', JSON.stringify(statuses) === '["pending","running","idle"]', statuses.join(' → '))
  check('streamingText was observed mid-run', streamedAny)
  const last = final?.conversation?.slice(-1)[0]
  check('assistant reply appended', last?.role === 'assistant' && last.content.includes('It works'), JSON.stringify(last))
  check('user prompt kept in conversation', final?.conversation?.some((m) => m.role === 'user' && m.content.includes('add a note')))
  check('lock released on completion', final?.lockedBy === null && final?.lockedByName === null)
  check('prompt fields cleared after run', final?.prompt === null && final?.promptModel === null)
  check('agent created a note shape', notes.length > 0, `found ${notes.length} note(s)`)
  check('no error state', final?.error === null, final?.error ?? '')

  // second prompt round-trips too
  const beforeCount = final.conversation.length
  store.put([
    {
      ...store.get(AI_STATE_ID),
      lockedBy: 'spike-human',
      lockedByName: 'Spike Human',
      status: 'pending',
      conversation: [...final.conversation, { role: 'user', content: 'Again please.' }],
      prompt: 'Again please.',
      promptModel: 'gpt-5.4-mini',
      promptSelection: null,
      promptViewport: null,
    },
  ])
  let secondDone = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    const cur = store.get(AI_STATE_ID)
    if (cur?.status === 'idle' && cur.conversation.length > beforeCount) {
      secondDone = cur
      break
    }
  }
  check('second prompt runs and appends again', !!secondDone && secondDone.conversation.length > beforeCount)

  // ---------------------------------------------------------------------------
  // §9 edge cases (Phase 9 hardening)
  // ---------------------------------------------------------------------------
  const submitPrompt = (target, prompt, opts = {}) => {
    const cur = target.store.get(AI_STATE_ID)
    target.store.put([
      {
        ...cur,
        lockedBy: opts.user ?? 'spike-human',
        lockedByName: opts.name ?? 'Spike Human',
        status: 'pending',
        error: null,
        conversation: [...(cur?.conversation ?? []), { role: 'user', content: prompt }],
        prompt,
        promptModel: 'gpt-5.4-mini',
        promptSelection: opts.selection ?? null,
        promptViewport: opts.viewport ?? { x: 0, y: 0, w: 400, h: 300 },
      },
    ])
  }

  // EC-1: unknown/invalid selection ids must not crash — the AI replies anyway
  const afterSecond = store.get(AI_STATE_ID).conversation.length
  submitPrompt(human, 'EC-1 unknown selection', { selection: ['not-a-real-shape-1', 'nope'] })
  const ec1 = await waitForState(store, (cur) => cur.status === 'idle' && cur.conversation.length > afterSecond)
  check('EC-1 invalid selection ids complete gracefully', !!ec1 && ec1.error === null && ec1.lockedBy === null, ec1 ? JSON.stringify(ec1.conversation?.slice(-1)[0]) : 'never-idle')

  // EC-2: a second client's concurrent prompt is single-flight — both get answered
  const human2 = connectClient(roomId, 'spike-human-2')
  await Promise.race([human2.loaded, sleep(10_000).then(() => Promise.reject(new Error('client 2 did not load')))])
  const beforeConcurrent = store.get(AI_STATE_ID).conversation.length
  submitPrompt(human, 'Concurrent #1')
  await waitForState(store, (cur) => cur.status === 'running' && cur.prompt === 'Concurrent #1', 10_000)
  submitPrompt(human2, 'Concurrent #2', { user: 'spike-human-2', name: 'Spike Human 2' })
  const both = await waitForState(
    store,
    (cur) => {
      const texts = cur.conversation.map((m) => m.content)
      return (
        cur.status === 'idle' &&
        cur.lockedBy === null &&
        texts.includes('Concurrent #1') &&
        texts.includes('Concurrent #2') &&
        cur.conversation.length >= beforeConcurrent + 4
      )
    },
    20_000
  )
  check('EC-2 concurrent prompts serialize (both answered, lock released)', !!both, JSON.stringify(both?.conversation?.slice(-4)))

  // EC-3: the asker disconnects mid-run — the AI finishes anyway
  submitPrompt(human, 'EC-3 disconnect mid-run')
  await waitForState(store, (cur) => cur.status === 'running', 10_000)
  const connBefore = store.get(AI_STATE_ID).conversation.length
  human.client.close()
  const human3 = connectClient(roomId, 'spike-human-3')
  await Promise.race([human3.loaded, sleep(10_000).then(() => Promise.reject(new Error('client 3 did not load')))])
  const ec3 = await waitForState(human3.store, (cur) => cur.status === 'idle' && cur.conversation.length > connBefore, 20_000)
  check('EC-3 AI finishes after asker disconnects', !!ec3 && ec3.error === null, ec3 ? JSON.stringify(ec3.conversation?.slice(-1)[0]) : 'never-idle')

  // EC-4: a stale 'running' left by a crashed run is reset by the watchdog
  const cur4 = human3.store.get(AI_STATE_ID)
  human3.store.put([{ ...cur4, status: 'running', lockedBy: 'ghost-user', lockedByName: 'Ghost', streamingText: 'zombie' }])
  const ec4 = await waitForState(human3.store, (c) => c.status === 'idle' && c.lockedBy === null, 10_000)
  check('EC-4 stale running lock reset by watchdog', !!ec4 && ec4.error === null && ec4.streamingText === '')
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