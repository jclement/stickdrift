# StickDrift protocol, version 1

A **host** (the game) opens a room; **pads** (phones) join it. Everything goes
through `wss://stickdrift.net`, where each room is a Durable
Object located near whoever opened it.

## Room codes

Five letters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (no I or O). The host picks one at
random. Phones join at `https://stickdrift.net/j/CODE`; put that
URL in a QR code.

## Host connection

```
GET wss://stickdrift.net/ws/host/CODE?key=SECRET
```

`SECRET` is 16-128 characters the host makes up. The first host to connect
claims the code; reconnecting with the same key reclaims it (pads stay put).
A different key gets **HTTP 409**: pick another code. A claim lapses 30
minutes after the host disconnects; an unhosted room is wiped after 6 hours.

### Host -> relay (JSON text)

| Message | Meaning |
|---|---|
| `{"t":"config","title":"My Game","maxPads":16,"open":true,"look":{…}}` | Room settings. `look` is the default for every pad. `open:false` refuses new phones (known phones can still reconnect). All fields optional. |
| `{"t":"pad","pad":3, …look fields…}` | Change one pad's look. |
| `{"t":"haptic","pad":3,"ms":40}` | Vibrate a phone. `ms` may be a pattern array. Android only; iOS ignores it. |
| `{"t":"kick","pad":3}` | Disconnect a phone and forget its seat. |
| `{"t":"ack","pad":3,"n":7,"s":"…"}` | Acknowledge a screen event (see [Screens](#screens)). |
| `{"t":"ping"}` | Answered with `{"t":"pong"}` (exact strings) for round-trip timing. |

### Relay -> host

| Message | Meaning |
|---|---|
| `{"t":"welcome","code":"ABCDE","joinUrl":"https://…/j/ABCDE","version":1,"pads":[…]}` | Connected. `pads` lists phones already in the room. |
| `{"t":"join","pad":3,"device":"…","rejoin":false}` | A phone took seat 3. `rejoin` is true when this phone had the seat before. |
| `{"t":"leave","pad":3}` | Seat 3's phone disconnected. Treat everything as released. |
| `{"t":"rtt","pad":3,"ms":31}` | That phone's measured round trip to the relay. |
| `{"t":"event","pad":3,"n":7,"screen":"r1","element":"hand","value":["c2"]}` | A player answered a screen (see [Screens](#screens)). Only sent to a host that has given that pad a screen. |
| 16 bytes, binary | An input frame (below). |

## Pad connection

```
GET wss://stickdrift.net/ws/pad/CODE?device=DEVICEID
```

`DEVICEID` is 8-64 characters `[A-Za-z0-9_-]`, stable per phone, so a
reconnect gets the same seat. The relay replies with `setup` (seat number and
look) and `host` (whether the game is connected). Close codes: 4001 replaced
by a newer connection from the same phone, 4002 kicked, 4003 room full, 4004
no such room.

## Input frames (binary, 16 bytes, little endian)

| Offset | Type | Field |
|---|---|---|
| 0 | u8 | kind, always 1 |
| 1 | u8 | pad number (the relay overwrites this; phones send 0) |
| 2 | u16 | sequence, increments per frame, wraps |
| 4 | u32 | buttons bitmask |
| 8 | i8 ×4 | lx, ly, rx, ry: sticks, -127..127 (y is down) |
| 12 | i16 ×2 | px, py: touchpad pointer, accumulated, wraps at 16 bits |

Every frame is the **complete** state, sent whenever it changes. A held
button is simply a bit that stays set. To detect presses shorter than your
frame, latch rising edges as frames arrive (the JS SDK's `poll()` does).

Button bits: Up 0, Down 1, Left 2, Right 3, A 4, B 5, X 6, Y 7, L 8, R 9,
Start 10, Select 11.

Analog sticks driving movement (`stick-ab`, `gamepad`, the left stick of
`twin-stick`, `tilt`) also set the d-pad bits (8-way, past half deflection),
so a game that only reads the d-pad works with every layout.

## Peer-to-peer (WebRTC), relay as fallback

If the host's `config` includes `"p2p": true`, phones (told via
`setup.p2p`) offer a WebRTC data channel named `input`, **unordered with no
retransmits**, and input goes over it whenever it is open; the relay
WebSocket stays up for setup, control messages and as the fallback.

Signalling rides the relay:

| Direction | Message |
|---|---|
| pad -> host | `{"t":"signal","pad":3,"data":{"type":"offer","sdp":"…"}}` |
| host -> pad | `{"t":"signal","pad":3,"data":{"type":"answer","sdp":"…"}}` |
| both | `{"t":"signal",…,"data":{"type":"candidate","candidate":{…RTCIceCandidateInit…}}}` (`null` = end of candidates) |

(The pad sends without `pad`; the relay adds it.) STUN is
`stun:stun.cloudflare.com:3478`; there is no TURN, because the relay already is
the fallback. Browsers advertise LAN addresses as mDNS `.local` names, so a
host must resolve those.

On the data channel:

- Input frames are the same 16 bytes; byte 1 (pad) is 0, the host knows the
  pad from the connection.
- Phones repeat each change ~25 and ~80 ms later and re-send the current
  snapshot every 250 ms, so lost packets can't leave a button stuck. Hosts
  must ignore any frame whose `seq` is not newer than the last one applied
  (16-bit wrap-aware: newer if `(a - b) & 0xffff` is in 1..32767), and reset
  that tracking when a pad (re)joins.
- `[2, 0, 0, 0, u32 timestamp]` (8 bytes) is a ping: echo it back unchanged.
- A **text** message is a screen event (below), without `pad`. Hosts that
  don't use screens can ignore text; they never receive any.

## Looks

A look is any subset of:

```json
{
  "layout": "dpad-ab",
  "label": "PLAYER 1",
  "color": "#e63946",
  "labels": { "A": "BOMB", "B": "ACTION" },
  "message": "Waiting for round 2",
  "swap": true,
  "diagonals": false,
  "theme": { "style": "retro", "font": "pixel", "shape": "square", "background": "#1a1423", "text": "#fdf6e3" },
  "custom": { "orientation": "landscape", "controls": [ … ] },
  "avatar": "data:image/png;base64,…",
  "banner": "RED"
}
```

- `avatar`: a base64 PNG data URL of at most 24 KB, shown in the phone's HUD
  chip and large, pixelated and faded behind the controls. Use it to show the
  player who they are (Kaboom sends the player's own sprite). Anything that
  is not a PNG data URL is dropped.
- `banner`: up to 16 characters of big faded text behind the controls.
- Looks can change at any time. A game typically sends a lobby look (READY,
  colour picker), a gameplay look, a spectator look and a between-rounds
  look; the phone rebuilds instantly and releases anything held.

- `layout`: `dpad-ab`, `stick-ab`, `arcade`, `gamepad`, `twin-stick`,
  `buzzer`, `quiz`, `paddle`, `tilt`, `touchpad`, `custom`, `screen`.
- `swap`: lets the player flip between the d-pad and stick versions
  (`dpad-ab` ⇄ `stick-ab`, `arcade` ⇄ `gamepad`).
- `diagonals: false`: a 4-way d-pad, for grid games.
- `theme.style`: `glass` (default), `neon`, `flat`, `retro`, `candy`.
  `font`: `display`, `sans`, `mono`, `pixel`. `shape`: `round`, `rounded`,
  `square`. Colours are hex only: hosts restyle phones, they can't inject CSS.

### Custom layouts

`custom.controls` is up to 32 controls:

| Field | Meaning |
|---|---|
| `type` | `button`, `pill`, `shoulder`, `tile`, `buzzer`, `dpad`, `stick`, `slider`, `touchpad` |
| `x`, `y` | centre, as fractions of screen width and height |
| `size` | diameter as a fraction of the short edge (buttons, d-pads, sticks) |
| `w`, `h` | fractions of width and height (tiles, sticks' touch zones, sliders, touchpads) |
| `button` | which bit it sets (buttons, pills, shoulders, tiles, buzzers) |
| `label`, `color`, `solid` | appearance |
| `side` | `left`/`right`: which stick axes a stick drives |
| `floating` | stick recentres under the thumb (default true) |
| `dpad` | stick also sets d-pad bits (default true for the left stick) |
| `diagonals` | 8-way d-pad (default true) |

A custom layout can be previewed with no room at
`/j?preview=custom#layout=<base64url of the JSON>`.

### Screens

`layout: "screen"` shows a scrolling page instead of controls, described by
`look.screen`:

```json
{ "id": "r1", "locked": false, "items": [
  { "type": "heading", "text": "Pick one" },
  { "type": "cards", "id": "hand", "pick": 1, "submit": "PLAY", "cards": [{ "id": "c1", "text": "…" }] },
  { "type": "choices", "id": "vote", "pick": 1, "options": [{ "id": "p2", "text": "Ann", "pad": 2, "color": "#3a86ff" }] },
  { "type": "stepper", "id": "bet", "min": 0, "max": 100, "step": 5, "value": 10, "submit": "BET" },
  { "type": "slider", "id": "spice", "min": 0, "max": 10, "step": 1, "value": 5 },
  { "type": "input", "id": "answer", "maxLength": 80, "placeholder": "…", "submit": "SEND" },
  { "type": "button", "id": "ready", "label": "READY", "color": "#38d996" },
  { "type": "status", "text": "Waiting…", "seconds": 30, "progress": 0.5 }
] }
```

Limits (the relay and the phone enforce them; extra items are dropped,
text is cut, numbers clamped): `id` 1-64 of `[A-Za-z0-9_-]`; element, card
and option ids 1-32 of the same, unique; 24 items; 12 cards of 140
characters; 16 options of 60; `pick` 1-3; heading 80, text 280, status 80,
labels and `submit` 24, placeholder 60; `maxLength` 1-80; numbers within
±1,000,000; `seconds` up to 3600; `progress` 0..1. Every interactive element
may carry `disabled: true`. Everything is plain text. In a `pad` message,
`"screen": null` removes that pad's own screen, so the room's shows again.
For choices with `pad`, the relay adds that pad's `color` (unless given)
and `avatar` before sending the screen to phones.

**Events.** When a player answers, the phone sends

```json
{"t":"event","s":"k3j9x0q1","n":7,"screen":"r1","element":"hand","value":["c2"]}
```

`value`: cards and choices, the chosen ids in order (exactly `pick` of
them); stepper and slider, a number; input, a string; button, absent. `s`
names the phone page's event session (1-32 of `[A-Za-z0-9_-]`, new on every
page load) and `n` counts up from 1 within it (at most 2^31).

**Delivery.** The phone sends each event over the data channel (if open)
and the relay, and keeps it until it is acknowledged with
`{"t":"ack","n":7,"s":"…"}`, matching **both** `s` and `n` (counters restart
with every page, so an ack for another session's `n` clears nothing; a
missing `s` counts as `""`). Acks always echo the event's `s`. The **host** acknowledges every event it
receives: on the data channel by sending that text back on it, and from the
relay by sending `{"t":"ack","pad":3,"n":7,"s":"…"}` to the relay, which
passes it to that phone. The relay acknowledges only events it refuses
(stale or invalid: they will never be wanted). With no host connected
nothing is acknowledged, so the answer survives a game restart. Until
acknowledged, the phone resends each event on its own backoff: on the
channel after 250 ms, then 500 ms, 1 s, 2 s and every 4 s; on the relay
after 3 s, then 6 s and every 10 s, and at once whenever the relay
reconnects. It keeps at most 32 unacknowledged events (the oldest go
first). The relay forwards it, with
`pad` added and the value cleaned, only if it answers the screen that pad
shows now (`screen` matches, the element exists, is interactive and
enabled, the screen isn't locked, the value fits the element); it never
forwards events for a pad whose layout isn't `screen`.

Hosts must apply the same check to events from the data channel, and must
drop copies, which arrive by both paths, retried, out of order and across
reconnects: keep, per pad and per session `s` (for the last 4 sessions
seen), the highest `n` and which of the 64 below it have been; accept an
`n` once. A reconnect changes nothing, and a late copy from an older page
meets its own session's history rather than resetting anyone's. Check
the screen against the screen as the relay normalised it (the rules
above), which is what the phone shows.

Re-sending a screen with the same `id` keeps the player's picks and typed
text on the phone. An element that has sent an event locks until a screen
with a new `id` arrives (steppers and sliders without `submit` send live
and never lock).
