// IMAGE-ONLY PLAN SETS AND IMAGE-ONLY PAGES: read by vision, chosen by content, capped, labelled.
//
// Two of the Iowa City corpus's plan sets (.probe/kin/ia/corpus) were SCANS: the text layer held
// 0 characters, so the text parser had nothing to read and every field came back empty — the
// parser page's own comment said "The plan set is always vector text (pdfjs) — no OCR either
// way", which those two sets disprove.
//
// SCAN (the whole text layer is empty or near-empty): the plan's KEY SHEETS are rendered to images
// and read with the same extraction contract as the text path (llm.extractProjectFields with
// planPageImages). WHICH sheets is decided by CONTENT, not position: every page is rendered small
// and one page-index read (llm.classifyPlanPages) names each page from its title block and the
// set's sheet index — cover, site/roof plan, one-line, calcs, attachment detail, labels, module and
// inverter datasheets. A second small read (llm.orientPlanPages) settles each chosen page's
// orientation by COMPARISON — four turned copies, pick the upright one — because asked for an
// angle, the index said "180" for sheets that were 90° sideways. Position picked pages 1, 2, 9 and 16 of a real
// 16-page Iowa City scan and skipped the one-line, the calcs and both datasheets (28 fields
// missing); the index picks the sheets that answer the intake. When the index names nothing usable
// (no index read, or no key sheet identified) the POSITION rule is kept exactly as it was
// (selectKeySheetPages: cover, site plan, middle, last — at most 4).
//
// HYBRID (a text set with image-only pages): spec sheets pasted into a vector PDF as pictures
// carry only their title block in the text layer (a real Iowa City set: 684 characters of title
// block on each of six datasheet pages), so the module Voc / Isc / temperature coefficient and the
// micro's max DC input never reach the text read. Those pages are found by what they ARE — little
// text beyond the title block the other pages repeat, and a large raster — read by vision, and
// MERGED UNDER the text read (mergeImagePageRead): the text layer stays authoritative wherever
// both answer, a disagreement is kept as a conflict, and only the fields the text did not answer
// come from vision.
//
// CAPS, enforced here and never by the prompt: at most MAX_VISION_PAGES distinct pages per read,
// each image inside the model's limits (VISION_MAX_LONG_EDGE / VISION_MAX_PIXELS) and under
// MAX_IMAGE_BYTES, and at most MAX_VISION_BYTES of images per call. Pages are rendered in priority
// order, so a byte budget that runs out drops the least useful sheet; every page that was a
// candidate and was not read is named, with why, in `visionSkipped` and the lead note.
import type {
  LLMProvider, ParserExtractedField, ParserExtractionConflict, ParserExtractionUncertainty,
  ParserLlmExtraction, PlanPageClass, PlanPageIndex, PlanSheetKind,
} from "../../shared/src/types";

/** At most this many DISTINCT pages are read by vision per read (one image per page). */
export const MAX_VISION_PAGES = 8;
/** The position rule (no usable page index) keeps its original page count. */
export const POSITION_RULE_PAGES = 4;
/** Opus 5's image limits: 2576 px on the long edge, ~3.75 MP (a larger image is only downscaled
 *  by the API, so rendering bigger costs bytes and buys nothing). Kept just under the area cap. */
export const VISION_MAX_LONG_EDGE = 2576;
export const VISION_MAX_PIXELS = 3_600_000;
/** Per-image byte cap (the API refuses an image over 5 MB; base64 inflates by 4/3). */
export const MAX_IMAGE_BYTES = 3_500_000;
/** Per-call byte budget for all page images together (the request limit is 32 MB, base64). */
export const MAX_VISION_BYTES = 16_000_000;
/** The page-index read sees at most this many pages (small images; a 60-page set is ~60k tokens). */
export const MAX_INDEX_PAGES = 60;
/** Small render for the page-index read; the first two pages (where a sheet index usually sits)
 *  a little larger. */
const INDEX_THUMB = { maxLongEdge: 1000, maxPixels: 800_000, quality: 70 } as const;
const INDEX_THUMB_FIRST = { maxLongEdge: 1600, maxPixels: 2_000_000, quality: 75 } as const;
/** A page with fewer letters/digits than this carries no usable text layer. */
const MIN_CHARS_PER_PAGE = 40;
/** HYBRID: a page whose text, less the title block every page repeats, is under this many
 *  letters/digits AND which paints at least MIN_RASTER_PIXELS of raster is an image-only page. */
export const MIN_BODY_CHARS = 150;
export const MIN_RASTER_PIXELS = 500_000;

/** Letters/digits in the text, ignoring the "--- PAGE n ---" markers the extractors add. */
export function meaningfulChars(text: string): number {
  return String(text ?? "").replace(/---\s*(?:OCR\s+)?PAGE\s+\d+\s*---/gi, "").replace(/[^A-Za-z0-9]/g, "").length;
}

/** Empty or near-empty text layer for a set of `pageCount` pages. */
export function planTextIsNearEmpty(text: string, pageCount: number): boolean {
  return meaningfulChars(text) < MIN_CHARS_PER_PAGE * Math.max(1, pageCount);
}

/** The pages to read when nothing can be classified: cover, site plan, the middle (the one-line
 *  on a residential set), the last (spec sheets) — distinct, in order, capped. */
