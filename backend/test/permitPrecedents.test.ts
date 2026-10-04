// ISSUED PERMITS IN THE SAME AHJ AS A CHECK (#147).
//
// An issued structural permit records what the plan CARRIED (module, inverter, racking, attachment
// hardware, roof detail). The next plan in that AHJ is compared with it: a reused product is a
// CALLOUT; a departure from every accepted precedent on a dimension the AHJ has corrected before
// (its shared correction rollup) is city.ahj.precedent-departure — a WARNING naming the precedent,
// never a blocker, never relaxed by vision, and never a model call. Synthetic data only.
//
// Run: npx tsx backend/test/permitPrecedents.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApprovedDesignObservation, CommonCorrectionPattern, ProjectRecord, ReviewerFinding } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "permit-precedents-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CODE_RESEARCH;
delete process.env.SKIP_CODE_RESEARCH;
delete process.env.PORTAL_AUTOSEED;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const CP = await import("../src/codeProfiles");
const { buildReviewerReport } = await import("../src/reviewerEngine");
const { visionMayRelax, MEASURED_FINDING_IDS } = await import("../src/reviewerVision");
const P = await import("../src/permitPrecedents");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const AHJ = "City of Precedentville";
const ISSUED_PLAN = {
  moduleMake: "Synthetic Solar", moduleModel: "SS-400", pvMicroMake: "Microco", pvMicroModel: "MC-8",
  rackingSystem: "Railco R100", attachmentHardware: "Footco FlashFoot 2", roofMaterial: "Composition Shingle", framingType: "rafter",
};
const mkPlan = (over: Record<string, string> = {}, id = "plan-under-review"): ProjectRecord => ({
  id, clientId: "c", homeownerName: "Synthetic Owner", projectAddress: "1 Test Way", city: "Testbay", state: "OR", zip: "97420",
  ahj: AHJ, utility: "Test Power", systemSizeDcKw: 8, systemSizeAcKw: 7, interconnectionMethod: "Load-side breaker", status: "pending",
  parserSnapshot: { state: "OR", ahj: AHJ, mounting: "Roof mount", ...ISSUED_PLAN, ...over },
} as unknown as ProjectRecord);
const issued = (projectId: string, issuedAt: string, over: Record<string, string> = {}): ApprovedDesignObservation => ({
  projectId, recordNumber: `REC-${projectId}`, issuedAt, criteria: [],
  precedents: P.extractPermitPrecedents(mkPlan(over, projectId)),
});
const correction = (bucket: CommonCorrectionPattern["bucket"], rootCause: string, requiredAction = ""): CommonCorrectionPattern =>
  ({ signature: rootCause, bucket, rootCause, requiredAction, count: 2, lastSeenAt: "2026-06-01T00:00:00Z" });
const ctxWith = (approvedDesigns: ApprovedDesignObservation[], ahjCorrections: CommonCorrectionPattern[] = []) =>
  ({ ...CP.buildCodeContext("OR", AHJ, null, approvedDesigns), ahjCorrections });
const find = (fs: ReviewerFinding[], id: string) => fs.filter((f) => f.id === id);

const PRIOR = [issued("p1", "2026-03-01T00:00:00Z"), issued("p2", "2026-05-10T00:00:00Z")];
const ATTACH_CORRECTED = correction("B_designer_fix", "Attachment detail does not match the flashing manufacturer's listing", "Provide the attachment cut sheet");

console.log("\n1. A PRODUCT THE OFFICE ALREADY ACCEPTED IS A CALLOUT");
await check("the same module / micro / racking / attachment / roof detail -> one callout naming each, with counts and dates, no record number", () => {
  const out = P.evaluatePermitPrecedentFindings(mkPlan(), ctxWith(PRIOR, [ATTACH_CORRECTED]));
  assert.deepEqual(out.map((f) => [f.id, f.severity]), [[P.PRECEDENT_MATCH_ID, "callout"]]);
  const m = out[0].message;
  assert.match(m, /module "Synthetic Solar SS-400" \(2 issued permits, latest 2026-05-10\)/);
  assert.match(m, /inverter "Microco MC-8"/);
  assert.match(m, /attachment hardware "Footco FlashFoot 2"/);
  assert.match(m, /roof attachment detail "Composition Shingle \/ rafter"/);
  assert.doesNotMatch(m, /REC-p|p1|p2/, "another project's id or record number reached pooled finding text");
});
await check("matching ignores case, spacing and punctuation", () => {
  const out = P.evaluatePermitPrecedentFindings(mkPlan({ attachmentHardware: "FOOTCO flashfoot-2" }), ctxWith(PRIOR, [ATTACH_CORRECTED]));
  assert.equal(find(out, P.PRECEDENT_DEPARTURE_ID).length, 0);
  assert.match(find(out, P.PRECEDENT_MATCH_ID)[0].message, /attachment hardware/);
});

