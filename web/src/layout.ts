import type { GraphNode } from './types'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface District {
  pkg: string
  label: string
  /** Centre of the district's disc, on the shell. */
  centre: Vec3
  /** Unit normal, pointing away from the middle of the sphere. */
  normal: Vec3
  /** In-plane basis, so symbols can be laid out in a flat grid. */
  u: Vec3
  v: Vec3
  radius: number
  /** Angular radius of the district's cap on the shell, in radians. */
  cap: number
  count: number
}

export interface Layout {
  districts: District[]
  /** node id -> position on its district's plane (before any lift) */
  pos: Map<string, Vec3>
  /** Radius of the shell the districts sit on. */
  shell: number
  /** Furthest any content reaches from the origin. */
  extent: number
}

const CELL = 7 // spacing between symbols inside a district
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)) // 137.5°, the sunflower turn
const PAD = 10 // gap between neighbouring districts
const MIN_RADIUS = 12

/**
 * Districts on the surface of a sphere: a crust, with the symbols of each
 * package on a disc tangent to it. Everything is deterministic from the node
 * set — same nodes, same coordinates, every time.
 *
 * A single ring put 69 packages on a circle 700 units across, most of it empty,
 * with the whole vertical axis unused. A shell of the same content is about a
 * fifth the size, and every district is the same distance from the middle
 * rather than fifty times further than its neighbour.
 */
export function layout(nodes: GraphNode[], rank: (n: GraphNode) => number = () => 0): Layout {
  const byPkg = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    const list = byPkg.get(n.pkg)
    if (list) list.push(n)
    else byPkg.set(n.pkg, [n])
  }

  // Alphabetical order fixes which district goes where. For Go paths that also
  // groups relatives — pkg/chart/v2 lands next to pkg/chart/v3 — which is a
  // free approximation of hierarchy.
  const pkgs = [...byPkg.keys()].sort()

  const discs = pkgs.map((pkg) => {
    const members = byPkg.get(pkg)!
    const blocks = blocksOf(members, rank)
    // The district has to hold its blocks, which are themselves discs. Start
    // from the area they need and grow until the packing actually succeeds —
    // an estimate alone is not enough, because greedy packing puts the first
    // block in the middle, which is exactly wrong for three equal ones.
    const area = blocks.reduce((s, b) => s + b.radius * b.radius, 0)
    let radius = Math.max(MIN_RADIUS, Math.sqrt(area / 0.62) + CELL * 0.5)
    let seats = seatBlocks(blocks, radius)
    for (let tries = 0; !seats && tries < 60; tries++) {
      radius *= 1.08
      seats = seatBlocks(blocks, radius)
    }
    const placed = seats ?? seatBlocks(blocks, radius, true)!
    // Packing had to search inside a generous bound; the district only has to
    // contain what actually landed. Shrinking to that keeps the rim from being
    // the empty margin the square grid used to leave.
    const reach = placed.reduce((m, s) => Math.max(m, Math.hypot(s.du, s.dv)), 0)
    return {
      pkg,
      members,
      blocks,
      radius: Math.max(MIN_RADIUS, reach + CELL * 0.9),
      seats: placed,
    }
  })

  const radii = discs.map((d) => d.radius)
  const shell = shellRadius(radii)
  const seats = packOnShell(radii, shell) ?? radii.map(() => ({ phi: Math.PI / 2, psi: 0 }))

  const districts: District[] = []
  const pos = new Map<string, Vec3>()

  discs.forEach((d, i) => {
    const { phi, psi } = seats[i]
    const normal = onSphere(phi, psi)
    const centre = scale(normal, shell)
    const { u, v } = basis(normal)

    districts.push({
      pkg: d.pkg,
      label: shortPkg(d.pkg),
      centre,
      normal,
      u,
      v,
      radius: d.radius,
      cap: shell > 0 ? Math.asin(Math.min(1, d.radius / shell)) : Math.PI / 2,
      count: d.members.length,
    })

    // Blocks are files, packed as discs inside the district and placed
    // biggest-first so the district still has a middle worth flying to.
    d.seats.forEach(({ n, du, dv }) => {
      // Lay the grid out on the tangent plane, then push it onto the sphere, so
      // symbols sit on the curve of the crust rather than on a flat card
      // floating above it. With a single district there is no sphere to push
      // onto — the shell has no radius — so the plane is the answer.
      const tangent = {
        x: centre.x + u.x * du + v.x * dv,
        y: centre.y + u.y * du + v.y * dv,
        z: centre.z + u.z * du + v.z * dv,
      }
      pos.set(n.id, shell > 0 ? scale(normalise(tangent), shell) : tangent)
    })
  })

  const extent = districts.reduce((m, d) => Math.max(m, shell + d.radius), MIN_RADIUS)
  return { districts, pos, shell, extent }
}

