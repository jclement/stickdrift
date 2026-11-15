// Transport: how input leaves the phone. Two paths, best first:
//
//   1. P2P: a WebRTC data channel straight to the game, negotiated through
//      the relay. Unordered with no retransmits (newest snapshot wins), so a
//      lost packet never delays the next one. On a LAN this never touches
//      the internet.
//   2. RELAY: the Cloudflare WebSocket, always open, used whenever the data
//      channel isn't usable (still connecting, blocked by a firewall, gone
//      quiet, or the game doesn't speak WebRTC).
//
// Because P2P frames can be lost, every change is repeated twice shortly
// after, and the current snapshot is re-sent as a keepalive, so a dropped
// "button released" can never leave a button stuck. The host discards
// anything not newer than what it has (sequence numbers), so duplicates and
// path switches are harmless.
//
// A data channel can look "open" long after the network under it has gone
// (Wi-Fi blip, the phone switching networks, the game's page reloading). So
// the channel only counts as usable while the host echoes our pings: ping
// every 250 ms, and if no echo has come back for a second, input moves to the
// relay at once (the current snapshot is re-sent there, so a held button
// still arrives). If the quiet lasts, or ICE fails, or the network changes,
// we negotiate a fresh connection (the host replaces the old one), retrying
// with backoff until one sticks.
import { FRAME_PING, ICE_SERVERS, PING, PONG, type Signal, type ToPadMessage } from "../../shared/protocol";

/** Which path input is currently taking. */
export type Path = "p2p" | "relay" | "none";

/** Rolling latency statistics for one path. */
export class Stats {
  private samples: number[] = [];
  add(ms: number) {
    this.samples = [...this.samples.slice(-49), ms];
  }
  get last(): number {
    return this.samples[this.samples.length - 1] ?? 0;
  }
  get avg(): number {
    return this.samples.length ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length : 0;
  }
  get p90(): number {
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] ?? 0;
  }
  get count(): number {
    return this.samples.length;
  }
}

/** Everything the debug panel shows. */
export interface Debug {
  path: Path;
  wsState: string;
  iceState: string;
  dcState: string; // "open", or "open, no echo for 1.4 s" when it has gone quiet
  candidate: string; // e.g. "host ↔ host (udp)" once connected
  relayRtt: Stats;
  p2pRtt: Stats;
  framesSent: number;
  framesP2P: number;
  framesRelay: number;
  repeats: number;
  reconnects: number;
  p2pAttempts: number;
  p2pFallbacks: number; // times input fell back from P2P to the relay
  hostP2P: boolean;
}

const REPEAT_DELAYS = [25, 80]; // ms after a change to resend over P2P
const TICK_MS = 250; // keepalive, P2P ping and liveness check period
const RELAY_PING_MS = 1000; // relay round-trip sampling period
const STALE_MS = 1000; // no echo for this long: stop trusting the channel
const RESTART_STALE_MS = 3000; // no echo for this long: negotiate afresh
const ICE_DISCONNECTED_RESTART_MS = 2000; // ICE "disconnected" this long: negotiate afresh
const P2P_TIMEOUT_MS = 6000; // give up on a negotiation after this long
const RETRY_FIRST_MS = 1000; // first retry after a failure…
const RETRY_MAX_MS = 30000; // …doubling up to this
const HOST_BACK_CHECK_MS = 1500; // after the game reconnects, verify the channel within this

export class Transport {
  debug: Debug = {
    path: "none", wsState: "closed", iceState: "new", dcState: "none", candidate: "",
    relayRtt: new Stats(), p2pRtt: new Stats(), framesSent: 0, framesP2P: 0, framesRelay: 0,
    repeats: 0, reconnects: 0, p2pAttempts: 0, p2pFallbacks: 0, hostP2P: false,
  };
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private last: ArrayBuffer | null = null;
  private repeatTimers: ReturnType<typeof setTimeout>[] = [];
  private backoff = 250;
  private pingAt = 0;
  private lastEcho = 0; // performance.now() of the last P2P echo (or channel open)
  private iceDownSince = 0; // when ICE went "disconnected", 0 if it isn't
  private retryDelay = RETRY_FIRST_MS;
  private p2pTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private hostBackTimer: ReturnType<typeof setTimeout> | undefined;
  private intervals: ReturnType<typeof setInterval>[];
  private stopped = false;

