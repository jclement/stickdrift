# SDKs

Two host libraries wrap the protocol, peer-to-peer WebRTC included. Both
give you the same model: open a room, set looks, and read each pad once per
game frame with latched presses. Pick the one in the language you were
going to use anyway.

## JavaScript (browser)

An ES module served by the relay itself, so there is nothing to install and
it always matches the relay it talks to:

```js
import { StickDriftHost, pressed, held } from "https://stickdrift.net/sdk.js";
```

The module connects back to the origin it was loaded from; pass `origin` to
use another relay. Everything in the protocol module (`Button`, `LAYOUTS`,
`PadLook`, `Theme`, `CustomLayout`, `encodeFrame`…) is exported too.
`ControllerHost` is a deprecated alias of `StickDriftHost`.

### `new StickDriftHost(options)`

| Option | Default | Meaning |
|---|---|---|
| `title` | `""` | Room title, shown on the phones |
| `look` | `{}` | The default [look](/docs#concepts) for every pad |
| `maxPads` | `16` | Seats in the room (1-64) |
| `open` | `true` | Accept new phones (known phones can always rejoin) |
| `p2p` | `true` when the browser has WebRTC | Accept WebRTC data channels from phones |
| `code`, `key` | random | Reuse a room after a reload (see [Hosts](/docs#concepts-hosts)) |
| `origin` | the script's origin | Which relay to use, e.g. `http://192.168.1.20:8787` |

The room opens at once. If the relay socket drops, the host reconnects by
itself with the same code and key: phones stay seated, phones on P2P keep
sending, and relay-only phones have their buttons released until it's back.
If another host takes the room with the same key, this one stops (an
`error` event with code `"replaced"`) rather than fight over it.

### Events

```js
host.on("open", (code, joinUrl) => {});   // room is live: show joinUrl as a QR code
host.on("join", (pad, rejoin) => {});     // a phone took seat pad.pad (rejoin: same phone as before)
host.on("leave", (pad) => {});            // it went; everything it held is released
host.on("input", (pad, prev) => {});      // a frame arrived (optional: poll() is usually better)
host.on("rtt", (pad) => {});              // pad.rtt / pad.via changed
host.on("p2p", (pad) => {});              // pad.p2p changed: a data channel came up or went down
host.on("close", () => {});               // relay socket dropped; reconnecting
host.on("error", (code, message) => {});  // code "replaced": another host took the room
```

`host.off(event, fn)` removes a listener.

### Reading input

Call `poll()` once per frame. It returns a `Map` from seat number to:

| Field | Meaning |
|---|---|
| `pad` | Seat number |
| `state` | The latest snapshot: `buttons`, `lx ly rx ry` (-1..1, y down), `px py` |
| `held` | Bitmask of buttons down right now |
| `pressed` | Bitmask of buttons that went down since the last `poll()`, **latched** |
| `released` | Bitmask of buttons that came up since the last `poll()` |
| `connected` | Whether the phone is in the room right now |
| `p2p`, `rtt`, `via` | Whether a data channel is open, the round trip in ms, and the path the phone reports (`"p2p"` or `"relay"`) |

The helpers `pressed(p, "A")`, `held(p, "A")` and `released(p, "A")` read
those masks by button name (an undefined entry reads as false), and
`down(mask, "A")` tests any mask:

```js
for (const [n, p] of host.poll()) {
  if (pressed(p, "A")) jump(n);      // a tap, even one shorter than a frame
  if (held(p, "Left")) walkLeft(n);  // held right now
  steer(n, p.state.lx);
}
```

Use `pressed` for actions (jump, fire, select) and `held` for continuous
things (walking, charging). Reading `held` alone misses taps that start and
end between two frames.

### Commands

| Method | What |
|---|---|
| `setLook(look)` | Change the default look for every pad (remembered across reconnects) |
| `setPad(n, look)` | Change one pad's look. Merged over what it had: `setPad(0, { label: "RED" })` changes only the label |
| `haptic(n, ms)` | Vibrate a phone: a number or a pattern array (Android only) |
| `kick(n)` | Disconnect a phone and free its seat |
| `setOpen(open)` | Allow or refuse new phones |
| `close()` | Close the room and every peer connection, for good |

### State

`host.code`, `host.key`, `host.joinUrl` (`""` until open), `host.online`
(relay socket up), `host.hostRtt` (ms to the relay), and `host.pads`, a
`Map` of every seat seen this session with `connected`, `state`, `rtt`,
`via`, `p2p` and `frames`. A returning phone gets the same `Pad` object back.

### TypeScript

Types are published at `/sdk.d.ts`. Download it next to your code and map
the URL to it in `tsconfig.json`:

```json
{ "compilerOptions": { "paths": { "https://stickdrift.net/sdk.js": ["./sdk.d.ts"] } } }
```

A complete browser game is `examples/web-pong` in the repository: a
single HTML file, Pong for two or more phones on the paddle layout.

## Go

Module `github.com/jclement/stickdrift/go`, package `stickdrift`.
WebSocket via `github.com/coder/websocket`, WebRTC via
`github.com/pion/webrtc/v4`, so P2P works from a native game too.

```sh
go get github.com/jclement/stickdrift/go
```

```go
host := stickdrift.NewHost(stickdrift.Options{
	Title: "My Game",
	Look:  stickdrift.Look{Layout: "stick-ab", Color: "#ff4d6d"},
})
host.Start(ctx) // connects in the background; reconnects by itself
defer host.Close()
<-host.Ready()  // closed once the room is online
fmt.Println("join at", host.Info().JoinURL) // draw this as a QR code

for !quit { // your game loop
	host.Tick() // once per frame, before reading pads
	for _, p := range host.Joined() {
		host.SetPad(p.Number(), stickdrift.Look{Label: fmt.Sprintf("PLAYER %d", p.Number()+1)})
	}
	for _, p := range host.Pads() {
		if p.JustPressed(stickdrift.A) { jump(p.Number()) }
		if p.Held(stickdrift.Left)     { walkLeft(p.Number()) }
		x, y := p.Stick()              // left stick, -1..1 (y down)
		_, _ = x, y
	}
}
```

The network runs on background goroutines and every method is safe from
any goroutine. Pad state changes only at `Tick`, so every read within one
frame agrees.

### Host

| API | What |
|---|---|
| `NewHost(opts)` | Prepare a room; nothing touches the network until `Start` |
| `host.Start(ctx)` | Open the room in the background and keep it connected until `ctx` ends or `Close` |
| `host.Ready()` | Channel closed once the room is first online |
| `host.Info()` | `Code`, `JoinURL`, `Status` (`StatusOff/Connecting/Online/Error`), `Err`, `RTT` |
| `host.Key()` | The host secret: save it with the code to reclaim the room later |
| `host.Tick()` | Publish every pad's latest state and the edges latched since the last tick |
| `host.Pads()` | Pads in the room now, by seat |
| `host.Pad(n)` | Seat `n`, or nil if no phone has sat there this session |
| `host.Joined()` / `host.Left()` | Pads that arrived / went since the last call (a returning phone is the same `*Pad`) |
| `host.SetLook(look)` | Default look for every pad |
| `host.SetPad(n, look)` | One pad's look; zero fields keep their value |
| `host.Haptic(n, ms...)` | Vibrate a phone: one duration or an on/off pattern (Android) |
| `host.Kick(n)`, `host.SetOpen(open)` | Remove a phone; allow or refuse new ones |
| `host.Close()` | Shut the room and wait for the goroutines |

`Options`: `Origin` (default `$STICKDRIFT_URL`, else `https://stickdrift.net`),
`Code`, `Key`, `Title`, `MaxPads`, `Look`, `DisableP2P`, `ICEServers`,
`Logger` (or set `STICKDRIFT_DEBUG`), `UserAgent`. If another host takes the
room with your key, `Info().Err` is `stickdrift.ErrReplaced` and this one
stops.

### Pad

| API | What |
|---|---|
| `p.Number()` | Seat, 0-based; show players `Number()+1` |
| `p.Held(b)` | Down at the last `Tick` |
| `p.JustPressed(b)` / `p.JustReleased(b)` | Went down / up between the last two ticks (latched: never misses a tap) |
| `p.Stick()` / `p.RightStick()` | `x, y` in -1..1, y down. The paddle slider and tilt steering report on `Stick` |
| `p.Pointer()` | Touchpad pointer, accumulated `int16`s that wrap: use differences between ticks |
| `p.State()` | The whole snapshot |
| `p.Connected()`, `p.P2P()`, `p.Via()`, `p.RTT()` | In the room; direct channel open; path the phone reports; round trip in ms |
| `p.Device()`, `p.Frames()` | Stable device id; frames applied |

Buttons are `stickdrift.Up … stickdrift.Select` (`stickdrift.Buttons` lists
them in bit order); `stickdrift.Layouts` lists the layout ids.

### Look

`stickdrift.Look` carries every look field: `Layout`, `Label`, `Color`,
`Labels` (`map[stickdrift.Button]string`, e.g. `{stickdrift.A: "BOMB"}`),
`Message`, `Swap` and `Diagonals` (pointers: `stickdrift.Bool(false)`),
`Theme`, `Custom` (`*stickdrift.CustomLayout` of `Control`s; set a control's
button with `stickdrift.Btn(stickdrift.A)`), `Avatar` and `Banner`.

Because zero fields are left out, blanking a text field needs `Clear`:
`stickdrift.Look{Clear: []string{"message"}}` sends `"message": ""`.
`stickdrift.AvatarPNG(pngBytes)` builds the avatar data URL, or tells you
why the relay would drop it.

A complete host is `examples/go-terminal` in the repository: it opens a
room, prints the QR code in the terminal and logs every phone's input.

For a full game on the Go library, play [KABOOM!](https://kaboom.stickdrift.net):
a couch bomb game in Go (Ebitengine), running natively and as WebAssembly in the
browser, with per-phase custom layouts, avatars and haptics. Or
[SKIDMARK!](https://skidmark.stickdrift.net), an overhead racer that steers
with a custom-layout analogue stick, or
[BRAINFART!](https://brainfart.stickdrift.net), a quiz show whose phones swap
between answer tiles, true/false buttons and a lobby mode switch, or
[SPACEJUNK!](https://spacejunk.stickdrift.net), an Asteroids-style dogfight on
four tiles (rotate, rotate, thrust, fire) that relabel themselves for ghosts.

## Other languages

The protocol is small: one WebSocket, a handful of JSON messages, and a
16-byte binary frame. Peer-to-peer is optional; without it everything rides
the relay. See [Protocol](/docs#protocol).
