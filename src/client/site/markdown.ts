// A small Markdown renderer for the documentation. It runs at build time
// (vite.config.ts turns docs/*.md and PROTOCOL.md into the /docs page), so
// the page ships as plain HTML: fast, readable without JavaScript, and easy
// for agents to scrape. The same .md files are also served raw for agents.
//
// It covers the Markdown the docs actually use, not CommonMark: headings,
// paragraphs, fenced code, GFM tables, flat and nested lists, blockquotes
// (rendered as callouts), and inline code, bold, italics and links.
//
// Two fenced-block "languages" are special, because the docs show live
// controllers rather than screenshots:
//
//   ```preview                       one phone per line: a layout id, then
//   gamepad color=#ff4d6d             key=value preview params (style, font,
//   stick-ab style=neon title="Neon"  shape, bg, text, color) and an optional
//   ```                               title="caption" and `portrait`.
//
//   ```custom                        a custom layout (or a whole look with
//   { "controls": [ … ] }            "custom" and "theme"): shown as JSON
//   ```                              next to a live preview of it.
//
//   ```live                          a placeholder that the docs page
//   avatars                          script turns into an interactive demo.
//   ```
//
// Pure functions only, no DOM: it is imported by vite.config.ts and tests.
import { LAYOUTS, cleanCustom, cleanTheme, type CustomLayout, type Theme } from "../../shared/protocol";

/** A rendered document: its HTML and the headings found, for navigation. */
export interface Rendered {
  html: string;
  headings: { level: number; text: string; id: string }[];
}

/** Options for render. */
export interface RenderOptions {
  /** Prefix for heading ids, so several documents can share one page. */
  idPrefix?: string;
  /** Drop the first H1 (the docs page shows the title itself). */
  dropTitle?: boolean;
}

// ---- Escaping and inline formatting ----

/** escapeHtml makes text safe to place in HTML content or attributes. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** slug turns heading text into an id fragment: "Custom layouts" -> "custom-layouts". */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * inline formats one line of Markdown text. Code spans are cut out first so
 * nothing inside them is formatted, then links, bold and italics apply to
 * the escaped remainder.
 */
export function inline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
    // Only same-site paths, anchors and http(s) links: docs never need javascript: URLs.
    const safe = /^(https?:\/\/|\/|#|\.)/.test(href) ? href : "#";
    const external = /^https?:\/\//.test(safe) ? ' target="_blank" rel="noopener"' : "";
    return `<a href="${safe}"${external}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}

// ---- Live previews ----

/** base64url encodes ASCII text for a #layout= fragment. */
export function base64url(ascii: string): string {
  return btoa(ascii).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * asciiJson serialises a value as pure-ASCII JSON. The phone decodes the
 * #layout= fragment with atob, which yields Latin-1, so anything beyond
 * ASCII (an emoji label) must travel as a \u escape to survive the trip.
 */
export function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** The params the phone's preview mode reads (see src/client/pad/main.ts). */
const PREVIEW_PARAMS = ["color", "style", "font", "shape", "bg", "text"];

/** One phone in a preview grid. */
export interface PreviewSpec {
  layout: string;
  params: Record<string, string>;
  title?: string;
  portrait: boolean;
  custom?: CustomLayout;
}

/** previewUrl builds the /j?preview= URL for one phone. */
export function previewUrl(p: PreviewSpec): string {
  const q = new URLSearchParams({ preview: p.layout });
  for (const k of PREVIEW_PARAMS) if (p.params[k]) q.set(k, p.params[k]);
  const hash = p.custom ? `#layout=${base64url(asciiJson(p.custom))}` : "";
  return `/j?${q.toString()}${hash}`;
}

/** parsePreviewLine reads `layout key=value key="quoted value" portrait`. */
export function parsePreviewLine(line: string): PreviewSpec | null {
  const tokens = line.match(/[\w-]+="[^"]*"|\S+/g);
  if (!tokens?.length) return null;
  const [layout, ...rest] = tokens;
  const params: Record<string, string> = {};
  let title: string | undefined;
  let portrait = LAYOUTS.find((l) => l.id === layout)?.orientation === "portrait";
  for (const t of rest) {
    if (t === "portrait") {
      portrait = true;
      continue;
    }
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq);
    const value = t.slice(eq + 1).replace(/^"|"$/g, "");
    if (key === "title") title = value;
    else params[key] = value;
  }
  return { layout, params, title, portrait };
}

/** phoneHtml renders one live preview phone with an optional caption. */
export function phoneHtml(p: PreviewSpec): string {
  const shape = p.portrait ? "doc-phone portrait" : "doc-phone";
  const caption = p.title ? `<figcaption>${inline(p.title)}</figcaption>` : `<figcaption><code>${escapeHtml(p.layout)}</code></figcaption>`;
  return `<figure class="doc-preview"><div class="phone ${shape}"><iframe loading="lazy" title="${escapeHtml(p.title ?? p.layout)} preview" src="${escapeHtml(previewUrl(p))}"></iframe></div>${caption}</figure>`;
}

