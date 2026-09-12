// THE ONE-TIME SECURE LINK THE ONBOARDING GUIDE PROMISES.
//
// The customer-facing guide (§4, Portal logins) tells every new customer:
//
//   "Send them through the one-time secure link we provide, or by phone.
//    Never by email, text or chat."
//
// That link did not exist. Credentials arrived however the operator happened to arrange it,
// which in practice meant the channel the guide forbids — and this session proved the cost:
// an operator pasted a live portal password into a chat transcript because there was nowhere
// better to put it.
//
// The design copies the shape already proven by project_intake_requests (a tokenized,
// no-login link the installer opens once), with the differences a SECRET demands:
//
//   • The link carries NO credential of its own — it is a write-only drop box. Opening it
//     reveals only which portals we are asking about, never anything previously submitted.
//   • The password never lands in a database column, a log line, or a response body. It goes
//     straight into encryptStorageState and then into portal_credentials.encrypted_secret via
//     createPortalCredential — the same writer the dashboard uses.
//   • ONE USE. The row is marked completed on first successful submission and every later
//     read or write is refused, so a link forwarded onward is already spent.
//   • IT EXPIRES. 72 hours by default, because a credential drop box that lives forever is a
//     credential drop box an attacker has time to find.
//   • Nothing is echoed. The response says what was stored (portal + username reference),
//     never the secret — the same rule the credential VIEW type already follows.
//
// What this deliberately does NOT do: create portal accounts (the guide says we don't), or
// accept an EIN or any other non-credential secret — one box, one purpose, so a customer can
// never be told "just put it in the secure link" for something that then lands in plaintext.
import { randomUUID } from "node:crypto";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { createPortalCredential } from "./portalCredentials";
import { nowIso } from "./time";

const DEFAULT_TTL_HOURS = 72;

