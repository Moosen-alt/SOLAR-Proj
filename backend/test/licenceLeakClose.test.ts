// THE LICENCE / FORMS LEAKS THE INTEGRATION SKEPTICS FOUND, CLOSED (fixer-10, 2026-09-28).
//
// licences-by-type skeptic (verdict "broken"):
//   L1 another company's licence replayed from a recorded literal ("ROC #", "TECL #", "Reg. No.") —
//      the learn company's number is never kept as a literal (any state, any kind), short labels name a
//      licence, and a typed contractor key binds a contractor licence on any track;
//   L2 a CSL-labelled step bound to the generic ccbLicenseNumber — the label's kind decides at learn
//      (the binder) and at replay (recipeReplayBinding R9 + the replay adapter);
//   L3 every licence kind the overlay carries has its own expiry key; a kind with none binds nothing;
//   L4 one number is never drawn into two generic licence placements on a flat (overlay) PDF;
//   L5 the Oregon named columns are Oregon's always — licenseState never moves them;
//   L6 on an Oregon job a generic contractor-licence slot is the CCB at every door;
//   + the metro/city licence only on Oregon jobs; a blank project state is unknown (no licence keys);
//     the Clients editor never drops a stored row it could not show.
// leak-fix-forms skeptic:
//   K1 a credential in a shared note: migration v42 drops it from unverified rows, and every reader
//      is served notes without it (rule 2; rule 3 for verified rows);
//   K2 an in-person clause that refuses in-person, or merely allows it, never outranks a portal
//      (cases in channelKind.test.ts; one here too);
//   K3 an old registry form on disk is packaged only while it still matches the project;
//   K4 "is this Oregon" in the code-review rules is the project's state, nothing else.
//
// Every licence number, name and credential below is INVENTED.
//
//   npx tsx backend/test/licenceLeakClose.test.ts
import "./_isolate"; // FIRST: temp cwd, so filled/ and page-images never land in the repo
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { ProjectRecord, RecipeStep } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "licence-leak-close-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmp, "portal-profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
process.env.AUTOPILOT_TEST_SEAMS = "1";
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE"]) process.env[k] = "off";
process.env.DOCUMENT_FETCH_BROWSER = "0";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "false";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const section = (t: string) => console.log(`\n${t}`);

const { openDatabase } = await import("../src/db");
const repo = await import("../src/repository");
const clients = await import("../src/clients");
const forms = await import("../src/ahjForms");
const auto = await import("../src/ahjFormAuto");
const recipes = await import("../src/portalRecipes");
const kb = await import("../src/knowledgeBase");
const autoLearn = await import("../src/autoLearn");
const llmMod = await import("../src/llm");
const { bindRecipeForReplay, REPLAY_BLANK_FIELD } = await import("../src/recipeReplayBinding");
const { channelKindOf } = await import("../src/submittalTracks");
const { evaluateDesignCodeFindings } = await import("../src/codeReviewRules");
const { kindForSlot } = await import("../../shared/src/licenceKinds");
const { isCompanyIdentityLabel } = await import("../../shared/src/companyFacts");
const { RecipeAdapter, looksLikeProjectData } = await import("../../portal-bot/src/adapters/recipeAdapter");
const db = await openDatabase();

// ---------------------------------------------------------------------------------------------
// Companies (numbers invented).
// ---------------------------------------------------------------------------------------------
const N = {
  orCcb: "700888", orBcd: "C7888", orElectrician: "7888S", orSupervisor: "Olive Ohm",
  azEc: "ROC 444111", azCon: "ROC 444222", txEc: "TECL 55501",
  maCsl: "CS-800111", maHic: "HIC-198700", maEc: "5511-EL-C3", maMaster: "ME-4400", maBiz: "BIZ-MA-77",
  betaAzCon: "ROC 999000", betaAzEc: "ROC 999111", betaMaCon: "MA-CON-55555", betaMaCsl: "CS-900333",
  waCcb: "700555", waBcd: "C7555", metro: "MET-12345",
};
const alpha = clients.createClient(db, {
  companyName: "Alpha Test Solar", legalBusinessName: "Alpha Test Solar LLC", businessEmail: "ops@alpha.test", businessPhone: "5035550101",
  ccbLicenseNumber: N.orCcb, ccbExpiration: "2027-03-31", electricalLicenseNumber: N.orBcd, electricianLicenseNumber: N.orElectrician, electricalSupervisorName: N.orSupervisor,
  metroCityLicenseNumber: N.metro,
  stateLicenses: [
    { state: "AZ", kind: "electrical_contractor", number: N.azEc },
    { state: "AZ", kind: "contractor", number: N.azCon },
    { state: "TX", kind: "electrical_contractor", number: N.txEc },
    { state: "MA", kind: "CSL", number: N.maCsl, expires: "2028-08-15", holder: "Casey Csl" },
    { state: "MA", kind: "HIC", number: N.maHic, expires: "2027-01-31" },
    { state: "MA", kind: "EC", number: N.maEc, expires: "2027-06-30" },
    { state: "MA", kind: "master_electrician", number: N.maMaster, expires: "2029-02-28", holder: "Max Master" },
    { state: "MA", kind: "business_registration", number: N.maBiz },
  ],
});
const beta = clients.createClient(db, {
  companyName: "Beta Test Solar", legalBusinessName: "Beta Test Solar LLC", businessEmail: "ops@beta.test", businessPhone: "6025550102",
  stateLicenses: [
    { state: "AZ", kind: "contractor", number: N.betaAzCon }, { state: "AZ", kind: "electrical_contractor", number: N.betaAzEc },
    { state: "MA", kind: "contractor", number: N.betaMaCon }, { state: "MA", kind: "CSL", number: N.betaMaCsl, expires: "2029-01-01" },
  ],
});
const noCsl = clients.createClient(db, { companyName: "Nocsl Test Solar", stateLicenses: [{ state: "MA", kind: "EC", number: "EC-770077" }] });
const waState = clients.createClient(db, { companyName: "Westward Test Solar", ccbLicenseNumber: N.waCcb, electricalLicenseNumber: N.waBcd, licenseState: "WA" });
const alphaRow = clients.clientLicenceRow(db, alpha.id)!;
const waRow = clients.clientLicenceRow(db, waState.id)!;

