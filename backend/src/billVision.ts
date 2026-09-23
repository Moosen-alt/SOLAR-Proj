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
// The extractor already existed (llm.extractProjectFieldsFromImages, whose vision prompt
// returns the account as "account" and the meter as "meter" — the snapshot's own keys, NOT
// "accountNumber"/"meterNumber" — and which never extracts passwords or SSNs). It was only reachable from a button on the parser screen, so it ran at intake — and
// the bill usually arrives AFTER intake. Measured on the live rows: in none of the five cases
// was a bill on file when the item was raised; three arrived 8 seconds to 17 minutes later,
// at which point the document was sitting there and a person typed its number in by hand.
//
// TWO RULES THIS MODULE WILL NOT BREAK:
//   · It never overwrites a value already on the project. An operator-entered account number
//     outranks anything a model reads.
//   · It only reads the customer's own documents (utility_bill, meter_photo) and only writes
//     accountNumber / meterNumber (snapshot keys "account" / "meter"). Anything else the extractor returns is dropped —
//     this is not a back door for re-parsing a project from a photo.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import type { AppDb } from "./db";
import type { LLMProvider, ParserPayload } from "../../shared/src/types";
import { parseJson } from "./json";
import { logger } from "./logger";
import { fieldAliases, parserField } from "./normalize";

/** Only these fields may be written from a document image, and only when empty. */
const READABLE_FIELDS = ["accountNumber", "meterNumber"] as const;
type ReadableField = (typeof READABLE_FIELDS)[number];

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
 * file, or no LLM configured). A provider error propagates — the chain step (autoStageSteps
 * STEP 0.5) catches it, because the chain must not die over this, and
 * QC asking a human is the correct fallback.
 */
