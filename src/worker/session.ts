// Session is the Durable Object that relays one room: one host (the game)
// and any number of pads (phones). It uses the WebSocket Hibernation API, so
// an idle room costs nothing; per-socket facts live in socket attachments
// and the room's settings in Durable Object storage, both of which survive
// hibernation.
//
// The hot path is webSocketMessage for a pad's binary frame: stamp the pad
// number into byte 1 and send it to the host. No parsing, no allocation
// beyond one copy, no awaits.
//
// Screen events (layout "screen") are the one pad message that carries game
// input as JSON. They are forwarded only when they answer the screen the
// pad is showing right now, so a host that never sends a screen never sees
// one.
import { DurableObject } from "cloudflare:workers";
import {
  FRAME_INPUT,
  FRAME_SIZE,
  PING,
  PONG,
  PROTOCOL_VERSION,
  checkEvent,
  cleanAvatar,
  cleanCustom,
  cleanScreen,
  cleanTheme,
  isLayout,
  type HostMessage,
  type PadInfo,
  type PadLook,
  type Screen,
  type Signal,
  type ToHostMessage,
  type ToPadMessage,
} from "../shared/protocol";

/** What we remember about each socket (kept across hibernation). */
type Attachment =
  | { role: "host" }
  | { role: "pad"; pad: number; device: string; name?: string };

/** Room settings persisted in storage. */
interface Room {
  code: string;
  hostKey: string;
  title: string;
  maxPads: number;
  open: boolean;
  look: PadLook; // defaults for new pads
  pads: Record<string, { pad: number; look: PadLook }>; // by device id
  lastHostSeen: number;
  p2p?: boolean; // host can answer WebRTC offers
}

/** Hard limits that keep a room from being abused. */
const MAX_PADS_LIMIT = 64;
/** Text limit: SDP offers run a few KB, and a look may carry a 24 KB avatar
 *  plus a screen of up to 24 elements. */
const MAX_TEXT_BYTES = 64 * 1024;
/** A host that has been gone this long loses its claim on the code. */
const HOST_CLAIM_TTL_MS = 30 * 60 * 1000;
/** Rooms with no host are wiped after this long. */
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

