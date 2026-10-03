import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { AppDb, SqlParam } from "./db";
import { DEFAULT_ORG_ID } from "./db";
// audit.ts is a leaf (db/ids/json/time only) — no cycle through repository here.
import { addAuditLog } from "./audit";
import { importMboxKnowledge } from "./knowledgeBase";
import { restoreRecipeSnapshotIfAbandoned, upsertRecipeNote } from "./portalRecipes";
import { runDuePermitChecks } from "./repository";
import { scanFolder } from "./batchImport";
import { nowIso } from "./time";
import { logger } from "./logger";
import { runWithLlmContext } from "./llmAccounting";
import { noteJobProgress, parseJobProgressNote, type JobProgressNote } from "./jobProgress";

export type JobType =
  | "permit_checks"
  | "nem_checks"
  | "mbox_import"
  | "folder_scan"
  | "autopilot"
  | "prepare_submission"
  | "auto_learn"
  | "code_research"
  // The NARROW lookup: one AHJ's ground snow / ultimate wind / exposure, for a profile row
  // that exists but has none on file (codeProfiles.ensureDesignCriteriaResearched).
  | "design_criteria_research"
  | "fee_research"
  // THE PER-JOB PERMIT-PROCESS LOOKUP (permitProcessLookup.ts): agency, combo vs separate, portal +
  // record type, documents and fees per permit — cited, seeded — for an AHJ with no process of its own.
  | "permit_process_lookup"
  | "run_triage"
  | "correction_triage"
  // The LOCAL pipeline steps (QC, doc package, reviewer gate, historical check) running
  // automatically when a project enters their stage. NEVER a portal effect: the chain in
  // autoStageSteps.ts stops cold at ready_to_stage, and staging stays a human gesture.
  | "stage_step";

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface JobRecord {
  id: string;
  jobType: JobType;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  assignedToUser: string | null;
  projectId: string | null;
  createdAt: string;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  progress: number;
  progressTotal: number;
  /** The step the job named as it started it (jobProgress.noteJobProgress), or null. */
  progressNote: JobProgressNote | null;
  result: Record<string, unknown> | null;
  error: string | null;
  retryCount: number;
  maxRetries: number;
  orgId: string;
}

type Row = Record<string, SqlParam>;

