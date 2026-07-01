// ---------------------------------------------------------------------------
// LearnRunDebug — ONE debug bundle per auto-learn run, ON BY DEFAULT.
//
// Every learn run gets its own folder under data/learn-runs/<runId>/ holding
// everything needed to diagnose it after the fact, without re-running blind:
//
//   run.json        — manifest: portal, start/end, config snapshot, outcome,
//                     final message, error + stack when the run threw.
//   events.jsonl    — timestamped timeline (login, per-page trace, progress,
//                     recovery attempts, challenge stops, errors).
//   pNNN-plan.json  — per page: fields the bot SAW + the planner's decisions
//                     (bound field / value / source; sensitive values masked).
//   pNNN-rescanN.json — conditional fields revealed after a fill.
//   pNNN-before/after-*.png — full-page screenshots around each page's fills.
//   trace.zip       — Playwright trace (DOM snapshots + actions + network),
//                     viewable at https://trace.playwright.dev. Started AFTER
//                     login so credentials are never captured in it.
//   verdict.json / llm-calls.json / result.json / review.png — written by the
//                     backend after verification (trust-gate signals, LLM call
//                     log, final outcome, review screenshot).
//
// The whole bundle is what the operator hands over for troubleshooting — the
// backend serves it zipped at GET /api/learn-runs/<runId>/bundle.zip.
//
// PII note: JSON artifacts mask sensitive values, but the PNGs and the
// Playwright trace are RAW renders of the portal and can show customer data
// (the same class of data as the review screenshot the dashboard already
// stores). The bundle stays on local disk under data/ (gitignored) and is
// pruned to the most recent AUTOLEARN_RUN_KEEP runs.
//
// Flags (all default ON so a failed run is never un-diagnosable):
//   AUTOLEARN_RUN_DEBUG=0        — disable the bundle entirely.
//   AUTOLEARN_DEBUG_SCREENSHOTS=0 — skip the per-page PNGs (JSON still written).
//   AUTOLEARN_TRACE=0            — skip the Playwright trace.
//   AUTOLEARN_RUN_KEEP=20        — how many run folders to retain.
//   AUTOLEARN_RUN_DIR            — override the base folder (default data/learn-runs).
//
// Every method is best-effort and never throws — debug capture must never be
// able to break a live learn run.
// ---------------------------------------------------------------------------
import fs from "fs";
import path from "path";
import type { Page } from "playwright";

const flagOff = (name: string): boolean => {
  const v = process.env[name];
  return v === "0" || v === "false";
};

function baseDir(): string {
  return process.env.AUTOLEARN_RUN_DIR
    ? path.resolve(process.env.AUTOLEARN_RUN_DIR)
    : path.resolve(process.cwd(), "data", "learn-runs");
}

