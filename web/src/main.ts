import * as THREE from 'three'
import { DEFAULT_OFFSET, FlyController, type Controller } from './controls'
import { parseView } from './view'
import { World } from './world'
import { place, skyRadius, STAR_RADIUS, type PlacedNode, type Placement } from './placement'
import { neighborhood, toggle, type Neighborhood } from './selection'
import { rank, SEARCH_LIMIT } from './search'
import { devlog, installDevLog } from './devlog'
import { Shutter } from './shutter'
import { bearingToBadge } from './badge'
import { movesTheView, watchCues } from './cue'
import { makeStarfield } from './sky'
import { MFD, MODES } from './mfd'
import { Voice } from './sound'
import { cycleMode, LABEL_MODES, ribbon } from './labelmode'
import type { Graph, LabelMode, ViewSpec } from './types'

installDevLog()

const POLL_MS = 400

const hud = document.getElementById('hud')!
const errBox = document.getElementById('err')!
const ribbonEl = document.getElementById('ribbon')!

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
// else is on screen. Built at its own radius and scaled to the graph on every
// rebuild; the badges are pasted on the inside of this same sphere.
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
  flying() // the query was the only thing keeping the controls busy
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
  flying()
})

/**
 * Music plays while the sim is being flown, which means somebody has the
 * controls: you with the pointer captured, or a remote holding the wheel. The
 * state it is the opposite of is the page sitting there with the cursor free,
 * which is not a moment that wants a soundtrack.
 */
/**
 * Whether anybody is flying this thing: you with the pointer captured, a hand
 * on the gamepad, a remote holding the wheel, or a query open — typing is still
 * driving the sim, even though it hands the pointer back to do it.
 *
 * The pad belongs here because it never captures anything. It flies the sim
 * without a pointer lock by design, which meant the whole map could be crossed
 * in silence — no music, no airflow — while the voice carried on talking,
 * because only the voice was ungated. If the sim is answering the stick, the
 * controls are being held.
 */
function inControl() {
  return (
    Boolean(document.pointerLockElement) || flyControls.padHasControls() || held || search.active
  )
}

/** Last reported by the controller, so control changes can re-decide the bed. */
let engine = { moving: false, fast: false }

function flying() {
  const active = inControl()
  voice.setPlaying(active)
  // Airflow needs somebody at the controls as well as motion. A gamepad is
  // polled rather than evented, so a stick resting a hair outside its deadzone
  // reads as flying forever — which is engine noise in an empty room.
  voice.bed(active && engine.moving, engine.fast)
}

// No callout for the speed change: the bed is two tiers of airflow and it is
// already saying which one you are in, continuously, for as long as it is true.
flyControls.onMotion = (moving, fast) => {
  engine = { moving, fast }
  flying()
}

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
/**
 * A declared hold is a long lease: somebody said they were driving, and they
 * get to go and think for a while without the page taking itself back.
 */
const HOLD_SECONDS = 120
/**
 * A hold taken by a cue simply having done something is a short one, refreshed
 * by the next cue. Long enough that a sequence of them reads as one stretch of
 * somebody else driving, short enough that the wheel comes back on its own
 * about as fast as you would reach for it.
 */
const AUTO_HOLD_SECONDS = 5
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

