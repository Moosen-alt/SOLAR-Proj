import Anthropic from "@anthropic-ai/sdk";
import type { CorrectionBucket, LLMProvider, MboxExtractedLearningRecord, ParserLlmExtraction, ProjectRecord } from "../../shared/src/types";

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
    "<fieldId>": { "value": <string|number|null>, "confidence": <0..1> }
  },
  "lowConfidenceFields": ["<fieldId>", ...],
  "notes": "<short notes on anything ambiguous or worth a human double-check>"
}

Use EXACTLY these fieldId keys when you find a value (omit a key entirely if absent):
- owner: full homeowner name(s) exactly as on the utility bill (e.g. "Abigail Boileau & Thomas Boileau")
- street: service street address line (e.g. "1300 N Sitka Ave")
- city, state, zip: service address city / 2-letter state / 5-digit zip
- ahj: the Authority Having Jurisdiction (permitting city or county), e.g. "City of Newberg"
- utility: electric utility company normalized (e.g. "PGE", "Pacific Power")
- account: utility account number (digits as printed on the bill)
- meter: meter number/serial (prefer the meter photo; cross-check the bill)
- dcKw: system size in kW DC (number only)
- acKw: system size in kW AC (number only)
- interco: interconnection method if stated (e.g. "Net Metering")
- moduleMake, moduleModel, moduleWattage (number), moduleQty (number)
- invMake, invModel, invQty (number)
- batteryMake, batteryModel, batteryQty (number)
- roofMaterial: e.g. "Composition Shingle"
- mounting: e.g. "Roof Mount"

Rules:
- Set confidence honestly. If a value is inferred or the OCR is messy, lower it. Put any field with confidence < 0.6 (or that you had to guess) into lowConfidenceFields.
- For account and meter numbers, only return digits/characters you can actually read; never invent or pad them. If unreadable, omit and add to lowConfidenceFields.
- Prefer the utility bill for name/address/account, the meter photo for meter number, the plan set for system/equipment.
- Numbers must be JSON numbers, not strings.
- Return valid JSON only — no prose outside the JSON.`;

    const parts: string[] = [];
    if (input.defaultState) parts.push(`(Default state hint if ambiguous: ${input.defaultState})`);
    if (input.planText?.trim()) parts.push(`=== PLAN_SET ===\n${input.planText.slice(0, 24000)}`);
    if (input.utilityBillText?.trim()) parts.push(`=== UTILITY_BILL ===\n${input.utilityBillText.slice(0, 8000)}`);
    if (input.meterText?.trim()) parts.push(`=== METER_PHOTO ===\n${input.meterText.slice(0, 2000)}`);
    if (!parts.length) {
      return { provider: "claude", fields: {}, lowConfidenceFields: [], notes: "No document text supplied." };
    }

    const raw = await this.askLong(system, parts.join("\n\n"));
    const parsed = this.parseJson<{
      fields?: Record<string, { value: unknown; confidence?: number }>;
      lowConfidenceFields?: string[];
      notes?: string;
    }>(raw, { fields: {}, lowConfidenceFields: [], notes: "Could not parse LLM response." });

    const fields: ParserLlmExtraction["fields"] = {};
    for (const [key, entry] of Object.entries(parsed.fields || {})) {
      if (!entry || entry.value == null || entry.value === "") continue;
      const value = typeof entry.value === "number" ? entry.value : String(entry.value).trim();
      if (value === "") continue;
      const confidence = typeof entry.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : 0.5;
      fields[key] = { value: value as string | number, confidence };
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
- UTILITY_BILL: the electric bill. Read the homeowner name, full service address, utility company, the ACCOUNT NUMBER exactly as printed (include any dashes/segments, e.g. "65564191-0014"), and the meter number from the account-activity table.
- METER_PHOTO: a photo of the electric meter. Read the meter serial number printed on the face/label (e.g. "78 118 886" -> "78118886"), and the utility (e.g. PacifiCorp = Pacific Power).

Return ONLY JSON: {"fields":{"<id>":{"value":<string|number>,"confidence":<0..1>}}, "lowConfidenceFields":[...], "notes":"..."}

Field ids (omit if not present):
- owner, street, city, state (2-letter), zip
- utility (normalize: PacifiCorp/Pacific Power -> "Pacific Power"; Portland General/PGE -> "PGE")
- account: the utility account number, digits/dashes EXACTLY as printed
- meter: the meter serial/number, digits only
- servicePeriod: e.g. "Mar 13, 2026 - Apr 13, 2026"

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
    const parsed = this.parseJson<{ fields?: Record<string, { value: unknown; confidence?: number }>; lowConfidenceFields?: string[]; notes?: string }>(
      raw,
      { fields: {}, lowConfidenceFields: [], notes: "Could not parse vision response." },
    );
    const fields: ParserLlmExtraction["fields"] = {};
    for (const [key, entry] of Object.entries(parsed.fields || {})) {
      if (!entry || entry.value == null || entry.value === "") continue;
      const value = typeof entry.value === "number" ? entry.value : String(entry.value).trim();
      if (value === "") continue;
      const confidence = typeof entry.confidence === "number" ? Math.max(0, Math.min(1, entry.confidence)) : 0.6;
      fields[key] = { value: value as string | number, confidence };
    }
    return {
      provider: "claude",
      fields,
      lowConfidenceFields: Array.isArray(parsed.lowConfidenceFields) ? parsed.lowConfidenceFields : [],
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
    };
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
