// LLM-1: web-grounded research must say when it was NOT web-grounded, and model memory must
// never persist a link. Pins, end to end with the Anthropic client stubbed (no network):
//   · a web-search call that aborts (the production 45s-timeout shape) falls back to a
//     prompt of its OWN that forbids URLs, and the result is webGrounded:false with no
//     portalUrl / sourceUrl / citations;
//   · parseable JSON with ZERO server_tool_use web_search blocks is NOT grounded (the old
//     test was "the JSON parsed");
//   · grounding is read by summarizeWebSearch from the response SHAPE: the attempt count is
//     max(server_tool_use blocks, usage.server_tool_use.web_search_requests), but only a
//     web_search_tool_result with a NON-EMPTY results array grounds an answer — usage-only,
//     error-result (unavailable / too_many_requests / max_uses_exceeded) and empty-result shapes
//     all fall back. The `searched-json` fixture was corrected from `content: []` to a real
//     web_search_result for this reason: under the stricter rule an empty array is ungrounded
//     by design;
//   · the model-memory URL scrub keeps email addresses whole ("permits@cityofx.gov" used to be
//     stored as the dangling "permits@") while still stripping URLs and bare domains;
//   · a response that really searched stays grounded and keeps its URL (must-pass);
//   · the research siblings get findAhjFormUrl's budget and a 4000+ token output cap;
//   · the KB save path records the model-memory marker in the source label and notes and
//     stores no portal URL — including a URL-shaped portalName, which upsertKnowledge would
//     otherwise promote into portal_url;
//   · the code-profile save path writes researchProvenance into payload_json, and a seeded
//     re-save without provenance (reference import merge) cannot launder it away.
// Run: tsx backend/test/researchProvenance.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-provenance-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.SKIP_CODE_RESEARCH = "1";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.WEB_RESEARCH_TIMEOUT_MS;
delete process.env.AHJ_FORM_LOOKUP_TIMEOUT_MS;

const { ClaudeLLMProvider, webResearchBudgetMs, summarizeWebSearch, stripUrlsFromModelMemory } = await import("../src/llm");
const { openDatabase } = await import("../src/db");
const { saveResearchedAhjProfile, saveResearchedUtilityProfile } = await import("../src/knowledgeBase");
const { saveResearchedCodeProfile, codeProfileKey } = await import("../src/codeProfiles");

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

// ---------------------------------------------------------------------------
// Stubbed Anthropic client
// ---------------------------------------------------------------------------
type Call = { hasTools: boolean; system: string; maxTokens: number };
const searchHit = { type: "web_search_result", url: "https://permits.example-city.gov/portal", title: "Permits", encrypted_content: "x", page_age: null };
// searched-json      — the real success shape: server_tool_use + web_search_tool_result with a
//                      NON-EMPTY results array + usage.server_tool_use.web_search_requests.
// blocks-only-json   — same blocks, usage carries no server_tool_use entry.
// usage-only-json    — usage says a search was billed, no blocks are visible.
// error-result-json  — a search was attempted and returned an error object (unavailable).
type WebMode = "abort" | "no-search-json" | "searched-json" | "blocks-only-json" | "usage-only-json" | "error-result-json";

function makeProvider(webMode: WebMode, webJson: unknown, fallbackJson: unknown) {
  const provider = new ClaudeLLMProvider("sk-ant-test-not-a-key");
  const calls: Call[] = [];
  const webTimeouts: number[] = [];
  const msg = (content: unknown[], webSearchRequests?: number) => ({
    content,
    usage: { input_tokens: 1, output_tokens: 1, ...(webSearchRequests != null ? { server_tool_use: { web_search_requests: webSearchRequests, web_fetch_requests: 0 } } : {}) },
    stop_reason: "end_turn",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).client = {
    messages: {
      stream(params: { tools?: unknown[]; system: Array<{ text: string }>; max_tokens: number }) {
        const hasTools = Array.isArray(params.tools) && params.tools.length > 0;
        calls.push({ hasTools, system: params.system.map((b) => b.text).join("\n"), maxTokens: params.max_tokens });
        return {
          async finalMessage() {
            if (hasTools) {
              if (webMode === "abort") throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
              const text = { type: "text", text: JSON.stringify(webJson) };
              if (webMode === "no-search-json") return msg([text]);
              if (webMode === "usage-only-json") return msg([text], 2);
              const use = { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } };
              if (webMode === "error-result-json") {
                return msg([use, { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }, text]);
              }
              const blocks = [use, { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [searchHit] }, text];
              return webMode === "blocks-only-json" ? msg(blocks) : msg(blocks, 1);
            }
            return msg([{ type: "text", text: JSON.stringify(fallbackJson) }]);
          },
        };
      },
    },
  };
  // Record the timeout each research call hands askWithWebSearch (the budget under test).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = provider as any;
  const original = p.askWithWebSearch.bind(provider);
  p.askWithWebSearch = (label: string, system: string, user: string, maxTokens: number, maxUses: number, timeoutMs: number) => {
    webTimeouts.push(timeoutMs);
    return original(label, system, user, maxTokens, maxUses, timeoutMs);
  };
  return { provider, calls, webTimeouts };
}

