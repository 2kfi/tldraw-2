import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import type { UnknownRecord } from '@tldraw/store'
import type { WebSocketMinimal } from '@tldraw/sync-core'
import { schema } from '../shared/schema'
import type { Database } from 'better-sqlite3'
import type { UserInfo } from '../shared/types'
import { createSessionId } from '../shared/ids'
import { log } from './log'

export type SessionMeta = { user: UserInfo }

const ROOM_CLIENT_TIMEOUT = 30_000

type RoomRecord = {
  room: TLSocketRoom<UnknownRecord, SessionMeta>
  connCount: number
  timer: NodeJS.Timeout | null
}

export class RoomManager {
  private readonly rooms = new Map<string, RoomRecord>()

  constructor(
    private readonly db: Database,
    private readonly hooks: {
      /** Spawn the AI session when a room first materializes. */
      onRoomCreated?: (roomId: string, room: TLSocketRoom<UnknownRecord, SessionMeta>) => void
      /** Tear the AI session down when the room is dropped from memory. */
      onRoomDestroyed?: (roomId: string) => void
    } = {}
  ) {}

  getRoom(roomId: string): TLSocketRoom<UnknownRecord, SessionMeta> {
    let record = this.rooms.get(roomId)
    if (record) {
      if (record.timer) {
        clearTimeout(record.timer)
        record.timer = null
      }
      return record.room
    }

    const sql = new NodeSqliteWrapper(this.db, {
      tablePrefix: `room_${roomId}_`,
    })
    const storage = new SQLiteSyncStorage({ sql })
    const room = new TLSocketRoom<UnknownRecord, SessionMeta>({
      storage,
      schema,
      clientTimeout: ROOM_CLIENT_TIMEOUT,
    })

    this.rooms.set(roomId, { room, connCount: 0, timer: null })
    this.hooks.onRoomCreated?.(roomId, room)
    return room
  }

  handleConnect(roomId: string, socket: WebSocketMinimal, user: UserInfo) {
    const room = this.getRoom(roomId)
    const record = this.rooms.get(roomId)!
    record.connCount += 1

    room.handleSocketConnect({
      sessionId: createSessionId(),
      socket,
      isReadonly: false,
      meta: { user },
    })
  }

  handleDisconnect(roomId: string) {
    const record = this.rooms.get(roomId)
    if (!record) return
    record.connCount -= 1
    if (record.connCount <= 0 && !record.timer) {
      // ponytail: rooms are persisted per change; drop the in-memory room once
      // empty so it re-materializes on the next connection (avoids unbounded map)
      record.timer = setTimeout(() => {
        const rec = this.rooms.get(roomId)
        if (rec && rec.connCount <= 0) {
          rec.room.close()
          this.rooms.delete(roomId)
          this.hooks.onRoomDestroyed?.(roomId)
        }
      }, 60_000)
    }
  }

  /** In-memory room without materializing it (music op authz reads). Never
   * creates a room or AI session — returns undefined when not live. */
  peekRoom(roomId: string): TLSocketRoom<UnknownRecord, SessionMeta> | undefined {
    return this.rooms.get(roomId)?.room
  }

  /** Drop one room from memory (DELETE /api/rooms/:id). The sync tables are
   * already gone from SQLite; this just stops the live room + AI session. */
  deleteRoom(roomId: string) {
    const record = this.rooms.get(roomId)
    if (!record) return
    if (record.timer) clearTimeout(record.timer)
    try {
      record.room.close()
    } catch (err) {
      log.warn(`room ${roomId}: error closing sync room`, err)
    }
    this.rooms.delete(roomId)
    this.hooks.onRoomDestroyed?.(roomId)
  }

  /** Number of live in-memory rooms (for /ready). */
  get size(): number {
    return this.rooms.size
  }

  /** Graceful shutdown: close every live room so nothing accepts writes after
   * the DB checkpoints. Rooms persist per change, so close() is the flush. */
  closeAll() {
    for (const roomId of [...this.rooms.keys()]) this.deleteRoom(roomId)
  }
}