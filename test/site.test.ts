// Tests for the site's pure modules: the build-time Markdown renderer that
// turns docs/*.md into /docs, the docs page assembly, and the layout
// designer's model (geometry must match the phone, and designs must survive
// the round trip through a URL).
import { describe, expect, it } from "vitest";
import { asciiJson, base64url, escapeHtml, inline, parsePreviewLine, previewUrl, render, slug } from "../src/client/site/markdown";
import { buildDocs } from "../src/client/site/docs-build";
import { DOC_SECTIONS } from "../src/client/site/docs-index";
import { FIELDS, STARTERS, boxOf, decodeDesign, encodeDesign, newControl, previewPath, toLook, unit } from "../src/client/site/designer-model";
import { CONTROL_TYPES, cleanCustom, cleanScreen } from "../src/shared/protocol";

describe("markdown inline", () => {
  it("escapes HTML and formats code, bold, italics and links", () => {
    expect(inline("a <b> & `x<y>` **bold** *em* [docs](/docs#a)")).toBe(
      'a &lt;b&gt; &amp; <code>x&lt;y&gt;</code> <strong>bold</strong> <em>em</em> <a href="/docs#a">docs</a>',
    );
  });
  it("leaves formatting inside code spans alone", () => {
    expect(inline("`**not bold**`")).toBe("<code>**not bold**</code>");
  });
  it("refuses javascript: links and opens external links in a new tab", () => {
    expect(inline("[x](javascript:alert(1))")).not.toContain("javascript");
    expect(inline("[x](https://example.com)")).toContain('target="_blank"');
  });
  it("slugs headings", () => {
    expect(slug("Custom `layouts` & more")).toBe("custom-layouts-more");
  });
  it("escapes quotes for attributes", () => {
    expect(escapeHtml('"><script>')).toBe("&quot;&gt;&lt;script&gt;");
  });
});

describe("markdown blocks", () => {
  it("renders headings with prefixed ids and drops the title", () => {
    const r = render("# Title\n\n## Getting started\n\ntext", { idPrefix: "qs", dropTitle: true });
    expect(r.html).not.toContain("Title</h1>");
    expect(r.html).toContain('<h2 id="qs-getting-started">');
    expect(r.headings).toEqual([{ level: 2, text: "Getting started", id: "qs-getting-started" }]);
  });
  it("renders tables, lists, code and callouts", () => {
    const md = "| A | B |\n|---|---|\n| `1` | two |\n\n- one\n  continued\n- two\n  - nested\n\n```js\nlet x = 1 < 2;\n```\n\n> **Note** hi";
    const html = render(md).html;
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td><code>1</code></td>");
    expect(html).toContain("<li>one continued</li>");
    expect(html).toContain("<ul><li>nested</li></ul>");
    expect(html).toContain('<code class="lang-js">let x = 1 &lt; 2;</code>');
    expect(html).toContain('<aside class="callout"><p><strong>Note</strong> hi</p></aside>');
  });
  it("joins paragraph lines and stops at a list", () => {
    expect(render("one\ntwo\n- item").html).toBe("<p>one two</p>\n<ul><li>item</li></ul>");
  });
});

