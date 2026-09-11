// A FROZEN [select] LITERAL IS A QUESTION THE PORTAL ASKS — WITH SOMEBODY ELSE'S ANSWER.
//
// Measured live on 2026-09-11: PacifiCorp's complete recipe replays 14 unbound select
// literals, including "Will the System be Customer-Owned or Third-Party Owned?" =
// "Customer-Owned" — a financing fact pinned to project A that files silently wrong on any
// third-party-owned job (A and B agree by luck, so the cross-project sweep cannot see it).
// Ameren separately files "Community Solar / Behind the Meter" BLANK — no binding exists.
//
// Pins: the bank extracts those questions from the recipe itself with the portal's own
// wording; the rigid classifier calls ownership per-job and the installer-role question
// portal-constant; a project whose record answers a per-job question drops it from the
// unanswered list; a human override flips a classification and persists; reads never
// create the overrides table (the CLI stays honestly read-only); and the classifier table
// is kill-tested — every rule must be the WINNING rule for a real label, and "net
// metering" boilerplate must hit nothing.
//
// Browser-free. Run: tsx backend/test/portalQuestionBank.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord, RecipeStep } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-question-bank-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { startPortalRecording, resolveRecipeFieldValues } = await import("../src/portalRecipes");
const {
  extractPortalQuestions, questionsForProject, classifyPortalQuestion, normalizeQuestionLabel,
  setPortalQuestionOverride, getPortalQuestionOverrides, auditFrozenAnswers,
  intakeFieldsForQuestions, QUESTION_CLASSIFIER_RULES,
} = await import("../src/portalQuestionBank");

const db = await openDatabase();

let failures = 0;
const run = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ── The synthetic recipe: PacifiCorp's REAL 14 unbound selects (2026-09-11 report), plus
//    the Ameren blank, an ESS radio-choice, a battery-mentioning consent, a bound
//    often-empty field, and steps that must never surface. ─────────────────────────────
const sel = (label: string, value: string): RecipeStep => ({
  action: "select", phase: "fill", selector: { label }, note: label, value,
});
const PACIFICORP_LITERALS: Array<[string, string]> = [
  ["Who will install this generation system?", "Contractor"],
  ["Will the System be Customer-Owned or Third-Party Owned?", "Customer-Owned"],
  ["Description of Service:", "This is a new generation system at an existing site."],
  ["Type of Electric Service at Generation Site", "Residential"],
  ["Will there be a Meter Mounted Device (MMD)", "No"],
  ["Are you interested in opting in to receiving changes that are made to our Net Metering handbook?", "No"],
  ["Generation Technology", "Inverter"],
  ["System Mounting Method", "Roof Mounting"],
  ["Is this meter located inside a garage/residence/facility?", "No"],
  ["Possible meter access issues?", "None"],
  ["Will the net metering facility interconnect to a switchgear?", "No"],
  ["Will the net metering facility include a parallel blocking scheme?", "No"],
  ["Please make your selection regarding meter aggregation below", "No Aggregation"],
  ["Will the output of this generation system serve more than one customer?", "No"],
];
const STEPS: RecipeStep[] = [
  { action: "goto", value: "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login" },
  ...PACIFICORP_LITERALS.map(([l, v]) => sel(l, v)),
  // The Ameren shape: an unbound select that recorded NO value — replays a blank.
  sel("Please select whether this system is a Community Solar, Behind the Meter request, or Collectively Owned Generation Facility:", ""),
  // A radio group: the checked LABEL is the answer; the SECTION is the question.
  { action: "check", phase: "fill", selector: { label: "No" }, note: "No",
    fingerprint: { section: "Do you seek to install an Energy Storage System (ESS), or batteries as part of t" } },
  // A consent that mentions batteries — must stay a consent, never per-job storage.
  { action: "check", phase: "fill",
    selector: { label: "I acknowledge that our technical staff is aware of the battery requirements below in red and that they are met in the line diagram attached." },
    note: "I acknowledge that our technical staff is aware of the battery requirements below in red and that they are met in the line diagram attached." },
  // Bound to a field the average project record leaves empty.
  { action: "select", phase: "fill", selector: { label: "AC Disconnect within 10 ft of meter?" },
    note: "AC Disconnect within 10 ft of meter?", field: "disconnectWithin10ft" },
  // Bound to ordinary project data — answered by the record, never a question.
  { action: "fill", phase: "fill", selector: { label: "System Size (kW DC)" }, note: "System Size (kW DC)", field: "systemSizeDcKw" },
  // Never questions: a credential and the final submit.
  { action: "fill", phase: "fill", selector: { label: "Account Number" }, note: "Account Number", field: "accountNumber", sensitive: true },
  { action: "click", phase: "review", selector: { label: "Submit Application" }, isFinalSubmit: true },
];

