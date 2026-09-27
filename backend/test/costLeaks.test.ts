// COST LEAKS (2026-09-26): the model-routing round measured that cheaper models lose accuracy on
// intake and lookup, so the saving has to come from LEAKS — spend that buys nothing. Each fix here
// is accuracy-neutral BY CONSTRUCTION, and this file pins that construction:
//
//   L1 MULTI-TURN HISTORY IS CACHED. Both tool loops (feeSchedules.claudeFeeScheduleResearcher,
//      llm.runToolAgent) re-send the growing conversation every turn with a breakpoint on the
//      system prompt only; measured, 57-75% of a fee track's spend was history re-billed at full
//      price. The fix moves a breakpoint onto the last block of the last turn. Pinned: the request
//      body differs from the unmarked one ONLY in cache_control (same model, tools, system text,
//      messages, byte for byte after the markers are stripped); each turn's messages are a strict
//      prefix of the next (the prefix-match invariant caching depends on); exactly one moving marker.
//   L2 FEE RESEARCH GOES THROUGH THE ROUTING TABLE: default env sends claude-opus-5 with NO
//      output_config (today's bytes); the global switch to Opus 5.5 sends effort high, never that
//      model's medium default.
//   L3 WEB-SEARCH FEES ARE IN THE LEDGER: llm_calls.web_searches (migration v38), $10 per 1,000 in
//      the estimate, NULL stays unknown (never $0), and both call paths record it.
//   L4 ONE JOB DOES NOT BUY THE SAME PERMIT FEE TWICE: when the per-job lookup landed a cited fee
//      for this AHJ + discipline, researchFeeSchedule skips with a named reason; NEM and an
//      un-landed discipline still research.
//   L6 A SAFETY-CLASSIFIER REFUSAL IS NAMED, NOT RE-SENT: one call, a reason that says "declined",
//      never "no usable fee schedule".
//
// No network: globalThis.fetch is stubbed for /v1/messages (the fee researcher builds its own SDK
// client per pass and the SDK reads fetch at construction). Run: tsx backend/test/costLeaks.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { CitedFact, PermitFeeAnswer } from "../../shared/src/types";

