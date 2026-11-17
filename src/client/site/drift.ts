// Drift mode: the website's easter egg. The Konami code, a triple-click on
// "DRIFT" in the logo, or the wobbling joystick in the footer opens a real
// StickDrift room in the corner of the page. Every phone that scans it
// drives a glowing comet over the page: the stick steers, BOOM sends out a
// shockwave that shoves the page's cards and headings about (they spring
// back), and PAINT leaves a fading light trail. Nothing opens a room until
// someone finds the egg, so ordinary visits cost the relay nothing.
import qrcode from "qrcode-generator";
import { StickDriftHost, held, pressed } from "../sdk/host";
import type { CustomLayout } from "../../shared/protocol";

const COLOURS = ["#ff4d6d", "#3a86ff", "#38d996", "#ffbe0b", "#b388ff", "#ff8c1a", "#2ee6e6", "#ff6fb5"];
const NAMES = ["RED", "BLUE", "GREEN", "GOLD", "VIOLET", "ORANGE", "CYAN", "PINK"];
const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
/** The page elements a shockwave can shove. */
const SHOVABLE = ".card, .btn-hot, .btn-ghost, h1, h2, .stat, .code-in, .launch-badge, .game-title";

const LAYOUT: CustomLayout = {
  orientation: "landscape",
  controls: [
    { type: "stick", x: 0.25, y: 0.6, w: 0.5, h: 0.8, size: 0.45 },
    { type: "button", x: 0.82, y: 0.42, size: 0.32, button: "A", label: "BOOM", solid: true },
    { type: "button", x: 0.64, y: 0.75, size: 0.22, button: "B", label: "PAINT", color: "#38d996" },
  ],
};

/** A phone's comet. Positions are viewport pixels. */
interface Comet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  colour: string;
  trail: { x: number; y: number }[];
}

/** A shockwave ring from BOOM. */
interface Wave {
  x: number;
  y: number;
  r: number;
  colour: string;
}

let active = false;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** installDriftMode wires up the three ways into drift mode. Call once per page. */
export function installDriftMode(): void {
  let seq = 0;
  addEventListener("keydown", (e) => {
    const want = KONAMI[seq];
    seq = e.key === want || e.key.toLowerCase() === want ? seq + 1 : e.key === KONAMI[0] ? 1 : 0;
    if (seq === KONAMI.length) {
      seq = 0;
      start();
    }
  });
  document.querySelector(".drifty")?.addEventListener("click", (e) => {
    if ((e as MouseEvent).detail === 3) {
      e.preventDefault();
      start();
    }
  });
  document.getElementById("drift-egg")?.addEventListener("click", start);
  if (location.hash === "#drift") start();
}

/** start opens the room and the overlay. */
function start(): void {
  if (active) return;
  active = true;
  const canvas = document.createElement("canvas");
  canvas.className = "drift-canvas";
  const paint = document.createElement("canvas"); // persistent PAINT trails
  paint.className = "drift-canvas";
  document.body.append(paint, canvas);
  const panel = document.createElement("aside");
  panel.className = "drift-panel";
  panel.innerHTML = `
    <button class="drift-close" aria-label="Close drift mode">×</button>
    <p class="drift-kicker">DRIFT MODE UNLOCKED</p>
    <div class="drift-qr" aria-label="QR code to join">opening a room…</div>
    <p class="drift-code"></p>
    <p class="drift-hint">Scan it. You're driving the website now. BOOM shoves things. PAINT paints. Nobody will ever know.</p>`;
  document.body.append(panel);

  const host = new StickDriftHost({ origin: location.origin, title: "stickdrift.net (you found it)", look: { layout: "custom", custom: LAYOUT } });
  host.on("open", (code, url) => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    panel.querySelector(".drift-qr")!.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    panel.querySelector(".drift-code")!.textContent = code;
  });
  const comets = new Map<number, Comet>();
  host.on("join", (pad) => {
    const n = pad.pad;
    const colour = COLOURS[n % COLOURS.length];
    host.setPad(n, { color: colour, label: NAMES[n % NAMES.length], message: "Steer your comet. BOOM shoves the page. PAINT paints it." });
    comets.set(n, { x: innerWidth * (0.2 + 0.6 * Math.random()), y: innerHeight * 0.4, vx: 0, vy: 0, colour, trail: [] });
  });
  host.on("leave", (pad) => comets.delete(pad.pad));

  const waves: Wave[] = [];
  let raf = 0;
  const resize = () => {
    for (const c of [canvas, paint]) {
      c.width = innerWidth * devicePixelRatio;
      c.height = innerHeight * devicePixelRatio;
    }
  };
  resize();
  addEventListener("resize", resize);

  const frame = () => {
    step(host, comets, waves, paint);
    draw(canvas, paint, comets, waves);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  panel.querySelector(".drift-close")!.addEventListener("click", () => {
    cancelAnimationFrame(raf);
    removeEventListener("resize", resize);
    host.close();
    canvas.remove();
    paint.remove();
    panel.remove();
    active = false;
  });
}

