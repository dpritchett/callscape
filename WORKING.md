# Working on lspvue

How to pick this up cold. `HANDOFF.md` is the original v0 brief and still describes the
shape of the thing; `ARCHITECTURE.md` has the ground rules; `DECISIONS.md` logs the
ten-minute calls. This file is the operating manual.

## Where it stands

A Go dumper and a three.js viewer, connected by two JSON files on disk.

Districts are packages, laid out as caps on a sphere — a crust. Inside a district,
symbols cluster by the file they live in; each file is a parcel, each symbol a building
straddling the ground. Select a symbol and its callers and callees light up; Tab swaps
the panel between counts and the function's actual source.

Currently loaded: **coder** (18,522 symbols, 355 packages, 10MB graph), viewed with
generated code excluded — 7,941 symbols across 321 districts.

## The loop

```sh
make dump TARGET=/path/to/module   # writes web/public/graph.json
make dev                           # vite on :5178
make check                         # vet, test, golangci-lint, tsc, vitest — what lefthook runs
```

Then edit `web/public/view.json` while the page is open. It applies within a second,
without a reload and without moving the camera. That loop is the point of the project;
anything that breaks it is a regression regardless of what else it improves.

## Instruments

The page is observable from a terminal. This matters more than it sounds — most of the
bugs in this repo were found by looking at these rather than by reasoning.

```sh
make logs    # tail web/dev-log.jsonl: console, errors, input, rebuilds, frame timings
make shot    # the page screenshots itself to web/shots/latest.png
make cue     # push web/cue.json to the page: focus, select, distance, yaw, pitch, pick
make look    # cue then shot
```

`make cue` reads `web/cue.json` rather than taking an inline argument, so the command
line never varies. Edit that file to change what you are looking at.

`"search": "Client.Get"` opens the symbol search on that query and logs what it ranked;
`"search": ""` closes it. Note that the panel is DOM and the shutter photographs the
canvas, so no screenshot has ever contained the HUD or the panel — the log and
`search.test.ts` are the only readers of that text.

`"pick": true` in a cue pulls the trigger: it runs the click handler on whatever the
reticle is on once the rest of the cue has been applied, and the result lands in the log
as a `pick` event with the id it hit and whether the ray hit exactly. That is the only
way to exercise picking without a mouse — `select` names an id and skips the code that
decides it. The camera still has to be settled first, which is why `pickAtReticle` calls
`updateMatrixWorld` itself rather than trusting the last frame.

Screenshots capture on demand even when the tab is backgrounded, because the shutter
renders its own frame — `requestAnimationFrame` stops in a hidden tab, so the first
version could only take a picture while somebody was already looking at the page.

Watch out: after a source edit the page reloads, and a `make shot` issued too early
returns the *previous* image. Check `web/dev-log.jsonl` for a fresh `shot` entry, or the
vite log for the reload, before trusting a capture.

## Where things live

**Pure, tested, no three.js and no DOM** — this is where the interesting logic goes:

| file | what |
|---|---|
| `placement.ts` | `place(graph, view)` — the whole model, plain data in and out |
| `layout.ts` | shell packing, district parcels, building seats |
| `select.ts` | occupant filtering: globs, minFanIn, limit, generated |
| `selection.ts` | neighbourhood: callers, callees, edge roles |
| `search.ts` | go to symbol: ranking, and the panel text it prints |
| `motion.ts` | the flight model |
| `labels.ts` | how big a label has to be to read at N pixels |
| `srcpath.ts` | path containment for the source reader |

**Rendering and wiring** — no arithmetic that could live on the other side:
`world.ts` (three.js objects), `main.ts` (wiring, polling, HUD), `controls.ts` (camera and
input), `mfd.ts` (the panel), `sky.ts`, `shutter.ts`, `cue.ts`, `devlog.ts`.

**Go**: `cmd/lspvue-dump` — one file, loads a module with `go/packages`, emits nodes and
statically resolved call edges.

## Working agreements

