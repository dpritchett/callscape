# Decisions

Ten-minute-rule calls, with what was rejected.

**Package mode includes `NeedModule`.** The handoff's mode list has no way to learn the
module path or root directory, and both are needed (module path to tell "declared here"
from "a dependency", root dir to make `file` relative). Rejected: parsing `go.mod` by
hand.

**Load errors warn, they don't stop.** A package that fails to type-check still
contributes its neighbours' edges. Rejected: failing the run, which makes the tool
useless on any module mid-refactor.

**Node ids are `pkg/path.Recv.Method`.** Generic type parameters are dropped from the
receiver, so `Cache[T].Get` and `Cache[string].Get` are one node. Rejected: encoding
instantiations, which multiplies nodes for no gain at this scale.

**`*` in a package glob crosses `/`.** The handoff's own example, `*/internal/gitlab`,
only matches a full module path if `*` spans separators. Rejected: doublestar `**`
semantics, which would have made every example in the handoff wrong. Runs of `*` collapse
to one before the pattern is compiled, so a stray `**` cannot turn into `.*.*` and
backtrack.

**Districts are ordered alphabetically around the ring.** Determinism as specified —
same package set, same layout — but adding a package shifts its neighbours. Rejected:
hashing the path to a fixed angle, which is stable per package but packs discs into each
other.

**Ring radius is found by bisection.** Sizing the ring from summed arc lengths let
neighbouring discs overlap, because the chord between two centres is shorter than the arc
(a test caught this). Now the ring is the smallest radius at which every disc's angular
width fits in 2π. Rejected: a fudge factor on the arc-length estimate.

**Symbols sit in a square grid inside the disc, sorted by name.** Corners of the grid
reach the rim, so a district's radius grows as `sqrt(members)`. Rejected: packing them in
a spiral, which reads as prettier but makes "where was that symbol" harder.

**Selection, layout and encoding are one pure function**, `place(graph, view)` in
`placement.ts`, returning plain data — no three.js, no DOM. `world.ts` only draws. That
is what makes the interesting half testable.

**The browser polls `graph.json` and `view.json` every 400ms** and diffs the raw text.
Vite's own watcher is told to ignore `public/*.json`, because a public-dir change
triggers a full page reload and that resets the camera — the one thing the edit loop must
not do. Rejected: a websocket or a custom Vite plugin.

**A bad `view.json` keeps the last good scene** and shows the parse error in a bar at the
bottom of the screen. The poller only advances its "last seen" marker after a successful
apply, so the error stays up until the file is fixed. Rejected: clearing the scene, which
punishes a typo with a blank screen.

**Labels are sized in pixels, not world units.** Each frame a label's world height is
recomputed from its distance to the camera, so it holds ~20px (districts) or ~13px
(symbols) on screen. Fixed world sizes meant a district name was unreadable from across
the map and enormous from inside the district. The clamps either side are a guard against
distance 0, not a design choice — a test pins that they never bind at the scene's own
scale. Rejected: HTML overlay labels positioned by projection, which needs its own
z-ordering and occlusion handling.

**`camera.focus` is only auto-framed on first load.** After that it is the F key. Editing
`view.json` must not move the camera.

**No screenshot in the deliverables.** Headless Chromium on this WSL box is missing
system libraries (`libasound.so.2`), and installing them needs root. Rejected: adding
Playwright to `web/` for one image.

**Symbols are one `InstancedMesh`; the selection is not.** Per-instance colour can carry
the hue but not the selected symbol's whole material, which is white with a strong
emissive in the node's colour. One or two real meshes for whatever is selected costs
nothing to traverse and keeps the look identical. Rejected: a second instanced mesh for
the hot ones, which needs the instance colour to mean two different things.

**Instanced emissive comes from a two-line shader patch.** `emissive` is a uniform, and
the per-node materials this replaced tinted it with the node's own colour — dropping it
darkens every face the key light misses. `onBeforeCompile` multiplies it by `vColor`,
and a missed chunk match is logged rather than left to be noticed. Rejected: one
`InstancedMesh` per colour, which is fine for the 12-entry palette and degenerates into
thousands of draw calls the moment `encoding.color` names a numeric field.