const ahjJson = {
  portalName: "https://permits.example-city.gov/portal",
  portalPlatform: "Accela",
  portalUrl: "https://permits.example-city.gov/portal",
  submissionMethod: "online portal",
  requiredDocuments: ["Building permit application", "Site plan (see https://example-city.gov/forms/site.pdf)"],
  commonCorrections: ["Missing fire setback"],
  tips: ["Download the checklist from https://example-city.gov/solar-checklist.pdf first"],
  submissionSteps: ["Create an account", "Upload the plan set"],
  confidence: "medium",
};
const utilityJson = {
  portalName: "PowerClerk",
  portalPlatform: "PowerClerk",
  portalUrl: "https://exampleutility.powerclerk.com/MvcAccount/Login",
  submissionMethod: "online portal",
  requiredDocuments: ["One-line diagram"],
  smartInverterSettings: "Yes for UL 1741-SB",
  meterAggregation: "No aggregation",
  acDisconnectRule: "Lockable disconnect",
  exportLimitNote: "",
  commonCorrections: [],
  tips: ["See www.exampleutility.com/interconnect"],
  submissionSteps: ["Apply"],
  confidence: "low",
};
const codesJson = {
  adoptedCodes: [{ code: "IRC", edition: "2021", title: "IRC with state amendments", sourceUrl: "https://codes.example-state.gov/irc", notes: "effective 2024" }],
  amendments: [{ code: "IRC", section: "R324", summary: "Solar setbacks per state", sourceUrl: "https://codes.example-state.gov/r324" }],
  designCriteria: { groundSnowLoadPsf: 25, sourceUrl: "https://county.example.gov/design" },
  prescriptive: { hasPrescriptivePath: false, sourceUrl: "https://codes.example-state.gov/pv" },
  citations: [{ label: "State codes page", sourceUrl: "https://codes.example-state.gov/" }],
  confidenceNotes: "Recalled; see https://codes.example-state.gov for details",
};

const hasUrl = (s: string) => /https?:\/\/|www\.|\.gov\b|\.com\b/i.test(s);

// ---------------------------------------------------------------------------
// LLM layer
// ---------------------------------------------------------------------------
await run("budget: research siblings get findAhjFormUrl's env-overridable budget (180s default)", () => {
  assert.equal(webResearchBudgetMs(), 180000);
  process.env.WEB_RESEARCH_TIMEOUT_MS = "200000";
  assert.equal(webResearchBudgetMs(), 200000);
  delete process.env.WEB_RESEARCH_TIMEOUT_MS;
  process.env.AHJ_FORM_LOOKUP_TIMEOUT_MS = "90000";
  assert.equal(webResearchBudgetMs(), 90000, "the pre-existing findAhjFormUrl override still applies");
  delete process.env.AHJ_FORM_LOOKUP_TIMEOUT_MS;
  process.env.WEB_RESEARCH_TIMEOUT_MS = "1000";
  assert.equal(webResearchBudgetMs(), 45000, "never below the old 45s floor");
  delete process.env.WEB_RESEARCH_TIMEOUT_MS;
});

