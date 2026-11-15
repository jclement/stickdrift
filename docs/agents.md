# StickDrift: integration guide for AI coding agents

You are adding phone controllers to a game. Players scan a QR code and
their phone becomes a gamepad; your game reads their input every frame.
Follow these steps in order. Each has a check, so you know it worked before
moving on, rather than announcing success and hoping. (StickDrift is named
after worn analogue sticks drifting; nothing here drifts, and neither
should your integration.) Full docs: https://stickdrift.net/docs (raw
Markdown under `/docs/*.md`, index at `/llms.txt`).

## Facts to rely on

- Relay: `https://stickdrift.net`. No signup, no API key, no
  server to run.
- The game is the **host**; each phone is a **pad** with a stable seat
  number from 0. Rooms are five letters (`ABCDEFGHJKLMNPQRSTUVWXYZ`).
- Buttons are bits: Up 0, Down 1, Left 2, Right 3, A 4, B 5, X 6, Y 7, L 8,
  R 9, Start 10, Select 11. Sticks `lx ly rx ry` are -1..1, **y is down**.
- Analog sticks also set the d-pad bits, so reading only the d-pad works
  with every layout.
- Input is a full snapshot on every change; presses shorter than a frame
  exist, so read **latched** presses (`poll().pressed` in JS,
  `JustPressed` after `Tick` in Go), never only the held state.
- Looks (layout, colour, labels, theme, avatar, banner, message) can change
  at any time, per pad or for everyone.

## Step 1: choose a layout

Map the game's controls to one of these `layout` ids:

| Game needs | Layout |
|---|---|
| D-pad + 2 buttons (platformer, grid game) | `dpad-ab` (`diagonals: false` for 4-way grids) |
| Analog movement + 2 buttons | `stick-ab` |
| D-pad + 4 buttons + Start/Select | `arcade` |
| Stick + d-pad + 4 buttons + shoulders | `gamepad` |
| Move + aim | `twin-stick` |
| One button | `buzzer` |
| Four answers | `quiz` |
| One axis + fire | `paddle` |
| Steering | `tilt` |
| Pointer | `touchpad` |
| Anything else | `custom` (see https://stickdrift.net/docs/custom-layouts.md) |

Relabel buttons to the game's verbs: `labels: { "A": "JUMP", "B": "FIRE" }`.

**Check:** open `https://stickdrift.net/j?preview=<layout>` and
confirm the controls match what the game needs. For a custom layout, use
`/j?preview=custom#layout=<base64url of the JSON>` or build it at `/designer`.

## Step 2: open a room

**Browser game:**

```js
import { ControllerHost, Button, down } from "https://stickdrift.net/sdk.js";
const host = new ControllerHost({ title: "<Game name>", look: { layout: "dpad-ab", labels: { A: "JUMP" } } });
```

**Go game:** `go get github.com/jclement/stickdrift/go` (package
`stickdrift`; still being built, confirm names with `go doc`):

```go
host := stickdrift.NewHost(stickdrift.Options{Title: "<Game name>", Look: stickdrift.Look{Layout: "dpad-ab"}})
if err := host.Start(ctx); err != nil { return err }
```

**Anything else:** WebSocket to
`wss://stickdrift.net/ws/host/<CODE>?key=<16-128 random chars>`,
send `{"t":"config","title":"…","look":{"layout":"dpad-ab"}}`, receive
`{"t":"welcome","joinUrl":…}`. Spec: https://stickdrift.net/protocol.md

To keep players seated across a reload, persist `code` and `key` and pass
them back to the constructor.

## Step 3: show the QR code

When the room opens (`host.on("open", (code, joinUrl) => …)` in JS), draw
`joinUrl` as a QR code on the game's screen, large, with the five-letter
code underneath in big type for people who'd rather type it at
`stickdrift.net`. Use any QR library already in the project;
otherwise `qrcode-generator` (JS) or `github.com/skip2/go-qrcode` (Go).

**Check:** scan it (or open `joinUrl` in another browser tab): the phone
shows the controller and the host fires a `join` event.

## Step 4: read input every frame

Call once per game update, before game logic:

```js
for (const [n, p] of host.poll()) {
  if (p.pressed & (1 << Button.A)) jump(n);   // latched: never misses a tap
  if (down(p.held, "Left")) moveLeft(n);       // held
  move(n, p.state.lx, p.state.ly);            // analog, -1..1
}
```

```go
host.Tick()
for _, pad := range host.Pads() {
	if pad.JustPressed(stickdrift.A) { jump(pad.Number) }
	if pad.Held(stickdrift.Left) { moveLeft(pad.Number) }
}
```

Map seat numbers to players. On `join`, create or restore the player for
that seat (`rejoin` is true when the same phone comes back). On `leave`,
treat all of that pad's buttons as released; don't delete the player
immediately, since phones come back after a lock screen.

**Check:** press each button on the phone and confirm the game reacts once
per tap, including very quick taps.

## Step 5: show players who they are

On `join`, give each pad the colour and name it has on the big screen:

```js
host.setPad(n, { color: player.color, label: player.name, banner: player.team });
```

Optionally send `avatar`: a PNG data URL of the player's sprite, under
12 KB. See https://stickdrift.net/docs/avatars.md

## Step 6: a look per phase

Send a different look when the game changes phase, for example:

- **lobby:** `{ layout: "buzzer", labels: { A: "READY" }, message: "Press READY" }`
- **playing:** the game layout from Step 1, `message: ""`
- **spectating** (a player who is out): `{ message: "You're out!", layout: "buzzer", labels: { A: "CHEER" } }`
- **results:** a custom layout with AGAIN and QUIT tiles

`host.setLook(look)` changes everyone; `host.setPad(n, look)` one phone.
After a phase change, call `host.poll()` once and discard the result so
presses from the old phase don't carry over. Recipes:
https://stickdrift.net/docs/recipes.md

Optional: `host.haptic(n, 40)` on hits (Android only; never the only
signal). `host.setOpen(false)` when a round starts to stop new joiners.

## Step 7: test

1. **Without a phone:** open the join URL in a second browser tab and click
   the buttons.
2. **The reference host:** https://stickdrift.net/demo shows
   every pad's live state; compare your game's behaviour with it.
3. **Every look you send:** preview it at
   `/j?preview=<layout>&color=%23hex&style=…` without a room.
4. **On real phones**, on the same Wi-Fi as the game: the phone's HUD
   should read `P2P · ~1 ms`. `RELAY · ~60 ms` means the network isolates
   devices (guest Wi-Fi); it still works.

## Done when

- [ ] A QR code and the room code appear on the game screen.
- [ ] Each phone controls exactly one player, and keeps it after locking
      and unlocking.
- [ ] Quick taps register every time (latched presses are used).
- [ ] Each phone shows its player's colour and name.
- [ ] Each game phase sends its own look.
- [ ] A phone leaving releases its buttons; nothing moves on its own.
