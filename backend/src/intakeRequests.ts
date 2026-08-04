import { randomUUID } from "node:crypto";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { getProjectDetail, updateProject } from "./repository";
import { resolveValuation } from "./valuation";
import { nowIso } from "./time";

// Per-project client intake requests.
//
// When a submittal needs data that isn't on the uploaded documents — project
// valuation (contract cost), homeowner email, homeowner phone — we generate a
// tokenized, no-login link. The installer opens it, sees only the missing fields
// pre-filled with whatever we know, and submits. Answers write straight to the
// project snapshot via updateProject().
//
// SECURITY: the public form exposes ONLY the requested submittal fields plus the
// homeowner name + address (so the client knows which project it is). It never
// exposes utility account/meter numbers, portal credentials, or internal status.

export type IntakeField = "jobValue" | "homeownerEmail" | "homeownerPhone";

const FIELD_LABELS: Record<IntakeField, string> = {
  jobValue: "Project contract / installed cost (USD)",
  homeownerEmail: "Homeowner email",
  homeownerPhone: "Homeowner phone",
};

const ALL_FIELDS: IntakeField[] = ["jobValue", "homeownerEmail", "homeownerPhone"];

interface IntakeRow {
  id: string;
  project_id: string;
  token: string;
  fields_json: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

/** Which submittal fields are still missing for a project (default request set). */
export function missingIntakeFields(db: AppDb, projectId: string): IntakeField[] {
  const snap = getProjectDetail(db, projectId).project.parserSnapshot || {};
  const missing: IntakeField[] = [];
  const valuation = resolveValuation(snap, getProjectDetail(db, projectId).project.systemSizeDcKw);
  if (valuation.method !== "contract") missing.push("jobValue");
  if (!str(snap.homeownerEmail)) missing.push("homeownerEmail");
  if (!str(snap.homeownerPhone)) missing.push("homeownerPhone");
  return missing;
}

/** Create (or reuse a pending) intake request for a project. Returns token + URL path. */
export function createIntakeRequest(
  db: AppDb,
  projectId: string,
  opts: { fields?: IntakeField[]; createdBy?: string; expiresInDays?: number } = {},
): { id: string; token: string; path: string; fields: IntakeField[] } {
  const project = getProjectDetail(db, projectId).project; // throws 404 if missing

  const fields = (opts.fields && opts.fields.length ? opts.fields : missingIntakeFields(db, projectId))
    .filter((f): f is IntakeField => ALL_FIELDS.includes(f));
  const requestFields = fields.length ? fields : ALL_FIELDS;

  // Reuse an existing pending request so re-clicking doesn't spawn duplicates.
  const existing = db.get<IntakeRow>(
    "SELECT * FROM project_intake_requests WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [projectId],
  );
  if (existing) {
    db.run("UPDATE project_intake_requests SET fields_json = ? WHERE id = ?", [
      JSON.stringify(requestFields),
      existing.id,
    ]);
    return { id: existing.id, token: existing.token, path: `/intake?token=${existing.token}`, fields: requestFields };
  }

  const id = randomUUID();
  const token = randomUUID();
  const now = nowIso();
  const expiresAt = opts.expiresInDays
    ? new Date(Date.now() + opts.expiresInDays * 86400_000).toISOString()
    : null;
  db.run(
    `INSERT INTO project_intake_requests (id, project_id, token, fields_json, status, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [id, projectId, token, JSON.stringify(requestFields), opts.createdBy ?? "", now, expiresAt],
  );
  return { id, token, path: `/intake?token=${token}`, fields: requestFields };
}

/** Public view of an intake request (no sensitive data). Throws if invalid/expired. */
export function getIntakeRequestPublic(db: AppDb, token: string): {
  status: string;
  projectLabel: string;
  fields: Array<{ key: IntakeField; label: string; value: string }>;
} {
  const row = db.get<IntakeRow>("SELECT * FROM project_intake_requests WHERE token = ?", [token]);
  if (!row) throw new HttpError(404, "Intake link not found.");
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    throw new HttpError(410, "This intake link has expired. Ask your permit coordinator for a new one.");
  }

  const project = getProjectDetail(db, row.project_id).project;
  const snap = project.parserSnapshot || {};
  const fields = (JSON.parse(row.fields_json) as IntakeField[]).filter((f) => ALL_FIELDS.includes(f));

  return {
    status: row.status,
    projectLabel: [project.homeownerName, project.projectAddress].filter(Boolean).join(" — ") || "Solar project",
    fields: fields.map((key) => ({ key, label: FIELD_LABELS[key], value: str(snap[key]) })),
  };
}

/** Submit answers to a public intake request — writes to the project snapshot. */
export function submitIntakeRequest(
  db: AppDb,
  token: string,
  answers: Record<string, unknown>,
): { ok: true; projectId: string } {
  const row = db.get<IntakeRow>("SELECT * FROM project_intake_requests WHERE token = ?", [token]);
  if (!row) throw new HttpError(404, "Intake link not found.");
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    throw new HttpError(410, "This intake link has expired.");
  }

  const fields = (JSON.parse(row.fields_json) as IntakeField[]).filter((f) => ALL_FIELDS.includes(f));
  const payload: Record<string, unknown> = {};
  for (const key of fields) {
    const raw = answers[key];
    if (raw == null || String(raw).trim() === "") continue;
    payload[key] = String(raw).trim();
  }
  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, "No values provided.");
  }

  const firstCompletion = row.status !== "completed";
  updateProject(db, row.project_id, payload);
  db.run("UPDATE project_intake_requests SET status = 'completed', completed_at = ? WHERE id = ?", [
    nowIso(),
    row.id,
  ]);
  // The installer just supplied missing data — re-drive the project toward the
  // approval gate without waiting for an operator click. Only on the FIRST
  // completion: this endpoint is public (token-auth only), so repeat posts to
  // the same link must not keep triggering automation runs.
  if (firstCompletion) {
    void import("./autopilot").then(({ maybeResumeAutopilot }) => maybeResumeAutopilot(db, row.project_id)).catch(() => null);
  }
  return { ok: true, projectId: row.project_id };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}
