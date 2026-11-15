// Peer-to-peer tests with a real pion handshake through the fake relay.

package controller

import (
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestPeerToPeer offers a data channel and checks input arrives over it,
// pings are echoed and the pad reports P2P.
func TestPeerToPeer(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{})
	p := join(t, r, h, 0)
	ph := dialPhone(t, r, 0)
	pump(t, r, func() *phone { return ph }, nil)
	ph.waitOpen()
	waitFor(t, "host to mark P2P", p.P2P)

	if err := ph.dc.Send(encodeFrame(0, 1, State{Buttons: A.Mask()})); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "A over P2P", func() bool { return p.Frames() == 1 })
	h.Tick()
	if !p.Held(A) {
		t.Fatal("A should be held")
	}
	ping := []byte{framePing, 0, 0, 0, 1, 2, 3, 4}
	_ = ph.dc.Send(ping)
	select {
	case got := <-ph.echoes:
		if string(got) != string(ping) {
			t.Fatalf("echo = %v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ping not echoed")
	}
}

// TestReofferReplacesPeer plays a phone whose channel died (a Wi-Fi blip):
// it closes its connection and offers again. The new channel must work and
// the old one's late close must not mark the pad down.
func TestReofferReplacesPeer(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{})
	p := join(t, r, h, 0)
	var mu sync.Mutex
	ph := dialPhone(t, r, 0)
	pump(t, r, func() *phone { mu.Lock(); defer mu.Unlock(); return ph }, nil)
	ph.waitOpen()
	waitFor(t, "first P2P", p.P2P)

	_ = ph.pc.Close()
	mu.Lock()
	ph = dialPhone(t, r, 0)
	second := ph
	mu.Unlock()
	second.waitOpen()
	waitFor(t, "second P2P", p.P2P)
	time.Sleep(300 * time.Millisecond) // let any stale close callbacks land
	if !p.P2P() {
		t.Fatal("a stale close from the replaced connection cleared P2P")
	}
	_ = second.dc.Send(encodeFrame(0, 1, State{Buttons: Y.Mask()}))
	waitFor(t, "input on the new channel", func() bool { return p.Frames() == 1 })
}

// TestP2PSurvivesRelayReconnect drops the relay while a channel is open:
// input keeps arriving and stays held, and the pad is not reported gone.
func TestP2PSurvivesRelayReconnect(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{Code: "PQRST", Key: "0123456789abcdef0123"})
	p := join(t, r, h, 0)
	rest := make(chan map[string]any, 64)
	ph := dialPhone(t, r, 0)
	pump(t, r, func() *phone { return ph }, rest)
	ph.waitOpen()
	waitFor(t, "P2P", p.P2P)
	_ = ph.dc.Send(encodeFrame(0, 1, State{Buttons: A.Mask()}))
	waitFor(t, "frame", func() bool { return p.Frames() == 1 })

	r.mu.Lock()
	r.pads = []map[string]any{{"pad": 0, "device": "device-a"}}
	r.mu.Unlock()
	r.drop(websocket.StatusGoingAway)
	_ = ph.dc.Send(encodeFrame(0, 2, State{Buttons: A.Mask() | B.Mask()}))
	r.waitConn()
	waitFor(t, "frame during reconnect", func() bool { return p.Frames() >= 2 })
	h.Tick()
	if !p.Held(A) || !p.Held(B) || !p.Connected() || !p.P2P() {
		t.Fatalf("P2P pad should ride out a relay reconnect: held A=%v B=%v connected=%v p2p=%v", p.Held(A), p.Held(B), p.Connected(), p.P2P())
	}
	if l := h.Left(); len(l) != 0 {
		t.Fatalf("no pad left, got %v", l)
	}
}

// TestLeaveClosesPeer checks a leaving phone's connection is dropped.
func TestLeaveClosesPeer(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{})
	p := join(t, r, h, 0)
	ph := dialPhone(t, r, 0)
	pump(t, r, func() *phone { return ph }, nil)
	ph.waitOpen()
	waitFor(t, "P2P", p.P2P)
	r.sendJSON(map[string]any{"t": "leave", "pad": 0})
	waitFor(t, "peer gone", func() bool { return h.peers.current(0) == nil && !p.P2P() })
}

// TestDisableP2PIgnoresOffers checks a relay-only host never answers.
func TestDisableP2PIgnoresOffers(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{DisableP2P: true})
	join(t, r, h, 0)
	dialPhone(t, r, 0)
	select {
	case m := <-r.fromHost:
		if m["t"] == "signal" {
			t.Fatalf("relay-only host answered: %v", m)
		}
	case <-time.After(500 * time.Millisecond):
	}
}
