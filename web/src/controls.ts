import * as THREE from 'three'
import { DEFAULT_TUNING, ease, speedScale, stepVelocity, type MotionTuning } from './motion'

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

    const k = this.keys
    // Held mouse buttons drive the same axis as W and S, so the mouse alone is
    // enough to get around.
    const forward =
      (k.has('KeyW') || this.buttons.has(0) ? 1 : 0) - (k.has('KeyS') || this.buttons.has(2) ? 1 : 0)
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
    const rise = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0)

    this.input.set(0, 0, 0)
    if (forward) this.input.addScaledVector(this.dir, forward)
    if (strafe) this.input.addScaledVector(this.right, strafe)
    if (rise) this.input.y += rise

    const boosting = k.has('ShiftLeft') || k.has('ShiftRight')
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

  private stepTween(dt: number) {
    const tw = this.tween!
    tw.t += dt / FOCUS_SECONDS
    this.camera.position.lerpVectors(tw.from, tw.to, ease(tw.t))
    this.camera.lookAt(tw.look)
    this.euler.setFromQuaternion(this.camera.quaternion)
    if (tw.t >= 1) this.tween = null
  }

  private onMouseDown = (e: MouseEvent) => {
    if (!this.locked) {
      // The click that captures the mouse must not also lurch us forward, so
      // it is spent on the lock and nothing else.
      this.dom.requestPointerLock()
      return
    }
    this.buttons.add(e.button)
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
    this.keys.add(e.code)
    if (e.code !== 'KeyF') this.tween = null
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }

  private onBlur = () => {
    this.keys.clear()
    this.buttons.clear()
  }
}
