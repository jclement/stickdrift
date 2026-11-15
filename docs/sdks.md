# SDKs

Two host libraries wrap the protocol, peer-to-peer WebRTC included. Both
give you the same model: open a room, set looks, and read each pad once per
game frame with latched presses.

## JavaScript (browser)

An ES module served by the relay itself, so there is nothing to install:

```js
import { ControllerHost, Button, down } from "https://stickdrift.net/sdk.js";
```

The module connects back to the origin it was loaded from. To use a local
relay, pass `origin`.

### `new ControllerHost(options)`

| Option | Default | Meaning |
|---|---|---|
| `title` | `""` | Room title, shown on the phones |
| `look` | `{}` | The default [look](/docs#concepts) for every pad |
| `maxPads` | `16` | Seats in the room (1-64) |
| `p2p` | `true` | Accept WebRTC data channels from phones |
| `code`, `key` | random | Reuse a room after a reload (see [Hosts](/docs#concepts-hosts)) |
| `origin` | the script's origin | Which relay to use, e.g. `http://192.168.1.20:8787` |

The host connects at once and reconnects by itself (with backoff) if the
socket drops; phones keep their seats.

### Events

```js
host.on("open", (code, joinUrl) => {});   // room is live: show joinUrl as a QR code
host.on("join", (pad, rejoin) => {});     // a phone took seat pad.pad
host.on("leave", (pad) => {});            // it went; everything is released
host.on("input", (pad, prev) => {});      // a frame arrived (optional: poll() is usually better)
host.on("rtt", (pad) => {});              // pad.rtt and pad.via updated
host.on("close", () => {});               // relay socket dropped; reconnecting
host.on("error", (code, message) => {});
```

### Reading input

Call `poll()` once per frame. It returns a `Map` from seat number to:

| Field | Meaning |
|---|---|
| `state` | The latest snapshot: `buttons`, `lx ly rx ry` (-1..1, y down), `px py` |
| `held` | Bitmask of buttons down right now |
| `pressed` | Bitmask of buttons that went down since the last `poll()`, **latched** |
| `released` | Bitmask of buttons that came up since the last `poll()` |

```js
for (const [n, p] of host.poll()) {
  if (p.pressed & (1 << Button.A)) jump(n);   // a tap, even one shorter than a frame
  if (down(p.held, "Left")) walkLeft(n);      // held
  steer(n, p.state.lx);
}
```

Use `pressed` for actions (jump, fire, select) and `held` for continuous
things (walking, charging). Reading `held` alone misses taps that start and
end between two frames.

### Commands

| Method | What |
|---|---|
| `setLook(look)` | Change the default look for every pad |
| `setPad(n, look)` | Change one pad's look |
| `haptic(n, ms)` | Vibrate a phone: a number or a pattern array (Android only) |
| `kick(n)` | Disconnect a phone and free its seat |
| `setOpen(open)` | Allow or refuse new phones |
| `close()` | Close the room |

### State

`host.code`, `host.key`, `host.joinUrl`, `host.hostRtt` (ms to the relay),
and `host.pads`, a `Map` of every pad with `connected`, `state`, `rtt`,
`via` (`"p2p"` or `"relay"`, as the phone reports it), `p2p` (a data
channel is open) and `frames`.

> **In progress:** typed declarations at `/sdk.d.ts`, and `pressed(n, "A")`
> / `held(n, "A")` conveniences over `poll()`, are being added. Until then
> use the bitmasks above.

## Go

Module `github.com/jclement/stickdrift/go`, package `stickdrift`. A
generalisation of the client Kaboom uses (WebSocket via
`github.com/coder/websocket`, WebRTC via `github.com/pion/webrtc/v4`).

> **Being built.** The API below is the agreed design; names may shift
> before it lands. `go doc github.com/jclement/stickdrift/go` is the truth.

```go
host := stickdrift.NewHost(stickdrift.Options{
	Title: "My Game",
	Look:  stickdrift.Look{Layout: "stick-ab", Color: "#ff4d6d"},
})
if err := host.Start(ctx); err != nil { // connects; reconnects by itself
	return err
}

for !quit { // your game loop
	host.Tick() // once per frame: this frame's presses become visible
	for _, pad := range host.Pads() {
		if pad.JustPressed(stickdrift.A) { jump(pad) }
		if pad.Held(stickdrift.Left)     { walkLeft(pad) }
		x, y := pad.Stick()             // left stick, -1..1
		_ = pad.P2P()                   // true when input arrives peer-to-peer
	}
}
```

| API | What |
|---|---|
| `NewHost(opts)` | Make a host (title, default look, room code and key, relay origin) |
| `host.Start(ctx)` | Connect and keep reconnecting until `ctx` ends |
| `host.Tick()` | Call once per game frame: publishes presses latched since the last tick |
| `host.Pads()` | The connected pads |
| `pad.Held(btn)` | Button down right now |
| `pad.JustPressed(btn)` | Went down since the previous `Tick` (never misses a tap) |
| `pad.Stick()` | Left stick `x, y`, -1..1 |
| `pad.P2P()` | Whether a direct WebRTC channel is carrying input |
| `host.SetLook(look)` | Default look for every pad |
| `host.SetPad(n, look)` | One pad's look |
| `host.Haptic(n, ms…)` | Vibrate a phone (Android) |
| `host.Joined()` / `host.Left()` | Channels of pads joining and leaving |

`Look` carries every look field: `Layout`, `Label`, `Color`, `Labels`,
`Message`, `Swap`, `Diagonals`, `Theme`, `Custom`, `Avatar`, `Banner`.

## Other languages

The protocol is small: one WebSocket, a handful of JSON messages, and a
16-byte binary frame. Peer-to-peer is optional; without it everything rides
the relay. See [Protocol](/docs#protocol).
