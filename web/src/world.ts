import * as THREE from 'three'
import { MAX_LIFT, type PlacedEdge, type PlacedNode, type Placement } from './placement'
import { disposeSprite, labelWorldHeight, makeLabel, setLabelHeight } from './labels'
import { edgeKey, type Neighborhood } from './selection'
import { devlog } from './devlog'
import type { ResolvedEdgeShow } from './types'

const LABEL_RANGE = 55 // symbol labels appear inside this radius
const DISTRICT_PX = 26 // on-screen label heights
const SYMBOL_PX = 17
const DISTRICT_LABELS = 14 // nearest N, so there is always something readable
const SYMBOL_LABELS = 24

// Edge colours. The unselected pair is dim-inside-a-package, bright-across it;
// once something is selected, direction matters more than distance.
const EDGE_INTRA = new THREE.Color(0x39415a)
const EDGE_CROSS = new THREE.Color(0xffc978)
const EDGE_IN = new THREE.Color(0x7dcfff) // someone calls the selection
const EDGE_OUT = new THREE.Color(0xff9e64) // the selection calls someone
const EDGE_INTERNAL = new THREE.Color(0xffffff) // both ends selected
const EDGE_MUTED = new THREE.Color(0x1a1f2b)

interface Symbol3D {
  node: PlacedNode
  /** Its slot in the buildings InstancedMesh, and its own index in `symbols`. */
  index: number
  pos: THREE.Vector3
}

/** Buildings stand along the local normal; this is the axis they start on. */
const POLE = new THREE.Vector3(0, 1, 0)

/**
 * One material for every building. Per-instance colour multiplies the diffuse
 * for free, but `emissive` is a uniform, and the per-node materials this
 * replaces used the node's own colour for it — dropping that would darken every
 * face the key light misses. The patch tints the emissive by the same instance
 * colour, so the look is what it was before instancing.
 */
function buildingMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff, // instanceColor supplies the hue
    emissive: 0xffffff,
    emissiveIntensity: 0.18,
  })
  const FROM = 'vec3 totalEmissiveRadiance = emissive;'
  mat.onBeforeCompile = (shader) => {
    // A three upgrade that renames this chunk would silently flatten the
    // buildings, so say so in the log rather than leaving it to be noticed.
    if (!shader.fragmentShader.includes(FROM)) {
      devlog('shader.patchMissed', { chunk: FROM })
      return
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      FROM,
      'vec3 totalEmissiveRadiance = emissive * vColor.rgb;',
    )
  }
  return mat
}

/**
 * Turns a Placement into three.js objects. All the arithmetic already happened
 * in placement.ts; this file only draws. Rebuilt wholesale when either JSON
 * file changes — the camera lives outside it and is never touched.
 */
export class World {
  readonly group = new THREE.Group()

  private symbols: Symbol3D[] = []
  private symbolLabels = new Map<string, THREE.Sprite>()
  private districtLabels: THREE.Sprite[] = []
  private disposables: (() => void)[] = []
  private positions = new Map<string, THREE.Vector3>()

  /** Per-colour material for the selected few, which are not instanced. */
  private hotMaterials = new Map<number, THREE.MeshLambertMaterial>()
  private buildings: THREE.InstancedMesh | null = null
  private boxGeom: THREE.BoxGeometry | null = null
  /** Each instance's matrix as built, so hiding one is reversible. */
  private baseMatrices = new Float32Array(0)
  /** On screen at all — instanced or drawn hot. Indexed like `symbols`. */
  private onScreen: boolean[] = []
  private hotMeshes: THREE.Mesh[] = []
  private byId = new Map<string, Symbol3D>()
  private edges: PlacedEdge[] = []
  private edgeColorAttr: THREE.Float32BufferAttribute | null = null
  private lines: THREE.LineSegments | null = null
  private activeLines: THREE.LineSegments | null = null
  private districtParts: {
    pkg: string
    centre: THREE.Vector3
    floor: THREE.Object3D
    rim: THREE.Object3D
    label: THREE.Sprite
  }[] = []
  private edgeShow: ResolvedEdgeShow = 'all'
  private edgeOpacity = 0.7
  /** Ids whose labels show regardless of distance, because they're selected. */
  private pinned = new Set<string>()
  private selecting = false
  /** Which symbols currently carry a label, and the camera that chose them. */
  private labelled: Symbol3D[] = []
  private districtChosen: THREE.Sprite[] = []
  private labelsDirty = true
  private lastEye = new THREE.Vector3(Infinity, 0, 0)
  private scratchA = new THREE.Vector3()
  private scratchB = new THREE.Vector3()

