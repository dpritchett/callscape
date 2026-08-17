import * as THREE from 'three'
import {
  DEFAULT_TUNING,
  columnFromKeys,
  deadzone,
  deadzone1,
  ease,
  padTouched,
  speedScale,
  stepBurn,
  stepVelocity,
  type MotionTuning,
} from './motion'
import { devlog } from './devlog'

/**
 * Everything the app needs from a camera controller. Swapping fly for orbit is
 * a one-line change in main.ts.
 */
export interface Controller {
  update(dt: number): void
  /**
   * Place the camera `distance` away from `target`, looking at it. Flies there
   * unless `instant`, which matters when nothing is driving update() — a
   * backgrounded tab has no animation loop to advance the flight.
   */
  frame(
    target: THREE.Vector3,
    distance: number,
    instant?: boolean,
    from?: { yaw: number; pitch: number },
  ): void
  dispose(): void
  /**
   * Hand the keyboard over, or take it back. WASD flies whether or not the
   * pointer is captured, so anything that reads typing — the symbol search —
   * has to be able to stop it; otherwise every letter of a query is also a
   * flight control, and `x` drops the selection you were looking for.
   */
  setTyping(on: boolean): void
  /**
   * Ignore every local input — keys, mouse, wheel, gamepad — because something
   * remote is driving. Broader than `setTyping`, which only wants the keyboard.
   */
  setLocked(on: boolean): void
  /**
   * Look the other way — the tail camera — arriving there rather than cutting.
   * `instant` for when nothing is driving update() to turn it.
   */
  flip(instant?: boolean): void
}

/**
 * Where `frame` stands when nobody names a bearing: off to the side and a
 * little above, because looking straight down at a flat district tells you
 * nothing. Exported so that anything wanting to stay near this bearing while
 * adjusting it — the opening shot, which also wants a badge in the frame — is
 * working from the same vector rather than a second copy of it.
 */
export const DEFAULT_OFFSET = new THREE.Vector3(0.55, 0.42, 0.72).normalize()

const WHEEL_IMPULSE = 0.22 // velocity per wheel unit, along the view direction
const FOCUS_SECONDS = 0.55
/** Long enough to see the world go past, short enough to feel like a flick. */
const SPIN_SECONDS = 0.2
/** The camera's own axes: its wings, its spine, and the line it looks along. */
const PITCH_AXIS = new THREE.Vector3(1, 0, 0)
const YAW_AXIS = new THREE.Vector3(0, 1, 0)
const ROLL_AXIS = new THREE.Vector3(0, 0, 1)
/**
 * How far over a held arrow counts as pushing the stick. A key has no travel,
 * so it would otherwise be full deflection from the instant it goes down, and
 * full deflection is 150 degrees a second — more than anyone wants from a tap.
 */
const KEY_DEFLECTION = 0.6
/**
 * How long a pad keeps the controls after its last real input.
 *
 * A pointer holds them until Escape, so a pad should not lose them the moment
 * you stop to look at something. Generous for that reason. Stick drift cannot
 * hold them open, because the deadzone has already turned drift into zero.
 */
const PAD_PRESENCE_SECONDS = 15

export class FlyController implements Controller {
  private keys = new Set<string>()
  private buttons = new Set<number>()
  private locked = false
  private typing = false
  /** Something remote has the wheel; every local input is ignored. */
  private remote = false
  private sensitivity = 0.0022

  private vel = new THREE.Vector3()
  private tuning: MotionTuning = DEFAULT_TUNING