await run("AHJ research: aborted web search -> own no-URL fallback prompt, webGrounded:false, no portal URL, no links", async () => {
  const { provider, calls, webTimeouts } = makeProvider("abort", ahjJson, ahjJson);
  const r = await provider.researchAhjRequirements({ ahj: "City of Example", state: "ZZ" });
  assert.equal(r.webGrounded, false);
  assert.equal(r.portalUrl, "", "a model-memory portal URL must not come back");
  assert.ok(!hasUrl(r.portalName), `portalName carries a URL: ${r.portalName}`);
  for (const s of [...r.tips, ...r.requiredDocuments, ...r.submissionSteps]) assert.ok(!hasUrl(s), `link survived in "${s}"`);
  const web = calls.find((c) => c.hasTools)!;
  const fallback = calls.find((c) => !c.hasTools)!;
  assert.ok(web && fallback, "expected a web call and a fallback call");
  assert.ok(web.system.includes("FIRST search the web"), "web prompt unchanged");
  assert.ok(!fallback.system.includes("FIRST search the web"), "fallback must not reuse the search-first prompt");
  assert.ok(/NO WEB ACCESS/.test(fallback.system) && /Do NOT output any URL/.test(fallback.system), "fallback forbids URLs");
  assert.ok(web.maxTokens >= 4000 && fallback.maxTokens >= 4000, `max_tokens web=${web.maxTokens} fallback=${fallback.maxTokens}`);
  assert.deepEqual(webTimeouts, [webResearchBudgetMs()], "web call must get the shared research budget, not the 45s default");
});

await run("AHJ research: parseable JSON with ZERO web_search blocks is NOT grounded", async () => {
  const { provider, calls } = makeProvider("no-search-json", ahjJson, ahjJson);
  const r = await provider.researchAhjRequirements({ ahj: "City of Example", state: "ZZ" });
  assert.equal(r.webGrounded, false, "JSON that parsed is not evidence a search ran");
  assert.equal(r.portalUrl, "");
  assert.ok(calls.some((c) => !c.hasTools), "an unsearched answer falls back to the no-web prompt");
});

await run("AHJ research (must-pass): a response that really searched stays grounded and keeps its URL", async () => {
  const { provider, calls } = makeProvider("searched-json", ahjJson, {});
  const r = await provider.researchAhjRequirements({ ahj: "City of Example", state: "ZZ" });
  assert.equal(r.webGrounded, true);
  assert.equal(r.portalUrl, "https://permits.example-city.gov/portal");
  assert.equal(calls.filter((c) => !c.hasTools).length, 0, "no fallback call when grounded");
});

await run("utility research: aborted web search -> webGrounded:false, no portal URL, no links", async () => {
  const { provider, calls, webTimeouts } = makeProvider("abort", utilityJson, utilityJson);
  const r = await provider.researchUtilityRequirements({ utility: "Example Electric", state: "ZZ" });
  assert.equal(r.webGrounded, false);
  assert.equal(r.portalUrl, "");
  const fallback = calls.find((c) => !c.hasTools)!;
  assert.ok(!fallback.system.includes("FIRST search the web") && /NO WEB ACCESS/.test(fallback.system), "utility fallback must use the no-web prompt");
  assert.ok(fallback.maxTokens >= 4000);
  for (const s of r.tips) assert.ok(!hasUrl(s), `link survived in "${s}"`);
  assert.deepEqual(webTimeouts, [webResearchBudgetMs()]);
});

