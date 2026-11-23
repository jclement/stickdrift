// The phone's transport against scripted sockets and peers: P2P when the
// host echoes, a relay fallback within about a second when it stops, and
// fresh negotiations after ICE failure, a network change or the game
// coming back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_PING } from "../../src/shared/protocol";
import { Transport } from "../../src/client/pad/transport";
import { FakeChannel, FakePeer, FakeSocket, resetFakes, settle } from "./fakes";

const frame = (n: number) => new Uint8Array([1, 0, n, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
const isPing = (d: unknown) => d instanceof ArrayBuffer && d.byteLength === 8 && new Uint8Array(d)[0] === FRAME_PING;

let transports: Transport[] = [];

/** start connects a transport to a host that speaks P2P and opens the channel. */
async function start(opts: { open?: boolean } = {}) {
  const t = new Transport("wss://relay.test/ws/pad/ABCDE?device=dev-aaaaaaaa", () => {}, () => true, () => {});
  transports.push(t);
  t.connect();
  const ws = FakeSocket.latest();
  ws.open();
  ws.json({ t: "setup", pad: 0, title: "", version: 1, p2p: true });
  const pc = FakePeer.instances[FakePeer.instances.length - 1];
  await settle();
  const dc = pc.channels[0];
  if (opts.open !== false) {
    pc.setIce("connected");
    dc.open();
  }
  return { t, ws, pc, dc };
}

/** echo answers every ping the phone has sent on dc so far, like a host. */
function echo(dc: FakeChannel) {
  for (const d of dc.sent.splice(0)) if (isPing(d)) dc.message(d);
}

/** relayFrames counts binary frames sent on the relay. */
const relayFrames = (ws: FakeSocket) => ws.sent.filter((d) => d instanceof ArrayBuffer).length;

beforeEach(() => {
  resetFakes();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("RTCPeerConnection", FakePeer);
});
afterEach(() => {
  for (const t of transports) t.close();
  transports = [];
  vi.unstubAllGlobals();
});

describe("Transport", () => {
  it("offers P2P when the host speaks it, and sends over the channel once open", async () => {
    const { t, ws, pc, dc } = await start();
    expect(ws.messages("signal")[0]).toMatchObject({ data: { type: "offer" } });
    t.sendFrame(frame(1));
    expect(dc.sent).toContainEqual(frame(1));
    expect(relayFrames(ws)).toBe(0);
    expect(t.debug.path).toBe("p2p");
    expect(t.debug.dcState).toBe("open");
    expect(pc.closed).toBe(false);
  });

  it("sends a screen answer by both paths and forgets it once the relay acknowledges", async () => {
    const { t, ws, dc } = await start();
    const ev = { t: "event" as const, s: "p", n: 1, screen: "r1", element: "ready" };
    t.sendEvent(ev);
    expect(dc.sent).toContainEqual(JSON.stringify(ev));
    expect(ws.messages("event")).toEqual([ev]);
    expect(t.pendingCount).toBe(1);
    ws.json({ t: "ack", n: 1, s: "p" });
    expect(t.pendingCount).toBe(0);
  });

  it("retries an answer lost on the channel while the relay is down, until acknowledged", async () => {
    const { t, ws, dc } = await start();
    ws.drop(); // relay down; the channel stays open
    const ev = { t: "event" as const, s: "p", n: 1, screen: "r1", element: "ready" };
    t.sendEvent(ev);
    const copies = () => (dc.sent as unknown[]).filter((d) => d === JSON.stringify(ev)).length;
    expect(copies()).toBe(1); // ...and suppose that packet was lost
    await settle(600);
    expect(copies()).toBeGreaterThan(1); // resent on the channel each tick
    const again = FakeSocket.latest();
    expect(again).not.toBe(ws);
    again.open();
    expect(again.messages("event")).toEqual([ev]); // and over the relay once it is back
    dc.message(JSON.stringify({ t: "ack", n: 1, s: "p" }) as unknown as ArrayBuffer); // the host has it
    expect(t.pendingCount).toBe(0);
    const before = copies();
    await settle(600);
    expect(copies()).toBe(before); // no more retries
    expect(t.debug.events).toBe(1);
  });

  it("uses the relay while the channel is still connecting", async () => {
    const { t, ws } = await start({ open: false });
    t.sendFrame(frame(1));
    expect(relayFrames(ws)).toBe(1);
    expect(t.debug.path).toBe("relay");
  });

  it("falls back to the relay within about a second when echoes stop, re-sending the held state", async () => {
    const { t, ws, dc } = await start();
    t.sendFrame(frame(7)); // say, a button held down
    expect(relayFrames(ws)).toBe(0);
    await settle(1300); // no echoes: the host has gone quiet
    expect(t.debug.path).toBe("relay");
    expect(t.debug.p2pFallbacks).toBe(1);
    expect(t.debug.dcState).toMatch(/^open, no echo/);
    expect(ws.sent.filter((d) => d instanceof ArrayBuffer)).toContainEqual(frame(7));
    // Echoes resume: back on P2P.
    echo(dc);
    expect(t.debug.path).toBe("p2p");
  });

  it("stays on P2P while the host echoes", async () => {
    const { t, ws, dc } = await start();
    t.sendFrame(frame(1));
    for (let i = 0; i < 6; i++) {
      await settle(250);
      echo(dc);
    }
    expect(t.debug.path).toBe("p2p");
    expect(t.debug.p2pRtt.count).toBeGreaterThan(0);
    expect(relayFrames(ws)).toBe(0);
  });

  it("moves to the relay at once when ICE disconnects", async () => {
    const { t, ws, pc } = await start();
    t.sendFrame(frame(3));
    pc.setIce("disconnected");
    expect(t.debug.path).toBe("relay");
    expect(relayFrames(ws)).toBe(1);
    t.sendFrame(frame(4));
    expect(relayFrames(ws)).toBe(2);
  });

  it("negotiates afresh after ICE fails, backing off", async () => {
    const { pc } = await start();
    pc.setIce("failed");
    expect(pc.closed).toBe(true);
    await settle(1200); // first retry after 1 s
    expect(FakePeer.instances).toHaveLength(2);
  });

  it("negotiates afresh when the network changes", async () => {
    const { t, pc } = await start();
    t.networkChanged();
    expect(pc.closed).toBe(true);
    expect(FakePeer.instances).toHaveLength(2);
  });

  it("checks the channel when the game comes back and renegotiates if it is dead", async () => {
    const { ws, pc } = await start();
    ws.json({ t: "host", online: false });
    ws.json({ t: "host", online: true }); // e.g. the game's page reloaded
    await settle(1700); // no echoes from the new host
    expect(pc.closed).toBe(true);
    expect(FakePeer.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("stops P2P when the relay says not to reconnect (kicked)", async () => {
    const t = new Transport("wss://relay.test/ws/pad/ABCDE?device=dev-aaaaaaaa", () => {}, () => false, () => {});
    transports.push(t);
    t.connect();
    const ws = FakeSocket.latest();
    ws.open();
    ws.json({ t: "setup", pad: 0, title: "", version: 1, p2p: true });
    await settle();
    ws.drop(4002);
    expect(FakePeer.instances[0].closed).toBe(true);
    t.sendFrame(frame(1));
    expect(FakePeer.instances[0].channels[0].sent).toHaveLength(0);
  });
});
