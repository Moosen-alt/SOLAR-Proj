// The fill engine: takes blank-PDF bytes + a FormMap + one data row, returns
// filled-PDF bytes. Adapted from backend/src/ahjForms.ts fillLoadedForm, with
// the project/client/snapshot context replaced by a flat data row. No network,
// no database, no environment coupling beyond the optional nudge knobs.
import {
  PDFDocument,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  rgb,
} from "pdf-lib";
import type { DataRow, FieldSource, FillOptions, FillResult, FormMap } from "./types";

/** Normalize a column/field name for fuzzy matching: lowercase, alnum only. */
export function normalizeName(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function todayString(override?: string): string {
  if (override) return override;
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

/** Case/punctuation-insensitive row lookup. Exact key always wins. */
export function rowValue(row: DataRow, key: string): string {
  if (Object.prototype.hasOwnProperty.call(row, key)) return String(row[key] ?? "");
  const want = normalizeName(key);
  if (!want) return "";
  for (const [k, v] of Object.entries(row)) {
    if (normalizeName(k) === want) return String(v ?? "");
  }
  return "";
}

export function resolveSource(source: FieldSource, row: DataRow, today?: string): string {
  if (!source) return "";
  if (source.startsWith("lit:")) return source.slice(4);
  const dot = source.indexOf(".");
  if (dot < 0) return "";
  const scope = source.slice(0, dot);
  const key = source.slice(dot + 1);
  if (scope === "row") return rowValue(row, key);
  if (scope === "computed") {
    if (key === "today") return todayString(today);
    return "";
  }
  return "";
}

function checkboxOn(rule: { source: FieldSource; equals?: string }, row: DataRow, today?: string): boolean {
  const value = resolveSource(rule.source, row, today);
  if (rule.equals != null) return value.trim().toLowerCase() === rule.equals.trim().toLowerCase();
  const v = value.trim().toLowerCase();
  return Boolean(v) && v !== "0" && v !== "false" && v !== "no" && v !== "n";
}

// Stamp the provided signature image at every placement; write today's date on
// adjacent date lines. Bad coordinates (NaN/Infinity) skip the placement rather
// than aborting the whole fill.
async function drawSignatures(
  doc: PDFDocument,
  placements: FormMap["signatureFields"],
  sig: FillOptions["signature"],
  today?: string,
): Promise<number> {
  if (!placements?.length || !sig) return 0;
  const pages = doc.getPages();
  let img;
  try {
    img = sig.mime.includes("jpeg") || sig.mime.includes("jpg")
      ? await doc.embedJpg(sig.bytes)
      : await doc.embedPng(sig.bytes);
  } catch {
    return 0;
  }
  let dateFont;
  let drawn = 0;
  for (const pl of placements) {
    const page = pages[pl.page];
    if (!page) continue;
    if (!Number.isFinite(pl.x) || !Number.isFinite(pl.y)) continue;
    const boxW = Number.isFinite(pl.width) && pl.width > 0 ? pl.width : 130;
    const boxH = Number.isFinite(pl.height) && pl.height > 0 ? pl.height : 34;
    const scale = Math.min(boxW / img.width, boxH / img.height) || 1;
    page.drawImage(img, { x: pl.x, y: pl.y, width: img.width * scale, height: img.height * scale });
    drawn += 1;
    if (pl.dateX != null && pl.dateY != null && Number.isFinite(pl.dateX) && Number.isFinite(pl.dateY)) {
      if (!dateFont) dateFont = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText(todayString(today), {
        x: pl.dateX,
        y: pl.dateY,
        size: pl.dateSize ?? 9,
        font: dateFont,
        color: rgb(0, 0, 0),
      });
    }
  }
  return drawn;
}

/** Fill one blank PDF from one data row. */
export async function fillPdf(
  templateBytes: Uint8Array,
  map: FormMap,
  row: DataRow,
  opts: FillOptions = {},
): Promise<FillResult> {
  const doc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
  const flatten = opts.flatten !== false;

  // Overlay mode: flat PDF, draw text at coordinates.
  if (map.fillMode === "overlay") {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    let drawn = 0;
    for (const field of map.overlayFields ?? []) {
      const page = pages[field.page];
      if (!page) continue;
      if (!Number.isFinite(field.x) || !Number.isFinite(field.y)) continue;
      if (field.onlyIf) {
        const cond = resolveSource(field.onlyIf.source, row, opts.today);
        const pass = field.onlyIf.equals != null
          ? cond.trim().toLowerCase() === field.onlyIf.equals.trim().toLowerCase()
          : Boolean(cond.trim());
        if (!pass) continue;
      }
      let text = resolveSource(field.source, row, opts.today);
      if (!text) continue;
      const size = field.size ?? 9;
      if (field.maxWidth) {
        while (text.length > 1 && font.widthOfTextAtSize(text, size) > field.maxWidth) {
          text = text.slice(0, -1);
        }
      }
      page.drawText(text, {
        x: field.x + (opts.nudgeX ?? 0),
        y: field.y + (opts.nudgeY ?? 0),
        size,
        font,
        color: rgb(0, 0, 0),
      });
      drawn += 1;
    }
    const signaturesDrawn = await drawSignatures(doc, map.signatureFields, opts.signature, opts.today);
    return { bytes: await doc.save(), filledCount: drawn, unmapped: [], signaturesDrawn };
  }

  // AcroForm mode.
  const form = doc.getForm();
  const fieldByName = new Map(form.getFields().map((f) => [f.getName(), f]));
  const unmapped: string[] = [];
  let filled = 0;

  for (const [fieldName, source] of Object.entries(map.textFields)) {
    const field = fieldByName.get(fieldName);
    if (!field) { unmapped.push(fieldName); continue; }
    const value = resolveSource(source, row, opts.today);
    try {
      if (field instanceof PDFTextField) {
        try {
          field.setText(value);
        } catch {
          // Most common setText failure: value exceeds the field's maxLength.
          const max = field.getMaxLength();
          if (max != null && value.length > max) field.setText(value.slice(0, max));
          else throw new Error("setText failed");
        }
        filled += 1;
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) {
        if (!value) continue; // leave unselected rather than erroring on ""
        const options = field.getOptions();
        const match = options.find((o) => o === value)
          ?? options.find((o) => normalizeName(o) === normalizeName(value));
        if (!match) { unmapped.push(fieldName); continue; }
        field.select(match);
        filled += 1;
      } else {
        unmapped.push(fieldName);
      }
    } catch {
      unmapped.push(fieldName);
    }
  }

  for (const [fieldName, rule] of Object.entries(map.checkboxes ?? {})) {
    const field = fieldByName.get(fieldName);
    if (!field || !(field instanceof PDFCheckBox)) { unmapped.push(fieldName); continue; }
    try {
      if (checkboxOn(rule, row, opts.today)) field.check();
      else field.uncheck();
      filled += 1;
    } catch {
      unmapped.push(fieldName);
    }
  }

  // Flatten so values are baked in and can't be edited in transit.
  if (flatten) {
    try { form.flatten(); } catch { /* some forms can't flatten; leave as-is */ }
  }

  const signaturesDrawn = await drawSignatures(doc, map.signatureFields, opts.signature, opts.today);
  return { bytes: await doc.save(), filledCount: filled, unmapped, signaturesDrawn };
}

/** row.* sources in a map that don't resolve to any known column — surfaced
 *  before a batch fill so a typo'd map fails loudly, not with blank fields. */
export function unknownRowSources(map: FormMap, headers: string[]): string[] {
  const known = new Set(headers.map(normalizeName));
  const out = new Set<string>();
  const checkSource = (source: FieldSource | undefined): void => {
    if (!source || !source.startsWith("row.")) return;
    const key = source.slice(4);
    if (!known.has(normalizeName(key))) out.add(source);
  };
  for (const s of Object.values(map.textFields ?? {})) checkSource(s);
  for (const rule of Object.values(map.checkboxes ?? {})) checkSource(rule.source);
  for (const f of map.overlayFields ?? []) { checkSource(f.source); checkSource(f.onlyIf?.source); }
  return [...out].sort();
}
