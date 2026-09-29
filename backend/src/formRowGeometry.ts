// ---------------------------------------------------------------------------
// THE ROWS A FLAT FORM PRINTS. A flat (non-AcroForm) permit application is a ruled table: a label,
// then the rest of its row to write in, the row closed by a printed rule; section headers are
// shaded bands ("JOB SITE INFORMATION AND LOCATION", "DESCRIPTION OF WORK"). A vision map's y is an
// estimate that drifts a few points — on Yamhill County's building application (live, 2026-09-28)
// values sat ON the row's rule (struck through), the job-site address was drawn over a header band,
// and the description of work landed in the "Tax map/parcel no" row while its three blank rows
// stayed empty.
//
// This module reads the page's own drawing (pdfjs operator list — no rendering, no model): the
// horizontal and vertical rules and the shaded bands, and places a value INSIDE the row its label
// sits in (rowSnapPlacement). Geometry and printed text only; an uncertain reading returns null and
// the caller keeps the map's own position (never worse than before).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { LabelItem } from "./formTextLayer";

/** A horizontal rule (a stroked line, a hairline filled rectangle, or a band's edge). */
export interface HRule { page: number; y: number; yTop: number; yBottom: number; x0: number; x1: number; band?: boolean }
/** A vertical rule (a cell divider). */
export interface VRule { page: number; x: number; y0: number; y1: number }
/** A filled, non-white rectangle. `header` = it carries printed header text (see headerBands). */
export interface Band { page: number; x0: number; y0: number; x1: number; y1: number; luma: number }
export interface PageGeometry { page: number; width: number; height: number; hRules: HRule[]; vRules: VRule[]; bands: Band[] }

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** A rule is at most this thick; a filled rectangle thicker than this is a band (or a box). */
const RULE_MAX_THICKNESS = 2.5;
/** Shorter horizontal strokes are checkbox edges and glyph pieces, not rows. */
const RULE_MIN_LENGTH = 12;

