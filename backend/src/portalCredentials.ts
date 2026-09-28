import { encryptStorageState, decryptStorageState } from "../../portal-bot/src/cryptoStorage";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { nowIso } from "./time";
import { text as s } from "./json";
import { isHarnessAbort } from "./runAbort";

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
  /** Last time this login was accepted by its portal (ISO), if ever. */
  lastLoginOkAt?: string;
  /** Last time the portal REJECTED it (ISO). Set only when we got as far as submitting. */
  lastLoginFailedAt?: string;
  /** What the portal did, in the engine's words. */
  lastLoginNote?: string;
  /** The operator-facing verdict: a login the portal refused more recently than it accepted. */
  stale: boolean;
  /** Does signing in to THIS portal account send a one-time code / challenge MFA? */
  mfaRequired: boolean;
  /** WHERE that code arrives — a shared inbox we can read, or the person who relays it.
   *  Not a secret: it is the answer to "who do I ask for the code", which is exactly what a
   *  paused run needs to be able to say. */
  mfaCodeDestination: string;
  /** Who pays this portal's AHJ/utility fees, agreed per portal at kickoff. One of
   *  '' (unagreed) | 'card-on-file' | 'customer-pays' | 'mailed-check' | 'keelix-pays'.
   *  A RECORD OF AN AGREEMENT, never an authorisation — automation never pays a portal fee. */
  feeResponsibility: string;
}

/** The agreed answers to "who pays this portal's fees, and how". '' means nobody has agreed
 *  yet, which is a real and common state at D0 and must stay distinguishable from an answer. */
export const FEE_RESPONSIBILITY_VALUES = ["card-on-file", "customer-pays", "mailed-check", "keelix-pays"] as const;

/** Normalises and REFUSES anything outside the vocabulary. The REST schema
 *  (validation.ts) declares this key as a plain string on purpose, so this function is the only
 *  gate the value ever passes through — a silently-accepted "venmo" would read as an agreement nobody made,
 *  and the whole value of the column is that the answer means something at kickoff. */
