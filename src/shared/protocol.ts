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
/** A ping over the peer-to-peer data channel: the host echoes it back
 *  unchanged (8 bytes: kind, 3 spare, u32 phone timestamp in ms). */
export const FRAME_PING = 2;

/** STUN servers for WebRTC. No TURN: if peers can't connect directly the
 *  relay WebSocket is already the fallback. */
export const ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];

/** seqNewer reports whether 16-bit sequence a is after b (wrap-aware). */
export function seqNewer(a: number, b: number): boolean {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

/** A WebRTC signalling payload, relayed verbatim between pad and host. */
export type Signal = { type: "offer" | "answer"; sdp: string } | { type: "candidate"; candidate: RTCIceCandidateInitLike | null };
/** The subset of RTCIceCandidateInit we pass around (no DOM types here). */
export interface RTCIceCandidateInitLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

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
  { id: "screen", name: "Screen", blurb: "A little app page instead of a game pad: text cards, votes, bets, a text box and buttons, for word and card games.", orientation: "portrait", produces: "screen events (no buttons)" },
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
  avatar?: string; // data:image/png;base64,... (≤ 24 KB): who you are, shown in the HUD and behind the controls
  banner?: string; // big faded text behind the controls, e.g. "RED"
  screen?: Screen | null; // the page for layout "screen"; null (pad looks only) falls back to the room's
}

/** Largest avatar data URL accepted. A 64x64 PNG is a few KB. */
export const MAX_AVATAR_BYTES = 24 * 1024;

/** cleanAvatar accepts only a size-limited base64 PNG data URL. Rendered as
 *  an <img>, a PNG can't run script, and nothing else gets through. */
