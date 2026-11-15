// The phone controller app: join a room (WebRTC peer-to-peer when the game
// supports it, the Cloudflare relay otherwise; see transport.ts), show the
// layout the host asked for, and route every touch to the right control.
//
// Latency notes: pointer events are handled synchronously and a frame is
// sent from inside the handler (no requestAnimationFrame batching); the
// socket is binary; a screen wake lock and full screen keep the phone from
// dozing or scrolling mid-game.
import "./pad.css";
import { cleanCustom, cleanTheme, isCode, LAYOUTS, type CustomLayout, type PadLook, type Theme, type ToPadMessage } from "../../shared/protocol";
import { Input, describe } from "./input";
import { Transport } from "./transport";
import { build, swapPartner, type Built } from "./layouts";
import type { Control } from "./controls";

// ---- Elements ----

const $ = (id: string) => document.getElementById(id)!;
const surface = $("surface");
const joinScreen = $("join");
const statusScreen = $("status");
const rotateScreen = $("rotate");
const tiltScreen = $("tilt-permission");
const hudLabel = $("hud-label");
const hudRtt = $("hud-rtt");
const message = $("message");
const swapBtn = $("swap") as HTMLButtonElement;
const fullBtn = $("fullscreen") as HTMLButtonElement;

// ---- Identity ----

/** deviceId is stable per phone so a reconnect keeps the same pad number. */
function deviceId(): string {
  let id = localStorage.getItem("controller.device");
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, "");
    localStorage.setItem("controller.device", id);
  }
  return id;
}

// ---- State ----

let code = "";
let look: PadLook = {};
let layoutId = "dpad-ab";
let localOverride: string | null = null; // player's swap choice
let built: Built | null = null;
let padNumber = -1;
let hostOnline = false;
const owners = new Map<number, Control>(); // pointerId -> control
let transport: Transport | null = null;

const input = new Input((frame) => transport?.sendFrame(frame));

// ---- Connection ----

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  transport = new Transport(
    `${proto}://${location.host}/ws/pad/${code}?device=${deviceId()}`,
    onMessage,
    (closeCode) => {
      input.releaseAll();
      if (closeCode === 4002) return showStatus("KICKED", "The host removed this controller.", true), false;
      if (closeCode === 4003) return showStatus("ROOM FULL", "Every seat is taken.", true), false;
      if (closeCode === 4004) return showStatus("NO SUCH ROOM", `Nothing is hosting ${code}. Check the code on the big screen.`, true), false;
      if (closeCode === 4001) return false; // replaced by a newer tab on this phone
      showStatus("RECONNECTING", `Room ${code}`);
      return true;
    },
    onTransportChange,
  );
  showStatus("CONNECTING", `Room ${code}`);
  transport.connect();
}

function onMessage(m: ToPadMessage) {
  switch (m.t) {
    case "setup":
      padNumber = m.pad;
      look = m;
      layoutId = m.layout ?? "dpad-ab";
      applyLook();
      relayout();
      input.resend();
      break;
    case "host":
      hostOnline = m.online;
      if (m.online) hideStatus();
      else showStatus("WAITING FOR THE GAME", "The big screen isn't connected right now. Hang tight.");
      break;
    case "haptic":
      if ("vibrate" in navigator) navigator.vibrate(m.ms);
      break;
  }
}

// ---- HUD and debug panel ----

/** onTransportChange refreshes the latency badge and the debug panel. */
function onTransportChange() {
  const t = transport;
  if (!t) return;
  const d = t.debug;
  const rtt = t.bestRtt();
  const via = d.path === "p2p" ? "P2P" : "RELAY";
  hudRtt.textContent = rtt ? `${via} · ${Math.round(rtt)} ms` : via;
  hudRtt.className = `chip rtt ${d.path === "p2p" ? "p2p " : ""}${rtt < 40 ? "good" : rtt < 90 ? "ok" : "bad"}`;
  if (!debugPanel.classList.contains("hidden")) renderDebug();
}

const debugPanel = $("debug");

