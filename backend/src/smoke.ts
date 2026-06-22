import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./db";
import { createClient } from "./clients";
import { saveProjectDocument } from "./projectDocuments";
import {
  createPermitCheckTarget,
  createProject,
  deleteProject,
  configureEmailTrackingSource,
  getApplicationDocumentPackage,
  getHistoricalFailureReport,
  getInstallerActionPacket,
  getKnowledgeBase,
  getLiveProjectReadinessReport,
  getOperationsActionQueue,
  getOperationsBoard,
  getOperationsBrief,
  getOperationsDailyReport,
  getProjectCommunicationDrafts,
  getProjectHandoffPacket,
  getProjectProcessMap,
  getProjectRunbook,
  getSubmitGateReport,
  getProjectTimelineReport,
  getProjectDetail,
  getProjectList,
  getReviewerReport,
  importKnowledgeFromMbox,
  prepareSubmission,
  recordPermitStatusCheck,
  addProjectNote,
  syncOperationsPlan,
  updateOperationStep,
  runEmailTracker,
  runProjectWorkflow,
} from "./repository";

const smokeDb = path.resolve(process.cwd(), "backend/data/smoke.sqlite");
fs.rmSync(smokeDb, { force: true });
process.env.AUTOPILOT_DB_PATH = smokeDb;

const db = await openDatabase();
const seededKnowledge = getKnowledgeBase(db).profiles;
if (seededKnowledge.length < 300) {
  throw new Error(`Expected seeded AHJ/utility knowledge base, got ${seededKnowledge.length} profiles.`);
}

// A submitting client with a CCB is required before staging (the submitting-client
// gate) — mirror the real intake flow by onboarding one and assigning it.
const smokeClient = createClient(db, {
  companyName: "Smoke Solar LLC",
  legalBusinessName: "Smoke Solar LLC",
  ccbLicenseNumber: "999999",
  electricalLicenseNumber: "C9999",
  businessEmail: "ops@smokesolar.test",
  businessPhone: "(503) 555-0100",
});

const detail = createProject(db, {
  clientId: smokeClient.id,
  owner: "Smoke Test",
  street: "123 Solar Way",
  city: "Portland",
  state: "OR",
  zip: "97201",
  ahj: "Portland",
  utility: "PGE",
  account: "1234567890",
  meter: "987654321",
  dcKw: "8.6",
  acKw: "6.5",
  exportKw: "6.5",
  moduleMake: "Qcells",
  moduleModel: "Q.TRON BLK M-G2.C1+/AC",
  moduleWattage: "430",
  moduleQty: "20",
  invModel: "IQ8M",
  invQty: "20",
  invOutputW: "325",
  interco: "Load-side breaker",
  busRating: "200",
  mainBreaker: "200",
  pvBreaker: "40",
  permitPath: "PRESCRIPTIVE",
  roofRafterSpacing: "24",
  roofRafterSpan: "10",
  snow: "25",
  deadLoad: "3.2",
  wind: "B",
  locateCalloutText: "No locate-triggering scope found.",
  sitePlanNotesText: "Roof plan shows fire access pathway, ridge/eave setbacks, array dimensions, service equipment, and PV layout.",
  roofPlanNotesText: "Roof framing: 2x6 rafters at 24 inches on center, 10 ft clear span, roof slope 5:12. Racking attachment detail shows flashed standoffs lagged to rafters.",
  structuralCalcText: "Oregon prescriptive rooftop PV worksheet complete. Dead load 3.2 psf, ground snow 25 psf, wind exposure B, rafter span checked.",
  electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A. NEC 690.12 rapid shutdown shown.",
  labelsText: "PV label schedule includes rapid shutdown label, service power source directory, disconnect labels, and backfed breaker warning.",
  splitPagesText: "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation and rapid shutdown: page 3\n03 Roof framing and racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12",
  utilityDownloadChecklistText: "PGE package includes SLD/3-line, site/plot plan, module spec, inverter spec, utility bill, meter data, and account data.",
  packetReadinessText: "READY - Plan set\nREADY - Utility bill\nREADY - Module spec\nREADY - Inverter spec",
});

