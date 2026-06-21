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
  | "nem_approved"
  | "handoff_ready"
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
  | "nem_approved"
  | "needs_human_review"
  | "no_change";

export type ParserPayload = Record<string, unknown>;

export interface ClientPortalIdentity {
  id: string;
  clientId: string;
  portalType: string;
  installerCompanyLabel: string;
  installerContactCode: string;
  notes: string;
  createdAt: string;
}

export interface ClientRecord {
  id: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  phone: string;
  billingStatus: string;
  notes: string;
  // Contractor licensing & business identity
  legalBusinessName: string;
  dba: string;
  ccbLicenseNumber: string;
  ccbExpiration: string;
  electricalLicenseNumber: string;
  // Metro/city contractor license (e.g. Portland Metro), and the supervising
  // electrician's own personal license — distinct from the company electrical
  // contractor license above. Many AHJ permit forms require all three.
  metroCityLicenseNumber: string;
  electricalSupervisorName: string;
  electricianLicenseNumber: string;
  businessAddress: string;
  businessCity: string;
  businessState: string;
  businessZip: string;
  businessPhone: string;
  businessEmail: string;
  ein: string;
  bondCarrier: string;
  insuranceCarrier: string;
  authorizedSignerName: string;
  authorizedSignerTitle: string;
  portalIdentities: ClientPortalIdentity[];
  createdAt: string;
}

