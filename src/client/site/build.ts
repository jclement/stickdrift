// Build-your-own page behaviour: the live layout gallery and the editable
// custom-layout example.
import "./site.css";
import { LAYOUTS, type CustomLayout } from "../../shared/protocol";
import { installDriftMode } from "./drift";
import { showVersion } from "./version";

/** The homepage's own one-liners per layout. The plain descriptions in
 *  protocol.ts stay factual for the API and docs; this is the sales floor. */
const QUIPS: Record<string, string> = {
  "dpad-ab": "D-pad, A and B. The eight-bit original, minus the cartridge you had to blow into.",
  "stick-ab": "An analogue stick that appears wherever the thumb lands, plus A and B. Lets go cleanly to zero, unlike some sticks we could name.",
  arcade: "D-pad, four face buttons, Start and Select. For people who still say \"hadouken\" out loud.",
  gamepad: "Stick, d-pad, four face buttons, shoulders, Start, Select. Everything except the cable.",
  "twin-stick": "Move with the left, aim with the right, shoulders on top. Your thumbs will need a minute.",
  buzzer: "One enormous button. Quiz night, reaction games, settling arguments.",
  quiz: "Four big coloured answer buttons. Being wrong has never been this colourful.",
  paddle: "A slider and a fire button. Pong, Breakout, and other games your parents were good at.",
  tilt: "Steer by tilting the phone, gas and brake under your thumbs. Yes, everyone will lean into the corners.",
  touchpad: "A trackpad: drag to move, tap to click, two fingers for B. Point-and-click, from the couch.",
};

const COLOURS = ["#ff4d6d", "#3a86ff", "#38d996", "#ffbe0b", "#b388ff", "#ff8c1a", "#2ee6e6", "#ff6fb5", "#ff4d6d", "#3a86ff", "#38d996"];

// ---- Gallery ----

const gallery = document.getElementById("gallery")!;
LAYOUTS.filter((l) => l.id !== "custom").forEach((l, i) => {
  const card = document.createElement("article");
  card.className = "card p-4";
  const portrait = l.orientation === "portrait";
  card.innerHTML = `
    <div class="phone ${portrait ? "aspect-[9/16] max-w-[260px] mx-auto" : "aspect-[19.5/9]"}">
      <iframe loading="lazy" title="${l.name} controller" src="/j?preview=${l.id}&color=${encodeURIComponent(COLOURS[i])}"></iframe>
    </div>
    <div class="mt-4 flex items-baseline gap-3">
      <h3 class="font-display text-xl font-bold text-white">${l.name}</h3>
      <code class="text-xs text-muted">${l.id}</code>
    </div>
    <p class="text-sm mt-1">${QUIPS[l.id] ?? l.blurb}</p>
    <p class="text-xs text-muted mt-2 font-mono">${l.produces}</p>`;
  gallery.appendChild(card);
});

// ---- Custom layout example ----

const example: CustomLayout = {
  orientation: "landscape",
  controls: [
    { type: "stick", x: 0.2, y: 0.6, w: 0.4, h: 0.75, size: 0.5 },
    { type: "button", x: 0.86, y: 0.42, size: 0.3, button: "A", label: "FIRE", solid: true },
    { type: "button", x: 0.68, y: 0.68, size: 0.24, button: "B", label: "BOOST", color: "#3a86ff" },
    { type: "tile", x: 0.62, y: 0.2, w: 0.16, h: 0.18, button: "X", label: "MAP", color: "#38d996" },
    { type: "pill", x: 0.42, y: 0.12, button: "Start", label: "PAUSE" },
  ],
};
const pre = document.getElementById("custom-json")!;
pre.contentEditable = "true";
pre.spellcheck = false;
pre.textContent = JSON.stringify(example, null, 2);
const frame = document.getElementById("custom-pad") as HTMLIFrameElement;
function updateCustom() {
  try {
    const json = JSON.stringify(JSON.parse(pre.textContent ?? ""));
    const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    frame.src = `/j?preview=custom&color=%23ff8c1a&r=${Date.now()}#layout=${b64}`;
  } catch {
    // Mid-edit JSON is often invalid; wait for the next keystroke.
  }
}
let t: ReturnType<typeof setTimeout>;
pre.addEventListener("input", () => {
  clearTimeout(t);
  t = setTimeout(updateCustom, 400);
});
updateCustom();

showVersion();
installDriftMode();
