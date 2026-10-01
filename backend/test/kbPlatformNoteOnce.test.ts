// Issue #15: a researched KB card read "reuse existing PowerClerk (Clean Power Research) — PNM uses
// PowerClerk for … automation; only the entry URL and login differ (reuse existing PowerClerk …
// automation; only the entry URL + login differ per utility)" — the platform template wrapped
// around text that already carried it. Two ways in, both pinned here through the REAL savers:
//   · the model answers portalPlatform with prose (the research prompt and the KB hint both say
//     "reuse existing … only the entry URL + login differ"), and the saver templated it verbatim;
//   · the platform sentence lived INSIDE the one research blob segment, so a re-research whose
//     platform (or any tip) differed kept a second blob and a second platform sentence.
// Rule 3: a human-verified row keeps its own platform sentence and portal_platform.
//
// KILL TESTS (each turns this file red):
//   K1 portalPlatformLabel returns its input unchanged          → (p1) fails.
//   K2 the savers put the platform sentence back inside the blob → (p2)(p3) fail.
//   K3 mergeNoteSegments stops replacing platform segments       → (p2)(p3)(p4) fail.
//
// Run: npx tsx backend/test/kbPlatformNoteOnce.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-platform-note-once-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.SKIP_CODE_RESEARCH = "1";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const kb = await import("../src/knowledgeBase");
const db = await openDatabase();

let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

const utilityResearch = (portalPlatform: string, tip: string) => ({
  provider: "stub" as const, portalName: "PowerClerk", portalPlatform, portalUrl: "", submissionMethod: "Online portal",
  requiredDocuments: [], smartInverterSettings: "", meterAggregation: "", acDisconnectRule: "", exportLimitNote: "",
  commonCorrections: [], tips: [tip], submissionSteps: [], confidence: "medium" as const, needsHumanVerification: true, notes: "",
  webGrounded: true,
});
const ahjResearch = (portalPlatform: string, tip: string) => ({
  provider: "stub" as const, portalName: "Citizen Access", portalPlatform, portalUrl: "", submissionMethod: "Online portal",
  requiredDocuments: [], commonCorrections: [], tips: [tip], submissionSteps: [], confidence: "medium" as const,
  needsHumanVerification: true, notes: "", webGrounded: true,
});
const row = (key: string) => db.get<{ notes: string; portal_platform: string }>(
  "SELECT notes, portal_platform FROM permit_utility_knowledge WHERE profile_key = ?", [key])!;
const count = (s: string, needle: RegExp) => (s.match(new RegExp(needle.source, "gi")) || []).length;

// The live shape: the model's portalPlatform already carries the reuse sentence.
const ECHOED = "PowerClerk (Clean Power Research) — Example Utility uses PowerClerk for interconnection automation; only the entry URL and login differ (reuse existing PowerClerk automation; only the entry URL + login differ per utility)";

await run("(p1) a prose portalPlatform is cut to its label: the note says 'reuse existing' once, portal_platform is the label", () => {
  assert.equal(kb.portalPlatformLabel(ECHOED), "PowerClerk (Clean Power Research)");
  assert.equal(kb.portalPlatformLabel("Portal platform: Accela (reuse existing Accela portal automation; only the entry URL + login differ per AHJ)."), "Accela");
  assert.equal(kb.portalPlatformLabel("Tyler EnerGov"), "Tyler EnerGov", "a plain label is untouched");
  kb.saveResearchedUtilityProfile(db, { state: "NM", utility: "Example Utility Co" }, utilityResearch(ECHOED, "Upload the one-line first."));
  const r = row(kb.knowledgeProfileKey({ state: "NM", ahj: "", utility: "Example Utility Co" }));
  assert.equal(count(r.notes, /reuse existing/), 1, r.notes);
  assert.equal(r.portal_platform, "PowerClerk (Clean Power Research)");
});

await run("(p2) re-researching a utility (platform worded differently, different tips) leaves ONE platform sentence — the latest", () => {
  kb.saveResearchedUtilityProfile(db, { state: "NM", utility: "Example Utility Co" }, utilityResearch("PowerClerk", "Sign the agreement last."));
  const r = row(kb.knowledgeProfileKey({ state: "NM", ahj: "", utility: "Example Utility Co" }));
  assert.equal(count(r.notes, /Portal platform:/), 1, r.notes);
  assert.equal(count(r.notes, /reuse existing/), 1, r.notes);
  assert.ok(r.notes.includes("Portal platform: PowerClerk (reuse existing PowerClerk automation"), r.notes);
});

await run("(p3) the same for an AHJ re-research", () => {
  const input = { state: "NM", ahj: "City of Exampleton" };
  kb.saveResearchedAhjProfile(db, input, ahjResearch("Accela", "Tip one."));
  kb.saveResearchedAhjProfile(db, input, ahjResearch("Accela Citizen Access", "Tip two."));
  kb.saveResearchedAhjProfile(db, input, ahjResearch("Accela Citizen Access", "Tip two."));
  const r = row(kb.knowledgeProfileKey({ state: "NM", ahj: "City of Exampleton", utility: "" }));
  assert.equal(count(r.notes, /Portal platform:/), 1, r.notes);
  assert.ok(r.notes.includes("Portal platform: Accela Citizen Access (reuse existing"), r.notes);
});

await run("(p4) a LEGACY research blob with the platform sentence inside it is cleaned when the row is re-researched", () => {
  const legacy = `AI-researched utility NEM profile — verify against the utility's official interconnection page before relying on it. Portal platform: ${ECHOED} (reuse existing ${ECHOED} automation; only the entry URL + login differ per utility). Submission: Online portal. Tips: Old tip.`;
  kb.importSeededUtilityKnowledge(db, { state: "NM", utility: "Legacy Electric", notes: legacy, sourceLabel: "test" });
  kb.saveResearchedUtilityProfile(db, { state: "NM", utility: "Legacy Electric" }, utilityResearch("PowerClerk", "New tip."));
  const r = row(kb.knowledgeProfileKey({ state: "NM", ahj: "", utility: "Legacy Electric" }));
  assert.equal(count(r.notes, /Portal platform:/), 1, r.notes);
  assert.equal(count(r.notes, /reuse existing/), 1, r.notes);
  assert.ok(r.notes.includes("Tips: Old tip."), `the rest of the legacy blob is kept: ${r.notes}`);
});

await run("(p5) rule 3: a human-VERIFIED row keeps its platform sentence and portal_platform; research adds no second one", () => {
  kb.saveVerifiedUtilityProfile(db, { state: "NM", utility: "Verified Power", portalPlatform: "PowerClerk", notes: "Checked by a person." });
  const key = kb.knowledgeProfileKey({ state: "NM", ahj: "", utility: "Verified Power" });
  const before = row(key);
  kb.saveResearchedUtilityProfile(db, { state: "NM", utility: "Verified Power" }, utilityResearch("Salesforce", "Research tip."));
  const after = row(key);
  assert.equal(after.portal_platform, "PowerClerk");
  assert.ok(after.notes.startsWith(before.notes), `verified segments untouched: ${after.notes}`);
  assert.equal(count(after.notes, /Portal platform:/), 1, after.notes);
  assert.ok(!/Salesforce/.test(after.notes), after.notes);
});

db.close?.();
if (failures) {
  console.error(`FAIL - kb-platform-note-once: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("ok   - kb-platform-note-once");
