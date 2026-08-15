/**
 * Ships browser events to the dev server, which appends them to
 * `web/dev-log.jsonl`. The point is that nobody can see this page's console
 * except whoever is sitting in front of it — this makes the browser's side of
 * the story readable from a terminal.
 *
 * Dev only. In a build, every call here is a no-op.
 */

interface Entry {
  t: string
  event: string
  data?: unknown
}

const queue: Entry[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let enabled = false

export function devlog(event: string, data?: unknown) {
  if (!enabled) return
  queue.push({ t: new Date().toISOString(), event, data })
  if (timer === null) timer = setTimeout(flush, 150)
}

function flush() {
  timer = null
  if (!queue.length) return
  const batch = queue.splice(0, queue.length)
  void fetch('/__log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch),
    keepalive: true,
  }).catch(() => {
    /* the log pipe must never break the app */
  })
}

export function installDevLog() {
  if (!import.meta.env.DEV) return
  enabled = true

  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      devlog(`console.${level}`, args.map(stringify).join(' '))
      original(...args)
    }
  }

  addEventListener('error', (e) => {
    devlog('window.error', { message: e.message, source: e.filename, line: e.lineno, col: e.colno })
  })
  addEventListener('unhandledrejection', (e) => {
    devlog('unhandledrejection', stringify(e.reason))
  })
  addEventListener('beforeunload', flush)

  devlog('session.start', { ua: navigator.userAgent, w: innerWidth, h: innerHeight })
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}`
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
