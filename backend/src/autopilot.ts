// ---------------------------------------------------------------------------
// Autopilot orchestrator — the autonomous pipeline that turns the manual
// "click each stage button" flow into a single hands-off run that stops at
// exactly ONE human-approval gate before the regulatory submission.
//
// The browser cannot be held paused for the hours/days a human approval may
// take, so autonomy is TWO automation segments separated by the existing
// `awaiting_human_submit` state, which IS the gate:
//
//   Segment A (pre-gate, fully automatic):
//     QC -> reviewer-gate -> prepareSubmission(autoSubmit=false). Reuses every
//     existing gate; lands the project in `awaiting_human_submit` with the
//     application staged to the portal review screen. Any gate (HttpError 409)
//     stops the run in `blocked` with the structured blocker payload.
//
//   Human gate:
//     `awaiting_human_submit` + zero reviewer blockers -> the Approve & Submit
//     button (auth-gated, audit-logged — the legal-compliance boundary).
//
//   Segment B (post-approval):
//     Re-open the staged application's review screen and click the allowlisted
//     final submit (never a fee-payment control), then capture confirmation.
//     Adapters that don't implement an autonomous submit fall back to "approved,
//     human completes in portal" — nothing is ever filed without explicit support.
// ---------------------------------------------------------------------------

import { performance } from "node:perf_hooks";
import type { AppDb, SqlParam } from "./db";
import { HttpError } from "./httpError";
import { addAuditLog } from "./audit";
import { logger } from "./logger";
import { nowIso } from "./time";
import { getProjectDetail, rerunQc, captureConfirmation, draftDocumentGaps } from "./repository";
import { parseJson } from "./json";
import type { NextStep, ProjectRecord, StageDetail, SubmittalTrackType } from "../../shared/src/types";
import { requiredTracks, SUBMITTAL_TRACK_TYPES, trackPermitTypes } from "./submittalTracks";
import { stageForStatus } from "./projectStage";
import { decideNextStep, gateBlockerHoldsTrack, loadFullNextStepFacts, reviewInfoFromResultJson, reviewerBlockerList, reviewerBlockersFor, stagingFailedFor, withoutCodeResearch, type NextStepFacts, type ReviewMismatch } from "./nextStep";
import { portalAutomationDisabled } from "../../portal-bot/src/browser";
// STATIC, and the synchrony is load-bearing (see maybeResumeAutopilot). No load-time cycle:
// jobQueue reaches this module only through the worker's dynamic import() in processNextJob,
// exactly as it reaches autoStageSteps.ts, which imports enqueueJob the same way.
import { enqueueJob } from "./jobQueue";

type Row = Record<string, SqlParam>;

export type AutopilotPhase =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "submitted"
  | "blocked"
  | "paused_for_human"
  | "failed";

export interface AutopilotBlocker {
  code: string;
  detail: string;
}

export type { ReviewMismatch };

export interface AutopilotState {
  projectId: string;
  phase: AutopilotPhase;
  stage: string;
  message: string;
  blockers: AutopilotBlocker[];
  canApprove: boolean;
  pauseReason: string | null;
  portalRunId: string | null;
  updatedAt: string;
  // Review-screen comparison: fields the portal shows vs. the project record.
  reviewMismatches: ReviewMismatch[];
  reviewAccurate: boolean | null;
  // Required portal fields the LLM gap-fill could NOT fill (no backing project data — left
  // blank, never guessed). The operator should add this data to the project and re-stage.
  gapFillMissing: string[];
  /** Required portal fields left blank though the project HAS the value — an engine gap,
   *  never the operator's data problem. */
  gapEngineUnfilled: string[];
  /** What the person taking the staged review page must know before submitting (dryrun-0928
   *  B3 / B14): answers the portal may not have saved; the portal's own calls held back. */
  reviewHandoffNotes: string[];
  /** Why Approve & Submit is disabled, in words (null when canApprove). */
  approveDisabledReason: string | null;
  /** S8 — may "Stage portals · Autopilot" start a run? False with a reason when the project is
   *  operator-blocked, a run is in flight, it is past Submit, every required track is
   *  already staged or filed (re-staging opens a duplicate draft), or the submit gate holds
   *  back a track it would stage (gateBlockersForTracks). */
  canStage: boolean;
  stageDisabledReason: string | null;
  /** The newest autopilot job's own outcome — HISTORY only. The phase is re-evaluated live
   *  (S3); a job that ended blocked no longer pins BLOCKED on a project whose gate is clean. */
  lastRun: { status: string; blocked: boolean; message: string; blockers: AutopilotBlocker[]; finishedAt: string | null } | null;
  /** The ONE next-step answer (nextStep.ts), full tier. */
  nextStep: NextStep;
}

// UNTYPED string Set — it does NOT fail typecheck when a status is removed from the
// ProjectStatus union, so it has to be maintained BY NAME. `intake_uploaded` and
// `submit_staging` were dropped here alongside their removal from the union (2026-09-19);
// leaving them would have been harmless-but-dead, and the next reader would have taken
// them for live vocabulary.
//
// READ BY EXACTLY ONE CALLER: maybeResumeAutopilot (below). It is NOT a staging permission
// list — prepareSubmission has no project-status gate at all (its gates are payment, an
// already-filed submission, QC/human-review/reviewer/historical, document presence, permit
// path and client), and Segment A's execution-time guard is per-TRACK on portal_runs, not on
// project status. So "pre-stage" here means only: a status from which a blocker-clearing
// event may re-drive the automatic run.
//
// `ready_to_resubmit` is a member for that reason. Resolving the last correction on a project
// with NOTHING on file lands there, and it is reached from a route that immediately calls
// maybeResumeAutopilot ("a correction was resolved", server.ts). Leaving it out would strand
// the corrected project exactly the way correction_received/correction_triaged strand one:
// the resume fires, the Set says no, and nothing moves. Being in this Set does not skip a
// single gate — Segment A still re-runs QC first and prepareSubmission still throws every
// 409 it throws from `parsed`.
const PRE_STAGE_STATUSES = new Set([
  "parsed",
  "qc_failed",
  "qc_passed",
  "ready_to_stage",
  "ready_to_resubmit",
]);

// A track counts as STAGED once it has a portal run that reached the portal (awaiting a
// human submit, already submitted, or paused mid-flow for a human). Staging is NOT
// idempotent portal-side — a re-run creates a duplicate live application draft — so this
// is what stops autopilot re-staging work that is already sitting in the portal.
//
// BY TRACK FAMILY, not by the literal permit_type. A trackless stage records its run as
// 'permit' and a per-track stage as 'combo' — ONE filing (submittalTracks.trackPermitTypes), as
// building/structural are one trade. Matched literally, a 'permit' draft was invisible to a
// 'combo' check (and vice versa), so prepareSubmission's stagedAtEntry / stagedMeanwhile re-check
// and Segment A's tracksToStage each let a second draft of the same application through.
// Pure DB read; exported for tests.
export function trackAlreadyStaged(db: AppDb, projectId: string, track: SubmittalTrackType): boolean {
  const family = trackPermitTypes(track);
  const row = db.get<Row>(
    `SELECT id FROM portal_runs
      WHERE project_id = ? AND permit_type IN (${family.map(() => "?").join(", ")})
        AND status IN ('awaiting_human_submit', 'submitted', 'paused_for_human')
      LIMIT 1`,
    [projectId, ...family],
  );
  return Boolean(row);
}