/** previewBlock renders a ```preview fence: one phone per non-empty line. */
function previewBlock(body: string): string {
  const phones = body
    .split("\n")
    .map((l) => parsePreviewLine(l.trim()))
    .filter((p): p is PreviewSpec => p !== null);
  const cls = phones.length === 1 ? "doc-previews one" : "doc-previews";
  return `<div class="${cls}">${phones.map(phoneHtml).join("")}</div>`;
}

/** customBlock renders a ```custom fence: the JSON beside a live preview. */
function customBlock(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`invalid JSON in a custom block: ${(e as Error).message}\n${body}`);
  }
  const look = parsed as { custom?: unknown; theme?: unknown; color?: string };
  const custom = cleanCustom(look.custom ?? parsed);
  if (!custom) throw new Error(`custom block has no usable controls:\n${body}`);
  const theme: Theme = cleanTheme(look.theme) ?? {};
  const params: Record<string, string> = { color: look.color ?? "#ff8c1a" };
  if (theme.style) params.style = theme.style;
  if (theme.font) params.font = theme.font;
  if (theme.shape) params.shape = theme.shape;
  if (theme.background) params.bg = theme.background;
  if (theme.text) params.text = theme.text;
  const phone = phoneHtml({ layout: "custom", params, custom, portrait: custom.orientation === "portrait", title: "Live preview" });
  return `<div class="doc-custom">${codeBlock(body, "json")}${phone}</div>`;
}

/** liveBlock is a placeholder the docs page script turns into an
 *  interactive demo (```live avatars```); without JavaScript it says so. */
function liveBlock(name: string): string {
  return `<div class="doc-live" data-live="${escapeHtml(name)}"><p>This interactive demo needs JavaScript.</p></div>`;
}

/** codeBlock renders fenced code with a copy button. */
function codeBlock(body: string, lang: string): string {
  const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
  return `<div class="doc-code"><button class="copy" type="button" aria-label="Copy code">COPY</button><pre><code${cls}>${escapeHtml(body)}</code></pre></div>`;
}

// ---- Blocks ----

/** isTableDivider spots the |---|---| line under a table header. */
const isTableDivider = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => inline(c.trim().replace(/\\\|/g, "|")));
const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/** renderList renders consecutive list lines, nesting on deeper indents. */
function renderList(lines: string[]): string {
  const first = lines[0].match(LIST_ITEM)!;
  const indent = first[1].length;
  const tag = /\d/.test(first[2]) ? "ol" : "ul";
  const items: string[][] = [];
  for (const l of lines) {
    const m = l.match(LIST_ITEM);
    if (m && m[1].length <= indent) items.push([m[3]]);
    else items[items.length - 1].push(l);
  }
  const html = items.map(([head, ...more]) => {
    const nestedAt = more.findIndex((l) => LIST_ITEM.test(l));
    const text = (nestedAt < 0 ? more : more.slice(0, nestedAt)).map((l) => l.trim());
    const nested = nestedAt < 0 ? "" : renderList(more.slice(nestedAt));
    return `<li>${inline([head, ...text].join(" "))}${nested}</li>`;
  });
  return `<${tag}>${html.join("")}</${tag}>`;
}

/** render turns a Markdown document into HTML plus its heading list. */
export function render(md: string, opts: RenderOptions = {}): Rendered {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const headings: Rendered["headings"] = [];
  const prefix = opts.idPrefix ? `${opts.idPrefix}-` : "";
  let droppedTitle = !opts.dropTitle;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code (and the live-preview fences).
    const fence = line.match(/^```\s*([\w-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const lang = fence[1];
      const text = body.join("\n");
      if (lang === "preview") out.push(previewBlock(text));
      else if (lang === "custom") out.push(customBlock(text));
      else if (lang === "live") out.push(liveBlock(text.trim()));
      else out.push(codeBlock(text, lang));
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      i++;
      const level = heading[1].length;
      if (level === 1 && !droppedTitle) {
        droppedTitle = true;
        continue;
      }
      const id = prefix + slug(heading[2]);
      headings.push({ level, text: heading[2].replace(/`/g, ""), id });
      out.push(`<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        `<div class="doc-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const block: string[] = [];
      while (i < lines.length && (LIST_ITEM.test(lines[i]) || (/^\s+\S/.test(lines[i]) && block.length))) block.push(lines[i++]);
      out.push(renderList(block));
      continue;
    }
    if (line.startsWith(">")) {
      const block: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) block.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<aside class="callout">${render(block.join("\n")).html}</aside>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    // A paragraph runs until a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>)/.test(lines[i]) && !LIST_ITEM.test(lines[i])) {
      if (lines[i].includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) break;
      para.push(lines[i++].trim());
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return { html: out.join("\n"), headings };
}
