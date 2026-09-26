import { randomUUID } from "node:crypto";
import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { HttpError } from "./httpError";
import { getProjectDetail, updateProject } from "./repository";
import { resolveValuation } from "./valuation";
import { nowIso } from "./time";
import { logger } from "./logger";
import { formFactQuestions } from "./bcdChecklistFacts";
import { issuingAgencyFor } from "./permitProcess";
import { resolvePermitPath } from "./permitPath";
import { iowaPvWorksheetValues } from "./iowaPvWorksheet";
import { pvWorksheetRequirement } from "./requiredDocuments";

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
  /** The bank's PortalQuestionKind for this question, when it came from the bank.
   *  Only "bound-empty" is load-bearing here — see OPERATOR_POLICY_ANSWERS. */
  kind?: string;
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
function formFactIntakeQuestions(project: ProjectRecord): PortalIntakeQuestion[] {
  try {
    const checklistApplies = String(project.state ?? "").trim().toUpperCase() === "OR" && resolvePermitPath(project).path !== "engineered";
    const agency = issuingAgencyFor(project, "building")?.value ?? issuingAgencyFor(project, "electrical")?.value ?? null;
    // A state PV worksheet owed (Iowa SFM): its multiple-choice questions (line vs load side, the
    // feeder row, dwelling units) ride the same mechanism. Free-text unknowns (module Voc, the
    // site low, the service conductor) cannot be rigidly answered here and are listed as missing
    // on the filled worksheet instead.
    const worksheet = pvWorksheetRequirement(project) ? iowaPvWorksheetValues(project).questions.filter((q) => q.options.length >= 2) : [];
    return [...formFactQuestions(project, { checklistApplies, issuingAgency: agency }), ...worksheet]
      .map((q) => ({ key: q.key, label: q.label, options: q.options, kind: q.kind }));
  } catch {
    return [];
  }
}

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

// ---------------------------------------------------------------------------
// OPERATOR POLICY ANSWERS — a standing answer for a per-job binding.
//
// "Is your disconnect within 10 feet of the PGE utility meter?" was reaching the
// homeowner's intake form on every PGE job. It is per-job in PRINCIPLE, but this
// operator has a standing call on it: the standard residential detail places the
// lockable AC disconnect within the required distance on every install. The
// learn-time pass already applies exactly that answer (POLICY_RADIO_DEFAULTS in
// portal-bot/src/adapters/autoLearnAdapter.ts), so the two halves of the system
// held opposite beliefs about the same question and the client paid for it.
//
// THIS IS DATA, NOT A RULE. The operator will one day have a job where the
// answer is No, and this table is deliberately the LOWEST-ranked answer source:
// projectAnswer() consults the parser snapshot, the project record, and the v17
// per-job column FIRST, so anything recorded for a specific project still wins.
// Adding/removing a policy answer is a one-line data edit here, with its reason.
const OPERATOR_POLICY_ANSWERS: Record<string, { answer: string; why: string }> = {
  disconnectWithin10ft: {
    answer: "Yes",
    why: "standard residential detail places the lockable AC disconnect within the required distance on every install — the operator's standing answer, and the same one autoLearnAdapter's POLICY_RADIO_DEFAULTS files at learn time",
  },
};

/** The operator's standing answer for a binding, or "" when there is none. */
export function operatorPolicyAnswer(key: string): string {
  return OPERATOR_POLICY_ANSWERS[key]?.answer ?? "";
}

/** True when the operator's standing answer settles this question, so nobody
 *  should be asked it.
 *
 *  THE "bound-empty" CARVE-OUT IS LOAD-BEARING. A bank question of kind
 *  "bound-empty" means the RECIPE has a step bound to this field: replay fills
 *  that control from resolveRecipeFieldValues (portalRecipes.ts), which has no
 *  policy default of its own and resolves "" — so suppressing the question there
 *  would file a BLANK into a required portal control with nothing surfacing it,
 *  strictly worse than asking. Those keep being asked, the answer lands in the
 *  v17 column, and the resolver then resolves it. Drop this clause only once
 *  portalRecipes.ts applies the same policy default.
 *
 *  AN ABSENT KIND IS NOT "NOT bound-empty" — it is "we do not know", and the two
 *  must not be spelled the same way. `kind` only began being persisted by
 *  storedJson in the commit that introduced this function, so every intake
 *  request that was already PENDING carries questions with no kind at all. Read
 *  as `q.kind !== "bound-empty"` those legacy rows suppress, and a legacy
 *  recipe-bound disconnect question then vanishes from the public form while
 *  resolveRecipeFieldValues goes on resolving "" into the required control —
 *  exactly the blank filing the carve-out above exists to prevent, arrived at by
 *  the back door. So an unknown kind degrades to ASKING. The cost of being wrong
 *  in that direction is one needless question on a link already in flight; the
 *  cost in the other is a blank in a live portal application that nothing
 *  surfaces. Live bank questions are unaffected: extractPortalQuestions builds
 *  every PortalQuestion with an explicit kind, and storedJson now persists it. */
