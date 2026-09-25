// ---------------------------------------------------------------------------
// EVAL: the PRODUCT code-edition researcher against the source-VERIFIED truth.
//
//   npx tsx scripts/eval-code-research.ts --truth <dir of *.verified.json>
//       [--states OR,TX] [--ahjs "OR:City of Coos Bay,TX:Mesquite"] [--db <sqlite to copy>]
//       [--out <dir>] [--concurrency 2]
//
// OPT-IN, REAL API, NOT IN ANY TEST CHAIN. Needs ANTHROPIC_API_KEY. It runs
// ClaudeLLMProvider.researchJurisdictionCodes — the current product code, same prompt, same
// budget — with AUTOPILOT_DB_PATH pointed at a SCRATCH copy (so llm_calls records the spend and
// nothing touches a real database), and scores each answer against the verified truth ONLY:
//
//   per state and family: edition exact · effectiveDate exact · basedOn (model + year) ·
//     grounded · source on an official domain · WRONG edition (the dangerous one: an edition
//     that is not the truth's) · omitted;
//   per state: adoption model correct; upcoming editions found;
//   per AHJ: asked EXACTLY what the product asks (codeResearchDecision on the scratch DB, which the
//     shipped state layers seed on open) — an AHJ the product would not research (inherits_state,
//     pending_state, fresh, blocked_verified) is reported as "not researched by the product" and
//     never sent; local editions exact / wrong / omitted are scored ONLY in the asked families (a
//     truth family outside the ask is listed as notAsked), and — for an AHJ that inherits the
//     state — any edition the research invented for it (a conflict).
//
// Every rate prints with its denominator. Total tokens and cost come from llm_calls. The result
// JSON lands in <out>/<timestamp>.json (default .probe/code-editions/eval/).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// --- The verified truth: one loader (the reference-data generator reuses it) --------------------

export interface TruthFamily {
  family: string;
  code?: string | null;
  edition?: string | null;
  basedOn?: string | null;
  effectiveDate?: string | null;
  mandatoryDate?: string | null;
  previousEdition?: string | null;
  scope?: string | null;
  url?: string | null;
  quote?: string | null;
}
export interface TruthUpcoming {
  family: string;
  code?: string | null;
  edition?: string | null;
  basedOn?: string | null;
  anticipatedDate?: string | null;
  status?: string | null;
  url?: string | null;
  quote?: string | null;
}
export interface TruthAhj {
  name: string;
  inheritsState: boolean | null;
  localEditions: Record<string, { edition?: string | null; basedOn?: string | null; effectiveDate?: string | null; url?: string | null; quote?: string | null; superseded?: boolean }>;
  url?: string | null;
}
export interface TruthState {
  state: string;
  group: string;
  asOf: string;
  adoptionModel: string | null;
  adoptionModelNote?: string | null;
  adoptionSources: Array<{ url: string; quote?: string }>;
  families: Record<string, TruthFamily>;
  upcoming: TruthUpcoming[];
  ahjs: TruthAhj[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Null out every leaf the verifier listed as UNVERIFIABLE (refuted leaves are already null in the
 *  verified tree). Paths look like "OR.families.energy.previousEdition", "IL.upcoming[0].status",
 *  "OR.upcoming[electrical].status". Anything else in the list is prose and is ignored. */
function applyUnverifiable(states: Record<string, Record<string, unknown>>, list: unknown): void {
  for (const u of Array.isArray(list) ? list : []) {
    const p = String((u as { path?: string })?.path || "");
    let m = p.match(/^([A-Z]{2})\.families\.(\w+)\.(\w+)$/);
    if (m) {
      const fam = (states[m[1]]?.families as Record<string, Record<string, unknown>> | undefined)?.[m[2]];
      if (fam && m[3] in fam) fam[m[3]] = null;
      continue;
    }
    m = p.match(/^([A-Z]{2})\.upcoming\[([^\]]+)\]\.(\w+)$/);
    if (m) {
      const ups = (states[m[1]]?.upcoming as Array<Record<string, unknown>> | undefined) ?? [];
      const idx = /^\d+$/.test(m[2]) ? Number(m[2]) : ups.findIndex((x) => String(x.family || "").split("/").includes(m![2]));
      if (ups[idx] && m[3] in ups[idx]) ups[idx][m[3]] = null;
    }
  }
}

export function loadTruth(dir: string): Record<string, TruthState> {
  const out: Record<string, TruthState> = {};
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".verified.json")).sort();
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
    const states = JSON.parse(JSON.stringify(raw.states ?? {})) as Record<string, Record<string, unknown>>;
    applyUnverifiable(states, raw.unverifiable);
    const asOf = String(raw.verifiedAt || raw.verifiedAsOf || raw.asOf || "").slice(0, 10);
    for (const [st, s] of Object.entries(states)) {
      const families: Record<string, TruthFamily> = {};
      for (const [fam, v] of Object.entries((s.families ?? {}) as Record<string, Record<string, unknown>>)) {
        families[fam] = { family: fam, ...(v as object) } as TruthFamily;
      }
      const sources: Array<{ url: string; quote?: string }> = [];
      for (const k of ["adoptionModelSource", "adoptionModelSource2", "adoptionModelSource3"]) {
        const src = s[k] as { url?: string; quote?: string } | undefined;
        if (src?.url) sources.push({ url: String(src.url), ...(src.quote ? { quote: String(src.quote) } : {}) });
      }
      const ahjs: TruthAhj[] = Object.entries((s.ahjs ?? {}) as Record<string, Record<string, unknown>>).map(([name, a]) => ({
        name,
        inheritsState: typeof a.inheritsState === "boolean" ? a.inheritsState : null,
        localEditions: (a.localEditions ?? {}) as TruthAhj["localEditions"],
        url: (a.url as string) ?? null,
      }));
      out[st] = {
        state: st,
        group: String(raw.group || f.replace(/\.verified\.json$/, "")),
        asOf,
        adoptionModel: typeof s.adoptionModel === "string" ? s.adoptionModel : null,
        adoptionModelNote: (s.adoptionModelNote as string) ?? null,
        adoptionSources: sources,
        families,
        upcoming: ((s.upcoming ?? []) as TruthUpcoming[]).map((u) => ({ ...u })),
        ahjs,
      };
    }
  }
  return out;
}

