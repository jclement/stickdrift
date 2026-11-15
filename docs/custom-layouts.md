# Custom layouts

Set `layout: "custom"` and send a list of controls in `custom`. The phone
builds it on the spot; change it mid-game and every phone follows (use
this power responsibly, or at least amusingly). The
fastest way to make one is the [layout designer](/designer): drag controls
onto a phone, then copy the JSON.

```custom
{
  "orientation": "landscape",
  "controls": [
    { "type": "stick", "x": 0.2, "y": 0.6, "w": 0.4, "h": 0.75, "size": 0.5 },
    { "type": "button", "x": 0.86, "y": 0.42, "size": 0.3, "button": "A", "label": "FIRE", "solid": true },
    { "type": "button", "x": 0.68, "y": 0.68, "size": 0.24, "button": "B", "label": "BOOST", "color": "#3a86ff" },
    { "type": "tile", "x": 0.62, "y": 0.2, "w": 0.16, "h": 0.18, "button": "X", "label": "MAP", "color": "#38d996" },
    { "type": "pill", "x": 0.42, "y": 0.12, "button": "Start", "label": "PAUSE" }
  ]
}
```

```js
host.setLook({ layout: "custom", custom: myLayout });
```

## Coordinates

- `x`, `y`: the **centre** of the control, as fractions of the screen's
  width and height (0..1, top left is 0,0).
- `size`: a diameter, as a fraction of the screen's **short edge** (more
  exactly, of the smaller of the height and 60% of the width), so round
  controls stay round on every phone.
- `w`, `h`: fractions of the width and height, for rectangular things.
- `orientation`: `landscape` asks the player to turn the phone sideways;
  `portrait` or `any` (the default) work either way.

## Controls

| `type` | What | Sized by | Sets |
|---|---|---|---|
| `button` | Round button. `solid: true` fills it with the colour | `size` (default 0.22) | `button` |
| `tile` | Rectangular button, good for grids and answers | `w`, `h` | `button` |
| `pill` | Small rounded button, for Start/Select/Pause | fixed | `button` |
| `shoulder` | Wide shoulder button | fixed | `button` |
| `buzzer` | One huge glowing button | `size` | `button` |
| `dpad` | Four-way or eight-way d-pad | `size` | Up Down Left Right |
| `stick` | Analog stick. `w`/`h` is its touch zone, `size` the knob's travel | `w`, `h`, `size` | `lx ly` or `rx ry` |
| `slider` | Horizontal slider; it stays where the thumb leaves it | `w` | `lx` |
| `touchpad` | Trackpad: drag moves the pointer, taps are A, two-finger taps B | `w`, `h` | `px py`, A, B |

## Fields

| Field | Applies to | Meaning |
|---|---|---|
| `button` | buttons, tiles, pills, shoulders, buzzers | Which bit: `Up` `Down` `Left` `Right` `A` `B` `X` `Y` `L` `R` `Start` `Select` (default `A`) |
| `label` | same | Text on it, up to 12 characters (default: the button name or your `labels`) |
| `color` | buttons, tiles | Hex colour; otherwise the player colour |
| `solid` | buttons | Filled instead of outlined |
| `side` | sticks | `left` drives `lx ly`, `right` drives `rx ry` (default `left`) |
| `floating` | sticks | Recentre under the thumb where it lands (default `true`) |
| `dpad` | sticks | Also set the d-pad bits (default `true` for the left stick) |
| `diagonals` | d-pads | 8-way (default `true`); `false` for 4-way |

Limits: at most 32 controls; unknown types and fields are dropped, numbers
are clamped to 0..1, colours must be hex. Validation happens on the relay
and again on the phone, so a bad layout can't break anyone's controller.

## More examples

A portrait answer grid for a quiz, with six choices:

```custom
{
  "orientation": "portrait",
  "controls": [
    { "type": "tile", "x": 0.27, "y": 0.2, "w": 0.42, "h": 0.22, "button": "A", "label": "ONE", "color": "#ff4d6d" },
    { "type": "tile", "x": 0.73, "y": 0.2, "w": 0.42, "h": 0.22, "button": "B", "label": "TWO", "color": "#3a86ff" },
    { "type": "tile", "x": 0.27, "y": 0.47, "w": 0.42, "h": 0.22, "button": "X", "label": "THREE", "color": "#ffbe0b" },
    { "type": "tile", "x": 0.73, "y": 0.47, "w": 0.42, "h": 0.22, "button": "Y", "label": "FOUR", "color": "#38d996" },
    { "type": "tile", "x": 0.27, "y": 0.74, "w": 0.42, "h": 0.22, "button": "L", "label": "FIVE", "color": "#b388ff" },
    { "type": "tile", "x": 0.73, "y": 0.74, "w": 0.42, "h": 0.22, "button": "R", "label": "SIX", "color": "#ff8c1a" }
  ]
}
```

A racing pad with a slider for steering and big pedals, in a retro theme:

```custom
{
  "layout": "custom",
  "color": "#ffbe0b",
  "theme": { "style": "retro", "font": "pixel", "shape": "square" },
  "custom": {
    "orientation": "landscape",
    "controls": [
      { "type": "slider", "x": 0.3, "y": 0.62, "w": 0.5 },
      { "type": "tile", "x": 0.78, "y": 0.35, "w": 0.3, "h": 0.32, "button": "A", "label": "GAS", "color": "#38d996" },
      { "type": "tile", "x": 0.78, "y": 0.75, "w": 0.3, "h": 0.32, "button": "B", "label": "BRAKE", "color": "#ff4d6d" },
      { "type": "pill", "x": 0.3, "y": 0.15, "button": "Start", "label": "PAUSE" }
    ]
  }
}
```

## Sharing a layout

Any custom layout can be previewed with no room at
`/j?preview=custom#layout=<base64url of the JSON>`. Keep the JSON ASCII:
escape anything else as `\uXXXX` (the designer does this for you).
