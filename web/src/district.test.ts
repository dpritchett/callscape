import { describe, expect, test } from 'vitest'
import { districtPanel, rankOccupants, type Occupant } from './district'

const o = (name: string, fanInPkgs: number, fanIn = fanInPkgs, fanOut = 0): Occupant => ({
  name,
  fanIn,
  fanInPkgs,
  fanOut,
})

const OCCUPANTS = [
  o('helper', 0, 0, 3),
  o('Write', 12, 40, 6),
  o('Read', 12, 9, 2),
  o('Close', 3, 3, 1),
]

describe('rankOccupants', () => {
  test('the most widely called first, since that is what a package is for', () => {
    expect(rankOccupants(OCCUPANTS).map((x) => x.name)).toEqual([
      'Write', // 12 packages, 40 calls
      'Read', // 12 packages, 9 calls
      'Close',
      'helper', // called by nobody outside
    ])
  })

  test('ties break on the name, so the list holds still while you fly', () => {
    const tied = [o('b', 4), o('c', 4), o('a', 4)]
    expect(rankOccupants(tied).map((x) => x.name)).toEqual(['a', 'b', 'c'])
    expect(rankOccupants([...tied].reverse()).map((x) => x.name)).toEqual(['a', 'b', 'c'])
  })

  test('does not disturb what it was given', () => {
    const before = OCCUPANTS.map((x) => x.name)
    rankOccupants(OCCUPANTS)
    expect(OCCUPANTS.map((x) => x.name)).toEqual(before)
  })
})

describe('districtPanel', () => {
  const view = { label: 'coderd/httpapi', pkg: 'm/coderd/httpapi', occupants: OCCUPANTS }

  test('names the district and lists what is in it', () => {
    const text = districtPanel(view)
    expect(text).toContain('coderd/httpapi')
    expect(text).toContain('m/coderd/httpapi')
    for (const x of OCCUPANTS) expect(text).toContain(x.name)
  })

  test('nothing in front of you is a sentence, not an empty panel', () => {
    expect(districtPanel(null)).toContain('nothing in front of you')
  })

  test('a symbol nobody outside calls says so rather than showing a zero', () => {
    const line = districtPanel(view).split('\n').find((l) => l.includes('helper'))
    expect(line).toContain('—')
    expect(line).toContain('out 3')
  })

  test('a long list is cut, and says what it is cutting', () => {
    const many = Array.from({ length: 40 }, (_, i) => o(`sym${i}`, i))
    const text = districtPanel({ ...view, occupants: many }, 5)
    expect(text).toContain('5 of 40')
    expect(text).toContain('sym39') // the most called survives the cut
    expect(text).not.toContain('sym0 ')
  })

  test('a short list is counted rather than cut', () => {
    expect(districtPanel(view)).toContain('4 symbols')
    expect(districtPanel({ ...view, occupants: [o('only', 1)] })).toContain('1 symbol')
  })

  test('names line up, so the columns after them do too', () => {
    const cols = districtPanel(view)
      .split('\n')
      .filter((l) => l.includes(' in '))
      .map((l) => l.indexOf(' in '))
    expect(new Set(cols).size).toBe(1)
  })
})
