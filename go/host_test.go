// Host behaviour against the fake relay: input, edges, events, commands,
// reconnects and code conflicts.

package stickdrift

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRelayFramesReachThePadAtTick(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{Title: "TEST", Look: Look{Layout: "dpad-ab"}})
	p := join(t, r, h, 2)
	if j := h.Joined(); len(j) != 1 || j[0] != p {
		t.Fatalf("Joined = %v", j)
	}

	r.sendBinary(encodeFrame(2, 1, State{Buttons: A.Mask(), LX: 0.5}))
	waitFor(t, "frame", func() bool { return p.Frames() == 1 })
	if p.Held(A) {
		t.Fatal("state must not change until Tick")
	}
	h.Tick()
	if !p.Held(A) || !p.JustPressed(A) {
		t.Fatal("A should be held and just pressed after Tick")
	}
	if x, _ := p.Stick(); x < 0.49 || x > 0.51 {
		t.Fatalf("stick x = %v", x)
	}
	h.Tick()
	if p.JustPressed(A) || !p.Held(A) {
		t.Fatal("a press is 'just' for one tick only; the hold stays")
	}

	// A stale duplicate must not undo a newer state.
	r.sendBinary(encodeFrame(2, 3, State{}))
	waitFor(t, "release frame", func() bool { return p.Frames() == 2 })
	r.sendBinary(encodeFrame(2, 2, State{Buttons: A.Mask()}))
	time.Sleep(50 * time.Millisecond)
	h.Tick()
	if p.Held(A) || !p.JustReleased(A) {
		t.Fatal("an older frame was applied over a newer one")
	}
}

func TestQuickTapIsLatched(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{})
	p := join(t, r, h, 0)
	r.sendBinary(encodeFrame(0, 1, State{Buttons: B.Mask()}))
	r.sendBinary(encodeFrame(0, 2, State{}))
	waitFor(t, "frames", func() bool { return p.Frames() == 2 })
	h.Tick()
	if !p.JustPressed(B) || !p.JustReleased(B) || p.Held(B) {
		t.Fatal("a tap shorter than a tick must register as a press and a release")
	}
}

func TestLeaveReleasesAndReports(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{})
	p := join(t, r, h, 1)
	r.sendBinary(encodeFrame(1, 1, State{Buttons: Start.Mask()}))
	waitFor(t, "frame", func() bool { return p.Frames() == 1 })
	h.Tick()
	r.sendJSON(map[string]any{"t": "leave", "pad": 1})
	waitFor(t, "leave", func() bool { return !p.Connected() })
	if l := h.Left(); len(l) != 1 || l[0] != p {
		t.Fatalf("Left = %v", l)
	}
	if len(h.Pads()) != 0 {
		t.Fatal("Pads should list only connected pads")
	}
	h.Tick()
	if p.Held(Start) || !p.JustReleased(Start) {
		t.Fatal("a leaving pad's buttons must read as released")
	}
	// The same phone comes back to the same seat and the same *Pad.
	if again := join(t, r, h, 1); again != p {
		t.Fatal("a returning phone should keep its *Pad")
	}
	if j := h.Joined(); len(j) != 2 {
		t.Fatalf("Joined should report the first join and the return, got %d", len(j))
	}
}

func TestRTTFromPhone(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{})
	p := join(t, r, h, 0)
	r.sendJSON(map[string]any{"t": "rtt", "pad": 0, "ms": 31.4, "via": "relay"})
	waitFor(t, "rtt", func() bool { return p.RTT() == 31 })
	if p.Via() != "relay" {
		t.Fatalf("via = %q", p.Via())
	}
}

func TestCommandsGoOutAsProtocolMessages(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{})

	h.SetPad(3, Look{Label: "RED", Labels: map[Button]string{A: "BOMB"}, Swap: Bool(false), Clear: []string{"message"}})
	m := r.expect("pad")
	if m["pad"] != float64(3) || m["label"] != "RED" || m["swap"] != false || m["message"] != "" {
		t.Fatalf("pad message = %v", m)
	}
	if labels, _ := m["labels"].(map[string]any); labels["A"] != "BOMB" {
		t.Fatalf("labels = %v", m["labels"])
	}

	h.SetLook(Look{Layout: "paddle"})
	if look, _ := r.expect("config")["look"].(map[string]any); look["layout"] != "paddle" {
		t.Fatalf("config look = %v", look)
	}
	h.SetOpen(false)
	if m := r.expect("config"); m["open"] != false {
		t.Fatalf("config open = %v", m)
	}
	h.Haptic(1, 40)
	if m := r.expect("haptic"); m["ms"] != float64(40) || m["pad"] != float64(1) {
		t.Fatalf("haptic = %v", m)
	}
	h.Haptic(1, 30, 50, 30)
	if ms, _ := r.expect("haptic")["ms"].([]any); len(ms) != 3 {
		t.Fatalf("haptic pattern = %v", ms)
	}
	h.Kick(2)
	if m := r.expect("kick"); m["pad"] != float64(2) {
		t.Fatalf("kick = %v", m)
	}
}

