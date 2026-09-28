// THE PORTAL / UTILITY / RECIPE SIDE OF THE 2026-09-28 LEAK SWEEP (.probe/leak-sweep/RESULT.json).
//
// Each section pins one confirmed defect with a MUST-PASS (the fix does its job) and a MUST-EXCLUDE
// (the fix does not reach what it must not). Every section was killed — the fix disabled, the
// section seen RED, the fix restored — before it was committed.
//
//   P1 a portal Job Value / Valuation box takes the declared valuation (the PDF's number), never the
//      contract price.
//
// Driven through the real write paths (createProject, createClient) on a scratch DB; no network,
// no API key.
//
//   npx tsx backend/test/leakFixPortal.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ never land in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeStep } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "leak-fix-portal-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
process.env.AUTOPILOT_TEST_SEAMS = "1";
delete process.env.PORTAL_AUTOMATION;
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "UTILITY_FILING_LOOKUP"]) process.env[k] = "off";
process.env.DOCUMENT_FETCH_BROWSER = "0";
process.env.AUTO_RELEARN_STALE = "0";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "false";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { createClient } = await import("../src/clients");
const PR = await import("../src/portalRecipes");
const { bindRecipeForReplay } = await import("../src/recipeReplayBinding");
const { buildPortalPlanner, setAutoLearnSeamsForTests } = await import("../src/autoLearn");
const { buildContext, resolveSource } = await import("../src/ahjForms");

const db = await openDatabase();

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const section = (t: string): void => console.log(`\n${t}`);

// Two companies, neither of them real: the learn company and another company.
const alpha = createClient(db, {
  companyName: "Alpha Solar Test Co", legalBusinessName: "Alpha Solar Test Co LLC", contactName: "Avery Alpha",
  businessAddress: "808 SE Test Dr Ste 3-337", businessCity: "Vancouver", businessState: "WA", businessZip: "98683",
  businessPhone: "5035550100", businessEmail: "ops@alpha.example",
});
const beta = createClient(db, {
  companyName: "Beta Energy Test Inc", legalBusinessName: "Beta Energy Test Inc", contactName: "Blair Beta",
  businessAddress: "12 Main St", businessCity: "Salt Lake City", businessState: "UT", businessZip: "84101",
  businessPhone: "8015550100", businessEmail: "ops@beta.example",
});

type P = Record<string, unknown>;
const project = (payload: P) => R.getProjectDetail(db, R.createProject(db, {
  owner: "Pat Example", street: "905 Quarry Bend", city: "Salem", state: "OR", zip: "97301",
  ahj: "City of Salem", utility: "Portland General Electric", dcKw: "8", acKw: "7.6",
  ...payload,
} as never).project.id).project;
const replay = (steps: RecipeStep[], fieldValues: Record<string, string>, extra: Partial<Parameters<typeof bindRecipeForReplay>[0]> = {}) =>
  bindRecipeForReplay({ steps, project: { state: "OR", ahj: "City of Salem" }, fieldValues, track: "structural", borrowed: null, agency: null, ...extra });

// ─────────────────────────────────────────────────────────────────────────────────────────────
section("P1  a Job Value / Valuation box takes the declared valuation, never the contract price");
const valued = project({ jobValue: "51866.60", clientId: alpha.id });
const valuedFields = PR.resolveRecipeFieldValues(db, valued, "AHJ");

