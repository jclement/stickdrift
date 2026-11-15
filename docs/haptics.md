# Haptics

Buzz a player's phone when they get hit, score, or it's their turn.

```js
host.haptic(pad, 40);                 // one 40 ms buzz
host.haptic(pad, [30, 60, 30]);       // buzz, pause, buzz (a pattern, in ms)
```

On the wire: `{"t":"haptic","pad":3,"ms":40}` or `"ms":[30,60,30]`.

## What to expect

- **Android** (Chrome, Firefox, Samsung Internet): works. The phone
  vibrates with the pattern you send.
- **iPhone**: nothing. Safari does not let web pages vibrate, from the
  browser or from the Home Screen. Never make a haptic the only way the
  player learns something; pair it with a sound, a flash, or a `message`.
- The phone also gives its own small tap of feedback on button presses
  where the platform allows it; you don't need to send those.

## Good patterns

| Moment | Pattern |
|---|---|
| Button confirm, menu tick | `15` |
| Hit, damage | `40` |
| Big explosion, death | `[80, 40, 120]` |
| Your turn | `[30, 80, 30]` |
| Countdown beat | `20` each second, `120` on GO |

Keep them short: long buzzes drain batteries and get annoying fast.