**District labels are the nearest N *on screen*, not the nearest N.** Plain nearest-N is
right only when the nearest districts are the ones you are looking at, which is true
outside the shell and false inside it: from in there every district is about the same
distance away, so the fourteen slots went to districts scattered over the whole sphere
and most of them were behind the camera. Only five to ten of fourteen ever survived to be
drawn. Filtering by the camera frustum first spends the slots on names that can be read.
Symbol labels deliberately keep the old rule — with a selection up they show at any
distance, because by the time you have stopped moving the thing you selected is usually
behind you.

**Focus means the selection, when there is one.** `F` framed `camera.focus` from the view
spec whatever was on screen, so from anywhere in the graph it flew you to a symbol you
had picked in a config file hours ago — or to the origin, a point in the middle of the
shell that is nowhere in particular. It now frames the most recent pick, which is the one
the panel is describing, and falls back to the view's focus and then the origin. Rejected:
a second key, which splits one verb in two.

**The source panel is coloured by `go/scanner`, not by a highlighter.** A browser
highlighter guesses at a grammar this project already ships a lexer for, and the lexer is
the one the compiler uses. `--lex` is one file with no package loading, so the dev server
can ask per panel. Rejected: Prism or Shiki, which is a dependency to approximate
something already on disk; and lexing in TypeScript, which is the same guessing written
by hand.

**Spans are cut on the bytes, in Node, not in the browser.** `go/scanner` reports byte
offsets and JavaScript string indices are UTF-16 code units, so one `é` in a comment puts
every later colour on the wrong character. The dev server has the file as a Buffer, so it
does the cutting and hands the page runs of text — which also means the page never needs
to know an offset. `runsForLines` is pure and tested, including a case with a multi-byte
rune ahead of a keyword. Rejected: sending offsets and slicing in the browser, which is
correct only for ASCII.

**The listing is built from DOM nodes, not from an HTML string.** It renders arbitrary
source off somebody's disk; as markup that needs escaping to be right, and `textContent`
cannot be broken by what a file happens to contain. Rejected: `innerHTML` with an escape
function, which is one forgotten call away from executing the file it is displaying.

**Semantic classification is not in this.** Telling a type from a variable needs
`types.Info`, which means a full `go/packages` load — the slow thing `make dump` does —
and doing that per panel open would cost seconds. It belongs at dump time if it is ever
worth the size, and the lexical classes are most of the readability for none of that.

**Clear undoes itself on a second press.** `X` sits next to the keys you fly with and it
throws away the expensive part — finding the symbol, not selecting it — so hitting it by
accident cost a search. The second press puts back what the first dropped, and only the
ids still placed, since a view change in between can filter one out. Rejected: a
confirmation, which taxes every deliberate clear to protect against the rare one.

**Burn is a sprint that expires, and normal speed is the default.** Fast used to be the
default with shift toggling it off, which meant arriving somewhere at 250 u/s and having
to remember to slow down before you could look at anything. Now shift lights the burn and
half a second at rest puts it out. At rest means no input *and* no drift left — letting
go coasts, and a coast is still moving. The timer lives in `motion.ts` with the rest of
the movement model, so "half a second" is tested without a clock: never early, never more
than one frame late, at 24, 60 and 144fps. Rejected: hold-to-burn, which is a key held
down for the entire time you are going anywhere.

**Music plays while somebody is flying, and not otherwise.** The two loops run for the
life of the page like the flight beds, and only their gain moves — a minute of one mood,
then a minute of the other, crossfaded over three seconds, forever. On means the pointer
is captured, or a remote is holding the wheel, or a query is open: typing is still driving
the sim even though it hands the pointer back to do it. The state it is the opposite of is
the page sitting there with the cursor free, which is somebody reading a panel or gone for
coffee. Letting go stops it inside a second — naming the search outright is what let the
stop be immediate, rather than delayed by a grace period covering for that one case.
Rejected: keying it to burn or to having a selection, which are both things you do
briefly and often, and would turn the soundtrack into a stutter.

