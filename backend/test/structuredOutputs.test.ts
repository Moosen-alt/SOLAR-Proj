// THE SYSTEM'S RELIABILITY DEPENDED ON THE MODEL HAPPENING TO EMIT CLEAN JSON.
//
// llm.ts read 26 structured responses with a tolerant regex-and-JSON.parse and a
// fallback value. When that fallback fired on the portal planner the result was an
// EMPTY PLAN — no fills, no advance, not atReview — which is byte-identical to "the
// planner looked at the page and chose to do nothing", and the learn loop just span.
// The API can make malformed JSON impossible instead: output_config.format constrains
// decoding server-side.
//
// This test drives the REAL provider (ClaudeLLMProvider from ../src/llm, the same class
// createLLMProvider returns) against a LOCAL HTTP STUB standing in for api.anthropic.com
// via ANTHROPIC_BASE_URL. No network, no spend, no mock of llm.ts itself — the request
// body asserted below is the one production would have put on the wire.
//
// THE ASSERTION THAT DIES WITHOUT THE FIX: "the planner request carries a response
// schema". Revert the output_config.format wiring and the captured body has no `format`
// at all, and that check goes red. Verified by reverting — see the report.
//
// Browser-free, no network, no DB writes. Run: tsx backend/test/structuredOutputs.test.ts
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import os from "node:os";

// A scratch path so nothing here can reach the live DB, set BEFORE ../src/llm is
// imported (llm.ts pulls in cecEquipment → schedulerState, which reaches ./db).
process.env.AUTOPILOT_DB_PATH = path.join(os.tmpdir(), `structured-outputs-${process.pid}.sqlite`);

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ---------------------------------------------------------------------------
// The stub API. Speaks both shapes the SDK needs: an SSE stream (every .stream()
// call site) and a plain JSON body (.create() / .parse()).
// ---------------------------------------------------------------------------

interface Captured { path: string; body: Record<string, unknown>; }
let allCaptured: Captured[] = [];
/** Only the /v1/messages completions. llm.ts also makes a one-per-process
 *  /v1/messages/count_tokens measurement of the planner prompt; counting it as a
 *  model call would make every index assertion below depend on which call ran first. */
const messageCalls = (): Captured[] => allCaptured.filter((c) => !c.path.includes("count_tokens"));
const resetCaptured = (): void => { allCaptured = []; };
/** What the next request should answer with. */
let nextText = "";
let nextStop: string = "end_turn";
/** Overrides nextText when set — lets a response carry a tool_use block. */
let nextContent: unknown[] | null = null;

function sseFor(text: string, stop: string): string {
  const msgStart = {
    type: "message_start",
    message: {
      id: "msg_stub", type: "message", role: "assistant", model: "claude-opus-5",
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
  const parts = [
    `event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 44 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];
  return parts.join("");
}

function jsonFor(text: string, stop: string): string {
  return JSON.stringify({
    id: "msg_stub", type: "message", role: "assistant", model: "claude-opus-5",
    content: nextContent ?? [{ type: "text", text, citations: null }],
    stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 44 },
  });
}

/** An SSE stream carrying arbitrary content blocks (used for the tool_use turn). */
function sseForBlocks(blocks: Array<Record<string, unknown>>, stop: string): string {
  const msgStart = {
    type: "message_start",
    message: {
      id: "msg_stub", type: "message", role: "assistant", model: "claude-opus-5",
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 0 },
    },
  };
  const out = [`event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`];
  blocks.forEach((block, i) => {
    if (block.type === "tool_use") {
      out.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } })}\n\n`);
      out.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } })}\n\n`);
    } else {
      out.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i, content_block: { type: "text", text: "", citations: null } })}\n\n`);
      out.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: String(block.text ?? "") } })}\n\n`);
    }
    out.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
  });
  out.push(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 44 } })}\n\n`);
  out.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  return out.join("");
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep {} */ }
    const path = req.url ?? "";
    allCaptured.push({ path, body });
    if (path.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 1234 }));
      return;
    }
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(nextContent
        ? sseForBlocks(nextContent as Array<Record<string, unknown>>, nextStop)
        : sseFor(nextText, nextStop));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jsonFor(nextText, nextStop));
    }
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

