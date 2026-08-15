GOLANGCI_LINT_VERSION := v2.11.4
NPM := npm --prefix web

.PHONY: check build install test vet lint lint-install \
	web-install web-check web-test dev dump hooks clean

# Everything lefthook runs, in one place.
check: vet test lint web-check web-test

build:
	go build -o lspvue-dump ./cmd/lspvue-dump

install:
	go install ./cmd/lspvue-dump

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

# make dump TARGET=/path/to/a/go/module
dump:
	@test -n "$(TARGET)" || { echo "usage: make dump TARGET=/path/to/a/go/module"; exit 1; }
	go run ./cmd/lspvue-dump $(TARGET) > web/public/graph.json

hooks:
	lefthook install

clean:
	rm -f lspvue-dump
