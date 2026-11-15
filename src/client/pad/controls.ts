// Controls are the widgets a layout is built from. Each owns a DOM element
// and handles the pointers the surface routes to it. Controls never send
// anything themselves; they write into the shared Input, which sends a frame
// immediately whenever the state actually changes.
import { Button, type ButtonName } from "../../shared/protocol";
import type { Input } from "./input";

/** A pointer-handling widget on the control surface. */
export interface Control {
  el: HTMLElement;
  /** hit reports whether a touch at client (x, y) belongs to this control. */
  hit(x: number, y: number): boolean;
  down(id: number, x: number, y: number): void;
  move(id: number, x: number, y: number): void;
  up(id: number): void;
  /** Buttons let a thumb slide onto them from a neighbouring button. */
  slidable?: boolean;
}

/** Geometry shared by every control: centre and size in pixels. */
export interface Place {
  x: number;
  y: number;
  w: number;
  h: number;
}

function el(cls: string, place: Place, parent: HTMLElement): HTMLElement {
  const e = document.createElement("div");
  e.className = `ctl ${cls}`;
  e.style.left = `${place.x}px`;
  e.style.top = `${place.y}px`;
  e.style.width = `${place.w}px`;
  e.style.height = `${place.h}px`;
  e.style.setProperty("--size", `${Math.min(place.w, place.h)}px`);
  parent.appendChild(e);
  return e;
}

/** Hit slop: fingers are fat and phones are small, so targets grow 18%. */
const SLOP = 1.18;

function inRect(p: Place, x: number, y: number, round: boolean): boolean {
  const dx = (x - p.x) / ((p.w / 2) * SLOP);
  const dy = (y - p.y) / ((p.h / 2) * SLOP);
  return round ? dx * dx + dy * dy <= 1 : Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
}

/** haptic gives a tiny tick where the platform supports it (Android). */
export function tick(ms = 8) {
  if ("vibrate" in navigator) navigator.vibrate(ms);
}

// ---- Buttons ----

export type ButtonStyle = "btn" | "btn solid" | "pill" | "shoulder" | "tile" | "buzzer";

/** PressButton holds one bit while any pointer is on it. */
export class PressButton implements Control {
  el: HTMLElement;
  slidable = true;
  private pointers = new Set<number>();
  constructor(
    private input: Input,
    private bit: ButtonName,
    private place: Place,
    parent: HTMLElement,
    style: ButtonStyle,
    label: string,
    colour?: string,
  ) {
    this.el = el(style, place, parent);
    if (colour) this.el.style.setProperty("--c", colour);
    const lbl = document.createElement("span");
    lbl.className = label.length > 2 ? "lbl long" : "lbl";
    lbl.textContent = label;
    this.el.appendChild(lbl);
    const ripple = document.createElement("i");
    ripple.className = "ripple";
    this.el.appendChild(ripple);
  }
  hit(x: number, y: number) {
    return inRect(this.place, x, y, this.el.classList.contains("btn") || this.el.classList.contains("buzzer"));
  }
  down(id: number) {
    const was = this.pointers.size > 0;
    this.pointers.add(id);
    if (!was) {
      this.el.classList.add("down");
      tick();
      this.input.set(this.bit, true);
    }
  }
  move() {}
  up(id: number) {
    this.pointers.delete(id);
    if (this.pointers.size === 0) {
      this.el.classList.remove("down");
      this.input.set(this.bit, false);
    }
  }
}

// ---- D-pad ----

/** Dpad maps a thumb's angle from its centre to one or two directions.
 *  The thumb can roll around without lifting, which is how real d-pads are
 *  played. A small dead zone in the middle means "nothing". */
