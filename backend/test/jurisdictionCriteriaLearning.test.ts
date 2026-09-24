// EVERY PROJECT TEACHES THE JURISDICTION — SAFELY.
//
// Two real bounces (fixtures are SYNTHETIC strings modelled on their facts — no names,
// addresses, firms or seals):
//   A. A coastal city's building review, "Addl Info Needed": "Provide updated design criteria
//      ... -Ground snow load 36 psf. Provide updated mounting spacing. -The mounting spacing
//      should be 2' oc per R324.4.1 exception 5 exception 1.4. Provide UL listing ..." Its code
//      profile had designCriteria {} and prescriptive {}; nothing learned from the comment.
//   B. Another coastal city: "... special wind region. The minimum wind speed design is 120 MPH
//      Ultimate Exposure D. R310.2.1 ORSC" plus a conflicting-criteria item and a manufactured-
//      home item that state no number. No profile row for that city at all.
//
// WHAT THIS FILE REFUSES TO LET REGRESS:
//   1. AHJ COMMENT -> PROPOSAL: the deterministic extractor reads A and B into the right
//      criteria (MUST-PASS) and nothing else (MUST-EXCLUDE: a live load, a fee, a code section,
//      framing spacing, roof snow, a quoted package value, an ASD speed, a rating, a negation).
//      Intake (addManualCorrection — the real write path) attaches them to the correction's
//      review item; apply lands them as SEEDED with a citation to the comment; a verified row
//      is untouched; an existing different seeded value is shown old -> new and a value that
//      drifted after the proposal is refused; a later research re-save keeps the AHJ's value.
//   2. APPROVED DESIGNS ARE CORROBORATION: the monitor's first issued reading records an
//      observation; designCriteria is unchanged; the unknown finding quotes it; a value a later
//      AHJ correction contradicted is not counted.
//   3. LOOK IT UP: one design-criteria lookup per AHJ lacking criteria, skipped when off /
//      keyless / recently asked / verified; the merge fills blanks only (stubbed LLM).
//
//   npx tsx backend/test/jurisdictionCriteriaLearning.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesignCriteriaResearchResult, JurisdictionCodeProfile, LLMProvider } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jurisdiction-criteria-"));
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
const { extractAhjRequiredCriteria, evaluateDesignCriteriaFindings } = await import("../src/designCriteria");
const { applyJurisdictionProposals, applyCorrectionApproval, parseCorrectionProposals, persistTriage } = await import("../src/correctionAgent");
const { enqueueJob, processNextJob } = await import("../src/jobQueue");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const TEXT_A = "Provide updated design criteria for the letter from the engineer and the plan set. -Ground snow load 36 psf. "
  + "Provide updated mounting spacing. -The mounting spacing should be 2' oc per R324.4.1 exception 5 exception 1.4. "
  + "Provide UL listing for the panels, mounting and racking hardware.";
const TEXT_B = "1. The structural engineered design criteria is conflicting between the calculations and the submitted plans set. "
  + "Please ensure the correct design criteria is the same on all documents. R106 ORSC 2. Testcoast City is located in a special wind region. "
  + "The minimum wind speed design is 120 MPH Ultimate Exposure D. R310.2.1 ORSC 3. The proposed installation is being placed on a manufactured home. "
  + "Prescriptive code does not allow this as these structures are not conventionally designed to support any additional loads. "
  + "Revise the structural design to show how the new loads will be adequately transferred through the existing walls to the ground below (Cont. load path). R301.1.3 ORSC";

const asMap = (list: Array<{ criterion: string; value: unknown }>): Record<string, unknown> =>
  Object.fromEntries(list.map((c) => [c.criterion, c.value]));

// ─────────────────────────────────────────────────────────────────────────────────────────
// 1a. THE EXTRACTOR — must pass AND must exclude.
// ─────────────────────────────────────────────────────────────────────────────────────────
await check("MUST PASS (A): ground snow 36 psf and 2' o.c. attachment spacing (24 in) — and nothing else", () => {
  const got = extractAhjRequiredCriteria(TEXT_A);
  assert.deepEqual(asMap(got), { groundSnowLoadPsf: 36, maxAttachmentSpacingIn: 24 });
  assert.equal(got.find((c) => c.criterion === "maxAttachmentSpacingIn")?.block, "prescriptive");
  assert.match(String(got.find((c) => c.criterion === "groundSnowLoadPsf")?.basis), /Ground snow load 36 psf/);
});

