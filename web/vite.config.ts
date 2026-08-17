import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { defineConfig, type Plugin } from 'vite'
import { resolveWithinRoot, shotFileName } from './src/srcpath'
import { runsForLines, type Span } from './src/spans'

const execFileAsync = promisify(execFile)

const LOG_FILE = 'dev-log.jsonl'
const SHOT_DIR = 'shots'

/**
 * Remote shutter. `POST /__shot/request` bumps a counter; the page polls it and
 * captures its canvas when the number moves; `POST /__shot` delivers the PNG.
 *
 * The point is that whoever is working on this — including an agent with no
 * browser — can see the current view on demand instead of asking the person
 * holding the mouse for a screenshot.
 */
function remoteShutter(): Plugin {
  let requested = 0
  let latest = ''

  return {
    name: 'callscape-remote-shutter',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        const url = req.url ?? '/'

        if (req.method === 'GET' && url.startsWith('/pending')) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ seq: requested, latest }))
          return
        }

        if (req.method === 'POST' && url.startsWith('/request')) {
          requested++
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ seq: requested }))
          return
        }

        if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => (body += chunk))
          req.on('end', () => {
            void (async () => {
              try {
                const { name, dataUrl } = JSON.parse(body) as { name: string; dataUrl: string }
                const safe = shotFileName(name)
                if (!safe) {
                  server.config.logger.warn(`shot refused: ${name}`)
                  res.statusCode = 400
                  res.end()
                  return
                }
                const png = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64')
                await mkdir(SHOT_DIR, { recursive: true })
                const file = `${SHOT_DIR}/${safe}`
                await writeFile(file, png)
                latest = file
                server.config.logger.info(`shot: ${file} (${Math.round(png.length / 1024)}kb)`)
              } catch (err) {
                server.config.logger.warn(`shot failed: ${String(err)}`)
              }
              res.statusCode = 204
              res.end()
            })()
          })
          return
        }

        res.statusCode = 405
        res.end()
      })
    },
  }
}

/**
 * Accepts batched events from the page and appends them to dev-log.jsonl, so
 * the browser's console is readable from a terminal — including by an agent
 * that has no browser at all.
 */
function devLogSink(): Plugin {
  return {
    name: 'callscape-dev-log',
    configureServer(server) {
      server.middlewares.use('/__log', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          void (async () => {
            try {
              const batch = JSON.parse(body) as unknown[]
              await appendFile(LOG_FILE, batch.map((e) => JSON.stringify(e)).join('\n') + '\n')
            } catch (err) {
              server.config.logger.warn(`dev-log: ${String(err)}`)
            }
            res.statusCode = 204
            res.end()
          })()
        })
      })
    },
  }
}

/**
 * Token spans for one file, from the Go scanner that compiles it.
 *
 * A highlighter written in the browser guesses at a grammar this project
 * already has a lexer for — `callscape-dump --lex` is one file and no package
 * loading, so it answers fast enough to ask per panel. The built binary if
 * `make build` has been run, otherwise the toolchain; neither is required, and
 * a failure here costs colour rather than the source.
 */
async function lex(file: string): Promise<Span[] | null> {
  const root = resolve('..') // vite runs in web/; the Go module is the repo
  const binary = join(root, 'callscape-dump')
  const [cmd, args] = existsSync(binary)
    ? [binary, ['--lex', file]]
    : ['go', ['run', './cmd/callscape-dump', '--lex', file]]
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024, // a big generated file is a lot of tokens
      timeout: 20_000,
    })
    return (JSON.parse(stdout) as { spans: Span[] }).spans
  } catch {
    return null
  }
}

/**
 * Where the analysed module lives on this machine.
 *
 * It used to be a field in graph.json, which meant every dump published the
 * home directory of whoever ran it. It is a local fact, so it lives in a local
 * untracked file that `make dump` writes; with no such file the answer is this
 * repo, which is exactly right for the sample graph a fresh clone starts on.
 */
const SOURCE_ROOT_FILE = '.source-root'

async function sourceRoot(): Promise<string> {
  try {
    const pinned = (await readFile(SOURCE_ROOT_FILE, 'utf8')).trim()
    if (pinned) return pinned
  } catch {
    /* no dump on this machine yet */
  }
  return resolve('..') // nothing pinned: the sample graph is this repo
}