function renderDebug() {
  const t = transport;
  const d = t?.debug;
  const fmt = (s: { last: number; avg: number; p90: number; count: number }) =>
    s.count ? `${s.last.toFixed(0)} / ${s.avg.toFixed(0)} / ${s.p90.toFixed(0)} ms` : "no samples";
  const held = describe(input.buttons) || "nothing";
  const rows: [string, string][] = d
    ? [
        ["Path in use", d.path === "p2p" ? "P2P (WebRTC data channel)" : d.path === "relay" ? "RELAY (Cloudflare WebSocket)" : "none"],
        ["Game speaks P2P", d.hostP2P ? "yes" : "no (relay only)"],
        ["Relay socket", d.wsState],
        ["ICE", d.iceState],
        ["Data channel", d.dcState],
        ["Network path", d.candidate || "-"],
        ["P2P round trip (last/avg/p90)", fmt(d.p2pRtt)],
        ["Relay round trip (last/avg/p90)", fmt(d.relayRtt)],
        ["Frames sent", `${d.framesSent} (${d.framesP2P} P2P, ${d.framesRelay} relay, ${d.repeats} repeats)`],
        ["P2P attempts / reconnects", `${d.p2pAttempts} / ${d.reconnects}`],
        ["Holding", held],
        ["Room / seat", `${code} / ${padNumber + 1}`],
        ["Layout", currentLayout()],
        ["Game connected", hostOnline ? "yes" : "no"],
        ["Device", deviceId().slice(0, 12)],
      ]
    : [["Status", "preview (no connection)"], ["Holding", held], ["Layout", currentLayout()]];
  $("debug-rows").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

$("debug-btn").addEventListener("click", () => {
  debugPanel.classList.toggle("hidden");
  renderDebug();
});
$("debug-close").addEventListener("click", () => debugPanel.classList.add("hidden"));
// Keep the live "Holding" line moving while the panel is open.
setInterval(() => {
  if (!debugPanel.classList.contains("hidden")) renderDebug();
}, 200);

// ---- Presentation ----

/** updateSwapLabel names the layout the flip button switches to. */
function updateSwapLabel() {
  const other = swapPartner(currentLayout());
  swapBtn.textContent = other === "stick-ab" || other === "gamepad" ? "STICK" : "D-PAD";
}

function applyLook() {
  const accent = look.color ?? "#ff4d6d";
  document.documentElement.style.setProperty("--accent", accent);
  const rgb = hexToRgb(accent);
  if (rgb) document.documentElement.style.setProperty("--accent-rgb", rgb.join(" "));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", accent);
  applyTheme(look.theme ?? {});
  const who = look.label ?? `PLAYER ${padNumber + 1}`;
  hudLabel.textContent = `${who}`;
  message.textContent = look.message ?? "";
  swapBtn.classList.toggle("hidden", !(look.swap && swapPartner(layoutId)));
  updateSwapLabel();
}

/** applyTheme switches the style preset, font, shape and colours. */
function applyTheme(t: Theme) {
  const body = document.body;
  for (const c of [...body.classList]) if (/^(style|font|shape)-/.test(c)) body.classList.remove(c);
  body.classList.add(`style-${t.style ?? "glass"}`, `font-${t.font ?? "display"}`, `shape-${t.shape ?? "round"}`);
  const root = document.documentElement.style;
  if (t.background) root.setProperty("--bg", t.background);
  else root.removeProperty("--bg");
  if (t.text) root.setProperty("--text", t.text);
  else root.removeProperty("--text");
}

function currentLayout(): string {
  if (localOverride && look.swap && (localOverride === layoutId || swapPartner(layoutId) === localOverride)) return localOverride;
  return layoutId;
}

function relayout() {
  for (const c of owners.values()) c.up(-1);
  owners.clear();
  input.releaseAll();
  built = build(currentLayout(), input, surface, look);
  const portrait = innerHeight > innerWidth;
  rotateScreen.classList.toggle("hidden", !(built.needsLandscape && portrait));
  if (built.usesTilt && !document.body.classList.contains("preview")) startTilt();
}

function showStatus(title: string, text: string, final = false) {
  statusScreen.classList.remove("hidden");
  $("status-title").textContent = title;
  $("status-text").textContent = text;
  $("status-dot").classList.toggle("hidden", final);
  $("status-retry").classList.toggle("hidden", !final);
}

function hideStatus() {
  statusScreen.classList.add("hidden");
}

function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (h.length < 6) return null;
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---- Touch routing ----

function controlAt(x: number, y: number, only?: (c: Control) => boolean): Control | undefined {
  const list = built?.controls ?? [];
  // Later controls sit on top; check them first.
  for (let i = list.length - 1; i >= 0; i--) {
    if ((!only || only(list[i])) && list[i].hit(x, y)) return list[i];
  }
  return undefined;
}

surface.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (!document.body.classList.contains("preview")) void goFullscreen();
  const c = controlAt(e.clientX, e.clientY);
  if (!c) return;
  owners.set(e.pointerId, c);
  c.down(e.pointerId, e.clientX, e.clientY);
});

