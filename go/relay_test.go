// Test helpers: a fake relay standing in for the Controller Durable Object,
// and a pion "phone" that negotiates a data channel through it the way the
// browser controller does.

package controller

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

// fakeRelay accepts host connections, welcomes them with a configurable pad
// list, and lets the test act as the phones.
type fakeRelay struct {
	t        *testing.T
	srv      *httptest.Server
	fromHost chan map[string]any

	mu       sync.Mutex
	host     *websocket.Conn
	pads     []map[string]any // listed in the next welcome
	takenFor map[string]bool  // codes that answer 409
	dials    int
	codes    []string
	conns    chan struct{} // one value per accepted host connection
}

func newFakeRelay(t *testing.T) *fakeRelay {
	t.Helper()
	r := &fakeRelay{t: t, fromHost: make(chan map[string]any, 256), takenFor: map[string]bool{}, conns: make(chan struct{}, 16)}
	r.srv = httptest.NewServer(http.HandlerFunc(r.serve))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *fakeRelay) serve(w http.ResponseWriter, req *http.Request) {
	if !strings.HasPrefix(req.URL.Path, "/ws/host/") {
		http.NotFound(w, req)
		return
	}
	code := strings.TrimPrefix(req.URL.Path, "/ws/host/")
	r.mu.Lock()
	r.dials++
	r.codes = append(r.codes, code)
	taken := r.takenFor[code]
	r.mu.Unlock()
	if taken {
		http.Error(w, "taken", http.StatusConflict)
		return
	}
	c, err := websocket.Accept(w, req, nil)
	if err != nil {
		return
	}
	c.SetReadLimit(1 << 20)
	r.mu.Lock()
	r.host = c
	pads := r.pads
	if pads == nil {
		pads = []map[string]any{}
	}
	r.mu.Unlock()
	r.sendJSON(map[string]any{"t": "welcome", "code": code, "joinUrl": "http://x/j/" + code, "version": 1, "pads": pads})
	r.conns <- struct{}{}
	for {
		typ, data, err := c.Read(context.Background())
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		if string(data) == pingMessage {
			_ = c.Write(context.Background(), websocket.MessageText, []byte(pongMessage))
			continue
		}
		var m map[string]any
		if json.Unmarshal(data, &m) == nil {
			r.fromHost <- m
		}
	}
}

// waitConn waits for the next host connection to be welcomed.
func (r *fakeRelay) waitConn() {
	r.t.Helper()
	select {
	case <-r.conns:
	case <-time.After(10 * time.Second):
		r.t.Fatal("host never connected")
	}
}

func (r *fakeRelay) sendJSON(v any) {
	b, _ := json.Marshal(v)
	r.mu.Lock()
	defer r.mu.Unlock()
	_ = r.host.Write(context.Background(), websocket.MessageText, b)
}

func (r *fakeRelay) sendBinary(b []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	_ = r.host.Write(context.Background(), websocket.MessageBinary, b)
}

// drop closes the host's socket with a close code, as the relay would.
func (r *fakeRelay) drop(code websocket.StatusCode) {
	r.mu.Lock()
	defer r.mu.Unlock()
	_ = r.host.Close(code, "test")
}

// expect waits for a host message of type typ, skipping others.
func (r *fakeRelay) expect(typ string) map[string]any {
	r.t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case m := <-r.fromHost:
			if m["t"] == typ {
				return m
			}
		case <-deadline:
			r.t.Fatalf("no %q message from host", typ)
		}
	}
}

// startHost starts a Host against the fake relay and waits for its config.
func startHost(t *testing.T, r *fakeRelay, opts Options) *Host {
	t.Helper()
	opts.Origin = r.srv.URL
	h := NewHost(opts)
	h.Start(context.Background())
	t.Cleanup(h.Close)
	r.waitConn()
	if cfg := r.expect("config"); cfg["p2p"] != !opts.DisableP2P {
		t.Fatalf("config p2p = %v", cfg["p2p"])
	}
	return h
}

// join seats a phone and waits for the host to see it.
func join(t *testing.T, r *fakeRelay, h *Host, n int) *Pad {
	t.Helper()
	r.sendJSON(map[string]any{"t": "join", "pad": n, "device": "device-" + string(rune('a'+n))})
	waitFor(t, "join", func() bool { p := h.Pad(n); return p != nil && p.Connected() })
	return h.Pad(n)
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(10 * time.Second); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

// ---- A pion phone ----

// phone is a pion peer playing the browser controller's part of P2P.
type phone struct {
	t      *testing.T
	pc     *webrtc.PeerConnection
	dc     *webrtc.DataChannel
	opened chan struct{}
	echoes chan []byte
}

// dialPhone offers a data channel from pad n through the relay. The relay
// read loop must be routed to phone.onHostSignal (see pump).
func dialPhone(t *testing.T, r *fakeRelay, n int) *phone {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	ordered, retransmits := false, uint16(0)
	dc, err := pc.CreateDataChannel("input", &webrtc.DataChannelInit{Ordered: &ordered, MaxRetransmits: &retransmits})
	if err != nil {
		t.Fatal(err)
	}
	ph := &phone{t: t, pc: pc, dc: dc, opened: make(chan struct{}), echoes: make(chan []byte, 8)}
	dc.OnOpen(func() { close(ph.opened) })
	dc.OnMessage(func(msg webrtc.DataChannelMessage) { ph.echoes <- msg.Data })
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			init := c.ToJSON()
			r.sendJSON(map[string]any{"t": "signal", "pad": n, "data": map[string]any{"type": "candidate", "candidate": init}})
		}
	})
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	r.sendJSON(map[string]any{"t": "signal", "pad": n, "data": map[string]any{"type": "offer", "sdp": offer.SDP}})
	return ph
}

// pump feeds the host's signals to whichever phone is current, until the
// test ends. Other host messages are forwarded to rest (if not nil).
func pump(t *testing.T, r *fakeRelay, current func() *phone, rest chan<- map[string]any) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case m := <-r.fromHost:
				if m["t"] != "signal" {
					if rest != nil {
						rest <- m
					}
					continue
				}
				data, _ := json.Marshal(m["data"])
				var s signal
				_ = json.Unmarshal(data, &s)
				ph := current()
				switch s.Type {
				case "answer":
					_ = ph.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: s.SDP})
				case "candidate":
					if s.Candidate != nil {
						_ = ph.pc.AddICECandidate(*s.Candidate)
					}
				}
			}
		}
	}()
}

// waitOpen waits for the phone's data channel to open.
func (ph *phone) waitOpen() {
	ph.t.Helper()
	select {
	case <-ph.opened:
	case <-time.After(15 * time.Second):
		ph.t.Fatal("data channel never opened")
	}
}
