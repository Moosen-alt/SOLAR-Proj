import type {
  ApplicationDocumentPackage,
  AuditLog,
  CorrectionRecord,
  EmailProjectMatch,
  EmailTrackerRunResult,
  EmailTrackingSource,
  HistoricalFailureReport,
  HumanReviewItem,
  InstallerActionCategory,
  InstallerActionItem,
  InstallerActionPacket,
  LiveProjectReadinessItem,
  LiveProjectReadinessReport,
  MboxKnowledgeImportResult,
  OperationStep,
  OperationStepStatus,
  OperationsActionDueBucket,
  OperationsActionQueue,
  OperationsBoard,
  OperationsBoardProject,
  OperationsBrief,
  OperationsBriefActivity,
  OperationsBriefSignal,
  OperationsDailyReport,
  OperationsOwnerWorkload,
  OperationsPlan,
  ParserPayload,
  PermitCheckOutcome,
  PermitCheckSource,
  PermitCheckTarget,
  PermitStatusCheck,
  PermitUtilityKnowledgeProfile,
  PortalRun,
  ProjectCommunicationDraft,
  ProjectCommunicationDraftPacket,
  ProjectDetail,
  ProjectHandoffPacket,
  ProjectHandoffPacketSection,
  ProjectListItem,
  ProjectNote,
  ProjectNoteType,
  ProjectProcessLane,
  ProjectProcessMap,
  ProjectProcessStep,
  ProjectProcessStepStatus,
  ProjectRunbook,
  ProjectRunbookStep,
  ProjectTimelineEvent,
  ProjectTimelineReport,
  ProjectRecord,
  ProjectWorkflow,
  QcResult,
  ReviewerFinding,
  ReviewerReport,
  SubmissionRecord,
  SubmitGateCheck,
  SubmitGateReport,
} from "../../shared/src/types";
import { touchProjectMetrics } from "./kpi";
import fs from "node:fs";
import path from "node:path";
import { stageWithAccela, stageWithMockPortal, stageWithPowerClerk } from "../../portal-bot/src/index";
import { addAuditLog } from "./audit";
import { clientStagingOverlay } from "./clients";
import { buildApplicationDocumentPackage } from "./applicationDocs";
import { classifyCorrection } from "./corrections";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { buildHistoricalFailureReport } from "./historicalFailures";
import { id } from "./ids";
import { asJson, parseJson } from "./json";
import {
  learnFromCorrection,
  learnFromPermitStatus,
  learnFromPermitTarget,
  learnFromProject,
  learnFromSubmissionConfirmation,
  listKnowledgeProfiles,
  importMboxKnowledge,
  classifyMboxMessages,
  type ClassifiedMboxMessage,
} from "./knowledgeBase";
import { fieldAliases, normalizeProject } from "./normalize";
import { classifyPermitStatusText, nextCheckIso } from "./permitMonitor";
import { evidenceForTopic, evidenceLines, type EvidenceTopic } from "./projectEvidence";
import { runQcForProject } from "./qc";
import { buildReviewerReport, renderReviewerReportHtml } from "./reviewerEngine";
import { nowIso } from "./time";

type Row = Record<string, unknown>;

interface ProjectRow extends Row {
  id: string;
  client_id: string | null;
  homeowner_name: string;
  project_address: string;
  city: string;
  state: string;
  zip: string;
  ahj: string;
  utility: string;
  account_number: string;
  meter_number: string;
  system_size_dc_kw: number | null;
  system_size_ac_kw: number | null;
  total_export_kw: number | null;
  interconnection_method: string;
  status: ProjectRecord["status"];
  current_stage: string;
  parser_confidence_summary: string;
  parser_json: string;
  assigned_user_id?: string | null;
  created_at: string;
  updated_at: string;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    homeownerName: row.homeowner_name,
    projectAddress: row.project_address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    ahj: row.ahj,
    utility: row.utility,
    accountNumber: row.account_number,
    meterNumber: row.meter_number,
    systemSizeDcKw: row.system_size_dc_kw,
    systemSizeAcKw: row.system_size_ac_kw,
    totalExportKw: row.total_export_kw,
    interconnectionMethod: row.interconnection_method,
    status: row.status,
    currentStage: row.current_stage,
    parserConfidenceSummary: row.parser_confidence_summary,
    parserSnapshot: parseJson<ParserPayload>(row.parser_json, {}),
    assignedUserId: row.assigned_user_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapQc(row: Row): QcResult {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    qcStatus: text(row.qc_status) as QcResult["qcStatus"],
    ruleId: text(row.rule_id),
    ruleName: text(row.rule_name),
    message: text(row.message),
    severity: text(row.severity) as QcResult["severity"],
    createdAt: text(row.created_at),
  };
}

function mapReview(row: Row): HumanReviewItem {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    issueType: text(row.issue_type),
    fieldName: text(row.field_name),
    parserValue: text(row.parser_value),
    llmSuggestedValue: text(row.llm_suggested_value),
    sourceExcerpt: text(row.source_excerpt),
    status: text(row.status) as HumanReviewItem["status"],
    notes: text(row.notes),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapCorrection(row: Row): CorrectionRecord {
  const createdAt = text(row.created_at);
  const closedAt = row.closed_at == null ? null : text(row.closed_at);
  const slaDays = Number(row.sla_days ?? 5);
  const dueAt = row.due_at == null
    ? (() => {
        const d = new Date(createdAt);
        d.setDate(d.getDate() + slaDays);
        return d.toISOString().slice(0, 10);
      })()
    : text(row.due_at);
  const refDate = closedAt ? new Date(closedAt) : new Date();
  const daysOpen = Math.floor((refDate.getTime() - new Date(createdAt).getTime()) / 86_400_000);
  const isOverdue = !closedAt && new Date() > new Date(`${dueAt}T23:59:59`);
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    source: text(row.source) as CorrectionRecord["source"],
    correctionText: text(row.correction_text),
    correctionBucket: text(row.correction_bucket) as CorrectionRecord["correctionBucket"],
    rootCause: text(row.root_cause),
    requiredAction: text(row.required_action),
    assignedTo: text(row.assigned_to),
    draftResponse: text(row.draft_response),
    humanApproved: bool(row.human_approved),
    resubmitted: bool(row.resubmitted),
    newRuleRecommended: bool(row.new_rule_recommended),
    createdAt,
    closedAt,
    dueAt,
    slaDays,
    daysOpen,
    isOverdue,
  };
}

function mapPermitTarget(row: Row): PermitCheckTarget {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    jurisdiction: text(row.jurisdiction),
    portalName: text(row.portal_name),
    portalUrl: text(row.portal_url),
    applicationNumber: text(row.application_number),
    permitNumber: text(row.permit_number),
    checkFrequencyDays: Number(row.check_frequency_days ?? 7),
    active: bool(row.active),
    lastCheckedAt: row.last_checked_at == null ? null : text(row.last_checked_at),
    nextCheckAt: row.next_check_at == null ? null : text(row.next_check_at),
    latestOutcome: row.latest_outcome == null ? null : (text(row.latest_outcome) as PermitCheckOutcome),
    latestStatusLabel: text(row.latest_status_label),
    notes: text(row.notes),
    targetType: (row.target_type === "nem" ? "nem" : "permit") as "permit" | "nem",
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapPermitStatusCheck(row: Row): PermitStatusCheck {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    targetId: row.target_id == null ? null : text(row.target_id),
    source: text(row.source) as PermitCheckSource,
    rawStatusText: text(row.raw_status_text),
    statusLabel: text(row.status_label),
    outcome: text(row.outcome) as PermitCheckOutcome,
    confidence: Number(row.confidence ?? 0),
    correctionId: row.correction_id == null ? null : text(row.correction_id),
    reviewedByAhj: bool(row.reviewed_by_ahj),
    readyForIssue: bool(row.ready_for_issue),
    issueFeeDue: bool(row.issue_fee_due),
    applicationNumber: text(row.application_number),
    permitNumber: text(row.permit_number),
    message: text(row.message),
    createdAt: text(row.created_at),
  };
}

function mapEmailTrackingSource(row: Row): EmailTrackingSource {
  return {
    id: text(row.id),
    sourceType: "mbox_path",
    label: text(row.label),
    filePath: text(row.file_path),
    defaultState: text(row.default_state),
    defaultAhj: text(row.default_ahj),
    defaultUtility: text(row.default_utility),
    active: bool(row.active),
    lastCheckedAt: row.last_checked_at == null ? null : text(row.last_checked_at),
    lastMessageCount: Number(row.last_message_count ?? 0),
    lastMatchedCount: Number(row.last_matched_count ?? 0),
    lastError: text(row.last_error),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapEmailProjectMatch(row: Row): EmailProjectMatch {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    sourceId: row.source_id == null ? null : text(row.source_id),
    sourceSignature: text(row.source_signature),
    sourceLabel: text(row.source_label),
    emailBucket: text(row.email_bucket) as EmailProjectMatch["emailBucket"],
    workflow: text(row.workflow) as EmailProjectMatch["workflow"],
    confidence: Number(row.confidence ?? 0),
    matchReason: text(row.match_reason),
    statusCheckId: row.status_check_id == null ? null : text(row.status_check_id),
    correctionId: row.correction_id == null ? null : text(row.correction_id),
    subject: text(row.subject),
    occurredAt: text(row.occurred_at),
    createdAt: text(row.created_at),
  };
}

function mapOperationStep(row: Row): OperationStep {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    phaseKey: text(row.phase_key),
    phaseName: text(row.phase_name),
    status: text(row.status) as OperationStepStatus,
    statusSource: text(row.status_source) === "manual" ? "manual" : "system",
    ownerRole: text(row.owner_role),
    dueAt: row.due_at == null ? null : text(row.due_at),
    summary: text(row.summary),
    nextAction: text(row.next_action),
    notes: text(row.notes),
    sortOrder: Number(row.sort_order ?? 0),
    source: text(row.source),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapProjectNote(row: Row): ProjectNote {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    noteType: text(row.note_type) as ProjectNoteType,
    body: text(row.body),
    createdBy: text(row.created_by),
    createdAt: text(row.created_at),
  };
}

function mapPortalRun(row: Row): PortalRun {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    portalProfileId: row.portal_profile_id == null ? null : text(row.portal_profile_id),
    runType: text(row.run_type),
    status: text(row.status) as PortalRun["status"],
    startedAt: text(row.started_at),
    finishedAt: row.finished_at == null ? null : text(row.finished_at),
    errorMessage: text(row.error_message),
    humanActionRequired: bool(row.human_action_required),
    screenshotsPath: text(row.screenshots_path),
    logsPath: text(row.logs_path),
  };
}

function mapSubmission(row: Row): SubmissionRecord {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    portalProfileId: row.portal_profile_id == null ? null : text(row.portal_profile_id),
    submissionType: text(row.submission_type) as SubmissionRecord["submissionType"],
    status: text(row.status) as SubmissionRecord["status"],
    applicationNumber: text(row.application_number),
    permitNumber: text(row.permit_number),
    confirmationNumber: text(row.confirmation_number),
    submittedAt: row.submitted_at == null ? null : text(row.submitted_at),
    submittedBy: text(row.submitted_by),
    screenshotsPath: text(row.screenshots_path),
    notes: text(row.notes),
  };
}

function mapAudit(row: Row): AuditLog {
  return {
    id: text(row.id),
    projectId: row.project_id == null ? null : text(row.project_id),
    actorType: text(row.actor_type) as AuditLog["actorType"],
    actorName: text(row.actor_name),
    action: text(row.action),
    details: parseJson<Record<string, unknown>>(text(row.details), {}),
    createdAt: text(row.created_at),
  };
}

export function createProject(db: AppDb, payload: ParserPayload): ProjectDetail {
  const project = normalizeProject(id(), payload);
  db.transaction(() => {
    db.run(
      `INSERT INTO projects (
        id, client_id, homeowner_name, project_address, city, state, zip, ahj, utility,
        account_number, meter_number, system_size_dc_kw, system_size_ac_kw, total_export_kw,
        interconnection_method, status, current_stage, parser_confidence_summary, parser_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        project.id,
        project.clientId,
        project.homeownerName,
        project.projectAddress,
        project.city,
        project.state,
        project.zip,
        project.ahj,
        project.utility,
        project.accountNumber,
        project.meterNumber,
        project.systemSizeDcKw,
        project.systemSizeAcKw,
        project.totalExportKw,
        project.interconnectionMethod,
        project.status,
        project.currentStage,
        project.parserConfidenceSummary,
        asJson(project.parserSnapshot),
        project.createdAt,
        project.updatedAt,
      ],
    );

    insertExtractedFields(db, project.id, payload, false);
    addAuditLog(db, project.id, "system", "front-end parser", "project.created_from_parser_snapshot", {
      source: "Solar Submission Engine HTML",
    });
  });

  const qc = runQcForProject(db, project.id);
  addAuditLog(db, project.id, "system", "qc gate", "project.qc_completed", { ...qc });
  const detail = getProjectDetail(db, project.id);
  learnFromProject(db, detail.project, "project.created");
  return getProjectDetail(db, project.id);
}

export function assignProjectClient(db: AppDb, projectId: string, clientId: string | null): ProjectDetail {
  const project = db.get<Row>("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) throw new HttpError(404, "Project not found.");
  if (clientId) {
    const client = db.get<Row>("SELECT id FROM clients WHERE id = ?", [clientId]);
    if (!client) throw new HttpError(404, "Client not found.");
  }
  db.run("UPDATE projects SET client_id = ?, updated_at = ? WHERE id = ?", [clientId, nowIso(), projectId]);
  addAuditLog(db, projectId, "human", "client assignment", "project.client_assigned", { clientId });
  return getProjectDetail(db, projectId);
}

function insertExtractedFields(db: AppDb, projectId: string, payload: ParserPayload, humanVerified: boolean): void {
  const seen = new Set<string>();
  const ts = nowIso();
  for (const aliases of Object.values(fieldAliases)) {
    for (const alias of aliases) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      const value = payload[alias];
      if (value == null || value === "") continue;
      db.run(
        `INSERT INTO extracted_fields
           (id, project_id, field_name, field_value, source_file_id, source_method, confidence, human_verified, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id(), projectId, alias, text(value), null, humanVerified ? "human" : "regex", null, humanVerified ? 1 : 0, "", ts],
      );
    }
  }
}

function outcomeFromEmailBucket(bucket: EmailProjectMatch["emailBucket"]): PermitCheckOutcome {
  if (bucket === "permit_correction" || bucket === "nem_correction" || bucket === "missing_info_request") return "correction_flagged";
  if (bucket === "fee_request") return "needs_human_review";
  if (bucket === "permit_approval" || bucket === "nem_approval" || bucket === "inspection_final_notice") return "ready_for_issue";
  return "no_change";
}

function statusLabel(value: string | null | undefined, fallback: PermitCheckOutcome | null): string | null {
  if (value && value.trim()) return value.trim();
  return fallback ? fallback.replaceAll("_", " ") : null;
}

function getProjectLaneStatusSummary(db: AppDb, projectId: string, projectStatus: ProjectRecord["status"]): Pick<
  ProjectListItem,
  | "latestPermitLabel"
  | "latestPermitOutcome"
  | "latestPermitCheckedAt"
  | "readyForIssue"
  | "latestNemLabel"
  | "latestNemOutcome"
  | "latestNemCheckedAt"
  | "nemApproved"
> {
  const checks = db
    .query<Row>("SELECT * FROM permit_status_checks WHERE project_id = ? ORDER BY created_at DESC LIMIT 50", [projectId])
    .map(mapPermitStatusCheck);
  const emails = db
    .query<Row>("SELECT * FROM email_project_matches WHERE project_id = ? ORDER BY created_at DESC LIMIT 50", [projectId])
    .map(mapEmailProjectMatch);

  const latestPermitCheck = checks.find(hasPermitSignal) || checks.find((check) => !hasNemSignal(check)) || null;
  const latestNemCheck = checks.find(hasNemSignal) || null;
  const latestPermitEmail = emails.find((email) => hasPermitSignal(email) && email.workflow !== "nem") || null;
  const latestNemEmail = emails.find((email) => hasNemSignal(email) || email.workflow === "nem" || email.workflow === "both") || null;
  const permitEmailOutcome = latestPermitEmail ? outcomeFromEmailBucket(latestPermitEmail.emailBucket) : null;
  const nemEmailOutcome = latestNemEmail ? outcomeFromEmailBucket(latestNemEmail.emailBucket) : null;
  const permitChecks = checks.filter((check) => hasPermitSignal(check) || !hasNemSignal(check));
  const nemChecks = checks.filter(hasNemSignal);
  const readyForIssue =
    projectStatus === "ready_for_issue"
    || projectStatus === "issued"
    || permitChecks.some((check) => check.readyForIssue || check.outcome === "ready_for_issue" || check.outcome === "issued")
    || emails.some((email) => hasPermitSignal(email) && (email.emailBucket === "permit_approval" || email.emailBucket === "inspection_final_notice"));
  const nemApproved =
    projectStatus === "approved"
    || projectStatus === "complete"
    || nemChecks.some((check) => check.readyForIssue || ["reviewed_by_ahj", "ready_for_issue", "issued"].includes(check.outcome))
    || emails.some((email) => (hasNemSignal(email) || email.workflow === "nem" || email.workflow === "both") && email.emailBucket === "nem_approval");

  return {
    latestPermitLabel: statusLabel(latestPermitCheck?.statusLabel, latestPermitCheck?.outcome ?? permitEmailOutcome),
    latestPermitOutcome: latestPermitCheck?.outcome ?? permitEmailOutcome,
    latestPermitCheckedAt: latestPermitCheck?.createdAt ?? latestPermitEmail?.createdAt ?? null,
    readyForIssue,
    latestNemLabel: statusLabel(latestNemCheck?.statusLabel, latestNemCheck?.outcome ?? nemEmailOutcome),
    latestNemOutcome: latestNemCheck?.outcome ?? nemEmailOutcome,
    latestNemCheckedAt: latestNemCheck?.createdAt ?? latestNemEmail?.createdAt ?? null,
    nemApproved,
  };
}

export function getProjectList(db: AppDb): ProjectListItem[] {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.query<ProjectRow & Row>(
    `SELECT p.*,
      (SELECT COUNT(*) FROM qc_results q WHERE q.project_id = p.id AND q.qc_status = 'fail') AS qcFailCount,
      (SELECT COUNT(*) FROM qc_results q WHERE q.project_id = p.id AND q.qc_status = 'warning') AS qcWarningCount,
      (SELECT COUNT(*) FROM human_review_items h WHERE h.project_id = p.id AND h.status = 'pending') AS pendingReviewCount,
      (SELECT COUNT(*) FROM corrections c WHERE c.project_id = p.id) AS correctionCount,
      (SELECT COUNT(*) FROM corrections c WHERE c.project_id = p.id AND c.closed_at IS NULL
         AND (c.due_at < ? OR (c.due_at IS NULL AND date(c.created_at, '+' || c.sla_days || ' days') < ?))) AS overdueCorrections,
      (SELECT pr.status FROM portal_runs pr WHERE pr.project_id = p.id ORDER BY pr.started_at DESC LIMIT 1) AS latestPortalStatus
     FROM projects p
     ORDER BY p.updated_at DESC`,
    [today, today],
  );

  return rows.map((row) => {
    const project = mapProject(row);
    const { parserSnapshot: _parserSnapshot, ...listBase } = project;
    const laneSummary = getProjectLaneStatusSummary(db, project.id, project.status);
    return {
      ...listBase,
      qcFailCount: Number(row.qcFailCount ?? 0),
      qcWarningCount: Number(row.qcWarningCount ?? 0),
      pendingReviewCount: Number(row.pendingReviewCount ?? 0),
      correctionCount: Number(row.correctionCount ?? 0),
      overdueCorrections: Number(row.overdueCorrections ?? 0),
      assignedUserId: row.assigned_user_id == null ? null : text(row.assigned_user_id),
      latestPortalStatus: row.latestPortalStatus == null ? null : (text(row.latestPortalStatus) as ProjectListItem["latestPortalStatus"]),
      ...laneSummary,
    };
  });
}

export function getProjectDetail(db: AppDb, projectId: string): ProjectDetail {
  const projectRow = db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!projectRow) throw new HttpError(404, "Project not found.");

  return {
    project: mapProject(projectRow),
    qcResults: db.query<Row>("SELECT * FROM qc_results WHERE project_id = ? ORDER BY created_at DESC", [projectId]).map(mapQc),
    humanReviewItems: db
      .query<Row>("SELECT * FROM human_review_items WHERE project_id = ? ORDER BY status DESC, created_at DESC", [projectId])
      .map(mapReview),
    corrections: db.query<Row>("SELECT * FROM corrections WHERE project_id = ? ORDER BY created_at DESC", [projectId]).map(mapCorrection),
    permitCheckTargets: db
      .query<Row>("SELECT * FROM permit_check_targets WHERE project_id = ? ORDER BY active DESC, created_at DESC", [projectId])
      .map(mapPermitTarget),
    permitStatusChecks: db
      .query<Row>("SELECT * FROM permit_status_checks WHERE project_id = ? ORDER BY created_at DESC LIMIT 50", [projectId])
      .map(mapPermitStatusCheck),
    emailProjectMatches: db
      .query<Row>("SELECT * FROM email_project_matches WHERE project_id = ? ORDER BY created_at DESC LIMIT 50", [projectId])
      .map(mapEmailProjectMatch),
    portalRuns: db.query<Row>("SELECT * FROM portal_runs WHERE project_id = ? ORDER BY started_at DESC", [projectId]).map(mapPortalRun),
    submissions: db.query<Row>("SELECT * FROM submissions WHERE project_id = ? ORDER BY created_at DESC", [projectId]).map(mapSubmission),
    auditLogs: db.query<Row>("SELECT * FROM audit_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT 100", [projectId]).map(mapAudit),
  };
}

