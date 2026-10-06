import type {
  ApplicationDocumentPackage,
  AuditLog,
  CorrectionReadingOrigin,
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
  PortalRecipe,
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
  ProjectStatus,
  ProjectWorkflow,
  QcResult,
  ReviewerFinding,
  ReviewerReport,
  StageDetail,
  SubmissionRecord,
  SubmitGateCheck,
  SubmitGateReport,
  SubmittalTrack,
  SubmittalTrackType,
} from "../../shared/src/types";
import { correctionFilingStamp, correctionOverdueSql, touchProjectMetrics, type CorrectionFilingInput } from "./kpi";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkStatusWithAdapter, runCorrectionReopen, stageWithAccela, stageWithMockPortal, stageWithPowerClerk, stageWithRecipe } from "../../portal-bot/src/index";
import { portalAutomationDisabled, resolveHeadless } from "../../portal-bot/src/browser";
import { findCompleteRecipeForProject, findAnyRecipeForProject, resolveRecipeFieldValues, markPortalRecipeForRerecord, demoteOnReplayFailure, collectHealedSteps, persistHealedSteps, getPortalRecipe, portalEntityEvidence, recipeHostFit, findBorrowableRecipe, replayFailureBlamesRecipe, recipeStepsSignature, isNotServedRecipe, recordPortalNotServed, type BorrowedRecipeChoice } from "./portalRecipes";
import { notServedInResult } from "../../shared/src/portalNotServed";
import { notifyClientOfStatusChange, shouldNotifyClient } from "./clientNotifier";
// detectPlatform moved with the target INSERT into submittalTracks.ts's ensureCheckTarget.
import { publicPermitStatusCheck } from "./publicPermitStatus";
import { planSetTextForProject, projectDocsByType, DOCS_DIR, PLAN_TEXT_DOC_TYPES } from "./projectDocuments";
import type { DesignTextSource } from "./designCriteria";
import { describeCited, lookedUpRecordType, issuingAgencyFor, permitAnswerForTrack, stateRulesFor, isStatewidePortalUrl, permitProcessKey, projectForTrack, refuseTrackIssuerValue, trackIssuer } from "./permitProcess";
import { statewideDecisionFor, statewideUrlRefusal } from "./statewideEvidence";
import { RESEARCH_UNCONFIRMED_REASON, researchNamedPlatform, researchSaysPortalUnconfirmed, researchWithFittedUrl } from "./researchedPortalUrl";
import { bindRecipeForReplay, describeReplayBinding, openPerJobQuestions } from "./recipeReplayBinding";
import { agencyListStatusResolver, documentInventory, missingFilledAtStaging, owedDocumentAction, owedMissingDocuments, requiredListCheck, type DocumentInventory, type DocPresence } from "./requiredDocuments";
import { startedAtLabel, type StageAcquiredForm } from "./formAcquisitionPlan";
import { agencyListReplacesLine, issuingAgencyDocumentList } from "./applicationDocsAgency";
import { STAGE_COUNT, stageForStatus, isBlockedProject } from "./projectStage";
// Static cycle (nextStep imports repository), used at CALL time only on both sides — the same
// shape as correctionAgent. getProjectList needs the rule table synchronously.
import { compactNextStep, decideNextStep, loadNextStepFacts, withoutCodeResearch } from "./nextStep";
import { correctionHoldScope, criticalFieldHoldScope, findingHoldScope, GATE_TRACKS, scopeHoldsTrack, tracksHeld, type GateHoldScope } from "./gateScope";
import { addAuditLog } from "./audit";
import { clientLicenceRow, clientStagingOverlay, contractorLicenceForState, getClient } from "./clients";
import { planSetLicenceWarning } from "./clientMatch";
import { assertSubmissionPaid } from "./submissionFees";
import { readAndRecordPortalFees } from "./portalFeeReadings";
import { getDecryptedCredential, getDecryptedCredentialByUrl, getDecryptedCredentialAny, listPortalCredentials, lockedOutCredential } from "./portalCredentials";
import { annotateDraft, buildDraftTouch, recordDraftTouch } from "./draftLedger";
import { logger } from "./logger";
import { selectAdapterActor, selectStagingActor, learnEntryUrl, resolvePortalChannel, seedOutcomeToStageResult, isAutoSeedDisabled, recipeDisciplineFromSteps, disciplineConflictsWithTrack, recipeDisciplineForTrack, hostFitsTrackAndEntity, scopeForTrack, trackSafeUrl, portalHostOf, type HostFit, type PortalUrlSource } from "./portalChannel";
import { isPortalPaused } from "./portalPause";
// The ONE creator of permit_check_targets rows (extracted from markTrackSubmitted).
// Direction matters: submittalTracks must never import repository — jobQueue statically
// imports repository, and the circular-import guard in CLAUDE.md is about that edge.
import { ensureCheckTarget, refuseUtilityUrlOnPermitTarget, getSubmittalTracks, isTrackDone, requiredTracks, SUBMITTAL_TRACK_TYPES, trackHasFiling, trackPermitTypes, unfinishedTracks, unfinishedUnattributedTargets } from "./submittalTracks";
import { recordTimelineSample, trackForTarget } from "./timelineSamples";
import { buildApplicationDocumentPackage, findApplicationProfile } from "./applicationDocs";
import { ensurePlanSetSplit } from "./docSplitter";
import { classifyCorrection, humanizeBucket, humanizeEnum } from "./corrections";
import { extractCorrectionFromPage } from "./correctionExtract";
import { parseCorrectionProposals, attachJurisdictionProposals } from "./correctionAgent";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { HttpError } from "./httpError";
import { buildHistoricalFailureReport } from "./historicalFailures";
import { id } from "./ids";
import { asJson, bool, parseJson, text } from "./json";
import {
  learnFromCorrection,
  learnFromPermitStatus,
  learnFromPermitTarget,
  learnFromProject,
  learnFromSubmissionConfirmation,
  rebuildKnowledgeRollup,
  relearnCorrection,
  findLearnedProfileForProject,
  findKnowledgeForLearn,
  knowledgeResearchHint,
  saveResearchedAhjProfile,
  saveResearchedUtilityProfile,
  listKnowledgeProfiles,
  importMboxKnowledge,
  importMboxKnowledgeFromFile,
  classifyMboxMessages,
  isVerifiedKnowledge,
  type ClassifiedMboxMessage,
} from "./knowledgeBase";
import { compactAlnum, existingSystemFromSnapshot, fieldAliases, normalizeProject, normalizeTokens, staleDerivedKeys, TRACK_ISSUER_SNAPSHOT_KEYS, withTrackIssuers } from "./normalize";
import {
  classificationDrift, classifyPermitStatusText, effectiveCheckDays, extractStatusDate, isAuthWallText, isNemApprovalOutcome, nextCheckIso, outcomeTrack, portalStatedStatus,
  readingMayFinishTrack, shouldRecordStatusCheck, trackKind, UNCONFIRMED_READING_LABEL,
  type PermitStatusClassification, type ReadingProvenance, type TrackKind,
} from "./permitMonitor";
import { evidenceForTopic, evidenceLines, type EvidenceTopic } from "./projectEvidence";
import { customerBillOnFile, runQcForProject, WAITING_ON_BILL_ISSUE_TYPE, type QcRunOptions } from "./qc";
import { loadStoredTemplates, formAllowedForPath } from "./ahjForms";
import { submissionDocumentsByType, uploadDocumentGuard } from "./submissionDocuments";
import { disciplineFor } from "./docDiscipline";
import { resolvePermitPath, usStateCode } from "./permitPath";
import { bcd5952FailedRows } from "./bcdChecklistFacts";
import { buildReviewerReport, renderReviewerReportHtml } from "./reviewerEngine";
import type { PvWorksheetGateInput } from "./pvWorksheetGate";
import { resolveEffectiveCodeContext, ensureCodeProfilesResearched, ownCodeProfileRow, resolvePermitPathForProject, recordApprovedDesignObservation, isStructuralPermitTrack } from "./codeProfiles";
import { applyCachedVisionVerdicts } from "./reviewerVision";
import { nowIso } from "./time";
import { isHarnessAbort, looksBotBlocked } from "./runAbort";
import { finalSubmitEnvAllows, recipeShapeProblems } from "../../shared/src/portalSafety";

// THE ONE SEAM A TEST MAY STUB: the recipe-replay launcher prepareSubmission calls. Everything
// around it — the gates, the run row, the outcome, the demotion, the heal write, the approval —
// runs for real; only the browser is replaced. Refuses unless the process opted in explicitly,
// so no production path can swap the thing that drives a live portal.
type RecipeStageRunner = typeof stageWithRecipe;
let recipeStageRunner: RecipeStageRunner = stageWithRecipe;
export function setRecipeStageRunnerForTests(runner: RecipeStageRunner | null): void {
  if (process.env.AUTOPILOT_TEST_SEAMS !== "1") throw new Error("setRecipeStageRunnerForTests needs AUTOPILOT_TEST_SEAMS=1 — it is a test seam only.");
  recipeStageRunner = runner ?? stageWithRecipe;
}

// THE STATUS MONITOR'S TWO DOORS TO THE OUTSIDE — the authenticated scrape (a browser) and the
// public fetch (the network) — behind the same kind of seam, so the sweep's own resolution (which
// recipe, which URL, the track/entity judgment) runs for real in a test with nothing opened.
type StatusCheckSeams = { checkStatus?: typeof checkStatusWithAdapter | null; publicCheck?: typeof publicPermitStatusCheck | null };
let statusCheckSeams: StatusCheckSeams = {};
export function setStatusCheckSeamsForTests(seams: StatusCheckSeams | null): void {
  if (process.env.AUTOPILOT_TEST_SEAMS !== "1") throw new Error("setStatusCheckSeamsForTests needs AUTOPILOT_TEST_SEAMS=1 — it is a test seam only.");
  statusCheckSeams = seams ?? {};
}
const statusScrape: typeof checkStatusWithAdapter = (...args) => (statusCheckSeams.checkStatus ?? checkStatusWithAdapter)(...args);
const publicStatusFetch: typeof publicPermitStatusCheck = (...args) => (statusCheckSeams.publicCheck ?? publicPermitStatusCheck)(...args);

// THE FAILURE TEXT LIVES ON THE FAILING STEP, NOT THE SUMMARY. stageWithRecipe's failure
// result carries no top-level message - "Recipe step failed (fill - inverter quantity)" rides
// in steps[].message - so anything testing result.message alone is dead code for step
// failures. Read both, always, through ONE reader so a second caller cannot re-learn this.
function stageFailureText(result: unknown): string {
  const r = (result ?? {}) as { message?: unknown; steps?: Array<{ message?: unknown }> };
  return [
    typeof r.message === "string" ? r.message : "",
    ...(Array.isArray(r.steps) ? r.steps.map((s) => (typeof s?.message === "string" ? s.message : "")) : []),
  ].filter(Boolean).join(" | ");
}

// Reviewer report with the jurisdiction's adopted-codes context resolved from the DB.
// Single chokepoint so every internal caller reviews against the same per-AHJ data
// (Oregon resolves to the verified seed profile — identical behavior to the legacy
// constants; other jurisdictions get their recorded limits/citations or model-code
// defaults with "verify locally" phrasing).
export function buildReviewerReportFor(db: AppDb, project: ProjectRecord): ReviewerReport {
  let codeContext = resolveEffectiveCodeContext(db, project.state, project.ahj);
  // AUTONOMY: the internal gate self-onboards too — reviewing a project in an
  // un-profiled jurisdiction queues background code research for its layers. What it just queued
  // is read back, so this very report says "lookup in progress", not "not on file".
  if (!codeContext.verified && ensureCodeProfilesResearched(db, project.state, project.ahj) > 0) {
    codeContext = resolveEffectiveCodeContext(db, project.state, project.ahj);
  }
  // The reviewer's plan-set requirement is about whether the package EXISTS; give it the
  // attached document types so it cannot block a project that has them.
  const uploadedDocTypes = Object.keys(projectDocsByType(db, project.id));
  // The AHJ's OWN code-profile row (not the merged context, whose confidence is the weaker of the
  // AHJ and state layers): reviewer.profile.missing names its status as a separate record (#217).
  let codeProfileRow: { ahj: string; confidence: "seeded" | "verified" } | null = null;
  try { const own = ownCodeProfileRow(db, project.state, project.ahj); codeProfileRow = own ? { ahj: own.profile.ahj, confidence: own.profile.confidence } : null; } catch { codeProfileRow = null; }
  return buildReviewerReport(project, { codeContext, codeProfileRow, uploadedDocTypes, documentTexts: designDocumentTexts(db, project.id), pvWorksheet: filedPvWorksheetInput(db, project) });
}

// WHAT HOLDS THIS FILING: ONE ANSWER (#214). The text report with the cached vision verdicts folded
// in. It makes no model call and renders no PDF; it only reads reviewer_vision_cache, so a read path
// stays read-only.
//
// Owner ruling 2026-10-05 (#214 "yes"): a cached vision verdict that relaxed a finding relaxes it on
// EVERY path. That means the submit gate, the correction notice, staging (prepareSubmission), Approve
// and next-step (nextStep.reviewerBlockerList, then runAutopilotApproval), the re-judges, the
// printable packet and the page load. Before this, the gate and the notice applied cached verdicts
// and staging and Approve did not. A live Utah project showed 2 holds on the gate while 3 blockers
// refused staging.
//
// The vision rules are unchanged (reviewerVision.applyVerdict): it only relaxes, only on a
// high/medium-confidence "present" verdict, never a measured finding, and the finding stays visible
// as a callout. Rule 1 is untouched: this decides which reviewer findings are blockers, before a named
// person approves a run.
//
// buildReviewerReportFor stays exported for two readers only: the full vision pass, which must start
// from the TEXT report, and tests that pin the text rules. Every gate consumer reads this function.
// reviewerSeverityParity.test.ts fails if a production caller reaches the raw builder.
export function reviewerGateReportFor(db: AppDb, project: ProjectRecord): ReviewerReport {
  return applyCachedVisionVerdicts(db, buildReviewerReportFor(db, project));
}

/** The newest filed PV worksheet read by position (project_documents.form_reading_json, written
 *  at text extraction), with its upload time against the newest plan set's. undefined = none. */
function filedPvWorksheetInput(db: AppDb, project: ProjectRecord): PvWorksheetGateInput | undefined {
  try {
    const ws = db.get<Row>(
      "SELECT form_reading_json, uploaded_at FROM project_documents WHERE project_id = ? AND form_reading_json != '' ORDER BY uploaded_at DESC LIMIT 1",
      [project.id],
    );
    if (!ws) return undefined;
    const plan = db.get<Row>(
      "SELECT MAX(uploaded_at) AS at FROM project_documents WHERE project_id = ? AND doc_type IN ('plan_set','combined_plan_set','full_plan_set','plan','plan_pdf','sld') AND COALESCE(source,'') != 'split'",
      [project.id],
    );
    return {
      reading: JSON.parse(text(ws.form_reading_json)) as PvWorksheetGateInput["reading"],
      worksheetUploadedAt: text(ws.uploaded_at),
      newestPlanUploadedAt: text(plan?.at),
      planText: String(project.parserSnapshot?.planSetExtractedText ?? ""),
    };
  } catch {
    return undefined;
  }
}

// What each stored DOCUMENT says, one source per document — so a design-criteria conflict is
// "plan set vs structural letter", two documents, and never the merged blob against itself.
// Newest per doc_type (the same rule as planSetTextForProject). Pages the splitter cut OUT of
// the plan set (source 'split') are the plan set, not a second document agreeing or
// disagreeing with it. Labelled by doc_type, never by filename (filenames carry names).
const DESIGN_DOC_LABELS: Record<string, string> = {
  plan_set: "Plan set", stamped_plans: "Stamped plan set", structural_letter: "Structural letter",
  engineering_letter: "Engineering letter", structural: "Structural sheets", electrical: "Electrical sheets",
  sld: "Single-line diagram", site_plan: "Site plan", labels: "Labels sheet",
  module_spec: "Module spec sheet", inverter_spec: "Inverter spec sheet",
};
function designDocumentTexts(db: AppDb, projectId: string): DesignTextSource[] {
  const out: DesignTextSource[] = [];
  const seen = new Set<string>();
  for (const row of db.query<Row>(
    "SELECT doc_type, source, extracted_text FROM project_documents WHERE project_id = ? ORDER BY uploaded_at DESC",
    [projectId],
  )) {
    const docType = text(row.doc_type);
    if (!PLAN_TEXT_DOC_TYPES.has(docType) || seen.has(docType)) continue;
    // A split page (the plan set's own sheet) or a row with no text never CLAIMS its doc type:
    // a newer split "structural" page must not hide an older uploaded structural calculation.
    const body = text(row.extracted_text);
    if (text(row.source) === "split" || !body.trim() || body === "[no text layer]") continue;
    seen.add(docType);
    out.push({ label: DESIGN_DOC_LABELS[docType] ?? docType, text: body });
  }
  return out;
}


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



function mapProject(row: ProjectRow): ProjectRecord {
  const parserSnapshot = parseJson<ParserPayload>(row.parser_json, {});
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
    // The v17 per-job answer columns (ownership/financing, behind-the-meter vs community
    // solar, disconnect-within-10ft). resolveRecipeFieldValues reads the columns directly
    // by project.id as a fallback, but the RECORD field wins when present — mapping them
    // here is what makes an in-memory ProjectRecord self-contained instead of correct-only-
    // when-a-DB-is-in-reach (the binding test pins record-beats-column precedence).
    ownershipModel: (row as Record<string, unknown>).ownership_model as string || "",
    systemConfiguration: (row as Record<string, unknown>).system_configuration as string || "",
    disconnectWithin10ft: (row as Record<string, unknown>).disconnect_within_10ft as string || "",
    systemSizeDcKw: row.system_size_dc_kw,
    systemSizeAcKw: row.system_size_ac_kw,
    totalExportKw: row.total_export_kw,
    interconnectionMethod: row.interconnection_method,
    status: row.status,
    currentStage: row.current_stage,
    // THE SUB-STAGE, SHIPPED FROM ONE PLACE. getProjectList and getProjectDetail both build
    // their project through mapProject, so mapping it here puts stage_detail on the board
    // payload and the detail payload at once — there is no second site to forget. Read via the
    // ownership_model cast precedent rather than a new required ProjectRow field, so row
    // literals elsewhere keep compiling. Always a string: "" is the honest unknown that
    // renderers must draw as nothing, and `undefined` on the wire would mean the same thing
    // twice.
    stageDetail: ((row as Record<string, unknown>).stage_detail as StageDetail) || "",
    parserConfidenceSummary: row.parser_confidence_summary,
    parserSnapshot,
    existingSystem: existingSystemFromSnapshot(parserSnapshot),
    // ARCHIVE STATE TRAVELS WITH THE RECORD (v-archive columns, `SELECT *` above).
    // It was stored and never mapped, so nothing built on a ProjectRecord could
    // tell a retired job from a live one: submissionFees quoted the superseded
    // Fixture pass at $274.43 exactly as it quotes its certified twin. Mapping it
    // does NOT hide anything — projectArchive.ts is explicit that operator
    // surfaces keep showing archived work — it only makes the fact sayable.
    archivedAt: text((row as Record<string, unknown>).archived_at),
    archivedReason: text((row as Record<string, unknown>).archived_reason),
    // THE OPERATOR'S PER-TRACK ISSUER (split issuer): flat snapshot keys, mapped here so every
    // ProjectRecord carries it; no key at all when none is set. Read only via permitProcess.trackIssuer.
    ...withTrackIssuers(parserSnapshot),
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

export function mapCorrection(row: Row): CorrectionRecord {
  const createdAt = text(row.created_at);
  const closedAt = row.closed_at == null ? null : text(row.closed_at);
  const slaDays = Number(row.sla_days ?? 5);
  const dueAt = row.due_at == null
    ? (() => {
        const d = new Date(row.noticed_at == null ? createdAt : text(row.noticed_at));
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
    sourceText: text(row.source_text),
    // Derived, not stored: the text was read off a page (source_text set) and either IS that page
    // (nothing was found to extract) or is what was extracted from it.
    extraction: !text(row.source_text).trim()
      ? "not_extracted"
      : text(row.correction_text).trim() === text(row.source_text).trim() ? "whole_text" : "items",
    track: text(row.track) as CorrectionRecord["track"],
    submissionId: row.submission_id == null ? null : text(row.submission_id),
    noticeId: text(row.notice_id) || text(row.id),
    noticedAt: row.noticed_at == null ? null : text(row.noticed_at),
    bucketLabel: humanizeBucket(text(row.correction_bucket)),
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
    // The cadence the monitor really uses (an open filing is read daily — effectiveCheckDays).
    checkFrequencyDays: effectiveCheckDays(row.check_frequency_days, row.latest_outcome == null ? null : text(row.latest_outcome)),
    active: bool(row.active),
    lastCheckedAt: row.last_checked_at == null ? null : text(row.last_checked_at),
    nextCheckAt: row.next_check_at == null ? null : text(row.next_check_at),
    latestOutcome: row.latest_outcome == null ? null : (text(row.latest_outcome) as PermitCheckOutcome),
    latestStatusLabel: text(row.latest_status_label),
    notes: text(row.notes),
    // ONE answer to "what track is this target": trackKind, so a legacy row (blank or 'permit'
    // target_type beside permit_type 'nem') is the NEM filing the writer already judges it as.
    targetType: trackKind(text(row.target_type), text(row.permit_type)),
    // WHICH permit this track is ('building' | 'electrical' | 'combo' | 'nem'). Carried because
    // both client-facing surfaces name the trade from it; without it a project with separate
    // structural and electrical permits shows two identical rows.
    permitType: text(row.permit_type),
    portalPlatform: text(row.portal_platform),
    trackingUrl: row.tracking_url ? text(row.tracking_url) : undefined,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapPermitStatusCheck(row: Row): PermitStatusCheck {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    targetId: row.target_id == null ? null : text(row.target_id),
    // The joined target's kind by trackKind (the ONE answer — `t.target_type, t.permit_type` in
    // the SELECT); blank when the check has no target, which hasNemSignal then word-sniffs.
    targetType: row.target_type == null && row.permit_type == null ? "" : trackKind(text(row.target_type), text(row.permit_type)),
    source: text(row.source) as PermitCheckSource,
    rawStatusText: text(row.raw_status_text),
    // The portal record's own status words, verbatim (a reading of the portal, not of an email).
    portalStatedStatus: ["portal", "public_url", "manual"].includes(text(row.source)) ? portalStatedStatus(text(row.raw_status_text)) : "",
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
    pauseReason: row.pause_reason ? text(row.pause_reason) : undefined,
    confirmationNumber: row.confirmation_number ? text(row.confirmation_number) : undefined,
    trackingUrl: row.tracking_url ? text(row.tracking_url) : undefined,
    // The track this run staged. Carried so the project screen can name the portal the operator
    // still has to file in — `nem` points at the utility, anything else at the AHJ. See the
    // field's note in shared/src/types.ts for why result_json is not a usable source.
    permitType: row.permit_type ? text(row.permit_type) : undefined,
  };
}

function mapSubmission(row: Row): SubmissionRecord {
  return {
    id: text(row.id),
    projectId: text(row.project_id),
    portalProfileId: row.portal_profile_id == null ? null : text(row.portal_profile_id),
    submissionType: text(row.submission_type) as SubmissionRecord["submissionType"],
    permitType: text(row.permit_type),
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

// ONE BROWSER PROFILE PER PORTAL, NOT PER PORTAL TYPE.
//
// Profiles were scoped `profileBase/clientId/portalType`, so EVERY utility portal for a client
// shared one session store. PowerClerk allows one session per account, so a filing to Ameren
// that followed one to PacifiCorp inherited PacifiCorp's login and drove Ameren's form against
// the wrong account's state: measured on the replay benchmark, Ameren scored 2 of 75 steps
// that way and 73 of 75 with its own profile. The fleet figure moved 74.7% -> 95.2% on the
// same build from this alone. Identical inputs, different outcome depending on what ran
// before — which is the "it just has an issue with that portal sometimes" an operator sees.
//
// The host is the natural key: it is what the session actually belongs to.
//
// MIGRATION: the first run against each portal after this change starts from an EMPTY profile
// and must log in again. That is deliberate — copying the old shared profile forward would
// carry the very cookies this separates. A portal with MFA will pause for a human on that
// first run, which is the designed behaviour, not a failure.
function portalProfileDir(profileBase: string, clientId: string | null, portalType: string, portalUrl?: string): string {
  let host = "";
  try { host = portalUrl ? new URL(portalUrl).hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, "_") : ""; }
  catch { host = ""; }
  const parts = clientId ? [profileBase, clientId, portalType] : [profileBase, portalType];
  if (host) parts.push(host);
  return path.join(...parts);
}

export function createProject(
  db: AppDb,
  payload: ParserPayload,
  orgId: string = DEFAULT_ORG_ID,
  /** learningExcluded: a demo / benchmark / fixture project that must never teach the SHARED
   *  knowledge base (L3). Written in the INSERT, so even the birth learn below skips it. */
  options: { learningExcluded?: boolean } = {},
): ProjectDetail {
  const project = normalizeProject(id(), payload);
  db.transaction(() => {
    db.run(
      `INSERT INTO projects (
        id, client_id, homeowner_name, project_address, city, state, zip, ahj, utility,
        account_number, meter_number, system_size_dc_kw, system_size_ac_kw, total_export_kw,
        interconnection_method, status, current_stage, stage_detail, parser_confidence_summary, parser_json,
        created_at, updated_at, org_id, learning_excluded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        // A project is born parsed with QC still to run — which is literally the next statement
        // in this function, so this value usually lives for milliseconds. Written anyway: if QC
        // throws, the row says what is true rather than nothing at all.
        "awaiting_qc" satisfies StageDetail,
        project.parserConfidenceSummary,
        asJson(project.parserSnapshot),
        project.createdAt,
        project.updatedAt,
        orgId,
        options.learningExcluded ? 1 : 0,
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
  // LIVE STAGING IS OPT-IN, NOT THE DEFAULT (AUTOPILOT_AUTO_START=1 to enable).
  //
  // This used to enqueue autopilot Segment A on every new project unless the env var was "0".
  // Segment A opens a LIVE portal browser under the operator's credentials — and the operator's
  // stated contract (autoStageSteps.ts header, 2026-09-21) is the opposite: the local chain
  // (split, bill read, QC, forms, docs, reviewer gate) runs itself and stops at ready_to_stage,
  // and staging a portal is a person's action. Production showed unattended live portal runs
  // on projects nobody clicked Stage on. The stage_step chain the parser route enqueues now does
  // all the local work, so Segment A adds nothing before a human decides to stage. Opt in only
  // where unattended staging is actually wanted. Dynamic import per the repository<->jobQueue
  // circular-import guard; enqueueJob self-kicks.
  if (process.env.AUTOPILOT_AUTO_START === "1") {
    void import("./jobQueue")
      // maxRetries 0: staging is not idempotent portal-side; failures escalate
      // and the event-driven auto-resume path handles recovery.
      // origin "auto_start": the chain's root says no person started it (autopilot.ts reads it
      // before any resume, and refuses an auto-started chain once the opt-in is withdrawn).
      .then(({ enqueueJob }) => { enqueueJob(db, "autopilot", { origin: "auto_start" }, { projectId: project.id, priority: 6, maxRetries: 0 }); })
      .catch(() => null);
  }
  return getProjectDetail(db, project.id);
}

// Onboard an unknown AHJ: research its residential-solar permitting requirements
// with the LLM, then save them as a knowledge-base profile so the jurisdiction is
// known next time. Advisory — flagged for human verification. Returns the research
// + the saved profile key (or a stub result when no API key is configured).
export async function researchAndSaveAhj(
  db: AppDb,
  input: { ahj: string; state: string; utility?: string },
): Promise<{ research: import("../../shared/src/types").AhjResearchResult; profileKey: string | null; saved: boolean }> {
  if (!input.ahj?.trim()) throw new HttpError(400, "ahj is required.");
  const { createLLMProvider } = await import("./llm");
  const llm = createLLMProvider();
  // Seed the research with what the KB already knows (imported reference rows) —
  // fuzzy-matched, so "Elmore County, ID" benefits from an imported "Elmore County".
  let hint: string | undefined;
  try { hint = knowledgeResearchHint(db, { state: input.state, ahj: input.ahj }, "ahj")?.text; } catch { /* non-fatal */ }
  const research = await llm.researchAhjRequirements({ ahj: input.ahj.trim(), state: (input.state || "").trim(), utility: input.utility?.trim(), knownContext: hint });
  if (research.provider === "stub" || !research.requiredDocuments.length) {
    return { research, profileKey: null, saved: false };
  }
  const profile = saveResearchedAhjProfile(db, { ahj: input.ahj.trim(), state: (input.state || "").trim(), utility: input.utility?.trim() },
    researchWithFittedUrl(db, "permit", { state: input.state, name: input.ahj }, research));
  return { research, profileKey: profile.profileKey, saved: true };
}

// Onboard an unknown UTILITY: research its residential NEM/interconnection process
// with the LLM, then save it as a utility-scoped KB profile so the utility is known
// next time — the same teach-once flow used for AHJs. Advisory — flagged for human
// verification. Returns the research + saved profile key (stub when no API key).
export async function researchAndSaveUtility(
  db: AppDb,
  input: { utility: string; state: string; ahj?: string },
): Promise<{ research: import("../../shared/src/types").UtilityResearchResult; profileKey: string | null; saved: boolean }> {
  if (!input.utility?.trim()) throw new HttpError(400, "utility is required.");
  const { createLLMProvider } = await import("./llm");
  const llm = createLLMProvider();
  // Same KB seeding as the AHJ path — the imported utility NEM notes (submit
  // instructions, disconnect/meter rules) anchor the web research.
  let hint: string | undefined;
  try { hint = knowledgeResearchHint(db, { state: input.state, utility: input.utility }, "utility")?.text; } catch { /* non-fatal */ }
  const research = await llm.researchUtilityRequirements({ utility: input.utility.trim(), state: (input.state || "").trim(), ahj: input.ahj?.trim(), knownContext: hint });
  if (research.provider === "stub" || !research.requiredDocuments.length) {
    return { research, profileKey: null, saved: false };
  }
  const profile = saveResearchedUtilityProfile(db, { utility: input.utility.trim(), state: (input.state || "").trim(), ahj: input.ahj?.trim() },
    researchWithFittedUrl(db, "nem", { state: input.state, name: input.utility }, research));
  return { research, profileKey: profile.profileKey, saved: true };
}

/**
 * A RESEARCHED URL IS SAVED TO THE KB ONLY WHEN IT FITS — the one write door, shared with the form
 * search (researchedPortalUrl.ts: hostFitsTrackAndEntity, and for a permit the statewide portal
 * refused for an AHJ whose evidence says it files elsewhere — statewideUrlRefusal).
 */
export { researchWithFittedUrl };

// Update an existing project from a (re-)parsed payload. Merges the new fields
// over the existing parser snapshot — so a re-parse of a corrected plan set
// updates the record (including the canonical electrical/structural/evidence
// keys) without losing prior data — then re-runs QC.
export function updateProject(db: AppDb, projectId: string, payload: ParserPayload): ProjectDetail {
  const existing = getProjectDetail(db, projectId).project;
  // Drop the non-persistent plan-set text overlay (re-derived from project_documents
  // on every load) so document text never bloats the stored parser_json.
  const { planSetExtractedText: _planSetText, ...existingSnapshot } = existing.parserSnapshot || {};
  // Derived canonical flags (hasExistingSystem/hasBattery) must be RECOMPUTED
  // from the merged evidence — a stale stored value would win over the re-parse
  // (canonicalizeSnapshot never clobbers a present key), permanently freezing
  // e.g. an addition discovered on re-parse out of the canonical flag.
  delete (existingSnapshot as Record<string, unknown>)["hasExistingSystem"];
  delete (existingSnapshot as Record<string, unknown>)["hasBattery"];
  // Same for the canonical ALIASES (inverterModel ← invModel, inverterQuantity ← invQty, …, #225):
  // a stored alias that merely echoes its source is dropped and re-derived from the merged evidence,
  // so editing invModel moves inverterModel with it. An alias set on its own (differs from its
  // source) is kept, and one sent in THIS payload wins over everything via the merge below.
  for (const key of staleDerivedKeys(existingSnapshot as ParserPayload)) delete (existingSnapshot as Record<string, unknown>)[key];
  const mergedSnapshot: ParserPayload = { ...existingSnapshot, ...payload };
  // WHICH PORTAL THIS FILES ON IS NOT A SIDE EFFECT OF AN EDIT.
  //
  // normalizeProject re-derives every column from the snapshot, so a project whose stored
  // columns and snapshot disagree silently adopts the SNAPSHOT's identity on ANY update.
  // Live: adding plan-evidence text to an Illinois / Commonwealth Edison project re-pointed
  // it to Oregon / City Of Salem / PGE — the fixture's snapshot carried a copy-pasted PGE
  // identity — and the very next staging run opened PGE's REAL portal with Illinois data on
  // it. Its sibling il-test-ameren showed the same split (columns IL/Ameren, snapshot
  // OR/PGE), so this was one edit away from happening twice.
  //
  // State, AHJ and utility decide WHICH PORTAL a filing goes to — the one thing this
  // codebase is most careful about everywhere else. They change only when the caller says
  // so. Settled BEFORE normalising, so the columns, the normalised record and the persisted
  // snapshot all agree afterwards and the next edit starts from a consistent project.
  const identityGiven = (k: string): boolean =>
    Object.prototype.hasOwnProperty.call(payload, k) && String((payload as Record<string, unknown>)[k] ?? "").trim() !== "";
  if (!identityGiven("state")) mergedSnapshot.state = existing.state;
  if (!identityGiven("ahj")) mergedSnapshot.ahj = existing.ahj;
  if (!identityGiven("utility")) mergedSnapshot.utility = existing.utility;
  // THE OPERATOR'S PER-TRACK ISSUER (split issuer) — which agency issues one permit track, e.g. the
  // city's building permit on a county-AHJ project. It decides WHICH PORTAL that track files on, so a
  // value that can never be honoured is refused HERE, before anything is written (the reader,
  // permitProcess.trackIssuer, refuses it too): a name in another state (a permit is never issued
  // across a state line), a web address, an over-long value. "" clears the track's issuer.
  const issuerChanges: Array<{ key: string; from: string; to: string }> = [];
  for (const key of Object.values(TRACK_ISSUER_SNAPSHOT_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const raw = (payload as Record<string, unknown>)[key];
    if (raw != null && typeof raw !== "string") throw new HttpError(400, `${key} must be an agency name (text), or "" to clear it.`, { field: key });
    const value = String(raw ?? "").replace(/\s+/g, " ").trim();
    const why = refuseTrackIssuerValue(value, String(mergedSnapshot.state ?? existing.state ?? ""));
    if (why) throw new HttpError(400, `Not saved — the issuing agency "${value}": ${why}.`, { field: key, trackIssuerRefused: true });
    (mergedSnapshot as Record<string, unknown>)[key] = value;
    const from = String((existingSnapshot as Record<string, unknown>)[key] ?? "").trim();
    if (from !== value) issuerChanges.push({ key, from, to: value });
  }
  const project = normalizeProject(projectId, mergedSnapshot, existing.status, existing.createdAt);
  // Preserve the client link unless the payload explicitly changes it.
  const clientId = (payload.clientId ?? payload.client_id ?? existing.clientId) as string | null;
  db.transaction(() => {
    db.run(
      `UPDATE projects SET
        client_id = ?, homeowner_name = ?, project_address = ?, city = ?, state = ?, zip = ?, ahj = ?, utility = ?,
        account_number = ?, meter_number = ?, system_size_dc_kw = ?, system_size_ac_kw = ?, total_export_kw = ?,
        interconnection_method = ?, parser_confidence_summary = ?, parser_json = ?, updated_at = ?
       WHERE id = ?`,
      [
        clientId,
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
        project.parserConfidenceSummary,
        // Persist the CANONICALIZED snapshot (same as createProject) so derived
        // keys recomputed from the merged evidence actually reach parser_json.
        asJson(project.parserSnapshot),
        nowIso(),
        projectId,
      ],
    );
    insertExtractedFields(db, projectId, mergedSnapshot, true);
    addAuditLog(db, projectId, "system", "front-end parser", "project.updated_from_parser_snapshot", { fields: Object.keys(payload).length });
    // Who issues a permit track decides which portal it files on: its own row in the history.
    for (const change of issuerChanges) {
      addAuditLog(db, projectId, "human", "operator", "project.track_issuer_set", change);
    }
  });
  runQcForProject(db, projectId);
  learnFromProject(db, getProjectDetail(db, projectId).project, "project.updated");
  return getProjectDetail(db, projectId);
}

// ---------------------------------------------------------------------------
// THE OPERATOR STATUS OVERRIDE — the only door out of a drifted status.
//
// updateProject above deliberately does NOT touch `status`: it re-derives every column from
// the parser snapshot, so letting a re-parse move the lifecycle would mean an edit to an
// address could silently un-submit a filing. That was the right call and it stays. What it
// left behind was a project with no way back: when a status drifted — the live PacifiCorp
// APP-111681 case, corrected and resubmitted inside PowerClerk while our row still said
// `correction_received` — the only fix was hand-written SQL against the production database.
//
// So this is a SEPARATE, NARROW, AUDITED path, and the audit row is the point. An operator
// moving a project by hand is a real event in the project's history; a status that changed
// with no record of who or why is how the drift becomes unexplainable six weeks later.
//
// It is also the writer for `blocked` and the way back out of it — `blocked` has no automatic
// writer anywhere by design, because what blocks a job is a human's judgement.
//
// Rule 1 is not weakened here: nothing in this function touches a portal, and moving a row to
// `submitted` records a belief about the world, it does not file anything. The automation
// still never clicks submit.
// ---------------------------------------------------------------------------

// EXHAUSTIVE BY CONSTRUCTION — a Record keyed on ProjectStatus, so adding or removing a status
// upstream is a COMPILE error here rather than a silently widened (or narrowed) override
// surface. Deny-by-default for the same reason the route table is: an unrecognised string must
// never reach `projects.status`, which is precisely the free-text disease this round cures.
const OVERRIDABLE_STATUS: Record<ProjectStatus, "operator" | "computed"> = {
  parsed: "operator",
  qc_failed: "operator",
  qc_passed: "operator",
  ready_to_stage: "operator",
  awaiting_human_submit: "operator",
  correction_received: "operator",
  correction_triaged: "operator",
  waiting_on_designer: "operator",
  ready_to_resubmit: "operator",
  awaiting_human_resubmit: "operator",
  submitted: "operator",
  ready_for_issue: "operator",
  issued: "operator",
  approved: "operator",
  nem_approved: "operator",
  // COMPUTED, NEVER TYPED. triggerHandoffIfReady sets this — and only when a permit is issued
  // AND the NEM is approved. An operator forcing it would produce a project that says the
  // submission scope is complete, publishes an installer handoff checklist, and drops off the
  // board, for a job whose permit may not exist. The way to reach handoff_ready is to record
  // the two approvals; then it sets itself.
  handoff_ready: "computed",
  blocked: "operator",
};

/**
 * Move a project's status by hand. Requires a reason (it goes on the audit row, which is the
 * only lasting record of why the pipeline was overruled). Returns the refreshed detail so the
 * caller can re-render without a second read.
 */
export function setProjectStatusByOperator(
  db: AppDb,
  projectId: string,
  nextStatus: string,
  reason: string,
  actor: string,
): ProjectDetail {
  const project = db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!project) throw new HttpError(404, "Project not found.");

  // A REASON IS NOT PAPERWORK. Without it the audit row says a human changed the status and
  // nothing else, which is the same dead end the SQL edits left behind.
  const trimmedReason = String(reason ?? "").trim();
  if (!trimmedReason) {
    throw new HttpError(400, "A reason is required to override a project's status — it is recorded on the audit trail as the explanation for overruling the pipeline.");
  }

  const disposition = Object.prototype.hasOwnProperty.call(OVERRIDABLE_STATUS, nextStatus)
    ? OVERRIDABLE_STATUS[nextStatus as ProjectStatus]
    : null;
  if (!disposition) {
    throw new HttpError(400, `"${nextStatus}" is not a project status.`, {
      allowed: Object.keys(OVERRIDABLE_STATUS).filter((s) => OVERRIDABLE_STATUS[s as ProjectStatus] === "operator"),
    });
  }
  if (disposition === "computed") {
    throw new HttpError(409,
      `"${nextStatus}" is computed, not chosen: it is set only when the permit is issued AND the NEM is approved. `
      + "Record those two approvals and the project moves itself — forcing it here would publish an installer handoff for a job that may have no permit.",
      { status: nextStatus });
  }

  const fromStatus = String(project.status);
  const ts = nowIso();
  db.run("UPDATE projects SET status = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
    nextStatus,
    // THE STALE SUB-STAGE MUST NOT SURVIVE THE MOVE. A project overridden out of
    // `awaiting_human_submit` while stage_detail still read `staged_for_review` would keep
    // claiming a filing sits on a portal review screen under a status that says otherwise.
    // This says exactly what is true and no more: a human put it here. WHY is on the audit row.
    "operator_override" satisfies StageDetail,
    ts,
    projectId,
  ]);
  // current_stage is left ALONE on purpose. It is prose, it is a matching key, and the last
  // machine event that wrote it is still the last machine event that happened.

  addAuditLog(db, projectId, "human", actor || "operator", "project.status_overridden", {
    from: fromStatus,
    to: nextStatus,
    reason: trimmedReason,
  });

  return getProjectDetail(db, projectId);
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

type LaneStatusSummary = Pick<
  ProjectListItem,
  | "latestPermitLabel"
  | "latestPermitOutcome"
  | "latestPermitCheckedAt"
  | "readyForIssue"
  | "latestNemLabel"
  | "latestNemOutcome"
  | "latestNemCheckedAt"
  | "nemApproved"
>;

// Pure analysis over already-loaded checks/emails — no DB access, so the list path can
// batch-load all pages' rows in two queries and call this per project.
//
// THE LATEST READING, NOT ANY READING (S4). readyForIssue / nemApproved used `.some` over EVERY
// historical check and email, and counted `reviewed_by_ahj` (and a NEM target reading
// ready_for_issue / issued) as "NEM approved" — so a board card said "NEM approved" while the
// project page's track said "Under utility review". Now: each tracking target speaks through
// its NEWEST check only, `reviewed_by_ahj` is "in review" (never approved), and "done" comes
// from `trackDone` — isTrackDone, the one rule the tracks panel and the handoff use (a finaled
// permit's newest reading is needs_human_review, so "latest check says issued" alone would
// un-issue it).
export function computeLaneStatusSummary(
  projectStatus: ProjectRecord["status"],
  checks: ReturnType<typeof mapPermitStatusCheck>[],
  emails: ReturnType<typeof mapEmailProjectMatch>[],
  trackDone: { permit: boolean; nem: boolean } = { permit: false, nem: false },
): LaneStatusSummary {
  const latestPermitCheck = checks.find(hasPermitSignal) || checks.find((check) => !hasNemSignal(check)) || null;
  const latestNemCheck = checks.find(hasNemSignal) || null;
  const latestPermitEmail = emails.find((email) => hasPermitSignal(email) && email.workflow !== "nem") || null;
  const latestNemEmail = emails.find((email) => hasNemSignal(email) || email.workflow === "nem" || email.workflow === "both") || null;
  const permitEmailOutcome = latestPermitEmail ? outcomeFromEmailBucket(latestPermitEmail.emailBucket) : null;
  const nemEmailOutcome = latestNemEmail ? outcomeFromEmailBucket(latestNemEmail.emailBucket) : null;
  // Newest check per tracking target (checks arrive newest-first). A legacy check with no
  // target groups under "" — the newest of those speaks for them.
  const latestPerTarget = (list: typeof checks): typeof checks => {
    const seen = new Set<string>();
    return list.filter((check) => {
      const key = check.targetId ?? "";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const permitChecks = latestPerTarget(checks.filter((check) => hasPermitSignal(check) || !hasNemSignal(check)));
  const nemChecks = latestPerTarget(checks.filter(hasNemSignal));
  const readyForIssue =
    projectStatus === "ready_for_issue"
    || projectStatus === "issued"
    || trackDone.permit
    || permitChecks.some((check) => check.readyForIssue || check.outcome === "ready_for_issue" || check.outcome === "issued")
    || Boolean(latestPermitEmail && (latestPermitEmail.emailBucket === "permit_approval" || latestPermitEmail.emailBucket === "inspection_final_notice"));
  // NOT projectStatus === "approved": only a PERMIT reading writes that status (reviewed_by_ahj
  // on a permit target -> project 'approved'), so counting it here was a second "is NEM
  // approved" predicate that said yes to a permit's plan-review approval (decisions-0926
  // skeptic MF2). The NEM lane answers through isNemApprovalOutcome on its own checks, the
  // NEM track's done verdict, the project's NEM-earned statuses, and the utility's own email.
  const nemApproved =
    projectStatus === "nem_approved"
    || projectStatus === "handoff_ready"
    || trackDone.nem
    || nemChecks.some((check) => isNemApprovalOutcome(check.outcome))
    || Boolean(latestNemEmail && latestNemEmail.emailBucket === "nem_approval");

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

export function getProjectList(
  db: AppDb,
  options: {
    limit?: number;
    offset?: number;
    search?: string;
    status?: string;
    userId?: string;
    clientId?: string;
    includeArchived?: boolean;
    sort?: "updated_desc" | "created_desc" | "name_asc" | "status_asc";
    /** Tenant filter. `null` reads across every org (superadmin); omitted means the
     *  single-operator default tenant, which is what every pre-tenancy row is. */
    orgId?: string | null;
  } = {},
): { projects: ProjectListItem[]; total: number } {
  const limit = Math.min(options.limit ?? 200, 500);
  const offset = options.offset ?? 0;

  const conditions: string[] = [];
  if (options.includeArchived === false) conditions.push("COALESCE(p.archived_at, '') = ''");
  const filterParams: (string | number)[] = [];

  // Tenant scope FIRST, so it is applied to the count and the page alike (both
  // interpolate the same `where`). `orgId: null` is the explicit superadmin bypass;
  // `undefined` means the default tenant rather than "everything", so a caller that
  // forgets to pass one sees only the default org instead of the whole database.
  const scopeOrgId = options.orgId === null ? null : (options.orgId || DEFAULT_ORG_ID);
  if (scopeOrgId) { conditions.push("p.org_id = ?"); filterParams.push(scopeOrgId); }

  if (options.search) {
    conditions.push("(p.homeowner_name LIKE ? OR p.project_address LIKE ? OR p.ahj LIKE ? OR p.status LIKE ?)");
    const q = `%${options.search}%`;
    filterParams.push(q, q, q, q);
  }
  if (options.status) { conditions.push("p.status = ?"); filterParams.push(options.status); }
  if (options.userId) { conditions.push("p.assigned_user_id = ?"); filterParams.push(options.userId); }
  if (options.clientId) { conditions.push("p.client_id = ?"); filterParams.push(options.clientId); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const orderMap: Record<string, string> = {
    updated_desc: "p.updated_at DESC",
    created_desc: "p.created_at DESC",
    name_asc: "p.homeowner_name ASC",
    status_asc: "p.status ASC",
  };
  const order = orderMap[options.sort ?? ""] ?? "p.updated_at DESC";

  const countRow = db.get<Row>(`SELECT COUNT(*) as cnt FROM projects p ${where}`, filterParams);
  const total = Number(countRow?.cnt ?? 0);

  const rows = db.query<ProjectRow & Row>(
    `SELECT p.*,
      (SELECT COUNT(*) FROM qc_results q WHERE q.project_id = p.id AND q.qc_status = 'fail') AS qcFailCount,
      (SELECT COUNT(*) FROM qc_results q WHERE q.project_id = p.id AND q.qc_status = 'warning') AS qcWarningCount,
      (SELECT COUNT(*) FROM human_review_items h WHERE h.project_id = p.id AND h.status = 'pending') AS pendingReviewCount,
      (SELECT COUNT(*) FROM corrections c WHERE c.project_id = p.id) AS correctionCount,
      (SELECT pr.status FROM portal_runs pr WHERE pr.project_id = p.id ORDER BY pr.started_at DESC LIMIT 1) AS latestPortalStatus,
      (SELECT COALESCE(NULLIF(c.company_name, ''), c.legal_business_name) FROM clients c WHERE c.id = p.client_id) AS clientName
     FROM projects p ${where}
     ORDER BY ${order}
     LIMIT ? OFFSET ?`,
    [...filterParams, limit, offset],
  );

  // Batch-load the lane-status inputs for the entire page in TWO queries (not 2 per
  // row) to avoid an N+1 that stalls the dashboard at thousands of projects. Global
  // ORDER BY created_at DESC means each project's rows arrive newest-first, so taking
  // the first 50 per project preserves the original per-project LIMIT 50 semantics.
  const pageIds = rows.map((r) => text(r.id)).filter(Boolean);
  const checksByProject = new Map<string, ReturnType<typeof mapPermitStatusCheck>[]>();
  const emailsByProject = new Map<string, ReturnType<typeof mapEmailProjectMatch>[]>();
  if (pageIds.length) {
    const placeholders = pageIds.map(() => "?").join(",");
    for (const r of db.query<Row>(`SELECT c.*, t.target_type, t.permit_type FROM permit_status_checks c LEFT JOIN permit_check_targets t ON t.id = c.target_id WHERE c.project_id IN (${placeholders}) ORDER BY c.created_at DESC`, pageIds)) {
      const pid = text(r.project_id);
      const arr = checksByProject.get(pid) ?? [];
      if (arr.length < 50) { arr.push(mapPermitStatusCheck(r)); checksByProject.set(pid, arr); }
    }
    for (const r of db.query<Row>(`SELECT * FROM email_project_matches WHERE project_id IN (${placeholders}) ORDER BY created_at DESC`, pageIds)) {
      const pid = text(r.project_id);
      const arr = emailsByProject.get(pid) ?? [];
      if (arr.length < 50) { arr.push(mapEmailProjectMatch(r)); emailsByProject.set(pid, arr); }
    }
  }

  // THE NEXT STEP, per row, from the same rule table the project page uses (nextStep.ts) —
  // batch facts, a fixed number of queries per page. The list tier does not run the submit gate
  // (~50ms a project); its answer says gateChecked:false.
  const mapped = rows.map((row) => ({ row, project: mapProject(row) }));
  const factsByProject = loadNextStepFacts(db, mapped.map((m) => m.project));
  const projects = mapped.map(({ row, project }) => {
    const { parserSnapshot: _parserSnapshot, ...listBase } = project;
    const facts = factsByProject.get(project.id);
    const nextStep = compactNextStep(decideNextStep(facts!));
    // Overdue is counted with the SAME predicate the project page renders (mapCorrection's
    // isOverdue) — the SQL date arithmetic it replaces disagreed with it across a day boundary.
    const overdueCorrections = facts!.openCorrections.filter((c) => c.isOverdue).length;
    const laneSummary = computeLaneStatusSummary(project.status, checksByProject.get(project.id) ?? [], emailsByProject.get(project.id) ?? [], {
      permit: facts!.tracks.some((t) => t.track !== "nem" && t.done),
      nem: facts!.tracks.some((t) => t.track === "nem" && t.done),
    });
    const stage = stageForStatus(project.status);
    return {
      ...listBase,
      qcFailCount: Number(row.qcFailCount ?? 0),
      qcWarningCount: Number(row.qcWarningCount ?? 0),
      pendingReviewCount: Number(row.pendingReviewCount ?? 0),
      correctionCount: Number(row.correctionCount ?? 0),
      overdueCorrections,
      assignedUserId: row.assigned_user_id == null ? null : text(row.assigned_user_id),
      clientName: row.clientName == null ? null : text(row.clientName),
      latestPortalStatus: row.latestPortalStatus == null ? null : (text(row.latestPortalStatus) as ProjectListItem["latestPortalStatus"]),
      stageKey: stage.key,
      stageIndex: stage.index,
      stageLabel: stage.label,
      stageCount: STAGE_COUNT,
      isBlocked: isBlockedProject(project.status, overdueCorrections > 0),
      ...laneSummary,
      nextStep,
    };
  });

  return { projects, total };
}

export function getProjectDetail(db: AppDb, projectId: string): ProjectDetail {
  const projectRow = db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!projectRow) throw new HttpError(404, "Project not found.");

  const project = mapProject(projectRow);
  // Overlay the uploaded plan-set-family document text (non-persistent) so the
  // reviewer gate and evidence checks see the ACTUAL sheets, not only what the
  // parser snapshot happened to capture. Fixes false "not shown on plans" blockers.
  const planSetText = planSetTextForProject(db, projectId);
  if (planSetText && !project.parserSnapshot.planSetExtractedText) {
    project.parserSnapshot = { ...project.parserSnapshot, planSetExtractedText: planSetText };
  }
  const stage = stageForStatus(project.status);
  const corrections = db.query<Row>("SELECT * FROM corrections WHERE project_id = ? ORDER BY created_at DESC", [projectId]).map(mapCorrection);
  return {
    project,
    stageKey: stage.key,
    stageIndex: stage.index,
    stageLabel: stage.label,
    stageCount: STAGE_COUNT,
    isBlocked: isBlockedProject(project.status, corrections.some((c) => c.isOverdue)),
    qcResults: db.query<Row>("SELECT * FROM qc_results WHERE project_id = ? ORDER BY created_at DESC", [projectId]).map(mapQc),
    humanReviewItems: db
      .query<Row>("SELECT * FROM human_review_items WHERE project_id = ? ORDER BY status DESC, created_at DESC", [projectId])
      .map(mapReview),
    corrections,
    permitCheckTargets: db
      .query<Row>("SELECT * FROM permit_check_targets WHERE project_id = ? ORDER BY active DESC, created_at DESC", [projectId])
      .map(mapPermitTarget),
    permitStatusChecks: db
      .query<Row>("SELECT c.*, t.target_type, t.permit_type FROM permit_status_checks c LEFT JOIN permit_check_targets t ON t.id = c.target_id WHERE c.project_id = ? ORDER BY c.created_at DESC LIMIT 50", [projectId])
      .map(mapPermitStatusCheck),
    emailProjectMatches: db
      .query<Row>("SELECT * FROM email_project_matches WHERE project_id = ? ORDER BY created_at DESC LIMIT 50", [projectId])
      .map(mapEmailProjectMatch),
    portalRuns: db.query<Row>("SELECT * FROM portal_runs WHERE project_id = ? ORDER BY started_at DESC", [projectId]).map(mapPortalRun),
    submissions: db.query<Row>("SELECT * FROM submissions WHERE project_id = ? ORDER BY created_at DESC", [projectId]).map(mapSubmission),
    auditLogs: db.query<Row>("SELECT * FROM audit_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT 100", [projectId]).map(mapAudit),
    projectNotes: db.query<Row>("SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at DESC LIMIT 50", [projectId]).map(mapProjectNote),
  };
}

// rebuildKnowledgeRollup lives in knowledgeBase.ts (it also derives the timeline from
// permit_timeline_samples, and the correction relearn path there needs it).

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
         SELECT profile_key FROM historical_failure_examples WHERE project_id = ?
         UNION
         SELECT profile_key FROM permit_timeline_samples WHERE project_id = ?`,
        [projectId, projectId, projectId, projectId],
      )
      .map((row) => text(row.profile_key))
      .filter(Boolean),
  );

  // The FILES first, before the transaction drops the rows that point at them.
  // This cascade used to delete the project_documents ROWS only, so every deleted
  // project left its plan set, meter photo, and stamped letters orphaned on disk —
  // homeowner PII with no DB reference, invisible to every check (the backup
  // integrity scan counts rows-missing-files, not files-missing-rows). Collected
  // before, unlinked after the transaction commits, so a rollback never loses files.
  const storedFiles = db
    .query<Row>("SELECT stored_path FROM project_documents WHERE project_id = ?", [projectId])
    .map((r) => text(r.stored_path))
    .filter(Boolean);

  db.transaction(() => {
    db.run("DELETE FROM email_project_matches WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM permit_status_checks WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM permit_check_targets WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM portal_runs WHERE project_id = ?", [projectId]);
    // Approve & Submit approvals (migration v35) carry a FK to projects.
    db.run("DELETE FROM portal_run_approvals WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM submissions WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM human_review_items WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM corrections WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM qc_results WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM extracted_fields WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM source_files WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM audit_logs WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM historical_failure_examples WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM permit_timeline_samples WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM historical_project_fingerprints WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM knowledge_events WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM project_notes WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM operation_steps WHERE project_id = ?", [projectId]);
    // Project-scoped tables added later — must also be cleared or the FK on projects fails.
    db.run("DELETE FROM project_metrics WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM filing_metrics WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM project_documents WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM project_intake_requests WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM submission_payments WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM portal_fee_readings WHERE project_id = ?", [projectId]);
    // Keep permit_fee_history (learned real fees) but unlink the deleted project.
    db.run("UPDATE permit_fee_history SET project_id = NULL WHERE project_id = ?", [projectId]);
    // Communications may belong to a customer too — unlink rather than destroy correspondence.
    db.run("UPDATE communications SET project_id = NULL WHERE project_id = ?", [projectId]);
    db.run("DELETE FROM projects WHERE id = ?", [projectId]);

    for (const key of affectedKeys) rebuildKnowledgeRollup(db, key);
    addAuditLog(db, null, "human", "dashboard", "project.deleted", {
      projectId,
      homeownerName: text(project.homeowner_name),
      projectAddress: text(project.project_address),
      affectedKnowledgeProfiles: affectedKeys.size,
    });
  });

  // Rows are gone — now remove the files, then the project's (empty) folder.
  // Best-effort per file: one locked/missing file must not strand the rest.
  for (const stored of storedFiles) {
    try { fs.unlinkSync(stored); } catch { /* already gone or busy */ }
  }
  try {
    const dir = path.join(DOCS_DIR, projectId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best effort */ }

  return { deleted: true, projectId, affectedKnowledgeProfiles: affectedKeys.size };
}


// A pending human-review item that actually gates staging. Corrections have their
// own lifecycle, and ADVISORY items — run-triage suggestions ("add the portal
// login, then retry") and background-job failure notices — are guidance, not
// unverified extraction data: they must never flip the submit gate to blocked.
// Live-tested failure: a triage tip about missing portal credentials blocked a
// clean Coos Bay submittal while the QC panel showed nothing to fix.
//
// NOR IS TRACK / OPS WORK QC WORK (S6). `permit_status` items are monitor readings of a FILED
// application's portal text; `prepare_submission` / `autopilot` items are job notices. Counting
// them here painted "N thing(s) must clear before this can be submitted" in red on ISSUED
// projects and held the staging gate shut over a permit already on file. They stay visible — the Track stage shows
// the readings and nextStep.ts surfaces them — they just do not gate. This is the ONE answer to
// "does this pending item hold staging?": the submit gate, prepareSubmission's 409 and every
// report below read it.
// A paid receipt disagreeing with a SHARED fee schedule (feeSchedules.raiseReceiptContradictionReviews)
// is about the schedule, not this project's data: it rides the project only because review items
// need one, and it must never hold that project's submission.
const ADVISORY_REVIEW_ISSUE_TYPES = new Set(["Run triage", "Background job failed", "Fee schedule disagrees with paid receipts"]);
export const NON_QC_REVIEW_FIELDS: ReadonlySet<string> = new Set(["correction", "permit_status", "prepare_submission", "autopilot"]);
export function isCriticalReviewItem(item: { status: string; fieldName: string; issueType?: string }): boolean {
  // The bill wait (qc.ts) is advisory: read at call time, not in the Set, so no import-order cycle
  // can leave the constant uninitialised when this module loads.
  return item.status === "pending" && !NON_QC_REVIEW_FIELDS.has(item.fieldName) && !ADVISORY_REVIEW_ISSUE_TYPES.has(item.issueType || "") && item.issueType !== WAITING_ON_BILL_ISSUE_TYPE;
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
  const historicalReport = buildHistoricalFailureReport(db, project.id, null);
  const reviewerReport = reviewerGateReportFor(db, project);
  const applicationDocs = buildApplicationDocumentPackage(project);
  const pendingCritical = detail.humanReviewItems.filter(isCriticalReviewItem).length;
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
  // ONE predicate for "is this NEM target approved" (isNemApprovalOutcome) on the NEM lane's own
  // checks (hasNemSignal: the target's type, the word sniff only for legacy untyped rows). This
  // used to sniff words and count the PERMIT family of outcomes while omitting nem_approved.
  const hasNemApproval = detail.permitStatusChecks.some((check) => hasNemSignal(check) && isNemApprovalOutcome(check.outcome));
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
  const reviewerReport = reviewerGateReportFor(db, project);
  const applicationDocs = buildApplicationDocumentPackage(project);
  const historicalReport = buildHistoricalFailureReport(db, projectId, null);
  const blockers: OperationsBriefSignal[] = [];
  const readySignals: OperationsBriefSignal[] = [];

  const qcFails = detail.qcResults.filter((item) => item.qcStatus === "fail");
  const qcWarnings = detail.qcResults.filter((item) => item.qcStatus === "warning");
  const pendingCritical = detail.humanReviewItems.filter(isCriticalReviewItem);
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
        // Per-track state, not the lane rollup (trackStateSummary): "fee due", never "waiting".
        (() => { const w = trackStateSummary(getSubmittalTracks(db, project)); return `PermitFlow: ${w.permit} | NEMflow: ${w.nem}`; })(),
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

export function getOperationsBoard(db: AppDb, orgId: string | null = DEFAULT_ORG_ID): OperationsBoard {
  const { projects } = getProjectList(db, { orgId });
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

export function getOperationsActionQueue(db: AppDb, orgId: string | null = DEFAULT_ORG_ID): OperationsActionQueue {
  const { projects } = getProjectList(db, { orgId });
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

export function getOperationsDailyReport(db: AppDb, orgId: string | null = DEFAULT_ORG_ID): OperationsDailyReport {
  const board = getOperationsBoard(db, orgId);
  const actionQueue = getOperationsActionQueue(db, orgId);
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
  const historicalReport = buildHistoricalFailureReport(db, projectId, null);
  const reviewerReport = reviewerGateReportFor(db, project);
  const applicationDocs = buildApplicationDocumentPackage(project);
  const activeEmailSources = db.query<Row>("SELECT id, label, last_checked_at, last_matched_count, last_error FROM email_tracking_sources WHERE active = 1 ORDER BY updated_at DESC");

  const accountEvidence = evidenceForTopic(project, "accountVerification");
  const meterEvidence = evidenceForTopic(project, "meterPhoto");
  const sldEvidence = evidenceForTopic(project, "sld");
  const siteEvidence = evidenceForTopic(project, "siteRoofPlan");
  const inverterEvidence = evidenceForTopic(project, "inverterSettings");
  const pendingCritical = detail.humanReviewItems.filter(isCriticalReviewItem).length;
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
        ...detail.humanReviewItems.filter((item) => item.status === "pending").slice(0, 3).map((item) => `Human review: ${item.issueType || item.fieldName}`),
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

/**
 * WHERE EACH FILING STANDS, in words — the per-track state (getSubmittalTracks: isTrackDone and
 * the latest reading per target), never the process lanes' rollup. The lane rollup reads
 * "waiting" whenever any step waits (a portal run awaiting its human submit, a checklist gap), so
 * the summary said "PermitFlow waiting" while the building permit was ready_for_issue (demo:
 * Walt Brennan). ready_for_issue is "fee due" — a person still has to pay — never "waiting" and
 * never "issued". Several permit tracks are named one by one.
 */
const TRACK_STATE_WORDS: Record<SubmittalTrack["status"], string> = {
  not_started: "not started", staged: "staged", submitted: "submitted", in_review: "in review",
  correction: "correction", ready_for_issue: "fee due", issued: "issued",
};
export function trackStateSummary(tracks: readonly Pick<SubmittalTrack, "type" | "category" | "status">[]): { permit: string; nem: string } {
  const permits = tracks.filter((t) => t.category === "permit");
  const nem = tracks.find((t) => t.category === "utility");
  const word = (t: Pick<SubmittalTrack, "category" | "status">) => (t.category === "utility" && t.status === "issued" ? "approved" : TRACK_STATE_WORDS[t.status]);
  return {
    permit: permits.length === 0 ? "not required"
      : permits.length === 1 ? word(permits[0])
      : permits.map((t) => `${t.type} ${word(t)}`).join(", "),
    nem: nem ? word(nem) : "not required",
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
  // A CHECK KNOWS ITS LANE — the target it descends from is typed "permit" | "nem". The
  // text heuristic below predates typed targets, and it misfiled a status check by the
  // WORDS on the page: Placeholder's issued ELECTRICAL permit page mentions "utility", the
  // regex called it a NEM check, the NEM lane showed "Permit issued", and — because
  // "issued" sits in the NEM-approved outcome list — the dashboard badged two live
  // interconnection applications "NEM approved" that PacifiCorp still lists as
  // submitted/under review. The type is authoritative; the sniff survives only for
  // legacy rows recorded before targets carried one.
  if (!("emailBucket" in check) && check.targetType) return check.targetType === "nem";
  const value = "emailBucket" in check
    ? `${check.emailBucket} ${check.workflow} ${check.subject}`
    : `${check.statusLabel} ${check.rawStatusText} ${check.message}`;
  return /\b(nem|net.?meter|interconnection|pto|permission to operate|utility|powerclerk|pge|pacific power|pacificorp)\b/i.test(value);
}

function hasPermitSignal(check: PermitStatusCheck | EmailProjectMatch): boolean {
  // Same rule as hasNemSignal: the target's own type is authoritative for a status check.
  if (!("emailBucket" in check) && check.targetType) return check.targetType === "permit";
  const value = "emailBucket" in check
    ? `${check.emailBucket} ${check.workflow} ${check.subject}`
    : `${check.statusLabel} ${check.rawStatusText} ${check.message}`;
  return /\b(permit|ahj|jurisdiction|city|county|building|electrical|inspection|issued|ready to issue)\b/i.test(value);
}

export function getProjectProcessMap(db: AppDb, projectId: string): ProjectProcessMap {
  const detail = getProjectDetail(db, projectId);
  const project = detail.project;
  const historicalReport = buildHistoricalFailureReport(db, projectId, null);
  const reviewerReport = reviewerGateReportFor(db, project);
  const applicationDocs = buildApplicationDocumentPackage(project);

  const accountEvidence = evidenceForTopic(project, "accountVerification");
  const meterEvidence = evidenceForTopic(project, "meterPhoto");
  const sldEvidence = evidenceForTopic(project, "sld");
  const siteEvidence = evidenceForTopic(project, "siteRoofPlan");
  const inverterEvidence = evidenceForTopic(project, "inverterSettings");
  const utilityApprovalEvidence = evidenceForTopic(project, "utilityApproval");
  const pendingCritical = detail.humanReviewItems.filter(isCriticalReviewItem).length;
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
  // Strong signals only — see classifyCorrectionTrack. An unclassified correction shows on
  // this lane AND the permit lane; a permit-record scrape shows on neither this one.
  // The page a portal correction was read from (sourceText) is evidence of WHICH record it came
  // off ("Record 187-26-000305-STR: ..."), so it stays in the track reading the extraction trimmed.
  const nemCorrections = detail.corrections.filter((correction) => correctionOnTrack("nem", correction.correctionText, correction.sourceText, correction.rootCause, correction.requiredAction));
  const openPermitCorrections = permitCorrections.filter((correction) => !correction.closedAt && !correction.resubmitted);
  const openNemCorrections = nemCorrections.filter((correction) => !correction.closedAt && !correction.resubmitted);
  const hasPortalStaging = detail.portalRuns.some((run) => run.status === "awaiting_human_submit" || run.status === "submitted");
  const permitApproved = project.status === "ready_for_issue" || project.status === "issued" || permitChecks.some((check) => check.readyForIssue || check.outcome === "issued");
  // isNemApprovalOutcome — the one "is this NEM target approved" answer (permitMonitor.ts). The
  // permit family (reviewed_by_ahj / ready_for_issue / issued) on a NEM target is not an approval.
  const nemApproved = utilityApprovalEvidence.present || nemChecks.some((check) => isNemApprovalOutcome(check.outcome)) || nemEmails.some((email) => email.emailBucket === "nem_approval");
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
          ...detail.humanReviewItems.filter((item) => item.status === "pending").slice(0, 3).map((item) => `Human review: ${item.issueType || item.fieldName}`),
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
          ...permitEmails.slice(0, 2).map((email) => `Email: ${humanizeEnum(email.emailBucket)} ${email.subject}`),
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
        evidence: permitChecks.slice(0, 4).map((check) => `${check.statusLabel || humanizeEnum(check.outcome)}`),
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
          ...nemEmails.slice(0, 2).map((email) => `Email: ${humanizeEnum(email.emailBucket)} ${email.subject}`),
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
          ...nemChecks.slice(0, 3).map((check) => `${check.statusLabel || humanizeEnum(check.outcome)}`),
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
          ...detail.emailProjectMatches.slice(0, 2).map((email) => `Email: ${humanizeEnum(email.emailBucket)} ${email.subject}`),
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
  const trackWords = trackStateSummary(getSubmittalTracks(db, project));
  const headline = `PermitFlow ${trackWords.permit}; NEMflow ${trackWords.nem}; overall ${status.replaceAll("_", " ")}.`;
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
  const reviewerReport = reviewerGateReportFor(db, project);
  const historicalReport = buildHistoricalFailureReport(db, projectId, null);
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

  for (const review of detail.humanReviewItems.filter(isCriticalReviewItem).slice(0, 8)) {
    add({
      id: `human-review:${review.id}`,
      category: /account|meter|utility|interconnection/i.test(review.fieldName) ? "utility_nem" : "field_verification",
      severity: "warning",
      title: `Verify ${review.issueType || review.fieldName}`,
      ask: `Confirm the correct value for ${review.issueType || review.fieldName}.`,
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
      title: `Open correction: ${correction.rootCause || humanizeBucket(correction.correctionBucket)}`,
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

/**
 * A PRESENT DOCUMENT SAYS ONLY THAT IT IS PRESENT. The inventory's labels describe what the AHJ
 * wants the document to SHOW ("Site / plot plan with fire access + escape pathways", "… (rapid
 * shutdown …)"), and the gate printed them after a green check: "✓ Site / plot plan with fire
 * access + escape pathways (attached file)" — on the Waltham job whose fire department then
 * rejected exactly that pathway (new-AHJ e2e, 2026-09-26). Nothing had read the drawing. So the
 * line names the document without its content claim, says how it was found, and carries no
 * check mark: a check mark means a rule was CHECKED; "file attached" means only that.
 */
export function documentPresenceLine(label: string, via: string): string {
  const bare = String(label || "").replace(/\s*\([^)]*\)/g, "").replace(/\s+with\s+.*$/i, "").trim() || String(label || "").trim();
  const how = String(via || "").trim();
  const claimed = bare !== String(label || "").trim();
  const tail = claimed ? " — its contents are not checked here" : "";
  if (/^in plan set/i.test(how)) return `Found in the plan set: ${bare}${tail}`;
  if (/^attached file/i.test(how)) return `File attached: ${bare}${how.slice("attached file".length)}${tail}`;
  return `On file: ${bare}${how ? ` (${how})` : ""}${tail}`;
}

// A line that NAMES a document's state is the check's answer, not supporting detail: capping it
// away left the document check a WARNING whose advisory document was named nowhere (e6b3afde —
// the count line and 4 present lines filled the cap first). Those lines are never capped; the
// rest share the cap. Order is kept, so the count line stays first.
const GATE_EVIDENCE_NAMES_A_DOCUMENT = /^(Filled at staging:|Stage downloads and fills it:|MISSING \(required\):|Missing \(advisory\):|NOT KNOWN:)/;

/** How Stage gets a form it acquires itself, in words (the gate's evidence line). */
function acquisitionSentence(a: StageAcquiredForm | undefined): string {
  if (!a) return "Stage acquires it before it counts";
  // The search is running NOW (formAcquisitionPlan's in-flight registry): said as such — never "find
  // the official form or upload the blank" over a search that is finding it.
  if (a.inFlight) return `Stage is searching for it now (${startedAtLabel(a.inFlight.since)}) — the form research for ${a.authority} is in flight; when it finishes this row says what it found`;
  if (a.via === "research") return `no free copy is on file; Stage's form research runs for ${a.authority} (the 24h cooldown is open) — if it finds nothing, Stage stops and says so`;
  return `${a.authority}'s ${a.via === "curated" ? "published form (a checked, hash-locked copy)" : "application PDF the per-job lookup cites"} is downloaded from ${a.sourceUrl} and filled before Stage counts — if the download fails, Stage stops and says so`;
}
const GATE_EVIDENCE_CAP = 6;

/** The contractor licence on file for the project's state — moved to clients.ts, the one predicate
 *  the form fill reads too; re-exported so existing callers keep working. */
export { contractorLicenceForState } from "./clients";

const GATE_EVIDENCE_LINE_CAP = 190;
const GATE_EVIDENCE_LINE_HARD_CAP = 400;

/** One gate evidence line, capped — but never mid-URL: a cited page is what the operator opens to
 *  check the line (a verified list's citation, #121), so the cap stretches to the end of the first
 *  URL it would cut, up to a hard ceiling. */
function gateEvidenceLine(line: string): string {
  const cleaned = text(line).replace(/\s+/g, " ").trim();
  let limit = GATE_EVIDENCE_LINE_CAP;
  for (const m of cleaned.matchAll(/https?:\/\/[^\s)"]+/g)) {
    const end = (m.index ?? 0) + m[0].length;
    if (end < limit) continue;
    if ((m.index ?? 0) < limit) limit = Math.min(GATE_EVIDENCE_LINE_HARD_CAP, end + 2);
    break;
  }
  return shorten(cleaned, limit);
}

function submitGateCheck(input: SubmitGateCheck): SubmitGateCheck {
  const lines = input.evidence.filter(Boolean).map(gateEvidenceLine);
  const named = lines.filter((line) => GATE_EVIDENCE_NAMES_A_DOCUMENT.test(line)).length;
  let otherRoom = Math.max(0, GATE_EVIDENCE_CAP - named);
  return {
    ...input,
    evidence: lines.filter((line) => GATE_EVIDENCE_NAMES_A_DOCUMENT.test(line) || otherRoom-- > 0),
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
  const historicalReport = buildHistoricalFailureReport(db, projectId, null);
  const reviewerReport = reviewerGateReportFor(db, project);
  const applicationDocs = buildApplicationDocumentPackage(project);
  const docInventory = documentInventory(db, project);
  // What the operator OWES — the document check below and Stage/Approve read this one answer.
  const gateDocs = owedMissingDocuments(db, project, docInventory);
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
  const pendingCritical = detail.humanReviewItems.filter(isCriticalReviewItem);
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
  // Strong signals only — see classifyCorrectionTrack. Unclassified still warns here (an
  // unknown is not an all-clear); a permit-record scrape no longer warns on the NEM lane.
  const openNemCorrections = openCorrections.filter((correction) => correctionOnTrack("nem", correction.correctionText, correction.sourceText, correction.rootCause, correction.requiredAction));
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
  const missingCriticalAll = criticalFields.filter(([, value]) => !hasValue(value)).map(([label]) => label);
  // ACCOUNT / METER WITH NO BILL ON FILE IS A NAMED WAIT (qc.ts WAITING_ON_BILL_ISSUE_TYPE): the
  // customer's bill carries them and nothing else does. The wait is shown, laned NEM, and does not
  // block the permit side; with a bill on file a missing value blocks again.
  const waitingOnBill: string[] = customerBillOnFile(db, projectId) ? [] : missingCriticalAll.filter((label) => label === "Account" || label === "Meter");
  const missingCritical = missingCriticalAll.filter((label) => !waitingOnBill.includes(label));
  // Safe client lookup (no throw) for the submitting-client gate.
  const submittingClientRow = project.clientId ? clientLicenceRow(db, project.clientId) : null;
  const licence = submittingClientRow ? contractorLicenceForState(submittingClientRow, project.state) : null;
  // OUTSIDE OREGON THE LICENCE IS THE PERMIT'S: each permit track asks licenceFor (the answer the
  // fill and the portal overlay read) for the licence it takes — a client holding three MA licences
  // is not "no licence on file" because the question was asked without a track.
  const licenceByTrack = submittingClientRow && licence && !licence.oregon
    ? (() => { try { return requiredTracks(project).filter((t) => t !== "nem"); } catch { return [] as string[]; } })()
      .map((t) => ({ track: t, answer: contractorLicenceForState(submittingClientRow, project.state, t) }))
    : [];
  const licenceMissingTracks = licenceByTrack.filter((t) => !t.answer.number);
  // THE PLAN SET'S LICENCE BELONGS TO ANOTHER COMPANY (clientMatch.planSetLicenceWarning): a warning,
  // never a switch — the assignment is the operator's.
  let planSetLicenceDoubt = "";
  try { planSetLicenceDoubt = planSetLicenceWarning(db, project) ?? ""; } catch { planSetLicenceDoubt = ""; }
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
  // AHJ forms whose auto-derived field/signature mapping the operator hasn't yet
  // verified. A real submit is gated until each is previewed and confirmed — but only
  // for forms that are actually filled for this project's permit path. The "other"
  // application (prescriptive vs structural) is skipped, so an unverified off-path
  // template must NOT block the submit.
  const gatePathResolution = resolvePermitPathForProject(db, project);
  const gatePermitPath = gatePathResolution.path;
  // The rows of this job's BCD 5952 that answer No (bcdChecklistFacts — the list the fill note
  // reads). Oregon's checklist only; read for the permit-path check below.
  const prescriptiveChecklistNo = usStateCode(project.state) === "OR" ? bcd5952FailedRows(project).map((f) => f.clause) : [];
  // Read the STORED kind, exactly as buildFilledFormsForProject's fill gate does. With the
  // name alone, a stamped-structural blank whose filename claims neither kind counted as
  // "allowed" on a PRESCRIPTIVE project — so its unverified mapping blocked the submit
  // gate over a form this project will never file.
  // A form filled from the BUILT-IN map written in code for its exact blank (by sha256 —
  // ahjForms.effectiveStoredFieldMap) was never derived automatically: it is not asked for a
  // "Mark verified" (dry-run 2026-09-28 B6 — the gate asked a person to verify the BCD 5952 and the
  // Coos County electrical maps, and verifying would have locked in their outdated stored copies).
  const unverifiedForms = loadStoredTemplates(db, project.ahj, project.state)
    .filter((t) => !t.verified && !t.builtInMap && formAllowedForPath(t.def.formName, gatePermitPath, t.applicationKind));
  const stagedRun = detail.portalRuns.find((run) => run.status === "awaiting_human_submit");
  // "SUBMITTED" MEANS EVERY REQUIRED FILING, NOT ANY ONE (S7). This was "any submission is
  // submitted, or the status says so" — so a project whose NEM application was filed while its
  // building and electrical permits still sat staged on the portal read "Submitted/tracking",
  // hid its blockers behind that decision, and never asked for the two filings still owed. The
  // per-track answer is the next-step facts' (nextStep.loadNextStepFacts — ONE "is this track
  // filed?" for the gate, the board and the project page): a submitted submissions row in the
  // track's family, a tracking target of it carrying an application number, or isTrackDone.
  //
  // THE STATUS STILL SPEAKS WHEN NOTHING ELSE DOES. A project moved past Submit by an operator
  // override, with no filing recorded on any track, would otherwise read "ready to stage" and
  // enable the trackless Prepare Submittal on an application that is already at the agency — a
  // duplicate draft on a live portal. Only that zero-evidence case falls back to the status; a
  // partial filing (evidence on some track) is judged per track.
  const gateFacts = loadNextStepFacts(db, [project]).get(projectId);
  const gateTracks = (gateFacts?.tracks ?? []).map((t) => t.track);
  const unfiledTracks = (gateFacts?.tracks ?? []).filter((t) => !t.filed && !t.done).map((t) => t.track);
  const noFilingEvidence = unfiledTracks.length === gateTracks.length;
  const statusSaysFiled = stageForStatus(project.status).index >= stageForStatus("submitted").index;
  const submittedOrBeyond = unfiledTracks.length === 0 || (noFilingEvidence && statusSaysFiled);
  const activeEmailSource = activeEmailSources[0];

  const checks: SubmitGateCheck[] = [
    submitGateCheck({
      id: "single-project-record",
      title: "Single project record",
      lane: "intake",
      status: missingCritical.length ? "blocker" : waitingOnBill.length ? "warning" : "pass",
      ownerRole: "Intake Coordinator",
      requirement: "Homeowner, service address, AHJ, utility, account, meter, system size, and interconnection method must be captured before PermitFlow or NEMflow staging.",
      evidence: [
        // The wait first: the evidence is capped at six lines and nine "captured" lines follow.
        ...(waitingOnBill.length ? [`Waiting on the customer's utility bill: ${waitingOnBill.join(", ")} (read from the bill; needed for the NEM application only)`] : []),
        ...(missingCritical.length ? missingCritical.map((field) => `Missing: ${field}`) : criticalFields.filter(([label]) => !waitingOnBill.includes(label)).map(([label, value]) => `${label}: ${hasValue(value) ? "captured" : "missing"}`)),
      ],
      nextAction: missingCritical.length
        ? `Resolve missing source-of-truth fields: ${missingCritical.join(", ")}.`
        : waitingOnBill.length
          ? `Waiting on the customer's utility bill for the ${waitingOnBill.join(" and ").toLowerCase()} number — upload it or send an intake request. The permit side can proceed.`
          : "Use this record as the source for every form, portal, and tracker.",
      source: "project.fields",
      // Each missing field holds only the filings that ask for it — the scope prepareSubmission's
      // own field gate uses (gateScope.criticalFieldHoldScope): an account number never holds the
      // AHJ permit, the AHJ never holds the utility's application.
      ...(missingCritical.length ? { holds: missingCritical.map((label) => ({ label: `Missing: ${label}`, tracks: tracksHeld(criticalFieldHoldScope(label)) })) } : {}),
    }),
    submitGateCheck({
      id: "submitting-client",
      // The CCB is OREGON's contractor board. Outside Oregon the check asks for a client and
      // reports the licence on file for the project's state — it never asks a Pennsylvania job
      // for a CCB number (new-AHJ e2e, 2026-09-26), and an unknown requirement stays a warning.
      title: licence?.oregon ? "Submitting client & CCB" : "Submitting client & contractor licence",
      lane: "intake",
      status: !submittingClientRow ? "blocker"
        : licence!.oregon ? (licence!.number ? (planSetLicenceDoubt ? "warning" : "pass") : "blocker")
        : licenceByTrack.length && !licenceMissingTracks.length && !planSetLicenceDoubt ? "pass" : "warning",
      ownerRole: "Intake Coordinator",
      requirement: licence?.oregon || !submittingClientRow
        ? "A submitting client with a CCB/contractor license must be assigned, so the filing uses the correct contractor — never default or another client's info."
        : `A submitting client must be assigned, so the filing uses the correct contractor — never default or another client's info. The contractor licence ${licence!.state || "this state"} / the AHJ require is on the application form.`,
      evidence: !submittingClientRow
        ? ["No submitting client assigned to this project."]
        : [
            `Client: ${String(submittingClientRow.company_name || submittingClientRow.legal_business_name || "(unnamed)")}`,
            ...(licence!.oregon
              ? [licence!.number ? `${licence!.label}: ${licence!.number}` : `No CCB license on file${licence!.reason && /placeholder/.test(licence!.reason) ? ` (${licence!.reason.replace(/^.*?; /, "")})` : ""}.`]
              : licenceByTrack.length
                ? licenceByTrack.slice(0, 3).map(({ track: t, answer: a }) => a.number
                  ? `${t} permit: ${a.label} ${a.number}`
                  : `${t} permit: ${a.reason || `no ${licence!.state} licence on file`}`)
                // No permit track could be read: the trackless answer, candidates named — never
                // "none on file" for a client that holds several.
                : [licence!.number ? `${licence!.label}: ${licence!.number}` : licence!.candidates.length ? `Several ${licence!.state} licences on file: ${licence!.candidates.join("; ")}` : `No contractor licence for ${licence!.state || "this state"} on file.`]),
            ...(planSetLicenceDoubt ? [planSetLicenceDoubt] : []),
          ],
      nextAction: !submittingClientRow
        ? "Assign the submitting client in the project header before staging."
        : planSetLicenceDoubt
          ? "Confirm the project is assigned to the right company — the plan set's title-block licence is another client's. Reassign the client in the project header if it is."
          : licence!.oregon
            ? (licence!.number ? "Verified — this client's contractor info will be used on the filing." : "Add the client's CCB license number in the Clients tab.")
            : !licenceMissingTracks.length && licenceByTrack.length
              ? "Verified — this client's licence for each permit will be used on the filing."
              : `Confirm which contractor licence ${licence!.state || "the state"} and ${project.ahj || "the AHJ"} require on the ${licenceMissingTracks.map((t) => t.track).join(" / ") || "permit"} application, and add it (with its type) to the client's state licences in the Clients tab.`,
      source: "project.client",
    }),
    submitGateCheck({
      id: "ahj-form-mapping-verified",
      title: "AHJ form mapping verified",
      lane: "permit",
      // WARNING, not a staging blocker: staging only FILLS the portal to its review screen and
      // stops — it never submits — and prepareSubmission() does not enforce form-mapping
      // verification, so making this a hard blocker greyed out "Prepare Submittal" (and blocked
      // unrelated NEM stages on an AHJ-permit check). Form-mapping verification belongs at the
      // human FINAL-SUBMIT gate (manualSubmitChecklist), which is unchanged. Surfaced here so the
      // operator still sees + clears it before they submit.
      status: unverifiedForms.length ? "warning" : "pass",
      ownerRole: "Permit Coordinator",
      requirement: "An auto-acquired or uploaded AHJ form whose field and signature placement was derived automatically (read from the PDF or mapped by AI) must be previewed by a person and its mapping marked verified before the final submit. A form filled from a built-in map written for its exact official revision (matched by the blank's fingerprint) needs no mapping verification.",
      evidence: unverifiedForms.length
        ? unverifiedForms.map((t) => `Unverified mapping: ${t.def.formName}`)
        : ["All matched AHJ forms are built-in or operator-verified."],
      nextAction: unverifiedForms.length
        ? `Open Build → App Docs, download each filled form, confirm the fields/signature are correct, then click "Mark verified": ${unverifiedForms.map((t) => t.def.formName).join(", ")}.`
        : "AHJ form mappings are verified.",
      source: "ahj_form_templates.verified",
    }),
    // PERMIT-PATH gate — mirrors the actual prepareSubmission() 409 guard (the prescriptive and
    // engineered applications are mutually exclusive; the AHJ takes exactly one). This is a REAL
    // staging blocker: prepareSubmission throws 409 when the path is unknown, so surfacing it here
    // keeps the Prepare Submittal button honest (it was previously a hidden surprise-409 on click).
    // OUTSIDE A SPLIT JURISDICTION THE CHECK SAYS WHAT THE REVIEW IS (e2e-gap close, 2026-09-26):
    // "Permit path confirmed (prescriptive vs engineered) … mutually exclusive" PASSED on every MA /
    // NM / PA / AZ / IA job — Oregon's sentence, stated as that AHJ's rule. There it is one building
    // application: a standard structural review, or a stamped one when the plan set is engineered.
    gatePathResolution.standardReview
      ? submitGateCheck({
        id: "permit-path",
        title: gatePathResolution.needsEngineeredDocs ? "Permit path: stamped structural review" : "Permit path: standard structural review",
        lane: "permit",
        status: "pass",
        ownerRole: "Permit Coordinator",
        requirement: "This jurisdiction files one building-side application (no prescriptive rooftop-PV path on file), so there is no permit-path choice to confirm before staging.",
        evidence: [gatePathResolution.needsEngineeredDocs
          ? "Stamped structural review: the plan set / operator calls for an engineered structural design — the PE-stamped plan set and sealed structural letter are on the required-documents list."
          : "Standard structural review: the AHJ's building application with the roof framing + attachment detail; a PE-sealed letter only where the jurisdiction's own rule requires one."],
        nextAction: "Nothing to confirm — file the AHJ's own building application.",
        source: "permit.path",
      })
      : submitGateCheck({
        id: "permit-path",
        title: "Permit path confirmed (prescriptive vs engineered)",
        lane: "permit",
        // A PRESCRIPTIVE path whose own BCD 5952 answers a row No is said, never staged silently: the
        // checklist says a No row may not be submitted on the prescriptive path (dry-run B4c). Operator
        // ruling pending: a 5952 No row warns, it does not route engineered — the screen
        // (permitPath.ts) routes on the roofing row only, so the path resolves prescriptive here
        // (a real issued Coos Bay permit for a 48 in / 120 mph Exposure C design was prescriptive).
        status: gatePermitPath === "unknown" ? "blocker" : gatePermitPath === "prescriptive" && prescriptiveChecklistNo.length ? "warning" : "pass",
        ownerRole: "Permit Coordinator",
        requirement: "The prescriptive and engineered (PE-stamped) permit applications are mutually exclusive and the AHJ accepts exactly one. The permit path must be confirmed before the AHJ permit can be staged.",
        evidence: [
          gatePermitPath === "unknown" ? "Permit path not yet confirmed for this project." : `Permit path: ${gatePermitPath}.`,
          ...(gatePermitPath === "prescriptive" ? prescriptiveChecklistNo.map((clause) => `BCD 5952 ${clause}`) : []),
        ],
        nextAction: gatePermitPath === "unknown"
          ? "Set the permit path on Manual entry → Permit path (prescriptive vs engineered) before staging the AHJ permit."
          : gatePermitPath === "prescriptive" && prescriptiveChecklistNo.length
            ? "The permit path is prescriptive, but this job's BCD 5952 answers a row No — and the checklist says a No row may not be submitted on the prescriptive path. Confirm with the AHJ, change the design (e.g. re-space the attachments), or choose the engineered path (Manual entry → Permit path)."
            : "Permit path is confirmed.",
        source: "permit.path",
        // prepareSubmission asks the path only off the NEM lane.
        ...(gatePermitPath === "unknown" ? { holds: [{ label: "Permit path not confirmed", tracks: tracksHeld("permit") }] } : {}),
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
        ...pendingCritical.slice(0, 4).map((item) => `Pending human review: ${item.issueType || item.fieldName}`),
        ...qcWarnings.slice(0, 3).map((item) => `Warning: ${item.ruleName}`),
      ],
      nextAction: qcFails.length
        ? `Resolve ${qcFails.length} QC failure(s), then rerun QC.`
        : pendingCritical.length
          ? `Approve or edit ${pendingCritical.length} pending item(s) in the Human Review queue (no QC failures remain).`
          : qcWarnings.length ? "Review warning values against source evidence before staging." : "QC is clear.",
      source: "qc.human_review",
    }),
    submitGateCheck({
      id: "permit-requirements",
      title: "PermitFlow reviewer and history check",
      lane: "permit",
      // Only REAL AHJ reviewer blockers and blocker-severity historical patterns gate
      // staging — matching the actual prepareSubmission() guard, which reads the same
      // severities (reviewerGateReportFor, #214; reviewerSeverityParity.test.ts). Blocked process-map
      // steps are derived from conditions already covered by the dedicated QC / docs /
      // reviewer checks, so they're advisory here (warning) and never double-count into
      // a false "can't submit".
      status: reviewerBlockers.length || learnedHistoricalBlockers.length ? "blocker" : reviewerWarnings.length || historicalMissing.length || blockedPermitSteps.length ? "warning" : "pass",
      ownerRole: "Permit Ops",
      requirement: "AHJ-style reviewer blockers and learned historical blocker patterns must be resolved before permit staging.",
      evidence: [
        ...reviewerBlockers.slice(0, 4).map((finding) => `${finding.title}: ${finding.evidenceStatus}`),
        ...learnedHistoricalBlockers.slice(0, 4).map((item) => `Historical blocker: ${item.title}`),
        ...blockedPermitSteps.slice(0, 3).map((step) => `${step.label}: ${step.nextAction}`),
        ...reviewerWarnings.slice(0, 2).map((finding) => `Warning: ${finding.title}`),
      ],
      nextAction: reviewerBlockers.length || learnedHistoricalBlockers.length ? "Clear AHJ blocker callouts and learned historical gaps before staging." : reviewerWarnings.length || historicalMissing.length || blockedPermitSteps.length ? "Confirm warnings and checklist gaps with evidence." : "PermitFlow requirements are clear.",
      source: "requirements.reviewer.history",
      // Each finding holds only the filings it is about (gateScope.findingHoldScope: a structural
      // conflict holds the building permit, not the utility's application nor the separate
      // electrical permit); a learned pattern by its own words (historicalBlockerScope).
      ...(reviewerBlockers.length || learnedHistoricalBlockers.length ? {
        holds: [
          ...reviewerBlockers.map((f) => ({ label: f.title, tracks: tracksHeld(findingHoldScope(f)) })),
          ...learnedHistoricalBlockers.map((item) => ({ label: `Historical blocker: ${item.title}`, tracks: tracksHeld(historicalBlockerScope(historicalReport, item)) })),
        ],
      } : {}),
    }),
    submitGateCheck({
      id: "ahj-nem-docs",
      title: "AHJ and NEM document packet",
      lane: applicationDocs.missingFields.some((field) => /utility|account|meter|interconnection|nem/i.test(field)) ? "nem" : "permit",
      // WARNING, not a staging blocker: these are DATA fields needed to GENERATE the forms, which
      // prepareSubmission() does not enforce (it enforces the document-inventory FILE-presence gate
      // and the adapter-specific portal-field gate separately). Keeping it a hard blocker over-blocked
      // the shared Prepare Submittal button. Surfaced as a warning so gaps are visible pre-submit.
      status: applicationDocs.missingFields.length ? "warning" : applicationDocs.docs.length ? "pass" : "warning",
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
    // THE document-presence gate. Verifies the actual required FILES are attached (or
    // identified in the uploaded plan set) — not just that the parser mentioned them.
    // This is what stops "documents still missing" rejections: a missing blocking
    // document (plan set, SLD, site plan, structural, module/inverter spec, or the
    // PE-stamped structural docs on the engineered path) hard-blocks submit.
    //
    // It asks for what the operator OWES (owedMissingDocuments) — the same predicate Stage portals
    // and Approve read. A form the staging-time fill produces from a stored template is not the
    // operator's to attach, so it is said (its own evidence line) and never blocks: counting it
    // here put "The submit gate is blocked: … checklist, filled" and phase BLOCKED beside an
    // ENABLED Stage portals (29cd57b5, e6b3afde). prepareSubmission still re-counts after its
    // fill, so a blank that fails to fill is still refused there.
    //
    // A FORM STAGE DOWNLOADS ITSELF IS NOT OWED EITHER (gates-proper C1): the issuing agency's curated
    // seed (Michael's Marion B-01S / E-01), a cited agency PDF the model may map, the AHJ's own seed /
    // the BCD 5952, or research on an open cooldown — owedMissingDocuments' third bucket, read off the
    // acquisition's own plan. It is said ("Stage downloads and fills it") and never blocks; the check
    // is a WARNING so it is seen. What IS owed says what to do about it: a form nothing will fetch is
    // "find the official form or upload the blank", a file is "attach it or split it out".
    submitGateCheck({
      id: "document-inventory",
      title: "Required documents attached",
      lane: gateDocs.owed.some((d) => d.lane === "nem") && !gateDocs.owed.some((d) => d.lane === "permit") ? "nem" : "permit",
      // An application set nobody knows is a WARNING (seen, never blocking) — never "pass".
      status: gateDocs.owed.length ? "blocker" : docInventory.missingAdvisory.length || gateDocs.acquiredAtStaging.length || docInventory.applicationSetUnknown ? "warning" : "pass",
      ownerRole: "Permit Ops",
      requirement: "Every required submittal document must be attached as a file (or identified in the uploaded plan set) before staging — the AHJ rejects incomplete packages.",
      evidence: [
        `${docInventory.presence.filter((d) => d.present).length}/${docInventory.required.length} required documents present${gateDocs.filledAtStaging.length ? `, ${gateDocs.filledAtStaging.length} more filled from a stored template at staging` : ""}${gateDocs.acquiredAtStaging.length ? `, ${gateDocs.acquiredAtStaging.length} more downloaded and filled by Stage` : ""}.`,
        // Never dropped by the evidence cap ("NOT KNOWN:" names a document question, like MISSING):
        // the count above is of a set that may not include the AHJ's applications at all.
        ...(docInventory.applicationSetUnknown ? [`NOT KNOWN: ${docInventory.applicationSetUnknown}`] : []),
        ...docInventory.presence.filter((d) => d.present).slice(0, 4).map((d) => documentPresenceLine(d.label, d.via)),
        ...gateDocs.filledAtStaging.map((d) => `Filled at staging: ${d.label} — the form's template is on file; staging fills it and offers it to any upload slot that asks for it (check the portal's attachment list before submitting)`),
        ...gateDocs.acquiredAtStaging.map((d) => `Stage downloads and fills it: ${d.label} — ${acquisitionSentence(gateDocs.acquiredVia.get(d))}`),
        ...gateDocs.owed.map((d) => `MISSING (required): ${d.label} — ${d.why}`),
        ...docInventory.missingAdvisory.map((d) => `Missing (advisory): ${d.label}`),
      ],
      nextAction: !gateDocs.owed.length && !docInventory.missingAdvisory.length && docInventory.applicationSetUnknown
        ? docInventory.applicationSetUnknown
        : gateDocs.owed.length
        ? `Missing before staging: ${gateDocs.owed
            .map((d) => `${d.docType === "structural_letter" && d.why ? `${d.label} (${d.why})` : d.label} — ${owedDocumentAction(d)}`)
            .join("; ")}.`
        : docInventory.missingAdvisory.length
          ? "Confirm the advisory document(s) are included in the plan set."
          : gateDocs.acquiredAtStaging.length
            ? `Nothing to attach: Stage downloads and fills ${gateDocs.acquiredAtStaging.map((d) => d.label).join("; ")}${gateDocs.filledAtStaging.length ? `, and fills ${gateDocs.filledAtStaging.map((d) => d.label).join("; ")} from stored templates` : ""}. If a download fails, Stage says so and stops.`
            : gateDocs.filledAtStaging.length
              ? `All required documents are attached; staging fills the rest from stored templates: ${gateDocs.filledAtStaging.map((d) => d.label).join("; ")}.`
              : "All required documents are attached.",
      source: "documents.inventory",
      // Each owed document holds the filings prepareSubmission's own filter says carry it
      // (stagingMissingDocuments: lane, then discipline) — asked here once, for every track.
      ...(gateDocs.owed.length ? {
        holds: gateDocs.owed.map((d) => ({
          label: d.label,
          action: owedDocumentAction(d),
          tracks: GATE_TRACKS.filter((t) => stagingMissingDocuments({ ...docInventory, missingBlocking: [d] }, t).length > 0),
        })),
      } : {}),
    }),
    submitGateCheck({
      id: "nem-preflight",
      title: "NEMflow preflight",
      lane: "nem",
      // WARNING, not a staging blocker: prepareSubmission() does not enforce NEM evidence topics
      // (account/meter/SLD/inverter proof) — for a real NEM stage it enforces the account/meter
      // PORTAL FIELDS via validatePortalFields, which is the actual guard. Hard-blocking here greyed
      // out the shared Prepare Submittal button (and blocked unrelated AHJ-permit stages). Surfaced
      // as a warning so the operator verifies NEM evidence before the human final submit.
      status: nemEvidenceMissing.length || blockedNemSteps.length || openNemCorrections.length ? "warning" : !utilityEvidenceOk || accountEvidence.confidence === "medium" || meterEvidence.confidence === "medium" || waitingNemSteps.length ? "warning" : "pass",
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
      // Advisory only — this packet aggregates process-step / correction / missing-field
      // signals that are ALREADY gated by the dedicated QC, docs, and reviewer checks.
      // Counting it as an independent hard blocker double-counted those and produced a
      // false "can't submit" when the reviewer gate itself had zero blockers.
      status: installerPacket.blockerCount || installerPacket.warningCount ? "warning" : "pass",
      ownerRole: installerPacket.items[0]?.ownerRole || "Operations",
      requirement: "Installer, designer, and NEM Ops callouts should be reviewed before the company sends a package to AHJ or utility intake.",
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
        submittedOrBeyond
          ? `Project status: ${project.status}`
          : unfiledTracks.length < gateTracks.length
            ? `Still to file: ${unfiledTracks.join(", ")} (every other required track is filed).`
            : "Project has not been manually submitted yet.",
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
  if (outcome === "ready_for_issue" || outcome === "issued" || outcome === "reviewed_by_ahj" || isNemApprovalOutcome(outcome)) return "pass";
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
      title: `Human review ${item.status}: ${item.issueType || item.fieldName}`,
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
      title: `Correction: ${humanizeBucket(correction.correctionBucket)}`,
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
      title: `Permit/NEM status: ${check.statusLabel || humanizeEnum(check.outcome)}`,
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

export function getEmailTrackerStatus(db: AppDb, orgId: string | null = DEFAULT_ORG_ID): { sources: EmailTrackingSource[]; recentMatches: EmailProjectMatch[] } {
  return {
    sources: (orgId
      ? db.query<Row>("SELECT * FROM email_tracking_sources WHERE org_id = ? ORDER BY active DESC, updated_at DESC", [orgId])
      : db.query<Row>("SELECT * FROM email_tracking_sources ORDER BY active DESC, updated_at DESC"))
      .map(mapEmailTrackingSource),
    // email_project_matches carries no org of its own — it reaches one through the
    // project it matched, which is the grain that actually owns the row.
    recentMatches: (orgId
      ? db.query<Row>(
          `SELECT m.* FROM email_project_matches m
           JOIN projects p ON p.id = m.project_id AND p.org_id = ?
           ORDER BY m.created_at DESC LIMIT 50`,
          [orgId],
        )
      : db.query<Row>("SELECT * FROM email_project_matches ORDER BY created_at DESC LIMIT 50"))
      .map(mapEmailProjectMatch),
  };
}

export function configureEmailTrackingSource(
  db: AppDb,
  input: { filePath?: string; label?: string; defaultState?: string; defaultAhj?: string; defaultUtility?: string; active?: boolean; orgId?: string },
): { sources: EmailTrackingSource[]; recentMatches: EmailProjectMatch[] } {
  const filePath = path.resolve(String(input.filePath || "").trim());
  if (!String(input.filePath || "").trim()) throw new HttpError(400, "MBOX watch path is required.");
  const label = text(input.label) || path.basename(filePath) || "Watched MBOX";
  const ts = nowIso();
  db.run(
    `INSERT INTO email_tracking_sources
      (id, source_type, label, file_path, default_state, default_ahj, default_utility, active,
       last_message_count, last_matched_count, last_error, org_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      // org_id is set on create and deliberately NOT in the DO UPDATE list: a watched
      // source never changes tenant, and its org is what scopes every project it can
      // match an inbound email to.
      input.orgId || DEFAULT_ORG_ID,
      ts,
      ts,
    ],
  );
  return getEmailTrackerStatus(db, input.orgId || DEFAULT_ORG_ID);
}


function containsLoose(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeTokens(needle);
  return normalizedNeedle.length >= 4 && haystack.includes(normalizedNeedle);
}

function containsIdentifier(raw: string, value: string): boolean {
  const needle = compactAlnum(value);
  return needle.length >= 5 && compactAlnum(raw).includes(needle);
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

/**
 * WHICH TRACKING TARGET AN INBOUND EMAIL IS FILED ON — the target of the email's OWN track.
 *
 * This used to be "the project's newest target, whoever sent the email" (firstPermitTargetId).
 * With the classifier reading the TARGET's track, an AHJ plan-review approval landing on a NEM
 * target created later read nem_approved: the NEM track finished, the project said the utility
 * had approved the interconnection, and the client was told so (decisions-0926 skeptic MF1;
 * production project 720b05f3 has exactly that shape — NEM target newest beside two permits).
 *
 * The email classifier already says which workflow the message is about
 * (message.record.workflow: "permit" | "nem" | "both" | "unknown"), so:
 *   - "permit" -> the newest ACTIVE permit-kind target; "nem" -> the newest ACTIVE NEM-kind target
 *     (kind by trackKind — the ONE answer to "what track is this target", never raw target_type);
 *   - no active target of that kind, or a workflow that names no single track ("both", "unknown")
 *     -> null: the reading is recorded as a check row with NO target. NEVER the other track's
 *     target, and never an inactive one (a retired filing is not this email's).
 * The caller passes the email's track alongside so a no-target reading is still WORDED as the
 * filing it is about (recordPermitStatusCheck's `track` input).
 *
 * WHERE IT IS FILED IS NOT WHAT IT MAY WRITE (decisions-0926-final, fail-closed). An email is a
 * third party's prose routed by a classifier, so whatever target this picks, the writer refuses
 * every finishing outcome from it (readingMayFinishTrack: source email) — the row lands as
 * "Reported, unconfirmed" with a human-review item, and a poll or an operator's re-check against
 * the target is what finishes the track. The classifier's mistakes (an AHJ approval that mentions
 * the utility bucketed nem) can therefore mis-FILE a reading, never mis-FINISH a track.
 */
export function emailTrackTargetId(db: AppDb, projectId: string, workflow: string): { targetId: string | null; track: TrackKind | null } {
  const track: TrackKind | null = workflow === "permit" || workflow === "nem" ? workflow : null;
  if (!track) return { targetId: null, track: null };
  const rows = db.query<Row>("SELECT id, target_type, permit_type FROM permit_check_targets WHERE project_id = ? AND active = 1 ORDER BY created_at DESC", [projectId]);
  const own = rows.find((row) => trackKind(text(row.target_type), text(row.permit_type)) === track);
  return { targetId: own ? text(own.id) : null, track };
}

function extractTrackingNumber(raw: string, labels: RegExp[]): string {
  for (const label of labels) {
    const match = raw.match(label);
    if (match?.[1]) return match[1].trim().slice(0, 80);
  }
  return "";
}

/**
 * Find the project an inbound tracked email belongs to.
 *
 * ALWAYS org-scoped. This used to take an OPTIONAL clientId and, when it was absent,
 * load every project in the database and fuzzy-match the email against all of them —
 * and `clientId` came from `email_tracking_sources.client_id`, which is nullable, so
 * the unscoped branch was the DEFAULT for any source without a client set. A match
 * writes an email_project_matches row, records a permit status check, can open a
 * correction and transition project status, so that was a cross-tenant WRITE: one
 * company's AHJ correction email could land on another company's project.
 *
 * Scope comes from the SOURCE ROW, never from a caller-supplied argument, so a caller
 * cannot widen it. clientId only ever NARROWS within the org.
 */
function matchProjectForEmail(
  db: AppDb,
  message: ClassifiedMboxMessage,
  scope: { orgId: string; clientId?: string },
): { project: ProjectRecord; confidence: number; reason: string } | null {
  const raw = message.rawSearchText;
  const haystack = normalizeTokens(raw);
  const projects = scope.clientId
    ? db.query<ProjectRow>("SELECT * FROM projects WHERE org_id = ? AND client_id = ? ORDER BY updated_at DESC", [scope.orgId, scope.clientId]).map(mapProject)
    : db.query<ProjectRow>("SELECT * FROM projects WHERE org_id = ? ORDER BY updated_at DESC", [scope.orgId]).map(mapProject);
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
    if (project.utility && (containsLoose(haystack, project.utility) || normalizeTokens(message.record.utility || "") === normalizeTokens(project.utility))) {
      score += 15;
      reasons.push("utility");
    }
    const jurisdiction = message.record.jurisdiction || "";
    if (project.ahj && (containsLoose(haystack, project.ahj) || normalizeTokens(jurisdiction) === normalizeTokens(project.ahj))) {
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
  input: { sourceId?: string; filePath?: string; clientId?: string; orgId?: string } = {},
): Promise<EmailTrackerRunResult> {
  const sourceRows = input.filePath
    ? [{
        id: "",
        label: path.basename(path.resolve(input.filePath)),
        file_path: path.resolve(input.filePath),
        default_state: "",
        default_ahj: "",
        default_utility: "",
        // Ad-hoc one-off import (no stored source row): the caller's org is the only
        // scope available, defaulting to the single-operator tenant.
        org_id: input.orgId || DEFAULT_ORG_ID,
        client_id: input.clientId ?? null,
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
    // Tenant scope for everything this source produces, read from the source row —
    // never from the caller, so a caller can't widen it.
    const sourceOrgId = text(source.org_id) || DEFAULT_ORG_ID;
    const sourceClientId = text(source.client_id) || undefined;
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
        orgId: sourceOrgId,
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
        const match = matchProjectForEmail(db, message, { orgId: sourceOrgId, clientId: sourceClientId });
        if (!match) {
          result.unmatchedMessages += 1;
          continue;
        }

        const before = getProjectDetail(db, match.project.id);
        // THE EMAIL'S OWN TRACK picks the target (emailTrackTargetId) — never the project's newest.
        const filing = emailTrackTargetId(db, match.project.id, text(message.record.workflow));
        const applicationNumber = extractTrackingNumber(message.rawSearchText, [/\b(?:application|app|record)\s*(?:number|#|no\.?)?\s*[:#-]?\s*([A-Z0-9-]{4,})/i]);
        const permitNumber = extractTrackingNumber(message.rawSearchText, [/\bpermit\s*(?:number|#|no\.?)?\s*[:#-]?\s*([A-Z0-9-]{4,})/i]);
        const updated = await recordPermitStatusCheck(db, match.project.id, {
          targetId: filing.targetId,
          track: filing.track,
          source: "email",
          rawStatusText: emailStatusText(message),
          applicationNumber,
          permitNumber,
          noticedAt: message.record.occurredAt || null,
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
          // Where the reading was filed: the email's own track's target, or none (no target of
          // that kind on this project, or a workflow naming no single track).
          targetId: filing.targetId,
          track: filing.track,
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
  const report = buildHistoricalFailureReport(db, projectId, null);
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
  const historicalReport = buildHistoricalFailureReport(db, projectId, null);
  const reviewerReport = reviewerGateReportFor(db, detail.project);
  const applicationDocs = buildApplicationDocumentPackage(detail.project);

  const qcFails = detail.qcResults.filter((item) => item.qcStatus === "fail").length;
  const qcWarnings = detail.qcResults.filter((item) => item.qcStatus === "warning").length;
  const pendingReview = detail.humanReviewItems.filter(isCriticalReviewItem).length;
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
  input: { orgId: string; mboxText: string; sourceLabel?: string; defaultState?: string; defaultAhj?: string; defaultUtility?: string },
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

// Stream a large local mbox file from disk (no full-file string load).
export async function importKnowledgeFromMboxFile(
  db: AppDb,
  input: { orgId: string; filePath: string; sourceLabel?: string; defaultState?: string; defaultAhj?: string; defaultUtility?: string },
): Promise<MboxKnowledgeImportResult> {
  const result = await importMboxKnowledgeFromFile(db, input);
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
  const { detail, pkg, learned } = assembleApplicationDocumentPackage(db, projectId);

  addAuditLog(db, projectId, "system", "application doc builder", "application_docs.generated", {
    profile: pkg.profile.id,
    docCount: pkg.docs.length,
    missingFields: pkg.missingFields,
    missingDocuments: (pkg.missingDocuments || []).map((d) => d.docType),
    // Without this the trail records the same empty list for "nothing is missing" and for
    // "we could not find out" — the distinction the field above exists to keep.
    missingDocumentsStatus: pkg.missingDocumentsStatus ?? null,
    ...(pkg.missingDocumentsError ? { missingDocumentsError: pkg.missingDocumentsError } : {}),
    learnedProfile: learned ? `${learned.state}:${learned.ahj}:${learned.utility}` : null,
  });

  // `ready_to_stage` GETS ITS WRITER — this is it.
  //
  // The status was labelled ("Ready to stage"), bannered with an instruction ("Docs built. Click
  // 2 · Reviewer Gate, then 3 · Prepare Submittal."), offered as a board filter and mapped into
  // the Build & Validate stage — and NOTHING anywhere could write it. A project that had just
  // had its AHJ/NEM documents built still read `qc_passed`, so the board could not tell "QC is
  // done" from "the packet exists", and the banner the operator needed was unreachable copy.
  //
  // THE GATE IS ONE ONE-WAY EDGE, AND IT IS NARROW ON PURPOSE:
  //  * only from `qc_passed` — the single status that means "verified, nothing built yet". From
  //    any other status (staged, submitted, in corrections, issued) this function stays exactly
  //    what it has always been: a pure read that writes nothing but its own audit row. That
  //    matters because the packet is fetched on the project screen and by the /research-ahj
  //    route, not only by the Build Docs button.
  //  * only when documents were actually produced (`pkg.docs.length > 0`). An empty package is
  //    a failure to build, and a failure must never read as progress.
  //
  // WHAT IT DOES NOT TOUCH: `stage_detail`. QC's verdict is still the most recent thing any
  // writer has actually established about this project, and overwriting it with a "docs built"
  // shade would invent a sub-stage nobody measured. The reviewer gate speaks next (below), and
  // that is the event that replaces it.
  if (detail.project.status === "qc_passed" && pkg.docs.length > 0) {
    db.run("UPDATE projects SET status = 'ready_to_stage', current_stage = ?, updated_at = ? WHERE id = ?", [
      `AHJ/NEM documents built (${pkg.profile.name}) — ready to stage.`,
      nowIso(),
      projectId,
    ]);
    addAuditLog(db, projectId, "system", "application doc builder", "project.ready_to_stage", {
      from: "qc_passed", profile: pkg.profile.id, docCount: pkg.docs.length,
    });
  }
  return pkg;
}

// The package itself, with no writes: no audit row, no status edge. The builder and the
// read-only stage-results view (below) must show the same packet, so both go through here.
function assembleApplicationDocumentPackage(db: AppDb, projectId: string) {
  const detail = getProjectDetail(db, projectId);
  const client = detail.project.clientId ? (() => { try { return getClient(db, detail.project.clientId!); } catch { return null; } })() : null;
  // Each issuing-agency line's status from the inventory the fill and the gate read (agency-apps-close MF3).
  const pkg = buildApplicationDocumentPackage(detail.project, client, { agencyStatus: agencyListStatusResolver(db, detail.project) });

  // A MISSING DOCUMENT IS NOT A MISSING FIELD, AND THE PACKET SCREEN SAID IT WAS.
  //
  // pkg.missingFields is fifteen SCALAR field checks (requiredProjectFields) — not one
  // of them ever looks at a document. The screen rendered "No critical document fields
  // missing from the generated packet" out of it, which reads as "the packet is
  // complete", and two permits went out that way with an application never attached.
  //
  // documentInventory answers the question the sentence appeared to answer. It lands in
  // its OWN field: missingFields feeds packageReady and four stage-status computations,
  // so widening it would change four things to fix one. Never fatal — the packet screen
  // must still render for a project whose inventory cannot be resolved.
  // AND A FAILURE TO ANSWER IS NOT AN ANSWER OF "NOTHING".
  //
  // This catch used to be bare. documentInventory throwing left missingDocuments undefined,
  // the packet screen's `pkg.missingDocuments || []` turned that into an empty list, and the
  // pass-styled "every required document is attached" printed — the exact sentence this
  // block was added to stop, reproduced by the error path. The old excuse ("the staging gate
  // is the authority") does not hold either: the staging gate calls the SAME
  // documentInventory, so it goes quiet in the same breath rather than offering a second
  // opinion. So the failure is REPRESENTABLE now (missingDocumentsStatus) instead of being
  // an absence that reads as good news, and it is logged rather than discarded.
  //
  // ONE QUESTION, ONE PREDICATE: "what is missing" here is what the operator OWES — the same
  // owedMissingDocuments the submit gate and Stage / Approve read. A form the staging-time fill
  // produces from a stored template is held out of missingDocuments and NAMED in
  // filledAtStagingDocuments; listing it as missing put "checklist NOT in the packet" on this
  // screen beside a gate that said "filled at staging" (e6b3afde, 29cd57b5). prepareSubmission's
  // post-fill check stays on the raw inventory — the fill has already run there.
  try {
    const inventory = documentInventory(db, detail.project);
    const gateDocs = owedMissingDocuments(db, detail.project, inventory);
    const row = (d: DocPresence) => ({ docType: d.docType, label: d.label, lane: d.lane, why: d.why, ...(d.verifiedList ? { verifiedList: d.verifiedList } : {}) });
    // Nothing known about this AHJ's applications: the packet says so instead of an all-clear.
    if (inventory.applicationSetUnknown) pkg.applicationSetUnknown = inventory.applicationSetUnknown;
    pkg.missingDocuments = gateDocs.owed.map(row);
    pkg.filledAtStagingDocuments = gateDocs.filledAtStaging.map(row);
    pkg.acquiredAtStagingDocuments = gateDocs.acquiredAtStaging.map((d) => ({
      ...row(d),
      why: acquisitionSentence(gateDocs.acquiredVia.get(d)),
      via: gateDocs.acquiredVia.get(d)?.via ?? "curated",
      sourceUrl: gateDocs.acquiredVia.get(d)?.sourceUrl ?? "",
      ...(gateDocs.acquiredVia.get(d)?.inFlight ? { inFlight: gateDocs.acquiredVia.get(d)!.inFlight } : {}),
    }));
    pkg.missingDocumentsStatus = "resolved";
  } catch (err) {
    // Leave missingDocuments ABSENT on purpose: [] would be a claim we cannot make.
    pkg.missingDocuments = undefined;
    pkg.missingDocumentsStatus = "unavailable";
    pkg.missingDocumentsError = err instanceof Error ? err.message : String(err);
    logger.warn("application-docs", "the required-document inventory could not be computed — the packet cannot say what is missing", {
      projectId,
      ahj: detail.project.ahj,
      state: detail.project.state,
      error: pkg.missingDocumentsError,
    });
  }

  // Enrich with the LEARNED AHJ profile from the knowledge base. The static
  // builder only knows a handful of hardcoded jurisdictions; the KB knows many
  // more (seeded + learned from mbox/projects). When it has this AHJ, use its
  // real required-document list + portal instead of the generic fallback.
  const learned = findLearnedProfileForProject(db, {
    state: detail.project.state,
    ahj: detail.project.ahj,
    utility: detail.project.utility,
  });
  if (learned) {
    pkg.learnedRequirements = {
      ahj: learned.ahj,
      utility: learned.utility,
      portalName: learned.portalName,
      portalUrl: learned.portalUrl,
      requiredDocuments: learned.requiredDocuments,
      confidence: learned.confidence,
      correctionCount: learned.correctionCount,
      // The packet card's badge says "Verified" only from this (kbConfidenceBadge) — without it
      // an operator-verified row read "Learned + seeded" here and "Verified" on the KB list.
      verifiedAt: learned.verifiedAt,
      verifiedBy: learned.verifiedBy,
    };
    // Merge the learned required docs into the profile's list (dedup), and if the
    // builder fell back to a generic profile, adopt the learned AHJ identity. A learned line for a
    // TRACK another agency issues does not come back behind that agency's own application — the
    // same replacement the builder made (applicationDocsAgency.agencyListReplacesLine; agency-apps-close
    // MF2 at the door: Michael's card re-grew the city's "portal entry" and generic checklist lines).
    let agencyList: ReturnType<typeof issuingAgencyDocumentList> = null;
    try { agencyList = issuingAgencyDocumentList(detail.project); } catch { agencyList = null; }
    const learnedLines = learned.requiredDocuments.filter((line) => !agencyList || !agencyListReplacesLine(agencyList, line));
    pkg.profile = {
      ...pkg.profile,
      requiredDocuments: Array.from(new Set([...pkg.profile.requiredDocuments, ...learnedLines])),
      portalName: pkg.profile.portalName || learned.portalName,
      sourceUrl: pkg.profile.sourceUrl || learned.portalUrl,
      name: /generic/i.test(pkg.profile.name) && learned.ahj
        ? `${learned.ahj}${learned.utility ? ` / ${learned.utility}` : ""} (learned)`
        : pkg.profile.name,
    };
  }

  return { detail, pkg, learned };
}

// THE REVIEWER GATE'S VERDICT, RECORDED.
//
// There is no "approve" button on the reviewer gate: its approval IS the report coming back
// with zero blockers when the operator clicks 2 · Reviewer Gate. That verdict was rendered and
// then forgotten — re-open the project tomorrow and nothing on the row says the packet was ever
// checked. This records it in the machine field.
//
// stage_detail ONLY — never a status. Passing the gate does not move the job down the pipeline
// (the docs builder's `ready_to_stage` is the status, and it stays), it only says the packet is
// defensible. And only on a PRE-STAGE project: re-running the report on a staged or filed job
// must never relabel where that job actually is, least of all overwrite
// `approved_awaiting_filing` on a filing that is waiting for a person to go and submit it.
// A CLEAN VERDICT CAN GO STALE, SO THIS RECORD IS TWO-WAY. getReviewerReportWithVision records the
// gate's report FIRST (the text report plus verdicts already cached, which may land here clean) and
// only then looks at the plan sheets, and a fresh look can disagree with that cached view. A write-only recorder would leave
// "reviewer gate approved" standing on a packet the gate had just rejected — an unknown reading
// as reassurance, which is the exact failure mode this codebase keeps paying for. So blockers
// RETRACT the value, and retract nothing else: only the string this function itself wrote is
// ever cleared, so `qc_passed`, `approved_awaiting_filing` and every other writer's value are
// untouchable from here. "" is the honest unknown and renders as nothing.
const REVIEWER_GATE_RECORDABLE_STATUSES = new Set(["qc_passed", "ready_to_stage"]);
function recordReviewerGateVerdict(db: AppDb, projectId: string, report: ReviewerReport): void {
  const row = db.get<Row>("SELECT status, stage_detail FROM projects WHERE id = ?", [projectId]);
  if (!row || !REVIEWER_GATE_RECORDABLE_STATUSES.has(text(row.status))) return;
  const clean = !report.findings.some((finding) => finding.severity === "blocker");
  const stored = text(row.stage_detail);
  const next: StageDetail = clean ? "reviewer_gate_approved" : "";
  if (!clean && stored !== "reviewer_gate_approved") return; // nothing of ours to retract
  if (stored === next) return; // already says this; don't churn updated_at
  db.run("UPDATE projects SET stage_detail = ?, updated_at = ? WHERE id = ?", [next, nowIso(), projectId]);
}

export function getReviewerReport(db: AppDb, projectId: string): ReviewerReport {
  const detail = getProjectDetail(db, projectId);
  // The gate's severities (reviewerGateReportFor): the verdict recorded below is the one the gate
  // shows, so a plain GET no longer overwrites a vision-cleared verdict with the text-only one.
  const report = reviewerGateReportFor(db, detail.project);
  addAuditLog(db, projectId, "system", "ahj reviewer gate", "reviewer_report.generated", {
    blockerCount: report.findings.filter((item) => item.severity === "blocker").length,
    warningCount: report.findings.filter((item) => item.severity === "warning").length,
    installerCalloutCount: report.installerCallouts.length,
    matchedProfile: report.matchedProcessProfile ? `${report.matchedProcessProfile.state}:${report.matchedProcessProfile.ahj}` : null,
  });
  recordReviewerGateVerdict(db, projectId, report);
  return report;
}

/**
 * RE-JUDGE THE GATE WHEN AN AHJ'S DESIGN-CRITERIA LOOKUP LANDS. The first project in a new AHJ is
 * judged while its lookup is still running (the single-slot worker runs the chain first), and
 * nothing judged it again: the gate kept saying "not on file" over criteria that had since landed.
 * Called by the worker after a design_criteria_research / code_research job finishes (done or
 * failed for good). Every PRE-STAGE project (qc_passed / ready_to_stage — the statuses the gate's
 * verdict is recorded for) in that state whose AHJ resolves to the looked-up row, and whose gate
 * has already run, is re-judged: a new reviewer_report.generated audit row, the verdict recorded,
 * and an SSE event so an open project page refetches. Cached vision verdicts only (no new LLM
 * spend). Never touches a portal or a status other than the gate's own stage_detail.
 *
 * THE STATE LAYER (#107). A state-layer code_research job carries no AHJ: its editions, adoption
 * model and state minimums reach every AHJ in the state that inherits them, so `scope: "state"`
 * re-judges every pre-stage project in the state whose gate has run — same conditions, no AHJ match.
 * Without it, a project judged "lookup in progress" before the state landed stayed on model
 * defaults, and city.code.basis-mismatch never fired from the state's editions.
 *
 * ONE RE-JUDGE PER LANDING. `landedMark` (lookupLandingMark, taken by the worker in the same
 * synchronous step that wrote the job's final status) orders the landing against each re-judge. A
 * project whose lookup re-judge STARTED after that mark already read this landing (the report is
 * built synchronously from the database), so a state and an AHJ landing in the same tick produce
 * one re-judge, not two. A landing after the last re-judge started always re-judges.
 */
let lookupSeq = 0;
/** A point in the landing/re-judge order (monotonic; a counter, so two marks never tie). */
export function lookupLandingMark(): number {
  return ++lookupSeq;
}
const lookupRejudgeStartedAt = new Map<string, { mark: number; at: number }>();
const LOOKUP_REJUDGE_MEMORY_MS = 10 * 60_000;

export async function rejudgeReviewerGatesAfterLookup(
  db: AppDb,
  target: { state: string; ahj: string; scope?: "ahj" | "state" },
  trigger: string,
  opts: { landedMark?: number } = {},
): Promise<string[]> {
  const { resolveCriteriaWriteRow } = await import("./codeProfiles");
  const st = String(target.state || "").trim();
  const name = String(target.ahj || "").trim();
  const stateScope = target.scope === "state";
  if (!st || (!stateScope && !name)) return [];
  const key = stateScope ? "" : resolveCriteriaWriteRow(db, st, name)?.key;
  if (!stateScope && !key) return [];
  const now = Date.now();
  for (const [id, seen] of lookupRejudgeStartedAt) if (now - seen.at > LOOKUP_REJUDGE_MEMORY_MS) lookupRejudgeStartedAt.delete(id);
  const candidates = db.query<Row>(
    `SELECT p.id, p.ahj FROM projects p
      WHERE UPPER(TRIM(p.state)) = ? AND p.status IN ('qc_passed', 'ready_to_stage')
        AND EXISTS (SELECT 1 FROM audit_logs a WHERE a.project_id = p.id AND a.action = 'reviewer_report.generated')`,
    [st.toUpperCase()],
  );
  const rejudged: string[] = [];
  for (const row of candidates) {
    const projectId = text(row.id);
    try {
      if (!stateScope && resolveCriteriaWriteRow(db, st, text(row.ahj))?.key !== key) continue;
      const already = lookupRejudgeStartedAt.get(projectId);
      if (opts.landedMark != null && already != null && already.mark > opts.landedMark) continue;
      // Recorded before the work: a re-judge that throws still suppresses a sibling landing it would
      // have covered (best effort, like the rest of this re-judge — the next gate run corrects it).
      lookupRejudgeStartedAt.set(projectId, { mark: lookupLandingMark(), at: Date.now() });
      const detail = getProjectDetail(db, projectId);
      const report = reviewerGateReportFor(db, detail.project);
      addAuditLog(db, projectId, "system", "ahj reviewer gate", "reviewer_report.generated", {
        trigger,
        blockerCount: report.findings.filter((item) => item.severity === "blocker").length,
        warningCount: report.findings.filter((item) => item.severity === "warning").length,
        installerCalloutCount: report.installerCallouts.length,
      });
      recordReviewerGateVerdict(db, projectId, report);
      rejudged.push(projectId);
    } catch (err) {
      logger.warn("reviewer-gate", `re-judge after ${trigger} failed`, { project: projectId, err: err instanceof Error ? err.message : String(err) });
    }
  }
  if (rejudged.length) {
    const { sseBroadcast } = await import("./events");
    for (const projectId of rejudged) {
      const what = stateScope ? `${st.toUpperCase()} state code lookup` : `${name} design-criteria lookup`;
      sseBroadcast({ type: "reviewer_gate_rejudged", projectId, message: `Reviewer gate re-judged: ${what} landed.` });
    }
  }
  return rejudged;
}

/**
 * RE-JUDGE QC'S DOCUMENT ROWS WHEN AN AHJ'S PERMIT-PROCESS LOOKUP LANDS (#112). The lookup is where
 * the AHJ's cited required-documents list comes from (requiredDocuments.lookupRequiredList), and QC
 * judges `docs.*` / `docs.complete` from it — but QC ran before the lookup landed, and nothing ran
 * it again, so `docs.complete` kept saying "not yet confirmed" over a list now on file and the plan
 * set that triggered the lookup was never checked against it. Called by the worker after a
 * permit_process_lookup job lands 'done', after savePermitProcessLookup wrote the row — never after
 * one that failed for good (no row was written, and this QC run's lookup trigger would re-queue it).
 * Same population as rejudgeReviewerGatesAfterLookup: PRE-STAGE projects (qc_passed /
 * ready_to_stage) whose QC has already run, in the looked-up state+AHJ (permitProcessKey — the key
 * the list is read by). The re-run is the document-triggered re-judge (autoStageSteps STEP 1,
 * qcRejudgedOnDocs.test.ts): every row refreshed, no demotion on bill-only new fails. The judgement
 * reads the database only — no model call, no parser re-run — but QC's trigger block still asks for
 * the lookup and fee research (the lookup is a no-op there: the row now exists). Synchronous per
 * project, so a second landing in the same tick re-runs the same cheap judgement rather than
 * needing the gate's landing mark.
 */
export function rejudgeQcDocumentsAfterLookup(db: AppDb, target: { state: string; ahj: string }, trigger: string): string[] {
  const st = String(target.state || "").trim();
  if (!st || !String(target.ahj || "").trim()) return [];
  const key = permitProcessKey(st, target.ahj);
  const candidates = db.query<Row>(
    `SELECT p.id, p.state, p.ahj FROM projects p
      WHERE UPPER(TRIM(p.state)) = ? AND p.status IN ('qc_passed', 'ready_to_stage')
        AND EXISTS (SELECT 1 FROM qc_results q WHERE q.project_id = p.id)`,
    [st.toUpperCase()],
  );
  const rejudged: string[] = [];
  for (const row of candidates) {
    const projectId = text(row.id);
    if (permitProcessKey(text(row.state), text(row.ahj)) !== key) continue;
    try {
      const result = runQcForProject(db, projectId, { holdStatusOnNewBillOnlyFails: true });
      addAuditLog(db, projectId, "system", "qc gate", "project.qc_rerun", { ...result, trigger });
      rejudged.push(projectId);
    } catch (err) {
      logger.warn("qc", `re-judge after ${trigger} failed`, { project: projectId, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return rejudged;
}

// Opt-in: run the base text report, then a Claude-vision pass that inspects the
// actual plan-set sheets to confirm/deny weak findings (verdicts cached per plan
// version). Falls back to the text report when no plan set or no LLM is present.
export async function getReviewerReportWithVision(db: AppDb, projectId: string): Promise<ReviewerReport> {
  // The audit row and the verdict of the gate as it stands (cached verdicts included).
  getReviewerReport(db, projectId);
  // The vision pass itself starts from the TEXT report, as it always has. Over the cached view it would
  // skip a finding a cached verdict already relaxed, and it would meet a roof-plan measurement that had
  // already been applied. Cached verdicts are read back inside the pass, so nothing is re-bought.
  const report = buildReviewerReportFor(db, getProjectDetail(db, projectId).project);
  const { createLLMProvider } = await import("./llm");
  const { applyVisionToReviewerReport } = await import("./reviewerVision");
  const llm = createLLMProvider();
  const enriched = await applyVisionToReviewerReport(db, llm, report);
  const upgraded = enriched.findings.filter((f) => f.visionVerification?.checked).length;
  addAuditLog(db, projectId, "system", "ahj reviewer gate", "reviewer_report.vision_pass", {
    visionChecks: upgraded,
    blockerCount: enriched.findings.filter((item) => item.severity === "blocker").length,
    warningCount: enriched.findings.filter((item) => item.severity === "warning").length,
  });
  // The inner getReviewerReport already recorded the verdict of the gate as it stood. This pass can
  // add new verdicts and change the blocker count, so the enriched report gets the last word.
  recordReviewerGateVerdict(db, projectId, enriched);
  return enriched;
}

export async function getReviewerReportHtml(db: AppDb, projectId: string): Promise<string> {
  const detail = getProjectDetail(db, projectId);
  // The gate's severities, cached vision verdicts included (no new LLM cost), so the printable
  // packet matches the gate the operator saw.
  const report = reviewerGateReportFor(db, detail.project);
  addAuditLog(db, projectId, "system", "ahj reviewer gate", "reviewer_report.html_opened", {
    blockerCount: report.findings.filter((item) => item.severity === "blocker").length,
    warningCount: report.findings.filter((item) => item.severity === "warning").length,
  });
  return renderReviewerReportHtml(detail.project, report);
}

// WHAT THE AUTOMATIC CHAIN ALREADY DID, SHOWN WITHOUT DOING IT AGAIN.
//
// The stage-step chain builds the AHJ/NEM docs and runs the reviewer gate + historical check
// server-side, but the project page only ever held those three results in browser memory from
// a button click. Opening a project whose chain had just run showed all three as "not run",
// so a pipeline that had moved read as one that had stalled.
//
// This is the page-load read, so it must write NOTHING: no audit rows, no status edge, no
// reviewer verdict. Re-recording a text-only verdict on every page view would overwrite the
// vision-enriched verdict the chain stored. Cached vision verdicts are folded in (no LLM call),
// the same way the printable packet does it. A step with no audit row has never run and comes
// back null, so "not run" still means exactly that.
export async function readStageResults(db: AppDb, projectId: string): Promise<{
  applicationDocs: ApplicationDocumentPackage | null;
  reviewerReport: ReviewerReport | null;
  historicalReport: HistoricalFailureReport | null;
}> {
  const detail = getProjectDetail(db, projectId);
  const ran = new Set(db.query<Row>(
    `SELECT DISTINCT action FROM audit_logs WHERE project_id = ?
       AND action IN ('application_docs.generated', 'reviewer_report.generated', 'historical_failures.generated')`,
    [projectId],
  ).map((r) => text(r.action)));
  const applicationDocs = ran.has("application_docs.generated") ? assembleApplicationDocumentPackage(db, projectId).pkg : null;
  let reviewerReport: ReviewerReport | null = null;
  if (ran.has("reviewer_report.generated")) {
    // The gate's severities (reviewerGateReportFor), read only: the vision cache is only read, and
    // withoutCodeResearch suppresses the research enqueue an un-profiled AHJ would otherwise trigger.
    reviewerReport = withoutCodeResearch(() => reviewerGateReportFor(db, detail.project));
  }
  const historicalReport = ran.has("historical_failures.generated") ? buildHistoricalFailureReport(db, projectId, null) : null;
  return { applicationDocs, reviewerReport, historicalReport };
}

export function rerunQc(db: AppDb, projectId: string, options: QcRunOptions = {}): ProjectDetail {
  const result = runQcForProject(db, projectId, options);
  addAuditLog(db, projectId, "system", "qc gate", "project.qc_rerun", { ...result });
  return getProjectDetail(db, projectId);
}

/**
 * WHAT A CORRECTION'S TEXT IS. A portal record page is read for the correction itself — its
 * conditions / review comments (correctionExtract) — and the page is kept whole as source_text,
 * never discarded; when nothing is found the whole page stands and source_text equals it (which is
 * how the record says it fell back). Anything else (a typed note, an email) is the correction as
 * written, with no source_text. ONE text then feeds every write: correction_text, the classifier,
 * the review item's excerpt (persistTriage's legacy match compares against it), learning, and the
 * agent's job payload.
 */
function correctionFromReading(readText: string, isPortalPage: boolean): { correctionText: string; sourceText: string } {
  if (!isPortalPage) return { correctionText: readText, sourceText: "" };
  const reading = extractCorrectionFromPage(readText);
  return { correctionText: reading.method === "items" ? reading.text : readText, sourceText: readText };
}

export function addManualCorrection(
  db: AppDb,
  projectId: string,
  submittedText: string,
  source = "manual",
  // WHICH FILING AND WHICH NOTICE (#47): the filing a person named, the notice's own id (items of
  // one notice share it — one notice is one cycle) and its date. None given: track unknown, the
  // row is its own notice, the clock starts now.
  notice: { submissionId?: string | null; noticeId?: string | null; noticedAt?: string | null } = {},
): ProjectDetail {
  const detail = getProjectDetail(db, projectId);
  // A PORTAL page handed in through this door is read like the monitor's (correctionText below);
  // a typed note or an email is the correction as written.
  const { correctionText, sourceText } = correctionFromReading(submittedText, source === "portal");
  const classification = classifyCorrection(correctionText, detail.project);
  const correctionId = id();
  const ts = nowIso();
  const stamp = correctionFilingStamp(db, detail.project, correctionId, ts, notice);

  db.transaction(() => {
    db.run(
      `INSERT INTO corrections (
        id, project_id, source, correction_text, source_text, correction_bucket, root_cause, required_action,
        assigned_to, draft_response, human_approved, resubmitted, new_rule_recommended, created_at, closed_at,
        track, submission_id, notice_id, noticed_at, sla_days, due_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        correctionId,
        projectId,
        source,
        correctionText,
        sourceText,
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
        stamp.track, stamp.submissionId, stamp.noticeId, stamp.noticedAt, stamp.slaDays, stamp.dueAt,
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
        `agent-triage:${JSON.stringify({ correctionId, bucket: classification.bucket, proposals: [], actions: [classification.requiredAction] })}`,
        ts,
        ts,
      ],
    );

    db.run("UPDATE projects SET status = ?, current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
      "correction_triaged",
      `Correction triaged: ${humanizeBucket(classification.bucket)}`,
      // WHICH bucket it landed in stays in the prose above; the enum says only that a
      // correction is open, because that is the part every renderer and filter needs.
      "correction_open" satisfies StageDetail,
      ts,
      projectId,
    ]);

    addAuditLog(db, projectId, "system", "correction classifier", "correction.created_and_classified", {
      correctionId,
      bucket: classification.bucket,
    });
    learnFromCorrection(db, detail.project, correctionId, classification, correctionText, source);
    // A design requirement the AHJ stated -> a proposal for that AHJ's code profile (human-applied).
    attachJurisdictionProposals(db, correctionId);
  });

  // Hand the correction to the agent for a richer classification + data-update
  // proposals + draft (advisory; regex classification above is the committed baseline).
  enqueueCorrectionTriage(db, projectId, correctionId, correctionText);

  touchProjectMetrics(db, projectId);
  return getProjectDetail(db, projectId);
}

// Enqueue the correction-handling agent (lazy import — jobQueue statically imports
// this module, so a static import here would be a cycle). No-op in stub mode: the
// job runs, the agent returns provider:"stub", and nothing is written.
function enqueueCorrectionTriage(db: AppDb, projectId: string, correctionId: string, correctionText: string): void {
  if (!process.env.ANTHROPIC_API_KEY || process.env.CORRECTION_AGENT === "off") return;
  void import("./jobQueue")
    .then(({ enqueueJob }) => { enqueueJob(db, "correction_triage", { correctionId, correctionText }, { projectId, priority: 4 }); })
    .catch(() => { /* best-effort */ });
}

// Generate an ADVISORY draft reply for the newest correction using the LLM, so
// the coordinator gets a ready-to-edit response instead of a blank box. The
// draft is suggestion-only — a human must review and send it. Falls back to the
// deterministic draft (or empty) when no API key is configured.
export async function draftLatestCorrectionResponse(db: AppDb, projectId: string, correctionText: string): Promise<ProjectDetail> {
  if (!process.env.ANTHROPIC_API_KEY) return getProjectDetail(db, projectId);
  const detail = getProjectDetail(db, projectId);
  const correction = (detail.corrections || [])[0]; // newest (ORDER BY created_at DESC)
  if (!correction) return detail;
  try {
    const { createLLMProvider } = await import("./llm");
    const llm = createLLMProvider();
    // Draft against the STORED correction — for a portal page posted here, what was read off it
    // (addManualCorrection), not the page — falling back to the text the caller passed.
    const result = await llm.draftResponse({ correctionText: correction.correctionText || correctionText, project: detail.project });
    if (result.draft && result.draft.trim()) {
      db.run("UPDATE corrections SET draft_response = ? WHERE id = ?", [result.draft.trim(), correction.id]);
      addAuditLog(db, projectId, "system", "correction drafter", "correction.llm_draft", { correctionId: correction.id, confidence: result.confidence });
      return getProjectDetail(db, projectId);
    }
  } catch (err) {
    console.warn("[corrections] LLM draft failed:", (err as Error).message);
  }
  return detail;
}

// Map an agent proposal `field` name onto the ParserPayload key normalizeProject
// reads for the corresponding top-level column. Unmapped fields pass through and
// merge into the snapshot (visible, harmless).
const CORRECTION_FIELD_TO_PAYLOAD: Record<string, string> = {
  homeownerName: "owner", owner: "owner",
  accountNumber: "account", account: "account",
  meterNumber: "meter", meter: "meter",
  projectAddress: "address", address: "address",
  city: "city", state: "state", zip: "zip",
  ahj: "ahj", utility: "utility",
  systemSizeDcKw: "dcKw", dcKw: "dcKw",
  systemSizeAcKw: "acKw", acKw: "acKw",
  interconnectionMethod: "interco", interco: "interco",
};

// Apply the agent's approved data-update proposals for a correction. Operator-gated:
// only call after a human approves. Reuses updateProject (merges snapshot + reruns
// QC), marks the correction human_approved, and closes the linked review item.
//
// It APPLIES DATA AND NOTHING ELSE: no portal is touched, nothing is filed, and the
// correction stays OPEN (closing it is the resubmit event, where a human confirms the
// package actually went back out). The one status move it makes is the designer wait at
// the tail — a `B_designer_fix` triage parks the project at `waiting_on_designer`,
// because from that point the next move belongs to the design team.
export function applyCorrectionProposals(
  db: AppDb,
  correctionId: string,
  approvedFields?: string[],
): ProjectDetail {
  const correction = db.get<Row>("SELECT * FROM corrections WHERE id = ?", [correctionId]);
  if (!correction) throw new HttpError(404, "Correction not found.");
  const projectId = text(correction.project_id);
  const items = db.query<Row>(
    "SELECT * FROM human_review_items WHERE project_id = ? AND field_name = 'correction' AND status = 'pending'",
    [projectId],
  );
  const linked = items.filter(item => parseCorrectionProposals(text(item.notes))?.correctionId === correctionId);
  if (linked.length !== 1) throw new HttpError(409, "No unique pending proposal set is linked to this correction. Re-triage it before approving.");
  const item = linked[0];
  const parsed = item ? parseCorrectionProposals(text(item.notes)) : null;
  const proposals = (parsed?.proposals ?? []).filter((p) => !approvedFields || approvedFields.includes(p.field));
  // THE BUCKET IS READ OFF THE CORRECTION ROW, never off the triage blob. The row is what the
  // deterministic classifier writes at intake (addManualCorrection) and what the agent upgrades
  // (correctionAgent persistTriage), so it is the same value the board, the lanes and the
  // timeline already read; the blob is a payload that may predate the agent's re-classification.
  const isDesignRevision = text(correction.correction_bucket) === ("B_designer_fix" satisfies CorrectionRecord["correctionBucket"]);
  // A DESIGN correction usually proposes NO data update at all — the fix is a revised plan set,
  // not a field — so refusing an empty proposal set here would make the designer-wait transition
  // below unreachable for exactly the corrections it exists for, and leave that card with no
  // action on it. Every OTHER bucket keeps the refusal: an A/C apply with nothing selected marks
  // a correction human_approved while changing nothing, which is the silent no-op this endpoint
  // already learned to refuse.
  if (!proposals.some(p => p.proposedValue.trim()) && !isDesignRevision) throw new HttpError(409, "This correction has no selected data updates to apply. Review its action checklist instead.");
  if (correction.closed_at) throw new HttpError(409, "This correction is already closed.");
  // READ THE STATUS BEFORE updateProject RUNS — this is the only place the question can be
  // asked. updateProject re-runs QC, and runQcForProject used to rewrite status AND stage_detail
  // to its own verdict unconditionally: a project at `correction_triaged` came back from an apply
  // reading `qc_failed`. QC now leaves any status at or past the Submit stage alone (qc.ts), so a
  // correction state survives the re-QC — but the pre-apply read stays, because it is the
  // question this transition is actually asking.
  const statusBefore = text(db.get<Row>("SELECT status FROM projects WHERE id = ?", [projectId])?.status);

  const payload: ParserPayload = {};
  for (const p of proposals) {
    if (!p.proposedValue) continue;
    const key = CORRECTION_FIELD_TO_PAYLOAD[p.field] || p.field;
    payload[key] = p.proposedValue;
  }
  if (Object.keys(payload).length) updateProject(db, projectId, payload);

  const ts = nowIso();
  db.run("UPDATE corrections SET human_approved = 1 WHERE id = ?", [correctionId]);
  // AN APPROVAL THAT DID NOT SELECT THE JURISDICTION PROPOSALS MUST NOT STRAND THEM. Closing the
  // item here used to leave them "proposed" behind a closed card, with no way left to apply them.
  // While any is still open the item stays pending with its project half recorded as done (the
  // applied project proposals move to appliedProposals), so the next click applies only them and
  // never re-runs these project updates or the designer wait.
  const stillProposed = (parsed?.jurisdictionProposals ?? []).some((p) => p.status === "proposed")
    || (parsed?.reviewRuleProposals ?? []).some((p) => p.status === "proposed");
  if (item && stillProposed) {
    let stored: Record<string, unknown> = {};
    try { stored = JSON.parse(text(item.notes).slice("agent-triage:".length)) as Record<string, unknown>; } catch { stored = {}; }
    db.run("UPDATE human_review_items SET notes = ?, updated_at = ? WHERE id = ?", [
      `agent-triage:${JSON.stringify({ ...stored, proposals: [], appliedProposals: proposals, projectAppliedAt: ts })}`, ts, text(item.id),
    ]);
  } else if (item) db.run("UPDATE human_review_items SET status = 'approved', updated_at = ? WHERE id = ?", [ts, text(item.id)]);
  addAuditLog(db, projectId, "human", "correction", "correction.proposals_applied", { correctionId, applied: proposals.length, jurisdictionStillProposed: stillProposed });

  // THE DESIGNER WAIT — the real writer for `waiting_on_designer`, which until now was labeled,
  // bannered, client-worded and filterable with nothing anywhere able to write it.
  //
  // A `B_designer_fix` correction says the package cannot be re-filed until the design team
  // sends back a revised plan set / calc, and that wait is the operator's whole day: the board
  // has to say "waiting on the designer", not "QC failed" (which is what the re-QC inside
  // updateProject just wrote) and not "correction triaged" (which says nothing about whose move
  // it is). Only applied triage moves the project — reading a correction does not.
  //
  // GUARDED ON THE PRE-APPLY STATUS so this can only ever move a project that was genuinely in
  // the correction flow. A filing sitting at `submitted`, `issued` or `handoff_ready` is never
  // dragged back to a designer wait by an apply.
  //
  // WHAT IT DOES NOT DO: close the correction, touch a portal, or file anything. The exit from
  // here is a human's word — recordDesignRevisionsReceived below — and never an inference from
  // a document appearing on the project.
  if (isDesignRevision && ["correction_received", "correction_triaged", "waiting_on_designer"].includes(statusBefore)) {
    db.run("UPDATE projects SET status = 'waiting_on_designer', current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
      "Correction triage applied — waiting on revised design.",
      "awaiting_design_revision" satisfies StageDetail,
      ts,
      projectId,
    ]);
    addAuditLog(db, projectId, "human", "correction", "correction.waiting_on_designer", { correctionId, from: statusBefore });
  }

  touchProjectMetrics(db, projectId);
  return getProjectDetail(db, projectId);
}

/**
 * "REVISIONS RECEIVED" — the operator's explicit end to a designer wait, and the ONLY way out
 * of `waiting_on_designer`.
 *
 * THE RULE THIS FUNCTION EXISTS TO HOLD: a correction state must never exit without a human
 * action. The tempting automation — move the project when a revised document is attached — is
 * exactly wrong: an upload is not evidence the revisions are complete. Designers attach a
 * partial sheet, a preview, the wrong file, or the stamped page ahead of the calcs, and any of
 * those would silently advance the job to a re-file the design does not support. So nothing in
 * the document path calls this; the operator says the words.
 *
 * WHERE IT GOES: `ready_to_resubmit` — B1's Submit-stage state, which is in PRE_STAGE_STATUSES,
 * so the corrected job re-enters at 3 · Prepare Submittal and faces the FULL re-QC plus every
 * staging gate (payment, documents, reviewer, permit path, client). Nothing is skipped by
 * having waited on a designer.
 *
 * WHAT IT DOES NOT DO: close the correction (that is the resubmit event — the package has not
 * gone back out yet), touch a portal, or enqueue an autopilot run. The ready_to_resubmit banner
 * already tells the operator to click 3 · Prepare Submittal; a wait that ends by itself into a
 * background run is the opposite of the human-paced gate this is.
 *
 * GUARDED ON THE PROJECT'S STATUS, NOT THE CORRECTION'S closed_at, on purpose: an operator who
 * resolves the correction by hand while the project waits on the designer leaves the project at
 * `waiting_on_designer` (resolveCorrection releases only `correction_received`/
 * `correction_triaged`), and refusing here because the correction row is closed would strand
 * that project with the audited override as its only exit.
 */
export function recordDesignRevisionsReceived(
  db: AppDb,
  correctionId: string,
  actorName = "operator",
): ProjectDetail {
  const correction = db.get<Row>("SELECT * FROM corrections WHERE id = ?", [correctionId]);
  if (!correction) throw new HttpError(404, "Correction not found.");
  const projectId = text(correction.project_id);
  const statusBefore = text(db.get<Row>("SELECT status FROM projects WHERE id = ?", [projectId])?.status);
  if (statusBefore !== "waiting_on_designer") {
    throw new HttpError(409, `This project is not waiting on a designer (it is "${statusBefore}"). "Revisions received" ends a designer wait; it cannot start one.`);
  }
  const ts = nowIso();
  // ASK THE SAME QUESTION resolveCorrection ASKS: is anything still on file?
  //
  // resolveCorrection branches carefully on this (a still-filed project returns to
  // `submitted`, only one with nothing on file goes back to re-stage) because the two
  // answers are OPPOSITE instructions to the operator — wait for the agency, or drive
  // Prepare Submittal. This writer used to skip the question and always say re-stage,
  // which told an operator to re-file an application that was already sitting with the
  // jurisdiction.
  const stillFiled = db.get<Row>(
    "SELECT id FROM submissions WHERE project_id = ? AND status = 'submitted' LIMIT 1", [projectId],
  );
  db.run("UPDATE projects SET status = ?, current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
    stillFiled ? "submitted" : "ready_to_resubmit",
    stillFiled
      ? "Revised design received — the application is still on file; update it in the portal."
      : "Revised design received — ready to re-stage.",
    "design_revisions_received" satisfies StageDetail,
    ts,
    projectId,
  ]);
  addAuditLog(db, projectId, "human", actorName, "correction.design_revisions_received", {
    correctionId, from: statusBefore, stillFiled: Boolean(stillFiled),
  });
  touchProjectMetrics(db, projectId);
  return getProjectDetail(db, projectId);
}

// Close a correction — the FIRST writer of closed_at / resubmitted. Called when the
// operator marks it resolved (POST /api/corrections/:id/resolve), and automatically from
// captureConfirmation via resolveOpenCorrectionsOnResubmit when a human confirms the
// resubmission actually went out.
export function resolveCorrection(
  db: AppDb,
  correctionId: string,
  opts: {
    resubmitted?: boolean;
    /** WHO closed it. The route passes the signed-in user; the monitor's terminal-status close
     *  passes a system actor. Defaults to the historical "human"/"correction" label. */
    actor?: { type: "human" | "system"; name: string };
    /** Why, when it was not a person clicking resolve (e.g. "closed_on_terminal_status"). */
    reason?: string;
  } = {},
): CorrectionRecord {
  const correction = db.get<Row>("SELECT * FROM corrections WHERE id = ?", [correctionId]);
  if (!correction) throw new HttpError(404, "Correction not found.");
  const ts = nowIso();
  db.run(
    "UPDATE corrections SET closed_at = ?, resubmitted = ? WHERE id = ?",
    [ts, opts.resubmitted ? 1 : Number(correction.resubmitted ?? 0), correctionId],
  );
  const projectId = text(correction.project_id);
  for (const item of db.query<Row>("SELECT id, notes FROM human_review_items WHERE project_id = ? AND field_name = 'correction' AND status != 'resolved'", [projectId])) {
    if (parseCorrectionProposals(text(item.notes))?.correctionId === correctionId) {
      db.run("UPDATE human_review_items SET status = 'resolved', updated_at = ? WHERE id = ?", [ts, text(item.id)]);
    }
  }
  const actor = opts.actor ?? { type: "human" as const, name: "correction" };
  addAuditLog(db, projectId, actor.type, actor.name, "correction.resolved", {
    correctionId, resubmitted: !!opts.resubmitted, ...(opts.reason ? { reason: opts.reason } : {}),
  });
  // The operator's resolve is the last word on what this correction WAS: re-derive its learned
  // failure row from the row's final classification (L4). A no-op for an unchanged A/B row.
  relearnCorrection(db, correctionId);
  // Closing the LAST open correction un-strands the project: correction_received /
  // correction_triaged are not in PRE_STAGE_STATUSES, so the auto-resume the resolve route
  // fires (maybeResumeAutopilot, "a correction was resolved") refuses to re-drive from them
  // — without this transition the project would sit in the correction state forever with no
  // path back to staging. (The old wording here also credited an "execution-time guard" with
  // the same refusal; that guard is now per-TRACK on portal_runs and reads no project status
  // at all — autopilot.ts trackAlreadyStaged.)
  const projRow = db.get<Row>("SELECT status FROM projects WHERE id = ?", [projectId]);
  const inCorrectionState = projRow && ["correction_received", "correction_triaged"].includes(text(projRow.status));
  const stillOpen = db.get<Row>(
    "SELECT id FROM corrections WHERE project_id = ? AND closed_at IS NULL LIMIT 1", [projectId],
  );
  if (!stillOpen) db.run("UPDATE human_review_items SET status = 'resolved', updated_at = ? WHERE project_id = ? AND field_name = 'correction' AND status != 'resolved'", [ts, projectId]);
  if (inCorrectionState && !stillOpen) {
    // WHERE IT GOES BACK TO DEPENDS ON WHETHER IT IS STILL FILED.
    // "Ready to re-stage" assumes the fix happens HERE and the application is sent
    // afterwards. But a suspended filing is usually corrected IN the portal — the utility
    // reopens the original application, the operator edits it and resubmits, and the filing
    // never stopped existing. Releasing that project to `parsed` announces work that is
    // already done and invites a re-stage that prepareSubmission will refuse anyway with a
    // 409. Live on PacifiCorp APP-111681: corrected and resubmitted in PowerClerk, and the
    // status had to be put back by hand.
    // A filing that is still submitted returns to `submitted`; only a project with nothing
    // on file goes back to re-stage.
    const filed = db.get<Row>(
      "SELECT id FROM submissions WHERE project_id = ? AND status = 'submitted' LIMIT 1", [projectId],
    );
    if (filed) {
      db.run("UPDATE projects SET status = 'submitted', current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
        "Correction resolved — resubmitted, awaiting review.", "correction_resolved" satisfies StageDetail, ts, projectId,
      ]);
      addAuditLog(db, projectId, "system", "correction", "correction.project_still_filed", { correctionId });
    } else {
      // NOTHING IS ON FILE — the corrected package has to be staged and filed again.
      //
      // This leg used to write `parsed`, which visually REWOUND a corrected project all the
      // way back to QC / Verify (stage 0): the board showed a job that had already been
      // filed, bounced and fixed as if its plan set had just been read. `ready_to_resubmit`
      // is where it belongs — it maps to the Submit stage (projectStage.ts STATUS_TO_STAGE)
      // and already carries its board label, banner and client-facing text; it simply had no
      // writer until now.
      //
      // `parsed` was chosen originally partly BECAUSE it is a pre-stage status, so the
      // automatic run would re-do QC and every gate rather than jumping the project ahead.
      // That property is preserved, not traded away: `ready_to_resubmit` is now a member of
      // PRE_STAGE_STATUSES (autopilot.ts — an untyped Set that typecheck cannot defend, so it
      // is maintained by name), and Segment A's gate path reads no project status whatsoever
      // — it re-runs QC and then calls prepareSubmission, which gates on payment, an already-
      // filed submission, QC/human-review/reviewer/historical, document presence, permit path
      // and client. A correction resolved this way faces the identical wall it faced from
      // `parsed`; only the stage the operator sees is now the truth.
      //
      // The PROSE IS A MATCHING KEY and stays byte-identical.
      db.run("UPDATE projects SET status = 'ready_to_resubmit', current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
        "Correction resolved — ready to re-stage.", "correction_resolved_restage" satisfies StageDetail, ts, projectId,
      ]);
      addAuditLog(db, projectId, "system", "correction", "correction.project_restageable", { correctionId });
    }
  }
  touchProjectMetrics(db, projectId);
  return mapCorrection(db.get<Row>("SELECT * FROM corrections WHERE id = ?", [correctionId])!);
}

/**
 * Close any open corrections for a project once its resubmission has actually gone out.
 * Sets resubmitted=1 + closed_at so cycle-time KPIs complete and every "open correction"
 * surface stops calling the job blocked.
 *
 * CALLED FROM captureConfirmation, AND THAT MOMENT IS THE POINT. This function existed
 * with ZERO callers while two comments (its own, and resolveCorrection's) claimed
 * prepareSubmission called it — so a re-filed package kept closed_at NULL and
 * resubmitted=0 unless an operator hit POST /api/corrections/:id/resolve by hand, and
 * openCorrectionCount, both lane computations, the action queue and the KPI all went on
 * reporting "Assign and resolve AHJ corrections before resubmittal" on a job already
 * resubmitted.
 *
 * NOT prepareSubmission: staging is not submitting (hard safety rule 1 — automation never
 * clicks final submit), and a staged run can be abandoned at the review screen. Closing a
 * correction there would announce a resubmission that never happened. captureConfirmation
 * is where a HUMAN says the filing went out.
 *
 * Corrections carry no track (project_id only — db.ts:413), so this is project-grained,
 * and the caller only fires it when NO track is still awaiting a human submit. That is
 * deliberately conservative: with two tracks staged together and one confirmed, the close
 * waits for the second rather than closing a correction that may belong to it.
 *
 * A no-op on a first submission — there is nothing open to close.
 */
export function resolveOpenCorrectionsOnResubmit(db: AppDb, projectId: string): number {
  const open = db.query<Row>(
    "SELECT id FROM corrections WHERE project_id = ? AND closed_at IS NULL AND resubmitted = 0",
    [projectId],
  );
  for (const row of open) resolveCorrection(db, text(row.id), { resubmitted: true });
  return open.length;
}

export function listOverdueCorrections(db: AppDb, orgId: string | null = DEFAULT_ORG_ID): CorrectionRecord[] {
  const today = new Date().toISOString().slice(0, 10);
  // corrections carry no org of their own; they reach one through their project,
  // which is the grain that owns them.
  const rows = db.query<Row>(
    `SELECT c.* FROM corrections c
     JOIN projects p ON p.id = c.project_id${orgId ? " AND p.org_id = ?" : ""}
     WHERE c.closed_at IS NULL
       AND ${correctionOverdueSql("c")}
     ORDER BY c.created_at ASC`,
    orgId ? [orgId, today, today] : [today, today],
  );
  return rows.map(mapCorrection);
}

export function setCorrectionsSlaDays(db: AppDb, correctionId: string, slaDays: number): void {
  const ts = nowIso();
  db.run(
    `UPDATE corrections SET sla_days = ?, due_at = date(COALESCE(noticed_at, created_at), '+' || ? || ' days') WHERE id = ?`,
    [slaDays, slaDays, correctionId],
  );
}

// ---------------------------------------------------------------------------
// CORRECTION REOPEN — the operator action that reopens a SUSPENDED filing's
// correction form on the live portal (the portal half of the correction flow;
// the data half is applyCorrectionProposals above).
//
// Binds the ORIGINAL filing from the project's tracking targets
// (permit_check_targets carries the application number, portal URL, and which
// track the filing belongs to), then drives portal-bot's runCorrectionReopen:
// login → open THAT application → choose the named correction form
// (correctionForm.ts refuses cancellation/withdraw forms, View-only rows, and
// ambiguity) → stage revised documents through the attach-time gate → STOP.
//
// What this NEVER does: create a new application, click any submit/withdraw
// control, or mark the correction resubmitted — resolveCorrection({resubmitted})
// records the human's own resubmit click. Every uncertain outcome (no bound
// filing, two plausible filings, no correction form, two correction forms)
// lands as a pending human_review_items row with the candidates listed, so an
// unknown never reads as fine.
// ---------------------------------------------------------------------------

export interface CorrectionReopenResult {
  ok: boolean;
  needsHuman: boolean;
  message: string;
  reopenedForm?: string;
  attachedDocs?: number;
  browserLeftOpen?: boolean;
  offeredForms?: string[];
  /** Why a revised document did not attach (a refused / failed attach) — the runner's own words.
   *  Without them a reopen that attached 0 of 3 documents read only as "attachedDocs: 0". */
  driftWarnings?: string[];
  /** Filing candidates when the reopen could not bind ONE target — operator picks by targetId. */
  candidates?: Array<{ targetId: string; targetType: string; applicationNumber: string; portalName: string; portalUrl: string }>;
  runId?: string;
}

// ---------------------------------------------------------------------------
// WHICH FILING DOES THIS CORRECTION BELONG TO?
//
// The predecessor of this function was one regex,
//   /nem|net.?meter|interconnection|pto|utility|meter|account|powerclerk|inverter|1741/i
// pasted at three sites, and it was wrong in a way that only live data showed.
// `utility`, `meter`, `account`, `inverter`, `interconnection` and `1741` are not
// track signals — they are the vocabulary EVERY residential solar record uses to
// describe the system. Drew Example's only open correction (cb3cf605) is a scrape
// of the Accela PERMIT record 187-26-000305-STR whose sole item is a parcel-level
// "Sewer Recovery" notice; it matched as NEM on the words "load-side breaker
// INTERCONNECTION", "within 10 ft of the UTILITY METER" and "microINVERTERs" — every
// one of them the plan-set description, none of them about a utility filing.
//
// MISATTRIBUTING A CORRECTION IS WORSE THAN NOT CLASSIFYING IT: the reopen flow binds
// the correction to a tracked filing and drives a browser at it, so a permit notice
// read as NEM points the operator (and the automation) at the wrong portal — the exact
// shape hard rule 5 exists to prevent.
//
// So: STRONG SIGNALS ONLY, and three answers rather than two.
//   - "nem"          — the text names a utility FILING (NEM, net metering, PowerClerk,
//                      PTO, an interconnection application/agreement) and nothing names
//                      a permit record.
//   - "permit"       — the text names a permit/building record (Accela, ePermitting, a
//                      plan review, a permit record number, a parcel, an AHJ permit
//                      application) and nothing names a utility filing.
//   - "unclassified" — both kinds of signal, or neither. A human decides.
// Ambient system vocabulary decides NOTHING on its own. UL 1741 in particular is an
// inverter listing printed on spec sheets, not evidence of an interconnection filing.
// ---------------------------------------------------------------------------

export type CorrectionTrack = "permit" | "nem" | "unclassified";

/** Names a UTILITY FILING (not merely utility equipment). */
const NEM_FILING_RE = /\bnem\b|\bnems\b|net[\s-]?meter(ing)?|power\s?clerk|\bpto\b|permission to operate|interconnection (application|agreement|request|review|submittal|packet|approval)|customer generation|utility (application|interconnection|submittal)|generator interconnection/i;

/** Names a PERMIT RECORD (not merely a building). `\d{3}-\d{2}-\d{6}` is the Accela
 *  record number shape the live scrape carries ("187-26-000305-STR"). */
const PERMIT_FILING_RE = /accela|e-?permitting|\bplan (review|check|examiner)\b|building permit|structural permit|electrical permit|permit (record|application|number)|\brecord\s+\d{3}-\d{2}-\d{6}|\b\d{3}-\d{2}-\d{6}(-[a-z]{2,4})?\b|\bparcel\b|\bahj\b|\bccb\b|certificate of occupancy|zoning|setback/i;

/** Classify a correction's own words into the filing it belongs to.
 *  Never guesses: an unclear correction comes back "unclassified" so the caller asks. */
export function classifyCorrectionTrack(...parts: Array<string | null | undefined>): CorrectionTrack {
  const blob = parts.filter(Boolean).join(" ");
  const nem = NEM_FILING_RE.test(blob);
  const permit = PERMIT_FILING_RE.test(blob);
  if (nem && !permit) return "nem";
  if (permit && !nem) return "permit";
  return "unclassified";
}

/** Should a correction appear on THIS track's board/lane?
 *
 *  AN UNKNOWN MUST NEVER READ AS REASSURANCE: an unclassified correction shows on BOTH
 *  lanes, never on neither. Dropping it from both would turn "we cannot tell which
 *  filing this belongs to" into a silent all-clear on the one it actually belongs to. */
export function correctionOnTrack(want: "permit" | "nem", ...parts: Array<string | null | undefined>): boolean {
  const track = classifyCorrectionTrack(...parts);
  return track === want || track === "unclassified";
}

/** WHICH FILINGS A LEARNED HISTORICAL BLOCKER HOLDS (gates-proper C2): its own words and its
 *  cause's, classified by classifyCorrectionTrack (strong signals only) — an unclassified item
 *  holds every filing. The gate's permit-requirements check and prepareSubmission ask this. */
export function historicalBlockerScope(report: HistoricalFailureReport, item: HistoricalFailureReport["checklist"][number]): GateHoldScope {
  const cause = report.topRejectionCauses.find((c) => c.signature === item.sourceCauseSignature);
  return correctionHoldScope(classifyCorrectionTrack(item.title, item.why, item.action, cause?.title, cause?.rootCause, cause?.requiredAction));
}

export async function reopenCorrectionOnPortal(
  db: AppDb,
  correctionId: string,
  opts: { targetId?: string; runner?: typeof runCorrectionReopen } = {},
): Promise<CorrectionReopenResult> {
  const correction = db.get<Row>("SELECT * FROM corrections WHERE id = ?", [correctionId]);
  if (!correction) throw new HttpError(404, "Correction not found.");
  if (correction.closed_at) {
    throw new HttpError(409, "This correction is closed. Reopening applies to an OPEN correction on a suspended filing.");
  }
  const projectId = text(correction.project_id);
  const detail = getProjectDetail(db, projectId);
  const runner = opts.runner ?? runCorrectionReopen;
  const ts = nowIso();

  // NEEDS-HUMAN surface: a pending review item with the candidates listed — the
  // operator's actual queue — plus an audit row. Never a silent no-op.
  const surfaceNeedsHuman = (
    why: string,
    extras: { offeredForms?: string[]; candidates?: CorrectionReopenResult["candidates"]; runId?: string },
  ): CorrectionReopenResult => {
    const offered = extras.offeredForms ?? [];
    const candidates = extras.candidates ?? [];
    const excerpt = [
      ...offered.map((f) => `form: ${f}`),
      ...candidates.map((c) => `filing: ${c.applicationNumber} (${c.targetType}${c.portalName ? `, ${c.portalName}` : ""})`),
    ].join(" | ").slice(0, 800);
    db.run(
      `INSERT INTO human_review_items
        (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id(), projectId, "Correction reopen needs a human", "correction_reopen", "", "", excerpt, "pending", why.slice(0, 900), ts, ts],
    );
    addAuditLog(db, projectId, "system", "correction reopen", "correction.reopen_needs_human", {
      correctionId, why: why.slice(0, 300), offeredForms: offered.slice(0, 10), candidates: candidates.map((c) => c.applicationNumber).slice(0, 10),
    });
    return { ok: false, needsHuman: true, message: why, offeredForms: offered, candidates, runId: extras.runId };
  };

  // 1) BIND THE ORIGINAL FILING. Only an active tracking target that carries the
  //    application number can anchor a reopen — the reopen must land on THAT filing,
  //    never on "whatever the portal lists first" and never on a new application.
  const targets = db.query<Row>(
    "SELECT * FROM permit_check_targets WHERE project_id = ? AND active = 1 AND application_number != '' ORDER BY created_at DESC",
    [projectId],
  );
  const describe = (t: Row) => ({
    targetId: text(t.id),
    targetType: trackKind(text(t.target_type), text(t.permit_type)),
    applicationNumber: text(t.application_number),
    portalName: text(t.portal_name),
    portalUrl: text(t.portal_url),
  });
  let target: Row | undefined;
  if (opts.targetId) {
    target = targets.find((t) => text(t.id) === opts.targetId);
    if (!target) throw new HttpError(404, "That tracking target does not belong to this project (or carries no application number).");
  } else if (targets.length === 1) {
    target = targets[0];
  } else if (targets.length > 1) {
    // Two filings tracked (e.g. the permit AND the NEM application). The correction's own
    // wording says which system suspended it; if that still leaves more than one filing
    // (two permit disciplines), refuse and let the operator pick — guessing files the
    // correction against the wrong application.
    //
    // AND IF THE WORDING DOES NOT SAY, WE DO NOT PICK. classifyCorrectionTrack returns
    // "unclassified" rather than defaulting to permit, and that lands in the same
    // needs-a-human surface below with every candidate listed. The old two-valued regex
    // had no way to say "I cannot tell", so every correction it did not read as NEM was
    // asserted to be a permit correction — and every correction it DID read as NEM was
    // usually just a plan set describing its own microinverters.
    // source_text is the page a portal correction was read from — the record header the extracted
    // correction no longer carries is exactly the evidence read below, so it stays in.
    const blob = `${text(correction.correction_text)} ${text(correction.source_text)} ${text(correction.root_cause)} ${text(correction.required_action)}`;
    // EVIDENCE BEATS CLASSIFICATION. A portal-scraped correction usually quotes the record
    // it came off ("Record 187-26-000305-STR: …"), and one of this project's own tracked
    // application numbers appearing verbatim in the text is not a signal to weigh — it names
    // the filing. Only when EXACTLY ONE tracked number appears: two would be a cross-reference
    // and a guess again. Live: Ivy 720b05f3 tracks three filings (two Accela permits, one
    // PowerClerk NEM); his correction quotes 187-26-000305-STR, so this binds it to that
    // permit instead of asking, and the old regex bound it to the NEM portal.
    const quotedTargets = targets.filter((t) => {
      const app = text(t.application_number);
      return app.length >= 6 && blob.includes(app);
    });
    const wantType = classifyCorrectionTrack(
      text(correction.correction_text), text(correction.source_text), text(correction.root_cause), text(correction.required_action),
    );
    const scoped = quotedTargets.length === 1
      ? quotedTargets
      : wantType === "unclassified"
        ? []
        : targets.filter((t) => trackKind(text(t.target_type), text(t.permit_type)) === wantType);
    if (scoped.length === 1) target = scoped[0];
    else {
      return surfaceNeedsHuman(
        wantType === "unclassified"
          ? `Correction reopen needs a human: this correction's wording does not say which filing it belongs to, and ${targets.length} filings are tracked — pick the one to reopen. Reopening the wrong one files the correction against the wrong application.`
          : `Correction reopen needs a human: ${scoped.length || targets.length} tracked filings could carry this correction — pick the one to reopen.`,
        { candidates: (scoped.length ? scoped : targets).map(describe) },
      );
    }
  }
  if (!target) {
    return surfaceNeedsHuman(
      "Correction reopen needs a human: no tracked filing carries an application number for this project. Add the filing under Permit/NEM Checks (with its application number) and retry.",
      { candidates: [] },
    );
  }

  const targetType: "permit" | "nem" = trackKind(text(target.target_type), text(target.permit_type));
  const scopeType: "ahj" | "utility" = targetType === "nem" ? "utility" : "ahj";
  const applicationNumber = text(target.application_number);

  // 2) RESOLVE THE PORTAL — the target's own URL first, else the track-scoped recipe's.
  //    WHOSE PORTAL? (resolution skeptic MF3: the same two-way predicate the stage uses.) The
  //    recipe is judged by track AND entity (recipeHostFit) — one that drives the other track's
  //    host, another entity's portal, or a portal a person's verified row contradicts is never
  //    replayed here (the reopen then runs on the target's own URL with no steps). The resolved
  //    URL is judged by the track half of rule 5, BOTH ways: a permit filing is never reopened
  //    on a utility platform, and a NEM filing never on an AHJ permit platform. Stop before any
  //    browser opens.
  const reopenTrack = targetType === "nem" ? "nem" : "permit";
  let recipe = findCompleteRecipeForProject(db, { scopeType, state: detail.project.state, ahj: detail.project.ahj, utility: detail.project.utility })
    ?? findAnyRecipeForProject(db, { scopeType, state: detail.project.state, ahj: detail.project.ahj, utility: detail.project.utility });
  if (recipe) {
    const entityInput = { scope: scopeType, state: detail.project.state, name: scopeType === "utility" ? detail.project.utility : detail.project.ahj, excludeRecipeIds: [recipe.id] };
    const fit = recipeHostFit(reopenTrack, portalEntityEvidence(db, entityInput), recipe);
    if (!fit.fits) {
      addAuditLog(db, projectId, "system", "correction reopen", fit.code === "track_conflict" ? "portal.track_host_conflict" : "portal.entity_host_conflict", {
        correctionId, targetId: text(target.id), recipeId: recipe.id, url: fit.url, code: fit.code, reason: fit.reason,
      });
      recipe = null;
    }
  }
  const portalUrl = text(target.portal_url) || (recipe?.portalUrl ?? "");
  if (portalUrl && !trackSafeUrl(reopenTrack, portalUrl)) {
    addAuditLog(db, projectId, "system", "correction reopen", "portal.track_host_conflict", {
      correctionId, targetId: text(target.id), url: portalUrl, track: reopenTrack,
    });
    return surfaceNeedsHuman(
      targetType === "permit"
        ? `Correction reopen stopped: the permit filing ${applicationNumber} is bound to a utility interconnection portal URL (${portalUrl}) — that's the NEM portal, not the permit portal. Fix the tracking target's portal URL and retry.`
        : `Correction reopen stopped: the NEM filing ${applicationNumber} is bound to an AHJ permit portal URL (${portalUrl}) — that's the permit portal, not the utility's interconnection portal. Fix the tracking target's portal URL and retry.`,
      { candidates: [describe(target)] },
    );
  }
  if (!portalUrl) {
    return surfaceNeedsHuman(
      `Correction reopen needs a human: no portal URL is known for filing ${applicationNumber}. Add the portal URL to its tracking target and retry.`,
      { candidates: [describe(target)] },
    );
  }

  // 3) REVISED DOCUMENTS through the SAME resolver + attach-time gate replay uses:
  //    explicit uploads beat generated forms, wrong-path forms are filtered, and the
  //    gate re-reads the project's current path + selected file at the attach itself.
  //    Scoped to THIS target's filing (docs-audit PLAN D3): a reopened building permit is
  //    handed the building track's documents, never the utility bill or the electrical form.
  const reopenFiling = trackForTarget(text(target.target_type), text(target.permit_type));
  const docsByType = submissionDocumentsByType(db, detail.project, reopenFiling);
  const beforeUpload = uploadDocumentGuard(db, projectId, { track: reopenFiling });

  // 4) Credential/session conventions shared with the learner/replay/monitor.
  const clientId = detail.project.clientId ?? "";
  const profileBase = process.env.PORTAL_PROFILES_DIR || path.join(process.cwd(), "portal-profiles");
  const portalType = scopeType === "utility" ? "utility" : "AHJ";
  const userDataDir = portalProfileDir(profileBase, clientId || null, portalType, portalUrl);
  const credential = clientId
    ? (getDecryptedCredential(db, clientId, portalType)
        ?? getDecryptedCredentialByUrl(db, clientId, portalUrl)
        ?? getDecryptedCredentialAny(db, clientId, portalUrl))
      ?? undefined
    : undefined;

  // The adapter logs in via the recipe's portalUrl — hand it the resolved one. A portal
  // with no recipe still reopens fine: the run replays no steps, so an empty recipe that
  // names the track's authority is enough.
  const recipeForRun: PortalRecipe = recipe
    ? { ...recipe, portalUrl }
    : {
        id: `correction-reopen-${text(target.id)}`,
        scopeType,
        profileKey: "",
        state: detail.project.state || "",
        ahj: targetType === "nem" ? "" : (detail.project.ahj || text(target.jurisdiction)),
        utility: targetType === "nem" ? (detail.project.utility || "") : "",
        portalPlatform: text(target.portal_platform) || "portal",
        portalUrl,
        // "recording": an unpromoted shell — it exists only to carry the portal URL and
        // authority name into the reopen run, and must never read as a replayable recipe.
        status: "recording",
        version: 1,
        steps: [],
        createdBy: "correction-reopen",
        createdAt: ts,
        updatedAt: ts,
        notes: "",
      } as PortalRecipe;

  const result = await runner(recipeForRun, applicationNumber, docsByType, {
    beforeUpload,
    credential,
    userDataDir,
    headless: resolveHeadless(undefined),
  });

  const pauseReason = typeof result.pauseReason === "string" && result.pauseReason ? result.pauseReason : null;
  const ok = result.ok === true;
  const needsHuman = result.needsHuman === true;
  const message = String(result.message ?? "");
  const offeredForms = Array.isArray(result.offeredForms) ? (result.offeredForms as unknown[]).map((f) => String(f)) : [];
  const driftWarnings = Array.isArray(result.driftWarnings) ? (result.driftWarnings as unknown[]).map((w) => String(w)).slice(0, 20) : [];
  const runId = id();
  // DELIBERATELY 'awaiting_human_resubmit', never 'awaiting_human_submit': the approve/
  // auto-submit path selects runs by that other status, and a reopened correction must
  // never become eligible for a delegated final submit (the resubmit click is human).
  const runStatus = pauseReason ? "paused_for_human" : ok ? "awaiting_human_resubmit" : "failed";
  db.run(
    `INSERT INTO portal_runs
      (id, project_id, portal_profile_id, run_type, status, started_at, finished_at, error_message,
       human_action_required, screenshots_path, logs_path, result_json, pause_reason, permit_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [runId, projectId, null, "correction_reopen", runStatus, ts, nowIso(), ok ? "" : message.slice(0, 500), 1, "", "",
      asJson({ ...result, correctionId, targetId: text(target.id), actor: "RecipeAdapter (correction reopen)" }),
      pauseReason, text(target.permit_type) || (targetType === "nem" ? "nem" : "permit")],
  );
  addAuditLog(db, projectId, "portal_bot", "correction reopen", ok ? "correction.reopened_on_portal" : pauseReason ? "correction.reopen_paused" : "correction.reopen_stopped", {
    correctionId,
    targetId: text(target.id),
    applicationNumber,
    runId,
    reopenedForm: String(result.reopenedForm ?? ""),
    attachedDocs: Number(result.attachedDocs ?? 0),
    driftWarnings,
    finalSubmitClickedByAutomation: false,
  });

  // THE PROJECT MOVES TOO. Until now this function recorded a portal_runs row and nothing
  // else, so a successful reopen left the board showing `correction_triaged` — the same red
  // "an outside party stopped this filing" chip it showed before anyone did anything. The
  // operator's next move (go to the portal, review the reopened application, click ITS
  // resubmit) had no state to hang off, and the one status that says exactly that —
  // `awaiting_human_resubmit` — existed in the union with a label and a banner and zero
  // writers. This is that writer.
  //
  // KEYED ON runStatus, NOT `ok`: runStatus already folds in the pause (`pauseReason ?
  // "paused_for_human" : ok ? ... : "failed"`), so an adapter that ever returns ok together
  // with a pause reason cannot announce a staged resubmission that walled at an MFA screen.
  //
  // ONLY FROM A CORRECTION STATE, and the status is re-read HERE rather than reused from the
  // `detail` loaded before the await — the portal run takes minutes, and a monitor sweep or an
  // operator override may have moved the project meanwhile. A reopen is not evidence about any
  // status other than the one it was started from, so anything else is left exactly as it is
  // and the skip is AUDITED: a status that refused to move must never be invisible.
  if (runStatus === "awaiting_human_resubmit") {
    const current = text(db.get<Row>("SELECT status FROM projects WHERE id = ?", [projectId])?.status);
    // THE EVIDENCE OF A CORRECTION CYCLE IS AN OPEN CORRECTION, NOT A STATUS VALUE.
    //
    // Keying purely on `correction_received`/`correction_triaged` made this writer a
    // measured no-op on the only two live projects it exists for: the permit monitor
    // rewrites projects.status on EVERY sweep, so a correction open for days sits at
    // `submitted` (Ivy 720b05f3) or `issued` (Ann 1fb3dc39) long before an operator
    // clicks reopen. The guard then skipped, the run recorded, and the board showed
    // nothing — the exact silence this leg was built to end.
    //
    // ISSUED IS STILL PROTECTED, and deliberately so. A project-level status cannot say
    // "permit issued, NEM correction pending", so rewinding an issued permit to
    // `awaiting_human_resubmit` would DESTROY the more important fact. Terminal states
    // are therefore excluded and the skip stays audited; everything else that is
    // genuinely mid-cycle is now admitted.
    const TERMINAL_KEEPS_ITS_FACT = new Set(["issued", "handoff_ready", "nem_approved", "archived"]);
    const hasOpenCorrection = Number(
      db.get<Row>("SELECT COUNT(*) AS n FROM corrections WHERE project_id = ? AND closed_at IS NULL", [projectId])?.n ?? 0,
    ) > 0;
    if (hasOpenCorrection && !TERMINAL_KEEPS_ITS_FACT.has(current)) {
      db.run("UPDATE projects SET status = 'awaiting_human_resubmit', current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
        "Correction form reopened on the portal — a person must review the application and click its resubmit.",
        "correction_reopened" satisfies StageDetail,
        nowIso(), projectId,
      ]);
      addAuditLog(db, projectId, "system", "correction reopen", "correction.project_awaiting_resubmit", {
        correctionId, runId, applicationNumber, from: current,
      });
    } else {
      addAuditLog(db, projectId, "system", "correction reopen", "correction.reopen_status_unchanged", {
        correctionId, runId, applicationNumber, from: current,
        why: "the project is no longer in a correction state — a reopen never overwrites an unrelated status",
      });
    }
  }

  if (!ok && needsHuman) {
    return { ...surfaceNeedsHuman(message || `Correction reopen for ${applicationNumber} needs a human.`, { offeredForms, runId }), driftWarnings };
  }
  return {
    ok,
    needsHuman: false,
    message: message || (ok
      ? `Reopened the correction form for ${applicationNumber}. Review the application in the portal and click its resubmit yourself.`
      : `Correction reopen for ${applicationNumber} did not complete.`),
    reopenedForm: String(result.reopenedForm ?? "") || undefined,
    attachedDocs: Number(result.attachedDocs ?? 0),
    browserLeftOpen: result.browserLeftOpen === true,
    offeredForms,
    driftWarnings,
    runId,
  };
}

// A review item that ADVISES rather than GATES. 'Background job failed' is an operator
// notification from the job worker; 'Run triage' is an unreviewed suggestion from the
// automated triage of a failed run. Counting either against the staging gate builds a
// feedback loop that live-locked a project twice in one afternoon: run fails → triage files
// a suggestion → the pending suggestion gates the RETRY it was supposed to help → the
// retry's failure files another. Both times the "missing" data was already on the record.
// Agent proposals advise; only a human's own pending items gate.
export function isAdvisoryReviewItem(issueType: string): boolean {
  return issueType === "Background job failed" || issueType === "Run triage";
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
    /** 'building' | 'electrical' | 'combo' | 'nem' — WHICH permit this track is.
     *  Omitting it leaves the client portal unable to tell a project's structural permit from
     *  its electrical one; both then render as the honest but unhelpful "Permit". */
    permitType?: string;
  },
): ProjectDetail {
  const detail = getProjectDetail(db, projectId);
  const frequency = Math.max(1, Math.floor(Number(input.checkFrequencyDays || 7)));
  // The ONE answer to "what track is this target" (trackKind): `{permitType:'nem'}` with no target
  // type is a NEM filing at this door too — the rule-5 refusal below used to read the raw
  // (defaulted 'permit') type and refuse that filing's own PowerClerk URL as "a utility portal on a
  // permit", while the row it would have written was the split shape MF3 removes.
  const targetType: "permit" | "nem" = trackKind(input.targetType ?? "", input.permitType ?? "");
  // RULE 5 AT THE DOOR. This form accepted a PacifiCorp PowerClerk URL as a PERMIT target
  // (production row 99ea32c3 on 1fb3dc39, duplicating that project's NEM target), and every
  // later consumer — the permit monitor, the correction reopen, the knowledge learner below —
  // then treats a utility interconnection portal as the AHJ's. The correction-reopen path
  // already refuses such a row; refusing it here stops it being written at all. Same
  // predicate as permitSafeUrl (host-only, so an AHJ URL that merely mentions a utility in
  // its path is still accepted). Refused BEFORE the transaction so neither the row nor the
  // learned portal is recorded. The reverse (an AHJ portal given as a NEM target) is not
  // guarded: no predicate here recognises an AHJ permit portal by host.
  // ONE rule, one message: ensureCheckTarget (every door's creator) enforces the same check;
  // this early call only keeps the refusal ahead of the transaction.
  refuseUtilityUrlOnPermitTarget(targetType, input.portalUrl);
  db.transaction(() => {
    // THROUGH THE ONE CREATOR (submittalTracks.ts). This used to be its own unconditional
    // INSERT, so adding the same filing twice — which is what an operator does after a page
    // refresh loses the first attempt — left two rows polling one application. The row shape
    // is unchanged: portal_platform is still auto-detected from the URL, permit_type still
    // defaults from target_type (migration v28's reason), and next_check_at is still
    // nextCheckIso(frequency) rather than "now", because THIS door records a filing that may
    // have gone in weeks ago; only a just-captured confirmation is due on the next sweep.
    const ensured = ensureCheckTarget(db, detail.project, {
      targetType,
      permitType: input.permitType || (targetType === "nem" ? "nem" : ""),
      applicationNumber: input.applicationNumber,
      permitNumber: input.permitNumber,
      jurisdiction: input.jurisdiction || "",
      portalName: input.portalName || "",
      portalUrl: input.portalUrl || "",
      notes: input.notes || "",
      checkFrequencyDays: frequency,
      nextCheckAt: nextCheckIso(frequency),
    });
    // AUDITING "created" FOR AN UPDATE IS A LIE. The two actions are separate strings so an
    // operator reading the audit panel (it renders the action name) can tell which happened.
    addAuditLog(
      db, projectId, "system", "permit monitor",
      ensured.created ? "permit_target.created" : "permit_target.updated",
      { targetId: ensured.targetId, targetType, matchedOn: ensured.matchedOn },
    );
    // Unchanged on purpose: the portal this target names is the same fact to learn whether the
    // row was inserted or updated, so the knowledge event keeps its original type.
    // (learnFromPermitTarget reads jurisdiction/portal fields only — never the target type.)
    learnFromPermitTarget(db, detail.project, input);
  });
  return getProjectDetail(db, projectId);
}

export async function recordPermitStatusCheck(
  db: AppDb,
  projectId: string,
  input: {
    targetId?: string | null;
    /** THE READING'S TRACK WHEN THERE IS NO TARGET to say — WORDING ONLY, NEVER AUTHORITY. The
     *  email tracker passes the email's own workflow so a utility's approval email filed with no
     *  NEM target is at least CLASSIFIED as the interconnection reading it is (its label and the
     *  human-review item say "interconnection approved", not "plan review"). Honoured only when
     *  `targetId` is absent: a target's own kind (trackKind) always wins. It never lets the reading
     *  write a track status: with no target, readingMayFinishTrack refuses every finishing outcome
     *  whatever this says (the POST /api/projects/:id/permit-checks route passes the request body
     *  straight through, so this IS a body field — a caller declaring `track: "nem"` gets a
     *  human-review item, not nem_approved). Omitted with no target: classified as a permit
     *  reading, refused the same way. */
    track?: TrackKind | null;
    source?: PermitCheckSource;
    rawStatusText?: string;
    applicationNumber?: string;
    permitNumber?: string;
    /** The notice's own date (an email's Date header) — the cure clock of any correction this
     *  reading raises starts there, not at ingestion. Omitted: the status date the page prints
     *  (permitMonitor.extractStatusDate), if any. */
    noticedAt?: string | null;
  },
): Promise<ProjectDetail> {
  const detail = getProjectDetail(db, projectId);
  const target = input.targetId
    ? db.get<Row>("SELECT * FROM permit_check_targets WHERE id = ? AND project_id = ?", [input.targetId, projectId])
    : null;
  if (input.targetId && !target) throw new HttpError(404, "Permit check target not found.");

  const source = input.source || "manual";
  const rawStatusText = await resolveStatusText(target, input.rawStatusText || "", source);
  // The notice's own date: the caller's (an email's Date header), else the date the page itself
  // prints for its status (#58: the portal monitor passes none). Neither: null, and the cure clock
  // of a correction this reading raises starts at ingestion.
  const noticedAt = input.noticedAt || extractStatusDate(rawStatusText);
  // THE TARGET'S TRACK decides what its words mean: a utility's "Approved" is the interconnection
  // approval (nem_approved), a jurisdiction's is plan review done (reviewed_by_ahj). ONE ANSWER,
  // trackKind (a legacy target with a blank or 'permit' target_type and permit_type 'nem' is the
  // NEM filing it is), derived HERE ONCE and handed to everything downstream — the project-status
  // writer, the track finish, the client update — which used to re-read raw target_type and
  // disagree with the classifier (decisions-0926 skeptic MF3: such a target read "Approved" as
  // nem_approved and then the project stayed 'submitted', or read "Permit Issued" and the project
  // went 'issued' from a utility filing). With no target: the caller's declared track (the email
  // tracker's workflow), else null = unknown provenance, classified as a permit reading and never
  // guessed into the utility's queue.
  const track: TrackKind | null = target ? trackKind(text(target.target_type), text(target.permit_type)) : (input.track ?? null);
  // WHAT THE TEXT SAYS — the classifier's verdict on the words. Not yet what gets written.
  const read = classifyPermitStatusText(rawStatusText, track ?? "permit");
  // Previous outcome/label BEFORE this check updates the target — the client is notified only
  // when the outcome actually CHANGES (never re-sent on every poll of a settled status), and the
  // same pair decides whether this check is a row at all. Both must be read here, above the
  // UPDATE below that overwrites them.
  const previousOutcome = target ? text(target.latest_outcome) : "";
  const previousStatusLabel = target ? text(target.latest_status_label) : "";
  // PROVENANCE, FAIL-CLOSED (decisions-0926-final). A finishing/positive outcome (outcomeTrack:
  // nem_approved -> nem; issued / ready_for_issue / reviewed_by_ahj -> permit) is WRITTEN — check
  // row, target, project status, track finish, handoff, client update — only when
  // readingMayFinishTrack says the reading came from the portal or an operator's re-check, against
  // a target that exists, is active, and is a filing of the track that outcome belongs to. Every
  // other reading of such an outcome — an email of any bucket/workflow (the classifier's
  // reliability is irrelevant here), a no-target reading, a body-declared track, the other track's
  // family on this target — is PERSISTED as needs_human_review / "Reported, unconfirmed" with a
  // human-review item naming the reading and the reason, and reaches no client. Three skeptics
  // found this defect in three shapes; the persisted outcome is the load-bearing half, because
  // targetFinishedTrack reads permit_status_checks and latest_outcome, not the project status.
  //
  // THE ONE EXCEPTION IS AGREEMENT: an untrusted reading that says what the target ALREADY holds
  // (an AHJ email confirming a permit the poll already read as issued) is a confirmation, not
  // news — it finishes nothing that was not finished, the change gate below sends nothing, and
  // demoting it would downgrade a verified status to "unconfirmed" until the next poll.
  const writtenTrack = outcomeTrack(read.outcome);
  const provenance: ReadingProvenance = writtenTrack ? readingMayFinishTrack(source, target, writtenTrack) : { trusted: true };
  const confirmsKnown = Boolean(target) && previousOutcome === read.outcome;
  const refused = !provenance.trusted && !confirmsKnown;
  const classification: PermitStatusClassification = refused
    ? {
        outcome: "needs_human_review",
        statusLabel: UNCONFIRMED_READING_LABEL,
        confidence: read.confidence,
        reviewedByAhj: false,
        readyForIssue: false,
        issueFeeDue: false,
        message: `Reported, unconfirmed: a reading from ${source} says "${read.statusLabel}" (${read.outcome}), but ${provenance.trusted ? "" : provenance.reason}. `
          + `Confirm it on the ${writtenTrack === "nem" ? "utility's" : "jurisdiction's"} portal — a poll or a manual re-check against the filing's own active tracking target — before it counts.`,
      }
    : read;
  // A HISTORY OF CHANGES, NOT A LOG OF LOOKUPS.
  //
  // This table was written on every CHECK. A permit sitting in "In review" for three weeks got a
  // row per sweep, and a project with three polled targets got three rows per sweep, so the
  // client's "Recent updates" card showed twelve identical lines in pairs seconds apart. The gate
  // is shouldRecordStatusCheck() in permitMonitor.ts — it lives beside the classifier that
  // produces these labels, and this is its only caller. It is NOT re-derived here: a second copy
  // of "did anything move" would drift from the classifier feeding it.
  //
  // WHAT THIS GATES, AND WHY ALL THREE TOGETHER. The status-check row, the human_review_items row
  // and insertMonitorCorrection (which also writes its own human_review_items row and enqueues a
  // correction-triage job) are all "this is news" artifacts of one check. Gating only the check
  // row would leave a correction each sweep with no check row to hang off, and would keep
  // re-queuing triage for a correction already recorded. The FIRST poll that sees a correction is
  // a transition, so it is recorded in full; only the re-reads of that same state are suppressed.
  //
  // WHAT IS NOT GATED, deliberately: the permit_check_targets UPDATE (last_checked_at must
  // advance every time we look), updateProjectForPermitOutcome, triggerHandoffIfReady, the
  // audit_logs row, and learnFromPermitStatus. "When did we last look" and "when did it last
  // move" are two questions and both keep an answer.
  // Is the reading this target currently PUBLISHES one today's rules disagree with? Newest row by
  // rowid, the same row staleStatusClassifications offers a re-check for — if the answer is yes, a
  // fresh check must replace it even when it lands on the same pair (see shouldRecordStatusCheck).
  const newestRow = target
    ? db.get<Row>(
      "SELECT outcome, status_label, raw_status_text FROM permit_status_checks WHERE target_id = ? ORDER BY rowid DESC LIMIT 1",
      [input.targetId ?? null],
    )
    : null;
  const baselineStale = newestRow
    ? classificationDrift({ outcome: text(newestRow.outcome), statusLabel: text(newestRow.status_label), rawStatusText: text(newestRow.raw_status_text) }, track ?? "permit").stale
    : false;
  const recordCheck = shouldRecordStatusCheck(
    target ? { outcome: previousOutcome, statusLabel: previousStatusLabel, stale: baselineStale } : null,
    { outcome: classification.outcome, statusLabel: classification.statusLabel },
    source,
  );
  const ts = nowIso();
  const checkId = id();
  let correctionId: string | null = null;
  // Which required tracks were done BEFORE this reading — closeCorrectionsOnTerminalStatus closes
  // only what this reading FINISHES (a not-done → done transition), never on a re-poll. Read only
  // for a finishing reading that changed its target's outcome (an unchanged poll finishes nothing).
  const doneBeforeReading = (classification.outcome === "issued" || classification.outcome === "nem_approved") && previousOutcome !== classification.outcome
    ? trackDoneSnapshot(db, detail.project)
    : null;

  db.transaction(() => {
    // `recordCheck &&` on all three: see the note above. An unchanged poll falls straight through
    // to the target/project/audit work below, which is NOT gated.
    if (recordCheck && classification.outcome === "correction_flagged") {
      // THE TARGET THIS TEXT WAS READ ON travels with the correction — which jurisdiction (if any)
      // it teaches is decided from the check itself, never reverse-engineered from the page text.
      correctionId = insertMonitorCorrection(db, detail.project, rawStatusText, classification.message, ts, source === "email" ? "email" : "portal", {
        targetId: text(target?.id),
        targetType: text(target?.target_type),
        permitType: text(target?.permit_type),
        jurisdiction: text(target?.jurisdiction),
        recordNumber: input.permitNumber || text(target?.permit_number) || input.applicationNumber || text(target?.application_number),
        readingSource: source,
      }, noticedAt);
    } else if (recordCheck && refused) {
      // THE REFUSED READING'S OWN ROW — issue_type names it, parser_value carries what the text
      // said (outcome + label), notes carry why it was not trusted. This is the item an operator
      // resolves by re-checking the portal (which writes a trusted row through this same
      // function); nothing else moves the track. Distinct from the generic status-review row
      // below so the queue shows a reported approval as what it is, not as "needs review".
      db.run(
        `INSERT INTO human_review_items
          (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id(),
          projectId,
          "Permit monitor: reported status, unconfirmed",
          "permit_status_unconfirmed",
          `${read.outcome}: ${read.statusLabel}`.slice(0, 400),
          "",
          rawStatusText.slice(0, 800),
          "pending",
          classification.message,
          ts,
          ts,
        ],
      );
    } else if (recordCheck && classification.outcome === "needs_human_review") {
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

    if (recordCheck) {
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
    }

    if (target) {
      // The cadence follows THIS reading: an open filing is read again tomorrow (effectiveCheckDays).
      const frequency = effectiveCheckDays(target.check_frequency_days, classification.outcome);
      db.run(
        `UPDATE permit_check_targets
         SET last_checked_at = ?, next_check_at = ?, latest_outcome = ?, latest_status_label = ?, updated_at = ?
         WHERE id = ?`,
        [ts, nextCheckIso(frequency, new Date(ts)), classification.outcome, classification.statusLabel, ts, input.targetId || null],
      );
    }

    // ONLY A TRUSTED FINISHING READING TOUCHES THE PROJECT STATUS OR THE HANDOFF. A refused one is
    // persisted as unconfirmed above and writes no status; an AGREEING untrusted one persists its
    // row but is a confirmation — it changes no status either (a legacy email-written nem_approved
    // target beside a project at 'submitted', then one more email saying "PTO Granted", must not
    // reach the writer as "nem_approved on the NEM track" and hand the project off). Ungated
    // outcomes (waiting / correction / needs_human_review) pass as they always did.
    const mayWriteStatus = !writtenTrack || provenance.trusted;
    if (mayWriteStatus) updateProjectForPermitOutcome(db, detail.project.status, projectId, classification.outcome, classification.message, ts, track, input.targetId || null);
    // AFTER the status write (so resolveCorrection sees the project already issued and does not
    // rewind it) and BEFORE the handoff check (an open correction is a handoff blocker, so the
    // same reading that finishes the scope can hand it off).
    if (doneBeforeReading) closeCorrectionsOnTerminalStatus(db, detail.project, classification.outcome, doneBeforeReading, ts);
    // A STRUCTURAL permit target's first issued reading: record the approved design's stated
    // criteria as corroboration for that jurisdiction (never its designCriteria). Idempotent per
    // target. An electrical or NEM issuance approved no structure and records nothing.
    if (target && classification.outcome === "issued" && previousOutcome !== "issued"
      && isStructuralPermitTrack(text(target.target_type), text(target.permit_type))) {
      recordApprovedDesignObservation(db, detail.project, {
        targetId: text(target.id), ahj: text(target.jurisdiction), issuedAt: ts,
        recordNumber: input.permitNumber || text(target.permit_number) || input.applicationNumber || text(target.application_number),
      });
    }
    if (mayWriteStatus) triggerHandoffIfReady(db, projectId, ts);
    // ONE ROW PER CHECK, ALWAYS — this is the per-check evidence trail, and it is the thing the
    // status-check gate above is allowed to suppress *because* this is not. `checkId` is null when
    // no row was written: an audit entry pointing at a permit_status_checks id that does not exist
    // would be worse than no id at all.
    addAuditLog(db, projectId, "system", "permit monitor", "permit_status.checked", {
      checkId: recordCheck ? checkId : null,
      recorded: recordCheck,
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
        // Blank when this check was not persisted — learnFromPermitStatus reads outcome/labels/
        // timestamps and never the id, so the KB still learns from every look.
        id: recordCheck ? checkId : "",
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
    // Turnaround is a MILESTONE, not a look: at most one sample per (project, track, milestone),
    // measured from that track's own submitted_at. See timelineSamples.ts.
    recordTimelineSample(db, detail.project, target, { outcome: classification.outcome, createdAt: ts });
  });

  // CLIENT UPDATE — after the transaction committed. Fire-and-forget: sends (or drafts,
  // when SMTP is unconfigured) a plain-language email to the submitting client with the
  // new status + their read-only status link, and records it in the CRM timeline.
  // THE NOTIFIER ASKS THE SAME PROVENANCE PREDICATE, on what the text SAID (`read`), not on the
  // demoted row: a reading this function refused to write is refused here for the same reason,
  // by the same verdict, so the two doors cannot disagree. (Passing the persisted outcome instead
  // would make this gate dead code — it would only ever see needs_human_review.)
  if (shouldNotifyClient(read.outcome, previousOutcome, provenance)) {
    void notifyClientOfStatusChange(db, detail.project, {
      outcome: read.outcome,
      statusLabel: read.statusLabel,
      // The writer's ONE track (trackKind), never raw target_type: the wording's "which side
      // moved / what is still outstanding" must agree with what was just written.
      targetType: track ?? "permit",
      // The jurisdiction's own reference. Without these the client update reads "has issued the
      // permit." with nothing they can quote back to the AHJ — the whole point of the sentence is
      // that they can look it up themselves. Optional on the signature, so omitting them
      // typechecked silently and only production was affected.
      // Which permit, not just "the permit" — a project files a structural AND an electrical
      // one, and "has issued the permit" leaves the client guessing which crew to book.
      permitType: text(target?.permit_type),
      permitNumber: text(target?.permit_number),
      applicationNumber: text(target?.application_number),
    });
  }

  return getProjectDetail(db, projectId);
}

async function resolveStatusText(target: Row | null, rawStatusText: string, source: PermitCheckSource): Promise<string> {
  const trimmed = rawStatusText.trim();
  if (trimmed) return trimmed;
  // "mock" source = no portal URL and no recipe to check against. NEVER fabricate a
  // status here — a made-up "under review" classifies as a real outcome and can email
  // the client a fake update. Honest answer only, except in explicit offline/dev mode
  // (PORTAL_AUTOSEED=0, the same switch that enables the mock staging adapter).
  if (source === "mock") {
    const offlineDev = isAutoSeedDisabled();
    return offlineDev
      ? "Application is under review. Plans assigned to reviewer."
      : "No status text available. Manual AHJ/utility portal check required.";
  }

  // Rule 5 both ways at the fetch (resolution skeptic MF3): a permit target bound to a utility
  // host (production 99ea32c3: permit, APP-111667, pacificorpnetmetering.powerclerk.com) is not
  // fetched, and a NEM target bound to an AHJ permit platform is not either.
  const fetchUrl = target ? trackSafeUrl(trackKind(text(target.target_type), text(target.permit_type)), text(target.portal_url)) : "";
  if ((source === "public_url" || source === "portal") && target && fetchUrl) {
    // Try the platform-aware public fetcher (Accela capID URL, EnerGov CSS API,
    // SolarAPP+, or generic HTML strip). Passes application/permit numbers so
    // Accela can construct the direct record-detail URL without login.
    const appNums = [text(target.application_number), text(target.permit_number)].filter(Boolean);
    const publicText = await publicStatusFetch(fetchUrl, appNums).catch(() => null);
    // A LOGIN PAGE IS NOT A PERMIT STATUS. isAuthWallText already guards the authenticated
    // scrape path three times over; this path never consulted it, so an expired PowerClerk
    // session returned "PowerClerk Log In Username: Password: Forgot Password?..." and that
    // string was stored as the filing's status and escalated to a person to read. Measured
    // 2026-09-22 while counting operator interruptions: of ten open "permit monitor status
    // review" items, several are this. The same failure honest in one path and silent in
    // its sibling is the shape that keeps producing these.
    if (publicText && isAuthWallText(publicText)) {
      return "The portal returned its LOGIN page, not a status — the stored session or credential for this portal is no longer valid. Refresh the credential, then re-check; nothing about the filing has been read.";
    }
    if (publicText && publicText.length > 40) return publicText;
  }

  return "No status text available. Manual AHJ/utility portal check required.";
}

function insertMonitorCorrection(
  db: AppDb,
  project: ProjectRecord,
  readText: string,
  monitorMessage: string,
  ts: string,
  source: CorrectionRecord["source"],
  origin: CorrectionReadingOrigin,
  noticedAt: string | null = null,
): string {
  // A portal reading is the record PAGE; the correction is what that page asks for.
  const { correctionText, sourceText } = correctionFromReading(readText, source === "portal");
  const classification = classifyCorrection(correctionText);
  const correctionId = id();
  // The filing is the TARGET's (its target_type / permit_type), never the page's words.
  const filing: CorrectionFilingInput = origin.targetId ? { targetType: origin.targetType, permitType: origin.permitType, noticedAt } : { noticedAt };
  const stamp = correctionFilingStamp(db, project, correctionId, ts, filing);
  db.run(
    `INSERT INTO corrections (
      id, project_id, source, correction_text, source_text, correction_bucket, root_cause, required_action,
      assigned_to, draft_response, human_approved, resubmitted, new_rule_recommended, created_at, closed_at,
      track, submission_id, notice_id, noticed_at, sla_days, due_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      correctionId,
      project.id,
      source,
      correctionText,
      sourceText,
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
      stamp.track, stamp.submissionId, stamp.noticeId, stamp.noticedAt, stamp.slaDays, stamp.dueAt,
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
      `agent-triage:${JSON.stringify({ correctionId, bucket: classification.bucket, proposals: [], actions: [monitorMessage, classification.requiredAction] })}`,
      ts,
      ts,
    ],
  );
  learnFromCorrection(db, project, correctionId, classification, correctionText, source);
  // A design requirement the AHJ stated -> a proposal for the jurisdiction of the TARGET it was
  // read on (human-applied). A NEM target's correction proposes nothing (hard rule 5).
  attachJurisdictionProposals(db, correctionId, origin);
  enqueueCorrectionTriage(db, project.id, correctionId, correctionText);
  return correctionId;
}

/**
 * A FINISHED FILING HAS ANSWERED ITS CORRECTION (LNK-7).
 *
 * The UI promises "the correction closes when the resubmission actually goes out", and that
 * close (captureConfirmation) never fires for a correction answered in the portal or by reply.
 * Such a correction stayed open forever: overdue on the KPI, and a permanent handoff blocker on
 * a project whose permit is issued. An issued permit / approved interconnection has by
 * definition satisfied the correction raised against it, so when a reading finishes a track the
 * engine closes what that finish answers — judged by isTrackDone, the ONE "is this track done"
 * rule (ever finished on its own kind of target, no correction read since):
 *   - a correction the monitor raised on a tracking target closes when THAT target's track is
 *     done (an untagged permit target: when every permit track is);
 *   - any other correction (manual, email with no target) closes only when EVERY required track
 *     is done and no active target still reads correction_flagged.
 * Closed through resolveCorrection with a system actor and reason closed_on_terminal_status.
 *
 * ONLY ON A TRANSITION, ONLY WHAT EXISTED BEFORE IT. A correction is closed by the reading that
 * FINISHES what answers it — its answer predicate was false before this reading (`doneBefore`,
 * snapshotted before the check row and target update) and is true after it — and only when it
 * was created at or before that reading. Without both, a correction an operator (or an email with
 * no target) entered on an already-finished project was closed by the next routine poll that
 * re-read "issued", or by a blip through an unreadable page and back, and the project snapped
 * back to handoff_ready (skeptic PROBE A). A re-issue after a NEW correction on the target is a
 * real transition (the correction made the track not-done), so that still closes.
 */
function trackDoneSnapshot(db: AppDb, project: ProjectRecord): Map<SubmittalTrackType, boolean> {
  const required = requiredTracks(project);
  return new Map(required.map((track) => [track, isTrackDone(db, project.id, track, required)]));
}

function closeCorrectionsOnTerminalStatus(
  db: AppDb,
  project: ProjectRecord,
  outcome: PermitCheckOutcome,
  doneBefore: Map<SubmittalTrackType, boolean>,
  readingAt: string,
): number {
  if (outcome !== "issued" && outcome !== "nem_approved") return 0;
  const open = db.query<Row>(
    "SELECT id FROM corrections WHERE project_id = ? AND closed_at IS NULL AND created_at <= ? ORDER BY created_at ASC",
    [project.id, readingAt],
  );
  if (!open.length) return 0;
  const required = requiredTracks(project);
  const doneNow = trackDoneSnapshot(db, project);
  const anyTargetInCorrection = Boolean(db.get<Row>(
    "SELECT id FROM permit_check_targets WHERE project_id = ? AND active = 1 AND latest_outcome = 'correction_flagged' LIMIT 1",
    [project.id],
  ));
  let closed = 0;
  for (const row of open) {
    const correctionId = text(row.id);
    const raisedOn = db.get<Row>(
      `SELECT t.target_type, t.permit_type FROM permit_status_checks c
         JOIN permit_check_targets t ON t.id = c.target_id
        WHERE c.correction_id = ? LIMIT 1`,
      [correctionId],
    );
    const answeredBy = (done: Map<SubmittalTrackType, boolean>): boolean => {
      const isDone = (track: SubmittalTrackType) => done.get(track) === true;
      if (raisedOn) {
        const track = trackForTarget(text(raisedOn.target_type), text(raisedOn.permit_type));
        return track === "permit" ? required.filter((t) => t !== "nem").every(isDone) : isDone(track);
      }
      return required.length > 0 && required.every(isDone);
    };
    const answered = answeredBy(doneNow) && !answeredBy(doneBefore) && (Boolean(raisedOn) || !anyTargetInCorrection);
    if (!answered) continue;
    resolveCorrection(db, correctionId, {
      resubmitted: false,
      actor: { type: "system", name: "permit monitor" },
      reason: "closed_on_terminal_status",
    });
    addAuditLog(db, project.id, "system", "permit monitor", "correction.closed_on_terminal_status", { correctionId, outcome });
    closed++;
  }
  return closed;
}

/** The required PERMIT tracks (building / electrical / combo — never NEM) with a TRACKED filing
 *  that is not yet done (isTrackDone). A required track nobody has filed/tracked is not "in
 *  review" and does not hold the headline — the tracks panel already shows it as not started. */
function permitTracksStillOpen(db: AppDb, projectId: string): SubmittalTrackType[] {
  const row = db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!row) return [];
  const required = requiredTracks(mapProject(row));
  return required.filter((t) => t !== "nem" && trackHasFiling(db, projectId, t, required) && !isTrackDone(db, projectId, t, required));
}

function updateProjectForPermitOutcome(
  db: AppDb,
  currentStatus: ProjectRecord["status"],
  projectId: string,
  outcome: PermitCheckOutcome,
  message: string,
  ts: string,
  /** The reading's track as the writer derived it ONCE (trackKind of the target; the caller's
   *  declared track for a no-target reading); null = unknown provenance (a project-level check
   *  with no target and no declared track), which is neither side. */
  track: TrackKind | null,
  targetId?: string | null,
): void {
  const update = (status: ProjectRecord["status"], stage: string, detail: StageDetail) => {
    db.run("UPDATE projects SET status = ?, current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [status, stage, detail, ts, projectId]);
  };
  // UNKNOWN PROVENANCE WRITES NO TRACK STATUS. With track null, isNem and isPermit below are BOTH
  // false, so every guarded branch would be open — "PTO Granted" with no target wrote nem_approved,
  // "Permit Issued" wrote issued, "Approved pending payment" wrote ready_for_issue (decisions-0926
  // close-v skeptic MF-B). recordPermitStatusCheck already refuses such a reading upstream
  // (readingMayFinishTrack: no target -> needs_human_review), so a finishing outcome never arrives
  // here with a null track; this guard states the invariant at the door itself, so the writer is
  // closed even if a new caller reaches it directly.
  if (track === null && outcomeTrack(outcome)) return;

/** Statuses a "still in review" reading may advance to "submitted".
 *
 *  "issued", "nem_approved" and "handoff_ready" are deliberately ABSENT: this branch carries no
 *  track guard, so including them let one track's "waiting" read rewrite a headline the OTHER
 *  track had already earned — an issued permit re-described as still in review, by the utility.
 *  "awaiting_human_submit" IS present by operator ruling (2026-09-20): the portal showing an
 *  application in review is evidence a person filed it, so a filing sent by hand is not stranded. */
const MONITOR_WAITING_MAY_ADVANCE = new Set(["awaiting_human_submit", "submitted", "approved", "ready_for_issue"]);

  // `approved` and `ready_for_issue` ARE in the list above, and they are PERMIT-earned: only a
  // permit target's reading can write them (the !isNem guards below). So a waiting reading may
  // take the project back from one of them only when it is the PERMIT side speaking AND no other
  // target still holds the greater outcome. Without this, a NEM "Engineering Review" — or the
  // ELECTRICAL permit's "plan review in progress" on a separate-permit AHJ — recorded after the
  // BUILDING permit reached ready_for_issue rewrote the project to submitted/under_review: the
  // fees-due fact erased by a different filing that is simply slower. Unknown provenance (no
  // target, or a non-permit target) never rewinds; the same permit filing regressing is the one
  // reading that still may.
  //
  // ONLY A PERMIT TARGET'S PROGRESS MAY HOLD A PERMIT STATUS. The same !isNem rule that stops a
  // NEM reading from WRITING ready_for_issue applies to what may KEEP it: a NEM target whose own
  // text classified as "ready to issue" (a utility "approved, fee due") never earned the project
  // that status, so it must not pin it when the one permit filing that did earn it regresses.
  const waitingWouldRewindAnotherTrack = (): boolean => {
    if (currentStatus !== "approved" && currentStatus !== "ready_for_issue") return false;
    if (!isPermit) return true;
    // Kind by trackKind (the one answer), judged in JS — a raw `target_type = 'permit'` filter
    // would count a legacy 'permit'-typed NEM filing as a permit holding the status.
    return db.query<Row>(
      `SELECT target_type, permit_type FROM permit_check_targets
        WHERE project_id = ? AND active = 1 AND id <> ?
          AND latest_outcome IN ('reviewed_by_ahj', 'ready_for_issue', 'issued')`,
      [projectId, targetId || ""],
    ).some((row) => trackKind(text(row.target_type), text(row.permit_type)) === "permit");
  };

  // Track-aware guard: a NEM (utility) target must NEVER drive the project to a PERMIT
  // status (issued / ready_for_issue / reviewed-by-AHJ) — those are AHJ-permit outcomes.
  // Likewise a PERMIT target must not set nem_approved. This prevents a utility approval
  // from masquerading as a permit issuance (and vice-versa). Handoff readiness is derived
  // from the per-target outcomes in triggerHandoffIfReady, which is already track-aware.
  // `track` is the writer's ONE derivation (trackKind) — this used to test raw target_type,
  // so a 'permit'-typed target with permit_type 'nem' was classified as NEM and then written
  // as a permit here.
  const isNem = track === "nem";
  const isPermit = track === "permit";

  // ONE FILING'S GOOD NEWS DOES NOT CLEAR ANOTHER FILING'S CORRECTION.
  //
  // The project has one status and every target's reading writes it, so the ELECTRICAL permit
  // reading "issued" two minutes after the BUILDING permit's correction was detected rewrote
  // correction_received to issued — the most urgent state in the system hidden, for weeks, on a
  // live project, while the client portal said "issued". A positive reading may leave a
  // correction state only when no OTHER active target of this project still stands at
  // correction_flagged. The SAME target recovering (its own correction answered, now issued) is
  // legitimate news and still moves the project; a reading with no target (unknown provenance)
  // never clears a correction that some target still holds.
  const anotherTargetInCorrection = (): boolean => {
    if (currentStatus !== "correction_received" && currentStatus !== "correction_triaged") return false;
    return Boolean(db.get<Row>(
      `SELECT id FROM permit_check_targets
        WHERE project_id = ? AND active = 1 AND id <> ? AND latest_outcome = 'correction_flagged'
        LIMIT 1`,
      [projectId, targetId || ""],
    ));
  };
  const positive = outcome === "nem_approved" || outcome === "ready_for_issue" || outcome === "issued" || outcome === "reviewed_by_ahj";
  if (positive && anotherTargetInCorrection()) return;
  // HANDOFF IS THE GREATEST OUTCOME; ONLY A CORRECTION MAY LEAVE IT. The monitor keeps polling
  // a handed-off project's targets, and each repeat "PTO granted" rewrote handoff_ready to
  // nem_approved — after which triggerHandoffIfReady saw a fresh transition and published the
  // installer handoff note AGAIN, every poll. A positive reading on a handed-off project is not
  // news about the project; a correction is, and still falls through to the branch below.
  if (positive && currentStatus === "handoff_ready") return;

  if (outcome === "correction_flagged") update("correction_received", "Permit monitor flagged a correction. Review bucket and next action.", "correction_open");
  else if (outcome === "nem_approved" && !isPermit) update("nem_approved", message, "nem_approved");
  else if (outcome === "ready_for_issue" && !isNem) update("ready_for_issue", message, "ready_for_issue");
  else if (outcome === "issued" && !isNem) {
    // ONE PERMIT ISSUED IS NOT THE PROJECT'S PERMITS ISSUED (live 2026-09-28: a separate-permit
    // AHJ's electrical permit read "Permit Issued" while its building permit sat in review, and the
    // project headline said "issued"). The headline is "issued" only once every required PERMIT
    // track is done — isTrackDone, the one answer the tracks panel and the handoff read. Before
    // that the issued filing is news on its own track card; the project reads "submitted" (in
    // review), except where a greater permit state (fees due / approved) or the NEM approval
    // already holds it — this writer never rewinds those.
    const open = permitTracksStillOpen(db, projectId);
    if (!open.length) update("issued", message, "permit_issued");
    else if (["awaiting_human_submit", "submitted", "issued"].includes(currentStatus)) {
      const named: Record<string, string> = { building: "building permit", electrical: "electrical permit", combo: "building + electrical permit", permit: "permit", mpu: "panel-upgrade permit" };
      update("submitted", `${message.replace(/\s+$/, "")} Not yet issued: the ${open.map((t) => named[t] ?? `${t} permit`).join(" and the ")}.`, "under_review");
    }
  }
  else if (outcome === "reviewed_by_ahj" && !isNem) update("approved", message, "permit_approved");
  else if (outcome === "waiting" && MONITOR_WAITING_MAY_ADVANCE.has(currentStatus) && !waitingWouldRewindAnotherTrack()) {
    // THE PORTAL IS TRUTH ABOUT WHETHER A FILING EXISTS (operator ruling, 2026-09-20).
    //
    // An application the portal shows in review WAS filed by a person, whether or not they
    // came back and clicked Capture Confirmation — so `awaiting_human_submit` is deliberately
    // in the advance list. Without it a filing sent by hand sits at "awaiting your submit"
    // forever and the operator has to correct the board by hand.
    //
    // BUT A LESSER OUTCOME MAY NOT OVERWRITE A GREATER ONE. This branch has no track guard
    // (unlike every branch above it), so a NEM target reading "waiting" used to drag a project
    // back from `issued`, `nem_approved` or `handoff_ready` to `submitted` — a permit that IS
    // issued being re-described as still in review, by the other track. Those outcomes are
    // therefore NOT in the set: once a track has reached them, "somebody else is still
    // reviewing" is not news that should rewrite the project's headline.
    update("submitted", "Permit monitor checked: AHJ/utility review is still in progress.", "under_review");
    if (currentStatus === "awaiting_human_submit") {
      // The one advance a human did not gesture for. Audited so it is never invisible.
      addAuditLog(db, projectId, "system", "permit monitor", "project.submitted_on_portal_evidence", {
        from: currentStatus, targetType: track, message,
      });
    }
  } else if (outcome === "needs_human_review") {
    // THE STOMP STAYS A STOMP, AND DELIBERATELY DOES NOT WRITE stage_detail.
    //
    // This branch overwrites current_stage with a raw portal message and changes no status:
    // a project reading "Record Status: Intake Requirements Needed" in its stage line while
    // sitting in `submitted` is this line's doing. That is exactly the ambiguity stage_detail
    // exists to end — so the enum is left untouched here and keeps describing the last thing
    // that actually HAPPENED, while the prose carries the note about what was read. Writing a
    // value here would re-import the bug into the column built to escape it.
    db.run("UPDATE projects SET current_stage = ?, updated_at = ? WHERE id = ?", [message, ts, projectId]);
  }
}

function buildInstallerHandoffChecklist(project: ProjectRecord): string[] {
  const size = project.systemSizeDcKw ? `${project.systemSizeDcKw} kW DC` : "system";
  return [
    `PERMIT ISSUED — ${project.ahj || "AHJ"}: Download permit card and post at job site before work begins.`,
    `NEM APPROVED — ${project.utility || "Utility"}: Save the approval confirmation email/letter.`,
    `INSTALLATION: Install per the approved plans. Do not deviate from stamped set without re-permit.`,
    `RAPID SHUTDOWN: Label all rapid shutdown devices per approved plans before inspection.`,
    `FINAL INSPECTION: Schedule with ${project.ahj || "AHJ"}. Inspector will verify install matches approved plans.`,
    `AFTER INSPECTION PASSES: Send a copy of the signed final inspection card to ${project.utility || "the utility"} to trigger Permission to Operate (PTO).`,
    `PTO: Utility will issue PTO once inspection record is received. Timeline varies (typically 1–5 business days).`,
    `SYSTEM SIZE: ${size} — verify AC output at inverter matches NEM application.`,
    project.interconnectionMethod ? `INTERCONNECTION: ${project.interconnectionMethod}` : "",
    `HOMEOWNER: Notify ${project.homeownerName || "homeowner"} that the system can be energized only after PTO is received.`,
  ].filter(Boolean);
}

/**
 * IS THE SUBMISSION SCOPE COMPLETE? — the handoff predicate, per track, from the filings'
 * own tracking targets. Returns what still stands in the way (empty = hand off).
 *
 * It used to ask "has ANY check on this project ever read issued" OR "does the project status
 * read issued / ready_for_issue", and the same for NEM. The project status is only the LAST
 * reading's writer, so the answer depended on arrival order: `ready_for_issue` (fees still due,
 * no permit card) counted as issued; the electrical permit's "issued" counted while the building
 * permit sat in correction; and a NEM approval handed off a project whose permit had only ever
 * been read ready-for-issue. A false "scope complete" is the costliest error this stage can make:
 * the installer checklist says to post the permit card, and the job drops off the board.
 *
 * Now: every REQUIRED track (requiredTracks — the same list the tracks panel and staging use)
 * must be done by isTrackDone (submittalTracks.ts — the ONE "is this track done" rule the panel
 * also reads — ever issued/approved with no correction since, one unattributed target never
 * finishing two tracks), NEM always included since the handoff certifies a utility approval, no
 * active permit target attributed to none of those tracks may be unfinished on a multi-permit
 * project (unfinishedUnattributedTargets), and no correction on the project may be open.
 */
export function handoffBlockers(db: AppDb, project: ProjectRecord): string[] {
  const tracks: SubmittalTrackType[] = requiredTracks(project);
  if (!tracks.includes("nem")) tracks.unshift("nem");
  const blockers = unfinishedTracks(db, project.id, tracks).map((t) => `${t} track not done`);
  const unattributed = unfinishedUnattributedTargets(db, project.id, tracks);
  if (unattributed > 0) blockers.push(`${unattributed} unattributed permit tracking target(s) not done`);
  const openCorrections = Number(db.get<Row>(
    "SELECT COUNT(*) AS n FROM corrections WHERE project_id = ? AND closed_at IS NULL",
    [project.id],
  )?.n ?? 0);
  if (openCorrections > 0) blockers.push(`${openCorrections} open correction(s)`);
  return blockers;
}

function triggerHandoffIfReady(db: AppDb, projectId: string, ts: string): void {
  const project = db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!project) return;
  // Already handed off: nothing to write, and the note/audit are written only on the transition.
  // (A correction arriving after handoff has already moved the status to correction_received
  // before this runs, so it is not caught here — and the predicate below refuses it.)
  if (project.status === "handoff_ready") return;
  if (handoffBlockers(db, mapProject(project)).length > 0) return;

  const mappedProject = mapProject(project);
  const checklist = buildInstallerHandoffChecklist(mappedProject);
  const noteBody = [
    "✓ PERMIT ISSUED + NEM APPROVED — your submission scope is complete.",
    "",
    "Installer handoff checklist:",
    ...checklist.map((line, i) => `${i + 1}. ${line}`),
    "",
    "No further action required from this platform unless a correction is received after final inspection.",
  ].join("\n");

  db.run("UPDATE projects SET status = 'handoff_ready', current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
    "Permit issued + NEM approved. Ready for installer handoff.",
    "handoff_ready" satisfies StageDetail,
    ts,
    projectId,
  ]);

  db.run(
    `INSERT INTO project_notes (id, project_id, note_type, body, created_by, created_at)
     VALUES (?, ?, 'handoff', ?, 'system', ?)`,
    [id(), projectId, noteBody, ts],
  );

  addAuditLog(db, projectId, "system", "handoff trigger", "handoff.ready", {
    permitIssued: true,
    nemApproved: true,
    fromStatus: project.status,
  });
}

export async function runDuePermitChecks(
  db: AppDb,
  targetType: "permit" | "nem" | "all" = "all",
): Promise<{ checked: number; projects: ProjectDetail[] }> {
  const now = nowIso();
  // Kind by trackKind (the ONE answer), judged in JS rather than a raw `target_type = ?` filter
  // that would poll a legacy 'permit'-typed NEM filing in the permit sweep. The 50-per-sweep cap
  // is applied AFTER the kind filter, as the SQL LIMIT was, so a kind-scoped sweep still gets 50.
  const targets = db.query<Row>(
    `SELECT * FROM permit_check_targets
     WHERE active = 1 AND (next_check_at IS NULL OR next_check_at <= ?)
     ORDER BY next_check_at ASC, created_at ASC`,
    [now],
  ).filter((row) => targetType === "all" || trackKind(text(row.target_type), text(row.permit_type)) === targetType).slice(0, 50);
  const projects: ProjectDetail[] = [];
  for (const target of targets) {
    const projectId = text(target.project_id);
    // Try a live authenticated portal scrape, falling back to the public tracking URL
    // and finally mock. Authenticated strategies, in order:
    //   1. RECIPE-FIRST (universal): the recorded/auto-learned recipe for this project's
    //      AHJ/utility carries the portal URL + a generic checkStatus — the primary
    //      submission path (recipe-first) gets a matching status path, so approvals on
    //      ANY learned portal are auto-scanned, not just the two hardcoded platforms.
    //   2. Legacy hardcoded platform profiles (Accela / PowerClerk storage-state blobs).
    let rawStatusText: string | undefined;
    const targetType = trackKind(text(target.target_type), text(target.permit_type)); // "permit" | "nem" — the ONE answer
    const track = targetType;
    // ── WHOSE PORTAL? (resolution skeptic MF3: the same two-way predicate the stage uses) ──
    // The target's own URLs are judged by the TRACK half of rule 5, both ways: a permit target
    // bound to a utility host (production 99ea32c3) and a NEM target bound to an AHJ permit
    // platform are neither scraped nor fetched. The recipe is judged by track AND entity
    // (recipeHostFit): a recipe that drives the other track's host, another entity's portal or
    // a portal a person's verified row contradicts is never handed to the scraper.
    const safeTargetPortalUrl = trackSafeUrl(track, text(target.portal_url));
    const safeTrackingUrl = trackSafeUrl(track, text(target.tracking_url));
    if ((text(target.portal_url) && !safeTargetPortalUrl) || (text(target.tracking_url) && !safeTrackingUrl)) {
      addAuditLog(db, projectId, "system", "permit monitor", "portal.track_host_conflict", {
        targetId: text(target.id), track, url: text(target.portal_url) && !safeTargetPortalUrl ? text(target.portal_url) : text(target.tracking_url),
        reason: track === "nem" ? "the target's URL is an AHJ permit portal, and this is a NEM filing" : "the target's URL is a utility interconnection portal, and this is a permit filing",
      });
    }
    let source: "portal" | "public_url" | "mock" = safeTargetPortalUrl ? "public_url" : "mock";
    // WHY A READ CAME BACK EMPTY (issue #161): the scrapers report it, and the skip below logs and
    // audits it. "no portal URL/recipe" is said only when there truly was neither.
    let unreadableReason = "";
    let portalRead = false; // a recipe or platform scrape was attempted
    const noteReason = (r: string) => { if (r && !unreadableReason) unreadableReason = r; };
    const applicationNumbers = [text(target.application_number), text(target.permit_number)].filter(Boolean);
    const projectDetail = getProjectDetail(db, projectId);
    const clientId = projectDetail.project.clientId ?? "";
    const profileBase = process.env.PORTAL_PROFILES_DIR || path.join(process.cwd(), "portal-profiles");

    if (applicationNumbers.length > 0) {
      const scopeType: "ahj" | "utility" = targetType === "nem" ? "utility" : "ahj";
      let recipe =
        findCompleteRecipeForProject(db, { scopeType, state: projectDetail.project.state, ahj: projectDetail.project.ahj, utility: projectDetail.project.utility })
        ?? findAnyRecipeForProject(db, { scopeType, state: projectDetail.project.state, ahj: projectDetail.project.ahj, utility: projectDetail.project.utility });
      if (recipe) {
        const entityInput = { scope: scopeType, state: projectDetail.project.state, name: scopeType === "utility" ? projectDetail.project.utility : projectDetail.project.ahj, excludeRecipeIds: [recipe.id] };
        const fit = recipeHostFit(track, portalEntityEvidence(db, entityInput), recipe);
        if (!fit.fits) {
          addAuditLog(db, projectId, "system", "permit monitor", fit.code === "track_conflict" ? "portal.track_host_conflict" : "portal.entity_host_conflict", {
            targetId: text(target.id), track, recipeId: recipe.id, url: fit.url, code: fit.code, reason: fit.reason,
          });
          noteReason(`the recorded portal was not used for this filing: ${fit.reason}`);
          recipe = null;
        }
      }
      if (recipe?.portalUrl) {
        // Same credential/profile conventions as the learner/replay: portalType key is
        // "utility" | "AHJ", persistent per-client browser profile carries the session.
        const recipePortalType = scopeType === "utility" ? "utility" : "AHJ";
        const userDataDir = portalProfileDir(profileBase, clientId ?? null, recipePortalType, recipe.portalUrl);
        const credential = clientId
          ? (getDecryptedCredential(db, clientId, recipePortalType)
              ?? getDecryptedCredentialByUrl(db, clientId, recipe.portalUrl)
              ?? getDecryptedCredentialAny(db, clientId, recipe.portalUrl))
            ?? undefined
          : undefined;
        portalRead = true;
        const scraped = await statusScrape("recipe", applicationNumbers, {
          recipe,
          fieldValues: {},
          docsByType: {},
          headless: true,
          credential,
          userDataDir,
          onReason: noteReason,
        }).catch((err) => { noteReason(`the status read failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`); return null; });
        if (scraped && !isAuthWallText(scraped)) {
          rawStatusText = scraped;
          source = "portal";
        } else if (scraped) {
          noteReason("the portal page read was a sign-in wall");
        }
      }
    } else {
      noteReason("the filing has no application or permit number to look up");
    }

    const portalType = targetType === "nem" ? "powerclerk_pge" : "accela_oregon";
    // The legacy platform adapter logs in at the target's own URL — only a track-safe one.
    const portalProfile = rawStatusText || (text(target.portal_url) && !safeTargetPortalUrl) ? null : db.get<{ id: string; portal_type: string; encrypted_storage_state?: string }>(
      "SELECT * FROM portal_profiles WHERE portal_type = ? ORDER BY created_at DESC LIMIT 1",
      [portalType],
    );
    if (portalProfile?.encrypted_storage_state) {
      const userDataDir = portalProfileDir(profileBase, clientId ?? null, portalType, safeTargetPortalUrl);
      const credential = clientId
        ? (getDecryptedCredential(db, clientId, portalType)
            ?? (safeTargetPortalUrl ? getDecryptedCredentialByUrl(db, clientId, safeTargetPortalUrl) : null)
            ?? getDecryptedCredentialAny(db, clientId, safeTargetPortalUrl))
          ?? undefined
        : undefined;
      const adapterType = portalType === "powerclerk_pge" ? "powerclerk" : "accela";
      portalRead = true;
      const scraped = await statusScrape(adapterType, applicationNumbers, {
        encryptedStorageStatePath: portalProfile.encrypted_storage_state,
        headless: true,
        credential,
        userDataDir,
        // Track-scoped portal URL (already resolved for the credential lookup above) so a
        // multi-tenant platform adapter checks status on the RIGHT subdomain.
        loginUrl: safeTargetPortalUrl || undefined,
        onReason: noteReason,
      }).catch((err) => { noteReason(`the status read failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`); return null; });
      if (scraped && !isAuthWallText(scraped)) {
        rawStatusText = scraped;
        source = "portal";
      } else if (scraped) {
        noteReason("the portal page read was a sign-in wall");
      }
    }
    // No authenticated scrape — try the public tracking URL (exact CapDetail / record-detail
    // link that requires no login), then fall back to the generic portal_url.
    if (!rawStatusText) {
      const checkUrl = safeTrackingUrl || safeTargetPortalUrl;
      const appNums = [text(target.application_number), text(target.permit_number)].filter(Boolean);
      if (checkUrl) {
        const publicText = await publicStatusFetch(checkUrl, appNums).catch(() => null);
        if (publicText && publicText.length > 40 && !isAuthWallText(publicText)) {
          rawStatusText = publicText;
          source = "public_url";
        }
      }
    }
    // A CHECK THAT READ NOTHING IS NOT A STATUS. Two ways a sweep gathers no evidence: it
    // had nothing to check at all (source stays "mock"), or it had a URL that could not be
    // read — a PowerClerk project page is behind a login, so an anonymous fetch returns
    // nothing usable. Recording either as a status classifies the honest "no status
    // available" text as needs_human_review, which on a target we ALREADY know the status of
    // is a downgrade: one sweep turned three verified "In review" NEM rows into "Needs human
    // review" and stomped each project's current_stage with it.
    //
    // So: skip whenever no text was gathered — but ALWAYS reschedule. The old skip `continue`d
    // without touching next_check_at, leaving an unreadable target permanently due and
    // re-attempted on every single sweep (live: Ivy's NEM, still due from a poll an hour
    // earlier). A never-checked target is the one exception: recording the honest "manual
    // check required" is how the operator learns the link needs a login.
    const gatheredNothing = !rawStatusText && !isAutoSeedDisabled();
    const alreadyKnown = Boolean(text(target.latest_outcome));
    if (gatheredNothing && (source === "mock" || alreadyKnown)) {
      const days = effectiveCheckDays(target.check_frequency_days, text(target.latest_outcome));
      db.run("UPDATE permit_check_targets SET last_checked_at = ?, next_check_at = ?, updated_at = ? WHERE id = ?", [
        now,
        new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
        now,
        text(target.id),
      ]);
      // Say WHY (issue #161). "No portal URL/recipe" only when nothing could be read at all; otherwise
      // the scraper's own reason (sign-in failed, MFA asked, where it looked and how far).
      const why = unreadableReason
        || (portalRead ? "the portal read returned nothing" : (safeTrackingUrl || safeTargetPortalUrl) ? "the public page held no readable status" : "no portal URL or recipe to read");
      logger.info(
        "monitor",
        alreadyKnown
          ? `status unreadable this sweep — keeping the known status for target ${text(target.id)}: ${why}`
          : `skipping status check for target ${text(target.id)}: ${why}`,
        { projectId },
      );
      addAuditLog(db, projectId, "system", "permit monitor", "permit_status.unreadable", { targetId: text(target.id), track, reason: why });
      continue;
    }
    const detail = await recordPermitStatusCheck(db, projectId, {
      targetId: text(target.id),
      source,
      rawStatusText,
    });
    // THE PORTAL'S OWN FEE, off the same filed record (portalFeeReadings.ts) — after the status
    // is recorded and unable to change it: a failure here is logged and the sweep moves on.
    if (source !== "mock") {
      await readAndRecordPortalFees(db, detail.project, text(target.id)).catch((err) => {
        logger.warn("monitor", "portal fee read failed — status unaffected", { projectId, targetId: text(target.id), err: err instanceof Error ? err.message : String(err) });
      });
    }
    touchProjectMetrics(db, projectId);
    projects.push(detail);
  }
  return { checked: targets.length, projects };
}

// Extract a concise, non-sensitive failure reason from a stage result for operator
// display. Walks the steps for the first failure and takes its first line — the adapter
// puts the human-readable reason first; verbose browser launch logs follow after a
// newline and are dropped. Adapters already redact credentials/tokens from step
// messages, so this never surfaces secrets.
export function extractStageFailureMessage(result: Record<string, unknown>): string {
  const steps = Array.isArray(result.steps)
    ? (result.steps as Array<{ ok?: boolean; message?: unknown }>)
    : [];
  const firstFail = steps.find((s) => s && s.ok === false);
  const raw = typeof firstFail?.message === "string"
    ? firstFail.message
    : typeof result.message === "string"
      ? (result.message as string)
      : "Portal run failed before reaching review.";
  const firstLine = raw.split("\n")[0].trim();
  return firstLine.slice(0, 300) || "Portal run failed before reaching review.";
}

// ---------------------------------------------------------------------------------------------
// A STAGE RUN'S OUTCOME (A3). PortalRunStatus in shared/src/types.ts lags these values (that file
// belongs to another workstream); the column is TEXT and the backend owns the vocabulary here.
//   running               — the row written BEFORE the adapter starts
//   submitted             — automation clicked the final submit and the portal CONFIRMED it
//   submitted_unconfirmed — automation clicked the final submit and the portal did not say
//                           (a human verifies on the portal; the duplicate guard counts it)
//   interrupted           — a 'running' row whose runner process is gone
// ---------------------------------------------------------------------------------------------
export type StageRunStatus =
  | "running" | "awaiting_human_submit" | "paused_for_human" | "submitted" | "submitted_unconfirmed" | "failed" | "interrupted";

/** A step message that can only exist after the final-submit click happened. "Final submit needs
 *  a human … stopped without clicking" is deliberately NOT here: that one did not click. */
const FINAL_SUBMIT_CLICKED_MESSAGE =
  /final submit clicked|after the submit click|approved final-submit click did not complete|final submit triggered a challenge after the click|the submit raised a payment dialog/i;

/**
 * THE ONE ANSWER TO "HOW DID THIS STAGE RUN END?" — the only source of a stage run's final
 * portal_runs.status and of its submissions row status.
 *
 * It reads what the adapter REPORTS HAPPENED, not what the run was permitted to do: a click the
 * gate should have refused is still a click, and recording it as 'failed' is how a second filing
 * got past the duplicate guard. Evidence of a click, any one of: the result's
 * finalSubmitClicked / finalSubmitClickedByAutomation, any step's data.finalSubmitClicked, or a
 * step message that only exists after the click (production runs ff90c10a/cb9a5f88/6aff4df6 said
 * "After the submit click the page neither confirmed nor rejected" with finalSubmitClicked=false).
 * A click is 'submitted' only on an explicit 'accepted' verdict; anything else is
 * 'submitted_unconfirmed' — an unknown never reads as reassurance.
 */
/** WHAT A PAUSED RUN TELLS THE OPERATOR. Only an MFA/CAPTCHA pause staged nothing; every other
 *  pause (the kVA tier, a signer, a stop before the review page) left a draft on the portal and
 *  names why in its own step message — which this repeats, instead of calling it a "challenge". */
export function pausedRunSentence(pauseReason: string, result: Record<string, unknown>): string {
  if (pauseReason === "mfa_captcha") return "a verification challenge (MFA/CAPTCHA) — nothing was staged. Complete it in the open browser, then re-stage.";
  const steps = Array.isArray(result.steps) ? (result.steps as Array<{ pauseReason?: unknown; message?: unknown }>) : [];
  const own = steps.find((st) => st?.pauseReason === pauseReason)?.message;
  const said = String(typeof own === "string" ? own : "").split("\n")[0].trim().slice(0, 600);
  return `${pauseReason.replace(/_/g, " ")} — ${said || "see the run log on the project"}`;
}

export function derivePortalRunOutcome(result: Record<string, unknown>): {
  status: Exclude<StageRunStatus, "running" | "interrupted">;
  submissionStatus: "submitted" | "submitted_unconfirmed" | "paused_for_human" | "failed" | "awaiting_human_submit";
  finalSubmitClicked: boolean;
  submissionVerdict: "accepted" | "rejected" | "unknown" | null;
  pauseReason: string | null;
  harnessAbort: boolean;
} {
  const steps = Array.isArray(result.steps) ? (result.steps as Array<{ ok?: unknown; message?: unknown; data?: Record<string, unknown> }>) : [];
  const clicked = result.finalSubmitClicked === true
    || result.finalSubmitClickedByAutomation === true
    || steps.some((st) => st?.data?.finalSubmitClicked === true)
    || steps.some((st) => typeof st?.message === "string" && FINAL_SUBMIT_CLICKED_MESSAGE.test(st.message));
  const verdictOf = (v: unknown): "accepted" | "rejected" | "unknown" | null => {
    const s = String((v as { verdict?: unknown } | null | undefined)?.verdict ?? "");
    return s === "accepted" || s === "rejected" || s === "unknown" ? s : null;
  };
  const verdict = verdictOf(result.finalSubmitOutcome) ?? verdictOf(result.submissionOutcome)
    ?? steps.map((st) => verdictOf(st?.data?.finalSubmitOutcome)).find((v) => v !== null) ?? null;
  const pauseReason = typeof result.pauseReason === "string" && result.pauseReason ? result.pauseReason : null;
  if (clicked) {
    const status = verdict === "accepted" ? "submitted" : "submitted_unconfirmed";
    return { status, submissionStatus: status, finalSubmitClicked: true, submissionVerdict: verdict ?? "unknown", pauseReason, harnessAbort: false };
  }
  if (pauseReason) return { status: "paused_for_human", submissionStatus: "paused_for_human", finalSubmitClicked: false, submissionVerdict: null, pauseReason, harnessAbort: false };
  if (result.ok === true) return { status: "awaiting_human_submit", submissionStatus: "awaiting_human_submit", finalSubmitClicked: false, submissionVerdict: null, pauseReason: null, harnessAbort: false };
  // A failure that was OUR browser/process going away is kept distinct in the record (never scored,
  // never a verdict about the portal) — but the status stays 'failed': autopilot's Segment A reads
  // any other status as "complete", and an 'aborted' run is not a staged one.
  return {
    status: "failed", submissionStatus: "failed", finalSubmitClicked: false, submissionVerdict: null, pauseReason: null,
    harnessAbort: isHarnessAbort(extractStageFailureMessage(result)),
  };
}

// ---------------------------------------------------------------------------------------------
// FINAL SUBMIT: A NAMED PERSON'S APPROVAL OF ONE RUN (A2; operator ruling 2026-09-24).
//
// Automation may click a portal's final submit ONLY right after a named person approved THAT
// run (the Approve & Submit action), with PORTAL_ALLOW_FINAL_SUBMIT=1 on the process at decision
// time, a recipe that is 'complete', and a recipe shape with exactly one isFinalSubmit click, last,
// right after the stopForReview marker. There is NO standing per-recipe arm:
// portal_recipes.auto_submit_enabled is never read here, and every recipe writer clears it.
// The approval row's id IS the id of the run it approves (prepareSubmission adopts it), and it is
// consumed by that run — it can never cover a second one. portal-bot re-checks the same
// conditions at the click (shared/src/portalSafety.mayClickFinalSubmit).
// ---------------------------------------------------------------------------------------------

/** How long an approval waits for its run. Approve & Submit enqueues the run immediately; an
 *  approval nobody's run picked up within this window is stale and is never honoured. */
const RUN_APPROVAL_TTL_MS = 30 * 60_000;

/** Record a named person's approval of the NEXT staging run of (project, track). The only writer
 *  is the Approve & Submit route. Refuses a blank approver: "dashboard" is not a person. */
export function createRunApproval(
  db: AppDb,
  input: { projectId: string; track: string; approver: string; approverUserId?: string | null },
): { id: string; approver: string; expiresAt: string } {
  const approver = String(input.approver ?? "").trim();
  if (!approver) throw new HttpError(400, "A final submit needs a named approver — sign in, or give your name, before approving.");
  const approvalId = id();
  const now = Date.now();
  const expiresAt = new Date(now + RUN_APPROVAL_TTL_MS).toISOString();
  db.run(
    `INSERT INTO portal_run_approvals (id, project_id, track, approver, approver_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [approvalId, input.projectId, input.track || "permit", approver, input.approverUserId ?? null, new Date(now).toISOString(), expiresAt],
  );
  addAuditLog(db, input.projectId, "human", approver, "portal.final_submit_approved", {
    approvalId, track: input.track || "permit", expiresAt,
  });
  return { id: approvalId, approver, expiresAt };
}

/**
 * Take (and consume, atomically) ONE NAMED approval — the one the request that started this run
 * minted — for (project, track). Single use.
 *
 * BY ID, NEVER "THE NEWEST LIVE ONE". The old claim took the newest unconsumed approval for the
 * (project, track), so an approval whose own run was refused at a staging gate BEFORE the claim
 * stayed live for thirty minutes and was handed to the next request that asked for a final
 * submit — including one that named nobody (trust skeptic M1). Now the approval id travels with
 * the request (the route puts it in the job payload; direct callers pass it), the claim happens
 * before the first gate (a refused run burns it), and a run with no id in hand claims nothing.
 * The id alone is not the check: the row must still be this project's, this track's, unconsumed
 * and unexpired.
 */
function claimRunApproval(db: AppDb, projectId: string, track: string, approvalId: string | null | undefined): { id: string; approver: string } | null {
  const wanted = String(approvalId ?? "").trim();
  if (!wanted) return null;
  const row = db.get<Row>(
    `SELECT id, approver FROM portal_run_approvals
      WHERE id = ? AND project_id = ? AND track = ? AND consumed_at IS NULL AND expires_at > ?`,
    [wanted, projectId, track || "permit", nowIso()],
  );
  if (!row) return null;
  db.run("UPDATE portal_run_approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL", [nowIso(), text(row.id)]);
  if (Number(db.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0) === 0) return null; // another run took it
  return { id: text(row.id), approver: text(row.approver) };
}

/** The approval id the RUNNING prepare_submission job for this project carries in its payload —
 *  the job the route enqueued for the request that minted the approval. The job queue runs at
 *  most one portal-effect job per project at a time (jobQueue PROJECT_BUSY_SQL), so the running
 *  row IS this request's job. Null when no job is running or it names no approval. */
function runningJobApprovalId(db: AppDb, projectId: string): string | null {
  const row = db.get<Row>(
    `SELECT payload FROM job_queue WHERE project_id = ? AND job_type = 'prepare_submission' AND status = 'running'
      ORDER BY started_at DESC LIMIT 1`,
    [projectId],
  );
  if (!row) return null;
  const payload = parseJson<Record<string, unknown>>(text(row.payload) || "{}", {});
  const approvalId = typeof payload.approvalId === "string" ? payload.approvalId.trim() : "";
  return approvalId || null;
}

/**
 * WHAT THE PREPARE-SUBMISSION ROUTE ENQUEUES for a final-submit request. autoSubmit /
 * allowFinalSubmit reach the job as true ONLY when THIS request minted an approval (a named
 * person approved this exact run); the approval's id rides along so the run claims that one and
 * no other. A request that named nobody is enqueued as an ordinary run that stops at review — it
 * never carries the flag on the strength of an approval somebody else minted earlier.
 */
export function finalSubmitJobPayload(input: {
  track?: string | null; autoSubmit: boolean; allowFinalSubmit: boolean; approval: { id: string } | null;
}): { track?: string; autoSubmit: boolean; allowFinalSubmit: boolean; approvalId: string | null } {
  const minted = Boolean(input.approval && String(input.approval.id || "").trim());
  return {
    track: input.track || undefined,
    autoSubmit: minted && input.autoSubmit === true,
    allowFinalSubmit: minted && input.allowFinalSubmit === true,
    approvalId: minted ? String(input.approval!.id).trim() : null,
  };
}

/**
 * EVERY REASON automation may NOT click the final submit in this run. Empty only when all hold.
 * Reads the recipe FROM THE DATABASE (status and steps as they are now, not as the caller last
 * saw them) and the environment switch at call time. Never reads auto_submit_enabled.
 */
export function automaticSubmitRefusals(
  db: AppDb,
  input: {
    recipeId: string | null; runApproval: { approver: string; runId: string } | null; runId: string; env?: Record<string, string | undefined>;
    /** Set when the recipe was learned for ANOTHER entity (shared-portal reuse): such a run always stops at review. */
    borrowedFrom?: string | null;
  },
): string[] {
  const out: string[] = [];
  if (!finalSubmitEnvAllows(input.env ?? process.env)) out.push("PORTAL_ALLOW_FINAL_SUBMIT is not 1 on this process");
  if (input.borrowedFrom) out.push(`the recipe was learned for ${input.borrowedFrom}, not this jurisdiction — a borrowed recipe always stops at review`);
  const a = input.runApproval;
  const approver = a && typeof a.approver === "string" ? a.approver.trim() : "";
  const runId = String(input.runId ?? "").trim();
  if (!a) out.push("no named person approved this run");
  else {
    if (!approver) out.push("the approval names no approver");
    if (!runId || String(a.runId ?? "").trim() !== runId) out.push("the approval is for a different run");
  }
  const row = input.recipeId ? db.get<Row>("SELECT status, steps_json FROM portal_recipes WHERE id = ?", [input.recipeId]) : null;
  if (!row) {
    out.push("no recorded recipe drives this run (a final submit needs a recipe with a flagged, terminal submit step)");
  } else {
    if (text(row.status) !== "complete") out.push(`the recipe is ${text(row.status) || "unknown"}, not complete`);
    const steps = parseJson<Array<{ action: string; isFinalSubmit?: boolean }>>(text(row.steps_json) || "[]", []);
    const flagged = steps.filter((st) => st && st.isFinalSubmit === true).length;
    if (flagged === 0) out.push("the recipe has no flagged final-submit step");
    out.push(...recipeShapeProblems(steps).map((p) => `recipe shape: ${p}`));
  }
  return out;
}

/** THE decision: may automation click the final submit in this run? A plain boolean; the reasons
 *  come from automaticSubmitRefusals. */
export function maySubmitAutomatically(
  db: AppDb,
  input: { recipeId: string | null; runApproval: { approver: string; runId: string } | null; runId: string; env?: Record<string, string | undefined> },
): boolean {
  return automaticSubmitRefusals(db, input).length === 0;
}

/** Who is driving a run: this host, this process, this boot. */
const PORTAL_RUNNER_ID = `${os.hostname()}|${process.pid}|${id().slice(0, 8)}`;

/** Is the process that wrote this runner id still alive? Same boot → yes. Same host → ask the OS
 *  for the pid. Another host → unknowable, so only its age can retire it. */
function portalRunnerAlive(runner: string, startedAt: string): boolean {
  if (!runner) return false; // a row from before runners were recorded
  // NO RUN IS 'running' FOR SIX HOURS. Checked first and for every runner: a dead runner's pid
  // reused by an unrelated process would otherwise answer "alive" forever, and the track would be
  // refused as "still running" until someone edited the database.
  const age = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(age) || age >= 6 * 3600_000) return false;
  if (runner === PORTAL_RUNNER_ID) return true;
  const [host, pidText] = runner.split("|");
  if (host === os.hostname()) {
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false; // our pid, another boot: reused
    try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException)?.code === "EPERM"; }
  }
  return true; // another host, younger than the cap: cannot tell, so it holds the track
}

function insertRunningPortalRun(db: AppDb, input: {
  runId: string; projectId: string; portalProfileId: string | null; startedAt: string; permitType: string;
  actor: string; recipeId: string | null; recipeVersion: number | null;
}): void {
  db.run(
    `INSERT INTO portal_runs
      (id, project_id, portal_profile_id, run_type, status, started_at, finished_at, error_message,
       human_action_required, screenshots_path, logs_path, result_json, pause_reason, permit_type,
       recipe_id, recipe_version, runner)
     VALUES (?, ?, ?, 'prepare_submit', 'running', ?, NULL, '', 0, '', '', ?, NULL, ?, ?, ?, ?)`,
    [input.runId, input.projectId, input.portalProfileId, input.startedAt, asJson({ actor: input.actor }),
      input.permitType, input.recipeId, input.recipeVersion, PORTAL_RUNNER_ID],
  );
}

/**
 * RETIRE 'running' ROWS WHOSE RUNNER IS GONE. A run that was 'running' when its process died may
 * have created an application on the portal; it becomes 'interrupted' with its URL kept and an
 * audit row, so the operator is pointed at the portal instead of the row claiming a live run
 * forever (or, worse, a re-stage opening a second draft beside it unnoticed).
 * Called by prepareSubmission for the project it is about to stage; exported for startup
 * recovery. `isAlive` is injectable for tests.
 */
export function recoverInterruptedPortalRuns(
  db: AppDb,
  opts: { projectId?: string; isAlive?: (runner: string, startedAt: string) => boolean } = {},
): Array<{ runId: string; projectId: string; permitType: string; trackingUrl: string }> {
  const alive = opts.isAlive ?? portalRunnerAlive;
  const rows = db.query<Row>(
    `SELECT id, project_id, permit_type, started_at, runner, tracking_url FROM portal_runs
      WHERE status = 'running'${opts.projectId ? " AND project_id = ?" : ""}`,
    opts.projectId ? [opts.projectId] : [],
  );
  const recovered: Array<{ runId: string; projectId: string; permitType: string; trackingUrl: string }> = [];
  for (const r of rows) {
    if (alive(text(r.runner), text(r.started_at))) continue;
    const url = text(r.tracking_url);
    db.run(
      `UPDATE portal_runs SET status = 'interrupted', finished_at = ?, human_action_required = 1,
         error_message = ? WHERE id = ? AND status = 'running'`,
      [nowIso(),
        `The run was interrupted (its process went away) — the portal may already hold a draft or a filing${url ? ` at ${url}` : ""}. Check the portal before staging this track again.`,
        text(r.id)],
    );
    addAuditLog(db, text(r.project_id), "system", "portal run recovery", "portal.run_interrupted", {
      runId: text(r.id), track: text(r.permit_type), trackingUrl: url || null, runner: text(r.runner),
    });
    recovered.push({ runId: text(r.id), projectId: text(r.project_id), permitType: text(r.permit_type), trackingUrl: url });
  }
  return recovered;
}

/** A live 'running' stage run on any of these permit types (another run holds the track). */
function trackRunInFlight(db: AppDb, projectId: string, permitTypes: string[], exceptRunId?: string): Row | null {
  if (!permitTypes.length) return null;
  return db.get<Row>(
    `SELECT id, started_at, permit_type FROM portal_runs
      WHERE project_id = ? AND status = 'running' AND permit_type IN (${permitTypes.map(() => "?").join(", ")})
        ${exceptRunId ? "AND id != ?" : ""}
      ORDER BY started_at DESC LIMIT 1`,
    [projectId, ...permitTypes, ...(exceptRunId ? [exceptRunId] : [])],
  );
}

// Check that a project record has the portal-specific fields required to run the adapter.
// Returns a list of human-readable missing field labels (empty = all good).
// This runs BEFORE any Playwright browser opens so failures surface cheaply.
// Adapter-selection precedence — single source of truth shared by the actor-name label and the
// staging dispatch. UNIVERSAL recipe-replay is FIRST-LINE: when a trusted recorded recipe exists
// it wins for EVERY portal; the hand-coded platform adapters (Accela/PowerClerk) are the FALLBACK
// "in case there is a need"; mock is the last resort. The returned name maps 1:1 to the dispatched
// stage function: RecipeAdapter→stageWithRecipe, OregonEPermittingAdapter→stageWithAccela,
// PowerClerkAdapter→stageWithPowerClerk, MockPortalAdapter→stageWithMockPortal. Pure + exported so
// the precedence is unit-tested without standing up a browser/DB.
// Portal channel resolution + the pure precedence helpers now live in ./portalChannel
// (the capability registry). Re-exported here so existing import sites — including
// backend/test/adapterPrecedence.test.ts which imports from "../src/repository" — keep
// working unchanged.
export { selectAdapterActor, selectStagingActor, seedOutcomeToStageResult, resolvePortalChannel };

/**
 * The words of the portal-field refusal. The account / meter numbers come off the customer's bill:
 * with no bill on file and nothing else missing, the NEM application is WAITING on it (qc.ts
 * WAITING_ON_BILL_ISSUE_TYPE) — said as the wait, not as a record someone forgot to complete.
 */
export function portalFieldRefusal(missing: string[], billOnFile: boolean): { message: string; waitingOnBill: boolean } {
  const billFields = missing.filter((f) => /account number|meter number/i.test(f));
  const waitingOnBill = billFields.length > 0 && billFields.length === missing.length && !billOnFile;
  return {
    waitingOnBill,
    message: waitingOnBill
      ? `Interconnection (NEM) staging is waiting on the customer's utility bill — the ${billFields.map((f) => f.toLowerCase()).join(" and ")} are read from it. Upload the bill or send an intake request; the permit side is not held by this.`
      : `Submission staging blocked: required portal field(s) missing — ${missing.join("; ")}. Complete the project record before staging.`,
  };
}

function validatePortalFields(
  project: ProjectRecord,
  track: SubmittalTrackType | undefined,
  adapterActorName: string,
): string[] {
  const missing: string[] = [];
  const req = (label: string, value: unknown) => {
    if (!hasValue(value)) missing.push(label);
  };

  // Fields every portal needs regardless of platform.
  req("Homeowner name", project.homeownerName);
  req("Project address", project.projectAddress);

  // NEM / utility portal (PowerClerk).
  const isNem = track === "nem" || adapterActorName === "PowerClerkAdapter";
  if (isNem) {
    req("Utility account number", project.accountNumber);
    req("Meter number", project.meterNumber);
    req("DC system size (kW)", project.systemSizeDcKw);
    req("AC system size (kW)", project.systemSizeAcKw);
    req("Utility", project.utility);
  }

  // AHJ permit portal (Accela / Recipe).
  const isPermit = !isNem && adapterActorName !== "MockPortalAdapter";
  if (isPermit) {
    req("DC system size (kW)", project.systemSizeDcKw);
    req("AHJ", project.ahj);
    // permitType drives Accela's residential-electrical vs. residential-structural path.
    if (adapterActorName === "OregonEPermittingAdapter") {
      req("Permit type (structural or electrical)", project.permitType);
    }
  }

  return missing;
}

/**
 * THE FILES THIS SUBMITTAL PACKAGES — what the portal upload sweep is handed.
 *
 * Exported for the same reason as the gate filter below: it was an inline expression,
 * so nothing could assert on what actually goes up without rebuilding the expression.
 *
 * Uploaded documents win on a key collision — an operator who uploaded their own
 * version meant to use it. The filled AHJ application counts as one of the documents:
 * it is written to backend/data/filled/<projectId>/ rather than the document store, so
 * it has no project_documents row and projectDocsByType cannot see it. Without the
 * merge the filled form attaches on the LEARN run and silently stops attaching on every
 * replay afterwards — the worst shape of regression, appearing only once a portal has
 * been learned, which is exactly when the operator stops watching.
 *
 * AND IT IS PATH-SCOPED. filledFormsByDocType drops a filled application that
 * contradicts the project's resolved permit path, because "skip the other application"
 * never deleted the previous path's PDF. A project filled on the engineered path and
 * then flipped to prescriptive still had a STRUCTURAL application sitting on disk —
 * and this is the line that would have uploaded it, against Coos Bay's own printed
 * instruction: "Prescriptive path — upload ONLY the prescriptive application. Do NOT
 * also upload the structural application."
 *
 * AND IT IS TRACK-SCOPED (docs-audit PLAN D3): the gate below was track-scoped while these
 * files were not, so Michael's electrical run carried the building checklist, the utility bill
 * and the meter photo. The run is handed its own track's documents plus the shared plan-set
 * family — docDiscipline.ts, the table stagingMissingDocuments reads too. `null` = a legacy
 * trackless stage (every track), said explicitly.
 */
export function packagedDocumentsByType(db: AppDb, project: ProjectRecord, track: SubmittalTrackType | null): Record<string, string> {
  return submissionDocumentsByType(db, project, track);
}

/** THE DOCUMENTS THIS FILING OWES THE PORTAL beyond the plan set (docs plan D7). The AHJ's required
 *  list (requiredListCheck: the per-job lookup's issuing-agency forms, the state checklist, the KB's
 *  lines) — each item ON FILE in THIS track's payload (docsByType is already track-scoped, so the
 *  building B-01S never rides the electrical permit, and a utility bill never rides a permit). One
 *  entry per document; the plan set (the recording uploads it) and generated worksheets excluded. */
export function owedAttachmentsFor(db: AppDb, project: ProjectRecord, docsByType: Record<string, string>): Array<{ docType: string; label: string }> {
  const out: Array<{ docType: string; label: string }> = [];
  let items: Array<{ text: string; docTypes: string[]; present: boolean }> = [];
  // An unreadable list never reads as "nothing owed" (skeptic eb36a8f MF2): a sentinel the approved
  // final submit refuses on (recipeAdapter.finalSubmitRefusalsNow).
  try { items = requiredListCheck(db, project, documentInventory(db, project)).items as typeof items; } catch { return [{ docType: "__unreadable__", label: "the required-document list could not be read" }]; }
  for (const it of items) {
    if (!it?.present || !Array.isArray(it.docTypes)) continue;
    const docType = it.docTypes.find((t) => docsByType[t] && t !== "plan_set" && !/^generated_/.test(t));
    if (!docType || out.some((o) => o.docType === docType)) continue;
    const label = String(it.text || docType).split(" — ")[0].replace(/^[^:]{0,100}\(issues the [^:]*?\):\s*/i, "").trim() || docType;
    out.push({ docType, label });
  }
  return out;
}

/**
 * THE DOCUMENT GATE'S FILTER — the one prepareSubmission turns into its 409.
 *
 * Exported because it was previously an inline expression, and the only way to test
 * "the gate refuses this" was to restate the filter in the test. A copy of a filter
 * cannot notice the original drifting; this is the original.
 *
 * TWO dimensions, and they are not the same dimension:
 *
 *  - LANE (permit vs nem) scopes out the OTHER utility/AHJ side, so staging one lane
 *    isn't blocked by the other's document. inverter_spec is dual-purpose and always
 *    counts.
 *  - DISCIPLINE scopes the permit APPLICATIONS to the track being filed. A separate-
 *    permit AHJ owes a building-side application AND an electrical one, both lane
 *    'permit' and both blocking — so with lane alone, staging the BUILDING track
 *    would 409 over the ELECTRICAL application, a document that belongs to a filing
 *    this run is not making. item.discipline speaks the same vocabulary
 *    recipeDisciplineForTrack does (`building` → `structural`), on purpose, so the
 *    two sides cannot disagree.
 *
 * A row's discipline is its own when it carries one (the application rows, which know which
 * permit owes them), else the docDiscipline.ts table's — the ONE docType → discipline answer
 * the payload (packagedDocumentsByType) reads too (docs-audit PLAN D3). The PE-letter row
 * (`structural_letter`) carries none, so it blocked the ELECTRICAL track of an engineered job
 * (b0ab5169, ec5c36d3) over a document only the building permit files (V9); the table files it
 * under structural. The universal plan-set family has no discipline and keeps the lane-only
 * filter — every discipline needs the plan set.
 */
export function stagingMissingDocuments(inventory: DocumentInventory, track?: SubmittalTrackType): DocPresence[] {
  const lane = track === "nem" ? "nem" : track ? "permit" : null;
  const discipline = track ? recipeDisciplineForTrack(track) : "";
  return inventory.missingBlocking.filter((d) => {
    if (!(lane == null || d.lane === lane || d.docType === "inverter_spec")) return false;
    const rowDiscipline = d.discipline || disciplineFor(d.docType);
    // No discipline on the row (plan-set family), no track, or a track whose
    // discipline we cannot name ('permit'): lane is the whole filter.
    if (!rowDiscipline || !discipline) return true;
    // A COMBINATION permit is one filing covering both trades — it owes everything.
    if (discipline === "combo" || rowDiscipline === "combo") return true;
    return rowDiscipline === discipline;
  });
}

/**
 * THE REQUIRED DOCUMENTS A STAGED DRAFT DID NOT CARRY — how Approve judges a draft that already exists
 * (gates-proper C1). Never the pre-Stage look-ahead: a draft is judged by what went up with it, not by
 * what Stage would acquire now, and not by what is on disk now. Jules Testperson's electrical draft
 * (191e45c8) was staged at 18:47Z, before the Marion E-01 existed; once the E-01 was fetched and filled
 * (02:19Z) the disk said "present", and Approve would have read the draft as complete.
 *
 * The track's required blocking rows (stagingMissingDocuments' own lane / discipline filter) are
 * checked against the run's recorded payload (`packagedDocTypes`, written at staging). A run staged
 * before that record existed is judged by POSITIVE proof only: a row on file now whose every upload /
 * stored template arrived AFTER the draft was staged was not in it; a row with no such proof is taken
 * as carried (no false stop on a legacy draft). A row not on file now was not carried either.
 * `onFileNow` says which fix applies: re-stage (it is on file now), or get it on file first.
 */
export function draftDocumentGaps(
  db: AppDb,
  project: ProjectRecord,
  run: { started_at?: unknown; result_json?: unknown },
  track: SubmittalTrackType | null,
): Array<{ label: string; onFileNow: boolean }> {
  const inv = documentInventory(db, project);
  const trackRows = stagingMissingDocuments({ ...inv, missingBlocking: inv.presence.filter((p) => p.blocking) }, track ?? undefined);
  const result = parseJson<Record<string, unknown>>(text(run.result_json) || "{}", {});
  const carried = Array.isArray(result.packagedDocTypes) ? (result.packagedDocTypes as unknown[]).map(String) : null;
  const startedMs = Date.parse(text(run.started_at));
  // A row not on disk that the staging-time fill produces from a stored template: the draft's own
  // staging ran that fill, so it carried the form if the template was on file then (its age decides,
  // below). Anything else not on disk was not in the draft.
  const produced = missingFilledAtStaging(db, project, trackRows.filter((d) => !d.present));
  // THE SAME PACKAGING ON BOTH SIDES: the recorded list is Object.keys(packagedDocumentsByType) at
  // staging, so a row is judged only under a key that packaging gives it NOW — a document the
  // payload keys another way (an alias, a family key), or would not carry on this track anyway, is
  // no proof of anything, and never a reason to refuse a fresh draft.
  const nowPackaged = carried ? new Set(Object.keys(packagedDocumentsByType(db, project, track))) : null;
  const templateIds = carried ? [] : loadStoredTemplates(db, project.ahj, project.state).map((t) => t.templateId);
  const out: Array<{ label: string; onFileNow: boolean }> = [];
  for (const d of trackRows) {
    const keys = [d.docType, ...(d.altDocTypes || [])];
    if (!d.present && !produced.has(d)) { out.push({ label: d.label, onFileNow: false }); continue; }
    if (d.via === "in plan set") continue; // the plan set carries it
    if (carried && nowPackaged) {
      // A FORM THE STAGING FILL MAKES FROM A STORED TEMPLATE, not filled here yet, is judged against
      // the RECORD alone (skeptic gates-proper MF2): nothing on disk can speak for it, and a template
      // stored after the draft (by another job — templates are shared) must not read as "carried".
      if (!d.present && produced.has(d)) {
        if (!keys.some((k) => carried.includes(k))) out.push({ label: d.label, onFileNow: true });
        continue;
      }
      const packagedKeys = keys.filter((k) => nowPackaged.has(k));
      if (packagedKeys.length && !packagedKeys.some((k) => carried.includes(k))) out.push({ label: d.label, onFileNow: true });
      continue;
    }
    if (Number.isFinite(startedMs) && documentArrivedAfter(db, project, keys, startedMs, templateIds)) out.push({ label: d.label, onFileNow: true });
  }
  return out;
}

/** Did every copy of these document types (uploads, and the stored templates a filled form comes
 *  from) arrive after `sinceMs`? false when nothing dated is found — no proof, no claim. */
function documentArrivedAfter(db: AppDb, project: ProjectRecord, keys: string[], sinceMs: number, templateIds: string[]): boolean {
  const ph = keys.map(() => "?").join(", ");
  const times: number[] = db.query<Row>(`SELECT uploaded_at FROM project_documents WHERE project_id = ? AND doc_type IN (${ph})`, [project.id, ...keys])
    .map((r) => Date.parse(text(r.uploaded_at)));
  if (templateIds.length) {
    const rows = db.query<Row>(`SELECT created_at FROM ahj_form_templates WHERE id IN (${templateIds.map(() => "?").join(", ")}) AND form_type IN (${ph})`, [...templateIds, ...keys]);
    times.push(...rows.map((r) => Date.parse(text(r.created_at))));
  }
  const dated = times.filter(Number.isFinite);
  return dated.length > 0 && dated.every((t) => t > sinceMs);
}

/**
 * THE OPERATOR'S HOLD, as the reason a person gave for it — or null when the project is not held.
 *
 * `blocked` is the one status no automation writes (setProjectStatusByOperator is its only
 * writer and the only way out), and it means a human decided this job must not move: a contract
 * dispute, a cancelled homeowner. Everything that opens a portal must honour it, and the two
 * staging entry points with no project-status gate — prepareSubmission and Segment A — ask here.
 * It is REFUSAL-ONLY: it can stop staging and never admits it, so it is not the lifecycle
 * status gate prepareSubmission deliberately does not have (correctionRestageGate section 3).
 * The reason comes off the newest audit row that moved the project INTO `blocked`.
 */
export function operatorHoldReason(db: AppDb, projectId: string): string | null {
  const status = text(db.get<Row>("SELECT status FROM projects WHERE id = ?", [projectId])?.status);
  if (status !== "blocked") return null;
  const rows = db.query<Row>(
    `SELECT details FROM audit_logs WHERE project_id = ? AND action = 'project.status_overridden'
      ORDER BY created_at DESC LIMIT 20`,
    [projectId],
  );
  for (const r of rows) {
    const d = parseJson<Record<string, unknown>>(text(r.details), {});
    if (d.to === "blocked") return text(d.reason) || "(no reason recorded)";
  }
  return "(no reason recorded)";
}

/**
 * WHERE A COLD-START PORTAL URL CAME FROM, for its `portal.url_researched` audit row. The row used
 * to say "researched" whether a web search found the URL or the model recalled it; a URL from
 * model memory is a guess at a live government login page. Three answers, and an unknown is
 * never worded as the reassuring one (the research result's webGrounded is optional — results
 * built by hand do not carry it).
 */
export function researchedUrlProvenance(webGrounded: boolean | undefined): { provenance: "web_grounded" | "model_memory" | "unknown"; note: string } {
  if (webGrounded === true) {
    return { provenance: "web_grounded", note: "Cold-start: portal URL found by a WEB-GROUNDED search and saved as a seeded KB profile — verify on first use." };
  }
  if (webGrounded === false) {
    return { provenance: "model_memory", note: "Cold-start: portal URL from MODEL MEMORY ONLY (web search did not run) and saved as a seeded KB profile — confirm it is the official portal before trusting it." };
  }
  return { provenance: "unknown", note: "Cold-start: portal URL researched, provenance UNKNOWN (not recorded as web-grounded) — saved as a seeded KB profile; confirm it is the official portal before trusting it." };
}

/** Order KB rows for a portal-URL lookup, best first: (utility lookups) the utility-keyed row
 *  with no AHJ, then a row pinned to the project's state, then a human-verified row. */
function kbRowRank(row: { state?: string; ahj?: string; verified_at?: string | null }, projectState: string, utilityLookup: boolean): number {
  let rank = 0;
  if (utilityLookup && String(row.ahj ?? "").trim()) rank += 4;
  if (!projectState || String(row.state ?? "").trim().toLowerCase() !== projectState) rank += 2;
  if (!isVerifiedKnowledge(row)) rank += 1;
  return rank;
}

/**
 * WHICH PORTAL, WHICH RECIPE, FOR THIS STAGE — the resolution prepareSubmission runs after its gates:
 * the learned profile and platform, the own recipe (discipline-checked), the entity evidence and the
 * one host predicate (hostFitsTrackAndEntity) every candidate URL is judged by, the KB / fuzzy /
 * per-job-lookup / draft / statewide candidates, the entity's OWN portal, and the shared-portal
 * borrow. Moved out of prepareSubmission unchanged (split-issuer, 2026-09-28) so it can be asked
 * without a browser and without the staging gates — the tests and the base-parity replay call it.
 * Portal truth (merged 2026-09-28) lives here too, for the track's VIEW (`project` is what
 * projectForTrack gave — the issuing agency when another agency issues this permit): the statewide
 * portal only on evidence (D1, statewideEvidence.statewideDecisionFor — read ONCE per stage), a
 * statewide URL from any store refused when that evidence says the AHJ files elsewhere
 * (statewideUrlRefusal, inside fitUrl so the returned permitSafeUrl holds it at the researched-URL
 * door too), and a recipe its portal refused ("not served here", D5) never replayed nor lending its URL.
 * Writes only the audit rows it always wrote (a legacy recipe skipped, a borrow refused / taken,
 * the statewide portal taken / withheld / a statewide URL refused, a not-served recipe skipped).
 */
export function resolveStagePortal(db: AppDb, input: {
  projectId: string;
  project: ProjectRecord;
  track: SubmittalTrackType | undefined;
  /** The portal_profiles row's type ("mock" when none). */
  portalType: string;
  isRealPortal: boolean;
}) {
  const { projectId, project, track, portalType, isRealPortal } = input;
  // Platform-driven adapter reuse: a new AHJ on a KNOWN platform (e.g. City of Lafayette
  // on Accela/Oregon ePermitting) reuses that platform's hand-coded adapter even if its
  // portal_type isn't the canonical one — only the entry URL + login differ. The platform
  // comes from the learned KB profile. Gated on a real portal profile so mock/dev is
  // unaffected.
  const learnedProfile = isRealPortal
    ? findLearnedProfileForProject(db, { state: project.state, ahj: project.ahj, utility: project.utility })
    : null;
  const platform = String(learnedProfile?.portalPlatform ?? "").toLowerCase();
  // PLATFORM FALLBACK FROM URL: portal_platform is empty on many learned/seeded KB rows
  // (nothing backfills it), and an empty platform used to dead-end dispatch as NoAdapter
  // even when the row's portal_url plainly identifies the platform (live: City of Salem
  // carried the aca-oregon.accela.com URL with a blank platform). Sniff the URL only when
  // the platform column is empty — an explicit value always wins.
  const platformUrlHint = String((learnedProfile as { portalUrl?: string } | null)?.portalUrl ?? "").toLowerCase();
  const isAccela = portalType === "accela_oregon"
    || (isRealPortal && (platform.includes("accela") || (!platform && /accela\.com|citizenaccess/.test(platformUrlHint))));
  const isPowerClerk = portalType === "powerclerk_pge"
    || (isRealPortal && (platform.includes("powerclerk") || (!platform && /powerclerk\.com/.test(platformUrlHint))));
  // Recipe replay is the FIRST-LINE (universal) path: if an admin has recorded a complete recipe
  // for this AHJ (or its utility), replay it — even on a known platform (PowerClerk/Accela). The
  // hand-coded platform adapters are the FALLBACK when no recipe exists. The lookup is track-
  // scoped so a NEM stage never picks up an AHJ permit recipe (and vice-versa).
  // Which permit discipline this track files under - the recipe key's second dimension.
  const trackDiscipline = recipeDisciplineForTrack(track);
  let recipe = track === "nem"
    // NEM stages against the utility's recorded recipe.
    ? findCompleteRecipeForProject(db, { scopeType: "utility", state: project.state, utility: project.utility })
    // Permit tracks replay ONLY an AHJ-scoped recipe — never a utility (NEM) recipe, which is a
    // different portal and form. No AHJ recipe → self-seed / hand-coded fallback, not a wrong-track replay.
    : findCompleteRecipeForProject(db, { scopeType: "ahj", state: project.state, ahj: project.ahj, utility: project.utility, discipline: trackDiscipline });
  // A RECIPE ITS PORTAL REFUSED ("not served here", portal-truth D5) never replays — even one a
  // person re-promoted without clearing the flag. The flag names the portal's words.
  if (recipe && isNotServedRecipe(recipe)) {
    addAuditLog(db, projectId, "system", "submit gate", "portal.not_served_recipe_skipped", { track: track ?? "permit", recipeId: recipe.id, reason: recipe.flagReason.slice(0, 300) });
    recipe = null;
  }
  // LEGACY-ROW DISCIPLINE CHECK. Recipes are keyed per AHJ per discipline, but rows
  // recorded before that dimension existed carry discipline '' and are accepted as a
  // fallback. If such a row was actually learned for the OTHER discipline, its steps pick
  // the wrong jurisdiction row and record type — so drop it here rather than replaying it.
  // Dropping (instead of refusing the stage) is the unlock: with no recipe in hand the
  // dispatch falls through to the universal learner, which now seeds THIS discipline's own
  // recipe. Refusing left the second discipline able to neither replay nor self-seed.
  let droppedLegacyRecipeDiscipline: "electrical" | "structural" | null = null;
  if (recipe && trackDiscipline && !recipe.discipline) {
    try {
      const learnedFor = recipeDisciplineFromSteps(getPortalRecipe(db, recipe.id).steps);
      if (disciplineConflictsWithTrack(learnedFor, track)) {
        droppedLegacyRecipeDiscipline = learnedFor;
        addAuditLog(db, projectId, "system", "submit gate", "portal.discipline_recipe_skipped", {
          track: track ?? "permit", recipeId: recipe.id, learnedFor,
        });
        recipe = null;
      }
    } catch { /* unreadable steps — leave the recipe in place for the gate below */ }
  }

  // ── WHOSE PORTAL? (rule 5, both ways, and the entity) ────────────────────────────────────
  // Every URL this stage could launch, and the recipe it could replay, is judged by ONE
  // predicate — hostFitsTrackAndEntity — against what the shared tables say about THIS
  // project's own utility (NEM) or AHJ (permit). A permit track never gets a utility portal and
  // a NEM track never gets a permit portal; a URL or recipe for entity X is never used for Y; and
  // where a person verified the entity's portal, nothing stored or researched that disagrees is
  // launched. Evidence: a ComEd project staged with the PGE recipe (fe12ed81); Tigard researched
  // to Accela against its verified EnerGov row; a Tigard KB row carrying PGE's PowerClerk.
  const hostEntityInput = {
    scope: scopeForTrack(track),
    state: project.state,
    name: track === "nem" ? project.utility : project.ahj,
  };
  const hostEntity = portalEntityEvidence(db, hostEntityInput);
  // A recipe is judged on the OTHER evidence — never on its own row, or a mis-keyed recipe would
  // vouch for its own wrong host.
  const judgeRecipe = (r: { id: string; portalUrl?: string; steps?: import("../../shared/src/types").RecipeStep[] }) =>
    recipeHostFit(track, portalEntityEvidence(db, { ...hostEntityInput, excludeRecipeIds: [r.id] }), r);
  /** Why candidate URLs were refused on this stage — the operator reads these if nothing fits. */
  const refusedUrls: Array<{ url: string; source: string; code: string; reason: string }> = [];
  // PORTAL-TRUTH D1 AT EVERY READ (statewideEvidence.statewideUrlRefusal — the predicate the research
  // write doors ask too): a stored / learned / researched URL on the STATEWIDE host is not served
  // when this AHJ's own evidence says it files elsewhere. The statewide fallback below is D1's own
  // answer, and an operator's URL is judged at its route. The decision is read ONCE per stage, for
  // this track's view (`project`: the issuing agency when another agency issues this permit), and
  // permitSafeUrl — returned to prepareSubmission for the researched URL — closes over the same
  // memo, so every door on this stage reads the one decision.
  let statewideDecisionMemo: ReturnType<typeof statewideDecisionFor> | undefined;
  const statewideDecision = () => (statewideDecisionMemo === undefined ? (statewideDecisionMemo = statewideDecisionFor(db, project, track)) : statewideDecisionMemo);
  const fitUrl = (url: string | null | undefined, source: PortalUrlSource, namedPlatform: string[] = []): string => {
    const value = String(url ?? "").trim();
    if (!value) return "";
    const fit = hostFitsTrackAndEntity(track, hostEntity, value, source, { namedPlatform });
    if (fit.fits) {
      const refusal = scopeForTrack(track) === "ahj" && source !== "statewide" && source !== "operator" && isStatewidePortalUrl(project.state, value)
        ? statewideUrlRefusal(db, project, track, value, statewideDecision())
        : "";
      if (!refusal) return value;
      if (!refusedUrls.some((r) => r.url === value)) {
        refusedUrls.push({ url: value, source, code: "statewide_elsewhere", reason: refusal });
        addAuditLog(db, projectId, "system", "submit gate", "portal.statewide_url_refused", { track: track ?? "permit", url: value, source, reason: refusal.slice(0, 600) });
      }
      return "";
    }
    if (!refusedUrls.some((r) => r.url === value)) refusedUrls.push({ url: value, source, code: fit.code, reason: fit.reason });
    return "";
  };
  // The own recipe: its entry URL and every portal it navigates to. A TRACK conflict keeps the
  // existing gate below (flag for re-record, stop); an entity/platform misfit stops the run
  // without touching the recipe — it is valid for whichever entity it was learned on.
  let recipeTrackConflict: (HostFit & { url: string }) | null = null;
  let recipeEntityMisfit: (HostFit & { url: string }) | null = null;
  if (recipe) {
    const fit = judgeRecipe(recipe);
    if (!fit.fits) {
      if (fit.code === "track_conflict") recipeTrackConflict = fit;
      else recipeEntityMisfit = fit;
    }
  }

  // Resolve stored credentials for session-expired auto-login. Passed
  // in-memory to the adapter; never logged. Falls back gracefully when
  // no credential has been stored for this client+portal combination.
  //
  // Lookup chain (the operator may store a credential keyed by any of these):
  //   1. exact portal_type (the canonical "accela_oregon"/"powerclerk_pge")
  //   2. portal URL hostname — covers credentials saved via the per-project
  //      "Manage logins" panel, whose portal_type is a channel-derived slug
  //      (e.g. "oregon_epermitting_accela") that won't equal the canonical type.
  //   3. the client's single credential when unambiguous.
  // Resolve the portal's login URL for the hostname match: learned KB profile,
  // recorded recipe, else the built-in applicationDocs sourceUrl.
  //
  // RESOLVED HERE, BEFORE THE FIELD GATE (pure DB reads — no browser, no research): the
  // shared-portal reuse below needs the AHJ's OWN portal to match a recipe to, and the field
  // gate needs to know whether a recipe will drive the run.
  // The fallback URL MUST be scoped to the track so a NEM stage never matches the AHJ
  // permit credential (and vice-versa). learnedProfile/recipe are already track-scoped
  // above; the applicationDocs sourceUrl is AHJ-scoped, so only use it for permit tracks.
  // For the NEM track, the fallback URL is the UTILITY's portal URL from the KB
  // (e.g. Pacific Power → pacificpower.net), never the AHJ permit portal.
  let utilityPortalUrl = "";
  let ahjPortalUrl = "";
  const projectState = (project.state || "").trim().toLowerCase();
  if (track === "nem" && project.utility) {
    // "OR the name IS a url": reference imports have twice filed the portal link in
    // portal_name with portal_url empty (Tigard, Douglas County) — same fallback as the
    // knowledgeBase mapper, kept in SQL because this exact-key read bypasses the mapper.
    // EVERY row for the utility, best first — the utility-keyed row (no AHJ), this state, a
    // verified row — and the first candidate that FITS wins. LIMIT 1 used to take whichever row
    // SQLite returned first, which could be an AHJ row carrying that AHJ's permit portal.
    // The row's own platform words judge its URL (issue #31): a row that says PowerClerk but points
    // at the utility's program page (PNM's researched row) is not launched; the next row may fit.
    const utilRows = db.query<{ portal_url?: string; portal_name?: string; portal_platform?: string; state?: string; ahj?: string; verified_at?: string | null }>(
      `SELECT portal_url, portal_name, portal_platform, state, ahj, verified_at FROM permit_utility_knowledge
        WHERE utility = ? AND ((portal_url IS NOT NULL AND portal_url != '') OR portal_name LIKE 'http%')`,
      [project.utility],
    ).sort((a, b) => kbRowRank(a, projectState, true) - kbRowRank(b, projectState, true));
    for (const row of utilRows) {
      utilityPortalUrl = [String(row.portal_url ?? ""), String(row.portal_name ?? "")]
        .map((u) => fitUrl(/^https?:\/\/\S+$/i.test(u.trim()) ? u.trim() : "", "kb", [String(row.portal_name ?? ""), String(row.portal_platform ?? "")])).find(Boolean) ?? "";
      if (utilityPortalUrl) break;
    }
  } else if (track !== "nem" && project.ahj) {
    // A human-verified AHJ in the KB may carry a portal URL even without a required-documents list,
    // so a permit self-seed can launch from it (mirrors the NEM utility-URL lookup). This is a real
    // portal ENTRY, unlike the applicationDocs sourceUrl (an AHJ info page), so it gates the gate.
    // BOTH columns, chosen in JS — because the KB sweep (2026-09-21) found every shape at once:
    // the reference import files the AHJ link in portal_NAME (71 rows), the learn path parks the
    // UTILITY's PowerClerk on AHJ-side rows (23 rows), and Happy Valley had both inverted in one
    // row (EnerGov in name, PowerClerk in url). The rule: for a PERMIT lookup, take the first
    // candidate that is an http URL and FITS the track and this AHJ — url column first, then name.
    // Every row for the AHJ name, best first (this state, verified): the same name in another
    // state is another city (the KB has "City of Tigard" in OR, AL, AR and WA).
    const ahjRows = db.query<{ portal_url?: string; portal_name?: string; state?: string; ahj?: string; verified_at?: string | null }>(
      `SELECT portal_url, portal_name, state, ahj, verified_at FROM permit_utility_knowledge
        WHERE ahj = ? AND ((portal_url IS NOT NULL AND portal_url != '') OR portal_name LIKE 'http%')`,
      [project.ahj],
    ).filter((r) => !projectState || !String(r.state ?? "").trim() || String(r.state).trim().toLowerCase() === projectState)
      .sort((a, b) => kbRowRank(a, projectState, false) - kbRowRank(b, projectState, false));
    for (const row of ahjRows) {
      ahjPortalUrl = [String(row.portal_url ?? ""), String(row.portal_name ?? "")]
        .map((u) => fitUrl(/^https?:\/\/\S+$/i.test(u.trim()) ? u.trim() : "", "kb")).find(Boolean) ?? "";
      if (ahjPortalUrl) break;
    }
  }
  // Fuzzy fallback: the exact-name lookups above miss imported KB rows keyed by
  // legal names ("Portland General Electric") when the project says "PGE". Same
  // resolver the auto-learn planner uses — state-filtered token/acronym matching.
  if (track === "nem" ? !utilityPortalUrl : !ahjPortalUrl) {
    const fuzzy = findKnowledgeForLearn(db, {
      state: project.state,
      ahj: track !== "nem" ? project.ahj : undefined,
      utility: track === "nem" ? project.utility : undefined,
    });
    if (track === "nem") utilityPortalUrl = fitUrl(fuzzy.utility?.portalUrl, "kb");
    else ahjPortalUrl = fitUrl(fuzzy.ahj?.portalUrl, "kb");
  }
  // THE PER-JOB LOOKUP'S PORTAL for this track's permit (cited, seeded) — judged like research
  // (a verified portal for the AHJ outranks it; an information page never fits). The statewide
  // portal is not taken here: that answer is the statewide fallback below, labelled as such.
  if (track !== "nem" && !ahjPortalUrl) {
    const looked = permitAnswerForTrack(project, track)?.portalUrl.value ?? "";
    if (looked && !isStatewidePortalUrl(project.state, looked)) ahjPortalUrl = fitUrl(looked, "research");
  }
  // A draft/recording recipe (not yet promoted to "complete") still carries the entry URL the
  // operator — or a prior auto-learn pass — pointed the recorder at. Recover it so the universal
  // self-seed can launch the right portal even before any recipe is verified. Track-scoped exactly
  // like the complete-recipe lookup above (NEM → utility key; permit → AHJ only, never utility).
  const draftRecipeRaw = track === "nem"
    ? findAnyRecipeForProject(db, { scopeType: "utility", state: project.state, utility: project.utility })
    : findAnyRecipeForProject(db, { scopeType: "ahj", state: project.state, ahj: project.ahj, utility: project.utility, discipline: trackDiscipline });
  // A draft whose portals do not fit (a Tigard draft that navigates to Accela) lends no URL.
  const draftFit = draftRecipeRaw ? judgeRecipe(draftRecipeRaw) : null;
  // …nor one its portal REFUSED ("not served here", portal-truth D5): the next stage must not reuse
  // the host that told this AHJ it does not serve the address.
  const draftNotServed = Boolean(draftRecipeRaw && isNotServedRecipe(draftRecipeRaw));
  const draftRecipe = draftRecipeRaw && draftFit?.fits && !draftNotServed ? draftRecipeRaw : null;
  if (draftRecipeRaw && draftFit && !draftFit.fits) {
    refusedUrls.push({ url: draftFit.url || String(draftRecipeRaw.portalUrl ?? ""), source: "recipe", code: draftFit.code, reason: draftFit.reason });
  } else if (draftRecipeRaw && draftNotServed) {
    refusedUrls.push({ url: String(draftRecipeRaw.portalUrl ?? ""), source: "recipe", code: "not_served", reason: draftRecipeRaw.flagReason });
  }
  // A PERMIT track must never launch a utility platform (PowerClerk etc.), a NEM track never a
  // permit portal, and neither a portal that belongs to another entity. A learned profile /
  // recipe / KB row matched via the project's UTILITY (or AHJ) can carry the other track's URL —
  // every candidate goes through fitUrl so resolution falls through to a real source instead of
  // stopping at the track/host-conflict guard below.
  const permitSafeUrl = (url: string | null | undefined, source: PortalUrlSource = "kb", namedPlatform: string[] = []): string => fitUrl(url, source, namedPlatform);
  // Statewide-portal fallback: an Oregon AHJ with no portal URL of its own whose process
  // profile files through e-permitting/Accela uses the shared Oregon ePermitting portal
  // (one Accela instance for all subscribed jurisdictions — only the jurisdiction field
  // differs), instead of failing with "no portal URL known".
  //
  // B2 (2026-09-25): the fallback no longer needs a seeded process profile that says
  // "e-permitting". City of Jefferson had none, so its permit tracks resolved no portal of their
  // own, never borrowed, and launched BCD's help page instead. permitProcess.statewidePortalFor
  // answers from the per-job lookup first (this AHJ files on the statewide portal / on a
  // DIFFERENT portal → no fallback), then from the cited state rule when nothing says otherwise.
  // A person's verified portal for the AHJ still outranks it (fitUrl → hostFitsTrackAndEntity).
  // PORTAL-TRUTH D1 (Corvallis, 2026-09-28): the fallback is taken ONLY on evidence that this AHJ
  // (or the agency issuing this permit) files on the statewide portal; anything saying it files
  // elsewhere — the lookup NAMING its own portal, kept or not — or nothing at all is "unknown, a
  // person confirms", named in the run's message and audited, never the statewide portal. The
  // decision is the one statewideDecision() above read for this track's view.
  let statewidePortalUrl = "";
  let statewideBasis = "";
  if (track !== "nem" && !ahjPortalUrl && !draftRecipe) {
    const statewide = statewideDecision();
    if (statewide && statewide.url !== null) {
      statewidePortalUrl = permitSafeUrl(statewide.url, "statewide");
      statewideBasis = describeCited("Statewide portal", statewide.basis);
      addAuditLog(db, projectId, "system", "submit gate", "portal.statewide_taken", { track: track ?? "permit", url: statewide.url, basis: statewideBasis.slice(0, 400) });
    } else if (statewide) {
      const ruleUrl = String(stateRulesFor(project.state).statewidePortal?.value ?? "");
      refusedUrls.push({ url: ruleUrl, source: "statewide", code: "withheld", reason: statewide.withheld });
      addAuditLog(db, projectId, "system", "submit gate", "portal.statewide_withheld", {
        track: track ?? "permit", url: ruleUrl, reason: statewide.withheld.slice(0, 600),
        evidence: statewide.evidence.slice(0, 6).map((e) => ({ kind: e.kind, source: e.source, url: e.url ?? null })),
      });
    }
  }
  // The AHJ's / utility's OWN portal, from its own evidence only — never from a borrowed recipe.
  const ownPortalUrl =
    permitSafeUrl(learnedProfile && (learnedProfile as { portalUrl?: string }).portalUrl) ||
    (recipe && !recipeTrackConflict && !recipeEntityMisfit ? String(recipe.portalUrl ?? "") : "") ||
    (draftRecipe ? String(draftRecipe.portalUrl ?? "") : "") ||
    (track === "nem" ? utilityPortalUrl : (ahjPortalUrl || statewidePortalUrl)) ||
    "";

  // ── SHARED-PORTAL REUSE (portalRecipes.findBorrowableRecipe; operator ruling 2026-09-24) ──
  // No complete recipe of its own → a complete recipe learned for ANOTHER entity on the SAME
  // portal, SAME record type and discipline may replay here. Recorded on the run, shown to the
  // operator, never demoted or healed by this project's run, and the run stops at review.
  let borrowed: BorrowedRecipeChoice | null = null;
  let borrowDecisionReason = "";
  if (!recipe && !recipeEntityMisfit && !recipeTrackConflict && track) {
    try {
      const decision = findBorrowableRecipe(db, {
        track, state: project.state, ahj: project.ahj, utility: project.utility,
        targetPortalUrl: ownPortalUrl, targetSource: ownPortalUrl && ownPortalUrl === statewidePortalUrl ? "statewide" : "kb", entity: hostEntity,
        targetRecordType: lookedUpRecordType(project, track)?.value ?? "",
      });
      borrowDecisionReason = decision.reason;
      // B4: A BORROWED RECIPE MUST BIND TO THIS PROJECT, or it is not borrowed. Every agency /
      // jurisdiction selection binds from the target's per-job answer (never the donor's literal);
      // a selection that cannot be bound refuses the borrow with the named reason.
      if (decision.choice) {
        const probe = bindRecipeForReplay({
          steps: decision.choice.recipe.steps ?? [], portalUrl: decision.choice.recipe.portalUrl,
          project: project, fieldValues: {}, track,
          borrowed: { learnedFor: decision.choice.learnedFor, discipline: decision.choice.discipline },
          agency: issuingAgencyFor(project, track),
        });
        if (probe.refusal) {
          addAuditLog(db, projectId, "system", "submit gate", "portal.recipe_borrow_refused", {
            track, recipeId: decision.choice.recipe.id, learnedFor: decision.choice.learnedFor, reason: probe.refusal,
          });
          borrowDecisionReason = `borrow refused: ${probe.refusal}`;
          decision.choice = null;
        }
      }
      if (decision.choice) {
        borrowed = decision.choice;
        recipe = decision.choice.recipe;
        addAuditLog(db, projectId, "system", "submit gate", "portal.recipe_borrowed", {
          track, recipeId: borrowed.recipe.id, recipeVersion: borrowed.recipe.version,
          learnedFor: borrowed.learnedFor, learnedForState: borrowed.learnedForState,
          portalHost: borrowed.portalHost, recordType: borrowed.recordType, discipline: borrowed.discipline,
        });
      }
    } catch (err) {
      logger.warn("prepare-submission", `shared-portal recipe lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    learnedProfile, platform, isAccela, isPowerClerk, trackDiscipline, recipe, droppedLegacyRecipeDiscipline,
    hostEntity, recipeTrackConflict, recipeEntityMisfit, refusedUrls, permitSafeUrl,
    utilityPortalUrl, ahjPortalUrl, draftRecipe, statewidePortalUrl, statewideBasis, ownPortalUrl,
    borrowed, borrowDecisionReason,
  };
}

export async function prepareSubmission(
  db: AppDb, projectId: string, track?: SubmittalTrackType, autoSubmit?: boolean, allowFinalSubmit?: boolean,
  /** The approval THIS request minted (Approve & Submit). Omitted by the job handler: the running
   *  job's payload carries it. With neither, the run claims nothing and stops at review. */
  approvalId?: string | null,
): Promise<ProjectDetail> {
  const detail = getProjectDetail(db, projectId);
  // A FINAL SUBMIT WAS ASKED FOR: take the named approval the Approve & Submit action recorded for
  // THIS request — by id (the route put it in the job payload; a direct caller passes it) — BEFORE
  // the first staging gate. Consumed here, single use: a run refused at any gate below has still
  // used its approval up, so it can never be picked up by a later request (trust skeptic M1). Its
  // id becomes THIS run's id, so the approval names this run and no other. No approval → an
  // ordinary run that stops at review.
  const wantsFinalSubmit = autoSubmit === true || allowFinalSubmit === true;
  const claimedApproval = wantsFinalSubmit
    ? claimRunApproval(db, projectId, track ?? "permit", approvalId ?? runningJobApprovalId(db, projectId))
    : null;
  if (claimedApproval) {
    // Audited at the claim: a run the gates refuse below leaves no run row, and the operator
    // must still be able to see why Approve & Submit did not end in a click.
    addAuditLog(db, projectId, "system", "submit gate", "portal.run_approval_claimed", {
      approvalId: claimedApproval.id, approvedBy: claimedApproval.approver, track: track ?? "permit",
    });
  } else if (wantsFinalSubmit) {
    addAuditLog(db, projectId, "system", "submit gate", "portal.run_approval_missing", {
      track: track ?? "permit", approvalId: approvalId ?? null,
      reason: "no live approval by that id for this project and track — the run stops at review",
    });
  }
  const runId = claimedApproval?.id ?? id();
  // AN OPERATOR'S HOLD STOPS STAGING — first, before anything is billed, built or opened.
  const hold = operatorHoldReason(db, projectId);
  if (hold !== null) {
    throw new HttpError(409,
      `This project is blocked by an operator: ${hold}. Nothing is staged while it is blocked — `
      + "lift the block (set the project's status) once the reason no longer applies.",
      { operatorBlocked: true, reason: hold });
  }
  // PAYMENT GATE (first — the payment screen sits at the beginning of the flow):
  // a per-submission client must have this track's quote (real permit fees + the
  // operator's service fee) paid or waived before anything is staged. This bills
  // the CLIENT; the portal's own fee checkout stays human-only regardless.
  assertSubmissionPaid(db, detail.project, track);

  // A TRACK THAT IS ALREADY FILED MUST NOT BE FILED AGAIN.
  //
  // Nothing stopped re-staging a submitted track. Re-running the structural track minutes
  // after 187-26-000305-STR was accepted would have opened a second application against the
  // same parcel — a duplicate record, a duplicate fee, and a jurisdiction ringing the customer
  // to ask which one is real. Staging is otherwise safe to retry, which is exactly why this is
  // easy to do by accident: the same command that recovers a failed run repeats a good one.
  //
  // Keyed on a SUBMITTED submission for this track, so retrying a failed or staged run is
  // untouched. Withdrawing the filing (or clearing its submission row) is the deliberate act
  // that re-opens the track.
  //
  // ONE PREDICATE FOR BOTH SHAPES OF CALL. A trackless call (the dashboard's "Prepare
  // Submittal" posts {}) is the legacy combined stage — it covers EVERY required track and
  // records its run as permit_type 'permit'. It used to skip this guard entirely, so on a filed
  // or closed project it restaged (handoff_ready -> awaiting_human_submit) and opened a new
  // portal draft: the duplicate application this guard exists to stop, through the one door
  // nobody thought of as "a track". It now resolves the tracks it would stage and refuses if
  // any is already filed — or already STAGED, since its single untracked run cannot pick one
  // track and would open a second draft beside the staged one. The per-track call keeps its
  // behaviour (a staged track may be re-staged explicitly; only a filed one refuses).
  //
  // combo / permit are one track, and building / structural one trade — the SAME fold the
  // tracks panel and the handoff read (submittalTracks.trackPermitTypes): the legacy trackless
  // run is recorded as 'permit', and the panel shows it as the combo filing.
  const trackFamily = (t: string): string[] => trackPermitTypes(t as SubmittalTrackType);
  // THE DUPLICATE GUARD COUNTS AUTOMATION'S CLICKS (A3). A filing is on the portal when a human
  // captured it (submissions 'submitted'), OR automation clicked the final submit — whatever the
  // run row ended up saying: a submissions row 'submitted_unconfirmed', a run whose result reports
  // the click (08909df6 / 5864e8ef clicked and were recorded 'failed', and the second filing went
  // through), or a portal.auto_submitted audit row for the track.
  const filedOn = (t: string): Row | null => {
    const family = trackFamily(t);
    const ph = family.map(() => "?").join(", ");
    return db.get<Row>(
      `SELECT permit_number, application_number, submitted_at, status AS via FROM submissions
        WHERE project_id = ? AND permit_type IN (${ph}) AND status IN ('submitted', 'submitted_unconfirmed')
        ORDER BY submitted_at DESC LIMIT 1`,
      [projectId, ...family],
    ) ?? db.get<Row>(
      `SELECT '' AS permit_number, '' AS application_number, started_at AS submitted_at, 'automation_click' AS via FROM portal_runs
        WHERE project_id = ? AND permit_type IN (${ph})
          AND (status IN ('submitted', 'submitted_unconfirmed')
            OR json_extract(result_json, '$.finalSubmitClicked') = 1
            OR json_extract(result_json, '$.finalSubmitClickedByAutomation') = 1)
        ORDER BY started_at DESC LIMIT 1`,
      [projectId, ...family],
    ) ?? db.get<Row>(
      `SELECT '' AS permit_number, '' AS application_number, created_at AS submitted_at, 'automation_click' AS via FROM audit_logs
        WHERE project_id = ? AND action = 'portal.auto_submitted'
          AND COALESCE(json_extract(details, '$.track'), 'permit') IN (${ph})
        ORDER BY created_at DESC LIMIT 1`,
      [projectId, ...family],
    );
  };
  // A STAGED DRAFT THAT A CORRECTION CAME AFTER IS SUPERSEDED, NOT A CONFLICT. A project staged
  // (never filed) and then corrected — a reviewer or designer caught something before the human
  // submit — resolves to ready_to_resubmit, "ready to re-stage", and re-staging is the whole
  // point of that status. Refusing it as "already staged" stranded the corrected project behind
  // the very draft the correction invalidated. Evidence, not status: only a staged row created
  // AFTER the project's newest correction still blocks a trackless run. Every stage inserts a
  // fresh submissions row, so the re-stage itself is again protected against a second click.
  const stagedOn = (t: string): Row | null => {
    const family = trackFamily(t);
    return db.get<Row>(
      `SELECT id FROM submissions
        WHERE project_id = ? AND permit_type IN (${family.map(() => "?").join(", ")}) AND status = 'awaiting_human_submit'
          AND created_at >= COALESCE((SELECT MAX(created_at) FROM corrections WHERE project_id = ?), '')
        LIMIT 1`,
      [projectId, ...family, projectId],
    );
  };
  const filedNumber = (row: Row): string => text(row.permit_number) || text(row.application_number)
    || (text(row.via) && text(row.via) !== "submitted"
      ? "(no number captured — automation clicked the final submit and the portal did not confirm it; verify on the portal)"
      : "(no number captured)");
  const filedWhen = (row: Row): string => (row.submitted_at ? ` on ${String(row.submitted_at).slice(0, 10)}` : "");
  // What a trackless call covers: every required track, plus its own 'permit' tag when no
  // required track already folds it in (a separate building/electrical AHJ) — otherwise a
  // second trackless stage would not see the first one.
  const required: string[] = requiredTracks(detail.project);
  const footprint = required.some((t) => trackFamily(t).includes("permit")) ? required : [...required, "permit"];
  // THE TRACKS ALREADY ON THE PORTAL WHEN THIS CALL BEGAN — read once, here, so the re-check just
  // before dispatch (below) can tell "a person re-staging a staged track on purpose" (allowed, as
  // it always was) from "another run staged it while this one was waiting" (refused). Dynamic
  // import: autopilot statically imports this module.
  const { trackAlreadyStaged } = await import("./autopilot");
  const stageCovers = (track ? [track] : footprint) as SubmittalTrackType[];
  const stagedAtEntry = new Set(stageCovers.filter((t) => trackAlreadyStaged(db, projectId, t)));
  // A RUN ALREADY ON THIS TRACK. A 'running' row whose process is gone is an interrupted run
  // (recovered here, audited, its URL kept); one whose process is alive holds the track, and a
  // second run beside it would open a second draft on the portal.
  recoverInterruptedPortalRuns(db, { projectId });
  const inFlightAtEntry = trackRunInFlight(db, projectId, [...new Set(stageCovers.flatMap((t) => trackFamily(t)))]);
  if (inFlightAtEntry) {
    throw new HttpError(409,
      `A portal run for the ${text(inFlightAtEntry.permit_type)} track started at ${text(inFlightAtEntry.started_at)} and is still running. `
      + "Staging again beside it would open a duplicate application on the portal — wait for it to finish.",
      { track: track ?? "permit", runInFlight: text(inFlightAtEntry.id) });
  }
  if (track) {
    const filed = filedOn(track);
    if (filed) {
      const num = filedNumber(filed);
      throw new HttpError(409,
        `The ${track} track is already filed as ${num}${filedWhen(filed)}. `
        + "Staging it again would open a duplicate application with the jurisdiction. "
        + "Withdraw the existing filing first if it needs to be replaced.",
        { track, permitNumber: num, submittedAt: filed.submitted_at ?? null });
    }
  } else {
    const found = footprint.map((t) => {
      const filed = filedOn(t);
      const staged = filed ? null : stagedOn(t);
      return { track: t, filed, staged };
    });
    const conflicts = found.filter((f) => f.filed || f.staged);
    if (conflicts.length) {
      const describe = (f: typeof found[number]): string => (f.filed
        ? `the ${f.track} track is already filed as ${filedNumber(f.filed)}${filedWhen(f.filed)}`
        : `the ${f.track} track is already staged and awaiting a human submit`);
      const remaining = found.filter((f) => required.includes(f.track) && !f.filed && !f.staged).map((f) => f.track);
      const allFiled = found.filter((f) => required.includes(f.track)).every((f) => f.filed);
      const first = conflicts[0];
      const said = conflicts.map(describe).join("; ");
      throw new HttpError(409,
        allFiled
          ? `Every required track is already filed: ${said}. `
            + "Staging again would open a duplicate application with the jurisdiction. "
            + "Withdraw the existing filing first if it needs to be replaced."
          : `${said.charAt(0).toUpperCase()}${said.slice(1)}. `
            + "Staging again would open a duplicate application with the jurisdiction. "
            + (remaining.length
              ? `Stage the remaining track(s) individually from the submittal-tracks panel: ${remaining.join(", ")}.`
              : "Withdraw the existing filing first if it needs to be replaced."),
        {
          track: first.track,
          permitNumber: first.filed ? filedNumber(first.filed) : null,
          submittedAt: first.filed ? (first.filed.submitted_at ?? null) : null,
          tracks: conflicts.map((f) => ({
            track: f.track,
            state: f.filed ? "filed" : "staged",
            permitNumber: f.filed ? filedNumber(f.filed) : null,
            submittedAt: f.filed ? (f.filed.submitted_at ?? null) : null,
          })),
          remaining,
        });
    }
  }

  // A TRACKLESS STAGE CANNOT FILE A SPLIT-ISSUER PROJECT (round-1 skeptic, 2026-09-28). The legacy
  // combined stage (the dashboard's "Prepare Submittal" posts {}) resolves ONE portal — the project
  // AHJ's (projectForTrack(project, undefined) is the project) — and files every required permit
  // there. When any required permit track is issued by another agency (the operator's per-track
  // issuer, or the per-job lookup's cited one — permitProcess.trackIssuer), that is the other agency's
  // permit on the wrong portal. Refused before anything is built, opened or recorded; each permit
  // stages from its own track card, where its issuer's portal resolves. A project with no split
  // (every required track's view is the project itself — the SAME object) is untouched.
  if (!track) {
    const splitTracks = required.filter((t) => t !== "nem" && projectForTrack(detail.project, t) !== detail.project);
    if (splitTracks.length) {
      const permitTracks = required.filter((t) => t !== "nem");
      const label = (t: string): string => (t === "combo" || t === "permit" ? "combination" : t === "mpu" ? "service-upgrade (MPU)" : t);
      const issuers = permitTracks.map((t) => ({ track: t, issuer: trackIssuer(detail.project, t).name }));
      // One clause per issuing agency: "the building permit is issued by City of Newberg, the
      // electrical by Yamhill County"; "the building and electrical permits are issued by Marion County".
      const byIssuer = new Map<string, string[]>();
      for (const x of issuers) byIssuer.set(x.issuer, [...(byIssuer.get(x.issuer) ?? []), label(x.track)]);
      const said = [...byIssuer.entries()].map(([issuer, labels], i) => {
        const names = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : labels[0];
        return i === 0 ? `the ${names} permit${labels.length > 1 ? "s are" : " is"} issued by ${issuer}` : `the ${names} by ${issuer}`;
      }).join(", ");
      addAuditLog(db, projectId, "system", "submit gate", "portal.trackless_split_refused", {
        tracks: issuers, split: splitTracks,
      });
      throw new HttpError(409,
        `Stage each permit from its track card — ${said}. `
        + "A combined stage opens one portal (the project AHJ's), so it would file another agency's permit there. Nothing was opened.",
        { tracklessSplitIssuer: true, tracks: issuers, split: splitTracks });
    }
  }

  const failCount = detail.qcResults.filter((result) => result.qcStatus === "fail").length;
  // 'Background job failed' items are OPERATOR NOTIFICATIONS (escalated by the
  // job worker), not data-quality gates — counting them would let e.g. a failed
  // advisory job hard-block staging of an otherwise-clean project.
  //
  // 'Run triage' items are in the same family: SUGGESTIONS from the automated triage of a
  // failed run, unreviewed by any human. Counting them builds a feedback loop that live-
  // locked a project twice in one afternoon: run fails → triage files a suggestion →
  // the pending suggestion gates the RETRY the triage was supposed to help → the retry's
  // failure files another. Both times the "missing" data (customer + installer emails) was
  // already on the record. Agent proposals advise; they do not gate — a human's own pending
  // items still do.
  // The SAME predicate the submit gate reads (isCriticalReviewItem) — two answers to "does this
  // pending item hold staging?" let the gate go green while this 409 still refused.
  const pendingCount = detail.humanReviewItems.filter(isCriticalReviewItem).length;
  // The same severities the gate shows (reviewerGateReportFor, #214): a finding a cached vision verdict
  // relaxed no longer refuses staging while the gate reads it green.
  const reviewerReport = reviewerGateReportFor(db, detail.project);
  // ONLY THE FINDINGS THAT HOLD THIS FILING (gateScope — the answer the gate, Stage and Approve
  // read): a structural conflict does not refuse the utility's application or the separate
  // electrical permit. A trackless stage (null) is held by every finding.
  const reviewerBlockers = reviewerReport.findings.filter((finding) => finding.severity === "blocker"
    && scopeHoldsTrack(findingHoldScope(finding), track ?? null));
  const historicalReport = buildHistoricalFailureReport(db, projectId, null);
  const learnedHistoricalMissing = historicalReport.checklist.filter((item) => {
    const cause = historicalReport.topRejectionCauses.find((candidate) => candidate.signature === item.sourceCauseSignature);
    return item.status === "missing" && Boolean(cause && cause.count > 0 && cause.severity === "blocker")
      && scopeHoldsTrack(historicalBlockerScope(historicalReport, item), track ?? null);
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

  // DOCUMENT-PRESENCE GATE: never stage a submittal that is missing a required file.
  // This is the guardrail against the "AHJ emailed back: documents still missing"
  // Auto-split the plan set into individual sheet documents if the plan set is uploaded
  // but individual sheet docs (SLD, site plan, etc.) haven't been split yet. This lets
  // the operator upload a single plan-set PDF and stage immediately without a separate
  // manual split step. Failures are non-fatal — if the plan set can't be split the
  // document gate below will still report exactly what's missing.
  // ensurePlanSetSplit withdraws split parts the current classifier disagrees with (#77) and
  // re-splits only when that can add a sheet — not on every pass for a set whose spec pages are
  // title-only cut-sheets that never become a spec part (#75 review).
  try {
    // nem → NEM docs; ANY permit-side track (building/electrical/combo/permit/mpu) → permit
    // docs only; no track (stage everything) → all. Previously only 'building' mapped to
    // 'permit', so electrical/combo/mpu stages did needless NEM-package work.
    const target = track === "nem" ? "nem" : track ? "permit" : "all";
    await ensurePlanSetSplit(db, detail.project.id, target, ["sld", "site_plan", "structural", "module_spec", "inverter_spec"]);
  } catch { /* non-fatal — document gate will surface what's still missing */ }

  // failure — the gate only let scalar fields through before. Scope NEM-only gaps out
  // when staging just the permit track and vice-versa, so a single-track stage isn't
  // blocked by the other lane's document.
  if (track !== "nem") {
    const { prepareOfficialDocuments } = await import("./prepareOfficialDocuments");
    await prepareOfficialDocuments(db, detail.project);
  }
  const inv = documentInventory(db, detail.project);
  const lane = track === "nem" ? "nem" : track ? "permit" : null;
  const missingDocs = stagingMissingDocuments(inv, track);
  if (missingDocs.length > 0) {
    // Each document says its own fix (owedDocumentAction — the gate's words): a form Stage could not
    // acquire is found / uploaded as a blank; a file is attached or split out of the plan set.
    throw new HttpError(409, `Submission staging blocked: required document(s) not attached${track !== "nem" ? " after Stage's own form acquisition and fill" : ""} — ${missingDocs.map((d) => `${d.label} (${owedDocumentAction(d)})`).join("; ")}. The AHJ/utility must receive a complete package.`, {
      missingDocuments: missingDocs.map((d) => ({ docType: d.docType, label: d.label, lane: d.lane })),
    });
  }

  // PERMIT-PATH GATE (AHJ permit lane only): the prescriptive and structural
  // applications are mutually exclusive and the AHJ takes exactly one. If the path
  // isn't confirmed we cannot know which application to file — block staging the permit
  // until the operator sets it (Manual entry → Permit path). NEM staging is unaffected.
  if (lane !== "nem") {
    const path = resolvePermitPathForProject(db, detail.project);
    if (path.path === "unknown") {
      throw new HttpError(409, "Submission staging blocked: confirm the permit path (prescriptive vs engineered) before staging the AHJ permit. The two applications are mutually exclusive — set it on Manual entry → Permit path.", { permitPathUnknown: true });
    }
  }

  // ROCK-SOLID CLIENT GATE: never stage a submittal without an explicitly assigned
  // client whose CCB/license will be on the filing. This is the guardrail against
  // submitting with the wrong (or default/blank) contractor's info.
  if (!detail.project.clientId) {
    throw new HttpError(409, "No submitting client assigned. Assign the client whose CCB/contractor license belongs on this permit before staging — we never submit with default or another client's info.", { needsClient: true });
  }
  const submittingClient = getClient(db, detail.project.clientId);
  // The CCB is Oregon's contractor board: required for an Oregon filing only. Elsewhere the
  // licence a state requires is on its own form, and the gate reports it (never a CCB demand).
  if (["OR", ""].includes(String(detail.project.state || "").trim().toUpperCase()) && !submittingClient.ccbLicenseNumber?.trim()) {
    throw new HttpError(409, `Submitting client "${submittingClient.companyName || submittingClient.legalBusinessName || detail.project.clientId}" has no CCB license number on file. Add it in the Clients tab before staging.`, { needsCcb: true, clientId: detail.project.clientId });
  }

  // (The approval was claimed at the top of this function, before the first gate — see there.)
  const submissionId = id();
  const ts = nowIso();
  // Prefer the backend-split/uploaded document set (the real upload-ready files, named
  // so the adapters classify them by keyword); fall back to snapshot file paths.
  // What goes in that set — the filled-form merge, its precedence, and the permit-path
  // scoping that keeps the OTHER application out — is documented on the function.
  const docsByType = packagedDocumentsByType(db, detail.project, track ?? null);
  const packagedFiles = Object.values(docsByType);
  const files = packagedFiles.length > 0 ? packagedFiles : filesFromProject(detail.project.parserSnapshot);

  // Resolve portal adapter. A project may pin a specific portal_profile_id in
  // its parser snapshot; otherwise fall back to any configured real portal
  // profile (accela_oregon for permits, powerclerk_pge for NEM), else mock.
  const snapshotProfileId = typeof detail.project.parserSnapshot?.["portal_profile_id"] === "string"
    ? detail.project.parserSnapshot["portal_profile_id"]
    : null;
  // Scope the portal to the track being staged: NEM is the utility portal
  // (PowerClerk); building/electrical/combo permits are the AHJ portal (Accela).
  // With no track (legacy combined stage) accept either, newest first.
  const trackPortalTypes = track === "nem"
    ? ["powerclerk_pge"]
    : (track === "building" || track === "electrical" || track === "combo" || track === "permit" || track === "mpu")
      ? ["accela_oregon"]
      : ["accela_oregon", "powerclerk_pge"];
  const trackPortalPlaceholders = trackPortalTypes.map(() => "?").join(", ");
  const portalProfile = snapshotProfileId
    ? (db.get("SELECT * FROM portal_profiles WHERE id = ?", [snapshotProfileId]) as { id?: string; portal_name?: string; portal_type?: string; encrypted_storage_state?: string } | undefined)
    : (db.get(
        `SELECT * FROM portal_profiles WHERE portal_type IN (${trackPortalPlaceholders}) ORDER BY created_at DESC LIMIT 1`,
        trackPortalTypes,
      ) as { id?: string; portal_name?: string; portal_type?: string; encrypted_storage_state?: string } | undefined);
  const portalType = portalProfile?.portal_type ?? "mock";
  const isRealPortal = portalType !== "mock";
  const portalProfileId = portalProfile?.id ?? null;
  // Refined below to the track's portal identity when a real adapter will actually drive a portal
  // that has no portal_profiles row (the common case — nothing populates that table), so status/
  // audit text isn't mislabeled "Mock portal". A genuine mock run keeps the "Mock portal" label.
  let portalLabel = isRealPortal
    ? (portalProfile?.portal_name || portalType)
    : "Mock portal";
  // WHOSE PORTAL THIS TRACK FILES ON (split issuer): the track-scoped view — the project itself (the
  // same object) when this track's issuer is the project AHJ, else the project with the ISSUER as its
  // AHJ (permitProcess.projectForTrack / trackIssuer: the operator's per-track issuer, else the per-job
  // lookup's cited agency for this permit). Every portal door below reads it — the recipe and KB keys,
  // the learned profile, the entity the one host predicate judges, the borrow and its agency binding,
  // cold-start research, the kill-switch, the field values, the learner and the adapters — so a
  // county-AHJ project's building permit stages on the city that issues it, and the city's portal is
  // never refused as a foreign entity for that track (nor accepted for the county's electrical one).
  // NEM and a trackless stage: the project, untouched.
  const portalProject = projectForTrack(detail.project, track);
  const clientId = detail.project.clientId ?? "";
  // WHICH PORTAL, WHICH RECIPE (resolveStagePortal): learned profile -> own recipe -> entity evidence
  // and the one host predicate -> KB / lookup / draft / statewide candidates -> the own portal -> borrow.
  const stagePortal = resolveStagePortal(db, { projectId, project: portalProject, track, portalType, isRealPortal });
  const {
    learnedProfile, platform, isAccela, isPowerClerk, trackDiscipline, recipe, droppedLegacyRecipeDiscipline,
    hostEntity, recipeTrackConflict, recipeEntityMisfit, refusedUrls, permitSafeUrl,
    utilityPortalUrl, ahjPortalUrl, draftRecipe, statewidePortalUrl, ownPortalUrl, borrowed, borrowDecisionReason,
  } = stagePortal;

  // Precedence: recipe (universal, first-line) → hand-coded platform adapter → mock.
  const adapterActorName = selectAdapterActor(Boolean(recipe), isAccela, isPowerClerk);

  // PORTAL FIELD GATE: before opening a browser, verify that the project has the
  // fields each portal requires. This catches "forgot to enter the meter number"
  // before a Playwright session starts, surfacing a clear blocker to the operator.
  const missingPortalFields = validatePortalFields(detail.project, track, adapterActorName);
  if (missingPortalFields.length > 0) {
    const refusal = portalFieldRefusal(missingPortalFields, customerBillOnFile(db, detail.project.id));
    throw new HttpError(409, refusal.message, { missingPortalFields, ...(refusal.waitingOnBill ? { waitingOnBill: true } : {}) });
  }

  // LAST GATE BEFORE ANY BROWSER OR PORTAL-URL RESEARCH. Every gate above has already given
  // its verdict, so an offline install (the demo kit) still shows exactly what staging
  // would have required, and then stops here instead of opening a live portal with no
  // login. openPortal refuses too; this is the readable version of the same refusal.
  if (portalAutomationDisabled()) {
    throw new HttpError(409,
      "Every gate is clear, but portal automation is off on this installation (PORTAL_AUTOMATION=off), so no portal will be opened. On a live install this step stages the application to the portal's review screen for a person to submit.",
      { portalAutomationDisabled: true },
    );
  }

  // The login/launch URL: the entity's own portal first; a borrowed recipe's entry is the same
  // portal by construction; the applicationDocs sourceUrl (an AHJ info page) last, permit only.
  // Every candidate is already through fitUrl — rule 5 both ways, and the entity.
  let credentialUrl =
    ownPortalUrl ||
    (borrowed ? String(borrowed.recipe.portalUrl ?? "") : "") ||
    (track === "nem" ? "" : permitSafeUrl(findApplicationProfile(portalProject).sourceUrl)) ||
    "";

  // LOCK THE PORTAL OUT ONCE IT HAS REFUSED THE LOGIN, BEFORE A BROWSER OPENS.
  //
  // We cannot detect a password change — the first sign is a failed filing. Re-attempting after
  // that is how an account gets locked, and it is the OPERATOR'S OWN account on the line, under
  // their licence. The `stale` flag has been correct for a long time (a later success clears it
  // with nobody editing anything) but was consulted only by the benchmark, so every real stage
  // kept knocking.
  //
  // Safe in the direction that matters: stale is set by recordLoginOutcome, which refuses to mark
  // anything when isHarnessAbort(note) is true — the guard that exists because a dead browser was
  // once recorded as six credential failures and quietly retired seven working platforms. So "our
  // browser died" cannot arrive here as "the password was refused".
  //
  // Refusing at 409 rather than failing the stage mid-run is deliberate: nothing is attempted, no
  // draft is left behind, and the message says the one thing that clears it.
  if (credentialUrl && detail.project.clientId) {
    const lockedOut = lockedOutCredential(db, detail.project.clientId, credentialUrl);
    if (lockedOut && process.env.PORTAL_CREDENTIAL_LOCKOUT !== "0") {
      addAuditLog(db, projectId, "system", "submit gate", "portal.credential_locked_out", {
        track: track ?? "permit", portalUrl: lockedOut.portalUrl, lastLoginNote: lockedOut.lastLoginNote,
      });
      throw new HttpError(409,
        `Staging stopped: ${lockedOut.portalUrl} refused this login the last time we tried, so we are not knocking again — `
        + `repeated attempts are what locks an account. Update the credential (or confirm the existing one still works) `
        + `and the block clears itself on the next successful login. `
        + `${lockedOut.lastLoginNote ? `The portal said: ${lockedOut.lastLoginNote}` : ""}`.trim(),
        {
          credentialLockedOut: true,
          portalUrl: lockedOut.portalUrl,
          clientId: detail.project.clientId,
          // A supervised learn is the other way through: run it headed, watch it, and anything you
          // do on the page is captured as recipe steps (armHumanCaptureOnPage).
          supervisedLearnHint: "npm run learn:supervised -- --project <id> --track <track>",
        });
    }
  }
  // COLD-START RESEARCH: a brand-new AHJ/utility with nothing in the KB, no
  // recipe, and no statewide fallback used to dead-end with "record the portal
  // once". With an API key, research the portal URL instead (web-grounded,
  // KB-hinted), SAVE it as a seeded profile so the next project skips this,
  // and continue the run. Track-scoped: NEM researches the utility, permit
  // researches the AHJ (result still filtered through permitSafeUrl so a
  // utility platform can never leak into a permit track). PORTAL_URL_RESEARCH=off
  // disables; stub LLM (no key) returns nothing and the original guidance stands.
  if (!credentialUrl && process.env.ANTHROPIC_API_KEY && process.env.PORTAL_URL_RESEARCH !== "off") {
    try {
      let webGrounded: boolean | undefined;
      let researched = "";
      let researchNotes = "";
      // What the research says the portal runs on — judged against the URL's host (issue #31).
      let researchPlatform: string[] = [];
      // WHOSE portal was researched: the track's own entity, named as such in the log (issue #8: a
      // NEM result for PNM was logged as "for City of Albuquerque").
      const researchedFor = track === "nem" ? `${detail.project.utility} (utility, NEM track)` : `${portalProject.ahj} (AHJ, ${track ?? "permit"} track)`;
      if (track === "nem" && detail.project.utility) {
        const { research } = await researchAndSaveUtility(db, {
          utility: detail.project.utility, state: detail.project.state || "", ahj: detail.project.ahj,
        });
        researched = String(research.portalUrl || "");
        researchNotes = [research.notes, ...(research.tips ?? [])].filter(Boolean).join(" | ");
        researchPlatform = researchNamedPlatform(research);
        webGrounded = research.webGrounded;
      } else if (track !== "nem" && portalProject.ahj) {
        const { research } = await researchAndSaveAhj(db, {
          ahj: portalProject.ahj, state: portalProject.state || "", utility: portalProject.utility,
        });
        researched = String(research.portalUrl || "");
        researchNotes = [research.notes, ...(research.tips ?? [])].filter(Boolean).join(" | ");
        webGrounded = research.webGrounded;
      }
      // A RESEARCHED URL IS NEVER LAUNCHED UNCONFIRMED WHEN IT DISAGREES with the track, with the
      // portal a person verified for this entity, or belongs to another entity (research resolved
      // Tigard to Accela while Tigard's verified rows say EnerGov) — nor when the research itself
      // says the URL is not the confirmed portal (the same refusal the KB write door makes, so what
      // is not saved is not launched either). The refusal is audited and named in the run's
      // message; a person confirms by saving the portal on the entity's profile.
      const unconfirmed = Boolean(researched) && researchSaysPortalUnconfirmed(researchNotes);
      credentialUrl = unconfirmed ? "" : permitSafeUrl(researched, "research", researchPlatform);
      if (researched && !credentialUrl) {
        const refusal = unconfirmed
          ? { code: "unconfirmed", reason: RESEARCH_UNCONFIRMED_REASON }
          : refusedUrls.find((r) => r.url === researched.trim());
        if (unconfirmed && !refusedUrls.some((r) => r.url === researched.trim())) {
          refusedUrls.push({ url: researched.trim(), source: "research", code: "unconfirmed", reason: RESEARCH_UNCONFIRMED_REASON });
        }
        addAuditLog(db, projectId, "system", "submit gate", "portal.url_research_conflict", {
          track: track ?? "permit", url: researched, code: refusal?.code ?? null, reason: refusal?.reason ?? null,
        });
        logger.info("prepare-submission", `cold-start research for ${researchedFor} returned ${researched}, refused as the portal: ${refusal?.reason ?? "does not fit this track"}`);
      }
      if (credentialUrl) {
        addAuditLog(db, projectId, "system", "submit gate", "portal.url_researched", {
          track: track ?? "permit", url: credentialUrl, ...researchedUrlProvenance(webGrounded),
        });
        logger.info("prepare-submission", `cold-start research resolved a portal URL for ${researchedFor}: ${credentialUrl}`);
      } else if (track === "nem" ? detail.project.utility : portalProject.ahj) {
        // NOTHING CONFIRMABLE: said so, for THIS track's entity — never a portal borrowed from the
        // other track's research (issue #8). The card reads "Unknown — verify" with no link.
        const entity = track === "nem" ? detail.project.utility : portalProject.ahj;
        addAuditLog(db, projectId, "system", "submit gate", "portal.url_unconfirmed", {
          track: track ?? "permit", entity, message: `Portal not confirmed for ${entity}: research found no application portal that fits this track — verify on the ${track === "nem" ? "utility's" : "AHJ's"} site.`,
        });
      }
    } catch (err) {
      logger.warn("prepare-submission", `cold-start portal research failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const credential = clientId
    ? (getDecryptedCredential(db, clientId, portalType)
        ?? (credentialUrl ? getDecryptedCredentialByUrl(db, clientId, credentialUrl) : null)
        ?? getDecryptedCredentialAny(db, clientId, credentialUrl))
      ?? undefined
    : undefined;

  // Per-client browser profile so sessions never bleed across clients.
  const profileBase = process.env.PORTAL_PROFILES_DIR || path.join(process.cwd(), "portal-profiles");
  const userDataDir = clientId
    ? path.join(profileBase, clientId, portalType)
    : path.join(profileBase, portalType);

  // HYBRID AUTO-SUBMIT (opt-in): only honored when the operator approved it AND a
  // recipe-based portal is in use AND that recipe is explicitly trusted
  // (auto_submit_enabled). Hand-coded adapters (Accela/PowerClerk) stay guided-manual.
  // Even then the adapter never clicks a fee-payment control and bails on CAPTCHA/MFA.
  // MAY THIS RUN CLICK THE FINAL SUBMIT? One function answers (automaticSubmitRefusals /
  // maySubmitAutomatically): a named approval of THIS run, PORTAL_ALLOW_FINAL_SUBMIT=1 now, a
  // complete recipe, and the one-terminal-flagged-click-after-stopForReview shape. The recipe's
  // auto_submit_enabled column is NOT consulted — a standing per-recipe arm is never authority.
  // The hand-coded adapters' delegated submit (allowFinalSubmit) answers to the same function, so
  // with no recipe it is refused: the ruling requires a valid recipe shape for any click.
  const runApproval = claimedApproval ? { approver: claimedApproval.approver, runId } : null;
  const submitRefusals = wantsFinalSubmit
    ? automaticSubmitRefusals(db, { recipeId: recipe?.id ?? null, runApproval, runId, borrowedFrom: borrowed?.learnedFor ?? null })
    : [];
  const resolvedAutoSubmit = wantsFinalSubmit && submitRefusals.length === 0;
  if (wantsFinalSubmit && !resolvedAutoSubmit) {
    addAuditLog(db, projectId, "system", "submit gate", "portal.auto_submit_declined", {
      track: track ?? "permit", runId, approvedBy: runApproval?.approver ?? null, reasons: submitRefusals,
    });
  } else if (resolvedAutoSubmit) {
    addAuditLog(db, projectId, "system", "submit gate", "portal.auto_submit_allowed", {
      track: track ?? "permit", runId, approvedBy: runApproval?.approver ?? null, recipeId: recipe?.id ?? null, recipeVersion: recipe?.version ?? null,
    });
  }

  // Overlay the linked client's contractor/licensing identity onto the project
  // snapshot the adapters read, so submissions use authoritative client data
  // (CCB#, electrical license, installer company) instead of hardcoded names.
  // The licence keys are THIS track's in THIS state (clients.licenceOverlay) — never Oregon's CCB
  // on another state's filing.
  const overlay = clientStagingOverlay(db, detail.project.clientId, portalType, { state: String(detail.project.state ?? ""), track: track ?? null });
  const stagedProject = Object.keys(overlay).length > 0
    ? { ...portalProject, parserSnapshot: { ...portalProject.parserSnapshot, ...overlay } }
    : portalProject;

  // LLM-assisted gap-fill for the hand-coded adapters: build the same planner the auto-learn
  // engine uses so PowerClerk/Accela fill any REQUIRED field their fixed selectors miss — from
  // real project data only (secrets are stripped inside buildPortalPlanner and never reach the
  // LLM). Best-effort: if no LLM is configured, staging proceeds with the hand-coded fills only.
  let gapFillPlanner: import("../../portal-bot/src/adapters/autoLearnAdapter").LearnPlanner | undefined;
  let gapFillFields: Record<string, string> | undefined;
  // Build the planner whenever a real automation path could use it. The first-line RecipeAdapter
  // calls runGapFill during replay, and the hand-coded fallbacks call it in their page-advance
  // helper (PowerClerk's settleAndNext, Accela's continueAndCheck). Drive scope off the TRACK (not
  // the adapter flags) so a NEM recipe gets a utility-scoped planner and a permit recipe an AHJ-
  // scoped one; the `recipe ||` clause is what makes gap-fill available to RecipeAdapter, while
  // `isPowerClerk || isAccela` keeps it available to the hand-coded fallback. Skip only pure mock.
  if (recipe || isPowerClerk || isAccela) {
    try {
      const { buildPortalPlanner } = await import("./autoLearn");
      const isNemTrack = track === "nem";
      const built = buildPortalPlanner(db, stagedProject, {
        portalType,
        scopeType: isNemTrack ? "utility" : "ahj",
        // The permit/AHJ application lists differ by discipline - the TRACK carries it
        // (electrical files the electrical application; building/combo file structural).
        permitType: isNemTrack ? undefined : (track === "electrical" ? "electrical" : "structural"),
        track: track ?? null,
      });
      gapFillPlanner = built.planner;
      gapFillFields = built.projectFields;
    } catch { /* no planner available — stage with hand-coded/recipe fills only */ }
  }

  const stageOptions = {
    beforeUpload: uploadDocumentGuard(db, projectId, track !== "nem"),
    encryptedStorageStatePath: portalProfile?.encrypted_storage_state ?? undefined,
    // HEADED IS A DESKTOP CHOICE, NOT A STAGING CONSTANT. This was hardcoded false, which
    // forced a HEADED browser on every staging run regardless of PORTAL_HEADLESS — and the
    // learn then left that browser open at review for a human who, on a headless server,
    // does not exist. The invisible browser held the client+portal lane until the run
    // ceiling or a reaper: live in the scale test, the third project of a lane queued for
    // the full profile wait behind a review page nobody would ever see. resolveHeadless
    // reads PORTAL_HEADLESS (an operator desktop sets false and keeps the watch-and-verify
    // flow, review browser left open; a server defaults true and every browser closes).
    headless: resolveHeadless(undefined),
    reviewerReport,
    credential,
    userDataDir,
    autoSubmit: resolvedAutoSubmit,
    // THIS run's named approval, only when the decision above allowed it (null otherwise), and the
    // run id it names — portal-bot re-checks both, with the environment, at the click.
    runApproval: resolvedAutoSubmit ? runApproval : null,
    runId,
    // THE DOCUMENTS THIS FILING OWES beyond the plan set (docs plan D7) - permit tracks only.
    // A trackless (legacy) stage still gets the list (skeptic eb36a8f MF2) - only the NEM track owes none.
    owedAttachments: track === "nem" ? [] : owedAttachmentsFor(db, detail.project, docsByType),
    // Operator-delegated submit for the HAND-CODED adapters: the same decision. With no recipe
    // (the hand-coded and self-seed paths) the decision refuses, so this is false there.
    allowFinalSubmit: allowFinalSubmit === true && resolvedAutoSubmit,
    // THE OPERATOR JUST SUBMITTED IN THE OPEN WINDOW. Reading the record number off the
    // completion page is the largest avoidable interruption in the product (~258 per 100
    // projects — it happens on every single filing, and a person types a number that is
    // already on the screen in front of a browser we own). Hard rule 1 is untouched: the
    // human clicked submit, this only reads what came back.
    //
    // WRITTEN ONLY WHEN THE READ IS CONFIDENT. Every downstream check keys on this value,
    // so a low-confidence read is recorded as a NOTE for the operator to confirm rather
    // than written as fact — the manual capture form keeps working exactly as it does now.
    onSubmitCaptured: (capture: { recordNumber: string; confidence: string; reason: string; recordLink: string }) => {
      try {
        if (capture.confidence === "high" && capture.recordNumber) {
          // runId is minted above, before staging, and the row exists by the time a human
          // gets round to clicking submit — this fires from the left-open window, minutes
          // later. captureConfirmation is the SAME function the manual form calls, so the
          // filing is recorded through one path whoever supplied the number.
          captureConfirmation(db, runId, {
            applicationNumber: capture.recordNumber,
            submittedBy: "read from the portal's completion page",
            notes: capture.reason.slice(0, 300),
          });
          addAuditLog(db, projectId, "portal_bot", "submit capture", "submission.record_number_read", {
            track, runId, source: "completion_page", reason: capture.reason.slice(0, 200),
          });
          logger.info("submit-capture", "record number read off the completion page — no typing needed", {
            project: projectId, track,
          });
        } else {
          // Not confident — say so where the operator will see it, and leave the form alone.
          addAuditLog(db, projectId, "portal_bot", "submit capture", "submission.record_number_unread", {
            track, reason: capture.reason.slice(0, 200),
          });
        }
      } catch { /* capture is a convenience; it must never disturb the run */ }
    },
    gapFillPlanner,
    gapFillFields,
    // The per-job lookup's issuing agency for THIS track, for a hand-coded adapter choosing
    // between an address's jurisdiction rows (portal-bot addressVersion). A recipe replay reads
    // the same answer from its bound field values (bindRecipeForReplay → issuingAgency).
    issuingAgency: track && track !== "nem" ? (issuingAgencyFor(portalProject, track)?.value ?? null) : null,
    // Track-scoped portal URL so multi-tenant platform adapters (PowerClerk hosts PGE
    // AND PacifiCorp on different subdomains) log in to the RIGHT portal instead of a
    // hardcoded default. Already permit/utility scoped by the credentialUrl resolution.
    loginUrl: credentialUrl || undefined,
  };

  // UNIVERSAL-FIRST dispatch with SELF-SEED (see selectStagingActor):
  //   1. RecipeAdapter        — a recorded complete recipe replays first-line for every portal;
  //   2. AutoLearnAdapter     — no recipe yet → SEED one now: the universal learner records a
  //                             recipe AND stages this project to review in one pass, then
  //                             auto-promotes it to "complete" only on a clean triple-verification
  //                             so the next stage replays deterministically. The learner never
  //                             clicks final submit / pays a fee / solves a CAPTCHA and bails to a
  //                             human on MFA/CAPTCHA. On a learn failure we STOP AND SURFACE — no
  //                             silent fallback to the hand-coded adapter.
  //   3. PowerClerk/Accela    — reachable ONLY when auto-seed is disabled (PORTAL_AUTOSEED=0).
  //   4. MockPortalAdapter    — ONLY on the explicit MOCK_PORTAL=1 switch (smoke / rehearsal);
  //                             no portal + no switch → NoAdapter: stop and surface (#14).
  const autoSeedEnabled = process.env.PORTAL_AUTOSEED !== "0" && process.env.PORTAL_AUTOSEED !== "false";
  // A portal is "real" (worth driving live automation against — incl. self-seeding a recipe) when
  // EITHER a configured portal_profiles row exists OR we know a genuine PORTAL ENTRY URL for it.
  // Nothing in the app ever writes portal_profiles, so without this URL-based fallback every stage
  // lacking a complete recipe would silently route to the no-op mock and never open a browser.
  // The entry URL is deliberately NARROWER than credentialUrl: a recorded recipe (complete OR
  // draft), a learned KB profile, or the utility's KB portal URL (NEM) — but NOT the permit-track
  // findApplicationProfile().sourceUrl, which is an AHJ *info/landing* page, not a login/portal
  // entry. Launching the learner there would burn a pass on a non-portal AND would turn every
  // mock/dev/smoke permit stage into a live browser run. To self-seed a permit portal, the operator
  // points the recorder at the real portal URL first (which yields a draftRecipe entry URL here).
  // ONE list (portalChannel.learnEntryUrl): fitted candidates, and for a permit track the cited
  // statewide portal too (already fitted above as "statewide") — Jefferson's Stage found no entry
  // and never opened the learner, although the lookup's agency files on Oregon ePermitting.
  const portalEntryUrl = learnEntryUrl({
    track,
    // Fitted, like every other candidate: a learned profile carrying the other track's portal
    // (or another entity's) is not a launchable entry for THIS stage.
    learnedProfileUrl: permitSafeUrl(learnedProfile && (learnedProfile as { portalUrl?: string }).portalUrl),
    recipeUrl: recipe ? (recipe as { portalUrl?: string }).portalUrl : "",
    draftUrl: draftRecipe ? draftRecipe.portalUrl : "",
    utilityUrl: utilityPortalUrl,
    ahjUrl: ahjPortalUrl,
    statewideUrl: statewidePortalUrl,
  });
  const hasLaunchablePortal = isRealPortal || Boolean(portalEntryUrl);
  // Capability registry: resolve the staging channel in one explicit decision. With the
  // API tier reserved (apiAvailable=false, no adapter) and no kill-switch wired yet
  // (portalPaused=false), this returns exactly the actor selectStagingActor produced —
  // a behaviour-preserving indirection that gives the dispatch a single seam to extend.
  // Legal kill-switch: if this jurisdiction (or its whole platform) is paused, the
  // registry resolves to a manual handoff and no automation is driven at all.
  const portalPaused = isPortalPaused(db, {
    scopeType: track === "nem" ? "utility" : "ahj",
    state: portalProject.state,
    ahj: portalProject.ahj,
    utility: portalProject.utility,
    platform,
  });
  const channelDecision = resolvePortalChannel({
    hasRecipe: Boolean(recipe),
    isRealPortal: hasLaunchablePortal,
    isAccela,
    isPowerClerk,
    autoSeedEnabled,
    // Simulation is an EXPLICIT opt-in (smoke test, simulated rehearsal) — never
    // implied by PORTAL_AUTOSEED=0 on a production box.
    simulationEnabled: process.env.MOCK_PORTAL === "1",
    portalPaused,
  });
  const runActorLabel = channelDecision.adapterLabel;
  // Now that the actor is known, name a real-but-profile-less portal by its track identity so the
  // status/audit text below doesn't read "Mock portal" for a run that actually drives a browser.
  if (!isRealPortal && runActorLabel !== "MockPortalAdapter") {
    portalLabel = track === "nem"
      ? (portalProject.utility ? `${portalProject.utility} (NEM portal)` : "Utility NEM portal")
      : (portalProject.ahj ? `${portalProject.ahj} (permit portal)` : "AHJ permit portal");
  }
  // WHAT THE AUDIT TRAIL CALLS THIS RUN'S PORTAL (dry run 2026-09-28, B12: 45 of 45 real staging runs
  // were audited portalType "mock"). `portalType` above is the portal_profiles row's type, "mock" when
  // there is none — and nothing writes portal_profiles, so every real run fell back to it. That
  // variable stays exactly as it is: it keys the credential lookup, the per-client browser profile
  // directory, the staging overlay and the field resolver, and renaming it would log every client out
  // of every portal. The AUDIT value is its own, from the dispatch decision: "mock" only when the mock
  // adapter is the one that ran; a stored profile's type when there is one; else the host the run
  // was pointed at; else the track's kind of portal.
  const auditPortalType = runActorLabel === "MockPortalAdapter"
    ? "mock"
    : isRealPortal
      ? portalType
      : (portalHostOf(String(recipe?.portalUrl ?? "") || portalEntryUrl || credentialUrl) || (track === "nem" ? "utility_portal" : "permit_portal"));
  // DISCIPLINE GATE input (see portalChannel.recipeDisciplineFromSteps): the ACA
  // learner bakes the learn project's permit discipline into the recorded jurisdiction
  // row + record-type steps. Recipes ARE keyed per discipline (migration v14,
  // `recipe_discipline` — state|ahj|utility PER discipline), but a row recorded BEFORE
  // that dimension existed carries discipline '' and is accepted as a legacy fallback at
  // line ~5549, so its steps can still belong to the other discipline. Best-effort load
  // — a failed read must not block the stage.
  // DEFENCE IN DEPTH. The legacy check above drops a cross-discipline recipe before the
  // channel is chosen, so this should no longer fire; it stays as the last guard against
  // replaying a recipe whose steps file under the wrong authority (silently - the clicks
  // all succeed, so neither drift detection nor self-heal would notice).
  let recipeDisciplineConflict: "electrical" | "structural" | null = null;
  if (recipe && (track === "electrical" || track === "building")) {
    try {
      const d = recipeDisciplineFromSteps(getPortalRecipe(db, recipe.id).steps);
      recipeDisciplineConflict = disciplineConflictsWithTrack(d, track) ? d : null;
    } catch { recipeDisciplineConflict = null; }
  }
  // RE-CHECK AT THE LAST POINT BEFORE DISPATCH. Everything above — the package build, the
  // official-documents pass, cold-start research — takes real time, and another run can put
  // this track on the portal meanwhile. Staging is not idempotent portal-side, so a track that
  // was NOT on the portal when this call began and IS now is refused with the already-filed
  // shape. (A track that was already staged at entry is an explicit re-stage and still goes.)
  //
  // The per-(client, portal) profile lock is NOT taken here: it lives in portal-bot's openPortal
  // (browser.ts acquireProfile), inside the adapter call below. A run that reaches this line
  // while another run on the same track is still inside its adapter cannot see it — that run's
  // portal_runs row is written only after its adapter returns — and will then wait on the lock
  // and stage a second draft. In-process that window is closed by the job claim
  // (jobQueue PROJECT_BUSY_SQL: one portal-effect job per project at a time, and every
  // prepareSubmission caller is such a job); it stays open across processes and for a job the
  // watchdog reclaims mid-run.
  // A 'running' row another run inserted while this one prepared counts as staged-meanwhile too:
  // trackAlreadyStaged (autopilot.ts) does not know that status.
  const stagedMeanwhile = stageCovers.filter((t) => (!stagedAtEntry.has(t) && trackAlreadyStaged(db, projectId, t))
    || Boolean(trackRunInFlight(db, projectId, trackFamily(t))));
  if (stagedMeanwhile.length) {
    const first = stagedMeanwhile[0];
    addAuditLog(db, projectId, "system", "submit gate", "portal.staged_meanwhile", { track: track ?? "permit", tracks: stagedMeanwhile });
    throw new HttpError(409,
      `The ${stagedMeanwhile.join(", ")} track${stagedMeanwhile.length > 1 ? "s were" : " was"} staged to the portal by another run while this one was preparing. `
      + "Staging it again would open a duplicate application with the jurisdiction. "
      + "Submit (or discard) the staged draft first if it needs to be replaced.",
      { track: first, permitNumber: null, submittedAt: null, stagedMeanwhile });
  }
  // A PER-JOB QUESTION THE JOB HAS NOT ANSWERED STOPS THE STAGE HERE — BEFORE A BROWSER OPENS
  // (dryrun-0928 B2). The recipe about to replay asks who owns the system (or whether it is behind
  // the meter / the disconnect distance), the answer is THIS job's, and no document states it. The
  // live PacifiCorp recipe filed the learn job's "Customer-Owned" on every job; the replay binder
  // (R10) now binds that control to the job's key, and an unanswered key would replay a blank — so
  // the question is asked first, named, the way the question bank lists it for intake. Same
  // predicate as the bank, the binders and the planner (shared/src/perJobQuestions).
  if (recipe && runActorLabel === "RecipeAdapter" && !channelDecision.blocked
      && !recipeTrackConflict && !recipeEntityMisfit && !recipeDisciplineConflict) {
    let open: Array<{ key: string; label: string }> = [];
    try {
      const gateValues = resolveRecipeFieldValues(db, stagedProject, portalType, track ?? null);
      const gateBinding = bindRecipeForReplay({
        steps: recipe.steps ?? [], portalUrl: recipe.portalUrl, project: portalProject, fieldValues: gateValues, track,
        borrowed: borrowed ? { learnedFor: borrowed.learnedFor, discipline: borrowed.discipline } : null,
        agency: issuingAgencyFor(portalProject, track),
      });
      open = openPerJobQuestions(gateBinding.steps, { ...gateValues, ...gateBinding.fieldValues });
    } catch (err) {
      // The replay path binds the same steps again inside the run below and records its own failure.
      logger.warn("prepare-submission", `per-job question check could not read the recipe: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (open.length) {
      addAuditLog(db, projectId, "system", "submit gate", "portal.per_job_question_open", {
        track: track ?? "permit", recipeId: recipe.id, questions: open,
      });
      throw new HttpError(409,
        `Staging paused before opening the portal: ${portalLabel} asks ${open.length === 1 ? "a question" : `${open.length} questions`} only a person can answer for this job — `
        + `${open.map((q) => `"${q.label}"`).join("; ")}. The recorded answer belonged to another job, so it is never replayed; `
        + "answer it under the project's portal questions (or send the intake link), then stage again. Nothing was opened.",
        { unansweredPortalQuestions: open, track: track ?? "permit", recipeId: recipe.id });
    }
  }
  let result: Record<string, unknown>;
  // What the replay-failure classifier decided about the recipe, for the run's own message.
  let replayVerdictNote = "";
  let replayBinding: ReturnType<typeof bindRecipeForReplay> | null = null;
  // THE RUN ROW EXISTS BEFORE THE BROWSER OPENS (A3). Until now it was written only after the
  // adapter returned: 4 of 7 interrupted production jobs left no record of an application the
  // portal may already have created, and a re-stage opened a duplicate draft. 'running' names
  // the recipe version and the process driving it; a row whose runner is gone is recovered as
  // 'interrupted' (recoverInterruptedPortalRuns), never read as a live run or as a staged one.
  // A stored portal profile may have been deleted since it was resolved; the run row's FK must
  // hold, so an orphaned id becomes null (a valid, FK-satisfying value).
  const safePortalProfileId = portalProfileId && db.get<{ id?: string }>("SELECT id FROM portal_profiles WHERE id = ?", [portalProfileId])
    ? portalProfileId
    : null;
  insertRunningPortalRun(db, {
    runId, projectId, portalProfileId: safePortalProfileId, startedAt: ts, permitType: track ?? "permit",
    actor: runActorLabel, recipeId: recipe?.id ?? null, recipeVersion: recipe?.version ?? null,
  });
  // EVERY STAGING BROWSER LAUNCH IS A POSSIBLE DRAFT ON A REAL ACCOUNT, WRITTEN DOWN BEFORE IT OPENS
  // (dryrun-0928 B11). Only the learn and the benchmark wrote the draft ledger, so a clean project's
  // building and electrical replays left two drafts on Oregon ePermitting that the list a company is
  // handed for cleanup never showed. Written at each launch below — not at the run row, since several
  // branches after it open nothing (kill-switch, host/entity/discipline conflicts) — and a headed
  // retry is a second browser, so a second row. The learn path writes its own (autoLearnPortal).
  const ledgerStagingLaunch = (purpose: string, url: string): void => {
    try {
      recordDraftTouch(buildDraftTouch({
        portalUrl: url, projectId, purpose,
        note: resolvedAutoSubmit
          ? `an approved run (named approval, run ${runId}) — may be FILED, not only drafted`
          : `staging stops at review; automation never submits it (run ${runId})`,
        credentials: clientId ? listPortalCredentials(db, clientId) : [],
      }));
    } catch (err) {
      logger.warn("prepare-submission", `draft ledger row not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  try {
    if (channelDecision.blocked) {
      // Kill-switch tripped: surface a manual handoff and drive NO automation.
      const msg = `${portalLabel} is paused (legal kill-switch). ${channelDecision.reason} Submit this application by hand and resume the portal once it's cleared.`;
      result = { ok: false, finalSubmitClicked: false, pauseReason: "portal_paused", message: msg, steps: [{ ok: false, message: msg }] };
    } else if (recipe && runActorLabel === "RecipeAdapter" && recipeTrackConflict) {
      // TRACK/HOST GATE for the REPLAY path, BOTH WAYS: a pre-fix learn mis-keyed by the KB
      // poisoning bug can leave an AHJ-scoped COMPLETE recipe whose steps drive the utility NEM
      // portal (or a utility recipe that drives a permit portal, or a goto that leaves for one).
      // Migration v8 repairs the KB rows but can't rewrite recipes — without this check the
      // recipe's existence bypasses the self-seed gate below and stages the filing in the wrong
      // system. Flag it for re-recording and stop.
      const badUrl = recipeTrackConflict.url || recipe.portalUrl;
      const isNemTrack = track === "nem";
      try {
        markPortalRecipeForRerecord(db, recipe.id, {
          actor: "track/host gate", actorType: "system", projectId,
          reason: isNemTrack
            ? `a utility recipe points at an AHJ permit portal (${badUrl})`
            : `an AHJ recipe points at a utility interconnection portal (${badUrl})`,
        });
      } catch { /* best-effort */ }
      const msg = isNemTrack
        ? `The recorded recipe for ${portalLabel} points at an AHJ permit portal (${badUrl}) — that's a building-permit system, not the ${detail.project.utility || "utility"} interconnection portal. It was mis-recorded and has been flagged for re-recording. Record the utility's NEM portal, then re-stage.`
        : `The recorded recipe for ${portalLabel} points at a utility interconnection portal (${badUrl}) — that's the NEM portal, not the ${portalProject.ahj || "AHJ"} permit portal. It was mis-recorded and has been flagged for re-recording. Record the AHJ's permit portal, then re-stage.`;
      addAuditLog(db, projectId, "system", "submit gate", "portal.track_host_conflict", { track: track ?? "permit", url: badUrl, recipeId: recipe.id });
      result = { ok: false, finalSubmitClicked: false, pauseReason: null, message: msg, steps: [{ ok: false, message: msg }] };
    } else if (recipe && runActorLabel === "RecipeAdapter" && recipeEntityMisfit) {
      // ENTITY GATE: the recipe this project's key resolved drives a portal that is not this
      // entity's — another utility's/AHJ's portal, or one a person verified is NOT where this
      // entity files. Nothing is launched and the recipe is left exactly as it is (it may be
      // right for whoever it was learned on); the operator fixes the key or the KB.
      const who = track === "nem" ? (portalProject.utility || "this utility") : (portalProject.ahj || "this AHJ");
      const msg = `Staging stopped before opening a browser: the recipe found for ${who} drives ${recipeEntityMisfit.url} — ${recipeEntityMisfit.reason}. Nothing was launched and the recipe was not changed. If ${who} really files there, save that portal on ${who}'s knowledge-base profile (verified) and re-stage; otherwise record ${who}'s own portal.`;
      addAuditLog(db, projectId, "system", "submit gate", "portal.recipe_entity_conflict", {
        track: track ?? "permit", recipeId: recipe.id, url: recipeEntityMisfit.url, code: recipeEntityMisfit.code, reason: recipeEntityMisfit.reason,
      });
      result = { ok: false, finalSubmitClicked: false, pauseReason: null, message: msg, steps: [{ ok: false, message: msg }] };
    } else if (recipe && runActorLabel === "RecipeAdapter" && recipeDisciplineConflict) {
      // DISCIPLINE GATE: this AHJ's recipe was learned for the OTHER permit discipline —
      // its recorded steps select that discipline's jurisdiction row and record type, and
      // the replay clicks would succeed silently (no drift, no self-heal), filing this
      // track down the wrong jurisdiction's application path. NOT flagged for re-record:
      // the recipe is valid for its own discipline, and its ROW is simply keyed wrong.
      //
      // RECIPES ARE DISCIPLINE-KEYED, AND THIS SAID THEY WERE NOT. Migration v14
      // (`recipe_discipline`) keys portal_recipes on (profile_key, discipline) — see
      // db.ts:892-894 and docs/HANDOFF.md ("RESOLVED (migration v14)"). The comment and the
      // operator-facing message below both claimed, in the present tense, that the product
      // lacked a capability it shipped, and then told the operator to hand-file. The real
      // remedy is that this recipe's row carries discipline '' (a pre-v14 legacy row) or the
      // wrong discipline, and it can be re-keyed — scripts/rekey-recipe.ts does exactly that.
      // Rare gate, which is exactly when the operator has no context to doubt the message.
      const msg = `The recorded recipe for ${portalLabel} is keyed for the ${recipeDisciplineConflict} permit discipline, so replaying it for the ${track} track would file under the wrong jurisdiction/application type. Its steps are valid for ${recipeDisciplineConflict} — the row is keyed wrong (usually a recipe recorded before recipes carried a discipline). Re-key it with scripts/rekey-recipe.ts, or record a recipe for the ${track} track; submit this one by hand meanwhile (the ${recipeDisciplineConflict} track still replays automatically).`;
      addAuditLog(db, projectId, "system", "submit gate", "portal.discipline_conflict", { track: track ?? "permit", recipeDiscipline: recipeDisciplineConflict, recipeId: recipe.id });
      result = { ok: false, finalSubmitClicked: false, pauseReason: null, message: msg, steps: [{ ok: false, message: msg }] };
    } else if (recipe && runActorLabel === "RecipeAdapter") {
      // THE REPLAY NEVER CARRIES ANOTHER PROJECT'S DATA (recipeReplayBinding): record links are
      // not replayed, project literals bind to THIS project, the agency row binds to the looked-up
      // agency, and state vocabulary guidance applies — on the own recipe AND a borrowed one.
      // THE STEPS THIS REPLAY READ (trust skeptic M3, close M3-selectors) — fingerprinted before
      // anything binds or runs them. A human step edit does not bump the version, so heals and the
      // demotion are measured against every field of these steps, selectors included.
      const replayStepsSig = recipeStepsSignature(recipe.steps ?? []);
      const replayFieldValues = resolveRecipeFieldValues(db, stagedProject, portalType, track ?? null);
      replayBinding = bindRecipeForReplay({
        steps: recipe.steps ?? [], portalUrl: recipe.portalUrl, project: portalProject, fieldValues: replayFieldValues, track,
        borrowed: borrowed ? { learnedFor: borrowed.learnedFor, discipline: borrowed.discipline } : null,
        agency: issuingAgencyFor(portalProject, track),
      });
      if (replayBinding.changes.length) {
        addAuditLog(db, projectId, "system", "portal staging", "portal.replay_binding", {
          runId, recipeId: recipe.id, changes: replayBinding.changes.map((c) => ({ index: c.index, kind: c.kind, reason: c.reason.slice(0, 200) })),
        });
      }
      const boundRecipe = { ...recipe, steps: replayBinding.steps };
      const boundValues = { ...replayFieldValues, ...replayBinding.fieldValues };
      ledgerStagingLaunch(`staging replay (${track ?? "permit"} track, run ${runId})`, String(recipe.portalUrl || credentialUrl || ""));
      result = await recipeStageRunner(boundRecipe, stagedProject, boundValues, docsByType, files, stageOptions);

      // A BOT WALL MUST NOT BLOCK A FILING — RETRY WITH A REAL WINDOW.
      //
      // autoLearnPortal has had this since Baltimore ("portal refused a headless browser —
      // retrying with a real window"); STAGING never did, so a portal that refuses headless
      // failed the submission outright even though the same machine could have filed it. It is
      // not hypothetical: coosbayor.gov returns 403 to every programmatic client including
      // HEADLESS Playwright, and 200 to a headed window. A portal behaving that way at staging
      // time is a filing that silently does not happen.
      //
      // Same guard rails as the learn path: only on a failure that LOOKS like a bot block (not
      // on any old failure, which would double every real error's cost), only once, only when we
      // were actually headless, and only when the operator has not switched it off. The retry
      // result is kept only if it got further, so a second refusal cannot erase the first
      // result's diagnostics.
      if (!result.ok && looksBotBlocked(stageFailureText(result)) && stageOptions.headless !== false
          && process.env.PORTAL_HEADED_RETRY !== "0") {
        logger.info("portal", "portal refused a headless browser at staging — retrying with a real window", {
          projectId, portal: portalLabel,
        });
        try {
          ledgerStagingLaunch(`staging replay (${track ?? "permit"} track, run ${runId}) — headed retry, a second browser; may leave a second draft`, String(recipe.portalUrl || credentialUrl || ""));
          const headedResult = await recipeStageRunner(
            boundRecipe, stagedProject, boundValues, docsByType, files,
            { ...stageOptions, headless: false },
          );
          const before = Array.isArray((result as { steps?: unknown[] }).steps) ? (result as { steps: unknown[] }).steps.length : 0;
          const after = Array.isArray((headedResult as { steps?: unknown[] }).steps) ? (headedResult as { steps: unknown[] }).steps.length : 0;
          if (headedResult.ok || after > before) {
            result = headedResult;
            result.message = `${result.message ?? ""} (succeeded on a headed retry — this portal refuses headless browsers)`.trim();
            addAuditLog(db, projectId, "system", "portal staging", "portal.headed_retry", { portal: portalLabel, track: track ?? "permit" });
          }
        } catch (e) {
          logger.warn("portal", "headed retry failed", { projectId, err: e instanceof Error ? e.message : String(e) });
        }
      }
      // SELF-HEALED STEPS: replay repaired drifted selectors. Persist each heal onto the ONE step
      // it healed (by stepIndex), only if the recipe is still the version this replay read — see
      // persistHealedSteps. The heals ride on the fill step's data (the adapter result's top level
      // never carried them, so this block was dead code); both places are read.
      // Heals are reported against the steps the run EXECUTED; map each back to the stored step it
      // healed (a record-link step the binding dropped shifts every later index).
      let stepsSigNow = replayStepsSig;
      const healed = collectHealedSteps(result)
        .map((h) => ({ ...h, stepIndex: replayBinding?.originalIndex[h.stepIndex] ?? -1 }))
        .filter((h) => h.stepIndex >= 0);
      // A BORROWED RECIPE IS NEVER CHANGED BY ANOTHER ENTITY'S RUN. A heal on Salem's page is a
      // fact about Salem's page; written onto the Coos Bay recipe it would break Coos Bay. The
      // heals are recorded for the operator and discarded; drift stops the run (ruling).
      if (healed.length && borrowed) {
        addAuditLog(db, projectId, "system", "portal staging", "portal.borrowed_recipe_heal_discarded", {
          runId, recipeId: recipe.id, learnedFor: borrowed.learnedFor, heals: healed.length,
        });
      } else if (healed.length) {
        // The run's OWN heal rewrites a selector: from here on the recipe is "unchanged" when it
        // is exactly what that heal wrote (a human edit before or after it still reads as changed).
        const heal = persistHealedSteps(db, recipe.id, recipe.version, healed, { projectId, runId, expectedStepsSig: replayStepsSig });
        if (heal.stepsSigAfter) stepsSigNow = heal.stepsSigAfter;
      }
      // WHOSE FAULT WAS THE FAILURE? (operator ruling 2026-09-24: keep-and-flag.)
      //
      // This used to demote on /recipe step failed/i over EVERY step's message joined — with no
      // classifier at all. PGE 481c00f4 was demoted in the same second a run died with "Target
      // page, context or browser has been closed"; PacifiCorp 6282e671 after a document-gate
      // refusal. NEM replay went offline for every production utility on failures that said
      // nothing about either recipe. And feeding the JOINED text to the classifier fails the
      // other way: the review step's boilerplate says "handle any MFA/fee", so every failure
      // would read as an MFA wall and nothing would ever demote.
      //
      // So: the failing step's OWN message (extractStageFailureMessage) goes to the one
      // classifier, demoteOnReplayFailure. Drift it could not heal → demote (and only then a
      // re-learn). Harness aborts, document gates, missing project data, challenges and outages
      // → keep. Nothing attributable → keep AND flag for a human. A paused run (MFA/CAPTCHA
      // wall) is not a failure of anything and never reaches here.
      // Only a replay that FAILED (not a pause) is judged. A paused run stopped at a challenge.
      const replayFailed = result && result.ok === false && !(typeof result.pauseReason === "string" && result.pauseReason);
      // THE PORTAL SAID THIS ADDRESS IS NOT SERVED THERE (portal-truth D5). The replay stopped with
      // the portal's own words; nothing filed here is kept for this entity on that host: its own
      // recipe is refused (flagged, demoted — never replayed again until a person clears it); on a
      // BORROWED run the donor is untouched and a refused row is saved for THIS entity, so the next
      // stage neither borrows nor falls back to this host.
      const notServed = replayFailed ? notServedInResult(result) : null;
      if (notServed) {
        const where = track === "nem" ? (portalProject.utility || "this utility") : (portalProject.ahj || "this AHJ");
        const host = portalHostOf(String(recipe.portalUrl ?? "")) || String(recipe.portalUrl ?? "");
        try {
          recordPortalNotServed(db, {
            scopeType: track === "nem" ? "utility" : "ahj", state: portalProject.state, ahj: portalProject.ahj, utility: portalProject.utility,
            discipline: trackDiscipline, portalUrl: String(recipe.portalUrl ?? ""), quote: notServed, projectId, recipeId: borrowed ? null : recipe.id,
          });
        } catch (e) {
          logger.warn("portal", "could not record the not-served refusal", { projectId, err: e instanceof Error ? e.message : String(e) });
        }
        replayVerdictNote = borrowed
          ? ` ${host} said this address is not served there ("${notServed}"): ${where} does not file this permit on that portal. The ${borrowed.learnedFor} recipe was not changed; nothing was kept for ${where} on ${host}. A person confirms ${where}'s own portal.`
          : ` ${host} said this address is not served there ("${notServed}"): the recipe was refused (flagged; it will not replay again until a person clears the flag). A person confirms ${where}'s own portal.`;
      }
      // A BORROWED recipe's failure on another entity's page says nothing about the recipe on its
      // own entity: it never demotes, never flags, never queues a re-learn. It is recorded (with
      // what the classifier would have said) and the run stops — that is the ruling's "drift
      // stops the run".
      if (replayFailed && borrowed) {
        const blame = replayFailureBlamesRecipe(extractStageFailureMessage(result));
        addAuditLog(db, projectId, "system", "portal staging", "portal.borrowed_recipe_failed", {
          runId, recipeId: recipe.id, learnedFor: borrowed.learnedFor, attribution: blame.attribution, reason: blame.reason,
        });
        if (!notServed) replayVerdictNote = ` This run replayed the ${borrowed.learnedFor} recipe on the shared portal; it stopped here and the ${borrowed.learnedFor} recipe was not changed.`;
      }
      const replayVerdict = replayFailed && !borrowed && !notServed
        ? (() => {
          try {
            return demoteOnReplayFailure(db, recipe.id, extractStageFailureMessage(result), recipe.version, { runId, projectId, expectedStepsSig: stepsSigNow });
          } catch {
            return null; /* best-effort: the run result stands */
          }
        })()
        : null;
      if (replayVerdict?.action === "flagged") {
        replayVerdictNote = " The recipe was KEPT (nothing in the failure points at it) and flagged for a human to look at.";
      } else if (replayVerdict?.action === "kept") {
        replayVerdictNote = ` The recipe was kept: ${replayVerdict.reason}.`;
      }
      if (replayVerdict?.action === "demoted") {
        // SELF-HEAL: the system already has a safe autonomous learner (never clicks
        // final submit, respects the portal kill-switch) — queue a fresh learn of
        // this portal instead of leaving a manual "re-record it" dead end. One-shot
        // event-driven enqueue (maxRetries 0 — a failed learn must not relaunch
        // browsers on a timer), deduped against an already-queued learn.
        let relearnQueued = false;
        try {
          if (process.env.ANTHROPIC_API_KEY && !portalPaused && recipe.portalUrl && process.env.AUTO_RELEARN_STALE !== "0") {
            // Dedupe portal-wide, not per-project: the stale recipe is shared by
            // every project on this AHJ/utility, and N projects hitting it must
            // not queue N identical browser learns of the same portal. Also skip
            // if this portal was already re-learned recently (6h window).
            const pending = db.get<Row>(
              `SELECT id FROM job_queue WHERE job_type = 'auto_learn' AND payload LIKE ?
                 AND (status IN ('pending','running') OR created_at > ?) LIMIT 1`,
              [`%${recipe.portalUrl}%`, new Date(Date.now() - 6 * 3600_000).toISOString()],
            );
            if (!pending) {
              void import("./jobQueue").then(({ enqueueJob }) => {
                enqueueJob(db, "auto_learn", {
                  scope: track === "nem" ? "utility" : "ahj",
                  portalUrl: recipe.portalUrl,
                  createdBy: "auto-relearn (stale recipe)",
                  permitType: track === "nem" ? undefined : (track === "electrical" || track === "mpu" || detail.project.permitType === "electrical" ? "electrical" : "structural"),
                  discipline: trackDiscipline,
                  // The stale recipe was found under THIS stage's view; the re-learn keys on the same
                  // one (autoLearn learnIssuerTrack) — null for a trackless stage, never a derived view.
                  track: track ?? null,
                }, { projectId, priority: 5, maxRetries: 0 });
              }).catch(() => null);
              relearnQueued = true;
            }
          }
        } catch { /* self-heal is best-effort */ }
        result = {
          ...result,
          recipeStale: true,
          message: `${result.message || extractStageFailureMessage(result)} — this recipe looks stale (the portal likely changed) and has been flagged for re-recording. ${relearnQueued ? "A fresh learn of the portal was queued automatically; re-stage once it finishes." : "Re-record it, then re-stage."}`,
        };
      }
    } else if (runActorLabel === "AutoLearnAdapter") {
      // Self-seed: learn + stage in one pass. Reuse the entry URL already resolved for the
      // credential match; pass the client-overlaid stagedProject so the learner fills authoritative
      // contractor identity (not the raw parse).
      // TRACK/HOST SANITY GATE: a permit (AHJ) track must never launch a known utility-
      // platform host — a PowerClerk URL reaching this point means the resolution chain
      // picked up the NEM portal (e.g. a poisoned KB row), and learning the wrong portal
      // both wastes the pass AND mis-keys the recorded recipe to the AHJ scope.
      // Every candidate was already fitted; this is the last check at the door, both directions.
      const learnFit = credentialUrl ? hostFitsTrackAndEntity(track, hostEntity, credentialUrl, "kb") : null;
      const trackHostConflict = Boolean(learnFit && learnFit.code === "track_conflict");
      if (!credentialUrl) {
        // No entry URL to launch the learner — stop and surface rather than guess a portal.
        // When candidates WERE found and refused, say which and why: "no URL known" would send the
        // operator hunting for a URL the KB already holds (for another entity or the other track).
        const refusedNote = refusedUrls.length
          ? ` Refused (not this ${track === "nem" ? "utility's" : "AHJ's"} portal): ${refusedUrls.slice(0, 3).map((r) => `${r.url} — ${r.reason}`).join("; ")}.`
          : "";
        const msg = (process.env.ANTHROPIC_API_KEY
          ? `No portal URL is known for ${portalLabel}, and automatic research couldn't confirm one either. Record the portal once (or add its URL to the knowledge base) and re-stage.`
          : `No portal URL is known for ${portalLabel}, so the universal learner can't seed a recipe yet. Record the portal once (or add its URL to the knowledge base) and re-stage — with an ANTHROPIC_API_KEY configured this would have been researched automatically.`)
          + refusedNote;
        result = { ok: false, finalSubmitClicked: false, pauseReason: null, message: msg, steps: [{ ok: false, message: msg }] };
      } else if (learnFit && !learnFit.fits) {
        const msg = trackHostConflict
          ? (track === "nem"
            ? `The only portal URL known for ${portalLabel} is an AHJ permit portal (${credentialUrl}) — not the ${detail.project.utility || "utility"} interconnection portal. Staging stopped so the interconnection isn't filed in the wrong system. Record the utility's NEM portal once (or add its URL to the knowledge base) and re-stage.`
            : `The only portal URL known for ${portalLabel} is a utility interconnection portal (${credentialUrl}) — that's the NEM portal, not the ${portalProject.ahj || "AHJ"} permit portal. Staging stopped so the permit isn't filed in the wrong system. Record the AHJ's permit portal once (or add its URL to the knowledge base) and re-stage.`)
          : `Staging stopped before opening a browser: ${credentialUrl} — ${learnFit.reason}.`;
        addAuditLog(db, projectId, "system", "submit gate", trackHostConflict ? "portal.track_host_conflict" : "portal.entity_host_conflict", { track: track ?? "permit", url: credentialUrl, code: learnFit.code });
        result = { ok: false, finalSubmitClicked: false, pauseReason: null, message: msg, steps: [{ ok: false, message: msg }] };
      } else {
        try {
          const { autoLearnPortal } = await import("./autoLearn");
          const seed = await autoLearnPortal(db, projectId, {
            scope: track === "nem" ? "utility" : "ahj",
            portalUrl: credentialUrl,
            // Already fitted here; the learn's own door re-asks the same question, and must know
            // a statewide-fallback URL is the deliberate statewide rule, not someone else's row.
            urlSource: statewidePortalUrl && credentialUrl === statewidePortalUrl ? "statewide" : "kb",
            createdBy: "auto-seed (staging)",
            permitType: track === "nem" ? undefined : (track === "electrical" || track === "mpu" || detail.project.permitType === "electrical" ? "electrical" : "structural"),
            // The recipe key's discipline for this track - MUST be the same value the
            // lookup above asked for, or the learned recipe is never found again.
            discipline: trackDiscipline,
            // AND THE SAME ISSUER (split issuer): this stage's own track, null when trackless, so the
            // learn keys on exactly `portalProject` — the view whose portal `credentialUrl` is — and
            // never re-derives a view from the permit type (a trackless stage's "structural" swapped
            // to the building issuer and saved the county's portal under the city's key).
            track: track ?? null,
            // The self-seed IS this track's staging run when no trusted recipe exists yet, so the
            // operator's delegated submit has to reach it here too — otherwise the only portals it
            // can never file on are precisely the ones with no recipe.
            // The self-seed has no complete recipe, so the one final-submit decision refused it.
            allowFinalSubmit: allowFinalSubmit === true && resolvedAutoSubmit,
            project: stagedProject,
            // Match the hand-coded/replay adapters' headed setting so the self-seed opens a visible
            // browser locally and leaves it open at review for the human (headless on a server).
            headless: stageOptions.headless,
          });
          result = seedOutcomeToStageResult(seed);
          // Say WHY this stage learned instead of replaying, so a re-learn on an AHJ that
          // already had a recipe doesn't look like the recipe went missing.
          if (droppedLegacyRecipeDiscipline && typeof result.message === "string") {
            result.message = `${result.message} (This AHJ's existing recipe was recorded for the ${droppedLegacyRecipeDiscipline} permit, so the ${track} track learned its own — each discipline now keeps a separate recipe.)`;
          }
        } catch (err) {
          // Learner couldn't even start (network/login/validation) — stop and surface.
          const msg = `Universal learn failed before staging: ${err instanceof Error ? err.message : String(err)}. Resolve the blocker and re-stage, or record the portal manually.`;
          result = { ok: false, finalSubmitClicked: false, pauseReason: null, message: msg, steps: [{ ok: false, message: msg }] };
        }
      }
    } else if (runActorLabel === "OregonEPermittingAdapter") {
      ledgerStagingLaunch(`staging, hand-coded Oregon ePermitting adapter (${track ?? "permit"} track, run ${runId})`, credentialUrl);
      result = await stageWithAccela(stagedProject, files, stageOptions);
    } else if (runActorLabel === "PowerClerkAdapter") {
      ledgerStagingLaunch(`staging, hand-coded PowerClerk adapter (${track ?? "permit"} track, run ${runId})`, credentialUrl);
      result = await stageWithPowerClerk(stagedProject, files, stageOptions);
    } else if (runActorLabel === "NoAdapter" || autoSeedEnabled) {
      // Nothing REAL to drive: no recorded recipe and either no adapter for this real
      // portal (NoAdapter — including PORTAL_AUTOSEED=0, where the "legacy hand-coded
      // fallback" only exists for Accela/PowerClerk) or no known portal at all in
      // real mode. Do NOT run the mock — a mock "staged to review" that never touched
      // the portal moves a real filing to awaiting_human_submit, and the mock approve
      // path then fabricates MOCK-/CONF- permit numbers staff would trust. Stop and
      // surface the actionable blocker instead.
      const where = track === "nem" ? (portalProject.utility || "this utility") : (portalProject.ahj || "this AHJ");
      // The portal may be KNOWN and a recording found for it, refused on purpose (production
      // 2026-09-27, City of Jefferson building: the Coos Bay recording would pick the city row
      // where Marion County issues). "No portal automation is available" then reads as a missing
      // URL and sends the operator to re-paste one that is already there — say the real reason.
      const refused = borrowDecisionReason.startsWith("borrow refused: ") ? borrowDecisionReason.slice("borrow refused: ".length) : "";
      // THE STATEWIDE PORTAL WAS WITHHELD (portal-truth D1): say why — the operator confirms the
      // AHJ's own portal; "no portal automation" would read as a missing URL.
      const withheld = refusedUrls.find((r) => r.code === "withheld")?.reason ?? "";
      const msg = refused
        ? `No recording exists yet for ${where}'s ${track} permit${ownPortalUrl ? ` on ${portalHostOf(ownPortalUrl) || ownPortalUrl}` : ""}, and the recording learned elsewhere on that portal was not reused: ${refused}. Nothing was opened. This permit needs one supervised learn or recording for its issuing agency; then re-stage.`
        : withheld
          ? `No portal is confirmed for ${where}'s ${track ?? "permit"} permit, so nothing was opened. ${withheld}`
          // NO PORTAL KNOWN AT ALL (#14): nothing launchable for this entity — say the portal is
          // unconfirmed, in the same words the learner's no-URL stop uses, so staff don't read it as
          // "automation missing for a known portal".
          : !hasLaunchablePortal && !credentialUrl
            ? (process.env.ANTHROPIC_API_KEY
              ? `No portal URL is known for ${portalLabel}, and automatic research couldn't confirm one either. Nothing was staged. Record the portal once (or add its URL to the knowledge base) and re-stage.`
              : `No portal URL is known for ${portalLabel}, so nothing was staged. Record the portal once (or add its URL to the knowledge base) and re-stage — with an ANTHROPIC_API_KEY configured this would have been researched automatically.`)
              + (refusedUrls.length
                ? ` Refused (not this ${track === "nem" ? "utility's" : "AHJ's"} portal): ${refusedUrls.slice(0, 3).map((r) => `${r.url} — ${r.reason}`).join("; ")}.`
                : "")
          : `No portal automation is available for ${where} yet, so there's nothing to stage against. Record the portal once (paste its login/landing URL under "Record this portal") or add its URL to the knowledge base, then re-stage.`;
      result = { ok: false, finalSubmitClicked: false, pauseReason: null, message: msg, steps: [{ ok: false, message: msg }] };
    } else {
      // The mock stands in ONLY on the explicit MOCK_PORTAL=1 switch with auto-seed off —
      // offline dev, the smoke test, and the simulated rehearsal (selectStagingActor never
      // returns it otherwise, #14). A project with a real portal can never reach it in any mode.
      result = await stageWithMockPortal(stagedProject, files, reviewerReport);
    }
  } catch (err) {
    // An adapter that THROWS staged nothing we can vouch for. Recorded as a failed run (the row
    // above already exists), never as a 500 that leaves the row 'running' forever.
    const msg = `Portal run errored: ${err instanceof Error ? err.message : String(err)}`;
    result = { ok: false, finalSubmitClicked: false, pauseReason: null, message: msg, steps: [{ ok: false, message: msg }] };
  }

  // THE RUN'S OUTCOME COMES FROM ONE FUNCTION (derivePortalRunOutcome), and it answers from what
  // the adapter REPORTS happened — never from what this call was permitted to do. A run in which
  // automation clicked a final submit is 'submitted' (the portal confirmed) or
  // 'submitted_unconfirmed' (it did not say), with a submissions row written in the same
  // transaction — never 'failed': production runs 08909df6 and 5864e8ef clicked the submit and
  // were recorded failed with no submission, so the duplicate guard let a second filing through.
  try {
    const outcome = derivePortalRunOutcome(result);
    const pauseReason = outcome.pauseReason;
    const clicked = outcome.finalSubmitClicked;
    const acceptedFiling = outcome.status === "submitted";
    const adapterFailed = outcome.status === "failed";
    const failureMessage = adapterFailed
      ? `${outcome.harnessAbort ? "[our browser/harness went away — this says nothing about the portal] " : ""}${extractStageFailureMessage(result)}${replayVerdictNote}`
      : "";
    // Permit/record number + record link scraped off the completion page after a final submit.
    const capturedPermitNumber = clicked ? String((result as Record<string, unknown>).capturedPermitNumber || "").trim() : "";
    const capturedConfirmation = clicked ? String((result as Record<string, unknown>).capturedConfirmationNumber || "").trim() : "";
    const capturedRecordLink = clicked ? String((result as Record<string, unknown>).capturedRecordLink || "").trim() : "";
    // WHERE THE EVIDENCE LIVES. Captured on EVERY outcome, not just a successful one: a run
    // that was refused is exactly when someone needs to see the page. evidenceDir is the
    // folder of page shots; outcomeShotPath is the single picture of how the filing ended
    // (the completion page and its record number, or the refusal).
    const evidenceDir = String((result as Record<string, unknown>).evidenceDir
      ?? (result as Record<string, unknown>).debugDir ?? "").trim();
    const outcomeShotPath = String((result as Record<string, unknown>).outcomeShotPath ?? "").trim();
    // THE DRAFT THIS RUN LEFT, NAMED (dryrun-0928 B11): the reference portal-bot read off the review
    // page's URL (PowerClerk's ProjectId) goes on the draft ledger beside the launch row, and stays in
    // result_json. A URL with no record key (an Accela wizard page) is recorded as the page link only.
    const draftRef = (result as { draftReference?: { link?: string; id?: string } }).draftReference;
    if (!clicked && draftRef && (draftRef.id || draftRef.link)) {
      annotateDraft(projectId, String(draftRef.id || draftRef.link), `${track ?? "permit"} staging run ${runId}${draftRef.id ? " — the portal's own reference" : " — review page link (its URL carries no record key)"}`);
    }
    // WHICH RECIPE DROVE THIS RUN, AND WHO IT WAS LEARNED FOR — on the run row (result_json), in
    // the stage line and on the submission, so the operator reviewing the staged application
    // knows it was filled from another jurisdiction's recipe.
    const borrowedRecord = borrowed && runActorLabel === "RecipeAdapter"
      ? {
        recipeId: borrowed.recipe.id, recipeVersion: borrowed.recipe.version, learnedFor: borrowed.learnedFor,
        learnedForState: borrowed.learnedForState, portalHost: borrowed.portalHost, recordType: borrowed.recordType,
        discipline: borrowed.discipline,
      }
      : undefined;
    const borrowedNote = borrowedRecord
      ? ` Filled from the ${borrowedRecord.learnedFor} ${borrowedRecord.discipline} recipe (record type "${borrowedRecord.recordType}", same portal ${borrowedRecord.portalHost}) — check every jurisdiction-specific answer before submitting.`
        + (replayBinding ? describeReplayBinding(replayBinding) : "")
      : (replayBinding ? describeReplayBinding(replayBinding) : "");
    const runSeconds = (() => {
      const started = Date.parse(ts);
      return Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0;
    })();
    const runStatus = outcome.status;
    // SELF-HEAL: a failed/paused STAGING run produces the same debug bundle the
    // learn path already triages automatically — enqueue the triage agent here
    // too so production staging failures get root-caused (and safe fixes applied)
    // without an operator manually opening the bundle. Best-effort, opt out with
    // RUN_TRIAGE=off; the enqueue self-kicks the worker.
    try {
      const debugDir = String((result as Record<string, unknown>).debugDir ?? "");
      const gapMissing = Array.isArray((result as Record<string, unknown>).gapFillMissing) && ((result as Record<string, unknown>).gapFillMissing as unknown[]).length > 0;
      if ((runStatus === "failed" || pauseReason || gapMissing) && debugDir && process.env.RUN_TRIAGE !== "off") {
        const triageRunId = debugDir.split(/[\\/]/).filter(Boolean).pop() || "";
        if (triageRunId) {
          void import("./jobQueue").then(({ enqueueJob }) => {
            enqueueJob(db, "run_triage", { runId: triageRunId }, { projectId, priority: 3 });
          }).catch(() => null);
        }
      }
    } catch { /* triage is best-effort */ }
    if (clicked) {
      addAuditLog(db, projectId, "portal_bot", runActorLabel, "portal.auto_submitted", {
        track: track ?? "permit", runId, finalSubmitClickedByAutomation: true, feePaymentAutomated: false,
        outcome: outcome.submissionVerdict, runStatus,
        // Who approved THIS run (null when a click happened without one — which the gate forbids,
        // and which is recorded here all the same: a click is a fact, not a permission).
        approvedBy: runApproval?.approver ?? null,
      });
    }

    // Tag the run + submission with the track being staged so each filing (NEM,
    // building, electrical, combo) shows separately in the submittal-tracks panel.
    const permitTypeTag = track ?? "permit";
    const submissionType = track === "nem" ? "interconnection" : "permit";
    const trackLabelText = track ? `${permitTypeTag.toUpperCase()} ` : "";

    // The self-seed/learn can run for minutes (a live browser pass); the project may be deleted or
    // reset during that window. Fail cleanly if it vanished (deleteProject also removed the run row).
    if (!db.get<{ id?: string }>("SELECT id FROM projects WHERE id = ?", [projectId])) {
      throw new HttpError(409, "The project was deleted or reset while the portal run was in progress, so the run could not be recorded. Re-create the project and re-stage. (Any browser the bot opened may still be at the portal.)");
    }

    db.transaction(() => {
      // The row inserted as 'running' before the adapter started — finished here, by the derived
      // outcome (the only writer of a stage run's final status).
      db.run(
        `UPDATE portal_runs SET status = ?, finished_at = ?, error_message = ?, human_action_required = ?,
           screenshots_path = ?, logs_path = ?, result_json = ?, pause_reason = ?
         WHERE id = ?`,
        [runStatus, nowIso(), failureMessage || (pauseReason ? pausedRunSentence(pauseReason, result) : ""), 1,
          // A FILE, never a folder: /portal-runs/:id/review-screenshot sendFile()s this column.
          outcomeShotPath,
          // logs_path: the learn-run debug bundle folder (set by the self-seed path) — links a
          // failed/paused run straight to its forensic artifacts under data/learn-runs/.
          String((result as Record<string, unknown>).debugDir ?? ""),
          // Persist WHICH adapter actually drove this run — the autopilot approve path
          // must never mock-submit a run that a real adapter staged (see autopilot.ts).
          // packagedDocTypes: WHAT THIS DRAFT WAS HANDED (the track-scoped payload) — Approve judges a
          // draft by it (draftDocumentGaps), never by what is on disk later (gates-proper C1).
          asJson({ ...result, actor: runActorLabel, harnessAbort: outcome.harnessAbort || undefined, submissionVerdict: outcome.submissionVerdict ?? undefined, borrowedRecipe: borrowedRecord, packagedDocTypes: Object.keys(docsByType) }),
          pauseReason, runId],
      );

      db.run(
        `INSERT INTO submissions
          (id, project_id, portal_profile_id, submission_type, permit_type, status, application_number, permit_number,
           confirmation_number, submitted_at, submitted_by, screenshots_path, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          submissionId,
          projectId,
          safePortalProfileId,
          submissionType,
          permitTypeTag,
          outcome.submissionStatus,
          "",
          capturedPermitNumber,
          capturedConfirmation,
          clicked ? ts : null,
          // A CLICK THAT SENT NOTHING IS NOT A FILING BY AUTOMATION (portal-run-close-2 M3): the
          // bot's network backstop reports whether the approved click's request reached the portal.
          clicked
            ? ((result as Record<string, unknown>).finalSubmitRequestSent === false
              ? `automation clicked the approved final submit (approved by ${runApproval?.approver || "no recorded approver"}) — NO filing request reached the portal`
              : `automation (final submit approved by ${runApproval?.approver || "no recorded approver"})`)
            : "",
          evidenceDir,
          clicked
            // WHAT WAS FILED, WHEN, AND WHERE THE PROOF IS — on the record itself, so a
            // completed run can be verified without reading a log. The elapsed time is the
            // measured cost of one replay: what a filing takes when nobody has to watch it.
            ? (acceptedFiling
              ? `${trackLabelText}${portalLabel} submitted by automation after a named approval (application submit only; no fee payment).`
                + `${capturedPermitNumber ? ` Record ${capturedPermitNumber}.` : ""}`
                + ` Confirmed ${nowIso()}${runSeconds ? ` after ${runSeconds}s` : ""}.`
                + `${outcomeShotPath ? ` Completion page: ${outcomeShotPath}` : ""}`
              : `${trackLabelText}${portalLabel}: automation CLICKED the final submit, and the portal did not confirm the filing`
                + ` (${outcome.submissionVerdict ?? "unknown"}). Verify on the portal whether it was filed before anything is staged or clicked again.`
                + `${outcomeShotPath ? ` Page: ${outcomeShotPath}` : ""}`)
            : pauseReason
              ? `${trackLabelText}${portalLabel} run PAUSED for a human: ${pausedRunSentence(pauseReason, result)}`
              : adapterFailed
                ? `${trackLabelText}${portalLabel} run FAILED before review — nothing was staged on the portal. ${failureMessage}`
                : `${trackLabelText}${portalLabel} staged to final review only. Automation did not click final submit.${borrowedNote}`,
          ts,
        ],
      );

      db.run("UPDATE projects SET status = ?, current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
        // On failure, an MFA/CAPTCHA pause, or an UNCONFIRMED click, leave the project in its prior
        // status — never advance it to awaiting_human_submit for a run that staged nothing, and never
        // to 'submitted' on a filing the portal did not confirm (the submissions row and the
        // duplicate guard carry the click).
        acceptedFiling ? "submitted" : (pauseReason || adapterFailed || clicked) ? detail.project.status : "awaiting_human_submit",
        clicked
          ? (acceptedFiling
            ? `${trackLabelText}${portalLabel} submitted by automation (approved run)${capturedPermitNumber ? ` — record ${capturedPermitNumber}` : ""}. Tracking status.`
            : `${trackLabelText}${portalLabel}: final submit CLICKED by automation, not confirmed by the portal — verify on the portal before anything else.`)
          : pauseReason
            ? `${trackLabelText}${portalLabel} run paused: ${pausedRunSentence(pauseReason, result)}`
            : adapterFailed
              ? `${trackLabelText}${portalLabel} run failed — not staged. ${failureMessage}`
              : `${trackLabelText}${portalLabel} staged. Human must verify and submit manually.${borrowedNote}`,
        // THE THREE OUTCOMES A PROSE LINE COULD NEVER BE FILTERED ON. A paused run and a failed
        // run BOTH leave the status untouched at its pre-run value, so status alone cannot tell
        // an operator that anything happened — before this column, the only difference between
        // "finish the MFA challenge in the browser that is still open" and "the adapter died,
        // retry" was a sentence.
        (clicked ? "auto_submitted"
          : pauseReason ? "staging_paused"
          : adapterFailed ? "staging_failed"
          : "staged_for_review") satisfies StageDetail,
        nowIso(),
        projectId,
      ]);

      // Persist the captured permit/record number + record link onto the track's tracking
      // target so the status poller follows it and the operator sees the number + link.
      if (clicked && (capturedPermitNumber || capturedRecordLink)) {
        const tgt = db.get<Row>(
          "SELECT id FROM permit_check_targets WHERE project_id = ? AND permit_type = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1",
          [projectId, permitTypeTag],
        );
        if (tgt) {
          db.run(
            "UPDATE permit_check_targets SET permit_number = COALESCE(NULLIF(?, ''), permit_number), tracking_url = COALESCE(NULLIF(?, ''), tracking_url), updated_at = ? WHERE id = ?",
            [capturedPermitNumber, capturedRecordLink, nowIso(), text(tgt.id)],
          );
        }
        db.run("UPDATE portal_runs SET tracking_url = COALESCE(NULLIF(?, ''), tracking_url) WHERE id = ?", [capturedRecordLink, runId]);
      }

      addAuditLog(db, projectId, "portal_bot", runActorLabel,
        clicked ? "portal.final_submit_clicked" : pauseReason ? "portal.paused_for_human" : adapterFailed ? "portal.run_failed" : "portal.staged_to_review", {
          runId,
          portalProfileId,
          portalType: auditPortalType,
          adapter: runActorLabel,
          runStatus,
          finalSubmitClickedByAutomation: clicked,
          ...(adapterFailed ? { failureReason: failureMessage, harnessAbort: outcome.harnessAbort } : {}),
          mustShowAhjPreviewWindow: reviewerReport.finalSubmitGate.mustShowAhjPreviewWindow,
          finalSubmitButtonAloneIsEnough: reviewerReport.finalSubmitGate.finalSubmitButtonAloneIsEnough,
        });
    });

  } catch (err) {
    // Recording the outcome failed. The row must not stay 'running': this process is alive, so
    // the next stage of the track would read it as a run in flight and refuse forever.
    try {
      db.run("UPDATE portal_runs SET status = 'failed', finished_at = ?, error_message = ? WHERE id = ? AND status = 'running'",
        [nowIso(), `Recording the run outcome failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`, runId]);
    } catch { /* the original error is the one to surface */ }
    throw err;
  }
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

// Pre-fill a suggested value onto pending human-review items (e.g. an AI equipment-spec
// lookup). The value lands in the review box for a human to approve — never auto-applied.
export function suggestReviewValues(db: AppDb, projectId: string, suggestions: Record<string, string>): number {
  let applied = 0;
  for (const [fieldName, value] of Object.entries(suggestions)) {
    if (!value) continue;
    const existing = db.get<{ id: string }>(
      "SELECT id FROM human_review_items WHERE project_id = ? AND field_name = ? AND status = 'pending' LIMIT 1",
      [projectId, fieldName],
    );
    if (!existing) continue;
    db.run(
      "UPDATE human_review_items SET llm_suggested_value = ?, updated_at = ? WHERE project_id = ? AND field_name = ? AND status = 'pending'",
      [value, nowIso(), projectId, fieldName],
    );
    applied += 1;
  }
  return applied;
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
  // A CORRECTION REOPEN IS NOT A FIRST FILING, AND THIS DOOR MIS-STAMPS IT.
  //
  // Nothing about this function filters on run_type, and a reopen run is reachable from the
  // dashboard's confirmation form today (renderPortalRuns offers it for any `paused_for_human`
  // run, reopen runs included). Run it against one and three things go wrong: (1) a reopened
  // filing has no `awaiting_human_submit` submission — the original is already 'submitted' —
  // so the fallback below stamps the newest FAILED/paused staging row 'submitted' and blanks
  // its application/permit numbers with `input.x || ""`, minting a second submitted row that
  // resolveCorrection's own still-filed check then reads; (2) it writes `submitted_all` and
  // "Human submitted. Confirmation captured.", first-filing language for an amendment; (3) it
  // feeds learnFromSubmissionConfirmation a resubmit as if it were an original submission.
  //
  // markCorrectionResubmitted is the door for that run type. Refusing here closes the
  // mis-stamp from both sides rather than relying on the UI to offer the right button.
  if (text(run.run_type) === "correction_reopen") {
    throw new HttpError(409,
      "This is a correction-reopen run, not a new filing. Record its resubmission with Mark Resubmitted — capturing it here would stamp an older staging row as the filing.",
      { runId: portalRunId, runType: "correction_reopen" });
  }
  const projectId = text(run.project_id);
  const runPermitType = text(run.permit_type);
  const ts = nowIso();
  // The project record ensureCheckTarget needs for a new target's jurisdiction and portal
  // name. Read before the transaction — nothing inside changes these columns.
  const projectRowForTarget = db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!projectRowForTarget) throw new HttpError(404, "Project not found.");
  const projectForTarget = mapProject(projectRowForTarget);
  // THE NUMBER THAT MAKES A FILING FOLLOWABLE. The poller looks a filing up by its
  // application or permit number (runDuePermitChecks builds `applicationNumbers` from
  // exactly these two columns), so a confirmation carrying neither cannot be tracked and
  // MUST NOT have a target invented for it: an active target with no number is polled
  // forever, reads nothing, and its "no status available" is classified needs_human_review.
  // The confirmation number is deliberately NOT accepted here — a portal's receipt number
  // is not a record the status page can be searched by.
  const filingNumber = (input.applicationNumber || "").trim() || (input.permitNumber || "").trim();
  // Hoisted so the post-transaction correction close can read it — see below.
  let remainingTracks = 0;

  db.transaction(() => {
    db.run("UPDATE portal_runs SET status = ?, finished_at = ? WHERE id = ?", ["submitted", ts, portalRunId]);
    // Scope the confirmation to THIS run's permit track so a NEM submit doesn't get
    // stamped with a permit number (and vice-versa). Legacy runs with no permit_type
    // fall back to the project-wide update (old behavior) so they still capture.
    const scopeByType = Boolean(runPermitType);
    // The row that best represents this filing. Prefer the awaiting-human rows (the normal
    // capture case) — but a run whose acceptance poll expired against a slow portal records
    // its submission as FAILED, and both live PacifiCorp filings tonight did exactly that:
    // the application existed on the account while the only row for the filing run said
    // failed, and the confirmation then stamped an OLDER staging row instead. When nothing
    // is awaiting, the newest failed/paused row of the track is the filing being confirmed.
    const awaiting = db.query<Row>(
      `SELECT id, permit_type, submission_type FROM submissions WHERE project_id = ? AND status = 'awaiting_human_submit'${scopeByType ? " AND permit_type = ?" : ""}`,
      [projectId, ...(scopeByType ? [runPermitType] : [])],
    );
    const fallback = awaiting.length ? [] : db.query<Row>(
      `SELECT id, permit_type, submission_type FROM submissions WHERE project_id = ? AND status IN ('failed', 'paused_for_human', 'submitted_unconfirmed')${scopeByType ? " AND permit_type = ?" : ""}
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, ...(scopeByType ? [runPermitType] : [])],
    );
    for (const row of [...awaiting, ...fallback]) {
      db.run(
        `UPDATE submissions
         SET status = ?, application_number = ?, permit_number = ?, confirmation_number = ?, submitted_at = ?, submitted_by = ?, notes = ?
         WHERE id = ?`,
        [
          "submitted",
          input.applicationNumber || "",
          input.permitNumber || "",
          input.confirmationNumber || "",
          ts,
          input.submittedBy || "human",
          input.notes || "Captured after human completed final portal submit.",
          text(row.id),
        ],
      );
    }
    // Only advance the whole-project status to "submitted" when there are no OTHER
    // tracks still awaiting a human submit — otherwise a single-track confirmation would
    // mark the entire project submitted while the other filing is still pending. While
    // tracks remain, the project STAYS awaiting_human_submit (not a pre-stage status):
    // the autopilot approval gate keys on that status, so a pre-stage value would hide
    // the remaining filings' Approve & Submit gate from the panel.
    const stillAwaiting = db.get<{ n: number }>(
      // COUNT TRACKS, NOT ROWS. Re-staging a track APPENDS another awaiting_human_submit
      // row rather than superseding the last one, so one filing that was staged four times
      // counts as four outstanding filings. Measured live: Ivy 720b05f3 shows 5 rows for 2
      // real tracks (4x interconnection/nem + 1x permit/building); Fixture cf1c56aa shows 9 rows
      // for 1 track. A row-count here made "are all tracks in?" unanswerable and left the
      // correction closer permanently waiting on filings that do not exist.
      "SELECT COUNT(*) AS n FROM (SELECT status, ROW_NUMBER() OVER (PARTITION BY submission_type, COALESCE(permit_type, '') ORDER BY created_at DESC, id DESC) AS rn FROM submissions WHERE project_id = ?) WHERE rn = 1 AND status = 'awaiting_human_submit'",
      [projectId],
    );
    const remaining = Number(stillAwaiting?.n ?? 0);
    remainingTracks = remaining;

    // SCHEDULE THE FILING FOR CHECKING — the step this function never took.
    //
    // captureConfirmation created no permit_check_targets row, so a filing confirmed
    // through the normal panel was never polled again. On the live database the operator
    // closed that gap by hand every time: Ann's building confirmation at 16:42:00 is
    // followed by an operator-typed permit_target.created at 16:43:05, the electrical one
    // at 19:10:07 by another at 19:10:16, and the NEM one at 23:02:11 by another at
    // 23:03:47. Three filings, three manual re-entries of a number the confirmation form
    // had already collected.
    //
    // Inside the transaction on purpose: this is plain SQL (no LLM, no network), and
    // whether a target exists decides the stage_detail written two statements below —
    // the two facts must not be able to disagree.
    const stamped = [...awaiting, ...fallback][0];
    // Which track this filing belongs to. The run's own permit_type is authoritative;
    // legacy runs carry none, so fall back to the submission row this confirmation just
    // stamped (its submission_type distinguishes an interconnection from a permit).
    const trackKey = runPermitType
      || text(stamped?.permit_type)
      || (text(stamped?.submission_type) === "interconnection" ? "nem" : "");
    const ensured = filingNumber
      ? ensureCheckTarget(db, projectForTarget, {
          track: SUBMITTAL_TRACK_TYPES.includes(trackKey as SubmittalTrackType) ? (trackKey as SubmittalTrackType) : undefined,
          targetType: trackKey === "nem" ? "nem" : "permit",
          permitType: trackKey,
          applicationNumber: input.applicationNumber,
          permitNumber: input.permitNumber,
          notes: "Tracking a filing a human confirmed from the dashboard.",
          // Due on the very next sweep. A filing was just made; waiting out a full
          // check_frequency_days window before the first read is a week of silence.
          nextCheckAt: ts,
        })
      : undefined;

    db.run("UPDATE projects SET status = ?, current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
      remaining > 0 ? "awaiting_human_submit" : "submitted",
      // AN UNKNOWN MUST NOT READ AS REASSURANCE. The untracked wording is deliberately the
      // operator's next action, not an apology.
      ensured
        ? (remaining > 0 ? `One filing submitted; ${remaining} track(s) still awaiting human submit.` : "Human submitted. Confirmation captured.")
        : (remaining > 0
            ? `One filing submitted with no application number, so it is NOT being tracked; ${remaining} track(s) still awaiting human submit.`
            : "Human submitted, but the confirmation carried no application or permit number — this filing is NOT being tracked. Add it under Permit/NEM Checks."),
      // A part-filed project sits in awaiting_human_submit exactly like one that has filed
      // nothing at all — the status cannot say "one of two is in". This can.
      //
      // `submitted_untracked` OUTRANKS partial/all, and that ordering is the point: the chip
      // answers "what is waiting on you", and an unpolled filing is the actionable unknown.
      // How many tracks remain is still answerable from the tracks panel, which reads the
      // submissions rows directly; whether anything is watching this filing was answerable
      // NOWHERE before this value existed.
      (!ensured ? "submitted_untracked" : remaining > 0 ? "submitted_partial" : "submitted_all") satisfies StageDetail,
      ts,
      projectId,
    ]);
    addAuditLog(db, projectId, "human", input.submittedBy || "dashboard", "submission.confirmation_captured", {
      portalRunId,
      applicationNumber: input.applicationNumber || "",
      permitNumber: input.permitNumber || "",
      confirmationNumber: input.confirmationNumber || "",
    });
    // A SECOND ROW, because the audit panel renders the ACTION NAME and nothing else. The
    // stage_detail chip is overwritten by the next thing that happens to this project; this
    // row is permanent, so "nobody is watching filing X" survives in the record.
    addAuditLog(
      db, projectId, "system", "permit monitor",
      ensured
        ? (ensured.created ? "permit_target.created" : "permit_target.updated")
        : "submission.confirmed_untracked",
      ensured
        ? { targetId: ensured.targetId, matchedOn: ensured.matchedOn, via: "capture_confirmation", portalRunId, permitType: trackKey }
        : {
            portalRunId,
            permitType: trackKey,
            why: "the confirmation carried no application or permit number, so there is nothing for the monitor to look up — this filing is not being checked",
          },
    );
  });

  // THE RESUBMISSION HAS NOW ACTUALLY GONE OUT — close the corrections it answers.
  //
  // resolveOpenCorrectionsOnResubmit had ZERO callers while its own header and
  // resolveCorrection's both claimed prepareSubmission called it. So a corrected package
  // was re-filed and its corrections stayed open forever unless an operator hit
  // POST /api/corrections/:id/resolve by hand — and every surface filtering on
  // `!closedAt && !resubmitted` (openCorrectionCount, the permit and NEM lanes, the action
  // queue) went on telling the operator to "resolve AHJ corrections before resubmittal" on
  // a job already resubmitted, while the cycle-time KPI that needs resubmitted=1 never
  // completed.
  //
  // OUTSIDE the transaction on purpose: the human's confirmation capture is the more
  // precious fact, and a throw in here must not roll it back. It also runs AFTER the
  // project status update, so resolveCorrection's own correction-state transition sees
  // "submitted" and leaves the status alone.
  //
  // Gated on remainingTracks === 0 — corrections are project-grained (no track column), so
  // closing them while another staged filing is still awaiting a human submit could close
  // one that belongs to THAT filing. A no-op on a first submission: nothing is open.
  if (remainingTracks === 0) {
    try {
      const closed = resolveOpenCorrectionsOnResubmit(db, projectId);
      if (closed > 0) {
        addAuditLog(db, projectId, "system", "correction", "correction.closed_on_resubmit", { portalRunId, closed });
      }
    } catch (err) {
      logger.warn("correction", "confirmed resubmission could not close its open corrections", {
        projectId, portalRunId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const detail = getProjectDetail(db, projectId);
  learnFromSubmissionConfirmation(db, detail.project, input);
  return getProjectDetail(db, projectId);
}

export interface CorrectionResubmitResult {
  /** How many corrections this action closed (resubmitted=1 + closed_at). */
  closedCorrections: number;
  /** Corrections STILL open afterwards — the honest read, counted from the database. */
  correctionsStillOpen: number;
  /** Did a tracking target get its next_check_at pulled forward? False is a real answer. */
  checkTargetRefreshed: boolean;
  /** Other tracks still awaiting a human submit; >0 keeps the project at awaiting_human_submit. */
  remainingTracks: number;
  /** The project's status after the action — unchanged if it had moved somewhere unrelated. */
  projectStatus: string;
  message: string;
  detail: ProjectDetail;
}

/**
 * "MARK RESUBMITTED" — the human's own record that a reopened correction form was actually
 * resubmitted in the portal. THE SIBLING OF captureConfirmation, NOT AN EXTENSION OF IT.
 *
 * WHY A SIBLING (the spot-check that was mandated before writing this). captureConfirmation
 * filters on nothing but the run id, so it WOULD have accepted a `correction_reopen` run, and
 * three of its steps are wrong for one: it stamps a submissions row (falling back to the newest
 * FAILED/paused staging row when nothing is awaiting, and blanking that row's numbers with
 * `input.x || ""`) — a reopened filing has no awaiting row because the original is already
 * 'submitted'; it writes `submitted_all` + first-filing prose for what is an amendment; and it
 * calls learnFromSubmissionConfirmation, teaching the KB from a resubmit as if it were an
 * original submission. captureConfirmation now REFUSES this run type with a 409 pointing here.
 *
 * THIS FUNCTION WRITES NO submissions ROWS AT ALL, and that is why "thin" is safe: the
 * application never stopped existing — the utility/AHJ reopened it, the operator amended it in
 * place, and its submissions row has said 'submitted' the whole time. The record of the
 * resubmission is the corrections themselves (closed_at + resubmitted=1, which is what the
 * cycle-time KPI and every "open correction" surface read) plus the audit row.
 *
 * HARD RULE 1: this is a HUMAN ACTION and nothing else calls it. Automation never clicks the
 * portal's resubmit and never asserts that a person did — the reopen stops at the review screen
 * and this route exists because only the operator can say what happened next.
 *
 * Closing is deliberately attached to the RESUBMIT event, never to the reopen: opening a form
 * is not evidence anything was filed.
 */
export function markCorrectionResubmitted(
  db: AppDb,
  portalRunId: string,
  input: { submittedBy?: string; confirmationNumber?: string; notes?: string } = {},
): CorrectionResubmitResult {
  const run = db.get<Row>("SELECT * FROM portal_runs WHERE id = ?", [portalRunId]);
  if (!run) throw new HttpError(404, "Portal run not found.");
  if (text(run.run_type) !== "correction_reopen") {
    throw new HttpError(409,
      "That portal run is not a correction reopen. A new filing's submission is recorded with Capture Confirmation.",
      { runId: portalRunId, runType: text(run.run_type) });
  }
  const runStatus = text(run.status);
  if (runStatus !== "awaiting_human_resubmit") {
    // A reopen that PAUSED (MFA/CAPTCHA) or FAILED staged nothing, so there is no reopened
    // application for the operator to have resubmitted. If they finished it by hand anyway,
    // the manual door is still open: POST /api/corrections/:id/resolve with resubmitted:true.
    throw new HttpError(409,
      runStatus === "submitted"
        ? "This reopened correction has already been recorded as resubmitted."
        : `This reopen run is "${runStatus}", not awaiting a human resubmit — nothing was staged for you to resubmit. If you corrected and resubmitted the filing by hand, resolve the correction directly (marking it resubmitted).`,
      { runId: portalRunId, runStatus });
  }
  const projectId = text(run.project_id);
  const ts = nowIso();

  // The tracking target this reopen was bound to, recorded on the run itself at reopen time.
  let boundTargetId = "";
  try {
    const parsed = JSON.parse(text(run.result_json) || "{}") as Record<string, unknown>;
    boundTargetId = typeof parsed.targetId === "string" ? parsed.targetId : "";
  } catch { boundTargetId = ""; }

  let remainingTracks = 0;
  let checkTargetRefreshed = false;
  let statusMoved = false;
  let statusBefore = "";

  db.transaction(() => {
    db.run("UPDATE portal_runs SET status = ?, finished_at = ?, human_action_required = 0, confirmation_number = ? WHERE id = ?", [
      "submitted", ts, input.confirmationNumber || text(run.confirmation_number), portalRunId,
    ]);

    // Same remaining-tracks rule captureConfirmation applies, for the same reason (:6973):
    // corrections carry no track (project_id only), so closing them while ANOTHER staged
    // filing still awaits a human submit could close one that belongs to that filing. When a
    // track is still out, this writes NO project status at all — the project keeps the state
    // the reopen left it in (awaiting_human_resubmit) because the other filing genuinely has
    // not gone out — and the close waits; it converges when captureConfirmation confirms that
    // track and runs the same closer.
    const stillAwaiting = db.get<{ n: number }>(
      // Same track-not-row rule as captureConfirmation above, for the same reason.
      "SELECT COUNT(*) AS n FROM (SELECT status, ROW_NUMBER() OVER (PARTITION BY submission_type, COALESCE(permit_type, '') ORDER BY created_at DESC, id DESC) AS rn FROM submissions WHERE project_id = ?) WHERE rn = 1 AND status = 'awaiting_human_submit'", [projectId],
    );
    remainingTracks = Number(stillAwaiting?.n ?? 0);

    statusBefore = text(db.get<Row>("SELECT status FROM projects WHERE id = ?", [projectId])?.status);
    // NEVER CLOBBER AN UNRELATED STATUS. The normal path arrives here from
    // `awaiting_human_resubmit` (what the reopen wrote); the two correction states are
    // included because a fresh correction can land between the reopen and the operator's
    // click. A project the monitor has since moved to `issued` is NOT rewound to `submitted`
    // by a bookkeeping action — the corrections still close, and the skip is audited.
    // `ready_to_resubmit` belongs here too: a project whose correction resolved with
    // nothing on file lands there (Round B1), and the resubmission an operator then
    // sends is exactly the event this records. Leaving it out meant the board never
    // recovered from the state B1 had just introduced.
    if (remainingTracks === 0 && ["awaiting_human_resubmit", "ready_to_resubmit", "correction_received", "correction_triaged"].includes(statusBefore)) {
      db.run("UPDATE projects SET status = 'submitted', current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
        "Resubmitted by a person in the portal. Awaiting review.",
        "correction_resubmitted" satisfies StageDetail,
        ts, projectId,
      ]);
      statusMoved = true;
    }

    // REFRESH THE EXISTING TARGET — never create one. Pull next_check_at forward to now so the
    // next monitor sweep reads the resubmitted filing instead of waiting out the remainder of
    // its check_frequency_days window. last_checked_at and latest_outcome are deliberately NOT
    // touched: nothing was checked, and claiming otherwise would age a reading that never
    // happened.
    //
    // ROUND C SEAM: target CREATION is Round C's (extract ensureCheckTarget from
    // submittalTracks.ts:480 and call it from captureConfirmation). This site reuses whatever
    // exists and reports `checkTargetRefreshed:false` when nothing does — when C lands, a
    // filing confirmed normally will already have a target here and this stays a refresh.
    const boundTarget = boundTargetId
      ? db.get<Row>("SELECT id FROM permit_check_targets WHERE id = ? AND project_id = ? AND active = 1", [boundTargetId, projectId])
      : undefined;
    const fallbacks = boundTarget ? [] : db.query<Row>(
      "SELECT id FROM permit_check_targets WHERE project_id = ? AND active = 1 AND application_number != ''", [projectId],
    );
    // Exactly one, or none: with two tracked filings and no recorded binding, refreshing the
    // wrong one would poll a filing that did not change and leave the one that did.
    const targetId = boundTarget ? text(boundTarget.id) : fallbacks.length === 1 ? text(fallbacks[0].id) : "";
    if (targetId) {
      db.run("UPDATE permit_check_targets SET next_check_at = ?, updated_at = ? WHERE id = ?", [ts, ts, targetId]);
      checkTargetRefreshed = true;
    }

    addAuditLog(db, projectId, "human", input.submittedBy || "dashboard", "correction.resubmit_recorded", {
      portalRunId,
      confirmationNumber: input.confirmationNumber || "",
      notes: (input.notes || "").slice(0, 300),
      checkTargetRefreshed,
      targetId,
      remainingTracks,
      statusFrom: statusBefore,
      statusMoved,
      finalSubmitClickedByAutomation: false,
    });
  });

  // THE RESUBMISSION HAS GONE OUT — close the corrections it answers, through the ONE closer.
  // Outside the transaction for captureConfirmation's reason (:6968): the human's own record
  // is the more precious fact and a throw in here must not roll it back. It also runs after
  // the status write, so resolveCorrection sees a project that is no longer in a correction
  // state and leaves the status alone.
  let closedCorrections = 0;
  if (remainingTracks === 0) {
    try {
      closedCorrections = resolveOpenCorrectionsOnResubmit(db, projectId);
      if (closedCorrections > 0) {
        addAuditLog(db, projectId, "system", "correction", "correction.closed_on_resubmit", { portalRunId, closed: closedCorrections });
      }
    } catch (err) {
      logger.warn("correction", "recorded resubmission could not close its open corrections", {
        projectId, portalRunId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // COUNTED FROM THE DATABASE, NOT INFERRED from the closer's return: a close that threw
  // half-way has to surface as a number the operator can see, not a swallowed warning. Same
  // filter every "open correction" surface uses (openCorrectionCount, both lanes, the action
  // queue) so this answer and theirs cannot disagree.
  const correctionsStillOpen = Number(db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM corrections WHERE project_id = ? AND closed_at IS NULL AND resubmitted = 0", [projectId],
  )?.n ?? 0);

  const detail = getProjectDetail(db, projectId);
  const parts = [
    closedCorrections > 0
      ? `Recorded the resubmission and closed ${closedCorrections} correction${closedCorrections === 1 ? "" : "s"}.`
      : "Recorded the resubmission.",
  ];
  if (remainingTracks > 0) parts.push(`${remainingTracks} other filing(s) still await a human submit, so the open corrections stay open until those are confirmed.`);
  if (correctionsStillOpen > 0 && remainingTracks === 0) parts.push(`${correctionsStillOpen} correction(s) are still open — resolve them from the corrections panel.`);
  if (!statusMoved) parts.push(`The project status stayed "${statusBefore}" — this action never overwrites a status it did not set.`);
  parts.push(checkTargetRefreshed
    ? "The filing's tracking check was pulled forward to the next monitor sweep."
    : "No tracked filing could be refreshed, so the monitor will NOT pick this resubmission up — add the filing (with its application number) under Permit/NEM Checks.");

  return {
    closedCorrections,
    correctionsStillOpen,
    checkTargetRefreshed,
    remainingTracks,
    projectStatus: detail.project.status,
    message: parts.join(" "),
    detail,
  };
}
