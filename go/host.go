// Host owns a room: one WebSocket to the relay, the pads in it, and (in
// p2p.go) a WebRTC peer connection per phone. The network runs on its own
// goroutines; the game thread calls Tick once per frame and then reads pads.

package stickdrift

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Options configure a Host. Every field is optional.
type Options struct {
	// Origin is the relay's base URL. Default: $STICKDRIFT_URL, else
	// DefaultOrigin. Use http://localhost:8787 for a local wrangler dev.
	Origin string
	// Code and Key reclaim a room (say, after the game restarts) with its
	// phones still seated. Default: a random code and key.
	Code, Key string
	// Title is shown on the phones.
	Title string
	// MaxPads caps the room (default 16, the relay allows up to 64).
	MaxPads int
	// Look is the default look for every pad.
	Look Look
	// DisableP2P keeps all input on the relay (no WebRTC).
	DisableP2P bool
	// ICEServers overrides the STUN server for WebRTC.
	ICEServers []string
	// Logger receives connection events. Default: discarded, or stderr when
	// STICKDRIFT_DEBUG is set.
	Logger *slog.Logger
	// UserAgent is sent when dialling the relay (default "stickdrift-go").
	UserAgent string
}

// Status is the room's connection state.
type Status int

// Connection states.
const (
	StatusOff        Status = iota // not started, or closed
	StatusConnecting               // dialling the relay (first time or again)
	StatusOnline                   // welcomed: the join URL works
	StatusError                    // disconnected; Info().Err says why; retrying unless ErrReplaced
)

// String names the status for display.
func (s Status) String() string {
	switch s {
	case StatusOff:
		return "off"
	case StatusConnecting:
		return "connecting"
	case StatusOnline:
		return "online"
	case StatusError:
		return "error"
	}
	return fmt.Sprintf("Status(%d)", int(s))
}

// ErrReplaced means another host connected with this room's key, so this one
// stopped rather than fight it for the room.
var ErrReplaced = errors.New("another host took over this room")

// errCodeTaken means a different key holds the code: pick another.
var errCodeTaken = errors.New("room code in use")

// Info describes the room for display.
type Info struct {
	Code    string        // room code
	JoinURL string        // what the QR code should say ("" until online)
	Status  Status        // connection state
	Err     error         // last error, if any
	RTT     time.Duration // this host's round trip to the relay
}

// Timings.
const (
	pingEvery     = 5 * time.Second        // RTT measurement and NAT keepalive
	dialTimeout   = 10 * time.Second       // give up on one connection attempt
	writeTimeout  = 3 * time.Second        // a control message that can't go out in this long is dropped
	backoffFirst  = 250 * time.Millisecond // first reconnect delay
	backoffMax    = 5 * time.Second        // reconnect delay cap
	closeReplaced = 4000                   // relay close code: a newer host connection took the room
	readLimit     = 1 << 20                // largest relay message (SDP plus a pad list)
)

// Host is a room. Make one with NewHost, then Start it.
type Host struct {
	origin    string
	title     string
	maxPads   int
	p2p       bool
	userAgent string
	log       *slog.Logger
	peers     *peers

	mu      sync.Mutex
	code    string
	key     string
	joinURL string
	status  Status
	lastErr error
	rtt     time.Duration
	pingAt  time.Time
	look    Look
	open    bool
	pads    map[int]*Pad
	joined  []*Pad  // pads that arrived since the last Joined
	left    []*Pad  // pads that went since the last Left
	events  []Event // screen answers since the last Events
	// padLooks is the layout and screen this host last gave each pad of its
	// own (SetPad), mirroring how the relay merges a pad's look over the
	// room's. It decides which screen a pad's events must answer.
	padLooks   map[int]*padLook
	roomScreen *Screen // h.look.Screen, normalized
	conn       *websocket.Conn
	started    bool
	cancel     context.CancelFunc
	done       chan struct{}
	ready      chan struct{} // closed at the first welcome
}

