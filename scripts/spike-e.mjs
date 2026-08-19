// Spike E — Phase 4: asset upload + streaming (Range, cache, guards).
// Requires `npm run build` first. Self-hosts the real server on PORT=3053 with
// a fresh temp DATA_DIR. Exercises POST /api/assets (multipart) and
// GET /media/asset/:file exactly like the client TLAssetStore does — the only
// browser-only part is `File`, which is a Blob subclass, so the FormData path
// is identical. `assetStore.upload` wraps this fetch; `resolve` returns
// `asset.props.src` (verified by typecheck, no runtime needed).
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PORT = 3053
const BASE = `http://localhost:${PORT}`
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'tldraw2-spike-e-'))

// 1x1 transparent PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

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
      // not up yet
    }
    await sleep(100)
  }
  throw new Error('server did not become healthy')
}

function check(name, cond) {
  if (!cond) throw new Error(`FAIL: ${name}`)
  console.log(`PASS: ${name}`)
}

async function uploadAs(fileName, blob, label) {
  const form = new FormData()
  form.append('file', blob, fileName)
  return fetch(`${BASE}/api/assets`, { method: 'POST', body: form })
}

let failed = false
try {
  startServer()
  await waitForHealth()

  // --- upload → { src } ---
  const up = await uploadAs('dot.png', new Blob([PNG], { type: 'image/png' }), 'dot.png')
  check('upload returns 200', up.status === 200)
  const body = await up.json()
  const src = body?.src
  check('upload returns { src: /media/asset/... }', typeof src === 'string' && src.startsWith('/media/asset/'))
  const filePart = src.split('/').pop()
  check('src ends with .png', filePart.endsWith('.png'))

  // --- plain GET ---
  const g = await fetch(`${BASE}${src}`)
  check('GET asset -> 200', g.status === 200)
  check('GET asset -> image/png', g.headers.get('content-type') === 'image/png')
  check('GET asset -> cache immutable', g.headers.get('cache-control') === 'public, max-age=31536000, immutable')
  const bytes = Buffer.from(await g.arrayBuffer())
  check('GET asset -> identical bytes', bytes.equals(PNG))
  check('GET asset -> Accept-Ranges present', g.headers.get('accept-ranges') === 'bytes')

  // --- Range request → 206 ---
  const r = await fetch(`${BASE}${src}`, { headers: { Range: 'bytes=0-9' } })
  check('Range request -> 206', r.status === 206)
  const cr = r.headers.get('content-range')
  check('Range -> content-range bytes 0-9', cr === `bytes 0-9/${PNG.length}`)
  const part = Buffer.from(await r.arrayBuffer())
  check('Range -> 10 bytes', part.length === 10 && part.equals(PNG.subarray(0, 10)))

  // --- guards ---
  const notFound = await fetch(`${BASE}/media/asset/${randomUUID()}.png`)
  check('unknown id -> 404', notFound.status === 404)

  const evil = await fetch(`${BASE}/media/asset/..%2f..%2fetc/passwd`)
  // Express 5's router normalizes `..` segments before routing, so this 404s at
  // the static fallback without ever reaching the handler — no file is served.
  // The handler's own `..` guard (400) is belt-and-suspenders for other encodings.
  check('traversal -> 400/404, never 200', evil.status === 400 || evil.status === 404)

  const big = await uploadAs('big.bin', new Blob([new Uint8Array(51 * 1024 * 1024)], { type: 'image/png' }), 'big.bin')
  check('oversize (51 MB) -> 413', big.status === 413)

  const txt = await uploadAs('evil.txt', new Blob([new TextEncoder().encode('hi')], { type: 'text/plain' }), 'evil.txt')
  check('text/plain -> 400', txt.status === 400)

  const noFile = await fetch(`${BASE}/api/assets`, { method: 'POST' })
  check('no file field -> 400', noFile.status === 400)

  // --- persisted row + file on disk ---
  const id = filePart.slice(0, -4)
  const dbPath = path.join(DATA_DIR, 'tldraw.db')
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })
  const row = db.prepare('SELECT id, mime, size FROM assets WHERE id = ?').get(id)
  db.close()
  check('assets row persisted', row && row.mime === 'image/png' && row.size === PNG.length)

  console.log('ALL SPIKE-E CHECKS PASSED')
} catch (err) {
  failed = true
  console.error('FAIL:', err.message)
} finally {
  stopServer()
  rmSync(DATA_DIR, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
