// ---------------------------------------------------------------------------
// NEXT STEP — the ONE server-side answer to "what does this project need next, and from whom?"
//
// Before this module the answer was guessed in several places that disagreed: the dashboard's
// client-side nextStepFor/boardAttention, `current_stage` prose (15+ writers, goes stale), the
// autopilot badge replaying an OLD job result, and the gate notes. An operator could read
// "Staged and ready" beside a "Staging Failed" chip, or "BLOCKED" on a project whose gate was
// clean. The operator's goal (verbatim): "ensure an operator can easily understand what is
// needed and next steps."
//
// SHAPE. One pure rule table (decideNextStep) over one facts record (NextStepFacts). Facts are
// loaded in BATCH (loadNextStepFacts) so the project list can carry a compact answer per row
// for a handful of queries per page, and the detail tier (computeNextStep) adds the submit gate
// and the reviewer blockers on top — the two costly inputs (~50ms/project, measured). The list
// therefore says `gateChecked:false`, and its gate-dependent wording never asserts the gate is
// clean. Both tiers run the SAME rule table, so they cannot disagree about anything the list
// tier knows.
//
// FIRST MATCH WINS, in this order (derived from "who is stopped, and how badly"):
//   1  operator_blocked        a person said stop — nothing else matters until lifted
//   2  correction_overdue      an agency stopped a filing AND our clock ran out
//   3  portal_paused           a live browser is waiting on a human at MFA/CAPTCHA
//   4  automation_running      a staging/autopilot job is in flight — wait for it
//   5  staging_failed          a track's newest staging run failed; nothing staged for it
//   6  qc_not_run / qc_failed / qc_review_pending   QC work (QC items only — S6)
//   7  gate_blocked            submit-gate / reviewer blockers (detail tier only)
//   8  gap_fill_missing        a staged draft has required fields with no project data
//   9  resubmit_awaiting_me    a reopened correction form waits for the human resubmit
//  10  staged_awaiting_submit  a staged draft waits for review + approval (per track)
//  11  approved_awaiting_filing  approval recorded, the human filing not captured yet
//  12  fee_due                 the AHJ approved a permit; a person pays the issuance fee
//  13  correction_open         an open (not overdue) correction — owner by triage bucket
//  14  payment_due             a per-submission client's payment gates staging (the 402)
//      ready_to_stage          required tracks with nothing on the portal yet
//  15  filing_untracked        a filing carries no number, so nothing is tracking it
//  16  portal_readings         monitor readings it could not classify (track/ops items)
//  17  waiting_on_agency       everything filed; the AHJ / utility has the ball
//  18  handoff_ready → done → archived → unknown (an unknown never reads as reassurance)
//
// READ-ONLY. Nothing here writes: no audit rows, no reviewer-verdict recording, and the code-
// research enqueue that reviewerGateReportFor/resolvePermitPathForProject trigger for an
// un-profiled jurisdiction is suppressed for the duration of the read (withoutCodeResearch).
//
// IMPORTS. repository ↔ nextStep is a static cycle, used at CALL time only on both sides (the
// same shape as repository ↔ correctionAgent). Nothing at this module's top level touches a
// repository export; keep it that way.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type {
  CorrectionRecord,
  NextStep,
  NextStepCompact,
  NextStepUrgency,
  NextStepWho,
  NextStepWhy,
  ProjectRecord,
  ProjectStatus,
  SubmitGateHold,
  SubmitGateReport,
  SubmittalTrackType,
} from "../../shared/src/types";
import { stageForStatus } from "./projectStage";
import { isTrackDone, requiredTracks, trackPermitTypes } from "./submittalTracks";
import { trackKind } from "./permitMonitor";
import { parseJson } from "./json";
import { billingTrack } from "./submissionFees";
import { findingHoldScope, gateCheckDefaultScope, scopeHoldsTrack, tracksHeld } from "./gateScope";
import { issuingAuthorityForTrack } from "./applicationDocsAgency";
import { parseJobProgressNote } from "./jobProgress";
import { startedAtLabel } from "./formAcquisitionPlan";
import {
  getProjectDetail,
  getSubmitGateReport,
  reviewerGateReportFor,
  isCriticalReviewItem,
  mapCorrection,
  operatorHoldReason,
} from "./repository";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v));

// ── Portal-run result readers (moved from autopilot.ts; autopilot imports them) ─────────
export interface ReviewMismatch {
  field: string;
  expected: string;
  found: string;
}

function gapMissingFrom(data: Record<string, unknown> | undefined): string[] {
  const gf = data?.gapFill as { reportedMissing?: unknown } | undefined;
  const list = gf && Array.isArray(gf.reportedMissing) ? gf.reportedMissing.map((x) => String(x)) : [];
  return Array.from(new Set(list)).slice(0, 20);
}

/** Required portal fields left blank even though the PROJECT HOLDS the value. Separate
 *  from gapMissingFrom on purpose: that list is work only a person can do, this list is
 *  the engine's own failure and must never be phrased as "add them to the project". */
function gapUnfilledDespiteDataFrom(data: Record<string, unknown> | undefined): string[] {
  const gf = data?.gapFill as { unfilledDespiteData?: unknown } | undefined;
  const list = gf && Array.isArray(gf.unfilledDespiteData) ? gf.unfilledDespiteData.map((x) => String(x)) : [];
  return Array.from(new Set(list)).slice(0, 20);
}

