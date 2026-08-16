import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import {
  BURN_SECONDS,
  DEFAULT_TUNING,
  deadzone,
  deadzone1,
  ease,
  flipFacing,
  speedScale,
  stepBurn,
  stepVelocity,
} from './motion'

const V = (x = 0, y = 0, z = 0) => ({ x, y, z })
const len = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z)

/** Runs the model for `seconds` at 60fps with a fixed input. */
function fly(dir: { x: number; y: number; z: number }, seconds: number, boosting = false) {
  let v = V()
  const dt = 1 / 60
  for (let t = 0; t < seconds; t += dt) v = stepVelocity(v, dir, dt, DEFAULT_TUNING, 1, boosting)
  return v
}

describe('velocity model', () => {
  test('accelerates toward a terminal speed rather than snapping to one', () => {
    const early = len(fly(V(0, 0, -1), 0.05))
    const cruise = len(fly(V(0, 0, -1), 5))
    expect(early).toBeLessThan(cruise / 2) // ramps up
    // terminal speed is accel / damping
    expect(cruise).toBeCloseTo(DEFAULT_TUNING.accel / DEFAULT_TUNING.damping, 0)
  })

  test('coasts to a stop instead of halting dead', () => {
    let v = fly(V(0, 0, -1), 5)
    const cruise = len(v)
    const dt = 1 / 60
    for (let t = 0; t < 0.1; t += dt) v = stepVelocity(v, V(), dt, DEFAULT_TUNING)
    const coasting = len(v)
    expect(coasting).toBeGreaterThan(cruise * 0.5) // still moving a tenth of a second later
    for (let t = 0; t < 3; t += dt) v = stepVelocity(v, V(), dt, DEFAULT_TUNING)
    expect(len(v)).toBeLessThan(0.5) // but stopped by three seconds
  })

  test('boost multiplies cruise speed, not acceleration alone', () => {
    expect(len(fly(V(0, 0, -1), 5, true))).toBeCloseTo(
      len(fly(V(0, 0, -1), 5)) * DEFAULT_TUNING.boost,
      0,
    )
  })

  test('a half-deflected stick accelerates half as hard', () => {
    expect(len(fly(V(0, 0, -0.5), 5))).toBeCloseTo(len(fly(V(0, 0, -1), 5)) / 2, 3)
  })

  test('frame rate does not change where you end up', () => {
    const run = (dt: number) => {
      let v = V()
      for (let t = 0; t < 2; t += dt) v = stepVelocity(v, V(0, 0, -1), dt, DEFAULT_TUNING)
      return len(v)
    }
    expect(run(1 / 144)).toBeCloseTo(run(1 / 30), 0)
  })
})

describe('speed scale', () => {
  test('slow up close, fast in open space, clamped at both ends', () => {
    expect(speedScale(0)).toBeCloseTo(0.55, 6)
    expect(speedScale(10_000)).toBeCloseTo(3, 6)
    expect(speedScale(200)).toBeGreaterThan(speedScale(60))
  })
})

test('ease is clamped and symmetric about its midpoint', () => {
  expect(ease(-1)).toBe(0)
  expect(ease(2)).toBe(1)
  expect(ease(0.5)).toBeCloseTo(0.5, 9)
  expect(ease(0.25) + ease(0.75)).toBeCloseTo(1, 9)
})

describe('analog deadzone', () => {
  test('ignores drift and starts from zero just outside the zone', () => {
    expect(deadzone(0.1, 0.05)).toEqual({ x: 0, y: 0 })
    const nudge = deadzone(0.13, 0)
    expect(nudge.x).toBeGreaterThan(0)
    expect(nudge.x).toBeLessThan(0.03) // no jump to 13% throttle
  })

  test('full deflection is full throttle, and diagonals are not faster', () => {
    const axis = deadzone(1, 0)
    const corner = deadzone(1, 1)
    expect(Math.hypot(axis.x, axis.y)).toBeCloseTo(1, 9)
    expect(Math.hypot(corner.x, corner.y)).toBeCloseTo(1, 9)
    expect(corner.x).toBeCloseTo(corner.y, 9)
  })

  test('preserves direction and sign', () => {
    const v = deadzone(-0.8, 0.4)
    expect(v.x).toBeLessThan(0)
    expect(v.y).toBeGreaterThan(0)
    expect(v.x / v.y).toBeCloseTo(-2, 9)
  })

  test('triggers use the same treatment on one axis', () => {
    expect(deadzone1(0.05)).toBe(0)
    expect(deadzone1(1)).toBeCloseTo(1, 9)
    expect(deadzone1(-1)).toBeCloseTo(-1, 9)
  })
})

