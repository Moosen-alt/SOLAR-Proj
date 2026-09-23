// PERSISTENT MODEL-CALL ACCOUNTING (LLM-6).
//
// llm.ts keeps an in-memory ring buffer of every model call for learn bundles and replay
// accounting. It dies with the process, so "what did this project cost", "which job type
// spends the money" and "is the prompt cache hitting" could not be answered from the product.
// recordLlmCall — the ONE function every call site already goes through — now also writes
// each record here, best-effort.
//
// ATTRIBUTION rides AsyncLocalStorage, set at the two edges that know who the work is for:
// the job worker (the claimed row's project, job and org) and project-scoped routes. Work
// with neither — the scheduler, a script — records NULLs, which matches "enforcement at the
// route edge": background work runs as system.
//
// No imports beyond node and a type: db.ts attaches the store statically, so this module
// must not pull anything that could close an import cycle.
import { AsyncLocalStorage } from "node:async_hooks";
import type { AppDb } from "./db";

export interface LlmCallContext {
  projectId?: string | null;
  jobId?: string | null;
  orgId?: string | null;
}

const context = new AsyncLocalStorage<LlmCallContext>();

/** Run `fn` with model calls attributed to `ctx`. Continuations (awaits, timers scheduled
 *  inside) inherit it; an inner call overrides an outer one. */
export function runWithLlmContext<T>(ctx: LlmCallContext, fn: () => T): T {
  return context.run(ctx, fn);
}

export function currentLlmContext(): LlmCallContext | undefined {
  return context.getStore();
}

let store: AppDb | null = null;

/** The database model calls are written to. openDatabase() attaches the handle it opens, so
 *  every process that opens a database — server, scripts, tests — keeps its own ledger. */
export function attachLlmCallStore(db: AppDb | null): void {
  store = db;
}

export interface PersistedLlmCall {
  at: number;
  label: string;
  model: string;
  ms: number;
  inTok?: number;
  outTok?: number;
  cacheRead?: number;
  cacheWrite?: number;
  stop?: string | null;
  error?: string;
}

const intOrNull = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);

/** Best-effort, never throws: accounting must not cost a model call (the same stance as
 *  countPlannerPrompt). A closed handle, a pre-migration schema or a locked file all land here. */
