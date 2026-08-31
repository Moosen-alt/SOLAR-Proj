// ---------------------------------------------------------------------------
// Operator "Permit Processes" workbook importer.
//
// Solar companies keep a per-state spreadsheet of every AHJ permit portal they
// file through: the portal URL, which software it runs, the login, security-
// question answers, and whether the portal emails a one-time code at login.
// The layouts are wildly inconsistent between states (one sheet per state, each
// authored by whoever set that state up), so this does NOT parse a fixed schema.
// It scans every row across every cell and pulls out whatever it recognizes:
//   - a portal URL (the first real http(s) link that isn't a Drive/one-off file)
//   - the platform, inferred from the URL host (EnerGov, Accela, ViewPoint, …)
//   - a login (email-shaped or the operator's known usernames)
//   - a password (the operator's "Walmart#!" family — extend PASSWORD_RE if a
//     company uses another shape)
//   - security-question answers, and an email-code (MFA) marker
//
// It emits two things per usable row, kept strictly separate so secrets never
// leak into LLM-visible text (repo safety rule #2):
//   1. a CREDENTIAL (URL + username + password) — encrypted via
//      createPortalCredential; security answers ride in the encrypted envelope.
//   2. a SEEDED AHJ KNOWLEDGE row (URL + platform + MFA marker + contact +
//      required-doc hints) via importSeededAhjKnowledge — notes carry NO secret.
//
// A row with neither a portal URL nor a password is noise (license numbers,
// addresses, status words) and is skipped. Future clients hand over the same
// kind of sheet for their state, so this is a real command, not a one-off.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import { readXlsx, type SheetData } from "./xlsxRead";
import { createPortalCredential } from "./portalCredentials";
import { importSeededAhjKnowledge } from "./knowledgeBase";

// Sheets that are not portal lists: valuation calculators, contractor-license
// registries, and anything explicitly retired. Matched case-insensitively.
const SKIP_SHEET_RE = /valuation|^ccbs|secretary contacts|\(old\)|^old |do not use/i;

// The operator's known login identities. A password-bearing row with no explicit
// user almost always uses the primary; we default to it and RECORD that we did.
const KNOWN_USERNAMES = [/[\w.+-]+@[\w.+-]+\.[a-z]{2,}/i, /InfinitySolar\w*/i];

// The operator's password family. This is deliberately narrow — a broad "any
// token with a digit and !" would sweep up addresses and license numbers. Add a
// company's shape here when onboarding one whose passwords differ.
const PASSWORD_RE = /\b(Walmart\d+!*)/i;

const URL_RE = /https?:\/\/[^\s|"'<>)\]]+/gi;

// URLs that are never a login target: cloud file links, browser-extension PDF
// viewers, raw document downloads, and reference/lookup sites that get pasted into
// these sheets (statute text, incentive databases, county property/appraiser search,
// flood maps, a stray webmail link). None is a permit portal.
const NON_PORTAL_HOST_RE = /mail\.google|dsireusa|legislature\.|\.fema\.gov|propertyappraiser|property-search|real-estate\/property|treasurer|\bpa\.gov\/.*property|msc\.fema/i;
function isPortalUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (/drive\.google|chrome-extension|dropbox\.com|\.pdf(\b|$|\?)|documentcenter|\/media\/|\/download/i.test(u)) return false;
  if (NON_PORTAL_HOST_RE.test(u)) return false;
  return /^https?:\/\//.test(u);
}

