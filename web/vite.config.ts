import { appendFile } from 'node:fs/promises'
import { defineConfig, type Plugin } from 'vite'

const LOG_FILE = 'dev-log.jsonl'

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
  plugins: [devLogSink()],
  server: {
    // graph.json and view.json live in public/ and are polled by the client.
    // Without this, Vite full-reloads the page whenever they change, which
    // resets the camera — the one thing the edit loop must not do.
    watch: { ignored: ['**/public/*.json'] },
  },
})
