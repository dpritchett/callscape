import { devlog } from './devlog'

/**
 * Client half of the remote shutter. Polls for a capture request and answers
 * with a PNG of the canvas.
 *
 * It renders the frame itself rather than waiting for the animation loop,
 * because a backgrounded tab stops requestAnimationFrame entirely — the first
 * version could only take a screenshot while somebody was already looking at
 * the page, which is exactly when a screenshot is least useful. setTimeout
 * keeps running when hidden (throttled to about a second), so the poll
 * survives.
 *
 * The capture has to happen in the same turn as the render: a WebGL drawing
 * buffer is cleared once presented, so reading it later gives a blank image
 * unless the context was created with preserveDrawingBuffer, which taxes every
 * frame to serve the rare screenshot.
 */
export class Shutter {
  private seq = -1

  constructor(
    private canvas: HTMLCanvasElement,
    private renderFrame: () => void,
    private pollMs = 400,
  ) {}

  start() {
    if (!import.meta.env.DEV) return
    // Registered only when the remote control was asked for, and that does not
    // change while the page is open — so a default clone should ask once and
    // stop, not twice a second forever. Vite answers an unknown path with
    // index.html and a 200, which is why this reads the content type rather
    // than the status.
    let registered = true
    const tick = async () => {
      try {
        const res = await fetch('/__shot/pending', { cache: 'no-store' })
        if (!(res.headers.get('content-type') ?? '').includes('json')) {
          registered = false
          return
        }
        const { seq } = (await res.json()) as { seq: number }
        if (this.seq === -1) this.seq = seq // ignore requests made before we loaded
        else if (seq !== this.seq) {
          this.seq = seq
          this.capture('latest')
        }
      } catch {
        /* the shutter must never break the app */
      } finally {
        if (registered) setTimeout(tick, this.pollMs)
      }
    }
    void tick()
  }

  private capture(label: string) {
    this.renderFrame()
    const dataUrl = this.canvas.toDataURL('image/png')
    const name = `${label}.png`
    devlog('shot', { name, bytes: dataUrl.length, hidden: document.hidden })
    void fetch('/__shot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, dataUrl }),
    }).catch(() => {})
  }
}
