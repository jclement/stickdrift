// The screen layout: validation (cleanScreen, checkEvent) and the relay
// forwarding screens to phones and events to hosts. Also the guarantee the
// nine live games depend on: hosts that never send a screen see exactly
// what they saw before, and never an event.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Button, LAYOUTS, checkEvent, cleanScreen, decodeFrame, emptyState, encodeFrame, randomCode, type Screen } from "../src/shared/protocol";

const KEY = "0123456789abcdef0123";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

/** open connects a WebSocket through the Worker and collects messages. */
async function open(path: string) {
  const res = await SELF.fetch(`https://controller.test${path}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket!;
  ws.accept();
  const texts: Record<string, unknown>[] = [];
  const frames: ArrayBuffer[] = [];
  ws.addEventListener("message", async (e) => {
    if (typeof e.data === "string") texts.push(JSON.parse(e.data));
    else frames.push(e.data instanceof Blob ? await e.data.arrayBuffer() : (e.data as ArrayBuffer));
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  async function next(t: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 100; i++) {
      const idx = texts.findIndex((m) => m.t === t);
      if (idx >= 0) return texts.splice(idx, 1)[0];
      await settle();
    }
    throw new Error(`no ${t} message (got ${JSON.stringify(texts)})`);
  }
  async function frame(): Promise<ArrayBuffer> {
    for (let i = 0; i < 100 && !frames.length; i++) await settle();
    const f = frames.shift();
    if (!f) throw new Error("no frame");
    return f;
  }
  /** none asserts no message of type t arrives within a moment. */
  async function none(t: string) {
    for (let i = 0; i < 10; i++) await settle();
    expect(texts.filter((m) => m.t === t)).toEqual([]);
  }
  return { ws, next, frame, none, texts, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

/** room opens a host and seats one phone, draining the opening messages. */
async function room(device = "phone-screen01") {
  const code = randomCode();
  const host = await open(`/ws/host/${code}?key=${KEY}`);
  await host.next("welcome");
  const pad = await open(`/ws/pad/${code}?device=${device}`);
  await pad.next("setup");
  await host.next("join");
  return { code, host, pad };
}

const hand: Screen = {
  id: "r1",
  items: [
    { type: "heading", text: "Pick two" },
    { type: "cards", id: "hand", pick: 2, submit: "PLAY", cards: [{ id: "c1", text: "one" }, { id: "c2", text: "two" }, { id: "c3", text: "three" }] },
    { type: "choices", id: "vote", options: [{ id: "a", text: "Ann" }, { id: "b", text: "Bo" }] },
    { type: "stepper", id: "bet", min: 0, max: 50, step: 5, value: 10 },
    { type: "input", id: "answer", maxLength: 5, placeholder: "type" },
    { type: "button", id: "ready", label: "READY" },
    { type: "button", id: "skip", label: "SKIP", disabled: true },
    { type: "status", text: "Waiting for 3 players", seconds: 30 },
  ],
};

describe("cleanScreen", () => {
  it("keeps a well-formed screen as it is", () => {
    const out = cleanScreen(hand)!;
    expect(out.id).toBe("r1");
    expect(out.items).toHaveLength(8);
    expect(out.items[1]).toEqual(hand.items[1]);
    expect(out.items[3]).toEqual({ type: "stepper", id: "bet", min: 0, max: 50, step: 5, value: 10 });
    expect(out.items[4]).toEqual({ type: "input", id: "answer", maxLength: 5, placeholder: "type" });
  });

  it("drops what it doesn't know and caps what it does", () => {
    const out = cleanScreen({
      id: "x",
      items: [
        { type: "script", text: "nope" },
        { type: "text", text: "<b>bold</b>\u0007 and\nnewline", html: "<img onerror=alert(1)>" },
        { type: "heading", text: "h".repeat(500) },
        { type: "cards", id: "c", pick: 9, cards: Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, text: "t".repeat(300) })) },
        { type: "cards", id: "c", cards: [{ id: "dup", text: "same id as above, dropped" }] },
        { type: "choices", id: "v", options: [{ id: "a", text: "A", pad: 2, color: "red", avatar: PNG }, { id: "a", text: "dup" }, { id: "bad id!", text: "x" }] },
        { type: "stepper", id: "s", min: 10, max: -10, step: -1, value: 1e9 },
        { type: "input", id: "i", maxLength: 999 },
        { type: "button", id: "b" },
        { type: "button", label: "no id, dropped" },
        { type: "status" },
      ],
    })!;
    expect(out.items.map((e) => e.type)).toEqual(["text", "heading", "cards", "choices", "stepper", "input", "button"]);
    expect(out.items[0]).toEqual({ type: "text", text: "<b>bold</b> and\nnewline" }); // kept as text, never markup
    expect(out.items[1].text).toHaveLength(80);
    expect(out.items[2].cards).toHaveLength(12);
    expect(out.items[2].cards![0].text).toHaveLength(140);
    expect(out.items[2].pick).toBe(3);
    expect(out.items[3].options).toEqual([{ id: "a", text: "A", pad: 2 }]); // no host-sent avatar, no bad colour
    expect(out.items[4]).toMatchObject({ min: -10, max: 10, step: 1, value: 10 });
    expect(out.items[5].maxLength).toBe(80);
    expect(out.items[6].label).toBe("OK");
    expect(cleanScreen({ id: "x", items: [{ type: "choices", id: "v", options: [{ id: "a", text: "A", avatar: PNG }] }] }, true)!.items[0].options![0].avatar).toBe(PNG);
  });

  it("refuses a screen without a usable id", () => {
    expect(cleanScreen({ id: "", items: [] })).toBeNull();
    expect(cleanScreen({ id: "has space", items: [] })).toBeNull();
    expect(cleanScreen({ id: "x".repeat(65), items: [] })).toBeNull();
    expect(cleanScreen({ id: "ok" })).toBeNull();
    expect(cleanScreen("nope")).toBeNull();
    expect(cleanScreen({ id: "ok", items: Array.from({ length: 40 }, () => ({ type: "text", text: "t" })) })!.items).toHaveLength(24);
  });
});

describe("checkEvent", () => {
  const s = cleanScreen(hand)!;
  const ev = (element: string, value?: unknown, extra = {}) => ({ t: "event", n: 1, screen: "r1", element, value, ...extra });
  it("accepts answers and cleans their values", () => {
    expect(checkEvent(s, ev("hand", ["c3", "c1"]))).toEqual({ t: "event", n: 1, screen: "r1", element: "hand", value: ["c3", "c1"] });
    expect(checkEvent(s, ev("vote", ["b"]))?.value).toEqual(["b"]);
    expect(checkEvent(s, ev("bet", 999))?.value).toBe(50);
    expect(checkEvent(s, ev("answer", "héllo wörld"))?.value).toBe("héllo");
    expect(checkEvent(s, ev("ready"))).toEqual({ t: "event", n: 1, screen: "r1", element: "ready" });
  });
  it("drops anything else", () => {
    for (const bad of [
      ev("hand", ["c1"]),
      ev("hand", ["c1", "c1"]),
      ev("hand", ["c1", "zz"]),
      ev("hand", "c1"),
      ev("vote", "b"),
      ev("bet", "20"),
      ev("bet", NaN),
      ev("answer", 5),
      ev("skip"),
      ev("nope"),
      ev("ready", undefined, { screen: "r0" }),
      ev("ready", undefined, { n: 0 }),
      ev("ready", undefined, { n: 1.5 }),
      null,
    ]) {
      expect(checkEvent(s, bad)).toBeNull();
    }
    expect(checkEvent({ ...s, locked: true }, ev("ready"))).toBeNull();
    expect(checkEvent(undefined, ev("ready"))).toBeNull();
  });
});

describe("relay: screens", () => {
  it("sends the screen to the phone and forwards only current answers", async () => {
    const { host, pad } = await room("phone-screen02");
    host.send({ t: "pad", pad: 0, layout: "screen", screen: hand });
    const setup = await pad.next("setup");
    expect(setup.layout).toBe("screen");
    expect((setup.screen as Screen).items).toHaveLength(8);

    pad.send({ t: "event", n: 1, screen: "r1", element: "hand", value: ["c2", "c1"] });
    expect(await host.next("event")).toEqual({ t: "event", n: 1, screen: "r1", element: "hand", value: ["c2", "c1"], pad: 0 });
    pad.send({ t: "event", n: 2, screen: "r1", element: "answer", value: "toolongtext" });
    expect((await host.next("event")).value).toBe("toolo"); // cut to maxLength

    // A new screen: late answers to the old one are dropped.
    host.send({ t: "pad", pad: 0, screen: { id: "r2", items: [{ type: "button", id: "next", label: "NEXT" }] } });
    await pad.next("setup");
    pad.send({ t: "event", n: 3, screen: "r1", element: "hand", value: ["c2", "c1"] });
    pad.send({ t: "event", n: 4, screen: "r2", element: "hand", value: ["c2", "c1"] }); // no such element now
    pad.send({ t: "event", n: 5, screen: "r2", element: "next" });
    expect(await host.next("event")).toMatchObject({ n: 5, element: "next" });
    await host.none("event");

    // Switching the pad to a game-pad layout: no screen, no events; buttons work.
    host.send({ t: "pad", pad: 0, layout: "buzzer" });
    await pad.next("setup");
    pad.send({ t: "event", n: 6, screen: "r2", element: "next" });
    pad.ws.send(encodeFrame({ ...emptyState(), seq: 1, buttons: 1 << Button.A }));
    expect(decodeFrame(await host.frame())!.state.buttons).toBe(1 << Button.A);
    await host.none("event");
  });

  it("falls back to the room's screen when a pad's own is cleared", async () => {
    const { host, pad } = await room("phone-screen03");
    host.send({ t: "config", look: { layout: "screen", screen: { id: "lobby", items: [{ type: "button", id: "ready", label: "READY" }] } } });
    expect(((await pad.next("setup")).screen as Screen).id).toBe("lobby");
    host.send({ t: "pad", pad: 0, screen: { id: "mine", items: [{ type: "text", text: "secret" }] } });
    expect(((await pad.next("setup")).screen as Screen).id).toBe("mine");
    host.send({ t: "pad", pad: 0, screen: null });
    expect(((await pad.next("setup")).screen as Screen).id).toBe("lobby");
    pad.send({ t: "event", n: 1, screen: "lobby", element: "ready" });
    expect(await host.next("event")).toMatchObject({ screen: "lobby", element: "ready", pad: 0 });
  });

  it("fills in the colour and avatar of choices that name a player", async () => {
    const { code, host, pad } = await room("phone-screen04");
    const other = await open(`/ws/pad/${code}?device=phone-screen05`);
    await other.next("setup");
    host.send({ t: "pad", pad: 1, color: "#3a86ff", avatar: PNG });
    await other.next("setup");
    host.send({ t: "pad", pad: 0, layout: "screen", screen: { id: "vote", items: [{ type: "choices", id: "who", options: [{ id: "p1", text: "Bo", pad: 1 }, { id: "p9", text: "Nobody", pad: 9 }, { id: "x", text: "Own colour", pad: 1, color: "#ffbe0b" }] }] } });
    const options = ((await pad.next("setup")).screen as Screen).items[0].options!;
    expect(options[0]).toEqual({ id: "p1", text: "Bo", pad: 1, color: "#3a86ff", avatar: PNG });
    expect(options[1]).toEqual({ id: "p9", text: "Nobody", pad: 9 });
    expect(options[2]).toEqual({ id: "x", text: "Own colour", pad: 1, color: "#ffbe0b", avatar: PNG });
  });
});

describe("relay: existing games are unaffected", () => {
  it("passes every built-in layout through exactly as before, with no screen field", async () => {
    const { host, pad } = await room("phone-legacy01");
    for (const l of LAYOUTS.filter((l) => l.id !== "screen" && l.id !== "custom")) {
      host.send({ t: "pad", pad: 0, layout: l.id, label: "P1", color: "#e63946", labels: { A: "JUMP" }, message: "go", swap: true, diagonals: false, banner: "RED" });
      const setup = await pad.next("setup");
      expect(setup).toEqual({ t: "setup", pad: 0, title: "", version: 1, p2p: false, layout: l.id, label: "P1", color: "#e63946", labels: { A: "JUMP" }, message: "go", swap: true, diagonals: false, banner: "RED" });
    }
  });

  it("passes a custom layout through exactly as before", async () => {
    const { host, pad } = await room("phone-legacy02");
    host.send({ t: "config", look: { layout: "custom", custom: { orientation: "portrait", controls: [{ type: "tile", x: 0.5, y: 0.2, w: 0.9, h: 0.15, button: "A", label: "ANSWER ONE", color: "#ff4d6d" }, { type: "stick", x: 0.3, y: 0.7, side: "left", floating: false }] } } });
    const setup = await pad.next("setup");
    expect(setup.custom).toEqual({
      orientation: "portrait",
      controls: [
        { type: "tile", x: 0.5, y: 0.2, w: 0.9, h: 0.15, button: "A", label: "ANSWER ONE", color: "#ff4d6d" },
        { type: "stick", x: 0.3, y: 0.7, side: "left", floating: false },
      ],
    });
    expect("screen" in setup).toBe(false);
  });

  it("never sends an event to a host that has not set a screen", async () => {
    const { host, pad } = await room("phone-legacy03");
    host.send({ t: "config", look: { layout: "quiz", screen: { id: "s", items: [{ type: "button", id: "b" }] } } }); // a screen without the screen layout
    await pad.next("setup");
    for (const bad of [
      { t: "event", n: 1, screen: "s", element: "b" },
      { t: "event", n: 2, screen: "", element: "" },
      { t: "event" },
      { t: "event", n: 3, screen: { evil: true }, element: ["x"], value: "<script>" },
    ]) pad.send(bad);
    pad.send({ t: "rtt", ms: 12, via: "relay" });
    pad.ws.send(encodeFrame({ ...emptyState(), seq: 1, buttons: 1 << Button.X }));
    expect(await host.next("rtt")).toEqual({ t: "rtt", pad: 0, ms: 12, via: "relay" });
    expect(decodeFrame(await host.frame())!.state.buttons).toBe(1 << Button.X);
    await host.none("event");
  });
});
