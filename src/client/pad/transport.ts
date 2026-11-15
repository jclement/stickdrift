// Transport: how input leaves the phone. Two paths, best first:
//
//   1. P2P: a WebRTC data channel straight to the game, negotiated through
//      the relay. Unordered with no retransmits (newest snapshot wins), so a
//      lost packet never delays the next one. On a LAN this never touches
//      the internet.
//   2. RELAY: the Cloudflare WebSocket, always open, used whenever the data
//      channel isn't (still connecting, blocked by a firewall, or the game
//      doesn't speak WebRTC).
//
// Because P2P frames can be lost, every change is repeated twice shortly
// after, and the current snapshot is re-sent as a keepalive, so a dropped
// "button released" can never leave a button stuck. The host discards
// anything not newer than what it has (sequence numbers), so duplicates and
// path switches are harmless.
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
  dcState: string;
  candidate: string; // e.g. "host ↔ host (udp)" once connected
  relayRtt: Stats;
  p2pRtt: Stats;
  framesSent: number;
  framesP2P: number;
  framesRelay: number;
  repeats: number;
  reconnects: number;
  p2pAttempts: number;
  hostP2P: boolean;
}

const REPEAT_DELAYS = [25, 80]; // ms after a change to resend over P2P
const KEEPALIVE_MS = 250; // resend the current snapshot over P2P this often
const P2P_TIMEOUT_MS = 6000; // give up on a negotiation after this long
const P2P_RETRY_MS = 15000; // try again this long after a failure

export class Transport {
  debug: Debug = {
    path: "none", wsState: "closed", iceState: "new", dcState: "none", candidate: "",
    relayRtt: new Stats(), p2pRtt: new Stats(), framesSent: 0, framesP2P: 0, framesRelay: 0,
    repeats: 0, reconnects: 0, p2pAttempts: 0, hostP2P: false,
  };
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private last: ArrayBuffer | null = null;
  private repeatTimers: ReturnType<typeof setTimeout>[] = [];
  private backoff = 250;
  private pingAt = 0;
  private p2pTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private url: string,
    private onMessage: (m: ToPadMessage) => void,
    private onClose: (code: number) => boolean, // return false to stop reconnecting
    private onChange: () => void,
  ) {
    setInterval(() => this.keepalive(), KEEPALIVE_MS);
    setInterval(() => this.ping(), 1000);
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
      if (m.t === "signal") void this.onSignal(m.data);
      if (m.t === "setup") {
        this.debug.hostP2P = m.p2p;
        if (m.p2p && !this.pc) this.startP2P();
      }
      if (m.t === "host" && m.online && this.debug.hostP2P && !this.dcOpen()) this.startP2P();
      this.onMessage(m);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.debug.wsState = "closed";
      this.changed();
      if (!this.onClose(ev.code)) return;
      this.debug.reconnects++;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 3000);
    };
  }

  /** sendFrame sends an input snapshot by the best available path. */
  sendFrame(frame: ArrayBuffer) {
    this.last = frame;
    this.debug.framesSent++;
    for (const t of this.repeatTimers) clearTimeout(t);
    this.repeatTimers = [];
    if (this.dcOpen()) {
      this.dc!.send(frame);
      this.debug.framesP2P++;
      this.setPath("p2p");
      // Unreliable channel: say it again, shortly, in case one got lost.
      this.repeatTimers = REPEAT_DELAYS.map((d) =>
        setTimeout(() => {
          if (this.dcOpen() && this.last === frame) {
            this.dc!.send(frame);
            this.debug.repeats++;
          }
        }, d),
      );
      return;
    }
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

  // ---- WebRTC ----

  private dcOpen(): boolean {
    return this.dc?.readyState === "open";
  }

  /** startP2P offers a data channel to the host through the relay. */
  private startP2P() {
    if (typeof RTCPeerConnection === "undefined") return;
    this.stopP2P();
    this.debug.p2pAttempts++;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    const dc = pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 });
    dc.binaryType = "arraybuffer";
    this.dc = dc;
    this.debug.dcState = "connecting";
    dc.onopen = () => {
      this.debug.dcState = "open";
      clearTimeout(this.p2pTimer);
      if (this.last) this.sendFrame(this.last);
      void this.describeCandidate();
      this.changed();
    };
    dc.onclose = () => {
      this.debug.dcState = "closed";
      this.setPath(this.ws ? "relay" : "none");
      this.scheduleRetry();
    };
    dc.onmessage = (ev) => {
      const b = new Uint8Array(ev.data as ArrayBuffer);
      if (b[0] === FRAME_PING && b.length === 8) {
        const sent = new DataView(ev.data as ArrayBuffer).getUint32(4, true);
        this.debug.p2pRtt.add(((performance.now() >>> 0) - sent) >>> 0);
        this.changed();
      }
    };
    pc.onicecandidate = (ev) => this.sendJSON({ t: "signal", data: { type: "candidate", candidate: ev.candidate ? ev.candidate.toJSON() : null } satisfies Signal });
    pc.oniceconnectionstatechange = () => {
      this.debug.iceState = pc.iceConnectionState;
      if (pc.iceConnectionState === "failed") {
        this.stopP2P();
        this.scheduleRetry();
      }
      this.changed();
    };
    void (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendJSON({ t: "signal", data: { type: "offer", sdp: offer.sdp ?? "" } satisfies Signal });
    })();
    // If it hasn't connected in a few seconds, stay on the relay for now.
    this.p2pTimer = setTimeout(() => {
      if (!this.dcOpen()) {
        this.stopP2P();
        this.scheduleRetry();
      }
    }, P2P_TIMEOUT_MS);
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
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    this.debug.dcState = "none";
    this.debug.iceState = "closed";
    this.debug.candidate = "";
    if (this.debug.path === "p2p") this.setPath(this.ws ? "relay" : "none");
  }

  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.debug.hostP2P && !this.dcOpen() && this.ws?.readyState === WebSocket.OPEN) this.startP2P();
    }, P2P_RETRY_MS);
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
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    this.debug.candidate = `${local?.candidateType ?? "?"} ↔ ${remote?.candidateType ?? "?"} (${local?.protocol ?? "?"})`;
    this.changed();
  }

  // ---- Upkeep ----

  private keepalive() {
    if (this.dcOpen() && this.last) this.dc!.send(this.last);
  }

  private ping() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.pingAt = performance.now();
      this.ws.send(PING);
    }
    if (this.dcOpen()) {
      const b = new ArrayBuffer(8);
      const v = new DataView(b);
      v.setUint8(0, FRAME_PING);
      v.setUint32(4, performance.now() >>> 0, true);
      this.dc!.send(b);
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
