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

**A hidden instance keeps its position and loses its basis.** `InstancedMesh` has no
per-instance visibility; zeroing the three basis columns collapses the box to a point,
which draws nothing and cannot be hit by a ray. Rejected: a zero matrix, whose `w` is 0.
