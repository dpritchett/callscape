import type { GraphNode, ViewSpec } from './types'

// Glob match over package paths. `*` matches any run of characters including
// `/`, so `*/internal/gitlab` matches a package inside any module and
// `*/cmd/*` matches every command package. `?` matches one character.
export function globToRegExp(pattern: string): RegExp {
  const body = pattern
    // Runs of `*` collapse to one. `**` means nothing extra here, and leaving
    // them in would compile to `.*.*.*`, which backtracks badly on a near-miss.
    .replace(/\*+/g, '*')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${body}$`)
}

export function matchesAny(pkg: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false
  return patterns.some((p) => globToRegExp(p).test(pkg))
}

/** Applies `occupants` to the graph: package globs, then minFanIn, then top-N. */
export function selectOccupants(nodes: GraphNode[], view: ViewSpec): GraphNode[] {
  const { packages, minFanIn, limit, generated } = view.occupants
  const rank = view.encoding.size

  const kept = nodes.filter(
    (n) =>
      matchesAny(n.pkg, packages) &&
      n.fanIn >= minFanIn &&
      // A third of coder is generated, and it distorts every ranking it appears
      // in, so whether to look at it is a decision the view gets to make.
      (generated === 'include' || (generated === 'only') === Boolean(n.generated)),
  )

  kept.sort((a, b) => {
    const av = a[rank], bv = b[rank]
    if (typeof av === 'number' && typeof bv === 'number' && av !== bv) return bv - av
    if (typeof av === 'string' && typeof bv === 'string' && av !== bv) return av < bv ? -1 : 1
    if (typeof av === 'boolean' && typeof bv === 'boolean' && av !== bv) return av ? -1 : 1
    return a.id < b.id ? -1 : 1 // stable tie-break, so the layout never shuffles
  })

  return limit > 0 ? kept.slice(0, limit) : kept
}
