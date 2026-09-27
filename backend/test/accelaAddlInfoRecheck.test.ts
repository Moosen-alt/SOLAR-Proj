// "ADDL INFO NEEDED" IS A CORRECTION, AND A RE-CHECK OF A STALE READING WRITES A NEW ONE.
//
// Live, 2026-09-23. Coos Bay's building reviewer marked 187-26-000309-STR "In Review/Addl Info
// Needed" and asked for a 36 psf snow load, 2' o.c. attachments and UL listings. Two defects kept
// that off the operator's screen:
//
//   1. The classifier read the stated status "In Review/Addl Info Needed" as waiting / "In review"
//      at 0.72 — waitingPattern's "in review" matched and nothing knew Accela's abbreviation. The
//      reviewer's comment itself is in the AJAX-loaded Processing Status panel a plain fetch never
//      sees, so the status is the ONLY signal there is.
//   2. The operator pressed Re-check three times. Each check landed on the same pair the target
//      already cached (waiting / In review), shouldRecordStatusCheck called it "no change", and no
//      row was written — so the newest stored row stayed the 9/14 reading that today's rules call
//      "Action needed before review", and the dashboard kept offering a Re-check that did nothing.
//
// Driven through recordPermitStatusCheck (the production write) and staleStatusClassifications
// (what the dashboard's stale panel reads). The stale row is inserted directly because it stands
// for a row OLDER RULES wrote — today's code cannot produce one.
//   npx tsx backend/test/accelaAddlInfoRecheck.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "accela-addl-info-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { classifyPermitStatusText, staleStatusClassifications } = await import("../src/permitMonitor");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const page = (status: string): string =>
  `Record 187-26-000999-STR: Residential Structural Record Status: ${status} Expiration Date: 03/16/2027 `
  + "Record Info/Schedule Inspections Payments Conditions Processing Status Loading... Loading...";

// ---------------------------------------------------------------------------------------------
// 1. THE CLASSIFIER — must pass AND must exclude (a widened pattern fails both ways).
// ---------------------------------------------------------------------------------------------
await check("MUST PASS: Accela's 'Addl Info Needed' is a correction request, with or without 'In Review/'", () => {
  for (const s of ["In Review/Addl Info Needed", "Addl Info Needed", "Add'l Info Needed", "Additional Info Requested", "Info Requested"]) {
    const c = classifyPermitStatusText(page(s), "permit");
    assert.equal(c.outcome, "correction_flagged", `"${s}" -> ${c.outcome} / ${c.statusLabel}`);
  }
});

await check("MUST PASS: a bare stated 'Issued' / 'Finaled' is an issued permit", () => {
  for (const s of ["Issued", "Finaled"]) {
    const c = classifyPermitStatusText(page(s), "permit");
    assert.equal(c.outcome, "issued", `"${s}" -> ${c.outcome} / ${c.statusLabel}`);
  }
});

await check("MUST EXCLUDE: neighbouring Accela statuses keep their verdicts", () => {
  const expected: Array<[string, string, string]> = [
    ["Intake Requirements Needed", "needs_human_review", "Action needed before review"],
    ["In Review", "waiting", "In review"],
    ["Awaiting Review", "waiting", "In review"],
    ["Ready for Plan Review", "waiting", "In review"],
    ["App Submitted", "waiting", "In review"],
    ["Ready to Issue", "ready_for_issue", "Ready for issue"],
    ["Permit Issued", "issued", "Permit issued"],
    // Its own label since 2026-09-26 (operator: "with-conditions gets its own label, for both").
    ["Approved with Conditions", "reviewed_by_ahj", "Approved with conditions"],
    ["Approved", "reviewed_by_ahj", "Reviewed by AHJ"],
  ];
  for (const [s, outcome, label] of expected) {
    const c = classifyPermitStatusText(page(s), "permit");
    assert.deepEqual([c.outcome, c.statusLabel], [outcome, label], `"${s}"`);
  }
});

await check("MUST EXCLUDE: 'issued' / 'final' in page prose is not this record's status", () => {
  const prose = classifyPermitStatusText("Permits issued by the city expire after 180 days. Final fees are listed on the fee schedule.", "permit");
  assert.notEqual(prose.outcome, "issued", `prose -> ${prose.outcome}`);
});

