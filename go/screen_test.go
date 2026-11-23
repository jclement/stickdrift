// Screen layout: JSON shape, event checking, de-duplication, and the host
// dropping events for screens that are no longer current.

package stickdrift

import (
	"encoding/json"
	"testing"
	"time"
)

// handScreen is a typical private hand: pick two cards, plus a ready button.
func handScreen(id string) *Screen {
	return &Screen{ID: id, Items: []Element{
		{Type: ElemHeading, Text: "Pick two"},
		{Type: ElemCards, ID: "hand", Pick: 2, Submit: "PLAY", Cards: []Card{{ID: "c1", Text: "one"}, {ID: "c2", Text: "two"}, {ID: "c3", Text: "three"}}},
		{Type: ElemChoices, ID: "vote", Options: []Option{{ID: "p0", Text: "Ann", Pad: Seat(0)}, {ID: "p1", Text: "Bo"}}},
		{Type: ElemStepper, ID: "bet", Min: 0, Max: 50, Step: 5, Value: 10},
		{Type: ElemInput, ID: "answer", MaxLength: 5},
		{Type: ElemButton, ID: "ready", Label: "READY"},
		{Type: ElemButton, ID: "skip", Label: "SKIP", Disabled: true},
		{Type: ElemStatus, Text: "Waiting", Seconds: 30},
	}}
}

