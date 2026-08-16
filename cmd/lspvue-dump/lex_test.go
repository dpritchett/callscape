package main

import "testing"

// text returns what a span actually covers, which is the only thing that
// matters: an offset that is one byte out is a colour on the wrong character.
func text(src string, s Span) string { return src[s[0] : s[0]+s[1]] }

func TestLexSpansCoversEveryTokenAndNothingElse(t *testing.T) {
	src := "package p\n\n// hi\nfunc f() int { return 42 }\n"
	spans := lexSpans("p.go", []byte(src))

	want := []struct {
		text  string
		class int
	}{
		{"package", classKeyword},
		{"p", classIdent},
		{"// hi", classComment},
		{"func", classKeyword},
		{"f", classIdent},
		{"(", classPunct},
		{")", classPunct},
		{"int", classIdent},
		{"{", classPunct},
		{"return", classKeyword},
		{"42", classNumber},
		{"}", classPunct},
	}
	if len(spans) != len(want) {
		t.Fatalf("got %d spans, want %d: %v", len(spans), len(want), spans)
	}
	for i, w := range want {
		if got := text(src, spans[i]); got != w.text {
			t.Errorf("span %d covers %q, want %q", i, got, w.text)
		}
		if spans[i][2] != w.class {
			t.Errorf("span %d (%q) is class %d, want %d", i, w.text, spans[i][2], w.class)
		}
	}
}

func TestLexSpansSkipsTheSemicolonsTheScannerInvents(t *testing.T) {
	// Nothing here ends in a semicolon, but the scanner reports one at the end
	// of each line. Colouring those paints over the line breaks.
	src := "package p\n\nvar x = 1\nvar y = 2\n"
	for _, s := range lexSpans("p.go", []byte(src)) {
		if text(src, s) == "\n" {
			t.Fatalf("a span covers a newline: %v", s)
		}
	}
}

func TestLexSpansAreOrderedAndDoNotOverlap(t *testing.T) {
	src := "package p\n\nfunc f() { /* a\nb */ _ = `raw\nstring` }\n"
	spans := lexSpans("p.go", []byte(src))
	for i, s := range spans {
		if s[1] <= 0 {
			t.Fatalf("span %d is empty: %v", i, s)
		}
		if i > 0 && s[0] < spans[i-1][0]+spans[i-1][1] {
			t.Fatalf("span %d overlaps its predecessor: %v after %v", i, s, spans[i-1])
		}
	}
}

func TestLexSpansCountBytesNotCharacters(t *testing.T) {
	// The offsets are byte offsets, and a multi-byte rune before a token moves
	// it further along the file than it moves along the string.
	src := "package p\n\n// héllo ☃\nvar x = 1\n"
	spans := lexSpans("p.go", []byte(src))
	for _, s := range spans {
		if got := text(src, s); got == "var" {
			return // sliced by bytes, it still lands on the keyword
		}
	}
	t.Fatal("no span covers `var`; offsets are not byte offsets")
}

func TestLexSpansSurviveABrokenFile(t *testing.T) {
	// Half a colourised file beats an error page while you are mid-edit.
	src := "package p\n\nfunc f( {\n"
	if len(lexSpans("p.go", []byte(src))) == 0 {
		t.Fatal("no spans at all for a file that does not parse")
	}
}
