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

// ─────────────────────────────────────────────────────────────────────────────────────────────
section("P2  PacifiCorp's / Portland General's PowerClerk is only ever THAT utility's portal");
const { knownPowerClerkUtility } = await import("../src/utilityIdentity");
const { hostFitsTrackAndEntity } = await import("../src/portalChannel");
const { buildReviewerReport } = await import("../src/reviewerEngine");
const { evaluateBaselineRules } = await import("../src/baselineRules");
const { buildApplicationDocumentPackage } = await import("../src/applicationDocs");
const { purgeForeignKnownTenantPortals, learnFromPermitTarget } = await import("../src/knowledgeBase");
const PACIFICORP_URL = "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login";
const PGE_URL = "https://pgenm.powerclerk.com/MvcAccount/Login";
type KbRow = { portal_url?: string; portal_name?: string; required_documents_json?: string; verified_at?: string | null };
const utilRow = (state: string, utility: string): KbRow | undefined =>
  db.get<KbRow>("SELECT * FROM permit_utility_knowledge WHERE lower(state) = lower(?) AND ahj = '' AND lower(utility) = lower(?)", [state, utility]);
const nemFit = (state: string, utility: string, url: string) =>
  hostFitsTrackAndEntity("nem", PR.portalEntityEvidence(db, { scope: "utility", state, name: utility }), url, "kb");

