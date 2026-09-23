// CORRECTION LEARNING STORES THE FINAL CLASSIFICATION, AND LEARNED PATTERNS REACH A CHECK
// (L4 + L7).
//
// L4: a live correction's historical_failure_examples row was written ONCE, at intake, from the
// regex classifier's guess — the paid triage result and the operator's resolve never reached it,
// and nothing could remove a false rejection (production: correction cb3cf605 triaged to
// C_reviewer_clarification while the KB still "knew" a B_designer_fix for Coos Bay). The row is
// now keyed by correction_id and re-derived from the corrections row on triage and resolve;
// C (reviewer clarification) means no row; an operator retraction is sticky.
//
// L7: the checklist title picks the evidence topic, and it read the raw sample through a bare
// /ess/ — "address", "necessary", "process" all became a battery item. Titles and severity now
// read root cause + required action only, with \bESS\b; "Labels/Placards" maps to the labels
// evidence topic and "Application Form" to the application package's own missing-field check.
//
// Everything goes through the real write paths: addManualCorrection (intake), persistTriage (the
// agent's persistence), resolveCorrection, retractCorrectionLearning, and the real risk report.
// Run: npx tsx backend/test/correctionLearning.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-learning-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.CLIENT_NOTIFICATIONS = "off";
process.env.BACKGROUND_WORKERS = "off";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.AHJ_FORM_RESEARCH = "off";
process.env.FEE_RESEARCH = "off";
process.env.PORTAL_URL_RESEARCH = "off";
process.env.RUN_TRIAGE = "off";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY; // intake must not enqueue a real triage; persistTriage is driven directly

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const kb = await import("../src/knowledgeBase");
const { persistTriage } = await import("../src/correctionAgent");
const { buildHistoricalFailureReport } = await import("../src/historicalFailures");
const { buildApplicationDocumentPackage } = await import("../src/applicationDocs");
const db = await openDatabase();

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const AHJ = "Learnville";
const UTILITY = "Pacific Power";
const key = kb.knowledgeProfileKey({ state: "OR", ahj: AHJ, utility: UTILITY });
function makeProject(owner: string, snapshot: Record<string, unknown> = {}): string {
  const { project } = R.createProject(db, {
    owner, street: "1 Test St", city: AHJ, state: "OR", zip: "97000", ahj: AHJ, utility: UTILITY, dcKw: "5", acKw: "4", ...snapshot,
  } as never);
  return project.id;
}
const hfe = (correctionId: string) =>
  db.query<{ correction_bucket: string; root_cause: string; required_action: string }>(
    "SELECT correction_bucket, root_cause, required_action FROM historical_failure_examples WHERE correction_id = ?", [correctionId],
  );
const shared = () => JSON.parse(String(db.get<{ c: string }>("SELECT common_corrections_json c FROM permit_utility_knowledge WHERE profile_key = ?", [key])?.c || "[]")) as Array<{ bucket: string; rootCause: string; count: number }>;
const newestCorrection = (projectId: string) => R.getProjectDetail(db, projectId).corrections[0];
const triage = (projectId: string, correctionId: string, bucket: string, rootCause: string, requiredAction: string) =>
  persistTriage(db, { correctionId, projectId }, { bucket: bucket as never, rootCause, requiredAction, actions: [], proposals: [] });

const p1 = makeProject("Learning One");

// ── L4.1 intake learns the regex guess, keyed by the correction ──────────────────────────────
R.addManualCorrection(db, p1, "Please provide the necessary rafter span calculations stamped by an engineer.");
const c1 = newestCorrection(p1);
check("SETUP: intake classified the correction B_designer_fix", c1.correctionBucket === "B_designer_fix", c1.correctionBucket);
check("intake wrote ONE failure row keyed by the correction", hfe(c1.id).length === 1 && hfe(c1.id)[0].correction_bucket === "B_designer_fix", JSON.stringify(hfe(c1.id)));
check("the shared rollup carries the pattern", shared().some((p) => p.bucket === "B_designer_fix"), JSON.stringify(shared()));

// ── L4.2 triage says it was only a reviewer question → the learned pattern is removed ──────────
triage(p1, c1.id, "C_reviewer_clarification", "Reviewer asked which rafter table was used", "Reply with the table reference");
check("triage C removed the correction's failure row", hfe(c1.id).length === 0, JSON.stringify(hfe(c1.id)));
check("…and the shared rollup no longer carries it", !shared().some((p) => p.bucket === "B_designer_fix"), JSON.stringify(shared()));

// ── L4.3 triage refines A → the row is REPLACED from the triage (one row, never two) ────────────
R.addManualCorrection(db, p1, "The account number on the application does not match the utility bill.");
const c2 = newestCorrection(p1);
check("SETUP: intake guessed A_we_fix", c2.correctionBucket === "A_we_fix", c2.correctionBucket);
const ADDRESS_CAUSE = "Service address on the application does not match the utility bill";
triage(p1, c2.id, "A_we_fix", ADDRESS_CAUSE, "Correct the service address and resubmit.");
check("triage replaced the row: one row, with the TRIAGE root cause", hfe(c2.id).length === 1 && hfe(c2.id)[0].root_cause === ADDRESS_CAUSE, JSON.stringify(hfe(c2.id)));
check("the regex guess is gone from the shared rollup", !shared().some((p) => /Submission data, document, or portal packaging issue/.test(p.rootCause)), JSON.stringify(shared()));

