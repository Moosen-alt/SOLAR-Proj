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
import type { FeePaymentMethod, ProjectRecord } from "../../shared/src/types";
import { fetchPublicDocument } from "./documentFetch";
import type { FetchPublicDocumentOptions } from "./documentFetch";
import { DEFAULT_FEE_KEYWORDS, groupItemsIntoRows, extractPdfTextItems } from "./pdfTables";
import type { PdfTextRow } from "./pdfTables";
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
  /** HOW the money moves. 'mailed_check' is the load-bearing one: it says no portal
   *  can take this fee and a person has to post it (Ameren Illinois' $50 Level 1).
   *  Exactly submissionFees.ts's four values — anything else it silently drops. */
  paymentMethod: FeePaymentMethod;
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
  /** How the jurisdiction takes the money. Optional so every existing caller
   *  (imports, seed scripts, tests) keeps compiling; absent reads as "unknown". */
  paymentMethod?: string;
  /** RETRIEVAL PROVENANCE — set only by a researcher that fetched the document
   *  itself. `quoteVerified` means the stored sentence was found, character for
   *  character, in bytes this process retrieved: the difference between a quote
   *  and a paraphrase of a search result. Never a gate (a finding sourced from
   *  web search alone cannot be checked this way); always reported. */
  evidence?: FeeResearchEvidence[];
  quoteVerified?: boolean;
  /** True when the plain HTTP rung was refused and a real window got through. */
  neededBrowser?: boolean;
}

