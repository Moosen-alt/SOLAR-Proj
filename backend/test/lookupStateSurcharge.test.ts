// THE STATE SURCHARGE THE AGENCY'S OWN SOURCE STATES IS PRICED; ONE NOBODY PRICED IS SAID (close M3).
//
// Measured on the Jefferson job: the quote was $161.25 (county $67.25 structural + $94 electrical)
// against a real $180.60 ($75.32 + $105.28 — both carry Oregon's 12% state surcharge). The per-job
// lookup had returned the surcharge line ($11.28) quoted from the county's own electrical form;
// applyLookupFees dropped it, STATE_PERMIT_RULES.OR.surcharge was read nowhere, and the quote's
// basis never said a surcharge was missing — on the item the operator said "look to be off".
//
// The lookup answer is stubbed data written through the REAL lookup writer; fees land through the
// real applyLookupFees → saveFeeSchedule, and the quote is the real buildPaymentQuote on a project
// created through the real createProject. Fictional jurisdictions, invented figures.
//
// KILL TESTS (each disabled by hand and seen red):
//   K1 applyLookupFees: never pass citedStateSurcharge                  → (s1), (q1) fail.
//   K2 citedStateSurcharge: accept a percentage from the basis/lines    → (s2) fails.
//   K3 citedStateSurcharge: drop the state-maximum / consistency checks → (s3) fails.
//   K4 buildPaymentQuote: no stateSurchargeNotice                       → (q1) fails.
//   K5 feeBracketFields.evaluatorAgrees: compare the surcharged line total → (b1) fails.
//
// Run: npx tsx backend/test/lookupStateSurcharge.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { CitedFact, PermitFeeAnswer } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("lookup-state-surcharge");
const { db, repo } = fx;
const pp = await import("../src/permitProcess");
const ppl = await import("../src/permitProcessLookup");
const fees = await import("../src/feeSchedules");
const quotes = await import("../src/submissionFees");

const FEES = "https://docs.example-countyfees.org/2026-fee-schedule.pdf";
const FORM = "https://docs.example-countyfees.org/electrical-application.pdf";
const COUNTY_PAGE = "https://www.co.example-county.or.us/building";
const AHJ = "City of Hollowmere";
const AGENCY = "Brightwater County";

const STRUCTURAL_FEE: CitedFact<PermitFeeAnswer> = {
  // The basis PROSE mentions a surcharge; the quoted words do not — never enough to apply one.
  value: { amountUsd: 67.25, basis: "flat fee for prescriptive-path PV; a 12% State Surcharge is added as set by the State", lines: [{ label: "Solar PV installed using the prescriptive path", amountUsd: 67.25 }] },
  sourceUrl: FEES, quote: "Solar Photovoltaic Systems installed using the prescriptive path $67.25 (includes application fee and one inspection)", origin: "lookup",
};
const ELECTRICAL_FEE: CitedFact<PermitFeeAnswer> = {
  value: {
    amountUsd: 105.28, basis: "tier 5.01 to 15 kVA plus the 12% state surcharge",
    lines: [{ label: "Solar generation systems, 5.01 to 15 kva", amountUsd: 94 }, { label: "State surcharge (12% of permit fee)", amountUsd: 11.28 }],
    tiers: [{ maxKva: 5, amountUsd: 79, label: "5 kva or less" }, { maxKva: 15, amountUsd: 94, label: "5.01 to 15 kva" }, { maxKva: 25, amountUsd: 156, label: "15.01 to 25 kva" }],
  } as PermitFeeAnswer,
  sourceUrl: FORM, quote: "SOLAR GENERATION SYSTEMS 5 kva or less $79.00 5.01 to 15 kva $94.00 15.01 to 25 kva $156.00 ... State surcharge (12% of permit fee)", origin: "lookup",
};
const none = { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "not searched" };
const cite = (value: string): CitedFact<string> => ({ value, sourceUrl: COUNTY_PAGE, quote: `${value} issues building and electrical permits for ${AHJ}`, origin: "lookup" });
const saved = pp.savePermitProcessLookup(db, {
  state: "OR", ahj: AHJ, lookedUpAt: new Date().toISOString(),
  issuingAgency: cite(AGENCY),
  permitStructure: { value: "separate", sourceUrl: COUNTY_PAGE, quote: "a structural permit and a separate electrical permit", origin: "lookup" },
  permits: [
    { discipline: "structural", label: "Residential Structural", issuingAgency: cite(AGENCY), portalUrl: none, recordType: none, documents: none, fee: STRUCTURAL_FEE },
    { discipline: "electrical", label: "Residential Electrical", issuingAgency: cite(AGENCY), portalUrl: none, recordType: none, documents: none, fee: ELECTRICAL_FEE },
  ],
} as never);
assert.ok(saved.saved && saved.lookup, saved.reason);
ppl.applyLookupFees(db, saved.lookup!);

