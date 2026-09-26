// CLIENT MATCHING ACROSS STATES (clientMatch.resolveClientFromPlanSet) — synthetic clients and
// look-alike decoys; every licence number here is INVENTED (the Iowa FORMAT, EL + 6 digits +
// class suffix, is the only real thing).
//
// The Iowa City cases this pins (.probe/resume-0924b/README.md):
//   - a plan set printing an Iowa electrical licence "IA-EL......MA" (format EL + 6 digits + class)
//     -> an exact state licence on exactly one client auto-assigns, like an Oregon CCB;
//   - a title block reading "LICENSE #: NN-NNNNNNN" -> EIN-shaped, NOT a contractor licence, never
//     auto-assigns (even when a decoy client stores those digits as a "CCB");
//   - a company name only in a LOGO (absent from the text layer) -> candidates, a human confirms;
//   - a national installer's plan set whose permit contractor of record is a local EC partner ->
//     the plan set's company is the client (pre-selected), never the partner auto-assigned; the
//     client record names that partner per AHJ/portal.
// MUST: never binds the wrong company.
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmstates-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const clients = await import("../src/clients");
const cm = await import("../src/clientMatch");

let failures = 0; let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const ORG = "org-cmstates";
db.run("INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES (?, ?, ?)", [ORG, "cm states test org", new Date().toISOString()]);

// ── the book: principals, partners and decoys ────────────────────────────────────────────
const summit = clients.createClient(db, { companyName: "Summit Home Solar", businessPhone: "555-010-0001", electricalLicenseNumber: "EL111111MA", licenseState: "IA",
  partnerContacts: [{ role: "contractor_electrical", companyName: "Riverbend Electric", contactName: "Pat Example", licenseNumber: "EL222222MA", licenseState: "IA", ahj: "City of Iowa City", portalType: "" }] }, ORG);
const riverbend = clients.createClient(db, { companyName: "Riverbend Electric", businessPhone: "555-010-0002", stateLicenses: [{ state: "IA", kind: "electrical_contractor", number: "EL222222MA" }] }, ORG);
// Look-alike decoys: a similar name with a DIFFERENT Iowa licence, sharing Summit's phone.
const summitDecoy = clients.createClient(db, { companyName: "Summit Home Solar Co", businessPhone: "555-010-0001", stateLicenses: [{ state: "IA", kind: "electrical_contractor", number: "EL333333REC" }] }, ORG);
// Parent vs branch: same phone, the branch holds the Florida licence.
const parent = clients.createClient(db, { companyName: "Sunrise Solar", businessPhone: "555-020-0000" }, ORG);
const branch = clients.createClient(db, { companyName: "Sunrise Solar - Tampa", businessPhone: "555-020-0000", stateLicenses: [{ state: "FL", kind: "solar_contractor", number: "CVC56789" }] }, ORG);
const flDecoy = clients.createClient(db, { companyName: "Sunrise Solar Tampa Bay", stateLicenses: [{ state: "FL", kind: "solar_contractor", number: "CVC56790" }] }, ORG);
const tx = clients.createClient(db, { companyName: "Lone Star Synth Electric", stateLicenses: [{ state: "TX", kind: "electrical_contractor", number: "TECL12345" }] }, ORG);
const ut = clients.createClient(db, { companyName: "Wasatch Synth Solar", stateLicenses: [{ state: "UT", kind: "contractor", number: "11223344-5501" }] }, ORG);
// EIN decoy: a client whose "CCB" field holds the digits of an EIN-shaped number.
const einDecoy = clients.createClient(db, { companyName: "Prairie Synth Builders", ccbLicenseNumber: "471234567", ein: "47-1234567" }, ORG);
// Oregon: CCB still binds, and an electrical licence never satisfies a CCB test.
const orCo = clients.createClient(db, { companyName: "Cascade Synth Solar", ccbLicenseNumber: "223344", electricalLicenseNumber: "C9911" }, ORG);
const orElec = clients.createClient(db, { companyName: "Willamette Synth Electric", electricalLicenseNumber: "223355" }, ORG);

