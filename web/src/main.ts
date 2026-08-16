import * as THREE from 'three'
import { FlyController, type Controller } from './controls'
import { parseView } from './view'
import { World } from './world'
import { place, type PlacedNode, type Placement } from './placement'
import { neighborhood, toggle, type Neighborhood } from './selection'
import { rank, SEARCH_LIMIT } from './search'
import { devlog, installDevLog } from './devlog'
import { Shutter } from './shutter'
import { watchCues } from './cue'
import { makeStarfield } from './sky'
import { MFD } from './mfd'
import { Voice } from './sound'
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

// Less fill, more key: flat lighting made every cube the same shade of its own
// colour, so a district was a field of identical chips.
scene.add(new THREE.AmbientLight(0xffffff, 0.42))
const key = new THREE.DirectionalLight(0xffffff, 1.25)
key.position.set(120, 220, 90)
scene.add(key)

/**
 * The selection casts light. Pulsing the symbol itself only helps when it is on
 * screen; a lamp standing in the city tells you something is over there the way
 * a torch off to one side does at night, by what it lights up rather than by
 * being looked at.
 *
 * Made once, at zero, and moved around after that. Adding a light to a scene
 * recompiles every material in it, which is not a thing to do per selection.
 * Distance and decay are physical, so the intensity is in candela and has to be
 * large to reach anything at this scale.
 */
const BEACON_RANGE = 160
const BEACON_INTENSITY = [120, 900] as const
const beacon = new THREE.PointLight(0xffffff, 0, BEACON_RANGE, 2)
scene.add(beacon)

/**
 * The same selection, as a sun.
 *
 * Inverse-square falloff cannot be both bright at twenty units and visible at
 * eight hundred: whatever reaches the far wall of the shell blows out
 * everything standing next to it. A sun does not fall off — it is only a
 * direction — so this one has no decay and no cutoff, and carries across the
 * whole scene at an intensity that is nearly nothing.
 *
 * What it buys is the thing lighting is for: from anywhere inside the shell,
 * the faces turned towards the selection are lit and the faces turned away are
 * not, and the difference breathes. That is how you know there is something
 * behind you without looking at it.
 */
const SUN_INTENSITY = [0.06, 0.34] as const
const beaconSun = new THREE.PointLight(0xffffff, 0, 0, 0)
scene.add(beaconSun)

const world = new World()
scene.add(world.group)

// No ground grid: districts are on a shell now, so a horizontal plane through
// the middle of it is a lie about where the ground is.
const fog = new THREE.Fog(0x0b0e14, 260, 1100)
scene.fog = fog

// A sky to fly against, so "which way am I facing" has an answer when nothing
// else is on screen. Sized once, well beyond anything a graph occupies.
const STAR_RADIUS = 3200
const stars = makeStarfield(STAR_RADIUS)
scene.add(stars)

// Swap this line for an OrbitController if flying turns out to feel bad.
const flyControls = new FlyController(camera, renderer.domElement)
const controls: Controller = flyControls
flyControls.onFocus = () => {
  // gamepad A, same action as F. The cue lives at the two deliberate call
  // sites rather than inside frameFocus, which also runs on first load.
  voice.play('focus')
  frameFocus()
}

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

const mfd = new MFD(selBox)
const voice = new Voice()
/** file/line/lines live on the raw graph, not on the placed node. */
const sources = new Map<string, { file: string; line: number; lines: number }>()

/**
 * An open query. Flying finds a symbol only if you already know where it is;
 * this is the other way in. It is modal — while it is up the keyboard spells
 * rather than flies — which is why the controller is told to stand down.
 */
const search = { active: false, query: '', hits: [] as PlacedNode[], cursor: 0, missed: false }

function openSearch() {
  if (search.active) return
  search.active = true
  search.query = ''
  search.hits = []
  search.cursor = 0
  search.missed = false
  voice.play('search-open')
  controls.setTyping(true)
  // Typing is not flying. Releasing the pointer also gives Escape back: while
  // it is captured the browser spends that key on letting go.
  document.exitPointerLock()
  devlog('search.open', { placed: placement?.nodes.length ?? 0 })
  paint()
}

