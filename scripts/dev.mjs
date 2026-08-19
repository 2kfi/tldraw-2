import { spawn, spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname
const env = { ...process.env, PORT: process.env.PORT ?? '3001' }

const first = spawnSync('npx', ['tsup'], { cwd: root, stdio: 'inherit' })
if (first.status !== 0) process.exit(first.status ?? 1)

const children = [
  spawn('npx', ['tsup', '--watch'], { stdio: 'inherit', cwd: root }),
  spawn('node', ['--env-file-if-exists=.env', '--watch', 'dist/server/index.js'], { stdio: 'inherit', cwd: root, env }),
  spawn('npx', ['vite'], { stdio: 'inherit', cwd: root }),
]

let closing = false
function onExit() {
  if (closing) return
  closing = true
  for (const c of children) c.kill()
  process.exit(0)
}
process.on('SIGINT', onExit)
process.on('SIGTERM', onExit)
for (const c of children) c.on('exit', (code) => code && onExit())