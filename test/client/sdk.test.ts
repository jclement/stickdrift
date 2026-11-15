// The browser host SDK against scripted sockets and peers: input and edges,
// the poll helpers, per-pad P2P and RTT, relay reconnects, and WebRTC
// re-offers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, ControllerHost, StickDriftHost, encodeFrame, emptyState, held, pressed, released, type Pad } from "../../src/client/sdk/host";
import { FakePeer, FakeSocket, resetFakes, settle } from "./fakes";

const frame = (seq: number, buttons: number, pad = 0) => encodeFrame({ ...emptyState(), seq, buttons }, pad);
const A = 1 << Button.A;
const B = 1 << Button.B;

/** start makes a host on a fake relay and welcomes it with some pads. */
function start(pads: number[] = [], opts: { p2p?: boolean } = {}) {
  const host = new StickDriftHost({ origin: "https://relay.test", code: "ABCDE", key: "0123456789abcdef0123", ...opts });
  const ws = FakeSocket.latest();
  ws.open();
  ws.json({ t: "welcome", code: "ABCDE", joinUrl: "https://relay.test/j/ABCDE", version: 1, pads: pads.map((pad) => ({ pad, device: `dev-${pad}` })) });
  return { host, ws };
}

beforeEach(() => {
  resetFakes();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("RTCPeerConnection", FakePeer);
});

let hosts: StickDriftHost[] = [];
afterEach(() => {
  for (const h of hosts) h.close();
  hosts = [];
  vi.unstubAllGlobals();
});
const track = <T extends { host: StickDriftHost }>(x: T) => (hosts.push(x.host), x);