await check("MUST PASS (B): 120 mph ultimate, Exposure D, special wind region — items 1 and 3 state no criterion", () => {
  assert.deepEqual(asMap(extractAhjRequiredCriteria(TEXT_B)), { specialWindRegion: true, windSpeedMph: 120, windExposure: "D" });
});

await check("MUST PASS: other honest phrasings of the same requirements", () => {
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Design ground snow load (Pg) shall be 25 psf.")), { groundSnowLoadPsf: 25 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Attachments must be spaced at 48\" o.c. maximum.")), { maxAttachmentSpacingIn: 48 });
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Use Vult = 130 mph, Exposure C.")), { windSpeedMph: 130, windExposure: "C" });
  // The framing member's spacing in the SAME sentence is not the attachment spacing.
  assert.deepEqual(asMap(extractAhjRequiredCriteria("Roof hooks shall be at 48\" o.c. max into rafters @ 16\" o.c.")), { maxAttachmentSpacingIn: 48 });
});

await check("MUST EXCLUDE: live load, fee, code sections, framing, roof snow, quoted package, ASD, rating, negation, ambiguity", () => {
  const none: string[] = [
    "Roof live load shall be 20 psf roof live load.",
    "The plan review fee is $120. The permit fee is $365.40, payable before issuance.",
    "See R324.4.1 exception 5 exception 1.4 and R310.2.1.",
    "Existing 2x4 rafters @ 24\" o.c. — verify span.",
    "Roof snow load 36 psf.",
    "The calculations show Exposure B, 95 mph wind and ground snow 28 psf.",
    "Vasd 93 mph wind.",
    "Racking is tested to 160 mph wind.",
    "Pg(asd) 20 psf.",
    "Testcoast City is not located in a special wind region.",
    "Ground snow load 25 psf. Ground snow load 36 psf.", // two values: ambiguous, a human reads it
    "Provide UL listing for the panels, mounting and racking hardware.",
  ];
  for (const text of none) assert.deepEqual(extractAhjRequiredCriteria(text), [], `extracted from: ${text}`);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 1b. INTAKE -> PROPOSAL -> APPLY, through the real write paths.
// ─────────────────────────────────────────────────────────────────────────────────────────
const seeded = (ahj: string, over: Partial<JurisdictionCodeProfile> = {}): void => {
  CP.saveResearchedCodeProfile(db, {
    key: "", state: "OR", ahj, confidence: "seeded",
    adoptedCodes: [{ code: "ORSC", edition: "2023" }], amendments: [], designCriteria: {}, prescriptive: {},
    fireSetbacks: [], citations: [], updatedAt: "", ...over,
  });
};
const ownRow = (ahj: string) => CP.ownCodeProfileRow(db, "OR", ahj);
const mkProject = (ahj: string, snapshot: Record<string, string> = {}, learningExcluded = false): string => R.createProject(db, {
  owner: "Synthetic Owner", state: "OR", dcKw: "8.4", acKw: "7.7", street: "1 Test Way", city: "Testbay", zip: "97420",
  ahj, utility: "Test Power", ...snapshot,
} as never, undefined, { learningExcluded }).project.id;
const itemPayload = (projectId: string, correctionId: string) => {
  const row = db.query<{ notes: string }>("SELECT notes FROM human_review_items WHERE project_id = ? AND field_name = 'correction'", [projectId])
    .find((r) => parseCorrectionProposals(r.notes)?.correctionId === correctionId);
  return row ? parseCorrectionProposals(row.notes) : null;
};

seeded("City of Testbay");
const pidA = mkProject("City of Testbay");
const corrA = R.addManualCorrection(db, pidA, TEXT_A).corrections[0].id;

await check("intake attaches JURISDICTION proposals (blank -> value), separate from the project-field list", () => {
  const p = itemPayload(pidA, corrA);
  assert.ok(p, "no linked review item");
  assert.deepEqual(p!.proposals, [], "a jurisdiction value leaked into the project-field proposals");
  const j = p!.jurisdictionProposals;
  assert.deepEqual(asMap(j), { groundSnowLoadPsf: 36, maxAttachmentSpacingIn: 24 });
  for (const x of j) {
    assert.equal(x.status, "proposed");
    assert.equal(x.currentValue, null);
    assert.equal(x.ahj, "City of Testbay");
    assert.equal(x.source.correctionId, corrA);
    assert.equal(x.profileKey, ownRow("City of Testbay")!.key);
  }
});

await check("the LLM triage's rewrite of the notes keeps the jurisdiction proposals", () => {
  persistTriage(db, { correctionId: corrA, projectId: pidA }, { actions: ["Revise sheets."], proposals: [] });
  assert.equal(itemPayload(pidA, corrA)!.jurisdictionProposals.length, 2);
});

await check("APPLY: lands as seeded with the value + a citation to the AHJ comment; a second apply does nothing", () => {
  const r = applyJurisdictionProposals(db, corrA, undefined, "operator@test");
  assert.equal(r.applied.length, 2, JSON.stringify(r));
  const row = ownRow("City of Testbay")!;
  assert.equal(row.profile.confidence, "seeded");
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 36);
  assert.equal(row.profile.prescriptive.maxAttachmentSpacingIn, 24);
  const cite = row.profile.citations.find((c) => c.kind === "ahj_correction" && c.field === "designCriteria.groundSnowLoadPsf");
  assert.ok(cite, "no ahj_correction citation");
  assert.equal(cite!.correctionId, corrA);
  assert.match(String(cite!.quote), /Ground snow load 36 psf/);
  assert.ok(itemPayload(pidA, corrA)!.jurisdictionProposals.every((x) => x.status === "applied"));
  assert.equal(applyJurisdictionProposals(db, corrA, undefined, "operator@test").attempted, 0, "an applied proposal re-applied");
  assert.ok(R.getProjectDetail(db, pidA).project, "project still readable");
});

await check("a later research / import re-save keeps the value the AHJ itself stated", () => {
  seeded("City of Testbay", { designCriteria: { groundSnowLoadPsf: 20, windSpeedMph: 100 } });
  const row = ownRow("City of Testbay")!;
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 36, "research overwrote the AHJ's own value");
  assert.equal(row.profile.designCriteria.windSpeedMph, 100, "research's other values should still land");
  assert.ok(row.profile.citations.some((c) => c.kind === "ahj_correction"));
});