if (detail.project.status !== "qc_passed") {
  throw new Error(`Expected qc_passed, got ${detail.project.status}`);
}

const learnedAfterProject = getKnowledgeBase(db).profiles.find((profile) => profile.ahj === "Portland" && profile.utility === "PGE");
if (!learnedAfterProject || learnedAfterProject.projectCount < 1) {
  throw new Error("Expected knowledge base to learn the Portland/PGE project profile.");
}
if (!learnedAfterProject.requiredDocuments.some((doc) => /SLD|one-line|3-line/i.test(doc))) {
  throw new Error("Expected knowledge base to learn required electrical one-line/SLD document evidence.");
}

// Attach the actual plan-set FILE so the document-presence gate is satisfied. The
// document gate (requiredDocuments.ts) requires the real plan set to exist, then uses
// the parsed sheet map to confirm the in-plan-set sheets (SLD, site plan, structural,
// module/inverter spec, labels) — this is the fix for "AHJ emailed back: docs missing".
const fakePdf = Buffer.from("%PDF-1.4\n% smoke test plan set\n", "utf8");
saveProjectDocument(db, detail.project.id, { docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: fakePdf, source: "upload" });

const reviewerReport = getReviewerReport(db, detail.project.id);
const reviewerBlockers = reviewerReport.findings.filter((finding) => finding.severity === "blocker");
if (reviewerBlockers.length) {
  throw new Error(`Expected reviewer gate to have no blockers, got ${reviewerBlockers.map((finding) => finding.title).join(", ")}`);
}
// DEADLOCK AUDIT: reviewer.submit.preview-required must never be a blocker.
// It is satisfied BY staging (automation stops at review, human submits manually),
// so making it a blocker would prevent staging from ever happening — a circular deadlock.
// This finding must always be severity "callout". If this assertion fires, check
// reviewerEngine.ts — the blockerCount conditional was removed for exactly this reason.
const previewRequiredFinding = reviewerReport.findings.find((finding) => finding.id === "reviewer.submit.preview-required");
if (previewRequiredFinding && previewRequiredFinding.severity === "blocker") {
  throw new Error("DEADLOCK: reviewer.submit.preview-required has severity 'blocker' — this prevents staging and creates a circular deadlock. It must always be 'callout'.");
}
if (reviewerReport.finalSubmitGate.finalSubmitButtonAloneIsEnough) {
  throw new Error("Expected reviewer gate to require AHJ preview/final packet instead of submit button only.");
}
if (!reviewerReport.findings.every((finding) => finding.evidenceStatus && finding.evidenceFound?.length)) {
  throw new Error("Expected every reviewer finding to include an evidence status and evidence trail.");
}

const submitGateBeforeStage = getSubmitGateReport(db, detail.project.id);
if (!submitGateBeforeStage.reportText.includes("PermitFlow + NEMflow Submit Gate") || !submitGateBeforeStage.checks.some((check) => check.lane === "nem" && /NEMflow/i.test(check.title))) {
  throw new Error("Expected submit gate to include a copyable NEMflow gate report.");
}
if (submitGateBeforeStage.blockerCount > 0 || !submitGateBeforeStage.canPrepareSubmission) {
  throw new Error(`Expected submit gate to allow staging before mock portal run, got ${submitGateBeforeStage.decision}.`);
}
if (!submitGateBeforeStage.manualSubmitChecklist.some((item) => /submit manually/i.test(item))) {
  throw new Error("Expected submit gate to preserve manual-submit guardrails.");
}

const staged = await prepareSubmission(db, detail.project.id);
if (staged.project.status !== "awaiting_human_submit") {
  throw new Error(`Expected awaiting_human_submit, got ${staged.project.status}`);
}

