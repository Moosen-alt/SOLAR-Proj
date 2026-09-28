// THE GATE POLICED ONE HALF OF A MUTUALLY EXCLUSIVE PAIR.
//
// A building-side solar permit goes down exactly one of two paths, and each path carries its
// OWN evidence that the path applies:
//
//     ENGINEERED (non-prescriptive) → PE stamp on the structural sheets + a sealed
//                                      engineering letter/calcs
//     PRESCRIPTIVE                  → the itemized prescriptive checklist (Oregon publishes
//                                      it statewide as BCD form 440-5952)
//
// Only the engineered half was ever demanded. resolveStampRequirement has blocked on a missing
// sealed letter for a long time; the prescriptive half existed as an ADVISORY sourced from one
// process-profile flag (`requiresSolarChecklist`) that most seeded AHJ rows leave false — City
// of Coos Bay's included. So a prescriptive filing went out with no checklist and nothing said
// a word, on any screen, at any stage.
//
// Two live Coos Bay structural records — 187-26-000309-STR (Ann Marineau) and 187-26-000305-STR
// (Christopher Ivy) — have sat at Accela "Record Status: Intake Requirements Needed" since
// Sep 3. The operator's own account of why: "Ann and Ivy both need corrections because of docs
// you missed to get them. Prescriptive checklist and didnt call out stamps that were needed."
//
// That is the same inverted gate formApplicationKind had (where "Non-Prescriptive" CONTAINS
// "prescriptive"), seen from the other side: a rule that exists to police a mutually exclusive
// pair, enforcing one member of it.
//
//   THE HEADLINE     — a PRESCRIPTIVE-path project missing the checklist is BLOCKING, by name,
//                      in documentInventory: the same list the staging gate refuses on.
//   AT QC            — and it is said on the day the plan set lands (runQcForProject), not at
//                      the portal three weeks later. WARNING, never fail: a QC failure is flow
//                      control and would stall every project the moment it parses.
//   NOT ON THE OTHER — an ENGINEERED project is never told to attach the prescriptive
//     PATH          checklist, in the required set or as a KB advisory. Filing it there is
//                      precisely the upload the AHJ forbids ("upload only the application that
//                      pertains — DO NOT upload both"), and its evidence is the sealed letter.
//   NO SIGNAL,       — an AHJ we hold no process knowledge for demands NO checklist. The
//     NO DEMAND        application-profile lookup always returns something (the Oregon generic
//                      fallback carries the checklist), so reading it standalone would invent a
//                      requirement for a jurisdiction nobody can name — as damaging as missing
//                      one. An UNCONFIRMED path stays advisory for the same reason.
//
// Every check runs the PRODUCTION functions — documentInventory, runQcForProject, and the
// exported stagingMissingDocuments filter prepareSubmission itself calls — never a restatement
// of the rule.
//
//   npx tsx backend/test/prescriptivePathDocs.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "presc-path-docs-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, stagingMissingDocuments } = await import("../src/repository");
const { runQcForProject } = await import("../src/qc");
const { documentInventory, applicationDocContext, requiredApplicationDocs } = await import("../src/requiredDocuments");
const { resolvePermitPath } = await import("../src/permitPath");
const { findAhjProcessProfile } = await import("../src/processProfiles");
const { findApplicationProfile } = await import("../src/applicationDocs");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const client = createClient(db, { companyName: "Prescriptive Path Solar", ccbLicenseNumber: "440595" });
let n = 0;
/** A real Coos Bay project. `permitPathOverride` is the operator's own dropdown choice — the
 *  strongest permit-path signal — so a fixture is never at the mercy of structural data it
 *  does not carry. Omit it to get a genuinely UNCONFIRMED path. */
const mk = (permitPathOverride?: string) => createProject(db, {
  clientId: client.id, owner: `Presc Owner ${++n}`, street: `${n} Checklist Way`, city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8.36", acKw: "7.68",
  ...(permitPathOverride ? { permitPathOverride } : {}),
}).project;

