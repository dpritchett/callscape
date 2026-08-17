package main

import (
	"encoding/json"
	"go/scanner"
	"go/token"
	"io"
	"os"
)

// Token classes. Small integers because they repeat once per token in every
// source response, and the browser only needs enough to pick a colour.
//
// Zero is left for "not a token": the scanner never reports whitespace, so
// anything a span does not cover is a gap the renderer draws plain.
const (
	classPunct = iota + 1
	classKeyword
	classIdent
	classString
	classNumber
	classComment
)

// Span is [byte offset, byte length, class]. An array rather than an object
// because a big file runs to tens of thousands of these and the field names
// would be most of the payload.
type Span [3]int

type lexOutput struct {
	Spans []Span `json:"spans"`
}

// lexSpans runs the real Go scanner over src. Highlighting by regular
// expression guesses; this is the lexer the compiler uses, and it is already a
// dependency of this command.
func lexSpans(filename string, src []byte) []Span {
	fset := token.NewFileSet()
	file := fset.AddFile(filename, fset.Base(), len(src))

	var s scanner.Scanner
	// ScanComments, or comments vanish silently — they are the one thing you
	// most want coloured and the scanner drops them by default.
	s.Init(file, src, nil, scanner.ScanComments)

	spans := []Span{}
	for {
		pos, tok, lit := s.Scan()
		if tok == token.EOF {
			break
		}
		// The scanner inserts semicolons the source does not contain, at the
		// end of a line, carrying the newline as their literal. Colouring one
		// would paint a semicolon over a line break.
		if tok == token.SEMICOLON && lit == "\n" {
			continue
		}

		off := fset.Position(pos).Offset
		n := len(lit)
		if n == 0 {
			// Operators and punctuation report no literal; their text is the
			// token itself.
			n = len(tok.String())
		}
		if off < 0 || off >= len(src) {
			continue
		}
		if off+n > len(src) {
			// ILLEGAL tokens in a malformed file can name a length the file
			// does not have. A half-coloured file beats no file.
			n = len(src) - off
		}
		spans = append(spans, Span{off, n, classOf(tok)})
	}
	return spans
}

func classOf(tok token.Token) int {
	switch {
	case tok.IsKeyword():
		return classKeyword
	case tok == token.COMMENT:
		return classComment
	case tok == token.STRING, tok == token.CHAR:
		return classString
	case tok == token.INT, tok == token.FLOAT, tok == token.IMAG:
		return classNumber
	case tok == token.IDENT:
		return classIdent
	default:
		return classPunct
	}
}

func lexMain(path string, out io.Writer) error {
	src, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(lexOutput{Spans: lexSpans(path, src)})
}
