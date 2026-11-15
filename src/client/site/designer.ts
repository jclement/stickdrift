// The layout designer (/designer): drag controls onto a phone-shaped
// canvas, edit them, theme the phone, and copy the resulting look. The
// canvas is a fast schematic drawn with the same geometry the phone uses
// (designer-model.ts); the real phone page runs beside it in an iframe as
// the live preview. The design lives in the URL (#d=…), so a link to the
// designer reopens exactly what you made.
import "./site.css";
import "./designer.css";
import qrcode from "qrcode-generator";
import type { ButtonName, ControlType, CustomControl } from "../../shared/protocol";
import { CONTROL_TYPES } from "../../shared/protocol";
import {
  BUTTON_NAMES,
  FIELDS,
  PHONE_DEFAULTS,
  STARTERS,
  THEME_FONTS,
  THEME_SHAPES,
  THEME_STYLES,
  TYPE_NAMES,
  boxOf,
  clamp01,
  decodeDesign,
  encodeDesign,
  newControl,
  previewPath,
  round2,
  toLook,
  unit,
  type Design,
  type Field,
} from "./designer-model";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $("canvas");
const props = $("props");

/** Grid step when snapping, as a fraction of the screen. */
const SNAP = 0.02;
/** Pointer travel (px) before a palette press counts as a drag. */
const DRAG_SLOP = 6;

const fromHash = location.hash.match(/d=([A-Za-z0-9_-]+)/);
let design: Design = (fromHash && decodeDesign(fromHash[1])) || structuredClone(STARTERS.shooter);
let selected = -1;

// ---- Rendering the canvas ----

/** draw renders every control on the canvas from the design. */
function draw() {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.replaceChildren();
  const hud = document.createElement("div");
  hud.className = "d-hud";
  canvas.appendChild(hud);
  design.controls.forEach((c, i) => canvas.appendChild(controlEl(c, i, W, H)));
  $("count").textContent = `${design.controls.length}/32 controls`;
}

/** controlEl draws one control as the phone would place it. */
function controlEl(c: CustomControl, i: number, W: number, H: number): HTMLElement {
  const b = boxOf(c, W, H);
  const el = document.createElement("div");
  el.className = `d-ctl t-${c.type}${b.round ? " round" : ""}${i === selected ? " selected" : ""}${c.solid ? " solid" : ""}`;
  el.dataset.i = String(i);
  Object.assign(el.style, { left: `${b.cx - b.w / 2}px`, top: `${b.cy - b.h / 2}px`, width: `${b.w}px`, height: `${b.h}px` });
  el.style.setProperty("--c", c.color ?? design.color);
  const inner = document.createElement("span");
  inner.className = "d-label";
  inner.textContent = labelOf(c);
  el.appendChild(inner);
  if (b.knob) {
    const k = document.createElement("i");
    k.className = "d-knob";
    Object.assign(k.style, { width: `${b.knob}px`, height: `${b.knob}px` });
    el.appendChild(k);
  }
  if (i === selected && hasHandle(c.type)) {
    const h = document.createElement("i");
    h.className = "d-handle";
    h.dataset.handle = "1";
    el.appendChild(h);
  }
  return el;
}

/** labelOf is the text the schematic shows on a control. */
function labelOf(c: CustomControl): string {
  if (c.type === "dpad") return c.diagonals === false ? "✚ 4-WAY" : "✚";
  if (c.type === "stick") return c.side === "right" ? "RIGHT STICK" : "STICK";
  if (c.type === "slider") return "◀ SLIDER ▶";
  if (c.type === "touchpad") return "TOUCHPAD";
  return c.label ?? c.button ?? PHONE_DEFAULTS.button;
}

/** Pills and shoulders have a fixed size on the phone. */
const hasHandle = (t: ControlType) => t !== "pill" && t !== "shoulder";

// ---- Changes ----

let outputTimer: ReturnType<typeof setTimeout> | undefined;

/** changed redraws and, after a pause, refreshes the preview and JSON. */
function changed(immediate = false) {
  draw();
  if (selected >= 0) syncPropValues();
  clearTimeout(outputTimer);
  outputTimer = setTimeout(output, immediate ? 0 : 350);
}

/** snap rounds a fraction to the grid when snapping is on. */
function snap(v: number): number {
  return $<HTMLInputElement>("snap").checked ? Math.round(v / SNAP) * SNAP : v;
}

function select(i: number) {
  selected = i;
  draw();
  renderProps();
}

