// BATTERY / ESS DRIVES THE REQUIRED SET AND THE PERMIT CARD (issue #246). A storage job owes the ESS
// spec sheet (UL 9540) and an ESS installation detail (NEC 706 / IRC R328), and its permit card says
// whether the AHJ wants a fire review or a separate ESS permit — from the cited per-job lookup or the
// seeded notes, or "not on file, verify". Never a new track. Gated on batteryStatus() === "yes": a
// no-battery job and an unknown one are unchanged. FICTIONAL jurisdictions on two permit platforms
// (an Accela-shaped and an EnerGov-shaped portal); no real AHJ anywhere.
//
// KILL TESTS (each verified red by hand with the change removed):
//   K1 requiredDocuments: drop the essDocumentRows() push           → (d1) (d2) fail.
//   K2 essRequirements: gate on batteryStatus() !== "no"             → (x2) fails.
//   K3 submittalTracks: drop the essStep spread                      → (c1)-(c4) and (c6) fail.
//
// Run: npx tsx backend/test/essRequirements.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ess-requirements-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.ANTHROPIC_API_KEY = "";
process.env.PERMIT_PROCESS_LOOKUP = "off";

const profile = (o: Record<string, unknown>) => ({
  state: "CO", ahj: "", submissionMethod: "", timeline: "", requiresElectricianSign: false, requiresElectricalStamp: false,
  requiresStructuralStamp: false, requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false,
  requiresSolarChecklist: false, requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false,
  requiresFloodplainCheck: false, requiresJurisdictionCheck: false, otherRequirements: "", reviewerNotes: "", sourceSheet: "(test) CO", ...o,
});
const REFERENCE = path.join(tmp, "reference-ahj-processes.json");
fs.writeFileSync(REFERENCE, JSON.stringify({ profiles: [
  profile({ ahj: "Juniper Flats", submissionMethod: "Portal", reviewerNotes: "Upload the plan set. Battery jobs go to the fire department for review" }),
  profile({ ahj: "Sagebrush", submissionMethod: "Portal", reviewerNotes: "Upload the plan set and the spec sheets." }),
] }));
process.env.AHJ_PROCESS_REFERENCE_PATH = REFERENCE;

const { openDatabase } = await import("../src/db");
const db = await openDatabase();
const tracks = await import("../src/submittalTracks");
const permitProcess = await import("../src/permitProcess");
const rd = await import("../src/requiredDocuments");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
let seq = 0;
const BATTERY = { hasBattery: "Yes", batteryMake: "Examplecell", batteryModel: "EX-13", batteryQty: "1" };
const NO_BATTERY = { hasBattery: "No" };
const project = (o: Record<string, unknown>) => ({
  id: `p-${++seq}`, clientId: null, state: "CO", ahj: "", city: "", utility: "Example Mountain Electric", homeownerName: "Test Owner",
  projectAddress: "1 Test Way", zip: "80000", systemSizeDcKw: 6, systemSizeAcKw: 5, parserSnapshot: {}, status: "parsed", ...o,
}) as never;
const cited = <T>(value: T, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const none = (why = "not searched") => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });
const lookup = (ahj: string, o: Record<string, unknown> = {}) => permitProcess.savePermitProcessLookup(db, {
  state: "CO", ahj, lookedUpAt: new Date().toISOString(), issuingAgency: none(), permitStructure: none(), permits: [], ...o,
} as never);
const permit = (discipline: string, label: string, portalUrl: string, platform: string, extra: Record<string, unknown> = {}) => ({
  discipline, label, issuingAgency: none(), portalUrl: cited(portalUrl, portalUrl, `Apply online for the ${label} in our permit portal`),
  recordType: none(), documents: none(), fee: none(), portalPlatform: platform, ...extra,
});
const docTypes = (p: never) => rd.requiredDocuments(p).map((d) => d.docType);
type View = ReturnType<typeof tracks.getSubmittalTracks>[number];
const cards = (p: never): View[] => tracks.getSubmittalTracks(db, p);

