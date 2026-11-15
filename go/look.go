// Looks: what a host can set on a phone (layout, colours, labels, theme,
// custom controls, avatar, banner). The relay validates everything again, so
// these types are for convenience and documentation, not security.

package controller

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
)

// Look is any subset of a phone's presentation. Zero fields are left out, and
// the relay merges a pad's look over what it had, so SetPad(n, Look{Label:
// "RED"}) changes only the label. To blank a text field, name it in Clear.
type Look struct {
	Layout    string            `json:"layout,omitempty"`    // see Layouts
	Label     string            `json:"label,omitempty"`     // shown big, e.g. "PLAYER 1"
	Color     string            `json:"color,omitempty"`     // hex, tints the controller
	Labels    map[Button]string `json:"labels,omitempty"`    // relabel buttons: {A: "BOMB"}
	Message   string            `json:"message,omitempty"`   // a line of status text
	Swap      *bool             `json:"swap,omitempty"`      // player may flip d-pad <-> stick
	Diagonals *bool             `json:"diagonals,omitempty"` // false = 4-way d-pad
	Theme     *Theme            `json:"theme,omitempty"`
	Custom    *CustomLayout     `json:"custom,omitempty"` // controls for Layout "custom"
	Avatar    string            `json:"avatar,omitempty"` // PNG data URL ≤ 24 KB; see AvatarPNG
	Banner    string            `json:"banner,omitempty"` // big faded text behind the controls

	// Clear lists text fields to send as "" (blanking them on the phone):
	// any of "label", "message", "banner". Omitempty can't express that.
	Clear []string `json:"-"`
}

// clearable are the text fields Clear may name.
var clearable = map[string]bool{"label": true, "message": true, "banner": true}

// MarshalJSON writes the look, adding an empty string for every Clear field.
func (l Look) MarshalJSON() ([]byte, error) {
	type plain Look // drops this method, so Marshal doesn't recurse
	b, err := json.Marshal(plain(l))
	if err != nil || len(l.Clear) == 0 {
		return b, err
	}
	var fields map[string]any
	if err := json.Unmarshal(b, &fields); err != nil {
		return nil, err
	}
	for _, name := range l.Clear {
		if !clearable[name] {
			return nil, fmt.Errorf("look: cannot clear %q (only label, message, banner)", name)
		}
		fields[name] = ""
	}
	return json.Marshal(fields)
}

// Bool returns a pointer to v, for Look.Swap and Look.Diagonals.
func Bool(v bool) *bool { return &v }

// Layouts are the built-in layout ids, plus "custom".
var Layouts = []string{"dpad-ab", "stick-ab", "arcade", "gamepad", "twin-stick", "buzzer", "quiz", "paddle", "tilt", "touchpad", "custom"}

// Theme is a styling preset. Only presets and hex colours: a host can
// restyle players' phones but never inject CSS or markup.
type Theme struct {
	Style      string `json:"style,omitempty"`      // glass, neon, flat, retro, candy
	Font       string `json:"font,omitempty"`       // display, sans, mono, pixel
	Shape      string `json:"shape,omitempty"`      // round, rounded, square
	Background string `json:"background,omitempty"` // hex
	Text       string `json:"text,omitempty"`       // hex
}

// CustomLayout places up to 32 controls anywhere on the screen.
type CustomLayout struct {
	Orientation string    `json:"orientation,omitempty"` // landscape, portrait, any
	Controls    []Control `json:"controls"`
}

// Control is one widget in a custom layout. X and Y are the centre as
// fractions of the screen; Size is a fraction of the short edge; W and H are
// fractions of width and height for rectangular controls.
type Control struct {
	Type      string  `json:"type"` // button, pill, shoulder, tile, buzzer, dpad, stick, slider, touchpad
	X         float64 `json:"x"`
	Y         float64 `json:"y"`
	Size      float64 `json:"size,omitempty"`
	W         float64 `json:"w,omitempty"`
	H         float64 `json:"h,omitempty"`
	Button    *Button `json:"button,omitempty"` // which bit it sets; see Btn
	Label     string  `json:"label,omitempty"`
	Color     string  `json:"color,omitempty"`
	Solid     bool    `json:"solid,omitempty"`
	Side      string  `json:"side,omitempty"`     // left/right: which stick axes
	Floating  *bool   `json:"floating,omitempty"` // stick recentres under the thumb (default true)
	DPad      *bool   `json:"dpad,omitempty"`     // stick also sets d-pad bits
	Diagonals *bool   `json:"diagonals,omitempty"`
}

// Btn returns a pointer to b, for Control.Button.
func Btn(b Button) *Button { return &b }

// MaxAvatarBytes is the largest avatar data URL the relay accepts.
const MaxAvatarBytes = 24 * 1024

// pngMagic starts every PNG file.
var pngMagic = []byte("\x89PNG\r\n\x1a\n")

// AvatarPNG turns PNG bytes into the data URL Look.Avatar wants, or explains
// why the relay would drop it. A 64x64 sprite is a few KB.
func AvatarPNG(png []byte) (string, error) {
	if !bytes.HasPrefix(png, pngMagic) {
		return "", fmt.Errorf("avatar: not a PNG")
	}
	url := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	if len(url) > MaxAvatarBytes {
		return "", fmt.Errorf("avatar: %d bytes encoded, the relay accepts at most %d (try a smaller image)", len(url), MaxAvatarBytes)
	}
	return url, nil
}
