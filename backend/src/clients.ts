import type { ClientPortalIdentity, ClientRecord } from "../../shared/src/types";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { nowIso } from "./time";

type Row = Record<string, unknown>;

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

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
    ccbExpiration: s(row.ccb_expiration),
    electricalLicenseNumber: s(row.electrical_license_number),
    electricalSupervisorName: s(row.electrical_supervisor_name),
    businessAddress: s(row.business_address),
    businessCity: s(row.business_city),
    businessState: s(row.business_state),
    businessZip: s(row.business_zip),
    businessPhone: s(row.business_phone),
    businessEmail: s(row.business_email),
    ein: s(row.ein),
    bondCarrier: s(row.bond_carrier),
    insuranceCarrier: s(row.insurance_carrier),
    authorizedSignerName: s(row.authorized_signer_name),
    authorizedSignerTitle: s(row.authorized_signer_title),
    portalIdentities: identities,
    createdAt: s(row.created_at),
  };
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
  ["ccbExpiration", "ccb_expiration"],
  ["electricalLicenseNumber", "electrical_license_number"],
  ["electricalSupervisorName", "electrical_supervisor_name"],
  ["businessAddress", "business_address"],
  ["businessCity", "business_city"],
  ["businessState", "business_state"],
  ["businessZip", "business_zip"],
  ["businessPhone", "business_phone"],
  ["businessEmail", "business_email"],
  ["ein", "ein"],
  ["bondCarrier", "bond_carrier"],
  ["insuranceCarrier", "insurance_carrier"],
  ["authorizedSignerName", "authorized_signer_name"],
  ["authorizedSignerTitle", "authorized_signer_title"],
];

function identitiesFor(db: AppDb, clientId: string): ClientPortalIdentity[] {
  return db
    .query<Row>("SELECT * FROM client_portal_identities WHERE client_id = ? ORDER BY created_at", [clientId])
    .map(mapIdentity);
}

export function listClients(db: AppDb): ClientRecord[] {
  const rows = db.query<Row>("SELECT * FROM clients ORDER BY company_name, created_at");
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

export function createClient(db: AppDb, payload: Record<string, unknown>): ClientRecord {
  const companyName = s(payload.companyName).trim() || s(payload.legalBusinessName).trim();
  if (!companyName) throw new HttpError(400, "companyName (or legalBusinessName) is required.");

  const clientId = id();
  const columns = ["id", "created_at", ...FIELD_COLUMNS.map(([, col]) => col)];
  const values: (string | null)[] = [clientId, nowIso(), ...FIELD_COLUMNS.map(([key]) => s(payload[key]))];
  const placeholders = columns.map(() => "?").join(", ");

  return db.transaction(() => {
    db.run(`INSERT INTO clients (${columns.join(", ")}) VALUES (${placeholders})`, values);
    replaceIdentities(db, clientId, payload.portalIdentities as PortalIdentityInput[] | undefined);
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
      const values: (string | null)[] = [...updates.map(([key]) => s(payload[key])), clientId];
      db.run(`UPDATE clients SET ${setClause} WHERE id = ?`, values);
    }
    if ("portalIdentities" in payload) {
      replaceIdentities(db, clientId, payload.portalIdentities as PortalIdentityInput[] | undefined);
    }
    return getClient(db, clientId);
  });
}

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

// Returns the installer/licensing overlay for a project's linked client, keyed
// to the snapshot field names the portal adapters already read. Empty object
// when the project has no client.
export function clientStagingOverlay(db: AppDb, clientId: string | null, portalType: string): Record<string, string> {
  if (!clientId) return {};
  const row = db.get<Row>("SELECT * FROM clients WHERE id = ?", [clientId]);
  if (!row) return {};
  const client = mapClient(row, identitiesFor(db, clientId));
  const identity = client.portalIdentities.find((entry) => entry.portalType === portalType);

  const overlay: Record<string, string> = {
    installerCompanyName: identity?.installerCompanyLabel || client.legalBusinessName || client.companyName,
    installerEmail: client.businessEmail || client.contactEmail,
    installerPhone: client.businessPhone || client.phone,
    installerAddress: [client.businessAddress, client.businessCity, client.businessState, client.businessZip]
      .filter(Boolean)
      .join(", "),
    installerStreet: client.businessAddress,
    installerCityStateZip:
      [client.businessCity, client.businessState].filter(Boolean).join(", ") +
      (client.businessZip ? ` ${client.businessZip}` : ""),
    installerContactName: client.contactName || client.authorizedSignerName,
    ccbLicenseNumber: client.ccbLicenseNumber,
    electricalLicenseNumber: client.electricalLicenseNumber,
    electricalSupervisorName: client.electricalSupervisorName,
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
