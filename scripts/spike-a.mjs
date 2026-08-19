// Spike A — headless Editor over the synced store, driven by the vendored
// Agent Starter Kit action utils + prompt builders (tldraw 5.3.2).
//
// Hosts a room in-process (same TLSocketRoom + SQLiteSyncStorage harness as
// spike-b), mounts two headless Editors over two TLSyncClient stores, runs the
// vendored create/move/resize/rotate/align/update/delete/pen actions, checks
// geometry for geo/text/note/arrow/draw, and verifies client 2 sees the shapes
// and that the system prompt builds. GO/fallback decision for Phase 5.
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 16)
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id)
// @tldraw/utils' Timers references the bare `window` global (not globalThis);
// the headless editor needs it stubbed before constructing.
const _raf = globalThis.requestAnimationFrame
const _caf = globalThis.cancelAnimationFrame
globalThis.window ??= {
  requestAnimationFrame: _raf,
  cancelAnimationFrame: _caf,
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  get document() {
    return globalThis.document
  },
}
// tiptap's generateHTML (used for headless text measurement) serializes DOM via
// the global `document` — provide a bare stub that satisfies createElement +
// innerHTML so text/note/geo label measurement returns real bounds.
globalThis.document ??= {
  createElement: () => makeDomEl(),
  createElementNS: () => makeDomEl(),
  createDocumentFragment: () => makeDomEl(),
  createTextNode: (text) => ({ textContent: String(text), nodeType: 3 }),
  createRange: () => ({ setStart() {}, setEnd() {}, getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
  implementation: {
    createHTMLDocument: () => ({
      createElement: () => makeDomEl(),
      createElementNS: () => makeDomEl(),
    }),
  },
  documentElement: { ownerDocument: null },
  body: null,
  getElementById: () => null,
}
function makeDomEl() {
  const el = {
    _html: '',
    _children: [],
    style: {},
    tagName: 'div',
    nodeType: 1,
    children: [],
    childNodes: [],
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {},
    removeAttribute() {},
    appendChild(c) {
      this._children.push(c)
      this.children = this._children
      this.childNodes = this._children
      // accumulate serialized text so `container.innerHTML` keeps the text
      if (c && typeof c.textContent === 'string') this._html += c.textContent
      return c
    },
    removeChild() {},
    remove() {},
    getAttribute: () => null,
    querySelectorAll: () => [],
  }
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html },
    set(v) { this._html = v; this.textContent = v.replace(/<[^>]*>/g, '') },
  })
  Object.defineProperty(el, 'textContent', {
    get() { return this._html.replace(/<[^>]*>/g, '') },
    set(v) { this._html = v },
  })
  el.ownerDocument = { createElement: () => makeDomEl(), createElementNS: () => makeDomEl() }
  return el
}
import {
  NodeSqliteWrapper,
  SQLiteSyncStorage,
  TLSocketRoom,
  TLSyncClient,
} from '@tldraw/sync-core'
import { createTLStore } from '@tldraw/editor'
import { atom } from '@tldraw/state'
import { WebSocket, WebSocketServer } from 'ws'
import {
  Editor,
  defaultBindingUtils,
  defaultShapeUtils,
  defaultAddFontsFromNode,
  tipTapDefaultExtensions,
} from 'tldraw'
import { schema } from '../dist/shared/schema.js'
import {
  AgentHelpers,
  buildSystemPrompt,
  getAgentActionUtilsRecordForMode,
} from '../dist/ai/ai.js'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// --- server side (same harness as spike-b) ----------------------------------
const db = new Database(':memory:')
const sql = new NodeSqliteWrapper(db, { tablePrefix: 'room_spikea_' })
const storage = new SQLiteSyncStorage({ sql })
const room = new TLSocketRoom({ storage, schema, clientTimeout: 30_000 })

const wss = new WebSocketServer({ port: 0 })
wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/sync/spikea')) {
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
  const ws = new WebSocket(`ws://localhost:${port}/sync/spikea`)
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

// --- minimal DOM stub so TextManager and the editor can measure text --------
function makeEl() {
  const el = {
    _text: '',
    classList: {
      _set: new Set(),
      add(...cls) {
        for (const c of cls) this._set.add(c)
      },
      remove(...cls) {
        for (const c of cls) this._set.delete(c)
      },
      contains(c) {
        return this._set.has(c)
      },
    },
    style: {
      _styles: new Map(),
      setProperty(k, v) {
        this._styles.set(k, v)
      },
      removeProperty(k) {
        this._styles.delete(k)
      },
      getPropertyValue(k) {
        return this._styles.get(k) ?? ''
      },
      getPropertyNames() {
        return [...this._styles.keys()]
      },
    },
    childNodes: [],
    scrollWidth: 0,
    tabIndex: 0,
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    removeChild() {},
    remove() {},
  }
  Object.defineProperty(el, 'textContent', {
    get() {
      return el._text
    },
    set(v) {
      el._text = v
    },
  })
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return el._text
    },
    set(v) {
      el._text = v
    },
  })
  el.getBoundingClientRect = () => {
    // ponytail: fake measurement — width scales with content so text/note
    // shapes get non-zero bounds. Real measurement ships with the browser.
    const w = Math.max(20, el._text.length * 9)
    const h = 22
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h }
  }
  return el
}