export class Dpad implements Control {
  el: HTMLElement;
  private arms: Record<string, HTMLElement> = {};
  private owner = -1;
  constructor(
    private input: Input,
    private place: Place,
    parent: HTMLElement,
    private diagonals: boolean,
  ) {
    this.el = el("dpad", place, parent);
    for (const d of ["up", "down", "left", "right"]) {
      const a = document.createElement("div");
      a.className = `arm ${d}`;
      this.el.appendChild(a);
      this.arms[d] = a;
    }
    const hub = document.createElement("div");
    hub.className = "hub";
    this.el.appendChild(hub);
  }
  hit(x: number, y: number) {
    return inRect(this.place, x, y, true);
  }
  down(id: number, x: number, y: number) {
    this.owner = id;
    this.move(id, x, y);
  }
  move(id: number, x: number, y: number) {
    if (id !== this.owner) return;
    const dx = x - this.place.x;
    const dy = y - this.place.y;
    const dead = this.place.w * 0.09;
    let dirs: ButtonName[] = [];
    if (Math.hypot(dx, dy) > dead) {
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 = right, 90 = down
      const sector = this.diagonals ? 45 : 90;
      const snapped = Math.round(ang / sector) * sector;
      const rad = (snapped * Math.PI) / 180;
      const sx = Math.round(Math.cos(rad));
      const sy = Math.round(Math.sin(rad));
      if (sx > 0) dirs.push("Right");
      if (sx < 0) dirs.push("Left");
      if (sy > 0) dirs.push("Down");
      if (sy < 0) dirs.push("Up");
    }
    this.apply(dirs);
  }
  up(id: number) {
    if (id !== this.owner) return;
    this.owner = -1;
    this.apply([]);
  }
  private apply(dirs: ButtonName[]) {
    const changed = this.input.setDirections(dirs, "dpad");
    for (const d of ["Up", "Down", "Left", "Right"] as ButtonName[]) {
      this.arms[d.toLowerCase()].classList.toggle("on", dirs.includes(d));
    }
    if (changed && dirs.length) tick(6);
  }
}

// ---- Analog stick ----

/** Stick is an analog thumbstick. Floating sticks recentre wherever the
 *  thumb lands inside their zone, which is far kinder on glass than a fixed
 *  stick you have to find by feel. Either way it also drives the d-pad bits
 *  (8-way, past half deflection) so d-pad-only games just work. */
