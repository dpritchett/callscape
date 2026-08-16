import { devlog } from './devlog'
import { lineWindow } from './srcpath'
import type { PlacedNode } from './placement'
import type { Neighborhood } from './selection'
import { panelText, type SearchView } from './search'

export type Mode = 'info' | 'source'
export const MODES: Mode[] = ['info', 'source']

interface Payload {
  selected: string[]
  nodeById: (id: string) => PlacedNode | undefined
  fileOf: (id: string) => { file: string; line: number; lines: number } | undefined
  drawn: (id: string) => { ins: number; outs: number }
  hood: Neighborhood
  search?: SearchView | null
}

/**
 * One small display that swaps modes, rather than a wall of permanent panes.
 * `info` is what the graph knows about the selection; `source` is the function
 * itself, which is the half of "fly there and read it" that was missing.
 */
export class MFD {
  private mode: Mode = 'info'
  private last: Payload | null = null
  private token = 0

  constructor(private el: HTMLElement) {}

  cycle() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]
    devlog('mfd', { mode: this.mode })
    if (this.last) this.render(this.last)
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
    if (!p.selected.length) {
      this.el.style.display = 'none'
      return
    }
    this.el.style.display = 'block'
    if (this.mode === 'info') this.el.textContent = this.info(p)
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
      const body = (await res.json()) as { lines?: string[]; error?: string }
      if (mine !== this.token) return // a newer selection won the race
      if (!res.ok || !body.lines) {
        this.el.textContent = `[source]\n\n${body.error ?? res.statusText}`
        return
      }
      const width = String(to).length
      const numbered = body.lines
        .map((text, i) => `${String(from + i).padStart(width)}  ${text}`)
        .join('\n')
      this.el.textContent = `[source]  tab to swap\n\n${node?.name ?? id}\n${where.file}:${where.line}\n\n${numbered}`
    } catch (err) {
      if (mine === this.token) this.el.textContent = `[source]\n\n${String(err)}`
    }
  }
}
