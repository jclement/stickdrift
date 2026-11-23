// Tilt steering that ignores the phone's idea of which way is up.
//
// Phones auto-rotate when tilted hard or held near flat, which a tilt game
// invites. So the tilt layout never reads the screen orientation mid-game:
// when tilting starts it records which way the player is holding the phone
// (the neutral pose) and which way the picture was drawn (the pinned
// orientation), and from then on steering is measured in the phone's own
// fixed axes. If the OS rotates anyway, the page counter-rotates the picture
// (pinRotation) so the controls stay where the player's thumbs are.
//
// Everything is worked out from the gravity vector rather than raw Euler
// angles: beta and gamma wrap and swap meaning near flat and upright, but
// the "up" direction they describe is continuous.
//
// Device axes (W3C): x to the right of the screen in its natural (portrait)
// orientation, y toward its top, z out of the screen.

export type Vec3 = [number, number, number];

/** Tilt that reaches full lock, in degrees from the neutral pose. */
export const FULL_TILT_DEG = 45;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));
const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const rad = (deg: number) => (deg * Math.PI) / 180;

/** upFromEuler turns deviceorientation beta and gamma (degrees) into the
 *  unit vector pointing away from the ground, in device axes. Alpha (the
 *  compass heading) does not change where "up" is. */
export function upFromEuler(beta: number, gamma: number): Vec3 {
  const b = rad(beta);
  const g = rad(gamma);
  return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
}

/** normAngle folds any orientation angle onto 0, 90, 180 or 270. */
export function normAngle(angle: number): number {
  return ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
}

/** screenAxes gives the picture's right and up directions in device axes
 *  when it is drawn at a screen orientation angle (0 portrait, 90 with the
 *  phone's top to the left, 270 with it to the right). */
export function screenAxes(angle: number): { right: Vec3; up: Vec3 } {
  const a = rad(normAngle(angle));
  const c = Math.round(Math.cos(a));
  const s = Math.round(Math.sin(a));
  return { right: [c, -s, 0], up: [s, c, 0] };
}

/** TiltFrame is the reference steering is measured against: the neutral
 *  "up" and the picture's right and up made level with it. */
export interface TiltFrame {
  neutral: Vec3;
  right: Vec3; // the picture's right, perpendicular to neutral
  ahead: Vec3; // the picture's up, perpendicular to neutral and right
}

/** calibrate records the neutral pose: steering is zero when the phone is
 *  held as it is now, whatever the angle (upright like a wheel, tipped
 *  toward the player, or flat on the hands), for a picture drawn at the
 *  pinned orientation angle. */
export function calibrate(up: Vec3, pinnedAngle: number): TiltFrame {
  const neutral = unit(up);
  const axes = screenAxes(pinnedAngle);
  // The picture's right, made level. If it points almost straight up or
  // down (the phone stood on its end), level the picture's up instead and
  // take right from that.
  let right = sub(axes.right, scale(neutral, dot(axes.right, neutral)));
  let ahead: Vec3;
  if (len(right) > 0.3) {
    right = unit(right);
    ahead = cross(neutral, right);
  } else {
    ahead = unit(sub(axes.up, scale(neutral, dot(axes.up, neutral))));
    right = cross(ahead, neutral);
  }
  return { neutral, right, ahead };
}

/** Tilt is the controller reading: steer is -1 (full left) to 1 (full
 *  right); pitch is -1 (tipped away, top edge down) to 1 (tipped back, top
 *  edge up), matching a stick's y, which points down the picture. */
export interface Tilt {
  steer: number;
  pitch: number;
}

/** readTilt measures the current "up" against the frame. Dipping the
 *  picture's right edge steers right; raising its top edge pulls back. */
export function readTilt(frame: TiltFrame, up: Vec3, fullDeg = FULL_TILT_DEG): Tilt {
  const g = unit(up);
  const full = rad(fullDeg);
  return {
    steer: clamp(Math.asin(clamp(-dot(g, frame.right))) / full),
    pitch: clamp(Math.asin(clamp(dot(g, frame.ahead))) / full),
  };
}

