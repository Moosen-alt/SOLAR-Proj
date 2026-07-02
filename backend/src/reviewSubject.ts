// ---------------------------------------------------------------------------
// Standalone review-gate submissions — the sellable surface of the reviewer.
//
// reviewSubjectToProject adapts the small ReviewSubject DTO onto the
// ProjectRecord shape the (pure) engine already consumes, so the internal
// all-in-one product and the AHJ-facing API run the IDENTICAL engine —
// there is one reviewer, packaged twice.
//
// runStandaloneReview is the whole flow: resolve the jurisdiction's adopted-
// codes context → optional plan-set PDF (page renders for the AI pass + text
// extraction) → runReviewPack (deterministic solar / AI general hybrid) →
// persist a review_submissions row (org-scoped for multi-tenant sale).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import type { AiPlanReviewResult, ProjectRecord, ReviewerReport, ReviewSubject, ReviewWorkType } from "../../shared/src/types";
import { resolveEffectiveCodeContext } from "./codeProfiles";
import { runReviewPack, reviewPackFor } from "./reviewPacks";
import { createLLMProvider } from "./llm";
import { extractPdfPages } from "./batchImport";
import { renderPdfPageToPng } from "./pageImages";
import { addAuditLog } from "./audit";
import { logger } from "./logger";
import { id } from "./ids";
import { asJson, parseJson, text as s } from "./json";
import { nowIso } from "./time";

interface Row { [key: string]: unknown }

/** Adapt the DTO onto the engine's ProjectRecord contract. Synthetic id; every
 *  field the engine reads is populated; `fields` land in parserSnapshot verbatim
 *  (the engine's fieldValue() reads that bag defensively). */
export function reviewSubjectToProject(subject: ReviewSubject, submissionId: string): ProjectRecord {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(subject.fields ?? {})) {
    if (v == null) continue;
    fields[k] = String(v);
  }
  // Jurisdiction keys are read from the payload too (baseline rules).
  fields.state = fields.state || subject.state;
  fields.ahj = fields.ahj || subject.ahj;
  if (subject.utility) fields.utility = fields.utility || subject.utility;
  if (subject.system?.sizeDcKw != null) fields.dcKw = fields.dcKw || String(subject.system.sizeDcKw);
  if (subject.system?.sizeAcKw != null) fields.acKw = fields.acKw || String(subject.system.sizeAcKw);

  return {
    id: submissionId,
    clientId: null,
    homeownerName: subject.applicant?.name || "",
    projectAddress: subject.applicant?.address || "",
    city: subject.applicant?.city || "",
    state: subject.state,
    zip: subject.applicant?.zip || "",
    ahj: subject.ahj,
    utility: subject.utility || "",
    accountNumber: "",
    meterNumber: "",
    systemSizeDcKw: subject.system?.sizeDcKw ?? null,
    systemSizeAcKw: subject.system?.sizeAcKw ?? null,
    interconnectionMethod: subject.system?.interconnectionMethod || "",
    status: "review_only",
    parserSnapshot: fields,
  } as unknown as ProjectRecord;
}

export interface ReviewSubmissionRecord {
  id: string;
  orgId: string;
  workType: ReviewWorkType;
  state: string;
  ahj: string;
  status: "complete" | "failed";
  report: ReviewerReport | null;
  aiSummary: string;
  plansetPath: string;
  createdAt: string;
}

function mapSubmission(row: Row): ReviewSubmissionRecord {
  return {
    id: s(row.id),
    orgId: s(row.org_id),
    workType: (s(row.work_type) || "general") as ReviewWorkType,
    state: s(row.state),
    ahj: s(row.ahj),
    status: s(row.status) === "failed" ? "failed" : "complete",
    report: parseJson<ReviewerReport | null>(s(row.report_json), null),
    aiSummary: s(row.ai_summary),
    plansetPath: s(row.planset_path),
    createdAt: s(row.created_at),
  };
}