for (const k of Object.keys(process.env)) if (/^AUTOPILOT_LLM_|^AUTOPILOT_ADVISOR_/.test(k)) delete process.env[k];
delete process.env.ANTHROPIC_BASE_URL;
process.env.FEE_RESEARCH = "off";
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "sk-ant-stub-key-no-network";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack || err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// Stubbed Messages API: scripted turns, captured request bodies.
// ---------------------------------------------------------------------------
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
interface Scripted { blocks: Block[]; stop: string; usage?: Record<string, unknown> }
const queue: Scripted[] = [];
const captured: Array<Record<string, unknown>> = [];
const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
function sse(s: Scripted, model: string): string {
  const usage = { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(s.usage ?? {}) };
  const out = [ev("message_start", { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } })];
  s.blocks.forEach((b, index) => {
    if (b.type === "text") {
      out.push(ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } }));
      out.push(ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } }));
    } else {
      out.push(ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }));
      out.push(ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }));
    }
    out.push(ev("content_block_stop", { type: "content_block_stop", index }));
  });
  out.push(ev("message_delta", { type: "message_delta", delta: { stop_reason: s.stop, stop_sequence: null }, usage: { output_tokens: 200, ...(s.usage?.server_tool_use ? { server_tool_use: s.usage.server_tool_use } : {}) } }));
  out.push(ev("message_stop", { type: "message_stop" }));
  return out.join("");
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("/v1/messages")) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  captured.push(body);
  const s = queue.shift() ?? { blocks: [{ type: "text", text: "{}" }], stop: "end_turn" };
  return new Response(sse(s, String(body.model || "claude-opus-5")), { status: 200, headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

const { openDatabase } = await import("../src/db");
const db = await openDatabase();
const fees = await import("../src/feeSchedules");
const llm = await import("../src/llm");
const { ClaudeLLMProvider, recordLlmCall, placeHistoryCacheBreakpoint, webSearchRequestsOf } = llm;
const { estimateLlmCallCostUsd, llmUsageForProject, runWithLlmContext, WEB_SEARCH_USD_PER_1000 } = await import("../src/llmAccounting");
const { ROUTE_TABLE, routeFor } = await import("../src/modelRouting");
const pp = await import("../src/permitProcess");
const ppl = await import("../src/permitProcessLookup");
type Msg = { role: string; content: string | Array<Record<string, unknown>> };
type CallRow = { label: string; model: string; stop: string | null; web_searches: number | null; error: string | null };
const rowsLike = (label: string) => db.query<CallRow>("SELECT label, model, stop, web_searches, error FROM llm_calls WHERE label LIKE ? ORDER BY id", [label]);

// --- helpers over a captured body -------------------------------------------------------------
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** The body with every cache_control marker removed (system and messages). */
function stripMarkers(body: Record<string, unknown>): Record<string, unknown> {
  const b = clone(body);
  for (const s of (b.system as Array<Record<string, unknown>>) ?? []) delete s.cache_control;
  for (const m of (b.messages as Msg[]) ?? []) if (Array.isArray(m.content)) for (const blk of m.content) delete blk.cache_control;
  return b;
}
/** Where the markers sit inside messages: [messageIndex, blockIndex] pairs. */
function markerPositions(body: Record<string, unknown>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  ((body.messages as Msg[]) ?? []).forEach((m, mi) => { if (Array.isArray(m.content)) m.content.forEach((blk, bi) => { if (blk.cache_control) out.push([mi, bi]); }); });
  return out;
}
function assertHistoryCaching(bodies: Array<Record<string, unknown>>, expectKeys: string[]): void {
  assert.ok(bodies.length >= 3, `expected a multi-turn loop, got ${bodies.length} request(s)`);
  bodies.forEach((body, i) => {
    assert.deepEqual(Object.keys(body).sort(), [...expectKeys].sort(), `turn ${i + 1}: body keys`);
    // The system breakpoint stays (tools + system cached together) on every turn.
    const sys = body.system as Array<Record<string, unknown>>;
    assert.deepEqual(sys[sys.length - 1].cache_control, { type: "ephemeral" }, `turn ${i + 1}: system marker`);
    const msgs = body.messages as Msg[];
    const last = msgs[msgs.length - 1];
    if (typeof last.content === "string") {
      assert.deepEqual(markerPositions(body), [], `turn ${i + 1}: a string user turn carries no marker (turn 1 stays byte-identical)`);
    } else {
      assert.deepEqual(markerPositions(body), [[msgs.length - 1, last.content.length - 1]], `turn ${i + 1}: exactly ONE marker, on the last block of the last message`);
      assert.deepEqual((last.content[last.content.length - 1] as Record<string, unknown>).cache_control, { type: "ephemeral" });
    }
    for (const m of msgs) if (m.role === "assistant") for (const blk of m.content as Array<Record<string, unknown>>) assert.equal(blk.cache_control, undefined, `turn ${i + 1}: assistant blocks are replayed verbatim`);
    if (i > 0) {
      // Everything sent last turn is re-sent unchanged as a PREFIX (markers aside) — the invariant
      // that lets this turn read the previous turn's write.
      const prev = stripMarkers(bodies[i - 1]);
      const cur = stripMarkers(body);
      const pm = prev.messages as Msg[], cm = cur.messages as Msg[];
      assert.ok(cm.length > pm.length, `turn ${i + 1}: the conversation grew`);
      assert.deepEqual(cm.slice(0, pm.length), pm, `turn ${i + 1}: previous messages are a byte-identical prefix`);
      assert.deepEqual({ ...cur, messages: null }, { ...prev, messages: null }, `turn ${i + 1}: everything but messages is identical to the previous turn`);
      assert.equal(cm[pm.length].role, "assistant"); assert.equal(cm[pm.length + 1].role, "user");
    }
  });
}

// ===========================================================================
// L1 — fee research loop
// ===========================================================================
console.log("L1 fee-research history caching");
const NO_URL = "No url was given. Call open_document with an absolute http(s) URL.";
const feeScript = (): Scripted[] => [
  { blocks: [{ type: "text", text: "Opening the fee page." }, { type: "tool_use", id: "tu_1", name: "open_document", input: { url: "" } }], stop: "tool_use", usage: { server_tool_use: { web_search_requests: 2 } } },
  { blocks: [{ type: "tool_use", id: "tu_2", name: "open_document", input: { url: "" } }, { type: "tool_use", id: "tu_3", name: "open_document", input: { url: "", find: "solar" } }], stop: "tool_use" },
  { blocks: [{ type: "text", text: JSON.stringify({ found: false, reason: "stub: nothing published" }) }], stop: "end_turn" },
];
let feeBodies: Array<Record<string, unknown>> = [];
await check("three scripted turns: the body differs from the unmarked one ONLY in cache_control; one moving marker on the last block; prefix-stable", async () => {
  captured.length = 0; queue.push(...feeScript());
  const finding = await fees.claudeFeeScheduleResearcher({ state: "OR", ahj: "Cache Probe City", track: "permit" });
  assert.equal(finding.found, false); assert.match(finding.reason, /nothing published/);
  feeBodies = captured.slice();
  assertHistoryCaching(feeBodies, ["model", "max_tokens", "thinking", "tools", "system", "messages", "stream"]);
  // The canonical transcript, built from the script itself: what an unmarked builder would send.
  const s = stripMarkers(feeBodies[2]);
  const m = s.messages as Msg[];
  assert.equal(typeof m[0].content, "string"); assert.match(m[0].content as string, /^AHJ: Cache Probe City/);
  assert.deepEqual((m[1].content as Array<Record<string, unknown>>).map((b) => ({ type: b.type, name: b.name, input: b.input })),
    [{ type: "text", name: undefined, input: undefined }, { type: "tool_use", name: "open_document", input: { url: "" } }]);
  assert.deepEqual(m[2].content, [{ type: "tool_result", tool_use_id: "tu_1", content: NO_URL }]);
  assert.deepEqual(m[4].content, [{ type: "tool_result", tool_use_id: "tu_2", content: NO_URL }, { type: "tool_result", tool_use_id: "tu_3", content: NO_URL }]);
  assert.equal(s.model, "claude-opus-5"); assert.equal(s.max_tokens, 16000); assert.deepEqual(s.thinking, { type: "adaptive" });
  assert.deepEqual((s.tools as Array<Record<string, unknown>>).map((t) => t.name), ["web_search", "open_document"]);
});

await check("KILL-TEST shape: a body with NO marker in messages fails the same assertion", () => {
  const unmarked = feeBodies.map(stripMarkers).map((b) => ({ ...b, system: (feeBodies[0].system as unknown[]) }));
  assert.throws(() => assertHistoryCaching(unmarked, ["model", "max_tokens", "thinking", "tools", "system", "messages", "stream"]), /exactly ONE marker/);
});

await check("placeHistoryCacheBreakpoint: strips every earlier marker and sets exactly one; a string tail is left alone", () => {
  const msgs: Msg[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r", cache_control: { type: "ephemeral" } }, { type: "text", text: "tail" }] },
  ];
  placeHistoryCacheBreakpoint(msgs);
  assert.deepEqual(markerPositions({ messages: msgs }), [[2, 1]]);
  const s: Msg[] = [{ role: "user", content: "only" }];
  placeHistoryCacheBreakpoint(s);
  assert.equal(s[0].content, "only");
});

// ===========================================================================
// L1 — runToolAgent (runTriage / correctionAgent)
// ===========================================================================
console.log("L1 runToolAgent history caching");
const provider = new ClaudeLLMProvider("sk-ant-stub-key-no-network");
const agentScript = (): Scripted[] => [
  { blocks: [{ type: "tool_use", id: "a_1", name: "probe", input: { q: "one" } }], stop: "tool_use" },
  { blocks: [{ type: "text", text: "Checking more." }, { type: "tool_use", id: "a_2", name: "probe", input: { q: "two" } }], stop: "tool_use", usage: { server_tool_use: { web_search_requests: 0 } } },
  { blocks: [{ type: "tool_use", id: "a_3", name: "probe", input: { q: "three" } }], stop: "tool_use" },
  { blocks: [{ type: "text", text: "done" }], stop: "end_turn" },
];
const runAgent = () => provider.runToolAgent({
  label: "runTriage", system: "You are a probe agent. ".repeat(40), user: "Probe three times, then stop.", effort: "medium", maxIterations: 6,
  tools: [{ name: "probe", description: "returns a fact", input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, handler: async (i) => ({ kind: "text", text: `fact:${String(i.q)}` }) }],
});
await check("four scripted turns: same invariants — only cache_control differs, one moving marker, prefix-stable; effort still sent", async () => {
  captured.length = 0; queue.push(...agentScript());
  const run = await runAgent();
  assert.equal(run.finalText, "done"); assert.equal(run.iterations, 4);
  const bodies = captured.slice();
  assertHistoryCaching(bodies, ["model", "max_tokens", "thinking", "output_config", "system", "tools", "messages", "stream"]);
  assert.deepEqual(bodies[3].output_config, { effort: "medium" });
  const m = stripMarkers(bodies[3]).messages as Msg[];
  assert.deepEqual(m[2].content, [{ type: "tool_result", tool_use_id: "a_1", content: "fact:one", is_error: false }]);
  assert.equal(m.length, 7);
});

// ===========================================================================
// L2 — the routing table
// ===========================================================================
console.log("L2 fee research through the routing table");
await check("default env: claude-opus-5, NO output_config on the wire (today's bytes); the table entry omits effort and says unmeasured", () => {
  for (const b of feeBodies) { assert.equal(b.model, "claude-opus-5"); assert.equal("output_config" in b, false); }
  assert.equal(ROUTE_TABLE.researchFeeSchedule.effort, undefined);
  assert.match(ROUTE_TABLE.researchFeeSchedule.evidence, /unmeasured/i);
  assert.equal(routeFor("researchFeeSchedule", { env: {} }).effort, undefined);
});
await check("AUTOPILOT_LLM_MODEL=claude-opus-5-5: the fee loop sends that model WITH effort high (never its medium default) and records it", async () => {
  process.env.AUTOPILOT_LLM_MODEL = "claude-opus-5-5";
  try {
    captured.length = 0; queue.push({ blocks: [{ type: "text", text: JSON.stringify({ found: false, reason: "stub" }) }], stop: "end_turn" });
    await fees.claudeFeeScheduleResearcher({ state: "OR", ahj: "Routed City", track: "permit" });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].model, "claude-opus-5-5");
    assert.deepEqual(captured[0].output_config, { effort: "high" });
    const rows = rowsLike("researchFeeSchedule[permit:OR:Routed City]%");
    assert.equal(rows.length, 1); assert.equal(rows[0].model, "claude-opus-5-5");
  } finally { delete process.env.AUTOPILOT_LLM_MODEL; }
});
await check("the per-task route (AUTOPILOT_LLM_ROUTE_RESEARCHFEESCHEDULE) reaches the fee loop, and an unroutable global typo is ignored — both only via routeFor", async () => {
  process.env.AUTOPILOT_LLM_ROUTE_RESEARCHFEESCHEDULE = "claude-opus-5-5@high";
  try {
    captured.length = 0; queue.push({ blocks: [{ type: "text", text: "{}" }], stop: "end_turn" });
    await fees.claudeFeeScheduleResearcher({ state: "OR", ahj: "Task Routed City", track: "permit" });
    assert.equal(captured[0].model, "claude-opus-5-5"); assert.deepEqual(captured[0].output_config, { effort: "high" });
  } finally { delete process.env.AUTOPILOT_LLM_ROUTE_RESEARCHFEESCHEDULE; }
  process.env.AUTOPILOT_LLM_MODEL = "claude-opus-5.5"; // a typo: not a routable id
  try {
    captured.length = 0; queue.push({ blocks: [{ type: "text", text: "{}" }], stop: "end_turn" });
    await fees.claudeFeeScheduleResearcher({ state: "OR", ahj: "Typo City", track: "permit" });
    assert.equal(captured[0].model, "claude-opus-5", "an unroutable model id must not reach the wire"); assert.equal("output_config" in captured[0], false);
  } finally { delete process.env.AUTOPILOT_LLM_MODEL; }
});

