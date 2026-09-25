// ---------------------------------------------------------------------------
// BACKFILL: research the code editions of the jurisdictions already on file.
//
//   AUTOPILOT_DB_PATH=<db> npx tsx scripts/backfill-code-research.ts [--states OR,TX] [--limit N]
//       [--projects-only] [--apply] [--concurrency 2]
//
// DRY-RUN BY DEFAULT, AND A DRY-RUN WRITES NOTHING: it copies the database (read-only backup) to a
// temp file and plans against the copy — opening a database migrates it and runs the reference
// seed, and neither may touch the target. The plan is therefore what the jurisdictions look like
// once this code has booted against them (the shipped state layers merged in, proposals raised).
//
// ORDER: state layers first; AHJ layers only where the state leaves a family to local adoption
// (Texas cities' residential codes), from the AHJ rows on file plus every AHJ a project names.
// Each layer's decision is codeProfiles.codeResearchDecision — the rule the automatic trigger uses.
// Human-verified rows are never researched here (skip-verified; a verified row found stale gets a
// proposal from the reference seed / the automatic staleness check, never a write).
//
// --apply runs the REAL researcher through the REAL save path (codeProfiles.runCodeResearch — the
// code_research job body), at most 2 at a time, states before AHJs (an AHJ's decision is re-taken
// after its state's research lands). Needs ANTHROPIC_API_KEY. Run it against a scratch copy first.
//
// COST is measured from llm_calls (researchJurisdictionCodes rows) when there are any; otherwise the
// 2026-09-24 probe (46,261 in / 4,863 out tokens, 6 searches) stands in, and the output says so.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type AppDb = {
  query<T>(sql: string, params?: unknown[]): T[];
  get<T>(sql: string, params?: unknown[]): T | null | undefined;
  close?: () => void;
};

export interface PlanItem {
  state: string;
  ahj: string;
  key: string;
  layer: "state" | "ahj";
  action: "research" | "skip" | "verify_check" | "pending_state";
  reason: string;
  families?: string[];
  hasProjects?: boolean;
}

export interface StateTally {
  state: string;
  model: string;
  wouldResearch: number;
  wouldResearchState: number;
  wouldResearchAhj: number;
  /** Of wouldResearchAhj: AHJs a project names (the ones a review will need first). */
  wouldResearchAhjWithProjects: number;
  pendingState: number;
  skipVerified: number;
  skipInherits: number;
  skipFresh: number;
  skipOther: number;
}

export interface BackfillPlan {
  items: PlanItem[];
  tallies: StateTally[];
  totals: { wouldResearch: number; pendingState: number; skipVerified: number; skipInherits: number; skipFresh: number; skipOther: number };
  cost: { perCallUsd: number; basis: string; measuredCalls: number; totalUsd: number };
}

const PROBE = { inTok: 46_261, outTok: 4_863, searches: 6 };
const SEARCH_FEE_USD = 0.01; // $10 per 1,000 web searches
const OPUS_PRICE = { input: 5, output: 25 };

type CP = typeof import("../backend/src/codeProfiles");

async function modules(): Promise<{ CP: CP; F: typeof import("../backend/src/codeFamilies"); acct: typeof import("../backend/src/llmAccounting") }> {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
  const imp = (p: string) => import(pathToFileURL(path.join(root, p)).href);
  return { CP: await imp("backend/src/codeProfiles.ts"), F: await imp("backend/src/codeFamilies.ts"), acct: await imp("backend/src/llmAccounting.ts") };
}

