import type { GraphNode } from './types'

export interface District {
  pkg: string
  label: string
  x: number
  z: number
  radius: number
  count: number
}

export interface Layout {
  districts: District[]
  /** node id -> ground position */
  pos: Map<string, { x: number; z: number }>
  extent: number
}

const CELL = 7 // spacing between symbols inside a district
const PAD = 10 // gap between neighbouring districts
const MIN_RADIUS = 12

/**
 * Districts on the ground plane: one disc per package, laid out around a ring,
 * symbols in a stable grid inside. Pure function of the node set — the same
 * nodes always produce the same coordinates, so two runs can be compared.
 */
export function layout(nodes: GraphNode[]): Layout {
  const byPkg = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    const list = byPkg.get(n.pkg)
    if (list) list.push(n)
    else byPkg.set(n.pkg, [n])
  }

  // Alphabetical package order fixes the angular order. It is stable for a
  // given set of packages, which is what determinism needs here.
  const pkgs = [...byPkg.keys()].sort()

  const discs = pkgs.map((pkg) => {
    const members = byPkg.get(pkg)!
    const cols = Math.ceil(Math.sqrt(members.length))
    const rows = Math.ceil(members.length / cols)
    const half = Math.hypot(cols * CELL, rows * CELL) / 2
    return { pkg, members, cols, rows, radius: Math.max(MIN_RADIUS, half + CELL) }
  })

  const ring = ringRadius(discs.map((d) => d.radius))
  // Angular width each disc needs at that radius. Sizing by arc length instead
  // would let neighbours overlap, because the chord between two centres is
  // shorter than the arc between them.
  const widths = discs.map((d) => angularWidth(d.radius, ring))
  const span = widths.reduce((s, w) => s + w, 0)

  const districts: District[] = []
  const pos = new Map<string, { x: number; z: number }>()
  let walked = 0

  for (const [i, d] of discs.entries()) {
    // Any slack left over is shared out proportionally, which only pushes
    // districts further apart.
    const theta = span > 0 ? ((walked + widths[i] / 2) / span) * 2 * Math.PI : 0
    walked += widths[i]

    const cx = Math.cos(theta) * ring
    const cz = Math.sin(theta) * ring
    districts.push({
      pkg: d.pkg,
      label: shortPkg(d.pkg),
      x: cx,
      z: cz,
      radius: d.radius,
      count: d.members.length,
    })

    const members = [...d.members].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    members.forEach((n, i) => {
      const col = i % d.cols
      const row = Math.floor(i / d.cols)
      pos.set(n.id, {
        x: cx + (col - (d.cols - 1) / 2) * CELL,
        z: cz + (row - (d.rows - 1) / 2) * CELL,
      })
    })
  }

  const extent = districts.reduce((m, d) => Math.max(m, Math.hypot(d.x, d.z) + d.radius), MIN_RADIUS)
  return { districts, pos, extent }
}

/** Half-angle a disc of `radius` (plus its share of PAD) subtends at `ring`. */
function angularWidth(radius: number, ring: number): number {
  if (ring <= 0) return 0
  return 2 * Math.asin(Math.min(1, (radius + PAD / 2) / ring))
}

/**
 * Smallest ring radius on which every disc fits without its neighbours, found
 * by bisection. Deterministic: a fixed iteration count, no tolerance on time.
 */
function ringRadius(radii: number[]): number {
  if (radii.length <= 1) return 0
  const need = (r: number) => radii.reduce((s, x) => s + angularWidth(x, r), 0)

  let lo = Math.max(...radii) + PAD / 2 // below this a single disc cannot fit
  let hi = lo
  while (need(hi) > 2 * Math.PI) hi *= 2
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2
    if (need(mid) > 2 * Math.PI) lo = mid
    else hi = mid
  }
  return hi
}

/** `github.com/x/y/internal/gitlab` -> `internal/gitlab`. */
export function shortPkg(pkg: string): string {
  const parts = pkg.split('/')
  return parts.slice(Math.max(0, parts.length - 2)).join('/')
}
