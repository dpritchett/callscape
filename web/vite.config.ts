import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { defineConfig, type Plugin } from 'vite'

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

export default defineConfig({
  plugins: [devLogSink(), remoteShutter()],
  server: {
    // graph.json and view.json live in public/ and are polled by the client.
    // Without this, Vite full-reloads the page whenever they change, which
    // resets the camera — the one thing the edit loop must not do.
    watch: { ignored: ['**/public/*.json'] },
  },
})