describe("live previews", () => {
  it("parses a preview line with quoted titles and portrait", () => {
    expect(parsePreviewLine('quiz style=neon color=#ff4d6d title="Two words" portrait')).toEqual({
      layout: "quiz",
      params: { style: "neon", color: "#ff4d6d" },
      title: "Two words",
      portrait: true,
    });
  });
  it("defaults portrait from the layout's orientation", () => {
    expect(parsePreviewLine("dpad-ab")?.portrait).toBe(false);
  });
  it("builds preview URLs with only known params", () => {
    expect(previewUrl({ layout: "gamepad", params: { color: "#fff", evil: "x" }, portrait: false })).toBe("/j?preview=gamepad&color=%23fff");
  });
  it("renders a preview fence as iframes", () => {
    const html = render("```preview\nbuzzer color=#000\nquiz\n```").html;
    expect(html.match(/<iframe/g)).toHaveLength(2);
    expect(html).toContain('src="/j?preview=buzzer&amp;color=%23000"');
  });
  it("renders a custom fence as JSON plus a decodable preview", () => {
    const html = render('```custom\n{"controls":[{"type":"button","x":0.5,"y":0.5,"label":"GO 🚀"}]}\n```').html;
    const hash = html.match(/#layout=([A-Za-z0-9_-]+)/)![1];
    // Decode exactly as the phone does: atob, then JSON.parse.
    const decoded = cleanCustom(JSON.parse(atob(hash.replace(/-/g, "+").replace(/_/g, "/"))));
    expect(decoded?.controls[0].label).toBe("GO 🚀");
  });
  it("renders a screen fence as JSON plus a decodable, portrait preview", () => {
    const html = render('```screen\n{"id":"r1","items":[{"type":"cards","id":"h","cards":[{"id":"a","text":"Soup 🍲"}]}]}\n```').html;
    expect(html).toContain("doc-phone portrait");
    expect(html).toContain("preview=screen");
    const hash = html.match(/#layout=([A-Za-z0-9_-]+)/)![1];
    const decoded = cleanScreen(JSON.parse(atob(hash.replace(/-/g, "+").replace(/_/g, "/"))));
    expect(decoded?.items[0].cards?.[0].text).toBe("Soup 🍲");
  });
  it("fails the build on a broken screen fence", () => {
    expect(() => render('```screen\n{"items":[]}\n```')).toThrow(/no usable screen/);
  });
  it("fails the build on a broken custom fence", () => {
    expect(() => render("```custom\n{nope\n```")).toThrow(/invalid JSON/);
  });
  it("keeps JSON ASCII so atob can carry it", () => {
    expect(asciiJson({ l: "é🚀" })).toMatch(/^[\x20-\x7e]+$/);
    expect(base64url("??>")).not.toMatch(/[+/=]/);
  });
});

describe("docs page", () => {
  it("renders every section with navigation and pager", () => {
    const page = buildDocs((f) => `# T\n\n## Part of ${f}\n\nBody.`);
    for (const s of DOC_SECTIONS) {
      expect(page.body).toContain(`<section class="doc" id="${s.slug}"`);
      expect(page.nav).toContain(`href="#${s.slug}"`);
      expect(page.body).toContain(`href="/docs/${s.slug}.md"`);
    }
    expect(page.nav).toContain(`href="#quickstart-part-of-docs-quickstart-md"`);
  });
  it("has unique slugs", () => {
    expect(new Set(DOC_SECTIONS.map((s) => s.slug)).size).toBe(DOC_SECTIONS.length);
  });
});

describe("designer model", () => {
  it("has fields and a new-control default for every control type", () => {
    for (const t of CONTROL_TYPES) {
      expect(FIELDS[t]).toBeDefined();
      expect(newControl(t).type).toBe(t);
    }
  });
  it("picks a free button for new controls", () => {
    expect(newControl("button", 0.5, 0.5, ["A", "B"]).button).toBe("X");
  });
  it("matches the phone's geometry", () => {
    // 800x400: unit = min(400, 480) = 400.
    expect(unit(800, 400)).toBe(400);
    expect(boxOf({ type: "button", x: 0.5, y: 0.5, size: 0.25 }, 800, 400)).toMatchObject({ cx: 400, cy: 200, w: 100, h: 100, round: true });
    expect(boxOf({ type: "tile", x: 0.5, y: 0.5 }, 800, 400)).toMatchObject({ w: 240, h: 80 }); // defaults 0.3 x 0.2
    expect(boxOf({ type: "pill", x: 0, y: 0 }, 800, 400)).toMatchObject({ w: 104, h: 36 });
    expect(boxOf({ type: "stick", x: 0.5, y: 0.5, w: 0.2, h: 0.5, size: 0.9 }, 800, 400).knob).toBe(160); // capped by the zone
    // Portrait: the unit is 60% of the width.
    expect(unit(400, 800)).toBe(240);
  });
  it("drops fields a type doesn't use and rounds", () => {
    const look = toLook({ orientation: "landscape", color: "#ff0000", theme: { style: "neon" }, controls: [{ type: "pill", x: 0.123456, y: 0.5, size: 0.3, button: "Start", label: "GO" }] });
    expect(look.custom!.controls[0]).toEqual({ type: "pill", x: 0.12, y: 0.5, button: "Start", label: "GO" });
    expect(look.theme).toEqual({ style: "neon" });
  });
  it("round-trips a design through the URL", () => {
    for (const name of ["shooter", "racer", "quiz"]) {
      const d = STARTERS[name];
      const back = decodeDesign(encodeDesign(d))!;
      expect(toLook(back)).toEqual(toLook(d));
    }
  });
  it("loads pasted JSON, either a whole look or a bare layout", () => {
    expect(decodeDesign('{"layout":"custom","custom":{"controls":[{"type":"dpad","x":0.3,"y":0.5}]}}')?.controls).toHaveLength(1);
    expect(decodeDesign('{"orientation":"portrait","controls":[{"type":"buzzer","x":0.5,"y":0.5}]}')?.orientation).toBe("portrait");
    expect(decodeDesign("not json")).toBeNull();
    expect(decodeDesign('{"controls":[]}')).toBeNull();
  });
  it("builds a preview link the phone understands", () => {
    const path = previewPath(STARTERS.racer);
    expect(path).toMatch(/^\/j\?preview=custom&color=%23ffbe0b&style=retro&font=pixel&shape=square#layout=/);
  });
});
