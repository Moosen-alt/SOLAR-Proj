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
//
// Pure: no database. The jurisdiction arrives as an EffectiveCodeContext, the same way the
// rest of codeReviewRules receives it, so these rules work for any AHJ whose profile carries
// designCriteria — the fix is data (the profile), never a city-specific branch here.
// ---------------------------------------------------------------------------
import type {
  CodeReference,
  JurisdictionCriterionKey,
  ProjectRecord,
  ReviewerFinding,
  ReviewerFindingEvidence,
  StatedCodeBasisEntry,
  StatedDesignCriteria,
  StatedDesignCriterion,
  StatedDesignCriterionKind,
  StatedDesignCriterionQualifier,
} from "../../shared/src/types";
import type { EffectiveCodeContext } from "./codeProfiles";

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
const RATING_CONTEXT = /(?:\bup\s*to|\bmax(?:imum)?\.?|\bmin(?:imum)?\.?|\brated|\btested|\blimit(?:ed)?|\bexceed(?:s|ing)?|\bnot\s+more\s+than|\bless\s+than|\bgreater\s+than|≤|≥|<=|>=|<|>)[^0-9]{0,24}$|\bdesigned\s+(?:for|to)\s*(?:an?\s+)?$/i;

function windQualifier(label: string): StatedDesignCriterionQualifier {
  if (/\bv\s*[_(]?\s*asd\b|\bvasd\b|\ballowable\s+stress|\bnominal\b|\basd\b|\bservice(?:ability)?\b/i.test(label)) return "nominal";
  if (/\bv\s*[_(]?\s*ult\b|\bvult\b|\bultimate\b|\bstrength\b/i.test(label)) return "ultimate";
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
    const windAfter = post.match(/^\s*(?:\(?\s*3[\s-]*sec(?:ond)?\.?[\s-]*gust\s*\)?\s*)?,?\s*wind\b/i);
    const labelled = /wind|\bv\s*[_(]?\s*(?:ult|asd)\b|\bv(?:ult|asd)\b|\bv\s*[:=]\s*$|\bv\s*$/i.test(label)
      || !!windAfter
      // "Exposure B, 95 mph" — a speed stated inside an exposure clause is the wind speed.
      || /\bexp(?:osure)?\.?\s*(?:cat(?:egory)?\.?\s*)?[:=]?\s*[BCD]\s*,?\s*$/i.test(label);
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
      qualifier: windQualifier(`${label} ${(post.match(/^\s*\(?\s*(?:v\s*[_(]?\s*(?:ult|asd)\b|vult|vasd|ultimate|nominal|asd)\b/i) ?? [""])[0]}`),
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
}

// --- exposure / risk ------------------------------------------------------------

// A LIMIT CLAUSE governs the letter — a prescriptive checklist "Wind exposure for structure is
// limited to Exposure Category B or C", "Less than or equal to 120 mph in Exposure Category B".
// Numbers may sit between the limit word and the letter; a field separator (= : ; . •) may not.
const EXPOSURE_LIMIT_BEFORE = /(?:\bup\s*to|\bmax(?:imum)?\b|\bmin(?:imum)?\b|\brat(?:ed|ing)\b|\btested\b|\blimit(?:ed|s)?\b|\bexceed(?:s|ing)?\b|\bnot\s+more\s+than|\bless\s+than|\bgreater\s+than|\bor\s+less\b|\bdesigned\s+(?:for|to)\b|≤|≥|<=|>=)[^.;:=•]{0,45}$/i;
// A LIST or RANGE of letters is not a stated category: "B or C", "C/D", "B, C and D", "B-D".
const EXPOSURE_LIST_AFTER = /^\s*(?:,|\/|&|\bor\b|\band\b|\bto\b|\bthrough\b|[-–])\s*(?:exp(?:osure|\.)?\s*(?:cat(?:egory|\.)?\s*)?)?[BCD](?![A-Za-z0-9])/i;
// "EXPOSURE B RATING", "Exposure C rated" — a product rating, not the site's category.
const EXPOSURE_RATING_AFTER = /^\s*(?:rat(?:ed|ing)|tested|max(?:imum)?\b|or\s+less\b|limit)/i;
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
      if (!/[:=]/.test(m[0]) && EXPOSURE_LIMIT_BEFORE.test(text.slice(Math.max(0, at - 60), at))) continue;
      const after = text.slice(end, end + 30);
      if (EXPOSURE_LIST_AFTER.test(after) || EXPOSURE_RATING_AFTER.test(after)) continue;
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
    out.push({ criterion: "riskCategory", value: normRisk(r[1]), qualifier: "unspecified", source, derived: false, excerpt: excerptAt(text, r.index, r.index + r[0].length) });
  }
  const asce = /\bASCE(?:\/SEI)?\s*7\s*[-–]\s*(\d{2})\b/gi;
  let a: RegExpExecArray | null;
  while ((a = asce.exec(text))) {
    out.push({ criterion: "asce7Edition", value: `7-${a[1]}`, qualifier: "unspecified", source, derived: false, excerpt: excerptAt(text, a.index, a.index + a[0].length) });
  }
}

// --- snow ------------------------------------------------------------------

function extractSnow(text: string, source: string, out: StatedDesignCriterion[]): void {
  const push = (criterion: StatedDesignCriterionKind, qualifier: StatedDesignCriterionQualifier, raw: string, m: RegExpExecArray): void => {
    const value = toNumber(raw);
    if (value == null || value > 400) return;
    out.push({ criterion, value, qualifier, source, derived: false, excerpt: excerptAt(text, m.index, m.index + m[0].length) });
  };
  const asd = (s: string | undefined): boolean => !!s && /asd/i.test(s);
  let m: RegExpExecArray | null;

  // GROUND SNOW, label first. A unit is required unless the label is followed by = or :,
  // so a numbered note ("3. GROUND SNOW LOAD …") can never lend its item number. A
  // parenthetical may sit between label and value ("GROUND SNOW LOAD (Pg) = 25 PSF",
  // "(ASCE 7-16 FIG 7.2-1)"), and prose connects with "of"/"is" ("ground snow load of 36 psf").
  const groundLabel = /\bground\s+snow(?:\s+loads?)?(?:\s*,?\s*p\s?g\b)?(?:\s*\((?![^)]*\basd\b)[^()]{0,40}\))?\s*(\(\s*asd\s*\)|,?\s*asd\b)?\s*(?:(of|is|[:=])\s*)?(\d+(?:\.\d+)?)\s*(psf|lbs?\/?(?:sq\.?\s*ft|ft2|ft²))?/gi;
  while ((m = groundLabel.exec(text))) {
    if (!(m[2] && /[:=]/.test(m[2])) && !m[4]) continue;
    push("groundSnowPsf", asd(m[1]) ? "ground_asd" : "ground", m[3], m);
  }
  // "SNOW LOAD (GROUND): 25 PSF" — the qualifier printed after the label.
  const groundParen = /\bsnow\s+loads?\s*\(\s*ground\s*\)\s*(?:([:=])\s*)?(\d+(?:\.\d+)?)\s*(psf)?/gi;
  while ((m = groundParen.exec(text))) {
    if (!m[1] && !m[3]) continue;
    push("groundSnowPsf", "ground", m[2], m);
  }
  // Pg symbol: "pg 28.00 psf", "p g = 28.00" (a PDF split the symbol), "Pg(asd) 20 psf".
  // "pg 5" is a page reference — the symbol needs = or a psf unit to count.
  const pgSymbol = /\bp\s?g\b\s*(\(\s*asd\s*\)|,\s*asd\b|\s+asd\b)?\s*(?:([:=])\s*)?(\d+(?:\.\d+)?)\s*(psf)?/gi;
  while ((m = pgSymbol.exec(text))) {
    if (!m[2] && !m[4]) continue;
    push("groundSnowPsf", asd(m[1]) ? "ground_asd" : "ground", m[3], m);
  }
  // Value first: "ground snow 28 psf" is caught above; "28 psf ground snow" here.
  const groundAfter = /(\d+(?:\.\d+)?)\s*psf\s*(\(\s*asd\s*\)\s*)?ground\s+snow/gi;
  while ((m = groundAfter.exec(text))) push("groundSnowPsf", asd(m[2]) ? "ground_asd" : "ground", m[1], m);

  // ROOF SNOW — a different quantity (Pf/Ps = f(Pg, Ce, Ct, Is, Cs)); never compared to Pg.
  const roofQual = (word: string | undefined): StatedDesignCriterionQualifier =>
    !word ? "roof" : /flat/i.test(word) ? "flat" : /sloped|total/i.test(word) ? "sloped" : "roof";
  const roofLabel = /\b(flat|sloped|total|design|balanced)?\s*roof\s+snow(?:\s+load)?(?:\s*,?\s*p\s?[fs]\b)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*psf/gi;
  while ((m = roofLabel.exec(text))) push("roofSnowPsf", roofQual(m[1]), m[2], m);
  const roofAfter = /(\d+(?:\.\d+)?)\s*psf\s*(flat|sloped|total|design)?\s*roof\s+snow/gi;
  while ((m = roofAfter.exec(text))) push("roofSnowPsf", roofQual(m[2]), m[1], m);
  const pf = /\bp\s?f\s*=\s*(\d+(?:\.\d+)?)\s*psf/gi;
  while ((m = pf.exec(text))) push("roofSnowPsf", "flat", m[1], m);
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
const CODE_BASIS_HEADER = /\b(governing\s+codes?|applicable\s+codes?|code\s+basis|design\s+codes?|codes?\s+and\s+standards|references\s+and\s+codes|building\s+codes?\s+used|codes?\s+used)\b\s*[:\-–]?|\bcodes\s*:/gi;
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
  const suffixed = c.match(/^([A-Z]{2,6})-([A-Z]{2})$/);
  if (suffixed && US_STATES.has(suffixed[2])) return suffixed[1];
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
const NAMED_CODE = /\b((?:19|20)\d{2})\s+((?:[A-Z][A-Za-z.'-]*\s+){0,6}?(?:CODE|Code))\b(?:\s*\(\s*([^)]{1,40}?)\s*\))?/g;
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
    const base = parenBase(paren);
    const code = namedCode(name, base ? "" : paren, volume ?? part.slice(end, end + 20));
    // "NEC: 2020 PER CODE: NEC 690.54" (a placard citation) is not a code named "PC": a
    // printed code name never opens with a preposition, and needs two initials besides CODE.
    if (NAME_STOPWORDS.has(name.split(" ")[0]) || code.length < 2) return;
    if (items.some((i) => at < i.end && end > i.at)) return;
    items.push({ at, end, entry: { code, edition, name, ...(base ?? {}) } });
  };
  let m: RegExpExecArray | null;
  const yearFirst = new RegExp(NAMED_CODE.source, "g");
  while ((m = yearFirst.exec(part))) push(m.index, m.index + m[0].length, m[2], m[1], m[3]);
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
  return extractFromSources(project, readSources(project, extraTexts));
}

function extractFromSources(project: ProjectRecord, sources: ReadSource[]): StatedDesignCriteria {
  const criteria: StatedDesignCriterion[] = [];
  const codeBasis: StatedCodeBasisEntry[] = [];
  extractParsedFields(project, criteria);
  for (const source of sources) {
    const found: StatedDesignCriterion[] = [];
    extractWind(source.text, source.label, found);
    extractExposureAndRisk(source.text, source.label, found);
    extractSnow(source.text, source.label, found);
    criteria.push(...found.map((c) => ({ ...c, derived: source.derived })));
    // The code basis is read from the package's own sheets only; a narrative summary
    // paraphrasing "2021 IRC" is not the plan's GOVERNING CODES block.
    if (source.sheet) {
      extractCodeBasis(source.text, source.label, codeBasis);
    }
  }
  const seenBasis = new Set<string>();
  return {
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
const REQUIREMENT_CUE = /\b(?:minimum|min\.|must\s+(?:not\s+)?be|shall\s+(?:not\s+)?be|should\s+be|needs?\s+to\s+be|is\s+required|are\s+required|required|requires?|provide|(?:shall|must|may)\s+not\s+exceed|not\s+to\s+exceed)\b/i;
/** The site's fact, stated: "Testcoast City is located in a special wind region". */
const SPECIAL_WIND_STATEMENT = /\b(?:is|are|lies|sits)\s+(?:located\s+|situated\s+)?(?:with)?in\s+(?:an?\s+|the\s+)?special\s+wind\s+(?:region|zone)\b/i;
/** A cue that FOLLOWS its value: "Exposure C is required", "36 psf ground snow is the minimum". */
const TRAILING_REQUIREMENT = /\b(?:is|are)\s+(?:required|the\s+minimum)\b\W*$/i;
/** Imperatives that open a clause: "Use Vult = 130 mph", "Show ground snow 36 psf", "Design for ...". */
const IMPERATIVE_START = /^\s*(?:please\s+)?(?:use|show|design\s+(?:for|to)|revise\s+(?:to|for)|update\s+to|submit|provide)\b/i;
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
}

function ahjSentences(text: string): AhjSentence[] {
  const raw = String(text || "")
    .replace(/\r/g, "")
    // A new sentence starts after . ; ! ? + space when the next token opens a clause; a code
    // section ("R324.4.1") has no space after its dots, so it is never split.
    .split(/\n+|(?<=[.;!?])\s+(?=[-–•*]?\s*[A-Z0-9(])/);
  const out: AhjSentence[] = [];
  let prevEndsColon = false;
  for (const piece of raw) {
    const flatPiece = flat(piece);
    if (!flatPiece) continue;
    const bullet = /^[-–•*]\s*/.test(flatPiece) || prevEndsColon;
    out.push({ text: flatPiece.replace(/^[-–•*]\s*/, ""), bullet });
    prevEndsColon = /:\s*$/.test(flatPiece);
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

/**
 * Every design requirement a correction's text STATES, deterministically (no LLM). Unit- and
 * label-anchored: a number is a ground snow load only when LABELLED ground snow / Pg and
 * carrying psf; a wind speed only with mph and a wind label; attachment spacing only with an
 * attachment label and an o.c. spacing, never a framing member's. A criterion stated with two
 * different values in one correction is ambiguous and yields nothing — a human reads it.
 */
export function extractAhjRequiredCriteria(text: string): AhjRequiredCriterion[] {
  const found: AhjRequiredCriterion[] = [];
  const add = (criterion: JurisdictionCriterionKey, value: number | string | boolean, sentence: string): void => {
    const block = criterion === "maxAttachmentSpacingIn" || criterion === "listingEvidenceRequired" ? "prescriptive" : "designCriteria";
    found.push({ criterion, block, value, basis: basisOf(sentence) });
  };
  // A bullet inherits the requirement cue of the header it hangs under, for as long as the
  // bullets run ("Provide updated design criteria ... -Ground snow load 36 psf.").
  let headerCue = false;
  for (const { text: sentence, bullet } of ahjSentences(text)) {
    const inherited = bullet && headerCue;
    let sentenceHasCue = false;
    ahjClauses(sentence).forEach((clause, clauseIndex) => {
      if (REJECTION_CUE.test(clause) || CONDITIONAL_START.test(clause) || PACKAGE_PREFIX.test(clause)) return;
      // "X is located in a special wind region" states the site's fact: its own cue. "Exposure C is
      // required" puts the value BEFORE its cue, so the whole (clean) clause is the requirement.
      const own = IMPERATIVE_START.test(clause) || TRAILING_REQUIREMENT.test(clause) ? 0
        : SPECIAL_WIND_STATEMENT.test(clause) ? clause.search(SPECIAL_WIND_STATEMENT)
          : clause.search(REQUIREMENT_CUE);
      if (own >= 0) sentenceHasCue = true;
      const quote = clause.search(QUOTATION_CUE);
      // "The calculations show the minimum ... 25 psf" — the requirement is inside the quote.
      if (quote >= 0 && (own < 0 || quote < own)) return;
      const bare = own < 0 && BARE_LABEL_START.test(clause) && clause.split(/\s+/).length <= BARE_MAX_WORDS;
      const inheritsHere = inherited && clauseIndex === 0;
      if (own < 0 && !inheritsHere && !bare) return;
      const from = own < 0 ? 0 : own;
      // A quotation AFTER the cue ends the requirement: "minimum is 36 psf, the plans show 16 psf".
      const q = clause.slice(from).search(QUOTATION_CUE);
      const to = q < 0 ? clause.length : from + q;
      extractClause(clause, from, to, (criterion, value) => add(criterion, value, sentence));
    });
    if (!bullet) headerCue = sentenceHasCue;
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
  if (LISTING_WORD.test(clause) && LISTING_SUBJECT.test(clause)) add("listingEvidenceRequired", true);
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
  return criterion === "windSpeedMph" ? " mph" : criterion === "groundSnowPsf" || criterion === "roofSnowPsf" ? " psf" : "";
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

function residentialFamily(ctx: EffectiveCodeContext): string {
  return ctx.adoptedCodes.some((c) => /^ORSC$/i.test(c.code)) ? "ORSC" : "IRC";
}

const IRC_FALLBACK_URL = "https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning";

function ref(ctx: EffectiveCodeContext, section: string, title: string, note: string): CodeReference {
  const family = residentialFamily(ctx);
  return ctx.citationFor(family, section, title, {
    code: family,
    section,
    title,
    adoptionScope: "One- and two-family residential; verify the locally adopted edition.",
    sourceUrl: IRC_FALLBACK_URL,
    note,
  });
}

/** A residential-code citation (ORSC where adopted, else IRC) at the jurisdiction's edition. */
export function residentialCodeRef(ctx: EffectiveCodeContext, section: string, title: string, note: string): CodeReference {
  return ref(ctx, section, title, note);
}

function describeValues(entries: Array<{ value: string | number; sources: Set<string> }>, unit: string): string {
  return entries.map((e) => `${e.value}${unit} in ${[...e.sources].join(", ")}`).join("; ");
}

export function evaluateDesignCriteriaFindings(
  project: ProjectRecord,
  ctx: EffectiveCodeContext,
  opts: { roofMounted: boolean; extraTexts?: DesignTextSource[] },
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
      if (!c.derived) e.docSources.add(c.source);
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
  const collect = (label: string, unit: string, required: string, pick: (c: StatedDesignCriterion) => boolean): void => {
    const hits = stated.criteria.filter(pick);
    if (!hits.length) return;
    below.push(...hits);
    const byValue = new Map<string, { value: string | number; sources: Set<string> }>();
    for (const c of hits) {
      const e = byValue.get(String(c.value)) ?? { value: c.value, sources: new Set<string>() };
      e.sources.add(c.source);
      byValue.set(String(c.value), e);
    }
    belowLines.push(`${label}: stated ${describeValues([...byValue.values()], unit)} — ${who} requires ${required}`);
  };
  if (ahjWind != null) {
    collect("Wind speed", " mph", `${ahjWind} mph (ultimate)`, (c) => c.criterion === "windSpeedMph" && c.qualifier !== "nominal" && typeof c.value === "number" && c.value < ahjWind);
  }
  if (ahjExposure) {
    collect("Wind exposure", "", `Exposure ${ahjExposure}`, (c) => c.criterion === "windExposure" && (EXPOSURE_RANK[String(c.value)] ?? 99) < EXPOSURE_RANK[ahjExposure]);
  }
  if (ahjSnow != null) {
    collect("Ground snow load", " psf", `${ahjSnow} psf`, (c) => c.criterion === "groundSnowPsf" && c.qualifier === "ground" && typeof c.value === "number" && c.value < ahjSnow);
  }
  if (belowLines.length) {
    out.push({
      id: "city.struct.design-criteria-below-ahj",
      severity: ctx.verified ? "blocker" : "warning",
      category: "structural",
      title: "Design criteria below the jurisdiction's requirement",
      message: `${belowLines.join(". ")}. AHJ value from the ${provenance(ctx)}.${approvedDesignsNote(ctx, [
        ...(ahjWind != null ? ["windSpeedMph" as const] : []),
        ...(ahjExposure ? ["windExposure" as const] : []),
        ...(ahjSnow != null ? ["groundSnowPsf" as const] : []),
      ])}`,
      cityFeedback: `Provide updated design criteria on the plan set and in the engineer's letter/calculations. ${who} design criteria: ${[ahjWind != null ? `wind ${ahjWind} mph ultimate` : "", ahjExposure ? `Exposure ${ahjExposure}` : "", ahjSnow != null ? `ground snow ${ahjSnow} psf` : ""].filter(Boolean).join(", ")}. Revise attachment spacing and member checks to the corrected loads.`,
      designTeamAction: "Re-run the structural design (attachment spacing, member capacity, uplift) at the jurisdiction's criteria and reissue the plan-set structural notes and the engineer's letter with the corrected values.",
      evidenceNeeded: ["Plan-set design criteria matching the jurisdiction", "Engineer's letter/calculation at the jurisdiction's criteria", "Attachment spacing revised to the corrected loads", ...belowLines].slice(0, 8),
      codeReferences: [ref(ctx, "Table R301.2", "Climatic and geographic design criteria (established by the jurisdiction)", "The jurisdiction sets wind speed, exposure and ground snow load; a design below them is not approvable."), ref(ctx, "R301.2.1", "Wind design criteria", "Compare ultimate design wind speed (Vult) to the jurisdiction's value."), ref(ctx, "R301.2.3", "Snow loads", "Ground snow load Pg per the jurisdiction's criteria.")],
      installerCallout: true,
      evidenceStatus: "verified",
      evidenceFound: statedEvidence(below, `Compared against ${provenance(ctx)}.`),
    });
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
      const lines = [
        ahjSnow == null ? `ground snow — ${say((c) => c.criterion === "groundSnowPsf", " psf")}` : "",
        ahjWind == null ? `wind speed — ${say((c) => c.criterion === "windSpeedMph", " mph")}` : "",
      ].filter(Boolean);
      const quoted = stated.criteria.filter((c) => (ahjSnow == null && c.criterion === "groundSnowPsf") || (ahjWind == null && c.criterion === "windSpeedMph"));
      out.push({
        id: "city.struct.design-criteria-unknown",
        severity: "callout",
        category: "structural",
        title: "Jurisdiction design criteria not on file — stated values unchecked",
        message: `${who}'s ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not on file yet, so the package's stated values have NOT been checked against the jurisdiction's requirement: ${lines.join("; ")}.${approvedDesignsNote(ctx, [
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

  // (d) CODE BASIS — the plan's printed editions vs what the profile says is adopted. A
  // warning at most: most profiles are seeded, and either side may be the stale one.
  //
  // LIKE WITH LIKE. A plan entry is compared with the profile entry of the SAME named code
  // (state code to state code: ORSC with ORSC). Base model codes are compared only when a base
  // is stated on BOTH sides — the plan's "(NEC 2020)" against the profile's own NEC entry or a
  // base its entry's title states ("based on the 2021 IRC"). A state code and a model code are
  // never compared by year: the 2022 Oregon Fire Code IS the right code for the 2021 IFC.
  const adopted = ctx.profile?.adoptedCodes?.length ? ctx.adoptedCodes : [];
  if (adopted.length && stated.codeBasis.length) {
    const profileEntries = adopted.map((a) => {
      const code = normCodeToken(a.code);
      const said = `${a.title ?? ""} ${a.notes ?? ""}`;
      const m = said.match(/\bbased\s+on\s+(?:the\s+)?((?:19|20)\d{2})\s+([A-Z]{2,6})\b/i)
        ?? said.match(/\(\s*([A-Z]{2,6})\s*[-:]?\s*((?:19|20)\d{2})\s*\)/);
      let base: { code: string; edition: string } | null = null;
      if (m) {
        const [bc, be] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
        // Only a base consistent with the map is a base ("(OSSC)" in a title is not one).
        if (baseModelCode(code) === normCodeToken(bc) && !MODEL_CODES.has(code)) base = { code: normCodeToken(bc), edition: be };
      }
      return { code, edition: String(a.edition).trim(), label: `${a.code} ${a.edition}`, base };
    });
    const lines: string[] = [];
    const seen = new Set<string>();
    const report = (key: string, line: string): void => {
      if (seen.has(key)) return;
      seen.add(key);
      lines.push(line);
    };
    for (const b of stated.codeBasis) {
      const code = normCodeToken(b.code);
      const same = profileEntries.filter((a) => a.code === code);
      if (same.length && !same.some((a) => a.edition === b.edition)) {
        report(`${code}|${b.edition}`, `plan states ${b.code} ${b.edition} (${b.source}) — profile records ${same.map((a) => a.label).join(" / ")}`);
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
            report(`${code}|${b.edition}|${model}|${b.baseEdition}`, `plan states ${b.code} ${b.edition} based on ${model} ${b.baseEdition} (${b.source}) — profile records ${recorded.map((r) => r.label).join(" / ")}`);
          }
        }
      }
      // A plan naming the MODEL code where the profile names only the state code built on it:
      // compared only with a base the profile states ("ORSC 2023, based on the 2021 IRC").
      if (!same.length && MODEL_CODES.has(code)) {
        const via = profileEntries.filter((a) => a.base?.code === code);
        if (via.length && !via.some((a) => a.base!.edition === b.edition)) {
          report(`${code}|${b.edition}`, `plan states ${b.code} ${b.edition} (${b.source}) — profile records ${via.map((a) => `${a.label} (based on ${code} ${a.base!.edition})`).join(" / ")}`);
        }
      }
    }
    if (lines.length) {
      out.push({
        id: "city.code.basis-mismatch",
        severity: "warning",
        category: "plan_set",
        title: "Plan's code basis differs from the jurisdiction's adopted codes",
        message: `${lines.join("; ")}. Profile: ${provenance(ctx)}. One side is out of date — confirm the currently adopted editions.`,
        cityFeedback: `Update the plan's governing-codes block to the code editions currently adopted by ${who}.`,
        designTeamAction: "Confirm the adopted editions with the jurisdiction; correct the plan's GOVERNING CODES block, or correct the jurisdiction's code profile if the plan is right.",
        evidenceNeeded: ["Governing-codes block on the cover sheet", ...lines].slice(0, 6),
        codeReferences: [...new Set(stated.codeBasis.map((b) => b.code))]
          .filter((code) => profileEntries.some((a) => a.code === normCodeToken(code)))
          .slice(0, 4)
          .map((code) => ctx.citationFor(code, "Adopted edition", `${code} as adopted by ${who}`)),
        installerCallout: true,
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
