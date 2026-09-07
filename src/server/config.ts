import path from 'node:path'
import { z } from 'zod'

// Single source of truth for server env. Import this — never read
// process.env for these keys elsewhere — so defaults and validation live once.
const DEV_DEFAULT_SECRET = 'dev-secret-change-me'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // z.coerce turns PORT='abc' into NaN, which fails the int check with a clear
  // message (previously Number() silently produced NaN and listen blew up).
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SESSION_SECRET: z.string().min(1).optional(),
  DATA_DIR: z.string().min(1).default(path.join(process.cwd(), 'data')),
  MUSIC_DIR: z.string().min(1).optional(),
})

function parseEnv() {
  const r = envSchema.safeParse(process.env)
  if (!r.success) {
    throw new Error(
      `invalid environment: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
    )
  }
  return r.data
}

const env = parseEnv()

export const NODE_ENV = env.NODE_ENV
export const IS_PRODUCTION = NODE_ENV === 'production'
export const PORT = env.PORT

// Fail-closed: a production boot with no (or the dev-default) secret would sign
// host/join tokens with a public value, so refuse instead.
let secret = env.SESSION_SECRET
if (IS_PRODUCTION && (!secret || secret === DEV_DEFAULT_SECRET)) {
  throw new Error(
    'SESSION_SECRET must be set to a long random value in production (NODE_ENV=production) — generate one with: openssl rand -base64 32'
  )
}
if (!secret) {
  // ponytail: dev/test only — warn once so the default never looks intentional.
  console.warn('[config] SESSION_SECRET unset, using the dev default (never use in production)')
  secret = DEV_DEFAULT_SECRET
}
export const SESSION_SECRET = secret

export const DATA_DIR = path.resolve(env.DATA_DIR)
export const MUSIC_DIR = env.MUSIC_DIR ? path.resolve(env.MUSIC_DIR) : path.join(DATA_DIR, 'music')