/** Review-screen comparison + gap-fill lists from a portal_run's result_json. */
export function reviewInfoFromResultJson(resultJson: unknown): { reviewMismatches: ReviewMismatch[]; reviewAccurate: boolean | null; gapFillMissing: string[]; gapEngineUnfilled: string[]; reviewHandoffNotes: string[] } {
  const empty = { reviewMismatches: [] as ReviewMismatch[], reviewAccurate: null as boolean | null, gapFillMissing: [] as string[], gapEngineUnfilled: [] as string[], reviewHandoffNotes: [] as string[] };
  if (!resultJson) return empty;
  try {
    const result = JSON.parse(String(resultJson)) as Record<string, unknown>;
    // result_json shape: { steps: [{ok, data: {reviewMismatches, reviewAccurate, gapFill}}] }
    const steps = Array.isArray(result.steps) ? result.steps as Array<Record<string, unknown>> : [];
    // gapFill and reviewMismatches live on DIFFERENT steps for different adapters:
    // PowerClerk puts both on the review step, the RecipeAdapter reports gapFill on the
    // fill step and never emits reviewMismatches. Collect each wherever it appears.
    let reviewMismatches: ReviewMismatch[] = [];
    let reviewAccurate: boolean | null = null;
    const gapMissing = new Set<string>(gapMissingFrom(result));
    const gapEngineGaps = new Set<string>(gapUnfilledDespiteDataFrom(result));
    // What the person taking the review page must know (dryrun-0928 B3 / B14): unsaved answers, the
    // portal's own calls the lockdown held back. Its OWN list — never folded into the mismatches.
    const handoffNotes = new Set<string>();
    for (const step of steps) {
      const data = step.data as Record<string, unknown> | undefined;
      if (!data) continue;
      if (!reviewMismatches.length && Array.isArray(data.reviewMismatches)) {
        reviewMismatches = data.reviewMismatches as ReviewMismatch[];
        reviewAccurate = typeof data.reviewAccurate === "boolean" ? data.reviewAccurate : null;
      }
      for (const f of gapMissingFrom(data)) gapMissing.add(f);
      for (const f of gapUnfilledDespiteDataFrom(data)) gapEngineGaps.add(f);
      if (Array.isArray(data.reviewHandoffNotes)) for (const n of data.reviewHandoffNotes) if (typeof n === "string" && n.trim()) handoffNotes.add(n.trim());
    }
    if (!reviewMismatches.length && Array.isArray(result.reviewMismatches)) {
      reviewMismatches = result.reviewMismatches as ReviewMismatch[];
      reviewAccurate = typeof result.reviewAccurate === "boolean" ? result.reviewAccurate : null;
    }
    return { reviewMismatches, reviewAccurate, gapFillMissing: Array.from(gapMissing).slice(0, 20), gapEngineUnfilled: Array.from(gapEngineGaps).slice(0, 20), reviewHandoffNotes: Array.from(handoffNotes).slice(0, 6) };
  } catch { /* ignore parse errors */ }
  return empty;
}

/** Reviewer-gate blockers exactly as the submit gate, prepareSubmission and runAutopilotApproval
 *  judge them: the gate's severities with cached vision verdicts folded in (reviewerGateReportFor,
 *  owner ruling #214). Read-only: withoutCodeResearch suppresses the research enqueue, and the vision
 *  cache is only read. Each blocker carries the filings it holds (gateScope.findingHoldScope, the
 *  answer prepareSubmission filters by), so a reader judging ONE track asks reviewerBlockersFor,
 *  never the bare list. */
export function reviewerBlockerList(db: AppDb, project: ProjectRecord): ReviewerBlocker[] {
  const report = withoutCodeResearch(() => reviewerGateReportFor(db, project));
  return report.findings
    .filter((finding) => finding.severity === "blocker")
    .map((finding) => ({ code: finding.id, detail: finding.title, tracks: tracksHeld(findingHoldScope(finding)) }));
}

export interface ReviewerBlocker { code: string; detail: string; /** The filings it holds; absent = every one. */ tracks?: SubmittalTrackType[] }

/** THE REVIEWER BLOCKERS THAT HOLD A FILING OF `track` (null = an unknown track: every blocker).
 *  The one filter Approve (autopilot), the next step's Approve button and runAutopilotApproval use. */
export function reviewerBlockersFor<T extends ReviewerBlocker>(blockers: T[], track: SubmittalTrackType | null): T[] {
  return blockers.filter((b) => track === null || !b.tracks || b.tracks.includes(track));
}

/** Does a gate blocker hold a filing of `track`? Its per-item `holds` when it carries them, else the
 *  check's own default scope (gateScope.gateCheckDefaultScope: the permit path never holds NEM;
 *  anything else holds every filing — an unknown never clears); a null track is held by every blocker. */
export function gateBlockerHoldsTrack(b: { id: string; holds?: Array<{ tracks: SubmittalTrackType[] }> }, track: SubmittalTrackType | null): boolean {
  if (track === null) return true;
  return b.holds ? b.holds.some((h) => h.tracks.includes(track)) : scopeHoldsTrack(gateCheckDefaultScope(b.id), track);
}

/**
 * Run `fn` with the jurisdiction code-research enqueue suppressed. buildReviewerReportFor and
 * resolvePermitPathForProject call ensureCodeProfilesResearched, which queues a code_research
 * job for an un-profiled jurisdiction — a WRITE. A read must not. ensureCodeProfilesResearched
 * honours SKIP_CODE_RESEARCH=1 synchronously before anything async starts, and everything in
 * `fn` is synchronous, so the toggle cannot leak into other work.
 */
export function withoutCodeResearch<T>(fn: () => T): T {
  const prev = process.env.SKIP_CODE_RESEARCH;
  process.env.SKIP_CODE_RESEARCH = "1";
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SKIP_CODE_RESEARCH;
    else process.env.SKIP_CODE_RESEARCH = prev;
  }
}

// ── Facts ───────────────────────────────────────────────────────────────────────────────
export interface RunLite {
  id: string;
  status: string;
  permitType: string;
  startedAt: string;
  errorMessage: string;
  pauseReason: string | null;
}

export interface TrackFacts {
  track: SubmittalTrackType;
  /** FILED: a `submitted` submissions row in the track's family, or an active tracking target of
   *  it carrying an application number (the filing exists at the agency — the monitor reads it). */
  filed: boolean;
  filedAt: string | null;
  /** isTrackDone — issued / approved on its own kind of target, no correction since. */
  done: boolean;
  /** Newest staging run (run_type prepare_submit) in the track's family. */
  latestRun: RunLite | null;
  /** autopilot.trackAlreadyStaged: a run reached the portal (awaiting/submitted/paused) — Segment A will not stage it again. */
  onPortal: boolean;
  /** Newest awaiting_human_submit run in the family: a draft on the portal waiting for a person. */
  stagedRun: RunLite | null;
  gapFillMissing: string[];
  /** A tracking target of this track's kind reads ready_for_issue (approved, fee due). */
  feeDue: boolean;
  /** The CLIENT's payment for this track is outstanding: a per-submission client with no paid /
   *  waived submission_payments row — exactly what assertSubmissionPaid's 402 refuses on. */
  paymentDue: boolean;
  /** WHO ISSUES THIS TRACK: the utility for NEM; for a permit, the one predicate
   *  (applicationDocsAgency.issuingAuthorityForTrack -> formAuthorityFor), so a county-issued
   *  electrical permit is named as the county's. Optional: absent, the answer falls back to the
   *  AHJ / utility on the facts record (agencyOf). */
  agency?: string;
}

