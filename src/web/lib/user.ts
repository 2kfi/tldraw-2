import type { UserInfo } from '@shared/types'

const ID_KEY = 't2.userId'
const NAME_KEY = 't2.name'
const COLOR_KEY = 't2.color'
const COOKIE = 't2user'

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
const COLORS = ['#3182ed', '#4ba1f1', '#4465e9', '#ae3ec9', '#e085f4', '#4cb05e', '#f87777', '#e03131']

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

export function getUser(): UserInfo {
  let id = localStorage.getItem(ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(ID_KEY, id)
  }
  let name = localStorage.getItem(NAME_KEY)
  if (!name) {
    name = `${pick(ADJECTIVES)} ${pick(NOUNS)}`
    localStorage.setItem(NAME_KEY, name)
  }
  let color = localStorage.getItem(COLOR_KEY)
  if (!color) {
    color = pick(COLORS)
    localStorage.setItem(COLOR_KEY, color)
  }
  return { id, name, color }
}

export function setUser(user: Partial<Pick<UserInfo, 'name' | 'color'>>): UserInfo {
  if (user.name !== undefined) localStorage.setItem(NAME_KEY, user.name)
  if (user.color !== undefined) localStorage.setItem(COLOR_KEY, user.color)
  return getUser()
}

// Browsers can't set headers on new WebSocket(), but cookies ride along on the
// same-origin handshake. Set this before the room socket opens so the server
// can attribute the session (the sync protocol carries no user info).
export function syncUserCookie(): void {
  document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(getUser()))};path=/`
}