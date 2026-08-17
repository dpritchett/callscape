import { expect, test } from 'vitest'
import {
  aimedOnly,
  cycleMode,
  LABEL_MODES,
  namesDistricts,
  namesSymbols,
  ribbon,
  RIBBON,
  type LabelMode,
} from './labelmode'

test('the ribbon and the mode list are the same ring in the same order', () => {
  // the ribbon's index is what a click maps back to, so a mismatch would set
  // the mode next to the one that was pressed
  expect(RIBBON.map((r) => r.mode)).toEqual([...LABEL_MODES])
})

test('stepping wraps in both directions', () => {
  expect(cycleMode('all', 1)).toBe('pkg')
  expect(cycleMode('off', 1)).toBe('all')
  expect(cycleMode('all', -1)).toBe('off')
  expect(cycleMode('pkg', -1)).toBe('all')
})

test('a full turn of the ring comes back to where it started', () => {
  let m: LabelMode = LABEL_MODES[0]
  for (let i = 0; i < LABEL_MODES.length; i++) m = cycleMode(m, 1)
  expect(m).toBe(LABEL_MODES[0])
})

test('a step of any size lands somewhere real', () => {
  for (const step of [-13, -5, -1, 0, 1, 7, 12]) {
    expect(LABEL_MODES).toContain(cycleMode('fn', step))
  }
})

test('each mode names what it says on the tin', () => {
  expect([namesDistricts('all'), namesSymbols('all')]).toEqual([true, true])
  expect([namesDistricts('pkg'), namesSymbols('pkg')]).toEqual([true, false])
  expect([namesDistricts('fn'), namesSymbols('fn')]).toEqual([false, true])
  expect([namesDistricts('off'), namesSymbols('off')]).toEqual([false, false])
})

test('aim names both kinds, but only for one district', () => {
  expect([namesDistricts('aim'), namesSymbols('aim')]).toEqual([true, true])
  expect(aimedOnly('aim')).toBe(true)
  for (const m of LABEL_MODES.filter((m) => m !== 'aim')) expect(aimedOnly(m)).toBe(false)
})

test('exactly one chip is lit, whichever mode it is', () => {
  for (const mode of LABEL_MODES) {
    expect(ribbon(mode).filter((r) => r.active)).toHaveLength(1)
  }
})

test('every chip carries a glyph and something to hover', () => {
  for (const r of ribbon('all')) {
    expect(r.glyph.length).toBeGreaterThan(0)
    expect(r.title.length).toBeGreaterThan(0)
  }
})
