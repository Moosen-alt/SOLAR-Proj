// PER-TASK MODEL ROUTING — which model, at which effort, with which advisor, for each product AI call.
//
// Every Claude call in backend/src asks this module (via llm.ts) what to run on. Before it existed,
// every call read ONE constant (`AUTOPILOT_LLM_MODEL || "claude-opus-5"`), so a model change was all
// or nothing: moving the cheap calls meant moving plan-set intake too.
//
// RELIABILITY FIRST (operator, 2026-09-26): "Make it as smart as needed to get the task completed as
// reliably ... and be able to decern correctly for the projects main goals" / "not leaking costs
// uneeded". A task moves to a cheaper setup ONLY when it measured at least as accurate on that task's
// truth set. An UNMEASURED task stays on claude-opus-5 at exactly the effort it sends today, so the
// shipped table reproduces today's wire bytes (model + effort) for every call.
//
// WHAT WAS MEASURED (2026-09-26, .probe/model-routing/; product prompts, scratch runners, no product
// file edited while measuring):
//   · extractProjectFields (plan-set intake), 13 plan sets / 5 states / 331 ground-truth fields:
//       claude-opus-5 high ........ 245/3/0 (wave 1) + 83/0/0 (wave 2), installer 108/108, $0.59/set
//       claude-opus-5-5 medium .... 243/4/1, $0.44/set — but drops moduleVoc/moduleVocTempCoeff on 9/9
//                                   sets and moduleIsc on 7/9 (not in ground truth; the Iowa worksheet
//                                   then asks the operator), and one stamp wording flips permitPath
//       claude-opus-5-5 high ...... 244/4/0, $0.61/set, same Voc/Isc drops, 2/9 max_tokens retries
//       claude-sonnet-5 high ...... 244/3/1, 7/9 sets hit max_tokens 16000; at 32k: wave 2 82/1/0 with
//                                   a stamp over-claim and one installer taken from a letter brand
//       + Fable 5.1 advisor ....... 91/2/0 vs 90/2/1 alone on the 3 hardest sets, at 3.2x the cost
//     => stays claude-opus-5 / high. No cheaper setup matched it without an operator-visible loss.
//   · webLookup (permitProcessLookup), 6 held-out AHJs, 63 truth items, pre-registered rule
//     "replace only if WRONG <= 3 AND found >= 22 AND cheaper":
//       claude-opus-5 (effort omitted = high) .. 22 found / 3 WRONG, $0.84/lookup, 2 calls aborted
//       claude-opus-5-5, effort omitted ......... 19 / 5  ($0.59) — the medium default is WORSE
//       claude-opus-5-5 high, run 1 ............. 22 / 4  ($0.64) — fails the rule on WRONG
//       claude-opus-5-5 high, run 2 ............. 25 / 3  ($0.52) — passes
//       claude-sonnet-5 high .................... 13 of 15 calls aborted at the time budget
//       claude-opus-5-5 + Fable advisor ......... partial (2-3 AHJs), no lift over the executor
//     => stays claude-opus-5. Opus 5.5 high is the LEADING CANDIDATE (split replicate pair, 2.3x
//        faster, no aborts) — one env var away (AUTOPILOT_LLM_ROUTE_WEBLOOKUP=claude-opus-5-5@high),
//        not the default until a third run settles it.
//   · The Opus 5.5 lesson that applies everywhere: its API default effort is MEDIUM (Opus 5's is
//     high). Config A above shows what an unpinned switch ships. So whenever a route resolves to a
//     model other than claude-opus-5 and names no effort, this module pins "high" — the effort that
//     route was implicitly running at on Opus 5. Never rely on a model's default.
//
// ENV OVERRIDES (read per call, so a test or an operator can flip one task without a restart):
//   AUTOPILOT_LLM_MODEL=<model>                    every task's model (the pre-existing global switch)
//   AUTOPILOT_LLM_ROUTE_<TASK>=<model>[@<effort>]  one task, e.g. AUTOPILOT_LLM_ROUTE_WEBLOOKUP=claude-opus-5-5@high
//   AUTOPILOT_LLM_ADVISOR_<TASK>=<advisor>[:<maxUses>]  opt one ADVISOR-CAPABLE task into the Fable advisor
//   AUTOPILOT_ADVISOR_MAX_REQUESTS=<n>             process-wide ceiling on advisor-bearing requests (default 50)
// <TASK> is the task name upper-cased with every non-alphanumeric run turned into "_"
// ("planPortalFields.vision" -> PLANPORTALFIELDS_VISION). An unknown model, an unknown effort or an
// invalid advisor pairing is REFUSED with a warning and the table's own value is used — a typo in an
// env var must never become a 400 on a live intake.
//
// No imports beyond the logger: llm.ts imports this, and feeSchedules.ts does too
// (routeFor("researchFeeSchedule")) without closing any cycle.
import { logger } from "./logger";

