// The wire protocol shared by the Worker, the phone controller page, the
// browser host SDK and (by specification in PROTOCOL.md) the Go client.
//
// Two kinds of message travel over each WebSocket:
//   * binary INPUT frames (phone -> relay -> host): a full snapshot of the
//     controller's state, 16 bytes, sent on every change. Full snapshots mean
//     a hold is simply "the bit is still set", and nothing can get stuck after
//     a reconnect. The relay forwards them byte-for-byte except byte 1, which
//     it overwrites with the pad number.
//   * JSON text control messages, everything else (rare, not latency bound).

/** Protocol version; bump on any incompatible change. */
export const PROTOCOL_VERSION = 1;

/** Size of a binary input frame in bytes. */
export const FRAME_SIZE = 16;

/** Binary frame kinds (byte 0). */
export const FRAME_INPUT = 1;

/** Button bit positions inside the 32-bit button mask. */
export const Button = {
  Up: 0,
  Down: 1,
  Left: 2,
  Right: 3,
  A: 4,
  B: 5,
  X: 6,
  Y: 7,
  L: 8,
  R: 9,
  Start: 10,
  Select: 11,
} as const;
export type ButtonName = keyof typeof Button;

/** Every button name in bit order. */
export const BUTTON_NAMES = Object.keys(Button) as ButtonName[];

/** A decoded controller state. Axes are -1..1; pointer is accumulated pixels. */
export interface PadState {
  seq: number;
  buttons: number; // bitmask, see Button
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  px: number; // touchpad pointer, accumulated, wraps at 16 bits
  py: number;
}

/** A neutral (nothing pressed) state. */
export function emptyState(): PadState {
  return { seq: 0, buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0, px: 0, py: 0 };
}

/** isDown reports whether a button is held in a state. */
export function isDown(s: PadState, b: ButtonName): boolean {
  return (s.buttons & (1 << Button[b])) !== 0;
}

const axisToByte = (v: number) => Math.max(-127, Math.min(127, Math.round(v * 127)));

/**
 * encodeFrame writes a state as a 16-byte input frame. Layout (little endian):
 *   0 u8  kind (1 = input)     1 u8  pad (set by the relay; 0 from phones)
 *   2 u16 seq                  4 u32 buttons
 *   8 i8  lx  9 i8 ly  10 i8 rx  11 i8 ry
 *  12 i16 px 14 i16 py
 */
export function encodeFrame(s: PadState, pad = 0): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_SIZE);
  const v = new DataView(buf);
  v.setUint8(0, FRAME_INPUT);
  v.setUint8(1, pad);
  v.setUint16(2, s.seq & 0xffff, true);
  v.setUint32(4, s.buttons >>> 0, true);
  v.setInt8(8, axisToByte(s.lx));
  v.setInt8(9, axisToByte(s.ly));
  v.setInt8(10, axisToByte(s.rx));
  v.setInt8(11, axisToByte(s.ry));
  v.setInt16(12, ((s.px % 65536) + 98304) % 65536 - 32768, true);
  v.setInt16(14, ((s.py % 65536) + 98304) % 65536 - 32768, true);
  return buf;
}

/** decodeFrame parses an input frame, returning the pad number and state. */
export function decodeFrame(buf: ArrayBuffer): { pad: number; state: PadState } | null {
  if (buf.byteLength !== FRAME_SIZE) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== FRAME_INPUT) return null;
  return {
    pad: v.getUint8(1),
    state: {
      seq: v.getUint16(2, true),
      buttons: v.getUint32(4, true),
      lx: v.getInt8(8) / 127,
      ly: v.getInt8(9) / 127,
      rx: v.getInt8(10) / 127,
      ry: v.getInt8(11) / 127,
      px: v.getInt16(12, true),
      py: v.getInt16(14, true),
    },
  };
}

// ---- Layouts ----

/** A controller layout the phone can show. */
export interface LayoutInfo {
  id: string;
  name: string;
  blurb: string;
  /** Orientation the layout is designed for. */
  orientation: "landscape" | "portrait" | "any";
  /** Buttons/axes it can produce, for host developers. */
  produces: string;
}

