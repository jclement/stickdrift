# Building party games

The games on [stickdrift.net](https://stickdrift.net) (KABOOM!, SKIDMARK!, BRAINFART!,
SPACEJUNK!, SNITCH!, DON'T PRESS IT! and ALL IN!) were built by an AI coding agent (Claude) working with one person: KABOOM!
first, then the others from a short brief plus a skill file distilled from it. This page
describes the recipe, so you can do the same: what the pieces are, why each was chosen, and
a prompt to start from.

**The short version:** give your agent the
[party-game skill](https://stickdrift.net/party-game-skill.md) and a one-page design brief.

## The shape

One big screen runs the game: a TV's browser, a laptop on an HDMI cable, a projector. It
shows a QR code; every player scans it and their phone becomes the controller. Up to
sixteen players, nothing to install, and the phone can show each player something the
others can't see.

```
phones ── StickDrift (P2P, ~1 ms; relay fallback) ──► game in a browser tab on the TV
                                                       │
           simulation (pure, 60 Hz, seeded) ──► events ┴─► sound, particles, narration,
                                                           phone looks and haptics
```

## The pieces, and why

| Piece | What we used | Why |
|---|---|---|
| Game code | **Go + [Ebitengine](https://ebitengine.org)**, compiled to WebAssembly | A fixed 60 Hz loop, audio and gamepads, and the same code runs as a native app and in any browser. Small turn-based games can skip this and use plain JS + canvas. |
| Phones | **StickDrift** ([Go library](/docs#sdks) or [browser SDK](/docs#quickstart)) | Rooms, QR join, a look per game phase, custom layouts, haptics, peer-to-peer input |
| Art | **Drawn in code**: ASCII sprites with colour slots, procedural backgrounds | No asset files. One drawing gives sixteen player colours; planets, nebulae and tracks are noise and maths |
| Music and effects | **Synthesised in code**: a tiny chord-chart tracker and sound recipes | Original, tiny, no licensing |
| Voices (optional) | **Pre-generated text-to-speech** (ElevenLabs `eleven_v3`) | A sarcastic narrator or smug quiz host is the biggest personality upgrade. Generated once, shipped with the game, so it needs no key at runtime |
| Hosting | **Static files** (we use Cloudflare Workers static assets) | The whole game is one HTML page, one wasm file and some audio |
| CPU players | **Simple bots in the simulation** | They fill empty seats, play in the background of the lobby, and make the game testable without people |

## How a game gets built

1. **Write a one-page brief.** The pitch in two sentences, what the phone shows in each
   phase, the rules, the silly items, the voice's personality, and the art direction. The
   more specific the jokes, the better the game.
2. **Start from the skill.** It carries the architecture (a pure simulation that emits
   events; one input abstraction for phones, keyboards, pads and bots; development flags for
   CPU-only matches and screenshots) and the hard-won details (push phone looks only when
   they change; read presses as latched edges; no frame-perfect inputs over a 60 ms relay).
3. **Simulation first, with tests.** Rules, maps and bots in a package with no graphics.
   Bot-only rounds over many seeds catch broken pacing and suicidal AI before anyone plays.
4. **Then the show:** art, sound, phone looks, narration, the lobby and results screens.
5. **Verify by looking.** The agent plays CPU matches with a screenshot flag and reads the
   images, then loads the browser build. Real phones on a real couch come last.
6. **Ship the static build.**

## A prompt to start from

Paste this into your coding agent, with the brief filled in:

```text
Build a same-screen party game. Read https://stickdrift.net/party-game-skill.md first and
follow it: Go + Ebitengine compiled to WebAssembly (or plain JS if the game is turn-based
and small), phones as controllers through StickDrift, art and sound generated in code,
CPU players, tests, and a static web build.

The game: <name>. <Two-sentence pitch.>
Players: 2-16, one shared screen, every phone is a controller.
Phone controls: <what each phone shows in the lobby, during play, when out, on results>.
Rules: <how a round goes, how it ends, how scoring works across rounds>.
Silly stuff: <items, hazards, twists>.
Voice: <optional: the narrator or host's personality, and whether to generate clips with a
TTS key I have in an env file>.
Look: <art direction>.

Verify with CPU-only matches and screenshots you actually look at. Tell me what you
checked and what still needs real phones.
```

## Lessons from the games

- **The phone's private screen is the point.** The best ideas use something a gamepad
  can't do: secret roles, a gauge only one crew member can see, the half of a clue only you
  have.
- **Narration is cheap and funny.** Write voice lines in the second person to whoever just
  died, say the player's colour first ("Red."), and put the words on screen too.
- **Give the dead something to do.** Ghosts that can say BOO! and shove the living keep
  eliminated players watching.
- **Bots that occasionally blunder are better company** than perfect ones.
- **Hosting several games on one domain?** On Cloudflare, use zone routes rather than
  Workers custom domains. See the [skill](https://stickdrift.net/party-game-skill.md) for
  the 403 this avoids.

## Installing the skill

- **Claude Code:** save it as `~/.claude/skills/stickdrift-party-games/SKILL.md`
  (`curl -o … https://stickdrift.net/party-game-skill.md` after making the folder), and it
  loads whenever you ask for a party game.
- **Any other agent:** tell it to read `https://stickdrift.net/party-game-skill.md` before it
  starts, as in the prompt above.
