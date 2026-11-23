# Layouts

Ten built-in controllers, each laid out from fractions of the screen so it
fits every phone, from the tiny one to the one with the cracked corner. Set
one with `look.layout`. These previews are the real controller page: press
them. They don't drift. We checked.

## Classic: `dpad-ab`

D-pad plus A and B, and Start. The eight-bit original. Set
`diagonals: false` for a 4-way d-pad (grid games).

```preview
dpad-ab color=#ff4d6d
```

## Thumbstick: `stick-ab`

A floating analog stick that appears under the thumb wherever it lands,
plus A and B. Produces `lx ly` and also sets the d-pad bits past half
deflection.

```preview
stick-ab color=#3a86ff
```

## Arcade: `arcade`

D-pad, four face buttons (A B X Y), Start and Select.

```preview
arcade color=#38d996
```

## Gamepad: `gamepad`

The works: stick, d-pad, four face buttons, L and R shoulders, Start and
Select.

```preview
gamepad color=#ffbe0b
```

## Twin Stick: `twin-stick`

Move with the left stick (`lx ly`, also the d-pad bits), aim with the right
(`rx ry`). L and R on top.

```preview
twin-stick color=#b388ff
```

## Buzzer: `buzzer`

One enormous button (A). Quiz night, reaction games, panic. Works in either
orientation.

```preview
buzzer color=#ff4d6d title="Buzzer, landscape"
buzzer color=#ff8c1a portrait title="Buzzer, portrait"
```

## Quiz: `quiz`

Four big coloured answer buttons: A B X Y. Relabel them with
`labels: { A: "Paris", B: "Rome", X: "Oslo", Y: "Bern" }`.

```preview
quiz color=#3a86ff
```

## Paddle: `paddle`

A slider for one axis (`lx`, -1..1) plus a fire button (A). Pong, Breakout.

```preview
paddle color=#2ee6e6
```

## Tilt: `tilt`

Steer by tilting the phone (`lx`, plus `ly` for pitch, and the Left/Right
bits); gas (A) and brake (B) under the thumbs. Landscape only. iPhones ask
for motion permission on the first tap.

```preview
tilt color=#ff6fb5
```

## Touchpad: `touchpad`

A trackpad: drag to move the pointer (`px py`, accumulated, wrapping at 16
bits: read the change between frames), tap for A, two-finger tap for B. A
and B buttons sit underneath.

```preview
touchpad color=#38d996
```

## Custom: `custom`

Anything else. Describe your own controls with `look.custom`: see
[Custom layouts](/docs#custom-layouts), or build one visually in the
[layout designer](/designer).

## Screen: `screen`

Not a controller at all: a little scrolling app page with text cards,
votes, bets, a text box and buttons, for word, card and voting games. The
phone sends events (which cards, which option, what number, what text)
instead of buttons. See [Screens](/docs#screens).

```preview
screen color=#ff8c1a
```

## Which one?

| Game | Layout |
|---|---|
| Platformer, grid or maze game, retro port | `dpad-ab` (with `swap: true` so players can choose the stick) |
| Top-down movement, analog speed | `stick-ab` |
| Fighting game, four actions | `arcade` / `gamepad` |
| Twin-stick shooter | `twin-stick` |
| Quiz, reaction game | `buzzer`, `quiz` |
| Pong, Breakout | `paddle` |
| Racing | `tilt` |
| Point-and-click, drawing, cursor UI | `touchpad` |
| Card game, voting, betting, typed answers | `screen` |

## Options that apply to every layout

- `swap: true` shows a toggle so each player can flip between the d-pad and
  stick versions (`dpad-ab` ⇄ `stick-ab`, `arcade` ⇄ `gamepad`). Since sticks
  also set the d-pad bits, your game doesn't need to know.
- `diagonals: false` makes every d-pad 4-way.
- `labels` renames buttons: `{ "A": "BOMB", "B": "ACTION" }`.
- `GET /api/v1/layouts` lists the layouts as JSON.

## Preview URLs

Every layout can be shown with no room at all, which is how these previews
work. Put them in your own docs, store pages, or tests:

```text
/j?preview=gamepad&color=%23ff4d6d
/j?preview=stick-ab&style=neon&font=display&shape=round
/j?preview=custom&color=%23ff8c1a#layout=<base64url of the custom JSON>
/j?preview=screen#layout=<base64url of the screen JSON>
```

| Param | Value |
|---|---|
| `preview` | a layout id |
| `color` | the player colour, hex (URL-encode `#` as `%23`) |
| `style`, `font`, `shape` | theme presets, see [Themes](/docs#themes) |
| `bg`, `text` | theme colours, hex |
| `#layout=` | for `custom`: the layout JSON, base64url; for `screen`: the screen JSON |
