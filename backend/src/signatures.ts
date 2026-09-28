import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { HttpError } from "./httpError";
import { nowIso } from "./time";
import { text as s } from "./json";

// ---------------------------------------------------------------------------
// Operator signatures. The operator stores their own signature image(s) once and
// the form filler places them on the matching signature line (applicant by
// default). The human still does the final portal submit — this only pre-places
// the operator's own signature on the prepared PDF at their direction.
// ---------------------------------------------------------------------------

export type SignatureRole = "applicant" | "owner" | "contractor" | "electrician" | "other";
export const SIGNATURE_ROLES: SignatureRole[] = ["applicant", "owner", "contractor", "electrician", "other"];

/**
 * WHOSE SIGNATURE IS THIS — THE ORG'S SUBMITTER, OR ONE COMPANY'S LICENCE HOLDER.
 *
 * Operator ruling (2026-09-28): the applicant / authorized agent is "who is submitting it" — the
 * org's own submitting person, the same on every company's job. A LICENCE-HOLDER line (the
 * supervising electrician, the contractor licence holder) is the job's COMPANY's: that person
 * attests work under their own licence, and one service-bureau org holds several companies. Loaded
 * per org, TML's supervising electrician signed a second company's electrical application.
 * A licence-holder signature carries its client_id and is loaded ONLY for that client's jobs.
 */
export const LICENCE_HOLDER_ROLES: readonly SignatureRole[] = ["electrician", "contractor"];
export function isLicenceHolderRole(role: string): boolean {
  return (LICENCE_HOLDER_ROLES as readonly string[]).includes(String(role || "").trim());
}

export interface SignatureView {
  id: string;
  role: string;
  name: string;
  mime: string;
  widthPx: number;
  heightPx: number;
  isDefault: boolean;
  createdAt: string;
  /** The company (client) a licence-holder signature belongs to; "" for an org-level role. */
  clientId: string;
}

export interface LoadedSignature {
  bytes: Uint8Array;
  mime: string;
  widthPx: number;
  heightPx: number;
  name: string; // the signer's typed name, for the adjacent "Print name" line
}


function mapRow(row: Record<string, unknown>): SignatureView {
  return {
    id: s(row.id),
    role: s(row.role),
    name: s(row.name),
    mime: s(row.mime),
    widthPx: Number(row.width_px ?? 0),
    heightPx: Number(row.height_px ?? 0),
    isDefault: Number(row.is_default ?? 0) === 1,
    createdAt: s(row.created_at),
    clientId: s(row.client_id),
  };
}

// A signature is a person's actual signature image, applied to permit forms. All of
// these are org-scoped: listing another tenant's signatures, or applying one, is not
// something any caller should be able to do.
export function listSignatures(db: AppDb, orgId: string | null = DEFAULT_ORG_ID): SignatureView[] {
  const sql = "SELECT id, role, name, mime, width_px, height_px, is_default, created_at, client_id FROM signatures";
  return (orgId
    ? db.query<Record<string, unknown>>(`${sql} WHERE org_id = ? ORDER BY role, name`, [orgId])
    : db.query<Record<string, unknown>>(`${sql} ORDER BY role, name`)
  ).map(mapRow);
}

export function getSignatureImage(db: AppDb, id: string, orgId: string | null = DEFAULT_ORG_ID): { bytes: Buffer; mime: string } {
  const row = orgId
    ? db.get<{ image_png: Buffer | null; mime: string }>("SELECT image_png, mime FROM signatures WHERE id = ? AND org_id = ?", [id, orgId])
    : db.get<{ image_png: Buffer | null; mime: string }>("SELECT image_png, mime FROM signatures WHERE id = ?", [id]);
  if (!row || !row.image_png) throw new HttpError(404, "Signature not found.");
  return { bytes: row.image_png, mime: s(row.mime) || "image/png" };
}

// Read PNG/JPEG pixel dimensions for sane default scaling. Falls back to pdf-lib.
async function imageDimensions(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number }> {
  try {
    const doc = await PDFDocument.create();
    const img = mime.includes("jpeg") || mime.includes("jpg") ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    return { width: img.width, height: img.height };
  } catch {
    return { width: 0, height: 0 };
  }
}

