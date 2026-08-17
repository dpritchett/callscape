/**
 * How much of the scene is named, as a small ring you step through.
 *
 * One setting cannot be right for both jobs. Crossing the shell you want the
 * package names and nothing else; standing in a district you want the functions
 * and the packages are noise; lining something up you want the one thing you are
 * pointing at and silence everywhere else. Rather than guess from altitude —
 * which is a rule that will be wrong at somebody's favourite distance — it is a
 * control, and the ribbon says which way round it currently is.
 */
export const LABEL_MODES = ['all', 'pkg', 'fn', 'aim', 'off'] as const

export type LabelMode = (typeof LABEL_MODES)[number]

/** The ribbon's running order, which is also what the d-pad steps through. */
export const RIBBON: { mode: LabelMode; glyph: string; title: string }[] = [
  { mode: 'all', glyph: 'A', title: 'packages and functions' },
  { mode: 'pkg', glyph: 'P', title: 'package names only' },
  { mode: 'fn', glyph: 'F', title: 'function names only' },
  { mode: 'aim', glyph: '+', title: 'only what the reticle is on' },
  { mode: 'off', glyph: '-', title: 'nothing named' },
]

/**
 * Step `n` places along the ribbon, wrapping. Wrapping rather than stopping at
 * the ends: a ring of five is faster to learn by spinning it than by finding out
 * where it stops, and there is no ordering here where an end means anything.
 */
export function cycleMode(current: LabelMode, step: number): LabelMode {
  const at = LABEL_MODES.indexOf(current)
  const from = at < 0 ? 0 : at
  const n = LABEL_MODES.length
  return LABEL_MODES[(((from + step) % n) + n) % n]
}

/** Whether district names are drawn at all in this mode. */
export function namesDistricts(mode: LabelMode): boolean {
  return mode === 'all' || mode === 'pkg' || mode === 'aim'
}

/** Whether symbol names are drawn at all in this mode. */
export function namesSymbols(mode: LabelMode): boolean {
  return mode === 'all' || mode === 'fn' || mode === 'aim'
}

/**
 * Whether naming is confined to the district under the reticle. This is the
 * answer to a screenful of names being too much without going all the way to
 * none: what you are pointing at keeps its name and everything else lets go.
 */
export function aimedOnly(mode: LabelMode): boolean {
  return mode === 'aim'
}

/**
 * The ribbon as plain data, so what is on the glass is a pure function of the
 * mode and can be checked without a browser — the same reason the search panel's
 * text is built in `search.ts` rather than in the renderer.
 */
export function ribbon(mode: LabelMode): { glyph: string; title: string; active: boolean }[] {
  return RIBBON.map((r) => ({ glyph: r.glyph, title: r.title, active: r.mode === mode }))
}
