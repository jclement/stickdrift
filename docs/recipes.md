# Recipes

Patterns that come up in nearly every game, solved once so you don't have
to solve them at 2 a.m. the night before game night.

## Lobby, gameplay, spectator, results

Send a look for each phase of the game. The phone rebuilds instantly and
releases anything held, so a button press can't leak from one phase into
the next.

**Lobby.** One big button. Players press it to say they're in.

```custom
{ "layout": "custom", "color": "#38d996", "custom": { "controls": [
  { "type": "buzzer", "x": 0.5, "y": 0.5, "size": 0.62, "button": "A", "label": "READY" }
] } }
```

```js
host.setLook({ layout: "custom", custom: LOBBY, message: "Press READY when you're in" });
```

**Gameplay.** The real controller, per player, so everyone knows who they
are.

```preview
dpad-ab color=#e63946 title="Player 1"
dpad-ab color=#3a86ff title="Player 2"
```

```js
players.forEach((p) => host.setPad(p.pad, { layout: "dpad-ab", color: p.color, label: p.name, banner: p.team, message: "" }));
```

**Spectator.** A knocked-out player keeps their phone but can't play.
Give them something to do (cheer, vote) or just say so.

```custom
{ "layout": "custom", "color": "#8a84a3", "theme": { "style": "flat" }, "custom": { "controls": [
  { "type": "tile", "x": 0.3, "y": 0.55, "w": 0.34, "h": 0.4, "button": "A", "label": "CHEER", "color": "#ffbe0b" },
  { "type": "tile", "x": 0.7, "y": 0.55, "w": 0.34, "h": 0.4, "button": "B", "label": "BOO", "color": "#8a84a3" }
] } }
```

```js
host.setPad(n, { layout: "custom", custom: SPECTATOR, message: "You're out! Cheer the others on" });
```

**Results.** Play again or quit.

```custom
{ "layout": "custom", "color": "#ffbe0b", "theme": { "style": "candy" }, "custom": { "controls": [
  { "type": "tile", "x": 0.5, "y": 0.4, "w": 0.6, "h": 0.36, "button": "A", "label": "AGAIN", "color": "#38d996" },
  { "type": "pill", "x": 0.5, "y": 0.8, "button": "Select", "label": "QUIT" }
] } }
```

A useful shape for the game side:

```js
const LOOKS = { lobby: {...}, playing: {...}, spectating: {...}, results: {...} };
function enter(phase) {
  game.phase = phase;
  host.setLook(LOOKS[phase]);
  host.poll(); // throw away presses latched during the old phase
}
```

## Show the player who they are

The moment a phone joins, give it the player's colour and name, and the
same sprite you draw on the big screen. See [Avatars and
banners](/docs#avatars).

```js
host.on("join", (pad, rejoin) => {
  const p = rejoin ? players[pad.pad] : (players[pad.pad] = newPlayer(pad.pad));
  host.setPad(pad.pad, { color: p.color, label: p.name, banner: p.name, avatar: p.spriteDataUrl });
});
```

Then do the same on the big screen: draw each player's colour or sprite
next to their score, so phone and screen agree.

## 4-way grid games

For mazes, Snake, Sokoban, Bomberman-likes: a 4-way d-pad stops diagonal
input from fighting the grid, and `swap` lets stick lovers have a stick.

```js
host.setLook({ layout: "dpad-ab", diagonals: false, swap: true, labels: { A: "BOMB", B: "ACTION" } });
```

```preview
dpad-ab color=#ff8c1a
```

On the game side, the d-pad bits are all you need (the stick sets them
too). When two directions are held, prefer the most recently pressed one:

```js
const DIRS = ["Up", "Down", "Left", "Right"];
for (const [n, p] of host.poll()) {
  const fresh = DIRS.find((d) => down(p.pressed, d));          // newest press wins
  if (fresh) players[n].dir = fresh;
  else if (!down(p.held, players[n].dir)) players[n].dir = DIRS.find((d) => down(p.held, d)) ?? null;
}
```

## Quiz with labelled answers

```js
host.setLook({ layout: "quiz", labels: { A: "Paris", B: "Rome", X: "Oslo", Y: "Bern" } });
// later: whoever pressed first
for (const [n, p] of host.poll()) if (p.pressed) answer(n, p.pressed);
```

```preview
quiz color=#3a86ff
```

## Surviving a reload

Store the room code and key, and pass them back: the players stay seated.
See [Hosts](/docs#concepts-hosts).

## Late joiners and full rooms

`maxPads` caps the room; extra phones see "room full". Close the doors at
the start of a round with `setOpen(false)` (phones already in can still
reconnect) and open them again in the lobby.
