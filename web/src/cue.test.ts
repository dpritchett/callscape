import { describe, expect, test } from 'vitest'
import { movesTheView, type Cue } from './cue'

describe('movesTheView', () => {
  test('anything that changes the scene takes the wheel', () => {
    const cues: Cue[] = [
      { seq: 1, focus: 'pkg.Symbol' },
      { seq: 1, distance: 400 },
      { seq: 1, yaw: 90 },
      { seq: 1, pitch: 20 },
      { seq: 1, select: [] },
      { seq: 1, reveal: false },
      { seq: 1, clear: true },
      { seq: 1, pick: true },
      { seq: 1, flip: true },
      { seq: 1, panel: 'source' },
      { seq: 1, labels: 'off' },
      { seq: 1, search: '' },
    ]
    for (const cue of cues) expect(movesTheView(cue)).toBe(true)
  })

  test('bookkeeping on its own does not', () => {
    // A bare cue, and the two ways of talking about the wheel itself: none of
    // these should grab it as a side effect of being sent.
    expect(movesTheView({ seq: 3 })).toBe(false)
    expect(movesTheView({ seq: 3, hold: true })).toBe(false)
    expect(movesTheView({ seq: 3, hold: false })).toBe(false)
  })

  test('a field explicitly left out is not a change', () => {
    expect(movesTheView({ seq: 3, focus: undefined })).toBe(false)
  })

  test('clearing the focus is a change, since null means something', () => {
    expect(movesTheView({ seq: 3, focus: null })).toBe(true)
  })
})