export type LlmEffort = "low" | "medium" | "high" | "xhigh";

/** The product's model calls, by task. Labels in llm_calls map onto these (see taskForLabel). */
export const LLM_TASKS = [
  "extractFields",
  "extractProjectFields",
  "extractProjectFieldsFromImages",
  "classifyCorrection",
  "draftResponse",
  "visionExtract",
  "reviewPlanSetGeneral",
  "synthesizeKnowledge",
  "researchAhjRequirements",
  "researchAhjRequirements.fallback",
  "researchUtilityRequirements",
  "researchUtilityRequirements.fallback",
  "researchDesignCriteria",
  "researchJurisdictionCodes",
  "webLookup",
  "suggestRecipeFieldBindings",
  "planPortalFields",
  "planPortalFields.vision",
  "verifyPortalFill",
  "verifyPortalFillVision",
  "lookupInverterSpec",
  "lookupInverterSpec.web",
  "findAhjFormUrl",
  "mapAcroFormFields",
  "mapFlatFormOverlay",
  "runToolAgent",
  "researchFeeSchedule",
] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

export const BASELINE_MODEL = "claude-opus-5";

/** Models a route may resolve to, with what the request builder must know about each. Every one is
 *  priced in llmAccounting (a test holds the two lists together). claude-haiku-4-5 is priced but NOT
 *  routable: nothing measured it on any task here and its thinking/effort surface differs. */
export const ROUTABLE_MODELS: Record<string, { defaultEffort: LlmEffort }> = {
  "claude-opus-5": { defaultEffort: "high" },
  "claude-opus-5-5": { defaultEffort: "medium" },
  "claude-sonnet-5": { defaultEffort: "high" },
  "claude-fable-5-1": { defaultEffort: "high" },
};

/** Valid executor -> advisor pairings (the advisor must be at least as capable as the executor).
 *  From the advisor-tool docs table; claude-opus-5-5 -> claude-fable-5-1 is not in that table and was
 *  PROBED instead (accepted, 2026-09-26, .probe/model-routing/measure-parser/advisorProbe.mts). Only
 *  advisors that are priced in llmAccounting are listed. */
export const ADVISOR_PAIRINGS: Record<string, readonly string[]> = {
  "claude-opus-5": ["claude-fable-5-1", "claude-opus-5"],
  "claude-opus-5-5": ["claude-fable-5-1"],
  "claude-sonnet-5": ["claude-fable-5-1", "claude-opus-5"],
  "claude-fable-5-1": ["claude-fable-5-1", "claude-opus-5"],
};

/** Tasks whose request path can carry the advisor tool — the two paths it was measured on. Adding it
 *  to a structured-output (output_config.format) call is unmeasured, so those tasks cannot opt in. */
export const ADVISOR_CAPABLE_TASKS: ReadonlySet<LlmTask> = new Set<LlmTask>(["extractProjectFields", "webLookup"]);

/** The advisor's own output cap per consult. The API rejects < 1024 (probed). */
export const ADVISOR_MAX_TOKENS = 2000;
export const ADVISOR_MAX_USES_CEILING = 3;

export interface AdvisorConfig {
  model: string;
  /** Consults per request (the tool's max_uses). */
  maxUses: number;
  maxTokens: number;
}