/** isUpsideDown reports whether the picture's top edge is clearly the low
 *  edge, i.e. the player has turned the phone round since it was pinned.
 *  Only meaningful when the phone isn't flat; used when re-centring. */
export function isUpsideDown(up: Vec3, pinnedAngle: number): boolean {
  return dot(unit(up), screenAxes(pinnedAngle).up) < -0.35;
}

/** isLandscape reports whether an orientation angle is a landscape one. */
export function isLandscape(angle: number): boolean {
  return normAngle(angle) % 180 === 90;
}

/** Pin is how to draw the picture so it stays fixed to the phone: rotate
 *  clockwise by deg about the viewport's centre and shrink by scale. */
export interface Pin {
  deg: number;
  scale: number;
}

/** pinRotation counter-rotates a picture laid out (w by h CSS px) at the
 *  pinned angle, now that the OS shows the page at angle in a viewport of
 *  vw by vh. It shrinks the picture only if the turned box would not fit. */
export function pinRotation(pinnedAngle: number, angle: number, w: number, h: number, vw: number, vh: number): Pin {
  const deg = normAngle(pinnedAngle - angle);
  const [bw, bh] = deg % 180 === 0 ? [w, h] : [h, w];
  const s = Math.min(1, vw / bw, vh / bh);
  return { deg, scale: s > 0 && Number.isFinite(s) ? s : 1 };
}

/** unpinPoint maps a pointer position in the viewport back into the pinned
 *  picture's own coordinates (the inverse of pinRotation's transform). */
export function unpinPoint(pin: Pin, x: number, y: number, w: number, h: number, vw: number, vh: number): [number, number] {
  const dx = (x - vw / 2) / pin.scale;
  const dy = (y - vh / 2) / pin.scale;
  const a = rad(-pin.deg);
  const c = Math.round(Math.cos(a));
  const s = Math.round(Math.sin(a));
  return [w / 2 + dx * c - dy * s, h / 2 + dx * s + dy * c];
}

/** TiltSession is one stretch of tilt play: the orientation the picture is
 *  pinned to and the neutral pose, both fixed until the player re-centres or
 *  the tilt layout goes away. Screen rotations never reach the steering. */
export class TiltSession {
  /** The screen orientation angle the picture is pinned to, once pinned. */
  pinned: number | null = null;
  private frame: TiltFrame | null = null;

  /** pin fixes the picture at the OS's current angle, if that is a
   *  landscape one (a portrait start waits for the player to turn). Returns
   *  whether the session is pinned. Once pinned, later calls change nothing. */
  pin(angle: number): boolean {
    if (this.pinned === null && isLandscape(angle)) {
      this.pinned = normAngle(angle);
      this.frame = null;
    }
    return this.pinned !== null;
  }

  /** read turns a sensor reading into steering. The first reading after
   *  pinning or re-centring becomes the neutral pose. */
  read(up: Vec3): Tilt {
    if (this.pinned === null) return { steer: 0, pitch: 0 };
    if (!this.frame) this.frame = calibrate(up, this.pinned);
    return readTilt(this.frame, up);
  }

  /** recentre makes the current pose neutral. If the player has clearly
   *  turned the phone round since it was pinned, the picture turns with
   *  them (returns true) so the controls are the right way up again. */
  recentre(up: Vec3 | null): boolean {
    if (this.pinned === null) return false;
    let flipped = false;
    if (up && isUpsideDown(up, this.pinned)) {
      this.pinned = normAngle(this.pinned + 180);
      flipped = true;
    }
    this.frame = up ? calibrate(up, this.pinned) : null;
    return flipped;
  }

  /** end forgets the pin and the neutral pose. */
  end() {
    this.pinned = null;
    this.frame = null;
  }
}
