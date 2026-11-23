// Screens: the "screen" layout, where a phone shows a small scrolling page
// (headings, text cards, choices, steppers, a text box, buttons, a status
// line) instead of game-pad controls, and answers with discrete events. This
// is for word, card and voting games: private hands, votes, bets, typed
// answers. The relay and the phone validate everything again; the checks
// here keep a game honest about what it receives, including events that
// came straight over the peer-to-peer channel and never passed the relay.

package stickdrift

import (
	"encoding/json"
	"math"
	"regexp"
	"strings"
)

// Screen is what a phone shows in Layout "screen". Send it in a Look:
//
//	host.SetPad(n, stickdrift.Look{Layout: "screen", Screen: &stickdrift.Screen{
//		ID: "round3-hand",
//		Items: []stickdrift.Element{
//			{Type: stickdrift.ElemHeading, Text: "Pick your funniest card"},
//			{Type: stickdrift.ElemCards, ID: "hand", Pick: 1, Submit: "PLAY IT", Cards: hand},
//		},
//	}})
//
// and read the answers once per frame with Host.Events. Every event names
// the screen it was made on; events for a screen that is no longer the
// pad's current one are dropped, so a late tap from last round can't count.
// Sending a screen with the same ID again re-renders it without losing what
// the player had selected or typed (use that to update a status line or to
// lock it); a new ID starts afresh.
type Screen struct {
	ID     string    `json:"id"`               // 1-64 of [A-Za-z0-9_-]; change it for every new question
	Locked bool      `json:"locked,omitempty"` // every control disabled, e.g. "Locked in. Judge is thinking…"
	Items  []Element `json:"items"`            // top to bottom, at most MaxScreenItems
}

// Element types.
const (
	ElemHeading = "heading" // Text, big
	ElemText    = "text"    // Text, a paragraph (the prompt, instructions)
	ElemCards   = "cards"   // ID, Cards, Pick, Submit: choose Pick text cards (ordered when Pick > 1)
	ElemChoices = "choices" // ID, Options, Pick, Submit: a list of answers or players to vote for
	ElemStepper = "stepper" // ID, Min, Max, Step, Value, Submit: − value + (bets)
	ElemSlider  = "slider"  // ID, Min, Max, Step, Value, Submit: a slider
	ElemInput   = "input"   // ID, MaxLength, Placeholder, Submit: a typed answer
	ElemButton  = "button"  // ID, Label, Color: ready, skip, next
	ElemStatus  = "status"  // Text, Seconds (a countdown bar), Progress (0..1 bar)
)

// Limits the relay and phone enforce. Longer text is cut, extra items are
// dropped.
const (
	MaxScreenItems  = 24  // elements per screen
	MaxCards        = 12  // cards per cards element
	MaxCardText     = 140 // characters per card
	MaxOptions      = 16  // options per choices element
	MaxPick         = 3   // most cards or options a player picks at once
	MaxInputLength  = 80  // characters a player may type
	maxScreenIDLen  = 64  // screen ids
	maxElementIDLen = 32  // element, card and option ids
)

// Element is one item on a screen. Which fields matter depends on Type; see
// the Elem constants. Interactive elements (cards, choices, stepper, slider,
// input, button) need an ID, unique on the screen.
//
// When a player answers, the element sends one event and locks until the
// screen changes: cards and choices when Pick items are chosen (or when the
// Submit button is pressed, if Submit is set), input when its Submit button
// (default "SEND") is pressed, a button when tapped. Steppers and sliders
// without Submit send their value live as it changes and never lock.
type Element struct {
	Type     string `json:"type"`
	ID       string `json:"id,omitempty"`
	Text     string `json:"text,omitempty"`     // heading, text, status
	Disabled bool   `json:"disabled,omitempty"` // shown greyed out, sends nothing

	Cards   []Card   `json:"cards,omitempty"`   // cards
	Options []Option `json:"options,omitempty"` // choices
	Pick    int      `json:"pick,omitempty"`    // cards, choices: how many to choose, 1-3 (default 1)
	Submit  string   `json:"submit,omitempty"`  // label of a confirm button under the element

	// Stepper and slider. Written to JSON only for those types, so a zero
	// is a real zero. Max defaults to 100 only when Min and Max are both 0;
	// Step 0 means 1; Value is clamped into range.
	Min, Max, Step, Value float64 `json:"-"`

	MaxLength   int    `json:"maxLength,omitempty"`   // input: 1-80 (default 80)
	Placeholder string `json:"placeholder,omitempty"` // input

	Label string `json:"label,omitempty"` // button
	Color string `json:"color,omitempty"` // button: hex fill (default the player's colour)

	Seconds  float64 `json:"seconds,omitempty"`  // status: a countdown bar from when the phone shows it
	Progress float64 `json:"progress,omitempty"` // status: a static bar, 0..1
}

