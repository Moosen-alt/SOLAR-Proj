// PORTAL QUESTIONS AT INTAKE — the link asks what the portal will ask.
//
// A recipe's frozen [select] literal ("Customer-Owned") is a PER-JOB fact the
// project record cannot answer, and replaying it files a wrong answer silently
// on any project where the truth differs. This suite proves the intake-request
// surface closes that gap:
//
//   1. Creating an intake request APPENDS the portal's unanswered per-job
//      questions (the portal's own wording + its exact options + the binding
//      the answer lands in) to the tokenized public payload.
//   2. Answers are RIGID — only one of the portal's own options is accepted
//      (free text for a classified question is a 400), and a valid answer
//      writes the project column through the existing update path.
//   3. "I'm not sure" marks the question for the operator and never guesses
//      into the project.
//   4. A project that already answered gets a request that carries none.
//   5. Public-safety: questions bound to portal-identity keys (state/ahj/
//      utility) or secret-shaped keys never reach the no-login payload.
//
// KILL-TEST (verified during development): with the questionsForProject append
// removed from createIntakeRequest, test [1] fails — the payload lacks the
// question — so this suite genuinely detects the feature's absence.
//
// Browser-free. Run: tsx backend/test/portalIntakeQuestions.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-intake-q-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createProject, getProjectDetail } = await import("../src/repository");
const {
  createIntakeRequest, getIntakeRequestPublic, submitIntakeRequest,
  setPortalQuestionSource, portalQuestionStatus, INTAKE_UNSURE,
} = await import("../src/intakeRequests");
const { resolveRecipeFieldValues } = await import("../src/portalRecipes");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};
const throws = (fn: () => unknown): { status?: number; message: string } | null => {
  try { fn(); return null; } catch (err) {
    return { status: (err as { status?: number }).status, message: (err as Error).message || String(err) };
  }
};

// The bank for these tests: one real per-job question (the live PacifiCorp
// example, bound to migration v17's ownership_model column) plus three that
// must be filtered out — a portal-identity binding, a secret-shaped binding,
// and a non-rigid question with no options.
const OWNERSHIP_Q = {
  key: "ownershipModel",
  label: "Will the System be Customer-Owned or Third-Party Owned?",
  options: ["Customer-Owned", "Third-Party Owned"],
  portalType: "powerclerk",
};
setPortalQuestionSource(() => [
  OWNERSHIP_Q,
  { key: "utility", label: "Which utility?", options: ["PacifiCorp", "PGE"] },
  { key: "portalPassword", label: "Portal password?", options: ["a", "b"] },
  { key: "installNotes", label: "Anything else?", options: [] },
]);

const projectA = createProject(db, {
  owner: "Question Test A", street: "1 Ownership Way", city: "Portland", state: "OR", zip: "97201",
  ahj: "City of Portland", utility: "PacifiCorp", dcKw: "6.4",
}).project.id;

console.log("\n[1] creating an intake request appends the portal's unanswered per-job questions");
const reqA = await createIntakeRequest(db, projectA);
run("create result carries exactly the one safe rigid question",
  reqA.questions.length === 1 && reqA.questions[0].key === "ownershipModel", JSON.stringify(reqA.questions));
const pubA = getIntakeRequestPublic(db, reqA.token);
const pubQ = pubA.questions.find((q) => q.key === "ownershipModel");
run("public payload carries the question", Boolean(pubQ));
run("…with the portal's own wording", pubQ?.label === OWNERSHIP_Q.label);
run("…with exactly the portal's options", JSON.stringify(pubQ?.options) === JSON.stringify(OWNERSHIP_Q.options));
run("…unanswered (empty value)", pubQ?.value === "");
run("identity binding (utility) never reaches the public payload", !pubA.questions.some((q) => q.key === "utility"));
run("secret-shaped binding never reaches the public payload", !pubA.questions.some((q) => q.key === "portalPassword"));
run("option-less question is not rigidly askable and is dropped", !pubA.questions.some((q) => q.key === "installNotes"));
run("classic fixed fields still present", pubA.fields.length >= 1);

console.log("\n[2] answers are rigid — the portal's vocabulary or nothing");
const freeText = throws(() => submitIntakeRequest(db, reqA.token, { ownershipModel: "we lease it I think" }));
run("free text for a classified question is a 400", freeText?.status === 400, freeText?.message ?? "no error");
run("free text did not touch the project",
  !(getProjectDetail(db, projectA).project.parserSnapshot as Record<string, unknown>).ownershipModel);
const submitted = submitIntakeRequest(db, reqA.token, { ownershipModel: "Third-Party Owned" });
run("a portal option is accepted", submitted.ok === true);
run("the answer landed in the project snapshot",
  (getProjectDetail(db, projectA).project.parserSnapshot as Record<string, unknown>).ownershipModel === "Third-Party Owned");
const colRow = db.get<Record<string, unknown>>("SELECT ownership_model FROM projects WHERE id = ?", [projectA]);
run("…and in the v17 ownership_model column", String(colRow?.ownership_model ?? "") === "Third-Party Owned");
// End-to-end with the question-bank build: the binding replay resolves is the
// installer's answer, not a frozen literal and not blank.
const resolved = resolveRecipeFieldValues(db, getProjectDetail(db, projectA).project, "powerclerk");
run("replay resolves the installer's answer", resolved.ownershipModel === "Third-Party Owned", resolved.ownershipModel);

