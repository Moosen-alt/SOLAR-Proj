import crypto from "node:crypto";
import type { AppDb, SqlParam } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { nowIso } from "./time";

type Row = Record<string, SqlParam>;

// ---------------------------------------------------------------------------
// Customers / leads
// ---------------------------------------------------------------------------

export interface CustomerRecord {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  leadSource: string;
  leadStage: string;
  clientId: string | null;
  assignedUserId: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

function mapCustomer(row: Row): CustomerRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? ""),
    address: String(row.address ?? ""),
    city: String(row.city ?? ""),
    state: String(row.state ?? ""),
    zip: String(row.zip ?? ""),
    leadSource: String(row.lead_source ?? ""),
    leadStage: String(row.lead_stage ?? "new_lead"),
    clientId: row.client_id ? String(row.client_id) : null,
    assignedUserId: row.assigned_user_id ? String(row.assigned_user_id) : null,
    notes: String(row.notes ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listCustomers(db: AppDb, opts: { stage?: string; search?: string; orgId?: string | null } = {}): CustomerRecord[] {
  const where: string[] = [];
  const params: SqlParam[] = [];
  // Tenant scope first. `orgId: null` is the explicit superadmin bypass; omitting it
  // means the default tenant, so a caller who forgets sees one org rather than every
  // company's lead list.
  const scopeOrgId = opts.orgId === null ? null : (opts.orgId || DEFAULT_ORG_ID);
  if (scopeOrgId) { where.push("org_id = ?"); params.push(scopeOrgId); }
  if (opts.stage) {
    where.push("lead_stage = ?");
    params.push(opts.stage);
  }
  if (opts.search) {
    where.push("(name LIKE ? OR email LIKE ? OR phone LIKE ? OR address LIKE ?)");
    const like = `%${opts.search}%`;
    params.push(like, like, like, like);
  }
  const sql = `SELECT * FROM customers ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC`;
  return db.query<Row>(sql, params).map(mapCustomer);
}

export function getCustomer(db: AppDb, id: string): CustomerRecord | null {
  const row = db.get<Row>("SELECT * FROM customers WHERE id = ?", [id]);
  return row ? mapCustomer(row) : null;
}

type CustomerInput = Partial<Omit<CustomerRecord, "id" | "createdAt" | "updatedAt">>;

export function createCustomer(db: AppDb, input: CustomerInput, orgId: string = DEFAULT_ORG_ID): CustomerRecord {
  const id = crypto.randomUUID();
  const ts = nowIso();
  db.run(
    `INSERT INTO customers
      (id, name, email, phone, address, city, state, zip, lead_source, lead_stage, client_id, assigned_user_id, notes, created_at, updated_at, org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      (input.name ?? "").trim(),
      (input.email ?? "").trim(),
      (input.phone ?? "").trim(),
      input.address ?? "",
      input.city ?? "",
      input.state ?? "",
      input.zip ?? "",
      input.leadSource ?? "",
      input.leadStage ?? "new_lead",
      input.clientId ?? null,
      input.assignedUserId ?? null,
      input.notes ?? "",
      ts,
      ts,
      orgId,
    ],
  );
  return getCustomer(db, id)!;
}

export function updateCustomer(db: AppDb, id: string, input: CustomerInput): CustomerRecord {
  const existing = getCustomer(db, id);
  if (!existing) throw new Error(`Customer ${id} not found`);
  const merged = { ...existing, ...input };
  db.run(
    `UPDATE customers SET name = ?, email = ?, phone = ?, address = ?, city = ?, state = ?, zip = ?,
       lead_source = ?, lead_stage = ?, client_id = ?, assigned_user_id = ?, notes = ?, updated_at = ?
     WHERE id = ?`,
    [
      merged.name,
      merged.email,
      merged.phone,
      merged.address,
      merged.city,
      merged.state,
      merged.zip,
      merged.leadSource,
      merged.leadStage,
      merged.clientId,
      merged.assignedUserId,
      merged.notes,
      nowIso(),
      id,
    ],
  );
  return getCustomer(db, id)!;
}

export function deleteCustomer(db: AppDb, id: string): void {
  db.run("UPDATE communications SET customer_id = NULL WHERE customer_id = ?", [id]);
  db.run("UPDATE projects SET customer_id = NULL WHERE customer_id = ?", [id]);
  db.run("DELETE FROM customers WHERE id = ?", [id]);
}

// ---------------------------------------------------------------------------
// Communication log
// ---------------------------------------------------------------------------

export interface CommunicationRecord {
  id: string;
  customerId: string | null;
  projectId: string | null;
  direction: string;
  channel: string;
  subject: string;
  body: string;
  loggedBy: string;
  occurredAt: string;
  createdAt: string;
}

function mapComm(row: Row): CommunicationRecord {
  return {
    id: String(row.id),
    customerId: row.customer_id ? String(row.customer_id) : null,
    projectId: row.project_id ? String(row.project_id) : null,
    direction: String(row.direction ?? "outbound"),
    channel: String(row.channel ?? "note"),
    subject: String(row.subject ?? ""),
    body: String(row.body ?? ""),
    loggedBy: String(row.logged_by ?? ""),
    occurredAt: String(row.occurred_at),
    createdAt: String(row.created_at),
  };
}

export function listCommunications(
  db: AppDb,
  filter: { customerId?: string; projectId?: string },
): CommunicationRecord[] {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (filter.customerId) {
    where.push("customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.projectId) {
    where.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (!where.length) return [];
  return db
    .query<Row>(`SELECT * FROM communications WHERE ${where.join(" OR ")} ORDER BY occurred_at DESC`, params)
    .map(mapComm);
}

export function addCommunication(
  db: AppDb,
  input: {
    customerId?: string | null;
    projectId?: string | null;
    direction?: string;
    channel?: string;
    subject?: string;
    body?: string;
    loggedBy?: string;
    occurredAt?: string;
  },
): CommunicationRecord {
  const id = crypto.randomUUID();
  const ts = nowIso();
  db.run(
    `INSERT INTO communications
      (id, customer_id, project_id, direction, channel, subject, body, logged_by, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.customerId ?? null,
      input.projectId ?? null,
      input.direction || "outbound",
      input.channel || "note",
      input.subject ?? "",
      input.body ?? "",
      input.loggedBy ?? "",
      input.occurredAt || ts,
      ts,
    ],
  );
  return mapComm(db.get<Row>("SELECT * FROM communications WHERE id = ?", [id])!);
}
