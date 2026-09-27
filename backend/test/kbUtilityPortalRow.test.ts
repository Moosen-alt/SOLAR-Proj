// RULE 5 AT THE KB WRITE (close-2 item 7, 2026-09-26): an AHJ-KEYED knowledge row never carries a
// UTILITY interconnection portal. The learn path stamped PGE's PowerClerk login onto every
// (ahj, utility) row a PGE project touched ("or|city of tigard|portland general electric" ->
// pgenm.powerclerk.com); the utility's portal belongs on the utility's own row (state, "", utility)
// or nowhere. Driven through the REAL write path: createProject -> learnFromProject ->
// upsertKnowledge, and the import seam every writer funnels through.
//
// KILL TESTS (each turns this file red):
//   K1 knowledgeBase.upsertKnowledge: drop the utility-URL guard (facts land as given) → (k1)(k3) fail.
//   K2 knowledgeBase.portalFromProject: put the PowerClerk URL back on the AHJ half     → (k1) fails.
//   K3 knowledgeBase.learnFromProject: drop the utility-row write                       → (k2) fails
//      (with K1 also applied; alone, the seam still lands it).
//
// Run: npx tsx backend/test/kbUtilityPortalRow.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("kb-utility-portal-row");
const db = fx.db;
const kb = await import("../src/knowledgeBase");
const { knowledgeProfileKey } = kb;

const row = (key: string) => db.get<{ portal_url: string; portal_name: string; ahj: string; utility: string }>("SELECT portal_url, portal_name, ahj, utility FROM permit_utility_knowledge WHERE profile_key = ?", [key]);

await check("(k1) MUST-EXCLUDE: a PGE project's AHJ row (or|city of tigard|portland general electric) never receives pgenm.powerclerk.com, nor 'PowerClerk' as its portal name", () => {
  fx.newProject({ ahj: "City of Tigard", city: "Tigard", utility: "Portland General Electric" });
  const ahjRow = row(knowledgeProfileKey({ state: "OR", ahj: "City of Tigard", utility: "Portland General Electric" }));
  assert.ok(ahjRow, "the AHJ row was learned");
  assert.ok(!/powerclerk/i.test(ahjRow!.portal_url), `AHJ row portal_url: ${ahjRow!.portal_url}`);
  assert.ok(!/powerclerk/i.test(ahjRow!.portal_name), `AHJ row portal_name: ${ahjRow!.portal_name}`);
});

await check("(k2) MUST-PASS: the utility's portal lands on the UTILITY's own row (or||portland general electric), learned", () => {
  const utilRow = row(knowledgeProfileKey({ state: "OR", ahj: "", utility: "Portland General Electric" }));
  assert.ok(utilRow, "the utility row exists");
  assert.equal(utilRow!.portal_url, "https://pgenm.powerclerk.com/MvcAccount/Login");
  assert.equal(utilRow!.ahj, "");
});

await check("(k3) MUST-EXCLUDE at the seam: an IMPORT / a permit-target write handing an AHJ-keyed row a utility portal URL is refused there too — the URL moves to the utility's row when one is named, nowhere otherwise; a PacifiCorp project's row is clean as well; MUST-PASS: an AHJ portal on an AHJ row is written", () => {
  const r = kb.importSeededAhjKnowledge(db, { state: "OR", ahj: "City of Beaverton", portalName: "PowerClerk", portalUrl: "https://pgenm.powerclerk.com/MvcAccount/Login", notes: "import", sourceLabel: "test" });
  assert.notEqual(r, "skipped_empty");
  const bv = row(knowledgeProfileKey({ state: "OR", ahj: "City of Beaverton", utility: "" }));
  assert.ok(bv && !/powerclerk/i.test(bv.portal_url) && !/powerclerk/i.test(bv.portal_name), `Beaverton row: ${JSON.stringify(bv)}`);
  // An operator's permit-monitor target on a utility portal (the shape production 99ea32c3 had).
  const pid = fx.newProject({ ahj: "City of Wilsonville", city: "Wilsonville", utility: "Consumers Power Coop" });
  kb.learnFromPermitTarget(db, fx.repo.getProjectDetail(db, pid).project, { jurisdiction: "City of Wilsonville", portalName: "PowerClerk", portalUrl: "https://coop-example.powerclerk.com/MvcAccount/Login" });
  const wv = row(knowledgeProfileKey({ state: "OR", ahj: "City of Wilsonville", utility: "Consumers Power Coop" }));
  assert.ok(wv && !/powerclerk/i.test(wv.portal_url) && !/powerclerk/i.test(wv.portal_name), `Wilsonville row: ${JSON.stringify(wv)}`);
  assert.equal(row(knowledgeProfileKey({ state: "OR", ahj: "", utility: "Consumers Power Coop" }))?.portal_url, "https://coop-example.powerclerk.com/MvcAccount/Login", "moved to the utility's own row");
  fx.newProject({ ahj: "City of Coos Bay", city: "Coos Bay", zip: "97420", utility: "Pacific Power" });
  const cb = row(knowledgeProfileKey({ state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power" }));
  assert.ok(cb && !/powerclerk/i.test(cb.portal_url), `Coos Bay row: ${JSON.stringify(cb)}`);
  assert.equal(row(knowledgeProfileKey({ state: "OR", ahj: "", utility: "Pacific Power" }))?.portal_url, "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login");
  assert.equal(kb.importSeededAhjKnowledge(db, { state: "OR", ahj: "City of Quillbrook", portalName: "Oregon ePermitting", portalUrl: "https://aca-oregon.accela.com/oregon/", notes: "import", sourceLabel: "test" }), "imported");
  assert.equal(row(knowledgeProfileKey({ state: "OR", ahj: "City of Quillbrook", utility: "" }))?.portal_url, "https://aca-oregon.accela.com/oregon/");
});

await check("(k4) rule 3 still holds on the utility row: a human-VERIFIED utility row keeps its own portal URL when a learn lands there", () => {
  kb.saveVerifiedUtilityProfile(db, { state: "OR", utility: "Portland General Electric", portalUrl: "https://verified-pge.example/apply", notes: "verified" });
  fx.newProject({ ahj: "City of Tigard", city: "Tigard", utility: "Portland General Electric" });
  assert.equal(row(knowledgeProfileKey({ state: "OR", ahj: "", utility: "Portland General Electric" }))?.portal_url, "https://verified-pge.example/apply");
});

finish("kb-utility-portal-row");