console.log("\n[3] a project that already answered gets a request carrying none");
const reqA2 = await createIntakeRequest(db, projectA);
run("second request carries no portal questions", reqA2.questions.length === 0, JSON.stringify(reqA2.questions));
run("…and its public payload carries none", getIntakeRequestPublic(db, reqA2.token).questions.length === 0);
const statusA = await portalQuestionStatus(db, projectA);
run("operator status shows zero unanswered", statusA.unansweredCount === 0);

console.log("\n[4] \"I'm not sure\" marks the operator, never guesses into the project");
const projectB = createProject(db, {
  owner: "Question Test B", street: "2 Unsure St", city: "Salem", state: "OR", zip: "97301",
  ahj: "City of Salem", utility: "PacifiCorp", dcKw: "8.1",
}).project.id;
const reqB = await createIntakeRequest(db, projectB);
run("B's request asks the question", reqB.questions.length === 1);
const unsureSubmit = submitIntakeRequest(db, reqB.token, { ownershipModel: INTAKE_UNSURE });
run("unsure-only submission completes", unsureSubmit.ok === true);
run("the sentinel never reached the project",
  !(getProjectDetail(db, projectB).project.parserSnapshot as Record<string, unknown>).ownershipModel);
const statusB = await portalQuestionStatus(db, projectB);
run("still unanswered for the operator", statusB.unansweredCount === 1);
run("…and flagged as installer-unsure", statusB.unsureCount === 1 && statusB.questions[0]?.unsure === true);

console.log("\n[5] legacy rows (plain string fields_json) keep working");
db.run(
  `INSERT INTO project_intake_requests (id, project_id, token, fields_json, status, created_by, created_at)
   VALUES ('legacy-row', ?, 'legacy-token', '["homeownerEmail"]', 'pending', '', ?)`,
  [projectA, new Date().toISOString()],
);
const legacy = getIntakeRequestPublic(db, "legacy-token");
run("legacy payload parses", legacy.fields.length === 1 && legacy.fields[0].key === "homeownerEmail");
run("legacy payload has no questions", legacy.questions.length === 0);

console.log("\n[6] no question source wired → intake links still work, without the bank's question");
setPortalQuestionSource(null);
const projectC = createProject(db, {
  owner: "Question Test C", street: "3 Fallback Rd", city: "Bend", state: "OR", zip: "97701",
  ahj: "City of Bend", utility: "PacifiCorp", dcKw: "5.0",
}).project.id;
const reqC = await createIntakeRequest(db, projectC);
run("request creation does not throw and payload lacks the seeded question",
  !reqC.questions.some((q) => q.key === "ownershipModel"));

console.log("\n[7] a column-only answer (written by another tool) counts as answered");
setPortalQuestionSource(() => [
  { key: "systemConfiguration", label: "Community Solar / Behind the Meter", options: ["Behind the Meter", "Community Solar"] },
]);
const projectD = createProject(db, {
  owner: "Question Test D", street: "4 Column Ct", city: "Eugene", state: "OR", zip: "97401",
  ahj: "City of Eugene", utility: "PacifiCorp", dcKw: "7.7",
}).project.id;
db.run("UPDATE projects SET system_configuration = 'Behind the Meter' WHERE id = ?", [projectD]);
const reqD = await createIntakeRequest(db, projectD);
run("the request does not re-ask it", reqD.questions.length === 0, JSON.stringify(reqD.questions));

console.log("\n[8] the live bank's track-grouped shape flattens, with canonical options for uncaptured dropdowns");
// questionsForProject (portalQuestionBank.ts) returns TrackPortalQuestions[]:
// {track, profileKey, unanswered: PortalQuestion[{portalLabel, suggestedBinding,
// options?}]} — and most recorded steps did NOT capture the dropdown's options.
setPortalQuestionSource(() => [
  {
    track: "nem", recipeId: "r1", profileKey: "utility:or:pacificorp", portalHost: "pacificorp.powerclerk.com",
    answered: [],
    unanswered: [
      { portalLabel: "Will the System be Customer-Owned or Third-Party Owned?", suggestedBinding: "ownershipModel", classification: "per-job" },
      { portalLabel: "Is a disconnect installed within 10 feet of the meter?", suggestedBinding: "disconnectWithin10ft", options: ["Yes", "No"], classification: "per-job" },
      { portalLabel: "Mystery question with no binding", suggestedBinding: null, classification: "per-job" },
    ],
  },
]);
const projectE = createProject(db, {
  owner: "Question Test E", street: "5 Track Ln", city: "Medford", state: "OR", zip: "97501",
  ahj: "City of Medford", utility: "PacifiCorp", dcKw: "9.9",
}).project.id;
const reqE = await createIntakeRequest(db, projectE);
const eOwnership = reqE.questions.find((q) => q.key === "ownershipModel");
run("track-grouped questions flatten into the request", reqE.questions.length === 2, JSON.stringify(reqE.questions));
run("uncaptured dropdown falls back to the canonical portal vocabulary",
  JSON.stringify(eOwnership?.options) === JSON.stringify(["Customer-Owned", "Third-Party Owned", "Lease", "PPA"]));
run("the track's portal identity tags the question", eOwnership?.portalType === "utility:or:pacificorp");
run("a question with no binding cannot land anywhere and is not asked",
  !reqE.questions.some((q) => q.label.startsWith("Mystery")));
setPortalQuestionSource(null);

if (failures) {
  console.error(`\nportalIntakeQuestions: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nportalIntakeQuestions: all checks passed");