interface Block {
  file: string
  members: GraphNode[]
  radius: number
}

/**
 * A district's members grouped by the file they live in. Files are what make a
 * package's interior irregular in a way that means something: a package with
 * one 400-line file and six small ones should not look like a package with
 * seven even ones.
 */
function blocksOf(members: GraphNode[], rank: (n: GraphNode) => number): Block[] {
  const byFile = new Map<string, GraphNode[]>()
  for (const n of members) {
    const list = byFile.get(n.file)
    if (list) list.push(n)
    else byFile.set(n.file, [n])
  }

  const blocks = [...byFile.entries()].map(([file, list]) => ({
    file,
    members: list.sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return rb - ra
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    }),
    radius: CELL * (0.62 * Math.sqrt(list.length) + 0.85),
  }))

  // Biggest block first: it claims the middle, and greedy packing works better
  // when the awkward shapes go down first.
  blocks.sort((a, b) => {
    if (a.members.length !== b.members.length) return b.members.length - a.members.length
    return a.file < b.file ? -1 : 1
  })
  return blocks
}

/**
 * Places each block inside the district, then each symbol inside its block.
 *
 * Blocks go down greedily along a spiral, taking the first spot that clears
 * everything already placed. Within a block, symbols sit in a jittered
 * sunflower — the jitter is hashed from the symbol's own id, so it is stable
 * across runs while breaking up the spiral arms that made a district look like
 * a mandala.
 */
function seatBlocks(
  blocks: Block[],
  radius: number,
  force = false,
): { n: GraphNode; du: number; dv: number }[] | null {
  const placed: { x: number; y: number; r: number }[] = []
  const out: { n: GraphNode; du: number; dv: number }[] = []

  for (const block of blocks) {
    const spot = findSpot(block.radius, radius, placed)
    if (!spot && !force) return null // caller grows the district and retries
    const at = spot ?? rimFallback(block.radius, radius, placed.length)
    placed.push({ x: at.x, y: at.y, r: block.radius })

    const inner = Math.max(0, block.radius - CELL * 0.8)
    block.members.forEach((n, i) => {
      const jr = hash01(`${n.id}#r`) - 0.5
      const jt = hash01(`${n.id}#t`) - 0.5
      const rr = inner * Math.sqrt((i + 0.5) / block.members.length) * (1 + jr * 0.35)
      const theta = i * GOLDEN_ANGLE + jt * 0.9
      out.push({
        n,
        du: at.x + rr * Math.cos(theta),
        dv: at.y + rr * Math.sin(theta),
      })
    })
  }
  return out
}

/**
 * First point on an outward spiral where a disc of `r` clears everything
 * already placed, or null if there is nowhere inside `bound`.
 *
 * Only the first block gets the middle, and only because there is nothing to
 * clear yet — for three equal blocks the centre is the one place none of them
 * should be, which is why the caller grows the district rather than trusting an
 * area estimate.
 */
function findSpot(
  r: number,
  bound: number,
  placed: { x: number; y: number; r: number }[],
): { x: number; y: number } | null {
  if (!placed.length) return { x: 0, y: 0 }
  const step = Math.max(0.5, r * 0.25)
  for (let k = 1; k < 6000; k++) {
    const t = k * GOLDEN_ANGLE
    const rad = step * Math.sqrt(k)
    if (rad + r > bound) return null
    const x = rad * Math.cos(t)
    const y = rad * Math.sin(t)
    if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + CELL * 0.25)) {
      return { x, y }
    }
  }
  return null
}

/** Last resort when growing did not help: ring the rim rather than overlap. */
function rimFallback(r: number, bound: number, index: number): { x: number; y: number } {
  const t = index * GOLDEN_ANGLE
  const rad = Math.max(0, bound - r)
  return { x: rad * Math.cos(t), y: rad * Math.sin(t) }
}

/** Stable hash of a string into [0,1). Deterministic jitter, not randomness. */
function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

function onSphere(phi: number, psi: number): Vec3 {
  return {
    x: Math.sin(phi) * Math.cos(psi),
    y: Math.cos(phi),
    z: Math.sin(phi) * Math.sin(psi),
  }
}

function scale(v: Vec3, k: number): Vec3 {
  return { x: v.x * k, y: v.y * k, z: v.z * k }
}

