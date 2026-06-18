export type ProjectStatus =
  | "intake_uploaded"
  | "parsed"
  | "qc_failed"
  | "qc_passed"
  | "ready_to_stage"
  | "submit_staging"
  | "awaiting_human_submit"
  | "submitted"
  | "correction_received"
  | "correction_triaged"
  | "waiting_on_designer"
  | "ready_to_resubmit"
  | "resubmit_staging"
  | "awaiting_human_resubmit"
  | "ready_for_issue"
  | "issued"
  | "approved"
  | "pto_pending"
  | "complete"
  | "blocked";

export type PortalType = "AHJ" | "utility" | "finance" | "other";
export type QcStatus = "pass" | "fail" | "warning";
export type Severity = "info" | "warning" | "error" | "blocker";
export type HumanReviewStatus = "pending" | "approved" | "edited" | "rejected";
export type CorrectionBucket =
  | "A_we_fix"
  | "B_designer_fix"
  | "C_reviewer_clarification";
export type PortalRunStatus =
  | "queued"
  | "running"
  | "awaiting_human_submit"
  | "submitted"
  | "failed";
export type PermitCheckSource = "manual" | "portal" | "email" | "mock" | "public_url";
export type PermitCheckOutcome =
  | "waiting"
  | "correction_flagged"
  | "reviewed_by_ahj"
  | "ready_for_issue"
  | "issued"
  | "needs_human_review"
  | "no_change";
export type ParserPayload = Record<string, unknown>;
export interface ProjectRecord { id: string; clientId: string | null; homeownerName: string; projectAddress: string; city: string; state: string; zip: string; ahj: string; utility: string; accountNumber: string; meterNumber: string; systemSizeDcKw: number | null; systemSizeAcKw: number | null; totalExportKw: number | null; interconnectionMethod: string; status: ProjectStatus; currentStage: string; parserConfidenceSummary: string; parserSnapshot: ParserPayload; createdAt: string; updatedAt: string; }
export interface LLMProvider { extractFields(input: Record<string, unknown>): Promise<Record<string, unknown>>; classifyCorrection(input: { correctionText: string; project?: ProjectRecord; }): Promise<{ bucket: CorrectionBucket; confidence: number; notes: string }>; draftResponse(input: { correctionText: string; project?: ProjectRecord; }): Promise<{ draft: string; confidence: number }>; }
