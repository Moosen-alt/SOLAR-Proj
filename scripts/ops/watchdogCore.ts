// WATCHDOG CORE — decide, from one poll, what (if anything) a human must be told.
//
// Pure apart from reading the backup directories: the HTTP fetch and the clock are injected, and
// delivery is the caller's job (scripts/ops/watchdog.ts), so the whole state machine is testable
// against a fake server with no mail server and no waiting.
//
// WHAT IS WATCHED
//   server      GET /health: no answer, a non-200, or ok:false. Alerts after WATCHDOG_DOWN_AFTER
//               consecutive failed polls (default 2), so one slow response is not a page.
//   queue       /health's own "pending but nothing running" warning (the stuck-worker shape).
//   job-failures  /health jobs.failed24h going UP between polls = new permanent job failures.
//               An EVENT, not a state — but a THROTTLED one: the first rise after a quiet spell
//               is sent at once; rises inside the next JOB_FAILURES_MIN_GAP_HOURS are added up
//               and sent as ONE message ("N failed since <time>") when the gap has passed. A
//               portal outage during a 100-project batch used to send one message per poll (48
//               in 4 h, D2 verification F2), and an operator stops reading a channel like that.
//   backup      the newest automatic snapshot in BACKUP_DIR is older than the allowed age, or the
//               server recorded a failed attempt (.last-backup.json) after it.
//   offbox      (when an off-box folder is configured) the newest snapshot there is too old, or
//               the last offbox-sync run reported a problem (.offbox-status.json).
//   gap         the watchdog itself did not run for a long stretch — on this box that means the
//               power went out or the machine was off. Reported once, when it comes back.
//
// DE-DUPLICATION: a state check alerts once when it goes bad, then again only every
// WATCHDOG_REPEAT_HOURS while it stays bad (0 = never), and sends one RECOVERED when it clears.
//
// AN UNKNOWN IS NOT A RECOVERY. While the server does not answer, the queue and job-failure checks
// have no reading: their state is left exactly as it was, never cleared.
//
// PRIVACY: every sentence below is built from fixed text, numbers, times and snapshot stamps.
// No string the server, a status file or a job produced is ever copied into an alert — /health's
// error text, a job's error, a backup error message can all carry a path, a name or an address.
import fs from "node:fs";
import path from "node:path";
// ONE definition of "an automatic snapshot" and of the status-file names, shared with the code
// that writes them (backup.ts, offbox-sync.ts). A second regex here could drift and go blind.
import { AUTOMATIC_SNAPSHOT_RE, BACKUP_STATUS_NAME, OFFBOX_STATUS_NAME } from "../../backend/src/offboxBackup";

export interface WatchdogConfig {
  name: string;
  healthUrl: string;
  timeoutMs: number;
  downAfter: number;
  repeatHours: number;
  /** Poll cadence, used only to recognise a gap in the watchdog's own runs. */
  intervalSec: number;
  backupDir: string | null;
  backupMaxAgeHours: number;
  offboxDir: string | null;
  offboxMaxAgeHours: number;
  /** Least time between two job-failures messages (default JOB_FAILURES_MIN_GAP_HOURS). */
  jobFailuresMinGapHours?: number;
}

export const JOB_FAILURES_MIN_GAP_HOURS = 1;

/** The job-failures throttle: rises seen while a message was not allowed yet, carried until the
 *  next message (never dropped). */
export interface JobFailuresState {
  lastAlertAt: string | null;
  /** Rises accumulated since the last message (0 = nothing pending). */
  pendingRise: number;
  /** When the first pending rise was observed. */
  pendingSince: string | null;
}

export interface CheckState {
  bad: boolean;
  /** Consecutive bad observations (only the server check needs more than one). */
  failCount: number;
  /** When the current bad stretch started (first bad observation). */
  since: string | null;
  lastAlertAt: string | null;
}

export interface WatchdogState {
  version: 1;
  lastRunAt: string | null;
  lastFailed24h: number | null;
  checks: Record<string, CheckState>;
  /** Alerts that no channel accepted last time — re-sent first on the next run. */
  undelivered: Alert[];
  /** Absent in state files written before the throttle: treated as nothing pending. */
  jobFailures?: JobFailuresState;
}

export type AlertKind = "problem" | "reminder" | "recovered" | "event" | "armed";
export interface Alert {
  key: string;
  kind: AlertKind;
  summary: string;
  at: string;
  /** Carried over from a run where no channel accepted it. */
  delayed?: boolean;
}

export interface Observation {
  server: "up" | "down";
  serverDetail: string;
  jobs: { pending: number; running: number; failed24h: number } | null;
  backupNewest: string | null;
  backupAgeHours: number | null;
  offboxNewest: string | null;
  offboxAgeHours: number | null;
}

