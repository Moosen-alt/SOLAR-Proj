// A BCD 5952 "NO" ROW WARNS; IT DOES NOT ROUTE THE PATH (dry-run 2026-09-28, B4 part c).
//
// The BCD 5952 says: "If No is selected for any of the above, the installation may not be submitted
// using the prescriptive path." A comp-shingle job at 48 in o.c., 120 mph Exposure C answers the
// attachment row No (Method 1 allows 110 mph at Exposure C above 24-in spacing). One cut routed every
// such job ENGINEERED from the permit-path screen — which then demanded PE-stamped documents as a
// document-inventory BLOCKER — while a real issued Coos Bay permit for that exact design was filed
// prescriptive.
//
// Operator ruling pending: a 5952 No row warns, it does not route engineered. The conservative default
// until then: the path resolves exactly as before that cut (only the roofing row is a screen input),
// and the submit gate's permit-path check is a WARNING naming the failing clause — never staged
// silently, never a false stop. The operator's explicit path still wins either way.
//
// Synthetic projects only. Run: npx tsx backend/test/bcd5952PathAgrees.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcd5952-path-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const repo = await import("../src/repository");
const clients = await import("../src/clients");
const { resolvePermitPathForProject } = await import("../src/codeProfiles");
const facts = await import("../src/bcdChecklistFacts");

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const client = clients.createClient(db, { companyName: "Pathcheck Test Solar LLC", ccbLicenseNumber: "900003" });
// The dry-run's design, on a fictional job: comp shingle, attachments 48 in o.c., 120 mph Exposure C.
const JOB = {
  owner: "Path Test Owner", street: "9 Synthetic Way", city: "Maple Hollow", state: "OR", zip: "97352", ahj: "City of Maple Hollow",
  utility: "Test Electric", dcKw: "6", acKw: "5", moduleMake: "Example", moduleModel: "EX-440", mounting: "Roof Mount",
  pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US",
  roofMaterial: "Composition Shingle", roofLayers: "1", framingType: "truss", roofRafterSpacing: "24", attachmentToFraming: "yes",
  attachmentSpacingIn: "48", attachmentEdgeSpacingIn: "24", gravityWindDesign: "yes", manufacturerInstallation: "yes",
  snow: "20", deadLoad: "3", wind: "C", windSpeed: "120",
};
const make = (over: Record<string, string> = {}) => repo.createProject(db, { clientId: client.id, ...JOB, ...over } as never).project;
const pathOf = (over: Record<string, string> = {}) => resolvePermitPathForProject(db, make(over));
type GateCheck = { id: string; status: string; evidence: string[]; nextAction: string };
const gateOf = (over: Record<string, string> = {}) => {
  const checks = repo.getSubmitGateReport(db, make(over).id).checks as GateCheck[];
  return { path: checks.find((c) => c.id === "permit-path")!, inventory: checks.find((c) => c.id === "document-inventory")! };
};
const ATTACHMENT_NO = /BCD 5952 attachment method compliance: No — Method 1: attachments spaced 48 in need an ultimate wind speed of 110 mph or less at Exposure C \(plan 120 mph\)/;
const PE_DOCS = /PE-stamped structural plans/i;