// A REAL FILE ON DISK: projectDocsByType requires fs.existsSync(stored_path), so a row that
// points at nothing is correctly not a document.
const attach = (pid: string, docType: string): void => {
  const file = path.join(tmpDir, `${pid}-${docType}.pdf`);
  // Distinct bytes per document: identical bytes under two doc types are one file attached once
  // (submissionDocuments.duplicateUploads).
  fs.writeFileSync(file, `%PDF-1.4 test fixture ${docType}`);
  db.run(
    `INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, source, uploaded_at)
     VALUES (?, ?, ?, ?, ?, 'upload', ?)`,
    [`${pid}-${docType}`, pid, docType, `${docType}.pdf`, file, new Date().toISOString()],
  );
};
const PLAN_SET_FAMILY = ["plan_set", "site_plan", "sld", "structural", "module_spec", "inverter_spec", "labels"];
/** Everything a Coos Bay filing needs EXCEPT the prescriptive checklist — i.e. exactly what the
 *  system used to call a complete prescriptive submittal. */
const papered = (pid: string): void => {
  for (const d of [...PLAN_SET_FAMILY, "building_application", "electrical_application"]) attach(pid, d);
};

const inv = (p: { id: string }) => documentInventory(db, p as never);
const docRules = (pid: string) => {
  runQcForProject(db, pid);
  return db.query<{ rule_id: string; qc_status: string; message: string; severity: string }>(
    "SELECT rule_id, qc_status, message, severity FROM qc_results WHERE project_id = ? AND rule_id LIKE 'docs.%'",
    [pid],
  );
};

// ---------------------------------------------------------------------------
// FIXTURE PREMISES — asserted, not assumed. Each one is a reason the bug existed; if a
// seeded row changes underneath them, every check below would silently test something else.
// ---------------------------------------------------------------------------
const prescriptive = mk("prescriptive");
const engineered = mk("engineered");

check("PREMISE: the fixtures really do resolve to the two mutually exclusive paths", () => {
  assert.equal(resolvePermitPath(prescriptive as never).path, "prescriptive");
  assert.equal(resolvePermitPath(engineered as never).path, "engineered");
});

check("PREMISE: Coos Bay's PROCESS profile flag is FALSE — which is why nothing ever asked", () => {
  // The old code read ONLY this flag. It is false here, so the checklist row was never even
  // emitted for the jurisdiction that bounced two permits for the missing checklist.
  const proc = findAhjProcessProfile(prescriptive as never);
  assert.ok(proc, "no process profile matched City of Coos Bay / OR");
  assert.equal(proc!.requiresSolarChecklist, false,
    "if this row ever goes true, this test stops covering the case that actually failed");
});

check("PREMISE: …while the APPLICATION profile carries the checklist, per Oregon's statewide rule", () => {
  // The signal that was there all along and nothing read. Not invented here: the profile field
  // is structured, per-AHJ, and set from Oregon's prescriptive-path rule (BCD 440-5952).
  assert.equal(findApplicationProfile(prescriptive as never).requiresPrescriptiveChecklist, true);
});

// ---------------------------------------------------------------------------
// THE HEADLINE
// ---------------------------------------------------------------------------
const missingChecklist = mk("prescriptive");
papered(missingChecklist.id);

check("THE HEADLINE: a PRESCRIPTIVE filing with no checklist is BLOCKED, and the row names it", () => {
  const blocked = inv(missingChecklist).missingBlocking;
  assert.ok(blocked.some((d) => d.docType === "solar_checklist"),
    `plan set, both applications, no prescriptive checklist — and the gate went green: ${JSON.stringify(blocked.map((d) => d.docType))}`);
  const row = blocked.find((d) => d.docType === "solar_checklist")!;
  assert.equal(row.blocking, true);
  assert.match(row.label, /checklist/i, "the operator has to be told WHICH document");
  assert.match(row.why, /Coos Bay/, "a requirement with no attributable source is not actionable");
  assert.match(row.why, /PRESCRIPTIVE/, "…and it must say which of the two paths put it there");
  assert.equal(row.lane, "permit");
  // The discipline vocabulary stagingMissingDocuments filters on — a building-side document.
  assert.equal(row.discipline, "structural");
});

