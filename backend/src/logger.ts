// ---------------------------------------------------------------------------
// Structured, copy-pasteable terminal logging + runtime diagnostics.
//
// Goals:
//  - Every line is greppable and self-describing: `[time] LEVEL [scope] message`.
//  - Errors print a clear block you can paste straight into a chat for diagnosis.
//  - A /api/diagnostics endpoint returns the same picture as JSON.
//  - NEVER log secrets or PII: no request bodies, no tokens/cookies/passwords,
//    no account/meter numbers. Query strings are redacted on sensitive keys.
// ---------------------------------------------------------------------------
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import type { AppDb } from "./db";
import type { BuildInfo } from "./buildInfo";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const CONFIGURED_LEVEL: Level = (() => {
  const raw = (process.env.LOG_LEVEL || "").toLowerCase();
  if (raw in LEVELS) return raw as Level;
  if (process.env.DEBUG === "true" || process.env.DEBUG === "1") return "debug";
  return "info";
})();

const threshold = LEVELS[CONFIGURED_LEVEL];

const ICON: Record<Level, string> = { error: "✖", warn: "▲", info: "•", debug: "·" };

function stamp(): string {
  // Local time, second precision — easy to correlate with what the user did.
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function fmtExtra(extra?: Record<string, unknown>): string {
  if (!extra) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    const val = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${val}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function emit(level: Level, scope: string, message: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] > threshold) return;
  const line = `${stamp()} ${ICON[level]} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${fmtExtra(extra)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  appendToLogFile(line);
}

// --- File sink ---------------------------------------------------------------
// The backend logs to stdout, visible only to whoever is watching that terminal.
// Mirroring the SAME lines to a file lets a second pair of eyes tail them live, and
// lets a crash be read afterwards when the terminal is gone. Nothing extra is written:
// same lines, same redaction guarantees as the console output above.
//
// THE LOG BELONGS TO THE DATABASE IT DESCRIBES. A test run from the repo root points
// AUTOPILOT_DB_PATH at a temp file but keeps the repo as its cwd, so 165 of 192 backend tests
// appended to the LIVE server's data/logs/backend.log — "Stale-classification pass failed ...
// injected: the drift pass exploded", "the AHJ process reference could not be read", a gate
// blocking project "p-gate" — interleaved with production's own lines while a real permit problem
// was being diagnosed from that file. A process whose database lives OUTSIDE this directory is not
// this installation's server, so by default it logs beside its own database instead. Production,
// the demo kit and the comparison checkouts all use a relative path inside their own folder and
// are unaffected.
function defaultLogFile(): string {
  const cwd = process.cwd();
  const dbPath = path.resolve(cwd, process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite");
  const rel = path.relative(cwd, dbPath);
  const dbOutsideInstall = rel.startsWith("..") || path.isAbsolute(rel);
  return dbOutsideInstall
    ? path.join(path.dirname(dbPath), "logs", "backend.log")
    : path.join(cwd, "data", "logs", "backend.log");
}
const LOG_FILE = process.env.AUTOPILOT_LOG_FILE === ""
  ? "" // explicitly disabled
  : (process.env.AUTOPILOT_LOG_FILE || defaultLogFile());
const LOG_MAX_BYTES = Number(process.env.AUTOPILOT_LOG_MAX_BYTES || 8 * 1024 * 1024);
let logDirReady = false;
let logWriteFailed = false;

function appendToLogFile(line: string): void {
  if (!LOG_FILE || logWriteFailed) return;
  try {
    if (!logDirReady) {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      logDirReady = true;
    }
    // Rotate ONE generation: bounds disk and keeps a live tail cheap, without pulling in
    // a rotation dependency for what is a diagnostic convenience.
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch { /* no file yet */ }
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // Never let logging break the server, and never retry-storm on a bad path.
    logWriteFailed = true;
  }
}

export const logger = {
  error: (scope: string, message: string, extra?: Record<string, unknown>) => emit("error", scope, message, extra),
  warn: (scope: string, message: string, extra?: Record<string, unknown>) => emit("warn", scope, message, extra),
  info: (scope: string, message: string, extra?: Record<string, unknown>) => emit("info", scope, message, extra),
  debug: (scope: string, message: string, extra?: Record<string, unknown>) => emit("debug", scope, message, extra),
  level: CONFIGURED_LEVEL,
};

// --- Sensitive-data hygiene --------------------------------------------------
const SENSITIVE_QUERY = /token|key|secret|password|cookie|auth|account|meter|mfa|otp/i;

function safePath(req: Request): string {
  const base = req.path || req.url.split("?")[0];
  const q = req.query && Object.keys(req.query).length
    ? "?" + Object.keys(req.query).map((k) => `${k}=${SENSITIVE_QUERY.test(k) ? "[redacted]" : String(req.query[k]).slice(0, 40)}`).join("&")
    : "";
  return base + q;
}

// --- HTTP request logger -----------------------------------------------------
// Logs one line per request on completion. 2xx/3xx -> info, 4xx -> warn, 5xx -> error.
// Health/diagnostics polling is logged at debug so it doesn't drown the terminal.
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = performance.now();
  res.on("finish", () => {
    const ms = Math.round(performance.now() - start);
    const status = res.statusCode;
    const quiet = req.path === "/health" || req.path === "/api/diagnostics";
    const level: Level = status >= 500 ? "error" : status >= 400 ? "warn" : quiet ? "debug" : "info";
    emit(level, "http", `${status} ${req.method} ${safePath(req)}`, { ms: `${ms}ms` });
  });
  next();
}

// --- Error block -------------------------------------------------------------
// Prints a boxed, copy-pasteable error report. Call from the global error handler.
export function logErrorBlock(scope: string, err: unknown, context?: Record<string, unknown>): void {
  const e = err as { message?: string; stack?: string; status?: number };
  const lines = [
    "┌─ ERROR ───────────────────────────────────────────────",
    `│ scope:   ${scope}`,
    `│ message: ${e?.message ?? String(err)}`,
  ];
  if (context) for (const [k, v] of Object.entries(context)) lines.push(`│ ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  if (e?.stack) {
    lines.push("│ stack:");
    for (const s of e.stack.split("\n").slice(0, 6)) lines.push(`│   ${s.trim()}`);
  }
  lines.push("└───────────────────────────────────────────────────────");
  console.error(lines.join("\n"));
}