function takeWheel(seconds = HOLD_SECONDS) {
  if (holdTimer) clearTimeout(holdTimer)
  holdTimer = setTimeout(() => giveWheel('expired'), seconds * 1000)
  if (held) return // a later cue only refreshes the deadman
  held = true
  controls.setLocked(true)
  closeSearch()
  document.exitPointerLock()
  renderHold()
  devlog('hold', { on: true, seconds })
  voice.play('remote-on')
  flying()
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
  flying()
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

/**
 * The district the reticle is on, gathered for the panel that lists it.
 *
 * Recomputed only when the answer changes, which flying past a district it
 * does about once a second — walking every symbol to collect a package's worth
 * on every frame would be a pass over eight thousand of them for a panel that
 * did not move.
 */
let aimedAt: string | null = null

function aimedDistrict() {
  if (!placement || !aimedAt) return null
  const d = placement.districts.find((x) => x.pkg === aimedAt)
  if (!d) return null
  return {
    label: d.label,
    pkg: d.pkg,
    occupants: placement.nodes.filter((n) => n.pkg === aimedAt),
  }
}

/** Follows the reticle, and repaints the panel when it lands somewhere new. */
function watchAim() {
  const now = world.districtAtReticle(camera)
  if (now === aimedAt) return
  aimedAt = now
  // What the page thinks you are looking at, which is otherwise only knowable
  // by reading a panel that no screenshot can see.
  devlog('aim', { pkg: now })
  if (mfd.mode === 'district') paint()
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
    district: aimedDistrict(),
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
flyControls.onCycleLabels = (step) => setLabelMode(cycleMode(labelMode, step))
// A pointer announces capture and release with an event; a pad is polled, so
// picking it up has to say so or nothing re-decides who is flying.
flyControls.onPadPresence = () => flying()
// Every way of looking behind you — the stick press, C, and a cue — goes
// through the controller's own flip, so hanging the sound there covers all
// three without any of them knowing about it.
flyControls.onFlip = () => voice.play('flip')

/**
 * Fly to whatever the panel is showing. The selection is the thing you are
 * looking at, so it is what "focus" means once there is one; `camera.focus`
 * from the view is the fallback for when there is not, and the origin is the
 * fallback for that — a point in the middle of a shell, which is nowhere in
 * particular and was where this always went.
 */
function frameFocus(opening = false) {
  if (!view) return
  const id = lastSelected() ?? view.camera.focus
  const at = id ? world.positionOf(id) : undefined
  const target = at ?? new THREE.Vector3(0, 0, 0)
  // Where it put the camera, not just what it was aiming at. Every question
  // about the opening shot so far has been "is it where I think it is", and
  // that is not answerable from a screenshot of the middle of a sphere.
  devlog('focus', {
    id,
    found: Boolean(at),
    target: [target.x, target.y, target.z].map((n) => +n.toFixed(0)),
    opening,
  })
  // Nothing to fly to means the middle of the shell, and `camera.distance` is a
  // distance for standing next to a symbol — a hundred-odd units from the
  // centre of a graph is inside it, looking at the far wall from within. Frame
  // the whole thing instead, which is what "no particular symbol" should mean.
  const distance = at ? view.camera.distance : Math.max(view.camera.distance, wholeGraphDistance())
  // The opening arrives rather than gliding. A glide is a nice touch when
  // somebody is watching, but it is stepped by the animation loop, and a
  // backgrounded tab has no animation loop — so the one thing that decided
  // where the page *starts* depended on whether anyone was looking at it.
  controls.frame(target, distance, opening, opening ? openingBearing(target) : undefined)
}

/** Far enough out for the crust to be an object rather than a wall. */
function wholeGraphDistance(): number {
  return (placement?.extent ?? 0) * 2.4
}

/**
 * Where to stand for the very first look: near enough to the usual bearing to
 * be the same shot, turned so one of the marks is behind what you are looking
 * at. Otherwise the opening view is the one direction in the sky with no
 * landmark in it, which is a strange thing to greet somebody with.
 *
 * Only the opening. `F` keeps the plain approach, because flying to a symbol is
 * about the symbol and swinging round to collect a badge on the way would be a
 * camera with opinions.
 */
function openingBearing(target: THREE.Vector3): { yaw: number; pitch: number } | undefined {
  if (!placement?.badge) return undefined
  // Where you would have looked: the opposite of where `frame` would stand.
  const prefer = { x: -DEFAULT_OFFSET.x, y: -DEFAULT_OFFSET.y, z: -DEFAULT_OFFSET.z }
  const dir = bearingToBadge(placement.badge, target, prefer)
  // frame() wants where to stand, which is the opposite of where to look, and
  // as the two angles it builds that offset from.
  const offset = { x: -dir.x, y: -dir.y, z: -dir.z }
  return { yaw: Math.atan2(offset.x, offset.z), pitch: Math.asin(offset.y) }
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

/**
 * The ribbon's position, and the last one the file asked for.
 *
 * Seeded from `view.json` and then owned by whoever is flying: the ribbon is a
 * control rather than a setting, and having a file poll every 400ms put the
 * labels back would make it useless. An actual edit to `labels.mode` still wins,
 * which is what the second variable is for — it is the difference between "the
 * file says all" and "the file has just changed its mind to all".
 */
let labelMode: LabelMode = 'all'
let specMode: LabelMode | null = null

function setLabelMode(mode: LabelMode) {
  labelMode = mode
  world.setLabelMode(mode)
  drawRibbon()
  devlog('labels', { mode })
}

function drawRibbon() {
  ribbonEl.replaceChildren(
    ...ribbon(labelMode).map((r, i) => {
      const b = document.createElement('button')
      b.textContent = r.glyph
      b.title = r.title
      b.className = r.active ? 'on' : ''
      // Clickable only with the pointer free, which is the honest state for a
      // button: captured, the mouse is a flight control and this is a d-pad.
      b.onclick = () => setLabelMode(LABEL_MODES[i])
      return b
    }),
  )
}

function rebuild() {
  if (!graph || !view) return
  voice.set(view.sound.enabled, view.sound.volume)
  if (view.labels.mode !== specMode) {
    specMode = view.labels.mode
    setLabelMode(specMode)
  }
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
  stars.scale.setScalar(skyRadius(p.extent) / STAR_RADIUS)
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
    frameFocus(true)
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

/**
 * Whatever `make dump` last wrote, and otherwise the sample this repo ships.
 * graph.json is untracked, so a fresh clone has only graph.default.json — and
 * flying that one is a better first run than an error banner telling you to
 * dump something before the page will do anything at all.
 *
 * Chosen once, at startup: a dump landing later is a page reload away, and the
 * poller must not be checking two URLs forever.
 */
async function graphUrl(): Promise<string> {
  try {
    const res = await fetch('/graph.json', { method: 'HEAD', cache: 'no-store' })
    if (res.ok) return '/graph.json'
  } catch {
    /* no dev server, or no such file: the sample it is */
  }
  return '/graph.default.json'
}

void graphUrl().then((url) => {
  devlog('graph', { url })
  watch(url, (raw) => {
    graph = raw as Graph
    sources.clear()
    for (const n of graph.nodes) sources.set(n.id, { file: n.file, line: n.line, lines: n.lines })
    rebuild()
  })
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
  world.updateLabels(camera, renderer.domElement.clientHeight, 1)
  updateBeacon(beat())
  watchAim() // a cue can move the camera where no animation loop is running
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
  // Wanting the view somewhere is the same thing as wanting the controls, so
  // no cue has to ask. An explicit hold is the long lease; an explicit release
  // hands it back now rather than making anyone sit out the timer.
  if (cue.hold === false) giveWheel('remote')
  else if (cue.hold === true) takeWheel()
  else if (movesTheView(cue)) takeWheel(AUTO_HOLD_SECONDS)
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
  if (cue.panel) {
    // Cycle to it rather than setting it, so there is one route through the
    // mode change and the callout still happens.
    for (let i = 0; i < MODES.length && mfd.mode !== cue.panel; i++) mfd.cycle()
    paint()
  }
  if (cue.labels) {
    // Cycle to it rather than setting it, for the same reason as the panel:
    // one route through the change, and an unknown name leaves the ribbon
    // where it was instead of putting it somewhere invalid.
    for (let i = 0; i < LABEL_MODES.length && labelMode !== cue.labels; i++) {
      setLabelMode(cycleMode(labelMode, 1))
    }
  }
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
  world.updateLabels(camera, renderer.domElement.clientHeight, dt)
  updateBeacon(beat())
  watchAim()
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
