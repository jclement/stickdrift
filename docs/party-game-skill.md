---
name: stickdrift-party-games
description: Build a same-screen party game where one big screen (a TV or laptop browser) runs the game and every player's phone is the controller, via StickDrift. Covers the stack (Go + Ebitengine compiled to WebAssembly, or plain JS + canvas for small games), the phone-controller patterns, art and sound generated in code, optional pre-generated voices, static hosting on Cloudflare, bots, tests and visual verification. Use when starting, extending or shipping a Jackbox-style or couch-multiplayer game.
---

# Same-screen party games with StickDrift

The shape: **one big screen runs the game; every player's phone is the controller.** Nobody
installs anything. The screen shows a QR code and a five-letter code, phones scan it, and
they're in. This is how KABOOM!, SKIDMARK!, BRAINFART! and SPACEJUNK! on stickdrift.net were
built. Read the StickDrift docs first: https://stickdrift.net/llms.txt (concepts, layouts,
custom layouts, SDKs, recipes).

## Pick a stack, say which

| Game | Stack | Why |
|---|---|---|
| Real-time (arena, racing, physics), up to 16 players | **Go + Ebitengine**, compiled to WebAssembly | Fixed 60 Hz update loop, audio, gamepads; the same code runs native and in the browser, so every tested line ships |
| Turn-based or small (quiz, drawing, voting) | **Plain JS + canvas** with `https://stickdrift.net/sdk.js` | Loads in ~1 MB instead of 8-10 MB of wasm |

Phones: the Go library `github.com/jclement/stickdrift/go` or the browser SDK. Either way the
game is the **host**, each phone a **pad**.

## Architecture rules

- **The simulation is pure and headless.** One package holds rules, maps and bots: fixed
  timestep (60 Hz), seeded RNG, no graphics or audio imports. Everything worth testing lives
  there, and a round is reproducible from its seed.
- **Events, not diffing.** Each tick the sim appends events (`EvDie{Ship, Cause, Other}`,
  `EvPickup{Item}` …). The app layer turns them into sound, particles, banners, narration and
  phone haptics. Adding juice never touches rules.
- **Presentation-only effects stay out of the sim**: screen shake, gore, flashes, disco
  tints, fog. Bots don't see them.
- **Input is one abstraction.** Keyboard zones, gamepads, phones and bots all produce the
  same `Intent` (for example `{Turn, Thrust, Fire}`). Bots have no input source, so any code
  that matches seats by source must skip them explicitly, or CPUs get re-seated every round.
- **Scale for TVs.** Draw into a small logical canvas (640x360 is a good default) and
  upscale by a whole number when that fills at least 85% of the window, else fill. Keep
  sprites readable at 16 players on one screen.
- **Development flags for everything.** `-demo N` (a CPU-only match), `-shots DIR
  -shot-ticks 60,600,1200` (save screenshots at those ticks, then quit), `-mute`,
  `-item NAME` (every pickup is this item). In the browser, map the page's query string to the
  same flags so `?demo=8&mute=1` works.

## Phones

- **Phone-first lobby.** The lobby is the front screen and always shows the QR and the
  code. Scanning is joining. During play a small QR stays in a corner; latecomers join the
  next round.
- **One look per phase**: lobby (a big READY tile, colour arrows, hold-to-START), play (a
  built-in layout or a custom one with game words on the buttons), spectator or ghost (one
  fun button: BOO!, HONK!), results (NEXT ROUND). **Push a look only when it changes**:
  every push rebuilds the phone's controller and releases held buttons. Cache the last look
  JSON per pad and compare.
- **Tell players who they are**: their colour, a name banner, and their sprite as a PNG
  data URL avatar. A pixel/retro theme makes the phone match the game.
- **Read presses as latched edges** once per tick (`Tick()` then `JustPressed` in Go;
  `pressed(p, "A")` on a `poll()` entry in JS). A tap shorter than a frame still counts.
- **Haptics** on hits, pickups and deaths: cheap, and players love them (Android only).
- **The phone's private screen is the superpower.** A gamepad can't show one player
  something the others don't see: secret roles, a station's gauges, the half of the clue
  only you have. Design for it.
- **Custom layouts**: tiles, buttons, pills, sticks, buzzers placed as fractions of the
  screen. Pixel-font labels are a fixed size, so keep them short (THRUST, FIRE, BOO!) and
  test that they fit.
- **Latency**: input goes phone → game peer-to-peer over WebRTC (~1 ms on the same Wi-Fi),
  falling back to the relay (~55-65 ms) on networks that isolate devices. Design so 60 ms is
  still playable: no frame-perfect inputs.

