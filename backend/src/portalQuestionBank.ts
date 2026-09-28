// ---------------------------------------------------------------------------
// THE QUESTION BANK — "if PGE detected, ask PGE questions."
//
// The recipes already know what each portal asks: every unbound [select]/[fill]
// literal in a complete recipe is a question, in the portal's own wording (the
// step's selector label), with the answer project A gave frozen beside it. Some
// of those answers are genuinely constant for this operator ("Who will install
// this generation system?" = "Contractor"); some are PER-JOB facts that were
// pinned to whatever the learn project happened to be. Measured live on
// 2026-09-11: PacifiCorp's recipe replays 14 frozen selects, including
// "Will the System be Customer-Owned or Third-Party Owned?" = "Customer-Owned"
// — a FINANCING fact that files silently wrong on any third-party-owned job,
// invisible to the cross-project sweep because project A and project B agree by
// luck. Ameren separately leaves "Community Solar / Behind the Meter" BLANK,
// because no project binding exists for it. Same root both times: the portal
// asks a question the project record cannot answer.
//
// This module surfaces those questions so the rest of the system can be RIGID
// about them, the way the operator asked: extract them from the recipe,
// classify each as 'portal-constant' (fine frozen) / 'per-job' (silent-wrong-
// answer hazard) / 'unknown' (a human classifies ONCE, the answer is
// remembered), and for a concrete project return exactly the per-job questions
// the project record cannot answer yet — the list an intake request should ask
// the installer. Delivery through project_intake_requests is owned elsewhere
// (build 3); this module exports what that wiring needs.
//
// Deliberately NOT imported here: repository.ts (the CLI loads projects
// itself — keeps this module cycle-free beside jobQueue/repository).
// ---------------------------------------------------------------------------
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../shared/src/types";
import type { AppDb } from "./db";
import { findCompleteRecipeForProject, getPortalRecipe, resolveRecipeFieldValues } from "./portalRecipes";
import { nowIso } from "./time";

type Row = Record<string, unknown>;

export type PortalQuestionClassification = "portal-constant" | "per-job" | "unknown";

export type PortalQuestionKind =
  /** fill/select with no field binding and a recorded literal — replays A's answer verbatim. */
  | "unbound-literal"
  /** fill/select with no field binding and NO recorded value — replays a blank (the Ameren case). */
  | "unbound-blank"
  /** a check on a radio group: the SECTION is the question, the checked label is the frozen answer. */
  | "radio-choice"
  /** an agreement/terms checkbox — a consent, not project data. */
  | "consent"
  /** bound to a project field the average project leaves empty — asked, but usually unanswerable. */
  | "bound-empty";

export interface PortalQuestion {
  /** The portal's own wording (selector label, or the radio group's section heading). */
  portalLabel: string;
  /** Normalized form of portalLabel — the key overrides are stored against. */
  labelNorm: string;
  /** What the learn project answered. "" means the recipe files a BLANK here. */
  recordedAnswer: string;
  /** Dropdown options when the step captured them (most recorded steps did not). */
  options?: string[];
  /** Project field the answer should come from — an existing resolver key, or the
   *  column/intake key a binding SHOULD use once it exists. null = nobody knows yet. */
  suggestedBinding: string | null;
  classification: PortalQuestionClassification;
  /** Which rigid rule decided it, "override" for a persisted human call, null for unknown. */
  classifiedBy: string | null;
  /** One line of why, printable next to the classification. */
  why: string;
  kind: PortalQuestionKind;
  /** The enclosing section heading, when the recorder captured one. */
  section?: string;
}