check("AT QC, ON THE DAY THE PLAN SET LANDS — not at the portal three weeks later", () => {
  // With form downloads OFF nothing fetches the BCD 5952 at Stage, so the checklist is the
  // operator's to supply (with them on, Stage downloads it itself — gates-proper C1, next check).
  process.env.AHJ_FORM_DOWNLOADS = "off";
  let rules: ReturnType<typeof docRules>;
  try { rules = docRules(missingChecklist.id); } finally { delete process.env.AHJ_FORM_DOWNLOADS; }
  const row = rules.find((r) => r.rule_id === "docs.solar_checklist");
  assert.ok(row, `QC said nothing about the checklist: ${JSON.stringify(rules.map((r) => r.rule_id))}`);
  assert.equal(row!.qc_status, "warning",
    "documents must WARN at QC, never fail — a QC failure blocks staging and autopilot for every fresh parse");
  assert.equal(row!.severity, "error", "a blocking document is not the same as an advisory one");
  assert.match(row!.message, /checklist/i);
  assert.match(row!.message, /Coos Bay/);
  assert.equal(rules.filter((r) => r.qc_status === "fail").length, 0,
    `a document gap was turned into a QC failure: ${JSON.stringify(rules.filter((r) => r.qc_status === "fail").map((r) => r.message))}`);
});

check("…and a checklist Stage downloads itself (the BCD 5952) is SAID at QC, not dropped (gates-proper C1)", () => {
  const rules = docRules(missingChecklist.id);
  const row = rules.find((r) => r.rule_id === "docs.solar_checklist");
  assert.ok(row, `QC said nothing about the checklist: ${JSON.stringify(rules.map((r) => r.rule_id))}`);
  assert.match(row!.message, /Stage downloads and fills it/);
  assert.match(row!.message, /oregon\.gov\/bcd/);
  assert.equal(rules.filter((r) => r.qc_status === "fail").length, 0);
});

check("STAGING REFUSES ON IT — through the same exported filter prepareSubmission calls", () => {
  const kept = stagingMissingDocuments(inv(missingChecklist), "building" as never);
  assert.ok(kept.some((d) => d.docType === "solar_checklist"),
    `the building track would stage without the checklist: ${JSON.stringify(kept.map((d) => d.docType))}`);
  // …and it belongs to the BUILDING side only. The electrical permit is a separate filing and
  // must not be held up by the building-side path's evidence.
  const electrical = stagingMissingDocuments(inv(missingChecklist), "electrical" as never);
  assert.ok(!electrical.some((d) => d.docType === "solar_checklist"),
    "the electrical track was blocked by a building-side document");
});

const withChecklist = mk("prescriptive");
papered(withChecklist.id);
attach(withChecklist.id, "solar_checklist");

check("ATTACHING IT CLEARS IT — a gate that cannot be satisfied is not a gate", () => {
  const report = inv(withChecklist);
  assert.ok(!report.missingBlocking.some((d) => d.docType === "solar_checklist"),
    `an attached checklist did not satisfy the row: ${JSON.stringify(report.missingBlocking.map((d) => d.label))}`);
  const row = report.presence.find((d) => d.docType === "solar_checklist")!;
  assert.equal(row.present, true);
  assert.match(row.via, /attached file/, `presence should say where it came from: "${row.via}"`);
  assert.deepEqual(report.missingBlocking.map((d) => d.docType), [],
    `a genuinely complete prescriptive filing was blocked: ${JSON.stringify(report.missingBlocking.map((d) => `${d.label}: ${d.why}`))}`);
});

// ---------------------------------------------------------------------------
// THE OTHER HALF OF THE PAIR — the mirror-image mistake
// ---------------------------------------------------------------------------
const engineeredPapered = mk("engineered");
papered(engineeredPapered.id);