export function selectKeySheetPages(pageCount: number, cap = POSITION_RULE_PAGES): number[] {
  const n = Math.max(0, Math.floor(pageCount));
  if (!n) return [];
  // A set no longer than the cap is read whole (a 4-page set's one-line is page 3, which the
  // position picks below would skip).
  if (n <= cap) return Array.from({ length: n }, (_, i) => i + 1);
  const picks = [1, 2, Math.max(1, Math.round(n * 0.55)), n].filter((p) => p >= 1 && p <= n);
  return [...new Set(picks)].sort((a, b) => a - b).slice(0, Math.max(1, cap));
}

// ---------------------------------------------------------------------------------------------
// Page index: validation and content choice
// ---------------------------------------------------------------------------------------------

const KINDS: readonly PlanSheetKind[] = [
  "cover", "site_plan", "roof_plan", "attachment", "structural", "one_line", "calcs", "labels",
  "module_spec", "inverter_spec", "battery_spec", "racking_spec", "other_spec", "certificate", "notes", "other", "blank",
];

/** Plain words for a kind, for labels and the lead note. */
export const KIND_WORDS: Record<PlanSheetKind, string> = {
  cover: "cover", site_plan: "site plan", roof_plan: "roof plan", attachment: "attachment detail", structural: "structural",
  one_line: "one-line", calcs: "electrical calcs", labels: "labels", module_spec: "module datasheet",
  inverter_spec: "inverter datasheet", battery_spec: "battery datasheet", racking_spec: "racking datasheet",
  other_spec: "equipment datasheet", certificate: "certificate", notes: "notes", other: "other sheet", blank: "blank",
};

/** Validate whatever the page-index read returned: only pages that were shown, known kinds,
 *  quarter-turn rotations, short strings, one entry per page. Never trusts the model's shape. */
export function normalizePageIndex(raw: unknown, shownPages: number[]): PlanPageIndex {
  const shown = new Set(shownPages);
  const r = (raw && typeof raw === "object" ? raw : {}) as { pages?: unknown; sheetIndex?: unknown };
  const seen = new Set<number>();
  const pages: PlanPageClass[] = [];
  const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 60) : "");
  for (const e of Array.isArray(r.pages) ? r.pages : []) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const page = Number(o.page);
    if (!Number.isInteger(page) || !shown.has(page) || seen.has(page)) continue;
    seen.add(page);
    const kind = (KINDS as readonly string[]).includes(String(o.kind)) ? (String(o.kind) as PlanSheetKind) : "other";
    // Only a quarter turn is a rotation (-90 is 270); anything else is no rotation.
    const deg = ((Number(o.rotate) % 360) + 360) % 360;
    const rotate = (Number.isFinite(deg) && [0, 90, 180, 270].includes(deg) ? deg : 0) as PlanPageClass["rotate"];
    const sheet = str(o.sheet), title = str(o.title);
    // Only a module datasheet can be the inverter's too (#79), and only on an explicit true.
    const both = kind === "module_spec" && o.integratedInverter === true;
    pages.push({ page, kind, rotate, ...(sheet ? { sheet } : {}), ...(title ? { title } : {}), ...(both ? { integratedInverter: true as const } : {}) });
  }
  pages.sort((a, b) => a.page - b.page);
  const sheetIndex = (Array.isArray(r.sheetIndex) ? r.sheetIndex : [])
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
    .map((e) => ({ sheet: str(e.sheet), title: str(e.title) }))
    .filter((e) => e.sheet || e.title)
    .slice(0, 80);
  return { pages, sheetIndex };
}

/** The order sheets are wanted in: each slot takes the first unread page of its kinds. The first
 *  pass is one of each thing an intake needs; later slots add a second site/roof plan, a second
 *  electrical sheet, and so on, until the cap. */
const SCAN_PRIORITY: PlanSheetKind[][] = [
  ["cover"],
  ["site_plan", "roof_plan"],
  ["one_line"],
  ["calcs"],
  ["module_spec"],
  ["inverter_spec"],
  ["attachment", "structural"],
  ["labels"],
  ["battery_spec"],
  ["roof_plan", "site_plan"],
  ["structural", "attachment"],
  ["one_line", "calcs"],
  ["notes"],
  ["other_spec", "racking_spec"],
  ["certificate", "other"],
];
/** A text set's image-only pages: the datasheets first (the text layer already has the drawings). */
const HYBRID_PRIORITY: PlanSheetKind[][] = [
  ["module_spec"], ["inverter_spec"], ["battery_spec"],
  ["one_line", "calcs"], ["site_plan", "roof_plan", "structural", "attachment"], ["labels", "cover"],
  ["other_spec", "racking_spec"], ["notes", "certificate", "other"],
];
/** Kinds that make an index worth trusting for a scan: the cover alone identifies nothing. */
const KEY_KINDS = new Set<PlanSheetKind>(["site_plan", "roof_plan", "one_line", "calcs", "attachment", "structural", "labels", "module_spec", "inverter_spec", "battery_spec"]);

export interface PageChoice {
  /** Pages to read, IN PRIORITY ORDER (the byte budget drops from the end). */
  pages: PlanPageClass[];
  /** "index" = chosen by content; "position" = the page index named nothing usable. */
  by: "index" | "position";
  /** Candidate pages not chosen, and why. */
  skipped: Array<{ page: number; reason: string }>;
}