/** The first 4-digit year in an edition string ("2015 (residential) / 2021 (commercial)" -> 2015). */
export function editionYear(v: unknown): string | null {
  const m = String(v ?? "").match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

// --- Scoring ------------------------------------------------------------------------------------

const OFFICIAL_HOST = /\.(gov|us|mil)$|(^|\.)(state\.[a-z]{2}\.us|legislature\.[a-z.]+|leg\.[a-z.]+|nfpa\.org|iccsafe\.org|amlegal\.com|municode\.com|ecode360\.com|codepublishing\.com|flrules\.org|floridabuilding\.org|pacodeandbulletin\.gov|mass\.gov|nj\.gov|ny\.gov|oregon\.gov|ca\.gov|wa\.gov)$/i;

export function officialDomain(url: string | undefined, truthUrls: string[]): boolean {
  let host = "";
  try { host = new URL(String(url || "")).hostname.toLowerCase(); } catch { return false; }
  if (!host) return false;
  if (OFFICIAL_HOST.test(host)) return true;
  // The truth's own source hosts count (a city's .org site, a state portal on .com).
  return truthUrls.some((u) => { try { return new URL(u).hostname.toLowerCase() === host; } catch { return false; } });
}

// --- What the PRODUCT asks for an AHJ (the eval measures the product's request, not the truth's) ---

type CPModule = typeof import("../backend/src/codeProfiles");
type AnyDb = Parameters<CPModule["codeResearchDecision"]>[0];

export interface AhjResearchInput {
  /** The product would research this AHJ's codes now. */
  run: boolean;
  /** The name the product researches under (a row on file under another label wins). */
  ahj: string;
  /** The families the product asks for (codeResearchDecision) — undefined = all. */
  families?: string[];
  /** Why not, when run is false ("inherits_state" = the state sets every family). */
  reason: string;
}

/** THE PRODUCT'S AHJ REQUEST: codeResearchDecision on the (scratch) database — the same call the
 *  automatic trigger and the backfill make. An AHJ the product would not research is reported as
 *  such, never researched with a request the product would not send. */
export function ahjResearchInput(CP: Pick<CPModule, "codeResearchDecision">, db: AnyDb, state: string, ahj: string, asOf?: string): AhjResearchInput {
  const d = CP.codeResearchDecision(db, state, ahj, asOf ? `${asOf.slice(0, 10)}T12:00:00Z` : undefined);
  if (d.action !== "research") return { run: false, ahj: d.ahj || ahj, reason: d.reason };
  return { run: true, ahj: d.ahj || ahj, ...(d.families?.length ? { families: [...d.families] } : {}), reason: d.reason };
}

export interface AhjFamilyScore {
  family: string;
  truth: string | null | undefined;
  found: string | null;
  editionExact: boolean;
  wrongEdition: boolean;
  omitted: boolean;
  officialSource: boolean;
}

/** Score an AHJ answer ONLY in the families the product asked for. A truth family outside the ask is
 *  listed as notAsked (the product reads the state's edition there) — never scored as omitted. An
 *  edition the research returned outside the ask is listed as outOfScope (the save drops it). */
export function scoreAhj(
  truthAhj: TruthAhj,
  codes: Array<Record<string, string | undefined>>,
  familiesAsked: string[] | undefined,
  familyOf: (c: Record<string, string | undefined>) => string | undefined,
  truthUrls: string[],
): { local: AhjFamilyScore[]; notAsked: string[]; outOfScope: string[] } {
  const asked = (fam: string) => !familiesAsked?.length || familiesAsked.includes(fam);
  const local = Object.entries(truthAhj.localEditions ?? {}).filter(([, e]) => editionYear(e?.edition) && !e?.superseded);
  const byFamily = (fam: string) => codes.filter((c) => familyOf(c) === fam);
  const scored = local.filter(([fam]) => asked(fam)).map(([fam, e]) => {
    const got = byFamily(fam);
    const exact = got.find((c) => editionYear(c.edition) === editionYear(e.edition));
    const pick = exact ?? got[0];
    return {
      family: fam, truth: e.edition, found: pick ? `${pick.code} ${pick.edition}` : null,
      editionExact: !!exact, wrongEdition: !exact && got.length > 0, omitted: got.length === 0,
      officialSource: exact ? officialDomain(exact.sourceUrl, truthUrls) : false,
    };
  });
  return {
    local: scored,
    notAsked: local.filter(([fam]) => !asked(fam)).map(([fam]) => fam),
    outOfScope: codes.filter((c) => { const f = familyOf(c); return !!f && !asked(f); }).map((c) => `${c.code} ${c.edition}`),
  };
}

interface FamilyScore {
  family: string;
  truth: string;
  found: string | null;
  editionExact: boolean;
  wrongEdition: boolean;
  omitted: boolean;
  effectiveDateExact: boolean | null;
  basedOnMatch: boolean | null;
  officialSource: boolean;
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

/** `deps.provider` is a test seam (a fake researcher; no API key needed). */
export async function main(argv: string[], deps: { provider?: { researchJurisdictionCodes(input: Record<string, unknown>): Promise<unknown> } } = {}): Promise<number> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const truthDir = arg("truth");
  if (!truthDir) { console.error("--truth <dir> is required"); return 2; }
  if (!deps.provider && !String(process.env.ANTHROPIC_API_KEY || "").trim()) { console.error("ANTHROPIC_API_KEY is not set — this eval calls the real API."); return 2; }
  const truth = loadTruth(truthDir);
  const states = (arg("states") ? arg("states")!.split(",") : Object.keys(truth)).map((s) => s.trim().toUpperCase()).filter((s) => truth[s]);
  const ahjSpec = arg("ahjs");
  const outDir = path.resolve(arg("out") || path.join(process.cwd(), ".probe", "code-editions", "eval"));
  const concurrency = Math.max(1, Math.min(4, Number(arg("concurrency")) || 2));

  // A SCRATCH database: the researcher's llm_calls land here, never in a real DB.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eval-code-research-"));
  const scratchDb = path.join(scratch, "eval.sqlite");
  const copyFrom = arg("db");
  if (copyFrom) {
    const Database = (await import("better-sqlite3")).default;
    const src = new Database(copyFrom, { readonly: true, fileMustExist: true });
    await src.backup(scratchDb);
    src.close();
  }
  process.env.AUTOPILOT_DB_PATH = scratchDb;
  process.env.SKIP_CODE_RESEARCH = "1"; // opening the DB must not queue research of its own
  const imp = (p: string) => import(pathToFileURL(path.join(REPO_ROOT, p)).href);
  const { openDatabase } = await imp("backend/src/db.ts");
  const CP = await imp("backend/src/codeProfiles.ts") as CPModule;
  const { codeFamilyOf, modelCodeInText } = await imp("backend/src/codeFamilies.ts");
  const { estimateLlmCallCostUsd } = await imp("backend/src/llmAccounting.ts");
  const db = await openDatabase();
  const llm = deps.provider ?? (await imp("backend/src/llm.ts")).createLLMProvider();
  const startedAt = new Date().toISOString();

  type Job = { kind: "state"; state: string } | { kind: "ahj"; state: string; ahj: TruthAhj };
  const jobs: Job[] = states.map((s) => ({ kind: "state", state: s }));
  if (ahjSpec) {
    for (const item of ahjSpec.split(",").map((x) => x.trim()).filter(Boolean)) {
      const [st, name] = item.includes(":") ? [item.split(":")[0].trim().toUpperCase(), item.split(":").slice(1).join(":").trim()] : ["", item];
      for (const s of st ? [st] : Object.keys(truth)) {
        const a = truth[s]?.ahjs.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (a) jobs.push({ kind: "ahj", state: s, ahj: a });
      }
    }
  }

  const results: Array<Record<string, unknown>> = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const t = truth[job.state];
      const truthUrls = [
        ...Object.values(t.families).map((f) => String(f.url || "")),
        ...t.adoptionSources.map((s) => s.url),
        ...t.upcoming.map((u) => String(u.url || "")),
        ...t.ahjs.map((a) => String(a.url || "")),
      ].filter(Boolean);
      // An AHJ is asked exactly what the PRODUCT would ask (codeResearchDecision on the scratch DB,
      // after the shipped state layers seeded it) — or not researched at all, as in the product.
      const input = job.kind === "ahj" ? ahjResearchInput(CP, db, job.state, job.ahj.name, t.asOf) : null;
      if (input && !input.run) {
        results.push({ kind: "ahj", state: job.state, ahj: job.ahj.name, notResearchedByProduct: true, reason: input.reason, inheritsState: job.ahj.inheritsState });
        console.log(`  ${job.state}/${job.ahj.name}: not researched by the product (${input.reason})`);
        continue;
      }
      const localFamilies = input?.families ?? [];
      const t0 = Date.now();
      let research: { webGrounded: boolean; profile: { adoptedCodes: Array<Record<string, string | undefined>>; adoptionModel?: { model: string; byFamily?: Record<string, string> }; upcoming?: Array<Record<string, string | undefined>>; researchProvenance?: Record<string, unknown> }; notes: string };
      try {
        research = await llm.researchJurisdictionCodes({
          state: job.state,
          ahj: input ? input.ahj : "",
          ...(localFamilies.length ? { families: localFamilies } : {}),
          asOf: t.asOf,
        }) as typeof research;
      } catch (err) {
        results.push({ kind: job.kind, state: job.state, ahj: job.kind === "ahj" ? job.ahj.name : "", error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const codes = research.profile.adoptedCodes ?? [];
      const byFamily = (fam: string) => codes.filter((c) => codeFamilyOf(c as never) === fam);
      if (job.kind === "state") {
        const families: FamilyScore[] = [];
        for (const [fam, f] of Object.entries(t.families)) {
          const want = editionYear(f.edition);
          if (!want) continue; // the truth has no confirmed edition for this family (local, or unverifiable)
          const got = byFamily(fam);
          const exact = got.find((c) => editionYear(c.edition) === want);
          const pick = exact ?? got[0];
          families.push({
            family: fam,
            truth: `${f.code ?? ""} ${f.edition}`.trim(),
            found: pick ? `${pick.code} ${pick.edition}` : null,
            editionExact: !!exact,
            wrongEdition: !exact && got.length > 0,
            omitted: got.length === 0,
            effectiveDateExact: f.effectiveDate && ISO.test(f.effectiveDate) ? (pick ? pick.effectiveDate === f.effectiveDate : false) : null,
            basedOnMatch: f.basedOn && modelCodeInText(f.basedOn)
              ? (pick ? modelCodeInText(pick.basedOn) === modelCodeInText(f.basedOn) && editionYear(pick.basedOn) === editionYear(f.basedOn) : false)
              : null,
            officialSource: pick ? officialDomain(pick.sourceUrl, truthUrls) : false,
          });
        }
        const upcomingTruth = t.upcoming.filter((u) => editionYear(u.edition));
        const upcomingFound = upcomingTruth.filter((u) => (research.profile.upcoming ?? []).some((r) =>
          String(u.family).split("/").includes(String(r.family)) && editionYear(r.edition) === editionYear(u.edition)));
        results.push({
          kind: "state", state: job.state, ms: Date.now() - t0, grounded: research.webGrounded,
          adoptionModel: { truth: t.adoptionModel, found: research.profile.adoptionModel?.model ?? null, correct: !!t.adoptionModel && research.profile.adoptionModel?.model === t.adoptionModel },
          families,
          upcoming: { truth: upcomingTruth.length, found: upcomingFound.length },
          provenance: research.profile.researchProvenance,
          notes: String(research.notes || "").slice(0, 400),
        });
      } else {
        const a = job.ahj;
        const scoredAhj = scoreAhj(a, codes, localFamilies.length ? localFamilies : undefined, (c) => codeFamilyOf(c as never), truthUrls);
        // An AHJ that inherits a uniform state must not come back with its own editions.
        const uniformFamilies = Object.entries(t.families).filter(([, f]) => f.scope === "statewide").map(([k]) => k);
        const conflicts = a.inheritsState ? codes.filter((c) => uniformFamilies.includes(String(codeFamilyOf(c as never)))).map((c) => `${c.code} ${c.edition}`) : [];
        results.push({
          kind: "ahj", state: job.state, ahj: a.name, researchedAs: input!.ahj, ms: Date.now() - t0, grounded: research.webGrounded, inheritsState: a.inheritsState,
          localFamilies, local: scoredAhj.local, notAsked: scoredAhj.notAsked, outOfScope: scoredAhj.outOfScope, conflicts, provenance: research.profile.researchProvenance,
        });
      }
      console.log(`  ${job.kind === "state" ? job.state : `${job.state}/${(job as { ahj: TruthAhj }).ahj.name}`} done in ${Math.round((Date.now() - t0) / 1000)}s (grounded=${research.webGrounded})`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  // --- Aggregate with denominators ---
  const fams = results.filter((r) => r.kind === "state").flatMap((r) => r.families as FamilyScore[]);
  const count = (pred: (f: FamilyScore) => boolean) => fams.filter(pred).length;
  const withDate = fams.filter((f) => f.effectiveDateExact !== null);
  const withBasis = fams.filter((f) => f.basedOnMatch !== null);
  const stateRows = results.filter((r) => r.kind === "state");
  const ahjRows = results.filter((r) => r.kind === "ahj" && !r.notResearchedByProduct && !r.error);
  const ahjSkipped = results.filter((r) => r.kind === "ahj" && r.notResearchedByProduct);
  const calls = db.query("SELECT label, model, in_tok, out_tok, cache_read, cache_write FROM llm_calls WHERE at >= ? AND label LIKE 'researchJurisdictionCodes%'", [startedAt]) as Array<{ label: string; model: string; in_tok: number | null; out_tok: number | null; cache_read: number | null; cache_write: number | null }>;
  const tokensIn = calls.reduce((n, c) => n + (c.in_tok ?? 0), 0);
  const tokensOut = calls.reduce((n, c) => n + (c.out_tok ?? 0), 0);
  const priced = calls.map((c) => estimateLlmCallCostUsd(c));
  const costUsd = priced.every((p) => p !== null) ? priced.reduce((n: number, p) => n + (p ?? 0), 0) : null;
  const searches = results.reduce((n, r) => n + Number((r.provenance as { searches?: number } | undefined)?.searches ?? 0), 0);
  const summary = {
    families: {
      denominator: fams.length,
      editionExact: count((f) => f.editionExact),
      wrongEdition: count((f) => f.wrongEdition),
      omitted: count((f) => f.omitted),
      officialSource: count((f) => f.officialSource),
      effectiveDateExact: `${withDate.filter((f) => f.effectiveDateExact).length}/${withDate.length}`,
      basedOnMatch: `${withBasis.filter((f) => f.basedOnMatch).length}/${withBasis.length}`,
    },
    states: {
      denominator: stateRows.length,
      grounded: stateRows.filter((r) => r.grounded).length,
      adoptionModelCorrect: `${stateRows.filter((r) => (r.adoptionModel as { correct: boolean }).correct).length}/${stateRows.filter((r) => (r.adoptionModel as { truth: string | null }).truth).length}`,
      upcomingFound: `${stateRows.reduce((n, r) => n + (r.upcoming as { found: number }).found, 0)}/${stateRows.reduce((n, r) => n + (r.upcoming as { truth: number }).truth, 0)}`,
    },
    ahjs: {
      denominator: ahjRows.length,
      grounded: ahjRows.filter((r) => r.grounded).length,
      localExact: `${ahjRows.reduce((n, r) => n + (r.local as Array<{ editionExact: boolean }>).filter((x) => x.editionExact).length, 0)}/${ahjRows.reduce((n, r) => n + (r.local as unknown[]).length, 0)}`,
      localWrong: ahjRows.reduce((n, r) => n + (r.local as Array<{ wrongEdition: boolean }>).filter((x) => x.wrongEdition).length, 0),
      inheritConflicts: ahjRows.reduce((n, r) => n + (r.conflicts as unknown[]).length, 0),
      notAskedFamilies: ahjRows.reduce((n, r) => n + (r.notAsked as unknown[]).length, 0),
      notResearchedByProduct: ahjSkipped.map((r) => `${r.state}/${r.ahj} (${r.reason})`),
    },
    cost: {
      calls: calls.length,
      tokensIn, tokensOut,
      tokenCostUsd: costUsd === null ? "unpriced model" : Number(costUsd.toFixed(3)),
      webSearches: searches,
      webSearchFeeUsdEstimate: Number((searches * 0.01).toFixed(2)),
    },
  };
  console.log("\n=== code research eval (verified truth only) ===");
  console.log(`families: ${summary.families.editionExact}/${summary.families.denominator} edition exact · ${summary.families.wrongEdition}/${summary.families.denominator} WRONG edition · ${summary.families.omitted}/${summary.families.denominator} omitted · ${summary.families.officialSource}/${summary.families.denominator} official source · effectiveDate ${summary.families.effectiveDateExact} · basedOn ${summary.families.basedOnMatch}`);
  console.log(`states: ${summary.states.grounded}/${summary.states.denominator} grounded · adoption model ${summary.states.adoptionModelCorrect} · upcoming ${summary.states.upcomingFound}`);
  if (ahjRows.length) console.log(`ahjs: ${summary.ahjs.grounded}/${summary.ahjs.denominator} grounded · local editions exact ${summary.ahjs.localExact} · wrong ${summary.ahjs.localWrong} · editions invented for inheriting AHJs ${summary.ahjs.inheritConflicts} · truth families the product does not ask (not scored) ${summary.ahjs.notAskedFamilies}`);
  if (ahjSkipped.length) console.log(`ahjs not researched by the product: ${summary.ahjs.notResearchedByProduct.join(", ")}`);
  console.log(`cost: ${summary.cost.calls} call(s), ${tokensIn} in / ${tokensOut} out tokens, $${summary.cost.tokenCostUsd} tokens + ~$${summary.cost.webSearchFeeUsdEstimate} search fees (${searches} searches)`);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ startedAt, truthDir, states, summary, results }, null, 2), "utf8");
  console.log(`\nwrote ${outFile}`);
  try { db.close?.(); } catch { /* ignore */ }
  return 0;
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