  /** Wired by main.ts to the same action as the F key. */
  onFocus: (() => void) | null = null
  /** Toggle whatever is under the reticle. */
  onPick: (() => void) | null = null
  /** Drop the whole selection. */
  onClearSelection: (() => void) | null = null
  /** Pull the selection's hidden neighbours into the scene, and back out. */
  onToggleReveal: (() => void) | null = null
  /** Step the label ribbon, -1 or 1. */
  onCycleLabels: ((step: number) => void) | null = null
  /**
   * The pad has picked up the controls, or put them down. A pointer captures
   * and releases with an event the page can hear; a pad is polled, so nothing
   * announces it and this has to.
   */
  onPadPresence: ((live: boolean) => void) | null = null
  private padLook = 2.6 // radians/sec at full stick deflection
  /** Roll is faster than pitch, since a turn starts by banking. */
  private padRoll = 3.2
  /** Rudder is slower than both: it trims a heading rather than flying one. */
  private padYaw = 1.3
  private padFocusHeld = false
  private padPickHeld = false
  private padClearHeld = false
  private padRevealHeld = false
  private padRibbonHeld = 0
  /** Seconds since the pad last said anything, and whether that is recent. */
  private padIdle = PAD_PRESENCE_SECONDS
  private padLive = false
  private padBoostHeld = false
  private padFlipHeld = false
  /** Shift or a bumper lights the burn; standing still puts it out. */
  private fast = false
  /** Seconds spent at rest, which is what expires the burn. */
  private still = 0
  /** Whether the camera is moving, and in which gear. Fires only on a change. */
  onMotion: ((moving: boolean, fast: boolean) => void) | null = null
  private wasMoving = false
  private wasFast = false

  // Focus tween state. Flying to a symbol beats being teleported to it.
  private tween: { from: THREE.Vector3; to: THREE.Vector3; look: THREE.Vector3; t: number } | null = null
  /** Tail camera. Whipping round reads as one place; a cut reads as two. */
  private spin: { from: THREE.Quaternion; to: THREE.Quaternion; t: number } | null = null

  private spinQuat = new THREE.Quaternion()
  private dir = new THREE.Vector3()
  private right = new THREE.Vector3()
  private input = new THREE.Vector3()

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    dom.addEventListener('mousedown', this.onMouseDown)
    dom.addEventListener('contextmenu', this.onContextMenu)
    dom.addEventListener('wheel', this.onWheel, { passive: false })
    document.addEventListener('mouseup', this.onMouseUp)
    document.addEventListener('pointerlockchange', this.onLockChange)
    document.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  /**
   * Tail camera: look the other way, arriving there rather than cutting.
   *
   * A hard swap reads as two separate places; a fifth of a second of rotation
   * reads as one place with something behind you. It is short enough that
   * ignoring look input while it runs is not a lockout anyone notices.
   */
  flip(instant = false) {
    if (this.spin) return // already on its way round
    // Half a turn about the camera's own up: a head-turn, which is what looking
    // behind you is. Doing it in angles meant deciding what a bank should
    // become, and every answer disagreed with the others — this one has no
    // opinion to get wrong, and needs no representation but the orientation.
    this.spin = {
      from: this.camera.quaternion.clone(),
      to: this.camera.quaternion.clone().multiply(this.spinQuat.setFromAxisAngle(YAW_AXIS, Math.PI)),
      t: 0,
    }
    this.tween = null // a focus flight and a look behind you disagree
    devlog('flip', { instant })
    // Nothing advances a spin in a backgrounded tab, where there is no
    // animation loop — the same reason `frame` can arrive instantly.
    if (instant) this.stepSpin(SPIN_SECONDS)
  }

  private stepSpin(dt: number) {
    const s = this.spin!
    s.t = Math.min(1, s.t + dt / SPIN_SECONDS)
    this.camera.quaternion.slerpQuaternions(s.from, s.to, ease(s.t))
    if (s.t >= 1) this.spin = null
  }

  update(dt: number) {
    if (this.spin) this.stepSpin(dt)
    if (this.tween) {
      // A focus flight is the camera moving, so it does not count as standing
      // still — burn should not expire underneath a flight you asked for, and
      // the airflow should be there while you are flying.
      this.still = 0
      this.reportMotion(true)
      this.stepTween(dt)
      return
    }

    this.camera.getWorldDirection(this.dir)
    // The camera's own right, not the horizon's. Identical while the wings are
    // level, and the difference is the point once they are not: strafing while
    // banked should go where the wing is pointing.
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion)