console.log("\n2. A DEPARTURE ON A DIMENSION THE AHJ HAS CORRECTED IS A WARNING NAMING THE PRECEDENT");
await check("a different attachment where the AHJ corrected attachments -> city.ahj.precedent-departure warning", () => {
  const out = P.evaluatePermitPrecedentFindings(mkPlan({ attachmentHardware: "Otherco QuickMount Z" }), ctxWith(PRIOR, [ATTACH_CORRECTED]));
  const dep = find(out, P.PRECEDENT_DEPARTURE_ID);
  assert.equal(dep.length, 1);
  assert.equal(dep[0].severity, "warning");
  assert.match(dep[0].message, /attachment hardware "Otherco QuickMount Z" matches none that issued permits in City of Precedentville carried: "Footco FlashFoot 2" \(2 issued permits, latest 2026-05-10\)/);
  assert.match(dep[0].message, /has corrected the attachment hardware before \(2 corrections; e\.g\. "Attachment detail does not match/);
  assert.match(dep[0].cityFeedback, /previously accepted: Footco FlashFoot 2/);
  assert.doesNotMatch(dep[0].message + dep[0].cityFeedback + dep[0].designTeamAction, /REC-p/);
  // The other dimensions still match: the callout stays, listing them.
  assert.match(find(out, P.PRECEDENT_MATCH_ID)[0].message, /module "Synthetic Solar SS-400"/);
});
await check("MUST EXCLUDE: a departure on a dimension the AHJ never corrected says nothing (a new module is not a deficiency)", () => {
  const out = P.evaluatePermitPrecedentFindings(mkPlan({ moduleModel: "SS-500" }), ctxWith(PRIOR, [ATTACH_CORRECTED]));
  assert.equal(find(out, P.PRECEDENT_DEPARTURE_ID).length, 0);
});
await check("MUST EXCLUDE: an operator-paperwork (A_we_fix) correction does not make a design dimension 'corrected'", () => {
  const out = P.evaluatePermitPrecedentFindings(mkPlan({ attachmentHardware: "Otherco QuickMount Z" }),
    ctxWith(PRIOR, [correction("A_we_fix", "Attachment cut sheet missing from the upload")]));
  assert.equal(find(out, P.PRECEDENT_DEPARTURE_ID).length, 0);
});
await check("MUST EXCLUDE: no precedent on that dimension -> no departure (nothing accepted to depart from)", () => {
  const noAttach = [issued("p1", "2026-03-01T00:00:00Z", { attachmentHardware: "" })];
  const out = P.evaluatePermitPrecedentFindings(mkPlan({ attachmentHardware: "Otherco QuickMount Z" }), ctxWith(noAttach, [ATTACH_CORRECTED]));
  assert.equal(find(out, P.PRECEDENT_DEPARTURE_ID).length, 0);
});
await check("MUST EXCLUDE: a project is never its own precedent (re-review after its own permit issued)", () => {
  const self = [issued("plan-under-review", "2026-05-10T00:00:00Z")];
  assert.deepEqual(P.evaluatePermitPrecedentFindings(mkPlan(), ctxWith(self, [ATTACH_CORRECTED])), []);
});
await check("no issued permit recorded here -> no findings at all", () => {
  assert.deepEqual(P.evaluatePermitPrecedentFindings(mkPlan(), ctxWith([], [ATTACH_CORRECTED])), []);
});

console.log("\n3. NEVER A BLOCKER, NEVER RELAXED BY VISION");
await check("city.ahj.precedent-departure is in MEASURED_FINDING_IDS; visionMayRelax is false", () => {
  assert.ok(MEASURED_FINDING_IDS.has(P.PRECEDENT_DEPARTURE_ID));
  assert.equal(visionMayRelax({ id: P.PRECEDENT_DEPARTURE_ID, severity: "warning", title: "" } as ReviewerFinding), false);
});
await check("through buildReviewerReport, every precedent finding is a warning or callout — even with a verified profile", () => {
  const verified = { key: "", state: "OR", ahj: AHJ, confidence: "verified" as const, adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "" };
  const codeContext = { ...CP.buildCodeContext("OR", AHJ, verified, PRIOR), ahjCorrections: [ATTACH_CORRECTED, correction("B_designer_fix", "Racking rails exceed span")] };
  const report = buildReviewerReport(mkPlan({ attachmentHardware: "Otherco QuickMount Z", rackingSystem: "Otherco Rail 9" }), { codeContext });
  const mine = report.findings.filter((f) => f.id.startsWith("city.ahj.precedent-"));
  assert.deepEqual(mine.map((f) => [f.id, f.severity]).sort(), [[P.PRECEDENT_DEPARTURE_ID, "warning"], [P.PRECEDENT_MATCH_ID, "callout"]]);
  // Both departed dimensions are in the one warning (the gate keeps one finding per id).
  const dep = mine.find((f) => f.id === P.PRECEDENT_DEPARTURE_ID)!;
  assert.match(dep.title, /racking, attachment hardware/);
  assert.match(dep.message, /racking "Otherco Rail 9" matches none .* "Railco R100"/);
  assert.match(dep.message, /attachment hardware "Otherco QuickMount Z" matches none .* "Footco FlashFoot 2"/);
});

console.log("\n4. THE MONITOR RECORDS THE PRECEDENT; THE CONTEXT CARRIES THE AHJ'S CORRECTIONS");
await check("an issued STRUCTURAL reading records the plan's products (even with no stated design criteria); the next plan is checked against them, no model call", async () => {
  CP.saveResearchedCodeProfile(db, { key: "", state: "OR", ahj: AHJ, confidence: "seeded", adoptedCodes: [{ code: "ORSC", edition: "2023" }], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "" });
  const pid = R.createProject(db, {
    owner: "Synthetic Owner", state: "OR", dcKw: "8.4", acKw: "7.7", street: "1 Test Way", city: "Testbay", zip: "97420",
    ahj: AHJ, utility: "Test Power", ...ISSUED_PLAN,
  } as never).project.id;
  const detail = R.createPermitCheckTarget(db, pid, {
    jurisdiction: AHJ, portalName: "Test ePermitting", portalUrl: "https://permits.example.test/cap",
    applicationNumber: "TEST-0001-STR", permitType: "building", targetType: "permit",
  } as never) as never as { permitCheckTargets: Array<{ id: string }> };
  const tid = String(detail.permitCheckTargets[detail.permitCheckTargets.length - 1].id);
  const page = (s: string) => `Record TEST-0001-STR: Residential Structural Record Status: ${s} Record Info Processing Status`;
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review") });
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("Issued") });
  const obs = CP.listApprovedDesignObservations(db, "OR", AHJ);
  assert.equal(obs.length, 1, "no observation recorded for a plan that states products but no design criteria");
  assert.deepEqual(obs[0].precedents?.find((p) => p.dimension === "attachment"), { dimension: "attachment", value: "Footco FlashFoot 2" });

  // The AHJ's shared correction rollup (bucket/rootCause/requiredAction/count only).
  const ts = "2026-06-01T00:00:00Z";
  const kb = (id: string, ahj: string, items: CommonCorrectionPattern[]) => db.run(
    `INSERT INTO permit_utility_knowledge (id, profile_key, state, ahj, utility, common_corrections_json, first_seen_at, last_learned_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_key) DO UPDATE SET common_corrections_json = excluded.common_corrections_json`,
    [id, `or|${ahj.toLowerCase()}|test power`, "OR", ahj, "Test Power", JSON.stringify(items), ts, ts, ts]);
  kb("kb-prec", AHJ, [ATTACH_CORRECTED]);
  // Another AHJ's corrections never count here.
  kb("kb-other", "City of Elsewhere", [correction("B_designer_fix", "Module not listed")]);

  const llmBefore = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls")?.n ?? 0);
  const ctx = CP.resolveEffectiveCodeContext(db, "OR", AHJ);
  assert.deepEqual((ctx.ahjCorrections ?? []).map((c) => c.rootCause), [ATTACH_CORRECTED.rootCause]);
  const report = buildReviewerReport(mkPlan({ attachmentHardware: "Otherco QuickMount Z", moduleModel: "SS-500" }, "next-plan"), { codeContext: ctx });
  const dep = report.findings.filter((f) => f.id === P.PRECEDENT_DEPARTURE_ID);
  assert.equal(dep.length, 1, `expected one departure (attachment), got ${dep.map((f) => f.title).join(" | ")}`);
  assert.match(dep[0].message, /"Footco FlashFoot 2" \(1 issued permit, latest/);
  assert.doesNotMatch(dep[0].message, /TEST-0001-STR/, "a record number reached pooled finding text");
  assert.equal(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls")?.n ?? 0), llmBefore, "the precedent check made a model call");
});

db.close();
console.log(failures === 0 ? "\npermitPrecedents: all checks passed" : `\npermitPrecedents: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
