import Anthropic from "@anthropic-ai/sdk";
import type { AhjFieldMapResult, AhjFormUrlResult, AhjOverlayMapResult, AhjResearchResult, CorrectionBucket, InverterSpecLookup, LLMProvider, MboxExtractedLearningRecord, ParserLlmExtraction, ProjectRecord, UtilityResearchResult } from "../../shared/src/types";
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

  async lookupInverterSpec(input: { inverterModel: string; inverterQty?: number }): Promise<InverterSpecLookup> {
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
      notes: "No ANTHROPIC_API_KEY configured — equipment spec lookup is off.",
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
- locateCalloutText: any utility-locate / call-before-dig callouts

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
    const system = `You are a solar permitting onboarding specialist. Given an Authority Having Jurisdiction (AHJ) that the system has never processed, lay out what's needed to permit a residential rooftop solar PV system there, based on your knowledge of US municipal/county solar permitting and the listed utility's interconnection process.

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
    const raw = await this.askLong(system, userMsg, 3000);
    const parsed = this.parseJson<Partial<AhjResearchResult>>(raw, {});
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
      notes: "AI-researched from model knowledge. Verify against the AHJ's official site before relying on it; the first real submittal will confirm/correct these requirements.",
    };
  }

  async researchUtilityRequirements(input: { utility: string; state: string; ahj?: string }): Promise<UtilityResearchResult> {
    const system = `You are a solar interconnection onboarding specialist. Given an electric UTILITY the system has never processed, lay out what's needed to file a RESIDENTIAL rooftop solar net-metering (NEM) / interconnection application with that utility, based on your knowledge of US utility customer-generation/interconnection processes.

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
    const raw = await this.askLong(system, userMsg, 3000);
    const parsed = this.parseJson<Partial<UtilityResearchResult>>(raw, {});
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
      notes: "AI-researched from model knowledge. Verify against the utility's official interconnection page before relying on it; the first real submittal will confirm/correct these requirements.",
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

  // Ask with the server-side web search tool enabled (used as the spec-lookup fallback).
  private async askWithWebSearch(systemPrompt: string, userMessage: string): Promise<string> {
    const stream = await this.client.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }] as any,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    const msg = await stream.finalMessage();
    let out = "";
    for (const block of msg.content) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((block as any).type === "text") out += (block as any).text;
    }
    return out;
  }

  async lookupInverterSpec(input: { inverterModel: string; inverterQty?: number }): Promise<InverterSpecLookup> {
    const model = String(input.inverterModel || "").trim();
    const qty = input.inverterQty && input.inverterQty > 0 ? Math.round(input.inverterQty) : 1;
    const empty = (notes: string, source = ""): InverterSpecLookup => ({
      provider: "claude", inverterModel: model, inverterQty: qty,
      outputCurrentA: null, outputVa: null, totalContinuousCurrentA: null, derivedPvBreakerA: null,
      confidence: "low", source, notes, needsHumanVerification: true,
    });
    if (!model) return empty("No inverter model provided — enter the inverter/microinverter model first.");

    const system = `You are a solar PV equipment datasheet expert. Given an inverter or microinverter MODEL, return its rated CONTINUOUS AC output from datasheet knowledge.
Return ONLY JSON:
{"outputCurrentA": <number|null — per-unit rated continuous AC output current in amps>,
 "outputVa": <number|null — per-unit rated continuous AC output power in VA or W>,
 "confidence": "low|medium|high",
 "notes": "<short note: full model name, voltage basis, any caveat>"}
Use the MAXIMUM CONTINUOUS output (not peak). Set confidence "low" and outputCurrentA null if you do not recognize the exact model or aren't sure — do NOT guess.`;

    let parsed: { outputCurrentA?: number; outputVa?: number; confidence?: string; notes?: string } = {};
    let source = "model knowledge";
    try {
      parsed = this.parseJson(await this.ask(system, `Model: ${model}`), {});
    } catch { parsed = {}; }

    // Web fallback only when knowledge is unsure/unknown (honors "knowledge first, web fallback").
    if (parsed.outputCurrentA == null || parsed.confidence === "low") {
      try {
        const webRaw = await this.askWithWebSearch(
          `${system}\nFirst search the web for the official manufacturer datasheet for this EXACT model, then return the JSON. Put the datasheet URL in "notes".`,
          `Find the rated continuous AC output current (amps) for inverter model: ${model}`,
        );
        const webParsed = this.parseJson<typeof parsed>(webRaw, {});
        if (webParsed.outputCurrentA != null) { parsed = webParsed; source = "web search"; }
      } catch (err) {
        console.warn("[llm] inverter spec web fallback failed:", err instanceof Error ? err.message : String(err));
      }
    }

    const perUnitA = Number(parsed.outputCurrentA);
    if (!Number.isFinite(perUnitA) || perUnitA <= 0) {
      return empty(`Could not determine a rated output for "${model}". Enter the value from the inverter datasheet/SLD manually.`, source);
    }
    const totalA = perUnitA * qty;
    return {
      provider: "claude",
      inverterModel: model,
      inverterQty: qty,
      outputCurrentA: Math.round(perUnitA * 100) / 100,
      outputVa: Number.isFinite(Number(parsed.outputVa)) ? Number(parsed.outputVa) : null,
      totalContinuousCurrentA: Math.round(totalA * 100) / 100,
      derivedPvBreakerA: nextStandardBreaker(totalA * 1.25),
      confidence: (["low", "medium", "high"].includes(String(parsed.confidence)) ? parsed.confidence : "medium") as "low" | "medium" | "high",
      source,
      notes: `${String(parsed.notes || "")} Derived PV breaker = next standard size ≥ 1.25 × ${Math.round(totalA * 100) / 100}A total (verify against the SLD, especially multi-branch microinverter layouts).`.trim(),
      needsHumanVerification: true,
    };
  }

  async findAhjFormUrl(input: { ahj: string; state: string; formType?: string }): Promise<AhjFormUrlResult> {
    const formType = input.formType || "permit_application";
    const system = `You are a solar permitting research assistant. Find the OFFICIAL blank ${formType.replace(/_/g, " ")} PDF form that the named Authority Having Jurisdiction (AHJ) uses for residential rooftop solar PV permits. Search the web and prefer the AHJ's own .gov/.us website.

Return ONLY JSON:
{
  "formName": "<the official form's title>",
  "candidateUrls": ["<direct https URL(s) that download the blank PDF, best first — only URLs you actually found, must end in .pdf or be a direct download>"],
  "confidence": "low|medium|high",
  "notes": "<which site it came from; any caveat, e.g. 'online portal only, no PDF exists'>"
}
Rules:
- ONLY return URLs you actually located via search — never fabricate a URL. If the AHJ submits exclusively through an online portal and has no downloadable PDF form, return an empty candidateUrls array and say so in notes.
- Prefer the most current year's form. Return valid JSON only.`;
    const userMsg = `AHJ: ${input.ahj}\nState: ${input.state}\nForm needed: residential solar ${formType.replace(/_/g, " ")}.\nFind the official blank PDF.`;
    let parsed: Partial<AhjFormUrlResult> = {};
    try {
      parsed = this.parseJson(await this.askWithWebSearch(system, userMsg), {});
    } catch (err) {
      console.warn("[llm] findAhjFormUrl web search failed:", err instanceof Error ? err.message : String(err));
    }
    const urls = Array.isArray(parsed.candidateUrls)
      ? parsed.candidateUrls.map((u) => String(u)).filter((u) => /^https?:\/\//i.test(u))
      : [];
    return {
      provider: "claude",
      formName: String(parsed.formName || ""),
      candidateUrls: urls,
      formType,
      confidence: (["low", "medium", "high"].includes(String(parsed.confidence)) ? parsed.confidence : "low") as "low" | "medium" | "high",
      notes: String(parsed.notes || ""),
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
- "role": whose signature — one of "applicant","owner","contractor","electrician","other" (infer from the nearby label; the main applicant/owner signature is "applicant")
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
    console.error("[llm] MBOX enrichment failed:", err);
    return null;
  }
}