// Card is one text card in a cards element.
type Card struct {
	ID   string `json:"id"`
	Text string `json:"text"` // up to MaxCardText characters, plain text
}

// Option is one line in a choices element. Set Pad to show that player's
// colour and avatar beside it (the relay fills them in), or Color for a
// colour of your own.
type Option struct {
	ID    string `json:"id"`
	Text  string `json:"text"`
	Pad   *int   `json:"pad,omitempty"`   // a seat number; see Seat
	Color string `json:"color,omitempty"` // hex
}

// Seat returns a pointer to n, for Option.Pad.
func Seat(n int) *int { return &n }

// MarshalJSON writes min/max/step/value for steppers and sliders only, so
// other elements stay small and a numeric zero is never mistaken for unset.
func (e Element) MarshalJSON() ([]byte, error) {
	type plain Element // drops this method, so Marshal doesn't recurse
	b, err := json.Marshal(plain(e))
	if err != nil || (e.Type != ElemStepper && e.Type != ElemSlider) {
		return b, err
	}
	var fields map[string]any
	if err := json.Unmarshal(b, &fields); err != nil {
		return nil, err
	}
	lo, hi, step, v := e.numberRange()
	fields["min"], fields["max"], fields["step"], fields["value"] = lo, hi, step, v
	return json.Marshal(fields)
}

// UnmarshalJSON reads the numeric fields back (tests and tools decode
// screens; games normally only send them).
func (e *Element) UnmarshalJSON(b []byte) error {
	type plain Element
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	var nums struct{ Min, Max, Step, Value float64 }
	if err := json.Unmarshal(b, &nums); err != nil {
		return err
	}
	*e = Element(p)
	e.Min, e.Max, e.Step, e.Value = nums.Min, nums.Max, nums.Step, nums.Value
	return nil
}

// maxNumber bounds stepper and slider values, as the relay does.
const maxNumber = 1e6

// numberRange applies the stepper/slider defaults the phone uses
// (numberRange in src/shared/protocol.ts).
func (e Element) numberRange() (lo, hi, step, v float64) {
	clamp := func(x float64) float64 { return math.Max(-maxNumber, math.Min(maxNumber, x)) }
	lo, hi, step = clamp(e.Min), clamp(e.Max), e.Step
	if lo == 0 && hi == 0 {
		hi = 100
	}
	if hi < lo {
		lo, hi = hi, lo
	}
	span := hi - lo
	if span == 0 {
		span = 1
	}
	if step > 0 {
		step = math.Min(step, span)
	} else {
		step = 1
	}
	return lo, hi, step, math.Max(lo, math.Min(hi, clamp(e.Value)))
}

// interactive reports whether an element type sends events.
func interactive(typ string) bool {
	switch typ {
	case ElemCards, ElemChoices, ElemStepper, ElemSlider, ElemInput, ElemButton:
		return true
	}
	return false
}

// Event is one answer from a phone showing a screen. Read them with
// Host.Events once per frame:
//
//	for _, ev := range host.Events() {
//		switch ev.Element {
//		case "hand":
//			play(ev.Pad.Number(), ev.Picks) // card ids, in the order chosen
//		case "bet":
//			bet(ev.Pad.Number(), int(ev.Number))
//		case "answer":
//			answer(ev.Pad.Number(), ev.Text) // plain text: never render it as markup
//		}
//	}
//
// The library has already checked the event against the screen it last
// sent that pad: the screen is current, the element exists and is enabled,
// picks are ids from that element (Pick of them, no repeats), numbers are
// within range and text is at most MaxLength characters.
type Event struct {
	Pad     *Pad
	Screen  string   // the screen ID it was made on (always the current one)
	Element string   // the element's ID
	Type    string   // the element's type: cards, choices, stepper, slider, input, button
	Picks   []string // cards, choices: the chosen ids, in order
	Number  float64  // stepper, slider
	Text    string   // input
}

// wireEvent is a phone's event as it arrives, from the relay (with pad) or
// over the data channel (without).
type wireEvent struct {
	T       string          `json:"t"`
	Pad     int             `json:"pad"`
	N       int64           `json:"n"` // the phone's event counter, for de-duplication
	S       string          `json:"s"` // the phone page's event session (n counts within it)
	Screen  string          `json:"screen"`
	Element string          `json:"element"`
	Value   json.RawMessage `json:"value"`
}

// idPattern is what screen, element, card and option ids may contain.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// validID reports whether s is a usable id of at most n characters.
func validID(s string, n int) bool { return len(s) <= n && idPattern.MatchString(s) }