// NewHost prepares a room. Nothing touches the network until Start.
func NewHost(opts Options) *Host {
	origin := opts.Origin
	if origin == "" {
		origin = os.Getenv("STICKDRIFT_URL")
	}
	if origin == "" {
		origin = DefaultOrigin
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
		if os.Getenv("STICKDRIFT_DEBUG") != "" {
			logger = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
		}
	}
	h := &Host{
		origin:     strings.TrimRight(origin, "/"),
		title:      opts.Title,
		maxPads:    opts.MaxPads,
		p2p:        !opts.DisableP2P,
		userAgent:  opts.UserAgent,
		log:        logger,
		code:       opts.Code,
		key:        opts.Key,
		look:       opts.Look,
		roomScreen: opts.Look.Screen.normalize(),
		open:       true,
		pads:       map[int]*Pad{},
		padLooks:   map[int]*padLook{},
		ready:      make(chan struct{}),
	}
	if h.code == "" {
		h.code = RandomCode()
	}
	if h.key == "" {
		h.key = RandomKey()
	}
	if h.maxPads == 0 {
		h.maxPads = 16
	}
	if h.userAgent == "" {
		h.userAgent = "stickdrift-go"
	}
	ice := opts.ICEServers
	if len(ice) == 0 {
		ice = []string{stunServer}
	}
	h.peers = newPeers(ice)
	return h
}

// Start opens the room in the background and keeps it connected until ctx
// is done or Close is called. Calling it again does nothing.
func (h *Host) Start(ctx context.Context) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.started {
		return
	}
	h.started = true
	h.status = StatusConnecting
	ctx, h.cancel = context.WithCancel(ctx)
	h.done = make(chan struct{})
	go h.run(ctx)
}

// Close shuts the room and waits for the network goroutines to finish.
func (h *Host) Close() {
	h.mu.Lock()
	cancel, done := h.cancel, h.done
	h.mu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	<-done
	h.peers.closeAll()
	h.mu.Lock()
	h.status = StatusOff
	h.mu.Unlock()
}

// Ready is closed once the room is first online, when Info().JoinURL is set.
func (h *Host) Ready() <-chan struct{} { return h.ready }

// Info reports the room for display.
func (h *Host) Info() Info {
	h.mu.Lock()
	defer h.mu.Unlock()
	return Info{Code: h.code, JoinURL: h.joinURL, Status: h.status, Err: h.lastErr, RTT: h.rtt}
}

// Key is the host secret. Save it with the code to reclaim the room later.
func (h *Host) Key() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.key
}

// ---- Game thread ----

// Tick publishes every pad's latest state and the edges latched since the
// previous Tick. Call it once per game frame, before reading any pad.
func (h *Host) Tick() {
	h.mu.Lock()
	pads := make([]*Pad, 0, len(h.pads))
	for _, p := range h.pads {
		pads = append(pads, p)
	}
	h.mu.Unlock()
	for _, p := range pads {
		p.tick()
	}
}

// Pads returns the pads in the room now, by seat number.
func (h *Host) Pads() []*Pad {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]*Pad, 0, len(h.pads))
	for _, p := range h.pads {
		if p.Connected() {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].number < out[j].number })
	return out
}

// Pad returns seat n, or nil if no phone has sat there this session. The
// pad may be disconnected; check Connected.
func (h *Host) Pad(n int) *Pad {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.pads[n]
}

// Joined returns pads that arrived since the last call: new phones and
// returning ones (the same *Pad, same seat).
func (h *Host) Joined() []*Pad {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := h.joined
	h.joined = nil
	return out
}

// Left returns pads that went since the last call. Their buttons read as
// released from the next Tick.
func (h *Host) Left() []*Pad {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := h.left
	h.left = nil
	return out
}

// Events returns the screen answers that arrived since the last call, in
// arrival order. Only events that answer a pad's current screen get here
// (see Screen and Event); call it once per frame, like Joined.
//
//	for _, ev := range host.Events() {
//		if ev.Element == "hand" {
//			play(ev.Pad.Number(), ev.Picks)
//		}
//	}
func (h *Host) Events() []Event {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := h.events
	h.events = nil
	return out
}

// ---- Commands ----
//
// Commands are best effort: sent if the relay is connected, dropped (and
// logged) if not. SetLook and SetOpen are remembered and re-sent on
// reconnect; the relay itself remembers each pad's look.