func TestScreenJSON(t *testing.T) {
	b, err := json.Marshal(Look{Layout: "screen", Screen: handScreen("r1")})
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Layout string `json:"layout"`
		Screen struct {
			ID    string           `json:"id"`
			Items []map[string]any `json:"items"`
		} `json:"screen"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if m.Layout != "screen" || m.Screen.ID != "r1" || len(m.Screen.Items) != 8 {
		t.Fatalf("look = %s", b)
	}
	if _, ok := m.Screen.Items[0]["min"]; ok {
		t.Fatalf("a heading must not carry stepper fields: %v", m.Screen.Items[0])
	}
	bet := m.Screen.Items[3]
	if bet["min"] != 0.0 || bet["max"] != 50.0 || bet["step"] != 5.0 || bet["value"] != 10.0 {
		t.Fatalf("stepper = %v", bet)
	}
	if opt := m.Screen.Items[2]["options"].([]any)[0].(map[string]any); opt["pad"] != 0.0 {
		t.Fatalf("option pad 0 must be sent: %v", opt)
	}
	// Round trip keeps the numbers.
	var back Screen
	if err := json.Unmarshal([]byte(`{"id":"x","items":[{"type":"slider","id":"s","min":-5,"max":5,"step":1,"value":2}]}`), &back); err != nil {
		t.Fatal(err)
	}
	if e := back.Items[0]; e.Min != -5 || e.Max != 5 || e.Value != 2 {
		t.Fatalf("decoded slider = %+v", e)
	}

	// Clear "screen" sends null, so the relay drops the pad's own screen.
	b, _ = json.Marshal(Look{Clear: []string{"screen"}})
	if string(b) != `{"screen":null}` {
		t.Fatalf("clear screen = %s", b)
	}
}

func TestScreenCheck(t *testing.T) {
	s := handScreen("r1")
	ev := func(element, value string) wireEvent {
		return wireEvent{T: "event", N: 1, Screen: "r1", Element: element, Value: json.RawMessage(value)}
	}
	cases := []struct {
		name string
		w    wireEvent
		ok   bool
	}{
		{"two cards", ev("hand", `["c3","c1"]`), true},
		{"one card of two", ev("hand", `["c1"]`), false},
		{"repeated card", ev("hand", `["c1","c1"]`), false},
		{"unknown card", ev("hand", `["c1","c9"]`), false},
		{"option id as a card", ev("hand", `["c1","p0"]`), false},
		{"vote", ev("vote", `["p1"]`), true},
		{"vote as a string", ev("vote", `"p1"`), false},
		{"bet", ev("bet", `20`), true},
		{"bet as text", ev("bet", `"20"`), false},
		{"answer", ev("answer", `"hello"`), true},
		{"answer as a number", ev("answer", `5`), false},
		{"ready", ev("ready", `null`), true},
		{"disabled button", ev("skip", `null`), false},
		{"heading", ev("", `null`), false},
		{"unknown element", ev("nope", `null`), false},
		{"other screen", wireEvent{T: "event", N: 1, Screen: "r0", Element: "ready"}, false},
	}
	for _, c := range cases {
		if _, ok := s.check(c.w); ok != c.ok {
			t.Errorf("%s: ok = %v, want %v", c.name, ok, c.ok)
		}
	}
	got, _ := s.check(ev("hand", `["c3","c1"]`))
	if len(got.Picks) != 2 || got.Picks[0] != "c3" || got.Type != ElemCards {
		t.Fatalf("picks = %+v", got)
	}
	got, _ = s.check(ev("bet", `999`))
	if got.Number != 50 {
		t.Fatalf("bet not clamped: %v", got.Number)
	}
	got, _ = s.check(ev("answer", `"héllo wörld"`))
	if got.Text != "héllo" {
		t.Fatalf("answer not cut to 5 characters: %q", got.Text)
	}
	s.Locked = true
	if _, ok := s.check(ev("ready", `null`)); ok {
		t.Fatal("a locked screen must refuse events")
	}
	if _, ok := (*Screen)(nil).check(ev("ready", `null`)); ok {
		t.Fatal("no screen must refuse events")
	}
}

func TestEventWindow(t *testing.T) {
	var w eventWindow
	steps := []struct {
		n  int64
		ok bool
	}{{5, true}, {5, false}, {7, true}, {6, true}, {6, false}, {3, true}, {200, true}, {100, false}, {199, true}, {0, false}, {-1, false}}
	for _, s := range steps {
		if got := w.accept(s.n); got != s.ok {
			t.Fatalf("accept(%d) = %v, want %v", s.n, got, s.ok)
		}
	}
	w.fresh = true
	if !w.accept(1) {
		t.Fatal("a rejoined phone restarts its counter")
	}
}

// TestHostEvents drives the host through the fake relay: answers to the
// current screen arrive once, stale and duplicate ones don't, and a pad
// switched to another layout sends nothing that counts.
func TestHostEvents(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{Look: Look{Layout: "screen", Screen: &Screen{ID: "lobby", Items: []Element{{Type: ElemButton, ID: "ready", Label: "READY"}}}}})
	p := join(t, r, h, 1)
	send := func(n int, screen, element, value string) {
		r.sendJSON(map[string]any{"t": "event", "pad": 1, "n": n, "screen": screen, "element": element, "value": json.RawMessage(value)})
	}
	// drain collects events up to one for the marker element, which each
	// step sends last: relay messages are handled in order, so once it is
	// here everything before it has been judged.
	drain := func(marker string) []Event {
		t.Helper()
		var got []Event
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			for _, e := range h.Events() {
				got = append(got, e)
				if e.Element == marker {
					return got
				}
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("no %q event; got %+v", marker, got)
		return nil
	}

	// The room's default screen.
	send(1, "lobby", "ready", "null")
	if got := drain("ready"); len(got) != 1 || got[0].Pad != p || got[0].Screen != "lobby" {
		t.Fatalf("lobby events = %+v", got)
	}

	// The pad's own screen replaces it; lobby taps are now stale.
	h.SetPad(1, Look{Screen: handScreen("r1")})
	r.expect("pad")
	send(2, "lobby", "ready", "null")    // stale screen
	send(3, "r1", "hand", `["c1","c2"]`) // counts
	send(3, "r1", "hand", `["c1","c2"]`) // duplicate (the other path)
	send(4, "r1", "bet", `15`)           // counts
	send(5, "r1", "ready", "null")       // marker
	got := drain("ready")
	if len(got) != 3 || got[0].Element != "hand" || got[1].Number != 15 {
		t.Fatalf("r1 events = %+v", got)
	}

	// Same id again: still current. A new id: the old one is stale.
	h.SetPad(1, Look{Screen: handScreen("r1")})
	h.SetPad(1, Look{Screen: handScreen("r2")})
	send(6, "r1", "ready", "null")
	send(7, "r2", "answer", `"hi"`)
	send(8, "r2", "ready", "null")
	if got := drain("ready"); len(got) != 2 || got[0].Text != "hi" || got[1].Screen != "r2" {
		t.Fatalf("r2 events = %+v", got)
	}

	// Clearing the pad's screen falls back to the room's.
	h.SetPad(1, Look{Clear: []string{"screen"}})
	send(9, "r2", "ready", "null")
	send(10, "lobby", "ready", "null")
	if got := drain("ready"); len(got) != 1 || got[0].Screen != "lobby" {
		t.Fatalf("after clear = %+v", got)
	}

	// Another layout: no screen, so nothing counts, not even the right id.
	h.SetPad(1, Look{Layout: "buzzer"})
	send(11, "lobby", "ready", "null")
	time.Sleep(100 * time.Millisecond) // let the host see 11 before switching back
	if got := h.Events(); len(got) != 0 {
		t.Fatalf("buzzer layout events = %+v", got)
	}
	h.SetPad(1, Look{Layout: "screen"})
	send(12, "lobby", "ready", "null")
	if got := drain("ready"); len(got) != 1 {
		t.Fatalf("after layout switch = %+v", got)
	}

	// A rejoin resets the counter: the phone reloaded and starts at 1.
	r.sendJSON(map[string]any{"t": "leave", "pad": 1})
	waitFor(t, "leave", func() bool { return !p.Connected() })
	r.sendJSON(map[string]any{"t": "join", "pad": 1, "device": "device-b", "rejoin": true})
	waitFor(t, "rejoin", func() bool { return p.Connected() })
	send(1, "lobby", "ready", "null")
	if got := drain("ready"); len(got) != 1 {
		t.Fatalf("after rejoin = %+v", got)
	}

	// A new phone in the seat (rejoin false) starts from the room's look.
	h.SetPad(1, Look{Screen: handScreen("r9")})
	r.sendJSON(map[string]any{"t": "join", "pad": 1, "device": "device-z", "rejoin": false})
	time.Sleep(50 * time.Millisecond)
	send(1, "r9", "ready", "null")
	send(2, "lobby", "ready", "null")
	if got := drain("ready"); len(got) != 1 || got[0].Screen != "lobby" {
		t.Fatalf("new phone = %+v", got)
	}
}

// TestUnknownRelayMessagesAreIgnored proves a host that never set a screen
// shrugs off an event (and anything else it doesn't know).
func TestUnknownRelayMessagesAreIgnored(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{Look: Look{Layout: "dpad-ab"}})
	p := join(t, r, h, 0)
	r.sendJSON(map[string]any{"t": "event", "pad": 0, "n": 1, "screen": "x", "element": "y"})
	r.sendJSON(map[string]any{"t": "something-new", "pad": 0})
	r.sendBinary(encodeFrame(0, 1, State{Buttons: A.Mask()}))
	waitFor(t, "frame", func() bool { return p.Frames() == 1 })
	h.Tick()
	if !p.JustPressed(A) || len(h.Events()) != 0 {
		t.Fatal("unknown messages must not disturb input")
	}
}