function policySettles(q: PortalIntakeQuestion): boolean {
  if (!OPERATOR_POLICY_ANSWERS[q.key]) return false;
  return !!q.kind && q.kind !== "bound-empty";
}

// A RECIPE NOTE IS NOT A QUESTION.
//
// autoLearnAdapter records a policy-answered radio as a step whose NOTE is
// `policy default: <the portal's question> → <the answer>` and whose selector is
// css-only; the bank's stepLabel() then falls back to that note, and the whole
// internal string was rendered to a homeowner on a public no-login page.
//
// The note is also a MATCHING KEY — recipeAdapter's conditional-question replay
// skip tests /^policy default:/ on it, and portal_question_overrides is
// PRIMARY-KEYED on its normalized form (a live row reads
// "…:: policy default: do you propose to limit the export capacity? → no").
// So it is cleaned HERE, at the one boundary where it is shown to a person, and
// nowhere upstream: changing stepLabel/normalizeQuestionLabel would silently
// orphan that override row.
const POLICY_NOTE_PREFIX = /^\s*policy default:\s*/i;

function publicQuestionLabel(label: string): string {
  // ANCHORED ON THE PREFIX. A legitimate portal label may contain an arrow
  // ("Line → Load side of the main panel?") and must survive byte-identical.
  if (!POLICY_NOTE_PREFIX.test(label)) return label;
  const body = label.replace(POLICY_NOTE_PREFIX, "");
  // Drop the recorded ANSWER the note carries after the arrow — the LAST arrow,
  // so a question that itself contains one keeps its own wording.
  const cleaned = body.replace(/^([\s\S]*)(?:→|->)\s*\S[\s\S]*$/, "$1").trim();
  return cleaned || body.trim() || label;
}

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
    const label = publicQuestionLabel(str(q.label ?? q.question ?? q.prompt ?? q.portalLabel));
    const rawOptions = Array.isArray(q.options) ? q.options : Array.isArray(q.choices) ? q.choices : [];
    let options = [...new Set(rawOptions.map((o) => str(o)).filter(Boolean))];
    if (options.length < 2 && CANONICAL_BINDING_OPTIONS[key]) options = CANONICAL_BINDING_OPTIONS[key];
    if (!key || !label || options.length < 2) continue; // not rigidly answerable
    if (!publicSafeQuestionKey(key)) continue;
    // DEFENCE IN DEPTH. questionsForProject already keeps only per-job questions,
    // but an injected source, a future bank shape or a stored legacy row could
    // hand us a portal-constant — a question with a FIXED answer, which asking a
    // client for is the whole defect. Checked only when a classification is
    // actually supplied: storedJson does not persist one, so a pending row
    // written before this change must still parse.
    const classification = str(q.classification);
    if (classification && classification !== "per-job") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key, label, options,
      portalType: str(q.portalType) || undefined,
      kind: str(q.kind) || undefined,
      unsure: q.unsure === true || undefined,
    });
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

/** THE ONE DEFINITION OF "still needs an answer", shared by every surface: the
 *  bank filter, the public GET, and the required check in the POST.
 *
 *  They MUST agree. If the GET hides a question the POST still requires, a
 *  client is rejected for a question the form never showed them — so this is a
 *  single function rather than three lookalike conditions. */
function questionIsOpen(project: ProjectRecord, q: PortalIntakeQuestion, columns: Record<string, string>): boolean {
  if (projectAnswer(project, q.key, columns)) return false; // parser / record / v17 column already answered it
  if (policySettles(q)) return false;                       // the operator's standing answer settles it
  return true;
}

