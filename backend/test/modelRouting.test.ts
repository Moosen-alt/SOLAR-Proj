// PER-TASK MODEL ROUTING, THE OPUS 5.5 RULES, REFUSALS AS A NAMED FAILURE, AND WHAT A CALL COSTS.
//
// Four things this guards, each of which fails quietly in production:
//   1. THE TABLE REPRODUCES TODAY'S WIRE. Every unmeasured task must send exactly the model and
//      effort it sent before routing existed — a routing refactor that silently moved intake to a
//      different effort would read as "the parser got worse" weeks later.
//   2. OPUS 5.5 IS NEVER RUN ON ITS DEFAULT EFFORT. Its API default is medium (Opus 5's is high); the
//      lookup measured the unpinned switch WORSE (19 found / 5 WRONG vs 22 / 3). A route that names
//      no effort must be pinned to high the moment it resolves to any model but claude-opus-5.
//   3. A REFUSAL IS A NAMED FAILURE, NOT AN EMPTY ANSWER — and it is not re-sent identically (the
//      classifier refuses the same bytes the same way; the old intake retry paid for that twice).
//   4. EVERY MODEL IS PRICED AT ITS OWN RATE. claude-opus-5-5 priced as claude-opus-5 under-reports
//      by 25%; its cache reads are 0.05x, not 0.1x; the advisor's tokens are a separate line.
//
// Browser-free, no network: a local stub speaks the Messages API. Run: tsx backend/test/modelRouting.test.ts
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.AUTOPILOT_DB_PATH = path.join(os.tmpdir(), `model-routing-${process.pid}.sqlite`);
// Whatever the shell has set must not steer the assertions below.
for (const k of Object.keys(process.env)) if (/^AUTOPILOT_LLM_|^AUTOPILOT_ADVISOR_/.test(k)) delete process.env[k];

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack || err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// Stub API with a scripted response queue.
// ---------------------------------------------------------------------------
interface Scripted { text?: string; stop?: string; stopDetails?: Record<string, unknown>; usage?: Record<string, unknown> }
interface Captured { path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }
let captured: Captured[] = [];
let queue: Scripted[] = [];
const calls = (): Captured[] => captured.filter((c) => !c.path.includes("count_tokens"));

function sse(s: Scripted, model: string): string {
  const usage = { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(s.usage ?? {}) };
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    ev("message_start", { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s.text ?? "" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: s.stop ?? "end_turn", stop_sequence: null, ...(s.stopDetails ? { stop_details: s.stopDetails } : {}) }, usage: { output_tokens: 200, ...(s.usage?.iterations ? { iterations: s.usage.iterations } : {}) } }),
    ev("message_stop", { type: "message_stop" }),
  ].join("");
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep {} */ }
    const p = req.url ?? "";
    captured.push({ path: p, body, headers: req.headers });
    if (p.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 1234 })); return; }
    const s = queue.shift() ?? { text: "{}", stop: "end_turn" };
    const model = String(body.model || "claude-opus-5");
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(sse(s, model));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_stub", type: "message", role: "assistant", model,
        content: [{ type: "text", text: s.text ?? "", citations: null }],
        stop_reason: s.stop ?? "end_turn", stop_sequence: null, ...(s.stopDetails ? { stop_details: s.stopDetails } : {}),
        usage: { input_tokens: 1000, output_tokens: 200, ...(s.usage ?? {}) },
      }));
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const routing = await import("../src/modelRouting");
const { routeFor, ROUTE_TABLE, LLM_TASKS, ROUTABLE_MODELS, ADVISOR_PAIRINGS, taskForLabel, takeAdvisorSlot, resetAdvisorSlotsForTest } = routing;
const { PRICE_PER_MTOK, estimateLlmCallCostUsd } = await import("../src/llmAccounting");
const llm = await import("../src/llm");
const { ClaudeLLMProvider, LlmRefusalError, shouldWrapperRetry, getRecentLlmCalls } = llm;
const Anthropic = (await import("@anthropic-ai/sdk")).default;
const provider = new ClaudeLLMProvider("sk-ant-stub-key");