interface Row {
  id: string;
  client_id: string;
  token: string;
  portals_json: string;
  status: string;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

/** One portal we are asking the customer to supply a login for. */
export interface RequestedPortal {
  /** How the operator names the portal to the customer ("City of Woodburn — permits"). */
  portalType: string;
  /** The login URL, so the customer confirms they are sending the right account's password.
   *  The guide asks them to copy it "including any city or county segment (…/oregon/)". */
  portalUrl: string;
  /** Filled by the customer. */
  username?: string;
  /** Filled by the customer — never persisted here, never echoed. */
  password?: string;
  /** §3.6: "Emailed code at login? Which inbox?" */
  mfaRequired?: boolean;
  mfaCodeDestination?: string;
  /** §3.7: fee responsibility, agreed per portal. */
  feeResponsibility?: string;
  /** Non-secret operational hints only — the same plaintext, LLM-visible column as elsewhere. */
  notes?: string;
}

function ensureTable(db: AppDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credential_requests (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      portals_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      expires_at TEXT,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_credential_requests_token ON credential_requests(token);
    CREATE INDEX IF NOT EXISTS idx_credential_requests_client ON credential_requests(client_id);
  `);
}

/** Portals as the PUBLIC form sees them: what we are asking for, never what was sent. */
function publicPortals(row: Row): Array<{ portalType: string; portalUrl: string }> {
  const parsed = JSON.parse(row.portals_json || "[]") as RequestedPortal[];
  return parsed.map((p) => ({ portalType: String(p.portalType ?? ""), portalUrl: String(p.portalUrl ?? "") }));
}

/**
 * Mint a one-time link asking this client for logins to the named portals.
 * Returns the token; the caller builds the URL from PUBLIC_BASE_URL.
 */
export function createCredentialRequest(
  db: AppDb,
  clientId: string,
  portals: RequestedPortal[],
  opts: { createdBy?: string; ttlHours?: number } = {},
): { id: string; token: string; expiresAt: string; portals: Array<{ portalType: string; portalUrl: string }> } {
  ensureTable(db);
  const client = db.get<{ id: string }>("SELECT id FROM clients WHERE id = ?", [clientId]);
  if (!client) throw new HttpError(404, "Client not found.");
  const asked = (portals ?? [])
    .map((p) => ({
      portalType: String(p.portalType ?? "").trim(),
      portalUrl: String(p.portalUrl ?? "").trim(),
    }))
    .filter((p) => p.portalType || p.portalUrl);
  if (asked.length === 0) throw new HttpError(400, "Name at least one portal to request a login for.");
  // A secret must never be pre-seeded into the ask — the operator describes the portal, the
  // customer supplies the credential. Anything else would put a password in the row we hand out.
  const id = randomUUID();
  const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  const ttl = Number(opts.ttlHours) > 0 ? Number(opts.ttlHours) : DEFAULT_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttl * 3600_000).toISOString();
  db.run(
    `INSERT INTO credential_requests (id, client_id, token, portals_json, status, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [id, clientId, token, JSON.stringify(asked), String(opts.createdBy ?? ""), nowIso(), expiresAt],
  );
  return { id, token, expiresAt, portals: asked };
}

function liveRow(db: AppDb, token: string): Row {
  ensureTable(db);
  const row = db.get<Row>("SELECT * FROM credential_requests WHERE token = ?", [String(token ?? "")]);
  // Same message for missing, spent and expired: a probing caller learns nothing about which
  // tokens ever existed.
  const dead = new HttpError(404, "This link is no longer valid. Ask your Keelix contact for a new one.");
  if (!row) throw dead;
  if (row.status !== "pending") throw dead;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) throw dead;
  return row;
}

/** What the public form renders. Carries no secret and no previously submitted value. */
export function getCredentialRequestPublic(
  db: AppDb,
  token: string,
): { portals: Array<{ portalType: string; portalUrl: string }>; expiresAt: string | null } {
  const row = liveRow(db, token);
  return { portals: publicPortals(row), expiresAt: row.expires_at };
}

/**
 * Accept the customer's logins ONCE, encrypt them through the ordinary credential writer, and
 * spend the link. Returns only non-secret confirmation.
 */
export function submitCredentialRequest(
  db: AppDb,
  token: string,
  submitted: RequestedPortal[],
): { stored: Array<{ portalType: string; username: string }>; count: number } {
  const row = liveRow(db, token);
  const asked = JSON.parse(row.portals_json || "[]") as RequestedPortal[];
  const entries = (submitted ?? []).filter((p) => String(p?.username ?? "").trim() && String(p?.password ?? ""));
  if (entries.length === 0) throw new HttpError(400, "Enter a username and password for at least one portal.");

  const stored: Array<{ portalType: string; username: string }> = [];
  db.transaction(() => {
    for (const entry of entries) {
      // Only the portals we ASKED about: a token-holder cannot add a credential for some other
      // portal, and cannot repoint one at a URL we never named.
      const match = asked.find(
        (a) => a.portalType === String(entry.portalType ?? "") || a.portalUrl === String(entry.portalUrl ?? ""),
      );
      if (!match) throw new HttpError(400, "That portal was not part of this request.");
      const view = createPortalCredential(db, row.client_id, {
        portalType: match.portalType,
        portalUrl: match.portalUrl,
        username: String(entry.username ?? "").trim(),
        password: String(entry.password ?? ""),
        mfaRequired: entry.mfaRequired === true,
        mfaCodeDestination: String(entry.mfaCodeDestination ?? "").trim(),
        feeResponsibility: String(entry.feeResponsibility ?? "").trim(),
        notes: String(entry.notes ?? "").trim(),
      });
      stored.push({ portalType: view.portalType, username: view.usernameReference });
    }
    // ONE USE: spent the moment it succeeds, so a forwarded link is already dead.
    db.run("UPDATE credential_requests SET status = 'completed', completed_at = ?, portals_json = '[]' WHERE id = ?", [
      nowIso(),
      row.id,
    ]);
  });
  return { stored, count: stored.length };
}

/** Operator view: which links are outstanding for a client. Never includes the token itself. */
export function listCredentialRequests(
  db: AppDb,
  clientId: string,
): Array<{ id: string; status: string; portals: number; createdAt: string; expiresAt: string | null; completedAt: string | null }> {
  ensureTable(db);
  const rows = db.query<Row>("SELECT * FROM credential_requests WHERE client_id = ? ORDER BY created_at DESC", [clientId]);
  return rows.map((r: Row) => ({
    id: r.id,
    status: r.expires_at && Date.parse(r.expires_at) < Date.now() && r.status === "pending" ? "expired" : r.status,
    portals: (JSON.parse(r.portals_json || "[]") as unknown[]).length,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    completedAt: r.completed_at,
  }));
}
