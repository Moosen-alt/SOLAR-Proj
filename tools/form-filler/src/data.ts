// Data-row loading: CSV (quote-aware, no dependency) or a JSON array of objects.
import fs from "node:fs";
import type { DataRow } from "./types";

/** Minimal RFC-4180-style CSV parser: quoted fields, "" escapes, CRLF/CR/LF,
 *  commas and newlines inside quotes. Drops fully-empty rows. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      // A quote only opens a quoted field at the START of a field; a stray
      // quote mid-field (e.g. 2" pipe) is a literal character, not a delimiter.
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = ""; rows.push(row); row = [];
    } else if (c === "\r") {
      row.push(field); field = ""; rows.push(row); row = [];
      if (text[i + 1] === "\n") i++;
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export interface LoadedRows {
  headers: string[];
  rows: DataRow[];
}

/** Load rows from a .csv (first row = headers) or .json (array of objects). */
export function loadRows(filePath: string): LoadedRows {
  const text = fs.readFileSync(filePath, "utf8");
  if (filePath.toLowerCase().endsWith(".json")) {
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // tolerate a UTF-8 BOM
    let parsed: unknown;
    try {
      parsed = JSON.parse(clean);
    } catch (err) {
      throw new Error(`${filePath}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${filePath}: JSON data must be an array of objects (one object per form to fill).`);
    }
    if (parsed.length === 0) {
      throw new Error(`${filePath}: JSON array is empty (no rows to fill).`);
    }
    const headers = new Set<string>();
    const rows: DataRow[] = parsed.map((item, i) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`${filePath}: entry ${i} is not an object.`);
      }
      const row: DataRow = {};
      for (const [k, v] of Object.entries(item)) {
        row[k] = v == null ? "" : String(v);
        headers.add(k);
      }
      return row;
    });
    return { headers: [...headers], rows };
  }
  const grid = parseCsv(text);
  if (grid.length === 0) throw new Error(`${filePath}: no rows found.`);
  const headers = grid[0].map((h) => h.trim());
  const rows = grid.slice(1).map((cells) => {
    const row: DataRow = {};
    headers.forEach((h, i) => { if (h) row[h] = (cells[i] ?? "").trim(); });
    return row;
  });
  if (rows.length === 0) throw new Error(`${filePath}: header row found but no data rows.`);
  return { headers: headers.filter(Boolean), rows };
}

/** Render an output filename from a template with {Column} placeholders
 *  (case/punctuation-insensitive) and {n} for the 1-based row number. */
export function renderName(template: string, row: DataRow, index: number): string {
  const rendered = template
    .replace(/\{n\}/g, String(index + 1).padStart(3, "0"))
    .replace(/\{([^{}]+)\}/g, (_m, key: string) => {
      // Lazy import avoided: inline the same normalization as engine.rowValue.
      if (Object.prototype.hasOwnProperty.call(row, key)) return String(row[key] ?? "");
      const want = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      for (const [k, v] of Object.entries(row)) {
        if (k.toLowerCase().replace(/[^a-z0-9]/g, "") === want) return String(v ?? "");
      }
      return "";
    });
  return sanitizeFilename(rendered);
}

export function sanitizeFilename(name: string): string {
  let out = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (out.length > 120) out = out.slice(0, 120);
  out = out.replace(/^[. ]+|[. ]+$/g, "");
  if (!out) out = "filled";
  if (!out.toLowerCase().endsWith(".pdf")) out += ".pdf";
  return out;
}
