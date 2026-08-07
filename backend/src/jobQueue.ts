import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { AppDb, SqlParam } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { importMboxKnowledge } from "./knowledgeBase";
import { runDuePermitChecks } from "./repository";
import { scanFolder } from "./batchImport";
import { nowIso } from "./time";
import { logger } from "./logger";

export type JobType =
  | "permit_checks"
  | "nem_checks"
  | "mbox_import"
  | "folder_scan"
  | "autopilot"
  | "prepare_submission"
  | "auto_learn"
  | "code_research"
  | "run_triage"
  | "correction_triage";

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
      options.maxRetries ?? 3,
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
  const stale = db.query<Row>(
    "SELECT id, updated_at FROM portal_recipes WHERE status = 'recording' AND updated_at <= ?",
    [cutoff],
  );
  if (!stale.length) return 0;
  for (const row of stale) {
    db.run(
      "UPDATE portal_recipes SET status = 'needs_rerecord', notes = ?, updated_at = ? WHERE id = ? AND status = 'recording'",
      [`Recording was interrupted (no activity since ${String(row.updated_at)}); marked for re-record.`, nowIso(), String(row.id)],
    );
  }
  console.log(`[job-worker] marked ${stale.length} stale portal recording(s) as needs_rerecord`);
  return stale.length;
}

// Background worker — call once at server startup. Polls the job queue on a fixed interval.
// Interval defaults to JOB_WORKER_INTERVAL_MS env var, or 30 seconds.
export function startJobWorker(db: AppDb): ReturnType<typeof setInterval> {
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

// Bounded serial drain used by the worker tick and the enqueue kick. The flag
// keeps drains strictly serial (a 30s tick can't stack onto a long drain);
// jobs stay one-at-a-time within a drain. Direct processNextJob callers keep
// today's semantics — the atomic claim makes any overlap a no-op, not a dupe.
let drainBusy = false;
const MAX_JOBS_PER_TICK = Math.max(1, Number(process.env.MAX_JOBS_PER_TICK ?? 5));

export async function drainPendingJobs(db: AppDb): Promise<number> {
  if (drainBusy) return 0;
  drainBusy = true;
  let processed = 0;
  try {
    while (processed < MAX_JOBS_PER_TICK && (await processNextJob(db))) processed += 1;
  } finally {
    drainBusy = false;
  }
  return processed;
}

// Process one pending job. Returns true if a job was found and processed.
export async function processNextJob(db: AppDb): Promise<boolean> {
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
    `SELECT * FROM job_queue
     WHERE status = 'pending'
       AND (scheduled_at IS NULL OR scheduled_at <= ?)
     ORDER BY priority DESC, created_at ASC
     LIMIT 50`,
    [now],
  );
  if (candidates.length === 0) return false;
  const topPriority = Number(candidates[0].priority ?? 5);
  const row = candidates
    .filter((c) => Number(c.priority ?? 5) === topPriority)
    .sort((x, y) => {
      const bx = runningByOrg.get(String(x.org_id || DEFAULT_ORG_ID)) ?? 0;
      const by = runningByOrg.get(String(y.org_id || DEFAULT_ORG_ID)) ?? 0;
      if (bx !== by) return bx - by;
      return String(x.created_at).localeCompare(String(y.created_at));
    })[0];
  if (!row) return false;

  const job = mapJob(row);
  db.run("UPDATE job_queue SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'", [now, job.id]);

  // Verify we won the claim (optimistic lock)
  const claimed = db.get<Row>("SELECT status FROM job_queue WHERE id = ?", [job.id]);
  if (!claimed || String(claimed.status) !== "running") return false;

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
    } else if (job.jobType === "autopilot") {
      const { runAutopilotSegmentA } = await import("./autopilot");
      const track = (job.payload.track as string | undefined) || undefined;
      const seg = await runAutopilotSegmentA(db, String(job.projectId), track as never);
      result = { blocked: seg.blocked, blockers: seg.blockers, message: seg.message, phase: seg.state.phase };
      // Announce the ACTUAL outcome from the one place every path runs through
      // (route kick, worker drain, auto-start, auto-resume). Best-effort.
      void import("./events").then(({ sseBroadcast }) => {
        const projectId = job.projectId ?? undefined;
        if (seg.blocked) {
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
      const detail = await prepareSubmission(db, String(job.projectId), track as never, autoSubmit);
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
      const p = job.payload as { scope?: string; portalUrl?: string; createdBy?: string; permitType?: string };
      const projectId = String(job.projectId);
      const learnResult = await autoLearnPortal(db, projectId, {
        scope: p.scope === "utility" ? "utility" : "ahj",
        portalUrl: String(p.portalUrl || ""),
        createdBy: p.createdBy || "operator",
        permitType: p.permitType === "electrical" ? "electrical" : p.permitType === "structural" ? "structural" : undefined,
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
      const { createLLMProvider } = await import("./llm");
      const { saveResearchedCodeProfile } = await import("./codeProfiles");
      const state = String(job.payload.state || "");
      const ahj = String(job.payload.ahj || "");
      const research = await createLLMProvider().researchJurisdictionCodes({ state, ahj });
      if (research.provider === "stub" || research.profile.adoptedCodes.length === 0) {
        // Don't store an empty row — it would block future auto-research for this
        // layer. Leave the jurisdiction un-profiled and report why.
        result = { saved: false, reason: research.provider === "stub" ? "stub LLM (no API key)" : "research found no adopted codes", notes: research.notes };
      } else {
        const saved = saveResearchedCodeProfile(db, research.profile);
        result = { saved: true, key: saved.key, confidence: saved.confidence, webGrounded: research.webGrounded, adoptedCodes: saved.adoptedCodes.length };
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
    }
  } finally {
    inFlightJobIds.delete(job.id);
  }

  return true;
}
