// THE REVIEW PAGE: THE RUN'S OWN SAVE GOES THROUGH, THE PORTAL'S HELD-BACK CALLS ARE NAMED
// (dryrun-0928 B3 + B14), in real Chromium against a local fixture.
//
// B3 — PowerClerk batches the last page's answers into ONE save ~5 s after the first change; the
// review lockdown aborted it (each write's own-write window had closed 1.5 s after the write) and
// the page was handed over reading "Saving…". drainOwnWrites keeps the run's own same-origin save
// open while the page reads saving, before the lock and the hand-off.
//   MUST-PASS  drain        — a tick whose save fires 2.5 s later (after the write's window) reaches
//                              the server; the drain says it finished (stillSaving false).
//   CONTROL    noDrain      — the same tick with NO drain: the save is aborted by the lockdown (the
//                              defect, reproduced — proves the fixture exercises it).
//   MUST-EXCLUDE drainGuard — during the drain the page's script also posts to ANOTHER origin and
//                              submits a FORM (a document request): both aborted, only the save goes.
//   MUST-PASS  stuck        — a save that never completes: the drain ends at its budget and says so
//                              (stillSaving true) — the run's cue to warn by name.
//   MUST-PASS  replayTick   — the replay: a recorded certification tick on the review page, then
//                              stopForReview — the save reaches the server, no "may not be saved".
//   MUST-PASS  replayStuck  — the replay on a page whose save never completes: the hand-off says the
//                              answers MAY NOT BE SAVED.
// B11 — the real stage path (stageWithRecipe → runAdapter) reports the draft's reference read off
// the review page's URL: PowerClerk's ProjectId when present; the page link and NO id otherwise.
// B14 — the review page's own load-time PageMethod (Accela's CapConfirm DisplayRequired…) is still
// aborted, and the hand-off now names it.
//   MUST-PASS  replayOwnCall   — a same-origin POST at load: aborted, the run stays ok, and the
//                                hand-off names the path and says to reload (reached by GET).
//   MUST-EXCLUDE replayTracker — only a third-party tracker POST: aborted, NO hand-off line.
//
// Run: npx tsx portal-bot/src/reviewSaveDrain.dom.smoke.ts
import "./smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../shared/src/types";
import { RecipeAdapter } from "./adapters/recipeAdapter";
import { stageWithRecipe } from "./index";
import { drainOwnWrites, installFilingBackstop, withOwnWriteWindow } from "./filingBackstop";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
// The replay's drain budget: short enough for a smoke, far above the fixture's 2.5 s batch delay.
process.env.REVIEW_SAVE_DRAIN_MS = "6000";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const posts: string[] = [];
const otherPosts: string[] = [];
// A SECOND ORIGIN (another port): a third-party tracker's host.
const other = http.createServer((req, res) => {
  if (req.method !== "GET") otherPosts.push(new URL(req.url || "/", "http://x").pathname);
  res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
  res.end("ok");
});
await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
const OTHER = `http://127.0.0.1:${(other.address() as { port: number }).port}`;