const JOB = { utility: "Test Electric", account: "ACCT-1", meter: "M-1", dcKw: "7.2", acKw: "6.0", jobValue: "20000" };
const ZIP: Record<string, string> = { OR: "97301", MA: "02451", AZ: "85001", WA: "98001", TX: "73301", ME: "04101", "": "00000" };
let seq = 0;
const mk = (clientId: string, state: string, extra: Record<string, unknown> = {}): ProjectRecord => {
  seq += 1;
  const created = repo.createProject(db, {
    clientId, owner: `Owner ${state || "blank"} ${seq}`, street: `${10 + seq} Elm St`, city: state === "OR" ? "Salem" : "Townsville", state,
    zip: ZIP[state] ?? "10001", ahj: `City of Townsville ${state || "X"}`, ...JOB, ...extra,
  } as never).project;
  return repo.getProjectDetail(db, created.id).project;
};
const fv = (p: { id: string }, track: string | null) => recipes.resolveRecipeFieldValues(db, repo.getProjectDetail(db, p.id).project, "accela", track);

const alphaAz = mk(alpha.id, "AZ");
const alphaMa = mk(alpha.id, "MA");
const alphaOr = mk(alpha.id, "OR");
const betaAz = mk(beta.id, "AZ");
const betaMa = mk(beta.id, "MA");
const noCslMa = mk(noCsl.id, "MA");

// =============================================================================================
section("L1a  short labels name a licence — the save guard and the replay guard see them");
await check("MUST-PASS: 'ROC #', 'ROC No.', 'TECL #', 'Reg. No.', 'Lic. No.', 'CS License No.' name a licence (kindForSlot, isCompanyIdentityLabel, the replay guard)", () => {
  for (const l of ["ROC #", "ROC No.", "TECL #", "Reg. No.", "Lic. No.", "CS License No.", "Electrical Supervisor License"]) {
    assert.notEqual(kindForSlot(l), null, l);
    assert.equal(isCompanyIdentityLabel(l), true, l);
    assert.equal(looksLikeProjectData(l, "ROC 444222"), true, l);
  }
  assert.equal(kindForSlot("TECL #"), "electrical_contractor");
  assert.equal(kindForSlot("CS License No."), "construction_supervisor");
  assert.equal(kindForSlot("Electrical Supervisor License"), "master_electrician", "a supervisor is a person's licence");
  assert.equal(kindForSlot("ROC #"), "generic", "Arizona's ROC issues contractor AND electrical classes");
});
await check("MUST-EXCLUDE: ordinary labels still name no licence", () => {
  for (const l of ["Roof Pitch", "Record Type", "Regular Business Hours", "Rock Anchor Count", "Permit Name", "Protocol"]) assert.equal(kindForSlot(l), null, l);
});

// =============================================================================================
section("L1b  the learn company's licence never stays a literal (withholdClientLicenceLiterals)");
const numbersAlpha = clients.clientLicenceNumbers(alphaRow);
await check("MUST-PASS: a literal equal to ANY licence of the learn client (any state, any kind, normalised) is withheld — named, never printed", () => {
  const steps = [
    { action: "fill", selector: { label: "Number:" }, value: N.txEc },
    { action: "fill", selector: { label: "Number:" }, value: "55501" },            // bare digits of "TECL 55501"
    { action: "fill", selector: { label: "ID" }, value: "roc-444-222" },          // separators ignored
    { action: "fill", selector: { label: "Reference" }, value: N.orCcb },         // Oregon's CCB on any portal
  ] as RecipeStep[];
  const out = recipes.withholdClientLicenceLiterals(steps, numbersAlpha);
  assert.equal(out.withheld, steps.length, JSON.stringify(out.steps));
  for (const s of out.steps) {
    assert.equal(s.value, undefined);
    assert.equal(s.operatorItem, recipes.LICENCE_LITERAL_OPERATOR_ITEM);
    for (const n of Object.values(N)) assert.ok(!String(s.operatorItem).includes(n), "the item printed the number");
  }
});
await check("MUST-EXCLUDE: portal vocabulary, short values, a bound step and another number are untouched", () => {
  const steps = [
    { action: "fill", selector: { label: "Number:" }, value: "Yes" },
    { action: "select", selector: { label: "Energy Source" }, value: "Solar PV" },
    { action: "fill", selector: { label: "Qty" }, value: "12" },
    { action: "fill", selector: { label: "Number:" }, value: "44422" },
    { action: "fill", selector: { label: "CSL #" }, field: "constructionSupervisorLicenseNumber" },
    // A value is compared by its FULL token: a parcel that merely ends in the CCB's digits is not the CCB.
    { action: "fill", selector: { label: "Parcel" }, value: `R${N.orCcb}` },
    // A SELECT is closed vocabulary — a licence OPTION stays R8's (stamped, replayed only for the
    // company that recorded it), never blanked for everyone at learn.
    { action: "select", selector: { label: "Licenses:" }, value: `ZZ Elec State ES ${N.orElectrician}` },
    { action: "select", selector: { label: "Qualifier" }, value: N.azCon },
  ] as RecipeStep[];
  const out = recipes.withholdClientLicenceLiterals(steps, numbersAlpha);
  assert.equal(out.withheld, 0, JSON.stringify(out.steps));
  assert.deepEqual(out.steps, steps);
});