function closeSearch() {
  if (!search.active) return
  search.active = false
  controls.setTyping(false)
  devlog('search.close', {})
  paint()
}

function setQuery(q: string) {
  search.query = q
  search.hits = rank(placement?.nodes ?? [], q)
  search.cursor = 0
  // Say "no match" on the keystroke that loses the last one, not on every one
  // after it — typing four more letters of a name that isn't there should not
  // be four announcements.
  const missing = Boolean(q.trim()) && search.hits.length === 0
  if (missing && !search.missed) voice.play('search-empty')
  search.missed = missing
  devlog('search', {
    query: q,
    matches: search.hits.length,
    top: search.hits.slice(0, 5).map((h) => h.id),
  })
  paint()
}

/** Take the highlighted hit: select it and fly there, as a pick would. */
function goToHit() {
  const hit = search.hits.slice(0, SEARCH_LIMIT)[search.cursor]
  if (!hit) return
  voice.play('search-go')
  closeSearch()
  selected = new Set([hit.id])
  applySelection()
  const at = world.positionOf(hit.id)
  if (at) controls.frame(at, view?.camera.distance ?? 120)
  devlog('search.go', { id: hit.id })
}

function searchKey(e: KeyboardEvent) {
  const shown = search.hits.slice(0, SEARCH_LIMIT)
  if (e.key === 'Escape') {
    voice.play('search-cancel')
    return closeSearch()
  }
  if (e.key === 'Enter') return goToHit()
  if (e.key === 'Backspace') return setQuery(search.query.slice(0, -1))
  if (e.key === 'Tab') return e.preventDefault() // nowhere for focus to go
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!shown.length) return
    const step = e.key === 'ArrowDown' ? 1 : -1
    search.cursor = Math.max(0, Math.min(shown.length - 1, search.cursor + step))
    return paint()
  }
  // One key, one character, and not a shortcut somebody meant for the browser.
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault()
    setQuery(search.query + e.key)
  }
}

addEventListener('keydown', (e) => {
  // Escape outranks the remote, and is the only key that does.
  if (held) {
    if (e.key === 'Escape') giveWheel('local')
    return
  }
  if (search.active) return searchKey(e)
  if (e.key === '/') {
    e.preventDefault() // firefox opens quick-find on this key
    return openSearch()
  }
  if (e.code === 'KeyF') {
    voice.play('focus')
    frameFocus()
  }
  if (e.code === 'Tab') {
    e.preventDefault() // tab moves focus otherwise, and there is nowhere to go
    voice.play(mfd.cycle() === 'info' ? 'panel-info' : 'panel-source')
  }
})

// Capturing the pointer means you are flying again, so a query left open would
// be holding a keyboard nobody is typing on — and Escape, which would close it,
// is the same key that releases the pointer.
document.addEventListener('pointerlockchange', () => {
  const captured = Boolean(document.pointerLockElement)
  if (captured) closeSearch()
  voice.play(captured ? 'capture' : 'release')
})

// No callout for the speed change: the bed is two tiers of airflow and it is
// already saying which one you are in, continuously, for as long as it is true.
flyControls.onMotion = (moving, fast) => voice.bed(moving, fast)

function pickAtReticle() {
  // A cue can fly the camera and pull the trigger in the same breath, before
  // anything has rendered, and setFromCamera reads matrixWorld rather than
  // computing it. For a real click this is already up to date and costs one
  // matrix; without it a remote pick aims where the camera used to be.
  camera.updateMatrixWorld()
  raycaster.setFromCamera(CENTRE, camera)
  const hit = world.pickTolerant(camera, raycaster, 45, { w: innerWidth, h: innerHeight })
  devlog('pick', { ...hit, selected: selected.size })
  if (!hit.id) {
    flashMiss()
    voice.play('select-miss')
    return
  }
  voice.play(selected.has(hit.id) ? 'deselect' : 'select')
  selected = toggle(selected, hit.id)
  // While revealing, the selection decides which nodes exist, so it has to go
  // all the way back through place().
  if (revealing) rebuild()
  else applySelection()
}

