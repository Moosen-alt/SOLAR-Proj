// "THIS PORTAL DOES NOT SERVE THIS ADDRESS" STOPS THE WALK — learn AND replay (portal-truth D5).
//
// City of Corvallis OR, 2026-09-28: staging fell to Oregon ePermitting, where Corvallis files no
// building permits. After the address search the portal said "No Building services were returned
// for this address" — and the learner walked four more pages and saved a recipe keyed to Corvallis
// on that host. The one predicate (shared/src/portalNotServed.portalSaysNotServed) is now asked of
// every page the learner reads and after every page-moving replay step; the walk stops there, with
// the portal's own words in a field of its own (LearnResult.notServed / step data.notServed).
//
// REPLICA (no live portal): /start (a street-number box + Search) → /result (the variant's
// message + a job-value box + Continue Application) → /review.
//   MUST-PASS  (notserved): the learner stops ON /result with notServed = the portal's words and
//              stopReason "not_served", recording nothing after it; the replay stops before the
//              job-value fill (the box stays empty) with data.notServed.
//   MUST-EXCLUDE (norecords): "No records were returned for this search." is not a refusal — the
//              learner and the replay walk on to review, notServed unset.
//
// Run: npx tsx portal-bot/src/adapters/notServed.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const MESSAGES: Record<string, string> = {
  notserved: "No Building services were returned for this address.",
  norecords: "No records were returned for this search.",
};
const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const variant = (req.headers.cookie || "").match(/v=(\w+)/)?.[1] || "notserved";
  res.writeHead(200, { "content-type": "text/html" });
  if (url.pathname === "/start") {
    res.end(html("Permits - Work Location", `<h2>Enter Work Site Location</h2>
      <form action="/result" method="get"><label for="sn">Street Number:</label> <input id="sn" name="sn" type="text">
      <button type="submit">Search</button></form>`));
    return;
  }
  if (url.pathname === "/result") {
    res.end(html("Permits - Select Record Type", `<h2>Select a Record Type</h2>
      <div class="ACA_Message_Notice"><span>${MESSAGES[variant]}</span></div>
      <form action="/review" method="get"><label for="jv">Job Value:</label> <input id="jv" name="jv" type="text">
      <button type="submit">Continue Application</button></form>`));
    return;
  }
  if (url.pathname === "/review") {
    res.end(html("Permits - Review", `<h2>Step 3: Review</h2><p>Please review all information below.</p>
      <table><tr><td>Job Value:</td><td>${url.searchParams.get("jv") ?? ""}</td></tr></table>`));
    return;
  }
  res.end(html("Not found", "<h1>Not found</h1>"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// Give every text box its obvious value; advance by Search / Continue Application; review is review.
const planner: LearnPlanner = async (req) => {
  const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
  req.fields.forEach((f, i) => {
    const l = String(f.label ?? "");
    if (f.fieldType === "text" && /street number/i.test(l)) fills.push({ selectorIndex: i, value: "953", field: "streetNumber" });
    if (f.fieldType === "text" && /job value/i.test(l)) fills.push({ selectorIndex: i, value: "20000", field: "valuation" });
  });
  const adv = req.fields.findIndex((f) => f.fieldType === "button" && /^(search|continue application)$/i.test(String(f.label ?? "").trim()));
  const atReview = /review/i.test(String((req as { pageTitle?: string }).pageTitle ?? "")) || req.fields.every((f) => f.fieldType === "button");
  return { fills, atReview, ...(adv >= 0 && !atReview ? { advanceSelectorIndex: adv } : {}) };
};
const project = { projectAddress: "953 Test St, Testville, OR 97330", city: "Testville", state: "OR", zip: "97330", homeownerName: "Test Owner", permitType: "structural", parserSnapshot: {} } as unknown as ProjectRecord;

const browser = await chromium.launch();
async function withPage<T>(variant: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.addCookies([{ name: "v", value: variant, url: base }]);
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  try { return await fn(page); } finally { await ctx.close().catch(() => null); }
}
async function learn(variant: string) {
  return withPage(variant, async (page) => {
    await page.goto(`${base}/start`);
    const adapter = new AutoLearnAdapter("Not Served Smoke", planner, { maxPages: 6 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).page = page;
    let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
    let threw = "";
    try { r = await adapter.learn({ portalUrl: `${base}/start` } as never, project); } catch (e) { threw = String(e).slice(0, 300); }
    return { r, threw, at: page.url() };
  });
}
const recipe = (): PortalRecipe => ({
  id: "not-served", scopeType: "ahj", profileKey: "or|city of testville|", state: "OR", ahj: "City of Testville", utility: "",
  portalPlatform: "accela", portalUrl: `${base}/start`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "", discipline: "structural",
  steps: [
    { action: "goto", value: `${base}/start`, note: "entry url" },
    { action: "fill", selector: { label: "Street Number:" }, field: "streetNumber", note: "work location: street number" },
    { action: "click", selector: { text: "Search", fallbacks: [{ role: "button", name: "Search" }] }, note: "work location: search" },
    { action: "fill", selector: { label: "Job Value:" }, field: "valuation", note: "Job Value" },
    { action: "click", selector: { text: "Continue Application", fallbacks: [{ role: "button", name: "Continue Application" }] }, note: "record type: continue" },
    { action: "stopForReview" } as RecipeStep,
  ] as RecipeStep[],
} as unknown as PortalRecipe);
async function replay(variant: string) {
  return withPage(variant, async (page) => {
    const adapter = new RecipeAdapter(recipe(), { streetNumber: "953", valuation: "20000" }, {}, { autoSubmit: false });
    (adapter as unknown as { page: unknown }).page = page;
    let result: { ok: boolean; message: string; data?: Record<string, unknown> };
    try { result = await adapter.fillApplication(project) as typeof result; } catch (e) { result = { ok: false, message: `threw ${String(e).slice(0, 300)}` }; }
    const jobValue = await page.evaluate(() => (document.getElementById("jv") as HTMLInputElement | null)?.value ?? "(no box)").catch(() => "(unreadable)");
    return { result, jobValue, at: page.url() };
  });
}

try {
  const a = await learn("notserved");
  const notesA = (a.r?.steps ?? []).map((s) => String(s.note ?? ""));
  check("MUST-PASS learn: the walk STOPS on the portal's 'not served' words, in their own field", a.r?.notServed === MESSAGES.notserved && a.r?.stopReason === "not_served" && a.r?.ok === false,
    `notServed=${JSON.stringify(a.r?.notServed)} stopReason=${a.r?.stopReason} ok=${String(a.r?.ok)} at=${a.at} ${a.threw} msg=${String(a.r?.message ?? "").slice(0, 300)}`);
  check("MUST-PASS learn: nothing is recorded ON or after the refusing page (no job value, no Continue), and it never reaches review",
    !notesA.some((n) => /job value|continue/i.test(n)) && a.r?.reachedReview !== true && !/review/.test(a.at), `notes=${JSON.stringify(notesA)} at=${a.at}`);

  const b = await learn("norecords");
  check("MUST-EXCLUDE learn: 'No records were returned for this search.' is not a refusal — notServed unset, the walk reaches review",
    !b.r?.notServed && b.r?.reachedReview === true, `notServed=${JSON.stringify(b.r?.notServed)} reachedReview=${String(b.r?.reachedReview)} at=${b.at} ${b.threw} msg=${String(b.r?.message ?? "").slice(0, 300)}`);

  const c = await replay("notserved");
  check("MUST-PASS replay: the replay stops after Search with data.notServed = the portal's words, and the job value is never typed",
    c.result.ok === false && c.result.data?.notServed === MESSAGES.notserved && (c.jobValue === "" || c.jobValue === "(no box)"),
    `ok=${String(c.result.ok)} notServed=${JSON.stringify(c.result.data?.notServed)} jobValue=${c.jobValue} at=${c.at} msg=${c.result.message.slice(0, 300)}`);

  const d = await replay("norecords");
  check("MUST-EXCLUDE replay: 'No records were returned' walks on — no notServed, the job value is typed",
    !d.result.data?.notServed && /20000|review/.test(`${d.jobValue} ${d.at}`), `notServed=${JSON.stringify(d.result.data?.notServed)} jobValue=${d.jobValue} at=${d.at} msg=${d.result.message.slice(0, 300)}`);
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} not-served check(s) FAILED.`); process.exit(1); }
console.log("\nAll not-served checks passed (real Chromium, replica portal).");
process.exit(0);