// ── the learn door, end to end through autoLearnPortal (browser + LLM stubbed) ────────────────
let nextLearn: Record<string, unknown> = {};
autoLearn.setAutoLearnSeamsForTests({ learnPortal: (async () => nextLearn) as never });
const verified = { accurate: true, overallConfidence: "high" as const, matches: [{ label: "Owner", expected: "x", found: "x", ok: true }], issues: [], notes: "" };
const fakeLlm = Object.assign(Object.create(llmMod.createLLMProvider()), {
  verifyPortalFill: async () => verified, verifyPortalFillVision: async () => verified,
});
autoLearn.setAutoLearnSeamsForTests({ llm: () => fakeLlm });
const LEARN_URL = "https://permits.townsville-az.example/apply";
const latestRecipeSteps = (): RecipeStep[] => JSON.parse(db.get<{ steps_json: string }>("SELECT steps_json FROM portal_recipes ORDER BY updated_at DESC, rowid DESC LIMIT 1")!.steps_json);
let learned: RecipeStep[] = [];
await check("MUST-PASS (learn door): on Alpha's AZ electrical learn the ROC contractor literal binds the typed contractor key; Alpha's TX licence under a bare label is withheld", async () => {
  nextLearn = {
    ok: true, portalName: "Townsville AZ Permits", pageCount: 2, pauseReason: null, finalSubmitRecorded: false,
    reachedReview: true, filledSomething: true, message: "reached review",
    steps: [
      { action: "goto", value: LEARN_URL, note: "entry url" },
      { action: "fill", selector: { name: "owner" }, field: "homeownerName", note: "Owner" },
      { action: "fill", selector: { label: "ROC #" }, value: N.azCon, note: "ROC #" },
      { action: "fill", selector: { label: "Number:" }, value: N.txEc, note: "Number:" },
      { action: "fill", selector: { label: "Permit Name" }, value: "Solar PV System Installation", note: "Permit Name" },
      { action: "stopForReview", selector: {} },
    ],
    reviewScreen: { fields: [{ label: "Owner", value: "x" }], bodyTextSnippet: "Review your application before submitting." },
    reviewScreenshotBase64: "iVBORw0KGgo=",
  };
  await autoLearn.autoLearnPortal(db, alphaAz.id, { scope: "ahj", portalUrl: LEARN_URL, createdBy: "operator", permitType: "electrical" });
  learned = latestRecipeSteps();
  const byNote = (n: string) => learned.find((s) => s.note === n)!;
  assert.equal(byNote("ROC #").field, "contractorLicenseNumber", JSON.stringify(byNote("ROC #")));
  assert.equal(byNote("Number:").value, undefined, "Alpha's TX licence was kept as a literal");
  assert.equal(byNote("Number:").operatorItem, recipes.LICENCE_LITERAL_OPERATOR_ITEM);
  assert.equal(byNote("Permit Name").value, "Solar PV System Installation", "MUST-EXCLUDE: portal vocabulary stays");
  const json = JSON.stringify(learned);
  for (const n of [N.azCon, N.txEc, "55501", N.azEc]) assert.ok(!json.includes(n), `the shared recipe carries ${n}`);
});
await check("MUST-PASS (human-patch door): a patch literal equal to the patching company's licence is withheld", async () => {
  const rec = recipes.startPortalRecording(db, { scopeType: "ahj", state: "AZ", ahj: "City of Patchville AZ", portalUrl: "https://permits.patchville.example/", createdBy: "test" });
  recipes.savePortalRecipeSteps(db, rec.id, [{ action: "stopForReview", selector: {} } as RecipeStep], { status: "recording" });
  const r = recipes.appendHumanPatchSteps(db, rec.id, [
    { action: "fill", selector: { label: "Number:" }, value: N.txEc, note: "human-patch: Number" },
  ] as RecipeStep[], fv(alphaAz, "electrical"), alpha.id);
  const patched = r.steps.find((s) => String(s.note ?? "").startsWith("human-patch"))!;
  assert.equal(patched.value, undefined);
  assert.ok(!db.get<{ steps_json: string }>("SELECT steps_json FROM portal_recipes WHERE id = ?", [rec.id])!.steps_json.includes("55501"));
});

// ── replay of what the learn saved, on ANOTHER company's job, through the real adapter ────────
interface Log { fills: Array<{ target: string; value: string }> }
function fakePage(log: Log): unknown {
  const held = new Map<string, string>();
  const loc = (target: string): Record<string, unknown> => {
    const l: Record<string, unknown> = {
      first: () => l, nth: () => l, count: async () => 1, isVisible: async () => true, isEnabled: async () => true, isEditable: async () => true,
      waitFor: async () => undefined, scrollIntoViewIfNeeded: async () => undefined, click: async () => undefined, check: async () => undefined,
      fill: async (v: string) => { held.set(target, String(v)); log.fills.push({ target, value: String(v) }); }, type: async (v: string) => { held.set(target, String(v)); log.fills.push({ target, value: String(v) }); },
      selectOption: async (v: unknown) => { log.fills.push({ target, value: typeof v === "string" ? v : String((v as { label?: string })?.label ?? "") }); },
      press: async () => undefined, inputValue: async () => held.get(target) ?? "", textContent: async () => "", innerText: async () => "", getAttribute: async () => null,
      evaluate: async () => "", allInnerTexts: async () => [], setInputFiles: async () => undefined, dispatchEvent: async () => undefined,
      boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }), locator: () => l, elementHandle: async () => null, focus: async () => undefined, blur: async () => undefined,
    };
    return l;
  };
  const page: Record<string, unknown> = {
    url: () => "https://portal.test/app", title: async () => "Application", goto: async () => undefined, waitForLoadState: async () => undefined,
    reload: async () => undefined, waitForTimeout: async () => undefined, isClosed: () => false, bringToFront: async () => undefined,
    keyboard: { press: async () => undefined }, frames: () => [], evaluate: async () => "", screenshot: async () => Buffer.from(""), content: async () => "<html></html>",
    getByRole: (r: string, o?: { name?: string }) => loc(`role:${r}:${o?.name ?? ""}`), getByLabel: (lbl: string) => loc(`label:${lbl}`),
    getByPlaceholder: (p: string) => loc(`placeholder:${p}`), getByTestId: (t: string) => loc(`testId:${t}`), getByText: () => ({ ...loc("text"), count: async () => 0 }),
    locator: (css: string) => loc(`css:${css}`), $$eval: async () => [],
  };
  page.frameLocator = () => page;
  page.context = () => ({ pages: () => [page] });
  return page;
}
/** The REAL replay adapter on one step (no recipeReplayBinding in front of it). */
const adapterTyped = async (project: { id: string }, track: string, step: RecipeStep): Promise<string[]> => {
  const log: Log = { fills: [] };
  const detail = repo.getProjectDetail(db, project.id).project;
  const recipe = { id: "r-lic", scopeType: "ahj", profileKey: "x|y|", state: detail.state, ahj: detail.ahj, utility: "", portalPlatform: "",
    portalUrl: "https://portal.test/app", status: "complete", version: 1, steps: [step], createdBy: "test", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), notes: "" };
  const adapter = new RecipeAdapter(recipe as never, recipes.resolveRecipeFieldValues(db, detail, "accela", track), {});
  (adapter as unknown as { page: unknown }).page = fakePage(log);
  (adapter as unknown as { opened: unknown }).opened = { context: { pages: () => [(adapter as unknown as { page: unknown }).page] } };
  await adapter.fillApplication(detail);
  return log.fills.map((f) => f.value);
};
await check("MUST-PASS: the learned ROC step replayed on Beta's AZ job types BETA's contractor licence — never Alpha's", async () => {
  const step = learned.find((s) => s.note === "ROC #")!;
  const typed = await adapterTyped(betaAz, "electrical", step);
  assert.deepEqual(typed, [N.betaAzCon], JSON.stringify(typed));
});

