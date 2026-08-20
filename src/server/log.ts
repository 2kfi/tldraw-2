const LEVELS = ['debug', 'info', 'warn', 'error'] as const
type Level = (typeof LEVELS)[number]

const current: Level = (() => {
  const v = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
  return (LEVELS as readonly string[]).includes(v) ? (v as Level) : 'info'
})()

function enabled(level: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(current)
}

export const log = {
  debug: (...a: unknown[]) => enabled('debug') && console.debug(...a),
  info: (...a: unknown[]) => enabled('info') && console.log(...a),
  warn: (...a: unknown[]) => enabled('warn') && console.warn(...a),
  error: (...a: unknown[]) => enabled('error') && console.error(...a),
}