// ===========================================================================
// L3 — web-search fees in the ledger
// ===========================================================================
console.log("L3 web-search fees");
await check("migration v38: llm_calls has web_searches after openDatabase", () => {
  const cols = db.query<{ name: string }>("PRAGMA table_info(llm_calls)").map((c) => c.name);
  assert.ok(cols.includes("web_searches"), cols.join(","));
});
await check("webSearchRequestsOf reads usage.server_tool_use; absent = undefined (unknown), present 0 = 0", () => {
  assert.equal(webSearchRequestsOf({ input_tokens: 1 }), undefined);
  assert.equal(webSearchRequestsOf(undefined), undefined);
  assert.equal(webSearchRequestsOf({ server_tool_use: { web_search_requests: 0 } }), 0);
  assert.equal(webSearchRequestsOf({ server_tool_use: { web_search_requests: 7 } }), 7);
  assert.equal(webSearchRequestsOf({ server_tool_use: { web_search_requests: "3" } }), 3);
});
await check("cost arithmetic: tokens + $10 per 1,000 searches; a NULL count adds nothing and stays unknown, never $0", () => {
  const base = { label: "x", model: "claude-opus-5", in_tok: 1000, out_tok: 200, cache_read: 0, cache_write: 0 };
  const tokensOnly = 1000 * 5 / 1e6 + 200 * 25 / 1e6;
  assert.equal(WEB_SEARCH_USD_PER_1000, 10);
  assert.equal(estimateLlmCallCostUsd({ ...base, web_searches: 3 }), tokensOnly + 0.03);
  assert.equal(estimateLlmCallCostUsd({ ...base, web_searches: null }), tokensOnly);
  assert.equal(estimateLlmCallCostUsd(base), tokensOnly);
  assert.equal(estimateLlmCallCostUsd({ ...base, label: "planPortalFields.countTokens", web_searches: 5 }), 0);
});
await check("both call paths record the count: the fee loop's turn with a search count, the agent turn with an explicit 0, and NULL when the response reported none", () => {
  const feeRows = rowsLike("researchFeeSchedule[permit:OR:Cache Probe City]%");
  assert.deepEqual(feeRows.map((r) => r.web_searches), [2, null, null]);
  const agentRows = rowsLike("runTriage#%");
  assert.deepEqual(agentRows.map((r) => r.web_searches), [null, 0, null, null]);
});
await check("llmUsageForProject: searches summed into the estimate, unknown rows counted, the note names the rate", () => {
  const pid = "cost-leaks-project";
  runWithLlmContext({ projectId: pid }, () => {
    recordLlmCall({ at: Date.now(), label: "findAhjFormUrl", model: "claude-opus-5", ms: 1, inTok: 1000, outTok: 100, webSearches: 4 });
    recordLlmCall({ at: Date.now(), label: "webLookup", model: "claude-opus-5", ms: 1, inTok: 1000, outTok: 100 });
  });
  const u = llmUsageForProject(db, pid);
  assert.equal(u.calls, 2); assert.equal(u.webSearches, 4); assert.equal(u.webSearchesUnknown, 1);
  const tokens = 2 * (1000 * 5 / 1e6 + 100 * 25 / 1e6);
  assert.equal(u.estimatedCostUsd, Math.round((tokens + 0.04) * 1e4) / 1e4);
  assert.equal(u.byLabel.find((l) => l.label === "findAhjFormUrl")!.webSearches, 4);
  assert.match(u.note, /\$10 per 1,000/); assert.match(u.note, /1 call\(s\) reported no search count/);
  assert.doesNotMatch(u.note, /not included/);
});

