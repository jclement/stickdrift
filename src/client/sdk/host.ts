// ControllerHost: the browser-side host SDK. A game (or the demo page) opens
// a room, shows the join URL/QR, and reads pads. Published as /sdk.js with
// type declarations at /sdk.d.ts (built by scripts/sdk-dts.ts).
//
//   import { ControllerHost, pressed } from "https://controller.onewheelgeek.net/sdk.js";
//   const host = new ControllerHost({ title: "My Game", look: { layout: "dpad-ab" } });
//   host.on("open", (code, joinUrl) => showQr(joinUrl));
//   function frame() { for (const [n, p] of host.poll()) if (pressed(p, "A")) jump(n); }
//
// Resilience, in one place:
//   * The relay socket reconnects with backoff and the same code and key.
//     Pads stay seated while it does (the relay keeps them); pads on P2P keep
//     sending; relay-only pads have their buttons released so nothing sticks.
//     The relay's welcome is then reconciled: anyone missing has left.
//   * WebRTC signalling is handled one message at a time per pad, so a
//     candidate is never added before its offer has been applied.
//   * A phone whose data channel dies offers again; the new connection
//     replaces the old one, and the old one's late events are ignored.
//   * If another host takes the room with our key, we stop rather than fight.
import {
  Button,
  FRAME_PING,
  ICE_SERVERS,
  PING,
  PONG,
  decodeFrame,
  emptyState,
  randomCode,
  seqNewer,
  type ButtonName,
  type Signal,
  type HostMessage,
  type PadInfo,
  type PadLook,
  type PadState,
  type ToHostMessage,
} from "../../shared/protocol";

// Everything in the protocol module (Button, LAYOUTS, PadLook, Theme,
// CustomLayout, encodeFrame, …) is part of the SDK too.
export * from "../../shared/protocol";

/** Options for a host. Everything is optional. */
export interface HostOptions {
  /** Relay origin. Default: the origin this script was loaded from. */
  origin?: string;
  /** Reuse a room code (e.g. saved across a page reload, with its key). */
  code?: string;
  /** The host secret for that code: 16-128 characters. Default: random. */
  key?: string;
  /** Shown on the phones. */
  title?: string;
  /** Most phones in the room (default 16, the relay allows up to 64). */
  maxPads?: number;
  /** Default layout and styling for every pad. */
  look?: PadLook;
  /** Accept new phones (default true). Known phones can always rejoin. See setOpen. */
  open?: boolean;
  /** Accept WebRTC data channels from phones (default true when the browser has WebRTC). */
  p2p?: boolean;
}

/** One pad as the host tracks it. The object is stable for a seat: a
 *  returning phone gets the same Pad back. */
export interface Pad {
  /** Seat number, 0-based and stable per phone. Show players pad + 1. */
  pad: number;
  /** The phone's stable device id. */
  device: string;
  /** The phone is in the room. */
  connected: boolean;
  /** The latest snapshot, updated as frames arrive. */
  state: PadState;
  /** The phone's last reported round trip in ms, over the path in `via`. */
  rtt?: number;
  /** The path the phone reports sending input on. */
  via?: "p2p" | "relay";
  /** A direct WebRTC data channel to this phone is open and connected. */
  p2p: boolean;
  /** Input frames applied, for rate displays. */
  frames: number;
  /** Buttons pressed since the last poll() (bitmask, latched). poll() clears it. */
  presses: number;
  /** Buttons released since the last poll() (bitmask, latched). poll() clears it. */
  releases: number;
}

/** What poll() reports per pad: held buttons and the edges since the last poll. */
export interface PadPoll {
  /** Seat number. */
  pad: number;
  /** The snapshot at poll time (sticks, pointer, buttons). */
  state: PadState;
  /** Buttons down now (bitmask). Use held(poll, "A"). */
  held: number;
  /** Buttons that went down since the last poll, however briefly (bitmask). Use pressed(poll, "A"). */
  pressed: number;
  /** Buttons that went up since the last poll (bitmask). Use released(poll, "A"). */
  released: number;
  /** The phone is in the room. */
  connected: boolean;
  /** Input from this phone is arriving peer-to-peer. */
  p2p: boolean;
  /** The phone's last reported round trip in ms. */
  rtt?: number;
  /** The path the phone reports using. */
  via?: "p2p" | "relay";
}

