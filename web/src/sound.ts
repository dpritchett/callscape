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
  // Not in the recipe yet: silent until beepboop bakes them, which is what the
  // banner across the top is for in the meantime.
  'remote-on',
  'remote-off',
] as const

export type Cue = (typeof CUES)[number]

/**
 * Airflow. Two-second loops that wrap seamlessly, played continuously while the
 * camera is moving rather than fired per event.
 *
 * They are one sound at two speeds, not two sounds: `flight-fast` is the same
 * partials and the same noise seed with the tone filter opened up. Riding the
 * two gains against each other reads as one airflow accelerating, which is why
 * both run all the time and neither is ever stopped.
 */
const BEDS = ['flight-slow', 'flight-fast'] as const
type Bed = (typeof BEDS)[number]

/** Long enough not to click, short enough not to be a crossfade. */
const CUT_SECONDS = 0.015
/** How long the bed takes to come up, go away, or change gear. */
const BED_FADE = 0.35

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
  private buffers = new Map<Cue | Bed, AudioBuffer>()
  private beds: Record<Bed, GainNode> | null = null
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
    const wanted = [...CUES, ...BEDS]
    await Promise.all(
      wanted.map(async (cue) => {
        try {
          const res = await fetch(`/sounds/${cue}.wav`)
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
          this.buffers.set(cue, await this.ctx.decodeAudioData(await res.arrayBuffer()))
        } catch (err) {
          // A slug the recipe has not baked yet is silence, not a broken page.
          devlog('voice.missing', { cue, err: String(err) })
        }
      }),
    )
    devlog('voice.ready', { loaded: this.buffers.size, of: wanted.length })
  }

  set(enabled: boolean, volume: number) {
    this.enabled = enabled
    this.master.gain.value = Math.max(0, Math.min(1, volume))
    if (!enabled) {
      this.cut()
      this.bed(false, false)
    }
  }

  /**
   * Airflow while the camera is moving, and which gear it is in. Safe to call
   * on every change of either: it only ever moves two gain ramps, and the
   * sources themselves start once and run for the life of the page.
   *
   * The levels come from the recipe already balanced against the voice — 0.26
   * and 0.38 against 0.72 — so callouts stay intelligible over the bed. Nothing
   * here normalises them.
   */
  bed(moving: boolean, fast: boolean) {
    const on = moving && this.enabled
    if (!this.startBeds()) return
    // Both gains ramp together over the same window, so the pair reads as one
    // airflow changing gear rather than as one sound replacing another.
    this.rampTo(this.beds!['flight-slow'].gain, on && !fast ? 1 : 0)
    this.rampTo(this.beds!['flight-fast'].gain, on && fast ? 1 : 0)
  }

  /** Starts both loops the first time there is anything to play. */
  private startBeds(): boolean {
    if (this.beds) return true
    if (!BEDS.every((b) => this.buffers.has(b))) return false
    if (this.ctx.state === 'suspended') void this.ctx.resume()

    const made = {} as Record<Bed, GainNode>
    for (const name of BEDS) {
      const src = this.ctx.createBufferSource()
      const gain = this.ctx.createGain()
      src.buffer = this.buffers.get(name)!
      // Sample-accurate looping. An <audio loop> re-opens the stream on each
      // repeat in several browsers and inserts a gap the file does not have.
      src.loop = true
      gain.gain.value = 0
      src.connect(gain).connect(this.master)
      src.start()
      made[name] = gain
    }
    this.beds = made
    devlog('voice.beds', { started: BEDS.length })
    return true
  }

  private rampTo(param: AudioParam, value: number) {
    if (Math.abs(param.value - value) < 0.001) return
    const at = this.ctx.currentTime
    param.cancelScheduledValues(at)
    param.setValueAtTime(param.value, at)
    param.linearRampToValueAtTime(value, at + BED_FADE)
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