const submitGateAfterStage = getSubmitGateReport(db, detail.project.id);
if (submitGateAfterStage.decision !== "staged_awaiting_human" || !submitGateAfterStage.canHumanSubmit || submitGateAfterStage.canPrepareSubmission) {
  throw new Error(`Expected submit gate to move to staged_awaiting_human after mock staging, got ${submitGateAfterStage.decision}.`);
}

const historicalBefore = getHistoricalFailureReport(db, detail.project.id);
if (!historicalBefore.checklist.length || !historicalBefore.summaryLabel.includes("prior")) {
  throw new Error("Expected historical failure report to generate a pre-submit checklist.");
}

const workflow = runProjectWorkflow(db, detail.project.id);
if (!workflow.steps.length || !workflow.nextAction || workflow.status === "blocked" || (!workflow.canPrepareSubmission && workflow.status !== "staged_or_submitted")) {
  throw new Error(`Expected workflow to be stageable with a next action, got ${workflow.status}.`);
}
if (!workflow.historicalReport.checklist.length || !workflow.reviewerReport.findings.length || !workflow.applicationDocs.docs.length) {
  throw new Error("Expected workflow to hydrate historical, reviewer, and AHJ doc outputs.");
}

const opsPlan = syncOperationsPlan(db, detail.project.id);
if (opsPlan.steps.length < 9 || !opsPlan.currentPhase || !opsPlan.nextAction) {
  throw new Error("Expected operations plan to generate PM phases and a next action.");
}
const updatedOps = updateOperationStep(db, detail.project.id, opsPlan.steps[0].id, {
  status: "in_progress",
  ownerRole: "Smoke PM",
  notes: "Smoke PM note on customer upload.",
});
if (updatedOps.steps[0].status !== "in_progress" || updatedOps.steps[0].statusSource !== "manual" || updatedOps.steps[0].ownerRole !== "Smoke PM") {
  throw new Error("Expected operations step update to preserve manual PM status/owner.");
}
const notedOps = addProjectNote(db, detail.project.id, {
  noteType: "handoff",
  body: "Handoff note for smoke test.",
  createdBy: "Smoke PM",
});
if (!notedOps.notes.some((note) => note.body.includes("Handoff note"))) {
  throw new Error("Expected operations plan to include project PM notes.");
}
const opsBrief = getOperationsBrief(db, detail.project.id);
if (!opsBrief.headline || !opsBrief.handoffNote.includes("Next action") || !opsBrief.immediateActions.length) {
  throw new Error("Expected operations brief to include a headline, handoff note, and action queue.");
}
if (!opsBrief.recentActivity.some((item) => item.detail.includes("Handoff note"))) {
  throw new Error("Expected operations brief to include recent PM notes.");
}
const opsBoard = getOperationsBoard(db);
if (opsBoard.totalProjects < 1 || !opsBoard.projects.some((project) => project.projectId === detail.project.id) || opsBoard.totalActiveActions < 1) {
  throw new Error("Expected operations board to roll project PM briefs into a portfolio action board.");
}
const opsActions = getOperationsActionQueue(db);
if (opsActions.totalActions < 1 || !opsActions.actions.some((action) => action.projectId === detail.project.id && action.ownerRole === "Smoke PM")) {
  throw new Error("Expected operations action queue to include active PM-owned project steps.");
}
if (!opsActions.actions.some((action) => action.notes.includes("Smoke PM note"))) {
  throw new Error("Expected operations action queue to carry PM action notes.");
}
const opsReport = getOperationsDailyReport(db);
if (!opsReport.reportText.includes("Solar Ops Daily Report") || !opsReport.ownerWorkload.some((owner) => owner.ownerRole === "Smoke PM")) {
  throw new Error("Expected daily operations report to include a copyable report and owner workload.");
}

