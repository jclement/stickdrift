# web-pong

A complete StickDrift game in one HTML file: Pong for two or more phones.
Everyone scans the QR code and gets the **paddle** layout; the slider moves
your paddle and **A** serves. Even seats play bottom, odd seats top, and extra
players become extra paddles further up the court. Each paddle shows whether
that phone is on P2P or the relay, and its round trip.

```sh
cd examples/web-pong
python3 -m http.server 8000      # or: bunx serve .
open http://localhost:8000
```

Against a local relay (`mise run dev`, which also builds `/sdk.js`):

```
http://localhost:8000/?origin=http://localhost:8787
```

What it shows, in about 150 lines of game:

- `new StickDriftHost({ look: { layout: "paddle", … } })` opens a room;
  `on("open")` gives the join URL for the QR code.
- `on("join")` colours each phone by team and gives it a banner, with
  `setPad`; `haptic` buzzes on a hit or a point.
- Once per animation frame, `poll()` reads every pad: `state.lx` is the
  slider, and `pressed(p, "A")` catches a serve however short the tap.
- `setLook({ message })` puts the score on every phone.

The page imports `/sdk.js` from the relay's origin, so the SDK always matches
the relay. For type checking, `/sdk.d.ts` sits next to it.