/** One document the researcher actually retrieved, and how. */
export interface FeeResearchEvidence {
  url: string;
  via: "http" | "browser";
  status: number;
  kind: "html" | "pdf" | "other";
  bytes: number;
  /** Rows/characters handed to the model from this document. */
  handed: number;
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

/** The optional second argument is the RETRIEVAL LEDGER: pass one in and the
 *  researcher records every document it opened into it, so a caller (a harvest
 *  script, a report) can see what was actually read rather than taking the
 *  finding's word for it. Optional so an injected test researcher stays a
 *  one-argument function. */
export type FeeScheduleResearcher = (
  input: FeeScheduleResearchInput,
  options?: { ledger?: FeeDocumentLedger },
) => Promise<FeeScheduleFinding>;

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
  paymentMethod: FeePaymentMethod;
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

/** submissionFees.ts whitelists EXACTLY these four and silently drops anything
 *  else, so a schedule that said "check" or "by mail" would arrive at the fee
 *  sheet as no answer at all. Normalise here, at the point the value is stored,
 *  rather than hoping the producer used the enum. */
export function normalizeFeePaymentMethod(value: unknown): FeePaymentMethod {
  const v = clean(value).toLowerCase().replace(/[\s\-/]+/g, "_");
  if (!v) return "unknown";
  if (/check|cheque|mail|post|money_order/.test(v)) return "mailed_check";
  if (/portal|online|website|web|card|credit|e_?pay|checkout/.test(v)) return "portal";
  if (/^(none|no_fee|no_charge|free|not_applicable|n_a|nothing)$/.test(v)) return "none";
  return "unknown";
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
    paymentMethod: normalizeFeePaymentMethod(row.payment_method),
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
  const method = normalizeFeePaymentMethod(finding.paymentMethod);
  return [
    `basis ${finding.basis}`,
    fees ? `(${fees})` : "",
    method === "unknown" ? "" : `paid: ${method}`,
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
  // A schedule that says nothing about payment does not erase what the row already
  // said: "unknown" is the absence of an answer, and an absence must never overwrite
  // an answer somebody found. Only a real method replaces a real method.
  const incomingMethod = normalizeFeePaymentMethod(finding.paymentMethod);
  const paymentMethod = incomingMethod === "unknown" ? (existing?.paymentMethod ?? "unknown") : incomingMethod;
  if (existing) {
    db.run(
      `UPDATE fee_schedules SET state = ?, ahj = ?, utility = ?, basis = ?, brackets_json = ?, notes = ?,
         payment_method = ?, source_url = ?, source_quote = ?, source_kind = ?, confidence = 'seeded', updated_at = ?
       WHERE id = ?`,
      [
        clean(input.state), clean(input.ahj), clean(input.utility), finding.basis,
        JSON.stringify(brackets), notes, paymentMethod, sourceUrl, sourceQuote, clean(finding.sourceKind), ts, existing.id,
      ],
    );
  } else {
    db.run(
      `INSERT INTO fee_schedules
         (id, profile_key, state, ahj, utility, track, basis, brackets_json, notes, payment_method,
          source_url, source_quote, source_kind, confidence, first_seen_at, updated_at, verified_at, verified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seeded', ?, ?, '', '')`,
      [
        id(), profileKey, clean(input.state), clean(input.ahj), clean(input.utility), track, finding.basis,
        JSON.stringify(brackets), notes, paymentMethod, sourceUrl, sourceQuote, clean(finding.sourceKind), ts, ts,
      ],
    );
  }
  logger.info("fees", "fee schedule saved (seeded)", { profileKey, track, basis: finding.basis, brackets: brackets.length });
  return { ...base, reason: "", saved: true, refusedVerified: false, schedule: getFeeSchedule(db, profileKey, track) };
}

// ---------------------------------------------------------------------------
// The researcher
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RETRIEVAL: the researcher's hands.
//
// The researcher used to have exactly one faculty — web search — and one way to
// fail: honestly. It reported found:false for the City of Coos Bay and gave a
// well-reasoned refusal; the operator then found the fee schedule in their
// browser in seconds. It was right that the document was hard to REACH and wrong
// about why. coosbayor.gov sits behind Akamai and returns 403 to every
// programmatic client — WebFetch, curl with a browser User-Agent, headless
// Playwright. A HEADED window gets 200, and the PDF fetched from inside that
// page context comes back 1.2 MB of application/pdf.
//
// And getting the bytes is only half of it. Read in text-stream order, that PDF
// pairs "Plan Review" with "65% of permit fee" where the printed row says
// "Structural Plan Review". Same stream, two different facts — and a fee
// attributed to the wrong line goes onto a customer's quote.
//
// So the model gets a tool that does both, and neither half is its job to get
// right: documentFetch.ts climbs from a plain GET to a real window when the far
// end refuses one, and pdfTables.ts hands back VISUAL ROWS grouped by baseline
// and ordered by x. What the model then quotes is a row a person would see.
//
// EVERY STRING THIS TOOL RETURNS IS KEPT (the ledger below). After the model
// answers, its quote is checked against those bytes. That check never refuses a
// finding — a fee found through web search alone cannot be checked this way, and
// silently dropping it would be worse than reporting it unchecked — but a stored
// quote that was never in anything we retrieved is exactly the shape a
// hallucinated fee has, and the notes say so in as many words.
// ---------------------------------------------------------------------------

/** The retrieval trail for one research pass: what came back, and the text of it. */
export interface FeeDocumentLedger {
  evidence: FeeResearchEvidence[];
  /** Exactly the strings handed to the model, for the quote check. */
  corpus: string[];
}

export function newFeeDocumentLedger(): FeeDocumentLedger {
  return { evidence: [], corpus: [] };
}

const OPEN_DOCUMENT_TOOL = {
  name: "open_document",
  description:
    "Retrieve a PUBLIC web page or PDF and read it. Escalates to a real browser window by itself when a site "
    + "refuses an ordinary HTTP client (many .gov sites sit behind a WAF that 403s every script), so a 403 from "
    + "your own knowledge of a site is not a reason to skip it — try it here. A PDF comes back as VISUAL ROWS: "
    + "cells that share a printed line, left to right, joined with ' | '. That pairing is read from the glyph "
    + "coordinates, NOT from the PDF's text order, so the row you see is the row that is printed. An HTML page "
    + "comes back as its links (to follow into a document search) plus its text. Never authenticates and never "
    + "solves a CAPTCHA.",
  input_schema: {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "Absolute http(s) URL of the page or PDF." },
      find: {
        type: "string",
        description:
          "Case-insensitive filter. On a PDF, only rows containing it (plus a line of context either side) are "
          + "returned; omit it and the solar/renewable/kVA rows are returned. On an HTML page it filters the links "
          + "and text lines. Use it to find the fee table in a 60-page schedule.",
      },
      pages: {
        type: "array",
        items: { type: "integer" },
        description: "PDF only: 1-based page numbers to return IN FULL, as printed in a PDF reader. Use this once "
          + "`find` has told you which page the fee table is on, to read the whole table including its header rows.",
      },
    },
    required: ["url"],
  },
};

/** Rows/links/text are capped so one 60-page schedule cannot eat the context
 *  window (and the budget) that the other five jurisdictions need. */
const DOC_MAX_ROWS = 220;
const DOC_MAX_ROW_CHARS = 300;
const DOC_MAX_LINKS = 70;
const DOC_MAX_TEXT_CHARS = 3500;
const DOC_MAX_PDF_PAGES = 80;

const looksLikePdf = (doc: { contentType: string; bytes?: Uint8Array }): boolean => {
  if (/pdf/i.test(doc.contentType)) return true;
  const b = doc.bytes;
  return !!b && b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
};

const rowText = (row: PdfTextRow): string => `p${row.page}  ${row.cells.join(" | ")}`.slice(0, DOC_MAX_ROW_CHARS);

/** Rows matching the filter, each with one line of context either side, so a
 *  bracket row is never read without the "Renewable Energy" heading above it. */
