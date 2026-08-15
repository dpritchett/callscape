import * as THREE from 'three'

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

export class FlyController implements Controller {
  private keys = new Set<string>()
  private euler = new THREE.Euler(0, 0, 0, 'YXZ')
  private locked = false
  private speed = 34
  private sensitivity = 0.0022

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    this.euler.setFromQuaternion(camera.quaternion)
    dom.addEventListener('click', this.onClick)
    document.addEventListener('pointerlockchange', this.onLockChange)
    document.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  update(dt: number) {
    const k = this.keys
    const forward = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0)
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
    const rise = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0)
    if (!forward && !strafe && !rise) return

    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1
    const step = this.speed * boost * dt

    const dir = new THREE.Vector3()
    this.camera.getWorldDirection(dir)
    const right = new THREE.Vector3().crossVectors(dir, this.camera.up).normalize()

    this.camera.position.addScaledVector(dir, forward * step)
    this.camera.position.addScaledVector(right, strafe * step)
    this.camera.position.y += rise * step
  }

  frame(target: THREE.Vector3, distance: number) {
    // Approach from the side and slightly above: looking straight down at a
    // flat district tells you nothing.
    const dir = new THREE.Vector3(0.55, 0.42, 0.72).normalize()
    this.camera.position.copy(target).addScaledVector(dir, distance)
    this.camera.lookAt(target)
    this.euler.setFromQuaternion(this.camera.quaternion)
  }

  dispose() {
    this.dom.removeEventListener('click', this.onClick)
    document.removeEventListener('pointerlockchange', this.onLockChange)
    document.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
  }

  private onClick = () => {
    if (!this.locked) this.dom.requestPointerLock()
  }

  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.dom
    if (!this.locked) this.keys.clear()
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return
    this.euler.y -= e.movementX * this.sensitivity
    this.euler.x -= e.movementY * this.sensitivity
    this.euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.euler.x))
    this.camera.quaternion.setFromEuler(this.euler)
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code)
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }

  private onBlur = () => this.keys.clear()
}
