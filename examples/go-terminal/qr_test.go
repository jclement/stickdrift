// Checks the half-block QR renderer keeps the code square and framed.

package main

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestRenderQR(t *testing.T) {
	out, err := renderQR("https://stickdrift.net/j/ABCDE")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	width := utf8.RuneCountInString(lines[0])
	// Two modules per line, so about half as many lines as columns.
	if want := (width + 1) / 2; len(lines) != want {
		t.Fatalf("%d lines for width %d, want %d", len(lines), width, want)
	}
	for i, l := range lines {
		if utf8.RuneCountInString(l) != width {
			t.Fatalf("line %d is ragged", i)
		}
	}
	// The quiet zone is light, so the first line is solid blocks.
	if strings.Trim(lines[0], "█") != "" {
		t.Fatalf("top border not light: %q", lines[0])
	}
}