function selectRows(rows: PdfTextRow[], pages: number[], find: string): { picked: PdfTextRow[]; how: string } {
  const ordered = [...rows].sort((a, b) => a.page - b.page || b.y - a.y);
  if (pages.length) {
    const want = new Set(pages);
    return { picked: ordered.filter((r) => want.has(r.page)), how: `every row on page(s) ${pages.join(", ")}` };
  }
  const needles = find ? [find.toLowerCase()] : DEFAULT_FEE_KEYWORDS;
  const hit = (r: PdfTextRow): boolean => {
    const hay = r.cells.join(" ").toLowerCase();
    return needles.some((k) => hay.includes(k));
  };
  const keep = new Set<number>();
  ordered.forEach((r, i) => {
    if (!hit(r)) return;
    for (let j = Math.max(0, i - 1); j <= Math.min(ordered.length - 1, i + 1); j++) keep.add(j);
  });
  return {
    picked: ordered.filter((_r, i) => keep.has(i)),
    how: find
      ? `rows containing "${find}" (with one line of context either side)`
      : `rows mentioning ${DEFAULT_FEE_KEYWORDS.join("/")} (with one line of context either side)`,
  };
}

function renderHtml(html: string, base: string, find: string): { body: string; handed: number } {
  const lines: string[] = [];
  let text = html;
  let links: Array<{ text: string; href: string }> = [];
  try {
    // Regex rather than cheerio on purpose: this runs inside a tool call on an
    // arbitrary government page, and a parser failure must degrade to "here is
    // the text" rather than lose the whole retrieval.
    const anchors = html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
    for (const m of anchors) {
      const raw = m[1].trim();
      if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel):/i.test(raw)) continue;
      let href: string;
      try { href = new URL(raw, base).toString(); } catch { continue; }
      const label = clean(m[2].replace(/<[^>]*>/g, " "));
      if (!label) continue;
      links.push({ text: label, href });
    }
    text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, "\n");
  } catch { /* fall through with whatever we have */ }

  const needle = find.toLowerCase();
  if (needle) links = links.filter((l) => l.text.toLowerCase().includes(needle) || l.href.toLowerCase().includes(needle));
  const seen = new Set<string>();
  const uniq = links.filter((l) => (seen.has(l.href) ? false : (seen.add(l.href), true))).slice(0, DOC_MAX_LINKS);

  const textLines = text.split("\n").map((l) => clean(l)).filter(Boolean);
  const picked = needle ? textLines.filter((l) => l.toLowerCase().includes(needle)) : textLines;

  lines.push(`LINKS (${uniq.length}${links.length > uniq.length ? ` of ${links.length}` : ""}):`);
  for (const l of uniq) lines.push(`  ${l.text}  ->  ${l.href}`);
  lines.push("");
  lines.push("TEXT:");
  let budget = DOC_MAX_TEXT_CHARS;
  for (const l of picked) {
    if (budget <= 0) { lines.push("  … (truncated)"); break; }
    lines.push(`  ${l.slice(0, budget)}`);
    budget -= l.length + 1;
  }
  const body = lines.join("\n");
  return { body, handed: uniq.length + picked.length };
}

/** The tool handler. Never throws: a tool that throws ends the loop, and a
 *  jurisdiction we could not retrieve is a REASON, not a crash. */
export async function openFeeDocument(
  args: { url?: unknown; find?: unknown; pages?: unknown },
  ledger: FeeDocumentLedger,
  opts: FetchPublicDocumentOptions = {},
): Promise<string> {
  const url = clean(args.url);
  if (!url) return "No url was given. Call open_document with an absolute http(s) URL.";
  const find = clean(args.find);
  const pages = Array.isArray(args.pages)
    ? args.pages.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p >= 1).slice(0, 8)
    : [];

  let doc: Awaited<ReturnType<typeof fetchPublicDocument>>;
  try {
    doc = await fetchPublicDocument(url, opts);
  } catch (err) {
    return `Could not retrieve ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!doc.ok || !doc.bytes) {
    // The reason names what blocked us — status, Server header, whether a real
    // window was tried. That is a fact about this jurisdiction worth reporting
    // in notes, so it goes to the model rather than being flattened to "failed".
    return `Could not retrieve ${url}. ${doc.reason}`;
  }

  const head = `${url}\nHTTP ${doc.status} via ${doc.via}${doc.via === "browser" ? " (a real window — the plain HTTP client was refused)" : ""}`
    + ` — ${doc.bytes.length} bytes of ${doc.contentType || "unknown type"}${doc.finalUrl && doc.finalUrl !== url ? `\nfinal URL: ${doc.finalUrl}` : ""}`;

  const record = (kind: FeeResearchEvidence["kind"], handed: number, body: string): string => {
    ledger.evidence.push({ url: doc.finalUrl || url, via: doc.via, status: doc.status, kind, bytes: doc.bytes?.length ?? 0, handed });
    ledger.corpus.push(body);
    return `${head}\n\n${body}`;
  };

  if (looksLikePdf(doc)) {
    let rows: PdfTextRow[];
    try {
      const items = await extractPdfTextItems(doc.bytes, { maxPages: DOC_MAX_PDF_PAGES });
      rows = groupItemsIntoRows(items);
    } catch (err) {
      return `${head}\n\nThis is a PDF but it could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
    const pageCount = rows.reduce((max, r) => Math.max(max, r.page), 0);
    const { picked, how } = selectRows(rows, pages, find);
    const shown = picked.slice(0, DOC_MAX_ROWS);
    const body = [
      `${pageCount} page(s). Rows are read BY COORDINATE — cells sharing a printed line, left to right, joined " | ".`,
      `Showing ${shown.length}${picked.length > shown.length ? ` of ${picked.length}` : ""}: ${how}.`,
      picked.length ? "" : "Nothing matched. Try a different `find`, or ask for a page in full with `pages`.",
      ...shown.map(rowText),
    ].filter((l) => l !== undefined).join("\n");
    return record("pdf", shown.length, body);
  }

  if (doc.text != null) {
    const { body, handed } = renderHtml(doc.text, doc.finalUrl || url, find);
    return record("html", handed, body);
  }

  return record("other", 0, "Retrieved, but it is neither HTML nor a PDF, so there is nothing to read here.");
}

