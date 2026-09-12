// ---------------------------------------------------------------------------
// FEE SCHEDULES — the schedule a fee came from, not just the fee.
//
// submissionFees.ts already resolves a DOLLAR AMOUNT for a submission, best
// source first: actual > learned_history > valuation_estimate > unknown. That
// ladder answers "what will this cost?" and nothing else. It cannot answer the
// question an AHJ application actually asks.
//
// Coos Bay's Accela recipe carries the frozen answer
//     "Renewable energy for electrical systems- 5.01kva through 15kva = 1"
// — a fee BRACKET QUANTITY, learned once from a learn project and replayed ever
// after. A 20 kW job replays into the 5.01–15 kVA bracket and is billed in the
// wrong tier, on a field that looks perfectly answered. No total, however
// accurate, fixes that: the bracket is a different fact than the price.
//
// So this module stores the schedule as a FUNCTION of something. `basis` names
// the variable the jurisdiction keys on (system kVA/kW, job valuation, or a flat
// charge); the brackets are the ordered table; feeForProject evaluates it for a
// specific project and returns BOTH the dollar amount and the bracket label the
// application needs.
//
// Two rules this module exists to keep:
//   - A fee with no quotable sentence behind it is a rumour. Research that
//     cannot produce a source URL *and* the sentence the number came from is
//     refused, not stored (hard safety: a rumour in a fee field is
//     indistinguishable from a fact).
//   - Research lands 'seeded' and NEVER auto-verifies (hard rule 3). Against a
//     human-'verified' row a research pass REFUSES to change anything and
//     appends its finding to notes, so the disagreement is visible instead of
//     the row quietly moving under the person who verified it.
//
// "No fee" is a FINDING, not a gap: a sourced flat $0 (most residential NEM) is
// stored as a real schedule. found:false means we could not find out. The two
// must never collapse into each other — that is exactly the conflation the
// quote ladder's "unknown" already suffers.
//
// NOTE ON TYPES: these live here rather than in shared/src/types.ts because
// nothing outside the backend consumes them yet. They move to the shared
// surface when the API/dashboard build lands.
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { knowledgeNameMatchScore, knowledgeProfileKey, knowledgeResearchHint } from "./knowledgeBase";
import { resolveValuation } from "./valuation";
import { sanitizeApiKey } from "./llm";
import { logger } from "./logger";
import { id } from "./ids";
import { text } from "./json";
import { nowIso } from "./time";

type Row = Record<string, unknown>;

export type FeeTrack = "permit" | "nem";
export type FeeBasis = "system_kw" | "valuation" | "flat" | "other";
export type FeeConfidence = "seeded" | "verified";

/** One line of a published schedule. Which pair of bounds is populated follows
 *  the schedule's `basis`; a flat schedule carries one bracket with neither. A
 *  null/absent upper bound means "and above" (the open last row). */
export interface FeeBracket {
  minKw?: number | null;
  maxKw?: number | null;
  minValuationUsd?: number | null;
  maxValuationUsd?: number | null;
  feeUsd: number;
  /** The jurisdiction's OWN wording for this line — this is what the permit
   *  application's fee-quantity field is asking for, verbatim where possible. */
  label?: string;
}

export interface FeeScheduleRecord {
  id: string;
  profileKey: string;
  state: string;
  ahj: string;
  utility: string;
  track: FeeTrack;
  basis: FeeBasis;
  brackets: FeeBracket[];
  notes: string;
  sourceUrl: string;
  sourceQuote: string;
  /** 'official' = the jurisdiction's/utility's own domain; 'third_party' = a
   *  summary site, acceptable only when labelled as such. */
  sourceKind: string;
  confidence: FeeConfidence;
  firstSeenAt: string;
  updatedAt: string;
  verifiedAt: string;
  verifiedBy: string;
}

/** What a researcher reports back. `found:false` carries a reason so a caller
 *  can tell "this jurisdiction charges nothing" from "we could not find out". */
export interface FeeScheduleFinding {
  found: boolean;
  reason: string;
  basis: FeeBasis;
  brackets: FeeBracket[];
  notes: string;
  sourceUrl: string;
  sourceQuote: string;
  sourceKind: string;
}

