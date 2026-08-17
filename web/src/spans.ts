/**
 * Turning a Go token stream into coloured runs, one line at a time.
 *
 * The offsets come from `go/scanner` and are **byte** offsets. JavaScript
 * string indices are UTF-16 code units, so one `é` in a comment puts every
 * later offset on the wrong character. All the cutting therefore happens here,
 * on the bytes, and the browser is handed text it can render without knowing
 * where anything was.
 */

/** `[byte offset, byte length, class]`, as emitted by `callscape-dump --lex`. */
export type Span = [number, number, number]

/** A stretch of text that is all one colour. Class 0 is uncoloured. */
export interface Run {
  t: string
  c: number
}

/**
 * The lines `from`..`to` (1-based, inclusive) of a UTF-8 buffer, each as runs.
 *
 * Whatever no span covers comes back as class 0 — whitespace, mostly, which the
 * scanner never reports. Spans that straddle a line break are cut at it, since
 * a block comment or a raw string is one token over several lines and the
 * renderer works a line at a time.
 */
export function runsForLines(src: Uint8Array, spans: Span[], from: number, to: number): Run[][] {
  const decode = new TextDecoder()
  const ranges = lineRanges(src)
  const first = Math.max(1, from)
  const last = Math.min(ranges.length, to)
  if (first > last) return []

  const lines: Run[][] = []
  for (let n = first; n <= last; n++) {
    const [begin, end] = ranges[n - 1]
    lines.push(runsForRange(src, spans, begin, end, decode))
  }
  return lines
}

/**
 * Every line as a byte range, the newline excluded — the renderer puts the
 * breaks back, and a run holding one would be drawn across two lines. A file
 * ending in a newline ends there rather than opening an empty last line.
 */
function lineRanges(src: Uint8Array): [number, number][] {
  const ranges: [number, number][] = []
  let begin = 0
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== 0x0a) continue
    ranges.push([begin, i])
    begin = i + 1
  }
  if (begin < src.length) ranges.push([begin, src.length])
  return ranges
}

function runsForRange(
  src: Uint8Array,
  spans: Span[],
  begin: number,
  end: number,
  decode: TextDecoder,
): Run[] {
  const runs: Run[] = []
  const push = (a: number, b: number, c: number) => {
    if (b > a) runs.push({ t: decode.decode(src.subarray(a, b)), c })
  }

  let at = begin
  for (const [off, len, cls] of spans) {
    const a = Math.max(off, begin)
    const b = Math.min(off + len, end)
    if (b <= a) continue // entirely before or after this line
    push(at, a, 0)
    push(a, b, cls)
    at = b
    if (at >= end) break
  }
  push(at, end, 0)
  return runs
}