export function getReviewSubmission(db: AppDb, orgId: string, submissionId: string): ReviewSubmissionRecord | null {
  const row = db.get<Row>("SELECT * FROM review_submissions WHERE id = ? AND org_id = ?", [submissionId, orgId]);
  return row ? mapSubmission(row) : null;
}

export function listReviewSubmissions(db: AppDb, orgId: string, limit = 50): ReviewSubmissionRecord[] {
  return db
    .query<Row>("SELECT * FROM review_submissions WHERE org_id = ? ORDER BY created_at DESC LIMIT ?", [orgId, Math.max(1, Math.min(200, limit))])
    .map(mapSubmission);
}

const REVIEW_FILES_DIR = () => path.resolve(process.cwd(), "backend/data/review-submissions");

/** The full standalone review flow. Never leaks internals: a failure records a
 *  failed submission with the reason instead of a 500 with a stack. */
export async function runStandaloneReview(
  db: AppDb,
  orgId: string,
  subject: ReviewSubject,
  planset?: { buffer: Buffer; filename: string },
): Promise<{ submission: ReviewSubmissionRecord; report: ReviewerReport; ai: AiPlanReviewResult | null }> {
  const submissionId = id();
  const ts = nowIso();
  const ctx = resolveEffectiveCodeContext(db, subject.state, subject.ahj);
  const project = reviewSubjectToProject(subject, submissionId);

  // Persist the plan set (if provided) so the report's evidence can be revisited.
  let plansetPath = "";
  let pageImagesBase64: string[] = [];
  let extractedText = subject.fields?.splitPagesText ? String(subject.fields.splitPagesText) : "";
  if (planset && planset.buffer.length > 0) {
    fs.mkdirSync(REVIEW_FILES_DIR(), { recursive: true });
    plansetPath = path.join(REVIEW_FILES_DIR(), `${submissionId}.pdf`);
    fs.writeFileSync(plansetPath, planset.buffer);
    try {
      const pages = await extractPdfPages(plansetPath, 40);
      if (!extractedText) extractedText = pages.join("\n").slice(0, 20000);
      // Render the first sheets for the AI vision pass (cap 6 — intake triage).
      const renderCount = Math.min(pages.length || 1, 6);
      for (let p = 1; p <= renderCount; p++) {
        try {
          const png = await renderPdfPageToPng(plansetPath, p, 1.4);
          pageImagesBase64.push(png.toString("base64"));
        } catch { /* skip unrenderable page */ }
      }
    } catch (err) {
      logger.warn("review", `plan-set extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The solar pack's plan-text checks read splitPagesText — feed the extraction.
    if (extractedText && !project.parserSnapshot?.splitPagesText) {
      (project.parserSnapshot as Record<string, string>).splitPagesText = extractedText.slice(0, 20000);
    }
  }

  const llm = createLLMProvider();
  const pack = reviewPackFor(subject.workType);
  const { report, ai } = await runReviewPack({
    workType: subject.workType,
    project,
    ctx,
    llm,
    pageImagesBase64,
    extractedText,
    // AI second opinion beside the deterministic solar pack only when there is
    // something visual/textual for it to read.
    includeAiSecondOpinion: pack.deterministic && (pageImagesBase64.length > 0),
  });

  db.run(
    `INSERT INTO review_submissions
      (id, org_id, work_type, state, ahj, status, subject_json, report_json, ai_summary, planset_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [submissionId, orgId, subject.workType, subject.state, subject.ahj, "complete", asJson(subject), asJson(report), ai?.summary || "", plansetPath, ts],
  );
  addAuditLog(db, null, "system", "review-gate", "review.submitted", {
    submissionId, orgId, workType: subject.workType, state: subject.state, ahj: subject.ahj,
    blockers: report.findings.filter((f) => f.severity === "blocker").length,
    codeProfileSource: ctx.source,
  });
  return { submission: getReviewSubmission(db, orgId, submissionId)!, report, ai };
}
