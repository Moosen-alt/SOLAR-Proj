// THE PER-JOB PERMIT-PROCESS LOOKUP (B11) — cited or NOT FOUND, never a guess; survives an aborted
// part, a truncated answer and a help page offered as a portal; lands seeded and is USED (tracks,
// agency, fees through the fee write path with the county delegation).
//
// The model is stubbed (webLookup returns what a grounded search would); everything after it is
// the real code and the real write paths. The fictional "City of Alderbrook" stands in for any AHJ
// the product has never seen.
//
// KILL TESTS (verified red by hand before the fix landed):
//   K1 acceptCited: drop the quote-supports-value check        → (x2), (x5) fail.
//   K2 parseProcessPart: drop the information-page refusal     → (x1) fails.
//   K3 runPermitProcessLookup: keep an ungrounded answer       → (x3) fails.
//   K4 applyLookupFees: no delegation row                      → (m3) fails.
//   K5 feeSchedules fuzzy fallback: bridge city to county      → (m4) fails.
//
// Run: npx tsx backend/test/permitProcessLookup.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppl-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const ppl = await import("../src/permitProcessLookup");
const pp = await import("../src/permitProcess");
const fees = await import("../src/feeSchedules");
const tracks = await import("../src/submittalTracks");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const COUNTY = "https://www.co.example-county.or.us/building/solar";
const FEES = "https://docs.example-countyfees.org/2026-fee-schedule.pdf";
const ACA = "https://aca-oregon.accela.com/oregon/";
const processAnswer = (over: Record<string, unknown> = {}) => JSON.stringify({
  issuingAgency: { value: "Marion County", sourceUrl: COUNTY, quote: "Marion County Building Inspection serves unincorporated areas and cities that do not have building inspection programs, including Alderbrook" },
  permitStructure: { value: "separate", sourceUrl: COUNTY, quote: "Solar installations require a structural permit and a separate electrical permit" },
  permits: [
    { discipline: "structural", label: "Residential Structural", portalUrl: { value: ACA, sourceUrl: COUNTY, quote: "Apply online through Oregon ePermitting (aca-oregon.accela.com)" }, recordType: { value: "Residential Structural", sourceUrl: COUNTY, quote: "Select record type Residential Structural for rooftop solar" } },
    { discipline: "electrical", label: "Residential Electrical", portalUrl: { value: ACA, sourceUrl: COUNTY, quote: "Apply online through Oregon ePermitting (aca-oregon.accela.com)" }, recordType: { value: "Residential Electrical", sourceUrl: COUNTY, quote: "Electrical: record type Residential Electrical" } },
  ],
  ...over,
});
const feesAnswer = (over: Record<string, unknown> = {}) => JSON.stringify({
  permits: [
    { discipline: "structural", documents: { value: ["plan set", "prescriptive solar checklist"], sourceUrl: COUNTY, quote: "Submit a plan set and the prescriptive solar checklist" },
      fee: { value: { amountUsd: 67.25, basis: "flat fee for prescriptive-path PV", lines: [{ label: "Prescriptive solar PV", amountUsd: 67.25 }] }, sourceUrl: FEES, quote: "Solar Photovoltaic Systems installed using the prescriptive path $67.25 (includes application fee and one inspection)" } },
    { discipline: "electrical", documents: { value: ["plan set", "module and inverter specifications"], sourceUrl: COUNTY, quote: "Electrical: plan set with module and inverter specifications" },
      fee: { value: { amountUsd: 94, basis: "tier 5.01-15 kVA", lines: [{ label: "5.01 to 15 kva", amountUsd: 94 }], tiers: [{ maxKva: 5, amountUsd: 79, label: "5 kva or less" }, { maxKva: 15, amountUsd: 94, label: "5.01 to 15 kva" }, { maxKva: 25, amountUsd: 156, label: "15.01 to 25 kva" }] }, sourceUrl: FEES, quote: "5 kva or less $79.00 5.01 to 15 kva $94.00 15.01 to 25 kva $156.00" } },
  ],
  ...over,
});
const grounded = (text: string, extra: Partial<WebLookupResult> = {}): WebLookupResult => ({ text, groundedSearches: 3, stopReason: "end_turn", resultUrls: [COUNTY, FEES, ACA], pagesRead: 2, ...extra });
const stub = (p1: WebLookupResult, p2: WebLookupResult) => ({
  webLookup: async (i: { label: string }) => (/process$/.test(i.label) ? p1 : p2),
});
const project = (ahj: string) => ({ id: "x", clientId: null, state: "OR", ahj, city: ahj, utility: "Pacific Power", parserSnapshot: {} }) as never;