// ---------------------------------------------------------------------------------------------
// 2. RE-CHECK OF A STALE READING — through the production write.
// ---------------------------------------------------------------------------------------------
const mkProject = (name: string): string => R.createProject(db, {
  owner: name, state: "OR", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
  street: "1 Test Way", city: "Coos Bay", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
} as never).project.id;

const mkTarget = (pid: string): string => {
  const detail = R.createPermitCheckTarget(db, pid, {
    jurisdiction: "City of Coos Bay", portalName: "Oregon ePermitting (Accela)",
    portalUrl: "https://aca-oregon.accela.com/oregon/Cap/CapDetail.aspx",
    applicationNumber: "187-26-000999-STR", permitType: "building", targetType: "permit",
  } as never);
  return String((detail as never as { permitCheckTargets: Array<{ id: string }> }).permitCheckTargets[0].id);
};

// A row OLDER RULES wrote: the 9/14 text, stored as waiting / In review, and the target's cached
// pair mirroring it — exactly what 1fb3dc39 carried.
const seedStaleRow = (pid: string, targetId: string): void => {
  const ts = "2026-09-15T02:12:04.964Z";
  db.run(
    `INSERT INTO permit_status_checks (id, project_id, target_id, source, raw_status_text, status_label, outcome, confidence,
       correction_id, reviewed_by_ahj, ready_for_issue, issue_fee_due, application_number, permit_number, message, created_at)
     VALUES (?, ?, ?, 'public_url', ?, 'In review', 'waiting', 0.72, NULL, 0, 0, 0, '187-26-000999-STR', '', 'old rules', ?)`,
    [`stale-${targetId}`, pid, targetId, page("Intake Requirements Needed"), ts],
  );
  db.run("UPDATE permit_check_targets SET latest_outcome = 'waiting', latest_status_label = 'In review', last_checked_at = ? WHERE id = ?", [ts, targetId]);
};

const rowsFor = (targetId: string): number =>
  Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_status_checks WHERE target_id = ?", [targetId])?.n ?? 0);

await check("THE LIVE CASE: a re-check landing on the stale row's own pair still writes a new reading", async () => {
  const pid = mkProject("Stale Recheck Owner");
  const tid = mkTarget(pid);
  seedStaleRow(pid, tid);
  assert.equal(staleStatusClassifications(db, [pid]).length, 1, "precondition: the seeded row reads as stale");
  // Today's page, which today's rules call waiting / In review — the SAME pair the target caches.
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review") });
  assert.equal(rowsFor(tid), 2, "the re-check wrote nothing — the stale 9/14 reading is still what every page publishes");
  assert.equal(staleStatusClassifications(db, [pid]).length, 0, "the stale panel still offers the same Re-check");
});

await check("CONTROL: a scheduled poll that saw no movement against a CURRENT reading still writes nothing", async () => {
  const pid = mkProject("Quiet Poll Owner");
  const tid = mkTarget(pid);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review") });
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review") });
  assert.equal(rowsFor(tid), 1, "an unchanged poll against a current reading laddered a second row");
});

await check("END TO END: the 9/23 page becomes a correction, and the stale panel clears", async () => {
  const pid = mkProject("Addl Info Owner");
  const tid = mkTarget(pid);
  seedStaleRow(pid, tid);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "public_url", rawStatusText: page("In Review/Addl Info Needed") });
  const newest = db.get<{ outcome: string; correction_id: string | null }>(
    "SELECT outcome, correction_id FROM permit_status_checks WHERE target_id = ? ORDER BY rowid DESC LIMIT 1", [tid]);
  assert.equal(newest?.outcome, "correction_flagged", `newest reading is ${newest?.outcome}`);
  assert.ok(newest?.correction_id, "no correction was opened for the reviewer's request");
  const corrections = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM corrections WHERE project_id = ?", [pid])?.n ?? 0);
  assert.equal(corrections, 1, `corrections=${corrections}`);
  assert.equal(staleStatusClassifications(db, [pid]).length, 0, "stale panel did not clear");
});

if (failures) { console.error(`\n${failures} Accela addl-info / re-check test(s) failed.`); process.exit(1); }
console.log("\nAll Accela addl-info / re-check tests passed.");
