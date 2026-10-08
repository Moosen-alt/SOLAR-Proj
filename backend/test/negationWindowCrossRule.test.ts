// AN UNRELATED "N/A" ROW DOES NOT DENY THE MENTION BEFORE IT (#242 / #257 review).
//
// affirmedIn (codeReviewRules.ts) reads a 30-character window after each matched phrase for a
// denial, and it joins whitespace — so the next schedule row sits inside that window. #265 first
// accepted "N/A" / "NOT USED" ANYWHERE in the window, and "EV CHARGER: N/A" on the line after a
// real mention denied it: new false blockers on 690.12(B)(2) / 690.12(C) / the 690.13 label, a
// missed manufactured home, false UL 2703 / 61730 and load-path findings, and a text-only
// Powerwall that stopped warning. "N/A" and "NOT USED" now deny only DIRECTLY after the mention.
//
// Every rule that reads through affirmedIn is probed here, on two synthetic jurisdictions.
// Every fixture is SYNTHETIC. No database, no LLM, no network.
//
// Run: npx tsx backend/test/negationWindowCrossRule.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { CodeEdition, JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings, structureType } from "../src/codeReviewRules";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const JURISDICTIONS = [["ZZ", "City of Testville"], ["YY", "Town of Example Mesa"]] as const;
const STRING_INVERTER = { invMake: "SolarEdge", invModel: "SE7600H-US", inverterModel: "SE7600H-US" };

const runIn = (state: string, ahj: string, text: string, snapshot: Record<string, unknown> = {}, prescriptive: Record<string, unknown> = {}): ReviewerFinding[] => {
  const profile: JurisdictionCodeProfile = {
    key: `${state.toLowerCase()}|${ahj.toLowerCase()}|unknown`, state, ahj, confidence: "verified",
    adoptedCodes: [{ code: "NEC", edition: "2020", title: "National Electrical Code" } as CodeEdition], amendments: [],
    designCriteria: {}, prescriptive, fireSetbacks: [], citations: [], updatedAt: "", researchedAt: "2026-09-01T00:00:00.000Z",
  };
  const project = {
    id: "negation-window", state, ahj, utility: "Test Power", homeownerName: "Test Owner", projectAddress: "1 Test St",
    interconnectionMethod: "Load-side breaker",
    parserSnapshot: { mounting: "Roof mount", ...STRING_INVERTER, planSetExtractedText: text, ...snapshot },
  } as unknown as ProjectRecord;
  return evaluateDesignCodeFindings(project, null, buildCodeContext(state, ahj, profile), [], [{ label: "Plan set", text }]);
};
const get = (fs: ReviewerFinding[], id: string) => fs.find((f) => f.id === id);
const sections = (f: ReviewerFinding | undefined) => (f?.codeReferences ?? []).map((r) => r.section);

// The unrelated rows that follow a real mention on a schedule.
const ROWS = ["EV CHARGER: N/A", "HOA: N/A", "GENERATOR: NOT USED"];
const RSD_BASE = "SOLAR PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN";

