// ---------------------------------------------------------------------------
// ONE PASS OVER A JURISDICTION'S DOCUMENT PAGE — THE FORMS **AND** THE FEES.
//
// The operator's observation, verbatim: "[the jurisdiction document page] is also a good place
// to see applications we can pull for the auto document fill out stuff and building AHJ docs
// phase. Often times applications have the fee structure on them as well so can get that info
// sometimes at the same place you're grabbing the building apps from."
//
// Proven on Coos County. ONE page — https://co.coos.or.us/solar-installations — carries the
// electrical permit application, the structural permit application and the prescriptive
// rooftop PV checklist; and the electrical application ITSELF prints the renewable-energy fee
// table on page 1 ("5 kva or less $79.00 | 5.01 kva to 15 kva $94.00 | 15.01 kva to 25 kva
// $156.00", Revised 12/23/2022). Two separate research passes were being paid for — one to
// find blank forms, one to find a fee schedule — against the same page, and often the same
// PDF. This module downloads each document ONCE and reads it TWICE: as a form to be mapped,
// and as a fee table to be quoted.
//
// THE PART THAT IS NOT A CONVENIENCE: CONFLICT.
//
// Coos County publishes both an ADOPTED fee schedule (effective 7-1-25: $135 / $160 / $265)
// and, on its own solar page, an application form still carrying 2022 fees ($79 / $94 / $156,
// "Revised 12/23/2022") — uniformly 1.70x apart, which is the fingerprint of a blanket
// increase rather than two different fee types. A harvester that just stored whatever it read
// last would overwrite the adopted numbers with three-year-old ones, and nothing downstream
// would ever know. So when two sources for the same (jurisdiction, track) disagree on a
// bracket this module stores BOTH candidates, marks the schedule conflicted, and arranges for
// feeForProject to REFUSE TO ANSWER. A fee with two candidate values is a question for a
// human, not an answer for a quote.
//
// HOW THE REFUSAL IS ACHIEVED WITHOUT OWNING feeSchedules.ts. That module's one evaluator
// already refuses a schedule it cannot read: `basis "other"` with more than one bracket falls
// through every branch of evaluateSchedule to
//     miss(`Schedule basis "other" needs a human to read it — see notes and the source quote.`)
// so feeForProject returns feeUsd:null with that reason, and lookupPublishedFee hands the
// quote ladder a null. That is not a trick played on the evaluator; it is the evaluator's own
// stated meaning of "other" — a table that is not a function of anything this code can
// evaluate. A conflicted schedule is exactly that. The invariant it rests on (basis "other",
// >= 2 brackets) is asserted in buildConflictFinding and in the test, because a conflict row
// that accidentally carried ONE bracket would be ANSWERED, silently, with one of the two
// disputed numbers.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//
//  * It does not break the tie by date. Both document dates are captured verbatim
//    ("Revised 12/23/2022", "effective 7-1-25") and dated-versus-undated is reported, because
//    an undated form must not carry the same weight as an adopted schedule — but the pick is
//    a human's. The lead's own resolution of the Coos conflict took a ratio analysis and a
//    currency chain across four documents; no rule in here reproduces that judgement.
//  * It does not overwrite human-verified knowledge. A form template whose map is verified is
//    skipped by name (storeAhjFormTemplate would otherwise stamp verified:false over it), and
//    a verified fee schedule is protected by saveFeeSchedule's own guard, whose refusal this
//    module surfaces rather than swallowing.
//  * It does not silently drop a link. Anchors that matched nothing are counted, anchors that
//    ALMOST matched are listed by name, and anchors that matched on wording but do not look
//    like a document are reported "unsure" rather than discarded — a harvest that quietly
//    loses a form is worse than one that reports a link it was not sure about.
//  * It writes nothing unless asked (`apply: true`). The dry run is the default because the
//    first thing a person wants from a new jurisdiction is to SEE the numbers.
//
// WHAT feeSchedules.ts WOULD NEED to hold a conflict properly (it is not ours to change): a
// `confidence`/status value of 'conflicted' distinct from seeded/verified; a `document_date`
// per source; and a `candidates_json` holding each source's own brackets rather than the two
// tables flattened into one list with tagged labels. Until then the conflict lives in this
// module's report, in the schedule's notes, and in the basis-"other" refusal.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { LLMProvider } from "../../shared/src/types";
import {
  buildFieldMapForPdf,
  classifyFormType,
  sha256,
  storeAhjFormTemplate,
  type StoredFieldMap,
} from "./ahjFormAuto";
// The document's own account of itself — "Revised 12/23/2022" — has ONE reader, in
// documentDate.ts, and it is the same one storeAhjFormTemplate stamps into the
// template's document_date column. A second reader here would eventually disagree
// with the column it is meant to explain, and a wrong date makes a stale form look
// current, which is strictly worse than no date at all.
import { documentDateForPdf, isDocumentDateStale, isoForDocumentDate } from "./documentDate";
import { fetchPublicDocument, findDocumentLinks, type DocumentLink, type FetchedDocument } from "./documentFetch";
import {
  feeScheduleProfileKey,
  getFeeSchedule,
  saveFeeSchedule,
  type FeeBasis,
  type FeeBracket,
  type FeeScheduleFinding,
  type FeeScheduleRecord,
} from "./feeSchedules";
import { knowledgeResearchHint } from "./knowledgeBase";
import { logger } from "./logger";
import { extractPdfRows, findFeeRows, parseBracketRow } from "./pdfTables";
import { nowIso } from "./time";

const squash = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HarvestInput {
  state: string;
  ahj?: string;
  /** Context only. Fee storage here is PERMIT track, which is keyed (state, AHJ) —
   *  an interconnection schedule belongs to (state, utility) and to a different page. */
  utility?: string;
  /** Skip the page hunt entirely. */
  pageUrl?: string;
}

/** Where the documents came from. A jurisdiction may hand us a page to index, a
 *  set of direct document links (the KB carries plenty), or both. */
export interface HarvestPageSource {
  pageUrl: string;
  directUrls: string[];
  /** Human sentence: how we got here, and what it cost. */
  how: string;
}