export interface FeeScheduleResearchInput {
  state: string;
  ahj?: string;
  utility?: string;
  track: FeeTrack;
  /** What the KB already knows about this jurisdiction/utility — several of the
   *  permit_utility_knowledge rows already carry the AHJ's own fee-page URL. */
  knownContext?: string;
}

export type FeeScheduleResearcher = (input: FeeScheduleResearchInput) => Promise<FeeScheduleFinding>;

export interface FeeScheduleResearchOutcome {
  found: boolean;
  reason: string;
  saved: boolean;
  /** True when a human-verified row blocked the write (its finding went to notes). */
  refusedVerified: boolean;
  profileKey: string;
  track: FeeTrack;
  /** The row as it stands AFTER the pass — unchanged when refusedVerified. */
  schedule: FeeScheduleRecord | null;
  /** What research actually said, saved or not. */
  finding: FeeScheduleFinding | null;
}

export interface ProjectFeeResolution {
  /** null when a schedule exists but cannot be evaluated for this project. */
  feeUsd: number | null;
  /** The schedule line's own wording — what the application's fee field wants. */
  bracketLabel: string;
  basis: FeeBasis;
  sourceUrl: string;
  sourceQuote: string;
  confidence: FeeConfidence;
  /** The AHJ/utility name the schedule is filed under (may differ from the
   *  project's spelling when the fuzzy fallback matched). */
  matchedName: string;
  scheduleId: string;
  /** Populated when feeUsd is null: why the schedule did not evaluate. */
  reason: string;
}

const NOTE_SEGMENT_CAP = 40;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function clean(value: unknown): string {
  return text(value).replace(/\s+/g, " ").trim();
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** KB notes are " | "-joined SEGMENTS; merge and dedupe by segment, never as one
 *  blob (the runaway-notes bug). Same convention as knowledgeBase.noteSegments. */
function noteSegments(value: unknown): string[] {
  return clean(value).split(" | ").map((s) => s.trim()).filter(Boolean);
}

function mergeNotes(existing: unknown, incoming: string[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seg of [...noteSegments(existing), ...incoming].map(clean).filter(Boolean)) {
    const key = seg.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seg);
    if (out.length >= NOTE_SEGMENT_CAP) break;
  }
  return out.join(" | ");
}

export function feeTrack(track?: string | null): FeeTrack {
  return String(track || "").toLowerCase() === "nem" ? "nem" : "permit";
}

/** Profile key at permit_utility_knowledge's OWN grain, which is two grains and
 *  not three: a permit schedule belongs to (state, AHJ) and an interconnection
 *  schedule to (state, utility). Keying on all three would file the same city's
 *  permit fee separately per utility and miss on every lookup. */
export function feeScheduleProfileKey(input: { state?: string; ahj?: string; utility?: string }, track: FeeTrack): string {
  return track === "nem"
    ? knowledgeProfileKey({ state: input.state, ahj: "", utility: input.utility })
    : knowledgeProfileKey({ state: input.state, ahj: input.ahj, utility: "" });
}

function parseBrackets(raw: unknown): FeeBracket[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text(raw) || "[]"); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return normalizeBrackets(parsed);
}

/** Keep only lines with a real fee, and ORDER them, because bracket evaluation
 *  is first-match — an unsorted table silently answers with the wrong tier. */
function normalizeBrackets(raw: unknown[]): FeeBracket[] {
  const out: FeeBracket[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const fee = num(b.feeUsd ?? b.fee_usd ?? b.fee);
    if (fee == null || fee < 0) continue;
    out.push({
      minKw: num(b.minKw ?? b.min_kw ?? b.minKva ?? b.min_kva),
      maxKw: num(b.maxKw ?? b.max_kw ?? b.maxKva ?? b.max_kva),
      minValuationUsd: num(b.minValuationUsd ?? b.min_valuation_usd),
      maxValuationUsd: num(b.maxValuationUsd ?? b.max_valuation_usd),
      feeUsd: round2(fee),
      label: clean(b.label).slice(0, 200),
    });
  }
  const sortKey = (b: FeeBracket): number => b.minKw ?? b.minValuationUsd ?? 0;
  return out.sort((a, b) => sortKey(a) - sortKey(b));
}

