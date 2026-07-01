import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { AppDb, SqlParam } from "./db";
import { importMboxKnowledge } from "./knowledgeBase";
import { runDuePermitChecks } from "./repository";
import { scanFolder } from "./batchImport";
import { nowIso } from "./time";

export type JobType =
  | "permit_checks"
  | "nem_checks"
  | "mbox_import"
  | "folder_scan"
  | "autopilot"
  | "prepare_submission"
  | "auto_learn";

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
  } = {},
): JobRecord {
  const id = crypto.randomUUID();
  const ts = nowIso();
  db.run(
    `INSERT INTO job_queue
      (id, job_type, payload, status, priority, assigned_to_user, project_id,
       created_at, scheduled_at, progress, progress_total, retry_count, max_retries)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
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
    ],
  );
  return mapJob(db.get<Row>("SELECT * FROM job_queue WHERE id = ?", [id])!);
}

export function listJobs(
  db: AppDb,
  filter: { status?: JobStatus; jobType?: JobType; limit?: number } = {},
): JobRecord[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
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

// Reclaim jobs stranded in `running`. The worker is single-process, so any job still
// `running` either (a) was interrupted by a restart, or (b) has outlived the max
// runtime watchdog. Either way it is dead: re-queue it for another attempt (counting
// the lost run against its retry budget so a poison job eventually fails instead of
// looping forever), or fail it outright once retries are exhausted.
export function recoverOrphanedJobs(db: AppDb, opts: { startup?: boolean } = {}): number {
  const cutoff = new Date(Date.now() - JOB_MAX_RUNTIME_MS).toISOString();
  // On startup every `running` row is orphaned; mid-run only those past the watchdog.
  const stale = db.query<Row>(
    opts.startup
      ? "SELECT * FROM job_queue WHERE status = 'running'"
      : "SELECT * FROM job_queue WHERE status = 'running' AND started_at IS NOT NULL AND started_at <= ?",
    opts.startup ? [] : [cutoff],
  );
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
    }
  }
  console.log(`[job-worker] recovered ${stale.length} orphaned job(s)${opts.startup ? " on startup" : ""}`);
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
    // then process the next pending job.
    try {
      recoverOrphanedJobs(db);
    } catch (err) {
      console.error("[job-worker] orphan recovery error:", err instanceof Error ? err.message : String(err));
    }
    processNextJob(db).catch((err) => {
      console.error("[job-worker] uncaught error:", err instanceof Error ? err.message : String(err));
    });
  }, intervalMs);
  console.log(`[job-worker] started — polling every ${intervalMs / 1000}s`);
  return timer;
}

// Process one pending job. Returns true if a job was found and processed.
export async function processNextJob(db: AppDb): Promise<boolean> {
  const now = nowIso();
  // Claim a job atomically
  const row = db.get<Row>(
    `SELECT * FROM job_queue
     WHERE status = 'pending'
       AND (scheduled_at IS NULL OR scheduled_at <= ?)
     ORDER BY priority DESC, created_at ASC
     LIMIT 1`,
    [now],
  );
  if (!row) return false;

  const job = mapJob(row);
  db.run("UPDATE job_queue SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'", [now, job.id]);

  // Verify we won the claim (optimistic lock)
  const claimed = db.get<Row>("SELECT status FROM job_queue WHERE id = ?", [job.id]);
  if (!claimed || String(claimed.status) !== "running") return false;

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
    } else if (job.jobType === "prepare_submission") {
      // Operator-initiated staging run, off the HTTP request path so a multi-second
      // (sometimes multi-minute) live portal pass never hangs or times out the request.
      const { prepareSubmission } = await import("./repository");
      const track = (job.payload.track as string | undefined) || undefined;
      const autoSubmit = job.payload.autoSubmit === true;
      const detail = await prepareSubmission(db, String(job.projectId), track as never, autoSubmit);
      const run = detail.portalRuns?.[0];
      result = { status: run?.status ?? null, pauseReason: run?.pauseReason ?? null };
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
    } else {
      result = { skipped: true, reason: "job type handled externally" };
    }

    db.run(
      "UPDATE job_queue SET status = 'done', finished_at = ?, result = ?, progress = progress_total WHERE id = ?",
      [nowIso(), JSON.stringify(result), job.id],
    );
  } catch (err) {
    const retryCount = job.retryCount + 1;
    if (retryCount < job.maxRetries) {
      const retryDelay = Math.pow(2, retryCount) * 60_000;
      const retryAt = new Date(Date.now() + retryDelay).toISOString();
      db.run(
        "UPDATE job_queue SET status = 'pending', retry_count = ?, scheduled_at = ?, error = ? WHERE id = ?",
        [retryCount, retryAt, String(err), job.id],
      );
    } else {
      db.run(
        "UPDATE job_queue SET status = 'failed', finished_at = ?, error = ? WHERE id = ?",
        [nowIso(), String(err), job.id],
      );
    }
  }

  return true;
}