export class Session extends DurableObject<Env> {
  private room: Room | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Pings are answered by the runtime without waking the object, so
    // latency measurement is cheap and never contends with input.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<Room>("room")) ?? null;
    });
  }

  /** fetch handles the WebSocket upgrade for hosts and pads. */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(req.url);
    const code = url.searchParams.get("code") ?? "";
    if (url.searchParams.get("role") === "host") {
      return this.acceptHost(code, url.searchParams.get("key") ?? "", joinOrigin(url));
    }
    return this.acceptPad(url.searchParams.get("device") ?? "", url.searchParams.get("name") ?? undefined);
  }

  // ---- Hosts ----

  private async acceptHost(code: string, key: string, origin: string): Promise<Response> {
    if (key.length < 16 || key.length > 128) return new Response("host key must be 16-128 characters", { status: 400 });
    const room = this.room;
    const claimed = room && room.hostKey !== key;
    const stale = room && Date.now() - room.lastHostSeen > HOST_CLAIM_TTL_MS && this.hosts().length === 0;
    if (claimed && !stale) {
      // Someone else owns this code. The host should pick another.
      return new Response("room code in use", { status: 409 });
    }
    if (!room || claimed) {
      this.room = { code, hostKey: key, title: "", maxPads: 16, open: true, look: {}, pads: {}, lastHostSeen: Date.now() };
    }
    for (const old of this.hosts()) old.close(4000, "replaced by a new host connection");
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["host"]);
    server.serializeAttachment({ role: "host" } satisfies Attachment);
    this.room!.lastHostSeen = Date.now();
    await this.save();
    const pads: PadInfo[] = this.padSockets().map((ws) => this.padInfo(ws));
    this.sendJSON(server, { t: "welcome", code, joinUrl: `${origin}/j/${code}`, version: PROTOCOL_VERSION, pads } satisfies ToHostMessage);
    this.broadcastPads({ t: "host", online: true });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Pads ----

  private async acceptPad(device: string, name?: string): Promise<Response> {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(device)) return new Response("bad device id", { status: 400 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["pad"]);
    const room = this.room;
    if (!room) {
      // No game has ever claimed this code: tell the phone and hang up.
      this.sendJSON(server, { t: "host", online: false });
      server.close(4004, "no such room");
      return new Response(null, { status: 101, webSocket: client });
    }
    const pad = this.assignPad(room, device);
    if (pad < 0) {
      this.sendJSON(server, { t: "full" });
      server.close(4003, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }
    // One phone, one socket: a reconnect replaces the previous connection.
    for (const ws of this.padSockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      if (a.role === "pad" && a.device === device && ws !== server) ws.close(4001, "replaced by a new connection");
    }
    const rejoin = device in room.pads;
    room.pads[device] ??= { pad, look: {} };
    await this.save();
    server.serializeAttachment({ role: "pad", pad, device, name: name?.slice(0, 24) } satisfies Attachment);
    this.sendSetup(server, room, device);
    this.sendJSON(server, { t: "host", online: this.hosts().length > 0 });
    this.toHost({ t: "join", pad, device, name: name?.slice(0, 24), rejoin });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** assignPad returns the device's previous pad number or the lowest free one. */
  private assignPad(room: Room, device: string): number {
    const known = room.pads[device];
    if (known) return known.pad;
    if (!room.open) return -1;
    const used = new Set(Object.values(room.pads).map((p) => p.pad));
    for (let i = 0; i < room.maxPads; i++) if (!used.has(i)) return i;
    // Full of remembered devices: recycle a slot whose phone is gone.
    const live = new Set(this.padSockets().map((ws) => (ws.deserializeAttachment() as { pad: number }).pad));
    for (const [dev, p] of Object.entries(room.pads)) {
      if (!live.has(p.pad)) {
        delete room.pads[dev];
        return p.pad;
      }
    }
    return -1;
  }

  private sendSetup(ws: WebSocket, room: Room, device: string) {
    const p = room.pads[device];
    const look: PadLook = { ...room.look, ...p.look };
    if (look.screen) look.screen = this.withPlayers(room, look.screen);
    this.sendJSON(ws, { t: "setup", pad: p.pad, title: room.title, version: PROTOCOL_VERSION, p2p: !!room.p2p, ...look } satisfies ToPadMessage);
  }

  /** withPlayers fills in the colour and avatar of every choice that names a
   *  pad, from that pad's look, so a vote can show who is who. */
  private withPlayers(room: Room, screen: Screen): Screen {
    if (!screen.items.some((e) => e.options?.some((o) => o.pad !== undefined))) return screen;
    const byPad = new Map(Object.values(room.pads).map((p) => [p.pad, { ...room.look, ...p.look }]));
    return {
      ...screen,
      items: screen.items.map((e) =>
        e.options
          ? {
              ...e,
              options: e.options.map((o) => {
                const who = o.pad === undefined ? undefined : byPad.get(o.pad);
                if (!who) return o;
                return { ...o, color: o.color ?? who.color, avatar: who.avatar || undefined };
              }),
            }
          : e,
      ),
    };
  }

  /** screenOf is the screen a pad shows now: its look merged over the
   *  room's, and only while its layout is "screen". */
  private screenOf(room: Room, pad: number): Screen | undefined {
    const entry = Object.values(room.pads).find((p) => p.pad === pad);
    if (!entry) return undefined;
    const look = { ...room.look, ...entry.look };
    return look.layout === "screen" ? (look.screen ?? undefined) : undefined;
  }

  // ---- Messages ----

  async webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment;
    if (a.role === "pad") {
      if (typeof msg !== "string") {
        this.relayInput(a.pad, msg);
        return;
      }
      this.padText(a, msg);
      return;
    }
    if (typeof msg === "string" && msg.length <= MAX_TEXT_BYTES) await this.hostText(msg);
  }

  /** relayInput is the hot path: stamp the pad number and forward. */
  private relayInput(pad: number, frame: ArrayBuffer) {
    if (frame.byteLength !== FRAME_SIZE) return;
    const out = new Uint8Array(frame.slice(0));
    if (out[0] !== FRAME_INPUT) return;
    out[1] = pad;
    for (const host of this.hosts()) host.send(out);
  }

  private padText(a: Extract<Attachment, { role: "pad" }>, msg: string) {
    if (msg.length > MAX_TEXT_BYTES) return;
    let m: { t?: string; ms?: number; via?: string; data?: Signal; screen?: unknown };
    try {
      m = JSON.parse(msg);
    } catch {
      return;
    }
    if (m.t === "rtt" && typeof m.ms === "number") {
      this.toHost({ t: "rtt", pad: a.pad, ms: Math.round(m.ms), via: m.via === "p2p" ? "p2p" : "relay" });
    }
    if (m.t === "signal" && m.data && typeof m.data === "object") this.toHost({ t: "signal", pad: a.pad, data: m.data });
    if (m.t === "event" && this.room) {
      // Only an answer to the screen this pad shows now, with a clean value.
      const ev = checkEvent(this.screenOf(this.room, a.pad), m);
      if (ev) this.toHost({ ...ev, pad: a.pad });
    }
  }

  private async hostText(msg: string) {
    const room = this.room;
    if (!room) return;
    let m: HostMessage;
    try {
      m = JSON.parse(msg);
    } catch {
      return;
    }
    switch (m.t) {
      case "config":
        if (typeof m.title === "string") room.title = m.title.slice(0, 40);
        if (typeof m.maxPads === "number") room.maxPads = Math.max(1, Math.min(MAX_PADS_LIMIT, Math.floor(m.maxPads)));
        if (typeof m.open === "boolean") room.open = m.open;
        if (typeof m.p2p === "boolean") room.p2p = m.p2p;
        if (m.look) room.look = cleanLook(m.look);
        if (room.look.screen === null) delete room.look.screen; // null only means something in a pad look
        await this.save();
        for (const ws of this.padSockets()) this.sendSetup(ws, room, (ws.deserializeAttachment() as { device: string }).device);
        return;
      case "pad": {
        const entry = Object.entries(room.pads).find(([, p]) => p.pad === m.pad);
        if (!entry) return;
        entry[1].look = { ...entry[1].look, ...cleanLook(m) };
        // screen: null removes the pad's own screen, so the room's shows.
        if (entry[1].look.screen === null) delete entry[1].look.screen;
        await this.save();
        for (const ws of this.padSocketsFor(m.pad)) this.sendSetup(ws, room, entry[0]);
        return;
      }
      case "signal":
        if (m.data && typeof m.data === "object") for (const ws of this.padSocketsFor(m.pad)) this.sendJSON(ws, { t: "signal", data: m.data });
        return;
      case "haptic":
        for (const ws of this.padSocketsFor(m.pad)) this.sendJSON(ws, { t: "haptic", ms: m.ms });
        return;
      case "kick": {
        for (const ws of this.padSocketsFor(m.pad)) {
          this.sendJSON(ws, { t: "kicked" });
          ws.close(4002, "kicked by host");
        }
        for (const [dev, p] of Object.entries(room.pads)) if (p.pad === m.pad) delete room.pads[dev];
        await this.save();
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // Complete the closing handshake: without this a client that closes
    // first waits for a reply that never comes.
    try {
      ws.close(code >= 1000 && code !== 1005 && code !== 1006 && code < 5000 ? code : 1000, "bye");
    } catch {
      // Already closed.
    }
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    if (a.role === "pad") {
      // Only report a leave if this device has no newer socket.
      const stillHere = this.padSockets().some((o) => o !== ws && (o.deserializeAttachment() as Attachment).role === "pad" && (o.deserializeAttachment() as { device: string }).device === a.device);
      if (!stillHere && code !== 4001) this.toHost({ t: "leave", pad: a.pad });
      return;
    }
    if (this.hosts().filter((h) => h !== ws).length === 0) {
      this.broadcastPads({ t: "host", online: false });
      if (this.room) {
        this.room.lastHostSeen = Date.now();
        await this.save();
      }
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1006);
  }

  /** alarm wipes a room nobody has hosted for ROOM_TTL_MS. */
  async alarm(): Promise<void> {
    if (this.hosts().length > 0) return;
    for (const ws of this.ctx.getWebSockets()) ws.close(4004, "room expired");
    this.room = null;
    await this.ctx.storage.deleteAll();
  }

  // ---- Helpers ----

  private hosts(): WebSocket[] {
    return this.ctx.getWebSockets("host");
  }

  private padSockets(): WebSocket[] {
    return this.ctx.getWebSockets("pad").filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.role === "pad");
  }

  private padSocketsFor(pad: number): WebSocket[] {
    return this.padSockets().filter((ws) => (ws.deserializeAttachment() as { pad: number }).pad === pad);
  }

  private padInfo(ws: WebSocket): PadInfo {
    const a = ws.deserializeAttachment() as Extract<Attachment, { role: "pad" }>;
    return { pad: a.pad, device: a.device, name: a.name, rejoin: true };
  }

  private toHost(m: ToHostMessage) {
    for (const h of this.hosts()) this.sendJSON(h, m);
  }

  private broadcastPads(m: ToPadMessage) {
    for (const ws of this.padSockets()) this.sendJSON(ws, m);
  }

  private sendJSON(ws: WebSocket, m: unknown) {
    try {
      ws.send(JSON.stringify(m));
    } catch {
      // Socket already closing; the close handler tidies up.
    }
  }

  private async save() {
    if (this.room) await this.ctx.storage.put("room", this.room);
  }
}

/** cleanLook keeps only known, size-limited presentation fields. */
function cleanLook(l: PadLook): PadLook {
  const out: PadLook = {};
  if (typeof l.layout === "string" && isLayout(l.layout)) out.layout = l.layout;
  if (typeof l.label === "string") out.label = l.label.slice(0, 24);
  if (typeof l.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(l.color)) out.color = l.color;
  if (typeof l.message === "string") out.message = l.message.slice(0, 80);
  if (typeof l.swap === "boolean") out.swap = l.swap;
  if (typeof l.diagonals === "boolean") out.diagonals = l.diagonals;
  if (typeof l.banner === "string") out.banner = l.banner.slice(0, 16);
  if (l.avatar === "") {
    out.avatar = ""; // an empty string clears a previously set avatar
  } else if (l.avatar !== undefined) {
    const avatar = cleanAvatar(l.avatar);
    if (avatar) out.avatar = avatar;
  }
  if (l.theme) {
    const theme = cleanTheme(l.theme);
    if (theme) out.theme = theme;
  }
  if (l.custom) {
    const custom = cleanCustom(l.custom);
    if (custom) out.custom = custom;
  }
  if (l.screen === null) {
    out.screen = null; // a pad look's way of falling back to the room's screen
  } else if (l.screen !== undefined) {
    const screen = cleanScreen(l.screen);
    if (screen) out.screen = screen;
  }
  if (l.labels && typeof l.labels === "object") {
    out.labels = {};
    for (const [k, v] of Object.entries(l.labels)) if (typeof v === "string") (out.labels as Record<string, string>)[k] = v.slice(0, 10);
  }
  return out;
}

/** joinOrigin is the origin phones should use. Normally the request's own;
 *  a host may pass ?origin= (http/https, host and port only), which matters
 *  under `wrangler dev`, where the request URL is rewritten to the public
 *  route and a LAN phone could never reach it. The value only ever goes back
 *  to that same host, in its welcome message. */
function joinOrigin(url: URL): string {
  const o = url.searchParams.get("origin") ?? "";
  return /^https?:\/\/[A-Za-z0-9.\-[\]:]{1,100}$/.test(o) ? o : url.origin;
}
