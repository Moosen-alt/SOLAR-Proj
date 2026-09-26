// THE OVERLAY DISMISSER MAY NOT ANSWER A FILING OR PAYING DIALOG (hard rule 1).
//
// dismissPageModals runs before every click/goto/check step of a replay and on every retry, and
// at the top of every learner page. Its list reaches `[role="dialog"] button` (the FIRST button
// of any dialog) and a bare `:text-is("OK")`. The replay skeptic's local fixture (modal-probe.log):
// a Bootstrap confirm whose first button is "Submit Application", and a confirm "You are about to
// submit your application" whose button is a bare OK — each FILED four times with
// PORTAL_ALLOW_FINAL_SUBMIT unset and no approval, because the dismisser clicked outside
// guardAction.
//
// MUST-EXCLUDE: both dialogs (and a pay-worded one) -> 0 POSTs, a named refusal, in replay AND
//   when the learner-side dismisser (no chokepoint callback) runs on its own.
// MUST-PASS: a cookie dialog's OK and a "What's new?" popover's Got it are still dismissed, and the
//   recipe advances past them.
//
// Run: npx tsx portal-bot/src/adapters/replayModalGuard.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { dismissPageModals } from "./autoLearnAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const posts: string[] = [];
const box = `class="modal show" role="dialog" style="display:block;position:fixed;top:10px;left:10px;width:420px;background:#fff;border:1px solid #000;padding:10px;z-index:50"`;
const MODALS: Record<string, string> = {
  // A Bootstrap confirm whose FIRST button files.
  dialogSubmit: `<div ${box}><p>Ready to file this application with the city?</p>
     <form method="post" action="/submit?via=dialogSubmit"><button type="submit">Submit Application</button></form>
     <button type="button" onclick="this.closest('.modal').remove()">Cancel</button></div>`,
  // A confirm whose button is a bare OK.
  dialogOk: `<div ${box}><p>You are about to submit your application. This cannot be undone.</p>
     <form method="post" action="/submit?via=dialogOk"><button type="submit">OK</button></form>
     <button type="button" onclick="this.closest('.modal').remove()">Cancel</button></div>`,
  // A fee confirm answered by Yes.
  dialogPay: `<div ${box}><p>A plan review charge of $120.00 is due. Proceed to payment?</p>
     <form method="post" action="/submit?via=dialogPay"><button type="submit">Yes</button></form></div>`,
  // MUST-PASS: a cookie notice whose OK only closes it.
  cookieOk: `<div ${box}><p>This site uses cookies to remember your preferences.</p>
     <button type="button" onclick="this.closest('.modal').remove()">OK</button></div>`,
  // MUST-PASS: an announcement popover.
  gotIt: `<div class="popover" style="position:fixed;top:10px;left:10px;background:#fff;border:1px solid #999;padding:10px;z-index:50">
     <strong>What's new?</strong> You can now submit documents faster. <button type="button" onclick="this.closest('.popover').remove()">Got it</button></div>`,
  none: "",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "POST") {
    posts.push(url.searchParams.get("via") || url.pathname);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><h1>Submitted</h1><p>Record Number: FER-26-000999-ELE</p></body></html>");
    return;
  }
  if (url.pathname === "/next") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><h1>Step 4: Additional Information</h1><input id='x' aria-label='Notes'></body></html>");
    return;
  }
  const m = url.searchParams.get("modal") || "none";
  res.writeHead(200, { "content-type": "text/html" });
  // The Next link sits well below the dialog: the dialog is not in the way of the click, so a
  // refusal costs nothing and the recipe advances.
  res.end(`<!doctype html><html><head><title>Portal</title></head><body><h1>Step 3: Contacts</h1>
    <label for="nm">Contact Name</label><input id="nm">
    <div style="margin-top:420px"><a id="next" href="/next">Next</a></div>${MODALS[m] ?? ""}</body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const recipe = (m: string): PortalRecipe => ({
  id: "modal-guard", scopeType: "ahj", profileKey: "or|x|", state: "OR", ahj: "X", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/form?modal=${m}`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/form?modal=${m}`, note: "open" },
    { action: "click", selector: { css: "#next", role: "link", name: "Next" }, note: "advance: Next" } as RecipeStep,
    { action: "stopForReview" },
  ],
} as unknown as PortalRecipe);

const browser = await chromium.launch();
try {
  // ---- REPLAY (the dismisser's clicks go through guardAction) ----
  for (const m of ["dialogSubmit", "dialogOk", "dialogPay", "cookieOk", "gotIt"]) {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    const adapter = new RecipeAdapter(recipe(m), {}, {}, {} as never);
    (adapter as unknown as { page: unknown }).page = page;
    posts.length = 0;
    let ok = false;
    let msg = "";
    try { const r = await adapter.fillApplication({} as ProjectRecord); ok = r.ok; msg = String(r.message).slice(0, 160); }
    catch (e) { msg = `threw ${String(e).slice(0, 160)}`; }
    const onNext = /\/next$/.test(page.url());
    const modalLeft = await page.locator(".modal, .popover").count().catch(() => -1);
    await ctx.close();
    const refusals = adapter.guardRefusals.join(" | ");
    if (m === "cookieOk" || m === "gotIt") {
      check(`MUST-PASS replay/${m}: the overlay is dismissed, no POST, and the recipe advances`,
        posts.length === 0 && ok && onNext && modalLeft === 0,
        `posts=${posts.length} ok=${ok} onNext=${onNext} overlaysLeft=${modalLeft} refusals=${refusals} ${msg}`);
    } else {
      check(`MUST-EXCLUDE replay/${m}: no filing/paying POST`, posts.length === 0, `POSTs=[${posts.join(",")}] ${msg}`);
      check(`MUST-EXCLUDE replay/${m}: the refusal is named in the run's refusals`,
        /dismisser refused/.test(refusals) && /(submit|filing|pay)/i.test(refusals), `refusals=${refusals || "(none)"}`);
      check(`replay/${m}: the recipe still advances (the dialog was not in the way)`, ok && onNext, `ok=${ok} onNext=${onNext} ${msg}`);
    }
  }

  // ---- LEARNER-SIDE (no chokepoint callback: the in-page predicate alone) ----
  for (const m of ["dialogSubmit", "dialogOk", "dialogPay", "cookieOk"]) {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}/form?modal=${m}`);
    posts.length = 0;
    const r = await dismissPageModals(page);
    await page.waitForTimeout(300);
    const left = await page.locator(".modal").count().catch(() => -1);
    await ctx.close();
    if (m === "cookieOk") {
      check(`MUST-PASS learner/${m}: dismissed with no POST`, posts.length === 0 && left === 0 && r.dismissed.length > 0,
        `posts=${posts.length} left=${left} dismissed=${r.dismissed.join(",")} refused=${r.refused.join(" | ")}`);
    } else {
      check(`MUST-EXCLUDE learner/${m}: 0 POSTs and a named refusal`, posts.length === 0 && r.refused.some((x) => /(submit|filing|pay)/i.test(x)),
        `POSTs=[${posts.join(",")}] refused=${r.refused.join(" | ") || "(none)"}`);
    }
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} replay-modal-guard check(s) FAILED.`); process.exit(1); }
console.log("\nAll replay-modal-guard checks passed (real Chromium).");
process.exit(0);