function addControl(type: ControlType, x: number, y: number) {
  if (design.controls.length >= 32) return;
  const taken = design.controls.map((c) => c.button).filter((b): b is ButtonName => !!b);
  design.controls.push(newControl(type, round2(snap(x)), round2(snap(y)), taken));
  selected = design.controls.length - 1;
  changed();
  renderProps();
}

function removeSelected() {
  if (selected < 0) return;
  design.controls.splice(selected, 1);
  selected = -1;
  changed();
  renderProps();
}

function duplicateSelected() {
  if (selected < 0 || design.controls.length >= 32) return;
  const copy = structuredClone(design.controls[selected]);
  copy.x = clamp01(copy.x + 0.06);
  copy.y = clamp01(copy.y + 0.06);
  design.controls.push(copy);
  selected = design.controls.length - 1;
  changed();
  renderProps();
}

// ---- Dragging and resizing on the canvas ----

/** capture keeps pointer events coming to el while dragging. It throws for
 *  pointers that are no longer active; dragging still works without it. */
function capture(el: HTMLElement, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Not capturable (already released, or synthetic): carry on uncaptured.
  }
}

type Drag = { kind: "move"; i: number; dx: number; dy: number } | { kind: "resize"; i: number };
let drag: Drag | null = null;

/** pointFrac converts a pointer position to fractions of the canvas. */
function pointFrac(e: PointerEvent): { x: number; y: number; px: number; py: number } {
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  return { x: px / r.width, y: py / r.height, px, py };
}

