import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // graph.json and view.json live in public/ and are polled by the client.
    // Without this, Vite full-reloads the page whenever they change, which
    // resets the camera — the one thing the edit loop must not do.
    watch: { ignored: ['**/public/*.json'] },
  },
})