await check("MUST-PASS: the resolver emits declaredValuation = the operator formula (40% of 51,866.60 = 20,747)", () => {
  assert.equal(valuedFields.declaredValuation, "20747");
});
await check("MUST-PASS: it is the SAME number the PDF application files (computed.declaredValuation)", () => {
  const pdf = resolveSource("computed.declaredValuation", buildContext(db, valued));
  assert.equal(valuedFields.declaredValuation, pdf, `portal ${valuedFields.declaredValuation} vs PDF ${pdf}`);
});
await check("MUST-PASS: the key is ALWAYS present — a job with nothing to compute from resolves it blank, never absent", () => {
  const bare = project({ dcKw: "", acKw: "" });
  const f = PR.resolveRecipeFieldValues(db, bare, "AHJ");
  assert.ok(Object.prototype.hasOwnProperty.call(f, "declaredValuation"), "declaredValuation missing");
  assert.equal(f.declaredValuation, "");
});
await check("MUST-PASS: replay rebinds the Coos Bay 'Job Value($):' steps (contractAmount / jobValue) and a frozen figure to the valuation", () => {
  const b = replay([
    { action: "fill", selector: { label: "Job Value($):" }, field: "contractAmount", note: "Job Value($):" },
    { action: "fill", selector: { label: "Job Value($):" }, field: "jobValue", note: "Job Value($):" },
    { action: "fill", selector: { label: "Estimated Cost of Construction" }, value: "41046.94", note: "Estimated Cost of Construction" },
    { action: "fill", selector: { label: "Valuation" }, field: "jobValue", note: "Valuation" },
  ], valuedFields);
  for (const s of b.steps) {
    assert.equal(s.field, "declaredValuation", `${s.note} bound to ${s.field}`);
    assert.equal(s.value, undefined, `${s.note} kept a literal`);
  }
  assert.equal(b.changes.filter((c) => c.kind === "rebound").length, 4);
});
await check("MUST-EXCLUDE: a box labelled CONTRACT price keeps the contract; other bindings are untouched", () => {
  const b = replay([
    { action: "fill", selector: { label: "Contract Price" }, field: "jobValue", note: "Contract Price" },
    { action: "fill", selector: { label: "Job Value (contract amount)" }, field: "contractAmount", note: "Job Value (contract amount)" },
    { action: "fill", selector: { label: "Owner Name" }, field: "homeownerName", note: "Owner Name" },
    { action: "fill", selector: { label: "System Size (kW DC)" }, field: "systemSizeDcKw", note: "System Size (kW DC)" },
  ], valuedFields);
  assert.deepEqual(b.steps.map((s) => s.field), ["jobValue", "contractAmount", "homeownerName", "systemSizeDcKw"]);
  assert.equal(b.changes.length, 0);
});
await check("MUST-PASS: the offline planner hint and the learn-time correction file the valuation in a Job Value box", async () => {
  const { planner } = buildPortalPlanner(db, valued, { portalType: "AHJ", scopeType: "ahj", permitType: "structural" });
  const plan = await planner({
    url: "https://aca.example.gov/", pageTitle: "Application", bodyText: "", alreadyFilledLabels: [],
    fields: [
      { selector: { label: "Job Value" }, label: "Job Value", fieldType: "text" },
      { selector: { label: "Contract Price" }, label: "Contract Price", fieldType: "text" },
    ],
  } as never);
  const byIdx = new Map(plan.fills.map((f) => [f.selectorIndex, f]));
  assert.equal(byIdx.get(0)?.field, "declaredValuation");
  assert.equal(byIdx.get(0)?.value, "20747");
  assert.equal(byIdx.get(1)?.field, "jobValue", "the contract-price box must keep the contract");
});
await check("MUST-PASS: a planner that binds a Job Value box to the contract is corrected before the draft is filled", async () => {
  setAutoLearnSeamsForTests({
    llm: () => ({
      planPortalFields: async () => ({
        fills: [
          { index: 0, value: "51866.6", field: "jobValue" },
          { index: 1, value: "51866.6", field: "jobValue" },
          { index: 2, value: "$10,001 - $25,000" },
        ],
        atReview: false, confidence: "high", notes: "",
      }),
    }) as never,
  });
  try {
    const { planner } = buildPortalPlanner(db, valued, { portalType: "AHJ", scopeType: "ahj", permitType: "structural" });
    const plan = await planner({
      url: "https://aca.example.gov/", pageTitle: "Application", bodyText: "", alreadyFilledLabels: [],
      fields: [
        { selector: { label: "Job Value($):" }, label: "Job Value($):", fieldType: "text" },
        { selector: { label: "Contract Amount" }, label: "Contract Amount", fieldType: "text" },
        { selector: { label: "Valuation Range" }, label: "Valuation Range", fieldType: "select", options: ["$0 - $10,000", "$10,001 - $25,000"] },
      ],
    } as never);
    assert.deepEqual(plan.fills[0], { selectorIndex: 0, value: "20747", field: "declaredValuation" });
    assert.equal(plan.fills[1].field, "jobValue", "MUST-EXCLUDE: a contract box keeps the contract");
    assert.equal(plan.fills[2].value, "$10,001 - $25,000", "MUST-EXCLUDE: a valuation RANGE select keeps its option");
  } finally {
    setAutoLearnSeamsForTests({ llm: null });
  }
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
