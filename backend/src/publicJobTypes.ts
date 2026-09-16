import type { JobType } from "./jobQueue";

// Only operator jobs belong on the generic enqueue route. Research and triage
// jobs are created by their own guarded triggers; accepting them here bypasses
// dedupe/backoff and lets callers invent research keys. Explicit inclusion also
// keeps a future internal job private until its API contract is reviewed.
const PUBLIC_JOB_TYPES = new Set<JobType>([
  "permit_checks",
  "nem_checks",
  "mbox_import",
  "folder_scan",
  "autopilot",
  "prepare_submission",
  "auto_learn",
]);

export function isPublicJobType(value: unknown): value is JobType {
  return typeof value === "string" && PUBLIC_JOB_TYPES.has(value as JobType);
}