canvas.addEventListener("pointerdown", (e) => {
  const target = e.target as HTMLElement;
  const ctl = target.closest<HTMLElement>(".d-ctl");
  if (!ctl) {
    select(-1);
    return;
  }
  e.preventDefault();
  canvas.focus();
  const i = Number(ctl.dataset.i);
  if (i !== selected) select(i);
  const p = pointFrac(e);
  const c = design.controls[i];
  drag = target.dataset.handle ? { kind: "resize", i } : { kind: "move", i, dx: p.x - c.x, dy: p.y - c.y };
  capture(canvas, e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const p = pointFrac(e);
  const c = design.controls[drag.i];
  if (drag.kind === "move") {
    c.x = round2(clamp01(snap(p.x - drag.dx)));
    c.y = round2(clamp01(snap(p.y - drag.dy)));
  } else {
    resize(c, p.px, p.py);
  }
  changed();
});

const endDrag = () => {
  if (!drag) return;
  drag = null;
  changed(true);
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

/** resize sets a control's size from the handle's distance to its centre. */
function resize(c: CustomControl, px: number, py: number) {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  const dx = Math.abs(px - c.x * W) * 2;
  const dy = Math.abs(py - c.y * H) * 2;
  const roundish = c.type === "button" || c.type === "buzzer" || c.type === "dpad";
  if (roundish) {
    c.size = round2(Math.max(0.05, Math.min(1, snap(Math.max(dx, dy) / unit(W, H)))));
    return;
  }
  c.w = round2(Math.max(0.02, Math.min(1, snap(dx / W))));
  if (c.type !== "slider") c.h = round2(Math.max(0.02, Math.min(1, snap(dy / H))));
}

canvas.addEventListener("keydown", (e) => {
  if (selected < 0) return;
  const c = design.controls[selected];
  const step = e.shiftKey ? 0.05 : 0.01;
  const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) {
    e.preventDefault();
    c.x = round2(clamp01(c.x + moves[e.key][0]));
    c.y = round2(clamp01(c.y + moves[e.key][1]));
    changed();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    removeSelected();
  } else if (e.key === "Escape") {
    select(-1);
  }
});

new ResizeObserver(() => draw()).observe(canvas);

// ---- Palette: tap to add, or drag onto the phone ----

/** paletteIcon is a tiny schematic of each control type. */
const PALETTE_ICON: Record<ControlType, string> = {
  button: "●",
  buzzer: "◉",
  tile: "▬",
  pill: "⬭",
  shoulder: "⌒",
  dpad: "✚",
  stick: "◎",
  slider: "⟷",
  touchpad: "▢",
};

function buildPalette() {
  const pal = $("palette");
  for (const type of CONTROL_TYPES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pal-item";
    b.innerHTML = `<span class="pal-icon">${PALETTE_ICON[type]}</span>${TYPE_NAMES[type]}`;
    b.addEventListener("pointerdown", (e) => paletteDrag(e, type, b));
    pal.appendChild(b);
  }
}

/** paletteDrag follows the pointer with a ghost and drops the control
 *  where it is released over the phone; a plain tap adds it in the middle. */
function paletteDrag(e: PointerEvent, type: ControlType, from: HTMLElement) {
  e.preventDefault();
  capture(from, e.pointerId);
  const start = { x: e.clientX, y: e.clientY };
  let ghost: HTMLElement | null = null;
  const move = (m: PointerEvent) => {
    if (!ghost && Math.hypot(m.clientX - start.x, m.clientY - start.y) > DRAG_SLOP) {
      ghost = document.createElement("div");
      ghost.className = "pal-ghost";
      ghost.textContent = `${PALETTE_ICON[type]} ${TYPE_NAMES[type]}`;
      document.body.appendChild(ghost);
    }
    if (ghost) Object.assign(ghost.style, { left: `${m.clientX}px`, top: `${m.clientY}px` });
  };
  const up = (u: PointerEvent) => {
    from.removeEventListener("pointermove", move);
    from.removeEventListener("pointerup", up);
    from.removeEventListener("pointercancel", up);
    if (!ghost) {
      addControl(type, 0.5, 0.5);
      return;
    }
    ghost.remove();
    const r = canvas.getBoundingClientRect();
    const inside = u.clientX >= r.left && u.clientX <= r.right && u.clientY >= r.top && u.clientY <= r.bottom;
    if (inside && u.type === "pointerup") addControl(type, (u.clientX - r.left) / r.width, (u.clientY - r.top) / r.height);
  };
  from.addEventListener("pointermove", move);
  from.addEventListener("pointerup", up);
  from.addEventListener("pointercancel", up);
}

function buildStarters() {
  const names: Record<string, string> = { shooter: "Shooter", racer: "Racer", quiz: "Quiz", blank: "Blank" };
  for (const [key, label] of Object.entries(names)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = label;
    b.onclick = () => load(structuredClone(STARTERS[key]));
    $("starters").appendChild(b);
  }
}

// ---- Properties panel ----

/** FIELD_UI describes how each field is edited. */
const FIELD_UI: Record<Field, { label: string; kind: "button" | "text" | "color" | "check" | "range" | "side"; min?: number }> = {
  button: { label: "Sets button", kind: "button" },
  label: { label: "Label", kind: "text" },
  color: { label: "Colour", kind: "color" },
  solid: { label: "Filled", kind: "check" },
  size: { label: "Size", kind: "range", min: 0.05 },
  w: { label: "Width", kind: "range", min: 0.02 },
  h: { label: "Height", kind: "range", min: 0.02 },
  side: { label: "Drives", kind: "side" },
  floating: { label: "Floats under thumb", kind: "check" },
  dpad: { label: "Also sets d-pad bits", kind: "check" },
  diagonals: { label: "Diagonals (8-way)", kind: "check" },
};

/** effective is a field's value with the phone's defaults filled in, so
 *  checkboxes and sliders show what the phone will actually do. */
function effective(c: CustomControl, f: Field): unknown {
  const v = c[f];
  if (v !== undefined) return v;
  if (f === "size") return PHONE_DEFAULTS.size;
  if (f === "w") return PHONE_DEFAULTS.w;
  if (f === "h") return PHONE_DEFAULTS.h;
  if (f === "button") return PHONE_DEFAULTS.button;
  if (f === "floating" || f === "diagonals") return true;
  if (f === "dpad") return (c.side ?? "left") === "left";
  if (f === "side") return "left";
  return undefined;
}

/** renderProps builds the form for the selected control. */
function renderProps() {
  if (selected < 0) {
    props.innerHTML = `<p class="panel-hint">Select a control to edit it, or add one from the palette.</p>`;
    return;
  }
  const c = design.controls[selected];
  const rows: string[] = [
    `<label class="field"><span>Type</span><select data-f="type">${CONTROL_TYPES.map((t) => `<option value="${t}"${t === c.type ? " selected" : ""}>${TYPE_NAMES[t]}</option>`).join("")}</select></label>`,
  ];
  for (const f of FIELDS[c.type]) rows.push(fieldRow(c, f));
  rows.push(
    `<div class="field-pair"><label class="field"><span>X</span><input data-f="x" type="number" min="0" max="1" step="0.01" /></label><label class="field"><span>Y</span><input data-f="y" type="number" min="0" max="1" step="0.01" /></label></div>`,
    `<div class="flex gap-2 mt-3"><button class="btn-ghost btn-sm" type="button" data-act="dup">DUPLICATE</button><button class="btn-ghost btn-sm danger" type="button" data-act="del">DELETE</button></div>`,
  );
  props.innerHTML = `<div class="fields">${rows.join("")}</div>`;
  syncPropValues();
}

function fieldRow(c: CustomControl, f: Field): string {
  const ui = FIELD_UI[f];
  switch (ui.kind) {
    case "button":
      return `<label class="field"><span>${ui.label}</span><select data-f="${f}">${BUTTON_NAMES.map((b) => `<option>${b}</option>`).join("")}</select></label>`;
    case "side":
      return `<label class="field"><span>${ui.label}</span><select data-f="${f}"><option value="left">Left stick (lx ly)</option><option value="right">Right stick (rx ry)</option></select></label>`;
    case "text":
      return `<label class="field"><span>${ui.label}</span><input data-f="${f}" type="text" maxlength="12" placeholder="${c.button ?? ""}" /></label>`;
    case "color":
      return `<label class="field"><span>${ui.label}</span><span class="pair"><input data-f="color" type="color" /><label class="check"><input data-f="color-default" type="checkbox" /> player</label></span></label>`;
    case "check":
      return `<label class="check field-check"><input data-f="${f}" type="checkbox" /> ${ui.label}</label>`;
    case "range":
      return `<label class="field"><span>${ui.label} <output data-o="${f}"></output></span><input data-f="${f}" type="range" min="${ui.min}" max="1" step="0.01" /></label>`;
  }
}

/** syncPropValues pushes the control's values into the form (after drags). */
function syncPropValues() {
  const c = design.controls[selected];
  if (!c) return;
  for (const input of props.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-f]")) {
    if (input === document.activeElement && input.type !== "range") continue;
    const f = input.dataset.f!;
    if (f === "type") input.value = c.type;
    else if (f === "x" || f === "y") input.value = String(c[f]);
    else if (f === "color-default") (input as HTMLInputElement).checked = c.color === undefined;
    else if (f === "color") input.value = normaliseHex(c.color ?? design.color);
    else if (input.type === "checkbox") (input as HTMLInputElement).checked = !!effective(c, f as Field);
    else input.value = String(effective(c, f as Field) ?? "");
  }
  for (const o of props.querySelectorAll<HTMLOutputElement>("output[data-o]")) o.value = String(effective(c, o.dataset.o as Field));
}

