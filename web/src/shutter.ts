import { devlog } from './devlog'

/**
 * Client half of the remote shutter. Polls for a capture request and answers
 * with a PNG of the canvas.
 *
 * The capture has to happen in the same frame as a render — a WebGL drawing
 * buffer is cleared once the frame is presented, so reading it later gives you
 * a blank image unless the context was created with preserveDrawingBuffer,
 * which costs performance on every frame to serve the rare screenshot.
 */
export class Shutter {
  private wanted = false
  private seq = -1

  constructor(
    private canvas: HTMLCanvasElement,
    private pollMs = 400,
  ) {}

  start() {
    if (!import.meta.env.DEV) return
    const tick = async () => {
      try {
        const res = await fetch('/__shot/pending', { cache: 'no-store' })
        const { seq } = (await res.json()) as { seq: number }
        if (this.seq === -1) this.seq = seq // ignore requests made before we loaded
        else if (seq !== this.seq) {
          this.seq = seq
          this.wanted = true
        }
      } catch {
        /* the shutter must never break the app */
      } finally {
        setTimeout(tick, this.pollMs)
      }
    }
    void tick()
  }

  /** Call immediately after renderer.render(), while the buffer still holds. */
  captureIfWanted(label: string) {
    if (!this.wanted) return
    this.wanted = false
    const dataUrl = this.canvas.toDataURL('image/png')
    const name = `${label}.png`
    devlog('shot', { name, bytes: dataUrl.length })
    void fetch('/__shot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, dataUrl }),
    }).catch(() => {})
  }
}
