import { describe, expect, test } from 'vitest'
import { LEGIBLE_EDGES, place, resolveEdgeShow } from './placement'
import { globToRegExp } from './select'
import { parseView } from './view'
import type { Graph, GraphNode, ViewSpec } from './types'

const M = 'example.com/mod'

function node(pkg: string, name: string, fanIn: number, lines: number): GraphNode {
  return {
    id: `${pkg}.${name}`,
    name,
    pkg,
    file: `${pkg.split('/').pop()}/f.go`,
    line: 1,
    lines,
    exported: name[0] === name[0].toUpperCase(),
    fanIn,
    fanOut: 0,
  }
}

// Hand-written fixture: three packages worth keeping, one that no pattern
// should ever match.
const GRAPH: Graph = {
  module: M,
  nodes: [
    node(`${M}/internal/gitlab`, 'Client.Get', 12, 30),
    node(`${M}/internal/gitlab`, 'Client.Post', 4, 90),
    node(`${M}/internal/gitlab`, 'helper', 0, 5),
    node(`${M}/cmd/glk`, 'main', 1, 12),
    node(`${M}/cmd/glk`, 'runList', 7, 40),
    node(`${M}/internal/format`, 'Rows', 8, 20),
    node(`${M}/vendorish`, 'Untouched', 99, 99),
  ],
  edges: [
    { from: `${M}/cmd/glk.runList`, to: `${M}/internal/gitlab.Client.Get` }, // cross
    { from: `${M}/internal/gitlab.Client.Post`, to: `${M}/internal/gitlab.helper` }, // intra
    { from: `${M}/vendorish.Untouched`, to: `${M}/internal/gitlab.Client.Get` }, // dropped end
  ],
}

const BASE_VIEW = {
  occupants: { packages: ['*/internal/gitlab', '*/cmd/*'], minFanIn: 0, limit: 100 },
  encoding: { size: 'fanIn', color: 'pkg', height: 'lines' },
  camera: { focus: null, distance: 120 },
}

function view(patch: Partial<Record<keyof typeof BASE_VIEW, unknown>> = {}): ViewSpec {
  return parseView({ ...BASE_VIEW, ...patch })
}

const ids = (v: ViewSpec) => place(GRAPH, v).nodes.map((n) => n.id)

describe('glob matching over package paths', () => {
  test('* spans path separators', () => {
    expect(globToRegExp('*/internal/gitlab').test(`${M}/internal/gitlab`)).toBe(true)
    expect(globToRegExp('*/cmd/*').test(`${M}/cmd/glk`)).toBe(true)
    expect(globToRegExp('*/internal/gitlab').test(`${M}/internal/gitlabber`)).toBe(false)
  })

  test('runs of * collapse, so a typo cannot build a backtracking regex', () => {
    expect(globToRegExp('***/cmd/**').source).toBe(globToRegExp('*/cmd/*').source)
    expect(globToRegExp('***/cmd/**').test(`${M}/cmd/glk`)).toBe(true)
    // a long near-miss must not hang: no match, and no exponential backtrack
    expect(globToRegExp('*'.repeat(30) + 'x').test('a'.repeat(4000))).toBe(false)
  })

  test('dots are literal, not wildcards', () => {
    expect(globToRegExp('example.com/*').test('example.com/mod')).toBe(true)
    expect(globToRegExp('example.com/*').test('exampleXcom/mod')).toBe(false)
  })

  test('only matching packages are placed', () => {
    const pkgs = new Set(place(GRAPH, view()).nodes.map((n) => n.pkg))
    expect([...pkgs].sort()).toEqual([`${M}/cmd/glk`, `${M}/internal/gitlab`])
  })

  test('an empty pattern list places nothing', () => {
    expect(ids(view({ occupants: { ...BASE_VIEW.occupants, packages: [] } }))).toEqual([])
  })
})

