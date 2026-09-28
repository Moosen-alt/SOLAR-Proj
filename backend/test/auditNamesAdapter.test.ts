// THE AUDIT NAMES THE PORTAL THE RUN REALLY DROVE — AND ONLY THE AUDIT CHANGES (dry run 2026-09-28, B12).
//
// prepareSubmission's `portalType` is the portal_profiles row's type, "mock" when there is none, and
// nothing in the app writes portal_profiles — so 45 of 45 real staging runs (Accela, PowerClerk) were
// audited `portalType: "mock"`. That variable must NOT be "fixed": it keys the credential lookup, the
// per-client browser profile directory (renaming it logs every client out of every portal, and MFA
// would pause the company account's runs), the staging overlay and the field resolver. The audit gets
// its own value from the dispatch decision instead.
//
// Pinned through the real prepareSubmission, browser stubbed (_stageFixture):
//   1 MUST-EXCLUDE — the mock adapter's run is audited "mock".
//   2 THE POINT    — a recipe replay is audited with the host it drove and the adapter's name, not "mock".
//   3 MUST-PASS    — the run's browser profile directory is unchanged (still keyed by portalType).
//
// KILL (verified by hand): the audit writing `portalType` again -> 2 FAILS.
//
//   npx tsx backend/test/auditNamesAdapter.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import path from "node:path";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("audit-names-adapter");
const { db, repo } = fx;

const stagedAudit = (projectId: string) => {
  const row = db.get<{ details: string; actor_name: string }>(
    "SELECT details, actor_name FROM audit_logs WHERE project_id = ? AND action = 'portal.staged_to_review' ORDER BY created_at DESC LIMIT 1", [projectId]);
  return row ? { ...JSON.parse(row.details), actorName: row.actor_name } as Record<string, unknown> : null;
};

let seenUserDataDir = "";
fx.stubRunner(async (_recipe, _project, _fields, _docs, _files, options) => {
  seenUserDataDir = String((options as { userDataDir?: string }).userDataDir ?? "");
  return { ok: true, finalSubmitClicked: false, steps: [{ ok: true, message: "reached review" }] } as never;
});

await check("(1) MUST-EXCLUDE: a run the MOCK adapter drove is audited portalType 'mock'", async () => {
  const pid = fx.newProject();
  await repo.prepareSubmission(db, pid);
  const a = stagedAudit(pid);
  assert.ok(a, "setup: no portal.staged_to_review audit row");
  assert.equal(a!.adapter, "MockPortalAdapter", JSON.stringify(a));
  assert.equal(a!.portalType, "mock");
});

await check("(2) THE POINT: a recipe replay is audited with the host it drove and the adapter's name — never 'mock'", async () => {
  fx.completeRecipe();
  const pid = fx.newProject();
  await repo.prepareSubmission(db, pid);
  const a = stagedAudit(pid);
  assert.ok(a, "setup: no portal.staged_to_review audit row");
  assert.equal(a!.adapter, "RecipeAdapter", JSON.stringify(a));
  assert.equal(a!.actorName, "RecipeAdapter");
  assert.notEqual(a!.portalType, "mock", "a real adapter's run is audited as the mock portal");
  assert.equal(a!.portalType, "permits.portland.example", JSON.stringify(a));
});

await check("(3) MUST-PASS: the browser profile directory is still keyed by portalType ('mock' with no stored profile) — no client is logged out", () => {
  assert.ok(seenUserDataDir, "setup: the runner saw no userDataDir");
  assert.equal(path.basename(seenUserDataDir), "mock", seenUserDataDir);
});

finish("audit-names-adapter");
