// THE AHJ'S OWN PLACEMENT RULES, AND CODE RESEARCH THAT SURVIVES A TIMEOUT (new-AHJ e2e, 2026-09-26).
//   P  GAP 6: no AHJ of seven had a setback rule on file; the one real correction (Waltham Fire: an
//      access path on the side of the incoming electrical service) is its public checklist item 11.
//      The placement lookup stores a cited, official, verbatim rule on the AHJ's own row (a uniform
//      state's AHJ included) and the reviewer shows it as a CALLOUT to confirm — never a check.
//   T  GAP 9: Iowa City's full code research timed out and nothing was stored. A transient failure
//      gets one lighter pass; only grounded, cited, quoted editions land.
//
//   npx tsx backend/test/e2eGapPlacementResearch.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-gap-placement-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.CODE_RESEARCH = "off";

const { openDatabase } = await import("../src/db");
const CP = await import("../src/codeProfiles");
const { parsePlacementLookup, setPlacementPageReaderForTests, verifyPlacementQuotes } = await import("../src/pvPlacementRules");
const { buildReviewerReport } = await import("../src/reviewerEngine");
type LLMProvider = import("../../shared/src/types").LLMProvider;
type ProjectRecord = import("../../shared/src/types").ProjectRecord;
type WebLookupResult = import("../../shared/src/types").WebLookupResult;

const db = await openDatabase();
let failures = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> => Promise.resolve().then(fn)
  .then(() => { console.log(`  ok   - ${label}`); })
  .catch((err) => { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); });

const W_URL = "https://www.city.waltham.ma.us/sites/g/files/fire-prevention/solar-pv-checklist.pdf";
const W_RULE = "Three-foot access path should, if possible, be clear of incoming electrical service.";
const lookupText = (rules: unknown[]) => JSON.stringify({ rules });
const webResult = (over: Partial<WebLookupResult>): WebLookupResult => ({ text: "", groundedSearches: 3, stopReason: "end_turn", resultUrls: [], pagesRead: 1, fetchedUrls: [], ...over });

// ── P ──────────────────────────────────────────────────────────────────────────────────
await check("P1 MUST-PASS: a cited, official, opened page's rule is kept verbatim", () => {
  const r = parsePlacementLookup(webResult({ text: lookupText([{ kind: "access_pathway", rule: W_RULE, section: "Item 11", sourceUrl: W_URL }]), fetchedUrls: [W_URL] }), { ahj: "Waltham", state: "MA" });
  assert.equal(r.rules.length, 1, JSON.stringify(r));
  assert.equal(r.rules[0].rule, W_RULE);
});

await check("P2 MUST-EXCLUDE: an uncited URL, a solar blog, and a lookup with no grounded search store nothing", () => {
  const uncited = parsePlacementLookup(webResult({ text: lookupText([{ kind: "access_pathway", rule: W_RULE, sourceUrl: W_URL }]), resultUrls: ["https://www.city.waltham.ma.us/other"] }), { ahj: "Waltham", state: "MA" });
  assert.equal(uncited.rules.length, 0, "an uncited rule was kept");
  const blog = "https://www.solarblog.example.com/waltham-fire-setbacks";
  const nonOfficial = parsePlacementLookup(webResult({ text: lookupText([{ kind: "fire_setback", rule: "Waltham requires a 3 ft setback from every ridge.", sourceUrl: blog }]), resultUrls: [blog] }), { ahj: "Waltham", state: "MA" });
  assert.equal(nonOfficial.rules.length, 0, "a blog's rule was kept");
  const memory = parsePlacementLookup(webResult({ groundedSearches: 0, text: lookupText([{ kind: "access_pathway", rule: W_RULE, sourceUrl: W_URL }]), fetchedUrls: [W_URL] }), { ahj: "Waltham", state: "MA" });
  assert.equal(memory.rules.length, 0, "model memory was kept");
});

const provider = (web: Partial<WebLookupResult>, codes?: { webGrounded: boolean; notes: string }): LLMProvider => ({
  async webLookup() { return webResult(web); },
  async researchDesignCriteria() { return { provider: "claude", webGrounded: true, values: [], notes: "" }; },
  async researchJurisdictionCodes(input: { state: string; ahj: string }) {
    return {
      provider: "claude", webGrounded: codes?.webGrounded ?? false, needsHumanVerification: true, notes: codes?.notes ?? "",
      profile: { key: "", state: input.state, ahj: input.ahj, confidence: "seeded", adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
        researchProvenance: { webGrounded: false, method: "model_memory", searches: 0, groundedSearches: 0 } },
    };
  },
} as unknown as LLMProvider);

