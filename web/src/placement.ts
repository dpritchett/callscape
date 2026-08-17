import type {
  EdgeShow,
  Graph,
  GraphNode,
  NodeField,
  ResolvedEdgeShow,
  ScaleKind,
  ViewSpec,
} from './types'
import { layout, type District, type Vec3 } from './layout'
import { placeBadge, type PlacedBadge } from './badge'
import { selectOccupants } from './select'

/** A symbol, placed and encoded. Everything the renderer needs, no three.js in it. */
export interface PlacedNode {
  id: string
  pkg: string
  name: string
  /** Centre of the building, which sits on the crust rather than above it. */
  x: number
  y: number
  z: number
  /** Unit normal at that point: the direction the building stands along. */
  nx: number
  ny: number
  nz: number
  size: number
  /** Total extent along the normal, half of it on each side of the ground. */
  height: number
  color: number
  /** Fan-in and fan-out across the whole graph, not just what survived the
   * occupant filter. Without these, a panel showing "in 0" for a symbol with
   * six callers is not a simplification, it is a wrong answer. */
  fanIn: number
  fanOut: number
  /** Distinct calling packages: what the panel should lead with. */
  fanInPkgs: number
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
  /** Where each symbol meets its district's plane, before being lifted. */
  seatOf: Map<string, Vec3>
  /** Radius of the shell the districts sit on. */
  shell: number
  /** How far the outermost district reaches, for framing. */
  extent: number
  /** Total symbols in the graph, before occupants filtered them. */
  total: number
  /** How many nodes were pulled in past the occupant filter by `reveal`. */
  revealed: number
  /** `auto` resolved against how many edges actually came out. */
  edgeShow: ResolvedEdgeShow
  /** Where the module's mark hangs, if its path can name one. May not exist on
   * disk — that is the renderer's problem, and a miss is a log line. */
  badge: PlacedBadge | null
}

/** Past this many drawn edges, showing them all is a hairball, not a picture. */
export const LEGIBLE_EDGES = 200

/** The sky's own radius, before a big graph pushes it outwards. */
export const STAR_RADIUS = 3200

/**
 * How far out the sky sits for a graph of this size.
 *
 * A floor rather than a plain multiple: a small graph should still be flying
 * against a distant sky rather than inside a snug little box. Lives here rather
 * than in `sky.ts` so that the stars, the badges and the camera's far plane are
 * all reading the same number instead of three copies of a 4.
 */
export function skyRadius(extent: number): number {
  return Math.max(STAR_RADIUS, extent * 4)
}

