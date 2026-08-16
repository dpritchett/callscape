/**
 * Go to symbol. Ranking only — no DOM, no three.js, no state.
 *
 * Eight thousand buildings are navigable by flying only if you already know
 * where the thing is. This is the other way in: type part of a name, get the
 * few symbols it could be, in an order that does not change between runs.
 */

/** Everything ranking needs. `PlacedNode` satisfies it; tests need not. */
export interface Searchable {
  id: string
  name: string
  pkg: string
  /** Distinct calling packages — the honest measure of how central a symbol is. */
  fanInPkgs: number
}

/** How many hits the panel shows. The rest are counted, not listed. */
export const SEARCH_LIMIT = 12

/**
 * Best-first matches for `query`, all of them. The caller shows the first few
 * and reports the total, because "12 of 143" and "12 of 12" call for different
 * next keystrokes.
 *
 * Match tiers, best first: the name exactly, the name by prefix, the name
 * anywhere, then the full id — which is what finds a symbol by its package, or
 * by its receiver as `Client.Get`. Ties go to the symbol more packages call,
 * then to the id, so the order is total and identical in any input order.
 */
export function rank<T extends Searchable>(nodes: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const scored: { node: T; tier: number }[] = []
  for (const node of nodes) {
    const tier = tierOf(node, q)
    if (tier >= 0) scored.push({ node, tier })
  }

  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.node.fanInPkgs - a.node.fanInPkgs ||
      (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0),
  )
  return scored.map((s) => s.node)
}

/**
 * An open query, as the panel needs to show it.
 *
 * Modal rather than a fourth thing Tab cycles through: while it is up the
 * keyboard is spelling, not flying, and the panel is the only thing on screen
 * that says so.
 */
export interface SearchView {
  query: string
  /** Which hit Enter would take, as an index into `shown`. */
  cursor: number
  shown: Searchable[]
  /** Matches in total, which is usually more than the panel lists. */
  matches: number
  /** Symbols the query ran against: what is placed, not what the module has. */
  searched: number
}

/**
 * What the panel says. A pure function of the query state, so what an agent
 * reads in a test is the same text a person reads on the glass — the shutter
 * photographs the canvas, and this panel is DOM, so it is in no screenshot.
 */
export function panelText(s: SearchView): string {
  // The bar ends in a cursor block, because an empty query and a closed search
  // otherwise look identical.
  const head = `[search]  enter goes · up/down · esc cancels\n\n  ${s.query}▏`
  if (!s.query.trim()) return `${head}\n\n  ${s.searched} symbols placed`
  if (!s.matches) return `${head}\n\n  no match in ${s.searched} symbols`

  // Names line up in a column so the eye can run down them. A long one pushes
  // its own package right rather than truncating the name that was searched.
  const width = Math.max(...s.shown.map((h) => h.name.length))
  const rows = s.shown.map(
    (h, i) => `${i === s.cursor ? '>' : ' '} ${h.name.padEnd(width)}  ${h.pkg}`,
  )
  const tail =
    s.matches > s.shown.length
      ? `${s.shown.length} of ${s.matches} matches`
      : `${s.matches} match${s.matches === 1 ? '' : 'es'}`
  return `${head}\n\n${rows.join('\n')}\n\n  ${tail}`
}

function tierOf(node: Searchable, q: string): number {
  const name = node.name.toLowerCase()
  if (name === q) return 0
  if (name.startsWith(q)) return 1
  if (name.includes(q)) return 2
  if (node.id.toLowerCase().includes(q)) return 3
  return -1
}