export function cleanAvatar(v: unknown): string | null {
  if (typeof v !== "string" || v.length > MAX_AVATAR_BYTES) return null;
  return /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(v) ? v : null;
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

// ---- Screens (layout "screen") ----
//
// A screen is a declarative page the phone renders as a normal scrolling
// portrait page: headings, text, text cards to pick from, choices to vote
// for, steppers and sliders, a text box, buttons and a status line. Players
// answer with events ({t:"event"}), each naming the screen it answers, so a
// late tap from a screen the host has since replaced never counts. Everything
// here is plain text: the phone sets textContent, never innerHTML.

/** The element types a screen can hold. */
export const SCREEN_ELEMENTS = ["heading", "text", "cards", "choices", "stepper", "slider", "input", "button", "status"] as const;
export type ScreenElementType = (typeof SCREEN_ELEMENTS)[number];

/** Element types that send events. */
export const INTERACTIVE_ELEMENTS: readonly ScreenElementType[] = ["cards", "choices", "stepper", "slider", "input", "button"];

/** Screen limits, enforced by the relay and again by the phone. */
export const SCREEN_LIMITS = {
  items: 24, // elements per screen
  cards: 12, // cards per cards element
  cardText: 140,
  options: 16, // options per choices element
  optionText: 60,
  pick: 3, // most cards or options picked at once
  heading: 80,
  text: 280,
  status: 80,
  label: 24, // button labels and submit labels
  placeholder: 60,
  input: 80, // characters a player may type
  number: 1e6, // stepper and slider bounds, ±
  countdown: 3600, // status seconds
} as const;

/** A text card. */
export interface ScreenCard {
  id: string;
  text: string;
}

/** A line in a choices element. pad shows that player's colour and avatar
 *  (the relay fills in color and avatar from that pad's look). */
export interface ScreenOption {
  id: string;
  text: string;
  pad?: number;
  color?: string;
  avatar?: string; // set by the relay only
}

/** One element of a screen; which fields matter depends on type. */
export interface ScreenElement {
  type: ScreenElementType;
  id?: string; // required for interactive elements, unique on the screen
  text?: string; // heading, text, status
  disabled?: boolean;
  cards?: ScreenCard[];
  options?: ScreenOption[];
  pick?: number; // cards, choices: how many to choose (1-3)
  submit?: string; // a confirm button under the element
  min?: number; // stepper, slider
  max?: number;
  step?: number;
  value?: number;
  maxLength?: number; // input
  placeholder?: string;
  label?: string; // button
  color?: string; // button
  seconds?: number; // status: countdown bar from when the phone shows it
  progress?: number; // status: static bar 0..1
}

/** A page for layout "screen". Re-sending the same id keeps what the player
 *  has selected or typed; a new id starts afresh. */
export interface Screen {
  id: string;
  locked?: boolean; // every control disabled ("Locked in. Judge is thinking…")
  items: ScreenElement[];
}

/** A player's answer. Phone -> relay (and over the data channel); the relay
 *  adds pad. value: cards and choices, the chosen ids in order; stepper and
 *  slider, a number; input, a string; button, absent. n counts up per phone
 *  page so a host can drop the copy that arrives by the other path. */
export interface ScreenEvent {
  t: "event";
  n: number;
  screen: string;
  element: string;
  value?: string[] | number | string | null;
}

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const SCREEN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** plain makes untrusted text safe to keep: a string, control characters
 *  (other than newlines) removed, at most n characters. */
function plain(v: unknown, n: number): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  return [...v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")].slice(0, n).join("");
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** numberRange applies the stepper/slider defaults: max 100 when min and
 *  max are both unset or 0, step 1, value clamped into range. (go/screen.go
 *  numberRange matches.) */
export function numberRange(e: Pick<ScreenElement, "min" | "max" | "step" | "value">): { min: number; max: number; step: number; value: number } {
  const lim = SCREEN_LIMITS.number;
  const clamp = (v: unknown, d: number) => (finite(v) ? Math.max(-lim, Math.min(lim, v)) : d);
  let min = clamp(e.min, 0);
  let max = clamp(e.max, 0);
  if (min === 0 && max === 0) max = 100;
  if (max < min) [min, max] = [max, min];
  const step = finite(e.step) && e.step > 0 ? Math.min(e.step, max - min || 1) : 1;
  const value = Math.max(min, Math.min(max, clamp(e.value, min)));
  return { min, max, step, value };
}

/** pickCount is how many items a cards or choices element wants chosen. */
export function pickCount(e: { pick?: number; cards?: unknown[]; options?: unknown[] }): number {
  const n = (e.cards ?? e.options ?? []).length;
  const want = finite(e.pick) ? Math.floor(e.pick) : 1;
  return Math.max(1, Math.min(SCREEN_LIMITS.pick, want, n || 1));
}

/** inputLength is an input's effective character limit. */
export function inputLength(e: { maxLength?: number }): number {
  const n = finite(e.maxLength) ? Math.floor(e.maxLength) : 0;
  return n >= 1 && n <= SCREEN_LIMITS.input ? n : SCREEN_LIMITS.input;
}

/** cleanScreen validates a screen from an untrusted source, keeping known
 *  fields with sane values and dropping unknown types and fields. Option
 *  avatars are kept only when allowAvatars (the phone, receiving what the
 *  relay filled in); hosts cannot send them. Returns null if unusable. */
export function cleanScreen(raw: unknown, allowAvatars = false): Screen | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !SCREEN_ID.test(r.id) || !Array.isArray(r.items)) return null;
  const L = SCREEN_LIMITS;
  const ids = new Set<string>();
  const items: ScreenElement[] = [];
  for (const it of r.items.slice(0, L.items)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const type = o.type as ScreenElementType;
    if (!SCREEN_ELEMENTS.includes(type)) continue;
    const e: ScreenElement = { type };
    if (INTERACTIVE_ELEMENTS.includes(type)) {
      if (typeof o.id !== "string" || !ID.test(o.id) || ids.has(o.id)) continue;
      ids.add(o.id);
      e.id = o.id;
      if (o.disabled === true) e.disabled = true;
    }
    const submit = plain(o.submit, L.label);
    switch (type) {
      case "heading":
      case "text":
      case "status": {
        const text = plain(o.text, type === "heading" ? L.heading : type === "text" ? L.text : L.status);
        if (text) e.text = text;
        if (type === "status") {
          if (finite(o.seconds) && o.seconds > 0) e.seconds = Math.min(L.countdown, o.seconds);
          if (finite(o.progress)) e.progress = Math.max(0, Math.min(1, o.progress));
        }
        if (!e.text && e.seconds === undefined && e.progress === undefined) continue;
        break;
      }
      case "cards":
      case "choices": {
        const list = type === "cards" ? o.cards : o.options;
        if (!Array.isArray(list)) continue;
        const seen = new Set<string>();
        const out: (ScreenCard & ScreenOption)[] = [];
        for (const c of list.slice(0, type === "cards" ? L.cards : L.options)) {
          if (!c || typeof c !== "object") continue;
          const co = c as Record<string, unknown>;
          if (typeof co.id !== "string" || !ID.test(co.id) || seen.has(co.id)) continue;
          seen.add(co.id);
          const item: ScreenCard & ScreenOption = { id: co.id, text: plain(co.text, type === "cards" ? L.cardText : L.optionText) ?? "" };
          if (type === "choices") {
            if (finite(co.pad) && Number.isInteger(co.pad) && co.pad >= 0 && co.pad < 64) item.pad = co.pad;
            if (typeof co.color === "string" && HEX.test(co.color)) item.color = co.color;
            const avatar = allowAvatars ? cleanAvatar(co.avatar) : null;
            if (avatar) item.avatar = avatar;
          }
          out.push(item);
        }
        if (!out.length) continue;
        if (type === "cards") e.cards = out.map(({ id, text }) => ({ id, text }));
        else e.options = out;
        e.pick = pickCount({ pick: o.pick as number, cards: out });
        if (submit) e.submit = submit;
        break;
      }
      case "stepper":
      case "slider":
        Object.assign(e, numberRange(o as Partial<ScreenElement>));
        if (submit) e.submit = submit;
        break;
      case "input": {
        e.maxLength = inputLength(o as Partial<ScreenElement>);
        const placeholder = plain(o.placeholder, L.placeholder);
        if (placeholder) e.placeholder = placeholder;
        if (submit) e.submit = submit;
        break;
      }
      case "button":
        e.label = plain(o.label, L.label) || "OK";
        if (typeof o.color === "string" && HEX.test(o.color)) e.color = o.color;
        break;
    }
    items.push(e);
  }
  const out: Screen = { id: r.id, items };
  if (r.locked === true) out.locked = true;
  return out;
}

