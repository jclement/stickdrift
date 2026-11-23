// The "screen" layout: a little scrolling page instead of a game pad, for
// word, card and voting games. The host describes it (see Screen in
// src/shared/protocol.ts, validated before it gets here); this renders it in
// the controller's style and turns taps into events.
//
// Two rules shape the code:
//   * Game and player text only ever goes through textContent (or an <img>
//     src that cleanAvatar has vetted), never innerHTML.
//   * Re-sending a screen with the same id must not lose anything: picks,
//     typed text and stepper values live here, keyed by element id, and an
//     element whose description hasn't changed keeps its DOM node, so a
//     focused text box keeps its keyboard while the status line updates.
import { inputLength, numberRange, pickCount, type Screen, type ScreenElement, type ScreenEvent } from "../../shared/protocol";

/** What an event carries besides the screen id and counter. */
export type EventValue = ScreenEvent["value"];

/** How long a live stepper waits for the taps to stop before sending. */
const STEPPER_SETTLE_MS = 250;

/** A rendered element, kept while its description is unchanged. */
interface Rendered {
  key: string; // type and id (or position)
  json: string; // its description plus local lock state, to spot changes
  node: HTMLElement;
}

/** ScreenView owns the screen page element. */
export class ScreenView {
  private screen: Screen | null = null;
  private picks = new Map<string, string[]>();
  private numbers = new Map<string, number>();
  private texts = new Map<string, string>();
  private sent = new Set<string>(); // elements that have answered (locked until a new screen)
  private rendered: Rendered[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private root: HTMLElement,
    private send: (element: string, value: EventValue) => void,
    private tap: () => void = () => {},
  ) {}

  /** show renders a screen. The same id as last time keeps the player's
   *  state; a new id starts afresh. */
  show(screen: Screen) {
    if (screen.id !== this.screen?.id) this.reset();
    this.screen = screen;
    this.render();
  }

  /** clear forgets the screen (the pad switched to another layout). */
  clear() {
    this.reset();
    this.screen = null;
    this.root.replaceChildren();
  }

  /** id is the screen on show, if any. */
  get id(): string | undefined {
    return this.screen?.id;
  }

  private reset() {
    this.picks.clear();
    this.numbers.clear();
    this.texts.clear();
    this.sent.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.rendered = [];
    this.root.replaceChildren();
  }

  // ---- Rendering ----

  /** render reconciles the page with the screen, rebuilding only elements
   *  whose description or lock state changed. */
  private render() {
    const s = this.screen;
    if (!s) return;
    this.root.classList.toggle("locked", !!s.locked);
    const old = new Map(this.rendered.map((r) => [r.key, r]));
    const next: Rendered[] = s.items.map((e, i) => {
      const key = `${e.type}:${e.id ?? i}`;
      const json = JSON.stringify([e, !!s.locked, this.sent.has(e.id ?? "")]);
      const prev = old.get(key);
      return prev && prev.json === json ? prev : { key, json, node: this.build(e) };
    });
    // Move nodes only where the order differs, so untouched ones (and a
    // focused text box) stay where they are.
    next.forEach((r, i) => {
      if (this.root.children[i] !== r.node) this.root.insertBefore(r.node, this.root.children[i] ?? null);
    });
    while (this.root.children.length > next.length) this.root.lastElementChild!.remove();
    this.rendered = next;
  }

  /** rerender rebuilds one element after its local state changed. */
  private rerender(id: string) {
    const i = this.rendered.findIndex((r) => r.key.endsWith(`:${id}`));
    if (i >= 0) this.rendered[i].json = ""; // force a rebuild
    this.render();
  }

  /** inactive reports whether an element can no longer be used. */
  private inactive(e: ScreenElement): boolean {
    return !!this.screen?.locked || !!e.disabled || this.sent.has(e.id ?? "");
  }

  private build(e: ScreenElement): HTMLElement {
    switch (e.type) {
      case "heading":
        return el("h2", "scr-heading", e.text);
      case "text":
        return el("p", "scr-text", e.text);
      case "status":
        return this.status(e);
      case "cards":
      case "choices":
        return this.picker(e);
      case "stepper":
        return this.stepper(e);
      case "slider":
        return this.slider(e);
      case "input":
        return this.input(e);
      case "button":
        return this.button(e);
    }
  }

