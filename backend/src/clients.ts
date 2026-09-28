import fs from "node:fs";
import path from "node:path";
import type { ClientPartnerContact, ClientPortalIdentity, ClientRecord, ClientStateLicense, LicenceAnswer, LicenceKind } from "../../shared/src/types";
import { canonicalLicenceKind, kindForSlot, LICENCE_KIND_SET, LICENCE_KINDS, licenceKindWords } from "../../shared/src/licenceKinds";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { HttpError } from "./httpError";
import { phoneSegmentKeys } from "./portalRecipes";
import { id } from "./ids";
import { nowIso } from "./time";
import { text as s } from "./json";
import { addAuditLog } from "./audit";
import { deleteCustomer } from "./crm";

type Row = Record<string, unknown>;

// The licence vocabulary is shared (shared/src/licenceKinds.ts); the slot predicate is re-exported
// here so every door imports "which licence for this slot" from one module.
export { canonicalLicenceKind, kindForSlot, LICENCE_KINDS } from "../../shared/src/licenceKinds";


function mapIdentity(row: Row): ClientPortalIdentity {
  return {
    id: s(row.id),
    clientId: s(row.client_id),
    portalType: s(row.portal_type),
    installerCompanyLabel: s(row.installer_company_label),
    installerContactCode: s(row.installer_contact_code),
    notes: s(row.notes),
    createdAt: s(row.created_at),
  };
}

function mapClient(row: Row, identities: ClientPortalIdentity[]): ClientRecord {
  return {
    id: s(row.id),
    companyName: s(row.company_name),
    contactName: s(row.contact_name),
    contactEmail: s(row.contact_email),
    phone: s(row.phone),
    billingStatus: s(row.billing_status),
    notes: s(row.notes),
    legalBusinessName: s(row.legal_business_name),
    dba: s(row.dba),
    ccbLicenseNumber: s(row.ccb_license_number),
    standardDisconnectMake: s(row.standard_disconnect_make),
    standardDisconnectModel: s(row.standard_disconnect_model),
    ccbExpiration: s(row.ccb_expiration),
    electricalLicenseNumber: s(row.electrical_license_number),
    docketNumber: s(row.docket_number),
    metroCityLicenseNumber: s(row.metro_city_license_number),
    electricalSupervisorName: s(row.electrical_supervisor_name),
    electricianLicenseNumber: s(row.electrician_license_number),
    businessAddress: s(row.business_address),
    businessCity: s(row.business_city),
    businessState: s(row.business_state),
    businessZip: s(row.business_zip),
    businessPhone: s(row.business_phone),
    businessEmail: s(row.business_email),
    updatesInbox: s(row.updates_inbox),
    billingContactEmail: s(row.billing_contact_email),
    licenseState: s(row.license_state),
    insuranceExpiry: s(row.insurance_expiry),
    bondExpiry: s(row.bond_expiry),
    ein: s(row.ein),
    bondCarrier: s(row.bond_carrier),
    insuranceCarrier: s(row.insurance_carrier),
    authorizedSignerName: s(row.authorized_signer_name),
    authorizedSignerTitle: s(row.authorized_signer_title),
    logoBase64: s(row.logo_base64),
    logoMime: s(row.logo_mime) || "image/png",
    billingMode: s(row.billing_mode),
    serviceFeeUsd: row.service_fee_usd == null || row.service_fee_usd === "" ? null : Number(row.service_fee_usd),
    portalIdentities: identities,
    stateLicenses: parseStateLicenses(row.state_licenses_json),
    partnerContacts: parsePartnerContacts(row.partner_contacts_json),
    createdAt: s(row.created_at),
  };
}

