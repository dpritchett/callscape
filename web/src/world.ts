import * as THREE from 'three'
import { MAX_LIFT, type PlacedEdge, type PlacedNode, type Placement } from './placement'
import {
  axisAnchor,
  disposeSprite,
  fadeOpacity,
  fadePresence,
  frustumEdgeCosine,
  labelRank,
  labelWorldHeight,
  makeLabel,
  makeNeonPanel,
  roundTexture,
  setLabelHeight,
} from './labels'
import { aimedOnly, namesDistricts, namesSymbols, type LabelMode } from './labelmode'
import { edgeKey, type Neighborhood } from './selection'
import { arcPoints } from './wires'
import { devlog } from './devlog'
import type { ResolvedEdgeShow } from './types'

// How far a symbol can be and still be named. Labels hold a fixed pixel height
// whatever the distance, so this is not about legibility — it is about how far
// out a name still means something. At 55 it meant you had to be inside a
// district to read any of it, and from the distance where a district is a
// shape rather than a floor, its contents were anonymous. At 320 the same thing
// happened one altitude higher: the district under the reticle was too far to
// have any names while the one under the nose had all of them.
const LABEL_RANGE = 900
// The discus each mark is printed on, and the name floating in front of it.
// Thickness and the icon are fractions of the disc; the name's drop and float
// are fractions of its radius.
const DISCUS_FLATNESS = 0.16
const ICON_FRACTION = 0.62
const NAME_HEIGHT = 0.12
const NAME_DROP = 0.72
const NAME_FLOAT = 0.55
const DISTRICT_PX = 26 // on-screen label heights
const SYMBOL_PX = 17
// How many names compete for the screen. These are the *candidates*, not the
// count you see: declutter drops whatever collides, so on a crowded view the
// limit is the screen itself. That is the point of sizing them this high — a
// small pool spends every slot on the same corner of the frame and leaves the
// rest of the view anonymous however it is ranked.
const DISTRICT_LABELS = 90 // best N, so there is always something readable
const SYMBOL_LABELS = 160
/**
 * Symbol labels are built on demand and kept, since flying back and forth over
 * the same district would otherwise rebuild the same canvases every couple of
 * degrees. Each one is a texture, though, so the cache is capped: past this,
 * anything not currently shown is dropped.
 */
const LABEL_CACHE = 600
/** How long a label takes to arrive or leave, as a rate per second. */
const LABEL_FADE = 5
/**
 * District names claim their space before any symbol name, but only this many
 * of them. Past that the two kinds compete on rank, so flying down among the
 * buildings hands the screen to the buildings without the map going anonymous.
 */
const RESERVED_DISTRICTS = 6
/** Clear space each kind of name keeps around itself, in pixels. */
const DISTRICT_PAD = 6
const SYMBOL_PAD = 2

/** Ask a label to be there or not; `fade` is what gets it there. */
function setWant(label: THREE.Sprite, want: number) {
  label.userData.want = want
}

/**
 * Advance one label towards what it was asked for. A label that has arrived, or
 * that left a while ago, costs two property reads and nothing else.
 */
function fade(label: THREE.Sprite, dt: number) {
  const want = (label.userData.want as number) ?? 0
  const was = (label.userData.presence as number) ?? 0
  if (was === want) {
    label.visible = want > 0
    return
  }
  const now = fadePresence(was, want, dt, LABEL_FADE)
  label.userData.presence = now
  ;(label.material as THREE.SpriteMaterial).opacity = fadeOpacity(now)
  label.visible = now > 0
}
/** About two degrees: how far the camera can turn before labels are rechosen. */
const TURN_COSINE = Math.cos((2 * Math.PI) / 180)
/** How far an in-district edge rides above the ground it crosses. */
const WIRE_LIFT = 3
/**
 * The selection's heartbeat. Slow enough to read as breathing rather than as a
 * strobe, fast enough that a glance catches it moving.
 */
const PULSE_HZ = 0.8
const HOT_EMISSIVE = [0.5, 2.1] as const
/**
 * How far a floor facing the selection head-on is tinted towards it, at the top
 * of the beat.
 *
 * Lower than it looks like it should be. The lerp happens in linear space and
 * the picture is sRGB, so on ground this dark a small step lands as a large
 * one on screen — at 0.3 the far wall stopped being its own district and became
 * a purple one. Turn this down if it shouts; the signal is meant to be the
 * breathing rather than the colour.
 */