/** Luma (0..1) of a pdfjs fill colour: "#rrggbb", or an [r,g,b] 0-255 array. null when unknown. */
function lumaOf(color: unknown): number | null {
  let r: number, g: number, b: number;
  if (typeof color === "string") {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color);
    if (!m) return null;
    [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  } else if (color && typeof (color as ArrayLike<number>).length === "number" && (color as ArrayLike<number>).length >= 3) {
    const c = color as ArrayLike<number>;
    [r, g, b] = [Number(c[0]), Number(c[1]), Number(c[2])];
  } else return null;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Sub-paths of a pdfjs DrawOPS path (moveTo 0, lineTo 1, curveTo 2, quadraticCurveTo 3, closePath 4),
 *  as point lists in device-independent user space (CTM applied). A sub-path with a curve is marked. */
function subPaths(data: ArrayLike<number>, m: Mat): Array<{ pts: Array<[number, number]>; closed: boolean; curved: boolean }> {
  const out: Array<{ pts: Array<[number, number]>; closed: boolean; curved: boolean }> = [];
  let cur: { pts: Array<[number, number]>; closed: boolean; curved: boolean } | null = null;
  for (let i = 0; i < data.length;) {
    const op = data[i++];
    if (op === 0) { cur = { pts: [apply(m, data[i++], data[i++])], closed: false, curved: false }; out.push(cur); }
    else if (op === 1) { const p = apply(m, data[i++], data[i++]); if (cur) cur.pts.push(p); }
    else if (op === 2) { i += 4; const p = apply(m, data[i++], data[i++]); if (cur) { cur.pts.push(p); cur.curved = true; } }
    else if (op === 3) { i += 2; const p = apply(m, data[i++], data[i++]); if (cur) { cur.pts.push(p); cur.curved = true; } }
    else if (op === 4) { if (cur) cur.closed = true; }
    else break;
  }
  return out;
}

/** Group items whose `key` lies within 0.8pt of the group's first (sorted by key). */
function clusters<T>(items: T[], key: (t: T) => number): T[][] {
  const out: T[][] = [];
  for (const it of [...items].sort((a, b) => key(a) - key(b))) {
    const c = out[out.length - 1];
    if (c && Math.abs(key(c[0]) - key(it)) <= 0.8) c.push(it); else out.push([it]);
  }
  return out;
}
/** Merge collinear horizontal pieces (a table's bottom border is often one segment per cell, and the
 *  left column's rule can sit 0.4pt off the right column's): same line within 0.8pt, touching within 2pt. */
function mergeH(rules: HRule[]): HRule[] {
  const out: HRule[] = [];
  for (const band of [false, true]) {
    for (const c of clusters(rules.filter((r) => !!r.band === band), (r) => r.y)) {
      let cur: HRule | null = null;
      for (const r of [...c].sort((a, b) => a.x0 - b.x0)) {
        if (cur && r.x0 <= cur.x1 + 2) {
          cur.x1 = Math.max(cur.x1, r.x1);
          cur.yTop = Math.max(cur.yTop, r.yTop);
          cur.yBottom = Math.min(cur.yBottom, r.yBottom);
          continue;
        }
        cur = { ...r };
        out.push(cur);
      }
    }
  }
  return out;
}
function mergeV(rules: VRule[]): VRule[] {
  const out: VRule[] = [];
  for (const c of clusters(rules, (r) => r.x)) {
    let cur: VRule | null = null;
    for (const r of [...c].sort((a, b) => a.y0 - b.y0)) {
      if (cur && r.y0 <= cur.y1 + 2) { cur.y1 = Math.max(cur.y1, r.y1); continue; }
      cur = { ...r };
      out.push(cur);
    }
  }
  return out;
}

const cache = new Map<string, PageGeometry[]>();
const CACHE_MAX = 24;

/**
 * Every page's rules and bands, read once per blank (cached by the blank's sha256). [] on any
 * failure — the caller then places values exactly as before.
 */
export async function extractPageGeometry(pdfBytes: Uint8Array): Promise<PageGeometry[]> {
  const key = createHash("sha256").update(pdfBytes).digest("hex");
  const hit = cache.get(key);
  if (hit) return hit;
  let pages: PageGeometry[] = [];
  try {
    const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true }).promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const ol = await page.getOperatorList();
      const hRules: HRule[] = [];
      const vRules: VRule[] = [];
      const bands: Band[] = [];
      const stack: Array<{ m: Mat; fill: unknown; lw: number }> = [];
      let state = { m: IDENTITY as Mat, fill: "#000000" as unknown, lw: 1 };
      const pageIndex = n - 1;
      const addStrokeSeg = (a: [number, number], b: [number, number], lw: number) => {
        const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
        const half = Math.max(0.25, lw / 2);
        if (dy <= 0.8 && dx >= RULE_MIN_LENGTH) {
          const y = (a[1] + b[1]) / 2;
          hRules.push({ page: pageIndex, y, yTop: y + half, yBottom: y - half, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]) });
        } else if (dx <= 0.8 && dy >= 8) {
          vRules.push({ page: pageIndex, x: (a[0] + b[0]) / 2, y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
        }
      };
      for (let i = 0; i < ol.fnArray.length; i++) {
        const fn = ol.fnArray[i];
        const args = ol.argsArray[i] as unknown[];
        if (fn === OPS.save) { stack.push({ ...state }); continue; }
        if (fn === OPS.restore) { state = stack.pop() ?? state; continue; }
        if (fn === OPS.transform) { state = { ...state, m: mul(args as unknown as Mat, state.m) }; continue; }
        if (fn === OPS.paintFormXObjectBegin) {
          stack.push({ ...state });
          const fm = args?.[0] as ArrayLike<number> | null;
          if (fm && fm.length === 6) state = { ...state, m: mul(Array.from(fm) as Mat, state.m) };
          continue;
        }
        if (fn === OPS.paintFormXObjectEnd) { state = stack.pop() ?? state; continue; }
        if (fn === OPS.setFillRGBColor) { state = { ...state, fill: args?.[0] }; continue; }
        if (fn === OPS.setFillGray) { const g = Number(args?.[0]); state = { ...state, fill: [g * 255, g * 255, g * 255] }; continue; }
        if (fn === OPS.setLineWidth) { state = { ...state, lw: Number(args?.[0]) || 0 }; continue; }
        if (fn !== OPS.constructPath) continue;
        const paint = Number(args?.[0]);
        const data = (args?.[1] as ArrayLike<number>[] | undefined)?.[0];
        if (!data || typeof data.length !== "number") continue;
        const isFill = paint === OPS.fill || paint === OPS.eoFill || paint === OPS.fillStroke || paint === OPS.eoFillStroke || paint === OPS.closeFillStroke || paint === OPS.closeEOFillStroke;
        const isStroke = paint === OPS.stroke || paint === OPS.closeStroke || paint === OPS.fillStroke || paint === OPS.eoFillStroke || paint === OPS.closeFillStroke || paint === OPS.closeEOFillStroke;
        if (!isFill && !isStroke) continue;
        // The stroke width in page units: the CTM's scale on the line width.
        const scale = Math.sqrt(Math.abs(state.m[0] * state.m[3] - state.m[1] * state.m[2])) || 1;
        for (const sp of subPaths(data, state.m)) {
          if (sp.curved || sp.pts.length < 2) continue;
          const xs = sp.pts.map((p) => p[0]), ys = sp.pts.map((p) => p[1]);
          const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
          const w = x1 - x0, h = y1 - y0;
          if (isFill) {
            if (h <= RULE_MAX_THICKNESS && w >= RULE_MIN_LENGTH) {
              hRules.push({ page: pageIndex, y: (y0 + y1) / 2, yTop: y1, yBottom: y0, x0, x1 });
            } else if (w <= RULE_MAX_THICKNESS && h >= 8) {
              vRules.push({ page: pageIndex, x: (x0 + x1) / 2, y0, y1 });
            } else if (w >= 20 && h > RULE_MAX_THICKNESS && w * h < 0.5 * vp.width * vp.height) {
              const luma = lumaOf(state.fill);
              if (luma != null && luma < 0.94) {
                bands.push({ page: pageIndex, x0, y0, x1, y1, luma });
                hRules.push({ page: pageIndex, y: y1, yTop: y1, yBottom: y1, x0, x1, band: true });
                hRules.push({ page: pageIndex, y: y0, yTop: y0, yBottom: y0, x0, x1, band: true });
              }
            }
          }
          if (isStroke) {
            const pts = sp.closed ? [...sp.pts, sp.pts[0]] : sp.pts;
            for (let k = 1; k < pts.length; k++) addStrokeSeg(pts[k - 1], pts[k], state.lw * scale);
          }
        }
      }
      pages.push({ page: pageIndex, width: vp.width, height: vp.height, hRules: mergeH(hRules), vRules: mergeV(vRules), bands });
    }
    try { await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.(); } catch { /* best effort */ }
  } catch {
    pages = [];
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, pages);
  return pages;
}

