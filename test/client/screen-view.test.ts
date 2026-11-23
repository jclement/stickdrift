// The screen renderer's state rules, without a DOM: what survives a re-sent
// screen with the same id, and when a confirm button may be pressed.
import { describe, expect, it } from "vitest";
import { newState, reconcileState, submitReady } from "../../src/client/pad/screen";
import type { Screen } from "../../src/shared/protocol";

const screen = (cards: string[], pick = 1): Screen => ({
  id: "r1",
  items: [
    { type: "cards", id: "hand", pick, submit: "PLAY", cards: cards.map((id) => ({ id, text: id })) },
    { type: "stepper", id: "bet", min: 0, max: 50, step: 5, value: 10 },
    { type: "input", id: "say", maxLength: 3 },
  ],
});

describe("same-id screen updates", () => {
  it("drops a picked card the host removed, so PLAY can't send a rejected answer", () => {
    const st = newState();
    const before = screen(["c1", "c2"]);
    st.picks.set("hand", ["c1"]);
    expect(submitReady(before.items[0], st)).toBe(true);
    const after = screen(["c2", "c3"]); // same screen id, c1 gone
    reconcileState(st, after);
    expect(st.picks.get("hand")).toEqual([]);
    expect(submitReady(after.items[0], st)).toBe(false);
  });

  it("trims picks to a smaller pick count and keeps the ones still there", () => {
    const st = newState();
    st.picks.set("hand", ["c1", "c2"]);
    reconcileState(st, screen(["c1", "c2"], 1));
    expect(st.picks.get("hand")).toEqual(["c1"]);
  });

  it("clamps numbers, cuts text and forgets elements that are gone", () => {
    const st = newState();
    st.numbers.set("bet", 45);
    st.texts.set("say", "hello");
    st.sent.add("gone");
    st.picks.set("gone", ["x"]);
    const s = screen(["c1"]);
    s.items[1] = { type: "stepper", id: "bet", min: 0, max: 20, step: 5, value: 10 };
    reconcileState(st, s);
    expect(st.numbers.get("bet")).toBe(20);
    expect(st.texts.get("say")).toBe("hel");
    expect(st.sent.has("gone")).toBe(false);
    expect(st.picks.has("gone")).toBe(false);
  });

  it("is never ready once sent", () => {
    const st = newState();
    st.picks.set("hand", ["c1"]);
    st.sent.add("hand");
    expect(submitReady(screen(["c1"]).items[0], st)).toBe(false);
  });
});
