// NEW MEXICO: THE PER-JOB LOOKUP ASKS "OWN BUILDING PROGRAM, OR SERVED BY THE STATE CID?" AND AN
// "UNINCORPORATED COUNTY" ANSWER MOVES THE ZONING STEP TO THE COUNTY'S OFFICE (issue #44, items 1+3).
//   - the NM process prompt asks the CID question (with a citation) and for the zoning step as a
//     prerequisite; another state's prompt does not;
//   - a CITED "state" answer puts an AHJ no seed names on CID; a cited "own" answer takes a seeded
//     AHJ off it (a cited lookup beats a seeded state rule); a person's verified row beats both
//     (rule 3); an uncited answer is not kept (unknown stays unknown);
//   - the CID information page is a citation, never a portal (rule 5, the one predicate);
//   - "Unincorporated county" on a city/village AHJ names the county office (seeded table or the
//     lookup's cited answer), and says it is not on file rather than guessing.
// The model is stubbed; synthetic jurisdictions and addresses; no network.
//   npx tsx backend/test/nmLookupCid.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord, WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nm-cid-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const ppl = await import("../src/permitProcessLookup");
const pp = await import("../src/permitProcess");
const { permitStructureAnswer } = await import("../src/applicationDocs");
const { isInformationalPageUrl } = await import("../src/portalChannel");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const CID_PAGE = "https://www.rld.nm.gov/construction-industries/";
const TOWN_PAGE = "https://www.examplepueblo-nm.gov/planning/zoning";
const CID = /Construction Industries Division/;
const project = (ahj: string, city: string, snapshot: Record<string, unknown> = {}): ProjectRecord =>
  ({ id: "p-nm", clientId: null, homeownerName: "Example Owner", projectAddress: "100 Example Rd", city, state: "NM", zip: "87000", ahj,
    utility: "Example Utility", parserSnapshot: { projectDescriptionText: "Install roof-mounted PV system, 12 modules.", ...snapshot } }) as unknown as ProjectRecord;

const answer = (over: Record<string, unknown>) => JSON.stringify({
  issuingAgency: { value: null, notFound: "no page names one agency for both permits" },
  permitStructure: { value: null, notFound: "not stated" },
  permits: [],
  prerequisites: [],
  ...over,
});
const grounded = (text: string): WebLookupResult => ({ text, groundedSearches: 3, stopReason: "end_turn", resultUrls: [CID_PAGE, TOWN_PAGE], pagesRead: 0 });
const asked: Array<{ label: string; system: string }> = [];
const stub = (p1: string) => ({ webLookup: async (i: { label: string; system: string }) => { asked.push(i); return grounded(/process$/.test(i.label) ? p1 : "{}"); } });
const run = (ahj: string, p1: string, force = false) => ppl.runPermitProcessLookup(db, stub(p1), { state: "NM", ahj, reader: null, force });

const STATE_SERVED = { value: "state", sourceUrl: CID_PAGE, quote: "CID is the building official for the Village of Example Pueblo, which has no building program of its own" };

