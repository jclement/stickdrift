// Regenerates screen-fixtures.json: raw screens (as a Go game would send
// them) and what the relay's cleanScreen makes of them. Both the Go tests
// (normalize) and the TypeScript tests (cleanScreen) assert against it, so
// the two implementations can't drift apart. Run: bun go/testdata/gen-fixtures.ts
import { writeFileSync } from "node:fs";
import { cleanScreen } from "../../src/shared/protocol";

const long = (n: number) => "x".repeat(n);
const cases: { name: string; raw: unknown }[] = [
  { name: "duplicate card ids shrink the pick", raw: { id: "dup", items: [{ type: "cards", id: "hand", pick: 2, submit: "PLAY", cards: [{ id: "c1", text: "one" }, { id: "c1", text: "again" }] }] } },
  { name: "lists, text and picks are cut to their limits", raw: { id: "caps", items: [
    { type: "heading", text: long(100) },
    { type: "text", text: "tab\there\u0007bell\nnewline" + long(300) },
    { type: "cards", id: "big", pick: 9, cards: Array.from({ length: 14 }, (_, i) => ({ id: `k${i}`, text: long(200) })) },
    { type: "choices", id: "who", pick: 1, options: [{ id: "a", text: long(70), pad: 2, color: "red" }, { id: "a", text: "dup" }, { id: "bad id", text: "x" }, { id: "b", text: "B", pad: 99, color: "#3a86ff" }] },
  ] } },
  { name: "numbers, inputs, buttons and status", raw: { id: "misc", items: [
    { type: "stepper", id: "s", min: 0, max: 0.5, step: 2, value: 9 },
    { type: "slider", id: "sl", min: 10, max: -10, step: 0, value: 3, submit: "SET" },
    { type: "input", id: "i", maxLength: 200, placeholder: long(80) },
    { type: "input", id: "j", maxLength: 0 },
    { type: "button", id: "b" },
    { type: "button", id: "c", label: "GO", color: "#38d996" },
    { type: "status", text: "", seconds: 5000 },
    { type: "status", text: "" },
    { type: "status", text: "half", progress: 0.5 },
    { type: "mystery", id: "m" },
    { type: "button", id: "b", label: "duplicate id" },
    { type: "button", label: "no id" },
  ] } },
  { name: "items past 24 are dropped", raw: { id: "many", items: Array.from({ length: 30 }, (_, i) => ({ type: "text", text: `line ${i}` })) } },
  { name: "a bad screen id refuses the screen", raw: { id: "no spaces", items: [] } },
];
const out = cases.map((c) => ({ ...c, want: cleanScreen(c.raw) }));
writeFileSync(new URL("./screen-fixtures.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${out.length} fixtures`);
