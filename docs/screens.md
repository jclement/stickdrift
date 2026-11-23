# Screens

Game pads are wrong for some games. A private hand of text cards, a vote, a
bet or a typed answer wants a little app page, not a d-pad. Set
`layout: "screen"` and send a `screen`: the phone shows a normal, scrolling
portrait page in the player's colour and theme, and sends you an **event**
when the player answers. Buttons and sticks still work: one pad can be on a
screen while another holds a controller, and a game can switch a phone
between the two at any time.

```screen
{
  "id": "round3-hand",
  "items": [
    { "type": "text", "text": "Round 3 · Ann is the judge" },
    { "type": "heading", "text": "The worst thing to hear from your dentist: ____" },
    { "type": "cards", "id": "hand", "pick": 1, "submit": "PLAY IT", "cards": [
      { "id": "c1", "text": "\"I learned this on YouTube.\"" },
      { "id": "c2", "text": "A surprising amount of glitter." },
      { "id": "c3", "text": "Hold still, this is my first time." }
    ] },
    { "type": "status", "text": "Waiting for 3 players…", "seconds": 45 }
  ]
}
```

Send it per pad for private hands, or in the room's look for everyone:

```js
host.setPad(2, { layout: "screen", screen: hand });
// once per frame
for (const ev of host.events()) {
  if (ev.element === "hand") play(ev.pad, ev.value); // ["c2"]
}
```

```go
host.SetPad(2, stickdrift.Look{Layout: "screen", Screen: hand})
// once per frame, after Tick
for _, ev := range host.Events() {
	if ev.Element == "hand" {
		play(ev.Pad.Number(), ev.Picks) // ["c2"]
	}
}
```

## Screen ids

Every screen has an `id` (1-64 of `A-Z a-z 0-9 _ -`), and every event names
the screen it was answered on. The host libraries (and the relay) **drop
events for a screen that is no longer that pad's current one**, so a tap
from last round that arrives late can never count. Give each new question
a new id (`round3-hand`, `round3-vote`).

Sending a screen with the **same id** again is a re-render, not a reset:
what the player has picked, typed or dialled in is kept, and a text box
keeps its keyboard. Use it to update a status line ("Waiting for 2
players…"), or to lock the page.

A pad's own screen (`setPad`) wins over the room's (`setLook`). To send a
pad back to the room's screen, set its `screen` to `null` (Go:
`Look{Clear: []string{"screen"}}`).

## Elements

`items` is a list of up to 24 elements, shown top to bottom.
Interactive ones need an `id`, unique on the screen.

| `type` | What | Fields |
|---|---|---|
| `heading` | Big text: the question, the prompt | `text` (80) |
| `text` | A paragraph; newlines are kept | `text` (280) |
| `cards` | Text cards to pick from, in a grid | `id`, `cards: [{id, text}]` (12 cards, 140 characters each), `pick` (1-3), `submit` |
| `choices` | A list of answers or players | `id`, `options: [{id, text, pad?, color?}]` (16 options, 60 characters), `pick` (1-3), `submit` |
| `stepper` | − value + | `id`, `min`, `max`, `step`, `value`, `submit` |
| `slider` | A slider with its value shown | `id`, `min`, `max`, `step`, `value`, `submit` |
| `input` | A text box | `id`, `maxLength` (1-80, default 80), `placeholder`, `submit` (default `SEND`) |
| `button` | Ready, skip, next | `id`, `label` (24), `color` |
| `status` | A quiet line, with an optional bar | `text` (80), `seconds` (a countdown bar from when the phone shows it) or `progress` (0..1) |

Any interactive element can carry `disabled: true`. The whole screen can
carry `locked: true`: everything is greyed out and nothing sends, which is
how you say "Locked in. The judge is thinking…".

A choice with `pad` shows that player's colour and avatar beside it (the
relay fills them in from the pad's look), which is what a vote for a
player wants. `color` sets a swatch of your own.

```screen
{
  "id": "vote",
  "items": [
    { "type": "heading", "text": "Who played the worst card?" },
    { "type": "choices", "id": "vote", "options": [
      { "id": "ann", "text": "Ann", "color": "#3a86ff" },
      { "id": "bo", "text": "Bo", "color": "#ffbe0b" },
      { "id": "cy", "text": "Cy", "color": "#38d996" }
    ] },
    { "type": "stepper", "id": "bet", "min": 0, "max": 100, "step": 10, "value": 20, "submit": "BET" },
    { "type": "input", "id": "answer", "maxLength": 40, "placeholder": "A better answer" },
    { "type": "button", "id": "done", "label": "DONE", "color": "#38d996" }
  ]
}
```

## When events are sent

- **cards, choices**: when `pick` items are chosen; with `submit`, when its
  button is pressed instead (players can change their mind until then).
  With `pick` above 1 the order matters and is shown.
- **input**: when its button (or Enter) is pressed, if not blank.
- **button**: when tapped.
- **stepper, slider** with `submit`: when the button is pressed. Without
  one they send live: a stepper once the taps settle, a slider when let go.

After sending, the element **locks** ("LOCKED IN") until a screen with a
new id arrives, so a double tap can't answer twice. Live steppers and
sliders never lock.

| Element | `value` (JS) | Go `Event` field |
|---|---|---|
| `cards`, `choices` | the chosen ids, in order: `["c3", "c1"]` | `Picks` |
| `stepper`, `slider` | a number, within `min`..`max` | `Number` |
| `input` | the text, at most `maxLength` characters | `Text` |
| `button` | none | |

Typed text is the player's: treat it as **plain text** and never put it
into markup.

## Safety

Answers are delivered reliably: the phone keeps each one, resending it,
until the relay or the game acknowledges it, and the host libraries count
each answer once however many copies arrive (also across reconnects).

Screens are validated like custom layouts, on the relay and again on the
phone: unknown element types and fields are dropped, text is cut to the
limits above, numbers are clamped, and everything is rendered as plain text
(no HTML). Events are checked on the relay and again by the host libraries
(they may also arrive straight over the peer-to-peer channel): the screen
must be current, the element must exist and be enabled, picks must be that
element's ids, numbers are clamped and text is cut.

## Previews

`/j?preview=screen` shows a sample screen, and
`/j?preview=screen#layout=<base64url of the screen JSON>` shows yours,
tappable: instead of sending, it shows what it would have sent. The
[layout designer](/designer) has a screen editor with a live preview.
