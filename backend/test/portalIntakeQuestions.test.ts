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
//   6. No INTERNAL VOCABULARY reaches the client. autoLearnAdapter records a
//      policy-answered radio as a step whose note is "policy default: <question>
//      → <answer>", the bank falls back to that note when the step carried no
//      selector label, and the whole string was rendered to a homeowner. It is
//      stripped at the public boundary — and ONLY there: the raw note is the
//      primary key of portal_question_overrides and recipeAdapter's replay-skip
//      key, so a label that merely CONTAINS an arrow must survive untouched.
//   7. A question the OPERATOR has a standing answer for is never asked
//      (OPERATOR_POLICY_ANSWERS) — with the bound-empty carve-out that keeps a
//      recipe-bound control from being filed blank.
//   8. REQUIRED IS ENFORCED SERVER-SIDE: a short post is a 400 naming what is
//      missing, thrown before any write, so a half-filled intake can no longer
//      mark itself completed and re-drive autopilot. "I'm not sure" counts as
//      answered.
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

// Every field the link still ASKS is required now, so a post that only carries a
// portal answer is a 400. These suites are about the QUESTIONS, so they answer
// the fixed fields from here and keep their subject in focus.
const FIELD_ANSWERS: Record<string, string> = {
  jobValue: "24500",
  homeownerEmail: "owner@example.com",
  homeownerPhone: "503-555-0142",
};
const fieldAnswersFor = (pub: { fields: Array<{ key: string }> }): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of pub.fields) out[f.key] = FIELD_ANSWERS[f.key] ?? "n/a";
  return out;
};

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
run("…and marked required, so the form and the server agree on what must be answered", pubQ?.required === true);
run("identity binding (utility) never reaches the public payload", !pubA.questions.some((q) => q.key === "utility"));
run("secret-shaped binding never reaches the public payload", !pubA.questions.some((q) => q.key === "portalPassword"));
run("option-less question is not rigidly askable and is dropped", !pubA.questions.some((q) => q.key === "installNotes"));
run("classic fixed fields still present", pubA.fields.length >= 1);

console.log("\n[2] answers are rigid — the portal's vocabulary or nothing");
const fieldsA = fieldAnswersFor(pubA);
const freeText = throws(() => submitIntakeRequest(db, reqA.token, { ...fieldsA, ownershipModel: "we lease it I think" }));
run("free text for a classified question is a 400", freeText?.status === 400, freeText?.message ?? "no error");
run("free text did not touch the project",
  !(getProjectDetail(db, projectA).project.parserSnapshot as Record<string, unknown>).ownershipModel);
const submitted = submitIntakeRequest(db, reqA.token, { ...fieldsA, ownershipModel: "Third-Party Owned" });
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
const fieldsB = fieldAnswersFor(getIntakeRequestPublic(db, reqB.token));
const unsureSubmit = submitIntakeRequest(db, reqB.token, { ...fieldsB, ownershipModel: INTAKE_UNSURE });
run("unsure-only submission completes", unsureSubmit.ok === true);
run("the sentinel never reached the project",
  !(getProjectDetail(db, projectB).project.parserSnapshot as Record<string, unknown>).ownershipModel);
const statusB = await portalQuestionStatus(db, projectB);
run("still unanswered for the operator", statusB.unansweredCount === 1);
run("…and flagged as installer-unsure", statusB.unsureCount === 1 && statusB.questions[0]?.unsure === true);
// "I'm not sure" is never written to the project, so without an explicit
// round-trip it reads back blank — and a client reopening the link to correct an
// email would then be blocked by a question they already answered.
const pubB = getIntakeRequestPublic(db, reqB.token);
const pubBQ = pubB.questions.find((q) => q.key === "ownershipModel");
run("the reopened link shows the unsure answer still selected", pubBQ?.value === INTAKE_UNSURE, JSON.stringify(pubBQ));
run("…and still marked required", pubBQ?.required === true);
const reunsure = throws(() => submitIntakeRequest(db, reqB.token, { ownershipModel: INTAKE_UNSURE }));
run("re-posting the sentinel is accepted, not 400'd as missing", reunsure === null, reunsure?.message ?? "");
const resilent = throws(() => submitIntakeRequest(db, reqB.token, {}));
run("…and an already-unsure question stays satisfied when it is not resent", resilent === null, resilent?.message ?? "");

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
      // `kind` is carried because the live bank always carries one —
      // extractPortalQuestions builds EVERY PortalQuestion through build(label,
      // kind, …), so a kind-less row is not a shape production can produce. It
      // matters here: an absent kind now means "unknown", and an unknown kind is
      // asked rather than settled (see [13]).
      { portalLabel: "Is a disconnect installed within 10 feet of the meter?", suggestedBinding: "disconnectWithin10ft", options: ["Yes", "No"], classification: "per-job", kind: "radio-choice" },
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
run("track-grouped questions flatten into the request", reqE.questions.length === 1, JSON.stringify(reqE.questions));
run("uncaptured dropdown falls back to the canonical portal vocabulary",
  JSON.stringify(eOwnership?.options) === JSON.stringify(["Customer-Owned", "Third-Party Owned", "Lease", "PPA"]));