function mapSchedule(row: Row): FeeScheduleRecord {
  return {
    id: text(row.id),
    profileKey: text(row.profile_key),
    state: text(row.state),
    ahj: text(row.ahj),
    utility: text(row.utility),
    track: feeTrack(text(row.track)),
    basis: (["system_kw", "valuation", "flat", "other"].includes(text(row.basis)) ? text(row.basis) : "other") as FeeBasis,
    brackets: parseBrackets(row.brackets_json),
    notes: text(row.notes),
    sourceUrl: text(row.source_url),
    sourceQuote: text(row.source_quote),
    sourceKind: text(row.source_kind),
    confidence: text(row.confidence) === "verified" ? "verified" : "seeded",
    firstSeenAt: text(row.first_seen_at),
    updatedAt: text(row.updated_at),
    verifiedAt: text(row.verified_at),
    verifiedBy: text(row.verified_by),
  };
}

export function getFeeSchedule(db: AppDb, profileKey: string, track: FeeTrack): FeeScheduleRecord | null {
  const row = db.get<Row>("SELECT * FROM fee_schedules WHERE profile_key = ? AND track = ?", [profileKey, track]);
  return row ? mapSchedule(row) : null;
}

/** Mark a schedule human-verified. From here on a research pass may not change
 *  it — it can only append what it found to notes (hard rule 3). */
export function markFeeScheduleVerified(
  db: AppDb,
  profileKey: string,
  track: FeeTrack,
  verifiedBy: string,
): FeeScheduleRecord | null {
  const existing = getFeeSchedule(db, profileKey, track);
  if (!existing) return null;
  const ts = nowIso();
  db.run(
    "UPDATE fee_schedules SET confidence = 'verified', verified_at = ?, verified_by = ?, updated_at = ? WHERE id = ?",
    [ts, clean(verifiedBy).slice(0, 120), ts, existing.id],
  );
  return getFeeSchedule(db, profileKey, track);
}

/** One-line human-readable rendering of a finding, for the notes trail. */
function findingSummary(finding: FeeScheduleFinding): string {
  const fees = finding.brackets.map((b) => `${b.label ? `${b.label}: ` : ""}$${b.feeUsd.toFixed(2)}`).join("; ");
  return [
    `basis ${finding.basis}`,
    fees ? `(${fees})` : "",
    finding.sourceUrl ? `[${finding.sourceUrl}]` : "",
    finding.sourceQuote ? `"${finding.sourceQuote.slice(0, 240)}"` : "",
  ].filter(Boolean).join(" ");
}

/** Store a finding as a 'seeded' schedule. Refuses (a) unsourced numbers and
 *  (b) any write over a human-verified row. Exported so an importer or an
 *  operator-entered schedule can use the same guard as research. */