// ===========================================================================
// L4 — one job, one fee research per permit
// ===========================================================================
console.log("L4 lookup-landed fee skips research");
const FEES_URL = "https://docs.example-fees.org/2026-fee-schedule.pdf";
const AHJ = "City of Dedupe";
const none = { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "not searched" };
const cite = (value: string): CitedFact<string> => ({ value, sourceUrl: "https://www.cityofdedupe.gov/building", quote: `${value} issues permits`, origin: "lookup" });
const STRUCTURAL_FEE: CitedFact<PermitFeeAnswer> = {
  value: { amountUsd: 67.25, basis: "flat fee for prescriptive-path PV", lines: [{ label: "Solar PV installed using the prescriptive path", amountUsd: 67.25 }] },
  sourceUrl: FEES_URL, quote: "Solar Photovoltaic Systems installed using the prescriptive path $67.25", origin: "lookup",
};
const ELECTRICAL_RATED: CitedFact<PermitFeeAnswer> = {
  // Priced by a rate: applyLookupFees does NOT land this as a flat fee, so electrical still researches.
  value: { amountUsd: null, basis: "1.5% of valuation", lines: [] }, sourceUrl: FEES_URL, quote: "1.5% of valuation", origin: "lookup",
};
const saved = pp.savePermitProcessLookup(db, {
  state: "OR", ahj: AHJ, lookedUpAt: new Date().toISOString(),
  issuingAgency: cite(AHJ), permitStructure: { value: "separate", sourceUrl: "https://www.cityofdedupe.gov/building", quote: "separate permits", origin: "lookup" },
  permits: [
    { discipline: "structural", label: "Residential Structural", issuingAgency: cite(AHJ), portalUrl: none, recordType: none, documents: none, fee: STRUCTURAL_FEE },
    { discipline: "electrical", label: "Residential Electrical", issuingAgency: cite(AHJ), portalUrl: none, recordType: none, documents: none, fee: ELECTRICAL_RATED },
  ],
} as never);
assert.ok(saved.saved && saved.lookup, saved.reason);
const landed = ppl.applyLookupFees(db, saved.lookup!);
let researcherCalls = 0;
const countingResearcher: typeof fees.claudeFeeScheduleResearcher = async () => { researcherCalls++; return { found: false, reason: "stub researcher ran", basis: "other", brackets: [], notes: "", sourceUrl: "", sourceQuote: "", sourceKind: "" }; };