interface RouteEntry {
  model: string;
  /** undefined = the call sends NO effort (today's wire bytes; Opus 5 then runs at its default, high). */
  effort?: LlmEffort;
  /** runToolAgent: the caller names the effort per agent (AgentRunInput.effort). */
  effortFromCaller?: boolean;
  advisor?: AdvisorConfig | null;
  evidence: string;
}

const UNMEASURED = "unmeasured — stays on the baseline model at the effort it sends today";

/** THE TABLE. Model + effort per task, each citing why. Effort values are exactly what each call site
 *  sent before routing existed (a test asserts the wire is unchanged for a sample of routes). */
export const ROUTE_TABLE: Readonly<Record<LlmTask, RouteEntry>> = {
  extractProjectFields: { model: BASELINE_MODEL, effort: "high", advisor: null, evidence: "MEASURED 2026-09-26: opus-5 high 328/3/0 on 12 plan sets (wave 1+2), installer 108/108; opus-5-5 medium/high and sonnet-5 each lost fields (Voc/Isc drops, max_tokens truncation, stamp over-claim); Fable advisor 3.2x cost, no field it alone fixed" },
  extractProjectFieldsFromImages: { model: BASELINE_MODEL, effort: "high", evidence: UNMEASURED + " (bill/meter photos: rule 2's one intake read)" },
  extractFields: { model: BASELINE_MODEL, evidence: UNMEASURED },
  classifyCorrection: { model: BASELINE_MODEL, evidence: UNMEASURED },
  draftResponse: { model: BASELINE_MODEL, evidence: UNMEASURED },
  visionExtract: { model: BASELINE_MODEL, effort: "high", evidence: UNMEASURED },
  reviewPlanSetGeneral: { model: BASELINE_MODEL, effort: "high", evidence: UNMEASURED },
  synthesizeKnowledge: { model: BASELINE_MODEL, evidence: UNMEASURED },
  researchAhjRequirements: { model: BASELINE_MODEL, evidence: UNMEASURED },
  "researchAhjRequirements.fallback": { model: BASELINE_MODEL, effort: "high", evidence: UNMEASURED },
  researchUtilityRequirements: { model: BASELINE_MODEL, evidence: UNMEASURED },
  "researchUtilityRequirements.fallback": { model: BASELINE_MODEL, effort: "high", evidence: UNMEASURED },
  researchDesignCriteria: { model: BASELINE_MODEL, evidence: UNMEASURED },
  researchJurisdictionCodes: { model: BASELINE_MODEL, evidence: UNMEASURED },
  webLookup: { model: BASELINE_MODEL, advisor: null, evidence: "MEASURED 2026-09-26 (6 held AHJs, 63 items): opus-5 22 found/3 WRONG; opus-5-5 default-effort 19/5; opus-5-5 high 22/4 then 25/3 (split — fails the pre-registered rule once); sonnet-5 aborted 13/15; Fable advisor partial, no lift. Leading candidate: claude-opus-5-5@high" },
  suggestRecipeFieldBindings: { model: BASELINE_MODEL, evidence: UNMEASURED },
  planPortalFields: { model: BASELINE_MODEL, effort: "high", evidence: UNMEASURED },
  "planPortalFields.vision": { model: BASELINE_MODEL, effort: "xhigh", evidence: UNMEASURED },
  verifyPortalFill: { model: BASELINE_MODEL, evidence: UNMEASURED },
  verifyPortalFillVision: { model: BASELINE_MODEL, effort: "high", evidence: UNMEASURED },
  lookupInverterSpec: { model: BASELINE_MODEL, effort: "low", evidence: "measured 2026-09-15 on opus-5: low returned the same amps/VA as high on 4 real models at 43% fewer output tokens; the answer is checked and escalates to .web" },
  "lookupInverterSpec.web": { model: BASELINE_MODEL, evidence: UNMEASURED },
  findAhjFormUrl: { model: BASELINE_MODEL, evidence: UNMEASURED },
  mapAcroFormFields: { model: BASELINE_MODEL, effort: "high", evidence: UNMEASURED },
  mapFlatFormOverlay: { model: BASELINE_MODEL, effort: "high", evidence: UNMEASURED },
  runToolAgent: { model: BASELINE_MODEL, effortFromCaller: true, evidence: UNMEASURED + " (effort is the agent caller's, default medium)" },
  researchFeeSchedule: { model: BASELINE_MODEL, evidence: UNMEASURED + " (feeSchedules.claudeFeeScheduleResearcher builds its own client but reads THIS route for model + effort; no truth set has scored it on any other model — the most expensive call in the system, measure before moving it)" },
};

