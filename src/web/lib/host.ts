const KEYS_KEY = 't2.hostKeys'
const TOKENS_KEY = 't2.hostTokens'

function readMap(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(key: string, map: Record<string, string>) {
  localStorage.setItem(key, JSON.stringify(map))
}

export function getHostKey(roomId: string): string | null {
  return readMap(KEYS_KEY)[roomId] ?? null
}

export function setHostKey(roomId: string, hostKey: string): void {
  const map = readMap(KEYS_KEY)
  map[roomId] = hostKey
  writeMap(KEYS_KEY, map)
}

export function getHostToken(roomId: string): string | null {
  return readMap(TOKENS_KEY)[roomId] ?? null
}

export function setHostToken(roomId: string, token: string): void {
  const map = readMap(TOKENS_KEY)
  map[roomId] = token
  writeMap(TOKENS_KEY, map)
}

export function allHostKeys(): Record<string, string> {
  return readMap(KEYS_KEY)
}