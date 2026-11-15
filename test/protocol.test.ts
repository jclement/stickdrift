import { describe, expect, it } from "vitest";
import { Button, FRAME_SIZE, seqNewer, cleanCustom, cleanTheme, decodeFrame, encodeFrame, isCode, randomCode } from "../src/shared/protocol";

describe("frames", () => {
  it("round-trips a full snapshot", () => {
    const s = { seq: 513, buttons: (1 << Button.A) | (1 << Button.Left), lx: -1, ly: 0.5, rx: 0, ry: 1, px: -300, py: 40000 };
    const buf = encodeFrame(s, 7);
    expect(buf.byteLength).toBe(FRAME_SIZE);
    const out = decodeFrame(buf)!;
    expect(out.pad).toBe(7);
    expect(out.state.seq).toBe(513);
    expect(out.state.buttons).toBe(s.buttons);
    expect(out.state.lx).toBeCloseTo(-1, 2);
    expect(out.state.ly).toBeCloseTo(0.5, 1);
    expect(out.state.ry).toBeCloseTo(1, 2);
    expect(out.state.px).toBe(-300);
    expect(out.state.py).toBe(40000 - 65536); // pointer wraps at 16 bits
  });
  it("rejects junk", () => {
    expect(decodeFrame(new ArrayBuffer(3))).toBeNull();
    expect(decodeFrame(new ArrayBuffer(FRAME_SIZE))).toBeNull(); // kind 0
  });
});

describe("codes", () => {
  it("makes valid codes", () => {
    for (let i = 0; i < 50; i++) expect(isCode(randomCode())).toBe(true);
  });
  it("rejects ambiguous letters and wrong lengths", () => {
    expect(isCode("ABCDO")).toBe(false);
    expect(isCode("ABCD")).toBe(false);
    expect(isCode("abcde")).toBe(false);
  });
});

describe("custom layouts", () => {
  it("keeps valid controls and clamps positions", () => {
    const out = cleanCustom({ controls: [{ type: "button", x: 2, y: 0.5, button: "A", label: "FIRE", color: "#ff0000" }, { type: "laser", x: 0.1, y: 0.1 }] })!;
    expect(out.controls).toHaveLength(1);
    expect(out.controls[0].x).toBe(1);
    expect(out.controls[0].label).toBe("FIRE");
  });
  it("drops script-ish values", () => {
    const out = cleanCustom({ controls: [{ type: "button", x: 0.5, y: 0.5, color: "red;}</style><script>", button: "constructor" }] })!;
    expect(out.controls[0].color).toBeUndefined();
    expect(out.controls[0].button).toBeUndefined();
  });
  it("rejects non-layouts", () => {
    expect(cleanCustom(null)).toBeNull();
    expect(cleanCustom({ controls: "nope" })).toBeNull();
  });
});

describe("themes", () => {
  it("accepts presets and hex colours only", () => {
    expect(cleanTheme({ style: "retro", font: "pixel", background: "#112233", text: "url(evil)" })).toEqual({ style: "retro", font: "pixel", background: "#112233" });
    expect(cleanTheme({ style: "vaporwave" })).toBeNull();
  });
});

describe("sequence numbers", () => {
  it("compares across the 16-bit wrap", () => {
    expect(seqNewer(2, 1)).toBe(true);
    expect(seqNewer(1, 2)).toBe(false);
    expect(seqNewer(1, 1)).toBe(false);
    expect(seqNewer(3, 65530)).toBe(true);
    expect(seqNewer(65530, 3)).toBe(false);
  });
});

describe("avatars", () => {
  it("accepts small PNG data URLs only", async () => {
    const { cleanAvatar } = await import("../src/shared/protocol");
    expect(cleanAvatar("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(cleanAvatar("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(cleanAvatar("javascript:alert(1)")).toBeNull();
    expect(cleanAvatar("data:image/png;base64," + "A".repeat(30000))).toBeNull();
  });
});