export class Stick implements Control {
  el: HTMLElement;
  private base: HTMLElement;
  private knob: HTMLElement;
  private dir: HTMLElement;
  private hint: HTMLElement | null = null;
  private owner = -1;
  private cx: number;
  private cy: number;
  private radius: number;
  constructor(
    private input: Input,
    private zone: Place,
    parent: HTMLElement,
    private side: "left" | "right",
    private floating: boolean,
    private drivesDpad: boolean,
    diameter: number,
  ) {
    this.el = document.createElement("div");
    this.el.className = "stick-zone";
    Object.assign(this.el.style, {
      left: `${zone.x - zone.w / 2}px`,
      top: `${zone.y - zone.h / 2}px`,
      width: `${zone.w}px`,
      height: `${zone.h}px`,
    });
    parent.appendChild(this.el);
    this.radius = diameter / 2;
    this.cx = zone.w / 2;
    this.cy = zone.h / 2;
    this.base = document.createElement("div");
    this.base.className = "stick idle";
    this.base.style.width = this.base.style.height = `${diameter}px`;
    this.dir = document.createElement("div");
    this.dir.className = "dir";
    this.knob = document.createElement("div");
    this.knob.className = "knob";
    this.base.append(this.dir, this.knob);
    this.el.appendChild(this.base);
    // The "drag anywhere" hint only fits when the zone is roomy.
    if (floating && zone.h > diameter * 1.6) {
      this.hint = document.createElement("div");
      this.hint.className = "hint";
      this.hint.textContent = "DRAG ANYWHERE";
      this.el.appendChild(this.hint);
    }
    this.placeBase(this.cx, this.cy);
  }
  hit(x: number, y: number) {
    const z = this.zone;
    return Math.abs(x - z.x) <= z.w / 2 && Math.abs(y - z.y) <= z.h / 2;
  }
  down(id: number, x: number, y: number) {
    if (this.owner >= 0) return;
    this.owner = id;
    const lx = x - (this.zone.x - this.zone.w / 2);
    const ly = y - (this.zone.y - this.zone.h / 2);
    if (this.floating) {
      // Keep the whole base on screen.
      this.cx = Math.max(this.radius, Math.min(this.zone.w - this.radius, lx));
      this.cy = Math.max(this.radius, Math.min(this.zone.h - this.radius, ly));
      this.placeBase(this.cx, this.cy);
      this.hint?.classList.add("hidden");
    }
    this.base.classList.remove("idle");
    tick(6);
    this.move(id, x, y);
  }
  move(id: number, x: number, y: number) {
    if (id !== this.owner) return;
    const lx = x - (this.zone.x - this.zone.w / 2) - this.cx;
    const ly = y - (this.zone.y - this.zone.h / 2) - this.cy;
    const dist = Math.hypot(lx, ly);
    const max = this.radius * 0.78;
    const k = dist > max ? max / dist : 1;
    const kx = lx * k;
    const ky = ly * k;
    this.knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
    // Small radial dead zone, then rescale so full tilt is reachable.
    let ax = kx / max;
    let ay = ky / max;
    const mag = Math.hypot(ax, ay);
    const dead = 0.12;
    if (mag < dead) {
      ax = 0;
      ay = 0;
    } else {
      const s = (mag - dead) / (1 - dead) / mag;
      ax *= s;
      ay *= s;
    }
    const m = Math.min(1, Math.hypot(ax, ay));
    this.dir.style.setProperty("--mag", `${m}`);
    this.dir.style.setProperty("--arc", "70deg");
    this.dir.style.setProperty("--rot", `${(Math.atan2(ay, ax) * 180) / Math.PI + 90 - 35}deg`);
    this.input.setStick(this.side, ax, ay);
    if (this.drivesDpad) this.input.setDirections(stickDirections(ax, ay), `stick-${this.side}`);
  }
  up(id: number) {
    if (id !== this.owner) return;
    this.owner = -1;
    this.knob.style.transform = "translate(-50%, -50%)";
    this.dir.style.setProperty("--mag", "0");
    this.base.classList.add("idle");
    if (this.floating) {
      this.cx = this.zone.w / 2;
      this.cy = this.zone.h / 2;
      this.placeBase(this.cx, this.cy);
      this.hint?.classList.remove("hidden");
    }
    this.input.setStick(this.side, 0, 0);
    if (this.drivesDpad) this.input.setDirections([], `stick-${this.side}`);
  }
  private placeBase(x: number, y: number) {
    this.base.style.left = `${x}px`;
    this.base.style.top = `${y}px`;
    if (this.hint) {
      this.hint.style.left = `${x}px`;
      this.hint.style.top = `${y + this.radius + 18}px`;
    }
  }
}

/** stickDirections turns a stick position into 8-way d-pad bits. */
export function stickDirections(x: number, y: number): ButtonName[] {
  const out: ButtonName[] = [];
  if (Math.hypot(x, y) < 0.5) return out;
  const ang = Math.atan2(y, x);
  const sx = Math.round(Math.cos(Math.round(ang / (Math.PI / 4)) * (Math.PI / 4)));
  const sy = Math.round(Math.sin(Math.round(ang / (Math.PI / 4)) * (Math.PI / 4)));
  if (sx > 0) out.push("Right");
  if (sx < 0) out.push("Left");
  if (sy > 0) out.push("Down");
  if (sy < 0) out.push("Up");
  return out;
}

// ---- Paddle slider ----

