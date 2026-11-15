// The docs page's behaviour. The content itself is plain HTML rendered at
// build time (see docs-build.ts); this script only makes it feel like an
// app: one section visible at a time (so only its live previews load),
// the mobile menu, copy buttons on code, and the interactive avatar demo.
import "./site.css";
import "./docs.css";
import { ControllerHost } from "../sdk/host";
import type { PadLook } from "../../shared/protocol";

const sections = [...document.querySelectorAll<HTMLElement>("section.doc")];
const navLinks = [...document.querySelectorAll<HTMLAnchorElement>(".doc-nav a[href^='#']")];
const nav = document.getElementById("doc-nav")!;
const menu = document.getElementById("menu")!;

// ---- One section at a time ----

/** sectionFor finds the section a hash points into: the section itself or
 *  a heading inside it. Unknown hashes fall back to the first section. */
function sectionFor(hash: string): { section: HTMLElement; target: HTMLElement | null } {
  const id = decodeURIComponent(hash.replace(/^#/, ""));
  const target = id ? document.getElementById(id) : null;
  const section = (target?.closest("section.doc") as HTMLElement | null) ?? sections[0];
  return { section, target: target === section ? null : target };
}

/** show reveals the section for the current hash and scrolls to its target. */
function show() {
  const { section, target } = sectionFor(location.hash);
  for (const s of sections) s.hidden = s !== section;
  for (const a of navLinks) {
    const id = a.getAttribute("href")!.slice(1);
    const active = id === section.id || (target !== null && id === target.id);
    a.classList.toggle("active", active);
    if (a.classList.contains("doc-link")) a.parentElement!.classList.toggle("open", id === section.id);
  }
  document.title = `${section.dataset.title} · StickDrift docs`;
  nav.classList.remove("open");
  menu.setAttribute("aria-expanded", "false");
  if (target) target.scrollIntoView({ block: "start" });
  else window.scrollTo({ top: 0 });
  startLiveDemos(section);
}
window.addEventListener("hashchange", show);

menu.addEventListener("click", () => {
  const open = nav.classList.toggle("open");
  menu.setAttribute("aria-expanded", String(open));
});

// ---- Copy buttons ----

document.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button.copy");
  if (!btn) return;
  const code = btn.parentElement?.querySelector("code")?.textContent ?? "";
  navigator.clipboard.writeText(code).then(
    () => {
      btn.textContent = "COPIED";
      setTimeout(() => (btn.textContent = "COPY"), 1200);
    },
    () => (btn.textContent = "SELECT + COPY"),
  );
});

// ---- Live demos ----

/** startLiveDemos wires any ```live blocks in a section, once. */
function startLiveDemos(section: HTMLElement) {
  for (const el of section.querySelectorAll<HTMLElement>(".doc-live:not(.ready)")) {
    el.classList.add("ready");
    if (el.dataset.live === "avatars") avatarDemo(el);
  }
}

/** A demo player: what the game would send to that player's phone. */
interface DemoPlayer {
  name: string;
  color: string;
  sprite: string[]; // rows of a tiny pixel sprite; "#" is the colour, "o" white
}

const PLAYERS: DemoPlayer[] = [
  { name: "RED", color: "#ff4d6d", sprite: ["..####..", ".######.", "##o##o##", "########", "########", ".#.##.#.", "#......#", ".#....#."] },
  { name: "BLUE", color: "#3a86ff", sprite: ["...##...", "..####..", ".#o##o#.", "########", "#.####.#", "#.#..#.#", "...##...", "..#..#.."] },
  { name: "GREEN", color: "#38d996", sprite: [".#....#.", "..#..#..", ".######.", "##o##o##", "########", "#.####.#", "#.#..#.#", "...##..."] },
  { name: "GOLD", color: "#ffbe0b", sprite: ["..####..", ".#oooo#.", "#o#oo#o#", "#oooooo#", "#o#..#o#", "#oo##oo#", ".#oooo#.", "..####.."] },
];

/** spritePng draws a sprite as a small PNG data URL, the way a game would
 *  send a player's own character. */
function spritePng(p: DemoPlayer): string {
  const scale = 4;
  const c = document.createElement("canvas");
  c.width = c.height = p.sprite.length * scale;
  const g = c.getContext("2d")!;
  p.sprite.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      g.fillStyle = ch === "o" ? "#ffffff" : p.color;
      g.fillRect(x * scale, y * scale, scale, scale);
    }),
  );
  return c.toDataURL("image/png");
}

/** lookFor is the per-pad look the demo sends for a player. */
function lookFor(p: DemoPlayer): PadLook {
  return { color: p.color, label: `PLAYER ${p.name}`, banner: p.name, avatar: spritePng(p), message: `You are ${p.name}` };
}

/** avatarDemo opens a real room on click and joins it with the phone page
 *  in an iframe, so the reader sees exactly what a player would. */
function avatarDemo(root: HTMLElement) {
  root.innerHTML = `
    <div class="live-controls">
      <button class="btn-hot live-start" type="button">OPEN A ROOM</button>
      <div class="live-players" hidden>${PLAYERS.map((p, i) => `<button class="chip" type="button" data-i="${i}" style="--c:${p.color}"><img alt="" src="${spritePng(p)}" /> ${p.name}</button>`).join("")}</div>
      <p class="live-status">Opens a real room on the relay; nothing is installed.</p>
    </div>
    <div class="phone doc-phone live-phone"><div class="live-empty">The phone appears here</div></div>
    <pre class="live-json"></pre>`;
  const start = root.querySelector<HTMLButtonElement>(".live-start")!;
  const status = root.querySelector<HTMLElement>(".live-status")!;
  const chips = root.querySelector<HTMLElement>(".live-players")!;
  const phone = root.querySelector<HTMLElement>(".live-phone")!;
  const json = root.querySelector<HTMLElement>(".live-json")!;
  let pad: number | null = null;
  let chosen = 0;
  let host: ControllerHost | null = null;

  function apply() {
    for (const c of chips.children) c.setAttribute("aria-pressed", String(Number((c as HTMLElement).dataset.i) === chosen));
    const look = lookFor(PLAYERS[chosen]);
    json.textContent = `host.setPad(${pad ?? 0}, ${JSON.stringify({ ...look, avatar: look.avatar!.slice(0, 32) + "…" }, null, 2)});`;
    if (host && pad !== null) host.setPad(pad, look);
  }

  start.addEventListener("click", () => {
    start.hidden = true;
    status.textContent = "Opening a room…";
    host = new ControllerHost({ origin: location.origin, title: "Avatars demo", look: { layout: "dpad-ab" }, p2p: false });
    host.on("open", (code) => {
      status.textContent = `Room ${code} is live. Pick a player:`;
      chips.hidden = false;
      if (!phone.querySelector("iframe")) phone.innerHTML = `<iframe title="A phone in the demo room" src="/j/${code}"></iframe>`;
    });
    host.on("join", (p) => {
      pad = p.pad;
      apply();
    });
    host.on("error", (_code, message) => (status.textContent = `Couldn't open a room: ${message}`));
    window.addEventListener("pagehide", () => host?.close());
  });
  chips.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (!b) return;
    chosen = Number(b.dataset.i);
    apply();
  });
  apply();
}

// ---- Start ----

// Last, so every constant the live demos use is initialised.
show();