/**
 * Serves source out of the analysed module, so a selected symbol can be read
 * rather than only counted. The request names a file relative to that module's
 * root, which is exactly the shape of a traversal bug, so the containment check
 * is a tested function rather than an inline string compare.
 */
function sourceReader(): Plugin {
  return {
    name: 'callscape-source',
    configureServer(server) {
      server.middlewares.use('/__src', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(body))
        }

        void (async () => {
          try {
            const file = url.searchParams.get('file') ?? ''
            const full = resolveWithinRoot(await sourceRoot(), file)
            if (!full) return send(400, { error: `refused: ${file}` })

            const from = Number(url.searchParams.get('from') ?? 1)
            const to = Number(url.searchParams.get('to') ?? from + 40)
            const raw = await readFile(full)
            const text = raw.toString('utf8')
            const lines = text.split('\n').slice(Math.max(0, from - 1), to)
            // Colour is a bonus: if the toolchain is not there, the panel still
            // reads. `lines` is what it falls back to.
            const spans = await lex(full)
            const runs = spans ? runsForLines(raw, spans, from, to) : undefined
            send(200, { file, from, to, lines, runs })
          } catch (err) {
            send(404, { error: String(err) })
          }
        })()
      })
    },
  }
}

export interface Cue {
  seq: number
  focus?: string | null
  select?: string[]
  reveal?: boolean
  distance?: number
  yaw?: number
  pitch?: number
  pick?: boolean
  clear?: boolean
  search?: string
  hold?: boolean
  flip?: boolean
  panel?: string
}

/**
 * Remote control. Lets whoever is driving put the page into a specific state —
 * this symbol selected, camera here, neighbours revealed — instead of asking
 * someone to fly there and describe it.
 */
function remoteCue(): Plugin {
  let cue: Cue = { seq: 0 }

  return {
    name: 'callscape-remote-cue',
    configureServer(server) {
      server.middlewares.use('/__cue', (req, res) => {
        if (req.method === 'GET') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(cue))
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          try {
            cue = { ...(JSON.parse(body) as Omit<Cue, 'seq'>), seq: cue.seq + 1 }
            server.config.logger.info(`cue: ${JSON.stringify(cue)}`)
          } catch (err) {
            server.config.logger.warn(`cue failed: ${String(err)}`)
          }
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(cue))
        })
      })
    },
  }
}

/**
 * Binding the LAN, and the two endpoints that make that interesting, are off
 * unless asked for.
 *
 * The exposure was never that these endpoints exist — it is `host: true`. On
 * loopback, a local page reading local files is a local process reading files
 * it could already read. Put the same server on the network and `/__cue` hands
 * the wheel to anything that asks and `/__shot` writes files on request, which
 * is a different proposition entirely.
 *
 * So this gates the network binding and those two. `/__src` is not in the list:
 * it is what the Tab panel calls to show you a function's source, which is a
 * feature this project advertises on its front page, and gating it turned that
 * into a parse error for everybody who cloned the repo. What keeps it honest is
 * `resolveWithinRoot`, which is a tested function and applies regardless.
 *
 * Named for what it is. Nobody sets a variable with UNSAFE in it by accident,
 * and nobody who does can say they were not told.
 */
const REMOTE_ENABLED = process.env.UNSAFE_ENABLE_REMOTE_CONTROL === 'true'

/**
 * The domain a Codespace forwards this port through, or null when we are not in
 * one.
 *
 * Three things need it and none of them can be guessed at build time. The
 * forward terminates HTTPS on 443 and proxies to 5178 here, so the client has
 * to be told which port to open its socket on; Vite refuses a Host header it
 * does not recognise, and the forward sends its own; and the loopback default
 * stops meaning what it means on a laptop, which is worth saying out loud.
 *
 * The domain is read rather than hardcoded because it is not always
 * `app.github.dev` — an enterprise or a proxy sets a different one, and this is
 * the variable that carries it.
 */
const FORWARDING_DOMAIN =
  process.env.CODESPACES === 'true'
    ? (process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ?? 'app.github.dev')
    : null

