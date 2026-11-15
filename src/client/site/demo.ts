// The demo host: opens a room, shows the QR code, gives every phone that
// joins a colour, and draws each pad's live state. It is also the manual
// test harness for the relay and every layout.
import "./site.css";
import qrcode from "qrcode-generator";
import { ControllerHost, down, type Pad } from "../sdk/host";
import { BUTTON_NAMES, LAYOUTS, type ButtonName } from "../../shared/protocol";

const PALETTE = ["#ff4d6d", "#3a86ff", "#38d996", "#ffbe0b", "#b388ff", "#ff8c1a", "#2ee6e6", "#ff6fb5"];
const $ = (id: string) => document.getElementById(id)!;

let layout = "dpad-ab";
const host = new ControllerHost({ origin: location.origin, title: "Demo", look: look() });
// For automated end-to-end checks (scripts/e2e.ts).
(window as unknown as { __host: ControllerHost }).__host = host;

/** A sample custom layout, so the Custom chip shows something real. */
const SAMPLE_CUSTOM = {
  orientation: "landscape" as const,
  controls: [
    { type: "stick" as const, x: 0.2, y: 0.6, w: 0.4, h: 0.75, size: 0.5 },
    { type: "button" as const, x: 0.86, y: 0.42, size: 0.3, button: "A" as const, label: "FIRE", solid: true },
    { type: "button" as const, x: 0.68, y: 0.68, size: 0.24, button: "B" as const, label: "BOOST", color: "#3a86ff" },
    { type: "tile" as const, x: 0.62, y: 0.2, w: 0.16, h: 0.18, button: "X" as const, label: "MAP", color: "#38d996" },
  ],
};

function look() {
  return {
    layout,
    custom: layout === "custom" ? SAMPLE_CUSTOM : undefined,
    diagonals: ($("diag") as HTMLInputElement | null)?.checked ?? true,
    swap: ($("swap") as HTMLInputElement | null)?.checked ?? true,
  };
}

// ---- Room panel ----

