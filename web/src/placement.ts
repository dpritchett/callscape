import type { Graph, GraphNode, NodeField, ViewSpec } from './types'
import { layout, type District } from './layout'
import { selectOccupants } from './select'

/** A symbol, placed and encoded. Everything the renderer needs, no three.js in it. */
export interface PlacedNode {
  id: string
  pkg: string
  name: string
  x: number
  y: number
  z: number
  size: number
  color: number
  /** Fan-in and fan-out across the whole graph, not just what survived the
   * occupant filter. Without these, a panel showing "in 0" for a symbol with
   * six callers is not a simplification, it is a wrong answer. */
  fanIn: number
  fanOut: number
}

export interface PlacedDistrict extends District {
  color: number
}

export interface PlacedEdge {
  from: string
  to: string
  /** true when the two ends live in different packages — the interesting ones. */
  cross: boolean
}

export interface Placement {
  nodes: PlacedNode[]
  districts: PlacedDistrict[]
  edges: PlacedEdge[]
  /** How far the outermost district reaches, for framing. */
  extent: number
  /** Total symbols in the graph, before occupants filtered them. */
  total: number
  /** How many nodes were pulled in past the occupant filter by `reveal`. */
  revealed: number
}

export const PALETTE = [
  0x7aa2f7, 0x9ece6a, 0xe0af68, 0xf7768e, 0xbb9af7, 0x7dcfff,
  0xff9e64, 0x73daca, 0xc0caf5, 0xd19a66, 0x56b6c2, 0xe06c75,
]

export const SIZE_RANGE = [0.55, 2.6] as const
export const MAX_LIFT = 26
const BASE = 2.2

/**
 * (graph, view) -> placed, encoded nodes. Pure: no three.js, no DOM, no clock,
 * no randomness. The same arguments always produce byte-identical output, which
 * is what makes a layout comparable to itself across runs.
 */
export function place(graph: Graph, view: ViewSpec, reveal: Iterable<string> = []): Placement {
  const kept = selectOccupants(graph.nodes, view)
  const extra = neighboursPastTheFilter(graph, kept, reveal)
  const selected = extra.length ? [...kept, ...extra] : kept
  const lay = layout(selected)

  const sizeOf = scaler(selected, view.encoding.size, SIZE_RANGE[0], SIZE_RANGE[1])
  const liftOf = scaler(selected, view.encoding.height, 0, MAX_LIFT)
  const colorOf = colorer(selected, view.encoding.color)

  const nodes: PlacedNode[] = selected.map((n) => {
    const ground = lay.pos.get(n.id)!
    const size = sizeOf(n) * BASE
    return {
      id: n.id,
      pkg: n.pkg,
      name: n.name,
      x: ground.x,
      y: liftOf(n) + size / 2, // sit the box on top of its lift, not through it
      z: ground.z,
      size,
      color: colorOf(n),
      fanIn: n.fanIn,
      fanOut: n.fanOut,
    }
  })

  const districts: PlacedDistrict[] = lay.districts.map((d, i) => ({
    ...d,
    label: relPkg(d.pkg, graph.module),
    color: PALETTE[i % PALETTE.length],
  }))

  const pkgOf = new Map(selected.map((n) => [n.id, n.pkg]))
  const edges: PlacedEdge[] = []
  for (const e of graph.edges) {
    const from = pkgOf.get(e.from)
    const to = pkgOf.get(e.to)
    if (from === undefined || to === undefined) continue // an end was filtered out
    edges.push({ from: e.from, to: e.to, cross: from !== to })
  }

  return {
    nodes,
    districts,
    edges,
    extent: lay.extent,
    total: graph.nodes.length,
    revealed: extra.length,
  }
}

/**
 * Nodes adjacent to `reveal` in the full graph that the occupant filter threw
 * away. Selecting a symbol and being told it has 12 callers while 8 are drawn
 * is only useful if you can then go and see the other 4.
 */
function neighboursPastTheFilter(
  graph: Graph,
  kept: GraphNode[],
  reveal: Iterable<string>,
): GraphNode[] {
  const anchors = new Set(reveal)
  if (anchors.size === 0) return []

  const present = new Set(kept.map((n) => n.id))
  const wanted = new Set<string>()
  for (const e of graph.edges) {
    if (anchors.has(e.from) && !present.has(e.to)) wanted.add(e.to)
    if (anchors.has(e.to) && !present.has(e.from)) wanted.add(e.from)
  }
  if (wanted.size === 0) return []
  return graph.nodes.filter((n) => wanted.has(n.id))
}

/** District label: the package path with the module prefix taken off. */
function relPkg(pkg: string, module: string): string {
  if (module && pkg.startsWith(module + '/')) return pkg.slice(module.length + 1)
  if (pkg === module) return '.'
  const parts = pkg.split('/')
  return parts.slice(Math.max(0, parts.length - 2)).join('/')
}

/** Maps a node field onto [lo, hi]; non-numeric fields collapse to the low end. */
export function scaler(nodes: GraphNode[], field: NodeField, lo: number, hi: number): (n: GraphNode) => number {
  let min = 0
  let max = 0
  for (const n of nodes) {
    const v = numeric(n[field])
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min || 1
  return (n) => lo + ((numeric(n[field]) - min) / span) * (hi - lo)
}

function numeric(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  return 0
}

/**
 * Categorical for string fields — one palette entry per distinct value, assigned
 * in sorted order so a package keeps its colour between runs. Numeric fields get
 * a cold-to-hot ramp instead.
 */
export function colorer(nodes: GraphNode[], field: NodeField): (n: GraphNode) => number {
  const sample = nodes.length ? nodes[0][field] : ''
  if (typeof sample === 'string') {
    const keys = [...new Set(nodes.map((n) => String(n[field])))].sort()
    const idx = new Map(keys.map((k, i) => [k, PALETTE[i % PALETTE.length]]))
    return (n) => idx.get(String(n[field])) ?? PALETTE[0]
  }
  const t = scaler(nodes, field, 0, 1)
  return (n) => lerpHex(0x3b6ea5, 0xffb454, t(n))
}

function lerpHex(a: number, b: number, t: number): number {
  const ch = (v: number, s: number) => (v >> s) & 0xff
  const mix = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t)
  return (mix(16) << 16) | (mix(8) << 8) | mix(0)
}
