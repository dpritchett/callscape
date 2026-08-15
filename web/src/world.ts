import * as THREE from 'three'
import { MAX_LIFT, type PlacedNode, type Placement } from './placement'
import { disposeSprite, labelWorldHeight, makeLabel, setLabelHeight } from './labels'

const LABEL_RANGE = 55 // symbol labels appear inside this radius
const DISTRICT_PX = 20 // on-screen label heights
const SYMBOL_PX = 13

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

  build(p: Placement) {
    this.clear()
    this.buildDistricts(p)
    this.buildSymbols(p)
    this.buildEdges(p)
  }

  private buildSymbols(p: Placement) {
    const geom = new THREE.BoxGeometry(1, 1, 1)
    this.disposables.push(() => geom.dispose())
    const mats = new Map<number, THREE.MeshLambertMaterial>()

    for (const n of p.nodes) {
      let mat = mats.get(n.color)
      if (!mat) {
        mat = new THREE.MeshLambertMaterial({ color: n.color, emissive: n.color, emissiveIntensity: 0.18 })
        mats.set(n.color, mat)
        const m = mat
        this.disposables.push(() => m.dispose())
      }

      const mesh = new THREE.Mesh(geom, mat)
      mesh.scale.setScalar(n.size)
      mesh.position.set(n.x, n.y, n.z)
      this.group.add(mesh)

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

  /** One LineSegments for everything; cross-district edges get the bright colour. */
  private buildEdges(p: Placement) {
    const verts: number[] = []
    const colors: number[] = []
    const dim = new THREE.Color(0x39415a)
    const bright = new THREE.Color(0xffc978)

    for (const e of p.edges) {
      const a = this.positions.get(e.from)
      const b = this.positions.get(e.to)
      if (!a || !b) continue
      const c = e.cross ? bright : dim
      verts.push(a.x, a.y, a.z, b.x, b.y, b.z)
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }
    if (!verts.length) return

    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7 })
    const lines = new THREE.LineSegments(geom, mat)
    this.group.add(lines)
    this.disposables.push(() => {
      geom.dispose()
      mat.dispose()
    })
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
      const near = dist < LABEL_RANGE
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
    this.group.clear()
  }
}
