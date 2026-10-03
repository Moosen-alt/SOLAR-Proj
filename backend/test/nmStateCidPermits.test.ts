// NEW MEXICO: A JURISDICTION WITHOUT ITS OWN BUILDING DEPARTMENT ONLY REVIEWS ZONING; THE STATE
// CONSTRUCTION INDUSTRIES DIVISION (CID) ISSUES THE BUILDING + ELECTRICAL PERMITS (issue #32).
// A manufactured home's permits come from the Manufactured Housing Division (MHD) instead. A
// full-service NM city (Albuquerque) keeps issuing its own. Synthetic addresses, no network.
//   npx tsx backend/test/nmStateCidPermits.test.ts
import assert from "node:assert/strict";
import type { ProjectRecord } from "../../shared/src/types";
import { requiredTracks } from "../src/submittalTracks";
import { issuingAgencyFor, stateTradeIssuerFor, projectForTrack, trackIssuer } from "../src/permitProcess";
import { describePermitType, findApplicationProfile, permitStructureAnswer, permitStructureSentence } from "../src/applicationDocs";
import { formFactQuestions } from "../src/bcdChecklistFacts";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const project = (ahj: string, city: string, snapshot: Record<string, unknown> = {}): ProjectRecord =>
  ({
    id: "p-nm", homeownerName: "Example Owner", projectAddress: "100 Example Rd", city, state: "NM", zip: "87000", ahj,
    utility: "Example Utility", parserSnapshot: { projectDescriptionText: "Install roof-mounted PV system, 12 modules.", ...snapshot },
  }) as unknown as ProjectRecord;

const CID = /Construction Industries Division/;
const MHD = /Manufactured Housing Division/;

const valencia = project("Valencia County", "Los Lunas");
check("unincorporated Valencia County: separate building + electrical tracks", () => {
  const tracks = requiredTracks(valencia);
  assert.ok(tracks.includes("building") && tracks.includes("electrical") && !tracks.includes("combo"), JSON.stringify(tracks));
});
check("unincorporated Valencia County: NMCID issues both trade permits (state rule, seeded — never verified)", () => {
  for (const t of ["building", "electrical"]) {
    const issuer = trackIssuer(valencia, t);
    assert.match(issuer.name, CID, `${t}: ${JSON.stringify(issuer)}`);
    assert.equal(issuer.source, "state_rule");
    assert.match(String(issuer.sourceUrl), /^https:\/\/www\.rld\.nm\.gov\//);
    const fact = issuingAgencyFor(valencia, t);
    assert.match(String(fact?.value), CID);
    assert.equal(fact?.origin, "state_rule");
  }
  assert.equal(projectForTrack(valencia, "building").ahj, trackIssuer(valencia, "building").name);
});
check("unincorporated Valencia County: the county's zoning/site review comes FIRST, then CID", () => {
  const a = permitStructureAnswer(valencia);
  assert.equal(a.structure, "separate");
  assert.equal(a.level, "state_rule");
  assert.equal(a.prerequisites.length, 1, JSON.stringify(a.prerequisites));
  assert.match(a.prerequisites[0].step, /Valencia County/);
  assert.match(a.prerequisites[0].step, /zoning/i);
  const sentence = permitStructureSentence(a);
  assert.match(sentence, CID, sentence);
  assert.ok(sentence.indexOf("FIRST") > 0 && /Valencia County/.test(sentence.slice(sentence.indexOf("FIRST"))), sentence);
  const callout = describePermitType(findApplicationProfile(valencia), { answer: a }).callout;
  assert.match(callout, CID, callout);
});
check("Village of Los Lunas: the village reviews zoning, CID issues the permits", () => {
  const p = project("Village of Los Lunas", "Los Lunas");
  assert.match(trackIssuer(p, "electrical").name, CID);
  assert.match(permitStructureAnswer(p).prerequisites[0]?.step ?? "", /Los Lunas/);
});
check("incorporated vs unincorporated is ASKED (never guessed) until answered", () => {
  const p = project("Village of Los Lunas", "Los Lunas");
  const q = formFactQuestions(p, { checklistApplies: false, issuingAgency: issuingAgencyFor(p, "building")?.value }).find((x) => x.key === "incorporatedStatus");
  assert.ok(q, "no incorporated/unincorporated question");
  assert.match(q!.label, /incorporated/i);
  assert.ok(q!.options.length >= 2);
  const answered = project("Village of Los Lunas", "Los Lunas", { incorporatedStatus: q!.options[0] });
  assert.ok(!formFactQuestions(answered, { checklistApplies: false }).some((x) => x.key === "incorporatedStatus"));
});
check("a manufactured home on a CID-served lot: MHD issues the permits, and says so", () => {
  const mh = project("Valencia County", "Los Lunas", { structureTypeOverride: "manufactured" });
  for (const t of ["building", "electrical"]) assert.match(trackIssuer(mh, t).name, MHD, t);
  assert.match(String(stateTradeIssuerFor(mh)?.quote), /manufactured/i);
  assert.match(permitStructureSentence(permitStructureAnswer(mh)), MHD);
});
check("Albuquerque (full-service city): unchanged — the city issues, no state rule, no prerequisite", () => {
  const abq = project("Albuquerque", "Albuquerque");
  assert.equal(stateTradeIssuerFor(abq), null);
  assert.equal(trackIssuer(abq, "building").source, "project");
  assert.equal(trackIssuer(abq, "building").name, "Albuquerque");
  assert.equal(issuingAgencyFor(abq, "electrical"), null);
  const a = permitStructureAnswer(abq);
  assert.notEqual(a.level, "state_rule");
  assert.equal(a.prerequisites.length, 0);
  assert.ok(!formFactQuestions(abq, { checklistApplies: false }).some((x) => x.key === "incorporatedStatus"));
});
check("an NM AHJ no source names as state-served is never guessed onto CID (unknown stays unknown)", () => {
  const p = project("City of Example Mesa", "Example Mesa");
  assert.equal(stateTradeIssuerFor(p), null);
  assert.equal(trackIssuer(p, "building").source, "project");
  assert.equal(permitStructureAnswer(p).structure, "unknown");
  assert.ok(!formFactQuestions(p, { checklistApplies: false }).some((x) => x.key === "incorporatedStatus"));
});
check("City of Albuquerque spelling is the same full-service city", () => {
  assert.equal(stateTradeIssuerFor(project("City of Albuquerque", "Albuquerque")), null);
});
check("an operator's own per-track issuer still outranks the state rule", () => {
  const p = project("Valencia County", "Los Lunas", { trackIssuerElectrical: "Valencia County" });
  assert.equal(trackIssuer(p, "electrical").source, "operator");
  assert.match(trackIssuer(p, "building").name, CID);
});
check("another state is untouched", () => {
  const p = { ...valencia, state: "OR" } as ProjectRecord;
  assert.equal(stateTradeIssuerFor(p), null);
  assert.equal(trackIssuer(p, "building").source, "project");
});

if (failures) { console.error(`\n${failures} NM state-CID check(s) FAILED.`); process.exit(1); }
console.log("\nAll NM state-CID permit checks passed.");
process.exit(0);