export async function fillAccountFieldsFromDocuments(db: AppDb, llm: LLMProvider, projectId: string): Promise<string[]> {
  const row = db.get<{ parser_json: string; utility: string; state: string; account_number: string | null; meter_number: string | null }>(
    "SELECT parser_json, utility, state, account_number, meter_number FROM projects WHERE id = ?",
    [projectId],
  );
  if (!row) return [];
  const snapshot = parseJson<ParserPayload>(row.parser_json, {});

  // PRESENCE IS ASKED THE SAME WAY QC ASKS IT. The snapshot stores these under the QC aliases
  // ("account"/"ubAccountNumber", "meter"/"ubMeterNumber" — normalize.ts fieldAliases), never
  // under the literal "accountNumber". Reading the literal made every project look empty, so
  // every chain run paid for a vision call — and, had the write ever landed, would have
  // overwritten a number an operator typed. The column is checked too: it is what every real
  // write path (updateProject/createProject) sets, so either one being present means "leave it".
  const present = (field: ReadableField): boolean => {
    const column = field === "accountNumber" ? row.account_number : row.meter_number;
    return String(column ?? "").trim() !== "" || parserField(snapshot, field) !== "";
  };

  // Nothing to do when the operator (or an earlier read) already has these — and that means
  // NO model call at all, not a call whose answer is then discarded.
  const wanted = READABLE_FIELDS.filter((f) => !present(f));
  if (!wanted.length) return [];

  const docs = db.query<{ id: string; doc_type: string; stored_path: string }>(
    `SELECT id, doc_type, stored_path FROM project_documents
      WHERE project_id = ? AND doc_type IN ('utility_bill', 'meter_photo')
      ORDER BY uploaded_at DESC`,
    [projectId],
  );
  const images: Array<{ kind: "utility_bill" | "meter_photo"; base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }> = [];
  const documentIds: string[] = [];
  const seenKinds = new Set<string>();
  for (const doc of docs) {
    const kind = doc.doc_type === "meter_photo" ? "meter_photo" : "utility_bill";
    if (seenKinds.has(kind)) continue; // newest of each kind is enough
    const img = imageFor(String(doc.stored_path));
    if (!img) continue;
    seenKinds.add(kind);
    images.push({ kind, ...img });
    documentIds.push(String(doc.id));
  }
  if (!images.length) return [];

  // THE SAME BILL IS NOT READ TWICE. A read that wrote nothing (low confidence, the number
  // simply not on the page) leaves the field empty, so presence alone would re-read the same
  // image on every chain run for the same answer. A new upload has a new id and is read.
  if (alreadyRead(db, projectId, documentIds)) return [];

  const extraction = await llm.extractProjectFieldsFromImages({ images, defaultState: row.state || undefined });
  // The stub provider returns nothing useful; treat it as "no read happened" rather than
  // letting an empty result look like a confident blank.
  if (extraction.provider === "stub") return [];

  const { addAuditLog } = await import("./audit");
  const lowConfidence = extraction.lowConfidenceFields || [];
  const payload: ParserPayload = {};
  const written: string[] = [];
  for (const field of wanted) {
    // The vision prompt names these "account"/"meter" (llm.ts extractProjectFieldsFromImages),
    // which is the first QC alias. The literal field name is kept as a fallback for any
    // provider that answers in the canonical id.
    const key = snapshotKey(field);
    const got = extraction.fields?.[key] ?? extraction.fields?.[field];
    const read = String(got?.value ?? "").trim();
    if (!read) continue;
    // A field the extractor itself flagged as low-confidence is exactly the case where a
    // person should look — writing it would turn a doubt into a fact on a utility application.
    if (lowConfidence.includes(key) || lowConfidence.includes(field)) continue;
    payload[key] = read;
    written.push(field);
  }
  if (!written.length) {
    addAuditLog(db, projectId, "system", "bill vision", READ_NOTHING_ACTION, { fields: [], fromDocuments: images.map((i) => i.kind), documentIds });
    return [];
  }

  // Written through the real project write path: updateProject maps {account} onto the
  // account_number column (what forms, portals and QC read) and re-runs QC, so a passing
  // check auto-resolves the review item. A raw parser_json write reached none of those.
  // Dynamic import: repository is heavy and this module is itself loaded on demand.
  try {
    const { updateProject } = await import("./repository");
    // RE-ASK PRESENCE AFTER THE LAST AWAIT. The check above ran before the vision call, and an
    // operator who uploads the bill often types the number off it while the model is still
    // reading — the read must never overwrite what they typed. Nothing awaits between this
    // re-read and updateProject (better-sqlite3 is synchronous), so no save can slip between.
    const fresh = db.get<{ parser_json: string; account_number: string | null; meter_number: string | null }>(
      "SELECT parser_json, account_number, meter_number FROM projects WHERE id = ?", [projectId],
    );
    const freshSnapshot = parseJson<ParserPayload>(fresh?.parser_json ?? "{}", {});
    const nowPresent = (field: ReadableField): boolean => {
      const column = field === "accountNumber" ? fresh?.account_number : fresh?.meter_number;
      return String(column ?? "").trim() !== "" || parserField(freshSnapshot, field) !== "";
    };
    for (const field of [...written] as ReadableField[]) {
      if (!nowPresent(field)) continue;
      delete payload[snapshotKey(field)];
      written.splice(written.indexOf(field), 1);
    }
    if (!written.length) {
      addAuditLog(db, projectId, "system", "bill vision", READ_NOTHING_ACTION, {
        fields: [], fromDocuments: images.map((i) => i.kind), documentIds, reason: "entered by a person while the bill was being read",
      });
      return [];
    }
    updateProject(db, projectId, payload);
  } catch (err) {
    logger.warn("bill-vision", "could not save account fields read from the bill; QC will ask a human", {
      project: projectId, err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  // Audited because it writes a value onto a filing: what was read, from which document kind,
  // and never the value itself (account numbers do not belong in logs).
  addAuditLog(db, projectId, "system", "bill vision", READ_ACTION, {
    fields: written,
    fromDocuments: images.map((i) => i.kind),
    documentIds,
  });
  logger.info("bill-vision", "account fields read from the customer's own documents", { project: projectId, fields: written });
  return written;
}

const READ_ACTION = "project.fields_read_from_document";
const READ_NOTHING_ACTION = "project.document_read_no_fields";

/** The snapshot key QC and normalizeProject read first for a canonical field ("account"). */
function snapshotKey(field: ReadableField): string {
  return fieldAliases[field]?.[0] ?? field;
}

/** True when this exact set of documents was already sent to the model for this project. */
function alreadyRead(db: AppDb, projectId: string, documentIds: string[]): boolean {
  const rows = db.query<{ details: string }>(
    "SELECT details FROM audit_logs WHERE project_id = ? AND action IN (?, ?)",
    [projectId, READ_ACTION, READ_NOTHING_ACTION],
  );
  const want = [...documentIds].sort().join(",");
  return rows.some((r) => {
    const ids = parseJson<{ documentIds?: unknown }>(r.details, {}).documentIds;
    return Array.isArray(ids) && [...ids].map(String).sort().join(",") === want;
  });
}
