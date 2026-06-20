import type { CorrectionBucket, LLMProvider, MboxExtractedLearningRecord } from "../../shared/src/types";

export class StubLLMProvider implements LLMProvider {
  async extractFields(): Promise<Record<string, unknown>> {
    return {
      provider: "stub",
      confidence: 0,
      notes: "No LLM API key configured. Human review is required for unresolved fields.",
    };
  }

  async classifyCorrection(_input: { correctionText: string }): Promise<{ bucket: CorrectionBucket; confidence: number; notes: string }> {
    return { bucket: "C_reviewer_clarification", confidence: 0, notes: "Stub: human review required." };
  }

  async draftResponse(_input: { correctionText: string }): Promise<{ draft: string; confidence: number }> {
    return { draft: "", confidence: 0 };
  }
}

export function createLLMProvider(): LLMProvider {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey || process.env["LLM_MBOX_ENRICHMENT"] !== "true") {
    return new StubLLMProvider();
  }
  // OpenAI provider would be instantiated here when configured
  return new StubLLMProvider();
}

/**
 * Optional LLM enrichment for MBOX learning records. Advisory only: returns a
 * partial record to merge over the deterministic result, or null when no LLM is
 * configured. The deterministic classifier remains the source of truth.
 */
export async function enrichMboxLearningWithLlm(_input: {
  redactedEmailText: string;
  deterministicRecord: MboxExtractedLearningRecord;
}): Promise<Partial<MboxExtractedLearningRecord> | null> {
  if (process.env["LLM_MBOX_ENRICHMENT"] !== "true" || !process.env["OPENAI_API_KEY"]) {
    return null;
  }
  // A real OpenAI-backed enrichment would run here, operating only on the
  // already-redacted email text. Until configured, defer to deterministic rules.
  return null;
}