/** What a call runs on, fully resolved. `effort` undefined means "send no effort" and only ever
 *  happens on claude-opus-5 (whose default is the high every such route was measured at). */
export interface ResolvedRoute {
  task: LlmTask;
  model: string;
  effort?: LlmEffort;
  advisor: AdvisorConfig | null;
  /** Where each value came from, for the log line and the tests. */
  source: { model: "table" | "global-env" | "task-env"; effort: "table" | "task-env" | "caller" | "pinned-high" | "omitted" };
  /** When a safety classifier refuses on this model: the model a refusal is retried on once (null = none). */
  refusalFallback: { model: string; effort?: LlmEffort } | null;
}

export function taskEnvKey(task: string): string {
  return task.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
}

const EFFORTS: readonly LlmEffort[] = ["low", "medium", "high", "xhigh"];
const warned = new Set<string>();
function warnOnce(key: string, msg: string, meta: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn("llm", msg, meta);
}

function parseRouteEnv(raw: string): { model?: string; effort?: string } {
  const [model, effort] = raw.trim().split("@").map((s) => s.trim());
  return { model: model || undefined, effort: effort || undefined };
}

/** Resolve one task's route: table, then the global model env, then the task's own env. */
export function routeFor(task: LlmTask, opts: { callerEffort?: LlmEffort; env?: NodeJS.ProcessEnv } = {}): ResolvedRoute {
  const env = opts.env ?? process.env;
  const entry = ROUTE_TABLE[task];
  const key = taskEnvKey(task);

  let model = entry.model;
  let modelSource: ResolvedRoute["source"]["model"] = "table";
  const globalModel = (env.AUTOPILOT_LLM_MODEL || "").trim();
  if (globalModel) {
    if (ROUTABLE_MODELS[globalModel]) { model = globalModel; modelSource = "global-env"; }
    else warnOnce(`global:${globalModel}`, `AUTOPILOT_LLM_MODEL="${globalModel}" is not a routable model — ignored; tasks keep their table model`, { routable: Object.keys(ROUTABLE_MODELS) });
  }

  let effort: LlmEffort | undefined = entry.effort;
  let effortSource: ResolvedRoute["source"]["effort"] = entry.effort ? "table" : "omitted";
  if (entry.effortFromCaller && opts.callerEffort) { effort = opts.callerEffort; effortSource = "caller"; }

  const taskRaw = env[`AUTOPILOT_LLM_ROUTE_${key}`];
  if (taskRaw && taskRaw.trim()) {
    const o = parseRouteEnv(taskRaw);
    if (o.model) {
      if (ROUTABLE_MODELS[o.model]) { model = o.model; modelSource = "task-env"; }
      else warnOnce(`task:${key}:${o.model}`, `AUTOPILOT_LLM_ROUTE_${key} names "${o.model}", which is not a routable model — ignored`, { routable: Object.keys(ROUTABLE_MODELS) });
    }
    if (o.effort) {
      if ((EFFORTS as readonly string[]).includes(o.effort)) { effort = o.effort as LlmEffort; effortSource = "task-env"; }
      else warnOnce(`effort:${key}:${o.effort}`, `AUTOPILOT_LLM_ROUTE_${key} names effort "${o.effort}" — not one of ${EFFORTS.join("/")}; ignored`, {});
    }
  }

  // THE OPUS 5.5 RULE. A route with no effort was running at Opus 5's default (high). Any other
  // model's default may differ (Opus 5.5: medium, measured WORSE on the lookup) — pin what it ran at.
  if (effort === undefined && model !== BASELINE_MODEL) { effort = "high"; effortSource = "pinned-high"; }

  const advisor = resolveAdvisor(task, model, entry.advisor ?? null, env);

  // A refusal on a non-baseline model is retried ONCE on the baseline at the table's effort (the
  // Opus 5.5 checklist: "ship a fallback opt-in"). On the baseline itself there is nothing to fall to.
  const refusalFallback = model !== BASELINE_MODEL ? { model: BASELINE_MODEL, ...(entry.effort ? { effort: entry.effort } : {}) } : null;

  return { task, model, ...(effort ? { effort } : {}), advisor, source: { model: modelSource, effort: effortSource }, refusalFallback };
}

