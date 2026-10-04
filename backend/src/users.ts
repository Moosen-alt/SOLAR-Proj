import type { AppDb, SqlParam } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { ADMIN_ROLES, ALL_ROLES, ROLE_OPERATOR, ROLE_SUPERADMIN } from "./auth";
import { HttpError } from "./httpError";
import { correctionOverdueSql } from "./kpi";
import { nowIso } from "./time";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: string;
  color: string;
  active: boolean;
  createdAt: string;
  orgId: string;
}

type Row = Record<string, SqlParam>;

function mapUser(row: Row): UserRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    role: String(row.role ?? ROLE_OPERATOR),
    color: String(row.color ?? "#6366f1"),
    active: Boolean(row.active),
    createdAt: String(row.created_at),
    orgId: String(row.org_id || DEFAULT_ORG_ID),
  };
}

/** Users in one tenant. Was an unfiltered SELECT *, so every org's staff list —
 *  names and email addresses — was readable by anyone who could log in. */
export function listUsers(db: AppDb, orgId: string | null = DEFAULT_ORG_ID): UserRecord[] {
  return orgId
    ? db.query<Row>("SELECT * FROM users WHERE org_id = ? ORDER BY name ASC", [orgId]).map(mapUser)
    : db.query<Row>("SELECT * FROM users ORDER BY name ASC").map(mapUser);
}

export function getUser(db: AppDb, userId: string, orgId?: string): UserRecord | null {
  const row = orgId
    ? db.get<Row>("SELECT * FROM users WHERE id = ? AND org_id = ?", [userId, orgId])
    : db.get<Row>("SELECT * FROM users WHERE id = ?", [userId]);
  return row ? mapUser(row) : null;
}

export function createUser(
  db: AppDb,
  input: { name: string; email: string; role?: string; color?: string; orgId?: string },
): UserRecord {
  const id = crypto.randomUUID();
  const ts = nowIso();
  // A caller can only ever create an operator here. Elevated roles are granted
  // deliberately through updateUser by someone who already holds one — creation is
  // not a back door around that check.
  db.run(
    "INSERT INTO users (id, name, email, role, color, active, created_at, org_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    [id, input.name.trim(), input.email.trim().toLowerCase(), ROLE_OPERATOR, input.color || "#6366f1", ts, input.orgId || DEFAULT_ORG_ID],
  );
  return getUser(db, id)!;
}

export function updateUser(
  db: AppDb,
  userId: string,
  input: { name?: string; email?: string; role?: string; color?: string; active?: boolean },
  /** Who is making this change. Required to alter a role; omit for system callers. */
  actor?: { role: string; orgId: string; id: string } | null,
): UserRecord {
  const user = getUser(db, userId, actor ? actor.orgId : undefined);
  if (!user) throw new Error(`User ${userId} not found`);

  // ROLE ESCALATION. This function used to accept `role` from anyone: PUT
  // /api/users/:id had no authorization at all, so any authenticated user could
  // POST themselves role:"admin" and then administer orgs, licences and users.
  let role = user.role;
  if (input.role !== undefined && input.role !== user.role) {
    if (!ALL_ROLES.includes(input.role)) throw new HttpError(400, `Unknown role: ${input.role}.`);
    if (!actor || !ADMIN_ROLES.has(actor.role)) {
      throw new HttpError(403, "Only an admin can change a user's role.");
    }
    // Superadmin is the cross-org role; it can only be granted by someone who
    // already holds it, so an org admin can never mint one.
    if (input.role === ROLE_SUPERADMIN && actor.role !== ROLE_SUPERADMIN) {
      throw new HttpError(403, "Only a superadmin can grant the superadmin role.");
    }
    // Nobody edits their own role, in either direction — that closes self-promotion
    // and stops the last superadmin from accidentally demoting themselves.
    if (actor.id === userId) throw new HttpError(403, "You cannot change your own role.");
    role = input.role;
  }

  db.run(
    "UPDATE users SET name = ?, email = ?, role = ?, color = ?, active = ? WHERE id = ?",
    [
      input.name ?? user.name,
      input.email ?? user.email,
      role,
      input.color ?? user.color,
      input.active !== undefined ? (input.active ? 1 : 0) : (user.active ? 1 : 0),
      userId,
    ],
  );
  return getUser(db, userId)!;
}

/** Assign a project to a user. Both must be in `orgId` — otherwise this was a way to
 *  hand another tenant's job to your own staff (or to name a stranger as its owner). */
export function assignProjectToUser(db: AppDb, projectId: string, userId: string | null, orgId: string = DEFAULT_ORG_ID): void {
  const project = db.get<Row>("SELECT id FROM projects WHERE id = ? AND org_id = ?", [projectId, orgId]);
  if (!project) throw new HttpError(404, "Project not found.");
  if (userId && !db.get<Row>("SELECT id FROM users WHERE id = ? AND org_id = ?", [userId, orgId])) {
    throw new HttpError(400, "That user is not in this organization.");
  }
  db.run("UPDATE projects SET assigned_user_id = ?, updated_at = ? WHERE id = ?", [userId, nowIso(), projectId]);
  db.run(
    `INSERT INTO project_metrics (project_id, assigned_user_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET assigned_user_id = excluded.assigned_user_id, updated_at = excluded.updated_at`,
    [projectId, userId, nowIso()],
  );
}

export function getUserWorkload(db: AppDb, orgId: string | null = DEFAULT_ORG_ID): Array<{
  user: UserRecord;
  openProjects: number;
  openCorrections: number;
  overdueCorrections: number;
  pendingReviews: number;
}> {
  const users = listUsers(db, orgId).filter((u) => u.active);
  const today = new Date().toISOString().slice(0, 10);

  return users.map((user) => {
    const openProjects = Number(
      db.get<Row>(
        `SELECT COUNT(*) as cnt FROM projects WHERE assigned_user_id = ?${orgId ? " AND org_id = ?" : ""} AND status NOT IN ('pto_granted','cancelled','archived')`,
        orgId ? [user.id, orgId] : [user.id],
      )?.cnt ?? 0,
    );
    const openCorrections = Number(
      db.get<Row>(
        `SELECT COUNT(*) as cnt FROM corrections c JOIN projects p ON c.project_id = p.id WHERE p.assigned_user_id = ?${orgId ? " AND p.org_id = ?" : ""} AND c.closed_at IS NULL`,
        orgId ? [user.id, orgId] : [user.id],
      )?.cnt ?? 0,
    );
    const overdueCorrections = Number(
      db.get<Row>(
        `SELECT COUNT(*) as cnt FROM corrections c JOIN projects p ON c.project_id = p.id
         WHERE p.assigned_user_id = ?${orgId ? " AND p.org_id = ?" : ""} AND c.closed_at IS NULL
           AND ${correctionOverdueSql("c")}`, // the one overdue clock (#58)
        orgId ? [user.id, orgId, today, today] : [user.id, today, today],
      )?.cnt ?? 0,
    );
    const pendingReviews = Number(
      db.get<Row>(
        `SELECT COUNT(*) as cnt FROM human_review_items h JOIN projects p ON h.project_id = p.id WHERE p.assigned_user_id = ?${orgId ? " AND p.org_id = ?" : ""} AND h.status = 'pending'`,
        orgId ? [user.id, orgId] : [user.id],
      )?.cnt ?? 0,
    );
    return { user, openProjects, openCorrections, overdueCorrections, pendingReviews };
  });
}
