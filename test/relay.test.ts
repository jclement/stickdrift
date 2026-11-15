// Integration tests: a host and pads talking through the real Worker and
// Session Durable Object.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Button, decodeFrame, encodeFrame, emptyState, randomCode } from "../src/shared/protocol";

const KEY = "0123456789abcdef0123";

/** open connects a WebSocket through the Worker and collects messages. */
async function open(path: string) {
  const res = await SELF.fetch(`https://controller.test${path}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) {
    const none = async (): Promise<never> => {
      throw new Error(`no socket (status ${res.status})`);
    };
    return { status: res.status, ws: null as never, next: none, frame: none, frames: [] as ArrayBuffer[], closed: () => 0 };
  }
  ws.accept();
  const texts: unknown[] = [];
  const frames: ArrayBuffer[] = [];
  const waiters: (() => void)[] = [];
  let closeCode = 0;
  ws.addEventListener("message", async (e) => {
    if (typeof e.data === "string") texts.push(JSON.parse(e.data));
    else frames.push(e.data instanceof Blob ? await e.data.arrayBuffer() : (e.data as ArrayBuffer));
    waiters.splice(0).forEach((w) => w());
  });
  ws.addEventListener("close", (e) => {
    closeCode = e.code;
    waiters.splice(0).forEach((w) => w());
  });
  /** next waits for a JSON message matching t. */
  async function next(t: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 50; i++) {
      const idx = texts.findIndex((m) => (m as { t: string }).t === t);
      if (idx >= 0) return texts.splice(idx, 1)[0] as Record<string, unknown>;
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
    throw new Error(`no ${t} message (got ${JSON.stringify(texts)}, close ${closeCode})`);
  }
  async function frame(): Promise<ArrayBuffer> {
    for (let i = 0; i < 50 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const f = frames.shift();
    if (!f) throw new Error("no frame");
    return f;
  }
  return { status: res.status, ws, next, frame, frames, closed: () => closeCode };
}

describe("relay", () => {
  it("connects a host and a pad and relays input with the pad number", async () => {
    const code = randomCode();
    const host = await open(`/ws/host/${code}?key=${KEY}`);
    const welcome = await host.next("welcome");
    expect(welcome.code).toBe(code);
    expect(welcome.joinUrl).toContain(`/j/${code}`);

    const pad = await open(`/ws/pad/${code}?device=phone-aaaaaaaa`);
    const setup = await pad.next("setup");
    expect(setup.pad).toBe(0);
    expect((await host.next("join")).pad).toBe(0);

    const s = { ...emptyState(), seq: 1, buttons: 1 << Button.A, lx: 0.5 };
    pad.ws.send(encodeFrame(s));
    const raw = await host.frame();
    const got = decodeFrame(raw)!;
    expect(got.pad).toBe(0);
    expect(got.state.buttons).toBe(1 << Button.A);
    expect(got.state.lx).toBeCloseTo(0.5, 1);
  });

  it("gives a second phone the next pad and keeps a phone's pad on reconnect", async () => {
    const code = randomCode();
    const host = await open(`/ws/host/${code}?key=${KEY}`);
    await host.next("welcome");
    const a = await open(`/ws/pad/${code}?device=phone-aaaaaaaa`);
    expect((await a.next("setup")).pad).toBe(0);
    const b = await open(`/ws/pad/${code}?device=phone-bbbbbbbb`);
    expect((await b.next("setup")).pad).toBe(1);
    a.ws.close(1000);
    expect((await host.next("leave")).pad).toBe(0);
    const again = await open(`/ws/pad/${code}?device=phone-aaaaaaaa`);
    expect((await again.next("setup")).pad).toBe(0);
  });

  it("refuses a second host with a different key", async () => {
    const code = randomCode();
    const host = await open(`/ws/host/${code}?key=${KEY}`);
    await host.next("welcome");
    const thief = await open(`/ws/host/${code}?key=someone-elses-key-0000`);
    expect(thief.status).toBe(409);
  });

  it("tells a phone when nothing is hosting the code", async () => {
    const pad = await open(`/ws/pad/${randomCode()}?device=phone-cccccccc`);
    await pad.next("host");
    for (let i = 0; i < 20 && !pad.closed(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(pad.closed()).toBe(4004);
  });

  it("forwards the host's look, custom layout and theme to the phone", async () => {
    const code = randomCode();
    const host = await open(`/ws/host/${code}?key=${KEY}`);
    await host.next("welcome");
    const pad = await open(`/ws/pad/${code}?device=phone-dddddddd`);
    await pad.next("setup");
    host.ws.send(JSON.stringify({
      t: "pad", pad: 0, label: "RED", color: "#e63946", layout: "custom",
      custom: { controls: [{ type: "buzzer", x: 0.5, y: 0.5 }] }, theme: { style: "retro", font: "pixel" },
    }));
    const setup = await pad.next("setup");
    expect(setup.label).toBe("RED");
    expect(setup.layout).toBe("custom");
    expect((setup.custom as { controls: unknown[] }).controls).toHaveLength(1);
    expect(setup.theme).toEqual({ style: "retro", font: "pixel" });
  });

  it("rejects bad codes and serves health", async () => {
    expect((await SELF.fetch("https://controller.test/ws/host/NOPE1?key=x", { headers: { Upgrade: "websocket" } })).status).toBe(400);
    const health = await (await SELF.fetch("https://controller.test/api/v1/health")).json();
    expect(health).toMatchObject({ status: "ok", protocol: 1 });
  });

  it("relays WebRTC signalling both ways and tells phones the host speaks P2P", async () => {
    const code = randomCode();
    const host = await open(`/ws/host/${code}?key=${KEY}`);
    await host.next("welcome");
    host.ws.send(JSON.stringify({ t: "config", p2p: true }));
    const pad = await open(`/ws/pad/${code}?device=phone-eeeeeeee`);
    const setup = await pad.next("setup");
    expect(setup.p2p).toBe(true);
    pad.ws.send(JSON.stringify({ t: "signal", data: { type: "offer", sdp: "v=0 offer" } }));
    const offer = await host.next("signal");
    expect(offer).toMatchObject({ pad: 0, data: { type: "offer", sdp: "v=0 offer" } });
    host.ws.send(JSON.stringify({ t: "signal", pad: 0, data: { type: "answer", sdp: "v=0 answer" } }));
    expect(await pad.next("signal")).toMatchObject({ data: { type: "answer", sdp: "v=0 answer" } });
  });

  it("uses the host's origin parameter for join links, and only a sane one", async () => {
    const code = randomCode();
    const host = await open(`/ws/host/${code}?key=${KEY}&origin=${encodeURIComponent("http://192.168.1.20:8787")}`);
    expect((await host.next("welcome")).joinUrl).toBe(`http://192.168.1.20:8787/j/${code}`);
    const code2 = randomCode();
    const evil = await open(`/ws/host/${code2}?key=${KEY}&origin=${encodeURIComponent("javascript:alert(1)//")}`);
    expect((await evil.next("welcome")).joinUrl).toBe(`https://controller.test/j/${code2}`);
  });

  it("lets a host clear an avatar with an empty string", async () => {
    const code = randomCode();
    const host = await open(`/ws/host/${code}?key=${KEY}`);
    await host.next("welcome");
    const pad = await open(`/ws/pad/${code}?device=phone-ffffffff`);
    await pad.next("setup");
    host.ws.send(JSON.stringify({ t: "pad", pad: 0, avatar: "data:image/png;base64,iVBORw0KGgo=" }));
    expect((await pad.next("setup")).avatar).toBe("data:image/png;base64,iVBORw0KGgo=");
    host.ws.send(JSON.stringify({ t: "pad", pad: 0, avatar: "" }));
    expect((await pad.next("setup")).avatar).toBe("");
  });
});