const GROUND_LIT = 0.22
/** Enough that the sag between two segments stays under half a unit. */
const WIRE_SEGMENTS = 8

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
  /** Per edge, where its segments start in the buffer and how many there are. */
  private edgeSpans: [number, number][] = []
  private edgeColorAttr: THREE.Float32BufferAttribute | null = null
  private lines: THREE.LineSegments | null = null
  private activeLines: THREE.LineSegments | null = null
  private districtParts: {
    pkg: string
    centre: THREE.Vector3
    /** Which way this district's ground faces, for lighting it by hand. */
    normal: THREE.Vector3
    /** How wide it is, for working out whether you are looking at it. */
    radius: number
    floor: THREE.Mesh
    /** Its unlit colour, to tint away from and back to. */
    ground: THREE.Color
    rim: THREE.Object3D
    label: THREE.Sprite
  }[] = []
  /** Radius of the shell, which sets the scale everything distance-based uses. */
  private shell = 1
  private edgeShow: ResolvedEdgeShow = 'all'
  private edgeOpacity = 0.7
  /** Ids whose labels show regardless of distance, because they're selected. */
  private pinned = new Set<string>()
  private selecting = false
  /**
   * Which symbols and districts currently carry a label, best first, with the
   * rank that got them there — declutter packs the two lists together in that
   * order, so it needs the scores to interleave them.
   */
  private labelled: { s: Symbol3D; rank: number }[] = []
  private districtChosen: { label: THREE.Sprite; rank: number }[] = []
  private labelMode: LabelMode = 'all'
  /** The district the reticle is on, while `aim` is what the ribbon says. */
  private aimedPkg: string | null = null
  private labelsDirty = true
  private lastEye = new THREE.Vector3(Infinity, 0, 0)
  private lastDir = new THREE.Vector3(0, 0, 0)
  private scratchA = new THREE.Vector3()
  private scratchB = new THREE.Vector3()
  private scratchC = new THREE.Vector3()
  private frustum = new THREE.Frustum()
  private projScreen = new THREE.Matrix4()

  build(p: Placement, opacity = 0.7) {
    this.clear()
    this.shell = p.shell || 1
    this.edgeShow = p.edgeShow
    this.edgeOpacity = opacity
    this.buildDistricts(p)
    this.buildSymbols(p)
    this.buildEdges(p)
    this.buildBadge(p)
  }

  /**
   * The module's mark, if somebody has vendored one under `public/badges`.
   *
   * Asked for rather than configured, so a module with no badge on disk costs
   * one 404 and a log line. It loads after the scene is already up — the image
   * is not worth blocking a rebuild on, and it appears when it appears.
   */
  private buildBadge(p: Placement) {
    if (!p.badge) return
    const { path, label, at, size } = p.badge

    const radius = size / 2

    // A discus, not a decal: a sphere squashed along one axis, so it has an
    // edge and two faces and the key light finds the curve of it. Flattened in
    // the geometry rather than by scaling the mesh, so all six share it and
    // nothing has to think about normals under a non-uniform scale.
    const discus = new THREE.SphereGeometry(radius, 48, 24)
    discus.scale(1, 1, DISCUS_FLATNESS)
    const discusMaterial = new THREE.MeshLambertMaterial({
      color: 0x2b1b4f,
      // The far side of one of these faces nothing, and an unlit purple disc in
      // deep space is a hole. The glow is what keeps it an object.
      emissive: 0x35134a,
      // A landmark at the back of the world is no use dissolved into the fog,
      // and the fog ends long before the sky does.
      fog: false,
    })

    // The mark itself, printed on the face rather than hanging in front of it.
    const face = new THREE.PlaneGeometry(size * ICON_FRACTION, size * ICON_FRACTION)
    const faceMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      fog: false,
      depthWrite: false,
    })

    const panels = at.map((point) => {
      const panel = new THREE.Mesh(discus, discusMaterial)
      panel.position.set(point.x, point.y, point.z)
      // Pointing local +Z at the origin turns the discus face towards the
      // middle of the world, which is the only place anyone looks at it from.
      // No orientation is stored in the placement: where it is decides which
      // way it faces, and everything below rides in that frame.
      panel.lookAt(0, 0, 0)
      // Nothing is drawn until the texture lands, so a miss leaves nothing
      // rather than six blank discs hanging in the sky. The miss is a decode
      // failure rather than a 404: Vite answers 200 with index.html for
      // anything missing under public/, and an <img> fed HTML errors out.
      panel.visible = false
      this.group.add(panel)

      // Just clear of the face it sits on, or it stitches through the curve.
      const icon = new THREE.Mesh(face, faceMaterial)
      icon.position.set(0, 0, radius * DISCUS_FLATNESS + radius * 0.02)
      panel.add(icon)

      // In front of the disc rather than beside it: nearer the viewer by a
      // fraction of the radius, which is what makes it read as floating there
      // instead of being painted on.
      const name = makeNeonPanel(label, size * NAME_HEIGHT)
      name.position.set(0, -radius * NAME_DROP, radius * NAME_FLOAT)
      panel.add(name)

      return panel
    })

    new THREE.TextureLoader().load(
      `/${path}`,
      (tex) => {
        faceMaterial.map = roundTexture(tex.image as HTMLImageElement)
        faceMaterial.needsUpdate = true
        tex.dispose() // the square original; the round copy is what gets drawn
        for (const p of panels) p.visible = true
        devlog('badge', { path, at: panels.length, size: +size.toFixed(0) })
      },
      undefined,
      () => devlog('badge.missing', { path }),
    )

    this.disposables.push(() => {
      for (const p of panels) {
        // Each name is its own canvas texture. The icon is not — it shares one
        // geometry and one material with the other five, disposed once below.
        for (const child of p.children as THREE.Mesh[]) {
          if (child.geometry === face) continue
          child.geometry.dispose()
          const m = child.material as THREE.MeshBasicMaterial
          m.map?.dispose()
          m.dispose()
        }
        this.group.remove(p)
      }
      discus.dispose()
      discusMaterial.dispose()
      face.dispose()
      faceMaterial.map?.dispose()
      faceMaterial.dispose()
    })
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

      // The district's own radius, which its symbols were placed on too. It
      // used to be computed here from the district's index, which drifted up to
      // six units clear of the shell the buildings sit on and buried the short
      // ones in their own floor when seen from outside.
      const capR = (p.shell || d.radius) + d.lift
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
      const R = ((p.shell || d.radius) + d.lift) * 1.002
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
        normal: normal.clone(),
        radius: d.radius,
        floor,
        ground: mat.color.clone(),
        rim,
        label,
      })
      this.disposables.push(() => disposeSprite(label))
    })
  }

  /**
   * The lines an edge is drawn along.
   *
   * Inside a district it arcs over that district's ground, because a straight
   * chord between two points on a sphere sinks below the surface it spans — 33
   * units across the widest district here, under opaque ground.
   *
   * And it arcs under it as well. The ground has one opaque side each way, so
   * any single arc is visible from one side of the shell and not the other:
   * putting it above swaps which half of the problem you have. Buildings
   * already solved this by straddling the crust and protruding both ways, and a
   * wire is no different. Two arcs, mirrored, one for each side.
   *
   * Across districts it stays a chord, and still passes through the middle of
   * the sphere. Those are tunnels rather than roads, and bending them over the
   * crust would be a different picture, not a fix.
   */
  private edgeLines(e: PlacedEdge): THREE.Vector3[][] {
    const a = this.positions.get(e.from)
    const b = this.positions.get(e.to)
    if (!a || !b) return []
    if (e.cross) return [[a, b]]
    const vec = (v: { x: number; y: number; z: number }) => new THREE.Vector3(v.x, v.y, v.z)
    return [
      arcPoints(a, b, WIRE_LIFT, WIRE_SEGMENTS).map(vec),
      arcPoints(a, b, -WIRE_LIFT, WIRE_SEGMENTS).map(vec),
    ]
  }

  /** Pushes a polyline as the pairs of endpoints LineSegments wants. */
  private pushLine(verts: number[], colors: number[], line: THREE.Vector3[], c: THREE.Color) {
    for (let i = 1; i < line.length; i++) {
      const p = line[i - 1]
      const q = line[i]
      verts.push(p.x, p.y, p.z, q.x, q.y, q.z)
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }
  }

  /** One LineSegments for everything; colours are rewritten on selection. */
  private buildEdges(p: Placement) {
    const verts: number[] = []
    const colors: number[] = []

    for (const e of p.edges) {
      const lines = this.edgeLines(e)
      if (!lines.length) continue
      this.edges.push(e)
      // Where each edge's segments start and how many it has, so recolouring
      // can find them again — an edge is two arcs, and an arc is many segments.
      const first = verts.length / 6
      const colour = e.cross ? EDGE_CROSS : EDGE_INTRA
      let count = 0
      for (const line of lines) {
        this.pushLine(verts, colors, line, colour)
        count += line.length - 1
      }
      this.edgeSpans.push([first, count])
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
   * How much of the scene is named. Cheap to change — the labels are rechosen
   * on the next frame and everything fades across rather than switching, so
   * spinning the ribbon looks like the map dressing and undressing itself.
   */
  setLabelMode(mode: LabelMode) {
    if (mode === this.labelMode) return
    this.labelMode = mode
    this.labelsDirty = true
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
      // An arc is many segments, so an edge no longer owns exactly two
      // vertices — it owns however many its line was drawn with.
      const [first, count] = this.edgeSpans[i]
      for (let s = first; s < first + count; s++) {
        attr.setXYZ(s * 2, c.r, c.g, c.b)
        attr.setXYZ(s * 2 + 1, c.r, c.g, c.b)
      }
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
      const colour = role === 'in' ? EDGE_IN : role === 'out' ? EDGE_OUT : EDGE_INTERNAL
      for (const line of this.edgeLines(e)) this.pushLine(verts, colors, line, colour)
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

  /**
   * Advances the selection's heartbeat, and returns how bright it is right now
   * as 0..1 so whatever else answers to it stays in phase.
   *
   * A thing that glows steadily is only findable by looking straight at it. A
   * thing that changes is findable out of the corner of an eye, which is the
   * point: after flying somewhere else you should be able to tell the selection
   * is still there, and roughly where, without hunting for it.
   */
  pulse(seconds: number, beaconAt?: THREE.Vector3, beaconColor?: THREE.Color): number {
    const k = 0.5 + 0.5 * Math.sin(seconds * PULSE_HZ * Math.PI * 2)
    const [lo, hi] = HOT_EMISSIVE
    for (const mesh of this.hotMeshes) {
      ;(mesh.material as THREE.MeshLambertMaterial).emissiveIntensity = lo + (hi - lo) * k
    }
    this.lightTheGround(k, beaconAt, beaconColor)
    return k
  }

  /**
   * Lights the district floors by hand.
   *
   * They are `MeshBasicMaterial` — opaque, unlit, and deliberately so, since
   * that is what stopped them wobbling. But from anywhere inside the shell the
   * far wall is nearly all floor, so a light at the selection had nothing to
   * fall on and a selection behind you was undetectable. This is the same
   * arithmetic a light does, done to the one surface that ignores lights: how
   * squarely a district faces the selection, times how bright it is beating.
   */
  private lightTheGround(k: number, at?: THREE.Vector3, color?: THREE.Color) {
    const toLight = this.scratchB
    for (const part of this.districtParts) {
      const mat = part.floor.material as THREE.MeshBasicMaterial
      if (!at || !color) {
        mat.color.copy(part.ground)
        continue
      }
      toLight.copy(at).sub(part.centre)
      const distance = toLight.length() || 1
      // Absolute, because a cap is double-sided and unlit and so has no front.
      // The face that matters is whichever one you are looking at, and from
      // inside the shell that is the inner one — which is the face a lamp
      // across the interior lights most squarely, and the whole point here.
      const facing = Math.abs(toLight.divideScalar(distance).dot(part.normal))
      // And it falls off with distance, or every district ends up wearing the
      // same tint and the picture stops saying which way the source is. Gentle
      // on purpose: inverse-square across a shell this wide would light three
      // districts and leave the rest black.
      const reach = this.shell / (this.shell + distance)
      mat.color.copy(part.ground).lerp(color, facing * reach * k * GROUND_LIT)
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
   * The district the reticle is nearest, by angle rather than by a ray.
   *
   * A ray would have to hit something, and a district you are looking straight
   * at across a gap is still the district you mean. This is the one whose
   * middle is closest to the line you are sighting along, which also stops the
   * answer flickering between neighbours as you drift over the seam between
   * them. Nothing behind the camera counts.
   */
  districtAtReticle(camera: THREE.PerspectiveCamera): string | null {
    const eye = camera.position
    const forward = this.scratchA
    camera.getWorldDirection(forward)
    const toDistrict = this.scratchB

    let best: string | null = null
    let closest = Math.PI / 3 // nothing more than sixty degrees off the nose
    for (const part of this.districtParts) {
      if (!part.floor.visible) continue
      toDistrict.copy(part.centre).sub(eye)
      const range = toDistrict.length() || 1
      const off = Math.acos(Math.max(-1, Math.min(1, toDistrict.divideScalar(range).dot(forward))))
      // How far off the nose its *edge* is, not its middle. Comparing centres
      // hands a district a hundred and eighty units wide the answer whenever
      // its middle happens to line up, over the small one filling the screen —
      // and a reticle inside a district scores below zero, which settles it.
      const spread = Math.asin(Math.min(1, part.radius / range))
      const score = off - spread
      if (score < closest) {
        closest = score
        best = part.pkg
      }
    }
    return best
  }

  /**
   * Labels are sized in pixels, not world units, so they stay readable at any
   * distance instead of ballooning as you fly into a district. Symbol labels
   * additionally only appear near the camera, to keep 70 boxes from turning
   * into 70 overlapping names.
   *
   * `dt` drives the fade in and out. The shutter passes a whole second, which
   * settles every label at once: a screenshot is a still, and one caught
   * mid-dissolve says nothing about what the page decided to show.
   */
  updateLabels(camera: THREE.PerspectiveCamera, viewportHeight: number, dt: number) {
    const eye = camera.position
    const dir = this.scratchC
    camera.getWorldDirection(dir)

    // The frustum is built here rather than in chooseLabels because hanging a
    // district's name needs it too, and it is one matrix multiply a frame.
    camera.updateMatrixWorld()
    this.frustum.setFromProjectionMatrix(
      this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    )

    // Which district the reticle is on, answered once a frame: the anchor loop
    // below wants it, and so does the choosing.
    this.aimedPkg =
      aimedOnly(this.labelMode) && !this.selecting ? this.districtAtReticle(camera) : null

    // Float each name on whichever side of its district the camera is on. Park
    // it at a fixed offset and the district's own cap occludes it from one side
    // — which is what happens to a label sitting inside the shell when you are
    // outside it.
    const toCamera = this.scratchA
    const anchor = this.scratchB
    for (const part of this.districtParts) {
      // The one district `aim` is about goes to the reticle rather than waiting
      // to be found off the edge of the frame. The widest district on coder is
      // 180 units across and you are usually inside it when you point at it, so
      // its centre is nowhere near the middle of the screen — walking the name
      // only as far as the usual margin left it off screen entirely, which is
      // the one outcome this mode cannot have.
      if (part.pkg === this.aimedPkg) {
        axisAnchor(part.centre, eye, dir, part.radius, anchor)
        toCamera.copy(eye).sub(anchor)
        part.label.position
          .copy(anchor)
          .addScaledVector(toCamera, (MAX_LIFT + 6) / (toCamera.length() || 1))
        continue
      }
      anchor.copy(part.centre)
      for (let pass = 0; pass < 2; pass++) {
        toCamera.copy(eye).sub(anchor)
        const len = toCamera.length() || 1
        part.label.position.copy(anchor).addScaledVector(toCamera, (MAX_LIFT + 6) / len)
        // A district can fill half the screen with its centre off the edge of
        // it, and then the biggest thing in view is the only thing without a
        // name. Walk the name in over its own ground until it is on screen, and
        // hang it from there instead.
        if (pass > 0 || this.frustum.containsPoint(part.label.position)) break
        axisAnchor(part.centre, eye, dir, part.radius * 0.8, anchor)
      }
    }

    // Choosing *which* labels to show is a pass over every symbol, so it only
    // happens when the camera has actually changed. At coder's 18,522 symbols,
    // scanning and sorting per frame cost 270ms a frame — the scene itself was
    // drawing in 50 calls, and labels were eating the whole budget.
    //
    // Turning counts as changing. Since the choice is filtered by what is on
    // screen, it is no longer rotation-invariant the way plain nearest-N was:
    // spin on the spot without this and the labels stay where they were, which
    // is now behind you.
    const turned = dir.dot(this.lastDir) < TURN_COSINE
    if (this.labelsDirty || turned || eye.distanceToSquared(this.lastEye) > 4) {
      this.chooseLabels(camera, dir)
      this.lastEye.copy(eye)
      this.lastDir.copy(dir)
      this.labelsDirty = false
    }

    // Sizing the chosen few is cheap, and has to happen every frame so they
    // hold their pixel height as you move.
    for (const { label } of this.districtChosen) {
      const d = label.position.distanceTo(eye)
      setLabelHeight(label, labelWorldHeight(DISTRICT_PX, d, camera.fov, viewportHeight, 0.05, 1e6))
    }
    const toEye = this.scratchB
    const up = this.scratchC
    for (const { s } of this.labelled) {
      const label = this.symbolLabels.get(s.node.id)
      if (!label) continue
      const d = s.pos.distanceTo(eye)
      const h = labelWorldHeight(SYMBOL_PX, d, camera.fov, viewportHeight, 0.05, 1e6)
      setLabelHeight(label, h)

      // A building straddles its district and stands up to fifty units along
      // the local normal, so a label offset from its centre by half its width
      // sits inside it and is cut in half by its own tower. Go to whichever end
      // faces the camera, then a little further towards the camera.
      toEye.copy(eye).sub(s.pos).normalize()
      up.set(s.node.nx, s.node.ny, s.node.nz)
      const side = up.dot(toEye) >= 0 ? 1 : -1
      label.position
        .copy(s.pos)
        .addScaledVector(up, side * (s.node.height / 2 + h * 0.35))
        .addScaledVector(toEye, h * 0.9)
    }

    this.declutter(camera, viewportHeight)
    this.fadeLabels(dt)
  }

  /**
   * Decide which of the chosen names actually get drawn: a name whose text
   * would land on one already placed gives way. Picking the best N is not
   * enough on its own — 835 callers of one function sit in the same square inch
   * of screen from a distance, and 24 names drawn there are a smear rather than
   * 24 names.
   *
   * The two kinds are packed in one pass, in rank order, after the first few
   * districts. Districts first all the way down was fine while there were
   * fourteen of them; with ninety, a nose-down pass over a district lost every
   * function name on screen to the package names of the ones behind it.
   */
  private declutter(camera: THREE.PerspectiveCamera, viewportHeight: number) {
    const viewportWidth = viewportHeight * camera.aspect
    const taken: { x: number; y: number; w: number; h: number }[] = []
    const p = this.scratchA

    const place = (label: THREE.Sprite, pad: number) => {
      p.copy(label.position).project(camera)
      if (p.z > 1) {
        setWant(label, 0) // behind the camera
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
          setWant(label, 0)
          return
        }
      }
      taken.push({ x, y, w, h })
      setWant(label, 1)
    }

    const districts = this.districtChosen
    const symbols = this.labelled
    let di = 0
    let si = 0
    while (di < districts.length || si < symbols.length) {
      const district =
        si >= symbols.length ||
        (di < districts.length && (di < RESERVED_DISTRICTS || districts[di].rank <= symbols[si].rank))
      if (district) {
        place(districts[di].label, DISTRICT_PAD)
        di++
      } else {
        const label = this.symbolLabels.get(symbols[si].s.node.id)
        if (label) place(label, SYMBOL_PAD)
        si++
      }
    }
  }

  /**
   * Walk every label towards where declutter left it. A label that is on its
   * way out is not asked to hold a position or a size — over a fifth of a
   * second nobody can tell, and it keeps the per-frame work on the few names
   * that are actually being read.
   */
  private fadeLabels(dt: number) {
    for (const label of this.districtLabels) fade(label, dt)
    for (const label of this.symbolLabels.values()) fade(label, dt)
  }

  /**
   * Best-N rather than everything-within-D: from across a 355-district shell
   * the second rule gives either a wall of overlapping text or nothing at all.
   * Keeps a small best-of list in one pass rather than sorting every symbol.
   *
   * "Best" is `labelRank` — distance, penalised by how far off the reticle a
   * name sits. Ranking on distance alone named the floor under the nose and
   * left whatever you were aiming at anonymous. The order matters twice, since
   * declutter places in it: the names nearest the reticle claim their space
   * first and the ones out at the edge give way.
   */
  private chooseLabels(camera: THREE.PerspectiveCamera, dir: THREE.Vector3) {
    const eye = camera.position
    const cosEdge = frustumEdgeCosine(camera.fov, camera.aspect)
    // Free here: updateLabels is done with scratchA/B and only holds scratchC.
    const toLabel = this.scratchB

    const best: { s: Symbol3D; rank: number }[] = []
    let worst = Infinity
    const range = LABEL_RANGE * LABEL_RANGE
    // In `aim` the reticle picks one district and everything else goes quiet.
    // A selection turns it off: you already said what you were interested in,
    // and it is usually not what the nose happens to be pointing at afterwards.
    const aiming = aimedOnly(this.labelMode) && !this.selecting
    const aimed = this.aimedPkg
    // Pointing at empty sky names nothing rather than everything, which is the
    // reading that makes it a sight rather than a filter that fails open.
    // A selection keeps its neighbourhood named in any mode but `off`, because
    // that is a direct answer to a direct action.
    const wantsSymbols =
      this.labelMode !== 'off' &&
      (namesSymbols(this.labelMode) || this.selecting) &&
      !(aiming && aimed === null)

    if (wantsSymbols) for (const s of this.symbols) {
      if (aiming && s.node.pkg !== aimed) continue
      // With a selection up, only the neighbourhood is labelled — at any
      // distance and in any direction, since you selected it to read it and it
      // is usually behind you by the time you stop moving. Without one, a name
      // is only worth a slot if it is on screen.
      if (this.selecting && !this.pinned.has(s.node.id)) continue
      const d2 = s.pos.distanceToSquared(eye)
      if (!this.selecting && (d2 > range || !this.frustum.containsPoint(s.pos))) continue
      const len = Math.sqrt(d2)
      toLabel.copy(s.pos).sub(eye)
      const rank = labelRank(len, len > 0 ? toLabel.dot(dir) / len : 1, cosEdge)
      if (best.length === SYMBOL_LABELS && rank >= worst) continue
      let at = best.length
      while (at > 0 && best[at - 1].rank > rank) at--
      best.splice(at, 0, { s, rank })
      if (best.length > SYMBOL_LABELS) best.pop()
      worst = best[best.length - 1].rank
    }

    this.labelled = best
    const shown = new Set(best.map((b) => b.s.node.id))
    for (const { s } of best) {
      if (this.symbolLabels.has(s.node.id)) continue
      const label = makeLabel(s.node.name, { size: 1, color: '#dbe4f3', onTop: this.selecting })
      // Arrives from nothing rather than at full strength, like every other
      // label; declutter has not had its say about this one yet.
      label.visible = false
      label.material.opacity = 0
      this.group.add(label)
      this.symbolLabels.set(s.node.id, label)
    }
    // Anything no longer chosen is asked to leave; only one that has finished
    // leaving is disposed, and only once the cache is worth trimming.
    const evict = this.symbolLabels.size > LABEL_CACHE
    for (const [id, label] of this.symbolLabels) {
      if (shown.has(id)) continue
      setWant(label, 0)
      if (evict && !label.visible) {
        this.group.remove(label)
        disposeSprite(label)
        this.symbolLabels.delete(id)
      }
    }

    // Best N, but only among the ones on screen. Every district is about the
    // same distance away from inside the shell, so plain nearest-N spends most
    // of its slots on districts behind the camera and the few names you could
    // actually read never get one. From outside it never showed, because out
    // there the nearest districts are the ones you are looking at.
    const districts = this.districtParts
      .filter((part) => namesDistricts(this.labelMode) && (!aiming || part.pkg === aimed))
      // The aimed district skips the on-screen test: it is on screen by
      // definition — that is what the reticle being on it means — even when the
      // point its name hangs from is not.
      .filter((part) => part.pkg === aimed || this.frustum.containsPoint(part.label.position))
      .map((part) => {
        const len = part.label.position.distanceTo(eye)
        toLabel.copy(part.label.position).sub(eye)
        const cos = len > 0 ? toLabel.dot(dir) / len : 1
        return { part, rank: labelRank(len, cos, cosEdge) }
      })
      .sort((a, b) => a.rank - b.rank)

    for (const part of this.districtParts) setWant(part.label, 0)
    this.districtChosen = districts
      .slice(0, DISTRICT_LABELS)
      .map(({ part, rank }) => ({ label: part.label, rank }))
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
    this.edgeSpans = []
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
