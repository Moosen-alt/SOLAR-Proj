// ONE FORM SEARCH PER AHJ/PATH AT A TIME, AND EVERY DOOR KNOWS IT IS RUNNING.
//
// Live 2026-09-28, the operator's first never-seen AHJ (City of Beaverton, OR; engineered path;
// building + electrical tracks). The automatic chain claimed the 24h research cooldown BEFORE it
// awaited its search — from that instant the gate read "research closed" and told the operator to
// "find the official form (App Docs → Find missing official forms) or upload the blank" while the
// chain was finding it. The operator clicked Find, twice. Three passes × two form types ran at once
// (six searches, 727 s of model time, five writes to the same KB profile), and nothing at any door
// knew a pass was already running. The operator's words: "should be done by default if unknown
// AHJ … it also looks like its getting lost finding the forums".
//
// For ANY AHJ (nothing here is Beaverton-specific in the code under test):
//   MUST-PASS   while the pass runs, the gate's ONE predicate (owedMissingDocuments) keeps the
//               application rows in acquiredAtStaging with inFlight, never in owed; the submit gate's
//               document check is not a blocker and says "searching for it now"; a second door (the
//               operator's Find) JOINS the running pass — exactly one findAhjFormUrl per form type,
//               identical results to the pass it joined; another project with the same AHJ/path waits
//               and then pays nothing; the pass leaves an ahj_form.find audit like the button does.
//   MUST-EXCLUDE the vacuity guard: after the pass (nothing found) the same rows ARE owed and
//               stageAcquiresForm is null — "no signal, no demand" would pass everything above
//               trivially. No network: fetch is stubbed to reject and asserted never called.
//
//   npx tsx backend/test/formResearchSingleFlight.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AhjFormUrlResult, LLMProvider } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "form-research-single-flight-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmp, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "PERMIT_PROCESS_LOOKUP", "UTILITY_FILING_LOOKUP"]) process.env[k] = "off";
// Downloads ON, fetch ON, research ON (a dummy key: stageAcquisitionFor reads formResearchAllowed()
// directly) — the gate's `acquires` / `researchOpen` are false otherwise and the research branch under
// test is never reached. The model is injected; the network is a stub that refuses.
for (const k of ["DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH"]) delete process.env[k];
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
process.env.DOCUMENT_FETCH_BROWSER = "0";

const fetchCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => { fetchCalls.push(String(input)); throw new Error("no network in this test"); }) as typeof fetch;

const { openDatabase } = await import("../src/db");
const repo = await import("../src/repository");
const auto = await import("../src/ahjFormAuto");
const plan = await import("../src/formAcquisitionPlan");
const { prepareOfficialDocuments } = await import("../src/prepareOfficialDocuments");
const { documentInventory, owedMissingDocuments, isApplicationFormRow } = await import("../src/requiredDocuments");
const { formAuthorityFor } = await import("../src/applicationDocsAgency");

const db = await openDatabase();

let passed = 0;
const failed: string[] = [];
const check = (name: string, cond: unknown, detail = ""): void => {
  if (cond) { passed++; return; }
  failed.push(name);
  console.error(`  FAIL - ${name}${detail ? `\n         ${detail.slice(0, 900)}` : ""}`);
};

// ── the injected model: every findAhjFormUrl call is a DEFERRED promise the test resolves ────────
type Deferred = { formType: string; ahj: string; resolve: (r: Partial<AhjFormUrlResult>) => void; reject: (e: Error) => void };
const pending: Deferred[] = [];
const calls: string[] = [];
const waiters: Array<() => void> = [];
const nextCall = (): Promise<void> => new Promise((r) => { waiters.push(r); });
const llm = {
  findAhjFormUrl(input: { ahj: string; formType?: string }) {
    const formType = input.formType || "permit_application";
    calls.push(`${input.ahj}:${formType}`);
    return new Promise<AhjFormUrlResult>((resolve, reject) => {
      pending.push({
        formType, ahj: input.ahj,
        resolve: (r) => resolve({ provider: "claude", formName: "", candidateUrls: [], formType, confidence: "medium", notes: "", ...r }),
        reject,
      });
      for (const w of waiters.splice(0)) w();
    });
  },
  async mapAcroFormFields() { return { provider: "claude", textFields: {}, checkboxes: {}, notes: "" }; },
  async mapFlatFormOverlay() { return { provider: "claude", fields: [], signatures: [], notes: "" }; },
} as unknown as LLMProvider;
const fp = { reader: null, minGapMs: 0 };
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