const withEnv = async (vars: Record<string, string>, fn: () => Promise<void> | void): Promise<void> => {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { await fn(); } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } resetAdvisorSlotsForTest(); }
};
const oc = (c: Captured | undefined) => (c?.body.output_config as Record<string, unknown> | undefined) ?? undefined;

// ===========================================================================
// 1. The table
// ===========================================================================
console.log("routing table");

// What every call site sent BEFORE routing existed (read off llm.ts at 1f9762a). undefined = no effort sent.
const EFFORT_BEFORE_ROUTING: Record<string, string | undefined> = {
  extractFields: undefined, extractProjectFields: "high", extractProjectFieldsFromImages: "high", classifyCorrection: undefined,
  // classifyPlanPages did not exist before routing: it was BORN on the table at low (scannedPlanSet page index, 2026-09-27).
  classifyPlanPages: "low",
  draftResponse: undefined, visionExtract: "high", reviewPlanSetGeneral: "high", synthesizeKnowledge: undefined,
  researchAhjRequirements: undefined, "researchAhjRequirements.fallback": "high", researchUtilityRequirements: undefined,
  "researchUtilityRequirements.fallback": "high", researchDesignCriteria: undefined, researchJurisdictionCodes: undefined,
  webLookup: undefined, suggestRecipeFieldBindings: undefined, planPortalFields: "high", "planPortalFields.vision": "xhigh",
  verifyPortalFill: undefined, verifyPortalFillVision: "high", lookupInverterSpec: "low", "lookupInverterSpec.web": undefined,
  findAhjFormUrl: undefined, mapAcroFormFields: "high", mapFlatFormOverlay: "high", runToolAgent: undefined, researchFeeSchedule: undefined,
};

await check("with no env, EVERY task routes to claude-opus-5 at exactly the effort it sent before routing", () => {
  for (const task of LLM_TASKS) {
    const r = routeFor(task, { env: {} });
    assert.equal(r.model, "claude-opus-5", `${task} model`);
    assert.equal(r.effort, EFFORT_BEFORE_ROUTING[task], `${task} effort`);
    assert.equal(r.advisor, null, `${task} advisor must be off by default (measured better nowhere)`);
    assert.equal(r.refusalFallback, null, `${task}: nothing to fall back to from the baseline`);
  }
  assert.deepEqual(Object.keys(EFFORT_BEFORE_ROUTING).sort(), [...LLM_TASKS].sort(), "the expectation list covers every task");
});

await check("every table entry cites its evidence", () => {
  for (const task of LLM_TASKS) assert.ok(ROUTE_TABLE[task].evidence.length > 10, task);
});

await check("KILL-TEST: the global switch to Opus 5.5 pins HIGH on every route that sent no effort (its default is medium)", () => {
  const env = { AUTOPILOT_LLM_MODEL: "claude-opus-5-5" };
  for (const task of LLM_TASKS) {
    const r = routeFor(task, { env });
    assert.equal(r.model, "claude-opus-5-5", task);
    assert.ok(r.effort, `${task} resolved to Opus 5.5 with NO effort — it would run at the medium default`);
    assert.equal(r.effort, EFFORT_BEFORE_ROUTING[task] ?? "high", task);
    assert.deepEqual(r.refusalFallback?.model, "claude-opus-5", `${task}: a refusal on 5.5 falls back once to the baseline`);
  }
});

