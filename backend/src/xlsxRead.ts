// ---------------------------------------------------------------------------
// Minimal .xlsx reader — no new dependency. An xlsx is a zip of XML; adm-zip is
// already a project dependency (bundle.zip, doc splitting), so we read the zip
// entries and parse the small amount of XML we need (shared strings + each
// sheet's cells) with regex. Enough for the flat reference spreadsheets we
// import (AHJ codes, utility NEM, township restrictions) — NOT a general xlsx
// engine (ignores formulas, styles, merged cells, dates-as-numbers).
// ---------------------------------------------------------------------------

import AdmZip from "adm-zip";

export interface SheetData {
  name: string;
  /** Header row (first non-empty row), trimmed. */
  headers: string[];
  /** Data rows as objects keyed by header text (blank/duplicate headers keyed by col index). */
  rows: Record<string, string>[];
}

function xmlEntry(zip: AdmZip, name: string): string {
  const e = zip.getEntry(name);
  return e ? e.getData().toString("utf8") : "";
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

function sharedStrings(zip: AdmZip): string[] {
  const xml = xmlEntry(zip, "xl/sharedStrings.xml");
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("");
    out.push(decode(text));
  }
  return out;
}

// "AB" (1-based column letters) → 0-based index.
function colIndex(ref: string): number {
  const letters = (ref.match(/^[A-Z]+/) || ["A"])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetTargets(zip: AdmZip): { name: string; target: string }[] {
  const wb = xmlEntry(zip, "xl/workbook.xml");
  const rels = xmlEntry(zip, "xl/_rels/workbook.xml.rels");
  const relMap: Record<string, string> = {};
  for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]*)"/g)) relMap[m[1]] = m[2];
  const out: { name: string; target: string }[] = [];
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"/g)) {
    const target = relMap[m[2]] || "";
    if (target) out.push({ name: decode(m[1]), target: target.replace(/^\/?xl\//, "").replace(/^\//, "") });
  }
  return out;
}

function readRows(zip: AdmZip, target: string, ss: string[]): string[][] {
  const xml = xmlEntry(zip, `xl/${target}`);
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: Record<number, string> = {};
    let max = -1;
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+\d+)"(?:[^>]*t="([^"]*)")?[^>]*>([\s\S]*?)<\/c>/g)) {
      const idx = colIndex(cm[1]);
      max = Math.max(max, idx);
      const type = cm[2];
      const vTag = cm[3].match(/<v>([\s\S]*?)<\/v>/);
      const tTag = cm[3].match(/<t[^>]*>([\s\S]*?)<\/t>/);
      let value = "";
      if (type === "s" && vTag) value = ss[Number(vTag[1])] ?? "";
      else if (type === "inlineStr" && tTag) value = decode(tTag[1]);
      else if (vTag) value = vTag[1];
      cells[idx] = value.trim();
    }
    const arr: string[] = [];
    for (let i = 0; i <= max; i++) arr.push(cells[i] ?? "");
    rows.push(arr);
  }
  return rows;
}

/** Read every sheet in an xlsx buffer into header-keyed row objects. */
export function readXlsx(buffer: Buffer): SheetData[] {
  const zip = new AdmZip(buffer);
  const ss = sharedStrings(zip);
  const out: SheetData[] = [];
  for (const { name, target } of sheetTargets(zip)) {
    const raw = readRows(zip, target, ss);
    const nonEmpty = raw.filter((r) => r.some((c) => c !== ""));
    if (!nonEmpty.length) { out.push({ name, headers: [], rows: [] }); continue; }
    const headers = nonEmpty[0].map((h, i) => (h && h.trim() ? h.trim() : `col${i}`));
    const rows: Record<string, string>[] = [];
    for (const r of nonEmpty.slice(1)) {
      if (!r.some((c) => c !== "")) continue;
      const obj: Record<string, string> = {};
      // Rows can be wider than the header row (e.g. a one-cell title row above
      // the real headers) — keep overflow columns keyed by index so downstream
      // header-detection (findHeaderedRows) can still see the full row.
      const width = Math.max(headers.length, r.length);
      for (let i = 0; i < width; i++) {
        const h = headers[i] ?? `col${i}`;
        const key = obj[h] !== undefined ? `${h}__${i}` : h; // keep duplicate headers distinct
        obj[key] = r[i] ?? "";
      }
      rows.push(obj);
    }
    out.push({ name, headers, rows });
  }
  return out;
}

/** Case/space-insensitive header lookup: returns the first row value whose header
 *  matches any of the candidate names (loosely). */
export function pick(row: Record<string, string>, ...candidates: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const wanted = candidates.map(norm);
  for (const [key, value] of Object.entries(row)) {
    const nk = norm(key.replace(/__\d+$/, ""));
    if (wanted.some((w) => nk === w || nk.startsWith(w))) {
      if (value && value.trim()) return value.trim();
    }
  }
  return "";
}