  build(p: Placement, opacity = 0.7) {
    this.clear()
    this.edgeShow = p.edgeShow
    this.edgeOpacity = opacity
    this.buildDistricts(p)
    this.buildSymbols(p)
    this.buildEdges(p)
  }

  /**
   * Every symbol is one instance of a single box. A mesh per symbol cost 273ms
   * a frame on coder's 18,522 of them at twelve draw calls — three.js walks and
   * culls every object in the scene each frame, so the bill was traversal, not
   * drawing. One object carries the whole crust.
   */
  private buildSymbols(p: Placement) {
    if (!p.nodes.length) return
    const geom = new THREE.BoxGeometry(1, 1, 1)
    this.boxGeom = geom
    const mat = buildingMaterial()
    const mesh = new THREE.InstancedMesh(geom, mat, p.nodes.length)
    this.disposables.push(() => {
      geom.dispose()
      mat.dispose()
      mesh.dispose()
    })

    const m = new THREE.Matrix4()
    const quat = new THREE.Quaternion()
    const up = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const pos = new THREE.Vector3()
    const color = new THREE.Color()

    p.nodes.forEach((n, i) => {
      // Buildings stand along the local normal and straddle the ground, so no
      // stalk is needed to tie one to its district — it passes through it.
      up.set(n.nx, n.ny, n.nz)
      quat.setFromUnitVectors(POLE, up)
      scale.set(n.size, n.height, n.size)
      pos.set(n.x, n.y, n.z)
      mesh.setMatrixAt(i, m.compose(pos, quat, scale))
      mesh.setColorAt(i, color.setHex(n.color))

      const at = pos.clone()
      this.positions.set(n.id, at)
      const s: Symbol3D = { node: n, index: i, pos: at }
      this.symbols.push(s)
      this.byId.set(n.id, s)
      this.onScreen.push(true)
    })

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    // Culling needs the extent of the instances, not of the unit box.
    mesh.computeBoundingSphere()
    // Nothing moves after placement, here or on the object itself.
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    this.baseMatrices = new Float32Array(mesh.instanceMatrix.array)
    this.group.add(mesh)
    this.buildings = mesh
  }