  constructor(
    private url: string,
    private onMessage: (m: ToPadMessage) => void,
    private onClose: (code: number) => boolean, // return false to stop reconnecting
    private onChange: () => void,
  ) {
    this.intervals = [setInterval(() => this.tick(), TICK_MS), setInterval(() => this.ping(), RELAY_PING_MS)];
    // A new network means new addresses: the old ICE pair is dead even if
    // the channel hasn't noticed yet.
    const conn = (globalThis.navigator as { connection?: EventTarget } | undefined)?.connection;
    conn?.addEventListener?.("change", () => this.networkChanged());
    if (typeof window !== "undefined") window.addEventListener("online", () => this.networkChanged());
  }

  connect() {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.debug.wsState = "connecting";
    this.changed();
    ws.onopen = () => {
      this.backoff = 250;
      this.debug.wsState = "open";
      this.changed();
      if (this.last) this.sendFrame(this.last);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      if (ev.data === PONG) {
        this.debug.relayRtt.add(performance.now() - this.pingAt);
        this.changed();
        return;
      }
      const m = JSON.parse(ev.data) as ToPadMessage;
      this.onRelayMessage(m);
      this.onMessage(m);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.debug.wsState = "closed";
      if (this.debug.path === "relay") this.setPath("none");
      this.changed();
      if (!this.onClose(ev.code)) {
        // Kicked, full, replaced or no room: nothing more to send anywhere.
        this.stopped = true;
        this.stopP2P();
        return;
      }
      this.debug.reconnects++;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 3000);
    };
  }

  /** close stops everything (used by tests; the page just unloads). */
  close() {
    this.stopped = true;
    for (const t of this.intervals) clearInterval(t);
    clearTimeout(this.retryTimer);
    clearTimeout(this.hostBackTimer);
    this.stopP2P();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  /** sendFrame sends an input snapshot by the best available path. */
  sendFrame(frame: ArrayBuffer) {
    this.last = frame;
    this.debug.framesSent++;
    for (const t of this.repeatTimers) clearTimeout(t);
    this.repeatTimers = [];
    if (this.p2pUsable()) {
      this.dc!.send(frame);
      this.debug.framesP2P++;
      this.setPath("p2p");
      // Unreliable channel: say it again, shortly, in case one got lost.
      this.repeatTimers = REPEAT_DELAYS.map((d) =>
        setTimeout(() => {
          if (this.p2pUsable() && this.last === frame) {
            this.dc!.send(frame);
            this.debug.repeats++;
          }
        }, d),
      );
      return;
    }
    // The channel may be merely slow rather than dead: try it as well. The
    // host keeps whichever copy is newest.
    if (this.dcOpen()) this.dc!.send(frame);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
      this.debug.framesRelay++;
      this.setPath("relay");
    }
  }

  /** sendJSON sends a control message over the relay. */
  sendJSON(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** bestRtt is the round trip of the path in use, for the HUD badge. */
  bestRtt(): number {
    return this.debug.path === "p2p" ? this.debug.p2pRtt.avg : this.debug.relayRtt.avg;
  }

  /** networkChanged renegotiates P2P after the phone changes networks. */
  networkChanged() {
    if (!this.debug.hostP2P || this.stopped) return;
    this.retryDelay = RETRY_FIRST_MS;
    if (this.ws?.readyState === WebSocket.OPEN) this.startP2P();
    // Otherwise the relay is reconnecting too; its setup restarts P2P.
  }

  // ---- Relay messages that steer P2P ----

  private onRelayMessage(m: ToPadMessage) {
    if (m.t === "signal") void this.onSignal(m.data);
    if (m.t === "setup") {
      this.debug.hostP2P = m.p2p;
      if (!m.p2p) this.stopP2P();
      else if (!this.p2pUsable() && !this.negotiating()) this.startP2P();
    }
    if (m.t === "host" && m.online && this.debug.hostP2P) this.hostBack();
  }

  /** hostBack runs when the game (re)connects to the relay. Its side of our
   *  channel may have survived (a relay blip) or not (a page reload). */
  private hostBack() {
    if (!this.dcOpen() && !this.negotiating()) {
      this.retryDelay = RETRY_FIRST_MS;
      this.startP2P();
      return;
    }
    clearTimeout(this.hostBackTimer);
    this.hostBackTimer = setTimeout(() => {
      if (!this.p2pUsable() && this.ws?.readyState === WebSocket.OPEN && !this.stopped) {
        this.retryDelay = RETRY_FIRST_MS;
        this.startP2P();
      }
    }, HOST_BACK_CHECK_MS);
  }

  // ---- WebRTC ----

  private dcOpen(): boolean {
    return this.dc?.readyState === "open";
  }

  /** p2pUsable: the channel is open, ICE is up, and the host has echoed a
   *  ping recently. Only then does input go P2P alone. */
  private p2pUsable(): boolean {
    if (!this.dcOpen() || !this.pc) return false;
    const ice = this.pc.iceConnectionState;
    if (ice !== "connected" && ice !== "completed") return false;
    return performance.now() - this.lastEcho < STALE_MS;
  }

  /** negotiating: an offer is out and the channel hasn't opened yet. */
  private negotiating(): boolean {
    return !!this.pc && !this.dcOpen() && this.pc.iceConnectionState !== "failed" && this.pc.iceConnectionState !== "closed";
  }

  /** startP2P offers a fresh data channel to the host through the relay,
   *  replacing any existing one. */
  private startP2P() {
    if (typeof RTCPeerConnection === "undefined" || this.stopped) return;
    this.stopP2P();
    clearTimeout(this.retryTimer);
    this.debug.p2pAttempts++;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    const dc = pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 });
    dc.binaryType = "arraybuffer";
    this.dc = dc;
    this.debug.dcState = "connecting";
    this.debug.iceState = pc.iceConnectionState;
    dc.onopen = () => {
      if (this.dc !== dc) return;
      this.debug.dcState = "open";
      this.lastEcho = performance.now(); // grace until the first echo
      this.retryDelay = RETRY_FIRST_MS;
      clearTimeout(this.p2pTimer);
      if (this.last) this.sendFrame(this.last);
      void this.describeCandidate();
      this.changed();
    };
    dc.onclose = () => {
      if (this.dc !== dc) return;
      this.debug.dcState = "closed";
      this.fallBack();
      this.scheduleRetry();
    };
    dc.onmessage = (ev) => this.onChannelMessage(ev.data as ArrayBuffer);
    pc.onicecandidate = (ev) => this.sendJSON({ t: "signal", data: { type: "candidate", candidate: ev.candidate ? ev.candidate.toJSON() : null } satisfies Signal });
    pc.oniceconnectionstatechange = () => this.onIceState(pc);
    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (this.pc === pc) this.sendJSON({ t: "signal", data: { type: "offer", sdp: offer.sdp ?? "" } satisfies Signal });
      } catch {
        if (this.pc === pc) (this.stopP2P(), this.scheduleRetry());
      }
    })();
    // If it hasn't connected in a few seconds, stay on the relay for now.
    this.p2pTimer = setTimeout(() => {
      if (this.pc === pc && !this.dcOpen()) {
        this.stopP2P();
        this.scheduleRetry();
      }
    }, P2P_TIMEOUT_MS);
    this.changed();
  }

  private onIceState(pc: RTCPeerConnection) {
    if (this.pc !== pc) return;
    const ice = pc.iceConnectionState;
    this.debug.iceState = ice;
    if (ice === "disconnected") this.iceDownSince ||= performance.now();
    else this.iceDownSince = 0;
    if (ice === "connected" || ice === "completed") void this.describeCandidate(); // the pair can change after a blip
    if (ice === "failed") {
      this.stopP2P();
      this.scheduleRetry();
    } else if (!this.p2pUsable()) {
      this.fallBack();
    }
    this.changed();
  }

  private onChannelMessage(data: ArrayBuffer) {
    const b = new Uint8Array(data);
    if (b[0] !== FRAME_PING || b.length !== 8) return;
    const sent = new DataView(data).getUint32(4, true);
    this.lastEcho = performance.now();
    this.debug.p2pRtt.add(((performance.now() >>> 0) - sent) >>> 0);
    if (this.debug.path !== "p2p" && this.p2pUsable() && this.last) this.sendFrame(this.last); // back on P2P
    this.changed();
  }

  private async onSignal(s: Signal) {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (s.type === "answer") await pc.setRemoteDescription({ type: "answer", sdp: s.sdp });
      if (s.type === "candidate" && s.candidate) await pc.addIceCandidate(s.candidate);
    } catch {
      // A stale answer or candidate from a previous attempt; ignore.
    }
  }

  private stopP2P() {
    clearTimeout(this.p2pTimer);
    const { dc, pc } = this;
    this.dc = null;
    this.pc = null;
    dc?.close();
    pc?.close();
    this.iceDownSince = 0;
    this.debug.dcState = "none";
    this.debug.iceState = "closed";
    this.debug.candidate = "";
    this.fallBack();
  }

  /** fallBack moves input to the relay if it was on P2P, re-sending the
   *  current snapshot there so nothing sent into a dead channel is lost. */
  private fallBack() {
    if (this.debug.path !== "p2p") return;
    this.debug.p2pFallbacks++;
    this.setPath(this.ws?.readyState === WebSocket.OPEN ? "relay" : "none");
    if (this.last && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(this.last);
      this.debug.framesRelay++;
    }
  }

  /** scheduleRetry tries P2P again later, backing off on repeated failures. */
  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      if (this.debug.hostP2P && !this.p2pUsable() && !this.negotiating() && this.ws?.readyState === WebSocket.OPEN) this.startP2P();
    }, delay);
  }

  /** describeCandidate reads which network path ICE picked, for debugging. */
  private async describeCandidate() {
    const pc = this.pc;
    if (!pc) return;
    const stats = await pc.getStats();
    let pairId = "";
    stats.forEach((r) => {
      if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    stats.forEach((r) => {
      if (!pairId && r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pairId = r.id;
    });
    const pair = pairId ? stats.get(pairId) : undefined;
    if (!pair || this.pc !== pc) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    this.debug.candidate = `${local?.candidateType ?? "?"} ↔ ${remote?.candidateType ?? "?"} (${local?.protocol ?? "?"})`;
    this.changed();
  }

  // ---- Upkeep ----

  /** tick runs every 250 ms: P2P ping and keepalive, liveness, restarts. */
  private tick() {
    if (!this.dcOpen()) return;
    const b = new ArrayBuffer(8);
    const v = new DataView(b);
    v.setUint8(0, FRAME_PING);
    v.setUint32(4, performance.now() >>> 0, true);
    this.dc!.send(b);
    if (this.last) this.dc!.send(this.last); // keepalive: lost packets can't leave a button stuck
    const quiet = performance.now() - this.lastEcho;
    const status = quiet < STALE_MS ? "open" : `open, no echo for ${(quiet / 1000).toFixed(1)} s`;
    if (status !== this.debug.dcState) (this.debug.dcState = status), this.changed();
    if (!this.p2pUsable()) this.fallBack();
    const iceDown = this.iceDownSince ? performance.now() - this.iceDownSince : 0;
    if (quiet > RESTART_STALE_MS || iceDown > ICE_DISCONNECTED_RESTART_MS) {
      // Gone quiet for good: try a fresh connection now.
      if (this.ws?.readyState === WebSocket.OPEN) this.startP2P();
      else (this.stopP2P(), this.scheduleRetry());
    }
  }

  private ping() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.pingAt = performance.now();
      this.ws.send(PING);
    }
    // Tell the host how we're doing every few seconds.
    if (this.debug.relayRtt.count && Math.random() < 0.25) {
      this.sendJSON({ t: "rtt", ms: this.bestRtt(), via: this.debug.path === "p2p" ? "p2p" : "relay" });
    }
  }

  private setPath(p: Path) {
    if (this.debug.path !== p) {
      this.debug.path = p;
      this.changed();
    }
  }

  private changed() {
    this.onChange();
  }
}