export async function createSignature(
  db: AppDb,
  input: { role: string; name: string; bytes: Uint8Array; mime: string; isDefault: boolean; orgId?: string; clientId?: string },
): Promise<SignatureView> {
  if (!input.bytes || input.bytes.length === 0) throw new HttpError(400, "Empty signature image.");
  const role = (SIGNATURE_ROLES as string[]).includes(input.role) ? input.role : "other";
  const orgId = input.orgId || DEFAULT_ORG_ID;
  // A licence holder signs for ONE company: the signature names it, and that company must be one of
  // THIS org's clients (another tenant's client id is not found — 404, never 403). An org-level role
  // (applicant / owner / other) never carries a company, whatever the caller sent.
  let clientId = "";
  if (isLicenceHolderRole(role)) {
    clientId = String(input.clientId ?? "").trim();
    if (!clientId) {
      throw new HttpError(400, `A ${role} signature belongs to the company whose licence it is — choose that company. It is stamped only on that company's jobs.`);
    }
    const client = db.get<{ id: string }>("SELECT id FROM clients WHERE id = ? AND org_id = ?", [clientId, orgId]);
    if (!client) throw new HttpError(404, "Client not found.");
  }
  const mime = input.mime.includes("jpeg") || input.mime.includes("jpg") ? "image/jpeg" : "image/png";
  const dims = await imageDimensions(input.bytes, mime);
  const id = crypto.randomUUID();
  const now = nowIso();
  db.transaction(() => {
    // "Default for this role" is per org AND per company: promoting one tenant's signature must not
    // demote another's, and making one company's electrician the default must not demote another
    // company's.
    if (input.isDefault) db.run("UPDATE signatures SET is_default = 0, updated_at = ? WHERE role = ? AND org_id = ? AND client_id = ?", [now, role, orgId, clientId]);
    db.run(
      `INSERT INTO signatures (id, role, name, image_png, mime, width_px, height_px, is_default, created_at, updated_at, org_id, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, role, input.name || role, Buffer.from(input.bytes), mime, dims.width, dims.height, input.isDefault ? 1 : 0, now, now, orgId, clientId],
    );
    // First signature of a role (for this company) becomes its default automatically.
    const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM signatures WHERE role = ? AND org_id = ? AND client_id = ?", [role, orgId, clientId]);
    if (count && count.n === 1) db.run("UPDATE signatures SET is_default = 1 WHERE id = ?", [id]);
  });
  return mapRow(db.get<Record<string, unknown>>("SELECT id, role, name, mime, width_px, height_px, is_default, created_at, client_id FROM signatures WHERE id = ?", [id])!);
}

export function setDefaultSignature(db: AppDb, id: string, orgId: string = DEFAULT_ORG_ID): void {
  const row = db.get<{ role: string; client_id: string }>("SELECT role, client_id FROM signatures WHERE id = ? AND org_id = ?", [id, orgId]);
  if (!row) throw new HttpError(404, "Signature not found.");
  const now = nowIso();
  db.transaction(() => {
    db.run("UPDATE signatures SET is_default = 0, updated_at = ? WHERE role = ? AND org_id = ? AND client_id = ?", [now, row.role, orgId, s(row.client_id)]);
    db.run("UPDATE signatures SET is_default = 1, updated_at = ? WHERE id = ?", [now, id]);
  });
}

export function deleteSignature(db: AppDb, id: string, orgId: string = DEFAULT_ORG_ID): void {
  const row = db.get<{ id: string }>("SELECT id FROM signatures WHERE id = ? AND org_id = ?", [id, orgId]);
  if (!row) throw new HttpError(404, "Signature not found.");
  db.run("DELETE FROM signatures WHERE id = ?", [id]);
}

/**
 * The default signature image for each role, for the form filler to draw on ONE job's forms.
 *   - org-level roles (applicant, other): the org's default — the person who submits;
 *   - licence-holder roles (electrician, contractor): THIS job's company's default, and nothing when
 *     the company has none. Never the org's, never another company's. `clientId` is required and
 *     positional: "" (a job with no company) loads no licence-holder signature at all.
 */
export function loadDefaultSignaturesByRole(db: AppDb, orgId: string, clientId: string): Record<string, LoadedSignature> {
  const company = String(clientId ?? "").trim();
  const rows = db.query<Record<string, unknown>>(
    "SELECT role, name, image_png, mime, width_px, height_px, client_id FROM signatures WHERE is_default = 1 AND org_id = ?",
    [orgId || DEFAULT_ORG_ID],
  ).filter((row) => (isLicenceHolderRole(s(row.role))
    ? Boolean(company) && s(row.client_id) === company
    : s(row.client_id) === ""));
  const out: Record<string, LoadedSignature> = {};
  for (const row of rows) {
    const blob = row.image_png as Buffer | null;
    if (!blob) continue;
    out[s(row.role)] = { bytes: new Uint8Array(blob), mime: s(row.mime) || "image/png", widthPx: Number(row.width_px ?? 0), heightPx: Number(row.height_px ?? 0), name: s(row.name) };
  }
  return out;
}