// SetLook changes the default look for every pad.
func (h *Host) SetLook(look Look) {
	h.mu.Lock()
	h.setRoomLook(look)
	h.mu.Unlock()
	h.send(map[string]any{"t": "config", "look": look})
}

// SetPad changes one pad's look. Fields left zero keep their value.
func (h *Host) SetPad(n int, look Look) {
	b, err := json.Marshal(look)
	if err != nil {
		h.log.Warn("stickdrift: bad look", "pad", n, "err", err)
		return
	}
	var fields map[string]any
	_ = json.Unmarshal(b, &fields)
	fields["t"], fields["pad"] = "pad", n
	h.rememberPadLook(n, look)
	h.send(fields)
}

// SetOpen allows or refuses new phones (known phones can always rejoin).
func (h *Host) SetOpen(open bool) {
	h.mu.Lock()
	h.open = open
	h.mu.Unlock()
	h.send(map[string]any{"t": "config", "open": open})
}

// Haptic vibrates a phone: one duration in ms, or an on/off pattern.
// Android only; iOS ignores it.
func (h *Host) Haptic(n int, ms ...int) {
	if len(ms) == 0 {
		return
	}
	var v any = ms
	if len(ms) == 1 {
		v = ms[0]
	}
	h.send(map[string]any{"t": "haptic", "pad": n, "ms": v})
}

// Kick disconnects a phone and frees its seat.
func (h *Host) Kick(n int) {
	h.mu.Lock()
	delete(h.padLooks, n) // the relay forgets the seat's look too
	h.mu.Unlock()
	h.send(map[string]any{"t": "kick", "pad": n})
}

// send writes a JSON control message if connected.
func (h *Host) send(v any) {
	h.mu.Lock()
	c := h.conn
	h.mu.Unlock()
	if c == nil {
		h.log.Debug("stickdrift: not connected, dropped message")
		return
	}
	b, err := json.Marshal(v)
	if err != nil {
		h.log.Warn("stickdrift: encoding message", "err", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		h.log.Debug("stickdrift: write failed", "err", err)
	}
}

// ---- Connection loop ----

// run keeps the room connected, reconnecting with backoff, until ctx ends
// or another host replaces this one.
func (h *Host) run(ctx context.Context) {
	defer close(h.done)
	backoff := backoffFirst
	for ctx.Err() == nil {
		welcomed, err := h.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if welcomed {
			backoff = backoffFirst
		}
		h.lostRelay(err)
		if errors.Is(err, ErrReplaced) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, backoffMax)
	}
}

// lostRelay records why the connection ended and lets go of input from
// phones we can no longer hear. Pads stay seated (the relay keeps them while
// we reconnect; the next welcome reconciles), and pads with an open P2P
// channel keep working throughout.
func (h *Host) lostRelay(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.conn, h.status, h.lastErr = nil, StatusError, err
	h.log.Info("stickdrift: relay connection ended", "err", err)
	if errors.Is(err, errCodeTaken) {
		h.code = RandomCode()
		h.log.Info("stickdrift: code taken, trying another", "code", h.code)
	}
	for _, p := range h.pads {
		if !p.P2P() {
			p.releaseInput()
		}
	}
}

// session is one connection's lifetime. It reports whether the relay
// welcomed us (so backoff can reset) and why it ended.
func (h *Host) session(ctx context.Context) (welcomed bool, err error) {
	h.mu.Lock()
	// origin tells the relay which address phones should use for the join
	// link; it matters when the relay is a local wrangler dev.
	u := fmt.Sprintf("%s/ws/host/%s?key=%s&origin=%s", wsOrigin(h.origin), h.code, url.QueryEscape(h.key), url.QueryEscape(h.origin))
	h.status = StatusConnecting
	h.mu.Unlock()
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	c, res, err := websocket.Dial(dialCtx, u, dialOptions(h.userAgent))
	if err != nil {
		if res != nil && res.StatusCode == http.StatusConflict {
			return false, errCodeTaken
		}
		return false, fmt.Errorf("connecting to %s: %w", h.origin, err)
	}
	defer func() { _ = c.CloseNow() }()
	c.SetReadLimit(readLimit)
	h.mu.Lock()
	h.conn = c
	config := map[string]any{"t": "config", "title": h.title, "maxPads": h.maxPads, "open": h.open, "look": h.look, "p2p": h.p2p}
	h.mu.Unlock()
	h.send(config)
	pingCtx, stopPing := context.WithCancel(ctx)
	defer stopPing()
	go h.pinger(pingCtx, c)
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == closeReplaced {
				return welcomed, ErrReplaced
			}
			return welcomed, fmt.Errorf("relay connection lost: %w", err)
		}
		if typ == websocket.MessageBinary {
			h.onFrame(data)
			continue
		}
		if h.onMessage(data) {
			welcomed = true
		}
	}
}

