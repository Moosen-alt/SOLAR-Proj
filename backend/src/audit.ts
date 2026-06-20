import type { AppDb } from "./db";
import { id } from "./ids";
import { asJson } from "./json";
import { nowIso } from "./time";
import type { AuditLog } from "../../shared/src/types";

export function addAuditLog(
  db: AppDb,
  projectId: string | null,
  actorType: AuditLog["actorType"],
  actorName: string,
  action: string,
  details: Record<string, unknown> = {},
): void {
  db.run(
    `INSERT INTO audit_logs (id, project_id, actor_type, actor_name, action, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id(), projectId, actorType, actorName, action, asJson(details), nowIso()],
  );
}

