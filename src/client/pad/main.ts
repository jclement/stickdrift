// The phone controller app: join a room (WebRTC peer-to-peer when the game
// supports it, the Cloudflare relay otherwise; see transport.ts), show the
// layout the host asked for, and route every touch to the right control.
//
// Latency notes: pointer events are handled synchronously and a frame is
// sent from inside the handler (no requestAnimationFrame batching); the
// socket is binary; a screen wake lock and full screen keep the phone from
// dozing or scrolling mid-game.
import "./pad.css";
import { cleanCustom, cleanScreen, cleanTheme, isCode, LAYOUTS, type CustomLayout, type PadLook, type Screen, type ScreenEvent, type Theme, type ToPadMessage } from "../../shared/protocol";
import { Input, describe } from "./input";
import { Transport } from "./transport";
import { haptic, setupHaptics } from "./haptics";
import { build, swapPartner, type Built } from "./layouts";
import type { Control } from "./controls";
import { ScreenView, type EventValue } from "./screen";
import { unpinPoint, upFromEuler, type Tilt, type Vec3 } from "./tilt";
import { PinKeeper, type LockAction, type ScreenState } from "./pin";

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
const screenPage = $("screen-page");

// ---- Identity ----

/** deviceId is stable per phone so a reconnect keeps the same pad number. */
function deviceId(): string {
  let id = localStorage.getItem("stickdrift.device");
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, "");
    localStorage.setItem("stickdrift.device", id);
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

// ---- Screen layout ----

let eventCount = 0; // n for screen events: counts up for this page's life
/** eventSession names this page's event counter, so hosts keep
 *  de-duplicating across reconnects and start afresh only after a reload. */
const eventSession = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const screenView = new ScreenView(screenPage, sendEvent, () => haptic(8));

/** sendEvent sends a screen answer, naming the screen it was given on. */
function sendEvent(element: string, value: EventValue) {
  const screen = screenView.id;
  if (!screen) return;
  const m: ScreenEvent = { t: "event", n: ++eventCount, s: eventSession, screen, element };
  if (value !== undefined) m.value = value;
  if (document.body.classList.contains("preview")) return showPreviewEvent(m);
  transport?.sendEvent(m);
}

/** showPreviewEvent shows what would have been sent, for the designer and
 *  the docs, where there is no room. */
function showPreviewEvent(m: ScreenEvent) {
  let log = document.getElementById("preview-event");
  if (!log) {
    log = document.createElement("div");
    log.id = "preview-event";
    log.className = "preview-event";
    document.body.append(log);
  }
  log.textContent = `→ ${m.element}${m.value === undefined ? "" : `: ${JSON.stringify(m.value)}`}`;
  log.classList.remove("show");
  void log.offsetWidth; // restart the fade
  log.classList.add("show");
}

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
      // The relay validated the screen; check again (and vet the avatars
      // it filled in) because this page renders it.
      look = { ...m, screen: cleanScreen(m.screen, true) };
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
      haptic(m.ms);
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
        ...tiltRows(),
        ["Game connected", hostOnline ? "yes" : "no"],
        ["Device", deviceId().slice(0, 12)],
        ["Build", `${__BUILD__}${updateReady ? " (update waiting)" : ""}`],
      ]
    : [["Status", "preview (no connection)"], ["Holding", held], ["Layout", currentLayout()]];
  function tiltRows(): [string, string][] {
    if (!built?.usesTilt) return [];
    const pinned = tilt.pinned === null ? "not pinned" : `pinned at ${tilt.pinned}°`;
    return [["Tilt", `${pinned}, screen at ${screenAngle()}°, steer ${lastTilt.steer.toFixed(2)}, pitch ${lastTilt.pitch.toFixed(2)}`]];
  }
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
  swapBtn.textContent = other === "stick-ab" || other === "gamepad" ? "SWITCH TO STICK" : "SWITCH TO D-PAD";
}