/** Events a host emits. Subscribe with host.on(name, fn). */
export interface HostEvents {
  /** The room is live: show joinUrl as a QR code. Fires again after a reconnect. */
  open: (code: string, joinUrl: string) => void;
  /** A phone took a seat. rejoin: it had this seat before. */
  join: (pad: Pad, rejoin: boolean) => void;
  /** A phone left. Its buttons read as released. */
  leave: (pad: Pad) => void;
  /** A frame changed a pad's state. prev is the state before it. */
  input: (pad: Pad, prev: PadState) => void;
  /** A pad's round trip, path or P2P status changed. */
  rtt: (pad: Pad) => void;
  /** A pad's P2P data channel came up or went down (pad.p2p). */
  p2p: (pad: Pad) => void;
  /** The relay connection dropped; the host is reconnecting (unless closed or replaced). */
  close: () => void;
  /** The relay reported a problem. code "replaced": another host took the room; this one stopped. */
  error: (code: string, message: string) => void;
}

/** The relay closes a host socket with this when a newer one takes the room. */
const CLOSE_REPLACED = 4000;
/** Reconnect delays (ms): first try and cap. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 5000;
/** How often to ping the relay, for hostRtt. The relay answers without waking. */
const PING_EVERY_MS = 2000;

/** A room: opens it on the relay, tracks phones, and talks back to them. */
export class ControllerHost {
  /** The room code (may change once if the first choice was taken). */
  code: string;
  /** The host secret. Save it with the code to reclaim the room after a reload. */
  key: string;
  /** What the QR code should say; "" until the room is open. */
  joinUrl = "";
  /** Every seat seen this session, by number. Check pad.connected. */
  pads = new Map<number, Pad>();
  /** This page's round trip to the relay, in ms. */
  hostRtt = 0;
  private ws: WebSocket | null = null;
  private origin: string;
  private listeners: { [K in keyof HostEvents]?: HostEvents[K][] } = {};
  private closed = false;
  private backoff = BACKOFF_FIRST_MS;
  private pingAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private peers = new Map<number, RTCPeerConnection>();
  private signalChains = new Map<number, Promise<void>>(); // per-pad signalling, in order
  private fresh = new Set<number>(); // pads whose next frame resets sequencing

  /** Opens a room straight away; listen for "open" to get the join URL. */
  constructor(private opts: HostOptions = {}) {
    this.origin = opts.origin ?? new URL(import.meta.url).origin;
    this.code = opts.code ?? randomCode();
    this.key = opts.key ?? randomKey();
    this.connect();
    this.timer = setInterval(() => this.ping(), PING_EVERY_MS);
  }