function makeContainer() {
  const classList = {
    _set: new Set(),
    add(...cls) {
      for (const c of cls) this._set.add(c)
    },
    remove(...cls) {
      for (const c of cls) this._set.delete(c)
    },
    contains(c) {
      return this._set.has(c)
    },
  }
  const container = {
    classList,
    ownerDocument: {
      createElement: () => makeEl(),
      defaultView: null,
      activeElement: null,
      body: {
        addEventListener() {},
        removeEventListener() {},
      },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  }
  return container
}

function mountEditor(client) {
  const container = makeContainer()
  const editor = new Editor({
    store: client.store,
    shapeUtils: defaultShapeUtils,
    bindingUtils: defaultBindingUtils,
    tools: [],
    getContainer: () => container,
    textOptions: {
      addFontsFromNode: defaultAddFontsFromNode,
      tipTapConfig: { extensions: tipTapDefaultExtensions },
    },
  })
  return editor
}

// --- minimal agent stub (Phase 5 replaces with the real loop) ---------------
function makeAgent(editor) {
  return {
    editor,
    chatOrigin: { getOrigin: () => ({ x: 0, y: 0 }) },
    schedule: () => {},
    interrupt: () => {},
    requests: { getScheduledRequest: () => null },
    todos: {
      push: () => {},
      update: () => {},
      getTodos: () => [],
    },
  }
}

// --- run ---------------------------------------------------------------------
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'ok ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

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

  const editorA = mountEditor(a)
  const editorB = mountEditor(b)
  const agentA = makeAgent(editorA)
  const helpersA = new AgentHelpers(agentA)
  const utils = getAgentActionUtilsRecordForMode(agentA, 'idling')

  const actionTypes = Object.keys(utils)
  check('action registry populated', actionTypes.length > 10, `${actionTypes.length} utils: ${actionTypes.join(', ')}`)

  // 1. create: geo rectangle via the vendored CreateActionUtil
  const rectId = 'shape:spike-rect'
  const textId = 'shape:spike-text'
  const noteId = 'shape:spike-note'
  const arrowId = 'shape:spike-arrow'
  const drawId = 'shape:spike-draw'
  await utils.create.applyAction(
    {
      _type: 'create',
      complete: true,
      intent: 'spike rect',
      shape: { _type: 'rectangle', color: 'lightblue', fill: 'solid', shapeId: 'spike-rect', x: 100, y: 100, w: 200, h: 120, note: '', text: 'hello' },
    },
    helpersA
  )
  const rect = a.store.get(rectId)
  check('create action made a rectangle', !!rect && rect.props.w === 200 && rect.props.h === 120, JSON.stringify(rect && { x: rect.x, y: rect.y, w: rect.props.w, h: rect.props.h }))

  // 2. text shape
  await utils.create.applyAction(
    {
      _type: 'create',
      complete: true,
      intent: 'spike text',
      shape: { _type: 'text', color: 'black', shapeId: 'spike-text', x: 400, y: 100, text: 'hello world', note: '' },
    },
    helpersA
  )

  // 3. note shape
  await utils.create.applyAction(
    {
      _type: 'create',
      complete: true,
      intent: 'spike note',
      shape: { _type: 'note', color: 'lightyellow', shapeId: 'spike-note', x: 100, y: 350, text: 'a note', note: '' },
    },
    helpersA
  )

  // 4. arrow between rect and text
  await utils.create.applyAction(
    {
      _type: 'create',
      complete: true,
      intent: 'spike arrow',
      shape: { _type: 'arrow', color: 'black', shapeId: 'spike-arrow', fromId: 'spike-rect', toId: 'spike-text', x1: 300, y1: 160, x2: 400, y2: 130, note: '' },
    },
    helpersA
  )

  // 5. pen action makes a draw shape
  await utils.pen.applyAction(
    {
      _type: 'pen',
      complete: true,
      points: [
        { x: 600, y: 300 },
        { x: 620, y: 330 },
        { x: 650, y: 360 },
        { x: 680, y: 340 },
        { x: 700, y: 320 },
      ],
      style: 'rough',
      color: 'black',
      fill: 'none',
      closed: false,
      shapeId: 'spike-draw',
    },
    helpersA
  )

  // geometry for every core type the plan requires
  const geomNames = [
    ['geo', rectId],
    ['text', textId],
    ['note', noteId],
    ['arrow', arrowId],
    ['draw', drawId],
  ]
  for (const [kind, id] of geomNames) {
    const shape = a.store.get(id)
    const g = shape ? editorA.getShapeGeometry(id) : null
    const ok = !!g && g.bounds.w > 0 && g.bounds.h > 0
    check(`geometry ${kind}`, ok, g ? `w=${g.bounds.w.toFixed(1)} h=${g.bounds.h.toFixed(1)}` : 'no shape')
  }

  // 6. move (absolute target, simple id — MoveActionUtil prepends 'shape:')
  await utils.move.applyAction(
    { _type: 'move', complete: true, shapeId: 'spike-rect', x: 150, y: 160, anchor: 'top-left' },
    helpersA
  )
  check('move action', a.store.get(rectId).x === 150 && a.store.get(rectId).y === 160, `at ${a.store.get(rectId).x},${a.store.get(rectId).y}`)

  // 7. resize (scaleX/scaleY around an origin point)
  await utils.resize.applyAction(
    { _type: 'resize', complete: true, shapeIds: ['spike-rect'], scaleX: 2, scaleY: 2, originX: 150, originY: 160 },
    helpersA
  )
  check('resize action', a.store.get(rectId).props.w === 400 && a.store.get(rectId).props.h === 240, `w=${a.store.get(rectId).props.w} h=${a.store.get(rectId).props.h}`)

  // 8. rotate (degrees + origin point; rect now at 150,160 w400 h240 → center 350,280)
  await utils.rotate.applyAction(
    { _type: 'rotate', complete: true, shapeIds: ['spike-rect'], degrees: 90, originX: 350, originY: 280 },
    helpersA
  )
  check('rotate action', Math.abs(a.store.get(rectId).rotation - Math.PI / 2) < 0.01, `rotation=${a.store.get(rectId).rotation.toFixed(3)}`)

  // 9. align (rect + text to top)
  await utils.align.applyAction(
    { _type: 'align', complete: true, shapeIds: ['spike-rect', 'spike-text'], alignment: 'top', gap: 0, intent: 'align top' },
    helpersA
  )
  const rectPageY = editorA.getShapePageBounds(rectId).y
  const textPageY = editorA.getShapePageBounds(textId).y
  check('align action', Math.abs(rectPageY - textPageY) < 0.5, `rect.y=${rectPageY.toFixed(1)} text.y=${textPageY.toFixed(1)}`)

  // 10. update (change color + fill — full focused shape, simple id)
  await utils.update.applyAction(
    {
      _type: 'update',
      complete: true,
      update: {
        _type: 'rectangle',
        shapeId: 'spike-rect',
        x: 150,
        y: 160,
        w: 400,
        h: 240,
        color: 'green',
        fill: 'pattern',
        note: '',
      },
    },
    helpersA
  )
  const rectProps = a.store.get(rectId).props
  check('update action', rectProps.color === 'green' && rectProps.fill === 'pattern', `color=${rectProps.color} fill=${rectProps.fill}`)

  // 11. delete
  const rectBeforeDelete = !!a.store.get(rectId)
  await utils.delete.applyAction({ _type: 'delete', complete: true, shapeId: 'spike-rect' }, helpersA)
  check('delete action', rectBeforeDelete && !a.store.get(rectId))

  // 12. client 2 sees the sync (agent works over the synced store, both directions)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const seen = [textId, noteId, arrowId, drawId].every((id) => !!b.store.get(id))
    if (seen) break
    await sleep(25)
  }
  const seenCount = [textId, noteId, arrowId, drawId].filter((id) => !!b.store.get(id)).length
  check('client 2 sees synced shapes', seenCount === 4, `${seenCount}/4 present`)
  const bGeom = b.store.get(textId) && editorB.getShapeGeometry(textId)
  check('client 2 measures geometry headless', !!bGeom && bGeom.bounds.w > 0, bGeom ? `w=${bGeom.bounds.w.toFixed(1)}` : 'none')

  // 13. system prompt builds from the vendored prompt pipeline
  const prompt = buildSystemPrompt({
    mode: { type: 'mode', modeType: 'idling', actionTypes, partTypes: [] },
  })
  const promptOk = prompt.includes('JSON schema') && prompt.includes('"create"')
  check('system prompt builds', promptOk, `${prompt.length} chars, includes create schema: ${prompt.includes('"create"')}`)

  a.client.close()
  b.client.close()
} catch (err) {
  failed = true
  console.error('FAIL:', err.stack || err.message)
} finally {
  wss.close()
  room.close()
  const bad = results.filter((r) => !r.ok)
  if (bad.length === 0 && !failed) {
    console.log(`\nPASS: all ${results.length} spike-a checks passed`)
    process.exit(0)
  } else {
    console.error(`\nFAIL: ${bad.length + (failed ? 1 : 0)} check(s) failed (${results.length} total)`)
    process.exit(1)
  }
}