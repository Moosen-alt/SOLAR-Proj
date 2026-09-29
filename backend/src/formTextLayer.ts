// ---------------------------------------------------------------------------
// Text-layer anchoring for flat AHJ forms. Many "flat" permit PDFs (e.g. the
// Oregon prescriptive rooftop solar checklist) are NOT scanned images — they
// carry a real text layer, so every label has exact coordinates. Anchoring
// fill values to those label positions is far more accurate than vision-guessed
// coordinates (which float a few points off, inconsistently, per field).
//
// This module extracts label items with pdfjs (headless, no canvas) and resolves
// a value's placement relative to a matched label. Used by ahjForms' overlay
// fill: an overlay field carrying a `label` anchor is positioned from the text
// layer; fields with only raw x/y keep working unchanged (backward compatible).
// ---------------------------------------------------------------------------

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface LabelItem {
  page: number;
  str: string;
  x: number; // left edge, PDF points
  y: number; // baseline, PDF points from bottom (pdf-lib's convention)
  width: number;
  height: number;
}

export const normLabel = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[^\w %/#.:&-]/g, "").trim();
const norm = normLabel;

/** Extract every non-empty text item with its position from a PDF. Returns [] on
 *  any failure or when the doc has no usable text layer (scanned/flattened). */
// pdfjs REFUSES Node Buffers outright ("provide binary data as Uint8Array"), and
// Buffer.slice() is still a Buffer — so a Buffer caller (fs.readFileSync, DB blobs)
// used to throw into the catch and silently get an EMPTY result, killing the whole
// text-layer path (anchoring, flat fill, checkbox recovery) with no visible error.
// new Uint8Array(bytes) copies AND strips the Buffer identity.
const asPlainBytes = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes);

