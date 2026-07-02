// Hybrid review packs: deterministic solar keeps the engine path; AI-served work
// types produce ADVISORY-ONLY reports (category ai_review, severity hard-capped at
// warning — an AI observation can never become a blocker). Mocked LLM, no network.
// Run: tsx backend/test/reviewPacks.test.ts
import assert from "node:assert/strict";
import type { AiPlanReviewResult, LLMProvider, ProjectRecord } from "../../shared/src/types";
import { REVIEW_PACKS, reviewPackFor, runReviewPack, aiResultToFindings, codeSummaryForPrompt } from "../src/reviewPacks";
import { buildCodeContext } from "../src/codeProfiles";

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

const ctx = buildCodeContext("ID", "Elmore County", {
  key: "id|elmore county|unknown", state: "ID", ahj: "Elmore County", confidence: "seeded",
  adoptedCodes: [{ code: "IRC", edition: "2018" }, { code: "NEC", edition: "2023" }],
  amendments: [{ code: "IRC", section: "R507", summary: "County deck ledger amendment." }],
  designCriteria: { groundSnowLoadPsf: 35, frostDepthIn: 24 },
  prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
});

const project = {
  id: "pack-test-1", clientId: null, homeownerName: "Pack Test", projectAddress: "1 Deck Ln",
  city: "Mountain Home", state: "ID", ahj: "Elmore County", utility: "Idaho Power",
  parserSnapshot: {},
} as unknown as ProjectRecord;

function mockLlm(result: Partial<AiPlanReviewResult> & { findings?: unknown[] }): LLMProvider {
  return {
    reviewPlanSetGeneral: async () => result as AiPlanReviewResult,
  } as unknown as LLMProvider;
}

await run("registry: solar is the only deterministic pack; unknown types map to general", () => {
  assert.equal(REVIEW_PACKS.filter((p) => p.deterministic).length, 1);
  assert.equal(reviewPackFor("solar_pv_residential").deterministic, true);
  assert.equal(reviewPackFor("does-not-exist").workType, "general");
});

await run("codeSummaryForPrompt renders adopted codes + amendments + criteria", () => {
  const summary = codeSummaryForPrompt(ctx);
  assert.ok(summary.includes("IRC 2018"));
  assert.ok(summary.includes("LOCAL AMENDMENT IRC R507"));
  assert.ok(summary.includes("ground snow 35 psf"));
});

await run("AI findings are HARD-CAPPED: ai_review category, never blocker, never installer", () => {
  const findings = aiResultToFindings({
    provider: "claude",
    findings: [
      { title: "Missing footing detail", message: "No footing detail shown.", severity: "blocker" as never, codeFamily: "IRC", codeSection: "R507.3" },
      { title: "Guard height unclear", message: "Guard height not dimensioned.", severity: "callout" },
    ],
    summary: "", confidence: "medium", notes: "",
  }, ctx);
  assert.equal(findings.length, 2);
  for (const f of findings) {
    assert.equal(f.category, "ai_review");
    assert.notEqual(f.severity, "blocker", "AI can never mint a blocker");
    assert.equal(f.installerCallout, false);
    assert.ok(f.title.startsWith("[AI pre-review]"));
  }
  assert.equal(findings[0].severity, "warning", "unknown/blocker severities cap to warning");
  const cite = findings[0].codeReferences[0];
  assert.ok(cite.code.includes("2018 IRC"), `adopted edition cited (${cite.code})`);
  assert.ok(/verify locally/i.test(cite.adoptionScope), "seeded profile phrases verify-locally");
});

await run("AI-served work type (deck): advisory-only report, zero blockers", async () => {
  const { report, ai } = await runReviewPack({
    workType: "deck", project, ctx,
    llm: mockLlm({ provider: "claude", findings: [{ title: "Ledger attachment missing", message: "Show ledger fastening.", severity: "warning", codeFamily: "IRC", codeSection: "R507" }], summary: "Mostly complete.", confidence: "medium", notes: "" }),
    extractedText: "deck plan",
  });
  assert.equal(ai?.summary, "Mostly complete.");
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings.filter((f) => f.severity === "blocker").length, 0);
  assert.ok(report.finalSubmitGate.requirements.some((r) => /human plans examiner/i.test(r)));
});

await run("stub LLM: honest 'AI review unavailable' finding, never silent", async () => {
  const { report } = await runReviewPack({
    workType: "general", project, ctx,
    llm: mockLlm({ provider: "stub", findings: [], summary: "", confidence: "low", notes: "AI plan review unavailable — no ANTHROPIC_API_KEY configured." }),
  });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].id, "ai.review.unavailable");
});

await run("solar pack keeps the deterministic engine (blockers intact), AI opinion appends as advisory", async () => {
  const solarProject = { ...project, parserSnapshot: { state: "ID", ahj: "Elmore County" } } as unknown as ProjectRecord;
  const { report } = await runReviewPack({
    workType: "solar_pv_residential", project: solarProject, ctx,
    llm: mockLlm({ provider: "claude", findings: [{ title: "Note", message: "AI note.", severity: "warning" }], summary: "s", confidence: "low", notes: "" }),
    extractedText: "plan text",
    includeAiSecondOpinion: true,
  });
  const deterministicBlockers = report.findings.filter((f) => f.severity === "blocker" && f.category !== "ai_review");
  assert.ok(deterministicBlockers.length > 0, "deterministic blockers present (empty project fixture)");
  assert.ok(report.findings.some((f) => f.category === "ai_review"), "AI second opinion appended");
  assert.equal(report.findings.filter((f) => f.category === "ai_review" && f.severity === "blocker").length, 0);
});

if (failures > 0) {
  console.error(`\n${failures} review-pack test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll review-pack tests passed.");
