// Builds the /docs page body from the Markdown sources at build time. Kept
// apart from vite.config.ts so it can be unit-tested: given each section's
// Markdown, it returns the sidebar and the sections as HTML strings that
// the Vite plugin splices into docs.html.
import { DOC_SECTIONS, type DocSection } from "./docs-index";
import { escapeHtml, render } from "./markdown";

/** The pieces spliced into docs.html. */
export interface DocsPage {
  nav: string;
  body: string;
}

/** buildDocs renders every section; read(file) returns a file's Markdown. */
export function buildDocs(read: (file: string) => string, sections: DocSection[] = DOC_SECTIONS): DocsPage {
  const groups = new Map<string, string[]>();
  const bodies = sections.map((s, i) => {
    const doc = render(read(s.file), { idPrefix: s.slug, dropTitle: true });
    const subnav = doc.headings
      .filter((h) => h.level === 2)
      .map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
      .join("");
    const link = `<li><a class="doc-link" href="#${s.slug}" data-section="${s.slug}">${escapeHtml(s.title)}</a>${subnav ? `<ul class="doc-sub">${subnav}</ul>` : ""}</li>`;
    groups.set(s.group, [...(groups.get(s.group) ?? []), link]);
    const prev = sections[i - 1];
    const next = sections[i + 1];
    const pager = `<nav class="doc-pager">${prev ? `<a href="#${prev.slug}"><small>PREVIOUS</small>${escapeHtml(prev.title)}</a>` : "<span></span>"}${
      next ? `<a class="next" href="#${next.slug}"><small>NEXT</small>${escapeHtml(next.title)}</a>` : "<span></span>"
    }</nav>`;
    const raw = `<a class="doc-raw" href="/docs/${s.slug}.md" title="This page as Markdown, for agents and offline reading">.md</a>`;
    return `<section class="doc" id="${s.slug}" data-title="${escapeHtml(s.title)}"><header class="doc-head"><p class="doc-group">${escapeHtml(s.group.toUpperCase())}</p><h1>${escapeHtml(s.title)}</h1>${raw}</header>${doc.html}${pager}</section>`;
  });
  const nav = [...groups].map(([g, links]) => `<p class="doc-nav-group">${escapeHtml(g.toUpperCase())}</p><ul>${links.join("")}</ul>`).join("");
  return { nav, body: bodies.join("\n") };
}