const runbook = getProjectRunbook(db, detail.project.id);
if (!runbook.reportText.includes("PM Runbook") || runbook.totalSteps < 10 || !runbook.currentStepId) {
  throw new Error("Expected PM runbook to include a copyable operating guide with current step.");
}
if (!runbook.steps.every((step) => step.whatToDo && step.why && step.doneCriteria.length && step.ownerRole && step.source)) {
  throw new Error("Expected every runbook step to include action, reason, done criteria, owner, and source.");
}
if (!runbook.steps.some((step) => /Interconnection|NEM/i.test(step.phaseName) && step.evidence.length)) {
  throw new Error("Expected PM runbook to include NEM/interconnection evidence.");
}

const handoffPacket = getProjectHandoffPacket(db, detail.project.id);
if (!handoffPacket.reportText.includes("Project Handoff Packet") || handoffPacket.sections.length < 6) {
  throw new Error("Expected consolidated project handoff packet with copyable report sections.");
}
if (!handoffPacket.sections.some((section) => /Installer|Design|NEM/i.test(section.title)) || !handoffPacket.sections.some((section) => /Recent Activity|PM Notes/i.test(section.title))) {
  throw new Error("Expected handoff packet to include installer/NEM asks, recent activity, and notes.");
}
if (!handoffPacket.ownerRoles.length || !handoffPacket.nextAction) {
  throw new Error("Expected handoff packet to include owners and next action.");
}

const communicationDrafts = getProjectCommunicationDrafts(db, detail.project.id);
if (!communicationDrafts.reportText.includes("Project Communication Drafts") || communicationDrafts.drafts.length !== 3) {
  throw new Error("Expected three project communication drafts and a copyable report.");
}
if (!communicationDrafts.drafts.some((draft) => draft.audience === "installer_design" && /Ask:/i.test(draft.body))) {
  throw new Error("Expected installer/design communication draft to include concrete asks.");
}
if (!communicationDrafts.drafts.some((draft) => draft.audience === "client_safe" && !/account|meter|breaker|705\.12/i.test(draft.body))) {
  throw new Error("Expected client-safe draft to avoid technical or sensitive details.");
}

const liveReadiness = getLiveProjectReadinessReport(db, detail.project.id);
if (!liveReadiness.reportText.includes("Live Project Test Readiness") || liveReadiness.items.length < 10) {
  throw new Error("Expected live project readiness to include a copyable report and full checklist.");
}
if (!liveReadiness.items.some((item) => item.id === "utility-account-evidence" && item.evidence.length)) {
  throw new Error("Expected live readiness to include utility/NEM evidence lines.");
}
if (!liveReadiness.items.every((item) => item.ownerRole && item.nextAction && item.source)) {
  throw new Error("Expected every live readiness item to include PM owner, next action, and source.");
}

const processMap = getProjectProcessMap(db, detail.project.id);
if (!processMap.reportText.includes("PermitFlow + NEMflow Map") || processMap.lanes.length !== 4) {
  throw new Error("Expected PermitFlow + NEMflow process map with four PM lanes.");
}
if (!processMap.lanes.some((lane) => lane.key === "permit" && lane.title === "PermitFlow")) {
  throw new Error("Expected process map to include a PermitFlow lane.");
}
if (!processMap.lanes.some((lane) => lane.key === "nem" && lane.title === "NEMflow" && lane.steps.some((step) => /Account|NEM|Approval|PTO|Utility/i.test(step.label)))) {
  throw new Error("Expected process map to include a NEMflow lane with utility/NEM steps.");
}
if (!processMap.lanes.every((lane) => lane.currentStep && lane.nextAction && lane.steps.every((step) => step.ownerRole && step.nextAction && step.source))) {
  throw new Error("Expected every process lane and step to include PM current step, owner, next action, and source.");
}

const installerPacket = getInstallerActionPacket(db, detail.project.id);
if (!installerPacket.reportText.includes("Installer Action Packet") || installerPacket.totalActions < 1) {
  throw new Error("Expected installer action packet to include a copyable action report.");
}
if (!installerPacket.items.every((item) => item.ask && item.why && item.ownerRole && item.dueBefore && item.source)) {
  throw new Error("Expected every installer action item to include ask, why, owner, due-before gate, and source.");
}
if (!installerPacket.items.some((item) => item.category === "utility_nem" || item.ownerRole === "NEM Ops")) {
  throw new Error("Expected installer action packet to include NEM-related action items.");
}

