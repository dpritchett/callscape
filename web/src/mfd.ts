import { devlog } from './devlog'
import { lineWindow } from './srcpath'
import type { PlacedNode } from './placement'
import type { Neighborhood } from './selection'
import { panelText, type SearchView } from './search'
import { districtPanel, type DistrictView } from './district'
import type { Run } from './spans'

export type Mode = 'info' | 'source' | 'district'
export const MODES: Mode[] = ['info', 'source', 'district']

interface Payload {
  selected: string[]
  nodeById: (id: string) => PlacedNode | undefined
  fileOf: (id: string) => { file: string; line: number; lines: number } | undefined
  drawn: (id: string) => { ins: number; outs: number }
  hood: Neighborhood
  search?: SearchView | null
  /** The district the reticle is on, for the mode that lists its contents. */
  district?: DistrictView | null
}

/**
 * One small display that swaps modes, rather than a wall of permanent panes.
 * `info` is what the graph knows about the selection; `source` is the function
 * itself, which is the half of "fly there and read it" that was missing.
 */
export class MFD {
  /** Which display is up, so the app can tell whether it needs feeding. */
  get mode(): Mode {
    return this.current
  }
  private current: Mode = 'info'
  private last: Payload | null = null
  private token = 0

  constructor(private el: HTMLElement) {}

  /** Returns the mode it landed on, which is what the caller announces. */
  cycle(): Mode {
    this.current = MODES[(MODES.indexOf(this.current) + 1) % MODES.length]
    devlog('mfd', { mode: this.current })
    if (this.last) this.render(this.last)
    return this.current
  }

  render(p: Payload) {
    this.last = p
    // A query takes the panel over, selection or not: it is the only thing on
    // screen saying what the keys are currently doing.
    if (p.search) {
      this.el.style.display = 'block'
      this.el.textContent = panelText(p.search)
      return
    }
    // The district panel is about where you are, not what you have picked, so
    // it is the one mode that has something to say with nothing selected.
    if (this.current === 'district') {
      this.el.style.display = 'block'
      this.el.textContent = districtPanel(p.district ?? null)
      return
    }
    if (!p.selected.length) {
      this.el.style.display = 'none'
      return
    }
    this.el.style.display = 'block'
    if (this.current === 'info') this.el.textContent = this.info(p)
    else void this.source(p)
  }

  private info(p: Payload): string {
    const lines = p.selected.map((id) => {
      const node = p.nodeById(id)
      if (!node) return id
      const { ins, outs } = p.drawn(id)
      const where = p.fileOf(id)
      return [
        node.name,
        `  ${node.pkg}`,
        where ? `  ${where.file}:${where.line}  ${where.lines} lines` : '',
        `  in ${ins}/${node.fanIn} (${node.fanInPkgs} pkgs) · out ${outs}/${node.fanOut}`,
      ]
        .filter(Boolean)
        .join('\n')
    })
    return `[info]  tab to swap\n\n${lines.join('\n\n')}\n\n${p.hood.callers.size} callers · ${p.hood.callees.size} callees`
  }

  /** Fetches the selected symbol's own lines from the analysed module. */
  private async source(p: Payload) {
    const id = p.selected[p.selected.length - 1] // the most recent pick
    const node = p.nodeById(id)
    const where = p.fileOf(id)
    if (!where) {
      this.el.textContent = '[source]  tab to swap\n\nno file for this symbol'
      return
    }

    const { from, to } = lineWindow(where.line, where.lines)
    const mine = ++this.token
    this.el.textContent = `[source]  tab to swap\n\n${where.file}:${where.line}\n\nloading…`
    try {
      const res = await fetch(`/__src?file=${encodeURIComponent(where.file)}&from=${from}&to=${to}`)
      const body = (await res.json()) as { lines?: string[]; runs?: Run[][]; error?: string }
      if (mine !== this.token) return // a newer selection won the race
      if (!res.ok || !body.lines) {
        this.el.textContent = `[source]\n\n${body.error ?? res.statusText}`
        return
      }
      this.paint(
        `[source]  tab to swap\n\n${node?.name ?? id}\n${where.file}:${where.line}\n\n`,
        body.lines,
        body.runs,
        from,
        to,
      )
    } catch (err) {
      if (mine === this.token) this.el.textContent = `[source]\n\n${String(err)}`
    }
  }

  /**
   * Draws the listing as nodes rather than as markup. This is arbitrary source
   * off somebody's disk: built as a string it would need escaping to be right,
   * and `textContent` cannot be broken by what the file happens to contain.
   *
   * Without `runs` — no Go toolchain, or a file the scanner refused — the lines
   * are drawn plain. Colour is a bonus and never a requirement for reading.
   */
  private paint(head: string, lines: string[], runs: Run[][] | undefined, from: number, to: number) {
    const width = String(to).length
    const out = document.createDocumentFragment()
    out.append(head)

    lines.forEach((text, i) => {
      const gutter = document.createElement('span')
      gutter.className = 'ln'
      gutter.textContent = `${String(from + i).padStart(width)}  `
      out.append(gutter)

      const line = runs?.[i]
      if (!line) {
        out.append(text)
      } else {
        for (const run of line) {
          if (!run.c) {
            out.append(run.t) // whitespace, and anything the scanner skipped
            continue
          }
          const el = document.createElement('span')
          el.className = `t${run.c}`
          el.textContent = run.t
          out.append(el)
        }
      }
      out.append('\n')
    })

    this.el.replaceChildren(out)
  }
}