// PLATFORM A — an Accela-shaped portal with a cited ESS permit of its own (discipline "other").
const ACCELA = "https://aca.cedar-ridge.example.gov/CitizenAccess/Default.aspx";
lookup("City of Cedar Ridge", {
  permitStructure: cited("combo", "https://cedar-ridge.example.gov/solar", "One residential solar permit covers building and electrical"),
  permits: [
    permit("combo", "Residential Solar PV", ACCELA, "accela"),
    permit("other", "Energy Storage System Permit", ACCELA, "accela", {
      issuingAgency: cited("Cedar Ridge Fire Department", "https://cedar-ridge.example.gov/fire/ess", "Battery energy storage systems require a separate permit from the Fire Department"),
    }),
  ],
});
// PLATFORM B — an EnerGov-shaped portal; separate building + electrical, a cited fire-review prerequisite.
const ENERGOV = "https://energov.pine-hollow.example.gov/EnerGov_Prod/SelfService";
lookup("Town of Pine Hollow", {
  permitStructure: cited("separate", "https://pine-hollow.example.gov/solar", "Solar requires a building permit and a separate electrical permit"),
  permits: [permit("structural", "Residential Solar Building", ENERGOV, "energov"), permit("electrical", "Residential Electrical", ENERGOV, "energov")],
  prerequisites: [cited("Fire Marshal plan review of the battery storage before the building permit", "https://pine-hollow.example.gov/fire", "Plans with battery storage must be reviewed by the Fire Marshal before building permit intake")],
});

const cedar = (snap: Record<string, unknown>) => project({ ahj: "City of Cedar Ridge", city: "Cedar Ridge", parserSnapshot: snap });
const pine = (snap: Record<string, unknown>) => project({ ahj: "Town of Pine Hollow", city: "Pine Hollow", parserSnapshot: snap });

console.log("\nRequired documents");
await check("(d1) MUST-PASS: a battery job owes the ESS spec sheet (blocking) and the ESS detail (advisory) — both platforms", () => {
  for (const p of [cedar(BATTERY), pine(BATTERY)]) {
    const rows = rd.requiredDocuments(p);
    const spec = rows.find((r) => r.docType === "battery_spec");
    const detail = rows.find((r) => r.docType === "ess_detail");
    assert.ok(spec?.blocking, JSON.stringify(rows.map((r) => r.docType)));
    assert.match(spec!.label, /UL 9540/);
    assert.ok(detail && !detail.blocking);
    assert.match(detail!.label, /706.*R328/);
  }
});
await check("(d2) MUST-PASS: a battery model alone (no hasBattery flag) is a battery", () => {
  assert.ok(docTypes(cedar({ batteryModel: "EX-13" })).includes("battery_spec"));
});
await check("(d3) MUST-PASS: the parser's READY line / page map counts the spec sheet present in the plan set; a MISSING line never does", () => {
  const docs = { plan_set: "/tmp/plan.pdf" };
  assert.ok(rd.sheetInPlanSet(cedar({ ...BATTERY, packetReadinessText: "READY - 07 Battery / ESS Spec Sheet" }), "battery_spec", docs));
  assert.ok(rd.sheetInPlanSet(cedar({ ...BATTERY, splitPagesText: "07 Battery / ESS specs: 12, 13" }), "battery_spec", docs));
  assert.ok(!rd.sheetInPlanSet(cedar({ ...BATTERY, packetReadinessText: "OPTIONAL/MISSING - 07 Battery / ESS Spec Sheet" }), "battery_spec", docs));
  assert.ok(!rd.sheetInPlanSet(cedar({ ...BATTERY, splitPagesText: "07 Battery / ESS specs: not detected" }), "battery_spec", docs));
  assert.ok(rd.sheetInPlanSet(cedar({ ...BATTERY, splitPagesText: "E-4 ESS location detail (R328): page 9" }), "ess_detail", docs));
});