// =============================================================================================
section("L2  the label's kind decides — at learn (the binder) and at replay (R9 + the adapter)");
const bindOne = (label: string, value: string, fields: Record<string, string>) =>
  recipes.convertLiteralsToBoundFields([{ action: "fill", selector: { label }, value, note: label } as RecipeStep], fields);
await check("MUST-PASS (binder): a CSL-labelled literal binds the CSL key, not the equal-valued generic ccbLicenseNumber", () => {
  const v = fv(alphaMa, "building");
  assert.equal(v.ccbLicenseNumber, N.maCsl, "setup: on Alpha's MA building job the generic key holds the CSL");
  for (const l of ["CSL License Number", "CS License No.", "Construction Supervisor Lic #"]) {
    const r = bindOne(l, N.maCsl, v);
    assert.equal(r.steps[0].field, "constructionSupervisorLicenseNumber", `${l}: ${JSON.stringify(r)}`);
    assert.equal(r.ambiguous.length, 0);
  }
  const exp = recipes.convertLiteralsToBoundFields([{ action: "fill", selector: { label: "CSL Expiration Date" }, value: "2028-08-15" } as RecipeStep], v);
  assert.equal(exp.steps[0].field, "constructionSupervisorLicenseExpiration", JSON.stringify(exp));
});
await check("MUST-PASS (binder): a CSL-labelled literal that is ANOTHER kind's number is withheld — never bound to the generic key", () => {
  const v = fv(betaMa, "building");
  assert.equal(v.ccbLicenseNumber, N.betaMaCon, "setup: Beta's generic building licence is its MA contractor licence");
  const r = bindOne("CSL Number", N.betaMaCon, v);
  assert.equal(r.steps[0].field, undefined, JSON.stringify(r));
  assert.equal(r.steps[0].value, undefined);
  assert.equal(r.steps[0].operatorItem, recipes.LICENCE_LITERAL_OPERATOR_ITEM);
});
await check("MUST-PASS (Oregon, no false stop): CCB / generic / electrical labels bind as before, never ambiguous", () => {
  const v = fv(alphaOr, "building");
  const cases: Array<[string, string, string]> = [
    ["CCB License Number", N.orCcb, "ccbLicenseNumber"],
    ["Contractor License #", N.orCcb, "ccbLicenseNumber"],
    ["License Number", N.orCcb, "ccbLicenseNumber"],
    ["Electrical License #", N.orBcd, "electricalLicenseNumber"],
    ["Supervising Electrician License #", N.orElectrician, "electricianLicenseNumber"],
    // A box that names the CCB asks for the CCB, whatever trade it sits under.
    ["Electrical Contractor CCB #", N.orCcb, "ccbLicenseNumber"],
  ];
  for (const [label, value, want] of cases) {
    const r = bindOne(label, value, v);
    assert.equal(r.steps[0].field, want, `${label}: ${JSON.stringify(r)}`);
    assert.equal(r.ambiguous.length, 0, label);
  }
});
const replayBind = (project: ProjectRecord, track: string, steps: RecipeStep[]) =>
  bindRecipeForReplay({ steps, project: { ...project, clientId: project.clientId }, fieldValues: fv(project, track), track, borrowed: null, agency: null });
