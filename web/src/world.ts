import * as THREE from 'three'
import { MAX_LIFT, type PlacedEdge, type PlacedNode, type Placement } from './placement'
import { disposeSprite, labelWorldHeight, makeLabel, setLabelHeight } from './labels'
import { edgeKey, type Neighborhood } from './selection'

const LABEL_RANGE = 55 // symbol labels appear inside this radius
const DISTRICT_PX = 20 // on-screen label heights
const SYMBOL_PX = 13

// Edge colours. The unselected pair is dim-inside-a-package, bright-across it;
// once something is selected, direction matters more than distance.
const EDGE_INTRA = new THREE.Color(0x39415a)
const EDGE_CROSS = new THREE.Color(0xffc978)
const EDGE_IN = new THREE.Color(0x7dcfff) // someone calls the selection
const EDGE_OUT = new THREE.Color(0xff9e64) // the selection calls someone
const EDGE_MUTED = new THREE.Color(0x1a1f2b)

interface Materials {
  base: THREE.MeshLambertMaterial
  dim: THREE.MeshLambertMaterial
  hot: THREE.MeshLambertMaterial
}

/**
 * Turns a Placement into three.js objects. All the arithmetic already happened
 * in placement.ts; this file only draws. Rebuilt wholesale when either JSON
 * file changes — the camera lives outside it and is never touched.
 */
export class World {
  readonly group = new THREE.Group()

  private symbols: { node: PlacedNode; mesh: THREE.Mesh; pos: THREE.Vector3 }[] = []
  private symbolLabels = new Map<string, THREE.Sprite>()
  private districtLabels: THREE.Sprite[] = []
  private disposables: (() => void)[] = []
  private positions = new Map<string, THREE.Vector3>()

  private materials = new Map<number, Materials>()
  private meshes: THREE.Mesh[] = []
  private byId = new Map<string, { node: PlacedNode; mesh: THREE.Mesh }>()
  private edges: PlacedEdge[] = []
  private edgeColorAttr: THREE.Float32BufferAttribute | null = null
  /** Ids whose labels show regardless of distance, because they're selected. */
  private pinned = new Set<string>()

  build(p: Placement) {
    this.clear()
    this.buildDistricts(p)
    this.buildSymbols(p)
    this.buildEdges(p)
  }