console.log("\nThe permit card");
await check("(c1) MUST-PASS (Accela-shaped): the cited ESS permit is a cited step on the one permit card", () => {
  const combo = cards(cedar(BATTERY)).find((t) => t.type === "combo")!;
  assert.equal(combo.essStep?.status, "cited");
  const e = combo.essStep!.entries[0];
  assert.equal(e.basis, "lookup_permit");
  assert.match(e.step, /Energy Storage System Permit — issued by Cedar Ridge Fire Department/);
  assert.equal(e.sourceUrl, "https://cedar-ridge.example.gov/fire/ess");
});
await check("(c2) MUST-PASS (EnerGov-shaped, separate permits): the cited fire review rides the building card only", () => {
  const all = cards(pine(BATTERY));
  const bld = all.find((t) => t.type === "building")!;
  assert.equal(bld.essStep?.status, "cited");
  assert.equal(bld.essStep!.entries[0].basis, "lookup_prerequisite");
  assert.match(bld.essStep!.entries[0].step, /Fire Marshal plan review/);
  assert.equal(all.find((t) => t.type === "electrical")!.essStep, undefined);
  assert.equal(all.find((t) => t.type === "nem")!.essStep, undefined);
});
await check("(c3) MUST-PASS: only a seeded note mentions storage → quoted as an unverified note, never a cited fact", () => {
  const combo = cards(project({ ahj: "Juniper Flats", city: "Juniper Flats", parserSnapshot: BATTERY })).find((t) => t.category === "permit")!;
  assert.equal(combo.essStep?.status, "process_note");
  assert.match(combo.essStep!.entries[0].step, /Battery jobs go to the fire department/);
  assert.equal(combo.essStep!.entries[0].sourceUrl, "");
  assert.match(combo.essStep!.summary, /unverified/);
});
await check("(c4) MUST-PASS: nothing on file → \"not on file, verify\", never assumed", () => {
  const combo = cards(project({ ahj: "Sagebrush", city: "Sagebrush", parserSnapshot: BATTERY })).find((t) => t.category === "permit")!;
  assert.equal(combo.essStep?.status, "not_on_file");
  assert.equal(combo.essStep!.entries.length, 0);
  assert.match(combo.essStep!.summary, /not on file — verify/);
});
await check("(c5) MUST-EXCLUDE: a battery adds no track — the same tracks as the no-battery job (no autopilot staging)", () => {
  for (const mk of [cedar, pine]) assert.deepEqual(tracks.requiredTracks(mk(BATTERY)), tracks.requiredTracks(mk(NO_BATTERY)));
});
await check("(c6) MUST-EXCLUDE: an uncited 'other' permit is not a fact (no step from it)", () => {
  lookup("Village of Aspen Bend", { permits: [{ ...permit("other", "Battery Storage Permit", ACCELA, "accela"), portalUrl: none() }] });
  const combo = cards(project({ ahj: "Village of Aspen Bend", city: "Aspen Bend", parserSnapshot: BATTERY })).find((t) => t.category === "permit")!;
  assert.equal(combo.essStep?.status, "not_on_file");
});

console.log("\nNo-battery and unknown jobs are unchanged");
await check("(x1) MUST-EXCLUDE: a no-battery job carries no ESS row and no ESS step — both platforms", () => {
  for (const p of [cedar(NO_BATTERY), pine(NO_BATTERY)]) {
    assert.ok(!docTypes(p).some((d) => d === "battery_spec" || d === "ess_detail"));
    assert.ok(cards(p).every((t) => !("essStep" in t)));
  }
});
await check("(x2) MUST-EXCLUDE: an UNKNOWN battery (never parsed) is not a battery: output identical to the no-battery job", () => {
  for (const mk of [cedar, pine]) {
    const strip = (v: unknown) => JSON.stringify(v).replace(/"id":"p-\d+"/g, "");
    assert.equal(strip(rd.requiredDocuments(mk({}))), strip(rd.requiredDocuments(mk(NO_BATTERY))));
    assert.equal(strip(cards(mk({}))), strip(cards(mk(NO_BATTERY))));
    assert.ok(cards(mk({})).every((t) => !("essStep" in t)));
  }
});

if (failures) { console.error(`\n${failures} ESS check(s) FAILED.`); process.exit(1); }
console.log("\nAll battery/ESS requirement checks passed.");
process.exit(0);
