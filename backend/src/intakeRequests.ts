import { randomUUID } from "node:crypto";
import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { HttpError } from "./httpError";
import { getProjectDetail, updateProject } from "./repository";
import { resolveValuation } from "./valuation";
import { nowIso } from "./time";
import { logger } from "./logger";

// Per-project client intake requests.
//
// When a submittal needs data that isn't on the uploaded documents — project
// valuation (contract cost), homeowner email, homeowner phone — we generate a
// tokenized, no-login link. The installer opens it, sees only the missing fields
// pre-filled with whatever we know, and submits. Answers write straight to the
// project snapshot via updateProject().
//
// PORTAL QUESTIONS: on top of the fixed field list, each request carries the
// portal's own per-job questions this project cannot answer yet (financing/
// ownership, community-solar participation, …) sourced from the shared portal
// question bank. The portal detected for the project decides which questions are
// asked — "if PGE detected, ask PGE questions". The installer answers with
// EXACTLY the portal's options (no free text; classified questions are rigid),
// and the answer lands in the project column the binding names. Only the
// question TEXT/classification is shared knowledge; every answer is project
// data, org-scoped through the project.
//
// SECURITY: the public form exposes ONLY the requested submittal fields plus the
// homeowner name + address (so the client knows which project it is). It never
// exposes utility account/meter numbers, portal credentials, or internal status.
// Portal questions bound to portal-identity keys (state/ahj/utility — they
// decide WHICH portal a filing goes to) or secret-shaped keys are refused at
// append time AND at read time, so a no-login token can never repoint a filing
// or echo a secret.

export type IntakeField = "jobValue" | "homeownerEmail" | "homeownerPhone";

const FIELD_LABELS: Record<IntakeField, string> = {
  jobValue: "Project contract / installed cost (USD)",
  homeownerEmail: "Homeowner email",
  homeownerPhone: "Homeowner phone",
};

const ALL_FIELDS: IntakeField[] = ["jobValue", "homeownerEmail", "homeownerPhone"];

// ---------------------------------------------------------------------------
// Portal per-job questions (build on the shared question bank).
// ---------------------------------------------------------------------------

/** One per-job question a portal asks that the project record cannot answer.
 *  `key` is the binding the answer lands in (a project snapshot key); `label` is
 *  the portal's own wording; `options` are exactly the portal's choices. */
export interface PortalIntakeQuestion {
  key: string;
  label: string;
  options: string[];
  portalType?: string;
  /** Set when the installer explicitly answered "I'm not sure" — the operator
   *  resolves it instead of the automation guessing. */
  unsure?: boolean;
}

/** Sentinel answer value: "I'm not sure — ask my coordinator". Never written to
 *  the project; marks the question for the operator instead of guessing. */
export const INTAKE_UNSURE = "__unsure__";

// Keys a public token-holder must never write or see echoed. state/ahj/utility
// decide WHICH PORTAL a filing goes to (updateProject honors them when given —
// see the identity guard there); account/meter numbers are exactly what the
// SECURITY note above promises never to expose on this form.
const PUBLIC_KEY_DENYLIST = new Set(["state", "ahj", "utility", "accountNumber", "meterNumber", "clientId", "client_id"]);
const SECRET_KEY_PATTERN = /password|secret|token|ssn|social|credential|account|meter/i;
// Binding names are code identifiers, not prose — reject anything else so a
// corrupt/malicious shared-bank row can never smuggle SQL or markup via a key.
const BINDING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function publicSafeQuestionKey(key: string): boolean {
  return BINDING_KEY_PATTERN.test(key) && !PUBLIC_KEY_DENYLIST.has(key) && !SECRET_KEY_PATTERN.test(key);
}

// The per-job answer COLUMNS (migration v17). resolveRecipeFieldValues reads the
// column directly ("an answer the intake link wrote five minutes ago must reach
// replay either way" — portalRecipes.ts), so an intake answer bound to one of
// these lands in the column as well as the snapshot. Column names are literals
// from this allowlist — never derived from bank data.
const PER_JOB_ANSWER_COLUMNS: Record<string, string> = {
  ownershipModel: "ownership_model",
  systemConfiguration: "system_configuration",
  disconnectWithin10ft: "disconnect_within_10ft",
};

