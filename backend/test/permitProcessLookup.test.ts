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
// Recall round (mechanised: .probe/lookup-recall/kill.mjs, each verified red):
//   K6 no lift of an agreeing per-permit agency                → (a1) fails.
//   K7 part two asked of 'top || ahj' (no per-agency groups)   → (a2) fails.
//   K8 a prerequisite quote supports the agency                → (a3) fails.
//   K9 no portal step                                          → (q1) fails.
//   K10 portal door without the rule-5 track fit               → (q2) fails (PowerClerk kept).
//   K11 a form title accepted as a record type                 → (q3) fails.
//   K12 documents/fees without page reading                    → (q1) fails.
//   K13 a fetched page not counted as seen                     → (q1) fails.
//   K14 a generic-only agency name kept                        → (a4) fails.
//   K15 no documents/fees retry after an abort                 → (q5) fails.
//   K16 a self-cited platform portal exempt from the seen check → (q6) fails.
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

await check("(x7) a re-run whose part aborts never forgets an earlier cited answer; an agency name is its name", async () => {
  await ppl.runPermitProcessLookup(db, stub(grounded(processAnswer({ issuingAgency: { value: "Marion County Public Works Building Inspection Division", sourceUrl: COUNTY, quote: "Marion County Building Inspection serves Alderbrook" } })), grounded(feesAnswer())), { state: "OR", ahj: "City of Elmstead" });
  assert.equal(pp.permitProcessFor(project("City of Elmstead"))?.issuingAgency.value, "Marion County");
  const aborted: WebLookupResult = { text: "", groundedSearches: 0, stopReason: null, resultUrls: [], pagesRead: 0, error: "Request was aborted." };
  let asked = 0;
  await ppl.runPermitProcessLookup(db, { webLookup: async () => { asked++; return aborted; } }, { state: "OR", ahj: "City of Elmstead", force: true });
  assert.equal(asked, 5, "the aborted process part is retried once, then the portal step, and documents/fees (retried once without page reading)");
  const lk = pp.permitProcessFor(project("City of Elmstead"))!;
  assert.equal(lk.issuingAgency.value, "Marion County");
  assert.equal(lk.permits.find((p) => p.discipline === "structural")?.fee.value?.amountUsd, 67.25);
});

// ── ASK THE AGENCY THAT ISSUES EACH PERMIT; THE PORTAL IS ITS OWN GROUNDED STEP (recall round) ──
// A recording stub: routes by label, records every call's user text and readPages/maxFetches.
type Asked = { label: string; user: string; readPages?: boolean; maxFetches?: number; maxSearches?: number };
const recorder = (answers: { process: WebLookupResult; portal?: WebLookupResult | ((user: string) => WebLookupResult); docs?: WebLookupResult | ((user: string) => WebLookupResult) }) => {
  const asked: Asked[] = [];
  const none: WebLookupResult = { text: "{}", groundedSearches: 1, stopReason: "end_turn", resultUrls: [COUNTY], pagesRead: 0 };
  return {
    asked,
    llm: {
      webLookup: async (i: Asked) => {
        asked.push({ label: i.label, user: i.user, readPages: i.readPages, maxFetches: i.maxFetches, maxSearches: i.maxSearches });
        const pick = (a: WebLookupResult | ((u: string) => WebLookupResult) | undefined) => (typeof a === "function" ? a(i.user) : a ?? none);
        if (/process$/.test(i.label)) return answers.process;
        if (/portal$/.test(i.label)) return pick(answers.portal);
        return pick(answers.docs);
      },
    },
  };
};
const CITY = "https://www.fernhill.example.org/building";
const STATE_BCD = "https://www.example-state.gov/bcd/electrical";
const permitAgency = (value: string, url = COUNTY, quote = `${value} Building Inspection issues structural and electrical permits for Fernhill`) => ({ value, sourceUrl: url, quote });
const jeffersonShape = (over: Record<string, unknown> = {}) => JSON.stringify({
  // The top level names the CITY on a prerequisite quote: must not be kept as the agency.
  issuingAgency: { value: "City of Fernhill", sourceUrl: CITY, quote: "Structural permits must be submitted to Fernhill City Hall first before going to the County." },
  permitStructure: { value: "separate", sourceUrl: CITY, quote: "Solar needs a structural permit and a separate electrical permit" },
  prerequisites: [{ value: "Submit structural permits to Fernhill City Hall first", sourceUrl: CITY, quote: "Structural permits must be submitted to Fernhill City Hall first before going to the County." }],
  permits: [
    { discipline: "structural", label: "Residential Structural", issuingAgency: permitAgency("Marion County"), portalUrl: { value: null, notFound: "search quota exhausted" }, recordType: { value: null } },
    { discipline: "electrical", label: "Residential Electrical", issuingAgency: permitAgency("Marion County"), portalUrl: { value: null, notFound: "search quota exhausted" }, recordType: { value: null } },
  ],
  ...over,
});
const portalAnswer = (portal: Record<string, unknown>, rt: Record<string, unknown> = { value: "Residential Structural", sourceUrl: COUNTY, quote: "choose the record type Residential Structural" }) => JSON.stringify({
  permits: [{ discipline: "structural", portalUrl: portal, recordType: rt }, { discipline: "electrical", portalUrl: portal, recordType: { value: null } }],
});
const docsUserAgency = (u: string) => /Issuing agency: (.*)/.exec(u)?.[1];

