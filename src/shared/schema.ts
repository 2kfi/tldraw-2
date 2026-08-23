import { createRecordType } from '@tldraw/store'
import { commentSchemaRecords, createTLSchema, idValidator } from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

export const AI_STATE_ID = 'aiState:global' as const
export const MUSIC_STATE_ID = 'musicState:global' as const

export const aiStateValidator = T.object({
  id: idValidator('aiState'),
  typeName: T.literal('aiState'),
  lockedBy: T.string.nullable(),
  lockedByName: T.string.nullable(),
  status: T.literalEnum('idle', 'pending', 'running', 'error'),
  streamingText: T.string,
  conversation: T.arrayOf(
    T.object({
      role: T.literalEnum('user', 'assistant'),
      content: T.string,
      // Author display info so remote users' messages show who wrote them.
      name: T.string.optional(),
      color: T.string.optional(),
    })
  ),
  error: T.string.nullable(),
  prompt: T.string.nullable(),
  promptModel: T.string.nullable(),
  promptSelection: T.arrayOf(T.string).nullable(),
  promptViewport: T.object({
    x: T.number,
    y: T.number,
    w: T.number,
    h: T.number,
  }).nullable(),
})

export const musicStateValidator = T.object({
  id: idValidator('musicState'),
  typeName: T.literal('musicState'),
  currentTrackId: T.string.nullable(),
  playing: T.boolean,
  startedAt: T.number.nullable(),
  positionMs: T.number,
  queue: T.arrayOf(T.string),
  allowedMemberIds: T.arrayOf(T.string),
  updatedBy: T.string,
})

export const aiStateType = createRecordType('aiState', {
  scope: 'document',
  validator: aiStateValidator,
})

export const musicStateType = createRecordType('musicState', {
  scope: 'document',
  validator: musicStateValidator,
})

export type AiState = {
  id: typeof AI_STATE_ID
  typeName: 'aiState'
  lockedBy: string | null
  lockedByName: string | null
  status: 'idle' | 'pending' | 'running' | 'error'
  streamingText: string
  conversation: Array<{ role: 'user' | 'assistant'; content: string; name?: string; color?: string }>
  error: string | null
  prompt: string | null
  promptModel: string | null
  promptSelection: string[] | null
  promptViewport: { x: number; y: number; w: number; h: number } | null
}

export type MusicState = {
  id: typeof MUSIC_STATE_ID
  typeName: 'musicState'
  currentTrackId: string | null
  playing: boolean
  startedAt: number | null
  positionMs: number
  queue: string[]
  allowedMemberIds: string[]
  updatedBy: string
}

export function createDefaultAiState(): AiState {
  return {
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
  }
}

export function createDefaultMusicState(updatedBy: string): MusicState {
  return {
    id: MUSIC_STATE_ID,
    typeName: 'musicState',
    currentTrackId: null,
    playing: false,
    startedAt: null,
    positionMs: 0,
    queue: [],
    allowedMemberIds: [],
    updatedBy,
  }
}

// ponytail: plan says `shapes: {}, bindings: {}` — omitting them keeps tldraw's
// default shape/binding/asset schemas (the editor and headless agent need them);
// custom records are what matters here. commentSchemaRecords must be registered on
// BOTH the client and the sync server (shared schema) or comment records fail
// validation on one side of the connection.
export const schema = createTLSchema({
  records: {
    aiState: aiStateType,
    musicState: musicStateType,
    ...commentSchemaRecords,
  },
})