# Quickstart

Phones controlling your game in five minutes. A game is the **host**: it
opens a room, shows a QR code, and reads input from every phone (**pad**)
that scans it. No app, no accounts, no server of your own.

## In the browser

Save this as `game.html`, open it, and scan the code with a phone. Every
button you press shows up on the page.

```html
<!doctype html>
<meta charset="utf-8" />
<title>My Game</title>
<div id="qr"></div>
<p id="code"></p>
<pre id="log"></pre>
<script type="module">
  import { ControllerHost, Button } from "https://controller.onewheelgeek.net/sdk.js";
  import qrcode from "https://esm.sh/qrcode-generator@2.0.4";

  const host = new ControllerHost({
    title: "My Game",
    look: { layout: "dpad-ab", labels: { A: "JUMP", B: "FIRE" } },
  });

  // 1. The room is open: put the join URL on screen as a QR code.
  host.on("open", (code, joinUrl) => {
    const qr = qrcode(0, "M");
    qr.addData(joinUrl);
    qr.make();
    document.getElementById("qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2 });
    document.getElementById("code").textContent = `Or go to ${joinUrl}`;
  });

  // 2. A phone joined: give it a colour and a name.
  const colours = ["#ff4d6d", "#3a86ff", "#38d996", "#ffbe0b"];
  host.on("join", (pad) => {
    host.setPad(pad.pad, { color: colours[pad.pad % 4], label: `P${pad.pad + 1}` });
  });

  // 3. Every frame: read each pad. `pressed` is latched, so a tap
  //    shorter than a frame is never missed.
  const log = document.getElementById("log");
  function frame() {
    for (const [n, p] of host.poll()) {
      if (p.pressed & (1 << Button.A)) log.textContent += `P${n + 1} jumped\n`;
      if (p.held & (1 << Button.Left)) { /* move left while held */ }
      // p.state.lx / p.state.ly: the stick, -1..1 (y is down)
    }
    requestAnimationFrame(frame);
  }
  frame();
</script>
```

That is the whole integration. From here:

- Pick a controller from the [layouts](/docs#layouts), or design your own in the
  [layout designer](/designer).
- Change what the phones show as the game moves on: see [phases](/docs#recipes).
- Read the [JavaScript SDK reference](/docs#sdks).

> **Testing without a phone?** Open the join URL in a second browser tab.
> Or open [/demo](/demo), which is a complete host that draws every pad live.

## In Go

The Go module `github.com/jclement/controller/go` wraps the same protocol,
including peer-to-peer WebRTC. It is **being built right now**; the shape
below is the agreed API, and names may still shift. Check
`go doc github.com/jclement/controller/go` for what shipped.

```sh
go get github.com/jclement/controller/go
```

```go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	controller "github.com/jclement/controller/go"
)

func main() {
	ctx := context.Background()
	host := controller.NewHost(controller.Options{
		Title: "My Game",
		Look:  controller.Look{Layout: "dpad-ab", Labels: map[string]string{"A": "JUMP"}},
	})
	if err := host.Start(ctx); err != nil {
		log.Fatal(err)
	}
	fmt.Println("Join at", host.JoinURL()) // draw this as a QR code (accessor name unconfirmed)

	tick := time.NewTicker(time.Second / 60)
	for range tick.C {
		host.Tick() // once per game frame: publishes this frame's presses
		for _, pad := range host.Pads() {
			if pad.JustPressed(controller.A) {
				fmt.Println("player", pad.Number, "jumped")
			}
			x, y := pad.Stick()
			_, _ = x, y // the left stick, -1..1
		}
	}
}
```

## Any other language

Anything that speaks WebSockets can be a host: connect to
`wss://controller.onewheelgeek.net/ws/host/CODE?key=SECRET`, send one JSON
`config` message, and read 16-byte binary frames. The [protocol](/docs#protocol)
page has every byte.

```text
connect  wss://controller.onewheelgeek.net/ws/host/ABCDE?key=<16+ random chars>
send     {"t":"config","title":"My Game","look":{"layout":"stick-ab"}}
receive  {"t":"welcome","code":"ABCDE","joinUrl":"https://controller.onewheelgeek.net/j/ABCDE",…}
receive  {"t":"join","pad":0,"device":"…"}
receive  <16 bytes>  kind u8 · pad u8 · seq u16 · buttons u32 · lx ly rx ry i8 · px py i16
send     {"t":"haptic","pad":0,"ms":40}
```

## Running your own relay

The relay is open source and runs on Cloudflare Workers. For local
development:

```sh
mise run setup && mise run dev    # http://localhost:8787, reachable from phones on your LAN
```

Point the browser SDK at it with `new ControllerHost({ origin: "http://<your-ip>:8787" })`.