run("the track's portal identity tags the question", eOwnership?.portalType === "utility:or:pacificorp");
run("a question with no binding cannot land anywhere and is not asked",
  !reqE.questions.some((q) => q.label.startsWith("Mystery")));
// The disconnect question the operator screenshotted. It is per-job in the bank
// and it always will be — what settles it is the operator's STANDING ANSWER, so
// the homeowner is not asked a question their coordinator has already decided.
run("a question the operator has a standing answer for is not asked",
  !reqE.questions.some((q) => q.key === "disconnectWithin10ft"), JSON.stringify(reqE.questions));
setPortalQuestionSource(null);

console.log("\n[9] the operator's standing answer settles the disconnect question — except where replay would file a blank");
const DISCONNECT_NOTE = "policy default: Is your disconnect within 10 feet of the PGE utility meter? → Yes";
const makeProjectFor = (owner: string, street: string) => createProject(db, {
  owner, street, city: "Portland", state: "OR", zip: "97201",
  ahj: "City of Portland", utility: "Portland General Electric", dcKw: "6.0",
}).project.id;

// (a) The LIVE shape: PGE's policy-default radio, recorded with a css-only
//     selector so the bank falls back to the step NOTE for a label.
setPortalQuestionSource(() => [
  { key: "disconnectWithin10ft", label: DISCONNECT_NOTE, options: ["Yes", "No"], classification: "per-job", kind: "radio-choice" },
]);
const projectF = makeProjectFor("Question Test F", "6 Policy Pl");
const reqF = await createIntakeRequest(db, projectF);
run("the PGE disconnect question never reaches the client form", reqF.questions.length === 0, JSON.stringify(reqF.questions));
run("…nor the public payload", getIntakeRequestPublic(db, reqF.token).questions.length === 0);
const statusF = await portalQuestionStatus(db, projectF);
run("…nor the operator's unanswered chip", statusF.unansweredCount === 0);

// (b) THE CARVE-OUT, tested from the other side. kind "bound-empty" means the
//     RECIPE binds a control to this field: replay fills it from
//     resolveRecipeFieldValues, which has no policy default and resolves "", so
//     suppressing the question here would file a BLANK into a required portal
//     control. Those must still be asked.
setPortalQuestionSource(() => [
  { key: "disconnectWithin10ft", label: DISCONNECT_NOTE, options: ["Yes", "No"], classification: "per-job", kind: "bound-empty" },
]);
const projectG = makeProjectFor("Question Test G", "7 Bound Blvd");
const reqG = await createIntakeRequest(db, projectG);
run("a RECIPE-BOUND disconnect control is still asked — a blank filing is worse than a question",
  reqG.questions.length === 1 && reqG.questions[0].key === "disconnectWithin10ft", JSON.stringify(reqG.questions));

console.log("\n[10] internal recipe vocabulary is impossible to render to a customer");
const pubG = getIntakeRequestPublic(db, reqG.token);
const pubGQ = pubG.questions.find((q) => q.key === "disconnectWithin10ft");
run("the 'policy default:' prefix and the recorded '→ Yes' answer are stripped",
  pubGQ?.label === "Is your disconnect within 10 feet of the PGE utility meter?", JSON.stringify(pubGQ?.label));
run("…and the raw note never appears anywhere in the public payload",
  !JSON.stringify(pubG).toLowerCase().includes("policy default"), JSON.stringify(pubG.questions));

// mustExclude — the other half of the filter. The strip is ANCHORED on the
// prefix: a legitimate portal label that merely contains an arrow must survive
// byte-identical, or a line/load-side question is silently truncated.
const ARROW_LABEL = "Line → Load side of the main panel?";
setPortalQuestionSource(() => [
  { key: "mountType", label: ARROW_LABEL, options: ["Line side", "Load side"], classification: "per-job" },
]);
const projectH = makeProjectFor("Question Test H", "8 Arrow Ave");
const reqH = await createIntakeRequest(db, projectH);
run("a normal label containing an arrow survives byte-identical",
  reqH.questions[0]?.label === ARROW_LABEL, JSON.stringify(reqH.questions[0]?.label));

