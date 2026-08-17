# callscape v0 — agent handoff

## What you're building

Two programs. A Go command that turns a Go module into a graph file, and a browser page
that flies through it.

```
callscape-dump ~/P/gitlab-kiosk > web/public/graph.json
cd web && npm run dev
# open localhost, fly around glk
```

Target repo is `~/P/gitlab-kiosk`: one Go module, ~20k lines, 135 files. It's a cobra CLI
with an `internal/gitlab` client. The person reading your output wrote it and knows what
the answers should be, so wrong output will be obvious.

## Non-goals

Do not build: LSP or gopls integration, SCIP, a daemon, SQLite, annotations or notes of
any kind, persistence beyond two JSON files, multi-language support, auth, a build
pipeline, or a test suite beyond one smoke test per side. Do not add a UI framework.

If a decision would take more than ten minutes, pick the boring option and note it in
`DECISIONS.md` with one line on what you rejected.

---

## Part 1: `cmd/callscape-dump`

Go, module `callscape`. Loads a Go module and writes a graph to stdout.

Use `golang.org/x/tools/go/packages` with `NeedName | NeedFiles | NeedSyntax | NeedTypes
| NeedTypesInfo | NeedDeps`, pattern `./...`, `Dir` set to the target.

**Nodes** are top-level funcs and methods declared in the target module. Skip anything
from a dependency.

```json
{
  "id": "github.com/radiusmethod/gitlab-kiosk/internal/gitlab.Client.Get",
  "name": "Client.Get",
  "pkg": "github.com/radiusmethod/gitlab-kiosk/internal/gitlab",
  "file": "internal/gitlab/client.go",
  "line": 142,
  "lines": 31,
  "exported": true,
  "fanIn": 12,
  "fanOut": 4
}
```

**Edges** are static calls. Walk each file's AST for `*ast.CallExpr`, resolve the callee
through `types.Info.Uses` to a `*types.Func`, and emit an edge if that func is a node.

```json
{ "from": "...cmd.runList", "to": "...internal/gitlab.Client.Get" }
```

Known limit, state it in the README rather than solving it: calls through an interface
resolve to the interface method, not the implementation. glk's transport chain is
interface-based, so some edges will be missing or point at the wrong place. That is
acceptable for v0 and is itself a finding.

Output is `{"module": "...", "nodes": [...], "edges": [...]}`. Compute `fanIn` and
`fanOut` from the edge list before writing.

**Smoke test:** on glk, node count is in the hundreds not the tens, `Client.Get` exists,
and its `fanIn` is greater than zero.

**Also add `--stats`**, printing node count, edge count, package count, and the top 20
symbols by fan-in as plain text. This is how a human checks your work without opening the
JSON.

---

## Part 2: `web/`

Vite, TypeScript, three.js. No React, no bundler config beyond the default.

Fetches two files at startup and re-fetches when they change: `graph.json` and
`view.json`.

### The view spec

`view.json` is the whole configuration of what's on screen. Closed struct, unknown fields
are an error rather than ignored.

```json
{
  "occupants": {
    "packages": ["*/internal/gitlab", "*/cmd/*"],
    "minFanIn": 1,
    "limit": 60
  },
  "encoding": {
    "size": "fanIn",
    "color": "pkg",
    "height": "lines"
  },
  "camera": { "focus": "...internal/gitlab.Client.Get", "distance": 120 }
}
```

`packages` takes glob patterns. `size`, `color`, and `height` each name a node field.
`limit` keeps the top N after filtering, ranked by whatever `size` names.

Editing `view.json` and saving must update the browser without a manual reload and
without resetting the camera. That loop is the point of the whole exercise, so get it
working before you make anything look good.

### Layout

**Districts, not a force-directed cloud.** A ball of 500 nodes with springs is the
failure mode this project exists to avoid.

- Each package is a district: a flat disc on the ground plane.
- District positions are deterministic from the package path, arranged in a ring, with
  radius proportional to member count. Same input must always produce the same layout.
- Symbols sit inside their district in a stable grid, sorted by name.
- `height` field lifts a symbol off the ground. `size` scales it. `color` tints it.
- Edges are lines. Draw intra-district edges dim and cross-district edges bright, because
  the interesting ones cross.
- Package name floats above each district as a sprite label. Symbol labels appear only
  within a proximity threshold.

Determinism matters more than beauty here. A layout that shuffles on reload can't be
compared to itself and can't be screenshot-tested later.

### Camera

Fly controls: WASD plus mouse look, shift to move faster. Pointer lock on click, escape
to release. Add a key to snap back to the `camera.focus` node.

If flying turns out to feel bad, orbit controls are the fallback and it should be a
one-line swap, so keep the controls behind a single interface.

---

## Definition of done

Run the dump against glk, start the dev server, and:

1. glk's packages are visible as distinct districts, labelled.
2. You can fly between them and read symbol names up close.
3. Editing `occupants.packages` in `view.json` changes what's on screen within a second,
   without touching the browser.
4. `callscape-dump --stats` prints a top-20 list.
5. `README.md` says how to run both halves in five lines or fewer.
6. `DECISIONS.md` lists every ten-minute-rule call you made.

## What to report back

The top 20 by fan-in, pasted as text, and one screenshot of the default view. Those two
things are what the experiment is actually testing.