// Platform, inferred from the URL host. The label is human-facing (KB portal_platform)
// and also tells the learn engine which known portal family it is walking into.
const PLATFORM_HOST_RULES: Array<[RegExp, string]> = [
  [/energov|tylerhost|tylertech/i, "Tyler EnerGov (CSS Self Service)"],
  [/aca[-.].*accela|accela\.com|citizenaccess/i, "Accela Citizen Access"],
  [/viewpointcloud|\.viewpoint/i, "ViewPoint Cloud (OpenGov)"],
  [/opengov\.com|portal\.opengov/i, "OpenGov"],
  [/momentum\./i, "Momentum"],
  [/etrakit|aspgov/i, "eTRAKiT"],
  [/smartgovcommunity|smartgov/i, "SmartGov"],
  [/citizenserve/i, "Citizenserve"],
  [/revize|civicplus|\.civicgov/i, "CivicPlus / Revize"],
  [/bsaonline/i, "BS&A Online"],
  [/maintstar/i, "MaintStar"],
  [/rhythm.*infor|infor.*rhythm/i, "Infor Rhythm"],
  [/permitwizard|dcra\.dc\.gov|access\.dc\.gov/i, "DC Access / PermitWizard"],
  [/cityofchicago|ipi\./i, "Chicago IPI"],
  [/mygov\.us/i, "MyGov"],
  [/permitsonline|clariti|cloudpermit/i, "Cloudpermit / Clariti"],
  [/portal\.laserfiche|laserfiche/i, "Laserfiche"],
  [/\.govconnect|govconnect/i, "GovConnect"],
  [/powerclerk/i, "PowerClerk (utility interconnection)"],
];
function inferPlatform(url: string): string {
  for (const [re, label] of PLATFORM_HOST_RULES) if (re.test(url)) return label;
  try { return `Unknown (${new URL(url).hostname})`; } catch { return "Unknown"; }
}
function isRecognizedPlatform(platform: string): boolean {
  return Boolean(platform) && !platform.startsWith("Unknown");
}

const STATE_NAME_TO_CODE: Record<string, string> = {
  al: "AL", ak: "AK", az: "AZ", ar: "AR", ca: "CA", co: "CO", ct: "CT", de: "DE", fl: "FL", ga: "GA",
  hi: "HI", id: "ID", il: "IL", in: "IN", ia: "IA", ks: "KS", ky: "KY", la: "LA", me: "ME", md: "MD",
  ma: "MA", mi: "MI", mn: "MN", ms: "MS", mo: "MO", mt: "MT", ne: "NE", nv: "NV", nh: "NH", nj: "NJ",
  nm: "NM", ny: "NY", nc: "NC", nd: "ND", oh: "OH", ok: "OK", or: "OR", pa: "PA", ri: "RI", sc: "SC",
  sd: "SD", tn: "TN", tx: "TX", ut: "UT", vt: "VT", va: "VA", wa: "WA", wv: "WV", wi: "WI", wy: "WY",
};
function titleCase(s: string): string {
  return s.toLowerCase().replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\s+/g, " ").trim();
}
// Derive the jurisdiction from a STRUCTURED portal host/path. These platforms encode the
// city/county in a predictable slot, which beats the free-text label every time:
//   hialeahfl-energovpub.tylerhost.net       -> Hialeah, FL
//   jerseycitynj-energovpub.tylerhost.net    -> Jersey City, NJ
//   aca-prod.accela.com/CHINO/Default.aspx   -> Chino
//   cantonoh.portal.iworq.net                -> Canton, OH
//   ci-edgewood-wa.smartgovcommunity.com     -> Edgewood, WA
//   desmoines-wa.permittrax.com              -> Des Moines, WA
// The state is authoritative from the SHEET — we never re-derive it from the host (that
// mis-split "centralia" into "central"+"IA"). We only ever strip a trailing "-xx"/"xx"
// token from a city slug when it EXACTLY equals the sheet state, then title-case the rest.
// Returns "" when the host has no derivable name (e.g. bsaonline numeric uid).
function cleanSlug(slug: string, state: string): string {
  let s = slug.toLowerCase().replace(/^ci-/, "").replace(/^cityof/, "");
  const st = state.toLowerCase();
  s = s.replace(new RegExp(`[-]?${st}$`), "");        // "edgewood-wa" -> "edgewood"
  if (st && s.endsWith(st) && s.length > st.length + 3) s = s.slice(0, -st.length); // "hialeahfl" -> "hialeah"
  return titleCase(s);
}
function deriveJurisdictionFromHost(url: string, state: string): string {
  let host = "", pathSeg = "";
  try { const u = new URL(url); host = u.hostname.toLowerCase(); pathSeg = (u.pathname.split("/").filter(Boolean)[0] || ""); } catch { return ""; }
  const withState = (name: string) => (name && name.length >= 3 ? `${name}${state ? `, ${state}` : ""}` : "");
  // Accela: the FIRST path segment is the tenant (city/county) code.
  if (/accela\.com/.test(host) && pathSeg && !/^(default|login|welcome|dashboard|citizenaccess)$/i.test(pathSeg)) {
    return withState(titleCase(pathSeg));
  }
  // EnerGov: "<cityst>-energovpub.tylerhost.net" or "<city>-energovweb...".
  let m = host.match(/^([a-z-]+?)-energov/);
  if (m) return withState(cleanSlug(m[1], state));
  // SmartGov / permittrax / govpilot: "<slug>-<st>.<platform>".
  m = host.match(/^(?:ci-)?([a-z-]+?)\.(?:permittrax|smartgovcommunity|govpilot)/);
  if (m) return withState(cleanSlug(m[1], state));
  // iWorQ: "<slug>.portal.iworq.net" — take the whole slug, never split it.
  m = host.match(/^([a-z]+)\.portal\.iworq\.net$/);
  if (m) return withState(cleanSlug(m[1], state));
  // A plain city host: selfservice.portlandmaine.gov, epermits.buffalony.gov, sandiego.gov.
  m = host.match(/(?:^|\.)([a-z]+)\.gov$/);
  if (m && m[1].length > 4 && !/^(www|city|county|state|portal|permits?)$/.test(m[1])) return withState(cleanSlug(m[1], state));
  return "";
}