console.log("\n[11] a portal-constant has a fixed answer — asking a client for it is the defect");
setPortalQuestionSource(() => [
  { key: "ownershipModel", label: "Will the System be Customer-Owned or Third-Party Owned?", options: ["Customer-Owned", "Third-Party Owned"], classification: "per-job" },
  { key: "mountType", label: "Who will install this generation system?", options: ["Contractor", "Self"], classification: "portal-constant" },
  // No classification at all: storedJson does not persist one, so a pending row
  // written before this guard existed must still parse. Dropping these would
  // silently empty every intake link already in flight.
  { key: "tilt", label: "Array tilt?", options: ["Flush", "Tilted"] },
]);
const projectI = makeProjectFor("Question Test I", "9 Constant Ct");
const reqI = await createIntakeRequest(db, projectI);
const iKeys = reqI.questions.map((q) => q.key).sort();
run("a portal-constant never reaches the intake payload", !iKeys.includes("mountType"), JSON.stringify(iKeys));
run("…while per-job and unclassified questions still do",
  JSON.stringify(iKeys) === JSON.stringify(["ownershipModel", "tilt"]), JSON.stringify(iKeys));

console.log("\n[12] required is enforced server-side, before anything is written");
setPortalQuestionSource(() => [OWNERSHIP_Q]);
const projectJ = makeProjectFor("Question Test J", "10 Required Rd");
const reqJ = await createIntakeRequest(db, projectJ);
const pubJ = getIntakeRequestPublic(db, reqJ.token);
const fieldsJ = fieldAnswersFor(pubJ);
run("every asked field is published as required", pubJ.fields.length > 0 && pubJ.fields.every((f) => f.required === true));

const noQuestion = throws(() => submitIntakeRequest(db, reqJ.token, fieldsJ));
run("a post missing the portal question is a 400", noQuestion?.status === 400, JSON.stringify(noQuestion));
run("…whose message NAMES the question, in the portal's own wording",
  Boolean(noQuestion?.message.includes(OWNERSHIP_Q.label)), noQuestion?.message ?? "");

const firstFieldKey = pubJ.fields[0].key;
const shortFields = { ...fieldsJ, ownershipModel: "Customer-Owned" };
delete (shortFields as Record<string, string>)[firstFieldKey];
const noField = throws(() => submitIntakeRequest(db, reqJ.token, shortFields));
run("a post missing a fixed field is a 400", noField?.status === 400, JSON.stringify(noField));
run("…whose message names that field", Boolean(noField?.message.includes(pubJ.fields[0].label)), noField?.message ?? "");

// NOTHING may be written by a rejected post — the old code marked the row
// 'completed' and fired maybeResumeAutopilot off a one-answer submission.
const rowJ = db.get<Record<string, unknown>>("SELECT status, completed_at FROM project_intake_requests WHERE id = ?", [reqJ.id]);
run("a rejected post leaves the request pending", String(rowJ?.status) === "pending", JSON.stringify(rowJ));
run("…and writes nothing to the project",
  !(getProjectDetail(db, projectJ).project.parserSnapshot as Record<string, unknown>).ownershipModel
  && !(getProjectDetail(db, projectJ).project.parserSnapshot as Record<string, unknown>).homeownerEmail);

const complete = throws(() => submitIntakeRequest(db, reqJ.token, { ...fieldsJ, ownershipModel: "Customer-Owned" }));
run("a complete post is accepted", complete === null, complete?.message ?? "");
run("…and only then does the request complete",
  String(db.get<Record<string, unknown>>("SELECT status FROM project_intake_requests WHERE id = ?", [reqJ.id])?.status) === "completed");

const unsureJ = makeProjectFor("Question Test K", "11 Unsure Way");
const reqK = await createIntakeRequest(db, unsureJ);
const okUnsure = throws(() => submitIntakeRequest(db, reqK.token, {
  ...fieldAnswersFor(getIntakeRequestPublic(db, reqK.token)), ownershipModel: INTAKE_UNSURE,
}));
run("\"I'm not sure\" satisfies required — it escalates, it does not guess", okUnsure === null, okUnsure?.message ?? "");
run("…and the sentinel still never reaches the project",
  !(getProjectDetail(db, unsureJ).project.parserSnapshot as Record<string, unknown>).ownershipModel);
run("…and the question stays open for the operator, flagged unsure",
  (await portalQuestionStatus(db, unsureJ)).unsureCount === 1);
setPortalQuestionSource(null);