describe('minFanIn', () => {
  test('drops symbols below the threshold', () => {
    expect(ids(view({ occupants: { ...BASE_VIEW.occupants, minFanIn: 5 } })).sort()).toEqual([
      `${M}/cmd/glk.runList`,
      `${M}/internal/gitlab.Client.Get`,
    ])
  })

  test('is inclusive at the boundary', () => {
    const got = ids(view({ occupants: { ...BASE_VIEW.occupants, minFanIn: 4 } }))
    expect(got).toContain(`${M}/internal/gitlab.Client.Post`) // fanIn === 4
  })
})

describe('limit keeps the top N by encoding.size', () => {
  test('ranks by fanIn when size is fanIn', () => {
    expect(ids(view({ occupants: { ...BASE_VIEW.occupants, limit: 3 } }))).toEqual([
      `${M}/internal/gitlab.Client.Get`, // 12
      `${M}/cmd/glk.runList`, // 7
      `${M}/internal/gitlab.Client.Post`, // 4
    ])
  })

  test('ranks by lines when size is lines', () => {
    expect(
      ids(view({
        occupants: { ...BASE_VIEW.occupants, limit: 2 },
        encoding: { ...BASE_VIEW.encoding, size: 'lines' },
      })),
    ).toEqual([
      `${M}/internal/gitlab.Client.Post`, // 90
      `${M}/cmd/glk.runList`, // 40
    ])
  })

  test('a limit above the population keeps everything', () => {
    expect(ids(view({ occupants: { ...BASE_VIEW.occupants, limit: 999 } })).length).toBe(5)
  })
})

describe('district assignment', () => {
  const p = place(GRAPH, view())

  test('one district per package, with member counts', () => {
    expect(p.districts.map((d) => [d.pkg, d.count])).toEqual([
      [`${M}/cmd/glk`, 2],
      [`${M}/internal/gitlab`, 3],
    ])
    expect(p.districts.map((d) => d.label)).toEqual(['cmd/glk', 'internal/gitlab'])
  })

  test('every symbol sits inside its own district disc', () => {
    const byPkg = new Map(p.districts.map((d) => [d.pkg, d]))
    for (const n of p.nodes) {
      const d = byPkg.get(n.pkg)!
      expect(Math.hypot(n.x - d.x, n.z - d.z)).toBeLessThanOrEqual(d.radius)
    }
  })

  test('districts do not overlap', () => {
    for (const a of p.districts) {
      for (const b of p.districts) {
        if (a === b) continue
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(a.radius + b.radius)
      }
    }
  })

  test('edges keep only pairs that survived, and flag the crossings', () => {
    expect(p.edges).toEqual([
      { from: `${M}/cmd/glk.runList`, to: `${M}/internal/gitlab.Client.Get`, cross: true },
      { from: `${M}/internal/gitlab.Client.Post`, to: `${M}/internal/gitlab.helper`, cross: false },
    ])
  })

  test('carries whole-graph fan-in through, not just what survived filtering', () => {
    const get = p.nodes.find((n) => n.name === 'Client.Get')!
    expect(get.fanIn).toBe(12) // 12 in the graph, only 1 of them drawn here
    expect(p.edges.filter((e) => e.to === get.id).length).toBe(1)
  })

  test('encoding lifts and sizes, and a package keeps one colour', () => {
    const gitlab = p.nodes.filter((n) => n.pkg === `${M}/internal/gitlab`)
    expect(new Set(gitlab.map((n) => n.color)).size).toBe(1)
    expect(new Set(p.nodes.map((n) => n.color)).size).toBe(2)

    const post = p.nodes.find((n) => n.name === 'Client.Post')! // most lines
    const helper = p.nodes.find((n) => n.name === 'helper')!
    expect(post.y).toBeGreaterThan(helper.y)

    const get = p.nodes.find((n) => n.name === 'Client.Get')! // most fanIn
    expect(get.size).toBeGreaterThan(helper.size)
  })
})

