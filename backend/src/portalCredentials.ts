import { encryptStorageState, decryptStorageState } from "../../portal-bot/src/cryptoStorage";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { nowIso } from "./time";

type Row = Record<string, unknown>;

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

// What the API returns — NEVER includes the password or the encrypted blob.
export interface PortalCredentialView {
  id: string;
  clientId: string;
  portalType: string;
  portalUrl: string;
  usernameReference: string;
  hasSecret: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

function mapView(row: Row): PortalCredentialView {
  return {
    id: s(row.id),
    clientId: s(row.client_id),
    portalType: s(row.portal_type),
    portalUrl: s(row.portal_url),
    usernameReference: s(row.username_reference),
    hasSecret: Boolean(s(row.encrypted_secret)),
    notes: s(row.notes),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

export function listPortalCredentials(db: AppDb, clientId: string): PortalCredentialView[] {
  return db
    .query<Row>("SELECT * FROM portal_credentials WHERE client_id = ? ORDER BY portal_type, created_at", [clientId])
    .map(mapView);
}

export function createPortalCredential(
  db: AppDb,
  clientId: string,
  payload: { portalType?: string; portalUrl?: string; username?: string; password?: string; notes?: string },
): PortalCredentialView {
  const client = db.get<Row>("SELECT id FROM clients WHERE id = ?", [clientId]);
  if (!client) throw new HttpError(404, "Client not found.");
  const username = s(payload.username).trim();
  const password = s(payload.password);
  if (!username || !password) throw new HttpError(400, "username and password are required.");
  // Store the secret only as an encrypted blob; keep a non-secret username reference
  // for display/audit.
  const encrypted = encryptStorageState({ username, password });
  const credId = id();
  const now = nowIso();
  db.run(
    `INSERT INTO portal_credentials
      (id, client_id, portal_type, portal_url, username_reference, encrypted_secret, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [credId, clientId, s(payload.portalType), s(payload.portalUrl), username, encrypted, s(payload.notes), now, now],
  );
  return mapView(db.get<Row>("SELECT * FROM portal_credentials WHERE id = ?", [credId])!);
}

export function updatePortalCredential(
  db: AppDb,
  clientId: string,
  credId: string,
  payload: { portalType?: string; portalUrl?: string; username?: string; password?: string; notes?: string },
): PortalCredentialView {
  const row = db.get<Row>("SELECT * FROM portal_credentials WHERE id = ? AND client_id = ?", [credId, clientId]);
  if (!row) throw new HttpError(404, "Portal credential not found.");
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if ("portalType" in payload) { sets.push("portal_type = ?"); params.push(s(payload.portalType)); }
  if ("portalUrl" in payload) { sets.push("portal_url = ?"); params.push(s(payload.portalUrl)); }
  if ("notes" in payload) { sets.push("notes = ?"); params.push(s(payload.notes)); }
  if ("username" in payload && s(payload.username).trim()) { sets.push("username_reference = ?"); params.push(s(payload.username).trim()); }
  // Re-encrypt only when a new password is provided (rotate the secret); a username
  // change without a password keeps the existing secret's username out of sync, so
  // require both to rotate.
  if (s(payload.password)) {
    const username = s(payload.username).trim() || s(row.username_reference);
    sets.push("encrypted_secret = ?");
    params.push(encryptStorageState({ username, password: s(payload.password) }));
  }
  if (sets.length === 0) return mapView(row);
  sets.push("updated_at = ?");
  params.push(nowIso());
  params.push(credId);
  db.run(`UPDATE portal_credentials SET ${sets.join(", ")} WHERE id = ?`, params);
  return mapView(db.get<Row>("SELECT * FROM portal_credentials WHERE id = ?", [credId])!);
}

export function deletePortalCredential(db: AppDb, clientId: string, credId: string): { deleted: boolean } {
  const row = db.get<Row>("SELECT id FROM portal_credentials WHERE id = ? AND client_id = ?", [credId, clientId]);
  if (!row) throw new HttpError(404, "Portal credential not found.");
  db.run("DELETE FROM portal_credentials WHERE id = ?", [credId]);
  return { deleted: true };
}

// INTERNAL ONLY — decrypt a client's portal credential for the bot to fill a login
// form. Never exposed via the API; returns plaintext only inside the server process.
export function getDecryptedCredential(
  db: AppDb,
  clientId: string,
  portalType: string,
): { username: string; password: string } | null {
  const row = db.get<Row>(
    "SELECT encrypted_secret FROM portal_credentials WHERE client_id = ? AND portal_type = ? ORDER BY updated_at DESC LIMIT 1",
    [clientId, portalType],
  );
  if (!row || !s(row.encrypted_secret)) return null;
  try {
    const decrypted = decryptStorageState(s(row.encrypted_secret)) as { username?: string; password?: string };
    return { username: s(decrypted.username), password: s(decrypted.password) };
  } catch {
    return null;
  }
}
