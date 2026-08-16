import * as THREE from 'three'
import {
  DEFAULT_TUNING,
  deadzone,
  deadzone1,
  ease,
  flipFacing,
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

const WHEEL_IMPULSE = 0.22 // velocity per wheel unit, along the view direction
const FOCUS_SECONDS = 0.55
/** Long enough to see the world go past, short enough to feel like a flick. */
const SPIN_SECONDS = 0.2

export class FlyController implements Controller {
  private keys = new Set<string>()
  private buttons = new Set<number>()
  private euler = new THREE.Euler(0, 0, 0, 'YXZ')
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
  private padLook = 2.6 // radians/sec at full stick deflection
  private padFocusHeld = false
  private padPickHeld = false
  private padClearHeld = false
  private padRevealHeld = false
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
  private spin: { yaw: number; pitch: number; dYaw: number; dPitch: number; t: number } | null = null

  private dir = new THREE.Vector3()
  private right = new THREE.Vector3()
  private input = new THREE.Vector3()

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    this.euler.setFromQuaternion(camera.quaternion)
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
    const to = flipFacing(this.euler.y, this.euler.x)
    this.spin = {
      yaw: this.euler.y,
      pitch: this.euler.x,
      dYaw: to.yaw - this.euler.y,
      dPitch: to.pitch - this.euler.x,
      t: 0,
    }
    this.tween = null // a focus flight and a look behind you disagree
    devlog('flip', { yaw: +this.euler.y.toFixed(2), pitch: +this.euler.x.toFixed(2), instant })
    // Nothing advances a spin in a backgrounded tab, where there is no
    // animation loop — the same reason `frame` can arrive instantly.
    if (instant) this.stepSpin(SPIN_SECONDS)
  }

  private stepSpin(dt: number) {
    const s = this.spin!
    s.t = Math.min(1, s.t + dt / SPIN_SECONDS)
    const k = ease(s.t)
    this.euler.y = s.yaw + s.dYaw * k
    this.euler.x = s.pitch + s.dPitch * k
    this.camera.quaternion.setFromEuler(this.euler)
    if (s.t >= 1) {
      // Keep yaw in one turn's worth, so flipping all night does not walk it
      // off into numbers that lose precision.
      this.euler.y = ((this.euler.y + Math.PI) % (Math.PI * 2)) - Math.PI
      this.camera.quaternion.setFromEuler(this.euler)
      this.spin = null
    }
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
    this.right.crossVectors(this.dir, this.camera.up).normalize()

    const pad = this.readGamepad(dt)
    const k = this.keys
    // Held mouse buttons drive the same axis as W and S, so the mouse alone is
    // enough to get around.
    const forward =
      (k.has('KeyW') || this.buttons.has(0) ? 1 : 0) -
      (k.has('KeyS') || this.buttons.has(2) ? 1 : 0) +
      (pad?.forward ?? 0)
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) + (pad?.strafe ?? 0)
    const rise = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0) + (pad?.rise ?? 0)

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
      : new THREE.Vector3(0.55, 0.42, 0.72).normalize().multiplyScalar(distance)
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
    if (this.remote) return null // a pad is polled, so it has to be asked to stop
    const pads = navigator.getGamepads?.() ?? []
    let pad: Gamepad | null = null
    for (const p of pads) {
      if (p?.connected) {
        pad = p
        break
      }
    }
    if (!pad) return null

    const move = deadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0)
    const look = deadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0)

    if (!this.spin && (look.x || look.y)) {
      this.euler.y -= look.x * this.padLook * dt
      this.euler.x -= look.y * this.padLook * dt
      this.euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.euler.x))
      this.camera.quaternion.setFromEuler(this.euler)
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

    // Either stick, pressed in: standard mapping puts L3 and R3 at 10 and 11.
    const stick = (pad.buttons[10]?.pressed ?? false) || (pad.buttons[11]?.pressed ?? false)
    if (stick && !this.padFlipHeld) this.flip()
    this.padFlipHeld = stick

    const bumper = (pad.buttons[4]?.pressed ?? false) || (pad.buttons[5]?.pressed ?? false)
    if (bumper && !this.padBoostHeld) this.setFast(!this.fast, 'bumper')
    this.padBoostHeld = bumper

    const down = deadzone1(pad.buttons[6]?.value ?? 0)
    const up = deadzone1(pad.buttons[7]?.value ?? 0)
    return {
      forward: -move.y, // stick up is forward
      strafe: move.x,
      rise: up - down,
      boost: false, // the pad toggles below rather than holding
    }
  }

  private stepTween(dt: number) {
    const tw = this.tween!
    tw.t += dt / FOCUS_SECONDS
    this.camera.position.lerpVectors(tw.from, tw.to, ease(tw.t))
    this.camera.lookAt(tw.look)
    this.euler.setFromQuaternion(this.camera.quaternion)
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
    }
  }

  private onMouseMove = (e: MouseEvent) => {
    if (this.remote || this.spin || !this.locked) return
    this.euler.y -= e.movementX * this.sensitivity
    this.euler.x -= e.movementY * this.sensitivity
    this.euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.euler.x))
    this.camera.quaternion.setFromEuler(this.euler)
    if (this.tween) this.tween = null
  }

  /**
   * Tells whoever is listening that the camera started or stopped moving, or
   * changed gear. Only on a change: the flight bed is a loop that is ridden
   * with a gain, not something to retrigger sixty times a second.
   */
  private reportMotion(moving: boolean) {
    if (moving === this.wasMoving && this.fast === this.wasFast) return
    this.wasMoving = moving
    this.wasFast = this.fast
    this.onMotion?.(moving, this.fast)
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