/** Per-call cost of one code research: measured from llm_calls, else the probe. */
export function measuredCallCost(db: AppDb, estimate: (row: { label: string; model: string; in_tok: number | null; out_tok: number | null; cache_read: number | null; cache_write: number | null }) => number | null): { perCallUsd: number; basis: string; measuredCalls: number } {
  let rows: Array<{ label: string; model: string; in_tok: number | null; out_tok: number | null; cache_read: number | null; cache_write: number | null }> = [];
  try {
    rows = db.query("SELECT label, model, in_tok, out_tok, cache_read, cache_write FROM llm_calls WHERE label = 'researchJurisdictionCodes' AND error IS NULL", []);
  } catch { rows = []; }
  const priced = rows.map(estimate).filter((v): v is number => typeof v === "number");
  const searchFee = PROBE.searches * SEARCH_FEE_USD;
  if (priced.length) {
    const avg = priced.reduce((a, b) => a + b, 0) / priced.length;
    return { perCallUsd: avg + searchFee, basis: `measured: mean of ${priced.length} researchJurisdictionCodes call(s) in llm_calls, + ~$${searchFee.toFixed(2)} search fees (${PROBE.searches} searches max, not in llm_calls)`, measuredCalls: priced.length };
  }
  const probe = (PROBE.inTok / 1e6) * OPUS_PRICE.input + (PROBE.outTok / 1e6) * OPUS_PRICE.output;
  return { perCallUsd: probe + searchFee, basis: `NO researchJurisdictionCodes call in llm_calls (0 measured) — using the 2026-09-24 probe: ${PROBE.inTok} in / ${PROBE.outTok} out tokens at $${OPUS_PRICE.input}/$${OPUS_PRICE.output} per Mtok + ~$${searchFee.toFixed(2)} for ${PROBE.searches} searches`, measuredCalls: 0 };
}

