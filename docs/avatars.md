# Avatars and banners

With four phones in a room, every player's first question is "which one am
I?", usually asked while their character walks off a ledge. Answer it on
the phone itself: give each pad its player colour, a name, a **banner** and
an **avatar**.

```js
host.on("join", (pad) => {
  host.setPad(pad.pad, {
    color: "#e63946",
    label: "PLAYER 1",
    banner: "RED",                          // big faded text behind the controls
    avatar: "data:image/png;base64,iVBORw0…", // the player's sprite
  });
});
```

## Try it

This opens a real room and joins it with the phone page below. Pick a
player to see how the phone changes.

```live
avatars
```

## Banner

`banner` is up to 16 characters of big, faded text behind the controls:
the team, the colour, the character's name. It sits behind everything, so
it never gets in the way of a thumb.

## Avatar

`avatar` is a PNG as a base64 data URL. The phone shows it in the HUD chip
next to the player's name, and large, pixelated and faded behind the
controls, so pixel art stays crisp. Send the player's own sprite (Kaboom
sends each player their bomber).

- **PNG only.** Anything that is not `data:image/png;base64,…` is dropped.
  Rendered as an image, a PNG can't run script.
- **Small.** The protocol allows up to 24 KB, but the relay currently drops
  any single host message over 16 KB, so keep the data URL under about
  **12 KB**. A 16x16 to 64x64 sprite is 0.5-4 KB.
- **Pixel art works best**: it is scaled up with crisp edges.

Making one in the browser from a sprite sheet:

```js
function avatarFrom(sheet, sx, sy, size = 32) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  c.getContext("2d").drawImage(sheet, sx, sy, size, size, 0, 0, size, size);
  return c.toDataURL("image/png");
}
```

In Go, encode the image with `image/png` and pass the bytes to
`stickdrift.AvatarPNG`, which returns the data URL or tells you why the relay
would drop it.

## Label, colour and message

| Field | Where it shows |
|---|---|
| `color` | Tints the buttons, glows and the HUD dot |
| `label` | The player's name in the HUD, such as `PLAYER 1` or `RED` |
| `banner` | Big faded text behind the controls |
| `avatar` | HUD chip, and large behind the controls |
| `message` | A line of status text: "Waiting for round 2", "You're out!" |

Set them per pad with `setPad`, and change them whenever the game changes:
a knocked-out player's phone can say so.
