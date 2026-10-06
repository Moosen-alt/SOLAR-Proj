// ---------------------------------------------------------------------------
// DESIGN CRITERIA ARE CHECKED FOR VALUE, NOT JUST PRESENCE.
//
// The code rules used to ask only whether a package MENTIONED ground snow, dead load and
// wind (city.struct.loads-missing). Two real bounces showed what that misses:
//
//   · A coastal Oregon city (2026-09-23): "Ground snow load 36 psf. Provide updated design
//     criteria for the letter from the engineer and the plan set." The plan printed
//     GROUND SNOW 16 PSF. Present — and wrong for the jurisdiction. Nothing on file knew
//     the city's value, and nothing said so.
//   · Another coastal Oregon city (2026-05-05): "The structural engineered design criteria
//     is conflicting between the calculations and the submitted plans set" (ORSC R106) and
//     "minimum wind speed design is 120 MPH Ultimate Exposure D" (special wind region). The
//     plan set said 110 mph / Exposure C / ground snow 20; the sealed calculation said 95
//     mph / Exposure B / ground snow 28 and claimed to "supersede" the plan for loads. The
//     jurisdiction bounced exactly that: a later document saying it supersedes an earlier
//     one does not reconcile the package the examiner is holding.
//
// So this module reads what the package STATES, per source, label-anchored — a number is a
// ground snow load only when it is LABELLED ground snow / Pg; "ROOF SNOW LOAD" is roof snow;
// "20 psf roof live" is neither — and four rules compare those statements with each other
// and with the jurisdiction's own recorded criteria:
//
//   city.struct.design-criteria-conflict   one quantity, two values, across the package
//   city.struct.design-criteria-below-ahj  a stated value less severe than the AHJ's record
//   city.struct.design-criteria-unknown    the AHJ's value is not on file (a callout, never
//                                          silence: an unknown must not read as reassurance)
//   city.code.basis-mismatch               the plan's GOVERNING CODES vs the adopted codes
//                                          (a blocker only against a human-verified profile)
//   city.code.basis-unverified             the plan states a code basis, the AHJ's editions
//                                          are not on file (a callout, never silence)
//
// Pure: no database. The jurisdiction arrives as an EffectiveCodeContext, the same way the
// rest of codeReviewRules receives it, so these rules work for any AHJ whose profile carries
// designCriteria — the fix is data (the profile), never a city-specific branch here.
// ---------------------------------------------------------------------------
import type {
  CodeReference,
  JurisdictionCriterionKey,
  JurisdictionDesignCriteria,
  ProjectRecord,
  ReviewerFinding,
  ReviewerFindingEvidence,
  ReviewerVisionVerdict,
  RoofPlanDimensionKind,
  RoofPlanRequiredDimension,
  StatedCodeBasisEntry,
  StatedDesignCriteria,
  StatedDesignCriterion,
  StatedDesignCriterionKind,
  StatedDesignCriterionQualifier,
  StatedRoofPlanDimension,
  UpcomingCodeEdition,
} from "../../shared/src/types";
import type { EffectiveCodeContext } from "./codeProfiles";
import { codeFamilyOf, editionsInEffect, type EditionsInEffect } from "./codeFamilies";

export interface DesignTextSource {
  label: string;
  text: string;
}

/** The parser's scalar fields — a READING of the documents, not a document. */
export const PARSED_FIELDS_SOURCE = "Parsed project fields";

// MACHINE EXTRACTS OF THE SHEETS THEMSELVES. planSetExtractedText is the uploaded documents'
// text merged into one blob (projectDocuments.planSetTextForProject); splitPagesText is the
// splitter's sheet map. Both are the package's own words.
const SHEET_TEXT_SOURCES: Array<[string, string]> = [
  ["planSetExtractedText", "Uploaded plan-set document text"],
  ["splitPagesText", "Split page mapping"],
];
// THE PARSER'S NARRATIVE SUMMARIES (llm.ts "NARRATIVE EVIDENCE BLOBS" — "a short factual
// summary; cite sheet numbers"). They are a READING of the documents, exactly like the scalar
// fields, never a document: on a real package the structural summary described the conflict
// itself ("Plan-set loads … 110 mph … supersedes for loads: Exposure B, 95 mph"), and counting
// it as a second document turned one internally inconsistent package into a two-document
// blocker. They are still read — they are marked derived. Parser commentary (reviewFlags) and
// utility/packet notes stay absent altogether: they talk ABOUT the design.
const NARRATIVE_SOURCES: Array<[string, string]> = [
  ["structuralCalcText", "Structural calculation text"],
  ["electricalCalcText", "Electrical calculation text"],
  ["sitePlanNotesText", "Site plan notes"],
  ["roofPlanNotesText", "Roof plan notes"],
  ["projectDescriptionText", "Project description"],
  ["labelsText", "Labels text"],
  ["stampRecommendation", "Stamp recommendation"],
];

/** A stored document whose PDF had no text layer (projectDocuments marker). */
const NO_TEXT_LAYER = "[no text layer]";

function snapshotText(project: ProjectRecord, key: string): string {
  const value = project.parserSnapshot?.[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function flat(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** One text the extractor reads, and whether it is a DOCUMENT or a reading of one. */
interface ReadSource {
  label: string;
  /** Flattened. */
  text: string;
  /** True for a reading (parser fields, narrative summaries, a merge of documents that are
   *  also supplied one by one) — never one side of a two-document conflict. */
  derived: boolean;
  /** The package's own sheets (a document, or the sheet text) — not a parser summary. */
  sheet: boolean;
}

/**
 * Every text the package offers, ONE SOURCE PER DOCUMENT:
 *  · per-document texts from the caller (one per stored plan/letter/calc document) first;
 *  · the snapshot's sheet text — but when documents are supplied it is a second copy of
 *    them, so the merged blob is skipped when it contains them all and is otherwise a
 *    (derived) reading;
 *  · the parser's narrative summaries, derived;
 *  · identical text under two keys is ONE source (the first label wins).
 */
function readSources(project: ProjectRecord, extraTexts: DesignTextSource[]): ReadSource[] {
  const docs = extraTexts
    .map((s) => ({ label: s.label, text: flat(String(s.text || "")) }))
    .filter((s) => s.text && s.text !== NO_TEXT_LAYER);
  const out: ReadSource[] = docs.map((d) => ({ ...d, derived: false, sheet: true }));
  for (const [key, label] of SHEET_TEXT_SOURCES) {
    const text = flat(snapshotText(project, key));
    if (!text || text === NO_TEXT_LAYER) continue;
    if (docs.length && key === "planSetExtractedText" && docs.every((d) => text.includes(d.text))) continue;
    out.push({ label, text, derived: docs.length > 0, sheet: true });
  }
  for (const [key, label] of NARRATIVE_SOURCES) {
    const text = flat(snapshotText(project, key));
    if (text) out.push({ label, text, derived: true, sheet: false });
  }
  const seen = new Set<string>();
  return out.filter((s) => {
    if (seen.has(s.text)) return false;
    seen.add(s.text);
    return true;
  });
}

// WHERE A LABEL STARTS. The excerpt runs from the label keyword to the end of the value —
// never the characters around them: on most sheets the design-criteria note sits beside the
// title block, and a window of "context" carried title-block names into the evidence
// (measured: "RISK CATEGORY = II DECK Rev <owner>"). A value-first match ("28 psf ground
// snow") already contains its label.
function excerptAt(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start), Math.min(text.length, end)).trim();
}

function toNumber(raw: string): number | null {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

const ROMAN: Record<string, string> = { "1": "I", "2": "II", "3": "III", "4": "IV" };
function normRisk(raw: string): string {
  const v = raw.trim().toUpperCase();
  return ROMAN[v] ?? v;
}

// --- wind ------------------------------------------------------------------

// A value that is a LIMIT or a RATING is not this building's design speed: a racking cut
// sheet "tested to 160 mph", "RAIL SYSTEM DESIGNED FOR 160 MPH WIND", a prescriptive checklist
// "wind ≤ 110 mph". "Designed for" counts only directly before the value — "SYSTEM DESIGNED
// FOR: WIND SPEED = 110 MPH" is a design-criteria header, and its label sits in between.
const RATING_CONTEXT = /(?:\bup\s*to|\bmax(?:imum)?\.?|\bmin(?:imum)?\.?|\brated|\brating|\btested|\bcertified|\bcapacit(?:y|ies)|\blimit(?:ed)?|\bexceed(?:s|ing)?|\bnot\s+more\s+than|\bless\s+than|\bgreater\s+than|≤|≥|<=|>=|<|>)[^0-9•▪●■◦]{0,24}$|\bdesigned\s+(?:for|to)\s*(?:an?\s+)?$/i;

// A LIMIT FURTHER BACK IN THE SENTENCE governs an UNASSIGNED value. A prescriptive checklist
// puts the limit word, then a form's furniture, then the values: "The basic design wind speed
// does not exceed the following: Yes No ( check one ) 120 mph in Wind Exposure Category C …; or
// 135 mph in Wind Exposure Category B" — every one of those is a bound, not the site's value.
// Only an UNASSIGNED value is governed this way: "… MAXIMUM … WIND SPEED = 110 MPH" still states
// 110 (the "=" is the statement). The sentence runs back to the last full stop (a decimal point
// is not one), never more than 260 characters.
//
// A LIMIT GOVERNS ITS OWN FIELD, NOT THE REST OF THE LINE. In period-less sheet text the limit's
// own field ends at its own value: "MAX ROOF SLOPE 30 DEG … WIND SPEED 110 MPH", "UP TO 16 MODULES
// PER BRANCH … WIND SPEED 115 MPH", "NOT TO EXCEED 6 FT GROUND SNOW LOAD 40 PSF". A number in
// another unit (not mph/psf) between the limit word and the value spends the limit; a checklist's
// bounds are all mph/psf ("does not exceed … 120 mph in … C; or 135 mph …"), so they stay bounds.
const SENTENCE_LIMIT = /\b(?:exceed(?:s|ed|ing)?|limited\s+to|up\s+to|less\s+than|greater\s+than|more\s+than|or\s+less|or\s+greater|or\s+more|not\s+to\s+exceed|maximum|max)\b|≤|≥|<=|>=/gi;
/** A number that is not a design-criteria value (no mph/psf after it). */
const OTHER_UNIT_NUMBER = /(?<![\d.])\d+(?:\.\d+)?(?![\d.])(?!\s*(?:mph|psf)\b)/i;
// THE LIMIT'S FIELD ALSO ENDS AT A FIELD BOUNDARY — not only at a full stop or a number in
// another unit:
//  · a LIST MARKER or a BULLET that opens a new item: "(1) ARRAY NOT TO EXCEED ROOF RIDGE (2) WIND
//    SPEED 110 MPH", "• RACKING LIMITED TO COMP SHINGLE ROOFS • WIND SPEED 110 MPH". (A blank line
//    cannot be one: readSources flattens every run of whitespace before the extractors run.)
//    Not when the new item opens with a VALUE ("does not exceed (1) 120 mph in … C; (2) 135 mph
//    in … B" — those items are the bound's own list), and not when the limit's clause ENDS in a
//    colon before the first item ("SYSTEM LIMITED TO: (1) WIND SPEED 110 MPH (2) …" — a header
//    whose items are all bounds). A list marker is never itself "a number in another unit".
//  · a LABEL WITH ITS OWN ":"/"=" VALUE, then this value's own design label: "MAXIMUM ROOF
//    HEIGHT: TWO STORIES WIND SPEED 110 MPH". A form's furniture is not a value ("does not exceed
//    the following: Yes No ( check one ) Wind speed 120 mph" stays a bound), and neither is a
//    bound value in the header's clause ("…: Yes No 120 mph in Wind Exposure Category C" — the
//    120 mph comes before the exposure's label, so the letter stays under the limit).
const LIST_MARKER = /(?<=^|\s)(?:\(\d{1,2}\)|\d{1,2}\))(?=\s)/g;
const FIELD_BREAK = /[•▪●■◦]|(?<=^|\s)(?:\(\d{1,2}\)|\d{1,2}\))(?=\s)/g;
const DESIGN_LABEL = /\b(?:wind|exp(?:osure\b|\.)|ground\s+snow|snow\s+loads?|risk\s+cat|v\s*[_(]?\s*(?:ult|asd)\b|v(?:ult|asd)\b|p\s?g\b)/i;
const FORM_FURNITURE = /\b(?:yes|no|n\/a)\b|[☐□☑☒✓✔]/gi;
const DESIGN_VALUE = /\d+(?:\.\d+)?\s*(?:mph|psf)\b/i;
/** Has the limit word's own field ended somewhere in `tail` (the text from the limit word to the value)? */
function limitSpent(tail: string): boolean {
  const numbersOnly = blankParentheticals(tail.replace(LIST_MARKER, (x) => " ".repeat(x.length))).replace(/\[[^[\]]*\]/g, (p) => " ".repeat(p.length));
  if (OTHER_UNIT_NUMBER.test(numbersOnly)) return true;
  const breaks = [...tail.matchAll(FIELD_BREAK)];
  if (breaks.length && !/[:=]\s*$/.test(tail.slice(0, breaks[0].index))) {
    for (const b of breaks) {
      // Nothing after the marker but the value itself ("(1) 120 mph"): the item opens with a value.
      if (!/^\s*(?:\d|$)/.test(tail.slice((b.index ?? 0) + b[0].length))) return true;
    }
  }
  const sep = Math.max(tail.lastIndexOf(":"), tail.lastIndexOf("="));
  if (sep >= 0) {
    const post = blankParentheticals(tail.slice(sep + 1)).replace(FORM_FURNITURE, (x) => " ".repeat(x.length));
    const lab = post.search(DESIGN_LABEL);
    if (lab > 0 && /\S/.test(post.slice(0, lab)) && !DESIGN_VALUE.test(post.slice(0, lab))) return true;
  }
  return false;
}
/** Does a limit word earlier in the sentence still govern the value at "at"? */
function limitGoverns(text: string, at: number): boolean {
  const sentence = sentenceBefore(text, at);
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  const re = new RegExp(SENTENCE_LIMIT.source, "gi");
  while ((m = re.exec(sentence))) last = m;
  if (!last) return false;
  return !limitSpent(sentence.slice(last.index + last[0].length));
}
function sentenceBefore(text: string, at: number): string {
  const window = text.slice(Math.max(0, at - 260), at);
  let cut = 0;
  const stop = /[.!?](?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = stop.exec(window))) cut = m.index + 1;
  return window.slice(cut);
}
/** A value with its label's separator right before it ("= 110", ": v 95", "Vult: 120"). */
const ASSIGNED_BEFORE = /[:=]\s*(?:v\s*[_(]?\s*(?:ult|asd)?\s*\)?\s*)?$/i;
/** A bound printed AFTER the value: "70 psf or less?", "110 mph and below" — whatever precedes it. */
const BOUND_AFTER = /^\s*(?:psf|mph)?\s*(?:or\s+(?:less|lower|below|greater|more|higher|above)\b|and\s+(?:less|lower|below|greater|more|higher|above)\b|\?)/i;
/** "120 mph max" is a rating — but only for an UNASSIGNED value. After "WIND SPEED: 110 MPH" or
 *  "GROUND SNOW LOAD = 25 PSF" a following "MAX ..." / "MAXIMUM ..." is the NEXT field's label
 *  ("MAX RAIL CANTILEVER 16 IN", "MAXIMUM ATTACHMENT SPACING 48 IN"), not a bound on this value. */
