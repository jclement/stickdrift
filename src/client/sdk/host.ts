// ControllerHost: the browser-side host SDK. A game (or the demo page) opens
// a room, shows the join URL/QR, and reads pads. Published as /sdk.js.
//
//   import { ControllerHost } from "https://controller.onewheelgeek.net/sdk.js";
//   const host = new ControllerHost({ title: "My Game", look: { layout: "dpad-ab" } });
//   host.on("join", (pad) => console.log("player", pad.pad));
//   function frame() { for (const [n, p] of host.poll()) if (p.pressed & 1 << 4) jump(n); }
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

export { Button, type ButtonName, type PadLook, type PadState };

/** Options for a host. Everything is optional. */
export interface HostOptions {
  origin?: string; // default: this script's origin
  code?: string; // reuse a room code (e.g. after reload)
  key?: string; // host secret for that code
  title?: string;
  maxPads?: number;
  look?: PadLook; // default layout and styling for every pad
  p2p?: boolean; // accept WebRTC data channels from phones (default true)
}

/** One pad as the host tracks it. */
export interface Pad {
  pad: number;
  device: string;
  connected: boolean;
  state: PadState;
  rtt?: number;
  via?: "p2p" | "relay"; // the path the phone reports using
  p2p: boolean; // a data channel to this phone is open
  frames: number; // input frames received, for rate displays
  presses: number; // bits pressed since the last poll (latched)
  releases: number;
}

/** What poll() reports per pad: held buttons and edges since the last poll. */
export interface PadPoll {
  state: PadState;
  held: number;
  pressed: number;
  released: number;
}

type Events = {
  open: (code: string, joinUrl: string) => void;
  join: (pad: Pad, rejoin: boolean) => void;
  leave: (pad: Pad) => void;
  input: (pad: Pad, prev: PadState) => void;
  rtt: (pad: Pad) => void;
  close: () => void;
  error: (code: string, message: string) => void;
};

export class ControllerHost {
  code: string;
  key: string;
  joinUrl = "";
  pads = new Map<number, Pad>();
  hostRtt = 0;
  private ws: WebSocket | null = null;
  private origin: string;
  private listeners: { [K in keyof Events]?: Events[K][] } = {};
  private closed = false;
  private backoff = 250;
  private pingAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private peers = new Map<number, RTCPeerConnection>();
  private fresh = new Set<number>(); // pads whose next frame resets sequencing

  constructor(private opts: HostOptions = {}) {
    this.origin = opts.origin ?? new URL(import.meta.url).origin;
    this.code = opts.code ?? randomCode();
    this.key = opts.key ?? randomKey();
    this.connect();
    this.timer = setInterval(() => this.ping(), 2000);
  }

  on<K extends keyof Events>(ev: K, fn: Events[K]): this {
    const list = (this.listeners[ev] ??= []) as unknown[];
    list.push(fn);
    return this;
  }

  /** setPad changes one pad's layout, label, colour or button labels. */
  setPad(pad: number, look: PadLook) {
    this.send({ t: "pad", pad, ...look });
  }

  /** setLook changes the defaults for every pad. */
  setLook(look: PadLook) {
    this.opts.look = look;
    this.send({ t: "config", look });
  }

  /** haptic buzzes a phone (Android; iOS ignores vibration). */
  haptic(pad: number, ms: number | number[]) {
    this.send({ t: "haptic", pad, ms });
  }

  kick(pad: number) {
    this.send({ t: "kick", pad });
  }

  /** setOpen allows or refuses new phones. */
  setOpen(open: boolean) {
    this.send({ t: "config", open });
  }

  /** poll returns each pad's state plus the presses and releases latched
   *  since the last poll, so a tap shorter than a frame is never missed. */
  poll(): Map<number, PadPoll> {
    const out = new Map<number, PadPoll>();
    for (const [n, p] of this.pads) {
      out.set(n, { state: p.state, held: p.state.buttons, pressed: p.presses, released: p.releases });
      p.presses = 0;
      p.releases = 0;
    }
    return out;
  }

  close() {
    for (const pc of this.peers.values()) pc.close();
    this.closed = true;
    clearInterval(this.timer);
    this.ws?.close();
  }

