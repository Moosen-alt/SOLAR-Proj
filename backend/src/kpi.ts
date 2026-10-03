import { DEFAULT_ORG_ID } from "./db";
import type { AppDb, SqlParam } from "./db";
import { mergeStepReport, MIN_CONFIRMED_FIELDS } from "./replayBenchmark";
import type { CorrectionTrack } from "../../shared/src/types";
import { HttpError } from "./httpError";
import { findKnowledgeForLearn, knowledgeProfileKey, seededDeficiencyCureDays } from "./knowledgeBase";
import { trackForTarget } from "./timelineSamples";
import { documentInventory, isApplicationFormRow } from "./requiredDocuments";
import { DOC_TYPE_ALIASES } from "./projectDocuments";
import { parseJson } from "./json";

type Row = Record<string, SqlParam>;

/**
 * HOW WELL THE AUTOMATION IS ACTUALLY FILING — measured on real production runs.
 *
 * Every other number here is about the business: how long a permit took, how many
 * corrections came back. None of them say whether the robot did its job, and the two are
 * not the same question. A filing staged with three blank required fields still reaches
 * handoff on time, because a human quietly filled them in — the cost lands on a person's
 * afternoon and shows up nowhere.
 *
 * These come from `portal_runs.result_json`, which has always stored the whole run report
 * (the replay's blanks, drift warnings and review-screen check), so this is computed from
 * history rather than requiring new instrumentation — the numbers below are real for runs
 * that already happened. Same definitions as the replay benchmark, via the same reader, so
 * a lab score and a production score cannot mean different things.
 */
export interface StagingQuality {
  runs: number;
  /** Runs whose report could be read at all. */
  measured: number;
  /** Nothing blank, nothing that failed to land, no drift warnings. */
  clean: number;
  cleanRate: number;
  /** Clean AND the portal's own review screen agreed with the project. */
  verified: number;
  verifiedRate: number;
  /** Runs that handed a person something to finish. */
  neededHuman: number;
  avgBlanksPerRun: number;
  /** How many required fields the portals asked for, per run — the denominator under
   *  avgBlanksPerRun. Zero blanks out of thirty required and zero blanks out of nothing
   *  seen are the same headline and opposite facts. */
  avgRequiredPerRun: number;
  /** CLEAN RUNS THAT NEVER SAW A REQUIRED FIELD. Not a failure and not a success: a score
   *  nothing can falsify. If this climbs, the sweep has stopped reaching the pages it is
   *  meant to check and the clean rate above it is drifting loose from the portals. */
  blindClean: number;
  /** The fields most often left blank — what to fix first, in order. */
  topGaps: Array<{ field: string; runs: number }>;
  /** Portals whose replays are drifting: re-anchored selectors, values not holding. */
  driftingPortals: Array<{ portal: string; runs: number }>;
}

/** A cycle-time distribution in days. Every number carries its n; median/p90 are null when n = 0. */
export interface CycleStat {
  median: number | null;
  p90: number | null;
  n: number;
}

/** Complete packages not yet submitted, and how many have waited longer than `olderThanDays`. */
export interface AwaitingSubmit {
  n: number;
  olderThanDays: number;
  overAge: number;
}

export interface KpiReport {
  period: { start: string; end: string };
  projectsSubmitted: number;
  projectsHandedOff: number;        // permit issued + NEM approved — our completion metric
  avgPermitCycleDays: number | null; // submit → permit issued
  avgNemCycleDays: number | null;    // submit → NEM approved
  avgTotalCycleDays: number | null;  // submit → handoff_ready (both complete)
  /** PROJECT-LEVEL: % of submitted projects with any correction on any filing. Not a per-filing
   *  first-pass rate — that reads filing_metrics / correctionsByTrack. */
  correctionRate: number;
  /** Correction ITEMS per project, all tracks together (a notice of eight items counts eight). */
  avgCorrectionsPerProject: number;
  /** Corrections in the period by filing track ("unknown" when no filing could be named):
   *  notices = cycles (distinct notice_id), items = rows. */
  correctionsByTrack: Array<{ track: string; notices: number; items: number }>;
  openCorrections: number;
  overdueCorrections: number;
  slaBreachRate: number;
  throughputPerWeek: number;         // handoffs per week in period
  /** Complete package received → submitted (package_complete_at → submitted_at), for projects
   *  SUBMITTED in the period. Keelix's own turnaround SLA. */
  packageToSubmitDays: CycleStat;
  /** Complete packages with no submission yet — outside the cycle above, counted here instead. */
  packageAwaitingSubmit: AwaitingSubmit;
  /** Per client: a client who trickles documents owns that delay, so it is theirs to see. */
  byClient: Array<{
    clientId: string;
    clientName: string;
    packageToSubmitDays: CycleStat;
    awaitingSubmit: AwaitingSubmit;
  }>;
  /** How well the automation filled, not just how fast the business moved. */
  stagingQuality: StagingQuality;
  byUser: Array<{
    userId: string;
    userName: string;
    submitted: number;
    handedOff: number;
    openProjects: number;
    overdueCorrections: number;
    avgCycleDays: number | null;
  }>;
}

export interface ProjectMetricsRecord {
  projectId: string;
  submittedAt: string | null;
  permitIssuedAt: string | null;
  nemApprovedAt: string | null;
  ptoAt: string | null;
  /** When the client's package became complete (#48): see derivePackageCompleteAt. */
  packageCompleteAt: string | null;
  firstCorrectionAt: string | null;
  lastCorrectionAt: string | null;
  correctionCount: number;
  permitCycleDays: number | null;
  nemCycleDays: number | null;
  totalCycleDays: number | null;
  slaBreaches: number;
  assignedUserId: string | null;
  updatedAt: string;
}