/**
 * Says what the loopback binding is and is not worth, when it is worth less.
 *
 * `host: false` is a real boundary on a laptop. It is not one here: the
 * forwarding agent runs inside this container and reaches 127.0.0.1 the same
 * way the browser on your desk would, so the page is on the internet behind an
 * authenticating proxy rather than off it. The forward's visibility is the
 * actual boundary, and it is set outside this repo — so the only useful thing
 * the server can do is name it.
 */
function forwardWarning(): Plugin {
  return {
    name: 'callscape-forward-warning',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        server.config.logger.warn(
          `  ⚠  forwarded through ${FORWARDING_DOMAIN}: loopback is not a boundary here. ` +
            'The port forward reaches this server, and who reaches the forward is its ' +
            'visibility setting — private, unless somebody changed it.' +
            (REMOTE_ENABLED
              ? ' Remote control is ON behind that, so /__cue and /__shot are reachable ' +
                'by anyone the forward lets through. Make it public and that is everyone.'
              : ''),
        )
      })
    },
  }
}

/**
 * Says so at startup, once.
 *
 * A capability that is on and silent is one nobody remembers is on. This is the
 * only line the dev server prints that is about exposure rather than about the
 * build, which is the point.
 */
function remoteWarning(): Plugin {
  return {
    name: 'callscape-remote-warning',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        server.config.logger.warn(
          '  ⚠  remote control ON: listening on every interface, and /__cue and /__shot ' +
            'are answering. Anything on this network can steer the camera, write a file, ' +
            'and read the dumped module. Unset UNSAFE_ENABLE_REMOTE_CONTROL to go back to ' +
            'loopback.',
        )
      })
    },
  }
}

export default defineConfig({
  // Off means the middleware was never registered, rather than registered and
  // answering 403. There is nothing to probe and nothing to get wrong later:
  // the endpoint does not exist.
  plugins: [
    devLogSink(), // local file, no reach — unconditional
    sourceReader(), // the Tab panel's own endpoint; contained by resolveWithinRoot
    ...(REMOTE_ENABLED ? [remoteWarning(), remoteShutter(), remoteCue()] : []),
    ...(FORWARDING_DOMAIN ? [forwardWarning()] : []),
  ],
  server: {
    // Loopback unless asked otherwise. With the flag, this listens on every
    // interface so the page can be flown from a phone — and is then a machine
    // on your network offering the camera, a file writer, and the dumped
    // module's source to anything that asks.
    //
    // Note for anything behind a port forward — a Codespace, an SSH tunnel —
    // where loopback is reachable from elsewhere and this default protects
    // less than it looks like it does. See issue #16.
    host: REMOTE_ENABLED,
    // Pinned, and pinned loudly. `make shot` and `make cue` post to 5178, and
    // Vite's default is to take the next free port when 5173 is busy — so this
    // server was on 5178 by coincidence, and the instruments would have been
    // talking to whatever else happened to answer there.
    port: 5178,
    strictPort: true,
    // Vite refuses a request whose Host header it does not recognise, and
    // allows only localhost and bare IPs by default — so a Codespace's
    // forwarded hostname is met with "Blocked request", which looks like the
    // devcontainer is broken rather than like a setting. The leading dot makes
    // it a suffix match over the one domain this port is forwarded through.
    allowedHosts: FORWARDING_DOMAIN ? [`.${FORWARDING_DOMAIN}`] : [],
    // The forward terminates HTTPS on 443 and proxies to 5178 in here, so a
    // client told to open its socket on 5178 opens it against a port that is
    // not published and HMR dies silently — the page loads, and only edits stop
    // arriving, which is the worst way for this to break. The protocol needs no
    // setting: the client reads `wss` off the page's own URL.
    //
    // `server.ws`, not `server.hmr` — Vite 8 moved these and still answers to
    // the old spelling, with a deprecation warning.
    ...(FORWARDING_DOMAIN ? { ws: { clientPort: 443 } } : {}),
    // graph.json and view.json live in public/ and are polled by the client.
    // Without this, Vite full-reloads the page whenever they change, which
    // resets the camera — the one thing the edit loop must not do.
    watch: { ignored: ['**/public/*.json'] },
  },
})
