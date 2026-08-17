GOLANGCI_LINT_VERSION := v2.11.4
NPM := npm --prefix web

.PHONY: check build install test vet lint lint-install \
	web-install web-check web-test dev logs shot cue look dump sample hooks clean sounds music

# Everything lefthook runs, in one place.
check: vet test lint web-check web-test

build:
	go build -o callscape-dump ./cmd/callscape-dump

install:
	go install ./cmd/callscape-dump

test:
	go test ./...

vet:
	go vet ./...

lint: lint-install
	golangci-lint run ./...

lint-install:
	@if ! golangci-lint version 2>/dev/null | grep -q '$(subst v,,$(GOLANGCI_LINT_VERSION))'; then \
		echo "Installing golangci-lint $(GOLANGCI_LINT_VERSION)..."; \
		go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION); \
	fi

web-install:
	$(NPM) ci

web-check:
	$(NPM) run check

web-test:
	$(NPM) test

dev:
	$(NPM) run dev

# What the browser saw. The dev server appends events from the page here.
logs:
	@tail -f web/dev-log.jsonl | jq -c '"\(.t[11:19]) \(.event) \(.data // "")"'

# make dump TARGET=/path/to/a/go/module
#
# The graph says which module it is, never where that module sits on this
# machine — an absolute home directory path has no business in a file that gets
# committed and screenshotted. The dev server needs it to serve source, so it
# goes in a local untracked pin instead.
dump:
	@test -n "$(TARGET)" || { echo "usage: make dump TARGET=/path/to/a/go/module"; exit 1; }
	go run ./cmd/callscape-dump $(TARGET) > web/public/graph.json
	@echo "$(abspath $(TARGET))" > web/.source-root

# The graph a fresh clone flies before it has dumped anything: this repo,
# dumped by itself. graph.json is untracked — it is a module-sized blob and
# every re-dump would otherwise commit another one — so something has to be
# there on clone. Generated rather than hand-kept, so it cannot drift from what
# the dumper emits, and deterministic, so an unchanged dumper rebakes to an
# empty diff.
sample:
	go run ./cmd/callscape-dump . > web/public/graph.default.json

# The navigator's voice. The WAVs are committed, so a clone runs with sound and
# without beepboop; this is how to rebake them after a wording or level change.
# The recipe is the source of truth — never hand-edit a WAV. Output is
# deterministic, so an unchanged recipe rebakes to an empty diff.
BEEPBOOP ?= ../beepboop
BEEPBOOP_VOICE_MODEL ?= $(HOME)/.local/share/piper/voices/en_US-lessac-medium.onnx
sounds:
	cd $(BEEPBOOP) && BEEPBOOP_VOICE_MODEL=$(BEEPBOOP_VOICE_MODEL) \
		go run ./cmd/beepboop bake recipes/navigator.json $(CURDIR)/web/public/sounds

# The music is written, not baked, so it comes from beatshop rather than from a
# recipe — and `sounds` must not touch it. It used to bake a lab of four
# candidates and copy two out; the pair of eight-second loops that produced is
# what `apollo-v1` replaced, and leaving that in would have overwritten a
# written track with a generated one on the next rebake.
#
# FLAC, not the WAV next to it: same samples at a fifth the size, and sample
# exact, so the loop comes round without the seam an MP3's padding would add.
BEATSHOP ?= ../beatshop
MUSIC ?= apollo-v1
music:
	cp $(BEATSHOP)/out/archive/$(MUSIC).flac web/public/sounds/

hooks:
	lefthook install

clean:
	rm -f callscape-dump

# Ask the open page to screenshot itself. Writes web/shots/latest.png.
shot:
	@curl -sS -X POST http://localhost:5178/__shot/request > /dev/null
	@sleep 3
	@ls -l web/shots/latest.png

# Put the open page into the state described by web/cue.json — focus, select,
# distance, yaw, pitch. Edit the file, then run this; the command line never
# changes, which keeps it out of the permission prompts an inline JSON argument
# would generate every time it differed.
#
# The file is scratch — where you happened to be looking, rewritten a dozen
# times a session — so it is not tracked, and a clone that has never cued has
# to be given one rather than being met with a curl error about a missing path.
web/cue.json:
	@printf '{\n  "select": [],\n  "distance": 110,\n  "yaw": 40,\n  "pitch": 35\n}\n' > $@
	@echo "wrote a starting $@"

cue: web/cue.json
	@curl -sS -X POST -H 'content-type: application/json' --data-binary @web/cue.json \
		http://localhost:5178/__cue > /dev/null
	@echo "cued $$(tr -d '\n ' < web/cue.json)"

# Cue that state and screenshot it.
look:
	@$(MAKE) --no-print-directory cue
	@$(MAKE) --no-print-directory shot