/** Choose up to `cap` pages by what they are. `candidates` bounds the choice (a hybrid set's
 *  image-only pages); for a scan it is every page. Returns null when the index identifies no key
 *  sheet (the caller falls back to position). */
export function choosePagesByContent(index: PlanPageIndex, candidates: number[], cap: number, mode: "scan" | "hybrid" = "scan"): PageChoice | null {
  const allowed = new Set(candidates);
  const byPage = new Map(index.pages.filter((p) => allowed.has(p.page)).map((p) => [p.page, p] as const));
  const usable = [...byPage.values()].filter((p) => p.kind !== "blank");
  if (mode === "scan" && !usable.some((p) => KEY_KINDS.has(p.kind))) return null;
  if (!usable.length) return null;
  const limit = Math.max(1, Math.floor(cap));
  const chosen: PlanPageClass[] = [];
  const taken = new Set<number>();
  const take = (p: PlanPageClass | undefined) => { if (p && !taken.has(p.page) && chosen.length < limit) { chosen.push(p); taken.add(p.page); } };
  const priority = mode === "hybrid" ? HYBRID_PRIORITY : SCAN_PRIORITY;
  // A scan with no page the index calls "cover" still has its project block on page 1.
  if (mode === "scan" && !usable.some((p) => p.kind === "cover")) take(usable.find((p) => p.page === 1));
  for (let round = 0; round < 3 && chosen.length < limit; round++) {
    for (const slot of priority) {
      if (chosen.length >= limit) break;
      take(usable.find((p) => slot.includes(p.kind) && !taken.has(p.page)));
    }
  }
  // Anything still unread (unknown kinds) fills the remaining slots in page order.
  for (const p of usable) take(p);
  const skipped: PageChoice["skipped"] = [];
  for (const page of candidates) {
    if (taken.has(page)) continue;
    const p = byPage.get(page);
    skipped.push({ page, reason: !p ? "not in the page index" : p.kind === "blank" ? "blank" : `${KIND_WORDS[p.kind]} — over the ${limit}-page cap` });
  }
  return { pages: chosen, by: "index", skipped };
}

// ---------------------------------------------------------------------------------------------
// Hybrid detection: image-only pages inside a text PDF
// ---------------------------------------------------------------------------------------------

/** Letters/digits on each page that are NOT the boilerplate every page repeats (the title block):
 *  a token present on at least half the pages (and on 2+) is boilerplate. */
export function bodyCharsPerPage(pageTexts: string[]): number[] {
  const n = pageTexts.length;
  const tokensOf = (t: string) => String(t ?? "").toUpperCase().split(/\s+/).map((w) => w.replace(/[^A-Z0-9]/g, "")).filter(Boolean);
  const perPage = pageTexts.map(tokensOf);
  const docFreq = new Map<string, number>();
  for (const toks of perPage) for (const w of new Set(toks)) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
  const common = (w: string) => n >= 3 && (docFreq.get(w) ?? 0) >= Math.max(2, Math.ceil(n / 2));
  return perPage.map((toks) => toks.filter((w) => !common(w)).reduce((s, w) => s + w.length, 0));
}

/** The image-only pages of a set that HAS a text layer: little body text and a large raster. */
export function imageOnlyPages(pageTexts: string[], rasterPixels: number[]): number[] {
  const body = bodyCharsPerPage(pageTexts);
  const out: number[] = [];
  for (let i = 0; i < pageTexts.length; i++) {
    if (body[i] < MIN_BODY_CHARS && (rasterPixels[i] ?? 0) >= MIN_RASTER_PIXELS) out.push(i + 1);
  }
  return out;
}

/** Raster pixels each page paints (image XObjects, one level of form XObjects deep, summed — a
 *  scan is often cut into dozens of strips). pdf-lib only; nothing is decoded. */
export async function rasterPixelsPerPage(pdfBytes: Uint8Array): Promise<number[]> {
  const { PDFDocument, PDFName, PDFDict, PDFStream } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const sum = (res: unknown, depth: number, seen: Set<unknown>): number => {
    if (!(res instanceof PDFDict) || depth > 3) return 0;
    const xo = res.lookup(PDFName.of("XObject"));
    if (!(xo instanceof PDFDict)) return 0;
    let total = 0;
    for (const [, ref] of xo.entries()) {
      const s = doc.context.lookup(ref);
      if (!(s instanceof PDFStream) || seen.has(s)) continue;
      seen.add(s);
      const d = s.dict;
      const sub = d.get(PDFName.of("Subtype"))?.toString();
      if (sub === "/Image") {
        const w = Number(d.lookup(PDFName.of("Width"))?.toString()), h = Number(d.lookup(PDFName.of("Height"))?.toString());
        if (Number.isFinite(w) && Number.isFinite(h)) total += w * h;
      } else if (sub === "/Form") {
        total += sum(d.lookup(PDFName.of("Resources")), depth + 1, seen);
      }
    }
    return total;
  };
  return doc.getPages().map((p) => { try { return sum(p.node.Resources(), 0, new Set()); } catch { return 0; } });
}

// ---------------------------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------------------------

