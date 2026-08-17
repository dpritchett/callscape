# callscape

A Go module's call graph, dumped by `callscape-dump` and flown through in a three.js page.
Personal project, MIT licensed, `dpritchett/callscape` on GitHub.

## Required reading

Start with `WORKING.md`: how to run it, the instruments for seeing what the page is
doing, the working agreements, and a list of gotchas that have already cost time once.

Then `ARCHITECTURE.md` before implementing a feature or making a design call — ground
rules, the system seam, known limits. `DECISIONS.md` is the running log of
ten-minute-rule calls with what was rejected; add to it rather than re-litigating a
choice already made there.

## Checks

`make check` runs everything lefthook runs: `go vet`, `go test`, `golangci-lint`,
`tsc --noEmit`, `vitest`. Run `make hooks` once per clone to install the pre-commit hooks.

Individual targets: `make vet test lint web-check web-test`. A new check goes in the
Makefile first; lefthook only ever calls `make`. There is no CI, on purpose — see
`ARCHITECTURE.md`.

Node is pinned in `.mise.toml`. If `npm` is missing from the shell, fix the repo
activation rather than decorating every command with a prefix.

## Running it

```sh
make dump TARGET=/path/to/a/go/module   # writes web/public/graph.json
make dev-remote                         # vite dev server, instruments on
```

`make dev-remote`, not `make dev`: `/__cue`, `/__shot` and `/__src` are not registered
without `UNSAFE_ENABLE_REMOTE_CONTROL=true`, and those are how you see the page at all
from here. A plain `make dev` is the safe default a stranger gets.

Then edit `web/public/view.json` while the page is open. That loop — edit the view spec,
see the scene change within a second without a reload and without the camera moving — is
the point of the project. Anything that breaks it is a regression regardless of what else
it improves.

You can see the page without a browser: `make cue` puts it where you want it and
`make shot` photographs it. A cue locks the local controls for a few seconds on its own,
so you are never steering against whoever is flying — **send `"hold": false` when you are
done** to hand the wheel straight back.

**To ask the dev server anything else, use `scripts/page`, not `curl`.** It takes a path
and has four verbs — `get`, `head`, `post`, and post-with-a-body-file — so it can only
reach `:5178`, which is why it can be pre-approved and `curl` cannot. `WORKING.md` has the
rest of the instruments.

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
- **Stage the paths you changed. Never `git add -A`, `git add .`, or `commit -a`.** Someone
  else is working in this tree with an editor open, and a blanket add has swept an
  in-progress file and a vim swapfile into the index at least once. Read
  `git status --short`, stage what you actually edited, and leave anything else alone.

## Not in scope

`HANDOFF.md` lists the non-goals and they still hold. No LSP or gopls integration, no
daemon, no database, no persistence beyond the two JSON files, no multi-language support,
no UI framework. The interface-resolution limit is a finding to report, not a bug to route
around.

## Caveats worth knowing

- No automated browser has ever loaded the page. Rendering, controls and the reload loop
  are verified by a human looking at them. Do not claim otherwise.
- `callscape-dump` runs the Go toolchain against whatever module you point it at.
