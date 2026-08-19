import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import type { Database } from 'better-sqlite3'
import { DATA_DIR } from '../db'

// Docker compose binds ./music → /data/music; local dev defaults to ./data/music.
export const MUSIC_DIR = process.env.MUSIC_DIR ?? path.join(DATA_DIR, 'music')
const ART_DIR = path.join(DATA_DIR, 'cache', 'art')
const EXTS = new Set(['.mp3', '.m4a', '.flac', '.ogg', '.opus', '.wav', '.aac'])
const COVER_NAMES = ['cover.jpg', 'folder.jpg', 'cover.png']

export type ScannedTrack = {
  id: string
  rel_path: string
  title: string
  artist: string
  album: string
  duration: number
  art_path: string | null
}

function walk(dir: string, base: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    const rel = path.join(base, entry.name)
    if (entry.isDirectory()) walk(abs, rel, out)
    else if (EXTS.has(path.extname(entry.name).toLowerCase())) out.push(rel)
  }
  return out
}

function resolveArt(trackId: string, absFile: string, picture: { data: Uint8Array; format?: string } | undefined): string | null {
  if (picture?.data?.length) {
    mkdirSync(ART_DIR, { recursive: true })
    const isJpg = (picture.format ?? '').toLowerCase().includes('jpg')
    const artFile = path.join(ART_DIR, `${trackId}.${isJpg ? 'jpg' : 'png'}`)
    writeFileSync(artFile, picture.data)
    return artFile
  }
  for (const name of COVER_NAMES) {
    const cover = path.join(path.dirname(absFile), name)
    if (existsSync(cover)) return cover
  }
  return null
}

export async function scanMusicDir(db: Database): Promise<{ tracks: ScannedTrack[]; added: number; removed: number }> {
  mkdirSync(MUSIC_DIR, { recursive: true })
  const files = existsSync(MUSIC_DIR) ? walk(MUSIC_DIR, '', []) : []
  const existing = new Map(
    (db.prepare('SELECT id, rel_path, mtime FROM music_tracks').all() as { id: string; rel_path: string; mtime: number }[]).map((r) => [
      r.rel_path,
      r,
    ])
  )
  const upsert = db.prepare(
    `INSERT INTO music_tracks (id, rel_path, title, artist, album, duration, art_path, mtime)
     VALUES (@id, @rel_path, @title, @artist, @album, @duration, @art_path, @mtime)
     ON CONFLICT(rel_path) DO UPDATE SET
       title = excluded.title, artist = excluded.artist, album = excluded.album,
       duration = excluded.duration, art_path = excluded.art_path, mtime = excluded.mtime`
  )
  const find = db.prepare('SELECT id, rel_path, title, artist, album, duration, art_path FROM music_tracks WHERE rel_path = ?')

  const seen = new Set<string>()
  let added = 0
  const tracks: ScannedTrack[] = []
  for (const rel of files) {
    seen.add(rel)
    let mtime: number
    try {
      mtime = statSync(path.join(MUSIC_DIR, rel)).mtimeMs
    } catch {
      continue
    }
    const old = existing.get(rel)
    // Unchanged file → keep the row as-is. The id is preserved so track ids in a
    // synced musicState.queue stay valid across rescans.
    if (old && old.mtime === mtime) {
      tracks.push(find.get(rel) as ScannedTrack)
      continue
    }
    const id = old?.id ?? randomUUID()
    let meta: { common?: { title?: string; artist?: string; album?: string; picture?: { data: Uint8Array; format?: string }[] }; format?: { duration?: number } } = {}
    try {
      meta = (await parseFile(path.join(MUSIC_DIR, rel), { duration: true })) as typeof meta
    } catch {
      // untagged/unsupported file still gets listed with its filename as title
    }
    const c = meta.common ?? {}
    const duration = typeof meta.format?.duration === 'number' && isFinite(meta.format.duration) ? meta.format.duration : 0
    const track: ScannedTrack = {
      id,
      rel_path: rel,
      title: (c.title ?? path.basename(rel, path.extname(rel))).toString(),
      artist: (c.artist ?? '').toString(),
      album: (c.album ?? '').toString(),
      duration,
      art_path: resolveArt(id, path.join(MUSIC_DIR, rel), c.picture?.[0]),
    }
    upsert.run({ ...track, mtime })
    tracks.push(track)
    added++
  }

  let removed = 0
  for (const rel of existing.keys()) {
    if (!seen.has(rel)) {
      db.prepare('DELETE FROM music_tracks WHERE rel_path = ?').run(rel)
      removed++
    }
  }
  return { tracks, added, removed }
}
