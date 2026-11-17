// Games homepage behaviour: the code-entry boxes (players who see a code on
// the TV can type it here instead of scanning) and the version stamp.
import "./site.css";
import { isCode } from "../../shared/protocol";
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
