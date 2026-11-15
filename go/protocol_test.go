// Unit tests for the wire format and looks.

package stickdrift

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestSeqNewerWraps(t *testing.T) {
	cases := []struct {
		a, b uint16
		want bool
	}{{2, 1, true}, {1, 2, false}, {1, 1, false}, {3, 65530, true}, {65530, 3, false}, {0x8000, 0, false}, {0x7fff, 0, true}}
	for _, c := range cases {
		if got := seqNewer(c.a, c.b); got != c.want {
			t.Errorf("seqNewer(%d,%d) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestFrameRoundTrip(t *testing.T) {
	in := State{Buttons: A.Mask() | Up.Mask(), LX: 1, LY: -1, RX: 0.5, RY: -0.25, PX: -300, PY: 32767}
	f, ok := decodeFrame(encodeFrame(4, 65535, in))
	if !ok || f.pad != 4 || f.seq != 65535 || f.state.Buttons != in.Buttons || f.state.PX != -300 || f.state.PY != 32767 {
		t.Fatalf("decoded %+v", f)
	}
	if f.state.LX != 1 || f.state.LY != -1 || f.state.RX < 0.49 || f.state.RX > 0.51 {
		t.Fatalf("axes %+v", f.state)
	}
}

func TestDecodeFrameRejects(t *testing.T) {
	good := encodeFrame(0, 1, State{})
	cases := map[string][]byte{"short": good[:15], "long": append(good, 0), "ping kind": append([]byte{framePing}, good[1:]...)}
	for name, b := range cases {
		if _, ok := decodeFrame(b); ok {
			t.Errorf("%s: decoded", name)
		}
	}
	// -128 is outside what phones send; it must still clamp to -1.
	b := encodeFrame(0, 1, State{})
	b[8] = 0x80
	if f, _ := decodeFrame(b); f.state.LX != -1 {
		t.Errorf("lx = %v", f.state.LX)
	}
}

func TestButtonNames(t *testing.T) {
	for i, b := range Buttons {
		if int(b) != i {
			t.Fatalf("Buttons out of order at %d", i)
		}
		var back Button
		text, err := b.MarshalText()
		if err != nil || back.UnmarshalText(text) != nil || back != b {
			t.Fatalf("round trip %v: %s %v", b, text, err)
		}
	}
	if Select.String() != "Select" || Select.Mask() != 1<<11 || Button(99).String() != "Button(99)" {
		t.Fatal("names or masks wrong")
	}
	var b Button
	if b.UnmarshalText([]byte("Z")) == nil {
		t.Fatal("unknown name accepted")
	}
}

func TestCodes(t *testing.T) {
	for range 100 {
		if c := RandomCode(); !IsCode(c) {
			t.Fatalf("bad code %q", c)
		}
	}
	for _, bad := range []string{"", "ABCD", "ABCDEF", "ABCDI", "abcde"} {
		if IsCode(bad) {
			t.Errorf("IsCode(%q)", bad)
		}
	}
	if len(RandomKey()) != 32 {
		t.Fatal("key length")
	}
}

func TestLookJSON(t *testing.T) {
	look := Look{
		Layout: "custom",
		Labels: map[Button]string{A: "JUMP", Start: "PAUSE"},
		Custom: &CustomLayout{Controls: []Control{{Type: "button", X: 0.5, Y: 0.5, Button: Btn(B), Label: "GO"}}},
		Theme:  &Theme{Style: "retro"},
		Clear:  []string{"banner", "label"},
	}
	b, err := json.Marshal(look)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["banner"] != "" || got["label"] != "" || got["layout"] != "custom" {
		t.Fatalf("look = %s", b)
	}
	if _, ok := got["message"]; ok {
		t.Fatalf("unset fields must be omitted: %s", b)
	}
	if labels := got["labels"].(map[string]any); labels["A"] != "JUMP" || labels["Start"] != "PAUSE" {
		t.Fatalf("labels = %v", labels)
	}
	if !strings.Contains(string(b), `"button":"B"`) {
		t.Fatalf("control button should be a name: %s", b)
	}
	if _, err := json.Marshal(Look{Clear: []string{"layout"}}); err == nil {
		t.Fatal("clearing a non-text field should fail")
	}
}

func TestAvatarPNG(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 100)...)
	url, err := AvatarPNG(png)
	if err != nil || !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Fatalf("url %q err %v", url, err)
	}
	if _, err := AvatarPNG([]byte("GIF89a")); err == nil {
		t.Fatal("non-PNG accepted")
	}
	if _, err := AvatarPNG(append(png, bytes.Repeat([]byte{1}, MaxAvatarBytes)...)); err == nil {
		t.Fatal("oversized avatar accepted")
	}
}
