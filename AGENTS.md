# lspvue

A Go module's call graph, dumped by `lspvue-dump` and flown through in a three.js page.
Personal project, MIT licensed, `dpritchett/lspvue` on GitHub.

## Required reading

Read `ARCHITECTURE.md` before implementing a feature or making a design call. It holds
the ground rules, the system seam, and the known limits. `DECISIONS.md` is the running log
of ten-minute-rule calls with what was rejected — add to it rather than re-litigating a
choice already made there.

## Checks

`make check` runs everything lefthook and CI run: `go vet`, `go test`, `golangci-lint`,
`tsc --noEmit`, `vitest`. Run `make hooks` once per clone to install the pre-commit hooks.

Individual targets: `make vet test lint web-check web-test`. Never add a check to CI
without adding it to the Makefile first — lefthook and Actions both call `make`, and that
is deliberate.

Node is pinned in `.mise.toml`. If `npm` is missing from the shell, fix the repo
activation rather than decorating every command with a prefix.

## Running it

```sh
make dump TARGET=/path/to/a/go/module   # writes web/public/graph.json
make dev                                # vite dev server
```

Then edit `web/public/view.json` while the page is open. That loop — edit the view spec,
see the scene change within a second without a reload and without the camera moving — is
the point of the project. Anything that breaks it is a regression regardless of what else
it improves.

## Where to put code

The interesting logic goes in `web/src/placement.ts` and its neighbours: pure functions
over plain data, no three.js and no DOM. `world.ts` only draws. If you find yourself
computing a position or a colour inside `world.ts`, it belongs on the other side of the
seam where it can be tested.

Determinism is a hard requirement. The same graph and view must place byte-identically in
any input order — there is a test for it.

## Commits

- No `Co-Authored-By` trailers, and no generated-with footers. Subject and body only.
- Small changes, committed and pushed promptly.
- If a change touches both halves, say what it does to the seam between them.

## Not in scope

`HANDOFF.md` lists the non-goals and they still hold. No LSP or gopls integration, no
daemon, no database, no persistence beyond the two JSON files, no multi-language support,
no UI framework. The interface-resolution limit is a finding to report, not a bug to route
around.

## Caveats worth knowing

- No automated browser has ever loaded the page. Rendering, controls and the reload loop
  are verified by a human looking at them. Do not claim otherwise.
- `lspvue-dump` runs the Go toolchain against whatever module you point it at.