// Imported AFTER the base URL is set — the SDK reads ANTHROPIC_BASE_URL when the client
// is constructed, and ClaudeLLMProvider constructs it in its constructor.
const { ClaudeLLMProvider, STRUCTURED_OUTPUT_FORMATS } = await import("../src/llm");
const provider = new ClaudeLLMProvider("sk-ant-stub-key");

const lastBody = (): Record<string, unknown> => messageCalls()[messageCalls().length - 1]?.body ?? {};
const outputConfig = (): Record<string, unknown> => (lastBody().output_config as Record<string, unknown>) ?? {};
const sentFormat = (): { type?: string; schema?: Record<string, unknown> } | undefined =>
  outputConfig().format as { type?: string; schema?: Record<string, unknown> } | undefined;

const PAGE = {
  url: "https://portal.example.gov/apply",
  pageTitle: "Application — Step 2",
  fields: [
    { index: 0, label: "First Name", fieldType: "text", section: "Customer Information" },
    { index: 1, label: "Last Name", fieldType: "text", section: "Customer Information" },
    { index: 2, label: "Continue", fieldType: "button" },
    { index: 3, label: "Pay Fees", fieldType: "button" },
  ],
  bodyText: "Step 2 of 6",
  projectFields: { homeownerFirstName: "Abigail", homeownerLastName: "Boileau" },
  alreadyFilledLabels: [],
};

// ---------------------------------------------------------------------------
// 1. THE WIRE. What production actually sends for the hottest structured route.
// ---------------------------------------------------------------------------

nextText = JSON.stringify({
  fills: [
    { index: 0, value: "Abigail", field: "homeownerFirstName" },
    { index: 1, value: "Boileau", field: null },
  ],
  navigateIndex: null, advanceIndex: 2, finalSubmitIndex: null,
  atReview: false, confidence: "high", notes: "filled customer block",
});
nextStop = "end_turn";
resetCaptured();
const plan = await provider.planPortalFields(PAGE);

await check("KILL-TEST: the planner request carries a response SCHEMA (revert the fix and this dies)", () => {
  const fmt = sentFormat();
  assert.ok(fmt, "planPortalFields sent no output_config.format — the model is free to emit anything");
  assert.equal(fmt.type, "json_schema");
  const schema = fmt.schema as Record<string, unknown>;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false, "additionalProperties:false is required by the supported schema subset");
  assert.deepEqual(schema.required, ["fills", "navigateIndex", "advanceIndex", "finalSubmitIndex", "atReview", "confidence", "notes"]);
});

await check("...and the schema it sends is the module-level const, not a per-call rebuild", () => {
  // The planner re-sends an identical prefix 18-80 times per learn run; a format rebuilt
  // per call would change bytes and cost the prompt cache that CLAUDE.md protects.
  assert.deepEqual(sentFormat(), STRUCTURED_OUTPUT_FORMATS.planPortalFields);
});

await check("effort is still set alongside the format — the schema did not displace it", () => {
  assert.equal(outputConfig().effort, "high");
});

await check("a schema-shaped response flows through to a real plan", () => {
  assert.equal(plan.fills.length, 2);
  assert.deepEqual(plan.fills[0], { index: 0, value: "Abigail", field: "homeownerFirstName" });
  assert.equal(plan.fills[1].field, undefined, "the schema's explicit null must read as 'no field key', not the string 'null'");
  assert.equal(plan.advanceIndex, 2);
  assert.equal(plan.navigateIndex, undefined, "a null index is absent, not index 0");
  assert.equal(plan.finalSubmitIndex, undefined);
  assert.equal(plan.confidence, "high");
});

// ---------------------------------------------------------------------------
// 2. THE SAFETY POST-FILTERS STILL RUN. A schema cannot express "never click Pay",
//    so CLAUDE.md rule 1's guards must survive the structured path unchanged.
// ---------------------------------------------------------------------------

nextText = JSON.stringify({
  fills: [], navigateIndex: 3, advanceIndex: 3, finalSubmitIndex: 3,
  atReview: false, confidence: "high", notes: "pay to continue",
});
resetCaptured();
const payPlan = await provider.planPortalFields(PAGE);

