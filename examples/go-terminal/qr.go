// QR codes drawn with Unicode half blocks: each character cell shows two
// QR modules stacked vertically, so the code stays roughly square in a
// terminal whose cells are twice as tall as they are wide.

package main

import (
	"strings"

	"rsc.io/qr"
)

// quietZone is the white border, in modules, that scanners need around a code.
const quietZone = 2

// renderQR returns text as a QR code in half-block characters. Dark modules
// are drawn as the terminal's background (spaces) on a light frame, so it
// scans on dark terminals, which are the common case.
func renderQR(text string) (string, error) {
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return "", err
	}
	dark := func(x, y int) bool {
		x, y = x-quietZone, y-quietZone
		return x >= 0 && y >= 0 && x < code.Size && y < code.Size && code.Black(x, y)
	}
	size := code.Size + 2*quietZone
	var b strings.Builder
	for y := 0; y < size; y += 2 {
		for x := range size {
			top, bottom := !dark(x, y), y+1 < size && !dark(x, y+1)
			switch {
			case top && bottom:
				b.WriteRune('█')
			case top:
				b.WriteRune('▀')
			case bottom:
				b.WriteRune('▄')
			default:
				b.WriteRune(' ')
			}
		}
		b.WriteByte('\n')
	}
	return b.String(), nil
}
