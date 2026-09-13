import Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";
import type { AgentRunInput, AgentRunResult, AgentToolResult, AhjFieldMapResult, AhjFormUrlResult, AhjOverlayMapResult, AhjResearchResult, CorrectionBucket, InverterSpecLookup, LLMProvider, MboxExtractedLearningRecord, ParserLlmExtraction, PortalFieldPlan, PortalFieldPlanInput, PortalFillVerification, PortalFillVerifyInput, PortalFillVisionVerifyInput, ProjectRecord, UtilityResearchResult, AiPlanReviewResult, ReviewWorkType, JurisdictionCodeProfile, JurisdictionCodeResearchResult, ParserExtractedField } from "../../shared/src/types";
import { RECIPE_FIELD_DESCRIPTIONS } from "./portalRecipes";
import { logger } from "./logger";
import { lookupCecInverter } from "./cecEquipment";

// Claude Opus 5: drop-in successor to Opus 4.8 at identical pricing with a
// step-change in agentic/vision capability. Verified safe for this codebase:
// every call site already uses adaptive thinking (on by default on Opus 5), no
// sampling params, no prefills, no thinking:{disabled}. Prompt-cache minimum
// also drops 1024→512 tokens, so mid-size system prompts start caching.
// NOTE: claude-opus-5 draws from a SEPARATE rate-limit bucket than Opus 4.x.
const MODEL = process.env.AUTOPILOT_LLM_MODEL || "claude-opus-5";

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
}

const LLM_CALL_LOG_MAX = 400;
const llmCallLog: LlmCallRecord[] = [];

