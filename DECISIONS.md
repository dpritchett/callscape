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

**The right stick is a control column, the mouse is still a mouse.** Pull back to climb,
push to dive, left and right roll rather than yaw — so a turn is banking and pulling back,
the way an aeroplane does it, instead of sliding the horizon sideways. The inversion is
only on the stick: a mouse that climbed when you pushed it away would be wrong, and the
two devices are allowed to disagree because people already expect them to.

Both turns happen in the camera's own frame, by right-multiplying its quaternion, rather
than by moving euler components. As eulers it was wrong the moment you banked: pitch there
turns about a horizontal axis whatever the wings are doing, so pulling back while rolled
took the nose towards the sky instead of towards the top of the screen. A local rotation
has no opinion about which way is up. Measured at four bank angles including inverted, the
nose moves towards viewport-up by 0.99 every time; banked ninety degrees a pull gives zero
climb and a third of a radian of turn, which is what banking and pulling back is for.

No pitch clamp on the stick — a quaternion has no gimbal to lock and an aeroplane can loop
— while the mouse keeps one, measured from where the nose actually is rather than from a
stored angle. Strafing uses the camera's own right rather than the horizon's, identical
while the wings are level and correct once they are not. `F` levels the wings, since
framing rebuilds the orientation from a `lookAt`.

**The orientation is the only record of where the camera points.** It used to be mirrored
by a euler that the mouse steered with, the two kept in step by resyncing one from the
other — which is agreement by convention, and near the poles they stop agreeing: the YXZ
decomposition is degenerate there, yaw and roll become the same edit, and the mouse jumps.
Taking the clamp off the stick made that reachable. So the euler is gone: mouse yaw
pre-multiplies about world up, everything else post-multiplies about a body axis, and the
tail camera is half a turn about the camera's own up. That last one also settled a
question the angles could not: what a bank should become when you look behind you. As a
head-turn it has no opinion to get wrong — and it disagreed with the euler version by up
to 1.4 in the up vector, which is how much the old one was inventing.

**Triggers are the rudder.** They used to push along the world's vertical axis, the last
thing on the pad still pegged to a direction only the outside world can see. Once the
right stick took roll, yaw had nowhere left to live, and without it the only way to turn
is to bank — authentic, and occasionally useless. Rejected: leaving them as a climb and
descend pair in the camera's own frame, which is a thing the stick already does better by
pointing the nose.

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

**Labels are ranked by the reticle, not by the nose.** Nearest-N spends its slots on
whatever the camera is passing over, which is the bottom of the frame, so the thing being
aimed at was the one thing without a name. `labelRank` is distance penalised by angle off
the view axis, full penalty at the corner of the frustum, and the same score orders both
kinds. Rejected: labelling by screen position after projecting every symbol, which is the
same ordering for more work and needs the viewport to mean anything.

**The candidate pool is large and the screen does the limiting.** Fourteen districts and
forty symbols were a hard cap on a screen that had room for four times that. Ninety and
a hundred and sixty go into declutter instead, which drops whatever collides — so the
count you see is what fits rather than a number chosen years earlier. Rejected: tuning
the caps per altitude, which is the same guess with more places to be wrong.

**Districts get six slots before symbols compete on merit.** Districts placing first all
the way down was fine at fourteen of them; at ninety, a pass down among the buildings
spent the whole screen on the package names of districts behind them. Six keeps the map
from going anonymous, and past that a name a few units away beats one a few hundred away
whatever kind it is. Rejected: separate screen budgets per kind, which needs a rule for
where the boundary goes and gets it wrong at every altitude in between.

**A name walks in over its own ground rather than sitting on its centre.** A district
wider than the screen has its centre off the edge of the frame, so the biggest thing in
view was the only thing unnamed. `axisAnchor` slides the name towards the view axis by up
to eight tenths of the district's radius. Rejected: clamping the sprite to the edge of
the screen, which parks a name over ground that is not its own and lies about what you
are looking at.

**Labels fade rather than switch.** Which names win is decided in jumps — every two
degrees of turn, and again every frame in the packing — so applied straight to visibility
it reads as half the screen blinking while you fly. A fifth of a second of smoothstep
covers it, and a label on its way out stops claiming space so the one replacing it can
cross over. The shutter passes a whole second as its `dt`, which settles every fade at
once: a screenshot caught mid-dissolve says nothing about what the page decided to show.
Rejected: latching a label on for N frames once chosen, which makes the popping periodic
instead of removing it.

**A district's name cannot live on its ground.** Two shapes were worked through: the name
arced around the rim like the text on a coin, and the name as a medallion in the middle
with the buildings reseated into a ring around it. Both die on the same arithmetic. A
district's radius is sized by its contents, 12 to 180 units, while its name is a fixed
number of characters — a one-symbol district has 75 units of circumference to spend on
`coderd/awsidentity`. Either the text comes out unreadable or the district grows to hold
its name, and then radius stops saying how much code is in there, which is the only thing
it currently says. Anything painted on the ground also foreshortens to a line when the
cap is edge-on, which is most of the crust from most places. A billboard is screen-space
and immune to both. Parked rather than rejected on taste: a ground name would have to be
a second label that hands over to the billboard, not a replacement for it, and the
floating boxes being awkward is still an open complaint.