function mapMetrics(row: Row): ProjectMetricsRecord {
  return {
    projectId: String(row.project_id),
    submittedAt: row.submitted_at == null ? null : String(row.submitted_at),
    permitIssuedAt: row.permit_issued_at == null ? null : String(row.permit_issued_at),
    nemApprovedAt: row.nem_approved_at == null ? null : String(row.nem_approved_at),
    ptoAt: row.pto_at == null ? null : String(row.pto_at),
    packageCompleteAt: row.package_complete_at == null ? null : String(row.package_complete_at),
    firstCorrectionAt: row.first_correction_at == null ? null : String(row.first_correction_at),
    lastCorrectionAt: row.last_correction_at == null ? null : String(row.last_correction_at),
    correctionCount: Number(row.correction_count ?? 0),
    permitCycleDays: row.permit_cycle_days == null ? null : Number(row.permit_cycle_days),
    nemCycleDays: row.nem_cycle_days == null ? null : Number(row.nem_cycle_days),
    totalCycleDays: row.total_cycle_days == null ? null : Number(row.total_cycle_days),
    slaBreaches: Number(row.sla_breaches ?? 0),
    assignedUserId: row.assigned_user_id == null ? null : String(row.assigned_user_id),
    updatedAt: String(row.updated_at),
  };
}

