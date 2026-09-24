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
// sheet "tested to 160 mph", a prescriptive checklist "wind ≤ 110 mph".
const RATING_CONTEXT = /(?:\bup\s*to|\bmax(?:imum)?\.?|\bmin(?:imum)?\.?|\brated|\btested|\blimit(?:ed)?|\bexceed(?:s|ing)?|\bnot\s+more\s+than|\bless\s+than|\bgreater\s+than|≤|≥|<=|>=|<|>)[^0-9]{0,24}$/i;

function windQualifier(label: string): StatedDesignCriterionQualifier {
  if (/\bv\s*[_(]?\s*asd\b|\bvasd\b|\ballowable\s+stress|\bnominal\b|\basd\b|\bservice(?:ability)?\b/i.test(label)) return "nominal";
  if (/\bv\s*[_(]?\s*ult\b|\bvult\b|\bultimate\b|\bstrength\b/i.test(label)) return "ultimate";
  return "unspecified";
}

function extractWind(text: string, source: string, out: StatedDesignCriterion[]): void {
  const re = /(\d{2,3}(?:\.\d+)?)\s*mph\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    const pre = text.slice(Math.max(0, start - 70), start);
    // The LOCAL label is the text since the previous number: "…Vasd qz = 8.34 psf Basic
    // wind pressure V= 95 mph" must read "Basic wind pressure V=", not the Vasd two
    // numbers back — otherwise an ultimate speed is filed as a nominal one.
    const lastDigit = pre.search(/\d[^\d]*$/);
    const label = lastDigit >= 0 ? pre.slice(lastDigit + 1) : pre;
    const post = text.slice(end, end + 30);
    if (RATING_CONTEXT.test(pre.slice(-30))) continue;
    const labelled = /wind|\bv\s*[_(]?\s*(?:ult|asd)\b|\bv(?:ult|asd)\b|\bv\s*[:=]\s*$|\bv\s*$/i.test(label)
      || /^\s*(?:\(?\s*3[\s-]*sec(?:ond)?\.?[\s-]*gust\s*\)?\s*)?,?\s*wind\b/i.test(post)
      // "Exposure B, 95 mph" — a speed stated inside an exposure clause is the wind speed.
      || /\bexp(?:osure)?\.?\s*(?:cat(?:egory)?\.?\s*)?[:=]?\s*[BCD]\s*,?\s*$/i.test(label);
    if (!labelled) continue;
    const value = toNumber(m[1]);
    if (value == null || value < 60 || value > 250) continue;
    out.push({
      criterion: "windSpeedMph",
      value,
      // A qualifier AFTER the value only when it is attached to it ("120 mph (Vult)") — the
      // next note's "Vasd qz = …" must not reach back and relabel this speed.
      qualifier: windQualifier(`${label} ${(post.match(/^\s*\(?\s*(?:v\s*[_(]?\s*(?:ult|asd)\b|vult|vasd|ultimate|nominal|asd)\b/i) ?? [""])[0]}`),
      source,
      derived: false,
      excerpt: excerptAt(text, start - label.length, end),
    });
    // "WIND SPEED AND EXPOSURE: 110 MPH, C" — the exposure rides after the speed.
    if (/exposure/i.test(label)) {
      const expAfter = post.match(/^\s*,?\s*(?:exp(?:osure)?\.?\s*)?([BCD])(?![A-Za-z0-9])/i);
      if (expAfter) {
        out.push({
          criterion: "windExposure",
          value: expAfter[1].toUpperCase(),
          qualifier: "unspecified",
          source,
          derived: false,
          excerpt: excerptAt(text, start - label.length, end + expAfter[0].length),
        });
      }
    }
  }
}

function extractExposureAndRisk(text: string, source: string, out: StatedDesignCriterion[]): void {
  const exposurePatterns: RegExp[] = [
    // "EXPOSURE CATEGORY = C", "Exposure B", "EXPOSURE: D". The lookahead refuses "Exposure
    // Factor", "EXPOSURE AND WET LOCATIONS", "Exposure category Ce" (snow Ce, not Exp. C)
    // and "Exposure Category (ASCE 7-22 Table …)" (a heading with no value).
    /\bexposure(?:\s+cat(?:egory|\.)?)?\s*[:=-]?\s*([BCD])(?![A-Za-z0-9])/gi,
    /\bexp\.\s*(?:cat(?:egory|\.)?\s*)?[:=]?\s*([BCD])(?![A-Za-z0-9])/gi,
  ];
  for (const re of exposurePatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({ criterion: "windExposure", value: m[1].toUpperCase(), qualifier: "unspecified", source, derived: false, excerpt: excerptAt(text, m.index, m.index + m[0].length) });
    }
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
  // so a numbered note ("3. GROUND SNOW LOAD …") can never lend its item number.
  const groundLabel = /\bground\s+snow(?:\s+load)?(?:\s*,?\s*p\s?g)?\s*(\(\s*asd\s*\)|,?\s*asd)?\s*(?:([:=])\s*)?(\d+(?:\.\d+)?)\s*(psf|lbs?\/?(?:sq\.?\s*ft|ft2|ft²))?/gi;
  while ((m = groundLabel.exec(text))) {
    if (!m[2] && !m[4]) continue;
    push("groundSnowPsf", asd(m[1]) ? "ground_asd" : "ground", m[3], m);
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

const CODE_BASIS_HEADER = /\b(governing\s+codes?|applicable\s+codes?|code\s+basis|design\s+codes?|codes?\s+and\s+standards|references\s+and\s+codes|building\s+codes?\s+used|codes?\s+used)\b\s*[:\-–]?/gi;
const NAME_STOPWORDS = new Set(["OF", "THE", "AND", "FOR", "&", "PER", "BY", "IN", "TO", "WITH", "AS", "ON", "AT", "SEE"]);
/** An abbreviation reads as a CODE only when it ends in C (NEC, IRC, OESC, IECC …);
 *  "OREGON", "ASCE", "NDS" and every other capitalised word do not. */
const CODE_ABBR = /^[A-Z]{1,5}C$/;

function acronym(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ""))
    .filter((w) => w && !NAME_STOPWORDS.has(w.toUpperCase()))
    .map((w) => w[0].toUpperCase())
    .join("");
}

type BasisItem = { at: number; end: number; entry: Omit<StatedCodeBasisEntry, "source" | "excerpt"> };

// "2023 OREGON ELECTRICAL SPECIALTY CODE (NEC 2020)", "2022 OREGON STRUCTURAL SPECIALTY CODE
// (OSSC)", "2021 International Residential Code". Case-sensitive on the capitals: every word
// of a code's printed name is capitalised, and "in 2021 the electrical code was…" is prose.
const NAMED_CODE = /\b((?:19|20)\d{2})\s+((?:[A-Z][A-Za-z.'-]*\s+){0,6}?(?:CODE|Code))\b(?:\s*\(\s*([^)]{1,40}?)\s*\))?/g;

function namedItems(part: string): BasisItem[] {
  const items: BasisItem[] = [];
  const re = new RegExp(NAMED_CODE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(part))) {
    const name = m[2].replace(/\s+/g, " ").trim().toUpperCase();
    const paren = (m[3] || "").trim();
    const parenBase = paren.match(/^([A-Z]{2,6})\s*[-:]?\s*((?:19|20)\d{2})$/);
    const parenAbbr = !parenBase && /^[A-Z]{2,6}$/.test(paren) ? paren : "";
    const code = parenAbbr || acronym(name);
    // "NEC: 2020 PER CODE: NEC 690.54" (a placard citation) is not a code named "PC": a
    // printed code name never opens with a preposition, and needs two initials besides CODE.
    if (NAME_STOPWORDS.has(name.split(" ")[0]) || code.length < 2) continue;
    items.push({ at: m.index, end: m.index + m[0].length, entry: { code, edition: m[1], name, ...(parenBase ? { baseCode: parenBase[1], baseEdition: parenBase[2] } : {}) } });
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
    const taken: Array<[number, number]> = items.map((i) => [i.at, i.end]);
    const free = (a: number, b: number): boolean => !taken.some(([x, y]) => a < y && b > x);
    let m: RegExpExecArray | null;
    // Case-sensitive: codes are printed as capitals, and a lower-case word is never one.
    const abbrPatterns: Array<[RegExp, number, number]> = [
      [/\b((?:19|20)\d{2})\s+([A-Z]{2,6})\b/g, 2, 1],
      [/\b([A-Z]{2,6})\s*[-:]?\s*((?:19|20)\d{2})\b/g, 1, 2],
    ];
    for (const [re, codeIdx, yearIdx] of abbrPatterns) {
      while ((m = re.exec(block))) {
        const code = m[codeIdx];
        if (!CODE_ABBR.test(code) || !free(m.index, m.index + m[0].length)) continue;
        let end = m.index + m[0].length;
        const base = block.slice(end).match(/^\s*\(\s*([A-Z]{2,6})\s*[-:]?\s*((?:19|20)\d{2})\s*\)/);
        if (base) end += base[0].length;
        items.push({ at: m.index, end, entry: { code, edition: m[yearIdx], ...(base ? { baseCode: base[1], baseEdition: base[2] } : {}) } });
        taken.push([m.index, end]);
      }
    }
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

const REQUIREMENT_CUE = /\b(?:minimum|min\.|must\s+be|shall\s+be|should\s+be|needs?\s+to\s+be|is\s+required|are\s+required|required|requires?)\b/i;
// Third-person / past forms only: "the calculations show(s)/use(d)" describes the package, while
// the imperative "Use Vult = 130 mph" / "Show ground snow 36 psf" is the requirement.
const QUOTATION_CUE = /\b(?:shows|shown|showing|states|stated|indicates|indicated|lists|listed|uses|used|currently|(?:plans?|calc\w*|letter|drawings?|sheets?)\s+(?:show|state|use|indicate|list))\b/i;
const ATTACHMENT_LABEL = /\b(?:mount(?:s|ing)?|attachments?|anchors?|anchorage|stand-?offs?|lags?|lag\s+screws?|roof\s+hooks?|hooks?|brackets?|clamps?|l-?feet|l-?foot)\b/gi;
const FRAMING_WORD = /\b(?:rafters?|truss(?:es)?|joists?|purlins?|studs?|framing|members?|sheathing)\b/i;

function ahjSentences(text: string): string[] {
  return String(text || "")
    .replace(/\r/g, "")
    // A new sentence starts after . ; ! ? + space when the next token opens a clause; a code
    // section ("R324.4.1") has no space after its dots, so it is never split.
    .split(/\n+|(?<=[.;!?])\s+(?=[-–•*]?\s*[A-Z0-9(])/)
    .map((s) => flat(s).replace(/^[-–•*]\s*/, ""))
    .filter(Boolean);
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
    found.push({ criterion, block: criterion === "maxAttachmentSpacingIn" ? "prescriptive" : "designCriteria", value, basis: basisOf(sentence) });
  };
  for (const sentence of ahjSentences(text)) {
    const cue = sentence.search(REQUIREMENT_CUE);
    // A sentence that quotes the package with no requirement in it states what was REJECTED.
    if (cue < 0 && QUOTATION_CUE.test(sentence)) continue;
    const from = cue < 0 ? 0 : cue;
    let m: RegExpExecArray | null;

    // Special wind region — a yes, unless negated.
    if (/\bspecial\s+wind\s+(?:region|zone)\b/i.test(sentence) && !/\bnot\b[^.]{0,40}\bspecial\s+wind/i.test(sentence)) {
      add("specialWindRegion", true, sentence);
    }

    // Ground snow load Pg (never Pg(asd), never roof snow).
    const ground = /\bground\s+snow(?:\s+loads?)?(?:\s*\(?\s*p\s?g\s*\)?)?\s*(\(\s*asd\s*\)|,?\s*asd\b)?[^0-9$]{0,30}?(\d+(?:\.\d+)?)\s*(?:psf\b|pounds?\s+per\s+square\s+f(?:oo|ee)t|lbs?\s*\/\s*(?:sq\.?\s*ft|ft2|ft²))/gi;
    while ((m = ground.exec(sentence))) {
      if (m[1] || m.index + m[0].length <= from) continue;
      const v = toNumber(m[2]);
      if (v != null && v > 0 && v <= 400) add("groundSnowLoadPsf", v, sentence);
    }
    const groundAfter = /(\d+(?:\.\d+)?)\s*psf\s+ground\s+snow\b/gi;
    while ((m = groundAfter.exec(sentence))) {
      if (m.index < from) continue;
      const v = toNumber(m[1]);
      if (v != null && v > 0 && v <= 400) add("groundSnowLoadPsf", v, sentence);
    }

    // Ultimate design wind speed. "minimum" is the requirement here; a maximum/rating is not.
    const wind = /(\d{2,3}(?:\.\d+)?)\s*mph\b/gi;
    while ((m = wind.exec(sentence))) {
      if (m.index < from) continue;
      const pre = sentence.slice(0, m.index);
      if (!/\bwind\b|\bv\s*[_(]?\s*ult\b|\bvult\b/i.test(pre) && !/^\s*(?:\(?\s*3[\s-]*sec(?:ond)?\.?[\s-]*gust\s*\)?\s*)?(?:ultimate\s+)?(?:design\s+)?wind\b/i.test(sentence.slice(m.index + m[0].length))) continue;
      if (/(?:\bup\s*to|\bmax(?:imum)?\.?|\brated|\btested|\bexceed(?:s|ing)?|\bnot\s+more\s+than|\bless\s+than|≤|<=|<)[^0-9]{0,24}$/i.test(pre.slice(-30))) continue;
      const qual = windQualifier(`${pre.slice(-40)} ${(sentence.slice(m.index + m[0].length).match(/^\s*\(?\s*(?:v\s*[_(]?\s*(?:ult|asd)\b|vult|vasd|ultimate|nominal|asd)\b/i) ?? [""])[0]}`);
      if (qual === "nominal") continue; // the profile records the ULTIMATE speed (R301.2.1)
      const v = toNumber(m[1]);
      if (v != null && v >= 85 && v <= 250) add("windSpeedMph", v, sentence);
    }

    // Wind exposure category.
    const exposure = /\bexp(?:osure|\.)\s*(?:cat(?:egory|\.)?\s*)?[:=-]?\s*([BCD])(?![A-Za-z0-9])/gi;
    while ((m = exposure.exec(sentence))) {
      if (m.index + m[0].length <= from) continue;
      add("windExposure", m[1].toUpperCase(), sentence);
    }

    // Roof-attachment spacing, o.c. — the shared reader below (the design side uses it too).
    for (const s of extractAttachmentSpacings(sentence)) {
      if (cue >= 0 && s.at < cue) continue;
      add("maxAttachmentSpacingIn", s.inches, sentence);
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
  const adopted = ctx.profile?.adoptedCodes?.length ? ctx.adoptedCodes : [];
  if (adopted.length && stated.codeBasis.length) {
    const lines: string[] = [];
    const seen = new Set<string>();
    const check = (code: string, edition: string, how: string, source: string): void => {
      const same = adopted.filter((a) => a.code.trim().toUpperCase() === code.toUpperCase());
      if (!same.length || same.some((a) => String(a.edition).trim() === edition)) return;
      const key = `${code}|${edition}`;
      if (seen.has(key)) return;
      seen.add(key);
      lines.push(`${how} ${code} ${edition} (${source}) — profile records ${same.map((a) => `${a.code} ${a.edition}`).join(" / ")}`);
    };
    for (const b of stated.codeBasis) {
      check(b.code, b.edition, "plan states", b.source);
      if (b.baseCode && b.baseEdition) check(b.baseCode, b.baseEdition, `plan states ${b.code} ${b.edition} based on`, b.source);
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
          .filter((code) => adopted.some((a) => a.code.toUpperCase() === code.toUpperCase()))
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