/** The plan: READ-ONLY (no write of any kind). */
export async function planBackfill(db: AppDb, opts: { states?: string[]; limit?: number; asOf?: string; projectsOnly?: boolean } = {}): Promise<BackfillPlan> {
  const { CP, F, acct } = await modules();
  const want = (opts.states ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const stateSet = new Set<string>();
  for (const r of db.query<{ state: string }>("SELECT DISTINCT UPPER(state) AS state FROM jurisdiction_code_profiles WHERE state != ''", [])) stateSet.add(r.state);
  const projectAhjs = db.query<{ state: string; ahj: string }>("SELECT DISTINCT UPPER(TRIM(state)) AS state, TRIM(ahj) AS ahj FROM projects WHERE TRIM(COALESCE(state,'')) != '' AND TRIM(COALESCE(ahj,'')) != ''", []);
  for (const r of projectAhjs) stateSet.add(r.state);
  const states = [...stateSet].filter((s) => /^[A-Z]{2}$/.test(s) && (!want.length || want.includes(s))).sort();
  const items: PlanItem[] = [];
  for (const st of states) {
    const d = CP.codeResearchDecision(db as never, st, "", opts.asOf);
    items.push({ state: st, ahj: "", key: d.key, layer: "state", action: d.action === "verify_check" ? "skip" : d.action, reason: d.action === "verify_check" ? `verified (staleness check due: ${d.reason})` : d.reason });
    const seen = new Set<string>();
    // A project names an AHJ under its own spelling ("City of Coos Bay"); the row on file may carry
    // another ("Coos Bay"). Both resolve to one write key — "has projects" is decided by that key.
    const projectKeys = new Set(projectAhjs.filter((p) => p.state === st && !CP.ahjLooksLikeHostname(p.ahj)).map((p) => CP.codeResearchDecision(db as never, st, p.ahj, opts.asOf).key || `${st}|${p.ahj.toLowerCase()}`));
    const candidates = [
      ...db.query<{ ahj: string }>("SELECT ahj FROM jurisdiction_code_profiles WHERE UPPER(state) = ? AND ahj != '' ORDER BY ahj", [st]).map((r) => r.ahj),
      ...projectAhjs.filter((p) => p.state === st).map((p) => p.ahj),
    ];
    for (const ahj of candidates) {
      if (CP.ahjLooksLikeHostname(ahj)) continue;
      const a = CP.codeResearchDecision(db as never, st, ahj, opts.asOf);
      const k = a.key || `${st}|${ahj.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const hasProjects = projectKeys.has(k);
      if (opts.projectsOnly && !hasProjects) continue;
      // STATE FIRST: with no adoption model known yet, an AHJ waits for its state's research — the
      // decision itself says so (the live trigger applies the same rule); --apply re-decides it
      // once the state layer has landed.
      if (a.action === "skip" && a.reason === "pending_state") {
        items.push({ state: st, ahj: a.ahj, key: k, layer: "ahj", action: "pending_state", reason: "state adoption model unknown until the state layer is researched", hasProjects });
        continue;
      }
      items.push({ state: st, ahj: a.ahj, key: k, layer: "ahj", action: a.action === "verify_check" ? "skip" : a.action, reason: a.reason, ...(a.families?.length ? { families: a.families } : {}), hasProjects });
    }
    void F;
  }
  // --limit caps the research calls (states first, then AHJs with projects, then the rest).
  if (opts.limit && opts.limit > 0) {
    const research = items.filter((i) => i.action === "research").sort((a, b) => (a.layer === b.layer ? Number(!!b.hasProjects) - Number(!!a.hasProjects) : a.layer === "state" ? -1 : 1));
    const keep = new Set(research.slice(0, opts.limit));
    for (const i of research) if (!keep.has(i)) { i.action = "skip"; i.reason = `over --limit ${opts.limit}`; }
  }
  const tallies: StateTally[] = states.map((st) => {
    const mine = items.filter((i) => i.state === st);
    const skip = (re: RegExp) => mine.filter((i) => i.action === "skip" && re.test(i.reason)).length;
    const skipVerified = skip(/verified/);
    const skipInherits = skip(/^inherits_state$/);
    const skipFresh = skip(/^fresh$/);
    return {
      state: st,
      model: CP.stateAdoptionModel(db as never, st)?.model ?? "unknown",
      wouldResearch: mine.filter((i) => i.action === "research").length,
      wouldResearchState: mine.filter((i) => i.action === "research" && i.layer === "state").length,
      wouldResearchAhj: mine.filter((i) => i.action === "research" && i.layer === "ahj").length,
      wouldResearchAhjWithProjects: mine.filter((i) => i.action === "research" && i.layer === "ahj" && i.hasProjects).length,
      pendingState: mine.filter((i) => i.action === "pending_state").length,
      skipVerified, skipInherits, skipFresh,
      skipOther: mine.filter((i) => i.action === "skip").length - skipVerified - skipInherits - skipFresh,
    };
  });
  const sum = (k: keyof StateTally) => tallies.reduce((n, t) => n + Number(t[k] || 0), 0);
  const cost = measuredCallCost(db, acct.estimateLlmCallCostUsd);
  const wouldResearch = sum("wouldResearch");
  return {
    items, tallies,
    totals: { wouldResearch, pendingState: sum("pendingState"), skipVerified: sum("skipVerified"), skipInherits: sum("skipInherits"), skipFresh: sum("skipFresh"), skipOther: sum("skipOther") },
    cost: { ...cost, totalUsd: Number((wouldResearch * cost.perCallUsd).toFixed(2)) },
  };
}

export function formatPlan(plan: BackfillPlan): string {
  const lines: string[] = [];
  const head = ["state", "model", "research(st/ahj[w/projects])", "pending-state", "skip-verified", "skip-inherits", "skip-fresh", "skip-other", "est $"];
  lines.push(head.join(" | "));
  for (const t of plan.tallies) {
    lines.push([t.state, t.model, `${t.wouldResearch} (${t.wouldResearchState}/${t.wouldResearchAhj}[${t.wouldResearchAhjWithProjects}])`, t.pendingState, t.skipVerified, t.skipInherits, t.skipFresh, t.skipOther, (t.wouldResearch * plan.cost.perCallUsd).toFixed(2)].join(" | "));
  }
  const T = plan.totals;
  lines.push(`TOTAL: would research ${T.wouldResearch} layer(s) · pending-state ${T.pendingState} (decided after their state lands) · skip-verified ${T.skipVerified} · skip-inherits ${T.skipInherits} · skip-fresh ${T.skipFresh} · skip-other ${T.skipOther}`);
  lines.push(`COST: ~$${plan.cost.perCallUsd.toFixed(3)} per call — ${plan.cost.basis}`);
  lines.push(`ESTIMATE: ~$${plan.cost.totalUsd.toFixed(2)} for the ${T.wouldResearch} planned call(s)${T.pendingState ? ` (+ up to ${T.pendingState} pending-state AHJ call(s) = ~$${(T.pendingState * plan.cost.perCallUsd).toFixed(2)} if their states leave families to local adoption)` : ""}`);
  return lines.join("\n");
}

/** --apply: the real researcher through the real save path. States first; AHJs re-decided after. */
export async function applyBackfill(db: AppDb, plan: BackfillPlan, opts: { concurrency?: number; provider?: unknown; asOf?: string; log?: (s: string) => void } = {}): Promise<Array<Record<string, unknown>>> {
  const { CP } = await modules();
  const log = opts.log ?? ((s: string) => console.log(s));
  const concurrency = Math.max(1, Math.min(2, Number(opts.concurrency) || 2));
  const results: Array<Record<string, unknown>> = [];
  const runAll = async (queue: PlanItem[]) => {
    let i = 0;
    const worker = async () => {
      while (i < queue.length) {
        const item = queue[i++];
        // Re-decide at run time: the state's research (or another run) may have changed the answer.
        const d = CP.codeResearchDecision(db as never, item.state, item.ahj, opts.asOf);
        if (d.action !== "research") { results.push({ ...item, ran: false, now: d.reason }); continue; }
        try {
          const r = await CP.runCodeResearch(db as never, { state: d.state, ahj: d.ahj, profileKey: d.key, ...(d.families?.length ? { families: d.families } : {}), reason: `backfill:${d.reason}` }, opts.provider as never);
          results.push({ ...item, ran: true, ...r });
          log(`  ${item.state}/${d.ahj || "(state)"}: ${r.saved ? "saved" : `not saved (${String(r.reason || (r.verified ? "verified — proposal only" : ""))})`} grounded=${String(r.webGrounded)}`);
        } catch (err) {
          results.push({ ...item, ran: true, error: err instanceof Error ? err.message : String(err) });
          log(`  ${item.state}/${d.ahj || "(state)"}: ERROR ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  };
  await runAll(plan.items.filter((i) => i.layer === "state" && i.action === "research"));
  await runAll(plan.items.filter((i) => i.layer === "ahj" && (i.action === "research" || i.action === "pending_state")));
  return results;
}

export async function main(argv: string[], out: (s: string) => void = (s) => console.log(s)): Promise<number> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const apply = argv.includes("--apply");
  const target = process.env.AUTOPILOT_DB_PATH;
  if (!target || !fs.existsSync(target)) { out("AUTOPILOT_DB_PATH must name an existing database."); return 2; }
  const states = arg("states")?.split(",");
  const limit = Number(arg("limit")) || undefined;
  process.env.SKIP_CODE_RESEARCH = "1"; // opening the DB must never queue research of its own
  let dbPath = path.resolve(target);
  let scratch = "";
  if (!apply) {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-dry-"));
    const copy = path.join(scratch, "plan.sqlite");
    const Database = (await import("better-sqlite3")).default;
    const src = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { await src.backup(copy); } finally { src.close(); }
    dbPath = copy;
  } else if (!String(process.env.ANTHROPIC_API_KEY || "").trim()) {
    out("--apply needs ANTHROPIC_API_KEY (the researcher is the real one)."); return 2;
  }
  const prev = process.env.AUTOPILOT_DB_PATH;
  process.env.AUTOPILOT_DB_PATH = dbPath;
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
  const { openDatabase } = await import(pathToFileURL(path.join(root, "backend/src/db.ts")).href);
  const db = (await openDatabase()) as AppDb;
  process.env.AUTOPILOT_DB_PATH = prev;
  try {
    const plan = await planBackfill(db, { states, limit, projectsOnly: argv.includes("--projects-only") });
    out(`${apply ? "APPLY" : "DRY-RUN (nothing written; planned against a temp copy)"} — ${path.resolve(target)}`);
    out(formatPlan(plan));
    if (apply) {
      const results = await applyBackfill(db, plan, { concurrency: Number(arg("concurrency")) || 2 });
      const saved = results.filter((r) => r.saved).length;
      out(`APPLIED: ${results.filter((r) => r.ran).length} research call(s), ${saved} saved, ${results.filter((r) => r.ran && !r.saved).length} not saved`);
    }
    return 0;
  } finally {
    try { db.close?.(); } catch { /* ignore */ }
    if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a held handle on Windows */ } }
  }
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
