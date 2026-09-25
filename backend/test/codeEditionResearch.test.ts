// CODE EDITIONS, FOUND BY DEFAULT FOR ANY STATE — the research pipeline's invariants (B1-B4).
//
//   B1 MEMORY NEVER LANDS AS AN EDITION: a result that is not web-grounded stores nothing (and so
//      never blocks the grounded attempt behind it); a row holding memory codes is re-researched;
//      a grounded save carries its evidence (searches, result URLs, model, tokens).
//   B2 MERGE, NOT REPLACE: a Stamp Summary row is researched and keeps its stamp amendment and
//      citation; an operator import and an AHJ-correction value survive; a verified row never
//      changes.
//   B3 STATE FIRST: an Oregon city reads the state's OSSC/OFC; a Texas city is researched for its
//      local families; a uniform-state AHJ never takes its own edition from research — for any
//      state whose layer says so, not an Oregon special case.
//   B4 EDITIONS OVER TIME: which editions apply on a date (a phase-in allows both); re-research on
//      a passed upcoming date / 180 days / memory; a stale VERIFIED row gets a proposal, never a
//      write — and the operator's approval is the re-verification.
// No network: the researcher is a fake LLMProvider. Run: npx tsx backend/test/codeEditionResearch.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodeEdition, JurisdictionCodeProfile, JurisdictionCodeResearchInput, LLMProvider } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "code-editions-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CODE_RESEARCH;
delete process.env.SKIP_CODE_RESEARCH;

const { openDatabase } = await import("../src/db");
const CP = await import("../src/codeProfiles");
const F = await import("../src/codeFamilies");
const db = await openDatabase();

