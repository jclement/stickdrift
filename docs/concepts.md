# Concepts

Six ideas cover everything: rooms, hosts, pads, looks, phases, and the two
paths input can take. That's the whole mental model. There is no
enterprise edition.

## Rooms

A room is a five-letter code such as `KXQTR` (letters only, never I or O,
so it reads cleanly off a TV). The host makes one up; phones join at
`/j/CODE`, which is what the QR code holds.

Each room is one Cloudflare Durable Object, created in the Cloudflare
location nearest whoever opened it: the big screen. Phones reach their
nearest edge and are routed there.

- A room holds up to 16 pads by default (`maxPads`, at most 64).
- `open: false` refuses new phones; phones that were already in can still
  reconnect.
- An idle room costs nothing (the object hibernates). An unhosted room is
  wiped after 6 hours.

## Hosts

The **host** is your game. It claims a room by connecting with a secret
**key** (16-128 characters it makes up). The first host on a code owns it;
reconnecting with the same key reclaims it with every phone still seated,
so a page reload or a network blip doesn't lose the players. A different
key is refused (HTTP 409): pick another code. The claim lapses 30 minutes
after the host disconnects.

The browser SDK makes up the code and key for you. To survive a reload,
keep them (for example in `sessionStorage`) and pass them back:

```js
const saved = JSON.parse(sessionStorage.getItem("room") ?? "{}");
const host = new StickDriftHost({ code: saved.code, key: saved.key, title: "My Game" });
sessionStorage.setItem("room", JSON.stringify({ code: host.code, key: host.key }));
```

## Pads

A **pad** is one phone. It gets a **seat number** (0, 1, 2…) the moment it
joins, and keeps it: each phone has a device id in its local storage, so a
phone that locks, drops off Wi-Fi or reloads comes back as the same player.

Input arrives as **complete snapshots**: every button, both sticks and a
touchpad pointer, 16 bytes, sent whenever anything changes. A held button
is a bit that stays set. Nothing can get stuck: when a phone leaves, treat
everything as released (the SDKs do this for you).

Short taps can start and end between two of your frames, so read presses as
**latched edges**: the SDK's `poll()` (JS) and `Tick()`/`JustPressed()` (Go)
remember every rising edge since you last looked.

**Buttons**: `Up` `Down` `Left` `Right` `A` `B` `X` `Y` `L` `R` `Start`
`Select` (bits 0-11). **Axes**: `lx ly rx ry` from -1 to 1, y pointing down.
Analog sticks also set the d-pad bits, so a game that only reads the d-pad
works with every layout.

## Looks

A **look** is everything the phone shows: the layout, the player's colour
and name, button labels, a status message, a theme, an avatar and a
banner. The host sets a default look for every pad and can override it per
pad at any time. The phone rebuilds instantly and releases anything held.

```js
host.setLook({ layout: "stick-ab", theme: { style: "neon" } });     // everyone
host.setPad(2, { color: "#38d996", label: "GREEN", message: "You're it!" }); // one phone
```

A look only ever carries presets and hex colours: a game can make a phone
look like the game but can't inject markup or CSS into a stranger's
browser.

## Phases

Most games have phases: a lobby, the game itself, someone watching, the
results. Send a different look for each. A lobby might be one big READY
button; gameplay a d-pad; a knocked-out player a "spectating" message; the
results screen a PLAY AGAIN button. See [Recipes](/docs#recipes) for
complete examples.

## Peer-to-peer and the relay

Input can take two paths from the phone to the game:

| Path | How | Typical latency |
|---|---|---|
| **P2P** | A WebRTC data channel straight from the phone to the game, unordered, no retransmits | ~1 ms on the same Wi-Fi |
| **Relay** | WebSocket to Cloudflare, through the room's Durable Object, back to the game | ~55-65 ms (measured from Alberta) |

P2P is tried first whenever the host supports it (`p2p: true`, the default
in the browser SDK). The relay WebSocket stays up regardless: it carries the
setup, looks and haptics, does the WebRTC signalling, and is the fallback
when a network blocks devices from talking to each other (some guest and
hotel Wi-Fi). The phone's HUD badge says which path is live, `P2P · 1 ms` or
`RELAY · 58 ms`, and the `i` button opens a debug panel with the details.

Your game doesn't need to care: the same frames arrive either way.
