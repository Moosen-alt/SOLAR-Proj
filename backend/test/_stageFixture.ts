// A PROJECT THAT CLEARS EVERY STAGING GATE, AND A COMPLETE RECIPE FOR ITS AHJ — so a test can
// drive the REAL prepareSubmission down the RecipeAdapter branch with only the browser stubbed
// (repository.setRecipeStageRunnerForTests). Shared by the replay-trust tests.
//
// The fixture is the smoke's own (backend/src/smoke.ts, as stageDetail.test.ts uses it): a
// Portland / PGE prescriptive job PROVEN to clear QC, the document gate and the reviewer gate.
// The recipe is AHJ-scoped (state OR, ahj Portland, utility PGE) with a non-utility portal URL,
// and every stage is TRACKLESS — the exact gate path stageDetail already proves clears.
//
// Usage (after `import "./_isolate"` and BEFORE any ../src import):
//   const fx = await setupStageFixture("my-test");
// It sets the env, opens a scratch DB, and returns the real modules plus helpers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeStep } from "../../shared/src/types";

export async function setupStageFixture(tag: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
  process.env.BACKUP_DIR = path.join(tmpDir, "backups");
  process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
  process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
  process.env.SEED_TEST_INSTALLER = "false";
  process.env.AUTOPILOT_AUTO_START = "0";
  process.env.PORTAL_AUTOSEED = "0";
  process.env.MOCK_PORTAL = "1";
  process.env.RUN_TRIAGE = "off";
  process.env.AUTOPILOT_TEST_SEAMS = "1";
  // No LLM, no network: no cold-start research, no auto re-learn enqueue (which would drain a
  // live auto_learn job and open a browser).
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  delete process.env.SMTP_HOST;
  delete process.env.CLIENT_NOTIFICATIONS;
  delete process.env.PORTAL_AUTOMATION;

  const dbMod = await import("../src/db");
  const clients = await import("../src/clients");
  const docs = await import("../src/projectDocuments");
  const repo = await import("../src/repository");
  const recipes = await import("../src/portalRecipes");
  const db = await dbMod.openDatabase();
  if (/autopilot\.sqlite$/.test(String(process.env.AUTOPILOT_DB_PATH))) throw new Error("tests must run on a scratch DB");

  const client = clients.createClient(db, {
    companyName: "Replay Trust Solar LLC",
    legalBusinessName: "Replay Trust Solar LLC",
    ccbLicenseNumber: "240136",
    electricalLicenseNumber: "C1235",
    businessEmail: "ops@replaytrust.test",
    businessPhone: "(503) 555-0143",
  });

  const FIXTURE = {
    owner: "Replay Trust Owner", street: "123 Solar Way", city: "Portland", state: "OR", zip: "97201",
    ahj: "Portland", utility: "PGE", account: "1234567890", meter: "987654321",
    dcKw: "8.6", acKw: "6.5", exportKw: "6.5",
    moduleMake: "Qcells", moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20",
    invModel: "IQ8M", invQty: "20", invOutputW: "325",
    interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40",
    permitPath: "PRESCRIPTIVE", roofRafterSpacing: "24", roofRafterSpan: "10", snow: "25", deadLoad: "3.2", wind: "B",
    locateCalloutText: "No locate-triggering scope found.",
    sitePlanNotesText: "Roof plan shows fire access pathway, ridge/eave setbacks, array dimensions, service equipment, and PV layout.",
    roofPlanNotesText: "Roof framing: 2x6 rafters at 24 inches on center, 10 ft clear span, roof slope 5:12. Racking attachment detail shows flashed standoffs lagged to rafters.",
    structuralCalcText: "Oregon prescriptive rooftop PV worksheet complete. Dead load 3.2 psf, ground snow 25 psf, wind exposure B, rafter span checked.",
    electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A. NEC 690.12 rapid shutdown shown.",
    labelsText: "PV label schedule includes rapid shutdown label, service power source directory, disconnect labels, and backfed breaker warning.",
    splitPagesText: "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation and rapid shutdown: page 3\n03 Roof framing and racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12",
    utilityDownloadChecklistText: "PGE package includes SLD/3-line, site/plot plan, module spec, inverter spec, utility bill, meter data, and account data.",
    packetReadinessText: "READY - Plan set\nREADY - Utility bill\nREADY - Module spec\nREADY - Inverter spec",
  };

  let seq = 0;
  /** A fresh project that clears every gate (its own row, so tests never share state). */
  const newProject = (overrides: Partial<typeof FIXTURE> = {}): string => {
    seq += 1;
    const created = repo.createProject(db, { clientId: client.id, ...FIXTURE, owner: `Replay Owner ${seq}`, street: `${100 + seq} Solar Way`, ...overrides });
    const projectId = created.project.id;
    docs.saveProjectDocument(db, projectId, {
      docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n% replay trust plan set\n", "utf8"), source: "upload",
    });
    return projectId;
  };

  const fills = (n: number): RecipeStep[] =>
    Array.from({ length: n }, (_, i) => ({ action: "fill", selector: { name: `f${i}` }, field: "homeownerName", value: "Jane Doe", note: `Field ${i}` } as RecipeStep));
  const REVIEW: RecipeStep = { action: "stopForReview", selector: {} } as RecipeStep;
  const FINAL: RecipeStep = { action: "click", selector: { text: "Submit Application" }, isFinalSubmit: true, note: "final submit" } as RecipeStep;

  /** THE complete recipe for the fixture's AHJ, written through the real writers (a fresh
   *  version each call — startPortalRecording resets the one row the key owns). */
  const completeRecipe = (steps: RecipeStep[] = [...fills(4), REVIEW, FINAL]) => {
    const r = recipes.startPortalRecording(db, {
      scopeType: "ahj", state: "OR", ahj: "Portland", utility: "PGE",
      portalUrl: "https://permits.portland.example/apply", portalPlatform: "accela", createdBy: "test",
    });
    return recipes.savePortalRecipeSteps(db, r.id, steps, { status: "complete", notes: "Auto-learned and verified (high confidence)." });
  };

  type Runner = Parameters<typeof repo.setRecipeStageRunnerForTests>[0];
  /** Replace the browser with a function returning this adapter result (or throwing). */
  const stubRunner = (fn: NonNullable<Runner>) => repo.setRecipeStageRunnerForTests(fn);
  const failingStep = (message: string, data: Record<string, unknown> = {}) => ({
    portalName: "stub", ok: false, finalSubmitClicked: false, pauseReason: null,
    steps: [
      { ok: true, message: "Opened stub portal." },
      { ok: false, message, data },
      // The review step's human boilerplate — carries "MFA/fee", exactly as recipeAdapter's does.
      { ok: true, message: "Human review required. Verify all fields and click submit manually. Handle any MFA/fee, then click submit manually. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } },
    ],
  });

  const latestRun = (projectId: string) => db.get<Record<string, unknown>>(
    "SELECT * FROM portal_runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1", [projectId]);
  const recipeRow = (recipeId: string) => db.get<Record<string, unknown>>("SELECT * FROM portal_recipes WHERE id = ?", [recipeId])!;
  const audits = (action: string) => db.query<{ details: string; project_id: string | null; actor_name: string }>(
    "SELECT details, project_id, actor_name FROM audit_logs WHERE action = ? ORDER BY created_at", [action]);

  return { db, repo, recipes, client, newProject, completeRecipe, fills, REVIEW, FINAL, stubRunner, failingStep, latestRun, recipeRow, audits };
}

let failures = 0;
export const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });
export const finish = (name: string): void => {
  if (failures) {
    console.error(`\n${failures} ${name} test(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${name} tests passed.`);
  process.exit(0);
};