export interface NextStepFacts {
  projectId: string;
  status: ProjectStatus;
  stageDetail: string;
  archived: boolean;
  ahj: string;
  utility: string;
  operatorHold: { reason: string; since: string | null } | null;
  openCorrections: CorrectionRecord[];
  /** step: what the job says it is doing right now (job_queue.progress_note — the automatic chain
   *  names each step), so the banner can show "Checking the AHJ's required official forms… (started
   *  HH:MM)" instead of a bare "running". */
  jobInFlight: { jobType: string; since: string; step?: { label: string; since: string } } | null;
  tracks: TrackFacts[];
  /** The newest correction-reopen run, when it paused for a person and a correction is still open. */
  reopenPause: RunLite | null;
  qcRan: boolean;
  qcFails: Array<{ ruleName: string; message: string }>;
  qcReview: Array<{ issueType: string; fieldName: string }>;
  /** Pending permit_status readings (monitor text it could not classify). */
  portalReadings: number;
  approvedRunIds: string[];
  /** Detail tier only (undefined on the list tier). */
  gate?: { decision: SubmitGateReport["decision"]; blockers: Array<{ id: string; title: string; nextAction: string; holds?: SubmitGateHold[] }> };
  /** Detail tier only: reviewer blockers as the approve route judges them (each with its tracks). */
  reviewerBlockers?: ReviewerBlocker[];
}

const ON_PORTAL = new Set(["awaiting_human_submit", "submitted", "paused_for_human"]);

/** How long a queued/started automatic chain (stage_step) reads as "automation running". A real
 *  chain takes about three minutes (2026-09-28: 2m45s on a Newberg job); past this it is stuck, and
 *  the page shows the real blockers again rather than "nothing to do". */
export const AUTO_CHAIN_FRESH_MS = 15 * 60 * 1000;

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = out.get(k);
    if (arr) arr.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function toRun(r: Row): RunLite {
  return {
    id: s(r.id),
    status: s(r.status),
    permitType: s(r.permit_type),
    startedAt: s(r.started_at),
    errorMessage: s(r.error_message),
    pauseReason: r.pause_reason == null || r.pause_reason === "" ? null : s(r.pause_reason),
  };
}

/**
 * Load the cheap facts for MANY projects in a fixed number of queries (plus isTrackDone for
 * projects that have tracking targets). Pure reads. `projects` must carry parserSnapshot —
 * requiredTracks reads it.
 */