function applyLook() {
  const accent = look.color ?? "#ff4d6d";
  document.documentElement.style.setProperty("--accent", accent);
  const rgb = hexToRgb(accent);
  if (rgb) document.documentElement.style.setProperty("--accent-rgb", rgb.join(" "));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", accent);
  applyTheme(look.theme ?? {});
  const avatar = look.avatar ?? "";
  for (const id of ["hud-avatar", "identity-avatar"]) {
    const img = $(id) as HTMLImageElement;
    if (avatar) img.src = avatar;
    img.classList.toggle("hidden", !avatar);
  }
  $("hud-dot").classList.toggle("hidden", !!avatar);
  $("identity-banner").textContent = look.banner ?? "";
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

/** The surface size the current layout was built for. */
let builtW = 0;
let builtH = 0;

function relayout() {
  for (const c of owners.values()) c.up(-1);
  owners.clear();
  input.releaseAll();
  // Only the tilt controller is pinned; anything else lays out for the
  // screen as the OS shows it, exactly as before.
  if (keeper.beforeBuild(currentLayout() === "tilt")) clearPinStyle();
  const screenMode = currentLayout() === "screen";
  document.body.classList.toggle("screen-mode", screenMode);
  if (screenMode) {
    // A page, not a controller: no controls, no landscape, the page scrolls.
    surface.replaceChildren();
    built = { controls: [], needsLandscape: false, usesTilt: false };
    builtW = surface.clientWidth;
    builtH = surface.clientHeight;
    rotateScreen.classList.add("hidden");
    if (look.screen) screenView.show(look.screen);
    else showWaitingScreen();
    void applyLock(keeper.afterBuild(false, false, screenState()));
    return;
  }
  screenView.clear();
  built = build(currentLayout(), input, surface, look);
  builtW = surface.clientWidth;
  builtH = surface.clientHeight;
  const tilting = built.usesTilt && !document.body.classList.contains("preview");
  // Orientation policy follows the layout just built, not the one replaced.
  void applyLock(keeper.afterBuild(tilting, built.needsLandscape, screenState()));
  if (keeper.pinned) drawPin();
  if (tilting) startTilt();
  const portrait = innerHeight > innerWidth;
  rotateScreen.classList.toggle("hidden", !(built.needsLandscape && portrait) || keeper.pinned);
}

/** showWaitingScreen fills a screen layout the game hasn't described yet. */
function showWaitingScreen() {
  screenView.show({ id: "_waiting", items: [{ type: "status", text: "Waiting for the game…" }] });
}

function showStatus(title: string, text: string, final = false) {
  statusScreen.classList.remove("hidden");
  $("status-title").textContent = title;
  $("status-text").textContent = text;
  $("status-dot").classList.toggle("hidden", final);
  $("status-retry").classList.toggle("hidden", !final);
  // Waiting can go on forever (the game may never come back), so there is
  // always a way out, which matters most in a home-screen app with no URL bar.
  $("status-leave").classList.toggle("hidden", final);
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

/** at is where a pointer lands on the controls: the viewport position, or,
 *  while the picture is pinned and turned, the spot on the turned picture. */
function at(e: PointerEvent): [number, number] {
  const pin = keeper.pin;
  if (!pin) return [e.clientX, e.clientY];
  return unpinPoint(pin, e.clientX, e.clientY, keeper.w, keeper.h, innerWidth, innerHeight);
}

surface.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (!document.body.classList.contains("preview")) void goFullscreen();
  const [x, y] = at(e);
  const c = controlAt(x, y);
  if (!c) {
    if (built?.usesTilt && built.wheel?.hit(x, y)) recentre();
    return;
  }
  owners.set(e.pointerId, c);
  c.down(e.pointerId, x, y);
});

surface.addEventListener("pointermove", (e) => {
  const c = owners.get(e.pointerId);
  if (!c) return;
  e.preventDefault();
  const [x, y] = at(e);
  // Coalesced events give every intermediate sample on 120 Hz screens; the
  // last one is what matters for state, so just use the latest position.
  if (c.slidable && !c.hit(x, y)) {
    // Thumb slid off a button: release it, and press whatever button it
    // slid onto (rolling from B to A without lifting).
    const next = controlAt(x, y, (o) => !!o.slidable);
    c.up(e.pointerId);
    owners.delete(e.pointerId);
    if (next) {
      owners.set(e.pointerId, next);
      next.down(e.pointerId, x, y);
    }
    return;
  }
  c.move(e.pointerId, x, y);
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
    // Measured in the phone's own axes against the pose it was held in when
    // tilting started (tilt.ts), never against the screen orientation, so
    // an auto-rotate mid-turn can't flip the steering.
    steerFrom(upFromEuler(e.beta, e.gamma));
  });
}

