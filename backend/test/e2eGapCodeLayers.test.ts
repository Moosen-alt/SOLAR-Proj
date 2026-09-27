// CODE LAYERING (e2e-gap close, 2026-09-26 — the scorer's MF2 / MF3, P15 ifcSetback and P11 ircIbc).
//
//   L0  THE REFERENCE FILE IS FOUND FROM ANY CWD. codeProfiles resolved reference-code-profiles.json
//       against process.cwd(); the scorer's scratch server ran from a private cwd, no state had an
//       adoption model, and every state edition was inherited as the city's code (Scottsdale read
//       Arizona's 2024 IFC, Venus read Texas's 2012 IRC floor). Module-relative now, like
//       processProfiles.ts.
//   (a) a state-layer edition is presented AS the state layer: `layer` + `layerLabel` on the entry
//       ("State default (TX statewide minimum) — <city>'s own adoption not confirmed"; a uniform
//       state's edition is "adopted uniformly"), never as the city's adopted code;
//   (b) a CITED local edition wins its family only; a research entry cited to the STATE's own
//       source (the statute) is the state's rule — never stored on, or read as, the city's edition;
//       beside a cited edition an uncited research entry of the same family is not shown;
//   (c) a research answer of "no adopted code" stores nothing and erases nothing;
//   (d) the fire family follows the same rule (AZ: no state IFC on the city; a cited local one wins).
//   MUST-PASS  the verified Oregon rows read as before; MD / PA cities read the state edition where
//              nothing local is cited — as the state layer; a MN city (no reference model) too.
//
// KILLS (each verified red with the fix removed — see the commit message):
//   K1 referencePath cwd-relative again                 → (L0) fails
//   K2 inheritAdoptedCodes: no layer/layerLabel          → (a1, a2) fail
//   K3 inheritAdoptedCodes: state-host entries kept      → (b2) fails
//   K4 scopeResearchToLayer: state-host entries stored   → (b1) fails
//   K5 inheritAdoptedCodes: cited does not retire uncited→ (b3) fails
//   K6 upsert stores layer fields                        → (p1) fails
//
// Run: npx tsx backend/test/e2eGapCodeLayers.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODE_RESEARCH = "off";
process.env.SEED_TEST_INSTALLER = "false";