function toggleReveal() {
  revealing = !revealing
  devlog('reveal', { on: revealing, selected: selected.size })
  voice.play(revealing ? 'reveal-on' : 'reveal-off')
  rebuild()
}

/**
 * Remote control of the wheel. While something at the other end of a cue is
 * driving, local input is ignored so an experiment is not fighting whoever is
 * holding the mouse.
 *
 * Two ways out, both mandatory. It expires on its own, because an agent that
 * dies mid-experiment must not leave the page locked; and Escape takes it back
 * immediately, because the person sitting in front of it outranks the remote.
 */
const HOLD_SECONDS = 120
const holdBar = document.getElementById('hold')!
let held = false
let holdTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The banner is on whether or not anything is holding the wheel. One that only
 * appears when something is wrong has to be read to be understood; one that is
 * always there is understood by having changed colour.
 */
function renderHold() {
  holdBar.className = held ? 'remote' : 'mine'
  holdBar.textContent = held ? 'REMOTE HAS THE WHEEL · esc to take it back' : 'YOU HAVE CONTROL'
}

function takeWheel() {
  if (holdTimer) clearTimeout(holdTimer)
  holdTimer = setTimeout(() => giveWheel('expired'), HOLD_SECONDS * 1000)
  if (held) return // a later cue only refreshes the deadman
  held = true
  controls.setLocked(true)
  closeSearch()
  document.exitPointerLock()
  renderHold()
  devlog('hold', { on: true, seconds: HOLD_SECONDS })
  voice.play('remote-on')
}

function giveWheel(why: string) {
  if (holdTimer) clearTimeout(holdTimer)
  holdTimer = null
  if (!held) return
  held = false
  controls.setLocked(false)
  renderHold()
  devlog('hold', { on: false, why })
  voice.play('remote-off')
}

renderHold()

/** A miss has to look different from a broken button. */
function flashMiss() {
  const reticle = document.getElementById('reticle')!
  reticle.classList.add('miss')
  setTimeout(() => reticle.classList.remove('miss'), 220)
}

/** What the last clear dropped, so hitting it by accident can be taken back. */
let cleared = new Set<string>()

/**
 * Clear, and clear again to undo. X is next to the keys you fly with and it
 * throws away work — finding the symbol again is the expensive part, not
 * selecting it — so the second press puts back what the first one dropped.
 */
function clearSelection() {
  devlog('clear', { had: selected.size, undo: cleared.size })
  if (selected.size) {
    cleared = selected
    selected = new Set()
    voice.play('clear')
  } else {
    // A view change between the clear and the undo can filter a symbol out of
    // the scene, and there is nothing to put back for one that is not placed.
    const live = new Set([...cleared].filter((id) => world.nodeById(id)))
    if (!live.size) {
      voice.play('clear-nothing')
      return
    }
    selected = live
    voice.play('select')
  }
  // Reveal decides which nodes exist from the selection, so changing it there
  // has to go back through place() — the same rule the pick path follows.
  if (revealing) rebuild()
  else applySelection()
}

let hood: Neighborhood = neighborhood([], [])

function applySelection() {
  if (!placement) return
  hood = neighborhood(placement.edges, selected)
  world.applySelection(hood)
  paint()
}

/** The panel, from whatever the current state is. Selection and query both. */
function paint() {
  if (!placement) return
  mfd.render({
    selected: [...selected],
    nodeById: (id) => world.nodeById(id),
    fileOf: (id) => sources.get(id),
    // Visible edges out of total, because the occupant filter hides callers and
    // "in 0" for something with six of them is a wrong answer, not a summary.
    drawn: (id) => ({
      ins: placement!.edges.filter((e) => e.to === id).length,
      outs: placement!.edges.filter((e) => e.from === id).length,
    }),
    hood,
    search: search.active
      ? {
          query: search.query,
          cursor: search.cursor,
          shown: search.hits.slice(0, SEARCH_LIMIT),
          matches: search.hits.length,
          searched: placement.nodes.length,
        }
      : null,
  })
}

