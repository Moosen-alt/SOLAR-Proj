import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { performance } from "node:perf_hooks";
import type { AcroFieldForMapping, AgentRunInput, AgentRunResult, AgentToolResult, AhjFieldMapResult, AhjFormUrlResult, AhjOverlayMapResult, AhjResearchResult, CorrectionBucket, InverterSpecLookup, LLMProvider, MboxExtractedLearningRecord, ParserLlmExtraction, PortalFieldPlan, PortalFieldPlanInput, PortalFillVerification, PortalFillVerifyInput, PortalFillVisionVerifyInput, ProjectRecord, UtilityResearchResult, AiPlanReviewResult, ReviewWorkType, JurisdictionCodeProfile, JurisdictionCodeResearchResult, JurisdictionCodeResearchInput, DesignCriteriaResearchResult, ParserExtractedField, ParserFieldEvidence, ParserExtractionConflict, ParserExtractionUncertainty, ParserExtractionResolution, PlanPageIndex, CodeEdition, CodeFamily, CodeFamilyAdoptionModel, JurisdictionAdoptionModel, UpcomingCodeEdition, WebLookupResult } from "../../shared/src/types";
import { RECIPE_FIELD_DESCRIPTIONS } from "./portalRecipes";
import { RESEARCH_PORTAL_UNCONFIRMED_NOTE } from "./researchedPortalUrl";
import { scopeResultsToState, stateScopeOf, stateScopedFormQueries } from "./formSearchScope";
import { logger } from "./logger";
import { persistLlmCall } from "./llmAccounting";
import { routeFor, taskForLabel, takeAdvisorSlot, describeRoutes, BASELINE_MODEL, type LlmEffort, type LlmTask, type ResolvedRoute, type AdvisorConfig } from "./modelRouting";
import { lookupCecInverter, lookupCecModuleMake } from "./cecEquipment";
import { planTextForExtraction } from "./structuralIntake";
import { CONTRACT_PRICE_LABEL, VALUATION_BOX_LABEL } from "./valuation";
import { parseAmendmentCheck } from "./amendmentChecks";
import type { CodeResearchProvenance } from "./codeProfiles";

// Claude Opus 5: drop-in successor to Opus 4.8 at identical pricing with a
// step-change in agentic/vision capability. Verified safe for this codebase:
// every call site already uses adaptive thinking (on by default on Opus 5), no
// sampling params, no prefills, no thinking:{disabled}. Prompt-cache minimum
// also drops 1024→512 tokens, so mid-size system prompts start caching.
// NOTE: claude-opus-5 draws from a SEPARATE rate-limit bucket than Opus 4.x.
//
// PER-TASK ROUTING (2026-09-26): there is no longer one MODEL constant. Every call asks
// modelRouting.routeFor(task) for its model, effort and (opt-in) advisor; the shipped table keeps
// every task on claude-opus-5 at the effort it sent before, and cites the measurement for each.
// This is only the label a record falls back to when a caller does not name its model.
const fallbackRecordModel = (): string => (process.env.AUTOPILOT_LLM_MODEL || BASELINE_MODEL).trim();

/** A safety classifier declined the request (HTTP 200, stop_reason "refusal"). A NAMED failure: its
 *  content is not an answer, empty or otherwise, and re-sending the same bytes to the same model is
 *  refused the same way — callers must not read it as "nothing found" and must not retry it as-is. */
export class LlmRefusalError extends Error {
  readonly label: string;
  readonly model: string;
  readonly category: string | null;
  constructor(label: string, model: string, category: string | null) {
    super(`${label}: the model's safety classifier declined this request${category ? ` (category: ${category})` : ""} — no answer was produced`);
    this.name = "LlmRefusalError";
    this.label = label;
    this.model = model;
    this.category = category;
  }
}

/** The model returned a response that could not be read as the JSON the route asked for. */
export class LlmUnreadableResponseError extends Error {
  /** The final stop reason: "max_tokens" here means the output ran into the budget's 2x ceiling. */
  readonly stopReason: string | null;
  constructor(message: string, stopReason: string | null) {
    super(message);
    this.name = "LlmUnreadableResponseError";
    this.stopReason = stopReason;
  }
}

/** What one request is sent with — the route, or its refusal fallback. */
interface CallTarget {
  model: string;
  effort?: LlmEffort;
  advisor: AdvisorConfig | null;
}

const ADVISOR_BETA = "advisor-tool-2026-03-01";
/** Appended to the user turn ONLY when the advisor is on. Without a nudge the consult rate is the
 *  fragile variable (cost-optimization guide); every measured advisor config carried one. */
const ADVISOR_NUDGE = "\n\n(Before you write the final answer, consult the advisor once about the point where the sources conflict or where your reading is least certain.)";

/** output_config from a target's effort plus an optional response format; undefined when empty so a
 *  route that names no effort sends exactly the bytes it sent before routing existed. */
function outputConfigFor(t: CallTarget, format?: Anthropic.JSONOutputFormat): { effort?: LlmEffort; format?: Anthropic.JSONOutputFormat } | undefined {
  const oc = { ...(t.effort ? { effort: t.effort } : {}), ...(format ? { format } : {}) };
  return Object.keys(oc).length ? oc : undefined;
}

/** The advisor tool definition for a target (the API rejects max_tokens < 1024). */
function advisorToolFor(a: AdvisorConfig): Record<string, unknown> {
  return { type: "advisor_20260301", name: "advisor", model: a.model, max_uses: a.maxUses, max_tokens: Math.max(1024, a.maxTokens) };
}

// Does the (possibly truncated) response text contain a complete, parseable JSON object?
// Used by the max_tokens retry: when the JSON block finished before the cap and only
// trailing prose was clipped, the response is fully usable and re-running the call would
// double the cost of the hottest planner step for nothing.
function hasCompleteJsonBlock(text: string): boolean {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return false;
  try { JSON.parse(text.slice(start, end + 1)); return true; } catch { return false; }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// STRUCTURED OUTPUTS — stop depending on the model happening to emit clean JSON.
//
// `output_config.format` constrains DECODING server-side: the bytes coming back
// are already valid JSON matching the schema, so the failure mode this file was
// built to survive (a brace in the wrong place → parseJson returns the fallback →
// an empty plan that looks exactly like "the planner chose to do nothing") cannot
// occur at all. The repair paths below are KEPT as the net for the two failures a
// schema cannot prevent — `max_tokens` truncation and a safety `refusal`.
//
// WIRE-ONLY FORMAT, DELIBERATELY. zodOutputFormat() returns {type, schema, parse};
// passing the whole thing to .stream()/.create() makes the SDK run `parse` inside
// the stream and THROW an AnthropicError on any content it cannot validate — which
// would destroy the raw text that hasCompleteJsonBlock's 2× retry, the
// "Response began: …" diagnostic in normalizeExtraction, and the "no actionable
// plan" warning all read. So we send {type, schema} only and validate client-side
// with safeParse, where a failure is a VALUE (null) we can fall back from rather
// than an exception that eats the evidence. `client.messages.parse()` is used only
// where a throw is contained and the output is too small to truncate
// (classifyCorrection).
//
// The formats are module-level consts: the planner re-sends an identical request
// prefix on every page of a learn run (18-80 calls), and a format rebuilt per call
// would change bytes and cost the prompt cache.
// ---------------------------------------------------------------------------

/** The wire half of a zod schema: a plain JSONOutputFormat with NO client parse fn.
 *  See the note above — attaching `parse` makes the SDK throw inside the stream. */
function wireFormat(schema: z.ZodType): Anthropic.JSONOutputFormat {
  const built = zodOutputFormat(schema);
  const json: Record<string, unknown> = { ...built.schema };
  // zod stamps `$schema` on the root object. The SDK's schema transform is an allowlist
  // and folds any keyword the API does not take into `description` — so that dialect URI
  // would arrive as a line of prompt noise on the root of every request. It carries no
  // constraint; drop it. (The same fold is what turns z.enum() into a description hint —
  // that one is wanted, and our own safeParse still enforces the enum.)
  if (typeof json.description === "string" && /^\{\$schema:/.test(json.description)) delete json.description;
  return { type: built.type, schema: json };
}

/** Close every object in a TOOL input schema so `strict: true` is legal on it.
 *  Strict tool use requires `additionalProperties: false`; `required` is left exactly as
 *  the caller authored it. Both of the shapes this repo's agent tools actually use were
 *  probed against the live API before this shipped: a schema with a property absent from
 *  `required` is ACCEPTED, and so is `properties: {}` with no `required` at all — so no
 *  caller in correctionAgent.ts / runTriage.ts has to change to gain the guarantee.
 *  Recursive because a nested open object would be rejected just as a top-level one is. */
function closeToolSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((e) => closeToolSchema(e)) as unknown as T;
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) out[k] = closeToolSchema(v);
  if (out.type === "object") out.additionalProperties = false;
  return out as unknown as T;
}

/** Nullable-required rather than optional: the supported JSON-schema subset is
 *  smallest and most predictable when every property is present, and every call
 *  site here already reads a null/non-number as "absent". */
const nullableNumber = z.union([z.number(), z.null()]);
const nullableString = z.union([z.string(), z.null()]);
const confidenceEnum = z.enum(["low", "medium", "high"]);

/** planPortalFields — the hottest structured call in the system (18-80 per learn
 *  run) and the one whose unparseable response used to read as a silent stall. */
const portalFieldPlanSchema = z.object({
  fills: z.array(z.object({
    index: z.number(),
    value: z.string(),
    field: nullableString,
  })),
  navigateIndex: nullableNumber,
  advanceIndex: nullableNumber,
  finalSubmitIndex: nullableNumber,
  atReview: z.boolean(),
  confidence: confidenceEnum,
  notes: z.string(),
});
const PORTAL_FIELD_PLAN_FORMAT = wireFormat(portalFieldPlanSchema);

/** verifyPortalFill / verifyPortalFillVision — gates whether a recorded recipe is
 *  trusted for reuse, so an unreadable answer is a silently untrusted recipe. */
const portalFillVerificationSchema = z.object({
  matches: z.array(z.object({
    label: z.string(),
    expected: z.string(),
    found: z.string(),
    ok: z.boolean(),
  })),
  overallConfidence: confidenceEnum,
  accurate: z.boolean(),
  issues: z.array(z.string()),
  notes: z.string(),
});
const PORTAL_FILL_VERIFICATION_FORMAT = wireFormat(portalFillVerificationSchema);

/** mapAcroFormFields — RESHAPED to arrays on the wire. The result type keeps its
 *  Record<fieldName, source> shape; the transport cannot, because a JSON schema in
 *  the supported subset needs `additionalProperties: false` on every object and an
 *  open map of PDF field names is exactly `additionalProperties: <schema>`. The
 *  arrays are folded back into the Records below, so AhjFieldMapResult is unchanged. */
const acroFieldMapSchema = z.object({
  textFields: z.array(z.object({ name: z.string(), source: z.string() })),
  checkboxes: z.array(z.object({ name: z.string(), source: z.string(), equals: nullableString })),
  notes: z.string(),
});
const ACRO_FIELD_MAP_FORMAT = wireFormat(acroFieldMapSchema);

/** mapFlatFormOverlay — coordinates are drawn VERBATIM onto a permit PDF, so the
 *  0..1 range checks stay client-side (numeric bounds are outside the schema subset). */
const overlayMapSchema = z.object({
  fields: z.array(z.object({
    source: z.string(),
    page: z.number(),
    nx: z.number(),
    ny: z.number(),
    size: nullableNumber,
    maxWidthFrac: nullableNumber,
    label: nullableString,
  })),
  signatures: z.array(z.object({
    role: z.enum(["applicant", "owner", "contractor", "electrician", "other"]),
    page: z.number(),
    nx: z.number(),
    ny: z.number(),
    widthFrac: nullableNumber,
    heightFrac: nullableNumber,
    dateNx: nullableNumber,
    dateNy: nullableNumber,
    label: nullableString,
  })),
  notes: z.string(),
});
const OVERLAY_MAP_FORMAT = wireFormat(overlayMapSchema);

/** suggestRecipeFieldBindings — the route answered with a bare JSON ARRAY, which a
 *  format cannot express (the top level must be an object). Wrapped in `bindings`. */
const recipeFieldBindingsSchema = z.object({
  bindings: z.array(z.object({ index: z.number(), field: nullableString })),
});
const RECIPE_FIELD_BINDINGS_FORMAT = wireFormat(recipeFieldBindingsSchema);

/** classifyCorrection — small enough that truncation is not a real failure mode, so
 *  this is the one route that uses the SDK's own client.messages.parse(). */
const CORRECTION_BUCKETS = [
  "permit_approval", "permit_correction", "nem_approval", "nem_correction",
  "status_update", "missing_info_request", "fee_request", "inspection_final_notice",
  "spam_irrelevant",
] as const;
const correctionClassificationSchema = z.object({
  bucket: z.enum(CORRECTION_BUCKETS),
  confidence: z.number(),
  notes: z.string(),
});

// Exported for backend/test/structuredOutputs.test.ts: the test asserts the exact
// wire schemas production sends, so it must read the same consts production reads.
export const STRUCTURED_OUTPUT_FORMATS = {
  planPortalFields: PORTAL_FIELD_PLAN_FORMAT,
  verifyPortalFill: PORTAL_FILL_VERIFICATION_FORMAT,
  mapAcroFormFields: ACRO_FIELD_MAP_FORMAT,
  mapFlatFormOverlay: OVERLAY_MAP_FORMAT,
  suggestRecipeFieldBindings: RECIPE_FIELD_BINDINGS_FORMAT,
  classifyCorrection: wireFormat(correctionClassificationSchema),
} as const;

// ---------------------------------------------------------------------------
// LLM call log — an in-memory ring buffer of every Claude call's outcome
// (operation, latency, token usage, stop_reason, error). The auto-learn
// pipeline dumps the calls made during a learn run into that run's debug
// bundle (llm-calls.json) so a pasted bundle shows exactly what the model
// was asked to do and how each call ended — refusals and max_tokens
// truncations included, which are the usual silent killers. Metadata only:
// prompts and responses are never stored here.
// ---------------------------------------------------------------------------

export interface LlmCallRecord {
  at: number; // epoch ms
  label: string;
  ms: number;
  inTok?: number;
  outTok?: number;
  cacheRead?: number;
  cacheWrite?: number;
  stop?: string | null;
  error?: string;
  /** The model that answered. Implicit before LLM-6, so a model change silently re-priced history. */
  model?: string;
  /** Server-side web searches this call ran (usage.server_tool_use.web_search_requests) — billed at
   *  $10 per 1,000 on top of tokens. undefined = the response reported nothing (unknown stays unknown). */
  webSearches?: number;
}

/** The web-search count a response reports. Read from usage (the billing source), not from content
 *  blocks: a search the server ran and billed is a search. ON THE REAL WIRE `server_tool_use` IS
 *  OMITTED when no server tool ran (probed 2026-09-26 on message_start + message_delta: create with
 *  no tools, stream with no tools, stream WITH the web_search tool and no search — absent in all
 *  three, present only on a turn that searched; the SDK type `ServerToolUsage | null` is not what
 *  arrives). So a usage object WITHOUT the key is a KNOWN zero, and null likewise. Only a missing
 *  or non-usage object (a stub with no usage at all) is unknown (undefined); a pre-v38 ledger row is
 *  NULL by its own age, never re-read. Before this rule 17 of 25 live rows recorded NULL = "unknown". */
export function webSearchRequestsOf(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as { input_tokens?: unknown; output_tokens?: unknown; server_tool_use?: { web_search_requests?: unknown } | null };
  if (!("server_tool_use" in u)) return "input_tokens" in u || "output_tokens" in u ? 0 : undefined;
  const st = u.server_tool_use;
  if (st == null) return 0;
  if (typeof st !== "object") return undefined;
  const n = Number(st.web_search_requests);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** MULTI-TURN HISTORY IS CACHED FROM THE LAST TURN, NOT JUST THE SYSTEM PROMPT.
 *
 *  Both tool loops (runToolAgent below; feeSchedules.claudeFeeScheduleResearcher) re-send the whole
 *  growing conversation on every turn with a breakpoint on the system prompt only. Measured (prod +
 *  new-AHJ e2e, 2026-09-26): fee-research input grew 17k → 42k per turn while cache_read stayed flat
 *  at the 7.5k system prompt — 57-75% of a track's spend was history re-billed at full price; triage
 *  was 57k uncached across 9 turns. The one exception was any turn whose assistant message carried
 *  a server-side web search (the API inserts its own write after those results), which is why some
 *  turns read `in=2` and the rest paid in full: a cache entry is only READ from a breakpoint that can
 *  look back to it, and the open_document / local-tool turns had none.
 *
 *  The prompt-caching guide's multi-turn pattern: put the breakpoint on the LAST content block of
 *  the most recently appended turn. Each request then reads the entire prior conversation from the
 *  previous turn's write and writes only what this turn appended. The marker MOVES: every earlier
 *  block is stripped (max 4 breakpoints per request; a marker is not part of the cached bytes, so
 *  moving it invalidates nothing). Only the two loop callers use this; single-turn calls keep their
 *  system-only breakpoint.
 *
 *  ACCURACY-NEUTRAL BY CONSTRUCTION: this changes nothing but cache_control fields. Turn 1's user
 *  message stays a plain string (there is no prior turn to reuse, and turn 2's marker covers it), so
 *  the request body differs from the unmarked one ONLY in cache_control (costLeaks.test pins that). */
export function placeHistoryCacheBreakpoint<M extends { role: string; content: unknown }>(messages: M[]): M[] {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (block && typeof block === "object" && "cache_control" in block) delete block.cache_control;
    }
  }
  const last = messages[messages.length - 1];
  if (last && Array.isArray(last.content) && last.content.length) {
    const block = last.content[last.content.length - 1] as Record<string, unknown>;
    if (block && typeof block === "object") block.cache_control = { type: "ephemeral" };
  }
  return messages;
}

const LLM_CALL_LOG_MAX = 400;
const llmCallLog: LlmCallRecord[] = [];

// Exported for backend/test/modelCallAccounting.test.ts ONLY: the replay benchmark's
// zero-model criterion is computed from exactly this record→query pair, so its test has
// to drive the real surface — a mock log would prove the mock. Production writes still
// arrive solely via instrument().
export function recordLlmCall(rec: LlmCallRecord): void {
  const withModel: LlmCallRecord = { ...rec, model: rec.model || fallbackRecordModel() };
  llmCallLog.push(withModel);
  if (llmCallLog.length > LLM_CALL_LOG_MAX) llmCallLog.splice(0, llmCallLog.length - LLM_CALL_LOG_MAX);
  // LLM-6: the ring buffer dies with the process; the ledger does not. Best-effort and
  // never throws (llmAccounting.persistLlmCall), attributed to whatever project/job context
  // the caller runs under (runWithLlmContext).
  persistLlmCall({ ...withModel, model: withModel.model as string });
}

/** Calls made at or after `sinceEpochMs`, oldest first. */
export function getRecentLlmCalls(sinceEpochMs: number): LlmCallRecord[] {
  return llmCallLog.filter((c) => c.at >= sinceEpochMs);
}

// ---------------------------------------------------------------------------
// Stub (no API key configured)
// ---------------------------------------------------------------------------

export class StubLLMProvider implements LLMProvider {
  async extractFields(): Promise<Record<string, unknown>> {
    return { provider: "stub", confidence: 0, notes: "No ANTHROPIC_API_KEY configured. Human review required." };
  }

  async extractProjectFields(): Promise<ParserLlmExtraction> {
    return {
      provider: "stub",
      fields: {},
      lowConfidenceFields: [],
      notes: "No ANTHROPIC_API_KEY configured — LLM-assisted parsing is off. Set ANTHROPIC_API_KEY to enable. Regex/OCR results are used as-is.",
    };
  }

  async extractProjectFieldsFromImages(): Promise<ParserLlmExtraction> {
    return {
      provider: "stub",
      fields: {},
      lowConfidenceFields: [],
      notes: "No ANTHROPIC_API_KEY configured — vision extraction is off.",
    };
  }

  async classifyCorrection(): Promise<{ bucket: CorrectionBucket; confidence: number; notes: string }> {
    return { bucket: "C_reviewer_clarification", confidence: 0, notes: "Stub: human review required." };
  }

  async draftResponse(): Promise<{ draft: string; confidence: number }> {
    return { draft: "", confidence: 0 };
  }

  async visionExtract(): Promise<Record<string, unknown>> {
    return { provider: "stub", confidence: 0, notes: "No ANTHROPIC_API_KEY configured." };
  }

  async researchDesignCriteria(): Promise<DesignCriteriaResearchResult> {
    return { provider: "stub", values: [], webGrounded: false, notes: "No ANTHROPIC_API_KEY configured — no design-criteria lookup." };
  }

  async webLookup(): Promise<WebLookupResult> {
    return { text: "", groundedSearches: 0, stopReason: null, resultUrls: [], pagesRead: 0, error: "No ANTHROPIC_API_KEY configured — no lookup." };
  }

  async researchJurisdictionCodes(input: JurisdictionCodeResearchInput): Promise<JurisdictionCodeResearchResult> {
    return {
      provider: "stub",
      profile: {
        key: "", state: input.state, ahj: input.ahj, confidence: "seeded",
        adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {},
        fireSetbacks: [], citations: [], updatedAt: "",
      },
      webGrounded: false,
      needsHumanVerification: true,
      notes: "No ANTHROPIC_API_KEY configured — enter the jurisdiction's adopted codes manually and verify against official sources.",
    };
  }

  async reviewPlanSetGeneral(): Promise<AiPlanReviewResult> {
    // Honest degradation: without an API key there is no AI review — the report
    // shows a single advisory saying so instead of silently omitting the pass.
    return {
      provider: "stub",
      findings: [],
      summary: "",
      confidence: "low",
      notes: "AI plan review unavailable — no ANTHROPIC_API_KEY configured. Deterministic checks (if any apply to this work type) still ran.",
    };
  }

  async synthesizeKnowledge(): Promise<{ requiredDocuments: string[]; commonRejectionReasons: string[]; tips: string[]; confidence: "low" | "medium" | "high" }> {
    return { requiredDocuments: [], commonRejectionReasons: [], tips: [], confidence: "low" };
  }

  async researchAhjRequirements(): Promise<AhjResearchResult> {
    return {
      provider: "stub",
      portalName: "",
      portalPlatform: "",
      portalUrl: "",
      submissionMethod: "",
      requiredDocuments: [],
      commonCorrections: [],
      tips: [],
      submissionSteps: [],
      confidence: "low",
      needsHumanVerification: true,
      notes: "No ANTHROPIC_API_KEY configured — AHJ research is off.",
    };
  }

  async researchUtilityRequirements(): Promise<UtilityResearchResult> {
    return {
      provider: "stub",
      portalName: "",
      portalPlatform: "",
      portalUrl: "",
      submissionMethod: "",
      requiredDocuments: [],
      smartInverterSettings: "",
      meterAggregation: "",
      acDisconnectRule: "",
      exportLimitNote: "",
      commonCorrections: [],
      tips: [],
      submissionSteps: [],
      confidence: "low",
      needsHumanVerification: true,
      notes: "No ANTHROPIC_API_KEY configured — utility research is off.",
    };
  }

  async suggestRecipeFieldBindings(): Promise<Array<{ index: number; field: string | null }>> {
    return [];
  }

  async planPortalFields(input: PortalFieldPlanInput): Promise<PortalFieldPlan> {
    // Deterministic heuristic fallback — label-matches the most common fields so the
    // learner still makes progress without an API key (low confidence, human verifies).
    return heuristicPortalPlan(input);
  }

  async verifyPortalFill(input: PortalFillVerifyInput): Promise<PortalFillVerification> {
    // Deterministic comparison — no LLM. Flags mismatches; never auto-trusts (accurate
    // stays false on any miss) so an unverified recipe can't be promoted in stub mode.
    return heuristicVerifyFill(input);
  }

  async verifyPortalFillVision(input: PortalFillVisionVerifyInput): Promise<PortalFillVerification> {
    // No vision capability in stub mode — fall back to heuristic using the DOM fields.
    return heuristicVerifyFill({ reviewFields: input.reviewFields, projectFields: input.projectFields, bodyText: input.bodyText });
  }

  async lookupInverterSpec(input: { inverterModel: string; inverterQty?: number; acNameplateKw?: number; serviceVoltageV?: number }): Promise<InverterSpecLookup> {
    // Even without an API key, resolve from the built-in equipment table or by deriving
    // from the AC nameplate, so the human-review "inverter output" box can still be filled.
    const offline = resolveInverterOffline(input);
    if (offline) return offline;
    return {
      provider: "stub",
      inverterModel: input.inverterModel,
      inverterQty: input.inverterQty && input.inverterQty > 0 ? input.inverterQty : 1,
      outputCurrentA: null,
      outputVa: null,
      totalContinuousCurrentA: null,
      derivedPvBreakerA: null,
      confidence: "low",
      source: "",
      notes: "No ANTHROPIC_API_KEY configured and the model isn't in the built-in table — enter the rated output from the inverter datasheet/SLD manually.",
      needsHumanVerification: true,
    };
  }

  async findAhjFormUrl(input: { ahj: string; state: string; formType?: string }): Promise<AhjFormUrlResult> {
    return {
      provider: "stub",
      formName: "",
      candidateUrls: [],
      formType: input.formType || "permit_application",
      confidence: "low",
      notes: "No ANTHROPIC_API_KEY configured — AHJ form lookup is off.",
    };
  }

  async mapAcroFormFields(): Promise<AhjFieldMapResult> {
    return { provider: "stub", textFields: {}, checkboxes: {}, notes: "No ANTHROPIC_API_KEY configured — field mapping is off." };
  }

  async mapFlatFormOverlay(): Promise<AhjOverlayMapResult> {
    return { provider: "stub", fields: [], signatures: [], notes: "No ANTHROPIC_API_KEY configured — flat-form vision mapping is off." };
  }

  async runToolAgent(): Promise<AgentRunResult> {
    // No key → no agent. Callers fall back to their deterministic path (e.g. the
    // regex correction classifier) and never auto-act on a stub result.
    return { provider: "stub", finalText: "", iterations: 0, hitIterationCap: false, stopReason: null };
  }
}

// Standard inverse-time breaker / OCPD sizes (amps), per NEC 240.6(A).
const STANDARD_BREAKER_SIZES = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225, 250, 300, 350, 400];
function nextStandardBreaker(amps: number): number | null {
  if (!Number.isFinite(amps) || amps <= 0) return null;
  return STANDARD_BREAKER_SIZES.find((s) => s >= amps) ?? STANDARD_BREAKER_SIZES[STANDARD_BREAKER_SIZES.length - 1];
}

// ---------------------------------------------------------------------------
// Built-in inverter/microinverter rating table — per-unit rated CONTINUOUS AC
// output current (A) at the unit's nominal voltage. Matched on normalized model or
// manufacturer PART NUMBER so common units (and manufacturers that publish part
// numbers rather than friendly model names, like Tesla) resolve instantly without a
// web round-trip. `matches` are normalized substrings (lowercased, alnum-only).
// ---------------------------------------------------------------------------
interface KnownInverter { label: string; matches: string[]; outputCurrentA: number; outputVa: number; note?: string }
const KNOWN_INVERTERS: KnownInverter[] = [
  // Tesla — published by part number; "1538000" is the Tesla 7.6 kW string inverter.
  { label: "Tesla Inverter 7.6 kW", matches: ["1538000", "tesla76", "teslainverter76", "teslainverter1538000"], outputCurrentA: 31.7, outputVa: 7600, note: "Tesla Inverter 7.6 kW @ 240 V single-phase." },
  { label: "Tesla Inverter 3.8 kW", matches: ["1707000", "1530000", "tesla38", "teslainverter38"], outputCurrentA: 15.8, outputVa: 3800, note: "Tesla Inverter 3.8 kW @ 240 V single-phase." },
  // Tesla Powerwall 3 — integrated PV+battery inverter, 11.5 kVA continuous on-grid.
  { label: "Tesla Powerwall 3", matches: ["powerwall3", "pw3", "1850000", "1707000ess"], outputCurrentA: 48, outputVa: 11500, note: "Powerwall 3 integrated inverter, 11.5 kVA / 48 A continuous @ 240 V. Verify the backfed PV portion against the SLD." },
  // Enphase microinverters (per-unit).
  { label: "Enphase IQ8+", matches: ["iq8plus", "iq8", "iq8a", "iq8h", "iq8m", "iq8mc", "iq8x"], outputCurrentA: 1.0, outputVa: 240, note: "Enphase IQ8-series microinverter (per unit ~ 240 VA / 1.0 A; multiply by qty)." },
  { label: "Enphase IQ7", matches: ["iq7plus", "iq7", "iq7a", "iq7x", "iq7pd"], outputCurrentA: 0.96, outputVa: 230, note: "Enphase IQ7-series microinverter (per unit; multiply by qty)." },
  // SolarEdge HD-Wave string inverters (240 V).
  { label: "SolarEdge SE7600H", matches: ["se7600h", "se7600"], outputCurrentA: 32, outputVa: 7600 },
  { label: "SolarEdge SE7600H", matches: ["se10000h", "se10000"], outputCurrentA: 41.7, outputVa: 10000 },
  { label: "SolarEdge SE11400H", matches: ["se11400h", "se11400"], outputCurrentA: 47.5, outputVa: 11400 },
  { label: "SolarEdge SE3800H", matches: ["se3800h", "se3800"], outputCurrentA: 16, outputVa: 3800 },
  // Generac/SMA/Fronius common units.
  { label: "SMA Sunny Boy 7.7", matches: ["sb77", "sunnyboy77", "sb7-7"], outputCurrentA: 32, outputVa: 7700 },
];