host.on("open", (code, joinUrl) => {
  $("code").textContent = code;
  const a = $("url") as HTMLAnchorElement;
  a.href = joinUrl;
  a.textContent = joinUrl.replace(/^https?:\/\//, "");
  const qr = qrcode(0, "M");
  qr.addData(joinUrl);
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
  $("conn").textContent = "live";
});
host.on("close", () => ($("conn").textContent = "reconnecting…"));

for (const l of LAYOUTS) {
  const b = document.createElement("button");
  b.className = "chip";
  b.textContent = l.name;
  b.title = l.blurb;
  b.setAttribute("aria-pressed", String(l.id === layout));
  b.onclick = () => {
    layout = l.id;
    for (const c of $("layouts").children) c.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-pressed", "true");
    host.setLook(look());
  };
  $("layouts").appendChild(b);
}
$("diag").addEventListener("change", () => host.setLook(look()));
$("swap").addEventListener("change", () => host.setLook(look()));

// ---- Pad cards ----

const cards = new Map<number, HTMLElement>();

host.on("join", (p) => {
  const colour = PALETTE[p.pad % PALETTE.length];
  host.setPad(p.pad, { color: colour, label: `PLAYER ${p.pad + 1}` });
  host.haptic(p.pad, 40);
  card(p, colour);
  draw(p);
});
host.on("leave", (p) => draw(p));
host.on("input", (p) => {
  draw(p);
  if (p.state.buttons & ~0) blink(p);
});
host.on("rtt", (p) => draw(p));

function card(p: Pad, colour: string): HTMLElement {
  let c = cards.get(p.pad);
  if (c) return c;
  c = document.createElement("article");
  c.className = "card p-4";
  c.style.setProperty("--c", colour);
  c.innerHTML = `
    <header class="flex items-center gap-2 mb-3">
      <span class="w-3 h-3 rounded-full" style="background:${colour};box-shadow:0 0 10px ${colour}"></span>
      <span class="font-display font-bold tracking-widest text-white">PLAYER ${p.pad + 1}</span>
      <span class="flex-1"></span>
      <span data-rtt class="font-mono text-xs text-muted">-- ms</span>
    </header>
    ${svgPad()}
    <footer class="mt-3 flex items-center gap-2 text-xs font-mono text-muted">
      <span data-held class="flex-1 truncate">idle</span>
      <span data-rate>0 f</span>
      <button data-buzz class="chip">BUZZ</button>
      <button data-kick class="chip">KICK</button>
    </footer>`;
  c.querySelector("[data-buzz]")!.addEventListener("click", () => host.haptic(p.pad, [60, 40, 60]));
  c.querySelector("[data-kick]")!.addEventListener("click", () => host.kick(p.pad));
  $("pads").appendChild(c);
  $("empty").classList.add("hidden");
  cards.set(p.pad, c);
  return c;
}

/** svgPad is a schematic controller whose parts light up as they're held. */
function svgPad(): string {
  const btn = (b: ButtonName, x: number, y: number, r = 11) =>
    `<circle data-b="${b}" cx="${x}" cy="${y}" r="${r}" fill="#26223a" stroke="#ffffff22"/><text x="${x}" y="${y + 4}" text-anchor="middle" font-size="10" fill="#fff" font-family="Chakra Petch">${b[0]}</text>`;
  const arm = (b: ButtonName, x: number, y: number, w: number, h: number) =>
    `<rect data-b="${b}" x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#26223a" stroke="#ffffff22"/>`;
  return `<svg viewBox="0 0 300 130" class="w-full">
    <rect x="1" y="1" width="298" height="128" rx="40" fill="#14111f" stroke="#ffffff14"/>
    ${arm("L", 22, 6, 60, 10)}${arm("R", 218, 6, 60, 10)}
    ${arm("Up", 52, 38, 18, 20)}${arm("Down", 52, 76, 18, 20)}${arm("Left", 32, 58, 20, 18)}${arm("Right", 70, 58, 20, 18)}
    ${btn("Y", 240, 40)}${btn("X", 218, 64)}${btn("B", 262, 64)}${btn("A", 240, 88)}
    ${arm("Select", 124, 30, 22, 8)}${arm("Start", 154, 30, 22, 8)}
    <circle cx="118" cy="88" r="22" fill="#0d0b14" stroke="#ffffff1a"/><circle data-s="l" cx="118" cy="88" r="8" fill="var(--c)"/>
    <circle cx="182" cy="88" r="22" fill="#0d0b14" stroke="#ffffff1a"/><circle data-s="r" cx="182" cy="88" r="8" fill="var(--c)"/>
  </svg>`;
}

function draw(p: Pad) {
  const c = cards.get(p.pad);
  if (!c) return;
  c.style.opacity = p.connected ? "1" : "0.4";
  for (const b of BUTTON_NAMES) c.querySelector(`[data-b="${b}"]`)?.classList.toggle("lit", down(p.state.buttons, b));
  const l = c.querySelector('[data-s="l"]')!;
  l.setAttribute("cx", String(118 + p.state.lx * 14));
  l.setAttribute("cy", String(88 + p.state.ly * 14));
  const r = c.querySelector('[data-s="r"]')!;
  r.setAttribute("cx", String(182 + p.state.rx * 14));
  r.setAttribute("cy", String(88 + p.state.ry * 14));
  const held = BUTTON_NAMES.filter((b) => down(p.state.buttons, b)).join(" ");
  const axes = p.state.lx || p.state.ly ? ` L(${p.state.lx.toFixed(2)},${p.state.ly.toFixed(2)})` : "";
  c.querySelector("[data-held]")!.textContent = p.connected ? held + axes || "idle" : "disconnected";
  c.querySelector("[data-rate]")!.textContent = `${p.frames} f`;
  const via = p.p2p ? "P2P" : "RELAY";
  c.querySelector("[data-rtt]")!.textContent = p.rtt ? `${via} · ${p.rtt} ms` : via;
}

function blink(p: Pad) {
  const c = cards.get(p.pad);
  if (!c) return;
  c.animate([{ boxShadow: "0 0 0 2px var(--c)" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 250 });
}