/** Bank questions this project has NOT answered yet. */
export async function unansweredPortalQuestions(db: AppDb, project: ProjectRecord): Promise<PortalIntakeQuestion[]> {
  // FORM FACTS NO DOCUMENT STATES (bcdChecklistFacts.formFactQuestions — roof layer count, module
  // height per the figures, structure description, a city's zoning sign-off when a county issues):
  // asked through the SAME intake mechanism, answered into the project, read by every form.
  const bank = [...await bankQuestionsForProject(db, project), ...formFactIntakeQuestions(project)];
  if (!bank.length) return [];
  const columns = perJobColumnAnswers(db, project.id);
  return bank.filter((q) => questionIsOpen(project, q, columns));
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
    // Persisted because it decides whether an operator policy answer may settle
    // the question without asking (see policySettles).
    ...(q.kind ? { kind: q.kind } : {}),
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
  fields: Array<{ key: IntakeField; label: string; value: string; required: boolean }>;
  questions: Array<{ key: string; label: string; options: string[]; value: string; required: boolean }>;
} {
  const row = db.get<IntakeRow>("SELECT * FROM project_intake_requests WHERE token = ?", [token]);
  if (!row) throw new HttpError(404, "Intake link not found.");
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    throw new HttpError(410, "This intake link has expired. Ask your permit coordinator for a new one.");
  }

  const project = getProjectDetail(db, row.project_id).project;
  const snap = project.parserSnapshot || {};
  const { fields, questions } = parseStored(row);

  const columns = perJobColumnAnswers(db, project.id);
  return {
    status: row.status,
    projectLabel: [project.homeownerName, project.projectAddress].filter(Boolean).join(" — ") || "Solar project",
    // Required = there is nothing on file yet. A prefilled field is shown but not
    // demanded, which is exactly what submitIntakeRequest enforces — the two must
    // not diverge or a client is blocked on a box that already has a value.
    fields: fields.map((key) => ({ key, label: FIELD_LABELS[key], value: str(snap[key]), required: !str(snap[key]) })),
    // normalizeQuestions (inside parseStored) re-applies the public-key denylist
    // and strips internal recipe vocabulary from the label, so a row written
    // before either tightening still can't leak.
    questions: questions.filter((q) => questionIsOpen(project, q, columns)).map((q) => ({
      key: q.key, label: q.label, options: q.options,
      // An "I'm not sure" answer is never written to the project, so without this
      // it round-trips as blank and a client reopening the link to correct an
      // email would be blocked by a question they already answered.
      value: q.unsure ? INTAKE_UNSURE : "",
      required: true,
    })),
  };
}

/** Submit answers to a public intake request — writes to the project snapshot.
 *  Portal-question answers are RIGID: only one of the portal's own options (or
 *  the "I'm not sure" sentinel, which marks the question for the operator and
 *  never touches the project). Every field/question the request still ASKS is
 *  REQUIRED: a short post is a 400 naming what is missing, thrown before any
 *  write, so a half-filled intake can never report itself complete. */
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

  const project = getProjectDetail(db, row.project_id).project;
  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  const columns = perJobColumnAnswers(db, row.project_id);
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

  // REQUIRED, ENFORCED HERE — against the STORED request, and BEFORE any write.
  //
  // A control the client left empty is simply absent from the body, so "skipped"
  // and "never asked" were indistinguishable on the wire, and ONE answer out of
  // five satisfied this endpoint: the row flipped to 'completed' and
  // maybeResumeAutopilot re-drove a half-answered project toward the approval
  // gate. Throwing before updateProject is what stops that.
  //
  // REQUIRED MEANS ANSWERED, NOT CERTAIN: INTAKE_UNSURE is a real answer (it
  // escalates to the operator), so it satisfies the check — either in this post
  // (q.unsure was just set above) or from a previous one that is not resent.
  //
  // questionIsOpen is the SAME predicate getIntakeRequestPublic renders with, so
  // a client is never rejected for a question the form did not show them.
  const missing: string[] = [];
  for (const key of fields) {
    if (payload[key] == null && !str(snap[key])) missing.push(FIELD_LABELS[key]);
  }
  for (const q of questions) {
    if (!questionIsOpen(project, q, columns)) continue;
    if (payload[q.key] != null || q.unsure) continue;
    missing.push(q.label);
  }
  if (missing.length) {
    // Read by a homeowner/installer, not an operator — name what is missing.
    throw new HttpError(400, `Please answer: ${missing.join("; ")}.`);
  }
  if (!fields.length && !questions.length && Object.keys(payload).length === 0 && !unsureMarked) {
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
