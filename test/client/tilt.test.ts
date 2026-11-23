// Tilt steering measured in the phone's own axes. Ground truth comes from
// deviceorientation Euler angles for physical poses (which edge of the phone
// is lowered), so the tests don't just restate the implementation's vectors.
//
// Poses: at screen angle 90 the phone's top is on the player's left, so the
// picture's right edge is the phone's bottom (device -y) and its top edge is
// the phone's right side (device +x). At 270 it is the other way round.
import { describe, expect, it } from "vitest";
import { calibrate, FULL_TILT_DEG, isUpsideDown, pinRotation, readTilt, TiltSession, unpinPoint, upFromEuler, type Pin, type Vec3 } from "../../src/client/pad/tilt";

const deg = (d: number) => d / FULL_TILT_DEG;
const close = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe("upFromEuler", () => {
  it("points out of the screen when flat and out of the top when upright", () => {
    close(upFromEuler(0, 0), [0, 0, 1]);
    close(upFromEuler(90, 0), [0, 1, 0]);
  });
  it("lowers the right side for positive gamma", () => {
    expect(upFromEuler(0, 30)[0]).toBeLessThan(0);
  });
  it("gives one vector for both Euler spellings of a pose (the gimbal flip near upright)", () => {
    // Browsers switch between (beta, gamma) and (180 - beta, gamma - 180)
    // as the phone passes upright; the raw angles jump, the vector doesn't.
    close(upFromEuler(80, 30), upFromEuler(100, -150));
    close(upFromEuler(179.9, 10), upFromEuler(-180.1, 10));
  });
});

/** Holds in landscape, as deviceorientation reports them, for each pinned angle. */
const holds: { name: string; angle: number; beta: number; gamma: number }[] = [
  { name: "flat on the hands, top left", angle: 90, beta: 0, gamma: 0 },
  { name: "tipped 40° toward the player, top left", angle: 90, beta: 0, gamma: -40 },
  { name: "upright like a wheel, top left", angle: 90, beta: 0, gamma: -89 },
  { name: "flat on the hands, top right", angle: 270, beta: 0, gamma: 0 },
  { name: "tipped 40° toward the player, top right", angle: 270, beta: 0, gamma: 40 },
  { name: "upright like a wheel, top right", angle: 270, beta: 0, gamma: 89 },
];

describe("calibrated steering", () => {
  for (const h of holds) {
    describe(h.name, () => {
      const frame = calibrate(upFromEuler(h.beta, h.gamma), h.angle);
      // Lowering the picture's right edge: at 90 that is the phone's bottom
      // going down (top up: beta rises); at 270 the phone's top going down.
      const dip = h.angle === 90 ? 1 : -1;

      it("reads zero at the neutral pose", () => {
        const t = readTilt(frame, upFromEuler(h.beta, h.gamma));
        expect(t.steer).toBeCloseTo(0, 6);
        expect(t.pitch).toBeCloseTo(0, 6);
      });
      it("steers right when the right edge dips, left when it rises", () => {
        // Rotate about the axis toward the player: the right edge drops by
        // 20° whatever the hold. Built as a rotation of the neutral up vector
        // about the picture's own axis, from the Euler pose.
        const right = readTilt(frame, rotateAboutForward(h, 20 * dip));
        const left = readTilt(frame, rotateAboutForward(h, -20 * dip));
        expect(right.steer).toBeCloseTo(deg(20), 2);
        expect(left.steer).toBeCloseTo(deg(-20), 2);
        expect(Math.abs(right.pitch)).toBeLessThan(0.05);
      });
      it("clamps past full lock", () => {
        expect(readTilt(frame, rotateAboutForward(h, 70 * dip)).steer).toBe(1);
        expect(readTilt(frame, rotateAboutForward(h, -70 * dip)).steer).toBe(-1);
      });
    });
  }

  it("pulls back when the top edge rises and pushes forward when it dips", () => {
    // Tipped 40° toward the player, top left: the top edge is device +x.
    // Raising it 15° more is gamma -55; lowering it is gamma -25.
    const frame = calibrate(upFromEuler(0, -40), 90);
    expect(readTilt(frame, upFromEuler(0, -55)).pitch).toBeCloseTo(deg(15), 6);
    expect(readTilt(frame, upFromEuler(0, -25)).pitch).toBeCloseTo(deg(-15), 6);
    expect(Math.abs(readTilt(frame, upFromEuler(0, -55)).steer)).toBeLessThan(1e-9);
  });

  it("is smooth through flat: no jump as the phone passes level", () => {
    const frame = calibrate(upFromEuler(0, -10), 90);
    let last = readTilt(frame, upFromEuler(0, -10));
    for (let g = -10; g <= 10; g += 0.5) {
      for (const b of [-5, 0, 5]) {
        const t = readTilt(frame, upFromEuler(b, g));
        expect(Number.isFinite(t.steer) && Number.isFinite(t.pitch)).toBe(true);
      }
      const t = readTilt(frame, upFromEuler(0, g));
      expect(Math.abs(t.pitch - last.pitch)).toBeLessThan(0.02);
      last = t;
    }
  });

  it("still steers when calibrated with the phone stood on its end", () => {
    // Picture right pointing straight down (top-left hold turned onto its
    // bottom edge): level the picture's up instead.
    const frame = calibrate([0, 1, 0], 90);
    const t = readTilt(frame, [0.17, 0.98, 0.1]);
    expect(Number.isFinite(t.steer) && Number.isFinite(t.pitch)).toBe(true);
  });
});