  /** online reports whether the relay connection is up. */
  get online(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** on subscribes to an event. Returns the host, for chaining. */
  on<K extends keyof HostEvents>(ev: K, fn: HostEvents[K]): this {
    const list = (this.listeners[ev] ??= []) as unknown[];
    list.push(fn);
    return this;
  }

  /** off removes a listener added with on(). */
  off<K extends keyof HostEvents>(ev: K, fn: HostEvents[K]): this {
    const list = this.listeners[ev] as unknown[] | undefined;
    const i = list?.indexOf(fn) ?? -1;
    if (i >= 0) list!.splice(i, 1);
    return this;
  }

  /** setPad changes one pad's look. The relay merges it over what the pad had,
   *  so setPad(0, { label: "RED" }) changes only the label. */
  setPad(pad: number, look: PadLook) {
    this.send({ t: "pad", pad, ...look });
  }

  /** setLook changes the defaults for every pad. Remembered across reconnects. */
  setLook(look: PadLook) {
    this.opts.look = look;
    this.send({ t: "config", look });
  }

  /** haptic vibrates a phone: one duration in ms or an on/off pattern.
   *  Android only; iOS ignores vibration. */
  haptic(pad: number, ms: number | number[]) {
    this.send({ t: "haptic", pad, ms });
  }

  /** kick disconnects a phone and frees its seat. */
  kick(pad: number) {
    this.send({ t: "kick", pad });
  }

  /** setOpen allows or refuses new phones (known phones can always rejoin). */
  setOpen(open: boolean) {
    this.opts.open = open;
    this.send({ t: "config", open });
  }

  /** poll returns each pad's state plus the presses and releases latched
   *  since the last poll, so a tap shorter than a frame is never missed.
   *  Call it once per game frame. */
  poll(): Map<number, PadPoll> {
    const out = new Map<number, PadPoll>();
    for (const [n, p] of this.pads) {
      out.set(n, {
        pad: n, state: p.state, held: p.state.buttons, pressed: p.presses, released: p.releases,
        connected: p.connected, p2p: p.p2p, rtt: p.rtt, via: p.via,
      });
      p.presses = 0;
      p.releases = 0;
    }
    return out;
  }

  /** close shuts the room connection and every peer connection for good. */
  close() {
    this.closed = true;
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    clearInterval(this.timer);
    this.ws?.close();
  }

  // ---- Relay connection ----

  private connect() {
    const url = new URL(`/ws/host/${this.code}`, this.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("key", this.key);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      const p2p = this.opts.p2p !== false && typeof RTCPeerConnection !== "undefined";
      this.send({ t: "config", title: this.opts.title, maxPads: this.opts.maxPads, look: this.opts.look, open: this.opts.open ?? true, p2p });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return this.onFrame(ev.data as ArrayBuffer);
      if (ev.data === PONG) {
        this.hostRtt = performance.now() - this.pingAt;
        return;
      }
      this.onMessage(JSON.parse(ev.data) as ToHostMessage);
    };
    ws.onclose = (ev) => this.onRelayClose(ws, ev.code);
  }

  /** onRelayClose lets go of what we can no longer hear and reconnects. */
  private onRelayClose(ws: WebSocket, code: number) {
    if (this.ws !== ws) return;
    this.ws = null;
    // Pads stay seated until the next welcome says otherwise. Input from
    // relay-only pads can't reach us now, so release it; P2P pads carry on.
    for (const p of this.pads.values()) if (!p.p2p) this.releaseInput(p);
    if (code === CLOSE_REPLACED) {
      this.closed = true;
      this.emit("close");
      this.emit("error", "replaced", "another host connected with this room's key");
      return;
    }
    // Browsers report a refused upgrade (most likely the code is taken by
    // another key) as 1006 before any welcome. Pick another code.
    if (code === 1006 && !this.joinUrl) this.code = randomCode();
    this.emit("close");
    if (!this.closed) setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  private onMessage(m: ToHostMessage) {
    switch (m.t) {
      case "welcome":
        this.onWelcome(m.code, m.joinUrl, m.pads);
        break;
      case "join":
        this.join(m, true);
        break;
      case "leave":
        this.leave(m.pad);
        break;
      case "rtt": {
        const p = this.pads.get(m.pad);
        if (p) {
          p.rtt = m.ms;
          p.via = m.via;
          this.emit("rtt", p);
        }
        break;
      }
      case "signal":
        this.queueSignal(m.pad, m.data);
        break;
      case "error":
        this.emit("error", m.code, m.message);
        break;
    }
  }

  /** onWelcome goes live and reconciles pads with the relay's list. */
  private onWelcome(code: string, joinUrl: string, listed: PadInfo[]) {
    this.backoff = BACKOFF_FIRST_MS;
    this.code = code;
    this.joinUrl = joinUrl;
    this.emit("open", code, joinUrl);
    const here = new Set(listed.map((p) => p.pad));
    for (const info of listed) this.join({ ...info, rejoin: true }, false);
    for (const p of this.pads.values()) if (p.connected && !here.has(p.pad)) this.leave(p.pad);
  }

  /** join seats a phone. announce: the relay said "join" (always news);
   *  otherwise (a welcome) only a pad we didn't have is news. */
  private join(info: PadInfo, announce: boolean) {
    const existing = this.pads.get(info.pad);
    const p: Pad = existing ?? { pad: info.pad, device: info.device, connected: false, p2p: false, state: emptyState(), frames: 0, presses: 0, releases: 0 };
    const wasHere = p.connected;
    this.fresh.add(info.pad); // the phone may have restarted its sequence numbers
    p.connected = true;
    p.device = info.device;
    this.pads.set(info.pad, p);
    if (announce || !wasHere) this.emit("join", p, !!info.rejoin);
  }

  /** leave unseats a phone, releases its input and drops its peer connection. */
  private leave(n: number) {
    const p = this.pads.get(n);
    this.closePeer(n);
    if (!p) return;
    this.releaseInput(p);
    p.connected = false;
    p.p2p = false;
    this.emit("leave", p);
  }

  /** releaseInput lets go of everything a pad held, latching the releases. */
  private releaseInput(p: Pad) {
    p.releases |= p.state.buttons;
    p.state = { ...emptyState(), seq: p.state.seq, px: p.state.px, py: p.state.py };
  }

  private onFrame(buf: ArrayBuffer, viaPad?: number) {
    const f = decodeFrame(buf);
    if (!f) return;
    if (viaPad !== undefined) f.pad = viaPad; // data channel frames carry no pad number
    const p = this.pads.get(f.pad);
    if (!p) return;
    // Frames can arrive twice (P2P repeats, path switches) or late (UDP):
    // only a newer snapshot counts.
    if (this.fresh.delete(f.pad) === false && !seqNewer(f.state.seq, p.state.seq)) return;
    const prev = p.state;
    p.presses |= f.state.buttons & ~prev.buttons;
    p.releases |= prev.buttons & ~f.state.buttons;
    p.state = f.state;
    p.frames++;
    this.emit("input", p, prev);
  }

  // ---- WebRTC ----

  /** queueSignal handles a pad's signalling messages strictly in order. */
  private queueSignal(pad: number, s: Signal) {
    const prev = this.signalChains.get(pad) ?? Promise.resolve();
    const next = prev.then(() => this.onSignal(pad, s)).catch(() => {
      // A broken offer or a candidate for a replaced connection: the phone
      // will time out and offer again; the relay carries input meanwhile.
    });
    this.signalChains.set(pad, next);
  }

  /** onSignal answers a phone's offer (replacing any earlier connection) or
   *  adds a candidate to the current one. */
  private async onSignal(pad: number, s: Signal) {
    if (this.opts.p2p === false || typeof RTCPeerConnection === "undefined") return;
    if (s.type === "candidate") {
      if (s.candidate) await this.peers.get(pad)?.addIceCandidate(s.candidate);
      return;
    }
    if (s.type !== "offer") return;
    this.closePeer(pad);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(pad, pc);
    let dcOpen = false;
    const refresh = () => this.refreshP2P(pad, pc, dcOpen);
    pc.onicecandidate = (ev) => this.send({ t: "signal", pad, data: { type: "candidate", candidate: ev.candidate ? ev.candidate.toJSON() : null } });
    pc.oniceconnectionstatechange = () => {
      refresh();
      if (pc.iceConnectionState === "failed" && this.peers.get(pad) === pc) this.closePeer(pad);
    };
    pc.ondatachannel = (ev) => {
      const dc = ev.channel;
      dc.binaryType = "arraybuffer";
      dc.onopen = () => ((dcOpen = true), refresh());
      dc.onclose = () => ((dcOpen = false), refresh());
      dc.onmessage = (m) => {
        const data = m.data as ArrayBuffer;
        if (new Uint8Array(data)[0] === FRAME_PING) dc.send(data); // echo: the phone times the round trip
        else this.onFrame(data, pad);
      };
    };
    await pc.setRemoteDescription({ type: "offer", sdp: s.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.send({ t: "signal", pad, data: { type: "answer", sdp: answer.sdp ?? "" } });
  }

  /** closePeer drops pad n's connection and marks it off P2P. */
  private closePeer(n: number) {
    const pc = this.peers.get(n);
    if (!pc) return;
    this.peers.delete(n);
    pc.close();
    this.setP2P(n, false);
  }

  /** refreshP2P recomputes pad n's P2P flag, unless pc has been replaced. */
  private refreshP2P(n: number, pc: RTCPeerConnection, dcOpen: boolean) {
    if (this.peers.get(n) !== pc) return;
    const ice = pc.iceConnectionState;
    this.setP2P(n, dcOpen && (ice === "connected" || ice === "completed"));
  }

  private setP2P(n: number, on: boolean) {
    const p = this.pads.get(n);
    if (!p || p.p2p === on) return;
    p.p2p = on;
    this.emit("p2p", p);
    this.emit("rtt", p);
  }

  // ---- Upkeep ----

  private ping() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.pingAt = performance.now();
      this.ws.send(PING);
    }
  }

  private send(m: HostMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private emit<K extends keyof HostEvents>(ev: K, ...args: Parameters<HostEvents[K]>) {
    const list = (this.listeners[ev] ?? []) as unknown as ((...a: unknown[]) => void)[];
    for (const fn of [...list]) fn(...args);
  }
}

/** randomKey makes a 32-character host secret. */
function randomKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** down reports whether a button bit is set in a mask. */
export function down(mask: number, b: ButtonName): boolean {
  return (mask & (1 << Button[b])) !== 0;
}

/** held reports whether a button is down, from a poll() entry or a Pad.
 *  Undefined (no such pad) is never held. */
export function held(p: PadPoll | Pad | undefined, b: ButtonName): boolean {
  if (!p) return false;
  return down("held" in p ? p.held : p.state.buttons, b);
}

/** pressed reports whether a button went down since the previous poll(),
 *  however briefly: host.poll().get(0) then pressed(p, "A"). */
export function pressed(p: PadPoll | undefined, b: ButtonName): boolean {
  return !!p && down(p.pressed, b);
}

/** released reports whether a button went up since the previous poll(). */
export function released(p: PadPoll | undefined, b: ButtonName): boolean {
  return !!p && down(p.released, b);
}