flyControls.onPick = pickAtReticle
flyControls.onClearSelection = clearSelection
flyControls.onToggleReveal = toggleReveal

/**
 * Fly to whatever the panel is showing. The selection is the thing you are
 * looking at, so it is what "focus" means once there is one; `camera.focus`
 * from the view is the fallback for when there is not, and the origin is the
 * fallback for that — a point in the middle of a shell, which is nowhere in
 * particular and was where this always went.
 */
function frameFocus() {
  if (!view) return
  const id = lastSelected() ?? view.camera.focus
  const target = (id && world.positionOf(id)) || new THREE.Vector3(0, 0, 0)
  devlog('focus', { id, found: Boolean(id && world.positionOf(id)) })
  controls.frame(target, view.camera.distance)
}

/** Puts the beacon on the selection, in phase with the symbol's own pulse. */
function updateBeacon(seconds: number) {
  const id = lastSelected()
  const at = id ? world.positionOf(id) : undefined
  if (!id || !at) {
    world.pulse(seconds)
    beacon.intensity = 0
    beaconSun.intensity = 0
    return
  }
  // Colour first: the ground is tinted towards it in the same call.
  const node = world.nodeById(id)
  if (node) {
    beacon.color.setHex(node.color)
    beaconSun.color.setHex(node.color)
  }
  const k = world.pulse(seconds, at, beaconSun.color)
  beacon.position.copy(at)
  beaconSun.position.copy(at)
  const [lo, hi] = BEACON_INTENSITY
  beacon.intensity = lo + (hi - lo) * k
  const [sunLo, sunHi] = SUN_INTENSITY
  beaconSun.intensity = sunLo + (sunHi - sunLo) * k
}

/** The most recent pick, which is the one the panel is describing. */
function lastSelected(): string | undefined {
  let last: string | undefined
  for (const id of selected) last = id
  return last
}

