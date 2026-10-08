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
//     stored bytes. A replaced or re-split document (new id, or new bytes) or a plan set uploaded
//     after the confirmation voids it; the project holds again until someone re-confirms.
//   - It can be withdrawn. Every confirm and withdraw is an audit_logs entry: who, when, document
//     id, page.
//
// With no standing confirmation the gate behaves exactly as before #198: held.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import fs from "node:fs";
import type { AppDb } from "./db";
import type { StructuralLetterCandidate, StructuralLetterConfirmationView, StructuralLetterState } from "../../shared/src/types";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { nowIso } from "./time";
import { certificationScore } from "./permitPath";
import { DOC_TYPE_ALIASES } from "./projectDocuments";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v));

export const STRUCTURAL_LETTER_CONFIRMED_ACTION = "structural_letter.confirmed";
export const STRUCTURAL_LETTER_WITHDRAWN_ACTION = "structural_letter.withdrawn";

/** A plan set uploaded after a confirmation voids it: the letter the person saw may not be in it. */
const PLAN_SET_TYPES = ["plan_set", ...DOC_TYPE_ALIASES.plan_set];

/** The stored bytes' sha256, memoised on (path, size, mtime) — the gate reads this several times a view. */
const hashMemo = new Map<string, { key: string; sha: string }>();
function fileSha256(storedPath: string): string | null {
  try {
    const st = fs.statSync(storedPath);
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = hashMemo.get(storedPath);
    if (hit && hit.key === key) return hit.sha;
    const sha = crypto.createHash("sha256").update(fs.readFileSync(storedPath)).digest("hex");
    hashMemo.set(storedPath, { key, sha });
    return sha;
  } catch {
    return null;
  }
}

/** Pages of a document's stored text: extractPdfText joins pages with "\n" (items within a page
 *  with spaces), so a newline is a page break. Approximate when a page carried no text at all. */
function pagesOf(text: string): string[] {
  const body = s(text);
  if (!body.trim() || body === "[no text layer]") return [];
  return body.split("\n");
}

/** THE CANDIDATE: of the project's `structural` documents whose file is on disk, the one whose text
 *  reads most like the engineer's letter (newest first on a tie), and its best page. Offered even
 *  when nothing reads letter-like (score 0, e.g. a scan with no text layer) — a person looking costs
 *  nothing, and a person, not the score, decides. null when the project has no structural document. */