// check turns a wire event into an Event if it is a legal answer to screen
// s, or reports false. It mirrors the relay's checks (src/shared/protocol.ts
// cleanEvent) because data-channel events never pass the relay.
func (s *Screen) check(w wireEvent) (Event, bool) {
	if s == nil || s.Locked || w.Screen != s.ID {
		return Event{}, false
	}
	var el *Element
	for i := range s.Items {
		if s.Items[i].ID == w.Element && interactive(s.Items[i].Type) {
			el = &s.Items[i]
			break
		}
	}
	if el == nil || el.Disabled {
		return Event{}, false
	}
	ev := Event{Screen: s.ID, Element: el.ID, Type: el.Type}
	switch el.Type {
	case ElemCards, ElemChoices:
		var picks []string
		if json.Unmarshal(w.Value, &picks) != nil || len(picks) != el.pickCount() {
			return Event{}, false
		}
		allowed := map[string]bool{}
		for _, c := range el.Cards {
			allowed[c.ID] = el.Type == ElemCards
		}
		for _, o := range el.Options {
			allowed[o.ID] = el.Type == ElemChoices
		}
		seen := map[string]bool{}
		for _, id := range picks {
			if !allowed[id] || seen[id] {
				return Event{}, false
			}
			seen[id] = true
		}
		ev.Picks = picks
	case ElemStepper, ElemSlider:
		var v float64
		if json.Unmarshal(w.Value, &v) != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			return Event{}, false
		}
		lo, hi, _, _ := el.numberRange()
		ev.Number = math.Max(lo, math.Min(hi, v))
	case ElemInput:
		var text string
		if json.Unmarshal(w.Value, &text) != nil {
			return Event{}, false
		}
		ev.Text = truncateRunes(text, inputLength(el.MaxLength))
	case ElemButton:
	}
	return ev, true
}

// pickCount is how many items an element wants chosen: Pick, within 1-3
// and no more than it offers (pickCount in src/shared/protocol.ts).
func (e *Element) pickCount() int {
	n := len(e.Cards) + len(e.Options)
	return max(1, min(MaxPick, e.Pick, max(n, 1)))
}

// inputLength is an input's effective character limit.
func inputLength(n int) int {
	if n <= 0 || n > MaxInputLength {
		return MaxInputLength
	}
	return n
}

// truncateRunes cuts s to at most n characters (not bytes).
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// maxEventN is the highest event counter the relay accepts.
const maxEventN = 1 << 31

// eventSessionsKept is how many event sessions a host remembers per seat.
// A reload starts a new session; remembering the last few means a late copy
// from a retired page meets its own history instead of looking new.
const eventSessionsKept = 4

// sessionWindow is one event session's history: the highest counter seen
// and which of the 64 below it have been.
type sessionWindow struct {
	session string
	high    int64
	seen    uint64 // bit i: high-i has been seen
}

// accept reports whether n is new in this session, and records it.
func (w *sessionWindow) accept(n int64) bool {
	if w.high == 0 || n > w.high {
		shift := n - w.high
		if w.high == 0 || shift >= 64 {
			w.seen = 0
		} else {
			w.seen <<= uint(shift)
		}
		w.high = n
		w.seen |= 1
		return true
	}
	back := w.high - n
	if back >= 64 || w.seen&(1<<uint(back)) != 0 {
		return false
	}
	w.seen |= 1 << uint(back)
	return true
}

// eventWindow de-duplicates one seat's screen events. Each carries a
// counter n within an event session s (one per phone page load). Copies
// arrive twice (data channel and relay), retried until acknowledged, out of
// order and across reconnects, so it keeps a window per session for the
// last eventSessionsKept sessions used: switching sessions never resets
// another's history. A fixed array, not a slice, so Pad stays comparable.
// EventWindow in src/shared/protocol.ts matches.
type eventWindow struct {
	sessions [eventSessionsKept]sessionWindow
	used     [eventSessionsKept]uint64 // when each slot was last used; 0 = empty
	clock    uint64
}

// accept reports whether (s, n) is new, and records it.
func (w *eventWindow) accept(s string, n int64) bool {
	if n <= 0 || n > maxEventN {
		return false
	}
	w.clock++
	slot, oldest := -1, 0
	for i := range w.sessions {
		if w.used[i] != 0 && w.sessions[i].session == s {
			slot = i
			break
		}
		if w.used[i] < w.used[oldest] {
			oldest = i
		}
	}
	if slot < 0 { // a session we don't remember: take the least recently used slot
		slot = oldest
		w.sessions[slot] = sessionWindow{session: s}
	}
	w.used[slot] = w.clock
	return w.sessions[slot].accept(n)
}

