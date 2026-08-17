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
  /** What to write under the mark: the repo, as you would type it. */
  label: string
  /** Every copy of the mark. One texture, one panel per point. */
  at: Vec3[]
  /** World height, which for a square mark is also its width. */
  size: number
}

/**
 * The module path as the repo you would go and clone.
 *
 * Go's major-version suffix is a detail of the import path rather than part of
 * the name of anything: `github.com/cli/cli/v2` is `github.com/cli/cli`, and
 * typing the first into a browser gets you a 404.
 */
export function repoLabel(module: string): string {
  return module.replace(/\/v[1-9][0-9]*$/, '')
}

/**
 * How big a mark is, as a fraction of the sphere it is stuck to.
 *
 * Angular size, in other words: what it works out to is the same slice of the
 * sky whatever the graph's size, which is the only measure that matters for a
 * thing you only ever see from near the middle. 0.14 is about 8 degrees.
 */
const SIZE = 0.14

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
 * Six marks, pasted on the inside of the sky.
 *
 * `radius` is the sky's, not the crust's: these belong at the back of the world
 * with the stars, not floating in the middle distance where they read as
 * stickers hanging in mid-air between you and the graph. Being that far out is
 * also what makes them worth having — something at the edge of the world tells
 * you which way you are facing, and something halfway there just gets in front
 * of what you were looking at.
 *
 * Fixed directions rather than anything derived from the graph, so the same six
 * points mean the same six things whatever module is loaded, and so they place
 * identically on every run without needing to be hashed to get there.
 */
export function placeBadge(module: string, radius: number): PlacedBadge | null {
  const path = badgePath(module)
  if (!path) return null

  const reach = Math.max(1, radius)
  return {
    path,
    label: repoLabel(module),
    at: CARDINALS.map((d) => ({ x: d.x * reach, y: d.y * reach, z: d.z * reach })),
    size: reach * SIZE,
  }
}

/**
 * Which way to look from `target` to have a mark in frame, staying as near as
 * possible to the bearing you would have used anyway.
 *
 * The opening shot approaches on a fixed vector that knows nothing about where
 * the marks are, so the first thing anyone sees reliably has none of them in
 * it: six landmarks in the sky, and the camera pointed at the one direction
 * with no landmark in it. Looking from the far side of the focus puts a mark
 * behind it — the city in front, its repo hanging over it.
 *
 * `prefer` is the direction you would have looked. Taking the mark closest to
 * it keeps the opening bearing recognisably the one it always was rather than
 * snapping the camera onto an axis.
 */
export function bearingToBadge(badge: PlacedBadge, target: Vec3, prefer: Vec3): Vec3 {
  const wanted = unit(prefer)
  let best = badge.at[0]
  let bestDot = -Infinity
  for (const point of badge.at) {
    const dir = unit(minus(point, target))
    const dot = dir.x * wanted.x + dir.y * wanted.y + dir.z * wanted.z
    // Strictly greater, so a tie goes to the earlier cardinal and the opening
    // shot is the same shot every time.
    if (dot > bestDot) {
      bestDot = dot
      best = point
    }
  }

  // Look *past* the mark rather than straight at it. Aiming at it exactly puts
  // it directly behind whatever you are looking at, which for an opening shot
  // of a whole graph means the crust sits in front of it and hides it — the
  // first version of this did exactly that. Turned a third of a right angle
  // away, it clears the silhouette and sits beside the sphere with both in
  // frame at once.
  const toBadge = unit(minus(best, target))
  const axis = cross(toBadge, wanted)
  const len = Math.hypot(axis.x, axis.y, axis.z)
  // Nothing to turn about when the two are already in line; any perpendicular
  // will do, and a fixed one keeps the shot repeatable.
  const about = len > 1e-6 ? unit(axis) : unit(cross(toBadge, { x: 0, y: 1, z: 0.001 }))
  return rotateAbout(toBadge, about, OFF_AXIS)
}

/** Far enough off the view axis to clear the graph, near enough to stay framed. */
const OFF_AXIS = (32 * Math.PI) / 180

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

/** Rodrigues: turn `v` about the unit `k` by `angle`. */
function rotateAbout(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const kv = k.x * v.x + k.y * v.y + k.z * v.z
  const kxv = cross(k, v)
  return unit({
    x: v.x * c + kxv.x * s + k.x * kv * (1 - c),
    y: v.y * c + kxv.y * s + k.y * kv * (1 - c),
    z: v.z * c + kxv.z * s + k.z * kv * (1 - c),
  })
}

function minus(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function unit(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}
