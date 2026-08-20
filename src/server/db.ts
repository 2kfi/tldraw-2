import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')

export function getDb(): Database.Database {
  mkdirSync(DATA_DIR, { recursive: true })
  const db = new Database(path.join(DATA_DIR, 'tldraw.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host_user_id TEXT,
      host_key_hash TEXT,
      password_hash TEXT,
      require_approval INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS join_requests (
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_color TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      room_id TEXT,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS music_tracks (
      id TEXT PRIMARY KEY,
      rel_path TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL DEFAULT '',
      album TEXT NOT NULL DEFAULT '',
      duration REAL NOT NULL DEFAULT 0,
      art_path TEXT,
      mtime REAL NOT NULL
    );
  `)
  // Migration for DBs created before the access-control columns existed:
  // CREATE TABLE IF NOT EXISTS never re-runs, so detect and ALTER instead.
  const roomCols = db.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]
  if (!roomCols.some((c) => c.name === 'password_hash')) {
    db.exec('ALTER TABLE rooms ADD COLUMN password_hash TEXT')
  }
  if (!roomCols.some((c) => c.name === 'require_approval')) {
    db.exec('ALTER TABLE rooms ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0')
  }
  return db
}