// ---------------------------------------------------------------------------
// ROW SNAP — where a value goes inside the row its label (or the map's point) names.
// ---------------------------------------------------------------------------

/** Cap height and descent of Helvetica, as a fraction of the font size. */
const CAP = 0.72;
const DESC = 0.22;
/** A value's baseline sits this far above its row's bottom rule (2-3pt; the label's own baseline
 *  within that range is kept, so value and label read on one line). */
const BASE_MIN = 2;
const BASE_MAX = 3;
const MIN_SIZE = 6;
/** A row narrower than this right of its label has no room for a value there. */
const MIN_ROOM = 24;

const endsLikeLabel = (s: string): boolean => /[:#]\s*$/.test(String(s || "").trim());

/**
 * THE SHADED HEADER BANDS of a page: a filled non-white rectangle that carries printed text, none
 * of it a "Label:" (a shaded row holding "Name:" is a row, not a header; a shaded box with no text
 * is an input area). A value is never drawn inside one.
 */
export function headerBands(g: PageGeometry, items: LabelItem[]): Band[] {
  return g.bands.filter((b) => {
    const inside = items.filter((it) => it.page === g.page && it.y >= b.y0 - 1 && it.y <= b.y1 && it.x >= b.x0 - 2 && it.x < b.x1);
    return inside.length > 0 && !inside.some((it) => endsLikeLabel(it.str));
  });
}

const covers = (r: { x0: number; x1: number }, x: number): boolean => r.x0 - 2 <= x && r.x1 + 2 >= x;

/** The highest rule whose top lies in [y - reach, y + slack], under x. */
function ruleUnder(g: PageGeometry, y: number, x: number, reach: number, slack: number): HRule | null {
  return g.hRules.filter((r) => covers(r, x) && r.yTop <= y + slack && r.yTop >= y - reach).sort((a, b) => b.yTop - a.yTop)[0] ?? null;
}
/** The lowest rule whose bottom lies in [y + minGap, y + maxGap], over x. */
function ruleOver(g: PageGeometry, y: number, x: number, minGap: number, maxGap: number): HRule | null {
  return g.hRules.filter((r) => covers(r, x) && r.yBottom >= y + minGap && r.yBottom <= y + maxGap).sort((a, b) => a.yBottom - b.yBottom)[0] ?? null;
}

const intersects = (a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }): boolean =>
  a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

export interface SnapLine { text: string; x: number; y: number; size: number }
export interface SnapResult { lines: SnapLine[]; how: "row" | "rows-below" | "above-line" | "point-row"; truncated: boolean }
export interface SnapInput {
  geometry: PageGeometry;
  /** The page's printed text (formTextLayer.extractLabels; other pages are ignored). */
  items: LabelItem[];
  /** The printed label the value belongs to (resolvePlacementLabel), or null: then the row is the
   *  one the map's own point sits in (a verified map, or a label not found). */
  label: LabelItem | null;
  /** The map's own position (text start x, baseline y). */
  point: { x: number; y: number };
  text: string;
  size: number;
  widthOf: (text: string, size: number) => number;
}