// ---------------------------------------------------------------------------
// THE CLASSIFIER TABLE. Rigid keywords, no model call — the operator asked for
// rigid, and a misfire here is auditable in a way a prompt is not.
//
// ORDER IS THE SAFETY DIRECTION: per-job rules run FIRST. Misreading a per-job
// question as a constant files a silently wrong answer on a live application;
// misreading a constant as per-job merely asks the installer a needless
// question. The one exception is a consent checkbox — decided by KIND at
// extraction time, before any keyword runs, so "I acknowledge ... battery
// requirements ..." stays a consent even though it says "battery".
//
// Every rule carries an id so the test suite can kill-test the table: each rule
// must be the WINNING rule for at least one real portal label, and boilerplate
// ("net metering facility ...") must hit none of them.
// ---------------------------------------------------------------------------
export interface QuestionClassifierRule {
  id: string;
  re: RegExp;
  classification: "per-job" | "portal-constant";
  /** For per-job rules: the project field the answer should bind to (null = intake-only for now). */
  binding?: string | null;
  why: string;
}

export const QUESTION_CLASSIFIER_RULES: QuestionClassifierRule[] = [
  // ── per-job: the silent-wrong-answer hazards ─────────────────────────────
  { id: "per-job:ownership", re: /customer.?owned|third.?party|owner\s?ship|financ|\bleas(e|ed|ing)\b|\bppa\b|power\s?purchase/i,
    classification: "per-job", binding: "ownershipModel", why: "ownership/financing is a per-job fact" },
  // Grown from the adversarial rewording sweep (2026-09-11): "System owner" /
  // "Who owns the system?" / "Owner of generating facility" fell to unknown.
  // NARROW on purpose: the owner must be OF THE SYSTEM/facility/generation —
  // "Property Owner Name" is an identity field, not financing, and must not hit.
  { id: "per-job:system-owner", re: /\bsystem\s?owner\b|who\s+owns\s+the\s+(system|generat|facility)|owner\s+of\s+(the\s+)?(system|generat\w*|facility)/i,
    classification: "per-job", binding: "ownershipModel", why: "who owns the system is the same per-job financing fact" },
  { id: "per-job:configuration", re: /community\s?solar|behind.?the.?meter|collectively\s?owned/i,
    classification: "per-job", binding: "systemConfiguration", why: "program/configuration is a per-job fact" },
  { id: "per-job:storage", re: /batter|energy\s?storage|\bess\b|powerwall|backup\s?power/i,
    classification: "per-job", binding: "hasBattery", why: "storage presence varies by project" },
  { id: "per-job:export-limit", re: /export\s?limit|non.?export|limited\s?export/i,
    classification: "per-job", binding: "exportLimiting", why: "export mode varies by project" },
  { id: "per-job:mounting", re: /mount(ing)?\s?(method|type)|ground.?mount/i,
    classification: "per-job", binding: "mountType", why: "mounting varies by project" },
  { id: "per-job:tilt", re: /\btilt\b/i,
    classification: "per-job", binding: "tilt", why: "array tilt comes from the plan set" },
  { id: "per-job:azimuth", re: /azimuth|\borientation\b/i,
    classification: "per-job", binding: "azimuth", why: "array azimuth comes from the plan set" },
  { id: "per-job:meter-location", re: /meter\s(located|location|access)|located inside/i,
    classification: "per-job", binding: "meterLocation", why: "meter siting varies by site" },
  { id: "per-job:meter-device", re: /meter.?(mounted.?device|collar)|\bmmd\b/i,
    classification: "per-job", binding: null, why: "a meter collar / meter-mounted device is installed per job" },
  // Per-job in principle, but the operator has a STANDING answer for it ("Yes" —
  // the standard residential detail always places the lockable AC disconnect
  // within the required distance). That standing answer lives as data in
  // OPERATOR_POLICY_ANSWERS (intakeRequests.ts), which is what stops it being
  // asked at intake; it stays per-job HERE so a project that genuinely differs
  // can still record its own answer and win.
  { id: "per-job:disconnect-10ft", re: /disconnect.{0,20}within\s?10|within\s?10.{0,12}(feet|ft)\b/i,
    classification: "per-job", binding: "disconnectWithin10ft",
    why: "disconnect placement is a site fact — settled for this operator by a standing policy answer, overridable per project" },
  { id: "per-job:connection-side", re: /line\s(or|\/)\s?load.?side|(line|load).?side of the main/i,
    classification: "per-job", binding: null, why: "point of connection comes from the electrical design" },
  // ── portal constants: the same answer on every filing this operator makes ─
  { id: "portal-constant:installer-role", re: /who will (install|be installing)|who is (installing|going to install)|installed by|self.?install/i,
    classification: "portal-constant", why: "this operator always files as the contractor" },
  { id: "portal-constant:service-description", re: /description of (service|work)/i,
    classification: "portal-constant", why: "boilerplate service description" },
  { id: "portal-constant:service-type", re: /type of electric(al)?\s?service/i,
    classification: "portal-constant", why: "residential is this operator's only line of business" },
  { id: "portal-constant:mailing-list", re: /opt(ing)?.?in\b|subscribe|newsletter|handbook|receiv(e|ing) (changes|updates|notifications)/i,
    classification: "portal-constant", why: "mailing-list / notification preference" },
  { id: "portal-constant:generation-technology", re: /generation technology/i,
    classification: "portal-constant", why: "residential solar is always inverter-based" },
  { id: "portal-constant:consent", re: /\bagree\b|acknowledge|terms (and|&) conditions|certif(y|ies|ication)|disclaimer|warrant/i,
    classification: "portal-constant", why: "consent/acknowledgement text" },
  { id: "portal-constant:fee-routing", re: /fee invoice|who should receive/i,
    classification: "portal-constant", why: "fee routing is operator policy" },
  { id: "portal-constant:fuel-source", re: /fuel source/i,
    classification: "portal-constant", why: "always solar" },
  { id: "portal-constant:ul1741", re: /ul\s?1741/i,
    classification: "portal-constant", why: "every listed inverter complies" },
  { id: "portal-constant:active-license", re: /active license/i,
    classification: "portal-constant", why: "licence status is operator-level, not per-job" },
];