export type HarvestPageFinder = (input: {
  db: AppDb;
  state: string;
  ahj: string;
  utility: string;
  llm?: LLMProvider;
}) => Promise<HarvestPageSource>;

export type HarvestFetcher = (url: string) => Promise<FetchedDocument>;

export interface HarvestOptions {
  /** Default false. Nothing is written on a dry run — the report says what would be. */
  apply?: boolean;
  /** Needed to map a downloaded AcroForm. Without it blanks are still stored, unmapped. */
  llm?: LLMProvider;
  /** Cap on documents downloaded in one pass. Default 10. */
  maxDocuments?: number;
  /** Injected for tests. Production uses fetchPublicDocument / findDocumentLinks. */
  fetchDocument?: HarvestFetcher;
  findLinks?: (url: string) => Promise<DocumentLink[]>;
  findPage?: HarvestPageFinder;
}

export interface HarvestLink {
  text: string;
  href: string;
  /** Why it was kept, flagged unsure, or passed over — always populated. */
  why: string;
}

export interface HarvestedFeeTable {
  found: boolean;
  reason: string;
  basis: FeeBasis;
  brackets: FeeBracket[];
  /** The jurisdiction's own printed rows, cell by cell, SAME-ROW paired. This is
   *  the sentence saveFeeSchedule demands behind every number. */
  quote: string;
  /** Fee-ish rows that could not be read as one description + one amount. Listed,
   *  never dropped: an unreadable row is a thing a person should look at. */
  unreadableRows: string[];
}

export interface HarvestDocumentReport {
  url: string;
  finalUrl: string;
  linkText: string;
  filename: string;
  /** The slot storeAhjFormTemplate would file this under (it re-derives the same one). */
  formType: string;
  fetched: boolean;
  status: number;
  via: string;
  contentType: string;
  bytes: number;
  /** Always populated, success or failure — fetchPublicDocument's own reason. */
  reason: string;
  isPdf: boolean;
  /** Set when these exact bytes already arrived under another URL on this page. */
  duplicateOf?: string;
  /** "Revised 12/23/2022" / "effective 7-1-25", verbatim as printed. "" when undated. */
  documentDate: string;
  documentDateIso: string;
  /** Older than DOCUMENT_DATE_STALE_DAYS. An UNDATED document is never stale —
   *  that is "unknown, go look", which is a different message and a different act. */
  documentStale: boolean;
  form: {
    action: "stored" | "would_store" | "skipped_verified" | "skipped_duplicate" | "not_a_pdf" | "no_acroform" | "failed";
    /** Field-map entries written (text fields + checkboxes), null when not mapped. */
    mappedFields: number | null;
    /** AcroForm fields the blank actually has, null when it has none/unknown. */
    acroFields: number | null;
    note: string;
  };
  fee: HarvestedFeeTable;
}

/** One document's claim about this jurisdiction's fees. The stored schedule is a
 *  candidate too — it is a source like any other, and it is the one the Coos
 *  application silently disagrees with. */
export interface FeeCandidate {
  /** Short tag used in conflict labels and notes: S1, S2, ... */
  tag: string;
  name: string;
  sourceUrl: string;
  sourceQuote: string;
  documentDate: string;
  documentDateIso: string;
  basis: FeeBasis;
  brackets: FeeBracket[];
  origin: "harvested" | "stored";
}

export interface FeeConflictBracket {
  /** The bracket's identity — its BOUNDS, not its position or its wording. */
  key: string;
  label: string;
  values: Array<{ tag: string; feeUsd: number[] }>;
}

export interface FeeConflict {
  brackets: FeeConflictBracket[];
  tags: string[];
  /** Set when every disputed bracket differs by the SAME multiple — the signature
   *  of a blanket increase, i.e. one document is simply older. Informational. */
  ratioNote: string;
  summary: string;
}

export type HarvestFeeAction =
  | "none"
  | "saved"
  | "would_save"
  | "conflict_saved"
  | "conflict_would_save"
  | "conflict_already_recorded"
  | "refused_verified"
  | "refused";

