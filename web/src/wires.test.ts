import { describe, expect, test } from 'vitest'
import { arcPoints, chordSag } from './wires'
import type { Vec3 } from './layout'

const R = 495
const len = (v: Vec3) => Math.hypot(v.x, v.y, v.z)

/** A point on a sphere of radius `r`, `deg` degrees round from the pole. */
const on = (r: number, deg: number): Vec3 => {
  const a = (deg * Math.PI) / 180
  return { x: r * Math.sin(a), y: r * Math.cos(a), z: 0 }
}

describe('chordSag', () => {
  test('a chord sinks below the surface it spans, more the longer it is', () => {
    expect(chordSag(R, 0)).toBeCloseTo(0, 9)
    expect(chordSag(R, 360)).toBeGreaterThan(chordSag(R, 80))
  })

  test('matches the L squared over 8R approximation for short chords', () => {
    for (const chord of [40, 80, 160]) {
      expect(chordSag(R, chord)).toBeCloseTo((chord * chord) / (8 * R), 1)
    }
  })

  test('half a sphere away, the chord passes through the middle', () => {
    expect(chordSag(R, 2 * R)).toBeCloseTo(R, 6)
  })
})

describe('arcPoints', () => {
  test('rides at a constant height above the surface, all the way along', () => {
    const points = arcPoints(on(R, 0), on(R, 21), 3, 8)
    for (const p of points) expect(len(p)).toBeCloseTo(R + 3, 6)
  })

  test('starts and ends over its endpoints', () => {
    const a = on(R, 0)
    const b = on(R, 21)
    const points = arcPoints(a, b, 3, 8)
    const first = points[0]
    const last = points[points.length - 1]
    // Same direction from the origin, just further out.
    expect(first.x / len(first)).toBeCloseTo(a.x / len(a), 9)
    expect(last.x / len(last)).toBeCloseTo(b.x / len(b), 9)
  })

  test('asked for n segments, gives n + 1 points', () => {
    expect(arcPoints(on(R, 0), on(R, 21), 3, 8)).toHaveLength(9)
    expect(arcPoints(on(R, 0), on(R, 21), 3, 1)).toHaveLength(2)
  })

  test('clears the ground where the straight line would not', () => {
    // The widest district on coder: a chord right across it sinks 33 units.
    const a = on(R, 0)
    const b = on(R, 41.6)
    const chord = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    expect(chordSag(R, chord)).toBeGreaterThan(30)

    // Every segment of the arc stays above the surface, including its middles.
    const points = arcPoints(a, b, 3, 8)
    for (let i = 1; i < points.length; i++) {
      const mid = {
        x: (points[i - 1].x + points[i].x) / 2,
        y: (points[i - 1].y + points[i].y) / 2,
        z: (points[i - 1].z + points[i].z) / 2,
      }
      expect(len(mid)).toBeGreaterThan(R)
    }
  })

  test('a negative lift runs under the surface, the same distance', () => {
    const a = on(R, 0)
    const b = on(R, 21)
    const over = arcPoints(a, b, 3, 8)
    const under = arcPoints(a, b, -3, 8)
    for (const p of under) expect(len(p)).toBeCloseTo(R - 3, 6)
    // Mirrored about the ground, so the pair straddles it evenly.
    for (let i = 0; i < over.length; i++) {
      expect(len(over[i]) - R).toBeCloseTo(R - len(under[i]), 6)
    }
  })

  test('an edge between two heights rises along its length', () => {
    const points = arcPoints(on(R, 0), on(R + 20, 21), 0, 4)
    expect(len(points[0])).toBeCloseTo(R, 6)
    expect(len(points[points.length - 1])).toBeCloseTo(R + 20, 6)
    expect(len(points[2])).toBeGreaterThan(len(points[1]))
  })

  test('two points in the same place are a line, not a division by zero', () => {
    const p = on(R, 7)
    const points = arcPoints(p, p, 3, 8)
    expect(points).toHaveLength(2)
    for (const q of points) expect(Number.isFinite(len(q))).toBe(true)
  })

  test('a point at the origin is left alone rather than normalised', () => {
    const zero = { x: 0, y: 0, z: 0 }
    expect(arcPoints(zero, on(R, 10), 3, 4)).toEqual([zero, on(R, 10)])
  })
})
