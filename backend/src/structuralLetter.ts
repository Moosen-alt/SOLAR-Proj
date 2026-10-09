// ---------------------------------------------------------------------------
// THE ENGINEER'S STRUCTURAL LETTER: TEXT SUGGESTS, A NAMED PERSON CONFIRMS (#198).
//
// Owner ruling 2026-10-08 (on #218). A Utah city approved a packet whose engineer's certification
// was bound into the plan set; the splitter filed it as `structural`, and the gate held the job
// twice for want of the very letter that made it engineered. Four rounds of teaching the text
// layer to recognise that letter each left ordinary plan-set wording that released the hold with
// nobody named. So:
//
//   - The detector (permitPath.certificationScore) only RANKS: which split `structural` document,
//     and which of its pages, is the likeliest letter. That is the candidate the gate shows.
//   - Only a named, signed-in person's confirmation credits the inventory's stamped-structural row
//     and turns city.struct.stamped-engineering-missing from a hold into a warning ("verify the
//     seal" — the seal is an image the text layer never sees, so it stays a person's check).
//   - A confirmation covers EXACTLY the document the person looked at: its id and the sha256 of its
//     stored bytes. A replaced document (gone, or new bytes), a newer `structural` row that is not a
//     byte-identical re-cut of the same plan set, or a newer plan set voids it
//     (structuralLetterVoid.ts); the project holds again until someone re-confirms. A write that
//     voids it stamps the void on the row, so deleting that newer row never revives it.
//   - The candidate is never a document whose confirmation would be void on arrival (a cut of a
//     superseded plan set, a row a newer one replaced), and the confirm door refuses one.
//   - It can be withdrawn. Every confirm and withdraw is an audit_logs entry: who, when, document
//     id, page.
//
// With no standing confirmation the gate behaves exactly as before #198: held.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import type { AppDb } from "./db";
import type { StructuralLetterCandidate, StructuralLetterConfirmationView, StructuralLetterState } from "../../shared/src/types";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { nowIso } from "./time";
import { certificationScore } from "./permitPath";
import { sniffFileKind } from "./fileTypes";
import { fileSha256, structuralDocumentVoidReason } from "./structuralLetterVoid";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v));

export const STRUCTURAL_LETTER_CONFIRMED_ACTION = "structural_letter.confirmed";
export const STRUCTURAL_LETTER_WITHDRAWN_ACTION = "structural_letter.withdrawn";

/** A document's pages as the background extraction stored them (page_texts_json, one entry per
 *  PDF page, a scanned page as ""). [] until that has run, or for a non-PDF. */
function pagesOf(pageTextsJson: unknown): string[] {
  try {
    const v = JSON.parse(s(pageTextsJson) || "[]");
    return Array.isArray(v) ? v.map((t) => s(t)) : [];
  } catch {
    return [];
  }
}

/** THE CANDIDATE: of the project's `structural` documents whose file is on disk and whose
 *  confirmation would stand (structuralDocumentVoidReason — in practice the row the package ships,
 *  or an identical earlier cut of it), the one whose text reads most like the engineer's letter
 *  (newest first on a tie), and its best page. Offered even when nothing reads letter-like (score 0,
 *  e.g. a scan with no text layer) — a person looking costs nothing, and a person, not the score,
 *  decides. null when no structural document can be confirmed. */
export function structuralLetterCandidate(db: AppDb, projectId: string): StructuralLetterCandidate | null {
  let best: StructuralLetterCandidate | null = null;
  const at = nowIso();
  for (const row of db.query<Row>(
    "SELECT id, original_filename, stored_path, source, extracted_text, page_texts_json FROM project_documents WHERE project_id = ? AND doc_type = 'structural' ORDER BY uploaded_at DESC, rowid DESC",
    [projectId],
  )) {
    const p = s(row.stored_path);
    const sha = p ? fileSha256(p) : null;
    if (!sha || structuralDocumentVoidReason(db, projectId, s(row.id), sha, at)) continue;
    const pages = pagesOf(row.page_texts_json);
    let page = 1, pageScore = 0;
    pages.forEach((t, i) => { const sc = certificationScore(t); if (sc > pageScore) { pageScore = sc; page = i + 1; } });
    const score = Math.max(pageScore, certificationScore(s(row.extracted_text)));
    if (!best || score > best.score) {
      best = { documentId: s(row.id), filename: s(row.original_filename), source: s(row.source), page, pageCount: pages.length, score };
    }
  }
  return best;
}

