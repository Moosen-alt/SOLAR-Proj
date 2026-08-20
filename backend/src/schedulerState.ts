import type { AppDb } from "./db";
import { logger } from "./logger";
import { nowIso } from "./time";

// PERSISTENT long-interval scheduling.
//
// The three long-interval sweeps (KB link check 14d, AHJ form refresh 60d, CEC
// sync 7d) used to accumulate elapsed time in a module-level variable, which
// reset to zero on every restart — so a server restarted more often than the
// interval NEVER ran them, and the 60-day form refresh effectively required 60
// days of continuous uptime. The clock now lives in scheduler_state
// (migration v13), so a restart resumes it instead of resetting it.
//
// Semantics preserved from the old accumulator:
//   - A FRESH install waits one full interval before the first run (the baseline
//     row is stamped at first boot) — no surprise LLM-costly sweep on install.
//   - The daily wake-step stays, because a days-long setInterval in ms overflows
//     the 32-bit cap (~24.8 days) and silently collapses to 1ms.
//   - A failed tick is NOT recorded as a run, so it retries on the next daily
//     step rather than waiting out another full interval.
// New: a catch-up check ~60s after boot, so an overdue sweep on a
// daily-restarted server runs promptly instead of waiting for the next step.

const DAY_MS = 24 * 60 * 60 * 1000;

export function lastRunAt(db: AppDb, task: string): string | null {
  const row = db.get<{ last_run_at?: string }>("SELECT last_run_at FROM scheduler_state WHERE task = ?", [task]);
  return row?.last_run_at ? String(row.last_run_at) : null;
}

export function recordRun(db: AppDb, task: string, result = "ok"): void {
  db.run(
    `INSERT INTO scheduler_state (task, last_run_at, last_result) VALUES (?, ?, ?)
     ON CONFLICT(task) DO UPDATE SET last_run_at = excluded.last_run_at, last_result = excluded.last_result`,
    [task, nowIso(), result.slice(0, 400)],
  );
}

/**
 * Run `tick` every `days` days, with the clock persisted across restarts.
 * `tick` should THROW on failure — a throw is logged and not recorded, so the
 * sweep retries on the next daily step instead of waiting out a full interval.
 */
export function startPersistentSchedule(
  db: AppDb,
  opts: { task: string; days: number; scope: string; tick: () => Promise<void> },
): void {
  const intervalMs = opts.days * DAY_MS;
  const stepMs = Math.min(intervalMs, DAY_MS);
  // Baseline for a fresh install: first run happens one interval from FIRST boot;
  // later restarts leave the stamp alone.
  db.run("INSERT OR IGNORE INTO scheduler_state (task, last_run_at, last_result) VALUES (?, ?, 'baseline')", [opts.task, nowIso()]);

  let running = false;
  const step = async (): Promise<void> => {
    if (running) return;
    const last = Date.parse(lastRunAt(db, opts.task) || "") || Date.now();
    if (Date.now() - last < intervalMs) return;
    running = true;
    try {
      await opts.tick();
      recordRun(db, opts.task, "ok");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(opts.scope, `${opts.task} tick failed (will retry on the next daily step): ${msg}`);
      // Record the failure on the row WITHOUT touching last_run_at — the untouched
      // stamp is exactly what makes the next daily step retry.
      db.run("UPDATE scheduler_state SET last_result = ? WHERE task = ?", [`error: ${msg}`.slice(0, 400), opts.task]);
    } finally {
      running = false;
    }
  };

  // Catch-up shortly after boot — the case the in-memory version could never handle.
  setTimeout(() => void step().catch(() => null), 60_000).unref();
  setInterval(() => void step().catch(() => null), stepMs).unref();
}
