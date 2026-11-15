// The wire format, in Go: button bits, the 16-byte input frame, sequence
// comparison and room codes. This mirrors src/shared/protocol.ts; PROTOCOL.md
// in the repository root is the language-neutral spec both follow.

package controller

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
)

// ProtocolVersion is the relay protocol this package speaks.
const ProtocolVersion = 1

// DefaultOrigin is the public relay.
const DefaultOrigin = "https://controller.onewheelgeek.net"

// stunServer is the only ICE server: there is no TURN because the relay
// WebSocket already is the fallback when phones can't reach us directly.
const stunServer = "stun:stun.cloudflare.com:3478"

// Button is one bit of a pad's button mask.
type Button int

// The buttons, in bit order. Analog sticks that drive movement also set the
// d-pad bits, so a game reading only Up/Down/Left/Right works with every
// layout.
const (
	Up Button = iota
	Down
	Left
	Right
	A
	B
	X
	Y
	L
	R
	Start
	Select
)

// buttonNames are the protocol's names, in bit order. They are used in JSON
// (button labels, custom layouts) and in String.
var buttonNames = [...]string{"Up", "Down", "Left", "Right", "A", "B", "X", "Y", "L", "R", "Start", "Select"}

// Buttons lists every button in bit order.
var Buttons = []Button{Up, Down, Left, Right, A, B, X, Y, L, R, Start, Select}

// String returns the protocol name of the button ("A", "Start").
func (b Button) String() string {
	if b < 0 || int(b) >= len(buttonNames) {
		return fmt.Sprintf("Button(%d)", int(b))
	}
	return buttonNames[b]
}

// Mask is the button's bit in a button mask.
func (b Button) Mask() uint32 { return 1 << uint(b) }

// MarshalText writes the protocol name, so a map[Button]string becomes the
// {"A":"BOMB"} object the relay expects.
func (b Button) MarshalText() ([]byte, error) {
	if b < 0 || int(b) >= len(buttonNames) {
		return nil, fmt.Errorf("unknown button %d", int(b))
	}
	return []byte(buttonNames[b]), nil
}

// UnmarshalText parses a protocol name ("A", "Start").
func (b *Button) UnmarshalText(text []byte) error {
	for i, name := range buttonNames {
		if name == string(text) {
			*b = Button(i)
			return nil
		}
	}
	return fmt.Errorf("unknown button %q", text)
}

// ---- Frames ----

// Binary frame kinds (byte 0).
const (
	frameInput = 1 // a 16-byte input snapshot
	framePing  = 2 // an 8-byte ping over the data channel: echo it back
)

// frameSize is the length of an input frame in bytes.
const frameSize = 16

// pingSize is the length of a data-channel ping.
const pingSize = 8

// State is a complete controller snapshot: every frame from a phone carries
// all of it, so a hold is simply a bit that stays set.
type State struct {
	Buttons uint32  // bitmask, see Button
	LX, LY  float64 // left stick, -1..1, y down
	RX, RY  float64 // right stick, -1..1, y down
	PX, PY  int16   // touchpad pointer, accumulated, wraps at 16 bits
}

// frame is a decoded input frame.
type frame struct {
	pad   int // relay-stamped pad number (0 over the data channel)
	seq   uint16
	state State
}

// decodeFrame parses a 16-byte input frame. Layout (little endian):
// u8 kind, u8 pad, u16 seq, u32 buttons, i8 lx ly rx ry, i16 px py.
func decodeFrame(b []byte) (frame, bool) {
	if len(b) != frameSize || b[0] != frameInput {
		return frame{}, false
	}
	// -128 is legal on the wire but outside the -127..127 range phones send;
	// clamp so axes stay within -1..1.
	axis := func(v byte) float64 { return max(-1, float64(int8(v))/127) }
	return frame{
		pad: int(b[1]),
		seq: binary.LittleEndian.Uint16(b[2:4]),
		state: State{
			Buttons: binary.LittleEndian.Uint32(b[4:8]),
			LX:      axis(b[8]),
			LY:      axis(b[9]),
			RX:      axis(b[10]),
			RY:      axis(b[11]),
			PX:      int16(binary.LittleEndian.Uint16(b[12:14])),
			PY:      int16(binary.LittleEndian.Uint16(b[14:16])),
		},
	}, true
}

// encodeFrame writes a snapshot as an input frame. The library never sends
// input itself; tests and tools use this to play a phone.
func encodeFrame(pad int, seq uint16, s State) []byte {
	b := make([]byte, frameSize)
	b[0], b[1] = frameInput, byte(pad)
	binary.LittleEndian.PutUint16(b[2:], seq)
	binary.LittleEndian.PutUint32(b[4:], s.Buttons)
	axis := func(v float64) byte { return byte(int8(max(-127, min(127, v*127)))) }
	b[8], b[9], b[10], b[11] = axis(s.LX), axis(s.LY), axis(s.RX), axis(s.RY)
	binary.LittleEndian.PutUint16(b[12:], uint16(s.PX))
	binary.LittleEndian.PutUint16(b[14:], uint16(s.PY))
	return b
}

// seqNewer reports whether 16-bit sequence a is after b, across the wrap.
// Frames arrive twice (P2P repeats, path switches) or late (UDP); only a
// newer snapshot may replace the current one.
func seqNewer(a, b uint16) bool {
	d := a - b
	return d != 0 && d < 0x8000
}

// ---- Room codes ----

// codeAlphabet has no I or O so codes read cleanly off a TV.
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ"

// codeLength is the number of letters in a room code.
const codeLength = 5

// IsCode reports whether s is a well-formed room code.
func IsCode(s string) bool {
	if len(s) != codeLength {
		return false
	}
	for _, ch := range s {
		if !strings.ContainsRune(codeAlphabet, ch) {
			return false
		}
	}
	return true
}

// RandomCode returns a fresh room code.
func RandomCode() string {
	b := make([]byte, codeLength)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b)
}

// RandomKey returns a 32-character host secret.
func RandomKey() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