describe("StickDriftHost", () => {
  it("opens with a config that offers P2P and reports the join URL", () => {
    const opened: string[] = [];
    const host = new StickDriftHost({ origin: "https://relay.test", title: "T", look: { layout: "paddle" } });
    hosts.push(host);
    host.on("open", (_code, url) => opened.push(url));
    const ws = FakeSocket.latest();
    expect(String(ws.url)).toMatch(/^wss:\/\/relay\.test\/ws\/host\/[A-Z]{5}\?key=[0-9a-f]{32}&origin=https%3A%2F%2Frelay\.test$/);
    ws.open();
    expect(ws.messages("config")[0]).toMatchObject({ title: "T", look: { layout: "paddle" }, open: true, p2p: true });
    ws.json({ t: "welcome", code: "QWERT", joinUrl: "https://relay.test/j/QWERT", version: 1, pads: [] });
    expect(opened).toEqual(["https://relay.test/j/QWERT"]);
    expect(host.code).toBe("QWERT");
    expect(host.online).toBe(true);
  });

  it("latches presses for poll() and the pressed/held/released helpers", () => {
    const { host, ws } = track(start());
    const joins: Pad[] = [];
    host.on("join", (p) => joins.push(p));
    ws.json({ t: "join", pad: 0, device: "dev-0" });
    expect(joins).toHaveLength(1);

    ws.frame(frame(1, A));
    ws.frame(frame(2, 0)); // a tap shorter than a frame
    ws.frame(frame(3, B));
    let p = host.poll().get(0);
    expect(pressed(p, "A")).toBe(true);
    expect(released(p, "A")).toBe(true);
    expect(held(p, "A")).toBe(false);
    expect(held(p, "B")).toBe(true);
    expect(held(host.pads.get(0), "B")).toBe(true);

    p = host.poll().get(0);
    expect(pressed(p, "B")).toBe(false); // edges are reported once
    expect(held(p, "B")).toBe(true);
    expect(pressed(undefined, "A")).toBe(false);
  });

  it("ignores stale and duplicate frames, but resets on rejoin", () => {
    const { host, ws } = track(start([0]));
    ws.frame(frame(10, A));
    ws.frame(frame(9, 0)); // late
    ws.frame(frame(10, 0)); // duplicate seq
    expect(held(host.pads.get(0), "A")).toBe(true);
    ws.json({ t: "join", pad: 0, device: "dev-0", rejoin: true }); // the phone reloaded
    ws.frame(frame(1, B));
    expect(host.pads.get(0)!.state.buttons).toBe(B);
  });

  it("reports each pad's round trip and path in poll()", () => {
    const { host, ws } = track(start([2]));
    ws.json({ t: "rtt", pad: 2, ms: 31, via: "relay" });
    expect(host.poll().get(2)).toMatchObject({ pad: 2, rtt: 31, via: "relay", p2p: false, connected: true });
  });

  it("releases a leaving pad's buttons and reports the release", () => {
    const { host, ws } = track(start([0]));
    const left: number[] = [];
    host.on("leave", (p) => left.push(p.pad));
    ws.frame(frame(1, A));
    host.poll();
    ws.json({ t: "leave", pad: 0 });
    const p = host.poll().get(0)!;
    expect(left).toEqual([0]);
    expect(p.connected).toBe(false);
    expect(held(p, "A")).toBe(false);
    expect(released(p, "A")).toBe(true);
  });

  it("reconnects after a relay drop and reconciles pads from the welcome", async () => {
    const { host, ws } = track(start([0, 1]));
    const events: string[] = [];
    host.on("join", (p) => events.push(`join ${p.pad}`));
    host.on("leave", (p) => events.push(`leave ${p.pad}`));
    host.on("close", () => events.push("close"));
    ws.frame(frame(5, A));
    host.poll();

    ws.drop(1006);
    expect(events).toEqual(["close"]);
    expect(host.pads.get(0)!.connected).toBe(true); // seated until the welcome says otherwise
    expect(released(host.poll().get(0), "A")).toBe(true); // relay-only input is let go

    await settle(300); // first backoff is 250 ms
    const again = FakeSocket.latest();
    expect(again).not.toBe(ws);
    expect(String(again.url)).toContain("/ws/host/ABCDE?key=0123456789abcdef0123");
    again.open();
    again.json({ t: "welcome", code: "ABCDE", joinUrl: "https://relay.test/j/ABCDE", version: 1, pads: [{ pad: 0, device: "dev-0" }] });
    expect(events).toEqual(["close", "leave 1"]); // pad 0 never left, so no join
    again.frame(frame(1, B)); // numbering may have restarted meanwhile
    expect(host.pads.get(0)!.state.buttons).toBe(B);
  });

  it("re-sends the latest look and open state after a reconnect", async () => {
    const { host, ws } = track(start());
    host.setLook({ layout: "quiz" });
    host.setOpen(false);
    ws.drop(1006);
    await settle(300);
    const again = FakeSocket.latest();
    again.open();
    expect(again.messages("config")[0]).toMatchObject({ look: { layout: "quiz" }, open: false });
  });

  it("stops when another host takes the room", async () => {
    const { host, ws } = track(start());
    const errors: string[] = [];
    host.on("error", (code) => errors.push(code));
    ws.drop(4000);
    await settle(400);
    expect(errors).toEqual(["replaced"]);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("sends commands as protocol messages", () => {
    const { host, ws } = track(start([0]));
    host.setPad(0, { label: "RED", labels: { A: "BOMB" } });
    host.haptic(0, [30, 40, 30]);
    host.kick(0);
    expect(ws.messages("pad")[0]).toEqual({ t: "pad", pad: 0, label: "RED", labels: { A: "BOMB" } });
    expect(ws.messages("haptic")[0]).toEqual({ t: "haptic", pad: 0, ms: [30, 40, 30] });
    expect(ws.messages("kick")[0]).toEqual({ t: "kick", pad: 0 });
  });
});

describe("StickDriftHost WebRTC", () => {
  const offer = (ws: FakeSocket, pad = 0) => ws.json({ t: "signal", pad, data: { type: "offer", sdp: "v=0" } });
  const candidate = (ws: FakeSocket, pad = 0) => ws.json({ t: "signal", pad, data: { type: "candidate", candidate: { candidate: "c", sdpMid: "0" } } });

  it("applies candidates only after the offer, and answers", async () => {
    const { ws } = track(start([0]));
    offer(ws);
    candidate(ws); // arrives while setRemoteDescription is still pending
    await settle();
    const pc = FakePeer.instances[0];
    expect(pc.candidates).toHaveLength(1);
    expect(ws.messages("signal")[0]).toMatchObject({ pad: 0, data: { type: "answer", sdp: "fake-answer" } });
  });

  it("takes input over the data channel, echoes pings and reports P2P", async () => {
    const { host, ws } = track(start([0]));
    const flips: boolean[] = [];
    host.on("p2p", (p) => flips.push(p.p2p));
    offer(ws);
    await settle();
    const dc = FakePeer.instances[0].connect();
    expect(host.pads.get(0)!.p2p).toBe(true);
    expect(host.poll().get(0)!.p2p).toBe(true);
    dc.message(frame(1, A));
    expect(held(host.pads.get(0), "A")).toBe(true);
    const ping = new Uint8Array([2, 0, 0, 0, 1, 2, 3, 4]).buffer;
    dc.message(ping);
    expect(dc.sent).toEqual([ping]);
    FakePeer.instances[0].setIce("disconnected"); // Wi-Fi blip
    expect(host.pads.get(0)!.p2p).toBe(false);
    expect(flips).toEqual([true, false]);
  });

  it("replaces the connection on a re-offer and ignores the old one's late events", async () => {
    const { host, ws } = track(start([0]));
    offer(ws);
    await settle();
    const first = FakePeer.instances[0];
    const firstDc = first.connect();
    offer(ws);
    await settle();
    expect(first.closed).toBe(true);
    expect(host.pads.get(0)!.p2p).toBe(false); // the new channel isn't up yet
    const second = FakePeer.instances[1];
    second.connect();
    firstDc.closeNow(); // late close from the replaced connection
    expect(host.pads.get(0)!.p2p).toBe(true);
  });

  it("keeps P2P pads working through a relay reconnect", async () => {
    const { host, ws } = track(start([0]));
    offer(ws);
    await settle();
    const pc = FakePeer.instances[0];
    const dc = pc.connect();
    dc.message(frame(1, A));
    ws.drop(1006);
    dc.message(frame(2, A | B));
    expect(host.pads.get(0)!.state.buttons).toBe(A | B);
    expect(pc.closed).toBe(false);
    await settle(300);
    FakeSocket.latest().open();
    FakeSocket.latest().json({ t: "welcome", code: "ABCDE", joinUrl: "x", version: 1, pads: [{ pad: 0, device: "dev-0" }] });
    expect(host.pads.get(0)!.p2p).toBe(true);
  });

  it("closes a leaving pad's connection", async () => {
    const { ws } = track(start([0]));
    offer(ws);
    await settle();
    FakePeer.instances[0].connect();
    ws.json({ t: "leave", pad: 0 });
    expect(FakePeer.instances[0].closed).toBe(true);
  });

  it("does not answer when P2P is off", async () => {
    const { ws } = track(start([0], { p2p: false }));
    expect(ws.messages("config")[0].p2p).toBe(false);
    offer(ws);
    await settle();
    expect(FakePeer.instances).toHaveLength(0);
  });
});

describe("renamed class", () => {
  it("keeps ControllerHost as an alias of StickDriftHost", () => {
    expect(ControllerHost).toBe(StickDriftHost);
  });
});
