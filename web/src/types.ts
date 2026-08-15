export interface GraphNode {
  id: string
  name: string
  pkg: string
  file: string
  line: number
  lines: number
  exported: boolean
  fanIn: number
  fanOut: number
}

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
export type EdgeShow = 'auto' | 'all' | 'cross' | 'selected' | 'none'
export type ResolvedEdgeShow = Exclude<EdgeShow, 'auto'>

export interface ViewSpec {
  occupants: {
    packages: string[]
    minFanIn: number
    limit: number
  }
  encoding: {
    size: NodeField
    color: NodeField
    height: NodeField
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
   * Symbol ids to light up on load. Empty means "leave whatever is selected in
   * the browser alone", so editing the rest of the file doesn't wipe a
   * selection you made by clicking.
   */
  select: string[]
}
