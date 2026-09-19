// THE PRODUCTION REOPEN, DRIVEN END-TO-END IN A REAL BROWSER.
//
// correctionForm.dom.smoke.ts proves the CHOOSER; this proves the PRODUCTION CALLER —
// portal-bot/src/index.ts runCorrectionReopen → RecipeAdapter.reopenSuspendedFiling —
// against a replica portal shaped like PowerClerk's captured structure (applications
// list → project landing page → Current Forms → reopened wizard).
//
// What must hold, per the correction-continuation contract:
//   1. THE BOUND FILING ID decides which project is opened — exact match, never a
//      prefix, never "the first application in the list".
//   2. The named correction form is chosen and clicked; the CANCELLATION form beside
//      it (byte-identical button) is never touched. After a successful resubmission
//      (correction form View-only, cancellation is the only Begin) the run REFUSES.
//   3. Ambiguity (two correction-shaped forms) refuses with the candidates listed —
//      needs-human, never a guess, and nothing is clicked.
//   4. Revised documents stage through the attach-time gate (beforeUpload) — and a
//      gate that throws STOPS the attach and is reported, never swallowed.
//   5. finalSubmitClicked is false on every path; the wizard's own Submit control is
//      never clicked.
//
// Run: npx tsx portal-bot/src/adapters/correctionReopen.dom.smoke.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { PortalRecipe } from "../../../shared/src/types";
import { runCorrectionReopen } from "../index";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Every request the replica serves, so "never clicked" is proven by the server's own log.
const hits: string[] = [];

// A "Sign out" link on every page: the shared login flow reads it as the positive
// signed-in signal, so the production login path passes without a credential.
const CHROME = `<a href="/logout">Sign out</a>`;

// The applications LIST — the number is the link into each filing, exactly like the live
// portal. APP-1116 exists ALONGSIDE APP-111681 so a substring match would be ambiguous:
// only exact-text resolution opens the right project.
const LANDING = `<!doctype html><html><body>${CHROME}
  <h1>My Applications</h1>
  <table><tbody>
    <tr><td><a href="/app/111681">APP-111681</a></td><td>Suspended - Changes Needed From Customer</td></tr>
    <tr><td><a href="/app/1116">APP-1116</a></td><td>Suspended - Changes Needed From Customer</td></tr>
    <tr><td><a href="/app/333333">APP-333333</a></td><td>Suspended</td></tr>
    <tr><td><a href="/app/444444">APP-444444</a></td><td>Resubmitted</td></tr>
  </tbody></table>
</body></html>`;

// A suspended filing's landing page: the correction form and the cancellation form,
// adjacent, same table, byte-identical Begin controls — only the NAME separates them.
const projectPage = (appNo: string, correctionHref: string, cancelHref: string): string => `<!doctype html><html><body>${CHROME}
  <h1>Project ${appNo}</h1>
  <div class="card">
    <div class="card-header">Current Forms</div>
    <table><tbody>
      <tr><td>PP - Suspended - Changes Needed From Customer
        <a class="btn" href="${correctionHref}" style="display:inline-block;height:26px;width:70px">Begin</a></td><td>New Form</td></tr>
      <tr><td>PP - Cancellation Form
        <a class="btn" href="${cancelHref}" style="display:inline-block;height:26px;width:70px">Begin</a></td><td>New Form</td></tr>
    </tbody></table>
  </div>
</body></html>`;

// Two correction-shaped forms: the portal is offering a choice this code cannot make.
const AMBIGUOUS = `<!doctype html><html><body>${CHROME}
  <h1>Project APP-333333</h1>
  <div class="card">
    <div class="card-header">Current Forms</div>
    <table><tbody>
      <tr><td>Suspended - Changes Needed (Electrical)
        <a class="btn" href="/form/wrong-guess" style="display:inline-block;height:26px;width:70px">Begin</a></td><td>New Form</td></tr>
      <tr><td>Suspended - Changes Needed (Structural)
        <a class="btn" href="/form/wrong-guess" style="display:inline-block;height:26px;width:70px">Begin</a></td><td>New Form</td></tr>
    </tbody></table>
  </div>
</body></html>`;