function rebuild() {
  if (!graph || !view) return
  voice.set(view.sound.enabled, view.sound.volume)
  const p = place(graph, view, revealing ? selected : [])
  placement = p
  world.build(p, view.edges.opacity)
  // Depth cue scaled to the world we actually built, so the far side of the
  // shell reads as far away rather than as missing.
  fog.near = p.extent * 0.8
  fog.far = p.extent * 3

  // The camera and the sky follow the scene's size too. A graph that comes out
  // bigger than the far plane renders as an empty screen with one district in
  // it, which is a confusing way to find out the layout has a bug.
  camera.far = Math.max(4000, p.extent * 6)
  camera.updateProjectionMatrix()
  stars.scale.setScalar(Math.max(1, (p.extent * 4) / STAR_RADIUS))
  devlog('rebuild', { nodes: p.nodes.length, edges: p.edges.length, districts: p.districts.length })

  // A view change can filter out something that was selected; keep only what
  // is still on screen rather than holding a reference to a ghost.
  const live = new Set([...selected].filter((id) => world.nodeById(id)))
  if (view.select.length) for (const id of view.select) live.add(id)
  selected = new Set([...live].filter((id) => world.nodeById(id)))
  applySelection()
  // A view change is a different set of symbols, so an open query is stale.
  if (search.active) setQuery(search.query)

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
  // Only when it breaks, not while it stays broken: the poller retries every
  // 400ms and a bad file would otherwise announce itself twice a second.
  const fresh = !errors.has(where)
  errors.set(where, `${where}:\n${e instanceof Error ? e.message : String(e)}`)
  if (fresh) voice.play('view-error')
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
  let stamp: string | null = null

  const tick = async () => {
    try {
      // Ask what changed before asking for the bytes. coder's graph is 10MB;
      // re-fetching and re-parsing it every 400ms to discover it is identical
      // is 25MB/s of work to learn nothing.
      const head = await fetch(url, { method: 'HEAD', cache: 'no-store' })
      const tag = head.headers.get('etag') ?? head.headers.get('last-modified')
      if (tag && tag === stamp) {
        clearError(url)
        return
      }

      const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const text = await res.text()
      if (text !== last) {
        onChange(JSON.parse(text))
        last = text
      }
      // Only after a successful apply, so a broken file keeps being retried.
      stamp = tag
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
  sources.clear()
  for (const n of graph.nodes) sources.set(n.id, { file: n.file, line: n.line, lines: n.lines })
  rebuild()
})

watch('/view.json', (raw) => {
  view = parseView(raw)
  rebuild()
})

// Frame timing goes to the log, so "is it slow" is answerable from a terminal
// rather than by asking whoever is holding the mouse.
let frames = 0
let worst = 0
let since = 0

const shutter = new Shutter(renderer.domElement, () => {
  // Timed, because a backgrounded tab reports no frame rate at all — this is
  // the only cost measurement available when nobody is watching the page.
  const t0 = performance.now()
  world.updateLabels(camera, renderer.domElement.clientHeight)
  updateBeacon(beat())
  const t1 = performance.now()
  renderer.render(scene, camera)
  devlog('renderMs', {
    labelMs: +(t1 - t0).toFixed(1),
    renderMs: +(performance.now() - t1).toFixed(1),
    nodes: placement?.nodes.length ?? 0,
    calls: renderer.info.render.calls,
    ...world.labelStats(),
  })

})
shutter.start()

/** Put the page into a requested state, so a specific view can be evaluated. */
watchCues((cue) => {
  devlog('cue', cue)
  if (cue.hold === true) takeWheel()
  if (cue.hold === false) giveWheel('remote')
  if (cue.select) {
    selected = new Set(cue.select.filter((id) => world.nodeById(id)))
  }
  const wantsReveal = typeof cue.reveal === 'boolean' ? cue.reveal : revealing
  if (wantsReveal !== revealing) {
    revealing = wantsReveal
    rebuild() // reveal changes which nodes exist, so positions move
  } else if (cue.select) {
    if (revealing) rebuild()
    else applySelection()
  }
  if (cue.focus) {
    const target = world.positionOf(cue.focus)
    const from =
      cue.yaw === undefined && cue.pitch === undefined
        ? undefined
        : { yaw: ((cue.yaw ?? 0) * Math.PI) / 180, pitch: ((cue.pitch ?? 20) * Math.PI) / 180 }
    if (target) controls.frame(target, cue.distance ?? view?.camera.distance ?? 120, true, from)
    else devlog('cue.miss', { focus: cue.focus })
  }
  // Last, so it fires at whatever the camera was just pointed at.
  if (cue.pick) pickAtReticle()
  if (cue.clear) clearSelection()
  if (cue.flip) controls.flip(true)
  if (typeof cue.search === 'string') {
    // An empty query closes it. A cue that could only open the search would
    // leave whoever is at the keyboard holding a modal they cannot dismiss
    // from the terminal that opened it.
    if (cue.search) {
      openSearch()
      setQuery(cue.search)
    } else closeSearch()
  }
})

const clock = new THREE.Clock()
/**
 * Wall time, not accumulated frame time. The heartbeat is cosmetic and it is
 * the only thing here that reads a clock, so taking it from the wall means a
 * screenshot of a backgrounded tab catches it somewhere alive rather than
 * frozen wherever the animation loop stopped.
 */
const beat = () => performance.now() / 1000
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1)
  controls.update(dt)
  world.updateLabels(camera, renderer.domElement.clientHeight)
  updateBeacon(beat())
  renderer.render(scene, camera)

  frames++
  since += dt
  worst = Math.max(worst, dt)
  if (since >= 5) {
    devlog('fps', {
      mean: Math.round(frames / since),
      worstFrameMs: Math.round(worst * 1000),
      nodes: placement?.nodes.length ?? 0,
      calls: renderer.info.render.calls,
    })
    frames = 0
    worst = 0
    since = 0
  }
})
