// The phone's stylesheet: a picked card or option must stand out in every
// theme. Theme rules (body.style-retro .scr-card …) once outranked
// .scr-card.picked, so a tap changed nothing visible. This parses pad.css
// and checks that for every rule styling .scr-card or .scr-choice, some
// .picked rule that applies in the same theme beats it (higher specificity,
// or equal and later) and sets a background.
import { describe, expect, it } from "vitest";
import css from "../../src/client/pad/pad.css?raw";

interface Rule {
  selector: string;
  props: Set<string>;
  order: number;
}

/** rules lists every style rule, including those inside @media, in source
 *  order; @keyframes are skipped. */
function rules(text: string): Rule[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  let order = 0;
  for (const block of src.split(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/)) {
    while ((m = re.exec(block))) {
      const head = m[1].trim().replace(/^@media[^{]*\{\s*/, "");
      const props = new Set(m[2].split(";").map((d) => d.split(":")[0].trim()).filter(Boolean));
      for (const selector of head.split(",")) out.push({ selector: selector.trim(), props, order: order++ });
    }
  }
  return out;
}

/** specificity as [ids, classes/attributes/pseudo-classes, elements]. */
function specificity(sel: string): [number, number, number] {
  const s = sel.replace(/:not\(([^)]*)\)/g, " $1"); // :not counts its argument
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/g) ?? []).length;
  const elements = (s.match(/(?:^|[\s>+~])[a-z][\w-]*/g) ?? []).length + (s.match(/::[\w-]+/g) ?? []).length;
  return [ids, classes, elements];
}

const beats = (a: Rule, b: Rule) => {
  const [x, y] = [specificity(a.selector), specificity(b.selector)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return a.order > b.order;
};

/** bodyClasses are the classes a selector requires on <body>. */
const bodyClasses = (sel: string) => new Set((sel.match(/^body((?:\.[\w-]+)*)/)?.[1] ?? "").split(".").filter(Boolean));

const VISUAL = ["background", "border", "border-color", "box-shadow"];

describe("pad.css picked state", () => {
  const all = rules(css);
  for (const target of [".scr-card", ".scr-choice"]) {
    it(`a picked ${target} outranks every theme's ${target} styling`, () => {
      const picked = all.filter((r) => r.selector.includes(`${target}.picked`) && r.props.has("background"));
      expect(picked.length).toBeGreaterThan(0);
      const styling = all.filter((r) => new RegExp(`${target.replace(".", "\\.")}(?![\\w-])`).test(r.selector) && !r.selector.includes(".picked") && VISUAL.some((p) => r.props.has(p)));
      expect(styling.length).toBeGreaterThan(4); // the base rule and the themes
      for (const s of styling) {
        const theme = bodyClasses(s.selector);
        const winners = picked.filter((p) => [...bodyClasses(p.selector)].every((c) => theme.has(c)) && beats(p, s));
        expect(winners.map((w) => w.selector), `nothing picked outranks "${s.selector}"`).not.toEqual([]);
      }
    });
  }
});