const project = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "placement-test", state: "MA", ahj: "Waltham", utility: "Eversource", homeownerName: "Test Owner", projectAddress: "1 Test St",
  interconnectionMethod: "Load-side breaker", parserSnapshot: { mounting: "Roof mount" }, ...over,
} as unknown as ProjectRecord);

// The cited page, as a plain client retrieves it (line breaks, &nbsp;, a curly quote — the fold must survive them).
const MASS_URL = "https://www.mass.gov/doc/527-cmr-1-solar-summary/download";
setPlacementPageReaderForTests(async (url) => url === MASS_URL
  ? { ok: true, status: 200, text: "Massachusetts Comprehensive Fire Safety Code summary. Three-foot access path should, if possible, be clear of incoming electrical service." }
  : url === W_URL
  ? { ok: true, status: 200, text: "<h2>Solar PV Checklist</h2><ol><li>Item 11. Three-foot access path should, if possible,\n be clear of&nbsp;incoming electrical service.</li></ol>" }
  : { ok: false, status: 404, text: "" });

await check("P5 MUST-EXCLUDE: a rule whose page does not carry the quote, or whose page cannot be retrieved, is not stored", async () => {
  const other = "https://www.city.waltham.ma.us/fire-department/files/solar-panel-ess-faqs";
  const r = await verifyPlacementQuotes([
    { kind: "fire_setback", rule: "Solar arrays must be set back 5 feet from every ridge.", sourceUrl: W_URL },
    { kind: "fire_setback", rule: "If solar arrays consume more than 33% of all roof planes, provide a 36 inch path.", sourceUrl: other },
    { kind: "access_pathway", rule: W_RULE, sourceUrl: W_URL },
  ]);
  assert.deepEqual(r.rules.map((x) => x.rule), [W_RULE], JSON.stringify(r));
  assert.ok(r.dropped.some((d) => /quote not found/.test(d)) && r.dropped.some((d) => /not retrievable \(status 404\)/.test(d)), JSON.stringify(r.dropped));
});

await check("P6 MUST-EXCLUDE: a state page carrying the same sentence is not stored as Waltham's own rule (the page must name the AHJ)", async () => {
  const r = await verifyPlacementQuotes([{ kind: "access_pathway", rule: W_RULE, sourceUrl: MASS_URL }], { ahj: "Waltham" });
  assert.equal(r.rules.length, 0, JSON.stringify(r));
  assert.ok(r.dropped.some((d) => /does not name Waltham/.test(d)), JSON.stringify(r.dropped));
  const own = await verifyPlacementQuotes([{ kind: "access_pathway", rule: W_RULE, sourceUrl: W_URL }], { ahj: "Waltham City" });
  assert.equal(own.rules.length, 1, "control: Waltham's own host names it");
});

await check("P3 MUST-PASS: the design-criteria job stores Waltham's rule on Waltham's row (a uniform state) and the reviewer shows it as a callout", async () => {
  const r = await CP.runDesignCriteriaResearch(db, { state: "MA", ahj: "Waltham" },
    provider({ text: lookupText([{ kind: "access_pathway", rule: W_RULE, section: "Item 11", sourceUrl: W_URL }]), fetchedUrls: [W_URL] }));
  const placement = r.placement as Record<string, unknown>;
  assert.equal(placement?.saved, true, JSON.stringify(r));
  const ctx = CP.resolveEffectiveCodeContext(db, "MA", "Waltham");
  assert.ok(ctx.fireSetbacks.some((f) => f.description === W_RULE), `not on the read: ${JSON.stringify(ctx.fireSetbacks)}`);
  const f = buildReviewerReport(project(), { codeContext: ctx }).findings.find((x) => x.id === "reviewer.plan.ahj-placement-rules");
  assert.ok(f, "no placement-rule callout");
  assert.equal(f!.severity, "callout");
  assert.equal(f!.evidenceStatus, "weak", "a rule read off a page is not evidence the plan meets it");
  assert.ok(f!.message.includes(W_RULE), f!.message);
  assert.ok(!f!.message.includes("✓") && /not checked against the drawing/.test(f!.message), f!.message);
});