function daysBetweenIso(a: string, b: string): number {
  return Math.round(((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000) * 10) / 10;
}

function avg(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

// ---------------------------------------------------------------------------
// WHICH FILING A CORRECTION ANSWERS (#47).
//
// A project files building, electrical and NEM separately; a first-pass rate per permit and a
// deficiency rate per interconnection need a per-filing denominator, and a utility deficiency
// must never count as a permit correction. The track comes from the FILING — the submissions row
// a person sent (submission_type / permit_type), or the tracking target the notice was read on —
// never from the notice's prose. Nothing to say which filing it is: '' (unknown), reported so.
// ---------------------------------------------------------------------------

/** The 5-day default every correction carried before cure windows came from the utility. */
export const DEFAULT_CORRECTION_SLA_DAYS = 5;

/** The track of one submissions row. 'permit' is the legacy one-permit filing (trackPermitTypes
 *  files it with combo); a permit_type nothing knows is unknown, not a guess. */
export function filingTrackOf(submissionType: unknown, permitType: unknown): CorrectionTrack {
  const pt = String(permitType ?? "").trim().toLowerCase();
  if (String(submissionType ?? "") === "interconnection" || pt === "nem") return "nem";
  if (pt === "building" || pt === "structural") return "building";
  if (pt === "electrical" || pt === "mpu") return pt;
  if (pt === "combo" || pt === "permit") return "combo";
  return "";
}

export interface CorrectionFilingInput {
  /** The filing a person named (the corrections route). Must be this project's. */
  submissionId?: string | null;
  /** The tracking target the notice was read on (the permit monitor / email tracker). */
  targetType?: string;
  permitType?: string;
  /** The notice's own date — picks the filing that was out when it arrived. */
  noticedAt?: string | null;
}

export function resolveCorrectionFiling(
  db: AppDb,
  projectId: string,
  input: CorrectionFilingInput,
): { track: CorrectionTrack; submissionId: string | null } {
  if (input.submissionId) {
    const named = db.get<Row>(
      "SELECT id, submission_type, permit_type FROM submissions WHERE id = ? AND project_id = ?",
      [input.submissionId, projectId],
    );
    // Another project's filing is not found, never named (rule 6: out of scope is a 404).
    if (!named) throw new HttpError(404, "Submission not found on this project.");
    return { track: filingTrackOf(named.submission_type, named.permit_type), submissionId: String(named.id) };
  }
  if (!input.targetType && !input.permitType) return { track: "", submissionId: null };

  // The target's track by the ONE target answer (trackForTarget → trackKind). "permit" is an AHJ
  // target tagged to no discipline: it answers whichever permit filing the project has, if only one.
  const hinted = trackForTarget(String(input.targetType ?? ""), String(input.permitType ?? ""));
  const hintedTrack: CorrectionTrack = hinted === "permit" ? "" : filingTrackOf("", hinted);
  const sent = db.query<Row>(
    `SELECT id, submission_type, permit_type, submitted_at FROM submissions
      WHERE project_id = ? AND submitted_at IS NOT NULL AND TRIM(submitted_at) <> '' AND status <> 'failed'
      ORDER BY submitted_at DESC`,
    [projectId],
  ).map((r) => ({ id: String(r.id), track: filingTrackOf(r.submission_type, r.permit_type), submittedAt: String(r.submitted_at) }));
  const matching = sent.filter((f) => (hinted === "permit" ? f.track !== "" && f.track !== "nem" : f.track === hintedTrack));
  const tracks = new Set(matching.map((f) => f.track));
  if (!matching.length || tracks.size > 1) return { track: hintedTrack, submissionId: null };
  // The filing that was out when the notice arrived: the latest one sent at or before it.
  const at = input.noticedAt ? Date.parse(input.noticedAt) : Date.now();
  const answered = matching.find((f) => Date.parse(f.submittedAt) <= at) ?? matching[matching.length - 1];
  return { track: answered.track, submissionId: answered.id };
}

/**
 * A utility's cure window for an interconnection deficiency: the utility's own knowledge record
 * (permit_utility_knowledge.deficiency_cure_days), then the seed for a utility whose row has not
 * been stamped yet, then the 5-day default. Never a number written at the correction insert.
 */
export function utilityDeficiencyCureDays(db: AppDb, project: { state?: string; utility?: string }): number {
  // The UTILITY's row (state|—|utility, the key timeline samples and the utility resolver use),
  // exact first, then the fuzzy name match (operator short names) — but only a utility-only row:
  // an AHJ+utility project profile is the jurisdiction's record, not the utility's.
  const readDays = (where: string, param: string): number =>
    Number(db.get<Row>(`SELECT deficiency_cure_days AS d FROM permit_utility_knowledge WHERE ${where} AND ahj = ''`, [param])?.d ?? 0);
  if (project.utility) {
    const exact = readDays("profile_key = ?", knowledgeProfileKey({ state: project.state, ahj: "", utility: project.utility }));
    if (exact > 0) return exact;
    const fuzzy = findKnowledgeForLearn(db, { state: project.state, utility: project.utility }).utility;
    const matched = fuzzy ? readDays("id = ?", fuzzy.id) : 0;
    if (matched > 0) return matched;
  }
  return seededDeficiencyCureDays(project.state, project.utility) ?? DEFAULT_CORRECTION_SLA_DAYS;
}

/** What every corrections INSERT stamps beside the text: the filing, the notice, the cure clock. */
export function correctionFilingStamp(
  db: AppDb,
  project: { id: string; state?: string; utility?: string },
  correctionId: string,
  createdAt: string,
  input: CorrectionFilingInput & { noticeId?: string | null },
): { track: CorrectionTrack; submissionId: string | null; noticeId: string; noticedAt: string | null; slaDays: number; dueAt: string } {
  const parsed = input.noticedAt ? Date.parse(input.noticedAt) : NaN;
  const noticedAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  const { track, submissionId } = resolveCorrectionFiling(db, project.id, { ...input, noticedAt });
  const slaDays = track === "nem" ? utilityDeficiencyCureDays(db, project) : DEFAULT_CORRECTION_SLA_DAYS;
  // The clock starts on the notice's own date, not when we happened to ingest it.
  const dueAt = new Date(Date.parse(noticedAt ?? createdAt) + slaDays * 86_400_000).toISOString().slice(0, 10);
  // One insert is one notice unless the caller groups several items under the notice's own id.
  const noticeId = String(input.noticeId ?? "").trim().slice(0, 120) || correctionId;
  return { track, submissionId, noticeId, noticedAt, slaDays, dueAt };
}

/** Per-filing metrics: one row per submissions row a person sent. Counts and dates only. */
function touchFilingMetrics(db: AppDb, projectId: string, now: string): void {
  const filings = db.query<Row>(
    `SELECT id, submission_type, permit_type, submitted_at FROM submissions
      WHERE project_id = ? AND submitted_at IS NOT NULL AND TRIM(submitted_at) <> '' AND status <> 'failed'`,
    [projectId],
  );
  // The readings that finish a track, with the track of the target each was read on.
  const finishes = db.query<Row>(
    `SELECT c.outcome, c.created_at, t.target_type, t.permit_type FROM permit_status_checks c
       JOIN permit_check_targets t ON t.id = c.target_id
      WHERE c.project_id = ? AND c.outcome IN ('issued', 'nem_approved') ORDER BY c.created_at ASC`,
    [projectId],
  ).map((r) => ({ outcome: String(r.outcome), at: String(r.created_at), target: trackForTarget(String(r.target_type ?? ""), String(r.permit_type ?? "")) }));
  for (const f of filings) {
    const track = filingTrackOf(f.submission_type, f.permit_type);
    const submittedAt = String(f.submitted_at);
    const finished = track ? finishes.find((r) =>
      r.outcome === (track === "nem" ? "nem_approved" : "issued") && r.at >= submittedAt
      && (filingTrackOf("", r.target) === track || (r.target === "permit" && track !== "nem"))) : undefined;
    const notices = db.get<Row>(
      `SELECT MIN(COALESCE(noticed_at, created_at)) AS first_at, COUNT(DISTINCT COALESCE(notice_id, id)) AS notices, COUNT(*) AS items
         FROM corrections WHERE submission_id = ?`,
      [String(f.id)],
    );
    db.run(
      `INSERT INTO filing_metrics (submission_id, project_id, track, submitted_at, finished_at, first_notice_at, notice_count, item_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(submission_id) DO UPDATE SET
         track = excluded.track, submitted_at = excluded.submitted_at, finished_at = excluded.finished_at,
         first_notice_at = excluded.first_notice_at, notice_count = excluded.notice_count,
         item_count = excluded.item_count, updated_at = excluded.updated_at`,
      [String(f.id), projectId, track, submittedAt, finished?.at ?? null, notices?.first_at == null ? null : String(notices.first_at),
        Number(notices?.notices ?? 0), Number(notices?.items ?? 0), now],
    );
  }
}

/** Nearest-rank percentile of an ascending-sorted list, to one decimal. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const v = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  return Math.round(v * 10) / 10;
}

function cycleStat(values: number[]): CycleStat {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: percentile(sorted, 50), p90: percentile(sorted, 90), n: sorted.length };
}

/** Audit action written whenever QC moves a project's status (qc.ts): details `{ from, to }`. */
export const QC_STATUS_WRITTEN_ACTION = "project.qc_status_written";

/**
 * WHEN QC LAST CAME TO "PASSED", or null when its latest verdict is a failure (or none is on
 * record). Read from the audit log because projects.status keeps only the latest verdict and
 * qc_results is replaced on every run. Facts, oldest first: the status QC wrote
 * (QC_STATUS_WRITTEN_ACTION), an operator's override to qc_passed / qc_failed, and — for history
 * written before that action existed — the qc_completed / qc_rerun rows that say QC moved the
 * status (statusWritten) and with how many failures. Only facts at or before `cutoff` count.
 */
function qcPassedAt(db: AppDb, projectId: string, cutoff: string | null): string | null {
  const facts = qcVerdictFacts(db, projectId, cutoff);
  if (facts.passedAt) return facts.passedAt;
  // LEGACY PASSES. A project at qc_passed whose pass came through a door that writes no fact
  // (updateProject, a workflow, humanVerify — or any pass before QC_STATUS_WRITTEN_ACTION existed)
  // would otherwise never be stamped. Its latest QC run (qc_results is replaced on every run) is the
  // best evidence on record of when it passed — but only a run after the last verdict fact, since a
  // run before a recorded failure cannot be the pass that followed it.
  const status = db.get<Row>("SELECT status FROM projects WHERE id = ?", [projectId])?.status;
  if (status !== "qc_passed") return null;
  const lastRun = db.get<Row>(
    `SELECT MAX(created_at) AS t FROM qc_results WHERE project_id = ?${cutoff ? " AND created_at <= ?" : ""}`,
    [projectId, ...(cutoff ? [cutoff] : [])],
  )?.t;
  if (lastRun == null) return null;
  return facts.lastVerdictAt && String(lastRun) <= facts.lastVerdictAt ? null : String(lastRun);
}

/** The QC verdict facts in the audit log: when the current pass began (null if the latest verdict
 *  is a failure or there is none) and when the latest verdict of either kind was written. */
function qcVerdictFacts(db: AppDb, projectId: string, cutoff: string | null): { passedAt: string | null; lastVerdictAt: string | null } {
  const rows = db.query<Row>(
    `SELECT action, details, created_at FROM audit_logs
      WHERE project_id = ? AND action IN (?, 'project.status_overridden', 'project.qc_completed', 'project.qc_rerun')
        ${cutoff ? "AND created_at <= ?" : ""}
      ORDER BY created_at ASC`,
    [projectId, QC_STATUS_WRITTEN_ACTION, ...(cutoff ? [cutoff] : [])],
  );
  let passedAt: string | null = null;
  let lastVerdictAt: string | null = null;
  for (const row of rows) {
    const d = parseJson<Record<string, unknown>>(String(row.details ?? "{}"), {});
    let verdict: "pass" | "fail" | null = null;
    if (row.action === QC_STATUS_WRITTEN_ACTION || row.action === "project.status_overridden") {
      verdict = d.to === "qc_passed" ? "pass" : d.to === "qc_failed" ? "fail" : null;
    } else if (d.statusWritten === true) {
      verdict = Number(d.failCount ?? 0) > 0 ? "fail" : "pass";
    }
    if (verdict) lastVerdictAt = String(row.created_at);
    if (verdict === "fail") passedAt = null;
    // A pass written while already passing (a legacy row beside the new one) is the same moment's news.
    else if (verdict === "pass" && passedAt === null) passedAt = String(row.created_at);
  }
  return { passedAt, lastVerdictAt };
}

/**
 * WHEN EVERY REQUIRED INTAKE DOCUMENT WAS PRESENT, or null when one is missing now.
 *
 * WHICH documents: the inventory's own blocking rows (documentInventory — the one answer the QC
 * rows, the packet and the staging gate already give), minus the permit APPLICATIONS, which Keelix
 * builds and fills; they are not something the client hands over. WHEN: the newest upload among the
 * document types that satisfy each row — so a replaced document re-times its row — and the latest
 * of those across rows. A row satisfied inside the plan set is timed by the plan set. A row with no
 * upload behind it contributes no time. Only uploads at or before `cutoff` count.
 */
function intakeCompleteAt(db: AppDb, projectId: string, cutoff: string | null): string | null {
  const row = db.get<Row>("SELECT id, parser_json, ahj, state, utility, system_size_dc_kw FROM projects WHERE id = ?", [projectId]);
  if (!row) return null;
  const payload = parseJson<Record<string, unknown>>(String(row.parser_json ?? "{}"), {});
  // The same project shape QC hands documentInventory, so the two cannot disagree about the list.
  const projectLike = {
    id: projectId,
    ahj: String(row.ahj ?? "") || String(payload.ahj ?? ""),
    state: String(row.state ?? "") || String(payload.state ?? ""),
    utility: String(row.utility ?? "") || String(payload.utility ?? ""),
    systemSizeDcKw: row.system_size_dc_kw == null ? null : Number(row.system_size_dc_kw),
    parserSnapshot: payload,
  } as never;
  // An unreadable knowledge base refuses (503) rather than reporting "nothing missing": no answer,
  // no stamp — the existing stamp, if any, stands.
  let inv;
  try { inv = documentInventory(db, projectLike); } catch { return null; }
  const intake = inv.presence.filter((p) => p.blocking && !isApplicationFormRow(p));
  if (!intake.length || intake.some((p) => !p.present)) return null;
  const planSet = ["plan_set", ...(DOC_TYPE_ALIASES.plan_set ?? [])];
  let latest: string | null = null;
  for (const p of intake) {
    const types = new Set([p.docType, ...(p.altDocTypes ?? []), ...(DOC_TYPE_ALIASES[p.docType] ?? [])]);
    if (/plan set/i.test(p.via)) for (const t of planSet) types.add(t);
    const sameAs = /^same file as (.+?) —/.exec(p.via)?.[1];
    if (sameAs) types.add(sameAs.replace(/ /g, "_"));
    const list = [...types];
    const t = db.get<Row>(
      `SELECT MAX(uploaded_at) AS t FROM project_documents
        WHERE project_id = ? AND doc_type IN (${list.map(() => "?").join(", ")})${cutoff ? " AND uploaded_at <= ?" : ""}`,
      [projectId, ...list, ...(cutoff ? [cutoff] : [])],
    )?.t;
    if (t != null && (latest === null || String(t) > latest)) latest = String(t);
  }
  return latest;
}

/** The later of intake complete and QC passed; null until both hold. */
function derivePackageCompleteAt(db: AppDb, projectId: string, cutoff: string | null): string | null {
  const docsAt = intakeCompleteAt(db, projectId, cutoff);
  if (!docsAt) return null;
  const qcAt = qcPassedAt(db, projectId, cutoff);
  if (!qcAt) return null;
  return docsAt > qcAt ? docsAt : qcAt;
}

export function touchProjectMetrics(db: AppDb, projectId: string): void {
  const now = new Date().toISOString();

  // SUBMITTED IS WHEN A PERSON SENT IT (#47): the earliest submissions.submitted_at — never a
  // portal run's start, which is when staging BEGAN and runs early by however long the filing sat
  // in awaiting_human_submit. No sent filing, no submitted_at.
  const submitRow = db.get<Row>(
    `SELECT MIN(submitted_at) as t FROM submissions
      WHERE project_id = ? AND submitted_at IS NOT NULL AND TRIM(submitted_at) <> '' AND status <> 'failed'`,
    [projectId],
  );
  const permitRow = db.get<Row>(
    "SELECT MIN(created_at) as t FROM permit_status_checks WHERE project_id = ? AND outcome = 'issued'",
    [projectId],
  );
  const nemRow = db.get<Row>(
    "SELECT MIN(created_at) as t FROM permit_status_checks WHERE project_id = ? AND outcome = 'nem_approved'",
    [projectId],
  );
  const corrRows = db.query<Row>(
    "SELECT created_at, noticed_at, due_at, closed_at, sla_days FROM corrections WHERE project_id = ? ORDER BY created_at ASC",
    [projectId],
  );

  const submittedAt = submitRow?.t != null ? String(submitRow.t) : null;
  const permitIssuedAt = permitRow?.t != null ? String(permitRow.t) : null;
  const nemApprovedAt = nemRow?.t != null ? String(nemRow.t) : null;
  // handoff_ready is our completion milestone — submit scope ends when both permit issued + NEM approved
  const handoffRow = db.get<Row>(
    "SELECT MIN(created_at) as t FROM project_notes WHERE project_id = ? AND note_type = 'handoff'",
    [projectId],
  );
  const handoffAt = handoffRow?.t != null ? String(handoffRow.t) : null;
  const firstCorrectionAt = corrRows.length > 0 ? String(corrRows[0].created_at) : null;
  const lastCorrectionAt = corrRows.length > 0 ? String(corrRows[corrRows.length - 1].created_at) : null;
  const correctionCount = corrRows.length;

  let slaBreaches = 0;
  for (const c of corrRows) if (breachedSla(c)) slaBreaches++;

  const daysBetween = (a: string | null, b: string | null) =>
    a && b ? Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000 * 10) / 10 : null;

  const permitCycleDays = daysBetween(submittedAt, permitIssuedAt);
  const nemCycleDays = daysBetween(submittedAt, nemApprovedAt);
  // total cycle = submit → handoff_ready (permit issued + NEM approved — our actual completion)
  const totalCycleDays = daysBetween(submittedAt, handoffAt);

  // COMPLETE PACKAGE RECEIVED (#48). It moves LATER on a new completion (a replaced document, a
  // QC re-pass after a failure) and never earlier: a regression keeps the last stamp until the
  // package completes again. Once submitted it is frozen — what changes after that is the
  // correction cycle, not the intake SLA — and a first stamp after submission reads only the facts
  // from before it.
  const prevPackage = db.get<Row>("SELECT package_complete_at AS t FROM project_metrics WHERE project_id = ?", [projectId])?.t;
  const prevPackageAt = prevPackage == null ? null : String(prevPackage);
  let packageCompleteAt = prevPackageAt;
  if (!(submittedAt && prevPackageAt)) {
    const derived = derivePackageCompleteAt(db, projectId, submittedAt);
    if (derived && (!prevPackageAt || derived > prevPackageAt)) packageCompleteAt = derived;
  }

  db.run(
    `INSERT INTO project_metrics
      (project_id, submitted_at, permit_issued_at, nem_approved_at, pto_at, package_complete_at,
       first_correction_at, last_correction_at, correction_count,
       permit_cycle_days, nem_cycle_days, total_cycle_days, sla_breaches, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       submitted_at = excluded.submitted_at,
       permit_issued_at = excluded.permit_issued_at,
       nem_approved_at = excluded.nem_approved_at,
       pto_at = excluded.pto_at,
       package_complete_at = excluded.package_complete_at,
       first_correction_at = excluded.first_correction_at,
       last_correction_at = excluded.last_correction_at,
       correction_count = excluded.correction_count,
       permit_cycle_days = excluded.permit_cycle_days,
       nem_cycle_days = excluded.nem_cycle_days,
       total_cycle_days = excluded.total_cycle_days,
       sla_breaches = excluded.sla_breaches,
       updated_at = excluded.updated_at`,
    [
      projectId, submittedAt, permitIssuedAt, nemApprovedAt, null /* pto outside our scope */, packageCompleteAt,
      firstCorrectionAt, lastCorrectionAt, correctionCount,
      permitCycleDays, nemCycleDays, totalCycleDays, slaBreaches, now,
    ],
  );
  touchFilingMetrics(db, projectId, now);
}

/** Past its cure window: due_at when stamped, else the notice's own date (falling back to
 *  ingestion) plus sla_days, against when it closed (or now). */
function breachedSla(c: Row): boolean {
  const start = Date.parse(String(c.noticed_at ?? c.created_at));
  const due = c.due_at
    ? Date.parse(`${String(c.due_at).slice(0, 10)}T23:59:59Z`)
    : start + Number(c.sla_days ?? DEFAULT_CORRECTION_SLA_DAYS) * 86_400_000;
  const closed = c.closed_at ? Date.parse(String(c.closed_at)) : Date.now();
  return closed > due;
}

export function getKpiReport(
  db: AppDb,
  options: { startDate?: string; endDate?: string; orgId?: string | null; awaitingSubmitDays?: number } = {},
): KpiReport {
  // Tenant scope. `null` reads across every org (superadmin); omitting it means the
  // default tenant, so a forgotten filter under-reports rather than leaking.
  const orgId = options.orgId === null ? null : (options.orgId || DEFAULT_ORG_ID);
  const orgAnd = (col: string) => (orgId ? ` AND ${col} = ?` : "");
  const orgP = orgId ? [orgId] : [];
  const start = options.startDate || new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const end = options.endDate || new Date().toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const metrics = db.query<Row>(
    `SELECT m.* FROM project_metrics m
     JOIN projects p ON p.id = m.project_id${orgId ? " AND p.org_id = ?" : ""}
     WHERE m.submitted_at >= ? AND m.submitted_at <= ?`,
    [...orgP, start, end + "T23:59:59"],
  ).map(mapMetrics);

  const allCorrections = db.query<Row>(
    `SELECT c.*, p.assigned_user_id FROM corrections c
     JOIN projects p ON c.project_id = p.id${orgId ? " AND p.org_id = ?" : ""}
     WHERE c.created_at >= ? AND c.created_at <= ?`,
    [...orgP, start, end + "T23:59:59"],
  );
  const openCorrections = Number(
    db.get<Row>(
      `SELECT COUNT(*) as cnt FROM corrections c
       JOIN projects p ON p.id = c.project_id${orgId ? " AND p.org_id = ?" : ""}
       WHERE c.closed_at IS NULL`,
      orgP,
    )?.cnt ?? 0,
  );
  const overdueCorrections = Number(
    db.get<Row>(
      `SELECT COUNT(*) as cnt FROM corrections c
       JOIN projects p ON p.id = c.project_id${orgId ? " AND p.org_id = ?" : ""}
       WHERE c.closed_at IS NULL
         AND (c.due_at < ? OR (c.due_at IS NULL AND date(c.created_at, '+' || c.sla_days || ' days') < ?))`,
      [...orgP, today, today],
    )?.cnt ?? 0,
  );

  const projectsWithCorrections = new Set(allCorrections.map((c) => String(c.project_id))).size;
  const totalSlaBreaches = allCorrections.filter(breachedSla).length;
  // Per filing track: a notice is one cycle however many items it carries. '' = no filing could be
  // named for it, reported as "unknown" rather than folded into the permit side.
  const byTrack = new Map<string, { notices: Set<string>; items: number }>();
  for (const c of allCorrections) {
    const track = String(c.track ?? "") || "unknown";
    const entry = byTrack.get(track) ?? { notices: new Set<string>(), items: 0 };
    entry.notices.add(String(c.notice_id ?? c.id));
    entry.items++;
    byTrack.set(track, entry);
  }

  const permitCycles = metrics.map((m) => m.permitCycleDays).filter((v): v is number => v !== null);
  const nemCycles = metrics.map((m) => m.nemCycleDays).filter((v): v is number => v !== null);
  const totalCycles = metrics.map((m) => m.totalCycleDays).filter((v): v is number => v !== null);

  const periodDays = Math.max(1, (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000);
  // Completion = handoff_ready (permit issued + NEM approved) — our actual deliverable
  const handoffCount = Number(
    db.get<Row>(
      `SELECT COUNT(*) as cnt FROM projects
       WHERE status = 'handoff_ready'${orgAnd("org_id")} AND updated_at >= ? AND updated_at <= ?`,
      [...orgP, start, end + "T23:59:59"],
    )?.cnt ?? 0,
  );

  // Per-user breakdown
  const users = db.query<Row>(
    `SELECT * FROM users WHERE active = 1${orgAnd("org_id")}`,
    orgP,
  );
  const byUser = users.map((u) => {
    const uid = String(u.id);
    const userMetrics = metrics.filter((m) => m.assignedUserId === uid);
    const userCycles = userMetrics.map((m) => m.totalCycleDays).filter((v): v is number => v !== null);
    const userOverdue = Number(
      db.get<Row>(
        `SELECT COUNT(*) as cnt FROM corrections c
         JOIN projects p ON c.project_id = p.id${orgId ? " AND p.org_id = ?" : ""}
         WHERE p.assigned_user_id = ? AND c.closed_at IS NULL
           AND (c.due_at < ? OR (c.due_at IS NULL AND date(c.created_at, '+' || c.sla_days || ' days') < ?))`,
        [...orgP, uid, today, today],
      )?.cnt ?? 0,
    );
    const userOpen = Number(
      db.get<Row>(
        `SELECT COUNT(*) as cnt FROM projects WHERE assigned_user_id = ?${orgAnd("org_id")} AND status NOT IN ('handoff_ready','blocked')`,
        [uid, ...orgP],
      )?.cnt ?? 0,
    );
    return {
      userId: uid,
      userName: String(u.name),
      submitted: userMetrics.length,
      handedOff: Number(
        db.get<Row>(
          `SELECT COUNT(*) as cnt FROM projects WHERE assigned_user_id = ?${orgAnd("org_id")} AND status = 'handoff_ready' AND updated_at >= ? AND updated_at <= ?`,
          [uid, ...orgP, start, end + "T23:59:59"],
        )?.cnt ?? 0,
      ),
      openProjects: userOpen,
      overdueCorrections: userOverdue,
      avgCycleDays: avg(userCycles),
    };
  });

  // PACKAGE → SUBMITTED. The cycle covers projects submitted in the period that have a stamp; a
  // complete package with no submission is not a cycle and is counted apart, with its age. "Not
  // submitted" is the snapshot's own submitted_at (#47: a person sent it) — one definition, the
  // same one the cycle above and touchProjectMetrics use, never a second predicate here.
  const awaitingSubmitDays = options.awaitingSubmitDays ?? 7;
  const clientOf = new Map(db.query<Row>(
    `SELECT m.project_id, p.client_id FROM project_metrics m
       JOIN projects p ON p.id = m.project_id${orgId ? " AND p.org_id = ?" : ""}
      WHERE m.package_complete_at IS NOT NULL`,
    orgP,
  ).map((r) => [String(r.project_id), r.client_id == null ? "" : String(r.client_id)]));
  const cycles = metrics
    .filter((m) => m.packageCompleteAt && m.submittedAt)
    .map((m) => ({ clientId: clientOf.get(m.projectId) ?? "", days: daysBetweenIso(m.packageCompleteAt!, m.submittedAt!) }))
    .filter((c) => c.days >= 0);
  const awaitingRows = db.query<Row>(
    `SELECT m.package_complete_at AS t, p.client_id AS client_id FROM project_metrics m
       JOIN projects p ON p.id = m.project_id${orgId ? " AND p.org_id = ?" : ""}
      WHERE m.package_complete_at IS NOT NULL
        AND m.submitted_at IS NULL`,
    orgP,
  );
  const nowMs = Date.now();
  const awaiting = (rows: Row[]): AwaitingSubmit => ({
    n: rows.length,
    olderThanDays: awaitingSubmitDays,
    overAge: rows.filter((r) => (nowMs - new Date(String(r.t)).getTime()) / 86_400_000 > awaitingSubmitDays).length,
  });
  const clients = db.query<Row>(
    `SELECT id, company_name FROM clients WHERE 1 = 1${orgAnd("org_id")} ORDER BY company_name`,
    orgP,
  );
  const byClient = clients.map((c) => {
    const cid = String(c.id);
    return {
      clientId: cid,
      clientName: String(c.company_name ?? ""),
      packageToSubmitDays: cycleStat(cycles.filter((x) => x.clientId === cid).map((x) => x.days)),
      awaitingSubmit: awaiting(awaitingRows.filter((r) => String(r.client_id ?? "") === cid)),
    };
  });

  return {
    period: { start, end },
    projectsSubmitted: metrics.length,
    projectsHandedOff: handoffCount,
    avgPermitCycleDays: avg(permitCycles),
    avgNemCycleDays: avg(nemCycles),
    avgTotalCycleDays: avg(totalCycles),
    correctionsByTrack: [...byTrack.entries()]
      .map(([track, e]) => ({ track, notices: e.notices.size, items: e.items }))
      .sort((a, b) => a.track.localeCompare(b.track)),
    correctionRate: metrics.length > 0 ? Math.round((projectsWithCorrections / metrics.length) * 100) : 0,
    avgCorrectionsPerProject: metrics.length > 0
      ? Math.round((allCorrections.length / metrics.length) * 10) / 10
      : 0,
    openCorrections,
    overdueCorrections,
    slaBreachRate: allCorrections.length > 0
      ? Math.round((totalSlaBreaches / allCorrections.length) * 100)
      : 0,
    throughputPerWeek: Math.round((handoffCount / periodDays) * 7 * 10) / 10,
    packageToSubmitDays: cycleStat(cycles.map((c) => c.days)),
    packageAwaitingSubmit: awaiting(awaitingRows),
    byClient,
    stagingQuality: getStagingQuality(db, { start, end, orgId }),
    byUser,
  };
}

/**
 * Staging quality over a period, read back out of the runs we already recorded.
 *
 * Deliberately CONSERVATIVE about what counts as measured: a run whose result_json cannot
 * be parsed, or that carries no replay report at all (a learn run, an adapter that never
 * reached the form), is excluded rather than counted as clean. A quality metric that scores
 * "we could not tell" as "fine" is the same failure the replay benchmark was built to stop
 * — it reported a filing the portal was refusing as `replayed_clean` for three runs.
 */
export function getStagingQuality(
  db: AppDb,
  opts: { start: string; end: string; orgId?: string | null },
): StagingQuality {
  const orgId = opts.orgId === null ? null : (opts.orgId || DEFAULT_ORG_ID);
  const rows = db.query<Row>(
    `SELECT r.result_json AS rj
       FROM portal_runs r
       JOIN projects p ON p.id = r.project_id${orgId ? " AND p.org_id = ?" : ""}
      WHERE r.run_type = 'prepare_submit'
        AND r.started_at >= ? AND r.started_at <= ?`,
    [...(orgId ? [orgId] : []), opts.start, opts.end + "T23:59:59"],
  );

  const gapCounts = new Map<string, number>();
  const driftCounts = new Map<string, number>();
  let measured = 0, clean = 0, verified = 0, neededHuman = 0, blanksTotal = 0;
  let requiredTotal = 0, blindClean = 0;

  for (const row of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(String(row.rj || "{}")); } catch { continue; }
    const rep = mergeStepReport(parsed);
    // No replay report on this run — a learn, or an adapter that never reached the form.
    // Not evidence of quality either way.
    if (rep.executed === undefined && rep.requiredStillEmpty === undefined) continue;
    measured++;

    const blanks = (rep.requiredStillEmpty as string[] | undefined) ?? [];
    const unresolved = new Set(((rep.unresolvedFields as string[] | undefined) ?? []).map(String));
    const skipped = ((rep.skipped as string[] | undefined) ?? [])
      .filter((s) => !/final submit|NOT clicked/i.test(String(s)));   // declining submit is the rule, not a fault
    const failed = skipped.filter((s) => !unresolved.has(String(s)));
    const drift = (rep.driftWarnings as string[] | undefined) ?? [];
    // Self-heals and correct decisions. Same split as the benchmark scorer, because a lab
    // number and a production number that disagree about what "clean" means are two numbers
    // nobody can use together.
    const aging = (rep.agingNotes as string[] | undefined) ?? [];
    const healed = ((rep.healedSteps as unknown[] | undefined) ?? []).length;
    const fieldsSeen = Number(rep.reviewFieldsSeen ?? 0);
    // Reading the page is not checking it — the benchmark's own bar, so the two agree.
    const confirmedFields = Number(rep.reviewFieldsConfirmed ?? 0);
    const mismatches = ((rep.reviewMismatches as unknown[] | undefined) ?? []).length;

    blanksTotal += blanks.length;
    for (const b of blanks.slice(0, 12)) {
      // Blanks now carry the page they were found on ("Name [Contact Information]"), which is
      // what makes a single run readable. Counting ACROSS runs wants the field alone, or one
      // recurring gap splits into a row per page and drops out of the top list entirely.
      const key = String(b)
        .replace(/ — the portal flagged this field$/, "")
        .replace(/\s*\[[^\]]{1,48}\]$/, "")
        .slice(0, 60);
      if (key) gapCounts.set(key, (gapCounts.get(key) ?? 0) + 1);
    }
    // A recipe reaching its controls by another route IS drift worth chasing, even though it
    // is not a defect in the filing. Declassifying it for the clean rate must not delete it
    // from the re-record signal, which is the whole reason the note exists.
    if (drift.length || aging.length || healed) {
      const portal = String((rep.portalName as string) || "unknown").slice(0, 40);
      driftCounts.set(portal, (driftCounts.get(portal) ?? 0) + 1);
    }

    // A FILING THE PORTAL'S OWN REVIEW SCREEN CONTRADICTS IS NOT CLEAN.
    //
    // It ran without a stumble and it is still wrong — the live shape of this was a
    // PowerClerk filing where every step executed, nothing was blank, and the preparer
    // block held the homeowner's name instead of the contractor's. The replay benchmark
    // says DO NOT SUBMIT about that run; a headline number that called it clean would be
    // saying the opposite thing about the same filing.
    // ABSENT IS NOT ZERO. Every run staged before this field existed carries no
    // requiredFieldsSeen at all, and treating that as "saw nothing" would flag the entire
    // back catalogue as unfalsifiable on the day the feature shipped — the same mistake as
    // counting an unreadable run as clean, pointing the other way. Absence means old build.
    const sawRequired = Array.isArray(rep.requiredFieldsSeen);
    const requiredSeen = sawRequired ? (rep.requiredFieldsSeen as string[]).length : 0;
    requiredTotal += requiredSeen;

    const isClean = !blanks.length && !failed.length && !drift.length && !healed && !mismatches;
    if (isClean) clean++;
    // A clean run that never saw a required control did not prove the filing is complete;
    // it proved only that it found nothing to object to, which is also what a run that never
    // looked reports. Counted separately so the clean rate can be read honestly.
    if (isClean && sawRequired && requiredSeen === 0) blindClean++;
    // The top bar, same as the benchmark's: clean AND the portal's own review screen agreed.
    if (isClean && fieldsSeen > 0 && confirmedFields >= MIN_CONFIRMED_FIELDS) verified++;
    if (blanks.length || failed.length || mismatches) neededHuman++;
  }

  const pct = (n: number): number => (measured ? Math.round((n / measured) * 1000) / 10 : 0);
  const top = (m: Map<string, number>, k: string): Array<{ [key: string]: string | number }> =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ [k]: name, runs: n }));

  return {
    runs: rows.length,
    measured,
    clean,
    cleanRate: pct(clean),
    verified,
    verifiedRate: pct(verified),
    neededHuman,
    avgBlanksPerRun: measured ? Math.round((blanksTotal / measured) * 10) / 10 : 0,
    avgRequiredPerRun: measured ? Math.round((requiredTotal / measured) * 10) / 10 : 0,
    blindClean,
    topGaps: top(gapCounts, "field") as Array<{ field: string; runs: number }>,
    driftingPortals: top(driftCounts, "portal") as Array<{ portal: string; runs: number }>,
  };
}
