// The Worker: routes WebSocket upgrades to the room's Durable Object,
// serves the small JSON API, and serves the static pages (home, phone
// controller, demo host) from the assets binding with security headers.
import { Hono } from "hono";
import { LAYOUTS, PROTOCOL_VERSION, isCode } from "../shared/protocol";

export { Session } from "./session";

const VERSION = "0.1.0";

const app = new Hono<{ Bindings: Env }>();

// Security headers on everything we serve. The CSP allows our own scripts
// and styles, Google Fonts, and WebSockets back to this origin.
app.use("*", async (c, next) => {
  await next();
  if (c.res.status === 101) return;
  // Responses from the Durable Object or assets can have immutable headers.
  c.res = new Response(c.res.body, c.res);
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "SAMEORIGIN");
  h.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' wss: ws:; frame-src 'self'; frame-ancestors 'self'",
  );
});

app.get("/api/v1/health", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ status: "ok", version: VERSION, build: c.env.BUILD ?? "dev", protocol: PROTOCOL_VERSION, update_available: false });
});

app.get("/api/v1/layouts", (c) => c.json({ data: LAYOUTS }));

/** Host (game) WebSocket: /ws/host/CODE?key=SECRET */
app.get("/ws/host/:code", (c) => forward(c.env, c.req.raw, c.req.param("code"), "host"));

/** Pad (phone) WebSocket: /ws/pad/CODE?device=ID */
app.get("/ws/pad/:code", (c) => forward(c.env, c.req.raw, c.req.param("code"), "pad"));

// The phone controller page, at a shareable /j/CODE URL.
app.get("/j/:code?", (c) => page(c.env, c.req.raw, "/pad.html"));
app.get("/demo", (c) => page(c.env, c.req.raw, "/demo.html"));

/** forward hands a WebSocket upgrade to the room's Durable Object. */
function forward(env: Env, req: Request, rawCode: string, role: "host" | "pad"): Response | Promise<Response> {
  const code = rawCode.toUpperCase();
  if (!isCode(code)) return Response.json({ error: { code: "VALIDATION_ERROR", message: "room codes are five letters" } }, { status: 400 });
  if (req.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
  const url = new URL(req.url);
  url.searchParams.set("code", code);
  url.searchParams.set("role", role);
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(code));
  return stub.fetch(new Request(url, req));
}

/** page serves a built HTML page from the assets binding. */
async function page(env: Env, req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  url.pathname = path;
  const res = await env.ASSETS.fetch(new Request(url, { headers: req.headers }));
  const out = new Response(res.body, res);
  // Pages must revalidate so a reload after a deploy gets the new build;
  // their scripts and styles have content-hashed names and cache forever.
  out.headers.set("Cache-Control", "no-cache");
  return out;
}

export default app;
