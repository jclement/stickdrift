# stickdrift (Go)

Turn phones into game controllers from a Go program. Your game is the
**host**: it opens a room on the StickDrift relay, shows the join URL as a QR
code, and every phone that opens it becomes a `*stickdrift.Pad`.

```sh
go get github.com/jclement/stickdrift/go
```

```go
import stickdrift "github.com/jclement/stickdrift/go"

host := stickdrift.NewHost(stickdrift.Options{
	Title: "My Game",
	Look:  stickdrift.Look{Layout: "dpad-ab"},
})
host.Start(ctx)
defer host.Close()
<-host.Ready()
showQR(host.Info().JoinURL)

// once per game frame:
host.Tick()
for _, p := range host.Joined() {
	host.SetPad(p.Number(), stickdrift.Look{Label: fmt.Sprintf("PLAYER %d", p.Number()+1), Color: "#e63946"})
}
for _, p := range host.Left() {
	removePlayer(p.Number())
}
for _, p := range host.Pads() {
	if p.JustPressed(stickdrift.A) { jump(p.Number()) }
	if p.Held(stickdrift.Left) { walkLeft(p.Number()) }
	x, y := p.Stick()
	_ = p.P2P() // true when input arrives directly over WebRTC
}
```

A complete program is in [`examples/go-terminal`](../examples/go-terminal).

## How it behaves

- **Tick once per frame, then read.** Pad state changes only at `Tick`, so
  everything you read within a frame agrees. Presses are latched as frames
  arrive: a tap shorter than a frame still shows up as `JustPressed` (and
  `JustReleased`) on the next tick.
- **P2P first, relay as fallback.** Phones offer a WebRTC data channel; the
  host answers with [pion](https://github.com/pion/webrtc), resolving the
  browsers' mDNS `.local` candidates. On the same Wi-Fi input takes about
  1 ms; otherwise it rides the relay WebSocket (~55 ms). The API is the same
  either way. `Options.DisableP2P` turns WebRTC off.
- **Reconnects are handled.** If the relay connection drops, the host
  reconnects with the same code and key. Phones keep their seats; phones on
  P2P keep sending throughout; phones on the relay have their buttons released
  (nothing sticks) until the connection is back. The relay's welcome is then
  reconciled: anyone who left meanwhile appears in `Left()`. A phone whose
  data channel dies offers a new one, which replaces the old.
- **Another host with the same key** takes the room over; this one stops with
  `Info().Err == stickdrift.ErrReplaced` rather than fight for it. A code held
  by a different key gets a fresh random code.
- **Commands are best effort.** `SetPad`, `SetLook`, `SetOpen`, `Haptic` and
  `Kick` are dropped while disconnected. `SetLook` and `SetOpen` are re-sent
  on reconnect, and the relay remembers each pad's look.
- Every method is safe from any goroutine.

## API at a glance

| | |
|---|---|
| `NewHost(Options)`, `Start(ctx)`, `Close()` | room lifetime |
| `Ready()`, `Info()`, `Key()` | join URL, status, last error, host RTT; save `Code`+`Key` to reclaim the room after a restart |
| `Tick()`, `Pads()`, `Pad(n)`, `Joined()`, `Left()` | the game loop |
| `SetLook(Look)`, `SetPad(n, Look)`, `SetOpen(bool)`, `Haptic(n, ms...)`, `Kick(n)` | commands |
| `pad.Held(b)`, `JustPressed(b)`, `JustReleased(b)`, `Stick()`, `RightStick()`, `Pointer()`, `State()` | input |
| `pad.Number()`, `Device()`, `Connected()`, `P2P()`, `RTT()`, `Via()`, `Frames()` | about the phone |

`Look` carries every field of the protocol's look: `Layout`, `Label`,
`Color`, `Labels` (`map[Button]string`), `Message`, `Swap`, `Diagonals`,
`Theme`, `Custom` (a `CustomLayout` of `Control`s), `Avatar` (use
`AvatarPNG(pngBytes)`) and `Banner`. Zero fields are omitted and the relay
merges a pad's look, so to blank a text field name it in `Look.Clear`.

## Configuration

| Variable | Effect |
|---|---|
| `STICKDRIFT_URL` | relay origin when `Options.Origin` is empty (e.g. `http://localhost:8787`) |
| `STICKDRIFT_DEBUG` | log connection events to stderr when `Options.Logger` is nil |
| `STICKDRIFT_LIVE=1` | `go test` also opens a room on a real relay |

## Tests

`mise run test:go` from the repository root (race detector on). The tests run
a fake relay with `httptest` and play the phone with pion, including a real
WebRTC handshake, a re-offer after a dropped channel and a relay reconnect
while P2P is up.

The wire protocol is [PROTOCOL.md](../PROTOCOL.md).
