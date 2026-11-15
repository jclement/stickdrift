// Stand-ins for the browser's WebSocket and WebRTC classes, so the host SDK
// and the phone transport can be tested in vitest without a browser. They
// record what the code under test does and let a test drive events by hand.

/** A scripted WebSocket. Tests call open(), json(), frame() and drop(). */
export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  sent: (string | ArrayBuffer)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;

  constructor(public url: string | URL) {
    FakeSocket.instances.push(this);
  }

  /** latest is the most recently created socket. */
  static latest(): FakeSocket {
    const s = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!s) throw new Error("no socket created");
    return s;
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  // ---- test controls ----

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  json(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }

  text(s: string) {
    this.onmessage?.({ data: s });
  }

  frame(buf: ArrayBuffer) {
    this.onmessage?.({ data: buf });
  }

  drop(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }

  /** messages returns the JSON messages sent, optionally of one type. */
  messages(t?: string): Record<string, unknown>[] {
    return this.sent
      .filter((d): d is string => typeof d === "string" && d.startsWith("{"))
      .map((d) => JSON.parse(d) as Record<string, unknown>)
      .filter((m) => !t || m.t === t);
  }
}

/** A scripted data channel. */
export class FakeChannel {
  static instances: FakeChannel[] = [];
  readyState: RTCDataChannelState = "connecting";
  binaryType = "blob";
  sent: ArrayBuffer[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(public label = "input") {
    FakeChannel.instances.push(this);
  }

  send(d: ArrayBuffer) {
    this.sent.push(d);
  }

  close() {
    this.readyState = "closed";
  }

  // ---- test controls ----

  open() {
    this.readyState = "open";
    this.onopen?.();
  }

  closeNow() {
    this.readyState = "closed";
    this.onclose?.();
  }

  message(buf: ArrayBuffer) {
    this.onmessage?.({ data: buf });
  }
}

/** A scripted RTCPeerConnection: no network, but it enforces the rule that
 *  candidates need a remote description first, like real browsers. */
export class FakePeer {
  static instances: FakePeer[] = [];
  iceConnectionState: RTCIceConnectionState = "new";
  remote: { type: string; sdp?: string } | null = null;
  local: { type: string; sdp?: string } | null = null;
  candidates: unknown[] = [];
  closed = false;
  channels: FakeChannel[] = [];
  onicecandidate: ((ev: { candidate: null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: FakeChannel }) => void) | null = null;

  constructor(public config?: unknown) {
    FakePeer.instances.push(this);
  }

  async setRemoteDescription(d: { type: string; sdp?: string }) {
    await new Promise((r) => setTimeout(r, 5)); // real ones are async too
    this.remote = d;
  }

  async setLocalDescription(d?: { type: string; sdp?: string }) {
    this.local = d ?? { type: "offer", sdp: "fake-offer" };
  }

  async createAnswer() {
    return { type: "answer", sdp: "fake-answer" };
  }

  async createOffer() {
    return { type: "offer", sdp: "fake-offer" };
  }

  async addIceCandidate(c: unknown) {
    if (!this.remote) throw new Error("addIceCandidate before setRemoteDescription");
    this.candidates.push(c);
  }

  createDataChannel(label: string): FakeChannel {
    const dc = new FakeChannel(label);
    this.channels.push(dc);
    return dc;
  }

  close() {
    this.closed = true;
    this.iceConnectionState = "closed";
  }

  async getStats() {
    return new Map();
  }

  // ---- test controls ----

  setIce(state: RTCIceConnectionState) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }

  /** connect plays the phone side opening its channel (host perspective). */
  connect(): FakeChannel {
    this.setIce("connected");
    const dc = new FakeChannel();
    this.channels.push(dc);
    this.ondatachannel?.({ channel: dc });
    dc.open();
    return dc;
  }
}

/** resetFakes clears instance lists between tests. */
export function resetFakes() {
  FakeSocket.instances = [];
  FakePeer.instances = [];
  FakeChannel.instances = [];
}

/** settle lets pending promises and short timers run. */
export const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