// Never reach the worker: queued payloads are recorded here.
const queued: Array<Record<string, unknown>> = [];
CP.setCodeResearchEnqueuerForTests((_d, p) => { queued.push(p as unknown as Record<string, unknown>); });
CP.setDesignResearchEnqueuerForTests(() => { /* the design lookup is not under test here */ });

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); } catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const blank = (state: string, ahj: string, over: Partial<JurisdictionCodeProfile> = {}): JurisdictionCodeProfile => ({
  key: "", state, ahj, confidence: "seeded", adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {},
  fireSetbacks: [], citations: [], updatedAt: "", ...over,
});
const grounded = { webGrounded: true, method: "web_search" as const, searches: 4, groundedSearches: 3, resultUrls: ["https://codes.example.gov/adopted"], model: "claude-test", outputTokens: 4100 };
/** A fake researcher: returns `codes` for whatever it is asked, grounded or not. */
const fakeResearcher = (codes: CodeEdition[], webGrounded: boolean, extra: Partial<JurisdictionCodeProfile> = {}): { provider: LLMProvider; asked: JurisdictionCodeResearchInput[] } => {
  const asked: JurisdictionCodeResearchInput[] = [];
  const provider = {
    async researchJurisdictionCodes(input: JurisdictionCodeResearchInput) {
      asked.push(input);
      return {
        provider: "claude" as const,
        profile: blank(input.state, input.ahj, {
          adoptedCodes: codes, ...extra,
          researchProvenance: webGrounded ? { ...grounded, at: new Date().toISOString() } : { webGrounded: false, method: "model_memory" as const, searches: 2, groundedSearches: 0 },
        }),
        webGrounded, needsHumanVerification: true as const, notes: "",
      };
    },
  } as unknown as LLMProvider;
  return { provider, asked };
};
const payloadOf = (key: string) => {
  const r = db.get<{ payload_json: string; confidence: string; verified_at: string | null }>("SELECT payload_json, confidence, verified_at FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
  return r ? { ...JSON.parse(r.payload_json), confidence: r.confidence, verifiedAt: r.verified_at } : null;
};
const OR_KEY = CP.codeProfileKey({ state: "OR", ahj: "" });
const ZV_KEY = CP.codeProfileKey({ state: "ZV", ahj: "" });
const codesOf = (p: { adoptedCodes: CodeEdition[] } | null) => (p?.adoptedCodes ?? []).map((c) => `${c.code} ${c.edition}`);

// ─────────────────────────────────────────────────────────────────────────────────────────
// B1
// ─────────────────────────────────────────────────────────────────────────────────────────
await check("B1 MUST-EXCLUDE: a model-memory result stores no row, so the grounded attempt behind it still runs and lands", async () => {
  const key = CP.codeProfileKey({ state: "TX", ahj: "City of Memoryville" });
  const r = await CP.runCodeResearch(db, { state: "TX", ahj: "City of Memoryville", profileKey: key }, fakeResearcher([{ family: "residential", code: "IRC", edition: "2023" }], false).provider);
  assert.equal(r.saved, false);
  assert.match(String(r.reason), /not web-grounded/);
  assert.equal(r.searches, 2, "the job result lost the grounding evidence");
  assert.equal(payloadOf(key), null, "a model-memory research created a row");
  const d = CP.codeResearchDecision(db, "TX", "City of Memoryville");
  assert.equal(d.action, "research", `the memory attempt blocked research: ${JSON.stringify(d)}`);
  // MUST-PASS: the grounded result lands, with its evidence.
  const g = await CP.runCodeResearch(db, { state: "TX", ahj: "City of Memoryville", profileKey: key }, fakeResearcher([{ family: "residential", code: "IRC", edition: "2021", sourceUrl: "https://memoryville.example.gov/codes" }], true).provider);
  assert.equal(g.saved, true, JSON.stringify(g));
  const p = payloadOf(key)!;
  assert.deepEqual(codesOf(p), ["IRC 2021"]);
  assert.equal(p.adoptedCodes[0].origin, "research");
  assert.equal(p.researchProvenance.groundedSearches, 3);
  assert.deepEqual(p.researchProvenance.resultUrls, ["https://codes.example.gov/adopted"]);
  assert.equal(p.researchProvenance.model, "claude-test");
  assert.equal(p.researchProvenance.outputTokens, 4100);
});

await check("B1: saveResearchedCodeProfile itself refuses memory (the POST /research route saves directly)", () => {
  const key = CP.codeProfileKey({ state: "WA", ahj: "" });
  const before = JSON.stringify(payloadOf(key));
  CP.saveResearchedCodeProfile(db, blank("WA", "", { adoptedCodes: [{ code: "IRC", edition: "2024" }], researchProvenance: { webGrounded: false, method: "model_memory" } }));
  assert.equal(JSON.stringify(payloadOf(key)), before, "a model-memory save changed the WA state row");
});

await check("B1 MUST-PASS: a row holding MEMORY codes is eligible for re-research", () => {
  // The legacy shape: codes written by the memory-era researcher, provenance model_memory.
  CP.saveResearchedCodeProfile(db, blank("TX", "City of Oldmemory", { adoptedCodes: [{ code: "IRC", edition: "2018" }], amendments: [{ code: "AHJ", summary: "x" }] }));
  db.run("UPDATE jurisdiction_code_profiles SET payload_json = json_set(payload_json, '$.researchProvenance', json('{\"webGrounded\":false,\"method\":\"model_memory\"}')) WHERE profile_key = ?", [CP.codeProfileKey({ state: "TX", ahj: "City of Oldmemory" })]);
  const d = CP.codeResearchDecision(db, "TX", "City of Oldmemory");
  assert.equal(d.action, "research");
  assert.equal(d.reason, "memory_provenance");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// B2
// ─────────────────────────────────────────────────────────────────────────────────────────
await check("B2 MUST-PASS: a Stamp Summary row is researched and keeps its stamp amendment + citation", async () => {
  const stamp = blank("TX", "Stampton", {
    amendments: [{ code: "AHJ", summary: "Structural stamp required: Yes" }, { code: "AHJ", summary: "Stamp notes: 120 mph wind speed on CAD" }],
    citations: [{ label: "Operator stamp-requirements list (Stamp Summary)", sourceUrl: "" }],
    designCriteria: { windSpeedMph: 120 },
  });
  CP.saveResearchedCodeProfile(db, stamp); // the import path (no provenance)
  const key = CP.codeProfileKey({ state: "TX", ahj: "Stampton" });
  const d = CP.codeResearchDecision(db, "TX", "City of Stampton");
  assert.equal(d.action, "research", `a stamp row was not researched: ${JSON.stringify(d)}`);
  assert.equal(d.key, key, "research aimed at a forked key instead of the stamp row");
  const { provider, asked } = fakeResearcher(
    [{ family: "residential", code: "IRC", edition: "2021", sourceUrl: "https://stampton.example.gov/codes", effectiveDate: "2023-01-01" }],
    true,
    { amendments: [{ code: "IRC", summary: "Local R324 setback" }], designCriteria: { windSpeedMph: 105, groundSnowLoadPsf: 5 }, citations: [{ label: "City codes page", sourceUrl: "https://stampton.example.gov/codes" }] },
  );
  const r = await CP.runCodeResearch(db, { state: d.state, ahj: d.ahj, profileKey: d.key, families: d.families }, provider);
  assert.equal(r.saved, true, JSON.stringify(r));
  assert.ok(asked[0].families?.includes("residential"), "the researcher was not scoped to the local families");
  const p = payloadOf(key)!;
  const summaries = p.amendments.map((a: { summary: string }) => a.summary);
  assert.ok(summaries.includes("Structural stamp required: Yes"), "the stamp amendment was lost");
  assert.ok(summaries.includes("Stamp notes: 120 mph wind speed on CAD"), "the stamp note was lost");
  assert.ok(summaries.includes("Local R324 setback"), "the research amendment was not added");
  assert.ok(p.citations.some((c: { label: string }) => /Stamp Summary/.test(c.label)), "the stamp citation was lost");
  assert.deepEqual(codesOf(p), ["IRC 2021"]);
  assert.equal(p.designCriteria.windSpeedMph, 120, "research overwrote a value on file");
  assert.equal(p.designCriteria.groundSnowLoadPsf, 5, "research did not fill a blank");
  assert.equal(CP.exactCodeProfileRow(db, "TX", "City of Stampton"), null, "the research forked the jurisdiction");
});

await check("B2 MUST-EXCLUDE: an operator import code and an AHJ-correction value survive a research save", async () => {
  CP.saveResearchedCodeProfile(db, blank("TX", "City of Keepsake", {
    adoptedCodes: [{ family: "electrical", code: "NEC", edition: "2017", origin: "import", notes: "Imported from operator reference list — verify against the AHJ." }],
    designCriteria: { groundSnowLoadPsf: 36 },
    citations: [CP.sharedCorrectionCitation("designCriteria.groundSnowLoadPsf", 36, "2026-09-01")],
  }));
  await CP.runCodeResearch(db, { state: "TX", ahj: "City of Keepsake" }, fakeResearcher(
    [{ family: "electrical", code: "NEC", edition: "2023" }, { family: "residential", code: "IRC", edition: "2021" }], true, { designCriteria: { groundSnowLoadPsf: 5 } },
  ).provider);
  const p = payloadOf(CP.codeProfileKey({ state: "TX", ahj: "City of Keepsake" }))!;
  assert.deepEqual(codesOf(p).sort(), ["IRC 2021", "NEC 2017"], `codes: ${codesOf(p)}`);
  assert.equal(p.designCriteria.groundSnowLoadPsf, 36, "the AHJ-correction value was overwritten");
});

await check("B2 MUST-EXCLUDE: a verified row does not change (a research finding becomes a proposal)", async () => {
  CP.saveVerifiedCodeProfile(db, blank("TX", "City of Lockdown", { adoptedCodes: [{ family: "residential", code: "IRC", edition: "2018" }], amendments: [{ code: "AHJ", summary: "Keep me" }] }), "tester");
  const key = CP.codeProfileKey({ state: "TX", ahj: "City of Lockdown" });
  const before = JSON.stringify(payloadOf(key));
  assert.equal(CP.codeResearchDecision(db, "TX", "City of Lockdown").reason, "blocked_verified");
  CP.saveResearchedCodeProfile(db, blank("TX", "City of Lockdown", { adoptedCodes: [{ family: "residential", code: "IRC", edition: "2021", sourceUrl: "https://lockdown.example.gov" }], researchProvenance: { ...grounded, at: new Date().toISOString() } }));
  assert.equal(JSON.stringify(payloadOf(key)), before, "research wrote a human-verified row");
  const props = CP.listEditionProposals(db, key);
  assert.equal(props.length, 1, "the finding was not proposed");
  assert.deepEqual(props[0].changes.map((c) => `${c.family}: ${c.current} -> ${c.proposed}`), ["residential: IRC 2018 -> IRC 2021"]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// B3
// ─────────────────────────────────────────────────────────────────────────────────────────
await check("B3: the shipped reference layer gives every truth state an adoption model (Oregon uniform even though its row is verified)", () => {
  assert.equal(CP.stateAdoptionModel(db, "OR")?.model, "statewide_uniform");
  assert.equal(CP.stateAdoptionModel(db, "TX")?.model, "local_adoption");
  assert.deepEqual(F.locallyAdoptedFamilies(CP.stateAdoptionModel(db, "OR")), []);
  assert.ok(F.locallyAdoptedFamilies(CP.stateAdoptionModel(db, "TX")).includes("residential"));
  // A state layer that says a family is LOCAL retires the memory-era state entry for it (Arizona
  // adopts no statewide residential code; the shipped seed row said "IRC 2018").
  const az = codesOf(CP.getCodeProfile(db, { state: "AZ", ahj: "" }));
  assert.ok(!az.includes("IRC 2018"), `Arizona still claims a statewide IRC: ${az}`);
  assert.ok(az.includes("IFC 2024"), `Arizona lost its state fire code: ${az}`);
  // A seeded state row created from the reference carries it on the row too.
  assert.equal(CP.getCodeProfile(db, { state: "NY", ahj: "" })?.adoptionModel?.model, "statewide_uniform");
});

await check("B3 MUST-PASS: a TX city with no row triggers AHJ research for its local families", () => {
  queued.length = 0;
  CP.resetResearchMarkersForTests();
  CP.ensureCodeProfilesResearched(db, "TX", "City of Newtexas");
  const job = queued.find((p) => p.ahj === "City of Newtexas");
  assert.ok(job, `no AHJ research queued: ${JSON.stringify(queued)}`);
  assert.ok((job!.families as string[]).includes("residential"));
  assert.ok(!(job!.families as string[]).includes("electrical"), "a state-set family was researched per city");
});

await check("B3 MUST-EXCLUDE: an Oregon (uniform) AHJ is not researched, and research can't give it its own edition", async () => {
  queued.length = 0;
  CP.resetResearchMarkersForTests();
  CP.ensureCodeProfilesResearched(db, "OR", "City of Newbay");
  assert.equal(queued.filter((p) => p.ahj === "City of Newbay").length, 0, `a uniform-state AHJ was researched: ${JSON.stringify(queued)}`);
  // Even if a research for it runs (the POST route, an old job), the uniform family never lands.
  await CP.runCodeResearch(db, { state: "OR", ahj: "City of Newbay" }, fakeResearcher(
    [{ family: "residential", code: "IRC", edition: "2023" }, { family: "fire", code: "IFC", edition: "2022" }], true, { designCriteria: { groundSnowLoadPsf: 25 } },
  ).provider);
  const own = payloadOf(CP.codeProfileKey({ state: "OR", ahj: "City of Newbay" }));
  assert.deepEqual(codesOf(own), [], `a uniform-state AHJ stored its own editions: ${codesOf(own)}`);
  const read = CP.getCodeProfile(db, { state: "OR", ahj: "City of Newbay" })!;
  assert.ok(!codesOf(read).includes("IRC 2023"), `the read shows a conflicting edition: ${codesOf(read)}`);
  assert.ok(codesOf(read).includes("ORSC 2023"), `the read lost the state's ORSC: ${codesOf(read)}`);
});

await check("B3 MUST-EXCLUDE: a memory-era fork row's wrong editions (Coos Bay: IRC 2023, IBC 2022, IFC 2022) never reach the read", () => {
  CP.saveResearchedCodeProfile(db, blank("OR", "City of Testcoos", {
    adoptedCodes: [{ code: "IRC", edition: "2023" }, { code: "IBC", edition: "2022" }, { code: "NEC", edition: "2023" }, { code: "IFC", edition: "2022" }, { code: "IPC", edition: "2023" }],
  }));
  const read = CP.getCodeProfile(db, { state: "OR", ahj: "City of Testcoos" })!;
  for (const wrong of ["IRC 2023", "IBC 2022", "IFC 2022", "IPC 2023"]) assert.ok(!codesOf(read).includes(wrong), `${wrong} reached the read: ${codesOf(read)}`);
  assert.ok(read.adoptedCodes.every((c) => c.inheritedFrom === "state"), "an entry is not the state's");
});

await check("B3: generic — ANY state whose layer says uniform inherits (a synthetic state, no Oregon code path)", async () => {
  await CP.runCodeResearch(db, { state: "ZQ", ahj: "" }, fakeResearcher(
    [{ family: "residential", code: "ZQRC", edition: "2024", basedOn: "2024 IRC", sourceUrl: "https://codes.zq.example.gov" }], true,
    { adoptionModel: { model: "statewide_uniform" } },
  ).provider);
  assert.equal(CP.stateAdoptionModel(db, "ZQ")?.model, "statewide_uniform");
  assert.equal(CP.codeResearchDecision(db, "ZQ", "City of Anywhere").reason, "inherits_state");
  CP.saveResearchedCodeProfile(db, blank("ZQ", "City of Anywhere", { adoptedCodes: [{ family: "residential", code: "IRC", edition: "2018", origin: "import" }] }));
  assert.deepEqual(codesOf(CP.getCodeProfile(db, { state: "ZQ", ahj: "City of Anywhere" })), ["ZQRC 2024"]);
  // Control: the same AHJ entry in a LOCAL state wins over the state's.
  await CP.runCodeResearch(db, { state: "ZL", ahj: "" }, fakeResearcher([{ family: "residential", code: "IRC", edition: "2012", sourceUrl: "https://zl.example.gov" }], true, { adoptionModel: { model: "local_adoption" } }).provider);
  CP.saveResearchedCodeProfile(db, blank("ZL", "City of Localton", { adoptedCodes: [{ family: "residential", code: "IRC", edition: "2021", origin: "import" }] }));
  assert.deepEqual(codesOf(CP.getCodeProfile(db, { state: "ZL", ahj: "City of Localton" })), ["IRC 2021"], "a local-adoption AHJ lost its own edition (or read the state floor)");
  // A local-adoption AHJ with NO row does not read the state's floor as its edition (M1).
  assert.deepEqual(codesOf(CP.getCodeProfile(db, { state: "ZL", ahj: "City of Norow" })), [], "a no-row city in a local-adoption state read the state floor as its own edition");
  assert.deepEqual(codesOf(CP.getCodeProfile(db, { state: "ZL", ahj: "" })), ["IRC 2012"], "the state-level read lost the state's own entry");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// M1 — a local-adoption AHJ reads the same whether or not it has a row
// ─────────────────────────────────────────────────────────────────────────────────────────
await check("M1 MUST-PASS: a no-row TX city and a stamp-only TX row both read no IRC/IBC, keep NEC 2026 inherited, and cite 'No adopted-code data' for the IRC", () => {
  CP.saveResearchedCodeProfile(db, blank("TX", "City of Hasrow", { amendments: [{ code: "AHJ", summary: "Structural stamp required: Yes" }] }));
  for (const ahj of ["City of Norowville", "City of Hasrow"]) {
    const read = CP.getCodeProfile(db, { state: "TX", ahj })!;
    const fams = read.adoptedCodes.map((c) => F.codeFamilyOf(c));
    assert.ok(!fams.includes("residential") && !fams.includes("building"), `${ahj} reads a state floor as its edition: ${codesOf(read)}`);
    const nec = read.adoptedCodes.find((c) => c.code === "NEC");
    assert.equal(nec?.edition, "2026", `${ahj} lost the state's NEC: ${codesOf(read)}`);
    assert.equal(nec?.inheritedFrom, "state", `${ahj}'s NEC is not marked inherited`);
    const irc = CP.resolveEffectiveCodeContext(db, "TX", ahj).citationFor("IRC", "R324", "Solar");
    assert.match(String(irc.note), /No adopted-code data/, `${ahj} cites the IRC as ${irc.code}`);
  }
});

await check("M1 MUST-EXCLUDE: the TX state-level read still lists IRC 2012; an OR city with no row still reads every OR state code", () => {
  assert.ok(codesOf(CP.getCodeProfile(db, { state: "TX", ahj: "" })).includes("IRC 2012"), "the TX state read lost its IRC floor");
  const orState = codesOf(CP.getCodeProfile(db, { state: "OR", ahj: "" }));
  const orCity = codesOf(CP.getCodeProfile(db, { state: "OR", ahj: "City of Norowor" }));
  assert.deepEqual(orCity, orState, "an Oregon city with no row does not read every state code");
  assert.equal(CP.getCodeProfile(db, { state: "OR", ahj: "City of Norowor" })?.confidence, "verified", "the verified OR state row stopped reading as verified");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// M5 — a human's statement is never hidden by a seeded state fact
// ─────────────────────────────────────────────────────────────────────────────────────────
await check("M5 MUST-PASS: a VERIFIED AHJ row's NEC 2020 in a uniform family (NC) is read, not dropped", () => {
  assert.equal(F.familyAdoptionModel(CP.stateAdoptionModel(db, "NC"), "electrical"), "statewide_uniform", "fixture: NC electrical is uniform");
  CP.saveVerifiedCodeProfile(db, blank("NC", "City of Verifiedton", { adoptedCodes: [{ family: "electrical", code: "NEC", edition: "2020" }] }), "operator");
  const read = CP.getCodeProfile(db, { state: "NC", ahj: "City of Verifiedton" })!;
  const nec = read.adoptedCodes.filter((c) => F.codeFamilyOf(c) === "electrical");
  assert.deepEqual(nec.map((c) => `${c.code} ${c.edition}`), ["NEC 2020"], `the verified statement was not the read: ${codesOf(read)}`);
  assert.equal(CP.resolveEffectiveCodeContext(db, "NC", "City of Verifiedton").citationFor("NEC", "690.12", "Rapid shutdown").code, "2020 NEC");
  // An operator-origin entry on a seeded row is a person's statement too.
  CP.saveResearchedCodeProfile(db, blank("NC", "City of Operatorton", { adoptedCodes: [{ family: "electrical", code: "NEC", edition: "2020", origin: "operator" }] }));
  assert.ok(codesOf(CP.getCodeProfile(db, { state: "NC", ahj: "City of Operatorton" })).includes("NEC 2020"), "an operator entry was dropped");
});

await check("M5 MUST-EXCLUDE: seeded, research and import AHJ entries in a uniform family are still dropped", () => {
  for (const [name, origin] of [["City of Seedton", undefined], ["City of Researchton", "research"], ["City of Importon", "import"]] as const) {
    CP.saveResearchedCodeProfile(db, blank("NC", name, { adoptedCodes: [{ family: "electrical", code: "NEC", edition: "2020", ...(origin ? { origin } : {}) }] }));
    const read = CP.getCodeProfile(db, { state: "NC", ahj: name })!;
    assert.ok(!codesOf(read).includes("NEC 2020"), `${name} (${origin ?? "no origin"}) read its own NEC in a uniform family: ${codesOf(read)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// M2 — AHJ research is scoped to what it was asked; it never displaces a statewide minimum
// ─────────────────────────────────────────────────────────────────────────────────────────
await check("M2 MUST-PASS (read): research that landed before the state said min+amend never displaces the state's edition", async () => {
  // The skeptic's A2 order: the AHJ result lands first (no model known), then the state layer.
  await CP.runCodeResearch(db, { state: "ZM", ahj: "City of Earlybird" }, fakeResearcher([
    { family: "residential", code: "IRC", edition: "2018", sourceUrl: "https://earlybird.example.gov" },
    { family: "electrical", code: "NEC", edition: "2017", sourceUrl: "https://earlybird.example.gov" },
  ], true).provider);
  await CP.runCodeResearch(db, { state: "ZM", ahj: "" }, fakeResearcher([
    { family: "residential", code: "IRC", edition: "2021", sourceUrl: "https://zm.example.gov" },
    { family: "electrical", code: "NEC", edition: "2023", sourceUrl: "https://zm.example.gov" },
  ], true, { adoptionModel: { model: "statewide_minimum_local_amend" } }).provider);
  const read = codesOf(CP.getCodeProfile(db, { state: "ZM", ahj: "City of Earlybird" }));
  assert.deepEqual(read.sort(), ["IRC 2021", "NEC 2023"], `a research-origin AHJ copy displaced the state's minimum: ${read}`);
  // An operator import in a min+amend family is a person's statement and still wins.
  CP.saveResearchedCodeProfile(db, blank("ZM", "City of Importville", { adoptedCodes: [{ family: "residential", code: "IRC", edition: "2018", origin: "import", notes: "Imported from operator reference list — verify against the AHJ." }] }));
  assert.ok(codesOf(CP.getCodeProfile(db, { state: "ZM", ahj: "City of Importville" })).includes("IRC 2018"), "an operator import in a min+amend family was dropped");
});

await check("M2 MUST-PASS (save): an MD AHJ research asked for its local families stores only those — the unasked IRC 2015 never lands, the read shows MD's IRC 2021", async () => {
  const d = CP.codeResearchDecision(db, "MD", "City of Probeville");
  assert.equal(d.action, "research", JSON.stringify(d));
  assert.ok(d.families?.includes("electrical") && !d.families.includes("residential"), `fixture: MD local families ${JSON.stringify(d.families)}`);
  const f = fakeResearcher([
    { family: "electrical", code: "NEC", edition: "2020", sourceUrl: "https://probeville.example.gov" },
    { family: "residential", code: "IRC", edition: "2015", sourceUrl: "https://probeville.example.gov" },
  ], true);
  const r = await CP.runCodeResearch(db, { state: d.state, ahj: d.ahj, profileKey: d.key, families: d.families }, f.provider);
  assert.equal(r.saved, true, JSON.stringify(r));
  assert.deepEqual(f.asked[0].families, d.families, "the researcher was not asked the decision's families");
  assert.deepEqual(codesOf(payloadOf(d.key)), ["NEC 2020"], `an unasked family was stored: ${codesOf(payloadOf(d.key))}`);
  const read = CP.getCodeProfile(db, { state: "MD", ahj: "City of Probeville" })!;
  const irc = read.adoptedCodes.filter((c) => F.codeFamilyOf(c) === "residential");
  assert.deepEqual(irc.map((c) => `${c.code} ${c.edition}${c.inheritedFrom ? "(state)" : ""}`), ["IRC 2021(state)"], `the read: ${codesOf(read)}`);
  // The POST /research route saves with no families: the state's local families scope it.
  CP.saveResearchedCodeProfile(db, blank("MD", "City of Routeville", {
    adoptedCodes: [{ family: "residential", code: "IRC", edition: "2015" }, { family: "electrical", code: "NEC", edition: "2020" }],
    researchProvenance: { ...grounded, at: new Date().toISOString() },
  }));
  assert.deepEqual(codesOf(payloadOf(CP.codeProfileKey({ state: "MD", ahj: "City of Routeville" }))), ["NEC 2020"], "a route-shaped save stored a family the state sets");
});

await check("M2 MUST-EXCLUDE: a TX AHJ research for residential still stores, and reads, its own IRC 2021", async () => {
  const d = CP.codeResearchDecision(db, "TX", "City of Ownirc");
  assert.ok(d.families?.includes("residential"), JSON.stringify(d));
  const r = await CP.runCodeResearch(db, { state: d.state, ahj: d.ahj, profileKey: d.key, families: d.families }, fakeResearcher([
    { family: "residential", code: "IRC", edition: "2021", sourceUrl: "https://ownirc.example.gov" },
  ], true).provider);
  assert.equal(r.saved, true, JSON.stringify(r));
  assert.deepEqual(codesOf(payloadOf(d.key)), ["IRC 2021"]);
  const read = CP.getCodeProfile(db, { state: "TX", ahj: "City of Ownirc" })!;
  const irc = read.adoptedCodes.filter((c) => F.codeFamilyOf(c) === "residential");
  assert.deepEqual(irc.map((c) => `${c.code} ${c.edition}${c.inheritedFrom ? "(state)" : ""}`), ["IRC 2021"], `the read: ${codesOf(read)}`);
  // A research result can never claim a person's authority: an "operator" origin it carries is
  // replaced (it would otherwise outrank the state's minimum once the state's model is known).
  CP.saveResearchedCodeProfile(db, blank("ZO", "City of Claimton", {
    adoptedCodes: [{ family: "electrical", code: "NEC", edition: "2017", origin: "operator" }],
    researchProvenance: { ...grounded, at: new Date().toISOString() },
  }));
  assert.equal(payloadOf(CP.codeProfileKey({ state: "ZO", ahj: "City of Claimton" }))?.adoptedCodes[0]?.origin, "research", "a research result's 'operator' origin was stored");
  await CP.runCodeResearch(db, { state: "ZO", ahj: "" }, fakeResearcher([{ family: "electrical", code: "NEC", edition: "2023", sourceUrl: "https://zo.example.gov" }], true, { adoptionModel: { model: "statewide_minimum_local_amend" } }).provider);
  assert.deepEqual(codesOf(CP.getCodeProfile(db, { state: "ZO", ahj: "City of Claimton" })), ["NEC 2023"], "a research result's 'operator' origin outranked the state's minimum");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// B4
// ─────────────────────────────────────────────────────────────────────────────────────────
await check("B4: canonical families — one predicate for every state's code names", () => {
  const cases: Array<[CodeEdition | string, string | undefined]> = [
    ["ORSC", "residential"], ["OSSC", "building"], ["OESC", "electrical"], ["OFC", "fire"], ["OMSC", "mechanical"], ["OPSC", "plumbing"], ["OEESC", "energy"],
    ["CRC", "residential"], ["CBC", "building"], ["FBC-R", "residential"], ["RCNYS", "residential"], ["MRC", "residential"], ["UCC-E", "electrical"],
    [{ code: "780 CMR", edition: "2021", basedOn: "2021 IRC with Massachusetts amendments" }, "residential"],
    [{ code: "NMEC", edition: "2020", basedOn: "2020 NEC" }, "electrical"],
    ["FFPC", "fire"], ["ASCE 7-16", undefined],
  ];
  for (const [entry, fam] of cases) assert.equal(F.codeFamilyOf(entry), fam, JSON.stringify(entry));
  // MUST-EXCLUDE: the Florida Fire Prevention Code is NFPA 1, not the IFC — never cited as it.
  assert.equal(F.modelBaseOf({ code: "FFPC" }), "NFPA1");
});

await check("B4: ONE helper answers which edition(s) apply on a date — a phase-in allows both", () => {
  const ossc: CodeEdition[] = [{ family: "building", code: "OSSC", edition: "2025", effectiveDate: "2025-10-01", mandatoryDate: "2026-04-01", previousEdition: "2022" }];
  const during = F.editionsInEffect(ossc, "building", "2026-01-15");
  assert.equal(during.status, "phase_in");
  assert.deepEqual(during.allowed.map((a) => a.edition), ["2025", "2022"]);
  assert.deepEqual(F.editionsInEffect(ossc, "building", "2026-05-01").allowed.map((a) => a.edition), ["2025"]);
  const before = F.editionsInEffect(ossc, "building", "2025-06-01");
  assert.equal(before.status, "previous_in_effect");
  assert.deepEqual(before.allowed.map((a) => a.edition), ["2022"]);
  // An unknown must not read as reassurance.
  assert.equal(F.editionsInEffect(ossc, "fire", "2026-05-01").status, "unknown");
  assert.equal(F.editionsInEffect([{ code: "OFC", edition: "2025" }], "fire", "2026-05-01").status, "undated");
});

await check("B4: an upcoming date that PASSED after the research triggers re-research — once", () => {
  const up = [{ family: "residential" as const, code: "ORSC", edition: "2026", anticipatedDate: "2026-10-01" }];
  assert.equal(F.upcomingDue(up, "2026-09-24", "2026-09-30").length, 0, "not yet");
  assert.equal(F.upcomingDue(up, "2026-09-24", "2026-10-02").length, 1, "passed after the research");
  assert.equal(F.upcomingDue(up, "2026-10-05", "2026-10-06").length, 0, "the research already saw it pass: no loop");
  // Through the decision, on a seeded state row (Washington's reference layer: NEC 2026 due 2026-12-31).
  assert.equal(CP.codeResearchDecision(db, "WA", "", "2026-10-01T00:00:00Z").action, "skip");
  const after = CP.codeResearchDecision(db, "WA", "", "2027-01-02T00:00:00Z");
  assert.equal(after.action, "research");
  assert.equal(after.reason, "upcoming_due");
});

await check("B4: 180 days old -> re-research; fresh -> skip", () => {
  const key = CP.codeProfileKey({ state: "TX", ahj: "City of Agedale" });
  CP.saveResearchedCodeProfile(db, blank("TX", "City of Agedale", { adoptedCodes: [{ family: "residential", code: "IRC", edition: "2021", sourceUrl: "https://agedale.example.gov" }], researchProvenance: { ...grounded, at: new Date().toISOString() } }));
  assert.equal(CP.codeResearchDecision(db, "TX", "City of Agedale").reason, "fresh");
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  db.run("UPDATE jurisdiction_code_profiles SET payload_json = json_set(payload_json, '$.researchProvenance.at', ?) WHERE profile_key = ?", [old, key]);
  assert.equal(CP.codeResearchDecision(db, "TX", "City of Agedale").reason, "older_than_180d");
});

await check("B4 MUST-PASS: the stale VERIFIED Oregon row gets a proposal from the reference data — and is never written", () => {
  const or = payloadOf(OR_KEY)!;
  assert.equal(or.confidence, "verified");
  assert.ok(codesOf(or).includes("IFC 2021"), "fixture: the shipped verified OR row");
  const props = CP.listEditionProposals(db, OR_KEY);
  assert.equal(props.length, 1, `no proposal for the stale verified OR row: ${JSON.stringify(props)}`);
  const byFamily = Object.fromEntries(props[0].changes.map((c) => [c.family, c]));
  assert.equal(byFamily.fire?.current, "IFC 2021");
  assert.match(String(byFamily.fire?.proposed), /^OFC 2025 \(2024 IFC\)/);
  assert.equal(byFamily.building?.current, null, "OSSC is missing from the verified row");
  assert.match(String(byFamily.building?.proposed), /^OSSC 2025/);
  assert.equal(byFamily.residential, undefined, "ORSC 2023 (2021 IRC) already agrees with the row");
  assert.equal(byFamily.electrical, undefined, "OESC 2023 already agrees with the row");
  assert.ok(byFamily.fire.sourceUrl?.includes("oregon.gov/osfm"), "the proposal lost its official source");
  // Surfaced on the listing GET /api/code-profiles returns.
  assert.equal(CP.listCodeProfiles(db).find((p) => p.key === OR_KEY)?.editionProposals?.length, 1);
  // Idempotent: the seeder runs on every open — no second proposal row.
  CP.seedReferenceCodeProfiles(db);
  assert.equal(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'code_profile.edition_proposal' AND details LIKE ?", [`%"profileKey":"${OR_KEY}"%`])?.n), 1);
  assert.ok(codesOf(payloadOf(OR_KEY)).includes("IFC 2021"), "the verified row was written");
});

await check("B4 MUST-PASS: a verified row older than 180 days gets a staleness CHECK whose only output is a proposal", async () => {
  CP.saveVerifiedCodeProfile(db, blank("ZV", "", { adoptedCodes: [{ family: "fire", code: "IFC", edition: "2018" }] }), "tester");
  db.run("UPDATE jurisdiction_code_profiles SET verified_at = ? WHERE profile_key = ?", [new Date(Date.now() - 400 * 86_400_000).toISOString(), ZV_KEY]);
  const d = CP.codeResearchDecision(db, "ZV", "");
  assert.equal(d.action, "verify_check");
  const before = JSON.stringify(payloadOf(ZV_KEY));
  const r = await CP.runCodeResearch(db, { state: "ZV", ahj: "", mode: "verify_check" }, fakeResearcher([{ family: "fire", code: "IFC", edition: "2024", sourceUrl: "https://zv.example.gov/fire" }], true).provider);
  assert.equal(r.saved, false);
  assert.equal(r.newProposal, true, JSON.stringify(r));
  assert.equal(JSON.stringify(payloadOf(ZV_KEY)), before, "the verify check wrote the verified row");
});

await check("B3+B4 MUST-PASS (Coos Bay): after the operator approves the proposal, an Oregon city with no row reads the state's OSSC 2025 / OFC 2025 with the state's citation", () => {
  const read0 = CP.getCodeProfile(db, { state: "OR", ahj: "City of Coquilleview" })!;
  assert.ok(!codesOf(read0).includes("OFC 2025"), "precondition: the verified (stale) row still governs before a person acts");
  const [p] = CP.listEditionProposals(db, OR_KEY);
  const res = CP.applyEditionProposal(db, p.fingerprint, "operator@test");
  assert.equal(res.status, "applied", res.note);
  const or = payloadOf(OR_KEY)!;
  assert.equal(or.confidence, "verified", "approval must be a re-verification");
  assert.ok(Object.keys(or.designCriteria).length + Object.keys(or.prescriptive).length > 0, "approval dropped the row's criteria/limits");
  const read = CP.getCodeProfile(db, { state: "OR", ahj: "City of Coquilleview" })!;
  for (const want of ["OSSC 2025", "OFC 2025", "ORSC 2023", "OESC 2023"]) assert.ok(codesOf(read).includes(want), `${want} missing: ${codesOf(read)}`);
  assert.ok(!codesOf(read).includes("IFC 2021"), "the stale IFC 2021 survived approval");
  assert.ok(codesOf(or).includes("IRC 2021") && codesOf(or).includes("NEC 2023"), `approval replaced families it did not change: ${codesOf(or)}`);
  const ctx = CP.resolveEffectiveCodeContext(db, "OR", "City of Coquilleview");
  const fire = ctx.citationFor("IFC", "1205", "Solar PV systems");
  assert.equal(fire.code, "2025 OFC", `an IFC citation in Oregon reads ${fire.code}`);
  assert.match(fire.adoptionScope, /2024 IFC/);
  assert.match(fire.sourceUrl, /oregon\.gov\/osfm/);
  assert.equal(CP.listEditionProposals(db, OR_KEY).length, 0, "the applied proposal is still pending");
});

await check("B4 MUST-EXCLUDE: an IFC citation never borrows a non-IFC fire code (Florida's FFPC is NFPA 1)", () => {
  const ctx = CP.resolveEffectiveCodeContext(db, "FL", "City of Testmiami2");
  const fire = ctx.citationFor("IFC", "1205", "Solar PV systems");
  assert.ok(!/FFPC/.test(fire.code), `an IFC section was cited as ${fire.code}`);
});

CP.setCodeResearchEnqueuerForTests(null);
CP.setDesignResearchEnqueuerForTests(null);
console.log(failures ? `\ncodeEditionResearch: ${failures} FAILED` : "\ncodeEditionResearch: all checks passed");
process.exit(failures ? 1 : 0);
