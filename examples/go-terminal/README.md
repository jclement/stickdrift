# go-terminal

The smallest complete Go host: opens a room, prints its QR code in the
terminal, and logs every phone's input live. Use it to try phones from Go, or
copy `main.go` as the start of a game.

```sh
cd examples/go-terminal
go run .                                   # the public relay
go run . -origin http://localhost:8787     # a local `mise run dev`
go run . -layout paddle -relay-only        # another layout, no WebRTC
```

```
Room KQZTD · scan the code or open https://stickdrift.net/j/KQZTD

14:02:11.204  player 1  [relay]  joined
14:02:12.981  player 1  [P2P 1 ms]  A↓
14:02:13.090  player 1  [P2P 1 ms]  A↑
14:02:14.402  player 1  [P2P 1 ms]  Up L(+0.03,-0.91)
```

Each line is a change: `A↓` pressed this tick, `A` held, `A↑` released,
`L(x,y)`/`R(x,y)` the sticks. The bracket says whether that phone's input is
arriving peer-to-peer or through the relay, with its round trip.

It uses the library in [`../../go`](../../go) through a `replace` directive;
in your own module, `go get github.com/jclement/stickdrift/go` instead. Set
`STICKDRIFT_DEBUG=1` to see connection events.
