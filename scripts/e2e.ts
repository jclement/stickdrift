// End-to-end check in real browsers: headless Chrome opens the demo host and
// a phone controller in two tabs, and we verify the phone negotiates a
// WebRTC data channel, a press arrives at the host over it, and the relay
// path works too. Drives Chrome over the DevTools protocol; no test deps.
//
//   bun scripts/e2e.ts [origin]     (default http://127.0.0.1:8787)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.argv[2] ?? "http://127.0.0.1:8787";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "e2e-"))}`,
  "--no-first-run", "--disable-gpu", "about:blank",
], { stdio: "ignore" });

/** tab opens a page and returns an evaluate() bound to it. */
async function tab(url: string) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURI(url)}`, { method: "PUT" });
  const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map<number, (v: unknown) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data as string);
    pending.get(m.id)?.(m.result?.result?.value);
    pending.delete(m.id);
  };
  return (expr: string): Promise<unknown> =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    });
}

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(v)})`);
    await sleep(200);
  }
}

let failed = false;
try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch {
      await sleep(100);
    }
  }
  const host = await tab(`${origin}/demo`);
  const code = (await until("room code", () => host("window.__host?.code && window.__host.joinUrl ? window.__host.code : ''"), (v) => !!v)) as string;
  console.log(`room ${code} open`);
  const pad = await tab(`${origin}/j/${code}`);
  await until("phone to join", () => host("window.__host.pads.size"), (n) => n === 1);
  console.log("phone joined over the relay");

  const dc = await until("data channel", () => pad("window.__pad.debug()?.dcState"), (s) => s === "open");
  console.log(`P2P data channel: ${dc}`);
  await pad("window.__pad.press('A', true)");
  const held = await until("A to arrive", () => host("window.__host.pads.get(0).state.buttons"), (b) => ((b as number) & 16) !== 0, 3000);
  await pad("window.__pad.press('A', false)");
  await until("A released", () => host("window.__host.pads.get(0).state.buttons"), (b) => ((b as number) & 16) === 0, 3000);
  const d = (await pad("JSON.stringify(window.__pad.debug())")) as string;
  const dbg = JSON.parse(d);
  console.log(`press arrived (buttons=${held}); path=${dbg.path}, network=${dbg.candidate}, frames P2P=${dbg.framesP2P} relay=${dbg.framesRelay}`);
  await sleep(2500);
  const d2 = JSON.parse((await pad("JSON.stringify(window.__pad.debug())")) as string);
  const avg = (s: { samples?: number[] }) => (s.samples?.length ? (s.samples.reduce((a, b) => a + b, 0) / s.samples.length).toFixed(1) : "-");
  console.log(`round trips: P2P ${avg(d2.p2pRtt)} ms, relay ${avg(d2.relayRtt)} ms`);
  if (dbg.path !== "p2p") throw new Error(`expected input over P2P, got ${dbg.path}`);
  console.log("PASS");
} catch (e) {
  failed = true;
  console.error("FAIL:", (e as Error).message);
} finally {
  chrome.kill();
}
process.exit(failed ? 1 : 0);