await check("a per-task env moves ONE task (model and effort), leaving the rest on the table", () => {
  const env = { AUTOPILOT_LLM_ROUTE_WEBLOOKUP: "claude-opus-5-5@high" };
  const r = routeFor("webLookup", { env });
  assert.equal(r.model, "claude-opus-5-5"); assert.equal(r.effort, "high"); assert.equal(r.source.model, "task-env");
  assert.equal(routeFor("extractProjectFields", { env }).model, "claude-opus-5");
  assert.equal(routeFor("planPortalFields.vision", { env: { AUTOPILOT_LLM_ROUTE_PLANPORTALFIELDS_VISION: "claude-opus-5-5" } }).effort, "xhigh", "task env naming only a model keeps the table effort");
});

await check("a typo in an env var is REFUSED, never sent: unknown model, unknown effort, unroutable haiku", () => {
  assert.equal(routeFor("draftResponse", { env: { AUTOPILOT_LLM_MODEL: "claude-opus-55" } }).model, "claude-opus-5");
  assert.equal(routeFor("draftResponse", { env: { AUTOPILOT_LLM_ROUTE_DRAFTRESPONSE: "claude-haiku-4-5" } }).model, "claude-opus-5", "haiku is priced but not routable");
  assert.equal(routeFor("draftResponse", { env: { AUTOPILOT_LLM_ROUTE_DRAFTRESPONSE: "claude-opus-5@max" } }).effort, undefined);
});

await check("the caller's effort drives runToolAgent; the Opus 5.5 pin still applies when the caller names none", () => {
  assert.equal(routeFor("runToolAgent", { callerEffort: "low", env: {} }).effort, "low");
  assert.equal(routeFor("runToolAgent", { env: { AUTOPILOT_LLM_MODEL: "claude-opus-5-5" } }).effort, "high");
});

await check("advisor: opt-in per task, capped, only on the measured paths, only on a valid pairing", () => {
  const on = routeFor("extractProjectFields", { env: { AUTOPILOT_LLM_ADVISOR_EXTRACTPROJECTFIELDS: "claude-fable-5-1" } });
  assert.deepEqual(on.advisor, { model: "claude-fable-5-1", maxUses: 1, maxTokens: 2000 });
  assert.equal(routeFor("extractProjectFields", { env: { AUTOPILOT_LLM_ADVISOR_EXTRACTPROJECTFIELDS: "claude-fable-5-1:9" } }).advisor?.maxUses, 3, "max_uses is capped");
  assert.equal(routeFor("planPortalFields", { env: { AUTOPILOT_LLM_ADVISOR_PLANPORTALFIELDS: "claude-fable-5-1" } }).advisor, null, "structured-output path cannot carry it");
  assert.equal(routeFor("webLookup", { env: { AUTOPILOT_LLM_ROUTE_WEBLOOKUP: "claude-opus-5-5", AUTOPILOT_LLM_ADVISOR_WEBLOOKUP: "claude-opus-5" } }).advisor, null, "opus-5 cannot advise the 5.5 executor");
  assert.equal(routeFor("webLookup", { env: { AUTOPILOT_LLM_ADVISOR_WEBLOOKUP: "claude-sonnet-5" } }).advisor, null, "a weaker advisor is refused");
});

await check("the process-wide advisor ceiling closes the tap", () => {
  resetAdvisorSlotsForTest();
  const env = { AUTOPILOT_ADVISOR_MAX_REQUESTS: "2" };
  assert.equal(takeAdvisorSlot(env), true); assert.equal(takeAdvisorSlot(env), true); assert.equal(takeAdvisorSlot(env), false);
  resetAdvisorSlotsForTest();
});

await check("every label llm.ts calls the model under maps onto a routed task", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/llm.ts"), "utf8");
  const labels = new Set<string>();
  for (const m of src.matchAll(/this\.(?:ask|askLong|askLongWithImage|askWithWebSearch|instrument)\(\s*"([^"]+)"/g)) labels.add(m[1]);
  assert.ok(labels.size >= 20, `found only ${labels.size} labels — the scan broke`);
  for (const l of labels) assert.ok(taskForLabel(l), `label "${l}" has no route`);
});