// ── L7.1 an address cause is never a battery item and never blocks a no-battery project ──────
const r1 = buildHistoricalFailureReport(db, p1, null);
const addressCause = r1.topRejectionCauses.find((c) => c.rootCause === ADDRESS_CAUSE);
check("SETUP: the learned address cause is in the report", Boolean(addressCause), JSON.stringify(r1.topRejectionCauses.map((c) => c.title)));
check("'address' does not title the cause as battery (\\bESS\\b, not bare 'ess')", !/battery/i.test(String(addressCause?.title)), String(addressCause?.title));
check("no battery checklist item on a project with no battery", !r1.checklist.some((i) => /battery/i.test(i.title)), JSON.stringify(r1.checklist.map((i) => i.title)));
const addressItem = r1.checklist.find((i) => i.sourceCauseSignature === addressCause?.signature);
check("the address item is not checked against battery evidence (projectEvidence \\bESS\\b)",
  Boolean(addressItem) && addressItem!.status !== "missing" && !addressItem!.evidence.some((e) => /Battery model/i.test(e)),
  JSON.stringify(addressItem));

// ── L4.4 resolve keeps it (one row); retract removes it, stickily ──────────────────────────────
R.resolveCorrection(db, c2.id, { resubmitted: false, actor: { type: "human", name: "ops@example.test" } });
check("resolve re-derives, still exactly one row", hfe(c2.id).length === 1, JSON.stringify(hfe(c2.id)));
const resolvedAudit = db.get<{ actor_type: string; actor_name: string }>(
  "SELECT actor_type, actor_name FROM audit_logs WHERE project_id = ? AND action = 'correction.resolved' ORDER BY created_at DESC LIMIT 1", [p1],
);
check("resolve records the REAL actor", resolvedAudit?.actor_name === "ops@example.test" && resolvedAudit?.actor_type === "human", JSON.stringify(resolvedAudit));
const removed = kb.retractCorrectionLearning(db, c2.id);
check("retract removed the learned row", removed === 1 && hfe(c2.id).length === 0, `${removed} / ${hfe(c2.id).length}`);
kb.relearnCorrection(db, c2.id);
check("a later relearn does not bring a retracted pattern back", hfe(c2.id).length === 0, JSON.stringify(hfe(c2.id)));
check("the shared rollup is empty again", shared().length === 0, JSON.stringify(shared()));

// ── L7.2 Labels/Placards reaches the labels evidence topic; severity ignores the sample ───────
R.addManualCorrection(db, p1, "Residential Structural Record, page 2: the PV label and placard schedule is missing.");
const c3 = newestCorrection(p1);
triage(p1, c3.id, "A_we_fix", "Electrical / Labels/Placards", "Upload label/placard schedule.");
const withLabels = makeProject("Learning Two", {
  labelsText: "PV label schedule: placard at service disconnect, power source directory per 705.10, rapid shutdown label.",
});
const r2 = buildHistoricalFailureReport(db, p1, null);
const labelItem = r2.checklist.find((i) => /label/i.test(i.title));
check("a labels cause becomes a labels checklist item", labelItem?.title === "Missing label / placard schedule", JSON.stringify(r2.checklist.map((i) => i.title)));
check("…checked against evidence: MISSING on a plan set with no labels", labelItem?.status === "missing", String(labelItem?.status));
const labelCause = r2.topRejectionCauses.find((c) => c.rootCause === "Electrical / Labels/Placards");
check("severity reads the classification, not the sample ('Structural Record' mints no blocker)", labelCause?.severity === "warning", String(labelCause?.severity));
const r3 = buildHistoricalFailureReport(db, withLabels, null);
const labelItem2 = r3.checklist.find((i) => /label/i.test(i.title));
check("…and PRESENT on a plan set that carries a label schedule", labelItem2 && labelItem2.status !== "missing" && labelItem2.status !== "needs_review", String(labelItem2?.status));

// ── L7.3 Application Form is answered by the application package's own missing fields ────────
R.addManualCorrection(db, p1, "The application is incomplete; resubmit with the required application form.");
const c4 = newestCorrection(p1);
triage(p1, c4.id, "A_we_fix", "Documentation / Application Form", "Complete and upload required application form.");
const r4 = buildHistoricalFailureReport(db, p1, null);
const appItem = r4.checklist.find((i) => /application form/i.test(i.title));
const pkgMissing = buildApplicationDocumentPackage(R.getProjectDetail(db, p1).project).missingFields;
check("an application-form cause becomes a checklist item", Boolean(appItem), JSON.stringify(r4.checklist.map((i) => i.title)));
check("…whose status IS the package's missing-field verdict (one predicate)",
  appItem?.status === (pkgMissing.length ? "missing" : "present"), `${appItem?.status} vs missingFields=${pkgMissing.length}`);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\ncorrectionLearning: all checks passed");