const CSL_STEP = { action: "fill", selector: { label: "CSL Number" }, field: "ccbLicenseNumber", note: "CSL Number" } as RecipeStep;
await check("MUST-PASS (replay binding R9): a CSL-labelled step bound to ccbLicenseNumber reads THIS job's CSL key", () => {
  for (const [p, track, want] of [[alphaMa, "electrical", N.maCsl], [alphaMa, "building", N.maCsl], [betaMa, "building", N.betaMaCsl]] as const) {
    const b = replayBind(p, track, [CSL_STEP]);
    assert.equal(b.steps[0].field, "constructionSupervisorLicenseNumber", `${p.state}/${track}: ${JSON.stringify(b.changes)}`);
    assert.equal(fv(p, track)[b.steps[0].field!], want);
  }
  assert.ok(replayBind(alphaMa, "electrical", [CSL_STEP]).changes.some((c) => c.kind === "rebound"), "a changed value is recorded");
});
await check("MUST-PASS (replay binding R9): no CSL on file / a kind with no key -> BLANK, named for a person", () => {
  const b = replayBind(noCslMa, "building", [CSL_STEP]);
  assert.equal(b.steps[0].field, REPLAY_BLANK_FIELD);
  assert.ok(b.steps[0].operatorItem && /construction supervisor/.test(b.steps[0].operatorItem), JSON.stringify(b.steps[0]));
  const solar = replayBind(alphaMa, "building", [{ action: "fill", selector: { label: "Solar Contractor License #" }, field: "ccbLicenseNumber", note: "x" } as RecipeStep]);
  assert.equal(solar.steps[0].field, REPLAY_BLANK_FIELD, "a solar licence has no key — never the generic licence");
});
await check("MUST-EXCLUDE (replay binding R9): a generic label, an Oregon CCB label and a holder NAME step are untouched", () => {
  const generic = { action: "fill", selector: { label: "License Number" }, field: "ccbLicenseNumber", note: "x" } as RecipeStep;
  const ccb = { action: "fill", selector: { label: "CCB #" }, field: "ccbLicenseNumber", note: "x" } as RecipeStep;
  const holder = { action: "fill", selector: { label: "Supervising Electrician Name" }, field: "electricalSupervisorName", note: "x" } as RecipeStep;
  const elecCcb = { action: "fill", selector: { label: "Electrical Contractor CCB #" }, field: "ccbLicenseNumber", note: "x" } as RecipeStep;
  const b = replayBind(alphaOr, "electrical", [generic, ccb, holder, elecCcb]);
  assert.deepEqual(b.steps.map((s) => s.field), ["ccbLicenseNumber", "ccbLicenseNumber", "electricalSupervisorName", "ccbLicenseNumber"]);
  assert.equal(b.changes.length, 0, JSON.stringify(b.changes));
});
await check("MUST-PASS (the replay adapter itself): 'CSL Number' bound to ccbLicenseNumber types the CSL — never the EC or the contractor number", async () => {
  const a = await adapterTyped(alphaMa, "electrical", CSL_STEP);
  assert.deepEqual(a, [N.maCsl], `Alpha MA electrical typed ${JSON.stringify(a)}`);
  const b = await adapterTyped(betaMa, "building", CSL_STEP);
  assert.deepEqual(b, [N.betaMaCsl], `Beta MA building typed ${JSON.stringify(b)}`);
  const none = await adapterTyped(noCslMa, "building", CSL_STEP);
  assert.ok(!none.some(Boolean), `no CSL on file typed ${JSON.stringify(none)}`);
});

// =============================================================================================
section("L3  every licence kind the overlay carries has its own expiry key");
await check("MUST-PASS: an expiry binds its own kind's key; CCB / generic keep ccbExpiration", () => {
  const d = recipes.dateFieldForLiteral;
  assert.equal(d("Electrical Contractor License Expiration Date", "2027-06-30"), "electricalLicenseExpiration");
  assert.equal(d("Electrical License Expiration Date", "2027-06-30"), "electricalLicenseExpiration");
  assert.equal(d("Master Electrician License Expiration Date", "2029-02-28"), "electricianLicenseExpiration");
  assert.equal(d("Supervising Electrician License Expiration Date", "2029-02-28"), "electricianLicenseExpiration");
  assert.equal(d("General Contractor License Expiration Date", "2027-03-31"), "contractorLicenseExpiration");
  assert.equal(d("CCB License Expiration Date", "2027-03-31"), "ccbExpiration");
  assert.equal(d("License Expiration Date", "2027-03-31"), "ccbExpiration");
  assert.equal(d("CSL Expiration Date", "2028-08-15"), "constructionSupervisorLicenseExpiration");
  assert.equal(d("HIC Registration Expiration Date", "2027-01-31"), "homeImprovementLicenseExpiration");
});
await check("MUST-EXCLUDE: a kind with no key binds NOTHING (the save guard withholds it) — never another licence's date", () => {
  const d = recipes.dateFieldForLiteral;
  for (const l of ["Business License Expiration Date", "Solar Contractor License Expiration Date", "Driver's License Expiration Date", "Registration Expiration Date"]) assert.equal(d(l, "2027-01-01"), null, l);
  assert.equal(d("Insurance Policy Expiration Date", "2027-01-01"), "insuranceExpiration");
  assert.equal(d("Surety Bond Expiration Date", "2027-01-01"), "bondExpiration");
});
await check("MUST-PASS: the resolver answers each expiry from its own licence (MA building job)", () => {
  const v = fv(alphaMa, "building");
  assert.equal(v.electricalLicenseExpiration, "2027-06-30");
  assert.equal(v.electricianLicenseExpiration, "2029-02-28");
  assert.equal(v.constructionSupervisorLicenseExpiration, "2028-08-15");
  assert.equal(v.contractorLicenseExpiration, "", "no MA contractor licence — present and blank");
  assert.equal(v.ccbExpiration, "2028-08-15", "the generic building licence here is the CSL");
  for (const k of ["contractorLicenseNumber", "contractorLicenseExpiration", "electricalLicenseExpiration", "electricianLicenseExpiration"]) {
    assert.ok(recipes.RECIPE_FIELD_DESCRIPTIONS[k], `${k} is described for auto-learn`);
    assert.ok(Object.prototype.hasOwnProperty.call(fv(noCslMa, "building"), k), `${k} is always present`);
  }
});
await check("MUST-PASS (Oregon): the BCD / supervising-electrician columns take their expiry from a typed twin (same number) — MUST-EXCLUDE: never the CCB's date", () => {
  const twin = clients.createClient(db, {
    companyName: "Twin Test Solar", ccbLicenseNumber: "700610", ccbExpiration: "2027-03-31", electricalLicenseNumber: "C6100",
    electricianLicenseNumber: "6100S", electricalSupervisorName: "Tess Twin",
    stateLicenses: [{ state: "OR", kind: "electrical_contractor", number: "C 6100", expires: "2027-09-30" }, { state: "OR", kind: "master_electrician", number: "6100S", expires: "2028-02-29" }],
  });
  const v = fv(mk(twin.id, "OR"), "electrical");
  assert.equal(v.electricalLicenseNumber, "C6100", "the column is still the number filed");
  assert.equal(v.electricalLicenseExpiration, "2027-09-30");
  assert.equal(v.electricianLicenseExpiration, "2028-02-29");
  assert.equal(v.electricalSupervisorName, "Tess Twin");
  const noTwin = fv(alphaOr, "electrical");
  assert.equal(noTwin.electricalLicenseExpiration, "", "no electrical expiry on file — blank, never the CCB's 2027-03-31");
  assert.equal(noTwin.ccbExpiration, "2027-03-31");
});

