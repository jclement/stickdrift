# Controller design

## Shape

```
phone (pad page) ──wss──▶ Worker ──▶ Session DO (one per room code) ──wss──▶ game (host)
                 ◀─ setup/haptics ─┘                                └─ looks/haptics ◀─
```

- `src/shared/protocol.ts`: the wire format, layouts list, validation of
  custom layouts and themes. Shared by the Worker, the pages and the SDK;
  PROTOCOL.md is the language-neutral spec of the same thing.
- `src/worker/index.ts`: Hono routes, security headers, WebSocket hand-off.
- `src/worker/session.ts`: the relay Durable Object.
- `src/client/pad/`: the phone controller (vanilla TypeScript, no framework):
  `input.ts` owns the state and sends; `controls.ts` are the widgets;
  `layouts.ts` places them; `main.ts` wires connection, touch routing and
  screen furniture; `pad.css` is all the looks.
- `src/client/sdk/host.ts`: the browser host SDK, also published as `/sdk.js`.
- `src/client/site/`: homepage and demo host.

## Key decisions

1. **Full-state binary snapshots, sent on change.** 16 bytes carrying every
   button, both sticks and a touchpad pointer. Holds are exact (the bit stays
   set), nothing can stick after a drop (a fresh snapshot replaces it), and the
   relay never parses input: it overwrites byte 1 with the pad number and
   forwards. JSON is only for rare control messages.
2. **Send inside the touch handler.** No requestAnimationFrame batching on
   the phone: that alone would add up to 16 ms. Frames are only sent when the
   quantised state changes, so stick jitter below one step costs nothing.
3. **A Durable Object per room, placed by the host.** Cloudflare creates the
   object near its first caller, which is the game. Phones in the same room
   reach their nearest edge and are routed there; typical end-to-end is the
   phone's RTT to Cloudflare plus a millisecond.
4. **WebSocket Hibernation.** Idle rooms cost nothing. Socket facts live in
   attachments and room settings in DO storage so they survive eviction.
   Pings are auto-answered by the runtime and never wake the object.
5. **Rooms are claimed with a host key**, not accounts: the first host on a
   code owns it; reconnecting with the key reclaims it with phones intact.
6. **Phones keep their seat.** A per-phone device id in localStorage maps to a
   seat, so a lock screen or a network blip rejoins as the same player.
7. **Sticks also drive the d-pad bits**, so layouts are interchangeable for
   d-pad games and players can flip between d-pad and stick (`swap`).
8. **Layouts are data.** Built-ins are defined in `layouts.ts` from fractions
   of the screen; hosts can send their own (`custom`) using the same
   vocabulary, validated server-side and again on the phone.
9. **Themes are presets, not CSS.** Five styles, four fonts, three shapes and
   hex colours. A host can make a phone look like its game without being able
   to inject markup or styles into a stranger's browser.
11. **P2P first, relay as fallback.** Phones offer an unordered,
    no-retransmit WebRTC data channel (relay does the signalling, STUN only, no
    TURN since the relay already is the fallback). Lost UDP packets are covered
    by repeating each change at +25 and +80 ms plus a 250 ms keepalive; hosts
    drop anything not newer by sequence number. Measured: 0.3-1 ms P2P vs
    55-65 ms relay (YVR edge) for the same pair of endpoints.
10. **Vanilla DOM for the pad.** No framework between a touch and a frame;
    animations only touch transform, opacity and shadows.

## Known limitations

- iOS Safari can't vibrate or go fullscreen from a page; "Add to Home Screen"
  gives fullscreen via the manifest.
- Relay-path input rides TCP: a lost packet stalls later frames briefly. P2P
  avoids this; networks that block UDP between devices (some guest Wi-Fi)
  fall back to the relay.
- Rooms trust anyone with the code to join as a pad; that's the point. Hosts
  can close the room (`open:false`) or kick.
- Tilt steering assumes landscape and is not calibrated.