// The operator's explicit block (`projects.status = 'blocked'`) as a Segment A outcome, or
// null. Compared by its literal status value on purpose — this is the one status a person
// sets to mean "stop", and the code `operator_blocked` is what maybeResumeAutopilot keys on
// to never relaunch such a run on its own.
export function operatorBlockedOutcome(db: AppDb, projectId: string): AutopilotBlocker | null {
  const status = String(db.get<Row>("SELECT status FROM projects WHERE id = ?", [projectId])?.status ?? "");
  if (status !== "blocked") return null;
  return {
    code: "operator_blocked",
    detail: "The project is blocked by an operator, so autopilot will not run QC, build or stage it. Unblock the project, then start autopilot again.",
  };
}

// Which tracks THIS autopilot invocation should stage. An explicit track stages just
// that one; with no track we stage every track the project actually requires (NEM +
// the AHJ's permit structure). Before this, a track-less run made ONE untracked stage:
// the second permit discipline never filed at all, and the run was recorded against
// permit_type 'permit' so it showed on no track.
export function tracksToStage(db: AppDb, project: ProjectRecord, requested?: SubmittalTrackType): SubmittalTrackType[] {
  const wanted = requested ? [requested] : requiredTracks(project);
  return wanted.filter((t) => !trackAlreadyStaged(db, project.id, t));
}

/**
 * THE SUBMIT-GATE BLOCKERS THAT HOLD BACK A FILING OF THESE TRACKS — the one answer Approve
 * (for the staged draft's track) and Stage portals (for the tracks it would stage) both read.
 *
 * The gate's decision is project-wide, but each blocking check now says which filings each of its
 * items holds (SubmitGateCheck.holds, computed once at the gate by gateScope and — for documents —
 * by stagingMissingDocuments, the filter prepareSubmission turns into its 409). This reads that
 * answer; it never re-derives it (gates-proper C2: the gate, Stage, Approve and the banner asked
 * separately, and a structural finding held the utility's application). A check with no `holds`
 * holds every track, and a null track (a run tagged with no known track) is held by every blocker:
 * an unknown never clears. The reason names, per track, only the items that hold THAT track.
 */
export function gateBlockersForTracks(
  _db: AppDb,
  _project: ProjectRecord,
  gate: NextStepFacts["gate"],
  tracks: Array<SubmittalTrackType | null>,
): Array<{ id: string; nextAction: string; tracks: Array<SubmittalTrackType | null> }> {
  if (gate?.decision !== "blocked" || !tracks.length) return [];
  const out: Array<{ id: string; nextAction: string; tracks: Array<SubmittalTrackType | null> }> = [];
  for (const b of gate.blockers) {
    const held = tracks.filter((t) => gateBlockerHoldsTrack(b, t));
    if (!held.length) continue;
    if (!b.holds) { out.push({ id: b.id, nextAction: b.nextAction, tracks: held }); continue; }
    const perTrack = held.map((t) => ({ t, items: b.holds!.filter((h) => t === null || h.tracks.includes(t)) }));
    // A document names its own fix (find the form / upload the blank vs attach / split out).
    const lead = b.id === "document-inventory" ? "Missing before staging" : b.nextAction.replace(/[.\s]+$/, "");
    out.push({
      id: b.id,
      nextAction: `${lead} — ${perTrack.map((x) => `${x.t ?? "this"} filing: ${x.items.map((h) => (h.action ? `${h.label} (${h.action})` : h.label)).join("; ")}`).join(" · ")}`,
      tracks: held,
    });
  }
  return out;
}

// Translate an HttpError 409 blocker payload from prepareSubmission into the flat
// AutopilotBlocker list the UI shows.
function blockersFromHttpError(err: HttpError): AutopilotBlocker[] {
  const d = (err.details ?? {}) as Record<string, unknown>;
  const out: AutopilotBlocker[] = [];
  if (Number(d.failCount) > 0) out.push({ code: "qc_fail", detail: `${d.failCount} QC failure(s) must be resolved.` });
  if (Number(d.pendingCount) > 0) out.push({ code: "pending_review", detail: `${d.pendingCount} required human-review item(s) pending.` });
  for (const t of (Array.isArray(d.reviewerBlockers) ? d.reviewerBlockers : []) as string[]) out.push({ code: "reviewer_blocker", detail: String(t) });
  for (const t of (Array.isArray(d.historicalMissing) ? d.historicalMissing : []) as string[]) out.push({ code: "historical_missing", detail: String(t) });
  for (const m of (Array.isArray(d.missingDocuments) ? d.missingDocuments : []) as Array<{ label?: string }>) out.push({ code: "missing_document", detail: String(m.label ?? "Required document missing") });
  if (d.permitPathUnknown) out.push({ code: "permit_path", detail: "Confirm the permit path (prescriptive vs engineered)." });
  if (d.needsClient) out.push({ code: "needs_client", detail: "Assign the submitting client whose CCB/license belongs on the filing." });
  if (d.needsCcb) out.push({ code: "needs_ccb", detail: "Submitting client has no CCB license number on file." });
  // A per-job question the portal asks and only a person can answer for this job (ownership,
  // behind-the-meter, disconnect distance) — named, so the operator knows what to answer (B2).
  for (const q of (Array.isArray(d.unansweredPortalQuestions) ? d.unansweredPortalQuestions : []) as Array<{ label?: string; key?: string }>) {
    out.push({ code: "portal_question", detail: `Answer the portal's question for this job: "${String(q.label ?? q.key ?? "a per-job question")}" (portal questions on the project, or the intake link).` });
  }
  if (out.length === 0) out.push({ code: "blocked", detail: err.message });
  return out;
}

// The staging outcome the portal_runs row recorded — prepareSubmission RESOLVES (returns
// ProjectDetail) even when the adapter itself failed or paused mid-run, so "no exception"
// must never be reported as "staged to review". The portal_runs row is authoritative.
// Returns null when the run genuinely staged (awaiting_human_submit / submitted).
// Pure + exported so the mapping is unit-tested without a browser or a live stage.
export function segmentAOutcomeFromRun(
  run: { status?: unknown; error_message?: unknown; pause_reason?: unknown } | null | undefined,
): AutopilotBlocker | null {
  const status = run ? String(run.status ?? "") : "";
  if (status === "failed") {
    const detail = String(run?.error_message ?? "").trim()
      || "The portal stage failed before reaching the review screen — see the run's debug bundle.";
    return { code: "stage_failed", detail };
  }
  if (status === "paused_for_human") {
    const why = String(run?.pause_reason ?? "").trim() || "human input required";
    return { code: "paused_for_human", detail: `The portal run paused for a human (${why}). Complete the challenge and resume from the portal panel.` };
  }
  return null;
}

