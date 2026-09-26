// NEW-AHJ E2E GAPS — QC, the submit gate and Oregon scoping (2026-09-26 e2e run, 7 real plan sets).
//
//   W   QC on a plan set alone failed 7/7 on utility account/meter. With no bill and no meter photo
//       on file those two are a NAMED WAIT (warning, advisory review item, gate warning laned to
//       the NEM application), not a QC failure that stops the chain. With a bill on file and the
//       value still missing, it fails again.
//   D   The document gate printed "✓ Site / plot plan with fire access + escape pathways (attached
//       file)" on the Waltham job whose fire department rejected that pathway. A present document
//       now says "File attached: Site / plot plan …" — no check mark, no content claim.
//   O   Oregon rules out of non-Oregon jobs: a PA job was asked for an Oregon CCB number; a
//       "Salem"/"Portland" AHJ outside Oregon read as Oregon; an IA job's QC cited PGE.
//
//   npx tsx backend/test/e2eGapQcGate.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-gap-qc-gate-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
process.env.CODE_RESEARCH = "off";
process.env.FEE_RESEARCH = "off";
process.env.PERMIT_PROCESS_LOOKUP = "off";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { createProject, getProjectDetail, getSubmitGateReport, documentPresenceLine, contractorLicenceForState, isCriticalReviewItem } = await import("../src/repository");
const { runQcForProject, WAITING_ON_BILL_ISSUE_TYPE } = await import("../src/qc");
const { evaluateBaselineRules } = await import("../src/baselineRules");

const db = await openDatabase();
let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

const client = createClient(db, {
  companyName: "Keystone Test Solar LLC", legalBusinessName: "Keystone Test Solar LLC", ccbLicenseNumber: "",
  electricalLicenseNumber: "", businessEmail: "ops@keystone.test", businessPhone: "(814) 555-0100",
});
const orClient = createClient(db, {
  companyName: "Willamette Test Solar LLC", legalBusinessName: "Willamette Test Solar LLC", ccbLicenseNumber: "",
  electricalLicenseNumber: "", businessEmail: "ops@willamette.test", businessPhone: "(503) 555-0100",
});

// A plan set's own fields — everything EXCEPT what only the customer's bill carries.
const PLAN_ONLY: Record<string, string> = {
  street: "100 Test St", city: "Corry", state: "PA", zip: "16407", ahj: "Corry City", utility: "FirstEnergy",
  dcKw: "8.0", acKw: "6.4", exportKw: "6.4", moduleMake: "Qcells", moduleModel: "Q.PEAK DUO BLK ML-G10+ 400", moduleWattage: "400",
  moduleQty: "20", invModel: "IQ8PLUS-72-2-US", invQty: "20", invOutputW: "290", interco: "Load-side breaker", busRating: "200",
  mainBreaker: "200", pvBreaker: "30", permitPath: "PRESCRIPTIVE", locateCalloutText: "Roof mount, no excavation.",
};
let seq = 0;
const mk = (over: Record<string, string> = {}, clientId = client.id): string => {
  const d = createProject(db, { clientId, owner: `Wait Owner ${++seq}`, ...PLAN_ONLY, ...over });
  saveProjectDocument(db, d.project.id, {
    docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% e2e gap plan set\n", "utf8"), source: "upload",
  });
  return d.project.id;
};
const qcRow = (pid: string, ruleId: string) => getProjectDetail(db, pid).qcResults.find((r) => r.ruleId === ruleId);

