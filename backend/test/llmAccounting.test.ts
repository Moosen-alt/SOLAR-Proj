// LLM-6: persistent model-call accounting.
//   · recordLlmCall (the one function every call site uses) writes an llm_calls row, with the
//     model, attributed to the AsyncLocalStorage context it runs under.
//   · A REAL job, run by the worker, whose model call is a stubbed HTTP response, lands a row
//     carrying that job's project, job id and org — the attribution the worker sets.
//   · llmUsageForProject rolls one project up per label; an unknown model prices as null.
//   · Persisting never throws, even against a closed database.
// The route's tenant scoping is asserted over real HTTP in tenancy.test.ts.
// Run: tsx backend/test/llmAccounting.test.ts
import "./_isolate";
import assert from "node:assert/strict";

process.env.SEED_TEST_INSTALLER = "false";
process.env.FEE_RESEARCH = "off"; // no auto-research: the only fee_research job is the one enqueued below
delete process.env.AUTOPILOT_LLM_MODEL;
delete process.env.ANTHROPIC_BASE_URL;

const { openDatabase } = await import("../src/db");
const { recordLlmCall } = await import("../src/llm");
const { runWithLlmContext, llmUsageForProject, attachLlmCallStore } = await import("../src/llmAccounting");
const { enqueueJob, processNextJob } = await import("../src/jobQueue");
const { createProject } = await import("../src/repository");

const db = await openDatabase();
let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
type CallRow = { label: string; model: string; in_tok: number | null; out_tok: number | null; cache_read: number | null; project_id: string | null; job_id: string | null; org_id: string | null; error: string | null };
const rowsLike = (label: string) => db.query<CallRow>("SELECT * FROM llm_calls WHERE label LIKE ? ORDER BY id", [label]);

const project = createProject(db, { owner: "Accounting Test", address: "1 Test Way", city: "Testville", state: "OR", zip: "97000", ahj: "City of Testville", utility: "PGE", dcKw: "6", valuation: "15000" }).project;
const projectOrg = db.get<{ org_id: string }>("SELECT org_id FROM projects WHERE id = ?", [project.id])!.org_id;

await run("recordLlmCall inside a context persists a row with that project/job/org and the model", () => {
  runWithLlmContext({ projectId: project.id, jobId: "job-direct", orgId: projectOrg }, () => {
    recordLlmCall({ at: Date.now(), label: "direct.op", ms: 12, inTok: 100, outTok: 20, cacheRead: 50, stop: "end_turn" });
  });
  const [row] = rowsLike("direct.op");
  assert.ok(row, "no llm_calls row was written");
  assert.equal(row.project_id, project.id);
  assert.equal(row.job_id, "job-direct");
  assert.equal(row.org_id, projectOrg);
  assert.equal(row.model, "claude-opus-5", "the model must be recorded, not implicit");
  assert.equal(row.in_tok, 100);
  assert.equal(row.cache_read, 50);
});

await run("outside any context the row is unattributed (background work runs as system)", () => {
  recordLlmCall({ at: Date.now(), label: "system.op", ms: 1, inTok: 1, outTok: 1 });
  const [row] = rowsLike("system.op");
  assert.ok(row);
  assert.equal(row.project_id, null);
  assert.equal(row.org_id, null);
});

await run("a real job's stubbed model call is attributed to the job's project by the worker", async () => {
  // The fee researcher builds its Anthropic client per run and the SDK reads globalThis.fetch at
  // construction, so a stubbed fetch answers the real call path. One SSE message, end_turn.
  const sse = [
    ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1234, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "{\"found\": false, \"reason\": \"stub\"}" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 56 } }],
    ["message_stop", { type: "message_stop" }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const realFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("/v1/messages")) return realFetch(input, init);
    modelCalls++;
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  try {
    const job = enqueueJob(db, "fee_research", {
      state: "OR", ahj: "City of Testville", utility: "PGE", track: "permit", discipline: "electrical",
      profileKey: "or|city of testville|unknown", researchKey: "permit|or|city of testville|unknown|electrical",
    }, { projectId: project.id, maxRetries: 1, scheduledAt: new Date(0).toISOString() });
    assert.equal(await processNextJob(db), true, "the worker claimed nothing");
    assert.ok(modelCalls >= 1, "the stubbed model endpoint was never called");
    const rows = rowsLike("researchFeeSchedule[%");
    assert.ok(rows.length >= 1, "the job's model call left no llm_calls row");
    for (const row of rows) {
      assert.equal(row.project_id, project.id, "not attributed to the job's project");
      assert.equal(row.job_id, job.id, "not attributed to the job");
      assert.equal(row.org_id, projectOrg);
      assert.equal(row.model, "claude-opus-5");
    }
    assert.equal(rows[0].in_tok, 1234);
    assert.equal(rows[0].out_tok, 56);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

await run("llmUsageForProject: per-label rollup, turn suffixes folded, estimated cost; unknown model is null", () => {
  const usage = llmUsageForProject(db, project.id);
  assert.ok(usage.calls >= 2);
  const direct = usage.byLabel.find((l) => l.label === "direct.op")!;
  assert.equal(direct.calls, 1);
  // 100 in × $5/M + 20 out × $25/M + 50 cache-read × $0.50/M
  assert.equal(direct.estimatedCostUsd, Math.round((100 * 5 + 20 * 25 + 50 * 0.5) / 1_000_000 * 10_000) / 10_000);
  assert.ok(usage.byLabel.some((l) => /^researchFeeSchedule\[[^#]*\]$/.test(l.label)), "a turn suffix leaked into the label");
  assert.ok(usage.estimatedCostUsd != null);
  runWithLlmContext({ projectId: project.id }, () => recordLlmCall({ at: Date.now(), label: "odd.op", model: "some-future-model", ms: 1, inTok: 10, outTok: 10 }));
  const after = llmUsageForProject(db, project.id);
  assert.equal(after.unpricedCalls, 1);
  assert.equal(after.estimatedCostUsd, null, "an unpriced call must not read as a known total");
  assert.equal(llmUsageForProject(db, "no-such-project").calls, 0);
});

await run("persisting never throws — a closed store costs a row, not the model call", async () => {
  const other = await openDatabase(); // attaches itself
  other.close();
  assert.doesNotThrow(() => recordLlmCall({ at: Date.now(), label: "after.close", ms: 1 }));
  attachLlmCallStore(db);
});

db.close();
console.log(failures ? `\n${failures} FAILED` : "\nall llm-accounting tests passed");
process.exit(failures ? 1 : 0);
