// COMMIT + READ-BACK, AND THE REPEATED LABEL — replayed fills in real Chromium against the
// synthetic replicas (127.0.0.1 only).
//
//   1. AUTOPOSTBACK, ONE AT A TIME (Accela-shaped UpdatePanel). Choosing Occupancy fires an async
//      postback that re-renders the panel from the values AS POSTED ~0.7 s later. A field typed
//      while it is in flight is overwritten — and a read-back taken the instant after typing
//      called it held. Every fill/select is now committed (blur) and SETTLED on the page's own
//      PageRequestManager before the next starts.
//      MUST-PASS  the module count typed after Occupancy is still there once the postback landed.
//   2. PER-FIELD AUTOSAVE (PowerClerk-shaped): Name, Phone (masked, typed key by key), Company all
//      reach the SERVER whole.
//   3. THE REPEATED LABEL: "Name *" in the installer block AND the electrical-contractor block,
//      recorded label-first with an id fallback (the real recipe's shape).
//      MUST-PASS    each name lands in its own block.
//      MUST-EXCLUDE the electrician's name in the installer's box (the scoreboard's
//                   inst.name wrong_box).
//
//   npx tsx portal-bot/src/adapters/replayCommit.dom.smoke.ts
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

const browser = await chromium.launch();
const recipeOf = (scopeType: "ahj" | "utility", portalUrl: string, steps: RecipeStep[]): PortalRecipe => ({
  id: "commit-smoke", scopeType, profileKey: "or||cascadia", state: "OR", ahj: "City of Fernhollow", utility: "Cascadia Power",
  portalPlatform: "fixture", portalUrl, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps,
});
async function replay(page: Page, recipe: PortalRecipe, values: Record<string, string>) {
  const adapter = new RecipeAdapter(recipe, values, {});
  (adapter as unknown as { page: unknown }).page = page;
  return adapter.fillApplication({} as ProjectRecord);
}
async function newPage(): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  return ctx.newPage();
}

console.log("\n1. AUTOPOSTBACK: a field typed after an autopostback select survives the postback");
{
  const w = buildWizard("accela", "base");
  const r = await startSyntheticReplica({ wizard: w });
  const ai = w.pages.find((p) => /additional information/i.test(p.heading))!;
  const page = await newPage();
  const result = await replay(page, recipeOf("ahj", `${r.base}/CitizenAccess/Default.aspx`, [
    { action: "goto", value: `${r.base}/CitizenAccess/Cap/${ai.slug}`, note: "open the page" },
    { action: "select", selector: { label: "Occupancy Type:" }, note: "Occupancy Type:", value: "Single Family Dwelling" },
    { action: "fill", selector: { label: "Total Number of Modules:" }, note: "Total Number of Modules:", field: "moduleQuantity" },
    { action: "stopForReview" },
  ]), { moduleQuantity: "18" });
  await page.waitForTimeout(w.delays.postback + 800); // any postback still in flight lands
  const modules = await page.locator("input[id$='AppSpecInfo_ASI_1_2']").inputValue().catch(() => "");
  const occ = await page.locator("select[id$='AppSpecInfo_ASI_1_3']").inputValue().catch(() => "");
  check("Occupancy held through its own postback", occ === "SFD", `occupancy=${occ}`);
  check("MUST-PASS: the module count typed after it survived the postback", modules === "18", `modules="${modules}" ok=${result.ok} ${String(result.message).slice(0, 160)}`);
  await page.context().close();
  await r.close();
}

console.log("\n2. PER-FIELD AUTOSAVE + 3. THE REPEATED LABEL (PowerClerk installer page)");
{
  const w = buildWizard("powerclerk", "base");
  const r = await startSyntheticReplica({ wizard: w, credential: { username: "u1", password: "p1" } });
  const inst = w.pages.find((p) => /installer information/i.test(p.heading))!;
  const page = await newPage();
  await page.goto(r.entryUrl);
  await page.fill("#UserName", "u1");
  await page.fill("#Password", "p1");
  await Promise.all([page.waitForURL(/Dashboard/), page.click("#btnSignIn")]);
  const values = { installerContactName: "Philippa Ashgrove", installerPhone: "541-555-0199", installerCompanyName: "Kestrel Energy LLC", electricalSupervisorName: "Ines Coldharbour" };
  const result = await replay(page, recipeOf("utility", `${r.base}/Dashboard`, [
    { action: "goto", value: `${r.base}/${inst.slug}`, note: "open the page" },
    // The shapes the learn records: label first, the render-order id as a fallback.
    { action: "fill", selector: { label: "Name *", fallbacks: [{ css: "#pcInputBase30" }] }, note: "Name *", field: "installerContactName" },
    { action: "fill", selector: { label: "Company *", fallbacks: [{ css: "#pcInputBase31" }] }, note: "Company *", field: "installerCompanyName" },
    { action: "fill", selector: { label: "Phone *", fallbacks: [{ css: "#pcInputBase33" }] }, note: "Phone *", field: "installerPhone" },
    { action: "fill", selector: { label: "Name *", fallbacks: [{ css: "#pcInputBase40" }] }, note: "Name *", field: "electricalSupervisorName" },
    { action: "stopForReview" },
  ]), values);
  await page.waitForTimeout(w.delays.autosave + w.delays.rerender + 400); // let any last re-render land
  const s = r.state.values;
  check("2. Company reached the server", s["inst.company"] === values.installerCompanyName, JSON.stringify(s));
  check("2. Phone reached the server WHOLE", String(s["inst.phone"] ?? "").replace(/\D/g, "") === "5415550199", `inst.phone=${JSON.stringify(s["inst.phone"])}`);
  check("3. MUST-PASS: the installer contact is in the installer's Name box", s["inst.name"] === values.installerContactName, `inst.name=${JSON.stringify(s["inst.name"])}`);
  check("3. MUST-PASS: the supervising electrician is in the electrical contractor's Name box", s["elec.name"] === values.electricalSupervisorName, `elec.name=${JSON.stringify(s["elec.name"])}`);
  check("3. MUST-EXCLUDE: the electrician's name is NOT in the installer's box", s["inst.name"] !== values.electricalSupervisorName);
  check("the run reports no unverified field", result.ok === true && ((result.data as { fieldsUnverified?: string[] })?.fieldsUnverified ?? []).length === 0, `${result.ok} ${String(result.message).slice(0, 200)} unverified=${JSON.stringify((result.data as { fieldsUnverified?: string[] })?.fieldsUnverified)}`);
  await page.context().close();
  await r.close();
}

await browser.close();
if (failures) { console.error(`\nreplayCommit: ${failures} check(s) FAILED`); process.exit(1); }
console.log("\nreplayCommit: all checks passed (real Chromium, synthetic replicas)");
process.exit(0);
