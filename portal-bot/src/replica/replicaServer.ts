// SERVE A CAPTURED PORTAL BACK AS A LIVE ONE.
//
// The bundles built by extractFromTrace.ts hold the real markup of pages we have actually
// walked — Accela's WorkLocation and CapConfirm, PowerClerk's EditProject. This serves them
// on localhost so a recipe can be replayed against genuine portal DOM with no government
// server involved, no credentials, and no possibility of filing something real.
//
// It is a STAND-IN, not an emulator. It does not run the portal's JavaScript, so an
// ASP.NET postback or a Vue wizard will not advance on its own. What it faithfully
// reproduces is the thing recipes actually break on: the DOM — ids, labels, nesting,
// duplicate namesakes, hidden twins, the wrapper rows around a results grid. Every failure
// this project has debugged live (the record-type checkbox chosen by index, the invisible
// Model combobox, the disabled Apply pill, the nested address grid) is a DOM fact, and all
// of them are reproducible here.
//
// Every submission is recorded and queryable at /__state, so a test asserts on what the
// portal RECEIVED rather than on a screenshot.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { ReplicaBundle } from "./extractFromTrace";

export interface ReplicaSubmission {
  at: string;
  route: string;
  method: string;
  fields: Record<string, string>;
}

export interface ReplicaServer {
  base: string;
  port: number;
  submissions: ReplicaSubmission[];
  routes: string[];
  close(): Promise<void>;
}

export function loadBundle(file: string): ReplicaBundle {
  return JSON.parse(fs.readFileSync(file, "utf8")) as ReplicaBundle;
}

export function bundleDir(): string {
  return path.resolve(process.cwd(), "data/portal-replicas");
}

export function listBundles(): string[] {
  const dir = bundleDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f));
}

/** Make a captured page safe and navigable offline:
 *   - <base href> to the real portal would send every relative link back to the real host.
 *   - Absolute portal links become local ones so clicking through stays inside the replica.
 *   - Forms POST back to the replica so what a recipe fills is recorded.
 *   - Nothing external loads (a replica must work with the network unplugged). */
export function localizeHtml(html: string, origins: string[]): string {
  let out = html.replace(/<base\b[^>]*>/gi, "");
  for (const origin of origins) {
    const rx = new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(rx, "");
  }
  // Kill remaining off-box asset loads; keep the tag so layout/DOM shape is unchanged.
  out = out.replace(/(<link\b[^>]*\bhref=")https?:\/\/[^"]*(")/gi, "$1about:blank$2");
  out = out.replace(/(<img\b[^>]*\bsrc=")https?:\/\/[^"]*(")/gi, "$1about:blank$2");
  // Any form with no action posts to itself; give them all an explicit method the server sees.
  out = out.replace(/<form\b([^>]*)>/gi, (m, attrs: string) => {
    const withMethod = /\bmethod=/i.test(attrs) ? attrs : `${attrs} method="post"`;
    return `<form${withMethod}>`;
  });
  return out;
}

function parseBody(raw: string, contentType: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (/multipart\/form-data/i.test(contentType)) {
    const boundary = /boundary=(.+)$/.exec(contentType)?.[1] || "";
    for (const part of raw.split(`--${boundary}`)) {
      const fm = /name="([^"]+)"[^]*?filename="([^"]*)"/.exec(part);
      if (fm) { if (fm[2]) out[fm[1]] = fm[2]; continue; }
      const m = /name="([^"]+)"\r\n\r\n([^]*?)\r\n$/.exec(part);
      if (m) out[m[1]] = m[2].trim();
    }
    return out;
  }
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

export async function startReplicaServer(opts: { bundleFile: string; port?: number }): Promise<ReplicaServer> {
  const bundle = loadBundle(opts.bundleFile);
  const submissions: ReplicaSubmission[] = [];
  const byRoute = new Map(bundle.pages.map((p) => [p.key || p.route, p]));
  // Origins seen in the capture — rewritten out so nothing reaches the real portal.
  const origins = [...new Set(bundle.pages.map((p) => { try { return new URL(p.url).origin; } catch { return ""; } }).filter(Boolean))];
  const localized = new Map<string, string>();
  for (const p of bundle.pages) localized.set(p.key || p.route, localizeHtml(p.html, origins));

  // A RECIPE ASKS FOR THE URL IT RECORDED, not for our variant key. A single-page-app
  // wizard is stored one page per step (/MvcProjects/EditProject/~installer-information),
  // but a replay navigates to the bare /MvcProjects/EditProject it saw live. Serve the
  // richest page captured for that path so the recorded URL still lands somewhere real;
  // the per-step keys stay addressable for a test that wants one specific step.
  const bestForRoute = (route: string): string | undefined => {
    let best: { html: string; bytes: number } | undefined;
    for (const p of bundle.pages) {
      if (p.route !== route) continue;
      if (!best || p.bytes > best.bytes) best = { html: localized.get(p.key || p.route) ?? "", bytes: p.bytes };
    }
    return best?.html || undefined;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const route = url.pathname.replace(/\/+$/, "") || "/";

    if (route === "/__state") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ portal: bundle.portal, routes: [...byRoute.keys()], submissions }));
      return;
    }
    if (route === "/__reset") { submissions.length = 0; res.end("{}"); return; }

    const serve = (body: string, code = 200): void => {
      res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };

    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        submissions.push({
          at: new Date().toISOString(),
          route,
          method: "POST",
          fields: parseBody(Buffer.concat(chunks).toString("latin1"), String(req.headers["content-type"] || "")),
        });
        // A postback re-renders the same page — the same thing ASP.NET does.
        serve(localized.get(route) ?? bestForRoute(route) ?? indexPage(bundle, [...byRoute.keys()]));
      });
      return;
    }

    const page = localized.get(route) ?? bestForRoute(route);
    if (page) { serve(page); return; }
    // An unknown route lists what this replica does have, so a wrong-URL failure is obvious.
    serve(indexPage(bundle, [...byRoute.keys()]), route === "/" ? 200 : 404);
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    submissions,
    routes: [...byRoute.keys()],
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function indexPage(bundle: ReplicaBundle, routes: string[]): string {
  const rows = routes.map((r) => `<li><a href="${r}">${r}</a></li>`).join("");
  return `<!doctype html><html><head><title>${bundle.portal} (replica)</title></head><body>
    <h1>${bundle.portal} — offline replica</h1>
    <p>Captured ${bundle.builtAt} from ${bundle.sourceRuns.length} learn run(s). No live portal is involved.</p>
    <ul>${rows}</ul></body></html>`;
}
