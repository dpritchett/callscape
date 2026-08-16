import type { Vec3 } from './layout'

/**
 * Edges that follow the crust instead of cutting under it.
 *
 * A straight line between two points on a sphere is a chord, and a chord sinks
 * below the surface it spans — about L²/8R for a length L. Across the widest
 * district on coder that is 33 units, well under the opaque ground, which is
 * why a district's own edges could only be seen from inside the shell. Lifting
 * the ends does not fix it: the sag grows with the square of the length, so
 * whatever constant clears the long ones leaves the short ones in the sky.
 *
 * An arc at a fixed height clears the ground by the same amount everywhere.
 *
 * A negative lift puts the arc under the ground instead, which is how an edge
 * straddles its district the way the buildings do: opaque ground has one side
 * each way, so a single arc is only ever visible from one of them.
 */

/**
 * Points along the surface from `a` to `b`, `lift` above it.
 *
 * The radius is taken from the ends, so an edge inside a district rides over
 * that district's own ground rather than over the bare shell — they are not
 * the same surface, and the difference is what buried the buildings.
 */
export function arcPoints(a: Vec3, b: Vec3, lift: number, segments: number): Vec3[] {
  const ra = length(a)
  const rb = length(b)
  if (ra === 0 || rb === 0) return [a, b]

  const ua = { x: a.x / ra, y: a.y / ra, z: a.z / ra }
  const ub = { x: b.x / rb, y: b.y / rb, z: b.z / rb }
  const dot = Math.min(1, Math.max(-1, ua.x * ub.x + ua.y * ub.y + ua.z * ub.z))
  const omega = Math.acos(dot)

  // Coincident, or as near as makes no difference: there is no arc to draw and
  // the slerp below would divide by zero.
  if (omega < 1e-6) return [out(ua, ra + lift), out(ub, rb + lift)]

  const n = Math.max(1, Math.floor(segments))
  const sin = Math.sin(omega)
  const points: Vec3[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const wa = Math.sin((1 - t) * omega) / sin
    const wb = Math.sin(t * omega) / sin
    const dir = {
      x: ua.x * wa + ub.x * wb,
      y: ua.y * wa + ub.y * wb,
      z: ua.z * wa + ub.z * wb,
    }
    points.push(out(normalise(dir), ra + (rb - ra) * t + lift))
  }
  return points
}

/** How far the middle of a chord falls below the surface it spans. */
export function chordSag(radius: number, chord: number): number {
  const half = Math.min(radius, chord / 2)
  return radius - Math.sqrt(Math.max(0, radius * radius - half * half))
}

function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z)
}

function normalise(v: Vec3): Vec3 {
  const l = length(v) || 1
  return { x: v.x / l, y: v.y / l, z: v.z / l }
}

function out(unit: Vec3, radius: number): Vec3 {
  return { x: unit.x * radius, y: unit.y * radius, z: unit.z * radius }
}
