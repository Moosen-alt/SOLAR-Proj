// Standalone form-filler types. This package is intentionally independent of
// backend/ and shared/ — it must keep working when the folder is copied out of
// the monorepo. The map format is a generalized cousin of the AHJ form maps in
// backend/src/ahjForms.ts, with data sources rebased from project/client/snapshot
// onto a flat data row (one CSV/JSON row per filled PDF).

/** A value source mini-language used by field maps:
 *    "row.<column>"   -> value of that column in the current data row
 *                        (column match is exact first, then case/punctuation-insensitive)
 *    "lit:<text>"     -> literal constant (e.g. "lit:X" for a checkbox mark)
 *    "computed.today" -> today's date, MM/DD/YYYY
 */
export type FieldSource = string;

export interface CheckboxRule {
  /** Checked when the resolved source is truthy, or equals `equals` (case-insensitive). */
  source: FieldSource;
  equals?: string;
}

/** For flat (non-fillable) PDFs: draw the value at a coordinate. x/y are PDF
 *  points from the BOTTOM-LEFT of the page (text baseline). */
export interface OverlayField {
  source: FieldSource;
  page: number; // 0-based
  x: number;
  y: number;
  size?: number;
  maxWidth?: number; // truncate long values to fit
  /** Only draw when this source resolves truthy (or equals `equals`). */
  onlyIf?: { source: FieldSource; equals?: string };
  /** The form's printed label, for human review of the map. */
  label?: string;
}

/** Where a signature image (passed at fill time) is stamped. PDF points,
 *  bottom-left origin of the box; the image is scaled to fit, keeping aspect. */
export interface SignaturePlacement {
  page: number; // 0-based
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  /** Adjacent "date signed" baseline; today's date is written here when set. */
  dateX?: number;
  dateY?: number;
  dateSize?: number;
}

export interface FormMap {
  formName: string;
  /** "acroform" fills fillable fields; "overlay" draws text at coordinates. */
  fillMode: "acroform" | "overlay";
  /** AcroForm field name -> source (text fields, dropdowns, radio groups). */
  textFields: Record<string, FieldSource>;
  /** AcroForm checkbox field name -> rule. */
  checkboxes?: Record<string, CheckboxRule>;
  /** Coordinate placements, used when fillMode === "overlay". */
  overlayFields?: OverlayField[];
  /** Signature stamp placements (either fill mode). */
  signatureFields?: SignaturePlacement[];
  notes?: string[];
  /** Human has previewed a filled output and confirmed the map is correct. */
  verified?: boolean;
}

/** One data record — one filled PDF. Values are always strings. */
export type DataRow = Record<string, string>;

export interface FillOptions {
  /** Signature image stamped at every signatureFields placement. */
  signature?: { bytes: Uint8Array; mime: string };
  /** Flatten AcroForm fields so values are baked in (default true). */
  flatten?: boolean;
  /** Overlay calibration: shift every overlay placement by N points (+y = up). */
  nudgeX?: number;
  nudgeY?: number;
  /** Override for computed.today (tests / backdating), "MM/DD/YYYY". */
  today?: string;
}

export interface FillResult {
  bytes: Uint8Array;
  /** Fields/placements actually written. */
  filledCount: number;
  /** Mapped AcroForm field names that don't exist or couldn't be set. */
  unmapped: string[];
  signaturesDrawn: number;
}
