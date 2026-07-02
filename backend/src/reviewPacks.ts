// ---------------------------------------------------------------------------
// Review packs — the HYBRID review-gate engine (general building plans).
//
// A "pack" is how a work type gets reviewed:
//   - solar_pv_residential — the DETERMINISTIC pack: the full reviewer engine
//     (code rules + plan-set/permit-path/utility checks). Findings carry full
//     authority; blockers gate staging.
//   - everything else (reroof, water_heater, adu, deck, general) — served by
//     the LLM GENERAL REVIEW mode: Claude vision over the rendered plan pages,
//     grounded in the jurisdiction's adopted-codes context. Those findings are
//     ALWAYS advisory: category "ai_review", severity capped at warning, never
//     counted as blockers, and explicitly labeled AI-assisted pre-review.
// The AI mode can also run ALONGSIDE the solar pack as a second opinion.
//
// Adding a deterministic pack for a new work type = add an entry here with an
// `evaluate` and it automatically takes authority over the AI-only mode.
// ---------------------------------------------------------------------------
import type {
  AiPlanReviewResult,
  LLMProvider,
  ProjectRecord,
  ReviewerFinding,
  ReviewerReport,
  ReviewWorkType,
} from "../../shared/src/types";
import type { EffectiveCodeContext } from "./codeProfiles";
import { buildReviewerReport } from "./reviewerEngine";
import { nowIso } from "./time";

export interface ReviewPackInfo {
  workType: ReviewWorkType;
  label: string;
  description: string;
  /** True when a hand-built deterministic rule pack exists for this work type. */
  deterministic: boolean;
}

export const REVIEW_PACKS: ReviewPackInfo[] = [
  { workType: "solar_pv_residential", label: "Residential rooftop solar PV", deterministic: true, description: "Full deterministic review: electrical (SLD, interconnection, rapid shutdown), structural prescriptive screens, fire access, equipment schedule — plus optional AI second opinion." },
  { workType: "reroof", label: "Re-roof", deterministic: false, description: "AI-assisted pre-review against the jurisdiction's adopted residential/building code." },
  { workType: "water_heater", label: "Water heater replacement", deterministic: false, description: "AI-assisted pre-review (plumbing/mechanical/energy code signals)." },
  { workType: "adu", label: "Accessory dwelling unit (ADU)", deterministic: false, description: "AI-assisted pre-review: completeness + code-conformance signals for ADU plan sets." },
  { workType: "deck", label: "Deck", deterministic: false, description: "AI-assisted pre-review: footings, ledger, guards, spans per the adopted residential code." },
  { workType: "general", label: "General / other permit", deterministic: false, description: "AI-assisted pre-review for any other permit plan set." },
];

export function reviewPackFor(workType: string): ReviewPackInfo {
  return REVIEW_PACKS.find((p) => p.workType === workType) ?? REVIEW_PACKS[REVIEW_PACKS.length - 1];
}

// Render the jurisdiction context into the grounding text the AI reviewer sees.
export function codeSummaryForPrompt(ctx: EffectiveCodeContext): string {
  const lines: string[] = [];
  for (const c of ctx.adoptedCodes) {
    lines.push(`- ${c.code} ${c.edition}${c.title ? ` (${c.title})` : ""}${c.notes ? ` — ${c.notes}` : ""}`);
  }
  for (const a of ctx.amendments) lines.push(`- LOCAL AMENDMENT ${a.code}${a.section ? ` ${a.section}` : ""}: ${a.summary}`);
  const d = ctx.designCriteria;
  const crit = [
    d.groundSnowLoadPsf != null ? `ground snow ${d.groundSnowLoadPsf} psf` : "",
    d.windSpeedMph != null ? `wind ${d.windSpeedMph} mph` : "",
    d.windExposure ? `exposure ${d.windExposure}` : "",
    d.seismicDesignCategory ? `seismic ${d.seismicDesignCategory}` : "",
    d.frostDepthIn != null ? `frost depth ${d.frostDepthIn} in` : "",
  ].filter(Boolean).join(", ");
  if (crit) lines.push(`- DESIGN CRITERIA: ${crit}`);
  return lines.join("\n");
}