const projectId = fx.newProject({ ahj: AHJ, city: "Hollowmere", zip: "97352", utility: "Pacific Power", dcKw: "15.9", acKw: "12.9", exportKw: "12.9" });
const projectRow = repo.getProjectDetail(db, projectId).project;

await check("(s1) MUST-PASS: the surcharge the county's own quoted form prints lands on its electrical tiers and is priced ($94 + 12% = $105.28)", () => {
  const sched = fees.findFeeScheduleForProject(db, projectRow, "permit", "electrical")!;
  assert.ok(sched, "the county's electrical schedule is reachable");
  assert.ok(sched.brackets.every((b) => b.stateSurcharge?.percent === 12), JSON.stringify(sched.brackets.map((b) => b.stateSurcharge ?? null)));
  const line = fees.feeForProject(db, projectRow, "permit")!.lines.find((l) => l.discipline === "electrical")!;
  assert.equal(line.feeUsd, 105.28, `electrical line: ${line.feeUsd}`);
  assert.equal(line.stateSurchargeUsd, 11.28);
});

await check("(s2) MUST-EXCLUDE: a surcharge only the basis prose mentions is never applied (the structural quote prints none)", () => {
  const sched = fees.findFeeScheduleForProject(db, projectRow, "permit", "structural")!;
  assert.ok(sched.brackets.every((b) => !b.stateSurcharge), JSON.stringify(sched.brackets));
  const line = fees.feeForProject(db, projectRow, "permit")!.lines.find((l) => l.discipline === "structural")!;
  assert.equal(line.feeUsd, 67.25);
  assert.equal(ppl.citedStateSurcharge("OR", STRUCTURAL_FEE), null);
});

await check("(s3) MUST-EXCLUDE: over the state's cited maximum, an inconsistent surcharge line, or a state with no surcharge rule → not applied", () => {
  assert.deepEqual(ppl.citedStateSurcharge("OR", ELECTRICAL_FEE)?.percent, 12, "MUST-PASS control");
  const over = { ...ELECTRICAL_FEE, quote: ELECTRICAL_FEE.quote.replace("12%", "15%"), value: { ...ELECTRICAL_FEE.value!, lines: [ELECTRICAL_FEE.value!.lines[0], { label: "State surcharge (15% of permit fee)", amountUsd: 14.1 }] } };
  assert.equal(ppl.citedStateSurcharge("OR", over), null, "15% exceeds ORS 455.210's 12% maximum");
  const inconsistent = { ...ELECTRICAL_FEE, value: { ...ELECTRICAL_FEE.value!, lines: [ELECTRICAL_FEE.value!.lines[0], { label: "State surcharge", amountUsd: 30 }] } };
  assert.equal(ppl.citedStateSurcharge("OR", inconsistent), null, "$30 is not 12% of $94");
  assert.equal(ppl.citedStateSurcharge("WA", ELECTRICAL_FEE), null, "no cited surcharge rule for WA");
});

await check("(b1) MUST-PASS: a surcharged tier still computes this project's fee-tier quantity keys (the evaluator veto compares the bracket before its surcharge)", async () => {
  const { feeBracketQuantityFields } = await import("../src/feeBracketFields");
  const keys = Object.fromEntries(Object.entries(feeBracketQuantityFields(db, projectRow)).filter(([k]) => k.startsWith("feeBracketQuantity:")));
  assert.deepEqual(keys, { "feeBracketQuantity:0-5": "0", "feeBracketQuantity:5.01-15": "1", "feeBracketQuantity:15.01-25": "0" }, JSON.stringify(keys));
});

const quote = quotes.buildPaymentQuote(db, projectRow, "permit");

await check("(q1) MUST-PASS: the quote prices the stated surcharge and SAYS which permit's surcharge is not included", () => {
  assert.equal(quote.permitFeeUsd, 172.53, `permit fee ${quote.permitFeeUsd} — ${quote.permitFeeBasis}`);
  assert.match(quote.permitFeeBasis, /PLUS the state surcharge on the Brightwater County structural permit \(up to 12% of the permit fee/i, quote.permitFeeBasis);
  assert.match(quote.permitFeeBasis, /NOT included in this amount/);
});
await check("(q2) MUST-EXCLUDE: a permit whose surcharge IS priced is not named as missing; outside a surcharge state nothing is added", () => {
  assert.ok(!/surcharge on the [^.]*electrical/i.test(quote.permitFeeBasis), quote.permitFeeBasis);
  assert.equal(quotes.stateSurchargeNotice("WA", ["Some County structural"]), "");
  assert.equal(quotes.stateSurchargeNotice("OR", []), "");
});

finish("lookup-state-surcharge");