interface ConfirmationRow {
  id: string;
  document_id: string;
  content_sha256: string;
  page: number;
  confirmed_by: string;
  confirmed_at: string;
  void_reason: string;
}

/** Why a confirmation no longer covers what is on file, or the filename when it still does. What is
 *  on file now speaks first; a void a document write stamped (structuralLetterVoid) holds after. */
function voidReason(db: AppDb, projectId: string, c: ConfirmationRow): { reason: string } | { filename: string } {
  const live = structuralDocumentVoidReason(db, projectId, c.document_id, c.content_sha256, c.confirmed_at);
  if (live) return { reason: live };
  if (c.void_reason) return { reason: c.void_reason };
  const doc = db.get<Row>("SELECT original_filename FROM project_documents WHERE id = ? AND project_id = ?", [c.document_id, projectId]);
  return { filename: s(doc?.original_filename) };
}

function latestStanding(db: AppDb, projectId: string): ConfirmationRow | null {
  const row = db.get<Row>(
    "SELECT id, document_id, content_sha256, page, confirmed_by, confirmed_at, void_reason FROM structural_letter_confirmations WHERE project_id = ? AND withdrawn_at = '' ORDER BY confirmed_at DESC, rowid DESC LIMIT 1",
    [projectId],
  );
  return row ? {
    id: s(row.id), document_id: s(row.document_id), content_sha256: s(row.content_sha256),
    page: Number(row.page ?? 0), confirmed_by: s(row.confirmed_by), confirmed_at: s(row.confirmed_at), void_reason: s(row.void_reason),
  } : null;
}

/** THE ONE ANSWER every consumer asks (inventory row, reviewer finding, gate card): the
 *  confirmation that still covers the document as it stands now, or null. */
export function activeStructuralLetterConfirmation(db: AppDb, projectId: string): StructuralLetterConfirmationView | null {
  const c = latestStanding(db, projectId);
  if (!c) return null;
  const v = voidReason(db, projectId, c);
  if ("reason" in v) return null;
  return { id: c.id, documentId: c.document_id, filename: v.filename, page: c.page, confirmedBy: c.confirmed_by, confirmedAt: c.confirmed_at };
}

/** The candidate, the standing confirmation and (when the latest one no longer covers what is on
 *  file) why it was voided — what the gate card shows. */
export function structuralLetterState(db: AppDb, projectId: string): StructuralLetterState {
  const c = latestStanding(db, projectId);
  const v = c ? voidReason(db, projectId, c) : null;
  const confirmation = c && v && !("reason" in v)
    ? { id: c.id, documentId: c.document_id, filename: v.filename, page: c.page, confirmedBy: c.confirmed_by, confirmedAt: c.confirmed_at }
    : null;
  const candidate = structuralLetterCandidate(db, projectId);
  return {
    candidate,
    confirmation,
    voided: c && v && "reason" in v ? { confirmedBy: c.confirmed_by, confirmedAt: c.confirmed_at, reason: v.reason } : null,
    unconfirmable: candidate ? null : unconfirmableStructuralDocument(db, projectId),
  };
}

/** With no candidate: the structural document that ships (the newest on disk) and why it cannot be
 *  confirmed, so the card never says "no structural document on file" over one that is (a cut that
 *  predates lineage, a cut of a plan set that no longer ships). null when none is on file. */
function unconfirmableStructuralDocument(db: AppDb, projectId: string): { filename: string; reason: string } | null {
  for (const row of db.query<Row>(
    "SELECT id, original_filename, stored_path FROM project_documents WHERE project_id = ? AND doc_type = 'structural' ORDER BY uploaded_at DESC, rowid DESC",
    [projectId],
  )) {
    const sha = s(row.stored_path) ? fileSha256(s(row.stored_path)) : null;
    if (!sha) continue;
    const reason = structuralDocumentVoidReason(db, projectId, s(row.id), sha, nowIso());
    return reason ? { filename: s(row.original_filename), reason } : null;
  }
  return null;
}

/** "Jane Example 2026-10-08": who and the day, for the inventory row and the finding. */
export function confirmedByLine(c: Pick<StructuralLetterConfirmationView, "confirmedBy" | "confirmedAt">): string {
  return `${c.confirmedBy} ${c.confirmedAt.slice(0, 10)}`;
}

/** How many pages the stored document has: a PDF (by its bytes, not its name or content type) is
 *  counted by pdf-lib; anything else is one page. The confirmed page is clamped into 1..this. */