export interface ProjectRecord {
  id: string;
  clientId: string | null;
  homeownerName: string;
  projectAddress: string;
  city: string;
  state: string;
  zip: string;
  ahj: string;
  utility: string;
  accountNumber: string;
  meterNumber: string;
  systemSizeDcKw: number | null;
  systemSizeAcKw: number | null;
  totalExportKw: number | null;
  interconnectionMethod: string;
  status: ProjectStatus;
  currentStage: string;
  parserConfidenceSummary: string;
  parserSnapshot: ParserPayload;
  assignedUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListItem extends Omit<ProjectRecord, "parserSnapshot"> {
  qcFailCount: number;
  qcWarningCount: number;
  pendingReviewCount: number;
  correctionCount: number;
  latestPortalStatus: PortalRunStatus | null;
  latestPermitLabel: string | null;
  latestPermitOutcome: PermitCheckOutcome | null;
  latestPermitCheckedAt: string | null;
  readyForIssue: boolean;
  latestNemLabel: string | null;
  latestNemOutcome: PermitCheckOutcome | null;
  latestNemCheckedAt: string | null;
  nemApproved: boolean;
  overdueCorrections: number;
  // Pipeline stage (computed from status by backend/src/projectStage.ts) so the
  // dashboard can render the stepper/board without duplicating the lifecycle map.
  stageKey: string;
  stageIndex: number;
  stageLabel: string;
  stageCount: number;
  isBlocked: boolean;
}

export interface QcResult {
  id: string;
  projectId: string;
  qcStatus: QcStatus;
  ruleId: string;
  ruleName: string;
  message: string;
  severity: Severity;
  createdAt: string;
}

export interface HumanReviewItem {
  id: string;
  projectId: string;
  issueType: string;
  fieldName: string;
  parserValue: string;
  llmSuggestedValue: string;
  sourceExcerpt: string;
  status: HumanReviewStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface CorrectionRecord {
  id: string;
  projectId: string;
  source: "email" | "portal" | "manual";
  correctionText: string;
  correctionBucket: CorrectionBucket;
  rootCause: string;
  requiredAction: string;
  assignedTo: string;
  draftResponse: string;
  humanApproved: boolean;
  resubmitted: boolean;
  newRuleRecommended: boolean;
  createdAt: string;
  closedAt: string | null;
  dueAt: string | null;
  slaDays: number;
  daysOpen: number;
  isOverdue: boolean;
}

export interface PortalRun {
  id: string;
  projectId: string;
  portalProfileId: string | null;
  runType: string;
  status: PortalRunStatus;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string;
  humanActionRequired: boolean;
  screenshotsPath: string;
  logsPath: string;
}

export interface SubmissionRecord {
  id: string;
  projectId: string;
  portalProfileId: string | null;
  submissionType: "permit" | "interconnection" | "correction" | "revision";
  status: "staged" | "awaiting_human_submit" | "submitted" | "failed" | "approved";
  applicationNumber: string;
  permitNumber: string;
  confirmationNumber: string;
  submittedAt: string | null;
  submittedBy: string;
  screenshotsPath: string;
  notes: string;
}

export interface PermitCheckTarget {
  id: string;
  projectId: string;
  jurisdiction: string;
  portalName: string;
  portalUrl: string;
  applicationNumber: string;
  permitNumber: string;
  checkFrequencyDays: number;
  active: boolean;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  latestOutcome: PermitCheckOutcome | null;
  latestStatusLabel: string;
  notes: string;
  targetType: "permit" | "nem";
  createdAt: string;
  updatedAt: string;
}

export interface PermitStatusCheck {
  id: string;
  projectId: string;
  targetId: string | null;
  source: PermitCheckSource;
  rawStatusText: string;
  statusLabel: string;
  outcome: PermitCheckOutcome;
  confidence: number;
  correctionId: string | null;
  reviewedByAhj: boolean;
  readyForIssue: boolean;
  issueFeeDue: boolean;
  applicationNumber: string;
  permitNumber: string;
  message: string;
  createdAt: string;
}

export interface ApplicationRequirementProfile {
  id: string;
  name: string;
  matchJurisdictions: string[];
  portalName: string;
  sourceUrl: string;
  requiresAhjApplication: boolean;
  requiresStructuralApplication: boolean;
  requiresElectricalApplication: boolean;
  requiresPrescriptiveChecklist: boolean;
  requiresBidSheet: boolean;
  requiresPortalEntryOnly: boolean;
  requiredDocuments: string[];
  notes: string[];
}

export interface GeneratedApplicationDocument {
  id: string;
  title: string;
  required: boolean;
  documentType: "cover" | "manifest" | "ahj_application" | "structural_application" | "electrical_application" | "checklist" | "utility_application" | "worksheet";
  fileName: string;
  markdown: string;
}

export interface ApplicationDocumentPackage {
  projectId: string;
  profile: ApplicationRequirementProfile;
  generatedAt: string;
  docs: GeneratedApplicationDocument[];
  missingFields: string[];
  html: string;
  /** When the knowledge base has a learned profile for this AHJ, its real
   *  required-document list + portal (so the PM isn't relying on the generic fallback). */
  learnedRequirements?: {
    ahj: string;
    utility: string;
    portalName: string;
    portalUrl: string;
    requiredDocuments: string[];
    confidence: string;
    correctionCount: number;
  };
}

export interface AhjProcessProfile {
  state: string;
  ahj: string;
  submissionMethod: string;
  timeline: string;
  requiresElectricianSign: boolean;
  requiresElectricalStamp: boolean;
  requiresStructuralStamp: boolean;
  requiresElectricalPermitApplication: boolean;
  requiresBuildingPermitApplication: boolean;
  requiresSolarChecklist: boolean;
  requiresPlanSet: boolean;
  requiresUtilityApproval: boolean;
  requiresCustomerSignature: boolean;
  requiresFloodplainCheck: boolean;
  requiresJurisdictionCheck: boolean;
  otherRequirements: string;
  reviewerNotes: string;
  sourceSheet: string;
}

export interface CodeReference {
  code: string;
  section: string;
  title: string;
  adoptionScope: string;
  sourceUrl: string;
  note: string;
}

export type ReviewerEvidenceStatus = "verified" | "weak" | "missing" | "profile" | "not_applicable";

export interface ReviewerFindingEvidence {
  kind: "source_excerpt" | "absence_check" | "field_value" | "process_profile" | "screenshot_placeholder";
  label: string;
  source: string;
  excerpt: string;
  confidence: "high" | "medium" | "low";
  pageHint: string;
  screenshotPath: string;
  verifier: "parser" | "normalized_field" | "rule_engine" | "ahj_profile" | "llm";
  note: string;
}

export interface ReviewerFinding {
  id: string;
  severity: "blocker" | "warning" | "callout" | "pass";
  category: "project_data" | "ahj_profile" | "plan_set" | "utility_nem" | "structural" | "electrical" | "portal" | "installer";
  title: string;
  message: string;
  cityFeedback: string;
  designTeamAction: string;
  evidenceNeeded: string[];
  codeReferences: CodeReference[];
  installerCallout: boolean;
  evidenceStatus?: ReviewerEvidenceStatus;
  evidenceFound?: ReviewerFindingEvidence[];
}

export interface FinalSubmitGate {
  mustShowAhjPreviewWindow: boolean;
  finalSubmitButtonAloneIsEnough: boolean;
  requirements: string[];
}

export interface ReviewerReport {
  projectId: string;
  generatedAt: string;
  matchedProcessProfile: AhjProcessProfile | null;
  findings: ReviewerFinding[];
  installerCallouts: ReviewerFinding[];
  finalSubmitGate: FinalSubmitGate;
}

export interface KnowledgeSource {
  label: string;
  url: string;
  sourceType: "official" | "sanitized_reference" | "learned_project" | "learned_correction" | "learned_permit_status" | "learned_batch_import" | "ai_researched";
  observedAt: string;
}

export interface CommonCorrectionPattern {
  signature: string;
  bucket: CorrectionBucket;
  rootCause: string;
  requiredAction: string;
  count: number;
  lastSeenAt: string;
  sample: string;
}

export interface PermitUtilityKnowledgeProfile {
  id: string;
  profileKey: string;
  state: string;
  ahj: string;
  utility: string;
  portalName: string;
  portalUrl: string;
  /** Underlying portal platform (Accela, ProjectDox, EnerGov…) — drives Playwright automation reuse. */
  portalPlatform: string;
  /** How submittals are made (online portal, email, in-person, combination). */
  submissionMethod: string;
  requiredDocuments: string[];
  averageTimelineDays: number | null;
  timelineSampleCount: number;
  timelineNotes: string[];
  commonCorrections: CommonCorrectionPattern[];
  projectCount: number;
  correctionCount: number;
  confidence: "seeded" | "learned" | "mixed";
  sources: KnowledgeSource[];
  notes: string;
  firstSeenAt: string;
  lastLearnedAt: string;
  updatedAt: string;
}

export interface HistoricalFailureCause {
  signature: string;
  title: string;
  count: number;
  correctionBucket: CorrectionBucket | "";
  rootCause: string;
  requiredAction: string;
  sample: string;
  severity: "blocker" | "warning" | "callout";
}

export interface HistoricalChecklistItem {
  id: string;
  status: "present" | "missing" | "needs_review";
  title: string;
  why: string;
  action: string;
  evidence: string[];
  sourceCauseSignature: string | null;
}

export interface HistoricalFailureReport {
  projectId: string;
  generatedAt: string;
  summaryLabel: string;
  matchedProjectCount: number;
  matchedFailureRecordCount: number;
  matchTags: string[];
  topRejectionCauses: HistoricalFailureCause[];
  checklist: HistoricalChecklistItem[];
  dataConfidence: "low" | "medium" | "high";
  notes: string[];
}

export type MboxEmailBucket =
  | "permit_approval"
  | "permit_correction"
  | "nem_approval"
  | "nem_correction"
  | "status_update"
  | "missing_info_request"
  | "fee_request"
  | "inspection_final_notice"
  | "spam_irrelevant";

export interface MboxExtractedLearningRecord {
  source: "email";
  type: MboxEmailBucket;
  workflow: "permit" | "nem" | "both" | "unknown";
  jurisdiction: string | null;
  utility: string | null;
  projectAddress: "REDACTED" | null;
  projectAddressHash: string | null;
  portalName: string | null;
  correctionCategory: string | null;
  correctionSubcategory: string | null;
  requiredAction: string | null;
  preventable: boolean;
  requiredDocuments: string[];
  timelineSignal: string | null;
  statusLabel: string | null;
  classifier: "deterministic" | "llm_stub" | "llm";
  confidence: number;
  sample: string;
  occurredAt: string;
}

export interface MboxKnowledgeImportResult {
  messagesScanned: number;
  learningEvents: number;
  failureExamplesImported: number;
  profilesTouched: number;
  skippedMessages: number;
  duplicateMessages: number;
  llmReviewRecommended: number;
  bucketCounts: Record<MboxEmailBucket, number>;
  extractedRecords: MboxExtractedLearningRecord[];
}

export interface EmailTrackingSource {
  id: string;
  sourceType: "mbox_path";
  label: string;
  filePath: string;
  defaultState: string;
  defaultAhj: string;
  defaultUtility: string;
  active: boolean;
  lastCheckedAt: string | null;
  lastMessageCount: number;
  lastMatchedCount: number;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailProjectMatch {
  id: string;
  projectId: string;
  sourceId: string | null;
  sourceSignature: string;
  sourceLabel: string;
  emailBucket: MboxEmailBucket;
  workflow: "permit" | "nem" | "both" | "unknown";
  confidence: number;
  matchReason: string;
  statusCheckId: string | null;
  correctionId: string | null;
  subject: string;
  occurredAt: string;
  createdAt: string;
}

export interface EmailTrackerRunResult {
  sourcesChecked: number;
  messagesScanned: number;
  projectMatches: number;
  statusChecksCreated: number;
  correctionsCreated: number;
  skippedDuplicates: number;
  unmatchedMessages: number;
  sourceErrors: string[];
  matches: EmailProjectMatch[];
}

export type OperationStepStatus = "not_started" | "in_progress" | "waiting" | "blocked" | "done";
export type ProjectNoteType = "pm_note" | "blocker" | "client_update" | "handoff" | "system_note";

export interface OperationStep {
  id: string;
  projectId: string;
  phaseKey: string;
  phaseName: string;
  status: OperationStepStatus;
  statusSource: "system" | "manual";
  ownerRole: string;
  dueAt: string | null;
  summary: string;
  nextAction: string;
  notes: string;
  sortOrder: number;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectNote {
  id: string;
  projectId: string;
  noteType: ProjectNoteType;
  body: string;
  createdBy: string;
  createdAt: string;
}

export interface OperationsPlan {
  projectId: string;
  generatedAt: string;
  status: OperationStepStatus;
  currentPhase: string;
  nextAction: string;
  steps: OperationStep[];
  notes: ProjectNote[];
  counts: Record<OperationStepStatus, number>;
}

export interface ProjectRunbookStep {
  id: string;
  phaseKey: string;
  phaseName: string;
  status: OperationStepStatus;
  ownerRole: string;
  dueAt: string | null;
  whatToDo: string;
  why: string;
  doneCriteria: string[];
  evidence: string[];
  notes: string;
  source: string;
  isCurrent: boolean;
}

export interface ProjectRunbook {
  projectId: string;
  generatedAt: string;
  status: OperationStepStatus;
  headline: string;
  currentStepId: string | null;
  nextAction: string;
  totalSteps: number;
  doneCount: number;
  blockedCount: number;
  waitingCount: number;
  inProgressCount: number;
  noteCount: number;
  steps: ProjectRunbookStep[];
  recentNotes: ProjectNote[];
  reportText: string;
}

export type OperationsBriefHealth = "ready" | "watch" | "blocked";
export type OperationsBriefSeverity = "pass" | "info" | "warning" | "blocker";

export interface OperationsBriefAction {
  phaseName: string;
  ownerRole: string;
  action: string;
  reason: string;
  status: OperationStepStatus;
  dueAt: string | null;
}

export interface OperationsBriefSignal {
  title: string;
  detail: string;
  severity: OperationsBriefSeverity;
  source: string;
}

export interface OperationsBriefActivity {
  title: string;
  detail: string;
  severity: OperationsBriefSeverity;
  occurredAt: string;
  source: string;
}

export interface OperationsBrief {
  projectId: string;
  generatedAt: string;
  health: OperationsBriefHealth;
  headline: string;
  currentPhase: string;
  nextAction: string;
  counts: Record<OperationStepStatus, number>;
  immediateActions: OperationsBriefAction[];
  blockers: OperationsBriefSignal[];
  readySignals: OperationsBriefSignal[];
  recentActivity: OperationsBriefActivity[];
  handoffNote: string;
}

export interface ProjectHandoffPacketSection {
  title: string;
  severity: OperationsBriefSeverity;
  source: string;
  lines: string[];
}

export interface ProjectHandoffPacket {
  projectId: string;
  generatedAt: string;
  health: OperationsBriefHealth;
  headline: string;
  nextAction: string;
  currentPhase: string;
  blockerCount: number;
  actionCount: number;
  readinessStatus: LiveProjectReadinessReport["status"];
  timelineEventCount: number;
  ownerRoles: string[];
  sections: ProjectHandoffPacketSection[];
  reportText: string;
}

export type ProjectCommunicationAudience = "internal_pm" | "installer_design" | "client_safe";

export interface ProjectCommunicationDraft {
  audience: ProjectCommunicationAudience;
  title: string;
  subject: string;
  body: string;
  severity: OperationsBriefSeverity;
  source: string;
}

export interface ProjectCommunicationDraftPacket {
  projectId: string;
  generatedAt: string;
  headline: string;
  status: OperationsBriefHealth;
  nextAction: string;
  drafts: ProjectCommunicationDraft[];
  reportText: string;
}

export interface OperationsBoardProject {
  projectId: string;
  homeownerName: string;
  projectAddress: string;
  status: ProjectStatus;
  health: OperationsBriefHealth;
  currentPhase: string;
  nextAction: string;
  ownerRole: string;
  blockerCount: number;
  activeActionCount: number;
  dueAt: string | null;
  latestActivityAt: string | null;
  latestActivity: string;
  updatedAt: string;
}

export interface OperationsBoard {
  generatedAt: string;
  totalProjects: number;
  blockedProjects: number;
  watchProjects: number;
  readyProjects: number;
  totalBlockers: number;
  totalActiveActions: number;
  projects: OperationsBoardProject[];
}

export type OperationsActionDueBucket = "overdue" | "today" | "upcoming" | "no_due";

export interface OperationsActionItem {
  projectId: string;
  stepId: string;
  homeownerName: string;
  projectAddress: string;
  health: OperationsBriefHealth;
  phaseName: string;
  status: OperationStepStatus;
  ownerRole: string;
  dueAt: string | null;
  dueBucket: OperationsActionDueBucket;
  action: string;
  reason: string;
  notes: string;
  source: string;
  blockerCount: number;
  updatedAt: string;
}

export interface OperationsActionQueue {
  generatedAt: string;
  totalActions: number;
  blockedActions: number;
  waitingActions: number;
  inProgressActions: number;
  overdueActions: number;
  todayActions: number;
  actions: OperationsActionItem[];
}

export interface OperationsOwnerWorkload {
  ownerRole: string;
  totalActions: number;
  blockedActions: number;
  waitingActions: number;
  inProgressActions: number;
  overdueActions: number;
  todayActions: number;
}

export interface OperationsDailyReport {
  generatedAt: string;
  headline: string;
  summary: string[];
  board: OperationsBoard;
  actionQueue: OperationsActionQueue;
  ownerWorkload: OperationsOwnerWorkload[];
  topProjects: OperationsBoardProject[];
  dueNow: OperationsActionItem[];
  topActions: OperationsActionItem[];
  reportText: string;
}

export type LiveProjectReadinessStatus = "done" | "needs_review" | "blocked";

export interface LiveProjectReadinessItem {
  id: string;
  title: string;
  status: LiveProjectReadinessStatus;
  ownerRole: string;
  detail: string;
  nextAction: string;
  evidence: string[];
  source: string;
}

export interface LiveProjectReadinessReport {
  projectId: string;
  generatedAt: string;
  status: "ready" | "needs_review" | "blocked";
  headline: string;
  nextAction: string;
  doneCount: number;
  needsReviewCount: number;
  blockedCount: number;
  totalCount: number;
  items: LiveProjectReadinessItem[];
  reportText: string;
}

export type ProjectTimelineEventCategory =
  | "project"
  | "pm_note"
  | "operation"
  | "qc"
  | "human_review"
  | "correction"
  | "permit_status"
  | "email"
  | "portal"
  | "submission"
  | "audit";

export interface ProjectTimelineEvent {
  id: string;
  projectId: string;
  occurredAt: string;
  category: ProjectTimelineEventCategory;
  severity: OperationsBriefSeverity;
  title: string;
  detail: string;
  actor: string;
  source: string;
  ownerRole: string;
  nextAction: string;
  evidence: string[];
  relatedId: string | null;
}

export interface ProjectTimelineReport {
  projectId: string;
  generatedAt: string;
  headline: string;
  latestActivityAt: string | null;
  totalEvents: number;
  blockerCount: number;
  warningCount: number;
  emailCount: number;
  correctionCount: number;
  events: ProjectTimelineEvent[];
  reportText: string;
}

export type ProjectProcessLaneKey = "intake" | "permit" | "nem" | "closeout";
export type ProjectProcessStepStatus = "not_started" | "in_progress" | "waiting" | "blocked" | "done";

export interface ProjectProcessStep {
  id: string;
  laneKey: ProjectProcessLaneKey;
  label: string;
  status: ProjectProcessStepStatus;
  ownerRole: string;
  summary: string;
  nextAction: string;
  evidence: string[];
  source: string;
}

export interface ProjectProcessLane {
  key: ProjectProcessLaneKey;
  title: string;
  status: ProjectProcessStepStatus;
  summary: string;
  currentStep: string;
  nextAction: string;
  steps: ProjectProcessStep[];
}

export interface ProjectProcessMap {
  projectId: string;
  generatedAt: string;
  headline: string;
  status: ProjectProcessStepStatus;
  permitStatus: ProjectProcessStepStatus;
  nemStatus: ProjectProcessStepStatus;
  nextAction: string;
  lanes: ProjectProcessLane[];
  reportText: string;
}

export type SubmitGateDecision = "blocked" | "ready_to_stage" | "staged_awaiting_human" | "submitted_tracking";
export type SubmitGateLane = "intake" | "qc" | "permit" | "nem" | "portal" | "tracking" | "closeout";
export type SubmitGateCheckStatus = "pass" | "warning" | "blocker";

export interface SubmitGateCheck {
  id: string;
  title: string;
  lane: SubmitGateLane;
  status: SubmitGateCheckStatus;
  ownerRole: string;
  requirement: string;
  evidence: string[];
  nextAction: string;
  source: string;
}

export interface SubmitGateReport {
  projectId: string;
  generatedAt: string;
  decision: SubmitGateDecision;
  headline: string;
  nextAction: string;
  canPrepareSubmission: boolean;
  canHumanSubmit: boolean;
  blockerCount: number;
  warningCount: number;
  passCount: number;
  checks: SubmitGateCheck[];
  manualSubmitChecklist: string[];
  reportText: string;
}

export type InstallerActionCategory =
  | "design"
  | "field_verification"
  | "utility_nem"
  | "documents"
  | "correction"
  | "portal"
  | "approval_tracking";

export interface InstallerActionItem {
  id: string;
  category: InstallerActionCategory;
  severity: OperationsBriefSeverity;
  title: string;
  ask: string;
  why: string;
  ownerRole: string;
  dueBefore: string;
  evidence: string[];
  source: string;
  relatedId: string | null;
}

export interface InstallerActionPacket {
  projectId: string;
  generatedAt: string;
  headline: string;
  status: "clear" | "needs_action" | "blocked";
  totalActions: number;
  blockerCount: number;
  warningCount: number;
  installerActionCount: number;
  designActionCount: number;
  nemActionCount: number;
  nextAction: string;
  items: InstallerActionItem[];
  reportText: string;
}

export interface WorkflowStep {
  id: string;
  label: string;
  status: "done" | "needs_review" | "blocked" | "ready";
  summary: string;
  action: string;
}

export interface ProjectWorkflow {
  projectId: string;
  generatedAt: string;
  status: "blocked" | "needs_review" | "ready_to_stage" | "staged_or_submitted";
  nextAction: string;
  canPrepareSubmission: boolean;
  steps: WorkflowStep[];
  historicalReport: HistoricalFailureReport;
  reviewerReport: ReviewerReport;
  applicationDocs: ApplicationDocumentPackage;
}

export interface AuditLog {
  id: string;
  projectId: string | null;
  actorType: "system" | "human" | "llm" | "portal_bot";
  actorName: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectDetail {
  project: ProjectRecord;
  qcResults: QcResult[];
  humanReviewItems: HumanReviewItem[];
  corrections: CorrectionRecord[];
  permitCheckTargets: PermitCheckTarget[];
  permitStatusChecks: PermitStatusCheck[];
  emailProjectMatches: EmailProjectMatch[];
  portalRuns: PortalRun[];
  submissions: SubmissionRecord[];
  auditLogs: AuditLog[];
  projectNotes: ProjectNote[];
  // Pipeline stage (computed from project.status by backend/src/projectStage.ts).
  stageKey: string;
  stageIndex: number;
  stageLabel: string;
  stageCount: number;
  isBlocked: boolean;
}

/** Where an extracted value came from — shown to the PM to verify accuracy. */
export interface ParserFieldEvidence {
  source: "plan_set" | "utility_bill" | "meter_photo";
  /** Sheet/page hint, e.g. "PV-2" or "Cover". */
  sheet?: string;
  /** Short verbatim excerpt the value was read from. */
  excerpt?: string;
}

/** One extracted parser field with provenance and confidence. */
export interface ParserExtractedField {
  value: string | number | null;
  confidence: number; // 0-1
  evidence?: ParserFieldEvidence;
}

/** Result of the LLM-assisted parser extraction across plan set + utility bill + meter photo. */
export interface ParserLlmExtraction {
  provider: "claude" | "stub";
  /** Field id -> extracted value+confidence. Keys match the parser form field ids. */
  fields: Record<string, ParserExtractedField>;
  /** Fields the model could not confidently determine — surface for human review. */
  lowConfidenceFields: string[];
  /** Short human-readable notes about anything ambiguous or worth verifying. */
  notes: string;
}

export interface LLMProvider {
  extractFields(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** LLM-assisted extraction of all project fields from raw document text (plan set, utility bill, meter photo). */
  extractProjectFields(input: {
    planText?: string;
    utilityBillText?: string;
    meterText?: string;
    defaultState?: string;
  }): Promise<ParserLlmExtraction>;
  /** Vision-based extraction from the actual document images — accurate for account/meter numbers that OCR mangles. */
  extractProjectFieldsFromImages(input: {
    images: { kind: "utility_bill" | "meter_photo" | "plan_page"; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }[];
    defaultState?: string;
  }): Promise<ParserLlmExtraction>;
  classifyCorrection(input: {
    correctionText: string;
    project?: ProjectRecord;
  }): Promise<{ bucket: CorrectionBucket; confidence: number; notes: string }>;
  draftResponse(input: {
    correctionText: string;
    project?: ProjectRecord;
  }): Promise<{ draft: string; confidence: number }>;
  /** Extract structured data from an image (base64 PNG/JPEG) — used for image-only SLDs */
  visionExtract(input: {
    imageBase64: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    prompt: string;
  }): Promise<Record<string, unknown>>;
  /** Synthesize AHJ/utility requirements from past project history */
  synthesizeKnowledge(input: {
    ahjName: string;
    state: string;
    utility?: string;
    pastApplicationTexts: string[];
    correctionPatterns: string[];
  }): Promise<{
    requiredDocuments: string[];
    commonRejectionReasons: string[];
    tips: string[];
    confidence: "low" | "medium" | "high";
  }>;
  /** Research an UNKNOWN AHJ's residential-solar permitting requirements from the
   *  model's knowledge, so a new jurisdiction can be onboarded automatically.
   *  Advisory — flagged for human verification before relying on it. */
  researchAhjRequirements(input: {
    ahj: string;
    state: string;
    utility?: string;
  }): Promise<AhjResearchResult>;
  /** Research an UNKNOWN utility's residential NEM / interconnection process from the
   *  model's knowledge, so a new utility can be onboarded the same way as an AHJ.
   *  Advisory — flagged for human verification before relying on it. */
  researchUtilityRequirements(input: {
    utility: string;
    state: string;
    ahj?: string;
  }): Promise<UtilityResearchResult>;
  /** Given a list of portal form fill/select interactions that weren't auto-bound to a
   *  field during recording (exact-match missed), ask the model to suggest which project
   *  or client field each typed value corresponds to. Returns null for portal-literal
   *  values (dropdown options, fixed text) that shouldn't be data-bound. Called ONCE
   *  at save-time (not per keystroke) so latency is acceptable. */
  suggestRecipeFieldBindings(input: {
    unbound: Array<{ index: number; action: string; label?: string; value: string }>;
    fieldValues: Record<string, string>;
  }): Promise<Array<{ index: number; field: string | null }>>;
  /** Look up an inverter/microinverter model's rated continuous AC output from datasheet
   *  knowledge (web search as a fallback when unsure), and derive a suggested PV breaker.
   *  Advisory only — the result pre-fills the human-review boxes for approval. */
  lookupInverterSpec(input: {
    inverterModel: string;
    inverterQty?: number;
  }): Promise<InverterSpecLookup>;

  /** Web-search for the AHJ's official blank permit application PDF and return
   *  candidate direct-download URLs to try. Advisory — URLs must be fetched and
   *  validated as PDFs before use. */
  findAhjFormUrl(input: {
    ahj: string;
    state: string;
    formType?: string;
  }): Promise<AhjFormUrlResult>;

  /** Map a blank form's AcroForm field names onto project data sources so the
   *  form can be auto-filled. Returns the textField/checkbox source maps using
   *  the same source convention as ahjForms (project.* / snapshot.* / client.* /
   *  computed.* / lit:*). */
  mapAcroFormFields(input: {
    ahj: string;
    state: string;
    formName: string;
    fields: { name: string; type: string }[];
    availableSources: string[];
  }): Promise<AhjFieldMapResult>;
}

export interface AhjFormUrlResult {
  provider: "claude" | "stub";
  formName: string;
  /** Direct-download URLs for the blank PDF, best first. May be empty. */
  candidateUrls: string[];
  formType: string;
  confidence: "low" | "medium" | "high";
  notes: string;
}

export interface AhjFieldMapResult {
  provider: "claude" | "stub";
  /** AcroForm text field name -> value source (e.g. "project.homeownerName"). */
  textFields: Record<string, string>;
  /** AcroForm checkbox field name -> check rule. */
  checkboxes: Record<string, { source: string; equals?: string }>;
  notes: string;
}

export interface InverterSpecLookup {
  provider: "claude" | "stub";
  inverterModel: string;
  inverterQty: number;
  /** Per-unit rated continuous AC output current in amps (this is the QC "inverter output"). */
  outputCurrentA: number | null;
  /** Per-unit rated continuous AC output power in VA/W. */
  outputVa: number | null;
  /** outputCurrentA * inverterQty. */
  totalContinuousCurrentA: number | null;
  /** Suggested PV backfeed breaker/OCPD: next standard size >= 1.25 * total continuous current. */
  derivedPvBreakerA: number | null;
  confidence: "low" | "medium" | "high";
  /** "model knowledge" | "web search" | "" — where the rating came from. */
  source: string;
  notes: string;
  needsHumanVerification: boolean;
}

export interface AhjResearchResult {
  provider: "claude" | "stub";
  portalName: string;
  /** The UNDERLYING portal platform/vendor (Accela, ProjectDox/Avolve, EnerGov/Tyler,
   *  MyGov, etc.) — many branded portals (e.g. "Oregon ePermitting") run on Accela,
   *  so the Playwright automation for that platform is reusable across AHJs (only the
   *  entry URL + login differ; no retraining of the automation flow). */
  portalPlatform: string;
  portalUrl: string;
  submissionMethod: string;
  requiredDocuments: string[];
  commonCorrections: string[];
  tips: string[];
  /** Step-by-step submittal process the model believes this AHJ uses. */
  submissionSteps: string[];
  confidence: "low" | "medium" | "high";
  /** Always true for AI research — a human must verify before trusting it. */
  needsHumanVerification: boolean;
  notes: string;
}

/** AI-researched (or human-verified) onboarding profile for a UTILITY's residential
 *  net-metering / interconnection process. Mirrors AhjResearchResult but focused on
 *  the NEM/interconnection portal and its application requirements, so a new utility
 *  can be taught the same way a new AHJ is. */
export interface UtilityResearchResult {
  provider: "claude" | "stub";
  /** Interconnection/NEM portal name as the utility refers to it (e.g. "PowerClerk"). */
  portalName: string;
  /** Underlying portal platform/vendor (PowerClerk / Clean Power Research, Tyler,
   *  custom). Many utilities share PowerClerk, so the automation is reusable across
   *  utilities on the same platform — only the entry URL + login differ. */
  portalPlatform: string;
  portalUrl: string;
  submissionMethod: string;
  /** Documents the utility's NEM/interconnection application requires (one-line, site
   *  plan, inverter technical specs/cut sheets, account/meter proof, signed agreement…). */
  requiredDocuments: string[];
  /** How the utility handles smart-inverter settings in its NEM app — e.g. a Yes/No
   *  question ("Will you use the utility's recommended smart inverter settings?")
   *  answered Yes for UL 1741-SB listed inverters. NOT a grid-profile drawing. */
  smartInverterSettings: string;
  /** Whether/how meter aggregation is offered (most residential projects: no aggregation). */
  meterAggregation: string;
  /** AC disconnect rule (e.g. "lockable AC disconnect within 10 ft of the meter; max AC
   *  output permitted without a disconnect varies by service type"). */
  acDisconnectRule: string;
  /** Export-capacity limit / tier note (e.g. "export over 25 kW is evaluated as Tier 2"). */
  exportLimitNote: string;
  commonCorrections: string[];
  tips: string[];
  /** Ordered steps a coordinator follows in this utility's NEM application. */
  submissionSteps: string[];
  confidence: "low" | "medium" | "high";
  /** Always true for AI research — a human must verify before trusting it. */
  needsHumanVerification: boolean;
  notes: string;
}

// ---------------------------------------------------------------------------
// Portal record/replay recipes — teach the bot a NEW AHJ or utility portal by
// recording the steps once, then replay them for future projects (substituting
// project/client data + uploading the right docs, always stopping before final
// submit). Admins can delete and re-record an incomplete recipe.
// ---------------------------------------------------------------------------

/** Which phase of the bot run a recorded step belongs to. The replay runner drives
 *  login → open → fill → upload → review; steps are grouped by phase. */
export type RecipePhase = "open" | "fill" | "upload" | "review";

export type RecipeAction =
  | "goto"
  | "click"
  | "fill"
  | "select"
  | "check"
  | "uncheck"
  | "press"
  | "waitFor"
  | "upload"
  | "stopForReview";

/** A portable locator descriptor captured at record time. Replay tries the richest
 *  available strategy first (role+name, label, placeholder, testId, text, then css). */
export interface RecipeSelector {
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  testId?: string;
  css?: string;
  /** Optional iframe name to scope the locator into (portals like Accela use dialogs). */
  frame?: string;
  /** 0-based index when multiple match; omitted means .first(). */
  nth?: number;
  exact?: boolean;
}

export interface RecipeStep {
  action: RecipeAction;
  phase?: RecipePhase;
  selector?: RecipeSelector;
  /** For fill/select: the project/client field key to substitute at replay
   *  (e.g. "accountNumber", "installerCompanyName"). Resolved server-side. */
  field?: string;
  /** Literal value (goto url, press key, or a fixed fill/select value). */
  value?: string;
  /** For upload: which document type to attach (e.g. "sld", "site_plan"). */
  docType?: string;
  /** Don't fail the run if this step's target isn't found. */
  optional?: boolean;
  note?: string;
}

export type PortalRecipeStatus = "recording" | "complete" | "needs_rerecord";

export interface PortalRecipe {
  id: string;
  /** Whether this teaches an AHJ permit portal or a utility NEM portal. */
  scopeType: "ahj" | "utility";
  /** The KB profile key (state|ahj|utility) this recipe serves. */
  profileKey: string;
  state: string;
  ahj: string;
  utility: string;
  portalPlatform: string;
  portalUrl: string;
  status: PortalRecipeStatus;
  version: number;
  steps: RecipeStep[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: string;
}
