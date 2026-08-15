// Command lspvue-dump loads a Go module and writes its call graph as JSON.
//
// Nodes are top-level funcs and methods declared in the target module.
// Edges are statically resolved calls between those nodes.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/types"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

type Node struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Pkg      string `json:"pkg"`
	File     string `json:"file"`
	Line     int    `json:"line"`
	Lines    int    `json:"lines"`
	Exported bool   `json:"exported"`
	FanIn    int    `json:"fanIn"`
	FanOut   int    `json:"fanOut"`
}

type Edge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type Graph struct {
	Module string `json:"module"`
	Nodes  []Node `json:"nodes"`
	Edges  []Edge `json:"edges"`
}

func main() {
	stats := flag.Bool("stats", false, "print a plain-text summary to stdout instead of JSON")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: lspvue-dump [--stats] <module-dir>\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	dir := "."
	if flag.NArg() > 0 {
		dir = flag.Arg(0)
	}

	g, err := dump(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "lspvue-dump: %v\n", err)
		os.Exit(1)
	}

	if *stats {
		printStats(g)
		return
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(g); err != nil {
		fmt.Fprintf(os.Stderr, "lspvue-dump: %v\n", err)
		os.Exit(1)
	}
}

func dump(dir string) (*Graph, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}

	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax |
			packages.NeedTypes | packages.NeedTypesInfo | packages.NeedDeps |
			packages.NeedModule,
		Dir:   abs,
		Tests: false,
	}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		return nil, err
	}
	if len(pkgs) == 0 {
		return nil, fmt.Errorf("no packages found in %s", abs)
	}

	// Report load errors but keep going: a partially typed module still yields
	// a useful graph.
	nerr := 0
	packages.Visit(pkgs, nil, func(p *packages.Package) {
		for _, e := range p.Errors {
			if nerr < 10 {
				fmt.Fprintf(os.Stderr, "lspvue-dump: %v\n", e)
			}
			nerr++
		}
	})
	if nerr > 10 {
		fmt.Fprintf(os.Stderr, "lspvue-dump: ... and %d more load errors\n", nerr-10)
	}

	modPath, modDir := moduleOf(pkgs, abs)

	nodes := map[string]*Node{}
	var edges []Edge

	for _, pkg := range pkgs {
		if !inModule(pkg.PkgPath, modPath) {
			continue
		}
		for _, f := range pkg.Syntax {
			for _, decl := range f.Decls {
				fd, ok := decl.(*ast.FuncDecl)
				if !ok || fd.Name == nil {
					continue
				}
				obj, _ := pkg.TypesInfo.Defs[fd.Name].(*types.Func)
				if obj == nil {
					continue
				}
				id := funcID(obj)
				if id == "" {
					continue
				}
				pos := pkg.Fset.Position(fd.Pos())
				end := pkg.Fset.Position(fd.End())
				rel := pos.Filename
				if r, err := filepath.Rel(modDir, pos.Filename); err == nil {
					rel = filepath.ToSlash(r)
				}
				nodes[id] = &Node{
					ID:       id,
					Name:     shortName(id, pkg.PkgPath),
					Pkg:      pkg.PkgPath,
					File:     rel,
					Line:     pos.Line,
					Lines:    end.Line - pos.Line + 1,
					Exported: obj.Exported(),
				}
			}
		}
	}

	// Second pass: calls. Nodes must all exist first so an edge can be tested
	// against the full node set.
	for _, pkg := range pkgs {
		if !inModule(pkg.PkgPath, modPath) {
			continue
		}
		for _, f := range pkg.Syntax {
			for _, decl := range f.Decls {
				fd, ok := decl.(*ast.FuncDecl)
				if !ok || fd.Name == nil || fd.Body == nil {
					continue
				}
				obj, _ := pkg.TypesInfo.Defs[fd.Name].(*types.Func)
				if obj == nil {
					continue
				}
				from := funcID(obj)
				if _, ok := nodes[from]; !ok {
					continue
				}
				ast.Inspect(fd.Body, func(n ast.Node) bool {
					call, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					to := calleeID(pkg.TypesInfo, call.Fun)
					if to == "" || to == from {
						return true
					}
					if _, ok := nodes[to]; ok {
						edges = append(edges, Edge{From: from, To: to})
					}
					return true
				})
			}
		}
	}

	edges = dedupe(edges)
	for _, e := range edges {
		nodes[e.From].FanOut++
		nodes[e.To].FanIn++
	}

	out := make([]Node, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, *n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })

	return &Graph{Module: modPath, Nodes: out, Edges: edges}, nil
}