const CONSENT_RULE_ID = "portal-constant:consent";
const consentRule = QUESTION_CLASSIFIER_RULES.find((r) => r.id === CONSENT_RULE_ID)!;

/** Fields recipes legitimately bind but the average project record leaves empty —
 *  the question was asked and bound, yet most filings would still replay a blank.
 *  These surface as per-job questions so intake can collect them up front. */
export const OFTEN_EMPTY_BOUND_FIELDS = new Set(["ownershipModel", "systemConfiguration", "disconnectWithin10ft"]);

/** Lowercase, collapse whitespace, strip trailing punctuation — the stable key a
 *  portal's question is remembered by (overrides store this, not the raw label). */
export function normalizeQuestionLabel(label: string): string {
  return String(label || "").toLowerCase().replace(/\s+/g, " ").trim().replace(/[\s:?!.]+$/, "");
}

export interface QuestionClassification {
  classification: PortalQuestionClassification;
  ruleId: string | null;
  why: string;
  binding: string | null;
}

/** First matching rule wins; per-job rules are listed first on purpose (see table). */
export function classifyPortalQuestion(text: string): QuestionClassification {
  const t = String(text || "");
  for (const rule of QUESTION_CLASSIFIER_RULES) {
    if (rule.re.test(t)) {
      return { classification: rule.classification, ruleId: rule.id, why: rule.why, binding: rule.binding ?? null };
    }
  }
  return { classification: "unknown", ruleId: null, why: "no rigid rule matches — a human classifies this once and it is remembered", binding: null };
}

// ---------------------------------------------------------------------------
// PERSISTED HUMAN OVERRIDES — the "then remembered" half of 'unknown'.
//
// Shared across tenants like the recipes themselves: a portal's question is the
// same for everyone (CLAUDE.md — shared knowledge is shared on purpose), so the
// table carries no org scope. The table is created LAZILY and only on the WRITE
// path: reads probe sqlite_master and treat a missing table as "no overrides",
// so an audit/report against a database never executes DDL. db.ts belongs to
// another change this run — this is the same CREATE-on-first-write pattern,
// kept inside the module that owns the table.
// ---------------------------------------------------------------------------
const OVERRIDES_TABLE = "portal_question_overrides";