const recipeStub = startPortalRecording(db, {
  scopeType: "utility", state: "OR", utility: "Pacific Power",
  portalPlatform: "powerclerk", portalUrl: "https://pacificorpnetmetering.powerclerk.com",
});
db.run("UPDATE portal_recipes SET steps_json = ?, status = 'complete' WHERE id = ?", [JSON.stringify(STEPS), recipeStub.id]);
const PROFILE_KEY = recipeStub.profileKey;

const questions = extractPortalQuestions(db, PROFILE_KEY);
const byLabel = (needle: string) => questions.find((q) => q.portalLabel.toLowerCase().includes(needle.toLowerCase()));

run("every unbound literal surfaces as a question in the portal's own wording", () => {
  for (const [label] of PACIFICORP_LITERALS) {
    assert.ok(byLabel(label.slice(0, 40)), `missing question for "${label}"`);
  }
});

run("the ownership question — the live silent-wrong-answer — is per-job with its recorded answer visible", () => {
  const q = byLabel("Customer-Owned or Third-Party Owned");
  assert.ok(q);
  assert.equal(q.classification, "per-job");
  assert.equal(q.classifiedBy, "per-job:ownership");
  assert.equal(q.recordedAnswer, "Customer-Owned");
  assert.equal(q.suggestedBinding, "ownershipModel");
  assert.equal(q.kind, "unbound-literal");
});

run("the installer-role question is a portal constant — fine frozen", () => {
  const q = byLabel("Who will install this generation system");
  assert.ok(q);
  assert.equal(q.classification, "portal-constant");
  assert.equal(q.classifiedBy, "portal-constant:installer-role");
});

run("the Ameren shape — an unbound select with NO recorded value — surfaces as a per-job blank", () => {
  const q = byLabel("Community Solar, Behind the Meter");
  assert.ok(q);
  assert.equal(q.recordedAnswer, "");
  assert.equal(q.kind, "unbound-blank");
  assert.equal(q.classification, "per-job");
  assert.equal(q.suggestedBinding, "systemConfiguration");
});

run("a radio choice classifies on its SECTION (the question), never on the checked 'No'", () => {
  const q = byLabel("Energy Storage System");
  assert.ok(q);
  assert.equal(q.kind, "radio-choice");
  assert.equal(q.recordedAnswer, "No");
  assert.equal(q.classification, "per-job");
  assert.equal(q.classifiedBy, "per-job:storage");
});

run("a consent that mentions batteries stays a consent — kind wins before keywords run", () => {
  const q = byLabel("technical staff is aware of the battery requirements");
  assert.ok(q);
  assert.equal(q.kind, "consent");
  assert.equal(q.classification, "portal-constant");
});

run("a step bound to an often-empty field surfaces as a per-job intake question", () => {
  const q = byLabel("Disconnect within 10 ft");
  assert.ok(q);
  assert.equal(q.kind, "bound-empty");
  assert.equal(q.classification, "per-job");
  assert.equal(q.suggestedBinding, "disconnectWithin10ft");
});

run("sensitive steps, final submit, and ordinary bound fields are never questions", () => {
  assert.equal(byLabel("Account Number"), undefined);
  assert.equal(byLabel("Submit Application"), undefined);
  assert.equal(byLabel("System Size"), undefined);
});

run("'net metering' boilerplate hits NO meter rule — switchgear/blocking-scheme stay unknown", () => {
  for (const needle of ["interconnect to a switchgear", "parallel blocking scheme", "meter aggregation", "serve more than one customer"]) {
    const q = byLabel(needle);
    assert.ok(q, `missing "${needle}"`);
    assert.equal(q.classification, "unknown", `"${q.portalLabel}" classified ${q.classification} by ${q.classifiedBy}`);
  }
});