export function loadNextStepFacts(db: AppDb, projects: ProjectRecord[]): Map<string, NextStepFacts> {
  const out = new Map<string, NextStepFacts>();
  if (!projects.length) return out;
  const ids = projects.map((p) => p.id);
  const ph = ids.map(() => "?").join(",");

  const openCorr = groupBy(
    db.query<Row>(`SELECT * FROM corrections WHERE project_id IN (${ph}) AND closed_at IS NULL ORDER BY created_at DESC`, ids).map(mapCorrection),
    (c) => c.projectId,
  );
  const runs = groupBy(
    db.query<Row>(
      `SELECT id, project_id, permit_type, status, started_at, error_message, pause_reason FROM portal_runs
        WHERE project_id IN (${ph}) AND COALESCE(run_type, '') <> 'correction_reopen'
        ORDER BY started_at DESC, rowid DESC`,
      ids,
    ),
    (r) => s(r.project_id),
  );
  const newestReopen = new Map<string, RunLite>();
  for (const r of db.query<Row>(
    `SELECT id, project_id, permit_type, status, started_at, error_message, pause_reason FROM portal_runs
      WHERE project_id IN (${ph}) AND run_type = 'correction_reopen' ORDER BY started_at DESC, rowid DESC`,
    ids,
  )) {
    if (!newestReopen.has(s(r.project_id))) newestReopen.set(s(r.project_id), toRun(r));
  }
  const filed = groupBy(
    db.query<Row>(`SELECT project_id, permit_type, submitted_at FROM submissions WHERE project_id IN (${ph}) AND status = 'submitted' ORDER BY submitted_at DESC`, ids),
    (r) => s(r.project_id),
  );
  const jobs = new Map(
    db.query<Row>(
      `SELECT project_id, job_type, created_at FROM job_queue
        WHERE project_id IN (${ph}) AND status IN ('pending','running') AND job_type IN ('autopilot','prepare_submission')
        ORDER BY created_at ASC`,
      ids,
    ).map((r) => [s(r.project_id), { jobType: s(r.job_type), since: s(r.created_at) }] as const),
  );
  // THE AUTOMATIC CHAIN IS AUTOMATION RUNNING TOO (operator 2026-09-28, a real Newberg job: "Blocked
  // … Site / plot plan … attach it or split it out of the plan set … can we just not have it do this
  // automatically?"). It was doing it: the stage_step chain splits the plan set, reads the bill, runs
  // QC and finds/fills the official forms, and the page listed those very items as the operator's
  // work while the chain ran. A FRESH chain job (queued or started within AUTO_CHAIN_FRESH_MS) reads
  // as automation running; a stale one never does — a chain stuck behind a dead worker must not
  // read as "nothing to do" forever, so the real blockers show again once it is that old.
  const chainFreshSince = new Date(Date.now() - AUTO_CHAIN_FRESH_MS).toISOString();
  for (const r of db.query<Row>(
    `SELECT project_id, created_at, started_at, status, progress_note FROM job_queue
      WHERE project_id IN (${ph}) AND job_type = 'stage_step'
        AND ((status = 'pending' AND created_at >= ?) OR (status = 'running' AND COALESCE(started_at, created_at) >= ?))
      ORDER BY created_at ASC`,
    [...ids, chainFreshSince, chainFreshSince],
  )) {
    // Staging/autopilot in flight keeps its own (more specific) wording.
    if (jobs.has(s(r.project_id))) continue;
    // The step the RUNNING chain is on (its own progress note); a queued one has not started a step.
    const note = s(r.status) === "running" ? parseJobProgressNote(r.progress_note) : null;
    jobs.set(s(r.project_id), { jobType: "stage_step", since: s(r.created_at), ...(note ? { step: note } : {}) });
  }
  const qcFails = groupBy(
    db.query<Row>(`SELECT project_id, rule_name, message FROM qc_results WHERE project_id IN (${ph}) AND qc_status = 'fail' ORDER BY created_at DESC`, ids),
    (r) => s(r.project_id),
  );
  const qcRan = new Set(db.query<Row>(`SELECT DISTINCT project_id FROM qc_results WHERE project_id IN (${ph})`, ids).map((r) => s(r.project_id)));
  const pendingReview = groupBy(
    db.query<Row>(`SELECT project_id, field_name, issue_type, status FROM human_review_items WHERE project_id IN (${ph}) AND status = 'pending'`, ids),
    (r) => s(r.project_id),
  );
  const approvals = groupBy(
    db.query<Row>(`SELECT project_id, details FROM audit_logs WHERE project_id IN (${ph}) AND action = 'autopilot.approved'`, ids),
    (r) => s(r.project_id),
  );
  const withTargets = new Set(db.query<Row>(`SELECT DISTINCT project_id FROM permit_check_targets WHERE project_id IN (${ph}) AND active = 1`, ids).map((r) => s(r.project_id)));
  // The per-submission payment gate's inputs (assertSubmissionPaid), read without the quote
  // refresh it performs: the client's billing mode and each billing track's payment status.
  const clientIds = [...new Set(projects.map((p) => s(p.clientId)).filter(Boolean))];
  const perSubmissionClients = new Set(clientIds.length
    ? db.query<Row>(
        `SELECT id FROM clients WHERE id IN (${clientIds.map(() => "?").join(",")}) AND LOWER(COALESCE(billing_mode, '')) = 'per_submission'`,
        clientIds,
      ).map((r) => s(r.id))
    : []);
  const payments = groupBy(
    db.query<Row>(`SELECT project_id, track, status FROM submission_payments WHERE project_id IN (${ph})`, ids),
    (r) => s(r.project_id),
  );
  const numberedTargets = groupBy(
    db.query<Row>(
      `SELECT project_id, target_type, permit_type FROM permit_check_targets
        WHERE project_id IN (${ph}) AND active = 1 AND COALESCE(application_number, '') <> ''`,
      ids,
    ),
    (r) => s(r.project_id),
  );
  const feeDueKinds = groupBy(
    db.query<Row>(`SELECT project_id, target_type, permit_type FROM permit_check_targets WHERE project_id IN (${ph}) AND active = 1 AND latest_outcome = 'ready_for_issue'`, ids),
    (r) => s(r.project_id),
  );

  const stagedRunIds: string[] = [];
  for (const project of projects) {
    const pid = project.id;
    const tracksRequired = requiredTracks(project);
    const projectRuns = (runs.get(pid) ?? []).map(toRun);
    const projectFiled = filed.get(pid) ?? [];
    const tracks: TrackFacts[] = tracksRequired.map((track) => {
      const family = trackPermitTypes(track);
      const familyRuns = projectRuns.filter((r) => family.includes(r.permitType));
      const filedRow = projectFiled.find((r) => family.includes(s(r.permit_type)));
      const staged = familyRuns.find((r) => r.status === "awaiting_human_submit") ?? null;
      if (staged) stagedRunIds.push(staged.id);
      const kind = track === "nem" ? "nem" : "permit";
      // A numbered tracking target is evidence of a filing: its own tag, or (like isTrackDone's
      // pool) an untagged target of this kind that no required track claims.
      const claimed = new Set(tracksRequired.flatMap(trackPermitTypes));
      const ownsTarget = (r: Row): boolean => family.includes(s(r.permit_type))
        || (trackKind(s(r.target_type), s(r.permit_type)) === kind && !claimed.has(s(r.permit_type)));
      const targetEvidence = (numberedTargets.get(pid) ?? []).some(ownsTarget);
      return {
        track,
        filed: Boolean(filedRow) || targetEvidence,
        filedAt: filedRow ? s(filedRow.submitted_at) || null : null,
        done: withTargets.has(pid) ? isTrackDone(db, pid, track, tracksRequired) : false,
        latestRun: familyRuns[0] ?? null,
        onPortal: familyRuns.some((r) => ON_PORTAL.has(r.status)),
        stagedRun: staged,
        gapFillMissing: [],
        // THIS track's filing reads ready-for-issue — not "some permit filing does". Matched by kind
        // alone, one permit's fee made every permit track "approved", and the banner told the
        // operator the electrical permit was approved while it sat in plan review.
        feeDue: (feeDueKinds.get(pid) ?? []).some(ownsTarget),
        paymentDue: perSubmissionClients.has(s(project.clientId))
          && !(payments.get(pid) ?? []).some((r) => s(r.track) === billingTrack(track) && (s(r.status) === "paid" || s(r.status) === "waived")),
        // A registry read (permitProcess), never the db — the "reads write nothing" invariant holds.
        agency: track === "nem" ? s(project.utility).trim() : issuingAuthorityForTrack(project, track),
      };
    });
    const pending = (pendingReview.get(pid) ?? []).map((r) => ({ status: "pending", fieldName: s(r.field_name), issueType: s(r.issue_type) }));
    const status = project.status;
    let operatorHold: NextStepFacts["operatorHold"] = null;
    if (status === "blocked") {
      const since = db.get<Row>(
        "SELECT created_at FROM audit_logs WHERE project_id = ? AND action = 'project.status_overridden' ORDER BY created_at DESC LIMIT 1",
        [pid],
      );
      operatorHold = { reason: operatorHoldReason(db, pid) ?? "(no reason recorded)", since: since ? s(since.created_at) : null };
    }
    out.set(pid, {
      projectId: pid,
      status,
      stageDetail: s(project.stageDetail),
      archived: Boolean(s(project.archivedAt)),
      ahj: s(project.ahj).trim(),
      utility: s(project.utility).trim(),
      operatorHold,
      openCorrections: openCorr.get(pid) ?? [],
      jobInFlight: jobs.get(pid) ?? null,
      tracks,
      reopenPause: newestReopen.get(pid)?.status === "paused_for_human" && (openCorr.get(pid) ?? []).length ? newestReopen.get(pid)! : null,
      qcRan: qcRan.has(pid),
      qcFails: (qcFails.get(pid) ?? []).map((r) => ({ ruleName: s(r.rule_name), message: s(r.message) })),
      qcReview: pending.filter(isCriticalReviewItem).map((r) => ({ issueType: r.issueType, fieldName: r.fieldName })),
      portalReadings: pending.filter((r) => r.fieldName === "permit_status").length,
      approvedRunIds: (approvals.get(pid) ?? []).map((r) => s(parseJson<Row>(s(r.details), {}).portalRunId)).filter(Boolean),
    });
  }

  // Gap-fill lists for the staged drafts only (result_json can be large; never load it for all runs).
  if (stagedRunIds.length) {
    const rph = stagedRunIds.map(() => "?").join(",");
    const gaps = new Map(
      db.query<Row>(`SELECT id, result_json FROM portal_runs WHERE id IN (${rph})`, stagedRunIds)
        .map((r) => [s(r.id), reviewInfoFromResultJson(r.result_json).gapFillMissing] as const),
    );
    for (const facts of out.values()) {
      for (const t of facts.tracks) if (t.stagedRun) t.gapFillMissing = gaps.get(t.stagedRun.id) ?? [];
    }
  }
  return out;
}