// ---------------------------------------------------------------------------
// Did the quote come from anything we actually read?
// ---------------------------------------------------------------------------

/** Fold away the differences that make two renderings of the SAME printed row
 *  look different: the en-dash a fee schedule prints where a model types a
 *  hyphen, the "$" and thousands separators, runs of white space. */
function matchKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[$,]/g, "")
    .replace(/[^a-z0-9.%'"()+/\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface QuoteSupport {
  /** A fragment of the quote, 15+ characters, found verbatim in retrieved bytes. */
  quoteVerified: boolean;
  /** Every bracket's fee appears in retrieved bytes. */
  feesVerified: boolean;
  /** Nothing was retrieved this run — the check could not be made either way. */
  noEvidence: boolean;
  matchedFragment: string;
  missingFees: number[];
}

/** Check a finding against the bytes this run actually retrieved.
 *
 *  ADVISORY, NEVER A GATE. A fee read off a page our fetcher never opened (web
 *  search returns its results encrypted, so they are unreadable here) is not
 *  thereby wrong — refusing it would lose real findings. But "the quote is not
 *  in anything we read" is the exact signature of an invented one, so it is
 *  reported every time, in the notes that travel with the row. */
export function checkQuoteSupport(finding: FeeScheduleFinding, ledger: FeeDocumentLedger): QuoteSupport {
  const corpus = ledger.corpus.map(matchKey).join("\n");
  const out: QuoteSupport = {
    quoteVerified: false, feesVerified: false, noEvidence: corpus.length === 0,
    matchedFragment: "", missingFees: [],
  };
  if (!corpus) return out;

  // Fragments, not the whole sentence: a good quote legitimately staples a row
  // to its heading, or appends "[Exhibit A, p.8]". One 15-character run that is
  // verbatim in the document is what distinguishes reading from paraphrasing.
  const fragments = String(finding.sourceQuote || "")
    .split(/\s*\|\s*|\s{2,}|[[\]]|(?<=\.)\s+/)
    .map(matchKey)
    .filter((f) => f.length >= 15)
    .sort((a, b) => b.length - a.length);
  for (const f of fragments) {
    if (corpus.includes(f)) { out.quoteVerified = true; out.matchedFragment = f.slice(0, 160); break; }
  }

  const missing = (finding.brackets || []).filter((b) => {
    const plain = matchKey(String(b.feeUsd));
    const exact = matchKey(b.feeUsd.toFixed(2));
    return !corpus.includes(plain) && !corpus.includes(exact);
  });
  out.missingFees = missing.map((b) => b.feeUsd);
  out.feesVerified = missing.length === 0;
  return out;
}

/** The note segments that carry the retrieval trail onto the stored row. */
export function retrievalNotes(finding: FeeScheduleFinding, ledger: FeeDocumentLedger, support: QuoteSupport): string[] {
  const out: string[] = [];
  if (!ledger.evidence.length) {
    out.push("RETRIEVAL: no document was opened this run — the finding rests on web search alone, and its quote could not be checked against any bytes we read.");
    return out;
  }
  const viaBrowser = ledger.evidence.filter((e) => e.via === "browser");
  out.push(
    `RETRIEVAL: read ${ledger.evidence.length} document(s) directly`
    + `${viaBrowser.length ? `, ${viaBrowser.length} of them through a headed browser because the site refused an ordinary HTTP client` : ""}`
    + ` — ${ledger.evidence.map((e) => `${e.kind} ${e.status} ${e.url}`).join("; ")}`.slice(0, 600),
  );
  if (ledger.evidence.some((e) => e.kind === "pdf")) {
    out.push("PDF rows were paired BY COORDINATE (same printed line, left to right), not in the PDF's text order.");
  }
  out.push(
    support.quoteVerified
      ? `Quote verified: "${support.matchedFragment}" appears verbatim in the retrieved document.`
      : "QUOTE NOT VERIFIED: no 15-character run of the stored quote appears in anything this run retrieved. Check it against the source before quoting a customer.",
  );
  if (!support.feesVerified && support.missingFees.length) {
    out.push(`FEE NOT FOUND IN THE RETRIEVED TEXT: ${support.missingFees.map((f) => `$${f}`).join(", ")} — the amount does not appear in the document we read.`);
  }
  return out;
}

const FEE_RESEARCH_SYSTEM = `You research PUBLISHED FEE SCHEDULES for residential solar work and return them as structured data.

WHAT YOU ARE LOOKING FOR
A jurisdiction's fee schedule is a FUNCTION, not a price. Most AHJ schedules are long documents mostly about new construction; you want the SOLAR / PHOTOVOLTAIC / RENEWABLE-ENERGY line item specifically. Those lines are usually BRACKETED — a real example reads "Renewable energy for electrical systems - 5.01kva through 15kva", with further rows for larger systems. When a bracket table exists, extract EVERY row, not just the one you think applies: the permit application asks which bracket, so the table is the answer, and a single dollar amount is not.

Identify which variable the schedule keys on and say so in "basis":
  "system_kw"  — brackets keyed on system size in kVA/kW (use minKw/maxKw; kVA and kW are the same number on these schedules)
  "valuation"  — brackets keyed on job valuation / declared value (use minValuationUsd/maxValuationUsd)
  "flat"       — one charge regardless of size (a single bracket, no bounds)
  "other"      — anything else; explain in notes

HOW TO WORK: SEARCH FINDS THE DOOR, open_document WALKS THROUGH IT
Use web_search to LOCATE the jurisdiction's fee page, document search or schedule PDF. Then use open_document to READ it. A search snippet is a lead, not a source: snippets and third-party summaries routinely staple a fee to the wrong line of a table. One real case — a summary of a county electrical schedule reported $346 and $796 for two solar brackets, because it had taken the amounts off the WIND GENERATION rows printed below them. The published numbers were $160 and $265. Only the document says which row a number is on.

open_document climbs to a real browser window by itself when a site refuses an ordinary HTTP client, so DO NOT give up on a .gov page because it seems to block automation — try it. It reads PDF tables BY COORDINATE, returning the cells that share a printed line joined with " | ", which is the same pairing your eye makes and is NOT the order the text sits in the file.

A GOOD SEQUENCE: search → open_document on the fee page (read its links) → open_document on the schedule PDF with find:"solar" or find:"renewable" to locate the table → open_document again with pages:[N] to read that whole page, headings included → quote the row.

SUPERSESSION: fee schedules are dated and replaced. When you find one, check whether a NEWER schedule exists (search the fee page for a later effective date) and say in notes which document you used and why. A permit-application FORM often carries fees years out of date; the adopted schedule wins.

EVERY NUMBER NEEDS A QUOTE, AND THE QUOTE MUST BE A ROW YOU READ
"sourceQuote" must be the actual table row or sentence carrying the fee, copied verbatim. Where open_document returned a row, quote that row's text exactly as it came back to you — including its " | " separator between the description and the amount — and name the document and page after it in square brackets. What you read is checked against the bytes we retrieved, so a paraphrase is visibly worse than a copy. DO NOT GUESS A FEE. If you cannot find a quotable sentence, return found:false with a reason — an unsourced number is worse than no number, because it will be filed on a real application.

SOURCES
PREFER the jurisdiction's own domain (.gov / .us) or the utility's own site — the published fee schedule PDF or fee page. A state rule or commission order (e.g. an OAR on oregon.gov) is official too, and is the right source for "the utility may not charge for this": say in notes whose domain it is. A third-party summary (solar blog, aggregator, permitting vendor) is acceptable ONLY as a last resort and ONLY if you set sourceKind "third_party" and say so in notes.

HOW IT IS PAID IS PART OF THE FEE
Set "paymentMethod" to how the money actually moves: "portal" (paid online at the portal's own checkout), "mailed_check" (a paper check is posted — there is no online payment), "none" (there is no fee to pay), or "unknown" if the source does not say. This matters more than it looks: Ameren Illinois' $50 Level 1 fee is paid BY MAILED CHECK within 15 business days and the application is not reviewed until the check arrives, so an operator who believes it is payable in the portal has a filing that silently stalls. Say so in notes too, with the deadline if the source states one.

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
  "notes": "<short segments: what the schedule covers, whether it is combined building+electrical, plan-review percentages, which document and effective date you used and whether a newer one exists, anything a coordinator must know. Say plainly if this is a third-party source.>",
  "paymentMethod": "portal|mailed_check|none|unknown",
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

/** How many times the model may call open_document in one pass. A fee page, the
 *  schedule PDF, a find, a page-in-full and a supersession check is five; ten
 *  leaves room to follow a wrong link and come back. */
export const FEE_RESEARCH_MAX_DOCUMENTS = 10;
/** Assistant turns. Each turn may carry several tool calls, so this is not the
 *  same ceiling as the one above. */
const FEE_RESEARCH_MAX_TURNS = 12;

/** The SDK client's own ceiling, below. The outer AbortController must never be the
 *  tighter of the two, or the client's timeout and its retries are unreachable. */
export const FEE_RESEARCH_CLIENT_TIMEOUT_MS = 240000;

/** How long one research call may run before it is abandoned.
 *
 *  A WEB-GROUNDED SEARCH IS NOT A CHAT TURN. This call reads fee pages and PDFs across up to
 *  six searches; measured live against the four jurisdictions we actually file in, it took
 *  62s, 66s, 82s and 69s. The previous 60s ceiling therefore aborted EVERY real call — and an
 *  abort comes back as found:false with a reason, which is the same channel a jurisdiction
 *  that publishes nothing comes back on. So automatic fee research was off by default and
 *  said nothing about it: the fee sheet simply reported no schedule, for every jurisdiction,
 *  forever.
 *
 *  Exported so the default itself is testable — the failure was a CONSTANT, and a constant
 *  nothing asserts is a constant that regresses. */
export function feeResearchTimeoutMs(): number {
  const configured = Number(process.env.FEE_RESEARCH_TIMEOUT_MS);
  return configured > 0 ? configured : FEE_RESEARCH_CLIENT_TIMEOUT_MS;
}

/** Default researcher: web-grounded Claude. Self-contained rather than routed
 *  through llm.ts because LLMProvider is the shared type surface and this build
 *  does not own it; the call mirrors askWithWebSearch (streamed, hard-timed-out
 *  so a stalled search can never hang a request). No API key → found:false with
 *  a reason, never a fabricated schedule. */
export const claudeFeeScheduleResearcher: FeeScheduleResearcher = async (input, options) => {
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
  const timeoutMs = feeResearchTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;
  // ONE DEADLINE FOR THE WHOLE PASS, not per call. The loop below may take five
  // turns and open ten documents; a per-call clock would let a pass that keeps
  // making progress run without any ceiling at all.
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const ledger = options?.ledger ?? newFeeDocumentLedger();
  try {
    const client = new Anthropic({ apiKey, maxRetries: 3, timeout: FEE_RESEARCH_CLIENT_TIMEOUT_MS });
    logger.debug("fees", "→ researchFeeSchedule", { model, track: input.track, state: input.state });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = [{ role: "user", content: userMsg }];
    let raw = "";
    let opened = 0;
    let exhausted = "";

    for (let turn = 0; turn < FEE_RESEARCH_MAX_TURNS; turn++) {
      if (Date.now() >= deadline) { timedOut = true; controller.abort(); break; }
      const msg = await client.messages
        .stream(
          {
            model,
            max_tokens: 4000,
            thinking: { type: "adaptive" },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }, OPEN_DOCUMENT_TOOL] as any,
            system: FEE_RESEARCH_SYSTEM,
            messages,
          },
          { signal: controller.signal },
        )
        .finalMessage();

      const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      if (text.trim()) raw = text;
      // The assistant turn goes back VERBATIM — thinking blocks, server-side
      // web_search results and all. Reconstructing it would drop the search
      // results the model is reasoning from.
      messages.push({ role: "assistant", content: msg.content });

      const calls = msg.content.filter(
        (b) => b.type === "tool_use" && (b as { name?: string }).name === OPEN_DOCUMENT_TOOL.name,
      ) as Array<{ id: string; input: Record<string, unknown> }>;
      if (!calls.length) break;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results: any[] = [];
      for (const call of calls) {
        if (opened >= FEE_RESEARCH_MAX_DOCUMENTS) {
          exhausted = `the ${FEE_RESEARCH_MAX_DOCUMENTS}-document budget for one research pass`;
          results.push({ type: "tool_result", tool_use_id: call.id, content: `Document budget spent (${FEE_RESEARCH_MAX_DOCUMENTS} retrievals). Answer now from what you have read, or return found:false saying what you would have needed to open.` });
          continue;
        }
        if (Date.now() >= deadline) { timedOut = true; controller.abort(); break; }
        opened++;
        const body = await openFeeDocument(call.input || {}, ledger, { timeoutMs: 25_000 });
        results.push({ type: "tool_result", tool_use_id: call.id, content: body.slice(0, 60_000) });
      }
      if (timedOut) break;
      messages.push({ role: "user", content: results });
      if (turn === FEE_RESEARCH_MAX_TURNS - 1) exhausted = `the ${FEE_RESEARCH_MAX_TURNS}-turn ceiling for one research pass`;
    }
    if (timedOut) throw new Error("aborted");

    const parsed = parseResearchJson(raw);
    const basisRaw = clean(parsed.basis).toLowerCase();
    const finding: FeeScheduleFinding = {
      found: parsed.found === true,
      reason: clean(parsed.reason),
      basis: (["system_kw", "valuation", "flat", "other"].includes(basisRaw) ? basisRaw : "other") as FeeBasis,
      brackets: Array.isArray(parsed.brackets) ? normalizeBrackets(parsed.brackets) : [],
      notes: clean(parsed.notes).slice(0, 2000),
      paymentMethod: normalizeFeePaymentMethod(parsed.paymentMethod),
      sourceUrl: clean(parsed.sourceUrl).slice(0, 500),
      sourceQuote: clean(parsed.sourceQuote).slice(0, 1000),
      sourceKind: clean(parsed.sourceKind).toLowerCase() === "official" ? "official" : clean(parsed.sourceKind) ? "third_party" : "",
      evidence: ledger.evidence,
      neededBrowser: ledger.evidence.some((e) => e.via === "browser"),
    };
    // The check runs on every finding, saved or not, and its verdict travels in
    // the notes — a row whose quote nothing we read supports must say so where
    // the person reading the fee sheet will see it.
    const support = checkQuoteSupport(finding, ledger);
    finding.quoteVerified = support.quoteVerified;
    if (finding.found) {
      finding.notes = mergeNotes(finding.notes, retrievalNotes(finding, ledger, support));
    }
    if (!finding.found && !finding.reason) {
      finding.reason = exhausted
        ? `Research ran out of room — it hit ${exhausted} before producing an answer. Re-run, or enter the schedule by hand from the jurisdiction's fee page.`
        : "Research returned no usable fee schedule.";
    }
    return finding;
  } catch (err) {
    // SAY WHICH FAILURE THIS WAS. A timeout surfaced as the SDK's bare "Request was aborted."
    // is the worst possible wording here: found:false already means "we could not find out",
    // and the fee sheet renders that beside the jurisdiction as though nothing is published.
    // Name the ceiling and the knob, so a run that ran out of clock cannot be mistaken for a
    // jurisdiction that charges nothing.
    const reason = timedOut
      ? `Fee-schedule research timed out after ${Math.round(timeoutMs / 1000)}s — this is a RUN that ran out of clock, NOT a finding that ${input.track === "nem" ? "this utility" : "this jurisdiction"} publishes no fee. Re-run, or raise FEE_RESEARCH_TIMEOUT_MS.`
      : `Fee-schedule research failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn("fees", "researchFeeSchedule failed", { track: input.track, state: input.state, timedOut, documentsRead: ledger.evidence.length });
    // The retrieval trail survives the failure: "we were refused by the site" and
    // "we read the schedule and then the model fell over" are different problems,
    // and only the evidence list tells them apart.
    return { ...emptyFinding(reason), evidence: ledger.evidence, neededBrowser: ledger.evidence.some((e) => e.via === "browser") };
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
  options: { researcher?: FeeScheduleResearcher; ledger?: FeeDocumentLedger } = {},
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
    finding = await researcher({ state: input.state, ahj: input.ahj, utility: input.utility, track, knownContext }, { ledger: options.ledger });
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

/** THE ONE EVALUATOR. Both public entry points below route through this, so the
 *  bracket boundary can only ever be decided in one place — two parallel
 *  evaluations would drift, and the boundary is the whole point of the table. */
function evaluateSchedule(
  schedule: FeeScheduleRecord,
  inputs: { kw: number | null; kwSource: string; valuationUsd: number | null },
): { feeUsd: number | null; bracketLabel: string; reason: string } {
  const miss = (reason: string) => ({ feeUsd: null, bracketLabel: "", reason });
  const hit = (b: FeeBracket) => ({ feeUsd: b.feeUsd, bracketLabel: bracketLabelFor(b, schedule.basis), reason: "" });

  if (!schedule.brackets.length) return miss("Schedule is stored but carries no fee lines.");

  if (schedule.basis === "flat" || (schedule.basis === "other" && schedule.brackets.length === 1)) {
    return hit(schedule.brackets[0]);
  }

  if (schedule.basis === "system_kw") {
    if (inputs.kw == null) return miss("Schedule brackets on system size, but this project has no system size yet.");
    const b = matchBracket(schedule.brackets, inputs.kw, "kw");
    if (!b) return miss(`System size ${inputs.kw} kW (${inputs.kwSource || "rated"}) falls outside every published bracket — check the schedule for a row we missed.`);
    return hit(b);
  }

  if (schedule.basis === "valuation") {
    if (inputs.valuationUsd == null) return miss("Schedule brackets on job valuation, but this project has no valuation yet.");
    const b = matchBracket(schedule.brackets, inputs.valuationUsd, "valuation");
    if (!b) return miss(`Valuation $${inputs.valuationUsd.toLocaleString()} falls outside every published bracket.`);
    return hit(b);
  }

  return miss(`Schedule basis "${schedule.basis}" needs a human to read it — see notes and the source quote.`);
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

  const { kw, which } = systemRatingKw(project);
  // Only pay for the valuation walk when the schedule actually keys on it.
  const valuationUsd = schedule.basis === "valuation"
    ? resolveValuation(project.parserSnapshot, project.systemSizeDcKw).value
    : null;
  const evaluated = evaluateSchedule(schedule, { kw, kwSource: which, valuationUsd });

  return {
    ...evaluated,
    basis: schedule.basis,
    paymentMethod: schedule.paymentMethod,
    sourceUrl: schedule.sourceUrl,
    sourceQuote: schedule.sourceQuote,
    confidence: schedule.confidence,
    matchedName: track === "nem" ? schedule.utility : schedule.ahj,
    scheduleId: schedule.id,
  };
}

// ---------------------------------------------------------------------------
// Seam: the quote ladder's "published_schedule" tier
//
// submissionFees.ts loads this module by name and looks for exactly this export
// (`mod?.lookupPublishedFee`). A MISSING export there is SILENT — its loader
// warns only on a require error, so a rename here would make the whole tier
// quietly vanish and every quote fall back to guessing 1.5% of valuation. Keep
// the name.
//
// Deliberately typed against LOCAL structural interfaces rather than the shared
// PublishedFeeLookupInput/Result: the consumer owns those, they are still in
// flight, and this module must keep compiling if they move. Its loader
// duck-types the function and its normalizer whitelists every field of the
// result, so nothing is lost by staying structural.
// ---------------------------------------------------------------------------

export interface PublishedFeeLookupArgs {
  track: string;
  state: string;
  ahj: string;
  utility: string;
  /** The size to bracket on, pre-computed by the caller (AC-first, as the kVA
   *  brackets intend). Falls back to the AC/DC fields when absent. */
  bracketKw?: number | null;
  systemSizeAcKw?: number | null;
  systemSizeDcKw?: number | null;
  /** Pre-resolved job valuation — this seam gets no parser snapshot, so a
   *  valuation-keyed schedule is unresolvable without it (and says so). */
  valuationUsd?: number | null;
}

export interface PublishedFeeLookupResult {
  feeUsd: number | null;
  bracketLabel: string | null;
  sourceUrl: string | null;
  /** The quote is read by the consumer's MAILED_CHECK_RE as a last resort, so it
   *  travels with the amount even when paymentMethod is explicit. */
  sourceQuote: string;
  /** 'portal' | 'mailed_check' | 'none' | 'unknown' — the consumer whitelists
   *  exactly these and drops anything else, which is why this is normalised on
   *  the way into the table rather than here. */
  paymentMethod: FeePaymentMethod;
  confidence: FeeConfidence;
  /** A HUMAN one-liner for the quote screen, not the basis enum. */
  basis: string;
  /** The schedule's own name for the jurisdiction — may be the legal name where
   *  the project carries an operator short name. */
  jurisdictionName: string;
}

/** Look up the published schedule for a project and evaluate it. Returns null
 *  when no schedule is stored; `feeUsd: null` when one is stored but cannot be
 *  evaluated for this project. Never throws at the caller — it runs inside the
 *  staging gate, where a thrown error would block a submission. */
export function lookupPublishedFee(db: AppDb, input: PublishedFeeLookupArgs): PublishedFeeLookupResult | null {
  try {
    const track = feeTrack(input.track);
    const schedule = findFeeScheduleForProject(db, { state: input.state, ahj: input.ahj, utility: input.utility }, track);
    if (!schedule) return null;

    const kw = num(input.bracketKw) ?? num(input.systemSizeAcKw) ?? num(input.systemSizeDcKw);
    const evaluated = evaluateSchedule(schedule, {
      kw: kw != null && kw > 0 ? kw : null,
      kwSource: input.bracketKw != null ? "bracket" : "AC/DC",
      valuationUsd: num(input.valuationUsd),
    });
    const jurisdictionName = track === "nem" ? schedule.utility : schedule.ahj;
    return {
      feeUsd: evaluated.feeUsd,
      bracketLabel: evaluated.bracketLabel || null,
      sourceUrl: schedule.sourceUrl || null,
      sourceQuote: schedule.sourceQuote,
      paymentMethod: schedule.paymentMethod,
      confidence: schedule.confidence,
      basis: evaluated.feeUsd == null
        ? evaluated.reason
        : `Published fee schedule${jurisdictionName ? ` (${jurisdictionName})` : ""}${evaluated.bracketLabel ? `: ${evaluated.bracketLabel}` : ""}`,
      jurisdictionName,
    };
  } catch (err) {
    logger.warn("fees", "lookupPublishedFee failed — falling through the quote ladder", { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
