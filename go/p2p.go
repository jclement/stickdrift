// Peer-to-peer input: each phone offers a WebRTC data channel through the
// relay and we answer with pion. Once the channel is open the phone sends
// input straight to us (on a LAN about 1 ms instead of ~55 ms through
// Cloudflare). The relay stays connected as the fallback, so nothing here is
// needed for phones to work; it only makes them faster.
//
// Robustness rules, learned the hard way:
//   - Offers are answered synchronously on the relay read loop, so a
//     candidate that follows an offer is always added after the remote
//     description is set (pion rejects candidates before that).
//   - A phone re-offers whenever its channel dies (Wi-Fi blip, network
//     change). The new offer replaces the old connection, and callbacks from
//     the old one are ignored, so a late "closed" can't mark the new channel
//     down.
//   - Peer connections survive a relay reconnect: input keeps flowing P2P
//     while the WebSocket comes back.

package controller

import (
	"encoding/json"
	"sync"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

// signal is a WebRTC signalling payload (see PROTOCOL.md).
type signal struct {
	Type      string                   `json:"type"`
	SDP       string                   `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
}

// peers holds the current peer connection for each pad.
type peers struct {
	api *webrtc.API
	ice []webrtc.ICEServer

	mu    sync.Mutex
	byPad map[int]*peer
}

// peer is one phone's connection and whether it can carry input.
type peer struct {
	pc *webrtc.PeerConnection

	mu        sync.Mutex
	dcOpen    bool
	connected bool
}

// usable reports whether input can arrive over this peer.
func (pr *peer) usable() bool {
	pr.mu.Lock()
	defer pr.mu.Unlock()
	return pr.dcOpen && pr.connected
}

// newPeers builds the WebRTC API. Browsers hide LAN addresses behind mDNS
// ".local" names, so we must resolve those (QueryOnly: we don't advertise our
// own) or LAN connections never form.
func newPeers(urls []string) *peers {
	var se webrtc.SettingEngine
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryOnly)
	return &peers{
		api:   webrtc.NewAPI(webrtc.WithSettingEngine(se)),
		ice:   []webrtc.ICEServer{{URLs: urls}},
		byPad: map[int]*peer{},
	}
}

// current returns pad n's live peer, or nil.
func (ps *peers) current(n int) *peer {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	return ps.byPad[n]
}

// replace installs pr as pad n's peer and closes the one it replaces.
func (ps *peers) replace(n int, pr *peer) {
	ps.mu.Lock()
	old := ps.byPad[n]
	ps.byPad[n] = pr
	ps.mu.Unlock()
	if old != nil {
		go func() { _ = old.pc.Close() }()
	}
}

// close drops pad n's peer (the phone left).
func (ps *peers) close(n int) {
	ps.mu.Lock()
	old := ps.byPad[n]
	delete(ps.byPad, n)
	ps.mu.Unlock()
	if old != nil {
		_ = old.pc.Close()
	}
}

// forget removes pr if it is still pad n's peer (it failed on its own).
func (ps *peers) forget(n int, pr *peer) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.byPad[n] == pr {
		delete(ps.byPad, n)
	}
}

// closeAll tears down every peer connection (room closed).
func (ps *peers) closeAll() {
	ps.mu.Lock()
	all := ps.byPad
	ps.byPad = map[int]*peer{}
	ps.mu.Unlock()
	for _, pr := range all {
		_ = pr.pc.Close()
	}
}

// onSignal handles an offer or a candidate from pad n.
func (h *Host) onSignal(n int, raw json.RawMessage) {
	if !h.p2p {
		return
	}
	var s signal
	if err := json.Unmarshal(raw, &s); err != nil {
		return
	}
	switch s.Type {
	case "offer":
		if err := h.answer(n, s.SDP); err != nil {
			h.log.Info("controller: answering offer", "pad", n, "err", err)
		}
	case "candidate":
		// nil is end-of-candidates, which pion doesn't need.
		if s.Candidate == nil {
			return
		}
		if pr := h.peers.current(n); pr != nil {
			if err := pr.pc.AddICECandidate(*s.Candidate); err != nil {
				h.log.Debug("controller: candidate", "pad", n, "err", err)
			}
		}
	}
}

// answer accepts a phone's offer, replacing any earlier connection, and
// wires the data channel to the pad.
func (h *Host) answer(n int, sdp string) error {
	pc, err := h.peers.api.NewPeerConnection(webrtc.Configuration{ICEServers: h.peers.ice})
	if err != nil {
		return err
	}
	pr := &peer{pc: pc}
	h.peers.replace(n, pr)

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		h.send(map[string]any{"t": "signal", "pad": n, "data": signal{Type: "candidate", Candidate: &init}})
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) { h.wireChannel(n, pr, dc) })
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		h.log.Debug("controller: p2p state", "pad", n, "state", s)
		pr.mu.Lock()
		pr.connected = s == webrtc.PeerConnectionStateConnected
		pr.mu.Unlock()
		h.refreshP2P(n, pr)
		if s == webrtc.PeerConnectionStateFailed {
			// The phone notices too and re-offers; free this one now.
			h.peers.forget(n, pr)
			go func() { _ = pc.Close() }()
		}
	})

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		return err
	}
	ans, err := pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := pc.SetLocalDescription(ans); err != nil {
		return err
	}
	h.send(map[string]any{"t": "signal", "pad": n, "data": signal{Type: "answer", SDP: ans.SDP}})
	return nil
}

// wireChannel routes a phone's data channel: pings are echoed so the phone
// can time the round trip, everything else is an input frame.
func (h *Host) wireChannel(n int, pr *peer, dc *webrtc.DataChannel) {
	setOpen := func(open bool) {
		pr.mu.Lock()
		pr.dcOpen = open
		pr.mu.Unlock()
		h.refreshP2P(n, pr)
	}
	dc.OnOpen(func() { setOpen(true) })
	dc.OnClose(func() { setOpen(false) })
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if len(msg.Data) == pingSize && msg.Data[0] == framePing {
			_ = dc.Send(msg.Data)
			return
		}
		if f, ok := decodeFrame(msg.Data); ok {
			h.applyFrame(n, f) // byte 1 is 0 on this path; the channel says who
		}
	})
}

// refreshP2P updates pad n's P2P flag, unless pr has been replaced.
func (h *Host) refreshP2P(n int, pr *peer) {
	if h.peers.current(n) != pr {
		return
	}
	if p := h.Pad(n); p != nil {
		p.setP2P(pr.usable())
	}
}