// pinger sends the relay's ping every few seconds: it measures our round
// trip and keeps idle NATs and proxies from dropping the socket. The relay
// answers without waking the room.
func (h *Host) pinger(ctx context.Context, c *websocket.Conn) {
	t := time.NewTicker(pingEvery)
	defer t.Stop()
	for {
		h.mu.Lock()
		h.pingAt = time.Now()
		h.mu.Unlock()
		wctx, cancel := context.WithTimeout(ctx, writeTimeout)
		err := c.Write(wctx, websocket.MessageText, []byte(pingMessage))
		cancel()
		if err != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// The exact strings the relay answers without waking the room.
const (
	pingMessage = `{"t":"ping"}`
	pongMessage = `{"t":"pong"}`
)

// ---- Relay messages ----

// relayMessage is any JSON message from the relay.
type relayMessage struct {
	T       string          `json:"t"`
	Code    string          `json:"code"`
	JoinURL string          `json:"joinUrl"`
	Pad     int             `json:"pad"`
	Device  string          `json:"device"`
	MS      float64         `json:"ms"`
	Via     string          `json:"via"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
	Pads    []padInfo       `json:"pads"`
	Rejoin  bool            `json:"rejoin"`
}

// padInfo is a seated phone in a welcome.
type padInfo struct {
	Pad    int    `json:"pad"`
	Device string `json:"device"`
}

// onMessage handles one JSON message. It reports whether it was a welcome.
func (h *Host) onMessage(data []byte) bool {
	if string(data) == pongMessage {
		h.mu.Lock()
		if !h.pingAt.IsZero() {
			h.rtt = time.Since(h.pingAt)
		}
		h.mu.Unlock()
		return false
	}
	var m relayMessage
	if err := json.Unmarshal(data, &m); err != nil {
		h.log.Debug("stickdrift: bad relay message", "err", err)
		return false
	}
	h.log.Debug("stickdrift: relay message", "t", m.T, "pad", m.Pad)
	switch m.T {
	case "welcome":
		h.onWelcome(m)
		return true
	case "join":
		if !m.Rejoin {
			// A new phone in this seat starts from the room's look, as on
			// the relay; any screen we gave the seat's last phone is gone.
			h.mu.Lock()
			delete(h.padLooks, m.Pad)
			h.mu.Unlock()
		}
		h.onJoin(m.Pad, m.Device)
	case "leave":
		h.onLeave(m.Pad)
	case "rtt":
		if p := h.Pad(m.Pad); p != nil {
			p.setRTT(int(m.MS+0.5), m.Via)
		}
	case "signal":
		h.onSignal(m.Pad, m.Data)
	case "event":
		var w wireEvent
		if json.Unmarshal(data, &w) == nil {
			h.onEvent(w.Pad, w)
			// Acknowledge it (duplicates and stale ones too), through the
			// relay to the phone, which retries until someone has it.
			if w.N > 0 {
				h.send(map[string]any{"t": "ack", "pad": w.Pad, "n": w.N, "s": w.S})
			}
		}
	case "error":
		h.mu.Lock()
		h.lastErr = fmt.Errorf("relay: %s: %s", m.Code, m.Message)
		h.mu.Unlock()
	}
	return false
}

// onWelcome goes online and reconciles pads with the relay's list: seated
// phones are (still) here, and anything we knew that is not listed left
// while we were away.
func (h *Host) onWelcome(m relayMessage) {
	listed := map[int]bool{}
	for _, info := range m.Pads {
		listed[info.Pad] = true
		h.onJoin(info.Pad, info.Device)
	}
	var gone []int
	h.mu.Lock()
	h.code, h.joinURL, h.status, h.lastErr = m.Code, m.JoinURL, StatusOnline, nil
	select {
	case <-h.ready:
	default:
		close(h.ready)
	}
	for n, p := range h.pads {
		if !listed[n] && p.Connected() {
			gone = append(gone, n)
		}
	}
	h.mu.Unlock()
	for _, n := range gone {
		h.onLeave(n)
	}
}

// onJoin seats a phone, queueing it for Joined if it wasn't already here.
func (h *Host) onJoin(n int, device string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	p := h.pads[n]
	if p == nil {
		p = newPad(n, device)
		h.pads[n] = p
	}
	if p.join(device) {
		h.joined = append(h.joined, p)
	}
}

// onLeave unseats a phone and drops its peer connection.
func (h *Host) onLeave(n int) {
	h.peers.close(n)
	h.mu.Lock()
	defer h.mu.Unlock()
	if p := h.pads[n]; p != nil && p.leave() {
		h.left = append(h.left, p)
	}
}

// onFrame applies a relayed input frame; the relay stamps the pad number.
func (h *Host) onFrame(data []byte) {
	if f, ok := decodeFrame(data); ok {
		h.applyFrame(f.pad, f)
	}
}

// applyFrame hands a frame to pad n.
func (h *Host) applyFrame(n int, f frame) {
	if p := h.Pad(n); p != nil {
		p.apply(f)
	}
}

// wsOrigin turns http(s):// into ws(s)://.
func wsOrigin(origin string) string {
	switch {
	case strings.HasPrefix(origin, "https://"):
		return "wss://" + strings.TrimPrefix(origin, "https://")
	case strings.HasPrefix(origin, "http://"):
		return "ws://" + strings.TrimPrefix(origin, "http://")
	}
	return origin
}

// ---- Screens ----

// padLook is the part of a pad's own look that decides its screen.
type padLook struct {
	layout string
	screen *Screen
}

// rememberPadLook records the layout and screen a SetPad gives pad n.
func (h *Host) rememberPadLook(n int, look Look) {
	h.mu.Lock()
	defer h.mu.Unlock()
	pl := h.padLooks[n]
	if pl == nil {
		pl = &padLook{}
		h.padLooks[n] = pl
	}
	if look.Layout != "" {
		pl.layout = look.Layout
	}
	// A screen the relay would refuse leaves the pad's last one in place,
	// as on the relay.
	if s := look.Screen.normalize(); s != nil {
		pl.screen = s
	}
	for _, f := range look.Clear {
		if f == "screen" {
			pl.screen = nil
		}
	}
}

// currentScreen is the screen pad n shows now: its own if it has one, else
// the room's, and only while its layout is "screen". Call with h.mu held.
func (h *Host) currentScreen(n int) *Screen {
	layout, screen := h.look.Layout, h.roomScreen
	if pl := h.padLooks[n]; pl != nil {
		if pl.layout != "" {
			layout = pl.layout
		}
		if pl.screen != nil {
			screen = pl.screen
		}
	}
	if layout != "screen" {
		return nil
	}
	return screen
}

// onEvent queues a phone's screen answer if it answers that pad's current
// screen and hasn't been seen (events can arrive over both paths).
func (h *Host) onEvent(n int, w wireEvent) {
	p := h.Pad(n)
	if p == nil || w.T != "event" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	ev, ok := h.currentScreen(n).check(w)
	if !ok {
		h.log.Debug("stickdrift: dropped screen event", "pad", n, "screen", w.Screen, "element", w.Element)
		return
	}
	if !p.acceptEvent(w.S, w.N) {
		return
	}
	ev.Pad = p
	h.events = append(h.events, ev)
}

// setRoomLook records the room's look, and its screen as the relay will
// pass it on (normalize also copies it, so a game editing its Screen after
// sending can't change what events are checked against). Call with h.mu
// held.
func (h *Host) setRoomLook(l Look) {
	h.look, h.roomScreen = l, l.Screen.normalize()
}