for (const [state, ahj] of JURISDICTIONS) {
  for (const row of ROWS) {
    check(`MUST-PASS ${state}: listed RSD equipment then '${row}' still answers 690.12(B)(2)`, () => {
      const f = get(runIn(state, ahj, `${RSD_BASE}\nRAPID SHUTDOWN SWITCH AT SERVICE ENTRANCE.\nRSD EQUIPMENT LISTED\n${row}`), "city.elec.rapid-shutdown-edition-evidence");
      assert.ok(!sections(f).includes("690.12(B)(2)"), f?.message);
    });
    check(`MUST-PASS ${state}: the RSD initiator then '${row}' still answers 690.12(C)`, () => {
      const f = get(runIn(state, ahj, `${RSD_BASE}.\nLISTED PV HAZARD CONTROL SYSTEM.\nRAPID SHUTDOWN INITIATOR\n${row}`), "city.elec.rapid-shutdown-edition-evidence");
      assert.ok(!sections(f).includes("690.12(C)"), f?.message);
    });
    check(`MUST-PASS ${state}: the PV system disconnect label then '${row}' still answers 690.13(B)`, () => {
      const f = get(runIn(state, ahj, `LABEL SCHEDULE:\nPV SYSTEM DISCONNECT\n${row}`), "city.elec.labels-edition-missing");
      assert.ok(f, "other labels are still missing, so the finding is expected");
      assert.ok(!sections(f).includes("690.13(B)"), sections(f).join(", "));
    });
    check(`MUST-PASS ${state}: 'EXISTING MOBILE HOME' then '${row}' is still a manufactured home`, () => {
      const project = { id: "mh", state, ahj, parserSnapshot: { mounting: "Roof mount", planSetExtractedText: `EXISTING MOBILE HOME\n${row}` } } as unknown as ProjectRecord;
      assert.equal(structureType(project).kind, "manufactured_home");
    });
    check(`MUST-PASS ${state}: a load path to the footing then '${row}' still answers the manufactured-home load path`, () => {
      const text = `NEW LOADS ARE TRANSFERRED FROM ROOF FRAMING THROUGH THE EXTERIOR WALLS TO THE FOOTING\n${row}`;
      const fs = runIn(state, ahj, text, { structuralCalcText: "HUD manufactured home, 2x2 manufactured trusses @ 24\" o.c.", structureTypeOverride: "manufactured", permitPath: "engineered" });
      assert.ok(!get(fs, "city.struct.manufactured-home-load-path"), get(fs, "city.struct.manufactured-home-load-path")?.message);
    });
    check(`MUST-PASS ${state}: UL 61730 and UL 2703 each followed by '${row}' still answer the listings`, () => {
      const text = `MODULES LISTED TO UL 61730\n${row}\nRACKING SYSTEM LISTED TO UL 2703\n${row}`;
      const f = get(runIn(state, ahj, text, {}, { listingEvidenceRequired: true }), "city.plan.ul-listings-missing");
      assert.equal(f, undefined, f?.message);
    });
    check(`MUST-PASS ${state}: a text-only Powerwall then '${row}' still raises the ESS review`, () => {
      assert.ok(get(runIn(state, ahj, `(1) TESLA POWERWALL 3\n${row}`), "city.ess.details-missing"));
    });
  }
  // Helm re-review: a dash before "NO <word>" is a clause about something else, not a denial.
  check(`MUST-PASS ${state}: 'EXISTING MOBILE HOME - NO BASEMENT' is still a manufactured home`, () => {
    const project = { id: "mh", state, ahj, parserSnapshot: { mounting: "Roof mount", planSetExtractedText: "EXISTING MOBILE HOME - NO BASEMENT" } } as unknown as ProjectRecord;
    assert.equal(structureType(project).kind, "manufactured_home");
  });
  check(`MUST-PASS ${state}: 'RAPID SHUTDOWN INITIATOR - NO ACCESS RESTRICTIONS' still answers 690.12(C)`, () => {
    const f = get(runIn(state, ahj, `${RSD_BASE}.\nLISTED PV HAZARD CONTROL SYSTEM.\nRAPID SHUTDOWN INITIATOR - NO ACCESS RESTRICTIONS`), "city.elec.rapid-shutdown-edition-evidence");
    assert.ok(!sections(f).includes("690.12(C)"), f?.message);
  });
  check(`MUST-PASS ${state}: 'POWERWALL - NO GENERATOR' still raises the ESS review; 'POWERWALL - NO.' does not`, () => {
    assert.ok(get(runIn(state, ahj, "(1) POWERWALL - NO GENERATOR"), "city.ess.details-missing"));
    assert.ok(!get(runIn(state, ahj, "POWERWALL - NO."), "city.ess.details-missing"));
  });
  // The direct denials #242 / #257 asked for still deny.
  check(`MUST-EXCLUDE ${state}: a denial DIRECTLY after the mention still denies it`, () => {
    assert.ok(!get(runIn(state, ahj, "POWERWALL: NOT USED"), "city.ess.details-missing"), "POWERWALL: NOT USED");
    assert.ok(!get(runIn(state, ahj, "ENERGY STORAGE (BATTERY BACKUP): NOT USED"), "city.ess.details-missing"), "(BATTERY BACKUP): NOT USED");
    const f = get(runIn(state, ahj, `${RSD_BASE}.\nRAPID SHUTDOWN INITIATOR AT SERVICE.\n690.12(B)(2)(3) - NOT USED`), "city.elec.rapid-shutdown-edition-evidence");
    assert.ok(sections(f).includes("690.12(B)(2)"), f?.message ?? "no finding");
  });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall negation-window cross-rule checks passed");