function latestPortalRun(db: AppDb, projectId: string, track?: SubmittalTrackType): Row | null {
  if (track) {
    const scoped = db.get<Row>(
      "SELECT * FROM portal_runs WHERE project_id = ? AND permit_type = ? ORDER BY started_at DESC LIMIT 1",
      [projectId, track],
    );
    if (scoped) return scoped;
  }
  return db.get<Row>("SELECT * FROM portal_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 1", [projectId]);
}

function awaitingPortalRun(db: AppDb, projectId: string, track?: SubmittalTrackType): Row | null {
  const params: SqlParam[] = [projectId];
  let sql = "SELECT * FROM portal_runs WHERE project_id = ? AND status = 'awaiting_human_submit'";
  if (track) { sql += " AND permit_type = ?"; params.push(track); }
  sql += " ORDER BY started_at DESC LIMIT 1";
  return db.get<Row>(sql, params);
}

// Review-screen mismatches + gap-fill lists from a portal_run's result_json (the reader lives
// in nextStep.ts so the next-step rule table and this panel read the same lists).
function reviewInfoFromRun(run: Row | null): { reviewMismatches: ReviewMismatch[]; reviewAccurate: boolean | null; gapFillMissing: string[]; gapEngineUnfilled: string[]; reviewHandoffNotes: string[] } {
  return reviewInfoFromResultJson(run?.result_json);
}