/** Current per-job-answer column values for a project ({} on a pre-v17 DB). */
function perJobColumnAnswers(db: AppDb, projectId: string): Record<string, string> {
  try {
    const row = db.get<Record<string, unknown>>(
      "SELECT ownership_model, system_configuration, disconnect_within_10ft FROM projects WHERE id = ?",
      [projectId],
    );
    return {
      ownershipModel: str(row?.ownership_model),
      systemConfiguration: str(row?.system_configuration),
      disconnectWithin10ft: str(row?.disconnect_within_10ft),
    };
  } catch { return {}; }
}

// Returns either flat question rows or the live bank's track-grouped shape —
// both are normalized the same way the module lookup's result is.
type PortalQuestionSource = (db: AppDb, project: ProjectRecord) => unknown;

// Explicit wiring wins over the module lookup — the question bank can register
// itself here, and tests inject a deterministic bank without a live module.
let questionSource: PortalQuestionSource | null = null;
export function setPortalQuestionSource(fn: PortalQuestionSource | null): void {
  questionSource = fn;
}

/** The shared portal question bank for this project, normalized and filtered to
 *  publicly safe, rigidly answerable (has options) questions. Empty when the
 *  bank module isn't built yet — intake links keep working without it. */
async function bankQuestionsForProject(db: AppDb, project: ProjectRecord): Promise<PortalIntakeQuestion[]> {
  try {
    if (questionSource) return normalizeQuestions(flattenBankTracks(await questionSource(db, project)));
    // Variable specifier on purpose: the bank module may not exist yet in this
    // checkout, and a literal import would fail typecheck/boot without it.
    const bankModule = "./portalQuestionBank";
    const mod = (await import(bankModule)) as {
      questionsForProject?: (db: AppDb, project: ProjectRecord) => unknown;
    };
    if (typeof mod?.questionsForProject !== "function") return [];
    return normalizeQuestions(flattenBankTracks(await mod.questionsForProject(db, project)));
  } catch (err) {
    // Bank not built yet → expected, quiet. A PRESENT but broken bank must be
    // seen: silently producing zero questions is the failure class this whole
    // feature exists to kill (a portal question nobody was asked).
    const code = (err as { code?: string } | null)?.code ?? "";
    if (code !== "ERR_MODULE_NOT_FOUND" && !/Cannot find (module|package)/i.test(String((err as Error)?.message ?? ""))) {
      logger.warn("intake", "portal question bank failed — intake link created without portal questions", {
        error: String((err as Error)?.message ?? err),
      });
    }
    return [];
  }
}

// Canonical answer vocabularies for the v17 per-job bindings, used when the
// recipe's recorded step did not capture the portal's dropdown options. These
// exact strings pass renderPerJobAnswer (portalRecipes.ts) unchanged — they ARE
// the portal-worded canon replay files — so a rigid select stays possible even
// for a recipe whose recorder saw only the chosen value.
const CANONICAL_BINDING_OPTIONS: Record<string, string[]> = {
  ownershipModel: ["Customer-Owned", "Third-Party Owned", "Lease", "PPA"],
  systemConfiguration: ["Behind the Meter", "Community Solar"],
  disconnectWithin10ft: ["Yes", "No"],
};

/** The live question bank returns TRACK-GROUPED results ({track, unanswered:
 *  PortalQuestion[]}, portalQuestionBank.ts). Flatten to question rows tagged
 *  with the track's portal identity; a flat array passes through untouched. */
function flattenBankTracks(raw: unknown): unknown {
  if (!Array.isArray(raw) || !raw.length) return raw;
  if (!raw.every((t) => t && typeof t === "object" && Array.isArray((t as { unanswered?: unknown }).unanswered))) return raw;
  const out: unknown[] = [];
  for (const t of raw as Array<Record<string, unknown>>) {
    for (const q of t.unanswered as Array<Record<string, unknown>>) {
      out.push({ ...q, portalType: str(t.profileKey ?? t.portalHost) || undefined });
    }
  }
  return out;
}

