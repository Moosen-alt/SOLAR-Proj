// A FORM SEARCH THAT RUNS OUT OF BUDGET SAYS SO, KEEPS WHAT IT SAW, AND IS NOT RE-RUN BLIND (issue #163).
// Owner live run 2026-10-04: findAhjFormUrl for an Oregon county failed "ms=240012 … err=Request was
// aborted"; the Find request took 385 s and returned nothing actionable. The 240 s ceiling stays; now:
//   (1) the abort returns the leads gathered so far (the URLs the searches had already returned) as
//       not-found detail, with the budget and the number of pages seen — never a bare SDK error;
//   (2) the same search is not re-run in the same pass (a second form type would pay another 4 min),
//       and the attempt is recorded so the NEXT trigger's search is told to try the county or state
//       issuer's forms instead of repeating the broad query; a completed search clears the record;
//   (3) the message the App Docs panel shows reads "timed out after 4 min; N page(s) seen; try Find
//       official form again or upload the blank".
// No network, no model: the SDK stream is a fake that NEVER resolves (only our abort ends it), and
// the acquisition's provider is injected.
//
// KILL TESTS (each verified red by hand with the fix removed):
//   K1 llm.findAhjFormUrl catch: drop the WebSearchAbortedError branch      → A fails (bare "Request was aborted", no leads).
//   K2 ensureAhjFormTemplate: drop the searchPass.timedOut short-circuit    → B fails (two searches in one pass).
//   K3 ensureAhjFormTemplate: drop the timeoutDirective                      → C fails (next search not steered).
//
//   npx tsx backend/test/formSearchTimeout.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AhjFormUrlResult, LLMProvider } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "form-search-timeout-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmp, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "PERMIT_PROCESS_LOOKUP", "UTILITY_FILING_LOOKUP"]) process.env[k] = "off";
for (const k of ["DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "ANTHROPIC_API_KEY", "WEB_RESEARCH_TIMEOUT_MS", "AHJ_FORM_LOOKUP_TIMEOUT_MS"]) delete process.env[k];
process.env.DOCUMENT_FETCH_BROWSER = "0";

const { openDatabase } = await import("../src/db");
const repo = await import("../src/repository");
const auto = await import("../src/ahjFormAuto");
const plan = await import("../src/formAcquisitionPlan");
const { ClaudeLLMProvider, webResearchBudgetMs } = await import("../src/llm");
const db = await openDatabase();

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

// ── A: the provider. A stream that never resolves; our 240 s abort is the only way out ──────────
await check("A the abort returns the leads seen so far, the budget and the page count — not a bare abort; one call, no retry", async () => {
  const BUDGET = webResearchBudgetMs();
  assert.equal(BUDGET, 240000, "the ceiling stays at 240 s");
  const leadA = "https://www.fixture-county.example.gov/building/forms";
  const leadB = "https://www.fixture-county.example.gov/DocumentCenter/View/12/Solar-Permit-Application";
  const read = "https://www.fixture-county.example.gov/building";
  let streams = 0;
  const provider = new ClaudeLLMProvider("sk-ant-test-not-used");
  (provider as unknown as { client: unknown }).client = {
    messages: {
      stream(_params: unknown, opts: { signal?: AbortSignal }) {
        streams++;
        return {
          // What the searches had returned when the budget ran out.
          currentMessage: { content: [
            { type: "server_tool_use", name: "web_search", id: "s1", input: { query: "fixture county solar permit application" } },
            { type: "web_search_tool_result", tool_use_id: "s1", content: [
              { type: "web_search_result", url: leadA, title: "Building Forms | Fixture County" },
              { type: "web_search_result", url: leadB, title: "Solar Permit Application" },
            ] },
            { type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: read } },
          ] },
          finalMessage: () => new Promise((_resolve, reject) => {
            opts.signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")));
          }),
        };
      },
    },
  };
  // Time is the only thing faked: the 240 s abort timer fires at once, every other timer is real.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
    realSetTimeout(fn, ms === BUDGET ? 5 : ms, ...rest)) as typeof setTimeout;
  let r: AhjFormUrlResult;
  try {
    r = await provider.findAhjFormUrl({ ahj: "Fixture County", state: "OR", formType: "permit_application" });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(streams, 1, "the same query is not retried");
  assert.equal(r.lookupFailed, true, "a timeout is 'we could not look', not 'nothing there'");
  assert.deepEqual(r.searchTimeout, { budgetMs: 240000, pagesSeen: 3 });
  assert.match(String(r.lookupError), /^search timed out after 4 min; 3 page\(s\) seen$/);
  assert.doesNotMatch(String(r.lookupError), /aborted/i, "the SDK's words are not the report");
  assert.deepEqual(r.searchResults, [
    { url: leadA, title: "Building Forms | Fixture County" },
    { url: leadB, title: "Solar Permit Application" },
  ], "the leads the searches returned are kept");
  assert.deepEqual(r.candidateUrls, [], "nothing is invented from a partial answer");
});

// ── B/C/D: the acquisition. An injected provider whose search times out ──────────────────────────
const LEADS = ["https://elsewhere.example.com/a", "https://elsewhere.example.com/b"];
let calls: Array<{ formType?: string; knownContext?: string }> = [];
let timeOut = true;
const llm = {
  async findAhjFormUrl(input: { ahj: string; formType?: string; knownContext?: string }): Promise<AhjFormUrlResult> {
    calls.push({ formType: input.formType, knownContext: input.knownContext });
    const base = { provider: "claude" as const, formName: "", candidateUrls: [], formType: input.formType || "permit_application", confidence: "low" as const, notes: "" };
    return timeOut
      ? { ...base, lookupFailed: true, lookupError: "search timed out after 4 min; 7 page(s) seen", searchTimeout: { budgetMs: 240000, pagesSeen: 7 }, searchResults: LEADS.map((url) => ({ url, title: "" })) }
      : { ...base, notes: "No downloadable form; the AHJ files through its portal." };
  },
  async mapAcroFormFields() { return { provider: "claude", textFields: {}, checkboxes: {}, notes: "" }; },
  async mapFlatFormOverlay() { return { provider: "claude", fields: [], signatures: [], notes: "" }; },
} as unknown as LLMProvider;
const project = repo.createProject(db, {
  owner: "Fixture Owner", street: "1 Fixture Rd", city: "Fixtureville", state: "MA", zip: "02451", ahj: "Town of Fixtureville", utility: "Eversource",
  dcKw: "8.1", acKw: "7.6", permitPathOverride: "engineered", mounting: "Roof Mount", structureDescription: "Single-family dwelling",
} as never).project;
const fp = { reader: null, minGapMs: 0 };

await check("B a timed-out search is reported in budget terms with its leads, and is not run again in the same pass", async () => {
  calls = []; timeOut = true;
  const pass: import("../src/ahjFormAuto").FormSearchPass = {};
  const first = await auto.ensureAhjFormTemplate(db, llm, project, "building_application", { formsPage: fp, searchPass: pass });
  const second = await auto.ensureAhjFormTemplate(db, llm, project, "electrical_application", { formsPage: fp, searchPass: pass });
  assert.equal(calls.length, 1, `one search per pass after a timeout (got ${calls.length})`);
  for (const r of [first, second]) {
    assert.equal(r.status, "not_found");
    assert.equal(r.lookupFailed, true);
    assert.equal(r.searchTimeout?.budgetMs, 240000);
    assert.equal(r.searchTimeout?.pagesSeen, 7);
    assert.deepEqual(r.searchTimeout?.leads, LEADS, "the leads are the not-found detail");
    assert.match(r.message, /timed out after 4 min; 7 page\(s\) seen/);
    assert.match(r.message, /Try Find official form again or upload the blank/);
    assert.match(r.message, /elsewhere\.example\.com\/a/, "the leads are named");
    assert.doesNotMatch(r.message, /No downloadable PDF form was found/, "a timeout is not a finding about the AHJ");
  }
  assert.match(second.message, /not run again/);
  assert.ok(plan.recentFormSearchTimeout(project.ahj, project.state), "the attempt is recorded");
});

await check("C the next trigger's search is told the broad one timed out and to try the county / state issuer instead", async () => {
  calls = []; timeOut = false;
  await auto.ensureAhjFormTemplate(db, llm, project, "building_application", { formsPage: fp, searchPass: {} });
  assert.equal(calls.length, 1, "the next trigger searches (once)");
  const ctx = String(calls[0].knownContext || "");
  assert.match(ctx, /previous search for Town of Fixtureville timed out after 4 min \(7 page\(s\) seen\)/);
  assert.match(ctx, /Do not repeat the same broad search/);
  assert.match(ctx, /county's or the state building agency's forms/);
});

await check("D a completed search clears the record — the search after it is not steered", async () => {
  assert.equal(plan.recentFormSearchTimeout(project.ahj, project.state), null);
  calls = [];
  await auto.ensureAhjFormTemplate(db, llm, project, "building_application", { formsPage: fp, searchPass: {} });
  assert.doesNotMatch(String(calls[0]?.knownContext || ""), /timed out/);
});

await check("E the operator's sentence: budget, pages, leads (at most three), what to do", () => {
  const msg = auto.searchTimeoutMessage({ budgetMs: 240000, pagesSeen: 5, leads: ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4"] });
  assert.equal(msg, "The form search timed out after 4 min; 5 page(s) seen (https://a.example/1, https://a.example/2, https://a.example/3). Try Find official form again or upload the blank");
  assert.equal(auto.searchTimeoutMessage({ budgetMs: 90000, pagesSeen: 0, leads: [] }), "The form search timed out after 2 min; 0 page(s) seen. Try Find official form again or upload the blank");
});

if (failures) { console.error(`formSearchTimeout: ${failures} check(s) FAILED`); process.exit(1); }
console.log("formSearchTimeout: all checks passed — a 240 s abort keeps its leads and reports the budget and pages seen; one search per pass after a timeout; the next trigger is steered to the county / state issuer; no network");
process.exit(0);