/** The layouts the phone controller implements (see src/client/pad/layouts.ts). */
export const LAYOUTS: LayoutInfo[] = [
  { id: "dpad-ab", name: "Classic", blurb: "D-pad plus A and B. The eight-bit original.", orientation: "landscape", produces: "Up Down Left Right A B Start" },
  { id: "stick-ab", name: "Thumbstick", blurb: "A floating analog stick that appears under your thumb, plus A and B. Also sets the D-pad bits.", orientation: "landscape", produces: "lx ly, Up Down Left Right, A B Start" },
  { id: "arcade", name: "Arcade", blurb: "D-pad, four face buttons, Start and Select.", orientation: "landscape", produces: "Up Down Left Right A B X Y Start Select" },
  { id: "gamepad", name: "Gamepad", blurb: "Stick, D-pad, four face buttons, shoulders, Start and Select. The works.", orientation: "landscape", produces: "lx ly, all buttons" },
  { id: "twin-stick", name: "Twin Stick", blurb: "Move with the left stick, aim with the right. Shoulder buttons on top.", orientation: "landscape", produces: "lx ly rx ry, L R, D-pad bits from the left stick" },
  { id: "buzzer", name: "Buzzer", blurb: "One enormous button. Quiz night, reaction games, panic.", orientation: "any", produces: "A" },
  { id: "quiz", name: "Quiz", blurb: "Four big coloured answer buttons.", orientation: "any", produces: "A B X Y" },
  { id: "paddle", name: "Paddle", blurb: "A slider for one axis plus a fire button. Pong, Breakout.", orientation: "any", produces: "lx, A" },
  { id: "tilt", name: "Tilt", blurb: "Steer by tilting the phone; gas and brake under your thumbs.", orientation: "landscape", produces: "lx ly (tilt), A B, Left Right bits" },
  { id: "custom", name: "Custom", blurb: "Whatever the game describes: any mix of buttons, d-pads, sticks, sliders and touchpads, placed anywhere.", orientation: "any", produces: "whatever it declares" },
  { id: "touchpad", name: "Touchpad", blurb: "A trackpad: drag to move the pointer, tap to click, two-finger tap for B.", orientation: "any", produces: "px py, A B" },
];

/** isLayout reports whether id names a known layout. */
export function isLayout(id: string): boolean {
  return LAYOUTS.some((l) => l.id === id);
}

// ---- Control messages (JSON) ----

/** Per-pad presentation the host may set. */
export interface PadLook {
  layout?: string;
  label?: string; // shown big on the phone, e.g. "PLAYER 1" or "RED"
  color?: string; // CSS colour, tints the controller
  labels?: Partial<Record<ButtonName, string>>; // relabel buttons ("BOMB")
  message?: string; // a line of status text
  swap?: boolean; // allow the player to flip between D-pad and stick variants
  diagonals?: boolean; // false = 4-way d-pad (grid games); default 8-way
  custom?: CustomLayout; // the controls for layout "custom"
  theme?: Theme; // the controller's visual style
}

// ---- Themes ----

/** Visual presets. Each is a coherent look; colours then tint it. */
export const THEME_STYLES = ["glass", "neon", "flat", "retro", "candy"] as const;
/** Fonts the controller page loads. */
export const THEME_FONTS = ["display", "sans", "mono", "pixel"] as const;
/** Button shapes. */
export const THEME_SHAPES = ["round", "rounded", "square"] as const;

/** How the controller looks. Only presets and colours: a host can restyle
 *  players' phones but never inject arbitrary CSS or markup into them. */
export interface Theme {
  style?: (typeof THEME_STYLES)[number];
  background?: string; // hex
  text?: string; // hex
  font?: (typeof THEME_FONTS)[number];
  shape?: (typeof THEME_SHAPES)[number];
}

const HEX = /^#[0-9a-fA-F]{3,8}$/;

/** cleanTheme validates a theme from an untrusted source. */
export function cleanTheme(raw: unknown): Theme | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const t: Theme = {};
  if (THEME_STYLES.includes(r.style as Theme["style"] & string)) t.style = r.style as Theme["style"];
  if (THEME_FONTS.includes(r.font as Theme["font"] & string)) t.font = r.font as Theme["font"];
  if (THEME_SHAPES.includes(r.shape as Theme["shape"] & string)) t.shape = r.shape as Theme["shape"];
  if (typeof r.background === "string" && HEX.test(r.background)) t.background = r.background;
  if (typeof r.text === "string" && HEX.test(r.text)) t.text = r.text;
  return Object.keys(t).length ? t : null;
}

// ---- Custom layouts ----

/** The kinds of control a custom layout can place. */
export const CONTROL_TYPES = ["button", "pill", "shoulder", "tile", "buzzer", "dpad", "stick", "slider", "touchpad"] as const;
export type ControlType = (typeof CONTROL_TYPES)[number];

