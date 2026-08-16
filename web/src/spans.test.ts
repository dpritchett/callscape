import { describe, expect, test } from 'vitest'
import { runsForLines, type Span } from './spans'

const bytes = (s: string) => new TextEncoder().encode(s)
/** The whole of a line, colours discarded — it must survive the round trip. */
const flat = (runs: { t: string }[]) => runs.map((r) => r.t).join('')

// Classes, as lex.go numbers them.
const PUNCT = 1
const KEYWORD = 2
const IDENT = 3
const STRING = 4
const COMMENT = 6

describe('runsForLines', () => {
  const SRC = 'package p\n\nfunc f() {\n\treturn "x"\n}\n'
  // Offsets into SRC, as go/scanner would report them.
  const SPANS: Span[] = [
    [0, 7, KEYWORD], // package
    [8, 1, IDENT], // p
    [11, 4, KEYWORD], // func
    [16, 1, IDENT], // f
    [17, 1, PUNCT], // (
    [18, 1, PUNCT], // )
    [20, 1, PUNCT], // {
    [23, 6, KEYWORD], // return
    [30, 3, STRING], // "x"
    [34, 1, PUNCT], // }
  ]

  test('every line comes back whole, colours or not', () => {
    const lines = runsForLines(bytes(SRC), SPANS, 1, 5)
    expect(lines.map(flat)).toEqual(['package p', '', 'func f() {', '\treturn "x"', '}'])
  })

  test('a line is cut into its tokens, with the gaps left plain', () => {
    const [line] = runsForLines(bytes(SRC), SPANS, 1, 1)
    expect(line).toEqual([
      { t: 'package', c: KEYWORD },
      { t: ' ', c: 0 },
      { t: 'p', c: IDENT },
    ])
  })

  test('leading whitespace is a plain run, not a missing one', () => {
    const [line] = runsForLines(bytes(SRC), SPANS, 4, 4)
    expect(line[0]).toEqual({ t: '\t', c: 0 })
    expect(flat(line)).toBe('\treturn "x"')
  })

  test('a window is only the lines asked for', () => {
    expect(runsForLines(bytes(SRC), SPANS, 3, 3).map(flat)).toEqual(['func f() {'])
  })

  test('a window past the end of the file stops at the end of the file', () => {
    expect(runsForLines(bytes(SRC), SPANS, 4, 900).map(flat)).toEqual(['\treturn "x"', '}'])
    expect(runsForLines(bytes(SRC), SPANS, 90, 99)).toEqual([])
  })

  test('no newline ever lands inside a run', () => {
    for (const line of runsForLines(bytes(SRC), SPANS, 1, 5)) {
      for (const run of line) expect(run.t).not.toContain('\n')
    }
  })

  test('a token spanning lines is cut at the break and keeps its colour', () => {
    const src = 'x\n/* one\ntwo */\ny\n'
    const spans: Span[] = [
      [0, 1, IDENT],
      [2, 13, COMMENT], // /* one\ntwo */
      [16, 1, IDENT],
    ]
    const lines = runsForLines(bytes(src), spans, 1, 4)
    expect(lines.map(flat)).toEqual(['x', '/* one', 'two */', 'y'])
    expect(lines[1]).toEqual([{ t: '/* one', c: COMMENT }])
    expect(lines[2]).toEqual([{ t: 'two */', c: COMMENT }])
  })

  test('a multi-byte rune does not shift the colours after it', () => {
    // The comment is 12 bytes and 10 characters. Slicing by character would
    // put `var` two columns to the left of where it is.
    const src = '// héllo ☃\nvar x = 1\n'
    const comment = bytes('// héllo ☃').length
    const spans: Span[] = [
      [0, comment, COMMENT],
      [comment + 1, 3, KEYWORD], // var
    ]
    const lines = runsForLines(bytes(src), spans, 1, 2)
    expect(lines[0]).toEqual([{ t: '// héllo ☃', c: COMMENT }])
    expect(lines[1][0]).toEqual({ t: 'var', c: KEYWORD })
  })

  test('no spans at all is plain text rather than nothing', () => {
    expect(runsForLines(bytes(SRC), [], 1, 3).map(flat)).toEqual(['package p', '', 'func f() {'])
  })

  test('a file with no trailing newline still ends in a line', () => {
    expect(runsForLines(bytes('a\nb'), [], 1, 2).map(flat)).toEqual(['a', 'b'])
  })
})
