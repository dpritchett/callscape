import { expect, test } from 'vitest'
import { parseView } from './view'

const OK = {
  occupants: { packages: ['*/internal/gitlab'], minFanIn: 1, limit: 60 },
  encoding: { size: 'fanIn', color: 'pkg', height: 'lines' },
  camera: { focus: 'x.Y', distance: 120 },
}

test('accepts the documented shape', () => {
  expect(parseView(OK)).toEqual(OK)
})

test('unknown fields are an error, not something to ignore', () => {
  expect(() => parseView({ ...OK, occupants: { ...OK.occupants, minFanin: 1 } })).toThrow(/unknown field/)
  expect(() => parseView({ ...OK, wat: 1 })).toThrow(/view.json.wat/)
})

test('rejects a field name that is not on a node', () => {
  expect(() => parseView({ ...OK, encoding: { ...OK.encoding, color: 'colour' } })).toThrow(/encoding.color/)
})

test('rejects wrong types and reports every problem at once', () => {
  const err = String(
    (() => {
      try {
        parseView({ ...OK, occupants: { packages: 'nope', minFanIn: 'lots', limit: 60 } })
      } catch (e) {
        return e
      }
    })(),
  )
  expect(err).toMatch(/occupants.packages/)
  expect(err).toMatch(/occupants.minFanIn/)
})

test('a missing section is an error', () => {
  const { camera, ...rest } = OK
  void camera
  expect(() => parseView(rest)).toThrow(/camera: missing/)
})
