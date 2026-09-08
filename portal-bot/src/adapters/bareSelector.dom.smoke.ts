// A RECIPE CAN RECORD A SELECTOR AS BARE AS `{css: "select"}`.
//
// Coos Bay's attachment step does, on an Accela page holding `ddlAlsoAttachTo` ("Also Attach
// To") first and `ddlDocType` ("Document Type") second. Taking the first files the plan set
// under the wrong heading with nothing reported — the filing looks complete and is not.
//
// THE ANSWER WAS ON THE PAGE AND UNREACHABLE. The step is noted "attachment: document type";
// the portal names its control `ddlDocType`. But `resolveLocator` collapses to ONE element via
// preferVisible, and it never received the step — so nothing downstream could apply what the
// recipe plainly said. Two earlier attempts fixed the identity check and the narrowing, both
// of which run AFTER the collapse and therefore never ran at all: a probe at the call site
// showed `count=1` where the reasoning assumed 2. The step's words now reach the collapse.
//
// Scored, not first-past-the-post: every id on that page contains `Attachment_24Edit`, so
// "attachment" agrees with everything and only "document" discriminates. ("type" is stopped
// by IDENTITY_STOPWORDS, with a comment naming this very control — ACA labels it
// `*Type (Required):` — which is precisely why scoring beats first agreement.)
//   npx tsx portal-bot/src/adapters/bareSelector.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const PAGE = `<!doctype html><html><body>
  <label for="ctl00_PlaceHolderMain_Attachment_24Edit_ddlAlsoAttachTo">Also Attach To</label>
  <select id="ctl00_PlaceHolderMain_Attachment_24Edit_ddlAlsoAttachTo" name="ctl00$ddlAlsoAttachTo">
    <option>Select...</option><option>Record 1</option>
  </select>
  <label for="ctl00_PlaceHolderMain_Attachment_24Edit_ddlDocType">Document Type</label>
  <select id="ctl00_PlaceHolderMain_Attachment_24Edit_ddlDocType" name="ctl00$ddlDocType">
    <option>Select...</option><option>Plans</option>
  </select>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const run = async (note: string, value: string) => {
  const recipe = {
    id: "bs1", scopeType: "ahj", profileKey: "or|city of coos bay|x", state: "OR",
    ahj: "City of Coos Bay", utility: "", portalPlatform: "accela", portalUrl: url,
    status: "complete", version: 1,
    steps: [{ action: "select", phase: "fill", selector: { css: "select" }, value, note }] as unknown as RecipeStep[],
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
  } as unknown as PortalRecipe;
  const p = await context.newPage();
  await p.goto(url);
  const a = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
  (a as unknown as { page: unknown }).page = p;
  const res = await a.fillApplication({} as never);
  const docType = await p.locator("#ctl00_PlaceHolderMain_Attachment_24Edit_ddlDocType").inputValue().catch(() => "");
  const alsoAttach = await p.locator("#ctl00_PlaceHolderMain_Attachment_24Edit_ddlAlsoAttachTo").inputValue().catch(() => "");
  const drift = (res as unknown as { data?: { driftWarnings?: string[] } }).data?.driftWarnings ?? [];
  await p.close();
  return { docType, alsoAttach, drift };
};

const typed = await run("attachment: document type", "Plans");
console.log(`   docType=${JSON.stringify(typed.docType)} alsoAttachTo=${JSON.stringify(typed.alsoAttach)}`);

check("THE REGRESSION: a bare `select` resolves by the step's own words, not by position", () => {
  assert.equal(typed.docType, "Plans", "the first control was taken and the named one never chosen");
});

check("...and the control it was NOT asked for is untouched", () => {
  assert.equal(typed.alsoAttach, "Select...",
    `"Also Attach To" was written with the document type (${JSON.stringify(typed.alsoAttach)})`);
});

check("...and it says it went by name rather than position, so the bare recipe can be re-recorded", () => {
  assert.ok(typed.drift.some((w) => /names for it, not the first/i.test(w)), JSON.stringify(typed.drift));
});

// The older guard, unchanged: a recorded label agreeing with NOTHING is SKIPPED rather than
// written into a control it does not describe. A document type in "Also Attach To" is worse
// than one left for a human.
const vague = await run("choose the thing", "Record 1");
check("a note agreeing with nothing is still SKIPPED, not filled into the wrong control", () => {
  assert.equal(vague.alsoAttach, "Select...", `it wrote into an unmatched control: ${JSON.stringify(vague)}`);
});

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} bare-selector check(s) FAILED.`); process.exit(1); }
console.log("\nAll bare-selector checks passed (real Chromium).");
process.exit(0);