/** checkEvent decides whether an event answers screen, and cleans its value:
 *  the element exists, is interactive and enabled, the screen isn't locked,
 *  picks are that element's ids (pick of them, no repeats), numbers are
 *  clamped into range, text is cut to maxLength. Returns null to drop it.
 *  go/screen.go check mirrors this. */
export function checkEvent(screen: Screen | null | undefined, raw: unknown): ScreenEvent | null {
  if (!screen || screen.locked || !raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.screen !== screen.id || typeof m.element !== "string") return null;
  if (!finite(m.n) || !Number.isInteger(m.n) || m.n < 1 || m.n > 2 ** 31) return null;
  const el = screen.items.find((e) => e.id === m.element && INTERACTIVE_ELEMENTS.includes(e.type));
  if (!el || el.disabled) return null;
  const out: ScreenEvent = { t: "event", n: m.n, screen: screen.id, element: m.element };
  const v = m.value;
  switch (el.type) {
    case "cards":
    case "choices": {
      const allowed = new Set((el.cards ?? el.options ?? []).map((c) => c.id));
      if (!Array.isArray(v) || v.length !== pickCount(el)) return null;
      if (new Set(v).size !== v.length || !v.every((id) => typeof id === "string" && allowed.has(id))) return null;
      out.value = v as string[];
      break;
    }
    case "stepper":
    case "slider": {
      if (!finite(v)) return null;
      const r = numberRange(el);
      out.value = Math.max(r.min, Math.min(r.max, v));
      break;
    }
    case "input":
      if (typeof v !== "string") return null;
      out.value = [...v].slice(0, inputLength(el)).join("");
      break;
    case "button":
      break;
  }
  return out;
}

/** Host -> relay. */
export type HostMessage =
  | { t: "config"; title?: string; maxPads?: number; open?: boolean; look?: PadLook; p2p?: boolean }
  | { t: "signal"; pad: number; data: Signal }
  | ({ t: "pad"; pad: number } & PadLook)
  | { t: "haptic"; pad: number; ms: number | number[] }
  | { t: "kick"; pad: number };

/** Relay -> host. */
export type ToHostMessage =
  | { t: "welcome"; code: string; joinUrl: string; version: number; pads: PadInfo[] }
  | ({ t: "join" } & PadInfo)
  | { t: "leave"; pad: number }
  | { t: "rtt"; pad: number; ms: number; via?: "p2p" | "relay" }
  | { t: "signal"; pad: number; data: Signal }
  | ({ pad: number } & ScreenEvent)
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
  | ({ t: "setup"; pad: number; title: string; version: number; p2p: boolean } & PadLook)
  | { t: "signal"; data: Signal }
  | { t: "haptic"; ms: number | number[] }
  | { t: "host"; online: boolean }
  | { t: "kicked" }
  | { t: "full" }
  | { t: "pong" };

/** Phone -> relay. */
export type PadMessage = { t: "hello"; name?: string } | { t: "rtt"; ms: number; via?: "p2p" | "relay" } | { t: "signal"; data: Signal } | ScreenEvent;

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