const CP = await import("../src/codeProfiles");
const { openDatabase } = await import("../src/db");
const F = await import("../src/codeFamilies");
type JurisdictionCodeProfile = import("../../shared/src/types").JurisdictionCodeProfile;
type CodeEdition = import("../../shared/src/types").CodeEdition;
type LLMProvider = import("../../shared/src/types").LLMProvider;
type Presented = CodeEdition & { layer?: string; layerLabel?: string };

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const grounded = { webGrounded: true, method: "web_search" as const, searches: 4, groundedSearches: 3, resultUrls: ["https://codes.example.gov/adopted"] };
const research = (state: string, ahj: string, codes: CodeEdition[], over: Partial<JurisdictionCodeProfile> = {}): JurisdictionCodeProfile => ({
  key: "", state, ahj, confidence: "seeded", adoptedCodes: codes, amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  researchProvenance: { ...grounded, at: new Date().toISOString() }, ...over,
} as JurisdictionCodeProfile);
const fakeResearcher = (codes: CodeEdition[], webGrounded: boolean, extra: Partial<JurisdictionCodeProfile> = {}): LLMProvider => ({
  async researchJurisdictionCodes(input: { state: string; ahj: string }) {
    return {
      provider: "claude" as const,
      profile: research(input.state, input.ahj, codes, { ...extra, researchProvenance: webGrounded ? { ...grounded, at: new Date().toISOString() } : { webGrounded: false, method: "model_memory" as const, searches: 1, groundedSearches: 0 } }),
      webGrounded, needsHumanVerification: true as const, notes: "",
    };
  },
} as unknown as LLMProvider);
const codesOf = (p: { adoptedCodes: CodeEdition[] } | null) => (p?.adoptedCodes ?? []).map((c) => `${c.code} ${c.edition}${c.inheritedFrom ? "(state)" : ""}`);
const ofFamily = (p: JurisdictionCodeProfile | null, family: string): Presented[] => (p?.adoptedCodes ?? []).filter((c) => F.codeFamilyOf(c) === family) as Presented[];
const payloadOf = (state: string, ahj: string) => {
  const r = db.get<{ payload_json: string }>("SELECT payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [CP.codeProfileKey({ state, ahj })]);
  return r ? JSON.parse(r.payload_json) as { adoptedCodes: Presented[] } : null;
};

// ── L0 ─────────────────────────────────────────────────────────────────────────────────
await check("L0 MUST-PASS: the reference file is found with NO env override from a foreign cwd (the scorer's server cwd)", () => {
  const saved = process.env.CODE_PROFILE_REFERENCE_PATH;
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-cwd-"));
  const cwd = process.cwd();
  // A state whose row is NOT in the database answers from the reference file alone (the scorer's
  // server seeded nothing, because the file was unreadable from its cwd).
  db.run("DELETE FROM jurisdiction_code_profiles WHERE profile_key = ?", [CP.codeProfileKey({ state: "VA", ahj: "" })]);
  try {
    delete process.env.CODE_PROFILE_REFERENCE_PATH;
    process.chdir(foreign);
    CP.resetReferenceCacheForTests();
    assert.ok(CP.stateAdoptionModel(db, "VA"), "VA's adoption model did not load from the reference file from a foreign cwd");
    assert.equal(F.familyAdoptionModel(CP.stateAdoptionModel(db, "TX"), "electrical"), "statewide_minimum_local_amend");
  } finally {
    process.chdir(cwd);
    process.env.CODE_PROFILE_REFERENCE_PATH = saved;
    CP.resetReferenceCacheForTests();
  }
});

// ── (b) Venus-shaped ───────────────────────────────────────────────────────────────────
const VENORIA = "City of Venoria";
const CITY = "https://www.cityofvenoria.org/building-permits";
const MYGOV = "https://public.mygov.us/venoria_tx/codes";
const STATUTE = "https://statutes.capitol.texas.gov/Docs/LG/htm/LG.214.htm";
await check("b1 MUST-EXCLUDE: a research entry cited to the STATE's own statute is not stored on the city's row (the 2012 IRC floor read as Venus's code)", () => {
  CP.saveResearchedCodeProfile(db, research("TX", VENORIA, [
    { family: "building", code: "IBC", edition: "2021", sourceUrl: CITY, quote: "Ordinance 755-2022-04 adopting the 2021 International Building Code." },
    { family: "residential", code: "IRC", edition: "2012", title: "code as it existed May 1, 2012", sourceUrl: STATUTE, quote: "the International Residential Code, as it existed on May 1, 2012, is adopted as a municipal residential building code in this state." },
    { family: "residential", code: "IRC", edition: "2018", sourceUrl: CITY },
    { family: "electrical", code: "NEC", edition: "2020", sourceUrl: MYGOV, quote: "The City of Venoria has Adopted the 2020 NEC." },
  ]), { families: ["residential", "building", "electrical"] });
  const stored = codesOf(payloadOf("TX", VENORIA) as never);
  assert.ok(!stored.includes("IRC 2012"), `the statute's floor was stored as the city's: ${stored}`);
  assert.ok(stored.includes("IBC 2021") && stored.includes("NEC 2020") && stored.includes("IRC 2018"), `the city's own entries were lost: ${stored}`);
});
await check("b2 MUST-EXCLUDE: even a stored state-sourced entry is never read as the city's edition; the state's floor is not shown beside the cited IBC", () => {
  // Put the floor on the row by hand (a row written before this rule) and read.
  const key = CP.codeProfileKey({ state: "TX", ahj: VENORIA });
  const row = db.get<{ payload_json: string }>("SELECT payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [key])!;
  const payload = JSON.parse(row.payload_json) as { adoptedCodes: CodeEdition[] };
  payload.adoptedCodes.push({ family: "residential", code: "IRC", edition: "2012", origin: "research", sourceUrl: STATUTE, quote: "as it existed on May 1, 2012" });
  db.run("UPDATE jurisdiction_code_profiles SET payload_json = ? WHERE profile_key = ?", [JSON.stringify(payload), key]);
  const read = CP.getCodeProfile(db, { state: "TX", ahj: VENORIA })!;
  assert.deepEqual(ofFamily(read, "building").map((c) => `${c.code} ${c.edition}`), ["IBC 2021"]);
  assert.ok(!ofFamily(read, "residential").some((c) => c.edition === "2012"), `the floor is read as the city's residential code: ${codesOf(read)}`);
  assert.deepEqual(ofFamily(read, "electrical").map((c) => `${c.code} ${c.edition}`), ["NEC 2020"], `the cited local NEC did not win: ${codesOf(read)}`);
});
await check("b3 MUST-PASS: a CITED local edition for a family retires an uncited research entry of that family only", () => {
  const before = ofFamily(CP.getCodeProfile(db, { state: "TX", ahj: VENORIA }), "residential").map((c) => c.edition);
  assert.deepEqual(before, ["2018"], `precondition: the uncited 2018 reads while nothing cited exists (${before})`);
  CP.saveResearchedCodeProfile(db, research("TX", VENORIA, [
    { family: "residential", code: "IRC", edition: "2021", sourceUrl: CITY, quote: "Ordinance 755-2022-04 adopting the 2021 International Residential Code." },
    { family: "residential", code: "IRC", edition: "2018", sourceUrl: CITY },
  ]), { families: ["residential"] });
  const read = CP.getCodeProfile(db, { state: "TX", ahj: VENORIA })!;
  assert.deepEqual(ofFamily(read, "residential").map((c) => c.edition), ["2021"], `the read: ${codesOf(read)}`);
  assert.deepEqual(ofFamily(read, "building").map((c) => c.edition), ["2021"], "the other family is untouched");
});

// ── (a) the state layer is said to be the state layer ─────────────────────────────────
await check("a1 MUST-PASS: a TX city with no local NEC reads the state's 2026 NEC AS the state layer — 'state default … not confirmed', never as its adopted code", () => {
  const read = CP.getCodeProfile(db, { state: "TX", ahj: "City of Nolocal" })!;
  const nec = ofFamily(read, "electrical")[0];
  assert.ok(nec && nec.edition === "2026" && nec.inheritedFrom === "state", `TX NEC not inherited: ${codesOf(read)}`);
  assert.equal(nec.layer, "state_minimum", JSON.stringify(nec));
  assert.match(String(nec.layerLabel), /State default \(TX statewide minimum\)/);
  assert.match(String(nec.layerLabel), /City of Nolocal.*not confirmed/);
  assert.deepEqual(ofFamily(read, "residential"), [], `a local-adoption family shows the state floor: ${codesOf(read)}`);
  // The citation the reviewer prints carries the same layer statement.
  const cite = CP.resolveEffectiveCodeContext(db, "TX", "City of Nolocal").citationFor("NEC", "690.12", "Rapid shutdown");
  assert.match(cite.adoptionScope, /State default \(TX statewide minimum\)/, cite.adoptionScope);
  // The state-level read (no AHJ asked) carries no layer statement: it IS the state.
  const state = CP.getCodeProfile(db, { state: "TX", ahj: "" })!;
  assert.ok(state.adoptedCodes.every((c: Presented) => !c.layer && !c.layerLabel && !c.inheritedFrom), "the state read is labelled as inherited from itself");
});
await check("a2 MUST-PASS: a state with true statewide adoption (MD, PA) still shows the state edition where nothing local is cited — as the state layer", () => {
  const md = CP.getCodeProfile(db, { state: "MD", ahj: "City of Chesapeake Falls" })!;
  const irc = ofFamily(md, "residential")[0];
  assert.ok(irc && irc.edition === "2021" && irc.layer === "state_minimum", `MD IRC: ${JSON.stringify(irc)}`);
  const fire = ofFamily(md, "fire")[0];
  assert.ok(fire && fire.layer === "state_uniform" && /adopted uniformly/.test(String(fire.layerLabel)), `MD fire (uniform): ${JSON.stringify(fire)}`);
  const pa = CP.getCodeProfile(db, { state: "PA", ahj: "City of Elk Hollow" })!;
  const paIrc = ofFamily(pa, "residential")[0];
  assert.ok(paIrc && paIrc.edition === "2021" && paIrc.inheritedFrom === "state" && /not confirmed/.test(String(paIrc.layerLabel)), `PA IRC: ${JSON.stringify(paIrc)}`);
});
await check("a3 MUST-PASS: a state the reference does not model (MN) — a city reads the state row's edition as 'State default — <city> not confirmed'", () => {
  CP.saveResearchedCodeProfile(db, research("MN", "", [{ family: "electrical", code: "NEC", edition: "2023", sourceUrl: "https://www.dli.mn.gov/electrical-codes", quote: "the 2023 NEC" }]));
  const read = CP.getCodeProfile(db, { state: "MN", ahj: "City of Lakeshore" })!;
  const nec = ofFamily(read, "electrical")[0];
  assert.ok(nec && nec.inheritedFrom === "state" && nec.layer === "state_default", JSON.stringify(nec));
  assert.equal(nec.layerLabel, "State default — City of Lakeshore not confirmed");
});

// ── (c) "no adopted code found" erases nothing ─────────────────────────────────────────
const SAGUARO = "City of Saguaro Mesa";
const AZCITY = "https://www.saguaromesaaz.gov/codes";
await check("c1 MUST-PASS: a city research answering 'no adopted code' leaves the row's cited editions exactly as they were (save path and job path)", async () => {
  CP.saveResearchedCodeProfile(db, research("AZ", SAGUARO, [
    { family: "electrical", code: "NEC", edition: "2020", sourceUrl: AZCITY, quote: "the 2020 National Electrical Code with city amendments" },
    { family: "residential", code: "IRC", edition: "2021", sourceUrl: AZCITY, quote: "the 2021 International Residential Code" },
  ]));
  const before = JSON.stringify(payloadOf("AZ", SAGUARO)?.adoptedCodes);
  assert.ok(before.includes("2020") && before.includes("2021"), "fixture");
  CP.saveResearchedCodeProfile(db, research("AZ", SAGUARO, []), { families: ["residential", "building", "electrical", "fire"] });
  assert.equal(JSON.stringify(payloadOf("AZ", SAGUARO)?.adoptedCodes), before, "an empty research save changed the stored editions");
  const r = await CP.runCodeResearch(db, { state: "AZ", ahj: SAGUARO, profileKey: CP.codeProfileKey({ state: "AZ", ahj: SAGUARO }) }, fakeResearcher([], true));
  assert.equal(r.saved, false, JSON.stringify(r));
  assert.equal(JSON.stringify(payloadOf("AZ", SAGUARO)?.adoptedCodes), before, "the job path erased the row");
  const r2 = await CP.runCodeResearch(db, { state: "AZ", ahj: SAGUARO }, fakeResearcher([], true, { adoptionModel: { model: "local_adoption" } }));
  assert.equal(JSON.stringify(payloadOf("AZ", SAGUARO)?.adoptedCodes), before, `an empty research WITH a model erased the row (${JSON.stringify(r2)})`);
  const read = CP.getCodeProfile(db, { state: "AZ", ahj: SAGUARO })!;
  assert.deepEqual(ofFamily(read, "electrical").map((c) => c.edition), ["2020"]);
  assert.deepEqual(ofFamily(read, "residential").map((c) => c.edition), ["2021"]);
});

// ── (d) the fire family ────────────────────────────────────────────────────────────────
await check("d1 MUST-EXCLUDE: an AZ city never reads the state's 2024 IFC as its fire code (AZ adopts locally); a cited local 2021 IFC is the city's", () => {
  const bare = CP.getCodeProfile(db, { state: "AZ", ahj: SAGUARO })!;
  assert.deepEqual(ofFamily(bare, "fire"), [], `the state fire layer reads as the city's: ${codesOf(bare)}`);
  CP.saveResearchedCodeProfile(db, research("AZ", SAGUARO, [{ family: "fire", code: "IFC", edition: "2021", sourceUrl: AZCITY, quote: "Ordinance 4562 adopting the 2021 International Fire Code with amendments" }]), { families: ["fire"] });
  const read = CP.getCodeProfile(db, { state: "AZ", ahj: SAGUARO })!;
  assert.deepEqual(ofFamily(read, "fire").map((c) => `${c.code} ${c.edition}${c.inheritedFrom ? "(state)" : ""}`), ["IFC 2021"], codesOf(read).join(","));
  assert.deepEqual(ofFamily(read, "electrical").map((c) => c.edition), ["2020"], "the fire research did not touch the electrical family");
  // And a no-row AZ city reads no fire edition at all — never the state's.
  assert.deepEqual(ofFamily(CP.getCodeProfile(db, { state: "AZ", ahj: "City of Norow Mesa" }), "fire"), []);
});

// ── MUST-PASS: Oregon unchanged; presentation never persisted ──────────────────────────
await check("p0 MUST-PASS: the verified Oregon state row reads as before, and an Oregon city reads its codes as 'adopted uniformly'", () => {
  const state = CP.getCodeProfile(db, { state: "OR", ahj: "" })!;
  assert.equal(state.confidence, "verified");
  assert.ok(codesOf(state).includes("ORSC 2023"), codesOf(state).join(","));
  assert.ok(state.adoptedCodes.every((c: Presented) => !c.layer), "the state read carries a layer");
  const city = CP.getCodeProfile(db, { state: "OR", ahj: "City of Fernhollow" })!;
  const orsc = city.adoptedCodes.find((c) => c.code === "ORSC") as Presented;
  assert.ok(orsc && orsc.inheritedFrom === "state" && orsc.layer === "state_uniform" && /adopted uniformly/.test(String(orsc.layerLabel)), JSON.stringify(orsc));
  assert.ok(!/not confirmed/.test(String(orsc.layerLabel)), "a uniform state's edition is the city's code by law — never 'not confirmed'");
});
await check("p1 MUST-EXCLUDE: a verify that sends the read back never stores layer / layerLabel / inheritedFrom", () => {
  // A read WITH inherited entries (the state's NEC 2026 on a city with no local NEC).
  const read = CP.getCodeProfile(db, { state: "TX", ahj: "City of Nolocal" })!;
  assert.ok(read.adoptedCodes.some((c: Presented) => c.layer), "precondition: the read carries a layered entry");
  CP.saveVerifiedCodeProfile(db, { ...read, ahj: "City of Nolocal" }, "tester");
  const stored = payloadOf("TX", "City of Nolocal")!.adoptedCodes;
  assert.ok(stored.length > 0 && stored.every((c) => !c.layer && !c.layerLabel && !c.inheritedFrom), JSON.stringify(stored));
  assert.ok(stored.some((c) => c.code === "NEC" && c.edition === "2026"), `a verify keeps what the person saw: ${JSON.stringify(stored)}`);
});

if (failures) { console.error(`\ne2eGapCodeLayers: ${failures} FAILED`); process.exit(1); }
console.log("\ne2eGapCodeLayers: all checks passed");
process.exit(0);