/** steerFrom applies one reading of which way is up to the controller. */
function steerFrom(up: Vec3) {
  lastUp = up;
  const { steer, pitch } = (lastTilt = tilt.read(up));
  built?.wheel?.set(steer);
  input.setStick("left", Math.abs(steer) < 0.08 ? 0 : steer, pitch);
  input.setDirections(steer < -0.35 ? ["Left"] : steer > 0.35 ? ["Right"] : [], "tilt");
}

// ---- Pinning the tilt picture ----
//
// Tilting a phone hard, or holding it near flat, makes the OS auto-rotate
// (iOS Safari can't lock orientation at all). While the tilt controller is
// up, the page is drawn at the size it was laid out at and turned back
// against any rotation, so the player sees nothing move and the rotate
// prompt never appears. Other layouts aren't tilted in play, so a rotation
// there means the player really turned the phone; they follow the OS.

const keeper = new PinKeeper();
const tilt = keeper.session;
let lastUp: Vec3 | null = null;
let lastTilt: Tilt = { steer: 0, pitch: 0 };

/** screenAngle is the OS's screen orientation angle (0, 90, 180, 270). */
function screenAngle(): number {
  const a = screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
  return ((a % 360) + 360) % 360;
}

/** screenState is what the keeper needs to know about the screen now. */
function screenState(): ScreenState {
  return { angle: screenAngle(), vw: innerWidth, vh: innerHeight, type: screen.orientation?.type, fullscreen: !!document.fullscreenElement };
}

/** syncPin runs on every resize/orientation event and the watchdog. It pins
 *  as soon as the OS's angle and viewport agree on landscape (they change
 *  in either order, and not always with a size change), then keeps the
 *  page turned to match the OS. */
function syncPin() {
  const fresh = keeper.sync(screenState());
  if (!keeper.pinned) return;
  drawPin();
  if (fresh) void applyLock(keeper.lockAfterChange(screenState()));
}

/** drawPin turns the page by the keeper's current counter-rotation. */
function drawPin() {
  const pin = keeper.pin;
  if (!pin) return;
  const style = document.body.style;
  style.setProperty("--pin-w", `${keeper.w}px`);
  style.setProperty("--pin-h", `${keeper.h}px`);
  style.setProperty("--pin-rot", `${pin.deg}deg`);
  style.setProperty("--pin-scale", `${pin.scale}`);
  document.body.classList.add("pinned");
  rotateScreen.classList.add("hidden");
}

/** clearPinStyle hands the page back to the OS's orientation. */
function clearPinStyle() {
  lastUp = null;
  document.body.classList.remove("pinned");
  for (const v of ["--pin-w", "--pin-h", "--pin-rot", "--pin-scale"]) document.body.style.removeProperty(v);
}

/** recentre makes the way the phone is held now the neutral pose (a tap on
 *  the wheel). If the player has turned the phone round, the picture turns
 *  with them. */
function recentre() {
  if (tilt.recentre(lastUp)) {
    syncPin();
    void applyLock(keeper.lockAfterChange(screenState())); // an exact lock would now be the wrong way round
  }
  if (lastUp) steerFrom(lastUp); // straight to neutral, not at the next reading
  built?.wheel?.centred();
  haptic(12);
}

// ---- Screen furniture ----

async function goFullscreen() {
  const d = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
  if (document.fullscreenElement) return;
  try {
    await (d.requestFullscreen?.({ navigationUI: "hide" }) ?? d.webkitRequestFullscreen?.());
    await applyLock(keeper.lockOnFullscreen(screenState()));
  } catch {
    // iOS Safari has no fullscreen for pages; "Add to Home Screen" does it.
  }
}

/** applyLock asks the OS to lock or unlock the orientation, where it
 *  allows that (Android, full screen only). */
