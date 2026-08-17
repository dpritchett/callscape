import { hash01, type Vec3 } from './layout'

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

/** A badge, placed. The renderer asks for `path` and draws nothing if it 404s. */
export interface PlacedBadge {
  path: string
  /** Centre of the sprite, outside the shell. */
  at: Vec3
  /** World height, which for a square mark is also its width. */
  size: number
}

/** How far out it floats, and how big it is, both as multiples of `extent`. */
const DISTANCE = 1.9
const SIZE = 0.3

/**
 * A moon: outside the crust, in a direction fixed by the module path.
 *
 * Deterministic like everything else here — the same module always hangs its
 * mark in the same place, which is what makes it worth navigating by. Outside
 * the shell rather than on it, because a district is a place you fly to and
 * this is a thing you get your bearings from.
 */
export function placeBadge(module: string, extent: number): PlacedBadge | null {
  const path = badgePath(module)
  if (!path) return null

  // Two hashes into a direction, with the polar one taken through cos so the
  // choice is spread evenly over the sphere rather than bunched at the poles.
  const theta = hash01(module) * Math.PI * 2
  const cosPhi = hash01(`${module}#badge`) * 2 - 1
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi))
  const reach = Math.max(1, extent) * DISTANCE

  return {
    path,
    at: {
      x: reach * sinPhi * Math.cos(theta),
      y: reach * cosPhi,
      z: reach * sinPhi * Math.sin(theta),
    },
    size: Math.max(1, extent) * SIZE,
  }
}
