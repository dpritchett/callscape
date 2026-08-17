import { describe, expect, test } from 'vitest'
import { badgePath, bearingToBadge, placeBadge, repoLabel } from './badge'
import type { Vec3 } from './layout'

describe('bearingToBadge', () => {
  const badge = placeBadge('github.com/cli/cli/v2', 3200)!
  const origin = { x: 0, y: 0, z: 0 }

  /** Where the chosen mark ends up relative to the bearing, in degrees. */
  const offAxis = (dir: Vec3, target: Vec3) => {
    const angles = badge.at.map((p) => {
      const to = { x: p.x - target.x, y: p.y - target.y, z: p.z - target.z }
      const len = Math.hypot(to.x, to.y, to.z)
      const dot = (to.x * dir.x + to.y * dir.y + to.z * dir.z) / len
      return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI
    })
    return Math.min(...angles)
  }

  test('puts a mark beside the view rather than dead ahead of it', () => {
    // Dead ahead means behind whatever you are looking at, and the graph then
    // hides it. Off to the side means both are in frame.
    for (const prefer of [
      { x: 0, y: 0, z: -1 },
      { x: 0.9, y: 0.1, z: 0 },
      { x: -0.55, y: -0.42, z: -0.72 },
    ]) {
      const angle = offAxis(bearingToBadge(badge, origin, prefer), origin)
      expect(angle).toBeGreaterThan(25)
      expect(angle).toBeLessThan(40)
    }
  })

  test('turns away from the mark nearest the bearing it was going to use', () => {
    // Still recognisably the bearing that was asked for: the mark it chose is
    // the one that was closest, so the camera has not swung to the far side.
    const prefer = { x: 0.9, y: 0.1, z: 0 }
    const dir = bearingToBadge(badge, origin, prefer)
    expect(dir.x).toBeGreaterThan(0.5)
  })

  test('the answer is a direction, whatever the target', () => {
    const dir = bearingToBadge(badge, { x: 200, y: -50, z: 90 }, { x: -0.55, y: -0.42, z: -0.72 })
    expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1)
  })

  test('the opening shot is the same shot every time', () => {
    const prefer = { x: -0.55, y: -0.42, z: -0.72 }
    const target = { x: 120, y: 60, z: -200 }
    expect(bearingToBadge(badge, target, prefer)).toEqual(bearingToBadge(badge, target, prefer))
  })

  test('a target sitting on a mark does not divide by zero', () => {
    const on = badge.at[0]
    const dir = bearingToBadge(badge, on, { x: 1, y: 0, z: 0 })
    expect(Number.isFinite(dir.x + dir.y + dir.z)).toBe(true)
  })
})

describe('repoLabel', () => {
  test('drops the Go major-version suffix, which is not part of the repo', () => {
    expect(repoLabel('github.com/cli/cli/v2')).toBe('github.com/cli/cli')
    expect(repoLabel('example.com/a/b/v12')).toBe('example.com/a/b')
  })

  test('leaves alone anything that only looks like one', () => {
    expect(repoLabel('github.com/dpritchett/callscape')).toBe('github.com/dpritchett/callscape')
    expect(repoLabel('github.com/some/v')).toBe('github.com/some/v')
    expect(repoLabel('github.com/some/version')).toBe('github.com/some/version')
    expect(repoLabel('github.com/some/v0')).toBe('github.com/some/v0')
  })
})

describe('badgePath', () => {
  test('names a file from the host and owner', () => {
    expect(badgePath('github.com/cli/cli/v2')).toBe('badges/github.com/cli.png')
    expect(badgePath('github.com/dpritchett/callscape')).toBe('badges/github.com/dpritchett.png')
    expect(badgePath('golang.org/x/tools')).toBe('badges/golang.org/x.png')
  })

  test('a module path that cannot name a forge gets nothing', () => {
    expect(badgePath('callscape')).toBeNull() // no owner
    expect(badgePath('example/thing')).toBeNull() // a host has a dot in it
    expect(badgePath('')).toBeNull()
  })

  test('refuses to let a module path build a path of its own', () => {
    // The module path comes out of whatever repo was dumped, so it is input.
    expect(badgePath('../../etc/passwd')).toBeNull()
    expect(badgePath('github.com/../../secrets')).toBeNull()
    expect(badgePath('github.com/.ssh')).toBeNull()
    expect(badgePath('git hub.com/cli')).toBeNull()
  })
})

describe('placeBadge', () => {
  test('one mark at each cardinal point, all on the sphere it was given', () => {
    const b = placeBadge('github.com/cli/cli/v2', 3200)!
    expect(b.path).toBe('badges/github.com/cli.png')
    expect(b.label).toBe('github.com/cli/cli')
    expect(b.at).toHaveLength(6)
    // On the sky, not somewhere in the middle distance: every one of them is
    // exactly the radius out.
    for (const p of b.at) expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(3200)
    expect(b.size).toBeGreaterThan(0)
  })

  test('the mark is the same slice of sky whatever the graph size', () => {
    const near = placeBadge('github.com/cli/cli/v2', 3200)!
    const far = placeBadge('github.com/cli/cli/v2', 6400)!
    // Size over distance is the angle it covers, and that is what stays fixed.
    expect(far.size / 6400).toBeCloseTo(near.size / 3200)
  })

  test('the six points are the six axis directions, no two the same', () => {
    const b = placeBadge('github.com/cli/cli/v2', 100)!
    // Each sits on exactly one axis: two of its three coordinates are zero.
    for (const p of b.at) {
      expect([p.x, p.y, p.z].filter((v) => v === 0)).toHaveLength(2)
    }
    expect(new Set(b.at.map((p) => `${p.x},${p.y},${p.z}`)).size).toBe(6)
  })

  test('the same module always hangs them in the same places', () => {
    expect(placeBadge('github.com/cli/cli/v2', 100)).toEqual(
      placeBadge('github.com/cli/cli/v2', 100),
    )
  })

  test('a degenerate graph still puts them somewhere finite', () => {
    // One district lays out flat with a shell of 0, which is what a clone
    // flying the sample graph gets.
    const b = placeBadge('github.com/dpritchett/callscape', 0)!
    for (const p of b.at) expect(Number.isFinite(p.x + p.y + p.z)).toBe(true)
    expect(b.size).toBeGreaterThan(0)
  })

  test('no badge for a module path that cannot name one', () => {
    expect(placeBadge('callscape', 100)).toBeNull()
  })
})
