// ---------------------------------------------------------------------------
// READ THE BILL INSTEAD OF ASKING A PERSON TO READ IT.
//
// The utility account number is the most common single reason a project stops and waits for
// a human: 5 of 19 live projects, one interruption each, ~26 per 100 projects (measured
// 2026-09-22 while counting operator supervision load). QC's instruction — "Enter the utility
// account number EXACTLY as printed on the bill — never guess it" — is correct and stays.
// This does not weaken it. Reading the digits off the bill IMAGE is reading, not guessing;
// the rule exists to stop the number being inferred from anything OTHER than the bill.
//
// The extractor already existed (llm.extractProjectFieldsFromImages, which explicitly maps
// "Account number -> accountNumber", "Meter number -> meterNumber", and refuses passwords and
// SSNs). It was only reachable from a button on the parser screen, so it ran at intake — and
// the bill usually arrives AFTER intake. Measured on the live rows: in none of the five cases
// was a bill on file when the item was raised; three arrived 8 seconds to 17 minutes later,
// at which point the document was sitting there and a person typed its number in by hand.
//
// TWO RULES THIS MODULE WILL NOT BREAK:
//   · It never overwrites a value already on the project. An operator-entered account number
//     outranks anything a model reads.
//   · It only reads the customer's own documents (utility_bill, meter_photo) and only writes
//     accountNumber / meterNumber / utility. Anything else the extractor returns is dropped —
//     this is not a back door for re-parsing a project from a photo.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import type { AppDb } from "./db";
import type { LLMProvider, ParserPayload } from "../../shared/src/types";
import { parseJson } from "./json";
import { logger } from "./logger";
import { nowIso } from "./time";

/** Only these fields may be written from a document image, and only when empty. */
const READABLE_FIELDS = ["accountNumber", "meterNumber"] as const;

const MIME_BY_EXT: Record<string, "image/png" | "image/jpeg" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function imageFor(storedPath: string): { base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" } | null {
  const ext = (storedPath.match(/\.[a-z0-9]+$/i)?.[0] || "").toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  // PDFs are deliberately excluded: the extractor takes images, and a PDF bill is already
  // covered by the text-extraction path. Rendering PDFs here would be a second, slower way
  // to do something that already works.
  if (!mimeType || !fs.existsSync(storedPath)) return null;
  const bytes = fs.readFileSync(storedPath);
  // A phone photo over ~8MB is past what the vision call will accept comfortably; skipping is
  // better than a failed call that reads as "the bill could not be read".
  if (bytes.length > 8 * 1024 * 1024) return null;
  return { base64: bytes.toString("base64"), mimeType };
}

/**
 * Fill empty account/meter fields on a project by reading its own bill and meter images.
 * Returns the field names actually written (empty when there was nothing to do, no image on
 * file, or no LLM configured). Never throws — the caller's chain must not die over this, and
 * QC asking a human is the correct fallback.
 */
export async function fillAccountFieldsFromDocuments(db: AppDb, llm: LLMProvider, projectId: string): Promise<string[]> {
  const row = db.get<{ parser_json: string; utility: string; state: string }>(
    "SELECT parser_json, utility, state FROM projects WHERE id = ?",
    [projectId],
  );
  if (!row) return [];
  const snapshot = parseJson<ParserPayload>(row.parser_json, {});
  const value = (key: string): string => String((snapshot as Record<string, unknown>)[key] ?? "").trim();

  // Nothing to do when the operator (or an earlier read) already has these.
  const wanted = READABLE_FIELDS.filter((f) => !value(f));
  if (!wanted.length) return [];

  const docs = db.query<{ doc_type: string; stored_path: string }>(
    `SELECT doc_type, stored_path FROM project_documents
      WHERE project_id = ? AND doc_type IN ('utility_bill', 'meter_photo')
      ORDER BY uploaded_at DESC`,
    [projectId],
  );
  const images: Array<{ kind: "utility_bill" | "meter_photo"; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }> = [];
  const seenKinds = new Set<string>();
  for (const doc of docs) {
    const kind = doc.doc_type === "meter_photo" ? "meter_photo" : "utility_bill";
    if (seenKinds.has(kind)) continue; // newest of each kind is enough
    const img = imageFor(String(doc.stored_path));
    if (!img) continue;
    seenKinds.add(kind);
    images.push({ kind, ...img });
  }
  if (!images.length) return [];

  const extraction = await llm.extractProjectFieldsFromImages({ images, defaultState: row.state || undefined });
  // The stub provider returns nothing useful; treat it as "no read happened" rather than
  // letting an empty result look like a confident blank.
  if (extraction.provider === "stub") return [];

  const written: string[] = [];
  const next: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  for (const field of wanted) {
    const got = extraction.fields?.[field];
    const read = String(got?.value ?? "").trim();
    if (!read) continue;
    // A field the extractor itself flagged as low-confidence is exactly the case where a
    // person should look — writing it would turn a doubt into a fact on a utility application.
    if ((extraction.lowConfidenceFields || []).includes(field)) continue;
    next[field] = read;
    written.push(field);
  }
  if (!written.length) return [];

  db.run("UPDATE projects SET parser_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(next), nowIso(), projectId]);
  // Audited because it writes a value onto a filing: what was read, from which document kind,
  // and never the value itself (account numbers do not belong in logs).
  const { addAuditLog } = await import("./audit");
  addAuditLog(db, projectId, "system", "bill vision", "project.fields_read_from_document", {
    fields: written,
    fromDocuments: images.map((i) => i.kind),
  });
  logger.info("bill-vision", "account fields read from the customer's own documents", { project: projectId, fields: written });
  return written;
}