surface.addEventListener("pointermove", (e) => {
  const c = owners.get(e.pointerId);
  if (!c) return;
  e.preventDefault();
  // Coalesced events give every intermediate sample on 120 Hz screens; the
  // last one is what matters for state, so just use the latest position.
  if (c.slidable && !c.hit(e.clientX, e.clientY)) {
    // Thumb slid off a button: release it, and press whatever button it
    // slid onto (rolling from B to A without lifting).
    const next = controlAt(e.clientX, e.clientY, (o) => !!o.slidable);
    c.up(e.pointerId);
    owners.delete(e.pointerId);
    if (next) {
      owners.set(e.pointerId, next);
      next.down(e.pointerId, e.clientX, e.clientY);
    }
    return;
  }
  c.move(e.pointerId, e.clientX, e.clientY);
});

const release = (e: PointerEvent) => {
  const c = owners.get(e.pointerId);
  if (!c) {
    // A thumb that slid off every button can slide back on.
    return;
  }
  c.up(e.pointerId);
  owners.delete(e.pointerId);
};
surface.addEventListener("pointerup", release);
surface.addEventListener("pointercancel", release);
surface.addEventListener("contextmenu", (e) => e.preventDefault());

// ---- Tilt ----

let tiltOn = false;

function startTilt() {
  if (tiltOn) return;
  const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  if (typeof DOE.requestPermission === "function") {
    tiltScreen.classList.remove("hidden");
    $("tilt-allow").onclick = async () => {
      const ok = (await DOE.requestPermission!()) === "granted";
      tiltScreen.classList.add("hidden");
      if (ok) listenTilt();
    };
    return;
  }
  listenTilt();
}

function listenTilt() {
  tiltOn = true;
  addEventListener("deviceorientation", (e) => {
    if (!built?.usesTilt || e.beta === null || e.gamma === null) return;
    // In landscape the phone's beta axis is the steering axis; which sign
    // depends on which way it was rotated.
    const landscapeAngle = (screen.orientation?.angle ?? 90) === 270 ? -1 : 1;
    const steer = Math.max(-1, Math.min(1, ((e.beta ?? 0) / 45) * landscapeAngle));
    const pitch = Math.max(-1, Math.min(1, ((e.gamma ?? 0) + 45) / 45));
    built.wheel?.set(steer);
    input.setStick("left", Math.abs(steer) < 0.08 ? 0 : steer, pitch);
    input.setDirections(steer < -0.35 ? ["Left"] : steer > 0.35 ? ["Right"] : [], "tilt");
  });
}

// ---- Screen furniture ----

async function goFullscreen() {
  const d = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
  if (document.fullscreenElement) return;
  try {
    await (d.requestFullscreen?.({ navigationUI: "hide" }) ?? d.webkitRequestFullscreen?.());
    // Once full screen, Android lets a page pin the orientation.
    if (built?.needsLandscape) {
      await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.("landscape").catch(() => {});
    }
  } catch {
    // iOS Safari has no fullscreen for pages; "Add to Home Screen" does it.
  }
}