await check("a schema-valid plan that points at a PAY button is still stripped of it", () => {
  assert.equal(payPlan.advanceIndex, undefined, "automation must never click a pay/fee button");
  assert.equal(payPlan.navigateIndex, undefined);
  assert.equal(payPlan.finalSubmitIndex, undefined);
});

// ---------------------------------------------------------------------------
// 3. THE NET WE DID NOT REMOVE. A schema cannot prevent max_tokens truncation or a
//    refusal, so the tolerant repair path has to still be there and still not throw.
// ---------------------------------------------------------------------------

nextText = `{"fills":[{"index":0,"value":"Abig`; // clipped mid-object
nextStop = "max_tokens";
resetCaptured();
const truncated = await provider.planPortalFields(PAGE);

await check("a TRUNCATED response degrades to an empty plan instead of throwing", () => {
  assert.equal(truncated.fills.length, 0);
  assert.equal(truncated.advanceIndex, undefined);
  assert.equal(truncated.atReview, false);
  assert.equal(truncated.confidence, "low");
});

await check("...and the truncation retried at 2x rather than silently accepting the clip", () => {
  // askLong's max_tokens retry is the safety netting that predates this change; the
  // structured path must not have deleted it.
  assert.equal(messageCalls().length, 2, "expected the one retry askLong makes on an unusable max_tokens response");
  assert.equal(messageCalls()[0].body.max_tokens, 8192);
  assert.equal(messageCalls()[1].body.max_tokens, 16384);
});

nextText = "I can't help with that.";
nextStop = "refusal";
resetCaptured();
const refused = await provider.planPortalFields(PAGE);
await check("a REFUSAL (not JSON at all) still degrades to an empty plan, not an exception", () => {
  assert.equal(refused.fills.length, 0);
  assert.equal(refused.confidence, "low");
});

// ---------------------------------------------------------------------------
// 4. THE FIELD MAPPER. Its wire shape had to move from an open-keyed object to
//    arrays (a Record of PDF field names cannot carry additionalProperties:false),
//    but AhjFieldMapResult is unchanged and the LEGACY object shape still parses.
// ---------------------------------------------------------------------------

const MAP_INPUT = {
  ahj: "City of Newberg", state: "OR", formName: "Building Permit Application",
  fields: [{ name: "OwnerName", type: "text" }, { name: "TypeOther", type: "checkbox" }],
  availableSources: ["project.homeownerName", "lit:X"],
};

nextText = JSON.stringify({
  textFields: [{ name: "OwnerName", source: "project.homeownerName" }],
  checkboxes: [{ name: "TypeOther", source: "lit:X", equals: null }],
  notes: "signature left for the human",
});
nextStop = "end_turn";
resetCaptured();
const mapped = await provider.mapAcroFormFields(MAP_INPUT);

await check("the field mapper sends an ARRAY schema and folds it back into the Record result", () => {
  const schema = sentFormat()?.schema as Record<string, unknown>;
  const props = schema.properties as Record<string, { type?: string }>;
  assert.equal(props.textFields.type, "array", "an open map of PDF field names is not expressible in the supported subset");
  assert.equal(props.checkboxes.type, "array");
  assert.deepEqual(mapped.textFields, { OwnerName: "project.homeownerName" });
  assert.deepEqual(mapped.checkboxes, { TypeOther: { source: "lit:X" } }, "a null equals must be DROPPED, not stored as ''");
  assert.equal(mapped.notes, "signature left for the human");
});

nextText = JSON.stringify({
  textFields: { OwnerName: "project.homeownerName" },
  checkboxes: { TypeOther: { source: "lit:X", equals: "yes" } },
  notes: "legacy shape",
});
resetCaptured();
const legacyMapped = await provider.mapAcroFormFields(MAP_INPUT);

await check("the LEGACY object shape still parses — the repair path was kept, not replaced", () => {
  assert.deepEqual(legacyMapped.textFields, { OwnerName: "project.homeownerName" });
  assert.deepEqual(legacyMapped.checkboxes, { TypeOther: { source: "lit:X", equals: "yes" } });
  assert.equal(legacyMapped.notes, "legacy shape");
});

