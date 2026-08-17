import { type Vec3 } from './layout'

/**
 * The module's own mark, hung outside the shell as a landmark.
 *
 * Convention rather than configuration: a module path implies a file, the
 * renderer asks for it, and a miss is a log line and no sprite. Nothing to
 * configure, nothing to keep in step with the graph you happen to be flying,
 * and adding a badge for a new module means dropping a PNG in the right place.
 *
 *   github.com/cli/cli/v2  ->  badges/github.com/cli.png
 *   golang.org/x/tools     ->  badges/golang.org/x.png
 *
 * Host and owner, mirroring the first two segments of the module path, so two
 * forges with the same owner name cannot land on the same file.
 */
export const BADGE_DIR = 'badges'

/** Module path segments may only look like this to become part of a path. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Where this module's badge would live, or null if the path cannot name one.
 *
 * A module path comes out of whatever repo was dumped, so it is input: `..` or
 * a slash smuggled through a segment would be a traversal in a fetch URL. The
 * segments have to look like segments, and `..` cannot survive `SAFE` because
 * of the leading-character class.
 */
export function badgePath(module: string): string | null {
  const parts = module.split('/')
  if (parts.length < 2) return null
  const [host, owner] = parts
  if (!SAFE.test(host) || !SAFE.test(owner)) return null
  // A host is a host: something with a dot in it. Without this, a two-segment
  // module path that is not a forge URL invents a badge nobody will ever add.
  if (!host.includes('.')) return null
  return `${BADGE_DIR}/${host}/${owner}.png`
}

/** A badge, placed. The renderer asks for `path` and draws nothing if it misses. */
export interface PlacedBadge {
  path: string
  /** Every copy of the mark. One texture, one sprite per point. */
  at: Vec3[]
  /** World height, which for a square mark is also its width. */
  size: number
}

/** How far out they float, and how big, both as multiples of `extent`. */
const DISTANCE = 1.9
const SIZE = 0.3

/**
 * The six directions a mark hangs in: up, down, left, right, ahead, behind.
 *
 * One copy in a hashed direction was a landmark you had to already know about
 * — findable if you went looking, invisible if you did not. Six along the axes
 * means turning anywhere puts one in or near the frame, which is the difference
 * between a thing you can navigate by and a thing you have to hunt for.
 *
 * The axes rather than a sphere-filling spread, because the axes are the
 * directions a person actually turns to.
 */
const CARDINALS: Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

/**
 * Moons: outside the crust, one at each cardinal point.
 *
 * Outside the shell rather than on it, because a district is a place you fly to
 * and this is a thing you take a bearing from. Fixed directions rather than
 * anything derived from the graph, so the same six points mean the same six
 * things whatever module is loaded — and, being constants, they place
 * identically on every run without needing to be hashed to get there.
 */
export function placeBadge(module: string, extent: number): PlacedBadge | null {
  const path = badgePath(module)
  if (!path) return null

  const reach = Math.max(1, extent) * DISTANCE
  return {
    path,
    at: CARDINALS.map((d) => ({ x: d.x * reach, y: d.y * reach, z: d.z * reach })),
    size: Math.max(1, extent) * SIZE,
  }
}
