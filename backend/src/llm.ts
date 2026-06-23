import Anthropic from "@anthropic-ai/sdk";
import type { AhjFieldMapResult, AhjFormUrlResult, AhjOverlayMapResult, AhjResearchResult, CorrectionBucket, InverterSpecLookup, LLMProvider, MboxExtractedLearningRecord, ParserLlmExtraction, PortalFieldPlan, PortalFieldPlanInput, PortalFillVerification, PortalFillVerifyInput, ProjectRecord, UtilityResearchResult } from "../../shared/src/types";
import { RECIPE_FIELD_DESCRIPTIONS } from "./portalRecipes";

const MODEL = "claude-opus-4-8";

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

export class ClaudeLLMProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  private async ask(systemPrompt: string, userMessage: string): Promise<string> {
    const stream = await this.client.messages.stream({
      model: MODEL,
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    const msg = await stream.finalMessage();
    for (const block of msg.content) {
      if (block.type === "text") return block.text;
    }
    return "";
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
    const raw = await this.ask(system, JSON.stringify(input));
    return this.parseJson<Record<string, unknown>>(raw, { provider: "claude", confidence: 0 });
  }

  // Larger budget than ask() — plan sets are dense and we want every field.
  private async askLong(systemPrompt: string, userMessage: string, maxTokens = 4096): Promise<string> {
    const stream = await this.client.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    const msg = await stream.finalMessage();
    for (const block of msg.content) {
      if (block.type === "text") return block.text;
    }
    return "";
  }

  async extractProjectFields(input: {
    planText?: string;
    utilityBillText?: string;
    meterText?: string;
    defaultState?: string;
  }): Promise<ParserLlmExtraction> {
    const system = `You are an expert solar permit intake specialist. You read the raw extracted text of a residential solar project's documents and pull out every field a permit/interconnection application needs. The text comes from PDF extraction and OCR, so it may be noisy, out of order, or have character errors — use judgment and cross-check between documents.

You are given up to three documents:
- PLAN_SET: the engineering plan set (cover sheet, site plan, electrical SLD, datasheets). Best source for system size, equipment, roof, AHJ.
- UTILITY_BILL: the electric utility bill. Best source for homeowner name(s), service address, utility company, account number, and sometimes meter number.
- METER_PHOTO: OCR of a photo of the electric meter. Best source for the meter number/serial.

Return ONLY a JSON object of this exact shape:
{
  "fields": {
    "<fieldId>": { "value": <string|number|null>, "confidence": <0..1>, "evidence": { "source": "plan_set|utility_bill|meter_photo", "sheet": "<sheet/page hint e.g. PV-2 or Cover>", "excerpt": "<short verbatim text you read it from>" } }
  },
  "lowConfidenceFields": ["<fieldId>", ...],
  "notes": "<short notes on anything ambiguous or worth a human double-check>"
}

EVIDENCE IS REQUIRED for accuracy: for every field, include an "evidence" object citing where you read it (which document, the sheet/page hint if visible, and a short verbatim excerpt). This lets a human verify the value. If you cannot cite a source, lower confidence and add the field to lowConfidenceFields.

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
ELECTRICAL (read from the SLD / one-line and load calc — critical for plan review)
- busRating: main service panel (MSP) busbar rating in amps (e.g. "200A")
- mainBreaker: main breaker / main service rating in amps (e.g. "200A")
- pvBreaker: PV backfeed breaker / OCPD size in amps (e.g. "40A")
- acDiscReq: AC/manual disconnect — "yes/required/provided/shown" if a lockable visible load-break disconnect is shown, else note the exception
STRUCTURAL (read from structural notes / roof framing plan — drive prescriptive screening)
- snow: ground snow load in PSF (number)
- deadLoad: PV dead load in PSF (number)
- roofRafterSpacing: rafter/truss spacing in inches on-center (number, e.g. 24)
- roofRafterSpan: rafter span (number, feet) if given
- wind: wind exposure category letter (e.g. "B" or "C")
- permitPath: "prescriptive" or "engineered" if determinable
UTILITY INTERCONNECTION (PGE PowerClerk / Pacific Power customer generation NEM)
- utilitySchedule: the utility rate schedule from the bill (e.g. PGE "Schedule 7", Pacific Power "Schedule 4")
- serviceVoltage: service voltage (e.g. "240V")
- servicePhase: "single-phase" or "three-phase"
- numberOfCircuits: number of PV backfeed circuits/strings (number)
- azimuth: array azimuth in degrees (number), tilt: array tilt/pitch in degrees (number), roofSlope: roof slope (e.g. "4:12" or degrees)
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

Rules:
- Set confidence honestly; put anything <0.6 or guessed into lowConfidenceFields.
- Account/meter numbers: only digits you can actually read; never invent or pad. Join spaced account segments (e.g. "65564191-001 4" -> "65564191-0014"); do not drop a trailing check digit.
- Electrical amps/structural loads come from the PLAN SET (SLD, datasheets, structural notes) — not the bill.
- Prefer the utility bill for name/address/account, the meter photo for meter number, the plan set for everything else.
- Numbers must be JSON numbers. Return valid JSON only — no prose outside the JSON.`;

    const parts: string[] = [];
    if (input.defaultState) parts.push(`(Default state hint if ambiguous: ${input.defaultState})`);
    if (input.planText?.trim()) parts.push(`=== PLAN_SET ===\n${input.planText.slice(0, 24000)}`);
    if (input.utilityBillText?.trim()) parts.push(`=== UTILITY_BILL ===\n${input.utilityBillText.slice(0, 8000)}`);
    if (input.meterText?.trim()) parts.push(`=== METER_PHOTO ===\n${input.meterText.slice(0, 2000)}`);
    if (!parts.length) {
      return { provider: "claude", fields: {}, lowConfidenceFields: [], notes: "No document text supplied." };
    }

    // Generous budget: every field now carries evidence + several narrative
    // blobs, so the JSON is large. Too small a budget truncates it (unparseable).
    const raw = await this.askLong(system, parts.join("\n\n"), 16000);
    return this.normalizeExtraction(raw, "Could not parse LLM response.");
  }

  // Shared parser for both text and vision extraction results — captures
  // value, confidence, and evidence (provenance) per field.
  private normalizeExtraction(raw: string, parseFailNote: string): ParserLlmExtraction {
    const parsed = this.parseJson<{
      fields?: Record<string, { value: unknown; confidence?: number; evidence?: { source?: string; sheet?: string; excerpt?: string } }>;
      lowConfidenceFields?: string[];
      notes?: string;
    }>(raw, { fields: {}, lowConfidenceFields: [], notes: parseFailNote });

    const fields: ParserLlmExtraction["fields"] = {};
    for (const [key, entry] of Object.entries(parsed.fields || {})) {
      if (!entry || entry.value == null || entry.value === "") continue;
      const value = typeof entry.value === "number" ? entry.value : String(entry.value).trim();
      if (value === "") continue;
      const confidence = typeof entry.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : 0.5;
      const ev = entry.evidence;
      const evidence = ev && (ev.sheet || ev.excerpt || ev.source)
        ? {
            source: (["plan_set", "utility_bill", "meter_photo"].includes(String(ev.source)) ? ev.source : "plan_set") as "plan_set" | "utility_bill" | "meter_photo",
            sheet: ev.sheet ? String(ev.sheet).slice(0, 40) : undefined,
            excerpt: ev.excerpt ? String(ev.excerpt).slice(0, 200) : undefined,
          }
        : undefined;
      fields[key] = { value: value as string | number, confidence, evidence };
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
- UTILITY_BILL: the electric bill. Read the homeowner name, full service address, utility company, the ACCOUNT NUMBER exactly as printed, and the meter number from the account-activity table. Account numbers are often shown in spaced segments (e.g. "65564191-001 4") — that is ONE account number "65564191-0014"; join the segments and never drop a trailing check digit.
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

    const msg = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content }],
    });
    let raw = "";
    for (const block of msg.content) if (block.type === "text") raw += block.text;
    return this.normalizeExtraction(raw, "Could not parse vision response.");
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
    const raw = await this.ask(system, `${ctx}Correction text:\n${input.correctionText}`);
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
    const raw = await this.ask(system, `${ctx}Correction request:\n${input.correctionText}`);
    return this.parseJson<{ draft: string; confidence: number }>(raw, { draft: "", confidence: 0 });
  }

  async visionExtract(input: { imageBase64: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; prompt: string }): Promise<Record<string, unknown>> {
    const msg = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2048,
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
    });
    for (const block of msg.content) {
      if (block.type === "text") {
        return this.parseJson<Record<string, unknown>>(block.text, { provider: "claude-vision", raw: block.text });
      }
    }
    return { provider: "claude-vision", confidence: 0 };
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
    const raw = await this.ask(system, userMsg);
    return this.parseJson(raw, { requiredDocuments: [], commonRejectionReasons: [], tips: [], confidence: "low" as const });
  }

  async researchAhjRequirements(input: { ahj: string; state: string; utility?: string }): Promise<AhjResearchResult> {
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
    const userMsg = `AHJ: ${input.ahj}\nState: ${input.state}${input.utility ? `\nUtility: ${input.utility}` : ""}\n\nResearch the residential solar permitting + interconnection requirements for this jurisdiction.`;
    // Web-grounded first (accurate for never-seen AHJs); fall back to model
    // knowledge if the search is unreachable so the call never hard-fails.
    let parsed: Partial<AhjResearchResult> = {};
    let webGrounded = false;
    try {
      const raw = await this.askWithWebSearch(system, userMsg, 3000, 5);
      const p = this.parseJson<Partial<AhjResearchResult>>(raw, {});
      if (p && (p.portalName || (Array.isArray(p.requiredDocuments) && p.requiredDocuments.length))) {
        parsed = p;
        webGrounded = true;
      }
    } catch (err) {
      console.warn("[llm] researchAhjRequirements web search failed:", err instanceof Error ? err.message : String(err));
    }
    if (!webGrounded) {
      const raw = await this.askLong(system, userMsg, 3000);
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

  async researchUtilityRequirements(input: { utility: string; state: string; ahj?: string }): Promise<UtilityResearchResult> {
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
    const userMsg = `Utility: ${input.utility}\nState: ${input.state}${input.ahj ? `\nAHJ context: ${input.ahj}` : ""}\n\nResearch the residential solar net-metering / interconnection requirements for this utility.`;
    // Web-grounded first; fall back to model knowledge if search is unreachable.
    let parsed: Partial<UtilityResearchResult> = {};
    let webGrounded = false;
    try {
      const raw = await this.askWithWebSearch(system, userMsg, 3000, 5);
      const p = this.parseJson<Partial<UtilityResearchResult>>(raw, {});
      if (p && (p.portalName || (Array.isArray(p.requiredDocuments) && p.requiredDocuments.length))) {
        parsed = p;
        webGrounded = true;
      }
    } catch (err) {
      console.warn("[llm] researchUtilityRequirements web search failed:", err instanceof Error ? err.message : String(err));
    }
    if (!webGrounded) {
      const raw = await this.askLong(system, userMsg, 3000);
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

    const raw = await this.ask(system, user);
    const suggestions = this.parseJson<Array<{ index: number; field: string | null }>>(raw, []);
    const validKeys = new Set(Object.keys(input.fieldValues));
    return suggestions
      .filter((s) => typeof s.index === "number")
      .map((s) => ({ index: s.index, field: s.field && validKeys.has(s.field) ? s.field : null }));
  }

  async planPortalFields(input: PortalFieldPlanInput): Promise<PortalFieldPlan> {
    const system = `You are filling a government/utility permit portal form for a solar project. Given the FIELDS (fillable inputs, buttons, and navigation links) on the current page and the project's available DATA, decide what to fill, which button navigates to the form (if on a dashboard), which button advances to the next page, and which button is the FINAL SUBMIT.

ADDRESS SEARCH & JURISDICTION SELECTION (Accela / Oregon ePermitting and similar):
- The SAME street address can appear MULTIPLE times in a results grid under different jurisdictions — e.g. "CITY APPLICATIONS" (the city) vs "COUNTY APPLICATIONS" (the county). These are DIFFERENT permitting authorities and expose DIFFERENT application-type lists. Picking the wrong row gets the wrong permit.
- When jurisdictionContext is provided, use it to choose the correct "Select" link: pick the row whose city/county matches the target jurisdiction for THIS permit discipline, and put that row's Select link in navigateIndex.
- After a row is selected, an application-type checklist appears. The "permitDiscipline" in jurisdictionContext tells you which ONE to check:
  - "structural" → check the Building/Structural type (e.g. "Residential - Structural"); this is usually under the CITY's list.
  - "electrical" → check the Electrical type (e.g. "Residential - Electrical"). If the city's list has NO electrical option, select the COUNTY APPLICATIONS row for the SAME address instead, then check "Residential - Electrical".
  - Check EXACTLY ONE application type matching the discipline — put that checkbox in "fills" with value "true". Never check multiple application types.
- One jurisdiction + one discipline per run. Do not try to file both structural and electrical in the same pass.

ELECTRICAL SERVICES PAGE (Accela "Residential - Electrical Comprehensive" and similar):
- This page lists MANY count fields — services/feeders by amperage tier, temp services, branch circuits, residential wiring sq ft, renewable energy by kVA tier, etc. For a SOLAR project, fill ONLY the renewable-energy field whose kVA tier matches the system, and leave EVERY other count field blank (do not put 0 — leave empty).
- Pick the kVA tier from the DC NAMEPLATE size (systemSizeDcKw — the larger value; the jurisdiction keys the fee to the DC nameplate, NOT the AC inverter output):
  - ≤ 5 kVA → "Renewable energy for electrical systems - 5kva or less"
  - 5.01–15 kVA → the "5.01kva through 15kva" field
  - 15.01–25 kVA → the "15.01kva through 25kva" field
  - > 25 kVA → "Renewable Energy - solar generation over 25 kva" (enter the TOTAL kVA here, not a count)
  For the ≤25 kVA tiers, the value is the COUNT of systems — normally "1". Only the >25 field takes the total kVA. (Example: 5.280 kW DC → the 5.01–15 kVA field = "1".)
- Required selects, with the values a residential solar install uses:
  - "Category of Construction" → "Other" (this reveals a required "Other Category of Construction" text field → enter "Solar").
  - "Type of Work" → "New".
  - "Project includes any of the following" → "Not Applicable" (e.g. "01-Not Applicable").
- "Plan Review Required" radio: leave its default (typically "No") unless the page clearly requires Yes; never flip it on speculatively.

DASHBOARD / HOME PAGES:
- If isDashboard=true (no fillable inputs — only buttons and navigation links), the bot just logged in and landed on the portal home/dashboard. Your ONLY job is to return "navigateIndex": the index of the link or button that starts a new application / interconnection request / permit application. Look for labels like "New Application", "Start Application", "New Pacific Power Customer Generation Application", "Start New Project", "Apply Now", "Create Application", or a tab/link for the relevant program. Set fills=[], advanceIndex=omit, atReview=false, and ONLY navigateIndex. Do NOT treat any dashboard navigation link as advanceIndex.

HARD SAFETY RULES:
- NEVER choose a pay / payment / fee / checkout / invoice button as "advance", "navigate", or anything to click. Omit it entirely.
- The final submit button is RECORDED ONLY (finalSubmitIndex) and is NEVER clicked — do not put it in advanceIndex.
- "advanceIndex" is ONLY a Next/Continue/Save-and-continue button that goes to the next INPUT page (not the final submit).
- BEWARE DECOY PAGER BUTTONS: some portals (PowerClerk) render BOTH a form-advance button labeled exactly "Next" (or "Continue", "Save & Continue") AND a header document/page pager labeled "Next page" / "Previous page". The pager does NOT advance the wizard — choosing it leaves the form stuck on the same step. Always prefer the exact "Next"/"Continue" wizard button; NEVER pick "Next page"/"Previous page"/"Page N" as advanceIndex.
- CRITICAL (Accela "Continue Application" trap): if this page is a READ-ONLY REVIEW/CONFIRM page (no fillable inputs — only a summary of previously entered data + Edit links, or body text like "Step N: Review" / "review all information" / "click the Continue Application button below" / "(Read-only)"), then set atReview=true and treat the primary button (even if labeled "Continue Application" or "Continue") as the finalSubmitIndex — NEVER as advanceIndex. On Oregon ePermitting/Accela, "Continue Application" advances on input pages but SUBMITS on the Review step. When in doubt and there are no fields to fill, STOP (atReview=true) and record the button as final submit.
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
    });
    let parsed: Partial<PortalFieldPlan> = {};
    // Use askLong: planning responses can be large (many fills + notes).
    try { parsed = this.parseJson<Partial<PortalFieldPlan>>(await this.askLong(system, user, 3000), {}); } catch { parsed = {}; }
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
    try { parsed = this.parseJson<Partial<PortalFillVerification>>(await this.ask(system, user), {}); } catch { parsed = {}; }
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

  // Ask with the server-side web search tool enabled (used as the spec-lookup fallback).
  private async askWithWebSearch(systemPrompt: string, userMessage: string, maxTokens = 1024, maxUses = 3, timeoutMs = 45000): Promise<string> {
    // Hard timeout so a stalled web search can never hang the HTTP request (the
    // "Find official form" button would otherwise spin forever). On timeout we
    // abort the stream; callers catch and fall back (no URLs / model knowledge).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const stream = await this.client.messages.stream(
        {
          model: MODEL,
          max_tokens: maxTokens,
          thinking: { type: "adaptive" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxUses }] as any,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        },
        { signal: controller.signal },
      );
      const msg = await stream.finalMessage();
      let out = "";
      for (const block of msg.content) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((block as any).type === "text") out += (block as any).text;
      }
      return out;
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
        parsed = this.parseJson(await this.ask(system, `Model / part number: ${model}`), {});
      } catch { parsed = {}; }

      // Web fallback when knowledge is unsure/unknown — search the manufacturer datasheet
      // AND the part number, with more uses for an exhaustive look.
      if (parsed.outputCurrentA == null || parsed.confidence === "low") {
        try {
          const webRaw = await this.askWithWebSearch(
            `${system}\nSearch the web thoroughly for the official manufacturer datasheet for this EXACT model OR part number, then return the JSON. Try the manufacturer's site, distributor spec pages, and the part number itself. Put the datasheet URL in "notes".`,
            `Find the rated continuous AC output current (amps) for inverter model/part number: ${model}`,
            1500,
            6,
          );
          const webParsed = this.parseJson<typeof parsed>(webRaw, {});
          if (webParsed.outputCurrentA != null) { parsed = webParsed; source = "web search"; }
        } catch (err) {
          console.warn("[llm] inverter spec web fallback failed:", err instanceof Error ? err.message : String(err));
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

  async findAhjFormUrl(input: { ahj: string; state: string; formType?: string }): Promise<AhjFormUrlResult> {
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
    const userMsg = `AHJ: ${input.ahj}\nState: ${input.state}\nForm needed: residential solar ${formType.replace(/_/g, " ")} (building + electrical permit applications).\nFind the AHJ's forms/applications page and the direct blank PDF links.`;
    let parsed: Partial<AhjFormUrlResult> = {};
    try {
      parsed = this.parseJson(await this.askWithWebSearch(system, userMsg), {});
    } catch (err) {
      console.warn("[llm] findAhjFormUrl web search failed:", err instanceof Error ? err.message : String(err));
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
    };
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
- Use the EXACT field names provided (case/spacing matters).
- Put checkbox-type fields in "checkboxes", text fields in "textFields".
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
      parsed = this.parseJson(await this.askLong(system, userMsg, 4096), {});
    } catch (err) {
      console.warn("[llm] mapAcroFormFields failed:", err instanceof Error ? err.message : String(err));
    }
    const textFields: Record<string, string> = {};
    if (parsed.textFields && typeof parsed.textFields === "object") {
      for (const [k, v] of Object.entries(parsed.textFields)) {
        const src = String(v);
        if (k && src && /^(project|snapshot|client|computed)\.|^lit:/.test(src)) textFields[k] = src;
      }
    }
    const checkboxes: Record<string, { source: string; equals?: string }> = {};
    if (parsed.checkboxes && typeof parsed.checkboxes === "object") {
      for (const [k, v] of Object.entries(parsed.checkboxes)) {
        const rule = v as { source?: unknown; equals?: unknown };
        const src = String(rule?.source || "");
        if (k && src && /^(project|snapshot|client|computed)\.|^lit:/.test(src)) {
          checkboxes[k] = rule.equals != null ? { source: src, equals: String(rule.equals) } : { source: src };
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
- For checkboxes (e.g. "Type of work: Other"), use source "lit:X" placed at the box.
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
      const msg = await this.client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content }],
      });
      for (const block of msg.content) if (block.type === "text") raw += block.text;
    } catch (err) {
      console.warn("[llm] mapFlatFormOverlay failed:", err instanceof Error ? err.message : String(err));
    }
    const parsed = this.parseJson<{ fields?: unknown[]; signatures?: unknown[]; notes?: string }>(raw, {});
    const fields: AhjOverlayMapResult["fields"] = [];
    if (Array.isArray(parsed.fields)) {
      for (const f of parsed.fields) {
        const o = f as Record<string, unknown>;
        const source = String(o.source || "");
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
    console.warn("[llm] No ANTHROPIC_API_KEY — running in stub mode (advisory only).");
    return new StubLLMProvider();
  }
  if (!/^sk-ant-/.test(apiKey)) {
    console.warn(`[llm] ANTHROPIC_API_KEY does not start with "sk-ant-" — it may be malformed (got ${apiKey.length} chars). Claude calls will likely 401.`);
  }
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
    console.error("[llm] MBOX enrichment failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