/** Defensive normalization of bank rows: tolerate near-miss field names, keep
 *  only rigid (option-carrying), publicly safe questions, dedupe by binding. */
function normalizeQuestions(raw: unknown): PortalIntakeQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: PortalIntakeQuestion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const key = str(q.key ?? q.field ?? q.bindsTo ?? q.suggestedBinding);
    const label = str(q.label ?? q.question ?? q.prompt ?? q.portalLabel);
    const rawOptions = Array.isArray(q.options) ? q.options : Array.isArray(q.choices) ? q.choices : [];
    let options = [...new Set(rawOptions.map((o) => str(o)).filter(Boolean))];
    if (options.length < 2 && CANONICAL_BINDING_OPTIONS[key]) options = CANONICAL_BINDING_OPTIONS[key];
    if (!key || !label || options.length < 2) continue; // not rigidly answerable
    if (!publicSafeQuestionKey(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label, options, portalType: str(q.portalType) || undefined, unsure: q.unsure === true || undefined });
  }
  return out.slice(0, 20);
}

/** The project's current answer for a question binding: snapshot, then the
 *  normalized top-level record, then the per-job answer column (an answer may
 *  have been written column-only by another tool). Empty string = unanswered. */
function projectAnswer(project: ProjectRecord, key: string, columns: Record<string, string> = {}): string {
  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  return str(snap[key]) || str((project as unknown as Record<string, unknown>)[key]) || str(columns[key]);
}

/** Bank questions this project has NOT answered yet. */
export async function unansweredPortalQuestions(db: AppDb, project: ProjectRecord): Promise<PortalIntakeQuestion[]> {
  const bank = await bankQuestionsForProject(db, project);
  if (!bank.length) return [];
  const columns = perJobColumnAnswers(db, project.id);
  return bank.filter((q) => !projectAnswer(project, q.key, columns));
}

// ---------------------------------------------------------------------------
// Stored request shape.
// ---------------------------------------------------------------------------

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

// fields_json is a MIXED array: strings are the fixed submittal fields
// (legacy rows are all-strings and keep working), objects are portal questions
// snapshotted at request-creation time.
function parseStored(row: IntakeRow): { fields: IntakeField[]; questions: PortalIntakeQuestion[] } {
  let parsed: unknown = [];
  try { parsed = JSON.parse(row.fields_json); } catch { parsed = []; }
  const arr = Array.isArray(parsed) ? parsed : [];
  const fields = arr.filter((f): f is IntakeField => typeof f === "string" && (ALL_FIELDS as string[]).includes(f));
  const questions = normalizeQuestions(arr.filter((f) => f && typeof f === "object"));
  return { fields, questions };
}