await check("(m1) MUST-PASS: a grounded, cited answer lands seeded with every value and its source", async () => {
  const run = await ppl.runPermitProcessLookup(db, stub(grounded(processAnswer()), grounded(feesAnswer())), { state: "OR", ahj: "City of Alderbrook", dcKw: "15.91", acKw: "12.9" });
  assert.equal(run.saved, true, run.reason);
  const lk = pp.permitProcessFor(project("City of Alderbrook"))!;
  assert.equal(lk.confidence, "seeded");
  assert.equal(lk.issuingAgency.value, "Marion County");
  assert.equal(lk.permitStructure.value, "separate");
  const str = lk.permits.find((p) => p.discipline === "structural")!;
  assert.equal(str.recordType.value, "Residential Structural");
  assert.equal(str.portalUrl.value, ACA);
  assert.equal(str.fee.value?.amountUsd, 67.25);
  assert.deepEqual(str.documents.value, ["plan set", "prescriptive solar checklist"]);
});
await check("(m2) the answer is USED: agency per track, cited structure", () => {
  assert.equal(pp.issuingAgencyFor(project("City of Alderbrook"), "building")?.value, "Marion County");
  assert.deepEqual(tracks.requiredTracks(project("City of Alderbrook")), ["nem", "building", "electrical"]);
});
await check("(m3) MUST-PASS: the fees land through the fee write path — the city DELEGATES to the county, which prices each permit", () => {
  const s = fees.findFeeScheduleForProject(db, { state: "OR", ahj: "City of Alderbrook", utility: "" }, "permit", "structural");
  assert.ok(s, "no structural schedule reachable for the city");
  assert.match(s!.ahj, /Marion County/);
  assert.equal(s!.brackets[0]?.feeUsd, 67.25);
  const e = fees.findFeeScheduleForProject(db, { state: "OR", ahj: "City of Alderbrook", utility: "" }, "permit", "electrical");
  assert.equal(e?.basis, "system_kw");
  assert.equal(e?.brackets.find((b) => b.maxKw === 15)?.feeUsd, 94);
});
await check("(m4) MUST-EXCLUDE: a fee fuzzy match never bridges a CITY to the like-named COUNTY", () => {
  fees.saveFeeSchedule(db, { state: "OR", ahj: "Jefferson County", track: "permit", discipline: "structural" }, {
    found: true, reason: "", basis: "flat", brackets: [{ feeUsd: 999, label: "x" }], notes: "", sourceUrl: "https://jefferson.example.gov/fees", sourceQuote: "solar $999.00", sourceKind: "official",
  });
  assert.equal(fees.findFeeScheduleForProject(db, { state: "OR", ahj: "City of Jefferson", utility: "" }, "permit", "structural"), null);
});

