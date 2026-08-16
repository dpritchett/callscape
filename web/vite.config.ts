import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { defineConfig, type Plugin } from 'vite'
import { resolveWithinRoot } from './src/srcpath'

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
    name: 'lspvue-remote-shutter',
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
                const png = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64')
                await mkdir(SHOT_DIR, { recursive: true })
                const file = `${SHOT_DIR}/${name}`
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
    name: 'lspvue-dev-log',
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
 * Serves source out of the analysed module, so a selected symbol can be read
 * rather than only counted. The graph names its own root; the request names a
 * file relative to it, which is exactly the shape of a traversal bug, so the
 * containment check is a tested function rather than an inline string compare.
 */
function sourceReader(): Plugin {
  return {
    name: 'lspvue-source',
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
            const graph = JSON.parse(await readFile('public/graph.json', 'utf8')) as {
              root?: string
            }
            const file = url.searchParams.get('file') ?? ''
            const full = resolveWithinRoot(graph.root ?? '', file)
            if (!full) return send(400, { error: `refused: ${file}` })

            const from = Number(url.searchParams.get('from') ?? 1)
            const to = Number(url.searchParams.get('to') ?? from + 40)
            const text = await readFile(full, 'utf8')
            const lines = text.split('\n').slice(Math.max(0, from - 1), to)
            send(200, { file, from, to, lines })
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
}

/**
 * Remote control. Lets whoever is driving put the page into a specific state —
 * this symbol selected, camera here, neighbours revealed — instead of asking
 * someone to fly there and describe it.
 */
function remoteCue(): Plugin {
  let cue: Cue = { seq: 0 }

  return {
    name: 'lspvue-remote-cue',
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

export default defineConfig({
  plugins: [devLogSink(), remoteShutter(), remoteCue(), sourceReader()],
  server: {
    // graph.json and view.json live in public/ and are polled by the client.
    // Without this, Vite full-reloads the page whenever they change, which
    // resets the camera — the one thing the edit loop must not do.
    watch: { ignored: ['**/public/*.json'] },
  },
})