export interface HarvestReport {
  state: string;
  ahj: string;
  utility: string;
  track: "permit";
  pageUrl: string;
  pageHow: string;
  /** Why indexing produced nothing — a wall reads differently from an empty page. */
  pageReason: string;
  anchorsSeen: number;
  kept: HarvestLink[];
  /** Matched on wording but does not look like a document. Reported, not fetched. */
  unsure: HarvestLink[];
  /** Nearly matched — a person should glance at these before believing the harvest. */
  nearMisses: HarvestLink[];
  skippedCount: number;
  documents: HarvestDocumentReport[];
  fee: {
    action: HarvestFeeAction;
    reason: string;
    profileKey: string;
    candidates: FeeCandidate[];
    conflict: FeeConflict | null;
    /** The row as it stands after the pass (null on a dry run that wrote nothing). */
    schedule: FeeScheduleRecord | null;
  };
  applied: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 1. Finding the page
// ---------------------------------------------------------------------------

/** Words that make a URL or a link look like a jurisdiction's document/forms page. */
const PAGE_WORDS = /solar|photovoltaic|\bpv\b|permit|application|forms?|document|fee|building|planning|develop/i;
const STRONG_PAGE_WORDS = /solar|photovoltaic|permit-?application|forms-?and-?applications|document-?center|fee-?schedule/i;

/** Every http(s) URL a blob of KB text carries. The KB's 40 reference rows hide
 *  fee and permit page URLs in their notes; reading them costs nothing, and a
 *  free head start is the difference between a $0 pass and a web search. */
export function urlsInText(blob: string): string[] {
  return [...new Set((String(blob || "").match(/https?:\/\/[^\s"'<>)\]]+/gi) || []).map((u) => u.replace(/[.,;]+$/, "")))];
}

function scorePageUrl(url: string): number {
  let score = 0;
  if (STRONG_PAGE_WORDS.test(url)) score += 3;
  if (PAGE_WORDS.test(url)) score += 1;
  if (/\.(gov|us)(\/|$)/i.test(url)) score += 1;
  return score;
}

/** KB first (free), then one research call. Separated from harvestJurisdiction so
 *  a caller with its own idea of where the documents live can substitute it, and
 *  so the test never needs an LLM to exercise the rest of the pass. */
export const defaultPageFinder: HarvestPageFinder = async ({ db, state, ahj, utility, llm }) => {
  const hows: string[] = [];
  let hint: ReturnType<typeof knowledgeResearchHint> = null;
  try {
    hint = knowledgeResearchHint(db, { state, ahj, utility }, "ahj");
  } catch { /* the KB having nothing to say is not a failure */ }

  const directUrls = [...(hint?.pdfUrls || [])];
  const fromKb = urlsInText(hint?.text || "").filter((u) => !/\.pdf\b/i.test(u));
  const ranked = fromKb.map((u) => ({ u, s: scorePageUrl(u) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s);
  if (ranked.length) {
    hows.push(`knowledge base (free): ${ranked[0].u}`);
    return { pageUrl: ranked[0].u, directUrls, how: hows.join("; ") };
  }
  if (directUrls.length) hows.push(`knowledge base (free) carried ${directUrls.length} direct document link(s) but no page`);

  if (!llm) {
    return { pageUrl: "", directUrls, how: `${hows.join("; ") || "knowledge base had nothing"}; no LLM supplied, so no search was spent` };
  }
  try {
    const research = await llm.findAhjFormUrl({ ahj, state, formType: "permit_application", knownContext: hint?.text });
    const page = squash(research.formsPageUrl);
    for (const u of research.candidateUrls || []) if (!directUrls.includes(u)) directUrls.push(u);
    hows.push(page ? `research: ${page}` : `research found no forms page (${research.candidateUrls?.length || 0} direct candidate(s))`);
    return { pageUrl: page, directUrls, how: hows.join("; ") };
  } catch (err) {
    hows.push(`research failed: ${err instanceof Error ? err.message : String(err)}`);
    return { pageUrl: "", directUrls, how: hows.join("; ") };
  }
};

// ---------------------------------------------------------------------------
// 2. Indexing the page
// ---------------------------------------------------------------------------

/** The documents the AHJ-docs phase and the fee reader actually want. */
const DOC_WORDS: Array<{ re: RegExp; what: string }> = [
  { re: /\belectrical\b/i, what: "electrical" },
  { re: /\bstructural\b/i, what: "structural" },
  { re: /\bbuilding\b/i, what: "building" },
  { re: /\bsolar\b|\bphotovoltaic\b|\bpv\b/i, what: "solar" },
  { re: /\brenewable\b/i, what: "renewable" },
  { re: /permit\s+application|application\s+for\s+permit|\bapplication\b/i, what: "application" },
  { re: /\bchecklist\b|\bworksheet\b/i, what: "checklist" },
  { re: /fee\s+schedule|schedule\s+of\s+fees|\bfees?\b/i, what: "fee" },
];

/** Looks like a FILE rather than another page. CivicPlus and Laserfiche hand out
 *  documents on extensionless paths, which is why this is not just /\.pdf$/. */
const DOC_HREF = /\.(pdf|docx?|xlsx?)\b|\/showpublisheddocument\b|\/documentcenter\/view\b|[?&]documentid=|\/weblink\/|\/download\b|\/filestore\b|\/files\//i;

/** Furniture that carries our words but is never a document: a site's own search,
 *  a login, a share link, a calendar. A filter list fails both ways, so this one
 *  only ever moves a link from "kept" to "unsure" — never to "dropped". */
const NOT_A_DOCUMENT = /\/(search|login|signin|account|calendar|contact|sitemap|rss|share|print)\b|^mailto:|^tel:/i;

export interface LinkVerdict {
  verdict: "keep" | "unsure" | "skip";
  why: string;
  matched: string[];
  /** Higher goes first when maxDocuments bites. */
  rank: number;
}

/** Decide what a page's anchor is, and SAY WHY in every branch. */
export function classifyHarvestLink(link: DocumentLink): LinkVerdict {
  const hay = `${link.text} ${decodeURIComponent(link.href)}`;
  const matched = DOC_WORDS.filter((w) => w.re.test(hay)).map((w) => w.what);
  const fileish = DOC_HREF.test(link.href);
  if (!matched.length) {
    return {
      verdict: "skip",
      matched,
      rank: 0,
      why: fileish
        ? "a document link whose wording says nothing about solar, permits, applications or fees"
        : "no application/checklist/fee wording",
    };
  }
  // Rank: a named application or checklist beats a generic "fees" nav item, and a
  // solar-specific document beats a generic one.
  const rank =
    (matched.includes("checklist") ? 4 : 0) +
    (matched.includes("application") ? 4 : 0) +
    (matched.includes("solar") || matched.includes("renewable") ? 3 : 0) +
    (matched.includes("electrical") || matched.includes("structural") || matched.includes("building") ? 2 : 0) +
    (matched.includes("fee") ? 1 : 0) +
    (fileish ? 2 : 0);

  if (NOT_A_DOCUMENT.test(link.href)) {
    return { verdict: "unsure", matched, rank, why: `matched on ${matched.join("/")} but the URL is site furniture (search/login/share)` };
  }
  if (!fileish) {
    return { verdict: "unsure", matched, rank, why: `matched on ${matched.join("/")} but the link is a page, not a file — a person should open it` };
  }
  return { verdict: "keep", matched, rank, why: `document link matching ${matched.join("/")}` };
}

// ---------------------------------------------------------------------------
// 3b. Reading the fee table off the SAME bytes
// ---------------------------------------------------------------------------

/** The first row of practically every renewable-energy table reads "5 kva or
 *  less", and pdfTables' bracket parser does not reach it: its RANGE/MIN_OPEN/MAX
 *  patterns all expect the bound word BEFORE the number ("up to 5 kVA", "5 kVA
 *  and above"), so "5 kva or less" comes back with a fee, no bounds and no
 *  complaint — and a boundless row in a bracketed table is dropped by the guard
 *  below. That would silently lose the smallest bracket, which is the one most
 *  residential jobs land in.
 *
 *  Read INCLUSIVELY and only from an inclusive phrase, which is the convention
 *  pdfTables and matchBracket already share: "5 kva or less" means maxKw 5 with
 *  nothing invented. The strictly-exclusive phrasings it deliberately refuses
 *  ("greater than 25 KVA") are NOT re-admitted here — inventing an epsilon is
 *  the thing that module declines to do, and this extension does not overrule it. */
const OR_LESS_RE = new RegExp(
  String.raw`(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:kva|kw|kilowatts?|kilovolt-?amp(?:ere)?s?)\s*(?:or|and)\s*(?:less|under|below|fewer)\b`,
  "i",
);

export function inclusiveMaxFromLabel(label: string): number | null {
  const m = OR_LESS_RE.exec(String(label || ""));
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

function bracketBasis(brackets: FeeBracket[]): FeeBasis {
  if (brackets.some((b) => b.minKw != null || b.maxKw != null)) return "system_kw";
  if (brackets.some((b) => b.minValuationUsd != null || b.maxValuationUsd != null)) return "valuation";
  return brackets.length === 1 ? "flat" : "other";
}

/** The jurisdiction's own printed row, cell by cell. SAME-ROW paired by
 *  pdfTables, which is the whole point: a web summary of Coos County's table
 *  returned $108/$346/$796 by attaching the WIND rows to the solar brackets, and
 *  Hood River's PDF renders $171.99 as "$ | 1 | 71 | . | 99". Item-by-item
 *  reading survives neither; grouping by baseline survives both. */
function rowQuote(cells: string[], continuations: string[]): string {
  const head = cells.map((c) => `"${c}"`).join(" | ");
  return continuations.length ? `${head} + "${squash(continuations.join(" "))}"` : head;
}

/** Read a downloaded PDF's solar/renewable fee rows. Never throws: pdfTables
 *  THROWS on bytes it cannot read, by design ("an empty result reads as 'this
 *  schedule has no solar fee', which is a lie a corrupt download must never be
 *  allowed to tell") — this is the caller it defers that decision to, and the
 *  decision is that one unreadable document must not end the harvest. */
export async function readFeeTableFromPdf(bytes: Uint8Array): Promise<HarvestedFeeTable> {
  const empty = (reason: string): HarvestedFeeTable =>
    ({ found: false, reason, basis: "other", brackets: [], quote: "", unreadableRows: [] });

  let rows;
  try {
    rows = await extractPdfRows(bytes, { maxPages: 24 });
  } catch (err) {
    return empty(`fee scan FAILED to read this PDF (not "no fee table"): ${err instanceof Error ? err.message : String(err)}`);
  }

  const feeRows = findFeeRows(rows);
  if (!feeRows.length) return empty("no solar/photovoltaic/renewable/kVA row in this document");

  const brackets: FeeBracket[] = [];
  const quotes: string[] = [];
  const unreadableRows: string[] = [];
  for (const match of feeRows) {
    const quote = rowQuote(match.row.cells, match.continuations);
    const parsed = parseBracketRow(match);
    if (parsed.unparsed || parsed.feeUsd == null) {
      unreadableRows.push(`${quote} — ${parsed.unparsed || "no dollar amount"}`);
      continue;
    }
    const label = parsed.label || squash(match.label);
    const maxKw = parsed.maxKw ?? (parsed.minKw == null ? inclusiveMaxFromLabel(label) : null);
    brackets.push({
      minKw: parsed.minKw ?? null,
      maxKw: maxKw ?? null,
      feeUsd: parsed.feeUsd,
      label,
    });
    quotes.push(quote);
  }

  if (!brackets.length) {
    return {
      ...empty(`${feeRows.length} fee-ish row(s) found, none readable as one description + one amount`),
      unreadableRows,
    };
  }

  // A BOUNDLESS ROW IN A BRACKETED TABLE IS A TRAP. normalizeBrackets sorts by
  // (minKw ?? 0), so a bracket with neither bound sorts to the front, and
  // matchBracket — which treats an absent bound as open — then answers EVERY
  // system size with it. "Solar plan review" sitting above the kVA rows would
  // quietly become the fee for a 20 kW job. Drop them here and say so.
  const basis = bracketBasis(brackets);
  let usable = brackets;
  if (basis === "system_kw") {
    usable = brackets.filter((b) => b.minKw != null || b.maxKw != null);
    for (const b of brackets) {
      if (b.minKw == null && b.maxKw == null) {
        unreadableRows.push(`"${b.label}" ($${b.feeUsd.toFixed(2)}) — a fee row with no size bounds cannot sit in a bracketed table; it would match every system size`);
      }
    }
  }
  if (!usable.length) return { ...empty("every readable fee row lacked the size bounds its table brackets on"), unreadableRows };

  return {
    found: true,
    reason: "",
    basis: bracketBasis(usable),
    brackets: usable,
    quote: quotes.join("  "),
    unreadableRows,
  };
}

// ---------------------------------------------------------------------------
// Conflict
// ---------------------------------------------------------------------------

/** The marker that makes an unresolved conflict recognisable on a later pass.
 *  It carries NO " | " of its own: KB/fee notes are " | "-joined SEGMENTS, and a
 *  marker containing the separator would be shredded by mergeNotes and never
 *  found again. */
export const FEE_CONFLICT_MARKER = "UNRESOLVED FEE CONFLICT";

/** A bracket's identity is its BOUNDS, not its wording or its position. "5 kva or
 *  less" and "5 KVA or less" are the same row of the same table; so are two rows
 *  printed in different orders. A row with no bounds at all keys as "flat", which
 *  is what makes a single-line $200-versus-$250 disagreement visible — those two
 *  never share a label and would otherwise slip past unnoticed. */
export function bracketKey(b: FeeBracket): string {
  if (b.minKw != null || b.maxKw != null) return `kw:${b.minKw ?? "-"}..${b.maxKw ?? "+"}`;
  if (b.minValuationUsd != null || b.maxValuationUsd != null) return `usd:${b.minValuationUsd ?? "-"}..${b.maxValuationUsd ?? "+"}`;
  return "flat";
}

const sameMoney = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

function feesByKey(c: FeeCandidate): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const b of c.brackets) {
    const key = bracketKey(b);
    const list = out.get(key) || [];
    if (!list.some((v) => sameMoney(v, b.feeUsd))) list.push(b.feeUsd);
    out.set(key, list.sort((x, y) => x - y));
  }
  return out;
}

/** Do two or more sources disagree about the same bracket? Returns null when they
 *  agree, or when they simply do not overlap (two documents covering different
 *  rows of the same schedule is not a conflict — it is coverage). */
export function detectFeeConflict(candidates: FeeCandidate[]): FeeConflict | null {
  if (candidates.length < 2) return null;
  const maps = candidates.map((c) => ({ c, m: feesByKey(c) }));
  const keys = [...new Set(maps.flatMap((e) => [...e.m.keys()]))];

  const conflicting: FeeConflictBracket[] = [];
  for (const key of keys) {
    const present = maps.filter((e) => e.m.has(key));
    if (present.length < 2) continue;
    const first = present[0].m.get(key) as number[];
    const disagrees = present.some((e) => {
      const list = e.m.get(key) as number[];
      return list.length !== first.length || list.some((v, i) => !sameMoney(v, first[i]));
    });
    if (!disagrees) continue;
    const label = present[0].c.brackets.find((b) => bracketKey(b) === key)?.label || key;
    conflicting.push({
      key,
      label: squash(label),
      values: present.map((e) => ({ tag: e.c.tag, feeUsd: e.m.get(key) as number[] })),
    });
  }
  if (!conflicting.length) return null;

  const tags = [...new Set(conflicting.flatMap((b) => b.values.map((v) => v.tag)))];

  // THE RATIO IS EVIDENCE, NOT A VERDICT. Coos County's two documents are
  // uniformly 1.70x apart (135/79, 160/94, 265/156) — the fingerprint of one
  // blanket increase between 2022 and 2025, i.e. one document is simply stale
  // rather than describing a different fee. Saying so out loud is what lets a
  // person resolve this in a minute; it is still a person who resolves it.
  let ratioNote = "";
  const pairRatios = conflicting
    .map((b) => (b.values.length === 2 && b.values[0].feeUsd.length === 1 && b.values[1].feeUsd.length === 1
      ? b.values[0].feeUsd[0] / b.values[1].feeUsd[0]
      : NaN))
    .filter((r) => Number.isFinite(r) && r > 0);
  if (pairRatios.length === conflicting.length && pairRatios.length >= 2) {
    const lo = Math.min(...pairRatios);
    const hi = Math.max(...pairRatios);
    if (hi > 0 && (hi - lo) / hi <= 0.02 && Math.abs(hi - 1) > 0.02) {
      ratioNote = `Every disputed bracket is uniformly ${((lo + hi) / 2).toFixed(2)}x apart, which is the signature of one blanket increase rather than two different fee types — i.e. one of these documents is very likely just older. A human must confirm which.`;
    }
  }

  const summary = conflicting
    .map((b) => `${b.label || b.key}: ${b.values.map((v) => `${v.tag}=$${v.feeUsd.map((f) => f.toFixed(2)).join("/$")}`).join(" vs ")}`)
    .join("; ");

  return { brackets: conflicting, tags, ratioNote, summary };
}

function describeCandidate(c: FeeCandidate): string {
  // Dated-versus-undated and stale-versus-current are the two facts a person needs
  // to resolve this in a minute. Neither of them resolves it here.
  const when = c.documentDate
    ? `states "${c.documentDate}"${isDocumentDateStale(c.documentDate) ? " (STALE by our two-year rule)" : ""}`
    : "states NO document date, so it cannot be weighed against a dated schedule";
  return `${c.tag} = ${c.name} [${c.sourceUrl || "(no url)"}] ${when}`;
}

/** Turn a conflict into something feeSchedules.ts can hold and REFUSE to answer.
 *
 *  basis "other" with >= 2 brackets is the one shape evaluateSchedule declines to
 *  evaluate ("needs a human to read it"). Both invariants are enforced here
 *  rather than assumed, because a conflict row that arrived with a single bracket
 *  would be answered — with one of the two disputed numbers, silently. */
export function buildConflictFinding(
  candidates: FeeCandidate[],
  conflict: FeeConflict,
  stamp: string,
): FeeScheduleFinding | { error: string } {
  const inPlay = candidates.filter((c) => conflict.tags.includes(c.tag));
  const brackets: FeeBracket[] = [];
  for (const c of inPlay) {
    for (const b of c.brackets) {
      brackets.push({ ...b, label: `[${c.tag}] ${squash(b.label) || bracketKey(b)}`.slice(0, 200) });
    }
  }
  if (brackets.length < 2) {
    return { error: `a conflicted schedule must carry every candidate's brackets (>= 2); this one had ${brackets.length}, so it would be ANSWERED instead of refused` };
  }

  // The URL a person goes back to first: the dated source if exactly one is dated,
  // otherwise the first. saveFeeSchedule refuses a finding with no URL and no quote.
  const dated = inPlay.filter((c) => c.documentDateIso);
  const primary = (dated.length === 1 ? dated[0] : inPlay.find((c) => c.sourceUrl)) || inPlay[0];

  const notes = [
    `${FEE_CONFLICT_MARKER} recorded ${stamp}: ${conflict.summary}`,
    `Sources: ${inPlay.map(describeCandidate).join("; ")}`,
    conflict.ratioNote,
    `Stored as basis "other" with every candidate's brackets ON PURPOSE: feeForProject will refuse to answer for this jurisdiction until a human picks a source and re-saves it. A fee with two candidate values is a question, not an answer.`,
    `Each bracket label is prefixed with the tag of the source that printed it.`,
  ].filter(Boolean);

  return {
    found: true,
    reason: "",
    basis: "other",
    brackets,
    notes: notes.join(" | "),
    sourceUrl: primary.sourceUrl,
    sourceQuote: inPlay.map((c) => `${c.tag}: ${c.sourceQuote}`).join("   ").slice(0, 1000),
    // Harvested off the jurisdiction's own document page — the researcher path has
    // to guess at this; the harvest knows.
    sourceKind: "official",
  };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

function filenameFor(url: string, linkText: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
    if (/\.(pdf|docx?|xlsx?)$/i.test(last)) return last;
  } catch { /* fall through to the link's own words */ }
  const words = squash(linkText).replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 80);
  return `${words || "document"}.pdf`;
}

/** Is the row storeAhjFormTemplate WOULD overwrite human-verified?
 *
 *  It must be asked of exactly that row: storeAhjFormTemplate dedupes on
 *  (lower(ahj_name), lower(state), form_type) and re-derives form_type from the
 *  filename, so a fuzzy-name check (hasStoredTemplateOfType) would answer about a
 *  different row. And it must be asked at all, because storeAhjFormTemplate
 *  stamps `verified: false` on every store — it protects nothing by itself. */
export function storedTemplateIsVerified(db: AppDb, ahj: string, state: string, formType: string): boolean {
  const row = db.get<{ field_map: string }>(
    "SELECT field_map FROM ahj_form_templates WHERE lower(ahj_name) = lower(?) AND lower(state) = lower(?) AND form_type = ? LIMIT 1",
    [ahj, state, formType],
  );
  if (!row) return false;
  try {
    return (JSON.parse(row.field_map || "{}") as StoredFieldMap)?.verified === true;
  } catch {
    return false;
  }
}

const isPdfBytes = (b: Uint8Array): boolean => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

/**
 * Harvest one jurisdiction in a single pass: find its document page, index it,
 * download each application/checklist ONCE, and use that download twice — as a
 * blank form to map and store, and as a fee table to quote.
 *
 * Writes nothing unless `apply` is true.
 */
export async function harvestJurisdiction(
  db: AppDb,
  input: HarvestInput,
  options: HarvestOptions = {},
): Promise<HarvestReport> {
  const state = squash(input.state);
  const ahj = squash(input.ahj);
  const utility = squash(input.utility);
  const apply = options.apply === true;
  const maxDocuments = Math.max(1, options.maxDocuments ?? 10);
  const fetchDoc: HarvestFetcher = options.fetchDocument || ((url) => fetchPublicDocument(url));
  const findLinks = options.findLinks || ((url) => findDocumentLinks(url, {}, () => true));
  const stamp = nowIso().slice(0, 10);
  const warnings: string[] = [];

  const profileKey = feeScheduleProfileKey({ state, ahj, utility: "" }, "permit");
  const report: HarvestReport = {
    state, ahj, utility, track: "permit",
    pageUrl: "", pageHow: "", pageReason: "",
    anchorsSeen: 0, kept: [], unsure: [], nearMisses: [], skippedCount: 0,
    documents: [],
    fee: { action: "none", reason: "", profileKey, candidates: [], conflict: null, schedule: null },
    applied: apply,
    warnings,
  };

  if (!state || !ahj) {
    report.fee.reason = "state and ahj are both required — a permit fee schedule is keyed (state, AHJ).";
    warnings.push(report.fee.reason);
    return report;
  }

  // ---- 1. FIND THE PAGE -----------------------------------------------------
  let source: HarvestPageSource;
  if (input.pageUrl) {
    source = { pageUrl: squash(input.pageUrl), directUrls: [], how: "given by the caller" };
  } else {
    source = await (options.findPage || defaultPageFinder)({ db, state, ahj, utility, llm: options.llm });
  }
  report.pageUrl = source.pageUrl;
  report.pageHow = source.how;

  // ---- 2. INDEX IT ----------------------------------------------------------
  const targets: Array<{ url: string; text: string }> = [];
  if (source.pageUrl) {
    let links: DocumentLink[] = [];
    try {
      links = await findLinks(source.pageUrl);
    } catch (err) {
      report.pageReason = `indexing threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    report.anchorsSeen = links.length;
    if (!links.length && !report.pageReason) {
      // findDocumentLinks returns [] for a wall and [] for an empty page alike —
      // which is measured failure #1 all over again, one level up. Pay for a
      // second fetch ONLY on the failure path, and name what actually happened.
      const probe = await fetchDoc(source.pageUrl);
      report.pageReason = probe.ok
        ? "the page was retrieved but carried no anchors we could read"
        : `page UNREACHABLE (not empty): ${probe.reason}`;
      if (!probe.ok) warnings.push(report.pageReason);
    }

    const verdicts = links.map((l) => ({ l, v: classifyHarvestLink(l) }));
    for (const { l, v } of verdicts) {
      if (v.verdict === "keep") report.kept.push({ text: l.text, href: l.href, why: v.why });
      else if (v.verdict === "unsure") report.unsure.push({ text: l.text, href: l.href, why: v.why });
      else {
        report.skippedCount++;
        // A skipped link that still smells of paper is listed by name. The bulk of
        // a county site's nav is not, or the report would be unreadable — but
        // nothing that could plausibly be a form leaves without being shown.
        if (/form|application|permit|fee|handout|guide|checklist|worksheet|packet|instruction/i.test(`${l.text} ${l.href}`)) {
          if (report.nearMisses.length < 30) report.nearMisses.push({ text: l.text, href: l.href, why: v.why });
        }
      }
    }
    for (const { l, v } of verdicts.filter((e) => e.v.verdict === "keep").sort((a, b) => b.v.rank - a.v.rank)) {
      targets.push({ url: l.href, text: l.text });
    }
  } else if (!report.pageReason) {
    report.pageReason = "no document page was found or given";
  }

  for (const url of source.directUrls) {
    if (!targets.some((t) => t.url === url)) targets.push({ url, text: "(direct link, not from an indexed page)" });
  }

  if (targets.length > maxDocuments) {
    warnings.push(`${targets.length} candidate documents, capped at ${maxDocuments} for this pass (raise --max to take more).`);
  }

  // ---- 3. EACH DOCUMENT, DOWNLOADED ONCE, READ TWICE ------------------------
  const seenHashes = new Map<string, string>();
  const candidates: FeeCandidate[] = [];
  let tagN = 0;

  for (const target of targets.slice(0, maxDocuments)) {
    const got = await fetchDoc(target.url);
    const filename = filenameFor(got.finalUrl || target.url, target.text);
    const formType = classifyFormType(filename, classifyFormType(`${target.text} ${target.url}`, "permit_application"));
    const doc: HarvestDocumentReport = {
      url: target.url,
      finalUrl: got.finalUrl || target.url,
      linkText: squash(target.text),
      filename,
      formType,
      fetched: got.ok,
      status: got.status,
      via: got.via,
      contentType: got.contentType,
      bytes: got.bytes?.length || 0,
      reason: got.reason,
      isPdf: false,
      documentDate: "",
      documentDateIso: "",
      documentStale: false,
      form: { action: "failed", mappedFields: null, acroFields: null, note: got.reason },
      fee: { found: false, reason: "not fetched", basis: "other", brackets: [], quote: "", unreadableRows: [] },
    };
    report.documents.push(doc);
    if (!got.ok || !got.bytes) continue;

    const bytes = got.bytes;
    doc.isPdf = isPdfBytes(bytes) || /pdf/i.test(got.contentType);
    if (!doc.isPdf) {
      doc.form = { action: "not_a_pdf", mappedFields: null, acroFields: null, note: `answered with ${got.contentType || "an unknown type"} — a link to fix, not a wall to climb` };
      doc.fee = { ...doc.fee, reason: "fee tables are read from PDFs; this document is not one" };
      continue;
    }

    const hash = sha256(bytes);
    const already = seenHashes.get(hash);
    if (already) {
      doc.duplicateOf = already;
      doc.form = { action: "skipped_duplicate", mappedFields: null, acroFields: null, note: `identical bytes to ${already} — the same PDF linked twice` };
      doc.fee = { ...doc.fee, reason: "already read under the other link" };
      continue;
    }
    seenHashes.set(hash, target.url);

    // ---- 3b. THE FEE TABLE, off the bytes we already paid for ---------------
    doc.fee = await readFeeTableFromPdf(bytes);

    // The document's own statement about its currency, from the one reader.
    doc.documentDate = await documentDateForPdf(bytes);
    doc.documentDateIso = isoForDocumentDate(doc.documentDate);
    doc.documentStale = isDocumentDateStale(doc.documentDate);

    if (doc.fee.found) {
      tagN += 1;
      candidates.push({
        tag: `S${tagN}`,
        name: `${squash(target.text) || filename} (harvested)`,
        sourceUrl: doc.finalUrl,
        sourceQuote: doc.fee.quote,
        documentDate: doc.documentDate,
        documentDateIso: doc.documentDateIso,
        basis: doc.fee.basis,
        brackets: doc.fee.brackets,
        origin: "harvested",
      });
    }

    // ---- 3a. THE FORM, off the very same bytes ------------------------------
    if (storedTemplateIsVerified(db, ahj, state, formType)) {
      doc.form = {
        action: "skipped_verified", mappedFields: null, acroFields: null,
        note: `a human has verified the stored ${formType.replace(/_/g, " ")} map for ${ahj}; storeAhjFormTemplate would stamp verified:false over it, so this pass leaves it alone`,
      };
      continue;
    }

    const formName = squash(target.text) || `${ahj} ${formType.replace(/_/g, " ")}`;
    let acro: Awaited<ReturnType<typeof buildFieldMapForPdf>> = null;
    if (options.llm) {
      try {
        acro = await buildFieldMapForPdf(options.llm, { ahj, state, formName, bytes });
      } catch (err) {
        warnings.push(`field mapping failed for ${target.url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const mapped = acro ? Object.keys(acro.textFields).length + Object.keys(acro.checkboxes).length : 0;
    const dateNote = doc.documentDate ? ` Document states: "${doc.documentDate}".` : " The document states no revision/effective date.";
    const map: StoredFieldMap = acro
      ? {
        formName, sourceUrl: doc.finalUrl, fillMode: "acroform",
        textFields: acro.textFields, checkboxes: acro.checkboxes,
        notes: `Harvested ${stamp} from ${report.pageUrl || "a direct link"}.${dateNote} ${acro.notes}`.trim(),
      }
      : {
        formName, sourceUrl: doc.finalUrl, fillMode: "overlay", textFields: {}, checkboxes: {},
        notes: `Harvested ${stamp} from ${report.pageUrl || "a direct link"}.${dateNote} `
          + `${options.llm ? "No AcroForm fields (flat or scanned) — route it through the vision overlay mapper or fill by hand." : "No LLM was supplied to this pass, so the blank is stored unmapped."}`,
      };

    if (!apply) {
      doc.form = {
        action: "would_store", mappedFields: acro ? mapped : null, acroFields: acro?.fieldCount ?? null,
        note: acro ? `would store as ${formType} with ${mapped} mapped field(s) of ${acro.fieldCount}` : `would store as ${formType}, unmapped (${map.notes})`,
      };
      continue;
    }

    try {
      // The provenance columns exist for exactly this pass: WHERE the blank came from,
      // WHAT it says about its own currency, WHEN we pulled it, and whether these bytes
      // were also the source of a fee table. The last one is what lets a later sweep find
      // every form whose fee numbers might have moved under it.
      storeAhjFormTemplate(db, {
        ahjName: ahj, state, formType, filename, bytes, map,
        documentDate: doc.documentDate,
        feeTableFound: doc.fee.found,
      });
      doc.form = {
        action: "stored", mappedFields: acro ? mapped : 0, acroFields: acro?.fieldCount ?? null,
        note: acro ? `stored as ${formType}: ${mapped} mapped field(s) of ${acro.fieldCount}` : `stored as ${formType}, unmapped blank`,
      };
    } catch (err) {
      doc.form = { action: "failed", mappedFields: null, acroFields: null, note: `store failed: ${err instanceof Error ? err.message : String(err)}` };
      warnings.push(`storing ${filename} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- 4. THE FEE DECISION --------------------------------------------------
  await resolveFees(db, report, candidates, { apply, stamp, state, ahj, profileKey });

  logger.info("harvest", "jurisdiction harvest complete", {
    ahj, state, page: report.pageUrl || undefined, documents: report.documents.length,
    fee: report.fee.action, conflict: Boolean(report.fee.conflict), applied: apply,
  });
  return report;
}

async function resolveFees(
  db: AppDb,
  report: HarvestReport,
  harvested: FeeCandidate[],
  cfg: { apply: boolean; stamp: string; state: string; ahj: string; profileKey: string },
): Promise<void> {
  const existing = getFeeSchedule(db, cfg.profileKey, "permit");

  // THE STORED ROW IS A SOURCE TOO. This is the Coos case exactly: the adopted
  // 7-1-25 schedule is already on file, and the county's own solar page hands us
  // an application printing 2022 numbers. Comparing only the harvested documents
  // with each other would agree with itself and overwrite the good row.
  const candidates: FeeCandidate[] = [...harvested];
  if (existing && existing.brackets.length) {
    candidates.push({
      tag: "S0",
      name: `already stored for ${existing.ahj || cfg.ahj} (${existing.confidence})`,
      sourceUrl: existing.sourceUrl,
      sourceQuote: existing.sourceQuote,
      documentDate: "",
      documentDateIso: "",
      basis: existing.basis,
      brackets: existing.brackets,
      origin: "stored",
    });
  }
  report.fee.candidates = candidates;

  if (!harvested.length) {
    report.fee.action = "none";
    report.fee.reason = report.documents.length
      ? "no document on this page printed a readable solar/renewable fee row"
      : "no documents were retrieved, so no fee table could be read";
    return;
  }

  // An unresolved conflict already on file is a QUESTION ALREADY ASKED. Piling a
  // fresh reading on top of it would re-flatten two disputed tables into three and
  // make the question harder, not easier.
  if (existing && existing.notes.includes(FEE_CONFLICT_MARKER)) {
    report.fee.action = "conflict_already_recorded";
    report.fee.schedule = existing;
    report.fee.conflict = detectFeeConflict(candidates);
    report.fee.reason = `An ${FEE_CONFLICT_MARKER} is already recorded for ${cfg.profileKey} and nothing was written. A human must pick a source and re-save it before research is stored here again. Existing notes: ${existing.notes}`;
    return;
  }

  const conflict = detectFeeConflict(candidates);
  report.fee.conflict = conflict;

  if (conflict) {
    const built = buildConflictFinding(candidates, conflict, cfg.stamp);
    if ("error" in built) {
      report.fee.action = "refused";
      report.fee.reason = `Conflict detected but NOT stored: ${built.error}. Nothing was written — resolve it by hand. ${conflict.summary}`;
      report.warnings.push(report.fee.reason);
      return;
    }
    // The invariant the refusal rests on, checked against the thing actually built.
    if (built.basis !== "other" || built.brackets.length < 2) {
      report.fee.action = "refused";
      report.fee.reason = `Conflict finding failed its own invariant (basis=${built.basis}, brackets=${built.brackets.length}); a schedule like that would be ANSWERED rather than refused, so nothing was written.`;
      report.warnings.push(report.fee.reason);
      return;
    }
    if (!cfg.apply) {
      report.fee.action = "conflict_would_save";
      report.fee.schedule = existing;
      report.fee.reason = `CONFLICT: ${conflict.summary}. ${conflict.ratioNote} Would store both candidates as basis "other" so feeForProject refuses to answer until a human picks one.`.trim();
      return;
    }
    const outcome = saveFeeSchedule(db, { state: cfg.state, ahj: cfg.ahj, track: "permit" }, built);
    report.fee.schedule = outcome.schedule;
    report.fee.action = outcome.refusedVerified ? "refused_verified" : outcome.saved ? "conflict_saved" : "refused";
    report.fee.reason = outcome.refusedVerified
      ? `The stored schedule is HUMAN-VERIFIED, so nothing was changed; the conflicting finding went to its notes. ${conflict.summary}`
      : outcome.saved
        ? `CONFLICT stored: ${conflict.summary}. ${conflict.ratioNote} feeForProject will now refuse to answer for ${cfg.ahj} until a human picks a source.`.trim()
        : `Conflict NOT stored: ${outcome.reason}`;
    return;
  }

  // No conflict: the best-covered harvested reading wins. "Best covered" is the
  // most brackets, because a table read in full is a table; one row of it is a
  // price, and this module exists to store the function rather than the price.
  const best = [...harvested].sort((a, b) => b.brackets.length - a.brackets.length)[0];
  const dateNote = best.documentDate
    ? `Source document states "${best.documentDate}".`
    : "Source document states NO revision or effective date — weigh it accordingly against any dated schedule.";
  const finding: FeeScheduleFinding = {
    found: true,
    reason: "",
    basis: best.basis,
    brackets: best.brackets,
    notes: [
      `Harvested ${cfg.stamp} from ${report.pageUrl || best.sourceUrl} in one pass with this jurisdiction's blank forms.`,
      dateNote,
      "Read by COORDINATE PAIRING (same-row grouping), not reading order: a web summary of a neighbouring county's table returned three fees that belonged to its wind rows.",
      candidates.length > 1 ? `Checked against ${candidates.length - 1} other source(s) for this jurisdiction and found no bracket disagreement.` : "",
    ].filter(Boolean).join(" | "),
    sourceUrl: best.sourceUrl,
    sourceQuote: best.sourceQuote.slice(0, 1000),
    sourceKind: "official",
  };

  if (!cfg.apply) {
    report.fee.action = "would_save";
    report.fee.schedule = existing;
    report.fee.reason = `Would save ${finding.brackets.length} bracket(s) on basis ${finding.basis} from ${best.sourceUrl}.`;
    return;
  }
  const outcome = saveFeeSchedule(db, { state: cfg.state, ahj: cfg.ahj, track: "permit" }, finding);
  report.fee.schedule = outcome.schedule;
  report.fee.action = outcome.refusedVerified ? "refused_verified" : outcome.saved ? "saved" : "refused";
  report.fee.reason = outcome.refusedVerified
    ? "The stored schedule is HUMAN-VERIFIED, so nothing was changed; the finding went to its notes."
    : outcome.saved
      ? `Saved ${finding.brackets.length} bracket(s) (seeded) on basis ${finding.basis}.`
      : `Not saved: ${outcome.reason}`;
}