await check("MUST-PASS/EXCLUDE: the one identity — anchored names, in the utility's own states only", () => {
  const cases: Array<[string, string, string | null]> = [
    ["OR", "Pacific Power", "pacificorp"], ["WA", "Pacific Power", "pacificorp"], ["CA", "Pacific Power", "pacificorp"],
    ["UT", "Rocky Mountain Power", "pacificorp"], ["WY", "PacifiCorp", "pacificorp"],
    ["OR", "PGE", "portland_general"], ["Oregon", "Portland General Electric", "portland_general"],
    ["CA", "Pacific Gas and Electric Company", null], ["CA", "PGE", null], ["CA", "PG&E", null],
    ["WA", "Pacific County PUD", null], ["TX", "Pacific Power", null], ["", "Pacific Power", null], ["WA", "PGE", null],
  ];
  for (const [state, utility, want] of cases) assert.equal(knownPowerClerkUtility({ state, utility }), want, `${state} ${utility}`);
});
const pge_ca = project({ state: "CA", city: "Fresno", zip: "93721", street: "2600 Fresno St", ahj: "City of Fresno", utility: "Pacific Gas and Electric Company" });
const pgeTyped_ca = project({ state: "CA", city: "Fresno", zip: "93721", street: "2601 Fresno St", ahj: "City of Fresno", utility: "PGE" });
const pud_wa = project({ state: "WA", city: "Raymond", zip: "98577", street: "300 Duryea St", ahj: "City of Raymond", utility: "Pacific County PUD" });
const pac_or = project({ state: "OR", city: "Coos Bay", zip: "97420", street: "1095 Michigan Ave", ahj: "City of Coos Bay", utility: "Pacific Power" });
const pge_or = project({ utility: "PGE" });
await check("MUST-PASS: saving a CA PG&E / CA 'PGE' / WA Pacific County PUD project writes NO PowerClerk portal as that utility's own", () => {
  assert.ok(!/powerclerk/i.test(utilRow("CA", "Pacific Gas and Electric Company")?.portal_url ?? ""), "PG&E got a PowerClerk portal");
  assert.ok(!/powerclerk/i.test(utilRow("CA", "PGE")?.portal_url ?? ""), "CA PGE got Portland General's portal");
  assert.ok(!/powerclerk/i.test(utilRow("WA", "Pacific County PUD")?.portal_url ?? ""), "Pacific County PUD got PacifiCorp's portal");
  void pge_ca; void pgeTyped_ca; void pud_wa;
});
await check("MUST-PASS: the KB write seam drops a known tenant carried in for another utility (a permit target naming PacifiCorp's URL on a PG&E job)", () => {
  learnFromPermitTarget(db, pge_ca, { jurisdiction: "City of Fresno", portalName: "PowerClerk", portalUrl: PACIFICORP_URL });
  assert.ok(!/powerclerk/i.test(utilRow("CA", "Pacific Gas and Electric Company")?.portal_url ?? ""), "relocated onto PG&E's utility row");
  learnFromPermitTarget(db, pac_or, { jurisdiction: "City of Coos Bay", portalName: "PowerClerk", portalUrl: PACIFICORP_URL });
  assert.equal(utilRow("OR", "Pacific Power")?.portal_url, PACIFICORP_URL, "MUST-EXCLUDE: PacifiCorp's own row");
});
await check("MUST-EXCLUDE: the real PacifiCorp (OR) and Portland General (OR) rows still get their own tenants", () => {
  assert.equal(utilRow("OR", "Pacific Power")?.portal_url, PACIFICORP_URL);
  assert.equal(utilRow("OR", "PGE")?.portal_url, PGE_URL);
  assert.equal(nemFit("OR", "Pacific Power", PACIFICORP_URL).fits, true);
  void pac_or; void pge_or;
});
await check("MUST-PASS: the NEM host gate refuses PacifiCorp's / PGE's tenant for another utility, even if a stale row claims it", () => {
  // The pre-fix write, as it sits in the live KB today (the fixed write path can no longer make it).
  db.run(`INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_name, portal_url, confidence, first_seen_at, last_learned_at, updated_at)
          VALUES ('stale-pge-ca', 'ca||pacific gas and electric (stale)', 'CA', '', 'Pacific Gas and Electric (stale)', 'Pacific Power Customer Generation Portal', ?, 'learned', 'x', 'x', 'x')`, [PACIFICORP_URL]);
  const fit = nemFit("CA", "Pacific Gas and Electric (stale)", PACIFICORP_URL);
  assert.equal(fit.fits, false, fit.reason);
  assert.equal(fit.code, "foreign_entity");
  assert.equal(nemFit("CA", "PGE", PGE_URL).fits, false, "Portland General's tenant fits a CA 'PGE'");
  assert.equal(nemFit("WA", "Pacific County PUD", PACIFICORP_URL).fits, false);
});
await check("MUST-PASS: QC and the reviewer no longer tell a PG&E job its Pacific Power meter photo / PGE account is missing", () => {
  const ids = buildReviewerReport(pge_ca).findings.map((f) => f.id);
  assert.ok(!ids.includes("reviewer.utility.pacpower-meter-photo"), ids.join(","));
  assert.ok(!buildReviewerReport(pgeTyped_ca).findings.some((f) => f.id === "reviewer.utility.pge-account"));
  const rules = evaluateBaselineRules({ state: "CA", utility: "Pacific Gas and Electric Company" } as never).map((r) => r.ruleId);
  assert.ok(!rules.some((r) => /^pacpower-|^pge-/.test(r)), rules.join(","));
});
await check("MUST-EXCLUDE: the real Pacific Power / PGE jobs keep their utility checks", () => {
  assert.ok(buildReviewerReport(pac_or).findings.some((f) => f.id === "reviewer.utility.pacpower-meter-photo"));
  const rules = evaluateBaselineRules({ state: "OR", utility: "Pacific Power" } as never).map((r) => r.ruleId);
  assert.ok(rules.includes("pacpower-meter-photo"), rules.join(","));
  assert.ok(evaluateBaselineRules({ state: "OR", utility: "PGE" } as never).some((r) => r.ruleId === "pge-powerclerk-docs"));
});
await check("MUST-PASS/EXCLUDE: the Utility/NEM worksheet is built for PacifiCorp / PGE jobs only", () => {
  const has = (p: typeof pge_ca) => buildApplicationDocumentPackage(p).docs.some((d) => d.id === "utility-nem");
  assert.equal(has(pge_ca), false);
  assert.equal(has(pud_wa), false);
  assert.equal(has(pac_or), true);
  assert.equal(has(pge_or), true);
});
await check("MUST-PASS: the v40 cleanup clears foreign tenants from learned/seeded rows; verified and correct rows are left alone", async () => {
  const ins = (key: string, state: string, ahj: string, utility: string, url: string, docs: string[], verified: boolean) =>
    db.run(`INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, portal_name, portal_url, required_documents_json, confidence, first_seen_at, last_learned_at, updated_at, verified_at, verified_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'x', 'x', 'x', ?, ?)`,
      [`id-${key}`, key, state, ahj, utility, url ? "PowerClerk" : "", url, JSON.stringify(docs), verified ? "mixed" : "learned", verified ? "2026-09-01T00:00:00Z" : null, verified ? "a person" : ""]);
  ins("t|pge-typed", "CA", "", "PGE (typed)", PGE_URL, [], false);
  ins("t|pud", "WA", "", "Pacific County PUD (t)", PACIFICORP_URL, [], false);
  ins("t|verified", "CA", "", "Verified Odd Utility", PACIFICORP_URL, [], true);
  ins("t|pac-or", "OR", "", "Pacific Power (t)", PACIFICORP_URL, ["Pacific Power customer generation application"], false);
  ins("t|pge-or", "OR", "", "PGE (t)", PGE_URL, ["PGE SLD/site/spec upload package"], false);
  ins("t|fresno", "CA", "City of Fresno (t)", "Pacific Gas and Electric (t)", "", ["Complete plan set", "Pacific Power customer generation application"], false);
  // Replay migration v40 through the real open path (versioned migrations run from MAX(version)).
  db.run("DELETE FROM schema_meta WHERE version >= 40");
  const db2 = await openDatabase();
  const row = (k: string) => db2.get<KbRow>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [k]);
  assert.equal(row("t|pge-typed")?.portal_url, "", "a CA 'PGE' kept Portland General's portal");
  assert.equal(row("t|pud")?.portal_url, "");
  assert.equal(row("ca||pacific gas and electric (stale)")?.portal_url, "", "the stale PG&E row kept PacifiCorp's portal");
  assert.equal(row("t|verified")?.portal_url, PACIFICORP_URL, "MUST-EXCLUDE: a human-verified row was rewritten (rule 3)");
  assert.equal(row("t|pac-or")?.portal_url, PACIFICORP_URL, "MUST-EXCLUDE: a correct PacifiCorp row was cleared");
  assert.deepEqual(JSON.parse(row("t|pac-or")?.required_documents_json ?? "[]"), ["Pacific Power customer generation application"]);
  assert.equal(row("t|pge-or")?.portal_url, PGE_URL, "MUST-EXCLUDE: a correct PGE row was cleared");
  assert.deepEqual(JSON.parse(row("t|fresno")?.required_documents_json ?? "[]"), ["Complete plan set"], "Fresno kept the foreign utility's document");
  const again = purgeForeignKnownTenantPortals(db2);
  assert.deepEqual([again.cleared.length, again.docsTrimmed.length], [0, 0], "not idempotent");
  assert.deepEqual(again.keptVerified, ["t|verified"]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
section("P3  a Yes/No site question never binds to a parser QC/evidence flag");
// The dictionary a learn binds against, with the parser's evidence flags in it (the real shape).
const evidenceProject = project({
  acDiscReq: "yes", lightFrame: "yes", gravityWindDesign: "yes", manufacturerInstallation: "yes",
  batteryModel: "", clientId: alpha.id,
});
const evidenceFields = PR.resolveRecipeFieldValues(db, evidenceProject, "utility");
const yn = (label: string, value = "Yes", note?: string): RecipeStep => ({ action: "select", selector: { label }, value, note: note ?? label });
await check("MUST-PASS: meter-access / manual-operable questions are NOT bound to acDiscReq / lightFrame by value", () => {
  assert.equal(evidenceFields.acDiscReq, "yes", "fixture: the evidence flag is in the dictionary");
  const r = PR.convertLiteralsToBoundFields([
    yn("Is the meter socket accessible 24/7?"),
    yn("Please indicate if the AC disconnect(s) for this installation are manually operable"),
    yn("Is the structure conventional light-frame construction?"),
  ], evidenceFields);
  for (const s of r.steps) {
    assert.ok(!s.field || !PR.isParserEvidenceKey(s.field), `${s.note} bound to ${s.field}`);
    assert.equal(s.value, "Yes", `${s.note} lost its recorded answer`);
  }
  assert.equal(r.ambiguous.length, 0, "a coincidental value match must not become a blocker");
});
await check("MUST-PASS: the disconnect-distance question binds to disconnectWithin10ft (both wordings)", () => {
  const r = PR.convertLiteralsToBoundFields([
    yn("Is your disconnect within 10 feet of the utility meter?"),
    yn("Are the AC disconnect(s) for this installation within the states required distance of the meter?"),
  ], evidenceFields);
  assert.deepEqual(r.steps.map((s) => s.field), ["disconnectWithin10ft", "disconnectWithin10ft"]);
  assert.ok(r.steps.every((s) => s.value === undefined));
});
await check("MUST-EXCLUDE: a policy-default step stays a literal; the question bank reads the same predicate", async () => {
  const r = PR.convertLiteralsToBoundFields([
    yn("Are the AC disconnect(s) for this installation within the states required distance of the meter?", "Yes", "policy default: Are the AC disconnect(s) for this installation within the states required distan -> Yes"),
    yn("Is the meter socket accessible 24/7?", "Yes", "policy default: Is the meter socket accessible 24/7? -> Yes"),
  ], evidenceFields);
  assert.deepEqual(r.steps.map((s) => [s.field, s.value]), [[undefined, "Yes"], [undefined, "Yes"]]);
  const { QUESTION_CLASSIFIER_RULES } = await import("../src/portalQuestionBank");
  const rule = QUESTION_CLASSIFIER_RULES.find((x) => x.id === "per-job:disconnect-10ft")!;
  assert.ok(rule.re.test("Are the AC disconnect(s) for this installation within the states required distance of the meter?"));
  assert.ok(!rule.re.test("Is the meter within 10 feet of the service panel?"), "a meter-only distance is not the disconnect question");
});
await check("MUST-PASS: a bare Yes/No matching ONE field by value alone is kept as recorded and reported, never bound", () => {
  const r = PR.convertLiteralsToBoundFields([yn("Is the meter socket accessible 24/7?", "Yes")], { hasBattery: "Yes", homeownerName: "Pat Example" });
  assert.equal(r.steps[0].field, undefined, `bound to ${r.steps[0].field}`);
  assert.equal(r.steps[0].value, "Yes");
  assert.equal(r.portalConstants.length, 1, "the kept literal is not reported");
});
await check("MUST-EXCLUDE: a Yes/No whose label names its field still binds (Energy Storage -> hasBattery); tokens are whole words", () => {
  const r = PR.convertLiteralsToBoundFields([yn("Energy Storage", "No")], { hasBattery: "No", homeownerName: "Pat Example" });
  assert.equal(r.steps[0].field, "hasBattery");
  assert.equal(PR.labelNamesField("Is the meter socket accessible 24/7?", "acDiscReq"), false, "'ac' matched inside 'accessible'");
  assert.equal(PR.labelNamesField("AC Disconnect Required", "acDiscReq"), true);
  // A non-Yes/No literal still binds on a unique value match, exactly as before.
  const n = PR.convertLiteralsToBoundFields([{ action: "fill", selector: { label: "Customer" }, value: "Pat Example" }], { homeownerName: "Pat Example" });
  assert.equal(n.steps[0].field, "homeownerName");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
section("P4  the plan set's AC disconnect beats the client's standard part; a contradiction is blank + named");
const { updateClient } = await import("../src/clients");
updateClient(db, alpha.id, { standardDisconnectMake: "Eaton", standardDisconnectModel: "DG221URB" });
const discProject = (snap: P) => project({ clientId: alpha.id, state: "OR", utility: "Pacific Power", city: "Coos Bay", zip: "97420", street: "10 Bay St", ahj: "City of Coos Bay", ...snap });
const disc = (p: ReturnType<typeof project>) => {
  const f = PR.resolveRecipeFieldValues(db, p, "utility");
  return [f.disconnectMake, f.disconnectModel, f.disconnectMakeModel];
};
const qcRules = (pid: string): string[] => db.query<{ rule_id: string }>("SELECT rule_id FROM qc_results WHERE project_id = ?", [pid]).map((r) => r.rule_id);
await check("MUST-PASS: a plan set that names its disconnect part is filed as named, not as the client's standard part", () => {
  const p = discProject({ acDiscMakeModel: "Square D DU222RB", acDiscAmps: "60A", acDiscFused: "fusible" });
  assert.deepEqual(disc(p), ["Square D", "DU222RB", "Square D DU222RB"]);
  assert.ok(!qcRules(p.id).some((r) => r.startsWith("xcheck-disconnect")), "the standard part is not in play — nothing to cross-check");
});
await check("MUST-PASS: a standard part that contradicts the plan set (60 A FUSIBLE vs a 30 A non-fused DG221URB) is left blank, and QC names it", () => {
  const p = discProject({ acDiscAmps: "60A", acDiscFused: "fusible" });
  assert.deepEqual(disc(p), ["", "", ""]);
  const rules = qcRules(p.id);
  assert.ok(rules.includes("xcheck-disconnect-fusing") && rules.includes("xcheck-disconnect-rating"), `QC: ${rules.filter((r) => r.startsWith("xcheck")).join(",") || "no cross-check fired"}`);
});
await check("MUST-EXCLUDE: a standard part that agrees with the plan set is filed; a schedule's rating line is not a part", () => {
  const p = discProject({ acDiscAmps: "30A", acDiscFused: "non-fusible", acDiscMakeModel: "30A NON-FUSIBLE AC DISCONNECT, 240V" });
  assert.deepEqual(disc(p), ["Eaton", "DG221URB", "Eaton DG221URB"]);
  assert.ok(!qcRules(p.id).some((r) => r.startsWith("xcheck-disconnect")));
});
await check("MUST-EXCLUDE: another company's job never gets this client's standard part (no client default -> blank)", () => {
  const p = project({ clientId: beta.id, state: "UT", utility: "Rocky Mountain Power", city: "Salt Lake City", zip: "84101", street: "1 Temple Sq", ahj: "Salt Lake City", acDiscAmps: "30A", acDiscFused: "non-fusible" });
  assert.deepEqual(disc(p), ["", "", ""]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
section("P5  a recorded date keeps its meaning: existing-system dates, insurance / bond expiries");
updateClient(db, alpha.id, { insuranceCarrier: "Acme Mutual Test", insuranceExpiry: "2027-01-31", bondCarrier: "Surety Test Co", bondExpiry: "2026-12-31" });
await check("MUST-PASS: existing-system / PTO dates are never today or a future estimate", () => {
  assert.equal(PR.dateFieldForLiteral("Existing System Permission to Operate Date", "03/15/2021"), "existingPtoDateUs");
  assert.equal(PR.dateFieldForLiteral("PTO date of the existing system", "2021-03-15"), "existingPtoDateIso");
  assert.equal(PR.dateFieldForLiteral("Existing system installation date", "06/01/2019"), null);
  assert.equal(PR.dateFieldForLiteral("Permission to Operate Date", "06/01/2019"), null, "a PTO that is not the EXISTING system's binds to nothing");
});
await check("MUST-PASS: insurance and bond expiries bind to the client's own dates; registration / business licence / workers' comp to nothing", () => {
  assert.equal(PR.dateFieldForLiteral("Contractor Insurance Expiration Date", "01/31/2027"), "insuranceExpiration");
  assert.equal(PR.dateFieldForLiteral("Surety Bond Expiration Date", "12/31/2026"), "bondExpiration");
  assert.equal(PR.dateFieldForLiteral("Business Registration Expiration Date", "12/31/2026"), null);
  assert.equal(PR.dateFieldForLiteral("Business License Expiration Date", "12/31/2026"), null);
  assert.equal(PR.dateFieldForLiteral("Workers' Comp Policy Expiration Date", "12/31/2026"), null);
});
await check("MUST-EXCLUDE: the dates that were right stay right (contractor licence expiry, today, commissioning)", () => {
  assert.equal(PR.dateFieldForLiteral("Contractor Licence Expiration Date", "2027-04-01"), "ccbExpiration");
  assert.equal(PR.dateFieldForLiteral("License valid through (date)", "2027-04-01"), "ccbExpiration");
  assert.equal(PR.dateFieldForLiteral("Application Date", "08/08/2026"), "todayDateUs");
  assert.equal(PR.dateFieldForLiteral("Estimated Commissioning Date", "08/08/2026"), "estimatedCommissioningDate");
});
const addition = project({ clientId: alpha.id, existingSystem: "yes", existingDcKw: "4.2", existingPtoDate: "2021-03-15" });
const additionFields = PR.resolveRecipeFieldValues(db, addition, "utility");
await check("MUST-PASS: exact value equality wins before the label rule — the existing PTO literal binds to the existing PTO, not today", () => {
  assert.equal(additionFields.existingPtoDateUs, "03/15/2021");
  assert.equal(additionFields.existingPtoDateIso, "2021-03-15");
  const r = PR.convertLiteralsToBoundFields([
    { action: "fill", selector: { label: "Existing System Permission to Operate Date" }, value: "03/15/2021", note: "Existing System Permission to Operate Date" },
    { action: "fill", selector: { label: "Signature Date" }, value: additionFields.todayDateUs, note: "Signature Date" },
    // A label the date rule reads as "today" — only value equality knows it is the existing PTO.
    { action: "fill", selector: { label: "Date of Interconnection" }, value: "03/15/2021", note: "Date of Interconnection" },
  ], additionFields);
  assert.ok(["existingPtoDate", "existingPtoDateUs"].includes(String(r.steps[0].field)), `PTO bound to ${r.steps[0].field}`);
  assert.equal(r.steps[1].field, "todayDateUs", "MUST-EXCLUDE: today's signature date is still today");
  assert.ok(["existingPtoDate", "existingPtoDateUs"].includes(String(r.steps[2].field)), `interconnection date bound to ${r.steps[2].field}`);
});
await check("MUST-PASS: the company-fact keys come from THIS job's client, always present, blank for another company", () => {
  assert.equal(additionFields.insuranceExpiration, "2027-01-31");
  assert.equal(additionFields.bondExpiration, "2026-12-31");
  assert.equal(additionFields.insuranceCarrier, "Acme Mutual Test");
  assert.equal(additionFields.installerStreetNumber, "808");
  assert.equal(additionFields.installerStreetName, "SE Test Dr Ste 3-337");
  const other = PR.resolveRecipeFieldValues(db, project({ clientId: beta.id }), "utility");
  for (const k of ["insuranceExpiration", "bondExpiration", "insuranceCarrier", "bondCarrier"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(other, k), `${k} absent`);
    assert.equal(other[k], "", `${k} leaked across companies: ${other[k]}`);
  }
  const noClient = PR.resolveRecipeFieldValues(db, project({}), "utility");
  assert.equal(noClient.installerStreetNumber, "");
  assert.ok(Object.prototype.hasOwnProperty.call(noClient, "bondExpiration"));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
section("P6  a company's identity and attestations never travel in a shared recipe");
const { isCompanyIdentityLabel, isCompanyAttestationStep, companyFactStamp } = await import("../../shared/src/companyFacts");
const { looksLikeProjectData } = await import("../../portal-bot/src/adapters/recipeAdapter");
const { REPLAY_BLANK_FIELD } = await import("../src/recipeReplayBinding");
const IDENTITY_LABELS = ["Insurance Carrier", "Policy Number", "Bond Number", "Workers Comp Carrier", "Workers' Compensation Policy #", "HIC Registration #",
  "Registration Number", "Title", "Website", "Master Electrician", "Supervisor", "CCB #", " ConStNum", " ConStName", " WCStrNum", " MailStName"];
await check("MUST-PASS: the replay guard refuses a recorded literal under every company-identity label the sweep found (control ids split into words)", () => {
  for (const l of IDENTITY_LABELS) {
    assert.equal(isCompanyIdentityLabel(l) || looksLikeProjectData(l, "x1"), true, `${l} is not company identity`);
    assert.equal(looksLikeProjectData(l, "808"), true, `replay would type the learn company's answer under "${l}"`);
  }
});
await check("MUST-EXCLUDE: the portal's own vocabulary still replays", () => {
  for (const [l, v] of [["Job Category", "STAND-ALONE"], ["Permit Name", "Solar PV System Installation"], ["Energy Source", "Solar"], ["Type of Work", "Alteration"], ["Description of Service", "Residential"]]) {
    assert.equal(looksLikeProjectData(l, v), false, `${l} = ${v} would be blanked`);
    assert.equal(isCompanyIdentityLabel(l), false, `${l} read as company identity`);
  }
});
const rec = PR.startPortalRecording(db, { scopeType: "ahj", state: "MA", ahj: "City of Testford", portalUrl: "https://permits.testford.example/", createdBy: "test" });
await check("MUST-PASS: the save guard never persists an unbound company-identity literal (bind it or blank it, named)", () => {
  const saved = PR.savePortalRecipeSteps(db, rec.id, [
    { action: "fill", selector: { label: "Insurance Carrier" }, value: "Acme Mutual Test", note: "Insurance Carrier" },
    { action: "fill", selector: { label: " ConStNum" }, value: "808", note: " ConStNum" },
    { action: "fill", selector: { label: "HIC Registration #" }, value: "HIC-000000", note: "HIC Registration #" },
    { action: "fill", selector: { label: "Owner Name" }, field: "homeownerName", note: "Owner Name" },
    { action: "fill", selector: { label: "Energy Source" }, value: "Solar", note: "Energy Source" },
    { action: "select", selector: { label: "Insurance Type" }, value: "General Liability", note: "Insurance Type" },
  ], { status: "recording" });
  const raw = db.get<{ steps_json: string }>("SELECT steps_json FROM portal_recipes WHERE id = ?", [rec.id])!.steps_json;
  for (const secret of ["Acme Mutual Test", "\"808\"", "HIC-000000"]) assert.ok(!raw.includes(secret), `persisted ${secret}`);
  assert.ok(saved.steps.slice(0, 3).every((s) => s.value === undefined && /company identity/.test(String(s.operatorItem))));
  assert.equal(saved.steps[3].field, "homeownerName", "MUST-EXCLUDE: a bound step");
  assert.equal(saved.steps[4].value, "Solar", "MUST-EXCLUDE: a portal constant");
  assert.equal(saved.steps[5].value, "General Liability", "MUST-EXCLUDE: a closed-vocabulary select is the attestation rule's, not the literal guard's");
});
await check("MUST-PASS: a human patch binds a company fact the client has on file, and withholds one it has not", () => {
  const fields = PR.resolveRecipeFieldValues(db, addition, "AHJ");
  const r = PR.appendHumanPatchSteps(db, rec.id, [
    { action: "fill", selector: { label: "Insurance Carrier" }, value: "Acme Mutual Test", note: "human-patch: Insurance Carrier" },
    { action: "fill", selector: { label: "Bond Number" }, value: "B-99999", note: "human-patch: Bond Number" },
  ], fields, alpha.id);
  const patched = r.steps.filter((s) => String(s.note ?? "").startsWith("human-patch"));
  assert.equal(patched[0].field, "insuranceCarrier");
  assert.equal(patched[1].value, undefined);
  assert.ok(!db.get<{ steps_json: string }>("SELECT steps_json FROM portal_recipes WHERE id = ?", [rec.id])!.steps_json.includes("B-99999"));
});
const attestations: RecipeStep[] = [
  { action: "check", selector: { label: "I am a sole proprietor or partnership and have no employees working for me in any capacity" }, value: "true", note: "I am a sole proprietor or partnership and have no employees" },
  { action: "select", selector: { label: "Licenses:" }, value: "HC Elec State ES 11774", note: "Licenses:" },
  { action: "check", selector: { label: "A liability insurance policy" }, value: "true", note: "A liability insurance policy" },
  { action: "check", selector: { label: "Yes, I'm a contractor for this project" }, value: "true", note: "Yes, I'm a contractor for this project" },
];
const benign: RecipeStep[] = [
  { action: "check", selector: { label: "I have read and agree to the terms and conditions" }, value: "true", note: "I have read and agree to the terms and conditions" },
  { action: "check", selector: { label: "I certify under the pains and penalties of perjury that the information is true" }, value: "true", note: "certification" },
  { action: "check", selector: { label: "Installer" }, value: "true", note: "Installer" },
  { action: "check", selector: { label: "Residential Solar" }, value: "true", note: "application type" },
  { action: "select", selector: { label: "Energy Source" }, value: "Solar PV", note: "Energy Source" },
];
await check("MUST-PASS/EXCLUDE: the attestation predicate — company facts yes, the notices and portal vocabulary no", () => {
  for (const s of attestations) assert.equal(isCompanyAttestationStep(s), true, String(s.note));
  for (const s of benign) assert.equal(isCompanyAttestationStep(s), false, String(s.note));
  assert.equal(isCompanyAttestationStep({ action: "click", isFinalSubmit: true, selector: { label: "Submit" } }), false);
});
await check("MUST-PASS: on ANOTHER company's job a stamped attestation is left for a person (check not replayed, select blank)", () => {
  const learned = PR.stampCompanyAttestations([...attestations, ...benign], alpha.id);
  assert.ok(learned.slice(0, 4).every((s) => s.companyFactOf === companyFactStamp(alpha.id)));
  assert.ok(learned.slice(4).every((s) => !s.companyFactOf), "a benign step was stamped");
  assert.ok(!String(companyFactStamp(alpha.id)).includes(alpha.id), "the stamp must not carry the client id");
  const onBeta = replay(learned, {}, { project: { state: "MA", ahj: "City of Testford", clientId: beta.id } });
  const labels = onBeta.steps.map((s) => String(s.note));
  assert.ok(!labels.some((l) => /sole proprietor|liability insurance|I'm a contractor/.test(l)), `replayed: ${labels.join(" | ")}`);
  const lic = onBeta.steps.find((s) => s.note === "Licenses:")!;
  assert.equal(lic.field, REPLAY_BLANK_FIELD);
  assert.equal(lic.value, "");
  assert.equal(onBeta.steps.length, learned.length - 3, "MUST-EXCLUDE: the notices / role / type / energy steps all replay");
});
await check("MUST-EXCLUDE: on the SAME company's job the stamped attestations replay; an unstamped one never does", () => {
  const learned = [...PR.stampCompanyAttestations(attestations.slice(0, 2), alpha.id), attestations[2]];
  const onAlpha = replay(learned, {}, { project: { state: "MA", ahj: "City of Testford", clientId: alpha.id } });
  assert.deepEqual(onAlpha.steps.map((s) => s.value), ["true", "HC Elec State ES 11774"]);
  assert.equal(onAlpha.changes.filter((c) => c.kind === "stripped").length, 1, "the unstamped liability-insurance check must be left for a person");
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