await check("every routable model and every advisor model is priced (an unpriced route reads as free)", () => {
  for (const m of Object.keys(ROUTABLE_MODELS)) assert.ok(PRICE_PER_MTOK[m], m);
  for (const list of Object.values(ADVISOR_PAIRINGS)) for (const m of list) assert.ok(PRICE_PER_MTOK[m], m);
});

// ===========================================================================
// 2. Prices
// ===========================================================================
console.log("prices");
const M = 1_000_000;
const cost = (model: string, t: { in?: number; out?: number; cr?: number; cw?: number }) =>
  estimateLlmCallCostUsd({ label: "x", model, in_tok: t.in ?? 0, out_tok: t.out ?? 0, cache_read: t.cr ?? 0, cache_write: t.cw ?? 0 });

await check("KILL-TEST: claude-opus-5-5 prices at $4/$20, NOT as claude-opus-5 (the runner's prefix-match bug)", () => {
  assert.equal(cost("claude-opus-5-5", { in: M }), 4);
  assert.equal(cost("claude-opus-5-5", { out: M }), 20);
  assert.equal(cost("claude-opus-5", { in: M, out: M }), 30);
});

await check("cache reads are per model: Opus 5.5 $0.20 (0.05x), Fable 5.1 $0.25 (0.025x), Opus 5 $0.50 (0.1x)", () => {
  assert.equal(cost("claude-opus-5-5", { cr: M }), 0.2);
  assert.equal(cost("claude-fable-5-1", { cr: M }), 0.25);
  assert.equal(cost("claude-opus-5", { cr: M }), 0.5);
  assert.equal(cost("claude-opus-5-5", { cw: M }), 5, "5-minute cache write = 1.25x input");
  assert.equal(cost("claude-fable-5-1", { in: M, out: M }), 60);
});

await check("a dated snapshot id prices as its alias; an unknown model is null, never $0", () => {
  assert.equal(cost("claude-haiku-4-5-20251001", { in: M }), 1);
  assert.equal(cost("claude-opus-9", { in: M }), null);
});

// ===========================================================================
// 3. The wire
// ===========================================================================
console.log("wire");
const INTAKE = { planText: "=== SHEET PV-1 === SYSTEM SIZE 10800WATTS DC", defaultState: "AZ" };
const GOOD_JSON = JSON.stringify({ fields: { dcKw: { value: 10.8, confidence: 0.9, evidence: { source: "plan_set", sheet: "PV-1", excerpt: "SYSTEM SIZE10800WATTS DC" } } }, lowConfidenceFields: [], notes: "" });

await check("default intake request: claude-opus-5, effort high, 16000, no advisor beta", async () => {
  captured = []; queue = [{ text: GOOD_JSON }];
  const out = await provider.extractProjectFields(INTAKE);
  assert.equal(out.fields.dcKw?.value, 10.8);
  assert.equal(calls().length, 1);
  const c = calls()[0];
  assert.equal(c.body.model, "claude-opus-5");
  assert.equal(oc(c)?.effort, "high");
  assert.equal(c.body.max_tokens, 16000);
  assert.ok(!String(c.headers["anthropic-beta"] || "").includes("advisor"), "no advisor beta by default");
});

await check("a route that sends no effort still sends none on the baseline (byte-identical to before)", async () => {
  captured = []; queue = [{ text: JSON.stringify({ draft: "x", confidence: 0.5 }) }];
  await provider.draftResponse({ correctionText: "Provide a line diagram." });
  const c = calls()[0];
  assert.equal(c.body.model, "claude-opus-5");
  assert.equal(oc(c), undefined, "output_config must be absent when the route names no effort");
});