export async function extractLabels(pdfBytes: Uint8Array): Promise<LabelItem[]> {
  try {
    const doc = await getDocument({ data: asPlainBytes(pdfBytes), useSystemFonts: true }).promise;
    const out: LabelItem[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      for (const it of tc.items as Array<{ str: string; transform: number[]; width: number; height: number }>) {
        if (!it.str || !it.str.trim()) continue;
        out.push({ page: n - 1, str: it.str, x: it.transform[4], y: it.transform[5], width: it.width || 0, height: it.height || 0 });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Map each checkbox field name → the descriptive text sitting just to its right
 *  (same row). Many forms name boxes generically ("Check Box6") but print the
 *  meaning next to them ("Applicant cancelled permit") — this recovers it so a
 *  reason phrase can be matched to the right box. Empty on any failure. */
export async function checkboxLabels(pdfBytes: Uint8Array): Promise<Record<string, string>> {
  try {
    const doc = await getDocument({ data: asPlainBytes(pdfBytes), useSystemFonts: true }).promise;
    const out: Record<string, string> = {};
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const boxes = (await page.getAnnotations()).filter((a: { fieldType?: string; fieldName?: string; rect?: number[] }) => a.fieldType === "Btn" && a.fieldName && a.rect);
      if (!boxes.length) continue;
      const text = (await page.getTextContent()).items as Array<{ str: string; transform: number[] }>;
      const items = text.map((t) => ({ s: t.str, x: t.transform[4], y: t.transform[5] })).filter((t) => t.s.trim());
      // Visual lines (same y within 3pt), for the Yes/No-grid fallback below.
      const lineMap = new Map<number, { y: number; parts: { s: string; x: number }[] }>();
      for (const t of items) {
        const key = Math.round(t.y / 3);
        const line = lineMap.get(key) ?? { y: t.y, parts: [] };
        line.parts.push({ s: t.s, x: t.x });
        lineMap.set(key, line);
      }
      const lines = [...lineMap.values()].map((L) => ({
        y: L.y,
        text: L.parts.sort((p, q) => p.x - q.x).map((p) => p.s).join(" ").replace(/\s+/g, " ").trim(),
      }));
      for (const a of boxes) {
        const r = a.rect as number[];
        const cy = (r[1] + r[3]) / 2;
        const cx = Math.max(r[0], r[2]);
        const near = items.filter((t) => Math.abs(t.y - cy) < 8 && t.x >= cx - 4).sort((p, q) => p.x - q.x)[0];
        let label = (near?.s ?? "").trim();
        // Yes/No GRIDS (AHJ questionnaires): the text right of a box is only the SIBLING
        // caption ("Yes [ ]  No [ ]") — the QUESTION lives on the line(s) above the pair
        // (PDF y grows upward). Join up to two lines within 40pt, top line first.
        if (!label || /^(yes|no)$/i.test(label)) {
          const above = lines
            .filter((L) => L.y > cy + 2 && L.y < cy + 40 && L.text && !/^(yes|no)(\s+(yes|no))*$/i.test(L.text))
            .sort((p, q) => p.y - q.y)
            .slice(0, 2)
            .sort((p, q) => q.y - p.y);
          if (above.length) label = above.map((L) => L.text).join(" ").slice(0, 200);
        }
        if (label && !out[a.fieldName as string]) out[a.fieldName as string] = label;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** True when the doc has enough real text to anchor against (vs a scanned form). */
export function hasTextLayer(items: LabelItem[]): boolean {
  return items.filter((i) => i.str.trim().length > 1).length >= 8;
}

/** Find the best label match on a page: exact-normalized wins, else the shortest
 *  item that STARTS WITH the wanted label (avoids matching a long paragraph that
 *  merely contains the word). Returns null if nothing reasonable matches. */
export function findLabel(items: LabelItem[], label: string, page?: number): LabelItem | null {
  const want = norm(label);
  if (!want) return null;
  const pool = items.filter((i) => (page == null || i.page === page));
  let exact: LabelItem | null = null;
  let prefix: LabelItem | null = null;
  for (const it of pool) {
    const s = norm(it.str);
    if (s === want) { if (!exact || it.width < exact.width) exact = it; continue; }
    if (s.startsWith(want) && s.length <= want.length + 3) { if (!prefix || it.width < prefix.width) prefix = it; }
  }
  return exact || prefix;
}

export interface AnchorOpts {
  page: number;
  label: string;
  side?: "right" | "below" | "above";
  gap?: number; // points between label and value
  size?: number;
}

/** Resolve where to draw a value relative to its label.
 *  - "right" (default): value just after the label on the SAME baseline.
 *  - "above": value on the line ABOVE the label — for caption-under-line forms
 *    ("Print Name"/"City" printed beneath the blank).
 *  y comes from the label's real baseline, so no vertical float. */
export function anchorPlacement(items: LabelItem[], opts: AnchorOpts): { x: number; y: number } | null {
  const lbl = findLabel(items, opts.label, opts.page);
  if (!lbl) return null;
  const gap = opts.gap ?? 5;
  const lh = lbl.height || opts.size || 11;
  if (opts.side === "below") return { x: lbl.x, y: lbl.y - lh - 2 };
  if (opts.side === "above") return { x: lbl.x, y: lbl.y + lh + 3 };
  return { x: lbl.x + lbl.width + gap, y: lbl.y };
}

/** Letters and digits only — "E-mail:" and "Email:" read alike, "PROPERTY OWNER" and "Property Owner". */
const looseNorm = (s: string): string => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * WHICH PRINTED LABEL A MAPPED PLACEMENT BELONGS TO, near where the map put it. A flat form repeats
 * its labels ("Name:", "Address:", "Phone:" in the owner, contractor AND applicant blocks), and a
 * vision map names the repeat by its section ("Property Owner - Name:", "Required data: Valuation:"),
 * which no single text item prints. In order:
 *  1. the whole label (exact, or the short prefix findLabel accepts) — of several, the nearest the
 *     map's point;
 *  2. a section-qualified label: the section header item, then the NEAREST item printing the tail
 *     BELOW that header (within 160pt) — "Applicant - Name:" is the Name under APPLICANT, even when
 *     the map's y drifted into the Address row beneath it;
 *  3. the tail alone, nearest the map's point;
 *  4. a label-like item just LEFT of the map's point on its own line (±9pt).
 * null when nothing reasonable matches (the caller keeps the map's own point).
 */
export function resolvePlacementLabel(items: LabelItem[], label: string, page: number, point: { x: number; y: number }): LabelItem | null {
  const pool = items.filter((i) => i.page === page && i.str.trim());
  const near = (cands: LabelItem[]): LabelItem | null => cands.length
    ? [...cands].sort((a, b) => (Math.abs(a.y - point.y) + Math.abs(a.x - point.x) * 0.05) - (Math.abs(b.y - point.y) + Math.abs(b.x - point.x) * 0.05))[0]
    : null;
  const matches = (it: LabelItem, want: string): boolean => {
    const s = norm(it.str), w = norm(want);
    if (!w) return false;
    if (s === w || (s.startsWith(w) && s.length <= w.length + 3)) return true;
    const ls = looseNorm(it.str), lw = looseNorm(want);
    return Boolean(lw) && ls === lw;
  };
  const whole = pool.filter((it) => matches(it, label));
  if (whole.length) return near(whole);
  // "Section - Label" / "Section: Label" — the header, then the tail beneath it.
  const split = /^(.{3,60}?)\s*(?:\s[-–—]\s|:\s+)\s*(.{2,60})$/.exec(String(label || "").trim());
  if (split) {
    const [, head, tail] = split;
    const lh = looseNorm(head);
    const tails = pool.filter((it) => matches(it, tail));
    const headers = lh.length >= 3 ? pool.filter((it) => looseNorm(it.str).startsWith(lh)) : [];
    let best: { it: LabelItem; score: number } | null = null;
    for (const h of headers) {
      const under = tails.filter((t) => t.y < h.y - 1 && h.y - t.y <= 160).sort((a, b) => b.y - a.y)[0];
      if (!under) continue;
      const score = Math.abs(under.y - point.y);
      if (!best || score < best.score) best = { it: under, score };
    }
    if (best) return best.it;
    if (tails.length) return near(tails);
  }
  // A label-like item on the map point's own line, ending just left of it.
  const left = pool.filter((it) => Math.abs(it.y - point.y) <= 9 && it.x < point.x && it.x + it.width <= point.x + 8 && point.x - (it.x + it.width) <= 90);
  const labelish = left.filter((it) => /[:#?]\s*$/.test(it.str.trim()));
  return near(labelish.length ? labelish : left);
}

/** A label ending in ":" or "#" takes its value to the RIGHT; a bare caption
 *  ("Print Name") takes it ABOVE the caption (on the blank line). */
export function sideForLabel(labelStr: string): "right" | "above" {
  return /[:#]\s*$/.test(labelStr.trim()) ? "right" : "above";
}

// Candidate label strings per data key, most-specific first. Used to auto-place
// provided data (name, address, …) onto whatever labels a given AHJ form uses.
export const FIELD_SYNONYMS: Record<string, string[]> = {
  name: ["property owner name", "person requesting refund", "applicant name", "owner name", "printed name", "print name", "name of applicant", "homeowner name", "name"],
  // Project/install address (per-row). Deliberately NOT "mailing address" —
  // that's the requester's own address (boilerplate), a separate field/key.
  street: ["installation address", "project address", "property address", "site address", "street address"],
  mailingAddress: ["mailing address"],
  city: ["city"],
  state: ["state"],
  zip: ["zip code", "zip", "postal code"],
  phone: ["phone number", "phone no", "telephone", "phone", "contact number"],
  email: ["email address", "e-mail", "email"],
  permitNumber: ["permit number", "permit no", "permit #", "permit"],
  date: ["issue intake payment date", "date"],
  installer: ["contractorowneragent", "installer", "contractor name", "company name", "business name", "contractor"],
  // A refund reason: fills a "reason" field, OR the long narrative field many
  // refund forms use ("…my request meets the refund policy criteria…").
  reason: ["reason for refund", "reason for request", "reason", "meets the refund", "criteria as explained", "explained below"],
};

export interface AutoPlacement { page: number; x: number; y: number; text: string; size: number; label: string; key: string }

/** Given a form's text layer and a bag of data (name/street/city/…), find each
 *  value's label and compute its placement. Returns one placement per matched
 *  field; unmatched keys (the form has no such label) are skipped. Values land on
 *  the label's real baseline, so no vertical float. */
export function autoPlaceFromData(items: LabelItem[], data: Record<string, string>, size = 10): AutoPlacement[] {
  const out: AutoPlacement[] = [];
  for (const [key, value] of Object.entries(data)) {
    const v = (value ?? "").trim();
    if (!v) continue;
    const candidates = FIELD_SYNONYMS[key] ?? [key];
    let placed: AutoPlacement | null = null;
    for (const cand of candidates) {
      // Search every page; take the first (most-specific) candidate that matches.
      for (let page = 0; page < 1 + Math.max(0, ...items.map((i) => i.page)); page++) {
        const lbl = findLabel(items, cand, page);
        if (!lbl) continue;
        // "LABEL:" → value to the right; a bare caption → value on the line above.
        const p = anchorPlacement(items, { page, label: cand, side: sideForLabel(lbl.str), size });
        if (p) { placed = { page, x: p.x, y: p.y, text: v, size, label: lbl.str, key }; break; }
      }
      if (placed) break;
    }
    if (placed) out.push(placed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// WIDGET CAPTIONS. An AcroForm widget's NAME is often auto-generated from whatever text sat near
// it when somebody ran "detect form fields", and it is often shifted onto the neighbouring box:
// City of Waltham's residential application names the 2.2 Authorized Agent's EMAIL box
// "Telephone". The printed caption beside the box is what the applicant reads, so it is what the
// box IS. These helpers read it off the text layer by geometry only (no model, no project data).
// ---------------------------------------------------------------------------

/** A widget rectangle in PDF points, bottom-left origin (pdf-lib's getRectangle()). */
export interface WidgetRect { x: number; y: number; width: number; height: number }

/** The printed text around one widget, by side. Each is the nearest single text item there. */
export interface WidgetCaptions { left?: string; right?: string; below?: string; above?: string }

export type CaptionSide = "below" | "above" | "left" | "right";

/** How far (pt) above or below a box its caption may sit. Waltham's captions sit 8-13pt under. */
const CAPTION_REACH = 14;

const cleanCaption = (s: string): string => s.replace(/_{2,}/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);

/**
 * The nearest printed text on each side of a widget. Geometry only:
 *  - left / right: an item on the box's own line (baseline inside the box band) ending just left of
 *    it / starting just right of it;
 *  - below / above: an item within CAPTION_REACH under / over the box that starts where the box
 *    starts (left-aligned to its first half).
 */
export function captionsForRect(items: LabelItem[], page: number, r: WidgetRect): WidgetCaptions {
  const pool = items.filter((i) => i.page === page && cleanCaption(i.str));
  const top = r.y + r.height;
  const inBand = (i: LabelItem) => i.y >= r.y - 1 && i.y <= top - 1;
  const aligned = (i: LabelItem) => i.x >= r.x - 8 && i.x <= r.x + r.width * 0.5;
  const out: WidgetCaptions = {};
  const left = pool
    .filter((i) => inBand(i) && i.x < r.x - 1 && i.x + i.width <= r.x + 6 && r.x - (i.x + i.width) <= 120)
    .sort((a, b) => (b.x + b.width) - (a.x + a.width))[0];
  if (left) out.left = cleanCaption(left.str);
  const right = pool
    .filter((i) => inBand(i) && i.x >= r.x + r.width - 6 && i.x - (r.x + r.width) <= 60)
    .sort((a, b) => a.x - b.x)[0];
  if (right) out.right = cleanCaption(right.str);
  const below = pool
    .filter((i) => aligned(i) && i.y < r.y - 0.5 && i.y >= r.y - CAPTION_REACH)
    .sort((a, b) => b.y - a.y || Math.abs(a.x - r.x) - Math.abs(b.x - r.x))[0];
  if (below) out.below = cleanCaption(below.str);
  const above = pool
    .filter((i) => aligned(i) && i.y > top && i.y <= top + CAPTION_REACH)
    .sort((a, b) => a.y - b.y || Math.abs(a.x - r.x) - Math.abs(b.x - r.x))[0];
  if (above) out.above = cleanCaption(above.str);
  return out;
}

const CAPTION_STOP = new Set(["the", "and", "for", "undefined", "text", "field", "row", "box", "check", "of", "to", "be", "by"]);
const captionWords = (s: string): string[] =>
  String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 2 && !CAPTION_STOP.has(w));

/** Does a widget's (auto-generated) name say the same thing as a printed caption? */
export function captionAgreesWithName(name: string, caption: string | undefined): boolean {
  const c = captionWords(caption || "");
  const n = captionWords(name);
  if (!c.length || !n.length) return false;
  const ns = new Set(n);
  const cs = new Set(c);
  return c.every((w) => ns.has(w)) || n.every((w) => cs.has(w));
}

/**
 * Which side of its boxes THIS form prints captions on. A caption-under form (Waltham) and a
 * caption-over form look alike box by box — in a dense form the text 9pt under one box is 9pt
 * over the next — so a single box cannot say. The form as a whole can: most auto-generated
 * widget names were taken from the real caption, so the side the most names AGREE with is the
 * form's convention (Waltham: 14 names agree with the text below their box, 8 above, 7 left).
 * null when no side wins clearly (at least 2 agreements and strictly more than the runner-up) —
 * then no caption is treated as THE caption and the name stands.
 */
export function calibrateCaptionSide(widgets: Array<{ name: string; captions?: WidgetCaptions }>): CaptionSide | null {
  const sides: CaptionSide[] = ["below", "above", "left", "right"];
  const counts = sides.map((side) => ({ side, n: widgets.filter((w) => captionAgreesWithName(w.name, w.captions?.[side])).length }))
    .sort((a, b) => b.n - a.n);
  if (counts[0].n < 2 || counts[0].n <= counts[1].n) return null;
  return counts[0].side;
}

/** THE printed caption of a text widget: the form's calibrated side, else the text on its own
 *  line to the left (an inline "Label: [____]"), else "" (unknown — the name stands). */
export function primaryCaption(captions: WidgetCaptions | undefined, side: CaptionSide | null): string {
  if (!captions) return "";
  if (side && captions[side]) return captions[side] as string;
  return side === "left" ? "" : captions.left || "";
}

export interface CheckboxOpts {
  page: number;
  anchor: string; // the word next to the box, e.g. "Yes" / "No"
  /** Baseline of the QUESTION's answer row. Repeated Yes/No captions must be
   *  constrained to a row; a page-wide first match can attest the wrong item. */
  rowY?: number;
  rowTolerance?: number;
  /** Distance LEFT of the anchor word where the box sits. The box is a drawn
   *  rectangle (not text), so this is estimated from the label; tune per form. */
  boxGap?: number;
  size?: number;
}

/** Place a check mark on the box beside an anchor word (e.g. the "Yes" box on a
 *  prescriptive checklist). Approximate — the box isn't in the text layer — but
 *  anchored to the real word position, so far better than a blind coordinate. */
export function checkboxPlacement(items: LabelItem[], opts: CheckboxOpts): { x: number; y: number } | null {
  const matches = items.filter((i) => i.page === opts.page && norm(i.str) === norm(opts.anchor)
    && (opts.rowY == null || Math.abs(i.y - opts.rowY) <= (opts.rowTolerance ?? 2)));
  // Never silently pick the first Yes on a checklist, even if no row was given.
  if (matches.length !== 1) return null;
  const a = matches[0];
  const gap = opts.boxGap ?? 12;
  return { x: a.x - gap, y: a.y };
}