// Derive the current autopilot snapshot for the UI from the project status, the
// latest portal run, and the latest autopilot job result. No dedicated table —
// the state machine is a pure function of state we already persist.
//
// LIVE, NOT REPLAYED (S3). The pre-stage phase used to be the newest autopilot job's stored
// result: a job that ended blocked kept the panel on BLOCKED, with that run's blockers, after
// every one of them was cleared (a project whose gate read ready_to_stage with zero blockers
// still said "Blocked"). The phase and blockers are now evaluated from the current gate, the
// operator block and the per-track staging outcome — the same facts the next-step rule table
// reads — and the job's own result is carried only as `lastRun` (history).
export function getAutopilotState(db: AppDb, projectId: string): AutopilotState {
  const detail = getProjectDetail(db, projectId);
  const project = detail.project;
  const ts = project.updatedAt || nowIso();
  const run = latestPortalRun(db, projectId);
  const facts = loadFullNextStepFacts(db, projectId);
  const nextStep = decideNextStep(facts);
  const noReview = { reviewMismatches: [] as ReviewMismatch[], reviewAccurate: null as boolean | null, gapFillMissing: [] as string[], gapEngineUnfilled: [] as string[], reviewHandoffNotes: [] as string[] };

  const job = db.get<Row>(
    "SELECT * FROM job_queue WHERE project_id = ? AND job_type = 'autopilot' ORDER BY created_at DESC LIMIT 1",
    [projectId],
  );
  const jobStatus = job ? String(job.status) : "";
  const jobInFlight = jobStatus === "pending" || jobStatus === "running";
  // Guard the parse: a corrupt/truncated job_queue.result must not 500 the autopilot panel.
  const jobResult = job ? parseJson<{ blocked?: boolean; blockers?: AutopilotBlocker[]; message?: string } | null>(job.result == null ? null : String(job.result), null) : null;
  const lastRun: AutopilotState["lastRun"] = job
    ? {
        status: jobStatus,
        blocked: Boolean(jobResult?.blocked),
        message: jobResult?.message ?? (job.error ? String(job.error) : ""),
        blockers: jobResult?.blockers ?? [],
        finishedAt: job.finished_at == null ? null : String(job.finished_at),
      }
    : null;

  // S8 — may "Stage portals" start a run? Built from the SAME predicates Segment A applies
  // (operator block, tracksToStage) plus the filed check, so an enabled button is one
  // Segment A will act on, and a disabled one says why.
  const unfinished = facts.tracks.filter((t) => !t.filed && !t.done);
  const stillToStage = tracksToStage(db, project).filter((t) => unfinished.some((u) => u.track === t));
  // A blocked submit gate for the tracks it would stage: Segment A stages them in order and stops
  // at the first 409, so a held track means the button would run into the refusal the banner
  // already names (e6b3afde: "gate is blocked" beside an enabled Stage portals).
  const stageGateBlockers = stillToStage.length ? gateBlockersForTracks(db, project, facts.gate, stillToStage) : [];
  const heldTracks = new Set(stageGateBlockers.flatMap((b) => b.tracks));
  const freeTracks = stillToStage.filter((t) => !heldTracks.has(t));
  // AN ARCHIVED PROJECT FILES NOTHING (gates-proper C1 false-clear c): its next step already says
  // "nothing is asked of anyone", and an enabled Stage / Approve beside that is a contradiction.
  const stageDisabledReason = facts.archived
    ? "The project is archived — nothing is staged or filed from it. Restore it from the archive first."
    : facts.operatorHold
    ? `Blocked by an operator (${facts.operatorHold.reason}) — lift the block before staging.`
    : jobInFlight || facts.jobInFlight
      ? "A staging / autopilot run is already in flight — wait for it to finish."
      : stageForStatus(project.status).index >= stageForStatus("submitted").index
        ? `The project is past Submit (${project.status.replaceAll("_", " ")}). Stage a remaining track from its track card if one still needs filing.`
        : stillToStage.length === 0
          ? "Every required track is already staged or filed — re-staging would open a duplicate draft. Submit the staged application(s) in the portal."
          : stageGateBlockers.length
            ? `The submit gate holds back the ${stillToStage.filter((t) => heldTracks.has(t)).join(", ")} filing(s): ${stageGateBlockers.map((b) => b.nextAction.replace(/[.\s]+$/, "")).join("; ")}.`
              + (freeTracks.length ? ` The ${freeTracks.join(", ")} track(s) can be staged on their own from the track card.` : "")
            : null;
  const stageInfo = { canStage: stageDisabledReason === null, stageDisabledReason, lastRun, nextStep };

  // A run that paused mid-fill for MFA/CAPTCHA needs a human at the browser. Per TRACK (the
  // same fact nextStep's portal_paused reads): the newest run of a track that is not filed,
  // or a correction reopen that paused.
  const pausedRun = facts.reopenPause ?? unfinished.find((t) => t.latestRun?.status === "paused_for_human")?.latestRun ?? null;
  if (pausedRun) {
    return {
      projectId, phase: "paused_for_human", stage: "Portal paused for human",
      message: "Portal run paused for MFA/CAPTCHA. A human must complete the challenge.",
      blockers: [], canApprove: false, approveDisabledReason: "A portal run is paused for a person.",
      pauseReason: pausedRun.pauseReason ?? "human input required", portalRunId: pausedRun.id, updatedAt: ts,
      ...noReview, ...stageInfo,
    };
  }

  if (project.status === "submitted" || project.status === "ready_for_issue" || project.status === "issued" || project.status === "nem_approved" || project.status === "handoff_ready") {
    return { projectId, phase: "submitted", stage: "Submitted", message: "Filing submitted; tracking approval.", blockers: [], canApprove: false, approveDisabledReason: "Nothing is staged and awaiting approval.", pauseReason: null, portalRunId: run ? String(run.id) : null, updatedAt: ts, ...noReview, ...stageInfo };
  }

  // The per-track staging outcome: a required, unfiled track whose newest staging run failed
  // with no draft of it on the portal (nextStep.stagingFailedFor — the same predicate).
  const stagingFailed = unfinished.filter(stagingFailedFor);

  if (project.status === "awaiting_human_submit") {
    // The DRAFT's review info — not the newest run's, which may be a later failed re-run that
    // carries no gap-fill report at all.
    const awaitingRun = awaitingPortalRun(db, projectId);
    const reviewInfo = reviewInfoFromRun(awaitingRun ?? run);
    // If the gap-fill left required portal fields blank (no project data to fill them from),
    // advise the operator to add the data and re-stage rather than submit an incomplete app.
    // TWO DIFFERENT FACTS, TWO DIFFERENT SENTENCES. "Add them to the project" is only true
    // of fields the project genuinely lacks. Fields the project HOLDS that the engine
    // failed to fill are ours to fix, and telling an operator to go type them in sends
    // them to redo work already done — measured at ~80 false interruptions per 100
    // projects (2026-09-22), the only avoidable touch that asks for work that is finished.
    const gapAdvisory = reviewInfo.gapFillMissing.length
      ? ` ${reviewInfo.gapFillMissing.length} required portal field(s) had no project data and were left blank — add them to the project and re-stage before submitting: ${reviewInfo.gapFillMissing.join(", ")}.`
      : "";
    const engineAdvisory = reviewInfo.gapEngineUnfilled.length
      ? ` ${reviewInfo.gapEngineUnfilled.length} required portal field(s) were left blank even though the project HAS the data — fill them on the review screen before submitting; no project edit is needed: ${reviewInfo.gapEngineUnfilled.join(", ")}.`
      : "";
    // AN APPROVAL ALREADY ON RECORD MUST NOT BE INVITED AGAIN AS IF IT NEVER HAPPENED.
    // runAutopilotApproval on a real portal writes stage_detail `approved_awaiting_filing` and
    // leaves the status alone (nothing is filed). Reading only the status, this branch then
    // answered "Click Approve & Submit to file" — actively contradicting the approval the
    // operator had just given and hiding the fact that a filing was half-done. The button stays
    // enabled on purpose (a second track staged later needs it, and re-approving only writes
    // another audit row); what changes is what the panel SAYS.
    const approvedAwaitingFiling = project.stageDetail === "approved_awaiting_filing";
    // CAN APPROVE (S2) — not "no reviewer blockers" alone. Approve & Submit was enabled on a
    // project whose staging FAILED for the draft's track (nothing reached the review screen), on
    // one whose staged draft left required fields blank for lack of data, and on one whose submit
    // gate says the filing itself is incomplete. Each is a refusal, in words. The gate refuses
    // only on blockers about what is IN the filing — required documents and QC data (reviewer
    // findings are `blockers` above). submitting-client / permit-path / project-fields are
    // prepareSubmission's own staging 409s: a draft that exists already passed them, so they
    // cannot hold back its approval.
    //
    // PER TRACK — the DRAFT's track. stage_detail is written by the newest run of ANY track, so
    // reading `staging_failed` off the project refused a good NEM draft because a building re-run
    // failed after it (7ec74634), and the gate's document check lists every lane's missing file,
    // so a NEM draft was refused over a permit-lane checklist (29cd57b5). Both now ask about the
    // awaiting run's own track: stagingFailedFor, and gateBlockersForTracks' scoped documents.
    const awaitingFacts = awaitingRun ? facts.tracks.find((t) => t.stagedRun?.id === String(awaitingRun.id)) ?? null : null;
    const awaitingPermitType = awaitingRun ? String(awaitingRun.permit_type ?? "") : "";
    const awaitingTrack: SubmittalTrackType | null = awaitingFacts?.track
      ?? ((SUBMITTAL_TRACK_TYPES as string[]).includes(awaitingPermitType) ? awaitingPermitType as SubmittalTrackType : null);
    // Only the reviewer findings that hold THIS draft's filing (gateScope; nextStep's Approve
    // button and runAutopilotApproval ask the same filter): a structural conflict refused
    // approval of a staged UTILITY draft (88647deb). No draft / an unknown track: every blocker.
    const blockers = reviewerBlockersFor(facts.reviewerBlockers ?? reviewerBlockerList(db, project), awaitingRun ? awaitingTrack : null);
    // WHAT IS IN THE FILING: the QC data (the gate's qc-human-review check, for this draft's track)
    // and the documents THIS DRAFT CARRIED (repository.draftDocumentGaps — its recorded payload, never
    // the pre-Stage look-ahead nor what is on disk now: Michael's electrical draft went up before the
    // Marion E-01 existed, and the fix is to re-stage, not to "attach"; gates-proper C1).
    const filingGateBlockers = awaitingRun
      ? gateBlockersForTracks(db, project, facts.gate, [awaitingTrack]).filter((b) => b.id === "qc-human-review")
      : [];
    const draftGaps = awaitingRun ? withoutCodeResearch(() => draftDocumentGaps(db, project, awaitingRun, awaitingTrack)) : [];
    const draftWord = awaitingTrack ? `${awaitingTrack} ` : "";
    const approveRefusals = [
      facts.archived ? "the project is archived — restore it first" : "",
      !awaitingRun ? "no staged portal run is awaiting a submit" : "",
      blockers.length ? `the reviewer gate lists ${blockers.length} blocker(s)` : "",
      awaitingFacts && stagingFailedFor(awaitingFacts) ? `the ${awaitingFacts.track} staging run failed before the review screen` : "",
      reviewInfo.gapFillMissing.length ? `${reviewInfo.gapFillMissing.length} required portal field(s) have no project data — add them and re-stage` : "",
      filingGateBlockers.length ? `the submit gate is blocked: ${filingGateBlockers.map((b) => b.nextAction.replace(/[.\s]+$/, "")).join("; ")}` : "",
      draftGaps.length
        ? `the staged ${draftWord}draft went up without ${draftGaps.map((g) => g.label).join("; ")} — ${draftGaps.every((g) => g.onFileNow)
          ? "it is on file now: re-stage to attach it"
          : "get it on file (App Docs → Find missing official forms, or attach it), then re-stage to attach it"}`
        : "",
    ].filter(Boolean).map((r) => r.replace(/[.\s]+$/, ""));
    const canApprove = approveRefusals.length === 0;
    // A sibling track that failed is not a reason to refuse THIS draft — it is said, not gated.
    const siblingNote = stagingFailed.length ? ` Staging failed for ${stagingFailed.map((t) => t.track).join(", ")} — nothing is staged there.` : "";
    const baseMsg = blockers.length
      ? "Staged, but reviewer blockers must be cleared before approval."
      : approvedAwaitingFiling
        ? `Approval recorded. Automation stops here — open the portal, click its submit yourself, then capture the confirmation number below.${canApprove ? "" : ` Not approvable again yet: ${approveRefusals.join("; ")}.`}`
        : !canApprove
          ? `Staged, but not approvable yet: ${approveRefusals.join("; ")}.`
          : "Staged to portal review. Click Approve & Submit to file.";
    return {
      projectId, phase: "awaiting_approval", stage: approvedAwaitingFiling ? "Approved — awaiting your filing" : "Awaiting approval",
      message: baseMsg + siblingNote + gapAdvisory + engineAdvisory,
      blockers, canApprove, approveDisabledReason: canApprove ? null : `Not approvable: ${approveRefusals.join("; ")}.`,
      pauseReason: null, portalRunId: run ? String(run.id) : null, updatedAt: ts,
      ...reviewInfo, ...stageInfo,
    };
  }

  if (jobInFlight) {
    return { projectId, phase: "running", stage: "Autopilot running", message: "Running QC → build → reviewer gate → stage.", blockers: [], canApprove: false, approveDisabledReason: "Autopilot is running.", pauseReason: null, portalRunId: null, updatedAt: ts, ...noReview, ...stageInfo };
  }

  // LIVE BLOCKERS: the operator's block, a failed staging run per track, the per-submission
  // payment gate, and the submit gate's blockers — as they stand NOW.
  const operatorBlock = operatorBlockedOutcome(db, projectId);
  const unpaid = unfinished.filter((t) => t.paymentDue && stillToStage.includes(t.track));
  // AN UNKNOWN MUST NOT READ AS "NOTHING BLOCKS IT NOW". A blocker the last run recorded that
  // none of the live checks above re-derives (a generic 409 — e.g. "staged by another run
  // meanwhile") is kept, marked as the last run's, until a newer portal run supersedes it.
  const LIVE_CODES = new Set([
    "qc_fail", "pending_review", "reviewer_blocker", "historical_missing", "missing_document", "permit_path", "needs_client", "needs_ccb",
    "payment_required", "operator_blocked", "stage_failed", "paused_for_human", "not_pre_stage",
  ]);
  const jobFinishedAt = job?.finished_at == null ? "" : String(job.finished_at);
  const runSinceJob = Boolean(run && jobFinishedAt && String(run.started_at ?? "") > jobFinishedAt);
  const unreproduced = lastRun?.blocked && !runSinceJob ? lastRun.blockers.filter((b) => !LIVE_CODES.has(String(b.code))) : [];
  const liveBlockers: AutopilotBlocker[] = [
    ...(operatorBlock ? [operatorBlock] : []),
    ...stagingFailed.map((t) => ({ code: "stage_failed", detail: `${t.track}: ${t.latestRun?.errorMessage || "the staging run failed before the review screen — see the run's debug bundle"}` })),
    ...(unpaid.length ? [{ code: "payment_required", detail: `Payment required before staging ${unpaid.map((t) => t.track).join(", ")}: this client bills per submission — collect it on the Payment screen, then mark it paid.` }] : []),
    // Only the gate blockers that hold a filing still to be made, each worded for the tracks it
    // holds (gateBlockersForTracks — the Stage button's own answer).
    ...(unfinished.length ? gateBlockersForTracks(db, project, facts.gate, unfinished.map((t) => t.track)).map((b) => ({ code: b.id, detail: b.nextAction })) : []),
    ...unreproduced.map((b) => ({ code: String(b.code), detail: `Last autopilot run: ${b.detail}` })),
  ];
  const notApprovable = { canApprove: false, approveDisabledReason: "Available once the project is staged to the portal review screen." };
  // A FAILED STAGING RUN IS NOT A BLOCK WHEN RE-STAGING IS THE FIX. When the only live blocker
  // is a track whose staging run failed and Stage portals is ENABLED, nothing stands between the
  // operator and the retry — reading BLOCKED beside an enabled button (3b9ce10c) sent them
  // looking for a gate that does not exist. The phase is the failure (the rail's own "failed"
  // wording), and the blockers stay so the reason is still printed. Any other live blocker, or a
  // disabled Stage portals, keeps BLOCKED.
  if (liveBlockers.length && liveBlockers.every((b) => b.code === "stage_failed") && stageInfo.canStage) {
    return {
      projectId, phase: "failed", stage: "Staging failed — re-stage",
      message: nextStep.headline, // the banner's sentence (staging_failed: "…fix the cause, then stage it again")
      blockers: liveBlockers, ...notApprovable, pauseReason: null, portalRunId: run ? String(run.id) : null, updatedAt: ts, ...noReview, ...stageInfo,
    };
  }
  if (liveBlockers.length) {
    return { projectId, phase: "blocked", stage: "Blocked", message: nextStep.headline, blockers: liveBlockers, ...notApprovable, pauseReason: null, portalRunId: null, updatedAt: ts, ...noReview, ...stageInfo };
  }
  // A FAILED job is still the answer while nothing has happened since it — a portal run started
  // after it finished means someone has already moved on from that failure.
  if (jobStatus === "failed") {
    if (!runSinceJob) {
      return { projectId, phase: "failed", stage: "Failed", message: job?.error ? String(job.error) : "Autopilot run failed.", blockers: [], ...notApprovable, pauseReason: null, portalRunId: null, updatedAt: ts, ...noReview, ...stageInfo };
    }
  }

  const message = !job
    ? `Autopilot has not been started for this project. ${nextStep.headline}`
    : lastRun?.blocked
      ? `The last autopilot run stopped on a gate; nothing blocks it now. ${nextStep.headline}`
      : nextStep.headline;
  return { projectId, phase: "idle", stage: "Idle", message, blockers: [], ...notApprovable, pauseReason: null, portalRunId: null, updatedAt: ts, ...noReview, ...stageInfo };
}