export function saveFeeSchedule(
  db: AppDb,
  input: { state: string; ahj?: string; utility?: string; track: FeeTrack },
  finding: FeeScheduleFinding,
): FeeScheduleResearchOutcome {
  const track = input.track;
  const profileKey = feeScheduleProfileKey(input, track);
  const brackets = normalizeBrackets(finding.brackets || []);
  const sourceUrl = clean(finding.sourceUrl);
  const sourceQuote = clean(finding.sourceQuote);
  const base = { found: finding.found, profileKey, track, finding: { ...finding, brackets } };

  if (!finding.found) {
    return { ...base, reason: finding.reason || "Researcher reported no finding.", saved: false, refusedVerified: false, schedule: getFeeSchedule(db, profileKey, track) };
  }
  // A FEE WITH NO QUOTE IS A RUMOUR. Both halves are required: the URL says
  // where to go back and check, the sentence says what was actually read there.
  if (!sourceUrl || !sourceQuote) {
    const reason = `Refused: a fee needs both a source URL and the sentence it came from (url=${sourceUrl ? "yes" : "no"}, quote=${sourceQuote ? "yes" : "no"}).`;
    logger.warn("fees", "fee schedule refused — unsourced", { profileKey, track });
    return { ...base, found: false, reason, saved: false, refusedVerified: false, schedule: getFeeSchedule(db, profileKey, track) };
  }
  if (!brackets.length) {
    return { ...base, found: false, reason: "Refused: no usable fee line (every bracket lacked a finite, non-negative feeUsd).", saved: false, refusedVerified: false, schedule: getFeeSchedule(db, profileKey, track) };
  }

  const existing = getFeeSchedule(db, profileKey, track);
  const ts = nowIso();

  // HUMAN-VERIFIED IS NOT A STARTING POINT. Record what research found, in
  // notes, and change nothing else — a person compares and decides.
  if (existing && existing.confidence === "verified") {
    const segment = `Research ${ts.slice(0, 10)} (NOT applied — row is human-verified): ${findingSummary({ ...finding, brackets })}`;
    db.run("UPDATE fee_schedules SET notes = ?, updated_at = ? WHERE id = ?", [mergeNotes(existing.notes, [segment]), ts, existing.id]);
    logger.info("fees", "research refused against human-verified fee schedule", { profileKey, track });
    return { ...base, reason: "Row is human-verified — finding recorded in notes, schedule unchanged.", saved: false, refusedVerified: true, schedule: getFeeSchedule(db, profileKey, track) };
  }

  const notes = mergeNotes(existing?.notes, noteSegments(finding.notes));
  if (existing) {
    db.run(
      `UPDATE fee_schedules SET state = ?, ahj = ?, utility = ?, basis = ?, brackets_json = ?, notes = ?,
         source_url = ?, source_quote = ?, source_kind = ?, confidence = 'seeded', updated_at = ?
       WHERE id = ?`,
      [
        clean(input.state), clean(input.ahj), clean(input.utility), finding.basis,
        JSON.stringify(brackets), notes, sourceUrl, sourceQuote, clean(finding.sourceKind), ts, existing.id,
      ],
    );
  } else {
    db.run(
      `INSERT INTO fee_schedules
         (id, profile_key, state, ahj, utility, track, basis, brackets_json, notes,
          source_url, source_quote, source_kind, confidence, first_seen_at, updated_at, verified_at, verified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seeded', ?, ?, '', '')`,
      [
        id(), profileKey, clean(input.state), clean(input.ahj), clean(input.utility), track, finding.basis,
        JSON.stringify(brackets), notes, sourceUrl, sourceQuote, clean(finding.sourceKind), ts, ts,
      ],
    );
  }
  logger.info("fees", "fee schedule saved (seeded)", { profileKey, track, basis: finding.basis, brackets: brackets.length });
  return { ...base, reason: "", saved: true, refusedVerified: false, schedule: getFeeSchedule(db, profileKey, track) };
}

// ---------------------------------------------------------------------------
// The researcher
// ---------------------------------------------------------------------------

const FEE_RESEARCH_SYSTEM = `You research PUBLISHED FEE SCHEDULES for residential solar work and return them as structured data.

WHAT YOU ARE LOOKING FOR
A jurisdiction's fee schedule is a FUNCTION, not a price. Most AHJ schedules are long documents mostly about new construction; you want the SOLAR / PHOTOVOLTAIC / RENEWABLE-ENERGY line item specifically. Those lines are usually BRACKETED — a real example reads "Renewable energy for electrical systems - 5.01kva through 15kva", with further rows for larger systems. When a bracket table exists, extract EVERY row, not just the one you think applies: the permit application asks which bracket, so the table is the answer, and a single dollar amount is not.

Identify which variable the schedule keys on and say so in "basis":
  "system_kw"  — brackets keyed on system size in kVA/kW (use minKw/maxKw; kVA and kW are the same number on these schedules)
  "valuation"  — brackets keyed on job valuation / declared value (use minValuationUsd/maxValuationUsd)
  "flat"       — one charge regardless of size (a single bracket, no bounds)
  "other"      — anything else; explain in notes

SOURCES
Search the web. PREFER the jurisdiction's own domain (.gov / .us) or the utility's own site — the published fee schedule PDF or fee page. A third-party summary (solar blog, aggregator, permitting vendor) is acceptable ONLY as a last resort and ONLY if you set sourceKind "third_party" and say so in notes.

EVERY NUMBER NEEDS A QUOTE
"sourceQuote" must be the actual sentence or table row you read the fee from, copied verbatim. DO NOT GUESS A FEE. If you cannot find a quotable sentence, return found:false with a reason — an unsourced number is worse than no number, because it will be filed on a real application.

"NO FEE" IS AN ANSWER
Most residential net-metering / interconnection applications carry no utility fee. If the utility's own documentation says so, that is a REAL FINDING: return found:true, basis "flat", one bracket with feeUsd 0, and the sentence that says it. Some utilities do charge — Ameren Illinois, for example, charges a $50 Level 1 interconnection fee paid by mailed check — so check, do not assume. Return found:false ONLY when you genuinely could not determine it.

Return ONLY JSON:
{
  "found": true|false,
  "reason": "<when found:false, why — 'no published schedule located', 'fee page found but no solar line', etc.>",
  "basis": "system_kw|valuation|flat|other",
  "brackets": [
    { "minKw": 5.01, "maxKw": 15, "feeUsd": 175, "label": "<the schedule's OWN wording for this row, verbatim>" }
  ],
  "notes": "<short segments: what the schedule covers, whether it is combined building+electrical, plan-review percentages, anything a coordinator must know. Say plainly if this is a third-party source.>",
  "sourceUrl": "<the page/PDF the numbers came from>",
  "sourceQuote": "<the verbatim sentence or table row carrying the fee>",
  "sourceKind": "official|third_party"
}`;

