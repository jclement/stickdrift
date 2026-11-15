// Layouts: each builds its controls for the current screen size. Positions
// are fractions of the surface (x of width, y of height) and sizes are
// fractions of the short edge, so one definition fits every phone.
import type { ButtonName, PadLook } from "../../shared/protocol";
import { DEFAULT_LABELS, Dpad, PressButton, Slider, Stick, TiltWheel, Touchpad, type ButtonStyle, type Control } from "./controls";
import type { Input } from "./input";

/** What a layout build returns. */
export interface Built {
  controls: Control[];
  wheel?: TiltWheel; // tilt layout's picture
  needsLandscape: boolean;
  usesTilt: boolean;
}

interface Ctx {
  input: Input;
  root: HTMLElement;
  w: number;
  h: number;
  u: number; // the short edge, the unit for sizes
  look: PadLook;
}

/** Classic quiz colours (not tied to any show's look). */
const QUIZ = { A: "#ff4d6d", B: "#3a86ff", X: "#ffbe0b", Y: "#38d996" } as const;
/** Arcade face-button colours. */
const FACE = { A: "#38d996", B: "#ff4d6d", X: "#3a86ff", Y: "#ffbe0b" } as const;

function label(c: Ctx, b: ButtonName): string {
  return c.look.labels?.[b] ?? DEFAULT_LABELS[b];
}

function button(c: Ctx, b: ButtonName, x: number, y: number, size: number, style: ButtonStyle = "btn", colour?: string): PressButton {
  const px = size * c.u;
  return new PressButton(c.input, b, { x: x * c.w, y: y * c.h, w: px, h: px }, c.root, style, label(c, b), colour);
}

function pill(c: Ctx, b: ButtonName, x: number, y: number): PressButton {
  return new PressButton(c.input, b, { x: x * c.w, y: y * c.h, w: c.u * 0.26, h: c.u * 0.09 }, c.root, "pill", label(c, b));
}

function shoulder(c: Ctx, b: ButtonName, x: number, y: number): PressButton {
  return new PressButton(c.input, b, { x: x * c.w, y: y * c.h, w: c.u * 0.42, h: c.u * 0.15 }, c.root, "shoulder", label(c, b));
}

function dpad(c: Ctx, x: number, y: number, size: number, diagonals = true): Dpad {
  const px = size * c.u;
  return new Dpad(c.input, { x: x * c.w, y: y * c.h, w: px, h: px }, c.root, diagonals);
}

/** A floating stick over a zone given as fractions (left, top, right, bottom). */
function stick(c: Ctx, side: "left" | "right", zone: [number, number, number, number], floating: boolean, drivesDpad: boolean, size = 0.5): Stick {
  const [l, t, r, b] = zone;
  const place = { x: ((l + r) / 2) * c.w, y: ((t + b) / 2) * c.h, w: (r - l) * c.w, h: (b - t) * c.h };
  return new Stick(c.input, place, c.root, side, floating, drivesDpad, size * c.u);
}

/** The A/B pair on the right, accent-filled A for the main action. */
function abPair(c: Ctx): Control[] {
  return [button(c, "A", 0.86, 0.5, 0.34, "btn solid"), button(c, "B", 0.66, 0.7, 0.28)];
}

type Builder = (c: Ctx) => Built;