run("reading the bank never creates the overrides table — the audit path stays read-only", () => {
  assert.equal(
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='portal_question_overrides'"),
    null,
  );
});

// ── questionsForProject: "the PGE questions" for a PGE project ─────────────────────────
const makeProject = (snapshot: Record<string, unknown>): ProjectRecord => ({
  id: "proj-test-1", clientId: null,
  homeownerName: "Terry Sample", projectAddress: "123 SW Test Ave", city: "Portland",
  state: "OR", zip: "97223", ahj: "City of Portland", utility: "Pacific Power",
  // accountNumber stays "" on purpose: systemConfiguration's behind-the-meter default is
  // guarded on a utility account existing (v17), so this fixture keeps it UNANSWERED.
  accountNumber: "", meterNumber: "", systemSizeDcKw: 7.2, systemSizeAcKw: 6.8,
  totalExportKw: 6.8, interconnectionMethod: "NEM", status: "qc_passed",
  currentStage: "ready", parserConfidenceSummary: "", parserSnapshot: snapshot as ProjectRecord["parserSnapshot"],
  createdAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z",
});

run("a project that cannot answer the ownership question gets it on the unanswered list", () => {
  const tracks = questionsForProject(db, makeProject({}));
  const nem = tracks.find((t) => t.track === "nem");
  assert.ok(nem, "the NEM track resolved no recipe");
  assert.equal(nem.portalHost, "pacificorpnetmetering.powerclerk.com");
  const labels = nem.unanswered.map((q) => q.labelNorm);
  assert.ok(labels.some((l) => l.includes("customer-owned or third-party owned")), `unanswered: ${labels.join("; ")}`);
});

run("a project whose record answers ownership drops it from unanswered (snapshot passthrough)", () => {
  const project = makeProject({ ownershipModel: "Third-Party Owned" });
  // Canary for the premise: snapshot scalars pass through the resolver by key.
  assert.equal(resolveRecipeFieldValues(db, project, "").ownershipModel, "Third-Party Owned");
  const nem = questionsForProject(db, project).find((t) => t.track === "nem");
  assert.ok(nem);
  assert.ok(!nem.unanswered.some((q) => q.labelNorm.includes("customer-owned or third-party owned")));
  const hit = nem.answered.find((a) => a.from === "ownershipModel");
  assert.ok(hit, "answered list should say WHERE the answer came from");
  assert.equal(hit.value, "Third-Party Owned");
});

run("intake fields for build 3 carry only bindable per-job questions, keyed for the snapshot", () => {
  const nem = questionsForProject(db, makeProject({})).find((t) => t.track === "nem");
  assert.ok(nem);
  const fields = intakeFieldsForQuestions(nem.unanswered);
  const keys = fields.map((f) => f.key);
  assert.ok(keys.includes("ownershipModel"));
  assert.ok(keys.includes("systemConfiguration"));
  assert.ok(keys.every(Boolean));
  const own = fields.find((f) => f.key === "ownershipModel");
  assert.ok(own && /Customer-Owned or Third-Party Owned/.test(own.label), "the installer sees the portal's own wording");
});

// ── Overrides: classify once, remembered ───────────────────────────────────────────────
run("a human override flips a classification, carries a binding, and persists", () => {
  setPortalQuestionOverride(db, PROFILE_KEY, "Please make your selection regarding meter aggregation below", "per-job", "meterAggregation");
  const after = extractPortalQuestions(db, PROFILE_KEY).find((q) => q.labelNorm.includes("meter aggregation"));
  assert.ok(after);
  assert.equal(after.classification, "per-job");
  assert.equal(after.classifiedBy, "override");
  assert.equal(after.suggestedBinding, "meterAggregation");
  // Persisted as shared portal knowledge, keyed by the normalized label.
  const stored = getPortalQuestionOverrides(db, PROFILE_KEY);
  assert.deepEqual(stored.get(normalizeQuestionLabel("Please make your selection regarding meter aggregation below")), {
    classification: "per-job", binding: "meterAggregation",
  });
});

