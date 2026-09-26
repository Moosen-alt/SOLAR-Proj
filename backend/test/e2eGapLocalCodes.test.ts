// A CITED LOCAL CODE EDITION BEATS THE STATE DEFAULT (new-AHJ e2e, 2026-09-26, GAP 7).
//
// Venus TX: the city's page says "The City of Venus has Adopted the 2020 NEC." Texas's reference
// layer holds TDLR's 2026 NEC as a statewide MINIMUM cities may amend. The code panel showed 2026,
// and the reviewer told the installer to "Update the plan's governing-codes block" — on a plan that
// correctly said 2020. Three seams:
//   R  the AHJ research ASKS for the amendable (minimum) families when it researches anyway;
//   I  a cited local research entry displaces the state's edition at read (never uniform; never an
//      uncited / wrong-edition / state-sourced entry);
//   F  an unverified profile never tells the installer to change the plan — at most "confirm".
//
//   npx tsx backend/test/e2eGapLocalCodes.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-gap-local-codes-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.CODE_RESEARCH = "off";

const { openDatabase } = await import("../src/db");
const { getCodeProfile, saveResearchedCodeProfile, codeResearchDecision, citedLocalAdoption, buildCodeContext, ahjResearchFamilies } = await import("../src/codeProfiles");
const { evaluateDesignCodeFindings } = await import("../src/codeReviewRules");
type JurisdictionCodeProfile = import("../../shared/src/types").JurisdictionCodeProfile;
type CodeEdition = import("../../shared/src/types").CodeEdition;
type ProjectRecord = import("../../shared/src/types").ProjectRecord;

const db = await openDatabase();
let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const VENUS_URL = "https://www.cityofvenus.org/building-permits";
const VENUS_QUOTE = "The City of Venus has Adopted the 2020 NEC.";
const research = (state: string, ahj: string, codes: CodeEdition[]): JurisdictionCodeProfile => ({
  key: "", state, ahj, confidence: "seeded", adoptedCodes: codes, amendments: [], designCriteria: {}, prescriptive: {},
  fireSetbacks: [], citations: [], updatedAt: "",
  researchProvenance: { webGrounded: true, method: "web_search", notes: "test", at: new Date().toISOString(), searches: 3, groundedSearches: 3 },
} as JurisdictionCodeProfile);
const necOf = (p: JurisdictionCodeProfile | null) => (p?.adoptedCodes ?? []).filter((c) => c.code.toUpperCase() === "NEC").map((c) => c.edition);
const ALL = ["residential", "building", "electrical", "fire", "energy", "mechanical", "plumbing"] as const;

// ── R ──────────────────────────────────────────────────────────────────────────────────
check("R1 MUST-PASS: a Texas city's code research asks for the NEC (a state minimum cities amend)", () => {
  const d = codeResearchDecision(db, "TX", "Town of Venus");
  assert.equal(d.action, "research", JSON.stringify(d));
  assert.ok(d.families?.includes("electrical"), `electrical not asked: ${JSON.stringify(d.families)}`);
  assert.ok(d.families?.includes("residential"), "the local families are still asked");
});

check("R2 MUST-EXCLUDE: a state where every family is uniform or a minimum (PA, MA) still skips the AHJ layer — no new spend", () => {
  for (const [st, ahj] of [["PA", "Corry City"], ["MA", "Waltham"]]) {
    const d = codeResearchDecision(db, st, ahj);
    assert.equal(d.action, "skip", `${st}/${ahj}: ${JSON.stringify(d)}`);
  }
  assert.deepEqual(ahjResearchFamilies({ model: "statewide_minimum_local_amend" }), []);
});

// ── I ──────────────────────────────────────────────────────────────────────────────────
check("I0 control: with no AHJ research, Venus reads Texas's NEC 2026", () => {
  assert.deepEqual(necOf(getCodeProfile(db, { state: "TX", ahj: "Town of Venus" })), ["2026"]);
});

check("I1 MUST-PASS: the city's cited 2020 NEC beats the state's 2026", () => {
  saveResearchedCodeProfile(db, research("TX", "Town of Venus", [
    { code: "NEC", edition: "2020", family: "electrical", sourceUrl: VENUS_URL, quote: VENUS_QUOTE },
    { code: "IRC", edition: "2021", family: "residential", sourceUrl: VENUS_URL, quote: "The City has adopted the 2021 International Residential Code." },
  ]), { families: ["residential", "building", "electrical"] });
  const nec = necOf(getCodeProfile(db, { state: "TX", ahj: "Town of Venus" }));
  assert.deepEqual(nec, ["2020"], `Venus reads ${JSON.stringify(nec)}`);
});