**That arithmetic has since moved.** Labels are the shortest unique suffix now, so the
mean name is 10.6 characters rather than 20.1. A one-symbol district has 75 units of
circumference and needs about half of what it did, which puts arced rim text back inside
the realm of the possible for anything but the smallest districts. The other half of the
objection stands unchanged: ground text foreshortens to a line when the cap is edge-on,
and it cannot hold a pixel height. Worth another look, from the new numbers, before
anyone re-derives the old ones.

**How much is named is a control, not a rule.** No single answer is right at every
distance: crossing the shell wants package names and nothing else, standing in a district
wants the functions, and lining something up wants the one thing under the reticle. The
ribbon is five modes — `all`, `pkg`, `fn`, `aim`, `off` — stepped by the d-pad, `L`, a
click, or a cue. Rejected: choosing the mode from altitude, which is a rule that would be
wrong at somebody's favourite distance and cannot be argued with when it is.

**The ribbon is seeded by the view spec and then owned by whoever is flying.** `view.json`
is the control surface, but it is also polled every 400ms, and a file that puts the labels
back four hundred milliseconds after you changed them is not a control. The spec's value
applies when it *changes*, which is the difference between the file saying `all` and the
file having just changed its mind to `all`. Rejected: browser-only state with no spec key,
which would make the starting position unsettable and the mode unreachable from a cue.

**The d-pad steps the ribbon.** It is the only cluster on the pad the flight model never
wanted — everything else is an axis or already spoken for — and stepping a ring is what a
four-way rocker is for. On the keyboard it is `L`, forwards only: shift already toggles the
burn on its own keydown, so shift-L would light the engines every time you stepped back,
and a ring of five reaches everything going one way.

**The arrow keys are the control column, and down climbs.** Mouse look can drag the nose
around but has no answer at all for roll, so a keyboard could only ever fly the map
upright while a pad could bank through it. The arrows read as the right stick reads:
`ArrowDown` pulls back and climbs, left and right roll rather than yaw. Inverted against
what a scrollbar would do, deliberately — there is one convention in this cockpit and the
pad already set it. A held key counts as six tenths of full deflection, because a key has
no travel and full stick is 150 degrees a second. The mapping lives in `motion.ts` under
test rather than inline in the controller, since a sign convention is the thing that
silently inverts. Rejected: binding roll to a spare letter pair, which leaves the arrows
unused and the two halves of the column on different parts of the keyboard.

**`aim` walks the name to the reticle rather than waiting to find it.** The district you
are pointing at is usually the one you are inside, and the widest on coder is 180 units
across, so its centre is nowhere near the middle of the screen — the usual eight-tenths
margin left the name off screen entirely, which is the one outcome this mode cannot have.
It also skips the on-screen test the other names take: the reticle being on it is what
"on screen" means.

**The project is called callscape.** `lspvue` claimed two things that were never true:
there is no language server anywhere in it — the dumper reads `go/packages` — and there
is no Vue. The name would have become load-bearing the moment the repo went public and
`go install github.com/dpritchett/lspvue/cmd/lspvue-dump@latest` started working, so it
was changed while nobody had typed it: module path, command, env var, plugin names, npm
package, page title, and every mention in the prose. Rejected: keeping it and explaining
the name in the README, which is a paragraph of apology on the front page forever.

**`graph.json` is untracked; `graph.default.json` is the tracked sample.** Tracking the
dump is what made `make dev` work on clone, and also what would have committed a
module-sized blob every time the dump target changed — and `.gitignore` cannot stop that
once a file is tracked. `make sample` bakes the fixture from this repo, so it is small,
generated (it cannot drift from what the dumper emits), and deterministic (an unchanged
dumper rebakes to an empty diff). The page and the diagnostic test both take the dump
when it exists and the sample otherwise, which keeps a stranger's `make check` green.
Rejected: telling the reader to run `make dump` first, which costs clone-and-run for the
one thing this project is trying to show; and hand-maintaining a trimmed fixture, which
rots on the first schema change.

**The graph never says where the module lives.** `root` was an absolute path from the
machine that ran the dump — a home directory, published in a file meant to be committed
and screenshotted. The client never read it; only the dev server did. It is a local fact,
so it lives in a local untracked file that `make dump` writes, and with no pin the answer
is this repo, which is right for the sample. Rejected: leaving the field and stripping it
before commit, which is a rule someone has to remember.

**A cue takes the wheel without being asked to.** Holding the controls used to be a thing
the remote had to declare, which meant it got forgotten exactly when it mattered — halfway
through lining a shot up, with two people steering and the camera going somewhere neither
of them asked for. Wanting the view somewhere *is* wanting the controls, so any cue that
changes anything locks them for five seconds and the next cue extends that. `hold: true`
survives as the long lease for going away to think, and `hold: false` hands it back
instantly, which matters more than the automatic part: nobody should have to wait out a
timer to get their own page back. Rejected: a longer automatic hold, which turns every
stray cue into a five-second lockout you cannot shorten; and leaving it declared-only,
which was the status quo and did not survive one working session.

**`.claude/settings.json` stays tracked.** It is a Bash allowlist with no secrets in it,
and it is the same kind of artefact as `lefthook.yml` — a description of how this repo is
worked on, which is part of what the repo has to say. Rejected: untracking it as a
reflex about dotfiles, which hides something a reader might actually want.
