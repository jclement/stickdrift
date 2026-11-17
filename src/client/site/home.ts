// Games homepage behaviour: the code-entry boxes (players who see a code on
// the TV can type it here instead of scanning), the version stamp, and some
// whimsy: drift mode (the easter egg), a rotating hero badge and game cards
// that lean towards the pointer.
import "./site.css";
import { isCode } from "../../shared/protocol";
import { installDriftMode } from "./drift";
import { showVersion } from "./version";

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

showVersion();

// ---- Whimsy ----

installDriftMode();

/** The hero badge cycles through lines nobody asked for. */
const BADGE = [
  "FOUR GAMES · UP TO SIXTEEN PLAYERS · FREE",
  "NOW WITH 40% MORE NARRATOR",
  "NO CONTROLLERS WERE PURCHASED",
  "DAVE HAS FOUND HIS CAMERA APP",
  "TESTED ON REAL FRIENDS (SOME REMAIN)",
  "THERE IS A SECRET ON THIS PAGE",
];
const badge = document.getElementById("badge-line");
let bi = 0;
if (badge && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  setInterval(() => {
    badge.classList.add("out");
    setTimeout(() => {
      bi = (bi + 1) % BADGE.length;
      badge.textContent = BADGE[bi];
      badge.classList.remove("out");
    }, 300);
  }, 3800);
}

/** Game cards lean towards the pointer, like a held-up phone. */
for (const card of document.querySelectorAll<HTMLElement>(".game-card")) {
  card.addEventListener("pointermove", (e) => {
    const b = card.getBoundingClientRect();
    const x = (e.clientX - b.left) / b.width - 0.5;
    const y = (e.clientY - b.top) / b.height - 0.5;
    card.style.transform = `perspective(900px) rotateY(${x * 8}deg) rotateX(${-y * 8}deg) translateY(-3px)`;
  });
  card.addEventListener("pointerleave", () => (card.style.transform = ""));
}