await check("a VERIFIED row is never touched: proposal is blocked, and a forced apply is refused", () => {
  CP.saveVerifiedCodeProfile(db, {
    key: "", state: "OR", ahj: "City of Verifiedport", confidence: "verified",
    adoptedCodes: [{ code: "ORSC", edition: "2023" }], amendments: [], designCriteria: { groundSnowLoadPsf: 30 }, prescriptive: {},
    fireSetbacks: [], citations: [], updatedAt: "",
  }, "tester");
  const pid = mkProject("City of Verifiedport");
  const cid = R.addManualCorrection(db, pid, "Ground snow load 36 psf.").corrections[0].id;
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.equal(j.length, 1);
  assert.equal(j[0].status, "blocked_verified");
  assert.equal(applyJurisdictionProposals(db, cid, undefined, "op").attempted, 0);
  const forced = CP.applyCorrectionCriterionToProfile(db, { ...j[0], status: "proposed" }, { actor: "op", projectId: pid });
  assert.equal(forced.status, "refused");
  const row = ownRow("City of Verifiedport")!;
  assert.equal(row.profile.confidence, "verified");
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 30);
});

await check("a DIFFERENT seeded value is shown old -> new, and a value that drifted since is refused", () => {
  seeded("City of Oldvalue", { designCriteria: { groundSnowLoadPsf: 25 } });
  const pid = mkProject("City of Oldvalue");
  const cid = R.addManualCorrection(db, pid, "Ground snow load 36 psf.").corrections[0].id;
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.equal(j[0].currentValue, 25);
  assert.equal(j[0].value, 36);
  assert.equal(j[0].status, "proposed");
  // Someone else changes the row before the human applies.
  seeded("City of Oldvalue", { designCriteria: { groundSnowLoadPsf: 30 } });
  const r = applyJurisdictionProposals(db, cid, ["jurisdiction:groundSnowLoadPsf"], "op");
  assert.equal(r.refused.length, 1, JSON.stringify(r));
  assert.equal(ownRow("City of Oldvalue")!.profile.designCriteria.groundSnowLoadPsf, 30, "a value the human never saw was overwritten");
});