// THE DANGEROUS STATE — after a successful resubmission the correction form is View-only
// and the ONLY Begin button left on the page is the cancellation form.
const SUBMITTED = `<!doctype html><html><body>${CHROME}
  <h1>Project APP-444444</h1>
  <div class="card">
    <div class="card-header">Current Forms</div>
    <table><tbody>
      <tr><td>PP - Cancellation Form
        <a class="btn" href="/form/cancel" style="display:inline-block;height:26px;width:70px">Begin</a></td><td>New Form</td></tr>
    </tbody></table>
  </div>
  <div class="card">
    <div class="card-header">Previously Submitted Forms</div>
    <table><tbody>
      <tr><td>PP - Suspended - Changes Needed From Customer
        <a class="btn" href="/form/view" style="display:inline-block;height:26px;width:70px">View</a></td><td>Submitted</td></tr>
    </tbody></table>
  </div>
</body></html>`;

// The REOPENED wizard: the original application, an upload slot for the revised document,
// and the portal's own resubmit control — which automation must never click.
const REOPENED = `<!doctype html><html><body>${CHROME}
  <h1>PP - Suspended - Changes Needed From Customer</h1>
  <p>Reviewer notes: provide the revised one-line diagram.</p>
  <div class="form-group">
    <label for="upl1">One-Line Diagram</label>
    <input type="file" id="upl1">
  </div>
  <a class="btn" href="/submitted" style="display:inline-block;height:26px;width:90px">Submit</a>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = req.url || "";
  hits.push(u);
  res.writeHead(200, { "content-type": "text/html" });
  if (u.startsWith("/app/111681")) return res.end(projectPage("APP-111681", "/form/correction-111681", "/form/cancel"));
  if (u.startsWith("/app/1116")) return res.end(projectPage("APP-1116", "/form/correction-1116", "/form/cancel"));
  if (u.startsWith("/app/333333")) return res.end(AMBIGUOUS);
  if (u.startsWith("/app/444444")) return res.end(SUBMITTED);
  if (u.startsWith("/form/correction")) return res.end(REOPENED);
  if (u.startsWith("/form/")) return res.end(`<!doctype html><html><body>${CHROME}<h1>WRONG FORM OPENED</h1></body></html>`);
  return res.end(LANDING);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// The same shell recipe the backend seam builds for a portal with no recorded recipe:
// zero steps, "recording" status, only the portal URL and the authority's name.
const recipe = {
  id: "correction-reopen-smoke", scopeType: "utility", profileKey: "", state: "OR", ahj: "",
  utility: "Pacific Power", portalPlatform: "powerclerk", portalUrl: `${base}/landing`,
  status: "recording", version: 1, steps: [], createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
} as unknown as PortalRecipe;

// A real file for the attach gate to approve.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-reopen-smoke-"));
const sldPath = path.join(tmpDir, "one-line-diagram.pdf");
fs.writeFileSync(sldPath, "%PDF-1.4\n% smoke fixture\n%%EOF\n");

// ---------------------------------------------------------------------------
// 1. Happy path: bound filing opened, correction form (not cancellation) clicked,
//    revised doc staged through the gate, automation stops.
// ---------------------------------------------------------------------------
const gateCalls: Array<[string, string]> = [];
const r1 = await runCorrectionReopen(recipe, "APP-111681", { sld: sldPath }, {
  headless: true,
  beforeUpload: (docType, file) => { gateCalls.push([docType, file]); },
});
console.log(`   happy path: ok=${r1.ok} form=${JSON.stringify(r1.reopenedForm)} attached=${r1.attachedDocs}`);

check("the reopen succeeds on the bound filing", () => {
  assert.equal(r1.ok, true, String(r1.message));
});
check("THE CHOICE: the correction form was opened, the cancellation form never touched", () => {
  assert.ok(hits.some((h) => h.startsWith("/form/correction-111681")), `hits: ${hits.join(" ")}`);
  assert.ok(!hits.some((h) => h.startsWith("/form/cancel")), "the CANCELLATION form was clicked — that ends the customer's interconnection");
  assert.match(String(r1.reopenedForm), /Suspended - Changes Needed/i);
});
check("the BOUND id decided the project: APP-111681 exactly, not the APP-1116 prefix row", () => {
  assert.ok(hits.some((h) => h.startsWith("/app/111681")), `hits: ${hits.join(" ")}`);
  assert.ok(!hits.some((h) => h.startsWith("/app/1116") && !h.startsWith("/app/111681")), "the prefix filing APP-1116 was opened instead of the bound one");
});
check("the revised document staged THROUGH the attach-time gate", () => {
  assert.equal(Number(r1.attachedDocs), 1, `attachedDocs=${r1.attachedDocs} (message: ${r1.message})`);
  assert.deepEqual(gateCalls[0], ["sld", sldPath], `gate saw: ${JSON.stringify(gateCalls)}`);
});
check("automation STOPPED: no final submit, and the wizard's Submit was never clicked", () => {
  assert.equal(r1.finalSubmitClicked, false);
  assert.ok(!hits.some((h) => h.startsWith("/submitted")), "the wizard's own Submit control was clicked");
});
check("the choice is explained (a filing is never reopened for an unreadable reason)", () => {
  assert.match(String(r1.reopenWhy ?? r1.message), /reopens this filing|correction/i);
});

// ---------------------------------------------------------------------------
// 2. Exact binding the other way round: the SHORT number must open ITS OWN filing,
//    even though a longer application number contains it.
// ---------------------------------------------------------------------------
hits.length = 0;
const r2 = await runCorrectionReopen(recipe, "APP-1116", { }, { headless: true });
check("a short application number opens its own filing, never a longer lookalike", () => {
  assert.equal(r2.ok, true, String(r2.message));
  assert.ok(hits.some((h) => h === "/app/1116" || h.startsWith("/app/1116?")), `hits: ${hits.join(" ")}`);
  assert.ok(hits.some((h) => h.startsWith("/form/correction-1116")), `hits: ${hits.join(" ")}`);
  assert.ok(!hits.some((h) => h.startsWith("/app/111681")), "APP-111681 was opened for a reopen bound to APP-1116");
});

// ---------------------------------------------------------------------------
// 3. A filing that is NOT on the portal: needs-human, nothing clicked.
// ---------------------------------------------------------------------------
hits.length = 0;
const r3 = await runCorrectionReopen(recipe, "APP-999999", {}, { headless: true });
check("an absent filing is a NEEDS-HUMAN refusal, never a guess", () => {
  assert.equal(r3.ok, false);
  assert.equal(r3.needsHuman, true, String(r3.message));
  assert.match(String(r3.message), /does not appear/i);
  assert.ok(!hits.some((h) => h.startsWith("/form/") || h.startsWith("/app/")), `something was clicked: ${hits.join(" ")}`);
});

// ---------------------------------------------------------------------------
// 4. Two correction-shaped forms: refuse with the candidates listed; click nothing.
// ---------------------------------------------------------------------------
hits.length = 0;
const r4 = await runCorrectionReopen(recipe, "APP-333333", {}, { headless: true });
check("ambiguity refuses with the candidates listed — needs-human, no click", () => {
  assert.equal(r4.ok, false);
  assert.equal(r4.needsHuman, true, String(r4.message));
  assert.equal((r4.offeredForms as string[]).length, 2, JSON.stringify(r4.offeredForms));
  assert.ok(!hits.some((h) => h.startsWith("/form/")), `a form was opened despite the ambiguity: ${hits.join(" ")}`);
});

// ---------------------------------------------------------------------------
// 5. THE REGRESSION THAT MATTERS — after a successful resubmission, the only Begin
//    button left is the cancellation form. Nothing may be chosen.
// ---------------------------------------------------------------------------
hits.length = 0;
const r5 = await runCorrectionReopen(recipe, "APP-444444", {}, { headless: true });
check("post-resubmission: the interconnection is NOT cancelled", () => {
  assert.equal(r5.ok, false);
  assert.equal(r5.needsHuman, true, String(r5.message));
  assert.match(String(r5.message), /cancel|withdraw/i);
  assert.ok(!hits.some((h) => h.startsWith("/form/cancel")), "the cancellation form was clicked at exactly the moment the work went right");
});

// ---------------------------------------------------------------------------
// 6. The attach-time gate REFUSES (document changed under the run): the reopen stands,
//    the attach stops, and the stop is REPORTED — never swallowed.
// ---------------------------------------------------------------------------
hits.length = 0;
const r6 = await runCorrectionReopen(recipe, "APP-111681", { sld: sldPath }, {
  headless: true,
  beforeUpload: () => { throw new Error("The sld document changed or no longer matches this permit path. Rebuild and restart the run."); },
});
check("a gate refusal stops the attach and is reported on the result", () => {
  assert.equal(r6.ok, true, String(r6.message));
  assert.equal(Number(r6.attachedDocs), 0, `attachedDocs=${r6.attachedDocs}`);
  assert.equal(r6.attachGateStopped, true, "the gate stop must be surfaced, not swallowed");
  assert.match(String(r6.message), /attach-time gate/i);
});

await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} correction-reopen check(s) FAILED.`); process.exit(1); }
console.log("\nAll correction-reopen checks passed (real Chromium, production runner, replica portal).");
process.exit(0);
