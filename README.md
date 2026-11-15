# Controller

Every phone is a game controller. A game opens a room, shows a QR code, and
every phone that scans it becomes a gamepad (d-pad, stick, buzzer, steering
wheel, or any layout the game describes), relayed to the game over WebSockets
with as little latency as Cloudflare's edge allows. No app, no accounts.

Live at **https://controller.onewheelgeek.net** (try `/demo`).

## Quick start

```sh
mise run setup     # bun install
mise run dev       # build pages, then wrangler dev on :8787 (all interfaces, so phones on the LAN can join)
mise run check     # typecheck + tests (in the Workers runtime)
mise run deploy    # build and deploy to controller.onewheelgeek.net
```

Smoke and latency test any deployment:

```sh
bun scripts/smoke.ts https://controller.onewheelgeek.net
```

## Pages

| Path | What |
|---|---|
| `/` | Homepage: how it works, live layout gallery, custom-layout playground, developer docs |
| `/j/CODE` | The phone controller (`/j` alone asks for a code) |
| `/j?preview=LAYOUT&color=%23hex&style=…` | A layout with no room, for previews |
| `/demo` | A working host: QR code, layout picker, live view of every pad |
| `/sdk.js` | The browser host SDK (ES module) |
| `/protocol.md` | The wire protocol |
| `/api/v1/health`, `/api/v1/layouts` | JSON |
| `/ws/host/CODE?key=…`, `/ws/pad/CODE?device=…` | WebSockets |

## On the phone

- **P2P first, Cloudflare as fallback.** Input goes over a direct WebRTC data
  channel when the game supports it (about 1 ms on the same Wi-Fi) and over
  the Cloudflare relay otherwise (about 55-65 ms from Alberta). The HUD badge
  says which (`P2P · 1 ms` or `RELAY · 58 ms`).
- **Debug panel:** the `i` button shows the path in use, ICE and data-channel
  state, the network path picked (host/srflx/prflx), round trips for both
  paths (last/avg/p90), frame counts, repeats, reconnects, and live input.
- **Full screen:** Android goes full screen on the first touch and locks to
  landscape. iPhone Safari can't (Apple doesn't allow it for pages), so the
  controller suggests Add to Home Screen once; launched from there it is full
  screen and offers to rejoin the last room in one tap.

## Testing

```sh
mise run check                                          # typecheck + workerd tests
bun scripts/smoke.ts https://controller.onewheelgeek.net  # relay latency, host and pad in Bun
bun scripts/e2e.ts https://controller.onewheelgeek.net    # two headless Chrome tabs: host + phone, checks P2P
```

## Configuration

None. No secrets, no environment variables. The Durable Object binding and
custom domain are in `wrangler.jsonc`.

## Tasks

| Task | What it does |
|---|---|
| `setup` | install dependencies |
| `build` | Vite pages + SDK + protocol.md into `dist/client` |
| `dev` | build, then `wrangler dev` |
| `test` | vitest in workerd: protocol units and host/pad relay integration |
| `lint` | `tsc -b` over worker and client |
| `check` | lint + test |
| `deploy` | build and `wrangler deploy` |
| `dev:reset` | delete `dist` and local DO state |

## License

MIT.