**The selection pulses, and casts light.** A thing that glows steadily is only findable by
looking straight at it. Two signals rather than one: the symbol's own emissive breathes at
0.8Hz, which a glance catches out of the corner of an eye, and a point light stands where
it does, so nearby towers are lit by something you cannot see — the way a torch off to one
side tells you where it is at night by what it lights up. The light is made once at zero
intensity and moved, because adding a light to a scene recompiles every material in it.
Limit worth knowing: the district ground is `MeshBasicMaterial` and takes no light, so the
beacon washes the buildings and not the floor. Rejected: pulsing the size, which reads as
the geometry being unstable rather than as a signal.

**An edge inside a district arcs over it; an edge between districts still cuts through.**
A straight line between two points on a sphere is a chord, and a chord sinks below the
surface it spans — 33 units across the widest district on coder, well under opaque
ground, which is why a district's own edges could be seen only from inside the shell.
Lifting the ends does not fix it, because the sag grows with the square of the length:
whatever constant clears the long ones leaves the short ones floating. So an in-district
edge is an arc at a fixed height above that district's own ground — and a second arc the
same distance under it. Opaque ground has one side each way, so a single arc only moves
which half of the shell cannot see it; the buildings already answered this by straddling
the crust and protruding both ways, and a wire is no different. Cross-district edges
are left alone: they pass through the middle of the sphere, and that is a tunnel rather
than a road. Bending them over the crust would empty the interior and turn the whole
thing into a surface map, which is a different picture, not a fix. Rejected: drawing
edges on top of everything, which shows you wires from the far side of the globe.

**The tail camera turns rather than cuts, and it is a fifth of a second.** A hard swap
reads as two separate places; watching the world go past reads as one place with
something behind you. Yaw turns half a circle and pitch changes sign — flipping yaw alone
leaves you staring at the floor behind you, and that convention is checked against
three.js in a test rather than against itself, since getting the pitch sign wrong passes
any test that uses the same formula twice. Look input is ignored while it runs, which at
0.2s nobody notices. Rejected: an instant swap, which is what was asked to be avoided.

**Labels are rechosen when the camera turns, not only when it moves.** Filtering the
choice by what is on screen cost the rotation-invariance that plain nearest-N had. The
tail camera found it: flipping on the spot left every label behind the camera and the
view unlabelled. Two degrees of turn is enough to reconsider.

**A continuous sound beats a callout for a continuous state.** "burn" and "coasting" were
spoken once at the moment the speed changed; the flight bed says which gear you are in
for as long as it is true, so the lines were dropped rather than kept as a second, worse
copy of the same fact. The same reasoning is why the control banner is always on screen
instead of appearing when something takes the wheel: a state you can see is better than
an event you had to catch.

**A remote hold locks the local controls, and has two ways out.** An agent taking
screenshots and a person flying by hand were fighting over the same camera, and neither
could tell which of them had moved it. `"hold": true` in a cue ignores every local input
for two minutes. The escapes are not optional: it expires on its own, because an agent
that dies mid-experiment must not leave the page locked, and Escape at the keyboard takes
it back immediately, because the person sitting in front of it outranks the remote. It
says so in a banner across the top, since a page that quietly stops answering the
keyboard is indistinguishable from a broken one. Rejected: a silent lock, which is the
bug it exists to avoid, wearing a different hat.

**The flight beds are two loops that never stop.** They are one airflow at two speeds —
same partials, same noise seed, filter opened — so the speed change is a crossfade
between two gains rather than one source stopping and another starting. Both run for the
life of the page and are ridden at zero when the camera is still. `AudioBufferSourceNode`
with `loop = true`, because the HTML `<audio loop>` attribute re-opens the stream on each
repeat in several browsers and inserts a gap the file does not have. Rejected:
normalising them, which would undo the levelling that keeps callouts intelligible over
the bed.

