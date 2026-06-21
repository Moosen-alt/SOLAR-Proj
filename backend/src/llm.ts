import Anthropic from "@anthropic-ai/sdk";
import type { AhjResearchResult, CorrectionBucket, LLMProvider, MboxExtractedLearningRecord, ParserLlmExtraction, ProjectRecord } from "../../shared/src/types";

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
PERMIT PORTAL (Accela / ProjectDox AHJ building+electrical permit)
- parcelNumber: assessor parcel number (APN) / map-tax-lot, if shown on the cover sheet or site plan
- jobValue: project valuation / installed cost in dollars (number), if shown

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
