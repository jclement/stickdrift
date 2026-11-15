// Homepage behaviour: the code-entry boxes, the live layout gallery and the
// editable custom-layout example.
import "./site.css";
import { LAYOUTS, isCode, type CustomLayout } from "../../shared/protocol";

const COLOURS = ["#ff4d6d", "#3a86ff", "#38d996", "#ffbe0b", "#b388ff", "#ff8c1a", "#2ee6e6", "#ff6fb5", "#ff4d6d", "#3a86ff", "#38d996"];

// ---- Join boxes ----

const boxes = [...document.querySelectorAll<HTMLInputElement>("#join input")];
boxes.forEach((b, i) => {
  b.addEventListener("input", () => {
    b.value = b.value.toUpperCase().replace(/[^A-Z]/g, "").slice(-1);
    if (b.value && i < boxes.length - 1) boxes[i + 1].focus();
    const code = boxes.map((x) => x.value).join("");
    if (isCode(code)) location.assign(`/j/${code}`);
  });
  b.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !b.value && i > 0) boxes[i - 1].focus();
  });
});

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
    <p class="text-sm mt-1">${l.blurb}</p>
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

// ---- Version ----

fetch("/api/v1/health")
  .then((r) => r.json())
  .then((h) => (document.getElementById("version")!.textContent = `v${(h as { version: string }).version}`))
  .catch(() => {});
