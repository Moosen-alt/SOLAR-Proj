// AN AHJ'S PAST CORRECTIONS BECOME PROPOSED REVIEW RULES — HUMAN-APPROVED (#146).
//
// A city bounces a plan: "Provide a minimum 36 inch wide fire access pathway", "Add the note
// "PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN" to the electrical sheet". Before #146 that taught the
// profile and showed up in a report; the NEXT plan in that city was not checked for it. Now intake
// proposes a jurisdiction_review_rules row with #145's check shape, a person approves it through
// the one corrections approval, and only then does the next plan in THAT AHJ get
// city.ahj.prior-correction. Fixtures are SYNTHETIC (no real names, addresses or records).
//
// WHAT THIS FILE REFUSES TO LET REGRESS:
//   1. The deterministic extractor reads pathway / ridge setback minimums, a PV dead load cap and
//      quoted required wording — and nothing from a question, a condition or the package quoted back.
//   2. Intake proposes, never approves (hard rule 4): the row is 'proposed', the review item carries
//      the proposal, and no finding fires on the next project.
//   3. The SHARED row holds only the check shape + bucket/rootCause/requiredAction — never the AHJ's
//      sentence; wording naming the project's homeowner or street is never proposed.
//   4. Approve (applyCorrectionApproval, the /api/corrections/:id/apply handler) -> the next project in
//      that AHJ gets a BLOCKER on a sheet-stated value, a WARNING on a parser-only one; another AHJ is
//      unaffected; a measured result is never relaxed by vision.
//   5. The dashboard card esc()s the AHJ's sentence and the wording.
//
//   npx tsx backend/test/ahjRuleProposals.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewerFinding } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ahj-rule-proposals-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CODE_RESEARCH;
delete process.env.PORTAL_AUTOSEED;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const CP = await import("../src/codeProfiles");
const { evaluateDesignCodeFindings } = await import("../src/codeReviewRules");
const { extractAhjReviewChecks, wordingNamesProject, PRIOR_CORRECTION_ID, PRIOR_CORRECTION_UNCONFIRMED_ID } = await import("../src/ahjReviewRules");
const { applyCorrectionApproval, parseCorrectionProposals, persistTriage } = await import("../src/correctionAgent");
const { visionMayRelax } = await import("../src/reviewerVision");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const shape = (text: string) => extractAhjReviewChecks(text).map((c) => `${c.check.kind}:${c.check.field}=${c.check.value}${c.check.unit ? ` ${c.check.unit}` : ""}`);

// ─────────────────────────────────────────────────────────────────────────────────────────
// 1. THE EXTRACTOR
// ─────────────────────────────────────────────────────────────────────────────────────────
await check("MUST PASS: pathway / ridge setback minimums (in and ft), a PV dead load cap, quoted required wording", () => {
  assert.deepEqual(shape("Provide a minimum 36 inch wide fire access pathway on the roof plan."), ["min_value:pathwayWidthIn=36 in"]);
  assert.deepEqual(shape("Fire access pathways shall be a minimum of 3 ft wide."), ["min_value:pathwayWidthIn=36 in"]);
  assert.deepEqual(shape("Arrays shall be set back 18\" from the ridge."), ["min_value:ridgeSetbackIn=18 in"]);
  assert.deepEqual(shape("The PV dead load shall not exceed 4 psf."), ["max_value:pvDeadLoadPsf=4 psf"]);
  assert.deepEqual(shape("Add the note \"PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN\" to the electrical sheet."), ["required_text:planText=PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN"]);
});

await check("MUST EXCLUDE: a question, a condition, the package quoted back, no requirement, two different values", () => {
  for (const text of [
    "Verify whether the pathway is 36 inches wide.",
    "If the array is within 18\" of the ridge, provide a sprinkler letter.",
    "The plans show a 30 inch pathway.",
    "36 inch pathway noted.",
    "Pathways shall be 36 inches wide. Pathways shall be 18 inches wide.",
    "Add the note to the cover sheet.", // nothing quoted: no wording to check
  ]) assert.deepEqual(shape(text), [], `extracted from: ${text}`);
});