// =============================================================================================
section("L4  one licence number is never drawn into two generic placements on a flat PDF");
async function flatBlank(labels: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  labels.forEach((l, i) => p.drawText(l, { x: 40, y: 700 - i * 40, size: 10, font }));
  return doc.save();
}
const overlayMap = (placements: Array<{ label: string; source: string }>, verifiedMap = false) => ({
  formName: "Flat Application", sourceUrl: "", fillMode: "overlay" as const, notes: "", textFields: {}, checkboxes: {},
  overlayFields: placements.map((pl, i) => ({ page: 0, x: 200, y: 700 - i * 40, size: 10, source: pl.source, label: pl.label })),
  ...(verifiedMap ? { verified: true, verifiedAt: "2026-09-28T12:00:00.000Z" } : {}),
});
const drawnText = async (file: string): Promise<string> => {
  const { extractLabels } = await import("../src/formTextLayer");
  return (await extractLabels(new Uint8Array(fs.readFileSync(file)))).map((i) => i.str).join(" | ");
};
const fillStored = async (ahj: string, state: string, project: ProjectRecord, tag: string) => {
  const t = forms.loadStoredTemplates(db, ahj, state)[0];
  assert.ok(t, `setup: a stored template for ${ahj}`);
  const ctx = forms.buildContext(db, repo.getProjectDetail(db, project.id).project);
  const out = path.join(tmp, `${tag}.pdf`);
  const res = await forms.fillLoadedForm(t.def, t.bytes, ctx, out);
  return { res, out, items: res.operatorItems ?? [] };
};
const FLAT_LABELS = ["License Number", "Registration Number"];
auto.storeAhjFormTemplate(db, { ahjName: "City of Flatfield", state: "MA", formType: "building_application", filename: "Flat Application.pdf",
  bytes: await flatBlank(FLAT_LABELS), map: overlayMap(FLAT_LABELS.map((label) => ({ label, source: "client.stateContractorLicense" }))) as never });
const flatJob = mk(alpha.id, "MA", { ahj: "City of Flatfield" });
await check("MUST-PASS unverified overlay: two generic licence placements are both left blank and named — the number is drawn ZERO times", async () => {
  const { out, items } = await fillStored("City of Flatfield", "MA", flatJob, "flat-dup");
  const text = await drawnText(out);
  assert.equal(text.split(N.maCsl).length - 1, 0, `drawn: ${text}`);
  const named = items.filter((i) => /the same licence number as/.test(i));
  assert.equal(named.length, 2, JSON.stringify(items));
  assert.ok(!named.some((i) => i.includes(N.maCsl)), "an item printed the number");
});
auto.storeAhjFormTemplate(db, { ahjName: "City of Oneslot", state: "MA", formType: "building_application", filename: "Flat Application.pdf",
  bytes: await flatBlank(["License Number"]), map: overlayMap([{ label: "License Number", source: "client.stateContractorLicense" }]) as never });
await check("MUST-EXCLUDE: a single generic placement is still drawn (the guard is about TWO slots)", async () => {
  const { out } = await fillStored("City of Oneslot", "MA", mk(alpha.id, "MA", { ahj: "City of Oneslot" }), "flat-one");
  assert.equal((await drawnText(out)).split(N.maCsl).length - 1, 1);
});

// =============================================================================================
section("L5  the Oregon named columns are Oregon's ALWAYS — licenseState never moves them");
await check("MUST-PASS: a client whose licenseState is WA keeps its CCB on Oregon jobs — gate, portal and forms", () => {
  assert.equal(clients.licenceFor(waRow, "OR", "contractor").number, N.waCcb);
  const gate = clients.contractorLicenceForState(waRow, "OR");
  assert.equal(gate.number, N.waCcb); assert.equal(gate.oregon, true);
  const orJob = mk(waState.id, "OR");
  assert.equal(fv(orJob, "building").ccbLicenseNumber, N.waCcb);
  assert.equal(fv(orJob, "electrical").electricalLicenseNumber, N.waBcd);
  const ctx = forms.buildContext(db, orJob);
  assert.equal(forms.resolveSource("client.stateContractorLicense", ctx), N.waCcb);
});
await check("MUST-EXCLUDE: the CCB / BCD columns are never offered as the WA licence", () => {
  const waJob = mk(waState.id, "WA");
  for (const track of ["building", "electrical", null]) {
    const v = fv(waJob, track);
    for (const [k, val] of Object.entries(v)) assert.ok(val !== N.waCcb && val !== N.waBcd, `${track}: ${k} carries an Oregon column`);
  }
  assert.equal(clients.contractorLicenceForState(waRow, "WA").number, "");
});