// AUTO-RESUME — called (fire-and-forget) from every route that can CLEAR a
// blocker: human-review verify, document upload, payment mark-paid/waive,
// client assignment, correction apply/resolve, and intake submission. If the
// latest autopilot run ended blocked and the project is still pre-stage, a
// fresh Segment A is enqueued so the project re-drives itself to the gate the
// moment the blocker is fixed. Premature resumes are harmless — Segment A
// re-evaluates every gate and simply re-blocks. It can NEVER cross the human
// approval gate: awaiting_human_submit is not in PRE_STAGE_STATUSES, and
// approval still requires the explicit POST /autopilot/approve.
//
// WHO STARTED THE CHAIN. Every autopilot job carries `payload.origin`: "operator" (POST
// /autopilot/start) or "auto_start" (createProject, only when AUTOPILOT_AUTO_START=1). A
// resume copies the origin of the job it resumes, so the ROOT's origin rides the whole chain.
// A chain with no origin is refused: "it only ever relaunches a run the operator started"
// used to rest on a timing heuristic, and production had live portal runs nobody clicked.
//
// SYNCHRONOUS ON PURPOSE. The in-flight check and the insert used to straddle an async
// import(), so N clearing events in one tick (one upload burst) each saw "nothing in flight"
// and each enqueued a Segment A — three parallel live runs on one project, 2026-09-21. The
// read and the insert now happen in ONE transaction with no await between them.
export type AutopilotOrigin = "operator" | "auto_start";