function resolveAdvisor(task: LlmTask, model: string, fromTable: AdvisorConfig | null, env: NodeJS.ProcessEnv): AdvisorConfig | null {
  const key = taskEnvKey(task);
  const raw = (env[`AUTOPILOT_LLM_ADVISOR_${key}`] || "").trim();
  let cfg: AdvisorConfig | null = fromTable;
  if (raw) {
    if (/^(off|none|0|false)$/i.test(raw)) return null;
    const [advModel, usesRaw] = raw.split(":").map((s) => s.trim());
    const uses = usesRaw ? Number(usesRaw) : 1;
    cfg = { model: advModel, maxUses: Number.isFinite(uses) ? Math.max(1, Math.min(ADVISOR_MAX_USES_CEILING, Math.round(uses))) : 1, maxTokens: ADVISOR_MAX_TOKENS };
  }
  if (!cfg) return null;
  if (!ADVISOR_CAPABLE_TASKS.has(task)) {
    warnOnce(`adv-task:${key}`, `advisor requested for ${task}, which cannot carry it (unmeasured request path) — ignored`, { capable: [...ADVISOR_CAPABLE_TASKS] });
    return null;
  }
  if (!(ADVISOR_PAIRINGS[model] ?? []).includes(cfg.model)) {
    warnOnce(`adv-pair:${key}:${model}:${cfg.model}`, `advisor ${cfg.model} is not a valid pairing for executor ${model} — ignored (the API would 400)`, { valid: ADVISOR_PAIRINGS[model] ?? [] });
    return null;
  }
  return { ...cfg, maxTokens: Math.max(1024, cfg.maxTokens) };
}

// ---------------------------------------------------------------------------
// Process-wide advisor ceiling. Each advisor-bearing request can cost several times the executor
// alone (measured: $1.50 vs $0.47 per plan set). A bad env value must not become an open tap.
// ---------------------------------------------------------------------------
let advisorRequests = 0;

/** Take one advisor slot. False once the ceiling is reached — the call then runs without it. */
export function takeAdvisorSlot(env: NodeJS.ProcessEnv = process.env): boolean {
  const cap = Number(env.AUTOPILOT_ADVISOR_MAX_REQUESTS);
  const ceiling = Number.isFinite(cap) && cap >= 0 ? cap : 50;
  if (advisorRequests >= ceiling) {
    warnOnce(`adv-cap:${ceiling}`, `advisor ceiling reached (${ceiling} requests this process) — further calls run without the advisor`, {});
    return false;
  }
  advisorRequests++;
  return true;
}

/** Tests only. */
export function resetAdvisorSlotsForTest(): void { advisorRequests = 0; warned.clear(); }

/** Map a recorded call label onto its task (labels carry suffixes: "#3", "[who]", a caller's own
 *  webLookup label). Unknown labels map to null. */
export function taskForLabel(label: string): LlmTask | null {
  const base = String(label || "").replace(/#.*$/, "").replace(/\[.*$/, "");
  if ((LLM_TASKS as readonly string[]).includes(base)) return base as LlmTask;
  return null;
}

/** One line per task, for the provider's startup log. */
export function describeRoutes(env: NodeJS.ProcessEnv = process.env): Array<{ task: LlmTask; model: string; effort: string; advisor: string | null; source: string }> {
  return LLM_TASKS.map((task) => {
    const r = routeFor(task, { env });
    return { task, model: r.model, effort: r.effort ?? "(omitted)", advisor: r.advisor ? `${r.advisor.model}x${r.advisor.maxUses}` : null, source: `${r.source.model}/${r.source.effort}` };
  });
}
