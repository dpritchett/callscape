/**
 * The movement model, kept separate from the input plumbing so it can be
 * tested without a camera, a mouse, or a clock.
 *
 * Velocity-based rather than position-based: input accelerates, and letting go
 * coasts to a stop instead of snapping. That single change is most of what
 * makes flying feel like flying rather than like nudging a cursor.
 */

export interface MotionTuning {
  /** Units per second squared, before boost and scale. */
  accel: number
  /** Exponential decay per second. Terminal speed is accel / damping. */
  damping: number
  /** Multiplier while the boost key is held. */
  boost: number
}

export const DEFAULT_TUNING: MotionTuning = {
  accel: 320,
  damping: 4.5, // ~71 u/s cruise, ~250 boosted, against a ~225-unit-wide scene
  boost: 3.5,
}

/**
 * Advances a velocity by one frame. `dir` is the desired direction in world
 * space and need not be normalised — its length is the throttle, so an analog
 * stick at half deflection accelerates half as hard.
 */
export function stepVelocity(
  vel: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  dt: number,
  tuning: MotionTuning,
  scale = 1,
  boosting = false,
): { x: number; y: number; z: number } {
  const accel = tuning.accel * scale * (boosting ? tuning.boost : 1)
  // Exact solution of dv/dt = a - kv over the step, rather than an Euler step.
  // Euler makes terminal speed depend on the frame rate — you cruise measurably
  // slower at 30fps than at 144 — which is the kind of thing that reads as the
  // controls being mushy on a bad day.
  const decay = Math.exp(-tuning.damping * dt)
  const gain = ((1 - decay) * accel) / tuning.damping
  return {
    x: vel.x * decay + dir.x * gain,
    y: vel.y * decay + dir.y * gain,
    z: vel.z * decay + dir.z * gain,
  }
}

/**
 * Move fast when there is nothing nearby, precise when close to something.
 * Without this, one speed is either sluggish across the map or uncontrollable
 * inside a district.
 */
export function speedScale(distanceToContent: number, near = 40, far = 400): number {
  const t = (distanceToContent - near) / (far - near)
  return 0.55 + 2.45 * Math.min(1, Math.max(0, t))
}

/**
 * Radial deadzone for an analog stick. Rescales so the usable range starts at
 * zero just outside the deadzone — otherwise the stick jumps to `dz` worth of
 * throttle the instant it registers — and clamps the diagonal, which would
 * otherwise reach 1.41 and make corners faster than the axes.
 */
export function deadzone(x: number, y: number, dz = 0.12): { x: number; y: number } {
  const mag = Math.hypot(x, y)
  if (mag <= dz) return { x: 0, y: 0 }
  const scaled = Math.min(1, (mag - dz) / (1 - dz))
  return { x: (x / mag) * scaled, y: (y / mag) * scaled }
}

/** One-dimensional deadzone, for triggers and single axes. */
export function deadzone1(v: number, dz = 0.12): number {
  const mag = Math.abs(v)
  if (mag <= dz) return 0
  return Math.sign(v) * Math.min(1, (mag - dz) / (1 - dz))
}

/** Seconds at rest before a burn puts itself out. */
export const BURN_SECONDS = 0.5

/**
 * Burn is a sprint, not a mode. Holding the throttle is what it is for, so it
 * expires once you have actually come to rest rather than leaving you fast the
 * next time you nudge a key, having forgotten you turned it on.
 *
 * Takes the time already spent at rest and returns the new total, plus whether
 * that is long enough. Frame-rate independent, because it accumulates seconds
 * rather than counting frames.
 */
export function stepBurn(
  still: number,
  moving: boolean,
  dt: number,
  seconds = BURN_SECONDS,
): { still: number; expired: boolean } {
  const next = moving ? 0 : still + dt
  return { still: next, expired: next >= seconds }
}

/** Smoothstep-eased 0..1 progress, for the focus tween. */
export function ease(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}
