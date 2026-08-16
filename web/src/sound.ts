import { devlog } from './devlog'

/**
 * The navigator's voice. One WAV per event slug in `public/sounds`, so a call
 * site names what happened and the file resolves without a lookup table.
 *
 * Baked by beepboop from `recipes/navigator.json` in that repo — the wording,
 * levels and grit live there. Do not edit the WAVs; ask for a rebake.
 */
export const CUES = [
  'select',
  'deselect',
  'select-miss',
  'clear',
  'clear-nothing',
  'reveal-on',
  'reveal-off',
  'focus',
  'search-open',
  'search-go',
  'search-cancel',
  'search-empty',
  'panel-info',
  'panel-source',
  'fast-on',
  'fast-off',
  'capture',
  'release',
  'view-error',
] as const

export type Cue = (typeof CUES)[number]

/** Long enough not to click, short enough not to be a crossfade. */
const CUT_SECONDS = 0.015

/**
 * Speech on the audio thread, decoded up front.
 *
 * An `<audio>` element is driven from the main thread, which in this page also
 * runs `place()` and every frame — so a rebuild or a heavy redraw stutters or
 * drops whatever is talking. Web Audio renders on its own thread: once a buffer
 * is started, a main thread stuck for 350ms cannot interrupt it. The rendering
 * and the voice have no business being coupled, and this is what uncouples
 * them.
 *
 * One voice at a time. Every line runs about a second and `select`, `capture`
 * and the speed toggle fire on every click and keypress, so a new line cuts the
 * one in progress rather than joining it — with a short ramp, because stopping
 * speech mid-syllable clicks and a click reads as a fault.
 */
export class Voice {
  private ctx = new AudioContext()
  private master = this.ctx.createGain()
  private buffers = new Map<Cue, AudioBuffer>()
  private now: { src: AudioBufferSourceNode; gain: GainNode } | null = null
  private enabled = true

  constructor() {
    this.master.gain.value = 0.8
    this.master.connect(this.ctx.destination)
    void this.preload()
  }

  /**
   * Decode everything at startup. Decoding on first use would put the work in
   * the main thread at exactly the moment something is happening, which is the
   * problem this class exists to avoid.
   */
  private async preload() {
    await Promise.all(
      CUES.map(async (cue) => {
        try {
          const res = await fetch(`/sounds/${cue}.wav`)
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
          this.buffers.set(cue, await this.ctx.decodeAudioData(await res.arrayBuffer()))
        } catch (err) {
          devlog('voice.missing', { cue, err: String(err) })
        }
      }),
    )
    devlog('voice.ready', { loaded: this.buffers.size, of: CUES.length })
  }

  set(enabled: boolean, volume: number) {
    this.enabled = enabled
    this.master.gain.value = Math.max(0, Math.min(1, volume))
    if (!enabled) this.cut()
  }

  play(cue: Cue) {
    if (!this.enabled) return
    const buffer = this.buffers.get(cue)
    if (!buffer) return // still decoding, or never arrived — see voice.missing
    // A context built before the page is clicked starts suspended, and the
    // first thing anyone does here is click to capture the pointer.
    if (this.ctx.state === 'suspended') void this.ctx.resume()

    this.cut()
    const src = this.ctx.createBufferSource()
    const gain = this.ctx.createGain()
    src.buffer = buffer
    src.connect(gain).connect(this.master)
    src.onended = () => {
      if (this.now?.src === src) this.now = null
    }
    src.start()
    this.now = { src, gain }
    devlog('voice', { cue })
  }

  /** End whatever is talking, without the click of stopping it dead. */
  private cut() {
    if (!this.now) return
    const { src, gain } = this.now
    const at = this.ctx.currentTime
    gain.gain.setValueAtTime(gain.gain.value, at)
    gain.gain.linearRampToValueAtTime(0, at + CUT_SECONDS)
    src.stop(at + CUT_SECONDS)
    this.now = null
  }
}
