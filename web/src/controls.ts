import * as THREE from 'three'
import {
  DEFAULT_TUNING,
  deadzone,
  deadzone1,
  ease,
  speedScale,
  stepVelocity,
  type MotionTuning,
} from './motion'

/**
 * Everything the app needs from a camera controller. Swapping fly for orbit is
 * a one-line change in main.ts.
 */
export interface Controller {
  update(dt: number): void
  /** Place the camera `distance` away from `target`, looking at it. */
  frame(target: THREE.Vector3, distance: number): void
  dispose(): void
}

const WHEEL_IMPULSE = 0.22 // velocity per wheel unit, along the view direction
const FOCUS_SECONDS = 0.55

export class FlyController implements Controller {
  private keys = new Set<string>()
  private buttons = new Set<number>()
  private euler = new THREE.Euler(0, 0, 0, 'YXZ')
  private locked = false
  private sensitivity = 0.0022

  private vel = new THREE.Vector3()
  private tuning: MotionTuning = DEFAULT_TUNING

  /** Wired by main.ts to the same action as the F key. */
  onFocus: (() => void) | null = null
  /** Toggle whatever is under the reticle. */
  onPick: (() => void) | null = null
  /** Drop the whole selection. */
  onClearSelection: (() => void) | null = null
  private padLook = 2.6 // radians/sec at full stick deflection
  private padFocusHeld = false
  private padPickHeld = false
  private padClearHeld = false

  // Focus tween state. Flying to a symbol beats being teleported to it.
  private tween: { from: THREE.Vector3; to: THREE.Vector3; look: THREE.Vector3; t: number } | null = null

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

  update(dt: number) {
    if (this.tween) {
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

    const boosting = k.has('ShiftLeft') || k.has('ShiftRight') || (pad?.boost ?? false)
    const scale = speedScale(this.camera.position.length())
    const next = stepVelocity(this.vel, this.input, dt, this.tuning, scale, boosting)
    this.vel.set(next.x, next.y, next.z)

    if (this.vel.lengthSq() < 1e-4) {
      this.vel.set(0, 0, 0)
      return
    }
    this.camera.position.addScaledVector(this.vel, dt)
  }

  frame(target: THREE.Vector3, distance: number) {
    // Approach from the side and slightly above: looking straight down at a
    // flat district tells you nothing.
    const offset = new THREE.Vector3(0.55, 0.42, 0.72).normalize().multiplyScalar(distance)
    this.vel.set(0, 0, 0)
    this.tween = {
      from: this.camera.position.clone(),
      to: target.clone().add(offset),
      look: target.clone(),
      t: 0,
    }
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

    if (look.x || look.y) {
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

    const down = deadzone1(pad.buttons[6]?.value ?? 0)
    const up = deadzone1(pad.buttons[7]?.value ?? 0)
    return {
      forward: -move.y, // stick up is forward
      strafe: move.x,
      rise: up - down,
      boost: (pad.buttons[4]?.pressed ?? false) || (pad.buttons[5]?.pressed ?? false),
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
    if (!this.locked) return
    e.preventDefault()
    this.camera.getWorldDirection(this.dir)
    // Dolly along the view direction. Q/E stay world-vertical; this is the one
    // that reads as zoom while flying.
    this.vel.addScaledVector(this.dir, -e.deltaY * WHEEL_IMPULSE)
    this.tween = null
  }

  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.dom
    if (!this.locked) {
      this.keys.clear()
      this.buttons.clear()
    }
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return
    this.euler.y -= e.movementX * this.sensitivity
    this.euler.x -= e.movementY * this.sensitivity
    this.euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.euler.x))
    this.camera.quaternion.setFromEuler(this.euler)
    if (this.tween) this.tween = null
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const fresh = !this.keys.has(e.code)
    this.keys.add(e.code)
    if (e.code !== 'KeyF' && e.code !== 'Space') this.tween = null
    if (!fresh) return // key repeat must not re-fire a toggle
    if (e.code === 'Space') this.onPick?.()
    if (e.code === 'KeyX') this.onClearSelection?.()
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }

  private onBlur = () => {
    this.keys.clear()
    this.buttons.clear()
  }
}