/** normaliseHex widens #rgb to #rrggbb for <input type=color>. */
function normaliseHex(v: string): string {
  const m = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : v.slice(0, 7);
}

props.addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.dataset.f;
  const c = design.controls[selected];
  if (!f || !c) return;
  const rec = c as unknown as Record<string, unknown>;
  if (f === "type") {
    const fresh = newControl(input.value as ControlType, c.x, c.y);
    if (c.button && FIELDS[fresh.type].includes("button")) fresh.button = c.button;
    if (c.label && FIELDS[fresh.type].includes("label")) fresh.label = c.label;
    design.controls[selected] = fresh;
    changed();
    renderProps();
    return;
  }
  if (f === "x" || f === "y") rec[f] = clamp01(Number(input.value) || 0);
  else if (f === "color-default") {
    if (input.checked) delete c.color;
    else c.color = design.color;
  } else if (f === "color") c.color = input.value;
  else if (f === "label") input.value ? (c.label = input.value.slice(0, 12)) : delete c.label;
  else if (input.type === "checkbox") rec[f] = input.checked;
  else if (input.type === "range") rec[f] = Number(input.value);
  else rec[f] = input.value;
  changed();
});

props.addEventListener("click", (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  if (act === "del") removeSelected();
  if (act === "dup") duplicateSelected();
});

// ---- Phone settings ----

function fillSelect(id: string, values: readonly string[], defaultValue: string) {
  $(id).innerHTML = values.map((v) => `<option value="${v}">${v}${v === defaultValue ? " (default)" : ""}</option>`).join("");
}