await check("(a1) MUST-PASS: every permit cites the same agency and the top level found none → the top level is LIFTED, cited, and documents/fees are asked of it", async () => {
  const r = recorder({ process: grounded(jeffersonShape()), docs: grounded(feesAnswer()) });
  const run = await ppl.runPermitProcessLookup(db, r.llm, { state: "OR", ahj: "City of Fernhill" });
  const lk = run.lookup!;
  assert.equal(lk.issuingAgency.value, "Marion County", "lifted from the agreeing permits");
  assert.equal(lk.issuingAgency.sourceUrl, COUNTY);
  const docs = r.asked.filter((a) => /documentsFees$/.test(a.label));
  assert.equal(docs.length, 1);
  assert.equal(docsUserAgency(docs[0].user), "Marion County", "part two asked of the issuing agency, not the city");
});
await check("(a2) MUST-PASS: permits cite DIFFERENT agencies → one documents/fees call per agency, each for its own permit; no lift", async () => {
  const split = JSON.parse(jeffersonShape());
  split.permits[1].issuingAgency = { value: "Example State Building Codes Division", sourceUrl: STATE_BCD, quote: "The Example State Building Codes Division issues electrical permits for Fernhill" };
  const r = recorder({
    process: grounded(JSON.stringify(split), { resultUrls: [COUNTY, FEES, ACA, CITY, STATE_BCD] }),
    docs: (u) => grounded(/Marion/.test(u)
      ? JSON.stringify({ permits: [JSON.parse(feesAnswer()).permits[0]] })
      : JSON.stringify({ permits: [JSON.parse(feesAnswer()).permits[1]] }), { resultUrls: [COUNTY, FEES, STATE_BCD] }),
  });
  const run = await ppl.runPermitProcessLookup(db, r.llm, { state: "OR", ahj: "City of Gorseby" });
  const docs = r.asked.filter((a) => /documentsFees$/.test(a.label));
  assert.deepEqual(docs.map((d) => docsUserAgency(d.user)).sort(), ["Example State", "Marion County"]);
  assert.match(docs.find((d) => /Marion/.test(d.user))!.user, /Permits: structural$/m);
  assert.match(docs.find((d) => /Example State/.test(d.user))!.user, /Permits: electrical$/m);
  const lk = run.lookup!;
  assert.equal(lk.issuingAgency.value, null, "two agencies: nothing lifted");
  assert.equal(lk.permits.find((p) => p.discipline === "structural")?.fee.value?.amountUsd, 67.25);
  assert.equal(lk.permits.find((p) => p.discipline === "electrical")?.fee.value?.amountUsd, 94);
  assert.ok(r.asked.length <= 6, `bounded: ${r.asked.length} calls`);
});
await check("(a3) MUST-EXCLUDE: a prerequisite office is never the issuing agency — it lands as a cited prerequisite note", async () => {
  const r = recorder({ process: grounded(jeffersonShape(), { resultUrls: [COUNTY, FEES, ACA, CITY] }), docs: grounded(feesAnswer()) });
  const run = await ppl.runPermitProcessLookup(db, r.llm, { state: "OR", ahj: "City of Hollin" });
  const lk = run.lookup!;
  assert.notEqual(lk.issuingAgency.value, "City of Fernhill");
  assert.ok(!r.asked.some((a) => /Issuing agency: City of Fernhill/.test(a.user)), "no part asked of the prerequisite office");
  assert.equal(lk.prerequisites?.[0]?.sourceUrl, CITY);
  assert.ok(lk.notes?.some((n) => /^Prerequisite: .*City Hall/.test(n)), JSON.stringify(lk.notes));
  // Unit: the prerequisite reading, both directions.
  const q = "Structural permits must be submitted to City Hall first before going to Marion County.";
  assert.equal(ppl.namesOnlyAsPrerequisite("City Hall", q), true);
  assert.equal(ppl.namesOnlyAsPrerequisite("Marion County", q), false, "the office it then goes to is the destination");
  assert.equal(ppl.namesOnlyAsPrerequisite("Marion County", "Marion County Building Inspection issues permits for Fernhill"), false);
  assert.equal(ppl.namesOnlyAsPrerequisite("Fernhill", "Obtain Fernhill zoning approval before applying."), true);
});
await check("(a4) MUST-EXCLUDE: an agency named only by generic words is NOT FOUND (and nobody is asked by that name); a dashed/comma tail is dropped", async () => {
  const gp = processAnswer({ issuingAgency: { value: "Building Inspections Division", sourceUrl: COUNTY, quote: "An approved permit by the Building Inspections Division is required for any residential solar panel" } });
  const r = ppl.parseProcessPart(gp, [COUNTY], "end_turn");
  assert.equal(r.issuingAgency.value, null);
  const bare = JSON.parse(processAnswer());
  bare.issuingAgency.value = null;
  for (const p of bare.permits) p.issuingAgency = { value: "Building", sourceUrl: COUNTY, quote: "All electrical work requires an approved permit by the Building Inspections Division." };
  const rec = recorder({ process: grounded(JSON.stringify(bare)), docs: grounded(feesAnswer()) });
  await ppl.runPermitProcessLookup(db, rec.llm, { state: "OR", ahj: "City of Mossgiel" });
  assert.ok(rec.asked.filter((a) => !/process$/.test(a.label)).every((a) => docsUserAgency(a.user) === "City of Mossgiel"), JSON.stringify(rec.asked.map((a) => docsUserAgency(a.user))));
  const ev = ppl.parseProcessPart(processAnswer({ issuingAgency: { value: "City of Evanston — Community Development Department, Building and", sourceUrl: COUNTY, quote: "The City of Evanston's Permit Desk handles all building permits" } }), [COUNTY], "end_turn");
  assert.equal(ev.issuingAgency.value, "City of Evanston");
});
await check("(q1) MUST-PASS: the portal step asks the ISSUING AGENCY, reads pages (bounded), and fills the portal + record type part one could not cite", async () => {
  const r = recorder({
    process: grounded(jeffersonShape()),
    portal: grounded(portalAnswer({ value: ACA, sourceUrl: "https://permits.example-county-online.org/apply", quote: "Apply online through Oregon ePermitting" }), { resultUrls: [COUNTY], fetchedUrls: ["https://permits.example-county-online.org/apply"] }),
    docs: grounded(feesAnswer()),
  });
  const run = await ppl.runPermitProcessLookup(db, r.llm, { state: "OR", ahj: "City of Ivybank" });
  const portal = r.asked.filter((a) => /portal$/.test(a.label));
  assert.equal(portal.length, 1);
  assert.equal(docsUserAgency(portal[0].user), "Marion County");
  assert.equal(portal[0].readPages, true);
  assert.ok((portal[0].maxFetches ?? 99) <= 3);
  const s = run.lookup!.permits.find((p) => p.discipline === "structural")!;
  assert.equal(s.portalUrl.value, ACA, "cited from a page the lookup OPENED");
  assert.equal(s.recordType.value, "Residential Structural");
  assert.equal(r.asked.find((a) => /process$/.test(a.label))?.readPages, false);
  const d = r.asked.find((a) => /documentsFees$/.test(a.label))!;
  assert.equal(d.readPages, true, "documents/fees may read fee-schedule pages");
  assert.ok((d.maxFetches ?? 99) <= 3);
});
await check("(q2) MUST-EXCLUDE: the portal door refuses a utility interconnection portal, a help page, and an uncited URL", async () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["utility portal", { value: "https://pacificpower.powerclerk.com/MvcAccount/Login", sourceUrl: COUNTY, quote: "Apply online through the PowerClerk portal" }, /utility|interconnection|permit \(AHJ\)/i],
    ["help page", { value: "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx", sourceUrl: COUNTY, quote: "Apply online: see the Oregon ePermitting portal help" }, /information page/],
    ["uncited", { value: ACA, sourceUrl: "https://blog.solar-installer.example.com/oregon-permits", quote: "Apply online through Oregon ePermitting (aca-oregon.accela.com)" }, /not a page the search returned/],
  ];
  for (const [name, portal, why] of cases) {
    const r = recorder({ process: grounded(jeffersonShape()), portal: grounded(portalAnswer(portal), { resultUrls: [COUNTY, "https://www.oregon.gov/bcd/epermitting/help/records/pages/permit-for-solar.aspx"] }), docs: grounded(feesAnswer()) });
    const run = await ppl.runPermitProcessLookup(db, r.llm, { state: "OR", ahj: `City of Juniper ${name}`, force: true });
    const s = run.lookup!.permits.find((p) => p.discipline === "structural")!;
    assert.equal(s.portalUrl.value, null, `${name}: ${s.portalUrl.value}`);
    assert.match(String(s.portalUrl.notFound), why, name);
  }
  // The same door in part one: a PowerClerk URL offered by the process answer is refused too.
  const bad = JSON.parse(processAnswer());
  bad.permits[0].portalUrl = { value: "https://pacificpower.powerclerk.com/MvcAccount/Login", sourceUrl: COUNTY, quote: "Apply online through the PowerClerk portal" };
  assert.equal(ppl.parseProcessPart(JSON.stringify(bad), [COUNTY], "end_turn").permits[0].portalUrl.value, null);
});
await check("(q3) MUST-EXCLUDE: a paper form's title is not a record type; the portal step never replaces a portal part one cited", async () => {
  const r = recorder({
    process: grounded(processAnswer({ permits: [{ ...JSON.parse(processAnswer()).permits[0], recordType: { value: null } }, JSON.parse(processAnswer()).permits[1]] })),
    portal: grounded(portalAnswer({ value: "https://other.accela.com/X", sourceUrl: COUNTY, quote: "Apply online at other.accela.com" }, { value: "B-01S Solar Prescriptive Installation Application", sourceUrl: COUNTY, quote: "B-01S Solar Prescriptive Installation Application" })),
    docs: grounded(feesAnswer()),
  });
  const run = await ppl.runPermitProcessLookup(db, r.llm, { state: "OR", ahj: "City of Kestrel" });
  const s = run.lookup!.permits.find((p) => p.discipline === "structural")!;
  assert.equal(s.portalUrl.value, ACA, "part one's cited portal stays");
  assert.equal(s.recordType.value, null);
  assert.match(String(s.recordType.notFound), /form's title/);
  const kept = ppl.acceptRecordType({ value: "Residential Electrical - Solar", sourceUrl: COUNTY, quote: "Apply for Permit - Residential Electrical - Solar" }, [COUNTY]);
  assert.equal(kept.value, "Residential Electrical - Solar");
});
await check("(q4) an aborted portal step keeps nothing and loses nothing else", async () => {
  const r = recorder({ process: grounded(jeffersonShape()), portal: { text: "", groundedSearches: 0, stopReason: null, resultUrls: [], pagesRead: 0, error: "Request was aborted." }, docs: grounded(feesAnswer()) });
  const run = await ppl.runPermitProcessLookup(db, r.llm, { state: "OR", ahj: "City of Larchmere" });
  const s = run.lookup!.permits.find((p) => p.discipline === "structural")!;
  assert.equal(s.portalUrl.value, null);
  assert.equal(s.fee.value?.amountUsd, 67.25);
  assert.equal(run.lookup!.issuingAgency.value, "Marion County");
});

await check("(q6) a portal citing its OWN page is kept only when that page was returned or opened — never a remembered platform URL", () => {
  const platform = "https://aca-prod.accela.com/FERNHILL/Default.aspx";
  const self = { value: platform, sourceUrl: platform, quote: "Welcome to the City of Fernhill Citizen Access portal" };
  assert.equal(ppl.acceptPortal(self, [COUNTY]).value, null, "self-cited, never seen → not kept");
  assert.match(String(ppl.acceptPortal(self, [COUNTY]).notFound), /not a page the search returned/);
  assert.equal(ppl.acceptPortal(self, [COUNTY, "https://aca-prod.accela.com/FERNHILL/Cap/CapHome.aspx"]).value, platform, "its host was returned → kept");
  assert.equal(ppl.acceptPortal({ value: ACA, sourceUrl: COUNTY, quote: "Apply online through Oregon ePermitting (aca-oregon.accela.com)" }, []).value, null, "no seen pages at all → nothing is a seen source");
});
await check("(q5) MUST-PASS: a documents/fees call that ABORTS while reading pages is retried once without page reading, and its cited answer is kept", async () => {
  let docsCalls = 0;
  const rec = recorder({
    process: grounded(processAnswer()),
    docs: () => (++docsCalls === 1 ? { text: "", groundedSearches: 0, stopReason: null, resultUrls: [], pagesRead: 0, error: "Request was aborted." } : grounded(feesAnswer())),
  });
  const run = await ppl.runPermitProcessLookup(db, rec.llm, { state: "OR", ahj: "City of Nettlecombe" });
  const d = rec.asked.filter((a) => /documentsFees$/.test(a.label));
  assert.deepEqual(d.map((a) => a.readPages), [true, false]);
  assert.equal(run.lookup!.permits.find((p) => p.discipline === "structural")?.fee.value?.amountUsd, 67.25);
  // An answer that RAN and found nothing is not retried.
  const rec2 = recorder({ process: grounded(processAnswer()), docs: grounded(JSON.stringify({ permits: [] })) });
  await ppl.runPermitProcessLookup(db, rec2.llm, { state: "OR", ahj: "City of Oxbow" });
  assert.equal(rec2.asked.filter((a) => /documentsFees$/.test(a.label)).length, 1);
});

if (failures) { console.error(`\n${failures} permitProcessLookup test(s) failed.`); process.exit(1); }
console.log("\nAll permitProcessLookup tests passed.");
process.exit(0);
