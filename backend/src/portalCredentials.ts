import { encryptStorageState, decryptStorageState } from "../../portal-bot/src/cryptoStorage";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { nowIso } from "./time";
import { text as s } from "./json";

type Row = Record<string, unknown>;


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
  payload: { portalType?: string; portalUrl?: string; username?: string; password?: string; notes?: string; securityAnswers?: string },
): PortalCredentialView {
  const client = db.get<Row>("SELECT id FROM clients WHERE id = ?", [clientId]);
  if (!client) throw new HttpError(404, "Client not found.");
  const username = s(payload.username).trim();
  const password = s(payload.password);
  if (!username || !password) throw new HttpError(400, "username and password are required.");
  // Store the secret only as an encrypted blob; keep a non-secret username reference
  // for display/audit. Security-question answers (portals challenge them on a new device)
  // ride ALONG in the encrypted envelope — never in the plaintext notes column, which is
  // LLM-visible via knowledgeResearchHint. Additive: the field is absent on older rows and
  // decrypt tolerates it.
  const securityAnswers = s(payload.securityAnswers).trim();
  const secret: { username: string; password: string; securityAnswers?: string } = { username, password };
  if (securityAnswers) secret.securityAnswers = securityAnswers;
  const encrypted = encryptStorageState(secret);
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
  payload: { portalType?: string; portalUrl?: string; username?: string; password?: string; notes?: string; securityAnswers?: string },
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
    // Carry the existing security answers across a password rotation unless new ones are
    // supplied — re-encrypting with only {username, password} would silently discard them,
    // and the portal still challenges for them on a new device.
    let securityAnswers = s(payload.securityAnswers).trim();
    if (!securityAnswers && s(row.encrypted_secret)) {
      try {
        const prev = decryptStorageState(s(row.encrypted_secret)) as { securityAnswers?: string };
        securityAnswers = s(prev?.securityAnswers).trim();
      } catch { /* unreadable previous secret — nothing to carry */ }
    }
    const secret: { username: string; password: string; securityAnswers?: string } = { username, password: s(payload.password) };
    if (securityAnswers) secret.securityAnswers = securityAnswers;
    sets.push("encrypted_secret = ?");
    params.push(encryptStorageState(secret));
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

// Known hostname aliases: portals that redirect to each other / share a login.
// e.g. epermitting.oregon.gov redirects to aca.oregon.gov/CitizenAccess — same Accela instance.
// Keys and values are all lowercase hostnames. The set is symmetric: add one direction and
// the resolver checks both.
const HOSTNAME_ALIASES: Record<string, string[]> = {
  // Oregon ePermitting / Accela — the AHJ permit portal (covers both BLD and ELE
  // submittals; they share one login). epermitting.oregon.gov redirects to aca.oregon.gov.
  "aca.oregon.gov": ["epermitting.oregon.gov", "aca-oregon.accela.com"],
  "epermitting.oregon.gov": ["aca.oregon.gov", "aca-oregon.accela.com"],
  "aca-oregon.accela.com": ["aca.oregon.gov", "epermitting.oregon.gov"],
  // PacifiCorp (Pacific Power / Rocky Mountain Power) NEM — the utility interconnection
  // portal is PowerClerk at pacificorpnetmetering.powerclerk.com, but operators often
  // store the credential against the utility's marketing site (pacificpower.net /
  // rockymountainpower.net). Treat them as the same login target.
  "pacificorpnetmetering.powerclerk.com": ["pacificpower.net", "rockymountainpower.net", "www.pacificpower.net", "www.rockymountainpower.net"],
  "pacificpower.net": ["pacificorpnetmetering.powerclerk.com", "www.pacificpower.net"],
  "www.pacificpower.net": ["pacificorpnetmetering.powerclerk.com", "pacificpower.net"],
  "rockymountainpower.net": ["pacificorpnetmetering.powerclerk.com", "www.rockymountainpower.net"],
  "www.rockymountainpower.net": ["pacificorpnetmetering.powerclerk.com", "rockymountainpower.net"],
  // PGE NEM — PowerClerk at pgenm.powerclerk.com; operators may store portlandgeneral.com.
  "pgenm.powerclerk.com": ["portlandgeneral.com", "www.portlandgeneral.com"],
  "portlandgeneral.com": ["pgenm.powerclerk.com", "www.portlandgeneral.com"],
  "www.portlandgeneral.com": ["pgenm.powerclerk.com", "portlandgeneral.com"],
};

function hostsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  const aliases = HOSTNAME_ALIASES[a] || [];
  return aliases.includes(b);
}

// Match by hostname of the stored portal_url — handles the common case where the
// operator stored the credential with a different portal_type string.
export function getDecryptedCredentialByUrl(
  db: AppDb,
  clientId: string,
  portalUrl: string,
): { username: string; password: string } | null {
  if (!portalUrl) return null;
  let targetHost: string;
  try { targetHost = new URL(portalUrl).hostname.toLowerCase(); } catch { return null; }
  const rows = db.query<Row>(
    "SELECT encrypted_secret, portal_url FROM portal_credentials WHERE client_id = ? ORDER BY updated_at DESC",
    [clientId],
  );
  for (const row of rows) {
    const stored = s(row.portal_url);
    if (!stored) continue;
    try {
      const storedHost = new URL(stored).hostname.toLowerCase();
      if (hostsMatch(targetHost, storedHost)) {
        const dec = decryptStorageState(s(row.encrypted_secret)) as { username?: string; password?: string };
        return { username: s(dec.username), password: s(dec.password) };
      }
    } catch { continue; }
  }
  return null;
}

// Last-resort fallback: ONLY when the client has exactly one stored credential is it
// unambiguous which login to use. When a client has credentials for multiple portals
// (e.g. a utility NEM portal AND an AHJ permit portal), guessing could fill one portal's
// login with the other's secret — so refuse and require a portalType/URL match instead.
// When the caller KNOWS the target portal URL, a single credential stored for a
// DIFFERENT host is also refused — the client's only login being the PGE PowerClerk
// one must not be typed into the Oregon ePermitting form (a guaranteed rejection, and
// it sprays one portal's secret at another).
export function getDecryptedCredentialAny(
  db: AppDb,
  clientId: string,
  targetUrl?: string,
): { username: string; password: string } | null {
  const rows = db.query<Row>(
    "SELECT encrypted_secret, portal_url FROM portal_credentials WHERE client_id = ?",
    [clientId],
  );
  if (rows.length !== 1 || !s(rows[0].encrypted_secret)) return null;
  const stored = s(rows[0].portal_url);
  if (targetUrl && stored) {
    try {
      const targetHost = new URL(targetUrl).hostname.toLowerCase();
      const storedHost = new URL(stored).hostname.toLowerCase();
      if (!hostsMatch(targetHost, storedHost)) return null; // known mismatch — never cross portals
    } catch { /* unparseable URL — fall through to the single-credential behavior */ }
  }
  try {
    const dec = decryptStorageState(s(rows[0].encrypted_secret)) as { username?: string; password?: string };
    return { username: s(dec.username), password: s(dec.password) };
  } catch { return null; }
}