export interface ScannedPlanRead {
  /** "text" = the text layer is usable and no page is image-only; nothing was sent to vision. */
  mode: "text" | "vision" | "hybrid";
  pageCount: number;
  textChars: number;
  /** HYBRID: the image-only pages found (before the cap). */
  imagePages?: number[];
  extraction?: ParserLlmExtraction;
}

type PageImage = { page: number; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; label?: string };
type Renderer = Awaited<ReturnType<typeof import("./pageImages").openPdfForVisionRender>>;

function roleLabel(p: PlanPageClass | { page: number; kind: PlanSheetKind; sheet?: string; rotate?: number }): string {
  const bits = [KIND_WORDS[p.kind]];
  if (p.sheet) bits.push(p.sheet);
  if (p.rotate) bits.push(`turned ${p.rotate}° upright`);
  return bits.join(", ");
}

/** Render the chosen pages in priority order under the per-image and per-call byte caps. */
async function renderChosen(renderer: Renderer, chosen: PlanPageClass[], labelled: boolean, byteBudget = MAX_VISION_BYTES) {
  const images: PageImage[] = [];
  const skipped: Array<{ page: number; reason: string }> = [];
  let total = 0;
  for (const p of chosen) {
    let img: Awaited<ReturnType<Renderer["render"]>> | null = null;
    try {
      img = await renderer.render(p.page, { maxLongEdge: VISION_MAX_LONG_EDGE, maxPixels: VISION_MAX_PIXELS, rotate: p.rotate, quality: 85 });
      // Over the per-image cap: lower quality, then fewer pixels, before giving the page up.
      if (img.bytes.length > MAX_IMAGE_BYTES) img = await renderer.render(p.page, { maxLongEdge: VISION_MAX_LONG_EDGE, maxPixels: VISION_MAX_PIXELS, rotate: p.rotate, quality: 65 });
      if (img.bytes.length > MAX_IMAGE_BYTES) img = await renderer.render(p.page, { maxLongEdge: 2000, maxPixels: 2_000_000, rotate: p.rotate, quality: 65 });
    } catch (err) {
      skipped.push({ page: p.page, reason: `could not be rendered (${String((err as Error)?.message ?? err).slice(0, 80)})` });
      continue;
    }
    if (img.bytes.length > MAX_IMAGE_BYTES) { skipped.push({ page: p.page, reason: `image over the ${MAX_IMAGE_BYTES}-byte per-image cap` }); continue; }
    if (total + img.bytes.length > byteBudget) { skipped.push({ page: p.page, reason: `over the ${byteBudget}-byte per-read image budget` }); continue; }
    total += img.bytes.length;
    images.push({ page: p.page, base64: img.bytes.toString("base64"), mimeType: img.mimeType, ...(labelled ? { label: roleLabel(p) } : {}) });
  }
  return { images, skipped, bytes: total };
}

/** Small images of `pages` for the page-index read. A `byteBudget` (the per-read image budget)
 *  stops adding pages once their images would go over it. */
async function renderThumbs(renderer: Renderer, pages: number[], byteBudget = Number.POSITIVE_INFINITY): Promise<PageImage[]> {
  const out: PageImage[] = [];
  let total = 0;
  for (const page of pages) {
    try {
      const img = await renderer.render(page, page <= 2 ? INDEX_THUMB_FIRST : INDEX_THUMB);
      if (total + img.bytes.length > byteBudget) continue;
      total += img.bytes.length;
      out.push({ page, base64: img.bytes.toString("base64"), mimeType: img.mimeType });
    } catch { /* an unrenderable page is simply not indexed */ }
  }
  return out;
}

/** Run the page-index read over `pages`; null when there is none or it failed. */
async function readPageIndex(
  llm: Pick<LLMProvider, "classifyPlanPages">, renderer: Renderer, pages: number[], byteBudget?: number,
): Promise<{ index: PlanPageIndex | null; failure?: string }> {
  if (typeof llm.classifyPlanPages !== "function") return { index: null, failure: "no page index was available" };
  const shown = pages.slice(0, MAX_INDEX_PAGES);
  const thumbs = await renderThumbs(renderer, shown, byteBudget);
  if (!thumbs.length) return { index: null, failure: "no page could be rendered for the index" };
  try {
    const raw = await llm.classifyPlanPages({ pageImages: thumbs });
    return { index: normalizePageIndex(raw, thumbs.map((t) => t.page)) };
  } catch (err) {
    return { index: null, failure: `the page-index read failed (${String((err as Error)?.message ?? err).slice(0, 80)})` };
  }
}

// ---------------------------------------------------------------------------------------------
// Undecided EQUIPMENT SPECIFICATION pages (#79): the same page-index read, on those pages only
// ---------------------------------------------------------------------------------------------

/** A page whose text says it is a utility bill or a meter record. Rule 2 (CLAUDE.md): only page
 *  images of EQUIPMENT DATASHEETS go to the page-index read, so a page that reads as a bill or a
 *  meter (an account/meter number label, the bill's money words) is withheld BEFORE anything is
 *  rendered — whatever spec-sheet title it also carries. Broad on purpose: a datasheet withheld by
 *  mistake only stays undecided (a person decides, as before #79); a bill sent by mistake is a breach. */