const REVIEW_HEAD = `<h1>Step 5: Review and Submit</h1><p>Please review your application before submitting.</p>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET") {
    posts.push(url.pathname);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  if (url.pathname === "/reviewBatch") {
    // PowerClerk's shape: an indicator that reads "Saving..." from the first change until ONE batched
    // save XHR returns, D ms later. stuck=1: the save never completes. also=1: 1.9 s after the tick —
    // after the write's own 1.5 s window has closed, while only the DRAIN holds the page — the page
    // ALSO posts to another origin and submits a form (neither is the run's save).
    const d = Number(url.searchParams.get("d") || "2500");
    const stuck = url.searchParams.get("stuck") === "1";
    const alsoKind = url.searchParams.get("also") || "";
    // An aborted form navigation replaces the page with Chromium's error page (its timers die with
    // it), so the form and the cross-origin post are separate cells.
    const alsoJs = alsoKind === "form"
      ? "var f = document.createElement('form'); f.method = 'post'; f.action = '/Project/Finish'; document.body.appendChild(f); f.submit();"
      : alsoKind === "xorigin" ? `fetch('${OTHER}/event/tell', { method: 'POST', body: 'x=1' }).catch(function () {});` : "";
    const also = Boolean(alsoJs);
    res.end(`<!doctype html><html><body>${REVIEW_HEAD}
      <span data-test-role="project-save-state">Saved</span>
      <div><input type="checkbox" id="terms"> <label for="terms">I certify the information in this application is correct</label></div>
      <script>
        var st = document.querySelector("[data-test-role='project-save-state']"); var timer = null;
        document.getElementById('terms').addEventListener('change', function () {
          st.textContent = 'Saving...';
          ${also ? `setTimeout(function () { ${alsoJs} }, 1900);` : ""}
          if (timer) return;
          timer = setTimeout(function () {
            ${stuck ? "" : `fetch('/Project/SaveChanges3', { method: 'POST', body: 'terms=on' })
              .then(function () { st.textContent = 'Saved'; }).catch(function () { st.textContent = 'Save failed'; });`}
          }, ${d});
        });
      </script></body></html>`);
    return;
  }
  if (url.pathname === "/confirm") {
    // Accela's CapConfirm: the review page's own PageMethod POSTs on load (and a tracker posts too).
    const tp = url.searchParams.get("tp") === "1";
    res.end(`<!doctype html><html><body>${REVIEW_HEAD}<p>Licensed Professional</p>
      <script>setTimeout(function () {
        ${tp ? "" : "fetch('/Cap/CapConfirm.aspx/DisplayRequiredLicenseProfessionalType', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(function () {});"}
        fetch('${OTHER}/event/tell', { method: 'POST', body: 'x=1', mode: 'no-cors' }).catch(function () {});
      }, 150);</script></body></html>`);
    return;
  }
  // The page before review: a "Next" link to wherever the cell says.
  const to = url.searchParams.get("to") || "/reviewBatch";
  // The signed-in chrome the real stage path's login step looks for (approvedFinalSubmit's NAV).
  res.end(`<!doctype html><html><head><title>Portal</title></head><body><nav><a href="/account">My Account</a> <a href="/logout">Sign Out</a></nav><h1>Step 4: Contacts</h1><a id="next" href="${to}">Next</a></body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const NEXT = { action: "click", selector: { css: "#next", role: "link", name: "Next" }, note: "advance: Next" } as RecipeStep;
const TICK = { action: "check", selector: { css: "#terms", label: "I certify the information in this application is correct" }, note: "I certify the information in this application is correct" } as RecipeStep;
const recipe = (to: string, steps: RecipeStep[]): PortalRecipe => ({
  id: "drain-smoke", scopeType: "utility", profileKey: "or|x|u", state: "OR", ahj: "", utility: "U",
  portalPlatform: "fixture", portalUrl: `${base}/form?to=${encodeURIComponent(to)}`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "",
  steps: [{ action: "goto", value: `${base}/form?to=${encodeURIComponent(to)}`, note: "open" } as RecipeStep, NEXT, ...steps, { action: "stopForReview" } as RecipeStep],
} as unknown as PortalRecipe);

