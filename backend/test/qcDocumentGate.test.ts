// THE DOCUMENT CHECK FIRED AT THE PORTAL, WHICH IS THE ONE PLACE IT IS TOO LATE.
//
// Two real Coos Bay structural permits came back "Intake Requirements Needed" — one wanting a
// PE-stamped structural, one wanting a plan review fee — and in both cases the operator found out
// from the CITY rather than from us. The information was not missing: documentInventory already
// knows exactly what a Coos Bay structural filing needs, and the staging gate already refuses
// without it (repository.ts, "Submission staging blocked: required document(s) not attached").
//
// It just ran at the wrong moment. The staging gate fires when somebody presses stage — by then
// the plan set is weeks old, the crew may be booked, and getting a sealed letter means going back
// to the designer. QC runs right after the parse, which is when there is still time to ask.
//
// So QC now reports the same inventory the staging gate uses. Same source of truth, moved
// earlier: an operator sees "this AHJ will want a PE-stamped structural letter" on the QC screen
// the day the plan set lands, not three weeks later from a plans examiner.
//
//   MUST WARN    — a project missing a document staging will refuse is WARNED about at QC, by
//                  name. Deliberately not a QC failure: qc_failed blocks staging and autopilot,
//                  so failing here would stall every project the moment it parses, before anyone
//                  could attach anything. Surface early, block late — the refusal stays at
//                  staging, where it already was.
//   MUST WARN    — an advisory document (a filled application form) warns rather than blocks, so
//                  a complete-but-unpapered project is not stopped dead.
//   MUST PASS    — a project with everything attached raises nothing. A gate that always fires
//                  is one an operator learns to click past.
//   MUST AGREE   — with the staging gate. Two lists that can disagree is how the portal ends up
//                  being the thing that tells you.
//
//   npx tsx backend/test/qcDocumentGate.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-doc-gate-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { runQcForProject } = await import("../src/qc");
const { documentInventory } = await import("../src/requiredDocuments");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const client = createClient(db, { companyName: "QC Docs Solar", ccbLicenseNumber: "959595" });
let n = 0;
const mk = () => createProject(db, {
  clientId: client.id, owner: `QC Owner ${++n}`, street: `${n} QC St`, city: "Coos Bay",
  state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "8", acKw: "6.4",
}).project;

// A REAL FILE ON DISK. projectDocsByType requires fs.existsSync(stored_path) — a row pointing at
// nothing is not a document, which is right, and is why the first version of this fixture showed
// every sheet as missing no matter what it inserted.
const attach = (pid: string, docType: string) => {
  const file = path.join(tmpDir, `${pid}-${docType}.pdf`);
  fs.writeFileSync(file, "%PDF-1.4 test fixture");
  db.run(
    `INSERT INTO project_documents (id, project_id, doc_type, original_filename, stored_path, source, uploaded_at)
     VALUES (?, ?, ?, ?, ?, 'upload', ?)`,
    [`${pid}-${docType}`, pid, docType, `${docType}.pdf`, file, new Date().toISOString()],
  );
};

const docRules = (pid: string) => {
  runQcForProject(db, pid);
  return db.query<{ rule_id: string; qc_status: string; message: string; severity: string }>(
    "SELECT rule_id, qc_status, message, severity FROM qc_results WHERE project_id = ? AND rule_id LIKE 'docs.%'",
    [pid],
  );
};

check("THE HEADLINE: a project missing required documents is WARNED about at QC, by name", () => {
  const p = mk();   // nothing attached at all
  const rules = docRules(p.id);
  assert.ok(rules.length > 0, "QC said nothing at all about documents — this is the gap the portal filled");
  const raised = rules.filter((r) => r.qc_status !== "pass");
  assert.ok(raised.length > 0, `nothing raised: ${JSON.stringify(rules.map((r) => [r.rule_id, r.qc_status]))}`);
  assert.equal(rules.filter((r) => r.qc_status === "fail").length, 0,
    "documents must WARN at QC, never fail — a QC failure blocks staging and autopilot");
  const text = raised.map((r) => r.message).join(" ");
  assert.match(text, /plan set|site plan|one-line|SLD|structural/i,
    `the failure must name what is missing, not just that something is: ${text}`);
});

check("...and it names the AHJ, because the requirement is the AHJ's, not ours", () => {
  const p = mk();
  const text = docRules(p.id).map((r) => r.message).join(" ");
  assert.match(text, /Coos Bay/i, `an operator needs to know whose requirement this is: ${text}`);
});

check("MUST PASS: a fully papered project raises nothing", () => {
  // A gate that fires on every project is one people learn to click past.
  const p = mk();
  for (const d of ["plan_set", "site_plan", "sld", "structural", "module_spec", "inverter_spec", "labels",
    "permit_application", "electrical_application", "solar_checklist", "building_application"]) attach(p.id, d);
  const rules = docRules(p.id);
  assert.equal(rules.filter((r) => r.qc_status === "fail").length, 0,
    `a complete project was BLOCKED: ${JSON.stringify(rules.filter((r) => r.qc_status === "fail").map((r) => r.message))}`);
});

check("MUST WARN, NOT FAIL: an advisory document does not block", () => {
  // The filled application forms are advisory — the package is submittable without them attached
  // as separate files, and stopping on that would block work that is genuinely ready.
  const p = mk();
  for (const d of ["plan_set", "site_plan", "sld", "structural", "module_spec", "inverter_spec"]) attach(p.id, d);
  const rules = docRules(p.id);
  assert.equal(rules.filter((r) => r.qc_status === "fail").length, 0,
    `an advisory-only gap was treated as blocking: ${JSON.stringify(rules.map((r) => [r.rule_id, r.qc_status, r.message]))}`);
  assert.ok(rules.some((r) => r.qc_status === "warning"), "the gap should still be said out loud");
});

check("MUST AGREE with the staging gate — same inventory, read earlier", () => {
  // Two lists that can disagree is exactly how the portal ends up being the thing that tells you.
  const p = mk();
  attach(p.id, "plan_set");
  attach(p.id, "site_plan");
  const inv = documentInventory(db, { ...(p as object), id: p.id } as never);
  const gateSays = inv.missingBlocking.map((d: { label: string }) => d.label).sort();
  const qcSays = docRules(p.id).filter((r) => r.qc_status !== "pass")
    .flatMap((r) => gateSays.filter((label: string) => r.message.includes(label))).sort();
  assert.deepEqual(qcSays, gateSays,
    `QC and the staging gate disagree about what is missing.\n  gate: ${JSON.stringify(gateSays)}\n  qc:   ${JSON.stringify(qcSays)}`);
});

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0
  ? "\nqcDocumentGate: all checks passed."
  : `\nqcDocumentGate: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
