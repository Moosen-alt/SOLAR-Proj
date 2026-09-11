// ---------------------------------------------------------------------------
// MODEL-CALL ACCOUNTING — "replay did the heavy lifting" becomes a number.
//
// The whole promise of learn-once/replay-forever is that a learned portal stages the
// NEXT project without paid model help, and the outside review's acceptance criterion
// says it plainly: "stage a different project using the published workflow and ZERO
// model calls". Nothing measured that. Production injects an LLM gap-fill planner into
// every staged replay (repository.ts builds it and hands it to stageWithRecipe), the
// benchmark mirrors that with --gap-fill, and the scorecard could not tell a replay
// that ran on its recorded steps from one that quietly spent five planner calls
// patching them — both printed `replayed_clean`.
//
// llm.ts already instruments every Anthropic call into a module-global log with an
// epoch stamp (recordLlmCall / getRecentLlmCalls), so per-attempt accounting is a
// WINDOW over that log: snapshot Date.now() before the attempt, query at-or-after it
// when the attempt ends. This module is the pure half — summing a window into a number
// and deciding what that number does to a score — so it can be tested without a
// browser, an API key, or a database.
//
// THE RUNG LIVES HERE, NOT IN REPLAY_RUNGS. "replayed_with_model_help" is a
// benchmark-only outcome: the production KPI reads the shared ladder and must never
// meet a rung it does not know, and inserting into REPLAY_RUNGS would renumber the
// indices that the tests and every JSON scorecard on disk already pin. So the ladder
// is extended from outside — the widened type exists only on this module's return.
// ---------------------------------------------------------------------------

import type { LlmCallRecord } from "./llm";
import type { ReplayScore } from "./replayBenchmark";

/** The benchmark-only outcome: the replay finished, but paid model calls carried it. */
export const MODEL_HELP_RUNG = "replayed_with_model_help" as const;

export interface ZeroModelScore extends Omit<ReplayScore, "rung"> {
  rung: ReplayScore["rung"] | typeof MODEL_HELP_RUNG;
}

/** One attempt's model-call bill, summed from the llm call-log window. */
export interface ModelCallAccounting {
  modelCalls: number;
  modelTokens: { in: number; out: number };
  modelMs: number;
  /** One entry per call, in call order — which OPERATIONS needed paid help. */
  labels: string[];
}

/** Sum a call-log window into one attempt's bill. Pure; the window is the caller's. */
export function accountModelCalls(
  calls: ReadonlyArray<Pick<LlmCallRecord, "label" | "ms" | "inTok" | "outTok">>,
): ModelCallAccounting {
  const acct: ModelCallAccounting = { modelCalls: 0, modelTokens: { in: 0, out: 0 }, modelMs: 0, labels: [] };
  for (const c of calls) {
    acct.modelCalls += 1;
    // A failed call carries no usage — it is still a call that was made and paid for in
    // latency, so it counts toward modelCalls and modelMs with zero tokens.
    acct.modelTokens.in += Number(c.inTok ?? 0);
    acct.modelTokens.out += Number(c.outTok ?? 0);
    acct.modelMs += Number(c.ms ?? 0);
    acct.labels.push(String(c.label ?? ""));
  }
  return acct;
}

/** "portalFieldPlan x3, verifyPortalFillVision" — repeated operations fold to a count. */
export function summarizeLabels(labels: ReadonlyArray<string>): string {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts.entries()].map(([l, n]) => (n > 1 ? `${l} x${n}` : l)).join(", ");
}

/**
 * Apply --expect-zero-model to a scored attempt.
 *
 * THE FLAG MEASURES, IT DOES NOT FORBID. The operator said get it working — so a run
 * that needed model help is never hard-failed and `measured` is never touched. What
 * changes is the NAME on the outcome: a clean or verified replay that spent model calls
 * is re-labelled `replayed_with_model_help` at index 3 — the same rank as
 * `replayed_with_gaps`, because that is exactly what it is: a gap in the recipe, filled
 * for money instead of left blank. Index 3 on purpose: reliability counts clean as
 * index >= 4 and the headline counts submittable as >= 5, so a paid replay can hold
 * neither, which is the whole point of the criterion.
 *
 * Owner flips to `recipe`: the person who can act is whoever extends or re-records the
 * recipe to cover the fields the planner had to fill — the labels in the reason say
 * which operations those were.
 *
 * A run already below the clean line keeps its failure rung — the abort is the
 * headline — and the model note is appended to the reason so the bill is still visible.
 */
export function applyZeroModelExpectation(
  score: ReplayScore,
  acct: ModelCallAccounting,
  expectZeroModel: boolean,
): ZeroModelScore {
  if (!expectZeroModel || acct.modelCalls === 0) return score;
  const note = `needed ${acct.modelCalls} model call(s): ${summarizeLabels(acct.labels)}`;
  if (score.index >= 4) {
    return { ...score, rung: MODEL_HELP_RUNG, index: 3, owner: "recipe", reason: `${score.reason} — ${note}` };
  }
  return { ...score, reason: `${score.reason} — ${note}` };
}