**The voice goes through Web Audio, not an `<audio>` element.** An element is driven from
the main thread, which here also runs `place()` and every frame, so a rebuild cut the
line that was talking — the audio was audibly bound to the rendering. Buffers are decoded
once at startup and played on the audio thread, where a stalled main thread cannot reach
them. Rejected: shortening the lines, which treats a symptom and gives up the words.

**One voice at a time, cut with a 15ms ramp.** `select`, `capture` and the speed toggle
fire on every click and keypress and each line runs about a second, so overlapping them
stacks a crowd talking over each other. A new line ends the one in progress, which is
what an annunciator does. The ramp is because stopping speech mid-syllable clicks, and a
click reads as a fault. Rejected: a queue, which makes the voice fall further behind the
thing it is describing.

**Voice lines are committed, not built.** They are baked by beepboop from a recipe in
that repo, and audio is build output there. Here it is checked in: this project has no
build pipeline on purpose, and a clone that needs another repo and a Piper voice model
before it makes a sound is not one you can run. `make sounds` rebakes deterministically,
so the artifact and the recipe cannot silently disagree. Rejected: fetching them at
startup, which adds a network dependency to a page whose whole point is local files.

**`sound` is a view spec block, not a mute key.** The stated agreement is that new knobs
belong in `view.json` as a closed struct rather than in browser state, and this one earns
it: turning the voice down is editing the same file that changes everything else, and it
applies within a second without a reload. Rejected: an `M` key, which is one more binding
to remember and invisible to anyone reading the config.

**A selection hides symbols, never ground.** Districts used to hide along with their
contents, because a cap was then a translucent disc and dozens of them stacked between
the camera and the selection were most of the milk in the picture. Caps have been opaque
since; the near crust hides the far side by itself, and what the old rule was actually
removing was the map. Selecting a symbol arrived at by search left it floating alone in
the void with nothing to say where it was. The selection's own packages keep all their
buildings too — a symbol alone on an empty disc is not standing anywhere. Rejected:
showing every building at full brightness, which puts the one you picked among eight
thousand others and is the haze the hiding rule exists to avoid.

**Search is modal, and takes the keyboard while it is open.** WASD flies whether or not
the pointer is captured, so every letter of a query was also a flight control and `x`
dropped the selection being looked for. The controller has a `setTyping` switch, opening
the search releases the pointer, and capturing it again closes the search — otherwise
Escape, the key that would close it, is spent by the browser on letting the pointer go.
Rejected: an HTML `<input>`, which needs the panel to take pointer events and puts the
page's one text field where a stray click lands in it.

**Ranking is four tiers, and ties break on the id.** Exact name, name prefix, name
anywhere, then anywhere in the full id — which is what finds a symbol by its package or
by `Client.Get`. Within a tier the symbol more packages call wins, then the id, so the
order is total and identical in any input order. Rejected: fuzzy subsequence matching,
which ranks by a score nobody can predict and needs its own tuning session.

**The panel's text is a pure function.** The shutter photographs the canvas, so no
screenshot this project can take has ever contained the HUD or the panel. Formatting it
in `search.ts` rather than in `mfd.ts` gives that text its only reader other than a
person looking at the glass. Rejected: leaving it in the renderer and checking it by
asking someone what their screen says.

**The remote trigger calls the click handler, not a synthetic click.** `"pick": true` in
a cue invokes the same function the mouse, the space bar and the gamepad already invoke,
so there is one path and the remote cannot drift from it. Rejected: dispatching a
`MouseEvent` at the canvas, which needs pointer lock the page can only enter from a real
user gesture, and would test the event plumbing rather than the picking.

**A hidden instance keeps its position and loses its basis.** `InstancedMesh` has no
per-instance visibility; zeroing the three basis columns collapses the box to a point,
which draws nothing and cannot be hit by a ray. Rejected: a zero matrix, whose `w` is 0.
