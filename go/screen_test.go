// Screen layout: JSON shape, event checking, de-duplication, and the host
// dropping events for screens that are no longer current.

package stickdrift

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
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
		s  string
		n  int64
		ok bool
	}{
		{"a", 5, true}, {"a", 5, false}, {"a", 7, true}, {"a", 6, true}, {"a", 6, false}, {"a", 3, true},
		{"a", 200, true}, {"a", 100, false}, {"a", 199, true}, {"a", 0, false}, {"a", -1, false},
		// Widely separated counters, up to the largest the relay accepts.
		{"a", maxEventN, true}, {"a", 1, false}, {"a", maxEventN, false}, {"a", maxEventN + 1, false},
		// A new page (session) starts afresh; the old one's copies are refused.
		{"b", 1, true}, {"b", 1, false}, {"b", 2, true},
		// Going back to a retired session must not reset anything: a late
		// copy from the old page and the new page's duplicate are both old.
		{"old", 12, true}, {"new", 1, true}, {"old", 12, false}, {"new", 1, false},
	}
	for i, st := range steps {
		if got := w.accept(st.s, st.n); got != st.ok {
			t.Fatalf("step %d: accept(%q, %d) = %v, want %v", i, st.s, st.n, got, st.ok)
		}
	}
}

// TestEventWindowKeepsRecentSessions: the last few sessions keep their
// history; only one evicted long ago starts over.
func TestEventWindowKeepsRecentSessions(t *testing.T) {
	var w eventWindow
	for _, s := range []string{"s1", "s2", "s3", "s4"} {
		w.accept(s, 1)
	}
	if w.accept("s1", 1) {
		t.Fatal("s1 is one of the last four sessions; its copy is old")
	}
	w.accept("s5", 1) // evicts s2, the least recently used
	if !w.accept("s2", 1) {
		t.Fatal("an evicted session starts over (bounded memory)")
	}
}

// TestRelayEventsAreAcknowledged: an event the relay forwards is
// acknowledged back through the relay, duplicates and stale ones too, so
// the phone stops retrying only once the game has it.
func TestRelayEventsAreAcknowledged(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{Look: Look{Layout: "screen", Screen: &Screen{ID: "s", Items: []Element{{Type: ElemButton, ID: "go", Label: "GO"}}}}})
	join(t, r, h, 3)
	for range 2 {
		r.sendJSON(map[string]any{"t": "event", "pad": 3, "s": "page", "n": 5, "screen": "s", "element": "go"})
		if m := r.expect("ack"); m["pad"] != 3.0 || m["n"] != 5.0 || m["s"] != "page" {
			t.Fatalf("ack = %v", m)
		}
	}
	if got := h.Events(); len(got) != 1 {
		t.Fatalf("events = %+v", got)
	}
}

// TestScreenFixtures holds normalize to the relay's cleanScreen, using the
// fixtures the TypeScript tests also check (go/testdata/gen-fixtures.ts).
func TestScreenFixtures(t *testing.T) {
	b, err := os.ReadFile("testdata/screen-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name string          `json:"name"`
		Raw  json.RawMessage `json:"raw"`
		Want json.RawMessage `json:"want"`
	}
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		var raw Screen
		if err := json.Unmarshal(c.Raw, &raw); err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		got, _ := json.Marshal(raw.normalize())
		var gotV, wantV any
		_ = json.Unmarshal(got, &gotV)
		_ = json.Unmarshal(c.Want, &wantV)
		if !reflect.DeepEqual(gotV, wantV) {
			t.Errorf("%s:\n got %s\nwant %s", c.Name, got, c.Want)
		}
	}
}