## Art from code

No image files. Sprites are ASCII grids with **tint slots**, so one drawing becomes sixteen
player colours, and a ragged row fails a test:

```go
var shipSprite = []string{
	"kkk..........",
	"kllkk........",
	".kccckk......",
	"..kddccccuukk",
	"..kddcccuuWWk", // c/l/d = the player's main/light/dark colour, k = outline
	"..kddccccuukk",
	".kccckk......",
	"kllkk........",
	"kkk..........",
}
```

- Pre-rotate sprites to 32 headings with nearest-neighbour sampling so pixel art stays crisp
  at any angle.
- Backgrounds and planets are procedural: layered value noise for nebulae and terrain, a
  hash for stars and craters, sphere shading lit from the top left. Paint once per map, draw
  only the moving parts each frame.
- Particles do the rest: sparks, debris, confetti, shockwave rings, floating "+1" popups.

## Sound from code

- **Music**: a tiny tracker. A song is chord names per bar plus a lead line of note tokens
  (`"A5 - C6 - E6 - . ."`); arpeggio and bass are derived from the chords, drums are
  pattern strings (`"k . h . s . h ."`). Write several songs and rotate them; a different one
  for sudden death.
- **Effects**: small synthesis recipes (square waves with pitch envelopes, filtered noise
  for explosions, a falling-pitch square for a rubber duck) rendered once at start-up, at
  several pitches and pans, played round-robin.
- Browsers start audio only after a user gesture: the loader page has a PLAY button.

## Voices (optional, ElevenLabs or any TTS)

A voiced narrator or host is the single biggest personality upgrade. Pre-generate the clips
once and ship them; the game never needs a key or a network for audio.

- Keep **every line in one catalogue** in code: key, speaker, text. Write pools of
  interchangeable lines ("die_planet": 8 lines) and pick at random.
- A generator tool reads the API key from an env file at generation time only (never
  printed or committed), renders **only missing** clips, trims silence and normalises
  loudness (ffmpeg, 64 kbps mono mp3), and retries on rate limits.
- Say the player's name as its own clip ("Red.") followed by a line in the second person
  ("You have flown into a planet."), so sixteen players share one set of lines.
- Show the words on screen too (a caption or text box), with delivery tags like `[sighs]`
  stripped. Queue lines; drop low-priority ones when the narrator is busy.
- **A missing clip is silent, never fatal.** In the browser, decode clips on first use
  rather than all at start-up, and consider fetching them on demand instead of embedding
  them, to keep the download small.
- Count characters before generating: TTS is billed by the character.

## Web build and hosting

- `GOOS=js GOARCH=wasm go build -ldflags="-s -w"`, gzip it, give it a content-hashed name
  (static hosts often cap files at 25 MB). The loader page streams it with a progress bar and
  decompresses with `DecompressionStream("gzip")`.
- Cache headers: `no-cache` on `/` and `index.html`, `immutable` on the hashed wasm and
  clips.
- Host the static files anywhere. On Cloudflare Workers static assets, **put several sites on
  one zone behind zone routes, not custom domains**:
  `"routes": [{ "pattern": "game.example.com/*", "zone_name": "example.com" }]` plus one
  proxied wildcard DNS record. Each Workers custom domain gets its own certificate that also
  names the apex; browsers then reuse one site's connection for a sibling and Cloudflare
  answers 403 instead of 421, so links between your sites fail intermittently.

## Bots

Every game ships CPU players: they fill empty seats, run attract mode behind the lobby, and
make the game testable. Keep them simple and imperfect (aim with a wobble, react with human
delays, sometimes panic). A bot that never dies is less fun than one that occasionally flies
into the sun.

## Tests that matter

- Sim tests for every rule, item and timer (pick up, use, expire).
- Map tests: every map at every player count; spawns are safe and reachable.
- **Bot-only rounds**: over 20+ seeds, rounds finish, scores happen, and bots don't mostly
  kill themselves. Log round lengths; tune pacing from them.
- App tests: seats across rounds (late joiners, CPUs not duplicated), phone labels fit,
  every voice key the game asks for exists in the catalogue.

## Verify before you say it works

- Run a CPU match with screenshots (`-demo 8 -shots …`) and **look at the images**. Say what
  you saw: the arena, the HUD, an item in use, the results screen.
- Load the browser build and check the console.
- Say plainly what wasn't verified: real phones joining, a full round with real people, a
  phone on guest Wi-Fi. Those need a couch.