const projectIds: string[] = [];
// A synthetic owner/address on the operator's real AHJ/path: its seeded process note files SEPARATE
// building + electrical permits, so the required set demands both applications (the vacuity guard
// below proves it rather than assuming it).
const mk = (owner: string) => {
  const p = repo.createProject(db, {
    owner, street: "1 Fixture Rd", city: "Beaverton", state: "OR", zip: "97005", ahj: "City of Beaverton", utility: "Portland General Electric",
    dcKw: "8.1", acKw: "7.6", permitPathOverride: "engineered", mounting: "Roof Mount", structureDescription: "Single-family dwelling",
  } as never).project;
  projectIds.push(p.id);
  return p;
};
const appRows = (pid: string) => {
  const project = repo.getProjectDetail(db, pid).project;
  const inv = documentInventory(db, project);
  const gate = owedMissingDocuments(db, project, inv);
  const apps = (rows: typeof gate.owed) => rows.filter((d) => d.lane === "permit" && isApplicationFormRow(d)).map((d) => d.docType).sort();
  return { project, gate, owedApps: apps(gate.owed), acquiredApps: apps(gate.acquiredAtStaging), inFlight: gate.acquiredAtStaging.map((d) => gate.acquiredVia.get(d)?.inFlight?.since ?? null) };
};

