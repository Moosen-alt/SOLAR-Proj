// ONE-CLICK CONFIRM — a person vouches for a researched fee (operator 2026-09-27: "there is no
// place to verify them").
//
// What this pins, on the REAL schedule module and the REAL route:
//   1. A Coos-shaped split fee (city structural + county electrical reached through the city's
//      "the county collects it" pointer) is `confirmable` while seeded; its card names the three
//      items a Confirm would verify; Confirm records EXACTLY those — (city row, "Solar PV
//      installation permit", $200), (county row, "5.01 KVA to 15 KVA", $160), (the pointer, hop to
//      the county) — under the confirming person, and flips NO fee_schedules row (fees-close2,
//      rule 3: "verified" is a person vouching for exactly what they saw). The line then reads
//      verified, names the person, and is no longer confirmable; another job in the SAME bracket
//      reads verified; a 4 kW job priced off the county's "5 KVA or less" $135 — never on the card
//      — stays seeded and confirmable (skeptic V1).
//   2. Only a named person confirms: "", "dashboard", "system", "human" are refused (400) and
//      write nothing. Only a researched published-schedule amount is confirmable: an estimate,
//      an actual and an already-verified line are refused (409).
//   3. Afterwards automation cannot move it: a research pass over a row carrying a person's record
//      is refused (refusedVerified) and the row is byte-identical, the record unchanged. A row a
//      person verified WHOLE by the script door still reads verified on every bracket (3d).
//   4. THE ROUTE: POST /api/projects/:id/fee-sheet/confirm on a real server with sign-in ON takes
//      WHO from the session — a body-supplied name is ignored — returns 401 signed out, and 404
//      for a project that does not exist (never 403).
//   5. WHO VERIFIED IS THE CONFIRMING ORG'S FACT (skeptic MF3): the org is recorded with the
//      verification; another org's card and its persisted submission_payments.fee_basis say
//      "human-verified" + the date and never the name; another org's confirm outcome never names
//      the first org's person; a two-org total and a no-org (script) row name nobody.
//   6. CONFIRM VOUCHES FOR THE AMOUNT THE PERSON SAW (skeptic MF2): the line carries the rows
//      behind its amount with their versions (confirmRows); $360 seen and $440 standing -> 409
//      "the fee changed since you looked", nothing verified; the same amount on a row re-saved
//      since (an unseen bracket moved) -> 409; the same amount and rows but another bracket than
//      the card said -> 409 (6h); saying nothing about what was seen -> 400; what was seen still
//      standing -> exactly those items recorded (control), and the row's other bracket stays
//      seeded (6i). The route: 4f (409) and 4g (400).
// Kill: feeConfirm writes "human" instead of the person -> 1c and 4b FAIL.
// Kill (fees-close2, bracket grain): findFeeVerification matches any bracket record on the row
// (label and amount ignored — the old row grain) -> 1e, 1f FAIL and 5e's setup throws 409 (the
// unseen bracket reads "already verified"). Kill: saveFeeSchedule's refusal ignores a row's
// bracket records -> 3a, 3b FAIL (measured: 2 failures).
// Kill (MF2): skip the seen-vs-standing comparison in confirmPublishedFee -> 6c, 6d, 6e FAIL.
// Kill (MF3): verifierNameFor returns the name without the org comparison -> 5b, 5c, 5f, 5g FAIL
// (measured: 4 failures).
import "./_isolate";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { REPO } from "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-confirm-"));
const dbPath = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.CODE_RESEARCH = "off";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const R = await import("../src/repository");
const F = await import("../src/feeSchedules");
const { buildProjectFeeSheet, recordActualPermitFee, feeLineConfirmable } = await import("../src/submissionFees");
const { confirmPublishedFee, feeConfirmSeenFrom, isConfirmingPerson } = await import("../src/feeConfirm");
type Finding = import("../src/feeSchedules").FeeScheduleFinding;
const db = await openDatabase();

