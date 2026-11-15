// Haptics on both platforms. Android has navigator.vibrate. iOS Safari has
// no vibration API at all, but since iOS 18 toggling a native
// <input type="checkbox" switch> plays the system "tick", so on iOS we flip a
// hidden one. iOS only allows that reliably inside a user gesture, so press
// feedback always works there; buzzes the game sends on its own (a death, a
// win) are best effort.

let iosLabel: HTMLLabelElement | null = null;

/** setupHaptics creates the hidden iOS switch (no-op elsewhere). */
export function setupHaptics() {
  if ("vibrate" in navigator || iosLabel) return;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  input.id = "haptic-switch";
  input.setAttribute("aria-hidden", "true");
  input.tabIndex = -1;
  const label = document.createElement("label");
  label.htmlFor = input.id;
  for (const el of [input, label]) {
    Object.assign(el.style, { position: "fixed", left: "-9999px", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
  }
  document.body.append(input, label);
  iosLabel = label;
}

/** tickOnce plays one short haptic tick. */
function tickOnce(ms: number) {
  if ("vibrate" in navigator) {
    navigator.vibrate(ms);
    return;
  }
  iosLabel?.click();
}

/** flash shows a buzz on screen: an edge glow in the player's colour and a
 *  little shake, lasting about as long as the buzz. iPhones can't be made to
 *  vibrate outside a touch, so this is how they feel the game's buzzes. */
function flash(totalMs: number) {
  const body = document.body;
  body.style.setProperty("--buzz-ms", `${Math.min(900, Math.max(220, totalMs))}ms`);
  body.classList.remove("buzz");
  void body.offsetWidth; // restart the animation if one is already running
  body.classList.add("buzz");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => body.classList.remove("buzz"), Math.min(900, Math.max(220, totalMs)) + 50);
}
let flashTimer: ReturnType<typeof setTimeout> | undefined;

/** haptic plays a duration or an on/off pattern (ms), with a visual buzz. On iOS each "on"
 *  segment becomes one tick, and long segments get a tick every 120 ms so
 *  a 400 ms death buzz still feels long. */
export function haptic(pattern: number | number[]) {
  flash(Array.isArray(pattern) ? pattern.reduce((a, b) => a + b, 0) : pattern);
  if ("vibrate" in navigator) {
    navigator.vibrate(pattern);
    return;
  }
  const segs = Array.isArray(pattern) ? pattern : [pattern];
  let at = 0;
  segs.forEach((ms, i) => {
    if (i % 2 === 0) {
      for (let t = 0; t < Math.max(ms, 1); t += 120) setTimeout(() => tickOnce(ms), at + t);
    }
    at += ms;
  });
}

/** tick is the light feedback for a button press. */
export function tick(ms = 8) {
  tickOnce(ms);
}