// moduleOf returns the module path and root directory for the loaded packages.
func moduleOf(pkgs []*packages.Package, fallbackDir string) (string, string) {
	for _, p := range pkgs {
		if p.Module != nil && p.Module.Path != "" {
			dir := p.Module.Dir
			if dir == "" {
				dir = fallbackDir
			}
			return p.Module.Path, dir
		}
	}
	// No module info (GOPATH mode or a broken load): fall back to the longest
	// common prefix of package paths.
	if len(pkgs) > 0 {
		return pkgs[0].PkgPath, fallbackDir
	}
	return "", fallbackDir
}

func inModule(pkgPath, modPath string) bool {
	if modPath == "" {
		return true
	}
	return pkgPath == modPath || strings.HasPrefix(pkgPath, modPath+"/")
}

// funcID builds the stable identifier for a func or method:
//
//	pkg/path.Func          pkg/path.Recv.Method
func funcID(obj *types.Func) string {
	if obj.Pkg() == nil {
		return ""
	}
	name := obj.Name()
	if sig, ok := obj.Type().(*types.Signature); ok && sig.Recv() != nil {
		recv := recvName(sig.Recv().Type())
		if recv == "" {
			// Interface method declared inline, or an unnamed receiver type.
			return ""
		}
		name = recv + "." + name
	}
	return obj.Pkg().Path() + "." + name
}

func recvName(t types.Type) string {
	if p, ok := t.(*types.Pointer); ok {
		t = p.Elem()
	}
	switch t := t.(type) {
	case *types.Named:
		return t.Obj().Name()
	case *types.Alias:
		return t.Obj().Name()
	}
	return ""
}

// calleeID resolves a call expression's function to a node id, or "" when the
// call is dynamic (a func value, a builtin, a conversion).
func calleeID(info *types.Info, fun ast.Expr) string {
	for {
		switch e := fun.(type) {
		case *ast.ParenExpr:
			fun = e.X
			continue
		case *ast.IndexExpr: // generic instantiation: F[int](...)
			fun = e.X
			continue
		case *ast.IndexListExpr:
			fun = e.X
			continue
		}
		break
	}

	var id *ast.Ident
	switch e := fun.(type) {
	case *ast.Ident:
		id = e
	case *ast.SelectorExpr:
		id = e.Sel
	default:
		return ""
	}

	obj, _ := info.Uses[id].(*types.Func)
	if obj == nil {
		return ""
	}
	return funcID(obj)
}

func dedupe(edges []Edge) []Edge {
	seen := map[Edge]bool{}
	out := edges[:0]
	for _, e := range edges {
		if seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].From != out[j].From {
			return out[i].From < out[j].From
		}
		return out[i].To < out[j].To
	})
	return out
}

// shortName strips the package path from an id: "…/internal/gitlab.Client.Get"
// becomes "Client.Get".
func shortName(id, pkgPath string) string {
	return strings.TrimPrefix(id, pkgPath+".")
}

func printStats(g *Graph) {
	pkgs := map[string]bool{}
	for _, n := range g.Nodes {
		pkgs[n.Pkg] = true
	}
	fmt.Printf("module:   %s\n", g.Module)
	fmt.Printf("nodes:    %d\n", len(g.Nodes))
	fmt.Printf("edges:    %d\n", len(g.Edges))
	fmt.Printf("packages: %d\n", len(pkgs))
	fmt.Println()

	top := make([]Node, len(g.Nodes))
	copy(top, g.Nodes)
	sort.SliceStable(top, func(i, j int) bool {
		if top[i].FanIn != top[j].FanIn {
			return top[i].FanIn > top[j].FanIn
		}
		return top[i].ID < top[j].ID
	})
	if len(top) > 20 {
		top = top[:20]
	}
	fmt.Println("top 20 by fan-in:")
	fmt.Printf("%6s %6s  %-44s %s\n", "fanIn", "fanOut", "symbol", "location")
	for _, n := range top {
		fmt.Printf("%6d %6d  %-44s %s:%d\n", n.FanIn, n.FanOut, trunc(n.Pkg[strings.LastIndex(n.Pkg, "/")+1:]+"."+n.Name, 44), n.File, n.Line)
	}
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
