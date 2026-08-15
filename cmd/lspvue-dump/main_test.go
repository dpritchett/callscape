package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Smoke test against gitlab-kiosk, the repo v0 is aimed at. Set LSPVUE_TARGET
// to point it somewhere else; skipped when the target is not on this machine.
func TestDumpGitlabKiosk(t *testing.T) {
	target := os.Getenv("LSPVUE_TARGET")
	if target == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skip("no home dir")
		}
		target = filepath.Join(home, "Projects", "gitlab-kiosk")
	}
	if _, err := os.Stat(filepath.Join(target, "go.mod")); err != nil {
		t.Skipf("target module not found at %s", target)
	}

	g, err := dump(target)
	if err != nil {
		t.Fatalf("dump: %v", err)
	}

	if len(g.Nodes) < 100 {
		t.Errorf("node count = %d, want hundreds not tens", len(g.Nodes))
	}
	if len(g.Edges) == 0 {
		t.Error("no edges")
	}

	const want = "github.com/radiusmethod/gitlab-kiosk/internal/gitlab.Client.Get"
	var got *Node
	for i := range g.Nodes {
		if g.Nodes[i].ID == want {
			got = &g.Nodes[i]
			break
		}
	}
	if got == nil {
		t.Fatalf("%s missing from the graph", want)
	}
	if got.FanIn <= 0 {
		t.Errorf("%s fanIn = %d, want > 0", want, got.FanIn)
	}
	if got.Name != "Client.Get" || got.Lines <= 0 {
		t.Errorf("unexpected node: %+v", *got)
	}
}