// ── The rule table ──────────────────────────────────────────────────────────────────────

/** Every button id the rule table can emit — a test checks each exists in dashboard.html. */
export const NEXT_STEP_BUTTON_IDS = [
  "applyStatusOverrideBtn",
  "runQcBtn",
  "openReviewerPacketBtn",
  "approveSubmitBtn",
  "startAutopilotBtn",
  "addPermitTargetBtn",
  "copyHandoffPacketBtn",
] as const;
/** Every fixTarget id the rule table can emit — same test. */
export const NEXT_STEP_FIX_TARGETS = [
  "statusOverrideWrap",
  "correctionsPanel",
  "portalRuns",
  "portalRunsPinned",
  "qcResults",
  "reviewItems",
  "submitGate",
  "gapFillList",
  "confirmationForm",
  "submittalTracks",
  "permitTargets",
  "paymentPanel",
] as const;
type ButtonId = typeof NEXT_STEP_BUTTON_IDS[number];
type FixTarget = typeof NEXT_STEP_FIX_TARGETS[number];

// A gate blocker as the ask it makes (the check's title names the CHECK, not the problem —
// "Required documents attached" is what passing looks like). The full nextAction rides in `why`.
const GATE_BLOCKER_ASK: Record<string, string> = {
  "single-project-record": "project fields are missing",
  "submitting-client": "assign the submitting client and its CCB number",
  "permit-path": "confirm the permit path (prescriptive vs engineered)",
  "qc-human-review": "QC failures or pending review items",
  "permit-requirements": "the designer has to clear the reviewer findings",
  // The fix is per document (find the form / upload the blank, or attach / split out) — it rides
  // in the check's nextAction, the `why` line; the headline names only the problem.
  "document-inventory": "required document(s) are missing",
};

const TRACK_NAME: Record<SubmittalTrackType, string> = {
  nem: "interconnection (NEM)",
  building: "building permit",
  electrical: "electrical permit",
  combo: "permit",
  permit: "permit",
  mpu: "panel-upgrade permit",
};

