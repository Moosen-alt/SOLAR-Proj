// THE LOOKUP TRIGGER'S GATE (#70). ensurePermitProcessLookedUp skipped the per-job permit-process
// lookup for ANY AHJ with a seeded process profile (`findAhjProcessProfile`), so a seeded row that
// does not answer the process — a bare row, or a state-issuer (New Mexico CID) row like Los Lunas's
// "Send Zoning App and Site Plan … then send to NM CID" — kept the lookup from ever being queued.
// The gate is applicationDocs.shippedProfileIsAuthoritative: skip ONLY for a hand-written profile or
// a seeded row whose words settle the structure; a person-verified lookup row still skips (rule 3).
//
// No network: the reference is synthetic, the model key is a placeholder, and every queued job is
// marked failed synchronously after the trigger returns — before enqueueJob's deferred kick can
// claim it.
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppl-trigger-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.DOCUMENT_FETCH = "off";
process.env.PORTAL_AUTOMATION = "off";
delete process.env.PERMIT_PROCESS_LOOKUP;

const profile = (o: Record<string, unknown>) => ({
  state: "NM", ahj: "", submissionMethod: "", timeline: "", requiresElectricianSign: false, requiresElectricalStamp: false,
  requiresStructuralStamp: false, requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false,
  requiresSolarChecklist: false, requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false,
  requiresFloodplainCheck: false, requiresJurisdictionCheck: false, otherRequirements: "", reviewerNotes: "", sourceSheet: "(test)", ...o,
});
const REFERENCE = path.join(tmp, "reference-ahj-processes.json");
fs.writeFileSync(REFERENCE, JSON.stringify({ profiles: [
  // Los Lunas-shaped: empty submission method, a note that routes the electrical permit to the state.
  profile({ ahj: "Los Brazos", reviewerNotes: "Send Zoning App and Site Plan to Los Brazos. Once approved, then send to NM CID for electrical permit." }),
  // A bare row: flags, no words.
  profile({ ahj: "Bernal County", submissionMethod: "In-person: appointment only", requiresElectricianSign: true }),
  // A seeded row whose own words settle the structure.
  profile({ ahj: "Tres Alamos", submissionMethod: "Email", reviewerNotes: "Apply for the building and electrical permits separately." }),
] }));
process.env.AHJ_PROCESS_REFERENCE_PATH = REFERENCE;

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail.slice(0, 600)}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const { openDatabase } = await import("../src/db");
const { ensurePermitProcessLookedUp } = await import("../src/permitProcessLookup");
const { shippedProfileIsAuthoritative } = await import("../src/applicationDocs");
const { findAhjProcessProfile } = await import("../src/processProfiles");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const jobQueue = await import("../src/jobQueue");

const db = await openDatabase();
clearInterval(jobQueue.startJobWorker(db));
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";

let seq = 0;
const projectLike = (o: Record<string, unknown>) => ({
  id: `trig-${++seq}`, clientId: null, state: "NM", ahj: "", city: "", utility: "Mesa Electric", homeownerName: "Owner", projectAddress: "1 Way", zip: "87500",
  systemSizeDcKw: 6, systemSizeAcKw: 5, parserSnapshot: {}, status: "parsed", ...o,
});
const queuedFor = (ahj: string): number =>
  db.query<{ id: string }>("SELECT id FROM job_queue WHERE job_type = 'permit_process_lookup' AND payload LIKE ?", [`%"ahj":${JSON.stringify(ahj)}%`]).length;
// Runs the trigger, then — synchronously, before the enqueue kick's macrotask — retires the job.
const trigger = async (p: ReturnType<typeof projectLike>): Promise<boolean> => {
  const queued = await ensurePermitProcessLookedUp(db, p);
  db.run("UPDATE job_queue SET status = 'failed' WHERE job_type = 'permit_process_lookup' AND status IN ('pending','running')");
  return queued;
};

try {
  // (1) Los Lunas-style: a seeded row exists, but it is not authoritative → the lookup is queued.
  const losBrazos = projectLike({ ahj: "Village of Los Brazos", city: "Los Brazos" });
  check("(1a) precondition: the seeded Los Brazos row matches the village", Boolean(findAhjProcessProfile(losBrazos as never)));
  check("(1b) precondition: that row is not authoritative (state issuer)", shippedProfileIsAuthoritative(losBrazos as never) === false);
  const q1 = await trigger(losBrazos);
  check("(1c) MUST-PASS: a seeded state-issuer row (Los Lunas shape) queues the per-job lookup", q1 === true && queuedFor("Village of Los Brazos") === 1,
    `returned ${q1}, rows ${queuedFor("Village of Los Brazos")}`);

  // (2) A bare seeded row → queued.
  const bernal = projectLike({ ahj: "Bernal County", city: "Bernal" });
  const q2 = await trigger(bernal);
  check("(2) MUST-PASS: a bare seeded row ('In-person: appointment only') queues the per-job lookup", q2 === true && queuedFor("Bernal County") === 1);

  // (3) A seeded row whose words settle the structure → still skipped.
  const tres = projectLike({ ahj: "Tres Alamos", city: "Tres Alamos" });
  const q3 = await trigger(tres);
  check("(3) MUST-EXCLUDE: a seeded row whose words settle the structure is authoritative — skipped", q3 === false && queuedFor("Tres Alamos") === 0);

  // (4) A hand-written (curated) application profile → still skipped.
  const marion = projectLike({ state: "OR", ahj: "Marion County", city: "Keizer", utility: "PGE", zip: "97303" });
  check("(4a) precondition: the hand-written Marion County profile is authoritative", shippedProfileIsAuthoritative(marion as never) === true);
  const q4 = await trigger(marion);
  check("(4b) MUST-EXCLUDE: a hand-written profile is authoritative — skipped", q4 === false && queuedFor("Marion County") === 0);

  // (5) A person-verified lookup row for a non-authoritative seeded AHJ → skipped, never re-asked (rule 3).
  const verified = projectLike({ ahj: "Village of Los Brazos", city: "Los Brazos" });
  db.run("DELETE FROM job_queue WHERE job_type = 'permit_process_lookup'");
  const saved = savePermitProcessLookup(db, {
    state: "NM", ahj: "Village of Los Brazos", permits: [], lookedUpAt: new Date().toISOString(), confidence: "verified",
  } as never, { verifiedBy: "reviewer@example.test" });
  check("(5a) precondition: a verified lookup row was saved", saved.saved === true, JSON.stringify(saved).slice(0, 300));
  const q5 = await trigger(verified);
  check("(5b) MUST-EXCLUDE: a person-verified lookup row is never re-asked — skipped", q5 === false && queuedFor("Village of Los Brazos") === 0);
} finally {
  delete process.env.ANTHROPIC_API_KEY;
  db.run("UPDATE job_queue SET status = 'failed' WHERE status IN ('pending','running')");
}

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
