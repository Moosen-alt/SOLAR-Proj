// A SERVICE-LINE BOX THE RECIPE NEVER RECORDED IS READ OFF THE PAGE AT REPLAY (F1b).
//
// Live City of Corvallis electrical learn, 2026-09-28: the planner filled the kVA row and left
// "Service 0-200 amps (qty)" at the page's own 0 — the recipe saved from that run has no step for the
// service box, so every replay would leave it 0 on a job whose plan set upgrades the service. The
// replay reads the services rows on the same page as the recorded kVA tier step with the ONE label
// grammar (shared serviceLineLabels) and types THIS project's count (fieldValues).
//
// Fixtures: the REAL captured Oregon ePermitting Marion County services page (its rows are
// "Services 200 amps or less", "Services 201 to 400 amps", "Temp services …", "Service reconnect only",
// …) and a synthetic page in City of Corvallis's wording ("Service 0-200 amps (qty)" …).
//
//   MUST PASS   an MPU-200 job: "Services 200 amps or less" = 1, "Services 201 to 400 amps" = 0;
//               Corvallis wording: "Service 0-200 amps (qty)" = 1 on a page that printed 0.
//   MUST EXCLUDE temporary service, reconnect-only, manufactured-home, higher tiers untouched; a recipe
//               that RECORDED a bound step for the box is left to that step; an unknown count ("")
//               types nothing and says so; a backend that sends no count at all changes nothing.
//
//   npx tsx portal-bot/src/adapters/serviceLineReplay.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { RecipeAdapter } from "./recipeAdapter";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { FEE_TIER_RATING_FIELD } from "../feeBracketQuantity";
import { SERVICE_FEEDER_200A_FIELD, SERVICE_FEEDER_400A_FIELD } from "../../../shared/src/serviceLineLabels";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const marion = fs.readFileSync(path.join(here, "fixtures", "marionServices", "services.html"), "utf8");
const M = "ctl00_PlaceHolderMain_AppSpec1CAA1E64Edit_MARION_CO_";
const MBOX = {
  s200: `${M}txt_0_5`, s400: `${M}txt_0_6`, s599: `${M}txt_0_7`, reconnect: `${M}txt_0_11`,
  temp200: `${M}txt_0_14`, temp400: `${M}txt_0_15`, mfd: `${M}txt_0_21`, kva5: `${M}txt_0_26`,
} as const;
const C = "ctl00_PlaceHolderMain_AppSpecCEdit_CORV_";
const corvallis = `<!doctype html><html><head><title>City of Fernhollow - Permit System</title></head><body>
  <h2>Installation Specifics</h2>
  <label for="${C}txt_0_1">Service 0-200 amps (qty):</label> <input id="${C}txt_0_1" type="text" value="0">
  <label for="${C}txt_0_2">Service 201-400 amps (qty):</label> <input id="${C}txt_0_2" type="text" value="0">
  <label for="${C}txt_0_3">Service 401-600 amps (qty):</label> <input id="${C}txt_0_3" type="text" value="0">
  <label for="${C}txt_0_4">Service Reconnect Only (qty):</label> <input id="${C}txt_0_4" type="text" value="0">
  <label for="${C}txt_0_5">Temporary Service 0-200 amps (qty):</label> <input id="${C}txt_0_5" type="text" value="0">
  <label for="${C}txt_0_6">Manufactured Dwelling Service or Feeder (qty):</label> <input id="${C}txt_0_6" type="text" value="0">
  <label for="${C}txt_0_7">Renewable Energy 5_kva or less (qty):</label> <input id="${C}txt_0_7" type="text" value="0">
  <a id="ctl00_PlaceHolderMain_actionBarBottom_btnContinue" href="javascript:void(0)"><span>Continue Application »</span></a></body></html>`;
const CBOX = { s200: `${C}txt_0_1`, s400: `${C}txt_0_2`, s600: `${C}txt_0_3`, reconnect: `${C}txt_0_4`, temp200: `${C}txt_0_5`, mfd: `${C}txt_0_6` } as const;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(url.pathname.includes("corvallis") ? corvallis : marion);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const MARION_TIER = "Renewable energy for electrical systems- 5kva or less:";
const recipeFor = (entry: string, tierLabel: string, extra: RecipeStep[] = []): PortalRecipe => ({
  id: "service-line-smoke", scopeType: "ahj", profileKey: "or|city of fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "accela", portalUrl: entry, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "", discipline: "electrical",
  steps: [
    { action: "goto", value: entry, note: "entry url" },
    ...extra,
    { action: "fill", selector: { label: tierLabel }, note: tierLabel, field: "feeBracketQuantity:0-5", value: "1" },
    { action: "stopForReview" } as RecipeStep,
  ],
} as unknown as PortalRecipe);