function joinNames(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
function trackList(tracks: TrackFacts[]): string {
  return joinNames(tracks.map((t) => TRACK_NAME[t.track]));
}
/** Who issues this track (TrackFacts.agency — the one predicate), else the facts record's AHJ /
 *  utility. Dry run 2026-09-28, B13: every permit track used to be named as the AHJ's. */
function agencyOf(facts: NextStepFacts, t: TrackFacts): string {
  const own = String(t.agency ?? "").trim();
  if (own) return own;
  return t.track === "nem" ? (facts.utility || "the utility") : (facts.ahj || "the AHJ");
}
/** A track named WITH its issuer — "the building permit (City of X)", "the interconnection (NEM) with
 *  Utility Y". Names who issues it, never whose portal it is (a statewide portal hosts many agencies). */
function trackWithAgency(facts: NextStepFacts, t: TrackFacts): string {
  return t.track === "nem" ? `${TRACK_NAME[t.track]} with ${agencyOf(facts, t)}` : `${TRACK_NAME[t.track]} (${agencyOf(facts, t)})`;
}
function tracksWithAgency(facts: NextStepFacts, tracks: TrackFacts[]): string {
  return joinNames(tracks.map((t) => trackWithAgency(facts, t)));
}
const isAre = (n: number): string => (n === 1 ? "is" : "are");
function why(text: string, fixTarget?: FixTarget): NextStepWhy {
  return fixTarget ? { text: text.slice(0, 240), fixTarget } : { text: text.slice(0, 240) };
}
function btn(id: ButtonId, label: string): { id: string; label: string } {
  return { id, label };
}

const BUCKET_OWNER: Record<string, { who: NextStepWho; ask: string }> = {
  A_we_fix: { who: "me", ask: "fix what the reviewer asked for and resubmit" },
  B_designer_fix: { who: "designer", ask: "the designer has to return revised plans" },
  C_reviewer_clarification: { who: "me", ask: "answer the reviewer's question" },
};
function correctionOwner(c: CorrectionRecord): { who: NextStepWho; ask: string } {
  return BUCKET_OWNER[c.correctionBucket] ?? { who: "me", ask: "triage it and draft the reply" };
}
function correctionWhy(c: CorrectionRecord): NextStepWhy {
  const owner = correctionOwner(c);
  return why(`Correction opened ${c.createdAt.slice(0, 10)}, due ${c.dueAt ?? "?"} — ${owner.ask}.`, "correctionsPanel");
}

/**
 * THE RULE TABLE. Pure: facts in, one answer out. First match wins (order documented at the top
 * of this file). `gateChecked` is true only when facts.gate was supplied.
 */
export function decideNextStep(facts: NextStepFacts): NextStep {
  const stageIndex = stageForStatus(facts.status).index;
  const gateChecked = Boolean(facts.gate);
  const unfinished = facts.tracks.filter((t) => !t.filed && !t.done);
  // THE THREE FLAGS THE CLIENT USED TO RE-DERIVE FROM `key` — each computed here, once, from the
  // facts (allFiled, hasStagedDraft) or from where the rule table actually stopped
  // (gateCanOverrule), so a reordered rule cannot leave a client-side key list behind.
  const allFiled = facts.tracks.length > 0 && unfinished.length === 0;
  const hasStagedDraft = !facts.archived && (unfinished.some((t) => t.stagedRun) || facts.status === "awaiting_human_resubmit");
  // Set once evaluation passes rule 7 (the submit gate). An answer produced after it, on a list
  // tier that never ran the gate, with something still to file, is one rule 7 could have pre-empted.
  let passedGateRule = false;
  const make = (
    key: NextStep["key"], who: NextStepWho, urgency: NextStepUrgency, headline: string,
    whys: NextStepWhy[], button: NextStep["button"], since?: string | null,
  ): NextStep => ({
    key, who, urgency, headline, why: whys.slice(0, 3), button, stageIndex,
    ...(since ? { since } : {}), gateChecked,
    allFiled,
    gateCanOverrule: passedGateRule && !gateChecked && unfinished.length > 0,
    hasStagedDraft,
  });

  if (facts.archived) return make("archived", "nobody", "done", "Archived — nothing is asked of anyone.", [], null);

  // 1. The operator's own stop.
  if (facts.operatorHold) {
    return make("operator_blocked", "me", "today",
      "Blocked by an operator — nothing is staged or filed until the block is lifted.",
      [why(`Reason given: ${facts.operatorHold.reason}`, "statusOverrideWrap")],
      btn("applyStatusOverrideBtn", "Change status"), facts.operatorHold.since);
  }

  // 2. An agency stopped a filing and our clock ran out.
  const overdue = facts.openCorrections.filter((c) => c.isOverdue).sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  if (overdue.length) {
    const first = overdue[0];
    const owner = correctionOwner(first);
    return make("correction_overdue", owner.who, "overdue",
      `A correction is overdue (was due ${first.dueAt}) — ${owner.ask}.`,
      overdue.map(correctionWhy), null, first.dueAt);
  }

  // 3. A live browser is waiting on a human.
  const paused = unfinished.filter((t) => t.latestRun?.status === "paused_for_human");
  if (facts.reopenPause) {
    return make("portal_paused", "me", "today",
      `The correction reopen on the portal is paused for a person (${facts.reopenPause.pauseReason ?? "human input"}) — finish it in the open browser.`,
      [why(`Paused ${facts.reopenPause.startedAt.slice(0, 16).replace("T", " ")}`, "portalRuns")], null, facts.reopenPause.startedAt);
  }
  if (paused.length) {
    // A replay that stopped BEFORE the review page left a draft on the portal: staging again would
    // start a second one. The person finishes that page, continues to review, and submits there.
    const beforeReview = paused[0].latestRun?.pauseReason === "stopped_before_review";
    return make("portal_paused", "me", "today",
      beforeReview
        ? `The ${trackList(paused)} portal run stopped before the portal's review page — finish that page in the open browser (every attachment listed), continue to review, verify and submit there, then record the confirmation.`
        : `The ${trackList(paused)} portal run is paused for a person (${paused[0].latestRun?.pauseReason ?? "human input"}) — finish it in the open browser, then stage again.`,
      paused.map((t) => why(`${TRACK_NAME[t.track]}: paused ${t.latestRun?.startedAt.slice(0, 16).replace("T", " ")}${t.latestRun?.errorMessage ? ` — ${t.latestRun.errorMessage.slice(0, 240)}` : ""}`, "portalRuns")),
      null, paused[0].latestRun?.startedAt);
  }

  // 4. Automation is already doing the next thing.
  if (facts.jobInFlight) {
    // The step the chain is on, as a why line ("Checking the AHJ's required official forms… (started
    // HH:MM UTC)") — a six-minute form search on a never-seen AHJ otherwise reads as nothing happening
    // (operator 2026-09-28: "it looks like its getting lost finding the forms").
    const step = facts.jobInFlight.step;
    return make("automation_running", "nobody", "waiting",
      facts.jobInFlight.jobType === "stage_step"
        ? "Preparing this project automatically — splitting the plan set, reading the bill, running QC and finding/filling the official forms. Nothing to do until it finishes."
        : `${facts.jobInFlight.jobType === "autopilot" ? "Autopilot" : "Staging"} is running — nothing to do until it finishes.`,
      step ? [why(`${step.label} (${startedAtLabel(step.since)})`)] : [], null, facts.jobInFlight.since);
  }

  // 5. The newest staging attempt for a track failed AND no draft of it sits on the portal. A
  //    failed RE-run does not un-stage an earlier draft — that track is staged, not failed.
  const failed = unfinished.filter(stagingFailedFor);
  if (failed.length) {
    return make("staging_failed", "me", "today",
      `Staging failed for the ${trackList(failed)} — the newest run did not reach the review screen. Check the portal run, fix the cause, then stage it again.`,
      failed.map((t) => why(`${TRACK_NAME[t.track]}: ${t.latestRun?.errorMessage || "no error message recorded — see the run's debug bundle"}`, "portalRuns")),
      null, failed[0].latestRun?.startedAt);
  }

  // 6. QC work — only while something is still to be filed.
  if (unfinished.length) {
    if (!facts.qcRan && facts.status === "parsed") {
      return make("qc_not_run", "me", "today", "Run QC to check the data read from the plan set.", [], btn("runQcBtn", "Run QC"));
    }
    if (facts.qcFails.length) {
      return make("qc_failed", "me", "today",
        `QC found ${facts.qcFails.length} problem(s) in the project data — correct them, then re-run QC.`,
        facts.qcFails.map((f) => why(`${f.ruleName}: ${f.message}`, "qcResults")),
        btn("runQcBtn", "Re-run QC"));
    }
    if (facts.qcReview.length) {
      return make("qc_review_pending", "me", "today",
        `${facts.qcReview.length} extracted value(s) need a person's check before staging.`,
        facts.qcReview.map((r) => why(r.issueType || r.fieldName, "reviewItems")), null);
    }
  }

  // 7. Submit-gate / reviewer blockers (detail tier) — only those that hold a filing still to be
  //    made (gateScope: a structural finding does not hold a utility application that is all that
  //    is left, and a blocker holding only filed tracks holds nothing).
  const holding = facts.gate?.decision === "blocked"
    ? facts.gate.blockers.filter((b) => unfinished.some((t) => gateBlockerHoldsTrack(b, t.track)))
    : [];
  if (unfinished.length && holding.length) {
    // Reviewer findings / learned rejection patterns are the DESIGNER's to fix (the plan set
    // changes); every other gate blocker (fields, client/CCB, permit path, documents to attach)
    // is the operator's. The headline is the first blocker's own next action, not its check name.
    const first = holding[0];
    const designer = first.id === "permit-requirements";
    const more = holding.length > 1 ? ` (+${holding.length - 1} more)` : "";
    // Name the filings it holds when it does not hold them all.
    const heldTracks = unfinished.filter((t) => holding.some((b) => gateBlockerHoldsTrack(b, t.track)));
    const partial = heldTracks.length < unfinished.length ? ` — it holds the ${trackList(heldTracks)}` : "";
    return make("gate_blocked", designer ? "designer" : "me", "today",
      `The submit gate is blocked: ${GATE_BLOCKER_ASK[first.id] ?? first.title.toLowerCase()}${more}${partial}.`,
      holding.map((b) => why(b.nextAction, "submitGate")),
      designer ? btn("openReviewerPacketBtn", "Open Correction Packet") : null);
  }
  passedGateRule = true;

  // 8. A staged draft has required portal fields the project has no data for.
  const gapTracks = unfinished.filter((t) => t.stagedRun && t.gapFillMissing.length);
  if (gapTracks.length) {
    const fields = [...new Set(gapTracks.flatMap((t) => t.gapFillMissing))];
    return make("gap_fill_missing", "me", "today",
      `The staged ${trackList(gapTracks)} left ${fields.length} required portal field(s) blank because the project has no data for them — add the data, then re-stage.`,
      [why(`Missing: ${fields.slice(0, 8).join(", ")}${fields.length > 8 ? ", …" : ""}`, "gapFillList")], null,
      gapTracks[0].stagedRun?.startedAt);
  }

  // 9. A reopened correction form waits for the human resubmit.
  if (facts.status === "awaiting_human_resubmit") {
    return make("resubmit_awaiting_me", "me", "today",
      "The correction form is reopened on the portal — review it, click the portal's resubmit yourself, then mark it resubmitted.",
      facts.openCorrections.map(correctionWhy), null);
  }

  // 10/11. Staged drafts waiting on a person (per track).
  const staged = unfinished.filter((t) => t.stagedRun);
  if (staged.length) {
    const approvedRuns = new Set(facts.approvedRunIds);
    const awaitingApproval = staged.filter((t) => !approvedRuns.has(t.stagedRun!.id));
    const approved = staged.filter((t) => approvedRuns.has(t.stagedRun!.id));
    // WHAT IS NOT STAGED YET IS NAMED HERE TOO (dry run 2026-09-28, B13). Rule 10 outranks rule 14
    // on purpose (a draft on the portal waits for a person), so "Ready to stage the electrical
    // permit and interconnection" could never fire while the building draft waited — and an operator
    // who read "Approve & Submit the building permit", filed it and stopped left two tracks unfiled.
    const notStaged = unfinished.filter((t) => !t.onPortal);
    const notStagedTail = notStaged.length
      ? ` The ${trackList(notStaged)} ${isAre(notStaged.length)} not staged yet — stage ${notStaged.length === 1 ? "it" : "them"} next.`
      : "";
    const notStagedWhy = notStaged.length
      ? [why(`Not staged yet: ${tracksWithAgency(facts, notStaged)} — Stage portals skips a track already on the portal.`, "submittalTracks")]
      : [];
    if (awaitingApproval.length) {
      // The draft Approve acts on is the NEWEST awaiting one (autopilot.awaitingPortalRun); it is
      // refused only by a reviewer blocker that holds ITS track (gateScope — the filter
      // getAutopilotState's canApprove applies too).
      const newest = [...awaitingApproval].sort((a, b) => String(b.stagedRun!.startedAt).localeCompare(String(a.stagedRun!.startedAt)))[0];
      const approveRefused = reviewerBlockersFor(facts.reviewerBlockers ?? [], newest.track).length > 0;
      // EACH TRACK WITH ITS OWN ISSUER, and the verbs agree with the count. One merged "the X, Y and
      // Z application is staged on the A and B portal" read as one filing on one portal — it is one
      // draft per track, each reviewed and submitted on its own.
      const what = awaitingApproval.length === 1
        ? `The ${trackWithAgency(facts, awaitingApproval[0])} application is staged on its portal`
        : `Staged for review: the ${tracksWithAgency(facts, awaitingApproval)}`;
      const ask = awaitingApproval.length === 1
        ? (gateChecked ? "review it, approve, then click its submit yourself." : "review it (the project page checks the gate before approval).")
        : (gateChecked ? "review each on its own portal, approve, then click its submit yourself." : "review each on its own portal (the project page checks the gate before approval).");
      return make("staged_awaiting_submit", "me", "today",
        `${what} — ${ask}${notStagedTail}`,
        [
          // What is left to stage first: make() keeps three whys, and the per-track lines fill them.
          ...notStagedWhy,
          // One button, one draft: Approve & Submit acts on the NEWEST awaiting draft only.
          ...(awaitingApproval.length > 1 && !approveRefused
            ? [why(`Approve & Submit acts on the newest draft only — the ${TRACK_NAME[newest.track]}. Each other draft needs its own review and its own submit.`, "portalRunsPinned")]
            : []),
          // The PINNED card: the staged draft renders there, not in the folded history (#portalRuns).
          ...awaitingApproval.map((t) => why(`${TRACK_NAME[t.track]} staged ${t.stagedRun!.startedAt.slice(0, 10)} — automation never clicks the final submit.`, "portalRunsPinned")),
          ...(approved.length ? [why(`Approval already recorded for the ${trackList(approved)} — file it and capture the confirmation.`, "confirmationForm")] : []),
        ],
        approveRefused ? null : btn("approveSubmitBtn", "Approve & Submit"),
        awaitingApproval[0].stagedRun!.startedAt);
    }
    return make("approved_awaiting_filing", "me", "today",
      approved.length === 1
        ? `Approval recorded — the ${trackWithAgency(facts, approved[0])} application is NOT filed yet: click its submit on its portal, then capture the confirmation number.${notStagedTail}`
        : `Approval recorded — the ${tracksWithAgency(facts, approved)} applications are NOT filed yet: click each one's submit on its own portal, then capture each confirmation number.${notStagedTail}`,
      [...notStagedWhy, why("Until the confirmation is captured, nothing is tracking this filing.", "confirmationForm")], null,
      approved[0].stagedRun!.startedAt);
  }

  // 12. Approved by the AHJ, issuance fee due (a person pays — automation never does).
  const feeDue = facts.tracks.filter((t) => t.feeDue && !t.done);
  if (feeDue.length) {
    return make("fee_due", "me", "today",
      `${joinNames(feeDue.map((t) => `${agencyOf(facts, t)} approved the ${TRACK_NAME[t.track]}`))} — pay the issuance fee in the portal (automation never pays fees).`,
      [], null);
  }

  // 13. An open correction that is not yet overdue.
  if (facts.openCorrections.length || facts.status === "waiting_on_designer") {
    const first = facts.openCorrections[0];
    const owner = first ? correctionOwner(first) : { who: "designer" as NextStepWho, ask: "the designer has to return revised plans" };
    const designer = owner.who === "designer" || facts.status === "waiting_on_designer";
    return make("correction_open", designer ? "designer" : owner.who, designer ? "waiting" : "today",
      designer
        ? `Waiting on the designer for revised plans${first?.dueAt ? ` (correction due ${first.dueAt})` : ""}.`
        : `A correction is open${first?.dueAt ? ` (due ${first.dueAt})` : ""} — ${owner.ask}.`,
      facts.openCorrections.map(correctionWhy), null, first?.createdAt);
  }

  // 14. Required tracks with nothing on the portal yet.
  const toStage = unfinished.filter((t) => !t.onPortal);
  // A per-submission client's payment gates staging (the 402) — say so before "stage it".
  const unpaid = toStage.filter((t) => t.paymentDue);
  if (unpaid.length) {
    return make("payment_due", "customer", "today",
      `Payment is due before staging the ${trackList(unpaid)} — this client bills per submission; collect it, then mark it paid.`,
      [why("Staging refuses until the submission is paid or waived.", "paymentPanel")], null);
  }
  if (toStage.length) {
    if (stageIndex >= stageForStatus("submitted").index) {
      // Past Submit: the big Stage button is disabled (S8) — stage the one track from its card.
      return make("ready_to_stage", "me", "today",
        `The ${trackList(toStage)} filing has not been made — stage it from its track card.`,
        [why(`${toStage.length} required filing(s) not on any portal yet.`, "submittalTracks")], null);
    }
    return make("ready_to_stage", "me", "today",
      gateChecked
        ? `Ready to stage the ${trackList(toStage)} — press Stage portals; automation stops at the review screen.`
        : `Next: stage the ${trackList(toStage)} (the project page checks the submit gate first).`,
      [why("Automation fills the application to its review screen and stops; a person clicks the final submit.")],
      btn("startAutopilotBtn", "Stage portals · Autopilot"));
  }

  // 15. A filing with no number is tracked by nobody.
  if (facts.stageDetail === "submitted_untracked") {
    return make("filing_untracked", "me", "today",
      "A filing was captured without an application number, so nothing is tracking it — add the number under Permit/NEM Checks.",
      [], btn("addPermitTargetBtn", "Add tracking target"));
  }

  // Everything left is on file (or on the portal); what is not done is the agency's.
  const notDone = facts.tracks.filter((t) => !t.done);

  // 16. Monitor readings it could not classify (track/ops items, not QC).
  if (facts.portalReadings > 0 && notDone.length) {
    return make("portal_readings", "me", "today",
      `Confirm ${facts.portalReadings} portal status reading(s) the monitor could not classify.`,
      notDone.map((t) => why(`${TRACK_NAME[t.track]}: waiting on ${agencyOf(facts, t)}`, "permitTargets")), null);
  }

  // 17. Filed; the agency has the ball.
  if (notDone.length) {
    const permitWaiting = notDone.some((t) => t.track !== "nem");
    const since = facts.tracks.map((t) => t.filedAt ?? "").filter(Boolean).sort().pop();
    return make("waiting_on_agency", permitWaiting ? "ahj" : "utility", "waiting",
      `Filed — waiting on ${joinNames(notDone.map((t) => `${agencyOf(facts, t)} for the ${TRACK_NAME[t.track]}`))}.`,
      notDone.map((t) => why(`${TRACK_NAME[t.track]} filed${t.filedAt ? ` ${t.filedAt.slice(0, 10)}` : ""}; the monitor checks for changes.`, "permitTargets")),
      null, since);
  }

  // 18. Closeout.
  if (facts.status === "handoff_ready") {
    return make("handoff_ready", "me", "done",
      "Permit issued and interconnection approved — send the installer the handoff packet.",
      [], btn("copyHandoffPacketBtn", "Copy handoff packet"));
  }
  if (facts.tracks.length && facts.tracks.every((t) => t.done)) {
    return make("done", "nobody", "done", "Every required filing is issued / approved.", [], null);
  }
  return make("unknown", "me", "today",
    `The next step could not be worked out from this project's records (status ${facts.status}) — open it and check.`, [], null);
}

/** A required track's staging FAILED: its newest staging run failed and no draft of it is on
 *  the portal awaiting a person. The one predicate for nextStep and the autopilot panel. */
export function stagingFailedFor(t: TrackFacts): boolean {
  return !t.filed && !t.done && t.latestRun?.status === "failed" && !t.stagedRun;
}

export function compactNextStep(step: NextStep): NextStepCompact {
  return {
    key: step.key, who: step.who, urgency: step.urgency, headline: step.headline, buttonId: step.button?.id ?? null,
    gateChecked: step.gateChecked, allFiled: step.allFiled, gateCanOverrule: step.gateCanOverrule, hasStagedDraft: step.hasStagedDraft,
  };
}

/** Detail-tier facts: the cheap facts plus the submit gate and the approve-route reviewer blockers. */
export function loadFullNextStepFacts(db: AppDb, projectId: string): NextStepFacts {
  const project = getProjectDetail(db, projectId).project;
  const facts = loadNextStepFacts(db, [project]).get(projectId)!;
  return withoutCodeResearch(() => {
    const gate = getSubmitGateReport(db, projectId);
    return {
      ...facts,
      gate: {
        decision: gate.decision,
        blockers: gate.checks.filter((c) => c.status === "blocker").map((c) => ({ id: c.id, title: c.title, nextAction: c.nextAction, ...(c.holds ? { holds: c.holds } : {}) })),
      },
      reviewerBlockers: reviewerBlockerList(db, project),
    };
  });
}

/** S1 — the full answer for one project. READ-ONLY. */
export function computeNextStep(db: AppDb, project: ProjectRecord | string): NextStep {
  const projectId = typeof project === "string" ? project : project.id;
  return decideNextStep(loadFullNextStepFacts(db, projectId));
}