// The email-code / MFA marker: many self-service portals email a one-time code at
// login on a new device. We cannot read the operator inbox during automation, so
// these are human-capture at the login step — flagged, never silently attempted-forever.
const MFA_RE = /they send a code|send(?:s)? (?:a |you )?(?:the )?code|sent code|code sent|otp|one[- ]time (?:code|password)|2fa|two[- ]factor|verification code|email.{0,12}code|code.{0,12}email/i;

// Security-question hints in free text: "SEC QUESTION(1st CAR = FORD)", "Sec-Q: pizza".
const SECQ_RE = /sec[- ]?q(?:uestion)?[^A-Za-z0-9]{0,4}([^|]{0,80})/i;

export interface ExtractedPortalRow {
  state: string;
  jurisdiction: string;
  portalUrl: string;
  platform: string;
  username: string;
  usernameDefaulted: boolean;
  password: string;
  securityAnswers: string;
  mfaEmailCode: boolean;
  contact: string;
  notes: string;
}

// Two-letter state from a sheet name like "MD PROCESS", "VA-PROCESS", "PA PROCESS NEW".
export function stateFromSheetName(name: string): string {
  const m = name.trim().match(/^([A-Za-z]{2})\b/);
  if (m) return m[1].toUpperCase();
  const named: Record<string, string> = { puerto: "PR", "new hampshire": "NH", "new york": "NY", "new jersey": "NJ", "new mexico": "NM" };
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(named)) if (lower.startsWith(k)) return v;
  return "";
}