export function autopilotOriginResumable(origin: unknown): origin is AutopilotOrigin {
  if (origin === "operator") return true;
  // Auto-start is opt-in; a chain it began may only continue while it is still opted in.
  if (origin === "auto_start") return process.env.AUTOPILOT_AUTO_START === "1";
  return false;
}

export function maybeResumeAutopilot(db: AppDb, projectId: string, trigger = "a blocker-clearing change"): void {
  try {
    if (process.env.AUTOPILOT_AUTO_START === "0") return;
    db.transaction(() => {
      const project = db.get<Row>("SELECT status FROM projects WHERE id = ?", [projectId]);
      if (!project || !PRE_STAGE_STATUSES.has(String(project.status))) return;
      // ANY queued or running autopilot job means one is already in flight — not only the
      // newest row: an older pending job behind a newer finished one is still in flight.
      const inFlight = db.get<Row>(
        "SELECT id FROM job_queue WHERE project_id = ? AND job_type = 'autopilot' AND status IN ('pending','running') LIMIT 1",
        [projectId],
      );
      if (inFlight) return;
      const job = db.get<Row>(
        "SELECT status, result, payload FROM job_queue WHERE project_id = ? AND job_type = 'autopilot' ORDER BY created_at DESC LIMIT 1",
        [projectId],
      );
      if (!job) return; // never started — nothing to resume
      // Resume ONLY runs that ended blocked on a gate. A FAILED run is an error —
      // it is escalated to the operator (job_failed SSE + review item) and must
      // not be silently relaunched by an unrelated clearing event (that would let
      // e.g. a public intake link repeatedly trigger live browser runs).
      const result = parseJson<{ blocked?: boolean; blockers?: Array<{ code?: string }> } | null>(job.result == null ? null : String(job.result), null);
      if (!result?.blocked) return;
      // PORTAL-RUN OUTCOMES ARE NOT GATES. Segment A also reports blocked:true when the
      // stage itself failed or paused mid-run (stage_failed / paused_for_human, from the
      // portal_runs row). No clearing event fixes those — relaunching would drive an
      // unattended live browser run (and, on a pause, a SECOND browser while the paused
      // one still sits at its MFA/CAPTCHA challenge). Same no-relaunch invariant as a
      // failed job: the operator resumes explicitly. `operator_blocked` likewise: the
      // operator stopped this project on purpose, and lifting the block is not a request
      // to have an unrelated upload relaunch a live portal run.
      if ((result.blockers ?? []).some((b) => b?.code === "stage_failed" || b?.code === "paused_for_human" || b?.code === "operator_blocked")) return;
      // Carry the original run's track — a resume of an NEM-track run must not
      // restage the default track — and its ORIGIN, so the root's origin rides the chain.
      const payload = parseJson<{ track?: string; origin?: unknown } | null>(job.payload == null ? null : String(job.payload), null);
      const origin = payload?.origin;
      if (!autopilotOriginResumable(origin)) return;
      const track = payload?.track;
      // maxRetries 0: staging drives a live portal and is not idempotent —
      // recovery happens through THIS event-driven resume path, never a timer.
      enqueueJob(db, "autopilot", track ? { track, origin, resumeTrigger: trigger } : { origin, resumeTrigger: trigger }, { projectId, priority: 6, maxRetries: 0 });
      logger.info("autopilot", `auto-resume enqueued (${trigger})`, { project: projectId, origin });
      // SAY WHY IT STARTED. This resume only ever relaunches a run whose chain an operator
      // (or the opted-in auto-start) began and that then blocked on a gate, and it can never
      // cross the approval gate. But it left no trace an operator could read, so the first
      // time it fired the report was "I never clicked the autopilot button", and it took a
      // code read to explain. An unexplained autonomous run is indistinguishable from a bug;
      // the audit trail names the trigger and the chain's origin.
      addAuditLog(db, projectId, "system", "autopilot", "autopilot.auto_resumed", {
        trigger,
        because: "an earlier autopilot run stopped on a gate, and this change may have cleared it",
        track: track ?? null,
        origin,
      });
    });
  } catch { /* auto-resume is best-effort — never break the clearing action */ }
}

