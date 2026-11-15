# Controller protocol, version 1

A **host** (the game) opens a room; **pads** (phones) join it. Everything goes
through `wss://controller.onewheelgeek.net`, where each room is a Durable
Object located near whoever opened it.

## Room codes

Five letters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (no I or O). The host picks one at
random. Phones join at `https://controller.onewheelgeek.net/j/CODE`; put that
URL in a QR code.

## Host connection

```
GET wss://controller.onewheelgeek.net/ws/host/CODE?key=SECRET
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
| `{"t":"ping"}` | Answered with `{"t":"pong"}` (exact strings) for round-trip timing. |

### Relay -> host

| Message | Meaning |
|---|---|
| `{"t":"welcome","code":"ABCDE","joinUrl":"https://…/j/ABCDE","version":1,"pads":[…]}` | Connected. `pads` lists phones already in the room. |
| `{"t":"join","pad":3,"device":"…","rejoin":false}` | A phone took seat 3. `rejoin` is true when this phone had the seat before. |
| `{"t":"leave","pad":3}` | Seat 3's phone disconnected. Treat everything as released. |
| `{"t":"rtt","pad":3,"ms":31}` | That phone's measured round trip to the relay. |
| 16 bytes, binary | An input frame (below). |

## Pad connection

```
GET wss://controller.onewheelgeek.net/ws/pad/CODE?device=DEVICEID
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
  "custom": { "orientation": "landscape", "controls": [ … ] }
}
```

- `layout`: `dpad-ab`, `stick-ab`, `arcade`, `gamepad`, `twin-stick`,
  `buzzer`, `quiz`, `paddle`, `tilt`, `touchpad`, `custom`.
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