describe("TiltSession", () => {
  it("calibrates on the first reading after pinning", () => {
    const s = new TiltSession();
    expect(s.pin(90)).toBe(true);
    expect(s.read(upFromEuler(0, -35)).steer).toBeCloseTo(0, 6);
    expect(s.read(upFromEuler(20, -35)).steer).toBeGreaterThan(0.3);
  });

  it("waits for landscape before pinning", () => {
    const s = new TiltSession();
    expect(s.pin(0)).toBe(false);
    expect(s.read(upFromEuler(20, 0))).toEqual({ steer: 0, pitch: 0 });
    expect(s.pin(270)).toBe(true);
    expect(s.pinned).toBe(270);
  });

  it("keeps the first pin when the OS rotates mid-turn (no sign inversion)", () => {
    // Held nearly flat, steering right; the OS flips to the other landscape
    // and then to portrait halfway through the turn. Steering keeps rising.
    const s = new TiltSession();
    s.pin(90);
    s.read(upFromEuler(0, -5));
    let last = -Infinity;
    for (let b = 0; b <= 30; b += 2) {
      if (b === 10) expect(s.pin(270)).toBe(true);
      if (b === 20) expect(s.pin(0)).toBe(true);
      const t = s.read(upFromEuler(b, -5));
      expect(t.steer).toBeGreaterThan(last);
      last = t.steer;
    }
    expect(s.pinned).toBe(90);
    expect(last).toBeCloseTo(deg(30), 2);
  });

  it("re-centres on the current pose, and turns the picture round if the phone was turned round", () => {
    const s = new TiltSession();
    s.pin(90);
    s.read(upFromEuler(0, -40));
    // Held the same way up: just a new neutral, no flip.
    expect(s.recentre(upFromEuler(10, -30))).toBe(false);
    expect(s.read(upFromEuler(10, -30)).steer).toBeCloseTo(0, 6);
    // Now turned round (top edge, device +x, is the low one): flip to 270.
    const turned = upFromEuler(0, 40);
    expect(isUpsideDown(turned, 90)).toBe(true);
    expect(s.recentre(turned)).toBe(true);
    expect(s.pinned).toBe(270);
    expect(s.read(turned).steer).toBeCloseTo(0, 6);
    // And steering is right-way-round for the new pin: at 270 the right
    // edge is the phone's top, so lowering it (beta falls) steers right.
    expect(s.read(upFromEuler(-20, 40)).steer).toBeGreaterThan(0.3);
  });

  it("doesn't flip on re-centre when flat (no way to tell which edge is up)", () => {
    const s = new TiltSession();
    s.pin(90);
    expect(s.recentre(upFromEuler(0, 2))).toBe(false);
    expect(s.pinned).toBe(90);
  });

  it("forgets everything when it ends", () => {
    const s = new TiltSession();
    s.pin(90);
    s.end();
    expect(s.pinned).toBe(null);
    expect(s.pin(270)).toBe(true);
    expect(s.pinned).toBe(270);
  });
});