await check("P4 MUST-EXCLUDE: a ground mount gets no roof callout; a reference setback (no research prefix) is not shown; a verified row is not written", async () => {
  const ctx = CP.resolveEffectiveCodeContext(db, "MA", "Waltham");
  assert.ok(!buildReviewerReport(project({ parserSnapshot: { mounting: "Ground mount" } } as never), { codeContext: ctx }).findings.some((x) => x.id === "reviewer.plan.ahj-placement-rules"));
  const refCtx = { ...ctx, fireSetbacks: [{ id: "or-fire-pathways", description: "Oregon pathway rule" }] };
  assert.ok(!buildReviewerReport(project(), { codeContext: refCtx }).findings.some((x) => x.id === "reviewer.plan.ahj-placement-rules"));
  CP.saveVerifiedCodeProfile(db, { key: "", state: "MA", ahj: "Verifiedtown", confidence: "verified", adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "" }, "test");
  const saved = CP.saveResearchedPlacementRules(db, { state: "MA", ahj: "Verifiedtown" }, [{ kind: "access_pathway", rule: W_RULE, sourceUrl: W_URL }]);
  assert.equal(saved.saved, false, "a human-verified row was written");
});

// ── T ──────────────────────────────────────────────────────────────────────────────────
const IC_URL = "https://www.icgov.org/building-codes";
const icCodes = JSON.stringify({ adoptedCodes: [
  { family: "residential", code: "IRC", edition: "2024", sourceUrl: IC_URL, quote: "Iowa City has adopted the 2024 International Residential Code." },
  { family: "electrical", code: "NEC", edition: "2023", sourceUrl: IC_URL, quote: "The 2023 National Electrical Code is in effect." },
  { family: "fire", code: "IFC", edition: "2024", sourceUrl: "https://www.somewhere-else.example.com/x", quote: "2024 IFC" },
] });

await check("T1 MUST-PASS: a timed-out full research gets a lighter pass that stores the cited, quoted editions", async () => {
  const r = await CP.runCodeResearch(db, { state: "IA", ahj: "Iowa City" },
    provider({ text: icCodes, resultUrls: [IC_URL] }, { webGrounded: false, notes: "Not web-grounded — nothing recorded (web search failed: Request timed out.)" }));
  assert.equal(r.saved, true, JSON.stringify(r));
  assert.equal(r.light, true);
  const own = CP.ownCodeProfileRow(db, "IA", "Iowa City")!.profile;
  const labels = own.adoptedCodes.map((c) => `${c.code} ${c.edition}`).sort();
  assert.deepEqual(labels, ["IRC 2024", "NEC 2023"], `stored: ${labels} (the uncited IFC must be dropped)`);
  assert.ok(own.adoptedCodes.every((c) => c.origin === "research" && c.quote), "light editions are research-owned and quoted");
});

await check("T2 MUST-EXCLUDE: a research that searched and found nothing is not retried; an uncited light answer stores nothing", async () => {
  const notTransient = await CP.runCodeResearch(db, { state: "IA", ahj: "Coralville" },
    provider({ text: icCodes, resultUrls: [IC_URL] }, { webGrounded: false, notes: "Not web-grounded — nothing recorded (the answer named no adopted code)" }));
  assert.equal(notTransient.saved, false);
  assert.ok(!notTransient.light, "a non-transient failure was retried");
  const uncited = await CP.runCodeResearch(db, { state: "IA", ahj: "North Liberty" },
    provider({ text: icCodes, resultUrls: ["https://unrelated.example.gov/"] }, { webGrounded: false, notes: "Not web-grounded — nothing recorded (web search failed: 529 overloaded)" }));
  assert.equal(uncited.saved, false, JSON.stringify(uncited));
  assert.equal(CP.ownCodeProfileRow(db, "IA", "North Liberty"), null, "a row was created from uncited editions");
});

setPlacementPageReaderForTests(null);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows keeps the sqlite handle */ }
if (failures) {
  console.error(`\ne2eGapPlacementResearch: ${failures} FAILED`);
  process.exit(1);
}
console.log("\ne2eGapPlacementResearch: all checks passed");