export interface WatchdogDeps {
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;
  now: () => Date;
}

export function emptyState(): WatchdogState {
  return { version: 1, lastRunAt: null, lastFailed24h: null, checks: {}, undelivered: [] };
}

export function loadState(file: string): { state: WatchdogState; fresh: boolean } {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WatchdogState>;
    if (raw && raw.version === 1 && raw.checks && typeof raw.checks === "object") {
      return {
        state: {
          version: 1,
          lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : null,
          lastFailed24h: typeof raw.lastFailed24h === "number" ? raw.lastFailed24h : null,
          checks: raw.checks as Record<string, CheckState>,
          undelivered: Array.isArray(raw.undelivered) ? raw.undelivered.slice(-20) : [],
          ...(raw.jobFailures && typeof raw.jobFailures === "object" ? { jobFailures: {
            lastAlertAt: typeof raw.jobFailures.lastAlertAt === "string" ? raw.jobFailures.lastAlertAt : null,
            pendingRise: typeof raw.jobFailures.pendingRise === "number" && raw.jobFailures.pendingRise > 0 ? Math.floor(raw.jobFailures.pendingRise) : 0,
            pendingSince: typeof raw.jobFailures.pendingSince === "string" ? raw.jobFailures.pendingSince : null,
          } } : {}),
        },
        fresh: false,
      };
    }
  } catch { /* missing or unreadable: start fresh */ }
  return { state: emptyState(), fresh: true };
}