// Map the LLM's advisory observations onto the ReviewerFinding contract. The hard
// caps live HERE (not just in the prompt): category ai_review, severity ≤ warning,
// installerCallout false — so a prompt drift can never mint an AI blocker.
export function aiResultToFindings(ai: AiPlanReviewResult, ctx: EffectiveCodeContext): ReviewerFinding[] {
  const out: ReviewerFinding[] = ai.findings.map((f, i) => ({
    id: `ai.review.${i + 1}`,
    severity: f.severity === "callout" ? "callout" : "warning",
    category: "ai_review",
    title: `[AI pre-review] ${f.title}`,
    message: f.message,
    cityFeedback: f.message,
    designTeamAction: "AI-assisted observation — a human reviewer confirms against the adopted code before acting.",
    evidenceNeeded: f.sheetRef ? [`See ${f.sheetRef}`] : [],
    codeReferences: f.codeFamily
      ? [ctx.citationFor(f.codeFamily, f.codeSection || "", f.title)]
      : [],
    installerCallout: false,
  }));
  if (ai.provider === "stub" && ai.notes) {
    out.push({
      id: "ai.review.unavailable",
      severity: "callout",
      category: "ai_review",
      title: "[AI pre-review] Unavailable",
      message: ai.notes,
      cityFeedback: ai.notes,
      designTeamAction: "Configure ANTHROPIC_API_KEY to enable AI-assisted pre-review.",
      evidenceNeeded: [],
      codeReferences: [],
      installerCallout: false,
    });
  }
  return out;
}

/** Run the hybrid review for a work type. The deterministic solar pack keeps its
 *  exact engine path; AI-served work types produce an advisory-only report. */
export async function runReviewPack(input: {
  workType: ReviewWorkType;
  project: ProjectRecord;
  ctx: EffectiveCodeContext;
  llm: LLMProvider;
  /** Rendered plan-page PNGs (base64) for the AI pass; empty = text-only. */
  pageImagesBase64?: string[];
  extractedText?: string;
  /** Also run the AI second opinion beside the deterministic solar pack. */
  includeAiSecondOpinion?: boolean;
}): Promise<{ report: ReviewerReport; ai: AiPlanReviewResult | null }> {
  const pack = reviewPackFor(input.workType);
  const jurisdictionLabel = [input.ctx.ahj, input.ctx.state].filter(Boolean).join(", ") || "the jurisdiction";

  const runAi = async (): Promise<AiPlanReviewResult> =>
    input.llm.reviewPlanSetGeneral({
      workType: input.workType,
      jurisdictionLabel,
      codeSummary: codeSummaryForPrompt(input.ctx),
      verifiedProfile: input.ctx.verified,
      pageImagesBase64: input.pageImagesBase64 ?? [],
      extractedText: input.extractedText,
      applicantFacts: {
        address: input.project.projectAddress,
        systemSizeDcKw: input.project.systemSizeDcKw ? String(input.project.systemSizeDcKw) : "",
      },
    });

  if (pack.deterministic) {
    const report = buildReviewerReport(input.project, { codeContext: input.ctx });
    let ai: AiPlanReviewResult | null = null;
    if (input.includeAiSecondOpinion && (input.pageImagesBase64?.length || input.extractedText)) {
      try {
        ai = await runAi();
        report.findings.push(...aiResultToFindings(ai, input.ctx));
      } catch { ai = null; /* second opinion is best-effort */ }
    }
    return { report, ai };
  }

  // AI-served work type: advisory-only report (no deterministic findings exist).
  let ai: AiPlanReviewResult;
  try {
    ai = await runAi();
  } catch (err) {
    ai = {
      provider: "stub", findings: [], summary: "", confidence: "low",
      notes: `AI review failed: ${err instanceof Error ? err.message : String(err)}. Re-run or review manually.`,
    };
  }
  const report: ReviewerReport = {
    projectId: input.project.id,
    generatedAt: nowIso(),
    matchedProcessProfile: null,
    findings: aiResultToFindings(ai, input.ctx),
    installerCallouts: [],
    finalSubmitGate: {
      mustShowAhjPreviewWindow: true,
      finalSubmitButtonAloneIsEnough: false,
      requirements: ["AI-assisted pre-review only — a human plans examiner completes the review."],
    },
  };
  return { report, ai };
}