// --- Diagnostics snapshot ----------------------------------------------------
function safeCount(db: AppDb, sql: string): number | null {
  try {
    const row = db.get<{ n: number }>(sql);
    return row ? Number(row.n) : 0;
  } catch {
    return null;
  }
}

export interface Diagnostics {
  service: string;
  /** The date version ("2026.09.24") of the running code, or "unknown" — see buildInfo.ts. */
  version: string;
  /** Full identity of the running code (admin-only endpoint, so codeRoot is included). */
  build: BuildInfo;
  status: "ok" | "degraded";
  timestamp: string;
  uptimeSeconds: number;
  node: string;
  logLevel: Level;
  config: {
    port: number;
    authEnabled: boolean;
    llm: "claude" | "stub";
    gmailConfigured: boolean;
    sessionKeySet: boolean;
    dbPath: string;
    dbSizeKb: number | null;
  };
  data: {
    projects: number | null;
    knowledgeProfiles: number | null;
    jobsPending: number | null;
    jobsFailed: number | null;
    historicalFailureExamples: number | null;
  };
  warnings: string[];
}

export function collectDiagnostics(db: AppDb, opts: { build: BuildInfo; port: number; dbPath: string }): Diagnostics {
  const dbSizeKb = (() => {
    try { return Math.round(fs.statSync(opts.dbPath).size / 1024); } catch { return null; }
  })();
  const llm: "claude" | "stub" = process.env.ANTHROPIC_API_KEY ? "claude" : "stub";
  const authEnabled = process.env.AUTH_ENABLED === "true";
  const gmailConfigured = Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
  const sessionKeySet = Boolean(process.env.SESSION_ENCRYPTION_KEY && process.env.SESSION_ENCRYPTION_KEY !== "replace-with-a-long-random-secret");

  const data = {
    projects: safeCount(db, "SELECT COUNT(*) n FROM projects"),
    knowledgeProfiles: safeCount(db, "SELECT COUNT(*) n FROM permit_utility_knowledge"),
    jobsPending: safeCount(db, "SELECT COUNT(*) n FROM job_queue WHERE status IN ('pending','running')"),
    jobsFailed: safeCount(db, "SELECT COUNT(*) n FROM job_queue WHERE status = 'failed'"),
    historicalFailureExamples: safeCount(db, "SELECT COUNT(*) n FROM historical_failure_examples"),
  };

  const warnings: string[] = [];
  if (llm === "stub") warnings.push("ANTHROPIC_API_KEY not set — LLM features run in advisory/stub mode.");
  if (!sessionKeySet) warnings.push("SESSION_ENCRYPTION_KEY is unset or default — set a real secret before deploying.");
  if (!authEnabled) warnings.push("AUTH_ENABLED=false — the dashboard is open with no login.");
  if ((data.jobsFailed ?? 0) > 0) warnings.push(`${data.jobsFailed} background job(s) are in 'failed' state.`);

  return {
    service: "Solar Submission Autopilot",
    version: opts.build.version ?? "unknown",
    build: opts.build,
    status: warnings.some((w) => w.includes("SESSION_ENCRYPTION_KEY")) ? "degraded" : "ok",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    logLevel: CONFIGURED_LEVEL,
    config: { port: opts.port, authEnabled, llm, gmailConfigured, sessionKeySet, dbPath: opts.dbPath, dbSizeKb },
    data,
    warnings,
  };
}

// --- Startup banner ----------------------------------------------------------
// One clear block at boot so a pasted terminal tells the whole story at a glance.
export function startupBanner(d: Diagnostics, urls: { base: string }): void {
  const L = (s: string) => console.log(s);
  L("");
  L("════════════════════════════════════════════════════════════");
  L(`  ${d.service}  ${d.build.label}`);
  L("════════════════════════════════════════════════════════════");
  L(`  URL          ${urls.base}`);
  L(`  Dashboard    ${urls.base}/   ·   Parser  ${urls.base}/parser`);
  L(`  Node         ${d.node}        Log level  ${d.logLevel}`);
  L(`  LLM          ${d.config.llm === "claude" ? "Claude (live)" : "stub (no API key)"}`);
  L(`  Auth         ${d.config.authEnabled ? "ENABLED (login required)" : "disabled (open dashboard)"}`);
  L(`  Database     ${d.config.dbPath} (${d.config.dbSizeKb ?? "?"} KB)`);
  L(`  Data         ${d.data.projects ?? "?"} projects · ${d.data.knowledgeProfiles ?? "?"} KB profiles · ${d.data.jobsPending ?? "?"} jobs queued`);
  if (d.warnings.length) {
    L("  ─ Warnings ────────────────────────────────────────────────");
    for (const w of d.warnings) L(`  ▲ ${w}`);
  }
  L("════════════════════════════════════════════════════════════");
  L("");
}