describe('determinism', () => {
  test('same input twice is byte-identical', () => {
    expect(JSON.stringify(place(GRAPH, view()))).toBe(JSON.stringify(place(GRAPH, view())))
  })

  test('input order does not move anything', () => {
    const shuffled: Graph = {
      module: GRAPH.module,
      nodes: [...GRAPH.nodes].reverse(),
      edges: [...GRAPH.edges].reverse(),
    }
    const a = place(GRAPH, view())
    const b = place(shuffled, view())
    expect(JSON.stringify(b.nodes)).toBe(JSON.stringify(a.nodes))
    expect(JSON.stringify(b.districts)).toBe(JSON.stringify(a.districts))
    // edges follow the graph's own order, so compare them as sets
    expect([...b.edges].sort(byKey)).toEqual([...a.edges].sort(byKey))
  })

  test('a symbol keeps its spot when an unrelated package joins the view', () => {
    const wide = view({ occupants: { ...BASE_VIEW.occupants, packages: ['*/internal/gitlab'] } })
    const one = place(GRAPH, wide).nodes.find((n) => n.name === 'Client.Get')!
    const relative = place(GRAPH, view()).nodes.find((n) => n.name === 'Client.Get')!
    const district = place(GRAPH, view()).districts.find((d) => d.pkg === `${M}/internal/gitlab`)!
    // absolute position moves with the ring, but the offset within the district
    // holds (to float precision — the centre came out of a sin/cos)
    expect(relative.x - district.x).toBeCloseTo(one.x, 9)
    expect(relative.z - district.z).toBeCloseTo(one.z, 9)
    expect(relative.y).toBe(one.y)
  })
})

const byKey = (a: { from: string; to: string }, b: { from: string; to: string }) =>
  `${a.from}->${a.to}` < `${b.from}->${b.to}` ? -1 : 1

describe('reveal', () => {
  // vendorish.Untouched calls internal/gitlab.Client.Get but no pattern matches
  // its package, so it is normally invisible.
  const anchor = `${M}/internal/gitlab.Client.Get`

  test('is off unless asked for', () => {
    const p = place(GRAPH, view())
    expect(p.revealed).toBe(0)
    expect(p.nodes.some((n) => n.pkg === `${M}/vendorish`)).toBe(false)
  })

  test('pulls a filtered-out caller in, and says how many', () => {
    const p = place(GRAPH, view(), [anchor])
    expect(p.revealed).toBe(1)
    expect(p.nodes.find((n) => n.name === 'Untouched')).toBeTruthy()
    expect(p.edges).toContainEqual({ from: `${M}/vendorish.Untouched`, to: anchor, cross: true })
  })

  test('gives the newcomer its own district', () => {
    const p = place(GRAPH, view(), [anchor])
    expect(p.districts.map((d) => d.pkg)).toContain(`${M}/vendorish`)
  })

  test('revealing something with no hidden neighbours changes nothing', () => {
    const before = place(GRAPH, view())
    const after = place(GRAPH, view(), [`${M}/internal/format.Rows`])
    expect(after.revealed).toBe(0)
    expect(JSON.stringify(after.nodes)).toBe(JSON.stringify(before.nodes))
  })

  test('stays deterministic with reveal on', () => {
    expect(JSON.stringify(place(GRAPH, view(), [anchor]))).toBe(
      JSON.stringify(place(GRAPH, view(), [anchor])),
    )
  })
})

describe('edge display policy', () => {
  test('auto keeps every edge while that is still legible', () => {
    expect(resolveEdgeShow('auto', 0)).toBe('all')
    expect(resolveEdgeShow('auto', LEGIBLE_EDGES)).toBe('all')
  })

  test('auto falls back to selection-only once it would be a hairball', () => {
    expect(resolveEdgeShow('auto', LEGIBLE_EDGES + 1)).toBe('selected')
    expect(resolveEdgeShow('auto', 2344)).toBe('selected') // helm
  })

  test('an explicit choice is never overridden', () => {
    for (const show of ['all', 'cross', 'selected', 'none'] as const) {
      expect(resolveEdgeShow(show, 99_999)).toBe(show)
    }
  })

  test('place resolves it against the edges it actually drew', () => {
    expect(place(GRAPH, view()).edgeShow).toBe('all') // fixture has 2
  })
})