// SEGMENT A — drive the project automatically to the approval gate. Reuses the
// existing stage functions; prepareSubmission enforces every gate and throws
// HttpError 409 with a structured blocker payload, which we surface as `blocked`.
export async function runAutopilotSegmentA(
  db: AppDb,
  projectId: string,
  track?: SubmittalTrackType,
): Promise<{ blocked: boolean; blockers: AutopilotBlocker[]; message: string; state: AutopilotState }> {
  const t0 = performance.now();
  // THE OPERATOR'S BLOCK IS A HARD STOP. `blocked` is a status a person sets to say "not
  // this project, not now". Segment A has no other project-status gate (see
  // PRE_STAGE_STATUSES), so a queued or explicitly started run would otherwise re-run QC,
  // build and drive a live portal on a project someone deliberately stopped. Refused before
  // anything is written — no QC rerun, no build, no audit of a start that did not happen.
  const operatorBlock = operatorBlockedOutcome(db, projectId);
  if (operatorBlock) {
    logger.info("autopilot", "Segment A refused — the project is blocked by an operator", { project: projectId });
    return { blocked: true, blockers: [operatorBlock], message: operatorBlock.detail, state: getAutopilotState(db, projectId) };
  }
  // EXECUTION-TIME GUARD, PER TRACK. A queued autopilot job may be stale by the time it
  // runs, and staging is NOT idempotent portal-side — a re-run creates a duplicate live
  // application draft. This used to be a PROJECT-status check, which also meant that once
  // the first track staged, the project left the pre-stage statuses and every remaining
  // track was refused: a separate-permit AHJ filed its structural permit and never its
  // electrical one. The check is now "has THIS track already reached the portal", which
  // keeps the anti-duplicate guarantee while letting the other tracks run.
  const currentStatus = String(db.get<Row>("SELECT status FROM projects WHERE id = ?", [projectId])?.status ?? "");
  const pendingTracks = tracksToStage(db, getProjectDetail(db, projectId).project, track);
  if (pendingTracks.length === 0) {
    const msg = track
      ? `The ${track} track is already staged to the portal, so autopilot will not re-stage it. Use the explicit Stage action if a re-stage is intended.`
      : `Every required track is already staged to the portal (project status '${currentStatus || "unknown"}'), so autopilot has nothing to stage. Use the explicit Stage action if a re-stage is intended.`;
    logger.info("autopilot", "Segment A skipped — nothing left to stage", { project: projectId, status: currentStatus, track: track ?? "all" });
    return { blocked: true, blockers: [{ code: "not_pre_stage", detail: msg }], message: msg, state: getAutopilotState(db, projectId) };
  }
  logger.info("autopilot", "Segment A started — QC → build → reviewer gate → stage", { project: projectId, tracks: pendingTracks.join(", ") });
  // Re-run QC ONCE so the project's gate state is fresh before staging (it is
  // project-wide, not per track).
  rerunQc(db, projectId);
  addAuditLog(db, projectId, "system", "autopilot", "autopilot.segment_a_started", { tracks: pendingTracks });

  // BUILD THE PACKET ON THE WAY, not just validate it. The operator's exact words
  // (2026-09-21): autopilot "opens portals and fills them out, but nothing else gets built
  // along the way" — segment A checked the document gates and staged, while the AHJ/NEM
  // package itself only existed if somebody had clicked Build Docs. Same production builder
  // the button calls; it owns the narrow qc_passed -> ready_to_stage edge and refuses it for
  // an empty package, so a failed build reads as a gate block below, never as progress.
  try {
    const { getApplicationDocumentPackage } = await import("./repository");
    const pkg = getApplicationDocumentPackage(db, projectId);
    logger.info("autopilot", "AHJ/NEM document package built en route", { project: projectId, docs: pkg.docs.length });
  } catch (err) {
    // A build failure is not a staging failure yet — prepareSubmission's document gates
    // decide that, with their structured blockers the UI already renders.
    logger.warn("autopilot", "document package build failed en route; the staging gates will rule", {
      project: projectId, err: err instanceof Error ? err.message : String(err),
    });
  }

  // prepareSubmission is imported lazily to avoid a module cycle (repository imports
  // are heavy and this module is imported by the job worker).
  const { prepareSubmission } = await import("./repository");
  // Stage each required track IN SEQUENCE. Sequential, never parallel: each stage drives
  // a live browser on the same per-client persistent profile, and two Chromium instances
  // on one profile directory collide.
  const staged: SubmittalTrackType[] = [];
  const skipped: SubmittalTrackType[] = [];
  const trackBlockers: AutopilotBlocker[] = [];
  for (const t of pendingTracks) {
    // RE-CHECK AT THE MOMENT OF STAGING, not only at the start. pendingTracks was computed
    // before QC, the package build and every earlier track's live portal run (minutes each),
    // and a track can reach the portal in that window through another run. Staging is not
    // idempotent portal-side, so a track that is staged NOW is skipped, and an operator
    // block set while an earlier track was staging stops the run here.
    const blockedNow = operatorBlockedOutcome(db, projectId);
    if (blockedNow) {
      logger.info("autopilot", "Segment A stopped mid-run — the project was blocked by an operator", { project: projectId, track: t });
      const blockers = [...trackBlockers, blockedNow];
      const msg = staged.length ? `Staged ${staged.join(", ")} to portal review, then stopped: ${blockedNow.detail}` : blockedNow.detail;
      return { blocked: true, blockers, message: msg, state: getAutopilotState(db, projectId) };
    }
    if (trackAlreadyStaged(db, projectId, t)) {
      logger.info("autopilot", "Segment A skipped a track that reached the portal while this run was under way", { project: projectId, track: t });
      addAuditLog(db, projectId, "system", "autopilot", "autopilot.track_already_staged", { track: t });
      skipped.push(t);
      continue;
    }
    try {
      await prepareSubmission(db, projectId, t, /* autoSubmit */ false);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        const blockers = blockersFromHttpError(err).map((b) => ({ ...b, detail: `${t}: ${b.detail}` }));
        addAuditLog(db, projectId, "system", "autopilot", "autopilot.blocked", { track: t, blockers });
        logger.warn("autopilot", "Segment A blocked at a gate", { project: projectId, track: t, ms: `${Math.round(performance.now() - t0)}ms`, blockers: blockers.length, reasons: blockers.map((b) => b.code).slice(0, 5) });
        // A project-wide gate (QC, reviewer, documents) blocks every remaining track
        // too — stop rather than re-running the same refusal per track.
        return { blocked: true, blockers: [...trackBlockers, ...blockers], message: err.message, state: getAutopilotState(db, projectId) };
      }
      // The per-submission payment gate throws 402 (assertSubmissionPaid runs first
      // in prepareSubmission). That's a GATE, not a failure — surface it as blocked
      // with a structured blocker so mark-paid/waive can auto-resume the run.
      if (err instanceof HttpError && err.status === 402) {
        const blockers: AutopilotBlocker[] = [{ code: "payment_required", detail: err.message }];
        addAuditLog(db, projectId, "system", "autopilot", "autopilot.blocked", { track: t, blockers });
        logger.warn("autopilot", "Segment A blocked on the payment gate", { project: projectId, track: t, ms: `${Math.round(performance.now() - t0)}ms` });
        return { blocked: true, blockers: [...trackBlockers, ...blockers], message: err.message, state: getAutopilotState(db, projectId) };
      }
      logger.error("autopilot", "Segment A failed", { project: projectId, track: t, ms: `${Math.round(performance.now() - t0)}ms`, err: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    // prepareSubmission resolved — but that only means the DISPATCH ran to completion.
    // The stage itself may have failed or paused; the portal_runs row it just wrote is
    // the authoritative outcome. Report it honestly instead of logging "complete" for a
    // run that never reached the portal's review screen.
    const stageOutcome = segmentAOutcomeFromRun(latestPortalRun(db, projectId, t));
    if (stageOutcome) {
      // One track failing does not invalidate the others — record it and keep going, so a
      // structural permit that staged is not thrown away because the electrical one broke.
      trackBlockers.push({ ...stageOutcome, detail: `${t}: ${stageOutcome.detail}` });
      addAuditLog(db, projectId, "system", "autopilot", "autopilot.blocked", { track: t, blockers: [stageOutcome] });
      logger.warn("autopilot", "Segment A stage did not complete — the portal run reports it", {
        project: projectId, track: t, ms: `${Math.round(performance.now() - t0)}ms`, code: stageOutcome.code,
      });
      continue;
    }
    staged.push(t);
  }
  if (trackBlockers.length) {
    const msg = staged.length
      ? `Staged ${staged.join(", ")} to portal review. ${trackBlockers.length} track(s) did not: ${trackBlockers.map((b) => b.detail).join("; ")}`
      : trackBlockers.map((b) => b.detail).join("; ");
    return { blocked: true, blockers: trackBlockers, message: msg, state: getAutopilotState(db, projectId) };
  }
  if (staged.length === 0) {
    // Every track this run meant to stage was staged by someone else first. Same answer as
    // the up-front "nothing left to stage" — never "Staged  to portal review".
    const msg = `The ${skipped.join(", ")} track(s) reached the portal while this run was under way, so autopilot did not re-stage them. Use the explicit Stage action if a re-stage is intended.`;
    return { blocked: true, blockers: [{ code: "not_pre_stage", detail: msg }], message: msg, state: getAutopilotState(db, projectId) };
  }
  logger.info("autopilot", "Segment A complete — staged to portal review, awaiting human approval", { project: projectId, tracks: staged.join(", "), ms: `${Math.round(performance.now() - t0)}ms` });
  return { blocked: false, blockers: [], message: `Staged ${staged.join(", ")} to portal review; awaiting human approval.`, state: getAutopilotState(db, projectId) };
}

// SEGMENT B — the human-approval action. Authorizes and audit-logs WHO approved
// (a regulatory requirement), then attempts the autonomous final submit. Adapters
// without an autonomous submit leave the project awaiting_human_submit so a human
// finishes in the portal — the approval authorization is recorded either way.
export async function runAutopilotApproval(
  db: AppDb,
  projectId: string,
  options: { approverUserId?: string | null; approverName: string; track?: SubmittalTrackType },
): Promise<AutopilotState> {
  const detail = getProjectDetail(db, projectId);
  const project = detail.project;
  if (project.status !== "awaiting_human_submit") {
    throw new HttpError(409, `Project is not awaiting approval (status: ${project.status}). Only a staged project can be approved.`);
  }
  const run = awaitingPortalRun(db, projectId, options.track);
  // Only the reviewer findings that hold THIS draft's filing (gateScope — the filter the panel's
  // canApprove and the next step's Approve button apply). No draft / an unknown track: every one.
  const runPermitType = run ? String(run.permit_type ?? "") : "";
  const runTrack: SubmittalTrackType | null = options.track
    ?? ((SUBMITTAL_TRACK_TYPES as string[]).includes(runPermitType) ? runPermitType as SubmittalTrackType : null);
  const blockers = reviewerBlockersFor(reviewerBlockerList(db, project), run ? runTrack : null);
  if (blockers.length > 0) {
    throw new HttpError(409, "Cannot approve: reviewer gate still has blockers.", { blockers });
  }
  if (!run) {
    throw new HttpError(409, "No staged portal run is awaiting submission for this project/track.");
  }
  const runId = String(run.id);
  const portalProfileId = run.portal_profile_id == null ? null : String(run.portal_profile_id);

  // PORTAL_AUTOMATION=off REFUSES APPROVAL TOO, not only staging. prepareSubmission stops
  // before any browser (repository.ts), but a run staged by MockPortalAdapter would otherwise
  // reach submitStagedRun below: the mock "clicks final submit" and captureConfirmation stamps
  // a MOCK-/CONF- number and moves the project to `submitted` — on an installation that
  // promised nothing is filed. Refused AFTER every gate above has given its verdict (so an
  // unstaged project still hears the real reason) and BEFORE the approval audit row: an
  // "autopilot.approved" row for an approval that did not happen would be a false record.
  // Nothing is written; status and the staged run are untouched.
  if (portalAutomationDisabled()) {
    throw new HttpError(409,
      "Every gate is clear, but portal automation is off on this installation (PORTAL_AUTOMATION=off), so nothing is approved or submitted. On a live install this records the approval and hands the staged application to a person to file.",
      { portalAutomationDisabled: true },
    );
  }

  // The regulatory authorization — recorded before any submit attempt, with the
  // approver's identity, so the audit trail shows exactly who authorized the filing.
  addAuditLog(db, projectId, "human", options.approverName, "autopilot.approved", {
    portalRunId: runId, approverUserId: options.approverUserId ?? null, track: options.track ?? "permit",
  });
  logger.info("autopilot", "Segment B — human approval authorized, attempting final submit", { project: projectId, portalRun: runId, approver: options.approverName, track: options.track ?? "permit" });

  // Mock runs submit autonomously so the full approval loop is exercisable in
  // tests/rehearsals. STRICT gate: a run is mock ONLY when the run itself recorded that
  // MockPortalAdapter staged it (result_json.actor, stamped at insert). No inference
  // fallbacks: "no portal profile" describes every universal-path run, and "offline mode
  // at APPROVAL time" says nothing about how the run was STAGED — a real run approved
  // while PORTAL_AUTOSEED=0 must not receive a fabricated MOCK-/CONF- confirmation. A
  // legacy pre-actor mock run simply falls to the approved-manual path (harmless in dev).
  const runResult = parseJson<Record<string, unknown>>(String(run.result_json || "{}"), {});
  const isMockRun = String(runResult.actor ?? "") === "MockPortalAdapter";
  if (isMockRun) {
    const { submitStagedRun } = await import("../../portal-bot/src/index");
    const { MockPortalAdapter } = await import("../../portal-bot/src/adapters/mock");
    const result = await submitStagedRun(new MockPortalAdapter(), project as unknown as ProjectRecord, {});
    if (result.ok === true && result.finalSubmitClicked === true) {
      captureConfirmation(db, runId, {
        permitNumber: String(result.capturedPermitNumber ?? ""),
        confirmationNumber: String(result.capturedConfirmationNumber ?? ""),
        submittedBy: `${options.approverName} (approved autopilot)`,
        notes: "Autopilot final submit after human approval (mock portal — no fee paid).",
      });
      addAuditLog(db, projectId, "portal_bot", "MockPortalAdapter", "autopilot.submitted", {
        portalRunId: runId, finalSubmitClickedByAutomation: true, feePaymentAutomated: false,
      });
      logger.info("autopilot", "Segment B — autonomous final submit captured confirmation (mock portal)", { project: projectId, portalRun: runId });
    } else {
      logger.warn("autopilot", "Segment B — mock submit did not complete", { project: projectId, portalRun: runId, ok: result.ok, finalSubmitClicked: result.finalSubmitClicked });
    }
    return getAutopilotState(db, projectId);
  }

  // Real portal: approval is recorded; a human completes the final submit in the portal
  // until a live-verified autonomous submitFromReview exists for the hand-coded adapter.
  addAuditLog(db, projectId, "human", options.approverName, "autopilot.approved_manual_submit", {
    portalRunId: runId,
    note: "Approval authorized. Adapter has no audited autonomous submit; human completes the final submit in the portal.",
  });

  // THE APPROVAL HAS TO SURVIVE THE PAGE RELOAD, OR IT IS NOT A STATE.
  //
  // Until this line the audit row above was the ONLY trace of an approval on a real portal, and
  // no renderer reads the audit trail to decide what a project needs next. So the operator
  // clicked Approve & Submit, the panel recomputed from `projects.status` — still
  // `awaiting_human_submit` — and told them "Staged to portal review. Click Approve & Submit to
  // file." The product had no way to say "approved; now go and file it", and no way to notice
  // that a filing was half-done. Every live portal run in the database is a real one (95 rows:
  // AutoLearnAdapter, RecipeAdapter, NoAdapter — zero mock), so this is the branch every real
  // approval takes.
  //
  // WHAT IS NOT WRITTEN HERE MATTERS AS MUCH AS WHAT IS:
  //  * `status` stays `awaiting_human_submit`. It is the truth (nothing is filed), it is what
  //    this function's own approval gate keys on, and it is what the staged portal_run still
  //    says. Moving it would be the automation claiming a filing that no human has made —
  //    hard rule 1, and the whole point of this round.
  //  * `current_stage` is untouched. A recorded label is a matching key; the prose already on
  //    the row ("PGE staged. Human must verify and submit manually.") keeps saying what it said.
  // stage_detail is the machine field, and this is an additive value in it.
  db.run("UPDATE projects SET stage_detail = ?, updated_at = ? WHERE id = ?", [
    "approved_awaiting_filing" satisfies StageDetail,
    nowIso(),
    projectId,
  ]);

  logger.info("autopilot", "Segment B — approval recorded; real portal has no autonomous submit, human completes final click", { project: projectId, portalRun: runId });
  return getAutopilotState(db, projectId);
}
