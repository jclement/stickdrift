// Pad is one phone. Each pad keeps two copies of its state: the live one the
// network goroutines write as frames arrive, and the view the game reads,
// published by Host.Tick. Reads within one game frame are therefore
// consistent, and edges (JustPressed) line up with game ticks the way
// Ebitengine's inpututil does.

package stickdrift

import "sync"

// Pad is one seat in the room. Its number is stable for that phone across
// reconnects (the relay remembers the device).
type Pad struct {
	number int

	mu     sync.Mutex
	device string

	// Network side, written as frames and relay messages arrive.
	live      State
	pressed   uint32 // rising edges since the last Tick
	released  uint32 // falling edges since the last Tick
	seq       uint16 // last applied frame sequence
	fresh     bool   // the next frame resets sequencing ((re)joined)
	connected bool
	p2p       bool        // a direct WebRTC channel to this phone is open
	rtt       int         // the phone's reported round trip, ms
	via       string      // the path the phone reports using: "p2p" or "relay"
	frames    uint64      // input frames applied
	events    eventWindow // screen events seen, for de-duplication

	// Game side, published by Tick.
	view         State
	justPressed  uint32
	justReleased uint32
}

// newPad makes a pad for seat n.
func newPad(n int, device string) *Pad { return &Pad{number: n, device: device} }

// Number is the seat, 0-based. Show players Number()+1.
func (p *Pad) Number() int { return p.number }

// Device is the phone's stable device id.
func (p *Pad) Device() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.device
}

// Held reports whether b was down at the last Tick.
func (p *Pad) Held(b Button) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.view.Buttons&b.Mask() != 0
}

// JustPressed reports whether b went down between the last two Ticks. A tap
// shorter than a frame still counts: edges are latched as frames arrive.
func (p *Pad) JustPressed(b Button) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.justPressed&b.Mask() != 0
}

// JustReleased reports whether b went up between the last two Ticks.
func (p *Pad) JustReleased(b Button) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.justReleased&b.Mask() != 0
}

// State is the whole snapshot as of the last Tick.
func (p *Pad) State() State {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.view
}

// Stick is the left stick as of the last Tick, -1..1 (y down). The paddle
// layout's slider and tilt steering also report here.
func (p *Pad) Stick() (x, y float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.view.LX, p.view.LY
}

// RightStick is the right stick as of the last Tick, -1..1 (y down).
func (p *Pad) RightStick() (x, y float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.view.RX, p.view.RY
}

// Pointer is the touchpad pointer as of the last Tick: accumulated pixels
// that wrap at 16 bits, so use differences between ticks.
func (p *Pad) Pointer() (x, y int16) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.view.PX, p.view.PY
}

// Connected reports whether the phone is in the room right now.
func (p *Pad) Connected() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.connected
}

// P2P reports whether a direct WebRTC channel to this phone is open.
func (p *Pad) P2P() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.p2p
}

// RTT is the phone's last reported round trip in ms, over the path it is
// using (see Via). 0 until the phone reports one, every few seconds.
func (p *Pad) RTT() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.rtt
}

// Via is the path the phone reports sending input on: "p2p" or "relay"
// ("" until it reports).
func (p *Pad) Via() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.via
}

// Frames counts input frames applied, for rate displays.
func (p *Pad) Frames() uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.frames
}

// ---- Network side ----

// apply takes a decoded frame, latching edges. Only a newer sequence number
// counts, except straight after a (re)join, when the phone may have restarted
// its numbering.
func (p *Pad) apply(f frame) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.fresh && !seqNewer(f.seq, p.seq) {
		return
	}
	p.fresh, p.seq = false, f.seq
	p.pressed |= f.state.Buttons &^ p.live.Buttons
	p.released |= p.live.Buttons &^ f.state.Buttons
	p.live = f.state
	p.frames++
}

// tick publishes the live state and the latched edges to the game.
func (p *Pad) tick() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.view = p.live
	p.justPressed, p.justReleased = p.pressed, p.released
	p.pressed, p.released = 0, 0
}

// join marks the pad present. It reports whether it was absent before (so
// the game should hear about it).
func (p *Pad) join(device string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	was := p.connected
	p.connected, p.fresh = true, true
	p.events.fresh = true // the phone may have restarted its event counter
	if device != "" {
		p.device = device
	}
	return !was
}

// releaseInput lets go of everything held, latching the releases, so nothing
// sticks when we lose contact with the phone.
func (p *Pad) releaseInput() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.released |= p.live.Buttons
	p.live = State{PX: p.live.PX, PY: p.live.PY}
}

// leave marks the pad gone and releases its input. It reports whether it
// was present before.
func (p *Pad) leave() bool {
	p.releaseInput()
	p.mu.Lock()
	defer p.mu.Unlock()
	was := p.connected
	p.connected, p.p2p = false, false
	return was
}

// setP2P records whether the direct channel is up.
func (p *Pad) setP2P(on bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.p2p = on
}

// setRTT records the phone's reported round trip and path.
func (p *Pad) setRTT(ms int, via string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.rtt, p.via = ms, via
}

// acceptEvent reports whether screen event n is new from this phone.
func (p *Pad) acceptEvent(n int64) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.events.accept(n)
}
