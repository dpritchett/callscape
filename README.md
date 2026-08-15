# lspvue

A Go module's call graph, as districts you fly through.

```sh
go run ./cmd/lspvue-dump /path/to/a/go/module > web/public/graph.json
go run ./cmd/lspvue-dump --stats /path/to/a/go/module   # same data, as text
cd web && npm install && npm run dev                    # open the printed URL
```

Then edit `web/public/view.json` while the page is open: what's on screen changes within
a second, without a reload and without moving the camera. That loop is the point of the
project.

**Controls:** click to capture the mouse, WASD to fly, Q/E down and up, shift to boost,
F to snap back to `camera.focus`, escape to release.

## What it does

`cmd/lspvue-dump` loads a module with `go/packages` and emits one node per top-level func
or method declared in that module, plus an edge for every statically resolved call
between them. `web/` lays each package out as a disc on the ground plane — deterministic
positions, so two runs are comparable — and encodes `size`, `color` and `height` from
whichever node fields `view.json` names.

Requires Go 1.24+ and Node 20+.

## Known limits

**Calls through an interface resolve to the interface method, not the implementation.**
This is the big one. On [gitlab-kiosk](https://github.com/radiusmethod/gitlab-kiosk) —
244 nodes, 16 packages, the module this was built against — only **4 of 67** drawn edges
cross a package boundary, because its transport chain is interface-based and most of the
inter-package structure resolves into interfaces and disappears. The districts render as
nearly disconnected islands. That number is a measurement, not a bug to route around, but
it does mean the cross-package view is much sparser than the code really is.

**Nothing here is verified in a browser.** The test suite covers `place(graph, view)` —
the pure function doing selection, layout and encoding — and the label sizing math. No
automated browser has ever loaded the page, so rendering, controls and the reload loop
are verified by looking at them and nothing else.

**Point it only at code you trust.** `go/packages` shells out to the Go toolchain, so
dumping a module runs `go list` against it — which can fetch dependencies, honour a
`toolchain` directive, and preprocess cgo. That is the same exposure as running any Go
build on that code, and the same reason not to do it to a repo you just cloned from a
stranger.

**The dev server is a dev server.** It binds localhost. Don't `--host` it onto a network
you share.

## Tests

```sh
go test ./...
cd web && npm test
```

`HANDOFF.md` is the brief this was built from, and `DECISIONS.md` lists every call made
under its ten-minute rule, with what was rejected. Both are worth more than this README
if you want to know why it looks like this.

MIT licensed.
