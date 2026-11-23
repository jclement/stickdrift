// PinKeeper decides when the tilt controller is pinned to the phone and
// which orientation lock the page should hold. It is kept apart from the
// DOM so its event ordering can be tested: the page feeds it the screen as
// it is now (ScreenState) and applies what it returns.
//
// Two orderings matter. Phones report a rotation as several events that
// arrive in no fixed order: the viewport can resize before the orientation
// angle changes, or after. So pinning is retried on every event and the
// watchdog, not only when the size changes, and only happens once the angle
// and the viewport agree it is landscape (otherwise a landscape pin could
// capture portrait dimensions). And the lock is decided from the layout
// that was just built, never the one being replaced.
import { isLandscape, pinRotation, TiltSession, type Pin } from "./tilt";

/** What the page knows about the screen right now. */
export interface ScreenState {
  angle: number; // screen orientation angle
  vw: number; // viewport width
  vh: number; // viewport height
  type?: string; // screen.orientation.type, when there is one
  fullscreen: boolean;
}

/** What to do about the orientation lock: lock to a type, unlock, or
 *  leave it as it is (null). */
export type LockAction = { lock: string } | { unlock: true } | null;

export class PinKeeper {
  readonly session = new TiltSession();
  /** The counter-rotation to draw, while pinned. */
  pin: Pin | null = null;
  /** The size the pinned picture is laid out at. */
  w = 0;
  h = 0;
  private wanted = false; // a tilt layout is up
  private needsLandscape = false; // the current layout wants landscape
  private tiltLock = false; // the lock held was put on by a tilt pin (exact or relaxed)

  get pinned(): boolean {
    return this.session.pinned !== null;
  }

  /** beforeBuild runs before a layout is built: anything but tilt unpins,
   *  so it lays out for the screen as the OS shows it. Returns whether the
   *  page must drop its pinned styling. */
  beforeBuild(usesTilt: boolean): boolean {
    if (usesTilt || !this.pinned) return false;
    this.session.end();
    this.pin = null;
    this.wanted = false;
    return true;
  }

  /** afterBuild runs once the incoming layout is built. It pins if it can,
   *  and returns the lock that layout calls for. */
  afterBuild(usesTilt: boolean, needsLandscape: boolean, s: ScreenState): LockAction {
    this.wanted = usesTilt;
    this.needsLandscape = needsLandscape;
    this.sync(s);
    return this.lockAfterChange(s);
  }

  /** sync runs on every resize, orientation change and watchdog tick. It
   *  pins the tilt controller as soon as angle and viewport agree on
   *  landscape, then keeps the counter-rotation current. Returns true when
   *  it has just pinned (the page then lays out at the pinned size and
   *  applies lockAfterChange). */
  sync(s: ScreenState): boolean {
    if (!this.wanted) return false;
    let fresh = false;
    if (!this.pinned) {
      if (!isLandscape(s.angle) || s.vw <= s.vh) return false;
      this.session.pin(s.angle);
      this.w = s.vw;
      this.h = s.vh;
      fresh = true;
    }
    this.pin = pinRotation(this.session.pinned!, s.angle, this.w, this.h, s.vw, s.vh);
    return fresh;
  }

  /** lockAfterChange is the lock after a layout change, a new pin or a
   *  re-centre. Only tilt changes it: a pin gets an exact lock (the way the
   *  phone is held). While still pinned but no longer matching (a re-centre
   *  turned it round) it is relaxed to either landscape and stays tilt's to
   *  release. When the pin goes, so does its lock: relaxed to landscape for
   *  a landscape layout, released otherwise. Other layouts keep whatever
   *  entering full screen set, as they always have. */
  lockAfterChange(s: ScreenState): LockAction {
    if (!s.fullscreen) return null;
    const exact = this.exactLock(s);
    if (exact) {
      this.tiltLock = true;
      return { lock: exact };
    }
    if (!this.tiltLock) return null;
    if (this.pinned) return { lock: "landscape" }; // still tilt's lock
    this.tiltLock = false;
    return this.needsLandscape ? { lock: "landscape" } : { unlock: true };
  }

  /** lockOnFullscreen is the lock on entering full screen: exact while
   *  pinned, landscape for a landscape layout (as before), else none. */
  lockOnFullscreen(s: ScreenState): LockAction {
    const exact = this.exactLock(s);
    if (exact) {
      this.tiltLock = true;
      return { lock: exact };
    }
    if (this.pinned) this.tiltLock = true; // pinned, but the OS is the other way round
    return this.needsLandscape ? { lock: "landscape" } : null;
  }

  private exactLock(s: ScreenState): string | null {
    const p = this.session.pinned;
    if (p === null || p !== s.angle % 360 || !s.type?.startsWith("landscape")) return null;
    return s.type;
  }
}
