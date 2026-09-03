// BUILD A PORTAL REPLICA FROM A LEARN RUN'S OWN TRACE.
//
// Every learn run already saves a Playwright trace containing a full DOM snapshot of each
// page it walked — thousands of them, real markup from the real portal. That is a replica
// waiting to be assembled: an offline stand-in of Accela / PowerClerk / any portal we have
// ever learned, that recipes can be regression-tested against with no government server
// involved, no credentials, and no risk of filing something real.
//
// Two things this deliberately does NOT do:
//
//   * It does not resolve Playwright's snapshot DIFF encoding. Later snapshots of a frame
//     are stored as back-references ([n, m]) into earlier ones. Resolving them faithfully
//     means reimplementing an internal format that is free to change. Instead we keep, per
//     URL, the snapshot with the largest self-contained tree — a full capture of that page.
//     A replica needs one good copy of each page, not every keystroke's delta.
//
//   * It does not keep the data that was typed in. Every input's value/checked state is
//     dropped: the captured pages carry real homeowner names, addresses, account and meter
//     numbers. A replica is a blank form, which is both the privacy-safe artifact and the
//     useful one — the point is to fill it again from a recipe.
import fs from "node:fs";
import path from "node:path";

export interface ReplicaPage {
  url: string;
  /** Path-only key (query dropped — portals key pages on path). NOT unique on an SPA. */
  route: string;
  /** What this page calls itself — the wizard step. Distinguishes the nine PowerClerk
   *  steps that all live at /MvcProjects/EditProject. */
  variant: string;
  /** The unique key the replica server routes on: route, plus the step when a route has
   *  more than one. */
  key: string;
  title: string;
  html: string;
  bytes: number;
}

/** A Playwright snapshot node: a string of text, or [TAG, attrs, ...children], or a
 *  back-reference [n, m] into an earlier snapshot (which we skip — see the header). */
type SnapNode = string | unknown[];

const VOID_TAGS = new Set(["AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META", "PARAM", "SOURCE", "TRACK", "WBR"]);
// Stripped wholesale: a replica must never phone home, run the portal's SPA, or restore the
// operator's session. Styles stay — a recognisable page is far easier to debug against.
const DROP_TAGS = new Set(["SCRIPT", "NOSCRIPT", "IFRAME"]);
// Values are dropped (PII), and so is anything that would fire a network call on load.
const DROP_ATTRS = new Set(["value", "checked", "selected", "integrity", "crossorigin", "srcset", "ping"]);

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string): string => esc(s).replace(/"/g, "&quot;");

function isBackRef(node: unknown[]): boolean {
  return node.length === 2 && typeof node[0] === "number" && typeof node[1] === "number";
}

/** Render one snapshot tree to HTML. Returns "" for a node we deliberately skip. */
export function renderSnapshotNode(node: SnapNode): string {
  if (typeof node === "string") return esc(node);
  if (!Array.isArray(node) || node.length === 0) return "";
  if (isBackRef(node)) return ""; // diffed subtree — not resolvable without the earlier snapshot
  const tag = String(node[0] || "").toUpperCase();
  if (!tag || DROP_TAGS.has(tag)) return "";
  const attrs = (node[1] && typeof node[1] === "object" && !Array.isArray(node[1])) ? node[1] as Record<string, unknown> : {};
  const attrStr = Object.entries(attrs)
    .filter(([k]) => !DROP_ATTRS.has(k.toLowerCase()) && !/^on/i.test(k))
    .map(([k, v]) => ` ${k}="${escAttr(String(v ?? ""))}"`)
    .join("");
  const childStart = (node[1] && typeof node[1] === "object" && !Array.isArray(node[1])) ? 2 : 1;
  if (VOID_TAGS.has(tag)) return `<${tag.toLowerCase()}${attrStr}>`;
  const inner = node.slice(childStart).map((c) => renderSnapshotNode(c as SnapNode)).join("");
  return `<${tag.toLowerCase()}${attrStr}>${inner}</${tag.toLowerCase()}>`;
}

/** Path-only route key. Portals key their pages on the path; the query carries per-project
 *  ids (ProjectId, capID) that must NOT split one page into dozens of replica routes. */
export function routeOf(url: string): string {
  try { const u = new URL(url); return u.pathname.replace(/\/+$/, "") || "/"; }
  catch { return url; }
}

/** WHICH STEP OF THE WIZARD IS THIS?
 *
 *  A single-page app serves every step from ONE url: all nine PowerClerk steps — Customer
 *  Information through Aggregation — are /MvcProjects/EditProject. Keying replica pages on
 *  the path alone kept the largest and threw the other eight away, which is why the first
 *  build of this produced a PowerClerk replica with no equipment page in it.
 *
 *  So a page is identified by path PLUS what it calls itself. The step name is the most
 *  stable thing on screen: the heading a portal renders for the section being filled. Falls
 *  back to the count of form controls, which at least separates a form from a landing page. */
export function variantOf(html: string): string {
  // Prefer an explicit step/section heading.
  for (const rx of [/<h1[^>]*>([^<]{3,60})<\/h1>/i, /<h2[^>]*>([^<]{3,60})<\/h2>/i, /<legend[^>]*>([^<]{3,60})<\/legend>/i]) {
    const m = rx.exec(html);
    const t = m?.[1]?.replace(/\s+/g, " ").trim();
    if (t && !/^\s*$/.test(t)) return t.slice(0, 48);
  }
  // PowerClerk marks the active step with aria-current / an "active" step class.
  const active = /aria-current="(?:step|page)"[^>]*>\s*([^<]{3,48})</i.exec(html)
    ?? /class="[^"]*\b(?:active|current)\b[^"]*"[^>]*>\s*([^<]{3,48})</i.exec(html);
  const at = active?.[1]?.replace(/\s+/g, " ").trim();
  if (at) return at.slice(0, 48);
  const inputs = (html.match(/<input\b/gi) || []).length;
  const selects = (html.match(/<select\b/gi) || []).length;
  return `form-${inputs}i-${selects}s`;
}

/** Give every page a servable key. A route captured once keeps its real path, so a recipe's
 *  own recorded URL still resolves; a route with several steps behind it (an SPA wizard)
 *  gets one child path per step, which is the only way to reach step 7 offline. */
function finalizeKeys(pages: ReplicaPage[]): ReplicaPage[] {
  const perRoute = new Map<string, number>();
  for (const p of pages) perRoute.set(p.route, (perRoute.get(p.route) ?? 0) + 1);
  const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "step";
  for (const p of pages) {
    p.key = (perRoute.get(p.route) ?? 0) > 1 ? `${p.route}/~${slug(p.variant)}` : p.route;
  }
  return pages.sort((a, b) => a.key.localeCompare(b.key));
}

function titleOf(html: string): string {
  const m = /<title[^>]*>([^<]{0,120})<\/title>/i.exec(html);
  return m ? m[1].trim() : "";
}

/** Extract the best full snapshot per route from an unpacked trace.trace file. */
export function pagesFromTraceFile(traceFile: string): ReplicaPage[] {
  return pagesFromTraceText(fs.readFileSync(traceFile, "utf8"));
}

/** The same, from the trace text itself — read straight out of the zip without unpacking. */
export function pagesFromTraceText(raw: string): ReplicaPage[] {
  const best = new Map<string, ReplicaPage>();
  for (const line of raw.split("\n")) {
    if (!line.includes('"frame-snapshot"')) continue;
    let d: { type?: string; snapshot?: { frameUrl?: string; html?: unknown } };
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "frame-snapshot" || !d.snapshot) continue;
    const url = String(d.snapshot.frameUrl || "");
    if (!url || url.startsWith("about:")) continue;
    const tree = d.snapshot.html;
    if (!Array.isArray(tree) || isBackRef(tree as unknown[])) continue;
    const html = renderSnapshotNode(tree as SnapNode);
    // A real page is substantial; a diffed husk is not.
    if (html.length < 2000) continue;
    const route = routeOf(url);
    const variant = variantOf(html);
    const k = `${route}::${variant}`;
    const prior = best.get(k);
    if (!prior || html.length > prior.bytes) {
      best.set(k, { url, route, variant, key: k, title: titleOf(html), html, bytes: html.length });
    }
  }
  return finalizeKeys([...best.values()]);
}