// =============================================================================================
section("L6  on an Oregon job a generic contractor-licence slot is the CCB at every door");
async function acroBlank(boxes: Array<{ name: string; caption: string }>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  const form = doc.getForm();
  const all = [{ name: "Owner Name", caption: "Owner Name" }, { name: "Business Phone", caption: "Business Phone" }, ...boxes];
  all.forEach((b, i) => { const y = 740 - i * 40; form.createTextField(b.name).addToPage(p, { x: 40, y, width: 300, height: 12 }); p.drawText(b.caption, { x: 42, y: y - 10, size: 9, font }); });
  return doc.save();
}
const acroMap = (textFields: Record<string, string>) => ({ formName: "Oregon Application", sourceUrl: "", fillMode: "acroform" as const, preserveInteractive: true, notes: "", textFields: { "Owner Name": "project.homeownerName", ...textFields }, checkboxes: {} });
const OR_BOXES = [{ name: "Contractor License", caption: "Contractor License #" }, { name: "Electrical License", caption: "Electrical License No." }];
for (const [ahj, formType] of [["City of Otherform", "other"], ["City of Elecform", "electrical_application"]] as const) {
  auto.storeAhjFormTemplate(db, { ahjName: ahj, state: "OR", formType, filename: `${formType}.pdf`, bytes: await acroBlank(OR_BOXES),
    map: acroMap({ "Contractor License": "client.stateContractorLicense", "Electrical License": "client.stateLicence.electrical_contractor" }) as never });
}
await check("MUST-PASS: licenceFor — a generic slot on an Oregon job is the CCB on every track; the BCD only when the slot names it", () => {
  for (const track of ["building", "electrical", "combo", "nem", null]) {
    assert.equal(clients.licenceFor(alphaRow, "OR", { track }).number, N.orCcb, String(track));
    assert.equal(clients.licenceFor(alphaRow, "OR", { slotText: "License #", track }).number, N.orCcb, String(track));
  }
  assert.equal(clients.licenceFor(alphaRow, "OR", { slotText: "Electrical License No.", track: "building" }).number, N.orBcd);
});
await check("MUST-PASS: gate, portal and form fill (an 'other' form and an electrical form) all give the CCB to the generic slot", async () => {
  for (const track of ["building", "electrical", null]) {
    assert.equal(clients.contractorLicenceForState(alphaRow, "OR", track).number, N.orCcb, `gate ${track}`);
    assert.equal(fv(alphaOr, track).ccbLicenseNumber, N.orCcb, `portal ${track}`);
  }
  for (const ahj of ["City of Otherform", "City of Elecform"]) {
    const job = mk(alpha.id, "OR", { ahj });
    const { out } = await fillStored(ahj, "OR", job, `or-${ahj.replace(/\W+/g, "")}`);
    const f = (await PDFDocument.load(fs.readFileSync(out))).getForm();
    assert.equal(f.getTextField("Contractor License").getText() ?? "", N.orCcb, `${ahj}: the generic slot`);
    assert.equal(f.getTextField("Electrical License").getText() ?? "", N.orBcd, `${ahj}: the typed electrical slot`);
  }
});

// =============================================================================================
section("EXTRAS  the metro licence is Oregon's; a blank state is unknown; the editor keeps what it could not show");
await check("MUST-PASS: the metro / city licence is filed on an Oregon job and blank elsewhere (portal and forms)", () => {
  assert.equal(fv(alphaOr, "building").metroCityLicenseNumber, N.metro);
  for (const p of [alphaMa, alphaAz]) {
    assert.equal(fv(p, "building").metroCityLicenseNumber, "", `${p.state} portal`);
    assert.ok(!forms.buildContext(db, p).client.metroCityLicenseNumber, `${p.state} form context`);
  }
  assert.equal(forms.buildContext(db, alphaOr).client.metroCityLicenseNumber, N.metro);
});
await check("MUST-PASS: the resolver's own metro gate — a metro number reaching the dictionary another way (the parser snapshot) is still blank off Oregon", () => {
  const detail = repo.getProjectDetail(db, alphaMa.id).project;
  const withSnap = { ...detail, parserSnapshot: { ...(detail.parserSnapshot ?? {}), metroCityLicenseNumber: "SNAP-METRO-9" } } as ProjectRecord;
  assert.equal(recipes.resolveRecipeFieldValues(db, withSnap, "accela", "building").metroCityLicenseNumber, "");
});
await check("MUST-PASS: a project with NO recorded state emits no licence at all (unknown, never Oregon's)", () => {
  assert.equal(clients.licenceJobState(""), "");
  const o = clients.licenceOverlay(alphaRow, { state: "", track: "building" });
  for (const [k, v] of Object.entries(o)) assert.equal(v, "", k);
  const gate = clients.contractorLicenceForState(alphaRow, "");
  assert.equal(gate.number, ""); assert.equal(gate.oregon, false);
  assert.match(gate.reason, /state is not recorded/);
  const blank = mk(alpha.id, "");
  const v = fv(blank, null);
  for (const k of [...clients.LICENCE_OVERLAY_KEYS, "metroCityLicenseNumber", "docketNumber"]) assert.equal(v[k], "", `${k} on a blank-state job`);
});
await check("MUST-PASS: an unrelated Clients save keeps stored rows the editor could not show (holder-only, unreadable expiry, unknown keys); a removed row goes", () => {
  const c = clients.createClient(db, { companyName: "Editor Keep Test", stateLicenses: [{ state: "MA", kind: "EC", number: "EC-1" }] });
  const legacy = [
    { state: "MA", kind: "EC", number: "EC-1", issuedBy: "Board of State Examiners", expires: "Aug 15 2028" },
    { state: "MA", kind: "master_electrician", holder: "Held Only" },
    { state: "MA", kind: "HIC", number: "HIC-2", expires: "2027-01-31" },
  ];
  db.run("UPDATE clients SET state_licenses_json = ? WHERE id = ?", [JSON.stringify(legacy), c.id]); // rows an older import stored
  // What the editor loads and sends back (stateLicencesFromClient -> stateLicencesPayload), minus the
  // HIC row the operator removed, plus an unrelated field.
  const shown = clients.getClient(db, c.id).stateLicenses ?? [];
  const sent = shown.filter((l) => l.number !== "HIC-2").map((l) => ({ state: l.state, kind: l.kind, number: l.number, ...(l.expires ? { expires: l.expires } : {}), ...(l.holder ? { holder: l.holder } : {}) }));
  clients.updateClient(db, c.id, { phone: "5555550000", stateLicenses: sent });
  const raw = JSON.parse(db.get<{ state_licenses_json: string }>("SELECT state_licenses_json FROM clients WHERE id = ?", [c.id])!.state_licenses_json) as Array<Record<string, unknown>>;
  const ec = raw.find((r) => r.number === "EC-1");
  assert.ok(ec, JSON.stringify(raw));
  assert.equal(ec!.issuedBy, "Board of State Examiners", "an unknown key was dropped");
  assert.equal(ec!.expires, "Aug 15 2028", "an unreadable expiry was dropped");
  assert.ok(raw.some((r) => r.holder === "Held Only" && !r.number), "a holder-only row was dropped");
  assert.ok(!raw.some((r) => r.number === "HIC-2"), "MUST-EXCLUDE: the row the operator removed came back");
});

