# Themes

Make the phone look like your game instead of like a web page someone made
in a hurry. A theme is a handful of presets plus
hex colours, set in `look.theme`; the player colour (`look.color`) then
tints buttons, glows and the HUD.

```js
host.setLook({
  layout: "arcade",
  color: "#ff4d6d",
  theme: { style: "retro", font: "pixel", shape: "square", background: "#1a1423", text: "#fdf6e3" },
});
```

Themes are presets on purpose: a game can restyle a stranger's phone but
can never inject CSS or markup into it.

## Styles

`theme.style` sets the overall material. `glass` is the default.

```preview
gamepad style=glass color=#ff4d6d title="`glass` (default): frosted, soft glow"
gamepad style=neon color=#2ee6e6 title="`neon`: dark, outlined, glowing"
gamepad style=flat color=#3a86ff title="`flat`: solid colour, no effects"
gamepad style=retro color=#ffbe0b title="`retro`: hard shadows, chunky borders"
gamepad style=candy color=#ff6fb5 title="`candy`: glossy and bright"
```

## Fonts

`theme.font`: `display` (default, Chakra Petch), `sans` (Inter), `mono`
(JetBrains Mono), `pixel` (Press Start 2P).

```preview
dpad-ab font=display color=#ff4d6d title="`display`"
dpad-ab font=sans color=#3a86ff title="`sans`"
dpad-ab font=mono color=#38d996 title="`mono`"
dpad-ab font=pixel color=#ffbe0b title="`pixel`"
```

## Shapes

`theme.shape`: `round` (default), `rounded`, `square`.

```preview
arcade shape=round color=#b388ff title="`round`"
arcade shape=rounded color=#b388ff title="`rounded`"
arcade shape=square color=#b388ff title="`square`"
```

## Colours

`theme.background` and `theme.text` are hex colours (`#rgb`, `#rrggbb` or
with alpha). Anything that isn't hex is ignored.

```preview
stick-ab style=flat bg=#fdf6e3 text=#1a1423 color=#e63946 title="Light: `bg=#fdf6e3 text=#1a1423`"
stick-ab style=neon bg=#000814 color=#ffbe0b title="Midnight: `bg=#000814`"
```

## Putting it together

Some combinations that look like a game rather than a website:

```preview
arcade style=retro font=pixel shape=square bg=#1a1423 text=#fdf6e3 color=#ff4d6d title="Pixel arcade"
twin-stick style=neon font=mono bg=#05010d color=#2ee6e6 title="Synthwave"
quiz style=candy font=sans shape=rounded color=#ff6fb5 title="Party quiz"
buzzer style=flat font=display bg=#101820 color=#ffbe0b title="Game show"
```

## Reference

| Field | Values | Default |
|---|---|---|
| `style` | `glass` `neon` `flat` `retro` `candy` | `glass` |
| `font` | `display` `sans` `mono` `pixel` | `display` |
| `shape` | `round` `rounded` `square` | `round` |
| `background` | hex colour | dark |
| `text` | hex colour | light |

Preview any combination with `/j?preview=<layout>&style=…&font=…&shape=…&bg=%23…&text=%23…&color=%23…`.
