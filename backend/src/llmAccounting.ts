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
  /** Server-side web searches (migration v38). undefined/NULL = the response reported none — unknown, not zero. */
  webSearches?: number;
}

const intOrNull = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);

/** Best-effort, never throws: accounting must not cost a model call (the same stance as
 *  countPlannerPrompt). A closed handle, a pre-migration schema or a locked file all land here. */
export function persistLlmCall(rec: PersistedLlmCall): void {
  if (!store) return;
  try {
    const ctx = context.getStore();
    store.run(
      `INSERT INTO llm_calls (at, label, model, in_tok, out_tok, cache_read, cache_write, ms, stop, error, project_id, job_id, org_id, web_searches)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date(Number.isFinite(rec.at) ? rec.at : Date.now()).toISOString(),
        String(rec.label || "").slice(0, 200),
        String(rec.model || "").slice(0, 80),
        intOrNull(rec.inTok), intOrNull(rec.outTok), intOrNull(rec.cacheRead), intOrNull(rec.cacheWrite),
        intOrNull(rec.ms) ?? 0,
        rec.stop == null ? null : String(rec.stop).slice(0, 40),
        rec.error == null ? null : String(rec.error).slice(0, 500),
        ctx?.projectId || null, ctx?.jobId || null, ctx?.orgId || null,
        intOrNull(rec.webSearches),
      ],
    );
  } catch { /* accounting is best-effort — never break the caller */ }
}

// ---------------------------------------------------------------------------
// Estimated cost
// ---------------------------------------------------------------------------

/** USD per million tokens, LIST price, first-party API (claude-api skill models.md /
 *  model-migration.md, 2026-09-26). ESTIMATES: 5-minute cache writes use the standard 1.25× input
 *  multiplier, and server-side web-search fees are not counted. Cache READS are priced PER MODEL:
 *  the discount is no longer one multiplier — Opus 5.5 reads at 0.05× ($0.20) and Fable 5.1 at
 *  0.025× ($0.25), against 0.1× for the rest. A model not listed here prices as UNKNOWN (null),
 *  never as $0 — an unknown must not read as reassurance. Keyed by EXACT model id (a dated
 *  snapshot suffix is stripped first): "claude-opus-5-5" must never price as "claude-opus-5" —
 *  the measurement runner's prefix match did exactly that and under-reported Opus 5.5 by 25%.
 *  Every model modelRouting can route to must be priced here (modelRouting.test holds them together). */
export const PRICE_PER_MTOK: Readonly<Record<string, { input: number; output: number; cacheRead: number }>> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Server-side web search: $10 per 1,000 searches (claude-api pricing, 2026-09-26), on top of the
 *  tokens the results add. Web FETCH carries no per-use fee. Counted from llm_calls.web_searches
 *  (migration v38): a NULL there means the call reported nothing — unknown, not free — and calls
 *  made before the column existed are not backfilled. */
export const WEB_SEARCH_USD_PER_1000 = 10;

/** count_tokens is free: it is recorded (it proves the planner budget was measured) but costs nothing. */
const FREE_LABEL = /\.countTokens$/;

/** "claude-haiku-4-5-20251001" -> "claude-haiku-4-5". Exact match otherwise — never a prefix. */
export function priceKeyForModel(model: string): string {
  return String(model || "").trim().replace(/-\d{8}$/, "");
}

export function estimateLlmCallCostUsd(row: { label: string; model: string; in_tok: number | null; out_tok: number | null; cache_read: number | null; cache_write: number | null; web_searches?: number | null }): number | null {
  if (FREE_LABEL.test(row.label)) return 0;
  const price = PRICE_PER_MTOK[priceKeyForModel(row.model)];
  if (!price) return null;
  const tok = (n: number | null) => (n ?? 0) / 1_000_000;
  return tok(row.in_tok) * price.input
    + tok(row.out_tok) * price.output
    + tok(row.cache_read) * price.cacheRead
    + tok(row.cache_write) * price.input * CACHE_WRITE_MULTIPLIER
    + ((row.web_searches ?? 0) / 1000) * WEB_SEARCH_USD_PER_1000;
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
  /** Server-side web searches the line's calls reported (NULL rows count 0 here; see webSearchesUnknown). */
  webSearches: number;
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
  /** Web searches reported across every call, billed at $10 per 1,000 inside estimatedCostUsd. */
  webSearches: number;
  /** Calls that reported no search count (recorded before migration v38, or a response without
   *  usage.server_tool_use): their search fees are NOT in the estimate — unknown, not zero. */
  webSearchesUnknown: number;
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
  const rows = db.query<{ at: string; label: string; model: string; in_tok: number | null; out_tok: number | null; cache_read: number | null; cache_write: number | null; web_searches: number | null; error: string | null }>(
    "SELECT at, label, model, in_tok, out_tok, cache_read, cache_write, web_searches, error FROM llm_calls WHERE project_id = ? ORDER BY at",
    [projectId],
  );
  const lines = new Map<string, LlmUsageLine & { unpriced: number; cost: number }>();
  let webSearchesUnknown = 0;
  for (const r of rows) {
    const label = String(r.label || "").replace(/#[^#]*$/, "");
    const key = `${label}\u0000${r.model}`;
    const line = lines.get(key) ?? { label, model: r.model, calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, estimatedCostUsd: null, unpriced: 0, cost: 0 };
    line.calls++;
    if (r.error) line.errors++;
    line.inputTokens += r.in_tok ?? 0;
    line.outputTokens += r.out_tok ?? 0;
    line.cacheReadTokens += r.cache_read ?? 0;
    line.cacheWriteTokens += r.cache_write ?? 0;
    if (r.web_searches == null) webSearchesUnknown++; else line.webSearches += r.web_searches;
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
    webSearches: sum((l) => l.webSearches),
    webSearchesUnknown,
    estimatedCostUsd: unpricedCalls ? null : round4([...lines.values()].reduce((s, l) => s + l.cost, 0)),
    unpricedCalls,
    byLabel,
    firstCallAt: rows[0]?.at ?? null,
    lastCallAt: rows[rows.length - 1]?.at ?? null,
    note: `Estimated at list price, web searches at $${WEB_SEARCH_USD_PER_1000} per 1,000${webSearchesUnknown ? ` (${webSearchesUnknown} call(s) reported no search count — their search fees are not in the estimate)` : ""}. Calls made before accounting existed, and background calls with no project, are not attributed here.`,
  };
}