  private buildSymbols(p: Placement) {
    const geom = new THREE.BoxGeometry(1, 1, 1)
    this.disposables.push(() => geom.dispose())

    for (const n of p.nodes) {
      const mats = this.materialsFor(n.color)

      const mesh = new THREE.Mesh(geom, mats.base)
      mesh.scale.setScalar(n.size)
      mesh.position.set(n.x, n.y, n.z)
      mesh.userData.id = n.id
      this.group.add(mesh)
      this.meshes.push(mesh)
      this.byId.set(n.id, { node: n, mesh })

      const pos = mesh.position.clone()
      this.positions.set(n.id, pos)
      this.symbols.push({ node: n, mesh, pos })

      // Stalk down to the ground, so a lifted symbol still reads as belonging
      // to its district.
      const foot = n.y - n.size / 2
      if (foot > 0.5) {
        const stalk = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(n.x, 0.1, n.z),
            new THREE.Vector3(n.x, foot, n.z),
          ]),
          new THREE.LineBasicMaterial({ color: n.color, transparent: true, opacity: 0.22 }),
        )
        this.group.add(stalk)
        this.disposables.push(() => {
          stalk.geometry.dispose()
          ;(stalk.material as THREE.Material).dispose()
        })
      }
    }
  }

  private buildDistricts(p: Placement) {
    const disc = new THREE.CircleGeometry(1, 48)
    this.disposables.push(() => disc.dispose())

    for (const d of p.districts) {
      const mat = new THREE.MeshBasicMaterial({ color: d.color, transparent: true, opacity: 0.07 })
      const floor = new THREE.Mesh(disc, mat)
      floor.rotation.x = -Math.PI / 2
      floor.scale.setScalar(d.radius)
      floor.position.set(d.x, 0, d.z)
      this.group.add(floor)
      this.disposables.push(() => mat.dispose())

      const rimGeom = new THREE.RingGeometry(0.985, 1, 64)
      const rimMat = new THREE.MeshBasicMaterial({ color: d.color, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
      const rim = new THREE.Mesh(rimGeom, rimMat)
      rim.rotation.x = -Math.PI / 2
      rim.scale.setScalar(d.radius)
      rim.position.set(d.x, 0.05, d.z)
      this.group.add(rim)
      this.disposables.push(() => {
        rimGeom.dispose()
        rimMat.dispose()
      })

      const label = makeLabel(`${d.label}  (${d.count})`, { size: 7, bg: 'rgba(10,13,20,0.72)' })
      label.position.set(d.x, MAX_LIFT + 16, d.z)
      this.group.add(label)
      this.districtLabels.push(label)
      this.disposables.push(() => disposeSprite(label))
    }
  }

  /** One LineSegments for everything; colours are rewritten on selection. */
  private buildEdges(p: Placement) {
    const verts: number[] = []
    const colors: number[] = []

    for (const e of p.edges) {
      const a = this.positions.get(e.from)
      const b = this.positions.get(e.to)
      if (!a || !b) continue
      this.edges.push(e)
      const c = e.cross ? EDGE_CROSS : EDGE_INTRA
      verts.push(a.x, a.y, a.z, b.x, b.y, b.z)
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }
    if (!verts.length) return

    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    const colorAttr = new THREE.Float32BufferAttribute(colors, 3)
    geom.setAttribute('color', colorAttr)
    this.edgeColorAttr = colorAttr
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7 })
    const lines = new THREE.LineSegments(geom, mat)
    this.group.add(lines)
    this.disposables.push(() => {
      geom.dispose()
      mat.dispose()
    })
  }

  private materialsFor(color: number): Materials {
    let mats = this.materials.get(color)
    if (mats) return mats
    mats = {
      base: new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.18 }),
      dim: new THREE.MeshLambertMaterial({
        color,
        transparent: true,
        opacity: 0.13,
        depthWrite: false,
      }),
      hot: new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 1.1 }),
    }
    this.materials.set(color, mats)
    const m = mats
    this.disposables.push(() => {
      m.base.dispose()
      m.dim.dispose()
      m.hot.dispose()
    })
    return mats
  }

  /**
   * Applies a neighbourhood: the selection burns bright, its callers and
   * callees stay lit, everything else drops back so the shape of the
   * neighbourhood is the only thing you can see.
   */
  applySelection(n: Neighborhood) {
    this.pinned = n.related

    for (const { node, mesh } of this.byId.values()) {
      const mats = this.materialsFor(node.color)
      if (n.empty) mesh.material = mats.base
      else if (n.selected.has(node.id)) mesh.material = mats.hot
      else if (n.related.has(node.id)) mesh.material = mats.base
      else mesh.material = mats.dim
    }

    const attr = this.edgeColorAttr
    if (!attr) return
    this.edges.forEach((e, i) => {
      let c: THREE.Color
      if (n.empty) c = e.cross ? EDGE_CROSS : EDGE_INTRA
      else {
        const role = n.role.get(edgeKey(e.from, e.to))
        c = role === 'in' ? EDGE_IN : role === 'out' ? EDGE_OUT : EDGE_MUTED
      }
      attr.setXYZ(i * 2, c.r, c.g, c.b)
      attr.setXYZ(i * 2 + 1, c.r, c.g, c.b)
    })
    attr.needsUpdate = true
  }

  /** The id of the symbol under a ray, or null. */
  pick(raycaster: THREE.Raycaster): string | null {
    const hits = raycaster.intersectObjects(this.meshes, false)
    return hits.length ? ((hits[0].object.userData.id as string) ?? null) : null
  }

  /**
   * Picking, but forgiving. A symbol can be a couple of units across and the
   * reticle is a few pixels wide, so an exact ray hit asks for more precision
   * than flying allows. If the ray misses, take the nearest symbol whose centre
   * projects within `radiusPx` of the reticle.
   */
  pickTolerant(
    camera: THREE.PerspectiveCamera,
    raycaster: THREE.Raycaster,
    radiusPx: number,
    viewport: { w: number; h: number },
  ): { id: string | null; exact: boolean; nearestPx: number | null } {
    const exact = this.pick(raycaster)
    if (exact) return { id: exact, exact: true, nearestPx: 0 }

    const v = new THREE.Vector3()
    let best: { id: string; d: number } | null = null
    for (const [id, { mesh }] of this.byId) {
      v.copy(mesh.position).project(camera)
      if (v.z > 1) continue // behind the camera
      const d = Math.hypot((v.x * viewport.w) / 2, (v.y * viewport.h) / 2)
      if (!best || d < best.d) best = { id, d }
    }
    if (!best) return { id: null, exact: false, nearestPx: null }
    return {
      id: best.d <= radiusPx ? best.id : null,
      exact: false,
      nearestPx: Math.round(best.d),
    }
  }

  nodeById(id: string): PlacedNode | undefined {
    return this.byId.get(id)?.node
  }

  /**
   * Labels are sized in pixels, not world units, so they stay readable at any
   * distance instead of ballooning as you fly into a district. Symbol labels
   * additionally only appear near the camera, to keep 70 boxes from turning
   * into 70 overlapping names.
   */
  updateLabels(camera: THREE.PerspectiveCamera, viewportHeight: number) {
    const eye = camera.position

    for (const label of this.districtLabels) {
      const h = labelWorldHeight(DISTRICT_PX, label.position.distanceTo(eye), camera.fov, viewportHeight, 0.05, 18)
      setLabelHeight(label, h)
    }

    for (const s of this.symbols) {
      const dist = s.pos.distanceTo(eye)
      // A selected symbol keeps its name up from anywhere — you selected it to
      // read it, and it is usually behind you by the time you stop moving.
      const near = dist < LABEL_RANGE || this.pinned.has(s.node.id)
      let label = this.symbolLabels.get(s.node.id)
      if (near && !label) {
        label = makeLabel(s.node.name, { size: 1, color: '#dbe4f3' })
        this.group.add(label)
        this.symbolLabels.set(s.node.id, label)
      }
      if (!label) continue
      label.visible = near
      if (!near) continue
      const h = labelWorldHeight(SYMBOL_PX, dist, camera.fov, viewportHeight, 0.05, 5)
      setLabelHeight(label, h)
      // Sit just clear of the box, whatever the label is currently sized to.
      label.position.set(s.pos.x, s.pos.y + s.node.size / 2 + h * 0.8, s.pos.z)
    }
  }

  positionOf(id: string): THREE.Vector3 | undefined {
    return this.positions.get(id)
  }

  clear() {
    for (const d of this.disposables) d()
    this.disposables = []
    for (const s of this.symbolLabels.values()) disposeSprite(s)
    this.symbolLabels.clear()
    this.districtLabels = []
    this.symbols = []
    this.positions.clear()
    this.materials.clear()
    this.meshes = []
    this.byId.clear()
    this.edges = []
    this.edgeColorAttr = null
    this.pinned = new Set()
    this.group.clear()
  }
}