function parseResearchJson(raw: string): Record<string, unknown> {
  try {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/);
    const parsed = JSON.parse(match ? match[1] : raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function emptyFinding(reason: string): FeeScheduleFinding {
  return { found: false, reason, basis: "other", brackets: [], notes: "", sourceUrl: "", sourceQuote: "", sourceKind: "" };
}

/** Default researcher: web-grounded Claude. Self-contained rather than routed
 *  through llm.ts because LLMProvider is the shared type surface and this build
 *  does not own it; the call mirrors askWithWebSearch (streamed, hard-timed-out
 *  so a stalled search can never hang a request). No API key → found:false with
 *  a reason, never a fabricated schedule. */
export const claudeFeeScheduleResearcher: FeeScheduleResearcher = async (input) => {
  const apiKey = sanitizeApiKey(process.env["ANTHROPIC_API_KEY"]);
  if (!apiKey) return emptyFinding("No ANTHROPIC_API_KEY configured — fee-schedule research is off. Enter the schedule by hand from the jurisdiction's fee page.");

  const who = input.track === "nem"
    ? `Utility: ${clean(input.utility) || "(unknown)"}`
    : `AHJ: ${clean(input.ahj) || "(unknown)"}`;
  const userMsg = [
    who,
    `State: ${clean(input.state)}`,
    input.track === "nem" && input.ahj ? `AHJ (context only): ${clean(input.ahj)}` : "",
    input.track === "permit" && input.utility ? `Utility (context only): ${clean(input.utility)}` : "",
    input.knownContext ? `\n${input.knownContext}` : "",
    "",
    input.track === "nem"
      ? "Find the published APPLICATION / INTERCONNECTION FEE for a residential net-metering (net energy metering) application to this utility. If there is none, say so with the sentence that says so."
      : "Find the published PERMIT FEE SCHEDULE line for a residential rooftop solar PV installation in this jurisdiction (building and/or electrical permit). Extract the full bracket table for the solar/renewable-energy line.",
  ].filter(Boolean).join("\n");

  const model = process.env.AUTOPILOT_LLM_MODEL || "claude-opus-5";
  const timeoutMs = Number(process.env.FEE_RESEARCH_TIMEOUT_MS) > 0 ? Number(process.env.FEE_RESEARCH_TIMEOUT_MS) : 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const client = new Anthropic({ apiKey, maxRetries: 3, timeout: 240000 });
    logger.debug("fees", "→ researchFeeSchedule", { model, track: input.track, state: input.state });
    const msg = await client.messages
      .stream(
        {
          model,
          max_tokens: 3000,
          thinking: { type: "adaptive" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }] as any,
          system: FEE_RESEARCH_SYSTEM,
          messages: [{ role: "user", content: userMsg }],
        },
        { signal: controller.signal },
      )
      .finalMessage();
    const raw = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
    const parsed = parseResearchJson(raw);
    const basisRaw = clean(parsed.basis).toLowerCase();
    const finding: FeeScheduleFinding = {
      found: parsed.found === true,
      reason: clean(parsed.reason),
      basis: (["system_kw", "valuation", "flat", "other"].includes(basisRaw) ? basisRaw : "other") as FeeBasis,
      brackets: Array.isArray(parsed.brackets) ? normalizeBrackets(parsed.brackets) : [],
      notes: clean(parsed.notes).slice(0, 2000),
      sourceUrl: clean(parsed.sourceUrl).slice(0, 500),
      sourceQuote: clean(parsed.sourceQuote).slice(0, 1000),
      sourceKind: clean(parsed.sourceKind).toLowerCase() === "official" ? "official" : clean(parsed.sourceKind) ? "third_party" : "",
    };
    if (!finding.found && !finding.reason) finding.reason = "Research returned no usable fee schedule.";
    return finding;
  } catch (err) {
    const reason = `Fee-schedule research failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn("fees", "researchFeeSchedule failed", { track: input.track, state: input.state });
    return emptyFinding(reason);
  } finally {
    clearTimeout(timer);
  }
};

/** Research this jurisdiction's/utility's published fee schedule and store it
 *  as a 'seeded' row. Always returns a structured outcome — a caller can tell
 *  "charges nothing" (found, flat $0) from "could not find out" (found:false),
 *  which the quote ladder's single "unknown" cannot. */
export async function researchFeeSchedule(
  db: AppDb,
  input: { state: string; ahj?: string; utility?: string; track?: string | null },
  options: { researcher?: FeeScheduleResearcher } = {},
): Promise<FeeScheduleResearchOutcome> {
  const track = feeTrack(input.track);
  const profileKey = feeScheduleProfileKey(input, track);
  const subject = track === "nem" ? clean(input.utility) : clean(input.ahj);
  if (!subject) {
    return {
      found: false, saved: false, refusedVerified: false, profileKey, track, schedule: null, finding: null,
      reason: track === "nem" ? "utility is required to research a NEM fee schedule." : "ahj is required to research a permit fee schedule.",
    };
  }
  // Seed the search with what the KB already holds — several permit_utility_knowledge
  // rows carry the AHJ's own fee-page URL in their notes, which is the page we want.
  let knownContext: string | undefined;
  try {
    knownContext = knowledgeResearchHint(db, { state: input.state, ahj: input.ahj, utility: input.utility }, track === "nem" ? "utility" : "ahj")?.text;
  } catch { /* non-fatal: research still runs unseeded */ }

  const researcher = options.researcher || claudeFeeScheduleResearcher;
  let finding: FeeScheduleFinding;
  try {
    finding = await researcher({ state: input.state, ahj: input.ahj, utility: input.utility, track, knownContext });
  } catch (err) {
    finding = emptyFinding(`Researcher threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  return saveFeeSchedule(db, { state: input.state, ahj: input.ahj, utility: input.utility, track }, finding);
}

// ---------------------------------------------------------------------------
// Resolving a stored schedule for a real project
// ---------------------------------------------------------------------------

/** Exact profile-key hit first, then a state-scoped fuzzy fallback over the same
 *  track — the same precedence knowledgeBase uses. Without the fallback a
 *  project filed as "Coos Bay" misses a schedule stored as "City Of Coos Bay",
 *  which is the headline case this exists for. */
export function findFeeScheduleForProject(
  db: AppDb,
  project: Pick<ProjectRecord, "state" | "ahj" | "utility">,
  track: FeeTrack,
): FeeScheduleRecord | null {
  const exact = getFeeSchedule(db, feeScheduleProfileKey(project, track), track);
  if (exact) return exact;

  const wanted = track === "nem" ? clean(project.utility) : clean(project.ahj);
  if (!wanted) return null;
  const state = clean(project.state).toUpperCase();
  const rows = db.query<Row>("SELECT * FROM fee_schedules WHERE track = ?", [track]);
  let best: { row: FeeScheduleRecord; score: number } | null = null;
  for (const row of rows) {
    const rec = mapSchedule(row);
    // State mismatch always loses: a like-named city in another state files
    // somewhere else entirely.
    const rowState = rec.state.trim().toUpperCase();
    if (state && rowState && rowState !== state) continue;
    const name = track === "nem" ? rec.utility : rec.ahj;
    const score = knowledgeNameMatchScore(wanted, name);
    if (score < 60) continue;
    if (!best || score > best.score) best = { row: rec, score };
  }
  return best ? best.row : null;
}

/** The system rating the kVA brackets are about. AC first: a schedule bracketed
 *  in kVA is rating the INVERTER output, not the array, and a 20 kW-DC job with
 *  15 kW-AC of inverters sits in a different bracket depending on which you
 *  read. DC is the fallback because it is the field most reliably populated. */
function systemRatingKw(project: Pick<ProjectRecord, "systemSizeAcKw" | "systemSizeDcKw">): { kw: number | null; which: string } {
  const ac = num(project.systemSizeAcKw);
  if (ac != null && ac > 0) return { kw: ac, which: "AC" };
  const dc = num(project.systemSizeDcKw);
  if (dc != null && dc > 0) return { kw: dc, which: "DC" };
  return { kw: null, which: "" };
}

/** First bracket whose bounds contain the value. Bounds are INCLUSIVE at both
 *  ends and an absent bound is open, which is how published schedules read
 *  ("5.01 through 15", then "15.01 through 25", then "25 and above"). */
function matchBracket(brackets: FeeBracket[], value: number, kind: "kw" | "valuation"): FeeBracket | null {
  for (const b of brackets) {
    const min = kind === "kw" ? b.minKw : b.minValuationUsd;
    const max = kind === "kw" ? b.maxKw : b.maxValuationUsd;
    if (min != null && value < min) continue;
    if (max != null && value > max) continue;
    return b;
  }
  return null;
}

function bracketLabelFor(b: FeeBracket, basis: FeeBasis): string {
  if (b.label) return b.label;
  if (basis === "system_kw" && (b.minKw != null || b.maxKw != null)) {
    return b.maxKw == null ? `${b.minKw ?? 0} kVA and above` : `${b.minKw ?? 0} through ${b.maxKw} kVA`;
  }
  if (basis === "valuation" && (b.minValuationUsd != null || b.maxValuationUsd != null)) {
    return b.maxValuationUsd == null ? `$${b.minValuationUsd ?? 0} and above` : `$${b.minValuationUsd ?? 0} – $${b.maxValuationUsd}`;
  }
  return "Flat fee";
}

/** Resolve a stored schedule to a NUMBER (and a bracket label) for THIS project.
 *  Returns null when no schedule is stored at all; returns a row with feeUsd
 *  null + a reason when a schedule exists but cannot be evaluated — so "we have
 *  no schedule" never reads as "the fee is zero". */
export function feeForProject(
  db: AppDb,
  project: Pick<ProjectRecord, "state" | "ahj" | "utility" | "systemSizeAcKw" | "systemSizeDcKw" | "parserSnapshot">,
  trackInput?: string | null,
): ProjectFeeResolution | null {
  const track = feeTrack(trackInput);
  const schedule = findFeeScheduleForProject(db, project, track);
  if (!schedule) return null;

  const base = {
    basis: schedule.basis,
    sourceUrl: schedule.sourceUrl,
    sourceQuote: schedule.sourceQuote,
    confidence: schedule.confidence,
    matchedName: track === "nem" ? schedule.utility : schedule.ahj,
    scheduleId: schedule.id,
  };
  const unresolved = (reason: string): ProjectFeeResolution => ({ ...base, feeUsd: null, bracketLabel: "", reason });

  if (!schedule.brackets.length) return unresolved("Schedule is stored but carries no fee lines.");

  if (schedule.basis === "flat" || (schedule.basis === "other" && schedule.brackets.length === 1)) {
    const b = schedule.brackets[0];
    return { ...base, feeUsd: b.feeUsd, bracketLabel: bracketLabelFor(b, schedule.basis), reason: "" };
  }

  if (schedule.basis === "system_kw") {
    const { kw, which } = systemRatingKw(project);
    if (kw == null) return unresolved("Schedule brackets on system size, but this project has no system size yet.");
    const b = matchBracket(schedule.brackets, kw, "kw");
    if (!b) return unresolved(`System size ${kw} kW (${which}) falls outside every published bracket — check the schedule for a row we missed.`);
    return { ...base, feeUsd: b.feeUsd, bracketLabel: bracketLabelFor(b, schedule.basis), reason: "" };
  }

  if (schedule.basis === "valuation") {
    const valuation = resolveValuation(project.parserSnapshot, project.systemSizeDcKw);
    if (valuation.value == null) return unresolved("Schedule brackets on job valuation, but this project has no valuation yet.");
    const b = matchBracket(schedule.brackets, valuation.value, "valuation");
    if (!b) return unresolved(`Valuation $${valuation.value.toLocaleString()} falls outside every published bracket.`);
    return { ...base, feeUsd: b.feeUsd, bracketLabel: bracketLabelFor(b, schedule.basis), reason: "" };
  }

  return unresolved(`Schedule basis "${schedule.basis}" needs a human to read it — see notes and the source quote.`);
}