  // ---- internals ----

  private connect() {
    const url = new URL(`/ws/host/${this.code}`, this.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("key", this.key);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 250;
      const p2p = this.opts.p2p !== false && typeof RTCPeerConnection !== "undefined";
      this.send({ t: "config", title: this.opts.title, maxPads: this.opts.maxPads, look: this.opts.look, open: true, p2p });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return this.onFrame(ev.data as ArrayBuffer);
      if (ev.data === PONG) {
        this.hostRtt = performance.now() - this.pingAt;
        return;
      }
      this.onMessage(JSON.parse(ev.data) as ToHostMessage);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      for (const p of this.pads.values()) this.drop(p);
      if (ev.code === 1006 && !this.joinUrl) {
        // The upgrade was refused: most likely the code is taken. Pick another.
        this.code = randomCode();
      }
      this.emit("close");
      if (!this.closed) setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
  }

  private onMessage(m: ToHostMessage) {
    switch (m.t) {
      case "welcome":
        this.code = m.code;
        this.joinUrl = m.joinUrl;
        this.emit("open", m.code, m.joinUrl);
        for (const p of m.pads) this.join(p);
        break;
      case "join":
        this.join(m);
        break;
      case "leave": {
        const p = this.pads.get(m.pad);
        if (p) {
          this.drop(p);
          this.emit("leave", p);
        }
        break;
      }
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
        void this.onSignal(m.pad, m.data);
        break;
      case "error":
        this.emit("error", m.code, m.message);
        break;
    }
  }

  private join(info: PadInfo) {
    const existing = this.pads.get(info.pad);
    const p: Pad = existing ?? { pad: info.pad, device: info.device, connected: true, p2p: false, state: emptyState(), frames: 0, presses: 0, releases: 0 };
    this.fresh.add(info.pad); // a (re)joined phone restarts its sequence numbers
    p.connected = true;
    p.device = info.device;
    this.pads.set(info.pad, p);
    this.emit("join", p, !!info.rejoin);
  }

  /** drop releases everything a pad held, so nothing sticks when it goes. */
  private drop(p: Pad) {
    p.releases |= p.state.buttons;
    p.state = { ...emptyState(), seq: p.state.seq };
    p.connected = false;
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

  /** onSignal answers a phone's offer and wires its data channel. */
  private async onSignal(pad: number, s: Signal) {
    if (s.type === "offer") {
      this.peers.get(pad)?.close();
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      this.peers.set(pad, pc);
      pc.onicecandidate = (ev) => this.send({ t: "signal", pad, data: { type: "candidate", candidate: ev.candidate ? ev.candidate.toJSON() : null } });
      pc.ondatachannel = (ev) => {
        const dc = ev.channel;
        dc.binaryType = "arraybuffer";
        dc.onopen = () => this.setP2P(pad, true);
        dc.onclose = () => this.setP2P(pad, false);
        dc.onmessage = (m) => {
          const data = m.data as ArrayBuffer;
          if (new Uint8Array(data)[0] === FRAME_PING) dc.send(data); // echo for the phone's RTT
          else this.onFrame(data, pad);
        };
      };
      await pc.setRemoteDescription({ type: "offer", sdp: s.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send({ t: "signal", pad, data: { type: "answer", sdp: answer.sdp ?? "" } });
      return;
    }
    if (s.type === "candidate" && s.candidate) {
      try {
        await this.peers.get(pad)?.addIceCandidate(s.candidate);
      } catch {
        // Candidate for a connection we've since replaced.
      }
    }
  }

  private setP2P(pad: number, on: boolean) {
    const p = this.pads.get(pad);
    if (p) {
      p.p2p = on;
      this.emit("rtt", p);
    }
  }

  private ping() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.pingAt = performance.now();
      this.ws.send(PING);
    }
  }

  private send(m: HostMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private emit<K extends keyof Events>(ev: K, ...args: Parameters<Events[K]>) {
    const list = (this.listeners[ev] ?? []) as unknown as ((...a: unknown[]) => void)[];
    for (const fn of list) fn(...args);
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
