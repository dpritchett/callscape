import { describe, expect, test } from 'vitest'
import { badgePath, placeBadge } from './badge'

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