const BILL_OR_METER_PAGE = new RegExp([
  String.raw`\b(?:ACCOUNT|ACCT|METER|SERVICE\s+AGREEMENT|SA|ESI)\s*(?:NUMBER|NO\b|NO\.|#|ID\b)`,
  String.raw`\bESI\s*-?\s*ID\b`, String.raw`\bMETER\s+(?:READ(?:ING)?S?|PHOTO)\b`, String.raw`\bUTILITY\s+BILL\b`,
  String.raw`\bAMOUNT\s+DUE\b`, String.raw`\bBILLING\s+PERIOD\b`, String.raw`\bPREVIOUS\s+BALANCE\b`,
  String.raw`\bCURRENT\s+CHARGES\b`, String.raw`\bSTATEMENT\s+DATE\b`, String.raw`\bkWh\s+USED\b`,
].join("|"), "i");
export function looksLikeBillOrMeterPage(text: string): boolean {
  return BILL_OR_METER_PAGE.test(String(text ?? ""));
}

/** Datasheet kinds that DECIDE an undecided spec page: module / inverter go into those parts; the
 *  rest (combiner, racking, battery…) are datasheets that belong in neither. */
const DATASHEET_KINDS = new Set<PlanSheetKind>(["module_spec", "inverter_spec", "battery_spec", "racking_spec", "other_spec"]);

export interface UndecidedSpecRead {
  /** 1-based page → the datasheet kind the page-index read gave it (datasheet kinds only). */
  decided: Record<string, PlanSheetKind>;
  /** module_spec pages that are AC modules carrying the integrated micro's ratings and UL 1741
   *  listing: the inverter datasheet too. */
  integratedInverter: number[];
  /** Pages never rendered or sent because their text reads as a bill or meter record (rule 2). */
  withheld: number[];
  /** Why no read ran, or why it named nothing ("" when it ran). */
  failure?: string;
}

/** Label a text plan set's undecided EQUIPMENT SPECIFICATION pages (docSplitter's
 *  `undecidedSpecPages`, title-only cut-sheets) with the EXISTING page-index read: their small
 *  images, under the existing page cap (MAX_INDEX_PAGES) and per-read image budget
 *  (MAX_VISION_BYTES, which a caller may only tighten). No pages → no render and no call. */
export async function readUndecidedSpecPages(
  llm: Pick<LLMProvider, "classifyPlanPages">,
  pdfBytes: Uint8Array,
  pages: number[],
  pageTexts: string[],
  opts: { maxBytes?: number } = {},
): Promise<UndecidedSpecRead> {
  const out: UndecidedSpecRead = { decided: {}, integratedInverter: [], withheld: [] };
  if (!pages.length) return out;
  const send = pages.filter((p) => {
    if (!looksLikeBillOrMeterPage(pageTexts[p - 1] ?? "")) return true;
    out.withheld.push(p);
    return false;
  });
  if (!send.length) return { ...out, failure: "every undecided page reads as a bill or meter record" };
  if (typeof llm.classifyPlanPages !== "function") return { ...out, failure: "no page index was available" };
  const byteBudget = Math.max(1, Math.min(MAX_VISION_BYTES, Math.floor(opts.maxBytes ?? MAX_VISION_BYTES)));
  const { openPdfForVisionRender } = await import("./pageImages");
  const renderer = await openPdfForVisionRender(pdfBytes);
  try {
    const { index, failure } = await readPageIndex(llm, renderer, send, byteBudget);
    if (!index) return { ...out, failure };
    for (const p of index.pages) {
      if (!DATASHEET_KINDS.has(p.kind)) continue;
      out.decided[String(p.page)] = p.kind;
      if (p.integratedInverter) out.integratedInverter.push(p.page);
    }
    return out;
  } finally {
    await renderer.close();
  }
}

/** Small render for the orientation read (four turned copies of each chosen page). */
const ORIENT_THUMB = { maxLongEdge: 640, maxPixels: 300_000, quality: 70 } as const;
const QUARTER_TURNS = [0, 90, 180, 270] as const;

/** Settle each chosen page's rotation by COMPARISON (llm.orientPlanPages): four turned copies of
 *  each page, the reader names the upright one. Without a reader the pages keep what they have;
 *  a failed read turns nothing (the page goes as scanned, as it always did). */
async function orientChosen(
  llm: Pick<LLMProvider, "orientPlanPages">, renderer: Renderer, chosen: PlanPageClass[],
): Promise<PlanPageClass[]> {
  if (typeof llm.orientPlanPages !== "function" || !chosen.length) return chosen;
  const pages: Array<{ page: number; versions: Array<{ rotate: 0 | 90 | 180 | 270; base64: string; mimeType: "image/jpeg" }> }> = [];
  for (const c of chosen) {
    try {
      const versions = [];
      for (const rotate of QUARTER_TURNS) {
        const img = await renderer.render(c.page, { ...ORIENT_THUMB, rotate });
        versions.push({ rotate, base64: img.bytes.toString("base64"), mimeType: img.mimeType });
      }
      pages.push({ page: c.page, versions });
    } catch { /* an unrenderable page keeps its rotation */ }
  }
  let answer: unknown;
  try { answer = await llm.orientPlanPages({ pages }); } catch { return chosen.map((c) => ({ ...c, rotate: 0 })); }
  const byPage = new Map<number, PlanPageClass["rotate"]>();
  for (const a of Array.isArray(answer) ? answer : []) {
    if (!a || typeof a !== "object") continue;
    const page = Number((a as { page?: unknown }).page), rot = Number((a as { rotate?: unknown }).rotate);
    if (Number.isInteger(page) && (QUARTER_TURNS as readonly number[]).includes(rot) && !byPage.has(page)) byPage.set(page, rot as PlanPageClass["rotate"]);
  }
  return chosen.map((c) => (byPage.has(c.page) ? { ...c, rotate: byPage.get(c.page)! } : c));
}