  private status(e: ScreenElement): HTMLElement {
    const box = el("div", "scr-status");
    if (e.text) box.append(el("span", "scr-status-text", e.text));
    if (e.seconds !== undefined || e.progress !== undefined) {
      const bar = el("div", "scr-bar");
      const fill = el("i");
      if (e.seconds !== undefined) fill.style.animation = `scr-countdown ${e.seconds}s linear forwards`;
      else fill.style.transform = `scaleX(${e.progress})`;
      bar.append(fill);
      box.append(bar);
    }
    return box;
  }

  /** picker renders cards (a grid of text cards) and choices (a list). */
  private picker(e: ScreenElement): HTMLElement {
    const id = e.id!;
    const pick = pickCount(e);
    const off = this.inactive(e);
    const box = el("div", `scr-${e.type}${off ? " off" : ""}${this.sent.has(id) ? " sent" : ""}`);
    if (pick > 1 && !off) box.append(el("div", "scr-hint", `PICK ${pick}, IN ORDER`));
    const chosen = this.picks.get(id) ?? [];
    const list = el("div", e.type === "cards" ? "scr-card-grid" : "scr-choice-list");
    const items = e.type === "cards" ? (e.cards ?? []) : (e.options ?? []);
    for (const item of items) {
      const b = el("button", e.type === "cards" ? "scr-card" : "scr-choice") as HTMLButtonElement;
      b.type = "button";
      b.disabled = off;
      const order = chosen.indexOf(item.id);
      if (order >= 0) {
        b.classList.add("picked");
        if (pick > 1) b.append(el("span", "scr-order", String(order + 1)));
      }
      if ("pad" in item || "color" in item || "avatar" in item) {
        const o = item as { color?: string; avatar?: string };
        if (o.avatar) {
          const img = el("img", "scr-avatar") as HTMLImageElement;
          img.alt = "";
          img.src = o.avatar;
          b.append(img);
        } else if (o.color) {
          const dot = el("span", "scr-swatch");
          dot.style.background = o.color;
          b.append(dot);
        }
      }
      b.append(el("span", "scr-label", item.text));
      b.addEventListener("click", () => this.choose(e, item.id));
      list.append(b);
    }
    box.append(list);
    if (e.submit) box.append(this.submitButton(e, chosen.length === pick, () => this.answer(e, this.picks.get(id) ?? [])));
    if (this.sent.has(id)) box.append(el("div", "scr-sent", "LOCKED IN"));
    return box;
  }

  /** choose toggles one card or option, sending when the pick is complete
   *  and there is no confirm button. */
  private choose(e: ScreenElement, itemId: string) {
    if (this.inactive(e)) return;
    this.tap();
    const id = e.id!;
    const pick = pickCount(e);
    let chosen = [...(this.picks.get(id) ?? [])];
    if (chosen.includes(itemId)) chosen = chosen.filter((c) => c !== itemId);
    else if (pick === 1) chosen = [itemId];
    else if (chosen.length < pick) chosen.push(itemId);
    this.picks.set(id, chosen);
    if (!e.submit && chosen.length === pick) this.answer(e, chosen);
    else this.rerender(id);
  }

  private stepper(e: ScreenElement): HTMLElement {
    const id = e.id!;
    const r = numberRange(e);
    const off = this.inactive(e);
    const value = this.numbers.get(id) ?? r.value;
    const box = el("div", `scr-stepper${off ? " off" : ""}`);
    const shown = el("output", "scr-value", fmt(value));
    const step = (dir: number) => {
      if (this.inactive(e)) return;
      this.tap();
      const v = clamp(round((this.numbers.get(id) ?? r.value) + dir * r.step, r.step), r.min, r.max);
      this.numbers.set(id, v);
      shown.textContent = fmt(v);
      minus.disabled = v <= r.min;
      plus.disabled = v >= r.max;
      if (!e.submit) this.live(e, v);
    };
    const minus = el("button", "scr-step", "−") as HTMLButtonElement;
    const plus = el("button", "scr-step", "+") as HTMLButtonElement;
    minus.type = plus.type = "button";
    minus.setAttribute("aria-label", "less");
    plus.setAttribute("aria-label", "more");
    minus.disabled = off || value <= r.min;
    plus.disabled = off || value >= r.max;
    minus.addEventListener("click", () => step(-1));
    plus.addEventListener("click", () => step(1));
    const row = el("div", "scr-step-row");
    row.append(minus, shown, plus);
    box.append(row);
    if (e.submit) box.append(this.submitButton(e, true, () => this.answer(e, this.numbers.get(id) ?? r.value)));
    if (this.sent.has(id)) box.append(el("div", "scr-sent", "LOCKED IN"));
    return box;
  }

