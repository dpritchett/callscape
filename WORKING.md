# Working on callscape

How to pick this up cold. `HANDOFF.md` is the original v0 brief and still describes the
shape of the thing; `ARCHITECTURE.md` has the ground rules; `DECISIONS.md` logs the
ten-minute calls. This file is the operating manual.

## Where it stands

A Go dumper and a three.js viewer, connected by two JSON files on disk.

Districts are packages, laid out as caps on a sphere — a crust. Inside a district,
symbols cluster by the file they live in; each file is a parcel, each symbol a building
straddling the ground. Select a symbol and its callers and callees light up; Tab swaps
the panel between counts and the function's actual source.

Currently loaded: **cli/cli** (3,501 symbols, 307 packages, 2.4MB graph), viewed with
generated code excluded — 2,448 symbols across 294 districts. Cloned to `../cli`.

The measurements throughout these notes were taken on **coder** (18,522 symbols, 355
packages, 10MB), which is four times the size and still the one to reach for when the
question is whether something scales.

## The loop

```sh
make dump TARGET=/path/to/module   # writes web/public/graph.json
make dev                           # vite on :5178
make dev-remote                    # the same, with the instruments below switched on
make check                         # vet, test, golangci-lint, tsc, vitest — what lefthook runs
```

**Use `make dev-remote` while working on this.** `make dev` serves the page and nothing
else; the endpoints the instruments talk to are not registered without
`UNSAFE_ENABLE_REMOTE_CONTROL=true`, because they are a remote camera and a source reader
on a server that binds the LAN, and a fresh clone should not be offering those to its
network on somebody's behalf. It prints a warning line when they are on.

With no `make dump` behind you the page flies `graph.default.json` instead: this repo,
dumped by itself, tracked so a clone has something to fly. `make sample` rebakes it and
should be run whenever the dumper's output changes shape.

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

**Poke the dev server with `scripts/page`, never with `curl`.** Same requests, except it
takes a path rather than a URL and has four verbs rather than all of curl's flags, so it
can only ever reach `:5178`:

```sh
scripts/page get /view.json
scripts/page head /badges/github.com/cli.png
scripts/page post /__cue web/cue.json
scripts/page post /__shot/request
```

That is the whole point of it. Working here means checking what the server is answering
several times an hour, and the alternative is somebody allowing `curl` in general — which
is a much bigger thing to hand over than "may reach my own dev server". `make shot` and
`make cue` go through it too, so the address is written down once.

`make cue` reads `web/cue.json` rather than taking an inline argument, so the command
line never varies. Edit that file to change what you are looking at. It is untracked
scratch — where you happened to be pointing — and `make cue` writes a starting one if
there is none.

**A cue takes the wheel by itself.** Anything that changes the view locks the local
controls for 5 seconds, and the next cue extends it, so a sequence of them reads as one
stretch of somebody else driving. You do not have to declare anything, and two people are
never steering at once. The banner across the top says who has it.

Two overrides. `"hold": true` is a long lease — 120 seconds, for going away to think —
and **`"hold": false` hands it back this instant**, which is worth sending the moment you
are done rather than leaving someone to wait out a timer. Escape always takes it back too:
the person in front of the screen outranks the remote.

The rest of the cue: `focus` a symbol id, `distance`, `yaw`, `pitch`, `select` a list of
ids, `reveal`, `clear`, `pick` the reticle, `flip` to look behind, `panel` and `labels` to
set those modes, `search` to open the query box (empty string closes it).

`"search": "Client.Get"` opens the symbol search on that query and logs what it ranked;
`"search": ""` closes it. Note that the panel is DOM and the shutter photographs the
canvas, so no screenshot has ever contained the HUD or the panel — the log and
`search.test.ts` are the only readers of that text.

`"labels": "aim"` sets the label ribbon — `all`, `pkg`, `fn`, `aim`, `off`. The ribbon
itself is a d-pad, a key and a click, none of which a cue has, and it is DOM so it is in
no screenshot either. What each mode does is legible from the terminal all the same: the
`renderMs` line carries `districtsVisible` and `symbolsVisible`, which on one parked
camera went 21/37 for `all`, 38/0 for `pkg`, 0/43 for `fn`, 1/2 for `aim` and 0/0 for
`off`. Note the cue polls every 400ms, so a `make shot` issued in the same breath
photographs the mode you were in before.

`"hold": true` takes the wheel: local input is ignored so an experiment is not fighting
whoever is holding the mouse, and a banner says so across the top. `"hold": false` gives
it back, Escape at the keyboard always takes it back, and it expires by itself after two
minutes — an agent that dies mid-experiment must not leave the page locked. Note the
banner is DOM, so it is in no screenshot; the person at the screen sees it, `make shot`
does not.

`"clear": true` presses the clear key, including its undo — a second one puts back what
the first dropped. `"flip": true` is the tail camera, arriving at once rather than
turning, since a cue may be driving a tab with no animation loop to turn it with.

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
| `labels.ts` | how big a label has to be to read at N pixels, which names win, how they arrive |
| `srcpath.ts` | path containment for the source reader |
| `district.ts` | what is in the district you are pointing at, ranked and listed |
| `wires.ts` | edges that follow the crust rather than cutting under it |
| `spans.ts` | Go token spans into coloured runs, cut on bytes not characters |

**Rendering and wiring** — no arithmetic that could live on the other side:
`world.ts` (three.js objects), `main.ts` (wiring, polling, HUD), `controls.ts` (camera and
input), `mfd.ts` (the panel), `sound.ts` (the voice), `sky.ts`, `shutter.ts`, `cue.ts`,
`devlog.ts`.