const listPages = (ps: number[]) => ps.join(", ");
function describeSkipped(skipped: Array<{ page: number; reason: string }>): string {
  if (!skipped.length) return "";
  // Group consecutive identical reasons: "pages 9-16 (equipment datasheet — over the 8-page cap)".
  const byReason = new Map<string, number[]>();
  for (const s of skipped) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.page]);
  return ` Not read: ${[...byReason.entries()].map(([reason, ps]) => `page${ps.length > 1 ? "s" : ""} ${listPages(ps)} (${reason})`).join("; ")}.`;
}

/** Read a plan-set PDF: its text layer if it has one (plus, by vision, any image-only pages);
 *  otherwise its key sheets by vision. */
export async function readPlanSetForExtraction(
  llm: Pick<LLMProvider, "extractProjectFields" | "classifyPlanPages" | "orientPlanPages">,
  pdfBytes: Uint8Array,
  opts: { defaultState?: string; maxPages?: number; maxBytes?: number } = {},
): Promise<ScannedPlanRead> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pageCount = doc.getPageCount();
  const { extractLabels } = await import("./formTextLayer");
  const labels = await extractLabels(pdfBytes);
  const text = labels.map((l) => l.str).join(" ");
  const textChars = meaningfulChars(text);
  const cap = Math.max(1, Math.min(MAX_VISION_PAGES, Math.floor(opts.maxPages ?? MAX_VISION_PAGES)));
  // A caller may only TIGHTEN the byte budget.
  const byteBudget = Math.max(1, Math.min(MAX_VISION_BYTES, Math.floor(opts.maxBytes ?? MAX_VISION_BYTES)));
  const scan = planTextIsNearEmpty(text, pageCount);

  let imagePages: number[] = [];
  if (!scan) {
    const pageTexts = Array.from({ length: pageCount }, () => "");
    for (const l of labels) if (l.page >= 0 && l.page < pageCount) pageTexts[l.page] += ` ${l.str}`;
    imagePages = imageOnlyPages(pageTexts, await rasterPixelsPerPage(pdfBytes));
    if (!imagePages.length) return { mode: "text", pageCount, textChars };
  }

  const { openPdfForVisionRender } = await import("./pageImages");
  const renderer = await openPdfForVisionRender(pdfBytes);
  try {
    if (scan) {
      const all = Array.from({ length: pageCount }, (_, i) => i + 1);
      const { index, failure } = await readPageIndex(llm, renderer, all);
      const choice = index ? choosePagesByContent(index, all, cap, "scan") : null;
      const positionCap = Math.min(POSITION_RULE_PAGES, cap);
      const picked: PlanPageClass[] = choice
        ? choice.pages
        : selectKeySheetPages(pageCount, positionCap).map((page) => ({ page, kind: "other" as const, rotate: (index?.pages.find((p) => p.page === page)?.rotate ?? 0) as PlanPageClass["rotate"] }));
      // A scan may be sideways or upside down: settle each chosen page upright before the read.
      const chosen = await orientChosen(llm, renderer, picked);
      const { images, skipped: renderSkipped } = await renderChosen(renderer, chosen, Boolean(choice), byteBudget);
      const read = images.map((i) => i.page);
      const pages = [...read].sort((a, b) => a - b);
      const skipped = [...(choice?.skipped ?? all.filter((p) => !chosen.some((c) => c.page === p)).map((page) => ({ page, reason: `not a position pick — ${failure ?? "the page index named no key sheet"}` }))), ...renderSkipped]
        .sort((a, b) => a.page - b.page);
      const ordered = pages.map((pg) => images.find((i) => i.page === pg)!);
      const result = await llm.extractProjectFields({ planPageImages: ordered, planImageMode: "scan", defaultState: opts.defaultState });
      const visionFields = Object.keys(result.fields ?? {});
      // What each page was taken to be — only when the index named it (a position pick is a guess).
      const roles = choice
        ? pages.map((pg) => {
          const c = chosen.find((x) => x.page === pg)!;
          return { page: pg, kind: c.kind, ...(c.sheet ? { sheet: c.sheet } : {}), ...(c.title ? { title: c.title } : {}), ...(c.rotate ? { rotate: c.rotate } : {}) };
        })
        : undefined;
      const why = roles
        ? `chosen by their sheet titles from the page index — ${roles.map((r) => `${r.page} ${roleLabel(r)}`).join("; ")} — at most ${cap}`
        : `cover, site plan, one-line, spec — chosen by POSITION because ${failure ?? "the page index named no key sheet"}, at most ${positionCap}`;
      const lead = `IMAGE-ONLY PLAN SET: the PDF has no usable text layer (${textChars} characters over ${pageCount} page(s)), so pages ${listPages(pages)} (${why}) were read by VISION.${describeSkipped(skipped)} Every value below came from those images${visionFields.length ? ` (${visionFields.join(", ")})` : " — none was read"}; verify each against the sheet.`;
      return {
        mode: "vision", pageCount, textChars,
        extraction: { ...result, visionFields, visionPages: pages, planReadMode: "vision", ...(roles ? { visionPageRoles: roles } : {}), visionSkipped: skipped, notes: [lead, result.notes].filter(Boolean).join(" ") },
      };
    }

    // HYBRID: a text set's image-only pages. Few enough are all read (page order, no index read —
    // pictures a PDF tool placed are upright); more than the cap are chosen by content.
    let chosen: PlanPageClass[] = imagePages.map((page) => ({ page, kind: "other" as const, rotate: 0 as const }));
    let skipped: Array<{ page: number; reason: string }> = [];
    let byIndex = false;
    if (imagePages.length > cap) {
      const { index, failure } = await readPageIndex(llm, renderer, imagePages);
      const choice = index ? choosePagesByContent(index, imagePages, cap, "hybrid") : null;
      if (choice) { chosen = choice.pages; skipped = choice.skipped; byIndex = true; }
      else {
        chosen = chosen.slice(0, cap);
        skipped = imagePages.slice(cap).map((page) => ({ page, reason: `over the ${cap}-page cap (${failure ?? "the page index named nothing"}; first pages kept)` }));
      }
    }
    const { images, skipped: renderSkipped } = await renderChosen(renderer, chosen, byIndex, byteBudget);
    skipped = [...skipped, ...renderSkipped].sort((a, b) => a.page - b.page);
    const pages = images.map((i) => i.page).sort((a, b) => a - b);
    if (!pages.length) {
      return { mode: "hybrid", pageCount, textChars, imagePages, extraction: { provider: "claude", fields: {}, lowConfidenceFields: [], notes: `IMAGE-ONLY PAGES: pages ${listPages(imagePages)} carry no text layer, but none could be read by vision.${describeSkipped(skipped)}`, visionFields: [], visionPages: [], planReadMode: "hybrid", visionSkipped: skipped } };
    }
    const ordered = pages.map((pg) => images.find((i) => i.page === pg)!);
    const result = await llm.extractProjectFields({ planPageImages: ordered, planImageMode: "hybrid", defaultState: opts.defaultState });
    const roles = pages.map((pg) => { const c = chosen.find((x) => x.page === pg)!; return { page: pg, kind: c.kind, ...(c.sheet ? { sheet: c.sheet } : {}), ...(c.title ? { title: c.title } : {}) }; });
    return {
      mode: "hybrid", pageCount, textChars, imagePages,
      extraction: { ...result, visionFields: Object.keys(result.fields ?? {}), visionPages: pages, planReadMode: "hybrid", visionPageRoles: roles, visionSkipped: skipped },
    };
  } finally {
    await renderer.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Hybrid merge: the text read stays authoritative
// ---------------------------------------------------------------------------------------------

const FIELD_ID = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
/** A text value that only says the TEXT did not state it ("Not stated on plan set (no UL 1741 SA/SB
 *  listing note found)" — the real text read of a set whose inverter datasheet was a picture) is
 *  not an answer, and must not outrank an image page that states it. Narrow on purpose: "N/A",
 *  "none" and "not required" ARE answers and stay authoritative. */
const STATED_ABSENCE = /^\s*(?:not\s+(?:stated|shown|found|given|listed|provided|specified|legible|readable|visible)|unknown|illegible|unreadable)\b/i;
/** Prose judgements: two wordings of the same verdict are not a disagreement. */
const PROSE_FIELD = (key: string) => /Text$/.test(key) || key === "stampRecommendation";

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  // A number with at most a short unit ("200A", "49.8 V", "-0.29 %/C") compares as a number.
  const num = (v: unknown) => { const m = String(v).trim().match(/^(-?\d+(?:\.\d+)?)\s*[A-Za-z%°/"]{0,5}$/); return m ? Number(m[1]) : null; };
  const na = num(a), nb = num(b);
  if (na != null && nb != null) return Math.abs(na - nb) <= Math.max(1e-9, 0.005 * Math.max(Math.abs(na), Math.abs(nb)));
  const norm = (v: unknown) => String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = norm(a), y = norm(b);
  return x === y || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)));
}