// TestCheckUsesTheNormalizedScreen: two cards sharing an id with Pick 2 is
// one card with Pick 1 on the phone, so one pick is the right answer.
func TestCheckUsesTheNormalizedScreen(t *testing.T) {
	s := (&Screen{ID: "r", Items: []Element{{Type: ElemCards, ID: "hand", Pick: 2, Cards: []Card{{ID: "c1", Text: "a"}, {ID: "c1", Text: "b"}}}}}).normalize()
	if _, ok := s.check(wireEvent{T: "event", N: 1, Screen: "r", Element: "hand", Value: json.RawMessage(`["c1"]`)}); !ok {
		t.Fatal("the answer the phone can give must be accepted")
	}
	many := &Screen{ID: "r", Items: []Element{{Type: ElemChoices, ID: "v"}}}
	for i := range 20 {
		many.Items[0].Options = append(many.Items[0].Options, Option{ID: fmt.Sprintf("o%d", i), Text: "x"})
	}
	if _, ok := many.normalize().check(wireEvent{T: "event", N: 1, Screen: "r", Element: "v", Value: json.RawMessage(`["o18"]`)}); ok {
		t.Fatal("an option past the cap was never shown, so it can't be answered")
	}
}

// TestHostEvents drives the host through the fake relay: answers to the
// current screen arrive once, stale and duplicate ones don't, and a pad
// switched to another layout sends nothing that counts.
func TestHostEvents(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{Look: Look{Layout: "screen", Screen: &Screen{ID: "lobby", Items: []Element{{Type: ElemButton, ID: "ready", Label: "READY"}}}}})
	p := join(t, r, h, 1)
	sendS := func(session string, n int, screen, element, value string) {
		r.sendJSON(map[string]any{"t": "event", "pad": 1, "s": session, "n": n, "screen": screen, "element": element, "value": json.RawMessage(value)})
	}
	send := func(n int, screen, element, value string) { sendS("page1", n, screen, element, value) }
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

	// A reconnect between two copies of one event: the late copy must not
	// count again (the phone's session is unchanged).
	r.sendJSON(map[string]any{"t": "leave", "pad": 1})
	waitFor(t, "leave", func() bool { return !p.Connected() })
	r.sendJSON(map[string]any{"t": "join", "pad": 1, "device": "device-b", "rejoin": true})
	waitFor(t, "rejoin", func() bool { return p.Connected() })
	send(12, "lobby", "ready", "null") // the late copy of 12
	time.Sleep(100 * time.Millisecond)
	if got := h.Events(); len(got) != 0 {
		t.Fatalf("a copy from before the reconnect counted again: %+v", got)
	}
	// A reloaded page is a new session, counting from 1 again.
	sendS("page2", 1, "lobby", "ready", "null")
	if got := drain("ready"); len(got) != 1 {
		t.Fatalf("new session = %+v", got)
	}

	// A new phone in the seat (rejoin false) starts from the room's look.
	h.SetPad(1, Look{Screen: handScreen("r9")})
	r.sendJSON(map[string]any{"t": "join", "pad": 1, "device": "device-z", "rejoin": false})
	time.Sleep(50 * time.Millisecond)
	sendS("phone-z", 1, "r9", "ready", "null")
	sendS("phone-z", 2, "lobby", "ready", "null")
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

// TestHostChecksTheNormalizedScreen: the host judges answers against the
// screen as the relay passed it on, not as the game wrote it.
func TestHostChecksTheNormalizedScreen(t *testing.T) {
	r := newFakeRelay(t)
	h := startHost(t, r, Options{})
	join(t, r, h, 0)
	h.SetPad(0, Look{Layout: "screen", Screen: &Screen{ID: "r", Items: []Element{{Type: ElemCards, ID: "hand", Pick: 2, Cards: []Card{{ID: "c1", Text: "a"}, {ID: "c1", Text: "b"}}}}}})
	r.sendJSON(map[string]any{"t": "event", "pad": 0, "s": "p", "n": 1, "screen": "r", "element": "hand", "value": []string{"c1"}})
	waitFor(t, "the one-card answer", func() bool { return len(h.Events()) == 1 })
}