run("the audit ranks frozen per-job answers worst, then blanks, then unknowns — constants excluded", () => {
  const findings = auditFrozenAnswers(db);
  assert.ok(findings.length > 0);
  const severities = findings.map((f) => f.severity);
  assert.deepEqual(severities, [...severities].sort((a, b) => a - b), "not sorted worst-first");
  assert.equal(findings[0].severity, 0);
  assert.ok(findings.some((f) => f.severity === 0 && /Customer-Owned/.test(f.question.recordedAnswer)));
  assert.ok(!findings.some((f) => f.question.classification === "portal-constant"));
  assert.ok(findings.some((f) => f.severity === 1 && f.question.labelNorm.includes("community solar")));
});

// ── Kill-test the classifier table: every rule must WIN on a real label, and every
//    sample must be won by ITS rule (a broad early rule masking a later one fails here).──
const RULE_SAMPLES: Record<string, string> = {
  "per-job:ownership": "Will the System be Customer-Owned or Third-Party Owned?",
  "per-job:configuration": "Please select whether this system is a Community Solar, Behind the Meter request, or Collectively Owned Generation Facility:",
  "per-job:storage": "Do you seek to install an Energy Storage System (ESS), or batteries as part of this project?",
  "per-job:export-limit": "Is the proposed DER system a limited export or non-exporting system?",
  "per-job:mounting": "System Mounting Method",
  "per-job:tilt": "Array Tilt (degrees)",
  "per-job:azimuth": "Array Azimuth (degrees from true north)",
  "per-job:meter-location": "Is this meter located inside a garage/residence/facility?",
  "per-job:meter-device": "Will there be a Meter Mounted Device (MMD)",
  "per-job:disconnect-10ft": "Is the AC disconnect located within 10 feet of the meter?",
  "per-job:connection-side": "Is this proposed generation to be connected on the line or load side of the main panel?",
  "portal-constant:installer-role": "Who will install this generation system?",
  "portal-constant:service-description": "Description of Service:",
  "portal-constant:service-type": "Type of Electric Service at Generation Site",
  "portal-constant:mailing-list": "Are you interested in opting in to receiving changes that are made to our Net Metering handbook?",
  "portal-constant:generation-technology": "Generation Technology",
  "portal-constant:consent": "By clicking here, you indicate that you have read and agree to the Terms and Conditions",
  "portal-constant:fee-routing": "Who should receive the Application Fee invoice?",
  "portal-constant:fuel-source": "Please select the fuel source of the existing/proposed generator",
  "portal-constant:ul1741": "Is the inverter UL 1741 listed?",
  "portal-constant:active-license": "Active License?",
};

run("every classifier rule is the WINNING rule for a real portal label (kill-test)", () => {
  const tableIds = QUESTION_CLASSIFIER_RULES.map((r) => r.id);
  assert.deepEqual(Object.keys(RULE_SAMPLES).sort(), [...tableIds].sort(), "sample set out of sync with the rule table");
  for (const [ruleId, label] of Object.entries(RULE_SAMPLES)) {
    const got = classifyPortalQuestion(label);
    assert.equal(got.ruleId, ruleId, `"${label}" won by ${got.ruleId}, expected ${ruleId}`);
  }
});

run("mustExclude: boilerplate and cross-domain words never leak into the wrong rule", () => {
  // "net metering facility" rides on nearly every utility question — no meter rule may bite.
  assert.equal(classifyPortalQuestion("Will the net metering facility interconnect to a switchgear?").ruleId, null);
  assert.equal(classifyPortalQuestion("Will the net metering facility include a parallel blocking scheme?").ruleId, null);
  // Meter aggregation is deliberately unknown until a human classifies it once.
  assert.equal(classifyPortalQuestion("Please make your selection regarding meter aggregation below").classification, "unknown");
  // The installer-role question must not read as per-job just because a system is named.
  assert.equal(classifyPortalQuestion("Who will install this generation system?").classification, "portal-constant");
});

db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }

if (failures) {
  console.error(`\nportalQuestionBank tests: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nportalQuestionBank tests: all passed");
