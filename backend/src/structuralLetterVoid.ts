// ---------------------------------------------------------------------------
// WHEN A STRUCTURAL-LETTER CONFIRMATION STOPS COVERING WHAT SHIPS (#198; Helm's review of #218 at
// fb160321). The one answer structuralLetter.ts (the gate, the candidate, the confirm door) and
// projectDocuments.saveProjectDocument (the stamp) both ask.
//
// A confirmation covers ONE document: its id and the sha256 of its stored bytes. The package ships
// the NEWEST `structural` row (projectDocsByType, latest per type), and the splitter only ever
// APPENDS (buildUtilityPackage — the build-package route, auto-stage's repair re-split), so a
// confirmation on row A is void as soon as a newer `structural` row B exists — unless B is the
// same cut again: a `source = 'split'` row of the same newest plan set with the same sha256 (the
// splitter writes its parts without a save-time timestamp, so an unchanged plan set re-cuts
// byte-identically). A changed re-cut, a person's upload to the slot, or a new plan set voids it.
//
// A split cut is judged by its LINEAGE: cut before the newest plan set landed, it is stale whenever
// it was confirmed. A person's own upload was looked at alongside whatever plan set stood when they
// confirmed, so for it a plan set newer than the confirmation voids.
//
// Dependency-light on purpose: projectDocuments imports this, so it must not import the gate.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import fs from "node:fs";
import type { AppDb } from "./db";
import { DOC_TYPE_ALIASES } from "./projectDocuments";
import { nowIso } from "./time";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v));

/** Read lazily: projectDocuments imports this module, so its exports are not there at load. */
const planSetTypes = (): string[] => ["plan_set", ...DOC_TYPE_ALIASES.plan_set];

/** The stored bytes' sha256, memoised on (path, size, mtime) — the gate reads this several times a view. */
const hashMemo = new Map<string, { key: string; sha: string }>();
export function fileSha256(storedPath: string): string | null {
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

/** Why a confirmation of `documentId` (bytes `sha256`, confirmed at `confirmedAt`) does not cover
 *  what is on file NOW, or null when it does. Asked of a hypothetical confirmation too (confirmedAt
 *  = now): the candidate is never a document whose confirmation would be void on arrival, and the
 *  confirm door refuses one. Reads only. */
export function structuralDocumentVoidReason(
  db: AppDb, projectId: string, documentId: string, sha256: string, confirmedAt: string,
): string | null {
  const doc = db.get<Row>(
    "SELECT rowid AS rid, doc_type, stored_path, source, uploaded_at FROM project_documents WHERE id = ? AND project_id = ?",
    [documentId, projectId],
  );
  if (!doc || s(doc.doc_type) !== "structural") return "the confirmed document was replaced or re-split";
  const sha = fileSha256(s(doc.stored_path));
  if (!sha) return "the confirmed document's file is missing";
  if (sha !== sha256) return "the confirmed document's contents changed";
  const isCut = s(doc.source) === "split";
  const types = planSetTypes();
  const newestPlanSet = s(db.get<Row>(
    `SELECT MAX(uploaded_at) AS t FROM project_documents WHERE project_id = ? AND doc_type IN (${types.map(() => "?").join(", ")})`,
    [projectId, ...types],
  )?.t);
  if (newestPlanSet && newestPlanSet > (isCut ? s(doc.uploaded_at) : confirmedAt)) {
    return isCut ? "a new plan set was uploaded after this cut was made" : "a new plan set was uploaded after it was confirmed";
  }
  for (const newer of db.query<Row>(
    `SELECT source, stored_path FROM project_documents
      WHERE project_id = ? AND doc_type = 'structural' AND id <> ? AND (uploaded_at > ? OR (uploaded_at = ? AND rowid > ?))`,
    [projectId, documentId, s(doc.uploaded_at), s(doc.uploaded_at), Number(doc.rid)],
  )) {
    const newerIsCut = s(newer.source) === "split";
    // The same cut again (the stage pass's no-op re-split): what ships is what the person saw.
    if (isCut && newerIsCut && fileSha256(s(newer.stored_path)) === sha256) continue;
    return newerIsCut ? "a re-split cut a different structural document" : "a newer document was filed to the structural slot";
  }
  return null;
}

/** STAMP THE VOID on the standing confirmation when a document write voided it, so removing the
 *  newer row later (deleting a newer plan set, a newer upload) never silently revives it. Called by
 *  saveProjectDocument for `structural` and plan-set writes — a write path, never a read. */
export function stampStructuralLetterVoid(db: AppDb, projectId: string, docType: string): void {
  if (docType !== "structural" && !planSetTypes().includes(docType)) return;
  const c = db.get<Row>(
    "SELECT id, document_id, content_sha256, confirmed_at FROM structural_letter_confirmations WHERE project_id = ? AND withdrawn_at = '' AND voided_at = '' ORDER BY confirmed_at DESC, rowid DESC LIMIT 1",
    [projectId],
  );
  if (!c) return;
  const reason = structuralDocumentVoidReason(db, projectId, s(c.document_id), s(c.content_sha256), s(c.confirmed_at));
  if (reason) db.run("UPDATE structural_letter_confirmations SET voided_at = ?, void_reason = ? WHERE id = ?", [nowIso(), reason, s(c.id)]);
}
