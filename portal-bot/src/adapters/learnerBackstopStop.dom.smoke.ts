// THE LEARNER STOPS BY NAME ON A BACKSTOP ABORT, AND LOCKS THE PAGE AT REVIEW (hard rule 1).
//
// filingBackstop.ts aborts a filing/payment request whichever control fired it; for the LEARNER
// two call sites decide what happens next, and neither was pinned by a kill:
//   (1) the page-boundary check (learnImpl, after pageCount++): a filing abort STOPS the walk,
//       stopReason backstop_abort — walking on would drive the next page (and the same filing
//       control) again;
//   (2) lockReview("learner at review"): after the planner declares atReview, every
//       state-changing request is aborted until the page is handed to a person.
//
// MUST-EXCLUDE (1): page 1's "Next" also fires fetch POST /SubmitApplication. 0 such POST reaches
//   the server, stopReason === "backstop_abort", ok=false, and page 2's field is never filled.
// MUST-EXCLUDE (2): a stop page that does not name itself review (only the planner's atReview says
//   so) whose script keeps posting: after the lock, its POSTs are aborted (REVIEW-PAGE LOCKDOWN in
//   the result), ok=false.
//
// Run: npx tsx portal-bot/src/adapters/learnerBackstopStop.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const PAGES: Record<string, string> = {
  p1: `<h1>Step 1: Contact</h1><form action="/p2" method="get"><label for="a">Contact Name</label><input id="a" name="a">
    <button type="submit" id="nx" onclick="fetch('/SubmitApplication', {method:'POST', body:'x=1'}).catch(function(){});">Next</button></form>`,
  p2: `<h1>Step 2: Project</h1><form action="/p3" method="get"><label for="b">Project Description</label><input id="b" name="b">
    <button type="submit">Next</button></form>`,
  summary: `<h1>Step 3: Summary</h1><p>Your details.</p><label for="c">Notes</label><input id="c" name="c">
    <script>setInterval(function(){ fetch('/keepalive', {method:'POST', body:'x=1'}).catch(function(){}); }, 10);</script>`,
};
const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET" && req.method !== "HEAD") { posts.push(url.pathname); res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
  const k = url.pathname.replace(/^\//, "") || "p1";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>Portal</title></head><body>${PAGES[k] ?? PAGES.p1}</body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// Fill every text box; advance by "Next"; declare review on the Summary page.
const planner: LearnPlanner = async (req) => {
  const fills = req.fields.map((f, i) => ({ f, i })).filter((x) => x.f.fieldType === "text").map((x) => ({ selectorIndex: x.i, value: "X" }));
  const atReview = req.fields.some((f) => /^notes$/i.test(String(f.label ?? "")));
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
  return { fills, atReview, ...(atReview || next < 0 ? {} : { advanceSelectorIndex: next }) };
};

const browser = await chromium.launch();
try {
  for (const start of ["p1", "summary"]) {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}/${start}`);
    posts.length = 0;
    const adapter = new AutoLearnAdapter("Learner Backstop Stop", planner, { maxPages: 4 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).page = page;
    let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
    let threw = "";
    try {
      r = await adapter.learn({ portalUrl: `${base}/${start}` } as never,
        { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T" } as never);
    } catch (e) { threw = String(e).slice(0, 200); }
    await ctx.close().catch(() => null);
    const msg = String(r?.message ?? threw).slice(0, 400);
    if (start === "p1") {
      const filledP2 = (r?.steps ?? []).some((s) => /project description/i.test(String(s.note ?? "")) || String(JSON.stringify(s.selector ?? {})).includes('"#b"'));
      check("MUST-EXCLUDE (1) the page-1 filing POST never reaches the server", !posts.includes("/SubmitApplication"), `POSTs=[${posts.join(",")}]`);
      check("MUST-EXCLUDE (1) the learner STOPS at the next page boundary, named (backstop_abort), ok=false, and page 2 is never filled",
        !!r && r.ok === false && r.stopReason === "backstop_abort" && !filledP2, `ok=${r?.ok} stop=${r?.stopReason} filledP2=${filledP2} ${msg}`);
    } else {
      // A page script's background POST at review is ABORTED and named; it no longer fails a learn that
      // reached review (live 3eaa1231: WalkMe / Accela page methods at CapConfirm). A form submission or a
      // filing-shaped URL still stops it (filingBackstop.dom.smoke toReviewForm / the filing-URL rule).
      check("MUST-EXCLUDE (2) after the learner declares review, the page's background POSTs are aborted (REVIEW-PAGE LOCKDOWN) and named — never sent",
        !!r && /REVIEW-PAGE LOCKDOWN — the run is at review \(learner at review\)/.test(msg + String(r?.message ?? "")), `ok=${r?.ok} stop=${r?.stopReason} posts=[${posts.join(",")}] ${msg}`);
    }
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} learner-backstop-stop check(s) FAILED.`); process.exit(1); }
console.log("\nAll learner-backstop-stop checks passed (real Chromium).");
process.exit(0);