// Tolerate a corrupt JSON column on a single row rather than crashing the
// whole job worker loop; fall back to `fallback` and keep processing.
function safeParse<T>(raw: SqlParam, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

function mapJob(row: Row): JobRecord {
  return {
    id: String(row.id),
    jobType: String(row.job_type) as JobType,
    payload: safeParse(row.payload, {}),
    status: String(row.status) as JobStatus,
    priority: Number(row.priority ?? 5),
    assignedToUser: row.assigned_to_user == null ? null : String(row.assigned_to_user),
    projectId: row.project_id == null ? null : String(row.project_id),
    createdAt: String(row.created_at),
    scheduledAt: row.scheduled_at == null ? null : String(row.scheduled_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    progress: Number(row.progress ?? 0),
    progressTotal: Number(row.progress_total ?? 0),
    progressNote: parseJobProgressNote(row.progress_note),
    result: row.result == null ? null : safeParse(row.result, null),
    error: row.error == null ? null : String(row.error),
    retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? 3),
    orgId: String(row.org_id || DEFAULT_ORG_ID),
  };
}

export function enqueueJob(
  db: AppDb,
  jobType: JobType,
  payload: Record<string, unknown>,
  options: {
    priority?: number;
    assignedToUser?: string;
    projectId?: string;
    scheduledAt?: string;
    maxRetries?: number;
    /** Tenant this job belongs to. Carried so work the job creates lands in the right
     *  org, and so the claim can be fair across tenants rather than first-come. */
    orgId?: string;
  } = {},
): JobRecord {
  const id = crypto.randomUUID();
  const ts = nowIso();
  // Prefer the org of the job's project when there is one — the project is the
  // authority, and it can't be spoofed by a caller passing the wrong orgId.
  const projectOrg = options.projectId
    ? db.get<{ org_id?: string }>("SELECT org_id FROM projects WHERE id = ?", [options.projectId])?.org_id
    : undefined;
  const orgId = String(projectOrg || options.orgId || DEFAULT_ORG_ID);
  db.run(
    `INSERT INTO job_queue
      (id, job_type, payload, status, priority, assigned_to_user, project_id,
       created_at, scheduled_at, progress, progress_total, retry_count, max_retries, org_id)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
    [
      id,
      jobType,
      JSON.stringify(payload),
      options.priority ?? 5,
      options.assignedToUser ?? null,
      options.projectId ?? null,
      ts,
      options.scheduledAt ?? null,
      // Portal-effecting jobs are pinned to 0 retries regardless of what the caller
      // asked for (the generic /api/jobs route would otherwise let one in with the
      // default budget of 3, and a timer would replay a live browser run).
      PORTAL_EFFECT_JOB_TYPES.has(jobType) ? 0 : options.maxRetries ?? 3,
      orgId,
    ],
  );
  // Instant kick: don't make an operator-enqueued job wait for the next 30s
  // worker tick. Deferred a macrotask so the enqueuing transaction settles;
  // processNextJob's atomic claim + the in-flight set make an overlap with the
  // interval tick harmless (one of the two claims wins, the other no-ops).
  if (!options.scheduledAt) {
    setTimeout(() => { void drainPendingJobs(db).catch(() => null); }, 0).unref?.();
  }
  return mapJob(db.get<Row>("SELECT * FROM job_queue WHERE id = ?", [id])!);
}

export function listJobs(
  db: AppDb,
  filter: { status?: JobStatus; jobType?: JobType; limit?: number; orgId?: string | null } = {},
): JobRecord[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const scopeOrgId = filter.orgId === null ? null : (filter.orgId || DEFAULT_ORG_ID);
  if (scopeOrgId) { conditions.push("org_id = ?"); params.push(scopeOrgId); }
  if (filter.status) { conditions.push("status = ?"); params.push(filter.status); }
  if (filter.jobType) { conditions.push("job_type = ?"); params.push(filter.jobType); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter.limit ?? 100;
  return db.query<Row>(
    `SELECT * FROM job_queue ${where} ORDER BY priority DESC, created_at ASC LIMIT ?`,
    [...params, limit],
  ).map(mapJob);
}

export function getJob(db: AppDb, jobId: string): JobRecord | null {
  const row = db.get<Row>("SELECT * FROM job_queue WHERE id = ?", [jobId]);
  return row ? mapJob(row) : null;
}

function updateJobProgress(db: AppDb, jobId: string, progress: number, total: number): void {
  db.run("UPDATE job_queue SET progress = ?, progress_total = ? WHERE id = ?", [progress, total, jobId]);
}

// The step a running job names (job_queue.progress_note) lives in jobProgress.ts — a leaf shared
// with nextStep, the reader. Re-exported for callers that already import this module.
export { noteJobProgress, parseJobProgressNote, type JobProgressNote } from "./jobProgress";

// Streaming MBOX reader — processes 50 GB+ without loading into memory.
// Yields raw message strings in chunks of chunkSize.
async function* streamMboxMessages(
  filePath: string,
  chunkSize = 500,
): AsyncGenerator<string[]> {
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  let current: string[] = [];
  let chunk: string[] = [];
  let lineCount = 0;

  for await (const line of rl) {
    lineCount++;
    if (line.startsWith("From ") && current.length > 0) {
      chunk.push(current.join("\n"));
      current = [line];
      if (chunk.length >= chunkSize) {
        yield chunk;
        chunk = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) chunk.push(current.join("\n"));
  if (chunk.length > 0) yield chunk;
}

async function runMboxImportJob(db: AppDb, job: JobRecord): Promise<Record<string, unknown>> {
  const { filePath, sourceLabel, defaultState, defaultAhj, defaultUtility } = job.payload as {
    filePath: string;
    sourceLabel?: string;
    defaultState?: string;
    defaultAhj?: string;
    defaultUtility?: string;
  };

  // Count lines to estimate message count for progress
  let totalMessages = 0;
  let processed = 0;
  const totals = {
    permit_approval: 0, permit_correction: 0,
    nem_approval: 0, nem_correction: 0,
    status_update: 0, missing_info_request: 0,
    fee_request: 0, inspection_final_notice: 0,
    spam_irrelevant: 0,
  };
  let learningEvents = 0;
  let duplicateMessages = 0;
  let skippedMessages = 0;

  // First pass: count "From " lines for progress tracking
  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
    rl.on("line", (line) => { if (line.startsWith("From ")) totalMessages++; });
    rl.on("close", resolve);
  });
  updateJobProgress(db, job.id, 0, totalMessages);

  for await (const chunk of streamMboxMessages(filePath, 500)) {
    const mboxText = chunk.join("\nFrom placeholder\n"); // re-join for importMboxKnowledge
    const result = await importMboxKnowledge(db, {
      // The job row's org (stamped at enqueue from the session) — never the payload.
      orgId: job.orgId,
      mboxText,
      sourceLabel: sourceLabel || "MBOX Import",
      defaultState: defaultState || "",
      defaultAhj: defaultAhj || "",
      defaultUtility: defaultUtility || "",
    });

    processed += chunk.length;
    learningEvents += result.learningEvents;
    duplicateMessages += result.duplicateMessages;
    skippedMessages += result.skippedMessages;
    for (const [k, v] of Object.entries(result.bucketCounts)) {
      (totals as Record<string, number>)[k] = ((totals as Record<string, number>)[k] || 0) + (v as number);
    }
    updateJobProgress(db, job.id, processed, totalMessages);
  }

  return { processed, totalMessages, learningEvents, duplicateMessages, skippedMessages, bucketCounts: totals };
}

async function runFolderScanJob(db: AppDb, job: JobRecord): Promise<Record<string, unknown>> {
  const { folderPath, defaultState, defaultAhj, defaultUtility, useLlm } = job.payload as {
    folderPath: string;
    defaultState?: string;
    defaultAhj?: string;
    defaultUtility?: string;
    useLlm?: boolean;
  };
  const summary = await scanFolder(db, folderPath, {
    // The job row's org (stamped at enqueue from the session) — never the payload.
    orgId: job.orgId,
    defaultState, defaultAhj, defaultUtility, useLlm,
    onProgress: (done, total) => updateJobProgress(db, job.id, done, total),
  });
  return {
    scanned: summary.scanned,
    learned: summary.learned,
    lowSignal: summary.lowSignal,
    errors: summary.errors,
    byType: summary.byType,
    byJurisdiction: summary.byJurisdiction,
    profilesTouched: summary.profilesTouched.length,
    correctionsLearned: summary.correctionsLearned,
    reportPath: summary.reportPath,
    results: summary.results,
  };
}

// How long a job may stay `running` before it is presumed dead (the process was
// killed mid-run, leaving an orphan that the optimistic-lock claim will never pick
// up again). Defaults to 30 minutes — comfortably longer than the slowest portal run.
const JOB_MAX_RUNTIME_MS = Number(process.env.JOB_MAX_RUNTIME_MS ?? 30 * 60_000);

// Job IDs this process is ACTIVELY running right now. The mid-run watchdog must
// never reclaim one of these: a portal run (prepare_submission / auto_learn) can
// legitimately outlast the 30-min watchdog, and re-queuing it while the original
// is still driving a live browser would stage the same application to a real AHJ/
// utility portal TWICE (the DB completion is status-guarded, but the side effect —
// the actual submission — is not). Populated only for the lifetime of a run in
// THIS process, so on startup (fresh process) the set is empty and every stranded
// `running` row is correctly reclaimed.
const inFlightJobIds = new Set<string>();

// Job types whose handler drives a live portal browser. Their side effects are not
// idempotent (a re-run can stage the same application twice), so they are pinned to
// maxRetries 0 at enqueue — whatever the caller asked for — and the orphan watchdog
// fails them for a human instead of re-queuing.
const PORTAL_EFFECT_JOB_TYPES = new Set<JobType>(["prepare_submission", "auto_learn", "autopilot"]);

// How many jobs THIS process is actively running right now. The shutdown handler
// uses it to hold a deploy restart until live portal runs finish (or a bounded
// drain window elapses) instead of killing a browser mid-staging.
export function inFlightJobCount(): number {
  return inFlightJobIds.size;
}

// Reclaim jobs stranded in `running`. The worker is single-process, so any job still
// `running` either (a) was interrupted by a restart, or (b) has outlived the max
// runtime watchdog. Either way it is dead: re-queue it for another attempt (counting
// the lost run against its retry budget so a poison job eventually fails instead of
// looping forever), or fail it outright once retries are exhausted.
export function recoverOrphanedJobs(
  db: AppDb,
  opts: { startup?: boolean; inFlight?: (jobId: string) => boolean } = {},
): number {
  const cutoff = new Date(Date.now() - JOB_MAX_RUNTIME_MS).toISOString();
  // On startup every `running` row is orphaned; mid-run only those past the watchdog.
  const staleRows = db.query<Row>(
    opts.startup
      ? "SELECT * FROM job_queue WHERE status = 'running'"
      : "SELECT * FROM job_queue WHERE status = 'running' AND started_at IS NOT NULL AND started_at <= ?",
    opts.startup ? [] : [cutoff],
  );
  // Mid-run: never reclaim a job THIS process is still actively running (a slow
  // portal pass past the watchdog) — that would double-submit. On startup the set
  // is empty so this filter is a no-op and all stranded rows are reclaimed.
  // `inFlight` is injectable for tests; production uses the process's live set.
  const isInFlight = opts.inFlight ?? ((id: string) => inFlightJobIds.has(id));
  const stale = opts.startup ? staleRows : staleRows.filter((row) => !isInFlight(String(row.id)));
  if (!stale.length) return 0;
  const now = nowIso();
  for (const row of stale) {
    const job = mapJob(row);
    const retryCount = job.retryCount + 1;
    // A portal-effecting job is NEVER auto-rerun after an interruption: its browser
    // may already have staged (or half-staged) a live application, and replaying it
    // blind could file the same application twice. Fail it and put it in front of a
    // human, whatever its retry budget says.
    if (PORTAL_EFFECT_JOB_TYPES.has(job.jobType)) {
      db.run(
        "UPDATE job_queue SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'",
        [now, "portal run was interrupted — not auto-rerun (staging is not idempotent portal-side); a human must check the portal and re-stage", job.id],
      );
      escalateJobFailure(db, job.jobType, job.projectId, "Portal run interrupted mid-flight. Check the portal for a partial application before re-staging.");
      continue;
    }
    if (retryCount < job.maxRetries) {
      db.run(
        "UPDATE job_queue SET status = 'pending', retry_count = ?, started_at = NULL, scheduled_at = NULL, error = ? WHERE id = ? AND status = 'running'",
        [retryCount, `recovered orphaned job (was running since ${job.startedAt ?? "?"})`, job.id],
      );
    } else {
      db.run(
        "UPDATE job_queue SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'",
        [now, "orphaned job exceeded retry budget after interruption", job.id],
      );
      escalateJobFailure(db, job.jobType, job.projectId, "orphaned job exceeded retry budget after interruption");
    }
  }
  console.log(`[job-worker] recovered ${stale.length} orphaned job(s)${opts.startup ? " on startup" : ""}`);
  return stale.length;
}

// Recipes stranded in 'recording'. A learn/record run that is interrupted (server
// restart, crashed browser, operator abandons the CLI recorder) leaves its stub at
// status='recording' forever — the UI then shows "recording in progress" with nothing
// actually running. Sweep rows whose updated_at is stale to 'needs_rerecord' so they
// surface as re-recordable instead of stuck. The threshold is generous (2h) so an
// operator mid-recording is never swept; steps recorded so far are preserved.
const RECIPE_RECORDING_STALE_MS = Number(process.env.RECIPE_RECORDING_STALE_MS ?? 2 * 60 * 60_000);

export function recoverStalePortalRecordings(db: AppDb): number {
  const cutoff = new Date(Date.now() - RECIPE_RECORDING_STALE_MS).toISOString();
  // `notes` is selected because it is MERGED below, not replaced — see the comment there.
  const stale = db.query<Row>(
    "SELECT id, updated_at, notes FROM portal_recipes WHERE status = 'recording' AND updated_at <= ?",
    [cutoff],
  );
  if (!stale.length) return 0;
  let restoredComplete = 0;
  let restoredForRerecord = 0;
  for (const row of stale) {
    // An abandoned RE-record rolls back to the steps kept alongside when the re-record
    // wiped them. Whether that rollback also restores 'complete' depends on whether those
    // steps were ever PROVEN — a run that died is not evidence that its capture works.
    // restoreRecipeSnapshotIfAbandoned owns that judgement; see the essay on it.
    const landed = restoreRecipeSnapshotIfAbandoned(db, String(row.id));
    if (landed === "complete") { restoredComplete++; continue; }
    if (landed === "needs_rerecord") { restoredForRerecord++; continue; }
    // NOTES ARE MERGED, NEVER OVERWRITTEN.
    //
    // This statement used to assign the notes column outright, and the column is where the
    // whole failure taxonomy lives: "Auto-learn paused: mfa_captcha", "Auto-learn did not
    // stage cleanly", the portal's own validation text, the required-blank finding that
    // promoteRecordingIfEligible refuses to promote past. A sweep two hours later replaced
    // every word of it with one sentence about the sweep — so the rows that most needed
    // explaining ("why did this portal stop at page 2?") reached the next session saying
    // only that a recording had been interrupted, and the evidence had to be re-gathered
    // from the live portal. Segment-merged (CLAUDE.md) so a sweep that ticks repeatedly
    // cannot re-append the same sentence.
    db.run(
      "UPDATE portal_recipes SET status = 'needs_rerecord', notes = ?, updated_at = ? WHERE id = ? AND status = 'recording'",
      [upsertRecipeNote(row.notes, "recording interrupted",
        `[recording interrupted — no activity since ${String(row.updated_at)}; marked for re-record]`),
        nowIso(), String(row.id)],
    );
  }
  console.log(`[job-worker] swept ${stale.length} stale portal recording(s): ${restoredComplete} restored to their previous PROVEN recipe, ${restoredForRerecord} had unproven steps restored for re-record, ${stale.length - restoredComplete - restoredForRerecord} marked needs_rerecord`);
  return stale.length;
}

// TRUE once startJobWorker has run in THIS process — i.e. this process actually
// executes background jobs (today: exactly the server; server.ts starts the worker
// in its listen callback). Read by feeSchedules.ensureFeeSchedulesResearched so
// that passive processes — the smoke, unit tests, one-off scripts, benchmarks —
// never CREATE autonomous research work as a side effect of merely running QC:
// those processes load dotenv (a real ANTHROPIC_API_KEY) and their enqueue's
// instant kick would run a multi-minute web-grounded LLM pass in-process. A
// process that runs no worker has declared it is not the place background
// spending happens.
let workerStarted = false;
export function jobWorkerRunning(): boolean {
  return workerStarted;
}

// Background worker — call once at server startup. Polls the job queue on a fixed interval.
// Interval defaults to JOB_WORKER_INTERVAL_MS env var, or 30 seconds.
export function startJobWorker(db: AppDb): ReturnType<typeof setInterval> {
  workerStarted = true;
  const intervalMs = Number(process.env.JOB_WORKER_INTERVAL_MS ?? 30_000);
  // Clear out jobs left `running` by a previous process before we start polling.
  recoverOrphanedJobs(db, { startup: true });
  const timer = setInterval(() => {
    // Each tick, first reclaim any job that has blown past the runtime watchdog,
    // then DRAIN pending jobs (bounded) instead of processing exactly one — a
    // burst of N queued jobs no longer takes N ticks to clear.
    try {
      recoverOrphanedJobs(db);
      recoverStalePortalRecordings(db);
    } catch (err) {
      console.error("[job-worker] orphan recovery error:", err instanceof Error ? err.message : String(err));
    }
    drainPendingJobs(db).catch((err) => {
      console.error("[job-worker] uncaught error:", err instanceof Error ? err.message : String(err));
    });
  }, intervalMs);
  console.log(`[job-worker] started — polling every ${intervalMs / 1000}s`);
  return timer;
}

// A permanently-failed job must be VISIBLE, not just a logger.warn: broadcast
// to the dashboard and (for project-scoped jobs) open a human-review item so
// the failure lands in the operator's queue instead of dying in the logs.
// Best-effort by design — escalation must never mask or replace the failure.
function escalateJobFailure(db: AppDb, jobType: string, projectId: string | null, message: string): void {
  void import("./events")
    .then(({ sseBroadcast }) => {
      sseBroadcast({ type: "job_failed", projectId: projectId ?? undefined, message: `${jobType} failed permanently: ${message}`.slice(0, 500) });
    })
    .catch(() => null);
  if (!projectId) return;
  // Advisory agents (triage) are best-effort by contract — their failure must
  // never become a pipeline gate, so they surface via SSE/log only.
  if (jobType === "run_triage" || jobType === "correction_triage") return;
  try {
    const ts = nowIso();
    // Dedupe: one open item per (project, jobType) — a flapping job must not
    // flood the review queue.
    const existing = db.get<Row>(
      "SELECT id FROM human_review_items WHERE project_id = ? AND issue_type = 'Background job failed' AND field_name = ? AND status = 'pending' LIMIT 1",
      [projectId, jobType],
    );
    if (existing) {
      db.run("UPDATE human_review_items SET notes = ?, updated_at = ? WHERE id = ?", [message.slice(0, 800), ts, String(existing.id)]);
      return;
    }
    db.run(
      `INSERT INTO human_review_items
        (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
       VALUES (?, ?, 'Background job failed', ?, '', '', '', 'pending', ?, ?, ?)`,
      [crypto.randomUUID(), projectId, jobType, message.slice(0, 800), ts, ts],
    );
  } catch { /* escalation is best-effort */ }
}

// Bounded drain used by the worker tick and the enqueue kick. The flag keeps drains from
// stacking (a 30s tick can't pile onto a long drain).
//
// CONCURRENCY. This was a strictly serial loop: one job at a time, however much hardware
// the box had, which capped a team deployment at one portal run at a time regardless of
// RAM. It now runs up to JOB_CONCURRENCY jobs at once, keeping the pool topped up rather
// than draining in barriered batches.
//
// Default 1 — identical to the old behaviour. Concurrency is OPT-IN because it arms
// hazards serial execution masked (chiefly the per-(client, portal) Chromium profile lock,
// which is why openPortal now queues on the profile). A single-operator workstation should
// leave it at 1; a team server sets it to what its RAM affords, roughly 400MB per
// concurrent browser. See docs/SCALE_DEPLOYMENT.md.
let drainBusy = false;
const MAX_JOBS_PER_TICK = Math.max(1, Number(process.env.MAX_JOBS_PER_TICK ?? 5));
const JOB_CONCURRENCY = Math.max(1, Number(process.env.JOB_CONCURRENCY ?? 1));
// A tick cannot start more jobs than its budget, so a JOB_CONCURRENCY above MAX_JOBS_PER_TICK
// would be silently clamped — the operator sets 8 and gets 5. Raise the budget to match
// rather than surprising them; the budget exists to bound one tick, not to cap concurrency.
const JOBS_PER_TICK = Math.max(MAX_JOBS_PER_TICK, JOB_CONCURRENCY);
// Longest a single drain will WAIT on in-flight jobs before returning. Jobs keep running;
// this only stops one hung handler from holding drainBusy — and therefore the entire
// queue — for the life of the process.
const DRAIN_MAX_MS = Math.max(60_000, Number(process.env.DRAIN_MAX_MS ?? 10 * 60_000));

export async function drainPendingJobs(db: AppDb): Promise<number> {
  if (drainBusy) return 0;
  drainBusy = true;
  let started = 0;
  let completed = 0;
  // How many consecutive probes came back empty. A SINGLE empty probe is not proof the
  // queue is drained — with N calls in flight, one can lose the race for the last row and
  // report empty while work remains. Latching on that first empty stopped the pool being
  // refilled and stranded jobs behind a slow one, so require the queue to look empty with
  // nothing else running before believing it.
  let emptyProbes = 0;
  const running = new Set<Promise<void>>();
  const startOne = (): void => {
    started += 1;
    const p = (async () => {
      // The claim inside processNextJob is fully synchronous (better-sqlite3 is sync and
      // there is no await before the row is marked 'running'), so parallel callers each
      // take a DIFFERENT job — they cannot interleave mid-claim.
      const ran = await processNextJob(db);
      if (ran) { completed += 1; emptyProbes = 0; } else { emptyProbes += 1; }
    })();
    running.add(p);
    void p.catch(() => null).finally(() => { running.delete(p); });
  };
  try {
    // A job whose promise never settles (a handler that hangs on a dead socket) used to
    // hold drainBusy for the life of the process, silently stopping ALL queue processing.
    // The drain's own tick is therefore bounded: work already started keeps running, we
    // just stop waiting on it and let the next tick continue.
    const deadline = Date.now() + DRAIN_MAX_MS;
    const timeLeft = () => Math.max(0, deadline - Date.now());
    while (started < JOBS_PER_TICK && timeLeft() > 0) {
      while (started < JOBS_PER_TICK && running.size < JOB_CONCURRENCY && emptyProbes === 0) {
        startOne();
        // Yield so a just-started call that found an empty queue can report it before we
        // start another; at worst we start one extra call that finds nothing and returns.
        await Promise.resolve();
      }
      if (!running.size) break;              // nothing in flight and the queue read empty
      await Promise.race([
        Promise.race([...running]).catch(() => null),
        new Promise((r) => setTimeout(r, Math.min(timeLeft(), 30_000))),
      ]);
      // A slot freed: if the last probe was empty but jobs are still running, they may
      // enqueue follow-on work, so allow probing again rather than latching shut.
      if (emptyProbes > 0 && running.size > 0) emptyProbes = 0;
    }
    // Wait for what we started, but never past the deadline — see above.
    await Promise.race([
      Promise.all([...running].map((p) => p.catch(() => null))),
      new Promise((r) => setTimeout(r, timeLeft())),
    ]);
  } finally {
    drainBusy = false;
  }
  return completed;
}

// ONE PROJECT, ONE PORTAL EFFECT AT A TIME. A pending job of a portal-effect type is not
// claimable while its project already has a RUNNING job of any portal-effect type: two such
// runs on one project drive two browsers against the same live application on the same
// per-(client, portal) profile, and staging is not idempotent portal-side. The same holds
// for two stage_step chains on one project (both build the packet; duplicate generated rows
// were measured). The job is left PENDING — it runs on a later claim once the project frees.
// Expressed in SQL so the candidate read and the claim UPDATE enforce the same predicate.
const PORTAL_EFFECT_TYPES_SQL = [...PORTAL_EFFECT_JOB_TYPES].map((t) => `'${t}'`).join(", ");
const PROJECT_BUSY_SQL = `NOT (
     project_id IS NOT NULL AND (
       (job_type IN (${PORTAL_EFFECT_TYPES_SQL}) AND EXISTS (
          SELECT 1 FROM job_queue busy WHERE busy.project_id = job_queue.project_id
             AND busy.status = 'running' AND busy.job_type IN (${PORTAL_EFFECT_TYPES_SQL})))
       OR (job_type = 'stage_step' AND EXISTS (
          SELECT 1 FROM job_queue busy WHERE busy.project_id = job_queue.project_id
             AND busy.status = 'running' AND busy.job_type = 'stage_step'))))`;

// Claim the next runnable job: mark it 'running' and return it, or null when nothing is
// claimable. FULLY SYNCHRONOUS — no await between the read and the claim — so concurrent
// drain callers in this process each take a different job and cannot both pass the
// per-project busy check. Exported so the claim rules are tested without running handlers.
export function claimNextJob(db: AppDb): JobRecord | null {
  const now = nowIso();
  // Claim a job atomically.
  //
  // FAIRNESS: this used to be a straight global FIFO, so one tenant enqueueing a
  // hundred jobs held every worker slot until they drained and every other tenant's
  // work waited behind them. The order is now: priority first (an operator-triggered
  // job still beats background sweeps), then the org with the least work IN FLIGHT,
  // then age. That keeps a busy tenant from starving a quiet one without needing a
  // separate worker per org.
  const runningByOrg = new Map<string, number>();
  for (const r of db.query<Row>("SELECT org_id, COUNT(*) AS cnt FROM job_queue WHERE status = 'running' GROUP BY org_id")) {
    runningByOrg.set(String(r.org_id || DEFAULT_ORG_ID), Number(r.cnt ?? 0));
  }
  const candidates = db.query<Row>(
    // The busy filter is applied HERE, before the top priority is picked: filtering after
    // would let one waiting high-priority job hide every runnable lower-priority one.
    `SELECT * FROM job_queue
     WHERE status = 'pending'
       AND (scheduled_at IS NULL OR scheduled_at <= ?)
       AND ${PROJECT_BUSY_SQL}
     ORDER BY priority DESC, created_at ASC
     LIMIT 50`,
    [now],
  );
  if (candidates.length === 0) return null;
  const topPriority = Number(candidates[0].priority ?? 5);
  const row = candidates
    .filter((c) => Number(c.priority ?? 5) === topPriority)
    .sort((x, y) => {
      const bx = runningByOrg.get(String(x.org_id || DEFAULT_ORG_ID)) ?? 0;
      const by = runningByOrg.get(String(y.org_id || DEFAULT_ORG_ID)) ?? 0;
      if (bx !== by) return bx - by;
      return String(x.created_at).localeCompare(String(y.created_at));
    })[0];
  if (!row) return null;

  const job = mapJob(row);
  db.run(`UPDATE job_queue SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending' AND ${PROJECT_BUSY_SQL}`, [now, job.id]);

  // Verify we won the claim (optimistic lock)
  const claimed = db.get<Row>("SELECT status FROM job_queue WHERE id = ?", [job.id]);
  if (!claimed || String(claimed.status) !== "running") return null;
  return { ...job, status: "running", startedAt: now };
}

/** A design-criteria lookup (or the full code research that asks for the same criteria) finished —
 *  AFTER its row left 'running', so the re-judged finding reads where the lookup now stands. The
 *  gate of every pre-stage project in that AHJ is re-run (repository.rejudgeReviewerGatesAfterLookup).
 *  Best effort: a failure here never changes the job's own outcome. */
async function rejudgeAfterJurisdictionLookup(db: AppDb, job: JobRecord): Promise<void> {
  if (job.jobType !== "design_criteria_research" && job.jobType !== "code_research") return;
  const p = job.payload as { state?: unknown; ahj?: unknown };
  if (!String(p.ahj || "").trim()) return; // the state layer: no AHJ's criteria
  try {
    const { rejudgeReviewerGatesAfterLookup } = await import("./repository");
    await rejudgeReviewerGatesAfterLookup(db, { state: String(p.state || ""), ahj: String(p.ahj || "") }, `${job.jobType}_landed`);
  } catch (err) {
    logger.warn("job-worker", `re-judge after ${job.jobType} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Process one pending job. Returns true if a job was found and processed.
export async function processNextJob(db: AppDb): Promise<boolean> {
  const job = claimNextJob(db);
  if (!job) return false;
  // LLM-6: every model call this job makes — directly or in anything it awaits or schedules —
  // is attributed to the claimed row's project, job and org in llm_calls.
  return runWithLlmContext({ projectId: job.projectId, jobId: job.id, orgId: job.orgId }, () => runClaimedJob(db, job));
}

async function runClaimedJob(db: AppDb, job: JobRecord): Promise<boolean> {
  // Mark in-flight so the watchdog can't reclaim this run out from under us.
  inFlightJobIds.add(job.id);
  try {
    let result: Record<string, unknown> = {};

    if (job.jobType === "permit_checks" || job.jobType === "nem_checks") {
      const targetType = job.jobType === "nem_checks" ? "nem" : "permit";
      const checkResult = await runDuePermitChecks(db, targetType);
      result = { checked: checkResult.checked };
    } else if (job.jobType === "mbox_import") {
      result = await runMboxImportJob(db, job);
    } else if (job.jobType === "folder_scan") {
      result = await runFolderScanJob(db, job);
    } else if (job.jobType === "stage_step") {
      const { processStageStep } = await import("./autoStageSteps");
      // Each step names itself on the job row (progress_note) as it starts — the project page's
      // "Checking the AHJ's required official forms… (started HH:MM)" line reads it (nextStep).
      const step = await processStageStep(db, String(job.projectId), { onStep: (label) => noteJobProgress(db, job.id, label) });
      result = { ran: step.ran, stoppedAt: step.stoppedAt, message: step.reason };
      // The chain runs server-side while the operator may be looking at the project. Without
      // an event the open page keeps showing "not run" until someone reloads it.
      if (step.ran.length) {
        void import("./events").then(({ sseBroadcast }) => {
          sseBroadcast({ type: "stage_steps_done", projectId: job.projectId ?? undefined, message: `Pipeline ran automatically: ${step.ran.join(", ")} — ${step.reason}` });
        }).catch(() => null);
      }
    } else if (job.jobType === "autopilot") {
      const { runAutopilotSegmentA } = await import("./autopilot");
      const track = (job.payload.track as string | undefined) || undefined;
      const seg = await runAutopilotSegmentA(db, String(job.projectId), track as never);
      result = { blocked: seg.blocked, blockers: seg.blockers, message: seg.message, phase: seg.state.phase };
      // Announce the ACTUAL outcome from the one place every path runs through
      // (route kick, worker drain, auto-start, auto-resume). Best-effort.
      void import("./events").then(({ sseBroadcast }) => {
        const projectId = job.projectId ?? undefined;
        if (seg.blocked && seg.blockers.some((b) => b.code === "paused_for_human")) {
          // An MFA/CAPTCHA pause is a designed human handoff, not an error — keep the
          // warning-severity pause toast even though Segment A reports it as blocked.
          sseBroadcast({ type: "run_paused", projectId, message: "Autopilot paused — the portal needs human attention." });
        } else if (seg.blocked) {
          const why = seg.blockers.map((b) => b.detail).join("; ").slice(0, 400) || seg.message;
          sseBroadcast({ type: "run_failed", projectId, message: `Autopilot blocked: ${why}` });
        } else if (seg.state.phase === "awaiting_approval") {
          sseBroadcast({ type: "run_complete", projectId, message: "Autopilot reached the approval gate." });
        } else if (seg.state.phase === "paused_for_human") {
          sseBroadcast({ type: "run_paused", projectId, message: "Autopilot paused — the portal needs human attention." });
        }
      }).catch(() => null);
    } else if (job.jobType === "prepare_submission") {
      // Operator-initiated staging run, off the HTTP request path so a multi-second
      // (sometimes multi-minute) live portal pass never hangs or times out the request.
      const { prepareSubmission } = await import("./repository");
      const track = (job.payload.track as string | undefined) || undefined;
      const autoSubmit = job.payload.autoSubmit === true;
      const allowFinalSubmit = job.payload.allowFinalSubmit === true;
      const detail = await prepareSubmission(db, String(job.projectId), track as never, autoSubmit, allowFinalSubmit);
      const run = detail.portalRuns?.[0];
      // Carry the run's failure text so the dashboard toast can say WHY, not just "failed".
      result = { status: run?.status ?? null, pauseReason: run?.pauseReason ?? null, message: run?.errorMessage || null };
    } else if (job.jobType === "auto_learn") {
      // Manual "Learn this portal" run, off the HTTP request path — a live LLM-driven
      // browser pass routinely takes minutes, which hung or proxy-timed-out the old
      // synchronous endpoint. Progress still streams over SSE (autolearn_progress) with
      // the same coarse phase→percent mapping the dashboard's progress bar expects.
      const { autoLearnPortal } = await import("./autoLearn");
      const { sseBroadcast } = await import("./events");
      const p = job.payload as { scope?: string; portalUrl?: string; createdBy?: string; permitType?: string; discipline?: string; track?: string | null };
      const projectId = String(job.projectId);
      const learnResult = await autoLearnPortal(db, projectId, {
        scope: p.scope === "utility" ? "utility" : "ahj",
        portalUrl: String(p.portalUrl || ""),
        createdBy: p.createdBy || "operator",
        permitType: p.permitType === "electrical" ? "electrical" : p.permitType === "structural" ? "structural" : undefined,
        // Carried so a queued/auto re-learn writes the SAME discipline the lookup keys on.
        discipline: typeof p.discipline === "string" ? p.discipline : undefined,
        // ...and the SAME issuer view: a stage's re-learn carries its own track (null = trackless —
        // JSON keeps the null), so it keys where the stale recipe was found. An operator's queued
        // learn carries none and names its permit by permitType / discipline.
        ...(p.track !== undefined ? { track: typeof p.track === "string" && p.track.trim() ? p.track.trim() : null } : {}),
        onProgress: (prog) => {
          const percent =
            prog.phase === "login" ? 8
              : prog.phase === "page" ? Math.min(82, 12 + prog.pageCount * 12)
                : prog.phase === "review" ? 90
                  : prog.phase === "verify" ? 96
                    : 100;
          sseBroadcast({
            type: "autolearn_progress",
            projectId,
            message: prog.message,
            data: { phase: prog.phase, percent, pageCount: prog.pageCount, maxPages: prog.maxPages, classification: prog.classification ?? null },
          });
        },
      });
      // The job result is what the dashboard renders as the verdict — keep it complete but
      // slim: the full recipe steps live in portal_recipes, not in the job row.
      result = {
        status: learnResult.status,
        pauseReason: learnResult.pauseReason,
        pageCount: learnResult.pageCount,
        finalSubmitRecorded: learnResult.finalSubmitRecorded,
        verification: learnResult.verification,
        message: learnResult.message,
        debugDir: learnResult.debugDir,
        recipeId: learnResult.recipe?.id ?? null,
        recipeStatus: learnResult.recipe?.status ?? null,
      };
      // Auto-triage a run that wasn't trusted: enqueue a run_triage job pointing at
      // this run's bundle so the agent explains what it missed (opt out: RUN_TRIAGE=off).
      if (learnResult.status !== "trusted" && learnResult.debugDir && process.env.RUN_TRIAGE !== "off") {
        const runId = String(learnResult.debugDir).split(/[\\/]/).filter(Boolean).pop() || "";
        if (runId) {
          try { enqueueJob(db, "run_triage", { runId }, { projectId, priority: 3 }); } catch { /* best-effort */ }
        }
      }
    } else if (job.jobType === "run_triage") {
      // Post-run triage agent: read the finished learn/stage bundle and file findings.
      const { triageLearnRun } = await import("./runTriage");
      const runId = String(job.payload.runId || "");
      const triage = await triageLearnRun(db, runId, String(job.projectId));
      result = { provider: triage.provider, findings: triage.findings, appliedCount: triage.appliedCount, message: triage.message };
    } else if (job.jobType === "correction_triage") {
      // Correction-handling agent: classify + propose fixes for one correction row.
      const { triageCorrection } = await import("./correctionAgent");
      const p = job.payload as { correctionId?: string; correctionText?: string };
      const triage = await triageCorrection(db, {
        correctionId: String(p.correctionId || ""),
        projectId: String(job.projectId),
        correctionText: String(p.correctionText || ""),
      });
      result = { provider: triage.provider, bucket: triage.bucket, proposals: triage.proposals.length, message: triage.message };
    } else if (job.jobType === "code_research") {
      // Autonomous adopted-codes onboarding: web-search the jurisdiction's codes
      // (state or county/city layer) and store them as a SEEDED profile. Enqueued
      // automatically the first time any review touches an un-profiled jurisdiction
      // (codeProfiles.ensureCodeProfilesResearched). A human verifies later; until
      // then findings phrase "verify locally" and seeded thresholds never hard-block.
      // The body lives in codeProfiles.runCodeResearch (the backfill's --apply runs the same path):
      // a stub / model-memory / empty result stores NOTHING (the job row is the backoff marker and
      // carries the grounding evidence); a verified target gets a proposal, never a write; anything
      // else MERGES onto the row (stamp notes, imports and corrections are kept).
      const { runCodeResearch } = await import("./codeProfiles");
      result = await runCodeResearch(db, job.payload as Record<string, unknown>);
    } else if (job.jobType === "design_criteria_research") {
      // Fills ONLY blank design criteria on the AHJ's own row, as seeded, web-grounded values
      // with their citations only; never a verified row (codeProfiles.runDesignCriteriaResearch).
      const { runDesignCriteriaResearch } = await import("./codeProfiles");
      result = await runDesignCriteriaResearch(db, job.payload as Record<string, unknown>);
    } else if (job.jobType === "fee_research") {
      // Autonomous fee-schedule onboarding: web-research the jurisdiction's (or
      // utility's) published fee schedule and land it through the REAL save path —
      // researchFeeSchedule owns the retrieval ledger, so what is stored carries
      // citation/corroboration evidence, always as confidence 'seeded' (hard rule
      // 3). Enqueued the first time QC sees a project needing a fee row the table
      // cannot answer (feeSchedules.ensureFeeSchedulesResearched). Same contract as
      // code_research: gated on ANTHROPIC_API_KEY (the researcher itself refuses
      // without a key), and a stub/empty/found:false result stores NOTHING — an
      // empty fee row would block future auto-research for this target; the job
      // rows themselves are the re-try backoff marker. saveFeeSchedule owns the
      // hard refusals (human-verified rows, open conflicts, unsourced fees), so
      // nothing in this handler can weaken them.
      const { researchFeeSchedule } = await import("./feeSchedules");
      const p = job.payload as { state?: string; ahj?: string; utility?: string; track?: string; discipline?: string };
      const discipline = String(p.discipline || "");
      const outcome = await researchFeeSchedule(db, {
        state: String(p.state || ""),
        ahj: String(p.ahj || ""),
        utility: String(p.utility || ""),
        track: p.track === "nem" ? "nem" : "permit",
        discipline,
      });
      result = {
        saved: outcome.saved, found: outcome.found,
        profileKey: outcome.profileKey, track: outcome.track, discipline,
        refusedVerified: outcome.refusedVerified, refusedConflicted: outcome.refusedConflicted,
        reason: outcome.reason || undefined,
      };
      // The attempt is a visible fact either way (the cold-start portal-URL
      // research does the same): a save says where the fee sheet's new number came
      // from; a miss says research ran and found nothing, so the project's honest
      // unknown is a checked unknown, not a gap nobody looked at.
      try {
        addAuditLog(db, job.projectId, "system", "fee research",
          outcome.saved ? "fees.schedule_researched" : "fees.research_no_result", {
            profileKey: outcome.profileKey, track: outcome.track, discipline: discipline || "(any)",
            saved: outcome.saved, found: outcome.found,
            refusedVerified: outcome.refusedVerified || undefined,
            reason: (outcome.reason || "").slice(0, 400) || undefined,
          });
      } catch { /* audit is best-effort — never fail the job over it */ }
    } else if (job.jobType === "permit_process_lookup") {
      // Lands 'seeded' through permitProcess.savePermitProcessLookup (a verified row is never
      // overwritten) and its fees through saveFeeSchedule; then asks for fee research on whatever
      // the lookup could not price — for the agency it found, via the delegation it wrote.
      const { runPermitProcessLookup } = await import("./permitProcessLookup");
      const { createLLMProvider } = await import("./llm");
      const p = job.payload as Record<string, unknown>;
      const run = await runPermitProcessLookup(db, createLLMProvider(), {
        state: String(p.state || ""), ahj: String(p.ahj || ""), utility: String(p.utility || ""),
        dcKw: String(p.dcKw || ""), acKw: String(p.acKw || ""), permitPath: String(p.permitPath || ""),
      });
      result = { saved: run.saved, reason: run.reason, calls: run.calls };
      try {
        addAuditLog(db, job.projectId, "system", "permit process lookup", run.saved ? "permit_process.looked_up" : "permit_process.no_result", {
          ahj: String(p.ahj || ""), state: String(p.state || ""), saved: run.saved, reason: run.reason.slice(0, 300),
          agency: run.lookup?.issuingAgency?.value ?? null, structure: run.lookup?.permitStructure?.value ?? null,
        });
      } catch { /* audit is best-effort */ }
      if (job.projectId) {
        try {
          const { getProjectDetail } = await import("./repository");
          const { ensureFeeSchedulesResearched } = await import("./feeSchedules");
          const { requiredTracks } = await import("./submittalTracks");
          const project = getProjectDetail(db, job.projectId).project;
          void ensureFeeSchedulesResearched(db, project, requiredTracks(project)).catch(() => null);
        } catch { /* fee research is best-effort */ }
      }
    } else {
      result = { skipped: true, reason: "job type handled externally" };
    }

    db.run(
      // Guard on status='running': the watchdog may have reclaimed (re-queued or failed)
      // this job mid-run; the loser of that race must not clobber the new state.
      "UPDATE job_queue SET status = 'done', finished_at = ?, result = ?, progress = progress_total WHERE id = ? AND status = 'running'",
      [nowIso(), JSON.stringify(result), job.id],
    );
    await rejudgeAfterJurisdictionLookup(db, job);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retryCount = job.retryCount + 1;
    if (retryCount < job.maxRetries) {
      const retryDelay = Math.pow(2, retryCount) * 60_000;
      const retryAt = new Date(Date.now() + retryDelay).toISOString();
      // A silent retry hid staging-gate failures from the server log entirely — the
      // operator saw only a generic toast. Every failure is loggable, always.
      logger.warn("job-worker", `${job.jobType} failed (retry ${retryCount}/${job.maxRetries} at ${retryAt}): ${msg}`, { projectId: job.projectId ?? undefined });
      db.run(
        "UPDATE job_queue SET status = 'pending', retry_count = ?, scheduled_at = ?, error = ? WHERE id = ? AND status = 'running'",
        [retryCount, retryAt, msg, job.id],
      );
    } else {
      logger.warn("job-worker", `${job.jobType} FAILED: ${msg}`, { projectId: job.projectId ?? undefined });
      db.run(
        "UPDATE job_queue SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'",
        [nowIso(), msg, job.id],
      );
      escalateJobFailure(db, job.jobType, job.projectId, msg);
      await rejudgeAfterJurisdictionLookup(db, job);
    }
  } finally {
    inFlightJobIds.delete(job.id);
  }

  return true;
}
