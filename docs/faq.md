# FAQ

## How do players get full screen on an iPhone?

**Add to Home Screen.** Safari doesn't let a web page go full screen, so
the controller suggests it once: Share, then Add to Home Screen. Launched
from there it opens full screen and offers to rejoin the last room in one
tap. Android goes full screen on the first touch and locks to landscape.

## How fast is it?

| Path | Typical round trip |
|---|---|
| Peer-to-peer, same Wi-Fi | about **1 ms** (measured 0.3-1 ms) |
| Cloudflare relay | about **55-65 ms** (measured from Alberta to the Vancouver edge) |

Frames leave the phone inside the touch handler (never queued to the next
paint) and only when something changes. The phone's HUD shows the live
path and latency: `P2P · 1 ms` or `RELAY · 58 ms`.

## Why is it on RELAY when we're on the same Wi-Fi?

Some networks stop devices from talking to each other: guest Wi-Fi, hotel
and conference networks, and some mesh systems with "client isolation".
WebRTC can't make a direct connection there, so input uses the relay. It
still works, just with relay latency. Put the game and phones on a normal
home network (or the game machine's own hotspot) to get P2P back.

The `i` button on the phone shows the details: ICE state, which candidate
types were found, and round trips on both paths.

## Do phones need an app or an account?

No. The controller is a web page. Scan, play.

## Can strangers join my room?

Anyone with the code can join as a pad: that is the point. Close the room
with `setOpen(false)` once everyone is in, and `kick(n)` anyone who
shouldn't be there. Nobody can take over the game itself without its
secret key.

## What happens when a phone locks or drops?

It releases every button (the host sees a `leave`) and, when it comes back,
it gets the same seat (`join` with `rejoin: true`). Nothing gets stuck
held.

## Does vibration work on iPhone?

No. Safari doesn't allow web pages to vibrate. See [Haptics](/docs#haptics).

## How many players?

16 by default, up to 64 with `maxPads`.

## Can I run my own relay?

Yes: it's a Cloudflare Worker with one Durable Object per room. `mise run
dev` runs it locally; `wrangler deploy` puts it on your own account. Point
the SDK at it with `origin`.

## Is my game's input private?

Input travels over TLS to the relay, or over an encrypted WebRTC (DTLS)
channel directly to the game. The relay forwards frames without storing
them.
