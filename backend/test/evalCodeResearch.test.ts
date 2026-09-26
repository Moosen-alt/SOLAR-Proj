// M6 — scripts/eval-code-research.ts asks each AHJ what the PRODUCT asks, and scores only that.
//   MUST-PASS: the researcher input for TX:Mesquite equals codeResearchDecision(db,'TX','Mesquite')
//     .families (on a database the shipped state layers seeded, as the eval's scratch DB is).
//   MUST-EXCLUDE: a family the product would not ask about is never scored as omitted (it is listed
//     as notAsked); an AHJ the product would not research (Oregon: inherits_state) is reported as
//     "not researched by the product" and never sent to the researcher.
// No network: main() takes a fake provider. Run: npx tsx backend/test/evalCodeResearch.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-code-research-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "own.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const CP = await import("../src/codeProfiles");
const E = await import(pathToFileURL(path.join(REPO, "scripts", "eval-code-research.ts")).href) as typeof import("../../scripts/eval-code-research");
const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); } catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// A verified-truth fixture in the eval's format. Mesquite's truth carries an ELECTRICAL edition — a
// family Texas sets for every city, which the product never asks a city about.
const truthDir = path.join(tmp, "truth");
fs.mkdirSync(truthDir);
fs.writeFileSync(path.join(truthDir, "fixture.verified.json"), JSON.stringify({
  group: "fixture", verifiedAsOf: "2026-09-24",
  states: {
    TX: {
      adoptionModel: "local_adoption",
      families: {
        residential: { code: "IRC", edition: "2012", scope: "minimum", url: "https://statutes.capitol.texas.gov/x" },
        electrical: { code: "NEC", edition: "2026", scope: "statewide", url: "https://www.tdlr.texas.gov/x" },
        fire: { scope: "local" },
      },
      upcoming: [],
      ahjs: {
        Mesquite: { inheritsState: false, localEditions: { residential: { edition: "2021" }, fire: { edition: "2021" }, electrical: { edition: "2023" } } },
      },
    },
    OR: {
      adoptionModel: "statewide_uniform",
      families: { residential: { code: "ORSC", edition: "2023", scope: "statewide", url: "https://www.oregon.gov/bcd/x" } },
      upcoming: [],
      ahjs: { "City of Coos Bay": { inheritsState: true, localEditions: {} } },
    },
  },
}), "utf8");

const asked: Array<{ state: string; ahj: string; families?: string[] }> = [];
const provider = {
  async researchJurisdictionCodes(input: Record<string, unknown>) {
    asked.push({ state: String(input.state), ahj: String(input.ahj || ""), ...(Array.isArray(input.families) ? { families: input.families as string[] } : {}) });
    return {
      provider: "claude", webGrounded: true, needsHumanVerification: true, notes: "",
      profile: {
        key: "", state: input.state, ahj: input.ahj, confidence: "seeded", amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
        adoptedCodes: input.ahj
          ? [{ family: "residential", code: "IRC", edition: "2021", sourceUrl: "https://www.cityofmesquite.com/codes" }]
          : [{ family: "residential", code: "IRC", edition: "2012", sourceUrl: "https://statutes.capitol.texas.gov/x" }],
        researchProvenance: { webGrounded: true, method: "web_search", searches: 2, groundedSearches: 2 },
      },
    };
  },
};

const outDir = path.join(tmp, "out");
const code = await E.main(["--truth", truthDir, "--states", "TX", "--ahjs", "TX:Mesquite,OR:City of Coos Bay", "--out", outDir, "--concurrency", "1"], { provider });
const outFile = fs.existsSync(outDir) ? fs.readdirSync(outDir).find((f) => f.endsWith(".json")) : undefined;
const result = outFile ? JSON.parse(fs.readFileSync(path.join(outDir, outFile), "utf8")) as { results: Array<Record<string, unknown>>; summary: Record<string, Record<string, unknown>> } : null;
const mesquite = result?.results.find((r) => r.kind === "ahj" && r.ahj === "Mesquite");
const coos = result?.results.find((r) => r.kind === "ahj" && r.ahj === "City of Coos Bay");

await check("MUST-PASS: the eval asks TX:Mesquite exactly the families codeResearchDecision asks", () => {
  assert.equal(code, 0);
  assert.ok(result, "the eval wrote no result file");
  const decision = CP.codeResearchDecision(db, "TX", "Mesquite");
  assert.equal(decision.action, "research", JSON.stringify(decision));
  const sent = asked.find((a) => a.ahj === "Mesquite");
  assert.ok(sent, `Mesquite was not researched: ${JSON.stringify(asked)}`);
  assert.deepEqual(sent!.families, decision.families, "the eval's request differs from the product's");
  assert.deepEqual(mesquite!.localFamilies, decision.families);
  // Scored in the asked families: residential exact, fire asked and omitted.
  const local = mesquite!.local as Array<{ family: string; editionExact: boolean; omitted: boolean }>;
  assert.ok(local.find((l) => l.family === "residential")?.editionExact, JSON.stringify(local));
  assert.equal(local.find((l) => l.family === "fire")?.omitted, true, "an asked family the research missed is not scored as omitted");
});

await check("MUST-EXCLUDE: a family the product does not ask is never scored as omitted; an inheriting AHJ is not researched", () => {
  const local = mesquite!.local as Array<{ family: string }>;
  // RULING 2026-09-26 (new-AHJ e2e, Venus TX): a Texas city is also asked for the NEC — TDLR's
  // edition is a MINIMUM cities amend, and a cited local adoption beats it — so electrical is asked
  // and scored now. What stays excluded: an inheriting AHJ (below) is not researched at all.
  assert.ok(local.some((l) => l.family === "electrical"), `electrical (a TX minimum cities amend) was not asked: ${JSON.stringify(local)}`);
  assert.deepEqual(mesquite!.notAsked, []);
  assert.equal(coos?.notResearchedByProduct, true, `Coos Bay: ${JSON.stringify(coos)}`);
  assert.equal(coos?.reason, "inherits_state");
  assert.ok(!asked.some((a) => a.ahj === "City of Coos Bay"), "an inheriting AHJ was sent to the researcher");
  assert.equal((result!.summary.ahjs as { denominator: number }).denominator, 1, "the not-researched AHJ entered the AHJ denominator");
});

console.log(failures ? `\nevalCodeResearch: ${failures} FAILED` : "\nevalCodeResearch: all checks passed");
process.exit(failures ? 1 : 0);
