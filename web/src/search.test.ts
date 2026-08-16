import { describe, expect, test } from 'vitest'
import { panelText, rank, type Searchable, type SearchView } from './search'

const node = (id: string, name: string, pkg: string, fanInPkgs = 0): Searchable => ({
  id,
  name,
  pkg,
  fanInPkgs,
})

const NODES: Searchable[] = [
  node('m/coderd/httpapi.Write', 'Write', 'm/coderd/httpapi', 52),
  node('m/coderd/httpapi.WriteIndent', 'WriteIndent', 'm/coderd/httpapi', 3),
  node('m/coderd/httpapi.WriteOAuth2Error', 'WriteOAuth2Error', 'm/coderd/httpapi', 1),
  node('m/cli.rewriteFlags', 'rewriteFlags', 'm/cli', 2),
  node('m/gitlab.Client.Get', 'Client.Get', 'm/gitlab', 12),
  node('m/gitlab.Client.Post', 'Client.Post', 'm/gitlab', 4),
]

const ids = (hits: Searchable[]) => hits.map((h) => h.id)

describe('rank', () => {
  test('an empty query matches nothing, rather than everything', () => {
    expect(rank(NODES, '')).toEqual([])
    expect(rank(NODES, '   ')).toEqual([])
  })

  test('exact name, then prefix, then anywhere in the name, then the id', () => {
    expect(ids(rank(NODES, 'write'))).toEqual([
      'm/coderd/httpapi.Write', // exact
      'm/coderd/httpapi.WriteIndent', // prefix, 3 pkgs
      'm/coderd/httpapi.WriteOAuth2Error', // prefix, 1 pkg
      'm/cli.rewriteFlags', // only inside the name
    ])
  })

  test('case does not matter, in the query or the symbol', () => {
    expect(ids(rank(NODES, 'WRITEINDENT'))).toEqual(['m/coderd/httpapi.WriteIndent'])
  })

  test('a package path finds its symbols, which a name search cannot', () => {
    expect(ids(rank(NODES, 'gitlab'))).toEqual(['m/gitlab.Client.Get', 'm/gitlab.Client.Post'])
  })

  test('a receiver finds its methods', () => {
    expect(ids(rank(NODES, 'client.'))).toEqual(['m/gitlab.Client.Get', 'm/gitlab.Client.Post'])
  })

  test('within a tier, more calling packages wins', () => {
    const hits = rank(NODES, 'client.')
    expect(hits[0].fanInPkgs).toBeGreaterThan(hits[1].fanInPkgs)
  })

  test('ties break on id, so the order is total', () => {
    const tied = [
      node('m/b.Same', 'Same', 'm/b', 5),
      node('m/a.Same', 'Same', 'm/a', 5),
      node('m/c.Same', 'Same', 'm/c', 5),
    ]
    expect(ids(rank(tied, 'same'))).toEqual(['m/a.Same', 'm/b.Same', 'm/c.Same'])
  })

  test('input order cannot change the result', () => {
    const shuffled = [...NODES].reverse()
    expect(ids(rank(shuffled, 'write'))).toEqual(ids(rank(NODES, 'write')))
    expect(ids(rank(shuffled, 'e'))).toEqual(ids(rank(NODES, 'e')))
  })

  test('every match comes back, so the caller can say how many it is showing', () => {
    expect(rank(NODES, 'e').length).toBe(NODES.length)
  })

  test('no match is empty, not everything', () => {
    expect(rank(NODES, 'zzz')).toEqual([])
  })
})

// The panel is DOM, and the shutter photographs the canvas, so nothing that
// takes a screenshot of this page can see the text below. These assertions are
// the only reader it has.
describe('panelText', () => {
  const view = (over: Partial<SearchView> = {}): SearchView => {
    const shown = over.shown ?? rank(NODES, 'write').slice(0, 3)
    return {
      query: 'write',
      cursor: 0,
      shown,
      matches: shown.length,
      searched: NODES.length,
      ...over,
    }
  }

  test('an empty query says how much there is to search', () => {
    const text = panelText(view({ query: '', shown: [], matches: 0 }))
    expect(text).toContain('6 symbols placed')
  })

  test('the cursor marks exactly one row, the one enter would take', () => {
    const marked = panelText(view({ cursor: 1 }))
      .split('\n')
      .filter((l) => l.startsWith('>'))
    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain('WriteIndent')
  })

  test('names line up, so a long one does not shorten the column', () => {
    const text = panelText(view())
    const cols = text
      .split('\n')
      .filter((l) => l.includes('m/coderd/httpapi'))
      .map((l) => l.indexOf('m/coderd/httpapi'))
    expect(new Set(cols).size).toBe(1)
  })

  test('a listing that is not the whole story says so', () => {
    expect(panelText(view({ matches: 154 }))).toContain('3 of 154 matches')
    expect(panelText(view())).toContain('3 matches')
    expect(panelText(view({ shown: [NODES[0]], matches: 1 }))).toContain('1 match')
  })

  test('no match names the query rather than showing an empty list', () => {
    const text = panelText(view({ query: 'zzz', shown: [], matches: 0 }))
    expect(text).toContain('zzz')
    expect(text).toContain('no match in 6 symbols')
  })
})