// ── W ──────────────────────────────────────────────────────────────────────────────────
await check("W1 MUST-PASS: plan set only, no bill -> account/meter are a named wait (warning), QC does not fail on them", () => {
  const pid = mk();
  runQcForProject(db, pid);
  for (const rule of ["critical.account", "critical.meter"]) {
    const r = qcRow(pid, rule);
    assert.ok(r, `${rule} row missing`);
    assert.equal(r!.qcStatus, "warning", `${rule} should wait, not fail: ${r!.qcStatus} ${r!.message}`);
    assert.match(r!.message, /Waiting on the customer's utility bill/, `${rule} names the wait: ${r!.message}`);
  }
  const d = getProjectDetail(db, pid);
  const fails = d.qcResults.filter((r) => r.qcStatus === "fail").map((r) => r.ruleId);
  assert.ok(!fails.includes("critical.account") && !fails.includes("critical.meter"), `account/meter failed QC: ${fails.join(", ")}`);
  const items = d.humanReviewItems.filter((i) => i.fieldName === "accountNumber" || i.fieldName === "meterNumber");
  assert.ok(items.length === 2 && items.every((i) => i.issueType === WAITING_ON_BILL_ISSUE_TYPE), `review items are the wait: ${JSON.stringify(items.map((i) => i.issueType))}`);
  assert.ok(items.every((i) => !isCriticalReviewItem(i)), "a bill wait is not pending critical work");
  const rec = getSubmitGateReport(db, pid).checks.find((c) => c.id === "single-project-record")!;
  assert.notEqual(rec.status, "blocker", `the gate blocks the permit side on the customer's bill: ${JSON.stringify(rec)}`);
  assert.ok(rec.evidence.some((e) => /Waiting on the customer's utility bill: Account, Meter/.test(e)), `gate names the wait: ${JSON.stringify(rec.evidence)}`);
});

await check("W2 MUST-EXCLUDE: a bill IS on file and account/meter are still missing -> QC fails and the gate blocks", () => {
  const pid = mk();
  saveProjectDocument(db, pid, {
    docType: "utility_bill", filename: "bill.pdf", contentType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% bill\n", "utf8"), source: "upload",
  });
  runQcForProject(db, pid);
  assert.equal(qcRow(pid, "critical.account")?.qcStatus, "fail", "account missing with a bill on file must fail");
  assert.equal(qcRow(pid, "critical.meter")?.qcStatus, "fail", "meter missing with a bill on file must fail");
  const items = getProjectDetail(db, pid).humanReviewItems.filter((i) => i.fieldName === "accountNumber");
  assert.ok(items.length && items.every((i) => i.issueType !== WAITING_ON_BILL_ISSUE_TYPE && isCriticalReviewItem(i)), "the review item is a blocker again");
  const rec = getSubmitGateReport(db, pid).checks.find((c) => c.id === "single-project-record")!;
  assert.equal(rec.status, "blocker");
});

await check("W3 MUST-EXCLUDE: a different missing field (homeowner) still fails with no bill on file", () => {
  const pid = mk({ account: "1234567890", meter: "987654321" });
  db.run("UPDATE projects SET homeowner_name = '' WHERE id = ?", [pid]);
  const rec = getSubmitGateReport(db, pid).checks.find((c) => c.id === "single-project-record")!;
  assert.equal(rec.status, "blocker", JSON.stringify(rec.evidence));
});

// ── D ──────────────────────────────────────────────────────────────────────────────────
await check("D1 MUST-EXCLUDE: a present document never gets a check mark or its content claim", () => {
  const line = documentPresenceLine("Site / plot plan with fire access + escape pathways", "attached file");
  assert.ok(!line.includes("✓"), line);
  assert.ok(!/fire access|escape pathways/i.test(line), `content claim kept: ${line}`);
  assert.match(line, /^File attached: Site \/ plot plan/);
  assert.match(line, /not checked/);
  const sld = documentPresenceLine("Electrical one-line / SLD (rapid shutdown, NEC 690.12)", "in plan set");
  assert.ok(!/rapid shutdown/i.test(sld) && sld.startsWith("Found in the plan set: Electrical one-line / SLD"), sld);
});

await check("D2 MUST-PASS: the gate's document check prints no ✓ line for a present document", () => {
  const pid = mk({
    account: "1234567890", meter: "987654321",
    sitePlanNotesText: "Roof plan shows fire access pathway, ridge/eave setbacks, array dimensions, service equipment, and PV layout.",
    splitPagesText: ["01 Site/Roof Plan and PV layout with fire pathway: pages 1-2", "02 SLD 3-Line Diagram with NEC 705.12 calculation and rapid shutdown: page 3",
      "03 Roof framing and racking attachment detail: pages 4-5", "04 Module spec UL 61730: pages 6-8", "05 Inverter spec UL 1741 SB: pages 9-11"].join(String.fromCharCode(10)),
  });
  const doc = getSubmitGateReport(db, pid).checks.find((c) => c.id === "document-inventory")!;
  assert.ok(!doc.evidence.some((e) => e.startsWith("✓")), `check mark on a present file: ${JSON.stringify(doc.evidence)}`);
  assert.ok(doc.evidence.some((e) => /^(File attached|Found in the plan set): /.test(e)), `present documents named: ${JSON.stringify(doc.evidence)}`);
});

// ── O ──────────────────────────────────────────────────────────────────────────────────
await check("O1 MUST-EXCLUDE: a PA job with no licence on file is never asked for a CCB number", () => {
  const pid = mk({ account: "1234567890", meter: "987654321" });
  const c = getSubmitGateReport(db, pid).checks.find((x) => x.id === "submitting-client")!;
  const words = `${c.title} ${c.requirement} ${c.nextAction} ${c.evidence.join(" ")}`;
  assert.ok(!/\bCCB\b/.test(words), `Oregon's CCB on a PA job: ${words}`);
  assert.notEqual(c.status, "blocker", "an unknown PA licence requirement is a warning, not a CCB blocker");
  assert.match(c.nextAction, /PA/);
});

await check("O2 MUST-PASS: an Oregon job with no CCB still blocks, in CCB words", () => {
  const pid = mk({ state: "OR", city: "Salem", ahj: "Salem", utility: "PGE", account: "1234567890", meter: "987654321" }, orClient.id);
  const c = getSubmitGateReport(db, pid).checks.find((x) => x.id === "submitting-client")!;
  assert.equal(c.status, "blocker");
  assert.match(c.nextAction, /CCB/);
});

await check("O3 MUST-PASS: a PA licence on the client's state licences satisfies the PA check", () => {
  const lic = contractorLicenceForState({ state_licenses_json: JSON.stringify([{ state: "PA", kind: "home_improvement", number: "PA123456" }]) }, "PA");
  assert.equal(lic.number, "PA123456");
  assert.equal(lic.oregon, false);
  assert.equal(contractorLicenceForState({ ccb_license_number: "240135" }, "PA").number, "", "a CCB is not a PA licence");
});

await check("O4 MUST-EXCLUDE: 'Salem' / 'Portland' / 'Washington County' outside Oregon do not pull Oregon rules or PGE", () => {
  const base = { dcKw: "30", acKw: "28", exportKw: "28", acDiscReq: "", snow: "90", deadLoad: "5", roofRafterSpacing: "32", wind: "D" };
  for (const [state, ahj, utility] of [["MA", "City of Salem", "National Grid"], ["ME", "Portland", "Central Maine Power"], ["PA", "Washington County", "PGE"]] as const) {
    const out = evaluateBaselineRules({ ...base, state, ahj, utility } as never);
    const oregonish = out.filter((r) => /^or-|oregon|pge/i.test(`${r.ruleId} ${r.ruleName}`));
    assert.equal(oregonish.length, 0, `${state}/${ahj}: ${JSON.stringify(oregonish.map((r) => r.ruleId))}`);
  }
  const or = evaluateBaselineRules({ ...base, state: "OR", ahj: "Salem", utility: "PGE" } as never);
  assert.ok(or.some((r) => /^or-/.test(r.ruleId)), "control: Oregon still gets Oregon's screens");
});

await check("O5 MUST-EXCLUDE: an IA job's inverter-spec requirement never cites PGE", () => {
  const pid = mk({ state: "IA", city: "Iowa City", ahj: "Iowa City", utility: "MidAmerican Energy", account: "1234567890", meter: "987654321" });
  runQcForProject(db, pid);
  const d = getProjectDetail(db, pid);
  const text = d.qcResults.map((r) => `${r.ruleName} ${r.message}`).join(" | ");
  assert.ok(!/\bPGE\b/.test(text), `PGE on an Iowa job: ${text.match(/.{0,80}PGE.{0,80}/)?.[0]}`);
});

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows keeps the sqlite handle */ }
if (failures) {
  console.error(`\ne2eGapQcGate: ${failures} FAILED`);
  process.exit(1);
}
console.log("\ne2eGapQcGate: all checks passed");