await check("B: no row yet -> proposals from blank; apply creates the AHJ's seeded row", () => {
  const pid = mkProject("City of Testcoast");
  const cid = R.addManualCorrection(db, pid, TEXT_B).corrections[0].id;
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.deepEqual(asMap(j), { specialWindRegion: true, windSpeedMph: 120, windExposure: "D" });
  assert.ok(j.every((x) => x.profileKey === "" && x.currentValue === null));
  const r = applyJurisdictionProposals(db, cid, undefined, "op");
  assert.equal(r.applied.length, 3);
  const row = ownRow("City of Testcoast")!;
  assert.equal(row.profile.confidence, "seeded");
  assert.deepEqual([row.profile.designCriteria.windSpeedMph, row.profile.designCriteria.windExposure, row.profile.designCriteria.specialWindRegion], [120, "D", true]);
});

await check("THE APPROVAL (apply route): a jurisdiction-only, non-design correction applies without a 409", () => {
  seeded("City of Routeville");
  const pid = mkProject("City of Routeville");
  const created = R.addManualCorrection(db, pid, "Ground snow load 36 psf.").corrections[0];
  assert.notEqual(created.correctionBucket, "B_designer_fix", "fixture precondition: this leg needs a non-design bucket");
  const out = applyCorrectionApproval(db, created.id, undefined, "op");
  assert.equal(out.jurisdictionCriteria?.applied.length, 1);
  assert.equal(ownRow("City of Routeville")!.profile.designCriteria.groundSnowLoadPsf, 36);
  // Project fields were not touched and the project did not move to a designer wait.
  assert.notEqual(String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid])?.status), "waiting_on_designer");
});

await check("THE APPROVAL: a design correction applies its jurisdiction values AND parks on the designer", () => {
  seeded("City of Designton");
  const pid = mkProject("City of Designton");
  const created = R.addManualCorrection(db, pid, TEXT_A).corrections[0];
  assert.equal(created.correctionBucket, "B_designer_fix");
  const out = applyCorrectionApproval(db, created.id, undefined, "op");
  assert.equal(out.jurisdictionCriteria?.applied.length, 2);
  assert.equal(String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [pid])?.status), "waiting_on_designer");
});

await check("THE APPROVAL: fields that select only a PROJECT field leave the jurisdiction proposals proposed", () => {
  seeded("City of Selectton");
  const pid = mkProject("City of Selectton");
  const cid = R.addManualCorrection(db, pid, TEXT_A).corrections[0].id;
  applyCorrectionApproval(db, cid, ["meterNumber"], "op");
  assert.equal(ownRow("City of Selectton")!.profile.designCriteria.groundSnowLoadPsf, undefined, "an unselected jurisdiction value was applied");
});