export function saveState(file: string, state: WatchdogState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

/** Local wall-clock time, minute precision — what the operator's phone should show. */
export function localTime(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

function newestSnapshot(dir: string): { name: string; mtimeMs: number } | null {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best: { name: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!AUTOMATIC_SNAPSHOT_RE.test(name)) continue;
    try {
      const m = fs.statSync(path.join(dir, name)).mtimeMs;
      if (!best || m > best.mtimeMs) best = { name, mtimeMs: m };
    } catch { /* vanished mid-scan (rotation) */ }
  }
  return best;
}

function readStatus(file: string): { ok: boolean; atMs: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { ok?: unknown; at?: unknown };
    const atMs = typeof raw.at === "string" ? Date.parse(raw.at) : NaN;
    if (typeof raw.ok !== "boolean" || !Number.isFinite(atMs)) return null;
    return { ok: raw.ok, atMs };
  } catch {
    return null;
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One poll. Returns the new state (the caller persists it) and the alerts to deliver. */
export async function runOnce(config: WatchdogConfig, prev: WatchdogState, deps: WatchdogDeps, opts: { fresh?: boolean } = {}): Promise<{ state: WatchdogState; alerts: Alert[]; observation: Observation }> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const state: WatchdogState = JSON.parse(JSON.stringify(prev)) as WatchdogState;
  state.undelivered = [];
  const alerts: Alert[] = [];
  const alert = (key: string, kind: AlertKind, summary: string): void => { alerts.push({ key, kind, summary, at: nowIso }); };

  // --- gap: did the watchdog itself stop running? --------------------------------------------
  // Three missed polls, and never less than 15 minutes, before a gap counts.
  if (state.lastRunAt) {
    const gapMs = now.getTime() - Date.parse(state.lastRunAt);
    const threshold = Math.max(15 * 60_000, 3 * config.intervalSec * 1000);
    if (Number.isFinite(gapMs) && gapMs > threshold) {
      alert("gap", "event",
        `The watchdog did not run from ${localTime(new Date(state.lastRunAt))} to ${localTime(now)} (${duration(gapMs)}). ` +
        "This machine was most likely without power, off, or restarting. Anything that was mid-run then needs a person to check the portal before re-staging.");
    }
  }
  state.lastRunAt = nowIso;

  /** Apply one observation to a state check. `reading` null = unknown: leave the state alone. */
  const apply = (key: string, reading: { bad: boolean; problem: string; recovered: string } | null, threshold = 1): void => {
    const c: CheckState = state.checks[key] ?? { bad: false, failCount: 0, since: null, lastAlertAt: null };
    state.checks[key] = c;
    if (!reading) return;
    if (reading.bad) {
      c.failCount += 1;
      if (!c.since) c.since = nowIso;
      if (!c.bad && c.failCount >= threshold) {
        c.bad = true;
        c.lastAlertAt = nowIso;
        alert(key, "problem", reading.problem);
      } else if (c.bad && config.repeatHours > 0 && c.lastAlertAt && now.getTime() - Date.parse(c.lastAlertAt) >= config.repeatHours * 3600_000) {
        c.lastAlertAt = nowIso;
        alert(key, "reminder", `${reading.problem} (since ${localTime(new Date(c.since))}, ${duration(now.getTime() - Date.parse(c.since))})`);
      }
    } else {
      if (c.bad) {
        const since = c.since ? Date.parse(c.since) : now.getTime();
        alert(key, "recovered", `${reading.recovered} (was down/failing for ${duration(now.getTime() - since)}, since ${localTime(new Date(since))})`);
      }
      c.bad = false;
      c.failCount = 0;
      c.since = null;
      c.lastAlertAt = null;
    }
  };

  // --- server + queue + job failures ------------------------------------------------------------
  const obs: Observation = {
    server: "down", serverDetail: "", jobs: null,
    backupNewest: null, backupAgeHours: null, offboxNewest: null, offboxAgeHours: null,
  };
  let health: Record<string, unknown> | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
    try {
      const res = await deps.fetch(config.healthUrl, { signal: ctrl.signal });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.status === 200 && body && body.ok === true) {
        health = body;
        obs.server = "up";
      } else {
        // Fixed wording from typed fields only — never the server's own error text.
        obs.serverDetail = `answered HTTP ${res.status}${body && body.db === "error" ? " with its database unreachable" : ""}`;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string }; code?: string };
    const code = e?.cause?.code || e?.code || (e?.name === "AbortError" ? "TIMEOUT" : "NO_RESPONSE");
    obs.serverDetail = code === "TIMEOUT" ? `did not answer within ${Math.round(config.timeoutMs / 1000)} s` : `is not answering (${/^[A-Z_]+$/.test(code) ? code : "NO_RESPONSE"})`;
  }
  apply("server", {
    bad: obs.server === "down",
    problem: `The server ${obs.serverDetail || "is not answering"} at ${config.healthUrl}. Nobody can use the dashboard and no job is running. If the autostart task is installed it restarts the server; otherwise start it by hand.`,
    recovered: `The server is answering again at ${config.healthUrl}`,
  }, Math.max(1, config.downAfter));

  if (health) {
    const jobs = (health.jobs ?? {}) as Record<string, unknown>;
    obs.jobs = { pending: num(jobs.pending), running: num(jobs.running), failed24h: num(jobs.failed24h) };
    apply("queue", {
      bad: typeof health.warning === "string" && health.warning.length > 0,
      problem: `Background jobs are waiting but none is running (pending ${obs.jobs.pending}, running ${obs.jobs.running}). The job worker may be stuck; a server restart clears it.`,
      recovered: `Background jobs are moving again (pending ${obs.jobs.pending}, running ${obs.jobs.running})`,
    });
    const failed = obs.jobs.failed24h;
    const jf: JobFailuresState = state.jobFailures ?? { lastAlertAt: null, pendingRise: 0, pendingSince: null };
    state.jobFailures = jf;
    if (state.lastFailed24h !== null && failed > state.lastFailed24h) {
      jf.pendingRise += failed - state.lastFailed24h;
      if (!jf.pendingSince) jf.pendingSince = nowIso;
    }
    // One message per gap, carrying every rise seen since the last one. A rise that arrives while
    // the gap is open waits; it is reported (with its count) as soon as the gap has passed — on
    // that later poll even if the count did not rise again on it.
    const gapMs = Math.max(0, config.jobFailuresMinGapHours ?? JOB_FAILURES_MIN_GAP_HOURS) * 3600_000;
    const gapOpen = jf.lastAlertAt !== null && now.getTime() - Date.parse(jf.lastAlertAt) < gapMs;
    if (jf.pendingRise > 0 && !gapOpen) {
      const sinceThisPoll = jf.pendingSince === nowIso;
      alert("job-failures", "event",
        `${jf.pendingRise} background job(s) failed permanently since ${sinceThisPoll ? "the last check" : localTime(new Date(jf.pendingSince!))} (${failed} in the last 24 h). ` +
        "Open the dashboard's review queue (\"Background job failed\") — portal runs that failed are never retried on their own.");
      jf.lastAlertAt = nowIso;
      jf.pendingRise = 0;
      jf.pendingSince = null;
    }
    state.lastFailed24h = failed;
  } else {
    apply("queue", null); // unknown while the server is down: neither alarm nor all-clear
  }

  // --- backups ------------------------------------------------------------------------------------
  if (config.backupDir) {
    const newest = newestSnapshot(config.backupDir);
    const status = readStatus(path.join(config.backupDir, BACKUP_STATUS_NAME));
    obs.backupNewest = newest?.name ?? null;
    obs.backupAgeHours = newest ? (now.getTime() - newest.mtimeMs) / 3600_000 : null;
    const failedAfterNewest = Boolean(status && !status.ok && (!newest || status.atMs > newest.mtimeMs));
    const tooOld = obs.backupAgeHours === null || obs.backupAgeHours > config.backupMaxAgeHours;
    apply("backup", {
      bad: tooOld || failedAfterNewest,
      problem: failedAfterNewest
        ? `The last database snapshot attempt FAILED (${localTime(new Date(status!.atMs))}). The newest good snapshot is ${newest ? `${duration(now.getTime() - newest.mtimeMs)} old` : "missing"}. See backend.log ("[backup]").`
        : newest
          ? `The newest database snapshot is ${duration(now.getTime() - newest.mtimeMs)} old (allowed: ${config.backupMaxAgeHours} h). Backups have stopped — check the backup drive and backend.log.`
          : `No database snapshot exists in the backup folder (${config.backupDir}). Nothing is being backed up.`,
      recovered: `Database snapshots are current again (newest ${newest ? duration(now.getTime() - newest.mtimeMs) : "?"} old)`,
    });
  }
  if (config.offboxDir) {
    const newest = newestSnapshot(config.offboxDir);
    const status = config.backupDir ? readStatus(path.join(config.backupDir, OFFBOX_STATUS_NAME)) : null;
    obs.offboxNewest = newest?.name ?? null;
    obs.offboxAgeHours = newest ? (now.getTime() - newest.mtimeMs) / 3600_000 : null;
    const lastSyncFailed = Boolean(status && !status.ok);
    const tooOld = obs.offboxAgeHours === null || obs.offboxAgeHours > config.offboxMaxAgeHours;
    apply("offbox", {
      bad: tooOld || lastSyncFailed,
      problem: lastSyncFailed
        ? `The last off-box backup sync reported a problem (${localTime(new Date(status!.atMs))}). Run scripts/ops/offbox-sync.ts by hand to see it.`
        : newest
          ? `The newest OFF-BOX snapshot is ${duration(now.getTime() - newest.mtimeMs)} old (allowed: ${config.offboxMaxAgeHours} h). If this machine dies now, that is how much work is lost.`
          : "There is no snapshot in the off-box backup folder. Every backup is still on this one machine.",
      recovered: `Off-box backups are current again (newest ${newest ? duration(now.getTime() - newest.mtimeMs) : "?"} old)`,
    });
  }

  if (opts.fresh) {
    alerts.unshift({
      key: "armed", kind: "armed", at: nowIso,
      summary: `Watchdog armed. Server ${obs.server === "up" ? "up" : `DOWN (${obs.serverDetail})`}` +
        (obs.jobs ? `; ${obs.jobs.failed24h} job failure(s) in the last 24 h, ${obs.jobs.pending} pending` : "") +
        (config.backupDir ? `; newest snapshot ${obs.backupAgeHours === null ? "NONE" : `${obs.backupAgeHours.toFixed(1)} h old`}` : "") +
        (config.offboxDir ? `; newest off-box ${obs.offboxAgeHours === null ? "NONE" : `${obs.offboxAgeHours.toFixed(1)} h old`}` : "; no off-box folder configured") +
        ". You will hear from it again only when something breaks or recovers.",
    });
  }

  return { state, alerts: [...prev.undelivered.map((a) => ({ ...a, delayed: true })), ...alerts], observation: obs };
}

