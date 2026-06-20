import type { AppDb, SqlParam } from "./db";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: string;
  color: string;
  active: boolean;
  createdAt: string;
}

type Row = Record<string, SqlParam>;

function mapUser(row: Row): UserRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    role: String(row.role ?? "operator"),
    color: String(row.color ?? "#6366f1"),
    active: Boolean(row.active),
    createdAt: String(row.created_at),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export function listUsers(db: AppDb): UserRecord[] {
  return db.query<Row>("SELECT * FROM users ORDER BY name ASC").map(mapUser);
}

export function getUser(db: AppDb, userId: string): UserRecord | null {
  const row = db.get<Row>("SELECT * FROM users WHERE id = ?", [userId]);
  return row ? mapUser(row) : null;
}

export function createUser(
  db: AppDb,
  input: { name: string; email: string; role?: string; color?: string },
): UserRecord {
  const id = crypto.randomUUID();
  const ts = nowIso();
  db.run(
    "INSERT INTO users (id, name, email, role, color, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    [id, input.name.trim(), input.email.trim().toLowerCase(), input.role || "operator", input.color || "#6366f1", ts],
  );
  return getUser(db, id)!;
}

export function updateUser(
  db: AppDb,
  userId: string,
  input: { name?: string; email?: string; role?: string; color?: string; active?: boolean },
): UserRecord {
  const user = getUser(db, userId);
  if (!user) throw new Error(`User ${userId} not found`);
  db.run(
    "UPDATE users SET name = ?, email = ?, role = ?, color = ?, active = ? WHERE id = ?",
    [
      input.name ?? user.name,
      input.email ?? user.email,
      input.role ?? user.role,
      input.color ?? user.color,
      input.active !== undefined ? (input.active ? 1 : 0) : (user.active ? 1 : 0),
      userId,
    ],
  );
  return getUser(db, userId)!;
}

export function assignProjectToUser(db: AppDb, projectId: string, userId: string | null): void {
  db.run("UPDATE projects SET assigned_user_id = ?, updated_at = ? WHERE id = ?", [userId, nowIso(), projectId]);
  db.run(
    `INSERT INTO project_metrics (project_id, assigned_user_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET assigned_user_id = excluded.assigned_user_id, updated_at = excluded.updated_at`,
    [projectId, userId, nowIso()],
  );
}

export function getUserWorkload(db: AppDb): Array<{
  user: UserRecord;
  openProjects: number;
  openCorrections: number;
  overdueCorrections: number;
  pendingReviews: number;
}> {
  const users = listUsers(db).filter((u) => u.active);
  const today = new Date().toISOString().slice(0, 10);

  return users.map((user) => {
    const openProjects = Number(
      db.get<Row>(
        "SELECT COUNT(*) as cnt FROM projects WHERE assigned_user_id = ? AND status NOT IN ('pto_granted','cancelled','archived')",
        [user.id],
      )?.cnt ?? 0,
    );
    const openCorrections = Number(
      db.get<Row>(
        "SELECT COUNT(*) as cnt FROM corrections c JOIN projects p ON c.project_id = p.id WHERE p.assigned_user_id = ? AND c.closed_at IS NULL",
        [user.id],
      )?.cnt ?? 0,
    );
    const overdueCorrections = Number(
      db.get<Row>(
        `SELECT COUNT(*) as cnt FROM corrections c JOIN projects p ON c.project_id = p.id
         WHERE p.assigned_user_id = ? AND c.closed_at IS NULL
           AND (c.due_at < ? OR (c.due_at IS NULL AND date(c.created_at, '+' || c.sla_days || ' days') < ?))`,
        [user.id, today, today],
      )?.cnt ?? 0,
    );
    const pendingReviews = Number(
      db.get<Row>(
        "SELECT COUNT(*) as cnt FROM human_review_items h JOIN projects p ON h.project_id = p.id WHERE p.assigned_user_id = ? AND h.status = 'pending'",
        [user.id],
      )?.cnt ?? 0,
    );
    return { user, openProjects, openCorrections, overdueCorrections, pendingReviews };
  });
}