/** Read trace.trace straight out of a trace.zip. adm-zip (already a dependency) rather than
 *  shelling to tar: tar refused these archives on Windows, and a 50 MB trace does not need
 *  to be unpacked to disk to read one member out of it. */
export async function pagesFromTraceZip(zipPath: string): Promise<ReplicaPage[]> {
  const mod = await import("adm-zip");
  const AdmZip = (mod.default ?? mod) as unknown as new (p: string) => { readAsText(name: string): string };
  const text = new AdmZip(zipPath).readAsText("trace.trace");
  if (!text) return [];
  return pagesFromTraceText(text);
}

/** Pages from a run's OWN captures (page-*.json, written by learnDebug.capturePageHtml).
 *  Preferred over trace mining: these are whole pages, already blanked of the operator's
 *  data, and an SPA's steps survive because each was captured in full rather than as a
 *  diff against the step before it. */
export function pagesFromCaptureDir(runDir: string): ReplicaPage[] {
  if (!fs.existsSync(runDir)) return [];
  const files = fs.readdirSync(runDir).filter((f) => f.startsWith("page-") && f.endsWith(".json"));
  const best = new Map<string, ReplicaPage>();
  for (const f of files) {
    let c: { url?: string; title?: string; heading?: string; html?: string };
    try { c = JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")); } catch { continue; }
    if (!c.html || c.html.length < 500) continue;
    const url = String(c.url || "");
    const route = routeOf(url);
    const variant = (c.heading || "").trim() || variantOf(c.html);
    const k = `${route}::${variant}`;
    const prior = best.get(k);
    if (!prior || c.html.length > prior.bytes) {
      best.set(k, { url, route, variant, key: k, title: String(c.title || ""), html: c.html, bytes: c.html.length });
    }
  }
  return finalizeKeys([...best.values()]);
}

export interface ReplicaBundle {
  portal: string;
  builtAt: string;
  sourceRuns: string[];
  pages: ReplicaPage[];
}

/** Merge the pages of several runs of the SAME portal — later/larger captures win, so a
 *  portal learned repeatedly gets steadily more complete rather than being overwritten. */
export function mergeBundles(portal: string, runs: Array<{ run: string; pages: ReplicaPage[] }>): ReplicaBundle {
  const byKey = new Map<string, ReplicaPage>();
  for (const r of runs) {
    for (const p of r.pages) {
      const kk = `${p.route}::${p.variant}`;
      const prior = byKey.get(kk);
      if (!prior || p.bytes > prior.bytes) byKey.set(kk, p);
    }
  }
  return {
    portal,
    builtAt: new Date().toISOString(),
    sourceRuns: runs.map((r) => r.run),
    pages: finalizeKeys([...byKey.values()]),
  };
}