  private slider(e: ScreenElement): HTMLElement {
    const id = e.id!;
    const r = numberRange(e);
    const off = this.inactive(e);
    const value = this.numbers.get(id) ?? r.value;
    const box = el("div", `scr-slider${off ? " off" : ""}`);
    const shown = el("output", "scr-value", fmt(value));
    const range = el("input", "scr-range") as HTMLInputElement;
    range.type = "range";
    range.min = String(r.min);
    range.max = String(r.max);
    range.step = String(r.step);
    range.value = String(value);
    range.disabled = off;
    range.addEventListener("input", () => {
      const v = Number(range.value);
      this.numbers.set(id, v);
      shown.textContent = fmt(v);
    });
    // Live sliders send when the thumb is let go, not on every pixel.
    range.addEventListener("change", () => {
      if (!e.submit && !this.inactive(e)) this.send(id, Number(range.value));
    });
    box.append(shown, range);
    if (e.submit) box.append(this.submitButton(e, true, () => this.answer(e, this.numbers.get(id) ?? r.value)));
    if (this.sent.has(id)) box.append(el("div", "scr-sent", "LOCKED IN"));
    return box;
  }

  private input(e: ScreenElement): HTMLElement {
    const id = e.id!;
    const off = this.inactive(e);
    const box = el("form", `scr-input${off ? " off" : ""}`) as HTMLFormElement;
    const field = el("input", "scr-field") as HTMLInputElement;
    field.type = "text";
    field.maxLength = inputLength(e);
    field.placeholder = e.placeholder ?? "";
    field.autocomplete = "off";
    field.enterKeyHint = "send";
    field.value = this.texts.get(id) ?? "";
    field.disabled = off;
    const go = this.submitButton({ ...e, submit: e.submit ?? "SEND" }, field.value.trim() !== "", () => {
      const text = [...field.value.trim()].slice(0, inputLength(e)).join("");
      if (text) this.answer(e, text);
    });
    field.addEventListener("input", () => {
      this.texts.set(id, field.value);
      go.disabled = field.value.trim() === "" || this.inactive(e);
    });
    box.addEventListener("submit", (ev) => {
      ev.preventDefault();
      go.click();
    });
    box.append(field, go);
    if (this.sent.has(id)) box.append(el("div", "scr-sent", "SENT"));
    return box;
  }

  private button(e: ScreenElement): HTMLElement {
    const b = el("button", `scr-button${this.sent.has(e.id!) ? " sent" : ""}`, e.label) as HTMLButtonElement;
    b.type = "button";
    b.disabled = this.inactive(e);
    if (e.color) b.style.setProperty("--c", e.color);
    b.addEventListener("click", () => {
      if (this.inactive(e)) return;
      this.answer(e, undefined);
    });
    return b;
  }

  /** submitButton is the confirm button under an element. */
  private submitButton(e: ScreenElement, ready: boolean, onClick: () => void): HTMLButtonElement {
    const b = el("button", "scr-submit", e.submit) as HTMLButtonElement;
    b.type = "button";
    b.disabled = !ready || this.inactive(e);
    b.addEventListener("click", () => {
      if (!this.inactive(e)) onClick();
    });
    return b;
  }

  // ---- Answers ----

  /** answer sends an element's final value and locks it until a new screen. */
  private answer(e: ScreenElement, value: EventValue) {
    const id = e.id!;
    this.tap();
    this.sent.add(id);
    clearTimeout(this.timers.get(id));
    this.send(id, value);
    this.rerender(id);
  }

  /** live sends a live stepper's value once the taps settle. */
  private live(e: ScreenElement, v: number) {
    const id = e.id!;
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        if (!this.inactive(e)) this.send(id, v);
      }, STEPPER_SETTLE_MS),
    );
  }
}

/** el makes an element with a class and plain-text content. */
function el(tag: string, cls = "", text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** round snaps to the step's precision, so 0.1 steps don't drift. */
const round = (v: number, step: number) => {
  const places = (String(step).split(".")[1] ?? "").length;
  return Number(v.toFixed(places));
};
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, ""));
