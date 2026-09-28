// THE PERMIT PATH AND ITS OWN CHECKLIST GIVE ONE ANSWER (dry-run 2026-09-28, B4 part c).
//
// The BCD 5952 says: "If No is selected for any of the above, the installation may not be submitted
// using the prescriptive path." The resolver's Oregon screen folded in only the roofing row, and its
// wind check used the tables' 120 mph cap at Exposure C — not the 110 mph the attachment method
// allows for attachments spaced over 24 in. So a comp-shingle job at 48 in o.c., 120 mph Exposure C
// resolved PRESCRIPTIVE while its own 5952 answered the attachment row No.
//
// Now every 5952 row that answers No (bcdChecklistFacts.bcd5952FailedRows — the list the fill note
// reads) fails the Oregon screen. An unknown row stays silent. An operator's explicit path still wins.
//
// OPERATOR RULING NEEDED: this routes the dry-run's design (and every job like it) ENGINEERED. A real
// issued Coos Bay permit for the same 48 in / 120 mph Exposure C design was filed prescriptive with no
// 5952. The operator's choices: route such jobs engineered, re-space attachments to 24 in or less, or
// set the path to prescriptive on the project (Manual entry -> Permit path) — the override wins below.
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

try {
  await check("(p1) MUST-PASS: 48 in o.c. at 120 mph Exposure C routes ENGINEERED, the basis naming the 110 mph attachment cap", () => {
    const r = pathOf();
    assert.equal(r.path, "engineered");
    assert.equal(r.source, "structural-screen");
    assert.match(r.basis.join(" "), /BCD 5952 attachment method compliance: No — Method 1: attachments spaced 48 in need an ultimate wind speed of 110 mph or less at Exposure C \(plan 120 mph\)/);
  });

  await check("(p2) MUST-PASS: the same job at 24 in o.c. stays prescriptive — its checklist answers every row Yes", () => {
    const p = make({ attachmentSpacingIn: "24" });
    assert.deepEqual(facts.bcd5952FailedRows(p), []);
    assert.equal(resolvePermitPathForProject(db, p).path, "prescriptive");
  });

  await check("(p3) MUST-EXCLUDE: an UNKNOWN row stays silent — a metal roof with no standing-seam statement is not routed on it", () => {
    const r = pathOf({ roofMaterial: "Standing seam metal", roofLayers: "" });
    assert.equal(facts.bcdChecklistAnswers(make({ roofMaterial: "Standing seam metal" })).attachments, "");
    assert.equal(r.path, "prescriptive", r.basis.join(" "));
  });

  await check("(p4) MUST-EXCLUDE: outside Oregon the 5952 rows say nothing", () => {
    const r = pathOf({ state: "WA", city: "Maple Hollow", ahj: "City of Maple Hollow WA", zip: "98001" });
    assert.doesNotMatch(r.basis.join(" "), /BCD 5952/);
  });

  await check("(p5) a framing row that fails on spacing is the spacing failure (named once); a stated height over 18 in routes too", () => {
    const spaced = pathOf({ roofRafterSpacing: "32", attachmentSpacingIn: "24" });
    assert.equal(spaced.path, "engineered");
    assert.doesNotMatch(spaced.basis.join(" "), /BCD 5952 framing row/, "not named twice");
    const tall = pathOf({ moduleHeightAboveRoof: "20", attachmentSpacingIn: "24" });
    assert.equal(tall.path, "engineered");
    assert.match(tall.basis.join(" "), /module height row: No — modules 20 in above the roof/);
  });

  await check("(p6) the operator's explicit path still wins (the ruling this change needs is theirs)", () => {
    const r = pathOf({ permitPathOverride: "prescriptive" });
    assert.equal(r.path, "prescriptive");
    assert.equal(r.source, "operator");
  });
} finally {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nbcd5952PathAgrees: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
