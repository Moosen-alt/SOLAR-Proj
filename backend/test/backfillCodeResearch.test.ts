// B5 — scripts/backfill-code-research.ts: plan the research of the jurisdictions on file, state first.
//   MUST-PASS: per-state counts (would research / skip-verified / skip-inherits / skip-fresh), the
//     cost basis says whether it was measured; --apply runs the real save path, states before AHJs,
//     never more than 2 at a time, and a stamp row keeps its notes.
//   MUST-EXCLUDE: a DRY-RUN writes NOTHING to the target (opening a DB migrates and seeds, so the
//     dry-run plans on a copy); --apply never writes a human-verified row.
// No network: the researcher is a fake provider. Run: npx tsx backend/test/backfillCodeResearch.test.ts
import "./_isolate"; // FIRST: temp cwd, nothing lands in the repo's backend/data
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CodeEdition, JurisdictionCodeProfile, JurisdictionCodeResearchInput, LLMProvider } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-code-"));
const dbFile = path.join(tmp, "t.sqlite");
process.env.AUTOPILOT_DB_PATH = dbFile;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SKIP_CODE_RESEARCH = "1"; // project creation must not queue research here
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const CP = await import("../src/codeProfiles");
const R = await import("../src/repository");
const B = await import(pathToFileURL(path.join(REPO, "scripts", "backfill-code-research.ts")).href) as typeof import("../../scripts/backfill-code-research");
const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); } catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const blank = (state: string, ahj: string, over: Partial<JurisdictionCodeProfile> = {}): JurisdictionCodeProfile => ({
  key: "", state, ahj, confidence: "seeded", adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {},
  fireSetbacks: [], citations: [], updatedAt: "", ...over,
});
const snapshot = () => JSON.stringify(["jurisdiction_code_profiles", "job_queue", "audit_logs", "llm_calls"].map((t) =>
  db.query(`SELECT * FROM ${t} ORDER BY rowid`)));

// Fixture: TX (local adoption) — a stamp-import row, a verified row, a project's AHJ with no row;
// OR (uniform) — an AHJ row; a state (NY) whose shipped layer is removed so an OPEN would re-seed it.
CP.saveResearchedCodeProfile(db, blank("TX", "Stampburg", { amendments: [{ code: "AHJ", summary: "Structural stamp required: Yes" }], citations: [{ label: "Operator stamp-requirements list (Stamp Summary)", sourceUrl: "" }] }));
CP.saveVerifiedCodeProfile(db, blank("TX", "City of Vaultville", { adoptedCodes: [{ family: "residential", code: "IRC", edition: "2018" }] }), "tester");
R.createProject(db, { owner: "Synthetic Owner", state: "TX", dcKw: "8.4", acKw: "7.7", street: "1 Test Way", city: "Testville", zip: "00000", ahj: "City of Projectburg", utility: "Test Power" } as never);
CP.saveResearchedCodeProfile(db, blank("OR", "City of Uniformton", { amendments: [{ code: "AHJ", summary: "Stamp notes: wet stamp" }], citations: [{ label: "Operator stamp-requirements list (Stamp Summary)", sourceUrl: "" }] }));
const nyKey = CP.codeProfileKey({ state: "NY", ahj: "" });

await check("MUST-PASS: the plan — state first, per-state counts, AHJs only where a family is local", async () => {
  const before = snapshot();
  const plan = await B.planBackfill(db, { states: ["TX", "OR"] });
  assert.equal(snapshot(), before, "planBackfill wrote to the database");
  const tx = plan.tallies.find((t) => t.state === "TX")!;
  const or = plan.tallies.find((t) => t.state === "OR")!;
  assert.equal(tx.model, "local_adoption");
  assert.equal(tx.wouldResearchState, 0, "the reference-seeded TX layer is fresh");
  assert.equal(tx.skipFresh, 1);
  assert.equal(tx.wouldResearchAhj, 2, `TX AHJs: ${JSON.stringify(plan.items.filter((i) => i.state === "TX"))}`);
  assert.equal(tx.wouldResearchAhjWithProjects, 1);
  assert.equal(tx.skipVerified, 1, "the verified TX row is not skip-verified");
  assert.equal(or.skipInherits, 1, "an Oregon AHJ was not skip-inherits");
  assert.equal(or.wouldResearch, 0);
  assert.equal(or.skipVerified, 2, "the verified OR state row and the verified Portland row");
  assert.equal(plan.items[0].layer, "state", "state layers do not come first");
  assert.match(plan.cost.basis, /0 measured/, "the cost basis hides that nothing was measured");
  assert.equal(plan.cost.totalUsd, Number((2 * plan.cost.perCallUsd).toFixed(2)));
  const text = B.formatPlan(plan);
  assert.match(text, /TX \| local_adoption \| 2 \(0\/2\[1\]\)/);
  // --projects-only narrows AHJs to those a project names.
  const narrow = await B.planBackfill(db, { states: ["TX"], projectsOnly: true });
  assert.equal(narrow.tallies[0].wouldResearchAhj, 1);
  // --limit caps research calls, AHJs with projects first.
  const capped = await B.planBackfill(db, { states: ["TX"], limit: 1 });
  assert.equal(capped.totals.wouldResearch, 1);
  assert.equal(capped.items.find((i) => i.action === "research")?.hasProjects, true);
});

