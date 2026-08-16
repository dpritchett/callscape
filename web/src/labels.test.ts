import { expect, test } from 'vitest'
import { Vector3 } from 'three'
import {
  axisAnchor,
  fadeOpacity,
  fadePresence,
  frustumEdgeCosine,
  labelRank,
  labelWorldHeight,
  setLabelHeight,
} from './labels'

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

test('the frustum corner is further off-axis than the top edge', () => {
  const edge = frustumEdgeCosine(FOV, 16 / 9)
  // vertical half-FOV is 32.5 degrees; the corner of a wide window is well past it
  expect(Math.acos(edge) * (180 / Math.PI)).toBeGreaterThan(32.5)
  // and a wider window pushes it further out still
  expect(frustumEdgeCosine(FOV, 21 / 9)).toBeLessThan(edge)
})

test('a name on the reticle ranks as its plain distance', () => {
  const edge = frustumEdgeCosine(FOV, 16 / 9)
  expect(labelRank(40, 1, edge)).toBeCloseTo(40, 9)
})

test('a name at the edge of the screen has to be much closer to win', () => {
  const edge = frustumEdgeCosine(FOV, 16 / 9)
  // default weight 2.5: the corner pays 3.5x
  expect(labelRank(40, edge, edge)).toBeCloseTo(140, 9)
  // so the one at the reticle wins from three times as far away
  expect(labelRank(120, 1, edge)).toBeLessThan(labelRank(40, edge, edge))
})

test('the penalty saturates outside the frustum instead of running away', () => {
  const edge = frustumEdgeCosine(FOV, 16 / 9)
  // pinned neighbours are labelled even when behind you; they must still rank
  // against each other by distance rather than all collapsing to Infinity
  expect(labelRank(40, -1, edge)).toBeCloseTo(140, 9)
  expect(labelRank(80, -1, edge)).toBeCloseTo(280, 9)
})

test('a label arrives and leaves in about a fifth of a second', () => {
  const frame = 1 / 60
  let p = 0
  let frames = 0
  while (p < 1) {
    p = fadePresence(p, 1, frame)
    frames++
  }
  expect(frames).toBeGreaterThan(6) // not a blink
  expect(frames).toBeLessThan(20) // not a swim
  // and it comes back down the same way
  while (p > 0) p = fadePresence(p, 0, frame)
  expect(p).toBe(0)
})

test('a fade never overshoots what was asked for', () => {
  expect(fadePresence(0.9, 1, 1)).toBe(1)
  expect(fadePresence(0.1, 0, 1)).toBe(0)
  // the shutter passes a whole second to settle everything for a still
  expect(fadePresence(0, 1, 1)).toBe(1)
})

test('a stalled frame does not run the fade backwards', () => {
  expect(fadePresence(0.5, 1, -1)).toBe(0.5)
})

test('the fade leaves and arrives gently', () => {
  expect(fadeOpacity(0)).toBe(0)
  expect(fadeOpacity(1)).toBe(1)
  expect(fadeOpacity(0.5)).toBeCloseTo(0.5, 9)
  // eased, so the first tenth of the way in is barely a tenth as visible
  expect(fadeOpacity(0.1)).toBeLessThan(0.05)
  expect(fadeOpacity(2)).toBe(1) // clamped, not extrapolated
})

// eye at the origin looking down -Z, the way a camera does
const EYE = new Vector3(0, 0, 0)
const DIR = new Vector3(0, 0, -1)

test('a wide district hangs its name where the view axis crosses it', () => {
  const out = new Vector3()
  // centre 60 to the right, 100 ahead; the axis is 60 away and the district is
  // wide enough to reach it
  axisAnchor(new Vector3(60, 0, -100), EYE, DIR, 80, out)
  expect(out.x).toBeCloseTo(0, 6)
  expect(out.z).toBeCloseTo(-100, 6)
})

test('a name never wanders off its own ground', () => {
  const out = new Vector3()
  axisAnchor(new Vector3(300, 0, -100), EYE, DIR, 80, out)
  // 300 out with only 80 of slack: it walks 80 and stops
  expect(out.x).toBeCloseTo(220, 6)
})

test('a district behind the camera is left where it is', () => {
  const out = new Vector3()
  const centre = new Vector3(60, 0, 100)
  axisAnchor(centre, EYE, DIR, 80, out)
  expect(out.equals(centre)).toBe(true)
})

test('a district already on the axis does not move', () => {
  const out = new Vector3()
  axisAnchor(new Vector3(0, 0, -100), EYE, DIR, 80, out)
  expect(out.x).toBeCloseTo(0, 6)
  expect(out.y).toBeCloseTo(0, 6)
  expect(out.z).toBeCloseTo(-100, 6)
})

test('a label is sized by its line of text, not by its padded canvas', () => {
  const sprite = {
    userData: { aspect: 4, perLine: 3.33 },
    scale: { set(x: number, y: number) { (this as unknown as {x:number;y:number}).x = x; (this as unknown as {x:number;y:number}).y = y } },
  } as unknown as Parameters<typeof setLabelHeight>[0]
  setLabelHeight(sprite, 10)
  // three lines of text means the sprite has to be 3.33x taller for each line
  // to come out at the requested height
  expect((sprite.scale as unknown as { y: number }).y).toBeCloseTo(33.3, 6)
  expect((sprite.scale as unknown as { x: number }).x).toBeCloseTo(133.2, 6)
})