await check("the same route moved to Opus 5.5 by env sends effort HIGH on the wire", async () => {
  await withEnv({ AUTOPILOT_LLM_ROUTE_DRAFTRESPONSE: "claude-opus-5-5" }, async () => {
    captured = []; queue = [{ text: JSON.stringify({ draft: "x", confidence: 0.5 }) }];
    await provider.draftResponse({ correctionText: "Provide a line diagram." });
    const c = calls()[0];
    assert.equal(c.body.model, "claude-opus-5-5");
    assert.equal(oc(c)?.effort, "high");
    assert.deepEqual(c.body.thinking, { type: "adaptive" }, "thinking stays adaptive (disabled 400s on 5.5)");
    assert.equal(c.body.tool_choice, undefined, "no forced tool_choice (400s on 5.5)");
  });
});

await check("KILL-TEST: a refusal on the baseline THROWS LlmRefusalError and is NOT re-sent", async () => {
  captured = []; queue = [{ text: "", stop: "refusal", stopDetails: { type: "refusal", category: "bio" } }];
  await assert.rejects(() => provider.extractProjectFields(INTAKE), (err: unknown) => {
    assert.ok(err instanceof LlmRefusalError, `expected LlmRefusalError, got ${String(err)}`);
    assert.equal((err as InstanceType<typeof LlmRefusalError>).category, "bio");
    return true;
  });
  assert.equal(calls().length, 1, `a refused intake was re-sent ${calls().length - 1} time(s)`);
});

await check("a refusal on Opus 5.5 is retried ONCE on claude-opus-5; a second refusal throws", async () => {
  await withEnv({ AUTOPILOT_LLM_ROUTE_EXTRACTPROJECTFIELDS: "claude-opus-5-5@high" }, async () => {
    captured = []; queue = [{ text: "", stop: "refusal", stopDetails: { category: "cyber" } }, { text: GOOD_JSON }];
    const out = await provider.extractProjectFields(INTAKE);
    assert.equal(out.fields.dcKw?.value, 10.8);
    assert.deepEqual(calls().map((c) => c.body.model), ["claude-opus-5-5", "claude-opus-5"]);
    assert.equal(oc(calls()[1])?.effort, "high");
    captured = []; queue = [{ text: "", stop: "refusal", stopDetails: { category: "cyber" } }, { text: "", stop: "refusal" }];
    await assert.rejects(() => provider.extractProjectFields(INTAKE), LlmRefusalError);
    assert.equal(calls().length, 2);
  });
});

await check("a reasoning_extraction decline is NOT retried on a fallback model (the migration guide)", async () => {
  await withEnv({ AUTOPILOT_LLM_ROUTE_EXTRACTPROJECTFIELDS: "claude-opus-5-5@high" }, async () => {
    captured = []; queue = [{ text: "", stop: "refusal", stopDetails: { category: "reasoning_extraction" } }];
    await assert.rejects(() => provider.extractProjectFields(INTAKE), LlmRefusalError);
    assert.equal(calls().length, 1);
  });
});

await check("runToolAgent keeps its contract: a refusal stops the agent cleanly with stopReason 'refusal'", async () => {
  captured = []; queue = [{ text: "", stop: "refusal" }];
  const r = await provider.runToolAgent({ label: "triageAgent", system: "s", user: "u", tools: [] });
  assert.equal(r.stopReason, "refusal");
});

await check("an UNREADABLE intake response is still retried once (the one retry that can help)", async () => {
  captured = []; queue = [{ text: "I cannot see a plan set here." }, { text: GOOD_JSON }];
  const out = await provider.extractProjectFields(INTAKE);
  assert.equal(out.fields.dcKw?.value, 10.8);
  assert.equal(calls().length, 2);
});

await check("KILL-TEST: truncation at the 2x ceiling is NOT re-sent from the top (was up to 4 full calls)", async () => {
  captured = []; queue = [{ text: '{"fields":{"dcKw":', stop: "max_tokens" }, { text: '{"fields":{"dcKw":{"value"', stop: "max_tokens" }];
  await assert.rejects(() => provider.extractProjectFields(INTAKE));
  assert.deepEqual(calls().map((c) => c.body.max_tokens), [16000, 32000], "16000 then its 2x retry, then stop");
});

