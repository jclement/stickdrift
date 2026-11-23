# StickDrift Arcade: one party, every game

Status: shelved (2026-11-23). Jeff preferred to keep listing the games on the homepage for now; kept for reference.

## The goal

A Jackbox-style night: the TV opens one page, shows one room code, and everyone joins once from
their phone with a name and avatar. A host character runs the evening. Phones vote on the next
game, the game loads, players keep their names, colours and running party score, and at the end
of the night someone is crowned. One sound unlock, one music toggle, one join.

## The constraint: bundle size

Measured from the live sites today (gzipped `.wasm`, what a browser downloads):

| Game | wasm.gz | Game | wasm.gz |
|---|---|---|---|
| KABOOM! | 8 MB | DON'T PRESS IT! | 6 MB |
| SKIDMARK! | 8 MB | ALL IN! | 6 MB |
| BRAINFART! | 6 MB | POOP DECK! | 11 MB |
| SPACEJUNK! | 9 MB | MARBLE MAYHEM! | 10 MB |
| SNITCH! | 6 MB | | |

About 70 MB if fused into one binary, before anything is cached. That is a non-starter.

Where the bytes go:

- **The Go runtime plus Ebitengine is the floor, about 4–5 MB gzipped per binary.** Go cannot
  share one runtime between several wasm modules, and TinyGo can't run Ebitengine properly, so
  every separately loaded game pays this once. It's cached afterwards.
- **Embedded voice clips are the rest.** BRAINFART! already fetches its 135 MB of clips over HTTP
  and is at the floor. The others still `//go:embed` 3–10 MB of clips. Music is already fetched.

## The shape: a shell page and game plugins in iframes

```
TV browser: stickdrift.net/play
┌──────────────────────────────────────────────────────────────┐
│ Arcade shell (TypeScript, ~100 KB, no wasm)                   │
│  • the one StickDrift room: code, QR, joins, names, avatars   │
│  • host character + voice, party scoreboard, game vote        │
│  • audio unlock, music preference, fullscreen                 │
│                                                               │
│   ┌──────────────────────────────────────────────────────┐    │
│   │ <iframe src="/g/spacejunk/?arcade=1" allow="autoplay"> │    │
│   │   the game's own wasm, unchanged rules and rendering  │    │
│   └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
        ▲ postMessage: players, input frames, phone looks, results
```

1. **The shell owns the room. Games never touch the network.** Phones stay connected to the
   shell across games; only the iframe changes. Joining once is free.
2. **One wasm per game, loaded only when that game is picked.** First load of the night costs
   the shell (~100 KB) and nothing else: the lobby, vote and scoreboard are plain HTML/canvas.
   While phones vote, the shell prefetches the two leading candidates, so PLAY is near-instant.
   After the first play, a game comes from the browser cache.
3. **The iframe is the plugin boundary, and it is what makes this safe to work on.** A game
   that panics, leaks or hangs takes down its iframe, not the room. Removing the iframe frees
   all of that game's memory, which a Go wasm instance can't do on its own. Each game keeps its
   own repo, CI and release cadence, and it still runs standalone at its own subdomain.
4. **Same origin by path, not subdomain.** Each game's Worker also answers a zone route
   `stickdrift.net/g/<game>/*`. Same origin means no iframe cookie or permission problems, one
   HTTP connection, and no 421/403 certificate coalescing trouble. The games already use
   page-relative asset paths, so they work under a prefix.

## The plugin contract

The seam goes **inside the StickDrift Go library**, so games barely change. Today
`stickdrift.NewHost` opens a relay WebSocket and WebRTC. With `?arcade=1` in an iframe,
`platform_js.go` swaps in a **bridge transport** that speaks `postMessage` to the parent, while
the same `Host`, `Pad`, `Look`, `Haptic` and `Kick` APIs work as before. A game that works under
StickDrift works in the arcade.

Messages, all versioned (`{v:1, type, ...}`):

| Direction | Message | Purpose |
|---|---|---|
| shell → game | `hello` | protocol version, players (slot, name, colour, avatar), music mode, the host's language/explicitness settings |
| shell → game | `frame` / `join` / `leave` | pad input and roster changes, exactly as the relay sends them |
| game → shell | `ready` | assets loaded; shell fades the iframe in |
| game → shell | `look` / `pad` / `haptic` / `open` | phone layouts and buzzes, forwarded to phones |
| game → shell | `result` | final ranking per slot, plus an optional highlight line ("Red died to their own boomerang") |
| game → shell | `quit` | game is finished or a player chose "back to arcade" |

Each game declares itself in a small `arcade.json` (name, players min/max, typical minutes, tags
like "chaotic" or "brainy", its icon and its explicitness). The shell builds the vote from these
files, so adding a game means shipping `arcade.json` and nothing in the shell.

In arcade mode a game **skips its own lobby and join screen** (players arrive in `hello`), plays
one match or cup, posts `result` and `quit`. That is the only game-side code change: a flag the
lobby checks.

## The Jackbox vibe

- **A host.** One ElevenLabs character for the shell, with lines for joins, the vote, game intros,
  standings, rivalries ("Blue has finished last three games running; we're all very proud") and
  the final crowning. Same rules as the games: 1.25×, interruptible, never holds the game up.
- **Party score.** Each game's `result` maps to party points (the 6/4/3/2/1 scheme SPACEJUNK!
  already uses). Standings appear between games, with a gloating line.
- **Phones vote.** Three random eligible games (filtered by player count), and phones vote. A tie
  gets a dramatic spinning wheel. "Party length" picks 3, 5 or "until we're bored".
- **Persistent identity.** Names, colours and avatars are chosen once in the shell and passed to
  every game, so Red stays Red all night.
- **Late joiners** join the shell lobby at any time and enter at the next game.

## Making games lighter (do it regardless)

Move every game's voice clips out of the wasm to HTTP fetch, as BRAINFART! already does
(`clips_js.go` / `clips_native.go`), with the shell or game prefetching during the vote. Each game
then drops to about 4–6 MB gzipped. This also speeds up standalone loading, so it's worth doing
first and on its own.

## Risks to spike before building

1. **Audio inside an iframe.** `allow="autoplay"` delegation plus the shell's click should let the
   game's Web Audio start. Chrome supports it; **Safari is the risk**. Spike on Safari macOS,
   iPad Safari and an Android TV browser before anything else. Fallback: the shell keeps one
   AudioContext and games route audio through it, which is much more invasive.
2. **Memory across a long night.** Confirm that removing an iframe actually frees a Go wasm
   instance after 8–10 game switches (Chrome task manager, Safari Web Inspector).
3. **Input latency through `postMessage`.** It should add well under a millisecond, but measure
   it with SPACEJUNK!, the twitchiest game.
4. **Fullscreen and keyboard focus** across the iframe boundary.

## Build order

1. Spike: a bare shell page iframing two existing games with audio, on Safari and Chrome (risks 1–2).
2. Voice clips out of the wasm in the eight games that still embed them.
3. Bridge transport in the StickDrift Go library, plus `?arcade=1` lobby skip, then convert SPACEJUNK! as the reference.
4. Shell MVP: join, lobby, vote, iframe handoff, `result` → standings. No host voice yet.
5. Convert the other games (mechanical, parallel agents, one per repo).
6. The host character, party lengths, crowning, rivalries.
7. Make `stickdrift.net/play` the front door on the homepage.

## Not doing

- One fused Go binary: about 70 MB, one crash kills the room, and every repo becomes one.
- Dynamic wasm linking or a shared Go runtime: Go doesn't support it.
- Rewriting games in another language to get smaller binaries.