function overridesTableExists(db: AppDb): boolean {
  return !!db.get<Row>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [OVERRIDES_TABLE]);
}

function ensureOverridesTable(db: AppDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${OVERRIDES_TABLE} (
      profile_key TEXT NOT NULL,
      label_norm TEXT NOT NULL,
      classification TEXT NOT NULL,
      binding TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (profile_key, label_norm)
    );
  `);
}

export interface PortalQuestionOverride {
  classification: PortalQuestionClassification;
  binding: string | null;
}

export function setPortalQuestionOverride(
  db: AppDb,
  profileKey: string,
  label: string,
  classification: PortalQuestionClassification,
  binding = "",
): void {
  if (!["portal-constant", "per-job", "unknown"].includes(classification)) {
    throw new Error(`invalid classification "${classification}" — use portal-constant | per-job | unknown`);
  }
  ensureOverridesTable(db);
  db.run(
    `INSERT INTO ${OVERRIDES_TABLE} (profile_key, label_norm, classification, binding, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(profile_key, label_norm) DO UPDATE SET classification = excluded.classification,
         binding = excluded.binding, created_at = excluded.created_at`,
    [profileKey, normalizeQuestionLabel(label), classification, binding, nowIso()],
  );
}

export function getPortalQuestionOverrides(db: AppDb, profileKey: string): Map<string, PortalQuestionOverride> {
  const out = new Map<string, PortalQuestionOverride>();
  if (!overridesTableExists(db)) return out;
  for (const row of db.query<Row>(`SELECT label_norm, classification, binding FROM ${OVERRIDES_TABLE} WHERE profile_key = ?`, [profileKey])) {
    const cls = String(row.classification);
    out.set(String(row.label_norm), {
      classification: (["portal-constant", "per-job", "unknown"].includes(cls) ? cls : "unknown") as PortalQuestionClassification,
      binding: String(row.binding ?? "").trim() || null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// EXTRACTION — the recipe IS the question bank.
// ---------------------------------------------------------------------------
const stepLabel = (step: RecipeStep): string =>
  String(step.selector?.label || step.note || step.fingerprint?.ariaLabel || "").trim();

const stepOptions = (step: RecipeStep): string[] | undefined => {
  // RecipeStep does not declare options today; a recorder that captures the
  // dropdown's option list stores it beside the step, and it survives here.
  const raw = (step as { options?: unknown }).options;
  if (!Array.isArray(raw)) return undefined;
  const opts = raw.map((o) => String(o)).filter(Boolean);
  return opts.length ? opts : undefined;
};

/** Long agreement text, or explicit consent wording — decided BEFORE keyword rules run. */
function looksLikeConsentLabel(label: string): boolean {
  return consentRule.re.test(label) || label.length >= 100;
}

/**
 * Every question this recipe's portal asks that replay answers from the RECIPE
 * rather than the project: unbound literals (frozen answers), unbound blanks
 * (filed empty), radio choices (the checked label is the frozen answer), consent
 * checkboxes, and steps bound to fields the average project leaves empty.
 * Accepts a recipe, or a profile key ("or|unknown|pacific power") — the newest
 * complete recipe under that key wins, falling back to the newest of any status.
 */
export function extractPortalQuestions(db: AppDb, source: PortalRecipe | string): PortalQuestion[] {
  const recipe = typeof source === "string" ? recipeForProfileKey(db, source) : source;
  if (!recipe) return [];
  const overrides = getPortalQuestionOverrides(db, recipe.profileKey);

  const out: PortalQuestion[] = [];
  const seen = new Set<string>();
  const push = (q: PortalQuestion) => {
    if (!q.portalLabel || seen.has(q.labelNorm)) return; // one question per control, first fill wins
    seen.add(q.labelNorm);
    out.push(q);
  };
  const build = (portalLabel: string, kind: PortalQuestionKind, recordedAnswer: string, extras: Partial<PortalQuestion> = {}): PortalQuestion => {
    const labelNorm = normalizeQuestionLabel(portalLabel);
    // Consents are decided by kind, not keywords — "I acknowledge ... battery
    // requirements" must not become a per-job storage question.
    const ruled: QuestionClassification = kind === "consent"
      ? { classification: "portal-constant", ruleId: CONSENT_RULE_ID, why: consentRule.why, binding: null }
      : classifyPortalQuestion(portalLabel);
    const override = overrides.get(labelNorm);
    return {
      portalLabel,
      labelNorm,
      recordedAnswer,
      suggestedBinding: override?.binding ?? extras.suggestedBinding ?? ruled.binding,
      classification: override ? override.classification : ruled.classification,
      classifiedBy: override ? "override" : ruled.ruleId,
      why: override ? "human-classified for this portal (portal_question_overrides)" : ruled.why,
      kind,
      ...(extras.section ? { section: extras.section } : {}),
      ...(extras.options ? { options: extras.options } : {}),
    };
  };

  for (const step of recipe.steps ?? []) {
    const action = String(step.action ?? "");
    if (!["fill", "select", "check"].includes(action)) continue;
    if (step.isFinalSubmit) continue; // never replayed by automation, never a question
    if (step.sensitive) continue; // credentials bind by name; their values are nobody's question
    const label = stepLabel(step);
    const value = String(step.value ?? "").trim();
    const section = String(step.fingerprint?.section ?? "").trim();

    if (step.field) {
      // Bound steps answer from the project — EXCEPT bindings the average project
      // record leaves empty, which are questions the intake must collect.
      if (OFTEN_EMPTY_BOUND_FIELDS.has(step.field)) {
        const base = build(label || section || step.field, "bound-empty", "");
        // A persisted human override still wins; otherwise the binding itself is the
        // classification — the field IS project data, most records just lack it.
        push(base.classifiedBy === "override" ? { ...base, suggestedBinding: base.suggestedBinding ?? step.field } : {
          ...base,
          suggestedBinding: step.field,
          classification: "per-job",
          classifiedBy: "per-job:bound-often-empty",
          why: "bound to a project field most projects leave empty — collect it at intake",
        });
      }
      continue;
    }

    if (action === "check") {
      if (looksLikeConsentLabel(label)) {
        push(build(label, "consent", "Checked", { section: section || undefined }));
      } else if (section) {
        // A radio group: the recorder captured the chosen option as the label and
        // the QUESTION as the enclosing section ("Do you seek to install an Energy
        // Storage System (ESS)..." -> "No"). Classify on the question, never the
        // answer — "No" carries no signal.
        push({ ...build(section, "radio-choice", label || "Checked"), section });
      } else {
        push(build(label, "radio-choice", "Checked"));
      }
      continue;
    }

    // fill / select with no binding: a question the recipe answers by itself.
    push(build(label, value ? "unbound-literal" : "unbound-blank", value, {
      section: section || undefined,
      options: stepOptions(step),
    }));
  }
  return out;
}

// A PROFILE KEY IS NO LONGER A UNIQUE ADDRESS FOR A RECIPE, AND THIS SILENTLY PICKED ONE.
//
// Recipes are keyed per AHJ PER DISCIPLINE. City of Coos Bay has TWO complete recipes under
// the one key "or|city of coos bay|pacific power" — the city/structural filing and the
// county/electrical one — and this LIMIT 1 returned whichever sorted first.
//
// Measured: the operator's triage queue listed the ELECTRICAL recipe's questions twice and
// never once showed the structural recipe's own. Its unknown question ("Residential -
// Structural"), its per-job geometry (building height, stories, areas, dwelling units,
// number of buildings) and its "Plans - Structural" attachment type were invisible, so no
// amount of triaging could ever reach them. apply-question-bindings had the same blind spot
// from the other side: it read the electrical question set and then walked the STRUCTURAL
// recipe's steps, so every structural label was simply absent from `wanted` and went unbound.
//
// Ambiguity here cannot be resolved by picking better — there is no correct single answer to
// "the recipe for this key" when two exist. So it THROWS, naming both, and the callers that
// have a recipe in hand (every real one) pass the recipe object instead and never reach it.
// Silence was the whole defect; an exception is the smallest thing that cannot be silent.
function recipeForProfileKey(db: AppDb, profileKey: string): PortalRecipe | null {
  const rows = db.query<Row>(
    `SELECT id, discipline, status FROM portal_recipes WHERE profile_key = ?
      ORDER BY CASE WHEN status = 'complete' THEN 0 ELSE 1 END, updated_at DESC`,
    [profileKey],
  );
  const complete = rows.filter((r) => String(r.status) === "complete");
  const pool = complete.length ? complete : rows;
  if (pool.length > 1) {
    const disciplines = pool.map((r) => String(r.discipline || "(untagged)"));
    throw new Error(
      `"${profileKey}" has ${pool.length} recipes (disciplines: ${disciplines.join(", ")}) — a profile key alone `
      + "does not identify one. Pass the PortalRecipe (or getPortalRecipe(db, id)) instead of the key.",
    );
  }
  return pool.length ? getPortalRecipe(db, String(pool[0].id)) : null;
}

/** The hostname a recipe drives — portal_url first, else the first goto step. */
export function recipeHost(recipe: PortalRecipe): string {
  const candidates = [recipe.portalUrl, String(recipe.steps.find((s) => s.action === "goto")?.value ?? "")];
  for (const c of candidates) {
    try { return new URL(String(c || "")).hostname.toLowerCase(); } catch { /* not a URL */ }
  }
  return "";
}

// ---------------------------------------------------------------------------
// "THE PGE QUESTIONS" FOR A PGE PROJECT — per-job questions this project's
// record cannot answer yet, per track.
// ---------------------------------------------------------------------------
export interface TrackPortalQuestions {
  track: "nem" | "permit";
  recipeId: string;
  profileKey: string;
  portalHost: string;
  /** Per-job questions the project record answers already (binding resolved non-empty). */
  answered: Array<{ question: PortalQuestion; from: string; value: string }>;
  /** Per-job questions with NO answer in the project record — what intake should ask. */
  unanswered: PortalQuestion[];
}

/**
 * Resolve the portal(s) this project will actually file through — the SAME
 * lookups production staging runs (repository.ts:5353-5358): the NEM track
 * against the utility-scoped recipe, the permit track against the AHJ-scoped
 * recipe for the project's discipline. Never mixed (safety rule 5). For each,
 * extract the bank, keep the per-job questions, and split them by whether the
 * project record can answer today.
 */
export function questionsForProject(db: AppDb, project: ProjectRecord): TrackPortalQuestions[] {
  const out: TrackPortalQuestions[] = [];
  const lookups: Array<{ track: "nem" | "permit"; recipe: PortalRecipe | null }> = [
    { track: "nem", recipe: findCompleteRecipeForProject(db, { scopeType: "utility", state: project.state, utility: project.utility }) },
    {
      track: "permit",
      recipe: findCompleteRecipeForProject(db, {
        scopeType: "ahj", state: project.state, ahj: project.ahj, utility: project.utility,
        // Same mapping recipeDisciplineForTrack applies to staging tracks: the project's
        // permitType drives it, defaulting to structural.
        discipline: project.permitType === "electrical" ? "electrical" : "structural",
      }),
    },
  ];
  for (const { track, recipe } of lookups) {
    if (!recipe) continue;
    // portalType here only feeds the client overlay's identity match inside the
    // resolver (falls back to the legal business name when it misses) — the
    // platform string is the closest honest value without re-running channel dispatch.
    const fields = resolveRecipeFieldValues(db, project, recipe.portalPlatform || "", track === "nem" ? "nem" : (project.permitType === "electrical" ? "electrical" : "building"));
    const perJob = extractPortalQuestions(db, recipe).filter((q) => q.classification === "per-job");
    const answered: TrackPortalQuestions["answered"] = [];
    const unanswered: PortalQuestion[] = [];
    for (const q of perJob) {
      const binding = q.suggestedBinding;
      const value = binding ? String(fields[binding] ?? "").trim() : "";
      if (binding && value) answered.push({ question: q, from: binding, value });
      else unanswered.push(q);
    }
    out.push({ track, recipeId: recipe.id, profileKey: recipe.profileKey, portalHost: recipeHost(recipe), answered, unanswered });
  }
  return out;
}

// ---------------------------------------------------------------------------
// FLEET AUDIT — every complete recipe's per-job questions that replay a frozen
// (or blank) answer today. Worst first: a frozen per-job answer files silently
// WRONG; a blank at least shows up as a blank; an unknown needs a human call.
// ---------------------------------------------------------------------------
export interface FrozenAnswerFinding {
  recipeId: string;
  profileKey: string;
  scopeType: "ahj" | "utility";
  state: string;
  ahj: string;
  utility: string;
  discipline: string;
  portalHost: string;
  question: PortalQuestion;
  /** 0 = frozen per-job answer (silent wrong answer), 1 = per-job blank, 2 = unknown. */
  severity: 0 | 1 | 2;
}

export function auditFrozenAnswers(db: AppDb): FrozenAnswerFinding[] {
  const rows = db.query<Row>("SELECT id FROM portal_recipes WHERE status = 'complete' ORDER BY updated_at DESC");
  const findings: FrozenAnswerFinding[] = [];
  for (const row of rows) {
    const recipe = getPortalRecipe(db, String(row.id));
    for (const q of extractPortalQuestions(db, recipe)) {
      if (q.classification === "portal-constant") continue;
      const severity: 0 | 1 | 2 = q.classification === "per-job" ? (q.recordedAnswer ? 0 : 1) : 2;
      findings.push({
        recipeId: recipe.id, profileKey: recipe.profileKey, scopeType: recipe.scopeType,
        state: recipe.state, ahj: recipe.ahj, utility: recipe.utility, discipline: recipe.discipline ?? "",
        portalHost: recipeHost(recipe), question: q, severity,
      });
    }
  }
  return findings.sort((a, b) => a.severity - b.severity || a.profileKey.localeCompare(b.profileKey));
}

// ---------------------------------------------------------------------------
// FOR THE INTAKE WIRING (build 3 owns project_intake_requests). Only questions
// with a BINDING become intake fields: the public intake form writes answers
// into the project snapshot by key, and resolveRecipeFieldValues passes
// snapshot scalars through by that same key — so a bound answer flows to the
// portal with no further plumbing. A per-job question with no binding is
// surfaced to a human first (set an override with a binding), never guessed.
// ---------------------------------------------------------------------------
export interface IntakeQuestionField {
  /** The project-snapshot key intake should write — same key replay resolves. */
  key: string;
  /** The portal's own wording, shown to the installer verbatim. */
  label: string;
  /** The (possibly wrong) answer the recipe would file today; "" = blank. */
  recordedAnswer: string;
  options?: string[];
}

export function intakeFieldsForQuestions(questions: PortalQuestion[]): IntakeQuestionField[] {
  const out: IntakeQuestionField[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    if (q.classification !== "per-job" || !q.suggestedBinding) continue;
    if (seen.has(q.suggestedBinding)) continue;
    seen.add(q.suggestedBinding);
    out.push({
      key: q.suggestedBinding,
      label: q.portalLabel,
      recordedAnswer: q.recordedAnswer,
      ...(q.options ? { options: q.options } : {}),
    });
  }
  return out;
}
