import { createRecordType } from '@tldraw/store'
import { commentSchemaRecords, createTLSchema, idValidator } from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

export const AI_STATE_ID = 'aiState:global' as const
export const MUSIC_STATE_ID = 'musicState:global' as const
// ponytail: queue cap + screenshot gate live here so client and server agree.
export const MAX_AI_QUEUE_LENGTH = 10
export const MAX_SCREENSHOT_CHARS = 400_000

export type AiQueuedPrompt = {
	id: string
	prompt: string
	promptModel: string | null
	promptSelection: string[] | null
	promptViewport: { x: number; y: number; w: number; h: number } | null
	includeScreenshot?: boolean
	screenshot?: string
	by?: string
	byName?: string
	byColor?: string
	queuedAt?: number
}

const aiQueuedPromptValidator = T.object({
	id: T.string,
	prompt: T.string,
	promptModel: T.string.nullable(),
	promptSelection: T.arrayOf(T.string).nullable(),
	promptViewport: T.object({
		x: T.number,
		y: T.number,
		w: T.number,
		h: T.number,
	}).nullable(),
	includeScreenshot: T.boolean.nullable().optional(),
	screenshot: T.string.nullable().optional(),
	by: T.string.optional(),
	byName: T.string.optional(),
	byColor: T.string.optional(),
	queuedAt: T.number.optional(),
})

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
  // Optional screenshot for the running prompt (data URL, size-gated client-side).
  promptIncludeScreenshot: T.boolean.nullable().optional(),
  promptScreenshot: T.string.nullable().optional(),
  // Append-only queue: sequential submits from one client all survive (cap 10).
  // Optional so rooms persisted before Phase 3 still validate.
  queue: T.arrayOf(aiQueuedPromptValidator).optional(),
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
  promptIncludeScreenshot?: boolean | null
  promptScreenshot?: string | null
  queue?: AiQueuedPrompt[]
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
    promptIncludeScreenshot: false,
    promptScreenshot: null,
    queue: [],
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