function correctionPatternSignature(row: Row): string {
  return [text(row.correction_bucket), text(row.root_cause), text(row.required_action)]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function rebuildKnowledgeRollup(db: AppDb, profileKey: string): void {
  const projectRow = db.get<Row>(
    `SELECT COUNT(DISTINCT project_id) AS project_count
     FROM knowledge_events
     WHERE profile_key = ? AND project_id IS NOT NULL`,
    [profileKey],
  );
  const correctionRows = db.query<Row>(
    `SELECT correction_bucket, root_cause, required_action, sample, MAX(created_at) AS last_seen_at, COUNT(*) AS count
     FROM historical_failure_examples
     WHERE profile_key = ?
     GROUP BY correction_bucket, root_cause, required_action
     ORDER BY count DESC, last_seen_at DESC
     LIMIT 25`,
    [profileKey],
  );
  const commonCorrections = correctionRows.map((row) => ({
    signature: correctionPatternSignature(row),
    bucket: text(row.correction_bucket),
    rootCause: text(row.root_cause),
    requiredAction: text(row.required_action),
    count: Number(row.count ?? 0),
    lastSeenAt: text(row.last_seen_at),
    sample: text(row.sample),
  }));
  db.run(
    `UPDATE permit_utility_knowledge
     SET project_count = ?, common_corrections_json = ?, correction_count = ?, updated_at = ?
     WHERE profile_key = ?`,
    [
      Number(projectRow?.project_count ?? 0),
      asJson(commonCorrections),
      commonCorrections.reduce((sum, item) => sum + item.count, 0),
      nowIso(),
      profileKey,
    ],
  );
}

export function deleteProject(db: AppDb, projectId: string): { deleted: true; projectId: string; affectedKnowledgeProfiles: number } {
  const project = db.get<Row>("SELECT id, homeowner_name, project_address FROM projects WHERE id = ?", [projectId]);
  if (!project) throw new HttpError(404, "Project not found.");

  const affectedKeys = new Set(
    db
      .query<Row>(
        `SELECT profile_key FROM knowledge_events WHERE project_id = ?
         UNION
         SELECT profile_key FROM historical_project_fingerprints WHERE project_id = ?
         UNION
         SELECT profile_key FROM historical_failure_examples WHERE project_id = ?`,
        [projectId, projectId, projectId],
      )
      .map((row) => text(row.profile_key))
      .filter(Boolean),
  );

  db.transaction(() => {
    db.run("DELETE FROM email_project_matches WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM permit_status_checks WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM permit_check_targets WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM portal_runs WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM submissions WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM human_review_items WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM corrections WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM qc_results WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM extracted_fields WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM source_files WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM audit_logs WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM historical_failure_examples WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM historical_project_fingerprints WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM knowledge_events WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM project_notes WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM operation_steps WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM projects WHERE id = ?", [projectId]);

    for (const key of affectedKeys) rebuildKnowledgeRollup(db, key);
    addAuditLog(db, null, "human", "dashboard", "project.deleted", {
      projectId,
      homeownerName: text(project.homeowner_name),
      projectAddress: text(project.project_address),
      affectedKnowledgeProfiles: affectedKeys.size,
    });
  });

  return { deleted: true, projectId, affectedKnowledgeProfiles: affectedKeys.size };
}

export function getKnowledgeBase(db: AppDb): { profiles: PermitUtilityKnowledgeProfile[] } {
  return { profiles: listKnowledgeProfiles(db) };
}

interface OperationStepDraft {
  phaseKey: string;
  phaseName: string;
  status: OperationStepStatus;
  ownerRole: string;
  summary: string;
  nextAction: string;
  sortOrder: number;
  source: string;
}

const operationStatusSet = new Set<OperationStepStatus>(["not_started", "in_progress", "waiting", "blocked", "done"]);

function parserBlob(project: ProjectRecord): string {
  const snapshot = project.parserSnapshot || {};
  return [
    project.homeownerName,
    project.projectAddress,
    project.ahj,
    project.utility,
    project.accountNumber,
    project.meterNumber,
    project.interconnectionMethod,
    text(snapshot.splitPagesText),
    text(snapshot.packetReadinessText),
    text(snapshot.utilityDownloadChecklistText),
    text(snapshot.utilityUploadNotesText),
    text(snapshot.projectDescriptionText),
    text(snapshot.sitePlanNotesText),
    text(snapshot.roofPlanNotesText),
    text(snapshot.structuralCalcText),
    text(snapshot.electricalCalcText),
    text(snapshot.labelsText),
  ].join("\n");
}

function hasSourcePackage(project: ProjectRecord): boolean {
  return /sld|single.line|one.line|3.line|site plan|roof plan|plot plan|module spec|inverter spec|utility bill/i.test(parserBlob(project));
}

function isStagedOrSubmitted(status: ProjectRecord["status"]): boolean {
  return ["awaiting_human_submit", "submitted", "approved", "ready_for_issue", "issued", "complete"].includes(status);
}

function operationDrafts(db: AppDb, detail: ProjectDetail): OperationStepDraft[] {
  const project = detail.project;
  const historicalReport = buildHistoricalFailureReport(db, project.id);
  const reviewerReport = buildReviewerReport(project);
  const applicationDocs = buildApplicationDocumentPackage(project);
  const pendingCritical = detail.humanReviewItems.filter((item) => item.status === "pending" && item.fieldName !== "correction").length;
  const pendingCorrections = detail.humanReviewItems.filter((item) => item.status === "pending" && item.fieldName === "correction").length;
  const qcFails = detail.qcResults.filter((item) => item.qcStatus === "fail").length;
  const qcWarnings = detail.qcResults.filter((item) => item.qcStatus === "warning").length;
  const reviewerBlockers = reviewerReport.findings.filter((item) => item.severity === "blocker").length;
  const reviewerWarnings = reviewerReport.findings.filter((item) => item.severity === "warning").length;
  const historicalMissing = historicalReport.checklist.filter((item) => item.status === "missing").length;
  const learnedHistoricalBlockers = historicalReport.checklist.filter((item) => {
    const cause = historicalReport.topRejectionCauses.find((candidate) => candidate.signature === item.sourceCauseSignature);
    return item.status === "missing" && Boolean(cause && cause.count > 0 && cause.severity === "blocker");
  }).length;
  const identityMissing = [
    project.homeownerName,
    project.projectAddress,
    project.utility,
    project.ahj,
    project.accountNumber,
    project.meterNumber,
    project.systemSizeDcKw,
    project.systemSizeAcKw,
  ].filter((value) => value == null || value === "").length;
  const packageReady = applicationDocs.missingFields.length === 0 && reviewerBlockers === 0 && learnedHistoricalBlockers === 0 && qcFails === 0 && pendingCritical === 0;
  const latestPermit = detail.permitStatusChecks[0];
  const hasNemApproval = detail.permitStatusChecks.some((check) => /nem|interconnection|pto|utility/i.test(`${check.statusLabel}\n${check.rawStatusText}`) && ["reviewed_by_ahj", "ready_for_issue", "issued"].includes(check.outcome));
  const hasCorrections = detail.corrections.length > 0;
  const openCorrectionCount = detail.corrections.filter((correction) => !correction.closedAt && !correction.resubmitted).length + pendingCorrections;
  const hasPortalStaging = detail.portalRuns.some((run) => run.status === "awaiting_human_submit" || run.status === "submitted");
  const projectDone = ["issued", "approved", "complete"].includes(project.status);

  return [
    {
      phaseKey: "customer_upload",
      phaseName: "Customer Upload",
      status: hasSourcePackage(project) ? "done" : "in_progress",
      ownerRole: "Intake Coordinator",
      summary: hasSourcePackage(project) ? "Source package evidence is present in the parser snapshot." : "Project exists, but source package evidence is thin.",
      nextAction: hasSourcePackage(project) ? "Confirm files are current and no upload is missing." : "Upload/parse the real plan set, utility bill, specs, photos, and AHJ forms.",
      sortOrder: 10,
      source: "system.signals",
    },
    {
      phaseKey: "project_intake",
      phaseName: "Project Intake",
      status: identityMissing ? "blocked" : "done",
      ownerRole: "Intake Coordinator",
      summary: identityMissing ? `${identityMissing} core intake field(s) still need verification.` : `${project.homeownerName || "Project"} at ${project.projectAddress || "address captured"}.`,
      nextAction: identityMissing ? "Resolve homeowner, address, AHJ, utility, account, meter, and system-size gaps." : "Lock the intake fields as the source of truth for forms and portal staging.",
      sortOrder: 20,
      source: "system.signals",
    },
    {
      phaseKey: "data_extraction",
      phaseName: "Data Extraction",
      status: qcFails ? "blocked" : pendingCritical ? "waiting" : qcWarnings ? "in_progress" : "done",
      ownerRole: "Data QA",
      summary: `${qcFails} QC fail(s), ${qcWarnings} warning(s), ${pendingCritical} critical human review item(s).`,
      nextAction: qcFails || pendingCritical ? "Work the Human Review queue and rerun QC." : qcWarnings ? "Review warnings and evidence confidence before package build." : "Extraction is clean enough for package generation.",
      sortOrder: 30,
      source: "qc.human_review",
    },
    {
      phaseKey: "requirements_engine",
      phaseName: "Requirements Engine",
      status: learnedHistoricalBlockers || reviewerBlockers ? "blocked" : historicalMissing || reviewerWarnings ? "waiting" : "done",
      ownerRole: "Permit Ops",
      summary: `${historicalReport.summaryLabel}; ${reviewerBlockers} reviewer blocker(s), ${reviewerWarnings} warning(s).`,
      nextAction: learnedHistoricalBlockers || reviewerBlockers ? "Clear reviewer and historical-failure blockers before staging." : historicalMissing || reviewerWarnings ? "Review generated checklist and warning callouts." : "Requirements check is clear.",
      sortOrder: 40,
      source: "requirements.reviewer.history",
    },
    {
      phaseKey: "package_generation",
      phaseName: "Permit Package Generation",
      status: applicationDocs.missingFields.length || reviewerBlockers ? "blocked" : packageReady ? "done" : "in_progress",
      ownerRole: "Permit Ops",
      summary: `${applicationDocs.docs.length} generated AHJ/NEM document(s); ${applicationDocs.missingFields.length} missing field(s).`,
      nextAction: applicationDocs.missingFields.length ? "Fill missing form fields and regenerate the AHJ docs packet." : "Open the print packet and verify forms/attachments before portal staging.",
      sortOrder: 50,
      source: "forms.application_docs",
    },
    {
      phaseKey: "ahj_submission",
      phaseName: "AHJ Submission",
      status: projectDone || hasPortalStaging || isStagedOrSubmitted(project.status) ? "waiting" : packageReady ? "in_progress" : "not_started",
      ownerRole: "Submission Specialist",
      summary: hasPortalStaging ? "Portal staging exists and is awaiting human submit/confirmation." : packageReady ? "Package can move toward supervised AHJ staging." : "AHJ submission is waiting on upstream blockers.",
      nextAction: hasPortalStaging ? "Verify final portal preview and capture human submit confirmation." : packageReady ? "Prepare Submittal and stop at final review for human submit." : "Do not stage until intake, QC, reviewer, and docs are clear.",
      sortOrder: 60,
      source: "portal.submission",
    },
    {
      phaseKey: "interconnection_submission",
      phaseName: "Interconnection Submission",
      status: hasNemApproval ? "done" : project.utility && project.accountNumber && project.meterNumber ? "in_progress" : "blocked",
      ownerRole: "NEM Ops",
      summary: hasNemApproval ? "NEM/interconnection approval signal has been captured." : `${project.utility || "Utility missing"} NEM package needs tracking through approval/PTO.`,
      nextAction: hasNemApproval ? "Attach approval evidence and keep tracking PTO/final utility requirements." : "Confirm NEM-required files, submit/stage utility application, and monitor email/portal updates.",
      sortOrder: 70,
      source: "utility.nem",
    },
    {
      phaseKey: "correction_management",
      phaseName: "Correction Management",
      status: openCorrectionCount ? "blocked" : hasCorrections ? "done" : "not_started",
      ownerRole: "Corrections Coordinator",
      summary: openCorrectionCount ? `${openCorrectionCount} open correction/review item(s).` : hasCorrections ? "Corrections exist, but none are currently open." : "No corrections received yet.",
      nextAction: openCorrectionCount ? "Classify, assign, and resolve correction items before resubmittal." : "Keep monitoring email and portal updates for correction requests.",
      sortOrder: 80,
      source: "corrections.email.portal",
    },
    {
      phaseKey: "approval_tracking",
      phaseName: "Approval Tracking",
      status: projectDone ? "done" : latestPermit ? "in_progress" : detail.permitCheckTargets.length ? "waiting" : "not_started",
      ownerRole: "Operations Coordinator",
      summary: latestPermit ? `${latestPermit.statusLabel}: ${latestPermit.message}` : detail.permitCheckTargets.length ? "Tracking target exists; no status checks captured yet." : "No active approval tracking target.",
      nextAction: projectDone ? "Archive approvals and release install-ready package." : latestPermit ? "Continue scheduled checks and capture approvals/fees/issued permit." : "Create permit/NEM tracking target and connect email watch source.",
      sortOrder: 90,
      source: "tracking.status",
    },
    {
      phaseKey: "install_ready",
      phaseName: "Install Ready",
      status: projectDone ? "done" : project.status === "ready_for_issue" ? "waiting" : "not_started",
      ownerRole: "Install Coordinator",
      summary: projectDone ? "Project has reached approval/issued/complete status." : project.status === "ready_for_issue" ? "Permit is ready for issue; remaining human/admin steps must be finished." : "Install release is not ready yet.",
      nextAction: projectDone ? "Hand off final approved package to install operations." : project.status === "ready_for_issue" ? "Pay/capture fees if required, download permit, and confirm NEM/inspection dependencies." : "Wait for AHJ/NEM approvals and closeout evidence.",
      sortOrder: 100,
      source: "install.release",
    },
  ];
}

function planStatus(steps: OperationStep[]): OperationStepStatus {
  if (steps.some((step) => step.status === "blocked")) return "blocked";
  if (steps.some((step) => step.status === "waiting")) return "waiting";
  if (steps.some((step) => step.status === "in_progress")) return "in_progress";
  if (steps.every((step) => step.status === "done")) return "done";
  return "not_started";
}

function planCounts(steps: OperationStep[]): Record<OperationStepStatus, number> {
  return steps.reduce<Record<OperationStepStatus, number>>(
    (counts, step) => {
      counts[step.status] += 1;
      return counts;
    },
    { not_started: 0, in_progress: 0, waiting: 0, blocked: 0, done: 0 },
  );
}

function readOperationsPlan(db: AppDb, projectId: string): OperationsPlan {
  const steps = db
    .query<Row>("SELECT * FROM operation_steps WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC", [projectId])
    .map(mapOperationStep);
  const notes = db
    .query<Row>("SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at DESC LIMIT 30", [projectId])
    .map(mapProjectNote);
  const current = steps.find((step) => step.status === "blocked")
    || steps.find((step) => step.status === "waiting")
    || steps.find((step) => step.status === "in_progress")
    || steps.find((step) => step.status === "not_started")
    || steps[steps.length - 1];
  return {
    projectId,
    generatedAt: nowIso(),
    status: planStatus(steps),
    currentPhase: current?.phaseName || "No plan",
    nextAction: current?.nextAction || "Generate an operations plan.",
    steps,
    notes,
    counts: planCounts(steps),
  };
}

export function syncOperationsPlan(db: AppDb, projectId: string): OperationsPlan {
  const detail = getProjectDetail(db, projectId);
  const drafts = operationDrafts(db, detail);
  const ts = nowIso();
  db.transaction(() => {
    for (const draft of drafts) {
      const existing = db.get<Row>("SELECT * FROM operation_steps WHERE project_id = ? AND phase_key = ?", [projectId, draft.phaseKey]);
      if (existing) {
        const existingStep = mapOperationStep(existing);
        const status = existingStep.statusSource === "manual" ? existingStep.status : draft.status;
        const owner = existingStep.ownerRole || draft.ownerRole;
        const changed =
          existingStep.phaseName !== draft.phaseName ||
          existingStep.status !== status ||
          existingStep.ownerRole !== owner ||
          existingStep.summary !== draft.summary ||
          existingStep.nextAction !== draft.nextAction ||
          existingStep.sortOrder !== draft.sortOrder ||
          existingStep.source !== draft.source;
        if (changed) {
          db.run(
            `UPDATE operation_steps
             SET phase_name = ?, status = ?, owner_role = ?, summary = ?, next_action = ?,
                 sort_order = ?, source = ?, updated_at = ?
             WHERE id = ?`,
            [draft.phaseName, status, owner, draft.summary, draft.nextAction, draft.sortOrder, draft.source, ts, existingStep.id],
          );
        }
      } else {
        db.run(
          `INSERT INTO operation_steps
            (id, project_id, phase_key, phase_name, status, status_source, owner_role, due_at,
             summary, next_action, notes, sort_order, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id(),
            projectId,
            draft.phaseKey,
            draft.phaseName,
            draft.status,
            "system",
            draft.ownerRole,
            null,
            draft.summary,
            draft.nextAction,
            "",
            draft.sortOrder,
            draft.source,
            ts,
            ts,
          ],
        );
      }
    }
  });
  return readOperationsPlan(db, projectId);
}

export function updateOperationStep(
  db: AppDb,
  projectId: string,
  stepId: string,
  input: { status?: string; ownerRole?: string; dueAt?: string | null; notes?: string },
): OperationsPlan {
  const step = db.get<Row>("SELECT * FROM operation_steps WHERE id = ? AND project_id = ?", [stepId, projectId]);
  if (!step) throw new HttpError(404, "Operation step not found.");
  const status = input.status ? String(input.status) : text(step.status);
  if (!operationStatusSet.has(status as OperationStepStatus)) throw new HttpError(400, "Invalid operation step status.");
  const ts = nowIso();
  db.run(
    `UPDATE operation_steps
     SET status = ?, status_source = ?, owner_role = ?, due_at = ?, notes = ?, updated_at = ?
     WHERE id = ?`,
    [
      status,
      input.status ? "manual" : text(step.status_source) || "system",
      input.ownerRole == null ? text(step.owner_role) : text(input.ownerRole),
      input.dueAt === undefined ? (step.due_at == null ? null : text(step.due_at)) : input.dueAt ? text(input.dueAt) : null,
      input.notes == null ? text(step.notes) : text(input.notes),
      ts,
      stepId,
    ],
  );
  addAuditLog(db, projectId, "human", "operations plan", "operation_step.updated", {
    stepId,
    phaseKey: text(step.phase_key),
    status,
  });
  return syncOperationsPlan(db, projectId);
}

export function addProjectNote(
  db: AppDb,
  projectId: string,
  input: { noteType?: string; body?: string; createdBy?: string },
): OperationsPlan {
  getProjectDetail(db, projectId);
  const body = text(input.body).trim();
  if (!body) throw new HttpError(400, "Note body is required.");
  const noteType = (["pm_note", "blocker", "client_update", "handoff", "system_note"].includes(text(input.noteType)) ? text(input.noteType) : "pm_note") as ProjectNoteType;
  const ts = nowIso();
  db.run(
    `INSERT INTO project_notes (id, project_id, note_type, body, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id(), projectId, noteType, body, text(input.createdBy) || "ops user", ts],
  );
  addAuditLog(db, projectId, "human", "operations plan", "project_note.added", {
    noteType,
    bodyPreview: body.slice(0, 160),
  });
  return syncOperationsPlan(db, projectId);
}

const runbookProcessStepIds: Record<string, string[]> = {
  customer_upload: ["intake-source-package"],
  project_intake: ["intake-project-record"],
  data_extraction: ["intake-qc"],
  requirements_engine: ["permit-requirements"],
  package_generation: ["permit-package", "nem-packet"],
  ahj_submission: ["permit-submit-review"],
  interconnection_submission: ["nem-requirements", "nem-account-proof", "nem-packet", "nem-application"],
  correction_management: ["permit-review-corrections", "nem-corrections"],
  approval_tracking: ["permit-issuance", "nem-approval-pto", "closeout-tracking"],
  install_ready: ["closeout-install-ready"],
};

function currentOperationStep(steps: OperationStep[]): OperationStep | null {
  return steps.find((step) => step.status === "blocked")
    || steps.find((step) => step.status === "waiting")
    || steps.find((step) => step.status === "in_progress")
    || steps.find((step) => step.status === "not_started")
    || steps[steps.length - 1]
    || null;
}

function doneCriteriaForPhase(phaseKey: string): string[] {
  const criteria: Record<string, string[]> = {
    customer_upload: [
      "Planset, site/roof plan, one-line, utility bill, equipment specs, photos, and labels are parsed or attached.",
      "File versions are current enough for AHJ and utility/NEM review.",
    ],
    project_intake: [
      "Homeowner, service address, AHJ, utility, account, meter, DC/AC size, and interconnection are verified.",
      "The project record is treated as the single source of truth.",
    ],
    data_extraction: [
      "Deterministic QC has no failing critical fields.",
      "Human review values are approved, edited, or rejected with notes.",
    ],
    requirements_engine: [
      "Historical failure checklist gaps are cleared or accepted with a PM note.",
      "Reviewer-gate blockers are resolved before staging.",
    ],
    package_generation: [
      "Required AHJ/NEM documents are generated and missing form fields are zero.",
      "The print packet has been reviewed against the source project record.",
    ],
    ahj_submission: [
      "Portal staging stops at final review.",
      "A human verifies the preview and captures confirmation after manual submit.",
    ],
    interconnection_submission: [
      "Utility account/meter proof, SLD, specs, inverter settings, and NEM forms match.",
      "Utility/NEM status is tracked through approval or PTO.",
    ],
    correction_management: [
      "Corrections are classified, assigned, and closed or resubmitted.",
      "New preventable causes are learned into the knowledge base.",
    ],
    approval_tracking: [
      "AHJ and NEM targets or email matches are monitored.",
      "Fees, ready-to-issue, approval, PTO, and issued permit signals are captured.",
    ],
    install_ready: [
      "AHJ permit/approval evidence and NEM/PTO readiness are attached.",
      "Install handoff notes are clear enough for the next owner.",
    ],
  };
  return criteria[phaseKey] || ["Owner confirms this phase is complete and leaves a PM note."];
}

function processStepsForRunbook(processMap: ProjectProcessMap, phaseKey: string): ProjectProcessStep[] {
  const ids = new Set(runbookProcessStepIds[phaseKey] || []);
  return processMap.lanes.flatMap((lane) => lane.steps).filter((step) => ids.has(step.id));
}

function runbookEvidenceForStep(
  step: OperationStep,
  processSteps: ProjectProcessStep[],
  installerItems: InstallerActionItem[],
): string[] {
  const relatedInstallerItems = installerItems.filter((item) => {
    const value = `${step.phaseKey} ${step.phaseName} ${step.ownerRole} ${step.nextAction}`;
    if (/interconnection|nem|utility/i.test(value)) return item.category === "utility_nem" || item.ownerRole === "NEM Ops";
    if (/correction/i.test(value)) return item.category === "correction";
    if (/package|document|application/i.test(value)) return item.category === "documents";
    if (/review|requirement/i.test(value)) return item.category === "design" || item.category === "field_verification";
    return false;
  });
  return [
    ...processSteps.flatMap((processStep) => processStep.evidence),
    ...relatedInstallerItems.slice(0, 3).map((item) => `${item.severity.toUpperCase()}: ${item.title}`),
  ]
    .filter(Boolean)
    .map((line) => shorten(text(line), 180))
    .slice(0, 6);
}

function renderRunbookText(report: Omit<ProjectRunbook, "reportText">): string {
  return [
    `PM Runbook - ${new Date(report.generatedAt).toLocaleString()}`,
    report.headline,
    "",
    `Next action: ${report.nextAction}`,
    "",
    "Steps:",
    ...report.steps.map((step, index) => [
      `${index + 1}. ${step.status.replaceAll("_", " ").toUpperCase()} - ${step.phaseName}${step.isCurrent ? " (CURRENT)" : ""}`,
      `   Owner: ${step.ownerRole}`,
      step.dueAt ? `   Due: ${step.dueAt}` : "",
      `   Do: ${step.whatToDo}`,
      `   Why: ${step.why}`,
      `   Done when: ${step.doneCriteria.join(" / ")}`,
      step.notes ? `   PM note: ${step.notes}` : "",
      step.evidence[0] ? `   Evidence: ${step.evidence[0]}` : "",
    ].filter(Boolean).join("\n")),
    "",
    "Recent notes:",
    ...(report.recentNotes.length
      ? report.recentNotes.slice(0, 8).map((note) => `- ${note.noteType.replaceAll("_", " ")} | ${note.createdBy || "Operations"} | ${note.body}`)
      : ["- No PM notes yet."]),
  ].join("\n");
}

export function getProjectRunbook(db: AppDb, projectId: string): ProjectRunbook {
  const plan = syncOperationsPlan(db, projectId);
  const processMap = getProjectProcessMap(db, projectId);
  const installerPacket = getInstallerActionPacket(db, projectId);
  const current = currentOperationStep(plan.steps);
  const steps: ProjectRunbookStep[] = plan.steps.map((step) => {
    const processSteps = processStepsForRunbook(processMap, step.phaseKey);
    return {
      id: step.id,
      phaseKey: step.phaseKey,
      phaseName: step.phaseName,
      status: step.status,
      ownerRole: step.ownerRole || "Operations",
      dueAt: step.dueAt,
      whatToDo: step.nextAction,
      why: step.summary,
      doneCriteria: doneCriteriaForPhase(step.phaseKey),
      evidence: runbookEvidenceForStep(step, processSteps, installerPacket.items),
      notes: step.notes,
      source: step.source,
      isCurrent: current?.id === step.id,
    };
  });
  const generatedAt = nowIso();
  const headline = `${plan.currentPhase} is current: ${plan.counts.blocked} blocked, ${plan.counts.waiting} waiting, ${plan.counts.in_progress} active, ${plan.counts.done} done.`;
  const baseReport: Omit<ProjectRunbook, "reportText"> = {
    projectId,
    generatedAt,
    status: plan.status,
    headline,
    currentStepId: current?.id || null,
    nextAction: plan.nextAction,
    totalSteps: steps.length,
    doneCount: plan.counts.done,
    blockedCount: plan.counts.blocked,
    waitingCount: plan.counts.waiting,
    inProgressCount: plan.counts.in_progress,
    noteCount: plan.notes.length,
    steps,
    recentNotes: plan.notes.slice(0, 10),
  };
  return {
    ...baseReport,
    reportText: renderRunbookText(baseReport),
  };
}

function signal(title: string, detail: string, severity: OperationsBriefSignal["severity"], source: string): OperationsBriefSignal {
  return { title, detail, severity, source };
}

function activity(title: string, detail: string, severity: OperationsBriefActivity["severity"], occurredAt: string, source: string): OperationsBriefActivity {
  return { title, detail, severity, occurredAt, source };
}

function projectIdentityReady(project: ProjectRecord): boolean {
  return Boolean(
    project.homeownerName
      && project.projectAddress
      && project.ahj
      && project.utility
      && project.accountNumber
      && project.meterNumber
      && project.systemSizeDcKw != null
      && project.systemSizeAcKw != null,
  );
}

function handoffLine(label: string, value: string): string {
  return value ? `${label}: ${value}` : "";
}

export function getOperationsBrief(db: AppDb, projectId: string): OperationsBrief {
  const detail = getProjectDetail(db, projectId);
  const plan = syncOperationsPlan(db, projectId);
  const project = detail.project;
  const reviewerReport = buildReviewerReport(project);
  const applicationDocs = buildApplicationDocumentPackage(project);
  const historicalReport = buildHistoricalFailureReport(db, projectId);
  const blockers: OperationsBriefSignal[] = [];
  const readySignals: OperationsBriefSignal[] = [];

  const qcFails = detail.qcResults.filter((item) => item.qcStatus === "fail");
  const qcWarnings = detail.qcResults.filter((item) => item.qcStatus === "warning");
  const pendingCritical = detail.humanReviewItems.filter((item) => item.status === "pending" && item.fieldName !== "correction");
  const pendingCorrections = detail.humanReviewItems.filter((item) => item.status === "pending" && item.fieldName === "correction");
  const reviewerBlockers = reviewerReport.findings.filter((item) => item.severity === "blocker");
  const reviewerWarnings = reviewerReport.findings.filter((item) => item.severity === "warning");
  const historicalMissing = historicalReport.checklist.filter((item) => item.status === "missing");
  const openCorrections = detail.corrections.filter((correction) => !correction.closedAt && !correction.resubmitted);

  if (qcFails.length) {
    blockers.push(signal("QC failures", `${qcFails.length} deterministic QC failure(s) must be resolved before staging.`, "blocker", "qc"));
  }
  if (pendingCritical.length) {
    blockers.push(signal("Human review required", `${pendingCritical.length} critical extracted value(s) need approval or edit.`, "blocker", "human_review"));
  }
  if (reviewerBlockers.length) {
    blockers.push(signal("Reviewer gate blockers", `${reviewerBlockers.length} AHJ-style reviewer blocker(s) found.`, "blocker", "reviewer_gate"));
  }
  if (applicationDocs.missingFields.length) {
    blockers.push(signal("Application fields missing", `${applicationDocs.missingFields.length} required AHJ/NEM form field(s): ${applicationDocs.missingFields.slice(0, 6).join(", ")}.`, "blocker", "application_docs"));
  }
  if (openCorrections.length || pendingCorrections.length) {
    blockers.push(signal("Open corrections", `${openCorrections.length + pendingCorrections.length} correction/review item(s) are still open.`, "blocker", "corrections"));
  }
  if (!projectIdentityReady(project)) {
    blockers.push(signal("Project identity incomplete", "Homeowner, service address, AHJ, utility, account, meter, and system size are not all verified.", "blocker", "intake"));
  }

  if (projectIdentityReady(project)) {
    readySignals.push(signal("Core intake verified", `${project.homeownerName || "Homeowner"} at ${project.projectAddress || "service address"} has AHJ, utility, account, meter, and system sizing captured.`, "pass", "intake"));
  }
  if (hasSourcePackage(project)) {
    readySignals.push(signal("Source package present", "Parser snapshot includes plan/package evidence such as one-line, site/roof plan, specs, utility bill, or readiness markers.", "pass", "parser"));
  }
  if (!qcFails.length && !pendingCritical.length && detail.qcResults.length) {
    readySignals.push(signal("QC queue clear", qcWarnings.length ? `${qcWarnings.length} warning(s) remain, but no critical QC failures are open.` : "No critical QC failures are open.", qcWarnings.length ? "warning" : "pass", "qc"));
  }
  if (!reviewerBlockers.length && reviewerReport.findings.length) {
    readySignals.push(signal("Reviewer gate has evidence", reviewerWarnings.length ? `${reviewerWarnings.length} warning(s) remain with evidence trails.` : "AHJ-style reviewer gate has no blockers.", reviewerWarnings.length ? "warning" : "pass", "reviewer_gate"));
  }
  if (!applicationDocs.missingFields.length && applicationDocs.docs.length) {
    readySignals.push(signal("AHJ/NEM docs generated", `${applicationDocs.docs.length} document/checklist item(s) generated for the matched profile.`, "pass", "application_docs"));
  }
  if (historicalReport.matchedProjectCount || historicalMissing.length) {
    readySignals.push(signal("Historical precheck run", `${historicalReport.summaryLabel}; ${historicalMissing.length} missing historical checklist item(s).`, historicalMissing.length ? "warning" : "pass", "historical_failures"));
  }
  if (detail.emailProjectMatches.length) {
    readySignals.push(signal("Email tracking matched", `${detail.emailProjectMatches.length} permitting/NEM email update(s) matched to this project.`, "info", "email_tracker"));
  }
  if (detail.permitCheckTargets.length) {
    readySignals.push(signal("Approval tracking configured", `${detail.permitCheckTargets.length} permit/NEM target(s) configured for follow-up.`, "info", "permit_monitor"));
  }

  const immediateActions = plan.steps
    .filter((step) => ["blocked", "waiting", "in_progress"].includes(step.status))
    .slice(0, 6)
    .map((step) => ({
      phaseName: step.phaseName,
      ownerRole: step.ownerRole || "Unassigned",
      action: step.nextAction,
      reason: step.summary,
      status: step.status,
      dueAt: step.dueAt,
    }));

  const recentActivity = [
    ...plan.notes.slice(0, 8).map((note) => activity(note.noteType.replaceAll("_", " "), note.body, note.noteType === "blocker" ? "blocker" : "info", note.createdAt, `note:${note.createdBy || "Operations"}`)),
    ...detail.permitStatusChecks.slice(0, 6).map((check) => activity(check.statusLabel, check.message, check.outcome === "correction_flagged" ? "blocker" : check.readyForIssue ? "pass" : "info", check.createdAt, check.source)),
    ...detail.emailProjectMatches.slice(0, 6).map((match) => activity(match.emailBucket.replaceAll("_", " "), match.subject || match.matchReason, match.emailBucket.includes("correction") ? "blocker" : match.emailBucket.includes("approval") ? "pass" : "info", match.createdAt, "email_tracker")),
    ...detail.corrections.slice(0, 6).map((correction) => activity(correction.correctionBucket, correction.requiredAction || correction.correctionText.slice(0, 160), correction.closedAt || correction.resubmitted ? "pass" : "blocker", correction.createdAt, correction.source)),
    ...detail.auditLogs.slice(0, 8).map((log) => activity(log.action, `${log.actorType}: ${log.actorName}`, "info", log.createdAt, "audit")),
  ]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 10);

  const health: OperationsBrief["health"] = blockers.length || plan.status === "blocked" ? "blocked" : plan.status === "done" ? "ready" : "watch";
  const headline = health === "blocked"
    ? `Blocked before submission: ${blockers.length} issue group(s) need attention.`
    : health === "ready"
      ? "Ready for install/closeout handoff based on current project signals."
      : `Watch item: ${plan.currentPhase} is the active phase.`;

  const handoffParts = [
    handoffLine("Project", [project.homeownerName, project.projectAddress].filter(Boolean).join(" - ")),
    handoffLine("Status", project.status),
    handoffLine("Utility/AHJ", [project.utility, project.ahj].filter(Boolean).join(" / ")),
    handoffLine("Current phase", plan.currentPhase),
    handoffLine("Next action", plan.nextAction),
    blockers.length ? `Blockers: ${blockers.slice(0, 5).map((item) => item.title).join("; ")}` : "Blockers: none currently flagged",
    immediateActions.length ? `Owners: ${immediateActions.slice(0, 4).map((item) => `${item.ownerRole} -> ${item.phaseName}`).join("; ")}` : "",
  ].filter(Boolean);

  return {
    projectId,
    generatedAt: nowIso(),
    health,
    headline,
    currentPhase: plan.currentPhase,
    nextAction: plan.nextAction,
    counts: plan.counts,
    immediateActions,
    blockers,
    readySignals,
    recentActivity,
    handoffNote: handoffParts.join("\n"),
  };
}

function handoffSection(input: ProjectHandoffPacketSection): ProjectHandoffPacketSection {
  return {
    ...input,
    lines: input.lines.filter(Boolean).map((line) => shorten(text(line), 240)).slice(0, 12),
  };
}

function renderHandoffPacketText(packet: Omit<ProjectHandoffPacket, "reportText">): string {
  return [
    `Project Handoff Packet - ${new Date(packet.generatedAt).toLocaleString()}`,
    packet.headline,
    "",
    `Current phase: ${packet.currentPhase}`,
    `Next action: ${packet.nextAction}`,
    `Health: ${packet.health}`,
    `Owners: ${packet.ownerRoles.join(", ") || "Operations"}`,
    "",
    ...packet.sections.map((section) => [
      `${section.title} - ${section.severity.toUpperCase()}`,
      ...section.lines.map((line) => `- ${line}`),
    ].join("\n")),
  ].join("\n\n");
}

export function getProjectHandoffPacket(db: AppDb, projectId: string): ProjectHandoffPacket {
  const detail = getProjectDetail(db, projectId);
  const project = detail.project;
  const brief = getOperationsBrief(db, projectId);
  const runbook = getProjectRunbook(db, projectId);
  const installerPacket = getInstallerActionPacket(db, projectId);
  const readiness = getLiveProjectReadinessReport(db, projectId);
  const timeline = getProjectTimelineReport(db, projectId);
  const processMap = getProjectProcessMap(db, projectId);
  const currentStep = runbook.steps.find((step) => step.isCurrent);
  const owners = new Set<string>();
  for (const action of brief.immediateActions) if (action.ownerRole) owners.add(action.ownerRole);
  for (const item of installerPacket.items.slice(0, 8)) if (item.ownerRole) owners.add(item.ownerRole);
  if (currentStep?.ownerRole) owners.add(currentStep.ownerRole);

  const blockerLines = [
    ...brief.blockers.slice(0, 8).map((item) => `${item.title}: ${item.detail}`),
    ...installerPacket.items.filter((item) => item.severity === "blocker").slice(0, 6).map((item) => `${item.ownerRole}: ${item.title} - ${item.ask}`),
  ];
  const readinessLines = readiness.items
    .filter((item) => item.status !== "done")
    .slice(0, 8)
    .map((item) => `${item.ownerRole}: ${item.title} - ${item.nextAction}`);
  const actionLines = [
    currentStep ? `${currentStep.ownerRole}: ${currentStep.phaseName} - ${currentStep.whatToDo}` : "",
    ...brief.immediateActions.slice(0, 8).map((action) => `${action.ownerRole}: ${action.phaseName} - ${action.action}`),
  ];
  const installerLines = installerPacket.items
    .slice(0, 10)
    .map((item) => `${item.severity.toUpperCase()} | ${item.ownerRole}: ${item.title} - ${item.ask}`);
  const timelineLines = timeline.events
    .slice(0, 8)
    .map((event) => `${new Date(event.occurredAt).toLocaleString()} | ${event.title}: ${event.detail}`);
  const noteLines = runbook.recentNotes
    .slice(0, 8)
    .map((note) => `${note.noteType.replaceAll("_", " ")} | ${note.createdBy || "Operations"}: ${note.body}`);

  const sections: ProjectHandoffPacketSection[] = [
    handoffSection({
      title: "Project Snapshot",
      severity: brief.health === "blocked" ? "blocker" : brief.health === "ready" ? "pass" : "warning",
      source: "project.ops_brief.process_map",
      lines: [
        [project.homeownerName || "Unnamed", project.projectAddress].filter(Boolean).join(" - "),
        `Status: ${project.status}`,
        `Utility/AHJ: ${[project.utility || "Utility missing", project.ahj || "AHJ missing"].join(" / ")}`,
        `System: ${project.systemSizeDcKw ?? "?"} kW DC / ${project.systemSizeAcKw ?? "?"} kW AC`,
        `PermitFlow: ${processMap.permitStatus.replaceAll("_", " ")} | NEMflow: ${processMap.nemStatus.replaceAll("_", " ")}`,
      ],
    }),
    handoffSection({
      title: "Current PM Action",
      severity: currentStep?.status === "blocked" ? "blocker" : currentStep?.status === "waiting" ? "warning" : "info",
      source: "runbook.current_step",
      lines: actionLines,
    }),
    handoffSection({
      title: "Blockers",
      severity: blockerLines.length ? "blocker" : "pass",
      source: "ops_brief.installer_packet",
      lines: blockerLines.length ? blockerLines : ["No blocker groups currently flagged."],
    }),
    handoffSection({
      title: "Installer / Design / NEM Asks",
      severity: installerPacket.blockerCount ? "blocker" : installerPacket.warningCount ? "warning" : "pass",
      source: "installer_actions",
      lines: installerLines.length ? installerLines : ["No installer/design asks are currently blocking the package."],
    }),
    handoffSection({
      title: "Readiness Gaps",
      severity: readiness.status === "blocked" ? "blocker" : readiness.status === "needs_review" ? "warning" : "pass",
      source: "live_readiness",
      lines: readinessLines.length ? readinessLines : ["Live readiness checklist is clear for the current scope."],
    }),
    handoffSection({
      title: "Recent Activity",
      severity: timeline.blockerCount ? "blocker" : timeline.warningCount ? "warning" : "info",
      source: "project_timeline",
      lines: timelineLines.length ? timelineLines : ["No timeline activity recorded yet."],
    }),
    handoffSection({
      title: "PM Notes",
      severity: runbook.recentNotes.some((note) => note.noteType === "blocker") ? "blocker" : runbook.recentNotes.length ? "info" : "pass",
      source: "project_notes",
      lines: noteLines.length ? noteLines : ["No PM notes yet."],
    }),
  ];
  const generatedAt = nowIso();
  const headline = `${brief.health.toUpperCase()} handoff: ${brief.currentPhase} | ${brief.blockers.length + installerPacket.blockerCount} blocker signal(s), ${brief.immediateActions.length} active PM action(s).`;
  const basePacket: Omit<ProjectHandoffPacket, "reportText"> = {
    projectId,
    generatedAt,
    health: brief.health,
    headline,
    nextAction: brief.nextAction,
    currentPhase: brief.currentPhase,
    blockerCount: brief.blockers.length + installerPacket.blockerCount,
    actionCount: brief.immediateActions.length,
    readinessStatus: readiness.status,
    timelineEventCount: timeline.totalEvents,
    ownerRoles: [...owners].sort((a, b) => a.localeCompare(b)),
    sections,
  };
  return {
    ...basePacket,
    reportText: renderHandoffPacketText(basePacket),
  };
}

function draftSubject(project: ProjectRecord, suffix: string): string {
  const label = [project.homeownerName || "Solar project", project.projectAddress].filter(Boolean).join(" - ");
  return `${label}: ${suffix}`;
}

function renderCommunicationDraftsText(packet: Omit<ProjectCommunicationDraftPacket, "reportText">): string {
  return [
    `Project Communication Drafts - ${new Date(packet.generatedAt).toLocaleString()}`,
    packet.headline,
    "",
    `Next action: ${packet.nextAction}`,
    "",
    ...packet.drafts.map((draft) => [
      `${draft.title} - ${draft.severity.toUpperCase()}`,
      `Subject: ${draft.subject}`,
      draft.body,
    ].join("\n\n")),
    "Reminder: Drafts are for human review/copy only. The system does not send emails or submit responses.",
  ].join("\n\n---\n\n");
}

export function getProjectCommunicationDrafts(db: AppDb, projectId: string): ProjectCommunicationDraftPacket {
  const detail = getProjectDetail(db, projectId);
  const project = detail.project;
  const brief = getOperationsBrief(db, projectId);
  const runbook = getProjectRunbook(db, projectId);
  const handoff = getProjectHandoffPacket(db, projectId);
  const installerPacket = getInstallerActionPacket(db, projectId);
  const readiness = getLiveProjectReadinessReport(db, projectId);
  const currentStep = runbook.steps.find((step) => step.isCurrent);
  const topBlockers = handoff.sections.find((section) => section.title === "Blockers")?.lines.slice(0, 5) || [];
  const installerAsks = installerPacket.items.slice(0, 6);
  const readinessGaps = readiness.items.filter((item) => item.status !== "done").slice(0, 5);
  const owners = handoff.ownerRoles.length ? handoff.ownerRoles.join(", ") : "Operations";
  const clientNext = brief.health === "blocked"
    ? "We are completing the remaining pre-submittal review items before anything is submitted."
    : brief.health === "ready"
      ? "The package is ready for the next supervised submission or closeout step."
      : "We are continuing the current review step and tracking the remaining items.";

  const drafts: ProjectCommunicationDraft[] = [
    {
      audience: "internal_pm",
      title: "Internal PM Update",
      subject: draftSubject(project, "PM status update"),
      severity: brief.health === "blocked" ? "blocker" : brief.health === "ready" ? "pass" : "warning",
      source: "handoff_packet.runbook",
      body: [
        `Project: ${[project.homeownerName || "Unnamed", project.projectAddress].filter(Boolean).join(" - ")}`,
        `Current phase: ${brief.currentPhase}`,
        `Next action: ${brief.nextAction}`,
        `Owner lane(s): ${owners}`,
        "",
        "Blockers / watch items:",
        ...(topBlockers.length ? topBlockers.map((line) => `- ${line}`) : ["- No blocker groups currently flagged."]),
        "",
        "Runbook current step:",
        currentStep ? `- ${currentStep.ownerRole}: ${currentStep.phaseName} - ${currentStep.whatToDo}` : "- No current step identified.",
      ].join("\n"),
    },
    {
      audience: "installer_design",
      title: "Installer / Design Request",
      subject: draftSubject(project, "items needed before submittal"),
      severity: installerPacket.blockerCount ? "blocker" : installerPacket.warningCount ? "warning" : "info",
      source: "installer_actions",
      body: [
        "Please review the items below before we move this package forward. These are pre-submittal checks intended to prevent AHJ/NEM corrections.",
        "",
        ...(installerAsks.length
          ? installerAsks.map((item, index) => `${index + 1}. ${item.title}\n   Ask: ${item.ask}\n   Why: ${item.why}\n   Evidence/source: ${(item.evidence || [item.source])[0] || item.source}`)
          : ["No installer/design actions are currently blocking this package."]),
        "",
        "Please reply with the corrected document, confirmation, or field note for each item.",
      ].join("\n"),
    },
    {
      audience: "client_safe",
      title: "Client-Safe Status Update",
      subject: draftSubject(project, "project status update"),
      severity: brief.health === "blocked" ? "warning" : brief.health === "ready" ? "pass" : "info",
      source: "pm_safe_summary",
      body: [
        "Hi,",
        "",
        `Quick update on your solar project: ${clientNext}`,
        "",
        readinessGaps.length
          ? `Current focus: ${readinessGaps[0].title}. Our next step is to ${readinessGaps[0].nextAction.charAt(0).toLowerCase()}${readinessGaps[0].nextAction.slice(1)}`
          : `Current focus: ${brief.currentPhase}. Next step: ${brief.nextAction}`,
        "",
        "We will continue tracking permitting/interconnection status and will reach out if we need anything from you.",
        "",
        "Thank you.",
      ].join("\n"),
    },
  ];
  const generatedAt = nowIso();
  const basePacket: Omit<ProjectCommunicationDraftPacket, "reportText"> = {
    projectId,
    generatedAt,
    headline: `${drafts.length} communication draft(s) generated for ${brief.currentPhase}.`,
    status: brief.health,
    nextAction: brief.nextAction,
    drafts,
  };
  return {
    ...basePacket,
    reportText: renderCommunicationDraftsText(basePacket),
  };
}

function boardHealthRank(health: OperationsBrief["health"]): number {
  if (health === "blocked") return 0;
  if (health === "watch") return 1;
  return 2;
}

export function getOperationsBoard(db: AppDb): OperationsBoard {
  const projects = getProjectList(db);
  const boardProjects: OperationsBoardProject[] = projects.map((project) => {
    const brief = getOperationsBrief(db, project.id);
    const primaryAction = brief.immediateActions[0];
    const latestActivity = brief.recentActivity[0];
    return {
      projectId: project.id,
      homeownerName: project.homeownerName,
      projectAddress: project.projectAddress,
      status: project.status,
      health: brief.health,
      currentPhase: brief.currentPhase,
      nextAction: brief.nextAction,
      ownerRole: primaryAction?.ownerRole || "Operations",
      blockerCount: brief.blockers.length,
      activeActionCount: brief.immediateActions.length,
      dueAt: primaryAction?.dueAt || null,
      latestActivityAt: latestActivity?.occurredAt || project.updatedAt,
      latestActivity: latestActivity ? `${latestActivity.title}: ${latestActivity.detail}` : "No recent activity recorded.",
      updatedAt: project.updatedAt,
    };
  });

  boardProjects.sort((a, b) => {
    const healthDelta = boardHealthRank(a.health) - boardHealthRank(b.health);
    if (healthDelta) return healthDelta;
    const blockerDelta = b.blockerCount - a.blockerCount;
    if (blockerDelta) return blockerDelta;
    const actionDelta = b.activeActionCount - a.activeActionCount;
    if (actionDelta) return actionDelta;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return {
    generatedAt: nowIso(),
    totalProjects: boardProjects.length,
    blockedProjects: boardProjects.filter((project) => project.health === "blocked").length,
    watchProjects: boardProjects.filter((project) => project.health === "watch").length,
    readyProjects: boardProjects.filter((project) => project.health === "ready").length,
    totalBlockers: boardProjects.reduce((sum, project) => sum + project.blockerCount, 0),
    totalActiveActions: boardProjects.reduce((sum, project) => sum + project.activeActionCount, 0),
    projects: boardProjects,
  };
}

function actionStatusRank(status: OperationStepStatus): number {
  if (status === "blocked") return 0;
  if (status === "waiting") return 1;
  if (status === "in_progress") return 2;
  if (status === "not_started") return 3;
  return 4;
}

function dueBucketRank(bucket: OperationsActionDueBucket): number {
  if (bucket === "overdue") return 0;
  if (bucket === "today") return 1;
  if (bucket === "upcoming") return 2;
  return 3;
}

function actionDueBucket(dueAt: string | null, now = new Date()): OperationsActionDueBucket {
  if (!dueAt) return "no_due";
  const dueTime = Date.parse(`${dueAt}T00:00:00`);
  if (Number.isNaN(dueTime)) return "no_due";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (dueTime < today) return "overdue";
  if (dueTime === today) return "today";
  return "upcoming";
}

export function getOperationsActionQueue(db: AppDb): OperationsActionQueue {
  const projects = getProjectList(db);
  const activeStatuses = new Set<OperationStepStatus>(["blocked", "waiting", "in_progress"]);
  const actions = projects.flatMap((project) => {
    const plan = syncOperationsPlan(db, project.id);
    const brief = getOperationsBrief(db, project.id);
    return plan.steps
      .filter((step) => activeStatuses.has(step.status))
      .map((step) => ({
        projectId: project.id,
        stepId: step.id,
        homeownerName: project.homeownerName,
        projectAddress: project.projectAddress,
        health: brief.health,
        phaseName: step.phaseName,
        status: step.status,
        ownerRole: step.ownerRole || "Operations",
        dueAt: step.dueAt,
        dueBucket: actionDueBucket(step.dueAt),
        action: step.nextAction,
        reason: step.summary,
        notes: step.notes,
        source: step.source,
        blockerCount: brief.blockers.length,
        updatedAt: step.updatedAt,
      }));
  });

  actions.sort((a, b) => {
    const statusDelta = actionStatusRank(a.status) - actionStatusRank(b.status);
    if (statusDelta) return statusDelta;
    const dueDelta = dueBucketRank(a.dueBucket) - dueBucketRank(b.dueBucket);
    if (dueDelta) return dueDelta;
    const blockerDelta = b.blockerCount - a.blockerCount;
    if (blockerDelta) return blockerDelta;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return {
    generatedAt: nowIso(),
    totalActions: actions.length,
    blockedActions: actions.filter((item) => item.status === "blocked").length,
    waitingActions: actions.filter((item) => item.status === "waiting").length,
    inProgressActions: actions.filter((item) => item.status === "in_progress").length,
    overdueActions: actions.filter((item) => item.dueBucket === "overdue").length,
    todayActions: actions.filter((item) => item.dueBucket === "today").length,
    actions,
  };
}

function actionProjectLabel(action: { homeownerName: string; projectAddress: string }): string {
  return [action.homeownerName || "Unnamed", action.projectAddress].filter(Boolean).join(" - ");
}

function projectBoardLabel(project: OperationsBoardProject): string {
  return [project.homeownerName || "Unnamed", project.projectAddress].filter(Boolean).join(" - ");
}

function ownerWorkload(actions: OperationsActionQueue["actions"]): OperationsOwnerWorkload[] {
  const workloads = new Map<string, OperationsOwnerWorkload>();
  for (const action of actions) {
    const owner = action.ownerRole || "Operations";
    const current = workloads.get(owner) || {
      ownerRole: owner,
      totalActions: 0,
      blockedActions: 0,
      waitingActions: 0,
      inProgressActions: 0,
      overdueActions: 0,
      todayActions: 0,
    };
    current.totalActions += 1;
    if (action.status === "blocked") current.blockedActions += 1;
    if (action.status === "waiting") current.waitingActions += 1;
    if (action.status === "in_progress") current.inProgressActions += 1;
    if (action.dueBucket === "overdue") current.overdueActions += 1;
    if (action.dueBucket === "today") current.todayActions += 1;
    workloads.set(owner, current);
  }
  return [...workloads.values()].sort((a, b) => (b.blockedActions - a.blockedActions) || (b.totalActions - a.totalActions) || a.ownerRole.localeCompare(b.ownerRole));
}

function renderDailyReportText(input: {
  generatedAt: string;
  headline: string;
  summary: string[];
  owners: OperationsOwnerWorkload[];
  topProjects: OperationsBoardProject[];
  dueNow: OperationsActionQueue["actions"];
  topActions: OperationsActionQueue["actions"];
}): string {
  const lines = [
    `Solar Ops Daily Report - ${new Date(input.generatedAt).toLocaleString()}`,
    input.headline,
    "",
    "Summary:",
    ...input.summary.map((item) => `- ${item}`),
    "",
    "Owner workload:",
    ...(input.owners.length ? input.owners.map((owner) => `- ${owner.ownerRole}: ${owner.totalActions} action(s), ${owner.blockedActions} blocked, ${owner.waitingActions} waiting, ${owner.inProgressActions} active, ${owner.overdueActions} overdue`) : ["- No active owner workload."]),
    "",
    "Top blocked projects:",
    ...(input.topProjects.length ? input.topProjects.map((project) => `- ${projectBoardLabel(project)}: ${project.currentPhase} -> ${project.nextAction}`) : ["- No blocked projects."]),
    "",
    "Due now:",
    ...(input.dueNow.length ? input.dueNow.map((action) => `- ${action.ownerRole}: ${actionProjectLabel(action)} | ${action.phaseName} | ${action.action}`) : ["- No overdue or due-today actions."]),
    "",
    "Next actions:",
    ...(input.topActions.length ? input.topActions.map((action) => `- ${action.ownerRole}: ${actionProjectLabel(action)} | ${action.phaseName} | ${action.action}`) : ["- No active actions."]),
  ];
  return lines.join("\n");
}

export function getOperationsDailyReport(db: AppDb): OperationsDailyReport {
  const board = getOperationsBoard(db);
  const actionQueue = getOperationsActionQueue(db);
  const owners = ownerWorkload(actionQueue.actions);
  const topProjects = board.projects.filter((project) => project.health === "blocked").slice(0, 6);
  const dueNow = actionQueue.actions.filter((action) => action.dueBucket === "overdue" || action.dueBucket === "today").slice(0, 8);
  const topActions = actionQueue.actions.slice(0, 10);
  const generatedAt = nowIso();
  const headline = `${board.blockedProjects} blocked project(s), ${actionQueue.blockedActions} blocked action(s), ${actionQueue.overdueActions} overdue action(s).`;
  const summary = [
    `${board.totalProjects} project(s) in portfolio: ${board.blockedProjects} blocked, ${board.watchProjects} watch, ${board.readyProjects} ready.`,
    `${actionQueue.totalActions} active action(s): ${actionQueue.blockedActions} blocked, ${actionQueue.waitingActions} waiting, ${actionQueue.inProgressActions} in progress.`,
    `${owners.length} owner role(s) carrying active work.`,
    dueNow.length ? `${dueNow.length} action(s) are due now or overdue.` : "No actions are due today or overdue.",
  ];
  const reportText = renderDailyReportText({
    generatedAt,
    headline,
    summary,
    owners,
    topProjects,
    dueNow,
    topActions,
  });

  return {
    generatedAt,
    headline,
    summary,
    board,
    actionQueue,
    ownerWorkload: owners,
    topProjects,
    dueNow,
    topActions,
    reportText,
  };
}

function hasValue(value: unknown): boolean {
  return value != null && String(value).trim() !== "";
}

function evidenceFor(project: ProjectRecord, topic: EvidenceTopic): string[] {
  return evidenceLines(evidenceForTopic(project, topic)).slice(0, 3);
}

function renderReadinessReportText(report: Omit<LiveProjectReadinessReport, "reportText">): string {
  return [
    `Live Project Test Readiness - ${new Date(report.generatedAt).toLocaleString()}`,
    report.headline,
    "",
    `Next action: ${report.nextAction}`,
    "",
    "Checklist:",
    ...report.items.map((item) => [
      `- ${item.status.toUpperCase()}: ${item.title}`,
      `  Owner: ${item.ownerRole}`,
      `  Action: ${item.nextAction}`,
      item.evidence[0] ? `  Evidence: ${item.evidence[0]}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

function readinessItem(input: LiveProjectReadinessItem): LiveProjectReadinessItem {
  return {
    ...input,
    evidence: input.evidence.filter(Boolean).slice(0, 5),
  };
}

export function getLiveProjectReadinessReport(db: AppDb, projectId: string): LiveProjectReadinessReport {
  const detail = getProjectDetail(db, projectId);
  const project = detail.project;
  const historicalReport = buildHistoricalFailureReport(db, projectId);
  const reviewerReport = buildReviewerReport(project);
  const applicationDocs = buildApplicationDocumentPackage(project);
  const activeEmailSources = db.query<Row>("SELECT id, label, last_checked_at, last_matched_count, last_error FROM email_tracking_sources WHERE active = 1 ORDER BY updated_at DESC");

  const accountEvidence = evidenceForTopic(project, "accountVerification");
  const meterEvidence = evidenceForTopic(project, "meterPhoto");
  const sldEvidence = evidenceForTopic(project, "sld");
  const siteEvidence = evidenceForTopic(project, "siteRoofPlan");
  const inverterEvidence = evidenceForTopic(project, "inverterSettings");
  const pendingCritical = detail.humanReviewItems.filter((item) => item.status === "pending" && item.fieldName !== "correction").length;
  const qcFails = detail.qcResults.filter((item) => item.qcStatus === "fail").length;
  const qcWarnings = detail.qcResults.filter((item) => item.qcStatus === "warning").length;
  const learnedHistoricalBlockers = historicalReport.checklist.filter((item) => {
    const cause = historicalReport.topRejectionCauses.find((candidate) => candidate.signature === item.sourceCauseSignature);
    return item.status === "missing" && Boolean(cause && cause.count > 0 && cause.severity === "blocker");
  });
  const historicalMissing = historicalReport.checklist.filter((item) => item.status === "missing");
  const reviewerBlockers = reviewerReport.findings.filter((item) => item.severity === "blocker");
  const reviewerWarnings = reviewerReport.findings.filter((item) => item.severity === "warning");
  const criticalFields: Array<[string, unknown]> = [
    ["Homeowner", project.homeownerName],
    ["Service address", project.projectAddress],
    ["Utility", project.utility],
    ["AHJ", project.ahj],
    ["Account", project.accountNumber],
    ["Meter", project.meterNumber],
    ["DC size", project.systemSizeDcKw],
    ["AC size", project.systemSizeAcKw],
    ["Interconnection", project.interconnectionMethod],
  ];
  const missingCritical = criticalFields.filter(([, value]) => !hasValue(value)).map(([label]) => label);
  const packageEvidenceOk = sldEvidence.present && siteEvidence.present && inverterEvidence.present;
  const utilityEvidenceOk = accountEvidence.present && meterEvidence.present && accountEvidence.confidence !== "low" && meterEvidence.confidence !== "low";
  const staged = isStagedOrSubmitted(project.status);
  const activeEmailSource = activeEmailSources[0];

  const items: LiveProjectReadinessItem[] = [
    readinessItem({
      id: "source-package",
      title: "Real source package parsed",
      status: packageEvidenceOk ? "done" : sldEvidence.present || siteEvidence.present || inverterEvidence.present ? "needs_review" : "blocked",
      ownerRole: "Intake Coordinator",
      detail: packageEvidenceOk ? "Plan/package evidence is mapped enough for a pre-submit review." : "The project needs a stronger source package before live testing.",
      nextAction: packageEvidenceOk ? "Confirm file versions are current." : "Upload and parse the real plan set, one-line, site/roof plan, utility bill, photos, specs, labels, and AHJ forms.",
      evidence: [...evidenceLines(sldEvidence), ...evidenceLines(siteEvidence), ...evidenceLines(inverterEvidence)].slice(0, 5),
      source: "project.evidence",
    }),
    readinessItem({
      id: "project-identity",
      title: "Project identity and NEM basics",
      status: missingCritical.length ? "blocked" : "done",
      ownerRole: "Data QA",
      detail: missingCritical.length ? `${missingCritical.length} critical field(s) missing: ${missingCritical.join(", ")}.` : "Homeowner, address, AHJ, utility, account, meter, size, and interconnection are captured.",
      nextAction: missingCritical.length ? "Resolve missing critical fields in Human Review before staging." : "Lock the project record as the source of truth for forms and portals.",
      evidence: criticalFields.map(([label, value]) => `${label}: ${hasValue(value) ? "captured" : "missing"}`),
      source: "project.fields",
    }),
    readinessItem({
      id: "utility-account-evidence",
      title: "Utility/account evidence",
      status: utilityEvidenceOk ? "done" : project.accountNumber || project.meterNumber ? "needs_review" : "blocked",
      ownerRole: "NEM Ops",
      detail: utilityEvidenceOk ? "Account and meter evidence are present with usable confidence." : "Account or meter values alone are not enough for a clean NEM pass.",
      nextAction: utilityEvidenceOk ? "Use the captured evidence in NEM staging." : "Verify utility bill/account holder/service address and meter photo before utility submission.",
      evidence: [...evidenceLines(accountEvidence), ...evidenceLines(meterEvidence)].slice(0, 5),
      source: "project.evidence.utility",
    }),
    readinessItem({
      id: "qc-human-review",
      title: "QC and human review",
      status: qcFails ? "blocked" : pendingCritical ? "needs_review" : "done",
      ownerRole: "Data QA",
      detail: `${qcFails} QC failure(s), ${qcWarnings} warning(s), ${pendingCritical} critical human review item(s).`,
      nextAction: qcFails || pendingCritical ? "Resolve QC failures and pending human review fields, then rerun QC." : "Keep warnings visible but continue toward package generation.",
      evidence: [
        ...detail.qcResults.filter((item) => item.qcStatus !== "pass").slice(0, 3).map((item) => `${item.ruleName}: ${item.message}`),
        ...detail.humanReviewItems.filter((item) => item.status === "pending").slice(0, 3).map((item) => `Human review: ${item.fieldName}`),
      ],
      source: "qc.human_review",
    }),
    readinessItem({
      id: "historical-precheck",
      title: "Historical failure precheck",
      status: learnedHistoricalBlockers.length ? "blocked" : historicalMissing.length ? "needs_review" : "done",
      ownerRole: "Permit Ops",
      detail: historicalReport.summaryLabel,
      nextAction: learnedHistoricalBlockers.length ? "Clear missing checklist items tied to learned blocker patterns." : historicalMissing.length ? "Review missing historical checklist items before live staging." : "Historical checklist is clear.",
      evidence: [
        ...historicalReport.topRejectionCauses.slice(0, 3).map((cause) => `${cause.title}: ${cause.count} prior record(s)`),
        ...historicalMissing.slice(0, 3).map((item) => `Missing: ${item.title}`),
      ],
      source: "historical_failures",
    }),
    readinessItem({
      id: "reviewer-gate",
      title: "AHJ reviewer gate",
      status: reviewerBlockers.length ? "blocked" : reviewerWarnings.length ? "needs_review" : "done",
      ownerRole: "Permit Ops",
      detail: `${reviewerBlockers.length} blocker(s), ${reviewerWarnings.length} warning(s), ${reviewerReport.findings.length} total callout(s).`,
      nextAction: reviewerBlockers.length ? "Send blocker callouts to installer/design before submittal." : reviewerWarnings.length ? "Confirm warnings with evidence before staging." : "Reviewer gate has no blockers.",
      evidence: reviewerReport.findings.slice(0, 5).map((finding) => `${finding.title}: ${finding.evidenceStatus}`),
      source: "reviewer_gate",
    }),
    readinessItem({
      id: "ahj-nem-docs",
      title: "AHJ/NEM application packet",
      status: applicationDocs.missingFields.length ? "blocked" : applicationDocs.docs.length ? "done" : "needs_review",
      ownerRole: "Permit Ops",
      detail: `${applicationDocs.profile.name}; ${applicationDocs.docs.length} generated document(s), ${applicationDocs.missingFields.length} missing field(s).`,
      nextAction: applicationDocs.missingFields.length ? "Fill missing form fields and regenerate the AHJ/NEM packet." : "Open the print packet and verify every form/worksheet before portal upload.",
      evidence: [
        ...applicationDocs.docs.slice(0, 4).map((doc) => `Generated: ${doc.title}`),
        ...applicationDocs.missingFields.slice(0, 4).map((field) => `Missing field: ${field}`),
      ],
      source: "forms.application_docs",
    }),
    readinessItem({
      id: "tracking",
      title: "Approval tracking target",
      status: detail.permitCheckTargets.length ? "done" : "needs_review",
      ownerRole: "Operations Coordinator",
      detail: detail.permitCheckTargets.length ? `${detail.permitCheckTargets.length} permit/NEM tracking target(s) configured.` : "No permit/NEM tracking target is configured yet.",
      nextAction: detail.permitCheckTargets.length ? "Keep scheduled checks and status notes current." : "Add AHJ/portal/application tracking details before or immediately after live submit.",
      evidence: detail.permitCheckTargets.slice(0, 3).map((target) => `${target.jurisdiction || project.ahj || "Jurisdiction"} | ${target.portalName || "Portal"} | ${target.applicationNumber || target.permitNumber || "number pending"}`),
      source: "tracking.targets",
    }),
    readinessItem({
      id: "email-watch",
      title: "Live email tracking",
      status: activeEmailSources.length ? "done" : "needs_review",
      ownerRole: "Operations Coordinator",
      detail: activeEmailSources.length ? `${activeEmailSources.length} active MBOX watch source(s).` : "No live MBOX watch source is configured.",
      nextAction: activeEmailSources.length ? "Run Scan Email during testing and verify matches land on the project." : "Configure the live permitting/NEM MBOX watch path.",
      evidence: activeEmailSource ? [
        `Active source: ${text(activeEmailSource.label)}`,
        activeEmailSource.last_checked_at ? `Last checked: ${text(activeEmailSource.last_checked_at)}` : "Last checked: not run",
        `Last matched: ${Number(activeEmailSource.last_matched_count ?? 0)}`,
        text(activeEmailSource.last_error) ? `Last error: ${text(activeEmailSource.last_error)}` : "",
      ] : [],
      source: "email_tracker",
    }),
    readinessItem({
      id: "portal-rehearsal",
      title: "Portal staging rehearsal",
      status: staged ? "done" : reviewerBlockers.length || learnedHistoricalBlockers.length || qcFails || pendingCritical || applicationDocs.missingFields.length ? "blocked" : "needs_review",
      ownerRole: "Submission Specialist",
      detail: staged ? "Project has staged/submitted status history." : "Use mock staging first. Real portal automation must stop at final review.",
      nextAction: staged ? "Verify final portal preview and capture human confirmation after manual submit." : "Run Prepare Submittal only after blockers are clear, then verify the final preview manually.",
      evidence: detail.portalRuns.slice(0, 3).map((run) => `${run.runType}: ${run.status}${run.humanActionRequired ? " | human action required" : ""}`),
      source: "portal.staging",
    }),
    readinessItem({
      id: "live-safeguards",
      title: "Live portal safeguards",
      status: process.env.SESSION_ENCRYPTION_KEY ? "done" : "needs_review",
      ownerRole: "Operations Lead",
      detail: process.env.SESSION_ENCRYPTION_KEY ? "Session encryption key is configured for local storage-state testing." : "Session encryption key is not configured in this process.",
      nextAction: process.env.SESSION_ENCRYPTION_KEY ? "Use supervised login and stop at the final review page." : "Set SESSION_ENCRYPTION_KEY before testing real portal storage state.",
      evidence: [
        "Automation must never submit, resubmit, pay fees, solve CAPTCHA/MFA, or apply signatures.",
        reviewerReport.finalSubmitGate.mustShowAhjPreviewWindow ? "Reviewer gate requires final AHJ preview window." : "Reviewer gate still requires human final review.",
      ],
      source: "security.portal_guardrails",
    }),
  ];

  const doneCount = items.filter((item) => item.status === "done").length;
  const needsReviewCount = items.filter((item) => item.status === "needs_review").length;
  const blockedCount = items.filter((item) => item.status === "blocked").length;
  const status: LiveProjectReadinessReport["status"] = blockedCount ? "blocked" : needsReviewCount ? "needs_review" : "ready";
  const nextAction = items.find((item) => item.status === "blocked")?.nextAction
    || items.find((item) => item.status === "needs_review")?.nextAction
    || "Ready for supervised live portal preview. Human final submit remains manual.";
  const generatedAt = nowIso();
  const headline = `${doneCount}/${items.length} ready, ${blockedCount} blocked, ${needsReviewCount} review item(s).`;
  const baseReport: Omit<LiveProjectReadinessReport, "reportText"> = {
    projectId,
    generatedAt,
    status,
    headline,
    nextAction,
    doneCount,
    needsReviewCount,
    blockedCount,
    totalCount: items.length,
    items,
  };
  return {
    ...baseReport,
    reportText: renderReadinessReportText(baseReport),
  };
}

function processStatusRank(status: ProjectProcessStepStatus): number {
  return status === "blocked" ? 5 : status === "waiting" ? 4 : status === "in_progress" ? 3 : status === "not_started" ? 2 : 1;
}

function laneStatus(steps: ProjectProcessStep[]): ProjectProcessStepStatus {
  if (steps.some((step) => step.status === "blocked")) return "blocked";
  if (steps.some((step) => step.status === "waiting")) return "waiting";
  if (steps.some((step) => step.status === "in_progress")) return "in_progress";
  if (steps.some((step) => step.status === "not_started")) return "not_started";
  return "done";
}

function processStep(input: ProjectProcessStep): ProjectProcessStep {
  return {
    ...input,
    evidence: input.evidence.filter(Boolean).map((line) => shorten(text(line), 180)).slice(0, 4),
  };
}

function processLane(input: Omit<ProjectProcessLane, "status" | "currentStep" | "nextAction">): ProjectProcessLane {
  const status = laneStatus(input.steps);
  const current = input.steps.find((step) => step.status === "blocked")
    || input.steps.find((step) => step.status === "waiting")
    || input.steps.find((step) => step.status === "in_progress")
    || input.steps.find((step) => step.status === "not_started")
    || input.steps[input.steps.length - 1];
  return {
    ...input,
    status,
    currentStep: current?.label || "Complete",
    nextAction: current?.nextAction || "No active action.",
  };
}

function renderProcessMapText(report: Omit<ProjectProcessMap, "reportText">): string {
  return [
    `PermitFlow + NEMflow Map - ${new Date(report.generatedAt).toLocaleString()}`,
    report.headline,
    "",
    `Next action: ${report.nextAction}`,
    "",
    ...report.lanes.map((lane) => [
      `${lane.title} - ${lane.status.replaceAll("_", " ")}`,
      `Current: ${lane.currentStep}`,
      `Next: ${lane.nextAction}`,
      ...lane.steps.map((step) => `- ${step.status.replaceAll("_", " ").toUpperCase()}: ${step.label} | ${step.ownerRole} | ${step.nextAction}`),
    ].join("\n")),
  ].join("\n\n");
}

function hasNemSignal(check: PermitStatusCheck | EmailProjectMatch): boolean {
  const value = "emailBucket" in check
    ? `${check.emailBucket} ${check.workflow} ${check.subject}`
    : `${check.statusLabel} ${check.rawStatusText} ${check.message}`;
  return /\b(nem|net.?meter|interconnection|pto|permission to operate|utility|powerclerk|pge|pacific power|pacificorp)\b/i.test(value);
}

function hasPermitSignal(check: PermitStatusCheck | EmailProjectMatch): boolean {
  const value = "emailBucket" in check
    ? `${check.emailBucket} ${check.workflow} ${check.subject}`
    : `${check.statusLabel} ${check.rawStatusText} ${check.message}`;
  return /\b(permit|ahj|jurisdiction|city|county|building|electrical|inspection|issued|ready to issue)\b/i.test(value);
}

export function getProjectProcessMap(db: AppDb, projectId: string): ProjectProcessMap {
  const detail = getProjectDetail(db, projectId);
  const project = detail.project;
  const historicalReport = buildHistoricalFailureReport(db, projectId);
  const reviewerReport = buildReviewerReport(project);
  const applicationDocs = buildApplicationDocumentPackage(project);

  const accountEvidence = evidenceForTopic(project, "accountVerification");
  const meterEvidence = evidenceForTopic(project, "meterPhoto");
  const sldEvidence = evidenceForTopic(project, "sld");
  const siteEvidence = evidenceForTopic(project, "siteRoofPlan");
  const inverterEvidence = evidenceForTopic(project, "inverterSettings");
  const utilityApprovalEvidence = evidenceForTopic(project, "utilityApproval");
  const pendingCritical = detail.humanReviewItems.filter((item) => item.status === "pending" && item.fieldName !== "correction").length;
  const qcFails = detail.qcResults.filter((item) => item.qcStatus === "fail").length;
  const qcWarnings = detail.qcResults.filter((item) => item.qcStatus === "warning").length;
  const reviewerBlockers = reviewerReport.findings.filter((item) => item.severity === "blocker");
  const reviewerWarnings = reviewerReport.findings.filter((item) => item.severity === "warning");
  const historicalMissing = historicalReport.checklist.filter((item) => item.status === "missing");
  const learnedHistoricalBlockers = historicalMissing.filter((item) => {
    const cause = historicalReport.topRejectionCauses.find((candidate) => candidate.signature === item.sourceCauseSignature);
    return Boolean(cause && cause.count > 0 && cause.severity === "blocker");
  });
  const missingCritical = [
    ["Homeowner", project.homeownerName],
    ["Service address", project.projectAddress],
    ["Utility", project.utility],
    ["AHJ", project.ahj],
    ["Account", project.accountNumber],
    ["Meter", project.meterNumber],
    ["DC size", project.systemSizeDcKw],
    ["AC size", project.systemSizeAcKw],
    ["Interconnection", project.interconnectionMethod],
  ].filter(([, value]) => !hasValue(value)).map(([label]) => label);

  const sourcePackageDone = sldEvidence.present && siteEvidence.present && inverterEvidence.present;
  const utilityEvidenceOk = accountEvidence.present && meterEvidence.present && accountEvidence.confidence !== "low" && meterEvidence.confidence !== "low";
  const permitChecks = detail.permitStatusChecks.filter(hasPermitSignal);
  const nemChecks = detail.permitStatusChecks.filter(hasNemSignal);
  const permitEmails = detail.emailProjectMatches.filter(hasPermitSignal);
  const nemEmails = detail.emailProjectMatches.filter(hasNemSignal);
  const permitCorrections = detail.corrections.filter((correction) => correction.source !== "email" || /permit|ahj|city|county|building|electrical|plan|site|revision/i.test(correction.correctionText));
  const nemCorrections = detail.corrections.filter((correction) => /nem|net.?meter|interconnection|pto|utility|meter|account|powerclerk|inverter|1741/i.test(`${correction.correctionText} ${correction.rootCause} ${correction.requiredAction}`));
  const openPermitCorrections = permitCorrections.filter((correction) => !correction.closedAt && !correction.resubmitted);
  const openNemCorrections = nemCorrections.filter((correction) => !correction.closedAt && !correction.resubmitted);
  const hasPortalStaging = detail.portalRuns.some((run) => run.status === "awaiting_human_submit" || run.status === "submitted");
  const permitApproved = project.status === "ready_for_issue" || project.status === "issued" || permitChecks.some((check) => check.readyForIssue || check.outcome === "issued");
  const nemApproved = utilityApprovalEvidence.present || nemChecks.some((check) => ["reviewed_by_ahj", "ready_for_issue", "issued"].includes(check.outcome)) || nemEmails.some((email) => email.emailBucket === "nem_approval");
  const docsReady = applicationDocs.missingFields.length === 0 && applicationDocs.docs.length > 0;
  const upstreamClear = qcFails === 0 && pendingCritical === 0 && reviewerBlockers.length === 0 && learnedHistoricalBlockers.length === 0 && docsReady;

  const intakeLane = processLane({
    key: "intake",
    title: "Intake & QC",
    summary: "Single source of truth before either AHJ or utility work starts.",
    steps: [
      processStep({
        id: "intake-source-package",
        laneKey: "intake",
        label: "Customer Upload",
        status: sourcePackageDone ? "done" : sldEvidence.present || siteEvidence.present ? "in_progress" : "blocked",
        ownerRole: "Intake Coordinator",
        summary: sourcePackageDone ? "Plans/specs are mapped for review." : "Source package is not strong enough yet.",
        nextAction: sourcePackageDone ? "Confirm file versions are current." : "Upload real planset, one-line, site/roof plan, utility bill, photos, specs, and labels.",
        evidence: [...evidenceLines(sldEvidence), ...evidenceLines(siteEvidence), ...evidenceLines(inverterEvidence)],
        source: "project.evidence",
      }),
      processStep({
        id: "intake-project-record",
        laneKey: "intake",
        label: "Project Record",
        status: missingCritical.length ? "blocked" : "done",
        ownerRole: "Data QA",
        summary: missingCritical.length ? `${missingCritical.length} critical field(s) missing.` : "Core project fields are captured.",
        nextAction: missingCritical.length ? `Resolve missing fields: ${missingCritical.join(", ")}.` : "Use this record as the source for every form and portal.",
        evidence: missingCritical.length ? missingCritical.map((field) => `Missing: ${field}`) : [`AHJ: ${project.ahj}`, `Utility: ${project.utility}`, `Interconnection: ${project.interconnectionMethod || "captured"}`],
        source: "project.fields",
      }),
      processStep({
        id: "intake-qc",
        laneKey: "intake",
        label: "Extraction QC",
        status: qcFails ? "blocked" : pendingCritical ? "waiting" : qcWarnings ? "in_progress" : "done",
        ownerRole: "Data QA",
        summary: `${qcFails} fail(s), ${qcWarnings} warning(s), ${pendingCritical} pending critical review item(s).`,
        nextAction: qcFails || pendingCritical ? "Resolve QC and human review before staging either lane." : qcWarnings ? "Review warnings before application prep." : "Extraction is ready for package prep.",
        evidence: [
          ...detail.qcResults.filter((item) => item.qcStatus !== "pass").slice(0, 4).map((item) => `${item.ruleName}: ${item.message}`),
          ...detail.humanReviewItems.filter((item) => item.status === "pending").slice(0, 3).map((item) => `Human review: ${item.fieldName}`),
        ],
        source: "qc.human_review",
      }),
    ],
  });

  const permitLane = processLane({
    key: "permit",
    title: "PermitFlow",
    summary: "AHJ permit path from requirements through issuance.",
    steps: [
      processStep({
        id: "permit-requirements",
        laneKey: "permit",
        label: "AHJ Requirements",
        status: reviewerBlockers.length || learnedHistoricalBlockers.length ? "blocked" : historicalMissing.length || reviewerWarnings.length ? "waiting" : "done",
        ownerRole: "Permit Ops",
        summary: `${reviewerBlockers.length} reviewer blocker(s), ${historicalMissing.length} historical checklist gap(s).`,
        nextAction: reviewerBlockers.length || learnedHistoricalBlockers.length ? "Clear AHJ reviewer and learned-failure blockers." : historicalMissing.length || reviewerWarnings.length ? "Review AHJ warnings and checklist gaps." : "AHJ requirements are clear enough for package prep.",
        evidence: [
          ...reviewerBlockers.slice(0, 3).map((finding) => finding.title),
          ...historicalMissing.slice(0, 3).map((item) => `Historical gap: ${item.title}`),
        ],
        source: "requirements.reviewer.history",
      }),
      processStep({
        id: "permit-package",
        laneKey: "permit",
        label: "Permit Package",
        status: applicationDocs.missingFields.length || reviewerBlockers.length ? "blocked" : docsReady ? "done" : "in_progress",
        ownerRole: "Permit Ops",
        summary: `${applicationDocs.docs.length} generated document(s), ${applicationDocs.missingFields.length} missing field(s).`,
        nextAction: applicationDocs.missingFields.length ? "Fill missing AHJ form fields and regenerate packet." : "Open the print packet and verify forms/attachments.",
        evidence: [
          ...applicationDocs.docs.slice(0, 4).map((doc) => `Generated: ${doc.title}`),
          ...applicationDocs.missingFields.slice(0, 4).map((field) => `Missing: ${field}`),
        ],
        source: "forms.application_docs",
      }),
      processStep({
        id: "permit-submit-review",
        laneKey: "permit",
        label: "Portal Preview",
        status: hasPortalStaging ? "waiting" : upstreamClear ? "in_progress" : "not_started",
        ownerRole: "Submission Specialist",
        summary: hasPortalStaging ? "Portal staging exists and awaits human submit/confirmation." : "Permit lane is not staged yet.",
        nextAction: hasPortalStaging ? "Verify AHJ preview and capture manual submit confirmation." : upstreamClear ? "Prepare Submittal and stop at final review." : "Do not stage until blockers are clear.",
        evidence: detail.portalRuns.slice(0, 3).map((run) => `${run.runType}: ${run.status}`),
        source: "portal.submission",
      }),
      processStep({
        id: "permit-review-corrections",
        laneKey: "permit",
        label: "Review & Corrections",
        status: openPermitCorrections.length ? "blocked" : permitChecks.length || permitEmails.length ? "in_progress" : hasPortalStaging ? "waiting" : "not_started",
        ownerRole: "Corrections Coordinator",
        summary: `${openPermitCorrections.length} open AHJ correction(s), ${permitChecks.length + permitEmails.length} AHJ tracking signal(s).`,
        nextAction: openPermitCorrections.length ? "Assign and resolve AHJ corrections before resubmittal." : hasPortalStaging ? "Monitor AHJ portal/email for review updates." : "Add tracking after AHJ submit.",
        evidence: [
          ...permitChecks.slice(0, 3).map((check) => `${check.statusLabel}: ${check.message}`),
          ...permitEmails.slice(0, 2).map((email) => `Email: ${email.emailBucket} ${email.subject}`),
        ],
        source: "permit.status.email",
      }),
      processStep({
        id: "permit-issuance",
        laneKey: "permit",
        label: "Permit Issuance",
        status: permitApproved ? "done" : permitChecks.length ? "in_progress" : "not_started",
        ownerRole: "Operations Coordinator",
        summary: permitApproved ? "Permit approval/ready-for-issue signal is captured." : "Permit is not issued yet.",
        nextAction: permitApproved ? "Download permit/approval evidence and keep install dependencies current." : "Continue tracking AHJ status until ready-for-issue or issued.",
        evidence: permitChecks.slice(0, 4).map((check) => `${check.statusLabel}: ${check.outcome}`),
        source: "permit.issuance",
      }),
    ],
  });

  const nemLane = processLane({
    key: "nem",
    title: "NEMflow",
    summary: "Utility interconnection path from account proof through PTO.",
    steps: [
      processStep({
        id: "nem-requirements",
        laneKey: "nem",
        label: "Utility Requirements",
        status: project.utility && project.interconnectionMethod ? "done" : "blocked",
        ownerRole: "NEM Ops",
        summary: project.utility ? `${project.utility} interconnection path identified.` : "Utility is missing.",
        nextAction: project.utility && project.interconnectionMethod ? "Confirm utility-specific NEM documents and portal path." : "Resolve utility and interconnection method before NEM prep.",
        evidence: [`Utility: ${project.utility || "missing"}`, `Interconnection: ${project.interconnectionMethod || "missing"}`, ...evidenceFor(project, "sld")],
        source: "utility.nem.requirements",
      }),
      processStep({
        id: "nem-account-proof",
        laneKey: "nem",
        label: "Account & Meter Proof",
        status: utilityEvidenceOk ? "done" : project.accountNumber || project.meterNumber ? "waiting" : "blocked",
        ownerRole: "NEM Ops",
        summary: utilityEvidenceOk ? "Utility account and meter evidence are usable." : "Account/meter proof needs verification.",
        nextAction: utilityEvidenceOk ? "Use account/meter proof in the NEM application." : "Verify utility bill, account holder, service address, and meter photo.",
        evidence: [...evidenceLines(accountEvidence), ...evidenceLines(meterEvidence)],
        source: "utility.account_meter",
      }),
      processStep({
        id: "nem-packet",
        laneKey: "nem",
        label: "NEM Packet",
        status: utilityEvidenceOk && sldEvidence.present && inverterEvidence.present ? "done" : utilityEvidenceOk || sldEvidence.present ? "in_progress" : "blocked",
        ownerRole: "NEM Ops",
        summary: "NEM packet needs account proof, SLD/one-line, site plan, specs, and inverter settings.",
        nextAction: utilityEvidenceOk && sldEvidence.present && inverterEvidence.present ? "Verify NEM packet fields before utility portal staging." : "Complete NEM packet evidence before utility submission.",
        evidence: [...evidenceLines(sldEvidence), ...evidenceLines(inverterEvidence), ...applicationDocs.docs.filter((doc) => doc.documentType === "utility_application" || /utility|nem|interconnection/i.test(doc.title)).map((doc) => `Generated: ${doc.title}`)],
        source: "utility.nem.packet",
      }),
      processStep({
        id: "nem-application",
        laneKey: "nem",
        label: "Utility Application",
        status: nemChecks.length || nemEmails.length ? "in_progress" : utilityEvidenceOk && docsReady ? "waiting" : "not_started",
        ownerRole: "NEM Ops",
        summary: nemChecks.length || nemEmails.length ? `${nemChecks.length + nemEmails.length} utility/NEM tracking signal(s) captured.` : "NEM application has not been tracked yet.",
        nextAction: nemChecks.length || nemEmails.length ? "Keep NEM status current from email/portal signals." : "Stage or submit the utility interconnection application after packet review.",
        evidence: [
          ...nemChecks.slice(0, 3).map((check) => `${check.statusLabel}: ${check.message}`),
          ...nemEmails.slice(0, 2).map((email) => `Email: ${email.emailBucket} ${email.subject}`),
        ],
        source: "utility.nem.application",
      }),
      processStep({
        id: "nem-corrections",
        laneKey: "nem",
        label: "Utility Corrections",
        status: openNemCorrections.length ? "blocked" : nemCorrections.length ? "done" : nemChecks.length || nemEmails.length ? "waiting" : "not_started",
        ownerRole: "Corrections Coordinator",
        summary: `${openNemCorrections.length} open utility/NEM correction(s).`,
        nextAction: openNemCorrections.length ? "Resolve NEM correction items before utility approval/PTO." : "Monitor for utility correction requests.",
        evidence: nemCorrections.slice(0, 4).map((correction) => `${correction.correctionBucket}: ${correction.requiredAction || correction.rootCause}`),
        source: "utility.nem.corrections",
      }),
      processStep({
        id: "nem-approval-pto",
        laneKey: "nem",
        label: "NEM Approval / PTO",
        status: nemApproved ? "done" : nemChecks.length || nemEmails.length ? "in_progress" : "not_started",
        ownerRole: "NEM Ops",
        summary: nemApproved ? "NEM/interconnection approval signal is captured." : "NEM/PTO approval is not captured yet.",
        nextAction: nemApproved ? "Attach approval/PTO evidence and confirm install/inspection dependencies." : "Track utility review until approval/PTO is received.",
        evidence: [
          ...evidenceLines(utilityApprovalEvidence),
          ...nemChecks.slice(0, 3).map((check) => `${check.statusLabel}: ${check.outcome}`),
          ...nemEmails.filter((email) => email.emailBucket === "nem_approval").slice(0, 2).map((email) => `Email: ${email.subject}`),
        ],
        source: "utility.nem.approval",
      }),
    ],
  });

  const closeoutLane = processLane({
    key: "closeout",
    title: "Tracking & Closeout",
    summary: "Follow-up, confirmation capture, and install-ready release.",
    steps: [
      processStep({
        id: "closeout-tracking",
        laneKey: "closeout",
        label: "Live Tracking",
        status: detail.permitCheckTargets.length || detail.emailProjectMatches.length ? "done" : "waiting",
        ownerRole: "Operations Coordinator",
        summary: `${detail.permitCheckTargets.length} target(s), ${detail.emailProjectMatches.length} matched email(s).`,
        nextAction: detail.permitCheckTargets.length || detail.emailProjectMatches.length ? "Keep permit/NEM tracking and email scan current." : "Configure permit/NEM tracking targets and live email watch.",
        evidence: [
          ...detail.permitCheckTargets.slice(0, 2).map((target) => `${target.portalName || "Portal"} ${target.applicationNumber || target.permitNumber || ""}`),
          ...detail.emailProjectMatches.slice(0, 2).map((email) => `Email: ${email.emailBucket} ${email.subject}`),
        ],
        source: "tracking.email",
      }),
      processStep({
        id: "closeout-human-submit",
        laneKey: "closeout",
        label: "Human Submit Confirmation",
        status: detail.submissions.some((submission) => submission.status === "submitted") ? "done" : hasPortalStaging ? "waiting" : "not_started",
        ownerRole: "Submission Specialist",
        summary: hasPortalStaging ? "Portal run requires human final submit/confirmation." : "No staged portal run awaiting confirmation.",
        nextAction: hasPortalStaging ? "Submit manually only after preview review, then capture confirmation/application/permit numbers." : "Stage first, then capture manual submit confirmation.",
        evidence: detail.submissions.slice(0, 3).map((submission) => `${submission.submissionType}: ${submission.status} ${submission.confirmationNumber}`),
        source: "submissions.confirmation",
      }),
      processStep({
        id: "closeout-install-ready",
        laneKey: "closeout",
        label: "Install Ready",
        status: permitApproved && nemApproved ? "done" : permitApproved || nemApproved ? "waiting" : "not_started",
        ownerRole: "Install Coordinator",
        summary: `Permit ${permitApproved ? "ready" : "not ready"}; NEM ${nemApproved ? "ready" : "not ready"}.`,
        nextAction: permitApproved && nemApproved ? "Release install-ready package with approval evidence." : "Wait for both AHJ permit and NEM/PTO readiness before install release.",
        evidence: [
          permitApproved ? "Permit approval/ready-for-issue captured." : "Permit approval not captured.",
          nemApproved ? "NEM/PTO approval captured." : "NEM/PTO approval not captured.",
        ],
        source: "install.release",
      }),
    ],
  });

  const lanes = [intakeLane, permitLane, nemLane, closeoutLane];
  const status = lanes.map((lane) => lane.status).sort((a, b) => processStatusRank(b) - processStatusRank(a))[0] || "not_started";
  const nextLane = lanes.find((lane) => lane.status === "blocked")
    || lanes.find((lane) => lane.status === "waiting")
    || lanes.find((lane) => lane.status === "in_progress")
    || lanes.find((lane) => lane.status === "not_started")
    || closeoutLane;
  const generatedAt = nowIso();
  const headline = `PermitFlow ${permitLane.status.replaceAll("_", " ")}, NEMflow ${nemLane.status.replaceAll("_", " ")}, overall ${status.replaceAll("_", " ")}.`;
  const baseReport: Omit<ProjectProcessMap, "reportText"> = {
    projectId,
    generatedAt,
    headline,
    status,
    permitStatus: permitLane.status,
    nemStatus: nemLane.status,
    nextAction: nextLane.nextAction,
    lanes,
  };
  return {
    ...baseReport,
    reportText: renderProcessMapText(baseReport),
  };
}

function installerSeverityRank(severity: InstallerActionItem["severity"]): number {
  return severity === "blocker" ? 4 : severity === "warning" ? 3 : severity === "info" ? 1 : 0;
}

function installerAction(input: InstallerActionItem): InstallerActionItem {
  return {
    ...input,
    ask: shorten(input.ask, 320),
    why: shorten(input.why, 320),
    evidence: input.evidence.filter(Boolean).map((line) => shorten(text(line), 180)).slice(0, 5),
  };
}

function categoryFromReviewer(category: ReviewerFinding["category"]): InstallerActionCategory {
  if (category === "utility_nem") return "utility_nem";
  if (category === "plan_set" || category === "structural" || category === "electrical") return "design";
  if (category === "project_data" || category === "installer") return "field_verification";
  if (category === "portal") return "portal";
  return "documents";
}

function renderInstallerActionText(packet: Omit<InstallerActionPacket, "reportText">): string {
  return [
    `Installer Action Packet - ${new Date(packet.generatedAt).toLocaleString()}`,
    packet.headline,
    "",
    `Next action: ${packet.nextAction}`,
    "",
    "Requests before submittal:",
    ...(packet.items.length ? packet.items.map((item, index) => [
      `${index + 1}. ${item.severity.toUpperCase()} - ${item.title}`,
      `   Owner: ${item.ownerRole}`,
      `   Ask: ${item.ask}`,
      `   Why: ${item.why}`,
      item.evidence[0] ? `   Evidence: ${item.evidence[0]}` : "",
    ].filter(Boolean).join("\n")) : ["No installer/design actions are blocking the current package."]),
  ].join("\n");
}

export function getInstallerActionPacket(db: AppDb, projectId: string): InstallerActionPacket {
  const detail = getProjectDetail(db, projectId);
  const project = detail.project;
  const reviewerReport = buildReviewerReport(project);
  const historicalReport = buildHistoricalFailureReport(db, projectId);
  const applicationDocs = buildApplicationDocumentPackage(project);
  const processMap = getProjectProcessMap(db, projectId);
  const accountEvidence = evidenceForTopic(project, "accountVerification");
  const meterEvidence = evidenceForTopic(project, "meterPhoto");
  const sldEvidence = evidenceForTopic(project, "sld");
  const inverterEvidence = evidenceForTopic(project, "inverterSettings");
  const items: InstallerActionItem[] = [];
  const seen = new Set<string>();

  const add = (item: InstallerActionItem) => {
    const key = `${item.category}|${item.title}|${item.ask}`.toLowerCase().replace(/\s+/g, " ").slice(0, 260);
    if (seen.has(key)) return;
    seen.add(key);
    items.push(installerAction(item));
  };

  add({
    id: "nem:preflight-confirmation",
    category: "utility_nem",
    severity: "warning",
    title: "NEM preflight confirmation",
    ask: "Confirm utility account holder/service address, account number, meter number/photo, interconnection method, export setting, and inverter settings all match the utility/NEM application.",
    why: "NEM and interconnection rejections commonly come from account mismatch, meter evidence issues, one-line gaps, or inverter setting/document mismatches.",
    ownerRole: "NEM Ops",
    dueBefore: "Before utility/NEM submission",
    evidence: [
      `Utility: ${project.utility || "missing"}`,
      `Interconnection: ${project.interconnectionMethod || "missing"}`,
      ...evidenceLines(accountEvidence),
      ...evidenceLines(meterEvidence),
      ...evidenceLines(sldEvidence).slice(0, 1),
      ...evidenceLines(inverterEvidence).slice(0, 1),
    ],
    source: "utility.nem.preflight",
    relatedId: project.id,
  });

  for (const finding of reviewerReport.findings.filter((item) => item.severity === "blocker" || item.installerCallout).slice(0, 20)) {
    add({
      id: `reviewer:${finding.id}`,
      category: categoryFromReviewer(finding.category),
      severity: finding.severity === "blocker" ? "blocker" : finding.severity === "warning" ? "warning" : "info",
      title: finding.title,
      ask: finding.designTeamAction || finding.cityFeedback || finding.message,
      why: finding.cityFeedback || finding.message,
      ownerRole: finding.category === "utility_nem" ? "NEM Ops" : finding.category === "installer" || finding.installerCallout ? "Installer" : "Designer",
      dueBefore: "Before portal preview/submittal",
      evidence: [
        ...(finding.evidenceFound || []).slice(0, 4).map((evidence) => `${evidence.label}: ${evidence.excerpt || evidence.note}`),
        ...(finding.evidenceNeeded || []).slice(0, 2).map((line) => `Needed: ${line}`),
      ],
      source: "reviewer_gate",
      relatedId: finding.id,
    });
  }

  for (const qc of detail.qcResults.filter((item) => item.qcStatus === "fail").slice(0, 8)) {
    add({
      id: `qc:${qc.id}`,
      category: "documents",
      severity: "blocker",
      title: `QC fail: ${qc.ruleName}`,
      ask: qc.message,
      why: "QC failures block staging because the portal/application data may be wrong or incomplete.",
      ownerRole: "Data QA",
      dueBefore: "Before AHJ/NEM staging",
      evidence: [qc.message],
      source: qc.ruleId,
      relatedId: qc.id,
    });
  }

  for (const review of detail.humanReviewItems.filter((item) => item.status === "pending" && item.fieldName !== "correction").slice(0, 8)) {
    add({
      id: `human-review:${review.id}`,
      category: /account|meter|utility|interconnection/i.test(review.fieldName) ? "utility_nem" : "field_verification",
      severity: "warning",
      title: `Verify ${review.fieldName}`,
      ask: `Confirm the correct value for ${review.fieldName}.`,
      why: review.notes || review.sourceExcerpt || "The parser marked this value for human verification.",
      ownerRole: /account|meter|utility|interconnection/i.test(review.fieldName) ? "NEM Ops" : "Installer",
      dueBefore: "Before final package lock",
      evidence: [review.parserValue ? `Parser value: ${review.parserValue}` : "", review.llmSuggestedValue ? `Suggested: ${review.llmSuggestedValue}` : "", review.sourceExcerpt],
      source: review.issueType,
      relatedId: review.id,
    });
  }

  for (const checklist of historicalReport.checklist.filter((item) => item.status === "missing").slice(0, 8)) {
    const cause = historicalReport.topRejectionCauses.find((candidate) => candidate.signature === checklist.sourceCauseSignature);
    add({
      id: `history:${checklist.id}`,
      category: /account|meter|utility|nem|interconnection|inverter/i.test(`${checklist.title} ${checklist.action}`) ? "utility_nem" : "documents",
      severity: cause?.severity === "blocker" ? "blocker" : "warning",
      title: checklist.title,
      ask: checklist.action,
      why: checklist.why,
      ownerRole: /account|meter|utility|nem|interconnection|inverter/i.test(`${checklist.title} ${checklist.action}`) ? "NEM Ops" : "Permit Ops",
      dueBefore: "Before submittal package is sent",
      evidence: checklist.evidence,
      source: "historical_failures",
      relatedId: checklist.id,
    });
  }

  for (const field of applicationDocs.missingFields.slice(0, 8)) {
    add({
      id: `application-field:${field}`,
      category: /account|meter|utility|interconnection|nem/i.test(field) ? "utility_nem" : "documents",
      severity: "blocker",
      title: `Missing application field: ${field}`,
      ask: `Provide the value needed for ${field}.`,
      why: "The generated AHJ/NEM application packet cannot be considered complete without this field.",
      ownerRole: /account|meter|utility|interconnection|nem/i.test(field) ? "NEM Ops" : "Permit Ops",
      dueBefore: "Before application packet upload",
      evidence: [`Missing field from ${applicationDocs.profile.name}`],
      source: "forms.application_docs",
      relatedId: null,
    });
  }

  for (const correction of detail.corrections.filter((item) => !item.closedAt && !item.resubmitted).slice(0, 10)) {
    add({
      id: `correction:${correction.id}`,
      category: /nem|utility|meter|account|interconnection|inverter|powerclerk/i.test(`${correction.correctionText} ${correction.rootCause} ${correction.requiredAction}`) ? "utility_nem" : "correction",
      severity: "blocker",
      title: `Open correction: ${correction.rootCause || correction.correctionBucket}`,
      ask: correction.requiredAction || correction.correctionText,
      why: correction.rootCause || "Open correction must be resolved before resubmittal.",
      ownerRole: correction.assignedTo || (correction.correctionBucket === "B_designer_fix" ? "Designer" : "Corrections Coordinator"),
      dueBefore: "Before resubmittal",
      evidence: [correction.correctionText],
      source: correction.source,
      relatedId: correction.id,
    });
  }

  for (const lane of processMap.lanes) {
    for (const step of lane.steps.filter((step) => step.status === "blocked").slice(0, 4)) {
      add({
        id: `process:${step.id}`,
        category: lane.key === "nem" ? "utility_nem" : lane.key === "permit" ? "documents" : "field_verification",
        severity: "blocker",
        title: `${lane.title}: ${step.label}`,
        ask: step.nextAction,
        why: step.summary,
        ownerRole: step.ownerRole,
        dueBefore: lane.key === "nem" ? "Before NEMflow can advance" : "Before PermitFlow can advance",
        evidence: step.evidence,
        source: step.source,
        relatedId: step.id,
      });
    }
  }

  items.sort((a, b) => installerSeverityRank(b.severity) - installerSeverityRank(a.severity) || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  const capped = items.slice(0, 30);
  const blockerCount = capped.filter((item) => item.severity === "blocker").length;
  const warningCount = capped.filter((item) => item.severity === "warning").length;
  const installerActionCount = capped.filter((item) => item.ownerRole === "Installer").length;
  const designActionCount = capped.filter((item) => item.ownerRole === "Designer").length;
  const nemActionCount = capped.filter((item) => item.category === "utility_nem" || item.ownerRole === "NEM Ops").length;
  const status: InstallerActionPacket["status"] = blockerCount ? "blocked" : capped.length ? "needs_action" : "clear";
  const nextAction = capped[0]?.ask || "No installer/design actions are currently blocking the package.";
  const generatedAt = nowIso();
  const headline = `${capped.length} installer/design action(s): ${blockerCount} blocker(s), ${warningCount} warning(s), ${nemActionCount} NEM item(s).`;
  const basePacket: Omit<InstallerActionPacket, "reportText"> = {
    projectId,
    generatedAt,
    headline,
    status,
    totalActions: capped.length,
    blockerCount,
    warningCount,
    installerActionCount,
    designActionCount,
    nemActionCount,
    nextAction,
    items: capped,
  };
  return {
    ...basePacket,
    reportText: renderInstallerActionText(basePacket),
  };
}

function submitGateCheck(input: SubmitGateCheck): SubmitGateCheck {
  return {
    ...input,
    evidence: input.evidence.filter(Boolean).map((line) => shorten(text(line), 190)).slice(0, 6),
  };
}

function renderSubmitGateReportText(report: Omit<SubmitGateReport, "reportText">): string {
  return [
    `PermitFlow + NEMflow Submit Gate - ${new Date(report.generatedAt).toLocaleString()}`,
    report.headline,
    "",
    `Decision: ${report.decision.replaceAll("_", " ")}`,
    `Next action: ${report.nextAction}`,
    `Can prepare submittal: ${report.canPrepareSubmission ? "yes" : "no"}`,
    `Can human submit: ${report.canHumanSubmit ? "yes" : "no"}`,
    "",
    "Gate checks:",
    ...report.checks.map((check, index) => [
      `${index + 1}. ${check.status.toUpperCase()} - ${check.title}`,
      `   Lane: ${check.lane}`,
      `   Owner: ${check.ownerRole}`,
      `   Requirement: ${check.requirement}`,
      `   Next: ${check.nextAction}`,
      check.evidence[0] ? `   Evidence: ${check.evidence[0]}` : "",
      `   Source: ${check.source}`,
    ].filter(Boolean).join("\n")),
    "",
    "Manual submit checklist:",
    ...report.manualSubmitChecklist.map((item) => `- ${item}`),
  ].join("\n");
}

export function getSubmitGateReport(db: AppDb, projectId: string): SubmitGateReport {
  const detail = getProjectDetail(db, projectId);
  const project = detail.project;
  const historicalReport = buildHistoricalFailureReport(db, projectId);
  const reviewerReport = buildReviewerReport(project);
  const applicationDocs = buildApplicationDocumentPackage(project);
  const processMap = getProjectProcessMap(db, projectId);
  const installerPacket = getInstallerActionPacket(db, projectId);
  const activeEmailSources = db.query<Row>(
    "SELECT id, label, last_checked_at, last_matched_count, last_error FROM email_tracking_sources WHERE active = 1 ORDER BY updated_at DESC",
  );

  const accountEvidence = evidenceForTopic(project, "accountVerification");
  const meterEvidence = evidenceForTopic(project, "meterPhoto");
  const sldEvidence = evidenceForTopic(project, "sld");
  const siteEvidence = evidenceForTopic(project, "siteRoofPlan");
  const inverterEvidence = evidenceForTopic(project, "inverterSettings");
  const utilityApprovalEvidence = evidenceForTopic(project, "utilityApproval");
  const pendingCritical = detail.humanReviewItems.filter((item) => item.status === "pending" && item.fieldName !== "correction");
  const qcFails = detail.qcResults.filter((item) => item.qcStatus === "fail");
  const qcWarnings = detail.qcResults.filter((item) => item.qcStatus === "warning");
  const reviewerBlockers = reviewerReport.findings.filter((item) => item.severity === "blocker");
  const reviewerWarnings = reviewerReport.findings.filter((item) => item.severity === "warning");
  const historicalMissing = historicalReport.checklist.filter((item) => item.status === "missing");
  const learnedHistoricalBlockers = historicalMissing.filter((item) => {
    const cause = historicalReport.topRejectionCauses.find((candidate) => candidate.signature === item.sourceCauseSignature);
    return Boolean(cause && cause.count > 0 && cause.severity === "blocker");
  });
  const openCorrections = detail.corrections.filter((correction) => !correction.closedAt && !correction.resubmitted);
  const openNemCorrections = openCorrections.filter((correction) => /nem|net.?meter|interconnection|pto|utility|meter|account|powerclerk|inverter|1741/i.test(`${correction.correctionText} ${correction.rootCause} ${correction.requiredAction}`));
  const criticalFields: Array<[string, unknown]> = [
    ["Homeowner", project.homeownerName],
    ["Service address", project.projectAddress],
    ["AHJ", project.ahj],
    ["Utility", project.utility],
    ["Account", project.accountNumber],
    ["Meter", project.meterNumber],
    ["DC size", project.systemSizeDcKw],
    ["AC size", project.systemSizeAcKw],
    ["Interconnection", project.interconnectionMethod],
  ];
  const missingCritical = criticalFields.filter(([, value]) => !hasValue(value)).map(([label]) => label);
  const permitLane = processMap.lanes.find((lane) => lane.key === "permit");
  const nemLane = processMap.lanes.find((lane) => lane.key === "nem");
  const blockedPermitSteps = (permitLane?.steps || []).filter((step) => step.status === "blocked");
  const blockedNemSteps = (nemLane?.steps || []).filter((step) => step.status === "blocked");
  const waitingNemSteps = (nemLane?.steps || []).filter((step) => step.status === "waiting" || step.status === "in_progress");
  const nemDocs = applicationDocs.docs.filter((doc) => doc.documentType === "utility_application" || /nem|utility|interconnection|powerclerk/i.test(`${doc.title} ${doc.fileName}`));
  const requiredNemFieldMissing = missingCritical.filter((field) => /utility|account|meter|interconnection/i.test(field));
  const utilityEvidenceOk = accountEvidence.present && meterEvidence.present && accountEvidence.confidence !== "low" && meterEvidence.confidence !== "low";
  const nemEvidenceMissing = [
    requiredNemFieldMissing.length ? `Missing NEM field(s): ${requiredNemFieldMissing.join(", ")}` : "",
    !accountEvidence.present ? "Account proof missing" : "",
    !meterEvidence.present ? "Meter proof missing" : "",
    !sldEvidence.present ? "SLD/one-line evidence missing" : "",
    !inverterEvidence.present ? "Inverter settings/spec evidence missing" : "",
  ].filter(Boolean);
  const stagedRun = detail.portalRuns.find((run) => run.status === "awaiting_human_submit");
  const submittedOrBeyond = detail.submissions.some((submission) => submission.status === "submitted")
    || ["submitted", "approved", "ready_for_issue", "issued", "complete"].includes(project.status);
  const activeEmailSource = activeEmailSources[0];

  const checks: SubmitGateCheck[] = [
    submitGateCheck({
      id: "single-project-record",
      title: "Single project record",
      lane: "intake",
      status: missingCritical.length ? "blocker" : "pass",
      ownerRole: "Intake Coordinator",
      requirement: "Homeowner, service address, AHJ, utility, account, meter, system size, and interconnection method must be captured before PermitFlow or NEMflow staging.",
      evidence: missingCritical.length ? missingCritical.map((field) => `Missing: ${field}`) : criticalFields.map(([label, value]) => `${label}: ${hasValue(value) ? "captured" : "missing"}`),
      nextAction: missingCritical.length ? `Resolve missing source-of-truth fields: ${missingCritical.join(", ")}.` : "Use this record as the source for every form, portal, and tracker.",
      source: "project.fields",
    }),
    submitGateCheck({
      id: "qc-human-review",
      title: "Extraction QC and human review",
      lane: "qc",
      status: qcFails.length ? "blocker" : pendingCritical.length ? "blocker" : qcWarnings.length ? "warning" : "pass",
      ownerRole: "Data QA",
      requirement: "QC failures and unresolved critical human-review fields must be cleared before portal staging.",
      evidence: [
        ...qcFails.slice(0, 4).map((item) => `${item.ruleName}: ${item.message}`),
        ...pendingCritical.slice(0, 4).map((item) => `Pending human review: ${item.fieldName}`),
        ...qcWarnings.slice(0, 3).map((item) => `Warning: ${item.ruleName}`),
      ],
      nextAction: qcFails.length || pendingCritical.length ? "Resolve QC failures and human review items, then rerun QC." : qcWarnings.length ? "Review warning values against source evidence before staging." : "QC is clear.",
      source: "qc.human_review",
    }),
    submitGateCheck({
      id: "permit-requirements",
      title: "PermitFlow reviewer and history check",
      lane: "permit",
      status: reviewerBlockers.length || learnedHistoricalBlockers.length || blockedPermitSteps.length ? "blocker" : reviewerWarnings.length || historicalMissing.length ? "warning" : "pass",
      ownerRole: "Permit Ops",
      requirement: "AHJ-style reviewer blockers and learned historical blocker patterns must be resolved before permit staging.",
      evidence: [
        ...reviewerBlockers.slice(0, 4).map((finding) => `${finding.title}: ${finding.evidenceStatus}`),
        ...learnedHistoricalBlockers.slice(0, 4).map((item) => `Historical blocker: ${item.title}`),
        ...blockedPermitSteps.slice(0, 3).map((step) => `${step.label}: ${step.nextAction}`),
        ...reviewerWarnings.slice(0, 2).map((finding) => `Warning: ${finding.title}`),
      ],
      nextAction: reviewerBlockers.length || learnedHistoricalBlockers.length || blockedPermitSteps.length ? "Clear AHJ blocker callouts and learned historical gaps before staging." : reviewerWarnings.length || historicalMissing.length ? "Confirm warnings and checklist gaps with evidence." : "PermitFlow requirements are clear.",
      source: "requirements.reviewer.history",
    }),
    submitGateCheck({
      id: "ahj-nem-docs",
      title: "AHJ and NEM document packet",
      lane: applicationDocs.missingFields.some((field) => /utility|account|meter|interconnection|nem/i.test(field)) ? "nem" : "permit",
      status: applicationDocs.missingFields.length ? "blocker" : applicationDocs.docs.length ? "pass" : "warning",
      ownerRole: "Permit Ops",
      requirement: "Required AHJ and utility/NEM forms, worksheets, and attachment lists must be generated with no missing source fields.",
      evidence: [
        `${applicationDocs.profile.name}: ${applicationDocs.docs.length} generated document(s)`,
        ...nemDocs.slice(0, 3).map((doc) => `NEM doc: ${doc.title}`),
        ...applicationDocs.docs.slice(0, 3).map((doc) => `Generated: ${doc.title}`),
        ...applicationDocs.missingFields.slice(0, 6).map((field) => `Missing field: ${field}`),
      ],
      nextAction: applicationDocs.missingFields.length ? "Fill missing fields and rebuild AHJ/NEM docs before staging." : "Open the packet and verify each generated form and attachment list.",
      source: "forms.application_docs",
    }),
    submitGateCheck({
      id: "nem-preflight",
      title: "NEMflow preflight",
      lane: "nem",
      status: nemEvidenceMissing.length || blockedNemSteps.length || openNemCorrections.length ? "blocker" : !utilityEvidenceOk || accountEvidence.confidence === "medium" || meterEvidence.confidence === "medium" || waitingNemSteps.length ? "warning" : "pass",
      ownerRole: "NEM Ops",
      requirement: "NEMflow must have utility, account holder/address proof, meter proof, one-line/SLD, inverter settings/specs, and no open utility correction before utility staging.",
      evidence: [
        `Utility: ${project.utility || "missing"}`,
        `Interconnection: ${project.interconnectionMethod || "missing"}`,
        ...nemEvidenceMissing,
        ...evidenceLines(accountEvidence),
        ...evidenceLines(meterEvidence),
        ...evidenceLines(sldEvidence).slice(0, 2),
        ...evidenceLines(inverterEvidence).slice(0, 2),
        ...blockedNemSteps.slice(0, 3).map((step) => `${step.label}: ${step.nextAction}`),
      ],
      nextAction: nemEvidenceMissing.length || blockedNemSteps.length || openNemCorrections.length ? "Resolve NEM account/meter/equipment evidence and open utility corrections before staging." : !utilityEvidenceOk || waitingNemSteps.length ? "Human-verify medium-confidence NEM evidence and update utility tracking." : "NEMflow preflight is clear.",
      source: "utility.nem.preflight",
    }),
    submitGateCheck({
      id: "installer-design-actions",
      title: "Installer/design action packet",
      lane: installerPacket.nemActionCount ? "nem" : "permit",
      status: installerPacket.blockerCount ? "blocker" : installerPacket.warningCount ? "warning" : "pass",
      ownerRole: installerPacket.items[0]?.ownerRole || "Operations",
      requirement: "Installer, designer, and NEM Ops callouts must be reviewed before the company sends a package to AHJ or utility intake.",
      evidence: [
        installerPacket.headline,
        ...installerPacket.items.slice(0, 5).map((item) => `${item.severity.toUpperCase()}: ${item.title} - ${item.ask}`),
      ],
      nextAction: installerPacket.blockerCount || installerPacket.warningCount ? installerPacket.nextAction : "No installer/design actions are blocking staging.",
      source: "installer_actions",
    }),
    submitGateCheck({
      id: "tracking-email",
      title: "Permit and NEM tracking",
      lane: "tracking",
      status: detail.permitCheckTargets.length || activeEmailSources.length || detail.emailProjectMatches.length ? "pass" : "warning",
      ownerRole: "Operations Coordinator",
      requirement: "A live project needs AHJ/utility tracking targets or email watch configured so approvals, corrections, missing info, fees, and PTO updates can be matched back to the record.",
      evidence: [
        `${detail.permitCheckTargets.length} permit/NEM tracking target(s)`,
        `${detail.emailProjectMatches.length} matched email(s)`,
        activeEmailSource ? `Active email source: ${text(activeEmailSource.label)}` : "No active email watch source",
        activeEmailSource?.last_checked_at ? `Last email scan: ${text(activeEmailSource.last_checked_at)}` : "",
        activeEmailSource?.last_error ? `Email source error: ${text(activeEmailSource.last_error)}` : "",
      ],
      nextAction: detail.permitCheckTargets.length || activeEmailSources.length ? "Keep email scans and permit/NEM status checks current." : "Configure live MBOX tracking or add AHJ/utility portal tracking targets before live submit.",
      source: "tracking.email",
    }),
    submitGateCheck({
      id: "portal-final-review",
      title: "Portal preview and manual submit guardrail",
      lane: "portal",
      status: process.env.SESSION_ENCRYPTION_KEY || stagedRun || submittedOrBeyond ? "pass" : "warning",
      ownerRole: "Submission Specialist",
      requirement: "Automation may stage PermitFlow/NEMflow only to the final review screen. A human must verify the portal preview, attachment list, fees, acknowledgements, and final packet before manually submitting.",
      evidence: [
        stagedRun ? `Portal run ${stagedRun.id}: awaiting human submit` : "No staged portal run awaiting human submit",
        reviewerReport.finalSubmitGate.mustShowAhjPreviewWindow ? "Reviewer gate requires visible AHJ/utility preview or internal final review packet." : "Reviewer gate still requires human final review.",
        process.env.SESSION_ENCRYPTION_KEY ? "Session storage encryption key configured." : "SESSION_ENCRYPTION_KEY is not configured for real storage-state testing.",
      ],
      nextAction: stagedRun ? "Verify the portal preview and click submit manually only after all checklist items pass." : "Use Prepare Submittal only when blockers are clear; automation must stop at final review.",
      source: "security.portal_guardrails",
    }),
    submitGateCheck({
      id: "closeout-approvals",
      title: "Approval and closeout awareness",
      lane: "closeout",
      status: submittedOrBeyond || utilityApprovalEvidence.present ? "pass" : "warning",
      ownerRole: "Operations Coordinator",
      requirement: "After manual submit, approval/PTO/correction emails and portal updates must be captured so install-ready release depends on real AHJ and utility evidence.",
      evidence: [
        submittedOrBeyond ? `Project status: ${project.status}` : "Project has not been manually submitted yet.",
        ...evidenceLines(utilityApprovalEvidence),
        ...detail.submissions.slice(0, 3).map((submission) => `${submission.submissionType}: ${submission.status} ${submission.confirmationNumber || ""}`),
      ],
      nextAction: submittedOrBeyond ? "Track AHJ and NEM approvals through install-ready release." : "Capture confirmation numbers after the human completes final submit.",
      source: "submissions.approval_tracking",
    }),
  ];

  const blockerCount = checks.filter((check) => check.status === "blocker").length;
  const warningCount = checks.filter((check) => check.status === "warning").length;
  const passCount = checks.filter((check) => check.status === "pass").length;
  const decision: SubmitGateReport["decision"] = submittedOrBeyond
    ? "submitted_tracking"
    : blockerCount
      ? "blocked"
      : stagedRun
        ? "staged_awaiting_human"
        : "ready_to_stage";
  const canPrepareSubmission = decision === "ready_to_stage";
  const canHumanSubmit = decision === "staged_awaiting_human";
  const nextAction = checks.find((check) => check.status === "blocker")?.nextAction
    || (stagedRun ? "Human review required. Verify all fields and click submit manually." : "")
    || checks.find((check) => check.status === "warning")?.nextAction
    || (submittedOrBeyond ? "Keep AHJ/NEM approval tracking live until install-ready release." : "Prepare Submittal, verify the final portal preview, and keep final submit manual.");
  const headline = decision === "blocked"
    ? `Submit gate blocked: ${blockerCount} blocker(s), ${warningCount} warning(s).`
    : decision === "staged_awaiting_human"
      ? `Staged at final review: ${warningCount} warning(s), human submit required.`
      : decision === "submitted_tracking"
        ? `Submitted/tracking: ${blockerCount} blocker(s), ${warningCount} warning(s), ${passCount} pass check(s).`
        : `Ready to stage PermitFlow + NEMflow: ${warningCount} warning(s) to verify.`;
  const manualSubmitChecklist = [
    "Open the AHJ/utility portal preview or internal final review packet before any legal submit.",
    "Verify homeowner, service address, AHJ, utility, account number, meter number, DC/AC size, interconnection method, and equipment.",
    "Compare every AHJ/NEM form field against the single project record and generated packet.",
    "Confirm uploaded files: planset, site/roof plan, SLD/one-line, utility bill/account proof, meter proof, specs, labels, structural documents, and required AHJ/NEM forms.",
    "Confirm fees, signatures, owner authorizations, CAPTCHA, MFA, and payment steps are handled only by a human.",
    "Human review required. Verify all fields and click submit manually.",
    "After manual submit, capture confirmation, application, permit, and utility/NEM numbers in the dashboard.",
  ];
  const generatedAt = nowIso();
  const baseReport: Omit<SubmitGateReport, "reportText"> = {
    projectId,
    generatedAt,
    decision,
    headline,
    nextAction,
    canPrepareSubmission,
    canHumanSubmit,
    blockerCount,
    warningCount,
    passCount,
    checks,
    manualSubmitChecklist,
  };

  return {
    ...baseReport,
    reportText: renderSubmitGateReportText(baseReport),
  };
}

function timelineSeverityForOperation(status: OperationStepStatus): ProjectTimelineEvent["severity"] {
  if (status === "blocked") return "blocker";
  if (status === "waiting") return "warning";
  if (status === "done") return "pass";
  return "info";
}

function timelineSeverityForPermit(outcome: PermitCheckOutcome): ProjectTimelineEvent["severity"] {
  if (outcome === "correction_flagged") return "blocker";
  if (outcome === "needs_human_review" || outcome === "waiting") return "warning";
  if (outcome === "ready_for_issue" || outcome === "issued" || outcome === "reviewed_by_ahj") return "pass";
  return "info";
}

function timelineSeverityForEmail(bucket: EmailProjectMatch["emailBucket"]): ProjectTimelineEvent["severity"] {
  if (bucket === "permit_correction" || bucket === "nem_correction") return "blocker";
  if (bucket === "missing_info_request" || bucket === "fee_request") return "warning";
  if (bucket === "permit_approval" || bucket === "nem_approval" || bucket === "inspection_final_notice") return "pass";
  return "info";
}

function timelineSeverityForPortal(status: PortalRun["status"]): ProjectTimelineEvent["severity"] {
  if (status === "failed") return "blocker";
  if (status === "awaiting_human_submit" || status === "queued" || status === "running") return "warning";
  return "pass";
}

function shorten(value: string, limit = 220): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}...` : cleaned;
}

function timelineEvidence(lines: string[]): string[] {
  return lines.map((line) => shorten(text(line), 180)).filter(Boolean).slice(0, 4);
}

function renderProjectTimelineText(report: Omit<ProjectTimelineReport, "reportText">): string {
  return [
    `Project Timeline - ${new Date(report.generatedAt).toLocaleString()}`,
    report.headline,
    "",
    "Latest activity:",
    ...(report.events.length ? report.events.slice(0, 14).map((event) => [
      `- ${new Date(event.occurredAt).toLocaleString()} | ${event.severity.toUpperCase()} | ${event.title}`,
      `  ${event.detail}`,
      event.nextAction ? `  Next: ${event.nextAction}` : "",
      event.ownerRole ? `  Owner: ${event.ownerRole}` : "",
    ].filter(Boolean).join("\n")) : ["- No activity recorded yet."]),
  ].join("\n");
}

export function getProjectTimelineReport(db: AppDb, projectId: string): ProjectTimelineReport {
  const detail = getProjectDetail(db, projectId);
  const project = detail.project;
  const notes = db.query<Row>("SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at DESC LIMIT 60", [projectId]).map(mapProjectNote);
  const steps = db.query<Row>("SELECT * FROM operation_steps WHERE project_id = ? ORDER BY updated_at DESC LIMIT 80", [projectId]).map(mapOperationStep);
  const events: ProjectTimelineEvent[] = [];

  const push = (event: Omit<ProjectTimelineEvent, "projectId">) => {
    events.push({
      projectId,
      ...event,
      detail: shorten(event.detail, 360),
      nextAction: shorten(event.nextAction, 260),
      evidence: timelineEvidence(event.evidence),
    });
  };

  push({
    id: `project:${project.id}:created`,
    occurredAt: project.createdAt,
    category: "project",
    severity: "info",
    title: "Project created from parser",
    detail: `${project.homeownerName || "Unnamed project"}${project.projectAddress ? ` at ${project.projectAddress}` : ""}.`,
    actor: "front-end parser",
    source: "project.created",
    ownerRole: "Intake Coordinator",
    nextAction: "Confirm source files, intake fields, AHJ, utility, account, meter, and system size.",
    evidence: [
      project.ahj ? `AHJ: ${project.ahj}` : "AHJ missing",
      project.utility ? `Utility: ${project.utility}` : "Utility missing",
      project.parserConfidenceSummary,
    ],
    relatedId: project.id,
  });

  for (const note of notes) {
    push({
      id: `note:${note.id}`,
      occurredAt: note.createdAt,
      category: "pm_note",
      severity: note.noteType === "blocker" ? "blocker" : note.noteType === "handoff" ? "pass" : "info",
      title: note.noteType.replaceAll("_", " "),
      detail: note.body,
      actor: note.createdBy || "Operations",
      source: "project_notes",
      ownerRole: "Operations",
      nextAction: note.noteType === "blocker" ? "Resolve this blocker or assign it to the responsible owner." : "Keep this note in the project handoff context.",
      evidence: [note.body],
      relatedId: note.id,
    });
  }

  for (const step of steps.filter((step) => step.statusSource === "manual" || step.notes || step.status !== "not_started").slice(0, 24)) {
    push({
      id: `operation:${step.id}`,
      occurredAt: step.updatedAt,
      category: "operation",
      severity: timelineSeverityForOperation(step.status),
      title: `${step.phaseName}: ${step.status.replaceAll("_", " ")}`,
      detail: step.summary || step.nextAction,
      actor: step.statusSource === "manual" ? "PM update" : "system",
      source: step.source || "operation_steps",
      ownerRole: step.ownerRole || "Operations",
      nextAction: step.nextAction,
      evidence: [step.notes, step.dueAt ? `Due: ${step.dueAt}` : "", `Status source: ${step.statusSource}`],
      relatedId: step.id,
    });
  }

  for (const qc of detail.qcResults.filter((item) => item.qcStatus !== "pass").slice(0, 24)) {
    push({
      id: `qc:${qc.id}`,
      occurredAt: qc.createdAt,
      category: "qc",
      severity: qc.qcStatus === "fail" ? "blocker" : "warning",
      title: `QC ${qc.qcStatus}: ${qc.ruleName}`,
      detail: qc.message,
      actor: "QC gate",
      source: qc.ruleId,
      ownerRole: "Data QA",
      nextAction: qc.qcStatus === "fail" ? "Resolve the failed field or document evidence, then rerun QC." : "Review the warning before staging.",
      evidence: [qc.message, qc.severity],
      relatedId: qc.id,
    });
  }

  for (const item of detail.humanReviewItems.slice(0, 24)) {
    push({
      id: `review:${item.id}`,
      occurredAt: item.updatedAt || item.createdAt,
      category: "human_review",
      severity: item.status === "pending" ? "warning" : item.status === "rejected" ? "blocker" : "pass",
      title: `Human review ${item.status}: ${item.fieldName}`,
      detail: item.notes || item.sourceExcerpt || `${item.issueType} requires human verification.`,
      actor: "Human Review",
      source: item.issueType,
      ownerRole: "Data QA",
      nextAction: item.status === "pending" ? "Approve, edit, or reject this review item." : "Use the verified value in project forms and portal staging.",
      evidence: [item.parserValue ? `Parser: ${item.parserValue}` : "", item.llmSuggestedValue ? `Suggested: ${item.llmSuggestedValue}` : "", item.sourceExcerpt],
      relatedId: item.id,
    });
  }

  for (const correction of detail.corrections.slice(0, 30)) {
    const open = !correction.closedAt && !correction.resubmitted;
    push({
      id: `correction:${correction.id}`,
      occurredAt: correction.createdAt,
      category: "correction",
      severity: open ? "blocker" : "pass",
      title: `Correction: ${correction.correctionBucket}`,
      detail: correction.requiredAction || correction.rootCause || correction.correctionText,
      actor: correction.source,
      source: "corrections",
      ownerRole: correction.assignedTo || (correction.correctionBucket === "B_designer_fix" ? "Designer" : "Corrections Coordinator"),
      nextAction: open ? "Complete the required action and mark the correction ready for resubmittal." : "Keep correction evidence attached for future learning.",
      evidence: [correction.rootCause, correction.correctionText],
      relatedId: correction.id,
    });
  }

  for (const check of detail.permitStatusChecks.slice(0, 40)) {
    push({
      id: `permit-status:${check.id}`,
      occurredAt: check.createdAt,
      category: "permit_status",
      severity: timelineSeverityForPermit(check.outcome),
      title: `Permit/NEM status: ${check.statusLabel || check.outcome}`,
      detail: check.message || check.rawStatusText,
      actor: check.source,
      source: "permit_status_checks",
      ownerRole: check.outcome === "correction_flagged" ? "Corrections Coordinator" : "Operations Coordinator",
      nextAction: check.correctionId ? "Open the linked correction and assign required action." : check.readyForIssue ? "Capture fees/issued permit details after human action." : "Continue tracking until approval, PTO, or correction is clear.",
      evidence: [check.applicationNumber ? `Application: ${check.applicationNumber}` : "", check.permitNumber ? `Permit: ${check.permitNumber}` : "", check.rawStatusText],
      relatedId: check.id,
    });
  }

  for (const match of detail.emailProjectMatches.slice(0, 40)) {
    push({
      id: `email:${match.id}`,
      occurredAt: match.occurredAt || match.createdAt,
      category: "email",
      severity: timelineSeverityForEmail(match.emailBucket),
      title: `Email matched: ${match.emailBucket.replaceAll("_", " ")}`,
      detail: match.subject || `${match.workflow} email matched by ${match.matchReason}.`,
      actor: match.sourceLabel || "email tracker",
      source: "email_project_matches",
      ownerRole: match.emailBucket.includes("correction") ? "Corrections Coordinator" : match.workflow === "nem" ? "NEM Ops" : "Operations Coordinator",
      nextAction: match.correctionId ? "Review the linked correction and assign it." : match.statusCheckId ? "Review the linked status check and update the project stage if needed." : "Review matched email context.",
      evidence: [`Confidence: ${Math.round(match.confidence * 100)}%`, `Matched by: ${match.matchReason}`, `Workflow: ${match.workflow}`],
      relatedId: match.id,
    });
  }

  for (const run of detail.portalRuns.slice(0, 20)) {
    push({
      id: `portal:${run.id}`,
      occurredAt: run.finishedAt || run.startedAt,
      category: "portal",
      severity: timelineSeverityForPortal(run.status),
      title: `Portal run: ${run.status}`,
      detail: run.errorMessage || (run.humanActionRequired ? "Human review required. Verify all fields and click submit manually." : `${run.runType} portal automation run.`),
      actor: "portal bot",
      source: "portal_runs",
      ownerRole: "Submission Specialist",
      nextAction: run.status === "awaiting_human_submit" ? "Verify final preview, submit manually, then capture confirmation." : run.status === "failed" ? "Review portal run logs and retry only after fixing the blocker." : "Continue tracking submission status.",
      evidence: [run.screenshotsPath, run.logsPath],
      relatedId: run.id,
    });
  }

  for (const submission of detail.submissions.slice(0, 20)) {
    push({
      id: `submission:${submission.id}`,
      occurredAt: submission.submittedAt || project.updatedAt,
      category: "submission",
      severity: submission.status === "failed" ? "blocker" : submission.status === "awaiting_human_submit" || submission.status === "staged" ? "warning" : "pass",
      title: `Submission ${submission.status}: ${submission.submissionType}`,
      detail: submission.notes || `${submission.submissionType} submission ${submission.status}.`,
      actor: submission.submittedBy || "Operations",
      source: "submissions",
      ownerRole: "Submission Specialist",
      nextAction: submission.status === "awaiting_human_submit" || submission.status === "staged" ? "Human must verify portal preview and submit manually." : "Track approval and capture final permit/NEM evidence.",
      evidence: [submission.applicationNumber ? `Application: ${submission.applicationNumber}` : "", submission.permitNumber ? `Permit: ${submission.permitNumber}` : "", submission.confirmationNumber ? `Confirmation: ${submission.confirmationNumber}` : ""],
      relatedId: submission.id,
    });
  }

  for (const log of detail.auditLogs.slice(0, 35)) {
    push({
      id: `audit:${log.id}`,
      occurredAt: log.createdAt,
      category: "audit",
      severity: "info",
      title: log.action,
      detail: `${log.actorType}: ${log.actorName}`,
      actor: log.actorName || log.actorType,
      source: "audit_logs",
      ownerRole: "Operations",
      nextAction: "",
      evidence: Object.entries(log.details || {}).slice(0, 3).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`),
      relatedId: log.id,
    });
  }

  events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.category.localeCompare(b.category));
  const cappedEvents = events.slice(0, 90);
  const blockerCount = cappedEvents.filter((event) => event.severity === "blocker").length;
  const warningCount = cappedEvents.filter((event) => event.severity === "warning").length;
  const emailCount = cappedEvents.filter((event) => event.category === "email").length;
  const correctionCount = cappedEvents.filter((event) => event.category === "correction").length;
  const generatedAt = nowIso();
  const latestActivityAt = cappedEvents[0]?.occurredAt || null;
  const headline = latestActivityAt
    ? `${cappedEvents.length} timeline event(s). Latest: ${cappedEvents[0].title}. ${blockerCount} blocker(s), ${warningCount} warning(s).`
    : "No project timeline activity recorded yet.";
  const baseReport: Omit<ProjectTimelineReport, "reportText"> = {
    projectId,
    generatedAt,
    headline,
    latestActivityAt,
    totalEvents: cappedEvents.length,
    blockerCount,
    warningCount,
    emailCount,
    correctionCount,
    events: cappedEvents,
  };
  return {
    ...baseReport,
    reportText: renderProjectTimelineText(baseReport),
  };
}

export function getEmailTrackerStatus(db: AppDb): { sources: EmailTrackingSource[]; recentMatches: EmailProjectMatch[] } {
  return {
    sources: db.query<Row>("SELECT * FROM email_tracking_sources ORDER BY active DESC, updated_at DESC").map(mapEmailTrackingSource),
    recentMatches: db.query<Row>("SELECT * FROM email_project_matches ORDER BY created_at DESC LIMIT 50").map(mapEmailProjectMatch),
  };
}

export function configureEmailTrackingSource(
  db: AppDb,
  input: { filePath?: string; label?: string; defaultState?: string; defaultAhj?: string; defaultUtility?: string; active?: boolean },
): { sources: EmailTrackingSource[]; recentMatches: EmailProjectMatch[] } {
  const filePath = path.resolve(String(input.filePath || "").trim());
  if (!String(input.filePath || "").trim()) throw new HttpError(400, "MBOX watch path is required.");
  const label = text(input.label) || path.basename(filePath) || "Watched MBOX";
  const ts = nowIso();
  db.run(
    `INSERT INTO email_tracking_sources
      (id, source_type, label, file_path, default_state, default_ahj, default_utility, active,
       last_message_count, last_matched_count, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       label = excluded.label,
       default_state = excluded.default_state,
       default_ahj = excluded.default_ahj,
       default_utility = excluded.default_utility,
       active = excluded.active,
       updated_at = excluded.updated_at`,
    [
      id(),
      "mbox_path",
      label,
      filePath,
      text(input.defaultState),
      text(input.defaultAhj),
      text(input.defaultUtility),
      input.active === false ? 0 : 1,
      0,
      0,
      "",
      ts,
      ts,
    ],
  );
  return getEmailTrackerStatus(db);
}

function searchNormalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compactIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function containsLoose(haystack: string, needle: string): boolean {
  const normalizedNeedle = searchNormalize(needle);
  return normalizedNeedle.length >= 4 && haystack.includes(normalizedNeedle);
}

function containsIdentifier(raw: string, value: string): boolean {
  const needle = compactIdentifier(value);
  return needle.length >= 5 && compactIdentifier(raw).includes(needle);
}

function trackingNumbersForProject(db: AppDb, projectId: string): string[] {
  return db
    .query<Row>(
      `SELECT application_number, permit_number FROM permit_check_targets WHERE project_id = ?
       UNION ALL
       SELECT application_number, permit_number FROM submissions WHERE project_id = ?`,
      [projectId, projectId],
    )
    .flatMap((row) => [text(row.application_number), text(row.permit_number)])
    .filter(Boolean);
}

function firstPermitTargetId(db: AppDb, projectId: string): string | null {
  const row = db.get<Row>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY active DESC, created_at DESC LIMIT 1", [projectId]);
  return row ? text(row.id) : null;
}

function extractTrackingNumber(raw: string, labels: RegExp[]): string {
  for (const label of labels) {
    const match = raw.match(label);
    if (match?.[1]) return match[1].trim().slice(0, 80);
  }
  return "";
}

function matchProjectForEmail(db: AppDb, message: ClassifiedMboxMessage): { project: ProjectRecord; confidence: number; reason: string } | null {
  const raw = message.rawSearchText;
  const haystack = searchNormalize(raw);
  const projects = db.query<ProjectRow>("SELECT * FROM projects ORDER BY updated_at DESC").map(mapProject);
  let best: { project: ProjectRecord; score: number; reasons: string[] } | null = null;

  for (const project of projects) {
    let score = 0;
    const reasons: string[] = [];

    if (containsLoose(haystack, project.projectAddress)) {
      score += 50;
      reasons.push("service address");
    }
    if (containsLoose(haystack, project.homeownerName)) {
      score += 30;
      reasons.push("homeowner");
    }
    if (containsIdentifier(raw, project.accountNumber)) {
      score += 35;
      reasons.push("utility account");
    }
    if (containsIdentifier(raw, project.meterNumber)) {
      score += 35;
      reasons.push("meter number");
    }
    for (const number of trackingNumbersForProject(db, project.id)) {
      if (containsIdentifier(raw, number)) {
        score += 45;
        reasons.push("application/permit number");
        break;
      }
    }
    if (project.utility && (containsLoose(haystack, project.utility) || searchNormalize(message.record.utility || "") === searchNormalize(project.utility))) {
      score += 15;
      reasons.push("utility");
    }
    const jurisdiction = message.record.jurisdiction || "";
    if (project.ahj && (containsLoose(haystack, project.ahj) || searchNormalize(jurisdiction) === searchNormalize(project.ahj))) {
      score += 15;
      reasons.push("AHJ");
    }
    if (project.city && containsLoose(haystack, project.city)) {
      score += 8;
      reasons.push("city");
    }
    if (project.state && containsLoose(haystack, project.state)) {
      score += 5;
      reasons.push("state");
    }

    if (!best || score > best.score) best = { project, score, reasons };
  }

  if (!best || best.score < 55 || !best.reasons.length) return null;
  return {
    project: best.project,
    confidence: Math.min(0.99, best.score / 100),
    reason: best.reasons.join(", "),
  };
}

function emailStatusText(message: ClassifiedMboxMessage): string {
  return [
    `Email bucket: ${message.record.type}`,
    message.record.workflow ? `Workflow: ${message.record.workflow}` : "",
    message.record.statusLabel ? `Status: ${message.record.statusLabel}` : "",
    message.record.requiredAction ? `Required action: ${message.record.requiredAction}` : "",
    message.redactedText,
  ].filter(Boolean).join("\n").slice(0, 5000);
}

export async function runEmailTracker(
  db: AppDb,
  input: { sourceId?: string; filePath?: string } = {},
): Promise<EmailTrackerRunResult> {
  const sourceRows = input.filePath
    ? [{
        id: "",
        label: path.basename(path.resolve(input.filePath)),
        file_path: path.resolve(input.filePath),
        default_state: "",
        default_ahj: "",
        default_utility: "",
      } as Row]
    : input.sourceId
      ? db.query<Row>("SELECT * FROM email_tracking_sources WHERE id = ?", [input.sourceId])
      : db.query<Row>("SELECT * FROM email_tracking_sources WHERE active = 1 ORDER BY updated_at DESC");

  const result: EmailTrackerRunResult = {
    sourcesChecked: 0,
    messagesScanned: 0,
    projectMatches: 0,
    statusChecksCreated: 0,
    correctionsCreated: 0,
    skippedDuplicates: 0,
    unmatchedMessages: 0,
    sourceErrors: [],
    matches: [],
  };

  for (const source of sourceRows) {
    result.sourcesChecked += 1;
    const sourceId = text(source.id) || null;
    const filePath = path.resolve(text(source.file_path));
    const sourceLabel = text(source.label) || path.basename(filePath) || "Watched MBOX";
    let sourceMatched = 0;
    let messageCount = 0;
    try {
      if (!fs.existsSync(filePath)) throw new HttpError(404, `Email watch path was not found: ${filePath}`);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new HttpError(400, "Email watch path must point to a local MBOX file.");
      const maxBytes = Number(process.env.EMAIL_TRACKER_MAX_BYTES || process.env.MBOX_IMPORT_MAX_BYTES || 1024 * 1024 * 1024);
      if (Number.isFinite(maxBytes) && stat.size > maxBytes) {
        throw new HttpError(413, `Email watch file is too large for this local import limit (${Math.round(maxBytes / 1024 / 1024)} MB).`);
      }
      const mboxText = fs.readFileSync(filePath, "utf8");
      await importMboxKnowledge(db, {
        mboxText,
        sourceLabel,
        defaultState: text(source.default_state),
        defaultAhj: text(source.default_ahj),
        defaultUtility: text(source.default_utility),
      });
      const classified = await classifyMboxMessages({
        mboxText,
        sourceLabel,
        defaultState: text(source.default_state),
        defaultAhj: text(source.default_ahj),
        defaultUtility: text(source.default_utility),
      });
      messageCount = classified.messages.length;
      result.messagesScanned += messageCount;

      for (const message of classified.messages) {
        if (message.record.type === "spam_irrelevant") continue;
        if (db.get<Row>("SELECT id FROM email_project_matches WHERE source_signature = ?", [message.sourceSignature])) {
          result.skippedDuplicates += 1;
          continue;
        }
        const match = matchProjectForEmail(db, message);
        if (!match) {
          result.unmatchedMessages += 1;
          continue;
        }

        const before = getProjectDetail(db, match.project.id);
        const targetId = firstPermitTargetId(db, match.project.id);
        const applicationNumber = extractTrackingNumber(message.rawSearchText, [/\b(?:application|app|record)\s*(?:number|#|no\.?)?\s*[:#-]?\s*([A-Z0-9-]{4,})/i]);
        const permitNumber = extractTrackingNumber(message.rawSearchText, [/\bpermit\s*(?:number|#|no\.?)?\s*[:#-]?\s*([A-Z0-9-]{4,})/i]);
        const updated = await recordPermitStatusCheck(db, match.project.id, {
          targetId,
          source: "email",
          rawStatusText: emailStatusText(message),
          applicationNumber,
          permitNumber,
        });
        const statusCheck = updated.permitStatusChecks[0] || null;
        const beforeCorrectionIds = new Set(before.corrections.map((item) => item.id));
        const newCorrection = updated.corrections.find((item) => !beforeCorrectionIds.has(item.id)) || null;
        const matchId = id();
        const ts = nowIso();
        db.run(
          `INSERT INTO email_project_matches
            (id, project_id, source_id, source_signature, source_label, email_bucket, workflow, confidence,
             match_reason, status_check_id, correction_id, subject, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            matchId,
            match.project.id,
            sourceId,
            message.sourceSignature,
            sourceLabel,
            message.record.type,
            message.record.workflow,
            match.confidence,
            match.reason,
            statusCheck?.id || null,
            newCorrection?.id || statusCheck?.correctionId || null,
            message.subject.slice(0, 240),
            message.record.occurredAt,
            ts,
          ],
        );
        const savedMatch = mapEmailProjectMatch(db.get<Row>("SELECT * FROM email_project_matches WHERE id = ?", [matchId])!);
        result.matches.push(savedMatch);
        result.projectMatches += 1;
        result.statusChecksCreated += statusCheck ? 1 : 0;
        const createdCorrection = Boolean(newCorrection || statusCheck?.correctionId);
        result.correctionsCreated += createdCorrection ? 1 : 0;
        sourceMatched += 1;
        addAuditLog(db, match.project.id, "system", "email tracker", "email.project_matched", {
          sourceLabel,
          bucket: message.record.type,
          workflow: message.record.workflow,
          confidence: match.confidence,
          reason: match.reason,
          statusCheckId: statusCheck?.id || null,
          correctionId: newCorrection?.id || statusCheck?.correctionId || null,
        });
      }
      if (sourceId) {
        db.run(
          `UPDATE email_tracking_sources
           SET last_checked_at = ?, last_message_count = ?, last_matched_count = ?, last_error = '', updated_at = ?
           WHERE id = ?`,
          [nowIso(), messageCount, sourceMatched, nowIso(), sourceId],
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown email tracker error.";
      result.sourceErrors.push(`${sourceLabel}: ${message}`);
      if (sourceId) {
        db.run("UPDATE email_tracking_sources SET last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?", [
          nowIso(),
          message,
          nowIso(),
          sourceId,
        ]);
      }
    }
  }

  return result;
}

export function getHistoricalFailureReport(db: AppDb, projectId: string): HistoricalFailureReport {
  const report = buildHistoricalFailureReport(db, projectId);
  addAuditLog(db, projectId, "system", "historical failure matcher", "historical_failures.generated", {
    matchedProjectCount: report.matchedProjectCount,
    matchedFailureRecordCount: report.matchedFailureRecordCount,
    dataConfidence: report.dataConfidence,
    checklistMissing: report.checklist.filter((item) => item.status === "missing").length,
  });
  return report;
}

export function runProjectWorkflow(db: AppDb, projectId: string): ProjectWorkflow {
  runQcForProject(db, projectId);
  const detail = getProjectDetail(db, projectId);
  const historicalReport = buildHistoricalFailureReport(db, projectId);
  const reviewerReport = buildReviewerReport(detail.project);
  const applicationDocs = buildApplicationDocumentPackage(detail.project);

  const qcFails = detail.qcResults.filter((item) => item.qcStatus === "fail").length;
  const qcWarnings = detail.qcResults.filter((item) => item.qcStatus === "warning").length;
  const pendingReview = detail.humanReviewItems.filter((item) => item.status === "pending" && item.fieldName !== "correction").length;
  const reviewerBlockers = reviewerReport.findings.filter((item) => item.severity === "blocker").length;
  const reviewerWarnings = reviewerReport.findings.filter((item) => item.severity === "warning").length;
  const historicalMissing = historicalReport.checklist.filter((item) => item.status === "missing").length;
  const learnedHistoricalBlockers = historicalReport.checklist.filter((item) => {
    const cause = historicalReport.topRejectionCauses.find((candidate) => candidate.signature === item.sourceCauseSignature);
    return item.status === "missing" && Boolean(cause && cause.count > 0 && cause.severity === "blocker");
  }).length;
  const docsMissing = applicationDocs.missingFields.length;
  const awaitingHumanSubmit = ["awaiting_human_submit", "submitted", "approved", "ready_for_issue", "issued", "complete"].includes(detail.project.status);

  const steps: ProjectWorkflow["steps"] = [
    {
      id: "intake",
      label: "Intake",
      status: detail.project.homeownerName && detail.project.projectAddress && detail.project.utility && detail.project.ahj ? "done" : "blocked",
      summary: detail.project.homeownerName && detail.project.projectAddress ? `${detail.project.homeownerName} at ${detail.project.projectAddress}` : "Project identity is incomplete.",
      action: detail.project.homeownerName && detail.project.projectAddress ? "Confirm the project, utility, AHJ, account, and meter are correct." : "Fix missing project identity fields in Human Review.",
    },
    {
      id: "history",
      label: "Historical Risk",
      status: learnedHistoricalBlockers ? "blocked" : historicalMissing ? "needs_review" : "done",
      summary: historicalReport.summaryLabel,
      action: historicalMissing ? "Clear the generated historical checklist before staging." : "No historical checklist gaps are blocking staging.",
    },
    {
      id: "qc",
      label: "QC",
      status: qcFails ? "blocked" : pendingReview || qcWarnings ? "needs_review" : "done",
      summary: `${qcFails} fail / ${qcWarnings} warning / ${pendingReview} pending human review.`,
      action: qcFails || pendingReview ? "Resolve QC failures and pending human review fields." : "QC is clear enough to continue.",
    },
    {
      id: "reviewer",
      label: "City Reviewer",
      status: reviewerBlockers ? "blocked" : reviewerWarnings ? "needs_review" : "done",
      summary: `${reviewerBlockers} blocker / ${reviewerWarnings} warning.`,
      action: reviewerBlockers ? "Send blocker comments to design/installer before submittal." : "Review warnings and installer callouts.",
    },
    {
      id: "docs",
      label: "AHJ/NEM Docs",
      status: docsMissing ? "blocked" : "done",
      summary: `${applicationDocs.profile.name}; ${applicationDocs.docs.length} generated document(s); ${docsMissing} missing field(s).`,
      action: docsMissing ? "Fill missing fields before using portal/application packets." : "Application and transfer worksheets are ready for human review.",
    },
    {
      id: "stage",
      label: "Stage Portal",
      status: awaitingHumanSubmit ? "done" : "ready",
      summary: awaitingHumanSubmit ? "Project has already reached staged/submitted status." : "Automation will stop at the final review page.",
      action: awaitingHumanSubmit ? "Continue permit monitoring and confirmation capture." : "When every step is clear, click Prepare Submittal.",
    },
  ];

  const blocking = steps.filter((step) => step.status === "blocked");
  const needsReview = steps.filter((step) => step.status === "needs_review");
  const canPrepareSubmission = !awaitingHumanSubmit && blocking.length === 0;
  const status: ProjectWorkflow["status"] = awaitingHumanSubmit
    ? "staged_or_submitted"
    : blocking.length
      ? "blocked"
      : needsReview.length
        ? "needs_review"
        : "ready_to_stage";
  const nextAction = blocking[0]?.action || needsReview[0]?.action || (awaitingHumanSubmit ? "Monitor AHJ/utility status and capture final confirmation." : "Prepare Submittal, then verify the portal preview manually.");

  const workflow: ProjectWorkflow = {
    projectId,
    generatedAt: nowIso(),
    status,
    nextAction,
    canPrepareSubmission,
    steps,
    historicalReport,
    reviewerReport,
    applicationDocs,
  };

  addAuditLog(db, projectId, "system", "workflow", "project.workflow_ran", {
    status,
    nextAction,
    canPrepareSubmission,
    blockedSteps: blocking.map((step) => step.id),
    needsReviewSteps: needsReview.map((step) => step.id),
  });

  return workflow;
}

export async function importKnowledgeFromMbox(
  db: AppDb,
  input: { mboxText: string; sourceLabel?: string; defaultState?: string; defaultAhj?: string; defaultUtility?: string },
): Promise<MboxKnowledgeImportResult> {
  const result = await importMboxKnowledge(db, input);
  addAuditLog(db, null, "system", "mbox importer", "knowledge_base.mbox_imported", {
    messagesScanned: result.messagesScanned,
    learningEvents: result.learningEvents,
    failureExamplesImported: result.failureExamplesImported,
    profilesTouched: result.profilesTouched,
    skippedMessages: result.skippedMessages,
    duplicateMessages: result.duplicateMessages,
    llmReviewRecommended: result.llmReviewRecommended,
    bucketCounts: result.bucketCounts,
  });
  return result;
}

export function getApplicationDocumentPackage(db: AppDb, projectId: string): ApplicationDocumentPackage {
  const detail = getProjectDetail(db, projectId);
  const pkg = buildApplicationDocumentPackage(detail.project);
  addAuditLog(db, projectId, "system", "application doc builder", "application_docs.generated", {
    profile: pkg.profile.id,
    docCount: pkg.docs.length,
    missingFields: pkg.missingFields,
  });
  return pkg;
}

export function getReviewerReport(db: AppDb, projectId: string): ReviewerReport {
  const detail = getProjectDetail(db, projectId);
  const report = buildReviewerReport(detail.project);
  addAuditLog(db, projectId, "system", "ahj reviewer gate", "reviewer_report.generated", {
    blockerCount: report.findings.filter((item) => item.severity === "blocker").length,
    warningCount: report.findings.filter((item) => item.severity === "warning").length,
    installerCalloutCount: report.installerCallouts.length,
    matchedProfile: report.matchedProcessProfile ? `${report.matchedProcessProfile.state}:${report.matchedProcessProfile.ahj}` : null,
  });
  return report;
}

export function getReviewerReportHtml(db: AppDb, projectId: string): string {
  const detail = getProjectDetail(db, projectId);
  const report = buildReviewerReport(detail.project);
  addAuditLog(db, projectId, "system", "ahj reviewer gate", "reviewer_report.html_opened", {
    blockerCount: report.findings.filter((item) => item.severity === "blocker").length,
    warningCount: report.findings.filter((item) => item.severity === "warning").length,
  });
  return renderReviewerReportHtml(detail.project, report);
}

export function rerunQc(db: AppDb, projectId: string): ProjectDetail {
  const result = runQcForProject(db, projectId);
  addAuditLog(db, projectId, "system", "qc gate", "project.qc_rerun", { ...result });
  return getProjectDetail(db, projectId);
}

export function addManualCorrection(db: AppDb, projectId: string, correctionText: string, source = "manual"): ProjectDetail {
  const detail = getProjectDetail(db, projectId);
  const classification = classifyCorrection(correctionText, detail.project);
  const correctionId = id();
  const ts = nowIso();

  db.transaction(() => {
    db.run(
      `INSERT INTO corrections (
        id, project_id, source, correction_text, correction_bucket, root_cause, required_action,
        assigned_to, draft_response, human_approved, resubmitted, new_rule_recommended, created_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        correctionId,
        projectId,
        source,
        correctionText,
        classification.bucket,
        classification.rootCause,
        classification.requiredAction,
        classification.assignedTo,
        classification.draftResponse,
        0,
        0,
        classification.newRuleRecommended ? 1 : 0,
        ts,
        null,
      ],
    );

    db.run(
      `INSERT INTO human_review_items
        (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id(),
        projectId,
        "Correction triage",
        "correction",
        "",
        classification.requiredAction,
        correctionText.slice(0, 800),
        "pending",
        `Bucket: ${classification.bucket}. ${classification.rootCause}`,
        ts,
        ts,
      ],
    );

    db.run("UPDATE projects SET status = ?, current_stage = ?, updated_at = ? WHERE id = ?", [
      "correction_triaged",
      `Correction triaged: ${classification.bucket}`,
      ts,
      projectId,
    ]);

    addAuditLog(db, projectId, "system", "correction classifier", "correction.created_and_classified", {
      correctionId,
      bucket: classification.bucket,
    });
    learnFromCorrection(db, detail.project, classification, correctionText, source);
  });

  touchProjectMetrics(db, projectId);
  return getProjectDetail(db, projectId);
}

export function listOverdueCorrections(db: AppDb): CorrectionRecord[] {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.query<Row>(
    `SELECT * FROM corrections
     WHERE closed_at IS NULL
       AND (
         due_at < ?
         OR (due_at IS NULL AND date(created_at, '+' || sla_days || ' days') < ?)
       )
     ORDER BY created_at ASC`,
    [today, today],
  );
  return rows.map(mapCorrection);
}

export function setCorrectionsSlaDays(db: AppDb, correctionId: string, slaDays: number): void {
  const ts = nowIso();
  db.run(
    `UPDATE corrections SET sla_days = ?, due_at = date(created_at, '+' || ? || ' days') WHERE id = ?`,
    [slaDays, slaDays, correctionId],
  );
}

export function createPermitCheckTarget(
  db: AppDb,
  projectId: string,
  input: {
    jurisdiction?: string;
    portalName?: string;
    portalUrl?: string;
    applicationNumber?: string;
    permitNumber?: string;
    checkFrequencyDays?: number;
    notes?: string;
    targetType?: "permit" | "nem";
  },
): ProjectDetail {
  const detail = getProjectDetail(db, projectId);
  const targetId = id();
  const ts = nowIso();
  const frequency = Math.max(1, Math.floor(Number(input.checkFrequencyDays || 7)));
  const targetType = input.targetType === "nem" ? "nem" : "permit";
  db.transaction(() => {
    db.run(
      `INSERT INTO permit_check_targets
        (id, project_id, jurisdiction, portal_name, portal_url, application_number, permit_number,
         check_frequency_days, active, last_checked_at, next_check_at, latest_outcome, latest_status_label,
         notes, target_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        targetId,
        projectId,
        input.jurisdiction || "",
        input.portalName || "",
        input.portalUrl || "",
        input.applicationNumber || "",
        input.permitNumber || "",
        frequency,
        1,
        null,
        nextCheckIso(frequency),
        null,
        "",
        input.notes || "",
        targetType,
        ts,
        ts,
      ],
    );
    addAuditLog(db, projectId, "system", "permit monitor", "permit_target.created", { targetId, targetType });
    learnFromPermitTarget(db, detail.project, input);
  });
  return getProjectDetail(db, projectId);
}

export async function recordPermitStatusCheck(
  db: AppDb,
  projectId: string,
  input: {
    targetId?: string | null;
    source?: PermitCheckSource;
    rawStatusText?: string;
    applicationNumber?: string;
    permitNumber?: string;
  },
): Promise<ProjectDetail> {
  const detail = getProjectDetail(db, projectId);
  const target = input.targetId
    ? db.get<Row>("SELECT * FROM permit_check_targets WHERE id = ? AND project_id = ?", [input.targetId, projectId])
    : null;
  if (input.targetId && !target) throw new HttpError(404, "Permit check target not found.");

  const source = input.source || "manual";
  const rawStatusText = await resolveStatusText(target, input.rawStatusText || "", source);
  const classification = classifyPermitStatusText(rawStatusText);
  const ts = nowIso();
  const checkId = id();
  let correctionId: string | null = null;

  db.transaction(() => {
    if (classification.outcome === "correction_flagged") {
      correctionId = insertMonitorCorrection(db, detail.project, rawStatusText, classification.message, ts, source === "email" ? "email" : "portal");
    } else if (classification.outcome === "needs_human_review") {
      db.run(
        `INSERT INTO human_review_items
          (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id(),
          projectId,
          "Permit monitor status review",
          "permit_status",
          rawStatusText.slice(0, 400),
          "",
          rawStatusText.slice(0, 800),
          "pending",
          classification.message,
          ts,
          ts,
        ],
      );
    }

    db.run(
      `INSERT INTO permit_status_checks
        (id, project_id, target_id, source, raw_status_text, status_label, outcome, confidence,
         correction_id, reviewed_by_ahj, ready_for_issue, issue_fee_due, application_number,
         permit_number, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        checkId,
        projectId,
        input.targetId || null,
        source,
        rawStatusText,
        classification.statusLabel,
        classification.outcome,
        classification.confidence,
        correctionId,
        classification.reviewedByAhj ? 1 : 0,
        classification.readyForIssue ? 1 : 0,
        classification.issueFeeDue ? 1 : 0,
        input.applicationNumber || text(target?.application_number) || "",
        input.permitNumber || text(target?.permit_number) || "",
        classification.message,
        ts,
      ],
    );

    if (target) {
      const frequency = Number(target.check_frequency_days ?? 7);
      db.run(
        `UPDATE permit_check_targets
         SET last_checked_at = ?, next_check_at = ?, latest_outcome = ?, latest_status_label = ?, updated_at = ?
         WHERE id = ?`,
        [ts, nextCheckIso(frequency, new Date(ts)), classification.outcome, classification.statusLabel, ts, input.targetId || null],
      );
    }

    updateProjectForPermitOutcome(db, detail.project.status, projectId, classification.outcome, classification.message, ts);
    addAuditLog(db, projectId, "system", "permit monitor", "permit_status.checked", {
      checkId,
      targetId: input.targetId || null,
      source,
      outcome: classification.outcome,
      statusLabel: classification.statusLabel,
      correctionId,
    });
    learnFromPermitStatus(
      db,
      detail.project,
      {
        id: checkId,
        projectId,
        targetId: input.targetId || null,
        source,
        rawStatusText,
        statusLabel: classification.statusLabel,
        outcome: classification.outcome,
        confidence: classification.confidence,
        correctionId,
        reviewedByAhj: classification.reviewedByAhj,
        readyForIssue: classification.readyForIssue,
        issueFeeDue: classification.issueFeeDue,
        applicationNumber: input.applicationNumber || text(target?.application_number) || "",
        permitNumber: input.permitNumber || text(target?.permit_number) || "",
        message: classification.message,
        createdAt: ts,
      },
      target
        ? {
            jurisdiction: text(target.jurisdiction),
            portalName: text(target.portal_name),
            portalUrl: text(target.portal_url),
            createdAt: text(target.created_at),
          }
        : null,
    );
  });

  return getProjectDetail(db, projectId);
}

async function resolveStatusText(target: Row | null, rawStatusText: string, source: PermitCheckSource): Promise<string> {
  const trimmed = rawStatusText.trim();
  if (trimmed) return trimmed;
  if (source === "mock") return "Application is under review. Plans assigned to reviewer.";

  if (source === "public_url" && target?.portal_url) {
    try {
      const res = await fetch(text(target.portal_url));
      const body = await res.text();
      return body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 8000);
    } catch (err) {
      return `Public URL check failed. ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  }

  return "No status text available. Manual AHJ/utility portal check required.";
}

function insertMonitorCorrection(db: AppDb, project: ProjectRecord, correctionText: string, monitorMessage: string, ts: string, source: CorrectionRecord["source"]): string {
  const classification = classifyCorrection(correctionText);
  const correctionId = id();
  db.run(
    `INSERT INTO corrections (
      id, project_id, source, correction_text, correction_bucket, root_cause, required_action,
      assigned_to, draft_response, human_approved, resubmitted, new_rule_recommended, created_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      correctionId,
      project.id,
      source,
      correctionText,
      classification.bucket,
      classification.rootCause,
      classification.requiredAction,
      classification.assignedTo,
      classification.draftResponse,
      0,
      0,
      classification.newRuleRecommended ? 1 : 0,
      ts,
      null,
    ],
  );

  db.run(
    `INSERT INTO human_review_items
      (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id(),
      project.id,
      "Permit correction bucket",
      "correction",
      "",
      classification.requiredAction,
      correctionText.slice(0, 800),
      "pending",
      `${monitorMessage} Bucket: ${classification.bucket}. ${classification.rootCause}`,
      ts,
      ts,
    ],
  );
  learnFromCorrection(db, project, classification, correctionText, source);
  return correctionId;
}

function updateProjectForPermitOutcome(
  db: AppDb,
  currentStatus: ProjectRecord["status"],
  projectId: string,
  outcome: PermitCheckOutcome,
  message: string,
  ts: string,
): void {
  const update = (status: ProjectRecord["status"], stage: string) => {
    db.run("UPDATE projects SET status = ?, current_stage = ?, updated_at = ? WHERE id = ?", [status, stage, ts, projectId]);
  };

  if (outcome === "correction_flagged") update("correction_received", "Permit monitor flagged a correction. Review bucket and next action.");
  else if (outcome === "ready_for_issue") update("ready_for_issue", message);
  else if (outcome === "issued") update("issued", message);
  else if (outcome === "reviewed_by_ahj") update("approved", message);
  else if (outcome === "waiting" && ["awaiting_human_submit", "submitted", "approved", "ready_for_issue", "issued", "complete"].includes(currentStatus)) {
    update("submitted", "Permit monitor checked: AHJ/utility review is still in progress.");
  } else if (outcome === "needs_human_review") {
    db.run("UPDATE projects SET current_stage = ?, updated_at = ? WHERE id = ?", [message, ts, projectId]);
  }
}

export async function runDuePermitChecks(
  db: AppDb,
  targetType: "permit" | "nem" | "all" = "all",
): Promise<{ checked: number; projects: ProjectDetail[] }> {
  const now = nowIso();
  const typeFilter = targetType === "all" ? "" : "AND target_type = ?";
  const params: string[] = targetType === "all" ? [now] : [now, targetType];
  const targets = db.query<Row>(
    `SELECT * FROM permit_check_targets
     WHERE active = 1 AND (next_check_at IS NULL OR next_check_at <= ?)
       ${typeFilter}
     ORDER BY next_check_at ASC, created_at ASC
     LIMIT 50`,
    params,
  );
  const projects: ProjectDetail[] = [];
  for (const target of targets) {
    const detail = await recordPermitStatusCheck(db, text(target.project_id), {
      targetId: text(target.id),
      source: text(target.portal_url) ? "public_url" : "mock",
    });
    touchProjectMetrics(db, text(target.project_id));
    projects.push(detail);
  }
  return { checked: targets.length, projects };
}

export async function prepareSubmission(db: AppDb, projectId: string): Promise<ProjectDetail> {
  const detail = getProjectDetail(db, projectId);
  const failCount = detail.qcResults.filter((result) => result.qcStatus === "fail").length;
  const pendingCount = detail.humanReviewItems.filter((item) => item.status === "pending" && item.fieldName !== "correction").length;
  const reviewerReport = buildReviewerReport(detail.project);
  const reviewerBlockers = reviewerReport.findings.filter((finding) => finding.severity === "blocker");
  const historicalReport = buildHistoricalFailureReport(db, projectId);
  const learnedHistoricalMissing = historicalReport.checklist.filter((item) => {
    const cause = historicalReport.topRejectionCauses.find((candidate) => candidate.signature === item.sourceCauseSignature);
    return item.status === "missing" && Boolean(cause && cause.count > 0 && cause.severity === "blocker");
  });
  if (failCount > 0 || pendingCount > 0 || reviewerBlockers.length > 0 || learnedHistoricalMissing.length > 0) {
    throw new HttpError(409, "Submission staging blocked until QC failures, required human review items, and AHJ reviewer gate blockers are resolved.", {
      failCount,
      pendingCount,
      reviewerBlockerCount: reviewerBlockers.length,
      reviewerBlockers: reviewerBlockers.slice(0, 8).map((finding) => finding.title),
      historicalMissingCount: learnedHistoricalMissing.length,
      historicalMissing: learnedHistoricalMissing.slice(0, 8).map((item) => item.title),
    });
  }

  const runId = id();
  const submissionId = id();
  const ts = nowIso();
  const files = filesFromProject(detail.project.parserSnapshot);

  // Resolve portal adapter. A project may pin a specific portal_profile_id in
  // its parser snapshot; otherwise fall back to any configured real portal
  // profile (accela_oregon for permits, powerclerk_pge for NEM), else mock.
  const snapshotProfileId = typeof detail.project.parserSnapshot?.["portal_profile_id"] === "string"
    ? detail.project.parserSnapshot["portal_profile_id"]
    : null;
  const portalProfile = snapshotProfileId
    ? (db.get("SELECT * FROM portal_profiles WHERE id = ?", [snapshotProfileId]) as { id?: string; portal_name?: string; portal_type?: string; encrypted_storage_state?: string } | undefined)
    : (db.get(
        "SELECT * FROM portal_profiles WHERE portal_type IN ('accela_oregon', 'powerclerk_pge') ORDER BY created_at DESC LIMIT 1"
      ) as { id?: string; portal_name?: string; portal_type?: string; encrypted_storage_state?: string } | undefined);
  const portalType = portalProfile?.portal_type ?? "mock";
  const isRealPortal = portalType !== "mock";
  const portalProfileId = portalProfile?.id ?? null;
  const portalLabel = isRealPortal
    ? (portalProfile?.portal_name || portalType)
    : "Mock portal";
  const adapterActorName = portalType === "accela_oregon"
    ? "OregonEPermittingAdapter"
    : portalType === "powerclerk_pge"
      ? "PowerClerkAdapter"
      : "MockPortalAdapter";
  const stageOptions = {
    encryptedStorageStatePath: portalProfile?.encrypted_storage_state ?? undefined,
    headless: false,
    reviewerReport,
  };

  // Overlay the linked client's contractor/licensing identity onto the project
  // snapshot the adapters read, so submissions use authoritative client data
  // (CCB#, electrical license, installer company) instead of hardcoded names.
  const overlay = clientStagingOverlay(db, detail.project.clientId, portalType);
  const stagedProject = Object.keys(overlay).length > 0
    ? { ...detail.project, parserSnapshot: { ...detail.project.parserSnapshot, ...overlay } }
    : detail.project;

  const result =
    portalType === "accela_oregon"
      ? await stageWithAccela(stagedProject, files, stageOptions)
      : portalType === "powerclerk_pge"
        ? await stageWithPowerClerk(stagedProject, files, stageOptions)
        : await stageWithMockPortal(stagedProject, files, reviewerReport);

  db.transaction(() => {
    db.run(
      `INSERT INTO portal_runs
        (id, project_id, portal_profile_id, run_type, status, started_at, finished_at, error_message,
         human_action_required, screenshots_path, logs_path, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, projectId, portalProfileId, "prepare_submit", "awaiting_human_submit", ts, nowIso(), "", 1, "", "", asJson(result)],
    );

    db.run(
      `INSERT INTO submissions
        (id, project_id, portal_profile_id, submission_type, status, application_number, permit_number,
         confirmation_number, submitted_at, submitted_by, screenshots_path, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        submissionId,
        projectId,
        portalProfileId,
        "permit",
        "awaiting_human_submit",
        "",
        "",
        "",
        null,
        "",
        "",
        `${portalLabel} staged to final review only. Automation did not click final submit.`,
        ts,
      ],
    );

    db.run("UPDATE projects SET status = ?, current_stage = ?, updated_at = ? WHERE id = ?", [
      "awaiting_human_submit",
      `${portalLabel} staged. Human must verify and submit manually.`,
      nowIso(),
      projectId,
    ]);

    addAuditLog(db, projectId, "portal_bot", adapterActorName, "portal.staged_to_review", {
      runId,
      portalProfileId,
      portalType,
      finalSubmitClickedByAutomation: false,
      mustShowAhjPreviewWindow: reviewerReport.finalSubmitGate.mustShowAhjPreviewWindow,
      finalSubmitButtonAloneIsEnough: reviewerReport.finalSubmitGate.finalSubmitButtonAloneIsEnough,
    });
  });

  return getProjectDetail(db, projectId);
}

function filesFromProject(payload: ParserPayload): string[] {
  const split = text(payload.splitPagesText);
  const checklist = text(payload.utilityDownloadChecklistText);
  return [split, checklist]
    .join("\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/not found|upload and parse/i.test(line))
    .slice(0, 20);
}

export function humanVerify(
  db: AppDb,
  projectId: string,
  input: { reviewItemId: string; action: "approve" | "edit" | "reject"; fieldValue?: string; notes?: string },
): ProjectDetail {
  const item = db.get<Row>("SELECT * FROM human_review_items WHERE id = ? AND project_id = ?", [input.reviewItemId, projectId]);
  if (!item) throw new HttpError(404, "Human review item not found.");
  const projectRow = db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!projectRow) throw new HttpError(404, "Project not found.");

  const status = input.action === "approve" ? "approved" : input.action === "edit" ? "edited" : "rejected";
  const fieldName = text(item.field_name);
  const oldPayload = parseJson<ParserPayload>(projectRow.parser_json, {});
  const value =
    input.fieldValue?.trim() ||
    (input.action === "approve" ? text(item.llm_suggested_value) || text(item.parser_value) : text(item.parser_value));

  db.transaction(() => {
    db.run("UPDATE human_review_items SET status = ?, notes = ?, updated_at = ? WHERE id = ?", [
      status,
      input.notes || text(item.notes),
      nowIso(),
      input.reviewItemId,
    ]);

    if (input.action !== "reject" && fieldName !== "correction") {
      applyVerifiedField(db, projectId, oldPayload, fieldName, value);
      db.run(
        `INSERT INTO extracted_fields
          (id, project_id, field_name, field_value, source_file_id, source_method, confidence, human_verified, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id(), projectId, fieldName, value, null, "human", 1, 1, input.notes || "Human verified from review queue.", nowIso()],
      );
    }

    addAuditLog(db, projectId, "human", "dashboard", "human_review.updated", {
      reviewItemId: input.reviewItemId,
      action: input.action,
      fieldName,
    });
  });

  if (fieldName !== "correction") {
    runQcForProject(db, projectId);
    learnFromProject(db, getProjectDetail(db, projectId).project, "human_review.updated");
  }
  return getProjectDetail(db, projectId);
}

function applyVerifiedField(db: AppDb, projectId: string, payload: ParserPayload, fieldName: string, value: string): void {
  const aliases = fieldAliases[fieldName] ?? [fieldName];
  payload[aliases[0]] = value;
  const numeric = Number.parseFloat(value.replace(/[^0-9.-]/g, ""));
  const numberValue = Number.isFinite(numeric) ? numeric : null;

  const columnUpdates: Record<string, [string, string | number | null]> = {
    homeownerName: ["homeowner_name", value],
    projectAddress: ["project_address", value],
    utility: ["utility", value],
    ahj: ["ahj", value],
    accountNumber: ["account_number", value],
    meterNumber: ["meter_number", value],
    systemSizeDcKw: ["system_size_dc_kw", numberValue],
    systemSizeAcKw: ["system_size_ac_kw", numberValue],
    totalExportKw: ["total_export_kw", numberValue],
    interconnectionMethod: ["interconnection_method", value],
  };

  const update = columnUpdates[fieldName];
  if (update) {
    db.run(`UPDATE projects SET ${update[0]} = ?, parser_json = ?, updated_at = ? WHERE id = ?`, [
      update[1],
      asJson(payload),
      nowIso(),
      projectId,
    ]);
    return;
  }

  db.run("UPDATE projects SET parser_json = ?, updated_at = ? WHERE id = ?", [asJson(payload), nowIso(), projectId]);
}

export function captureConfirmation(
  db: AppDb,
  portalRunId: string,
  input: {
    applicationNumber?: string;
    permitNumber?: string;
    confirmationNumber?: string;
    submittedBy?: string;
    notes?: string;
  },
): ProjectDetail {
  const run = db.get<Row>("SELECT * FROM portal_runs WHERE id = ?", [portalRunId]);
  if (!run) throw new HttpError(404, "Portal run not found.");
  const projectId = text(run.project_id);
  const ts = nowIso();

  db.transaction(() => {
    db.run("UPDATE portal_runs SET status = ?, finished_at = ? WHERE id = ?", ["submitted", ts, portalRunId]);
    db.run(
      `UPDATE submissions
       SET status = ?, application_number = ?, permit_number = ?, confirmation_number = ?, submitted_at = ?, submitted_by = ?, notes = ?
       WHERE project_id = ? AND status = 'awaiting_human_submit'`,
      [
        "submitted",
        input.applicationNumber || "",
        input.permitNumber || "",
        input.confirmationNumber || "",
        ts,
        input.submittedBy || "human",
        input.notes || "Captured after human completed final portal submit.",
        projectId,
      ],
    );
    db.run("UPDATE projects SET status = ?, current_stage = ?, updated_at = ? WHERE id = ?", [
      "submitted",
      "Human submitted. Confirmation captured.",
      ts,
      projectId,
    ]);
    addAuditLog(db, projectId, "human", input.submittedBy || "dashboard", "submission.confirmation_captured", {
      portalRunId,
      applicationNumber: input.applicationNumber || "",
      permitNumber: input.permitNumber || "",
      confirmationNumber: input.confirmationNumber || "",
    });
  });

  const detail = getProjectDetail(db, projectId);
  learnFromSubmissionConfirmation(db, detail.project, input);
  return getProjectDetail(db, projectId);
}