async function storedPageCount(storedPath: string): Promise<number> {
  try {
    const bytes = fs.readFileSync(storedPath);
    if (sniffFileKind(bytes) !== "pdf") return 1;
    return Math.max(1, (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount());
  } catch {
    return 1;
  }
}

/** CONFIRM: `confirmedBy` is a named person (the route passes the signed-in user, never a body
 *  field while auth is on). The document must be one of THIS project's `structural` documents with
 *  its file on disk (404 otherwise — never another project's), and one whose confirmation would
 *  stand: never a cut of a superseded plan set, nor a row a newer one replaced (409). The page is
 *  clamped into the document's pages. Supersedes any standing confirmation. */
export async function confirmStructuralLetter(
  db: AppDb,
  projectId: string,
  input: { documentId: string; page?: number; confirmedBy: string; userId?: string },
): Promise<StructuralLetterConfirmationView> {
  const who = s(input.confirmedBy).replace(/\s+/g, " ").trim();
  if (!who) throw new HttpError(400, "A named person must confirm the structural letter.");
  const found = db.get<Row>(
    "SELECT id, stored_path FROM project_documents WHERE id = ? AND project_id = ? AND doc_type = 'structural'",
    [s(input.documentId), projectId],
  );
  if (!found) throw new HttpError(404, "Structural document not found on this project.");
  const pageCount = await storedPageCount(s(found.stored_path));
  // Re-read after the await: the document may have gone, or a newer one landed, meanwhile.
  const doc = db.get<Row>(
    "SELECT id, original_filename, stored_path FROM project_documents WHERE id = ? AND project_id = ? AND doc_type = 'structural'",
    [s(found.id), projectId],
  );
  if (!doc) throw new HttpError(404, "Structural document not found on this project.");
  const sha = fileSha256(s(doc.stored_path));
  if (!sha) throw new HttpError(404, "The structural document's file is missing on disk.");
  const at = nowIso();
  const stale = structuralDocumentVoidReason(db, projectId, s(doc.id), sha, at);
  if (stale) throw new HttpError(409, `This structural document cannot be confirmed: ${stale}. Confirm the current one.`);
  const page = Math.min(pageCount, Math.max(1, Math.floor(Number(input.page ?? 1)) || 1));
  const confirmationId = id();
  db.transaction(() => {
    const superseded = latestStanding(db, projectId);
    db.run(
      "UPDATE structural_letter_confirmations SET withdrawn_by = ?, withdrawn_at = ? WHERE project_id = ? AND withdrawn_at = ''",
      [`superseded by ${who}`, at, projectId],
    );
    db.run(
      `INSERT INTO structural_letter_confirmations
        (id, project_id, document_id, content_sha256, page, confirmed_by, confirmed_by_user_id, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [confirmationId, projectId, s(doc.id), sha, page, who, s(input.userId), at],
    );
    // The filename is left out on purpose: it can carry a homeowner's name. The user id is there
    // because a display name is editable.
    addAuditLog(db, projectId, "human", who, STRUCTURAL_LETTER_CONFIRMED_ACTION, {
      confirmationId, documentId: s(doc.id), page, contentSha256: sha, confirmedAt: at, userId: s(input.userId),
      ...(superseded ? { supersededConfirmationId: superseded.id } : {}),
    });
  });
  return { id: confirmationId, documentId: s(doc.id), filename: s(doc.original_filename), page, confirmedBy: who, confirmedAt: at };
}

/** WITHDRAW the standing confirmation (a voided one too: it still stands in the table until a
 *  person withdraws or supersedes it). 409 when there is nothing to withdraw. */
export function withdrawStructuralLetterConfirmation(
  db: AppDb, projectId: string, withdrawnBy: string, userId = "",
): { withdrawn: true; documentId: string; page: number } {
  const who = s(withdrawnBy).replace(/\s+/g, " ").trim();
  if (!who) throw new HttpError(400, "A named person must withdraw the confirmation.");
  const c = latestStanding(db, projectId);
  if (!c) throw new HttpError(409, "No structural-letter confirmation to withdraw.");
  const at = nowIso();
  db.transaction(() => {
    db.run("UPDATE structural_letter_confirmations SET withdrawn_by = ?, withdrawn_at = ? WHERE project_id = ? AND withdrawn_at = ''", [who, at, projectId]);
    addAuditLog(db, projectId, "human", who, STRUCTURAL_LETTER_WITHDRAWN_ACTION, {
      confirmationId: c.id, documentId: c.document_id, page: c.page, withdrawnAt: at, userId: s(userId),
    });
  });
  return { withdrawn: true, documentId: c.document_id, page: c.page };
}