console.log("\n[13] a PENDING request written before 'kind' was persisted degrades to ASKING, never to a blank filing");
// THE REGRESSION. storedJson only began persisting `kind` in the commit that
// introduced OPERATOR_POLICY_ANSWERS, so every intake request already pending at
// that moment carries questions with no kind. policySettles read that as
// "not bound-empty" and suppressed them — and for a recipe-bound control that is
// the worst available outcome: the question disappears from the client's form
// while resolveRecipeFieldValues (which has no policy default) goes on resolving
// "" into a REQUIRED portal control, with nothing anywhere surfacing it. The
// code's own comment calls that "strictly worse than asking", so an unknown kind
// must ask.
const projectL = makeProjectFor("Question Test L", "12 Legacy Ln");
const LEGACY_DISCONNECT_TOKEN = "legacy-kindless-token";
db.run(
  `INSERT INTO project_intake_requests (id, project_id, token, fields_json, status, created_by, created_at)
   VALUES ('legacy-kindless', ?, ?, ?, 'pending', '', ?)`,
  [
    projectL, LEGACY_DISCONNECT_TOKEN,
    // Exactly what pre-change storedJson wrote: key, label, options — no kind.
    // The denylisted binding is the mustExclude arm: degrading to "ask" must not
    // also degrade the public-key guard, or a no-login token could repoint a filing.
    JSON.stringify([
      "homeownerEmail",
      { key: "disconnectWithin10ft", label: DISCONNECT_NOTE, options: ["Yes", "No"] },
      { key: "utility", label: "Which utility?", options: ["PacifiCorp", "PGE"] },
    ]),
    new Date().toISOString(),
  ],
);
const pubL = getIntakeRequestPublic(db, LEGACY_DISCONNECT_TOKEN);
const pubLQ = pubL.questions.find((q) => q.key === "disconnectWithin10ft");
run("a legacy kind-less policy question is ASKED, not silently settled", Boolean(pubLQ), JSON.stringify(pubL.questions));
run("…in the portal's own wording, with the internal note prefix still stripped",
  pubLQ?.label === "Is your disconnect within 10 feet of the PGE utility meter?", JSON.stringify(pubLQ?.label));
run("…and marked required, so the form and the server still agree",
  pubLQ?.required === true, JSON.stringify(pubLQ));
// mustExclude — the public-key denylist is untouched by the degrade.
run("…while a portal-identity binding in the same legacy row still never reaches the form",
  !pubL.questions.some((q) => q.key === "utility"), JSON.stringify(pubL.questions));

const legacyShort = throws(() => submitIntakeRequest(db, LEGACY_DISCONNECT_TOKEN, { homeownerEmail: "legacy@example.com" }));
run("a post that omits it is a 400 — the server requires what the form showed",
  legacyShort?.status === 400, JSON.stringify(legacyShort));
run("…naming the question in the portal's own wording",
  Boolean(legacyShort?.message.includes("Is your disconnect within 10 feet of the PGE utility meter?")),
  legacyShort?.message ?? "");
// "I'm not sure" must remain a real answer on this path too — it escalates to the
// operator, and escalation is still better than a blank in a required control.
const legacyUnsure = throws(() => submitIntakeRequest(db, LEGACY_DISCONNECT_TOKEN, {
  homeownerEmail: "legacy@example.com", disconnectWithin10ft: INTAKE_UNSURE,
}));
run("\"I'm not sure\" still satisfies it", legacyUnsure === null, legacyUnsure?.message ?? "");
run("…and the sentinel never reached the project",
  !(getProjectDetail(db, projectL).project.parserSnapshot as Record<string, unknown>).disconnectWithin10ft);

// THE OTHER DIRECTION, from storage rather than from the live bank: a row whose
// kind WAS persisted still lets the operator's standing answer settle it. [9](a)
// only covers the live-source path; this pins the round trip through fields_json.
const projectM = makeProjectFor("Question Test M", "13 Stored St");
db.run(
  `INSERT INTO project_intake_requests (id, project_id, token, fields_json, status, created_by, created_at)
   VALUES ('stored-kind', ?, 'stored-kind-token', ?, 'pending', '', ?)`,
  [
    projectM,
    JSON.stringify([
      "homeownerEmail",
      { key: "disconnectWithin10ft", label: DISCONNECT_NOTE, options: ["Yes", "No"], kind: "radio-choice" },
    ]),
    new Date().toISOString(),
  ],
);
run("a stored row that DOES carry its kind is still settled by the standing answer",
  getIntakeRequestPublic(db, "stored-kind-token").questions.length === 0,
  JSON.stringify(getIntakeRequestPublic(db, "stored-kind-token").questions));
// …and a stored bound-empty row keeps being asked, as it always has.
const projectN = makeProjectFor("Question Test N", "14 Bound Ct");
db.run(
  `INSERT INTO project_intake_requests (id, project_id, token, fields_json, status, created_by, created_at)
   VALUES ('stored-bound', ?, 'stored-bound-token', ?, 'pending', '', ?)`,
  [
    projectN,
    JSON.stringify([{ key: "disconnectWithin10ft", label: DISCONNECT_NOTE, options: ["Yes", "No"], kind: "bound-empty" }]),
    new Date().toISOString(),
  ],
);
run("a stored bound-empty row is still asked", getIntakeRequestPublic(db, "stored-bound-token").questions.length === 1);

if (failures) {
  console.error(`\nportalIntakeQuestions: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nportalIntakeQuestions: all checks passed");
