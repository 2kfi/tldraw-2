import { customAlphabet } from 'nanoid'

const ROOM_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function createRoomId(): string {
  return customAlphabet(ROOM_ALPHABET, 10)()
}

export function createSessionId(): string {
  return crypto.randomUUID()
}