// ── NOT FOUND instead of a guess ─────────────────────────────────────────────────────────────
await check("(x1) MUST-EXCLUDE: a help page offered as the portal is refused, by name", async () => {
  const help = "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx";
  const bad = JSON.parse(processAnswer());
  bad.permits[0].portalUrl = { value: help, sourceUrl: help, quote: "How to permit solar in Oregon ePermitting portal" };
  const r = ppl.parseProcessPart(JSON.stringify(bad), [COUNTY, help, ACA], "end_turn");
  assert.equal(r.permits[0].portalUrl.value, null);
  assert.match(String(r.permits[0].portalUrl.notFound), /information page/);
});
await check("(x2) MUST-EXCLUDE: an agency whose quote does not name it is NOT FOUND", () => {
  const r = ppl.parseProcessPart(processAnswer({ issuingAgency: { value: "Polk County", sourceUrl: COUNTY, quote: "Building permits are issued for Alderbrook addresses" } }), [COUNTY], "end_turn");
  assert.equal(r.issuingAgency.value, null);
  assert.match(String(r.issuingAgency.notFound), /do not state/);
});
await check("(x3) MUST-EXCLUDE: an ungrounded answer (no search results) keeps NOTHING — model memory is never stored", async () => {
  const run = await ppl.runPermitProcessLookup(db, stub(grounded(processAnswer(), { groundedSearches: 0 }), grounded(feesAnswer(), { groundedSearches: 0 })), { state: "OR", ahj: "City of Birchport" });
  const lk = pp.permitProcessFor(project("City of Birchport"))!;
  assert.equal(lk.issuingAgency.value, null, JSON.stringify(run.calls));
  assert.equal(lk.permitStructure.value, null);
  assert.ok(lk.permits.every((p) => p.fee.value === null && p.portalUrl.value === null));
});
await check("(x4) a truncated answer is NOT FOUND ('cut off'), and an aborted part loses only that part", async () => {
  const cut = processAnswer().slice(0, 200);
  const r = ppl.parseProcessPart(cut, [COUNTY], "max_tokens");
  assert.equal(r.issuingAgency.value, null);
  assert.match(String(r.issuingAgency.notFound), /cut off/);
  await ppl.runPermitProcessLookup(db, stub(grounded(processAnswer()), { text: "", groundedSearches: 0, stopReason: null, resultUrls: [], pagesRead: 0, error: "Request was aborted." }), { state: "OR", ahj: "City of Cedarton" });
  const lk = pp.permitProcessFor(project("City of Cedarton"))!;
  assert.equal(lk.issuingAgency.value, "Marion County", "the part that returned is kept");
  assert.ok(lk.permits.every((p) => p.fee.value === null), "the aborted part's answers are not invented");
});
await check("(x5) MUST-EXCLUDE: a fee whose quote does not carry the amount, or a source the search never returned, is NOT FOUND", () => {
  const f = JSON.parse(feesAnswer());
  f.permits[0].fee.quote = "The county charges a flat fee for prescriptive solar.";
  const r = ppl.parseDocsFeesPart(JSON.stringify(f), [COUNTY, FEES], "end_turn");
  assert.equal(r.byDiscipline.get("structural")?.fee.value, null);
  const r2 = ppl.parseDocsFeesPart(feesAnswer(), [COUNTY], "end_turn");
  assert.equal(r2.byDiscipline.get("structural")?.fee.value, null, "a fee sourced to a host the search never returned");

});
await check("(x6) a verified row is never overwritten by a lookup (hard rule 3)", async () => {
  pp.savePermitProcessLookup(db, {
    state: "OR", ahj: "City of Dunmore", lookedUpAt: new Date().toISOString(), confidence: "verified",
    issuingAgency: { value: "City of Dunmore", sourceUrl: "https://dunmore.example.gov", quote: "City of Dunmore issues permits", origin: "operator" },
    permitStructure: { value: "combo", sourceUrl: "https://dunmore.example.gov", quote: "one combination permit", origin: "operator" }, permits: [],
  }, { verifiedBy: "user-1" });
  const run = await ppl.runPermitProcessLookup(db, stub(grounded(processAnswer()), grounded(feesAnswer())), { state: "OR", ahj: "City of Dunmore", force: true });
  assert.equal(run.saved, false);
  assert.equal(pp.permitProcessFor(project("City of Dunmore"))?.issuingAgency.value, "City of Dunmore");
});

if (failures) { console.error(`\n${failures} permitProcessLookup test(s) failed.`); process.exit(1); }
console.log("\nAll permitProcessLookup tests passed.");
process.exit(0);
