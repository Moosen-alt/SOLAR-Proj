import type { PermitCheckOutcome } from "../../shared/src/types";

export interface PermitStatusClassification {
  outcome: PermitCheckOutcome;
  statusLabel: string;
  confidence: number;
  reviewedByAhj: boolean;
  readyForIssue: boolean;
  issueFeeDue: boolean;
  message: string;
}