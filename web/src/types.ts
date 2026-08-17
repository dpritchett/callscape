import type { LabelMode } from './labelmode'

export type { LabelMode }

export interface GraphNode {
  id: string
  name: string
  pkg: string
  file: string
  line: number
  lines: number
  exported: boolean
  /** Declared in a file with a "Code generated ... DO NOT EDIT." header. */
  generated: boolean
  fanIn: number
  fanOut: number
  /** Distinct calling/called packages, rather than call sites. */
  fanInPkgs: number
  fanOutPkgs: number
}

/** What to do with generated symbols, which can be a third of a codebase. */
export type GeneratedFilter = 'include' | 'exclude' | 'only'

export interface GraphEdge {
  from: string
  to: string
}

export interface Graph {
  module: string
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** Fields of GraphNode usable in `encoding`. */
export type NodeField = keyof GraphNode

/**
 * How much of the call graph to draw at rest.
 *  auto     — all of it while that is still legible, otherwise `selected`
 *  all      — every edge, dim inside a package and bright across one
 *  cross    — only the edges that leave a package
 *  selected — nothing until you select something, then its neighbourhood
 *  none     — never
 */
export type ScaleKind = 'linear' | 'sqrt' | 'log'

export type EdgeShow = 'auto' | 'all' | 'cross' | 'selected' | 'none'
export type ResolvedEdgeShow = Exclude<EdgeShow, 'auto'>

export interface ViewSpec {
  occupants: {
    packages: string[]
    minFanIn: number
    limit: number
    generated: GeneratedFilter
  }
  encoding: {
    size: NodeField
    color: NodeField
    height: NodeField
    /**
     * How a numeric field maps onto its range. Fan-in spans 0 to 837 on coder,
     * so linear puts almost every symbol in the bottom few percent and they all
     * come out the same size; log spreads the crowded low end apart.
     */
    scale: ScaleKind
  }
  edges: {
    show: EdgeShow
    opacity: number
  }
  camera: {
    focus: string | null
    distance: number
  }
  /**
   * The navigator's voice. Here rather than in browser state so it is turned
   * down the same way everything else is — edit the file, hear it change,
   * without reaching for a key nobody will remember.
   */
  sound: {
    enabled: boolean
    volume: number
  }
  /**
   * How much of the scene is named. This one is a starting position rather than
   * a setting: the ribbon on the glass moves it from a d-pad or a click, and
   * only an actual edit to this value takes it back off you.
   */
  labels: {
    mode: LabelMode
  }
  /**
   * Symbol ids to light up on load. Empty means "leave whatever is selected in
   * the browser alone", so editing the rest of the file doesn't wipe a
   * selection you made by clicking.
   */
  select: string[]
}
