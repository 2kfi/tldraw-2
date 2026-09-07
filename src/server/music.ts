import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import type { Database } from 'better-sqlite3'
import type { UnknownRecord } from '@tldraw/store'
import type { TLSocketRoom } from '@tldraw/sync-core'
import { z } from 'zod'
import { DATA_DIR } from './config'
import { MUSIC_DIR, lastScanAt, scanMusicDir } from './music/scanner'
import type { ScannedTrack } from './music/scanner'
import { requireHostToken, requireJoinToken } from './rooms'
import type { UserParser } from './rooms'
import type { SessionMeta } from './sync'
import { MUSIC_STATE_ID, createDefaultMusicState } from '../shared/schema'
import type { MusicState } from '../shared/schema'

const UUID_RE = /^[0-9a-f-]{36}$/
const ART_DIR = path.join(DATA_DIR, 'cache', 'art')

// plan §6: mp3 / m4a / ogg / opus / wav / flac
const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  aac: 'audio/aac',
}

function toInfo(t: ScannedTrack) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    artUrl: t.art_path ? `/media/art/${t.id}` : null,
  }
}

export function createMusicRouter(
  db: Database,
  deps: {
    userFromReq: UserParser
    /** Live sync room without materializing (undefined when nobody is in it). */
    peekRoom: (roomId: string) => TLSocketRoom<UnknownRecord, SessionMeta> | undefined
  }
) {
  const router = Router()
  const { userFromReq, peekRoom } = deps
  const roomExists = (roomId: string) => !!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId)
  const listAll = () =>
    (db.prepare('SELECT id, rel_path, title, artist, album, duration, art_path FROM music_tracks ORDER BY title COLLATE NOCASE').all() as ScannedTrack[]).map(toInfo)

  // plan §6: GET /api/music → { tracks, scannedAt }; the phase-6 task also lists
  // /api/music/tracks, so both hit the same handler. scannedAt is the last
  // completed scan time, not the request time (falls back to now pre-first-scan).
  const listHandler = (_req: unknown, res: { json: (v: unknown) => void }) => {
    res.json({ tracks: listAll(), scannedAt: lastScanAt() ?? Date.now() })
  }
  router.get('/api/music', listHandler)
  router.get('/api/music/tracks', listHandler)

  router.post('/api/music/refresh', async (req, res) => {
    const token = req.headers['x-host-token'] as string | undefined
    const roomId = token?.split('.')[0]
    // the host token embeds its room id; the token must be valid for that
    // room AND the room must still exist (a deleted room's token authorizes
    // nothing). An explicit ?room= scope must match the token's room.
    const hostUserId = roomId ? requireHostToken(roomId, token) : null
    const scope = req.query.room
    if (!roomId || !hostUserId || !roomExists(roomId) || (typeof scope === 'string' && scope !== roomId)) {
      res.status(401).json({ error: 'host token required' })
      return
    }
    try {
      const { tracks, added, removed } = await scanMusicDir(db)
      res.json({ tracks: tracks.map(toInfo), added, removed, scannedAt: lastScanAt() ?? Date.now() })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'scan failed' })
    }
  })

  router.get('/media/track/:id', (req, res) => {
    const { id } = req.params
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid track id' })
      return
    }
    const row = db.prepare('SELECT rel_path FROM music_tracks WHERE id = ?').get(id) as { rel_path: string } | undefined
    if (!row) {
      res.status(404).json({ error: 'track not found' })
      return
    }
    const abs = path.resolve(MUSIC_DIR, row.rel_path)
    if (!abs.startsWith(path.resolve(MUSIC_DIR) + path.sep)) {
      res.status(400).json({ error: 'invalid path' })
      return
    }
    if (!existsSync(abs)) {
      res.status(404).json({ error: 'file missing' })
      return
    }
    const ext = path.extname(abs).slice(1).toLowerCase()
    // ponytail: scanner.ts keeps the same track id when a file changes on disk
    // (mtime differs → re-parse, old id reused), so bytes can mutate under one
    // id — immutable long-cache would serve stale audio. sendFile's defaults
    // give ETag + Last-Modified + public,max-age=0: browsers keep the copy and
    // revalidate with cheap 304s instead of re-downloading.
    res.sendFile(abs, {
      acceptRanges: true,
      headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' },
    })
  })

  router.get('/media/art/:id', (req, res) => {
    const { id } = req.params
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'invalid track id' })
      return
    }
    const row = db.prepare('SELECT art_path FROM music_tracks WHERE id = ?').get(id) as { art_path: string } | undefined
    if (!row?.art_path || !existsSync(row.art_path)) {
      res.status(404).json({ error: 'art not found' })
      return
    }
    const abs = path.resolve(row.art_path)
    const inside = abs.startsWith(path.resolve(ART_DIR)) || abs.startsWith(path.resolve(MUSIC_DIR) + path.sep)
    if (!inside) {
      res.status(400).json({ error: 'invalid path' })
      return
    }
    res.sendFile(abs, { headers: { 'Cache-Control': 'public, max-age=86400' } })
  })

  // --- uploads + guest proposals (Phase 4) ---

  // plan §6 containers: mp3 / m4a / ogg / opus / wav / flac (+ aac, same family).
  const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.flac', '.ogg', '.opus', '.wav', '.aac'])
  const MAX_AUDIO_BYTES = 50 * 1024 * 1024
  const STAGING_DIR = path.join(DATA_DIR, 'music_staging')

  // ponytail: same trust model as assets.ts — the client mimetype is advisory
  // (audio/* or octet-stream for curl), the extension allowlist is the real
  // guard: the scanner only ever picks up listed extensions.
  function audioFileFilter(_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback) {
    if (!AUDIO_EXTS.has(path.extname(file.originalname).toLowerCase())) {
      cb(new Error('unsupported audio type (mp3/m4a/flac/ogg/opus/wav/aac)'))
      return
    }
    if (file.mimetype !== 'application/octet-stream' && !file.mimetype.startsWith('audio/')) {
      cb(new Error('unsupported audio type (mp3/m4a/flac/ogg/opus/wav/aac)'))
      return
    }
    cb(null, true)
  }

  // Library uploads keep a sanitized original name so the folder bind stays
  // human-readable; staging uploads use uuids (the original name lives in DB).
  function safeBase(orig: string): { base: string; ext: string } {
    const ext = path.extname(orig).toLowerCase()
    const base = path.basename(orig, ext).replace(/[^a-zA-Z0-9._\- ]+/g, '_').slice(0, 80) || 'track'
    return { base, ext }
  }

  function uniqueName(dir: string, base: string, ext: string): string {
    let candidate = `${base}${ext}`
    for (let n = 1; existsSync(path.join(dir, candidate)); n++) candidate = `${base}-${n}${ext}`
    return candidate
  }

  const libraryUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        mkdirSync(MUSIC_DIR, { recursive: true })
        cb(null, MUSIC_DIR)
      },
      filename: (_req, file, cb) => {
        const { base, ext } = safeBase(file.originalname)
        cb(null, uniqueName(MUSIC_DIR, base, ext))
      },
    }),
    limits: { fileSize: MAX_AUDIO_BYTES },
    fileFilter: audioFileFilter,
  })

  const stagingUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        mkdirSync(STAGING_DIR, { recursive: true })
        cb(null, STAGING_DIR)
      },
      filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: MAX_AUDIO_BYTES },
    fileFilter: audioFileFilter,
  })

  function runSingle(upload: multer.Multer, req: any, res: any): Promise<Express.Multer.File | undefined> {
    return new Promise((resolve, reject) => {
      upload.single('file')(req, res, (err: unknown) => (err ? reject(err) : resolve(req.file)))
    })
  }

  function uploadError(err: unknown, res: { status: (n: number) => { json: (v: unknown) => void } }) {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'file too large (max 50 MB)' })
      return
    }
    res.status(400).json({ error: err instanceof Error ? err.message : 'upload failed' })
  }

  /** Host auth for library-mutating endpoints: token must be valid for ?room= (or
   * its embedded room), and that room must still exist. Returns the room id. */
  function requireRoomHost(req: {
    headers: Record<string, string | string[] | undefined>
    query: Record<string, unknown>
  }): string | null {
    const token = req.headers['x-host-token'] as string | undefined
    const roomId = token?.split('.')[0]
    if (!roomId || !requireHostToken(roomId, token)) return null
    const scope = req.query.room
    if (typeof scope === 'string' && scope !== roomId) return null
    if (!roomExists(roomId)) return null
    return roomId
  }

  function readCookie(cookieHeader: string | string[] | undefined, name: string): string | undefined {
    if (typeof cookieHeader !== 'string') return undefined
    for (const part of cookieHeader.split(';')) {
      const [key, ...rest] = part.trim().split('=')
      if (key === name) return decodeURIComponent(rest.join('='))
    }
    return undefined
  }

  // POST /api/music/upload?room=… (host only): audio file → MUSIC_DIR + rescan.
  // Folder-bind keeps working — this is just a second way files get there.
  router.post('/api/music/upload', async (req, res) => {
    if (!requireRoomHost(req as any)) {
      res.status(401).json({ error: 'host token required' })
      return
    }
    let file: Express.Multer.File | undefined
    try {
      file = await runSingle(libraryUpload, req, res)
    } catch (err) {
      uploadError(err, res)
      return
    }
    if (!file) {
      res.status(400).json({ error: 'missing file' })
      return
    }
    try {
      const { tracks } = await scanMusicDir(db)
      const rel = path.relative(MUSIC_DIR, file.path).split(path.sep).join('/')
      const track = tracks.map(toInfo).find((t, i) => tracks[i]!.rel_path === rel)
      if (!track) {
        res.status(500).json({ error: 'uploaded but not indexed' })
        return
      }
      res.json({ track })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'scan failed' })
    }
  })

  type ProposalRow = {
    id: string
    file: string
    orig_name: string
    submitted_by: string
    submitted_by_name: string
    status: string
    created_at: number
  }

  const toProposal = (r: ProposalRow) => ({
    id: r.id,
    origName: r.orig_name,
    submittedByName: r.submitted_by_name,
    createdAt: r.created_at,
    status: r.status,
  })

  // POST /api/music/propose (any joined user): audio file → staging + pending row.
  router.post('/api/music/propose', async (req, res) => {
    let file: Express.Multer.File | undefined
    try {
      file = await runSingle(stagingUpload, req, res)
    } catch (err) {
      uploadError(err, res)
      return
    }
    if (!file) {
      res.status(400).json({ error: 'missing file' })
      return
    }
    const user = userFromReq(req as any)
    const id = randomUUID()
    db.prepare(
      'INSERT INTO music_proposals (id, file, orig_name, submitted_by, submitted_by_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, path.basename(file.path), file.originalname.slice(0, 120), user.id, user.name.slice(0, 80), 'pending', Date.now())
    res.json({ proposal: toProposal(db.prepare('SELECT * FROM music_proposals WHERE id = ?').get(id) as ProposalRow) })
  })

  // GET /api/music/proposals?room=… (host only): pending guest suggestions.
  router.get('/api/music/proposals', (req, res) => {
    if (!requireRoomHost(req as any)) {
      res.status(401).json({ error: 'host token required' })
      return
    }
    const rows = db
      .prepare('SELECT * FROM music_proposals WHERE status = ? ORDER BY created_at ASC')
      .all('pending') as ProposalRow[]
    res.json({ proposals: rows.map(toProposal) })
  })

  // POST /api/music/proposals/:id/approve?room=… (host only): staging → library + rescan.
  router.post('/api/music/proposals/:id/approve', async (req, res) => {
    if (!requireRoomHost(req as any)) {
      res.status(401).json({ error: 'host token required' })
      return
    }
    const row = db.prepare('SELECT * FROM music_proposals WHERE id = ? AND status = ?').get(req.params.id, 'pending') as
      | ProposalRow
      | undefined
    if (!row) {
      res.status(404).json({ error: 'proposal not found' })
      return
    }
    const staged = path.resolve(STAGING_DIR, path.basename(row.file))
    if (!staged.startsWith(path.resolve(STAGING_DIR) + path.sep) || !existsSync(staged)) {
      db.prepare('UPDATE music_proposals SET status = ? WHERE id = ?').run('rejected', row.id)
      res.status(404).json({ error: 'staged file missing — proposal rejected' })
      return
    }
    const { base, ext } = safeBase(row.orig_name)
    const target = path.join(MUSIC_DIR, uniqueName(MUSIC_DIR, base, AUDIO_EXTS.has(ext) ? ext : '.mp3'))
    try {
      mkdirSync(MUSIC_DIR, { recursive: true })
      // copy + unlink instead of rename: MUSIC_DIR is often a separate bind.
      copyFileSync(staged, target)
      unlinkSync(staged)
      db.prepare('UPDATE music_proposals SET status = ? WHERE id = ?').run('approved', row.id)
      const { tracks } = await scanMusicDir(db)
      const rel = path.relative(MUSIC_DIR, target).split(path.sep).join('/')
      const track = tracks.map(toInfo).find((t, i) => tracks[i]!.rel_path === rel)
      res.json({ track: track ?? null })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'approve failed' })
    }
  })

  // POST /api/music/proposals/:id/reject?room=… (host only): drop the staged file.
  router.post('/api/music/proposals/:id/reject', (req, res) => {
    if (!requireRoomHost(req as any)) {
      res.status(401).json({ error: 'host token required' })
      return
    }
    const row = db.prepare('SELECT * FROM music_proposals WHERE id = ? AND status = ?').get(req.params.id, 'pending') as
      | ProposalRow
      | undefined
    if (!row) {
      res.status(404).json({ error: 'proposal not found' })
      return
    }
    try {
      const staged = path.resolve(STAGING_DIR, path.basename(row.file))
      if (staged.startsWith(path.resolve(STAGING_DIR) + path.sep)) unlinkSync(staged)
    } catch {
      // best-effort: the row state is what matters
    }
    db.prepare('UPDATE music_proposals SET status = ? WHERE id = ?').run('rejected', row.id)
    res.json({ ok: true })
  })

  // --- server-authoritative playback ops (Phase 4) ---

  const opBody = z.object({
    roomId: z.string().min(1).max(64),
    op: z.enum(['play', 'toggle', 'seek', 'step', 'dj']),
    trackId: z.string().uuid().optional(),
    positionMs: z.number().finite().min(0).optional(),
    delta: z.number().int().min(-100).max(100).optional(),
    userId: z.string().min(1).max(200).optional(),
    grant: z.boolean().optional(),
  })

  function readRecord(room: TLSocketRoom<UnknownRecord, SessionMeta>): MusicState | undefined {
    const found = room.getCurrentSnapshot().documents.find((d) => (d.state as { id?: string }).id === MUSIC_STATE_ID)
    return found ? (found.state as unknown as MusicState) : undefined
  }

  // Queue stays persisted in the record; the library (title order) only fills
  // gaps: stale ids drop out, new uploads append in library order.
  function effectiveQueue(queue: string[], libIds: string[]): string[] {
    const lib = new Set(libIds)
    const kept = queue.filter((id) => lib.has(id))
    const inQueue = new Set(kept)
    for (const id of libIds) if (!inQueue.has(id)) kept.push(id)
    return kept
  }

  function posOf(cur: MusicState, now: number): number {
    return cur.playing && cur.startedAt ? cur.positionMs + (now - cur.startedAt) : cur.positionMs
  }

  // PUT /api/music/state: the only writer clients use. Host token or a DJ id in
  // the record's allowedMemberIds (join-cookie-bound when present, else the
  // self-asserted cookie — same trust as presence). Server stamps startedAt on
  // its own clock (drift §4) and applies via updateStore, so the TLSync record
  // is a read replica for every client.
  router.put('/api/music/state', async (req, res) => {
    const parsed = opBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid op' })
      return
    }
    const { roomId, op } = parsed.data
    if (!roomExists(roomId)) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    const token = req.headers['x-host-token'] as string | undefined
    const hostUserId = requireHostToken(roomId, token)
    // Prefer the HMAC-bound join identity over the self-asserted cookie.
    const callerId =
      hostUserId ?? requireJoinToken(roomId, readCookie(req.headers.cookie, 't2join')) ?? userFromReq(req as any).id
    const room = peekRoom(roomId)
    // Fail closed when nobody is in the room: without the live record the DJ
    // list can't be verified (and there is nobody to hear the change anyway).
    if (!room && !hostUserId) {
      res.status(403).json({ error: 'host or DJ only' })
      return
    }
    if (!room) {
      res.status(409).json({ error: 'room not live — join the room first' })
      return
    }
    const cur = readRecord(room) ?? createDefaultMusicState(hostUserId ?? 'server')
    const isDJ = cur.allowedMemberIds.includes(callerId)
    if (!hostUserId && !isDJ) {
      res.status(403).json({ error: 'host or DJ only' })
      return
    }
    if (op === 'dj' && !hostUserId) {
      res.status(403).json({ error: 'host only' })
      return
    }
    const now = Date.now()
    const libIds = (
      db.prepare('SELECT id FROM music_tracks ORDER BY title COLLATE NOCASE').all() as { id: string }[]
    ).map((r) => r.id)
    let next: MusicState | null = null
    if (op === 'play') {
      const { trackId } = parsed.data
      if (!trackId || !libIds.includes(trackId)) {
        res.status(404).json({ error: 'track not found' })
        return
      }
      const queue = effectiveQueue(cur.queue, libIds)
      if (!queue.includes(trackId)) queue.push(trackId)
      next = { ...cur, currentTrackId: trackId, queue, playing: true, startedAt: now, positionMs: 0, updatedBy: callerId }
    } else if (op === 'toggle') {
      next = cur.playing
        ? { ...cur, playing: false, startedAt: null, positionMs: posOf(cur, now), updatedBy: callerId }
        : !cur.currentTrackId
          ? null
          : { ...cur, playing: true, startedAt: now, updatedBy: callerId }
      if (!next) {
        res.status(400).json({ error: 'nothing to play' })
        return
      }
    } else if (op === 'seek') {
      const { positionMs } = parsed.data
      if (positionMs === undefined) {
        res.status(400).json({ error: 'positionMs required' })
        return
      }
      next = { ...cur, positionMs, startedAt: cur.playing ? now : null, updatedBy: callerId }
    } else if (op === 'step') {
      const delta = parsed.data.delta ?? 1
      const queue = effectiveQueue(cur.queue, libIds)
      const idx = cur.currentTrackId ? queue.indexOf(cur.currentTrackId) : -1
      if (queue.length === 0 || idx < 0) {
        res.status(400).json({ error: 'nothing to step to' })
        return
      }
      const trackId = queue[(idx + delta + queue.length) % queue.length]!
      if (!queue.includes(trackId)) queue.push(trackId)
      next = { ...cur, currentTrackId: trackId, queue, playing: true, startedAt: now, positionMs: 0, updatedBy: callerId }
    } else {
      // dj: host-only grant/revoke (grant omitted → toggle)
      const { userId: target } = parsed.data
      if (!target) {
        res.status(400).json({ error: 'userId required' })
        return
      }
      const set = new Set(cur.allowedMemberIds)
      const grant = parsed.data.grant ?? !set.has(target)
      if (grant) set.add(target)
      else set.delete(target)
      next = { ...cur, allowedMemberIds: [...set], updatedBy: callerId }
    }
    try {
      const state = next
      await room.updateStore((store) => {
        store.put(state as any)
      })
      res.json({ state })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'op failed' })
    }
  })

  return router
}