const builders: Record<string, Builder> = {
  "dpad-ab": (c) => ({
    controls: [dpad(c, 0.22, 0.58, 0.66, c.look.diagonals !== false), ...abPair(c), pill(c, "Start", 0.5, 0.9)],
    needsLandscape: true,
    usesTilt: false,
  }),
  "stick-ab": (c) => ({
    controls: [stick(c, "left", [0, 0.15, 0.5, 1], true, true), ...abPair(c), pill(c, "Start", 0.5, 0.9)],
    needsLandscape: true,
    usesTilt: false,
  }),
  arcade: (c) => ({
    controls: [
      dpad(c, 0.21, 0.58, 0.62, c.look.diagonals !== false),
      button(c, "Y", 0.81, 0.33, 0.21, "btn", FACE.Y),
      button(c, "X", 0.7, 0.56, 0.21, "btn", FACE.X),
      button(c, "B", 0.92, 0.56, 0.21, "btn", FACE.B),
      button(c, "A", 0.81, 0.79, 0.21, "btn", FACE.A),
      pill(c, "Select", 0.42, 0.9),
      pill(c, "Start", 0.58, 0.9),
    ],
    needsLandscape: true,
    usesTilt: false,
  }),
  gamepad: (c) => ({
    controls: [
      stick(c, "left", [0, 0.18, 0.36, 0.72], true, true, 0.42),
      dpad(c, 0.27, 0.78, 0.34),
      button(c, "Y", 0.82, 0.36, 0.18, "btn", FACE.Y),
      button(c, "X", 0.72, 0.56, 0.18, "btn", FACE.X),
      button(c, "B", 0.92, 0.56, 0.18, "btn", FACE.B),
      button(c, "A", 0.82, 0.76, 0.18, "btn", FACE.A),
      shoulder(c, "L", 0.13, 0.1),
      shoulder(c, "R", 0.87, 0.1),
      pill(c, "Select", 0.47, 0.9),
      pill(c, "Start", 0.6, 0.9),
    ],
    needsLandscape: true,
    usesTilt: false,
  }),
  "twin-stick": (c) => ({
    controls: [
      stick(c, "left", [0, 0.2, 0.5, 1], true, true, 0.48),
      stick(c, "right", [0.5, 0.2, 1, 1], true, false, 0.48),
      shoulder(c, "L", 0.13, 0.1),
      shoulder(c, "R", 0.87, 0.1),
      pill(c, "Start", 0.5, 0.9),
    ],
    needsLandscape: true,
    usesTilt: false,
  }),
  buzzer: (c) => ({
    controls: [new PressButton(c.input, "A", { x: c.w / 2, y: c.h * 0.55, w: c.u * 0.72, h: c.u * 0.72 }, c.root, "buzzer", c.look.labels?.A ?? "BUZZ")],
    needsLandscape: false,
    usesTilt: false,
  }),
  quiz: (c) => {
    const portrait = c.h > c.w;
    const cells: [ButtonName, number, number][] = portrait
      ? [["A", 0.27, 0.36], ["B", 0.73, 0.36], ["X", 0.27, 0.72], ["Y", 0.73, 0.72]]
      : [["A", 0.27, 0.36], ["B", 0.73, 0.36], ["X", 0.27, 0.74], ["Y", 0.73, 0.74]];
    const w = c.w * 0.42;
    const h = c.h * (portrait ? 0.32 : 0.33);
    return {
      controls: cells.map(([b, x, y]) => new PressButton(c.input, b, { x: x * c.w, y: y * c.h, w, h }, c.root, "tile", label(c, b), QUIZ[b as keyof typeof QUIZ])),
      needsLandscape: false,
      usesTilt: false,
    };
  },
  paddle: (c) => ({
    controls: [
      new Slider(c.input, { x: c.w / 2, y: c.h * 0.42, w: c.w * 0.84, h: c.u * 0.12 }, c.root),
      button(c, "A", 0.5, 0.78, 0.26, "btn solid"),
    ],
    needsLandscape: false,
    usesTilt: false,
  }),
  tilt: (c) => {
    const wheel = new TiltWheel({ x: c.w / 2, y: c.h * 0.55, w: c.u * 0.5, h: c.u * 0.5 }, c.root);
    return {
      controls: [
        new PressButton(c.input, "B", { x: c.w * 0.14, y: c.h * 0.6, w: c.w * 0.22, h: c.h * 0.6 }, c.root, "tile", c.look.labels?.B ?? "BRAKE", "#555a70"),
        new PressButton(c.input, "A", { x: c.w * 0.86, y: c.h * 0.6, w: c.w * 0.22, h: c.h * 0.6 }, c.root, "tile", c.look.labels?.A ?? "GAS"),
        pill(c, "Start", 0.5, 0.9),
      ],
      wheel,
      needsLandscape: true,
      usesTilt: true,
    };
  },
  touchpad: (c) => ({
    controls: [
      new Touchpad(c.input, { x: c.w / 2, y: c.h * 0.46, w: c.w * 0.9, h: c.h * 0.56 }, c.root),
      button(c, "A", 0.3, 0.87, 0.17, "btn solid"),
      button(c, "B", 0.7, 0.87, 0.17),
    ],
    needsLandscape: false,
    usesTilt: false,
  }),
};

/** buildCustom places whatever a host described (already validated). */
function buildCustom(c: Ctx): Built {
  const def = c.look.custom;
  if (!def) return builders["dpad-ab"](c);
  const controls: Control[] = [];
  for (const d of def.controls) {
    const x = d.x * c.w;
    const y = d.y * c.h;
    const size = (d.size ?? 0.22) * c.u;
    const rect = { x, y, w: (d.w ?? 0.3) * c.w, h: (d.h ?? 0.2) * c.h };
    const b = d.button ?? "A";
    const text = d.label ?? label(c, b);
    switch (d.type) {
      case "button":
        controls.push(new PressButton(c.input, b, { x, y, w: size, h: size }, c.root, d.solid ? "btn solid" : "btn", text, d.color));
        break;
      case "buzzer":
        controls.push(new PressButton(c.input, b, { x, y, w: size, h: size }, c.root, "buzzer", text));
        break;
      case "tile":
        controls.push(new PressButton(c.input, b, rect, c.root, "tile", text, d.color));
        break;
      case "pill":
        controls.push(new PressButton(c.input, b, { x, y, w: c.u * 0.26, h: c.u * 0.09 }, c.root, "pill", text));
        break;
      case "shoulder":
        controls.push(new PressButton(c.input, b, { x, y, w: c.u * 0.42, h: c.u * 0.15 }, c.root, "shoulder", text));
        break;
      case "dpad":
        controls.push(new Dpad(c.input, { x, y, w: size, h: size }, c.root, d.diagonals !== false));
        break;
      case "stick": {
        const side = d.side ?? "left";
        controls.push(new Stick(c.input, rect, c.root, side, d.floating !== false, d.dpad ?? side === "left", Math.min(size, rect.w, rect.h)));
        break;
      }
      case "slider":
        controls.push(new Slider(c.input, { x, y, w: rect.w, h: c.u * 0.12 }, c.root));
        break;
      case "touchpad":
        controls.push(new Touchpad(c.input, rect, c.root));
        break;
    }
  }
  return { controls, needsLandscape: def.orientation === "landscape", usesTilt: false };
}
builders.custom = buildCustom;

/** build lays out a controller in root, replacing whatever was there. */
export function build(id: string, input: Input, root: HTMLElement, look: PadLook): Built {
  root.replaceChildren();
  const w = root.clientWidth;
  const h = root.clientHeight;
  const u = Math.min(h, w * 0.6);
  return (builders[id] ?? builders["dpad-ab"])({ input, root, w, h, u, look });
}

/** swapPartner is the layout a player can flip to when the host allows it. */
export function swapPartner(id: string): string | null {
  return ({ "dpad-ab": "stick-ab", "stick-ab": "dpad-ab", arcade: "gamepad", gamepad: "arcade" } as Record<string, string>)[id] ?? null;
}