const browser = await chromium.launch();
async function run(entry: string, recipe: PortalRecipe, fieldValues: Record<string, string>, ids: Record<string, string>) {
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.route("**/*", (route) => (/^https?:\/\/127\.0\.0\.1:/.test(route.request().url()) ? route.continue() : route.abort()));
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page: Page = await ctx.newPage();
  await page.goto(entry);
  const adapter = new RecipeAdapter(recipe, { __replayBlank: "", [FEE_TIER_RATING_FIELD]: "3.84", ...fieldValues }, {}, {});
  (adapter as unknown as { page: unknown }).page = page;
  let result: { ok: boolean; message: string; data?: Record<string, unknown> };
  try { result = await adapter.fillApplication({ systemSizeAcKw: 3.84 } as ProjectRecord) as typeof result; }
  catch (e) { result = { ok: false, message: `threw ${String(e).slice(0, 300)}` }; }
  const values = await page.evaluate((m: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [k, id] of Object.entries(m)) out[k] = (document.getElementById(id) as HTMLInputElement | null)?.value ?? "(missing)";
    return out;
  }, ids).catch(() => ({} as Record<string, string>));
  await ctx.close().catch(() => null);
  const data = JSON.stringify(result.data ?? {});
  return { result, values, data };
}

const MARION_ENTRY = `${base}/oregon/Cap/CapEdit.aspx?marion=1`;
const CORV_ENTRY = `${base}/corvallis/Cap/CapEdit.aspx`;
const MPU = { [SERVICE_FEEDER_200A_FIELD]: "1", [SERVICE_FEEDER_400A_FIELD]: "0" };

try {
  const a = await run(MARION_ENTRY, recipeFor(MARION_ENTRY, MARION_TIER), MPU, MBOX);
  check("MUST PASS (Marion's real page): an MPU-200 job → \"Services 200 amps or less\" = 1, \"Services 201 to 400 amps\" = 0",
    a.values.s200 === "1" && a.values.s400 === "0", JSON.stringify(a.values));
  check("MUST EXCLUDE: temp services, reconnect-only, manufactured home and the 401-599 row are untouched",
    a.values.temp200 === "" && a.values.temp400 === "" && a.values.reconnect === "" && a.values.mfd === "" && a.values.s599 === "", JSON.stringify(a.values));
  check("the run says the service line was read from the page", /service line read from the page/.test(a.data), a.data.slice(0, 400));

  const b = await run(CORV_ENTRY, recipeFor(CORV_ENTRY, "Renewable Energy 5_kva or less (qty):"), MPU, CBOX);
  check("MUST PASS (Corvallis wording): \"Service 0-200 amps (qty)\" 0 → 1 on an MPU-200 job; the 201-400 row stays 0",
    b.values.s200 === "1" && b.values.s400 === "0", JSON.stringify(b.values));
  check("MUST EXCLUDE (Corvallis wording): 401-600, reconnect, temporary 0-200, manufactured dwelling keep the page's 0",
    b.values.s600 === "0" && b.values.reconnect === "0" && b.values.temp200 === "0" && b.values.mfd === "0", JSON.stringify(b.values));

  // A recipe that RECORDED a bound step for the box: that step answers for it (typed "1" by its own path).
  const recordedStep: RecipeStep = { action: "fill", selector: { label: "Service 0-200 amps (qty):" }, note: "Service 0-200 amps (qty):", field: SERVICE_FEEDER_200A_FIELD };
  const c = await run(CORV_ENTRY, recipeFor(CORV_ENTRY, "Renewable Energy 5_kva or less (qty):", [recordedStep]), { ...MPU, [SERVICE_FEEDER_200A_FIELD]: "1" }, CBOX);
  check("a recorded, bound step answers for its own box (the page pass stays out of it — no 'read from the page' note)",
    c.values.s200 === "1" && !/service line read from the page: "Service 0-200/.test(c.data), `${JSON.stringify(c.values)} ${c.data.slice(0, 300)}`);

  const d = await run(CORV_ENTRY, recipeFor(CORV_ENTRY, "Renewable Energy 5_kva or less (qty):"), { [SERVICE_FEEDER_200A_FIELD]: "", [SERVICE_FEEDER_400A_FIELD]: "" }, CBOX);
  check("MUST EXCLUDE: an UNKNOWN count types nothing (the page's 0 stays) and the run SAYS it is not known",
    d.values.s200 === "0" && /service-line count is not known/.test(d.data), `${JSON.stringify(d.values)} ${d.data.slice(0, 300)}`);

  const e = await run(CORV_ENTRY, recipeFor(CORV_ENTRY, "Renewable Energy 5_kva or less (qty):"), {}, CBOX);
  check("MUST EXCLUDE: a backend that sends no service count at all changes nothing", e.values.s200 === "0" && e.values.s400 === "0", JSON.stringify(e.values));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\nserviceLineReplay DOM smoke: ${failures} check(s) FAILED`); process.exit(1); }
console.log("\nserviceLineReplay DOM smoke: all checks passed (real Chromium)");
process.exit(0);