export function resolveEdgeShow(show: EdgeShow, drawn: number): ResolvedEdgeShow {
  if (show !== 'auto') return show
  return drawn > LEGIBLE_EDGES ? 'selected' : 'all'
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

  const sizeField = view.encoding.size
  // Districts are packed biggest-first by whatever the view sizes symbols by,
  // so each one has a middle worth flying to.
  const lay = layout(selected, (n) => numeric(n[sizeField]))

  const sizeOf = scaler(selected, sizeField, SIZE_RANGE[0], SIZE_RANGE[1], view.encoding.scale)
  const liftOf = scaler(selected, view.encoding.height, 0, MAX_LIFT, view.encoding.scale)
  const colorOf = colorer(selected, view.encoding.color)

  const nodes: PlacedNode[] = selected.map((n) => {
    const seat = lay.pos.get(n.id)!
    const size = sizeOf(n) * BASE
    // A building straddles the crust, protruding equally on both sides, so a
    // district looks the same whichever side of the shell you are on. Putting
    // it entirely on one face means the ground hides the contents from the
    // other, and there is no side that is right to choose.
    const height = Math.max(size, liftOf(n) * 2)
    const mag = Math.hypot(seat.x, seat.y, seat.z) || 1
    return {
      id: n.id,
      pkg: n.pkg,
      name: n.name,
      x: seat.x,
      y: seat.y,
      z: seat.z,
      // Local up, for standing the building on end.
      nx: seat.x / mag,
      ny: seat.y / mag,
      nz: seat.z / mag,
      size,
      height,
      color: colorOf(n),
      fanIn: n.fanIn,
      fanOut: n.fanOut,
      fanInPkgs: n.fanInPkgs,
    }
  })

  // Named against every package in the graph rather than only the ones that
  // survived the filter, so a label does not change under you when you edit the
  // view spec.
  const names = packageLabels(
    [...new Set(graph.nodes.map((n) => n.pkg))],
    graph.module,
  )
  const districts: PlacedDistrict[] = lay.districts.map((d, i) => ({
    ...d,
    label: names.get(d.pkg) ?? relPkg(d.pkg, graph.module),
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
    seatOf: lay.pos,
    shell: lay.shell,
    extent: lay.extent,
    total: graph.nodes.length,
    revealed: extra.length,
    edgeShow: resolveEdgeShow(view.edges.show, edges.length),
    badge: placeBadge(graph.module, skyRadius(lay.extent)),
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

/**
 * What to call each package on screen: the fewest trailing path segments that
 * no other package in the graph shares.
 *
 * This is compression, not truncation — the full path is one line down in the
 * district panel, and the short form is recoverable from it given the set. On
 * coder it takes the mean label from 2.4 lines to 1.2 and the mean length from
 * 20 characters to 11, and a label half the height is a label that fits twice
 * as often once declutter has had its say. It also lands on what a Go
 * programmer already calls these things: the code says `pubsub.New`, never
 * `database/pubsub.New`.
 *
 * Ambiguity is the thing being traded away, and only where it exists: the 58
 * packages on coder whose last segment is shared — every `proto`, every
 * `testutil` — keep as many segments as it takes to tell them apart.
 */
export function packageLabels(pkgs: string[], module: string): Map<string, string> {
  const rel = new Map(pkgs.map((p) => [p, relPkg(p, module)]))
  // How many packages could print a given string. Built over every suffix of
  // every path at once, so the answer does not depend on the input order.
  const claims = new Map<string, number>()
  for (const label of rel.values()) {
    const parts = label.split('/')
    for (let k = 1; k <= parts.length; k++) {
      const s = parts.slice(-k).join('/')
      claims.set(s, (claims.get(s) ?? 0) + 1)
    }
  }

  const out = new Map<string, string>()
  for (const [pkg, label] of rel) {
    const parts = label.split('/')
    let pick = label
    for (let k = 1; k <= parts.length; k++) {
      const s = parts.slice(-k).join('/')
      // A path that is itself the suffix of a longer one can never be alone —
      // `agent/proto` claims `proto` as hard as a package actually called
      // `proto` does. Falling through to the whole label keeps them distinct.
      if (claims.get(s) === 1) {
        pick = s
        break
      }
    }
    out.set(pkg, pick)
  }
  return out
}

/** District label: the package path with the module prefix taken off. */
function relPkg(pkg: string, module: string): string {
  if (module && pkg.startsWith(module + '/')) return pkg.slice(module.length + 1)
  if (pkg === module) return '.'
  const parts = pkg.split('/')
  return parts.slice(Math.max(0, parts.length - 2)).join('/')
}

/** Maps a node field onto [lo, hi]; non-numeric fields collapse to the low end. */
export function scaler(
  nodes: GraphNode[],
  field: NodeField,
  lo: number,
  hi: number,
  kind: ScaleKind = 'linear',
): (n: GraphNode) => number {
  const curve = curveFor(kind)
  let min = Infinity
  let max = -Infinity
  for (const n of nodes) {
    const v = curve(numeric(n[field]))
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min)) return () => lo
  const span = max - min || 1
  return (n) => lo + ((curve(numeric(n[field])) - min) / span) * (hi - lo)
}

function curveFor(kind: ScaleKind): (v: number) => number {
  if (kind === 'sqrt') return (v) => Math.sqrt(Math.max(0, v))
  if (kind === 'log') return (v) => Math.log1p(Math.max(0, v))
  return (v) => v
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