/** step moves the comets from their phones and handles BOOM. */
function step(host: StickDriftHost, comets: Map<number, Comet>, waves: Wave[], paint: HTMLCanvasElement): void {
  for (const [n, p] of host.poll()) {
    const c = comets.get(n);
    if (!c || !p.connected) continue;
    c.vx = (c.vx + p.state.lx * 1.4) * 0.94;
    c.vy = (c.vy + p.state.ly * 1.4) * 0.94;
    c.x += c.vx;
    c.y += c.vy;
    if (c.x < 0 || c.x > innerWidth) (c.vx *= -0.8), (c.x = Math.max(0, Math.min(innerWidth, c.x)));
    if (c.y < 0 || c.y > innerHeight) (c.vy *= -0.8), (c.y = Math.max(0, Math.min(innerHeight, c.y)));
    c.trail.push({ x: c.x, y: c.y });
    if (c.trail.length > 24) c.trail.shift();
    if (held(p, "B")) splat(paint, c);
    if (pressed(p, "A")) {
      waves.push({ x: c.x, y: c.y, r: 0, colour: c.colour });
      shove(c.x, c.y);
      host.haptic(n, 40);
    }
  }
  for (const w of waves) w.r += 14;
  while (waves.length && waves[0].r > 260) waves.shift();
}

/** shove knocks page elements near (x, y) away from it; CSS springs them back. */
function shove(x: number, y: number): void {
  for (const el of document.querySelectorAll<HTMLElement>(SHOVABLE)) {
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - x;
    const dy = b.top + b.height / 2 - y;
    const d = Math.hypot(dx, dy);
    if (d > 320 || b.bottom < 0 || b.top > innerHeight) continue;
    const k = (1 - d / 320) * (reduceMotion ? 6 : 28);
    el.classList.add("drift-shoved");
    el.style.transform = `translate(${(dx / (d || 1)) * k}px, ${(dy / (d || 1)) * k}px) rotate(${(Math.random() - 0.5) * k * 0.6}deg)`;
    setTimeout(() => (el.style.transform = ""), 180);
  }
}

/** splat paints one dab of a comet's colour into the persistent layer. */
function splat(paint: HTMLCanvasElement, c: Comet): void {
  const g = paint.getContext("2d")!;
  g.fillStyle = c.colour;
  g.globalAlpha = 0.5;
  g.beginPath();
  g.arc(c.x * devicePixelRatio, c.y * devicePixelRatio, 5 * devicePixelRatio, 0, Math.PI * 2);
  g.fill();
}

/** draw renders comets and waves, and slowly fades the paint. */
function draw(canvas: HTMLCanvasElement, paint: HTMLCanvasElement, comets: Map<number, Comet>, waves: Wave[]): void {
  const pg = paint.getContext("2d")!;
  pg.globalAlpha = 1;
  pg.globalCompositeOperation = "destination-out";
  pg.fillStyle = "rgba(0,0,0,0.006)";
  pg.fillRect(0, 0, paint.width, paint.height);
  pg.globalCompositeOperation = "source-over";

  const g = canvas.getContext("2d")!;
  const s = devicePixelRatio;
  g.clearRect(0, 0, canvas.width, canvas.height);
  for (const w of waves) {
    g.strokeStyle = w.colour;
    g.globalAlpha = 1 - w.r / 260;
    g.lineWidth = 3 * s;
    g.beginPath();
    g.arc(w.x * s, w.y * s, w.r * s, 0, Math.PI * 2);
    g.stroke();
  }
  for (const c of comets.values()) {
    c.trail.forEach((t, i) => {
      g.globalAlpha = (i / c.trail.length) * 0.6;
      g.fillStyle = c.colour;
      g.beginPath();
      g.arc(t.x * s, t.y * s, (3 + i * 0.5) * s, 0, Math.PI * 2);
      g.fill();
    });
    g.globalAlpha = 1;
    g.shadowColor = c.colour;
    g.shadowBlur = 36 * s;
    g.fillStyle = c.colour;
    g.beginPath();
    g.arc(c.x * s, c.y * s, 14 * s, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(c.x * s, c.y * s, 7 * s, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
  }
}