await check("the NM process prompt asks the CID question with a citation, and for the zoning step as a prerequisite", async () => {
  asked.length = 0;
  await run("Village of Example Pueblo", answer({ buildingProgram: STATE_SERVED }));
  const sys = asked.find((a) => /process$/.test(a.label))!.system;
  assert.match(sys, /buildingProgram/);
  assert.match(sys, /Construction Industries Division/);
  assert.match(sys, /own building program/i);
  assert.match(sys, /zoning[^]*prerequisites/i);
  assert.match(sys, /unincorporatedZoning/);
  assert.doesNotMatch(ppl.processLookupSystemFor("OR"), /buildingProgram|Construction Industries/);
});
await check("a CITED 'served by CID' answer puts an AHJ no seed names on CID (origin lookup), both tracks", () => {
  const p = project("Village of Example Pueblo", "Example Pueblo");
  const st = pp.stateTradeIssuerFor(p);
  assert.ok(st, "no state issuer from the cited lookup");
  assert.match(st!.value, CID);
  assert.equal(st!.origin, "lookup");
  assert.equal(st!.sourceUrl, CID_PAGE);
  for (const t of ["building", "electrical"]) {
    const ti = pp.trackIssuer(p, t);
    assert.match(ti.name, CID, t);
    assert.equal(ti.source, "lookup", t);
  }
  const a = permitStructureAnswer(p);
  assert.equal(a.structure, "separate");
  assert.match(a.prerequisites[0].step, /Example Pueblo/);
  // The seed's Los Lunas citation is never borrowed for another AHJ's local step.
  assert.ok(!a.prerequisites.some((x) => /loslunas/i.test(x.sourceUrl)), JSON.stringify(a.prerequisites));
});
await check("the lookup's zoning step is recorded as a cited prerequisite", async () => {
  await run("Village of Example Mesa", answer({
    buildingProgram: { value: "state", sourceUrl: CID_PAGE, quote: "The Village of Example Mesa is served by CID for building and electrical permits" },
    prerequisites: [{ value: "Zoning compliance review at the Village of Example Mesa Planning office", sourceUrl: TOWN_PAGE, quote: "A zoning compliance review by the Planning office is required before a CID permit" }],
  }));
  const lk = pp.permitProcessFor({ state: "NM", ahj: "Village of Example Mesa" })!;
  assert.ok(lk.prerequisites?.some((x) => /zoning/i.test(String(x.value)) && x.sourceUrl === TOWN_PAGE), JSON.stringify(lk.prerequisites));
  const a = permitStructureAnswer(project("Village of Example Mesa", "Example Mesa"));
  assert.ok(a.prerequisites.some((x) => x.sourceUrl === TOWN_PAGE), JSON.stringify(a.prerequisites));
});
await check("a cited 'own building program' answer outranks the seeded served list (Rio Communities)", async () => {
  assert.ok(pp.stateTradeIssuerFor(project("Rio Communities", "Rio Communities")), "seed precondition");
  await run("Rio Communities", answer({ buildingProgram: { value: "own", sourceUrl: TOWN_PAGE, quote: "Rio Communities now runs its own building program; the city building official issues permits" } }));
  assert.equal(pp.stateTradeIssuerFor(project("Rio Communities", "Rio Communities")), null);
});
await check("an UNCITED answer is not kept: unknown stays unknown", async () => {
  await run("Village of Example Arroyo", answer({ buildingProgram: { value: "state", sourceUrl: "", quote: "" } }));
  assert.equal(pp.permitProcessFor({ state: "NM", ahj: "Village of Example Arroyo" })?.buildingProgram?.value ?? null, null);
  assert.equal(pp.stateTradeIssuerFor(project("Village of Example Arroyo", "Example Arroyo")), null);
});
await check("a person's VERIFIED row beats both the seed and a later lookup (rule 3)", async () => {
  pp.savePermitProcessLookup(db, {
    state: "NM", ahj: "Bosque Farms", lookedUpAt: new Date().toISOString(), confidence: "verified",
    issuingAgency: { value: null, sourceUrl: "", quote: "", origin: "lookup" }, permitStructure: { value: null, sourceUrl: "", quote: "", origin: "lookup" }, permits: [],
    buildingProgram: { value: "own", sourceUrl: TOWN_PAGE, quote: "Bosque Farms issues its own building permits (verified by a person)", origin: "verified" },
  }, { verifiedBy: "reviewer@example.test" });
  const r = await run("Bosque Farms", answer({ buildingProgram: { value: "state", sourceUrl: CID_PAGE, quote: "Bosque Farms is served by CID for building permits" } }), true);
  assert.equal(r.saved, false);
  assert.equal(pp.stateTradeIssuerFor(project("Bosque Farms", "Bosque Farms")), null);
});
await check("rule 5: the CID information page is a citation, never a portal", async () => {
  assert.equal(isInformationalPageUrl(CID_PAGE), true);
  await run("Village of Example Llano", answer({
    buildingProgram: { value: "state", sourceUrl: CID_PAGE, quote: "CID is the building official for the Village of Example Llano" },
    permits: [{ discipline: "electrical", label: "Electrical", issuingAgency: { value: null }, portalUrl: { value: CID_PAGE, sourceUrl: CID_PAGE, quote: "Apply for permits with the Construction Industries Division" }, recordType: { value: null } }],
  }));
  const lk = pp.permitProcessFor({ state: "NM", ahj: "Village of Example Llano" })!;
  assert.equal(lk.permits.find((x) => x.discipline === "electrical")?.portalUrl.value ?? null, null);
});

