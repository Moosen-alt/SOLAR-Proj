// ISSUE #14 — a stage with NO launchable portal and NO explicit MOCK_PORTAL=1 ran the MOCK adapter on
// a production install: selectStagingActor's last line returned "MockPortalAdapter" whenever
// isRealPortal was false, so the run reported "Mock portal staged", the project moved to
// awaiting_human_submit, and staff were shown a staged application that never touched a portal.
// Pins:
//   (a) the dispatch: no portal + no simulation → NoAdapter (surface), with seed on AND off;
//       the mock stays reachable ONLY by the explicit MOCK_PORTAL=1 switch (smoke/rehearsal);
//   (b) end-to-end prepareSubmission with MOCK_PORTAL unset: no mock run, no
//       awaiting_human_submit, and the message names the AHJ / utility as unconfirmed;
//   (c) MUST-PASS: with MOCK_PORTAL=1 the same project still stages to the mock (the smoke's path).
// No network, no browser: no ANTHROPIC_API_KEY (no research), and the recipe runner is stubbed.
//
// KILL TEST: restore `return "MockPortalAdapter"` as selectStagingActor's last line → (a1), (a2),
// (b1), (b2) fail.
//
// Run: npx tsx backend/test/noPortalNoMock.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("no-portal-no-mock");
const { db, repo } = fx;
const chan = await import("../src/portalChannel");

const AHJ = "City of Quillmere Flats";          // synthetic, in no KB row
const UTILITY = "Quillmere Basin Electric";     // synthetic, in no KB row
const noPortal = { hasRecipe: false, isRealPortal: false, isAccela: false, isPowerClerk: false };

// ── (a) the dispatch ─────────────────────────────────────────────────────────────────────────
await check("(a1) no portal + seed on + MOCK_PORTAL unset → NoAdapter, never the mock", () => {
  assert.equal(chan.selectStagingActor({ ...noPortal, autoSeedEnabled: true }), "NoAdapter");
  assert.equal(chan.resolvePortalChannel({ ...noPortal, autoSeedEnabled: true }).channel, "manual");
});
await check("(a2) no portal + seed off + MOCK_PORTAL unset → NoAdapter, never the mock", () => {
  assert.equal(chan.selectStagingActor({ ...noPortal, autoSeedEnabled: false }), "NoAdapter");
  assert.equal(chan.selectStagingActor({ ...noPortal, isAccela: true, autoSeedEnabled: false }), "NoAdapter");
});
await check("(a3) MUST-PASS: explicit MOCK_PORTAL=1 → the mock (smoke / simulated rehearsal)", () => {
  assert.equal(chan.selectStagingActor({ ...noPortal, autoSeedEnabled: false, simulationEnabled: true }), "MockPortalAdapter");
  assert.equal(chan.selectStagingActor({ ...noPortal, autoSeedEnabled: true, simulationEnabled: true }), "MockPortalAdapter");
});

// ── (b) end-to-end, MOCK_PORTAL unset ───────────────────────────────────────────────────────
let ran = false;
fx.stubRunner(async () => { ran = true; return { ok: true, finalSubmitClicked: false, steps: [] }; });
const status = (id: string) => String(repo.getProjectDetail(db, id).project.status ?? "");

for (const [label, track, entity, seed] of [
  ["(b1) permit track, seed off", "building", AHJ, "0"],
  ["(b2) NEM track, seed off", "nem", UTILITY, "0"],
  ["(b3) permit track, seed on", "building", AHJ, "1"],
] as const) {
  await check(`${label}: no portal + MOCK_PORTAL unset → nothing staged, the run names ${entity} as unconfirmed`, async () => {
    const projectId = fx.newProject({ state: "NM", ahj: AHJ, city: "Quillmere Flats", zip: "87002", utility: UTILITY });
    delete process.env.MOCK_PORTAL;
    process.env.PORTAL_AUTOSEED = seed;
    try {
      await repo.prepareSubmission(db, projectId, track).catch((e) => e);
    } finally {
      process.env.MOCK_PORTAL = "1";
      process.env.PORTAL_AUTOSEED = "0";
    }
    assert.equal(ran, false, "no recipe/browser run");
    const run = fx.latestRun(projectId);
    assert.ok(run, "a run row records the refusal");
    const text = JSON.stringify(run);
    assert.ok(!/Mock Portal|Mock portal/i.test(text), `the mock ran: ${text.slice(0, 600)}`);
    assert.equal(run!.status, "failed", text.slice(0, 600));
    assert.notEqual(status(projectId), "awaiting_human_submit");
    const message = String(JSON.parse(String(run!.result_json ?? "{}")).message ?? "");
    assert.ok(message.includes(entity), `message names ${entity}: ${message}`);
    assert.match(message, /No portal URL is known/);
  });
}

// ── (c) the smoke's path still simulates ────────────────────────────────────────────────────
await check("(c1) MUST-PASS: MOCK_PORTAL=1 → the same no-portal project stages to the mock", async () => {
  const projectId = fx.newProject({ state: "NM", ahj: AHJ, city: "Quillmere Flats", zip: "87002", utility: UTILITY });
  process.env.MOCK_PORTAL = "1";
  await repo.prepareSubmission(db, projectId, "building");
  const run = fx.latestRun(projectId);
  assert.match(JSON.stringify(run), /Mock Portal Adapter/);
  assert.equal(status(projectId), "awaiting_human_submit");
});

finish("no portal, no mock (#14)");
