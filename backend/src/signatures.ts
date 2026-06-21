import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { nowIso } from "./time";

// ---------------------------------------------------------------------------
// Operator signatures. The operator stores their own signature image(s) once and
// the form filler places them on the matching signature line (applicant by
// default). The human still does the final portal submit — this only pre-places
// the operator's own signature on the prepared PDF at their direction.
// ---------------------------------------------------------------------------

export type SignatureRole = "applicant" | "owner" | "contractor" | "electrician" | "other";
export const SIGNATURE_ROLES: SignatureRole[] = ["applicant", "owner", "contractor", "electrician", "other"];

export interface SignatureView {
  id: string;
  role: string;
  name: string;
  mime: string;
  widthPx: number;
  heightPx: number;
  isDefault: boolean;
  createdAt: string;
}

export interface LoadedSignature {
  bytes: Uint8Array;
  mime: string;
  widthPx: number;
  heightPx: number;
}

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
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
  };
}

export function listSignatures(db: AppDb): SignatureView[] {
  return db
    .query<Record<string, unknown>>("SELECT id, role, name, mime, width_px, height_px, is_default, created_at FROM signatures ORDER BY role, name")
    .map(mapRow);
}

export function getSignatureImage(db: AppDb, id: string): { bytes: Buffer; mime: string } {
  const row = db.get<{ image_png: Buffer | null; mime: string }>("SELECT image_png, mime FROM signatures WHERE id = ?", [id]);
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
  input: { role: string; name: string; bytes: Uint8Array; mime: string; isDefault: boolean },
): Promise<SignatureView> {
  if (!input.bytes || input.bytes.length === 0) throw new HttpError(400, "Empty signature image.");
  const role = (SIGNATURE_ROLES as string[]).includes(input.role) ? input.role : "other";
  const mime = input.mime.includes("jpeg") || input.mime.includes("jpg") ? "image/jpeg" : "image/png";
  const dims = await imageDimensions(input.bytes, mime);
  const id = crypto.randomUUID();
  const now = nowIso();
  db.transaction(() => {
    if (input.isDefault) db.run("UPDATE signatures SET is_default = 0, updated_at = ? WHERE role = ?", [now, role]);
    db.run(
      `INSERT INTO signatures (id, role, name, image_png, mime, width_px, height_px, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, role, input.name || role, Buffer.from(input.bytes), mime, dims.width, dims.height, input.isDefault ? 1 : 0, now, now],
    );
    // First signature of a role becomes its default automatically.
    const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM signatures WHERE role = ?", [role]);
    if (count && count.n === 1) db.run("UPDATE signatures SET is_default = 1 WHERE id = ?", [id]);
  });
  return mapRow(db.get<Record<string, unknown>>("SELECT id, role, name, mime, width_px, height_px, is_default, created_at FROM signatures WHERE id = ?", [id])!);
}

export function setDefaultSignature(db: AppDb, id: string): void {
  const row = db.get<{ role: string }>("SELECT role FROM signatures WHERE id = ?", [id]);
  if (!row) throw new HttpError(404, "Signature not found.");
  const now = nowIso();
  db.transaction(() => {
    db.run("UPDATE signatures SET is_default = 0, updated_at = ? WHERE role = ?", [now, row.role]);
    db.run("UPDATE signatures SET is_default = 1, updated_at = ? WHERE id = ?", [now, id]);
  });
}

export function deleteSignature(db: AppDb, id: string): void {
  const row = db.get<{ id: string }>("SELECT id FROM signatures WHERE id = ?", [id]);
  if (!row) throw new HttpError(404, "Signature not found.");
  db.run("DELETE FROM signatures WHERE id = ?", [id]);
}

// The default signature image for each role, for the form filler to draw.
export function loadDefaultSignaturesByRole(db: AppDb): Record<string, LoadedSignature> {
  const rows = db.query<Record<string, unknown>>(
    "SELECT role, image_png, mime, width_px, height_px FROM signatures WHERE is_default = 1",
  );
  const out: Record<string, LoadedSignature> = {};
  for (const row of rows) {
    const blob = row.image_png as Buffer | null;
    if (!blob) continue;
    out[s(row.role)] = { bytes: new Uint8Array(blob), mime: s(row.mime) || "image/png", widthPx: Number(row.width_px ?? 0), heightPx: Number(row.height_px ?? 0) };
  }
  return out;
}