nextText = JSON.stringify({
  textFields: [{ name: "OwnerName", source: "whatever.the.model.invented" }],
  checkboxes: [], notes: "",
});
resetCaptured();
const junkMapped = await provider.mapAcroFormFields(MAP_INPUT);
await check("an invented source is still dropped — a schema constrains SHAPE, never meaning", () => {
  assert.deepEqual(junkMapped.textFields, {});
});

// ---------------------------------------------------------------------------
// 5. classifyCorrection — the one route on the SDK's own client.messages.parse().
// ---------------------------------------------------------------------------

nextText = JSON.stringify({ bucket: "fee_request", confidence: 0.92, notes: "invoice attached" });
resetCaptured();
const classified = await provider.classifyCorrection({ correctionText: "Please remit the $312 plan review fee." });

await check("classifyCorrection goes through messages.parse with a schema, non-streaming", () => {
  assert.equal(lastBody().stream, undefined, "messages.parse() must not stream");
  assert.equal(sentFormat()?.type, "json_schema");
  assert.equal(classified.bucket, "fee_request");
  assert.equal(classified.confidence, 0.92);
});

nextText = "not json at all";
resetCaptured();
const unreadable = await provider.classifyCorrection({ correctionText: "…" });
await check("...and when the SDK's parser throws, the route lands on its documented default", () => {
  // The SDK's client-side parse THROWS on unparseable content — contained here because
  // the output is three small keys and the catch returns the same value this route
  // already returned on a parse failure.
  assert.equal(unreadable.bucket, "C_reviewer_clarification");
  assert.equal(unreadable.confidence, 0.3);
});

// ---------------------------------------------------------------------------
// 6. STRICT TOOL USE on the agent loop. runToolAgent is what correctionAgent.ts and
//    runTriage.ts call; its tools SET A BUCKET, SET A SEVERITY and PROPOSE A DATA
//    UPDATE, so an input the schema never described must not reach a handler.
// ---------------------------------------------------------------------------

let handlerSaw: Record<string, unknown> | null = null;
const AGENT_TOOLS = [
  {
    // Shape A, taken verbatim from correctionAgent.ts: a property NOT in `required`.
    name: "propose_data_update",
    description: "Propose a corrected value for one project field.",
    input_schema: {
      type: "object",
      properties: {
        field: { type: "string" },
        currentValue: { type: "string" },
        proposedValue: { type: "string" },
      },
      required: ["field", "proposedValue"],
    } as Record<string, unknown>,
    handler: async (i: Record<string, unknown>) => { handlerSaw = i; return { kind: "text" as const, text: "proposed" }; },
  },
  {
    // Shape B, also verbatim: an EMPTY properties bag with no `required` at all.
    name: "get_correction_text",
    description: "The full text of the correction notice.",
    input_schema: { type: "object", properties: {} } as Record<string, unknown>,
    handler: async () => ({ kind: "text" as const, text: "the notice" }),
  },
];

nextContent = [{ type: "tool_use", id: "tu_1", name: "propose_data_update", input: { field: "ahj", proposedValue: "City Of Salem" } }];
nextStop = "tool_use";
resetCaptured();
let agentCalls = 0;
const agentRun = await provider.runToolAgent({
  label: "correctionAgent",
  system: "You triage a correction.",
  user: "The AHJ is wrong.",
  tools: AGENT_TOOLS.map((t) => ({
    ...t,
    handler: async (i: Record<string, unknown>) => {
      agentCalls++;
      // After the first tool turn, answer with plain text so the loop terminates.
      nextContent = null; nextText = "done"; nextStop = "end_turn";
      return t.handler(i);
    },
  })),
  maxIterations: 3,
});

await check("agent tools go out as STRICT, with every object closed", () => {
  const tools = messageCalls()[0].body.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 2);
  for (const t of tools) {
    assert.equal(t.strict, true, `${String(t.name)} was sent without strict:true — the API will not validate its input`);
    const schema = t.input_schema as Record<string, unknown>;
    assert.equal(schema.additionalProperties, false, `${String(t.name)}: strict tool use requires additionalProperties:false`);
  }
});

