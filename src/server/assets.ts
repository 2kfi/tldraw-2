import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import type { Database } from 'better-sqlite3'
import { DATA_DIR } from './db'

const MAX_BYTES = 50 * 1024 * 1024
const ALLOWED = /^(image|video|audio)\//
const ASSET_DIR = path.join(DATA_DIR, 'assets')

// ponytail: trust the client's mimetype (no magic-byte sniffing — `file-type`
// isn't a dependency). The size limit is the real guard; a fake mimetype just
// gets an odd extension. See README.
const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
}

function extFor(mime: string): string {
  if (EXT[mime]) return EXT[mime]!
  const sub = mime.split('/')[1]?.replace(/[^a-z0-9.]/gi, '')
  return sub || 'bin'
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdirSync(ASSET_DIR, { recursive: true })
      cb(null, ASSET_DIR)
    },
    filename: (_req, file, cb) => cb(null, `${randomUUID()}.${extFor(file.mimetype)}`),
  }),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    // SVG is a stored-XSS vector (scripts run on top-level navigation to the
    // served file in the app origin) — refuse it outright.
    if (file.mimetype === 'image/svg+xml') cb(new Error('SVG is not allowed'))
    else if (ALLOWED.test(file.mimetype)) cb(null, true)
    else cb(new Error('unsupported type (image/video/audio only)'))
  },
})

const UUID_RE = /^[0-9a-f-]{36}$/

export function createAssetsRouter(db: Database) {
  const router = Router()

  router.post('/api/assets', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'file too large (max 50 MB)' })
          return
        }
        res.status(400).json({ error: err instanceof Error ? err.message : 'upload failed' })
        return
      }
      if (!req.file) {
        res.status(400).json({ error: 'missing file' })
        return
      }
      const id = path.basename(req.file.filename, path.extname(req.file.filename))
      db.prepare('INSERT INTO assets (id, room_id, mime, size, path, created_at) VALUES (?, NULL, ?, ?, ?, ?)').run(
        id,
        req.file.mimetype,
        req.file.size,
        path.join('assets', req.file.filename),
        Date.now()
      )
      res.json({ src: `/media/asset/${req.file.filename}` })
    })
  })

  router.get('/media/asset/:file', (req, res) => {
    const { file } = req.params
    const id = path.basename(file, path.extname(file))
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid asset id' })
      return
    }
    const row = db.prepare('SELECT path FROM assets WHERE id = ?').get(id) as { path: string } | undefined
    if (!row) {
      res.status(404).json({ error: 'asset not found' })
      return
    }
    const abs = path.resolve(DATA_DIR, row.path)
    if (!abs.startsWith(path.resolve(DATA_DIR))) {
      res.status(400).json({ error: 'invalid path' })
      return
    }
    // sendFile serves Range requests natively (206) and sets Content-Type from the extension.
    res.sendFile(abs, {
      acceptRanges: true,
      headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
    })
  })

  return router
}