await check("wording naming the homeowner, the street, or carrying an account/phone number is flagged", () => {
  const p = { homeownerName: "Synthetic Owner", projectAddress: "1 Testmark Way" };
  assert.equal(wordingNamesProject("SYNTHETIC OWNER RESIDENCE", p), true);
  assert.equal(wordingNamesProject("SERVICE AT 1 TESTMARK WAY", p), true);
  assert.equal(wordingNamesProject("CALL 555-123-4567", p), true);
  assert.equal(wordingNamesProject("METER 12345678", p), true);
  assert.equal(wordingNamesProject("PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN", p), false);
  assert.equal(wordingNamesProject("ALL WORK PER 2023 NEC", p), false);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 2-4. INTAKE -> PROPOSAL -> APPROVAL -> FINDING, through the real write path.
// ─────────────────────────────────────────────────────────────────────────────────────────
const AHJ = "City of Ruleport";
const OTHER = "City of Otherport";
const mkProject = (ahj: string, snapshot: Record<string, string> = {}): string => R.createProject(db, {
  owner: "Synthetic Owner", state: "OR", dcKw: "8.4", acKw: "7.7", street: "1 Testmark Way", city: "Ruleport", zip: "97420",
  ahj, utility: "Test Power", ...snapshot,
} as never).project.id;
const itemPayload = (projectId: string, correctionId: string) => {
  const row = db.query<{ notes: string }>("SELECT notes FROM human_review_items WHERE project_id = ? AND field_name = 'correction'", [projectId])
    .find((r) => parseCorrectionProposals(r.notes)?.correctionId === correctionId);
  return row ? parseCorrectionProposals(row.notes) : null;
};
const rules = () => db.query<Record<string, unknown>>("SELECT * FROM jurisdiction_review_rules ORDER BY created_at");
const findingsFor = (projectId: string, ahj: string): ReviewerFinding[] => {
  const project = R.getProjectDetail(db, projectId).project;
  return evaluateDesignCodeFindings(project, null, CP.resolveEffectiveCodeContext(db, "OR", ahj));
};
const get = (fs: ReviewerFinding[], id: string) => fs.find((f) => f.id === id);

const CORRECTION = "Fire access: provide a minimum 36 inch wide fire access pathway on the roof plan per R324.6.2.1. "
  + "Add the note \"PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN\" to the electrical sheet. "
  + "Add the placard \"SYNTHETIC OWNER RESIDENCE SOLAR\" at the meter.";
const srcPid = mkProject(AHJ);
const corrId = R.addManualCorrection(db, srcPid, CORRECTION).corrections[0].id;
// The plans of the NEXT job in the same AHJ: an 18 in pathway on its own sheet, no RSD note.
const NEXT_PLAN = "ROOF PLAN: 18\" FIRE ACCESS PATHWAY. ARRAY LAYOUT PER DETAIL 3.";

await check("intake PROPOSES (rule 4): a 'proposed' shared row per check, the proposals on the review item, nothing approved", () => {
  const p = itemPayload(srcPid, corrId);
  assert.ok(p, "no linked review item");
  assert.deepEqual(p!.proposals, [], "a review rule leaked into the project-field proposals");
  const got = p!.reviewRuleProposals.map((x) => `${x.check.kind}:${x.check.field}=${x.check.value}`).sort();
  assert.deepEqual(got, ["min_value:pathwayWidthIn=36", "required_text:planText=PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN"]);
  for (const x of p!.reviewRuleProposals) {
    assert.equal(x.status, "proposed");
    assert.equal(x.ahj, AHJ);
    assert.equal(x.source.correctionId, corrId);
    assert.equal(x.id, `review-rule:${x.ruleId}`);
  }
  assert.equal(rules().length, 2);
  assert.ok(rules().every((r) => r.status === "proposed" && !r.approved_at));
});

await check("the SHARED row carries the check + classification only — never the AHJ's sentence, a correction id or the homeowner", () => {
  const blob = JSON.stringify(rules());
  assert.doesNotMatch(blob, /Synthetic Owner|SYNTHETIC OWNER|Testmark|R324\.6\.2\.1|on the roof plan/i);
  assert.ok(!blob.includes(corrId), "the correction id is one org's record");
  assert.ok(rules().every((r) => r.bucket === "B_designer_fix" && String(r.root_cause) && String(r.required_action)));
  const cols = db.query<{ name: string }>("PRAGMA table_info(jurisdiction_review_rules)").map((c) => c.name);
  for (const forbidden of ["sample", "excerpt", "basis", "correction_id", "project_id", "org_id", "record_number"]) assert.ok(!cols.includes(forbidden), `column ${forbidden}`);
});

await check("UNAPPROVED NEVER FIRES: the next plan in the same AHJ gets no prior-correction finding", () => {
  const pid = mkProject(AHJ, { planSetExtractedText: NEXT_PLAN });
  const fs = findingsFor(pid, AHJ);
  assert.ok(!get(fs, PRIOR_CORRECTION_ID) && !get(fs, PRIOR_CORRECTION_UNCONFIRMED_ID), JSON.stringify(fs.map((f) => f.id)));
});

await check("the LLM triage's rewrite of the notes keeps the review-rule proposals", () => {
  persistTriage(db, { correctionId: corrId, projectId: srcPid }, { actions: ["Revise the roof plan."], proposals: [] });
  assert.equal(itemPayload(srcPid, corrId)!.reviewRuleProposals.length, 2);
});

await check("APPROVE (the apply route's handler): rows turn 'approved'; the card records it; a second approval does nothing", () => {
  const p = itemPayload(srcPid, corrId)!;
  const out = applyCorrectionApproval(db, corrId, p.reviewRuleProposals.map((x) => x.id), "operator@test");
  assert.equal(out.jurisdictionCriteria?.applied.length, 2, JSON.stringify(out.jurisdictionCriteria));
  assert.ok(rules().every((r) => r.status === "approved" && r.approved_at));
  assert.ok(itemPayload(srcPid, corrId)!.reviewRuleProposals.every((x) => x.status === "applied"));
  const again = applyCorrectionApproval(db, corrId, p.reviewRuleProposals.map((x) => x.id), "operator@test");
  assert.equal(again.jurisdictionCriteria?.attempted ?? 0, 0);
});

await check("APPROVED FIRES: the next project in that AHJ — 18 in pathway on its own sheet -> BLOCKER; the missing note -> WARNING", () => {
  const pid = mkProject(AHJ, { planSetExtractedText: NEXT_PLAN });
  const fs = findingsFor(pid, AHJ);
  const f = get(fs, PRIOR_CORRECTION_ID);
  assert.equal(f?.severity, "blocker", JSON.stringify(fs.map((x) => [x.id, x.severity])));
  assert.match(f!.message, /18 in/);
  assert.match(f!.message, /at least 36 in/);
  assert.equal(visionMayRelax(f!), false, "a measured comparison must not be relaxed by a picture");
  const u = get(fs, PRIOR_CORRECTION_UNCONFIRMED_ID);
  assert.equal(u?.severity, "warning");
  assert.match(u!.message, /RAPID SHUTDOWN/);
  assert.equal(visionMayRelax(u!), true, "absence of wording in the text layer is what vision can answer");
});

await check("a plan meeting both rules gets nothing; a value only the PARSER read is a WARNING, never a blocker", () => {
  const ok = mkProject(AHJ, { planSetExtractedText: "ROOF PLAN: 36\" FIRE ACCESS PATHWAY. PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN." });
  const fsOk = findingsFor(ok, AHJ);
  assert.ok(!get(fsOk, PRIOR_CORRECTION_ID) && !get(fsOk, PRIOR_CORRECTION_UNCONFIRMED_ID), JSON.stringify(fsOk.map((f) => f.id)));
  const project = R.getProjectDetail(db, ok).project;
  const parserOnly = { ...project, parserSnapshot: { ...project.parserSnapshot, planSetExtractedText: "", roofPlanNotesText: "Roof plan shows an 18\" fire access pathway. PV system equipped with rapid shutdown." } };
  const f = get(evaluateDesignCodeFindings(parserOnly as never, null, CP.resolveEffectiveCodeContext(db, "OR", AHJ)), PRIOR_CORRECTION_ID);
  assert.equal(f?.severity, "warning");
});

await check("ANOTHER AHJ IS UNAFFECTED: the same plan in a different city gets no prior-correction finding", () => {
  const pid = mkProject(OTHER, { planSetExtractedText: NEXT_PLAN });
  const fs = findingsFor(pid, OTHER);
  assert.ok(!get(fs, PRIOR_CORRECTION_ID) && !get(fs, PRIOR_CORRECTION_UNCONFIRMED_ID));
  assert.deepEqual(CP.listApprovedReviewRules(db, "OR", OTHER), []);
  assert.deepEqual(CP.listApprovedReviewRules(db, "WA", AHJ), [], "same name, another state");
});

await check("a second correction asking the same thing reuses the approved rule (already_approved), no duplicate row", () => {
  const pid = mkProject(AHJ);
  const cid = R.addManualCorrection(db, pid, "Revise the roof plan: provide a minimum 36 inch wide fire access pathway.").corrections[0].id;
  const p = itemPayload(pid, cid)!;
  assert.deepEqual(p.reviewRuleProposals.map((x) => x.status), ["already_approved"]);
  assert.equal(rules().length, 2);
});

await check("a reviewer's QUESTION (C bucket) proposes nothing", () => {
  const pid = mkProject("City of Askport");
  const cid = R.addManualCorrection(db, pid, "Please clarify: is the label reading \"PV DISCONNECT\" required by the utility?").corrections[0].id;
  assert.deepEqual(itemPayload(pid, cid)?.reviewRuleProposals ?? [], []);
  assert.equal(db.query("SELECT 1 FROM jurisdiction_review_rules WHERE ahj = ?", ["City of Askport"]).length, 0);
});

await check("an approval after the correction was RE-BUCKETED to a question is refused; the rule stays proposed and silent", () => {
  const pid = mkProject("City of Rebucket");
  const cid = R.addManualCorrection(db, pid, "Fire access pathways shall be a minimum of 3 ft wide.").corrections[0].id;
  const p = itemPayload(pid, cid)!;
  assert.equal(p.reviewRuleProposals.length, 1);
  persistTriage(db, { correctionId: cid, projectId: pid }, { bucket: "C_reviewer_clarification", actions: ["Answer the reviewer."], proposals: [] });
  const out = applyCorrectionApproval(db, cid, [p.reviewRuleProposals[0].id], "operator@test");
  assert.equal(out.jurisdictionCriteria?.refused.length, 1);
  assert.equal(db.get<{ status: string }>("SELECT status FROM jurisdiction_review_rules WHERE ahj = ?", ["City of Rebucket"])?.status, "proposed");
  assert.deepEqual(CP.listApprovedReviewRules(db, "OR", "City of Rebucket"), []);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 5. THE CARD — the shipped function lifted out of dashboard.js.
// ─────────────────────────────────────────────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = fs.readFileSync(path.join(here, "..", "..", "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (kind: "function" | "const", name: string): string => {
  const re = kind === "function" ? new RegExp(`^function ${name}\\(`, "m") : new RegExp(`^const ${name} = `, "m");
  const m = re.exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${kind} ${name}`);
  let depth = 0, end = -1;
  for (let j = dashboard.indexOf("{", m.index); j < dashboard.length; j++) {
    if (dashboard[j] === "{") depth++;
    else if (dashboard[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dashboard.slice(m.index, end) + (kind === "const" ? ";" : "");
};
const render = new Function(`${[cut("function", "esc"), cut("const", "REVIEW_RULE_FIELD_LABELS"), cut("const", "REVIEW_RULE_STATUS_LABELS"), cut("function", "reviewRuleProposalsHtml")].join("\n\n")}
return reviewRuleProposalsHtml;`)() as (list: unknown[]) => string;

await check("the card names the rule and the AHJ, says nothing runs until approved, and esc()s the sentence and wording", () => {
  const html = render([{
    kind: "jurisdiction_review_rule", id: "review-rule:x", ruleId: "x", ahj: "City of <b>Ruleport</b>", state: "OR", profileKey: "k",
    check: { kind: "required_text", field: "planText", value: "<script>alert(1)</script>" },
    basis: "Add the note \"<img src=x onerror=alert(1)>\"", source: { correctionId: "c", recordNumber: "", receivedAt: "" }, status: "proposed",
  }, {
    kind: "jurisdiction_review_rule", id: "review-rule:y", ruleId: "y", ahj: "City of Ruleport", state: "OR", profileKey: "k",
    check: { kind: "min_value", field: "pathwayWidthIn", value: 36, unit: "in" },
    basis: "Provide a minimum 36 inch pathway.", source: { correctionId: "c", recordNumber: "", receivedAt: "" }, status: "already_approved",
  }]);
  assert.doesNotMatch(html, /<script>|<img|<b>Ruleport/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Fire access pathway width at least 36 in/);
  assert.match(html, /Nothing is checked until you approve/);
  assert.match(html, /Already a rule/);
  assert.equal(render([]), "");
});

console.log(failures === 0 ? "\nahjRuleProposals: all checks passed" : `\nahjRuleProposals: ${failures} FAILED`);
try { db.close(); } catch { /* ignore */ }
process.exit(failures === 0 ? 0 : 1);