/** One control in a custom layout. Positions are fractions of the screen
 *  (x of width, y of height, centre of the control); size is a fraction of
 *  the screen's short edge; w/h are fractions of width/height for
 *  rectangular controls. */
export interface CustomControl {
  type: ControlType;
  x: number;
  y: number;
  size?: number;
  w?: number;
  h?: number;
  button?: ButtonName; // which bit a button/tile/buzzer/pill/shoulder sets
  label?: string;
  color?: string;
  solid?: boolean; // filled button
  side?: "left" | "right"; // which stick axes a stick or slider drives
  floating?: boolean; // stick recentres under the thumb (default true)
  dpad?: boolean; // stick also sets d-pad bits (default true for left)
  diagonals?: boolean; // d-pad 8-way (default true)
}

/** A complete custom layout. */
export interface CustomLayout {
  orientation?: "landscape" | "portrait" | "any";
  controls: CustomControl[];
}

/** Most controls a custom layout may declare. */
export const MAX_CUSTOM_CONTROLS = 32;

/** cleanCustom validates a custom layout from an untrusted source, keeping
 *  only known fields with sane values. Returns null if nothing usable. */
export function cleanCustom(raw: unknown): CustomLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { orientation?: unknown; controls?: unknown };
  if (!Array.isArray(r.controls)) return null;
  const frac = (v: unknown, lo = 0, hi = 1) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
  const controls: CustomControl[] = [];
  for (const c of r.controls.slice(0, MAX_CUSTOM_CONTROLS)) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    if (!CONTROL_TYPES.includes(o.type as ControlType)) continue;
    const x = frac(o.x);
    const y = frac(o.y);
    if (x === undefined || y === undefined) continue;
    const out: CustomControl = { type: o.type as ControlType, x, y };
    out.size = frac(o.size, 0.05, 1);
    out.w = frac(o.w, 0.02, 1);
    out.h = frac(o.h, 0.02, 1);
    if (typeof o.button === "string" && Object.hasOwn(Button, o.button)) out.button = o.button as ButtonName;
    if (typeof o.label === "string") out.label = o.label.slice(0, 12);
    if (typeof o.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(o.color)) out.color = o.color;
    if (typeof o.solid === "boolean") out.solid = o.solid;
    if (o.side === "left" || o.side === "right") out.side = o.side;
    if (typeof o.floating === "boolean") out.floating = o.floating;
    if (typeof o.dpad === "boolean") out.dpad = o.dpad;
    if (typeof o.diagonals === "boolean") out.diagonals = o.diagonals;
    controls.push(out);
  }
  if (!controls.length) return null;
  const orientation = r.orientation === "portrait" || r.orientation === "landscape" ? r.orientation : "any";
  return { orientation, controls };
}

/** Host -> relay. */
export type HostMessage =
  | { t: "config"; title?: string; maxPads?: number; open?: boolean; look?: PadLook }
  | ({ t: "pad"; pad: number } & PadLook)
  | { t: "haptic"; pad: number; ms: number | number[] }
  | { t: "kick"; pad: number };

/** Relay -> host. */
export type ToHostMessage =
  | { t: "welcome"; code: string; joinUrl: string; version: number; pads: PadInfo[] }
  | ({ t: "join" } & PadInfo)
  | { t: "leave"; pad: number }
  | { t: "rtt"; pad: number; ms: number }
  | { t: "error"; code: string; message: string };

/** A connected pad as the host sees it. */
export interface PadInfo {
  pad: number;
  device: string;
  name?: string;
  rejoin?: boolean;
}

/** Relay -> phone. */
export type ToPadMessage =
  | ({ t: "setup"; pad: number; title: string; version: number } & PadLook)
  | { t: "haptic"; ms: number | number[] }
  | { t: "host"; online: boolean }
  | { t: "kicked" }
  | { t: "full" }
  | { t: "pong" };

/** Phone -> relay. */
export type PadMessage = { t: "hello"; name?: string } | { t: "rtt"; ms: number };

/** The exact ping string both sides send; the relay answers it without waking. */
export const PING = '{"t":"ping"}';
/** The exact pong reply to PING. */
export const PONG = '{"t":"pong"}';

// ---- Room codes ----

/** Letters used in room codes: no I or O, which look like 1 and 0. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
/** Length of a room code. */
export const CODE_LENGTH = 5;

/** isCode reports whether s is a well-formed room code. */
export function isCode(s: string): boolean {
  if (s.length !== CODE_LENGTH) return false;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** randomCode makes a fresh room code using crypto randomness. */
export function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}
