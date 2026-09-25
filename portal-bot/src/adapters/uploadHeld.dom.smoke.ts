// AN EMPTY FILE BOX IS NOT A MISSING DOCUMENT — replayed uploads in real Chromium against the
// synthetic Accela replica (127.0.0.1 only).
//
// A browser never restores a file input's value, so once Accela's Save posts the upload back
// the required "Plans - Construction" box reads EMPTY beside the portal's own "Uploaded: <file>".
// The blank sweep reported that as "1 required field(s) would not stay filled ... need entering
// by hand" on every Accela scoreboard replay whose server held the plan set (after.json:
// accela/base 19/19 fields, rung replayed_with_gaps).
//
//   MUST-PASS     upload + Save + advance: the server holds the document and the run reports
//                 NO required field left blank.
//   MUST-EXCLUDE  A. no upload step: the empty required slot IS reported.
//                 B. upload performed, but the page does not list the file afterwards (the portal
//                    dropped it): the slot IS reported — the discharge needs the page's own word.
//
//   npx tsx portal-bot/src/adapters/uploadHeld.dom.smoke.ts
import { chromium, type Page } from "playwright";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
// Every artifact this smoke's replays write goes to a temp folder, never data/.
const SMOKE_ARTIFACTS = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "replay-smoke-"));
process.env.REPLAY_CAPTURE_DIR = SMOKE_ARTIFACTS;
process.env.REPLAY_RUN_DIR = nodePath.join(SMOKE_ARTIFACTS, "runs");
process.env.PORTAL_SCREENSHOT_DIR = nodePath.join(SMOKE_ARTIFACTS, "screenshots");
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { buildWizard } from "../replica/fixtures/wizards";
import { startSyntheticReplica } from "../replica/syntheticServer";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const recipeOf = (base: string, steps: RecipeStep[]): PortalRecipe => ({
  id: "upload-held-smoke", scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "accela", portalUrl: `${base}/CitizenAccess/Default.aspx`, status: "complete", version: 1,
  steps, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
});
const pdf = nodePath.join(SMOKE_ARTIFACTS, "B-plan-set.pdf");
nodeFs.writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");

// The recorded shape of the learned Accela recipe's attachment page (reuse-accela-base.json).
const UPLOAD: RecipeStep = { action: "upload", selector: { css: "[data-al-upl=\"f0\"]" }, docType: "plan_set", viaFileChooser: false, note: "upload plan_set: Plans - Construction" };
const SAVE: RecipeStep = { action: "click", selector: { role: "link", name: "Save", exact: true, fallbacks: [{ css: "a[id*='btnSave' i]" }, { role: "button", name: "Save", exact: true }] }, note: "attachment: save (commits the upload)" };
const ADVANCE: RecipeStep = { action: "click", selector: { role: "link", name: "Continue Application »", exact: true, fallbacks: [{ css: "#ctl00_PlaceHolderMain_actionBarBottom_btnContinue" }] }, note: "advance: Continue Application »" };

const browser = await chromium.launch();
async function run(name: string, steps: (attach: string) => RecipeStep[], opts: { hideListing?: boolean } = {}) {
  const w = buildWizard("accela", "base");
  const r = await startSyntheticReplica({ wizard: w });
  const attach = w.pages.find((p) => /attachments/i.test(p.heading))!;
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page: Page = await ctx.newPage();
  if (opts.hideListing) {
    // The portal took the POST but lists nothing afterwards: strip its "Uploaded:" line.
    await page.route("**/CitizenAccess/Cap/**", async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(/<div class="ACA_FileName">[\s\S]*?<\/div>/g, "");
      await route.fulfill({ response: res, body });
    });
  }
  const adapter = new RecipeAdapter(recipeOf(r.base, [
    { action: "goto", value: `${r.base}/CitizenAccess/Cap/${attach.slug}`, note: "resume the application" },
    ...steps(attach.slug),
  ]), {}, { plan_set: pdf });
  (adapter as unknown as { page: unknown }).page = page;
  const result = await adapter.fillApplication({} as ProjectRecord);
  const data = (result.data ?? {}) as { requiredStillEmpty?: string[]; driftWarnings?: string[]; agingNotes?: string[] };
  const out = {
    result, data,
    stillEmpty: (data.requiredStillEmpty ?? []).join(" | "),
    drift: (data.driftWarnings ?? []).join(" | "),
    aging: (data.agingNotes ?? []).join(" | "),
    serverDoc: String(r.state.values["attach.plans"] ?? ""),
    submitPosts: r.state.submitPosts.length,
  };
  console.log(`  [${name}] ok=${result.ok} stillEmpty=[${out.stillEmpty.slice(0, 120)}]`);
  await ctx.close();
  await r.close();
  return out;
}

console.log("\n1. MUST-PASS: upload + Save + advance — the server holds the plan set, nothing is reported blank");
{
  const o = await run("uploaded", () => [UPLOAD, SAVE, ADVANCE, { action: "stopForReview" }]);
  check("the server holds the uploaded plan set", /plan-set\.pdf/i.test(o.serverDoc), `server attach.plans="${o.serverDoc}"`);
  check("no required field reported blank", !/Plans - Construction/i.test(o.stillEmpty), o.stillEmpty);
  check("no 'would not stay filled' warning", !/would not stay filled/i.test(o.drift), o.drift.slice(0, 300));
  check("the held upload is noted (aging), not silently dropped", /file box reads empty.*lists the uploaded file/i.test(o.aging), o.aging.slice(0, 300));
  check("no filing POST", o.submitPosts === 0);
}

console.log("\n2. MUST-EXCLUDE A: no upload step — the empty required slot IS reported");
{
  const o = await run("no-upload", () => [SAVE, { action: "stopForReview" }]);
  check("the server holds no document", !o.serverDoc, `server attach.plans="${o.serverDoc}"`);
  check("Plans - Construction is reported blank", /Plans - Construction/i.test(o.stillEmpty), `stillEmpty=[${o.stillEmpty}]`);
}

console.log("\n3. MUST-EXCLUDE B: uploaded, but the page does not list the file — the slot IS reported");
{
  const o = await run("unlisted", () => [UPLOAD, SAVE, { action: "stopForReview" }], { hideListing: true });
  check("Plans - Construction is reported blank", /Plans - Construction/i.test(o.stillEmpty), `stillEmpty=[${o.stillEmpty}] aging=${o.aging.slice(0, 200)}`);
}

await browser.close();
if (failures) { console.error(`\nuploadHeld: ${failures} check(s) FAILED`); process.exit(1); }
console.log("\nuploadHeld: all checks passed (real Chromium, synthetic replica)");
