import { expect, test } from 'vitest'
import { parseView } from './view'

const OK = {
  occupants: { packages: ['*/internal/gitlab'], minFanIn: 1, limit: 60 },
  encoding: { size: 'fanIn', color: 'pkg', height: 'lines' },
  camera: { focus: 'x.Y', distance: 120 },
}

test('accepts the documented shape, filling in the optional blocks', () => {
  expect(parseView(OK)).toEqual({
    ...OK,
    occupants: { ...OK.occupants, generated: 'include' },
    encoding: { ...OK.encoding, scale: 'log' },
    select: [],
    edges: { show: 'auto', opacity: 0.7 },
    sound: { enabled: true, volume: 0.8 },
  })
})

test('sound block is optional and validated', () => {
  expect(parseView({ ...OK, sound: { enabled: false } }).sound).toEqual({
    enabled: false,
    volume: 0.8,
  })
  expect(parseView({ ...OK, sound: { volume: 0 } }).sound.volume).toBe(0)
  expect(() => parseView({ ...OK, sound: { enabled: 'yes' } })).toThrow(/sound.enabled/)
  expect(() => parseView({ ...OK, sound: { loud: true } })).toThrow(/unknown field/)
})

test('scale is optional, log by default, and validated', () => {
  expect(parseView({ ...OK, encoding: { ...OK.encoding, scale: 'sqrt' } }).encoding.scale).toBe('sqrt')
  expect(() => parseView({ ...OK, encoding: { ...OK.encoding, scale: 'loglog' } })).toThrow(
    /encoding.scale/,
  )
})

test('edges block is optional and validated', () => {
  expect(parseView({ ...OK, edges: { show: 'none' } }).edges).toEqual({ show: 'none', opacity: 0.7 })
  expect(() => parseView({ ...OK, edges: { show: 'sometimes' } })).toThrow(/edges.show/)
  expect(() => parseView({ ...OK, edges: { shown: 'all' } })).toThrow(/unknown field/)
})

test('select is optional, and empty means "do not touch the selection"', () => {
  expect(parseView(OK).select).toEqual([])
  expect(parseView({ ...OK, select: ['x.Y'] }).select).toEqual(['x.Y'])
  expect(() => parseView({ ...OK, select: 'x.Y' })).toThrow(/select/)
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