// Timestamped, filesystem-safe run id: sorts chronologically so retention
// pruning can just sort by name. A short random suffix avoids collisions when
// two learns start within the same second.
function makeRunId(portalName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const slug = (portalName || "portal").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "portal";
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}_${slug}_${rand}`;
}

export class LearnRunDebug {
  readonly dir: string;
  readonly runId: string;
  private readonly startedAtMs = Date.now();
  private tracing = false;
  private finalized = false;

  private constructor(dir: string, runId: string) {
    this.dir = dir;
    this.runId = runId;
  }

  /** Create the run folder (pruning old runs), write the initial manifest, and
   *  return the recorder — or null when disabled (AUTOLEARN_RUN_DEBUG=0) or the
   *  folder can't be created. */
  static start(portalName: string, meta?: Record<string, unknown>): LearnRunDebug | null {
    if (flagOff("AUTOLEARN_RUN_DEBUG")) return null;
    try {
      const runId = makeRunId(portalName);
      const dir = path.join(baseDir(), runId);
      fs.mkdirSync(dir, { recursive: true });
      const dbg = new LearnRunDebug(dir, runId);
      dbg.pruneOldRuns();
      dbg.writeJson("run.json", {
        runId,
        portalName,
        startedAt: new Date().toISOString(),
        finished: false,
        ...meta,
        config: snapshotConfig(),
      });
      return dbg;
    } catch {
      return null;
    }
  }

  /** Append a timestamped event to events.jsonl. */
  event(evt: Record<string, unknown>): void {
    try {
      const line = JSON.stringify({ t: new Date().toISOString(), ms: Date.now() - this.startedAtMs, ...evt });
      fs.appendFileSync(path.join(this.dir, "events.jsonl"), line + "\n");
    } catch { /* never throws */ }
  }

  /** Write a JSON artifact into the run folder. */
  writeJson(name: string, obj: unknown): void {
    try {
      fs.writeFileSync(path.join(this.dir, name), JSON.stringify(obj, null, 2));
    } catch { /* never throws */ }
  }

  /** Write a binary artifact (e.g. the review PNG) into the run folder. */
  writeFile(name: string, buf: Buffer): void {
    try {
      fs.writeFileSync(path.join(this.dir, name), buf);
    } catch { /* never throws */ }
  }

  /** Full-page PNG of the current page, unless AUTOLEARN_DEBUG_SCREENSHOTS=0.
   *  Tolerates test fakes with no screenshot() and any capture error. */
  async screenshot(page: unknown, label: string): Promise<void> {
    if (flagOff("AUTOLEARN_DEBUG_SCREENSHOTS")) return;
    const p = page as Page | null;
    if (!p || typeof p.screenshot !== "function") return;
    const safe = label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80);
    try {
      const buf = await p.screenshot({ type: "png", fullPage: true });
      fs.writeFileSync(path.join(this.dir, `${safe}.png`), buf);
    } catch { /* never throws */ }
  }

  /** Start a Playwright trace (DOM snapshots + actions + network timing) on the
   *  page's context. Called AFTER login so credentials never enter the trace.
   *  Skipped for test fakes and when AUTOLEARN_TRACE=0. */
  async startTrace(page: unknown): Promise<void> {
    if (flagOff("AUTOLEARN_TRACE") || this.tracing) return;
    const p = page as Page | null;
    if (!p || typeof p.context !== "function") return;
    try {
      await p.context().tracing.start({ screenshots: true, snapshots: true });
      this.tracing = true;
      this.event({ type: "trace_started" });
    } catch { /* never throws */ }
  }

  /** Stop the trace and save trace.zip (viewable at trace.playwright.dev). */
  async stopTrace(page: unknown): Promise<void> {
    if (!this.tracing) return;
    this.tracing = false;
    const p = page as Page | null;
    if (!p || typeof p.context !== "function") return;
    try {
      await p.context().tracing.stop({ path: path.join(this.dir, "trace.zip") });
      this.event({ type: "trace_saved" });
    } catch { /* never throws */ }
  }

  /** Finalize run.json with the outcome. Idempotent — the first call wins so a
   *  specific failure summary isn't overwritten by a generic later one. */
  finalize(summary: Record<string, unknown>): void {
    if (this.finalized) return;
    this.finalized = true;
    try {
      const p = path.join(this.dir, "run.json");
      const existing = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(p, JSON.stringify({
        ...existing,
        finished: true,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - this.startedAtMs,
        ...summary,
      }, null, 2));
    } catch { /* never throws */ }
  }

  /** Keep only the newest AUTOLEARN_RUN_KEEP (default 20) run folders. Name
   *  order == chronological order because runIds start with the timestamp. */
  private pruneOldRuns(): void {
    try {
      const keep = Math.max(1, Number(process.env.AUTOLEARN_RUN_KEEP) || 20);
      const base = baseDir();
      const dirs = fs.readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
        fs.rmSync(path.join(base, name), { recursive: true, force: true });
      }
    } catch { /* never throws */ }
  }
}

// The env knobs that change learner behaviour — snapshotted into every run
// manifest so a pasted bundle answers "what settings was this run using?"
// without a follow-up question. Values only, never secrets.
function snapshotConfig(): Record<string, unknown> {
  const keys = [
    "PORTAL_HEADLESS",
    "PORTAL_VISION_PLAN",
    "PORTAL_VISION_VERIFY",
    "PORTAL_SAVE_REVIEW_SCREENSHOT",
    "PORTAL_REPLAY_SELFTEST",
    "PORTAL_AUTOSEED",
    "PORTAL_SECTION_READY_MS",
    "AUTOLEARN_DEBUG",
    "AUTOLEARN_DEBUG_SCREENSHOTS",
    "AUTOLEARN_TRACE",
    "AUTOLEARN_NAV_DWELL_MS",
    "AUTOLEARN_SAVE_SETTLE_MS",
    "MAX_CONCURRENT_PORTAL_RUNS",
    "LOG_LEVEL",
  ];
  const cfg: Record<string, unknown> = {
    node: process.version,
    platform: process.platform,
    llmConfigured: Boolean(process.env.ANTHROPIC_API_KEY), // presence only, never the key
    proxyConfigured: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
  };
  for (const k of keys) if (process.env[k] !== undefined) cfg[k] = process.env[k];
  return cfg;
}