const R = (identity: Record<string, unknown>) => cm.resolveClientFromPlanSet(db, identity as never, ORG);
const all: ReturnType<typeof R>[] = [];
const r = (identity: Record<string, unknown>) => { const x = R(identity); all.push(x); return x; };

await check("(f1) formats: Iowa EL (IA- prefix optional), Florida DBPR, Texas TECL, Utah DOPL, EIN", () => {
  assert.deepEqual(cm.classifyLicence("IA-EL111111MA"), { format: "ia_electrical", normalized: "EL111111MA" });
  assert.deepEqual(cm.classifyLicence("EL089123REC"), { format: "ia_electrical", normalized: "EL089123REC" });
  assert.equal(cm.classifyLicence("CVC 56789").format, "fl_dbpr");
  assert.equal(cm.classifyLicence("EC13001234").format, "fl_dbpr");
  assert.equal(cm.classifyLicence("TECL 12345").format, "tx_electrical");
  assert.equal(cm.classifyLicence("11223344-5501").format, "ut_dopl");
  assert.equal(cm.classifyLicence("LICENSE #: 47-1234567").format, "ein");
  assert.equal(cm.classifyLicence("47-1234567").format, "ein");
  assert.equal(cm.classifyLicence("CCB# 223344").format, "plain");
});
await check("(a1) MUST-PASS: an Iowa EL licence on exactly one client auto-assigns — the look-alike with the same phone does not win", () => {
  const x = r({ companyName: "Summit Home Solar", ccbLicenseNumber: "IA-EL111111MA", phone: "555-010-0001" });
  assert.equal(x.decision, "auto_assign"); assert.equal(x.clientId, summit.id); assert.equal(x.requiresConfirmation, false);
  assert.ok(!x.candidates.some((c) => c.clientId === summitDecoy.id), "the decoy's different EL licence disqualifies it");
});
await check("(a2) MUST-PASS: a class-suffix variant (REC) is its own licence", () => {
  const x = r({ companyName: "Summit Home Solar Co", ccbLicenseNumber: "EL333333REC" });
  assert.equal(x.decision, "auto_assign"); assert.equal(x.clientId, summitDecoy.id);
});
await check("(a3) MUST-PASS: Florida CVC binds the BRANCH that holds it, not the parent sharing its phone; the decoy one digit off is excluded", () => {
  const x = r({ companyName: "Sunrise Solar", ccbLicenseNumber: "CVC 56789", phone: "555-020-0000" });
  assert.equal(x.decision, "auto_assign"); assert.equal(x.clientId, branch.id);
  assert.ok(!x.candidates.some((c) => c.clientId === flDecoy.id));
});
await check("(a4) Texas TECL and Utah DOPL bind their holders", () => {
  assert.equal(r({ companyName: "Lone Star Synth Electric", electricalLicenseNumber: "TECL 12345" }).clientId, tx.id);
  assert.equal(r({ companyName: "Wasatch Synth Solar", ccbLicenseNumber: "11223344-5501" }).clientId, ut.id);
});
await check("(e1) MUST-EXCLUDE: an EIN-shaped 'LICENSE #' never auto-assigns — not even to a client storing those digits as a CCB", () => {
  const x = r({ companyName: "Prairie Synth Builders", ccbLicenseNumber: "47-1234567" });
  assert.notEqual(x.decision, "auto_assign");
  assert.ok(!x.candidates.some((c) => c.evidence.some((e) => e.kind === "ccb" || e.kind === "state_license")), "no licence evidence from an EIN");
  assert.match(x.explanation, /EIN/);
  assert.deepEqual(x.installer.rejectedLicenceNumbers, ["47-1234567"]);
  const bare = r({ ccbLicenseNumber: "LICENSE #: 47-1234567" });
  assert.equal(bare.decision, "none", "an EIN alone identifies no installer");
  assert.equal(bare.clientId, null);
  void einDecoy;
});
await check("(l1) MUST-PASS: a logo-only company name -> candidates, a human confirms; the same name in the text -> pre-select", () => {
  const logo = cm.resolveClientForExtraction(db, { contractorCompany: { value: "Riverbend Electric", confidence: 0.8 } } as never, ORG, "SITE PLAN  SCALE 1/8 = 1'  PV-1  MODULES 10  (NO COMPANY NAME IN THE TEXT LAYER)");
  assert.equal(logo.decision, "candidates"); assert.equal(logo.clientId, null);
  assert.match(logo.explanation, /logo/);
  const printed = cm.resolveClientForExtraction(db, { contractorCompany: { value: "Riverbend Electric", confidence: 0.8 } } as never, ORG, "RIVERBEND ELECTRIC  PV-1 SITE PLAN");
  assert.equal(printed.decision, "preselect"); assert.equal(printed.clientId, riverbend.id); assert.equal(printed.requiresConfirmation, true);
  assert.equal(cm.companyNameInText("Summit Home Solar, LLC", "SUMMIT HOME\nSOLAR  PV-1"), true);
  assert.equal(cm.companyNameInText("Summit Home Solar", "PV-1 SITE PLAN"), false);
});
await check("(p1) MUST-PASS: the plan set's company with its PARTNER's licence -> the company is pre-selected, the partner never auto-assigned", () => {
  const x = r({ companyName: "Summit Home Solar", electricalLicenseNumber: "EL222222MA" });
  assert.equal(x.decision, "preselect"); assert.equal(x.clientId, summit.id); assert.equal(x.requiresConfirmation, true);
  assert.match(x.explanation, /partner/);
});
await check("(p2) MUST-EXCLUDE: the partner's OWN plan set (its name, its licence) still binds the partner", () => {
  const x = r({ companyName: "Riverbend Electric", electricalLicenseNumber: "EL222222MA" });
  assert.equal(x.decision, "auto_assign"); assert.equal(x.clientId, riverbend.id);
});
await check("(p3) the client record names the partner per AHJ/portal; the most specific scope wins", () => {
  const withMore = clients.updateClient(db, summit.id, { partnerContacts: [
    ...(clients.getClient(db, summit.id).partnerContacts ?? []),
    { role: "contractor_electrical", companyName: "Statewide Synth Electric", licenseNumber: "EL444444MA", licenseState: "IA", ahj: "", portalType: "" },
  ] });
  assert.equal(clients.partnerContactFor(withMore, { ahj: "City of Iowa City" })?.companyName, "Riverbend Electric");
  assert.equal(clients.partnerContactFor(withMore, { ahj: "Iowa City" })?.companyName, "Riverbend Electric", "'City of' is spelling");
  assert.equal(clients.partnerContactFor(withMore, { ahj: "City of Synthville" })?.companyName, "Statewide Synth Electric");
  assert.equal(clients.partnerContactFor(clients.getClient(db, riverbend.id), { ahj: "City of Iowa City" }), null);
});
await check("(o1) MUST-EXCLUDE: Oregon CCB still binds; an electrical licence number never satisfies a CCB", () => {
  assert.equal(r({ companyName: "Cascade Synth Solar", ccbLicenseNumber: "CCB# 223344" }).clientId, orCo.id);
  const x = r({ ccbLicenseNumber: "223355" });
  assert.notEqual(x.clientId, orElec.id, "C/E licence 223355 is not CCB 223355");
});
await check("(s1) shared phone, no licence, parent vs branch -> candidates, nothing assigned", () => {
  const x = r({ companyName: "Sunrise", phone: "555-020-0000" });
  assert.equal(x.decision, "candidates"); assert.equal(x.clientId, null);
  void parent;
});
await check("(z1) MUST: requiresConfirmation is false ONLY on auto_assign, across every decision above", () => {
  for (const x of all) assert.equal(x.requiresConfirmation, x.decision !== "auto_assign", `${x.decision}: ${x.explanation}`);
});

console.log(failures ? `clientMatchStates: ${failures} FAILED, ${passed} passed` : `clientMatchStates: ${passed}/${passed} passed`);
if (failures) process.exit(1);