- **Edit and Write, never `sed`/`awk`/`cat > file <<EOF`.** A single sed pattern matched
  two call sites here and broke the build; shelling out for edits also trips permission
  prompts that the tools do not.
- **Run single commands, not pipelines**, when a prompt would be annoying. Each stage of
  `make check | grep x | head` is checked separately against the allowlist.
- **No `Co-Authored-By` trailers** on commits.
- **Check the repo's own facts before recommending a practice.** `git log`, a grep, a
  measurement. Several long arguments here were settled in fifteen seconds by one
  command that should have come first.
- **Commit small and often.** Several changes went four rounds deep before landing;
  smaller commits would have made the bad ones cheaper to drop.
- **`view.json` is the control surface.** New knobs belong in the view spec, parsed as a
  closed struct, rather than in browser-only state.

## Gotchas already paid for

Every one of these cost real time. They are not hypothetical.

- **Transparency is order-dependent.** Every district cap is a patch of the same sphere,
  so dozens overlap on screen and the paint order changes as the camera turns — the
  surfaces visibly wobbled. Fixed `renderOrder` made it worse; additive blending works
  but cannot be tuned to a readable strength; opaque ground has one right answer.
- **Sprites are fogged by default**, and the fog is sized to the scene. That is why
  distant labels vanished — not size.
- **A sprite is a padded canvas.** Sizing the sprite to N pixels gives a fraction of that
  in glyphs, and worse per line. Size the *text*.
- **Same rule at every scale is a fractal.** Golden-angle spirals for districts, parcels
  and buildings made a mandala. Different rules per scale, irregularity from the data.
- **Centre-out placement radiates.** Anything swept outward from a middle looks like a
  snowflake. Accretion — new thing pressed against an existing thing — does not.
- **Uniform lattices cannot pack mixed sizes.** Spacing has to fit the biggest, so the
  crust covered 9.9% of its sphere. Accretion got it to 63%.
- **Search steps must scale with the container, not the item.** A one-symbol parcel could
  only look 108 units from its district's centre, so packing failed and the district grew
  101× trying.
- **three.js walks every object each frame.** 18k individual meshes cost 273ms/frame at
  12 draw calls — traversal, not drawing. Merging static lines and freezing matrices got
  it to 80ms; making the buildings one `InstancedMesh` finished the job.
- **A backgrounded tab stops rendering entirely**, including frame-rate logging.
- **Poll with HEAD and an ETag.** Re-fetching a 10MB graph every 400ms to discover it is
  unchanged is 25MB/s of nothing.

## Known limits and open threads

- **Interface calls resolve to the interface method, not the implementation.** On
  gitlab-kiosk only 4 of 67 drawn edges crossed a package. This is the thing to fix
  before the CLI query vector is trustworthy: "who calls this" returning a confidently
  incomplete answer is worse than one that admits it cannot see.
- **Symbols are instanced now.** On full coder (18,522 symbols) the same cued view renders
  in 0.8–1.7ms at 78 draw calls, against 9.1–10.6ms at 1,129 before. What is left in a
  frame is the districts: 355 caps and 355 rims, each its own object.
- **Labels can be occluded by geometry.** Decluttering only checks label against label.
- **Panels.** Agreed shape is MFDs — two or three small displays that swap modes — rather
  than a dashboard. `info` and `source` exist, and `/` opens a symbol search that takes
  the keyboard until Escape. Still missing: clickable callers/callees for traversal, and
  a minimap, which is what would make the HUD an actual navigation aid rather than a
  debug readout.
- **Search only sees what is placed.** A symbol the occupant filter dropped cannot be
  found, because there is nowhere to fly to. The panel says how many symbols the query
  ran against so the answer is not silently partial.
- **A second panel is just a second view spec** watching the same selection. That is the
  cheap way to add one.
- **Generated code** is detected and filterable. `fanInPkgs` (distinct calling packages)
  is usually the honest ranking; raw `fanIn` measures how often something is typed, which
  codegen dominates.