  private buildDistricts(p: Placement) {
    // A district is a patch of the crust, not a card lying on top of one: a
    // spherical cap of the same sphere, so its edge follows the curve and its
    // symbols stand radially out of it.
    // POLE is SphereGeometry's own pole as well as the box's standing axis.
    const normal = new THREE.Vector3()
    const quat = new THREE.Quaternion()

    p.districts.forEach((d, index) => {
      normal.set(d.normal.x, d.normal.y, d.normal.z)
      quat.setFromUnitVectors(POLE, normal)

      // Each cap gets its own hair's-breadth radius. They are patches of one
      // sphere, so any two that abut are coplanar, and coplanar surfaces have
      // no stable answer to which is in front — that is the bright slashing
      // where districts meet.
      const capR = (p.shell || d.radius) * (1 + index * 0.00004)
      const capGeom = new THREE.SphereGeometry(capR, 40, 20, 0, Math.PI * 2, 0, d.cap)
      // Opaque ground, tinted with the district's colour. Transparency was the
      // whole problem: alpha blending depends on paint order, dozens of caps
      // overlap on screen from anywhere inside the shell, and turning the
      // camera reshuffles that order — so the surfaces wobbled. Depth-tested
      // opaque geometry has exactly one right answer for what is in front, and
      // it does not depend on where you are looking from.
      const mat = new THREE.MeshBasicMaterial({
        // Barely above the background. The ground exists to occlude what is
        // behind it and to give the buildings something to stand on; the rim
        // carries the district's identity and the symbols carry its colour.
        // Anything brighter and a district reads as a solid disc of one hue
        // with its contents lost inside it.
        color: new THREE.Color(0x0b0e14).lerp(new THREE.Color(d.color), 0.06),
        side: THREE.DoubleSide,
      })
      const floor = new THREE.Mesh(capGeom, mat)
      floor.quaternion.copy(quat)
      floor.matrixAutoUpdate = false
      floor.updateMatrix()
      floor.renderOrder = -1000 + index * 2
      this.group.add(floor)
      this.disposables.push(() => {
        capGeom.dispose()
        mat.dispose()
      })

      // Rim: the circle where the cap meets the rest of the shell, drawn a
      // whisker outside it so the two are not coplanar and fighting for depth.
      const rimPoints: THREE.Vector3[] = []
      const R = (p.shell || d.radius) * 1.002
      for (let k = 0; k <= 64; k++) {
        const a = (k / 64) * Math.PI * 2
        rimPoints.push(
          new THREE.Vector3(
            R * Math.sin(d.cap) * Math.cos(a),
            R * Math.cos(d.cap),
            R * Math.sin(d.cap) * Math.sin(a),
          ),
        )
      }
      const rimGeom = new THREE.BufferGeometry().setFromPoints(rimPoints)
      const rimMat = new THREE.LineBasicMaterial({
        color: d.color,
        transparent: true,
        opacity: 0.55,
      })
      const rim = new THREE.Line(rimGeom, rimMat)
      rim.quaternion.copy(quat)
      rim.matrixAutoUpdate = false
      rim.updateMatrix()
      rim.renderOrder = -1000 + index * 2 + 1
      this.group.add(rim)
      this.disposables.push(() => {
        rimGeom.dispose()
        rimMat.dispose()
      })

      // Package paths break at the slash, so a label is two short lines rather
      // than one long one — they collide far less at the same legibility.
      const label = makeLabel(`${d.label.split('/').join('\n')}\n(${d.count})`, {
        size: 7,
        bg: 'rgba(10,13,20,0.85)',
        onTop: false, // fog was the reason distant names vanished; depth still tells you which district a name belongs to
      })
      // The cap is centred on the origin like the sphere it belongs to, so the
      // label hangs off the district's own centre rather than the mesh's.
      label.position
        .set(d.centre.x, d.centre.y, d.centre.z)
        .addScaledVector(normal, -(MAX_LIFT + 4))
      this.group.add(label)
      this.districtLabels.push(label)
      this.districtParts.push({
        pkg: d.pkg,
        centre: new THREE.Vector3(d.centre.x, d.centre.y, d.centre.z),
        floor,
        rim,
        label,
      })
      this.disposables.push(() => disposeSprite(label))
    })
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
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: this.edgeOpacity,
    })
    const lines = new THREE.LineSegments(geom, mat)
    this.lines = lines
    this.group.add(lines)
    this.disposables.push(() => {
      geom.dispose()
      mat.dispose()
    })
  }

  /** The selected symbol's material: white, lit from inside in its own hue. */
  private hotMaterialFor(color: number): THREE.MeshLambertMaterial {
    let mat = this.hotMaterials.get(color)
    if (mat) return mat
    mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 1.1 })
    this.hotMaterials.set(color, mat)
    const m = mat
    this.disposables.push(() => m.dispose())
    return mat
  }

  /**
   * Show or hide one instance. InstancedMesh has no per-instance visibility, so
   * a hidden one keeps its position and loses its basis: eight corners at one
   * point, which rasterises to nothing and cannot be hit by a ray.
   */
  private setInstanceShown(i: number, shown: boolean) {
    const dst = this.buildings!.instanceMatrix.array as Float32Array
    const src = this.baseMatrices
    const o = i * 16
    if (shown) {
      dst.set(src.subarray(o, o + 16), o)
      return
    }
    for (let k = 0; k < 12; k++) dst[o + k] = 0 // the three basis columns
    dst[o + 12] = src[o + 12]
    dst[o + 13] = src[o + 13]
    dst[o + 14] = src[o + 14]
    dst[o + 15] = 1
  }

  private clearHot() {
    for (const mesh of this.hotMeshes) mesh.removeFromParent()
    this.hotMeshes = []
  }

  /**
   * The selection itself is a handful of real meshes rather than instances.
   * Its material differs in more than colour — white with a strong emissive —
   * and per-instance colour cannot express that. One or two objects is not a
   * traversal cost worth avoiding.
   */
  private addHot(node: PlacedNode) {
    if (!this.boxGeom) return
    const mesh = new THREE.Mesh(this.boxGeom, this.hotMaterialFor(node.color))
    mesh.quaternion.setFromUnitVectors(POLE, new THREE.Vector3(node.nx, node.ny, node.nz))
    mesh.scale.set(node.size, node.height, node.size)
    mesh.position.set(node.x, node.y, node.z)
    mesh.userData.id = node.id
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    this.group.add(mesh)
    this.hotMeshes.push(mesh)
  }

  /**
   * Applies a neighbourhood: the selection burns bright, its callers and
   * callees stay lit, everything else drops back so the shape of the
   * neighbourhood is the only thing you can see.
   */
  applySelection(n: Neighborhood) {
    this.pinned = n.related
    this.selecting = !n.empty
    this.labelsDirty = true

    // Dimming does not scale. At 1600 symbols, 13% opacity each is a haze you
    // cannot see through, so a selection hides the symbols it is not about.
    //
    // Its own district is not one of those. A symbol alone on an empty disc is
    // not standing anywhere, and arriving by search rather than by flying is
    // exactly when you have no idea where that is — so the packages the
    // selection lives in keep all of their buildings.
    const home = new Set<string>()
    if (!n.empty) {
      for (const id of n.selected) {
        const s = this.byId.get(id)
        if (s) home.add(s.node.pkg)
      }
    }

    this.clearHot()
    for (const s of this.symbols) {
      const node = s.node
      const shown = n.empty || n.related.has(node.id) || home.has(node.pkg)
      const hot = !n.empty && n.selected.has(node.id)
      this.onScreen[s.index] = shown
      // A hot symbol is drawn by its own mesh, so its instance stands down.
      if (this.buildings) this.setInstanceShown(s.index, shown && !hot)
      if (hot) this.addHot(node)
    }
    if (this.buildings) this.buildings.instanceMatrix.needsUpdate = true

    // The ground stays, all of it. Districts used to hide with their contents,
    // from back when a cap was a translucent disc and dozens of them stacked
    // between you and the thing you picked. They have been opaque for a while:
    // the near crust hides the far side by itself, and what is left is the map
    // you are standing on.

    this.buildNeighbourhoodEdges(n)

    // At rest, `selected` and `none` draw nothing at all: 954 bright chords
    // across the shell is the hairball the districts exist to avoid.
    if (this.lines) {
      this.lines.visible =
        n.empty === false
          ? false // the neighbourhood lines take over entirely
          : this.edgeShow === 'none' || this.edgeShow === 'selected'
            ? false
            : true
    }

    const attr = this.edgeColorAttr
    if (!attr || !n.empty) return
    this.edges.forEach((e, i) => {
      const c = this.edgeShow === 'cross' && !e.cross ? EDGE_MUTED : e.cross ? EDGE_CROSS : EDGE_INTRA
      attr.setXYZ(i * 2, c.r, c.g, c.b)
      attr.setXYZ(i * 2 + 1, c.r, c.g, c.b)
    })
    attr.needsUpdate = true
  }

  /**
   * A separate, tiny geometry holding only the selection's own edges. Recolouring
   * the full set and leaving the rest muted still draws 2000 faint lines across
   * everything, which is the difference between quiet and invisible.
   */
  private buildNeighbourhoodEdges(n: Neighborhood) {
    this.activeLines?.removeFromParent()
    this.activeLines?.geometry.dispose()
    ;(this.activeLines?.material as THREE.Material | undefined)?.dispose()
    this.activeLines = null
    if (n.empty) return

    const verts: number[] = []
    const colors: number[] = []
    for (const e of this.edges) {
      const role = n.role.get(edgeKey(e.from, e.to))
      if (!role || role === 'none') continue
      const a = this.positions.get(e.from)
      const b = this.positions.get(e.to)
      if (!a || !b) continue
      const c = role === 'in' ? EDGE_IN : role === 'out' ? EDGE_OUT : EDGE_INTERNAL
      verts.push(a.x, a.y, a.z, b.x, b.y, b.z)
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }
    if (!verts.length) return

    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    this.activeLines = new THREE.LineSegments(
      geom,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }),
    )
    this.group.add(this.activeLines)
  }

  /** The id of the symbol under a ray, or null. */
  pick(raycaster: THREE.Raycaster): string | null {
    const targets: THREE.Object3D[] = [...this.hotMeshes]
    if (this.buildings) targets.push(this.buildings)
    const hits = raycaster.intersectObjects(targets, false)
    for (const hit of hits) {
      if (hit.instanceId === undefined) return (hit.object.userData.id as string) ?? null
      const s = this.symbols[hit.instanceId]
      // A hidden instance is degenerate and should not be hit at all, but a ray
      // that grazes one must not select something nobody can see.
      if (s && this.onScreen[s.index]) return s.node.id
    }
    return null
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
    for (const s of this.symbols) {
      if (!this.onScreen[s.index]) continue // a selection hides most of them
      v.copy(s.pos).project(camera)
      if (v.z > 1) continue // behind the camera
      const d = Math.hypot((v.x * viewport.w) / 2, (v.y * viewport.h) / 2)
      if (!best || d < best.d) best = { id: s.node.id, d }
    }
    if (!best) return { id: null, exact: false, nearestPx: null }
    return {
      id: best.d <= radiusPx ? best.id : null,
      exact: false,
      nearestPx: Math.round(best.d),
    }
  }

  /** What the labels are actually doing, for the log. */
  labelStats() {
    const d = this.districtLabels.filter((l) => l.visible)
    const s = [...this.symbolLabels.values()].filter((l) => l.visible)
    return {
      districtsVisible: d.length,
      districtsTotal: this.districtLabels.length,
      symbolsVisible: s.length,
      sample: d[0] ? { scaleY: +d[0].scale.y.toFixed(2), pos: d[0].position.toArray().map((v) => Math.round(v)) } : null,
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

    // Float each name on whichever side of its district the camera is on. Park
    // it at a fixed offset and the district's own cap occludes it from one side
    // — which is what happens to a label sitting inside the shell when you are
    // outside it.
    const toCamera = this.scratchA
    for (const part of this.districtParts) {
      toCamera.copy(eye).sub(part.centre)
      const len = toCamera.length() || 1
      part.label.position.copy(part.centre).addScaledVector(toCamera, (MAX_LIFT + 6) / len)
    }

    // Choosing *which* labels to show is a pass over every symbol, so it only
    // happens when the camera has actually moved. At coder's 18,522 symbols,
    // scanning and sorting per frame cost 270ms a frame — the scene itself was
    // drawing in 50 calls, and labels were eating the whole budget.
    if (this.labelsDirty || eye.distanceToSquared(this.lastEye) > 4) {
      this.chooseLabels(eye)
      this.lastEye.copy(eye)
      this.labelsDirty = false
    }

    // Sizing the chosen few is cheap, and has to happen every frame so they
    // hold their pixel height as you move. Visibility is reasserted here rather
    // than inherited: declutter hides some of them below, and that decision has
    // to be reconsidered each frame rather than latching a label off forever.
    for (const label of this.districtChosen) {
      label.visible = true
      const d = label.position.distanceTo(eye)
      setLabelHeight(label, labelWorldHeight(DISTRICT_PX, d, camera.fov, viewportHeight, 0.05, 1e6))
    }
    const away = this.scratchB
    for (const s of this.labelled) {
      const label = this.symbolLabels.get(s.node.id)
      if (!label) continue
      label.visible = true
      const d = s.pos.distanceTo(eye)
      const h = labelWorldHeight(SYMBOL_PX, d, camera.fov, viewportHeight, 0.05, 1e6)
      setLabelHeight(label, h)
      // Sit just clear of the box, on the side the camera is on.
      away.copy(s.pos).sub(eye).normalize().multiplyScalar(-(s.node.size / 2 + h * 0.8))
      label.position.copy(s.pos).add(away)
    }

    this.declutter(camera, viewportHeight)
  }

  /**
   * Hide any label whose text would land on top of one already placed. Picking
   * the nearest N is not enough on its own: 835 callers of one function sit in
   * the same square inch of screen from a distance, and 24 names drawn there
   * are a smear rather than 24 names. Nearest wins, districts before symbols.
   */
  private declutter(camera: THREE.PerspectiveCamera, viewportHeight: number) {
    const viewportWidth = viewportHeight * camera.aspect
    const taken: { x: number; y: number; w: number; h: number }[] = []
    const p = this.scratchA

    const place = (label: THREE.Sprite, pad: number) => {
      p.copy(label.position).project(camera)
      if (p.z > 1) {
        label.visible = false // behind the camera
        return
      }
      // Sprite scale is a world height; on screen it is that over the frustum
      // height at this depth, which is what the projection has already applied.
      const h = (label.scale.y / (label.position.distanceTo(camera.position) * 2 * Math.tan((camera.fov * Math.PI) / 360))) * viewportHeight
      const w = h * ((label.userData.aspect as number) || 1)
      const x = (p.x * viewportWidth) / 2
      const y = (p.y * viewportHeight) / 2
      for (const t of taken) {
        if (Math.abs(x - t.x) < (w + t.w) / 2 + pad && Math.abs(y - t.y) < (h + t.h) / 2 + pad) {
          label.visible = false
          return
        }
      }
      taken.push({ x, y, w, h })
    }

    for (const label of this.districtChosen) if (label.visible) place(label, 6)
    for (const s of this.labelled) {
      const label = this.symbolLabels.get(s.node.id)
      if (label?.visible) place(label, 2)
    }
  }

  /**
   * Nearest-N rather than everything-within-D: from across a 355-district shell
   * the second rule gives either a wall of overlapping text or nothing at all.
   * Keeps a small best-of list in one pass rather than sorting every symbol.
   */
  private chooseLabels(eye: THREE.Vector3) {
    const best: { s: Symbol3D; d: number }[] = []
    let worst = Infinity
    const range = LABEL_RANGE * LABEL_RANGE

    for (const s of this.symbols) {
      // With a selection up, only the neighbourhood is labelled — at any
      // distance, since you selected it to read it and it is usually behind you
      // by the time you stop moving.
      if (this.selecting && !this.pinned.has(s.node.id)) continue
      const d = s.pos.distanceToSquared(eye)
      if (!this.selecting && d > range) continue
      if (best.length === SYMBOL_LABELS && d >= worst) continue
      let at = best.length
      while (at > 0 && best[at - 1].d > d) at--
      best.splice(at, 0, { s, d })
      if (best.length > SYMBOL_LABELS) best.pop()
      worst = best[best.length - 1].d
    }

    this.labelled = best.map((b) => b.s)
    const shown = new Set(this.labelled.map((s) => s.node.id))
    for (const s of this.labelled) {
      let label = this.symbolLabels.get(s.node.id)
      if (!label) {
        label = makeLabel(s.node.name, { size: 1, color: '#dbe4f3', onTop: this.selecting })
        this.group.add(label)
        this.symbolLabels.set(s.node.id, label)
      }
      label.visible = true
    }
    for (const [id, label] of this.symbolLabels) {
      if (!shown.has(id)) label.visible = false
    }

    const districts = this.districtParts
      .map((part) => ({ part, d: part.label.position.distanceToSquared(eye) }))
      .sort((a, b) => a.d - b.d)
    this.districtChosen = []
    districts.forEach(({ part }, i) => {
      const wanted = i < DISTRICT_LABELS
      part.label.visible = wanted
      if (wanted) this.districtChosen.push(part.label)
    })
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
    this.hotMaterials.clear()
    this.hotMeshes = []
    this.buildings = null
    this.boxGeom = null
    this.baseMatrices = new Float32Array(0)
    this.onScreen = []
    this.byId.clear()
    this.edges = []
    this.edgeColorAttr = null
    this.lines = null
    this.activeLines = null
    this.districtParts = []
    this.pinned = new Set()
    this.selecting = false
    this.labelled = []
    this.districtChosen = []
    this.labelsDirty = true
    this.group.clear()
  }
}