const browser = await chromium.launch();
try {
  const newPage = async () => {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(5000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    return { ctx, page: await ctx.newPage() };
  };

  // ── B3, the mechanism: drainOwnWrites on a backstopped review page ─────────────────────────────
  const tickThen = async (q: string, after: (page: import("playwright").Page) => Promise<unknown>) => {
    const { ctx, page } = await newPage();
    const bs = await installFilingBackstop(page, "drain smoke");
    await page.goto(`${base}/reviewBatch?${q}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    posts.length = 0; otherPosts.length = 0;
    await withOwnWriteWindow(page, "the run ticks the certification", () => page.check("#terms"));
    const out = await after(page);
    await page.waitForTimeout(300);
    const res = { out, posts: posts.slice(), otherPosts: otherPosts.slice(), aborts: (bs?.aborts ?? []).map((a) => `${a.rule} ${a.method} ${a.where.replace(base, "").replace(OTHER, "OTHER")} (${a.resourceType})`), drained: (bs?.drainRequests ?? []).map((w) => w.replace(base, "")) };
    await bs?.dispose();
    await ctx.close().catch(() => null);
    return res;
  };
  {
    const r = await tickThen("d=2500", (page) => drainOwnWrites(page, { budgetMs: 8000 }));
    const d = r.out as { drained: boolean; stillSaving: boolean; waitedMs: number };
    check("B3 MUST-PASS drain: the run's own batched save (2.5 s after the tick) reaches the server", r.posts.includes("/Project/SaveChanges3"), `posts=[${r.posts}] aborts=[${r.aborts.join("; ")}]`);
    check("B3 drain: it was the drain that let it through, and the drain saw the save finish", r.drained.includes("/Project/SaveChanges3") && d.drained && !d.stillSaving, JSON.stringify({ d, drained: r.drained }));
  }
  {
    const r = await tickThen("d=2500", (page) => page.waitForTimeout(3500));
    check("B3 CONTROL noDrain: without the drain the same save is aborted by the review lockdown (the defect, reproduced)", !r.posts.includes("/Project/SaveChanges3") && r.aborts.some((a) => /review-lockdown POST \/Project\/SaveChanges3/.test(a)), `posts=[${r.posts}] aborts=[${r.aborts.join("; ")}]`);
  }
  {
    const r = await tickThen("d=2500&also=form", (page) => drainOwnWrites(page, { budgetMs: 8000 }));
    check("B3 MUST-EXCLUDE drainGuard: a form the page submits during the drain is still aborted", !r.posts.includes("/Project/Finish") && r.aborts.some((a) => /\/Project\/Finish \(document\)/.test(a)), `posts=[${r.posts}] aborts=[${r.aborts.join("; ")}]`);
  }
  {
    const r = await tickThen("d=2500&also=xorigin", (page) => drainOwnWrites(page, { budgetMs: 8000 }));
    check("B3 MUST-EXCLUDE drainGuard: a post to another origin during the drain is still aborted", r.otherPosts.length === 0 && r.aborts.some((a) => /OTHER\/event\/tell/.test(a)), `other=[${r.otherPosts}] aborts=[${r.aborts.join("; ")}]`);
    check("B3 drainGuard: ...and the run's own save still went", r.posts.includes("/Project/SaveChanges3"), `posts=[${r.posts}] aborts=[${r.aborts.join("; ")}]`);
  }
  {
    const r = await tickThen("stuck=1", (page) => drainOwnWrites(page, { budgetMs: 1500 }));
    const d = r.out as { drained: boolean; stillSaving: boolean };
    check("B3 MUST-PASS stuck: a save that never completes ends the drain at its budget and says so", d.drained && d.stillSaving, JSON.stringify(d));
  }

  // ── The replay, end to end (RecipeAdapter.fillApplication + stopAtReview) ─────────────────────
  const replay = async (to: string, steps: RecipeStep[]) => {
    const { ctx, page } = await newPage();
    const adapter = new RecipeAdapter(recipe(to, steps), {}, {}, {} as never);
    (adapter as unknown as { page: unknown }).page = page;
    posts.length = 0; otherPosts.length = 0;
    let ok = false; let msg = "";
    try { const r = await adapter.fillApplication({} as ProjectRecord); ok = r.ok; msg = String(r.message ?? ""); }
    catch (e) { msg = `threw ${String(e).slice(0, 200)}`; }
    const review = await adapter.stopAtReview();
    await page.waitForTimeout(300);
    const res = { ok, msg, handoff: String(review.message ?? ""), data: (review.data ?? {}) as Record<string, unknown>, posts: posts.slice(), otherPosts: otherPosts.slice(), warnings: ((adapter as unknown as { driftWarnings: string[] }).driftWarnings ?? []).join(" | ") };
    await ctx.close().catch(() => null);
    return res;
  };
  {
    const r = await replay("/reviewBatch?d=2500", [TICK]);
    check("B3 MUST-PASS replayTick: the recorded certification tick's save reaches the server before the hand-off", r.posts.includes("/Project/SaveChanges3"), `ok=${r.ok} posts=[${r.posts}] ${r.msg.slice(0, 300)} || ${r.warnings.slice(0, 400)}`);
    check("B3 replayTick: the run stays ok and the hand-off does not claim unsaved answers", r.ok && !/MAY NOT BE SAVED/.test(r.handoff), `ok=${r.ok} ${r.handoff.slice(0, 300)}`);
  }
  {
    const r = await replay("/reviewBatch?stuck=1", [TICK]);
    check("B3 MUST-PASS replayStuck: a save still pending at hand-off is named in the hand-off", /MAY NOT BE SAVED/.test(r.handoff) && Array.isArray(r.data.reviewHandoffNotes), `${r.handoff.slice(0, 400)}`);
  }
  {
    const r = await replay("/confirm", []);
    check("B14 replayOwnCall: the review page's own PageMethod is still aborted (nothing sent)", !r.posts.includes("/Cap/CapConfirm.aspx/DisplayRequiredLicenseProfessionalType"), `posts=[${r.posts}]`);
    check("B14 replayOwnCall: a non-filing background call does not fail the run", r.ok, r.msg.slice(0, 300));
    check("B14 MUST-PASS replayOwnCall: the hand-off names the held-back call and says to reload (the page came by GET)",
      /\/Cap\/CapConfirm\.aspx\/DisplayRequiredLicenseProfessionalType were blocked/.test(r.handoff) && /reload the review page/.test(r.handoff),
      r.handoff.slice(0, 500));
    check("B14 replayOwnCall: the third-party tracker is not named as the portal's own", !/event\/tell/.test(r.handoff), r.handoff.slice(0, 500));
  }
  {
    const r = await replay("/confirm?tp=1", []);
    check("B14 MUST-EXCLUDE replayTracker: only a third-party tracker was held back — no hand-off line", r.ok && !/were blocked/.test(r.handoff) && r.otherPosts.length === 0, `ok=${r.ok} other=[${r.otherPosts}] ${r.handoff.slice(0, 300)}`);
  }

  // ── B11, the real stage path (index.ts runAdapter): the draft's reference off the review URL ──
  {
    const staged = await stageWithRecipe(recipe("/confirm?tp=1&ProjectId=TESTPROJ9&NewProject=1", []), { id: "p-drain" } as ProjectRecord, {}, {}, [], { headless: true });
    const ref = staged.draftReference as { link?: string; id?: string } | undefined;
    check("B11 MUST-PASS stage path: a run stopped at review reports the draft's own key (ProjectId) read off its URL",
      staged.ok === true && ref?.id === "TESTPROJ9" && /ProjectId=TESTPROJ9/.test(String(ref?.link)) && !/NewProject|tp=/.test(String(ref?.link)),
      JSON.stringify({ ok: staged.ok, ref, msg: [String(staged.message ?? ""), ...((staged.steps as Array<{ message?: unknown }> | undefined) ?? []).map((s) => String(s?.message ?? ""))].join(" | ").slice(0, 600) }));
    const plain = await stageWithRecipe(recipe("/confirm?tp=1", []), { id: "p-drain-2" } as ProjectRecord, {}, {}, [], { headless: true });
    const plainRef = plain.draftReference as { link?: string; id?: string } | undefined;
    check("B11 MUST-EXCLUDE stage path: a review URL with no record key reports the page link and NO invented id",
      plain.ok === true && plainRef?.id === "" && /\/confirm$/.test(String(plainRef?.link)), JSON.stringify({ ok: plain.ok, plainRef }));
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
  other.close();
}
if (failures) { console.error(`\n${failures} review-save-drain check(s) FAILED.`); process.exit(1); }
console.log("\nAll review-save-drain checks passed.");
process.exit(0);
