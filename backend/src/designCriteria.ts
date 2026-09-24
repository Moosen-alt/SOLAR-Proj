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

// Text the package itself carries. Parser commentary (reviewFlags) and utility/packet notes
// are deliberately absent: they talk ABOUT the design ("plan says 110 but letter says 95")
// and would manufacture a conflict out of the parser's own observation.
const TEXT_SOURCES: Array<[string, string]> = [
  ["planSetExtractedText", "Uploaded plan-set document text"],
  ["splitPagesText", "Split page mapping"],
  ["structuralCalcText", "Structural calculation text"],
  ["electricalCalcText", "Electrical calculation text"],
  ["sitePlanNotesText", "Site plan notes"],
  ["roofPlanNotesText", "Roof plan notes"],
  ["projectDescriptionText", "Project description"],
  ["labelsText", "Labels text"],
  ["stampRecommendation", "Stamp recommendation"],
];

function snapshotText(project: ProjectRecord, key: string): string {
  const value = project.parserSnapshot?.[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function flat(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function excerptAt(text: string, start: number, end: number): string {
  // Tight on purpose: a design-criteria note sits beside the title block on most sheets,
  // and a wide window would carry the homeowner's name and address into the report.
  return text.slice(Math.max(0, start - 24), Math.min(text.length, end + 12)).trim();
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
  const criteria: StatedDesignCriterion[] = [];
  const codeBasis: StatedCodeBasisEntry[] = [];
  extractParsedFields(project, criteria);
  const sources: DesignTextSource[] = [
    ...TEXT_SOURCES.map(([key, label]) => ({ label, text: snapshotText(project, key) })),
    ...extraTexts,
  ];
  for (const source of sources) {
    const text = flat(source.text || "");
    if (!text) continue;
    extractWind(text, source.label, criteria);
    extractExposureAndRisk(text, source.label, criteria);
    extractSnow(text, source.label, criteria);
    extractCodeBasis(text, source.label, codeBasis);
  }
  const seenBasis = new Set<string>();
  return {
    criteria: dedupe(criteria),
    codeBasis: codeBasis.filter((b) => {
      const key = `${b.source}|${b.code}|${b.edition}|${b.baseCode ?? ""}|${b.baseEdition ?? ""}`;
      if (seenBasis.has(key)) return false;
      seenBasis.add(key);
      return true;
    }),
  };
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

function describeValues(entries: Array<{ value: string | number; sources: Set<string> }>, unit: string): string {
  return entries.map((e) => `${e.value}${unit} in ${[...e.sources].join(", ")}`).join("; ");
}

export function evaluateDesignCriteriaFindings(
  project: ProjectRecord,
  ctx: EffectiveCodeContext,
  opts: { roofMounted: boolean; extraTexts?: DesignTextSource[] },
): ReviewerFinding[] {
  const stated = extractStatedDesignCriteria(project, opts.extraTexts ?? []);
  const out: ReviewerFinding[] = [];
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
    // The parser's scalar field is a reading, not a document: a disagreement that needs it
    // to exist is a warning (and may be the parser's mistake rather than the package's).
    for (let i = 0; i < entries.length && !conflictBlocker; i++) {
      for (let j = 0; j < entries.length && !conflictBlocker; j++) {
        if (i === j) continue;
        for (const s1 of entries[i].docSources) {
          if ([...entries[j].docSources].some((s2) => s2 !== s1)) { conflictBlocker = true; break; }
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
        + (conflictBlocker ? "" : " (At least one side is the parser's reading or a single source, so verify before treating it as a document conflict.)"),
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
      message: `${belowLines.join(". ")}. AHJ value from the ${provenance(ctx)}.`,
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
        if (!hits.length) return "not stated";
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
        return describeValues([...byValue.values()], "");
      };
      const lines = [
        ahjSnow == null ? `ground snow — package states ${say((c) => c.criterion === "groundSnowPsf", " psf")}` : "",
        ahjWind == null ? `wind speed — package states ${say((c) => c.criterion === "windSpeedMph", " mph")}` : "",
      ].filter(Boolean);
      const quoted = stated.criteria.filter((c) => (ahjSnow == null && c.criterion === "groundSnowPsf") || (ahjWind == null && c.criterion === "windSpeedMph"));
      out.push({
        id: "city.struct.design-criteria-unknown",
        severity: "callout",
        category: "structural",
        title: "Jurisdiction design criteria not on file — stated values unchecked",
        message: `${who}'s ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not on file yet, so the package's stated values have NOT been checked against the jurisdiction's requirement: ${lines.join("; ")}.`,
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
