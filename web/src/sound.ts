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
  // No fast-on/fast-off. The flight bed is two tiers of airflow and it says
  // which one you are in continuously, for as long as it is true, which is
  // strictly more than a callout said once. The recipe can drop those two.
  'capture',
  'release',
  // Looking behind you. Wants a whoosh rather than a word: it is a movement,
  // and the thing it should sound like is the thrusters that turned you round.
  'flip',
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

/**
 * Background music: one written track, looping, from beatshop rather than from
 * the sound recipe.
 *
 * It replaced a pair of eight-second loops that took a minute each in turn —
 * two moods handing over, which was a way of making eight seconds of material
 * last. A hundred and eleven seconds of actual music does not need the trick,
 * so the handover, the second gain and the minute timer are gone with it.
 *
 * FLAC rather than WAV: the same samples at a fifth of the size, and unlike an
 * MP3 it is sample-exact, so the loop comes round without the seam an encoder's
 * padding would put there. Every browser this page runs in decodes it.
 */
const TRACK = 'apollo-v1'
type Track = typeof TRACK
/** Long enough that arriving reads as weather changing, not as a play button. */
const TRACK_FADE = 3
/**
 * Stopping is not a handover. Letting go of the controls should leave you in
 * silence about as fast as you noticed you had let go, so this is short enough
 * to read as the sim powering down rather than as the music trailing off.
 */
const TRACK_STOP = 0.8

/**
 * The voice and the beds are WAVs baked by beepboop; the music is a FLAC
 * written elsewhere. One line rather than a manifest, because the exception is
 * one file and a lookup table would be longer than the thing it replaced.
 */
function fileOf(name: Cue | Bed | Track): string {
  return name === TRACK ? `${name}.flac` : `${name}.wav`
}

/**
 * How loud a spoken line is, against the level the recipe baked.
 *
 * One number for all of them rather than a trim per cue. The recipe normalises
 * every line to the same peak and that is the right call there — but the whole
 * voice sits too far forward against the beds and the music, and "view error,
 * holding last scene" arriving at full level is a shout for something the error
 * bar is already saying quietly at the bottom of the screen.
 *
 * The value is the one `capture` and `release` were trimmed to, which is the
 * level that stopped being annoying, applied to the lot.
 */
const VOICE_LEVEL = 0.45

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
  private buffers = new Map<Cue | Bed | Track, AudioBuffer>()
  private beds: Record<Bed, GainNode> | null = null
  private music: GainNode | null = null
  /** What the app asked for; `playing` is what is actually sounding. */
  private wanted = false
  private playing = false
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
    // Annotated: a bare element in an array literal widens to `string`, which
    // the spreads alone did not.
    const wanted: (Cue | Bed | Track)[] = [...CUES, ...BEDS, TRACK]
    await Promise.all(
      wanted.map(async (cue) => {
        try {
          const res = await fetch(`/sounds/${fileOf(cue)}`)
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
          this.buffers.set(cue, await this.ctx.decodeAudioData(await res.arrayBuffer()))
        } catch (err) {
          // A slug the recipe has not baked yet is silence, not a broken page.
          devlog('voice.missing', { cue, err: String(err) })
        }
      }),
    )
    // The context's state and the master gain go in the log because every
    // silent-page question so far has been one of: nothing decoded, nothing
    // asked to play, or a graph that is running perfectly into a tab the
    // browser has muted. The first two were already visible; this is the third.
    devlog('voice.ready', {
      loaded: this.buffers.size,
      of: wanted.length,
      state: this.ctx.state,
      master: this.master.gain.value,
      rate: this.ctx.sampleRate,
    })
    // Whatever was asked for while this was still loading, do it now.
    this.applyMusic()
  }

  set(enabled: boolean, volume: number) {
    this.enabled = enabled
    this.master.gain.value = Math.max(0, Math.min(1, volume))
    if (!enabled) {
      this.cut()
      this.bed(false, false)
    }
    this.applyMusic()
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
    // What the gains actually are, not what they were asked for, plus a clock
    // that only advances while the context is really running. A bed that is
    // wired, unmuted and still inaudible is one of those two lying.
    devlog('voice.bed', {
      on,
      fast,
      slow: +this.beds!['flight-slow'].gain.value.toFixed(3),
      quick: +this.beds!['flight-fast'].gain.value.toFixed(3),
      music: this.music ? +this.music.gain.value.toFixed(3) : null,
      state: this.ctx.state,
      time: +this.ctx.currentTime.toFixed(2),
    })
  }

  /**
   * Music, on while the sim is being flown and off while it is not.
   *
   * "Being flown" means somebody has the controls — you with the pointer
   * captured, or a remote holding the wheel. The state this is the opposite of
   * is the one where the page is sitting there with the cursor free, which is
   * not a moment that wants a soundtrack.
   */
  setPlaying(on: boolean) {
    this.wanted = on
    this.applyMusic()
  }

  /** What the app asked for, once the volume knob has had its say. */
  private applyMusic() {
    const want = this.wanted && this.enabled
    if (want === this.playing) return
    // Only claim to be playing once there is something to play. Marking it
    // first meant that capturing the pointer during the second it takes to
    // decode left the flag set with silence behind it, and every later call
    // agreed there was nothing to do. Preload calls back here when it lands.
    if (!this.startMusic()) return
    this.playing = want

    // The loop itself never stops once started; only whether you can hear it
    // changes. Leaving takes under a second, arriving takes three.
    this.rampTo(this.music!.gain, want ? 1 : 0, want ? TRACK_FADE : TRACK_STOP)
    devlog('music', { playing: want, track: TRACK, state: this.ctx.state, master: this.master.gain.value })
  }

  /** Starts the loop at zero, once. */
  private startMusic(): boolean {
    if (this.music) return true
    const buffer = this.buffers.get(TRACK)
    if (!buffer) return false
    if (this.ctx.state === 'suspended') void this.ctx.resume()

    const src = this.ctx.createBufferSource()
    const gain = this.ctx.createGain()
    src.buffer = buffer
    src.loop = true
    gain.gain.value = 0
    src.connect(gain).connect(this.master)
    src.start()
    this.music = gain
    return true
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

  private rampTo(param: AudioParam, value: number, seconds = BED_FADE) {
    if (Math.abs(param.value - value) < 0.001) return
    const at = this.ctx.currentTime
    param.cancelScheduledValues(at)
    param.setValueAtTime(param.value, at)
    param.linearRampToValueAtTime(value, at + seconds)
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
    gain.gain.value = VOICE_LEVEL
    src.connect(gain).connect(this.master)
    src.onended = () => {
      if (this.now?.src === src) this.now = null
    }
    src.start()
    this.now = { src, gain }
    devlog('voice', { cue, gain: VOICE_LEVEL })
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