await check("MUST EXCLUDE: a utility correction and a learning-excluded project teach no jurisdiction", () => {
  const pid = mkProject("City of Utilitytown");
  const cid = R.addManualCorrection(db, pid, "Ground snow load 36 psf.", "utility_email").corrections[0].id;
  assert.equal(itemPayload(pid, cid)!.jurisdictionProposals.length, 0);
  const demo = mkProject("City of Demoville", {}, true);
  const did = R.addManualCorrection(db, demo, "Ground snow load 36 psf.").corrections[0].id;
  assert.equal(itemPayload(demo, did)!.jurisdictionProposals.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 2. APPROVED DESIGNS ARE CORROBORATION, NOT THE RULE.
// ─────────────────────────────────────────────────────────────────────────────────────────
const page = (status: string): string =>
  `Record 187-26-000777-STR: Residential Structural Record Status: ${status} Expiration Date: 03/16/2027 Record Info Processing Status`;
const mkTarget = (pid: string, jurisdiction: string, targetType = "permit"): string => {
  const detail = R.createPermitCheckTarget(db, pid, {
    jurisdiction, portalName: "Test ePermitting", portalUrl: "https://permits.example.test/cap",
    applicationNumber: "187-26-000777-STR", permitType: targetType === "nem" ? "nem" : "building", targetType,
  } as never) as never as { permitCheckTargets: Array<{ id: string; targetType?: string }> };
  return String(detail.permitCheckTargets[detail.permitCheckTargets.length - 1].id);
};
await check("MONITOR intake: an 'Addl Info Needed' reading's text is proposed for the TARGET's jurisdiction, with its record", async () => {
  const pid = mkProject("City of Monitorbay");
  const tid = mkTarget(pid, "Monitor County");
  db.run("UPDATE permit_check_targets SET application_number = '187-26-000888-STR' WHERE id = ?", [tid]);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review") });
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url",
    rawStatusText: page("In Review/Addl Info Needed").replace("187-26-000777-STR", "187-26-000888-STR") + " Ground snow load 36 psf." });
  const cid = String(db.get<{ id: string }>("SELECT id FROM corrections WHERE project_id = ?", [pid])?.id ?? "");
  assert.ok(cid, "the monitor raised no correction (fixture precondition)");
  const j = itemPayload(pid, cid)!.jurisdictionProposals;
  assert.deepEqual(asMap(j), { groundSnowLoadPsf: 36 });
  assert.equal(j[0].ahj, "Monitor County");
  assert.equal(j[0].source.recordNumber, "187-26-000888-STR");
});

await check("MUST EXCLUDE: a correction raised on a utility (NEM) target proposes nothing for a building jurisdiction", async () => {
  const pid = mkProject("City of Nemcorrect");
  const tid = mkTarget(pid, "Test Power", "nem");
  db.run("UPDATE permit_check_targets SET application_number = '187-26-000999-NEM' WHERE id = ?", [tid]);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review").replace("187-26-000777-STR", "187-26-000999-NEM") });
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url",
    rawStatusText: page("In Review/Addl Info Needed").replace("187-26-000777-STR", "187-26-000999-NEM") + " Ground snow load 36 psf." });
  const cid = String(db.get<{ id: string }>("SELECT id FROM corrections WHERE project_id = ?", [pid])?.id ?? "");
  assert.ok(cid, "the monitor raised no correction (fixture precondition)");
  assert.equal(itemPayload(pid, cid)!.jurisdictionProposals.length, 0);
});

const obsCount = (ahj: string): number => Number(db.get<{ n: number }>(
  "SELECT COUNT(*) AS n FROM jurisdiction_design_observations WHERE ahj = ?", [ahj])?.n ?? 0);

seeded("City of Approvedville");
const pidI = mkProject("City of Approvedville", { snow: "25", windSpeed: "120", wind: "C" });
const tidI = mkTarget(pidI, "City of Approvedville");

await check("the FIRST issued reading records an observation; designCriteria is unchanged; a re-read adds nothing", async () => {
  await R.recordPermitStatusCheck(db, pidI, { targetId: tidI, source: "public_url", rawStatusText: page("In Review") });
  assert.equal(obsCount("City of Approvedville"), 0, "an in-review reading recorded an approved design");
  await R.recordPermitStatusCheck(db, pidI, { targetId: tidI, source: "public_url", rawStatusText: page("Issued") });
  assert.equal(obsCount("City of Approvedville"), 1);
  await R.recordPermitStatusCheck(db, pidI, { targetId: tidI, source: "public_url", rawStatusText: page("Issued") });
  assert.equal(obsCount("City of Approvedville"), 1);
  assert.deepEqual(ownRow("City of Approvedville")!.profile.designCriteria, {}, "an approved design was written into the AHJ's rule");
  const obs = CP.listApprovedDesignObservations(db, "OR", "City of Approvedville");
  assert.equal(obs[0].recordNumber, "187-26-000777-STR");
  assert.ok(obs[0].criteria.some((c) => c.criterion === "groundSnowPsf" && c.value === 25));
});

await check("MUST EXCLUDE: a utility (NEM) target's approval records no building observation", async () => {
  const pid = mkProject("City of Nemtown", { snow: "25", windSpeed: "120" });
  const tid = mkTarget(pid, "Test Power", "nem");
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review") });
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("Issued") });
  assert.equal(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jurisdiction_design_observations WHERE project_id = ?", [pid])?.n ?? 0), 0);
});