async function applyLock(a: LockAction) {
  if (!a) return;
  const o = screen.orientation as unknown as { lock?: (o: string) => Promise<void>; unlock?: () => void };
  if ("unlock" in a) o.unlock?.();
  else await o.lock?.(a.lock).catch(() => {});
}

/** isStandalone reports a home-screen launch (already full screen). */
function isStandalone(): boolean {
  return matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/** maybeShowIosHint suggests Add to Home Screen once, on iPhone Safari. */
function maybeShowIosHint() {
  const iphone = /iPhone|iPod/.test(navigator.userAgent);
  if (!iphone || isStandalone() || localStorage.getItem("stickdrift.iosHint") === "done") return;
  const hint = $("ios-hint");
  hint.classList.remove("hidden");
  $("ios-hint-close").addEventListener("click", () => {
    hint.classList.add("hidden");
    localStorage.setItem("stickdrift.iosHint", "done");
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

// Refit whenever the usable screen changes. Phones are inconsistent about
// which event they fire (iOS often fires none after rotating or returning
// to the tab), so listen to all of them and keep a cheap watchdog that
// compares the surface with the size the layout was built for.
function refitIfNeeded() {
  // Pinned, the page keeps its laid-out size whatever the OS does, so this
  // only re-turns it.
  syncPin();
  if (built && (surface.clientWidth !== builtW || surface.clientHeight !== builtH)) relayout();
}
const refitSoon = () => {
  refitIfNeeded();
  requestAnimationFrame(() => requestAnimationFrame(refitIfNeeded));
  setTimeout(refitIfNeeded, 350);
};
addEventListener("resize", refitSoon);
addEventListener("orientationchange", refitSoon);
addEventListener("pageshow", refitSoon);
document.addEventListener("fullscreenchange", refitSoon);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refitSoon();
});
window.visualViewport?.addEventListener("resize", refitSoon);
setInterval(refitIfNeeded, 400);

$("status-leave").addEventListener("click", () => {
  input.releaseAll();
  location.assign("/j");
});
$("leave").addEventListener("click", () => {
  // Navigating away closes the socket; the game sees the seat leave. The
  // join screen then offers to rejoin this room or enter another code.
  input.releaseAll();
  location.assign("/j");
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
  const last = localStorage.getItem("stickdrift.lastCode");
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
  return cleanCustom(jsonFromHash(false));
}

/** screenFromHash reads a screen from the same #layout= link, for
 *  /j?preview=screen. */
function screenFromHash(): Screen | null {
  return cleanScreen(jsonFromHash(true));
}

/** jsonFromHash decodes #layout=<base64url JSON>. Screens are UTF-8 (card
 *  text is anything); custom layouts keep the Latin-1 reading they always
 *  had, so existing links show exactly what they did. */
function jsonFromHash(utf8: boolean): unknown {
  const m = location.hash.match(/layout=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const bin = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(utf8 ? new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))) : bin);
  } catch {
    return null;
  }
}

/** SAMPLE_SCREEN is what /j?preview=screen shows with no #layout. */
const SAMPLE_SCREEN: Screen = {
  id: "sample",
  items: [
    { type: "text", text: "Round 3 · Ann is the judge" },
    { type: "heading", text: "The worst thing to hear from your dentist: ____" },
    {
      type: "cards", id: "hand", pick: 1, submit: "PLAY IT", cards: [
        { id: "c1", text: "\"I learned this on YouTube.\"" },
        { id: "c2", text: "A surprising amount of glitter." },
        { id: "c3", text: "My other hobby is taxidermy." },
        { id: "c4", text: "Hold still, this is my first time." },
        { id: "c5", text: "Whoops." },
      ],
    },
    { type: "status", text: "Waiting for 3 players…", seconds: 45 },
  ],
};

// ---- Self-update ----

declare const __BUILD__: string;

/** How long without a touch before a pending update applies itself. */
const IDLE_BEFORE_UPDATE_MS = 20_000;
let lastTouch = performance.now();
let updateReady = false;

/** checkForUpdate asks the server which build is live. A home-screen app can
 *  live in memory for days, so this is how it learns about a new deploy. */
