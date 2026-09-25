// THE RESIDENTIAL-CODE CITATION NAMES THE JURISDICTION'S OWN RESIDENTIAL CODE.
//
// residentialFamily() knew only ORSC and IRC, so a California (CRC) or Florida (FBC-R) finding —
// the manufactured-home BLOCKER, the UL-listing callout, the anchor-spacing findings — cited
// "IRC R301.1.3" as if the IRC were the adopted code. Now the family is the adopted code built on
// the IRC (a state code filed under the model token is read from its title), and a section is cited
// under it only where the numbering is KNOWN to match; anywhere else the citation keeps the IRC's
// number and says the state code's section is unmapped. No section number is invented.
//
// Fixtures are synthetic. No LLM, no network. Run: npx tsx backend/test/residentialCodeFamily.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { CodeReference, JurisdictionCodeProfile, ProjectRecord } from "../../shared/src/types";
import { buildCodeContext, type EffectiveCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
import { residentialCodeRef } from "../src/designCriteria";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const ctxOf = (state: string, ahj: string, adoptedCodes: JurisdictionCodeProfile["adoptedCodes"]): EffectiveCodeContext =>
  buildCodeContext(state, ahj, {
    key: `${state.toLowerCase()}|${ahj.toLowerCase()}|unknown`, state, ahj, confidence: "seeded", adoptedCodes,
    amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  });
const CA = ctxOf("CA", "City of Testvale", [{ code: "CRC", edition: "2025", title: "California Residential Code (Title 24 Part 2.5)" }]);
// The research seeder's shape: the state code under the model token, named in the title.
const CA_FILED_AS_IRC = ctxOf("CA", "City of Testvale", [{ code: "IRC", edition: "2022", title: "2022 California Residential Code (CRC), Title 24 Part 2.5 — state-adopted, based on the 2021 IRC with California amendments" }]);
const FL = ctxOf("FL", "Testee County", [{ code: "FBC-R", edition: "2023", title: "Florida Building Code, Residential — 8th Edition" }]);
const OR = ctxOf("OR", "City of Testport", [{ code: "ORSC", edition: "2023" }, { code: "IRC", edition: "2021" }]);
const IL = ctxOf("IL", "Testfield", [{ code: "IRC", edition: "2021" }]);
const cite = (ctx: EffectiveCodeContext, section: string): CodeReference => residentialCodeRef(ctx, section, "Title", "Rule note.");

console.log("1. the citation's code family and section");

check("MUST-PASS: CA cites the CRC where the section is known to match (R301.1.3, R324.4.1), also when filed under the IRC token", () => {
  for (const ctx of [CA, CA_FILED_AS_IRC]) {
    for (const section of ["R301.1.3", "R324.4.1"]) {
      const r = cite(ctx, section);
      assert.match(r.code, /^\d{4} CRC$/, `${section}: ${r.code}`);
      assert.equal(r.section, section);
    }
  }
  assert.equal(cite(CA, "R301.1.3").code, "2025 CRC");
  assert.equal(cite(CA_FILED_AS_IRC, "R301.1.3").code, "2022 CRC");
});
check("MUST-PASS: FL cites the FBC-R where the section is known to match (R301.1.3, R324.3.1)", () => {
  for (const section of ["R301.1.3", "R324.3.1"]) {
    const r = cite(FL, section);
    assert.equal(r.code, "2023 FBC-R", section);
    assert.equal(r.section, section);
  }
});
check("MUST-EXCLUDE: an UNMAPPED section is never cited under the state code, and says it is the IRC's number", () => {
  for (const [ctx, family, section] of [[CA, "CRC", "R324.3.1"], [FL, "FBC-R", "R324.4.1"]] as const) {
    const r = cite(ctx, section);
    assert.equal(r.code, "IRC", `${family} ${section}: ${r.code}`);
    assert.equal(r.section, section, "the IRC's own number, nothing invented");
    assert.match(r.note, new RegExp(`The ${family} section matching IRC ${section.replace(/\./g, "\\.")} is not mapped here`));
    assert.match(r.adoptionScope, new RegExp(`adopts the ${family}, built on the IRC`));
    assert.match(r.note, /Rule note\./, "the rule's own note is kept");
  }
});
check("MUST-PASS: Oregon keeps ORSC (every section), a Coos-Bay-shaped IRC-token ORSC row reads as ORSC, IRC states keep IRC", () => {
  for (const section of ["R301.1.3", "R324.3.1", "R324.4.1"]) {
    assert.equal(cite(OR, section).code, "2023 ORSC", section);
    assert.equal(cite(IL, section).code, "2021 IRC", section);
  }
  const coos = ctxOf("OR", "City of Testbay", [{ code: "IRC", edition: "2023", title: "2023 Oregon Residential Specialty Code (ORSC) — statewide amended adoption of the 2021 International Residential Code" }]);
  assert.equal(cite(coos, "R324.4.1").code, "2023 ORSC", "there is no 2023 IRC; the row's code is the ORSC");
});

console.log("\n2. through the rules: the manufactured-home BLOCKER's citation");

const project = (state: string, ahj: string): ProjectRecord => ({
  id: "residential-family-test", state, ahj, utility: "Test Power", homeownerName: "Test Owner", projectAddress: "1 Test St",
  interconnectionMethod: "Load-side breaker",
  parserSnapshot: { mounting: "Roof mount", permitPath: "PRESCRIPTIVE", structureType: "manufactured" },
} as unknown as ProjectRecord);
const manufacturedRef = (state: string, ahj: string, ctx: EffectiveCodeContext): CodeReference => {
  const f = evaluateDesignCodeFindings(project(state, ahj), null, ctx, [], []).find((x) => x.id === "city.struct.manufactured-home-prescriptive");
  assert.ok(f, "the manufactured-home finding must fire");
  return f!.codeReferences[0];
};
check("MUST-PASS: CA -> CRC R301.1.3, FL -> FBC-R R301.1.3, OR -> ORSC R301.1.3 — never 'IRC R301.1.3' outside an IRC state", () => {
  assert.deepEqual([manufacturedRef("CA", "City of Testvale", CA).code, manufacturedRef("CA", "City of Testvale", CA).section], ["2025 CRC", "R301.1.3"]);
  assert.deepEqual([manufacturedRef("FL", "Testee County", FL).code, manufacturedRef("FL", "Testee County", FL).section], ["2023 FBC-R", "R301.1.3"]);
  assert.deepEqual([manufacturedRef("OR", "City of Testport", OR).code, manufacturedRef("OR", "City of Testport", OR).section], ["2023 ORSC", "R301.1.3"]);
  assert.deepEqual([manufacturedRef("IL", "Testfield", IL).code, manufacturedRef("IL", "Testfield", IL).section], ["2021 IRC", "R301.1.3"]);
});

console.log("\n3. through the rules: the roof-loads citation (roofLoadsRef) — snow-inv item 4");

// At 2dc7527 roofLoadsRef was cite("IRC", roofLoads): a Coos-Bay-shaped row (the ORSC filed under the
// IRC token, edition 2023) printed "2023 IRC R324.4.1" — there is no 2023 IRC — and CA / FL, with no
// IRC entry, fell back to the legacy "IRC / ORSC" label.
const roofRef = (state: string, ahj: string, ctx: EffectiveCodeContext): CodeReference => {
  const f = evaluateDesignCodeFindings(project(state, ahj), null, ctx, [], []).find((x) => x.id === "city.struct.framing-missing");
  assert.ok(f, "the framing-missing finding must fire (no framing in the package)");
  const r = f!.codeReferences.find((c) => c.section === "R324.4.1");
  assert.ok(r, `no R324.4.1 reference: ${JSON.stringify(f!.codeReferences.map((c) => `${c.code} ${c.section}`))}`);
  return r!;
};
check("MUST-PASS: the roof-loads reference cites the jurisdiction's residential code — ORSC (also filed as IRC), CRC, IRC", () => {
  const coos = ctxOf("OR", "City of Testbay", [{ code: "IRC", edition: "2023", title: "2023 Oregon Residential Specialty Code (ORSC) — statewide amended adoption of the 2021 International Residential Code" }]);
  assert.equal(roofRef("OR", "City of Testbay", coos).code, "2023 ORSC", "never '2023 IRC'");
  assert.equal(roofRef("OR", "City of Testport", OR).code, "2023 ORSC");
  assert.equal(roofRef("CA", "City of Testvale", CA).code, "2025 CRC", "R324.4.1 is a mapped CRC section");
  assert.equal(roofRef("CA", "City of Testvale", CA_FILED_AS_IRC).code, "2022 CRC");
  assert.equal(roofRef("IL", "Testfield", IL).code, "2021 IRC");
});
check("MUST-EXCLUDE: FL's R324.4.1 is not mapped to the FBC-R — the IRC's number with the unmapped note, never 'IRC / ORSC' or an invented FBC-R section", () => {
  const r = roofRef("FL", "Testee County", FL);
  assert.equal(r.code, "IRC");
  assert.match(r.note, /The FBC-R section matching IRC R324\.4\.1 is not mapped here/);
  assert.match(r.note, /dead load, live load, and attachment assumptions/, "the rule's own note is kept");
  for (const ctx of [CA, FL, OR, IL]) assert.notEqual(roofRef(ctx.state, ctx.ahj, ctx).code, "IRC / ORSC");
});

if (failures) {
  console.error(`\n${failures} residential-code-family check(s) FAILED`);
  process.exit(1);
}
console.log("\nall residential-code-family checks passed");