function normModel(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Autonomous portal-learning helpers (heuristic fallbacks + safety filter).
// ---------------------------------------------------------------------------

// Pay/fee/submit button labels the learner must NEVER click or treat as "advance".
const PORTAL_PAY_RE = /\b(pay|payment|checkout|invoice|fee|charge|credit card)\b/i;
const PORTAL_SUBMIT_RE = /\b(submit|file application|finalize|finish|confirm submission|place order|complete submission)\b/i;
const PORTAL_ADVANCE_RE = /\b(next|continue|proceed|save and continue|add|step \d)\b/i;
// Dashboard "start a new application" link/button labels — used by the offline planner to
// navigate from a portal home page INTO the application form. Matches PowerClerk's "New
// Pacific Power Customer Generation Application", Accela's "Create an Application", etc.
const PORTAL_NEW_APP_RE = /\b(new|start|begin|create|apply|file|add)\b[^.]{0,40}\b(application|interconnection|generation|project|request|permit|submittal|submission|service)\b|\b(apply now|get started|start now)\b/i;

// Field-label → project-field key heuristics, used by the offline planner.
const PORTAL_FIELD_HINTS: Array<{ re: RegExp; field: string }> = [
  { re: /owner.*name|applicant name|property owner|customer name|homeowner/i, field: "homeownerName" },
  { re: /(site|project|installation|service|property).*address|street/i, field: "projectAddress" },
  { re: /\bcity\b/i, field: "city" },
  { re: /\bstate\b/i, field: "state" },
  { re: /\bzip|postal/i, field: "zip" },
  { re: /county|jurisdiction|ahj/i, field: "ahj" },
  { re: /utility|electric company/i, field: "utility" },
  { re: /account (number|no|#)/i, field: "accountNumber" },
  { re: /meter (number|no|#)/i, field: "meterNumber" },
  { re: /system size.*dc|dc.*kw|dc size/i, field: "systemSizeDcKw" },
  { re: /system size.*ac|ac.*kw|ac size|inverter.*kw/i, field: "systemSizeAcKw" },
  { re: /export|generation capacity/i, field: "totalExportKw" },
  { re: /interconnection|net.?meter/i, field: "interconnectionMethod" },
  { re: /business name|company name|contractor name|installer/i, field: "installerCompanyName" },
  { re: /ccb|contractor.*licens/i, field: "ccbLicenseNumber" },
  { re: /electrical licens/i, field: "electricalLicenseNumber" },
  { re: /installer.*email|contractor.*email|business email/i, field: "installerEmail" },
  { re: /installer.*phone|contractor.*phone|business phone/i, field: "installerPhone" },
  // A box that says CONTRACT keeps the contract price; every other Job Value / Valuation /
  // Estimated Cost box takes the declared valuation (valuation.ts — the one label predicate the
  // learn-time correction and the replay rebind ask too). Order matters: contract first.
  { re: CONTRACT_PRICE_LABEL, field: "jobValue" },
  { re: VALUATION_BOX_LABEL, field: "declaredValuation" },
];

function isSensitivePortalLabel(label: string): boolean {
  return /password|account (number|no|#)|meter (number|no|#)|ssn|social security|mfa|verification code|card number/i.test(label);
}

// A read-only review page has no fillable inputs (only buttons + a summary). On such a
// page a "Continue Application"/"Continue"/"Submit" button SUBMITS — it must be recorded
// as the final submit, never treated as an advance. (Accela "Continue Application" trap.)
const PORTAL_REVIEW_MARKERS = /\bstep\s*\d+\s*:?\s*review\b|review all information|continue application button below|please review (all )?information|\(read-only\)/i;

function heuristicPortalPlan(input: PortalFieldPlanInput): PortalFieldPlan {
  // DASHBOARD / HOME PAGE (no fillable inputs, only navigation links). Find the link that
  // starts a new application and return it as navigateIndex so the learner can reach the
  // actual form. Without this, the offline (no-API-key) planner can't get past the portal
  // home screen — it would mistake the dashboard for a review page and stop.
  if (input.isDashboard) {
    const navField = input.fields.find(
      (f) => f.fieldType === "button" && PORTAL_NEW_APP_RE.test(f.label || "") && !PORTAL_PAY_RE.test(f.label || ""),
    );
    if (navField) {
      return {
        fills: [],
        navigateIndex: navField.index,
        atReview: false,
        confidence: "low",
        notes: `Heuristic dashboard navigation (no LLM): clicking "${navField.label}" to start a new application. Human verification required.`,
      };
    }
    // No recognizable "new application" link — don't guess at a random nav link; stop cleanly.
    return {
      fills: [],
      atReview: false,
      confidence: "low",
      notes: "Heuristic fallback: a page with no fillable inputs and no recognizable 'new application' link. A human must navigate to the application form (or set ANTHROPIC_API_KEY so the LLM planner can find it).",
    };
  }

  const fills: PortalFieldPlan["fills"] = [];
  let advanceIndex: number | undefined;
  let finalSubmitIndex: number | undefined;
  const hasFillable = input.fields.some((f) => f.fieldType !== "button");
  const reviewPage = !hasFillable || PORTAL_REVIEW_MARKERS.test(input.bodyText);

  for (const f of input.fields) {
    const label = f.label || "";
    if (f.fieldType === "button") {
      if (PORTAL_PAY_RE.test(label)) continue; // never advance/submit on a pay/fee button.
      // On a review page, ANY submit/continue button is the FINAL SUBMIT (never advance).
      if (reviewPage && (PORTAL_SUBMIT_RE.test(label) || PORTAL_ADVANCE_RE.test(label))) {
        if (finalSubmitIndex == null) finalSubmitIndex = f.index;
        continue;
      }
      if (PORTAL_SUBMIT_RE.test(label)) { if (finalSubmitIndex == null) finalSubmitIndex = f.index; continue; }
      if (PORTAL_ADVANCE_RE.test(label) && advanceIndex == null) advanceIndex = f.index;
      continue;
    }
    const hint = PORTAL_FIELD_HINTS.find((h) => h.re.test(label));
    if (hint && input.projectFields[hint.field]) {
      fills.push({ index: f.index, value: input.projectFields[hint.field], field: hint.field });
    }
  }
  // "At review" on a read-only page, or when there's a submit button and nothing to advance.
  const atReview = reviewPage || (finalSubmitIndex != null && advanceIndex == null);
  return {
    fills,
    advanceIndex: atReview ? undefined : advanceIndex,
    finalSubmitIndex,
    atReview,
    confidence: "low",
    notes: "Heuristic label-matching fallback (no LLM). Human verification required before trusting.",
  };
}

function heuristicVerifyFill(input: PortalFillVerifyInput): PortalFillVerification {
  const norm = (v: string) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const projVals = Object.values(input.projectFields).map(norm).filter((v) => v.length >= 3);
  const matches = input.reviewFields.map((rf) => {
    const fv = norm(rf.value);
    // A review value is "ok" if it matches some project value (or is a non-data literal).
    const ok = fv.length < 3 || projVals.some((pv) => pv === fv || pv.includes(fv) || fv.includes(pv));
    return { label: rf.label, expected: "(project data)", found: rf.value, ok };
  });
  const misses = matches.filter((m) => !m.ok);
  return {
    matches,
    overallConfidence: "low",
    // Stub never auto-trusts — a human must confirm in stub mode.
    accurate: false,
    issues: misses.map((m) => `Unverified value on "${m.label}": ${m.found}`),
    notes: "Heuristic comparison (no LLM). Confirm each field on the review screen before trusting the recipe.",
  };
}

function lookupKnownInverter(model: string): KnownInverter | null {
  const n = normModel(model);
  if (!n) return null;
  for (const k of KNOWN_INVERTERS) {
    if (k.matches.some((m) => n.includes(m) || m.includes(n))) return k;
  }
  return null;
}

// Build the final lookup result from a per-unit current, with PV breaker derivation.
function buildInverterResult(opts: {
  model: string; qty: number; perUnitA: number; perUnitVa: number | null;
  confidence: "low" | "medium" | "high"; source: string; notes: string;
}): InverterSpecLookup {
  const totalA = opts.perUnitA * opts.qty;
  return {
    provider: "claude",
    inverterModel: opts.model,
    inverterQty: opts.qty,
    outputCurrentA: Math.round(opts.perUnitA * 100) / 100,
    outputVa: opts.perUnitVa,
    totalContinuousCurrentA: Math.round(totalA * 100) / 100,
    derivedPvBreakerA: nextStandardBreaker(totalA * 1.25),
    confidence: opts.confidence,
    source: opts.source,
    notes: `${opts.notes} Derived PV breaker = next standard size ≥ 1.25 × ${Math.round(totalA * 100) / 100} A total (verify against the SLD, especially multi-branch microinverter layouts).`.trim(),
    needsHumanVerification: true,
  };
}

// Resolve an inverter rating WITHOUT the network: first the built-in table, then by
// deriving the continuous output current from the AC nameplate (VA / voltage). The
// nameplate derivation is the most reliable fallback because the AC nameplate IS the
// inverter's continuous output — it always works when the AC size is known.
function resolveInverterOffline(input: { inverterModel: string; inverterQty?: number; acNameplateKw?: number; serviceVoltageV?: number }): InverterSpecLookup | null {
  const model = String(input.inverterModel || "").trim();
  const qty = input.inverterQty && input.inverterQty > 0 ? Math.round(input.inverterQty) : 1;

  const known = model ? lookupKnownInverter(model) : null;
  if (known) {
    return buildInverterResult({
      model, qty, perUnitA: known.outputCurrentA, perUnitVa: known.outputVa,
      confidence: "high", source: "built-in equipment table",
      notes: `${known.label}. ${known.note || ""}`.trim(),
    });
  }

  // CEC solar equipment list (weekly-synced cec_equipment table, primed cache):
  // certified output specs for the long tail the curated table doesn't cover.
  // Medium confidence — CEC data is authoritative but model matching is fuzzy,
  // and buildInverterResult keeps needsHumanVerification on regardless.
  const cec = model ? lookupCecInverter(model) : null;
  if (cec && (cec.outputCurrentA || cec.powerW)) {
    const voltage = Number(input.serviceVoltageV) > 0 ? Number(input.serviceVoltageV) : 240;
    const perUnitA = cec.outputCurrentA ?? (cec.powerW ? Math.round(((cec.powerW / voltage) + Number.EPSILON) * 100) / 100 : null);
    if (perUnitA) {
      return buildInverterResult({
        model, qty, perUnitA, perUnitVa: cec.powerW ?? null,
        confidence: "medium", source: "CEC solar equipment list",
        notes: `CEC listing: ${cec.manufacturer} ${cec.model}.`,
      });
    }
  }

  // Nameplate derivation — total system continuous current from AC kW. This is a SYSTEM
  // total (not per-unit), so don't multiply by qty again.
  const acKw = Number(input.acNameplateKw);
  if (Number.isFinite(acKw) && acKw > 0) {
    const voltage = Number(input.serviceVoltageV) > 0 ? Number(input.serviceVoltageV) : 240;
    const totalA = (acKw * 1000) / voltage;
    return {
      provider: "claude",
      inverterModel: model || "(derived from AC nameplate)",
      inverterQty: qty,
      outputCurrentA: Math.round((totalA / Math.max(qty, 1)) * 100) / 100,
      outputVa: Math.round(acKw * 1000),
      totalContinuousCurrentA: Math.round(totalA * 100) / 100,
      derivedPvBreakerA: nextStandardBreaker(totalA * 1.25),
      confidence: "medium",
      source: "derived from AC nameplate",
      notes: `Derived from the ${acKw} kW AC nameplate at ${voltage} V → ${Math.round(totalA * 100) / 100} A continuous (system total). Derived PV breaker = next standard size ≥ 1.25 × that. Confirm against the inverter datasheet/SLD.`,
      needsHumanVerification: true,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claude provider
// ---------------------------------------------------------------------------

/**
 * Backoff schedule for a transient upstream failure. Four attempts in total, spread over
 * roughly twenty seconds — long enough to ride out an overload burst, short enough that a
 * portal budget is not spent waiting.
 */
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 4_000, 15_000];

/**
 * Is this a failure a retry can fix? Deliberately conservative: a malformed request or a bad
 * key fails the same way every time, and retrying it burns a portal's budget to arrive at
 * the same answer three times more slowly.
 */
export function isTransientLlmError(err: unknown): boolean {
  const status = Number((err as { status?: unknown })?.status ?? 0);
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true;
  const m = String((err as Error)?.message || err || "");
  // Checked FIRST and deliberately: a request that is wrong is wrong however long you wait,
  // and its message often carries a number that would otherwise read as a server error
  // ("max_tokens 500000 exceeds the limit").
  if (/\bapi_?key\b|unauthorized|authentication|invalid_request|permission|not_found/i.test(m)) return false;
  return /overloaded|rate.?limit|\b429\b|\b5\d\d\b|timeout|timed out|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|network|fetch failed|stream (error|ended)/i.test(m);
}

/** Should instrument()'s OWN retry loop re-send this call?
 *
 *  Not a client TIMEOUT. The SDK arms its timeout around the fetch until response headers and then
 *  retries a timed-out request itself (maxRetries 5, read in node_modules/@anthropic-ai/sdk client.js).
 *  So by the time an APIConnectionTimeoutError reaches us it has already been sent six times, and on a
 *  non-streaming call each of those may have been generated — and billed — server-side before the
 *  headers arrived. Retrying it three more times here multiplied a stalled call to 24 attempts.
 *  Everything else isTransientLlmError accepts is still retried: an in-stream overload (Gilbert, no
 *  status, never seen by the SDK's retry) and 429/5xx (not billed). */
export function shouldWrapperRetry(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionTimeoutError || (err as { name?: string })?.name === "APIConnectionTimeoutError") return false;
  return isTransientLlmError(err);
}

// ---------------------------------------------------------------------------
// Web-grounded research: one budget, one "no web" prompt, one URL scrub.
// ---------------------------------------------------------------------------

/** findAhjFormUrl reads every result its searches return, discards a same-named place in another
 *  state (formSearchScope, issue #162), and keeps the first KEPT of the rest — askWithWebSearch's own
 *  default cap, applied after the filter instead of before it. */
const FORM_SEARCH_RESULTS_SEEN = 400;
const FORM_SEARCH_RESULTS_KEPT = 20;

/** A GROUNDED SEARCH NEEDS A GROUNDED BUDGET — for every research call, not just the one that
 *  was caught. researchAhjRequirements / researchUtilityRequirements / researchJurisdictionCodes
 *  ran on askWithWebSearch's 45s default with 5-6 searches each, timed out, and quietly fell
 *  back to model memory, which then landed as ordinary shared 'seeded' knowledge. Same budget
 *  and env override findAhjFormUrl already used (AHJ_FORM_LOOKUP_TIMEOUT_MS, kept for
 *  compatibility); WEB_RESEARCH_TIMEOUT_MS is the name that says what it covers. */
export function webResearchBudgetMs(): number {
  // 240 s: the fee researcher's budget for the same kind of call (feeSchedules.FEE_RESEARCH_CLIENT_TIMEOUT_MS,
  // not imported — feeSchedules imports this module). findAhjFormUrl's comment claimed to match it at
  // 180 s and did not: on a never-seen AHJ (2026-09-28) its searches measured 59–176 s and the first
  // aborted at 180,012 ms, which threw away the search-result URLs already received and shortened the
  // AHJ's cooldown claim to an hour. Still env-overridable, never below the old 45 s floor.
  return Math.max(45000, Number(process.env.WEB_RESEARCH_TIMEOUT_MS) || Number(process.env.AHJ_FORM_LOOKUP_TIMEOUT_MS) || 240000);
}

/** A budget in the operator's words: "4 min" for 240,000 ms, "45 s" under a minute. */
export function formatBudget(ms: number): string {
  return ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`;
}

/** Output budget for the research siblings. Their outputs measured 4.7-5.8k tokens; at the old
 *  3000 a fixed timeout would only have turned into max_tokens truncation that parses to {} —
 *  the trap findAhjFormUrl hit (44c9ba5). */
export const WEB_RESEARCH_MAX_TOKENS = 6000;

/** Output ceiling for the flat-form vision pass (thinking included). 4096 truncated a two-page
 *  application (City of Waltham, 2026-09-28) before any JSON; a ceiling is not spend. */
export const FLAT_FORM_OVERLAY_MAX_TOKENS = 16000;

// DESIGN-CRITERIA LOOKUP (one AHJ: ground snow, ultimate wind speed, exposure). Measured on 10
// AHJs in 8 states (2026-09-24): it never returned a wrong value, but it returned ONE value in
// ten, because it accepted only a "building-department page". The values it missed were in
// the jurisdiction's own ADOPTED CODE as published on its municipal-code or code-publisher site
// (a city's "Residential Code 2021" Table R301.2), and in a STATE code that names the
// jurisdiction (the Florida code's High-Velocity Hurricane Zone speeds by county). It must
// still never take a neighbour's value, a county value that varies inside the city, a range, a
// site-specific map, a roof snow load as ground snow, or an ASD speed as Vult. A pg(asd) is
// returned under its OWN key (the 2024 IRC prints it) and stored apart from the strength Pg.
//
// OPERATOR DECISION (2026-09-24): this ONE call may READ pages, not only search: a search snippet
// rarely carries a Table R301.2 row, and the table is on the page the search found. The fetch tool
// only opens URLs already in the conversation (the search results), is capped per lookup
// (DESIGN_LOOKUP_MAX_FETCHES) and per page (DESIGN_LOOKUP_MAX_PAGE_TOKENS), and its tokens are
// recorded in llm_calls like every call (instrument()). What it stores is unchanged: seeded,
// blank-fill only, each value with its page and quote (codeProfiles.mergeResearchedDesignCriteria).
export const DESIGN_CRITERIA_LOOKUP_SYSTEM = `You look up ONE building jurisdiction's structural design criteria for residential roofs: ground snow load, ultimate design wind speed (Vult), wind exposure category, seismic design category (SDC), frost line depth, risk category. Answer EVERY one: a value you found, or omit it and say in notes that you looked and did not find it.

WHERE A VALUE MAY COME FROM (a page you actually found):
1. The jurisdiction's building-department pages and PDFs (design criteria, "currently adopted codes").
2. The jurisdiction's OWN ADOPTED CODE text wherever it is published — its municipal code, or a code publisher's copy of THAT jurisdiction's code (a page titled with the jurisdiction's name, e.g. "<City> Residential Code … Table R301.2"). A generic IRC/state page with the table left for "the jurisdiction to fill in" is NOT a value.
3. A STATE code or state agency table that NAMES this jurisdiction (or its county, when the value applies to the whole county with no sub-region) and gives ONE value for it.
Search for "<jurisdiction> Table R301.2 ground snow load wind speed" and "<jurisdiction> design criteria" first.

A JURISDICTION-WIDE DESIGN VALUE comes from a design-criteria / climatic and geographic design criteria table, the code adoption ordinance or amendments, or a building-safety policy that states it for all construction. A PROJECT-TYPE HANDOUT (a storage building / shed, deck, fence, patio cover, carport, pool or garage handout) is NOT one: keep looking for the table; if a handout is all you find, give the value with "sourceKind": "project_handout".
You may OPEN (web_fetch) a result page to read its table — only official city, county or state government pages and code-publisher copies of this jurisdiction's adopted code (up.codes, codes.iccsafe.org, municode, ecode360, codepublishing, American Legal). Open at most a few pages; never open a blog, vendor, forum or map-tool page.

WHEN TO OMIT (and say why in notes):
- The source gives several values or a range for the jurisdiction ("115/125/140", "20-25 psf", "Exposure B or C", special wind region inside it), or says criteria are site-specific or vary by elevation (an elevation-banded table, an address lookup tool / hazard map) — omit the value, and report it under "siteSpecific" with that table's or tool's official URL.
- The value belongs to a neighbouring or different jurisdiction — omit.
- A ROOF snow load (flat/sloped/minimum roof snow, Pf, Pm) is never a ground snow load.
- windSpeedMph must be the ULTIMATE (strength) speed Vult; omit a speed labelled ASD, nominal, Vasd, or a legacy "basic wind speed" from a pre-2012 map.
- groundSnowLoadPsf is the strength-level ground snow load Pg. A value labelled allowable-stress pg(asd) (2024-edition Table R301.2 prints pg(asd)) goes under groundSnowLoadAsdPsf instead — never under groundSnowLoadPsf.
- Use the CURRENT edition: a table from a superseded code cycle, or a staging/preview copy of a page, is not the value.
- The quote must put the number right next to its own label (e.g. "Vult = 120 mph", "Ground snow load pg = 25 psf", "Seismic Design Category: B", "Frost line depth 18 inches", "Risk Category II").

Return ONLY JSON:
{"groundSnowLoadPsf": {"value": <number>, "sourceUrl": "<page>", "quote": "<the exact words stating it, with the number>"} or omit,
 "groundSnowLoadAsdPsf": {"value": <number>, "sourceUrl": "<page>", "quote": "<exact words, with pg(asd) and the number>"} or omit,
 "windSpeedMph": {"value": <Vult number>, "sourceUrl": "<page>", "quote": "<exact words, with the number>"} or omit,
 "windExposure": {"value": "<B|C|D>", "sourceUrl": "<page>", "quote": "<exact words naming the exposure category>"} or omit,
 "seismicDesignCategory": {"value": "<A|B|C|D0|D1|D2|E>", "sourceUrl": "<page>", "quote": "<exact words naming the seismic design category>"} or omit,
 "frostDepthIn": {"value": <inches>, "sourceUrl": "<page>", "quote": "<exact words, with frost and the number>"} or omit,
 "riskCategory": {"value": "<I|II|III|IV>", "sourceUrl": "<page>", "quote": "<exact words naming the risk category the jurisdiction requires for dwellings>"} or omit,
 "siteSpecific": [{"criterion": "groundSnowLoadPsf|windSpeedMph|windExposure|seismicDesignCategory|frostDepthIn", "sourceUrl": "<the official table/tool page>", "note": "<≤20 words: how it varies, e.g. by elevation band>"}] or omit,
 "notes": "<what you could not confirm, and any site-specific tool>"}
Every value object may also carry "sourceKind": "design_criteria_table|adoption_ordinance|building_safety_policy|code_text|project_handout".
Never guess. Never use model memory.`;

/**
 * The design-criteria lookup's user message. A COUNTY in a statewide-minimum state usually has no
 * Table R301.2 page of its own (measured: a New Mexico county's lookup ran 196 s and found nothing):
 * its criteria live in the STATE's adopted residential code (its Table R301.2 amendments) and on the
 * county building page, and are often elevation-banded — so for "… County" the lookup is told to
 * search those too, and to report a banded table as site-specific rather than as nothing. Pure.
 */
export function designCriteriaLookupUserMessage(input: { ahj: string; state: string }): string {
  const base = `Jurisdiction: ${input.ahj}\nState: ${input.state}`;
  if (!/\bcounty\b|\bparish\b/i.test(String(input.ahj || ""))) return base;
  return `${base}
This is a COUNTY. Besides its own pages, also search:
- the state's adopted residential code and its amendments to Table R301.2 (climatic and geographic design criteria) — "${input.state} residential code Table R301.2 amendments ${input.ahj}";
- the county's building / planning department page for design criteria ("${input.ahj} building department design criteria snow load wind").
If the values vary by elevation or location inside the county (an elevation-banded table, an address lookup), report them under "siteSpecific" with that page's URL, not as one value.`;
}

/** Page-fetch caps for the design-criteria lookup ONLY (the other web-research calls do not fetch). */
export const DESIGN_LOOKUP_MAX_FETCHES = 3;
export const DESIGN_LOOKUP_MAX_PAGE_TOKENS = 12000;

/** The server-side fetch tool the design-criteria lookup adds beside web_search. It can only open a
 *  URL already in the conversation (a search result); hosts are not listable here (no TLD wildcards),
 *  so which pages count is decided on the parse side (the source URL must be a page it found). */
export function designLookupFetchTool(): Record<string, unknown> {
  return { type: "web_fetch_20260209", name: "web_fetch", max_uses: DESIGN_LOOKUP_MAX_FETCHES, max_content_tokens: DESIGN_LOOKUP_MAX_PAGE_TOKENS };
}

/** The URLs of the pages the fetch tool actually returned (a web_fetch_result, not an error): a
 *  lookup that reads pages may cite a page it OPENED, which is not always a search result. */
export function webFetchResultUrls(msg: { content?: unknown }): string[] {
  const blocks = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown> | null>) : [];
  const urls: string[] = [];
  for (const b of blocks) {
    const c = b?.type === "web_fetch_tool_result" ? (b.content as { type?: string; url?: unknown } | null) : null;
    const u = c?.type === "web_fetch_result" && typeof c.url === "string" ? c.url.trim() : "";
    if (/^https?:\/\//i.test(u) && !urls.includes(u)) urls.push(u.slice(0, 300));
  }
  return urls;
}

/** Pages the fetch tool actually returned (a web_fetch_tool_result whose content is a result, not an
 *  error object). For the log line and the lookup's notes — grounding is still decided by search. */
export function countWebFetches(msg: { content?: unknown }): number {
  const blocks = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown> | null>) : [];
  return blocks.filter((b) => b?.type === "web_fetch_tool_result" && (b.content as { type?: string } | null)?.type === "web_fetch_result").length;
}

type LookupValue = DesignCriteriaResearchResult["values"][number];

/** Every standalone number in a quote, with where it sits. */
function numbersIn(quote: string): Array<{ n: number; at: number; end: number }> {
  const out: Array<{ n: number; at: number; end: number }> = [];
  const re = /(?<![\d.])\d+(?:\.\d+)?(?![\d.]*\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(quote))) out.push({ n: Number(m[0]), at: m.index, end: m.index + m[0].length });
  return out;
}

/** The number sits in a range or a list ("20-25 psf", "115/125/140", "25 or 30 psf"): not ONE value. */
function inRangeOrList(quote: string, at: number, end: number): boolean {
  const before = quote.slice(Math.max(0, at - 8), at);
  const after = quote.slice(end, end + 14);
  return /\d\s*(?:-|–|—|\/|,|\bto\b|\bor\b|\band\b|\bthrough\b)\s*$/i.test(before)
    || /^\s*(?:psf|mph|lbs?)?\s*(?:-|–|—|\/|,|\bto\b|\bor\b|\band\b|\bthrough\b)\s*\d/i.test(after);
}

/** Publishers of adopted code text (a jurisdiction's own code, as that jurisdiction adopted it). */
const CODE_PUBLISHER_HOSTS = ["up.codes", "iccsafe.org", "municode.com", "ecode360.com", "codepublishing.com", "amlegal.com", "generalcode.com", "sterlingcodifiers.com", "qcode.us", "codelibrary.amlegal.com", "municipal.codes", "floridabuilding.org"];
/** Known NON-official hosts, refused whatever their suffix or name: the address-based hazard lookup
 *  tools the lookup prompt already says to omit (ATC's hazards tool, ASCE's hazard tool, SEAO's
 *  Oregon snow-load lookup — site-specific by design), and encyclopedias. */
const NON_OFFICIAL_HOSTS = ["atcouncil.org", "ascehazardtool.org", "seao.org", "wikipedia.org", "wikimedia.org", "wikiwand.com"];
/** The words a jurisdiction's name carries that are not its name. */
const JURISDICTION_FILLER = /\b(?:city|town|township|village|borough|county|parish|municipality|of|the)\b/g;
/** Is the host this jurisdiction's own .org? The registrable label ("coosbay" in www.coosbay.org)
 *  must BE the jurisdiction's name — alone, or with the usual city/county/state affixes — not merely
 *  contain it ("salemhealth.org" is not Salem's). */
function orgHostNamesJurisdiction(host: string, jurisdiction: { ahj: string; state: string }): boolean {
  const label = host.split(".").slice(-2, -1)[0]?.replace(/[^a-z0-9]/g, "") ?? "";
  const full = jurisdiction.ahj.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const core = full.replace(JURISDICTION_FILLER, " ").replace(/\s+/g, "");
  if (!label || core.length < 3) return false;
  const st = jurisdiction.state.trim().toLowerCase().replace(/[^a-z]/g, "");
  const names = new Set([core, full.replace(/\s+/g, "")]);
  for (const n of [...names]) {
    for (const pre of ["", "cityof", "townof", "villageof", "countyof", "co", "ci"]) {
      for (const post of ["", "city", "county", "co", "town"]) {
        names.add(`${pre}${n}${post}`);
        if (st) names.add(`${pre}${n}${post}${st}`);
      }
    }
  }
  return names.has(label);
}
/**
 * THE PAGES A LOOKUP VALUE MAY COME FROM: a government host (.gov / .us / .mil), a publisher of
 * adopted code text, or a .org that is THIS jurisdiction's own site (the host names it — pass the
 * jurisdiction; without one no .org is accepted). Every other .org — a trade association's blog, an
 * encyclopedia, a hazard lookup tool — is not an official page: accepting the whole suffix let a
 * wikipedia / association / atcouncil.org value become a jurisdiction's seeded criterion.
 */
export function isOfficialCodeSource(url: string, jurisdiction: { ahj: string; state: string } | null = null): boolean {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (NON_OFFICIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  if (/\.(?:gov|us|mil)$/.test(host)) return true;
  if (CODE_PUBLISHER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return /\.org$/.test(host) && jurisdiction != null && orgHostNamesJurisdiction(host, jurisdiction);
}

/**
 * WHICH LABEL A NUMBER BELONGS TO. The text from the previous number (or ";") up to this one is its
 * label; a parenthetical right after it ("43 psf (pg(asd))", "175 mph (Vult)") qualifies it too.
 * "Vult = 175 mph, Vasd = 136 mph": 136's label is "Vasd". "Roof snow load 25 psf; ground snow load
 * 35 psf": 25's label is "Roof snow load".
 */
type NumberLabel = { before: string; after: string; nextNumberFollows: boolean };
function labelOf(quote: string, nums: Array<{ at: number; end: number }>, i: number): NumberLabel {
  const start = i > 0 ? nums[i - 1].end : 0;
  let before = quote.slice(start, nums[i].at);
  const cut = Math.max(before.lastIndexOf(";"), before.lastIndexOf("|"));
  if (cut >= 0) before = before.slice(cut + 1);
  const next = i + 1 < nums.length ? nums[i + 1].at : quote.length;
  const after = quote.slice(nums[i].end, Math.min(next, nums[i].end + 30));
  return { before, after, nextNumberFollows: i + 1 < nums.length && next <= nums[i].end + 30 };
}

/** A label right AFTER a number qualifies it ("175 mph (Vult)", "43 psf (pg(asd))") — unless it is
 *  the NEXT number's label: "175 mph (Vasd = 136 mph)" assigns Vasd to 136, not to 175. */
function trailingLabel(after: string, nextNumberFollows: boolean, re: RegExp): string | undefined {
  const m = after.match(re);
  if (!m) return undefined;
  const rest = m[2] ?? "";
  if (/^\s*\)?\s*[:=]/.test(rest) || (nextNumberFollows && /^[\s)]*$/.test(rest))) return undefined;
  return m[1].toLowerCase();
}

type WindClass = "ult" | "asd" | "none";
function windClass(label: NumberLabel): WindClass {
  const labels = [...label.before.matchAll(/\bv\s*_?\s*ult\b|\bvult\b|\bultimate\b|\bv\s*_?\s*asd\b|\bvasd\b|\basd\b|\bnominal\b|allowable\s+stress|\bwind\b/gi)].map((m) => m[0].toLowerCase());
  const tail = trailingLabel(label.after, label.nextNumberFollows, /^\s*(?:mph)?\s*\(?\s*(v\s*_?\s*ult|vult|ultimate|v\s*_?\s*asd|vasd|asd|nominal)\b([\s\S]*)$/i);
  const nearest = tail ?? labels[labels.length - 1];
  if (!nearest) return "none";
  if (/asd|nominal|allowable/.test(nearest)) return "asd";
  return "ult"; // vult / ultimate / an unqualified "wind" label next to the number
}

type SnowClass = "pg" | "pg_asd" | "roof" | "none";
function snowClass(label: NumberLabel): SnowClass {
  const b = label.before;
  const groundAt = Math.max(b.search(/ground\s+snow/i) >= 0 ? b.toLowerCase().lastIndexOf("ground") : -1, (() => { const m = [...b.matchAll(/\bp\s?g\b/gi)]; return m.length ? m[m.length - 1].index ?? -1 : -1; })());
  const roofAt = (() => { const m = [...b.matchAll(/\broof\b|\bflat\b|\bsloped\b|\bp[fsm]\b|uniform\s+snow/gi)]; return m.length ? m[m.length - 1].index ?? -1 : -1; })();
  const asd = /\basd\b|allowable\s+stress/i.test(groundAt >= 0 ? b.slice(Math.max(0, groundAt - 40)) : b)
    || Boolean(trailingLabel(label.after, label.nextNumberFollows, /^\s*(?:psf|lbs?\s*\/\s*(?:sq\.?\s*ft|ft2|ft²)|pounds\s+per\s+square\s+f(?:oo|ee)t)?\s*\(\s*(?:p\s?g\s*\(\s*)?(asd)\b([\s\S]*)$/i));
  if (roofAt > groundAt) return "roof";
  if (groundAt >= 0) return asd ? "pg_asd" : "pg";
  return asd ? "pg_asd" : "none";
}

/** A PROJECT-TYPE HANDOUT names the project it is for in its file name or path (measured: City of
 *  Albuquerque's ground snow load came back cited to ".../BuildingSafety/Storage Building.pdf"). */
const PROJECT_HANDOUT_PATH = /\b(?:storage[\s_-]*build(?:ing)?s?|sheds?|accessory[\s_-]*(?:build(?:ing)?s?|structures?|dwellings?)|fences?|decks?|patio(?:[\s_-]*covers?)?|carports?|pergolas?|gazebos?|(?:swimming[\s_-]*)?pools?|hot[\s_-]*tubs?|retaining[\s_-]*walls?|garages?|porch(?:es)?|handouts?|brochures?|(?:tip|fact|info(?:rmation)?)[\s_-]*sheets?)\b/i;

/**
 * IS THIS PAGE A JURISDICTION-WIDE DESIGN VALUE? A handout for one project type (a storage
 * building, a deck, a fence) may print a snow load, but it is not the jurisdiction's design-criteria
 * table, adoption ordinance or building-safety policy — the value is kept (seeded) and FLAGGED so a
 * person verifies it against the real table. Returns why it is weak, or "" for a design-value page.
 * The model's own "sourceKind" counts; so does the URL's path naming a project type.
 */
export function weakDesignSourceReason(sourceUrl: string, sourceKind?: unknown): string {
  if (String(sourceKind ?? "").trim().toLowerCase() === "project_handout") return "the lookup reported a project-type handout, not a design-criteria table";
  let pathName = "";
  try { pathName = decodeURIComponent(new URL(sourceUrl).pathname); } catch { pathName = String(sourceUrl || ""); }
  const m = pathName.replace(/[+_]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").match(PROJECT_HANDOUT_PATH);
  return m ? `project-type handout ("${m[0].trim()}"), not a jurisdiction-wide design-criteria page` : "";
}

/** The quote conditions the value on the site (elevation, a lookup tool): not the jurisdiction's one value. */
const SITE_CONDITIONAL = /\bsite[-\s]specific\b|\b(?:below|above|under|over)\s+\d[\d,]*\s*(?:ft|feet|')|\belevations?\b/i;

/**
 * Parse the lookup's JSON into values the profile may store. A value survives only when it is
 * web-grounded, has a source URL, and its QUOTE says it: the number appears in the quote as a
 * number of its own, BOUND TO ITS OWN LABEL (Vult / ground snow / pg) — never the other number of a
 * two-number quote ("Vult = 175 mph, Vasd = 136 mph" stores 175 only) — and not inside a range or a
 * list ("20-25 psf", "115/125/140", "Exposure B or C"). A ground snow load labelled pg(asd) is kept
 * with qualifier "pg_asd" (stored apart from Pg); an exposure quote names the category.
 * Pure — tested without a network.
 */
export function parseDesignCriteriaLookup(
  parsed: Record<string, unknown>,
  grounded: boolean,
  truncated = false,
  /** The jurisdiction looked up — its own .org site is an official source; with null, no .org is. */
  jurisdiction: { ahj: string; state: string } | null = null,
): DesignCriteriaResearchResult {
  const values: DesignCriteriaResearchResult["values"] = [];
  const dropped: string[] = [];
  if (grounded) {
    for (const key of ["groundSnowLoadPsf", "groundSnowLoadAsdPsf", "windSpeedMph", "windExposure", "seismicDesignCategory", "frostDepthIn", "riskCategory"] as const) {
      const v = parsed[key] as { value?: unknown; sourceUrl?: unknown; quote?: unknown; sourceKind?: unknown } | undefined;
      if (!v || typeof v !== "object") continue;
      const criterion: LookupValue["criterion"] = key === "groundSnowLoadAsdPsf" ? "groundSnowLoadPsf" : key;
      const sourceUrl = typeof v.sourceUrl === "string" ? v.sourceUrl.trim() : "";
      const quote = typeof v.quote === "string" ? v.quote.trim() : "";
      const isText = criterion === "windExposure" || criterion === "seismicDesignCategory" || criterion === "riskCategory";
      // A risk category answered as "2" is Risk Category II.
      const romanRisk: Record<string, string> = { "1": "I", "2": "II", "3": "III", "4": "IV" };
      const rawText = String(v.value ?? "").trim().toUpperCase();
      const value = isText ? (criterion === "riskCategory" ? romanRisk[rawText] ?? rawText : rawText) : typeof v.value === "number" ? v.value : Number.NaN;
      if (!sourceUrl || (typeof value === "number" && !Number.isFinite(value)) || value === "") continue;
      let why = "";
      let qualifier: LookupValue["qualifier"];
      if (!quote) why = "no quote";
      else if (criterion === "windExposure") {
        if (!/^[BCD]$/.test(String(value)) || !new RegExp(`exposure[^.;]{0,40}\\b${value}\\b|\\b${value}\\b[^.;]{0,20}exposure`, "i").test(quote)) why = "quote does not name the exposure";
        else if (/\bexp(?:osure|\.)?\s*(?:cat(?:egory|\.)?\s*)?[:=]?\s*[BCD]\s*(?:,|\/|&|-|–|\bor\b|\band\b|\bto\b|\bthrough\b)\s*(?:exp(?:osure|\.)?\s*(?:cat(?:egory|\.)?\s*)?)?[BCD]\b/i.test(quote)) why = "quote lists several exposures";
      } else if (criterion === "seismicDesignCategory") {
        // The label is matched case-insensitively, the category case-SENSITIVELY ("a house" is not SDC A).
        const label = quote.match(/seismic|\bSDC\b/i);
        const tail = label ? quote.slice((label.index ?? 0) + label[0].length).split(/[.;]/)[0].slice(0, 40) : "";
        if (!/^(?:A|B|C|D[012]?|E|F)$/.test(String(value)) || !new RegExp(`\\b${value}\\b`).test(tail)) why = "quote does not name the seismic design category";
        else if (/\b(?:A|B|C|D[012]?|E|F)\s*(?:,|\/|&|-|–|\bor\b|\band\b|\bto\b|\bthrough\b)\s*(?:A|B|C|D[012]?|E|F)\b/.test(tail)) why = "quote lists several seismic design categories";
      } else if (criterion === "riskCategory") {
        // Bound to its own label ("Risk Category II", "Occupancy Category: II"), the numeral in
        // roman or arabic form, and never a list ("Risk Category I or II").
        const label = quote.match(/\b(?:risk|occupancy)\s+cat(?:egory|\.)?/i);
        const tail = label ? quote.slice((label.index ?? 0) + label[0].length).split(/[.;]/)[0].slice(0, 30) : "";
        const arabic = Object.entries(romanRisk).find(([, r]) => r === value)?.[0] ?? "";
        // The value is checked BEFORE it goes into a pattern: it is the model's text.
        const named = /^(?:I|II|III|IV)$/.test(String(value))
          && new RegExp(`^\\s*[:=-]?\\s*(?:${value}${arabic ? `|${arabic}` : ""})(?![A-Za-z0-9])`).test(tail);
        if (!named) why = "quote does not name the risk category";
        else if (/^\s*[:=-]?\s*(?:IV|I{1,3}|[1-4])\s*(?:,|\/|&|-|–|\bor\b|\band\b|\bto\b|\bthrough\b)\s*(?:IV|I{1,3}|[1-4])(?![A-Za-z0-9])/.test(tail)) why = "quote lists several risk categories";
      } else {
        const nums = numbersIn(quote);
        const hits = nums.map((x, i) => ({ ...x, i })).filter((x) => x.n === value);
        if (!hits.length) why = "quote does not contain the value";
        else if (hits.every((h) => inRangeOrList(quote, h.at, h.end))) why = "value sits in a range or list";
        else if (SITE_CONDITIONAL.test(quote)) why = "quote makes the value site-specific";
        else if (criterion === "frostDepthIn") {
          const bound = hits.filter((h) => !inRangeOrList(quote, h.at, h.end)).some((h) => {
            const l = labelOf(quote, nums, h.i);
            return /frost/i.test(l.before) || /^\s*(?:in(?:ch(?:es)?)?\.?|")?\s*\(?\s*frost/i.test(l.after);
          });
          if (!bound) why = "quote does not bind the value to frost depth";
        } else if (criterion === "windSpeedMph") {
          const classes = hits.filter((h) => !inRangeOrList(quote, h.at, h.end)).map((h) => windClass(labelOf(quote, nums, h.i)));
          const speeds = nums.filter((x) => /^\s*mph\b/i.test(quote.slice(x.end, x.end + 6)));
          if (classes.includes("ult")) { /* bound to Vult / ultimate / wind */ }
          else if (classes.includes("asd")) why = "quote labels the speed ASD/nominal";
          else if (speeds.length > 1) why = "quote carries several speeds and none is labelled Vult";
          else if (/\b(?:v\s*_?\s*asd|vasd|asd|nominal|allowable\s+stress)\b/i.test(quote)) why = "quote labels the speed ASD/nominal";
        } else {
          const classes = hits.filter((h) => !inRangeOrList(quote, h.at, h.end)).map((h) => snowClass(labelOf(quote, nums, h.i)));
          // Under the pg(asd) key only a number labelled pg(asd) counts; under the Pg key a number
          // labelled pg(asd) is re-qualified (kept apart), never stored as the strength Pg.
          if (key === "groundSnowLoadAsdPsf") {
            if (classes.includes("pg_asd")) qualifier = "pg_asd";
            else why = "the value is not the one labelled pg(asd)";
          } else if (classes.includes("pg")) qualifier = "pg";
          else if (classes.includes("pg_asd")) qualifier = "pg_asd";
          else if (classes.includes("roof")) why = "the value is labelled roof snow, not ground snow";
          else why = "quote does not bind the value to ground snow";
        }
      }
      // A staging / preview host is not the jurisdiction's published page (measured: a "prelive"
      // copy of a superseded table).
      if (!why && /^https?:\/\/[^/]*\b(?:prelive|preview|staging|stage|uat|dev|test)\b/i.test(sourceUrl)) why = "source is a staging/preview host";
      // Official pages only — the same list the prompt gives the page fetch (a fetched blog or vendor
      // page must not become a jurisdiction's seeded value).
      if (!why && !isOfficialCodeSource(sourceUrl, jurisdiction)) why = "source is not an official government or code-publisher page";
      if (why) { dropped.push(`${key} ${value} (${why})`); continue; }
      // One value per stored field: a strength Pg and a pg(asd) may both land; two answers for the
      // same one (the model put a pg(asd) quote under groundSnowLoadPsf and also answered the asd key) keep the first.
      if (values.some((x) => x.criterion === criterion && (x.qualifier ?? "") === (qualifier ?? ""))) { dropped.push(`${key} ${value} (a second value for the same field)`); continue; }
      const weakSource = weakDesignSourceReason(sourceUrl, v.sourceKind);
      const item: LookupValue = { criterion, value, sourceUrl, quote: quote.slice(0, 240), ...(qualifier ? { qualifier } : {}), ...(weakSource ? { weakSource } : {}) };
      values.push(item);
    }
  }
  const notes = typeof parsed.notes === "string" ? parsed.notes.slice(0, 400) : "";
  // SITE-SPECIFIC criteria: no value to store, a page for a person — official pages only, one per
  // criterion, never for a criterion that came back with a value.
  const siteSpecific: NonNullable<DesignCriteriaResearchResult["siteSpecific"]> = [];
  if (grounded && Array.isArray(parsed.siteSpecific)) {
    for (const raw of parsed.siteSpecific as Array<Record<string, unknown> | null>) {
      const criterion = String(raw?.criterion ?? "") as NonNullable<DesignCriteriaResearchResult["siteSpecific"]>[number]["criterion"];
      if (!["groundSnowLoadPsf", "windSpeedMph", "windExposure", "seismicDesignCategory", "frostDepthIn"].includes(criterion)) continue;
      const sourceUrl = typeof raw?.sourceUrl === "string" ? raw.sourceUrl.trim().slice(0, 500) : "";
      if (!/^https?:\/\//i.test(sourceUrl) || !isOfficialCodeSource(sourceUrl, jurisdiction)) continue;
      if (values.some((v) => v.criterion === criterion) || siteSpecific.some((x) => x.criterion === criterion)) continue;
      siteSpecific.push({ criterion, sourceUrl, note: typeof raw?.note === "string" ? raw.note.trim().slice(0, 200) : "" });
    }
  }
  return {
    provider: "claude",
    values,
    webGrounded: grounded,
    ...(truncated ? { truncated: true } : {}),
    ...(siteSpecific.length ? { siteSpecific } : {}),
    // A cut-off answer is not a negative result: an empty list from a truncated reply must not
    // read as "the jurisdiction publishes nothing".
    notes: `${grounded ? "Web-grounded lookup." : "No web results — nothing stored."}${truncated ? " Output truncated — not a negative result; retry." : ""}${dropped.length ? ` Dropped: ${dropped.join("; ")}.` : ""} ${notes}`.trim(),
  };
}

/** The fallback's own instructions. The fallback used to resend the web prompt ("FIRST search
 *  the web … cite it") with no tool attached, so the model spent its budget explaining it could
 *  not search and then wrote source-looking URLs from memory. */
export const MODEL_MEMORY_RESEARCH_RULES = `YOU HAVE NO WEB ACCESS IN THIS CALL. Answer ONLY from general knowledge of this jurisdiction and its region, and treat every answer as unverified.
- Do NOT output any URL, link, web address or domain name anywhere. Every URL / sourceUrl field must be "" and any citations array must be empty.
- Do NOT say you searched, found, confirmed, verified or cited anything, and do not explain that you cannot browse.
- Where you are unsure, give the standard requirement for the state/region and say it must be verified.`;

// The `(?<![\w@.-])` lookbehind keeps an EMAIL ADDRESS whole: without it the bare-domain branch
// matched the domain after the "@" (a `\b` sits between "@" or "-" and a letter), so
// "permits@cityofx.gov" was stored in shared KB rows as the dangling "permits@", and
// "building@city-x.gov" as "building@city-". An email is contact info, not a portal link.
const URL_LIKE = /\bhttps?:\/\/\S+|(?<![\w@.-])www\.\S+|(?<![\w@.-])\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:gov|com|org|net|us|edu|info|io)\b(?:\/\S*)?/gi;

/** Remove every URL / bare domain from a model-memory string. A link recalled from memory
 *  reads as a source to the operator and, in KB notes, is harvested as a form candidate.
 *  Email addresses are kept intact (see URL_LIKE). */
export function stripUrlsFromModelMemory(value: string): string {
  return String(value || "").replace(URL_LIKE, "").replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

/** How much web searching a response did, read from BOTH places the API reports it.
 *   searches         — max(server_tool_use web_search blocks, usage.server_tool_use.web_search_requests):
 *                      "a search was attempted", robust to either signal being absent.
 *   groundedSearches — web_search_tool_result blocks whose content is a NON-EMPTY results array.
 *                      An error object ({type:"web_search_tool_result_error", error_code:
 *                      "unavailable" | "too_many_requests" | …}) or an empty array returned
 *                      nothing, so an answer written after it is model memory. A usage count
 *                      with no visible result block proves an attempt, not a result.
 *  Only `groundedSearches > 0` may label an answer web-grounded. */
export function summarizeWebSearch(msg: { content?: unknown; usage?: unknown }): { searches: number; groundedSearches: number } {
  const blocks = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown> | null>) : [];
  const blockCount = blocks.filter((b) => b?.type === "server_tool_use" && b?.name === "web_search").length;
  const usage = (msg?.usage ?? null) as { server_tool_use?: { web_search_requests?: unknown } | null } | null;
  const reported = Number(usage?.server_tool_use?.web_search_requests);
  const usageCount = Number.isFinite(reported) && reported > 0 ? Math.floor(reported) : 0;
  const groundedSearches = blocks.filter((b) => b?.type === "web_search_tool_result" && Array.isArray(b?.content) && (b.content as unknown[]).length > 0).length;
  return { searches: Math.max(blockCount, usageCount), groundedSearches };
}

/** The result URLs the web searches actually RETURNED (web_search_tool_result blocks with a results
 *  array — also when the search ran from code execution), deduped and bounded. Evidence stored on a
 *  research row's provenance: which pages the answer could have come from. */
export function webSearchResultUrls(msg: { content?: unknown }, max = 20): string[] {
  const blocks = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown> | null>) : [];
  const urls: string[] = [];
  for (const b of blocks) {
    if (b?.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content as Array<Record<string, unknown> | null>) {
      const u = typeof r?.url === "string" ? r.url.trim() : "";
      if (/^https?:\/\//i.test(u) && !urls.includes(u)) urls.push(u.slice(0, 300));
      if (urls.length >= max) return urls;
    }
  }
  return urls;
}

/** What a web search had gathered when OUR timeout aborted it: the stream's last snapshot, read
 *  with the same helpers as a finished answer. Grounding is decided exactly as for a finished one —
 *  a partial snapshot with no search result block is model memory and stays ungrounded. */
export interface PartialWebSearch { text: string; searches: number; groundedSearches: number; resultUrls: string[]; fetchedUrls: string[]; resultTitles: Record<string, string>; fetches: number }
export function partialWebSearchOf(snapshot: unknown): PartialWebSearch {
  const msg = (snapshot && typeof snapshot === "object" ? snapshot : {}) as { content?: unknown; usage?: unknown };
  const blocks = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown> | null>) : [];
  const { searches, groundedSearches } = summarizeWebSearch(msg);
  return {
    text: blocks.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join(""),
    searches, groundedSearches, resultUrls: webSearchResultUrls(msg, 400), fetchedUrls: webFetchResultUrls(msg),
    resultTitles: webSearchResultTitles(msg, 400), fetches: countWebFetches(msg),
  };
}
/** askWithWebSearch's own timeout fired. Carries the partial evidence; the message is the SDK's. */
export class WebSearchAbortedError extends Error {
  constructor(message: string, readonly partial: PartialWebSearch) {
    super(message);
    this.name = "WebSearchAbortedError";
  }
}

/** The TITLE each search result carried, by URL (the per-job lookup picks the agency's fee schedule /
 *  checklist from its search results by title — a URL alone rarely says "fee schedule"). */
export function webSearchResultTitles(msg: { content?: unknown }, max = 400): Record<string, string> {
  const blocks = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown> | null>) : [];
  const out: Record<string, string> = {};
  let n = 0;
  for (const b of blocks) {
    if (b?.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content as Array<Record<string, unknown> | null>) {
      const u = typeof r?.url === "string" ? r.url.trim().slice(0, 300) : "";
      const t = typeof r?.title === "string" ? r.title.trim().slice(0, 200) : "";
      if (/^https?:\/\//i.test(u) && t && !(u in out)) { out[u] = t; if (++n >= max) return out; }
    }
  }
  return out;
}

/** Output budget for the code-edition research. It asks for dated editions per family (effective /
 *  mandatory dates, basis, previous edition, a quote) plus the state's adoption model and upcoming
 *  editions: the measured 4.9k-token answer at the old shape grows, and adaptive thinking spends
 *  from the same budget. Truncation parses to {} and stores nothing, so this is a ceiling, not a
 *  cost — tokens are billed as used. */
export const CODE_RESEARCH_MAX_TOKENS = 10000;

export class ClaudeLLMProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    // maxRetries 5 (SDK default 2): the SDK auto-retries 408/429/5xx/connection
    // errors with backoff and honors retry-after. learn/prepare_submission/
    // autopilot jobs are enqueued with maxRetries:0, so a 529 burst that
    // outlasts two quick retries would otherwise permanently fail a run
    // mid-flight and discard all page progress.
    //
    // timeout 4min (SDK default 10min): a live NEM learn sat NINE MINUTES on one stalled
    // planner call with the browser open on a half-filled page and not a single log line —
    // to the operator, indistinguishable from a hang (and the last such "hang" got the
    // window closed by hand, killing the run at page 9). The heaviest legitimate planner
    // calls finish in well under two minutes; four bounds the stall while retries recover
    // it, and instrument() logs the ✗ so the wait is at least visible.
    this.client = new Anthropic({ apiKey, maxRetries: 5, timeout: 240000 });
  }

  // ---------------------------------------------------------------------------
  // Instrumentation — every Claude call routes through here so the terminal/logs
  // show what's happening: which operation, how long it took, token usage
  // (incl. prompt-cache hits), and the stop_reason. Refusals (safety classifier)
  // and max_tokens truncation are surfaced as WARN because both silently degrade
  // a JSON response to garbage downstream — these are the first things to check
  // when a parse "fails for no reason". `label` is the operation name so a log
  // line reads e.g. `[llm] ✓ extractProjectFields ms=8421ms inTok=6210 outTok=1840 stop=end_turn`.
  // ---------------------------------------------------------------------------
  // Generic in the message type so a `client.messages.parse()` call keeps its
  // `parsed_output` through the wrapper — every existing caller is unaffected
  // (T infers to Anthropic.Message).
  //
  // ROUTED (2026-09-26): `route` says which model/effort/advisor the call runs on; `exec` builds the
  // request from the CallTarget it is handed, so a refusal fallback can re-run it on another model.
  // A REFUSAL IS THROWN as LlmRefusalError (after one fallback attempt when the route has one and the
  // category is not reasoning_extraction) — before this, its empty content flowed on to the parser,
  // read as "no JSON", and the intake retry paid to be refused a second time.
  private async instrument<T extends Anthropic.Message>(
    label: string,
    route: ResolvedRoute,
    meta: Record<string, unknown>,
    exec: (t: CallTarget) => Promise<T>,
  ): Promise<T> {
    const primary: CallTarget = { model: route.model, ...(route.effort ? { effort: route.effort } : {}), advisor: route.advisor };
    const msg = await this.runOnce(label, primary, meta, exec);
    if (msg.stop_reason !== "refusal") return msg;
    const category = (msg as { stop_details?: { category?: string | null } }).stop_details?.category ?? null;
    const fb = route.refusalFallback;
    if (fb && category !== "reasoning_extraction") {
      logger.warn("llm", `↻ ${label} refused on ${route.model} — retrying once on ${fb.model}`, { category });
      const second = await this.runOnce(label, { model: fb.model, ...(fb.effort ? { effort: fb.effort } : {}), advisor: null }, { ...meta, refusalFallback: true }, exec);
      if (second.stop_reason !== "refusal") return second;
      throw new LlmRefusalError(label, fb.model, (second as { stop_details?: { category?: string | null } }).stop_details?.category ?? category);
    }
    throw new LlmRefusalError(label, route.model, category);
  }

  /** One logical request: the transient-retry loop, the log line and the ledger row(s). */
  private async runOnce<T extends Anthropic.Message>(
    label: string,
    target: CallTarget,
    metaIn: Record<string, unknown>,
    exec: (t: CallTarget) => Promise<T>,
  ): Promise<T> {
    const t0 = performance.now();
    const at = Date.now();
    const MODEL = target.model;
    const meta: Record<string, unknown> = { ...metaIn, ...(target.effort ? { effort: target.effort } : {}), ...(target.advisor ? { advisor: target.advisor.model } : {}) };
    logger.debug("llm", `→ ${label}`, { model: MODEL, ...meta });
    let msg: T;
    // A TRANSIENT FAILURE INSIDE A STREAM DOES NOT REACH THE SDK'S RETRY.
    //
    // The client is built with maxRetries:5 and the SDK does retry 429/5xx — but only when
    // the REQUEST fails. Every call here is a .stream(), so the HTTP request succeeds and an
    // overload arrives later as an event inside the stream. The SDK has nothing left to
    // retry, and this wrapper had nothing either.
    //
    // Measured cost, on the final sweep of 2026-09-04: Gilbert's single planner call came
    // back {"type":"overloaded_error","message":"Overloaded"} after 1455ms, the run recorded
    // zero fills on a form whose eight fields it had already extracted, and the portal
    // dropped two rungs. One transient upstream blip, one portal lost, and nothing in the
    // scorecard to say it was not the engine's fault — it looked exactly like a regression
    // from that day's work, which is the expensive way to be wrong.
    //
    // Bounded and narrow: only the errors a retry can actually fix, never a bad request or
    // an auth failure, and logged each time so a run that survived a burst says so.
    let lastErr: unknown;
    // One advisor slot per logical request (not per transient retry); past the process ceiling the
    // call runs on the executor alone rather than failing.
    const sent: CallTarget = target.advisor && !takeAdvisorSlot() ? { ...target, advisor: null } : target;
    for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
      try {
        msg = await exec(sent);
        if (attempt > 0) logger.info("llm", `✓ ${label} recovered after ${attempt} retry(ies)`, { ...meta });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length || !shouldWrapperRetry(err)) break;
        const wait = TRANSIENT_RETRY_DELAYS_MS[attempt];
        logger.warn("llm", `↻ ${label} transient failure — retrying in ${wait}ms`, { ...meta, attempt: attempt + 1, err: errMsg(err) });
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (lastErr) {
      const err = lastErr;
      logger.error("llm", `✗ ${label} failed`, { ms: `${Math.round(performance.now() - t0)}ms`, ...meta, err: errMsg(err) });
      recordLlmCall({ at, label, model: MODEL, ms: Math.round(performance.now() - t0), error: errMsg(err) });
      throw err;
    }
    msg = msg!;
    const ms = Math.round(performance.now() - t0);
    const u = msg.usage as
      | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
      | undefined;
    const extra: Record<string, unknown> = {
      ms: `${ms}ms`,
      inTok: u?.input_tokens,
      outTok: u?.output_tokens,
      // Only show cache counters when non-zero so quiet lines stay readable; a
      // persistent cacheRead=0 across repeated calls is the tell that a large
      // static system prompt isn't being cached (see prompt-caching notes).
      cacheRead: u?.cache_read_input_tokens || undefined,
      cacheWrite: u?.cache_creation_input_tokens || undefined,
      stop: msg.stop_reason,
    };
    if (msg.stop_reason === "refusal") {
      const cat = (msg as { stop_details?: { category?: string } }).stop_details?.category;
      logger.warn("llm", `⚠ ${label} refused by safety classifier — content unusable`, { ...extra, category: cat });
    } else if (msg.stop_reason === "max_tokens") {
      logger.warn("llm", `⚠ ${label} hit max_tokens — output truncated, JSON likely unparseable (raise maxTokens)`, extra);
    } else {
      logger.info("llm", `✓ ${label}`, extra);
    }
    recordLlmCall({
      at, label, model: MODEL, ms,
      inTok: u?.input_tokens, outTok: u?.output_tokens,
      cacheRead: u?.cache_read_input_tokens || undefined,
      cacheWrite: u?.cache_creation_input_tokens || undefined,
      stop: msg.stop_reason,
      // Web-search fees ($10/1000) were invisible in every cost figure before this column existed.
      webSearches: webSearchRequestsOf(u),
    });
    // THE ADVISOR IS ITS OWN LINE. With the advisor tool, top-level usage is the EXECUTOR's alone
    // (checked against the measured runs: it equals the sum of the non-advisor iterations); the
    // advisor's sub-inference is billed at ITS model's price and arrives only in usage.iterations.
    // Without this row a Fable consult ($10/$50) would be invisible spend.
    const iters = (u as { iterations?: Array<{ type?: string; model?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }> | null } | undefined)?.iterations;
    const adv = Array.isArray(iters) ? iters.filter((i) => i?.type === "advisor_message") : [];
    if (adv.length) {
      const sum = (k: "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens") => adv.reduce((s, i) => s + (Number(i[k]) || 0), 0);
      const advModel = String(adv[0].model || sent.advisor?.model || "");
      logger.info("llm", `  ${label} advisor consulted`, { model: advModel, consults: adv.length, inTok: sum("input_tokens"), outTok: sum("output_tokens") });
      recordLlmCall({
        at, label: `${label}.advisor`, model: advModel, ms: 0,
        inTok: sum("input_tokens"), outTok: sum("output_tokens"),
        cacheRead: sum("cache_read_input_tokens") || undefined, cacheWrite: sum("cache_creation_input_tokens") || undefined,
        stop: `consults:${adv.length}`,
        webSearches: 0, // the advisor never searches; a known zero, not an unknown
      });
    }
    return msg;
  }

  /** Stream one request, adding the advisor tool (beta) when the target carries one. The beta
   *  message is structurally a superset of Message for everything this file reads (content blocks
   *  by type, usage, stop_reason). */
  /** `onStream` hands the caller the live stream, so a call it aborts can still read what the
   *  stream had gathered (askWithWebSearch: a timed-out search keeps its grounded evidence). */
  private streamFinal(t: CallTarget, params: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal }, onStream?: (s: { currentMessage?: unknown }) => void): Promise<Anthropic.Message> {
    if (!t.advisor) {
      const s = this.client.messages.stream(params, options);
      onStream?.(s);
      return s.finalMessage();
    }
    const tools = [...((params.tools as unknown[] | undefined) ?? []), advisorToolFor(t.advisor)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = this.client.beta.messages.stream({ ...(params as any), tools, betas: [ADVISOR_BETA] }, options);
    onStream?.(s);
    return s.finalMessage() as unknown as Promise<Anthropic.Message>;
  }

  /** Append the advisor nudge to a user turn — only when the advisor is on. */
  private withAdvisorNudge<C extends string | Anthropic.Messages.ContentBlockParam[]>(t: CallTarget, content: C): C {
    if (!t.advisor) return content;
    if (typeof content === "string") return (content + ADVISOR_NUDGE) as C;
    return [...content, { type: "text" as const, text: ADVISOR_NUDGE.trim() }] as C;
  }

  /** The route for a label this file calls the model under. A label with no route is a programming
   *  error (modelRouting.test scans this file for every literal label). */
  private routeOf(label: string, task?: LlmTask): ResolvedRoute {
    const t = task ?? taskForLabel(label);
    if (!t) throw new Error(`no model route for call label "${label}" — add it to modelRouting.LLM_TASKS`);
    return routeFor(t);
  }

  // Concatenate every text block (more robust than first-block-only: web search
  // and summarized thinking can interleave multiple text blocks).
  private textOf(msg: Anthropic.Message): string {
    let out = "";
    for (const block of msg.content) if (block.type === "text") out += block.text;
    return out;
  }

  // Wrap a static system prompt as a cacheable content block. The portal planner re-sends
  // the SAME multi-KB system prompt on every page of a learn run (18-80 calls) — with
  // cache_control the prefix is cached across calls (5-min TTL, refreshed on each hit), so
  // repeat pages pay ~10% of the input cost and start faster. Prompts under the model's
  // cacheable minimum are simply not cached — never an error. Watch cacheRead in the llm
  // log lines / llm-calls.json to confirm hits.
  private cachedSystem(systemPrompt: string): Anthropic.TextBlockParam[] {
    return [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
  }

  /** ONCE PER PROCESS, not once per call — see countPlannerPrompt. */
  private plannerPromptCounted = false;

  /** What the planner's USER half may cost before somebody should look at it.
   *
   *  The system half is a fixed multi-KB prompt and is cached (measured: 6143
   *  tokens, read from cache on every repeat page). The user half is the page's
   *  field list plus the project digest, and it is the half a regression lands in.
   *
   *  MEASURED, claude-opus-5, 2026-09-15, through the real planPortalFields:
   *    · compact designNotesDigest, 4-field page → user half 313 tokens (686 chars)
   *    · raw parser text in the digest's place  → user half 6673 tokens (15711 chars)
   *  The second is the regression CLAUDE.md warns about, and its price is exactly
   *  the warning's: +6360 input tokens per planner call × 80 calls on a learn run
   *  × $15/Mtok = $7.63 per run, for prompt text the planner does not read.
   *
   *  4000 is chosen between them: roughly twice what a sixty-field page needs
   *  (fields are ~20 tokens each, digest ~300, bodyText ~500) and well under the
   *  measured regression, so a busy page is quiet and raw text is not. */
  private static readonly PLANNER_USER_TOKEN_BUDGET = 4000;

  /** Count the planner prompt ONCE per process and write it to the call log.
   *
   *  count_tokens is free and does not consume the model, but it is still a round
   *  trip, and a learn run makes 18-80 planner calls whose user half is the same
   *  SHAPE every time. One measurement answers the question ("is the digest still
   *  compact?"); eighty answer it eighty times and add eighty round trips to the
   *  run this is supposed to be protecting.
   *
   *  NEVER THROWS AND NEVER BLOCKS THE PLAN. A measurement that fails must cost a
   *  log line, not a portal page — so the flag is set BEFORE the await and the
   *  catch is silent-by-design. */
  private async countPlannerPrompt(label: string, systemPrompt: string, userMessage: string): Promise<void> {
    if (this.plannerPromptCounted) return;
    this.plannerPromptCounted = true;
    const MODEL = this.routeOf(label).model;
    const startedAt = Date.now();
    const t0 = performance.now();
    try {
      const whole = await this.client.messages.countTokens({
        model: MODEL,
        system: this.cachedSystem(systemPrompt),
        messages: [{ role: "user", content: userMessage }],
      });
      const systemOnly = await this.client.messages.countTokens({
        model: MODEL,
        system: this.cachedSystem(systemPrompt),
        messages: [{ role: "user", content: "." }],
      });
      const userTokens = Math.max(0, whole.input_tokens - systemOnly.input_tokens);
      recordLlmCall({
        at: startedAt,
        label: `${label}.countTokens`,
        model: MODEL,
        ms: Math.round(performance.now() - t0),
        inTok: whole.input_tokens,
        outTok: 0,
        webSearches: 0, // count_tokens never searches; a known zero, not an unknown
      });
      logger.info("llm", "planner prompt measured (once per process)", {
        label, promptTokens: whole.input_tokens, systemTokens: systemOnly.input_tokens,
        userTokens, userChars: userMessage.length, budget: ClaudeLLMProvider.PLANNER_USER_TOKEN_BUDGET,
      });
      if (userTokens > ClaudeLLMProvider.PLANNER_USER_TOKEN_BUDGET) {
        logger.warn(
          "llm",
          `⚠ PLANNER PROMPT IS OVER BUDGET: its user half is ${userTokens} tokens against a ${ClaudeLLMProvider.PLANNER_USER_TOKEN_BUDGET} budget. `
          + "A learn run sends this 18-80 times. The usual cause is raw parser text reaching the planner instead of the compact "
          + "designNotesDigest (see CLAUDE.md) — check what resolveRecipeFieldValues is putting in projectFields before running a full learn.",
          { label, userTokens, userChars: userMessage.length },
        );
      }
    } catch (err) {
      // A count that fails tells us nothing; a count that throws would cost a page.
      logger.debug("llm", "planner prompt count_tokens unavailable", { label, err: errMsg(err) });
    }
  }

  // EFFORT IS OPTIONAL HERE AND THE DEFAULT IS NOT FREE.
  //
  // Measured on this exact route (lookupInverterSpec, four real inverter/part
  // numbers, claude-opus-5, 2026-09-15): output_config omitted → 933 output
  // tokens; effort:"high" → 924; effort:"medium" → 721; effort:"low" → 531. The
  // unset default IS high. So every call through this helper has been paying for
  // high-effort reasoning whether or not the route needed it, and "no effort set"
  // is a decision that was never made rather than a cheap default.
  //
  // It stays OPT-IN. Lowering effort is a per-route judgement — a route whose
  // answer is checked or escalated downstream can afford a weaker first pass; a
  // route whose answer is acted on unverified cannot — so callers name it, and
  // anything that says nothing keeps exactly the behaviour it had.
  //
  // ROUTED: the effort a route runs at now lives in modelRouting.ROUTE_TABLE (lookupInverterSpec's
  // "low" moved there with its measurement), so the table is the one place a route's effort is named.
  private async ask(
    label: string,
    systemPrompt: string,
    userMessage: string,
    format?: Anthropic.JSONOutputFormat,
  ): Promise<string> {
    const msg = await this.instrument(label, this.routeOf(label), { chars: userMessage.length, ...(format ? { schema: true } : {}) }, (t) => {
      const oc = outputConfigFor(t, format);
      return this.client.messages
        .stream({
          model: t.model,
          max_tokens: 2048,
          thinking: { type: "adaptive" },
          ...(oc ? { output_config: oc } : {}),
          system: this.cachedSystem(systemPrompt),
          messages: [{ role: "user", content: userMessage }],
        })
        .finalMessage();
    });
    return this.textOf(msg);
  }

  private parseJson<T>(text: string, fallback: T): T {
    try {
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      return JSON.parse(match ? match[1] : text) as T;
    } catch {
      return fallback;
    }
  }

  // Read a schema-constrained response. Returns the validated value, or null when the
  // response was NOT schema-shaped — which with output_config.format set means the call
  // truncated or was refused, not that the model wrote sloppy JSON. Null is a value the
  // caller falls back from; the SDK's own parse would have thrown here instead, inside
  // the stream, taking the raw text (and every diagnostic that reads it) with it.
  private readStructured<T>(raw: string, schema: z.ZodType<T>, label: string): T | null {
    const NOTHING = Symbol("no-json");
    const obj = this.parseJson<unknown>(raw, NOTHING);
    if (obj === NOTHING) {
      logger.warn("llm", `⚠ ${label} returned no JSON despite a response schema — truncated or refused`, { chars: raw.length });
      return null;
    }
    const result = schema.safeParse(obj);
    if (result.success) return result.data;
    // The server constrains decoding to this schema, so a mismatch is a real signal
    // (usually a truncated object that still parsed). Say so; fall back, never throw.
    logger.warn("llm", `⚠ ${label} response did not satisfy its schema — falling back to tolerant parsing`, {
      issue: result.error.issues[0] ? `${result.error.issues[0].path.join(".")}: ${result.error.issues[0].message}` : "unknown",
    });
    return null;
  }

  async extractFields(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const system = `You are a solar permit document parser. Extract structured data from solar permit application text.
Return a JSON object with any of these fields you can find: customerName, address, city, state, zip, systemKw, panelCount, panelModel, inverterModel, inverterCount, batteryModel, batteryCount, utilityAccount, meterNumber, ahj, utility, roofType, mountType, azimuth, tilt.
IMPORTANT: Do NOT include utility account numbers — omit that field entirely for privacy.
Set confidence (0-1) for each field. Return only valid JSON.`;
    const raw = await this.ask("extractFields", system, JSON.stringify(input));
    return this.parseJson<Record<string, unknown>>(raw, { provider: "claude", confidence: 0 });
  }

  // Larger budget than ask() — plan sets are dense and we want every field.
  private async askLong(label: string, systemPrompt: string, userMessage: string, maxTokens = 4096, format?: Anthropic.JSONOutputFormat,
    images?: Array<{ label: string; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }>,
    /** Filled with the final stop reason when supplied (the intake retry reads it). */
    info?: { stopReason?: string | null }): Promise<string> {
    const r = await this.askLongDetailed(label, systemPrompt, userMessage, maxTokens, format, images);
    if (info) info.stopReason = r.stopReason;
    return r.text;
  }

  /** askLong, also reporting the final stop reason (the intake retry needs to know whether the
   *  output already ran into the 2x ceiling — re-sending that from the top repeats both calls). */
  private async askLongDetailed(label: string, systemPrompt: string, userMessage: string, maxTokens = 4096, format?: Anthropic.JSONOutputFormat,
    images?: Array<{ label: string; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }>): Promise<{ text: string; stopReason: string | null }> {
    // Page images (a scanned plan set with no text layer) go BEFORE the text, each labelled.
    const content: string | Anthropic.Messages.ContentBlockParam[] = images?.length
      ? [
          ...images.flatMap((img) => [
            { type: "text" as const, text: img.label },
            { type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.base64 } },
          ]),
          { type: "text" as const, text: userMessage },
        ]
      : userMessage;
    const route = this.routeOf(label);
    const run = (budget: number) =>
      this.instrument(label, route, { chars: userMessage.length, maxTokens: budget, ...(images?.length ? { images: images.length } : {}), ...(format ? { schema: true } : {}) }, (t) => {
        const oc = outputConfigFor(t, format);
        return this.streamFinal(t, {
          model: t.model,
          max_tokens: budget,
          thinking: { type: "adaptive" },
          // Plan sets are dense, multi-section reasoning — give the model room to reason (the
          // route table holds "high" for every askLong task). `format`, when supplied, constrains
          // decoding to the route's JSON schema.
          ...(oc ? { output_config: oc } : {}),
          system: this.cachedSystem(systemPrompt),
          messages: [{ role: "user", content: this.withAdvisorNudge(t, content) }],
        });
      });
    let msg = await run(maxTokens);
    // Truncated output is usually unparseable JSON → a silently empty result. Retry once
    // at 2× — but only when the clipped text really is unusable: a response whose JSON
    // block completed before the cap (only trailing prose was cut) parses fine, and
    // re-running it would double the cost of the hottest call for nothing.
    if (msg.stop_reason === "max_tokens" && !hasCompleteJsonBlock(this.textOf(msg))) {
      msg = await run(maxTokens * 2);
    }
    return { text: this.textOf(msg), stopReason: msg.stop_reason ?? null };
  }

  // Like askLong, but with a page SCREENSHOT prepended (vision-assisted planning). The model
  // reads the visible layout/section headings as the authoritative signal and the JSON field
  // list corroborates it. Used by planPortalFields when a screenshot is available.
  private async askLongWithImage(label: string, systemPrompt: string, userMessage: string, imageBase64: string, mimeType: "image/png" | "image/jpeg" | "image/webp", maxTokens = 4096, format?: Anthropic.JSONOutputFormat): Promise<string> {
    const run = (budget: number) =>
      this.instrument(label, this.routeOf(label), { chars: userMessage.length, maxTokens: budget, image: true, ...(format ? { schema: true } : {}) }, (t) =>
        this.client.messages
          .stream({
            model: t.model,
            max_tokens: budget,
            thinking: { type: "adaptive" },
            // The vision-assisted planner is the hardest "see and reason" step (read the live
            // layout, reconcile it with the field list, decide each fill) — its route runs it at xhigh.
            ...(outputConfigFor(t, format) ? { output_config: outputConfigFor(t, format) } : {}),
            system: this.cachedSystem(systemPrompt),
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
                { type: "text", text: userMessage },
              ],
            }],
          })
          .finalMessage(),
      );
    let msg = await run(maxTokens);
    // Same truncation retry as askLong — only when the clipped text is truly unusable.
    if (msg.stop_reason === "max_tokens" && !hasCompleteJsonBlock(this.textOf(msg))) {
      msg = await run(maxTokens * 2);
    }
    return this.textOf(msg);
  }

  async extractProjectFields(input: {
    planText?: string;
    utilityBillText?: string;
    meterText?: string;
    structuralLetterText?: string;
    defaultState?: string;
    /** A SCANNED plan set (no text layer): its key sheets as page images (scannedPlanSet.ts caps them). */
    planPageImages?: Array<{ page: number; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; label?: string }>;
    /** "hybrid": the text layer was read separately; these are the set's image-only pages. */
    planImageMode?: "scan" | "hybrid";
  }): Promise<ParserLlmExtraction> {
    const system = `You are an expert solar permit intake specialist. You read the raw extracted text of a residential solar project's documents and pull out every field a permit/interconnection application needs. The text comes from PDF extraction and OCR, so it may be noisy, out of order, or have character errors — use judgment and cross-check between documents.

You are given up to three documents:
- PLAN_SET: the engineering plan set (cover sheet, site plan, electrical SLD, datasheets). Best source for system size, equipment, roof, AHJ.
- UTILITY_BILL: the electric utility bill. Best source for homeowner name(s) (the account holder in the customer block — never the utility, its website/email/phone, or its remit-to address), service address, utility company, account number, and sometimes meter number.
- METER_PHOTO: OCR of a photo of the electric meter. Best source for the meter number/serial.
- STRUCTURAL_LETTER: a stamped/sealed engineering letter or structural calculation package. AUTHORITATIVE for the structural block (ground snow, PV dead load, roof dead/live load, ultimate design wind speed + exposure category, risk category, rafter/truss size + spacing + span, wood grade, roof material, roof slope, attachment/withdrawal values) and for whether a PE stamp exists. It does NOT contain the electrical single-line or the equipment schedule — never infer module/inverter make, model, wattage, quantity, or system size from it.

Return ONLY a JSON object of this exact shape:
{
  "fields": {
    "<fieldId>": { "value": <string|number|null|array|object>, "confidence": <0..1>, "evidence": { "source": "plan_set|utility_bill|meter_photo|structural_letter", "sheet": "<sheet/page hint e.g. PV-2 or Cover>", "excerpt": "<verbatim text you read it from, MAX 100 CHARACTERS>" } }
  },
  "lowConfidenceFields": ["<fieldId>", ...],
  "uncertainties": [ { "field": "<fieldId>", "kind": "unreadable|guessed|inferred|conflicting|unconfirmed", "reason": "<one short sentence>" } ],
  "conflicts": [ { "field": "<fieldId>", "readings": [ { "value": <value>, "source": "plan_set|utility_bill|meter_photo|structural_letter", "sheet": "<hint>", "excerpt": "<verbatim, MAX 100 CHARACTERS>" }, ... ], "note": "<what disagrees>" } ],
  "notes": "<short notes on anything ambiguous or worth a human double-check>"
}

UNCERTAINTY AND CONFLICTS ARE STRUCTURED, NOT PROSE:
- lowConfidenceFields is for values that are UNREADABLE (garbled text), GUESSED (no excerpt to cite), INFERRED (derived from something that is not the value itself, e.g. a breaker read off a 705.12 maximum calculation) or CONFLICTING (documents disagree). A value printed on a document beside its label ("Roof Height 25 ft", "PANELS WILL NOT EXTEND MORE THAN 6\" ABOVE") is STATED — it is NOT low confidence merely because no second document confirms it; if you list it anyway, its kind is "unconfirmed". Every lowConfidenceFields entry gets an "uncertainties" row with its kind and a reason.
- Whenever two documents (or two places in one document) give DIFFERENT values for the same field — owner name on the title block vs the letter, dead load on the letter vs the plan set's array table, rafters vs trusses, "SHUTDOWN - NO" vs rapid-shutdown labels — report it in "conflicts" with EVERY reading and its source/excerpt (the structural letter's readings carry source "structural_letter"), and still put your best value in "fields". Do not bury a disagreement in notes only.
- You are shown ONLY the documents listed below. The intake page may hold others you were not given: NEVER write that a bill, meter photo, plan set or letter was "not supplied" / "not provided" — describe only what the text you were given shows.

EVIDENCE IS REQUIRED for accuracy: for every field, include an "evidence" object citing where you read it (which document, the sheet/page hint if visible, and a verbatim excerpt of AT MOST 100 CHARACTERS — just enough for a human to find the line; longer excerpts are truncated on receipt and only cost time). If you cannot cite a source, lower confidence and add the field to lowConfidenceFields.
VALUE TYPES: almost every field is a scalar. The few documented as structured (notably pvArrays) MUST be emitted as real JSON arrays/objects, never as a stringified version of one.

Use EXACTLY these fieldId keys when you find a value (omit a key entirely if absent):
IDENTITY / SITE
- owner: full homeowner name(s) (e.g. "Abigail Boileau & Thomas Boileau")
- street, city, state (2-letter), zip: service address parts
- ahj: Authority Having Jurisdiction (permitting city/county), e.g. "City of Newberg"
- utility: the electric utility as the documents name it, in its common short form (e.g. "Eversource", "Oncor", "SRP", "APS", "Duke Energy", "PGE", "Pacific Power"). Any US utility; do not force it into another utility's naming.
- account: utility account number (digits as printed)
- meter: meter number/serial
SYSTEM / EQUIPMENT
- dcKw (number), acKw (number): system size kW DC / AC
- interco: interconnection method (e.g. "Net Metering", "Load-side breaker", "Supply-side tap")
- moduleMake, moduleModel, moduleWattage (number), moduleQty (number)
- invMake, invModel, invQty (number) — for string inverters
- invOutputW: string-inverter rated output CURRENT in amps (number; from datasheet/SLD)
- pvMicroMake, pvMicroModel, pvMicroQty (number) — for MICROINVERTERS (e.g. Enphase, AP Systems). Use these instead of inv* when the system uses microinverters.
- pvMicroOutputW: microinverter rated output CURRENT in amps per unit (number; from the micro datasheet)
- moduleVoc (number, volts), moduleIsc (number, amps), moduleVocTempCoeff (number, %/°C, negative as printed, e.g. -0.27): the MODULE's open-circuit voltage, short-circuit current and Voc temperature coefficient, read from the module DATASHEET page of the plan set (when the SLD's module table disagrees with the datasheet, the DATASHEET wins and say so in notes — a table copied from an older set is common). Omit when no datasheet page states them.
- pvMicroMaxDcInputV (number, volts): the microinverter's maximum DC input voltage from its datasheet. Omit if not stated.
- modulesPerString (number): modules in series in the longest string (string inverters only; from the SLD string table). Omit for microinverters.
- siteLowTempC (number, °C): the site's extreme minimum / ASHRAE design low temperature printed in the design criteria (convert °F to °C). Omit if the set does not state one — never estimate it.
- invMaxDcInputV (number, volts): the STRING inverter's maximum DC input voltage from its datasheet. Omit for microinverters or if not stated.
- siteHighTempC (number, °C): the site's high design ambient temperature (ASHRAE 2% / 0.4%) printed in the design criteria or conductor calc (convert °F to °C). Omit if not stated — never estimate it.
- acConductor: the inverter OUTPUT circuit conductor (the circuit the PV breaker protects) exactly as the SLD/wire schedule prints it, e.g. "#10 AWG THWN-2 CU". Omit if not stated.
- acConductorCount (number): current-carrying conductors in that circuit's raceway, from the wire schedule. Omit if not stated.
- acRunLengthFt (number, feet): the ONE-WAY length of that circuit when the SLD or voltage-drop calc states it. Omit if not stated — never estimate it from a drawing.
- inverterSettings: note grid-support listing / settings, e.g. "UL 1741 SB" or "UL 1741 SA, PCS profile" (needed for utility interconnection)
- batteryMake, batteryModel, batteryQty (number)
- roofMaterial (e.g. "Composition Shingle"), mounting (e.g. "Roof Mount"). A TILE roof is tile — never "shingle": write e.g. "Concrete Tile", "Clay S-Tile", "Flat Concrete Tile" exactly as the sheets say (a "concrete shake tile" is tile, not wood shake)
- roofMaterialSubtype: tile roofs only — "Concrete", "Clay", "S-tile", "Flat tile" (or two joined with " / ", e.g. "Concrete / S-tile"); omit for non-tile roofs
- tileAttachmentMethod: tile roofs only — "tile hook", "tile-replacement mount" or "comp-out", from the attachment detail / racking notes; omit if the sheets do not say
EXISTING SYSTEM (system ADDITIONS: the plan set shows an existing PV system remaining in service alongside the new install — e.g. an "EXISTING ARRAY" on the site plan, "EXISTING SYSTEM SPECIFICATIONS" block, "(E) PV" on the SLD)
- existingSystem: "yes" when an existing PV system is shown remaining in service; omit otherwise
- existingDcKw (number), existingAcKw (number): the EXISTING system's size
- existingModuleMake, existingModuleModel, existingModuleQty (number): the EXISTING modules
- existingInvMake, existingInvModel, existingInvQty (number): the EXISTING inverter(s)
- combinedDcKw (number), combinedAcKw (number): the COMBINED/total size after the addition (often labeled "COMBINED SYSTEM SIZE"); compute new+existing if not printed
ELECTRICAL (read from the SLD / one-line and load calc — critical for plan review)
- busRating: main service panel (MSP) busbar rating in amps (e.g. "200A")
- mainBreaker: main breaker / main service rating in amps (e.g. "200A")
- pvBreaker: PV backfeed breaker / OCPD size in amps (e.g. "40A")
- acDiscReq: AC/manual disconnect — "yes/required/provided/shown" if a lockable visible load-break disconnect is shown, else note the exception
- acDiscQty: how many AC disconnects the equipment schedule lists (a number, e.g. "1", "2")
- acDiscAmps: the AC disconnect's amp rating from the equipment schedule (e.g. "60A")
- acDiscFused: "fusible" or "non-fusible" exactly as the equipment schedule words it
- acDiscVoltage: the AC disconnect's voltage rating (e.g. "240V")
- acDiscMakeModel: the AC disconnect's manufacturer and model IF the schedule names one. Most
  plan sets do NOT — they specify only the rating ("60A NON-FUSIBLE AC DISCONNECT, 240V") and
  leave the part to the installer. Return "" rather than guessing, and NEVER borrow the
  combiner panel's or load centre's make/model (an equipment schedule lists those adjacent,
  e.g. "COMBINER PANEL 1 EATON BR STYLE 1-INCH LOAD CENTER 816L125RP AC DISCONNECT 1 60A ..."
  — the Eaton part there is the COMBINER, not the disconnect)
STRUCTURAL (read from structural notes / roof framing plan — drive prescriptive screening)
- snow: ground snow load in PSF (number)
- deadLoad: PV dead load in PSF (number)
- roofRafterSpacing: rafter/truss spacing in inches on-center (number, e.g. 24)
- roofRafterSpan: rafter span (number, feet) if given
- wind: wind exposure category letter (e.g. "B" or "C")
- windSpeed: ultimate design wind speed in mph (number, e.g. 120, 135) if the structural notes state it
- riskCategory: building risk/occupancy category as a Roman numeral ("I" or "II" for residential) if stated
- lightFrame: "yes" if the structure is conventional light-frame (dimensional lumber or engineered wood rafters/trusses) construction, "no" if it is not (e.g. steel/concrete/heavy timber), else omit
- framingType: "rafter" or "truss" — the roof framing member type
- structureType: "manufactured" if the documents state THIS house is a manufactured/mobile (HUD) home, "site_built" if they state site-built; else omit (a disclaimer, exclusion or code title is not an answer)
- structureDescription: which building carries the ARRAY, from the site plan / roof plan layout — exactly one of "Single-family dwelling", "Two-family dwelling (duplex)", "Townhouse", "Manufactured home", "Accessory building (garage/shed)". Single-family dwelling unless the array is on a detached garage/shed/barn/ADU (Accessory building) or the dwelling is a duplex/townhouse/manufactured home; another structure merely drawn on the lot does not count; omit if the plan set does not show it
- roofLayers: number of existing roofing layers/coverings under the array (number, e.g. 1)
- moduleHeightAboveRoof: max height of the module top above the roof surface in inches (number, e.g. 10)
- gravityWindDesign: "yes" only when structural design notes/details establish design for the site's gravity and wind loads; cite the evidence, not just a jurisdiction default.
- manufacturerInstallation: "yes" when the PV array AND attachments/racking installation follows the manufacturer's instructions.
- rafterExceptionCompliant: "yes/no" for explicit R324.4.1 Exception 1.4 through 1.6 compliance; spacing alone is insufficient. Omit if unknown.
- moduleFiguresCompliant: "yes/no" for documented compliance with Figures R324.4.1(2) and (3); a height under 18 inches alone is insufficient. Omit if unknown.
- attachmentToFraming: "yes/no" for direct attachment to roof framing or blocking.
- attachmentSpacingIn: maximum attachment spacing in ANY direction in inches (convert feet).
- attachmentEdgeSpacingIn: maximum spacing within 3 feet of roof edges, hips, eaves and ridges, if separately specified, inches.
- attachmentsOutsideEdgeZone: "yes" only if all attachments with spacing over 24 inches are at least 3 feet from roof edges/hips/eaves/ridges.
- standingSeamMethod2Compliant: "yes/no" only if ALL BCD 5952 Method 2 clamp capacity, spacing, tributary area, panel gauge/width, screws and sheathing/nailing requirements are documented. Omit if unknown.
- moduleListingAgency: actual certification/testing agency from the MODULE's label/datasheet (not a racking certificate, not the name of a UL standard). Omit if unknown.
For roofing layers, a generic drawn roof section or "composition shingles" does NOT establish the existing layer count. Do not invent it.
Prefer explicit roof SECTION/mount DETAILS naming trusses over a generic table heading "rafter size & spacing".
- permitPath: "prescriptive" or "engineered" if determinable
BUILDING GEOMETRY (read from the site plan / structural sheet / cover-sheet project data block).
  AHJ permit portals ask for these on the application itself and refuse to advance without them —
  Coos Bay's Accela asks Existing Building Area, Building Height and Number of Stories, and its
  recipe had FROZEN the learn project's answers ("1675" sq ft, "15" feet) onto every later job.
  Extract only what the documents actually state; return "" rather than estimating from a drawing.
- existingBuildingArea: conditioned floor area of the EXISTING house in square feet (number, e.g. 1675).
  Often labelled "existing area", "house sq ft", "conditioned area", or given in a cover-sheet
  project-data table. It is NOT the array area, the roof area, or the lot size.
- buildingHeightFeet: overall height of the existing building in whole FEET (number, e.g. 15) —
  grade to ridge/peak, as the elevation or project-data block states it.
- buildingHeightInches: the remaining INCHES of that height (number, 0-11; 0 when stated in whole feet).
- numberOfStories: number of storeys of the existing building (number, e.g. 1 or 2).
- dwellingUnits: number of dwelling units in the building (number; 1 for a single-family house).
- numberOfBuildings: number of buildings on the permit (number; 1 unless the plans show more).
- stampRecommendation: one line on whether PE-stamped/sealed structural documentation is present or required (e.g. "PE-sealed structural letter provided — existing framing adequate" / "no stamp present; AHJ may require one"). Base it ONLY on what the documents show.
UTILITY INTERCONNECTION (the utility's NEM / interconnection application, whichever utility it is)
- utilitySchedule: the utility rate schedule / rate plan printed on the bill (e.g. "Schedule 7", "Schedule 4", "R1 Residential", "E-27", "Basic Plan")
- serviceVoltage: service voltage (e.g. "240V")
- servicePhase: "single-phase" or "three-phase"
- numberOfCircuits: number of PV backfeed circuits/strings (number)
- azimuth: array azimuth in degrees (number), tilt: array tilt/pitch in degrees (number), roofSlope: roof slope (e.g. "4:12" or degrees)
- pvArrays: PER-ARRAY breakdown when the plans show MORE THAN ONE roof plane / array / orientation (e.g. "Roof #1: 11 modules, tilt 30, azimuth 265"). Array of objects IN ORDER, one per plane: [{"quantity": 11, "tilt": 30, "azimuth": 265}, ...]; add moduleManufacturer/moduleModel per entry only if planes use different modules. Utility portals need one repeater row per array with its own qty/tilt/azimuth, so extract this whenever the site/roof plan or array schedule lists multiple planes; single-array projects may omit it (scalar azimuth/tilt/moduleQuantity suffice).
- mainServiceRating: main service rating in amps if distinct from busRating
PERMIT PORTAL (Accela / ProjectDox AHJ building+electrical permit)
- parcelNumber: assessor parcel number (APN) / map-tax-lot, if shown on the cover sheet or site plan
- jobValue: project valuation / installed cost in dollars (number), if shown
CLIENT ONBOARDING — the INSTALLER/CONTRACTOR shown on the plan set title block / stamp
  (this is the solar company doing the install, NOT the homeowner). Extract for onboarding a
  client record — these do NOT fill the project's contractor fields (those come from the
  selected client), they're a suggestion to create/match the client:
- contractorCompany: installer/contractor business name
- contractorCcb: the contractor's STATE licence number exactly as the title block prints it, whatever the state calls it (Oregon CCB, Massachusetts/Pennsylvania HIC, Arizona ROC, Texas TDLR/TECL, California CSLB, Nevada NSCB, Florida CVC…; Iowa's electrical contractor licence reads "EL" + 6 digits + a class suffix, e.g. EL123456MA). Omit when none is printed — "N/A" is not a value. A number shaped NN-NNNNNNN is a federal EIN / tax id even when the title block labels it "LICENSE #" — it is NOT a licence; put it in no licence field.
- contractorElectricalLicense: the company's electrical contractor license number (e.g. "C1556")
- contractorMetroCityLicense: metro/city contractor or business license number, if shown (e.g. Portland Metro / city license)
- contractorAddress: contractor business address
- contractorPhone: contractor phone
- contractorEmail: contractor email
- contractorSupervisor: supervising electrician name
- contractorElectricianLicense: the supervising electrician's PERSONAL license number (e.g. "5787S") — distinct from the company electrical license above

NARRATIVE EVIDENCE BLOBS — also include these as fields (value = a short factual summary; cite sheet numbers). These let plan review confirm each required element is shown. Write what the plan set ACTUALLY shows; if an element is absent, say so plainly ("No rapid shutdown note found"):
- electricalCalcText: summarize the SLD/one-line — SLD sheet #, modules→inverter→POI, disconnects/OCPD, busbar/main/PV breaker math (705.12), rapid shutdown (690.12), grounding/bonding, meter/service relationship
- structuralCalcText: roof framing (rafter/truss size & spacing & span), snow/dead/wind loads, attachment/standoff/flashing details, whether stamped engineering is present
- sitePlanNotesText: site/plot plan, roof plan/PV layout, setbacks, north arrow, equipment locations
- roofPlanNotesText: roof planes, fire access pathways/setbacks/ridge gaps, module layout per plane
- labelsText: PV label/placard schedule and directory (690.12 / 705.10)
- projectDescriptionText: one-paragraph scope (size, module/inverter counts, mounting, interconnection)
- locateCalloutText: any utility-locate / call-before-dig (811) callouts on the plan set. If the system is roof-mounted with no underground conduit or excavation, write "No excavation — roof mount only". If a 811 callout or locate note is shown, quote it. Never leave blank.

READING PLAN-SET TEXT (these quirks are common across design vendors — handle them, don't be defeated by them):
- LABELS ARE OFTEN GLUED TO THEIR VALUES with no space, because PDF table cells extract without whitespace: "SYSTEM SIZE10800WATTS DC", "MODULES13Q.PEAK DUO ML-G10+ 400W", "INVERTER(S)27ENPHASE IQ7PLUS-72-2-US", "NUMBER OF MODULES27", "SIZE (kW)10.8", "LBS/SQ.FT2.46". Split the label from the value and read the value.
- UNITS VARY: system size is often given in WATTS, not kW ("10800WATTS DC" -> dcKw 10.8; "4810WATTS AC" -> acKw 4.81). Always return dcKw/acKw in KILOWATTS. A "SYSTEM SPECIFICATIONS" table elsewhere in the set may state "SIZE (kW)" directly — prefer whichever is unambiguous, and make sure the two agree.
- QUANTITY IS OFTEN GLUED TO THE MAKE: "27QCELLS Q.PEAK DUO BLK ML-G10" means moduleQty 27, moduleMake "QCELLS", moduleModel "Q.PEAK DUO BLK ML-G10"; "13ENPHASE IQ7PLUS-72-2-US" means 13 microinverters, pvMicroMake "Enphase", pvMicroModel "IQ7PLUS-72-2-US". A trailing wattage in the module string ("... ML-G10+ 400W", or a lone "400" in the next cell) is moduleWattage.
- PV DEAD LOAD is frequently expressed as a distributed weight in the array/loading table — "LBS/SQ.FT2.46", "DISTRIBUTED LOAD 2.46 PER SQFT" — which IS deadLoad in psf (2.46). Do not confuse it with MODULE WEIGHT (LBS) or SYSTEM WEIGHT (LBS), which are totals, not psf.
- ADDRESS FIELDS CAN RUN TOGETHER, and an assessor parcel number often follows the ZIP with no separator: "32189 CAMINO CALIARITEMECULA, CA 92592959352002" is street "32189 Camino Caliari", city "Temecula", state CA, zip "92592", parcelNumber "959352002". A US ZIP is 5 digits (or 5+4 hyphenated) — never absorb trailing digits into it.
- MULTIPLE ROOF PLANES show as a slashed list: "AZIMUTH(°)180/ 0" or "TILT 18/ 22" means TWO arrays — populate pvArrays with one entry per plane.
- SOME PLAN SETS CARRY NO STRUCTURAL BLOCK AT ALL (common in California, where loads live in a separate stamped structural letter). If snow/wind/dead load/rafter data is not in the documents, OMIT those keys — never infer them from the jurisdiction or from typical values.

Rules:
- Set confidence honestly. lowConfidenceFields means unreadable / guessed / inferred / conflicting (see above) — not "printed once, not double-confirmed".
- Account/meter numbers: only digits you can actually read; never invent or pad. Join spaced account segments (e.g. "65564191-001 4" -> "65564191-0014"); do not drop a trailing check digit.
- Electrical amps come from the PLAN SET (SLD, datasheets) — not the bill. Structural loads come from the STRUCTURAL_LETTER when one is supplied (it is the sealed source of record), otherwise from the plan set's structural notes.
- When a STRUCTURAL_LETTER is present, set stampRecommendation to a one-line statement of what it certifies and whether it is sealed/stamped (e.g. "PE-sealed structural letter provided: existing framing adequate, no upgrades required"). Never claim a stamp that the document does not show.
- SYSTEM ADDITIONS: when the plan set shows an existing PV system, dcKw/acKw and ALL module/inverter/pvMicro/pvArrays fields describe ONLY the NEW equipment being added under this permit — never the existing equipment and never the combined total. E.g. a cover sheet stating "SYSTEM SIZE: 5.280 kW DC" and "COMBINED SYSTEM SIZE: 10.440 kW DC" means dcKw=5.28 and combinedDcKw=10.44. Existing equipment goes ONLY in the existing* fields. Mention the addition (existing + new + combined sizes) in projectDescriptionText.
- Prefer the utility bill for name/address/account, the meter photo for meter number, the plan set for everything else.
- Numbers must be JSON numbers. Return valid JSON only — no prose outside the JSON.`;

    const parts: string[] = [];
    if (input.defaultState) parts.push(`(Default state hint if ambiguous: ${input.defaultState})`);
    if (input.planText?.trim()) parts.push(`=== PLAN_SET ===\n${planTextForExtraction(input.planText)}`);
    const pageImages = input.planPageImages ?? [];
    if (pageImages.length) {
      // What each image was taken to be (the page index read), so the model knows which sheet
      // answers which field — e.g. the module Voc lives on the module datasheet page.
      const roles = pageImages.some((p) => p.label) ? ` (${pageImages.map((p) => `page ${p.page}${p.label ? `: ${p.label}` : ""}`).join("; ")})` : "";
      if (input.planImageMode === "hybrid") {
        parts.push(`=== PLAN_SET (IMAGE-ONLY PAGES) ===\nThis plan set's TEXT layer is read separately. The attached PLAN_SET PAGE images are the set's pages that carry NO text layer — usually equipment datasheets or scans pasted into the PDF as pictures${roles}. Read every field these images state (module Voc / Isc / Voc temperature coefficient and listing agency from the module datasheet; the microinverter's or inverter's maximum DC input voltage and rated output current from its datasheet; anything else the images print). For every field, evidence.source is "plan_set" and evidence.sheet names the page ("page 7") and sheet label if legible. Report only what the images show; a field these pages do not state is simply omitted — never write that the plan set lacks it.`);
      } else {
        parts.push(`=== PLAN_SET (SCANNED) ===\nThis plan set has NO text layer. The attached PLAN_SET PAGE images (pages ${pageImages.map((p) => p.page).join(", ")} of the set${roles || ", chosen as its likely cover/title, site plan, one-line and spec sheets"}) ARE the plan set: read them as the PLAN_SET document. Pages were turned upright where the page index showed the sheet printed sideways. For every field, evidence.source is "plan_set" and evidence.sheet names the page ("page 3") and sheet label if legible. Read the small print of tables (roof description / array table, design criteria, wire and OCPD tables, electrical calculations) closely — per-plane module count, tilt and azimuth go in pvArrays. Read only what the images show; a sheet you were not shown is not "absent".`);
      }
    }
    if (input.utilityBillText?.trim()) parts.push(`=== UTILITY_BILL ===\n${input.utilityBillText.slice(0, 8000)}`);
    if (input.meterText?.trim()) parts.push(`=== METER_PHOTO ===\n${input.meterText.slice(0, 2000)}`);
    if (input.structuralLetterText?.trim()) parts.push(`=== STRUCTURAL_LETTER ===\n${input.structuralLetterText.slice(0, 12000)}`);
    if (!parts.length) {
      return { provider: "claude", fields: {}, lowConfidenceFields: [], notes: "No document text supplied." };
    }

    // Generous budget: every field now carries evidence + several narrative
    // blobs, so the JSON is large. Too small a budget truncates it (unparseable).
    // ONE RETRY on an unreadable response. Intake is a long, expensive pipeline and this
    // call is ~99% of it; a transient upstream error should not cost the operator the whole
    // project. Observed live: the same plan set returned an unparseable response in 1.8s
    // and 6.4s, then extracted cleanly in 88s — i.e. a fast failure is transient, not a
    // property of the document. The retry is bounded at one so a genuinely unparseable
    // response still surfaces promptly rather than doubling the wait repeatedly.
    // THE TURN ENDS WITH THE ASK, NOT WITH THE LAST DOCUMENT. Without this the user turn ended on raw
    // document text (a structural letter's last line, "=== METER_PHOTO === ..."), and on corpus-0924
    // P02 claude-opus-5 CONTINUED the document instead of answering — 3 of 3 attempts, 6 calls,
    // ~$2.10, zero fields. Measured 2026-09-26 (.probe/model-routing/measure-parser, o5-high-endmark):
    // P02 27/27 with it; on six more sets (P01 P05 P10 P13 P15 P16) field-for-field identical to the
    // baseline (168/3/0, installer 54/54), every set in ONE call (baseline: 1 unreadable-response
    // re-send in 8 runs there). Long documents first, the question last.
    parts.push("=== END OF DOCUMENTS ===\nReturn ONLY the JSON object described in the system prompt.");
    const user = parts.join("\n\n");
    const images = pageImages.map((p) => ({ label: `PLAN_SET PAGE ${p.page}${p.label ? ` (${p.label})` : ""} image:`, base64: p.base64, mimeType: p.mimeType }));
    const documentsSeen: Array<ParserFieldEvidence["source"]> = [
      ...(input.planText?.trim() || pageImages.length ? ["plan_set" as const] : []),
      ...(input.utilityBillText?.trim() ? ["utility_bill" as const] : []),
      ...(input.meterText?.trim() ? ["meter_photo" as const] : []),
      ...(input.structuralLetterText?.trim() ? ["structural_letter" as const] : []),
    ];
    //
    // WHAT IS RETRIED (2026-09-26). Only an UNREADABLE RESPONSE that did not already run into the
    // 2x ceiling. Before, the catch re-sent on ANY throw, so it also re-sent:
    //   · an API error instrument() had already retried (and the SDK before it) — up to 4 more attempts;
    //   · a safety refusal — the same bytes refused the same way, paid for twice;
    //   · a 32000-token truncation — re-running it from 16000 repeats both calls for the same cap.
    // EVERY read starts at 32000. A page-image read measured 17,552 output tokens (eight scanned
    // sheets, set A, 2026-09-27); a TEXT read of an installer's full plan set measured 16,470
    // (live intake test, WA, 2026-09-29), with two more at 13,110 and 13,451 — so the earlier
    // "measured 16000" for text was the dev corpus, not production, and a 16000 start truncated,
    // paid ~155 s for the wasted call, then re-ran at 32000 (5.2 min for one step). A larger cap
    // costs nothing unless it is used: only tokens actually written are billed.
    const outBudget = 32000;
    const attempt = async (note: string) => {
      const info: { stopReason?: string | null } = {};
      const text = await this.askLong("extractProjectFields", system, user, outBudget, undefined, images, info);
      try {
        return finalizeExtraction(this.normalizeExtraction(text, note), documentsSeen);
      } catch (err) {
        if (err instanceof LlmUnreadableResponseError) throw new LlmUnreadableResponseError(err.message, info.stopReason ?? null);
        throw err;
      }
    };
    try {
      return await attempt("Could not parse LLM response.");
    } catch (err) {
      if (!(err instanceof LlmUnreadableResponseError) || err.stopReason === "max_tokens") throw err;
      logger.warn("llm", "extractProjectFields response unreadable — retrying once", {
        err: err.message.slice(0, 120),
      });
      return attempt("Could not parse LLM response (retry).");
    }
  }

  /** PAGE INDEX of a plan set from small page images (scannedPlanSet.ts picks the pages to read
   *  from it and validates everything returned — page range, kinds, rotation, caps). Its own route
   *  (modelRouting classifyPlanPages, effort low): inheriting extractProjectFields' high, one real
   *  16-page scan ran away to 24k truncated output tokens. An unreadable answer is an EMPTY index,
   *  and the caller falls back to the position rule. */
  async classifyPlanPages(input: {
    pageImages: Array<{ page: number; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }>;
  }): Promise<PlanPageIndex> {
    if (!input.pageImages.length) return { pages: [] };
    const system = `You index the pages of a residential solar PERMIT PLAN SET from small images of every page. You do not extract project data; you say what each page IS so the right pages can be read at full resolution.

For EVERY page image you are shown, return one entry. Use the sheet's own words: its title block (sheet number such as "PV-2" and sheet name) and, when the set has one, the SHEET INDEX table (usually on the cover). Where the print is too small, judge by what the drawing shows (a roof outline with module rectangles is a site/roof plan; boxes joined by conductors is a one-line; a manufacturer's datasheet layout is a spec sheet).

kind — exactly one of:
  cover          cover / title sheet, project data, system summary, sheet index, vicinity map
  site_plan      site / plot plan, property lines, equipment locations (a site plan that also shows the modules on the roof is still site_plan)
  roof_plan      roof plan / array layout / module layout per roof plane (no property-level site plan)
  attachment     mounting / attachment / racking / flashing DETAILS, roof section
  structural     framing plan, structural calculations, structural letter
  one_line       single-line / three-line / electrical diagram
  calcs          wire / conductor / OCPD sizing, voltage drop, electrical calculations, equipment schedule tables
  labels         placards, warning labels, signage, directory
  module_spec    PV MODULE (panel) datasheet
  inverter_spec  inverter / MICROINVERTER / optimizer datasheet
  battery_spec   battery / energy storage datasheet
  racking_spec   racking / rail / attachment manufacturer datasheet
  other_spec     any other equipment datasheet (combiner, disconnect, gateway, rapid shutdown device)
  certificate    listing / UL / engineering certificate or letter
  notes          general notes only
  other          anything else
  blank          blank or near-blank page
Pages may be scanned sideways or upside down; read them as they are (orientation is settled separately).

Return ONLY JSON of this shape, no prose:
{"pages":[{"page":<page number as labelled>,"sheet":"<sheet number as printed, or \\"\\">","title":"<sheet name as printed, max 60 characters, or \\"\\">","kind":"<kind>"}],"sheetIndex":[{"sheet":"<number>","title":"<name>"}]}
sheetIndex lists the set's own sheet index rows when one is legible; otherwise [].`;
    const user = `The ${input.pageImages.length} page image(s) above are pages ${input.pageImages.map((p) => p.page).join(", ")} of one plan set, in order, each labelled with its page number. Return the JSON page index.`;
    const images = input.pageImages.map((p) => ({ label: `PAGE ${p.page}:`, base64: p.base64, mimeType: p.mimeType }));
    const text = await this.askLong("classifyPlanPages", system, user, 8000, undefined, images);
    const parsed = this.parseJson<{ pages?: unknown; sheetIndex?: unknown }>(text, {});
    const pages = Array.isArray(parsed.pages) ? (parsed.pages as PlanPageIndex["pages"]) : [];
    const sheetIndex = Array.isArray(parsed.sheetIndex) ? (parsed.sheetIndex as NonNullable<PlanPageIndex["sheetIndex"]>) : [];
    return { pages, sheetIndex };
  }

  /** ORIENTATION by comparison (scannedPlanSet.ts validates the answer). Each page arrives four
   *  times, turned 0/90/180/270 degrees clockwise; the model names the version that reads upright.
   *  Asked for an angle instead, the page-index read said "180" for every page of a real scan
   *  whose sheets were 90 degrees sideways. Same route as the page index (low effort). */
  async orientPlanPages(input: {
    pages: Array<{ page: number; versions: Array<{ rotate: 0 | 90 | 180 | 270; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }> }>;
  }): Promise<Array<{ page: number; rotate: number }>> {
    if (!input.pages.length) return [];
    const system = `You settle the orientation of scanned plan-set pages. Each page is shown four times, labelled "PAGE n, turned D°" for D = 0, 90, 180, 270 (the scan turned D degrees clockwise). For each page pick the ONE version in which the sheet's main drawing and its body text read upright — lines of text run left to right, letters stand the right way up. Judge by the bulk of the text and the drawing's labels, not by one small block printed at another angle (title blocks often are).
Return ONLY JSON, no prose: {"pages":[{"page":<n>,"rotate":<the D of the upright version>}]}`;
    const images = input.pages.flatMap((p) => p.versions.map((v) => ({ label: `PAGE ${p.page}, turned ${v.rotate}°:`, base64: v.base64, mimeType: v.mimeType })));
    const user = `Pages ${input.pages.map((p) => p.page).join(", ")}: for each, which turned version reads upright? Return the JSON.`;
    const text = await this.askLong("classifyPlanPages[orient]", system, user, 4000, undefined, images);
    const parsed = this.parseJson<{ pages?: unknown }>(text, {});
    return Array.isArray(parsed.pages) ? (parsed.pages as Array<{ page: number; rotate: number }>) : [];
  }

  // Shared parser for both text and vision extraction results — captures
  // value, confidence, and evidence (provenance) per field.
  private normalizeExtraction(raw: string, parseFailNote: string): ParserLlmExtraction {
    const FAILED = Symbol("parse-failed");
    const parsed = this.parseJson<{
      fields?: Record<string, { value: unknown; confidence?: number; evidence?: { source?: string; sheet?: string; excerpt?: string } }>;
      lowConfidenceFields?: string[];
      uncertainties?: unknown;
      conflicts?: unknown;
      notes?: string;
      [FAILED]?: boolean;
    }>(raw, { fields: {}, lowConfidenceFields: [], notes: parseFailNote, [FAILED]: true });
    // A RESPONSE WE COULD NOT PARSE IS NOT AN EMPTY PLAN SET. Degrading it to
    // `{fields:{}}` made a failed call indistinguishable from "this document says
    // nothing" — observed live: a 1.8s call came back with zero fields and
    // lowConfidence 0, and the caller happily created a project with 13 missing fields
    // and 15 reviewer blockers, with nothing anywhere saying the extraction had failed.
    // Fail loudly instead; the callers already map thrown LLM errors to a real message.
    if (parsed[FAILED]) {
      // Say WHAT came back. Without a sample of the response there is no way to tell a
      // truncation from a refusal from an upstream error, and the operator is left with an
      // unactionable "could not parse". Redacted and capped — this text can contain
      // project data.
      const sample = String(raw || "").trim().slice(0, 200).replace(/\b\d[\d-]{6,}\b/g, "[redacted]") || "(empty response)";
      throw new LlmUnreadableResponseError(`${parseFailNote} The model's response could not be read as JSON — the document was NOT parsed. Response began: ${sample}`, null);
    }

    const fields: ParserLlmExtraction["fields"] = {};
    for (const [key, entry] of Object.entries(parsed.fields || {})) {
      if (!entry || entry.value == null || entry.value === "") continue;
      // STRUCTURED values pass through intact. String() on an array/object yields
      // "[object Object]", and normalizeProject then discards it because it is not an
      // array — so a multi-roof-plane pvArrays (which the prompt explicitly asks for, and
      // which utility portals need one repeater row per entry from) silently collapsed to
      // a single synthesized array. Scalars keep their existing trim.
      const rawValue = entry.value as unknown;
      const structured = typeof rawValue === "object" && rawValue !== null;
      const value = structured
        ? (rawValue as Array<Record<string, unknown>> | Record<string, unknown>)
        : (typeof rawValue === "number" ? rawValue : String(rawValue).trim());
      if (value === "") continue;
      if (Array.isArray(value) && value.length === 0) continue;
      const confidence = typeof entry.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : 0.5;
      const ev = entry.evidence;
      const evidence = ev && (ev.sheet || ev.excerpt || ev.source)
        ? {
            source: evidenceSource(ev.source),
            sheet: ev.sheet ? String(ev.sheet).slice(0, 40) : undefined,
            excerpt: ev.excerpt ? String(ev.excerpt).slice(0, 200) : undefined,
          }
        : undefined;
      fields[key] = { value: value as ParserExtractedField["value"], confidence, evidence };
    }
    const lowConfidenceFields = Array.isArray(parsed.lowConfidenceFields) ? parsed.lowConfidenceFields.filter((f): f is string => typeof f === "string") : [];
    return {
      provider: "claude",
      fields,
      lowConfidenceFields,
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
      uncertainties: normalizeUncertainties(parsed.uncertainties),
      conflicts: normalizeConflicts(parsed.conflicts),
    };
  }

  async extractProjectFieldsFromImages(input: {
    images: { kind: "utility_bill" | "meter_photo" | "plan_page"; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }[];
    defaultState?: string;
  }): Promise<ParserLlmExtraction> {
    if (!input.images.length) {
      return { provider: "claude", fields: {}, lowConfidenceFields: [], notes: "No images supplied." };
    }
    const system = `You read photos/scans of a residential solar customer's electric documents and extract intake fields with MAXIMUM accuracy. These are phone photos, so read carefully — digits matter.

You are shown one or more labeled images:
- UTILITY_BILL: the electric bill. The homeowner name ("owner") is the ACCOUNT HOLDER: the person or business printed in the CUSTOMER name/address block (often beside the service address or above the mailing address). It is NEVER the utility company, its logo/brand, its website or email (e.g. "example-utility.com"), a phone number, its remit-to/payment address block, or a label like "Account Summary". If the customer block is unreadable, omit "owner" rather than guess. Read the homeowner name, full service address, utility company, the ACCOUNT NUMBER exactly as printed, and the meter number from the account-activity table. Account numbers are often shown in spaced segments and formats VARY BY UTILITY (e.g. "65564191-001 4" is ONE account number "65564191-0014"; Pacific Power prints a "002"-style sub-account segment plus a separate check digit, like "12345678 002 X" → "12345678-002X"). Join ALL printed segments in order and never drop a trailing check digit or sub-account segment — a missing segment makes the utility reject the NEM application.
- METER_PHOTO: a photo of the electric meter. Read the meter serial number printed on the face/label (e.g. "78 118 886" -> "78118886"), and the utility (e.g. PacifiCorp = Pacific Power).

Return ONLY JSON: {"fields":{"<id>":{"value":<string|number>,"confidence":<0..1>,"evidence":{"source":"utility_bill|meter_photo","sheet":"<region/label>","excerpt":"<verbatim text read>"}}}, "lowConfidenceFields":[...], "uncertainties":[{"field":"<id>","kind":"unreadable|guessed|inferred|conflicting|unconfirmed","reason":"<one short sentence>"}], "notes":"..."}
Every lowConfidenceFields entry gets an "uncertainties" row saying WHY (a smudged digit, a value inferred from branding, two documents disagreeing).

Include an "evidence" object for every field (where on the document you read it + a short verbatim excerpt) so a human can verify it.

Field ids (omit if not present):
- owner, street, city, state (2-letter), zip
- utility: the utility's common short name as the bill or meter shows it, for ANY US utility (e.g. "Eversource", "Oncor", "SRP", "Penelec"; PacifiCorp -> "Pacific Power"; Portland General -> "PGE"). In a deregulated market (Texas) the retail provider on the bill is not the wires utility on the meter — report the wires/delivery utility and mention the retailer in notes.
- account: the utility account number, digits/dashes EXACTLY as printed
- meter: the meter serial/number, digits only
- servicePeriod: e.g. "Mar 13, 2026 - Apr 13, 2026"
- utilitySchedule: the rate schedule / rate plan printed on the bill (e.g. "Schedule 7", "R1HP Residential", "Basic Plan") — needed for the NEM/interconnection application
Describe only what these images show; never state that a document you were not shown was "not supplied" — the intake page may hold it.

CRITICAL accuracy rules:
- Transcribe account and meter numbers digit-by-digit from the image. Do NOT guess or "correct" them. If a digit is genuinely unreadable, lower confidence and add the field to lowConfidenceFields.
- If both UTILITY_BILL and METER_PHOTO show a meter number, they should match; if they differ, report the clearer one and note the discrepancy.
- Numbers that are identifiers (account, meter, zip) stay strings to preserve leading zeros/segments.
- Return valid JSON only.`;

    const content: Anthropic.Messages.ContentBlockParam[] = [];
    for (const img of input.images) {
      const label = img.kind === "utility_bill" ? "UTILITY_BILL image:" : img.kind === "meter_photo" ? "METER_PHOTO image:" : "PLAN_PAGE image:";
      content.push({ type: "text", text: label });
      content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.base64 } });
    }
    content.push({ type: "text", text: `${input.defaultState ? `(Default state if ambiguous: ${input.defaultState})\n` : ""}Extract the fields now as specified.` });

    const msg = await this.instrument("extractProjectFieldsFromImages", this.routeOf("extractProjectFieldsFromImages"), { images: input.images.length }, (t) =>
      this.client.messages.create({
        model: t.model,
        // Headroom: adaptive thinking shares the output budget, so leave room for the JSON answer.
        max_tokens: 3500,
        thinking: { type: "adaptive" },
        ...(outputConfigFor(t) ? { output_config: outputConfigFor(t) } : {}),
        system: this.cachedSystem(system),
        messages: [{ role: "user", content }],
      }),
    );
    return finalizeExtraction(
      this.normalizeExtraction(this.textOf(msg), "Could not parse vision response."),
      [...new Set(input.images.map((i) => (i.kind === "plan_page" ? "plan_set" : i.kind) as ParserFieldEvidence["source"]))],
    );
  }

  async classifyCorrection(input: { correctionText: string; project?: ProjectRecord }): Promise<{ bucket: CorrectionBucket; confidence: number; notes: string }> {
    const system = `You are a solar permit correction classifier for AHJ (Authority Having Jurisdiction) permit applications.
Classify the correction request into exactly one bucket:
- permit_approval: permit was approved
- permit_correction: application has a fixable error (wrong specs, missing doc, formatting)
- nem_approval: NEM/interconnection was approved
- nem_correction: NEM application needs correction
- status_update: informational update, no action needed
- missing_info_request: AHJ needs more information
- fee_request: payment required
- inspection_final_notice: inspection scheduled or finalized
- spam_irrelevant: not relevant to this project

Return JSON: {"bucket": "<bucket>", "confidence": 0.0-1.0, "notes": "<brief reason>"}`;
    const ctx = input.project ? `Project: ${input.project.homeownerName}, AHJ: ${input.project.ahj}\n\n` : "";
    // THE ONE ROUTE THAT USES THE SDK'S OWN client.messages.parse(). Everywhere else the
    // SDK's client-side parse would throw inside the stream and take the raw text with it;
    // here the output is three small keys that cannot realistically truncate, the call is
    // non-streaming, and the catch lands on the SAME default this route already returned
    // on a parse failure — so the throw is fully contained and we get a typed,
    // enum-validated bucket instead of whatever string came back.
    const fallback = {
      bucket: "C_reviewer_clarification" as CorrectionBucket,
      confidence: 0.3,
      notes: "Parse error — review manually",
    };
    try {
      const msg = await this.instrument("classifyCorrection", this.routeOf("classifyCorrection"), { schema: true }, (t) =>
        this.client.messages.parse({
          model: t.model,
          max_tokens: 2048,
          thinking: { type: "adaptive" },
          output_config: { ...(t.effort ? { effort: t.effort } : {}), format: zodOutputFormat(correctionClassificationSchema) },
          system: this.cachedSystem(system),
          messages: [{ role: "user", content: `${ctx}Correction text:\n${input.correctionText}` }],
        }),
      );
      const out = msg.parsed_output;
      if (!out) return fallback;
      return { bucket: out.bucket as CorrectionBucket, confidence: out.confidence, notes: out.notes };
    } catch (err) {
      logger.warn("llm", "classifyCorrection could not be read", { err: errMsg(err).slice(0, 160) });
      return fallback;
    }
  }

  async draftResponse(input: { correctionText: string; project?: ProjectRecord }): Promise<{ draft: string; confidence: number }> {
    const system = `You are a solar permit specialist drafting a response to an AHJ correction request.
Write a professional, factual response. Be concise. Do NOT invent specifications — only reference what is provided.
IMPORTANT: This is an advisory draft only. A human must review before sending. Note that at the top.
Return JSON: {"draft": "<response text>", "confidence": 0.0-1.0}`;
    const ctx = input.project
      ? `Project details:\n- Homeowner: ${input.project.homeownerName}\n- Address: ${input.project.projectAddress}, ${input.project.city}, ${input.project.state}\n- System: ${input.project.systemSizeDcKw}kW DC\n- AHJ: ${input.project.ahj}\n- Utility: ${input.project.utility}\n\n`
      : "";
    const raw = await this.ask("draftResponse", system, `${ctx}Correction request:\n${input.correctionText}`);
    return this.parseJson<{ draft: string; confidence: number }>(raw, { draft: "", confidence: 0 });
  }

  async visionExtract(input: { imageBase64: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; prompt: string }): Promise<Record<string, unknown>> {
    const msg = await this.instrument("visionExtract", this.routeOf("visionExtract"), { image: true }, (t) =>
      this.client.messages.create({
        model: t.model,
        // Headroom: adaptive thinking shares the output budget.
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        ...(outputConfigFor(t) ? { output_config: outputConfigFor(t) } : {}),
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: input.mimeType, data: input.imageBase64 },
            },
            { type: "text", text: input.prompt },
          ],
        }],
      }),
    );
    const text = this.textOf(msg);
    if (text) return this.parseJson<Record<string, unknown>>(text, { provider: "claude-vision", raw: text });
    return { provider: "claude-vision", confidence: 0 };
  }

  // LLM GENERAL PLAN REVIEW — the hybrid review gate's coverage for work types
  // without a deterministic rule pack (reroof, ADU, water heater, general…), and an
  // optional second opinion beside the solar pack. Vision over rendered plan pages,
  // grounded in the jurisdiction's adopted-codes summary. ALWAYS advisory: the
  // caller maps results to category "ai_review" with severity capped at warning —
  // an AI observation can never block anything.
  async reviewPlanSetGeneral(input: {
    workType: ReviewWorkType;
    jurisdictionLabel: string;
    codeSummary: string;
    verifiedProfile: boolean;
    pageImagesBase64: string[];
    extractedText?: string;
    applicantFacts?: Record<string, string>;
  }): Promise<AiPlanReviewResult> {
    // CACHING: keep the system prompt STATIC (jurisdiction/work-type context
    // moves to the user turn) so every review shares one cached prefix instead
    // of writing a rarely-re-read cache entry per jurisdiction.
    const system = `You are an experienced municipal plans examiner performing a PRE-REVIEW of a permit application plan set. You are ASSISTING a human reviewer, never replacing them: your findings are advisory observations the human confirms against the adopted codes. The user message states the WORK TYPE, JURISDICTION, and the adopted codes / design criteria to ground every citation in; when the criteria are marked UNVERIFIED, phrase every citation as 'verify locally'.

Review the attached plan-sheet images (and extracted text, when provided) the way a plans examiner triages an intake packet:
- COMPLETENESS: are the sheets a reviewer needs present and legible (site plan, structural details, sections, schedules appropriate to this work type)?
- CODE CONFORMANCE SIGNALS: obvious conflicts with the adopted codes/design criteria above (spans, load paths, egress, clearances, setbacks, fire access — whatever this work type implicates). Cite the code FAMILY and SECTION you are relying on.
- MISSING INFORMATION a correction letter would ask for.
Ground every finding in what is actually visible; never invent sheet contents. If the images are unreadable or insufficient, say so in notes rather than guessing.

Return ONLY JSON:
{"findings":[{"title":"<short>","message":"<what a correction letter would say>","severity":"warning|callout","codeFamily":"IRC|IBC|NEC|IFC|IPC|IMC|<state code>","codeSection":"<section>","sheetRef":"<sheet/page if identifiable>"}],
 "summary":"<2-3 sentence overall assessment>",
 "confidence":"low|medium|high",
 "notes":"<caveats: unreadable pages, missing context>"}`;
    const userParts: Anthropic.ContentBlockParam[] = [];
    // Cap pages sent — intake triage reads the key sheets, not a 60-page set.
    for (const b64 of input.pageImagesBase64.slice(0, 8)) {
      userParts.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });
    }
    const factLines = Object.entries(input.applicantFacts ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");
    userParts.push({
      type: "text",
      text: `WORK TYPE: ${input.workType.replace(/_/g, " ")}.
JURISDICTION: ${input.jurisdictionLabel}.
ADOPTED CODES / DESIGN CRITERIA (${input.verifiedProfile ? "verified by the jurisdiction's staff" : "UNVERIFIED — phrase every citation as 'verify locally'"}):
${input.codeSummary || "No adopted-code data available — cite current model codes and say 'verify the locally adopted edition'."}

Applicant facts:\n${factLines || "(none provided)"}\n\nExtracted plan text (may be partial):\n${(input.extractedText || "").slice(0, 6000) || "(none)"}\n\nPerform the pre-review now.`,
    });
    const msg = await this.instrument("reviewPlanSetGeneral", this.routeOf("reviewPlanSetGeneral"), { image: input.pageImagesBase64.length > 0, pages: input.pageImagesBase64.length }, (t) =>
      this.client.messages.create({
        model: t.model,
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        ...(outputConfigFor(t) ? { output_config: outputConfigFor(t) } : {}),
        system: this.cachedSystem(system),
        messages: [{ role: "user", content: userParts }],
      }),
    );
    const parsed = this.parseJson<Partial<AiPlanReviewResult>>(this.textOf(msg), {});
    const findings = (Array.isArray(parsed.findings) ? parsed.findings : [])
      .filter((f) => f && typeof f.title === "string" && typeof f.message === "string")
      .slice(0, 20)
      .map((f) => ({
        title: String(f.title).slice(0, 140),
        message: String(f.message).slice(0, 1200),
        // HARD CAP: an AI observation is never a blocker.
        severity: (f.severity === "callout" ? "callout" : "warning") as "warning" | "callout",
        codeFamily: f.codeFamily ? String(f.codeFamily).slice(0, 24) : undefined,
        codeSection: f.codeSection ? String(f.codeSection).slice(0, 40) : undefined,
        sheetRef: f.sheetRef ? String(f.sheetRef).slice(0, 60) : undefined,
      }));
    return {
      provider: "claude",
      findings,
      summary: String(parsed.summary || "").slice(0, 1500),
      confidence: (["low", "medium", "high"].includes(String(parsed.confidence)) ? parsed.confidence : "low") as "low" | "medium" | "high",
      notes: String(parsed.notes || ""),
    };
  }

  async synthesizeKnowledge(input: {
    ahjName: string;
    state: string;
    utility?: string;
    pastApplicationTexts: string[];
    correctionPatterns: string[];
  }): Promise<{ requiredDocuments: string[]; commonRejectionReasons: string[]; tips: string[]; confidence: "low" | "medium" | "high" }> {
    const system = `You are a solar permitting expert synthesizing institutional knowledge about a specific AHJ (Authority Having Jurisdiction).
Analyze the provided past application samples and correction patterns. Identify:
1. Required documents for this AHJ
2. Common rejection reasons
3. Tips and best practices specific to this AHJ

Return JSON:
{
  "requiredDocuments": ["..."],
  "commonRejectionReasons": ["..."],
  "tips": ["..."],
  "confidence": "low|medium|high"
}
Set confidence based on how many samples you have: <3 samples=low, 3-10=medium, 10+=high.`;
    const userMsg = `AHJ: ${input.ahjName}, State: ${input.state}${input.utility ? `, Utility: ${input.utility}` : ""}

Past application samples (${input.pastApplicationTexts.length}):
${input.pastApplicationTexts.slice(0, 10).map((t, i) => `--- Sample ${i + 1} ---\n${t.slice(0, 800)}`).join("\n")}

Correction patterns observed:
${input.correctionPatterns.slice(0, 20).join("\n")}`;
    const raw = await this.ask("synthesizeKnowledge", system, userMsg);
    return this.parseJson(raw, { requiredDocuments: [], commonRejectionReasons: [], tips: [], confidence: "low" as const });
  }

  async researchAhjRequirements(input: { ahj: string; state: string; utility?: string; knownContext?: string }): Promise<AhjResearchResult & { webGrounded: boolean }> {
    const intro = `You are a solar permitting onboarding specialist. Given an Authority Having Jurisdiction (AHJ) that the system has never processed, lay out what's needed to permit a residential rooftop solar PV system there.`;
    const searchStep = `FIRST search the web — prefer the AHJ's own .gov/.us site and the state's ePermitting/building-department pages — to confirm the real portal, submission method, and document checklist for THIS jurisdiction. Many small/mid Oregon and Washington cities (e.g. City of Hillsboro) do NOT run their own portal — they file building+electrical permits through a shared state system (Oregon ePermitting, which runs on Accela). Identify that correctly rather than inventing a city-specific portal. Ground every field in what you actually find; only fall back to regional norms when the search is inconclusive, and say so in tips.`;
    const body = `Return ONLY JSON:
{
  "portalName": "<the BRANDED portal name as the AHJ refers to it, e.g. 'Oregon ePermitting', 'Portland DevHub', or 'Email/in-person'>",
  "portalPlatform": "<the UNDERLYING software platform/vendor: one of Accela, ProjectDox, EnerGov, MyGov, OpenGov, CityView, Avolve, Tyler, or 'Other'/'None'. IMPORTANT: many branded portals run on a shared platform — e.g. Oregon ePermitting and most Oregon city/county portals run on ACCELA; ProjectDox is Avolve; EnerGov is Tyler. Identify the platform so existing portal automation can be reused.>",
  "portalUrl": "<best-known URL or '' if unsure>",
  "submissionMethod": "<online portal | email | in-person | combination>",
  "requiredDocuments": ["<each document this AHJ typically requires for residential solar — e.g. completed building+electrical permit application, site/plot plan, electrical SLD/one-line, structural/roof framing plan or stamped calcs, module spec, inverter spec, fire access pathway plan, signed owner authorization, etc.>"],
  "commonCorrections": ["<typical plan-review correction reasons for this AHJ/region>"],
  "tips": ["<practical submittal tips: prescriptive vs engineered path, snow/wind load expectations for the region, combo vs separate permits, fees, etc.>"],
  "submissionSteps": ["<ordered steps a coordinator follows to submit here>"],
  "confidence": "low|medium|high"
}

Rules:
- Be specific to the named AHJ and state when you can; otherwise give the standard requirements for that state/region and say so in tips.
- This is ADVISORY and must be human-verified — do NOT invent a precise portal URL you are unsure of (use '' instead).
- Reflect the named utility's interconnection/NEM document needs in requiredDocuments where relevant.
- Return valid JSON only.`;
    const system = `${intro}\n\n${searchStep}\n\n${body}`;
    const userMsg = `AHJ: ${input.ahj}\nState: ${input.state}${input.utility ? `\nUtility: ${input.utility}` : ""}${input.knownContext ? `\n\n${input.knownContext}` : ""}\n\nResearch the residential solar permitting + interconnection requirements for this jurisdiction.`;
    // Web-grounded first (accurate for never-seen AHJs); fall back to model
    // knowledge if the search is unreachable so the call never hard-fails.
    // Grounded means a search RETURNED RESULTS and the answer parsed — see summarizeWebSearch.
    let parsed: Partial<AhjResearchResult> = {};
    let webGrounded = false;
    try {
      const web = await this.askWithWebSearch("researchAhjRequirements", system, userMsg, WEB_RESEARCH_MAX_TOKENS, 5, webResearchBudgetMs());
      const p = this.parseJson<Partial<AhjResearchResult>>(web.text, {});
      if (web.groundedSearches > 0 && p && (p.portalName || (Array.isArray(p.requiredDocuments) && p.requiredDocuments.length))) {
        parsed = p;
        webGrounded = true;
      }
    } catch (err) {
      // A refusal is not "search unreachable": the same request re-asked from memory is refused the
      // same way (or answers what the web pass would not). Surface it; do not pay for a second call.
      if (err instanceof LlmRefusalError) throw err;
      logger.warn("llm", "researchAhjRequirements web search failed — falling back to model knowledge", { err: errMsg(err) });
    }
    if (!webGrounded) {
      const raw = await this.askLong("researchAhjRequirements.fallback", `${intro}\n\n${MODEL_MEMORY_RESEARCH_RULES}\n\n${body}`, userMsg, WEB_RESEARCH_MAX_TOKENS);
      parsed = this.parseJson<Partial<AhjResearchResult>>(raw, {});
    }
    // Model memory never supplies a link: not the portal URL (prepareSubmission's cold start
    // and the KB link sweep would navigate to it), and not one buried in a tip or step.
    const scrub = (s: string): string => (webGrounded ? s : stripUrlsFromModelMemory(s));
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => scrub(String(x))).filter(Boolean) : []);
    return {
      provider: "claude",
      webGrounded,
      portalName: scrub(String(parsed.portalName || "")),
      portalPlatform: String(parsed.portalPlatform || ""),
      portalUrl: webGrounded ? String(parsed.portalUrl || "") : "",
      submissionMethod: String(parsed.submissionMethod || ""),
      requiredDocuments: arr(parsed.requiredDocuments),
      commonCorrections: arr(parsed.commonCorrections),
      tips: arr(parsed.tips),
      submissionSteps: arr(parsed.submissionSteps),
      confidence: (["low", "medium", "high"].includes(String(parsed.confidence)) ? parsed.confidence : "low") as "low" | "medium" | "high",
      needsHumanVerification: true,
      notes: webGrounded
        ? "Researched from the AHJ's official site via web search. Human-verify before relying on it; the first real submittal will confirm/correct these requirements."
        : "Web search was unavailable — researched from model knowledge only. Verify against the AHJ's official site before relying on it.",
    };
  }

  // NARROW DESIGN-CRITERIA LOOKUP for one AHJ whose profile has no ground snow / wind on file
  // (researchJurisdictionCodes asks for everything and came back designCriteria {} for a city
  // whose examiner then bounced a 16 psf plan for 36). Compact on purpose (LLM cost rule): three
  // numbers, each with the page and the sentence it came from. Web-grounded or nothing — a
  // remembered snow load is exactly the false authority a below-ahj warning must not rest on,
  // so there is no model-memory fallback here.
  // PER-JOB PERMIT-PROCESS LOOKUP transport (permitProcessLookup.ts owns the prompt, the parse and
  // every validation). Its own timeout per call, so one aborted part loses one part, not all.
  async webLookup(input: { label: string; system: string; user: string; maxTokens?: number; maxSearches?: number; readPages?: boolean; maxFetches?: number; timeoutMs?: number }): Promise<WebLookupResult> {
    try {
      // readPages: the capped web_fetch beside web_search (max_uses = maxFetches, default the
      // design lookup's 3; each page capped at DESIGN_LOOKUP_MAX_PAGE_TOKENS).
      const fetchTool = input.readPages ? [{ ...designLookupFetchTool(), max_uses: Math.max(1, Math.min(6, input.maxFetches ?? DESIGN_LOOKUP_MAX_FETCHES)) }] : [];
      const web = await this.askWithWebSearch(input.label, input.system, input.user, input.maxTokens ?? WEB_RESEARCH_MAX_TOKENS,
        input.maxSearches ?? 5, input.timeoutMs ?? webResearchBudgetMs(), fetchTool,
        // Every URL the searches returned: the caller checks each cited source against this list, and
        // twelve searches return far more than the default 20.
        400,
        // Every webLookup label (the caller's own, e.g. "permitProcessLookup.process") routes as ONE task.
        "webLookup");
      return {
        text: web.text, groundedSearches: web.groundedSearches, searches: web.searches, stopReason: web.stopReason, resultUrls: web.resultUrls, pagesRead: web.fetches,
        fetchedUrls: web.fetchedUrls, resultTitles: web.resultTitles,
      };
    } catch (err) {
      // A timeout keeps what the search had gathered (the caller still validates every citation
      // against these URLs, and an ungrounded partial is still memory) and says it timed out.
      if (err instanceof WebSearchAbortedError) {
        const p = err.partial;
        return { text: p.text, groundedSearches: p.groundedSearches, searches: p.searches, stopReason: null, resultUrls: p.resultUrls, pagesRead: p.fetches,
          fetchedUrls: p.fetchedUrls, resultTitles: p.resultTitles, error: errMsg(err), timedOut: true };
      }
      return { text: "", groundedSearches: 0, stopReason: null, resultUrls: [], pagesRead: 0, error: errMsg(err) };
    }
  }

  async researchDesignCriteria(input: { ahj: string; state: string }): Promise<DesignCriteriaResearchResult> {
    const userMsg = designCriteriaLookupUserMessage(input);
    let raw = "";
    let grounded = false;
    let truncated = false;
    let fetches = 0;
    try {
      // 5 searches, not 3: measured on 10 AHJs across 8 states, the lookup ran out of searches
      // before it opened the jurisdiction's own table (one reported "cut off by a tool-use limit").
      // 4000 tokens, not 1500: adaptive thinking shares the budget, and a 1800 cap cut one
      // answer's JSON off (stop=max_tokens) so it parsed as "nothing found".
      // + the capped page fetch (designLookupFetchTool) — this lookup only; every other caller of
      // askWithWebSearch is unchanged.
      const web = await this.askWithWebSearch("researchDesignCriteria", DESIGN_CRITERIA_LOOKUP_SYSTEM, userMsg, 4000, 5, webResearchBudgetMs(), [designLookupFetchTool()]);
      raw = web.text;
      grounded = web.groundedSearches > 0;
      // A turn the server paused (tool-use loop limit) is as unfinished as one cut off by max_tokens.
      truncated = web.stopReason === "max_tokens" || web.stopReason === "pause_turn";
      fetches = web.fetches;
    } catch (err) {
      logger.warn("llm", "researchDesignCriteria web search failed", { err: errMsg(err) });
      return { provider: "claude", values: [], webGrounded: false, notes: "Web search failed — nothing looked up." };
    }
    const out = parseDesignCriteriaLookup(this.parseJson<Record<string, unknown>>(raw, {}), grounded, truncated, { ahj: input.ahj, state: input.state });
    return fetches ? { ...out, notes: `${out.notes} Pages read: ${fetches}.`.trim() } : out;
  }

  // ADOPTED-CODES onboarding research (review gate). Targets the code EDITIONS IN EFFECT on a date,
  // per canonical family, with their dates and basis, and — at the state level — how the state
  // adopts each family. Output is saved as confidence "seeded" and a human verifies each claim
  // against its citation before the review gate cites it authoritatively.
  //
  // WEB-GROUNDED OR NOTHING. There is no model-memory fallback here: a remembered edition is exactly
  // the wrong answer this data exists to prevent (production's memory-era rows said "IRC 2023" for
  // Coos Bay — no such edition), and the save path refuses to store one. A call that does not
  // ground returns an empty profile marked model_memory, with the search evidence, and costs no
  // second call.
  async researchJurisdictionCodes(input: JurisdictionCodeResearchInput): Promise<JurisdictionCodeResearchResult> {
    const asOf = /^\d{4}-\d{2}-\d{2}/.test(String(input.asOf || "")) ? String(input.asOf).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const stateLayer = !String(input.ahj || "").trim();
    const families = (input.families ?? []).filter((f) => ["residential", "building", "electrical", "fire", "energy", "mechanical", "plumbing"].includes(f));
    const intro = `You are a building-code analyst for a plan-review tool. Find which code EDITIONS are in effect on ${asOf} for the jurisdiction below${stateLayer ? ", and how the state adopts each code family" : ""}, plus its local design criteria.`;
    const searchStep = `FIRST search the web. Prefer official sources: the state agency that adopts each code (building codes division, fire marshal, electrical board, the state administrative code/register), then the jurisdiction's own building department or municipal code. Every edition must come from a page you found: cite it and quote the words that state it. OMIT what you cannot confirm — an omission is better than a guess. An edition adopted for a FUTURE date, or still proposed, goes in "upcoming", never in adoptedCodes.`;
    const scope = stateLayer
      ? ""
      : families.length
        ? `\n- The state adopts the other families for every AHJ. Research ONLY this jurisdiction's own adopted editions for: ${families.join(", ")}.`
        : `\n- State-adopted editions apply to the city/county unless it adopted its own — report the edition that applies here and say which level adopted it.`;
    const body = `Return ONLY JSON:
{${stateLayer ? `
  "adoptionModel": {"model": "statewide_uniform|statewide_minimum_local_amend|local_adoption|mixed", "byFamily": {"<family>": "<model, only where it differs>"}, "sourceUrl": "<statute/rule saying so>", "quote": "<≤25 words>"},` : ""}
  "adoptedCodes": [{"family": "residential|building|electrical|fire|energy|mechanical|plumbing", "code": "<the jurisdiction's own abbreviation (ORSC, CRC, FBC-R, RCNYS) or the model code (IRC, NEC) when adopted under that name>", "edition": "<year>", "basedOn": "<model code + edition it is built on, e.g. 2021 IRC>", "effectiveDate": "YYYY-MM-DD", "mandatoryDate": "YYYY-MM-DD, first day ONLY this edition may be used (omit if no phase-in)", "previousEdition": "<year>", "sourceUrl": "<page stating it>", "quote": "<≤25 words from that page>"}],${stateLayer ? `
  "upcoming": [{"family": "<family>", "code": "", "edition": "", "basedOn": "", "anticipatedDate": "YYYY-MM-DD", "status": "adopted|filed|in rulemaking|proposed", "sourceUrl": ""}],` : ""}
  "amendments": [{"code": "<family>", "section": "<section if known>", "summary": "<what the state/local amendment changes>", "sourceUrl": "<source>", "check": {"kind": "min_value|max_value|required_text|prohibited", "field": "groundSnowPsf|windSpeedMph|pvDeadLoadPsf|pathwayWidthIn|ridgeSetbackIn|attachmentSpacingIn|planText", "value": <number, or the exact wording>, "unit": "psf|mph|in|ft"} or omit}],
  "designCriteria": {"groundSnowLoadPsf": <number or omit>, "windSpeedMph": <number or omit>, "windExposure": "<B|C|D or omit>", "seismicDesignCategory": "<or omit>", "frostDepthIn": <number or omit>, "sourceUrl": "<the county/city design-criteria page>"},
  "prescriptive": {"hasPrescriptivePath": <true|false — omit ONLY if you genuinely could not tell>, "maxGroundSnowPsf": <number or omit>, "maxPvDeadLoadPsf": <number or omit>, "maxRafterSpacingIn": <number or omit>, "allowedWindExposures": ["<B>","<C>"] or omit, "maxWindSpeedMphExpB": <number or omit>, "maxWindSpeedMphExpC": <number or omit>, "engineerStampOverKwDc": <number or omit>, "sourceUrl": "<the page publishing the prescriptive path>"},
  "citations": [{"label": "<what this source establishes>", "sourceUrl": "<url>"}],
  "confidenceNotes": "<what you could and could not confirm>"
}

Rules:${stateLayer ? `
- Adoption model per family: statewide_uniform = one edition everywhere, localities cannot adopt another; statewide_minimum_local_amend = the state edition applies everywhere and localities may amend it; local_adoption = each city/county adopts its own edition. "mixed" overall when families differ.` : ""}${scope}
- One adoptedCodes entry per family in effect on ${asOf}. During a phase-in (both editions allowed) give the new edition with effectiveDate, mandatoryDate and previousEdition.
- Design criteria (ground snow load, wind, frost depth, seismic) are usually published by the COUNTY/CITY building department; only include numbers you found on such a page.
- THE PRESCRIPTIVE BLOCK IS ABOUT ROOFTOP SOLAR PV SPECIFICALLY. Some states publish a
  prescriptive (no-engineering) rooftop-PV path with printed limits — Oregon's ORSC via BCD
  form 440-5952 is the model: ground snow, PV dead load, rafter/truss spacing, wind exposure
  and design wind speed caps. Many states publish NO such path, and rooftop PV instead goes
  through standard structural review or a product-approval regime (Florida is the common
  example). "hasPrescriptivePath": false is a VALUABLE answer — say it plainly when the
  jurisdiction has no published prescriptive PV path. Never copy Oregon's numbers into
  another state: omit any limit you did not find published for THIS jurisdiction.
- An amendment's "check" makes it comparable with a plan set — give one ONLY when the cited page states it plainly, else omit it: min_value / max_value with a numeric field and its unit (a ground snow minimum, a minimum pathway width or ridge setback, a maximum PV dead load or attachment spacing, a minimum design wind speed); required_text with field "planText" and the exact wording the plans must carry (a required placard); prohibited with field "planText" and the wording a plan would show for the prohibited item (e.g. "roof-mounted disconnect"). Anything else stays a summary with no check.
- This is ADVISORY and will be human-verified — never invent a sourceUrl.
- Return valid JSON only.`;
    const system = `${intro}\n\n${searchStep}\n\n${body}`;
    const userMsg = `Jurisdiction (AHJ): ${input.ahj || "(state-level default)"}\nState: ${input.state}\nAs of: ${asOf}\n\nResearch the code editions in effect${stateLayer ? ", the state's adoption model, announced upcoming editions," : ""} and local design criteria for this jurisdiction.`;
    interface Raw {
      adoptionModel?: Record<string, unknown>; adoptedCodes?: unknown; upcoming?: unknown; amendments?: unknown;
      designCriteria?: Record<string, unknown>; prescriptive?: Record<string, unknown>; citations?: unknown; confidenceNotes?: unknown;
    }
    let parsed: Raw = {};
    let webGrounded = false;
    let evidence: { searches: number; groundedSearches: number; resultUrls: string[]; inputTokens?: number; outputTokens?: number; model: string; stopReason?: string | null } = { searches: 0, groundedSearches: 0, resultUrls: [], model: this.routeOf("researchJurisdictionCodes").model };
    let failure = "";
    try {
      const web = await this.askWithWebSearch("researchJurisdictionCodes", system, userMsg, CODE_RESEARCH_MAX_TOKENS, 6, webResearchBudgetMs());
      evidence = { searches: web.searches, groundedSearches: web.groundedSearches, resultUrls: web.resultUrls, inputTokens: web.inputTokens, outputTokens: web.outputTokens, model: web.model, stopReason: web.stopReason };
      const p = this.parseJson<Raw>(web.text, {});
      const hasCodes = !!p && Array.isArray(p.adoptedCodes) && p.adoptedCodes.length > 0;
      const hasModel = stateLayer && !!p?.adoptionModel && typeof p.adoptionModel === "object";
      if (web.groundedSearches > 0 && (hasCodes || hasModel)) {
        parsed = p;
        webGrounded = true;
      } else {
        failure = web.groundedSearches === 0
          ? `no web search returned results (${web.searches} attempted)`
          : web.stopReason === "max_tokens" ? "the answer was truncated (max_tokens) and did not parse" : "the answer named no adopted code";
      }
    } catch (err) {
      failure = `web search failed: ${errMsg(err)}`;
      logger.warn("llm", "researchJurisdictionCodes web search failed — nothing is recorded (no model-memory fallback for code editions)", { err: errMsg(err) });
    }
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const strv = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const day = (v: unknown): string | undefined => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined);
    const fam = (v: unknown) => (typeof v === "string" && ["residential", "building", "electrical", "fire", "energy", "mechanical", "plumbing"].includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() as CodeFamily : undefined);
    // Only a grounded answer is parsed at all; the helpers keep the old stance anyway.
    const src = (v: unknown): string | undefined => (webGrounded ? strv(v) : undefined);
    const prose = (v: unknown): string | undefined => (webGrounded ? strv(v) : strv(typeof v === "string" ? stripUrlsFromModelMemory(v) : v));
    const d = parsed.designCriteria ?? {};
    const researchNotes = `${webGrounded
      ? "Researched from official sources via web search."
      : `Not web-grounded — nothing recorded (${failure || "no answer"}).`} ${prose(parsed.confidenceNotes) || ""}`.trim();
    const am = (parsed.adoptionModel ?? {}) as Record<string, unknown>;
    const models = ["statewide_uniform", "statewide_minimum_local_amend", "local_adoption", "mixed"];
    const byFamily: Partial<Record<CodeFamily, CodeFamilyAdoptionModel>> = {};
    for (const [k, v] of Object.entries((am.byFamily ?? {}) as Record<string, unknown>)) {
      const f = fam(k);
      if (f && typeof v === "string" && models.includes(v) && v !== "mixed") byFamily[f] = v as CodeFamilyAdoptionModel;
    }
    const adoptionModel: JurisdictionAdoptionModel | undefined = stateLayer && webGrounded && typeof am.model === "string" && models.includes(am.model)
      ? { model: am.model as JurisdictionAdoptionModel["model"], ...(Object.keys(byFamily).length ? { byFamily } : {}), ...(src(am.sourceUrl) ? { sourceUrl: src(am.sourceUrl)!.slice(0, 500) } : {}), ...(strv(am.quote) ? { quote: strv(am.quote)!.slice(0, 300) } : {}) }
      : undefined;
    const upcoming: UpcomingCodeEdition[] = (stateLayer && Array.isArray(parsed.upcoming) ? parsed.upcoming : [])
      .filter((u): u is Record<string, unknown> => !!u && typeof u === "object")
      .map((u) => ({
        family: fam(u.family) as CodeFamily, code: String(u.code || "").slice(0, 40), edition: String(u.edition || "").slice(0, 16),
        ...(strv(u.basedOn) ? { basedOn: strv(u.basedOn)!.slice(0, 120) } : {}),
        ...(day(u.anticipatedDate) ? { anticipatedDate: day(u.anticipatedDate) } : {}),
        ...(strv(u.status) ? { status: strv(u.status)!.slice(0, 40) } : {}),
        ...(src(u.sourceUrl) ? { sourceUrl: src(u.sourceUrl)!.slice(0, 500) } : {}),
      }))
      .filter((u) => u.family && u.code && u.edition)
      .slice(0, 12);
    const profile: JurisdictionCodeProfile = {
      key: "", state: input.state, ahj: input.ahj, confidence: "seeded",
      adoptedCodes: (Array.isArray(parsed.adoptedCodes) ? parsed.adoptedCodes : [])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => {
          const out: CodeEdition = { code: String(c.code || "").slice(0, 24), edition: String(c.edition || "").slice(0, 12) };
          const f = fam(c.family);
          if (f) out.family = f;
          if (strv(c.basedOn)) out.basedOn = strv(c.basedOn)!.slice(0, 120);
          if (day(c.effectiveDate)) out.effectiveDate = day(c.effectiveDate);
          if (day(c.mandatoryDate)) out.mandatoryDate = day(c.mandatoryDate);
          if (strv(c.previousEdition)) out.previousEdition = strv(c.previousEdition)!.slice(0, 16);
          if (prose(c.title)) out.title = prose(c.title);
          if (src(c.sourceUrl)) out.sourceUrl = src(c.sourceUrl)!.slice(0, 500);
          if (strv(c.quote) && webGrounded) out.quote = strv(c.quote)!.slice(0, 300);
          if (prose(c.notes)) out.notes = prose(c.notes);
          return out;
        })
        .filter((c) => c.code && c.edition)
        .slice(0, 16),
      amendments: (Array.isArray(parsed.amendments) ? parsed.amendments : [])
        .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
        .map((a) => {
          // A check only on a CITED amendment of a grounded answer (#145): uncited or unclassifiable
          // ones stay informational, listed for a person to check by hand.
          const check = parseAmendmentCheck(a.check, { cited: webGrounded && !!src(a.sourceUrl) });
          return { code: String(a.code || "").slice(0, 24), section: strv(a.section), summary: String(prose(a.summary) || "").slice(0, 400), sourceUrl: src(a.sourceUrl), ...(check ? { check } : {}) };
        })
        .filter((a) => a.code && a.summary)
        .slice(0, 20),
      designCriteria: {
        groundSnowLoadPsf: num(d.groundSnowLoadPsf),
        windSpeedMph: num(d.windSpeedMph),
        windExposure: strv(d.windExposure),
        seismicDesignCategory: strv(d.seismicDesignCategory),
        frostDepthIn: num(d.frostDepthIn),
        sourceUrl: src(d.sourceUrl),
      },
      // The researched prescriptive block. `hasPrescriptivePath` is read strictly: only a
      // real boolean lands, so "the model didn't say" stays undefined rather than becoming
      // a false that would route every project in the jurisdiction to engineered on silence.
      prescriptive: (() => {
        const pr = (parsed.prescriptive ?? {}) as Record<string, unknown>;
        const exposures = Array.isArray(pr.allowedWindExposures)
          ? pr.allowedWindExposures.map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-D]$/.test(x))
          : undefined;
        return {
          hasPrescriptivePath: typeof pr.hasPrescriptivePath === "boolean" ? pr.hasPrescriptivePath : undefined,
          maxGroundSnowPsf: num(pr.maxGroundSnowPsf),
          maxPvDeadLoadPsf: num(pr.maxPvDeadLoadPsf),
          maxRafterSpacingIn: num(pr.maxRafterSpacingIn),
          allowedWindExposures: exposures && exposures.length ? exposures : undefined,
          maxWindSpeedMphExpB: num(pr.maxWindSpeedMphExpB),
          maxWindSpeedMphExpC: num(pr.maxWindSpeedMphExpC),
          engineerStampOverKwDc: num(pr.engineerStampOverKwDc),
          sourceUrl: src(pr.sourceUrl),
        };
      })(),
      fireSetbacks: [],
      citations: (webGrounded && Array.isArray(parsed.citations) ? parsed.citations : [])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({ label: String(c.label || "").slice(0, 200), sourceUrl: String(c.sourceUrl || "").slice(0, 500) }))
        .filter((c) => c.sourceUrl)
        .slice(0, 20),
      updatedAt: "",
      ...(adoptionModel ? { adoptionModel } : {}),
      ...(upcoming.length ? { upcoming } : {}),
      // Rides on the profile because the callers that persist it (codeProfiles.runCodeResearch,
      // POST /api/code-profiles/research) hand saveResearchedCodeProfile only research.profile;
      // upsert writes it into payload_json so a stored row says how it was researched — with the
      // grounding EVIDENCE (search counts, the result URLs returned, model, tokens).
      researchProvenance: {
        webGrounded, method: webGrounded ? "web_search" : "model_memory", notes: researchNotes.slice(0, 1000), at: new Date().toISOString(),
        searches: evidence.searches, groundedSearches: evidence.groundedSearches,
        ...(evidence.resultUrls.length ? { resultUrls: evidence.resultUrls.slice(0, 20) } : {}),
        model: evidence.model,
        ...(evidence.inputTokens !== undefined ? { inputTokens: evidence.inputTokens } : {}),
        ...(evidence.outputTokens !== undefined ? { outputTokens: evidence.outputTokens } : {}),
      },
    };
    return {
      provider: "claude",
      profile,
      webGrounded,
      needsHumanVerification: true,
      notes: researchNotes,
    };
  }

  async researchUtilityRequirements(input: { utility: string; state: string; ahj?: string; knownContext?: string }): Promise<UtilityResearchResult & { webGrounded: boolean }> {
    const intro = `You are a solar interconnection onboarding specialist. Given an electric UTILITY the system has never processed, lay out what's needed to file a RESIDENTIAL rooftop solar net-metering (NEM) / interconnection application with that utility.`;
    const searchStep = `FIRST search the web — prefer the utility's own customer-generation / interconnection page — to confirm the real application portal (many utilities run PowerClerk), submission method, and document checklist for THIS utility. Ground every field in what you actually find; only fall back to regional norms when the search is inconclusive, and say so in tips.`;
    const body = `Return ONLY JSON:
{
  "portalName": "<the BRANDED interconnection/NEM portal name the utility uses, e.g. 'PowerClerk', 'Customer Generation online application', or 'Email/PDF application'>",
  "portalPlatform": "<the UNDERLYING software platform/vendor: e.g. 'PowerClerk' (Clean Power Research), 'Tyler', 'Salesforce', 'custom', or 'None'. Many utilities share PowerClerk, so existing automation is reusable — only the entry URL + login differ.>",
  "portalUrl": "<the application portal's OWN entry/login URL — where the application is filed (for PowerClerk, the utility's own <tenant>.powerclerk.com login) — or '' if you did not find it. A resource library, program, info, or 'how to apply' page on the utility's website is NOT the portal: leave it out of portalUrl and mention it in tips.>",
  "portalUrlConfirmed": <true only when a page you found shows portalUrl IS the application portal's entry/login page; false otherwise>,
  "submissionMethod": "<online portal | email | mail | combination>",
  "requiredDocuments": ["<each document the utility's NEM/interconnection application requires — e.g. electrical one-line/SLD, site plan, inverter technical specifications / cut sheets, module spec, utility account + meter verification/photo, signed interconnection/customer-generation agreement, labeling photos, commissioning/as-built when required>"],
  "smartInverterSettings": "<how the utility handles smart-inverter settings in its NEM app. Most utilities ask a simple Yes/No: 'Will you use the utility's recommended smart inverter settings?' — answered Yes when the inverter is a UL 1741-SB listed smart inverter. This is a portal answer + an inverter spec-sheet upload, NOT a grid-profile drawing on the plan set. State the utility's specific behavior if known.>",
  "meterAggregation": "<whether/how meter aggregation is offered; for most single-home residential projects this is 'No aggregation'>",
  "acDisconnectRule": "<the utility's AC disconnect rule, e.g. 'lockable AC disconnect within 10 ft of the meter; max AC output permitted without a disconnect varies by service type (e.g. 7.2 kW at 240V single-phase)'>",
  "exportLimitNote": "<export-capacity limit / tier note, e.g. 'systems over 25 kW export are evaluated as Tier 2'>",
  "commonCorrections": ["<typical NEM-application correction reasons for this utility>"],
  "tips": ["<practical filing tips: meter-base/socket requirements, witness test, timelines, fees, PTO process, etc.>"],
  "submissionSteps": ["<ordered steps a coordinator follows in this utility's NEM application>"],
  "confidence": "low|medium|high"
}

Rules:
- Be specific to the named utility and state when you can; otherwise give the standard customer-generation requirements for that region and say so in tips.
- This is ADVISORY and must be human-verified — do NOT invent a precise portal URL you are unsure of (use '' instead).
- When portalPlatform names an interconnection platform (PowerClerk, ConnectTheGrid…), portalUrl must be on that platform's domain (the utility's own tenant); a page on the utility's website is never it.
- For smartInverterSettings, reflect the REAL portal behavior: it is a Yes/No election to use the utility's recommended smart-inverter settings (answer Yes for UL 1741-SB listed inverters) plus an inverter spec/cut-sheet upload — never describe it as a required grid-profile drawing on the plan set.
- Return valid JSON only.`;
    const system = `${intro}\n\n${searchStep}\n\n${body}`;
    const userMsg = `Utility: ${input.utility}\nState: ${input.state}${input.ahj ? `\nAHJ context: ${input.ahj}` : ""}${input.knownContext ? `\n\n${input.knownContext}` : ""}\n\nResearch the residential solar net-metering / interconnection requirements for this utility.`;
    // Web-grounded first; fall back to model knowledge if search is unreachable.
    // Grounded means a search RETURNED RESULTS and the answer parsed — see summarizeWebSearch.
    let parsed: Partial<UtilityResearchResult> = {};
    let webGrounded = false;
    try {
      const web = await this.askWithWebSearch("researchUtilityRequirements", system, userMsg, WEB_RESEARCH_MAX_TOKENS, 5, webResearchBudgetMs());
      const p = this.parseJson<Partial<UtilityResearchResult>>(web.text, {});
      if (web.groundedSearches > 0 && p && (p.portalName || (Array.isArray(p.requiredDocuments) && p.requiredDocuments.length))) {
        parsed = p;
        webGrounded = true;
      }
    } catch (err) {
      if (err instanceof LlmRefusalError) throw err; // see researchAhjRequirements
      logger.warn("llm", "researchUtilityRequirements web search failed — falling back to model knowledge", { err: errMsg(err) });
    }
    if (!webGrounded) {
      const raw = await this.askLong("researchUtilityRequirements.fallback", `${intro}\n\n${MODEL_MEMORY_RESEARCH_RULES}\n\n${body}`, userMsg, WEB_RESEARCH_MAX_TOKENS);
      parsed = this.parseJson<Partial<UtilityResearchResult>>(raw, {});
    }
    // Same rule as the AHJ research: model memory never supplies a link (ahjFormRefresh's
    // dead-link sweep writes research.portalUrl straight into the KB row).
    const scrub = (s: string): string => (webGrounded ? s : stripUrlsFromModelMemory(s));
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => scrub(String(x))).filter(Boolean) : []);
    return {
      provider: "claude",
      webGrounded,
      portalName: scrub(String(parsed.portalName || "")),
      portalPlatform: String(parsed.portalPlatform || ""),
      portalUrl: webGrounded ? String(parsed.portalUrl || "") : "",
      submissionMethod: String(parsed.submissionMethod || ""),
      requiredDocuments: arr(parsed.requiredDocuments),
      smartInverterSettings: scrub(String(parsed.smartInverterSettings || "")),
      meterAggregation: scrub(String(parsed.meterAggregation || "")),
      acDisconnectRule: scrub(String(parsed.acDisconnectRule || "")),
      exportLimitNote: scrub(String(parsed.exportLimitNote || "")),
      commonCorrections: arr(parsed.commonCorrections),
      tips: arr(parsed.tips),
      submissionSteps: arr(parsed.submissionSteps),
      confidence: (["low", "medium", "high"].includes(String(parsed.confidence)) ? parsed.confidence : "low") as "low" | "medium" | "high",
      needsHumanVerification: true,
      notes: (webGrounded
        ? "Researched from the utility's official interconnection page via web search. Human-verify before relying on it; the first real submittal will confirm/correct these requirements."
        : "Web search was unavailable — researched from model knowledge only. Verify against the utility's official interconnection page before relying on it.")
        // The model's own "not the confirmed portal" reaches the write door (issue #31): these notes
        // are otherwise a fixed sentence, so researchSaysPortalUnconfirmed could never fire on them.
        // Fail closed: a URL the model did not say it confirmed is a reference link, not the portal.
        + (webGrounded && parsed.portalUrl && !["true", true].includes((parsed as { portalUrlConfirmed?: unknown }).portalUrlConfirmed as string | boolean) ? ` ${RESEARCH_PORTAL_UNCONFIRMED_NOTE}` : ""),
    };
  }

  async suggestRecipeFieldBindings(input: {
    unbound: Array<{ index: number; action: string; label?: string; value: string }>;
    fieldValues: Record<string, string>;
  }): Promise<Array<{ index: number; field: string | null }>> {
    if (input.unbound.length === 0) return [];
    // Build a combined field reference: description + current value for the recording project.
    const fieldRef: Record<string, string> = {};
    for (const [key, desc] of Object.entries(RECIPE_FIELD_DESCRIPTIONS)) {
      const val = input.fieldValues[key];
      fieldRef[key] = val ? `${desc} (current value: "${val}")` : desc;
    }
    // Also include any snapshot/overlay fields that didn't make the descriptions map.
    for (const [key, val] of Object.entries(input.fieldValues)) {
      if (!fieldRef[key] && val) fieldRef[key] = `(current value: "${val}")`;
    }

    const system = `You are a field-binding assistant for a solar permit automation bot.
For each portal form fill/select interaction, decide if the typed value corresponds to one of the known project/client data fields — even when formatted differently (e.g. "TML INTERNATIONAL LLC" → installerCompanyName).
Return null for portal-specific literal values (dropdown options, status words, fixed portal text) that should NOT be substituted per-project.
Respond with ONLY a valid JSON object: {"bindings":[{"index":N,"field":"fieldKey"|null}]}
One entry per interaction you were given, in the same order. "field" is required — send null
when the value is a portal literal.`;

    const user = `Known project/client fields:
${JSON.stringify(fieldRef, null, 2)}

Unbound portal form interactions to classify:
${JSON.stringify(input.unbound, null, 2)}`;

    const raw = await this.ask("suggestRecipeFieldBindings", system, user, RECIPE_FIELD_BINDINGS_FORMAT);
    // Legacy fallback still accepts the bare top-level array this route used to return —
    // a top-level array is not expressible as an output format, which is why the wire
    // shape moved inside "bindings".
    const structured = this.readStructured(raw, recipeFieldBindingsSchema, "suggestRecipeFieldBindings");
    const suggestions = structured
      ? structured.bindings
      : this.parseJson<Array<{ index: number; field: string | null }>>(raw, []);
    const validKeys = new Set(Object.keys(input.fieldValues));
    return suggestions
      .filter((s) => typeof s.index === "number")
      .map((s) => ({ index: s.index, field: s.field && validKeys.has(s.field) ? s.field : null }));
  }

  async planPortalFields(input: PortalFieldPlanInput): Promise<PortalFieldPlan> {
    const system = `You are filling a government/utility permit portal form for a solar project. Given the FIELDS (fillable inputs, buttons, and navigation links) on the current page and the project's available DATA, decide what to fill, which button navigates to the form (if on a dashboard), which button advances to the next page, and which button is the FINAL SUBMIT.

A SCREENSHOT of the current page may be attached. When it is, the VISIBLE layout is AUTHORITATIVE: read the section headings / wizard-step labels / how controls are grouped directly from the image to decide which block is which (especially homeowner vs installer) and what each control is. The text field list + each field's "section" corroborate the image; if they ever conflict, trust what the screenshot plainly shows.

RECOVERY MODE: if the user message contains a "RECOVERY" field, the automation is STUCK or CYCLING — a prior action looped it back. Treat that directive as top priority: pick a DIFFERENT action than the one implied last time. Never return a navigateIndex that restarts an already-started application (no "New/Start/Building Dept Application" when mid-flow); instead make forward progress on THIS page — fill remaining required fields, Select the correct results row, check the required application-type option, or advance with this page's Continue/Next.

GENERIC FORM-FILLING (works on ANY portal — reason from the LIVE page, not from memorized portal rules):
- Multi-step wizards: on each page fill EVERY field you can confidently map from the project DATA, then return advanceIndex = the form's own "Next"/"Continue"/"Save and continue" button to the next INPUT page. Do not skip an input page, and do NOT set atReview on a page that still has empty required fields.
- SEARCH / LOOKUP boxes (address, parcel, account): enter the most-searchable CORE token, not the full string. For an ADDRESS search, put the street NAME WITHOUT the house number or street-type suffix into the street-name field (e.g. for "925 N Grant St" search "Grant"); put the house number and any leading direction into their own number/direction fields when those exist. Click the Search button ADJACENT to those fields — never a global/header search or a "search my records" control. If a search returns no results, or bounces you to a records LIST / home page, the search did NOT take: re-enter a broader token and search again; do NOT start a new application.
- RESULTS GRID / multiple matches: when a list of results or jurisdictions appears, pick the row matching the project's jurisdictionContext (target AHJ / city / county) and discipline, and put that row's Select link in navigateIndex. The SAME address may appear under several jurisdictions (e.g. a city vs its county) exposing different application-type lists — choose the one matching jurisdictionContext. After selecting, check EXACTLY ONE application type matching the permitDiscipline (a checkbox fill with value "true"); never check multiple. One jurisdiction + one discipline per run.
- COMPUTE buttons ("Calculate", "Recalculate", "Update Totals") only derive values — they are NOT the wizard advance and NOT submit. Do not return them as advanceIndex/finalSubmitIndex; still return the real Next/Continue as advanceIndex.
- DECOY navigation: prefer the form's OWN Next/Continue/Save button. NEVER choose a document/page pager ("Next page", "Previous page", "Page N") or a link that RESTARTS the flow ("New/Start Application") when an application is already begun.

SOLAR DOMAIN DEFAULTS (apply when a REQUIRED field asks and the project DATA / kbContext doesn't specify — these are technology facts, NOT portal-specific rules):
- Equipment: map inverter make/model/qty, module make/model/qty/wattage, and DC/AC system size from project DATA. For an equipment REPEATER (an inverter row + one or more PV-array rows, each with its own model + Qty), map each array's Qty/model to THAT array (arrayNModuleQuantity / arrayNModuleModel); never put a module count into the inverter Qty. If there is one combined module field instead of a repeater, use the totals (moduleQty, moduleModel, moduleMake). A page asking for system technical details is a required INPUT page — fill it, never treat it as review.
- Energy source → Solar; prime mover → Photovoltaic; type → Static Inverter; energy storage → No unless the project has a battery.
- "Recommended / utility smart inverter settings?" Yes/No → Yes for standard UL 1741 SB residential inverters (IQ8, IQ7, SolarEdge HD-Wave, Tesla, etc.); No only if the plans show a non-UL-1741-SB inverter. This is a Yes/No answer, not a plan-set drawing.
- "Are all inverters lab certified (UL 1741 SB)?" Yes/No → Yes for standard UL 1741 SB listed residential inverters (IQ8, IQ7, SolarEdge HD-Wave, Tesla, etc.); No only if the plans show a non-UL-1741-SB inverter.
- Meter aggregation → No; pole-mounted meter → No; limit export capacity → No — unless the project DATA says otherwise.
- AHJ ELIGIBILITY / PARTICIPATION QUESTIONS ("Is this a capital construction project for the City?", "Does this project offer affordable housing benefits?", "Will a Private Provider perform the review and inspections?", "Is this part of a disaster-recovery / block-grant programme?", "Is this a site-specific permit?") → NO, unless the project DATA explicitly says otherwise. These ask whether the job belongs to a special programme. A private residential solar job does not, so Yes asserts something untrue AND unlocks a block of further required fields nothing in the DATA can fill (a City Project number, a Private Provider company). Live: Miami's Additional Options page answered Yes to three of these and turned one blocked page into four.
- More generally, when a required Yes/No has no support in the DATA, prefer the answer that ASSERTS NOTHING and adds no new required fields. "No" is almost always that answer.
- EQUIPMENT ENTRY — always use the searchable pickers, NEVER the "not listed" path. When the page has searchable manufacturer/model dropdowns ("Please select…" comboboxes) for the inverter and PV modules, use them: type the manufacturer/model and pick the matching option. NEVER check a "the proposed PV equipment is not listed" / "equipment is not listed" / "not in the list" / "enter manually" checkbox — checking it HIDES the dropdowns and degrades to plain-text inputs the portal scores as UNLISTED equipment. Leave that checkbox UNCHECKED even if the dropdowns are momentarily empty; the real options load after you type. If you already see a "PV System Specification" repeater with Qty + a model dropdown, that IS the listed path — fill it and do not touch the "not listed" checkbox.
- PV SYSTEM SPECIFICATION REPEATERS (Inverter row + one or more PV Array rows): fill EVERY row from the project data — inverter Qty (inverterQty, the TOTAL inverter/microinverter count) + manufacturer dropdown + model dropdown, then ONE PV Array row PER ARRAY. Per-array data arrives as indexed keys: array1ModuleQuantity/array1Tilt/array1Azimuth, array2ModuleQuantity/array2Tilt/array2Azimuth, … — each PV Array row gets ITS OWN array's module Qty (NOT the project total), manufacturer + model dropdowns, Tilt (degrees), Azimuth (degrees), Tracking ("Fixed" unless the data says otherwise). With no arrayN keys, one row with the total moduleQty + scalar tilt/azimuth is correct.
- REPEATER FLOW: when more arrayN groups remain than PV Array rows on screen, do NOT advance to the next page — return the row-adding control ("Add Array", or the row "Clone" button, "Add Inverter"/"Clone System" for inverters) as the advance click; the page re-scans after it and you fill the new row on the next pass. Repeat until every array has a row, delete unused blank rows if a Delete link exists, and click a "Calculate" button (recompute-totals — the page shows "Needs to be recalculated" until clicked) BEFORE moving on. Only click Next once all arrays are filled and totals calculate cleanly.
- UNLABELED REPEATER CONTROLS: PowerClerk's repeater inputs often extract with generic or missing labels (a bare "Qty", "Please select…" selects, unlabeled Tilt/Azimuth). Use the SCREENSHOT to identify each control's row and column (Inverter row vs PV Array N; Qty | Manufacturer | Model; Tilt | Azimuth | Tracking beneath) and fill them BY INDEX from the matching arrayN data — never skip a repeater control just because its label is empty or generic.
- "Is your disconnect within 10 feet of the utility meter?" (or similar disconnect-location Yes/No) → Yes by default: the plan set's standard detail places the lockable AC disconnect adjacent to the meter. Answer No only when the project data/site plan notes explicitly say the disconnect is remote from the meter.
- For an electrical-services / fee page that lists many capacity tiers (kVA), fill ONLY the renewable-energy / PV tier matching the system's AC rating in kVA (systemSizeAcKw — the inverters' continuous AC output, NOT the DC module nameplate) and leave the other count fields EMPTY (not 0); the agency confirms the tier at intake. If a tier takes a count, it is normally "1"; only a single "total kVA" field takes the kVA number. "Category of Construction" = the STRUCTURE TYPE the system is installed on (a house → the 1-or-2-family-dwelling option), NEVER "Other"/"Solar"; "Type of Work" on an existing building → "Alteration", never "New" (Oregon BCD ePermitting guidance: "Solar is not considered 'Other' under CoC or under ToW").
- SYSTEM ADDITIONS / MODIFICATIONS: when the project DATA carries existing-system fields (hasExistingSystem, existingSystemSizeDcKw, existingInverterMake/Model, nemTariff, …), the application must DISCLOSE the existing system: "existing generation on site?" → Yes; existing size/equipment fields → the existing* keys (existingSystemSizeDcKw, existingInverterMake, existingInverterModel, existingModuleMake, existingModuleModel, existingBatteryMakeModel); "total"/"combined"/"aggregate" system size after the addition → totalSystemSizeDcKw / totalSystemSizeAcKw — NEVER the new-only systemSizeDcKw. Plain "system size" for the NEW equipment being added stays systemSizeDcKw/systemSizeAcKw. Existing NEM agreement/application numbers are sensitive — bind field: "existingNemAgreementNumber" / "existingNemApplicationNumber" only, never a literal.
- A required DATE field with no project value (e.g. an estimated commissioning date) → use todayDate plus a few weeks, formatted MM/DD/YYYY.
- JOB VALUE / VALUATION / ESTIMATED COST / CONSTRUCTION VALUE / "value of work" boxes → field: "declaredValuation" (the declared valuation, the same figure the PDF application states). jobValue / contractAmount are the CONTRACT price the client pays: use them ONLY for a box explicitly labelled contract price / contract amount — never for a Job Value or Valuation box.
- NOTICES / COMPLIANCE ACKNOWLEDGMENTS → AGREE. Operator standing policy: on a page of notices, disclosures, code-compliance statements or acknowledgment checkboxes ("I have read...", "I understand...", "I acknowledge...", "I agree to comply..."), CHECK every required acknowledgment box and continue — these gate entry to the application and a human has authorized agreeing to them. This NEVER extends to the FINAL SUBMIT/attestation-and-file button, payment, or anything that files the application: those remain recorded-only for a human.
- Any REQUIRED (asterisk) Yes/No or dropdown MUST be answered — use these defaults or kbContext rather than leaving it blank.

SENSITIVE FIELDS — never store a literal value; bind the field KEY only (the adapter fills these from the encrypted credential store, not from the recipe):
- Account number ("Account Number"/"Account #") → field: "accountNumber". Meter number ("Meter Number"/"Meter #") → field: "meterNumber". Existing NEM/interconnection agreement or application number → field: "existingNemAgreementNumber" / "existingNemApplicationNumber". Password / SSN → never fill.

HOMEOWNER vs INSTALLER — the #1 cause of a bad fill. Decide WHOSE contact a block is from each field's
"section" (its enclosing heading / wizard-step), NEVER from the field labels — portals reuse IDENTICAL
"Name / Last / Company / Address / Email / Phone" blocks on every step, so the labels can't tell them
apart and ONLY the section can.
- section names a CUSTOMER / PROPERTY OWNER / ACCOUNT HOLDER / SITE OWNER / "Applicant (Customer)" → the
  HOMEOWNER: homeownerFirstName (First/Name), homeownerLastName (Last), homeownerEmail, homeownerPhone,
  street, city, state, zip. Its "Company" field is the HOMEOWNER's company — for a residential project
  this is almost always EMPTY, so LEAVE IT BLANK. NEVER put the installer/contractor company name in a
  customer/owner section.
- section names the INSTALLER / CONTRACTOR / SOLAR COMPANY / PREPARER / SUBMITTER / APPLICANT'S
  REPRESENTATIVE → the INSTALLER: installerContactName (First/Name), installer last name (Last),
  installerCompanyName (Company), installerEmail, installerPhone, installerStreet, ccbLicenseNumber. The
  person preparing/submitting the application is the INSTALLER, not the homeowner.
- "Applicant" alone is AMBIGUOUS: when the section pairs it with Customer / Account Holder / Property
  Owner (e.g. "Applicant (Customer) Information"), Applicant = the HOMEOWNER. Treat "Applicant" as the
  installer ONLY when the section clearly means the submitting contractor/company.
- If a field has no "section", fall back to the page heading / step name in pageTitle/bodyText.
- NEVER cross-fill: installer name/company/email/phone must NEVER land in a homeowner field, or vice
  versa. If a homeowner email/phone is empty, LEAVE IT BLANK — do not substitute installer values.

DASHBOARD / HOME PAGES:
- If isDashboard=true (no fillable inputs — only buttons and navigation links), the bot just logged in and landed on the portal home/dashboard. Your ONLY job is to return "navigateIndex": the index of the link or button that starts a new application / interconnection request / permit application. Look for labels like "New Application", "Start Application", "New Pacific Power Customer Generation Application", "Start New Project", "Apply Now", "Create Application", or a tab/link for the relevant program. Set fills=[], advanceIndex=omit, atReview=false, and ONLY navigateIndex. Do NOT treat any dashboard navigation link as advanceIndex.

HARD SAFETY RULES:
- NEVER choose a pay / payment / fee / checkout / invoice button as "advance", "navigate", or anything to click. Omit it entirely.
- The final submit button is RECORDED ONLY (finalSubmitIndex) and is NEVER clicked — do not put it in advanceIndex.
- "advanceIndex" is ONLY a Next/Continue/Save-and-continue button that goes to the next INPUT page (not the final submit).
- BEWARE DECOY PAGER BUTTONS: some portals render BOTH a form-advance button labeled exactly "Next" (or "Continue", "Save & Continue") AND a header document/page pager labeled "Next page" / "Previous page". The pager does NOT advance the wizard — choosing it leaves the form stuck on the same step. Always prefer the exact "Next"/"Continue" wizard button; NEVER pick "Next page"/"Previous page"/"Page N" as advanceIndex.
- CRITICAL (submit-on-review trap): if this page is a READ-ONLY REVIEW/CONFIRM page (no fillable inputs — only a summary of previously entered data + Edit links, or body text like "Step N: Review" / "review all information" / "(read-only)"), OR it pairs a terms/certification acknowledgment with a submit-intent button, then set atReview=true and treat the primary submit-intent button (even if labeled "Continue Application"/"Continue"/"Submit"/"Finish") as the finalSubmitIndex — NEVER as advanceIndex. On many portals the same button advances on input pages but SUBMITS on the review page. When in doubt and there are no fields to fill, STOP (atReview=true) and record the button as final submit.
- Prefer binding a field to a reusable project-field KEY (the "field" property, e.g. "homeownerName") over a literal value, so the recipe generalizes. Only use a literal "value" for fixed dropdown selections/portal-specific choices.
- Do NOT fill a field you can't confidently map. Leave it out.
- FILE UPLOADS: ignore file-input fields (fieldType "file") entirely — do NOT put them in "fills". The bot attaches the correct split document (SLD, site plan, inverter spec, meter photo, etc.) to each upload control automatically. Still return "advanceIndex" for the Next/Continue button on an upload page so the form proceeds.
Return ONLY JSON. EVERY key below is required — where you have no answer send null (for the
index keys) or an empty array/string; never omit a key:
{"fills":[{"index":<field index>,"value":"<string>","field":"<projectFieldKey, or null for a portal-specific literal>"}],
 "navigateIndex": <index of dashboard nav link, or null>,
 "advanceIndex": <index, or null>, "finalSubmitIndex": <index, or null>,
 "atReview": <true if this is the review/confirm screen>, "confidence":"low|medium|high", "notes":"<short>"}`;
    const user = JSON.stringify({
      url: input.url, pageTitle: input.pageTitle, fields: input.fields,
      bodyText: input.bodyText.slice(0, 2000), projectFields: input.projectFields,
      alreadyFilledLabels: input.alreadyFilledLabels,
      // isDashboard must be in the user message so the LLM actually sees it.
      ...(input.isDashboard ? { isDashboard: true } : {}),
      ...(input.kbContext ? { kbContext: input.kbContext } : {}),
      ...(input.jurisdictionContext ? { jurisdictionContext: input.jurisdictionContext } : {}),
      ...(input.recoveryHint ? { RECOVERY: input.recoveryHint } : {}),
    });
    let parsed: Partial<PortalFieldPlan> = {};
    // Use askLong: planning responses can be large (many fills + notes).
    try {
      // Vision-assisted planning when a page screenshot is supplied: the model SEES the section
      // headings/layout (authoritative for who-owns-which-block) instead of guessing from labels.
      // 8192 output budget: a field-heavy page (equipment repeaters, 40+ fills) truncated at
      // 4096 in a real PGE run → an unparseable plan → a silent stall. askLong also retries
      // once at 2× on max_tokens. Accuracy over speed.
      const label = input.screenshotBase64 ? "planPortalFields.vision" : "planPortalFields";
      // MEASURE THE PROMPT THE $10 WARNING IS ABOUT. CLAUDE.md: "the planner gets a
      // compact designNotesDigest, NOT raw parser text … regressing this costs ~$10
      // per run" — and nothing measured it, so the regression would arrive as a
      // bill. `chars` in the call log is not the number: tokens are what is billed,
      // and 18-80 planner calls multiply whatever this is.
      await this.countPlannerPrompt(label, system, user);
      const raw = input.screenshotBase64
        ? await this.askLongWithImage(label, system, user, input.screenshotBase64, "image/png", 8192, PORTAL_FIELD_PLAN_FORMAT)
        : await this.askLong(label, system, user, 8192, PORTAL_FIELD_PLAN_FORMAT);
      // Schema-constrained first; the tolerant parseJson stays as the net for the two
      // things a response schema cannot prevent (max_tokens truncation, a refusal).
      // The schema carries explicit nulls where PortalFieldPlan uses optionals — mapped
      // here, so every post-filter below (pay/submit guards, empty-plan warning) is
      // untouched and behaves identically on both paths.
      const structured = this.readStructured(raw, portalFieldPlanSchema, label);
      parsed = structured
        ? {
            fills: structured.fills.map((f) => ({ index: f.index, value: f.value, ...(f.field ? { field: f.field } : {}) })),
            navigateIndex: structured.navigateIndex ?? undefined,
            advanceIndex: structured.advanceIndex ?? undefined,
            finalSubmitIndex: structured.finalSubmitIndex ?? undefined,
            atReview: structured.atReview,
            confidence: structured.confidence,
            notes: structured.notes,
          }
        : this.parseJson<Partial<PortalFieldPlan>>(raw, {});
    } catch (err) {
      // SAY WHY. A bare `catch {}` here turned every planner failure — a bad request, a
      // 400 on the response schema, an auth error — into the same empty plan the warning
      // below calls "truncated or unparseable", and the learn loop just span. The error
      // is still swallowed (an empty plan is the correct degradation), but it is no
      // longer invisible.
      logger.warn("llm", "planPortalFields call failed — planning this page produced nothing", {
        url: input.url || "page", err: errMsg(err).slice(0, 300),
      });
      parsed = {};
    }
    // Safety post-filter: never let a pay/fee button through as advance/submit, and drop
    // a finalSubmit that was mistakenly set as advance.
    const labelOf = (i?: number) => (i == null ? "" : input.fields.find((f) => f.index === i)?.label || "");
    let advanceIndex = typeof parsed.advanceIndex === "number" ? parsed.advanceIndex : undefined;
    let finalSubmitIndex = typeof parsed.finalSubmitIndex === "number" ? parsed.finalSubmitIndex : undefined;
    let navigateIndex = typeof parsed.navigateIndex === "number" ? parsed.navigateIndex : undefined;
    if (advanceIndex != null && (PORTAL_PAY_RE.test(labelOf(advanceIndex)) || PORTAL_SUBMIT_RE.test(labelOf(advanceIndex)))) advanceIndex = undefined;
    if (finalSubmitIndex != null && PORTAL_PAY_RE.test(labelOf(finalSubmitIndex))) finalSubmitIndex = undefined;
    if (navigateIndex != null && PORTAL_PAY_RE.test(labelOf(navigateIndex))) navigateIndex = undefined;
    const fills = Array.isArray(parsed.fills)
      ? parsed.fills.filter((f) => typeof f.index === "number" && typeof f.value === "string").map((f) => ({ index: f.index, value: String(f.value), field: f.field ? String(f.field) : undefined }))
      : [];
    // Diagnose a silent stall: a truncated/unparseable response degrades to an EMPTY plan (no
    // fills, no advance/navigate/submit, not atReview), which looks identical to "the planner
    // chose to do nothing" and leaves the learn loop spinning. Log a distinct marker so the
    // operator can tell a parse failure from a genuine no-op.
    if (!fills.length && advanceIndex == null && navigateIndex == null && finalSubmitIndex == null && !parsed.atReview) {
      logger.warn("llm", "planPortalFields produced no actionable plan — response may have been truncated or unparseable", { url: input.url || "page", fieldsSeen: input.fields.length, hadScreenshot: Boolean(input.screenshotBase64) });
    }
    return {
      fills,
      advanceIndex,
      navigateIndex,
      finalSubmitIndex,
      atReview: Boolean(parsed.atReview),
      confidence: (["low", "medium", "high"].includes(String(parsed.confidence)) ? parsed.confidence : "low") as "low" | "medium" | "high",
      notes: String(parsed.notes || ""),
    };
  }

  async verifyPortalFill(input: PortalFillVerifyInput): Promise<PortalFillVerification> {
    const system = `You verify that a solar permit portal form was filled CORRECTLY before the recorded recipe is trusted for reuse. Compare each review-screen field/value against the project's authoritative DATA. A value is OK if it matches the corresponding project datum (allowing formatting differences) or is a fixed portal literal (a dropdown choice, label, units). Flag any value that contradicts the project data.
Return ONLY JSON:
{"matches":[{"label":"<field>","expected":"<project value or '(literal)'>","found":"<review value>","ok":<bool>}],
 "overallConfidence":"low|medium|high",
 "accurate": <true ONLY if every data-bearing field matches and nothing contradicts the project — this gates trusting the recipe>,
 "issues":["<short issue>"], "notes":"<short>"}`;
    const user = JSON.stringify({ reviewFields: input.reviewFields, projectFields: input.projectFields, bodyText: input.bodyText.slice(0, 1500) });
    let parsed: Partial<PortalFillVerification> = {};
    try {
      const raw = await this.ask("verifyPortalFill", system, user, PORTAL_FILL_VERIFICATION_FORMAT);
      parsed = this.readStructured(raw, portalFillVerificationSchema, "verifyPortalFill")
        ?? this.parseJson<Partial<PortalFillVerification>>(raw, {});
    } catch { parsed = {}; }
    const matches = Array.isArray(parsed.matches)
      ? parsed.matches.map((m) => ({ label: String(m.label || ""), expected: String(m.expected || ""), found: String(m.found || ""), ok: Boolean(m.ok) }))
      : [];
    // Defense in depth: never report "accurate" if any match is not ok.
    const accurate = Boolean(parsed.accurate) && matches.every((m) => m.ok) && matches.length > 0;
    return {
      matches,
      overallConfidence: (["low", "medium", "high"].includes(String(parsed.overallConfidence)) ? parsed.overallConfidence : "low") as "low" | "medium" | "high",
      accurate,
      issues: Array.isArray(parsed.issues) ? parsed.issues.map((i) => String(i)) : [],
      notes: String(parsed.notes || ""),
    };
  }

  async verifyPortalFillVision(input: PortalFillVisionVerifyInput): Promise<PortalFillVerification> {
    const system = `You are a QA agent verifying that a solar permit portal was filled correctly. You will be shown a screenshot of the review/confirm screen. Compare what you see against the project's authoritative data. Flag any mismatch.
Solid pink/magenta rectangles are DELIBERATE masks over secrets (utility account / meter numbers) the automation typed and must not show you: never list them as a match, a mismatch or an issue.
Return ONLY JSON:
{"matches":[{"label":"<field>","expected":"<project value>","found":"<value on screen>","ok":<bool>}],
 "overallConfidence":"low|medium|high",
 "accurate": <true ONLY if every data-bearing field matches the project data>,
 "issues":["<short issue>"], "notes":"<short>"}`;
    const mimeType = input.mimeType ?? "image/png";
    const user = [
      { type: "image" as const, source: { type: "base64" as const, media_type: mimeType, data: input.screenshotBase64 } },
      { type: "text" as const, text: JSON.stringify({ reviewFields: input.reviewFields, projectFields: input.projectFields, bodyText: input.bodyText.slice(0, 800) }) },
    ];
    let parsed: Partial<PortalFillVerification> = {};
    try {
      const msg = await this.instrument("verifyPortalFillVision", this.routeOf("verifyPortalFillVision"), { image: true, schema: true }, (t) =>
        this.client.messages.create({ model: t.model, max_tokens: 3072, thinking: { type: "adaptive" }, output_config: outputConfigFor(t, PORTAL_FILL_VERIFICATION_FORMAT)!, system: this.cachedSystem(system), messages: [{ role: "user", content: user }] }),
      );
      const raw = this.textOf(msg);
      parsed = this.readStructured(raw, portalFillVerificationSchema, "verifyPortalFillVision")
        ?? this.parseJson<Partial<PortalFillVerification>>(raw, {});
    } catch { parsed = {}; }
    const matches = Array.isArray(parsed.matches)
      ? parsed.matches.map((m) => ({ label: String(m.label || ""), expected: String(m.expected || ""), found: String(m.found || ""), ok: Boolean(m.ok) }))
      : [];
    const accurate = Boolean(parsed.accurate) && matches.every((m) => m.ok) && matches.length > 0;
    return {
      matches,
      overallConfidence: (["low", "medium", "high"].includes(String(parsed.overallConfidence)) ? parsed.overallConfidence : "low") as "low" | "medium" | "high",
      accurate,
      issues: Array.isArray(parsed.issues) ? parsed.issues.map((i) => String(i)) : [],
      notes: String(parsed.notes || ""),
    };
  }

  // Ask with the server-side web search tool enabled (used as the spec-lookup fallback).
  //
  // Returns HOW MANY SEARCHES RAN and HOW MANY RETURNED RESULTS alongside the text, because
  // "the tool was offered" is not "the answer came from the web". Every caller that labels its
  // result grounded must decide from `groundedSearches` (see summarizeWebSearch), not from
  // whether the JSON parsed and not from the bare search count.
  // `extraTools`: server tools offered beside web_search (only the design-criteria lookup passes one —
  // the capped web_fetch); empty for every other caller, whose request is unchanged.
  private async askWithWebSearch(label: string, systemPrompt: string, userMessage: string, maxTokens = 1024, maxUses = 3, timeoutMs = 45000, extraTools: Array<Record<string, unknown>> = [], resultUrlCap = 20, task?: LlmTask): Promise<{ text: string; searches: number; groundedSearches: number; fetches: number; fetchedUrls: string[]; stopReason: string | null; resultUrls: string[]; resultTitles: Record<string, string>; inputTokens?: number; outputTokens?: number; model: string }> {
    // Hard timeout so a stalled web search can never hang the HTTP request (the
    // "Find official form" button would otherwise spin forever). On timeout we
    // abort the stream; callers catch and fall back (no URLs / model knowledge).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const route = this.routeOf(label, task);
    let answeredBy = route.model;
    const live: { stream?: { currentMessage?: unknown } } = {};
    try {
      const msg = await this.instrument(label, route, { chars: userMessage.length, maxTokens, webSearch: maxUses, timeoutMs, ...(extraTools.length ? { extraTools: extraTools.map((t) => String(t.name)) } : {}) }, (t) => {
        answeredBy = t.model;
        const oc = outputConfigFor(t);
        return this.streamFinal(
          t,
          {
            model: t.model,
            max_tokens: maxTokens,
            thinking: { type: "adaptive" },
            ...(oc ? { output_config: oc } : {}),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxUses }, ...extraTools] as any,
            system: this.cachedSystem(systemPrompt),
            messages: [{ role: "user", content: this.withAdvisorNudge(t, userMessage) }],
          },
          { signal: controller.signal },
          (st) => { live.stream = st; },
        );
      });
      const { searches, groundedSearches } = summarizeWebSearch(msg);
      if (groundedSearches) logger.debug("llm", `  ${label} web_search ran`, { queries: searches, withResults: groundedSearches });
      else if (!searches) logger.warn("llm", `  ${label} returned without running a single web search — its answer is model memory`);
      else logger.warn("llm", `  ${label} ran ${searches} web search(es) but none returned results we can see (errored, empty, or no web_search_tool_result block) — treating its answer as model memory`);
      const fetches = countWebFetches(msg);
      if (extraTools.length) logger.debug("llm", `  ${label} web_fetch`, { pagesRead: fetches });
      const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      return {
        text: this.textOf(msg), searches, groundedSearches, fetches, fetchedUrls: webFetchResultUrls(msg),
        stopReason: (msg as { stop_reason?: string | null }).stop_reason ?? null,
        resultUrls: webSearchResultUrls(msg, resultUrlCap),
        resultTitles: webSearchResultTitles(msg, resultUrlCap),
        inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined,
        outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined,
        model: answeredBy,
      };
    } catch (err) {
      // OUR timeout fired: what the stream had gathered by then is evidence, not noise (issue #9 —
      // PNM's lookup ran its searches for 240s and every result was thrown away with the abort).
      if (controller.signal.aborted) throw new WebSearchAbortedError(errMsg(err), partialWebSearchOf(live.stream?.currentMessage));
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async lookupInverterSpec(input: { inverterModel: string; inverterQty?: number; acNameplateKw?: number; serviceVoltageV?: number }): Promise<InverterSpecLookup> {
    const model = String(input.inverterModel || "").trim();
    const qty = input.inverterQty && input.inverterQty > 0 ? Math.round(input.inverterQty) : 1;
    const empty = (notes: string, source = ""): InverterSpecLookup => ({
      provider: "claude", inverterModel: model, inverterQty: qty,
      outputCurrentA: null, outputVa: null, totalContinuousCurrentA: null, derivedPvBreakerA: null,
      confidence: "low", source, notes, needsHumanVerification: true,
    });

    // 1. Built-in equipment table — instant, exact for Tesla/Enphase/SolarEdge part
    //    numbers + common models. No network round-trip needed.
    const known = model ? lookupKnownInverter(model) : null;
    if (known) {
      return buildInverterResult({
        model, qty, perUnitA: known.outputCurrentA, perUnitVa: known.outputVa,
        confidence: "high", source: "built-in equipment table",
        notes: `${known.label}. ${known.note || ""}`.trim(),
      });
    }
    if (!model && !(Number(input.acNameplateKw) > 0)) {
      return empty("No inverter model provided — enter the inverter/microinverter model first (or the AC system size to derive it).");
    }

    const system = `You are a solar PV equipment datasheet expert. Given an inverter or microinverter MODEL or manufacturer PART NUMBER, return its rated CONTINUOUS AC output from datasheet knowledge.
Return ONLY JSON:
{"outputCurrentA": <number|null — per-unit rated continuous AC output current in amps>,
 "outputVa": <number|null — per-unit rated continuous AC output power in VA or W>,
 "confidence": "low|medium|high",
 "notes": "<short note: full model name, voltage basis, any caveat>"}
Notes:
- Some manufacturers (e.g. Tesla) publish PART NUMBERS rather than friendly model names (Tesla string inverter part 1538000 = 7.6 kW / 31.7 A @ 240 V; Powerwall 3 = 11.5 kVA / 48 A).
- For microinverters return the PER-UNIT rating (the caller multiplies by quantity).
- Use the MAXIMUM CONTINUOUS output (not peak). Set confidence "low" and outputCurrentA null only if you genuinely can't identify it — do NOT guess a wrong number.`;

    let parsed: { outputCurrentA?: number; outputVa?: number; confidence?: string; notes?: string } = {};
    let source = "model knowledge";
    let refused = false;
    if (model) {
      try {
        // EFFORT "low", AND THE ESCALATION BELOW IS WHY IT IS SAFE.
        //
        // This is recall of one number off one datasheet — not a route that has to
        // reconcile anything — and it is the only call in this file whose answer is
        // CHECKED before it is used: outputCurrentA null or confidence "low" falls
        // through to the web-search pass, and a web pass that finds nothing falls
        // through to resolveInverterOffline. A weaker first pass therefore cannot
        // produce a wrong number, only a cheap escalation.
        //
        // Measured (claude-opus-5, 2026-09-15, four real models — Enphase
        // IQ8A-72-2-US, SolarEdge SE7600H-US, SMA Sunny Boy 7.7-US-41, Tesla part
        // 1538000): unset/default 933 output tokens, high 924, medium 721, low 531.
        // Every model returned the SAME amps/VA at all four settings. 43% fewer
        // output tokens for an identical answer on the cases we could check.
        // (The "low" now lives in modelRouting.ROUTE_TABLE.lookupInverterSpec, with this measurement.)
        parsed = this.parseJson(await this.ask("lookupInverterSpec", system, `Model / part number: ${model}`), {});
      } catch (err) { parsed = {}; refused = err instanceof LlmRefusalError; }

      // Web fallback when knowledge is unsure/unknown — search the manufacturer datasheet
      // AND the part number, with more uses for an exhaustive look. Not after a REFUSAL: the same
      // question re-asked with a search is declined the same way; the nameplate derivation below
      // is correct by construction and costs nothing.
      if (!refused && (parsed.outputCurrentA == null || parsed.confidence === "low")) {
        try {
          const web = await this.askWithWebSearch(
            "lookupInverterSpec.web",
            `${system}\nSearch the web thoroughly for the official manufacturer datasheet for this EXACT model OR part number, then return the JSON. Try the manufacturer's site, distributor spec pages, and the part number itself. Put the datasheet URL in "notes".`,
            `Find the rated continuous AC output current (amps) for inverter model/part number: ${model}`,
            1500,
            6,
          );
          const webParsed = this.parseJson<typeof parsed>(web.text, {});
          // "web search" is a claim about where the number came from. With zero searches this
          // is the same model memory that just answered "low"/unknown, re-asked — adopting it
          // would promote an unsure recall to a sourced one. Fall through to the nameplate
          // derivation (resolveInverterOffline) instead, which is correct by construction.
          if (webParsed.outputCurrentA != null && web.groundedSearches > 0) { parsed = webParsed; source = "web search"; }
        } catch (err) {
          logger.warn("llm", "lookupInverterSpec web fallback failed", { model, err: errMsg(err) });
        }
      }
    }

    const perUnitA = Number(parsed.outputCurrentA);
    if (!Number.isFinite(perUnitA) || perUnitA <= 0) {
      // 3. Final fallback — derive from the AC nameplate (the inverter's continuous output
      //    IS the AC nameplate). This is what makes "in-depth search" always land a number.
      const offline = resolveInverterOffline(input);
      if (offline && offline.outputCurrentA != null) return offline;
      return empty(`Could not determine a rated output for "${model}". Enter the value from the inverter datasheet/SLD manually, or set the AC system size so it can be derived.`, source);
    }
    return buildInverterResult({
      model, qty, perUnitA,
      perUnitVa: Number.isFinite(Number(parsed.outputVa)) ? Number(parsed.outputVa) : null,
      confidence: (["low", "medium", "high"].includes(String(parsed.confidence)) ? parsed.confidence : "medium") as "low" | "medium" | "high",
      source,
      notes: String(parsed.notes || ""),
    });
  }

  async findAhjFormUrl(input: { ahj: string; state: string; formType?: string; knownContext?: string }): Promise<AhjFormUrlResult> {
    const formType = input.formType || "permit_application";
    const system = `You are a solar permitting research assistant. Find the OFFICIAL blank ${formType.replace(/_/g, " ")} PDF form that the named Authority Having Jurisdiction (AHJ) uses for residential rooftop solar PV permits.

HOW TO SEARCH (do this thoroughly — these forms are usually easy to find):
1. Search for the AHJ's permitting / building-department "Forms & Applications" or "Permitting Center" page on its own .gov/.us site (e.g. "<AHJ> permitting center forms applications", "<AHJ> building permit application pdf", "<AHJ> electrical permit application pdf").
2. From the search results, pull the DIRECT links to the blank building permit application AND the electrical permit application documents (residential solar usually needs BOTH a BLD and an ELE permit). Always report the forms/applications page itself in formsPageUrl — that page is read separately and the document links on it are checked.
3. Return every blank-form document link you find, best/most-relevant first.

STATE SCOPE — many towns share a name across states (Monroe is in Oregon, Michigan, Connecticut, Ohio…; Salem in Oregon and Massachusetts). EVERY web_search query MUST name the AHJ's state by its full name AND its two-letter abbreviation (start from the queries the request lists). A result for a same-named place in ANOTHER state is not this AHJ: do not spend a search following it and never report its URLs. If a search returns only other-state results, make the next query narrower (add the county, or the AHJ's own .gov / .us site) — never broader.

Return ONLY JSON:
{
  "formName": "<the official form's title (or 'Building + Electrical permit applications')>",
  "candidateUrls": ["<direct https URL(s) that download a blank form document, best first — only URLs you actually found: a .pdf link, or a document-center / file-view link with no extension (e.g. /DocumentCenter/View/<id>/<name>, /home/showpublisheddocument/<id>)>"],
  "formsPageUrl": "<the AHJ forms/applications landing page on the AHJ's own site, or ''>",
  "submissionMethod": "<email | online portal | in-person | combination — how this AHJ takes the completed application, if stated>",
  "submittalPortalUrl": "<the URL of the actual submittal PORTAL where the completed application is uploaded/entered, if there is one (login/landing page), else ''>",
  "portalPlatform": "<which platform the submittal portal runs on, if identifiable: 'Oregon ePermitting' (Accela), 'Portland Portal' (City of Portland Development Hub), 'ProjectDox' (Avolve), 'Email', or 'Other'>",
  "submittalRequirements": "<any AHJ-specific submittal requirements posted on the site — e.g. 'email BLD+ELE apps + plan set as one PDF to permits@city.gov', 'register in ProjectDox after intake', required cover sheet, fee handling>",
  "permitStructure": "<'combo' if ONE combined building+electrical permit covers residential solar, 'separate' if distinct BUILDING and ELECTRICAL permits must BOTH be filed, or 'unknown'>",
  "confidence": "low|medium|high",
  "notes": "<which site it came from; any caveat>"
}
Context — in Oregon/SW-Washington the submittal almost always lands in one of these, so identify which:
- Oregon ePermitting (Accela) — the shared state portal most OR cities/counties use.
- Portland Portal — City of Portland's own Development Hub.
- ProjectDox (Avolve) — electronic plan review many cities route into after intake.
- Email — the completed application + plan set is emailed to a permit-center address.
Rules:
- ONLY return URLs you actually located via search — never fabricate a URL.
- If the AHJ truly submits exclusively through an online portal with NO downloadable PDF, return an empty candidateUrls array and say so in notes (but still fill submittalPortalUrl/portalPlatform).
- Prefer the most current year's form. Return valid JSON only.`;
    // THE STATE, BY NAME AND ABBREVIATION, IN EVERY QUERY (issue #162): "State: OR" alone let three
    // searches for the City of Monroe, Oregon return only Monroe MI / CT / OH.
    const scope = stateScopeOf(input.state);
    const queries = stateScopedFormQueries(input.ahj, input.state, formType);
    const stateLine = scope ? `${scope.name} (${scope.abbr}) — only ${input.ahj}, ${scope.abbr}; a same-named place in any other state is not this AHJ` : input.state;
    const queryLines = queries.length ? `\nSearch with queries like these (each names the state):\n${queries.map((q) => `- ${q}`).join("\n")}` : "";
    const userMsg = `AHJ: ${input.ahj}\nState: ${stateLine}\nForm needed: residential solar ${formType.replace(/_/g, " ")} (building + electrical permit applications).${input.knownContext ? `\n\n${input.knownContext}\nStart from the known portal/URLs above when searching.` : ""}\nFind the AHJ's forms/applications page and the direct blank PDF links.${queryLines}`;
    let parsed: Partial<AhjFormUrlResult> = {};
    let lookupError = "";
    // THE SEARCH RESULTS THEMSELVES (Waltham, 2026-09-28): the call already receives every result's
    // URL and title; only the model's text was kept, so a document link the model saw but did not
    // list was thrown away. Kept as data for the acquisition's own predicate (ahjFormAuto).
    let searchResults: Array<{ url: string; title: string }> = [];
    let searchTimeout: AhjFormUrlResult["searchTimeout"];
    const budgetMs = webResearchBudgetMs();
    try {
      // A GROUNDED SEARCH NEEDS A GROUNDED BUDGET. This ran on askWithWebSearch's 45-second
      // default while making up to three web searches, and on City of Salem it aborted at
      // 45,016ms — after which the harvest reported "research found no forms page", a claim
      // about the jurisdiction rather than about us. The fee researcher uses 240s for the same
      // kind of call (FEE_RESEARCH_CLIENT_TIMEOUT_MS); webResearchBudgetMs matches it (it said so
      // at 180s and did not — one Beaverton search aborted at 180,012 ms) and stays
      // env-overridable for a machine on a slower link.
      // 1024 was the signature default and far too small for this call: with the budget fixed it
      // stopped timing out and immediately hit max_tokens instead (outTok 2918, stop=max_tokens),
      // truncating the JSON so it parsed to {} — which the harvest then read as "this AHJ has no
      // forms page". The sibling research calls all use 3000; this one returns several URLs plus
      // notes after three searches, so it gets more.
      // Every result the searches returned (not the first 20): the out-of-state ones are discarded
      // below BEFORE the cap, so a page of Monroe MI hits cannot crowd Monroe OR's out of it.
      const web = await this.askWithWebSearch("findAhjFormUrl", system, userMsg, 4000, 3, budgetMs, [], FORM_SEARCH_RESULTS_SEEN);
      const raw = web.text;
      searchResults = (web.resultUrls || []).map((url) => ({ url, title: String(web.resultTitles?.[url] || "") }));
      parsed = this.parseJson(raw, {});
      // A RESPONSE WE COULD NOT READ IS NOT AN ANSWER OF "NOTHING". parseJson returns {} for
      // truncated or malformed output, which is byte-identical to a genuine empty result. If the
      // model said something substantial and none of it parsed, say so rather than letting the
      // caller draw a conclusion about the jurisdiction.
      if (String(raw || "").trim().length > 40 && !Object.keys(parsed).length) {
        lookupError = "the model replied but the JSON could not be parsed (most likely truncated — raise maxTokens)";
        logger.warn("llm", "findAhjFormUrl returned unparseable output", { ahj: input.ahj, state: input.state, chars: String(raw).length });
      }
    } catch (err) {
      lookupError = errMsg(err);
      // OUR BUDGET RAN OUT (issue #163: an Oregon county aborted at 240,012 ms with "Request was
      // aborted" and the operator got nothing actionable). The ceiling stays; what the searches had
      // already returned is kept as leads — the acquisition reads them exactly as it reads a finished
      // search's results — and the error says what happened in budget terms, not the SDK's words.
      if (err instanceof WebSearchAbortedError) {
        searchResults = err.partial.resultUrls.map((url) => ({ url, title: String(err.partial.resultTitles[url] || "") }));
        const pagesSeen = new Set([...err.partial.resultUrls, ...err.partial.fetchedUrls]).size;
        searchTimeout = { budgetMs, pagesSeen };
        lookupError = `search timed out after ${formatBudget(budgetMs)}; ${pagesSeen} page(s) seen`;
      }
      logger.warn("llm", "findAhjFormUrl web search failed", { ahj: input.ahj, state: input.state, err: lookupError, ...(searchTimeout ? { pagesSeen: searchTimeout.pagesSeen } : {}) });
    }
    // A SAME-NAMED PLACE IN ANOTHER STATE IS DISCARDED HERE (issue #162), before the harvest reads a
    // forms page, downloads a candidate or learns a portal off it: the search results, the model's
    // candidate links, its forms page and its portal alike. Titles come from the results the search
    // returned (a model-listed URL the search never returned is judged by its host alone).
    const titleOf = new Map(searchResults.map((r) => [r.url, r.title]));
    const scoped = scopeResultsToState(searchResults, input.ahj, input.state);
    searchResults = scoped.kept.slice(0, FORM_SEARCH_RESULTS_KEPT);
    const discarded: Array<{ url: string; title: string; state: string }> = [...scoped.discarded];
    const inState = (url: string): boolean => {
      const other = scopeResultsToState([{ url, title: titleOf.get(url) ?? "" }], input.ahj, input.state).discarded[0];
      if (other && !discarded.some((d) => d.url === url)) discarded.push(other);
      return !other;
    };
    const urls = Array.isArray(parsed.candidateUrls)
      ? parsed.candidateUrls.map((u) => String(u)).filter((u) => /^https?:\/\//i.test(u) && inState(u))
      : [];
    const portalUrl = /^https?:\/\//i.test(String(parsed.submittalPortalUrl || "")) && inState(String(parsed.submittalPortalUrl)) ? String(parsed.submittalPortalUrl) : "";
    const formsPageUrl = /^https?:\/\//i.test(String(parsed.formsPageUrl || "")) && inState(String(parsed.formsPageUrl)) ? String(parsed.formsPageUrl) : "";
    if (discarded.length) {
      logger.info("llm", "findAhjFormUrl discarded same-named out-of-state results", { ahj: input.ahj, state: input.state, discarded: discarded.length, states: [...new Set(discarded.map((d) => d.state))] });
    }
    const discardNote = discarded.length
      ? `Discarded ${discarded.length} result(s) for a same-named place in another state (${[...new Set(discarded.map((d) => d.state))].join(", ")}) — not ${input.ahj}, ${scope?.abbr ?? input.state}.`
      : "";
    return {
      provider: "claude",
      formName: String(parsed.formName || ""),
      candidateUrls: urls,
      formType,
      confidence: (["low", "medium", "high"].includes(String(parsed.confidence)) ? parsed.confidence : "low") as "low" | "medium" | "high",
      notes: [String(parsed.notes || ""), discardNote].filter(Boolean).join(" "),
      formsPageUrl,
      submissionMethod: String(parsed.submissionMethod || ""),
      submittalPortalUrl: portalUrl,
      portalPlatform: String(parsed.portalPlatform || ""),
      submittalRequirements: String(parsed.submittalRequirements || ""),
      permitStructure: (["combo", "separate", "unknown"].includes(String(parsed.permitStructure)) ? parsed.permitStructure : "unknown") as "combo" | "separate" | "unknown",
      // "We could not look" is a different report from "we looked and there is nothing".
      lookupFailed: Boolean(lookupError),
      lookupError,
      searchResults,
      ...(searchTimeout ? { searchTimeout } : {}),
      ...(discarded.length ? { discardedOutOfState: discarded } : {}),
    };
  }

  // The AVAILABLE DATA SOURCES list annotates entries with a trailing
  // "  (explanation)" — models occasionally echo the annotation back with the
  // source (sometimes whitespace-normalized to a single space). Dotted sources
  // never contain whitespace, so keep only the first token; "lit:" literals
  // legitimately carry spaces and keep everything before a 2+-space gap.
  private cleanFieldSourceString(raw: string): string {
    const s = raw.split(/\s{2,}/)[0].trim();
    return s.startsWith("lit:") || s.startsWith("operator:") ? s : s.split(/\s+/)[0];
  }

  async mapAcroFormFields(input: {
    ahj: string;
    state: string;
    formName: string;
    fields: AcroFieldForMapping[];
    captionSide?: "below" | "above" | "left" | "right" | null;
    availableSources: string[];
  }): Promise<AhjFieldMapResult> {
    const system = `You map a blank permit PDF's form fields onto a solar project's known data, so the form can be auto-filled.

You are given the form's AcroForm FIELDS — each with its widget name, type, page, and the PRINTED TEXT around the box on the page — and the list of AVAILABLE DATA SOURCES. For each form field you can confidently fill, choose the single best matching source. Leave a field out entirely if no source clearly matches (do not guess).

Source syntax (use these EXACT strings):
- "project.<key>" / "snapshot.<key>" / "client.<key>" / "computed.<key>" — pull from project data
- "lit:<text>" — a literal constant (use for fixed marks, e.g. "lit:X" for a checkbox, "lit:Solar")
- "operator:<printed caption>" — NOT a value: a blank the applicant must fill by hand because no source answers it

Return ONLY JSON. Every key is required — send an empty array where you have nothing, and
null for an "equals" you do not need:
{
  "textFields": [ { "name": "<exact form field name>", "source": "<source string>" }, ... ],
  "checkboxes": [ { "name": "<exact checkbox field name>", "source": "<source string>", "equals": "<value to compare, or null>" }, ... ],
  "notes": "<short note on anything ambiguous or left blank, e.g. signature/date fields left for the human>"
}
Rules:
- THE PRINTED CAPTION OUTRANKS THE WIDGET NAME. Widget names were auto-generated from nearby text and are often SHIFTED onto the neighbouring box (a box named "Telephone" whose caption reads "Email Address" is an EMAIL box; a box named "SECTION 3 CONSTRUCTION SERVICES" whose caption reads "Name (Print)" is a name box). Decide what each box is from its "caption" first, then the other printed text near it, and only then its name.
- Use the EXACT field names provided (case/spacing matters). Source strings are the part BEFORE any "(...)" annotation in the sources list.
- Put checkbox-type fields in "checkboxes", text fields in "textFields".
- WHO IS WHO: this project is submitted by the licensed CONTRACTOR, who is also the APPLICANT / AUTHORIZED AGENT; the property-owner block holds the homeowner (project.homeownerName, snapshot.homeownerEmail, snapshot.homeownerPhone). Wherever the form names the authorized agent / applicant as a PERSON — the agent's name box, an owner authorization's "hereby authorize ___", an "Owner/Authorized Agent" declaration the agent signs — use computed.applicantSignerName, the ONE source for that person everywhere on the form. The agent's company is client.installerCompanyName; the agent's address / phone / email are client.installerStreet / client.installerPhone / client.installerEmail.
- PRINT-NAME LINES: a "Print name" / "Printed name" / "Name (print)" blank next to or under a SIGNATURE line names whoever signs there — computed.applicantSignerName for the applicant's/agent's signature (computed.electricianSignerName for the electrician's), project.homeownerName only for a signature line that is the property owner's alone.
- ONE SIGNER, ONE SOURCE: an "I, ____" declarant blank and the "Print Name" under the SAME signature are the SAME person and must bind to the SAME source.
- LICENCES: client.ccbLicenseNumber is OREGON's CCB number — never on another state's form. A licence / registration NUMBER slot binds by the licence it NAMES (read its caption AND the section header above it): a construction supervisor licence → client.stateLicence.construction_supervisor; a home improvement contractor registration (HIC) → client.stateLicence.home_improvement_contractor; an electrical contractor licence → client.stateLicence.electrical_contractor; a master / supervising electrician licence → client.stateLicence.master_electrician; a solar contractor licence → client.stateLicence.solar_contractor; a general / building contractor licence → client.stateLicence.contractor; an expiration beside one → that source's ".expires". Only a slot that names NO particular licence ("License #") binds client.stateContractorLicense. Never bind one licence source to two slots that ask for different licences. A licence HOLDER's name slot (e.g. "Licensed Construction Supervisor") is the licence holder, NOT the applicant — never computed.applicantSignerName; bind the holder source (client.stateLicence.construction_supervisor.holder / client.stateLicence.master_electrician.holder), else return it as "operator:<caption>". Never tick "Not Applicable" beside a licence section.
- ESTIMATED COST / VALUATION is NOT a fee-payment field: an "estimated cost", "cost of construction", "valuation" or "job value" blank maps to computed.estimatedJobValue. In a cost-breakdown TABLE (one row per trade — Building, Electrical, Plumbing, Mechanical… — plus a Total), map it ONLY to the Total row (plus at most the single trade row this solar permit is for, when it is clearly captioned); leave every other row out. A parcel / APN / assessor's map-and-parcel blank maps to snapshot.parcelNumber.
- OPERATOR ITEMS: a blank the applicant must fill that NO source answers (zoning district, proposed use, lot area, frontage, setbacks, flood zone, water supply, sewage disposal, a licence holder's name, …) goes in textFields (or checkboxes) with source "operator:<its printed caption>" so it is listed for the operator by name. Never use it for signature, date-signed, fee-payment or official-use-only fields.
- NEVER tick or fill a box attesting that a document is attached or on file (e.g. "Workers' Compensation Insurance affidavit attached — Yes/No"): return it as "operator:<caption>".
- COMPLIANCE-CHECKLIST forms (rows of Yes/No or Complies checkboxes): for the STRUCTURAL PRESCRIPTIVE rows (roof mount, light-frame construction, risk category, ground snow load, wind exposure, wind speed, rafter/truss spacing, PV dead load, module height above roof, roofing layers) map the row's Yes box to the matching "computed.presc<Criterion>Yes" source and its No box to "computed.presc<Criterion>No" — these resolve from the project's parsed data and stay blank when unverified. A single "meets all prescriptive criteria" attestation box maps to "computed.prescAllYes". For rows a code-standard residential rooftop PV install satisfies by definition (listed equipment, rapid shutdown, racking per manufacturer letter), map "lit:X"; skip rows needing project-specific measurements with no matching source and name them in "notes". The mapping is human-verified before real use — a mostly-complete checklist beats an empty one.
- "computed.presc*Answer" sources return the word Yes/No — use them ONLY in "textFields" (a written Yes/No blank), never as a checkbox source.
- NEVER map signature, date-signed, or fee-payment fields — leave them for the human.
- NEVER map utility account number or meter number onto a public form field unless the field name explicitly asks for it.
- Return valid JSON only.`;
    // Each field with its printed text: THE caption (the form's calibrated side) and whatever else
    // is printed around the box. The blank's own text only — no field value, no project data.
    const q = (s: string | undefined): string => JSON.stringify(String(s ?? "").slice(0, 90));
    const fieldLine = (f: AcroFieldForMapping): string => {
      const near = (["left", "right", "below", "above"] as const)
        .filter((side) => f.captions?.[side] && f.captions[side] !== f.caption)
        .map((side) => `${side} ${q(f.captions![side])}`);
      return [f.name, f.type, f.page != null ? `p${f.page + 1}` : "", f.caption ? `caption: ${q(f.caption)}` : "caption: (none found)",
        near.length ? `near: ${near.join(", ")}` : ""].filter(Boolean).join(" | ");
    };
    const sideNote = input.captionSide
      ? `On this form captions are printed ${input.captionSide === "left" || input.captionSide === "right" ? `to the ${input.captionSide} of` : input.captionSide} their boxes (most widget names agree with that side); "caption" is that text.`
      : `No single caption side could be confirmed on this form; "caption" is the text on the box's own line to its left, when there is one — judge each box from all the printed text around it.`;
    const userMsg = `AHJ: ${input.ahj} (${input.state})
Form: ${input.formName}

${sideNote}
FORM FIELDS (name | type | page | printed caption | other printed text near the box):
${input.fields.slice(0, 200).map(fieldLine).join("\n")}

AVAILABLE DATA SOURCES:
${input.availableSources.join("\n")}`;
    // Both shapes are normalized to [name, rule] pairs so the SAME validation runs on the
    // schema-constrained ARRAY response and on the legacy OBJECT response the tolerant
    // repair path still yields. AhjFieldMapResult (Records) is unchanged either way.
    let textEntries: Array<[string, string]> = [];
    let checkboxEntries: Array<[string, { source?: unknown; equals?: unknown }]> = [];
    let mapNotes = "";
    try {
      const raw = await this.askLong("mapAcroFormFields", system, userMsg, 8192, ACRO_FIELD_MAP_FORMAT);
      const structured = this.readStructured(raw, acroFieldMapSchema, "mapAcroFormFields");
      if (structured) {
        textEntries = structured.textFields.map((f) => [f.name, f.source]);
        checkboxEntries = structured.checkboxes.map((c) => [c.name, { source: c.source, equals: c.equals }]);
        mapNotes = structured.notes;
      } else {
        const legacy = this.parseJson<Partial<AhjFieldMapResult>>(raw, {});
        if (legacy.textFields && typeof legacy.textFields === "object") {
          textEntries = Object.entries(legacy.textFields).map(([k, v]) => [k, String(v)]);
        }
        if (legacy.checkboxes && typeof legacy.checkboxes === "object") {
          checkboxEntries = Object.entries(legacy.checkboxes) as Array<[string, { source?: unknown; equals?: unknown }]>;
        }
        mapNotes = String(legacy.notes || "");
      }
    } catch (err) {
      logger.warn("llm", "mapAcroFormFields failed", { err: errMsg(err) });
    }
    const textFields: Record<string, string> = {};
    // "operator:<caption>" is not a value: the blank is named for the operator, never filled.
    const operatorItems: Array<{ field?: string; label: string }> = [];
    const asOperatorItem = (field: string, src: string): boolean => {
      if (!src.startsWith("operator:")) return false;
      if (field) operatorItems.push({ field, label: src.slice("operator:".length).trim() || field });
      return true;
    };
    {
      for (const [k, v] of textEntries) {
        const src = this.cleanFieldSourceString(String(v));
        if (asOperatorItem(k, src)) continue;
        if (k && src && /^(project|snapshot|client|computed)\.|^lit:/.test(src)) textFields[k] = src;
      }
    }
    const checkboxes: Record<string, { source: string; equals?: string }> = {};
    {
      for (const [k, rule] of checkboxEntries) {
        let src = this.cleanFieldSourceString(String(rule?.source || ""));
        if (asOperatorItem(k, src)) continue;
        // An EMPTY equals must be dropped, not kept: at fill time `equals: ""`
        // would mean "check when the value resolves EMPTY" — i.e. tick the box
        // exactly when the data is unverified. (fillLoadedForm guards this too.)
        const equals = rule?.equals == null || String(rule.equals).trim() === "" ? null : String(rule.equals);
        // A presc*Answer source resolves to the word "Yes"/"No" — both truthy,
        // so with no `equals` either answer would tick the box. Resolve which
        // mark variant the box wants from its field name; when the name says
        // neither yes nor no, DROP the rule (a human ticks it) — guessing Yes
        // could put the mark in a row's No box.
        if (equals == null && /^computed\.presc\w*Answer$/.test(src)) {
          const tokens = k.toLowerCase().split(/[^a-z]+/);
          if (tokens.includes("no")) src = src.replace(/Answer$/, "No");
          else if (tokens.some((t) => ["yes", "complies", "meets", "conforms", "pass"].includes(t))) src = src.replace(/Answer$/, "Yes");
          else continue;
        }
        if (k && src && /^(project|snapshot|client|computed)\.|^lit:/.test(src)) {
          checkboxes[k] = equals != null ? { source: src, equals } : { source: src };
        }
      }
    }
    return { provider: "claude", textFields, checkboxes, notes: mapNotes, ...(operatorItems.length ? { operatorItems } : {}) };
  }

  async mapFlatFormOverlay(input: {
    ahj: string;
    state: string;
    formName: string;
    pages: { base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }[];
    availableSources: string[];
  }): Promise<AhjOverlayMapResult> {
    const system = `You are reading a BLANK government permit form (image per page) to determine WHERE each piece of a solar project's data should be written, so a flat (non-fillable) PDF can be auto-filled by drawing text at coordinates.

For each blank/line/box on the form that one of the AVAILABLE DATA SOURCES should fill, return a placement with:
- "source": the EXACT source string to write there (from AVAILABLE DATA SOURCES; use "lit:X" for a checkbox mark, "lit:<text>" for a constant)
- "page": 0-based page index of the image it's on
- "nx": normalized horizontal position (0=left edge, 1=right edge) where the text should START (just right of the label / start of the blank)
- "ny": normalized vertical position (0=top edge, 1=bottom edge) of the text BASELINE (the line the text sits on)
- "size": font size in points (8-10 typical)
- "maxWidthFrac": optional, the available width as a fraction of page width
- "label": the form's printed label for this blank EXACTLY as printed (e.g. "Name:") — the fill finds it on the page and writes inside that label's row. When one label is printed in several sections, prefix the section header: "PROPERTY OWNER - Name:", "APPLICANT - Name:". For a shaded section header with blank rows under it (e.g. "DESCRIPTION OF WORK"), the label is the header's own text.

ALSO locate every SIGNATURE line (where a handwritten signature goes) and return it under "signatures" with:
- "role": whose signature — one of "applicant","owner","contractor","electrician","other". Infer from the label: "supervising electrician","licensed electrician","electrician signature" → "electrician"; "property owner","homeowner" → "owner"; "contractor" → "contractor"; the main submittal/authorized signature → "applicant"
- "page": 0-based page index
- "nx","ny": normalized position of the BOTTOM-LEFT corner of the signature area (just above the signature line, at its left)
- "widthFrac","heightFrac": the signature area size as a fraction of page width/height (a signature line is typically ~0.25 wide, ~0.04 tall)
- "dateNx","dateNy": if there is a "date" line right next to this signature, the normalized baseline position to write the date; omit if there is none
- "label": the printed signature label

Return ONLY JSON: {"fields":[ ... ], "signatures":[ ... ], "notes":"<caveats>"}
Every key listed above is required on every entry — send null for one that does not apply
(e.g. "maxWidthFrac": null, "dateNx": null), never omit it. Send empty arrays when you find nothing.

Rules:
- Place a value ONLY where you can clearly see the matching labeled blank. Do not guess positions.
- Do NOT put text in "fields" for signature or date-signed lines — signature lines go in "signatures"; leave date-signed for the human.
- PRINT-NAME LINES: a "Print name" / "Printed name" / "Name (print)" blank next to or under a SIGNATURE line is a regular text field, not a signature — place "computed.applicantSignerName" there (or "computed.electricianSignerName" when the adjacent signature is the electrician's). These are routinely left blank by mappers and then bounced by the AHJ; map them whenever the signer is the applicant/agent.
- For checkboxes (e.g. "Type of work: Other"), use source "lit:X" placed at the box.
- COMPLIANCE CHECKLISTS (e.g. a prescriptive solar checklist where each row has Yes/No or Complies boxes): for the STRUCTURAL PRESCRIPTIVE rows (roof mount, light-frame construction, risk category, ground snow load, wind exposure, wind speed, rafter/truss spacing, PV dead load, module height above roof, roofing layers) place the matching "computed.presc<Criterion>Yes" source at the row's Yes/Complies box and "computed.presc<Criterion>No" at its No box — each draws an "X" only when the project's parsed data answers that way, so an unverified row stays blank for the operator. A single "meets all prescriptive criteria" box gets "computed.prescAllYes". Written blanks on those rows (e.g. "Ground snow load: ___ psf") take the matching "snapshot.*" value source. For rows a code-standard residential rooftop PV install satisfies by definition (flush roof mount, listed equipment, engineered racking per manufacturer letter, rapid shutdown, permitted conductor sizing), place "lit:X" in the Yes/Complies box. SKIP rows requiring project-specific data with no matching source (spans, site distances) — list those skipped rows in "notes" so the operator finishes them. The map is human-verified before real use, so favor covering the standard rows over leaving the checklist blank.
- ONE SIGNER, ONE SOURCE: an "I, ____" declarant blank and the "Print Name" under the SAME signature are the SAME person — the same source. The authorized agent / applicant as a PERSON is computed.applicantSignerName everywhere on the form.
- LICENCES: client.ccbLicenseNumber is OREGON's CCB number — never on another state's form. A licence / registration NUMBER blank takes the source of the licence it NAMES (client.stateLicence.construction_supervisor / .home_improvement_contractor / .electrical_contractor / .master_electrician / .solar_contractor / .contractor, and ".expires" for its expiry); only a blank that names no particular licence takes client.stateContractorLicense. A licence HOLDER's name blank is not the applicant — never computed.applicantSignerName; it takes the holder source (client.stateLicence.construction_supervisor.holder / client.stateLicence.master_electrician.holder).
- ESTIMATED COST / VALUATION is not a fee: an "estimated cost" / "valuation" blank takes computed.estimatedJobValue — in a cost table ONLY the Total row. A parcel / APN / map-and-parcel / tax-map / tax-lot blank takes snapshot.parcelNumber (never the description of work). A DESCRIPTION OF WORK / scope-of-work area takes computed.descriptionOfWork.
- OPERATOR ITEMS: for a blank you can see that NO source answers (zoning district, lot area, frontage, setbacks, flood zone, water supply, sewage disposal…), add a "fields" entry with source "operator:<its printed label>" at that blank — it is listed for the operator, never drawn. Never for signature, date-signed, fee-payment or official-use-only blanks.
- NEVER place a mark attesting that a document is attached or on file (e.g. "Workers' Compensation affidavit attached — Yes/No"): use "operator:<label>" instead.
- ROLE/SECTION checkboxes: if the form has checkboxes that select WHO a section describes — e.g. "Property owner" vs "Tenant", "Contractor" vs "Subcontractor", "Applicant" vs "Contact Person", "Owner" vs "Agent" — check the boxes that match THIS filing: this project is submitted by the licensed CONTRACTOR who is also the APPLICANT, and the property-owner block holds the homeowner. So place "lit:X" in the "Property owner", "Contractor", and "Applicant" boxes (and any equivalent owner/contractor/applicant selector), and DO NOT check "Tenant", "Subcontractor", or "Contact Person". Place the X precisely inside the small box, not on the label.
- Coordinates must be precise — they will be used verbatim. Return valid JSON only.`;

    const content: Anthropic.Messages.ContentBlockParam[] = [];
    content.push({ type: "text", text: `Form: ${input.formName} — ${input.ahj} (${input.state})\n\nAVAILABLE DATA SOURCES:\n${input.availableSources.join("\n")}\n\nPages follow:` });
    input.pages.forEach((pg, i) => {
      content.push({ type: "text", text: `PAGE ${i}:` });
      content.push({ type: "image", source: { type: "base64", media_type: pg.mimeType, data: pg.base64 } });
    });
    content.push({ type: "text", text: "Return the placements JSON now." });

    let raw = "";
    try {
      // A 4096-token ceiling (thinking included) truncated City of Waltham's two-page application
      // mid-JSON: "hit max_tokens … returned no JSON", so NO placements and NO signature lines were
      // stored for it. The ceiling is not spend — the model stops when it is done — so it is sized
      // for a multi-page form, and the call streams, which the SDK requires above ~21k tokens and
      // which keeps a long read from tripping the non-streaming timeout.
      const msg = await this.instrument("mapFlatFormOverlay", this.routeOf("mapFlatFormOverlay"), { pages: input.pages.length, schema: true, maxTokens: FLAT_FORM_OVERLAY_MAX_TOKENS }, (t) =>
        this.client.messages.stream({
          model: t.model,
          max_tokens: FLAT_FORM_OVERLAY_MAX_TOKENS,
          thinking: { type: "adaptive" },
          output_config: outputConfigFor(t, OVERLAY_MAP_FORMAT)!,
          system: this.cachedSystem(system),
          messages: [{ role: "user", content }],
        }).finalMessage(),
      );
      raw = this.textOf(msg);
      if (msg.stop_reason === "max_tokens") logger.warn("llm", "mapFlatFormOverlay hit its token ceiling", { maxTokens: FLAT_FORM_OVERLAY_MAX_TOKENS, pages: input.pages.length });
    } catch (err) {
      logger.warn("llm", "mapFlatFormOverlay failed", { err: errMsg(err) });
    }
    // The schema spells "not applicable" as an explicit null; the coordinate readers below
    // were written against an OMITTED key (Number(undefined) is NaN → the default; but
    // Number(null) is 0 → a placement drawn at the page corner). Dropping nulls makes the
    // schema-constrained entry byte-for-byte the shape those readers already handle, so
    // every 0..1 range check and default stays exactly as it was.
    const dropNulls = (o: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) if (v !== null) out[k] = v;
      return out;
    };
    const structured = this.readStructured(raw, overlayMapSchema, "mapFlatFormOverlay");
    const parsed: { fields?: unknown[]; signatures?: unknown[]; notes?: string } = structured
      ? {
          fields: structured.fields.map((f) => dropNulls(f as unknown as Record<string, unknown>)),
          signatures: structured.signatures.map((s) => dropNulls(s as unknown as Record<string, unknown>)),
          notes: structured.notes,
        }
      : this.parseJson<{ fields?: unknown[]; signatures?: unknown[]; notes?: string }>(raw, {});
    const fields: AhjOverlayMapResult["fields"] = [];
    // "operator:<label>" marks a printed blank no source answers — named for the operator, never drawn.
    const operatorItems: Array<{ label: string }> = [];
    if (Array.isArray(parsed.fields)) {
      for (const f of parsed.fields) {
        const o = f as Record<string, unknown>;
        const source = this.cleanFieldSourceString(String(o.source || ""));
        const nx = Number(o.nx);
        const ny = Number(o.ny);
        if (source.startsWith("operator:")) {
          const label = source.slice("operator:".length).trim() || String(o.label ?? "").trim();
          if (label) operatorItems.push({ label });
          continue;
        }
        if (!/^(project|snapshot|client|computed)\.|^lit:/.test(source)) continue;
        if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
        fields.push({
          source,
          page: Number.isFinite(Number(o.page)) ? Math.max(0, Math.floor(Number(o.page))) : 0,
          nx,
          ny,
          size: Number.isFinite(Number(o.size)) ? Number(o.size) : 9,
          maxWidthFrac: Number.isFinite(Number(o.maxWidthFrac)) ? Number(o.maxWidthFrac) : undefined,
          label: o.label != null ? String(o.label) : undefined,
        });
      }
    }
    const validRoles = ["applicant", "owner", "contractor", "electrician", "other"];
    const signatures: AhjOverlayMapResult["signatures"] = [];
    if (Array.isArray(parsed.signatures)) {
      for (const sgn of parsed.signatures) {
        const o = sgn as Record<string, unknown>;
        const nx = Number(o.nx);
        const ny = Number(o.ny);
        if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
        const dateNx = Number(o.dateNx);
        const dateNy = Number(o.dateNy);
        const hasDate = Number.isFinite(dateNx) && Number.isFinite(dateNy) && dateNx >= 0 && dateNx <= 1 && dateNy >= 0 && dateNy <= 1;
        signatures.push({
          role: validRoles.includes(String(o.role)) ? String(o.role) : "applicant",
          page: Number.isFinite(Number(o.page)) ? Math.max(0, Math.floor(Number(o.page))) : 0,
          nx,
          ny,
          widthFrac: Number.isFinite(Number(o.widthFrac)) && Number(o.widthFrac) > 0 ? Number(o.widthFrac) : 0.25,
          heightFrac: Number.isFinite(Number(o.heightFrac)) && Number(o.heightFrac) > 0 ? Number(o.heightFrac) : 0.04,
          label: o.label != null ? String(o.label) : undefined,
          ...(hasDate ? { dateNx, dateNy } : {}),
        });
      }
    }
    return { provider: "claude", fields, signatures, notes: String(parsed.notes || ""), ...(operatorItems.length ? { operatorItems } : {}) };
  }

  // ---------------------------------------------------------------------------
  // Bounded tool-use agent. A manual loop: call the model with the supplied
  // tools, run each requested tool's local handler, feed the results back, and
  // repeat until the model stops calling tools (end_turn) or maxIterations is
  // reached. Every model turn routes through instrument() so the whole agent
  // shows up in the llm-calls.json log like any other call. Tools are narrow
  // local handlers (read a bundle file, read project fields, record a finding) —
  // there is no shell, no network, no filesystem access beyond what a handler
  // itself does. Used by the run-triage and correction agents.
  // ---------------------------------------------------------------------------
  async runToolAgent(input: AgentRunInput): Promise<AgentRunResult> {
    const maxIterations = Math.max(1, Math.min(input.maxIterations ?? 12, 20));
    // The agent caller names the effort (default medium, as before); the route supplies the model.
    const route = routeFor("runToolAgent", { callerEffort: input.effort ?? "medium" });
    const toolByName = new Map(input.tools.map((t) => [t.name, t]));
    // STRICT TOOL USE. `classify_correction` and `report_finding` set a bucket / a
    // severity that the operator then acts on, and `propose_data_update` writes a
    // human-approved data change — the handlers coerce every field defensively
    // because until now a tool_use.input was whatever the model felt like emitting.
    // strict:true has the API validate the input against the schema instead, so a
    // missing required field or an invented key cannot reach a handler at all.
    // The handlers' coercion stays: defence in depth, and it is what runs in stub mode.
    const apiTools: Anthropic.Tool[] = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      strict: true,
      input_schema: closeToolSchema(t.input_schema) as Anthropic.Tool.InputSchema,
    }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: input.user }];
    let finalText = "";
    let iterations = 0;
    let stopReason: string | null = null;

    for (; iterations < maxIterations; iterations++) {
      let msg: Anthropic.Message;
      try {
        msg = await this.instrument(`${input.label}#${iterations + 1}`, route, { tools: apiTools.length }, (t) =>
          this.client.messages
            .stream({
              model: t.model,
              max_tokens: 4096,
              thinking: { type: "adaptive" },
              ...(outputConfigFor(t) ? { output_config: outputConfigFor(t) } : {}),
              system: this.cachedSystem(input.system),
              tools: apiTools,
              // The growing history reads from the previous turn's cache (see placeHistoryCacheBreakpoint).
              messages: placeHistoryCacheBreakpoint(messages),
            })
            .finalMessage(),
        );
      } catch (err) {
        // The agent's contract predates LlmRefusalError: a refusal stops it cleanly with
        // stopReason "refusal" (a named outcome its callers already branch on), not a throw.
        if (err instanceof LlmRefusalError) return { provider: "claude", finalText, iterations: iterations + 1, hitIterationCap: false, stopReason: "refusal" };
        throw err;
      }
      stopReason = msg.stop_reason;
      finalText = this.textOf(msg) || finalText;

      const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (msg.stop_reason !== "tool_use" || toolUses.length === 0) {
        // Model is done (end_turn) or refused/truncated — stop cleanly.
        return { provider: "claude", finalText, iterations: iterations + 1, hitIterationCap: false, stopReason };
      }

      // Append the assistant turn, then run each tool and return all results in ONE user turn.
      messages.push({ role: "assistant", content: msg.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const tool = toolByName.get(use.name);
        let content: Anthropic.ToolResultBlockParam["content"];
        let isError = false;
        try {
          if (!tool) throw new Error(`unknown tool ${use.name}`);
          const out = await tool.handler((use.input ?? {}) as Record<string, unknown>);
          content = toolResultContent(out);
        } catch (err) {
          isError = true;
          content = errMsg(err);
        }
        results.push({ type: "tool_result", tool_use_id: use.id, content, is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }
    // Ran out of iterations while the model still wanted to call tools.
    return { provider: "claude", finalText, iterations, hitIterationCap: true, stopReason };
  }
}

// Serialize a tool handler's return value into Anthropic tool_result content.
// JSON/text → a text block; an image → an image block so the model can SEE it.
function toolResultContent(out: AgentToolResult): Anthropic.ToolResultBlockParam["content"] {
  if (out.kind === "image") {
    const blocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
    if (out.caption) blocks.push({ type: "text", text: out.caption });
    blocks.push({ type: "image", source: { type: "base64", media_type: out.mimeType, data: out.base64 } });
    return blocks;
  }
  if (out.kind === "text") return out.text;
  return JSON.stringify(out.value);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Strip the common mistakes that cause a 401 "invalid x-api-key": surrounding
// quotes, whitespace, and accidental "Bearer "/"ANTHROPIC_API_KEY=" prefixes.
export function sanitizeApiKey(raw: string | undefined): string {
  if (!raw) return "";
  let k = raw.trim();
  k = k.replace(/^["']|["']$/g, "").trim();
  k = k.replace(/^Bearer\s+/i, "").replace(/^ANTHROPIC_API_KEY\s*=\s*/i, "").trim();
  return k;
}

export function createLLMProvider(): LLMProvider {
  const apiKey = sanitizeApiKey(process.env["ANTHROPIC_API_KEY"]);
  if (!apiKey) {
    logger.warn("llm", "No ANTHROPIC_API_KEY — running in stub mode (advisory only)");
    return new StubLLMProvider();
  }
  if (!/^sk-ant-/.test(apiKey)) {
    logger.warn("llm", `ANTHROPIC_API_KEY does not start with "sk-ant-" — it may be malformed (Claude calls will likely 401)`, { chars: apiKey.length });
  }
  // The routing table, once: every task on the baseline says so in one line; anything an env var
  // moved (or an advisor switched on) is listed by name so a changed route is never silent.
  const routes = describeRoutes();
  const moved = routes.filter((r) => r.source !== "table/table" && r.source !== "table/omitted" || r.advisor);
  logger.info("llm", "Claude provider ready", { baseline: BASELINE_MODEL, tasks: routes.length, routedElsewhere: moved.length ? moved : "none" });
  return new ClaudeLLMProvider(apiKey);
}

// ---------------------------------------------------------------------------
// MBOX enrichment (called by knowledgeBase.ts)
// ---------------------------------------------------------------------------

export async function enrichMboxLearningWithLlm(input: {
  redactedEmailText: string;
  deterministicRecord: MboxExtractedLearningRecord;
}): Promise<Partial<MboxExtractedLearningRecord> | null> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || process.env["LLM_MBOX_ENRICHMENT"] !== "true") return null;

  const provider = new ClaudeLLMProvider(apiKey);
  try {
    const classification = await provider.classifyCorrection({ correctionText: input.redactedEmailText });
    // Map Claude classification back to learning record fields
    return {
      type: classification.bucket as MboxExtractedLearningRecord["type"],
      classifier: "llm" as const,
      confidence: classification.confidence,
    };
  } catch (err) {
    logger.error("llm", "MBOX enrichment failed", { err: errMsg(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// PARSER EXTRACTION POST-PROCESSING — no model. Provenance that survives receipt,
// structured uncertainty / conflicts, and the deterministic resolutions the parser page
// shows as RESOLVED (value + how) instead of "not fully sure".
// ---------------------------------------------------------------------------
const EVIDENCE_SOURCES: ReadonlyArray<ParserFieldEvidence["source"]> = ["plan_set", "utility_bill", "meter_photo", "structural_letter"];

/** A structural letter's provenance used to be coerced to plan_set here, which silently
 *  deleted the sealed-source rule's only input. Unknown strings still fall back to plan_set. */
export function evidenceSource(raw: unknown): ParserFieldEvidence["source"] {
  const s = String(raw ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  return (EVIDENCE_SOURCES as readonly string[]).includes(s) ? (s as ParserFieldEvidence["source"]) : "plan_set";
}

const UNCERTAINTY_KINDS = new Set<ParserExtractionUncertainty["kind"]>(["unreadable", "guessed", "inferred", "conflicting", "unconfirmed"]);

export function normalizeUncertainties(raw: unknown): ParserExtractionUncertainty[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ParserExtractionUncertainty[] = [];
  for (const u of raw) {
    if (!u || typeof u !== "object") continue;
    const rec = u as { field?: unknown; kind?: unknown; reason?: unknown };
    const field = String(rec.field ?? "").trim();
    if (!field) continue;
    const kindRaw = String(rec.kind ?? "").toLowerCase().trim() as ParserExtractionUncertainty["kind"];
    out.push({ field, kind: UNCERTAINTY_KINDS.has(kindRaw) ? kindRaw : "guessed", reason: String(rec.reason ?? "").trim().slice(0, 240) });
  }
  return out;
}

export function normalizeConflicts(raw: unknown): ParserExtractionConflict[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ParserExtractionConflict[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const rec = c as { field?: unknown; readings?: unknown; note?: unknown };
    const field = String(rec.field ?? "").trim();
    if (!field || !Array.isArray(rec.readings)) continue;
    const readings: ParserExtractionConflict["readings"] = [];
    for (const r of rec.readings) {
      if (!r || typeof r !== "object") continue;
      const rr = r as { value?: unknown; source?: unknown; sheet?: unknown; excerpt?: unknown };
      if (rr.value == null || rr.value === "") continue;
      const value = typeof rr.value === "number" ? rr.value : String(rr.value).trim().slice(0, 120);
      readings.push({ value, source: evidenceSource(rr.source), sheet: rr.sheet ? String(rr.sheet).slice(0, 40) : undefined, excerpt: rr.excerpt ? String(rr.excerpt).slice(0, 200) : undefined });
    }
    if (readings.length < 2) continue; // one reading is not a disagreement
    out.push({ field, readings, note: rec.note ? String(rec.note).trim().slice(0, 300) : undefined });
  }
  return out;
}

/**
 * Deterministic resolutions after a pass, plus the record of which documents the pass was
 * GIVEN (from the request — never from the model, which cannot know what else the page holds).
 *   - moduleMake: when the plan set never printed a make (or the model was unsure of it), the
 *     CEC equipment list resolves it from the model string — and only when every listing of
 *     that model names ONE manufacturer. No match → the field stays as the model left it.
 */
export function finalizeExtraction(result: ParserLlmExtraction, documentsSeen: Array<ParserFieldEvidence["source"]>): ParserLlmExtraction {
  const out: ParserLlmExtraction = { ...result, documentsSeen: [...documentsSeen] };
  const resolutions: ParserExtractionResolution[] = [...(result.resolutions ?? [])];
  const make = result.fields.moduleMake;
  const model = result.fields.moduleModel;
  const modelStr = model && typeof model.value === "string" ? model.value.trim() : "";
  const makeUnsure = !make || make.value === "" || result.lowConfidenceFields.includes("moduleMake");
  if (modelStr && makeUnsure) {
    const hit = lookupCecModuleMake(modelStr);
    if (hit) {
      out.fields = {
        ...result.fields,
        moduleMake: { value: hit.manufacturer, confidence: 0.9, evidence: { source: model?.evidence?.source ?? "plan_set", sheet: "CEC equipment list", excerpt: `${modelStr} is listed under ${hit.manufacturer}`.slice(0, 200) } },
      };
      out.lowConfidenceFields = result.lowConfidenceFields.filter((f) => f !== "moduleMake");
      if (result.uncertainties) out.uncertainties = result.uncertainties.filter((u) => u.field !== "moduleMake");
      resolutions.push({ field: "moduleMake", value: hit.manufacturer, how: `CEC equipment list: module ${modelStr} is listed under ${hit.manufacturer}${make && make.value ? ` (the plan set reads "${String(make.value)}")` : " (no make printed on the plan set)"}` });
    }
  }
  if (resolutions.length) out.resolutions = resolutions;
  return out;
}