await check("MUST-EXCLUDE: a DRY-RUN writes nothing to the target — even where opening the DB would seed", async () => {
  db.run("DELETE FROM jurisdiction_code_profiles WHERE profile_key = ?", [nyKey]); // an open re-seeds this
  const before = snapshot();
  const out: string[] = [];
  const code = await B.main(["--states", "TX,NY"], (s) => out.push(s));
  assert.equal(code, 0, out.join("\n"));
  assert.match(out.join("\n"), /DRY-RUN \(nothing written/);
  assert.match(out.join("\n"), /TOTAL: would research/);
  assert.equal(snapshot(), before, "the dry-run wrote to the target database");
  assert.ok(!db.get("SELECT 1 FROM jurisdiction_code_profiles WHERE profile_key = ?", [nyKey]), "the dry-run's open re-seeded the target");
});

await check("MUST-PASS: --apply runs the real save path, states first, at most 2 at a time; verified untouched; stamp kept", async () => {
  CP.seedReferenceCodeProfiles(db); // restore NY for the rest
  // Enough AHJ work that a concurrency above 2 would show (4 AHJ layers queued behind the state).
  for (const n of ["Stampburg Two", "Stampburg Three"]) CP.saveResearchedCodeProfile(db, blank("TX", n, { amendments: [{ code: "AHJ", summary: "Structural stamp required: Yes" }] }));
  const vaultKey = CP.codeProfileKey({ state: "TX", ahj: "City of Vaultville" });
  const vaultBefore = db.get<{ payload_json: string }>("SELECT payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [vaultKey])!.payload_json;
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];
  const provider = {
    async researchJurisdictionCodes(input: JurisdictionCodeResearchInput) {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(input.ahj ? "ahj" : "state");
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      const codes: CodeEdition[] = [{ family: "residential", code: "IRC", edition: "2021", sourceUrl: "https://example.gov/codes" }];
      return {
        provider: "claude" as const, webGrounded: true, needsHumanVerification: true as const, notes: "",
        profile: blank(input.state, input.ahj, { adoptedCodes: codes, researchProvenance: { webGrounded: true, method: "web_search" as const, at: new Date().toISOString(), searches: 3, groundedSearches: 2 } }),
      };
    },
  } as unknown as LLMProvider;
  // Make the TX state layer due too (memory provenance), so the ordering is observable.
  const txState = CP.codeProfileKey({ state: "TX", ahj: "" });
  db.run("UPDATE jurisdiction_code_profiles SET payload_json = json_set(payload_json, '$.researchProvenance', json('{\"webGrounded\":false,\"method\":\"model_memory\"}')) WHERE profile_key = ?", [txState]);
  const plan = await B.planBackfill(db, { states: ["TX"] });
  assert.equal(plan.tallies[0].wouldResearchState, 1);
  const results = await B.applyBackfill(db, plan, { concurrency: 5, provider, log: () => {} });
  assert.ok(maxInFlight <= 2, `concurrency ${maxInFlight} > 2`);
  assert.equal(order[0], "state", `the state layer did not go first: ${order.join(",")}`);
  assert.ok(results.filter((r) => r.ran).length >= 3, JSON.stringify(results));
  assert.equal(db.get<{ payload_json: string }>("SELECT payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [vaultKey])!.payload_json, vaultBefore, "--apply wrote a verified row");
  const stamp = CP.exactCodeProfileRow(db, "TX", "Stampburg")!.profile;
  assert.ok(stamp.amendments.some((a) => a.summary === "Structural stamp required: Yes"), "the stamp note was lost");
  assert.ok(stamp.adoptedCodes.some((c) => c.edition === "2021"), "the research did not land on the stamp row");
});

console.log(failures ? `\nbackfillCodeResearch: ${failures} FAILED` : "\nbackfillCodeResearch: all checks passed");
process.exit(failures ? 1 : 0);