/** isStandalone reports a home-screen launch (already full screen). */
function isStandalone(): boolean {
  return matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** maybeShowIosHint suggests Add to Home Screen once, on iPhone Safari. */
function maybeShowIosHint() {
  const iphone = /iPhone|iPod/.test(navigator.userAgent);
  if (!iphone || isStandalone() || localStorage.getItem("controller.iosHint") === "done") return;
  const hint = $("ios-hint");
  hint.classList.remove("hidden");
  $("ios-hint-close").addEventListener("click", () => {
    hint.classList.add("hidden");
    localStorage.setItem("controller.iosHint", "done");
  });
}

let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake() {
  try {
    wakeLock = await (navigator as unknown as { wakeLock: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock.request("screen");
  } catch {
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // Never leave a button held down when the phone locks.
    input.releaseAll();
  } else {
    void keepAwake();
    input.resend();
  }
});

addEventListener("resize", () => {
  if (built) relayout();
});

swapBtn.addEventListener("click", () => {
  localOverride = swapPartner(currentLayout());
  relayout();
  updateSwapLabel();
});
fullBtn.addEventListener("click", () => void goFullscreen());
$("status-retry").addEventListener("click", () => location.assign("/j"));

// ---- Join screen ----

function showJoin(prefill = "") {
  joinScreen.classList.remove("hidden");
  // A home-screen launch lands here: offer the last room in one tap.
  const last = localStorage.getItem("controller.lastCode");
  if (last && isCode(last)) {
    const btn = $("rejoin");
    btn.textContent = `REJOIN ${last}`;
    btn.classList.remove("hidden");
    btn.onclick = () => location.assign(`/j/${last}`);
  }
  const boxes = [...joinScreen.querySelectorAll("input")] as HTMLInputElement[];
  boxes.forEach((b, i) => {
    b.value = prefill[i] ?? "";
    b.addEventListener("input", () => {
      b.value = b.value.toUpperCase().replace(/[^A-Z]/g, "").slice(-1);
      if (b.value && i < boxes.length - 1) boxes[i + 1].focus();
      const typed = boxes.map((x) => x.value).join("");
      if (isCode(typed)) location.assign(`/j/${typed}`);
    });
    b.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !b.value && i > 0) boxes[i - 1].focus();
    });
  });
  boxes[0].focus();
}

/** customFromHash reads a custom layout from #layout=<base64url JSON>, so a
 *  layout can be previewed or shared as a plain link. */
function customFromHash(): CustomLayout | null {
  const m = location.hash.match(/layout=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const json = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    return cleanCustom(JSON.parse(json));
  } catch {
    return null;
  }
}

// ---- Start ----

/** preview renders a layout with no connection, for the homepage gallery. */
function preview(layout: string, colour: string, custom: CustomLayout | null, theme: Theme | null) {
  look = { layout, color: colour, label: "PREVIEW", swap: false, custom: custom ?? undefined, theme: theme ?? undefined };
  layoutId = layout;
  padNumber = 0;
  document.body.classList.add("preview");
  applyLook();
  relayout();
  hudRtt.textContent = "LIVE";
  hudRtt.className = "chip rtt good";
}

function start() {
  const params = new URLSearchParams(location.search);
  const previewLayout = params.get("preview");
  if (previewLayout) {
    const theme = cleanTheme({ style: params.get("style"), font: params.get("font"), shape: params.get("shape"), background: params.get("bg"), text: params.get("text") });
    preview(previewLayout, params.get("color") ?? "#ff4d6d", customFromHash(), theme);
    return;
  }
  const fromPath = location.pathname.split("/")[2]?.toUpperCase() ?? "";
  if (!isCode(fromPath)) {
    showJoin();
    return;
  }
  code = fromPath;
  localStorage.setItem("controller.lastCode", code);
  document.title = `Controller · ${code}`;
  maybeShowIosHint();
  void keepAwake();
  connect();
}

// Exposed for scripts/e2e.ts and poking at from devtools.
(window as unknown as { __pad: unknown }).__pad = {
  debug: () => transport?.debug,
  press: (b: "A" | "B", on: boolean) => input.set(b, on),
};
// Exposed for the homepage's layout gallery and debugging.
(window as unknown as { __layouts: typeof LAYOUTS }).__layouts = LAYOUTS;
void wakeLock;
start();