describe('stepBurn', () => {
  /** Runs `seconds` of standing still at `fps`, from a standing start. */
  const rest = (seconds: number, fps = 60) => {
    let still = 0
    let expired = false
    const dt = 1 / fps
    for (let t = 0; t < seconds - 1e-9; t += dt) ({ still, expired } = stepBurn(still, false, dt))
    return { still, expired }
  }

  /** How much rest it actually took to put the burn out, at `fps`. */
  const untilOut = (fps: number) => {
    let still = 0
    const dt = 1 / fps
    for (let i = 0; i < 10_000; i++) {
      const step = stepBurn(still, false, dt)
      still = step.still
      if (step.expired) return still
    }
    return Infinity
  }

  test('moving holds the burn, however long you have been at it', () => {
    let still = 0
    for (let i = 0; i < 600; i++) ({ still } = stepBurn(still, true, 1 / 60))
    expect(still).toBe(0)
    expect(stepBurn(0, true, 10).expired).toBe(false)
  })

  // Not "expired at exactly 0.5s": real frame times accumulate float error, so
  // the honest contract is that it never goes out early and never lasts more
  // than one frame past the mark, whatever the frame rate.
  test('goes out half a second after you stop, at any frame rate', () => {
    for (const fps of [24, 60, 144]) {
      const out = untilOut(fps)
      expect(out).toBeGreaterThanOrEqual(BURN_SECONDS - 1e-9)
      expect(out).toBeLessThan(BURN_SECONDS + 1 / fps)
    }
  })

  test('and a moment less does not', () => {
    expect(rest(BURN_SECONDS - 0.05).expired).toBe(false)
    expect(rest(BURN_SECONDS - 0.1, 144).expired).toBe(false)
    expect(rest(BURN_SECONDS - 0.1, 24).expired).toBe(false)
  })

  test('one long frame counts for all of the time it took', () => {
    expect(stepBurn(0, false, 1).expired).toBe(true)
  })

  test('a touch of throttle resets the clock', () => {
    const almost = rest(BURN_SECONDS - 0.05)
    expect(stepBurn(almost.still, true, 1 / 60).still).toBe(0)
  })
})

// Checked against three.js rather than against itself. The formula is only
// right relative to a euler order and a camera's idea of forward, and getting
// the pitch sign wrong still passes any test that uses the same formula twice.
describe('flipFacing', () => {
  const facing = (yaw: number, pitch: number) => {
    const camera = new THREE.PerspectiveCamera()
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'))
    return camera.getWorldDirection(new THREE.Vector3())
  }

  test('reverses the view vector, whatever it was', () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [0.7, 0.3],
      [-2.1, -0.9],
      [3.0, 1.2],
      [Math.PI, -1.5],
    ]) {
      const flipped = flipFacing(yaw, pitch)
      const there = facing(yaw, pitch)
      const back = facing(flipped.yaw, flipped.pitch)
      // Exactly opposite: the two unit vectors sum to nothing.
      expect(there.clone().add(back).length()).toBeCloseTo(0, 9)
    }
  })

  test('twice is where you started', () => {
    const once = flipFacing(0.7, 0.3)
    const twice = flipFacing(once.yaw, once.pitch)
    const a = facing(0.7, 0.3)
    const b = facing(twice.yaw, twice.pitch)
    expect(a.distanceTo(b)).toBeCloseTo(0, 9)
  })

  test('looking down in front becomes looking up behind', () => {
    expect(facing(0, -0.5).y).toBeLessThan(0)
    const flipped = flipFacing(0, -0.5)
    expect(facing(flipped.yaw, flipped.pitch).y).toBeGreaterThan(0)
  })
})