    const pad = this.readGamepad(dt)
    const k = this.keys
    // Held mouse buttons drive the same axis as W and S, so the mouse alone is
    // enough to get around.
    const forward =
      (k.has('KeyW') || this.buttons.has(0) ? 1 : 0) -
      (k.has('KeyS') || this.buttons.has(2) ? 1 : 0) +
      (pad?.forward ?? 0)
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) + (pad?.strafe ?? 0)
    const rise = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0)

    // The arrows are the same control column the right stick is, and for the
    // same reason: mouse look can drag the nose around but it has no answer at
    // all for roll, so a keyboard could only ever fly the map upright. Down
    // pulls back and climbs, matching the stick rather than matching a
    // scrollbar — there is one convention in this cockpit and this is it.
    const { pitch, roll } = columnFromKeys(k)
    if (!this.spin && (pitch || roll)) {
      this.turn(PITCH_AXIS, pitch * this.padLook * KEY_DEFLECTION * dt)
      this.turn(ROLL_AXIS, -roll * this.padRoll * KEY_DEFLECTION * dt) // negative banks right
    }

    this.input.set(0, 0, 0)
    if (forward) this.input.addScaledVector(this.dir, forward)
    if (strafe) this.input.addScaledVector(this.right, strafe)
    if (rise) this.input.y += rise
    // Clamp the throttle so a diagonal is not 1.41x faster than an axis, and so
    // stick plus keyboard does not stack into double acceleration.
    if (this.input.lengthSq() > 1) this.input.normalize()

    const boosting = this.fast
    const scale = speedScale(this.camera.position.length())
    const next = stepVelocity(this.vel, this.input, dt, this.tuning, scale, boosting)
    this.vel.set(next.x, next.y, next.z)

    if (this.vel.lengthSq() < 1e-4) this.vel.set(0, 0, 0)
    else this.camera.position.addScaledVector(this.vel, dt)

    // At rest means no input and no drift left, not merely a released key —
    // letting go coasts, and a coast is still moving.
    const moving = Boolean(forward || strafe || rise) || this.vel.lengthSq() > 0
    const burn = stepBurn(this.still, moving, dt)
    this.still = burn.still
    if (this.fast && burn.expired) this.setFast(false, 'rest')
    this.reportMotion(moving)
  }

  frame(
    target: THREE.Vector3,
    distance: number,
    instant = false,
    from?: { yaw: number; pitch: number },
  ) {
    // Approach from the side and slightly above: looking straight down at a
    // flat district tells you nothing. A caller can ask for a specific bearing
    // instead, which is how a rotation-dependent problem gets reproduced.
    const offset = from
      ? new THREE.Vector3(
          Math.cos(from.pitch) * Math.sin(from.yaw),
          Math.sin(from.pitch),
          Math.cos(from.pitch) * Math.cos(from.yaw),
        ).multiplyScalar(distance)
      : DEFAULT_OFFSET.clone().multiplyScalar(distance)
    this.vel.set(0, 0, 0)
    this.spin = null // the flight decides where you are looking
    this.tween = {
      from: this.camera.position.clone(),
      to: target.clone().add(offset),
      look: target.clone(),
      t: 0,
    }
    if (instant) this.stepTween(FOCUS_SECONDS)
  }

  dispose() {
    this.dom.removeEventListener('mousedown', this.onMouseDown)
    this.dom.removeEventListener('contextmenu', this.onContextMenu)
    this.dom.removeEventListener('wheel', this.onWheel)
    document.removeEventListener('mouseup', this.onMouseUp)
    document.removeEventListener('pointerlockchange', this.onLockChange)
    document.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
  }

  /**
   * Standard-mapping gamepad, polled rather than evented. Left stick flies,
   * right stick looks, triggers are the vertical pair, bumpers boost, A snaps
   * to focus. Works whether or not the pointer is captured — a pad is its own
   * input vector, not a mouse accessory.
   */
  private readGamepad(dt: number) {
    if (this.remote) {
      this.dropPad() // a pad is polled, so it has to be asked to stop
      return null
    }
    const pads = navigator.getGamepads?.() ?? []
    let pad: Gamepad | null = null
    for (const p of pads) {
      if (p?.connected) {
        pad = p
        break
      }
    }
    if (!pad) {
      this.dropPad()
      return null
    }

    const move = deadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0)
    const look = deadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0)

    // Somebody is at the controls if the pad says anything at all — past the
    // deadzone, so a resting stick is not an answer. Flying with a pad never
    // captures the pointer, which is what "in control" used to mean, so the sim
    // could be flown across the whole map in silence: no music, no airflow, and
    // the voice still talking. Same idle-timer arithmetic the burn uses.
    const presence = stepBurn(
      this.padIdle,
      padTouched(pad.axes, pad.buttons),
      dt,
      PAD_PRESENCE_SECONDS,
    )
    this.padIdle = presence.still
    this.setPadLive(!presence.expired)

    if (!this.spin && (look.x || look.y)) {
      // A stick, not a mouse. Pull it towards you and the nose comes up; push
      // it away and you dive. Left and right roll rather than yaw, so turning
      // is banking and pulling back, the way an aeroplane does it. The mouse
      // keeps its own convention, which is a mouse's.
      //
      // Both happen in the camera's own frame rather than the world's, so up
      // is the top of the viewport and not true north. Written as euler
      // components this was wrong the moment you banked: pitch there turns
      // about a horizontal axis whatever the wings are doing, so pulling back
      // while rolled took the nose towards the sky instead of towards the top
      // of the screen. A local rotation has no opinion about which way is up.
      this.turn(PITCH_AXIS, look.y * this.padLook * dt)
      this.turn(ROLL_AXIS, -look.x * this.padRoll * dt) // negative banks right
      this.tween = null
    }

    const focus = pad.buttons[0]?.pressed ?? false
    if (focus && !this.padFocusHeld) this.onFocus?.()
    this.padFocusHeld = focus

    const pick = pad.buttons[2]?.pressed ?? false // X / square
    if (pick && !this.padPickHeld) this.onPick?.()
    this.padPickHeld = pick

    const clear = pad.buttons[1]?.pressed ?? false // B / circle
    if (clear && !this.padClearHeld) this.onClearSelection?.()
    this.padClearHeld = clear

    const reveal = pad.buttons[3]?.pressed ?? false // Y / triangle
    if (reveal && !this.padRevealHeld) this.onToggleReveal?.()
    this.padRevealHeld = reveal

    // The d-pad steps the label ribbon. It is the only cluster the flight model
    // never wanted: everything else on the pad is an axis or already spoken for,
    // and stepping a ribbon is exactly what a four-way rocker is for. Edge
    // triggered per direction, so holding it does not spin the ring.
    const ribbon =
      (pad.buttons[15]?.pressed ?? false) ? 1 : (pad.buttons[14]?.pressed ?? false) ? -1 : 0
    if (ribbon !== 0 && ribbon !== this.padRibbonHeld) this.onCycleLabels?.(ribbon)
    this.padRibbonHeld = ribbon

    // Either stick, pressed in: standard mapping puts L3 and R3 at 10 and 11.
    const stick = (pad.buttons[10]?.pressed ?? false) || (pad.buttons[11]?.pressed ?? false)
    if (stick && !this.padFlipHeld) this.flip()
    this.padFlipHeld = stick

    const bumper = (pad.buttons[4]?.pressed ?? false) || (pad.buttons[5]?.pressed ?? false)
    if (bumper && !this.padBoostHeld) this.setFast(!this.fast, 'bumper')
    this.padBoostHeld = bumper

    // Triggers are the rudder. They used to push you along the world's vertical
    // axis, which was the last thing on the pad still pegged to a direction the
    // outside world agrees on rather than one you can see — and once the right
    // stick took over roll, yaw had nowhere else to live. Without it you can
    // only turn by banking, which is authentic and occasionally useless: this
    // is how you swing the nose across without laying the horizon over.
    const left = deadzone1(pad.buttons[6]?.value ?? 0)
    const right = deadzone1(pad.buttons[7]?.value ?? 0)
    if (!this.spin) this.turn(YAW_AXIS, (left - right) * this.padYaw * dt)

    return {
      forward: -move.y, // stick up is forward
      strafe: move.x,
      boost: false, // the pad toggles below rather than holding
    }
  }

  private stepTween(dt: number) {
    const tw = this.tween!
    tw.t += dt / FOCUS_SECONDS
    this.camera.position.lerpVectors(tw.from, tw.to, ease(tw.t))
    this.camera.lookAt(tw.look)
    if (tw.t >= 1) this.tween = null
  }

  // What a click means depends on whether the pointer is captured, so the two
  // states get their own bindings.
  private onMouseDown = (e: MouseEvent) => {
    if (this.remote) return
    devlog('mousedown', { button: e.button, locked: this.locked })
    if (this.locked) this.pressCaptured(e.button)
    else this.pressUncaptured(e.button)
  }

  private pressUncaptured = (button: number) => {
    // Only the primary button captures, and that press is spent on capturing:
    // carrying it over would fire you forward the instant you clicked in.
    // Delete this branch's `return` if you'd rather it be continuous.
    if (button === 0) this.dom.requestPointerLock()
  }

  private pressCaptured = (button: number) => {
    if (button === 1) {
      this.onPick?.() // middle click selects; it is the only button not flying
      return
    }
    this.buttons.add(button)
    this.tween = null // any input cancels a focus flight
  }

  private onMouseUp = (e: MouseEvent) => {
    this.buttons.delete(e.button)
  }

  private onContextMenu = (e: Event) => {
    e.preventDefault() // secondary click is "back", not a menu
  }

  private onWheel = (e: WheelEvent) => {
    if (this.remote || !this.locked) return
    e.preventDefault()
    this.camera.getWorldDirection(this.dir)
    // Dolly along the view direction. Q/E stay world-vertical; this is the one
    // that reads as zoom while flying.
    this.vel.addScaledVector(this.dir, -e.deltaY * WHEEL_IMPULSE)
    this.tween = null
  }

  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.dom
    devlog('pointerlock', { locked: this.locked })
    if (!this.locked) {
      this.keys.clear()
      this.buttons.clear()
      // Letting the pointer go is somebody saying they are done, and it should
      // not then take fifteen seconds of pad timeout for the sim to agree. An
      // explicit release beats implicit presence; the next touch of the stick
      // picks the controls straight back up on the following frame.
      this.dropPad()
    }
  }

  /**
   * Mouse look, which is not stick flying: yaw about the world's vertical so
   * the horizon stays where the horizon is, pitch about the camera's own wing
   * axis, and no roll at all. That is what a mouse means everywhere else.
   *
   * The pitch limit is measured from where the nose actually is rather than
   * from a stored angle, so it holds however the stick has been rolling the
   * camera around underneath it.
   */
  private onMouseMove = (e: MouseEvent) => {
    if (this.remote || this.spin || !this.locked) return
    this.turnWorld(YAW_AXIS, -e.movementX * this.sensitivity)

    const elevation = Math.asin(Math.max(-1, Math.min(1, this.camera.getWorldDirection(this.dir).y)))
    const limit = Math.PI / 2 - 0.01
    const wanted = -e.movementY * this.sensitivity
    this.turn(PITCH_AXIS, Math.max(-limit - elevation, Math.min(limit - elevation, wanted)))
    if (this.tween) this.tween = null
  }

  /**
   * Tells whoever is listening that the camera started or stopped moving, or
   * changed gear. Only on a change: the flight bed is a loop that is ridden
   * with a gain, not something to retrigger sixty times a second.
   */
  /**
   * Whether a pad is flying this thing right now.
   *
   * Responding to the stick *is* having the controls, whether or not anybody
   * clicked to capture a pointer they are not using. The page asks this the way
   * it asks for `document.pointerLockElement`.
   */
  padHasControls(): boolean {
    return this.padLive
  }

  private setPadLive(live: boolean) {
    if (live === this.padLive) return
    this.padLive = live
    devlog('pad', { live })
    this.onPadPresence?.(live)
  }

  /** No pad, or somebody else has the wheel: it is holding nothing. */
  private dropPad() {
    this.padIdle = PAD_PRESENCE_SECONDS
    this.setPadLive(false)
  }

  private reportMotion(moving: boolean) {
    if (moving === this.wasMoving && this.fast === this.wasFast) return
    this.wasMoving = moving
    this.wasFast = this.fast
    this.onMotion?.(moving, this.fast)
  }

  /**
   * Rotates the camera about one of its own axes.
   *
   * Right-multiplying the quaternion applies the turn in the camera's frame,
   * which is what makes the stick relative: no clamp is needed and none is
   * wanted, since a quaternion has no gimbal to lock and an aeroplane can loop.
   *
   * The orientation is the only record of where the camera is pointing. It used
   * to be mirrored by a euler that the mouse steered with, kept in step by
   * resyncing one from the other — two representations agreeing by convention,
   * which near the poles they stop doing: the decomposition there is degenerate
   * and yaw and roll become the same edit, so the mouse jumps. Taking the
   * clamp off the stick made that reachable. Now there is nothing to agree.
   */
  private turn(axis: THREE.Vector3, radians: number) {
    if (!radians) return
    this.camera.quaternion.multiply(this.spinQuat.setFromAxisAngle(axis, radians))
  }

  /** The same, but about an axis the world holds still — the mouse's yaw. */
  private turnWorld(axis: THREE.Vector3, radians: number) {
    if (!radians) return
    this.camera.quaternion.premultiply(this.spinQuat.setFromAxisAngle(axis, radians))
  }

  /** The one place the burn changes, so every route through it says so. */
  private setFast(on: boolean, why: string) {
    if (this.fast === on) return
    this.fast = on
    this.still = 0
    devlog('speed', { fast: on, why })
    // No callback of its own: the gear reaches the world through onMotion,
    // which the flight bed is listening to anyway.
  }

  setLocked(on: boolean) {
    this.remote = on
    if (!on) return
    // Nothing is held any more as far as flying is concerned, and no keyup or
    // mouseup is coming while the input is being ignored.
    this.keys.clear()
    this.buttons.clear()
    this.vel.set(0, 0, 0)
  }

  setTyping(on: boolean) {
    this.typing = on
    // Whatever was held when the query opened is not held any more as far as
    // flying is concerned, and no keyup is coming while the keyboard is away.
    if (on) this.keys.clear()
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.typing || this.remote) return
    const fresh = !this.keys.has(e.code)
    this.keys.add(e.code)
    if (e.code !== 'KeyF' && e.code !== 'Space') this.tween = null
    if (!fresh) return // key repeat must not re-fire a toggle
    devlog('keydown', { code: e.code, locked: this.locked })
    // Shift toggles rather than being held down for the entire time you are
    // going anywhere. It expires at rest, so the toggle never has to be undone.
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.setFast(!this.fast, 'shift')
    if (e.code === 'Space') this.onPick?.()
    if (e.code === 'KeyC') this.flip()
    if (e.code === 'KeyX') this.onClearSelection?.()
    if (e.code === 'KeyR') this.onToggleReveal?.()
    // Same ribbon from the keyboard, since the pad is not always plugged in.
    // Forwards only: shift already toggles the burn on its own keydown, so
    // shift-L would light the engines every time you stepped back, and a ring
    // of five reaches everything going one way.
    if (e.code === 'KeyL') this.onCycleLabels?.(1)
  }

  private onKeyUp = (e: KeyboardEvent) => {
    if (this.typing || this.remote) return
    this.keys.delete(e.code)
  }

  private onBlur = () => {
    this.keys.clear()
    this.buttons.clear()
  }
}