/** Slider sets lx from -1 (left) to 1 (right) and remembers where it was. */
export class Slider implements Control {
  el: HTMLElement;
  private thumb: HTMLElement;
  private owner = -1;
  private value = 0;
  constructor(
    private input: Input,
    private place: Place,
    parent: HTMLElement,
  ) {
    this.el = el("track", place, parent);
    this.thumb = document.createElement("div");
    this.thumb.className = "thumb";
    this.el.appendChild(this.thumb);
    this.render();
  }
  hit(x: number, y: number) {
    return Math.abs(x - this.place.x) <= this.place.w / 2 + 20 && Math.abs(y - this.place.y) <= this.place.h * 1.6;
  }
  down(id: number, x: number) {
    this.owner = id;
    this.move(id, x);
  }
  move(id: number, x: number) {
    if (id !== this.owner) return;
    const usable = this.place.w * 0.78;
    this.value = Math.max(-1, Math.min(1, (x - this.place.x) / (usable / 2)));
    this.render();
    this.input.setStick("left", this.value, 0);
  }
  up(id: number) {
    if (id === this.owner) this.owner = -1;
  }
  private render() {
    this.thumb.style.left = `${50 + this.value * 39}%`;
  }
}

// ---- Touchpad ----

/** Touchpad accumulates relative motion into px/py (scaled for feel). A
 *  quick tap presses A briefly; a two-finger tap presses B. */
export class Touchpad implements Control {
  el: HTMLElement;
  private spark: HTMLElement;
  private touches = new Map<number, { x: number; y: number; t: number; moved: number }>();
  constructor(
    private input: Input,
    private place: Place,
    parent: HTMLElement,
  ) {
    this.el = el("pad-area", place, parent);
    this.spark = document.createElement("div");
    this.spark.className = "spark";
    this.el.appendChild(this.spark);
  }
  hit(x: number, y: number) {
    return inRect(this.place, x, y, false);
  }
  down(id: number, x: number, y: number) {
    this.touches.set(id, { x, y, t: performance.now(), moved: 0 });
    this.showSpark(x, y, true);
  }
  move(id: number, x: number, y: number) {
    const t = this.touches.get(id);
    if (!t) return;
    const dx = x - t.x;
    const dy = y - t.y;
    t.x = x;
    t.y = y;
    t.moved += Math.abs(dx) + Math.abs(dy);
    if (this.touches.size === 1) this.input.addPointer(dx * 2, dy * 2);
    this.showSpark(x, y, true);
  }
  up(id: number) {
    const t = this.touches.get(id);
    if (!t) return;
    const fingers = this.touches.size;
    this.touches.delete(id);
    if (performance.now() - t.t < 220 && t.moved < 12) {
      this.input.pulse(fingers >= 2 ? "B" : "A");
      tick(10);
    }
    if (this.touches.size === 0) this.showSpark(0, 0, false);
  }
  private showSpark(x: number, y: number, on: boolean) {
    const r = this.el.getBoundingClientRect();
    this.spark.style.left = `${x - r.left}px`;
    this.spark.style.top = `${y - r.top}px`;
    this.spark.style.opacity = on ? "1" : "0";
  }
}

// ---- Tilt ----

/** TiltWheel shows a steering wheel that turns with the phone. The reading
 *  comes from Input.tilt (device orientation); this is only the picture. */
export class TiltWheel {
  el: HTMLElement;
  constructor(place: Place, parent: HTMLElement) {
    this.el = el("wheel", place, parent);
  }
  set(angle: number) {
    this.el.style.transform = `translate(-50%, -50%) rotate(${angle * 90}deg)`;
  }
}

/** Every button bit mapped to its default label. */
export const DEFAULT_LABELS: Record<ButtonName, string> = {
  Up: "▲", Down: "▼", Left: "◀", Right: "▶", A: "A", B: "B", X: "X", Y: "Y", L: "L", R: "R", Start: "START", Select: "SELECT",
};

/** bitOf returns the mask bit for a button name. */
export const bitOf = (b: ButtonName) => 1 << Button[b];