await check("the unknown finding quotes approved designs; a value a LATER AHJ correction contradicted is not counted", () => {
  const ctx = CP.resolveEffectiveCodeContext(db, "OR", "City of Approvedville");
  const probe = R.getProjectDetail(db, pidI).project;
  const unknown = evaluateDesignCriteriaFindings(probe, ctx, { roofMounted: true }).find((f) => f.id === "city.struct.design-criteria-unknown");
  assert.ok(unknown, "no unknown finding");
  assert.match(unknown!.message, /Approved designs used: ground snow 25 psf \(1 issued permit/);
  assert.doesNotMatch(unknown!.message, /187-26-000777-STR/, "a record number reached pooled finding text");
  // The AHJ later says 36 (a correction applied after that permit issued): 25 no longer counts.
  const cid = R.addManualCorrection(db, pidI, "Ground snow load 36 psf.").corrections[0].id;
  db.run("UPDATE corrections SET created_at = ? WHERE id = ?", ["2999-01-01T00:00:00.000Z", cid]);
  const row = db.query<{ id: string; notes: string }>("SELECT id, notes FROM human_review_items WHERE project_id = ? AND field_name = 'correction'", [pidI])
    .find((r) => parseCorrectionProposals(r.notes)?.correctionId === cid)!;
  const payload = JSON.parse(row.notes.slice(13));
  payload.jurisdictionProposals = payload.jurisdictionProposals.map((p: { source: Record<string, string> }) => ({ ...p, source: { ...p.source, receivedAt: "2999-01-01T00:00:00.000Z" } }));
  db.run("UPDATE human_review_items SET notes = ? WHERE id = ?", [`agent-triage:${JSON.stringify(payload)}`, row.id]);
  assert.equal(applyJurisdictionProposals(db, cid, undefined, "op").applied.length, 1);
  const after = CP.resolveEffectiveCodeContext(db, "OR", "City of Approvedville");
  const below = evaluateDesignCriteriaFindings(probe, after, { roofMounted: true }).find((f) => f.id === "city.struct.design-criteria-below-ahj");
  assert.ok(below, "no below-ahj finding after the AHJ value landed");
  assert.match(below!.message, /contradicted by a later AHJ correction/);
  assert.doesNotMatch(below!.message, /ground snow 25 psf \(/, "a contradicted approved value was still counted");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 3. LOOK IT UP AT THE AHJ — once, never when off, never to overwrite.
// ─────────────────────────────────────────────────────────────────────────────────────────
const enqueued: Array<Record<string, unknown>> = [];
CP.setDesignResearchEnqueuerForTests((d, payload) => { enqueued.push(payload); enqueueJob(d, "design_criteria_research", payload, { priority: 3, maxRetries: 2 }); });

await check("keyless: no lookup is enqueued", () => {
  seeded("City of Lookupton");
  CP.resetResearchMarkersForTests();
  assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Lookupton"), 0);
  assert.equal(enqueued.length, 0);
});

await check("with a key: ONE lookup per AHJ (the review hook), deduped by the job row across restarts", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-called";
  try {
    CP.resetResearchMarkersForTests();
    CP.ensureCodeProfilesResearched(db, "OR", "City of Lookupton");
    CP.ensureCodeProfilesResearched(db, "OR", "City of Lookupton");
    assert.equal(enqueued.filter((p) => p.ahj === "City of Lookupton").length, 1);
    CP.resetResearchMarkersForTests(); // a restart: only the DB row remembers
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Lookupton"), 0, "re-queued within 30 days");
    assert.equal(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'design_criteria_research'")?.n ?? 0), 1);
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

await check("MUST EXCLUDE: switched off, offline, verified, or criteria already on file -> no lookup", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-called";
  try {
    seeded("City of Offton");
    CP.resetResearchMarkersForTests();
    process.env.CODE_RESEARCH = "off";
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Offton"), 0, "CODE_RESEARCH=off ignored");
    delete process.env.CODE_RESEARCH;
    process.env.PORTAL_AUTOSEED = "0";
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Offton"), 0, "offline switch ignored");
    delete process.env.PORTAL_AUTOSEED;
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Verifiedport"), 0, "a verified row was queued");
    seeded("City of Fullfile", { designCriteria: { groundSnowLoadPsf: 25, windSpeedMph: 110 } });
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Fullfile"), 0, "criteria on file, still queued");
    assert.equal(enqueued.filter((p) => ["City of Offton", "City of Verifiedport", "City of Fullfile"].includes(String(p.ahj))).length, 0);
    // Control: the same AHJ with every switch on DOES queue — the exclusions above are real.
    assert.equal(CP.ensureDesignCriteriaResearched(db, "OR", "City of Offton"), 1);
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.CODE_RESEARCH; delete process.env.PORTAL_AUTOSEED; }
});

const fakeProvider = (result: DesignCriteriaResearchResult): LLMProvider => ({ researchDesignCriteria: async () => result } as unknown as LLMProvider);

await check("the lookup fills BLANKS only, as seeded, with citations; web-grounded values only", async () => {
  seeded("City of Fillton", { designCriteria: { windSpeedMph: 110 } });
  const r = await CP.runDesignCriteriaResearch(db, { state: "OR", ahj: "City of Fillton" }, fakeProvider({
    provider: "claude", webGrounded: true, notes: "",
    values: [
      { criterion: "groundSnowLoadPsf", value: 30, sourceUrl: "https://fillton.example.gov/design", quote: "Ground snow load: 30 psf" },
      { criterion: "windSpeedMph", value: 140, sourceUrl: "https://fillton.example.gov/design" },
      { criterion: "windExposure", value: "C", sourceUrl: "" },
    ],
  }));
  const row = ownRow("City of Fillton")!;
  assert.equal(row.profile.confidence, "seeded");
  assert.equal(row.profile.designCriteria.groundSnowLoadPsf, 30);
  assert.equal(row.profile.designCriteria.windSpeedMph, 110, "a value on file was overwritten by research");
  assert.equal(row.profile.designCriteria.windExposure, undefined, "an unsourced value was stored");
  assert.ok(row.profile.citations.some((c) => c.kind === "design_criteria_research" && c.sourceUrl === "https://fillton.example.gov/design"));
  assert.deepEqual(r.filled, ["groundSnowLoadPsf"]);
  const memory = await CP.runDesignCriteriaResearch(db, { state: "OR", ahj: "City of Lookupton" }, fakeProvider({
    provider: "claude", webGrounded: false, notes: "", values: [{ criterion: "groundSnowLoadPsf", value: 30, sourceUrl: "https://x.example.gov" }],
  }));
  assert.equal(memory.saved, false);
  assert.equal(ownRow("City of Lookupton")!.profile.designCriteria.groundSnowLoadPsf, undefined, "model memory was stored");
  const verified = await CP.runDesignCriteriaResearch(db, { state: "OR", ahj: "City of Verifiedport" }, fakeProvider({
    provider: "claude", webGrounded: true, notes: "", values: [{ criterion: "windSpeedMph", value: 140, sourceUrl: "https://v.example.gov" }],
  }));
  assert.equal(verified.saved, false);
  assert.equal(ownRow("City of Verifiedport")!.profile.designCriteria.windSpeedMph, undefined, "a verified row was filled");
});

await check("the job type is registered: a queued lookup runs keyless through the stub and stores nothing", async () => {
  CP.setDesignResearchEnqueuerForTests(null);
  db.run("UPDATE job_queue SET status = 'done' WHERE status IN ('pending','running')");
  enqueueJob(db, "design_criteria_research", { state: "OR", ahj: "City of Lookupton", profileKey: ownRow("City of Lookupton")!.key }, { priority: 3 });
  assert.equal(await processNextJob(db), true);
  const job = db.get<{ status: string; result: string }>("SELECT status, result FROM job_queue WHERE job_type = 'design_criteria_research' ORDER BY created_at DESC LIMIT 1")!;
  assert.equal(job.status, "done", job.result);
  assert.match(job.result, /stub/);
  assert.doesNotMatch(job.result, /handled externally/);
});

console.log(failures === 0 ? "\njurisdictionCriteriaLearning: all checks passed" : `\njurisdictionCriteriaLearning: ${failures} FAILED`);
try { db.close(); } catch { /* ignore */ }
process.exit(failures === 0 ? 0 : 1);
