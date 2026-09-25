// COMMIT + READ-BACK — every replayed fill is committed (blur, then settle on what the page is
// doing) before the next one starts, and read back from the intended control.
//
// The synthetic PowerClerk replica's contact block RE-RENDERS from saved state ~300 ms after each
// autosave (a Vue-style patch: every value reset to what the server holds). A masked field typed
// key-by-key (Phone, ~0.5 s) that starts before the previous field's re-render lands is wiped
// MID-TYPING; the remaining keystrokes leave a fragment ("…0199"), and a read-back that accepted
// "shown is contained in wanted" called that held. That is the bench's "inst.phone wrong".
//
//   MUST-PASS     Name, Phone, Company replayed into the installer block all reach the SERVER
//                 with B's exact values.
//   MUST-EXCLUDE  a fragment of the wanted value is never accepted as held (checked by reading
//                 the server, not the adapter's report).
//
//   npx tsx portal-bot/src/adapters/replayCommit.dom.smoke.ts
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { buildWizard } from "../replica/fixtures/wizards";
import { startSyntheticReplica } from "../replica/syntheticServer";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const w = buildWizard("powerclerk", "base");
const r = await startSyntheticReplica({ wizard: w, credential: { username: "u1", password: "p1" } });
const inst = w.pages.find((p) => /installer information/i.test(p.heading))!;
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
const page = await ctx.newPage();
await page.goto(r.entryUrl);
await page.fill("#UserName", "u1");
await page.fill("#Password", "p1");
await Promise.all([page.waitForURL(/Dashboard/), page.click("#btnSignIn")]);

const steps: RecipeStep[] = [
  { action: "goto", value: `${r.base}/${inst.slug}`, note: "installer information" },
  { action: "fill", selector: { css: "#pcInputBase30" }, note: "Name", field: "installerContactName" },
  { action: "fill", selector: { css: "#pcInputBase33" }, note: "Phone", field: "installerPhone" },
  { action: "fill", selector: { css: "#pcInputBase31" }, note: "Company", field: "installerCompanyName" },
  { action: "stopForReview" },
];
const recipe: PortalRecipe = {
  id: "commit-smoke", scopeType: "utility", profileKey: "or||cascadia", state: "OR", ahj: "", utility: "Cascadia Power",
  portalPlatform: "powerclerk", portalUrl: `${r.base}/Dashboard`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps,
};
const values = { installerContactName: "Philippa Ashgrove", installerPhone: "541-555-0199", installerCompanyName: "Kestrel Energy LLC" };
const adapter = new RecipeAdapter(recipe, values, {});
(adapter as unknown as { page: unknown }).page = page;
const result = await adapter.fillApplication({} as ProjectRecord);
await page.waitForTimeout(w.delays.autosave + w.delays.rerender + 400); // let any last re-render land

const s = r.state.values;
check("Name reached the server", s["inst.name"] === values.installerContactName, JSON.stringify(s));
check("Phone reached the server WHOLE (no mid-typing wipe fragment)", String(s["inst.phone"] ?? "").replace(/\D/g, "") === "5415550199", `inst.phone=${JSON.stringify(s["inst.phone"])}`);
check("Company reached the server", s["inst.company"] === values.installerCompanyName, JSON.stringify(s));
check("the run reports no failed/unverified field", result.ok === true && ((result.data as { fieldsUnverified?: string[] })?.fieldsUnverified ?? []).length === 0, `${result.ok} ${String(result.message).slice(0, 200)} unverified=${JSON.stringify((result.data as { fieldsUnverified?: string[] })?.fieldsUnverified)}`);

await ctx.close();
await browser.close();
await r.close();
if (failures) { console.error(`\nreplayCommit: ${failures} check(s) FAILED`); process.exit(1); }
console.log("\nreplayCommit: all checks passed (real Chromium, synthetic replica)");
process.exit(0);
