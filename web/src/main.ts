import * as THREE from 'three'
import { FlyController, type Controller } from './controls'
import { parseView } from './view'
import { World } from './world'
import { place, type Placement } from './placement'
import { neighborhood, toggle } from './selection'
import { devlog, installDevLog } from './devlog'
import type { Graph, ViewSpec } from './types'

installDevLog()

const POLL_MS = 400

const hud = document.getElementById('hud')!
const errBox = document.getElementById('err')!

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0b0e14)
scene.fog = new THREE.Fog(0x0b0e14, 260, 1100)

const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.5, 4000)
camera.position.set(0, 90, 220)
camera.lookAt(0, 0, 0)

scene.add(new THREE.AmbientLight(0xffffff, 0.65))
const key = new THREE.DirectionalLight(0xffffff, 0.9)
key.position.set(120, 220, 90)
scene.add(key)

const world = new World()
scene.add(world.group)

const grid = new THREE.GridHelper(2400, 120, 0x1c2434, 0x141a26)
;(grid.material as THREE.Material).transparent = true
;(grid.material as THREE.Material).opacity = 0.5
scene.add(grid)

// Swap this line for an OrbitController if flying turns out to feel bad.
const flyControls = new FlyController(camera, renderer.domElement)
const controls: Controller = flyControls
flyControls.onFocus = () => frameFocus() // gamepad A, same action as F

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

let graph: Graph | null = null
let view: ViewSpec | null = null
let placement: Placement | null = null
let framed = false
let status = ''
let selected = new Set<string>()
let revealing = false

const selBox = document.getElementById('sel')!
const raycaster = new THREE.Raycaster()
const CENTRE = new THREE.Vector2(0, 0) // the reticle, since the pointer is locked

addEventListener('keydown', (e) => {
  if (e.code === 'KeyF') frameFocus()
})

function pickAtReticle() {
  raycaster.setFromCamera(CENTRE, camera)
  const hit = world.pickTolerant(camera, raycaster, 45, { w: innerWidth, h: innerHeight })
  devlog('pick', { ...hit, selected: selected.size })
  if (!hit.id) {
    flashMiss()
    return
  }
  selected = toggle(selected, hit.id)
  // While revealing, the selection decides which nodes exist, so it has to go
  // all the way back through place().
  if (revealing) rebuild()
  else applySelection()
}

function toggleReveal() {
  revealing = !revealing
  devlog('reveal', { on: revealing, selected: selected.size })
  rebuild()
}

/** A miss has to look different from a broken button. */
function flashMiss() {
  const reticle = document.getElementById('reticle')!
  reticle.classList.add('miss')
  setTimeout(() => reticle.classList.remove('miss'), 220)
}

function clearSelection() {
  devlog('clear', { had: selected.size })
  if (!selected.size) return
  selected = new Set()
  applySelection()
}

function applySelection() {
  if (!placement) return
  const n = neighborhood(placement.edges, selected)
  world.applySelection(n)

  if (n.empty) {
    selBox.style.display = 'none'
    return
  }
  const lines = [...selected].map((id) => {
    const node = world.nodeById(id)
    if (!node) return id
    // Visible edges out of total, because the occupant filter hides callers and
    // "in 0" for something with six of them is a wrong answer, not a summary.
    const ins = placement!.edges.filter((e) => e.to === id).length
    const outs = placement!.edges.filter((e) => e.from === id).length
    return `${node.name}\n  ${node.pkg}\n  in ${ins}/${node.fanIn} · out ${outs}/${node.fanOut}`
  })
  selBox.textContent = `${lines.join('\n\n')}\n\n${n.callers.size} callers · ${n.callees.size} callees`
  selBox.style.display = 'block'
}

flyControls.onPick = pickAtReticle
flyControls.onClearSelection = clearSelection
flyControls.onToggleReveal = toggleReveal

function frameFocus() {
  if (!view) return
  const target = (view.camera.focus && world.positionOf(view.camera.focus)) || new THREE.Vector3(0, 0, 0)
  controls.frame(target, view.camera.distance)
}

function rebuild() {
  if (!graph || !view) return
  const p = place(graph, view, revealing ? selected : [])
  placement = p
  world.build(p)
  devlog('rebuild', { nodes: p.nodes.length, edges: p.edges.length, districts: p.districts.length })

  // A view change can filter out something that was selected; keep only what
  // is still on screen rather than holding a reference to a ghost.
  const live = new Set([...selected].filter((id) => world.nodeById(id)))
  if (view.select.length) for (const id of view.select) live.add(id)
  selected = new Set([...live].filter((id) => world.nodeById(id)))
  applySelection()

  status = [
    graph.module,
    `${p.nodes.length}/${p.total} symbols · ${p.edges.length} edges · ${p.districts.length} districts` +
      (p.revealed ? ` · +${p.revealed} revealed` : ''),
    `size=${view.encoding.size}  color=${view.encoding.color}  height=${view.encoding.height}`,
    `packages: ${view.occupants.packages.join(', ')}`,
  ].join('\n')
  hud.textContent = status
  if (!framed) {
    framed = true
    frameFocus()
  }
}

const errors = new Map<string, string>()

function setError(where: string, e: unknown) {
  errors.set(where, `${where}:\n${e instanceof Error ? e.message : String(e)}`)
  renderErrors()
}

function clearError(where: string) {
  if (errors.delete(where)) renderErrors()
}

function renderErrors() {
  errBox.textContent = [...errors.values()].join('\n\n')
  errBox.style.display = errors.size ? 'block' : 'none'
}

/**
 * Polls a JSON file, invoking onChange only when the bytes actually change.
 * `last` advances only after a successful apply, so a broken file keeps its
 * error on screen until it is fixed.
 */
function watch(url: string, onChange: (raw: unknown) => void) {
  let last: string | null = null
  const tick = async () => {
    try {
      const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const text = await res.text()
      if (text !== last) {
        onChange(JSON.parse(text))
        last = text
      }
      clearError(url)
    } catch (e) {
      setError(url, e)
    } finally {
      setTimeout(tick, POLL_MS)
    }
  }
  tick()
}

watch('/graph.json', (raw) => {
  graph = raw as Graph
  rebuild()
})

watch('/view.json', (raw) => {
  view = parseView(raw)
  rebuild()
})

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1)
  controls.update(dt)
  world.updateLabels(camera, renderer.domElement.clientHeight)
  renderer.render(scene, camera)
})