const earlyTimeline = getProjectTimelineReport(db, detail.project.id);
if (!earlyTimeline.reportText.includes("Project Timeline") || !earlyTimeline.events.some((event) => event.category === "pm_note" && event.detail.includes("Handoff note"))) {
  throw new Error("Expected project timeline to include a copyable report and PM note activity.");
}
if (!earlyTimeline.events.every((event) => event.title && event.occurredAt && event.source)) {
  throw new Error("Expected every project timeline event to include title, timestamp, and source.");
}

const appDocs = getApplicationDocumentPackage(db, detail.project.id);
if (appDocs.profile.id !== "portland-devhub-solar") {
  throw new Error(`Expected Portland application profile, got ${appDocs.profile.id}`);
}
if (!appDocs.docs.some((doc) => doc.id === "prescriptive-application")) {
  throw new Error("Expected Portland docs to include the prescriptive solar application/checklist.");
}
// A prescriptive-path project must NOT also generate the structural application — the
// two are mutually exclusive and the AHJ takes exactly one.
if (appDocs.docs.some((doc) => doc.id === "structural")) {
  throw new Error("Prescriptive project should not also generate the structural application.");
}
if (!appDocs.html.includes("AHJ Application Document Package")) {
  throw new Error("Expected printable application document HTML.");
}

const withTarget = createPermitCheckTarget(db, detail.project.id, {
  jurisdiction: "Portland",
  portalName: "DevHub",
  applicationNumber: "APP-123",
  checkFrequencyDays: 3,
});
if (!withTarget.permitCheckTargets.length) {
  throw new Error("Expected a permit check target.");
}
const learnedTarget = getKnowledgeBase(db).profiles.find((profile) => profile.ahj === "Portland" && profile.utility === "PGE");
if (!learnedTarget?.portalName.includes("DevHub")) {
  throw new Error(`Expected knowledge base to learn DevHub portal, got ${learnedTarget?.portalName || "none"}.`);
}

const ready = await recordPermitStatusCheck(db, detail.project.id, {
  targetId: withTarget.permitCheckTargets[0].id,
  source: "manual",
  rawStatusText: "Pre-issuance complete. Permit is ready to issue and fees are due.",
});
if (ready.project.status !== "ready_for_issue" || !ready.permitStatusChecks[0]?.readyForIssue) {
  throw new Error(`Expected ready_for_issue, got ${ready.project.status}`);
}
const learnedTimeline = getKnowledgeBase(db).profiles.find((profile) => profile.ahj === "Portland" && profile.utility === "PGE");
if (!learnedTimeline || learnedTimeline.timelineSampleCount < 1 || learnedTimeline.averageTimelineDays == null) {
  throw new Error("Expected knowledge base to learn an average timeline sample from permit status.");
}

const correction = await recordPermitStatusCheck(db, detail.project.id, {
  targetId: withTarget.permitCheckTargets[0].id,
  source: "manual",
  rawStatusText: "Review comments: correction required. Please revise the site plan and resubmit.",
});
if (correction.project.status !== "correction_received" || !correction.corrections.length) {
  throw new Error("Expected monitor correction to create a bucketed correction.");
}
const learnedCorrection = getKnowledgeBase(db).profiles.find((profile) => profile.ahj === "Portland" && profile.utility === "PGE");
if (!learnedCorrection || !learnedCorrection.commonCorrections.length) {
  throw new Error("Expected knowledge base to learn a common correction pattern.");
}
const historicalAfter = getHistoricalFailureReport(db, detail.project.id);
if (!historicalAfter.topRejectionCauses.some((cause) => cause.count > 0)) {
  throw new Error("Expected historical failure report to surface learned rejection causes.");
}