// Exported for backend/test/modelCallAccounting.test.ts ONLY: the replay benchmark's
// zero-model criterion is computed from exactly this record→query pair, so its test has
// to drive the real surface — a mock log would prove the mock. Production writes still
// arrive solely via instrument().
export function recordLlmCall(rec: LlmCallRecord): void {
  llmCallLog.push(rec);
  if (llmCallLog.length > LLM_CALL_LOG_MAX) llmCallLog.splice(0, llmCallLog.length - LLM_CALL_LOG_MAX);
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

  async researchJurisdictionCodes(input: { ahj: string; state: string }): Promise<JurisdictionCodeResearchResult> {
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
  { re: /valuation|job value|contract (price|value)|cost of/i, field: "jobValue" },
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
  private async instrument(
    label: string,
    meta: Record<string, unknown>,
    exec: () => Promise<Anthropic.Message>,
  ): Promise<Anthropic.Message> {
    const t0 = performance.now();
    const at = Date.now();
    logger.debug("llm", `→ ${label}`, { model: MODEL, ...meta });
    let msg: Anthropic.Message;
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
    for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
      try {
        msg = await exec();
        if (attempt > 0) logger.info("llm", `✓ ${label} recovered after ${attempt} retry(ies)`, { ...meta });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length || !isTransientLlmError(err)) break;
        const wait = TRANSIENT_RETRY_DELAYS_MS[attempt];
        logger.warn("llm", `↻ ${label} transient failure — retrying in ${wait}ms`, { ...meta, attempt: attempt + 1, err: errMsg(err) });
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (lastErr) {
      const err = lastErr;
      logger.error("llm", `✗ ${label} failed`, { ms: `${Math.round(performance.now() - t0)}ms`, ...meta, err: errMsg(err) });
      recordLlmCall({ at, label, ms: Math.round(performance.now() - t0), error: errMsg(err) });
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
      at, label, ms,
      inTok: u?.input_tokens, outTok: u?.output_tokens,
      cacheRead: u?.cache_read_input_tokens || undefined,
      cacheWrite: u?.cache_creation_input_tokens || undefined,
      stop: msg.stop_reason,
    });
    return msg;
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

  private async ask(label: string, systemPrompt: string, userMessage: string): Promise<string> {
    const msg = await this.instrument(label, { chars: userMessage.length }, () =>
      this.client.messages
        .stream({
          model: MODEL,
          max_tokens: 2048,
          thinking: { type: "adaptive" },
          system: this.cachedSystem(systemPrompt),
          messages: [{ role: "user", content: userMessage }],
        })
        .finalMessage(),
    );
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

  async extractFields(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const system = `You are a solar permit document parser. Extract structured data from solar permit application text.
Return a JSON object with any of these fields you can find: customerName, address, city, state, zip, systemKw, panelCount, panelModel, inverterModel, inverterCount, batteryModel, batteryCount, utilityAccount, meterNumber, ahj, utility, roofType, mountType, azimuth, tilt.
IMPORTANT: Do NOT include utility account numbers — omit that field entirely for privacy.
Set confidence (0-1) for each field. Return only valid JSON.`;
    const raw = await this.ask("extractFields", system, JSON.stringify(input));
    return this.parseJson<Record<string, unknown>>(raw, { provider: "claude", confidence: 0 });
  }

  // Larger budget than ask() — plan sets are dense and we want every field.
  private async askLong(label: string, systemPrompt: string, userMessage: string, maxTokens = 4096): Promise<string> {
    const run = (budget: number) =>
      this.instrument(label, { chars: userMessage.length, maxTokens: budget, effort: "high" }, () =>
        this.client.messages
          .stream({
            model: MODEL,
            max_tokens: budget,
            thinking: { type: "adaptive" },
            // Plan sets are dense, multi-section reasoning — give the model room to reason.
            output_config: { effort: "high" },
            system: this.cachedSystem(systemPrompt),
            messages: [{ role: "user", content: userMessage }],
          })
          .finalMessage(),
      );
    let msg = await run(maxTokens);
    // Truncated output is usually unparseable JSON → a silently empty result. Retry once
    // at 2× — but only when the clipped text really is unusable: a response whose JSON
    // block completed before the cap (only trailing prose was cut) parses fine, and
    // re-running it would double the cost of the hottest call for nothing.
    if (msg.stop_reason === "max_tokens" && !hasCompleteJsonBlock(this.textOf(msg))) {
      msg = await run(maxTokens * 2);
    }
    return this.textOf(msg);
  }

  // Like askLong, but with a page SCREENSHOT prepended (vision-assisted planning). The model
  // reads the visible layout/section headings as the authoritative signal and the JSON field
  // list corroborates it. Used by planPortalFields when a screenshot is available.
  private async askLongWithImage(label: string, systemPrompt: string, userMessage: string, imageBase64: string, mimeType: "image/png" | "image/jpeg" | "image/webp", maxTokens = 4096): Promise<string> {
    const run = (budget: number) =>
      this.instrument(label, { chars: userMessage.length, maxTokens: budget, effort: "xhigh", image: true }, () =>
        this.client.messages
          .stream({
            model: MODEL,
            max_tokens: budget,
            thinking: { type: "adaptive" },
            // The vision-assisted planner is the hardest "see and reason" step (read the live
            // layout, reconcile it with the field list, decide each fill) — run it at xhigh.
            output_config: { effort: "xhigh" },
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
  }): Promise<ParserLlmExtraction> {
    const system = `You are an expert solar permit intake specialist. You read the raw extracted text of a residential solar project's documents and pull out every field a permit/interconnection application needs. The text comes from PDF extraction and OCR, so it may be noisy, out of order, or have character errors — use judgment and cross-check between documents.

You are given up to three documents:
- PLAN_SET: the engineering plan set (cover sheet, site plan, electrical SLD, datasheets). Best source for system size, equipment, roof, AHJ.
- UTILITY_BILL: the electric utility bill. Best source for homeowner name(s), service address, utility company, account number, and sometimes meter number.
- METER_PHOTO: OCR of a photo of the electric meter. Best source for the meter number/serial.
- STRUCTURAL_LETTER: a stamped/sealed engineering letter or structural calculation package. AUTHORITATIVE for the structural block (ground snow, PV dead load, roof dead/live load, ultimate design wind speed + exposure category, risk category, rafter/truss size + spacing + span, wood grade, roof material, roof slope, attachment/withdrawal values) and for whether a PE stamp exists. It does NOT contain the electrical single-line or the equipment schedule — never infer module/inverter make, model, wattage, quantity, or system size from it.

Return ONLY a JSON object of this exact shape:
{
  "fields": {
    "<fieldId>": { "value": <string|number|null|array|object>, "confidence": <0..1>, "evidence": { "source": "plan_set|utility_bill|meter_photo", "sheet": "<sheet/page hint e.g. PV-2 or Cover>", "excerpt": "<verbatim text you read it from, MAX 100 CHARACTERS>" } }
  },
  "lowConfidenceFields": ["<fieldId>", ...],
  "notes": "<short notes on anything ambiguous or worth a human double-check>"
}

EVIDENCE IS REQUIRED for accuracy: for every field, include an "evidence" object citing where you read it (which document, the sheet/page hint if visible, and a verbatim excerpt of AT MOST 100 CHARACTERS — just enough for a human to find the line; longer excerpts are truncated on receipt and only cost time). If you cannot cite a source, lower confidence and add the field to lowConfidenceFields.
VALUE TYPES: almost every field is a scalar. The few documented as structured (notably pvArrays) MUST be emitted as real JSON arrays/objects, never as a stringified version of one.

Use EXACTLY these fieldId keys when you find a value (omit a key entirely if absent):
IDENTITY / SITE
- owner: full homeowner name(s) (e.g. "Abigail Boileau & Thomas Boileau")
- street, city, state (2-letter), zip: service address parts
- ahj: Authority Having Jurisdiction (permitting city/county), e.g. "City of Newberg"
- utility: electric utility normalized ("PGE", "Pacific Power")
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
- inverterSettings: note grid-support listing / settings, e.g. "UL 1741 SB" or "UL 1741 SA, PCS profile" (needed for utility interconnection)
- batteryMake, batteryModel, batteryQty (number)
- roofMaterial (e.g. "Composition Shingle"), mounting (e.g. "Roof Mount")
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
- roofLayers: number of existing roofing layers/coverings under the array (number, e.g. 1)
- moduleHeightAboveRoof: max height of the module top above the roof surface in inches (number, e.g. 10)
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
UTILITY INTERCONNECTION (PGE PowerClerk / Pacific Power customer generation NEM)
- utilitySchedule: the utility rate schedule from the bill (e.g. PGE "Schedule 7", Pacific Power "Schedule 4")
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
- contractorCcb: CCB / contractor license number
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
- Set confidence honestly; put anything <0.6 or guessed into lowConfidenceFields.
- Account/meter numbers: only digits you can actually read; never invent or pad. Join spaced account segments (e.g. "65564191-001 4" -> "65564191-0014"); do not drop a trailing check digit.
- Electrical amps come from the PLAN SET (SLD, datasheets) — not the bill. Structural loads come from the STRUCTURAL_LETTER when one is supplied (it is the sealed source of record), otherwise from the plan set's structural notes.
- When a STRUCTURAL_LETTER is present, set stampRecommendation to a one-line statement of what it certifies and whether it is sealed/stamped (e.g. "PE-sealed structural letter provided: existing framing adequate, no upgrades required"). Never claim a stamp that the document does not show.
- SYSTEM ADDITIONS: when the plan set shows an existing PV system, dcKw/acKw and ALL module/inverter/pvMicro/pvArrays fields describe ONLY the NEW equipment being added under this permit — never the existing equipment and never the combined total. E.g. a cover sheet stating "SYSTEM SIZE: 5.280 kW DC" and "COMBINED SYSTEM SIZE: 10.440 kW DC" means dcKw=5.28 and combinedDcKw=10.44. Existing equipment goes ONLY in the existing* fields. Mention the addition (existing + new + combined sizes) in projectDescriptionText.
- Prefer the utility bill for name/address/account, the meter photo for meter number, the plan set for everything else.
- Numbers must be JSON numbers. Return valid JSON only — no prose outside the JSON.`;

    const parts: string[] = [];
    if (input.defaultState) parts.push(`(Default state hint if ambiguous: ${input.defaultState})`);
    if (input.planText?.trim()) parts.push(`=== PLAN_SET ===\n${input.planText.slice(0, 24000)}`);
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
    const user = parts.join("\n\n");
    try {
      return this.normalizeExtraction(
        await this.askLong("extractProjectFields", system, user, 16000),
        "Could not parse LLM response.",
      );
    } catch (err) {
      logger.warn("llm", "extractProjectFields response unreadable — retrying once", {
        err: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
      });
      return this.normalizeExtraction(
        await this.askLong("extractProjectFields", system, user, 16000),
        "Could not parse LLM response (retry).",
      );
    }
  }

  // Shared parser for both text and vision extraction results — captures
  // value, confidence, and evidence (provenance) per field.
  private normalizeExtraction(raw: string, parseFailNote: string): ParserLlmExtraction {
    const FAILED = Symbol("parse-failed");
    const parsed = this.parseJson<{
      fields?: Record<string, { value: unknown; confidence?: number; evidence?: { source?: string; sheet?: string; excerpt?: string } }>;
      lowConfidenceFields?: string[];
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
      throw new Error(`${parseFailNote} The model's response could not be read as JSON — the document was NOT parsed. Response began: ${sample}`);
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
            source: (["plan_set", "utility_bill", "meter_photo"].includes(String(ev.source)) ? ev.source : "plan_set") as "plan_set" | "utility_bill" | "meter_photo",
            sheet: ev.sheet ? String(ev.sheet).slice(0, 40) : undefined,
            excerpt: ev.excerpt ? String(ev.excerpt).slice(0, 200) : undefined,
          }
        : undefined;
      fields[key] = { value: value as ParserExtractedField["value"], confidence, evidence };
    }
    return {
      provider: "claude",
      fields,
      lowConfidenceFields: Array.isArray(parsed.lowConfidenceFields) ? parsed.lowConfidenceFields : [],
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
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
- UTILITY_BILL: the electric bill. Read the homeowner name, full service address, utility company, the ACCOUNT NUMBER exactly as printed, and the meter number from the account-activity table. Account numbers are often shown in spaced segments and formats VARY BY UTILITY (e.g. "65564191-001 4" is ONE account number "65564191-0014"; Pacific Power prints a "002"-style sub-account segment plus a separate check digit, like "12345678 002 X" → "12345678-002X"). Join ALL printed segments in order and never drop a trailing check digit or sub-account segment — a missing segment makes the utility reject the NEM application.
- METER_PHOTO: a photo of the electric meter. Read the meter serial number printed on the face/label (e.g. "78 118 886" -> "78118886"), and the utility (e.g. PacifiCorp = Pacific Power).

Return ONLY JSON: {"fields":{"<id>":{"value":<string|number>,"confidence":<0..1>,"evidence":{"source":"utility_bill|meter_photo","sheet":"<region/label>","excerpt":"<verbatim text read>"}}}, "lowConfidenceFields":[...], "notes":"..."}

Include an "evidence" object for every field (where on the document you read it + a short verbatim excerpt) so a human can verify it.

Field ids (omit if not present):
- owner, street, city, state (2-letter), zip
- utility (normalize: PacifiCorp/Pacific Power -> "Pacific Power"; Portland General/PGE -> "PGE")
- account: the utility account number, digits/dashes EXACTLY as printed
- meter: the meter serial/number, digits only
- servicePeriod: e.g. "Mar 13, 2026 - Apr 13, 2026"
- utilitySchedule: the rate schedule printed on the bill (e.g. "Schedule 7" for PGE, "Schedule 4" for Pacific Power) — needed for the NEM/interconnection application

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

    const msg = await this.instrument("extractProjectFieldsFromImages", { images: input.images.length, effort: "high" }, () =>
      this.client.messages.create({
        model: MODEL,
        // Headroom: adaptive thinking shares the output budget, so leave room for the JSON answer.
        max_tokens: 3500,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        system: this.cachedSystem(system),
        messages: [{ role: "user", content }],
      }),
    );
    return this.normalizeExtraction(this.textOf(msg), "Could not parse vision response.");
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
    const raw = await this.ask("classifyCorrection", system, `${ctx}Correction text:\n${input.correctionText}`);
    const parsed = this.parseJson<{ bucket: CorrectionBucket; confidence: number; notes: string }>(raw, {
      bucket: "C_reviewer_clarification" as CorrectionBucket,
      confidence: 0.3,
      notes: "Parse error — review manually",
    });
    return parsed;
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
    const msg = await this.instrument("visionExtract", { effort: "high", image: true }, () =>
      this.client.messages.create({
        model: MODEL,
        // Headroom: adaptive thinking shares the output budget.
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
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
    const msg = await this.instrument("reviewPlanSetGeneral", { effort: "high", image: input.pageImagesBase64.length > 0, pages: input.pageImagesBase64.length }, () =>
      this.client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
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

  async researchAhjRequirements(input: { ahj: string; state: string; utility?: string; knownContext?: string }): Promise<AhjResearchResult> {
    const system = `You are a solar permitting onboarding specialist. Given an Authority Having Jurisdiction (AHJ) that the system has never processed, lay out what's needed to permit a residential rooftop solar PV system there.

FIRST search the web — prefer the AHJ's own .gov/.us site and the state's ePermitting/building-department pages — to confirm the real portal, submission method, and document checklist for THIS jurisdiction. Many small/mid Oregon and Washington cities (e.g. City of Hillsboro) do NOT run their own portal — they file building+electrical permits through a shared state system (Oregon ePermitting, which runs on Accela). Identify that correctly rather than inventing a city-specific portal. Ground every field in what you actually find; only fall back to regional norms when the search is inconclusive, and say so in tips.

Return ONLY JSON:
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
    const userMsg = `AHJ: ${input.ahj}\nState: ${input.state}${input.utility ? `\nUtility: ${input.utility}` : ""}${input.knownContext ? `\n\n${input.knownContext}` : ""}\n\nResearch the residential solar permitting + interconnection requirements for this jurisdiction.`;
    // Web-grounded first (accurate for never-seen AHJs); fall back to model
    // knowledge if the search is unreachable so the call never hard-fails.
    let parsed: Partial<AhjResearchResult> = {};
    let webGrounded = false;
    try {
      const raw = await this.askWithWebSearch("researchAhjRequirements", system, userMsg, 3000, 5);
      const p = this.parseJson<Partial<AhjResearchResult>>(raw, {});
      if (p && (p.portalName || (Array.isArray(p.requiredDocuments) && p.requiredDocuments.length))) {
        parsed = p;
        webGrounded = true;
      }
    } catch (err) {
      logger.warn("llm", "researchAhjRequirements web search failed — falling back to model knowledge", { err: errMsg(err) });
    }
    if (!webGrounded) {
      const raw = await this.askLong("researchAhjRequirements.fallback", system, userMsg, 3000);
      parsed = this.parseJson<Partial<AhjResearchResult>>(raw, {});
    }
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
    return {
      provider: "claude",
      portalName: String(parsed.portalName || ""),
      portalPlatform: String(parsed.portalPlatform || ""),
      portalUrl: String(parsed.portalUrl || ""),
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

  // ADOPTED-CODES onboarding research (review gate). Same web-grounded pattern as
  // researchAhjRequirements, but targets the jurisdiction's ADOPTED CODE EDITIONS,
  // state/local amendments, and site design criteria. Output is saved as confidence
  // "seeded" and a human verifies each claim against its citation before the review
  // gate cites it authoritatively.
  async researchJurisdictionCodes(input: { ahj: string; state: string }): Promise<JurisdictionCodeResearchResult> {
    const system = `You are a building-department code analyst onboarding a jurisdiction into a plan-review tool. Determine what building codes the jurisdiction has ADOPTED and its local design criteria.

FIRST search the web — prefer, in order: (1) the jurisdiction's own building-department page (.gov/.us/.org), (2) the STATE building-codes agency (state building codes division / DOPL / BCD — many states adopt codes statewide and counties/cities inherit them), (3) the state electrical board for the NEC cycle. Ground every value in a page you actually found and cite it. If a value cannot be confirmed, OMIT it rather than guessing.

Return ONLY JSON:
{
  "adoptedCodes": [{"code": "<IRC|IBC|NEC|IFC|IPC|IMC|IECC|state specialty code abbreviation>", "edition": "<year>", "title": "<full name incl. state amendments note>", "sourceUrl": "<the page confirming this>", "notes": "<effective date / amendment note>"}],
  "amendments": [{"code": "<family>", "section": "<section if known>", "summary": "<what the state/local amendment changes>", "sourceUrl": "<source>"}],
  "designCriteria": {"groundSnowLoadPsf": <number or omit>, "windSpeedMph": <number or omit>, "windExposure": "<B|C|D or omit>", "seismicDesignCategory": "<or omit>", "frostDepthIn": <number or omit>, "sourceUrl": "<the county/city design-criteria page>"},
  "citations": [{"label": "<what this source establishes>", "sourceUrl": "<url>"}],
  "confidenceNotes": "<what you could and could not confirm>"
}

Rules:
- STATE-adopted codes apply to the county/city unless it has its own amendments — say which level each value came from in titles/notes.
- Design criteria (ground snow load, wind, frost depth, seismic) are usually published by the COUNTY/CITY building department; only include numbers you found on such a page.
- This is ADVISORY and will be human-verified — never invent a sourceUrl.
- Return valid JSON only.`;
    const userMsg = `Jurisdiction (AHJ): ${input.ahj || "(state-level default)"}\nState: ${input.state}\n\nResearch the adopted building/electrical/fire codes and local design criteria for this jurisdiction.`;
    interface Raw {
      adoptedCodes?: unknown; amendments?: unknown; designCriteria?: Record<string, unknown>;
      citations?: unknown; confidenceNotes?: unknown;
    }
    let parsed: Raw = {};
    let webGrounded = false;
    try {
      const raw = await this.askWithWebSearch("researchJurisdictionCodes", system, userMsg, 3000, 6);
      const p = this.parseJson<Raw>(raw, {});
      if (p && Array.isArray(p.adoptedCodes) && p.adoptedCodes.length) {
        parsed = p;
        webGrounded = true;
      }
    } catch (err) {
      logger.warn("llm", "researchJurisdictionCodes web search failed — falling back to model knowledge", { err: errMsg(err) });
    }
    if (!webGrounded) {
      const raw = await this.askLong("researchJurisdictionCodes.fallback", system, userMsg, 3000);
      parsed = this.parseJson<Raw>(raw, {});
    }
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const strv = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const d = parsed.designCriteria ?? {};
    const profile: JurisdictionCodeProfile = {
      key: "", state: input.state, ahj: input.ahj, confidence: "seeded",
      adoptedCodes: (Array.isArray(parsed.adoptedCodes) ? parsed.adoptedCodes : [])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({ code: String(c.code || "").slice(0, 24), edition: String(c.edition || "").slice(0, 12), title: strv(c.title), sourceUrl: strv(c.sourceUrl), notes: strv(c.notes) }))
        .filter((c) => c.code && c.edition)
        .slice(0, 12),
      amendments: (Array.isArray(parsed.amendments) ? parsed.amendments : [])
        .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
        .map((a) => ({ code: String(a.code || "").slice(0, 24), section: strv(a.section), summary: String(a.summary || "").slice(0, 400), sourceUrl: strv(a.sourceUrl) }))
        .filter((a) => a.code && a.summary)
        .slice(0, 20),
      designCriteria: {
        groundSnowLoadPsf: num(d.groundSnowLoadPsf),
        windSpeedMph: num(d.windSpeedMph),
        windExposure: strv(d.windExposure),
        seismicDesignCategory: strv(d.seismicDesignCategory),
        frostDepthIn: num(d.frostDepthIn),
        sourceUrl: strv(d.sourceUrl),
      },
      prescriptive: {},
      fireSetbacks: [],
      citations: (Array.isArray(parsed.citations) ? parsed.citations : [])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({ label: String(c.label || "").slice(0, 200), sourceUrl: String(c.sourceUrl || "").slice(0, 500) }))
        .filter((c) => c.sourceUrl)
        .slice(0, 20),
      updatedAt: "",
    };
    return {
      provider: "claude",
      profile,
      webGrounded,
      needsHumanVerification: true,
      notes: `${webGrounded
        ? "Researched from official sources via web search."
        : "Web search unavailable — model knowledge only."} ${String(parsed.confidenceNotes || "")}`.trim(),
    };
  }

  async researchUtilityRequirements(input: { utility: string; state: string; ahj?: string; knownContext?: string }): Promise<UtilityResearchResult> {
    const system = `You are a solar interconnection onboarding specialist. Given an electric UTILITY the system has never processed, lay out what's needed to file a RESIDENTIAL rooftop solar net-metering (NEM) / interconnection application with that utility.

FIRST search the web — prefer the utility's own customer-generation / interconnection page — to confirm the real application portal (many utilities run PowerClerk), submission method, and document checklist for THIS utility. Ground every field in what you actually find; only fall back to regional norms when the search is inconclusive, and say so in tips.

Return ONLY JSON:
{
  "portalName": "<the BRANDED interconnection/NEM portal name the utility uses, e.g. 'PowerClerk', 'Customer Generation online application', or 'Email/PDF application'>",
  "portalPlatform": "<the UNDERLYING software platform/vendor: e.g. 'PowerClerk' (Clean Power Research), 'Tyler', 'Salesforce', 'custom', or 'None'. Many utilities share PowerClerk, so existing automation is reusable — only the entry URL + login differ.>",
  "portalUrl": "<best-known interconnection portal/library URL or '' if unsure>",
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
- For smartInverterSettings, reflect the REAL portal behavior: it is a Yes/No election to use the utility's recommended smart-inverter settings (answer Yes for UL 1741-SB listed inverters) plus an inverter spec/cut-sheet upload — never describe it as a required grid-profile drawing on the plan set.
- Return valid JSON only.`;
    const userMsg = `Utility: ${input.utility}\nState: ${input.state}${input.ahj ? `\nAHJ context: ${input.ahj}` : ""}${input.knownContext ? `\n\n${input.knownContext}` : ""}\n\nResearch the residential solar net-metering / interconnection requirements for this utility.`;
    // Web-grounded first; fall back to model knowledge if search is unreachable.
    let parsed: Partial<UtilityResearchResult> = {};
    let webGrounded = false;
    try {
      const raw = await this.askWithWebSearch("researchUtilityRequirements", system, userMsg, 3000, 5);
      const p = this.parseJson<Partial<UtilityResearchResult>>(raw, {});
      if (p && (p.portalName || (Array.isArray(p.requiredDocuments) && p.requiredDocuments.length))) {
        parsed = p;
        webGrounded = true;
      }
    } catch (err) {
      logger.warn("llm", "researchUtilityRequirements web search failed — falling back to model knowledge", { err: errMsg(err) });
    }
    if (!webGrounded) {
      const raw = await this.askLong("researchUtilityRequirements.fallback", system, userMsg, 3000);
      parsed = this.parseJson<Partial<UtilityResearchResult>>(raw, {});
    }
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
    return {
      provider: "claude",
      portalName: String(parsed.portalName || ""),
      portalPlatform: String(parsed.portalPlatform || ""),
      portalUrl: String(parsed.portalUrl || ""),
      submissionMethod: String(parsed.submissionMethod || ""),
      requiredDocuments: arr(parsed.requiredDocuments),
      smartInverterSettings: String(parsed.smartInverterSettings || ""),
      meterAggregation: String(parsed.meterAggregation || ""),
      acDisconnectRule: String(parsed.acDisconnectRule || ""),
      exportLimitNote: String(parsed.exportLimitNote || ""),
      commonCorrections: arr(parsed.commonCorrections),
      tips: arr(parsed.tips),
      submissionSteps: arr(parsed.submissionSteps),
      confidence: (["low", "medium", "high"].includes(String(parsed.confidence)) ? parsed.confidence : "low") as "low" | "medium" | "high",
      needsHumanVerification: true,
      notes: webGrounded
        ? "Researched from the utility's official interconnection page via web search. Human-verify before relying on it; the first real submittal will confirm/correct these requirements."
        : "Web search was unavailable — researched from model knowledge only. Verify against the utility's official interconnection page before relying on it.",
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
Respond with ONLY a valid JSON array: [{"index":N,"field":"fieldKey"|null}]`;

    const user = `Known project/client fields:
${JSON.stringify(fieldRef, null, 2)}

Unbound portal form interactions to classify:
${JSON.stringify(input.unbound, null, 2)}`;

    const raw = await this.ask("suggestRecipeFieldBindings", system, user);
    const suggestions = this.parseJson<Array<{ index: number; field: string | null }>>(raw, []);
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
- For an electrical-services / fee page that lists many capacity tiers, fill ONLY the renewable-energy / PV tier matching the system's DC nameplate (systemSizeDcKw) and leave the other count fields EMPTY (not 0). If a tier takes a count, it is normally "1"; only a single "total kVA" field takes the kVA number. A "Category of Construction"/"Type of Work" select with no project value → use the most generic option ("Other" → reveals a text field, fill "Solar"; type of work → "New").
- SYSTEM ADDITIONS / MODIFICATIONS: when the project DATA carries existing-system fields (hasExistingSystem, existingSystemSizeDcKw, existingInverterMake/Model, nemTariff, …), the application must DISCLOSE the existing system: "existing generation on site?" → Yes; existing size/equipment fields → the existing* keys (existingSystemSizeDcKw, existingInverterMake, existingInverterModel, existingModuleMake, existingModuleModel, existingBatteryMakeModel); "total"/"combined"/"aggregate" system size after the addition → totalSystemSizeDcKw / totalSystemSizeAcKw — NEVER the new-only systemSizeDcKw. Plain "system size" for the NEW equipment being added stays systemSizeDcKw/systemSizeAcKw. Existing NEM agreement/application numbers are sensitive — bind field: "existingNemAgreementNumber" / "existingNemApplicationNumber" only, never a literal.
- A required DATE field with no project value (e.g. an estimated commissioning date) → use todayDate plus a few weeks, formatted MM/DD/YYYY.
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
Return ONLY JSON:
{"fills":[{"index":<field index>,"value":"<string>","field":"<projectFieldKey or omit>"}],
 "navigateIndex": <index of dashboard nav link, or omit>,
 "advanceIndex": <index or omit>, "finalSubmitIndex": <index or omit>,
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
      const raw = input.screenshotBase64
        ? await this.askLongWithImage("planPortalFields.vision", system, user, input.screenshotBase64, "image/png", 8192)
        : await this.askLong("planPortalFields", system, user, 8192);
      parsed = this.parseJson<Partial<PortalFieldPlan>>(raw, {});
    } catch { parsed = {}; }
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
    try { parsed = this.parseJson<Partial<PortalFillVerification>>(await this.ask("verifyPortalFill", system, user), {}); } catch { parsed = {}; }
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
      const msg = await this.instrument("verifyPortalFillVision", { effort: "high", image: true }, () =>
        this.client.messages.create({ model: MODEL, max_tokens: 3072, thinking: { type: "adaptive" }, output_config: { effort: "high" }, system: this.cachedSystem(system), messages: [{ role: "user", content: user }] }),
      );
      parsed = this.parseJson<Partial<PortalFillVerification>>(this.textOf(msg), {});
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
  private async askWithWebSearch(label: string, systemPrompt: string, userMessage: string, maxTokens = 1024, maxUses = 3, timeoutMs = 45000): Promise<string> {
    // Hard timeout so a stalled web search can never hang the HTTP request (the
    // "Find official form" button would otherwise spin forever). On timeout we
    // abort the stream; callers catch and fall back (no URLs / model knowledge).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const msg = await this.instrument(label, { chars: userMessage.length, maxTokens, webSearch: maxUses, timeoutMs }, () =>
        this.client.messages
          .stream(
            {
              model: MODEL,
              max_tokens: maxTokens,
              thinking: { type: "adaptive" },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxUses }] as any,
              system: this.cachedSystem(systemPrompt),
              messages: [{ role: "user", content: userMessage }],
            },
            { signal: controller.signal },
          )
          .finalMessage(),
      );
      // Surface how much searching actually happened — server_tool_use blocks of
      // type web_search are the real round-trips, useful when results look thin.
      const searches = msg.content.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (b) => (b as any).type === "server_tool_use" && (b as any).name === "web_search",
      ).length;
      if (searches) logger.debug("llm", `  ${label} web_search ran`, { queries: searches });
      return this.textOf(msg);
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
    if (model) {
      try {
        parsed = this.parseJson(await this.ask("lookupInverterSpec", system, `Model / part number: ${model}`), {});
      } catch { parsed = {}; }

      // Web fallback when knowledge is unsure/unknown — search the manufacturer datasheet
      // AND the part number, with more uses for an exhaustive look.
      if (parsed.outputCurrentA == null || parsed.confidence === "low") {
        try {
          const webRaw = await this.askWithWebSearch(
            "lookupInverterSpec.web",
            `${system}\nSearch the web thoroughly for the official manufacturer datasheet for this EXACT model OR part number, then return the JSON. Try the manufacturer's site, distributor spec pages, and the part number itself. Put the datasheet URL in "notes".`,
            `Find the rated continuous AC output current (amps) for inverter model/part number: ${model}`,
            1500,
            6,
          );
          const webParsed = this.parseJson<typeof parsed>(webRaw, {});
          if (webParsed.outputCurrentA != null) { parsed = webParsed; source = "web search"; }
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
2. Open that forms page and pull the DIRECT links to the blank building permit application AND the electrical permit application PDFs (residential solar usually needs BOTH a BLD and an ELE permit).
3. Return every blank-form PDF you find, best/most-relevant first.

Return ONLY JSON:
{
  "formName": "<the official form's title (or 'Building + Electrical permit applications')>",
  "candidateUrls": ["<direct https URL(s) that download a blank PDF, best first — only URLs you actually found, ending in .pdf or a direct download>"],
  "formsPageUrl": "<the AHJ forms/applications landing page you found these on, or ''>",
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
    const userMsg = `AHJ: ${input.ahj}\nState: ${input.state}\nForm needed: residential solar ${formType.replace(/_/g, " ")} (building + electrical permit applications).${input.knownContext ? `\n\n${input.knownContext}\nStart from the known portal/URLs above when searching.` : ""}\nFind the AHJ's forms/applications page and the direct blank PDF links.`;
    let parsed: Partial<AhjFormUrlResult> = {};
    let lookupError = "";
    try {
      // A GROUNDED SEARCH NEEDS A GROUNDED BUDGET. This ran on askWithWebSearch's 45-second
      // default while making up to three web searches, and on City of Salem it aborted at
      // 45,016ms — after which the harvest reported "research found no forms page", a claim
      // about the jurisdiction rather than about us. The fee researcher already uses 240s for
      // the same kind of call (FEE_RESEARCH_CLIENT_TIMEOUT_MS); this matches it and stays
      // env-overridable for a machine on a slower link.
      const budgetMs = Math.max(45000, Number(process.env.AHJ_FORM_LOOKUP_TIMEOUT_MS) || 180000);
      // 1024 was the signature default and far too small for this call: with the budget fixed it
      // stopped timing out and immediately hit max_tokens instead (outTok 2918, stop=max_tokens),
      // truncating the JSON so it parsed to {} — which the harvest then read as "this AHJ has no
      // forms page". The sibling research calls all use 3000; this one returns several URLs plus
      // notes after three searches, so it gets more.
      const raw = await this.askWithWebSearch("findAhjFormUrl", system, userMsg, 4000, 3, budgetMs);
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
      logger.warn("llm", "findAhjFormUrl web search failed", { ahj: input.ahj, state: input.state, err: lookupError });
    }
    const urls = Array.isArray(parsed.candidateUrls)
      ? parsed.candidateUrls.map((u) => String(u)).filter((u) => /^https?:\/\//i.test(u))
      : [];
    const portalUrl = /^https?:\/\//i.test(String(parsed.submittalPortalUrl || "")) ? String(parsed.submittalPortalUrl) : "";
    const formsPageUrl = /^https?:\/\//i.test(String(parsed.formsPageUrl || "")) ? String(parsed.formsPageUrl) : "";
    return {
      provider: "claude",
      formName: String(parsed.formName || ""),
      candidateUrls: urls,
      formType,
      confidence: (["low", "medium", "high"].includes(String(parsed.confidence)) ? parsed.confidence : "low") as "low" | "medium" | "high",
      notes: String(parsed.notes || ""),
      formsPageUrl,
      submissionMethod: String(parsed.submissionMethod || ""),
      submittalPortalUrl: portalUrl,
      portalPlatform: String(parsed.portalPlatform || ""),
      submittalRequirements: String(parsed.submittalRequirements || ""),
      permitStructure: (["combo", "separate", "unknown"].includes(String(parsed.permitStructure)) ? parsed.permitStructure : "unknown") as "combo" | "separate" | "unknown",
      // "We could not look" is a different report from "we looked and there is nothing".
      lookupFailed: Boolean(lookupError),
      lookupError,
    };
  }

  // The AVAILABLE DATA SOURCES list annotates entries with a trailing
  // "  (explanation)" — models occasionally echo the annotation back with the
  // source (sometimes whitespace-normalized to a single space). Dotted sources
  // never contain whitespace, so keep only the first token; "lit:" literals
  // legitimately carry spaces and keep everything before a 2+-space gap.
  private cleanFieldSourceString(raw: string): string {
    const s = raw.split(/\s{2,}/)[0].trim();
    return s.startsWith("lit:") ? s : s.split(/\s+/)[0];
  }

  async mapAcroFormFields(input: {
    ahj: string;
    state: string;
    formName: string;
    fields: { name: string; type: string }[];
    availableSources: string[];
  }): Promise<AhjFieldMapResult> {
    const system = `You map a blank permit PDF's form fields onto a solar project's known data, so the form can be auto-filled.

You are given the form's AcroForm FIELD NAMES (and types) and the list of AVAILABLE DATA SOURCES. For each form field you can confidently fill, choose the single best matching source. Leave a field out entirely if no source clearly matches (do not guess).

Source syntax (use these EXACT strings):
- "project.<key>" / "snapshot.<key>" / "client.<key>" / "computed.<key>" — pull from project data
- "lit:<text>" — a literal constant (use for fixed marks, e.g. "lit:X" for a checkbox, "lit:Solar")

Return ONLY JSON:
{
  "textFields": { "<exact form field name>": "<source string>", ... },
  "checkboxes": { "<exact checkbox field name>": { "source": "<source string>", "equals": "<optional value to compare>" }, ... },
  "notes": "<short note on anything ambiguous or left blank, e.g. signature/date fields left for the human>"
}
Rules:
- Use the EXACT field names provided (case/spacing matters). Source strings are the part BEFORE any "(...)" annotation in the sources list.
- Put checkbox-type fields in "checkboxes", text fields in "textFields".
- COMPLIANCE-CHECKLIST forms (rows of Yes/No or Complies checkboxes): for the STRUCTURAL PRESCRIPTIVE rows (roof mount, light-frame construction, risk category, ground snow load, wind exposure, wind speed, rafter/truss spacing, PV dead load, module height above roof, roofing layers) map the row's Yes box to the matching "computed.presc<Criterion>Yes" source and its No box to "computed.presc<Criterion>No" — these resolve from the project's parsed data and stay blank when unverified. A single "meets all prescriptive criteria" attestation box maps to "computed.prescAllYes". For rows a code-standard residential rooftop PV install satisfies by definition (listed equipment, rapid shutdown, racking per manufacturer letter), map "lit:X"; skip rows needing project-specific measurements with no matching source and name them in "notes". The mapping is human-verified before real use — a mostly-complete checklist beats an empty one.
- "computed.presc*Answer" sources return the word Yes/No — use them ONLY in "textFields" (a written Yes/No blank), never as a checkbox source.
- NEVER map signature, date-signed, or fee-payment fields — leave them for the human.
- NEVER map utility account number or meter number onto a public form field unless the field name explicitly asks for it.
- Return valid JSON only.`;
    const userMsg = `AHJ: ${input.ahj} (${input.state})
Form: ${input.formName}

FORM FIELDS (name | type):
${input.fields.slice(0, 200).map((f) => `${f.name} | ${f.type}`).join("\n")}

AVAILABLE DATA SOURCES:
${input.availableSources.join("\n")}`;
    let parsed: Partial<AhjFieldMapResult> = {};
    try {
      parsed = this.parseJson(await this.askLong("mapAcroFormFields", system, userMsg, 4096), {});
    } catch (err) {
      logger.warn("llm", "mapAcroFormFields failed", { err: errMsg(err) });
    }
    const textFields: Record<string, string> = {};
    if (parsed.textFields && typeof parsed.textFields === "object") {
      for (const [k, v] of Object.entries(parsed.textFields)) {
        const src = this.cleanFieldSourceString(String(v));
        if (k && src && /^(project|snapshot|client|computed)\.|^lit:/.test(src)) textFields[k] = src;
      }
    }
    const checkboxes: Record<string, { source: string; equals?: string }> = {};
    if (parsed.checkboxes && typeof parsed.checkboxes === "object") {
      for (const [k, v] of Object.entries(parsed.checkboxes)) {
        const rule = v as { source?: unknown; equals?: unknown };
        let src = this.cleanFieldSourceString(String(rule?.source || ""));
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
    return { provider: "claude", textFields, checkboxes, notes: String(parsed.notes || "") };
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
- "label": the form's printed label for this blank (for human review)

ALSO locate every SIGNATURE line (where a handwritten signature goes) and return it under "signatures" with:
- "role": whose signature — one of "applicant","owner","contractor","electrician","other". Infer from the label: "supervising electrician","licensed electrician","electrician signature" → "electrician"; "property owner","homeowner" → "owner"; "contractor" → "contractor"; the main submittal/authorized signature → "applicant"
- "page": 0-based page index
- "nx","ny": normalized position of the BOTTOM-LEFT corner of the signature area (just above the signature line, at its left)
- "widthFrac","heightFrac": the signature area size as a fraction of page width/height (a signature line is typically ~0.25 wide, ~0.04 tall)
- "dateNx","dateNy": if there is a "date" line right next to this signature, the normalized baseline position to write the date; omit if there is none
- "label": the printed signature label

Return ONLY JSON: {"fields":[ ... ], "signatures":[ ... ], "notes":"<caveats>"}

Rules:
- Place a value ONLY where you can clearly see the matching labeled blank. Do not guess positions.
- Do NOT put text in "fields" for signature or date-signed lines — signature lines go in "signatures"; leave date-signed for the human.
- PRINT-NAME LINES: a "Print name" / "Printed name" / "Name (print)" blank next to or under a SIGNATURE line is a regular text field, not a signature — place "computed.applicantSignerName" there (or "computed.electricianSignerName" when the adjacent signature is the electrician's). These are routinely left blank by mappers and then bounced by the AHJ; map them whenever the signer is the applicant/agent.
- For checkboxes (e.g. "Type of work: Other"), use source "lit:X" placed at the box.
- COMPLIANCE CHECKLISTS (e.g. a prescriptive solar checklist where each row has Yes/No or Complies boxes): for the STRUCTURAL PRESCRIPTIVE rows (roof mount, light-frame construction, risk category, ground snow load, wind exposure, wind speed, rafter/truss spacing, PV dead load, module height above roof, roofing layers) place the matching "computed.presc<Criterion>Yes" source at the row's Yes/Complies box and "computed.presc<Criterion>No" at its No box — each draws an "X" only when the project's parsed data answers that way, so an unverified row stays blank for the operator. A single "meets all prescriptive criteria" box gets "computed.prescAllYes". Written blanks on those rows (e.g. "Ground snow load: ___ psf") take the matching "snapshot.*" value source. For rows a code-standard residential rooftop PV install satisfies by definition (flush roof mount, listed equipment, engineered racking per manufacturer letter, rapid shutdown, permitted conductor sizing), place "lit:X" in the Yes/Complies box. SKIP rows requiring project-specific data with no matching source (spans, site distances) — list those skipped rows in "notes" so the operator finishes them. The map is human-verified before real use, so favor covering the standard rows over leaving the checklist blank.
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
      const msg = await this.instrument("mapFlatFormOverlay", { pages: input.pages.length, effort: "high" }, () =>
        this.client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          system: this.cachedSystem(system),
          messages: [{ role: "user", content }],
        }),
      );
      raw = this.textOf(msg);
    } catch (err) {
      logger.warn("llm", "mapFlatFormOverlay failed", { err: errMsg(err) });
    }
    const parsed = this.parseJson<{ fields?: unknown[]; signatures?: unknown[]; notes?: string }>(raw, {});
    const fields: AhjOverlayMapResult["fields"] = [];
    if (Array.isArray(parsed.fields)) {
      for (const f of parsed.fields) {
        const o = f as Record<string, unknown>;
        const source = this.cleanFieldSourceString(String(o.source || ""));
        const nx = Number(o.nx);
        const ny = Number(o.ny);
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
    return { provider: "claude", fields, signatures, notes: String(parsed.notes || "") };
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
    const effort = input.effort ?? "medium";
    const toolByName = new Map(input.tools.map((t) => [t.name, t]));
    const apiTools = input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: input.user }];
    let finalText = "";
    let iterations = 0;
    let stopReason: string | null = null;

    for (; iterations < maxIterations; iterations++) {
      const msg = await this.instrument(`${input.label}#${iterations + 1}`, { tools: apiTools.length, effort }, () =>
        this.client.messages
          .stream({
            model: MODEL,
            max_tokens: 4096,
            thinking: { type: "adaptive" },
            output_config: { effort },
            system: this.cachedSystem(input.system),
            tools: apiTools,
            messages,
          })
          .finalMessage(),
      );
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
  logger.info("llm", "Claude provider ready", { model: MODEL });
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
