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
