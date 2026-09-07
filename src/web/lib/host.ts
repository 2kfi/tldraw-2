import { useEffect, useState } from 'react'

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
  notifyHostChanged(roomId)
}

export function getHostToken(roomId: string): string | null {
  return readMap(TOKENS_KEY)[roomId] ?? null
}

export function setHostToken(roomId: string, token: string): void {
  const map = readMap(TOKENS_KEY)
  map[roomId] = token
  writeMap(TOKENS_KEY, map)
  notifyHostChanged(roomId)
}

export function allHostKeys(): Record<string, string> {
  return readMap(KEYS_KEY)
}

function notifyHostChanged(roomId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('t2:host-changed', { detail: { roomId } }))
}

/** Reactive host check: re-reads localStorage on claim (same tab via
 *  t2:host-changed, other tabs via storage event). */
export function useIsHost(roomId: string): boolean {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    function bump(e: Event) {
      const detail = (e as CustomEvent).detail as { roomId?: string } | undefined
      if (detail && detail.roomId && detail.roomId !== roomId) return
      setVersion((v) => v + 1)
    }
    function onStorage(e: StorageEvent) {
      if (e.key === KEYS_KEY || e.key === TOKENS_KEY) setVersion((v) => v + 1)
    }
    window.addEventListener('t2:host-changed', bump)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('t2:host-changed', bump)
      window.removeEventListener('storage', onStorage)
    }
  }, [roomId])
  // version is read to subscribe; getHostKey does the real check per render.
  void version
  return getHostKey(roomId) !== null
}