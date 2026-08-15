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
  camera: {
    focus: string | null
    distance: number
  }
}