/** Merge the vision read of a text set's image-only pages INTO the text read. The text read wins
 *  every field it answered; vision fills only the fields the text left empty (listed in
 *  visionFields); where both answered and disagree, the text value is kept and both readings are
 *  recorded as a conflict. `imageRead` comes from the client (the parser page posts back what the
 *  plan-scan route returned), so its shape is validated here, never trusted. */
export function mergeImagePageRead(textRead: ParserLlmExtraction, imageRead: unknown): ParserLlmExtraction {
  const ir = (imageRead && typeof imageRead === "object" ? imageRead : {}) as Record<string, unknown>;
  const irFields = (ir.fields && typeof ir.fields === "object" ? ir.fields : {}) as Record<string, unknown>;
  const visionPages = (Array.isArray(ir.visionPages) ? ir.visionPages : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
  const fields: Record<string, ParserExtractedField> = { ...(textRead.fields ?? {}) };
  const visionFields: string[] = [];
  const conflicts: ParserExtractionConflict[] = [...(textRead.conflicts ?? [])];
  const disagreed: string[] = [];
  const filledOverAbsence: string[] = [];
  for (const [key, entry] of Object.entries(irFields)) {
    if (!FIELD_ID.test(key) || !entry || typeof entry !== "object") continue;
    const e = entry as Partial<ParserExtractedField>;
    const value = e.value as ParserExtractedField["value"];
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) continue;
    if (typeof value === "string" && value.length > 4000) continue;
    const ev = e.evidence && typeof e.evidence === "object" ? e.evidence : undefined;
    const evidence = ev ? { source: "plan_set" as const, sheet: typeof ev.sheet === "string" ? ev.sheet.slice(0, 40) : undefined, excerpt: typeof ev.excerpt === "string" ? ev.excerpt.slice(0, 200) : undefined } : undefined;
    const confidence = typeof e.confidence === "number" && Number.isFinite(e.confidence) ? Math.max(0, Math.min(1, e.confidence)) : 0.5;
    const existing = fields[key];
    const textSaysAbsent = Boolean(existing) && typeof existing.value === "string" && STATED_ABSENCE.test(existing.value);
    if (textSaysAbsent) filledOverAbsence.push(key);
    if (existing && existing.value != null && existing.value !== "" && !textSaysAbsent) {
      // Narrative blobs always differ in wording; only a stated value can disagree.
      if (!PROSE_FIELD(key) && !sameValue(existing.value, value)) {
        disagreed.push(key);
        if (!conflicts.some((c) => c.field === key)) {
          const reading = (v: unknown, x: ParserExtractedField["evidence"] | undefined, where: string) => ({ value: (typeof v === "object" ? JSON.stringify(v) : v) as string | number, source: "plan_set" as const, sheet: x?.sheet ?? where, excerpt: x?.excerpt });
          conflicts.push({ field: key, readings: [reading(existing.value, existing.evidence, "text layer"), reading(value, evidence, "image page")], note: "The plan set's text layer and one of its image-only pages disagree; the text value is kept — check the sheet." });
        }
      }
      continue;
    }
    fields[key] = { value, confidence, ...(evidence ? { evidence } : {}) };
    visionFields.push(key);
  }
  const irLow = (Array.isArray(ir.lowConfidenceFields) ? ir.lowConfidenceFields : []).filter((f): f is string => typeof f === "string" && visionFields.includes(f));
  const irUnc = (Array.isArray(ir.uncertainties) ? ir.uncertainties : [])
    .filter((u): u is ParserExtractionUncertainty => Boolean(u) && typeof u === "object" && typeof (u as { field?: unknown }).field === "string" && visionFields.includes((u as { field: string }).field))
    .map((u) => ({ field: u.field, kind: u.kind, reason: String(u.reason ?? "").slice(0, 300) }));
  const skipped = (Array.isArray(ir.visionSkipped) ? ir.visionSkipped : [])
    .filter((s): s is { page: number; reason: string } => Boolean(s) && typeof s === "object" && Number.isInteger((s as { page?: unknown }).page) && typeof (s as { reason?: unknown }).reason === "string")
    .map((s) => ({ page: s.page, reason: s.reason.slice(0, 160) }))
    .slice(0, 200);
  const roles = (Array.isArray(ir.visionPageRoles) ? ir.visionPageRoles : [])
    .filter((r): r is { page: number; kind: PlanSheetKind } => Boolean(r) && typeof r === "object" && Number.isInteger((r as { page?: unknown }).page) && (KINDS as readonly string[]).includes(String((r as { kind?: unknown }).kind)))
    .map((r) => ({ page: r.page, kind: r.kind }))
    .slice(0, 200);
  if (!visionPages.length && !visionFields.length) return textRead;
  const imageNotes = typeof ir.notes === "string" ? ir.notes.trim().slice(0, 1500) : "";
  const lead = `IMAGE-ONLY PAGES: page${visionPages.length === 1 ? "" : "s"} ${listPages(visionPages)} of this plan set carry no text layer (pictures in the PDF), so ${visionPages.length === 1 ? "it was" : "they were"} read by VISION and merged under the text read — the text layer stays authoritative wherever both answer.${describeSkipped(skipped)} ${visionFields.length ? `Fields from vision: ${visionFields.join(", ")}; verify each against the sheet.` : "No field came from vision that the text had not already answered."}${filledOverAbsence.length ? ` The text read stated no value for ${filledOverAbsence.join(", ")} ("not stated"), so the image page's value is used.` : ""}${disagreed.length ? ` Where an image page disagrees with the text (${disagreed.join(", ")}), both readings are listed as conflicts.` : ""}${visionFields.length ? " A note below from the text read that these pages were unreadable describes the TEXT layer only." : ""}`;
  return {
    ...textRead,
    fields,
    lowConfidenceFields: [...new Set([...(textRead.lowConfidenceFields ?? []), ...irLow])],
    uncertainties: [...(textRead.uncertainties ?? []), ...irUnc],
    conflicts,
    visionFields,
    visionPages,
    planReadMode: "hybrid",
    ...(roles.length ? { visionPageRoles: roles } : {}),
    ...(skipped.length ? { visionSkipped: skipped } : {}),
    notes: [lead, textRead.notes, imageNotes ? `Image pages: ${imageNotes}` : ""].filter(Boolean).join(" "),
  };
}