export function persistLlmCall(rec: PersistedLlmCall): void {
  if (!store) return;
  try {
    const ctx = context.getStore();
    store.run(
      `INSERT INTO llm_calls (at, label, model, in_tok, out_tok, cache_read, cache_write, ms, stop, error, project_id, job_id, org_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date(Number.isFinite(rec.at) ? rec.at : Date.now()).toISOString(),
        String(rec.label || "").slice(0, 200),
        String(rec.model || "").slice(0, 80),
        intOrNull(rec.inTok), intOrNull(rec.outTok), intOrNull(rec.cacheRead), intOrNull(rec.cacheWrite),
        intOrNull(rec.ms) ?? 0,
        rec.stop == null ? null : String(rec.stop).slice(0, 40),
        rec.error == null ? null : String(rec.error).slice(0, 500),
        ctx?.projectId || null, ctx?.jobId || null, ctx?.orgId || null,
      ],
    );
  } catch { /* accounting is best-effort — never break the caller */ }
}

// ---------------------------------------------------------------------------
// Estimated cost
// ---------------------------------------------------------------------------

/** USD per million tokens, LIST price, first-party API. ESTIMATES: cache reads and 5-minute
 *  cache writes use the standard 0.1× / 1.25× input multipliers, and server-side web-search
 *  fees are not counted. A model not listed here prices as UNKNOWN (null), never as $0 —
 *  an unknown must not read as reassurance. Keyed by exact model id: a new model has to be
 *  added here on purpose, or its spend reads as unpriced. */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** count_tokens is free: it is recorded (it proves the planner budget was measured) but costs nothing. */
const FREE_LABEL = /\.countTokens$/;

export function estimateLlmCallCostUsd(row: { label: string; model: string; in_tok: number | null; out_tok: number | null; cache_read: number | null; cache_write: number | null }): number | null {
  if (FREE_LABEL.test(row.label)) return 0;
  const price = PRICE_PER_MTOK[row.model];
  if (!price) return null;
  const tok = (n: number | null) => (n ?? 0) / 1_000_000;
  return tok(row.in_tok) * price.input
    + tok(row.out_tok) * price.output
    + tok(row.cache_read) * price.input * CACHE_READ_MULTIPLIER
    + tok(row.cache_write) * price.input * CACHE_WRITE_MULTIPLIER;
}

export interface LlmUsageLine {
  /** The operation, with per-turn suffixes ("#3", "#failed") folded together. */
  label: string;
  model: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** null when any call in the line is unpriced (unknown model). */
  estimatedCostUsd: number | null;
}

export interface ProjectLlmUsage {
  projectId: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Share of prompt tokens served from cache: cacheRead / (input + cacheRead + cacheWrite). */
  cacheHitRate: number | null;
  estimatedCostUsd: number | null;
  unpricedCalls: number;
  byLabel: LlmUsageLine[];
  firstCallAt: string | null;
  lastCallAt: string | null;
  note: string;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Per-label calls, tokens and ESTIMATED cost for ONE project. Scoping is the caller's: the
 *  route sits under /api/projects/:id and inherits that path's tenant scope guard. */
export function llmUsageForProject(db: AppDb, projectId: string): ProjectLlmUsage {
  const rows = db.query<{ at: string; label: string; model: string; in_tok: number | null; out_tok: number | null; cache_read: number | null; cache_write: number | null; error: string | null }>(
    "SELECT at, label, model, in_tok, out_tok, cache_read, cache_write, error FROM llm_calls WHERE project_id = ? ORDER BY at",
    [projectId],
  );
  const lines = new Map<string, LlmUsageLine & { unpriced: number; cost: number }>();
  for (const r of rows) {
    const label = String(r.label || "").replace(/#[^#]*$/, "");
    const key = `${label}\u0000${r.model}`;
    const line = lines.get(key) ?? { label, model: r.model, calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: null, unpriced: 0, cost: 0 };
    line.calls++;
    if (r.error) line.errors++;
    line.inputTokens += r.in_tok ?? 0;
    line.outputTokens += r.out_tok ?? 0;
    line.cacheReadTokens += r.cache_read ?? 0;
    line.cacheWriteTokens += r.cache_write ?? 0;
    const cost = estimateLlmCallCostUsd(r);
    if (cost == null) line.unpriced++; else line.cost += cost;
    lines.set(key, line);
  }
  const byLabel: LlmUsageLine[] = [...lines.values()].map(({ unpriced, cost, ...line }) => ({
    ...line, estimatedCostUsd: unpriced ? null : round4(cost),
  })).sort((a, b) => (b.estimatedCostUsd ?? Infinity) - (a.estimatedCostUsd ?? Infinity));
  const sum = (f: (l: LlmUsageLine) => number) => byLabel.reduce((s, l) => s + f(l), 0);
  const unpricedCalls = [...lines.values()].reduce((s, l) => s + l.unpriced, 0);
  const inputTokens = sum((l) => l.inputTokens), cacheReadTokens = sum((l) => l.cacheReadTokens), cacheWriteTokens = sum((l) => l.cacheWriteTokens);
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    projectId,
    calls: rows.length,
    errors: sum((l) => l.errors),
    inputTokens,
    outputTokens: sum((l) => l.outputTokens),
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitRate: promptTokens ? round4(cacheReadTokens / promptTokens) : null,
    estimatedCostUsd: unpricedCalls ? null : round4([...lines.values()].reduce((s, l) => s + l.cost, 0)),
    unpricedCalls,
    byLabel,
    firstCallAt: rows[0]?.at ?? null,
    lastCallAt: rows[rows.length - 1]?.at ?? null,
    note: "Estimated at list price; web-search fees not included. Calls made before accounting existed, and background calls with no project, are not attributed here.",
  };
}
