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
  test('hangs the mark outside the crust', () => {
    const b = placeBadge('github.com/cli/cli/v2', 100)!
    expect(b.path).toBe('badges/github.com/cli.png')
    expect(Math.hypot(b.at.x, b.at.y, b.at.z)).toBeGreaterThan(100)
    expect(b.size).toBeGreaterThan(0)
  })

  test('the same module always hangs it in the same place', () => {
    expect(placeBadge('github.com/cli/cli/v2', 100)).toEqual(
      placeBadge('github.com/cli/cli/v2', 100),
    )
  })

  test('different modules go to different places', () => {
    const a = placeBadge('github.com/cli/cli/v2', 100)!
    const b = placeBadge('github.com/dpritchett/callscape', 100)!
    expect(a.at).not.toEqual(b.at)
  })

  test('a degenerate graph still puts it somewhere finite', () => {
    // One district lays out flat with a shell of 0, which is what a clone
    // flying the sample graph gets.
    const b = placeBadge('github.com/dpritchett/callscape', 0)!
    expect(Number.isFinite(b.at.x + b.at.y + b.at.z)).toBe(true)
    expect(b.size).toBeGreaterThan(0)
  })

  test('no badge for a module path that cannot name one', () => {
    expect(placeBadge('callscape', 100)).toBeNull()
  })
})
