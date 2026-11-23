// When the tilt controller pins, and which orientation lock the page holds.
// Phones report a rotation as several events in no fixed order (the
// viewport can resize before or after the orientation angle changes), and
// a layout change must take its lock from the incoming layout.
import { describe, expect, it } from "vitest";
import { PinKeeper, type ScreenState } from "../../src/client/pad/pin";

const portrait: ScreenState = { angle: 0, vw: 375, vh: 812, type: "portrait-primary", fullscreen: false };
const land90: ScreenState = { angle: 90, vw: 812, vh: 375, type: "landscape-primary", fullscreen: false };
const fs = (s: ScreenState): ScreenState => ({ ...s, fullscreen: true });

describe("pinning through out-of-order rotation events", () => {
  it("pins when the angle catches up after the viewport has already resized", () => {
    // Tilt controller shown in portrait: not pinned, rotate prompt up.
    const k = new PinKeeper();
    k.afterBuild(true, true, portrait);
    expect(k.pinned).toBe(false);
    // The viewport turns landscape first; the angle still says portrait.
    expect(k.sync({ ...portrait, vw: 812, vh: 375 })).toBe(false);
    expect(k.pinned).toBe(false);
    // Later the angle updates, with no further size change (only the
    // watchdog or an orientationchange event sees it). It must pin now.
    expect(k.sync(land90)).toBe(true);
    expect(k.pinned).toBe(true);
    expect([k.w, k.h]).toEqual([812, 375]);
    expect(k.session.pinned).toBe(90);
  });

  it("waits for the viewport when the angle changes first, so it never pins portrait dimensions", () => {
    const k = new PinKeeper();
    k.afterBuild(true, true, portrait);
    expect(k.sync({ ...land90, vw: 375, vh: 812 })).toBe(false);
    expect(k.pinned).toBe(false);
    expect(k.sync(land90)).toBe(true);
    expect([k.w, k.h]).toEqual([812, 375]);
  });

  it("keeps steering once the angle catches up", () => {
    const k = new PinKeeper();
    k.afterBuild(true, true, portrait);
    k.sync({ ...portrait, vw: 812, vh: 375 });
    k.sync(land90);
    // Calibrate, then tip the right edge down: steering is live.
    k.session.read([0.6, 0, 0.8]);
    expect(k.session.read([0.6, 0.3, 0.74]).steer).toBeGreaterThan(0.3);
  });

  it("only pins while a tilt layout is up", () => {
    const k = new PinKeeper();
    k.afterBuild(false, true, land90);
    expect(k.sync(land90)).toBe(false);
    expect(k.pinned).toBe(false);
  });

  it("keeps the first pin and counter-rotates through later rotations", () => {
    const k = new PinKeeper();
    k.afterBuild(true, true, land90);
    expect(k.pinned).toBe(true);
    expect(k.sync({ ...land90, angle: 270, type: "landscape-secondary" })).toBe(false);
    expect(k.pin?.deg).toBe(180);
    k.sync(portrait);
    expect(k.pin?.deg).toBe(90);
    expect(k.session.pinned).toBe(90);
  });
});

describe("orientation lock follows the incoming layout", () => {
  it("releases the tilt lock when the next layout doesn't need landscape", () => {
    const k = new PinKeeper();
    expect(k.afterBuild(true, true, fs(land90))).toEqual({ lock: "landscape-primary" });
    // Back to a portrait layout: unpin before building, then the policy
    // comes from the portrait layout, so the exact landscape lock goes.
    expect(k.beforeBuild(false)).toBe(true);
    expect(k.afterBuild(false, false, fs(land90))).toEqual({ unlock: true });
  });

  it("relaxes the tilt lock to either landscape for a landscape layout", () => {
    const k = new PinKeeper();
    k.afterBuild(true, true, fs(land90));
    k.beforeBuild(false);
    expect(k.afterBuild(false, true, fs(land90))).toEqual({ lock: "landscape" });
    // And after that, other layouts are left alone, as they always were.
    expect(k.afterBuild(false, false, fs(land90))).toBe(null);
  });

  it("locks to the exact way round when a pin happens in full screen", () => {
    const k = new PinKeeper();
    expect(k.afterBuild(true, true, fs(portrait))).toBe(null);
    k.sync(fs({ ...portrait, vw: 812, vh: 375 }));
    expect(k.sync(fs(land90))).toBe(true);
    expect(k.lockAfterChange(fs(land90))).toEqual({ lock: "landscape-primary" });
  });

  it("relaxes the exact lock when a re-centre turns the pin round", () => {
    const k = new PinKeeper();
    k.afterBuild(true, true, fs(land90));
    k.session.recentre([-0.6, 0, 0.8]); // held the other way up: pin flips to 270
    expect(k.session.pinned).toBe(270);
    expect(k.lockAfterChange(fs(land90))).toEqual({ lock: "landscape" });
  });

  it("leaves other games' locks exactly as before", () => {
    const k = new PinKeeper();
    // Entering full screen on a landscape layout locks landscape; on a
    // portrait one, nothing. Layout changes never touch the lock.
    expect(k.afterBuild(false, true, fs(land90))).toBe(null);
    expect(k.lockOnFullscreen(fs(land90))).toEqual({ lock: "landscape" });
    expect(k.afterBuild(false, false, fs(portrait))).toBe(null);
    expect(k.lockOnFullscreen(fs(portrait))).toBe(null);
  });

  it("does nothing outside full screen (the OS ignores locks there)", () => {
    const k = new PinKeeper();
    expect(k.afterBuild(true, true, land90)).toBe(null);
    k.beforeBuild(false);
    expect(k.afterBuild(false, false, land90)).toBe(null);
  });
});
