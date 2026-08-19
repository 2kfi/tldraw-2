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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
  return db
}