await check("...without rewriting `required` — both authored shapes survive untouched", () => {
  // Probed against the live API before shipping: a property absent from `required` is
  // accepted, and so is `properties: {}` with no `required`. So no caller has to change.
  const tools = messageCalls()[0].body.tools as Array<Record<string, unknown>>;
  const propose = tools.find((t) => t.name === "propose_data_update")!.input_schema as Record<string, unknown>;
  assert.deepEqual(propose.required, ["field", "proposedValue"], "currentValue must NOT have been forced into required");
  const getText = tools.find((t) => t.name === "get_correction_text")!.input_schema as Record<string, unknown>;
  assert.equal(getText.required, undefined, "an empty properties bag keeps having no `required`");
});

await check("the agent loop still runs the handler and finishes", () => {
  assert.equal(agentCalls, 1);
  assert.deepEqual(handlerSaw, { field: "ahj", proposedValue: "City Of Salem" });
  assert.equal(agentRun.hitIterationCap, false);
  assert.equal(agentRun.finalText, "done");
});

nextContent = null;

// ---------------------------------------------------------------------------
// 7. SCHEMA INVARIANTS. Every format production can send must sit inside the
//    supported JSON-schema subset, or the API rejects the request with a 400 and
//    the route is dead — not degraded, dead.
// ---------------------------------------------------------------------------

function walk(node: unknown, at: string, visit: (obj: Record<string, unknown>, at: string) => void): void {
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (o.type === "object") visit(o, at);
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) v.forEach((e, i) => walk(e, `${at}.${k}[${i}]`, visit));
    else if (v && typeof v === "object") walk(v, `${at}.${k}`, visit);
  }
}

for (const [route, fmt] of Object.entries(STRUCTURED_OUTPUT_FORMATS)) {
  await check(`${route}: every object is closed and lists every property as required`, () => {
    const schema = fmt.schema as Record<string, unknown>;
    assert.equal(schema.type, "object", "the top level of an output format must be an object");
    walk(schema, route, (obj, at) => {
      assert.equal(obj.additionalProperties, false, `${at}: additionalProperties must be false`);
      const props = Object.keys((obj.properties as Record<string, unknown>) ?? {});
      const required = (obj.required as string[]) ?? [];
      assert.deepEqual([...required].sort(), [...props].sort(),
        `${at}: nullable-required, not optional — every property must appear in "required"`);
    });
  });
  await check(`${route}: carries no keyword outside the supported subset`, () => {
    // The SDK's transform folds unsupported keywords into `description`; anything it
    // could not place would show up here as a raw keyword.
    const ALLOWED = new Set(["type", "properties", "additionalProperties", "required", "items", "anyOf", "allOf", "$ref", "$defs", "description", "title", "format", "minItems"]);
    const seen: string[] = [];
    const scan = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(scan); return; }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const parentIsBag = false;
        if (!ALLOWED.has(k) && !parentIsBag) seen.push(k);
        if (k === "properties" || k === "$defs") { Object.values(v as Record<string, unknown>).forEach(scan); continue; }
        scan(v);
      }
    };
    // Only scan the schema skeleton, not user-named property keys.
    const skeleton = JSON.parse(JSON.stringify(fmt.schema)) as Record<string, unknown>;
    scan(skeleton);
    assert.deepEqual(seen.filter((k) => !ALLOWED.has(k)), [], `unsupported schema keywords: ${seen.join(", ")}`);
  });
}

await check("the root schema carries no $schema dialect noise in its description", () => {
  for (const [route, fmt] of Object.entries(STRUCTURED_OUTPUT_FORMATS)) {
    const desc = (fmt.schema as Record<string, unknown>).description;
    assert.ok(typeof desc !== "string" || !desc.startsWith("{$schema:"), `${route} leaks the JSON-schema dialect URI into the prompt`);
  }
});

server.close();
if (failures) { console.error(`\n${failures} structured-output check(s) FAILED.`); process.exit(1); }
console.log("\nAll structured-output checks passed.");
process.exit(0);