/** The largest size <= start (min 6) at which `text` fits `width`; `fits` false when even 6 does not. */
function fitSize(text: string, width: number, start: number, widthOf: SnapInput["widthOf"]): { size: number; fits: boolean } {
  let s = Math.max(MIN_SIZE, start);
  while (s > MIN_SIZE && widthOf(text, s) > width) s = Math.max(MIN_SIZE, s - 0.25);
  return { size: s, fits: widthOf(text, s) <= width };
}
/** Cut `text` to what fits `width` at `size`. */
function cut(text: string, width: number, size: number, widthOf: SnapInput["widthOf"]): string {
  let t = text;
  while (t.length > 1 && widthOf(t, size) > width) t = t.slice(0, -1);
  return t.trimEnd();
}
/** Greedy word wrap at one size. */
function wrap(text: string, width: number, size: number, widthOf: SnapInput["widthOf"]): string[] {
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || widthOf(next, size) <= width) { cur = next; continue; }
    lines.push(cur);
    cur = w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Where the free part of a row ends, right of xStart: the next printed text on the row, the next
 *  vertical rule crossing it, the row's own rule end, the page margin. */
function rowEnd(g: PageGeometry, items: LabelItem[], xStart: number, bottom: number, top: number, ruleEnd: number): number {
  const mid = (bottom + top) / 2;
  let end = Math.min(ruleEnd - 2, g.width - 18);
  for (const v of g.vRules) if (v.x > xStart + 1 && v.y0 <= mid && v.y1 >= mid) end = Math.min(end, v.x - 2);
  for (const it of items) if (it.page === g.page && it.y > bottom && it.y < top && it.x > xStart + 1) end = Math.min(end, it.x - 4);
  return end;
}

/**
 * Place a value INSIDE its row. Modes, in order:
 *  - the label sits inside a shaded HEADER band ("DESCRIPTION OF WORK") → the blank rows stacked
 *    under the band, the text wrapped across them;
 *  - the label has a rule tight under it (a ruled row) → the same row, right of the label, baseline
 *    2-3pt above the rule, shrunk (min 6pt) to the room before the next text / cell divider; a row
 *    with no room right of its label → the blank rows under it;
 *  - a bare caption with a rule just above it (caption-under-line) → on that line;
 *  - no label → the row the map's point sits in (x kept).
 * Never crosses a rule, never inside a header band. null when no sane row is found — the caller
 * keeps the map's own position.
 */