await check("the wrapper does NOT retry a client timeout (the SDK already retried it; each attempt may be billed)", () => {
  assert.equal(shouldWrapperRetry(new Anthropic.APIConnectionTimeoutError()), false);
  assert.equal(shouldWrapperRetry(new Error('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')), true, "the in-stream overload (Gilbert) is still retried");
  assert.equal(shouldWrapperRetry(Object.assign(new Error("x"), { status: 529 })), true);
});

await check("advisor on: beta header, advisor tool with caps, and its tokens land as their OWN priced ledger row", async () => {
  await withEnv({ AUTOPILOT_LLM_ADVISOR_EXTRACTPROJECTFIELDS: "claude-fable-5-1" }, async () => {
    const since = Date.now();
    captured = [];
    queue = [{ text: GOOD_JSON, usage: { input_tokens: 5000, iterations: [
      { type: "message", input_tokens: 3000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: "advisor_message", model: "claude-fable-5-1", input_tokens: 6000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: "message", input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ] } }];
    await provider.extractProjectFields(INTAKE);
    const c = calls()[0];
    assert.ok(String(c.headers["anthropic-beta"] || "").includes("advisor-tool-2026-03-01"), "beta header missing");
    const tools = (c.body.tools as Array<Record<string, unknown>>) ?? [];
    const adv = tools.find((t) => t.type === "advisor_20260301");
    assert.ok(adv, "advisor tool missing");
    assert.equal(adv!.model, "claude-fable-5-1"); assert.equal(adv!.max_uses, 1); assert.equal(adv!.max_tokens, 2000);
    const rows = getRecentLlmCalls(since);
    const advRow = rows.find((r) => r.label === "extractProjectFields.advisor");
    assert.ok(advRow, `no advisor ledger row in ${JSON.stringify(rows.map((r) => r.label))}`);
    assert.equal(advRow!.model, "claude-fable-5-1"); assert.equal(advRow!.inTok, 6000); assert.equal(advRow!.outTok, 900);
    const execRow = rows.find((r) => r.label === "extractProjectFields");
    assert.equal(execRow?.model, "claude-opus-5");
  });
});

await check("advisor on the lookup path: web_search AND the advisor tool go out together on the beta endpoint", async () => {
  await withEnv({ AUTOPILOT_LLM_ADVISOR_WEBLOOKUP: "claude-fable-5-1" }, async () => {
    captured = []; queue = [{ text: "{}" }];
    const r = await provider.webLookup({ label: "permitProcessLookup.process", system: "Find the permit process.", user: "AHJ: Test City, AZ" });
    assert.equal(r.error, undefined, `webLookup errored: ${r.error}`);
    const c = calls()[0];
    assert.ok(String(c.headers["anthropic-beta"] || "").includes("advisor-tool-2026-03-01"), "beta header missing");
    const types = ((c.body.tools as Array<Record<string, unknown>>) ?? []).map((t) => t.type);
    assert.ok(types.includes("web_search_20260209"), `web_search missing: ${types}`);
    assert.ok(types.includes("advisor_20260301"), `advisor missing: ${types}`);
    assert.equal(c.body.model, "claude-opus-5");
  });
  // ...and without the env, the lookup request is exactly what it was: no beta, no advisor, no effort.
  captured = []; queue = [{ text: "{}" }];
  await provider.webLookup({ label: "permitProcessLookup.process", system: "s", user: "u" });
  const c = calls()[0];
  assert.ok(!String(c.headers["anthropic-beta"] || "").includes("advisor"));
  assert.deepEqual(((c.body.tools as Array<Record<string, unknown>>) ?? []).map((t) => t.type), ["web_search_20260209"]);
  assert.equal(oc(c), undefined);
});

server.close();
if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nmodelRouting: all passed");