function jsonArray(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  try { const v = JSON.parse(s(raw) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
/** A licence expiry as YYYY-MM-DD; "" when it is not a date (MM/DD/YYYY is converted). */
function isoDay(raw: unknown): string {
  const t = s(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
}

/** Stored/accepted licences: state + number required. The kind is normalised to a canonical
 *  LicenceKind ("EC" → electrical_contractor, "CSL" → construction_supervisor, "home_improvement" →
 *  home_improvement_contractor); a kind no canonical kind matches keeps its text so nothing an
 *  operator typed is destroyed — such a licence is never offered to a slot (licenceFor names it). */
export function parseStateLicenses(raw: unknown): ClientStateLicense[] {
  return jsonArray(raw)
    .map((l) => {
      const typed = s(l?.kind).trim();
      const out: ClientStateLicense = { state: s(l?.state).trim().toUpperCase().slice(0, 2), kind: canonicalLicenceKind(typed) || typed, number: s(l?.number).trim() };
      const expires = isoDay(l?.expires);
      if (expires) out.expires = expires;
      const holder = s(l?.holder).replace(/\s+/g, " ").trim();
      if (holder) out.holder = holder;
      return out;
    })
    .filter((l) => /^[A-Z]{2}$/.test(l.state) && l.number);
}

// =============================================================================================
// WHICH LICENCE GOES IN THIS SLOT — THE ONE ANSWER.
//
// A company files in several states and a state issues it several licences (Massachusetts: a
// Construction Supervisor licence, a Home Improvement Contractor registration, an Electrical
// Contractor licence, all on one application). "The first licence on file for the state" put one
// number in every slot, and the portal overlay handed Oregon's CCB to a "contractor licence" box in
// any state. licenceFor answers by KIND, for THIS project's client only:
//   - an explicit kind (a slot that names its licence, a typed source) gets that kind or nothing;
//   - a generic slot ("License #") gets the kind the PERMIT needs — building: contractor, then
//     construction supervisor, then home improvement, then solar; electrical: electrical
//     contractor, then solar (never a general contractor's number); combo: the building list then
//     electrical; any other track: the one contractor licence on file, and "" with the candidates
//     named when there is more than one;
//   - business_registration is never offered as a contractor licence;
//   - nothing of the needed kind on file = "" and a reason — never another kind's, another
//     state's or another company's number (no default client, ever).
// Oregon's licences live in the named columns (ccb = contractor, electrical = electrical
// contractor, electrician + supervisor name = master electrician); those columns belong to the
// client's licenseState when it names another state. Read by: the submit gate
// (contractorLicenceForState), the form fill (ahjForms) and the portal overlay (licenceOverlay).
// =============================================================================================

/** Anything that carries a client's licences: a clients ROW (snake_case) or a ClientRecord. */
export type LicenceClient = Row | Partial<ClientRecord> | null | undefined;

interface LicenceEntry { state: string; kind: LicenceKind | ""; typedKind: string; number: string; expires: string; holder: string; column: boolean }

const pick = (c: Record<string, unknown>, snake: string, camel: string): string => s(c[snake] ?? c[camel]).trim();

/** Does the object carry any client identity at all? ({} / null = no client.) */
function hasClient(c: LicenceClient): c is Record<string, unknown> {
  return !!c && typeof c === "object" && Object.keys(c).length > 0;
}

/** The state the named licence columns belong to: licenseState when it names a state, else OR. */
export function namedColumnsState(client: LicenceClient): string {
  if (!hasClient(client)) return "OR";
  const ls = pick(client, "license_state", "licenseState").toUpperCase();
  return /^[A-Z]{2}$/.test(ls) ? ls : "OR";
}

/** Every licence the client holds in `state`, in the order they are preferred: Oregon — the named
 *  columns first (they ARE Oregon's CCB/BCD numbers), then typed OR entries; any other state — the
 *  typed entries first, then the named columns when licenseState names that state. */
function licenceEntries(client: Record<string, unknown>, state: string): LicenceEntry[] {
  const columnsState = namedColumnsState(client);
  const columns: LicenceEntry[] = [];
  if (columnsState === state) {
    const ccb = pick(client, "ccb_license_number", "ccbLicenseNumber");
    if (ccb) columns.push({ state, kind: "contractor", typedKind: "contractor", number: ccb, expires: isoDay(pick(client, "ccb_expiration", "ccbExpiration")) || pick(client, "ccb_expiration", "ccbExpiration"), holder: "", column: true });
    const ec = pick(client, "electrical_license_number", "electricalLicenseNumber");
    if (ec) columns.push({ state, kind: "electrical_contractor", typedKind: "electrical_contractor", number: ec, expires: "", holder: "", column: true });
    const el = pick(client, "electrician_license_number", "electricianLicenseNumber");
    const sup = pick(client, "electrical_supervisor_name", "electricalSupervisorName");
    if (el || sup) columns.push({ state, kind: "master_electrician", typedKind: "master_electrician", number: el, expires: "", holder: sup, column: true });
  }
  const typedRaw = Array.isArray(client.stateLicenses) ? client.stateLicenses : client.state_licenses_json;
  const typed: LicenceEntry[] = parseStateLicenses(typedRaw).filter((l) => l.state === state).map((l) => ({
    state, kind: (LICENCE_KIND_SET.has(l.kind) ? l.kind : "") as LicenceKind | "", typedKind: l.kind, number: l.number,
    expires: l.expires ?? "", holder: l.holder ?? "", column: false,
  }));
  return state === "OR" ? [...columns, ...typed] : [...typed, ...columns];
}

export type LicenceTrack = "building" | "electrical" | "combo" | "unknown";
/** A submittal track / form track / discipline, as the licence question reads it. NEM, a legacy
 *  "permit" and anything unrecognised are "unknown" — a generic slot there takes the one contractor
 *  licence on file, or nothing when several could fit. */
export function licenceTrack(track: string | null | undefined): LicenceTrack {
  const t = String(track ?? "").trim().toLowerCase();
  if (["building", "structural", "prescriptive", "engineered"].includes(t)) return "building";
  if (["electrical", "mpu"].includes(t)) return "electrical";
  if (t === "combo") return "combo";
  return "unknown";
}

const TRACK_KINDS: Record<Exclude<LicenceTrack, "unknown">, LicenceKind[]> = {
  building: ["contractor", "construction_supervisor", "home_improvement_contractor", "solar_contractor"],
  electrical: ["electrical_contractor", "solar_contractor"],
  combo: ["contractor", "construction_supervisor", "home_improvement_contractor", "solar_contractor", "electrical_contractor"],
};
const CONTRACTOR_KINDS: LicenceKind[] = LICENCE_KINDS.filter((k) => k.contractorLicence).map((k) => k.kind);

/** What a slot needs: an explicit kind, or the slot's printed text + the permit's track. */
export type LicenceNeed = LicenceKind | { slotText?: string | null; track?: string | null };

function answer(state: string, over: Partial<LicenceAnswer>): LicenceAnswer {
  return { number: "", kind: "", state, label: "", expires: "", holder: "", reason: "", candidates: [], ...over };
}
function labelFor(e: LicenceEntry): string {
  return e.state === "OR" && e.column && e.kind === "contractor" ? "CCB" : `${e.state} ${licenceKindWords(e.kind)}`;
}
function found(e: LicenceEntry): LicenceAnswer {
  return answer(e.state, { number: e.number, kind: e.kind, label: labelFor(e), expires: e.expires, holder: e.holder });
}
const normNumber = (n: string): string => n.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The one entry of `kind` — the first when it is a named column (Oregon's own), else the single
 *  distinct number; several different numbers of one kind is ambiguous (null + the entries). */
function entryOfKind(entries: LicenceEntry[], kind: LicenceKind): { entry: LicenceEntry | null; ambiguous: LicenceEntry[] } {
  const of = entries.filter((e) => e.kind === kind);
  const withNumber = of.filter((e) => e.number);
  if (!withNumber.length) return { entry: of[0] ?? null, ambiguous: [] };
  if (withNumber[0].column) return { entry: withNumber[0], ambiguous: [] };
  const distinct = new Map(withNumber.map((e) => [normNumber(e.number), e]));
  return distinct.size === 1 ? { entry: withNumber[0], ambiguous: [] } : { entry: null, ambiguous: [...distinct.values()] };
}

/**
 * THE ONE ANSWER to "which licence number goes in this slot, for this project's client and state".
 * `client` is ONLY the project's own client (a row or record); no client → "". See the block above.
 */
export function licenceFor(client: LicenceClient, projectState: string, need: LicenceNeed): LicenceAnswer {
  const st = String(projectState || "").trim().toUpperCase() || "OR";
  if (!hasClient(client)) return answer(st, { reason: "no client is assigned to this project" });
  const entries = licenceEntries(client, st);
  const untyped = entries.filter((e) => !e.kind && e.number).map((e) => `${e.number}${e.typedKind ? ` ("${e.typedKind}")` : ""}`);
  const untypedNote = untyped.length ? `; a ${st} licence with no recognised type is on file (${untyped.join(", ")}) — set its type under Clients` : "";
  const describe = (e: LicenceEntry): string => `${labelFor(e)} ${e.number}`;

  let kinds: LicenceKind[];
  let explicit: LicenceKind | null = null;
  if (typeof need === "string") explicit = need;
  else {
    const slot = kindForSlot(need.slotText);
    if (slot && slot !== "generic") explicit = slot;
  }
  if (explicit) kinds = [explicit];
  else {
    const track = licenceTrack(typeof need === "string" ? null : need.track);
    if (track === "unknown") {
      // ANY TRACK WE CANNOT NAME: the one contractor licence on file, never a guess among several.
      const pool = entries.filter((e) => e.number && e.kind && CONTRACTOR_KINDS.includes(e.kind));
      const distinct = [...new Map(pool.map((e) => [normNumber(e.number), e])).values()];
      if (distinct.length === 1) return found(distinct[0]);
      if (distinct.length > 1) {
        return answer(st, {
          reason: `several ${st} licences are on file (${distinct.map(describe).join("; ")}) and neither this slot nor the permit says which one it takes`,
          candidates: distinct.map(describe),
        });
      }
      return answer(st, { reason: `no ${st} contractor licence on file${untypedNote}` });
    }
    kinds = TRACK_KINDS[track];
  }
  for (const kind of kinds) {
    const { entry, ambiguous } = entryOfKind(entries, kind);
    if (ambiguous.length) {
      return answer(st, {
        kind, label: `${st} ${licenceKindWords(kind)}`,
        reason: `${ambiguous.length} different ${st} ${licenceKindWords(kind)} numbers are on file (${ambiguous.map((e) => e.number).join(", ")}) — keep the one that applies under Clients`,
        candidates: ambiguous.map(describe),
      });
    }
    // A holder-only entry (a supervising electrician's name with no licence number) still answers
    // the holder, and is "no number" for a number slot.
    if (entry && (entry.number || explicit)) return entry.number ? found(entry) : { ...found(entry), reason: `no ${st} ${licenceKindWords(kind)} number on file${untypedNote}` };
  }
  const words = explicit ? licenceKindWords(explicit) : kinds[0] === "electrical_contractor" ? licenceKindWords("electrical_contractor") : "contractor licence";
  return answer(st, { kind: explicit ?? "", label: `${st} ${words}`, reason: `no ${st} ${words} on file${untypedNote}` });
}

/** The submit gate's question, through licenceFor so the gate and the fill never disagree: Oregon —
 *  the CCB (Oregon's contractor registration, required on every Oregon permit); any other state —
 *  the licence the permit's track takes (unknown track: the one contractor licence on file). The
 *  number is "" when none is on file — an unknown, never a CCB demand outside Oregon. */
export function contractorLicenceForState(clientRow: LicenceClient, projectState: string, track?: string | null): LicenceAnswer & { oregon: boolean } {
  const st = String(projectState || "").trim().toUpperCase();
  const oregon = st === "OR" || !st;
  const got = oregon ? licenceFor(clientRow, "OR", "contractor") : licenceFor(clientRow, st, { track: track ?? null });
  return { ...got, oregon, state: st, label: oregon ? "CCB" : got.label || `${st} licence` };
}

/** The licence columns of a project's client, by id (null when there is no client or no row). */
export function clientLicenceRow(db: AppDb, clientId: string | null | undefined): Row | null {
  if (!clientId) return null;
  return db.get<Row>(
    `SELECT id, company_name, legal_business_name, ccb_license_number, ccb_expiration, electrical_license_number,
            electrician_license_number, electrical_supervisor_name, license_state, state_licenses_json
       FROM clients WHERE id = ?`, [clientId]) ?? null;
}

/** contractorLicenceForState for a project's client, read by id ("" when there is no client). */
export function contractorLicenceForClient(db: AppDb, clientId: string | null | undefined, projectState: string, track?: string | null): ReturnType<typeof contractorLicenceForState> {
  return contractorLicenceForState(clientLicenceRow(db, clientId), projectState, track);
}

/** The licence keys the portal overlay and the recipe resolver carry, every one answered by
 *  licenceFor for THIS job's state and track. Oregon: the named columns, as they always were. */
export const LICENCE_OVERLAY_KEYS = [
  "ccbLicenseNumber", "ccbExpiration", "electricalLicenseNumber", "electricianLicenseNumber", "electricalSupervisorName",
  "constructionSupervisorLicenseNumber", "constructionSupervisorLicenseExpiration", "homeImprovementLicenseNumber", "homeImprovementLicenseExpiration",
] as const;
export type LicenceOverlayKey = (typeof LICENCE_OVERLAY_KEYS)[number];

/**
 * THE PORTAL'S LICENCE KEYS FOR ONE JOB — every key present, "" where nothing of the needed kind is
 * on file (a present-but-empty key is a BLANK answer to recipe replay; an absent one would fall
 * back to the recorded literal, which is the learn company's licence). ccbLicenseNumber is "the
 * contractor licence this filing takes": Oregon's CCB on an Oregon job, elsewhere the generic-by-
 * track licence (never the Oregon CCB); ccbExpiration is the CHOSEN licence's expiry.
 */
export function licenceOverlay(client: LicenceClient, job: { state: string; track: string | null }): Record<LicenceOverlayKey, string> {
  const st = String(job.state || "").trim().toUpperCase() || "OR";
  const oregon = st === "OR";
  const generic = oregon ? licenceFor(client, st, "contractor") : licenceFor(client, st, { track: job.track });
  const ec = licenceFor(client, st, "electrical_contractor");
  const master = licenceFor(client, st, "master_electrician");
  const csl = licenceFor(client, st, "construction_supervisor");
  const hic = licenceFor(client, st, "home_improvement_contractor");
  return {
    ccbLicenseNumber: generic.number,
    ccbExpiration: generic.expires,
    electricalLicenseNumber: ec.number,
    electricianLicenseNumber: master.number,
    electricalSupervisorName: master.holder,
    constructionSupervisorLicenseNumber: csl.number,
    constructionSupervisorLicenseExpiration: csl.number ? csl.expires : "",
    homeImprovementLicenseNumber: hic.number,
    homeImprovementLicenseExpiration: hic.number ? hic.expires : "",
  };
}

/** Every contractor/person licence the client holds in `state`, labelled ("MA construction
 *  supervisor licence: CS-…"), for a document that lists them — through licenceFor, so a cover sheet
 *  names the same numbers the forms and the portal get. Never a business registration. */
export function stateLicenceLines(client: LicenceClient, state: string): string[] {
  const kinds: LicenceKind[] = ["contractor", "construction_supervisor", "home_improvement_contractor", "electrical_contractor", "solar_contractor", "master_electrician"];
  const out: string[] = [];
  for (const kind of kinds) {
    const a = licenceFor(client, state, kind);
    if (a.number) out.push(`${a.label}: ${a.number}`);
  }
  return out;
}

/** licenceOverlay for a project's client, read by id (every key "" when there is no client). */
export function licenceOverlayForClient(db: AppDb, clientId: string | null | undefined, job: { state: string; track: string | null }): Record<LicenceOverlayKey, string> {
  return licenceOverlay(clientLicenceRow(db, clientId), job);
}

/** Stored/accepted partner contacts: a company name required; scope by portal and/or AHJ. */
export function parsePartnerContacts(raw: unknown): ClientPartnerContact[] {
  return jsonArray(raw)
    .map((p) => ({
      role: s(p?.role).trim() || "contractor_electrical", companyName: s(p?.companyName).trim(), contactName: s(p?.contactName).trim(),
      licenseNumber: s(p?.licenseNumber).trim(), licenseState: s(p?.licenseState).trim().toUpperCase().slice(0, 2),
      email: s(p?.email).trim(), phone: s(p?.phone).trim(), portalType: s(p?.portalType).trim(), ahj: s(p?.ahj).trim(),
    }))
    .filter((p) => p.companyName);
}

/** The partner contact for this filing: AHJ + portal match first, then AHJ, then portal, then an
 *  unscoped entry for the role. null when the client names none — the client itself files. */
export function partnerContactFor(client: Pick<ClientRecord, "partnerContacts">, scope: { ahj?: string; portalType?: string; role?: string }): ClientPartnerContact | null {
  const norm = (v: string | undefined) => String(v ?? "").toLowerCase().replace(/^city of\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
  const role = scope.role ?? "contractor_electrical";
  const list = (client.partnerContacts ?? []).filter((p) => p.role === role);
  const ahjOk = (p: ClientPartnerContact) => !p.ahj || norm(p.ahj) === norm(scope.ahj);
  const portalOk = (p: ClientPartnerContact) => !p.portalType || p.portalType === scope.portalType;
  const rank = (p: ClientPartnerContact) => (p.ahj ? 2 : 0) + (p.portalType ? 1 : 0);
  return list.filter((p) => ahjOk(p) && portalOk(p)).sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

// Money-ish → number|null (0 is a valid service fee; blank clears to env default).
function moneyOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

// Maps incoming camelCase payload keys to DB columns. Only these fields are
// writable; id/createdAt are managed server-side.
const FIELD_COLUMNS: [keyof ClientRecord, string][] = [
  ["companyName", "company_name"],
  ["contactName", "contact_name"],
  ["contactEmail", "contact_email"],
  ["phone", "phone"],
  ["billingStatus", "billing_status"],
  ["notes", "notes"],
  ["legalBusinessName", "legal_business_name"],
  ["dba", "dba"],
  ["ccbLicenseNumber", "ccb_license_number"],
  ["standardDisconnectMake", "standard_disconnect_make"],
  ["standardDisconnectModel", "standard_disconnect_model"],
  ["ccbExpiration", "ccb_expiration"],
  ["electricalLicenseNumber", "electrical_license_number"],
  ["docketNumber", "docket_number"],
  ["metroCityLicenseNumber", "metro_city_license_number"],
  ["electricalSupervisorName", "electrical_supervisor_name"],
  ["electricianLicenseNumber", "electrician_license_number"],
  ["businessAddress", "business_address"],
  ["businessCity", "business_city"],
  ["businessState", "business_state"],
  ["businessZip", "business_zip"],
  ["businessPhone", "business_phone"],
  ["businessEmail", "business_email"],
  ["updatesInbox", "updates_inbox"],
  ["billingContactEmail", "billing_contact_email"],
  ["licenseState", "license_state"],
  ["insuranceExpiry", "insurance_expiry"],
  ["bondExpiry", "bond_expiry"],
  ["ein", "ein"],
  ["bondCarrier", "bond_carrier"],
  ["insuranceCarrier", "insurance_carrier"],
  ["authorizedSignerName", "authorized_signer_name"],
  ["authorizedSignerTitle", "authorized_signer_title"],
  ["billingMode", "billing_mode"],
  ["serviceFeeUsd", "service_fee_usd"],
];

// serviceFeeUsd is REAL; everything else is coerced to string.
function fieldValue(key: keyof ClientRecord, raw: unknown): string | number | null {
  return key === "serviceFeeUsd" ? moneyOrNull(raw) : s(raw);
}

function identitiesFor(db: AppDb, clientId: string): ClientPortalIdentity[] {
  return db
    .query<Row>("SELECT * FROM client_portal_identities WHERE client_id = ? ORDER BY created_at", [clientId])
    .map(mapIdentity);
}

/**
 * Clients in one tenant. This was an unfiltered `SELECT * FROM clients`, which handed
 * every company's id to anyone who could log in — and portal_credentials is keyed only
 * on client_id, so a leaked id was the route to another company's portal logins.
 * `null` reads across every org (superadmin).
 */
export function listClients(db: AppDb, orgId: string | null = DEFAULT_ORG_ID): ClientRecord[] {
  const rows = orgId
    ? db.query<Row>("SELECT * FROM clients WHERE org_id = ? ORDER BY company_name, created_at", [orgId])
    : db.query<Row>("SELECT * FROM clients ORDER BY company_name, created_at");
  return rows.map((row) => mapClient(row, identitiesFor(db, s(row.id))));
}

export function getClient(db: AppDb, clientId: string): ClientRecord {
  const row = db.get<Row>("SELECT * FROM clients WHERE id = ?", [clientId]);
  if (!row) throw new HttpError(404, "Client not found.");
  return mapClient(row, identitiesFor(db, clientId));
}

interface PortalIdentityInput {
  portalType?: string;
  installerCompanyLabel?: string;
  installerContactCode?: string;
  notes?: string;
}

function replaceIdentities(db: AppDb, clientId: string, identities: PortalIdentityInput[] | undefined): void {
  if (!Array.isArray(identities)) return;
  db.run("DELETE FROM client_portal_identities WHERE client_id = ?", [clientId]);
  for (const identity of identities) {
    const portalType = s(identity.portalType).trim();
    if (!portalType) continue;
    db.run(
      `INSERT INTO client_portal_identities
        (id, client_id, portal_type, installer_company_label, installer_contact_code, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id(),
        clientId,
        portalType,
        s(identity.installerCompanyLabel),
        s(identity.installerContactCode),
        s(identity.notes),
        nowIso(),
      ],
    );
  }
}

export function createClient(db: AppDb, payload: Record<string, unknown>, orgId: string = DEFAULT_ORG_ID): ClientRecord {
  const companyName = s(payload.companyName).trim() || s(payload.legalBusinessName).trim();
  if (!companyName) throw new HttpError(400, "companyName (or legalBusinessName) is required.");

  const clientId = id();
  const columns = ["id", "created_at", "org_id", ...FIELD_COLUMNS.map(([, col]) => col)];
  const values: (string | number | null)[] = [clientId, nowIso(), orgId, ...FIELD_COLUMNS.map(([key]) => fieldValue(key, payload[key]))];
  const placeholders = columns.map(() => "?").join(", ");

  return db.transaction(() => {
    db.run(`INSERT INTO clients (${columns.join(", ")}) VALUES (${placeholders})`, values);
    replaceIdentities(db, clientId, payload.portalIdentities as PortalIdentityInput[] | undefined);
    writeLicenceAndPartnerJson(db, clientId, payload);
    return getClient(db, clientId);
  });
}

export function updateClient(db: AppDb, clientId: string, payload: Record<string, unknown>): ClientRecord {
  const existing = db.get<Row>("SELECT id FROM clients WHERE id = ?", [clientId]);
  if (!existing) throw new HttpError(404, "Client not found.");

  // Only update fields present in the payload (partial update supported).
  const updates = FIELD_COLUMNS.filter(([key]) => key in payload);
  return db.transaction(() => {
    if (updates.length > 0) {
      const setClause = updates.map(([, col]) => `${col} = ?`).join(", ");
      const values: (string | number | null)[] = [...updates.map(([key]) => fieldValue(key, payload[key])), clientId];
      db.run(`UPDATE clients SET ${setClause} WHERE id = ?`, values);
    }
    if ("portalIdentities" in payload) {
      replaceIdentities(db, clientId, payload.portalIdentities as PortalIdentityInput[] | undefined);
    }
    writeLicenceAndPartnerJson(db, clientId, payload);
    return getClient(db, clientId);
  });
}

/** stateLicenses / partnerContacts: written only when present in the payload (partial update). */
function writeLicenceAndPartnerJson(db: AppDb, clientId: string, payload: Record<string, unknown>): void {
  if ("stateLicenses" in payload) db.run("UPDATE clients SET state_licenses_json = ? WHERE id = ?", [JSON.stringify(parseStateLicenses(payload.stateLicenses)), clientId]);
  if ("partnerContacts" in payload) db.run("UPDATE clients SET partner_contacts_json = ? WHERE id = ?", [JSON.stringify(parsePartnerContacts(payload.partnerContacts)), clientId]);
}

/**
 * The ORDINARY dashboard delete, and it stays deliberately hard.
 *
 * It removes a client that never carried work — identities, profiles, the row — and REFUSES
 * the moment a project is linked. That refusal is not a gap to route around: a misclick in a
 * client list must not be able to destroy a company's filings. A real departing customer
 * always has projects, so this path is never the one that offboards them; `offboardClient`
 * below is, and it is flagged, confirmed and audited precisely because it is the path that
 * can destroy everything. Keep the two apart.
 */
export function deleteClient(db: AppDb, clientId: string): { deleted: boolean } {
  const existing = db.get<Row>("SELECT id FROM clients WHERE id = ?", [clientId]);
  if (!existing) throw new HttpError(404, "Client not found.");
  const linked = db.get<{ count: number }>("SELECT COUNT(*) as count FROM projects WHERE client_id = ?", [clientId]);
  if (linked && Number(linked.count) > 0) {
    throw new HttpError(409, `Cannot delete client: ${linked.count} project(s) are still linked to it.`);
  }
  return db.transaction(() => {
    db.run("DELETE FROM client_portal_identities WHERE client_id = ?", [clientId]);
    db.run("DELETE FROM portal_profiles WHERE client_id = ?", [clientId]);
    db.run("DELETE FROM clients WHERE id = ?", [clientId]);
    return { deleted: true };
  });
}

// ===========================================================================
// OFFBOARDING — MAKING THE LEAVING PROMISE TRUE.
//
// The onboarding guide tells every customer, in "Your data": if you ever leave, change your
// portal passwords; WE THEN REMOVE YOUR CREDENTIALS, SESSIONS, PROJECTS AND DOCUMENTS FROM
// OUR LIVE SYSTEMS. Until this function that sentence was false in every clause. The only
// removal path was deleteClient above, which deletes three things — client_portal_identities,
// portal_profiles, the clients row — and refuses outright when any project is linked, which
// is every real departing customer. So a company could leave and we would still be holding,
// with no route that removed any of it:
//   - portal_credentials: their AES-256-GCM encrypted portal passwords, the single worst row
//     to keep, and the one deleteClient never touched even when it succeeded;
//   - portal-profiles/<clientId>/: LOGGED-IN Chrome sessions on disk — cookies that still
//     open their portal account, gitignored but not encrypted;
//   - every project, and through it every qc result, submission, correction and uploaded
//     document, i.e. their homeowners' names, addresses and plan sets;
//   - customers, their communications, and any per-client email source (whose IMAP password
//     is another encrypted secret).
//
// WHAT THIS NEVER DELETES, and this is a product decision, not an oversight: the pooled
// portal knowledge — portal_recipes, permit_utility_knowledge, jurisdiction_code_profiles,
// ahj_form_templates, cec_equipment. The guide draws exactly this line: your projects,
// homeowner records, documents and credentials are yours alone; how a portal behaves is
// pooled. What a departing customer's filings taught this system about an AHJ's portal stays,
// for everyone. The append-only draft ledger (data/portal-drafts.jsonl) stays too: it records
// drafts we left on a real portal account under that customer's licence, it carries username
// references and never a secret, and erasing it would erase the evidence of what still has to
// be cancelled on their side.
//
// ORDER MATTERS. We cannot invalidate a session we no longer hold, so the customer changes
// their portal passwords FIRST and we purge second. The CLI prints that back every run.
// ===========================================================================

/** The literal .env.example value counts as no key at all — cryptoStorage.ts treats it that
 *  way, and copying the example without editing it is indistinguishable from having none. */
const KEY_PLACEHOLDER = "replace-with-a-long-random-secret";

function sessionKeyState(): { ok: boolean; reason: string } {
  const raw = process.env.SESSION_ENCRYPTION_KEY || "";
  if (!raw) return { ok: false, reason: "SESSION_ENCRYPTION_KEY is unset" };
  if (raw === KEY_PLACEHOLDER) return { ok: false, reason: "SESSION_ENCRYPTION_KEY is still the .env.example placeholder" };
  return { ok: true, reason: "" };
}

/** Resolved the same way repository.ts resolves it for every live run — read, not guessed.
 *  If these two ever disagree the purge cleans a directory nobody writes to. */
function portalProfilesBase(): string {
  return process.env.PORTAL_PROFILES_DIR || path.join(process.cwd(), "portal-profiles");
}

/** Every browser profile under this client's tree. repository.ts nests them
 *  <base>/<clientId>/<portalType>/<host>, so the profiles are the leaves; a portalType
 *  directory with no host children (older layout) is itself a profile. */
function clientSessionDirs(clientRoot: string): string[] {
  const found: string[] = [];
  let level1: string[];
  try {
    if (!fs.existsSync(clientRoot)) return found;
    level1 = fs.readdirSync(clientRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return found; }
  for (const portalType of level1) {
    const typeDir = path.join(clientRoot, portalType);
    let hosts: string[] = [];
    try { hosts = fs.readdirSync(typeDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { /* unreadable — still counts as one profile below */ }
    if (hosts.length === 0) found.push(typeDir);
    else for (const host of hosts) found.push(path.join(typeDir, host));
  }
  return found;
}

/** What a purge would destroy. Printed before anything is touched, and returned by the dry
 *  run so the operator sees the shape of the damage before authorising it. */
export interface OffboardInventory {
  clientId: string;
  companyName: string;
  portalCredentials: number;
  /** Outstanding + spent one-time credential links (guide S4). A pending one is a live write
   *  path into a client we were told to forget. */
  credentialRequests: number;
  projects: number;
  documents: number;
  customers: number;
  communications: number;
  emailSources: number;
  portalIdentities: number;
  portalProfiles: number;
  /** Absolute paths of the logged-in browser profiles on disk. */
  sessionDirs: string[];
  /** The directory removed wholesale: <PORTAL_PROFILES_DIR>/<clientId>. */
  sessionRoot: string;
  /** False when SESSION_ENCRYPTION_KEY is unset or the placeholder — a purge refuses then. */
  sessionKeyOk: boolean;
}

export interface OffboardResult {
  /** True when nothing was written. The DEFAULT: a purge happens only on a matching confirm. */
  dryRun: boolean;
  inventory: OffboardInventory;
  /** Directories actually gone from disk. */
  sessionDirsRemoved: string[];
  /** Directories we FAILED to remove — a Chrome still holding the profile open is the usual
   *  cause on Windows. Never swallowed: "we removed your sessions" that silently didn't is
   *  the exact broken promise this function exists to fix. */
  sessionDirsFailed: { dir: string; error: string }[];
}

export interface OffboardOptions {
  /** The client id typed back. Absent → dry run. Present and different → refused outright,
   *  so a mistyped id can never purge the customer standing next to the intended one. */
  confirm?: string;
  /** Who ran it, for the audit row. */
  actor?: string;
}

export function offboardInventory(db: AppDb, clientId: string): OffboardInventory {
  const client = db.get<Row>("SELECT id, company_name FROM clients WHERE id = ?", [clientId]);
  if (!client) throw new HttpError(404, "Client not found.");
  const count = (sql: string): number => Number(db.get<{ n: number }>(sql, [clientId])?.n ?? 0);
  const sessionRoot = path.join(portalProfilesBase(), clientId);
  return {
    clientId,
    companyName: s(client.company_name),
    portalCredentials: count("SELECT COUNT(*) AS n FROM portal_credentials WHERE client_id = ?"),
    // Lazily-created table: a database older than the secure link has none, and the operator
    // should see 0 rather than the inventory throwing.
    credentialRequests: (() => {
      try { return count("SELECT COUNT(*) AS n FROM credential_requests WHERE client_id = ?"); }
      catch { return 0; }
    })(),
    projects: count("SELECT COUNT(*) AS n FROM projects WHERE client_id = ?"),
    documents: count(
      "SELECT COUNT(*) AS n FROM project_documents WHERE project_id IN (SELECT id FROM projects WHERE client_id = ?)",
    ),
    customers: count("SELECT COUNT(*) AS n FROM customers WHERE client_id = ?"),
    communications: Number(
      db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM communications
          WHERE customer_id IN (SELECT id FROM customers WHERE client_id = ?)
             OR project_id  IN (SELECT id FROM projects  WHERE client_id = ?)`,
        [clientId, clientId],
      )?.n ?? 0,
    ),
    emailSources: count("SELECT COUNT(*) AS n FROM email_tracking_sources WHERE client_id = ?"),
    portalIdentities: count("SELECT COUNT(*) AS n FROM client_portal_identities WHERE client_id = ?"),
    portalProfiles: count("SELECT COUNT(*) AS n FROM portal_profiles WHERE client_id = ?"),
    sessionDirs: clientSessionDirs(sessionRoot),
    sessionRoot,
    sessionKeyOk: sessionKeyState().ok,
  };
}

/**
 * Purge one departing customer, or report what a purge would take.
 *
 * Async because the project cascade lives in repository.ts, which statically imports THIS
 * file — the same circular-import guard jobQueue uses. Reusing deleteProject rather than
 * hand-writing twenty deletes is the point: that cascade already knows about the tables added
 * since (project_metrics, submission_payments, project_intake_requests) and unlinks documents
 * from disk, and it will keep knowing as the schema grows. A second copy here would rot, and
 * the rot would be silent — leftover homeowner rows nobody looks for.
 */
export async function offboardClient(db: AppDb, clientId: string, opts: OffboardOptions = {}): Promise<OffboardResult> {
  const inventory = offboardInventory(db, clientId);
  const confirm = s(opts.confirm).trim();

  // DRY RUN IS THE DEFAULT POSTURE. No confirm, no writes — not even an audit row.
  if (!confirm) return { dryRun: true, inventory, sessionDirsRemoved: [], sessionDirsFailed: [] };

  // A MISTYPED ID IS A REFUSAL, NOT A DRY RUN. Falling back to "report only" here would be
  // worse than throwing: the operator sees an inventory, believes the purge ran, and the
  // customer's credentials are still on disk. And the id they typed may be another live
  // customer's — that one must never be the row we act on either.
  if (confirm !== clientId) {
    throw new HttpError(
      400,
      `--confirm does not match the client being offboarded (got "${confirm}", expected "${clientId}"). ` +
      "Nothing was deleted. Re-run with the exact client id.",
    );
  }

  // REFUSE WITHOUT THE KEY. Half of what this destroys is AES-256-GCM ciphertext keyed by
  // SESSION_ENCRYPTION_KEY. Running without it means deleting credentials we cannot read,
  // so nothing can confirm afterwards what was held — and a run that cannot decrypt is a run
  // configured against the wrong environment, which is exactly when you do NOT want a purge.
  const key = sessionKeyState();
  if (!key.ok) {
    throw new HttpError(
      400,
      `${key.reason}. Refusing to offboard: this purge destroys secrets encrypted under that key, and a ` +
      "process that cannot read them is a process pointed at the wrong environment. Set it and re-run. " +
      "The dry run (omit --confirm) still reports the full inventory.",
    );
  }

  const { deleteProject } = await import("./repository");

  const projectIds = db
    .query<Row>("SELECT id FROM projects WHERE client_id = ?", [clientId])
    .map((row) => s(row.id));
  const customerIds = db
    .query<Row>("SELECT id FROM customers WHERE client_id = ?", [clientId])
    .map((row) => s(row.id));

  // COMMUNICATIONS FIRST, because both cascades below only UNLINK them: deleteProject NULLs
  // project_id and deleteCustomer NULLs customer_id, each so correspondence survives the
  // other's deletion. Run in that order on a departing customer and the row survives BOTH,
  // orphaned, still carrying the homeowner's name and the body of the email. For a purge
  // that is a leak, so they go here while they are still reachable.
  // Built from the client_id subqueries rather than an IN-list of collected ids: an empty
  // list renders as `IN ()`, which SQLite rejects outright, and a client with no customers
  // (or no projects) is the ordinary case, not an edge one.
  db.run(
    `DELETE FROM communications
      WHERE customer_id IN (SELECT id FROM customers WHERE client_id = ?)
         OR project_id  IN (SELECT id FROM projects  WHERE client_id = ?)`,
    [clientId, clientId],
  );

  // Per project, each committing on its own. NOT wrapped in one outer transaction on
  // purpose: deleteProject unlinks files from disk after its own commit, so a giant
  // enclosing transaction would delete plan sets and then roll the rows back. Independent
  // commits also mean a purge interrupted halfway is resumable — re-run it.
  for (const projectId of projectIds) deleteProject(db, projectId);

  // Customers: reuse the CRM cascade so project_id/communication unlinking stays in one place.
  for (const customerId of customerIds) deleteCustomer(db, customerId);

  db.transaction(() => {
    // THE MOST IMPORTANT ROW IN THIS FUNCTION. Everything else is recoverable-ish from a
    // backup; a portal password we kept after being told to delete it is the promise broken.
    db.run("DELETE FROM portal_credentials WHERE client_id = ?", [clientId]);
    // The one-time secure credential links (onboarding guide §4). A PENDING row is a live
    // write path into this client — a token that could still deposit a credential for a
    // customer we were told to forget — and a SPENT row still names the portals they file in.
    // Guarded because credentialRequests.ts creates this table lazily (no versioned
    // migration), so an older database genuinely has no such table and a bare DELETE throws
    // mid-transaction, which would abort the purge AFTER the projects were already gone.
    // Found by the guide audit: offboarding shipped an hour after the secure link and did not
    // know about it, so the §6 leaving promise failed for exactly the customers onboarded the
    // way the runbook recommends.
    try { db.run("DELETE FROM credential_requests WHERE client_id = ?", [clientId]); }
    catch { /* pre-secure-link database: no such table, nothing to purge */ }
    // Per-client IMAP sources carry imap_pass_encrypted — another live secret.
    db.run("DELETE FROM email_tracking_sources WHERE client_id = ?", [clientId]);
    db.run("DELETE FROM client_portal_identities WHERE client_id = ?", [clientId]);
    // portal_profiles.encrypted_storage_state is the DB half of the logged-in session.
    db.run("DELETE FROM portal_profiles WHERE client_id = ?", [clientId]);
    db.run("DELETE FROM clients WHERE id = ?", [clientId]);
  });

  // The ON-DISK half of the session: cookies that still open their portal account.
  const sessionDirsRemoved: string[] = [];
  const sessionDirsFailed: { dir: string; error: string }[] = [];
  if (fs.existsSync(inventory.sessionRoot)) {
    try {
      fs.rmSync(inventory.sessionRoot, { recursive: true, force: true });
      if (fs.existsSync(inventory.sessionRoot)) throw new Error("directory still present after removal");
      sessionDirsRemoved.push(...inventory.sessionDirs);
    } catch (err) {
      // Reported, never swallowed — a running Chrome holds these files open on Windows, and
      // the operator has to know the sessions are still there.
      sessionDirsFailed.push({ dir: inventory.sessionRoot, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Audit LAST, so it can name what actually happened on disk. project_id is null on purpose:
  // audit_logs' only foreign key is project_id, and every project this row describes has just
  // been deleted — a row pointing at one of them could not survive its own subject.
  addAuditLog(db, null, "human", s(opts.actor) || "offboard-company script", "client.offboarded", {
    clientId,
    companyName: inventory.companyName,
    purged: {
      portalCredentials: inventory.portalCredentials,
      projects: inventory.projects,
      documents: inventory.documents,
      customers: inventory.customers,
      communications: inventory.communications,
      emailSources: inventory.emailSources,
      portalIdentities: inventory.portalIdentities,
      portalProfiles: inventory.portalProfiles,
    },
    sessionRoot: inventory.sessionRoot,
    sessionDirsRemoved: sessionDirsRemoved.length,
    sessionDirsFailed: sessionDirsFailed.map((f) => f.dir),
    // Named in the audit row so a later reader knows the omission was a decision.
    sharedKnowledgeRetained: [
      "portal_recipes", "permit_utility_knowledge", "jurisdiction_code_profiles",
      "ahj_form_templates", "cec_equipment",
    ],
    at: nowIso(),
  });

  return { dryRun: false, inventory, sessionDirsRemoved, sessionDirsFailed };
}

// Returns the installer/licensing overlay for a project's linked client, keyed
// to the snapshot field names the portal adapters already read. Empty object
// when the project has no client.
//
// THE JOB IS REQUIRED: a licence is a state's and a permit's (licenceOverlay). On an Oregon job the
// licence keys are the named columns exactly as before; elsewhere ccbLicenseNumber is that state's
// licence for this track, never Oregon's CCB. `track` null = not known (a generic slot then takes
// the one contractor licence on file, or nothing when several could fit).
export function clientStagingOverlay(db: AppDb, clientId: string | null, portalType: string, job: { state: string; track: string | null }): Record<string, string> {
  if (!clientId) return {};
  const row = db.get<Row>("SELECT * FROM clients WHERE id = ?", [clientId]);
  if (!row) return {};
  const client = mapClient(row, identitiesFor(db, clientId));
  const identity = client.portalIdentities.find((entry) => entry.portalType === portalType);
  const licences = licenceOverlay(client, job);

  const overlay: Record<string, string> = {
    installerCompanyName: identity?.installerCompanyLabel || client.legalBusinessName || client.companyName,
    installerEmail: client.businessEmail || client.contactEmail,
    installerPhone: client.businessPhone || client.phone,
    installerAddress: [client.businessAddress, client.businessCity, client.businessState, client.businessZip]
      .filter(Boolean)
      .join(", "),
    installerStreet: client.businessAddress,
    // Separate parts too: portal contact forms ask for city / state / zip in their own
    // controls (ACA's Add-Contact dialog validates zip as exactly #####).
    // STANDARD AC DISCONNECT. Not on the plan set — the equipment schedule specifies only
    // the rating and leaves the part to the installer — but utility portals require a
    // make and model, so it is per-installer knowledge, defaulted here and overridable per
    // project by the parser. A cross-check warns when the plan set's rating contradicts it.
    disconnectMake: client.standardDisconnectMake || "",
    disconnectModel: client.standardDisconnectModel || "",
    installerCity: client.businessCity,
    installerState: client.businessState,
    installerZip: client.businessZip,
    ...phoneSegmentKeys("installerPhone", client.businessPhone || client.phone),
    installerCityStateZip:
      [client.businessCity, client.businessState].filter(Boolean).join(", ") +
      (client.businessZip ? ` ${client.businessZip}` : ""),
    installerContactName: client.contactName || client.authorizedSignerName,
    ccbLicenseNumber: licences.ccbLicenseNumber,
    // A LICENCE NUMBER WITHOUT ITS EXPIRY IS HALF AN ANSWER, AND THE OTHER HALF HAD NO KEY.
    //
    // Portals that ask for a contractor licence usually ask when it expires in the next box.
    // Nothing in RECIPE_FIELD_DESCRIPTIONS matched /expir/, so a recorded expiry could only be
    // frozen as an unbound literal — and recipeAdapter's cross-project guard then correctly
    // refuses it, because "2027-04-01" belongs to the company that was learned on. Measured in
    // paymentBoundary.dom.smoke: the licence expiration came out "". This is exactly the class
    // battery capacity was in before 55b5d24; the repair is the same one — give the value a
    // key, and the literal stops being its only carrier.
    // THE CHOSEN licence's expiry (licenceOverlay) — Oregon's CCB expiry on an Oregon job.
    ccbExpiration: licences.ccbExpiration,
    electricalLicenseNumber: licences.electricalLicenseNumber,
    docketNumber: client.docketNumber,
    metroCityLicenseNumber: client.metroCityLicenseNumber,
    electricalSupervisorName: licences.electricalSupervisorName,
    electricianLicenseNumber: licences.electricianLicenseNumber,
    constructionSupervisorLicenseNumber: licences.constructionSupervisorLicenseNumber,
    constructionSupervisorLicenseExpiration: licences.constructionSupervisorLicenseExpiration,
    homeImprovementLicenseNumber: licences.homeImprovementLicenseNumber,
    homeImprovementLicenseExpiration: licences.homeImprovementLicenseExpiration,
    authorizedSignerName: client.authorizedSignerName,
    authorizedSignerTitle: client.authorizedSignerTitle,
  };
  if (identity?.installerContactCode) {
    overlay.powerclerkExistingContact = identity.installerContactCode;
    overlay.accelaContactCode = identity.installerContactCode;
  }
  // Drop empties so we never overwrite real snapshot values with blanks.
  return Object.fromEntries(Object.entries(overlay).filter(([, v]) => v));
}