check("I2 MUST-EXCLUDE: an uncited research entry (no quote) does not displace the state's edition", () => {
  saveResearchedCodeProfile(db, research("TX", "City of Uncited", [{ code: "NEC", edition: "2020", family: "electrical", sourceUrl: "https://www.uncited-tx.gov/codes" }]), { families: ["electrical"] });
  assert.deepEqual(necOf(getCodeProfile(db, { state: "TX", ahj: "City of Uncited" })), ["2026"]);
});

check("I3 MUST-EXCLUDE: a quote that does not state the edition, or the STATE's own source, does not qualify", () => {
  const state: CodeEdition[] = [{ code: "NEC", edition: "2026", family: "electrical", sourceUrl: "https://www.tdlr.texas.gov/news/x" }];
  assert.equal(citedLocalAdoption({ code: "NEC", edition: "2020", origin: "research", sourceUrl: VENUS_URL, quote: "The City has adopted the National Electrical Code." }, state), false, "no year");
  assert.equal(citedLocalAdoption({ code: "NEC", edition: "2020", origin: "research", sourceUrl: VENUS_URL, quote: "Permits are issued within 2020 business days." }, state), false, "year without the code");
  assert.equal(citedLocalAdoption({ code: "NEC", edition: "2020", origin: "research", sourceUrl: "https://www.tdlr.texas.gov/other", quote: "the 2020 NEC" }, state), false, "the state's own host");
  assert.equal(citedLocalAdoption({ code: "NEC", edition: "2020", sourceUrl: VENUS_URL, quote: VENUS_QUOTE }, state), false, "no origin (memory-era)");
  assert.equal(citedLocalAdoption({ code: "NEC", edition: "2020", origin: "research", sourceUrl: VENUS_URL, quote: VENUS_QUOTE }, state), true, "control");
});

check("I4 MUST-EXCLUDE: a statewide-UNIFORM state keeps its edition even against a cited local page (Massachusetts)", () => {
  saveResearchedCodeProfile(db, research("MA", "Waltham", [{ code: "NEC", edition: "2020", family: "electrical", sourceUrl: "https://www.city.waltham.ma.us/codes", quote: "Waltham enforces the 2020 NEC" }]), { families: [...ALL] });
  const nec = necOf(getCodeProfile(db, { state: "MA", ahj: "Waltham" }));
  assert.ok(!nec.includes("2020"), `a uniform state's AHJ took a local edition: ${JSON.stringify(nec)}`);
});

// ── F ──────────────────────────────────────────────────────────────────────────────────
const venusProject = {
  id: "venus-test", state: "TX", ahj: "Town of Venus", utility: "Oncor", homeownerName: "Test Owner", projectAddress: "1 Test St",
  interconnectionMethod: "Load-side breaker",
  parserSnapshot: { mounting: "Roof mount", planSetExtractedText: "GOVERNING CODES: 2021 IRC, 2021 IBC, 2020 NEC, 2021 IFC. SYSTEM SIZE: 8 kW DC" },
} as unknown as ProjectRecord;
const texasSeeded = (confidence: "seeded" | "verified"): JurisdictionCodeProfile => ({
  key: "tx|town of venus|unknown", state: "TX", ahj: "Town of Venus", confidence,
  adoptedCodes: [{ code: "IRC", edition: "2021" }, { code: "NEC", edition: "2026", inheritedFrom: "state" }],
  amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
} as JurisdictionCodeProfile);
const basis = (confidence: "seeded" | "verified") =>
  evaluateDesignCodeFindings(venusProject, null, buildCodeContext("TX", "Town of Venus", texasSeeded(confidence)), [], []).find((f) => f.id === "city.code.basis-mismatch");

check("F1 MUST-EXCLUDE: an UNVERIFIED profile never tells the installer to update the plan", () => {
  const f = basis("seeded");
  assert.ok(f, "precondition: the mismatch is still reported (a warning to confirm)");
  assert.ok(!/^Update the plan/i.test(f!.cityFeedback), `installer told to update: ${f!.cityFeedback}`);
  assert.match(f!.cityFeedback, /Confirm with/);
  assert.equal(f!.installerCallout, false, "not an installer callout on an unverified profile");
});

check("F2 MUST-PASS: a human-VERIFIED profile may still ask for the plan to change", () => {
  const f = basis("verified");
  assert.ok(f);
  assert.match(f!.cityFeedback, /^Update the plan's governing-codes block/);
  assert.equal(f!.installerCallout, true);
});

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows keeps the sqlite handle */ }
if (failures) {
  console.error(`\ne2eGapLocalCodes: ${failures} FAILED`);
  process.exit(1);
}
console.log("\ne2eGapLocalCodes: all checks passed");