const mboxResult = await importKnowledgeFromMbox(db, {
  sourceLabel: "smoke.mbox",
  mboxText: `From reviewer@example.com Mon Jun 15 10:00:00 2026
Subject: Pacific Power PowerClerk correction required
Date: Mon, 15 Jun 2026 10:00:00 -0700

Correction required. Pacific Power PowerClerk application is missing meter photo and UL 1741 SB inverter settings. Please revise and resubmit.

From permit@example.com Tue Jun 16 10:00:00 2026
Subject: City of Portland permit approved
Date: Tue, 16 Jun 2026 10:00:00 -0700

Solar permit has been approved and is ready to issue. Permit fees are due before issuance.
`,
});
if (mboxResult.failureExamplesImported < 1 || mboxResult.profilesTouched < 1) {
  throw new Error("Expected MBOX import to create learned failure examples.");
}
if (mboxResult.bucketCounts.nem_correction < 1 || mboxResult.bucketCounts.fee_request < 1) {
  throw new Error(`Expected MBOX import to classify NEM correction and fee/approval signals, got ${JSON.stringify(mboxResult.bucketCounts)}.`);
}
if (!mboxResult.extractedRecords.some((record) => record.type === "nem_correction" && record.preventable && record.requiredAction)) {
  throw new Error("Expected MBOX import to extract a preventable NEM correction record with required action.");
}

const liveMboxPath = path.resolve(process.cwd(), "backend/data/smoke-live-email.mbox");
fs.writeFileSync(
  liveMboxPath,
  `From utility@example.com Wed Jun 17 10:00:00 2026
Subject: PGE NEM approved APP-123
Date: Wed, 17 Jun 2026 10:00:00 -0700

Permission to operate granted. PGE interconnection approved for Smoke Test at 123 Solar Way. Application APP-123 is approved.
`,
);
configureEmailTrackingSource(db, {
  filePath: liveMboxPath,
  label: "smoke-live-email.mbox",
});
const emailRun = await runEmailTracker(db);
if (emailRun.projectMatches < 1 || emailRun.statusChecksCreated < 1) {
  throw new Error(`Expected live email tracker to match project and create a status check, got ${JSON.stringify(emailRun)}.`);
}
const emailUpdated = getProjectDetail(db, detail.project.id);
if (!emailUpdated.emailProjectMatches.length || emailUpdated.permitStatusChecks[0]?.source !== "email") {
  throw new Error("Expected project detail to include an email match and latest email permit/NEM status check.");
}
const listWithNem = getProjectList(db).projects.find((project) => project.id === detail.project.id);
if (!listWithNem?.latestNemOutcome || !listWithNem.nemApproved || !listWithNem.latestNemCheckedAt) {
  throw new Error("Expected dashboard project list to expose NEMflow status and approval from live email tracking.");
}
const finalTimeline = getProjectTimelineReport(db, detail.project.id);
if (
  !finalTimeline.events.some((event) => event.category === "email") ||
  !finalTimeline.events.some((event) => event.category === "permit_status") ||
  !finalTimeline.events.some((event) => event.category === "correction") ||
  !finalTimeline.events.some((event) => event.category === "portal")
) {
  throw new Error("Expected final project timeline to include email, permit status, correction, and portal events.");
}
fs.rmSync(liveMboxPath, { force: true });

const deletion = deleteProject(db, detail.project.id);
if (!deletion.deleted || getProjectList(db).projects.some((project) => project.id === detail.project.id)) {
  throw new Error("Expected test project deletion to remove the project from the dashboard list.");
}

console.log("Smoke test passed: project saved, KB seeded/learned, operations plan/notes/PM brief/PM runbook/handoff packet/communication drafts/Ops Board/action queue/daily report/live readiness/process map/installer packet/submit gate/project timeline generated, evidence trails generated, historical failure check generated, MBOX learned, QC passed, AHJ docs generated, mock portal staged, permit ready-for-issue flagged, AHJ correction bucketed, live email matched, and test project deleted cleanly.");
