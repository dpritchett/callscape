import { describe, expect, test } from 'vitest'
import { edgeKey, neighborhood, toggle } from './selection'
import type { PlacedEdge } from './placement'

//  a -> b -> c
//  d -> b
//  e -> f        (unrelated to b)
const EDGES: PlacedEdge[] = [
  { from: 'a', to: 'b', cross: true },
  { from: 'b', to: 'c', cross: false },
  { from: 'd', to: 'b', cross: true },
  { from: 'e', to: 'f', cross: false },
]

describe('neighborhood', () => {
  test('splits callers from callees around the selection', () => {
    const n = neighborhood(EDGES, ['b'])
    expect([...n.callers].sort()).toEqual(['a', 'd'])
    expect([...n.callees]).toEqual(['c'])
    expect([...n.related].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  test('tags each edge by which side it sits on', () => {
    const n = neighborhood(EDGES, ['b'])
    expect(n.role.get(edgeKey('a', 'b'))).toBe('in')
    expect(n.role.get(edgeKey('d', 'b'))).toBe('in')
    expect(n.role.get(edgeKey('b', 'c'))).toBe('out')
    expect(n.role.get(edgeKey('e', 'f'))).toBe('none')
  })

  test('an empty selection lights nothing, and says so', () => {
    const n = neighborhood(EDGES, [])
    expect(n.empty).toBe(true)
    expect(n.related.size).toBe(0)
    expect(n.role.size).toBe(0)
  })

  test('multi-select unions the neighbourhoods', () => {
    const n = neighborhood(EDGES, ['b', 'e'])
    expect([...n.callees].sort()).toEqual(['c', 'f'])
    expect(n.role.get(edgeKey('e', 'f'))).toBe('out')
  })

  test('an edge between two selected nodes is internal, not in or out', () => {
    const n = neighborhood(EDGES, ['b', 'c'])
    expect(n.role.get(edgeKey('b', 'c'))).toBe('internal')
    expect(n.callees.has('c')).toBe(false) // already selected, not a neighbour
    expect(n.callers.has('b')).toBe(false)
  })

  test('selecting something with no edges still counts as a selection', () => {
    const n = neighborhood(EDGES, ['zzz'])
    expect(n.empty).toBe(false)
    expect(n.related.size).toBe(1)
  })
})

describe('toggle', () => {
  test('adds then removes', () => {
    const once = toggle([], 'a')
    expect([...once]).toEqual(['a'])
    expect([...toggle(once, 'a')]).toEqual([])
  })

  test('leaves the rest of the selection alone', () => {
    expect([...toggle(['a', 'b'], 'c')].sort()).toEqual(['a', 'b', 'c'])
    expect([...toggle(['a', 'b'], 'a')]).toEqual(['b'])
  })
})