function storedJson(fields: IntakeField[], questions: PortalIntakeQuestion[]): string {
  const qs = questions.map((q) => ({
    key: q.key, label: q.label, options: q.options,
    ...(q.portalType ? { portalType: q.portalType } : {}),
    ...(q.unsure ? { unsure: true } : {}),
  }));
  return JSON.stringify([...fields, ...qs]);
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

/** Create (or reuse a pending) intake request for a project. Returns token + URL path.
 *  The request also carries the portal's unanswered per-job questions for this
 *  project — recomputed fresh on every create/reuse so newly-answered ones drop off. */
export async function createIntakeRequest(
  db: AppDb,
  projectId: string,
  opts: { fields?: IntakeField[]; createdBy?: string; expiresInDays?: number } = {},
): Promise<{ id: string; token: string; path: string; fields: IntakeField[]; questions: PortalIntakeQuestion[] }> {
  const project = getProjectDetail(db, projectId).project; // throws 404 if missing

  const fields = (opts.fields && opts.fields.length ? opts.fields : missingIntakeFields(db, projectId))
    .filter((f): f is IntakeField => ALL_FIELDS.includes(f));
  const requestFields = fields.length ? fields : ALL_FIELDS;
  const questions = await unansweredPortalQuestions(db, project);

  // Reuse an existing pending request so re-clicking doesn't spawn duplicates.
  const existing = db.get<IntakeRow>(
    "SELECT * FROM project_intake_requests WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [projectId],
  );
  if (existing) {
    // REPLACE the stored list (never merge): answered questions drop off and the
    // link always asks exactly what is still unanswered today.
    db.run("UPDATE project_intake_requests SET fields_json = ? WHERE id = ?", [
      storedJson(requestFields, questions),
      existing.id,
    ]);
    return { id: existing.id, token: existing.token, path: `/intake?token=${existing.token}`, fields: requestFields, questions };
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
    [id, projectId, token, storedJson(requestFields, questions), opts.createdBy ?? "", now, expiresAt],
  );
  return { id, token, path: `/intake?token=${token}`, fields: requestFields, questions };
}

/** Public view of an intake request (no sensitive data). Throws if invalid/expired. */
export function getIntakeRequestPublic(db: AppDb, token: string): {
  status: string;
  projectLabel: string;
  fields: Array<{ key: IntakeField; label: string; value: string }>;
  questions: Array<{ key: string; label: string; options: string[]; value: string }>;
} {
  const row = db.get<IntakeRow>("SELECT * FROM project_intake_requests WHERE token = ?", [token]);
  if (!row) throw new HttpError(404, "Intake link not found.");
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    throw new HttpError(410, "This intake link has expired. Ask your permit coordinator for a new one.");
  }

  const project = getProjectDetail(db, row.project_id).project;
  const snap = project.parserSnapshot || {};
  const { fields, questions } = parseStored(row);

  return {
    status: row.status,
    projectLabel: [project.homeownerName, project.projectAddress].filter(Boolean).join(" — ") || "Solar project",
    fields: fields.map((key) => ({ key, label: FIELD_LABELS[key], value: str(snap[key]) })),
    // normalizeQuestions (inside parseStored) re-applies the public-key denylist,
    // so a row written before a denylist tightening still can't leak.
    questions: questions.map((q) => ({
      key: q.key, label: q.label, options: q.options,
      value: projectAnswer(project, q.key, perJobColumnAnswers(db, project.id)),
    })),
  };
}

/** Submit answers to a public intake request — writes to the project snapshot.
 *  Portal-question answers are RIGID: only one of the portal's own options (or
 *  the "I'm not sure" sentinel, which marks the question for the operator and
 *  never touches the project). */
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

  const { fields, questions } = parseStored(row);
  const payload: Record<string, unknown> = {};
  for (const key of fields) {
    const raw = answers[key];
    if (raw == null || String(raw).trim() === "") continue;
    payload[key] = String(raw).trim();
  }

  let unsureMarked = false;
  for (const q of questions) {
    const raw = answers[q.key];
    if (raw == null || String(raw).trim() === "") continue;
    const value = String(raw).trim();
    if (value === INTAKE_UNSURE) {
      if (!q.unsure) { q.unsure = true; unsureMarked = true; }
      continue; // never written to the project — the operator resolves it
    }
    if (!q.options.includes(value)) {
      // No free text for classified questions — the portal accepts exactly its
      // own vocabulary, so anything else would file a wrong answer silently.
      throw new HttpError(400, `"${q.label}" must be one of the portal's own options.`);
    }
    delete q.unsure;
    payload[q.key] = value;
  }

  if (Object.keys(payload).length === 0 && !unsureMarked) {
    throw new HttpError(400, "No values provided.");
  }

  const firstCompletion = row.status !== "completed";
  if (Object.keys(payload).length > 0) {
    updateProject(db, row.project_id, payload);
    // Answers bound to a per-job answer COLUMN (migration v17) land there too:
    // resolveRecipeFieldValues reads the column directly, so replay sees the
    // installer's answer either way. Column names come only from the allowlist
    // above; try/catch keeps a pre-migration DB working (snapshot still has it).
    for (const [key, column] of Object.entries(PER_JOB_ANSWER_COLUMNS)) {
      const value = payload[key];
      if (value == null || String(value) === "") continue;
      try {
        db.run(`UPDATE projects SET ${column} = ?, updated_at = ? WHERE id = ?`, [String(value), nowIso(), row.project_id]);
      } catch { /* pre-v17 DB — the snapshot write above already carries the answer */ }
    }
  }
  db.run("UPDATE project_intake_requests SET fields_json = ?, status = 'completed', completed_at = ? WHERE id = ?", [
    storedJson(fields, questions),
    nowIso(),
    row.id,
  ]);
  // The installer just supplied missing data — re-drive the project toward the
  // approval gate without waiting for an operator click. Only on the FIRST
  // completion: this endpoint is public (token-auth only), so repeat posts to
  // the same link must not keep triggering automation runs.
  if (firstCompletion) {
    void import("./autopilot").then(({ maybeResumeAutopilot }) => maybeResumeAutopilot(db, row.project_id, "an intake request was submitted")).catch(() => null);
  }
  return { ok: true, projectId: row.project_id };
}

