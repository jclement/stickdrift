// The layout designer's data model, kept free of the DOM so it can be unit
// tested: what each control type needs, the default for a new control,
// the on-screen geometry (which must match how the phone builds a custom
// layout in src/client/pad/layouts.ts, or the designer would lie), and how
// a design travels in a URL.
import {
  BUTTON_NAMES,
  THEME_FONTS,
  THEME_SHAPES,
  THEME_STYLES,
  cleanCustom,
  cleanTheme,
  type ButtonName,
  type ControlType,
  type CustomControl,
  type CustomLayout,
  type PadLook,
  type Theme,
} from "../../shared/protocol";
import { asciiJson, base64url } from "./markdown";

export { BUTTON_NAMES, THEME_FONTS, THEME_SHAPES, THEME_STYLES };

/** Everything the designer edits: the layout plus how the phone looks. */
export interface Design {
  orientation: "landscape" | "portrait";
  controls: CustomControl[];
  color: string; // the player colour
  theme: Theme;
}

/** A field the properties panel can show for a control. */
export type Field = "button" | "label" | "color" | "solid" | "size" | "w" | "h" | "side" | "floating" | "dpad" | "diagonals";

/** FIELDS lists, per control type, the fields the phone actually reads
 *  (see buildCustom in layouts.ts). The panel shows only these. */
export const FIELDS: Record<ControlType, Field[]> = {
  button: ["button", "label", "color", "solid", "size"],
  buzzer: ["button", "label", "size"],
  tile: ["button", "label", "color", "w", "h"],
  pill: ["button", "label"],
  shoulder: ["button", "label"],
  dpad: ["size", "diagonals"],
  stick: ["side", "floating", "dpad", "size", "w", "h"],
  slider: ["w"],
  touchpad: ["w", "h"],
};

/** Human names for the palette. */
export const TYPE_NAMES: Record<ControlType, string> = {
  button: "Button",
  buzzer: "Buzzer",
  tile: "Tile",
  pill: "Pill",
  shoulder: "Shoulder",
  dpad: "D-pad",
  stick: "Stick",
  slider: "Slider",
  touchpad: "Touchpad",
};

/** Defaults the phone applies when a field is missing (layouts.ts). */
export const PHONE_DEFAULTS = { size: 0.22, w: 0.3, h: 0.2, button: "A" as ButtonName };

/** newControl makes a sensible new control of a type at x, y. */
export function newControl(type: ControlType, x = 0.5, y = 0.5, taken: ButtonName[] = []): CustomControl {
  const free = (["A", "B", "X", "Y", "L", "R", "Start", "Select"] as ButtonName[]).find((b) => !taken.includes(b)) ?? "A";
  switch (type) {
    case "button":
      return { type, x, y, size: 0.24, button: free, label: free };
    case "buzzer":
      return { type, x, y, size: 0.5, button: free, label: "GO" };
    case "tile":
      return { type, x, y, w: 0.2, h: 0.24, button: free, label: free };
    case "pill":
      return { type, x, y, button: "Start", label: "START" };
    case "shoulder":
      return { type, x, y, button: taken.includes("L") ? "R" : "L", label: taken.includes("L") ? "R" : "L" };
    case "dpad":
      return { type, x, y, size: 0.42, diagonals: true };
    case "stick":
      return { type, x, y, w: 0.4, h: 0.7, size: 0.5, side: "left" };
    case "slider":
      return { type, x, y, w: 0.5 };
    case "touchpad":
      return { type, x, y, w: 0.5, h: 0.5 };
  }
}

/** A control's box on screen, in pixels, centred at (cx, cy). */
export interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  round: boolean;
  /** For sticks: the knob's travel circle, inside the touch zone. */
  knob?: number;
}

/** unit is the phone's sizing unit: the short edge, but never more than
 *  60% of the width (so landscape controls don't swell on wide screens). */
export function unit(width: number, height: number): number {
  return Math.min(height, width * 0.6);
}

/** boxOf computes where the phone will draw a control on a width x height
 *  surface. Mirrors buildCustom in src/client/pad/layouts.ts. */
export function boxOf(c: CustomControl, width: number, height: number): Box {
  const u = unit(width, height);
  const cx = c.x * width;
  const cy = c.y * height;
  const size = (c.size ?? PHONE_DEFAULTS.size) * u;
  const rw = (c.w ?? PHONE_DEFAULTS.w) * width;
  const rh = (c.h ?? PHONE_DEFAULTS.h) * height;
  switch (c.type) {
    case "button":
    case "buzzer":
      return { cx, cy, w: size, h: size, round: true };
    case "dpad":
      return { cx, cy, w: size, h: size, round: false };
    case "pill":
      return { cx, cy, w: u * 0.26, h: u * 0.09, round: false };
    case "shoulder":
      return { cx, cy, w: u * 0.42, h: u * 0.15, round: false };
    case "slider":
      return { cx, cy, w: rw, h: u * 0.12, round: false };
    case "stick":
      return { cx, cy, w: rw, h: rh, round: false, knob: Math.min(size, rw, rh) };
    case "tile":
    case "touchpad":
      return { cx, cy, w: rw, h: rh, round: false };
  }
}