await check("the lookup landed the structural fee through the real write path (fixture sanity)", () => {
  assert.ok(landed.some((l) => l.discipline === "structural" && l.saved), JSON.stringify(landed));
  assert.ok(landed.some((l) => l.discipline === "electrical" && !l.saved), JSON.stringify(landed));
});
await check("permit/structural: research is SKIPPED with a named reason, the researcher never runs, the lookup's fee is returned", async () => {
  const out = await fees.researchFeeSchedule(db, { state: "OR", ahj: AHJ, track: "permit", discipline: "structural" }, { researcher: countingResearcher });
  assert.equal(researcherCalls, 0);
  assert.equal(out.skipped, "lookup_fee_landed");
  assert.equal(out.saved, false); assert.equal(out.found, true);
  assert.match(out.reason, /Skipped — no research ran/); assert.ok(out.reason.includes(FEES_URL), out.reason); assert.match(out.reason, /flat \$67\.25/);
  assert.equal(out.schedule?.sourceUrl, FEES_URL); assert.equal(out.schedule?.brackets[0]?.feeUsd, 67.25);
  assert.ok(fees.lookupLandedPermitFee(db, { state: "OR", ahj: AHJ }, "structural"));
});
await check("permit/electrical: the lookup cited a RATED fee it could not land, so research still runs", async () => {
  const out = await fees.researchFeeSchedule(db, { state: "OR", ahj: AHJ, track: "permit", discipline: "electrical" }, { researcher: countingResearcher });
  assert.equal(researcherCalls, 1); assert.equal(out.skipped, undefined); assert.match(out.reason, /stub researcher ran/);
});
await check("NEM is unaffected: the utility track always researches", async () => {
  const out = await fees.researchFeeSchedule(db, { state: "OR", ahj: AHJ, utility: "Pacific Power", track: "nem" }, { researcher: countingResearcher });
  assert.equal(researcherCalls, 2); assert.equal(out.skipped, undefined);
});
await check("an AHJ with no lookup row researches; a landed fee whose source is NOT the lookup's citation does not count", async () => {
  await fees.researchFeeSchedule(db, { state: "OR", ahj: "City of Nowhere Looked Up", track: "permit", discipline: "structural" }, { researcher: countingResearcher });
  assert.equal(researcherCalls, 3);
  // A row for a different AHJ, saved by research from another URL, with a lookup that cites no fee at all.
  const other = pp.savePermitProcessLookup(db, {
    state: "OR", ahj: "City of Other", lookedUpAt: new Date().toISOString(), issuingAgency: cite("City of Other"),
    permitStructure: { value: "combo", sourceUrl: "https://www.cityofother.gov/b", quote: "one permit", origin: "lookup" },
    permits: [{ discipline: "combo", label: "Solar", issuingAgency: cite("City of Other"), portalUrl: none, recordType: none, documents: none, fee: none }],
  } as never);
  assert.ok(other.saved);
  fees.saveFeeSchedule(db, { state: "OR", ahj: "City of Other", track: "permit", discipline: "combo" }, { found: true, reason: "", basis: "flat", brackets: [{ feeUsd: 100, label: "solar" }], notes: "", sourceUrl: "https://elsewhere.example/fees.pdf", sourceQuote: "solar $100", sourceKind: "official" });
  assert.equal(fees.lookupLandedPermitFee(db, { state: "OR", ahj: "City of Other" }, "combo"), null);
  await fees.researchFeeSchedule(db, { state: "OR", ahj: "City of Other", track: "permit", discipline: "combo" }, { researcher: countingResearcher });
  assert.equal(researcherCalls, 4);
});

// ===========================================================================
// L6 — a refusal is named, once
// ===========================================================================
console.log("L6 refusal");
await check("a safety-classifier refusal costs ONE call, is named in the reason (never 'no usable fee schedule'), and stores nothing", async () => {
  captured.length = 0; queue.push({ blocks: [], stop: "refusal" });
  const out = await fees.researchFeeSchedule(db, { state: "OR", ahj: "Declined City", track: "permit", discipline: "structural" });
  assert.equal(captured.length, 1, "the refused request was re-sent");
  assert.equal(out.found, false); assert.equal(out.saved, false);
  assert.match(out.reason, /safety classifier DECLINED/); assert.match(out.reason, /not a finding/i);
  assert.doesNotMatch(out.reason, /no usable fee schedule/);
  const rows = rowsLike("researchFeeSchedule[permit:OR:Declined City]%");
  assert.equal(rows.length, 1); assert.equal(rows[0].stop, "refusal");
  assert.equal(fees.getFeeSchedule(db, fees.feeScheduleProfileKey({ state: "OR", ahj: "Declined City" }, "permit"), "permit", "structural"), null);
});

globalThis.fetch = realFetch;
db.close();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\ncostLeaks: all checks passed");