/** Operator view: which portal per-job questions are still unanswered for a
 *  project, and which ones the installer explicitly wasn't sure about. Drives
 *  the dashboard's "N portal questions unanswered" blocker chip. */
/**
 * THE PARSER PAGE IS THE INTAKE SURFACE (operator's words), so the same rigid answers the
 * public token accepts must also be writable from the authenticated parser flow, the moment
 * the project is saved. Same discipline as submitIntakeRequest, revalidated against the
 * LIVE question list rather than a stored request: only a currently-unanswered question's
 * key is accepted, only the portal's own options are valid (no free text - anything else
 * files a wrong answer silently), and answers land in the parser snapshot AND the v17
 * column so resolveRecipeFieldValues sees them from either side.
 */
export async function answerPortalQuestions(
  db: AppDb,
  projectId: string,
  answers: Record<string, string>,
): Promise<{ written: string[]; remaining: number }> {
  const project = getProjectDetail(db, projectId).project;
  const unanswered = await unansweredPortalQuestions(db, project);
  const byKey = new Map(unanswered.map((q) => [q.key, q]));
  const payload: Record<string, string> = {};
  const written: string[] = [];
  for (const [key, raw] of Object.entries(answers ?? {})) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const q = byKey.get(key);
    if (!q) throw new HttpError(400, `"${key}" is not an open portal question for this project.`);
    if (!q.options.includes(value)) {
      throw new HttpError(400, `"${q.label}" must be one of the portal's own options.`);
    }
    payload[key] = value;
    written.push(key);
  }
  if (written.length === 0) throw new HttpError(400, "No values provided.");
  updateProject(db, projectId, payload);
  for (const [key, column] of Object.entries(PER_JOB_ANSWER_COLUMNS)) {
    const value = payload[key];
    if (value == null || String(value) === "") continue;
    try {
      db.run(`UPDATE projects SET ${column} = ?, updated_at = ? WHERE id = ?`, [String(value), nowIso(), projectId]);
    } catch { /* pre-v17 DB - the snapshot write above already carries the answer */ }
  }
  const stillOpen = await unansweredPortalQuestions(db, getProjectDetail(db, projectId).project);
  return { written, remaining: stillOpen.length };
}

export async function portalQuestionStatus(db: AppDb, projectId: string): Promise<{
  questions: Array<{ key: string; label: string; options: string[]; portalType?: string; unsure: boolean }>;
  unansweredCount: number;
  unsureCount: number;
}> {
  const project = getProjectDetail(db, projectId).project;
  const unanswered = await unansweredPortalQuestions(db, project);
  // "I'm not sure" marks live on the latest request row for this project.
  const latest = db.get<IntakeRow>(
    "SELECT * FROM project_intake_requests WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
    [projectId],
  );
  const unsureKeys = new Set(
    latest ? parseStored(latest).questions.filter((q) => q.unsure).map((q) => q.key) : [],
  );
  const questions = unanswered.map((q) => ({
    key: q.key, label: q.label, options: q.options,
    ...(q.portalType ? { portalType: q.portalType } : {}),
    unsure: unsureKeys.has(q.key),
  }));
  return {
    questions,
    unansweredCount: questions.length,
    unsureCount: questions.filter((q) => q.unsure).length,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}
