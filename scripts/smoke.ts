// Smoke and latency test against a running deployment: opens a room as a
// host, joins it as a phone, sends input frames and measures how long each
// takes to come out the other side. Both ends are this machine, so the
// number is the full phone -> edge -> Durable Object -> host path.
//
//   bun scripts/smoke.ts https://stickdrift.net
import { Button, decodeFrame, emptyState, encodeFrame, randomCode } from "../src/shared/protocol";

const origin = process.argv[2] ?? "http://127.0.0.1:8787";
const wsOrigin = origin.replace(/^http/, "ws");
const code = randomCode();
const key = crypto.randomUUID().replace(/-/g, "");

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`could not connect to ${url}`));
  });
}

const host = await open(`${wsOrigin}/ws/host/${code}?key=${key}`);
const joined = new Promise<void>((r) => {
  host.addEventListener("message", (e) => {
    if (typeof e.data === "string" && JSON.parse(e.data).t === "join") r();
  });
});
const pad = await open(`${wsOrigin}/ws/pad/${code}?device=smoke-${key.slice(0, 12)}`);
await joined;
console.log(`room ${code}: host and pad connected`);

const sentAt = new Map<number, number>();
const times: number[] = [];
host.addEventListener("message", (e) => {
  if (typeof e.data === "string") return;
  const f = decodeFrame(e.data as ArrayBuffer);
  const t0 = f && sentAt.get(f.state.seq);
  if (t0 !== undefined) times.push(performance.now() - t0);
});

const N = 60;
for (let i = 1; i <= N; i++) {
  const s = { ...emptyState(), seq: i, buttons: i % 2 ? 1 << Button.A : 0 };
  sentAt.set(i, performance.now());
  pad.send(encodeFrame(s));
  await new Promise((r) => setTimeout(r, 30));
}
await new Promise((r) => setTimeout(r, 500));
times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(1);
console.log(`${times.length}/${N} frames relayed · p50 ${pct(0.5)} ms · p90 ${pct(0.9)} ms · max ${pct(1)} ms`);
host.close();
pad.close();
if (times.length !== N) process.exit(1);