// A jurisdiction/portal label from the row: the descriptive text of the cell that
// carries the portal URL, with the URL, credentials, and status noise stripped. Best
// effort — imperfect labels still land as "seeded" and get refined by a human/learn.
function extractJurisdiction(cells: string[], urlCell: string, state: string): string {
  let base = urlCell || cells.find((c) => c.length > 3) || "";
  base = base
    .replace(URL_RE, " ")
    .replace(PASSWORD_RE, " ")
    .replace(/USR ?NM[:=].*/i, " ")
    .replace(/PSWRD[:=].*/i, " ")
    .replace(/pass(?:word)?[:=].*/i, " ")
    .replace(/user ?name[:=].*/i, " ")
    .replace(/REG#?\s*\d+|LICENSE #?\s*\d+|#\s*\d{4,}/gi, " ")
    .replace(/\bonline processing\b|\bself ?service\b|\bportal\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Keep the leading proper-noun-ish phrase (place/portal name), cap length.
  base = base.replace(/[|•·]+/g, " ").trim().slice(0, 80).trim();
  if (!base || base.length < 3) return "";
  return base;
}

function firstMatch(text: string, re: RegExp): string {
  const m = text.match(re);
  return m ? (m[1] ?? m[0]).trim() : "";
}

/**
 * Scan one sheet into structured portal rows. Pure — no DB, no secrets printed.
 * Dedupes by portal URL host+path (latest cell wins), so a portal listed twice in
 * a sheet yields one row.
 */
export function extractPortalRows(sheet: SheetData): ExtractedPortalRow[] {
  const state = stateFromSheetName(sheet.name);
  const byKey = new Map<string, ExtractedPortalRow>();
  for (const row of sheet.rows) {
    const cells = Object.values(row).map((v) => String(v ?? "").trim()).filter(Boolean);
    if (!cells.length) continue;
    const blob = cells.join(" | ");
    const urls = [...blob.matchAll(URL_RE)].map((m) => m[0]).filter(isPortalUrl);
    const password = firstMatch(blob, PASSWORD_RE);
    if (!urls.length && !password) continue; // pure noise row

    // The cell that actually carries the portal URL (for the jurisdiction label).
    const urlCell = cells.find((c) => URL_RE.test(c) && isPortalUrl(c)) || "";
    URL_RE.lastIndex = 0;
    const portalUrl = urls[0] || "";
    if (!portalUrl && !password) continue;

    // Username: an explicit email/known handle in the row; else, when a password is
    // present, default to the primary operator login and mark it.
    let username = "";
    for (const re of KNOWN_USERNAMES) { const hit = firstMatch(blob, re); if (hit) { username = hit; break; } }
    let usernameDefaulted = false;
    if (!username && password) { username = "permit@infinitysolarusa.com"; usernameDefaulted = true; }

    const securityAnswers = firstMatch(blob, SECQ_RE).replace(/[)\]]+$/, "").trim();
    const mfaEmailCode = MFA_RE.test(blob);
    const contact = firstMatch(blob, /\btel:([\d-]+)/i) || firstMatch(blob.replace(username, ""), /[\w.+-]+@[\w.+-]+\.gov\b/i);
    // Prefer a name derived from a structured portal host (predictable slot) over the
    // messy free-text label; fall back to the label, then to a generic placeholder.
    const jurisdiction = (portalUrl && deriveJurisdictionFromHost(portalUrl, state))
      || extractJurisdiction(cells, urlCell, state)
      || (portalUrl ? `${state} portal` : `${state} filing`);
    const platform = portalUrl ? inferPlatform(portalUrl) : "";

    // Notes: descriptive, NO secrets. Strip credential tokens defensively.
    const notes = blob
      .replace(PASSWORD_RE, "«pw»")
      .replace(/USR ?NM[:=]\s*\S+/gi, "")
      .replace(/PSWRD[:=]\s*\S+/gi, "")
      .replace(SECQ_RE, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);

    const key = (() => { try { const u = new URL(portalUrl); return `${u.hostname}${u.pathname}`.toLowerCase(); } catch { return portalUrl || `${state}:${jurisdiction}`; } })();
    // Latest wins, but never downgrade a real credential/URL to a blank one.
    const prev = byKey.get(key);
    const merged: ExtractedPortalRow = {
      state, jurisdiction, portalUrl, platform,
      username: username || prev?.username || "",
      usernameDefaulted: username ? usernameDefaulted : (prev?.usernameDefaulted ?? false),
      password: password || prev?.password || "",
      securityAnswers: securityAnswers || prev?.securityAnswers || "",
      mfaEmailCode: mfaEmailCode || prev?.mfaEmailCode || false,
      contact: contact || prev?.contact || "",
      notes: notes || prev?.notes || "",
    };
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}

export interface PortalImportSummary {
  state: string;
  sheet: string;
  credentialsStored: number;
  credentialsDefaultedUser: number;
  knowledgeSeeded: number;
  knowledgeSkippedVerified: number;
  mfaPortals: number;
  credentialErrors?: number;
  lastCredentialError?: string;
  samples: string[];
}

/**
 * Import one workbook: store credentials under `clientId` and seed AHJ knowledge.
 * dryRun previews without writing (passwords are NEVER included in the summary or
 * samples — only username_reference, URL, platform, and stored/skipped counts).
 */
export function importPortalProcessesWorkbook(
  db: AppDb,
  buffer: Buffer,
  opts: { clientId: string; dryRun?: boolean; sourceLabel?: string },
): PortalImportSummary[] {
  const sheets = readXlsx(buffer);
  const sourceLabel = opts.sourceLabel || "Permit Processes workbook";
  const out: PortalImportSummary[] = [];
  for (const sheet of sheets) {
    if (SKIP_SHEET_RE.test(sheet.name)) continue;
    const state = stateFromSheetName(sheet.name);
    if (!state) continue;
    const rows = extractPortalRows(sheet);
    if (!rows.length) continue;
    const summary: PortalImportSummary = {
      state, sheet: sheet.name, credentialsStored: 0, credentialsDefaultedUser: 0,
      knowledgeSeeded: 0, knowledgeSkippedVerified: 0, mfaPortals: 0, samples: [],
    };
    for (const r of rows) {
      if (r.mfaEmailCode) summary.mfaPortals++;
      // 1) Credential — only when we have both a URL and a password. A failure here (e.g.
      // missing encryption key) must NOT skip the knowledge seeding below, so it is
      // isolated: record it and fall through, never `continue`.
      if (r.portalUrl && r.password && r.username) {
        let stored = true;
        if (!opts.dryRun) {
          try {
            createPortalCredential(db, opts.clientId, {
              portalType: `${state} · ${r.platform}`.slice(0, 120),
              portalUrl: r.portalUrl,
              username: r.username,
              password: r.password,
              securityAnswers: r.securityAnswers || undefined,
              notes: `Imported from ${sourceLabel} (${state}). ${r.mfaEmailCode ? "Login emails a one-time code (human-capture at login)." : ""}`.trim(),
            });
          } catch (e) { stored = false; summary.credentialErrors = (summary.credentialErrors || 0) + 1; summary.lastCredentialError = (e as Error).message; }
        }
        if (stored) {
          summary.credentialsStored++;
          if (r.usernameDefaulted) summary.credentialsDefaultedUser++;
        }
      }
      // 2) Seeded AHJ knowledge — only for ACTIONABLE portal rows: a recognized portal
      // platform, a stored credential, or an email-code login. Bare info-page URLs on an
      // unrecognized host (a city's "how to get a permit" page) add KB noise with a
      // useless jurisdiction label, so they are skipped — the credential (if any) is
      // still stored above and remains findable by URL.
      const actionable = r.portalUrl && (isRecognizedPlatform(r.platform) || (r.password && r.username) || r.mfaEmailCode);
      if (actionable) {
        const noteParts = [
          r.platform ? `Portal platform: ${r.platform}` : "",
          r.mfaEmailCode ? "Login emails a one-time code at login on a new device — HUMAN-CAPTURE step, not autonomous." : "",
          r.contact ? `Contact: ${r.contact}` : "",
          r.username ? "Operator credential stored for this portal." : "",
          r.notes ? `Sheet note: ${r.notes}` : "",
        ].filter(Boolean);
        const res = opts.dryRun
          ? "imported"
          : importSeededAhjKnowledge(db, {
              state,
              ahj: r.jurisdiction,
              portalName: r.platform || undefined,
              portalUrl: r.portalUrl,
              requiredDocuments: [],
              notes: noteParts.join(" | ").slice(0, 900),
              sourceLabel,
            });
        if (res === "imported") summary.knowledgeSeeded++; else summary.knowledgeSkippedVerified++;
      }
      if (summary.samples.length < 6) {
        summary.samples.push(
          `${r.jurisdiction.slice(0, 40)} | ${r.platform || "-"} | ${r.portalUrl.slice(0, 55) || "(no url)"} | ` +
          `${r.password ? (r.usernameDefaulted ? "cred(user defaulted)" : "cred") : "no-cred"}${r.mfaEmailCode ? " | MFA-email-code" : ""}`,
        );
      }
    }
    out.push(summary);
  }
  return out;
}