/** round2 keeps fractions short in the JSON (0.4137 -> 0.41). */
export const round2 = (v: number) => Math.round(v * 100) / 100;

/** clamp01 keeps a fraction on the screen. */
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** toLook turns a design into the look a host sends. Theme fields left at
 *  their defaults are omitted so the JSON stays minimal. */
export function toLook(d: Design): PadLook {
  const custom: CustomLayout = { orientation: d.orientation, controls: d.controls.map(tidy) };
  const look: PadLook = { layout: "custom", color: d.color, custom };
  const theme = cleanTheme(d.theme);
  if (theme) look.theme = theme;
  return look;
}

/** tidy drops fields the control's type doesn't use and rounds numbers. */
function tidy(c: CustomControl): CustomControl {
  const out: CustomControl = { type: c.type, x: round2(c.x), y: round2(c.y) };
  for (const f of FIELDS[c.type]) {
    const v = c[f];
    if (v === undefined || v === "") continue;
    (out as unknown as Record<string, unknown>)[f] = typeof v === "number" ? round2(v) : v;
  }
  return out;
}

/** encodeDesign packs a design into a URL-safe string (ASCII JSON, base64url). */
export function encodeDesign(d: Design): string {
  return base64url(asciiJson(toLook(d)));
}

/** decodeDesign reads a look (from a URL fragment or pasted JSON), validating
 *  it exactly as the phone would. Returns null if there is no usable layout. */
export function decodeDesign(input: string): Design | null {
  let raw: unknown;
  try {
    const text = input.trim().startsWith("{") ? input : atob(input.replace(/-/g, "+").replace(/_/g, "/"));
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const look = raw as { custom?: unknown; color?: unknown; theme?: unknown };
  const custom = cleanCustom(look.custom ?? raw);
  if (!custom) return null;
  return {
    orientation: custom.orientation === "portrait" ? "portrait" : "landscape",
    controls: custom.controls,
    color: typeof look.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(look.color) ? look.color : "#ff4d6d",
    theme: cleanTheme(look.theme) ?? {},
  };
}

/** previewPath is the /j?preview= link that shows a design on a phone. */
export function previewPath(d: Design): string {
  const q = new URLSearchParams({ preview: "custom", color: d.color });
  const t = d.theme;
  if (t.style) q.set("style", t.style);
  if (t.font) q.set("font", t.font);
  if (t.shape) q.set("shape", t.shape);
  if (t.background) q.set("bg", t.background);
  if (t.text) q.set("text", t.text);
  return `/j?${q}#layout=${base64url(asciiJson(toLook(d).custom))}`;
}

/** STARTERS are designs to begin from. */
export const STARTERS: Record<string, Design> = {
  shooter: {
    orientation: "landscape",
    color: "#ff8c1a",
    theme: {},
    controls: [
      { type: "stick", x: 0.2, y: 0.6, w: 0.4, h: 0.75, size: 0.5, side: "left" },
      { type: "button", x: 0.86, y: 0.42, size: 0.3, button: "A", label: "FIRE", solid: true },
      { type: "button", x: 0.68, y: 0.68, size: 0.24, button: "B", label: "BOOST", color: "#3a86ff" },
      { type: "tile", x: 0.62, y: 0.2, w: 0.16, h: 0.18, button: "X", label: "MAP", color: "#38d996" },
      { type: "pill", x: 0.42, y: 0.12, button: "Start", label: "PAUSE" },
    ],
  },
  racer: {
    orientation: "landscape",
    color: "#ffbe0b",
    theme: { style: "retro", font: "pixel", shape: "square" },
    controls: [
      { type: "slider", x: 0.3, y: 0.62, w: 0.5 },
      { type: "tile", x: 0.78, y: 0.35, w: 0.3, h: 0.32, button: "A", label: "GAS", color: "#38d996" },
      { type: "tile", x: 0.78, y: 0.75, w: 0.3, h: 0.32, button: "B", label: "BRAKE", color: "#ff4d6d" },
      { type: "pill", x: 0.3, y: 0.15, button: "Start", label: "PAUSE" },
    ],
  },
  quiz: {
    orientation: "portrait",
    color: "#3a86ff",
    theme: { style: "candy", font: "sans", shape: "rounded" },
    controls: [
      { type: "tile", x: 0.27, y: 0.3, w: 0.42, h: 0.26, button: "A", label: "A", color: "#ff4d6d" },
      { type: "tile", x: 0.73, y: 0.3, w: 0.42, h: 0.26, button: "B", label: "B", color: "#3a86ff" },
      { type: "tile", x: 0.27, y: 0.62, w: 0.42, h: 0.26, button: "X", label: "C", color: "#ffbe0b" },
      { type: "tile", x: 0.73, y: 0.62, w: 0.42, h: 0.26, button: "Y", label: "D", color: "#38d996" },
    ],
  },
  blank: { orientation: "landscape", color: "#ff4d6d", theme: {}, controls: [] },
};
