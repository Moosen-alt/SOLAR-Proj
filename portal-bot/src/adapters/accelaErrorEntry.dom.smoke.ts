// THE FIRST MINUTES OF A REPLAY: an Accela Error.aspx landing during entry is recognised and
// re-entered promptly, and the wait says what it is waiting on.
//
// Live run 99baa5d0 (Oregon ePermitting, 2026-09-27): the operator's screen recording shows the
// browser on aca-oregon.accela.com/oregon/Error.aspx?ErrorId=… (Accela's own error page, blank,
// tab still loading) at 06:18:39, the Dashboard at 06:18:59, the Work Location page at 06:19:19.
// The recipe's step 0 ("goto entry url" = Dashboard.aspx) took 50.9 s: page.goto waited for
// `load` on an error page that was still fetching, then waitForInteractiveControls burned its
// full 12 s budget on a page with no controls, and the dashboard showed nothing the whole time.
//
// REPLICA (no live portal): the first GET of /oregon/Dashboard.aspx answers 302 → /oregon/Error.aspx
// (as Accela did). Error.aspx is a blank page whose one image the server holds for 25 s (so `load`
// waits) and which refreshes itself to the Dashboard after 20 s (as Accela did, f001→f002). Every
// later Dashboard hit is the real dashboard (Apply link → Work Location page with inputs).
//
// MUST-PASS: the replay reaches the Work Location page and fills the street number; the seconds
//   from the start of the run to that first application page are printed BEFORE/AFTER (this smoke
//   run on the unchanged adapter gave the "before"); the entry step is under 15 s; the error
//   landing is named in the run's notes; progress lines were emitted for the wait.
// MUST-EXCLUDE: an entry page that is NOT an error page (the dashboard served first time) is not
//   re-fetched — exactly one Dashboard GET before the Apply click.
//
// Run: npx tsx portal-bot/src/adapters/accelaErrorEntry.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import { RecipeAdapter } from "./recipeAdapter";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const P = "ctl00_PlaceHolderMain";
const SLOW_IMG_MS = 25_000;
const REFRESH_S = 20;
const hits: string[] = [];
let mode: "error_first" | "plain" = "error_first";
let dashboardHits = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  hits.push(url.pathname + url.search);
  if (/\/oregon\/Dashboard\.aspx$/i.test(url.pathname)) {
    dashboardHits++;
    if (mode === "error_first" && dashboardHits === 1) { res.writeHead(302, { location: "/oregon/Error.aspx?ErrorId=91f98968bf2f40e590fc5bdbd9cddf3f" }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>BuildingPermits.Oregon.gov</title></head><body><h1 class="ACA_Hide">Message Bar</h1>
      <div id="nav"><a href="/oregon/Cap/WorkLocation.aspx?Module=Building">Apply</a> <a href="/oregon/Dashboard.aspx">Home</a> <a href="/oregon/Logout.aspx">Log out</a></div>
      <h2>Hello, TestAccount</h2></body></html>`);
    return;
  }
  if (/\/oregon\/Error\.aspx$/i.test(url.pathname)) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>BuildingPermits.Oregon.gov</title><meta http-equiv="refresh" content="${REFRESH_S};url=/oregon/Dashboard.aspx"></head><body><img src="/oregon/slow.gif" alt=""></body></html>`);
    return;
  }
  if (/\/oregon\/slow\.gif$/i.test(url.pathname)) {
    const t = setTimeout(() => { res.writeHead(200, { "content-type": "image/gif" }); res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64")); }, SLOW_IMG_MS);
    req.on("close", () => clearTimeout(t));
    return;
  }
  if (/\/oregon\/Cap\/WorkLocation\.aspx$/i.test(url.pathname)) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>BuildingPermits.Oregon.gov</title></head><body><h2>Enter Work Site Location</h2>
      <label for="${P}_WorkLocationEdit_txtStreetNo4Search_ChildControl0">Street Number:</label> <input id="${P}_WorkLocationEdit_txtStreetNo4Search_ChildControl0" type="text">
      <label for="${P}_WorkLocationEdit_txtStreetName">Street Name:</label> <input id="${P}_WorkLocationEdit_txtStreetName" type="text">
      <a id="${P}_WorkLocationEdit_btnSearch" href="javascript:void(0)">Search</a></body></html>`);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("not found");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const steps: RecipeStep[] = [
  { action: "goto", value: `${base}/oregon/Dashboard.aspx`, note: "entry url" },
  { action: "click", selector: { text: "Apply", fallbacks: [{ role: "link", name: "Apply" }] }, note: "application entry: Apply" },
  { action: "fill", selector: { label: "Street Number:" }, note: "work location: street number", field: "streetNumber" },
  { action: "stopForReview" } as RecipeStep,
];
const recipe = {
  id: "aca-error-entry", scopeType: "ahj", profileKey: "or|city of coos bay|pacific power", state: "OR", ahj: "City of Coos Bay", utility: "",
  portalPlatform: "accela", portalUrl: `${base}/oregon/`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "", discipline: "electrical", steps,
} as unknown as PortalRecipe;

const browser = await chromium.launch();
async function run(m: typeof mode): Promise<{ ms: number; firstAppPageMs: number; result: { ok: boolean; message: string; data?: Record<string, unknown> }; progress: string[]; url: string; street: string }> {
  mode = m; dashboardHits = 0; hits.length = 0;
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page: Page = await ctx.newPage();
  const progress: string[] = [];
  const adapter = new RecipeAdapter(recipe, { streetNumber: "953" }, {}, { onProgress: (p) => progress.push(`${p.phase}@${Math.round(p.elapsedMs / 1000)}s: ${p.message}`) });
  (adapter as unknown as { page: unknown }).page = page;
  const t0 = Date.now();
  let firstAppPageMs = -1;
  page.on("framenavigated", (f) => { if (f === page.mainFrame() && /WorkLocation/i.test(f.url()) && firstAppPageMs < 0) firstAppPageMs = Date.now() - t0; });
  let result: { ok: boolean; message: string; data?: Record<string, unknown> };
  try { result = await adapter.fillApplication({} as ProjectRecord) as typeof result; } catch (e) { result = { ok: false, message: `threw ${String(e).slice(0, 300)}` }; }
  const ms = Date.now() - t0;
  const street = await page.evaluate((id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? "(missing)", `${P}_WorkLocationEdit_txtStreetNo4Search_ChildControl0`).catch(() => "(unreadable)");
  const url = page.url();
  await ctx.close().catch(() => null);
  return { ms, firstAppPageMs, result, progress, url, street };
}
const say = (o: Awaited<ReturnType<typeof run>>): string => `ms=${o.ms} firstAppPage=${o.firstAppPageMs} ok=${String(o.result.ok)} url=${o.url} street=${o.street} msg=${o.result.message.slice(0, 200)} slow=${JSON.stringify(o.result.data?.slowSteps ?? [])} notes=${JSON.stringify((o.result.data?.agingNotes as string[] | undefined)?.filter((n) => /error page/i.test(n)))} progress=${JSON.stringify(o.progress.slice(0, 8))}`;

try {
  const a = await run("error_first");
  console.log(`  [timing] Error.aspx-first entry: ${a.ms} ms to the end of the run; ${a.firstAppPageMs} ms from the start of the run to the first application page (Work Location); slowSteps=${JSON.stringify(a.result.data?.slowSteps ?? [])}`);
  check("MUST-PASS F3: the replay gets past Accela's Error.aspx landing and fills the Work Location page", a.street === "953" && /WorkLocation/i.test(a.url), say(a));
  const entry = (a.result.data?.slowSteps as Array<{ i: number; ms: number }> | undefined)?.find((s) => s.i === 0)?.ms ?? 0;
  check("MUST-PASS F3: the entry step is under 15 s (live: 50.9 s; the page's own refresh alone is 20 s)", a.firstAppPageMs > 0 && a.firstAppPageMs < 15000 && entry < 15000, say(a));
  check("MUST-PASS F3: the error landing is NAMED in the run's notes", ((a.result.data?.agingNotes as string[] | undefined) ?? []).some((n) => /error page/i.test(n) && /Error\.aspx|re-entered|retr/i.test(n)), say(a));
  check("MUST-PASS F3: the wait reported progress (\"Waiting for the portal…\")", a.progress.some((p) => /waiting for the portal/i.test(p)), say(a));

  const b = await run("plain");
  console.log(`  [timing] plain entry (dashboard first time): ${b.ms} ms; first application page at ${b.firstAppPageMs} ms`);
  check("MUST-PASS plain: a normal entry still reaches the Work Location page", b.street === "953" && /WorkLocation/i.test(b.url), say(b));
  check("MUST-EXCLUDE F3: an entry page that is not an error page is not re-fetched (one Dashboard GET before Apply)",
    hits.filter((h) => /Dashboard\.aspx/i.test(h)).length === 1, `hits=${JSON.stringify(hits)}`);
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} accela-error-entry check(s) FAILED.`); process.exit(1); }
console.log("\nAll accela-error-entry checks passed (real Chromium, replica portal).");
process.exit(0);
