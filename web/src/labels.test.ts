import { expect, test } from 'vitest'
import { labelWorldHeight } from './labels'

const FOV = 65
const VH = 900

/** How many pixels tall a label of `world` units renders at `distance`. */
const px = (world: number, distance: number) =>
  (world * VH) / (2 * Math.tan((FOV * Math.PI) / 360) * distance)

test('a label holds its pixel height as the camera pulls back', () => {
  // between the clamps, pixel height is flat — that is the whole point
  for (const d of [10, 40, 120]) {
    expect(px(labelWorldHeight(20, d, FOV, VH, 0, Infinity), d)).toBeCloseTo(20, 6)
  }
})

test("the district clamps do not bind anywhere you'd actually fly", () => {
  // 0.05..18 are the bounds world.ts passes for district labels; across the
  // scene's own scale they must not kick in, or labels balloon up close.
  for (const d of [5, 20, 60, 120, 400]) {
    expect(px(labelWorldHeight(20, d, FOV, VH, 0.05, 18), d)).toBeCloseTo(20, 6)
  }
})

test('scales with the requested pixel height', () => {
  expect(labelWorldHeight(26, 50, FOV, VH)).toBeCloseTo(2 * labelWorldHeight(13, 50, FOV, VH), 9)
})

test('clamps instead of filling the screen from far away', () => {
  expect(labelWorldHeight(20, 100_000, FOV, VH, 2, 18)).toBe(18)
  expect(labelWorldHeight(20, 0, FOV, VH, 2, 18)).toBe(2)
})

test('survives a zero-height viewport', () => {
  expect(labelWorldHeight(20, 50, FOV, 0, 2, 18)).toBe(2)
})