export function structuralLetterCandidate(db: AppDb, projectId: string): StructuralLetterCandidate | null {
  let best: StructuralLetterCandidate | null = null;
  for (const row of db.query<Row>(
    "SELECT id, original_filename, stored_path, source, extracted_text FROM project_documents WHERE project_id = ? AND doc_type = 'structural' ORDER BY uploaded_at DESC",
    [projectId],
  )) {
    const p = s(row.stored_path);
    if (!p || !fs.existsSync(p)) continue;
    const pages = pagesOf(s(row.extracted_text));
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
}

/** Why a confirmation no longer covers what is on file, or null when it still does. */
function voidReason(db: AppDb, projectId: string, c: ConfirmationRow): { reason: string } | { filename: string } {
  const doc = db.get<Row>(
    "SELECT original_filename, stored_path, doc_type FROM project_documents WHERE id = ? AND project_id = ?",
    [c.document_id, projectId],
  );
  if (!doc || s(doc.doc_type) !== "structural") return { reason: "the confirmed document was replaced or re-split" };
  const sha = fileSha256(s(doc.stored_path));
  if (!sha) return { reason: "the confirmed document's file is missing" };
  if (sha !== c.content_sha256) return { reason: "the confirmed document's contents changed" };
  const newerPlanSet = db.get<Row>(
    `SELECT id FROM project_documents WHERE project_id = ? AND doc_type IN (${PLAN_SET_TYPES.map(() => "?").join(", ")}) AND uploaded_at > ? LIMIT 1`,
    [projectId, ...PLAN_SET_TYPES, c.confirmed_at],
  );
  if (newerPlanSet) return { reason: "a new plan set was uploaded after it" };
  return { filename: s(doc.original_filename) };
}

function latestStanding(db: AppDb, projectId: string): ConfirmationRow | null {
  const row = db.get<Row>(
    "SELECT id, document_id, content_sha256, page, confirmed_by, confirmed_at FROM structural_letter_confirmations WHERE project_id = ? AND withdrawn_at = '' ORDER BY confirmed_at DESC, rowid DESC LIMIT 1",
    [projectId],
  );
  return row ? {
    id: s(row.id), document_id: s(row.document_id), content_sha256: s(row.content_sha256),
    page: Number(row.page ?? 0), confirmed_by: s(row.confirmed_by), confirmed_at: s(row.confirmed_at),
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
  return {
    candidate: structuralLetterCandidate(db, projectId),
    confirmation,
    voided: c && v && "reason" in v ? { confirmedBy: c.confirmed_by, confirmedAt: c.confirmed_at, reason: v.reason } : null,
  };
}

/** "Jane Example 2026-10-08": who and the day, for the inventory row and the finding. */
export function confirmedByLine(c: Pick<StructuralLetterConfirmationView, "confirmedBy" | "confirmedAt">): string {
  return `${c.confirmedBy} ${c.confirmedAt.slice(0, 10)}`;
}

/** CONFIRM: `confirmedBy` is a named person (the route passes the signed-in user, never a body
 *  field while auth is on). The document must be one of THIS project's `structural` documents with
 *  its file on disk (404 otherwise — never another project's). Supersedes any standing confirmation. */
export function confirmStructuralLetter(
  db: AppDb,
  projectId: string,
  input: { documentId: string; page?: number; confirmedBy: string; userId?: string },
): StructuralLetterConfirmationView {
  const who = s(input.confirmedBy).replace(/\s+/g, " ").trim();
  if (!who) throw new HttpError(400, "A named person must confirm the structural letter.");
  const doc = db.get<Row>(
    "SELECT id, original_filename, stored_path FROM project_documents WHERE id = ? AND project_id = ? AND doc_type = 'structural'",
    [s(input.documentId), projectId],
  );
  if (!doc) throw new HttpError(404, "Structural document not found on this project.");
  const sha = fileSha256(s(doc.stored_path));
  if (!sha) throw new HttpError(404, "The structural document's file is missing on disk.");
  const page = Math.max(0, Math.floor(Number(input.page ?? 0)) || 0);
  const at = nowIso();
  const confirmationId = id();
  db.transaction(() => {
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
    // The filename is left out on purpose: it can carry a homeowner's name.
    addAuditLog(db, projectId, "human", who, STRUCTURAL_LETTER_CONFIRMED_ACTION, {
      confirmationId, documentId: s(doc.id), page, contentSha256: sha, confirmedAt: at,
    });
  });
  return { id: confirmationId, documentId: s(doc.id), filename: s(doc.original_filename), page, confirmedBy: who, confirmedAt: at };
}

/** WITHDRAW the standing confirmation (a voided one too: it still stands in the table until a
 *  person withdraws or supersedes it). 409 when there is nothing to withdraw. */
export function withdrawStructuralLetterConfirmation(db: AppDb, projectId: string, withdrawnBy: string): { withdrawn: true; documentId: string; page: number } {
  const who = s(withdrawnBy).replace(/\s+/g, " ").trim();
  if (!who) throw new HttpError(400, "A named person must withdraw the confirmation.");
  const c = latestStanding(db, projectId);
  if (!c) throw new HttpError(409, "No structural-letter confirmation to withdraw.");
  const at = nowIso();
  db.transaction(() => {
    db.run("UPDATE structural_letter_confirmations SET withdrawn_by = ?, withdrawn_at = ? WHERE project_id = ? AND withdrawn_at = ''", [who, at, projectId]);
    addAuditLog(db, projectId, "human", who, STRUCTURAL_LETTER_WITHDRAWN_ACTION, {
      confirmationId: c.id, documentId: c.document_id, page: c.page, withdrawnAt: at,
    });
  });
  return { withdrawn: true, documentId: c.document_id, page: c.page };
}
