import type { EdgeShow, NodeField, ScaleKind, ViewSpec } from './types'

const EDGE_SHOWS: EdgeShow[] = ['auto', 'all', 'cross', 'selected', 'none']
const SCALES: ScaleKind[] = ['linear', 'sqrt', 'log']

const NODE_FIELDS: NodeField[] = [
  'id', 'name', 'pkg', 'file', 'line', 'lines', 'exported', 'fanIn', 'fanOut',
]

/**
 * Parses view.json as a closed struct: any key we do not know about is an
 * error, not something to ignore. A typo in a config file should be loud.
 */
export function parseView(raw: unknown): ViewSpec {
  const errs: string[] = []
  const root = obj(raw, 'view.json', errs, [
    'occupants',
    'encoding',
    'camera',
    'select',
    'edges',
  ])

  const occ = obj(root.occupants, 'occupants', errs, ['packages', 'minFanIn', 'limit'])
  const enc = obj(root.encoding, 'encoding', errs, ['size', 'color', 'height', 'scale'])
  const cam = obj(root.camera, 'camera', errs, ['focus', 'distance'])
  const edg = obj(root.edges ?? {}, 'edges', errs, ['show', 'opacity'])

  const view: ViewSpec = {
    occupants: {
      packages: strArray(occ.packages, 'occupants.packages', errs, ['*']),
      minFanIn: num(occ.minFanIn, 'occupants.minFanIn', errs, 0),
      limit: num(occ.limit, 'occupants.limit', errs, 100),
    },
    encoding: {
      size: field(enc.size, 'encoding.size', errs, 'fanIn'),
      color: field(enc.color, 'encoding.color', errs, 'pkg'),
      height: field(enc.height, 'encoding.height', errs, 'lines'),
      scale: scaleKind(enc.scale, 'encoding.scale', errs),
    },
    camera: {
      focus: str(cam.focus, 'camera.focus', errs),
      distance: num(cam.distance, 'camera.distance', errs, 120),
    },
    edges: {
      show: edgeShow(edg.show, 'edges.show', errs),
      opacity: num(edg.opacity, 'edges.opacity', errs, 0.7),
    },
    select: strArray(root.select, 'select', errs, []),
  }

  if (errs.length) throw new Error(errs.join('\n'))
  return view
}

type Bag = Record<string, unknown>

function obj(v: unknown, path: string, errs: string[], allowed: string[]): Bag {
  if (v === undefined || v === null) {
    errs.push(`${path}: missing`)
    return {}
  }
  if (typeof v !== 'object' || Array.isArray(v)) {
    errs.push(`${path}: expected an object`)
    return {}
  }
  const bag = v as Bag
  for (const k of Object.keys(bag)) {
    if (!allowed.includes(k)) {
      errs.push(`${path}.${k}: unknown field (allowed: ${allowed.join(', ')})`)
    }
  }
  return bag
}

function strArray(v: unknown, path: string, errs: string[], dflt: string[]): string[] {
  if (v === undefined) return dflt
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    errs.push(`${path}: expected an array of strings`)
    return dflt
  }
  return v as string[]
}

function num(v: unknown, path: string, errs: string[], dflt: number): number {
  if (v === undefined) return dflt
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errs.push(`${path}: expected a number`)
    return dflt
  }
  return v
}

function str(v: unknown, path: string, errs: string[]): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') {
    errs.push(`${path}: expected a string`)
    return null
  }
  return v
}

function scaleKind(v: unknown, path: string, errs: string[]): ScaleKind {
  // Log by default: on a real codebase the interesting fields are heavily
  // skewed, and linear makes every symbol below the top percentile identical.
  if (v === undefined) return 'log'
  if (typeof v !== 'string' || !SCALES.includes(v as ScaleKind)) {
    errs.push(`${path}: expected one of ${SCALES.join(', ')}`)
    return 'log'
  }
  return v as ScaleKind
}

function edgeShow(v: unknown, path: string, errs: string[]): EdgeShow {
  if (v === undefined) return 'auto'
  if (typeof v !== 'string' || !EDGE_SHOWS.includes(v as EdgeShow)) {
    errs.push(`${path}: expected one of ${EDGE_SHOWS.join(', ')}`)
    return 'auto'
  }
  return v as EdgeShow
}

function field(v: unknown, path: string, errs: string[], dflt: NodeField): NodeField {
  if (v === undefined) return dflt
  if (typeof v !== 'string' || !NODE_FIELDS.includes(v as NodeField)) {
    errs.push(`${path}: expected one of ${NODE_FIELDS.join(', ')}`)
    return dflt
  }
  return v as NodeField
}