// ── Item 3: the incorporated-status answer routes the zoning step ──────────────────────────
const UNINC = "Unincorporated county";
await check("Los Lunas, inside the village limits: the village reviews zoning", () => {
  const a = permitStructureAnswer(project("Village of Los Lunas", "Los Lunas", { incorporatedStatus: "Inside the incorporated limits of Los Lunas" }));
  assert.match(a.prerequisites[0].step, /at Village of Los Lunas/);
});
await check("Los Lunas, unincorporated county: the zoning step names Valencia County's office, not the village", () => {
  const a = permitStructureAnswer(project("Village of Los Lunas", "Los Lunas", { incorporatedStatus: UNINC }));
  const step = a.prerequisites[0].step;
  assert.match(step, /Valencia County Community Development/, step);
  assert.doesNotMatch(step, /at Village of Los Lunas/, step);
  assert.match(String(pp.stateTradeIssuerFor(project("Village of Los Lunas", "Los Lunas"))?.value), CID);
});
await check("a county AHJ answered unincorporated keeps its own office", () => {
  assert.match(permitStructureAnswer(project("Valencia County", "Los Lunas", { incorporatedStatus: UNINC })).prerequisites[0].step, /at Valencia County/);
});
await check("an unlisted CID-served village with no county on file: never guessed, said so", () => {
  const step = permitStructureAnswer(project("Village of Example Pueblo", "Example Pueblo", { incorporatedStatus: UNINC })).prerequisites[0].step;
  assert.match(step, /county/i);
  assert.match(step, /not on file/i, step);
  assert.doesNotMatch(step, /at Village of Example Pueblo/, step);
});
await check("the lookup's cited county office answers when the seed has none", async () => {
  await run("Village of Example Vado", answer({
    buildingProgram: { value: "state", sourceUrl: CID_PAGE, quote: "CID is the building official for the Village of Example Vado" },
    unincorporatedZoning: { value: "Example County Planning and Zoning", sourceUrl: TOWN_PAGE, quote: "Addresses outside village limits are reviewed by Example County Planning and Zoning" },
  }));
  const step = permitStructureAnswer(project("Village of Example Vado", "Example Vado", { incorporatedStatus: UNINC })).prerequisites[0].step;
  assert.match(step, /Example County Planning and Zoning/, step);
});
await check("Albuquerque control: no state issuer, no zoning step, whatever the answer", () => {
  const a = permitStructureAnswer(project("Albuquerque", "Albuquerque", { incorporatedStatus: UNINC }));
  assert.equal(pp.stateTradeIssuerFor(project("Albuquerque", "Albuquerque")), null);
  assert.equal(a.prerequisites.length, 0);
});
await check("addendum: the BUILDING seed's quote no longer claims solar scopes (that was the electrical form)", () => {
  const forms = pp.STATE_PERMIT_RULES.NM.stateTradeIssuer!.issuerForms!;
  assert.doesNotMatch(forms.find((f) => f.track === "building")!.quote, /Solar is among/);
  assert.match(forms.find((f) => f.track === "electrical")!.quote, /Solar is among/);
});

if (failures) { console.error(`\n${failures} NM lookup/CID check(s) FAILED.`); process.exit(1); }
console.log("\nAll NM lookup/CID checks passed.");
process.exit(0);
