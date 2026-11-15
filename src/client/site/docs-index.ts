// The documentation's table of contents: which Markdown file becomes which
// section of /docs, in order. vite.config.ts reads this to build the page
// and to publish each file raw at /docs/<slug>.md for agents; llms.txt
// links the same slugs. Add a page here and it appears everywhere.

/** One section of the docs page. */
export interface DocSection {
  /** Anchor on /docs and the raw file name (/docs/<slug>.md). */
  slug: string;
  /** Title in the sidebar and at the top of the section. */
  title: string;
  /** Source file, relative to the repository root. */
  file: string;
  /** One line for the sidebar group and llms.txt. */
  blurb: string;
  /** Sidebar group heading. */
  group: "Start" | "Controllers" | "Reference" | "Guides";
}

/** Every docs section, in reading order. */
export const DOC_SECTIONS: DocSection[] = [
  { slug: "quickstart", title: "Quickstart", file: "docs/quickstart.md", blurb: "Phones controlling your game in five minutes, in the browser or Go.", group: "Start" },
  { slug: "concepts", title: "Concepts", file: "docs/concepts.md", blurb: "Rooms, hosts, pads, looks, phases, and P2P vs the relay.", group: "Start" },
  { slug: "agents", title: "AI agents", file: "docs/agents.md", blurb: "Step-by-step integration instructions for AI coding agents.", group: "Start" },
  { slug: "layouts", title: "Layouts", file: "docs/layouts.md", blurb: "The ten built-in controllers, live, and preview URLs.", group: "Controllers" },
  { slug: "custom-layouts", title: "Custom layouts", file: "docs/custom-layouts.md", blurb: "Describe your own controls: every type and field.", group: "Controllers" },
  { slug: "themes", title: "Themes", file: "docs/themes.md", blurb: "Styles, fonts, shapes and colours, with live previews.", group: "Controllers" },
  { slug: "avatars", title: "Avatars & banners", file: "docs/avatars.md", blurb: "Show each player who they are on their own phone.", group: "Controllers" },
  { slug: "haptics", title: "Haptics", file: "docs/haptics.md", blurb: "Vibrate phones: patterns and platform support.", group: "Controllers" },
  { slug: "sdks", title: "SDKs", file: "docs/sdks.md", blurb: "The JavaScript and Go host libraries.", group: "Reference" },
  { slug: "protocol", title: "Protocol", file: "PROTOCOL.md", blurb: "The wire protocol: WebSockets, JSON messages, 16-byte frames, WebRTC.", group: "Reference" },
  { slug: "recipes", title: "Recipes", file: "docs/recipes.md", blurb: "Game phases, player identity, 4-way grid games, quizzes.", group: "Guides" },
  { slug: "faq", title: "FAQ", file: "docs/faq.md", blurb: "iPhone full screen, latency, guest Wi-Fi, privacy.", group: "Guides" },
];