describe("pinning the picture", () => {
  it("does nothing while the OS agrees with the pin", () => {
    expect(pinRotation(90, 90, 800, 375, 800, 375)).toEqual({ deg: 0, scale: 1 });
  });
  it("turns the picture over when the OS flips to the other landscape", () => {
    expect(pinRotation(90, 270, 800, 375, 800, 375)).toEqual({ deg: 180, scale: 1 });
    expect(pinRotation(270, 90, 800, 375, 800, 375)).toEqual({ deg: 180, scale: 1 });
  });
  it("turns a quarter and fits the viewport when the OS goes portrait", () => {
    // Pinned with the phone's top on the left; the OS now draws portrait
    // (top up), so the picture's up (device +x) is the viewport's right:
    // rotate clockwise 90°.
    expect(pinRotation(90, 0, 800, 375, 375, 800)).toEqual({ deg: 90, scale: 1 });
    expect(pinRotation(270, 0, 800, 375, 375, 800)).toEqual({ deg: 270, scale: 1 });
    // A portrait viewport a little shorter than the picture is wide (URL bar).
    expect(pinRotation(90, 0, 800, 375, 375, 700).scale).toBeCloseTo(700 / 800, 6);
  });

  /** forward is the CSS transform the page applies: about the viewport
   *  centre, rotate clockwise (screen y points down) then scale. */
  function forward(pin: Pin, x: number, y: number, w: number, h: number, vw: number, vh: number): [number, number] {
    const a = (pin.deg * Math.PI) / 180;
    const dx = x - w / 2;
    const dy = y - h / 2;
    return [vw / 2 + pin.scale * (dx * Math.cos(a) - dy * Math.sin(a)), vh / 2 + pin.scale * (dx * Math.sin(a) + dy * Math.cos(a))];
  }

  it("maps touches back to where they land on the pinned picture", () => {
    for (const angle of [90, 270, 0, 180]) {
      const [vw, vh] = angle % 180 ? [800, 375] : [375, 760];
      const pin = pinRotation(90, angle, 800, 375, vw, vh);
      for (const [x, y] of [[100, 300], [700, 50], [400, 187.5], [0, 0]] as [number, number][]) {
        const [sx, sy] = forward(pin, x, y, 800, 375, vw, vh);
        const [bx, by] = unpinPoint(pin, sx, sy, 800, 375, vw, vh);
        expect(bx).toBeCloseTo(x, 6);
        expect(by).toBeCloseTo(y, 6);
      }
    }
  });
});

/** rotateAboutForward returns the hold's "up" after turning the phone by
 *  t degrees about the axis pointing at the player (positive: the phone's
 *  top end rises, i.e. beta's direction), keeping the screen's tip. */
function rotateAboutForward(h: { beta: number; gamma: number }, t: number): Vec3 {
  const n = upFromEuler(h.beta, h.gamma);
  // The axis about which a wheel turns lies in the plane of gravity and
  // the screen normal, perpendicular to the phone's long axis (device y).
  // Turning by t moves "up" toward +y by t, keeping its x/z mix.
  const r = Math.hypot(n[0], n[2]);
  const k = (t * Math.PI) / 180;
  return [(n[0] / r) * Math.cos(k), Math.sin(k), (n[2] / r) * Math.cos(k)];
}