async function checkForUpdate() {
  if (__BUILD__ === "dev") return;
  try {
    const res = await fetch("/api/v1/health", { cache: "no-store" });
    const h = (await res.json()) as { build?: string };
    if (h.build && h.build !== "dev" && h.build !== __BUILD__) {
      updateReady = true;
      $("update").classList.remove("hidden");
    }
  } catch {
    // Offline for a moment; try again next time.
  }
}

/** applyUpdateIfQuiet reloads into the new build, but never mid-press: only
 *  when the app has just come back to the foreground or nobody has touched
 *  it for a while. The device id and the room code in the URL bring the
 *  player straight back to their seat. */
function applyUpdateIfQuiet(force = false) {
  if (!updateReady) return;
  if (force || (owners.size === 0 && performance.now() - lastTouch > IDLE_BEFORE_UPDATE_MS)) {
    input.releaseAll();
    location.reload();
  }
}

surface.addEventListener("pointerdown", () => (lastTouch = performance.now()), { capture: true });
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) return;
  await checkForUpdate();
  applyUpdateIfQuiet(true);
});
setInterval(() => void checkForUpdate(), 60_000);
setInterval(() => applyUpdateIfQuiet(), 5_000);
$("update").addEventListener("click", () => applyUpdateIfQuiet(true));

// ---- Start ----

/** preview renders a layout with no connection, for the homepage gallery. */
let previewExtras: Partial<PadLook> = {};

function preview(layout: string, colour: string, custom: CustomLayout | null, theme: Theme | null) {
  look = { layout, color: colour, label: "PREVIEW", swap: false, custom: custom ?? undefined, theme: theme ?? undefined };
  if (layout === "screen") look.screen = screenFromHash() ?? SAMPLE_SCREEN;
  for (const [k, v] of Object.entries(previewExtras)) if (v !== undefined && v !== null && !(typeof v === "object" && !Object.keys(v).length)) (look as Record<string, unknown>)[k] = v;
  layoutId = layout;
  padNumber = 0;
  document.body.classList.add("preview");
  applyLook();
  relayout();
  hudRtt.textContent = "LIVE";
  hudRtt.className = "chip rtt good";
}

function start() {
  setupHaptics();
  const params = new URLSearchParams(location.search);
  const previewLayout = params.get("preview");
  if (previewLayout) {
    const theme = cleanTheme({ style: params.get("style"), font: params.get("font"), shape: params.get("shape"), background: params.get("bg"), text: params.get("text") });
    // label, banner, message and labels=A:JUMP,B:FIRE let docs show a
    // relabelled controller without opening a room.
    previewExtras = {
      label: params.get("label") ?? undefined,
      banner: params.get("banner") ?? undefined,
      message: params.get("message") ?? undefined,
      labels: Object.fromEntries((params.get("labels") ?? "").split(",").filter((p) => p.includes(":")).map((p) => p.split(":", 2).map((x) => x.slice(0, 12)))),
    };
    preview(previewLayout, params.get("color") ?? "#ff4d6d", customFromHash(), theme);
    return;
  }
  const fromPath = location.pathname.split("/")[2]?.toUpperCase() ?? "";
  if (!isCode(fromPath)) {
    showJoin();
    return;
  }
  code = fromPath;
  localStorage.setItem("stickdrift.lastCode", code);
  document.title = `StickDrift · ${code}`;
  maybeShowIosHint();
  void keepAwake();
  connect();
}

// Exposed for scripts/e2e.ts and poking at from devtools.
(window as unknown as { __pad: unknown }).__pad = {
  debug: () => transport?.debug,
  press: (b: "A" | "B", on: boolean) => input.set(b, on),
  // Sends a raw screen event, bypassing the page: e2e scripts use it to
  // prove hosts drop answers to screens that are no longer current.
  event: (m: ScreenEvent) => transport?.sendEvent(m),
  // The tilt session, for scripts checking pinning and steering.
  tilt: () => ({ pinned: tilt.pinned, pin: keeper.pin, steer: lastTilt.steer, pitch: lastTilt.pitch, up: lastUp }),
};
// Exposed for the homepage's layout gallery and debugging.
(window as unknown as { __layouts: typeof LAYOUTS }).__layouts = LAYOUTS;
void wakeLock;
start();