function normalizeFeeResponsibility(raw: unknown): string {
  const value = s(raw).trim().toLowerCase();
  if (!value) return "";
  if (!(FEE_RESPONSIBILITY_VALUES as readonly string[]).includes(value)) {
    throw new HttpError(400, `feeResponsibility must be one of ${FEE_RESPONSIBILITY_VALUES.join(", ")} (or blank).`);
  }
  return value;
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
    // INTEGER column, so the Boolean(s(...)) idiom used above for TEXT columns is WRONG here:
    // s(0) is the string "0" and Boolean("0") is true, which would report every credential as
    // MFA-gated and send an operator hunting a shared inbox that does not exist.
    mfaRequired: Number(row.mfa_required ?? 0) === 1,
    mfaCodeDestination: s(row.mfa_code_destination),
    feeResponsibility: s(row.fee_responsibility),
    lastLoginOkAt: s(row.last_login_ok_at) || undefined,
    lastLoginFailedAt: s(row.last_login_failed_at) || undefined,
    lastLoginNote: s(row.last_login_note) || undefined,
    // Refused more recently than it was accepted — or refused and never accepted at all.
    // A login that later succeeds stops being stale without anyone editing anything.
    stale: Boolean(s(row.last_login_failed_at)) && s(row.last_login_failed_at) > s(row.last_login_ok_at),
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
  payload: {
    portalType?: string; portalUrl?: string; username?: string; password?: string; notes?: string; securityAnswers?: string;
    mfaRequired?: boolean; mfaCodeDestination?: string; feeResponsibility?: string;
  },
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
  // Refuse an unknown fee answer BEFORE writing anything: a half-written credential carrying
  // a fee agreement nobody made is worse than a refusal the operator can retype.
  const feeResponsibility = normalizeFeeResponsibility(payload.feeResponsibility);
  const credId = id();
  const now = nowIso();
  db.run(
    `INSERT INTO portal_credentials
      (id, client_id, portal_type, portal_url, username_reference, encrypted_secret, notes,
       mfa_required, mfa_code_destination, fee_responsibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      credId, clientId, s(payload.portalType), s(payload.portalUrl), username, encrypted, s(payload.notes),
      payload.mfaRequired ? 1 : 0, s(payload.mfaCodeDestination).trim(), feeResponsibility, now, now,
    ],
  );
  return mapView(db.get<Row>("SELECT * FROM portal_credentials WHERE id = ?", [credId])!);
}

export function updatePortalCredential(
  db: AppDb,
  clientId: string,
  credId: string,
  payload: {
    portalType?: string; portalUrl?: string; username?: string; password?: string; notes?: string; securityAnswers?: string;
    mfaRequired?: boolean; mfaCodeDestination?: string; feeResponsibility?: string;
  },
): PortalCredentialView {
  const row = db.get<Row>("SELECT * FROM portal_credentials WHERE id = ? AND client_id = ?", [credId, clientId]);
  if (!row) throw new HttpError(404, "Portal credential not found.");
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if ("portalType" in payload) { sets.push("portal_type = ?"); params.push(s(payload.portalType)); }
  if ("portalUrl" in payload) { sets.push("portal_url = ?"); params.push(s(payload.portalUrl)); }
  if ("notes" in payload) { sets.push("notes = ?"); params.push(s(payload.notes)); }
  // Key-presence guarded, like the three above: an intake re-run that names only the portal
  // type must not silently clear an MFA destination somebody took a phone call to establish.
  if ("mfaRequired" in payload) { sets.push("mfa_required = ?"); params.push(payload.mfaRequired ? 1 : 0); }
  if ("mfaCodeDestination" in payload) { sets.push("mfa_code_destination = ?"); params.push(s(payload.mfaCodeDestination).trim()); }
  if ("feeResponsibility" in payload) { sets.push("fee_responsibility = ?"); params.push(normalizeFeeResponsibility(payload.feeResponsibility)); }
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

/** The known aliases of a host (lowercase, "www." kept as stored) — THE one alias list: the
 *  credential resolver reads it, and so does permitProcess.isStatewidePortalUrl (aca.oregon.gov and
 *  epermitting.oregon.gov ARE Oregon ePermitting's aca-oregon.accela.com). */
export function hostAliasesOf(host: string): string[] {
  const h = String(host ?? "").toLowerCase();
  return [...(HOSTNAME_ALIASES[h] ?? []), ...(HOSTNAME_ALIASES[h.replace(/^www\./, "")] ?? [])];
}

function hostsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  const aliases = HOSTNAME_ALIASES[a] || [];
  return aliases.includes(b);
}

// Match by hostname of the stored portal_url — handles the common case where the
// operator stored the credential with a different portal_type string.
/** WHICH STORED URLs MAY SUPPLY THE CREDENTIAL FOR THIS TARGET. Exported so the choice can be
 *  tested for real: the decision is which ROW gets used, and a test that only watches the
 *  decrypted output cannot see it (every row fails to decrypt in a fixture, so the answer is
 *  null either way and the test passes without the fix).
 *
 *  Returns the stored URLs that are safe to use, most-specific first. Empty means REFUSE —
 *  never fall back to a neighbour. */
export function selectCredentialUrlsFor(targetUrl: string, storedUrls: string[]): string[] {
  const host = (u: string): string => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
  const seg = (u: string): string => {
    try { return (new URL(u).pathname.split("/").filter(Boolean)[0] ?? "").toLowerCase(); } catch { return ""; }
  };
  const targetHost = host(targetUrl);
  if (!targetHost) return [];
  const targetSeg = seg(targetUrl);
  const hostMatches = storedUrls.filter((u) => u && hostsMatch(targetHost, host(u)));
  const segMatches = hostMatches.filter((u) => seg(u) === targetSeg);
  if (segMatches.length) return segMatches;
  // Only when NO stored row on this host carries a jurisdiction segment does a bare host
  // match stand on its own — that is a portal living at the host root, not an ambiguity.
  const anySegments = hostMatches.some((u) => seg(u) !== "");
  return (!anySegments) ? hostMatches : [];
}

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
  // ONE HOST, MANY JURISDICTIONS. Accela serves every city it hosts from aca-prod.accela.com
  // and tells them apart by the FIRST PATH SEGMENT: /sandiego, /lascruces, /SACRAMENTO. Tyler,
  // iWorQ and SmartGov do the same. Matching on host alone therefore returns whichever row was
  // updated most recently and types one city's password into another city's login — the exact
  // secret-spraying this file's own comment refuses to do across hosts, unguarded within one.
  //
  // Measured: with San Diego, Sacramento and Las Cruces all on aca-prod.accela.com, San Diego's
  // login went from "logged in" to "still on the login form" purely because two neighbours
  // arrived. Repeated attempts of that kind are how accounts get locked out.
  //
  // So: host must match, and when the target URL carries a first path segment, the stored URL
  // must carry the SAME one. A host match with a different jurisdiction segment is not a
  // near-miss to fall back on; it is the wrong account.
  const usable = selectCredentialUrlsFor(portalUrl, rows.map((r) => s(r.portal_url)))
    .map((u) => rows.find((r) => s(r.portal_url) === u))
    .filter((r): r is Row => Boolean(r));
  for (const row of usable) {
    try {
      const dec = decryptStorageState(s(row.encrypted_secret)) as { username?: string; password?: string };
      return { username: s(dec.username), password: s(dec.password) };
    } catch { continue; }
  }
  return null;
}

/**
 * THE LEARN'S CREDENTIAL FOR ONE TARGET PORTAL (B11). The URL decides FIRST: host + first path
 * segment (selectCredentialUrlsFor), the same guard that keeps one Accela city's password out of
 * its neighbour's login. A row whose portal_type is literally the generic "AHJ" / "utility" used
 * to win BEFORE the URL was looked at — whatever portal its stored URL named — so an operator
 * who typed "AHJ" into the free-text type field on Iowa City's login would have had it typed into
 * Lee County's. A typed row now stands only when its OWN stored URL fits the target (which the
 * URL step already found); a typed row for a different portal is never used. Last resort, as
 * before: the client's ONLY credential when its host does not contradict the target
 * (getDecryptedCredentialAny).
 *
 * `portalType` is kept in the signature so a caller cannot forget which track it is on; it no
 * longer outranks the URL.
 */
export function getDecryptedCredentialForPortal(
  db: AppDb,
  clientId: string,
  _portalType: string,
  targetUrl: string,
): { username: string; password: string } | null {
  return getDecryptedCredentialByUrl(db, clientId, targetUrl)
    ?? getDecryptedCredentialAny(db, clientId, targetUrl);
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

// ---------------------------------------------------------------------------
// WHICH OF THE CLIENT'S LOGINS LOOKS LIKE THE ONE WE NEEDED?
//
// A refusal has to name the portal it wanted. "No stored credential for this client/portal"
// sent an operator hunting a bug that did not exist: the client held 83 logins including one
// for Oregon ePermitting, the page in front of the bot was City of Portland's own DevHub,
// and the message named neither. The first version of the fix then listed all 83 — a 4,700
// character wall that buried the single fact that mattered.
//
// So: name the host that was needed, and offer only the logins that plausibly ARE it.
// Scoring on shared host labels catches same-system-different-subdomain; scoring on the
// jurisdiction's own name catches the genuinely dangerous lookalikes — Portland, Maine is
// not Portland, Oregon, and a tired operator at 6pm will absolutely try that login.
// ---------------------------------------------------------------------------

/** Host labels that identify nothing on their own. */
const GENERIC_HOST_LABELS = new Set(["www", "com", "gov", "org", "net", "portal", "permits", "permitting", "online", "citizen", "public"]);

/** AHJ words that match every municipal host ever registered, so they name nothing. */
const GENERIC_AHJ_WORDS = new Set([
  "city", "county", "town", "village", "borough", "township", "district",
  "department", "building", "unincorporated", "the", "and", "of",
]);

function hostLabels(host: string): string[] {
  return host.toLowerCase().split(".").filter((p) => p.length > 3 && !GENERIC_HOST_LABELS.has(p));
}

/**
 * Ranks a client's stored logins by how likely each is to be the one the caller wanted.
 * Returns display labels, most plausible first, and an empty array when nothing relates —
 * which is itself the answer worth reporting.
 */
export function nearestStoredLogins(
  stored: Array<{ portalType?: string; portalUrl?: string | null }>,
  targetUrlOrHost: string,
  ahj?: string,
  limit = 4,
): string[] {
  const targetHost = (() => {
    try { return new URL(targetUrlOrHost).hostname.toLowerCase(); } catch { return String(targetUrlOrHost || "").toLowerCase(); }
  })();
  const targetLabels = new Set(hostLabels(targetHost));
  const ahjWords = String(ahj || "").toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !GENERIC_AHJ_WORDS.has(w));

  return (stored || [])
    .map((c) => {
      const host = (() => {
        try { return c.portalUrl ? new URL(c.portalUrl).hostname.toLowerCase() : ""; } catch { return ""; }
      })();
      const type = String(c.portalType || "").toLowerCase();
      let score = 0;
      for (const label of hostLabels(host)) if (targetLabels.has(label)) score += 2;
      for (const word of ahjWords) if (host.includes(word) || type.includes(word)) score += 1;
      return { label: host ? `${c.portalType} (${host})` : String(c.portalType || ""), score };
    })
    .filter((c) => c.score > 0 && c.label)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => c.label);
}

// ---------------------------------------------------------------------------
// LOGIN HEALTH — remember which stored logins the portal actually accepted.
//
// A stale credential is indistinguishable from a broken bot from the outside: the run
// stops with "still on the login form after submitting", which is accurate and then
// forgotten. A service bureau holding 80+ logins for jurisdictions it touches a few times
// a year will always have some that have rotated; which ones is worth keeping.
//
// Matched by HOST, the same way the credential was chosen in the first place, so the note
// lands on the row that was actually tried.
// ---------------------------------------------------------------------------
export function recordLoginOutcome(
  db: AppDb,
  clientId: string,
  portalUrl: string,
  outcome: { ok: boolean; note?: string },
): boolean {
  if (!clientId || !portalUrl) return false;
  // A DEAD BROWSER IS NOT A REFUSED PASSWORD.
  //
  // This is the expensive half of the mistake. A killed benchmark run reported
  // "browserType.launchPersistentContext: Target page, context or browser has been closed"
  // for every portal still in flight, and that text was written here as a login failure
  // against six real, working credentials — Accela, SmartGov, Tyler EnerGov, eTRAKiT,
  // Cloudpermit, PermitTrax. The stale flag is honoured by the benchmark precisely so it
  // will not bang on locked doors, so those six were then skipped by every later run: a
  // twelve-portal baseline quietly selected five, and the interesting platforms had been
  // retired by a browser that died.
  //
  // Marking a credential is a claim about the PORTAL's answer. When the run never got an
  // answer, the honest record is no record at all — leave the row exactly as it was.
  if (!outcome.ok && isHarnessAbort(outcome.note)) return false;
  let targetHost = "";
  try { targetHost = new URL(portalUrl).hostname.toLowerCase(); } catch { return false; }
  const rows = db.query<Row>(
    "SELECT id, portal_url FROM portal_credentials WHERE client_id = ? ORDER BY updated_at DESC", [clientId],
  );
  const now = nowIso();
  for (const row of rows) {
    const stored = s(row.portal_url);
    if (!stored) continue;
    let storedHost = "";
    try { storedHost = new URL(stored).hostname.toLowerCase(); } catch { continue; }
    if (!hostsMatch(targetHost, storedHost)) continue;
    // Both outcomes are recorded. Only writing failures would leave a credential marked
    // stale forever after one bad night; a success is what clears it.
    if (outcome.ok) {
      db.run(
        "UPDATE portal_credentials SET last_login_ok_at = ?, last_login_note = ?, updated_at = ? WHERE id = ?",
        [now, s(outcome.note).slice(0, 300), now, s(row.id)],
      );
    } else {
      db.run(
        "UPDATE portal_credentials SET last_login_failed_at = ?, last_login_note = ?, updated_at = ? WHERE id = ?",
        [now, s(outcome.note).slice(0, 300), now, s(row.id)],
      );
    }
    return true;
  }
  return false;
}

/** Logins the portal refused more recently than it accepted them — the refresh list. */
export function listStaleCredentials(db: AppDb, clientId: string): PortalCredentialView[] {
  return listPortalCredentials(db, clientId).filter((c) => c.stale);
}

/**
 * THE CREDENTIAL FOR THIS PORTAL, IF THE PORTAL HAS ALREADY REFUSED IT.
 *
 * The onboarding guide promises this in as many words: "We can't detect a password change — the
 * first sign is a failed filing — and we stop trying that portal until we have a working login so
 * the account doesn't get locked." The `stale` flag has existed and been correct for a long time
 * (a later success clears it without anyone editing anything), but it was consulted ONLY by the
 * benchmark — the comment above says so outright — so a real filing kept re-attempting a rejected
 * login, every stage, on the operator's own account. Which is how accounts get locked.
 *
 * Safe in the direction that matters: `stale` is set by recordLoginOutcome, which refuses to mark
 * anything when isHarnessAbort(note) is true. That guard exists because a dead browser was once
 * recorded as six credential failures and quietly retired seven working platforms — so "our
 * browser died" can never reach this function as "the password was refused".
 */
export function lockedOutCredential(
  db: AppDb,
  clientId: string,
  portalUrl: string,
): PortalCredentialView | null {
  if (!clientId || !portalUrl) return null;
  const rows = listPortalCredentials(db, clientId);
  if (!rows.length) return null;
  // Matched the way production matches: most-specific stored URL first.
  for (const url of selectCredentialUrlsFor(portalUrl, rows.map((c) => c.portalUrl))) {
    const hit = rows.find((c) => c.portalUrl === url);
    if (hit) return hit.stale ? hit : null;   // the FIRST match decides; a later one is a different portal
  }
  return null;
}

// ---------------------------------------------------------------------------
// "PAUSED FOR MFA" IS HALF AN ANSWER. THE OTHER HALF WAS WRITTEN DOWN AT KICKOFF.
//
// Automation never solves a one-time code (hard safety rule 1) — that is settled, and no
// column changes it. What a pause CAN do is stop sending the operator hunting: the intake
// packet asks, per portal account, "Emailed code at login? Which inbox?", and until now the
// answer lived in a spreadsheet while the run said only that it had stopped.
//
// Resolved through selectCredentialUrlsFor — the SAME choice that picked the password — so
// the hint describes the account actually being logged into. A host match with a different
// jurisdiction segment names a different account and would point at the wrong inbox, so it
// yields nothing rather than a guess. Empty string means "we were never told", which is a
// truthful thing for a pause message to omit.
//
// Non-secret by construction: a destination is who to ask, never the code itself.
// ---------------------------------------------------------------------------
export function mfaCodeDestinationFor(db: AppDb, clientId: string, portalUrl: string): string {
  if (!clientId || !portalUrl) return "";
  const rows = db.query<Row>(
    "SELECT portal_url, mfa_code_destination FROM portal_credentials WHERE client_id = ? ORDER BY updated_at DESC",
    [clientId],
  );
  for (const url of selectCredentialUrlsFor(portalUrl, rows.map((r) => s(r.portal_url)))) {
    const hit = rows.find((r) => s(r.portal_url) === url);
    const destination = s(hit?.mfa_code_destination).trim();
    if (destination) return destination;
  }
  return "";
}
