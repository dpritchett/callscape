# lspvue

A Go module's call graph, as districts you fly through.

```sh
go run ./cmd/lspvue-dump ~/Projects/gitlab-kiosk > web/public/graph.json
go run ./cmd/lspvue-dump --stats ~/Projects/gitlab-kiosk   # same data, as text
cd web && npm install && npm run dev                       # open the printed URL
```

Edit `web/public/view.json` while the page is open: what's on screen changes within a
second, without a reload and without moving the camera.

**Controls:** click to capture the mouse, WASD to fly, Q/E down and up, shift to boost,
F to snap back to `camera.focus`, escape to release.

**Known limit:** calls through an interface resolve to the interface method, not the
implementation. gitlab-kiosk's transport chain is interface-based, so some edges are
missing or point at the interface. That is expected in v0.

**Tests:** `go test ./...`, and `cd web && npm test` — which covers `place(graph, view)`,
the pure function that does selection, layout and encoding.
