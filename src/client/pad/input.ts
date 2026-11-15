// Input is the controller's single source of truth. Controls write into it;
// it sends a frame the instant the encoded state changes, with no batching
// to animation frames, because a frame of delay is 16 ms of lag.
import { BUTTON_NAMES, Button, encodeFrame, emptyState, type ButtonName, type PadState } from "../../shared/protocol";

const DIRS: ButtonName[] = ["Up", "Down", "Left", "Right"];

export class Input {
  private state: PadState = emptyState();
  private held = 0; // buttons from press-style controls
  private dirSources = new Map<string, ButtonName[]>(); // direction bits by control
  private lastSent = "";

  constructor(private send: (frame: ArrayBuffer) => void) {}

  /** set holds or releases one button. */
  set(b: ButtonName, on: boolean) {
    const bit = 1 << Button[b];
    this.held = on ? this.held | bit : this.held & ~bit;
    this.commit();
  }

  /** setDirections replaces the directions held by one control (keyed by
   *  the caller's identity), so a d-pad and a stick can both steer. Returns
   *  whether the overall state changed. */
  setDirections(dirs: ButtonName[], source = "default"): boolean {
    this.dirSources.set(source, dirs);
    return this.commit();
  }

  /** setStick sets an analog stick (-1..1, y down). */
  setStick(side: "left" | "right", x: number, y: number) {
    if (side === "left") {
      this.state.lx = x;
      this.state.ly = y;
    } else {
      this.state.rx = x;
      this.state.ry = y;
    }
    this.commit();
  }

  /** addPointer accumulates touchpad motion in pixels. */
  addPointer(dx: number, dy: number) {
    this.state.px += dx;
    this.state.py += dy;
    this.commit();
  }

  /** pulse taps a button: down now, up after a beat (touchpad clicks). */
  pulse(b: ButtonName) {
    this.set(b, true);
    setTimeout(() => this.set(b, false), 70);
  }

  /** releaseAll lets go of everything (page hidden, layout change). */
  releaseAll() {
    this.held = 0;
    this.dirSources.clear();
    this.state.lx = this.state.ly = this.state.rx = this.state.ry = 0;
    this.commit();
  }

  /** resend pushes the current state again (after a reconnect). */
  resend() {
    this.lastSent = "";
    this.commit();
  }

  /** buttons returns the currently held mask (for the debug readout). */
  get buttons(): number {
    return this.state.buttons;
  }

  private commit(): boolean {
    let dirs = 0;
    for (const list of this.dirSources.values()) for (const d of list) dirs |= 1 << Button[d];
    const dirMask = DIRS.reduce((m, d) => m | (1 << Button[d]), 0);
    this.state.buttons = (this.held & ~dirMask) | dirs | (this.held & dirMask);
    // Compare the quantised frame, not the floats: sub-step stick jitter
    // shouldn't cost bandwidth.
    const frame = encodeFrame(this.state);
    const key = new Uint8Array(frame, 4).join(",");
    if (key === this.lastSent) return false;
    this.lastSent = key;
    this.state.seq = (this.state.seq + 1) & 0xffff;
    this.send(encodeFrame(this.state));
    return true;
  }
}

/** describe lists held buttons for debugging. */
export function describe(mask: number): string {
  return BUTTON_NAMES.filter((b) => mask & (1 << Button[b])).join(" ");
}