try {
  const a = mk("Single Flight Owner");
  const key = plan.acquisitionScopeKey(a, "engineered");

  // ═══ 0. THE FIXTURE REACHES THE RESEARCH BRANCH (no signal, no demand — prove the signal) ═══════
  const before = appRows(a.id);
  check("0 the required set demands both applications (structure: separate)", JSON.stringify(before.owedApps.concat(before.acquiredApps).sort()) === JSON.stringify(["building_application", "electrical_application"]),
    JSON.stringify({ owed: before.owedApps, acquired: before.acquiredApps, blocking: before.gate.owed.map((d) => d.docType) }));
  check("0 no free source (curated seed / BCD checklist) answers either — research is the only route", ["building_application", "electrical_application"].every((t) => plan.ownFreeFormSource(a, t, "structural") === null));
  check("0 the AHJ issues its own permits here (no issuing-agency plan in the way)", ["building_application", "electrical_application"].every((t) => formAuthorityFor(a, t).issuedByOther === false));
  check("0 before any pass: research is open, so the gate already counts both as acquired-at-staging (not in flight)", before.owedApps.length === 0 && before.acquiredApps.length === 2 && before.inFlight.every((s) => s === null),
    JSON.stringify(before));
  check("0 nothing is in flight yet", plan.formResearchInFlight(key) === null);

  // ═══ 1. THE CHAIN'S / STAGE'S PASS STARTS — and the same tick, the registry knows ════════════════
  const firstCall = nextCall();
  const pass = prepareOfficialDocuments(db, a, { llm, research: true, formsPage: fp });
  check("1 MUST-PASS the pass is registered in the SAME TICK as the cooldown claim (no await between)", plan.formResearchInFlight(key) !== null && plan.acquisitionCooldownOpen(db, key) === false,
    JSON.stringify({ inFlight: plan.formResearchInFlight(key)?.since, cooldownOpen: plan.acquisitionCooldownOpen(db, key) }));
  await firstCall;
  check("1 the search is running (findAhjFormUrl called once, for the first form type)", calls.length === 1, JSON.stringify(calls));

  // ═══ 2. MID-FLIGHT, THE GATE SAYS "SEARCHING NOW" — never "find it or upload the blank" ═════════
  const mid = appRows(a.id);
  check("2 MUST-PASS both application rows stay acquired-at-staging, marked in flight, and none is owed", mid.owedApps.length === 0 && mid.acquiredApps.length === 2 && mid.inFlight.length === 2 && mid.inFlight.every(Boolean),
    JSON.stringify({ owed: mid.owedApps, acquired: mid.acquiredApps, inFlight: mid.inFlight }));
  const gateMid = repo.getSubmitGateReport(db, a.id);
  const docCheck = gateMid.checks.find((c) => c.id === "document-inventory");
  // (The fixture has no plan sheets, so the check still blocks on THOSE — the applications are what
  // this pins: never "find the official form", said as "searching for it now".)
  check("2 MUST-PASS the submit gate's document check names no application as owed mid-flight and says Stage is searching now", docCheck != null
    && /searching for it now \(started \d\d:\d\d UTC\)/.test(docCheck.evidence.join(" | ")) && !/find the official form/.test(docCheck.nextAction)
    && !/permit application/i.test(docCheck.nextAction) && !docCheck.evidence.some((e) => /^MISSING \(required\):.*permit application/i.test(e)),
    JSON.stringify({ status: docCheck?.status, evidence: docCheck?.evidence, nextAction: docCheck?.nextAction }));
  const acq = plan.stageAcquisitionFor(db, a);
  check("2 stageAcquiresForm reports the research in flight although the cooldown is claimed (researchOpen false)", acq.researchOpen === false
    && plan.stageAcquiresForm(db, a, "building_application", "structural", acq)?.inFlight?.since === plan.formResearchInFlight(key)?.since);

  // ═══ 3. A SECOND DOOR JOINS THE RUNNING PASS instead of starting another ═════════════════════════
  const manual = auto.ensureAhjFormsForProject(db, llm, a); // the operator's Find (server find-ahj-form): research allowed
  await settle();
  check("3 MUST-PASS the joining door started no search of its own", calls.length === 1, JSON.stringify(calls));
  // Another project on the same AHJ/path arrives too (a second job for the same city).
  const b = mk("Second Job Owner");
  const other = auto.ensureAhjFormsForProject(db, llm, b);
  await settle();
  check("3 MUST-PASS neither did the other project's door", calls.length === 1, JSON.stringify(calls));
  // Let the pass run: resolve the first form type, wait for the second, resolve it (nothing found).
  const secondCall = nextCall();
  pending.shift()!.resolve({});
  await secondCall;
  check("3 the pass then searched the second form type (one search per type, sequential)", calls.length === 2 && calls[1].endsWith(":electrical_application"), JSON.stringify(calls));
  pending.shift()!.resolve({});
  const [prep, joined, otherOut] = await Promise.all([pass, manual, other]);
  check("3 exactly ONE findAhjFormUrl per form type across three doors", calls.length === 2, JSON.stringify(calls));
  check("3 MUST-PASS the joining door took the pass's result verbatim, and says it joined", joined.joined?.since != null
    && JSON.stringify(joined.results.map((r) => `${r.formType}:${r.status}`)) === JSON.stringify(prep.results.map((r) => `${r.formType}:${r.status}`)),
    JSON.stringify({ joined: joined.joined, mine: joined.results.map((r) => `${r.formType}:${r.status}`), theirs: prep.results.map((r) => `${r.formType}:${r.status}`) }));
  check("3 the pass itself did not join anything", prep.acquisition === "full" && prep.joined == null, JSON.stringify(prep));
  check("3 the other project waited, then answered its own set with NO search (a free pass)", otherOut.joined?.since != null && otherOut.results.length === 2 && calls.length === 2,
    JSON.stringify({ joined: otherOut.joined, results: otherOut.results.map((r) => `${r.formType}:${r.status}`), calls }));
  check("3 the registry is clear once the pass settles", plan.formResearchInFlight(key) === null);
  const audits = db.query<{ details: string }>("SELECT details FROM audit_logs WHERE project_id = ? AND action = 'ahj_form.find'", [a.id]).map((r) => JSON.parse(r.details));
  check("3 MUST-PASS the automatic pass left the same ahj_form.find audit the button leaves (via: stage)", audits.length === 1 && audits[0].via === "stage" && audits[0].acquisition === "full"
    && String(audits[0].status) === "not_found", JSON.stringify(audits));

  // ═══ 4. AFTER THE PASS (nothing found): the demand is real — the same rows are OWED now ═══════════
  const after = appRows(a.id);
  check("4 MUST-EXCLUDE (vacuity guard) after a completed empty search the rows are owed and nothing is acquired-at-staging", after.owedApps.length === 2 && after.acquiredApps.length === 0,
    JSON.stringify({ owed: after.owedApps, acquired: after.acquiredApps }));
  check("4 stageAcquiresForm is null for both (cooldown claimed, nothing in flight, nothing stored)", ["building_application", "electrical_application"]
    .every((t) => plan.stageAcquiresForm(db, a, t, "structural", plan.stageAcquisitionFor(db, a)) === null));
  const gateAfter = repo.getSubmitGateReport(db, a.id).checks.find((c) => c.id === "document-inventory");
  check("4 and the gate's document check is a blocker again that says what to do", gateAfter?.status === "blocker" && /find the official form/.test(gateAfter.nextAction), JSON.stringify(gateAfter?.nextAction));

  // ═══ 5. A PASS THAT THROWS still clears the registry (a joiner is not stuck forever) ═════════════
  const c = mk("Throwing Pass Owner");
  const cKey = plan.acquisitionScopeKey(c, "engineered");
  const throwing = auto.ensureAhjFormsForProject(db, llm, c);
  await nextCall();
  check("5 registered while running", plan.formResearchInFlight(cKey) !== null);
  pending.shift()!.reject(new Error("model down"));
  await throwing.catch(() => undefined);
  await settle();
  check("5 cleared after the rejection", plan.formResearchInFlight(cKey) === null);

  check("no network: fetch was never called", fetchCalls.length === 0, JSON.stringify(fetchCalls));
  check("no job ran (nothing queued a lookup with the switches off)", db.query("SELECT id FROM job_queue WHERE status NOT IN ('done')").length === 0, JSON.stringify(db.query("SELECT job_type, status FROM job_queue")));

  assert.equal(failed.length, 0, `${failed.length} check(s) failed: ${failed.join(" | ")}`);
  console.log(`formResearchSingleFlight: ${passed} checks passed — one form search per AHJ/path at a time: registered in the same tick as the cooldown claim; mid-flight the gate keeps the applications acquired-at-staging (in flight) and says "searching for it now", never "find it or upload the blank"; a second door joins the running pass (one findAhjFormUrl per form type, identical results), another project waits and pays nothing; the automatic pass leaves an ahj_form.find audit; after an empty search the rows are owed (vacuity guard); a throwing pass clears the registry; no network`);
} finally {
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = realFetch;
  db.close();
  for (const id of projectIds) fs.rmSync(path.resolve("backend/data/filled", id), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