const finding = (over: Partial<Finding>): Finding => ({
  found: true, reason: "", basis: "flat", brackets: [], notes: "", paymentMethod: "portal",
  sourceUrl: "https://example.gov/fees.pdf", sourceQuote: "A sentence a person could go back and read.", sourceKind: "official", ...over,
});
const COUNTY_PDF = "https://co.coos.example/community_development_fees.pdf";
const seedSplit = (city: string, county: string): void => {
  const countyKey = F.feeScheduleProfileKey({ state: "OR", ahj: county }, "permit");
  F.saveFeeSchedule(db, { state: "OR", ahj: city, track: "permit", discipline: "structural" }, finding({
    brackets: [{ feeUsd: 200, label: "Solar PV installation permit" }], sourceUrl: "https://city.example/fees.pdf", sourceQuote: "Solar PV installation permit | $200.00",
  }));
  F.saveFeeSchedule(db, { state: "OR", ahj: county, track: "permit", discipline: "electrical" }, finding({
    basis: "system_kw",
    brackets: [{ maxKw: 5, feeUsd: 135, label: "5 KVA or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "5.01 KVA to 15 KVA" }],
    sourceUrl: COUNTY_PDF, sourceQuote: "5.01 KVA to 15 KVA | $160.00",
  }));
  F.saveFeeSchedule(db, { state: "OR", ahj: city, track: "permit", discipline: "electrical" }, finding({
    basis: "other", brackets: [], collectedByProfileKey: countyKey, sourceUrl: "https://city.example/fees.pdf",
    sourceQuote: "A separate electrical permit is required through the county.",
  }));
};
const mk = (ahj: string, acKw = "7.68") => R.createProject(db, {
  owner: "Synthetic Owner", state: "OR", dcKw: "8.36", acKw, street: "1 Test Way", city: "Testbay", zip: "97420", ahj, utility: "Test Power",
} as never).project;
const rows = (ahj: string) => db.query<Record<string, unknown>>("SELECT id, discipline, confidence, verified_by, verified_at, brackets_json, source_quote, collected_by_profile_key FROM fee_schedules WHERE ahj = ? ORDER BY discipline", [ahj]);
/** THE BRACKET-GRAIN RECORD (section 7): what a person verified — (row, bracket label, amount) as
 *  shown on their card, or (pointer row, the authority it hops to). Never the whole row. */
type Verif = { ahj: string; discipline: string; kind: string; bracket_label: string; fee_cents: number; collected_by_profile_key: string; verified_by: string; verified_org_id: string; verified_at: string };
const verifs = (...ahjs: string[]): Verif[] => db.query<Verif>(
  `SELECT s.ahj, s.discipline, v.kind, v.bracket_label, v.fee_cents, v.collected_by_profile_key, v.verified_by, v.verified_org_id, v.verified_at
     FROM fee_bracket_verifications v JOIN fee_schedules s ON s.id = v.schedule_id
    WHERE s.ahj IN (${ahjs.map(() => "?").join(",")}) ORDER BY s.ahj, s.discipline, v.bracket_label`, ahjs);
const wholeRowVerified = (...ahjs: string[]) => ahjs.flatMap((a) => rows(a)).filter((r) => r.confidence === "verified" || String(r.verified_at) !== "");
const permitLine = (projectId: string) => buildProjectFeeSheet(db, R.getProjectDetail(db, projectId).project).lines.find((l) => l.track === "permit")!;
/** What the person SAW on the card — the amount and the rows behind it (section 6). */
const seenOf = (line: { feeUsd: number | null; confirmRows?: Array<{ id: string; updatedAt: string }> }) => ({ feeUsd: line.feeUsd as number, scheduleRows: line.confirmRows ?? [] });

// ── 1. CONFIRM A SPLIT FEE ─────────────────────────────────────────────────────────────────
seedSplit("City of Confirmbay", "Confirm County");
const ann = mk("City of Confirmbay");
const before = permitLine(ann.id);
check("1a. the researched split fee is seeded, from the schedule, $360, and confirmable",
  before.source === "published_schedule" && before.confidence === "seeded" && before.feeUsd === 360 && before.confirmable === true,
  JSON.stringify({ s: before.source, c: before.confidence, f: before.feeUsd, k: before.confirmable }));

// 2 (first half): the refusals write nothing.
for (const who of ["", "  ", "dashboard", "System", "human", "operator"]) {
  let status = 0;
  try { confirmPublishedFee(db, ann, "permit", who, DEFAULT_ORG_ID, seenOf(before)); } catch (err) { status = (err as { status?: number }).status ?? -1; }
  check(`2a. "${who}" is not a person — refused 400`, status === 400, String(status));
}
check("2b. …and nothing was verified by a refused confirm",
  [...rows("City of Confirmbay"), ...rows("Confirm County")].every((r) => r.confidence === "seeded") && verifs("City of Confirmbay", "Confirm County").length === 0);

check("1a'. the card names exactly what a Confirm would verify: each line's authority, bracket and amount, and the pointer's hop",
  JSON.stringify(before.confirmRows.map((r) => [r.kind, r.authority, r.bracketLabel, r.feeUsd]).sort()) === JSON.stringify([
    ["bracket", "City of Confirmbay", "Solar PV installation permit", 200],
    ["bracket", "Confirm County", "5.01 KVA to 15 KVA", 160],
    ["delegation", "City of Confirmbay", "", null],
  ].sort()) && before.confirmRows.find((r) => r.kind === "delegation")?.collectedByAuthority === "Confirm County",
  JSON.stringify(before.confirmRows));
const outcome = confirmPublishedFee(db, ann, "permit", "Jane Operator", DEFAULT_ORG_ID, seenOf(before));
const recorded = verifs("City of Confirmbay", "Confirm County");
check("1b. Confirm recorded EXACTLY what the card showed — city 'Solar PV installation permit' $200, the city's pointer to the county, the county's '5.01 KVA to 15 KVA' $160 — and flipped no row",
  outcome.verified.length === 3
    && JSON.stringify(recorded.map((v) => [v.ahj, v.kind, v.bracket_label, v.fee_cents])) === JSON.stringify([
      ["City of Confirmbay", "delegation", "", 0],
      ["City of Confirmbay", "bracket", "Solar PV installation permit", 20000],
      ["Confirm County", "bracket", "5.01 KVA to 15 KVA", 16000],
    ])
    && recorded.find((v) => v.kind === "delegation")?.collected_by_profile_key === F.feeScheduleProfileKey({ state: "OR", ahj: "Confirm County" }, "permit")
    && wholeRowVerified("City of Confirmbay", "Confirm County").length === 0,
  JSON.stringify({ outcome: outcome.verified, recorded, whole: wholeRowVerified("City of Confirmbay", "Confirm County").length }));
check("1c. each record names the confirming PERSON and when",
  recorded.every((v) => v.verified_by === "Jane Operator" && String(v.verified_at).length >= 10),
  JSON.stringify(recorded.map((v) => [v.verified_by, v.verified_at])));
const after = permitLine(ann.id);
check("1d. the line now reads verified, names the person, and is no longer confirmable",
  after.confidence === "verified" && after.verifiedBy === "Jane Operator" && after.confirmable === false && /human-verified by Jane Operator/.test(after.basis),
  JSON.stringify({ c: after.confidence, v: after.verifiedBy, k: after.confirmable, b: after.basis.slice(0, 160) }));
// THE OTHER BRACKET OF THE SAME ROW STAYS SEEDED (rule 3: a person vouches for exactly what they
// saw — skeptic V1). Jane looked at a 7.68 kW job: '5.01 KVA to 15 KVA' $160. A 4 kW job in the same
// city is priced off '5 KVA or less' $135, which was never on her screen.
const small = mk("City of Confirmbay", "4.0");
const smallLine = permitLine(small.id);
check("1e. MUST-EXCLUDE (V1): a 4 kW job's '5 KVA or less' $135 — the bracket nobody saw — stays seeded, names nobody, and is confirmable",
  smallLine.feeUsd === 335 && smallLine.confidence === "seeded" && smallLine.verifiedBy === "" && smallLine.confirmable === true
    && /not yet human-verified/.test(smallLine.basis) && !/\(human-verified|Jane/.test(smallLine.basis),
  JSON.stringify({ f: smallLine.feeUsd, c: smallLine.confidence, v: smallLine.verifiedBy, k: smallLine.confirmable, b: smallLine.basis.slice(0, 160) }));
check("1f. …and what it would confirm is that bracket, beside the two items Jane already vouched for",
  smallLine.confirmRows.some((r) => r.kind === "bracket" && r.authority === "Confirm County" && r.bracketLabel === "5 KVA or less" && r.feeUsd === 135),
  JSON.stringify(smallLine.confirmRows));
const sameBracket = permitLine(mk("City of Confirmbay", "12.0").id);
check("1g. MUST-PASS: another job in the SAME bracket Jane saw ('5.01 KVA to 15 KVA' $160, 12 kW) reads verified",
  sameBracket.feeUsd === 360 && sameBracket.confidence === "verified" && sameBracket.verifiedBy === "Jane Operator", JSON.stringify({ f: sameBracket.feeUsd, c: sameBracket.confidence }));

// 2 (second half): nothing-to-confirm refusals.
const refused409 = (fn: () => unknown): number => { try { fn(); return 200; } catch (err) { return (err as { status?: number }).status ?? -1; } };
check("2c. an already-verified line is refused 409", refused409(() => confirmPublishedFee(db, ann, "permit", "Jane Operator", DEFAULT_ORG_ID, seenOf(before))) === 409);
const trued = mk("City of Confirmbay");
recordActualPermitFee(db, trued, "permit", 412.5, "operator");
check("2d. an operator-entered actual has nothing on the schedule to confirm — 409", refused409(() => confirmPublishedFee(db, trued, "permit", "Jane Operator", DEFAULT_ORG_ID, seenOf(before))) === 409);
check("2e. …and its line is not confirmable", permitLine(trued.id).confirmable === false);
// The one predicate both doors ask (the sheet's control and confirmPublishedFee's refusal):
// only a seeded published-schedule amount. An estimate walked on a guessed valuation is not.
const grid: Array<[string, string, boolean]> = [
  ["published_schedule", "seeded", true], ["published_schedule", "estimated", false], ["published_schedule", "verified", false],
  ["actual", "actual", false], ["learned_history", "verified", false], ["valuation_estimate", "estimated", false], ["unknown", "unknown", false],
];
check("2f. feeLineConfirmable: only a seeded published-schedule amount",
  grid.every(([s, c, want]) => feeLineConfirmable(s as never, c as never) === want));

// ── 3. AUTOMATION CANNOT MOVE IT ───────────────────────────────────────────────────────────
const frozen = rows("Confirm County").find((r) => r.discipline === "electrical")!;
const research = F.saveFeeSchedule(db, { state: "OR", ahj: "Confirm County", track: "permit", discipline: "electrical" }, finding({
  basis: "system_kw", brackets: [{ maxKw: 5, feeUsd: 150, label: "5 KVA or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 190, label: "5.01 KVA to 15 KVA" }],
  sourceUrl: COUNTY_PDF, sourceQuote: "5.01 KVA to 15 KVA | $190.00",
}));
const thawed = rows("Confirm County").find((r) => r.discipline === "electrical")!;
check("3a. a later research pass over a row carrying a person-verified bracket is refused", research.refusedVerified === true && research.saved === false, research.reason);
check("3b. …the row's table and quote are byte-identical, and the person's record stands",
  thawed.brackets_json === frozen.brackets_json && thawed.source_quote === frozen.source_quote
    && verifs("Confirm County").length === 1 && verifs("Confirm County")[0].verified_by === "Jane Operator" && permitLine(ann.id).confidence === "verified");
// THE SCRIPT DOOR STILL VERIFIES A WHOLE ROW (markFeeScheduleVerified — a person who read the whole
// table), and every reader of verified_at keeps working: every bracket of that row reads verified.
F.saveFeeSchedule(db, { state: "OR", ahj: "Whole County", track: "permit" }, finding({
  basis: "system_kw", brackets: [{ maxKw: 5, feeUsd: 135, label: "Solar 5 KVA or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 160, label: "Solar 5.01 KVA to 15 KVA" }],
}));
F.markFeeScheduleVerified(db, F.feeScheduleProfileKey({ state: "OR", ahj: "Whole County" }, "permit"), "permit", "Script Person");
const wholeSmall = permitLine(mk("Whole County", "4.0").id);
const wholeBig = permitLine(mk("Whole County").id);
check("3d. a row verified WHOLE by the script door reads verified on every bracket (4 kW $135 and 7.68 kW $160), and records no bracket",
  wholeSmall.confidence === "verified" && wholeSmall.feeUsd === 135 && wholeBig.confidence === "verified" && wholeBig.feeUsd === 160 && verifs("Whole County").length === 0,
  JSON.stringify([wholeSmall.confidence, wholeSmall.feeUsd, wholeBig.confidence, wholeBig.feeUsd]));
check("3c. isConfirmingPerson: a name passes, placeholders do not",
  isConfirmingPerson("Jane Operator") && isConfirmingPerson("jo@solar.example") && !isConfirmingPerson("Admin") && !isConfirmingPerson("x"));

// ── 5. WHO VERIFIED IS THE CONFIRMING ORG'S FACT (skeptic MF3) ─────────────────────────────
// fee_schedules is shared ON PURPOSE: every tenant quoting Tenantbay gets the verified amount. A
// person's identity is not shared knowledge (rule 6): the verifier's NAME shows only on the
// confirming org's projects; every other org reads "human-verified" + the date, and nothing
// persisted into another org's rows carries the name. The audit row stays with the confirming
// org's own project.
const OTHER_ORG = "org-mf3-beta";
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES (?, ?, 'full', ?)", [OTHER_ORG, "Beta Solar", new Date().toISOString()]);
const mkIn = (ahj: string, orgId: string) => R.createProject(db, {
  owner: "Synthetic Owner", state: "OR", dcKw: "8.36", acKw: "7.68", street: "2 Test Way", city: "Testbay", zip: "97420", ahj, utility: "Test Power",
} as never, orgId).project;
const orgOf = (...ahjs: string[]) => verifs(...ahjs).map((r) => r.verified_org_id);
{
  seedSplit("City of Tenantbay", "Tenant County");
  const mine = mkIn("City of Tenantbay", DEFAULT_ORG_ID);
  confirmPublishedFee(db, mine, "permit", "Jane Operator", DEFAULT_ORG_ID, seenOf(permitLine(mine.id)));
  check("5a. the confirming org is recorded with the verification, on every item it verified",
    orgOf("City of Tenantbay", "Tenant County").length === 3 && orgOf("City of Tenantbay", "Tenant County").every((o) => o === DEFAULT_ORG_ID), JSON.stringify(orgOf("City of Tenantbay", "Tenant County")));
  const theirs = mkIn("City of Tenantbay", OTHER_ORG);
  const theirLine = permitLine(theirs.id);
  check("5b. MUST-EXCLUDE: another org's card reads verified, 'human-verified' + the date, and never the name",
    theirLine.confidence === "verified" && theirLine.verifiedBy === "" && /human-verified on \d{4}-\d{2}-\d{2}/.test(theirLine.basis) && !/Jane/.test(JSON.stringify(theirLine)),
    JSON.stringify({ c: theirLine.confidence, v: theirLine.verifiedBy, b: theirLine.basis.slice(0, 200) }));
  const theirStored = String(db.get<{ fee_basis: string }>("SELECT fee_basis FROM submission_payments WHERE project_id = ? AND track = 'permit'", [theirs.id])?.fee_basis ?? "");
  check("5c. MUST-EXCLUDE: …and the other org's persisted quote row (submission_payments.fee_basis) carries no name",
    /human-verified/.test(theirStored) && !/Jane/.test(theirStored), theirStored.slice(0, 200));
  const mineLine = permitLine(mine.id);
  check("5d. MUST-PASS: the confirming org's own card still names the person, and the date",
    mineLine.verifiedBy === "Jane Operator" && /human-verified by Jane Operator on \d{4}-\d{2}-\d{2}/.test(mineLine.basis), mineLine.basis.slice(0, 200));

  // A second org confirms a total part of which the first org already verified: its outcome
  // (the response, and its own audit trail) names nobody from the first org, and a total vouched
  // for by two orgs' people names nobody on either card. The first org's person looked at a 4 kW
  // job (city $200, the pointer, the county's '5 KVA or less' $135); the second org's 7.68 kW job
  // shares the city bracket and the pointer, and its county bracket ('5.01 KVA to 15 KVA') is new.
  seedSplit("City of Mixbay", "Mix County");
  const mixMine = mkIn("City of Mixbay", DEFAULT_ORG_ID);
  const mixSmall = R.createProject(db, { owner: "Synthetic Owner", state: "OR", dcKw: "4.4", acKw: "4.0", street: "3 Test Way", city: "Testbay", zip: "97420", ahj: "City of Mixbay", utility: "Test Power" } as never, DEFAULT_ORG_ID).project;
  confirmPublishedFee(db, mixSmall, "permit", "Jane Operator", DEFAULT_ORG_ID, seenOf(permitLine(mixSmall.id)));
  const mixTheirs = mkIn("City of Mixbay", OTHER_ORG);
  const mixOutcome = confirmPublishedFee(db, mixTheirs, "permit", "Bob Beta", OTHER_ORG, seenOf(permitLine(mixTheirs.id)));
  check("5e. MUST-EXCLUDE: another org's confirm outcome does not name the first org's verifier",
    mixOutcome.verified.length === 1 && mixOutcome.alreadyVerified.length === 2 && mixOutcome.alreadyVerified.every((a) => a.verifiedBy === "") && !/Jane/.test(JSON.stringify(mixOutcome)),
    JSON.stringify(mixOutcome));
  const mixA = permitLine(mixMine.id);
  const mixB = permitLine(mixTheirs.id);
  check("5f. a total vouched for by two orgs' people is verified and names nobody on either org's card",
    mixA.confidence === "verified" && mixB.confidence === "verified" && mixA.verifiedBy === "" && mixB.verifiedBy === "" && !/Jane|Bob/.test(mixA.basis + mixB.basis),
    JSON.stringify([mixA.verifiedBy, mixB.verifiedBy, mixA.basis.slice(0, 120)]));

  // The script door (markFeeScheduleVerified) records no org — so it names nobody (fail closed).
  F.saveFeeSchedule(db, { state: "OR", ahj: "City of Legacybay", track: "permit" }, finding({ brackets: [{ feeUsd: 120, label: "Solar PV installation permit" }] }));
  F.markFeeScheduleVerified(db, F.feeScheduleProfileKey({ state: "OR", ahj: "City of Legacybay" }, "permit"), "permit", "Legacy Person");
  const legacy = permitLine(mkIn("City of Legacybay", DEFAULT_ORG_ID).id);
  check("5g. a row verified with no org on record is 'human-verified' and names nobody (fail closed)",
    legacy.confidence === "verified" && legacy.verifiedBy === "" && !/Legacy Person/.test(legacy.basis) && /human-verified/.test(legacy.basis), legacy.basis.slice(0, 160));
}

// ── 6. CONFIRM VOUCHES FOR THE AMOUNT THE PERSON SAW (skeptic MF2) ─────────────────────────
// Confirm used to re-resolve the quote at click time and verify whatever rows stood behind it
// THEN: the person looked at $360, background research re-saved the county row, and the click
// wrote "verified by Jane" onto $440 — an amount she never saw. The sheet line now carries the
// rows behind its amount WITH their versions (confirmRows); the click sends the amount and rows it
// displayed; the server verifies only if the quote standing now is that amount on those row
// versions, else 409 "the fee changed since you looked — reload and confirm again".
const statusOf = (fn: () => unknown): { status: number; message: string } => {
  try { fn(); return { status: 200, message: "" }; } catch (err) { return { status: (err as { status?: number }).status ?? -1, message: (err as Error).message }; }
};
const tick = () => new Promise((r) => setTimeout(r, 5));
{
  seedSplit("City of Toctou", "Toctou County");
  const p = mk("City of Toctou");
  const seen = permitLine(p.id);
  check("6a. a confirmable line carries the rows behind its amount, with their versions (city structural, the pointer, the county electrical)",
    seen.feeUsd === 360 && Array.isArray(seen.confirmRows) && seen.confirmRows.length === 3 && seen.confirmRows.every((r) => r.id && r.updatedAt),
    JSON.stringify(seen.confirmRows));
  const silent = statusOf(() => confirmPublishedFee(db, p, "permit", "Jane Operator", DEFAULT_ORG_ID, undefined as never));
  check("6b. a confirmation that does not say what was seen is refused (400) and writes nothing",
    silent.status === 400 && [...rows("City of Toctou"), ...rows("Toctou County")].every((r) => r.confidence === "seeded") && verifs("City of Toctou", "Toctou County").length === 0, JSON.stringify(silent));

  // Background research re-saves the county row with new amounts before the click lands.
  await tick();
  F.saveFeeSchedule(db, { state: "OR", ahj: "Toctou County", track: "permit", discipline: "electrical" }, finding({
    basis: "system_kw", brackets: [{ maxKw: 5, feeUsd: 150, label: "5 KVA or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 240, label: "5.01 KVA to 15 KVA" }],
    sourceUrl: COUNTY_PDF, sourceQuote: "5.01 KVA to 15 KVA | $240.00",
  }));
  const raced = statusOf(() => confirmPublishedFee(db, p, "permit", "Jane Operator", DEFAULT_ORG_ID, seenOf(seen)));
  check("6c. MUST-EXCLUDE: $360 seen, $440 standing now -> 409 'the fee changed since you looked'",
    raced.status === 409 && /changed since you looked/i.test(raced.message), JSON.stringify(raced));
  check("6d. …and nothing was verified — no person's name on an amount they never saw",
    [...rows("City of Toctou"), ...rows("Toctou County")].every((r) => r.confidence === "seeded" && r.verified_by === "") && verifs("City of Toctou", "Toctou County").length === 0);

  // Same displayed amount, but a row re-saved since the person looked (an UNSEEN bracket moved):
  // the rows' versions differ, so the person has not seen what they would be vouching for.
  const seen440 = permitLine(p.id);
  await tick();
  F.saveFeeSchedule(db, { state: "OR", ahj: "Toctou County", track: "permit", discipline: "electrical" }, finding({
    basis: "system_kw", brackets: [{ maxKw: 5, feeUsd: 170, label: "5 KVA or less" }, { minKw: 5.01, maxKw: 15, feeUsd: 240, label: "5.01 KVA to 15 KVA" }],
    sourceUrl: COUNTY_PDF, sourceQuote: "5.01 KVA to 15 KVA | $240.00",
  }));
  const unseen = statusOf(() => confirmPublishedFee(db, p, "permit", "Jane Operator", DEFAULT_ORG_ID, seenOf(seen440)));
  check("6e. MUST-EXCLUDE: the same $440 but a row re-saved since the person looked (an unseen bracket moved) -> 409",
    seen440.feeUsd === 440 && unseen.status === 409 && [...rows("Toctou County")].every((r) => r.confidence === "seeded") && verifs("Toctou County").length === 0, JSON.stringify({ f: seen440.feeUsd, unseen }));

  // THE BRACKET IS PART OF WHAT WAS SEEN: the same amount and row versions, but the card said
  // another bracket (a doctored body, or a bracket that moved while the rows did not) -> 409.
  const fresh = permitLine(p.id);
  const forged = { feeUsd: fresh.feeUsd as number, scheduleRows: fresh.confirmRows.map((r) => (r.kind === "bracket" && r.authority === "Toctou County" ? { ...r, bracketLabel: "5 KVA or less" } : r)) };
  const wrongBracket = statusOf(() => confirmPublishedFee(db, p, "permit", "Jane Operator", DEFAULT_ORG_ID, forged));
  check("6h. MUST-EXCLUDE: right amount and row versions, but not the bracket standing -> 409, nothing verified",
    wrongBracket.status === 409 && verifs("City of Toctou", "Toctou County").length === 0, JSON.stringify(wrongBracket));

  // CONTROL: the person reloads, sees what stands, confirms — verified.
  const ok = confirmPublishedFee(db, p, "permit", "Jane Operator", DEFAULT_ORG_ID, seenOf(fresh));
  check("6f. MUST-PASS: the amount and row versions the person saw are the ones standing -> the three items they saw are recorded",
    ok.verified.length === 3 && verifs("City of Toctou", "Toctou County").length === 3 && verifs("City of Toctou", "Toctou County").every((v) => v.verified_by === "Jane Operator")
      && verifs("Toctou County")[0].bracket_label === "5.01 KVA to 15 KVA" && verifs("Toctou County")[0].fee_cents === 24000
      && permitLine(p.id).feeUsd === 440 && permitLine(p.id).confidence === "verified",
    JSON.stringify(ok.verified));
  check("6g. a line that is not confirmable carries no rows to confirm", permitLine(p.id).confirmRows.length === 0);
  const toctouSmall = permitLine(mk("City of Toctou", "4.0").id);
  check("6i. MUST-EXCLUDE: the county's '5 KVA or less' $170 — on the same row, never on the card — stays seeded",
    toctouSmall.feeUsd === 370 && toctouSmall.confidence === "seeded" && toctouSmall.confirmable === true, JSON.stringify({ f: toctouSmall.feeUsd, c: toctouSmall.confidence }));
  const whitelisted = feeConfirmSeenFrom({ feeUsd: "440", scheduleRows: fresh.confirmRows.map((r) => ({ ...r, extra: "x" })) });
  check("6j. the body whitelist keeps each item's kind, bracket and amount (what the comparison reads), and drops the rest",
    !!whitelisted && whitelisted.scheduleRows.length === fresh.confirmRows.length
      && whitelisted.scheduleRows.every((r, i) => r.kind === fresh.confirmRows[i].kind && r.bracketLabel === fresh.confirmRows[i].bracketLabel && r.feeUsd === fresh.confirmRows[i].feeUsd && !("extra" in r)),
    JSON.stringify(whitelisted));
}

// ── 4. THE ROUTE, sign-in ON ───────────────────────────────────────────────────────────────
seedSplit("City of Routebay", "Route County");
const routed = mk("City of Routebay");
db.close();

const PORT = 5160 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: dbPath, BACKUP_DIR: path.join(tmpDir, "backups"), AUTOPILOT_AUTO_START: "0", PORT: String(PORT),
  SEED_TEST_INSTALLER: "false", MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "true", ADMIN_EMAIL: "admin@fee.test", ADMIN_PASSWORD: "fee-test-password-1", NO_PROXY: "*", no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
/** Anything verified behind the Routebay fee: a person's bracket-grain record, or a whole row. */
const ROUTE_VERIFIED_SQL = `SELECT 1 FROM fee_bracket_verifications v JOIN fee_schedules s ON s.id = v.schedule_id WHERE s.ahj IN ('City of Routebay','Route County')
  UNION ALL SELECT 1 FROM fee_schedules WHERE ahj IN ('City of Routebay','Route County') AND (confidence = 'verified' OR verified_at <> '')`;
const read = (sql: string, args: unknown[] = []): Array<Record<string, unknown>> => {
  const h = new Database(dbPath, { readonly: true });
  try { return h.prepare(sql).all(...args) as Array<Record<string, unknown>>; } finally { h.close(); }
};
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const post = (projectId: string, body: unknown, cookie = "") => fetch(`${BASE}/api/projects/${projectId}/fee-sheet/confirm`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  const anon = await post(routed.id, { track: "permit", confirmedBy: "Mallory Forger" });
  check("4a. signed out: 401, and nothing verified", anon.status === 401 && read(ROUTE_VERIFIED_SQL).length === 0, String(anon.status));
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@fee.test", password: "fee-test-password-1" }) });
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  // What the person SEES first: the sheet, its amount and the rows behind it (MF2).
  const sheetRes = await fetch(`${BASE}/api/projects/${routed.id}/fee-sheet`, { headers: { cookie } });
  const shown = ((await sheetRes.json()) as { feeSheet: { lines: Array<{ track: string; feeUsd: number; confirmRows: Array<{ id: string; updatedAt: string }> }> } }).feeSheet.lines.find((l) => l.track === "permit")!;
  const stale = await post(routed.id, { track: "permit", feeUsd: shown.feeUsd + 80, scheduleRows: shown.confirmRows }, cookie);
  const staleBody = await stale.json().catch(() => ({})) as { error?: string };
  check("4f. MUST-EXCLUDE (MF2, the route): an amount other than the one standing -> 409 'changed since you looked', nothing verified",
    stale.status === 409 && /changed since you looked/i.test(String(staleBody.error)) && read(ROUTE_VERIFIED_SQL).length === 0,
    `${stale.status} ${JSON.stringify(staleBody).slice(0, 160)}`);
  const blind = await post(routed.id, { track: "permit" }, cookie);
  check("4g. a confirm that does not say what was seen -> 400, nothing verified",
    blind.status === 400 && read(ROUTE_VERIFIED_SQL).length === 0, String(blind.status));
  const res = await post(routed.id, { track: "permit", confirmedBy: "Mallory Forger", feeUsd: shown.feeUsd, scheduleRows: shown.confirmRows }, cookie);
  const body = await res.json().catch(() => ({})) as { outcome?: { confirmedBy?: string }; feeSheet?: { lines?: Array<{ track: string; confidence: string; verifiedBy: string }> } };
  const who = read("SELECT DISTINCT v.verified_by FROM fee_bracket_verifications v JOIN fee_schedules s ON s.id = v.schedule_id WHERE s.ahj IN ('City of Routebay','Route County')").map((r) => r.verified_by);
  check("4b. signed in: WHO is the session's person, never the body's name",
    res.status === 200 && who.length === 1 && who[0] === "admin@fee.test" && body.outcome?.confirmedBy === "admin@fee.test",
    `${res.status} ${JSON.stringify(who)} ${JSON.stringify(body).slice(0, 200)}`);
  check("4c. the response carries the refreshed sheet: the permit line is verified by that person",
    body.feeSheet?.lines?.find((l) => l.track === "permit")?.confidence === "verified" && body.feeSheet?.lines?.find((l) => l.track === "permit")?.verifiedBy === "admin@fee.test");
  const audit = read("SELECT actor_name, action FROM audit_logs WHERE project_id = ? AND action = 'fee.schedule_confirmed'", [routed.id]);
  check("4d. the confirmation is in the audit trail under the person", audit.length === 1, JSON.stringify(audit));
  const missing = await post("no-such-project", { track: "permit" }, cookie);
  check("4e. a project that does not exist is 404, never 403", missing.status === 404, String(missing.status));
} finally {
  server.kill("SIGTERM");
}

await new Promise((r) => setTimeout(r, 500));
try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Windows may hold the killed server's handle a moment longer; the OS temp dir is reaped */ }
if (failures) { console.error(`\nfeeConfirm: ${failures} failure(s)`); process.exit(1); }
console.log("\nfeeConfirm: all checks passed");
process.exit(0);