await run("code research: aborted web search -> model_memory provenance, no sourceUrl, no citations", async () => {
  const { provider, calls, webTimeouts } = makeProvider("abort", codesJson, codesJson);
  const r = await provider.researchJurisdictionCodes({ ahj: "Example County", state: "ZZ" });
  assert.equal(r.webGrounded, false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prov = (r.profile as any).researchProvenance;
  assert.equal(prov?.method, "model_memory");
  assert.equal(prov?.webGrounded, false);
  assert.equal(r.profile.citations.length, 0);
  assert.ok(!hasUrl(JSON.stringify(r.profile)), `a link survived: ${JSON.stringify(r.profile)}`);
  assert.equal(r.profile.adoptedCodes[0]?.edition, "2021", "the recalled content itself is kept (seeded, verify locally)");
  const fallback = calls.find((c) => !c.hasTools)!;
  assert.ok(!fallback.system.includes("FIRST search the web") && /NO WEB ACCESS/.test(fallback.system));
  assert.ok(fallback.maxTokens >= 4000);
  assert.deepEqual(webTimeouts, [webResearchBudgetMs()]);
});

await run("utility + code research: parseable JSON with ZERO web_search blocks is NOT grounded", async () => {
  const u = await makeProvider("no-search-json", utilityJson, utilityJson).provider.researchUtilityRequirements({ utility: "Example Electric", state: "ZZ" });
  assert.equal(u.webGrounded, false, "utility: JSON that parsed is not evidence a search ran");
  assert.equal(u.portalUrl, "");
  const c = await makeProvider("no-search-json", codesJson, codesJson).provider.researchJurisdictionCodes({ ahj: "Example County", state: "ZZ" });
  assert.equal(c.webGrounded, false, "codes: JSON that parsed is not evidence a search ran");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((c.profile as any).researchProvenance?.method, "model_memory");
});

await run("code research (must-pass): searched -> web_search provenance, sources kept", async () => {
  const { provider } = makeProvider("searched-json", codesJson, {});
  const r = await provider.researchJurisdictionCodes({ ahj: "Example County", state: "ZZ" });
  assert.equal(r.webGrounded, true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((r.profile as any).researchProvenance?.method, "web_search");
  assert.equal(r.profile.citations.length, 1);
  assert.equal(r.profile.adoptedCodes[0]?.sourceUrl, "https://codes.example-state.gov/irc");
});

await run("inverter lookup: a 'web' answer with ZERO searches is not labeled 'web search' and is not adopted", async () => {
  const unsure = { outputCurrentA: null, confidence: "low", notes: "" };
  const recalled = { outputCurrentA: 99, outputVa: 23760, confidence: "high", notes: "from memory" };
  const r = await makeProvider("no-search-json", recalled, unsure).provider.lookupInverterSpec({ inverterModel: "ZZ-NOT-A-REAL-INVERTER-9000" });
  assert.notEqual(r.source, "web search", "an unsearched answer claims a web source");
  assert.notEqual(r.outputCurrentA, 99, "an unsearched recall was adopted over the unsure first pass");
  // must-pass: the same answer WITH a search is adopted and labeled.
  const g = await makeProvider("searched-json", recalled, unsure).provider.lookupInverterSpec({ inverterModel: "ZZ-NOT-A-REAL-INVERTER-9000" });
  assert.equal(g.source, "web search");
  assert.equal(g.outputCurrentA, 99);
});

// ---------------------------------------------------------------------------
// Grounding is read from the response SHAPE, both signals, and only successes count
// ---------------------------------------------------------------------------
await run("summarizeWebSearch: blocks-only shape (no usage entry) -> searched and grounded", () => {
  const r = summarizeWebSearch({
    content: [
      { type: "server_tool_use", id: "a", name: "web_search", input: {} },
      { type: "web_search_tool_result", tool_use_id: "a", content: [searchHit, searchHit] },
      { type: "text", text: "{}" },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  assert.deepEqual(r, { searches: 1, groundedSearches: 1 });
});

await run("summarizeWebSearch: usage-only shape -> the attempt is counted, but nothing proves a result", () => {
  const r = summarizeWebSearch({ content: [{ type: "text", text: "{}" }], usage: { server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 } } });
  assert.equal(r.searches, 3, "usage.server_tool_use.web_search_requests must count even with no server_tool_use block");
  assert.equal(r.groundedSearches, 0, "a billed search with no visible result is not grounding");
  // usage higher than the visible blocks wins the attempt count
  assert.equal(summarizeWebSearch({ content: [{ type: "server_tool_use", name: "web_search" }], usage: { server_tool_use: { web_search_requests: 4 } } }).searches, 4);
});

await run("summarizeWebSearch: error-result and empty-result shapes are NOT grounded; one success among errors is", () => {
  for (const error_code of ["unavailable", "too_many_requests", "max_uses_exceeded"]) {
    const r = summarizeWebSearch({
      content: [
        { type: "server_tool_use", id: "a", name: "web_search", input: {} },
        { type: "web_search_tool_result", tool_use_id: "a", content: { type: "web_search_tool_result_error", error_code } },
        { type: "text", text: "{}" },
      ],
      usage: { server_tool_use: { web_search_requests: 1 } },
    });
    assert.deepEqual(r, { searches: 1, groundedSearches: 0 }, error_code);
  }
  assert.equal(summarizeWebSearch({ content: [{ type: "server_tool_use", name: "web_search" }, { type: "web_search_tool_result", content: [] }] }).groundedSearches, 0, "empty results");
  assert.equal(summarizeWebSearch({
    content: [
      { type: "web_search_tool_result", content: [searchHit] },
      { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
    ],
  }).groundedSearches, 1, "a later max_uses_exceeded must not erase an earlier success");
  assert.deepEqual(summarizeWebSearch({ content: undefined, usage: null }), { searches: 0, groundedSearches: 0 });
});

await run("research end to end: an error-result search and a usage-only search both fall back to the no-web prompt", async () => {
  for (const mode of ["error-result-json", "usage-only-json"] as const) {
    const { provider, calls } = makeProvider(mode, ahjJson, ahjJson);
    const r = await provider.researchAhjRequirements({ ahj: "City of Example", state: "ZZ" });
    assert.equal(r.webGrounded, false, `${mode}: labeled grounded`);
    assert.equal(r.portalUrl, "", `${mode}: kept a model-memory portal URL`);
    assert.ok(calls.some((c) => !c.hasTools), `${mode}: no fallback call`);
    const c = await makeProvider(mode, codesJson, codesJson).provider.researchJurisdictionCodes({ ahj: "Example County", state: "ZZ" });
    assert.equal(c.webGrounded, false, `${mode}: codes labeled grounded`);
    const u = await makeProvider(mode, utilityJson, utilityJson).provider.researchUtilityRequirements({ utility: "Example Electric", state: "ZZ" });
    assert.equal(u.webGrounded, false, `${mode}: utility labeled grounded`);
  }
  // must-pass: the blocks-only success shape (no usage entry) is grounded end to end
  const g = await makeProvider("blocks-only-json", ahjJson, {}).provider.researchAhjRequirements({ ahj: "City of Example", state: "ZZ" });
  assert.equal(g.webGrounded, true, "blocks-only success shape must stay grounded");
});

// ---------------------------------------------------------------------------
// The URL scrub keeps email addresses whole (they are contact info, not portal links)
// ---------------------------------------------------------------------------
await run("stripUrlsFromModelMemory: email addresses survive whole; URLs and bare domains still go", () => {
  const mustKeep: Array<[string, string]> = [
    ["Email plans to building@example-city.gov for review", "Email plans to building@example-city.gov for review"],
    ["Contact permits@cityofx.gov.", "Contact permits@cityofx.gov."],
    ["Questions: Permits@CityOfX.gov", "Questions: Permits@CityOfX.gov"],
    ["Send to info@sub.cityofx.gov or call", "Send to info@sub.cityofx.gov or call"],
    ["solar.permits@county-x.us", "solar.permits@county-x.us"],
  ];
  for (const [input, expected] of mustKeep) assert.equal(stripUrlsFromModelMemory(input), expected, `email mangled: ${input}`);
  const mustStrip: Array<[string, string]> = [
    ["Email permits@cityofx.gov or visit cityofx.gov/solar", "Email permits@cityofx.gov or visit"],
    ["See www.exampleutility.com/interconnect", "See"],
    ["Download from https://example-city.gov/forms/site.pdf first", "Download from first"],
    ["Portal at permits.example-city.gov (login required)", "Portal at (login required)"],
    ["Site plan at e-permits.gov", "Site plan at"],
  ];
  for (const [input, expected] of mustStrip) assert.equal(stripUrlsFromModelMemory(input), expected, `not stripped: ${input}`);
});

// ---------------------------------------------------------------------------
// Save layer (isolated DB)
// ---------------------------------------------------------------------------
type KbRow = { portal_url: string; portal_name: string; sources_json: string; notes: string; required_documents_json: string };
const kbRow = (key: string) => db.get<KbRow>("SELECT portal_url, portal_name, sources_json, notes, required_documents_json FROM permit_utility_knowledge WHERE profile_key = ?", [key])!;

await run("KB save: a model-memory row keeps the AHJ's contact email intact in notes and docs", () => {
  const saved = saveResearchedAhjProfile(db, { state: "ZZ", ahj: "City of Emailville" }, {
    ...ahjJson, provider: "claude", webGrounded: false, needsHumanVerification: true, notes: "",
    portalName: "Email: permits@emailville.gov",
    requiredDocuments: ["Plan set (email PDF to building@emailville.gov)"],
    tips: ["Questions go to Permits@Emailville.gov; forms at emailville.gov/forms"],
    confidence: "medium",
  });
  const row = kbRow(saved.profileKey);
  assert.ok(row.notes.includes("Permits@Emailville.gov"), `email mangled in notes: ${row.notes}`);
  assert.ok(!/@[;,. ]|@$/.test(row.notes), `dangling "@" in notes: ${row.notes}`);
  assert.ok(!/emailville\.gov\/forms/.test(row.notes), "the bare-domain link must still be stripped");
  assert.ok(row.required_documents_json.includes("building@emailville.gov"), `email mangled in docs: ${row.required_documents_json}`);
  assert.equal(row.portal_name, "Email: permits@emailville.gov", "an email portalName is kept whole");
  assert.equal(row.portal_url, "", "a kept email must never be promoted into portal_url");
});

await run("KB save: model-memory AHJ research stores the marker and NO portal URL (end to end from the aborted call)", async () => {
  const { provider } = makeProvider("abort", ahjJson, ahjJson);
  const research = await provider.researchAhjRequirements({ ahj: "City of Memoryville", state: "ZZ" });
  const saved = saveResearchedAhjProfile(db, { state: "ZZ", ahj: "City of Memoryville" }, research);
  const row = kbRow(saved.profileKey);
  assert.equal(row.portal_url, "", `portal_url persisted: ${row.portal_url}`);
  assert.ok(!hasUrl(row.portal_name), `portal_name persisted a URL: ${row.portal_name}`);
  assert.ok(/model memory/i.test(row.sources_json), `source label lacks the marker: ${row.sources_json}`);
  assert.ok(/MODEL MEMORY ONLY/.test(row.notes), "notes lack the provenance segment");
  assert.ok(!hasUrl(row.notes) && !hasUrl(row.required_documents_json), "a link survived into notes/docs");
});

await run("KB save guard (defense in depth): a hand-built webGrounded:false result with URLs in every field stores none", () => {
  const saved = saveResearchedAhjProfile(db, { state: "ZZ", ahj: "City of Handbuilt" }, {
    ...ahjJson, provider: "claude", webGrounded: false, needsHumanVerification: true, notes: "",
    confidence: "medium",
  });
  const row = kbRow(saved.profileKey);
  assert.equal(row.portal_url, "", "portalUrl (or a URL-shaped portalName promoted by upsertKnowledge) persisted");
  assert.ok(!hasUrl(row.notes), `notes carry a link: ${row.notes}`);
  assert.ok(/model memory/i.test(row.sources_json));
});

await run("KB save (must-pass): grounded research keeps its portal URL and says web-grounded", () => {
  const saved = saveResearchedAhjProfile(db, { state: "ZZ", ahj: "City of Groundedville" }, {
    ...ahjJson, portalName: "Example ePermits", provider: "claude", webGrounded: true, needsHumanVerification: true, notes: "",
    confidence: "medium",
  });
  const row = kbRow(saved.profileKey);
  assert.equal(row.portal_url, "https://permits.example-city.gov/portal");
  assert.ok(/web-grounded/i.test(row.sources_json));
  assert.ok(!/MODEL MEMORY/.test(row.notes));
});

await run("KB save: model-memory utility research stores the marker and NO portal URL", () => {
  const saved = saveResearchedUtilityProfile(db, { state: "ZZ", utility: "Example Electric" }, {
    ...utilityJson, provider: "claude", webGrounded: false, needsHumanVerification: true, notes: "",
    confidence: "low",
  });
  const row = kbRow(saved.profileKey);
  assert.equal(row.portal_url, "");
  assert.ok(/model memory/i.test(row.sources_json));
  assert.ok(!hasUrl(row.notes), `notes carry a link: ${row.notes}`);
});

await run("code-profile save: payload_json records model_memory provenance; a seeded re-save without it keeps it", async () => {
  const { provider } = makeProvider("abort", codesJson, codesJson);
  const research = await provider.researchJurisdictionCodes({ ahj: "Example County", state: "ZZ" });
  saveResearchedCodeProfile(db, research.profile);
  const key = codeProfileKey({ state: "ZZ", ahj: "Example County" });
  const payload = () => JSON.parse(db.get<{ payload_json: string }>("SELECT payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [key])!.payload_json);
  assert.equal(payload().researchProvenance?.method, "model_memory", `payload: ${JSON.stringify(payload()).slice(0, 300)}`);
  assert.equal(payload().researchProvenance?.webGrounded, false);
  assert.ok(!/https?:\/\//.test(JSON.stringify(payload())), "a link persisted in payload_json");
  // A reference-import style merge: a plain profile with no provenance, seeded.
  const { researchProvenance: _drop, ...plain } = research.profile as typeof research.profile & { researchProvenance?: unknown };
  saveResearchedCodeProfile(db, { ...plain, amendments: [...plain.amendments, { code: "NEC", summary: "Imported note" }] });
  assert.equal(payload().researchProvenance?.method, "model_memory", "a merge must not launder the model-memory marker away");
});

console.log(failures ? `\n${failures} FAILED` : "\nall research-provenance tests passed");
process.exit(failures ? 1 : 0);
