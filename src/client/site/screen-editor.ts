// The designer's screen editor: a textarea of screen JSON beside a live
// /j?preview=screen phone. It validates with the same cleanScreen the relay
// uses, so what you see is what a phone would get. No drag-and-drop:
// screens are a flowing list, so JSON is the clearest editor.
import { cleanScreen, type Screen } from "../../shared/protocol";

const EXAMPLE: Screen = {
  id: "round3-hand",
  items: [
    { type: "text", text: "Round 3 · Ann is the judge" },
    { type: "heading", text: "My superpower is ____, but only during ____." },
    {
      type: "cards", id: "hand", pick: 2, submit: "PLAY THEM", cards: [
        { id: "c1", text: "Aggressive napping" },
        { id: "c2", text: "Tax season" },
        { id: "c3", text: "A modest amount of soup" },
        { id: "c4", text: "Unsolicited jazz" },
      ],
    },
    { type: "stepper", id: "bet", min: 0, max: 100, step: 10, value: 20, submit: "BET" },
    { type: "input", id: "answer", maxLength: 40, placeholder: "Or write your own" },
    { type: "status", text: "Waiting for 3 players…", seconds: 60 },
  ],
};

const editor = document.getElementById("screen-json") as HTMLTextAreaElement | null;
const frame = document.getElementById("screen-pad") as HTMLIFrameElement | null;
const msg = document.getElementById("screen-msg")!;

/** base64url of UTF-8 text, for the #layout= fragment. */
function base64url(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** update re-renders the phone if the JSON parses into a usable screen. */
function update() {
  if (!editor || !frame) return;
  let raw: unknown;
  try {
    raw = JSON.parse(editor.value);
  } catch (e) {
    msg.textContent = `Not JSON yet: ${(e as Error).message}`;
    return; // mid-edit; wait for the next keystroke
  }
  const look = raw as { screen?: unknown };
  const screen = cleanScreen(look.screen ?? raw);
  if (!screen) {
    msg.textContent = 'Not a screen: it needs an "id" (letters, digits, _ and -) and an "items" list.';
    return;
  }
  const src = (look.screen ?? raw) as { items?: unknown };
  const given = Array.isArray(src.items) ? src.items.length : 0;
  const dropped = given - screen.items.length;
  msg.textContent = dropped > 0 ? `${dropped} item(s) dropped by validation (unknown type, missing or repeated id, nothing to show).` : "Valid.";
  frame.src = `/j?preview=screen&color=%23ff8c1a&r=${Date.now()}#layout=${base64url(JSON.stringify(screen))}`;
}

if (editor && frame) {
  editor.value = JSON.stringify(EXAMPLE, null, 2);
  let t: ReturnType<typeof setTimeout>;
  editor.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(update, 400);
  });
  document.getElementById("screen-copy")!.addEventListener("click", () => void navigator.clipboard.writeText(editor.value));
  update();
}