// =============================================================================================
section("K1  a credential in a shared note is never served, and v42 drops it from unverified rows (rules 2 + 3)");
// Synthetic legacy rows (the write guard now refuses these shapes, so an older import is the only
// way they exist — hence raw SQL). Never a real handle or password.
const SECRET_PAIR = "SynthHandle & Zz9synth!x";
const SECRET_LABEL = "Password: notreal123";
const LEGACY_NOTES = `Upload the plan set as one PDF | ${SECRET_PAIR} | ${SECRET_LABEL} | Fees are invoiced later`;
const insKb = (key: string, notes: string, verifiedAt: string | null) => db.run(
  `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, notes, confidence, verified_at, first_seen_at, last_learned_at, updated_at)
   VALUES (?, ?, 'OH', ?, '', ?, 'seeded', ?, '2026-01-01', '2026-01-01', '2026-01-01')`, [`id-${key}`, key, `Synthville ${key}`, notes, verifiedAt]);
insKb("k1|unverified", LEGACY_NOTES, null);
insKb("k1|verified", LEGACY_NOTES, "2026-09-01T00:00:00Z");
insKb("k1|clean", "Upload the plan set as one PDF | Contact permits@synthville.gov for corrections", null);
await check("MUST-PASS: GET /api/knowledge-base (getKnowledgeBase) serves no credential segment — the knowledge around it stays", () => {
  const served = repo.getKnowledgeBase(db).profiles.filter((p) => String(p.profileKey).startsWith("k1|"));
  assert.equal(served.length, 3);
  for (const p of served) {
    assert.ok(!p.notes.includes("Zz9synth") && !p.notes.includes("notreal123"), `${p.profileKey} served a credential`);
    assert.ok(p.notes.includes("Upload the plan set as one PDF"), `${p.profileKey} lost its knowledge`);
  }
});
await check("MUST-PASS: migration v42 drops the credential segments from the UNVERIFIED row; the verified row and a clean row are byte-identical (rule 3)", async () => {
  db.run("DELETE FROM schema_meta WHERE version >= 42");
  const db2 = await openDatabase();
  const raw = (k: string) => db2.get<{ notes: string }>("SELECT notes FROM permit_utility_knowledge WHERE profile_key = ?", [k])!.notes;
  assert.equal(raw("k1|unverified"), "Upload the plan set as one PDF | Fees are invoiced later");
  assert.equal(raw("k1|verified"), LEGACY_NOTES, "a human-verified row was rewritten");
  assert.equal(raw("k1|clean"), "Upload the plan set as one PDF | Contact permits@synthville.gov for corrections");
  const again = kb.purgeCredentialNoteSegments(db2);
  assert.equal(again.cleaned.length, 0, "not idempotent");
  assert.ok(again.keptVerified.length >= 1, "the verified row is counted for the operator");
});

// =============================================================================================
section("K2  an in-person clause that refuses — or merely allows — in-person never outranks a portal");
await check("MUST-PASS / MUST-EXCLUDE: channelKindOf reads the in-person clause on its own", () => {
  assert.equal(channelKindOf({ channel: "In-person submittals are not accepted; apply online", portalUrl: "" }), "portal");
  assert.equal(channelKindOf({ channel: "Apply online; in-person drop off also accepted", portalUrl: "" }), "portal");
  assert.equal(channelKindOf({ channel: "BPA: In person EPA: Bernalillo County accela (seeded AHJ profile — verify)", portalUrl: "" }), "in_person");
});

// =============================================================================================
section("K3  an old registry form on disk rides the packet only while it still matches the project");
await check("MUST-PASS / MUST-EXCLUDE: the Portland OR registry fill packages on a Portland OR job, never on a Portland ME job", () => {
  const put = (p: ProjectRecord) => { const f = forms.filledFormPath(p.id, "portland-electrical-renewable-energy"); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "%PDF-1.4\n% stale fill\n"); };
  const orPortland = mk(alpha.id, "OR", { ahj: "City of Portland", city: "Portland", zip: "97201" });
  const mePortland = mk(alpha.id, "ME", { ahj: "City of Portland", city: "Portland", zip: "04101" });
  put(orPortland); put(mePortland);
  assert.equal(forms.filledApplicationForms(db, orPortland.id).length, 1, "MUST-PASS: Oregon's own Portland keeps its fill");
  assert.equal(forms.filledApplicationForms(db, mePortland.id).length, 0, "an Oregon form rode a Maine job's packet");
});

// =============================================================================================
section("K4  'is this Oregon' in the code-review rules is the project's state");
await check("MUST-PASS / MUST-EXCLUDE: a blank-state 'City of Salem' job gets no Oregon citations; an OR job does", () => {
  const refsFor = (state: string, ahj: string) => {
    const f = evaluateDesignCodeFindings({ state, ahj, parserSnapshot: {} } as unknown as ProjectRecord, null).find((x) => x.id === "city.struct.framing-missing");
    assert.ok(f, "setup: the framing finding fires on an empty design");
    return (f!.codeReferences ?? []).map((r) => r.code).join(" | ");
  };
  // The Oregon WORKSHEET refs (ORSC / OSSC prescriptive checklist, the OSSC span table) — the legacy
  // roof-loads constant is labelled "IRC / ORSC" everywhere, so OSSC is the Oregon-only marker.
  assert.match(refsFor("OR", "City of Salem"), /OSSC/);
  for (const [st, ahj] of [["", "City of Salem"], ["", "Portland"], ["", "Washington County"], ["MA", "City of Salem"]]) {
    assert.doesNotMatch(refsFor(st, ahj), /OSSC/, `${st || "blank"}/${ahj}`);
  }
});

console.log(`\nlicenceLeakClose: ${failures ? `${failures} FAILED, ` : "all "}${passed} passed${failures ? "" : " — each licence by its label's kind at learn and replay, Oregon's columns Oregon's, no credential served, no stale form packaged"}`);
if (failures) process.exit(1);
process.exit(0);