function syncPhoneForm() {
  $<HTMLSelectElement>("orientation").value = design.orientation;
  $<HTMLInputElement>("color").value = normaliseHex(design.color);
  $<HTMLSelectElement>("style").value = design.theme.style ?? "glass";
  $<HTMLSelectElement>("font").value = design.theme.font ?? "display";
  $<HTMLSelectElement>("shape").value = design.theme.shape ?? "round";
  $<HTMLInputElement>("bg-default").checked = !design.theme.background;
  if (design.theme.background) $<HTMLInputElement>("bg").value = normaliseHex(design.theme.background);
  $<HTMLInputElement>("text-default").checked = !design.theme.text;
  if (design.theme.text) $<HTMLInputElement>("text").value = normaliseHex(design.theme.text);
  $("stage-wrap").classList.toggle("portrait", design.orientation === "portrait");
  $("preview-wrap").classList.toggle("portrait", design.orientation === "portrait");
}

/** readPhoneForm takes the phone settings back into the design. Defaults
 *  are left out of the theme so the JSON only says what differs. */
function readPhoneForm() {
  design.orientation = $<HTMLSelectElement>("orientation").value as Design["orientation"];
  design.color = $<HTMLInputElement>("color").value;
  const style = $<HTMLSelectElement>("style").value;
  const font = $<HTMLSelectElement>("font").value;
  const shape = $<HTMLSelectElement>("shape").value;
  design.theme = {
    style: style === "glass" ? undefined : (style as Design["theme"]["style"]),
    font: font === "display" ? undefined : (font as Design["theme"]["font"]),
    shape: shape === "round" ? undefined : (shape as Design["theme"]["shape"]),
    background: $<HTMLInputElement>("bg-default").checked ? undefined : $<HTMLInputElement>("bg").value,
    text: $<HTMLInputElement>("text-default").checked ? undefined : $<HTMLInputElement>("text").value,
  };
  syncPhoneForm();
  changed();
}

for (const id of ["orientation", "color", "style", "font", "shape", "bg", "bg-default", "text", "text-default"]) {
  $(id).addEventListener("input", () => {
    // Picking a colour implies you want it, not the default.
    if (id === "bg") $<HTMLInputElement>("bg-default").checked = false;
    if (id === "text") $<HTMLInputElement>("text-default").checked = false;
    readPhoneForm();
  });
}

// ---- Output: preview, JSON, links ----

let lastPreview = "";

/** output refreshes the live preview, the JSON, the QR code and the URL. */
function output() {
  const look = toLook(design);
  $("json").textContent = JSON.stringify(look, null, 2);
  history.replaceState(null, "", `#d=${encodeDesign(design)}`);
  const path = previewPath(design);
  if (path !== lastPreview && design.controls.length) {
    lastPreview = path;
    // A changed query string forces a reload; the hash alone would not.
    const [base, hash] = path.split("#");
    $<HTMLIFrameElement>("preview").src = `${base}&r=${Date.now()}#${hash}`;
  }
  if (!$("qr-box").hidden) drawQr();
}

function drawQr() {
  const qr = qrcode(0, "L");
  qr.addData(location.origin + previewPath(design));
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

$("qr-toggle").addEventListener("click", () => {
  const box = $("qr-box");
  box.hidden = !box.hidden;
  $("qr-toggle").setAttribute("aria-pressed", String(!box.hidden));
  if (!box.hidden) drawQr();
});

/** copyText returns what each copy button copies. */
function copyText(kind: string): string {
  const look = toLook(design);
  if (kind === "json") return JSON.stringify(look, null, 2);
  if (kind === "code") return `host.setLook(${JSON.stringify(look, null, 2)});`;
  if (kind === "preview") return location.origin + previewPath(design);
  return `${location.origin}/designer#d=${encodeDesign(design)}`;
}

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
  if (!b) return;
  const was = b.textContent;
  navigator.clipboard.writeText(copyText(b.dataset.copy!)).then(
    () => (b.textContent = "COPIED"),
    () => (b.textContent = "COPY FAILED"),
  );
  setTimeout(() => (b.textContent = was), 1200);
});

$("import-go").addEventListener("click", () => {
  const d = decodeDesign($<HTMLTextAreaElement>("import").value);
  $("import-msg").textContent = d ? `Loaded ${d.controls.length} controls.` : "That isn't a look or custom layout with any usable controls.";
  if (d) load(d);
});

/** load replaces the whole design (starters, imports). */
function load(d: Design) {
  design = d;
  selected = -1;
  lastPreview = "";
  syncPhoneForm();
  renderProps();
  changed(true);
}

// ---- Start ----

fillSelect("style", THEME_STYLES, "glass");
fillSelect("font", THEME_FONTS, "display");
fillSelect("shape", THEME_SHAPES, "round");
buildPalette();
buildStarters();
load(design);