// TestReconnectReconciles drops the relay socket: the host reconnects with
// the same code and key, re-sends its config (with the latest look and
// open state), keeps pads the relay still lists, and reports the rest as
// gone.
func TestReconnectReconciles(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{Code: "ABCDE", Key: "0123456789abcdef0123"})
	a := join(t, r, h, 0)
	b := join(t, r, h, 1)
	h.Joined()
	r.sendBinary(encodeFrame(0, 7, State{Buttons: A.Mask()}))
	waitFor(t, "frame", func() bool { return a.Frames() == 1 })
	h.Tick()
	h.SetLook(Look{Layout: "quiz"})
	r.expect("config")

	r.mu.Lock()
	r.pads = []map[string]any{{"pad": 0, "device": "device-a"}}
	r.mu.Unlock()
	r.drop(websocket.StatusGoingAway)
	r.waitConn()
	cfg := r.expect("config")
	if look, _ := cfg["look"].(map[string]any); look["layout"] != "quiz" {
		t.Fatalf("reconnect config should carry the latest look, got %v", cfg)
	}
	waitFor(t, "b reconciled away", func() bool { return !b.Connected() })
	if !a.Connected() {
		t.Fatal("pad 0 is still listed, so still here")
	}
	if l := h.Left(); len(l) != 1 || l[0] != b {
		t.Fatalf("Left = %v", l)
	}
	if j := h.Joined(); len(j) != 0 {
		t.Fatalf("a pad that never left is not a new join, got %v", j)
	}
	h.Tick()
	if a.Held(A) {
		t.Fatal("input from a relay-only pad must be released when the relay drops")
	}
	r.mu.Lock()
	codes := r.codes
	r.mu.Unlock()
	if codes[0] != "ABCDE" || codes[len(codes)-1] != "ABCDE" {
		t.Fatalf("reconnect must keep the code, dialled %v", codes)
	}
	// After the reconnect the phone's numbering may have restarted.
	r.sendBinary(encodeFrame(0, 1, State{Buttons: X.Mask()}))
	waitFor(t, "frame after reconnect", func() bool { return a.Frames() == 2 })
}

func TestTakenCodePicksAnother(t *testing.T) {
	r := newFakeRelay(t)
	r.takenFor["ZZZZZ"] = true
	h := NewHost(Options{Origin: r.srv.URL, Code: "ZZZZZ"})
	h.Start(context.Background())
	t.Cleanup(h.Close)
	select {
	case <-h.Ready():
	case <-time.After(10 * time.Second):
		t.Fatal("never came online")
	}
	if info := h.Info(); info.Code == "ZZZZZ" || !IsCode(info.Code) || info.JoinURL == "" || info.Status != StatusOnline {
		t.Fatalf("info = %+v", info)
	}
}

func TestReplacedHostStops(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{})
	r.drop(closeReplaced)
	waitFor(t, "replaced", func() bool { return h.Info().Err == ErrReplaced })
	time.Sleep(600 * time.Millisecond)
	r.mu.Lock()
	dials := r.dials
	r.mu.Unlock()
	if dials != 1 {
		t.Fatalf("a replaced host must not fight for the room, dialled %d times", dials)
	}
}

func TestHostRTT(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{})
	waitFor(t, "host rtt", func() bool { return h.Info().RTT > 0 })
}

// TestLiveRelay opens a room on a real relay end to end. Opt-in:
// STICKDRIFT_LIVE=1 (uses $STICKDRIFT_URL, default the public relay).
func TestLiveRelay(t *testing.T) {
	if os.Getenv("STICKDRIFT_LIVE") == "" {
		t.Skip("set STICKDRIFT_LIVE=1 to test against a real relay")
	}
	h := NewHost(Options{Title: "go test"})
	h.Start(context.Background())
	defer h.Close()
	select {
	case <-h.Ready():
	case <-time.After(15 * time.Second):
		t.Fatalf("room never came online: %+v", h.Info())
	}
	t.Logf("room %s at %s", h.Info().Code, h.Info().JoinURL)
}