/**
 * Two perpendicular in-plane directions for a disc with the given normal.
 * Deterministic, including at the poles where the usual up vector degenerates.
 */
function basis(n: Vec3): { u: Vec3; v: Vec3 } {
  const seed = Math.abs(n.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
  const u = normalise(cross(seed, n))
  const v = cross(n, u)
  return { u, v }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function normalise(v: Vec3): Vec3 {
  const m = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / m, y: v.y / m, z: v.z / m }
}

/**
 * Packs discs onto a sphere in latitude bands, the way the ring version packed
 * them around a circle. Bands handle wildly different district sizes, which a
 * uniform lattice does not: helm has a 213-symbol package next to a 2-symbol
 * one, and spacing everything for the biggest wastes the whole shell.
 *
 * Returns null when they do not fit at this radius.
 */
function packOnShell(radii: number[], shell: number): { phi: number; psi: number }[] | null {
  if (radii.length === 0) return []
  if (radii.length === 1) return [{ phi: Math.PI / 2, psi: 0 }]

  const angular = (r: number) => Math.asin(Math.min(1, (r + PAD / 2) / shell))
  const seats: { phi: number; psi: number }[] = []

  /** Which discs fit in one band at this latitude, and how wide each sits. */
  const fill = (start: number, phi: number) => {
    const band: { alpha: number; half: number }[] = []
    let used = 0
    let max = 0
    for (let j = start; j < radii.length; j++) {
      const alpha = angular(radii[j])
      // Azimuthal half-width at this latitude: a disc near the pole eats more
      // longitude than the same disc at the equator.
      const half = Math.asin(Math.min(1, Math.sin(alpha) / Math.max(1e-6, Math.sin(phi))))
      if (band.length && used + 2 * half > 2 * Math.PI) break
      band.push({ alpha, half })
      used += 2 * half
      max = Math.max(max, alpha)
    }
    return { band, used, max }
  }

  let i = 0
  let phi = 0
  let previousBandMax = 0

  while (i < radii.length) {
    // The band's latitude depends on its tallest disc, and which discs fit
    // depends on the latitude. Settle it by iterating rather than by guessing
    // from the first disc, which is how bands used to collide with the one
    // above whenever a big package sat late in the row.
    let candidate = phi === 0 ? angular(radii[i]) : phi + previousBandMax + angular(radii[i])
    let filled = fill(i, candidate)
    for (let pass = 0; pass < 4; pass++) {
      const settled = phi === 0 ? filled.max : phi + previousBandMax + filled.max
      if (Math.abs(settled - candidate) < 1e-9) break
      candidate = settled
      filled = fill(i, candidate)
    }
    if (candidate >= Math.PI) return null

    let walked = 0
    for (const b of filled.band) {
      seats.push({ phi: candidate, psi: ((walked + b.half) / filled.used) * 2 * Math.PI })
      walked += 2 * b.half
    }
    i += filled.band.length
    phi = candidate
    previousBandMax = filled.max
  }

  return phi + previousBandMax <= Math.PI ? seats : null
}

/**
 * The greedy packing proposes; this disposes. Checking the actual chord
 * distance between every pair is the only feasibility test worth trusting —
 * the angular arithmetic that produced the seats is exactly what would be
 * wrong if they overlapped.
 */
function noOverlaps(seats: { phi: number; psi: number }[], radii: number[], shell: number): boolean {
  const points = seats.map((s) => scale(onSphere(s.phi, s.psi), shell))
  for (let a = 0; a < points.length; a++) {
    for (let b = a + 1; b < points.length; b++) {
      const dx = points[a].x - points[b].x
      const dy = points[a].y - points[b].y
      const dz = points[a].z - points[b].z
      if (Math.hypot(dx, dy, dz) < radii[a] + radii[b]) return false
    }
  }
  return true
}

/**
 * Smallest shell the districts actually fit on, found by growing until the
 * packing verifies. Grown rather than bisected: which discs land in which band
 * changes with the radius, so feasibility is not perfectly monotonic and a
 * bisection can converge onto a radius that does not work.
 */
function shellRadius(radii: number[]): number {
  if (radii.length <= 1) return 0

  let shell = Math.max(...radii) + PAD
  for (let step = 0; step < 200; step++) {
    const seats = packOnShell(radii, shell)
    if (seats && noOverlaps(seats, radii, shell)) return shell
    shell *= 1.06
  }
  return shell
}

/** `github.com/x/y/internal/gitlab` -> `internal/gitlab`. */
export function shortPkg(pkg: string): string {
  const parts = pkg.split('/')
  return parts.slice(Math.max(0, parts.length - 2)).join('/')
}