try {
  await check("(p1) MUST-PASS (ruling pending): the dry-run design resolves PRESCRIPTIVE as before — the 5952 attachment row still answers No, but it does not route the path", () => {
    const p = make();
    assert.ok(facts.bcd5952FailedRows(p).some((f) => f.row === "attachments"), "the checklist itself still answers the attachment row No");
    const r = resolvePermitPathForProject(db, p);
    assert.equal(r.path, "prescriptive", r.basis.join(" "));
    assert.equal(r.needsEngineeredDocs, false, "no PE-stamped package is demanded");
    assert.doesNotMatch(r.basis.join(" "), /BCD 5952 attachment/);
  });

  await check("(p2) MUST-PASS: the same job at 24 in o.c. answers every 5952 row Yes and stays prescriptive", () => {
    const p = make({ attachmentSpacingIn: "24" });
    assert.deepEqual(facts.bcd5952FailedRows(p), []);
    assert.equal(resolvePermitPathForProject(db, p).path, "prescriptive");
  });

  await check("(p3) MUST-EXCLUDE: an UNKNOWN row stays silent — a metal roof with no standing-seam statement is not flagged on it", () => {
    const r = pathOf({ roofMaterial: "Standing seam metal", roofLayers: "" });
    assert.equal(facts.bcdChecklistAnswers(make({ roofMaterial: "Standing seam metal" })).attachments, "");
    assert.equal(r.path, "prescriptive", r.basis.join(" "));
  });

  await check("(p4) MUST-EXCLUDE: outside Oregon the 5952 rows say nothing — not in the basis, not on the gate", () => {
    const over = { state: "WA", city: "Maple Hollow", ahj: "City of Maple Hollow WA", zip: "98001" };
    assert.doesNotMatch(pathOf(over).basis.join(" "), /BCD 5952/);
    assert.doesNotMatch(gateOf(over).path.evidence.join(" | "), /BCD 5952/);
  });

  await check("(p5) the base screen still routes on its own inputs: rafters at 32 in are the spacing failure; 3 composition layers fail the roofing row", () => {
    const spaced = pathOf({ roofRafterSpacing: "32", attachmentSpacingIn: "24" });
    assert.equal(spaced.path, "engineered");
    assert.match(spaced.basis.join(" "), /rafter spacing 32 in > 24 in prescriptive limit/);
    assert.doesNotMatch(spaced.basis.join(" "), /BCD 5952 framing row/, "the framing row is not a second screen failure");
    const layered = pathOf({ roofLayers: "3", attachmentSpacingIn: "24" });
    assert.equal(layered.path, "engineered", layered.basis.join(" "));
    assert.match(layered.basis.join(" "), /BCD 5952 roofing row admits no more than two layers/);
  });

  await check("(p6) the operator's explicit path still wins (either choice is theirs)", () => {
    const eng = pathOf({ permitPathOverride: "engineered" });
    assert.equal(eng.path, "engineered");
    assert.equal(eng.source, "operator");
    const pre = pathOf({ permitPathOverride: "prescriptive" });
    assert.equal(pre.path, "prescriptive");
    assert.equal(pre.source, "operator");
  });

  await check("(p7) MUST-PASS: the dry-run design's gate says it — permit-path is a WARNING naming the clause", () => {
    const g = gateOf();
    assert.equal(g.path.status, "warning", g.path.evidence.join(" | "));
    assert.match(g.path.evidence.join(" | "), /Permit path: prescriptive\./);
    assert.match(g.path.evidence.join(" | "), ATTACHMENT_NO);
    assert.match(g.path.nextAction, /may not be submitted on the prescriptive path/);
    // A stated module height over 18 in is another No row: warned the same way, path unchanged.
    const tall = gateOf({ moduleHeightAboveRoof: "20", attachmentSpacingIn: "24" });
    assert.equal(tall.path.status, "warning");
    assert.match(tall.path.evidence.join(" | "), /BCD 5952 module height row: No — modules 20 in above the roof/);
    // The operator choosing prescriptive over the No row is warned too.
    assert.equal(gateOf({ permitPathOverride: "prescriptive" }).path.status, "warning");
  });

  await check("(p7b) MUST-PASS: the dry-run design's document inventory demands no PE-stamped documents (the false stop the routing raised)", () => {
    const g = gateOf();
    assert.doesNotMatch(g.inventory.evidence.join(" | "), PE_DOCS, "the document inventory does not ask for PE-stamped documents");
    assert.doesNotMatch(g.inventory.nextAction, PE_DOCS);
    // Not vacuous: the same fixture on the engineered path (the operator's choice) is asked for them.
    assert.match(gateOf({ permitPathOverride: "engineered" }).inventory.evidence.join(" | "), PE_DOCS);
  });

  await check("(p8) MUST-EXCLUDE: a clean prescriptive job passes the permit-path check with no 5952 line; an engineered path carries none", () => {
    const clean = gateOf({ attachmentSpacingIn: "24" });
    assert.equal(clean.path.status, "pass", clean.path.evidence.join(" | "));
    assert.doesNotMatch(clean.path.evidence.join(" | "), /BCD 5952/);
    const eng = gateOf({ permitPathOverride: "engineered" });
    assert.equal(eng.path.status, "pass", eng.path.evidence.join(" | "));
    assert.doesNotMatch(eng.path.evidence.join(" | "), /BCD 5952/);
  });
} finally {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nbcd5952PathAgrees: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
