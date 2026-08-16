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
  const { shell, dirs } = spreadOnShell(radii)

  const districts: District[] = []
  const pos = new Map<string, Vec3>()

  discs.forEach((d, i) => {
    const normal = dirs[i]
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
  /** Parcel dimensions. Not a circle: circles inside circles is a fractal. */
  w: number
  h: number
  /** A few degrees off true, so nothing in the district lines up globally. */
  angle: number
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

  const blocks = [...byFile.entries()].map(([file, list]) => {
    const members = list.sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return rb - ra
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
    // Parcel shape comes from the file's own name, so a package's plan is
    // irregular but the same irregular every time. City blocks are not circles
    // and are not all the same proportion.
    const aspect = 0.55 + hash01(`${file}#aspect`) * 1.5
    const area = members.length * CELL * CELL * 1.25
    const w = Math.sqrt(area * aspect)
    const h = area / w
    return {
      file,
      members,
      w,
      h,
      angle: (hash01(`${file}#angle`) - 0.5) * 0.45, // ±13°
      radius: Math.hypot(w, h) / 2,
    }
  })

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
    const spot = findSpot(block.radius, radius, placed, block.file)
    if (!spot && !force) return null // caller grows the district and retries
    const at = spot ?? rimFallback(block.radius, radius, placed.length)
    placed.push({ x: at.x, y: at.y, r: block.radius })

    // Buildings sit on streets inside the parcel: rows of varying length,
    // staggered, each nudged off true. A spiral here is what made a district
    // look like a smaller copy of the sphere.
    const cols = Math.max(1, Math.round(block.w / CELL))
    const rows = Math.max(1, Math.ceil(block.members.length / cols))
    const cos = Math.cos(block.angle)
    const sin = Math.sin(block.angle)

    block.members.forEach((n, i) => {
      const row = Math.floor(i / cols)
      const inRow = i % cols
      // The last row is short, and every row is offset by its own amount, so
      // the parcel's edges come out ragged instead of square.
      const stagger = (hash01(`${block.file}#${row}`) - 0.5) * CELL * 0.9
      const x = (inRow - (cols - 1) / 2) * CELL + stagger + (hash01(`${n.id}#x`) - 0.5) * CELL * 0.55
      const y = (row - (rows - 1) / 2) * CELL * 1.1 + (hash01(`${n.id}#y`) - 0.5) * CELL * 0.5

      out.push({
        n,
        du: at.x + x * cos - y * sin,
        dv: at.y + x * sin + y * cos,
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
  seed: string,
): { x: number; y: number } | null {
  if (!placed.length) return { x: 0, y: 0 }

  const clears = (x: number, y: number) =>
    Math.hypot(x, y) + r <= bound &&
    placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + CELL * 0.4)

  // Towns accrete: a new parcel goes up against one that is already there, not
  // at the next position along a spiral. Any centre-out sequence — golden angle
  // or otherwise — leaves the district visibly radiating from its middle, which
  // is the snowflake this keeps turning into.
  for (let k = 0; k < 900; k++) {
    const neighbour = placed[Math.floor(hash01(`${seed}#pick${k}`) * placed.length)]
    const angle = hash01(`${seed}#ang${k}`) * Math.PI * 2
    const gap = CELL * (0.45 + hash01(`${seed}#gap${k}`) * 0.9)
    const reach = neighbour.r + r + gap
    const x = neighbour.x + reach * Math.cos(angle)
    const y = neighbour.y + reach * Math.sin(angle)
    if (clears(x, y)) return { x, y }
  }

  // Nothing free against an existing parcel: fall back to open ground, sampled
  // uniformly by area rather than swept outward.
  for (let k = 0; k < 400; k++) {
    const rad = (bound - r) * Math.sqrt(hash01(`${seed}#far-r${k}`))
    const angle = hash01(`${seed}#far-t${k}`) * Math.PI * 2
    const x = rad * Math.cos(angle)
    const y = rad * Math.sin(angle)
    if (clears(x, y)) return { x, y }
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
 * Spreads districts over a sphere: Fibonacci lattice for even coverage, then
 * relaxation to open up whatever overlaps, growing the shell if relaxation
 * cannot resolve it.
 *
 * Latitude bands were the previous approach and they showed: near a pole the
 * circumference is almost nothing, so a band holds one or two districts and
 * trails off into a chain, while the equator carries the mass — the whole thing
 * reads as a barbell rather than a globe. A lattice has no poles and no rows.
 */
function spreadOnShell(radii: number[]): { shell: number; dirs: Vec3[] } {
  if (radii.length === 0) return { shell: 0, dirs: [] }
  if (radii.length === 1) return { shell: 0, dirs: [{ x: 1, y: 0, z: 0 }] }

  // Enough surface for the caps plus room between them, as a starting guess.
  const area = radii.reduce((s, r) => s + Math.PI * (r + PAD / 2) ** 2, 0)
  let shell = Math.max(Math.max(...radii) + PAD, Math.sqrt(area / (4 * Math.PI)) * 1.15)

  for (let attempt = 0; attempt < 40; attempt++) {
    const dirs = fibonacciSphere(radii.length)
    if (relax(dirs, radii, shell)) return { shell, dirs }
    shell *= 1.08
  }
  return { shell, dirs: fibonacciSphere(radii.length) }
}

/** Evenly spaced directions, no clustering at the poles. */
function fibonacciSphere(n: number): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const t = i * GOLDEN_ANGLE
    out.push({ x: r * Math.cos(t), y, z: r * Math.sin(t) })
  }
  return out
}

/**
 * Pushes overlapping districts apart along the sphere until none overlap.
 * Returns whether it succeeded — the caller grows the shell if it did not.
 */
function relax(dirs: Vec3[], radii: number[], shell: number): boolean {
  for (let pass = 0; pass < 60; pass++) {
    let worst = 0
    for (let a = 0; a < dirs.length; a++) {
      for (let b = a + 1; b < dirs.length; b++) {
        const need = radii[a] + radii[b] + PAD
        const dx = (dirs[a].x - dirs[b].x) * shell
        const dy = (dirs[a].y - dirs[b].y) * shell
        const dz = (dirs[a].z - dirs[b].z) * shell
        const gap = Math.hypot(dx, dy, dz)
        if (gap >= need) continue
        worst = Math.max(worst, need - gap)

        // Move each away from the other by half the shortfall, then put them
        // back on the sphere. Two points on top of each other get nudged by
        // their index instead, since they have no direction to separate along.
        const push = (need - gap) / (2 * shell)
        const ux = gap > 1e-9 ? dx / gap : Math.cos(a)
        const uy = gap > 1e-9 ? dy / gap : Math.sin(a)
        const uz = gap > 1e-9 ? dz / gap : Math.cos(b)
        dirs[a] = normalise({
          x: dirs[a].x + ux * push,
          y: dirs[a].y + uy * push,
          z: dirs[a].z + uz * push,
        })
        dirs[b] = normalise({
          x: dirs[b].x - ux * push,
          y: dirs[b].y - uy * push,
          z: dirs[b].z - uz * push,
        })
      }
    }
    if (worst === 0) return true
  }
  return false
}

/** `github.com/x/y/internal/gitlab` -> `internal/gitlab`. */
export function shortPkg(pkg: string): string {
  const parts = pkg.split('/')
  return parts.slice(Math.max(0, parts.length - 2)).join('/')
}
