/**
 * The contents of whichever district you are pointing at, as a list.
 *
 * Flying past a district tells you how big it is and what colour it is. It does
 * not tell you what is in it, and the labels only name the few symbols nearest
 * the camera. This is the readable version: everything in the package you are
 * looking at, in the order that says which parts of it matter.
 *
 * Pure, like the search panel and for the same reason — the shutter
 * photographs the canvas, so no screenshot has ever contained this text.
 */

/** What a row needs. `PlacedNode` satisfies it. */
export interface Occupant {
  name: string
  fanIn: number
  fanInPkgs: number
  fanOut: number
}

export interface DistrictView {
  /** The district's short label, as drawn on the sprite over it. */
  label: string
  pkg: string
  occupants: Occupant[]
}

/** How many rows the panel lists before it starts counting instead. */
export const DISTRICT_ROWS = 16

/**
 * Ranked by how many packages call a symbol, which is the honest measure of
 * what a district is *for*: the things other packages reach in through, first,
 * and the private machinery after. Ties go to the name, so the list is stable
 * while you fly around and does not reshuffle under your eyes.
 */
export function rankOccupants<T extends Occupant>(occupants: readonly T[]): T[] {
  return [...occupants].sort(
    (a, b) =>
      b.fanInPkgs - a.fanInPkgs ||
      b.fanIn - a.fanIn ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
}

export function districtPanel(d: DistrictView | null, rows = DISTRICT_ROWS): string {
  const head = '[district]  tab to swap'
  if (!d) return `${head}\n\n  nothing in front of you`

  const ranked = rankOccupants(d.occupants)
  const shown = ranked.slice(0, rows)
  const width = shown.length ? Math.max(...shown.map((o) => o.name.length)) : 0

  const lines = shown.map((o) => {
    // Two numbers, because they answer different questions: how many packages
    // depend on this, and how much it depends on.
    const called = o.fanInPkgs ? `${o.fanInPkgs} pkg${o.fanInPkgs === 1 ? '' : 's'}` : '—'
    return `  ${o.name.padEnd(width)}  in ${called.padStart(6)} · out ${o.fanOut}`
  })

  const tail =
    ranked.length > shown.length
      ? `  ${shown.length} of ${ranked.length}`
      : `  ${ranked.length} symbol${ranked.length === 1 ? '' : 's'}`

  return `${head}\n\n${d.label}\n${d.pkg}\n\n${lines.join('\n')}\n\n${tail}`
}
