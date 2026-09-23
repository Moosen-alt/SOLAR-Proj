// ---------------------------------------------------------------------------
// WHICH CLICK GATE REFUSED — observed on the engine's own code, not re-derived from a copy.
//
// RecipeAdapter.executeClick answers every refusal with a bare `false`: the fee gate
// (PAY_FEE_REPLAY_GATE), the past-review block, the submit-keyword block and the guided-manual
// final-submit refusal all look the same from outside. The Act 4 video's captions say the last
// one stopped the engine — and the first recording was in fact stopped by the FEE gate, because
// the step's note said "submit/pay-like" and `\bpay\b` matched. So the recorder must SEE which
// gate answered.
//
// How, without copying the gate order into this file: for the duration of each executeClick
// call on ONE adapter instance, it watches the two things only the relevant gates touch —
//   · the engine's exported PAY_FEE_REPLAY_GATE object (its `test` is spied on that object, so
//     the engine's own evaluation is what is recorded): a true result inside the call means the
//     fee gate refused, since it is checked first and returns immediately;
//   · reads of `options.autoSubmit`: executeClick consults it only in the isFinalSubmit branch,
//     so a refused isFinalSubmit step that consulted it, with the fee gate false and autoSubmit
//     off, was refused by the guided-manual final-submit rule.
// Anything else is reported as "other-refusal" — never guessed into one of the two.
// ---------------------------------------------------------------------------
import type { RecipeStep } from "../../shared/src/types";

export type ClickGate =
  | "clicked"
  | "fee-gate"
  | "final-submit-guided-manual"
  | "other-refusal"
  | "threw";

export interface ClickGateObservation {
  note: string;
  isFinalSubmit: boolean;
  gate: ClickGate;
  feeGateMatched: boolean;
  autoSubmitConsulted: boolean;
  error?: string;
}

export interface ClickGateProbe {
  observations: ClickGateObservation[];
  restore(): void;
}

interface AdapterInternals {
  executeClick: (step: RecipeStep, scoped: unknown, pastReview: boolean) => Promise<boolean>;
  options: { autoSubmit?: boolean } & Record<string, unknown>;
}

/** Instrument ONE adapter instance. The fee-gate spy is removed by restore(); call it in a
 *  finally so the shared regex object never keeps the spy. */
export function probeClickGates(adapter: unknown, feeGate: RegExp): ClickGateProbe {
  const a = adapter as AdapterInternals;
  const observations: ClickGateObservation[] = [];
  let active: { feeGateMatched: boolean; autoSubmitConsulted: boolean } | null = null;

  const realExecuteClick = a.executeClick;
  if (typeof realExecuteClick !== "function") throw new Error("probeClickGates: adapter has no executeClick — the engine changed; update the probe.");
  const hadOwnExecuteClick = Object.prototype.hasOwnProperty.call(a, "executeClick");
  const realOptions = a.options ?? {};

  const hadOwnTest = Object.prototype.hasOwnProperty.call(feeGate, "test");
  const priorTest = feeGate.test;
  Object.defineProperty(feeGate, "test", {
    configurable: true, writable: true,
    value: function (this: RegExp, s: string): boolean {
      const r = RegExp.prototype.test.call(this, s);
      if (active && r) active.feeGateMatched = true;
      return r;
    },
  });
  a.options = new Proxy(realOptions, {
    get(target, key, receiver) {
      if (key === "autoSubmit" && active) active.autoSubmitConsulted = true;
      return Reflect.get(target, key, receiver);
    },
  });
  a.executeClick = async function (this: unknown, step: RecipeStep, scoped: unknown, pastReview: boolean): Promise<boolean> {
    const ctx = { feeGateMatched: false, autoSubmitConsulted: false };
    active = ctx;
    const isFinalSubmit = (step as { isFinalSubmit?: unknown }).isFinalSubmit === true;
    const base = { note: String(step.note ?? ""), isFinalSubmit };
    try {
      const done = await realExecuteClick.call(this, step, scoped, pastReview);
      active = null;
      const gate: ClickGate = done ? "clicked"
        : ctx.feeGateMatched ? "fee-gate"
          : isFinalSubmit && ctx.autoSubmitConsulted && !realOptions.autoSubmit ? "final-submit-guided-manual"
            : "other-refusal";
      observations.push({ ...base, gate, ...ctx });
      return done;
    } catch (err) {
      active = null;
      observations.push({ ...base, gate: "threw", ...ctx, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };

  return {
    observations,
    restore() {
      if (hadOwnExecuteClick) a.executeClick = realExecuteClick;
      else delete (a as Partial<AdapterInternals>).executeClick; // back to the prototype method
      a.options = realOptions;
      if (hadOwnTest) Object.defineProperty(feeGate, "test", { configurable: true, writable: true, value: priorTest });
      else delete (feeGate as { test?: unknown }).test;
    },
  };
}

/** BEFORE ANY BROWSER: put each isFinalSubmit step of a recipe through the engine's real
 *  executeClick on a fresh, page-less adapter (guided-manual), and report which gate answered.
 *  The scoped element is a stub that records a click attempt — which must never happen. */
export async function preflightFinalSubmitSteps(
  freshAdapter: unknown,
  steps: RecipeStep[],
  feeGate: RegExp,
): Promise<{ observations: ClickGateObservation[]; clickAttempted: boolean }> {
  let clickAttempted = false;
  const stub = { click: async () => { clickAttempted = true; } };
  const probe = probeClickGates(freshAdapter, feeGate);
  try {
    for (const step of steps.filter((s) => (s as { isFinalSubmit?: unknown }).isFinalSubmit === true)) {
      await (freshAdapter as AdapterInternals).executeClick(step, stub, false).catch(() => false);
    }
  } finally {
    probe.restore();
  }
  return { observations: probe.observations, clickAttempted };
}

/** Human-readable reason, for the recorder's report. */
export function describeGate(o: ClickGateObservation): string {
  switch (o.gate) {
    case "final-submit-guided-manual": return "refused by the guided-manual final-submit rule (isFinalSubmit step, autoSubmit off) — a person submits";
    case "fee-gate": return "refused by the FEE gate (PAY_FEE_REPLAY_GATE matched the step's name/note) — NOT the final-submit rule";
    case "clicked": return "CLICKED";
    case "threw": return `threw: ${o.error ?? ""}`;
    default: return "refused by another click gate (past-review or submit-keyword block)";
  }
}