// Text limits, as cleanScreen applies them (characters).
const (
	maxHeading     = 80
	maxText        = 280
	maxStatus      = 80
	maxOptionText  = 60
	maxLabel       = 24 // button labels and submit labels
	maxPlaceholder = 60
	maxCountdown   = 3600
)

// hexColor is what colour fields may hold.
var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{3,8}$`)

// plainText drops control characters other than newline and cuts s to n
// characters, as the relay does.
func plainText(s string, n int) string {
	s = strings.Map(func(r rune) rune {
		if (r < 0x20 && r != '\n') || r == 0x7f {
			return -1
		}
		return r
	}, s)
	return truncateRunes(s, n)
}

// normalize returns the screen exactly as the relay will pass it on (the
// rules of cleanScreen in src/shared/protocol.ts): unknown types, bad or
// repeated ids and empty elements dropped, lists and text cut to their
// limits, picks and numbers clamped. Events are checked against this, so a
// game is held to what its players were actually shown. It returns nil if
// the relay would refuse the screen outright (a bad id).
func (s *Screen) normalize() *Screen {
	if s == nil || !validID(s.ID, maxScreenIDLen) {
		return nil
	}
	out := &Screen{ID: s.ID, Locked: s.Locked, Items: []Element{}}
	ids := map[string]bool{}
	items := s.Items
	if len(items) > MaxScreenItems {
		items = items[:MaxScreenItems]
	}
	for _, in := range items {
		e := Element{Type: in.Type}
		if interactive(in.Type) {
			if !validID(in.ID, maxElementIDLen) || ids[in.ID] {
				continue
			}
			ids[in.ID] = true
			e.ID, e.Disabled = in.ID, in.Disabled
		}
		submit := plainText(in.Submit, maxLabel)
		switch in.Type {
		case ElemHeading, ElemText, ElemStatus:
			limit := map[string]int{ElemHeading: maxHeading, ElemText: maxText, ElemStatus: maxStatus}[in.Type]
			e.Text = plainText(in.Text, limit)
			if in.Type == ElemStatus {
				if in.Seconds > 0 && !math.IsInf(in.Seconds, 0) {
					e.Seconds = math.Min(maxCountdown, in.Seconds)
				}
				if in.Progress > 0 && !math.IsInf(in.Progress, 0) {
					e.Progress = math.Min(1, in.Progress)
				}
			}
			if e.Text == "" && e.Seconds == 0 && e.Progress == 0 {
				continue
			}
		case ElemCards:
			seen := map[string]bool{}
			cards := in.Cards // cut before filtering, as the relay does
			if len(cards) > MaxCards {
				cards = cards[:MaxCards]
			}
			for _, c := range cards {
				if !validID(c.ID, maxElementIDLen) || seen[c.ID] {
					continue
				}
				seen[c.ID] = true
				e.Cards = append(e.Cards, Card{ID: c.ID, Text: plainText(c.Text, MaxCardText)})
			}
			if len(e.Cards) == 0 {
				continue
			}
			e.Pick, e.Submit = max(1, min(MaxPick, in.Pick, len(e.Cards))), submit
		case ElemChoices:
			seen := map[string]bool{}
			options := in.Options // cut before filtering, as the relay does
			if len(options) > MaxOptions {
				options = options[:MaxOptions]
			}
			for _, o := range options {
				if !validID(o.ID, maxElementIDLen) || seen[o.ID] {
					continue
				}
				seen[o.ID] = true
				opt := Option{ID: o.ID, Text: plainText(o.Text, maxOptionText)}
				if o.Pad != nil && *o.Pad >= 0 && *o.Pad < 64 {
					opt.Pad = Seat(*o.Pad)
				}
				if hexColor.MatchString(o.Color) {
					opt.Color = o.Color
				}
				e.Options = append(e.Options, opt)
			}
			if len(e.Options) == 0 {
				continue
			}
			e.Pick, e.Submit = max(1, min(MaxPick, in.Pick, len(e.Options))), submit
		case ElemStepper, ElemSlider:
			e.Min, e.Max, e.Step, e.Value = in.numberRange()
			e.Submit = submit
		case ElemInput:
			e.MaxLength, e.Placeholder, e.Submit = inputLength(in.MaxLength), plainText(in.Placeholder, maxPlaceholder), submit
		case ElemButton:
			e.Label = plainText(in.Label, maxLabel)
			if e.Label == "" {
				e.Label = "OK"
			}
			if hexColor.MatchString(in.Color) {
				e.Color = in.Color
			}
		default:
			continue
		}
		out.Items = append(out.Items, e)
	}
	return out
}
