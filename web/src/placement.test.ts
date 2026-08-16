import { describe, expect, test } from 'vitest'
import { LEGIBLE_EDGES, place, resolveEdgeShow } from './placement'
import { globToRegExp } from './select'
import { parseView } from './view'
import type { Graph, GraphNode, ViewSpec } from './types'

const M = 'example.com/mod'

function node(pkg: string, name: string, fanIn: number, lines: number, generated = false): GraphNode {
  return {
    id: `${pkg}.${name}`,
    name,
    pkg,
    file: `${pkg.split('/').pop()}/f.go`,
    line: 1,
    lines,
    exported: name[0] === name[0].toUpperCase(),
    generated,
    fanIn,
    fanOut: 0,
    fanInPkgs: fanIn > 0 ? 1 : 0,
    fanOutPkgs: 0,
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
      const seat = p.seatOf.get(n.id)! // where it meets the plane, before lifting
      expect(dist(seat, d.centre)).toBeLessThanOrEqual(d.radius)
    }
  })

  test('symbols lift towards the middle of the shell, not away from it', () => {
    for (const n of p.nodes) {
      const seat = p.seatOf.get(n.id)!
      // the lifted position is closer to the origin than its seat
      expect(Math.hypot(n.x, n.y, n.z)).toBeLessThanOrEqual(Math.hypot(seat.x, seat.y, seat.z))
    }
  })

  test('districts do not overlap, in three dimensions', () => {
    for (const a of p.districts) {
      for (const b of p.districts) {
        if (a === b) continue
        expect(dist(a.centre, b.centre)).toBeGreaterThan(a.radius + b.radius)
      }
    }
  })

  test('every district sits on the shell, facing outwards', () => {
    for (const d of p.districts) {
      expect(Math.hypot(d.centre.x, d.centre.y, d.centre.z)).toBeCloseTo(p.shell, 6)
      expect(Math.hypot(d.normal.x, d.normal.y, d.normal.z)).toBeCloseTo(1, 9)
      // the in-plane basis is perpendicular to the normal and to itself
      expect(dot(d.u, d.normal)).toBeCloseTo(0, 9)
      expect(dot(d.v, d.normal)).toBeCloseTo(0, 9)
      expect(dot(d.u, d.v)).toBeCloseTo(0, 9)
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

    // Height is now a lift off the district's plane along its normal, so it is
    // a distance from the seat rather than a y coordinate.
    const lift = (name: string) => {
      const n = p.nodes.find((x) => x.name === name)!
      return dist(n, p.seatOf.get(n.id)!)
    }
    expect(lift('Client.Post')).toBeGreaterThan(lift('helper')) // 90 lines vs 5

    const get = p.nodes.find((n) => n.name === 'Client.Get')! // most fanIn
    expect(get.size).toBeGreaterThan(p.nodes.find((n) => n.name === 'helper')!.size)
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

  test('a symbol keeps its seat within its district when another package joins', () => {
    // A district moves and turns when the set of packages changes, so the
    // invariant is its position in the district's own frame, not in the world's.
    const local = (v: ViewSpec) => {
      const p = place(GRAPH, v)
      const d = p.districts.find((x) => x.pkg === `${M}/internal/gitlab`)!
      const seat = p.seatOf.get(`${M}/internal/gitlab.Client.Get`)!
      const rel = { x: seat.x - d.centre.x, y: seat.y - d.centre.y, z: seat.z - d.centre.z }
      return { u: dot(rel, d.u), v: dot(rel, d.v) }
    }
    // Projecting onto the shell compresses distance from the district's centre,
    // and the shell resizes when a package joins — so what is preserved is the
    // seat's bearing within its own district, not its distance from the middle.
    const alone = local(view({ occupants: { ...BASE_VIEW.occupants, packages: ['*/internal/gitlab'] } }))
    const crowded = local(view())
    expect(Math.atan2(crowded.v, crowded.u)).toBeCloseTo(Math.atan2(alone.v, alone.u), 9)
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

type V = { x: number; y: number; z: number }
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y + a.z * b.z
const dist = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

describe('district interior', () => {
  // Three files of very different sizes, which is what a real package looks
  // like and what makes a district's interior irregular.
  const many: Graph = {
    module: M,
    nodes: Array.from({ length: 60 }, (_, i) => {
      const n = node(`${M}/internal/gitlab`, `f${String(i).padStart(2, '0')}`, i, 10 + i)
      n.file = i < 40 ? 'gitlab/client.go' : i < 55 ? 'gitlab/cache.go' : 'gitlab/util.go'
      return n
    }),
    edges: [],
  }
  const GRAPH_FILE = new Map(many.nodes.map((n) => [n.id, n.file]))
  const p = place(many, view({ occupants: { packages: ['*'], minFanIn: 0, limit: 0 } }))
  const d = p.districts[0]
  const radial = (id: string) => {
    const s = p.seatOf.get(id)!
    return Math.hypot(s.x - d.centre.x, s.y - d.centre.y, s.z - d.centre.z)
  }

  test('symbols fill the disc rather than a square inside it', () => {
    const rs = p.nodes.map((n) => radial(n.id))
    // the outermost symbol is near the rim, not at 70% of it like a grid corner
    expect(Math.max(...rs) / d.radius).toBeGreaterThan(0.8)
    // and the interior is populated, not just a ring
    const inner = rs.filter((r) => r < d.radius / 2).length
    expect(inner).toBeGreaterThan(p.nodes.length / 5)
  })

  test('the biggest file claims the middle of the district', () => {
    // Symbols cluster by file now, so the district's centre belongs to the
    // largest block rather than to whichever single symbol ranks highest.
    const inMiddle = p.nodes
      .filter((n) => radial(n.id) < d.radius / 3)
      .map((n) => GRAPH_FILE.get(n.id))
    expect(new Set(inMiddle).size).toBe(1)
    expect(inMiddle[0]).toBe('gitlab/client.go') // 40 of the 60
  })

  test('log scaling separates the crowded low end that linear flattens', () => {
    const spread = (scale: 'linear' | 'log') => {
      const q = place(many, view({ encoding: { ...BASE_VIEW.encoding, scale } , occupants: { packages: ['*'], minFanIn: 0, limit: 0 } }))
      const small = q.nodes.filter((n) => n.fanIn <= 5).map((n) => n.size)
      return Math.max(...small) - Math.min(...small)
    }
    expect(spread('log')).toBeGreaterThan(spread('linear') * 3)
  })
})

describe('generated code', () => {
  const mixed: Graph = {
    module: M,
    nodes: [
      node(`${M}/api`, 'Handwritten', 3, 40),
      node(`${M}/api`, 'AlsoHandwritten', 1, 20),
      node(`${M}/api`, 'queryStore.Get', 2, 8, true),
      node(`${M}/api`, 'queryStore.Put', 2, 8, true),
    ],
    edges: [],
  }
  const occ = { packages: ['*'], minFanIn: 0, limit: 0 }
  const names = (generated: string) =>
    place(mixed, view({ occupants: { ...occ, generated } })).nodes.map((n) => n.name).sort()

  test('included by default', () => {
    expect(place(mixed, view({ occupants: occ })).nodes).toHaveLength(4)
  })

  test('exclude leaves only what a person wrote', () => {
    expect(names('exclude')).toEqual(['AlsoHandwritten', 'Handwritten'])
  })

  test('only shows the generated half on its own', () => {
    expect(names('only')).toEqual(['queryStore.Get', 'queryStore.Put'])
  })

  test('an unknown setting is an error rather than a silent default', () => {
    expect(() => view({ occupants: { ...occ, generated: 'sometimes' } })).toThrow(
      /occupants.generated/,
    )
  })
})

describe('files cluster inside a district', () => {
  const withFiles: Graph = {
    module: M,
    nodes: Array.from({ length: 45 }, (_, i) => {
      const n = node(`${M}/pkg`, `sym${String(i).padStart(2, '0')}`, i % 7, 10 + i)
      n.file = `pkg/${['a', 'b', 'c'][i % 3]}.go`
      return n
    }),
    edges: [],
  }
  const p = place(withFiles, view({ occupants: { packages: ['*'], minFanIn: 0, limit: 0 } }))
  const seat = (id: string) => p.seatOf.get(id)!
  const spread = (nodes: typeof p.nodes) => {
    let sum = 0
    let pairs = 0
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        sum += dist(seat(nodes[i].id), seat(nodes[j].id))
        pairs++
      }
    return sum / pairs
  }

  test('same-file symbols sit closer together than the district average', () => {
    // place() returns nodes ranked, not in input order, so group by the file
    // recorded on the source graph rather than by index.
    const fileOf = new Map(withFiles.nodes.map((n) => [n.id, n.file]))
    const overall = spread(p.nodes)
    for (const file of ['pkg/a.go', 'pkg/b.go', 'pkg/c.go']) {
      const group = p.nodes.filter((n) => fileOf.get(n.id) === file)
      expect(group.length).toBe(15)
      expect(spread(group)).toBeLessThan(overall * 0.75)
    }
  })

  test('the interior is not a single spiral: neighbour spacing varies', () => {
    // A pure sunflower puts every symbol at almost exactly the same distance
    // from its nearest neighbour. Blocks plus jitter should not.
    const nearest = p.nodes.map((n) => {
      let best = Infinity
      for (const m of p.nodes) {
        if (m.id === n.id) continue
        best = Math.min(best, dist(seat(n.id), seat(m.id)))
      }
      return best
    })
    const mean = nearest.reduce((s, d) => s + d, 0) / nearest.length
    const sd = Math.sqrt(nearest.reduce((s, d) => s + (d - mean) ** 2, 0) / nearest.length)
    expect(sd / mean).toBeGreaterThan(0.15)
  })

  test('still byte-identical run to run', () => {
    expect(JSON.stringify(place(withFiles, view({ occupants: { packages: ['*'], minFanIn: 0, limit: 0 } })))).toBe(
      JSON.stringify(p),
    )
  })
})
