import { existsSync } from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import type { Database } from 'better-sqlite3'
import { DATA_DIR } from './db'
import { MUSIC_DIR, scanMusicDir } from './music/scanner'
import type { ScannedTrack } from './music/scanner'
import { requireHostToken } from './rooms'

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

export function createMusicRouter(db: Database) {
  const router = Router()
  const listAll = () =>
    (db.prepare('SELECT id, rel_path, title, artist, album, duration, art_path FROM music_tracks ORDER BY title COLLATE NOCASE').all() as ScannedTrack[]).map(toInfo)

  // plan §6: GET /api/music → { tracks, scannedAt }; the phase-6 task also lists
  // /api/music/tracks, so both hit the same handler.
  const listHandler = (_req: unknown, res: { json: (v: unknown) => void }) => {
    res.json({ tracks: listAll(), scannedAt: Date.now() })
  }
  router.get('/api/music', listHandler)
  router.get('/api/music/tracks', listHandler)

  router.post('/api/music/refresh', async (req, res) => {
    const token = req.headers['x-host-token'] as string | undefined
    const roomId = token?.split('.')[0]
    // the host token embeds its room id, so any valid token authorizes a rescan
    if (!roomId || !requireHostToken(roomId, token)) {
      res.status(401).json({ error: 'host token required' })
      return
    }
    try {
      const { tracks, added, removed } = await scanMusicDir(db)
      res.json({ tracks: tracks.map(toInfo), added, removed, scannedAt: Date.now() })
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

  return router
}
