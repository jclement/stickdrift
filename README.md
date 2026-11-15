# StickDrift

Every phone is a game controller. A game opens a room, shows a QR code, and
every phone that scans it becomes a gamepad (d-pad, stick, buzzer, steering
wheel, or any layout the game describes). Input goes peer-to-peer over WebRTC
(about 1 ms on the same Wi-Fi), with a Cloudflare relay as the fallback. No
app, no accounts.

**Docs: https://stickdrift.net/docs.** Using an AI coding agent? Point it at
https://stickdrift.net/agents.md (and `/llms.txt`).

Live at **https://stickdrift.net** (try `/demo`).

## Quick start

```sh
mise run setup     # bun install
mise run dev       # build pages, then wrangler dev on :8787 (all interfaces, so phones on the LAN can join)
mise run check     # typecheck + tests (in the Workers runtime)
mise run deploy    # build and deploy to stickdrift.net
```

Smoke and latency test any deployment:

```sh
bun scripts/smoke.ts https://stickdrift.net
```

## Pages

| Path | What |
|---|---|
| `/` | Homepage: how it works, live layout gallery, custom-layout playground, developer intro |
| `/docs` | Documentation, rendered at build time from `docs/*.md` and `PROTOCOL.md` |
| `/docs/<page>.md`, `/agents.md`, `/llms.txt` | The same docs as raw Markdown, for agents |
| `/designer` | Layout designer: drag controls onto a phone, copy the custom-layout JSON |
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
bun scripts/smoke.ts https://stickdrift.net  # relay latency, host and pad in Bun
bun scripts/e2e.ts https://stickdrift.net    # two headless Chrome tabs: host + phone, checks P2P
```

## Configuration

None. No secrets, no environment variables. The Durable Object binding and
custom domain are in `wrangler.jsonc`.

## Tasks

| Task | What it does |
|---|---|
| `setup` | install dependencies (bun and Go modules) |
| `build` | Vite pages (docs rendered from Markdown) + SDK + protocol.md into `dist/client` |
| `dev` | build, then `wrangler dev` |
| `test` | `test:js` + `test:go` |
| `test:js` | vitest in workerd: protocol units, SDK, host/pad relay integration |
| `test:go` | the Go host library (`go/`) and `examples/go-terminal`, with `-race` |
| `lint` | `lint:ts` (`tsc -b`) + `lint:go` (`go vet`, gofmt check) |
| `fmt` | gofmt the Go code |
| `check` | lint + test |
| `deploy` | build and `wrangler deploy` |
| `dev:reset` | delete `dist` and local DO state |

## License

MIT.

## Documentation

The docs live in `docs/*.md` (plus `PROTOCOL.md`), one file per section;
`src/client/site/docs-index.ts` sets their order. At build time
`vite.config.ts` renders them into `/docs` with `src/client/site/markdown.ts`,
which also turns ```` ```preview ```` and ```` ```custom ```` fences into live
controller previews, and publishes each file raw at `/docs/<slug>.md`.
`docs/agents.md` is served at `/agents.md`; `src/client/public/llms.txt`
indexes everything. Adding a page: write the Markdown, add it to
`docs-index.ts` and `llms.txt`.
