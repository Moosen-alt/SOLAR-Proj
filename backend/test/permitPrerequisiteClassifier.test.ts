// #204 — WHAT COUNTS AS A PREREQUISITE. A city's "After the permit is approved and building permit is
// issued we will provide you a digital copy of the approved plans" was stored three times (one from
// its BASEMENT permit page) as "Approval before the permit", and the Required document set panel
// told the operator "FIRST, at another office: …". Deterministic, no model call:
//   (e) MUST-EXCLUDE: the three post-issuance sentences give no prerequisite — not from the page
//       extractor, not through the classifier, not on the read of a seeded row already saved.
//   (p) MUST-PASS: a zoning approval before applying and an HOA letter before issuance are kept,
//       each with its source.
//   (d) two equivalent prerequisites from two pages render once, keeping both sources; two
//       different offices' approvals are never merged.
//   (v) a person's VERIFIED row reads as they verified it (hard rule 3).
// Synthetic agency (example-city.gov); no real homeowner data.
//
// Run: npx tsx backend/test/permitPrerequisiteClassifier.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prereq-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const cat = await import("../src/permitPlatformCatalog");
const pp = await import("../src/permitProcess");
const docs = await import("../src/applicationDocs");
const { classifyPrerequisites, pageIsOtherPermitType } = await import("../src/permitProcessPrerequisites");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   - ${name}`); } catch (e) { failed++; console.log(`FAIL - ${name}\n       ${(e as Error).message}`); }
}

const HOST = "https://www.example-city.gov";
const POST_ISSUANCE = [
  { url: `${HOST}/221/Additional-Building-Permit-Requirements`, title: "Additional Building Permit Requirements", s: "After The Permit Is Approved And Building Permit Is Issued We Will Provide You A Digital Copy Of The Approved Plans And Permit Documents For You To Print." },
  { url: `${HOST}/201/Building`, title: "Building", s: "After the permit is approved and the building permit is issued we will provide you a digital copy of the approved plans and permit documents." },
  { url: `${HOST}/225/Obtaining-a-Basement-Permit`, title: "Obtaining a Basement Permit", s: "After The Permit Is Approved And Building Permit Is Issued We Will Provide You A Digital Copy Of The Approved Plans And Permit Documents For You To Print and maintain onsite." },
];
const fact = (value: string, sourceUrl: string, quote = value) => ({ value, sourceUrl, quote, origin: "lookup" as const });
const STORED_BAD = POST_ISSUANCE.map((p) => fact(`Approval before the permit: ${p.s}`, p.url, p.s));
const ZONING = fact("Obtain zoning approval from the Planning Department before applying", `${HOST}/310/Planning`, "Obtain zoning approval from the Planning Department before applying.");
const HOA = fact("a recorded HOA approval letter is required before a permit is issued", `${HOST}/201/Building`, "A recorded HOA approval letter is required before a permit is issued.");
const ZONING_AGAIN = fact("Zoning approval from the Planning Department is required before you apply", `${HOST}/400/Solar-Permits`, "Zoning approval from the Planning Department is required before you apply.");

await check("(e1) MUST-EXCLUDE: the page extractor finds no prerequisite in the three post-issuance sentences", () => {
  for (const p of POST_ISSUANCE) {
    const page = { ok: true, finalUrl: p.url, title: p.title, text: `Building permits are reviewed by the Building Division. ${p.s} Inspections are scheduled online.` };
    const got = cat.extractPrerequisites(page);
    assert.deepEqual(got.map((g) => g.value), [], p.url);
  }
});

await check("(e2) MUST-EXCLUDE: the classifier drops all three as stored (\"Approval before the permit: After …\")", () => {
  assert.deepEqual(classifyPrerequisites(STORED_BAD), []);
});

await check("(e3) MUST-EXCLUDE: another permit type's page is never a source, whatever the sentence says", () => {
  const page = { ok: true, finalUrl: `${HOST}/225/Obtaining-a-Basement-Permit`, title: "Obtaining a Basement Permit", text: "Plan review approval from the Fire Marshal is required before the building permit is issued." };
  assert.deepEqual(cat.extractPrerequisites(page), []);
  assert.deepEqual(classifyPrerequisites([fact("Fire Marshal approval is required before the permit is issued", page.finalUrl)]), []);
  // The same sentence on the city's building page IS a step before issuance.
  assert.equal(cat.extractPrerequisites({ ...page, finalUrl: `${HOST}/201/Building`, title: "Building" }).length, 1);
});

await check("(e4) a step that only precedes the final inspection is not a prerequisite to filing", () => {
  assert.deepEqual(classifyPrerequisites([fact("Utility approval is required before final inspection", `${HOST}/201/Building`)]), []);
});

await check("(p1) MUST-PASS: zoning approval before applying and an HOA letter before issuance are kept, each with its source", () => {
  const got = classifyPrerequisites([...STORED_BAD, ZONING, HOA]);
  assert.deepEqual(got.map((g) => [g.value, g.sourceUrl]), [[ZONING.value, ZONING.sourceUrl], [HOA.value, HOA.sourceUrl]]);
  // A zoning SIGN-OFF is not a "sign" permit.
  assert.equal(classifyPrerequisites([fact("Zoning sign-off from the Planning Department is required before the permit is issued", `${HOST}/310/Planning`)]).length, 1);
});

await check("(d1) two equivalent prerequisites from two pages collapse into one keeping both sources; two offices never merge", () => {
  const got = classifyPrerequisites([ZONING, HOA, ZONING_AGAIN]);
  assert.equal(got.length, 2, JSON.stringify(got));
  assert.equal(got[0].sourceUrl, ZONING.sourceUrl);
  assert.deepEqual(got[0].alsoSourceUrls, [ZONING_AGAIN.sourceUrl]);
  const two = classifyPrerequisites([
    fact("Fire Department approval is required before the permit is issued", `${HOST}/a`),
    fact("Planning Department approval is required before the permit is issued", `${HOST}/b`),
  ]);
  assert.equal(two.length, 2);
});

const kept = (value: string, url = `${HOST}/201/Building`) => classifyPrerequisites([fact(value, url)]).length === 1;

await check("(r1) review: \"after <another office's> approval, apply\" IS a step before filing; after the permit's own approval it is not", () => {
  const page = (text: string) => ({ ok: true, finalUrl: `${HOST}/201/Building`, title: "Building", text });
  assert.equal(cat.extractPrerequisites(page("After plan review approval by the Fire Marshal, apply for the building permit online.")).length, 1, "extractor door");
  assert.ok(kept("After zoning approval, apply for the building permit."));
  assert.ok(kept("Once the Planning Department sign-off is received, submit the building permit application."));
  assert.ok(!kept("After the permit is approved, apply for inspections through the portal."));
  assert.ok(!kept("Once the permit is issued, file the inspection request online."));
});

await check("(r2) review: MUST-EXCLUDE \"prior to final inspection, submit / file …\" — a submit verb after issuance is not a filing step", () => {
  for (const v of [
    "Prior to final inspection, submit the signed interconnection agreement from the utility.",
    "Prior to final inspection, submit the as-built drawings to the Engineering Division.",
    "Prior to the final inspection you must file the completed load calculation with the utility.",
  ]) assert.ok(!kept(v), v);
  // "before applying" survives beside a later milestone in the same sentence.
  assert.ok(kept("Zoning approval is required before applying and again before final inspection."));
});

await check("(r3) review: another permit this job must obtain FIRST is kept; another permit type's own process is not", () => {
  assert.ok(kept("An encroachment permit from Public Works is required before the building permit is issued."));
  assert.ok(kept("Obtain a right-of-way permit from Public Works before applying."));
  assert.ok(!kept("A basement permit requires a structural plan review before it is issued."));
  assert.ok(!kept("Fence permits must be submitted to the Zoning Office before construction begins."));
});

await check("(r4) review: a general building page that only LISTS example permit types is still a source", () => {
  assert.equal(pageIsOtherPermitType(`${HOST}/201/Building`, "Building Permits: decks, fences, sheds and more"), false);
  assert.equal(pageIsOtherPermitType(`${HOST}/225/Obtaining-a-Basement-Permit`, "Obtaining a Basement Permit"), true);
});

// The registry read of a SEEDED row saved before this fix (the stored rows of the issue).
const save = (ahj: string, prerequisites: unknown[], verifiedBy?: string) => pp.savePermitProcessLookup(db, {
  state: "UT", ahj, lookedUpAt: new Date().toISOString(),
  issuingAgency: fact(ahj, `${HOST}/201/Building`, `${ahj} Building Division issues building permits`),
  permitStructure: fact("combo", `${HOST}/201/Building`, "one combined building permit includes electrical"),
  permits: [], notes: [], prerequisites,
  ...(verifiedBy ? { confidence: "verified" as const } : {}),
} as never, verifiedBy ? { verifiedBy } : {});
const project = (ahj: string) => ({ id: `p-${ahj}`, ahj, state: "UT", city: ahj.replace(/^City of /, ""), parserSnapshot: {} }) as never;

await check("(e5+d2) a seeded row's stored prerequisites read through the classifier: the panel says FIRST only the real steps, once each", () => {
  assert.equal(save("City of Examplefield", [...STORED_BAD, ZONING, HOA, ZONING_AGAIN]).saved, true);
  const a = docs.permitStructureAnswer(project("City of Examplefield"));
  assert.deepEqual(a.prerequisites.map((p) => p.step), [ZONING.value, HOA.value]);
  assert.deepEqual(a.prerequisites[0].alsoSourceUrls, [ZONING_AGAIN.sourceUrl]);
  const sentence = docs.permitStructureSentence(a);
  assert.ok(!/After the permit is approved/i.test(sentence), sentence);
  assert.equal(sentence.match(/zoning approval/gi)?.length, 1, sentence);
});

await check("(v1) hard rule 3: a person's VERIFIED row reads exactly as verified", () => {
  assert.equal(save("City of Verifiedton", [ZONING, ZONING_AGAIN], "operator@example.com").saved, true);
  const lk = pp.getPermitProcessLookup(db, "UT", "City of Verifiedton");
  assert.equal(lk?.confidence, "verified");
  assert.equal(lk?.prerequisites?.length, 2);
});

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
process.exit(0);