export function rowSnapPlacement(input: SnapInput): SnapResult | null {
  const { geometry: g, label: L, point, widthOf } = input;
  const items = input.items.filter((it) => it.page === g.page);
  const text = String(input.text || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const size0 = input.size > 0 ? input.size : 9;
  const headers = headerBands(g, items);
  const clear = (lines: SnapLine[]): boolean => lines.every((l) => {
    const box = { x0: l.x, y0: l.y - DESC * l.size, x1: l.x + widthOf(l.text, l.size), y1: l.y + CAP * l.size };
    return !headers.some((b) => intersects(box, b));
  });
  const done = (lines: SnapLine[], how: SnapResult["how"], truncated: boolean): SnapResult | null => (clear(lines) ? { lines, how, truncated } : null);

  /** One line in a row [bottom rule, top], from xStart to xEnd. */
  const inRow = (bottom: HRule, top: number, xStart: number, xEnd: number, preferY: number | null, how: SnapResult["how"]): SnapResult | null => {
    const room = xEnd - xStart;
    if (room < MIN_ROOM) return null;
    const y = preferY != null ? Math.min(bottom.yTop + BASE_MAX, Math.max(bottom.yTop + BASE_MIN, preferY)) : bottom.yTop + (BASE_MIN + BASE_MAX) / 2;
    const byHeight = (top - y - 0.5) / CAP;
    if (byHeight < MIN_SIZE) return null;
    const fit = fitSize(text, room, Math.min(size0, byHeight), widthOf);
    const t = fit.fits ? text : cut(text, room, fit.size, widthOf);
    return done([{ text: t, x: xStart, y, size: fit.size }], how, !fit.fits);
  };

  /** The blank rows stacked under startY (a header band's bottom, a full label row), within [x0, x1]. */
  const rowsBelow = (startY: number, x0: number, x1: number): SnapResult | null => {
    const probe = [x0 + 10, (x0 + x1) / 2];
    const spans = (r: HRule) => probe.every((x) => covers(r, x));
    const rows: Array<{ bottom: number; top: number }> = [];
    let cur = startY;
    for (let k = 0; k < 8; k++) {
      const top = Math.min(cur, ...g.hRules.filter((r) => spans(r) && r.yBottom <= cur + 0.5 && r.yBottom >= cur - 6).map((r) => r.yBottom));
      const next = g.hRules.filter((r) => spans(r) && r.yTop < top - 6 && r.yTop >= top - 40).sort((a, b) => b.yTop - a.yTop)[0];
      if (!next) break;
      const bottom = next.yTop;
      if (items.some((it) => it.y > bottom && it.y < top && it.x + Math.max(1, it.width) > x0 && it.x < x1)) break;
      if (headers.some((b) => intersects({ x0, y0: bottom, x1, y1: top }, b))) break;
      rows.push({ bottom, top });
      cur = next.yBottom;
    }
    if (!rows.length) return null;
    const width = x1 - x0 - 8;
    if (width < MIN_ROOM) return null;
    const minH = Math.min(...rows.map((r) => r.top - r.bottom));
    let s = Math.min(size0, (minH - (BASE_MIN + BASE_MAX) / 2 - 0.5) / CAP);
    if (s < MIN_SIZE) return null;
    let lines = wrap(text, width, s, widthOf);
    while ((lines.length > rows.length || lines.some((l) => widthOf(l, s) > width)) && s > MIN_SIZE) {
      s = Math.max(MIN_SIZE, s - 0.25);
      lines = wrap(text, width, s, widthOf);
    }
    let truncated = false;
    if (lines.length > rows.length) {
      truncated = true;
      lines = lines.slice(0, rows.length);
    }
    lines = lines.map((l) => {
      if (widthOf(l, s) <= width) return l;
      truncated = true;
      return cut(l, width, s, widthOf);
    });
    return done(lines.map((l, i) => ({ text: l, x: x0 + 4, y: rows[i].bottom + (BASE_MIN + BASE_MAX) / 2, size: s })), "rows-below", truncated);
  };

  if (L) {
    const lh = L.height > 0 ? L.height : size0;
    const band = headers.find((b) => L.y >= b.y0 - 1 && L.y <= b.y1 && L.x >= b.x0 - 2 && L.x < b.x1);
    if (band) return rowsBelow(band.y0, band.x0, band.x1);
    const under = ruleUnder(g, L.y, L.x + 1, 7, 0.5);
    if (under) {
      const over = ruleOver(g, L.y, L.x + 1, Math.max(4, 0.6 * lh), 40);
      const top = over ? over.yBottom : L.y + lh + 4;
      const xStart = L.x + L.width + 4;
      const xEnd = rowEnd(g, items, xStart, under.yTop, top, over ? Math.min(under.x1, over.x1) : under.x1);
      if (xEnd - xStart >= MIN_ROOM) return inRow(under, top, xStart, xEnd, L.y, "row");
      return rowsBelow(under.yBottom, under.x0, under.x1);
    }
    if (!endsLikeLabel(L.str)) {
      // A bare caption printed under its writing line.
      const line = ruleOver(g, L.y, L.x + 1, 0.4 * lh, lh + 8);
      if (!line) return null;
      const xStart = L.x;
      const above = ruleOver(g, line.yTop, xStart + 1, 4, 40);
      const top = above ? above.yBottom : line.yTop + size0 + 6;
      const xEnd = rowEnd(g, items, xStart, line.yTop, top, line.x1);
      return inRow(line, top, xStart, xEnd, null, "above-line");
    }
    return null;
  }
  // No label: the row the map's own point sits in. A baseline drawn ON a rule belongs to the row
  // above it (the text sits on the line), so the rule's bottom edge may be up to 1pt over the point.
  const under = g.hRules.filter((r) => covers(r, point.x) && r.yBottom <= point.y + 1 && r.yTop >= point.y - 14).sort((a, b) => b.yTop - a.yTop)[0];
  if (!under) return null;
  const over = ruleOver(g, under.yTop, point.x, 6, 40);
  if (!over) return null;
  // Never over the row's own printed text: a point that starts on a label starts after it.
  let xStart = point.x;
  for (const it of [...items].sort((a, b) => a.x - b.x)) {
    if (it.y > under.yTop && it.y < over.yBottom && it.x <= xStart + 1 && it.x + it.width >= xStart - 1) xStart = Math.max(xStart, it.x + it.width + 4);
  }
  const xEnd = rowEnd(g, items, xStart, under.yTop, over.yBottom, Math.min(under.x1, over.x1));
  return inRow(under, over.yBottom, xStart, xEnd, point.y, "point-row");
}