**Audio**: `web/public/sounds/*.wav`, one file per slug — nineteen spoken one-shots and
two flight beds, `flight-slow` and `flight-fast`, which loop while the camera is moving.
The beds are one sound at two speeds sharing a noise seed, so their gains are ridden
against each other rather than one being stopped and the other started. Both run for the
life of the page. `remote-on` and `remote-off` are tones rather than speech — falling when
the remote takes the wheel, rising when it gives it back — because the wheel changing
hands is a state change and a state change wants an earcon. `flip` is wired and silent
until its whoosh arrives — **from beatshop, not beepboop**, because it needs a filter that
travels over its duration and only beatshop has one. It will land the way the music does,
copied in by hand; `make sounds` will never produce it.

**A recipe change and a playback trim are different things.** The recipe decides what a
line says, how it is voiced and how hot it was baked; that lives in beepboop and changing
it means a rebake. `VOICE_LEVEL` in `sound.ts` is a fader on top, for the whole voice
sitting too far forward against the beds and the music. Reach for the fader first — it is
a mix decision, it needs no other repo, and it is one number.

One written track sits under all of it, `apollo-v1.flac`, looping. It only plays while
somebody has the controls — pointer captured, or a remote holding the wheel — because a
page sitting idle with the cursor free does not want a soundtrack. It comes from
beatshop, not from a recipe: `make music` copies it out of that project's
`out/archive`, and `make sounds` deliberately no longer touches it. FLAC rather than the
WAV beside it, at a fifth the size and sample-exact, so the loop has no seam.

It replaced two eight-second loops that took a minute each in turn. That handover existed
to make eight seconds of material last; 111 seconds of written music does not need it, so
the second gain and the minute timer went with them.
They are baked by [beepboop](https://github.com/dpritchett/beepboop) from
`recipes/navigator.json` over there and
committed here, so a clone runs with sound and without that toolchain. `make sounds`
rebakes; the recipe is the source of truth and the output is deterministic, so an
unchanged recipe rebakes to an empty diff. Never hand-edit a WAV. Wording, levels and
grit are all recipe changes — ask beepboop in plain language. `view.json` carries
`sound.enabled` and `sound.volume`.

**Go**: `cmd/callscape-dump` — loads a module with `go/packages`, emits nodes and statically
resolved call edges. `--lex <file.go>` is a second mode: token spans for one file from
`go/scanner`, no package loading, fast enough for the dev server to call per source
panel. Run `make build` and the plugin uses the binary; otherwise it falls back to
`go run`, and if neither works the panel is uncoloured rather than broken. A stale
binary is a stale lexer — rebuild after touching `lex.go`.

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
- **An `<audio>` element is driven from the main thread.** That is the same thread
  running `place()` and every frame here, so a rebuild or a big redraw stuttered and
  dropped whatever was talking — the voice audibly bound to the rendering. Web Audio
  renders on its own thread: decode into an `AudioBuffer` once and a 350ms stall cannot
  interrupt a line that has already started.
- **A rule outlives the thing it was written for.** Districts hid on selection because
  translucent caps stacked into milk. They were made opaque three commits later and the
  hiding stayed, so selecting a symbol deleted the map around it. Worth asking, when
  something looks wrong, which of its rules were written about a different version.
- **Poll with HEAD and an ETag.** Re-fetching a 10MB graph every 400ms to discover it is
  unchanged is 25MB/s of nothing.
- **A missing file under `public/` is a 200, not a 404.** Vite's SPA fallback hands back
  `index.html` for anything it cannot find, so a status check is not an existence check.
  The badge loader gets away with it because an `<img>` fed HTML fails to decode and its
  error handler fires anyway — but anything that trusts the status code will believe a
  file is there and then parse a web page.

## Known limits and open threads

- **Interface calls resolve to the interface method, not the implementation.** On
  gitlab-kiosk only 4 of 67 drawn edges crossed a package. This is the thing to fix
  before the CLI query vector is trustworthy: "who calls this" returning a confidently
  incomplete answer is worse than one that admits it cannot see.
- **Symbols are instanced now.** On full coder (18,522 symbols) the same cued view renders
  in 0.8–1.7ms at 78 draw calls, against 9.1–10.6ms at 1,129 before. What is left in a
  frame is the districts: 355 caps and 355 rims, each its own object.
- **Labels can be occluded by geometry.** Decluttering only checks label against label.
- **District names are boxes floating over the map.** They hold a fixed pixel height so
  they read from anywhere, which is why they win, but a screenful of them sits on top of
  the thing it is describing. Painting the name onto the district's own ground is the
  obvious alternative and does not survive the arithmetic — `DECISIONS.md` has the
  working. What exists instead is the ribbon: five modes on the d-pad, `L`, a click or a
  cue, so how much is named is a control rather than a compromise.
- **Panels.** Agreed shape is MFDs — two or three small displays that swap modes — rather
  than a dashboard. `info`, `source` and `district` exist, and `/` opens a symbol search
  that takes the keyboard until Escape. Still missing: clickable callers/callees for
  traversal, and a minimap, which is what would make the HUD an actual navigation aid
  rather than a debug readout.
- **`district` is the only mode that works with nothing selected**, because it is about
  where you are rather than what you picked. Which district you are on is chosen by angle
  to its *edge* rather than its centre, so a wide district does not win just by having its
  middle near the view axis. The answer goes to the log as `aim`.
- **Search only sees what is placed.** A symbol the occupant filter dropped cannot be
  found, because there is nowhere to fly to. The panel says how many symbols the query
  ran against so the answer is not silently partial.
- **A second panel is just a second view spec** watching the same selection. That is the
  cheap way to add one.
- **Generated code** is detected and filterable. `fanInPkgs` (distinct calling packages)
  is usually the honest ranking; raw `fanIn` measures how often something is typed, which
  codegen dominates.