/** One message for everything this run found. */
export function composeMessage(name: string, alerts: Alert[]): { subject: string; text: string } {
  const problems = alerts.filter((a) => a.kind === "problem" || a.kind === "reminder" || a.kind === "event").length;
  const recovered = alerts.filter((a) => a.kind === "recovered").length;
  const head = alerts.length === 1
    ? `${labelFor(alerts[0].kind)}: ${alerts[0].key}`
    : [problems ? `${problems} problem(s)` : "", recovered ? `${recovered} recovered` : "", alerts.some((a) => a.kind === "armed") ? "armed" : ""].filter(Boolean).join(", ");
  const subject = `[${name}] ${head}`;
  const text = [
    ...alerts.map((a) => `${labelFor(a.kind)} [${a.key}] ${a.delayed ? `(delayed from ${localTime(new Date(a.at))}) ` : ""}${a.summary}`),
    "",
    `-- ${name} watchdog. Runbook: docs/OPERATIONS.md.`,
  ].join("\n");
  return { subject, text };
}

function labelFor(kind: AlertKind): string {
  return kind === "problem" ? "PROBLEM" : kind === "reminder" ? "STILL BROKEN" : kind === "recovered" ? "RECOVERED" : kind === "armed" ? "ARMED" : "NOTICE";
}