const MAX_AFTER = /^\s*(?:psf|mph)?\s*max(?:imum)?\b/i;
/** A product rating printed after the value: "115 MPH RATED", "140 MPH UPLIFT CAPACITY". */
const RATING_AFTER = /^\s*(?:psf|mph)?\s*\(?\s*(?:rat(?:ed|ing)|tested|certified|(?:uplift\s+)?capacity)\b/i;
/** An assigned value that opens a RANGE: "Basic Wind Speed: 110.00 mph - 150.00 mph", "Ground Snow
 *  Load: 0 - 100.00 psf", "Wind Speed: 110 to 150 mph" — a product's applicability, not the site's
 *  value (a racking report's boilerplate "Design Parameters" block, #68). A dash or "to" and then a
 *  second NUMBER; a dash followed by a word opens the next field ("110 MPH - EXPOSURE C"). */
const RANGE_AFTER = /^\s*(?:psf|mph)?\s*(?:[-–—]|to\b)\s*(\d+(?:\.\d+)?)(?![\d.])/i;
/** The second number must exceed the first: a range ascends, while "25 PSF - 2. WIND SPEED …" is
 *  the next list item's number. Refuses the RANGE, never a lone value: "GROUND SNOW LOAD: 0 PSF". */
function rangeAfter(after: string, value: number | null): boolean {
  const r = RANGE_AFTER.exec(after);
  return !!r && value != null && Number(r[1]) > value;
}
function boundAfter(after: string, assigned: boolean, value: number | null = null): boolean {
  return BOUND_AFTER.test(after) || RATING_AFTER.test(after) || (!assigned && MAX_AFTER.test(after))
    || (assigned && rangeAfter(after, value));
}
/** "psf 25" / "mph V 120" split by a PDF: "2 5 PSF", "ASCE 7-1 6". Joined ONLY right after a
 *  field separator and right before the unit — anywhere else two numbers are two numbers. */
function joinSplitDigits(text: string): string {
  return text
    .replace(/([:=]\s*)(\d{1,2}) (\d{1,2})(?=\s*(?:psf|mph)\b)/gi, (all, sep: string, a: string, b: string) => ((a + b).length <= 3 ? `${sep}${a}${b}` : all))
    .replace(/\b(ASCE(?:\/SEI)?\s*7\s*[-–]\s*\d) (\d)\b/gi, "$1$2");
}

function windQualifier(label: string): StatedDesignCriterionQualifier {
  if (/\bv\s*[_(]?\s*asd\b|\bvasd\b|\ballowable\s+stress|\bnominal\b|\basd\b|\bservice(?:ability)?\b/i.test(label)) return "nominal";
  if (/\bv\s*[_(]?\s*ult\b|\bvult\b|\bult(?:imate)?\b|\bstrength\b/i.test(label)) return "ultimate";
  return "unspecified";
}

/** Blank every complete "( … )" group, keeping offsets: "(3-SECOND GUST)", "(ASCE 7-16)". */
function blankParentheticals(text: string): string {
  return text.replace(/\([^()]*\)/g, (p) => " ".repeat(p.length));
}

// Where a wind label STARTS inside the text before a speed — the excerpt begins here.
const WIND_LABEL_START = /(?:\b(?:ultimate|basic|design)\s+)?(?:\bwind|\bv\s*[_(]?\s*(?:ult|asd)\b|\bv(?:ult|asd)\b|\bexp(?:osure|\.))|\bv\s*[:=]?\s*$/i;

function extractWind(text: string, source: string, out: StatedDesignCriterion[]): void {
  const re = /(\d{2,3}(?:\.\d+)?)\s*mph\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    const pre = text.slice(Math.max(0, start - 70), start);
    // The LOCAL label is the text since the previous number: "…Vasd qz = 8.34 psf Basic
    // wind pressure V= 95 mph" must read "Basic wind pressure V=", not the Vasd two
    // numbers back — otherwise an ultimate speed is filed as a nominal one. A number inside a
    // parenthetical is not a previous value: "BASIC WIND SPEED (3-SECOND GUST) = 115 MPH" and
    // "WIND SPEED (ASCE 7-16): 110 MPH" keep their label.
    const lastDigit = blankParentheticals(pre).search(/\d[^\d]*$/);
    const label = lastDigit >= 0 ? pre.slice(lastDigit + 1) : pre;
    const post = text.slice(end, end + 30);
    if (RATING_CONTEXT.test(pre.slice(-30))) continue;
    if (boundAfter(text.slice(end, end + 30), ASSIGNED_BEFORE.test(pre), toNumber(m[1]))) continue;
    if (!ASSIGNED_BEFORE.test(pre) && limitGoverns(text, start)) continue;
    const labelBefore = /wind|\bv\s*[_(]?\s*(?:ult|asd)\b|\bv(?:ult|asd)\b|\bv\s*[:=]\s*$|\bv\s*$/i.test(label);
    // "120 MPH ultimate wind speed", "110 mph (3-sec gust) basic wind" — the label after the value,
    // used ONLY when the value has none before it: in "WIND SPEED: 110 MPH NOMINAL DESIGN WIND
    // SPEED: 85 MPH" the words after 110 are the NEXT field's label, and would make it nominal.
    const windAfter = labelBefore ? null : post.match(/^\s*(?:\(?\s*3[\s-]*sec(?:ond)?\.?[\s-]*gust\s*\)?\s*)?,?\s*(?:(?:ultimate|ult\.?|basic|design|nominal|asd)\s+)?(?:design\s+)?wind\b/i);
    const labelled = labelBefore
      || !!windAfter
      // "Exposure B, 95 mph" — a speed stated inside an exposure clause is the wind speed. Not when
      // the exposure is the last of a TABLE's heads ("EXPOSURE B EXPOSURE C EXPOSURE D 110 MPH 6.0
      // 5.3 …": several different letters, the same test the exposure reader applies), and not
      // when the speed opens a ROW of speeds ("EXPOSURE C 90 MPH 110 MPH 120 MPH").
      || (/\bexp(?:osure)?\.?\s*(?:cat(?:egory)?\.?\s*)?[:=]?\s*[BCD]\s*,?\s*$/i.test(label)
        && new Set([...label.matchAll(/\bexp(?:osure)?\.?\s*(?:cat(?:egory)?\.?\s*)?[:=]?\s*([BCD])(?![A-Za-z0-9])/gi)].map((x) => x[1].toUpperCase())).size < 2
        && !/^\s*,?\s*\d{2,3}(?:\.\d+)?\s*mph\b/i.test(post));
    if (!labelled) continue;
    const value = toNumber(m[1]);
    if (value == null || value < 60 || value > 250) continue;
    const labelAt = label.search(WIND_LABEL_START);
    const excerptStart = labelAt >= 0 ? start - label.length + labelAt : start;
    const excerptEnd = labelAt < 0 && windAfter ? end + windAfter[0].length : end;
    out.push({
      criterion: "windSpeedMph",
      value,
      // A qualifier AFTER the value only when it is attached to it ("120 mph (Vult)") — the
      // next note's "Vasd qz = …" must not reach back and relabel this speed.
      // The value's own label decides first. A qualifier WORD after the value counts only when it
      // does not open the next field ("175 MPH NOMINAL DESIGN WIND SPEED (Vasd): 136 MPH").
      qualifier: windQualifier(label) !== "unspecified" ? windQualifier(label)
        : windQualifier(`${(post.match(/^\s*\(?\s*(?:v\s*[_(]?\s*(?:ult|asd)\b|vult|vasd|(?:ultimate|nominal|asd)\b(?!\s+(?:design\s+|basic\s+)?(?:wind|speed)\b))/i) ?? [""])[0]} ${windAfter ? windAfter[0] : ""}`),
      source,
      derived: false,
      excerpt: excerptAt(text, excerptStart, excerptEnd),
    });
    // "WIND SPEED AND EXPOSURE: 110 MPH, C" — the exposure rides after the speed.
    if (/exposure/i.test(label)) {
      const expAfter = post.match(/^\s*,?\s*(?:exp(?:osure)?\.?\s*)?([BCD])(?![A-Za-z0-9])/i);
      if (expAfter && !EXPOSURE_LIST_AFTER.test(post.slice(expAfter[0].length))) {
        out.push({
          criterion: "windExposure",
          value: expAfter[1].toUpperCase(),
          qualifier: "unspecified",
          source,
          derived: false,
          excerpt: excerptAt(text, excerptStart, end + expAfter[0].length),
        });
      }
    }
  }
  // LABEL FIRST, THE UNIT BEFORE THE VALUE OR NOT PRINTED AT ALL — a letter's design-criteria
  // table ("mph Ult Wind Speed: 110.0", the unit in its own column) and a racking design report
  // ("Wind Speed ASCE 7-10 (3s gust) mph V 120"). The label must be the speed's own ("wind
  // speed", "Vult", "Vasd"); between it and the value only an edition, a parenthetical, the unit
  // and the V symbol. A value followed by a unit is the pass above's; one followed by another
  // number is a table row ("Wind Speed (mph) 110 120 130"), not a statement.
  const labelFirst = /(\b(?:(?:ult(?:imate)?\.?|basic|design|nominal)\s+)?wind\s+speed|\bv\s*[_(]\s*(?:ult|asd)\s*\)?|\bv(?:ult|asd)\b)((?:\s*,?\s*(?:ASCE(?:\/SEI)?\s*7\s*[-–]\s*\d{2}|\([^()]{0,30}\)|\[\s*mph\s*\]|mph\b|v\b))*)\s*([:=])?\s*(\d{2,3}(?:\.\d+)?)(?![\d.])/gi;
  let lf: RegExpExecArray | null;
  while ((lf = labelFirst.exec(text))) {
    const unitBefore = /\bmph\b/i.test(lf[2]) || /\bmph\s*$/i.test(text.slice(Math.max(0, lf.index - 8), lf.index));
    // Without a separator the unit must sit before the value; without either it is a heading
    // followed by some other number.
    if (!lf[3] && !unitBefore) continue;
    const endAt = lf.index + lf[0].length;
    const after = text.slice(endAt, endAt + 24);
    if (/^\s*(?:mph|m\/s|km|kph|psf|%|ft|'|-|–|\/|x\b|sec)/i.test(after)) continue;
    if (/^\s+\d{1,3}(?:\.\d+)?\b/.test(after)) continue;
    const value = toNumber(lf[4]);
    if (value == null || value < 60 || value > 250) continue;
    const before = text.slice(Math.max(0, lf.index - 30), lf.index);
    if (RATING_CONTEXT.test(before) || boundAfter(after, !!lf[3], value)) continue;
    out.push({
      criterion: "windSpeedMph",
      value,
      qualifier: windQualifier(`${lf[1]} ${lf[2]}`),
      source,
      derived: false,
      excerpt: excerptAt(text, lf.index, endAt),
    });
  }
}

// --- exposure / risk ------------------------------------------------------------

// A LIMIT CLAUSE governs the letter — a prescriptive checklist "Wind exposure for structure is
// limited to Exposure Category B or C", "Less than or equal to 120 mph in Exposure Category B".
// Numbers may sit between the limit word and the letter; a field separator (= : ; . •) may not.
// The limit's own field ends where limitSpent says (a number in another unit, a new list item):
// "MAX ROOF SLOPE 30 DEG WIND SPEED 110 MPH EXPOSURE C", "1) ARRAY NOT TO EXCEED ROOF RIDGE 2) WIND
// SPEED 110 MPH EXPOSURE C" state Exposure C.
const EXPOSURE_LIMIT_BEFORE = /(?:\bup\s*to|\bmax(?:imum)?\b|\bmin(?:imum)?\b|\brat(?:ed|ing)\b|\btested\b|\blimit(?:ed|s)?\b|\bexceed(?:s|ing)?\b|\bnot\s+more\s+than|\bless\s+than|\bgreater\s+than|\bor\s+less\b|\bdesigned\s+(?:for|to)\b|≤|≥|<=|>=)([^.;:=•]{0,45})$/i;
function exposureLimitBefore(before: string): boolean {
  const m = EXPOSURE_LIMIT_BEFORE.exec(before);
  return !!m && !limitSpent(m[1]);
}
// A LIST or RANGE of letters is not a stated category: "B or C", "C/D", "B, C and D", "B-D".
const EXPOSURE_LIST_AFTER = /^\s*(?:,|\/|&|\bor\b|\band\b|\bto\b|\bthrough\b|[-–])\s*(?:exp(?:osure|\.)?\s*(?:cat(?:egory|\.)?\s*)?)?[BCD](?![A-Za-z0-9])/i;
// "EXPOSURE B RATING", "Exposure C rated" — a product rating, not the site's category.
const EXPOSURE_RATING_AFTER = /^\s*(?:rat(?:ed|ing)|tested|or\s+(?:less|lower|greater|more|higher)\b|and\s+(?:below|above|less|greater)\b|limit)/i;
// A bare "exposure X" is the WIND exposure only beside wind ("Exposure B, 95 mph", "110 mph
// Exposure C"); "roof exposure c. site is open" and "SUN EXPOSURE" are not.
const WIND_NEARBY = /\bwind\b|\bmph\b|\bv\s*[_(]?\s*(?:ult|asd)\b|\bv(?:ult|asd)\b/i;

function extractExposureAndRisk(text: string, source: string, out: StatedDesignCriterion[]): void {
  const candidates: Array<{ at: number; end: number; letter: string }> = [];
  const exposurePatterns: RegExp[] = [
    // "EXPOSURE CATEGORY = C", "Wind exposure category: C", "Exposure B", "EXPOSURE: D". The
    // lookahead refuses "Exposure Factor", "EXPOSURE AND WET LOCATIONS", "Exposure category Ce"
    // (snow Ce, not Exp. C) and "Exposure Category (ASCE 7-22 Table …)" (a heading, no value).
    /\b(?:wind\s+)?exposure(?:\s+cat(?:egory|\.)?)?\s*[:=-]?\s*([BCD])(?![A-Za-z0-9])/gi,
    /\bexp\.\s*(?:cat(?:egory|\.)?\s*)?[:=]?\s*([BCD])(?![A-Za-z0-9])/gi,
    // A Washington cover sheet's "WIND EXPOSURE FACTOR: C" — the category under a looser word.
    // Only with "wind" in front and an assigned letter; the snow "Exposure Factor, C e : 0.9"
    // is neither.
    /\bwind\s+exposure\s+(?:factor|class|type)\s*[:=]\s*([BCD])(?![A-Za-z0-9])/gi,
  ];
  for (const re of exposurePatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const at = m.index;
      const end = at + m[0].length;
      // A design-criteria LABEL: "exposure category", "wind exposure", "Exp. Cat.". A bare
      // "exposure X" / "Exp. X" needs wind beside it.
      const strong = /\bwind\s+exposure|\bcat(?:egory|\.)?/i.test(m[0]);
      if (!strong && !WIND_NEARBY.test(text.slice(Math.max(0, at - 40), at)) && !WIND_NEARBY.test(text.slice(end, end + 40))) continue;
      // An ASSIGNED value ("EXPOSURE CATEGORY = C", "Wind exposure category: C") is a statement
      // whatever precedes it ("PER ASCE 7-16 MINIMUM DESIGN LOADS … EXPOSURE CATEGORY = C"); the
      // checklist's limit clauses never assign ("limited to Exposure Category B", "in Exposure
      // Category C").
      if (!/[:=]/.test(m[0]) && exposureLimitBefore(text.slice(Math.max(0, at - 60), at))) continue;
      // …and the same limit further back in the sentence, across a form's ": Yes No ( check
      // one ) 120 mph in Wind Exposure Category C" (the per-field check above stops at a colon).
      if (!/[:=]/.test(m[0]) && limitGoverns(text, at)) continue;
      const after = text.slice(end, end + 30);
      if (EXPOSURE_LIST_AFTER.test(after) || EXPOSURE_RATING_AFTER.test(after)) continue;
      // "Exposure C max" bounds an UNASSIGNED letter; after "EXPOSURE CATEGORY: C" a "MAX. ..." is the next field.
      if (!/[:=]/.test(m[0]) && /^\s*max(?:imum)?\b/i.test(after)) continue;
      if (candidates.some((c) => c.at === at)) continue;
      candidates.push({ at, end, letter: m[1].toUpperCase() });
    }
  }
  // A TABLE, not a statement: several different exposure letters in a row ("EXPOSURE B
  // EXPOSURE C EXPOSURE D" span-table column heads) — none of them is the site's category.
  const tabular = (c: { at: number; end: number; letter: string }): boolean =>
    candidates.some((o) => o !== c && o.letter !== c.letter && (Math.abs(o.at - c.end) <= 40 || Math.abs(c.at - o.end) <= 40));
  for (const c of candidates) {
    if (tabular(c)) continue;
    out.push({ criterion: "windExposure", value: c.letter, qualifier: "unspecified", source, derived: false, excerpt: excerptAt(text, c.at, c.end) });
  }
  // Engineering software's summary table: "Exposure and Occupancy Categories B II".
  const combined = /\bexposure\s+and\s+(?:occupancy|risk)\s+categor(?:y|ies)\s*[:=]?\s*([BCD])\s+(IV|I{1,3}|[1-4])(?![A-Za-z0-9])/gi;
  let c: RegExpExecArray | null;
  while ((c = combined.exec(text))) {
    const ex = excerptAt(text, c.index, c.index + c[0].length);
    out.push({ criterion: "windExposure", value: c[1].toUpperCase(), qualifier: "unspecified", source, derived: false, excerpt: ex });
    out.push({ criterion: "riskCategory", value: normRisk(c[2]), qualifier: "unspecified", source, derived: false, excerpt: ex });
  }
  const risk = /\brisk\s+cat(?:egory|\.)?\s*[:=-]?\s*(IV|I{1,3}|[1-4])(?![A-Za-z0-9])/gi;
  let r: RegExpExecArray | null;
  while ((r = risk.exec(text))) {
    // "Risk Category I or II" (a checklist's list), "do not exceed Risk Category II" (a bound),
    // "Risk Category II or less": a range or a limit, never the building's category.
    const riskAfter = text.slice(r.index + r[0].length, r.index + r[0].length + 30);
    if (/^\s*(?:,|\/|&|\bor\b|\band\b|\bto\b|\bthrough\b|[-–])\s*(?:risk\s+cat(?:egory|\.)?\s*)?(?:IV|I{1,3}|[1-4])(?![A-Za-z0-9])/i.test(riskAfter)) continue;
    // A form's choices printed in a row: "Identify Risk Category: I II III IV".
    if (/^\s+(?:IV|I{1,3})\s+(?:IV|I{1,3})(?![A-Za-z0-9])/.test(riskAfter)) continue;
    if (/^\s*(?:or\s+(?:less|lower|greater|more|higher)\b|and\s+(?:below|above|less|greater)\b)/i.test(riskAfter)) continue;
    if (!/[:=]/.test(r[0]) && limitGoverns(text, r.index)) continue;
    out.push({ criterion: "riskCategory", value: normRisk(r[1]), qualifier: "unspecified", source, derived: false, excerpt: excerptAt(text, r.index, r.index + r[0].length) });
  }
  const asce = /\bASCE(?:\/SEI)?\s*7\s*[-–]\s*(\d{2})\b/gi;
  let a: RegExpExecArray | null;
  while ((a = asce.exec(text))) {
    out.push({ criterion: "asce7Edition", value: `7-${a[1]}`, qualifier: "unspecified", source, derived: false, excerpt: excerptAt(text, a.index, a.index + a[0].length) });
  }
}

// --- seismic design category and frost depth -----------------------------------

// "Seismic Design Category D1", "SEISMIC DESIGN CATEGORY = D", "SDC: C", "Seismic Cat. B". Never
// "Seismic Site Class D" (soil, not the SDC) and never "Seismic Design Categories A, B and C" (a
// prescriptive limit — the plural does not match). The category is read case-SENSITIVELY after a
// case-insensitive label: "seismic design category and …" must not read "a" as SDC A.
const SDC_LABEL = /\b(?:seismic\s+(?:design\s+)?cat(?:egory|\.)|SDC)(?:\s*\(\s*SDC\s*\))?\s*[:=-]?\s*(D[012]|[A-F])(?![A-Za-z0-9])/gi;
const SDC_LIST_AFTER = /^\s*(?:,|\/|&|\bor\b|\band\b|\bto\b|\bthrough\b|[-–])\s*(?:D[012]|[A-F])(?![A-Za-z0-9])/;

// "FROST DEPTH = 24 IN", "Frost line depth: 30\"", "FROST DEPTH 2'-6\"", "frost depth of 3 ft", and
// value-first "36\" FROST DEPTH". A footing note ("EXTEND 12 IN BELOW FROST DEPTH") states the
// footing's embedment, not the frost depth: value-first needs the value directly before the label.
const FROST_VALUE = String.raw`(\d+(?:\.\d+)?)\s*(?:(in(?:ch(?:es)?)?\b\.?|["”]|'')|(ft\b\.?|feet\b|foot\b|['’])(?:\s*[-–]?\s*(\d+(?:\.\d+)?)\s*(?:in(?:ch(?:es)?)?\b\.?|["”]|''))?)`;
const FROST_LABEL_FIRST = new RegExp(String.raw`\bfrost\s+(?:line\s+)?depth\b(?:\s+(?:of|is))?\s*[:=]?\s*(?:min(?:imum)?\.?\s*)?${FROST_VALUE}`, "gi");
const FROST_VALUE_FIRST = new RegExp(String.raw`(?<![\d.])${FROST_VALUE}\s*(?:min(?:imum)?\.?\s+)?frost\s+(?:line\s+)?depth\b`, "gi");
const FROST_RANGE_AFTER = /^\s*(?:[-–—]|to\b|or\b)\s*\d/i;

function frostInches(m: RegExpExecArray): number | null {
  const n = toNumber(m[1]);
  if (n == null) return null;
  const inches = m[3] ? n * 12 + (m[4] ? toNumber(m[4]) ?? 0 : 0) : n;
  // A frost depth is a depth below grade: 0 < d <= 120 in. Anything else is another number.
  return inches > 0 && inches <= 120 ? inches : null;
}

function extractSeismicAndFrost(text: string, source: string, out: StatedDesignCriterion[]): void {
  let m: RegExpExecArray | null;
  SDC_LABEL.lastIndex = 0;
  while ((m = SDC_LABEL.exec(text))) {
    if (m[1] !== m[1].toUpperCase()) continue;
    const end = m.index + m[0].length;
    const after = text.slice(end, end + 30);
    if (SDC_LIST_AFTER.test(after)) continue;
    if (/^\s*(?:or\s+(?:less|lower|greater|more|higher)\b|and\s+(?:below|above|less|greater)\b)/i.test(after)) continue;
    if (!/[:=]/.test(m[0]) && limitGoverns(text, m.index)) continue;
    out.push({ criterion: "seismicDesignCategory", value: m[1], qualifier: "unspecified", source, derived: false, excerpt: excerptAt(text, m.index, end) });
  }
  for (const re of [FROST_LABEL_FIRST, FROST_VALUE_FIRST]) {
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length;
      if (re === FROST_LABEL_FIRST && FROST_RANGE_AFTER.test(text.slice(end, end + 12))) continue;
      const inches = frostInches(m);
      if (inches == null) continue;
      out.push({ criterion: "frostDepthIn", value: inches, qualifier: "unspecified", source, derived: false, excerpt: excerptAt(text, m.index, end) });
    }
  }
}

// --- snow ------------------------------------------------------------------

/** Which label an UNSEPARATED psf value belongs to, inside a run of load labels and values. */
type LoadValueOwner = "prev" | "next" | "both";
/** A value's owner, and whether its run is a value-first LIST (opens with a value and alternates at
 *  least V L V L): the only place a bare "Pg" printed after a value reads it (pgAfter). */
interface LoadValueRun { owner: LoadValueOwner; valueFirstList: boolean }

/**
 * AN ASSIGNING SEPARATOR between a label and its value: ":", "=", or a SPACED dash ("GROUND SNOW LOAD
 * - 36 PSF", "36 PSF – GROUND SNOW LOAD"). A dash touching a digit is a sign ("C&C PRESSURE -16 PSF")
 * or a range/edition ("ASCE 7-16"), never a separator. Measured: with the dash unrecognised, "ROOF
 * DEAD LOAD - 3 PSF GROUND SNOW LOAD - 36 PSF" split into a value-first "3 PSF GROUND SNOW LOAD" and
 * read Pg 3 (a BLOCKER on a correct plan). ONE definition, used by the run glue, evidenceBefore and
 * every label reader — each place that knew only ":"/"=" was a place the mirror image slipped through.
 *
 * EVERY DASH GLYPH A SHEET PRINTS IS THE SAME DASH: the hyphen, the en dash, the em dash Word and
 * InDesign emit ("GROUND SNOW LOAD — 36 PSF"), a double hyphen ("-- 36 PSF"), and a run of DOT LEADERS
 * — the commonest title-block table fill ("GROUND SNOW LOAD ..... 36 PSF"). With only "-"/"–" known,
 * "ROOF DEAD LOAD — 3 PSF GROUND SNOW LOAD — 36 PSF" and its dot-leader twin split exactly the way the
 * unrecognised hyphen did (Pg 3, a BLOCKER on a correct plan). A single full stop is not a leader
 * ("DEAD LOAD 10 psf. GROUND SNOW LOAD 36 PSF" ends a sentence), and a dash touching a digit is still a
 * sign or an edition ("ASCE 7—16").
 */
const DASH = String.raw`(?:[-–—]|--|\.{2,})`;
const SEP = String.raw`(?:[:=]|(?<=\s)${DASH}(?=\s))`;
/** A separator the regex captured: a DASH assigns only through the run's ownership (it is also how
 *  some sheets join list items), unlike ":"/"=" which assign outright. */
const isDashSep = (sep: string | undefined): boolean => !!sep && /[-–—.]/.test(sep) && !/[:=]/.test(sep);
/** Text that ends in ":"/"=" or a spaced dash — the separator that hands the value after it to the label before it. */
const SEP_BEFORE = new RegExp(String.raw`(?:[:=]|\s${DASH}(?=\s))\s*$`);
/** …and that separator directly after a label word or a closing parenthesis (not after a heading or nothing). */
const LABEL_SEP_BEFORE = new RegExp(String.raw`[A-Za-z)]\s*(?:[:=]|${DASH}(?=\s))\s*$`);
/** A gap holding an assigning separator: never two side-by-side cells of a table. */
const SEP_IN_GAP = new RegExp(String.raw`[:=]|\s${DASH}\s`);
/** A value with a MINUS sign ("C&C PRESSURE -16 PSF", "ZONE 1: -16.5 PSF") is a wind pressure, never
 *  a load: a dash touching the digit that is not inside a range or an edition ("7-16"). Measured: a
 *  column-major table's "-16 PSF GROUND SNOW LOAD" read as Pg 16 (a BLOCKER on a correct 36 psf plan). */
const NOT_NEGATIVE = String.raw`(?<![\d.])(?<!(?:^|[^\w.])[-−])`;
/** What follows a formula's COEFFICIENT: a multiplication, a parenthesised factor, or a code
 *  coefficient ("0.7 x 1.0", "0.7 (1.0)(1.1)", "0.7 Ce Ct Is"). */
const COEFFICIENT_TAIL = String.raw`\s*(?:[×*·⋅]|x(?=\s*[\d(A-Za-z])|\(\s*\d|C[etsa]\b|Is\b)`;
/** A separator and a number that is not a formula coefficient: a label ASSIGNING its own value. */
const ASSIGNS_OWN_VALUE = String.raw`\s*[:=]\s*\d+(?:\.\d+)?(?![\d.])(?!${COEFFICIENT_TAIL})`;
const COEFFICIENT_AFTER = new RegExp(`^${COEFFICIENT_TAIL}`, "i");
/** Right after a label: it assigns its own value ("GROUND SNOW LOAD = 25"), not a coefficient
 *  ("ROOF SNOW LOAD pf = 0.7 x Ce x …" is the calculation line, not the roof snow load 0.7). */
const OWN_VALUE_AFTER = new RegExp(`^${ASSIGNS_OWN_VALUE}`, "i");
/** …and allowing the label's tail first: "LOAD", its symbol, a parenthetical ("(Pg)"). */
const LABEL_OWN_VALUE_AFTER = new RegExp(String.raw`^(?:\s+loads?)?(?:\s*,?\s*p\s?[gfsm]\b)?(?:\s*\([^()]{0,40}\))?${ASSIGNS_OWN_VALUE}`, "i");

// A load LABEL, as a design-loads list prints it: "GROUND SNOW", "FLAT ROOF SNOW LOAD", "ROOF DEAD
// LOAD", "PV DEAD LOAD", "PV WEIGHT", "GROUND SNOW LOAD (Pg)" — and the short forms plan sets print
// beside them: "DL", "ROOF DL", "LL", "ROOF LIVE", "RACKING", "COLLATERAL", "PV MODULES", a bare "Pg" —
// and a calculation's other psf quantities: "qz"/"qh" (velocity pressure), "WIND PRESSURE", "p net".
// Measured on the production copy: a calc summary's "qz 13.74 psf pg 28.00 psf Ground Snow Load pg"
// read 13.74 as a second Pg while "qz" was not a label.
// A heading ("DESIGN LOADS", "SNOW LOADS:") is not one: it names no load (dropped in loadValueOwners).
// A label of a NON-psf quantity ("WIND SPEED") is deliberately not one either: in "110 MPH WIND SPEED
// 36 PSF GROUND SNOW" it would open the run as a label and take the 36.
const LOAD_LABEL_TOKEN = /\b(?:(?:(?:ground|roof|flat|sloped|total|design|balanced|minimum|pv|floor|array|system|module|dead)\s+){0,2}(?:snow(?:\s+loads?)?|(?:dead|live|wind|collateral|seismic)\s+loads?|weight)\b(?:\s*,?\s*p\s?[gfsm]\b)?(?:\s*\([^()]{0,40}\))?(?:\s*,?\s*asd\b)?|(?:roof\s+)?(?:dl|ll)\b|roof\s+live\b|racking(?:\s+weight)?\b|collateral\b|pv\s+(?:modules?|panels?|array)(?:\s+weight)?\b|p\s?g\b(?!\s*\(\s*asd)|q\s?[zh]\b|(?:velocity|wind|design\s+wind)\s+pressures?\b|p\s?net\b)/gi;
const LOAD_VALUE_TOKEN = new RegExp(String.raw`${NOT_NEGATIVE}\b\d+(?:\.\d+)?\s*(?:psf\b|lbs?\/?(?:sq\.?\s*ft|ft2|ft²))(?:\s*\(\s*asd\s*\))?`, "gi");
/** A HEADING over a list, not a label of one load: "SNOW LOADS", "DESIGN SNOW LOADS" (plural, bare). */
const HEADING_LABEL = /^(?:design\s+)?snow\s+loads$/i;
/** Text that ENDS in a heading: "DESIGN LOADS", "SNOW LOADS:", "DESIGN CRITERIA -", "LOADS". */
const HEADING_BEFORE = /\b(?:loads|criteria|parameters|notes|summary|information)\s*[:\-–—]?\s*$/i;
/** Text that ends in a label or value of a NON-psf quantity, or in a unit: it cannot own a psf value. */
const OTHER_QUANTITY_BEFORE = /(?:\b(?:wind(?:\s+speed)?|speed|v\s*ult|vult|v\s*asd|vasd|exposure(?:\s+cat(?:egory|\.)?)?|risk(?:\s+cat(?:egory|\.)?)?|occupancy(?:\s+cat(?:egory|\.)?)?|asce(?:\s*7)?|mph|psf|ft|feet|in|inch(?:es)?|deg(?:rees)?|kw|kwdc|kwac|v|a|amps?)|\d|["'”’°%])\s*[:=]?\s*$/i;
/** Prose words: "USE 36 PSF GROUND SNOW", "a ground snow load of 36 psf", "MINIMUM 25 PSF". */
const PROSE_WORD = new Set("of a an the for at to with is are be been was were use using used per and or by on in from than least minimum maximum min max approx approximately design designed provide submit based when where if as include includes including shall must should will not no nor that which this these those its their our your has have had see".split(" "));

/**
 * What the text just BEFORE a run's opening value says about who owns it:
 *   · "assign" — a label assigns it with ":"/"=" ("LIVE: 20 PSF", "EXISTING ROOF = 10 PSF");
 *   · "label"  — a word that reads as a load label this reader does not list ("EXISTING ROOF 10 PSF",
 *                "MODULE RAILS 3 PSF"): evidence the run is label-first, its first value that word's;
 *   · "none"   — start of text, a heading, punctuation, prose, or another quantity's label/value.
 */
function evidenceBefore(text: string, at: number): "assign" | "label" | "none" {
  const before = text.slice(Math.max(0, at - 60), at);
  if (!before.trim()) return "none";
  if (HEADING_BEFORE.test(before)) return "none";
  if (OTHER_QUANTITY_BEFORE.test(before)) return "none";
  // ":"/"=" or a spaced dash ("ROOF DEAD LOAD - 3 PSF", "— 3 PSF", "..... 3 PSF"); a dash touching the value is its sign.
  if (SEP_BEFORE.test(before)) return LABEL_SEP_BEFORE.test(before) ? "assign" : "none";
  const word = before.match(/([A-Za-z][A-Za-z'.\-]*)\s*$/)?.[1];
  if (!word || word.length < 2) return "none";
  if (PROSE_WORD.has(word.toLowerCase().replace(/\.$/, ""))) return "none";
  return "label";
}

/** A label-ish word right AFTER a run's closing value that has no value of its own ("… 25 PSF
 *  PURLINS"): evidence the run is value-first, the closing value that word's. */
function unvaluedLabelAfter(text: string, end: number): boolean {
  const after = text.slice(end, end + 50);
  const m = after.match(/^\s*[,;]?\s*([A-Za-z][A-Za-z'\-]*)/);
  if (!m || m[1].length < 2) return false;
  const word = m[1].toLowerCase();
  if (PROSE_WORD.has(word)) return false;
  if (/^(?:wind|exposure|risk|occupancy|asce|seismic|speed|mph|psf|code|codes|note|notes|sheet|see|per)$/.test(word)) return false;
  // Its own value follows within a few words: a label of the next item, not a claimant — unless a
  // load label comes first and the number is THAT label's ("… 10 PSF EXISTING ROOF GROUND SNOW LOAD =
  // 25.2 PSF (ASD)": EXISTING ROOF has no value of its own).
  // A formula's coefficient ("EXISTING ROOF pf = 0.7 x Ce …") is no value of its own either.
  const rest = after.slice(m[0].length, m[0].length + 30);
  const own = [...rest.matchAll(/\d+(?:\.\d+)?/g)].find((n) => !COEFFICIENT_AFTER.test(rest.slice((n.index ?? 0) + n[0].length)));
  if (!own) return true;
  const digit = own.index ?? 0;
  const label = rest.search(new RegExp(LOAD_LABEL_TOKEN.source, "i"));
  return label >= 0 && label < digit;
}

/**
 * THE LAYOUT OF A DESIGN-LOADS LIST DECIDES WHICH LABEL A VALUE BELONGS TO. With no separator, a
 * value between two labels reads both ways: "ROOF DEAD LOAD 3 PSF GROUND SNOW LOAD 36 PSF" is
 * label-first (the 3 is the dead load's), "36 PSF GROUND SNOW 25 PSF ROOF SNOW 10 PSF DEAD LOAD" is
 * value-first (the 25 is the ROOF snow's). The extractor reads flattened text (readSources), so a
 * vertical list and a one-line list are the same run — the run's own shape is the only evidence.
 *
 * A RUN is labels and psf values alternating with nothing but spaces, commas, semicolons, ":", "=" or
 * a spaced dash (SEP) between them. LABEL-FIRST IS THE DEFAULT; value-first needs POSITIVE evidence. Three rounds of
 * fixes each closed one layout and opened its mirror image, so each rule below is one reading of
 * the evidence, and a run the evidence cannot settle is "both" — read both ways, its values UNSURE
 * (extractSnowBothWays), and never a blocker (readGroundSnow):
 *   · opens with a LABEL (or a value a label outside the list assigns with ":"/"=") -> label-first.
 *     A label left over at the end has no value; it never makes the run ambiguous.
 *   · opens with a VALUE and closes with a LABEL (V L, V L V L …) -> value-first: every value has
 *     the label after it. Ambiguous only when a label-ish word (not a heading, not prose) sits just
 *     before the opening value and no value is followed by ":"/"=" and its label.
 *   · opens AND closes with a VALUE (V L V …) -> one value is left over either way: label-first if
 *     a label-ish word precedes the run, value-first if an unvalued label-ish word follows it (or a
 *     value is followed by ":"/"=" and its label), and "both" when the evidence is on neither side
 *     or on both ("DESIGN LOADS 36 PSF GROUND SNOW 25 PSF").
 *   · opens with a VALUE but a separator hands a value to the label BEFORE it ("36 PSF GROUND SNOW
 *     LOAD - 25 PSF …"): the separator and the shape disagree -> "both", unless a label-ish word
 *     before the run owns the opening value (then label-first throughout).
 *   · two labels or two values side by side anywhere in the block (a flattened TABLE) -> "both".
 * Keyed by the value's start index.
 */
function loadValueOwners(text: string): Map<number, LoadValueRun> {
  const tokens: Array<{ kind: "L" | "V"; start: number; end: number }> = [];
  for (const [kind, re] of [["L", LOAD_LABEL_TOKEN], ["V", LOAD_VALUE_TOKEN]] as const) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (kind === "L" && HEADING_LABEL.test(m[0].trim())) continue;
      tokens.push({ kind, start: m.index, end: m.index + m[0].length });
    }
  }
  tokens.sort((a, b) => a.start - b.start || b.end - a.end);
  const clean: typeof tokens = [];
  for (const t of tokens) if (!clean.length || t.start >= clean[clean.length - 1].end) clean.push(t);
  const owners = new Map<number, LoadValueRun>();
  const between = (a: { end: number }, b: { start: number }): string => text.slice(a.end, b.start);
  const glue = new RegExp(String.raw`^(?:[\s,;]|${SEP})*$`);
  const sepIn = new RegExp(SEP);
  // A FLATTENED TABLE is not a list: pdf.js prints a header row then a value row ("DEAD LOAD LIVE
  // LOAD GROUND SNOW LOAD 10 PSF 20 PSF 36 PSF"), or a column-major table ("36 PSF 25 PSF 3 PSF GROUND
  // SNOW LOAD ROOF SNOW LOAD DEAD LOAD"). Read as runs, each put its first value beside the ground
  // label (Pg 10, Pg 3 — BLOCKERs on correct plans). A BLOCK (tokens joined by nothing but glue) in
  // which two LABELS or two VALUES sit side by side is a table the alternation cannot map, so every
  // value in it is "both": read, but UNSURE — a warning naming the readings, never a blocker.
  // Not a table: a pair that only CLOSES an alternating segment and opens the next — "… 10 PSF DEAD
  // LOAD | ROOF LIVE LOAD: 20 PSF" (a value-first list, then a label-first line: V L L), "GROUND SNOW
  // LOAD 16 PSF | 10 PSF DEAD LOAD" (L V V). Flattened text runs sections together, so that boundary
  // is everywhere on a real sheet; a table's pair opens its block or follows another same-kind token.
  // A table's cells may be quantities this reader does not tokenise: "ROOF SNOW LOAD C&C PRESSURE
  // GROUND SNOW LOAD 25 PSF -16 PSF 36 PSF", "16 PSF 110 MPH 10 PSF GROUND SNOW LOAD WIND SPEED …". So
  // two LABELS are side by side across a short gap with no number, no separator and no "no value"
  // mark (N/A, NONE); two VALUES across a gap of nothing but other values ("110 MPH", "-16 PSF", an
  // exposure "C", a risk category "II") — a WORD between two values is a label ("GROUND SNOW LOAD 36
  // PSF EXISTING ROOF 10 PSF").
  const sideBySide = (a: { kind: "L" | "V"; end: number }, b: { kind: "L" | "V"; start: number }): boolean => {
    const gap = between(a, b);
    if (glue.test(gap)) return true;
    if (a.kind !== b.kind || SEP_IN_GAP.test(gap)) return false;
    return a.kind === "L"
      ? gap.length <= 40 && !/\d/.test(gap) && !/\b(?:n\/?a|none|tbd)\b/i.test(gap)
      : /^(?:[\s,;]|[-−]?\d+(?:\.\d+)?\s*(?:[mM][pP][hH]|[pP][sS][fF]|[kK][pP][aA])?\b|\b(?:[BCD]|I{1,3}|IV)\b)*$/.test(gap);
  };
  const blockOf: number[] = [];
  const tableBlocks = new Set<number>();
  clean.forEach((t, k) => {
    const joined = k > 0 && sideBySide(clean[k - 1], t);
    blockOf[k] = k === 0 ? 0 : joined ? blockOf[k - 1] : blockOf[k - 1] + 1;
    if (!joined || clean[k - 1].kind !== t.kind) return;
    // V L | L …: the first label closes a value-first segment (a trailing label reads the same either way).
    // L V | V L: the first value closes a label-first segment AND the second opens a value-first one —
    // an orphan value at the end ("EXISTING ROOF GROUND SNOW LOAD 10 PSF 36 PSF", a header row whose
    // first cell is a label this reader does not list) is a table.
    const after = (): boolean => k + 1 < clean.length && clean[k + 1].kind !== t.kind && sideBySide(t, clean[k + 1]);
    const closesSegment = k >= 2 && blockOf[k - 2] === blockOf[k] && clean[k - 2].kind !== t.kind && (t.kind === "L" || after());
    if (!closesSegment) tableBlocks.add(blockOf[k]);
  });
  const indexOf = new Map(clean.map((t, k) => [t, k] as const));
  // A STRAY VALUE JUST BEFORE A LABEL-FIRST RUN. A value-first list is BROKEN by a token the glue does not
  // recognise — a parenthetical after the value ("36 PSF (ULT.)", "36 PSF (1.72 KPA)"), a footnote mark
  // ("36 PSF*"), a full stop ("36 psf."), a unit spelt oddly ("36 P.S.F.", pdf.js's "36 P SF") or no unit
  // at all ("36 GROUND SNOW LOAD") — and the fragment that opens with the ground label then read SURE
  // label-first, taking the NEXT label's value: "36 PSF (ULT.) GROUND SNOW LOAD 25 PSF ROOF SNOW LOAD" was
  // Pg 25, a BLOCKER on a correct plan (a 16 psf plan in the same shapes blocked naming 10). ONE RULE, no
  // new tokens: a run that opens with a label, just after a value no label-first run owns, is "both" —
  // read both ways, its values unsure, a warning naming the readings, never a blocker. The stray value is
  // either a value token whose run is not label-first, parted from the label by nothing but decoration (a
  // complete parenthetical, ",;.*", a separator), or a bare number — then at most two short unit-ish words
  // — ending the text since the previous token. Not a stray value: one a label before it owns ("ROOF DEAD
  // LOAD 3 PSF (TYP.) GROUND SNOW LOAD 36 PSF"), one inside an unbalanced parenthesis ("ROOF LIVE LOAD
  // 20 PSF (0 PSF UNDER PV), GROUND SNOW 36 PSF" — a production shape), a list marker ("2. GROUND SNOW
  // LOAD", "2)"), a speed ("110 MPH GROUND SNOW LOAD"), an edition ("ASCE 7-16"), a sign ("-16 PSF").
  const decorationOnly = new RegExp(String.raw`^(?:[\s,;.*†]|${SEP})*$`);
  const bareNumberTail = new RegExp(String.raw`(?<![\d.\-–—−])\d+(?:\.\d+)?(?=[\s:=])\s*(?:(?!mph\b)[A-Za-z][A-Za-z.\/²]{0,8}\s*){0,2}(?:[\s,;.*†]|${SEP})*$`, "i");
  /** Values whose run OPENS with a label token: owned by that label, whatever follows them. */
  const labelLed = new Set<number>();
  const strayValueBefore = (first: (typeof clean)[number]): boolean => {
    const k = indexOf.get(first)!;
    const p = k > 0 ? clean[k - 1] : undefined;
    const seg = blankParentheticals(text.slice(p ? p.end : 0, first.start));
    if (p?.kind === "V" && decorationOnly.test(seg)) {
      if (owners.get(p.start)?.owner !== "prev") return true;
      // "10 PSF EXISTING ROOF 36 PSF (ULT.) GROUND SNOW LOAD …": a LONE value owned only by the label-ish
      // word before it, when that word sits between it and another lone value — the word is either
      // value's (the 10's trailing label, or the 36's leading one), so the 36 is not surely owned. Not
      // after a label-led value ("ROOF SNOW LOAD 25 PSF (TYP.) EXISTING ROOFING 10 PSF (TYP.) GROUND SNOW
      // LOAD 36 PSF": the 25 is ROOF SNOW LOAD's, so EXISTING ROOFING opens the next item), and not
      // when the word assigns ("EXISTING ROOF: 36 PSF").
      const q = k > 1 ? clean[k - 2] : undefined;
      if (!labelLed.has(p.start) && q?.kind === "V" && !labelLed.has(q.start) && evidenceBefore(text, p.start) !== "assign") return true;
    }
    // "10 PSF EXISTING ROOF 36 GROUND SNOW LOAD 3 PSF …": a bare number after an unlisted label is stray too.
    return bareNumberTail.test(seg.slice(-40));
  };
  let i = 0;
  while (i < clean.length) {
    const run = [clean[i]];
    while (i + 1 < clean.length && clean[i + 1].kind !== run[run.length - 1].kind && glue.test(between(run[run.length - 1], clean[i + 1]))) {
      run.push(clean[++i]);
    }
    i++;
    const first = run[0];
    let last = run[run.length - 1];
    // A label at the end that assigns its own bare number ("GROUND SNOW LOAD = 25") closes with a value.
    const lastAssignsOwn = last.kind === "L" && OWN_VALUE_AFTER.test(text.slice(last.end, last.end + 40));
    const closesWithValue = last.kind === "V" || lastAssignsOwn;
    if (lastAssignsOwn && run.length > 1) last = run[run.length - 2];
    // "36 PSF: GROUND SNOW LOAD", "36 PSF - GROUND SNOW LOAD" — a value a separator hands to the label AFTER it.
    const valueFirstMarked = run.some((t, k) => t.kind === "V" && k + 1 < run.length && sepIn.test(between(t, run[k + 1])));
    // "GROUND SNOW LOAD - 25 PSF" inside a run that OPENS with a value: the separator hands the 25 to
    // the label BEFORE it — the opposite of the run's value-first shape. Evidence both ways.
    const labelFirstMarked = run.some((t, k) => t.kind === "L" && k + 1 < run.length && sepIn.test(between(t, run[k + 1])));
    let owner: LoadValueOwner;
    if (first.kind === "L") {
      owner = strayValueBefore(first) ? "both" : "prev";
    } else {
      const before = evidenceBefore(text, first.start);
      if (before === "assign") owner = "prev";
      else if (labelFirstMarked) owner = before === "label" && !valueFirstMarked ? "prev" : "both";
      else if (!closesWithValue) owner = before === "label" && !valueFirstMarked ? "both" : "next";
      else {
        const lf = before === "label";
        const vf = valueFirstMarked || unvaluedLabelAfter(text, last.end);
        owner = lf && !vf ? "prev" : vf && !lf ? "next" : "both";
      }
    }
    // A value-first LIST: opens with a value and alternates at least V L V L.
    const valueFirstList = first.kind === "V" && run.length >= 4;
    if (tableBlocks.has(blockOf[indexOf.get(first)!])) owner = "both";
    for (const t of run) {
      if (t.kind !== "V") continue;
      owners.set(t.start, { owner, valueFirstList });
      if (first.kind === "L") labelLed.add(t.start);
    }
  }
  return owners;
}

/**
 * READ A TEXT'S SNOW LOADS BOTH WAYS. An ambiguous run ("both") is read once as label-first and once
 * as value-first. A reading BOTH passes give is SURE; one only a single pass gives is UNSURE — the
 * extractor itself could not tell which label its value belongs to. Both are reported (so the
 * conflict shows), and `unsure` gets the keys (criterion|qualifier|value) of the unsure ones.
 */
function extractSnowBothWays(text: string, source: string, out: StatedDesignCriterion[], unsure: Set<string>): void {
  const owners = loadValueOwners(text);
  const passes = (["prev", "next"] as const).map((mode) => {
    const found: StatedDesignCriterion[] = [];
    extractSnow(text, source, found, owners, mode);
    return found;
  });
  const keyOf = (c: StatedDesignCriterion): string => `${c.criterion}|${c.qualifier}|${c.value}`;
  const inPass = passes.map((p) => new Set(p.map(keyOf)));
  const seen = new Set<string>();
  for (const c of [...passes[0], ...passes[1]]) {
    const k = keyOf(c);
    if (!(inPass[0].has(k) && inPass[1].has(k))) unsure.add(k);
    if (seen.has(`${k}|${c.excerpt}`)) continue;
    seen.add(`${k}|${c.excerpt}`);
    out.push(c);
  }
}

function extractSnow(text: string, source: string, out: StatedDesignCriterion[], owners: Map<number, LoadValueRun>, mode: "prev" | "next"): void {
  /** Who owns the unseparated value at `at` in THIS pass: an ambiguous run is read the pass's way. */
  const ownerAt = (at: number): LoadValueOwner | undefined => {
    const o = owners.get(at)?.owner;
    return o === "both" ? mode : o;
  };
  const push = (criterion: StatedDesignCriterionKind, qualifier: StatedDesignCriterionQualifier, raw: string, m: RegExpExecArray): void => {
    const value = toNumber(raw);
    // A 0 psf ROOF snow is "not applicable" ("Minimum Roof Snow Load, p m [psf]: 0"). A 0 psf
    // GROUND snow is a real site value (a desert jurisdiction's "GROUND SNOW LOAD: 0 PSF").
    if (value == null || value < 0 || value > 400 || (value === 0 && criterion === "roofSnowPsf")) return;
    const end = m.index + m[0].length;
    // A bound, not a value: "Is the ground snow load 70 psf or less?"; and an UNASSIGNED value
    // under a limit earlier in its sentence ("… not exceeding a ground snow load of 50 psf").
    const assigned = new RegExp(SEP).test(m[0]);
    if (boundAfter(text.slice(end, end + 30), assigned, value)) return;
    if (!assigned && limitGoverns(text, m.index)) return;
    out.push({ criterion, value, qualifier, source, derived: false, excerpt: excerptAt(text, m.index, end) });
  };
  const asd = (s: string | undefined): boolean => !!s && /asd/i.test(s);
  // THE ASD QUALIFIER ON EITHER SIDE of a label-first reading: after the value ("GROUND SNOW LOAD =
  // 25.2 PSF (ASD)", "Pg = 25.2 PSF (ASD)") or before the label ("ASD GROUND SNOW LOAD: 25.2 PSF").
  // Read only before the value, a plan stating its ASD ground snow alone was read as Pg 25.2 and
  // blocked. A bare trailing "ASD" counts only where the statement ends ("= 25.2 PSF ASD."); followed
  // by words it opens the NEXT field ("36 PSF ASD WIND SPEED: 85 MPH", "36 PSF ASD GROUND SNOW LOAD:
  // 25.2 PSF") and is not this value's qualifier.
  const asdAround = (match: RegExpExecArray): boolean => {
    const end = match.index + match[0].length;
    const after = text.slice(end, end + 30);
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    return /^\s*(?:\(\s*asd\s*\)|,?\s*asd\b(?=\s*(?:$|[.,;|)])))/i.test(after)
      || /\basd\s*\)?\s*$/i.test(before);
  };
  const groundQual = (label: string | undefined, match: RegExpExecArray): StatedDesignCriterionQualifier =>
    asd(label) || asdAround(match) ? "ground_asd" : "ground";
  let m: RegExpExecArray | null;
  // Where a label-first match's value starts: the capture group's own index (the "d" flag) — a
  // match may carry more after the value than its unit.
  const valueStartOf = (match: RegExpExecArray, group: number): number => match.indices?.[group]?.[0] ?? match.index;
  // An UNSEPARATED (or dash-separated) label-first read ("GROUND SNOW 25 PSF") is the label's own
  // unless its run is value-first: then the 25 is the NEXT label's ("… 25 PSF ROOF SNOW …").
  const labelFirstIsNextLabels = (match: RegExpExecArray, group: number): boolean =>
    ownerAt(valueStartOf(match, group)) === "next";

  // GROUND SNOW, label first. A unit is required unless the label is followed by = or :,
  // so a numbered note ("3. GROUND SNOW LOAD …") can never lend its item number. A
  // parenthetical may sit between label and value ("GROUND SNOW LOAD (Pg) = 25 PSF",
  // "(ASCE 7-16 FIG 7.2-1)"), and prose connects with "of"/"is" ("ground snow load of 36 psf").
  // A spaced dash separates too ("GROUND SNOW LOAD - 36 PSF"), but only with a unit, and — as a dash
  // also joins list items — only where the run's layout agrees the value is this label's.
  // METRIC FIRST: "GROUND SNOW LOAD = 1.72 KPA (36 PSF)" states 36 psf; the kPa number is skipped, and
  // a bare number after the separator that carries ANOTHER unit ("= 1.72 KPA") is never a psf value
  // (it read as Pg 1.72, a BLOCKER).
  const metricFirst = String.raw`(?:\d+(?:\.\d+)?\s*(?:kpa|kn\s*\/\s*m(?:2|²|\^2))\s*[(\[]\s*)?`;
  const otherUnitAt = (end: number): boolean => /^\s*(?:kpa|kn\s*\/\s*m|kg\s*\/\s*m|pa\b|psi\b|mph\b)/i.test(text.slice(end, end + 12));
  const groundLabel = new RegExp(String.raw`\bground\s+snow(?:\s+loads?)?(?:\s*,?\s*p\s?g\b)?(?:\s*\((?![^)]*\basd\b)[^()]{0,40}\))?\s*(\(\s*asd\s*\)|,?\s*asd\b)?\s*(?:(of|is|${SEP})\s*)?${metricFirst}(\d+(?:\.\d+)?)\s*(psf|lbs?\/?(?:sq\.?\s*ft|ft2|ft²))?`, "gid");
  while ((m = groundLabel.exec(text))) {
    if (!(m[2] && /[:=]/.test(m[2])) && !m[4]) continue;
    if (!m[4] && otherUnitAt(m.indices![3][1])) continue;
    if ((!m[2] || isDashSep(m[2])) && labelFirstIsNextLabels(m, 3)) continue;
    push("groundSnowPsf", groundQual(m[1], m), m[3], m);
  }
  // THE UNIT BEFORE THE VALUE: a design report's "Ground Snow Load psf 25" (unit column), a
  // calc table's "Ground Snow Load [psf]: 25". A BRACKETED unit counts only with its separator:
  // "[psf] 28" with none is a calculation-table cell, and on the one letter template that prints
  // it the cell repeats Pg under a "p g (asd)" label that contradicts the letter's own Pg(asd)
  // (measured: 15 of 15 letters) — the letter's design statement is its Design Parameters block.
  const groundUnitFirst = /\bground\s+snow(?:\s+loads?)?(?:\s*,?\s*p\s?g\b)?\s*(?:psf\s+|\[\s*psf\s*\]\s*[:=]\s*)(\d+(?:\.\d+)?)(?![\d.])(?!\s*psf)/gi;
  while ((m = groundUnitFirst.exec(text))) push("groundSnowPsf", groundQual(undefined, m), m[1], m);
  // "SNOW LOAD (GROUND): 25 PSF" — the qualifier printed after the label. It asks the run's ownership
  // like every other label reader: in "36 PSF SNOW LOAD (GROUND) 10 PSF DEAD LOAD" the 10 is the dead
  // load's (read as Pg 10, a BLOCKER on a correct plan). Its value-first form is groundParenAfter.
  const groundParen = new RegExp(String.raw`\bsnow\s+loads?\s*\(\s*ground\s*\)\s*(?:(${SEP})\s*)?(\d+(?:\.\d+)?)\s*(psf)?`, "gid");
  while ((m = groundParen.exec(text))) {
    if (!(m[1] && /[:=]/.test(m[1])) && !m[3]) continue;
    if (!m[3] && otherUnitAt(m.indices![2][1])) continue;
    if ((!m[1] || isDashSep(m[1])) && labelFirstIsNextLabels(m, 2)) continue;
    push("groundSnowPsf", groundQual(undefined, m), m[2], m);
  }
  // A FORMULA'S COEFFICIENT is not a stated value: "Pf = 0.7 Ce Ct Is Pg = 0.7 (1.0)(1.1)(1.0)(36 PSF)",
  // "pf = 0.7 x Ce x Ct x Is x pg = 0.7 x 1.0 x …" — a unitless number after "Pg =" that a
  // multiplication, a parenthesised factor or a code coefficient (Ce, Ct, Cs, Is) follows (it read
  // as Pg 0.7, a BLOCKER naming 0.7 psf).
  const coefficientAt = (end: number): boolean =>
    COEFFICIENT_AFTER.test(text.slice(end, end + 12));
  // Pg symbol: "pg 28.00 psf", "p g = 28.00" (a PDF split the symbol), "Pg(asd) 20 psf".
  // "pg 5" is a page reference — the symbol needs = or a psf unit to count.
  const pgSymbol = new RegExp(String.raw`\bp\s?g\b\s*(\(\s*asd\s*\)|,\s*asd\b|\s+asd\b)?\s*(?:(${SEP})\s*)?${metricFirst}(\d+(?:\.\d+)?)\s*(psf)?`, "gid");
  while ((m = pgSymbol.exec(text))) {
    if (!(m[2] && /[:=]/.test(m[2])) && !m[4]) continue;
    if (!m[4] && (coefficientAt(m.indices![3][1]) || otherUnitAt(m.indices![3][1]))) continue;
    // The symbol as a FACTOR in a product ("Pg(asd) = 0.7 x Pg = 11.2 psf", "S = 0.7 Pg = 11.2 PSF"):
    // the value after it is the product's result, not Pg (it read as a second, sure Pg and turned a
    // plan's own 16 psf into a two-value warning).
    if (/(?:[×*·⋅]|\bx|\d*\.\d+)\s*$/i.test(text.slice(Math.max(0, m.index - 8), m.index))) continue;
    // …and the LAST FACTOR of a JUXTAPOSED product — the commonest line in a snow calc: "Pf = 0.7 Ce Ct
    // Is Pg = 27.7 psf", "Ce Ct I Pg", "0.7(Ce)(Ct)(Is)(Pg)". A coefficient symbol (Ce, Ct, Cs, Ca, Is,
    // I) or a closing-then-opening parenthesis right before the symbol makes the value after it the
    // product's result (it read as a second SURE Pg: a conflict BLOCKER on a correct plan beside its
    // calc, and a real 16 psf plan's blocker LOST to a two-value warning). A comma list is not a product
    // ("Is = 1.0, Pg = 36 PSF" states Pg); so "DESIGN SNOW: Is Pg = 36 PSF" alone reads nothing.
    if (/\b(?:C[etsa]|Is?|\)\s*\()\s*$/.test(text.slice(Math.max(0, m.index - 8), m.index))) continue;
    // "36 PSF Pg 25 PSF ROOF SNOW": in a value-first list the 25 is the next label's, as for "GROUND SNOW".
    if ((!m[2] || isDashSep(m[2])) && labelFirstIsNextLabels(m, 3)) continue;
    push("groundSnowPsf", groundQual(m[1], m), m[3], m);
  }
  // Value first: "ground snow 28 psf" is caught above; "28 psf ground snow" here.
  // A value-first read never takes a value its OWN label already assigned: in "ROOF SNOW LOAD:
  // 20 PSF GROUND SNOW LOAD = 25 PSF" the 20 belongs to roof snow, and in "GROUND SNOW LOAD (Pg):
  // 110 PSF ROOF SNOW LOAD: 77 PSF" the 110 is not a roof snow load.
  // (A heading's colon — "Plan-set loads: 20 psf roof snow" — assigns nothing; only a snow label does.)
  // A HEADING's colon assigns nothing either: "SNOW LOADS: 36 PSF GROUND SNOW 25 PSF ROOF SNOW" is a
  // value-first list under a heading, and its 36 is the ground snow load.
  const assignedValue = (at: number): boolean => {
    const before = text.slice(Math.max(0, at - 40), at);
    return /\bsnow\b[^:=.;]{0,24}[:=]\s*$/i.test(before) && !HEADING_BEFORE.test(before);
  };
  // …and a label that ASSIGNS its own value never also claims the number before it: in "ROOF LIVE
  // LOAD: 20 PSF GROUND SNOW LOAD: 25 PSF" the ground snow load is 25, and the 20 is the live load.
  // A separator assigns even a bare number ("GROUND SNOW LOAD = 25").
  // (Only ":"/"=": a spaced dash assigns through the run's ownership, which these readers already ask.)
  const labelHasOwnValue = (after: number): boolean =>
    LABEL_OWN_VALUE_AFTER.test(text.slice(after, after + 90));
  // With NO separator the run's layout decides (loadValueOwners): in "ROOF DEAD LOAD 3 PSF GROUND
  // SNOW LOAD 36 PSF" the 3 is the dead load's (read as Pg 3, a correct plan got a below-the-minimum
  // BLOCKER); in "36 PSF GROUND SNOW 25 PSF ROOF SNOW 10 PSF DEAD LOAD" the 36 IS the ground snow
  // load (dropping it left Pg 25 alone — the same false BLOCKER on a correct 36 psf plan).
  const valueFirstIsPrevLabels = (at: number): boolean => ownerAt(at) === "prev";
  // A separator between the value and the label AFTER it ("36 PSF: GROUND SNOW LOAD") reads only in a
  // run that is value-first (loadValueOwners) — never on its own.
  const valueFirstOnly = (sep: string | undefined, at: number): boolean => !sep || ownerAt(at) === "next";
  // THE UNIT ENDS AT A WORD BOUNDARY, as the label token's "\bground" demands: OCR text "ROOF SNOW LOAD
  // 25 PSFGROUND SNOW LOAD 36 PSF" glues the unit to the next label, and a reader that accepted zero
  // whitespace read the 25 as a sure Pg (a BLOCKER on a correct plan). Nothing is read there — the
  // unknown callout asks a human. "36PSF GROUND SNOW" (no space before the unit) still reads.
  const groundAfter = new RegExp(String.raw`${NOT_NEGATIVE}(\d+(?:\.\d+)?)\s*psf\b\s*(${SEP}\s*)?(\(\s*asd\s*\)\s*)?ground\s+snow`, "gi");
  while ((m = groundAfter.exec(text))) {
    if (assignedValue(m.index) || labelHasOwnValue(m.index + m[0].length) || valueFirstIsPrevLabels(m.index) || !valueFirstOnly(m[2], m.index)) continue;
    push("groundSnowPsf", asd(m[3]) ? "ground_asd" : "ground", m[1], m);
  }
  // "36 PSF SNOW LOAD (GROUND)" — the parenthetical label, value first, read as "36 PSF GROUND SNOW".
  const groundParenAfter = new RegExp(String.raw`${NOT_NEGATIVE}(\d+(?:\.\d+)?)\s*psf\b\s*(${SEP}\s*)?snow\s+loads?\s*\(\s*ground\s*\)`, "gi");
  while ((m = groundParenAfter.exec(text))) {
    if (assignedValue(m.index) || labelHasOwnValue(m.index + m[0].length) || valueFirstIsPrevLabels(m.index) || !valueFirstOnly(m[2], m.index)) continue;
    push("groundSnowPsf", "ground", m[1], m);
  }
  // "36 PSF Pg 25 PSF ROOF SNOW LOAD" — the symbol printed after its value, read only in a value-first
  // LIST (V L V L …). A bare "Pg" is also a table's column header: in "36 PSF 2.8 PSF Pg PV DEAD LOAD"
  // (column-major) the two-token "2.8 PSF Pg" is no evidence the 2.8 is Pg (it read as Pg 2.8).
  const pgAfter = new RegExp(String.raw`${NOT_NEGATIVE}(\d+(?:\.\d+)?)\s*psf\b\s*(?:${SEP}\s*)?\(?\s*p\s?g\b(?!\s*\(?\s*asd)`, "gi");
  while ((m = pgAfter.exec(text))) {
    if (ownerAt(m.index) !== "next" || !owners.get(m.index)?.valueFirstList || assignedValue(m.index) || labelHasOwnValue(m.index + m[0].length)) continue;
    push("groundSnowPsf", "ground", m[1], m);
  }

  // ROOF SNOW — a different quantity (Pf/Ps = f(Pg, Ce, Ct, Is, Cs)); never compared to Pg.
  const roofQual = (word: string | undefined): StatedDesignCriterionQualifier =>
    !word ? "roof" : /flat/i.test(word) ? "flat" : /sloped|total/i.test(word) ? "sloped" : "roof";
  // "ROOF SNOW LOAD: 20 PSF", "Minimum roof snow load, Pm: 20 psf", and a calc table's unit-first
  // "Flat Roof Snow Load, p f [psf]: 21" (bracketed unit + separator, as for ground snow).
  const roofLabel = new RegExp(String.raw`\b(flat|sloped|total|design|balanced|minimum)?\s*roof\s+snow(?:\s+load)?(?:\s*,?\s*p\s?[fsm]\b)?\s*(?:(\[\s*psf\s*\])\s*[:=]|${SEP})?\s*(\d+(?:\.\d+)?)\s*(psf)?`, "gid");
  while ((m = roofLabel.exec(text))) {
    if (!m[2] && !m[4]) continue;
    // ":"/"=" assign outright; a spaced dash, like no separator, only where the run's layout agrees.
    if (!/[:=]/.test(m[0]) && labelFirstIsNextLabels(m, 3)) continue;
    push("roofSnowPsf", roofQual(m[1]), m[3], m);
  }
  const roofAfter = new RegExp(String.raw`${NOT_NEGATIVE}(\d+(?:\.\d+)?)\s*psf\b\s*(${SEP}\s*)?(flat|sloped|total|design)?\s*roof\s+snow`, "gi");
  while ((m = roofAfter.exec(text))) {
    if (assignedValue(m.index) || labelHasOwnValue(m.index + m[0].length) || valueFirstIsPrevLabels(m.index) || !valueFirstOnly(m[2], m.index)) continue;
    push("roofSnowPsf", roofQual(m[3]), m[1], m);
  }
  const pf = /\bp\s?f\s*=\s*(\d+(?:\.\d+)?)\s*psf/gi;
  while ((m = pf.exec(text))) push("roofSnowPsf", "flat", m[1], m);
  // The minimum roof snow load symbol: "p m = 20 psf".
  const pm = /\bp\s?m\s*=\s*(\d+(?:\.\d+)?)\s*psf/gi;
  while ((m = pm.exec(text))) push("roofSnowPsf", "roof", m[1], m);
  const ps = /\b(?:total\s+snow\s+load\s*,?\s*)?p\s?s\s*=?\s*(\d+(?:\.\d+)?)\s*psf/gi;
  while ((m = ps.exec(text))) {
    // "ps 20.00 psf" alone is too short to trust; require the "=" or the "Total Snow Load" label.
    if (!/=|total/i.test(m[0])) continue;
    push("roofSnowPsf", "sloped", m[1], m);
  }
}

// --- code basis -------------------------------------------------------------

// A bare "CODES:" heads a list on many cover sheets ("CODES: 2021 IRC WITH WASHINGTON STATE
// AMENDMENTS"); only the plural with a colon — "PER CODE: NEC 690.54" is a placard citation.
// The SINGULAR "Code:" heads a list only when a code/edition pair follows at once: an engineer's
// "Design Criteria Code: 2021 WSBC, 2021 WSRC, ASCE 7-16" (a Washington letter), never "PER CODE:
// NEC 690.54" (a section number is not an edition) nor a placard's "PER CODE: NEC 2020" (measured on the
// labels sheet of the most common plan-set template).
const CODE_BASIS_HEADER = /\b(governing\s+codes?|applicable\s+codes?|code\s+basis|design\s+codes?|codes?\s+and\s+standards|references\s+and\s+codes|building\s+codes?\s+used|codes?\s+used)\b\s*[:\-–]?|\bcodes\s*:|(?<!\bper\s{1,3})\bcode\s*:(?=\s*(?:(?:19|20)\d{2}\s+[A-Z]{2,6}\b|[A-Z]{2,6}\s+(?:19|20)\d{2}\b))/gi;
const NAME_STOPWORDS = new Set(["OF", "THE", "AND", "FOR", "&", "PER", "BY", "IN", "TO", "WITH", "AS", "ON", "AT", "SEE"]);
/** An abbreviation reads as a CODE only when it ends in C (NEC, IRC, OESC, IECC …) or is a
 *  known code token (FBC-R); "OREGON", "ASCE", "NDS" and every other capitalised word do not. */
const CODE_ABBR = /^[A-Z]{1,5}C$/;

/** The model codes (ICC / NFPA 70) state codes are built on. */
const MODEL_CODES = new Set(["IRC", "IBC", "IFC", "NEC", "IECC", "IPC", "IMC", "IEBC", "IFGC", "IPMC", "ISPSC"]);

/**
 * STATE CODES MAP TO THEIR BASE MODEL CODE. A state code's edition is ITS OWN (the 2023 ORSC is
 * built on the 2021 IRC; the 2022 Oregon Fire Code on the 2021 IFC), so a state code is never
 * compared with a model code by year. The map only says which model code a printed "(NEC 2020)"
 * — or a profile's own "NEC 2023" entry — is the basis OF. Static engine data, not per-AHJ.
 */
export const STATE_CODE_BASE: Readonly<Record<string, string>> = {
  ORSC: "IRC", OSSC: "IBC", OESC: "NEC", OFC: "IFC",
  CRC: "IRC", CBC: "IBC", CEC: "NEC", CFC: "IFC",
  "FBC-R": "IRC", "FBC-B": "IBC",
  // New York's codes do not end in C ("2020 RCNYS"), so without an entry here an abbreviated
  // list is not read at all. (Washington's "WSRC"/"WSBC" end in C and read without one.)
  RCNYS: "IRC", BCNYS: "IBC", FCNYS: "IFC",
};

const US_STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));

/** One spelling per code: "FBC Residential"/"FBCR" -> FBC-R, "NFPA 70" -> NEC, "I.R.C." -> IRC,
 *  and a state-suffixed profile token ("CEC-CA", written to tell the California Electrical Code
 *  from other CECs) -> CEC. */
export function normCodeToken(code: string): string {
  const c = String(code || "").toUpperCase().replace(/[.\s]/g, "");
  if (/^FBC-?R(?:ESIDENTIAL)?$/.test(c)) return "FBC-R";
  if (/^FBC-?B(?:UILDING)?$/.test(c)) return "FBC-B";
  if (c === "NFPA70") return "NEC";
  const suffixed = c.match(/^([A-Z]{2,6})-([A-Z]{2,3})$/);
  // A two-letter tag is a state ("CEC-CA"); a three-letter one a city ("CBC-CHI", "CEC-CHI":
  // Chicago's own building and electrical codes, as a profile records them and a plan prints
  // "2019 CHICAGO BUILDING CODE"). "FBC-R" (one letter) is a volume, never stripped.
  if (suffixed && (suffixed[2].length === 3 || US_STATES.has(suffixed[2]))) return suffixed[1];
  return c;
}

/** The model code a code token is built on: itself for a model code, the map for a state code. */
export function baseModelCode(code: string): string | undefined {
  const c = normCodeToken(code);
  return MODEL_CODES.has(c) ? c : STATE_CODE_BASE[c];
}

function isCodeToken(token: string): boolean {
  const c = normCodeToken(token);
  return CODE_ABBR.test(c) || MODEL_CODES.has(c) || c in STATE_CODE_BASE;
}

// A model code's printed name ends a state-amended title: "2021 OREGON AMENDED INTERNATIONAL
// RESIDENTIAL CODE" is the IRC, not a code named "OAIRC".
const MODEL_CODE_NAMES: Array<[RegExp, string]> = [
  [/INTERNATIONAL RESIDENTIAL CODE$/, "IRC"],
  [/INTERNATIONAL BUILDING CODE$/, "IBC"],
  [/INTERNATIONAL FIRE CODE$/, "IFC"],
  [/NATIONAL ELECTRIC(?:AL)? CODE$/, "NEC"],
  [/INTERNATIONAL ENERGY CONSERVATION CODE$/, "IECC"],
  [/INTERNATIONAL EXISTING BUILDING CODE$/, "IEBC"],
];

function acronym(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ""))
    .filter((w) => w && !NAME_STOPWORDS.has(w.toUpperCase()))
    .map((w) => w[0].toUpperCase())
    .join("");
}

type BasisItem = { at: number; end: number; entry: Omit<StatedCodeBasisEntry, "source" | "excerpt"> };

const YEAR = "(?:19|20)\\d{2}";
/** A parenthetical naming the base model code, either order: "(NEC 2020)", "(2023 NEC)",
 *  "(based on the 2021 IRC)". */
function parenBase(paren: string): { baseCode: string; baseEdition: string } | null {
  const p = paren.trim();
  let m = p.match(new RegExp(`^([A-Z]{2,6})\\s*[-:]?\\s*(${YEAR})(?:\\s+edition)?$`, "i"));
  if (m && isCodeToken(m[1])) return { baseCode: normCodeToken(m[1]), baseEdition: m[2] };
  m = p.match(new RegExp(`^(?:based\\s+on\\s+(?:the\\s+)?)?(${YEAR})\\s+([A-Z]{2,6})$`, "i"));
  if (m && isCodeToken(m[2])) return { baseCode: normCodeToken(m[2]), baseEdition: m[1] };
  return null;
}

function namedCode(name: string, paren: string, tail: string): string {
  const parenAbbr = /^[A-Z]{2,6}(?:-[A-Z]{1,11})?$/.test(paren) && isCodeToken(paren) ? normCodeToken(paren) : "";
  if (parenAbbr) return parenAbbr;
  // "2020 NEC CODE" is the NEC, not a code named "NC".
  const abbrName = name.match(/^([A-Z]{2,6})\s+CODE$/);
  if (abbrName && isCodeToken(abbrName[1])) return normCodeToken(abbrName[1]);
  const model = MODEL_CODE_NAMES.find(([re]) => re.test(name));
  if (model) return model[1];
  const code = acronym(name);
  // "FLORIDA BUILDING CODE, RESIDENTIAL" is the residential volume, ", BUILDING" the building one.
  if (/^\s*[,\-–]?\s*RESIDENTIAL\b/i.test(tail)) return normCodeToken(`${code}-R`);
  if (/^\s*[,\-–]?\s*BUILDING\b/i.test(tail)) return normCodeToken(`${code}-B`);
  // "CALIFORNIA ENERGY CODE" shares CEC's initials with the California ELECTRICAL Code; it is
  // not an NEC-based code, so it must not borrow CEC's base.
  if (/\bENERGY\b/.test(name) && baseModelCode(code) === "NEC") return `${code}-ENERGY`;
  return code;
}

// "2023 OREGON ELECTRICAL SPECIALTY CODE (NEC 2020)", "2022 OREGON STRUCTURAL SPECIALTY CODE
// (OSSC)", "2021 International Residential Code". Case-sensitive on the capitals: every word
// of a code's printed name is capitalised, and "in 2021 the electrical code was…" is prose.
// A year that ends a DATE is not an edition: a portal page's "06/03/2026 Result Code Approved".
// A state named AFTER "CODE" is part of the name: "2020 RESIDENTIAL CODE OF NEW YORK STATE
// (2020 RCNYS)" is the RCNYS, not a code named "RC"; so is "… CODE OF THE STATE OF X".
const NAMED_CODE = /(?<![/.\-\d])\b((?:19|20)\d{2})\s+((?:[A-Z][A-Za-z.'-]*\s+){0,6}?(?:CODE|Code))\b(\s+(?:of|OF)\s+(?:(?:the|THE)\s+)?(?:(?:State|STATE|Commonwealth|COMMONWEALTH)\s+(?:of|OF)\s+(?:[A-Z][A-Za-z]+\s?){1,2}|(?:[A-Z][A-Za-z]+\s+){1,2}(?:State|STATE)\b))?(?:\s*\(\s*([^)]{1,40}?)\s*\))?/g;
// Name first, then the edition: "Oregon Structural Specialty Code, 2025 Edition (2024 IBC)",
// "International Residential Code, 2021 Edition".
// An ordinal edition with the year in parentheses: "FLORIDA BUILDING CODE, RESIDENTIAL 8TH
// EDITION (2023)".
const NAMED_CODE_ORDINAL = /\b((?:[A-Z][A-Za-z.'-]*\s+){1,6}?(?:CODE|Code))((?:\s*[,\-–]?\s*(?:RESIDENTIAL|BUILDING|Residential|Building))?),?\s*[-–]?\s*\d{1,2}(?:ST|ND|RD|TH|st|nd|rd|th)\s+(?:EDITION|Edition)\s*\(\s*((?:19|20)\d{2})\s*\)/g;
const NAMED_CODE_EDITION = /\b((?:[A-Z][A-Za-z.'-]*\s+){1,6}?(?:CODE|Code)),?\s+((?:19|20)\d{2})\s+(?:EDITION|Edition)\b(?:\s*\(\s*([^)]{1,40}?)\s*\))?/g;

function namedItems(part: string): BasisItem[] {
  const items: BasisItem[] = [];
  const push = (at: number, end: number, rawName: string, edition: string, rawParen: string | undefined, volume?: string): void => {
    const name = rawName.replace(/\s+/g, " ").trim().toUpperCase();
    const paren = (rawParen || "").trim();
    const parsedBase = parenBase(paren);
    const code = namedCode(name, parsedBase ? "" : paren, volume ?? part.slice(end, end + 20));
    // A parenthetical naming the SAME code is its abbreviation, not its base:
    // "RESIDENTIAL CODE OF NEW YORK STATE (2020 RCNYS)".
    const base = parsedBase && parsedBase.baseCode !== code ? parsedBase : null;
    // "NEC: 2020 PER CODE: NEC 690.54" (a placard citation) is not a code named "PC": a
    // printed code name never opens with a preposition, and needs two initials besides CODE.
    if (NAME_STOPWORDS.has(name.split(" ")[0]) || code.length < 2) return;
    if (items.some((i) => at < i.end && end > i.at)) return;
    items.push({ at, end, entry: { code, edition, name, ...(base ?? {}) } });
  };
  let m: RegExpExecArray | null;
  const yearFirst = new RegExp(NAMED_CODE.source, "g");
  while ((m = yearFirst.exec(part))) {
    // "2021 INTERNATIONAL RESIDENTIAL CODE OF THE STATE OF COLORADO" is the IRC; only a name that is
    // not a known code WITHOUT its state tail takes the tail ("RESIDENTIAL CODE OF NEW YORK STATE"
    // is the RCNYS, not a code named "RC").
    const bare = m[2].replace(/\s+/g, " ").trim().toUpperCase();
    const bareCode = namedCode(bare, "", part.slice(m.index + m[0].length, m.index + m[0].length + 20));
    const known = MODEL_CODES.has(bareCode) || bareCode in STATE_CODE_BASE;
    push(m.index, m.index + m[0].length, known || !m[3] ? m[2] : `${m[2]}${m[3]}`, m[1], m[4]);
  }
  const ordinal = new RegExp(NAMED_CODE_ORDINAL.source, "g");
  while ((m = ordinal.exec(part))) push(m.index, m.index + m[0].length, m[1], m[3], undefined, m[2]);
  const nameFirst = new RegExp(NAMED_CODE_EDITION.source, "g");
  while ((m = nameFirst.exec(part))) push(m.index, m.index + m[0].length, m[1], m[2], m[3]);
  return items;
}

type BasisToken = { kind: "year" | "code"; at: number; end: number; value: string };

/**
 * Bare abbreviations in a code-basis block, READ IN ORDER and PAIRED ONCE: a code and a year
 * side by side (either order) form one entry and are consumed, so one year can never serve two
 * codes. "IRC 2021 NEC 2023 IFC 2021" is exactly those three pairs; "2021 IBC 3) 2018 IRC" is
 * two. A permit-number shape ("BLDC 2024-00012") is not a code and not a year.
 */
function abbreviationItems(block: string, taken: Array<[number, number]>): BasisItem[] {
  const free = (a: number, b: number): boolean => !taken.some(([x, y]) => a < y && b > x);
  const tokens: BasisToken[] = [];
  // Case-sensitive: codes are printed as capitals, and a lower-case word is never one.
  const re = new RegExp(`\\b(${YEAR})\\b(?!\\s*-\\s*\\d)|\\b([A-Z]{2,6}(?:-R\\b)?)\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const at = m.index;
    const end = at + m[0].length;
    if (!free(at, end)) continue;
    if (m[1]) {
      // "2024-00012" is excluded by the lookahead; so is the tail of "00012-2024".
      if (/\d\s*-\s*$/.test(block.slice(Math.max(0, at - 3), at))) continue;
      tokens.push({ kind: "year", at, end, value: m[1] });
    } else if (isCodeToken(m[2])) {
      // A permit-number prefix: "BLDC 2024-00012", "ELEC# 2024-0031", "BLD 20240012".
      if (/^\s*[-#:]?\s*(?:(?:19|20)\d{2}\s*-\s*\d+|\d{5,})/.test(block.slice(end))) continue;
      tokens.push({ kind: "code", at, end, value: m[2] });
    }
  }
  const items: BasisItem[] = [];
  for (let i = 0; i + 1 < tokens.length;) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a.kind === b.kind || !/^\s*[-:]?\s*$/.test(block.slice(a.end, b.at))) { i++; continue; }
    const code = a.kind === "code" ? a : b;
    const year = a.kind === "year" ? a : b;
    let end = b.end;
    const paren = block.slice(end).match(/^\s*\(\s*([^)]{1,40}?)\s*\)/);
    const base = paren ? parenBase(paren[1]) : null;
    if (base && paren) end += paren[0].length;
    items.push({ at: a.at, end, entry: { code: normCodeToken(code.value), edition: year.value, ...(base ?? {}) } });
    i += 2;
    // The tokens inside a consumed "(NEC 2020)" belong to this entry.
    while (i < tokens.length && tokens[i].at < end) i++;
  }
  return items;
}

function extractCodeBasis(text: string, source: string, out: StatedCodeBasisEntry[]): void {
  const emit = (part: string, item: BasisItem): void => {
    out.push({ ...item.entry, source, excerpt: flat(part.slice(item.at, item.end)).slice(0, 90) });
  };
  // A spelled-out code name with its year is self-anchoring, so it is read ANYWHERE: PDF text
  // order often puts the list BEFORE its "GOVERNING CODES:" heading (measured on the live book).
  for (const item of namedItems(text)) emit(text, item);

  // Bare abbreviations ("2021 IBC", "NEC 2020") are only read inside a code-basis block —
  // the labels sheet repeats "NEC: 2020, PER CODE: NEC 690.31" dozens of times, and those are
  // placard citations, not the design's code basis.
  let h: RegExpExecArray | null;
  const header = new RegExp(CODE_BASIS_HEADER.source, "gi");
  while ((h = header.exec(text))) {
    const blockStart = h.index + h[0].length;
    const block = text.slice(blockStart, blockStart + 520);
    const items: BasisItem[] = namedItems(block);
    items.push(...abbreviationItems(block, items.map((i) => [i.at, i.end])));
    items.sort((a, b) => a.at - b.at);
    // A block is contiguous: once the entries stop, whatever follows is another note.
    let lastEnd = 0;
    for (const item of items) {
      if (item.at - lastEnd > 120) break;
      lastEnd = item.end;
      emit(block, item);
    }
  }
}

// --- parser fields -----------------------------------------------------------

function singleNumber(raw: string): number | null {
  const nums = raw.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length !== 1) return null;
  return toNumber(nums[0]);
}

function extractParsedFields(project: ProjectRecord, out: StatedDesignCriterion[]): void {
  const field = (k: string): string => snapshotText(project, k).trim();
  const add = (criterion: StatedDesignCriterionKind, value: number | string, qualifier: StatedDesignCriterionQualifier, key: string): void => {
    out.push({ criterion, value, qualifier, source: PARSED_FIELDS_SOURCE, derived: true, excerpt: `${key}: ${field(key)}`.slice(0, 80) });
  };
  for (const key of ["snow", "groundSnowLoad"]) {
    const v = field(key) ? singleNumber(field(key)) : null;
    if (v != null) { add("groundSnowPsf", v, "ground", key); break; }
  }
  const ws = field("windSpeed") ? singleNumber(field("windSpeed")) : null;
  if (ws != null && ws >= 60 && ws <= 250) add("windSpeedMph", ws, windQualifier(field("windSpeed")), "windSpeed");
  for (const key of ["wind", "windExposure"]) {
    const raw = field(key);
    const exp = raw.match(/^\s*(?:exp(?:osure)?\.?\s*(?:cat(?:egory)?\.?\s*)?[:=]?\s*)?([BCD])\s*$/i) || raw.match(/\bexposure\s*(?:cat(?:egory)?\s*)?[:=]?\s*([BCD])(?![A-Za-z0-9])/i);
    if (exp) { add("windExposure", exp[1].toUpperCase(), "unspecified", key); break; }
  }
  const risk = field("riskCategory").match(/^\s*(?:risk\s*cat(?:egory)?\s*)?(IV|I{1,3}|[1-4])\s*$/i);
  if (risk) add("riskCategory", normRisk(risk[1]), "unspecified", "riskCategory");
}

// --- public extractor --------------------------------------------------------

function dedupe(items: StatedDesignCriterion[]): StatedDesignCriterion[] {
  const seen = new Set<string>();
  return items.filter((c) => {
    const key = `${c.source}|${c.criterion}|${c.qualifier}|${c.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Every design criterion the package STATES, per source, plus the plan's code-basis block.
 * `extraTexts` lets a caller hand in per-document text (one source per uploaded document),
 * which is what lets the conflict rule say "the plan set vs the engineer's letter" instead
 * of "somewhere in the uploaded text".
 */
export function extractStatedDesignCriteria(project: ProjectRecord, extraTexts: DesignTextSource[] = []): StatedDesignCriteria {
  const { unsure: _unsure, ...stated } = extractFromSources(project, readSources(project, extraTexts));
  return stated;
}

/** What the extractor read, plus which readings it was UNSURE of (see extractSnowBothWays): keys
 *  `source|criterion|qualifier|value`. Internal — the shared StatedDesignCriteria shape is unchanged. */
interface StatedReading extends StatedDesignCriteria {
  unsure: Set<string>;
}
const readingKey = (c: StatedDesignCriterion): string => `${c.source}|${c.criterion}|${c.qualifier}|${c.value}`;

function extractFromSources(project: ProjectRecord, sources: ReadSource[]): StatedReading {
  const criteria: StatedDesignCriterion[] = [];
  const codeBasis: StatedCodeBasisEntry[] = [];
  const sure = new Set<string>();
  const unsure = new Set<string>();
  extractParsedFields(project, criteria);
  for (const source of sources) {
    const found: StatedDesignCriterion[] = [];
    const text = joinSplitDigits(source.text);
    extractWind(text, source.label, found);
    extractExposureAndRisk(text, source.label, found);
    extractSeismicAndFrost(text, source.label, found);
    const unsureHere = new Set<string>();
    extractSnowBothWays(text, source.label, found, unsureHere);
    for (const c of found) {
      const k = `${c.criterion}|${c.qualifier}|${c.value}`;
      (unsureHere.has(k) ? unsure : sure).add(`${source.label}|${k}`);
    }
    criteria.push(...found.map((c) => ({ ...c, derived: source.derived })));
    // The code basis is read from the package's own sheets only; a narrative summary
    // paraphrasing "2021 IRC" is not the plan's GOVERNING CODES block.
    if (source.sheet) {
      extractCodeBasis(source.text, source.label, codeBasis);
    }
  }
  const seenBasis = new Set<string>();
  // Two sources under one label: a value one of them read surely is sure.
  for (const k of sure) unsure.delete(k);
  return {
    unsure,
    documentTextRead: sources.some((s) => s.sheet),
    criteria: dedupe(criteria),
    codeBasis: codeBasis.filter((b) => {
      const key = `${b.source}|${b.code}|${b.edition}|${b.baseCode ?? ""}|${b.baseEdition ?? ""}`;
      if (seenBasis.has(key)) return false;
      seenBasis.add(key);
      return true;
    }),
  };
}

// --- what an AHJ correction REQUIRES ---------------------------------------------
//
// The package extractor above reads what a DESIGN states. An AHJ comment is the other side:
// it states what the jurisdiction REQUIRES ("Ground snow load 36 psf", "The minimum wind speed
// design is 120 MPH Ultimate Exposure D", "The mounting spacing should be 2' oc"). The label
// rules are shared, but the context rule is inverted: in a design, "minimum 120 mph" is a
// limit and not the design's speed; in a correction, "minimum" is exactly the requirement.
// And a correction often QUOTES the package back ("the calculations show Exposure B, 95 mph")
// — a quoted value is what the AHJ rejected, never what it requires.

export interface AhjRequiredCriterion {
  criterion: JurisdictionCriterionKey;
  block: "designCriteria" | "prescriptive";
  value: number | string | boolean;
  /** The sentence the AHJ wrote, flattened and capped (it lands in a SHARED profile). */
  basis: string;
}

// WHICH SENTENCES STATE A REQUIREMENT. Three ways in, and nothing else:
//  1. a requirement cue in the clause — "should be / shall be / must be / minimum ... is /
//     required / provide ... / use ..." — and the value comes AFTER the cue;
//  2. a bullet under a requirement header ("Provide updated design criteria ... -Ground snow
//     load 36 psf.") inherits the header's cue;
//  3. a BARE statement that is nothing but the criterion ("Ground snow load 36 psf.") — a short
//     clause that OPENS with the criterion's label. A portal page that prints the applicant's
//     entered criteria mid-line ("Record ... Addl Info Needed Wind Speed 120 mph ...") is not one.
// And these never count, whatever cue they carry: a clause that REJECTS a value ("is incorrect",
// "not acceptable", "not allowed", "exceeds", "does not match"), one that is CONDITIONAL ("If
// ...", "verify whether ..."), and one that QUOTES THE PACKAGE ("Plan set: ...", "Calcs - ...",
// "the letter states ..."). A rejected or quoted value is what the AHJ bounced, never its rule.
const REQUIREMENT_CUE = /\b(?:minimum|min\.|must\s+(?:not\s+)?be|shall\s+(?:not\s+)?be|should\s+be|needs?\s+to\s+be|is\s+required|are\s+required|required|requires?|(?:shall|must|may)\s+not\s+exceed|not\s+to\s+exceed)\b/i;
// "PROVIDE" ASKS FOR SOMETHING; IT DOES NOT STATE A VALUE. "Provide calculations for 16 psf ground
// snow load", "Provide a copy of the engineer letter for the 16 psf ... used", "Provide attachment
// spacing at 72\" o.c. per the engineer letter" all carry the PACKAGE's number. So "provide" is a
// cue for a value only when the clause cites a CODE for it ("... per R324.4.1", "per ORSC 2023",
// "per ASCE 7-22") and does not ask for a document; otherwise it still (a) makes a header whose
// bullets state the values ("Provide updated design criteria ... -Ground snow load 36 psf.") and
// (b) asks for LISTING evidence, which is a flag, not a value.
const PROVIDE_CUE = /\b(?:provide|submit)\b/i;
const PER_CODE = /\bper\s+(?:the\s+)?(?:(?:19|20)\d{2}\s+)?(?:[A-Z]{2,6}\s+(?:(?:19|20)\d{2}\s+)?)?(?:(?:section|sec\.?|§|table|figure)\s*)?(?:R|IRC\s*R?)?\d{3}(?:\.\d+)*\b|\bper\s+(?:the\s+)?(?:[A-Z]{2,6}\s+(?:19|20)\d{2}|(?:19|20)\d{2}\s+[A-Z]{2,6}|ASCE\s*7(?:-\d{2})?)\b/i;
// WHAT "PROVIDE" ASKS FOR. A document noun anywhere in what is asked for — whatever words sit
// around it ("Provide STAMPED STRUCTURAL calcs per ASCE 7-16 for the 25 psf ...", "Provide a COPY of
// the engineer letter for:", "Provide WIND LOAD calculations per ASCE 7-22 using 110 mph") — makes the
// clause a request for that document, and the number in it the PACKAGE's. Only the adjacent-word
// form was caught before (a word between "provide" and the noun let PER_CODE turn "provide" into a
// cue). "design" alone is not a document ("Provide design for a ground snow load of 36 psf per ...").
const DOCUMENT_NOUN = /\b(?:cop(?:y|ies)|calc\w*|documentation|documents?|letters?|engineer\w*|details?|drawings?|plans?|plan\s*sets?|evidence|verification|reports?|analys[ie]s|sheets?|photos?|specs?|specifications?|information|justification|tables?|charts?|narratives?|design\s+(?:by|from|letter|calc\w*))\b/i;
// Where the thing asked for ENDS in a HEADER (no value in the clause): at the first preposition. TEXT_A's
// "Provide updated design criteria FOR the letter from the engineer and the plan set" asks for design
// criteria — the letter is where they go. "of" does not end it ("a copy of the engineer letter").
const OBJECT_END = /\b(?:for|per|in|at|to|with|on|from|by|using|showing|confirming|demonstrating|verifying|indicating|that|which)\b|[:;(]/i;
// Where a clause's first VALUE starts: a number with its unit, or an exposure category.
const FIRST_VALUE = /\d+(?:\.\d+)?\s*(?:psf\b|mph\b|pounds?\b|lbs?\b|["”'’]|in\b|in\.|inch|ft\b|feet\b|foot\b|o\.?\s*c\b)|\bexposure\s+(?:cat(?:egory|\.)?\s*)?[BCD]\b|\b[BCD]\s+exposure\b/i;
/** The clause (from its "provide/submit" at `provideAt`) asks for a DOCUMENT: a document noun sits
 *  between "provide" and the clause's first value — or, in a header with no value, in what the header
 *  asks for (up to its first preposition). ONE predicate for both the value cue and the header cue. */
function provideAsksForDocument(clause: string, provideAt: number): boolean {
  if (provideAt < 0) return false;
  const rest = clause.slice(provideAt).replace(PROVIDE_CUE, "");
  const valueAt = rest.search(FIRST_VALUE);
  const upto = valueAt >= 0 ? valueAt : (() => { const e = rest.search(OBJECT_END); return e >= 0 ? e : rest.length; })();
  return DOCUMENT_NOUN.test(rest.slice(0, upto));
}
/** A portal STATUS PAGE printing the application's fields ("Record Status: ... Application Information.
 *  Wind Speed 120 mph Exposure C.") — its bare "label value" lines are the applicant's entries, not
 *  the AHJ's rule. Only cued statements count on such a page. */
const STATUS_PAGE = /\b(?:record\s+status|application\s+information|record\s+info(?:rmation)?|processing\s+status|workflow\s+status|expiration\s+date|application\s+status)\b|\bstatus\s*:/i;
/** The site's fact, stated: "Testcoast City is located in a special wind region". */
const SPECIAL_WIND_STATEMENT = /\b(?:is|are|lies|sits)\s+(?:located\s+|situated\s+)?(?:with)?in\s+(?:an?\s+|the\s+)?special\s+wind\s+(?:region|zone)\b/i;
/** A cue that FOLLOWS its value: "Exposure C is required", "36 psf ground snow is the minimum". */
const TRAILING_REQUIREMENT = /\b(?:is|are)\s+(?:required|the\s+minimum)\b\W*$/i;
/** Imperatives that open a clause: "Use Vult = 130 mph", "Show ground snow 36 psf", "Design for ...". */
const IMPERATIVE_START = /^\s*(?:please\s+)?(?:use|show|design\s+(?:for|to)|revise\s+(?:to|for)|update\s+to)\b/i;
// Third-person / past forms only: "the calculations show(s)/use(d)" describes the package, while
// the imperative "Use Vult = 130 mph" / "Show ground snow 36 psf" is the requirement.
const QUOTATION_CUE = /\b(?:shows|shown|showing|states|stated|indicates|indicated|lists|listed|uses|used|currently|(?:plans?|calc\w*|letter|drawings?|sheets?)\s+(?:show|state|use|indicate|list))\b/i;
/** The clause rejects a value, or asks a question instead of stating a rule. "shall not exceed" /
 *  "not to exceed" state a MAXIMUM (a requirement), so "exceed" counts only without them. */
const REJECTION_CUE = /\b(?:is|are|was|were)\s+(?:incorrect|wrong|inaccurate|invalid|insufficient|inadequate)\b|\bnot\s+(?:acceptable|allowed|permitted|approved|correct|required|needed)\b|\bunacceptable\b|\b(?<!\bnot\s)(?<!\bnot\s+to\s)exceed(?:s|ed|ing)?\b|\bdo(?:es)?\s+not\s+(?:match|agree|comply|meet|correspond)\b|\b(?:mismatch(?:ed)?|inconsistent|conflict(?:s|ing)?)\b|\bwhether\b/i;
/** A conditional clause ("If the site is ...", "Unless ..."), after any item number. */
const CONDITIONAL_START = /^\s*(?:\(?\d+[.)]\s*)?(?:if|unless|where|when)\b/i;
/** The clause opens by naming a PACKAGE document it then quotes: "Plan set: ground snow 25 psf.",
 *  "Calcs - Exposure B", "The letter states ...", "Design criteria: Wind 110 mph ...". */
const PACKAGE_PREFIX = /^\s*(?:\(?\d+[.)]\s*)?(?:the\s+|your\s+)?(?:submitted\s+)?(?:plan\s*sets?|plans?|drawings?|calc(?:ulation)?s?|structural\s+calc\w*|(?:engineer(?:'s|ing)?\s+|stamped\s+|structural\s+)?letter|sheet(?:\s+[A-Z]{0,3}[-\s]?\d+(?:\.\d+)?)?|design\s+criteria|spec(?:ification)?\s*sheets?|cut\s*sheets?|specs?)\s*(?:[:=\-–—]|\b(?:states?|shows?|lists?|uses?|indicates?|reads?|says?|has|have)\b)/i;
/** A bare statement opens with the criterion's own label. */
const BARE_LABEL_START = /^\s*(?:\(?\d+[.)]\s*)?(?:the\s+)?(?:design\s+|ultimate\s+|basic\s+)?(?:ground\s+snow|wind\s+(?:speed|exposure)|(?:wind\s+)?exposure\b|exp\.|v\s*[_(]?\s*ult|vult|(?:roof\s+)?(?:attachments?|mount(?:s|ing)?|anchors?|stand-?offs?)\s+spacing|special\s+wind)/i;
const BARE_MAX_WORDS = 10;
const ATTACHMENT_LABEL = /\b(?:mount(?:s|ing)?|attachments?|anchors?|anchorage|stand-?offs?|lags?|lag\s+screws?|roof\s+hooks?|hooks?|brackets?|clamps?|l-?feet|l-?foot)\b/gi;
const FRAMING_WORD = /\b(?:rafters?|truss(?:es)?|joists?|purlins?|studs?|framing|members?|sheathing)\b/i;
/** Module / racking listing evidence (UL 61730 / 1703 / 2703) — never an inverter's UL 1741. */
const LISTING_WORD = /\bUL\s*(?:2703|61730|1703)\b|\bUL[\s-]*list(?:ing|ings|ed)\b|\blistings?\s+(?:for|of|documentation|evidence|certificates?|information)\b|\blisted\s+(?:to|per)\s+UL\b/i;
const LISTING_SUBJECT = /\b(?:panels?|modules?|racking|racks?|rails?|mount(?:s|ing)?|attachments?|array)\b/i;

interface AhjSentence {
  text: string;
  /** The line opened with a bullet mark, or followed a header that ended with ":". */
  bullet: boolean;
  /** The sentence ends with ":" — it heads the items after it, even when it is itself a bullet
   *  ("Structural Comments:\nProvide calculations for the following:\n- ..."). */
  opensList: boolean;
  /** The first sentence of its line (a later sentence runs on within the line). */
  lineStart: boolean;
}

/** A piece that is ONLY an item number or letter: the "1." a line's "1. Ground snow load 16 psf"
 *  splits off at its period. It is the next piece's marker, never a sentence of its own. */
const SOLE_ITEM_MARKER = /^\(?(?:\d{1,3}|[a-z])[.)]$/i;

/** A line's list marker: "1." "2)" "(3)" (numeric), "a." "b)" (letter), or a bullet mark. */
const LINE_MARKER = /^(\s*)(?:([-–•*])|(\()?(?:(\d{1,3})|([a-z]))([.)]))\s/i;

/** The marker's FAMILY and LEVEL: "1." and "2." are one family; "a.", "(1)", "1)" and "-" are others. */
function lineMarkerOf(line: string): { family: string; indent: number } | null {
  const m = LINE_MARKER.exec(line);
  if (!m) return null;
  const indent = m[1].replace(/\t/g, "    ").length;
  if (m[2]) return { family: `bullet${m[2]}`, indent };
  const kind = m[4] ? "num" : m[5] === m[5]!.toLowerCase() ? "lower" : "upper";
  return { family: `${m[3] ? "(" : ""}${kind}${m[6]}`, indent };
}

function ahjSentences(text: string): AhjSentence[] {
  const out: AhjSentence[] = [];
  let prevEndsColon = false;
  // A header ending with ":" opens a LIST: every following line (a line of its own, marked or not)
  // is one of its items until a blank line or a sentence that runs on within a line. "Provide
  // calculations for the following:\nGround snow load 16 psf\nWind speed 110 mph" — both lines hang
  // under the header, not only the first.
  let inList = false;
  // THE HEADER'S OWN MARKER. A header that is itself a numbered comment ("1. The following design
  // criteria are required:") heads its lettered / bulleted items, but a line with the SAME marker
  // family at the same level or shallower ("2. Wind speed 110 mph per plans.") is the next COMMENT,
  // not an item: it closes the header, so the header's cue does not carry to it (on a status reading
  // the package's own values would become the jurisdiction's proposals). An unnumbered header's
  // numbered lines stay its items ("Provide the following:\n1. …\n2. …").
  // (Assigned inside the pieces callback, so typed by cast: TS would narrow a plain `= null` to never.)
  let headerMarker = null as { family: string; indent: number } | null;
  for (const line of String(text || "").replace(/\r/g, "").split("\n")) {
    if (!line.trim()) { inList = false; headerMarker = null; continue; }
    const marker = lineMarkerOf(line);
    // (An ORDERED marker only: a bullet header's same-level bullets are how a flat list prints its items.)
    const sibling = !!(inList && headerMarker && marker && !marker.family.startsWith("bullet")
      && marker.family === headerMarker.family && marker.indent <= headerMarker.indent);
    if (sibling) { inList = false; prevEndsColon = false; headerMarker = null; }
    // A new sentence starts after . ; ! ? + space when the next token opens a clause; a code
    // section ("R324.4.1") has no space after its dots, so it is never split. An item number split
    // off on its own ("1." of "1. Ground snow load 16 psf") belongs to the item after it: dropped,
    // so the item keeps the line's first position (and with it the list it hangs under).
    const pieces = line.split(/(?<=[.;!?])\s+(?=[-–•*]?\s*[A-Z0-9(])/)
      .filter((piece, i, all) => !(SOLE_ITEM_MARKER.test(flat(piece)) && i < all.length - 1));
    pieces.forEach((piece, i) => {
      const flatPiece = flat(piece);
      if (!flatPiece) return;
      const marked = /^[-–•*]\s*/.test(flatPiece);
      if (i > 0 && !marked && !prevEndsColon) { inList = false; headerMarker = null; }
      // (A sibling line has already closed the list above, so its first piece is no bullet.)
      const bullet = marked || prevEndsColon || (inList && i === 0);
      const opensList = /:\s*$/.test(flatPiece);
      out.push({ text: flatPiece.replace(/^[-–•*]\s*/, ""), bullet, opensList, lineStart: i === 0 });
      prevEndsColon = opensList;
      if (prevEndsColon) {
        inList = true;
        // The line's marker numbers the COMMENT the header sits in, wherever in the line the header
        // is ("1. Revise per the checklist. The following are required:").
        headerMarker = marker;
      }
    });
  }
  return out;
}

/** One sentence's clauses: split at ";" and before a " but " / conditional tail, so "minimum
 *  is 36 psf; the plans show 16 psf" and "Provide X, if Y" are judged part by part. */
function ahjClauses(sentence: string): string[] {
  return sentence.split(/;\s*|,?\s+(?=but\b)|,\s*(?=(?:if|unless|whether)\b)/i).map((c) => c.trim()).filter(Boolean);
}

function basisOf(sentence: string): string {
  return sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence;
}

/** One roof-attachment spacing stated in a text: where it sits, and its value in inches. */
export interface StatedAttachmentSpacing {
  at: number;
  inches: number;
  excerpt: string;
}

/**
 * ROOF-ATTACHMENT SPACING, o.c. — ONE reader for both sides of the question: what an AHJ
 * correction REQUIRES ("The mounting spacing should be 2' oc") and what a design STATES ("NEW
 * PV ATTACHMENTS AT 4'-0\" O.C."). An attachment label must sit within 60 chars before the
 * value, with no framing member between them — "RAFTER @ 16\" O.C." is framing, not an
 * attachment. Values outside 6..96 inches are not an attachment spacing.
 */
export function extractAttachmentSpacings(text: string): StatedAttachmentSpacing[] {
  const src = String(text || "");
  const spacings: Array<{ at: number; end: number; inches: number }> = [];
  let m: RegExpExecArray | null;
  const ftIn = /(\d+(?:\.\d+)?)\s*(?:'|’|ft\.?|feet|foot)\s*(?:-?\s*(\d+(?:\.\d+)?)\s*(?:"|”|in\.?))?\s*(?:o\.?\s*c\b\.?|on\s+cent(?:er|re))/gi;
  while ((m = ftIn.exec(src))) {
    const ft = toNumber(m[1]);
    const inch = m[2] ? toNumber(m[2]) ?? 0 : 0;
    if (ft != null) spacings.push({ at: m.index, end: m.index + m[0].length, inches: ft * 12 + inch });
  }
  const inOnly = /(\d+(?:\.\d+)?)\s*(?:"|”|in\.?|inch(?:es)?)\s*(?:o\.?\s*c\b\.?|on\s+cent(?:er|re))/gi;
  while ((m = inOnly.exec(src))) {
    // Skip the inch tail of a 4'-0" form already read above.
    if (spacings.some((s) => m!.index > s.at && m!.index - s.at < 12)) continue;
    const v = toNumber(m[1]);
    if (v != null) spacings.push({ at: m.index, end: m.index + m[0].length, inches: v });
  }
  const out: StatedAttachmentSpacing[] = [];
  for (const s of spacings) {
    const window = src.slice(Math.max(0, s.at - 60), s.at);
    const labels = [...window.matchAll(ATTACHMENT_LABEL)];
    if (!labels.length) continue;
    const last = labels[labels.length - 1];
    if (FRAMING_WORD.test(window.slice((last.index ?? 0) + last[0].length))) continue;
    if (s.inches < 6 || s.inches > 96) continue;
    // From the attachment word to the end of the value, nothing either side: on a roof plan the
    // next characters are the title block (the homeowner's name and address).
    const from = Math.max(0, s.at - 60) + (last.index ?? 0);
    out.push({ at: s.at, inches: Math.round(s.inches * 100) / 100, excerpt: flat(src.slice(from, s.end)).slice(0, 120) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// FIRE ACCESS PATHWAYS AND RIDGE SETBACKS, MEASURED (issue #142).
//
// The gate used to ask only whether a roof plan MENTIONED a fire pathway (city.fire.pathways-
// missing, a word list) and listed the AHJ's own placement rules under "confirm the roof plan
// meets them" (reviewer.plan.ahj-placement-rules): shown, never checked. A plan printing 18"
// PATHWAY for a jurisdiction that requires 36" passed both. This reads the NUMBERS, with ONE reader
// for both sides, as attachment spacing does: what the AHJ's rule requires ("minimum 36-inch
// pathways", "3 feet from the ridge") and what the plan states ("36\" FIRE ACCESS PATHWAY",
// "18\" SETBACK FROM RIDGE").
//
// A dimension belongs to the NEAREST label in its clause: a pathway word, a ridge, or a roof edge
// this does not check (eave, rake, hip, valley, gutter, a property line). "18\" FROM HIP/VALLEY" is
// a hip/valley clearance, not an 18" pathway, and "3' FROM EAVE" is not a ridge setback.
// ---------------------------------------------------------------------------

/** 36", 36 in, 36-inch, 3', 3 ft, 3-foot, 3'-0", 1'-6", "three (3) feet". Group 2 is the inch
 *  tail of a feet value; group 3 marks an inch-only value. */
// The units carry no leading \b, so "36in" and "3ft" (no space) read too.
const ROOF_DIM_VALUE = /(?<![\d.])(\d+(?:\.\d+)?)\s*\)?\s*-?\s*(?:(?:'(?!')|’|ft\b\.?|feet\b|foot\b)(?:\s*-?\s*(\d+(?:\.\d+)?)\s*(?:"|”|in\b\.?|inch(?:es)?\b))?|(''|"|”|in\b\.?|inch(?:es)?\b))/gi;
const ROOF_DIM_LABEL = /\b(?:(?<path>(?:fire\s+)?(?:access\s+)?path(?:way)?s?|walkways?|access\s+aisles?|fire\s+access)|(?<ridge>ridges?)|(?<other>eaves?|rakes?|hips?|valleys?|gutters?|edges?|(?:property|lot)\s+lines?))\b/gi;
/** A clause ends at a sentence stop (not an abbreviation's or a decimal's dot), a list mark, a
 *  comma or a joining "and"/"&": "36\" FROM RIDGE AND 18\" CLEAR OF HIPS" is two clauses, and the
 *  18" is the hips' (read across the "and", the ridge label won and a compliant plan blocked). */
const CLAUSE_BREAK = /(?<!\b(?:min|max|typ|approx|in|ft|no|o\.c|e\.g|i\.e))\.(?!\d)|[;,&•▪●■◦]|\band\b/i;
/** The gap from a value to the label after it is only a preposition ("36\" FROM RIDGE", "18\" CLEAR
 *  OF HIPS"): the value is attached to that label, even with no break after a ridge label before it. */
const ATTACHED_AFTER = /^\s*(?:(?:clear|setback|set\s+back|offset|min(?:imum)?\.?|max(?:imum)?\.?)\s+)?(?:from|of|to|at)\s+(?:the\s+)?$/i;
/** "RIDGE VENT 12\"", "RIDGE HEIGHT": a ridge, but not a setback from it. */
const RIDGE_NOT_SETBACK = /\b(?:vent|cap|height|board|beam|elev(?:ation)?)\b/i;
const ROOF_DIM_WINDOW = 60;

/** One fire access dimension a text states: where, which, how many inches. */
export interface ReadRoofPlanDimension {
  at: number;
  kind: RoofPlanDimensionKind;
  inches: number;
  excerpt: string;
}

/**
 * Every pathway width and ridge setback a text STATES, label-anchored, in inches (6..120). Pure
 * text in, so the same reader serves a plan sheet and an AHJ's fire setback rule.
 */
export function readRoofPlanDimensions(text: string): ReadRoofPlanDimension[] {
  const src = flat(String(text || ""));
  const out: ReadRoofPlanDimension[] = [];
  const values: Array<{ at: number; end: number; inches: number }> = [];
  for (const m of src.matchAll(ROOF_DIM_VALUE)) {
    const n = toNumber(m[1]);
    if (n == null) continue;
    const inches = m[3] ? n : n * 12 + (m[2] ? toNumber(m[2]) ?? 0 : 0);
    values.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, inches });
  }
  for (const v of values) {
    if (v.inches < 6 || v.inches > 120) continue;
    // The value's clause, at most ROOF_DIM_WINDOW characters either side.
    let from = Math.max(0, v.at - ROOF_DIM_WINDOW);
    const before = src.slice(from, v.at);
    let stop = -1;
    for (const b of before.matchAll(new RegExp(CLAUSE_BREAK.source, "gi"))) stop = (b.index ?? 0) + b[0].length;
    if (stop >= 0) from += stop;
    let to = Math.min(src.length, v.end + ROOF_DIM_WINDOW);
    const after = src.slice(v.end, to).search(CLAUSE_BREAK);
    if (after >= 0) to = v.end + after;
    let best: { kind: "path" | "ridge" | "other"; dist: number; start: number; end: number } | null = null;
    for (const l of src.slice(from, to).matchAll(ROOF_DIM_LABEL)) {
      const start = from + (l.index ?? 0);
      const end = start + l[0].length;
      const gap = end <= v.at ? src.slice(end, v.at) : start >= v.end ? src.slice(v.end, start) : null;
      if (gap == null) continue;
      // Another dimension between them: the label is that one's.
      if (values.some((o) => o !== v && o.at >= Math.min(end, v.end) && o.end <= Math.max(start, v.at))) continue;
      const kind = l.groups?.path ? "path" : l.groups?.ridge ? "ridge" : "other";
      if (kind === "ridge" && RIDGE_NOT_SETBACK.test(gap)) continue;
      // "RIDGE SETBACK: 18\"" assigns; "18\" CLEAR OF HIPS" attaches to the label after it;
      // otherwise a label AFTER the value wins a tie (callouts print "36\" FIRE ACCESS PATHWAY").
      const dist = end <= v.at ? (/^\s*[:=]/.test(gap) ? -1 : gap.length + 0.5) : ATTACHED_AFTER.test(gap) ? -0.5 : gap.length;
      if (!best || dist < best.dist) best = { kind, dist, start, end };
    }
    if (!best || best.kind === "other") continue;
    out.push({
      at: v.at,
      kind: best.kind === "path" ? "pathwayWidth" : "ridgeSetback",
      inches: Math.round(v.inches * 100) / 100,
      excerpt: src.slice(Math.min(best.start, v.at), Math.max(best.end, v.end)).slice(0, 120),
    });
  }
  return out;
}

/**
 * The fire access dimensions the PACKAGE states, per source (the same one-source-per-document
 * reading as the design criteria): the documents first, then the snapshot's sheet text, then the
 * parser's roof/site plan summaries, which are readings (derived) and never block alone.
 */
export function extractRoofPlanDimensions(project: ProjectRecord, extraTexts: DesignTextSource[] = []): StatedRoofPlanDimension[] {
  const out: StatedRoofPlanDimension[] = [];
  const seen = new Set<string>();
  for (const s of readSources(project, extraTexts)) {
    for (const d of readRoofPlanDimensions(s.text)) {
      const key = `${s.label}|${d.kind}|${d.inches}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: d.kind, inches: d.inches, source: s.label, excerpt: d.excerpt, derived: s.derived });
    }
  }
  return out;
}

/** The adopted IRC edition (or the IRC edition a state residential code is built on), else the IFC's. */
function fireCodeEditionYear(ctx: EffectiveCodeContext): number | null {
  for (const family of ["IRC", "IFC"]) {
    for (const a of ctx.adoptedCodes ?? []) {
      const e = profileCodeEntry(a);
      const year = Number(e.code === family ? e.edition : e.base?.code === family ? e.base.edition : "");
      if (year >= 2000 && year < 2100) return year;
    }
  }
  return null;
}

/**
 * WHAT THE ROOF PLAN MUST SHOW, per dimension: the jurisdiction's own number where one of its
 * fireSetbacks rules states it (the strictest, when several do), else the model-code default for
 * the adopted edition: 36 in pathways (IRC R324.6.1); a ridge setback of 18 in from the 2015 IRC
 * on (R324.6.2, mirroring IFC 2015 605.11.3.2.3: 18 in where the array covers no more than 33% of
 * the roof, 36 in above; coverage is not read here, so 18 in is the floor and the message names the
 * 36 in case), and 36 in before it (the 36-in-only text is the 2012 IFC's). Model-code lines never
 * block, so the floor can only under-warn, never stop a compliant plan.
 */
export function requiredRoofPlanDimensions(ctx: EffectiveCodeContext): RoofPlanRequiredDimension[] {
  const who = ctx.ahj || ctx.state || "the jurisdiction";
  const prov = fieldProvenance(ctx, "fireSetbacks");
  const year = fireCodeEditionYear(ctx);
  const edition = year != null ? `IRC ${year}` : "IRC (adopted edition not on file; 2015 or later assumed)";
  const out: RoofPlanRequiredDimension[] = [];
  for (const kind of ["pathwayWidth", "ridgeSetback"] as const) {
    let best: { inches: number; description: string } | null = null;
    for (const rule of ctx.fireSetbacks ?? []) {
      for (const d of readRoofPlanDimensions(rule.description)) {
        if (d.kind === kind && (!best || d.inches > best.inches)) best = { inches: d.inches, description: rule.description };
      }
    }
    if (best) {
      out.push({ kind, inches: best.inches, basis: "ahj", verified: prov.verified, source: `${who}'s rule "${flat(best.description).slice(0, 160)}" (${prov.text})` });
    } else if (kind === "pathwayWidth") {
      out.push({ kind, inches: 36, basis: "model_code", verified: false, source: `${edition} R324.6.1 model-code default; no ${who} pathway width on file` });
    } else if (year != null && year < 2015) {
      out.push({ kind, inches: 36, basis: "model_code", verified: false, source: `${edition} model-code default (3 ft from the ridge, IFC 2012); no ${who} ridge setback on file` });
    } else {
      out.push({ kind, inches: 18, basis: "model_code", verified: false, source: `${edition} R324.6.2 / IFC 605.11.3.2.3 model-code default (18 in each side of a horizontal ridge where the array covers no more than 33% of the roof; 36 in where it covers more, which is not read here); no ${who} ridge setback on file` });
    }
  }
  return out;
}

export const FIRE_PATHWAY_BELOW_ID = "city.fire.pathway-below-required";
export const FIRE_PATHWAY_UNMEASURED_ID = "city.fire.pathway-unmeasured";
const ROOF_DIM_NAME: Record<RoofPlanDimensionKind, string> = {
  pathwayWidth: "Fire access pathway width",
  ridgeSetback: "Array setback from the ridge",
};

interface RoofPlanBelowLine {
  req: RoofPlanRequiredDimension;
  values: Array<{ inches: number; source: string; excerpt: string; derived: boolean }>;
}

/**
 * RULE 3 SHAPE: a BLOCKER only when the requirement is the jurisdiction's own (fireSetbacks) on a
 * human-verified row AND a document, not the parser's reading, states the short dimension; every
 * other short dimension (a model-code default, a seeded rule, a parser summary, a number vision
 * read off the sheet image) is a WARNING that says which of those it lacks.
 */
function roofPlanBelowFinding(lines: RoofPlanBelowLine[], codeReferences: CodeReference[], vision: ReviewerVisionVerdict | null): ReviewerFinding {
  const blocks = !vision && lines.some((l) => l.req.basis === "ahj" && l.req.verified && l.values.some((v) => !v.derived));
  const text = lines.map((l) => {
    const stated = [...new Set(l.values.map((v) => `${v.inches} in (${v.source})`))].join(", ");
    const why = blocks ? [] : [
      vision ? `read from the sheet image by vision (page ${vision.page}, ${vision.confidence} confidence), not from a document's text` : "",
      l.req.basis === "model_code" ? "the requirement is the model-code default, not a rule on file for this jurisdiction" : "",
      l.req.basis === "ahj" && !l.req.verified ? "the jurisdiction's rule is not human-verified" : "",
      !vision && l.values.every((v) => v.derived) ? "only the parser's reading states it" : "",
    ].filter(Boolean);
    return `${ROOF_DIM_NAME[l.req.kind]}: stated ${stated}; requires at least ${l.req.inches} in — ${l.req.source}${why.length ? ` (a warning: ${why.join("; ")})` : ""}`;
  });
  const asks = lines.map((l) => l.req.kind === "pathwayWidth" ? `fire access pathways at least ${l.req.inches} in wide` : `the array at least ${l.req.inches} in from the ridge`);
  return {
    id: FIRE_PATHWAY_BELOW_ID,
    severity: blocks ? "blocker" : "warning",
    category: "plan_set",
    title: "Fire access pathway / ridge setback below the required dimension",
    message: `${text.join(". ")}.`,
    cityFeedback: `Revise the roof plan to provide ${asks.join(" and ")}, dimensioned on the plan.`,
    designTeamAction: "Re-lay the array so every fire access pathway and the ridge setback meet the required dimensions, then reissue the roof/site plan with those dimensions shown.",
    evidenceNeeded: [`Roof plan dimensioning ${asks.join(" and ")}`, ...text].slice(0, 6),
    codeReferences,
    installerCallout: true,
    evidenceStatus: vision ? "weak" : "verified",
    evidenceFound: lines.flatMap((l) => l.values.slice(0, 3).map((v): ReviewerFindingEvidence => ({
      kind: vision ? "source_excerpt" : v.derived ? "field_value" : "source_excerpt",
      label: `${ROOF_DIM_NAME[l.req.kind]} ${v.inches} in`,
      source: v.source,
      excerpt: v.excerpt,
      confidence: vision ? vision.confidence : v.derived ? "medium" : "high",
      pageHint: vision ? `page ${vision.page}` : "",
      screenshotPath: "",
      verifier: vision ? "vision" : v.derived ? "parser" : "rule_engine",
      note: `Compared against ${l.req.inches} in: ${l.req.source}.`,
    }))),
  };
}

function roofPlanRef(ctx: EffectiveCodeContext): CodeReference {
  return ref(ctx, "R324.6", "Roof access and pathways", "Fire access pathway widths and ridge setbacks for rooftop PV; the jurisdiction may amend them.");
}

/**
 * The measured fire access rule and its honest fallback, for a roof-mounted array:
 *   city.fire.pathway-below-required  a stated dimension below what the plan must show
 *   city.fire.pathway-unmeasured      no dimension readable from the text: a callout carrying the
 *                                     requirement (roofPlanRequired), so the vision pass can make
 *                                     its one measurement of the sheet against the same numbers
 * `measured` tells the caller whether any dimension was read (city.fire.pathways-missing, the
 * presence check, is then only the fallback for a plan with no pathway text or dimension).
 */
export function evaluateFirePathwayFindings(
  project: ProjectRecord,
  ctx: EffectiveCodeContext,
  opts: { roofMounted: boolean; extraTexts?: DesignTextSource[] },
): { findings: ReviewerFinding[]; measured: boolean } {
  if (!opts.roofMounted) return { findings: [], measured: false };
  const stated = extractRoofPlanDimensions(project, opts.extraTexts ?? []);
  const required = requiredRoofPlanDimensions(ctx);
  const codeReferences = [roofPlanRef(ctx)];
  if (!stated.length) {
    const who = ctx.ahj || ctx.state || "the jurisdiction";
    const wants = required.map((r) => `${ROOF_DIM_NAME[r.kind].toLowerCase()} at least ${r.inches} in (${r.source})`);
    // What the plan DOES say about pathways, quoted from the label to the end of its clause —
    // never the characters around it (title blocks carry the homeowner's name).
    let quote: { source: string; excerpt: string } | null = null;
    for (const s of readSources(project, opts.extraTexts ?? [])) {
      const m = /\b(?:fire\s+access|(?:access\s+)?pathways?|ridge\s+setback|setback\s+(?:from|at)\s+(?:the\s+)?ridge)\b/i.exec(s.text);
      if (!m) continue;
      const rest = s.text.slice(m.index, m.index + 120);
      const cut = rest.slice(1).search(CLAUSE_BREAK);
      quote = { source: s.label, excerpt: (cut >= 0 ? rest.slice(0, cut + 1) : rest).trim() };
      break;
    }
    return {
      measured: false,
      findings: [{
        id: FIRE_PATHWAY_UNMEASURED_ID,
        severity: "callout",
        category: "plan_set",
        title: "Fire pathway width and ridge setback not dimensioned in the plan text — not measured",
        message: `No fire access pathway width or ridge setback could be read from the package text, so neither has been measured against ${wants.join("; ")}.`
          + (quote ? ` The plan says: "${quote.excerpt}" (${quote.source}).` : " The package text does not mention fire access pathways at all."),
        cityFeedback: `Dimension the fire access pathways and the ridge setback on the roof plan; ${who} reviews them against ${required.map((r) => `${r.inches} in`).join(" / ")}.`,
        designTeamAction: `Confirm the roof plan dimensions each fire access pathway (at least ${required.find((r) => r.kind === "pathwayWidth")?.inches} in) and the ridge setback (at least ${required.find((r) => r.kind === "ridgeSetback")?.inches} in).`,
        evidenceNeeded: ["Dimensioned fire access pathways on the roof plan", "Dimensioned ridge setback on the roof plan"],
        codeReferences,
        installerCallout: false,
        evidenceStatus: "missing",
        evidenceFound: [quote
          ? { kind: "source_excerpt", label: "Pathway mention without a dimension", source: quote.source, excerpt: quote.excerpt, confidence: "low", pageHint: "", screenshotPath: "", verifier: "rule_engine", note: "The plan mentions fire access, but no width or setback dimension could be read next to it." }
          : { kind: "absence_check", label: "No pathway width or ridge setback stated", source: "Package text", excerpt: "No dimensioned fire access pathway or ridge setback in the package text.", confidence: "low", pageHint: "", screenshotPath: "", verifier: "rule_engine", note: "Absence check over the package text." }],
        roofPlanRequired: required,
      }],
    };
  }
  const lines: RoofPlanBelowLine[] = [];
  for (const req of required) {
    const values = stated.filter((s) => s.kind === req.kind && s.inches < req.inches);
    if (values.length) lines.push({ req, values });
  }
  return { measured: true, findings: lines.length ? [roofPlanBelowFinding(lines, codeReferences, null)] : [] };
}

/**
 * THE ONE VISION MEASUREMENT, APPLIED (reviewerVision.ts makes it within MAX_VISION_CHECKS and caches
 * it). A measured short dimension becomes city.fire.pathway-below-required — a WARNING at most: a
 * number read off a sheet image is not a document's statement, so it never blocks (rule 3). A
 * measurement that meets the requirement, or a low-confidence one, leaves the callout as it was,
 * with the verdict attached for the operator. Vision never relaxes anything here.
 */
export function applyRoofPlanMeasurement(finding: ReviewerFinding, verdict: ReviewerVisionVerdict): ReviewerFinding {
  const out: ReviewerFinding = { ...finding, visionVerification: verdict };
  const m = verdict.measured;
  if (finding.id !== FIRE_PATHWAY_UNMEASURED_ID || !verdict.checked || !m || verdict.confidence === "low" || !finding.roofPlanRequired?.length) return out;
  const lines: RoofPlanBelowLine[] = [];
  for (const req of finding.roofPlanRequired) {
    const inches = req.kind === "pathwayWidth" ? m.pathwayWidthIn : m.ridgeSetbackIn;
    if (typeof inches === "number" && inches > 0 && inches < req.inches) {
      lines.push({ req, values: [{ inches, source: "Plan-set sheet image (vision)", excerpt: verdict.observed.slice(0, 200), derived: true }] });
    }
  }
  if (!lines.length) return out;
  return { ...roofPlanBelowFinding(lines, finding.codeReferences, verdict), visionVerification: verdict };
}

/**
 * Text the PACKAGE itself carries, per source — for a check that a statement in the package
 * SATISFIES (a UL listing, a load path to the foundation). The parser's commentary is excluded
 * on purpose: reviewFlags ("UL 2703 listing not found") and stampRecommendation ("engineer must
 * show the load path to the foundation") talk ABOUT the package, and would clear the very
 * finding they describe.
 */
export function packageTextSources(project: ProjectRecord, extraTexts: DesignTextSource[] = []): DesignTextSource[] {
  // The same one-source-per-document reading as the criteria extractor (readSources): the
  // merged blob is not read a second time beside the documents it was merged from.
  const stamp = NARRATIVE_SOURCES.find(([key]) => key === "stampRecommendation")?.[1];
  return readSources(project, extraTexts)
    .filter((s) => s.label !== stamp)
    .map(({ label, text }) => ({ label, text }));
}

/** Every package text WITH its kind (readSources): `sheet` and not `derived` is a document's own
 *  words; anything else is a reading of one. For a rule outside this module that must say whether
 *  what it found is document-stated (the local amendment checks, amendmentChecks.ts). */
export function packageReadSources(project: ProjectRecord, extraTexts: DesignTextSource[] = []): Array<DesignTextSource & { derived: boolean; sheet: boolean }> {
  return readSources(project, extraTexts).map(({ label, text, derived, sheet }) => ({ label, text, derived, sheet }));
}

/** The package's OWN sheets only (per-document texts, the sheet text) — never the parser's
 *  narrative summaries, which are a reading of the documents. What "document-stated" means for
 *  the electrical sizing checks (electricalSizing.ts). */
export function sheetTextSources(project: ProjectRecord, extraTexts: DesignTextSource[] = []): DesignTextSource[] {
  return readSources(project, extraTexts)
    .filter((s) => s.sheet)
    .map(({ label, text }) => ({ label, text }));
}

/**
 * Every design requirement a correction's text STATES, deterministically (no LLM). Unit- and
 * label-anchored: a number is a ground snow load only when LABELLED ground snow / Pg and
 * carrying psf; a wind speed only with mph and a wind label; attachment spacing only with an
 * attachment label and an o.c. spacing, never a framing member's. A criterion stated with two
 * different values in one correction is ambiguous and yields nothing — a human reads it.
 *
 * `statusReading`: the text is a STATUS READING (the permit monitor's portal/public-page scrape, or
 * any correction a person did not paste) — decided by the caller from where the correction came from
 * (corrections.source), never from the words. On such a text a bare "Wind Speed 120 mph Exposure C"
 * is the application's own field as the page prints it, however the page labels itself, so bare
 * statements never count; cued comments still do. STATUS_PAGE stays as the narrower text check for a
 * person who pastes a whole status page.
 */
export function extractAhjRequiredCriteria(text: string, opts: { statusReading?: boolean } = {}): AhjRequiredCriterion[] {
  const found: AhjRequiredCriterion[] = [];
  const add = (criterion: JurisdictionCriterionKey, value: number | string | boolean, sentence: string): void => {
    const block = criterion === "maxAttachmentSpacingIn" || criterion === "listingEvidenceRequired" ? "prescriptive" : "designCriteria";
    found.push({ criterion, block, value, basis: basisOf(sentence) });
  };
  // A bullet inherits the requirement cue of the header it hangs under, for as long as the
  // bullets run ("Provide updated design criteria ... -Ground snow load 36 psf.").
  // A status page's bare "label value" lines are the application's own fields (see STATUS_PAGE).
  const statusPage = opts.statusReading === true || STATUS_PAGE.test(String(text || ""));
  let headerCue = false;
  // A header that asks for a DOCUMENT ("Provide calculations for the following:", "Provide a copy of
  // the engineer letter for:") lists what that document must cover — the PACKAGE's numbers. Its
  // bullets neither inherit a cue nor count as bare statements.
  let headerAsksDocument = false;
  // A document asked for with its list ON THE SAME LINE ("Provide calculations for the following:
  // ground snow load 16 psf; wind speed 110 mph."): every later clause and sentence of that line is
  // one of its items — no bare reading, no inherited cue — until the line ends.
  let lineDocumentList = false;
  for (const { text: sentence, bullet, opensList, lineStart } of ahjSentences(text)) {
    if (lineStart) lineDocumentList = false;
    const underDocument = (bullet && headerAsksDocument) || lineDocumentList;
    const inherited = bullet && headerCue && !underDocument;
    let sentenceHasCue = false;
    let sentenceAsksDocument = false;
    ahjClauses(sentence).forEach((clause, clauseIndex) => {
      const underInlineList = lineDocumentList;
      if (REJECTION_CUE.test(clause) || CONDITIONAL_START.test(clause) || PACKAGE_PREFIX.test(clause)) return;
      // "Provide ..." is a value's cue only with a code citation and no document asked for.
      const provideAt = clause.search(PROVIDE_CUE);
      const asksDocument = provideAsksForDocument(clause, provideAt);
      if (asksDocument) sentenceAsksDocument = true;
      if (asksDocument && clause.indexOf(":", provideAt) >= 0) lineDocumentList = true;
      const provideRequires = provideAt >= 0 && PER_CODE.test(clause) && !asksDocument;
      const cueAt = clause.search(REQUIREMENT_CUE);
      // "X is located in a special wind region" states the site's fact: its own cue. "Exposure C is
      // required" puts the value BEFORE its cue, so the whole (clean) clause is the requirement.
      const own = IMPERATIVE_START.test(clause) || TRAILING_REQUIREMENT.test(clause) ? 0
        : SPECIAL_WIND_STATEMENT.test(clause) ? clause.search(SPECIAL_WIND_STATEMENT)
          : provideRequires ? (cueAt >= 0 ? Math.min(cueAt, provideAt) : provideAt)
            : cueAt;
      // (A header asking for a document keeps this cue: headerAsksDocument turns it off for its items.)
      if (own >= 0 || provideAt >= 0) sentenceHasCue = true;
      const quote = clause.search(QUOTATION_CUE);
      // "The calculations show the minimum ... 25 psf" — the requirement is inside the quote.
      if (quote >= 0 && (own < 0 || quote < own)) return;
      const bare = !statusPage && !underDocument && !underInlineList && own < 0 && BARE_LABEL_START.test(clause) && clause.split(/\s+/).length <= BARE_MAX_WORDS;
      const inheritsHere = inherited && clauseIndex === 0 && !underInlineList;
      if (own < 0 && !inheritsHere && !bare) {
        // "Provide UL listing for the panels ..." asks for listing EVIDENCE: a flag, not a value.
        if (provideAt >= 0 && listingRequested(clause)) add("listingEvidenceRequired", true, sentence);
        return;
      }
      const from = own < 0 ? 0 : own;
      // A quotation AFTER the cue ends the requirement: "minimum is 36 psf, the plans show 16 psf".
      const q = clause.slice(from).search(QUOTATION_CUE);
      const to = q < 0 ? clause.length : from + q;
      extractClause(clause, from, to, (criterion, value) => add(criterion, value, sentence));
    });
    if (!bullet) {
      headerCue = sentenceHasCue;
      headerAsksDocument = sentenceAsksDocument;
    } else if (opensList) {
      // A header that is itself an item — under a section heading ("Structural Comments:\nProvide
      // calculations for the following:"), or a bullet ("- Provide calculations for the following:")
      // — heads what follows it, within the list it sits in: a document asked for at EITHER level
      // stays asked for, and a cue at either level carries to the items.
      headerCue = sentenceHasCue || headerCue;
      headerAsksDocument = sentenceAsksDocument || headerAsksDocument;
    }
  }
  // One criterion, one value per correction — two different values are ambiguous.
  const out: AhjRequiredCriterion[] = [];
  for (const criterion of [...new Set(found.map((f) => f.criterion))]) {
    const hits = found.filter((f) => f.criterion === criterion);
    if (new Set(hits.map((h) => String(h.value))).size !== 1) continue;
    out.push(hits[0]);
  }
  return out;
}

/** The labelled values of ONE requirement clause, between [from, to). */
function extractClause(
  clause: string,
  from: number,
  to: number,
  add: (criterion: JurisdictionCriterionKey, value: number | string | boolean) => void,
): void {
  let m: RegExpExecArray | null;
  // Special wind region — stated as the site's fact ("X is located in a special wind region"), or
  // named inside a requirement; never negated.
  if (/\bspecial\s+wind\s+(?:region|zone)\b/i.test(clause) && !/\bnot\b[^.]{0,40}\bspecial\s+wind/i.test(clause)) {
    if (SPECIAL_WIND_STATEMENT.test(clause) || from > 0 || IMPERATIVE_START.test(clause)) add("specialWindRegion", true);
  }

  // Ground snow load Pg (never Pg(asd), never roof snow, never a limit it must not exceed).
  const ground = /\bground\s+snow(?:\s+loads?)?(?:\s*\(?\s*p\s?g\s*\)?)?\s*(\(\s*asd\s*\)|,?\s*asd\b)?[^0-9$]{0,30}?(\d+(?:\.\d+)?)\s*(?:psf\b|pounds?\s+per\s+square\s+f(?:oo|ee)t|lbs?\s*\/\s*(?:sq\.?\s*ft|ft2|ft²))/gi;
  while ((m = ground.exec(clause))) {
    const valueAt = m.index + m[0].lastIndexOf(m[2]);
    if (m[1] || m.index + m[0].length <= from || valueAt >= to) continue;
    if (/(?:\bup\s*to|\bmax(?:imum)?\.?|\bexceed\b|\bnot\s+more\s+than|\bless\s+than|≤|<=|<)[^0-9]{0,24}$/i.test(clause.slice(Math.max(0, valueAt - 30), valueAt))) continue;
    const v = toNumber(m[2]);
    if (v != null && v > 0 && v <= 400) add("groundSnowLoadPsf", v);
  }
  const groundAfter = /(\d+(?:\.\d+)?)\s*psf\s+ground\s+snow\b/gi;
  while ((m = groundAfter.exec(clause))) {
    if (m.index < from || m.index >= to) continue;
    const v = toNumber(m[1]);
    if (v != null && v > 0 && v <= 400) add("groundSnowLoadPsf", v);
  }

  // Ultimate design wind speed. "minimum" is the requirement here; a maximum/rating is not.
  const wind = /(\d{2,3}(?:\.\d+)?)\s*mph\b/gi;
  while ((m = wind.exec(clause))) {
    if (m.index < from || m.index >= to) continue;
    const pre = clause.slice(0, m.index);
    const post = clause.slice(m.index + m[0].length);
    if (!/\bwind\b|\bv\s*[_(]?\s*ult\b|\bvult\b/i.test(pre) && !/^\s*(?:\(?\s*3[\s-]*sec(?:ond)?\.?[\s-]*gust\s*\)?\s*)?(?:ultimate\s+)?(?:design\s+)?wind\b/i.test(post)) continue;
    if (/(?:\bup\s*to|\bmax(?:imum)?\.?|\brated|\btested|\bexceed(?:s|ing)?|\bnot\s+more\s+than|\bless\s+than|≤|<=|<)[^0-9]{0,24}$/i.test(pre.slice(-30))) continue;
    const after = (post.match(/^\s*\(?\s*(?:v\s*[_(]?\s*(?:ult|asd)\b|vult|vasd|ultimate|nominal|asd)\b/i) ?? [""])[0];
    const qual = windQualifier(pre.slice(-40) + " " + after);
    if (qual === "nominal") continue; // the profile records the ULTIMATE speed (R301.2.1)
    const v = toNumber(m[1]);
    if (v != null && v >= 85 && v <= 250) add("windSpeedMph", v);
  }

  // Wind exposure category.
  const exposure = /\bexp(?:osure|\.)\s*(?:cat(?:egory|\.)?\s*)?[:=-]?\s*([BCD])(?![A-Za-z0-9])/gi;
  while ((m = exposure.exec(clause))) {
    if (m.index + m[0].length <= from || m.index + m[0].length - 1 >= to) continue;
    add("windExposure", m[1].toUpperCase());
  }

  // Roof-attachment spacing, o.c. — the shared reader (the design side uses it too).
  for (const sp of extractAttachmentSpacings(clause)) {
    if ((from > 0 && sp.at < from) || sp.at >= to) continue;
    add("maxAttachmentSpacingIn", sp.inches);
  }

  // The AHJ asked for module / racking LISTING evidence — a flag on its profile, not a number.
  if (listingRequested(clause)) add("listingEvidenceRequired", true);
}

function listingRequested(clause: string): boolean {
  return LISTING_WORD.test(clause) && LISTING_SUBJECT.test(clause);
}

// --- approved designs: corroboration, never the rule ----------------------------

const OBS_FIELD: Record<string, "groundSnowLoadPsf" | "windSpeedMph" | "windExposure"> = {
  groundSnowPsf: "groundSnowLoadPsf",
  windSpeedMph: "windSpeedMph",
  windExposure: "windExposure",
};

/** Less severe than the AHJ's value? (Lower snow/wind, a lower exposure letter.) */
function lessSevere(criterion: string, observed: number | string, required: number | string): boolean {
  if (criterion === "windExposure") return (EXPOSURE_RANK[String(observed).toUpperCase()] ?? 99) < (EXPOSURE_RANK[String(required).toUpperCase()] ?? 0);
  return typeof observed === "number" && typeof required === "number" && observed < required;
}

/**
 * "Approved designs used …" — what ISSUED projects in this AHJ stated, as corroboration. A
 * conservative design over-states the minimum, so this never becomes the AHJ's value; and a
 * value a LATER AHJ correction contradicted (the AHJ said more after that permit issued) is
 * dropped from the tally and counted as contradicted. Aggregates only — values, counts and
 * dates; no project, record number or address (the observations are pooled across tenants).
 */
export function approvedDesignsNote(ctx: EffectiveCodeContext, criteria: Array<"groundSnowPsf" | "windSpeedMph" | "windExposure">): string {
  const obs = ctx.approvedDesigns ?? [];
  if (!obs.length) return "";
  const parts: string[] = [];
  for (const criterion of criteria) {
    const field = OBS_FIELD[criterion];
    const ahjValue = (ctx.designCriteria as Record<string, unknown>)[field];
    const correctionAt = (ctx.profile?.citations ?? [])
      .filter((c) => c.kind === "ahj_correction" && c.field === `designCriteria.${field}` && c.at)
      .map((c) => String(c.at))
      .sort()
      .pop();
    const tally = new Map<string, { count: number; latest: string }>();
    let contradicted = 0;
    for (const o of obs) {
      const values = new Set(o.criteria
        .filter((c) => c.criterion === criterion && (criterion !== "windSpeedMph" || c.qualifier !== "nominal") && (criterion !== "groundSnowPsf" || c.qualifier === "ground"))
        .map((c) => String(c.value)));
      for (const value of values) {
        const typed: number | string = criterion === "windExposure" ? value : Number(value);
        if (correctionAt && correctionAt > o.issuedAt && (typeof ahjValue === "number" || typeof ahjValue === "string") && lessSevere(criterion, typed, ahjValue)) {
          contradicted++;
          continue;
        }
        const t = tally.get(value) ?? { count: 0, latest: "" };
        t.count++;
        if (o.issuedAt > t.latest) t.latest = o.issuedAt;
        tally.set(value, t);
      }
    }
    if (!tally.size && !contradicted) continue;
    const label = criterion === "groundSnowPsf" ? "ground snow" : criterion === "windSpeedMph" ? "wind" : "exposure";
    const unit = criterion === "groundSnowPsf" ? " psf" : criterion === "windSpeedMph" ? " mph" : "";
    const used = [...tally.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([v, t]) => `${criterion === "windExposure" ? `Exposure ${v}` : `${v}${unit}`} (${t.count} issued permit${t.count === 1 ? "" : "s"}, latest ${t.latest.slice(0, 10)})`);
    parts.push(`${label} ${used.join(", ") || "none"}${contradicted ? ` [${contradicted} lower value(s) contradicted by a later AHJ correction — not counted]` : ""}`);
  }
  if (!parts.length) return "";
  return ` Approved designs used: ${parts.join("; ")} — corroboration only, not the jurisdiction's requirement.`;
}

// --- findings ------------------------------------------------------------------

const EXPOSURE_RANK: Record<string, number> = { B: 1, C: 2, D: 3 };
const RISK_RANK: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4 };

/** "D1", "sdc d1", "Category D1" -> "D1"; anything that is not one category -> null. */
function normSdc(raw: unknown): string | null {
  const v = String(raw ?? "").trim().toUpperCase().replace(/^(?:SDC|SEISMIC(?:\s+DESIGN)?\s+CAT(?:EGORY|\.)?|CAT(?:EGORY|\.)?)\s*[:=]?\s*/, "");
  return /^(?:D[012]|[A-F])$/.test(v) ? v : null;
}
function normRiskCategory(raw: unknown): string | null {
  const v = normRisk(String(raw ?? "").trim().toUpperCase().replace(/^(?:RISK\s+CAT(?:EGORY|\.)?)\s*[:=]?\s*/, ""));
  return RISK_RANK[v] ? v : null;
}

/** A plan's SDC BELOW the jurisdiction's: A < B < C < D0 < D1 < D2 < E < F. A bare "D" (the IBC
 *  category, before the IRC split it into D0/D1/D2) spans all three: it is never below a D
 *  subcategory, nor a D subcategory below it — that difference is a wording, not a lower design. */
function sdcBelow(plan: string, ahj: string): boolean {
  const letter = (v: string): number => "ABCDEF".indexOf(v[0]);
  if (letter(plan) !== letter(ahj)) return letter(plan) < letter(ahj);
  if (plan.length < 2 || ahj.length < 2) return false;
  return plan[1] < ahj[1];
}

const CRITERION_LABEL: Record<string, string> = {
  "windSpeedMph|ultimate": "Wind speed (ultimate / unqualified)",
  "windSpeedMph|nominal": "Wind speed (nominal / ASD)",
  "windExposure|": "Wind exposure category",
  "groundSnowPsf|ground": "Ground snow load Pg",
  "groundSnowPsf|asd": "Ground snow load Pg(asd)",
  "riskCategory|": "Risk category",
};

/** Site-level quantities only. Roof snow legitimately varies by roof plane and slope
 *  factor (and a calculation prints Pf before the minimum governs), and the ASCE 7
 *  edition is a method citation, so neither is compared for conflict. */
function conflictGroup(c: StatedDesignCriterion): string | null {
  switch (c.criterion) {
    case "windSpeedMph": return `windSpeedMph|${c.qualifier === "nominal" ? "nominal" : "ultimate"}`;
    case "windExposure": return "windExposure|";
    case "groundSnowPsf": return `groundSnowPsf|${c.qualifier === "ground_asd" ? "asd" : "ground"}`;
    case "riskCategory": return "riskCategory|";
    default: return null;
  }
}

function unitFor(criterion: StatedDesignCriterionKind): string {
  return criterion === "windSpeedMph" ? " mph" : criterion === "groundSnowPsf" || criterion === "roofSnowPsf" ? " psf" : criterion === "frostDepthIn" ? " in" : "";
}

function statedEvidence(items: StatedDesignCriterion[], note: string): ReviewerFindingEvidence[] {
  return items.slice(0, 12).map((c) => ({
    kind: c.derived ? "field_value" : "source_excerpt",
    label: `${c.criterion} = ${c.value}${unitFor(c.criterion)}${c.qualifier !== "unspecified" ? ` (${c.qualifier})` : ""}`,
    source: c.source,
    excerpt: c.excerpt,
    confidence: c.derived ? "medium" : "high",
    pageHint: "",
    screenshotPath: "",
    verifier: c.derived ? "parser" : "rule_engine",
    note,
  }));
}

/** How far AHEAD of an upcoming edition's anticipated date a plan printing it softens a verified
 *  mismatch: a plan drawn to the next cycle a quarter early is ordinary, a year early is not. */
export const UPCOMING_SOFTEN_DAYS_BEFORE = 90;
/** How long AFTER the anticipated date the softening still holds. Past the date the edition is
 *  (or should be) in effect and the profile is expected to have caught up: `upcomingDue`
 *  (codeFamilies.ts) flags the row for re-research from that day on, and this grace is the time
 *  that research has to land. After it, a row that never caught up is stale and the mismatch
 *  blocks again (issue #124) — a past-dated row must not soften forever. */
export const UPCOMING_SOFTEN_DAYS_AFTER = 30;
/** `UpcomingCodeEdition.status` words that make an edition certain enough to soften (case-
 *  insensitive substring; helm's decision on #124). A missing status, "proposed", "in rulemaking"
 *  or "draft" is speculative and never softens. */
export const UPCOMING_SOFTENING_STATUSES = ["adopted", "filed", "effective"] as const;
/** A NEGATED status contains a softening word too: "not adopted", "unfiled", "not yet effective",
 *  "ineffective" all substring-match. A status that negates is not one that softens; erring this
 *  way only keeps a verified blocker a blocker. */
const UPCOMING_STATUS_NEGATED = /\b(?:not|no|never)\b|\bun-?(?:adopted|filed)\b|\bin-?effective\b|\bnon-?(?:adopted|filed|effective)\b/;

function upcomingStatusSoftens(status: string | undefined): boolean {
  const s = String(status ?? "").toLowerCase();
  if (UPCOMING_STATUS_NEGATED.test(s)) return false;
  return UPCOMING_SOFTENING_STATUSES.some((w) => s.includes(w));
}

/** The state's upcoming edition of exactly the code and edition a mismatch line compared, when its
 *  status reads as adopted/filed/effective and `asOf` falls in the window from `before` days ahead
 *  of its anticipated date to `after` days past it. Only that pair: a plan's upcoming base must not
 *  soften a mismatch on its state code, or vice versa. */
function upcomingWithin(ctx: EffectiveCodeContext, asOf: string | undefined, before: number, after: number): (stated: { code: string; edition: string }) => UpcomingCodeEdition | null {
  const now = Date.parse(String(asOf || new Date().toISOString()).slice(0, 10));
  const due = (ctx.profile?.upcoming ?? []).filter((u) => {
    if (!upcomingStatusSoftens(u.status)) return false;
    const when = Date.parse(String(u.anticipatedDate || "").slice(0, 10));
    return Number.isFinite(when) && Number.isFinite(now) && when - now <= before * 86_400_000 && now - when <= after * 86_400_000;
  });
  return (stated) => due.find((u) => normCodeToken(u.code) === normCodeToken(stated.code) && String(u.edition).trim() === stated.edition) ?? null;
}

/** The recorded PHASE-IN that still allows exactly the code and edition a mismatch line compared,
 *  on `asOf` (issue #216). A state that adopts a new edition often accepts the previous one until a
 *  mandatory date; a plan on that previous edition, filed inside the window, is not wrong.
 *  `editionsInEffect` (codeFamilies.ts) is the one helper that reads those windows. It answers per
 *  FAMILY (one current entry each), so it is asked about the entries of the compared CODE only:
 *  two codes of one family (IBC and IEBC) each in their own window each get their own answer.
 *  Only a window whose previous edition is ON FILE, for the same code token, softens: a window
 *  that does not say which edition it still allows, or that allows another code's edition, keeps
 *  the mismatch as it was. From the mandatory date on, `editionsInEffect` no longer reports a
 *  phase-in and the mismatch blocks. */
function graceWindowFor(ctx: EffectiveCodeContext, asOf: string | undefined): (stated: { code: string; edition: string }) => EditionsInEffect | null {
  const date = String(asOf || new Date().toISOString()).slice(0, 10);
  const entries = ctx.adoptedCodes ?? [];
  return (stated) => {
    const code = normCodeToken(stated.code);
    const sameCode = entries.filter((e) => normCodeToken(e.code) === code);
    const families = new Set(sameCode.map((e) => codeFamilyOf(e)));
    for (const family of families) {
      if (!family) continue;
      const window = editionsInEffect(sameCode, family, date);
      if (window.status !== "phase_in") continue;
      if (window.allowed.some((a) => a.role === "previous" && normCodeToken(a.code) === code && String(a.edition).trim() === stated.edition)) return window;
    }
    return null;
  };
}

/**
 * NO EDITIONS ON FILE — the plan's code basis next to the lookup state. A callout, never more:
 * the model-code defaults are placeholders (the "current cycle" says nothing about what this AHJ
 * adopted), and a seeded lookup that recorded no editions has nothing to compare with.
 */
function codeBasisUnverified(ctx: EffectiveCodeContext, basis: StatedCodeBasisEntry[], who: string): ReviewerFinding {
  const seen = new Set<string>();
  const claims: string[] = [];
  for (const b of basis) {
    const label = `${b.edition} ${b.code}${b.baseCode ? ` (${b.baseCode} ${b.baseEdition})` : ""}`;
    if (seen.has(label)) continue;
    seen.add(label);
    claims.push(label);
  }
  const at = ctx.profile?.researchedAt ? ` ${ctx.profile.researchedAt.slice(0, 10)}` : "";
  const lookup = !ctx.profile
    ? "no code profile on file yet (lookup not landed)"
    : ctx.verified
      ? `${provenance(ctx)} records no adopted editions`
      : `lookup landed seeded${at} without adopted editions`;
  // The model cycle, said as such: which stated editions are not the current model edition. With
  // no editions on file the context carries the model-code defaults (buildCodeContext).
  const defaults = new Map(ctx.adoptedCodes.map((d) => [normCodeToken(d.code), d.edition]));
  const offCycle = [...new Set(basis
    .filter((b) => defaults.has(normCodeToken(b.code)) && defaults.get(normCodeToken(b.code)) !== b.edition)
    .map((b) => `${b.code} ${b.edition} (current model edition ${defaults.get(normCodeToken(b.code))})`))];
  return {
    id: "city.code.basis-unverified",
    severity: "callout",
    category: "plan_set",
    title: "Jurisdiction's adopted code editions not on file — plan's code basis unchecked",
    message: `Plan states ${claims.slice(0, 8).join(" / ")}; ${who}'s adopted code editions are not on file — ${lookup}. The plan's code basis has NOT been checked against the jurisdiction's adoption.${offCycle.length ? ` For reference only (not the jurisdiction's adoption): ${offCycle.slice(0, 4).join("; ")}.` : ""}`,
    cityFeedback: `Confirm the code editions ${who} currently enforces and show them in the plan's governing-codes block.`,
    designTeamAction: `Look up the code editions ${who} has adopted (building, residential, electrical, fire) and confirm the plan's governing-codes block before submittal; record them on the jurisdiction's code profile so the next plan set is compared automatically.`,
    evidenceNeeded: ["Jurisdiction's adopted code editions", "Governing-codes block on the cover sheet"],
    codeReferences: [...new Set(basis.map((b) => normCodeToken(b.code)))]
      .filter((code) => MODEL_CODES.has(code))
      .slice(0, 4)
      .map((code) => ctx.citationFor(code, "Adopted edition", `${code} as adopted by ${who}`)),
    installerCallout: false,
    evidenceStatus: "weak",
    evidenceFound: basis.slice(0, 12).map((b) => ({
      kind: "source_excerpt" as const,
      label: `${b.code} ${b.edition}${b.baseCode ? ` (${b.baseCode} ${b.baseEdition})` : ""}`,
      source: b.source,
      excerpt: b.excerpt,
      confidence: "high" as const,
      pageHint: "",
      screenshotPath: "",
      verifier: "rule_engine" as const,
      note: "Stated by the package; not compared — the jurisdiction's editions are not on file.",
    })),
  };
}

function provenance(ctx: EffectiveCodeContext): string {
  // Name the ROW the value came from, not the project's AHJ: a city with no row of its own
  // resolves to the state-level default, and "City of X code profile (human-verified)" would
  // claim a verification nobody did for that city.
  const who = ctx.profile?.ahj ? `${ctx.profile.ahj} (${ctx.profile.state || ctx.state})` : `${ctx.state || "state"} state-level`;
  const url = ctx.designCriteria.sourceUrl ? `; source ${ctx.designCriteria.sourceUrl}` : "";
  if (ctx.verified) {
    const at = ctx.profile?.verifiedAt ? ` on ${ctx.profile.verifiedAt.slice(0, 10)}` : "";
    // seedReferenceCodeProfiles stamps shipped rows "verified" with verifiedBy
    // "reference-seed". That is a row nobody at this install checked — calling it
    // "human-verified by reference-seed" contradicts itself on the operator's screen.
    if (ctx.profile?.verifiedBy === "reference-seed") return `${who} code profile (verified via the shipped reference seed${at}, not by an operator here${url})`;
    const by = ctx.profile?.verifiedBy ? ` by ${ctx.profile.verifiedBy}` : "";
    return `${who} code profile (human-verified${by}${at}${url})`;
  }
  const at = ctx.profile?.researchedAt ? ` ${ctx.profile.researchedAt.slice(0, 10)}` : "";
  return `${who} code profile (seeded${at} — researched/imported, not yet human-verified${url})`;
}

/**
 * THE JURISDICTION'S OWN RESIDENTIAL CODE: the adopted code built on the IRC (STATE_CODE_BASE) —
 * ORSC, CRC, FBC-R, RCNYS … — else the IRC itself. A state code filed under the model token (the
 * research seeder's "IRC 2023 — 2023 Oregon Residential Specialty Code (ORSC) …", "IRC 2022 — 2022
 * California Residential Code (CRC) …") is read from its title, as profileCodeEntry reads it.
 * `token` is the adopted entry's own code, which citationFor looks the edition up by.
 */
function residentialFamily(ctx: EffectiveCodeContext): { family: string; token: string } {
  for (const a of ctx.adoptedCodes) {
    const entry = profileCodeEntry(a);
    if (entry.code !== "IRC" && baseModelCode(entry.code) === "IRC") return { family: entry.code, token: a.code };
  }
  return { family: "IRC", token: "IRC" };
}

/**
 * WHICH IRC SECTION NUMBERS A STATE RESIDENTIAL CODE KEEPS. A state code is an amended IRC, but it
 * may renumber, so a section is cited under the state code only where the mapping is KNOWN to be the
 * same; anywhere else the citation stays the IRC's number and says the state code's is unmapped.
 *  · ORSC: every section (the long-standing Oregon behaviour of these rules).
 *  · CRC (2022, Title 24 Part 2.5): R301.1.3 Engineered design and R324.4.1 (rooftop PV structural
 *    requirements) per the published CRC chapter 3 (ICC CARC2022 / UpCodes); R324.6 roof access and
 *    pathways per the shipped CA reference profile. R324.3.1 is NOT confirmed.
 *  · FBC-R (Florida Building Code, Residential): R301.1.3 Engineered design (ICC FLRC2020 / FLRC2023
 *    R301) and R324.3.1 Equipment listings (8th edition). R324.4.1 is NOT confirmed.
 * Never add a number here that no source states.
 */
const RESIDENTIAL_SECTIONS_SAME_AS_IRC: Readonly<Record<string, "all" | ReadonlySet<string>>> = {
  ORSC: "all",
  CRC: new Set(["R301.1.3", "R324.4.1", "R324.6"]),
  "FBC-R": new Set(["R301.1.3", "R324.3.1"]),
};

const IRC_FALLBACK_URL = "https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning";

function ref(ctx: EffectiveCodeContext, section: string, title: string, note: string): CodeReference {
  const { family, token } = residentialFamily(ctx);
  const same = RESIDENTIAL_SECTIONS_SAME_AS_IRC[family];
  const mapped = family === "IRC" || same === "all" || (same instanceof Set && same.has(section));
  if (!mapped) {
    // Not "IRC R324.3.1" as if the IRC were the adopted code, and not an invented state number.
    return {
      code: "IRC",
      section,
      title,
      adoptionScope: `${ctx.ahj || ctx.state || "This jurisdiction"} adopts the ${family}, built on the IRC; this is the IRC's section number.`,
      sourceUrl: IRC_FALLBACK_URL,
      note: `The ${family} section matching IRC ${section} is not mapped here — confirm the ${family} section before citing it. ${note}`.trim(),
    };
  }
  const cited = ctx.citationFor(token, section, title, {
    code: family,
    section,
    title,
    adoptionScope: "One- and two-family residential; verify the locally adopted edition.",
    sourceUrl: IRC_FALLBACK_URL,
    note,
  });
  // A state code filed under the model token cites as the state code: "2022 CRC", not "2022 IRC".
  const tokenNorm = normCodeToken(token);
  return tokenNorm !== family && new RegExp(`\\b${tokenNorm}$`).test(cited.code)
    ? { ...cited, code: cited.code.replace(new RegExp(`\\b${tokenNorm}$`), family) }
    : cited;
}

/** A residential-code citation (the state's own residential code where adopted and the section is
 *  known to match, else the IRC) at the jurisdiction's edition. */
export function residentialCodeRef(ctx: EffectiveCodeContext, section: string, title: string, note: string): CodeReference {
  return ref(ctx, section, title, note);
}

function describeValues(entries: Array<{ value: string | number; sources: Set<string> }>, unit: string): string {
  return entries.map((e) => `${e.value}${unit} in ${[...e.sources].join(", ")}`).join("; ");
}

// A MODEL CODE'S SPELLED-OUT NAME anywhere in a title ("… adoption of the 2021 International
// Residential Code", "based on the 2020 NFPA 70 (NEC)"), for reading a profile entry's base.
const MODEL_NAME_IN_TITLE: Array<[RegExp, string]> = [
  [/^international\s+residential\s+code\b/i, "IRC"],
  [/^international\s+building\s+code\b/i, "IBC"],
  [/^international\s+fire\s+code\b/i, "IFC"],
  [/^(?:national\s+electric(?:al)?\s+code|nfpa\s*70)\b/i, "NEC"],
  [/^international\s+energy\s+conservation\s+code\b/i, "IECC"],
  [/^international\s+existing\s+building\s+code\b/i, "IEBC"],
];

/** The editions of MODEL code "model" a profile entry's text states as a base: "based on the 2021
 *  IRC", "adoption of the 2021 International Residential Code", "based on the 2020 NFPA 70 (NEC)",
 *  "(NEC 2020)". The title decides; the notes only when the title states none. */
function statedBaseEdition(entry: { title?: string; notes?: string }, model: string): string | null {
  for (const said of [entry.title ?? "", entry.notes ?? ""]) {
    const editions = new Set<string>();
    const yearThen = /\b((?:19|20)\d{2})\s+(?:edition\s+(?:of\s+)?(?:the\s+)?)?/gi;
    let m: RegExpExecArray | null;
    while ((m = yearThen.exec(said))) {
      const rest = said.slice(m.index + m[0].length);
      const abbr = rest.match(/^([A-Z]{2,6})(?:\s*70)?\b/);
      const named = MODEL_NAME_IN_TITLE.find(([re]) => re.test(rest))?.[1];
      const code = named ?? (abbr ? normCodeToken(abbr[0].replace(/\s+/g, "")) : "");
      if (code === model) editions.add(m[1]);
    }
    const paren = /\(\s*([A-Z]{2,6})\s*[-:]?\s*((?:19|20)\d{2})\s*\)/g;
    while ((m = paren.exec(said))) if (normCodeToken(m[1]) === model) editions.add(m[2]);
    if (editions.size === 1) return [...editions][0];
    if (editions.size > 1) return null;
  }
  return null;
}

/**
 * ONE PROFILE ENTRY, READ LIKE WITH LIKE. The research seeder often files a STATE code under a
 * MODEL-code token with the STATE edition: "IRC 2023 | 2023 Oregon Residential Specialty Code
 * (ORSC) — … adoption of the 2021 International Residential Code", "NEC 2022 | 2022 California
 * Electrical Code (CEC) … based on the 2020 NFPA 70". Read as "IRC 2023" it is compared with a
 * plan's IRC edition, so a correct "(2021 IRC)" plan raises a mismatch and a stale "2021 ORSC"
 * is missed. When the entry's own title names a non-model code of the entry's edition, the entry
 * IS that code, and the model code is its base (only where the title states one).
 */
function profileCodeEntry(a: { code: string; edition: string; title?: string; notes?: string }): {
  code: string; edition: string; label: string; base: { code: string; edition: string } | null;
} {
  let code = normCodeToken(a.code);
  const edition = String(a.edition).trim();
  let label = `${a.code} ${a.edition}`;
  if (MODEL_CODES.has(code) && a.title) {
    const model = code;
    const named = namedItems(a.title)
      .map((i) => i.entry)
      .find((e) => !MODEL_CODES.has(e.code) && e.edition === edition && (baseModelCode(e.code) ?? model) === model);
    // No year in the title, but a state code's abbreviation: "Oregon Mechanical Specialty Code (OMSC)".
    const abbr = named ? null : a.title.match(/\(\s*([A-Z]{2,6})\s*\)/);
    const state = named?.code ?? (abbr && isCodeToken(abbr[1]) && !MODEL_CODES.has(normCodeToken(abbr[1])) && (baseModelCode(abbr[1]) ?? model) === model ? normCodeToken(abbr[1]) : "");
    if (state) {
      code = state;
      label = `${state} ${edition} (filed as ${a.code})`;
    }
  }
  // A base is read only for a state code, and only one consistent with the map ("(OSSC)" is none).
  const model = MODEL_CODES.has(code) ? undefined : baseModelCode(code);
  const baseEdition = model ? statedBaseEdition(a, model) : null;
  return { code, edition, label, base: model && baseEdition ? { code: model, edition: baseEdition } : null };
}

/** Whose row supplied a profile field, and was THAT row verified. A layered read records it per
 *  field (JurisdictionCodeProfile.fieldSources); a single row answers for all its fields. */
function fieldProvenance(ctx: EffectiveCodeContext, field: string): { verified: boolean; text: string; owner: string } {
  const src = ctx.profile?.fieldSources?.[field];
  const verified = src ? src.confidence === "verified" : ctx.verified;
  const ahj = src ? src.ahj : ctx.profile?.ahj ?? "";
  const state = (src?.state || ctx.profile?.state || ctx.state || "").toUpperCase();
  const verifiedBy = src ? src.verifiedBy : ctx.profile?.verifiedBy;
  const verifiedAt = src ? src.verifiedAt : ctx.profile?.verifiedAt;
  const who = ahj ? `${ahj} (${state})` : `${state || "state"} state-level`;
  // Whose minimum it is, in a sentence: the state's, unless the AHJ's own row carries it.
  const owner = ahj || state || "the state";
  if (!verified) return { verified, owner, text: `${who} code profile (seeded — researched/imported, not yet human-verified)` };
  if (verifiedBy === "reference-seed") return { verified, owner, text: `${who} code profile (verified via the shipped reference seed, not by an operator here)` };
  return { verified, owner, text: `${who} code profile (human-verified${verifiedBy ? ` by ${verifiedBy}` : ""}${verifiedAt ? ` on ${verifiedAt.slice(0, 10)}` : ""})` };
}

/** The minimum ground snow load that applies to this project's path, and which profile field holds
 *  it. Path known: its own minimum (none on file for that path -> null). Path unknown: the stricter
 *  of the minimums on file. */
function groundSnowMinimumFor(ctx: EffectiveCodeContext, path: "prescriptive" | "engineered" | ""): {
  required: number; field: string; mins: { prescriptive: number | null; engineered: number | null };
} | null {
  const p = ctx.prescriptive ?? {};
  const positive = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const mins = { prescriptive: positive(p.minGroundSnowPsfPrescriptive), engineered: positive(p.minGroundSnowPsfEngineered) };
  const usePrescriptive = path ? path === "prescriptive" : (mins.prescriptive ?? -1) >= (mins.engineered ?? -1);
  const required = usePrescriptive ? mins.prescriptive : mins.engineered;
  if (required == null) return null;
  return { required, field: `prescriptive.${usePrescriptive ? "minGroundSnowPsfPrescriptive" : "minGroundSnowPsfEngineered"}`, mins };
}

/**
 * THE ONE QUESTION EVERY GROUND-SNOW BLOCKER ASKS: what Pg does the package state, and is that
 * reading UNAMBIGUOUS? Three rounds of regex fixes to the unseparated load-list reader each closed one
 * layout and opened its mirror image, and each time the below-the-minimum rule turned the misread
 * number into a BLOCKER on a correct plan. So a blocker no longer trusts any single reading:
 *   · unambiguous = every Pg reading of the package (every source, parser fields included) is ONE
 *     value, and at least one of them is SURE — a pass-independent reading, not one only the
 *     label-first or only the value-first pass of an ambiguous run gave (extractSnowBothWays);
 *   · anything else (two values, or one value only an unsure pass read) is ambiguous: at most a
 *     warning that names every reading, never a blocker.
 * Pg only: a Pg(asd) or a roof snow load is a different quantity.
 */
export type GroundSnowReading =
  | { status: "none" }
  | { status: "unambiguous"; value: number }
  | { status: "ambiguous"; readings: Array<{ value: number; sources: string[]; unsure: boolean }> };

function readGroundSnow(stated: StatedReading): GroundSnowReading {
  const items = stated.criteria.filter((c) => c.criterion === "groundSnowPsf" && c.qualifier === "ground" && typeof c.value === "number");
  if (!items.length) return { status: "none" };
  const byValue = new Map<number, { value: number; sources: Set<string>; unsure: boolean }>();
  for (const c of items) {
    const value = c.value as number;
    const e = byValue.get(value) ?? { value, sources: new Set<string>(), unsure: true };
    e.sources.add(c.source);
    if (!stated.unsure.has(readingKey(c))) e.unsure = false;
    byValue.set(value, e);
  }
  const entries = [...byValue.values()];
  if (entries.length === 1 && !entries[0].unsure) return { status: "unambiguous", value: entries[0].value };
  return { status: "ambiguous", readings: entries.map((e) => ({ value: e.value, sources: [...e.sources], unsure: e.unsure })) };
}

/** The package's stated Pg, as the ground-snow blockers read it (readGroundSnow). */
export function statedGroundSnowReading(project: ProjectRecord, extraTexts: DesignTextSource[] = []): GroundSnowReading {
  return readGroundSnow(extractFromSources(project, readSources(project, extraTexts)));
}

/** "36 psf in Plan set; 25 psf in Plan set (one way of reading an unseparated load list)". */
function describeGroundReadings(reading: Extract<GroundSnowReading, { status: "ambiguous" }>): string {
  return reading.readings
    .map((r) => `${r.value} psf in ${r.sources.join(", ")}${r.unsure ? " [only one way of reading an unseparated load list]" : ""}`)
    .join("; ");
}
/** The sentence an ambiguous Pg adds to a finding: every reading, and why it is not a blocker. */
function ambiguousPgNote(reading: Extract<GroundSnowReading, { status: "ambiguous" }>): string {
  // An unsure reading is the extractor's doubt; sure readings that differ are the package's own conflict.
  const what = reading.readings.some((r) => r.unsure) ? "reads more than one way" : "states more than one value";
  return `The package's ground snow load ${what} (${describeGroundReadings(reading)}), so the ground snow load is a warning here, not a blocker: confirm which value is the design Pg on the plan set and in the engineer's letter/calculations.`;
}

function groundSnowMinimumFinding(
  stated: StatedReading,
  ctx: EffectiveCodeContext,
  path: "prescriptive" | "engineered" | "",
): ReviewerFinding | null {
  const criteria = stated.criteria;
  const p = ctx.prescriptive ?? {};
  const applies = groundSnowMinimumFor(ctx, path);
  if (!applies) return null;
  const { required, field, mins } = applies;
  // Pg only: a Pg(asd) (~0.7 x Pg) or a roof snow load under the minimum says nothing about Pg.
  const below = criteria.filter((c) => c.criterion === "groundSnowPsf" && c.qualifier === "ground" && typeof c.value === "number" && c.value < required);
  if (!below.length) return null;
  const reading = readGroundSnow(stated);
  const ambiguous = reading.status === "ambiguous" ? reading : null;
  const prov = fieldProvenance(ctx, field);
  const citation = String(p.minGroundSnowCitation || "").trim();
  const byValue = new Map<string, { value: string | number; sources: Set<string> }>();
  for (const c of below) {
    const e = byValue.get(String(c.value)) ?? { value: c.value, sources: new Set<string>() };
    e.sources.add(c.source);
    byValue.set(String(c.value), e);
  }
  // A DOCUMENT must state it for a blocker. The parser's "snow" field carries no qualifier — it
  // may hold a Pg(asd) or a roof snow load — so a value only the parser read is a warning.
  const documentStates = below.some((c) => !c.derived);
  const pathName = (k: "prescriptive" | "engineered"): string => (k === "prescriptive" ? "prescriptive" : "non-prescriptive");
  const pathWords = path === "prescriptive" ? "for prescriptive design"
    : path === "engineered" ? "for non-prescriptive (engineered) design"
      : "";
  const unknownTail = path ? "" : ` for ${required === mins.prescriptive ? "prescriptive" : "non-prescriptive"} design (the stricter minimum, used because the project's permit path is unknown)`;
  const others = path ? "" : [
    mins.prescriptive != null ? `${mins.prescriptive} psf prescriptive` : "",
    mins.engineered != null ? `${mins.engineered} psf non-prescriptive` : "",
  ].filter(Boolean).join(", ");
  const line = `Ground snow load Pg: stated ${describeValues([...byValue.values()], " psf")} — ${prov.owner}'s minimum${pathWords ? ` ${pathWords}` : ""} is ${required} psf${unknownTail}${citation ? ` (${citation})` : ""}`;
  const notes = [
    others ? `Minimums on file: ${others}. The permit path is unknown (no operator choice and no parser reading), so this is a warning until the path is set.` : "",
    documentStates ? "" : "Only the parser's reading states this value (no document text below the minimum was read); confirm it on the plan set.",
    ambiguous ? ambiguousPgNote(ambiguous) : "",
  ].filter(Boolean).join(" ");
  return {
    id: "city.struct.ground-snow-below-state-minimum",
    // A BLOCKER only on an UNAMBIGUOUS reading (readGroundSnow): the minimum never fires from a
    // number the extractor itself was unsure of, nor from one the package contradicts elsewhere.
    severity: path && prov.verified && documentStates && !ambiguous ? "blocker" : "warning",
    category: "structural",
    title: "Ground snow load below the state's minimum",
    message: `${line}.${notes ? ` ${notes}` : ""} Minimum from the ${prov.text}. The site-specific Pg may be higher than the minimum; it is never lower.`,
    cityFeedback: path
      ? `The design ground snow load is below the minimum ${required} psf${citation ? ` required by ${citation}` : ""} for ${pathName(path)} design. Revise the design criteria on the plan set and in the engineer's letter/calculations to the site-specific ground snow load, not less than ${required} psf.`
      : `The design ground snow load is below the minimum ground snow load${citation ? ` of ${citation}` : ""} (${others}). Revise the design criteria on the plan set and in the engineer's letter/calculations to the site-specific ground snow load, not less than the minimum for the permit path.`,
    designTeamAction: `${path ? "" : "Set the permit path (prescriptive or engineered) on the project. "}Look up the site's ground snow load (not less than ${path ? `${required} psf` : "the minimum for that path"}), re-run the structural design at that value, and reissue the plan-set design criteria and the engineer's letter/calculations.`,
    evidenceNeeded: ["Site-specific ground snow load Pg (not less than the state minimum)", "Plan-set design criteria at that Pg", "Engineer's letter/calculation at that Pg", line].slice(0, 6),
    codeReferences: [ref(ctx, "R301.2.3", "Snow loads", `${citation ? `${citation}: ` : ""}minimum ground snow load ${others || `${required} psf`}.`)],
    installerCallout: true,
    evidenceStatus: "verified",
    evidenceFound: statedEvidence(below, `Compared against the minimum in the ${prov.text}.`),
  };
}

/**
 * The "criteria not on file" finding's wording from where the AHJ's lookup stands (null = no lookup
 * in the window: the plain "not on file" wording). Same finding id and severity either way — only
 * the words change, so the four tests that pin the id keep pinning it.
 */
function designLookupWording(
  ctx: EffectiveCodeContext,
  who: string,
  missing: string[],
  snowMissing: boolean,
  windMissing: boolean,
): { title: string; lead: string; tail: string } | null {
  const lk = ctx.designLookup;
  if (!lk) return null;
  const day = lk.at ? String(lk.at).slice(0, 10) : "";
  const what = `${missing.join(" and ")}`;
  if (lk.status === "queued" || lk.status === "running") {
    return {
      title: "Jurisdiction design criteria lookup in progress — stated values not yet checked",
      lead: `${who}'s ${what} ${missing.length > 1 ? "are" : "is"} being looked up now (lookup ${lk.status}${day ? ` since ${day}` : ""})`,
      tail: " The gate re-judges automatically when the lookup lands.",
    };
  }
  if (lk.status === "retrying" || lk.status === "incomplete") {
    return {
      title: lk.status === "retrying" ? "Jurisdiction design criteria lookup incomplete — retrying" : "Jurisdiction design criteria lookup incomplete — verify with the AHJ",
      lead: `The lookup for ${who}'s ${what}${day ? ` (${day})` : ""} did not finish (failed, cut off, or found no web results)`,
      tail: lk.status === "retrying" ? " It is retried automatically; the gate re-judges when it lands." : " Automatic retries are used up for now; confirm the values with the AHJ.",
    };
  }
  // landed: a complete lookup ran and the row still lacks these criteria.
  const items = lk.items ?? [];
  const site = items.filter((i) => i.status === "site_specific" && ((snowMissing && i.item === "groundSnowLoad") || (windMissing && i.item === "windSpeed")));
  const siteNote = site.map((i) => `${i.item === "groundSnowLoad" ? "ground snow load" : "wind speed"} is published per site${i.note ? ` (${i.note})` : ""}${i.sourceUrl ? ` — ${i.sourceUrl}` : ""}`);
  return {
    title: "Jurisdiction design criteria looked up — no jurisdiction-wide value found",
    lead: `A lookup${day ? ` on ${day}` : ""} found no jurisdiction-wide ${what} for ${who} on an official page`,
    tail: siteNote.length ? ` Site-specific: ${siteNote.join("; ")}. Use the site's value from that source.` : "",
  };
}

export function evaluateDesignCriteriaFindings(
  project: ProjectRecord,
  ctx: EffectiveCodeContext,
  opts: {
    roofMounted: boolean;
    extraTexts?: DesignTextSource[];
    /** The project's permit path as its wording scopes it (permitPath.pathWordingScope): "" = not
     *  decided. Picks which state minimum ground snow load applies. */
    permitPath?: "prescriptive" | "engineered" | "";
    /** The day "within 90 days of an upcoming edition" is measured from (ISO); defaults to today. */
    asOf?: string;
  },
): ReviewerFinding[] {
  const sources = readSources(project, opts.extraTexts ?? []);
  const stated = extractFromSources(project, sources);
  const out: ReviewerFinding[] = [];
  // ONE DOCUMENT, NOT TWO: a text wholly contained in another (a sheet re-uploaded on its own,
  // a page copied into a combined PDF) is the same pages, not a second document agreeing or
  // disagreeing with the first.
  const textOf = new Map(sources.map((s) => [s.label, s.text]));
  const sameDocument = (a: string, b: string): boolean => {
    if (a === b) return true;
    const ta = textOf.get(a) ?? "";
    const tb = textOf.get(b) ?? "";
    return !!ta && !!tb && (ta.includes(tb) || tb.includes(ta));
  };
  const who = ctx.ahj || ctx.state || "the jurisdiction";

  // (a) CONFLICT — one labelled quantity, two values, in one package.
  const groups = new Map<string, StatedDesignCriterion[]>();
  for (const c of stated.criteria) {
    const g = conflictGroup(c);
    if (!g) continue;
    const list = groups.get(g) ?? [];
    list.push(c);
    groups.set(g, list);
  }
  const conflictLines: string[] = [];
  const conflictItems: StatedDesignCriterion[] = [];
  let conflictBlocker = false;
  for (const [group, items] of groups) {
    const byValue = new Map<string, { value: string | number; sources: Set<string>; docSources: Set<string> }>();
    for (const c of items) {
      const key = String(c.value);
      const e = byValue.get(key) ?? { value: c.value, sources: new Set<string>(), docSources: new Set<string>() };
      e.sources.add(c.source);
      // A document counts toward a two-document BLOCKER only with a value it states SURELY: a value
      // only one pass of an ambiguous load list gave is not that document's statement.
      if (!c.derived && !stated.unsure.has(readingKey(c))) e.docSources.add(c.source);
      byValue.set(key, e);
    }
    if (byValue.size < 2) continue;
    const entries = [...byValue.values()];
    // Blocker only when two DIFFERENT documents each explicitly state a different value.
    // The parser's fields and narrative summaries are readings, not documents: a disagreement
    // that needs one of them to exist is a warning (and may be the parser's mistake, or the
    // parser describing ONE document's own inconsistency, rather than two documents'.)
    for (let i = 0; i < entries.length && !conflictBlocker; i++) {
      for (let j = 0; j < entries.length && !conflictBlocker; j++) {
        if (i === j) continue;
        for (const s1 of entries[i].docSources) {
          if ([...entries[j].docSources].some((s2) => !sameDocument(s1, s2))) { conflictBlocker = true; break; }
        }
      }
    }
    const criterion = items[0].criterion;
    conflictLines.push(`${CRITERION_LABEL[group] ?? group}: ${describeValues(entries, unitFor(criterion))}`);
    conflictItems.push(...items);
  }
  if (conflictLines.length) {
    const sources = [...new Set(conflictItems.map((c) => c.source))];
    out.push({
      id: "city.struct.design-criteria-conflict",
      severity: conflictBlocker ? "blocker" : "warning",
      category: "structural",
      title: "Design criteria conflict between documents",
      message: `The package states different values for the same design criterion. ${conflictLines.join(". ")}.`
        + (conflictBlocker ? "" : " (No two documents disagree here: the values come from one document, or one side is the parser's reading of the package — verify before treating it as a document conflict.)"),
      cityFeedback: "The structural design criteria conflict between the calculations and the submitted plan set. Ensure the same design criteria (wind speed and its basis, exposure category, ground snow load, risk category) appear on all documents. A later document stating that it supersedes another does not reconcile the package — revise the superseded sheets.",
      designTeamAction: `Reconcile the design criteria across ${sources.join(", ")}: pick the governing values (at least the jurisdiction's minimums), then reissue every sheet and calculation that states them.`,
      evidenceNeeded: ["Revised plan-set structural notes with the governing design criteria", "Calculation / engineer's letter restating the same criteria", ...conflictLines].slice(0, 8),
      codeReferences: [ref(ctx, "R106.1", "Construction documents — information on construction documents", "Construction documents must be consistent; the examiner reviews the package as submitted."), ref(ctx, "Table R301.2", "Climatic and geographic design criteria", "Wind speed, exposure and ground snow load are design criteria the whole package must state consistently.")],
      installerCallout: true,
      evidenceStatus: "verified",
      evidenceFound: statedEvidence(conflictItems, "Stated design criterion (label-anchored)."),
    });
  }

  // (b) BELOW THE AHJ — like with like: ultimate/unqualified wind speed against the AHJ's
  // (ultimate, IRC R301.2.1) speed; ground Pg against Pg; exposure B < C < D.
  const dc = ctx.designCriteria ?? {};
  const ahjWind = typeof dc.windSpeedMph === "number" && dc.windSpeedMph > 0 ? dc.windSpeedMph : null;
  const ahjSnow = typeof dc.groundSnowLoadPsf === "number" && dc.groundSnowLoadPsf > 0 ? dc.groundSnowLoadPsf : null;
  const ahjExposure = typeof dc.windExposure === "string" && EXPOSURE_RANK[dc.windExposure.trim().toUpperCase().replace(/^EXP(?:OSURE)?\s*/, "")]
    ? dc.windExposure.trim().toUpperCase().replace(/^EXP(?:OSURE)?\s*/, "")
    : null;
  const below: StatedDesignCriterion[] = [];
  const belowLines: string[] = [];
  // The profile field behind each line: its severity is THAT field's row's (fieldProvenance).
  const belowFields: string[] = [];
  const collect = (field: string, label: string, unit: string, required: string, pick: (c: StatedDesignCriterion) => boolean): void => {
    const hits = stated.criteria.filter(pick);
    if (!hits.length) return;
    below.push(...hits);
    belowFields.push(`designCriteria.${field}`);
    const byValue = new Map<string, { value: string | number; sources: Set<string> }>();
    for (const c of hits) {
      const e = byValue.get(String(c.value)) ?? { value: c.value, sources: new Set<string>() };
      e.sources.add(c.source);
      byValue.set(String(c.value), e);
    }
    belowLines.push(`${label}: stated ${describeValues([...byValue.values()], unit)} — ${who} requires ${required}`);
  };
  if (ahjWind != null) {
    collect("windSpeedMph", "Wind speed", " mph", `${ahjWind} mph (ultimate)`, (c) => c.criterion === "windSpeedMph" && c.qualifier !== "nominal" && typeof c.value === "number" && c.value < ahjWind);
  }
  if (ahjExposure) {
    collect("windExposure", "Wind exposure", "", `Exposure ${ahjExposure}`, (c) => c.criterion === "windExposure" && (EXPOSURE_RANK[String(c.value)] ?? 99) < EXPOSURE_RANK[ahjExposure]);
  }
  // The wind lines can block; the ground snow line blocks only on an UNAMBIGUOUS reading
  // (readGroundSnow) — the same question the state-minimum rule asks.
  const linesBeforeSnow = belowLines.length;
  let snowAmbiguous = false;
  if (ahjSnow != null) {
    collect("groundSnowLoadPsf", "Ground snow load", " psf", `${ahjSnow} psf`, (c) => c.criterion === "groundSnowPsf" && c.qualifier === "ground" && typeof c.value === "number" && c.value < ahjSnow);
    const reading = belowLines.length > linesBeforeSnow ? readGroundSnow(stated) : null;
    if (reading?.status === "ambiguous") {
      snowAmbiguous = true;
      belowLines[belowLines.length - 1] += ` (${ambiguousPgNote(reading)})`;
    }
  }
  // WHOSE VALUE, VERIFIED BY WHOM. The merged profile's confidence is the WEAKER layer's, so a
  // human-verified AHJ row under a seeded state layer (Utah, #110) read as seeded and never blocked.
  // Each wind / exposure / ground snow line blocks only when the row that supplied ITS field is
  // verified, as the state-minimum rule does; the ground snow line also needs an unambiguous
  // reading (readGroundSnow). The #111 lines below carry their own per-line policy (moreBlocks).
  const basicLines = belowLines.length;
  const belowBlocks = belowFields.slice(0, basicLines)
    .filter((_, i) => i < linesBeforeSnow || !snowAmbiguous)
    .some((f) => fieldProvenance(ctx, f).verified);
  // (b1) THE CHEAP NUMERIC ONES (issue #111): seismic design category, frost depth, risk category,
  // and an ALLOWABLE-STRESS ground snow load against the AHJ's own pg(asd). Same finding, and the
  // same policy as the lines above — but asked PER LINE, of the row that holds that field:
  //   · a blocker only when the field's row is human-verified (fieldProvenance) AND a document —
  //     not the parser's reading, and not one pass of an ambiguous load list — states the value AND
  //     every reading of that criterion in the package is one value;
  //   · otherwise a warning that says which of those it lacks.
  // Pg(asd) is compared ONLY with the AHJ's pg(asd): it is ~0.7 x Pg, so against the strength Pg it
  // would always read "below" — which is why the line above never compares it.
  const ahjSdc = normSdc(dc.seismicDesignCategory);
  const ahjFrost = typeof dc.frostDepthIn === "number" && dc.frostDepthIn > 0 ? dc.frostDepthIn : null;
  const ahjRisk = normRiskCategory(dc.riskCategory);
  const ahjSnowAsd = typeof dc.groundSnowLoadAsdPsf === "number" && dc.groundSnowLoadAsdPsf > 0 ? dc.groundSnowLoadAsdPsf : null;
  let moreBlocks = false;
  const compareMore = (
    label: string, unit: string, required: string, field: keyof JurisdictionDesignCriteria,
    same: (c: StatedDesignCriterion) => boolean, isBelow: (c: StatedDesignCriterion) => boolean,
  ): void => {
    const before = belowLines.length;
    collect(field, label, unit, required, (c) => same(c) && isBelow(c));
    if (belowLines.length === before) return;
    const hits = stated.criteria.filter((c) => same(c) && isBelow(c));
    const prov = fieldProvenance(ctx, `designCriteria.${field}`);
    const documentStates = hits.some((c) => !c.derived && !stated.unsure.has(readingKey(c)));
    const oneValue = new Set(stated.criteria.filter(same).map((c) => String(c.value))).size === 1;
    if (prov.verified && documentStates && oneValue) { moreBlocks = true; return; }
    const why = [
      prov.verified ? "" : "the AHJ value is not human-verified",
      documentStates ? "" : "only the parser's reading states it",
      oneValue ? "" : "the package states more than one value",
    ].filter(Boolean);
    belowLines[belowLines.length - 1] += ` (a warning: ${why.join("; ")})`;
  };
  if (ahjSdc) {
    compareMore("Seismic design category", "", `Seismic Design Category ${ahjSdc}`, "seismicDesignCategory",
      (c) => c.criterion === "seismicDesignCategory" && normSdc(c.value) != null,
      (c) => sdcBelow(normSdc(c.value)!, ahjSdc));
  }
  if (ahjFrost != null) {
    compareMore("Frost depth", " in", `${ahjFrost} in`, "frostDepthIn",
      (c) => c.criterion === "frostDepthIn" && typeof c.value === "number",
      (c) => (c.value as number) < ahjFrost);
  }
  if (ahjRisk) {
    compareMore("Risk category", "", `Risk Category ${ahjRisk}`, "riskCategory",
      (c) => c.criterion === "riskCategory" && normRiskCategory(c.value) != null,
      (c) => RISK_RANK[normRiskCategory(c.value)!] < RISK_RANK[ahjRisk]);
  }
  if (ahjSnowAsd != null) {
    compareMore("Ground snow load pg(asd)", " psf", `${ahjSnowAsd} psf pg(asd) (allowable-stress)`, "groundSnowLoadAsdPsf",
      (c) => c.criterion === "groundSnowPsf" && c.qualifier === "ground_asd" && typeof c.value === "number",
      (c) => (c.value as number) < ahjSnowAsd);
  }
  const belowProvenance = ctx.profile?.fieldSources
    ? [...new Set(belowFields.map((f) => fieldProvenance(ctx, f).text))].join(" / ")
    : provenance(ctx);
  if (belowLines.length) {
    out.push({
      id: "city.struct.design-criteria-below-ahj",
      severity: belowBlocks || moreBlocks ? "blocker" : "warning",
      category: "structural",
      title: "Design criteria below the jurisdiction's requirement",
      message: `${belowLines.join(". ")}. AHJ value from the ${belowProvenance}.${approvedDesignsNote(ctx, [
        ...(ahjWind != null ? ["windSpeedMph" as const] : []),
        ...(ahjExposure ? ["windExposure" as const] : []),
        ...(ahjSnow != null ? ["groundSnowPsf" as const] : []),
      ])}`,
      cityFeedback: `Provide updated design criteria on the plan set and in the engineer's letter/calculations. ${who} design criteria: ${[ahjWind != null ? `wind ${ahjWind} mph ultimate` : "", ahjExposure ? `Exposure ${ahjExposure}` : "", ahjSnow != null ? `ground snow ${ahjSnow} psf` : "", ahjSnowAsd != null ? `ground snow pg(asd) ${ahjSnowAsd} psf` : "", ahjSdc ? `Seismic Design Category ${ahjSdc}` : "", ahjRisk ? `Risk Category ${ahjRisk}` : "", ahjFrost != null ? `frost depth ${ahjFrost} in` : ""].filter(Boolean).join(", ")}. Revise attachment spacing and member checks to the corrected loads.`,
      designTeamAction: "Re-run the structural design (attachment spacing, member capacity, uplift) at the jurisdiction's criteria and reissue the plan-set structural notes and the engineer's letter with the corrected values.",
      evidenceNeeded: ["Plan-set design criteria matching the jurisdiction", "Engineer's letter/calculation at the jurisdiction's criteria", "Attachment spacing revised to the corrected loads", ...belowLines].slice(0, 8),
      codeReferences: [ref(ctx, "Table R301.2", "Climatic and geographic design criteria (established by the jurisdiction)", "The jurisdiction sets wind speed, exposure and ground snow load; a design below them is not approvable."), ref(ctx, "R301.2.1", "Wind design criteria", "Compare ultimate design wind speed (Vult) to the jurisdiction's value."), ref(ctx, "R301.2.3", "Snow loads", "Ground snow load Pg per the jurisdiction's criteria."),
        ...(ahjSdc ? [ref(ctx, "R301.2.2", "Seismic provisions", "The seismic design category per the jurisdiction's criteria.")] : []),
        ...(ahjFrost != null ? [ref(ctx, "R403.1.4.1", "Frost protection", "Footings extend below the jurisdiction's frost line depth.")] : [])],
      installerCallout: true,
      evidenceStatus: "verified",
      evidenceFound: statedEvidence(below, `Compared against ${provenance(ctx)}.`),
    });
  }

  // (b2) BELOW THE STATE'S MINIMUM GROUND SNOW LOAD — a floor under whatever the site value is
  // (Oregon, ORSC 2023 R301.2.3.1: Pg from the SEAO lookup, never less than 36 psf for prescriptive
  // design or 25 psf for non-prescriptive design). The package's stated Pg — never Pg(asd), never
  // roof snow — against the minimum for the project's path. A blocker only when the ROW carrying
  // the minimum is human-verified (the merged profile's confidence is the weaker layer's, so a
  // seeded city row over a verified state row must not demote the state's verified floor), and
  // only when the path is known: with the path undecided the stricter minimum is used, as a
  // warning that says so.
  const minFinding = groundSnowMinimumFinding(stated, ctx, opts.permitPath ?? "");
  if (minFinding) out.push(minFinding);

  // (b3) ABOVE THE PRESCRIPTIVE PATH'S WIND CAP — the plan's stated Vult against the cap for the
  // exposure it states (maxWindSpeedMphExpB / ExpC), on the prescriptive path only. Always a
  // WARNING: permitPath already decides the path, and a speed over the cap does not make the design
  // wrong — it means this design needs the engineered path, not the prescriptive one.
  if (opts.permitPath === "prescriptive") {
    const p = ctx.prescriptive ?? {};
    const caps: Record<string, number | null> = {
      B: typeof p.maxWindSpeedMphExpB === "number" && p.maxWindSpeedMphExpB > 0 ? p.maxWindSpeedMphExpB : null,
      C: typeof p.maxWindSpeedMphExpC === "number" && p.maxWindSpeedMphExpC > 0 ? p.maxWindSpeedMphExpC : null,
    };
    const winds = stated.criteria.filter((c) => c.criterion === "windSpeedMph" && c.qualifier !== "nominal" && typeof c.value === "number");
    const exposures = stated.criteria.filter((c) => c.criterion === "windExposure");
    const capLines: string[] = [];
    const capItems: StatedDesignCriterion[] = [];
    const capFields: string[] = [];
    for (const letter of [...new Set(exposures.map((c) => String(c.value)))]) {
      const cap = caps[letter];
      if (cap == null) continue;
      const over = winds.filter((c) => (c.value as number) > cap);
      if (!over.length) continue;
      const byValue = new Map<string, { value: string | number; sources: Set<string> }>();
      for (const c of over) {
        const e = byValue.get(String(c.value)) ?? { value: c.value, sources: new Set<string>() };
        e.sources.add(c.source);
        byValue.set(String(c.value), e);
      }
      const field = `prescriptive.maxWindSpeedMphExp${letter}`;
      capFields.push(field);
      capLines.push(`Wind speed: stated ${describeValues([...byValue.values()], " mph")} in Exposure ${letter} — ${who}'s prescriptive path allows at most ${cap} mph in Exposure ${letter} (${fieldProvenance(ctx, field).text})`);
      capItems.push(...over, ...exposures.filter((c) => String(c.value) === letter));
    }
    if (capLines.length) {
      out.push({
        id: "city.struct.wind-exceeds-prescriptive-cap",
        severity: "warning",
        category: "structural",
        title: "Wind speed above the prescriptive path's limit — engineered path needed",
        message: `${capLines.join(". ")}. The project is on the prescriptive path, but its stated design wind speed is above what that path covers: an engineered design (stamped calculations) is needed, or the stated speed is wrong.`,
        cityFeedback: `The design wind speed exceeds the limit of the prescriptive path for the stated exposure. Provide an engineered design (stamped structural calculations) for the stated wind speed, or correct the design criteria.`,
        designTeamAction: "Confirm the site's ultimate design wind speed and exposure. If they are right, move the project to the engineered path and provide stamped structural calculations; if not, correct the design criteria on the plan set.",
        evidenceNeeded: ["Site ultimate design wind speed and exposure", "Engineered structural calculations (stamped), if the speed is above the prescriptive limit", ...capLines].slice(0, 6),
        codeReferences: [ref(ctx, "R301.2.1", "Wind design criteria", "The prescriptive path applies only up to the jurisdiction's wind-speed limit for the exposure.")],
        installerCallout: true,
        evidenceStatus: "verified",
        evidenceFound: statedEvidence(capItems, `Compared against the prescriptive limit${capFields.length > 1 ? "s" : ""} on file.`),
      });
    }
  }

  // (c) UNKNOWN — the jurisdiction's value is not on file. Never a blocker, never silent:
  // "no finding" here would read as "the criteria were checked", and they were not.
  if (opts.roofMounted) {
    const missing: string[] = [];
    if (ahjSnow == null) missing.push("ground snow load");
    if (ahjWind == null) missing.push("design wind speed");
    if (missing.length) {
      const say = (pick: (c: StatedDesignCriterion) => boolean, unit: string): string => {
        const hits = stated.criteria.filter(pick);
        // THREE ANSWERS, NOT TWO. "Not stated" is a claim about text we read; with no readable
        // package text it would read as reassurance about a package nobody looked at.
        if (!hits.length) return stated.documentTextRead ? "not stated in the package text we read" : "could not be read from the package (no readable plan text on file)";
        const byValue = new Map<string, { value: string | number; sources: Set<string> }>();
        for (const c of hits) {
          // Keep the qualifier visible: a Pg(asd) 20 or a Vasd 93 quoted bare would read as
          // a second, lower Pg / Vult.
          const tag = c.qualifier === "ground_asd" ? " Pg(asd)" : c.qualifier === "nominal" ? " (nominal/ASD)" : "";
          const key = `${c.value}${tag}`;
          const e = byValue.get(key) ?? { value: `${c.value}${unit}${tag}`, sources: new Set<string>() };
          e.sources.add(c.source);
          byValue.set(key, e);
        }
        return `stated in the package: ${describeValues([...byValue.values()], "")}`;
      };
      // A state minimum on file was compared (b2), but a minimum is not the site's value: say which
      // was checked, so "not checked" and "checked" are not both implied about one number.
      const minimum = groundSnowMinimumFor(ctx, opts.permitPath ?? "");
      const minimumNote = minimum ? ` (compared only with the ${minimum.required} psf minimum for ${opts.permitPath ? `${opts.permitPath === "prescriptive" ? "prescriptive" : "non-prescriptive"} design` : "the stricter path, the permit path being unknown"}, not with the site's own Pg)` : "";
      // The other criteria the plan STATES and the profile lacks ride along (issue #111): stated and
      // unchecked is said, but they never raise this callout on their own — residential plans print
      // "Risk Category II" almost everywhere, and the row rarely records it.
      const alsoUnchecked = (criterion: StatedDesignCriterionKind, ahjHas: boolean): boolean =>
        !ahjHas && stated.criteria.some((c) => c.criterion === criterion);
      const lines = [
        ahjSnow == null ? `ground snow — ${say((c) => c.criterion === "groundSnowPsf", " psf")}${minimumNote}` : "",
        ahjWind == null ? `wind speed — ${say((c) => c.criterion === "windSpeedMph", " mph")}` : "",
        alsoUnchecked("seismicDesignCategory", !!ahjSdc) ? `seismic design category — ${say((c) => c.criterion === "seismicDesignCategory", "")}` : "",
        alsoUnchecked("frostDepthIn", ahjFrost != null) ? `frost depth — ${say((c) => c.criterion === "frostDepthIn", " in")}` : "",
        alsoUnchecked("riskCategory", !!ahjRisk) ? `risk category — ${say((c) => c.criterion === "riskCategory", "")}` : "",
      ].filter(Boolean);
      const quoted = stated.criteria.filter((c) => (ahjSnow == null && c.criterion === "groundSnowPsf") || (ahjWind == null && c.criterion === "windSpeedMph")
        || (!ahjSdc && c.criterion === "seismicDesignCategory") || (ahjFrost == null && c.criterion === "frostDepthIn") || (!ahjRisk && c.criterion === "riskCategory"));
      // WHERE THE LOOKUP STANDS (ctx.designLookup, read from the job queue). The first project in a
      // new AHJ is judged while its lookup is still running: "not on file" read as "nobody is
      // looking", and a lookup that ran and found nothing read as one that never ran.
      const lookup = designLookupWording(ctx, who, missing, ahjSnow == null, ahjWind == null);
      out.push({
        id: "city.struct.design-criteria-unknown",
        severity: "callout",
        category: "structural",
        title: lookup?.title ?? "Jurisdiction design criteria not on file — stated values unchecked",
        message: `${lookup?.lead ?? `${who}'s ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not on file yet`}, so the package's stated values have NOT been checked against the jurisdiction's requirement: ${lines.join("; ")}.${lookup?.tail ?? ""}${approvedDesignsNote(ctx, [
          ...(ahjSnow == null ? ["groundSnowPsf" as const] : []),
          ...(ahjWind == null ? ["windSpeedMph" as const, "windExposure" as const] : []),
        ])}`,
        cityFeedback: `Confirm the design criteria ${who} requires (ground snow load, ultimate wind speed and exposure) and show them on the plan set and in any engineer's letter.`,
        designTeamAction: `Look up ${who}'s climatic/geographic design criteria (its Table R301.2 values or published design-criteria map) and confirm the stated values meet them before submittal; record them on the jurisdiction's code profile so the next project is checked automatically.`,
        evidenceNeeded: ["Jurisdiction's ground snow load", "Jurisdiction's ultimate design wind speed and exposure", ...lines].slice(0, 6),
        codeReferences: [ref(ctx, "Table R301.2", "Climatic and geographic design criteria (established by the jurisdiction)", "The jurisdiction sets these values; the profile on file does not record them yet.")],
        installerCallout: false,
        evidenceStatus: "weak",
        evidenceFound: statedEvidence(quoted, "Stated by the package; not compared — the jurisdiction's value is not on file."),
      });
    }
  }

  // (d) CODE BASIS — the plan's printed editions vs what the profile says is adopted. EVERY plan
  // set that prints a code basis gets an answer (issue #108): silence on a jurisdiction with no
  // editions on file read as "the code basis checked out".
  //   · no editions on file (model defaults, or a profile row that records none) -> a callout
  //     quoting the plan's claim next to the lookup state, like design-criteria-unknown. Never
  //     more: the defaults are placeholders, not the jurisdiction's adoption.
  //   · a mismatch against a SEEDED profile -> a warning (hard rule 3: research lands seeded,
  //     and a seeded row never blocks; either side may be the stale one).
  //   · a mismatch against a human-VERIFIED profile -> a blocker, unless the plan prints the
  //     state's UPCOMING edition, its status reads adopted/filed/effective, and its date is
  //     between 90 days ahead and 30 days past (a warning naming the date; #124).
  //   · a plan on the PREVIOUS edition inside a recorded phase-in (effective <= asOf < mandatory,
  //     previous edition on file) -> not a mismatch: a callout naming the mandatory date, on a
  //     verified or a seeded profile (#216). From the mandatory date on it blocks as above.
  //
  // LIKE WITH LIKE. A plan entry is compared with the profile entry of the SAME named code
  // (state code to state code: ORSC with ORSC). Base model codes are compared only when a base
  // is stated on BOTH sides — the plan's "(NEC 2020)" against the profile's own NEC entry or a
  // base its entry's title states ("based on the 2021 IRC"). A state code and a model code are
  // never compared by year: the 2022 Oregon Fire Code IS the right code for the 2021 IFC.
  const adopted = ctx.profile?.adoptedCodes?.length ? ctx.adoptedCodes : [];
  if (!adopted.length && stated.codeBasis.length) out.push(codeBasisUnverified(ctx, stated.codeBasis, who));
  if (adopted.length && stated.codeBasis.length) {
    const profileEntries = adopted.map(profileCodeEntry);
    const lines: string[] = [];
    // Lines whose plan edition is the state's upcoming edition, due within the window: these
    // never block, and say the date.
    const softened = new Set<string>();
    // Lines whose plan edition the profile itself still allows today (a phase-in, #216): these are
    // not mismatches yet, and say the mandatory date.
    const inGrace = new Set<string>();
    const seen = new Set<string>();
    const upcomingFor = upcomingWithin(ctx, opts.asOf, UPCOMING_SOFTEN_DAYS_BEFORE, UPCOMING_SOFTEN_DAYS_AFTER);
    const graceFor = graceWindowFor(ctx, opts.asOf);
    // `graceVia`: the state-code pair a BASE line belongs to. The profile records only the new
    // edition's base, so a plan's base on the previous state edition is in grace exactly when its
    // state-code pair is.
    const report = (key: string, line: string, compared: { code: string; edition: string }, graceVia?: { code: string; edition: string }): void => {
      if (seen.has(key)) return;
      seen.add(key);
      const due = upcomingFor(compared);
      const grace = due ? null : graceFor(compared) ?? (graceVia ? graceFor(graceVia) : null);
      const text = due
        ? `${line} — the plan's edition is the upcoming ${due.code} ${due.edition}, anticipated effective ${due.anticipatedDate}`
        : grace ? `${line} — still allowed during the phase-in: ${grace.note.replace(/\.$/, "")}` : line;
      if (due) softened.add(text);
      if (grace) inGrace.add(text);
      lines.push(text);
    };
    for (const b of stated.codeBasis) {
      const code = normCodeToken(b.code);
      const same = profileEntries.filter((a) => a.code === code);
      if (same.length && !same.some((a) => a.edition === b.edition)) {
        report(`${code}|${b.edition}`, `plan states ${b.code} ${b.edition} (${b.source}) — profile records ${same.map((a) => a.label).join(" / ")}`, b);
      }
      // The plan's printed base, compared with a base the profile states for that model code.
      if (b.baseCode && b.baseEdition) {
        const model = normCodeToken(b.baseCode);
        const own = baseModelCode(code);
        if (!own || own === model) {
          const recorded = [
            ...profileEntries.filter((a) => a.code === model).map((a) => ({ edition: a.edition, label: a.label })),
            ...profileEntries.filter((a) => a.base?.code === model).map((a) => ({ edition: a.base!.edition, label: `${a.label} (based on ${model} ${a.base!.edition})` })),
          ];
          if (recorded.length && !recorded.some((r) => r.edition === b.baseEdition)) {
            report(`${code}|${b.edition}|${model}|${b.baseEdition}`, `plan states ${b.code} ${b.edition} based on ${model} ${b.baseEdition} (${b.source}) — profile records ${recorded.map((r) => r.label).join(" / ")}`, { code: model, edition: b.baseEdition }, b);
          }
        }
      }
      // A plan naming the MODEL code where the profile names only the state code built on it:
      // compared only with a base the profile states ("ORSC 2023, based on the 2021 IRC").
      if (!same.length && MODEL_CODES.has(code)) {
        const via = profileEntries.filter((a) => a.base?.code === code);
        if (via.length && !via.some((a) => a.base!.edition === b.edition)) {
          report(`${code}|${b.edition}`, `plan states ${b.code} ${b.edition} (${b.source}) — profile records ${via.map((a) => `${a.label} (based on ${code} ${a.base!.edition})`).join(" / ")}`, b);
        }
      }
    }
    if (lines.length) {
      // A VERIFIED edition is the jurisdiction's code: a plan on another edition is not approvable
      // as drawn. Only a seeded row stays a warning, and only an upcoming edition softens it. A
      // plan wholly inside a recorded phase-in is no mismatch at all: a callout naming the date.
      // Softening only ever lowers severity (rule 3): one line outside both still blocks.
      const blocks = ctx.verified && lines.some((l) => !softened.has(l) && !inGrace.has(l));
      const graceOnly = inGrace.size === lines.length;
      out.push({
        id: "city.code.basis-mismatch",
        severity: blocks ? "blocker" : graceOnly ? "callout" : "warning",
        category: "plan_set",
        title: graceOnly
          ? "Plan's code basis is the previous edition — still allowed during the phase-in"
          : "Plan's code basis differs from the jurisdiction's adopted codes",
        message: `${lines.join("; ")}. Profile: ${provenance(ctx)}. ${blocks
          ? "The adopted editions are verified — the plan's governing-codes block must state them."
          : graceOnly
            ? "The jurisdiction still accepts the previous edition until the mandatory date — a submittal on or after that date must state the new edition."
            : softened.size === lines.length
              ? "The plan anticipates the upcoming edition — confirm which edition the jurisdiction will review under on the submittal date."
              : softened.size + inGrace.size === lines.length
                ? "The plan's editions are the upcoming edition or a previous one still allowed during a phase-in — confirm which edition the jurisdiction will review under on the submittal date."
                : "One side is out of date — confirm the currently adopted editions."}`,
        // AN UNVERIFIED PROFILE CANNOT TELL AN INSTALLER TO CHANGE THEIR PLAN. Venus TX (new-AHJ e2e,
        // 2026-09-26): a seeded state edition (NEC 2026) against a plan that correctly said 2020 —
        // and the installer was told to "update" it. Only a human-verified profile may ask for the
        // change; otherwise the ask is to confirm with the AHJ, and it is not an installer callout.
        cityFeedback: graceOnly
          ? `The plan's governing-codes block states the previous edition, which ${who} still accepts during its phase-in — submit before the mandatory date or update the block to the new edition.`
          : ctx.verified
          ? `Update the plan's governing-codes block to the code editions currently adopted by ${who}.`
          : `Confirm with ${who} which code editions are currently adopted before changing the plan's governing-codes block — the editions on file are unverified.`,
        designTeamAction: "Confirm the adopted editions with the jurisdiction; correct the plan's GOVERNING CODES block, or correct the jurisdiction's code profile if the plan is right.",
        evidenceNeeded: ["Governing-codes block on the cover sheet", ...lines].slice(0, 6),
        codeReferences: [...new Set(stated.codeBasis.map((b) => b.code))]
          .filter((code) => profileEntries.some((a) => a.code === normCodeToken(code)))
          .slice(0, 4)
          .map((code) => ctx.citationFor(code, "Adopted edition", `${code} as adopted by ${who}`)),
        installerCallout: ctx.verified && !graceOnly,
        evidenceStatus: "verified",
        evidenceFound: stated.codeBasis.slice(0, 12).map((b) => ({
          kind: "source_excerpt" as const,
          label: `${b.code} ${b.edition}${b.baseCode ? ` (${b.baseCode} ${b.baseEdition})` : ""}`,
          source: b.source,
          excerpt: b.excerpt,
          confidence: "high" as const,
          pageHint: "",
          screenshotPath: "",
          verifier: "rule_engine" as const,
          note: "Stated code basis.",
        })),
      });
    }
  }

  return out;
}
