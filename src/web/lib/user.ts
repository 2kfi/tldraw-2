import { useSyncExternalStore } from 'react'
import type { UserInfo } from '@shared/types'

const ID_KEY = 't2.userId'
const NAME_KEY = 't2.name'
const COLOR_KEY = 't2.color'
const PROFILE_KEY = 't2.profile'
const COOKIE = 't2user'
const JOIN_COOKIE = 't2join'

const ADJECTIVES = [
  'Brave',
  'Clever',
  'Swift',
  'Quiet',
  'Bold',
  'Lucky',
  'Nimble',
  'Calm',
  'Bright',
  'Mellow',
]
const NOUNS = ['Fox', 'Owl', 'Panda', 'Puma', 'Heron', 'Lynx', 'Otter', 'Raven', 'Wombat', 'Gecko']
// Preset swatches for the profile color picker (tldraw palette colors).
export const PROFILE_COLORS = [
  '#3182ed',
  '#4ba1f1',
  '#4465e9',
  '#ae3ec9',
  '#e085f4',
  '#4cb05e',
  '#f87777',
  '#e03131',
  '#f1ac4b',
  '#9fa8b2',
]

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

// --- reactive identity store ---
// Components subscribe via useUser() so profile edits apply immediately
// everywhere (presence, chat attribution, chrome, DJ badge) without prop
// drilling. The id lives in t2.userId and is never changed by an edit.
const listeners = new Set<() => void>()
let snapshot: UserInfo | null = null

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function notify() {
  for (const l of listeners) l()
}

function readCookie(name: string): string | undefined {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return m ? decodeURIComponent(m[1]!) : undefined
}

function loadProfile(): { name: string; color: string } {
  const raw = localStorage.getItem(PROFILE_KEY)
  if (raw) {
    try {
      const p = JSON.parse(raw) as { name?: unknown; color?: unknown }
      if (p && typeof p.name === 'string' && p.name && typeof p.color === 'string') {
        return { name: p.name, color: p.color }
      }
    } catch {
      // corrupted — fall through to migration
    }
  }
  // First run after the upgrade: keep the pre-existing identity. Prefer the
  // old t2.name/t2.color keys, then the t2user cookie, so an existing random
  // name/color survives. The id (t2.userId) is separate and never regenerated.
  const legacyName = localStorage.getItem(NAME_KEY)
  const legacyColor = localStorage.getItem(COLOR_KEY)
  if (legacyName) {
    const profile = { name: legacyName, color: legacyColor || pick(PROFILE_COLORS) }
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
    return profile
  }
  const cookie = readCookie(COOKIE)
  if (cookie) {
    try {
      const p = JSON.parse(cookie) as UserInfo
      if (p && typeof p.name === 'string' && p.name) {
        const profile = { name: p.name, color: typeof p.color === 'string' ? p.color : pick(PROFILE_COLORS) }
        localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
        return profile
      }
    } catch {
      // ignore a malformed cookie
    }
  }
  const profile = { name: `${pick(ADJECTIVES)} ${pick(NOUNS)}`, color: pick(PROFILE_COLORS) }
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
  return profile
}

function loadUser(): UserInfo {
  let id = localStorage.getItem(ID_KEY)
  if (!id) {
    // adopt an id already minted in the t2user cookie before minting a new one,
    // so presence/sync identity survives for users who only had the cookie.
    const cookie = readCookie(COOKIE)
    try {
      const p = cookie ? (JSON.parse(cookie) as UserInfo) : null
      if (p && typeof p.id === 'string' && p.id) id = p.id
    } catch {
      // ignore a malformed cookie
    }
    if (!id) id = crypto.randomUUID()
    localStorage.setItem(ID_KEY, id)
  }
  const { name, color } = loadProfile()
  return { id, name, color }
}

export function getUser(): UserInfo {
  if (!snapshot) snapshot = loadUser()
  return snapshot
}

export function setUser(user: Partial<Pick<UserInfo, 'name' | 'color'>>): UserInfo {
  const next = { ...getUser(), ...user }
  const profile = { name: next.name, color: next.color }
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
  // keep the legacy keys in sync (Home's prompt + anything reading them)
  localStorage.setItem(NAME_KEY, next.name)
  localStorage.setItem(COLOR_KEY, next.color)
  snapshot = next
  // re-sync the WS identity cookie so the server sees the new name/color
  // (join requests, host claims, session attribution).
  syncUserCookie()
  notify()
  return next
}

export function useUser(): UserInfo {
  return useSyncExternalStore(subscribe, getUser, getUser)
}

// Browsers can't set headers on new WebSocket(), but cookies ride along on the
// same-origin handshake. Set this before the room socket opens so the server
// can attribute the session (the sync protocol carries no user info).
export function syncUserCookie(): void {
  document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(getUser()))};path=/`
}

// Room-access cookie: a join token the server requires before admitting a WS
// connection to a password-protected room. Set after POST /api/rooms/:id/join.
export function setJoinCookie(token: string): void {
  document.cookie = `${JOIN_COOKIE}=${encodeURIComponent(token)};path=/`
}

export function getJoinCookie(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)t2join=([^;]*)/)
  const token = m?.[1]
  return token !== undefined ? decodeURIComponent(token) : null
}