check("NOT ON THE ENGINEERED PATH: the prescriptive checklist is never demanded there, at all", () => {
  // Filing it on this path is the upload the AHJ explicitly forbids. Advisory is not good
  // enough: an advisory that tells you to attach the forbidden document is still wrong, and it
  // is what pushed these two records onto the wrong form in the first place.
  const report = inv(engineeredPapered);
  assert.ok(!report.required.some((d) => d.docType === "solar_checklist"),
    `an engineered filing was told to attach the prescriptive path's checklist: ${JSON.stringify(
      report.required.filter((d) => d.docType === "solar_checklist").map((d) => `${d.label} (blocking=${d.blocking})`))}`);
  assert.ok(!report.missingAdvisory.some((d) => d.docType === "solar_checklist"),
    "the KB's own checklist prose leaked back in behind the path-scoped row");
});

check("…because the ENGINEERED path's evidence is the PE stamp + sealed letter, and it blocks", () => {
  // The half that already worked. Pinned here so the pair stays a pair: if this ever stops
  // blocking, the gate is inverted again, just in the other direction.
  const blocked = inv(engineeredPapered).missingBlocking;
  const row = blocked.find((d) => d.docType === "structural_letter");
  assert.ok(row, `the engineered path stopped demanding its sealed structural letter: ${JSON.stringify(blocked.map((d) => d.docType))}`);
  assert.equal(row!.blocking, true);
  assert.match(row!.label, /stamp/i);
  assert.match(row!.label, /letter|calc/i);
});

// ---------------------------------------------------------------------------
// NO OVER-REACH — an invented requirement is as damaging as a missed one
// ---------------------------------------------------------------------------
check("NO SIGNAL, NO DEMAND: an AHJ we hold no process knowledge for is asked for nothing", () => {
  // findApplicationProfile ALWAYS returns something — for an unknown Oregon jurisdiction it
  // falls back to the generic Oregon profile, which carries requiresPrescriptiveChecklist.
  // Reading that standalone would demand a checklist from every AHJ in the state we have never
  // heard of. The profile field may only refine a building-side filing we already know about.
  const unknownAhj = { id: "p-nowhere", clientId: null, state: "OR", ahj: "City of Nowhereville", utility: "PGE", parserSnapshot: { permitPathOverride: "prescriptive" } };
  assert.equal(findApplicationProfile(unknownAhj as never).requiresPrescriptiveChecklist, true,
    "premise: the Oregon fallback profile really does carry the checklist flag");
  // RULE ADJUSTED (operator authorization 2026-09-25, B1): an unknown OREGON AHJ now has a cited
  // state-rule structure (separate — OAR 918-050-0180(2)), so its rows exist — as portal entries
  // that never BLOCK. Outside Oregon (no cited rule) nothing is demanded, exactly as before.
  const rows = requiredApplicationDocs(unknownAhj as never, applicationDocContext(unknownAhj as never));
  assert.ok(rows.filter((r) => r.docType !== "solar_checklist").every((r) => !r.blocking),
    "the application rows are portal entries and never block on a state-rule answer");
  // On a CONFIRMED prescriptive path the BCD 440-5952 checklist is owed statewide (the product fills it).
  assert.ok(rows.some((r) => r.docType === "solar_checklist"));
  const unknownWa = { ...unknownAhj, state: "WA" };
  assert.deepEqual(requiredApplicationDocs(unknownWa as never, applicationDocContext(unknownWa as never)), [],
    "an AHJ with no structure knowledge, no process flags and no state rule must demand nothing at all");
});

const unconfirmed = mk();

check("AN UNCONFIRMED PATH stays advisory — staging already blocks it with a better message", () => {
  assert.equal(resolvePermitPath(unconfirmed as never).path, "unknown", "premise: this fixture has no path signal");
  const report = inv(unconfirmed);
  const row = report.required.find((d) => d.docType === "solar_checklist");
  assert.ok(row, "the checklist should still be surfaced so the operator can see it coming");
  assert.equal(row!.blocking, false,
    "an unconfirmed path must not hard-block on a document we cannot yet say is owed");
  assert.match(row!.why, /not confirmed/i, "…and it must say why it is only an advisory");
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nprescriptivePathDocs: all checks passed."
  : `\nprescriptivePathDocs: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
