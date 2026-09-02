import type { PortalRecipe, PortalRecipeStatus, ProjectRecord, RecipeStep } from "../../shared/src/types";
import { addAuditLog } from "./audit";
import { clientStagingOverlay } from "./clients";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { asJson, bool, parseJson, text as s } from "./json";
import { knowledgeProfileKey, knowledgeNameMatchScore } from "./knowledgeBase";
import { certifiedModelFor } from "./cecEquipment";
import { nowIso } from "./time";
import { parseStreetNumber, parseStreetName } from "../../portal-bot/src/addressParse";

type Row = Record<string, unknown>;


function mapRecipe(row: Row): PortalRecipe {
  return {
    id: s(row.id),
    scopeType: s(row.scope_type) === "utility" ? "utility" : "ahj",
    profileKey: s(row.profile_key),
    state: s(row.state),
    ahj: s(row.ahj),
    utility: s(row.utility),
    portalPlatform: s(row.portal_platform),
    portalUrl: s(row.portal_url),
    status: (["recording", "complete", "needs_rerecord"].includes(s(row.status)) ? s(row.status) : "recording") as PortalRecipeStatus,
    version: Number(row.version ?? 1),
    steps: parseJson<RecipeStep[]>(s(row.steps_json) || "[]", []),
    loginStep: row.login_step_json ? parseJson(s(row.login_step_json), undefined) : undefined,
    createdBy: s(row.created_by),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
    notes: s(row.notes),
    // bool() (not Boolean()) — a string "0" cell must read as false, never as trusted.
    autoSubmitEnabled: bool(row.auto_submit_enabled),
    discipline: s(row.discipline),
  };
}

// Split a US phone into the three boxes segmented portal controls use (Accela renders
// area / prefix / line as separate inputs). Emitted as derived substitution keys so a
// recorded segment step binds to a KEY rather than freezing the learn project's number.
export function phoneSegmentKeys(base: string, raw: string): Record<string, string> {
  const digits = String(raw || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length < 10) return {};
  return {
    [`${base}Area`]: digits.slice(0, 3),
    [`${base}Prefix`]: digits.slice(3, 6),
    [`${base}Line`]: digits.slice(6, 10),
  };
}

export function recipeProfileKey(input: { scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string }): string {
  // AHJ recipes key on state|ahj|utility; utility recipes key on the utility only
  // (ahj empty) so they match any AHJ in that utility territory.
  return input.scopeType === "utility"
    ? knowledgeProfileKey({ state: input.state, ahj: "", utility: input.utility })
    : knowledgeProfileKey({ state: input.state, ahj: input.ahj, utility: input.utility });
}

export function listPortalRecipes(db: AppDb): PortalRecipe[] {
  return db.query<Row>("SELECT * FROM portal_recipes ORDER BY updated_at DESC").map(mapRecipe);
}

export function getPortalRecipe(db: AppDb, recipeId: string): PortalRecipe {
  const row = db.get<Row>("SELECT * FROM portal_recipes WHERE id = ?", [recipeId]);
  if (!row) throw new HttpError(404, "Portal recipe not found.");
  return mapRecipe(row);
}

// Recipes are keyed per AHJ PER DISCIPLINE: Oregon solar files a city/structural permit
// AND a county/electrical one for the same project, and their portal steps differ
// (different jurisdiction row, different record type). An exact discipline match wins; a
// LEGACY row (discipline '', learned before the dimension existed) is accepted as a
// fallback so existing recipes keep replaying — the staging discipline gate still refuses
// one whose recorded steps belong to the other discipline.
// NAME-ALIAS FALLBACK for the recipe key. The profile key is built from the utility/AHJ
// string as the PROJECT spells it, so a portal learned under one spelling is invisible to a
// project that uses another. Measured on the live DB: the trusted 60-step PGE recipe is
// keyed "or|unknown|pge", but a real PGE project stores "Portland General Electric" and
// therefore resolved to NO complete recipe — every NEM stage re-learned the portal from
// scratch instead of replaying, and the second key quietly accumulated its own draft
// (v11). Same for "Pacific Power". This reuses the KB's own scorer, which already bridges
// operator short names to legal names ("PGE" -> "Portland General Electric" scores 78).
// EXACT KEY ALWAYS WINS (CLAUDE.md); this only runs when the exact key finds nothing.
const NAME_ALIAS_MIN_SCORE = 78;
function findRecipeByNameAlias(
  db: AppDb,
  input: { scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string; discipline?: string },
  requireComplete: boolean,
): PortalRecipe | null {
  const wanted = s(input.scopeType === "utility" ? input.utility : input.ahj).trim();
  if (!wanted) return null;
  // A state-less project is exactly where a wrong-portal replay could slip through, since
  // the state guard below can only compare states it has. Fuzzy needs both sides known.
  if (!s(input.state).trim()) return null;
  const discipline = s(input.discipline);
  const rows = db.query<Row>(
    `SELECT * FROM portal_recipes WHERE scope_type = ?${requireComplete ? " AND status = 'complete'" : ""}
       AND (discipline = ? OR discipline = '') ORDER BY updated_at DESC`,
    [input.scopeType, discipline],
  );
  let best: { row: Row; score: number } | null = null;
  for (const row of rows) {
    // Never cross states — a same-named utility in another state is a different portal.
    const rowState = s(row.state);
    if (!rowState || rowState.toLowerCase() !== s(input.state).trim().toLowerCase()) continue;
    const score = knowledgeNameMatchScore(wanted, s(input.scopeType === "utility" ? row.utility : row.ahj));
    if (score >= NAME_ALIAS_MIN_SCORE && (!best || score > best.score)) best = { row, score };
  }
  return best ? mapRecipe(best.row) : null;
}

export function findCompleteRecipeForProject(
  db: AppDb,
  input: { scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string; discipline?: string },
): PortalRecipe | null {
  const key = recipeProfileKey(input);
  const discipline = s(input.discipline);
  const row = db.get<Row>(
    `SELECT * FROM portal_recipes
      WHERE profile_key = ? AND status = 'complete' AND (discipline = ? OR discipline = '')
      ORDER BY CASE WHEN discipline = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
    [key, discipline, discipline],
  );
  return row ? mapRecipe(row) : findRecipeByNameAlias(db, input, true);
}

// Like findCompleteRecipeForProject, but matches a recipe of ANY status (recording / needs_rerecord
// / complete), newest first. Used by staging to recover a launchable portal URL even before a recipe
// is verified-complete: a draft/recording recipe still carries the entry URL the operator (or a prior
// auto-learn pass) pointed the recorder at. Without it, a real portal whose only recipe is still a
// draft has no URL to launch and the self-seed can't fire — staging silently falls to the no-op mock.
export function findAnyRecipeForProject(
  db: AppDb,
  input: { scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string; discipline?: string },
): PortalRecipe | null {
  const key = recipeProfileKey(input);
  const discipline = s(input.discipline);
  // Discipline-scoped for the same reason as above. Critically, this is what the learn
  // path calls to decide whether a trusted recipe already exists: unscoped, an ELECTRICAL
  // learn would see the STRUCTURAL recipe, "preserve" it, and silently discard its own
  // pass — the other half of the one-recipe-per-AHJ ceiling.
  const row = db.get<Row>(
    `SELECT * FROM portal_recipes
      WHERE profile_key = ? AND (discipline = ? OR discipline = '')
      ORDER BY CASE WHEN discipline = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
    [key, discipline, discipline],
  );
  return row ? mapRecipe(row) : findRecipeByNameAlias(db, input, false);
}

// Start (or reset) a recording for a portal. Creates a 'recording' stub keyed by
// profile_key; if a recipe already exists for that key, bumps the version and clears
// the steps so the admin re-records cleanly (used for "delete & re-record").
export function startPortalRecording(
  db: AppDb,
  input: { scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string; portalPlatform?: string; portalUrl?: string; createdBy?: string; discipline?: string },
): PortalRecipe {
  const scopeType = input.scopeType === "utility" ? "utility" : "ahj";
  if (scopeType === "ahj" && !s(input.ahj).trim()) throw new HttpError(400, "ahj is required for an AHJ recipe.");
  if (scopeType === "utility" && !s(input.utility).trim()) throw new HttpError(400, "utility is required for a utility recipe.");
  // A utility recipe is keyed by utility ONLY (it replays for any AHJ in that utility's
  // territory), so it must NOT carry the originating project's AHJ city — otherwise it
  // gets mislabeled as a city ("PGE shown as City of Dayton"). Null out ahj for utility.
  const ahj = scopeType === "utility" ? "" : s(input.ahj);
  const key = recipeProfileKey(input);
  // Scoped to THIS discipline: an electrical learn must not reset the AHJ's structural
  // recipe (or vice versa). A legacy row (discipline '') is adopted by the first learn
  // that claims a discipline, so the existing recipe is upgraded in place rather than
  // orphaned beside a duplicate.
  const discipline = scopeType === "utility" ? "" : s(input.discipline);
  const existing = db.get<Row>(
    `SELECT * FROM portal_recipes WHERE profile_key = ? AND (discipline = ? OR discipline = '')
      ORDER BY CASE WHEN discipline = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
    [key, discipline, discipline],
  );
  const now = nowIso();
  if (existing) {
    const nextVersion = Number(existing.version ?? 1) + 1;
    // Snapshot the outgoing steps BEFORE wiping so an abandoned re-record can be
    // rolled back to the last working recipe (see restoreRecipeSnapshotIfAbandoned).
    // Only a non-empty step list overwrites the snapshot — re-recording twice in a
    // row must not clobber a good snapshot with the empty stub of attempt one.
    const outgoingSteps = parseJson<RecipeStep[]>(s(existing.steps_json) || "[]", []);
    db.run(
      `UPDATE portal_recipes SET status = 'recording', version = ?, steps_json = '[]',
         prev_steps_json = CASE WHEN ? != '' THEN ? ELSE prev_steps_json END,
         portal_platform = COALESCE(NULLIF(?, ''), portal_platform),
         portal_url = COALESCE(NULLIF(?, ''), portal_url),
         discipline = ?, updated_at = ? WHERE id = ?`,
      [nextVersion,
        outgoingSteps.length ? s(existing.steps_json) : "", outgoingSteps.length ? s(existing.steps_json) : "",
        s(input.portalPlatform), s(input.portalUrl), discipline, now, s(existing.id)],
    );
    return getPortalRecipe(db, s(existing.id));
  }
  const recipeId = id();
  db.run(
    `INSERT INTO portal_recipes
      (id, scope_type, profile_key, state, ahj, utility, portal_platform, portal_url, status, version, steps_json, created_by, created_at, updated_at, notes, discipline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recording', 1, '[]', ?, ?, ?, '', ?)`,
    [recipeId, scopeType, key, s(input.state), ahj, s(input.utility), s(input.portalPlatform), s(input.portalUrl), s(input.createdBy), now, now, discipline],
  );
  return getPortalRecipe(db, recipeId);
}

// Roll an ABANDONED re-record back to the last working recipe. Called by the
// stale-recording sweep: if the stub still holds a pre-re-record snapshot, the
// portal gets its proven steps back as 'complete' (the bot can replay again)
// instead of being stranded with no recipe at 'needs_rerecord'. Returns true
// when a snapshot was restored.
export function restoreRecipeSnapshotIfAbandoned(db: AppDb, recipeId: string): boolean {
  const row = db.get<Row>("SELECT * FROM portal_recipes WHERE id = ?", [recipeId]);
  if (!row || s(row.status) !== "recording") return false;
  const snapshot = parseJson<RecipeStep[]>(s(row.prev_steps_json) || "[]", []);
  if (!snapshot.length) return false;
  db.run(
    `UPDATE portal_recipes SET steps_json = ?, status = 'complete', structure_sig = ?, prev_steps_json = NULL,
       notes = notes || ?, updated_at = ? WHERE id = ? AND status = 'recording'`,
    [asJson(snapshot), recipeStructureSignature(snapshot),
      " [re-record abandoned — restored the previous working recipe]", nowIso(), recipeId],
  );
  return true;
}

// A stable fingerprint of a recipe's STRUCTURE — the ordered shape of its steps
// (action + selector identity), deliberately excluding any filled values. Two
// recordings of the same portal flow hash the same; a portal that adds/removes/renames
// a field changes the hash. Stored at save time as the baseline a future pre-flight
// drift check (or a re-record) can compare a freshly-observed structure against.
export function recipeStructureSignature(steps: RecipeStep[]): string {
  const shape = (Array.isArray(steps) ? steps : []).map((step) => {
    const sel = step.selector || {};
    // Identity = action + the most stable selector handle available (name/text/css),
    // never the value, so the signature tracks structure, not a project's data.
    return [step.action, sel.name || sel.text || sel.css || "", step.field || ""].join("|");
  });
  const joined = shape.join("\n");
  // Cheap deterministic 32-bit hash (FNV-1a) — no crypto import needed for a fingerprint.
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Save the recorded steps (called by the recorder when the admin finishes). Marks the
// recipe 'complete' so the bot will replay it. A short/empty recording stays 'recording'.
export function savePortalRecipeSteps(
  db: AppDb,
  recipeId: string,
  steps: RecipeStep[],
  options: { status?: PortalRecipeStatus; notes?: string } = {},
): PortalRecipe {
  getPortalRecipe(db, recipeId); // 404 if missing
  const status = options.status ?? (Array.isArray(steps) && steps.length > 0 ? "complete" : "recording");
  db.run(
    // A recording that lands 'complete' supersedes the pre-re-record snapshot,
    // so drop it; anything still mid-recording keeps the rollback available.
    `UPDATE portal_recipes SET steps_json = ?, status = ?, structure_sig = ?,
       prev_steps_json = CASE WHEN ? = 'complete' THEN NULL ELSE prev_steps_json END,
       notes = COALESCE(NULLIF(?, ''), notes), updated_at = ? WHERE id = ?`,
    [asJson(steps ?? []), status, recipeStructureSignature(steps ?? []), status, s(options.notes), nowIso(), recipeId],
  );
  return getPortalRecipe(db, recipeId);
}

// Promote a "recording" recipe to "complete" once a human has verified/fixed the captured
// fill (the "Recording looks right — save recipe" action, or automatically when the operator
// marks the track submitted — their manual submit just demonstrated the flow works). A recipe
// with no steps can't be promoted; already-complete is a no-op.
export function finishPortalRecipe(db: AppDb, recipeId: string, finishedBy?: string): PortalRecipe {
  const recipe = getPortalRecipe(db, recipeId);
  if (recipe.status === "complete") return recipe;
  if (!recipe.steps.length) throw new HttpError(409, "This recording has no captured steps yet — nothing to save as a replayable recipe.");
  db.run("UPDATE portal_recipes SET status = 'complete', prev_steps_json = NULL, notes = notes || ?, updated_at = ? WHERE id = ?", [
    ` [verified by ${finishedBy || "operator"} — promoted from recording]`, nowIso(), recipeId,
  ]);
  return getPortalRecipe(db, recipeId);
}

// AUTOMATIC promotion chokepoint (submit-observed signal, mark-submitted): promote a
// recording only when the learn actually REACHED REVIEW — its steps carry a terminal
// marker (stopForReview / isFinalSubmit). Without this guard, a learn that paused on a
// CAPTCHA at page 2 (or a stale abandoned draft) would be silently promoted to a
// replayable "complete" recipe by the operator's unrelated manual submit, and the bot
// would then deterministically replay a mid-form fragment for every future project.
// The explicit "Recording looks right — save recipe" button keeps using
// finishPortalRecipe directly: a deliberate operator override needs no marker.
export function promoteRecordingIfEligible(
  db: AppDb,
  recipeId: string,
  opts: { finishedBy: string; via: string; projectId?: string | null; /** Promote DESPITE recorded required-blank findings. Requires a written reason — see below. */ overrideBlankFields?: string },
): PortalRecipe | null {
  const recipe = getPortalRecipe(db, recipeId);
  if (recipe.status !== "recording" || recipe.steps.length === 0) return null;
  const reachedReview = recipe.steps.some(
    (st) => st.action === "stopForReview" || (st as { isFinalSubmit?: boolean }).isFinalSubmit === true,
  );
  if (!reachedReview) return null;

  // REACHING REVIEW IS NOT THE SAME AS FILLING THE FORM. The learn's required-field sweep
  // writes "Required field(s) left blank/unselected" into the notes precisely so a recipe
  // that walked the whole wizard while leaving required fields empty cannot be trusted.
  // That happened on the first Ameren Illinois learn — the sweep named Email, Street, Name,
  // Company, Address and Docket Number, and the recipe was promoted anyway on the strength
  // of a summary row that looked populated. Replay then faithfully reproduced an incomplete
  // application, reporting "no failures" because every recorded step did succeed.
  //
  // So the blank finding now BLOCKS promotion. Overriding is still possible, because a
  // sweep can be wrong, but it takes a written reason that lands in the notes and the audit
  // log next to the fields it overrode.
  const blankFinding = /required field\(s\) left blank/i.test(recipe.notes || "");
  if (blankFinding && !opts.overrideBlankFields) {
    throw new HttpError(409,
      "This recipe recorded REQUIRED FIELDS LEFT BLANK, so it is not trustworthy yet: "
      + `${(recipe.notes.match(/Required field\(s\) left blank[^.]*/i) || [""])[0].slice(0, 300)}. `
      + "Fill those fields (usually by adding the missing project/client data and re-learning), "
      + "or promote with an explicit written reason if the sweep is wrong.");
  }
  const finished = finishPortalRecipe(db, recipeId, opts.finishedBy);
  try {
    addAuditLog(db, opts.projectId ?? null, "human", "operator", "portal_recipe.finished", {
      recipeId, via: opts.via, profileKey: recipe.profileKey,
      // An override is the thing a later reader most needs to see, so it is stored
      // explicitly rather than buried in the free-text `via`.
      ...(opts.overrideBlankFields ? { overrodeBlankFieldFinding: opts.overrideBlankFields } : {}),
    });
  } catch { /* audit is best-effort */ }
  return finished;
}

export function markPortalRecipeForRerecord(db: AppDb, recipeId: string): PortalRecipe {
  getPortalRecipe(db, recipeId);
  db.run("UPDATE portal_recipes SET status = 'needs_rerecord', updated_at = ? WHERE id = ?", [nowIso(), recipeId]);
  return getPortalRecipe(db, recipeId);
}

export function deletePortalRecipe(db: AppDb, recipeId: string): { deleted: boolean } {
  getPortalRecipe(db, recipeId);
  db.run("DELETE FROM portal_recipes WHERE id = ?", [recipeId]);
  return { deleted: true };
}

// Human-readable descriptions for every bindable field key — used by the LLM field-binding
// classifier to understand what each key means when matching portal form values.
export const RECIPE_FIELD_DESCRIPTIONS: Record<string, string> = {
  homeownerName: "Property owner full name (the person who owns the house) — NOT the utility account holder, which is ubAccountHolder",
  ubAccountHolder: "Utility bill account holder, exactly as printed on the bill — this is the CUSTOMER on an interconnection application",
  wattsmartBatteryProgram: "Yes/No for the utility battery programme — Yes only when the project has storage",
  ubAccountHolderFirstName: "Utility bill account holder first name (title stripped)",
  ubAccountHolderLastName: "Utility bill account holder last name",
  ubAccountHolderEmail: "Account holder email (falls back to the homeowner's)",
  ubAccountHolderPhone: "Account holder phone (falls back to the homeowner's)",
  projectName: "Permit \"Project Name\" — the homeowner's name, which is how the AHJ, the inspector and the office look the job up later",
  homeownerFirstName: "Property owner first (given) name only",
  homeownerLastName: "Property owner last (family) name only",
  homeownerEmail: "Property owner / homeowner email address",
  homeownerPhone: "Property owner / homeowner phone number",
  street: "Installation site street address (no city/state/zip)",
  projectAddress: "Installation site full street address",
  city: "Installation site city",
  state: "Installation site state (2-letter abbreviation, e.g. OR)",
  zip: "Installation site zip/postal code",
  ahj: "Authority Having Jurisdiction (city/county) name",
  utility: "Electric utility company name",
  accountNumber: "Customer utility account number",
  meterNumber: "Utility meter number",
  interconnectionMethod: "Interconnection method (e.g. NEM, Parallel Generation)",
  systemSizeDcKw: "Solar system DC size in kilowatts",
  systemSizeAcKw: "Solar system AC size in kilowatts",
  totalExportKw: "Total export capacity in kilowatts",
  inverterManufacturer: "Inverter manufacturer/make (e.g. Tesla, Enphase, SolarEdge)",
  inverterMake: "Inverter manufacturer/make (alias of inverterManufacturer)",
  inverterModel: "Inverter model number",
  inverterQuantity: "Number of inverters",
  inverterQty: "Number of inverters (alias of inverterQuantity)",
  moduleManufacturer: "PV module/panel manufacturer/make",
  moduleMake: "PV module/panel manufacturer/make (alias of moduleManufacturer)",
  moduleModel: "PV module/panel model number",
  moduleQuantity: "Total number of PV modules/panels across all arrays",
  moduleQty: "Total number of PV modules/panels (alias of moduleQuantity)",
  totalModuleQuantity: "Total number of PV modules/panels across all arrays",
  moduleWattage: "Per-module DC wattage (W)",
  mainServiceRating: "Main service panel/entrance rating in amps",
  hasBattery: "Whether the system includes battery storage (Yes/No)",
  batteryManufacturer: "Battery/storage manufacturer/make",
  batteryModel: "Battery/storage model number",
  batteryQuantity: "Number of battery units",
  installerCompanyName: "Installer/contractor company name",
  installerEmail: "Installer company or contact email address",
  installerPhone: "Installer company phone number",
  installerAddress: "Full installer company address (street, city, state, zip combined)",
  installerStreet: "Installer company street address only",
  installerCityStateZip: "Installer company city, state, zip (no street)",
  installerContactName: "Installer contact person full name",
  ccbLicenseNumber: "CCB (contractor) license number",
  electricalLicenseNumber: "Electrical contractor license number",
  docketNumber: "ICC/state docket number for the installer's DG certification (Illinois Part 468)",
  metroCityLicenseNumber: "Metro or city business license number",
  electricalSupervisorName: "Supervising electrician full name",
  electricianLicenseNumber: "Supervising electrician license number",
  authorizedSignerName: "Authorized signer or representative full name",
  authorizedSignerTitle: "Authorized signer's title",
  powerclerkExistingContact: "PowerClerk existing contact ID code",
  accelaContactCode: "Accela contact/license lookup code",
  hasExistingSystem: "Whether an existing PV/storage system is already interconnected on site (Yes/No)",
  existingSystemSizeDcKw: "EXISTING (already interconnected) system DC size in kilowatts",
  existingSystemSizeAcKw: "EXISTING (already interconnected) system AC size in kilowatts",
  totalSystemSizeDcKw: "COMBINED (existing + new) total system DC size in kilowatts after the addition",
  totalSystemSizeAcKw: "COMBINED (existing + new) total system AC size in kilowatts after the addition",
  existingInverterMake: "EXISTING system's inverter manufacturer/make",
  existingInverterModel: "EXISTING system's inverter model number",
  existingInverterQty: "Number of inverters in the EXISTING system",
  existingModuleMake: "EXISTING system's PV module manufacturer/make",
  existingModuleModel: "EXISTING system's PV module model number",
  existingBatteryMakeModel: "EXISTING system's battery/storage make and model",
  nemTariff: "NEM tariff/program the existing system is on (e.g. NEM1, NEM2, NEM3/NBT)",
  existingPtoDate: "Permission-to-operate date of the EXISTING system",
  existingNemAgreementNumber: "EXISTING interconnection/NEM agreement number (sensitive — bind by name, never a literal)",
  existingNemApplicationNumber: "EXISTING interconnection application number (sensitive — bind by name, never a literal)",
  exportMode: "Export mode of the system (export / non-export-pcs / ngom)",
};

// Build the field-substitution map a recipe step's `field` resolves against at replay:
// the project's authoritative fields + the assigned client's licensing overlay (so the
// correct contractor identity is always used) + parser-snapshot extras as fallback.
// Commissioning is an ESTIMATE the applicant supplies, not a known project date — no
// parser snapshot in the live DB carries one. Six weeks out matches the horizon the
// planner was already told to use ("todayDate plus a few weeks") and is comfortably
// future-dated for a portal that rejects a past commissioning date.
const COMMISSIONING_HORIZON_DAYS = 42;
function dateFields(): Record<string, string> {
  const today = new Date();
  const commissioning = new Date(today.getTime() + COMMISSIONING_HORIZON_DAYS * 86400000);
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const us = (d: Date): string => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  return {
    todayDate: iso(today),
    todayDateUs: us(today),
    estimatedCommissioningDate: us(commissioning),
    estimatedCommissioningDateIso: iso(commissioning),
  };
}

// Which date field a recorded date literal should become. Value-equality binding cannot
// reach these (that is exactly why they froze), so this matches on the CONTROL's label
// and picks the format the portal already demonstrated it accepts.
const DATE_LITERAL = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})$/;
const FUTURE_DATE_LABEL = /commission|in[- ]?service|energiz|operation|installation|completion|start|planned|expected|estimated|anticipat|schedul/i;
export function dateFieldForLiteral(label: string, value: string): string | null {
  const raw = String(value || "").trim();
  if (!DATE_LITERAL.test(raw)) return null;
  const text = String(label || "");
  if (!/date/i.test(text)) return null; // only rebind a control that is actually a date
  const isUs = raw.includes("/");
  if (FUTURE_DATE_LABEL.test(text)) return isUs ? "estimatedCommissioningDate" : "estimatedCommissioningDateIso";
  // A signature/application date is "today", not a future estimate.
  return isUs ? "todayDateUs" : "todayDate";
}

// A plan-set orientation rounded to the whole degree the portals accept. Anything that is
// not a number is passed through untouched (a portal may legitimately want "SW").
function wholeDegrees(value: unknown): unknown {
  if (value == null || value === "") return value;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) return value;
  return String(Math.round(n));
}

// The model strings a portal will actually list, for this project's equipment. Kept beside
// the other derived fields so both learn and replay see the same map.
function certifiedModelFields(
  db: AppDb,
  snapshotFlat: Record<string, string>,
  equipment: Record<string, string>,
): Record<string, string> {
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = String(equipment[k] ?? snapshotFlat[k] ?? "").trim();
      if (v) return v;
    }
    return "";
  };
  const out: Record<string, string> = {};
  try {
    const modWatts = pick("moduleWattage", "moduleWatts", "watts");
    const mod = certifiedModelFor(db, "module", pick("moduleMake", "moduleManufacturer"), pick("moduleModel"), modWatts);
    if (mod) out.moduleModelCertified = mod;
    const inv = certifiedModelFor(db, "inverter", pick("inverterMake", "inverterManufacturer"), pick("inverterModel"), pick("inverterWattage"));
    if (inv) out.inverterModelCertified = inv;
  } catch { /* CEC table absent or unsynced — fall back to the plan-set values */ }
  return out;
}

export function resolveRecipeFieldValues(db: AppDb, project: ProjectRecord, portalType: string): Record<string, string> {
  const snapshot = project.parserSnapshot || {};
  const snapshotFlat: Record<string, string> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (v == null || typeof v === "object") continue;
    const s = String(v);
    // Fill values are short scalars. Long free-text blobs (plan-set extracted text,
    // split-page mappings, checklists, notes) are evidence for the reviewer gate, not
    // portal field values — and because projectFields is serialized into EVERY LLM
    // planning call, letting them through multiplies token spend per call (a 150KB
    // plan-set text is ~40k tokens on every planPortalFields call).
    if (k === "planSetExtractedText" || s.length > 400) continue;
    snapshotFlat[k] = s;
  }

  // Derive split first/last from full homeowner name so portals with separate
  // first/last inputs get proper field bindings instead of LLM-guessed literals.
  const hoFullName = (project.homeownerName || "").trim();
  const hoNameParts = hoFullName.split(/\s+/);
  const homeownerFirstName = hoNameParts[0] || "";
  const homeownerLastName = hoNameParts.slice(1).join(" ") || "";

  // Street-only address (no city/state/zip) for portals that split the address.
  // Comma-delimited addresses split cleanly; a comma-LESS parsed address ("7307 SW Arranmore
  // Way Portland OR 97223" — common from OCR) would leak city/state/zip into the street
  // field, so also strip a trailing "<city> [ST [zip]]" tail when it matches the project.
  let streetOnly = (project.projectAddress || "").split(",")[0].trim();
  if (streetOnly && project.city) {
    const esc = project.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    streetOnly = streetOnly.replace(new RegExp(`\\s+${esc}(\\s+[A-Za-z]{2})?(\\s+\\d{5}(-\\d{4})?)?\\s*$`, "i"), "").trim() || streetOnly;
  }

  // AN INTERCONNECTION IS FILED UNDER THE NAME ON THE BILL.
  //
  // The permit goes under the property owner; the interconnection goes under whoever holds
  // the utility ACCOUNT, and they are routinely different people. Live: Ivy's account reads
  // "PROF CHRIS A IVY" where the project says "Christopher Ivy", and Marineau's account is
  // held by CRAIG while the plan set names ANN — a joint account. Filing a NEM application
  // under a name the utility has no account for is a rejection, or worse, a second account.
  //
  // Operator rule: intake keys off the project, submittal keys off the bill. So on a UTILITY
  // portal the homeowner* bindings resolve to the account holder, which fixes recipes already
  // recorded against homeownerName without re-recording them. ubAccountHolder* is also
  // exposed in its own right so a fresh recording can bind to it explicitly.
  const ubHolder = String(snapshotFlat.ubAccountHolder || "").trim();
  // A billing name often carries a title ("PROF CHRIS A IVY"). Keep the full string for the
  // account-name field — it should match the bill — but drop the title before splitting, or
  // the first-name box gets "PROF".
  const ubNameParts = ubHolder.replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, "").split(/\s+/).filter(Boolean);
  const ubFirstName = ubNameParts[0] || "";
  const ubLastName = ubNameParts.length > 1 ? ubNameParts[ubNameParts.length - 1] : "";
  // TWO ROLES, TWO FIELDS — DO NOT COLLAPSE THEM.
  //
  // A first cut made homeownerName resolve to the account holder on any utility portal. That
  // is wrong wherever the form asks for BOTH, and PacifiCorp's does: page 3 is "Customer
  // Information" (the account holder) and page 4 is "Property Owner Information" (the person
  // who owns the house). Overriding homeownerName would have put PROF CHRIS A IVY into the
  // property-owner block, which is a different assertion about a different person.
  //
  // So homeowner* stays the property owner, always and on every portal, and the account
  // holder has its own name. A recording binds the customer block to ubAccountHolder* and the
  // owner block to homeowner*, which is what the form is actually asking for.
  const projectFields: Record<string, string> = {
    homeownerName: project.homeownerName,
    // The permit's "Project Name" always follows the PROJECT, never the billing name — it is
    // how the AHJ and the inspector find the job.
    // Bound, never frozen: a recipe is shared across every project under the profile, so a
    // literal here would file every future job under the learn project's homeowner.
    projectName: project.homeownerName,
    // Always available by their own names, whichever portal this is.
    ubAccountHolder: ubHolder,
    // Operator policy: participate in the utility's battery programme only when the job
    // actually has storage. Answering yes on a PV-only system invites battery requirements
    // for equipment that is not there.
    wattsmartBatteryProgram: /^(yes|true|y)$/i.test(String(snapshotFlat.hasBattery ?? "").trim()) ? "Yes" : "No",
    ubAccountHolderFirstName: ubFirstName,
    ubAccountHolderLastName: ubLastName,
    // The account holder's own contact details when the bill carries them; otherwise the
    // homeowner's, which is who the utility would reach about this address anyway. Never
    // blank — an empty required contact field fails the submission outright.
    ubAccountHolderEmail: String(snapshotFlat.ubAccountHolderEmail || snapshotFlat.homeownerEmail || ""),
    ubAccountHolderPhone: String(snapshotFlat.ubAccountHolderPhone || snapshotFlat.homeownerPhone || ""),
    homeownerFirstName,
    homeownerLastName,
    homeownerEmail: String(snapshotFlat.homeownerEmail || snapshotFlat.ownerEmail || ""),
    homeownerPhone: String(snapshotFlat.homeownerPhone || snapshotFlat.ownerPhone || ""),
    street: streetOnly || project.projectAddress,
    // Accela-style address SEARCH forms take the number and CORE street name in separate
    // boxes. The learner's work-location pass records its fills bound to these keys so a
    // shared recipe replays THIS project's address, never the learn project's literals.
    streetNumber: parseStreetNumber(project.projectAddress || ""),
    streetNameCore: parseStreetName(project.projectAddress || ""),
    // Bound instead of streetNameCore when the LEARN run's full-name search returned
    // zero results and its 3-char retry succeeded (the portal's own search hint).
    streetNameSearchPortion: parseStreetName(project.projectAddress || "").slice(0, 3),
    // SEGMENTED PHONE parts. Accela renders a US phone as three boxes (area/prefix/line);
    // recording the digits as literals would replay the LEARN project's phone number for
    // every future project, so each segment binds to its own derived key.
    ...phoneSegmentKeys("homeownerPhone", String(snapshotFlat.homeownerPhone || snapshotFlat.ownerPhone || "")),
    projectAddress: project.projectAddress,
    city: project.city,
    state: project.state,
    zip: project.zip,
    ahj: project.ahj,
    utility: project.utility,
    accountNumber: project.accountNumber,
    meterNumber: project.meterNumber,
    systemSizeDcKw: project.systemSizeDcKw == null ? "" : String(project.systemSizeDcKw),
    systemSizeAcKw: project.systemSizeAcKw == null ? "" : String(project.systemSizeAcKw),
    totalExportKw: project.totalExportKw == null ? "" : String(project.totalExportKw),
    interconnectionMethod: project.interconnectionMethod,
    // DATES ARE COMPUTED AT REPLAY, NEVER FROZEN. A portal date field has no project
    // value to bind to, so the learn-time planner computes one (llm.ts tells it to use
    // todayDate plus a few weeks) and — because convertLiteralsToBoundFields deliberately
    // skips the volatile todayDate — that computed value used to freeze into the recipe.
    // The live PGE recipe carried "08/08/2026" as its Estimated Commissioning Date: fine
    // the day it was learned, a PAST date by the time this was written, and every future
    // project would have filed it. These fields let the binder swap such a literal for a
    // binding that is recomputed on every replay. Both formats exist because the recorded
    // literal proves which one the portal accepted.
    // AC DISCONNECT. Utility interconnection portals ask for this by make/model/rating and
    // PacifiCorp REQUIRES it — a learn against a real project failed promotion on exactly
    // "Disconnect Switch Manufacturer" and "Disconnect Switch Model".
    //
    // The plan set's equipment schedule DOES carry the rating ("AC DISCONNECT 1 60A
    // NON-FUSIBLE AC DISCONNECT, 240V"), so those come from the parser. It does NOT carry
    // the make/model: the schedule leaves the part to the installer, and the manufacturer
    // named nearby belongs to the COMBINER PANEL, not the disconnect. So make/model is
    // operator knowledge (like the contract amount) and falls back to a per-installer
    // default. `disconnectMakeModel` is what a portal with ONE combined field wants.
    disconnectQty: String(snapshotFlat.acDiscQty ?? "").trim() || "1",
    disconnectAmps: String(snapshotFlat.acDiscAmps ?? "").trim(),
    disconnectVoltage: String(snapshotFlat.acDiscVoltage ?? "").trim(),
    disconnectType: String(snapshotFlat.acDiscFused ?? "").trim(),
    disconnectMake: String(snapshotFlat.acDiscMake ?? "").trim(),
    disconnectModel: String(snapshotFlat.acDiscModel ?? "").trim(),
    disconnectMakeModel: [String(snapshotFlat.acDiscMake ?? "").trim(), String(snapshotFlat.acDiscModel ?? "").trim()]
      .filter(Boolean).join(" ").trim(),
    ...dateFields(),
    // EXPORT LIMITING. Derived here, not only in the learner's planner map: a step that
    // BINDS to this key must resolve at REPLAY time, and it used to exist only at learn
    // time — so a recipe binding it filled nothing, forever, silently. Same derivation the
    // learner uses (autoLearn.ts), kept in the resolver so both sides agree by construction.
    exportLimiting:
      /non.?export|export.?limit\b|power control system|\bpcs\b|\bngom\b/i
        .test(`${snapshotFlat.exportMode ?? ""} ${snapshotFlat.pcs ?? ""} ${snapshotFlat.exportLimit ?? ""}`)
        ? "Yes" : "No",
    // ENERGY SOURCE — the GATE for a portal's whole battery section, and the reason it is
    // derived here rather than left as a recorded literal.
    //
    // PacifiCorp's recipe learned on a project WITH a Tesla battery recorded the literal
    // "Solar PV and Battery" with no field binding, so replaying it onto a project without
    // storage would have declared a battery that does not exist on an interconnection
    // application. The same portal's earlier learns, on projects WITHOUT batteries,
    // recorded "Solar PV" and carried ZERO battery steps — the portal only renders that
    // section once Battery is chosen. So this one answer decides whether ~17 downstream
    // questions are asked at all, and it must follow the project rather than whichever
    // system happened to be learned.
    //
    // Both option strings are taken from real recorded recipes for this portal, not
    // invented: "Solar PV" (v4/v6 backups) and "Solar PV and Battery" (v9).
    // hasBattery is set by normalize.ts, so it is present on real projects — but fall back
    // to the same inputs normalize derives it from, so this cannot silently answer "no
    // battery" for a snapshot that simply never went through normalisation.
    energySource: (
      /^y/i.test(String(snapshotFlat.hasBattery ?? "").trim())
      || String(snapshotFlat.batteryModel ?? "").trim() !== ""
      || Number(snapshotFlat.batteryQty ?? 0) > 0
    ) ? "Solar PV and Battery" : "Solar PV",
  };
  // EQUIPMENT BINDING (portal-agnostic). The PV module spec lives in a nested `pvArrays`
  // array in the parser snapshot, which the scalar-only flatten above drops — so the module
  // make/model/quantity never reached the planner and the equipment dropdowns came back
  // blank. Flatten it into scalar keys here, plus the key ALIASES the planner prompt already
  // references (moduleMake/moduleQty/inverterMake/inverterQty), so a value exists regardless
  // of which name a given portal's field maps to. Every utility/AHJ on any platform benefits;
  // nothing here is portal-specific. Only non-empty values are emitted (so they never blank
  // out a snapshot/overlay value via the merge below).
  const equipment: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    const s = v == null ? "" : String(v).trim();
    if (s) equipment[k] = s;
  };
  // Inverter aliases (snapshot uses *Manufacturer/*Quantity; the prompt/portals also say make/qty).
  put("inverterMake", snapshotFlat.inverterManufacturer || snapshotFlat.inverterMake);
  put("inverterQty", snapshotFlat.inverterQuantity || snapshotFlat.inverterQty);
  // Canonical inverter model (the parser stores it as invModel or pvMicroModel) so the
  // planner, the deterministic equipment pass, and recipe replay all bind one key.
  put("inverterModel", snapshotFlat.inverterModel || snapshotFlat.invModel || snapshotFlat.pvMicroModel);
  const arraysRaw = (snapshot as Record<string, unknown>).pvArrays;
  if (Array.isArray(arraysRaw) && arraysRaw.length) {
    let totalModules = 0;
    let firstMake = "";
    let firstModel = "";
    let firstWattage = "";
    arraysRaw.forEach((a, i) => {
      const arr = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
      const qty = arr.quantity ?? arr.moduleQuantity ?? arr.qty;
      const make = arr.moduleManufacturer ?? arr.moduleMake ?? arr.manufacturer;
      const model = arr.moduleModel ?? arr.model;
      const watt = arr.moduleWattage ?? arr.wattage ?? arr.watts;
      const n = Number(qty);
      if (!isNaN(n)) totalModules += n;
      if (!firstMake && make) firstMake = String(make);
      if (!firstModel && model) firstModel = String(model);
      if (!firstWattage && watt) firstWattage = String(watt);
      // Per-array indexed keys for portals with a repeater (one row per array/string).
      const p = `array${i + 1}`;
      put(`${p}ModuleQuantity`, qty);
      put(`${p}ModuleManufacturer`, make);
      put(`${p}ModuleModel`, model);
      put(`${p}ModuleWattage`, watt);
      // WHOLE DEGREES. Plan sets carry fractional orientations ("180.5"), but the utility
      // portals ask for degrees as an integer — filing the decimal was flagged live on the
      // PacifiCorp form. Half a degree is far below anything that changes an
      // interconnection review, so round rather than truncate or pass it through.
      put(`${p}Azimuth`, wholeDegrees(arr.azimuth));
      put(`${p}Tilt`, wholeDegrees(arr.tilt));
    });
    // The bare aliases some portals bind to come from the raw snapshot, which keeps the
    // plan-set decimal — round those the same way so no path can reach a portal with a
    // fractional degree. `equipment` overrides snapshotFlat in the merge below.
    put("azimuth", wholeDegrees(snapshotFlat.azimuth));
    put("tilt", wholeDegrees(snapshotFlat.tilt));
    put("moduleManufacturer", firstMake);
    put("moduleMake", firstMake);
    put("moduleModel", firstModel);
    put("moduleWattage", firstWattage);
    if (totalModules > 0) {
      put("moduleQuantity", totalModules);
      put("moduleQty", totalModules);
      put("totalModuleQuantity", totalModules);
    }
  } else {
    // No array repeater — carry any flat module scalars + their aliases through.
    put("moduleManufacturer", snapshotFlat.moduleManufacturer || snapshotFlat.moduleMake);
    put("moduleMake", snapshotFlat.moduleManufacturer || snapshotFlat.moduleMake);
    put("moduleModel", snapshotFlat.moduleModel);
    put("moduleQty", snapshotFlat.moduleQuantity || snapshotFlat.moduleQty);
    put("moduleQuantity", snapshotFlat.moduleQuantity || snapshotFlat.moduleQty);
    put("moduleWattage", snapshotFlat.moduleWattage);
  }

  // EXISTING-SYSTEM / NEM-ADDITION BINDINGS. Additions must disclose the existing
  // system's size/equipment and the combined totals on interconnection applications.
  // Values come from the project's structured existingSystem block (intake/manual);
  // only non-empty values are emitted so they never blank another layer.
  // existingNemAgreementNumber / existingNemApplicationNumber are account-linked
  // identifiers — they bind here BY NAME for deterministic replay, and
  // buildPortalPlanner strips them (key + value match) before anything reaches the
  // LLM, same as accountNumber/meterNumber (safety rule 2).
  const existingSys: Record<string, string> = {};
  const es = project.existingSystem;
  if (es) {
    const putEs = (k: string, v: unknown) => {
      const s = v == null ? "" : String(v).trim();
      if (s) existingSys[k] = s;
    };
    putEs("hasExistingSystem", es.hasExistingSystem ? "Yes" : "");
    putEs("existingSystemSizeDcKw", es.existingDcKw);
    putEs("existingDcKw", es.existingDcKw);
    putEs("existingSystemSizeAcKw", es.existingAcKw);
    putEs("existingAcKw", es.existingAcKw);
    putEs("totalSystemSizeDcKw", es.combinedDcKw);
    putEs("combinedDcKw", es.combinedDcKw);
    putEs("totalSystemSizeAcKw", es.combinedAcKw);
    putEs("combinedAcKw", es.combinedAcKw);
    putEs("existingInverterMake", es.existingInverterMake);
    putEs("existingInverterModel", es.existingInverterModel);
    putEs("existingInverterQty", es.existingInverterQty);
    putEs("existingModuleMake", es.existingModuleMake);
    putEs("existingModuleModel", es.existingModuleModel);
    putEs("existingBatteryMakeModel", es.existingBatteryMakeModel);
    putEs("nemTariff", es.nemTariff);
    putEs("existingPtoDate", es.ptoDate);
    putEs("existingNemAgreementNumber", es.agreementNumber);
    putEs("existingNemApplicationNumber", es.applicationNumber);
    putEs("exportMode", es.exportMode);
  }

  const overlay = project.clientId ? clientStagingOverlay(db, project.clientId, portalType) : {};

  // Derive split installer first/last from the full installer contact name (mirrors the
  // homeowner split above). The overlay only provides a full `installerContactName`, so a
  // portal with separate first/last installer inputs (e.g. PGE PowerClerk Preparer/Installer
  // pages) had no binding to hit — the planner then guessed, and the company name bled into
  // the Name field. Only emit when non-empty so we never blank a real value via the merge.
  const installerSplit: Record<string, string> = {};
  const instFullName = String(overlay.installerContactName || "").trim();
  if (instFullName) {
    const parts = instFullName.split(/\s+/);
    installerSplit.installerFirstName = parts[0] || "";
    installerSplit.installerLastName = parts.slice(1).join(" ") || "";
  }

  // Precedence: snapshot scalars → derived equipment aliases → existing-system block → explicit project fields →
  // client licensing overlay → derived installer name split (each later layer wins).
  // PORTAL-READY EQUIPMENT MODELS, resolved last so it can see the merged equipment map.
  // A portal's dropdown lists CEC strings and the plan set's model is a prefix of them
  // ("DS3-L" vs "DS3-L {240V}"). Resolved HERE, where the CEC table lives, rather than in
  // the browser: PowerClerk renders a native <select> on one page and a Vue combobox
  // <input> on another, and a combobox has no <option> elements for a page-side matcher to
  // read — so it gave up exactly where the equipment matters. Empty when the CEC list is
  // unsynced or the choice is ambiguous, leaving the plan-set value to be used unchanged.
  const certifiedModels = certifiedModelFields(db, snapshotFlat, equipment);
  return { ...snapshotFlat, ...equipment, ...existingSys, ...projectFields, ...overlay, ...installerSplit, ...certifiedModels };
}

// ---------------------------------------------------------------------------
// Post-learn binding pass.
//
// The auto-learned recipe is the ONLY home for a portal's specifics, so any fill the
// learner recorded as a frozen LITERAL `value` (instead of a reusable `field` binding)
// replays verbatim on every future project. When that literal happens to be THIS project's
// own data (homeowner name, site address, system size, …), replaying it onto a DIFFERENT
// project produces wrong-but-plausible data that per-project verification — which only checks
// against the learn-project's data — can never catch.
//
// This deterministic pass converts a recorded literal into a `field` binding when the literal
// equals exactly one project field value. A literal matching MULTIPLE field values is AMBIGUOUS
// (we can't know which key the portal expects) — left literal and reported, so the caller can
// refuse to promote the recipe. Truly portal-specific literals (dropdown options, "Yes"/"No",
// "Solar") match no project value and are kept as-is.
// ---------------------------------------------------------------------------
export interface LiteralBindingResult {
  steps: RecipeStep[];
  /** Literals uniquely matched and converted to field bindings. */
  bound: Array<{ value: string; field: string; note?: string }>;
  /** Literals that equal project data but map to >1 field — cannot be safely auto-bound. */
  ambiguous: Array<{ value: string; candidates: string[]; note?: string }>;
  /**
   * Literals that COLLIDED with project data by coincidence — the control's label shows it
   * is asking something else entirely (a portal policy question), so the literal is kept
   * and the collision is reported for awareness rather than blocking the recipe.
   */
  portalConstants: Array<{ value: string; note?: string }>;
}

// Disambiguate a literal that matches SEVERAL project fields, using the control's own
// label. A Yes/No portal question is the common case: "No" is equally the value of
// hasBattery and of exportLimiting, so the binder refused to bind either and treated the
// ambiguity as a hard blocker — which by itself kept the live PGE recipe out of trust. The
// control was labelled "Energy Storage", which says plainly which field it is.
// Synonyms bridge the portal's wording to the field's name; a candidate wins only if it is
// the UNIQUE best match, so a genuinely ambiguous literal still blocks as before.
const FIELD_TOKEN_SYNONYMS: Record<string, string[]> = {
  battery: ["battery", "batteries", "storage", "ess"],
  export: ["export", "exporting"],
  limiting: ["limit", "limiting", "limited", "curtail", "curtailment"],
  phone: ["phone", "telephone", "mobile", "cell"],
  email: ["email", "e-mail"],
  zip: ["zip", "postal"],
  street: ["street", "address"],
  installer: ["installer", "contractor", "company"],
  homeowner: ["homeowner", "owner", "customer", "applicant"],
};
function fieldNameTokens(field: string): string[] {
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t && !["has", "is", "the", "of", "a", "an", "no", "number"].includes(t));
  const out = new Set<string>();
  for (const w of words) for (const t of (FIELD_TOKEN_SYNONYMS[w] ?? [w])) out.add(t);
  return [...out];
}
export function disambiguateByLabel(label: string, candidates: string[]): string | null {
  const text = String(label || "").toLowerCase();
  if (!text.trim() || candidates.length < 2) return null;
  const scored = candidates.map((c) => {
    const toks = fieldNameTokens(c);
    const hit = toks.filter((t) => text.includes(t));
    return { c, n: hit.length, extra: toks.length - hit.length };
  });
  const best = Math.max(...scored.map((x) => x.n));
  if (best === 0) return null;
  let winners = scored.filter((x) => x.n === best);
  // Tiebreak on PRECISION: "Installation Voltage" matches both serviceVoltage and voltage
  // on the token "voltage", but serviceVoltage also carries "service", which the label does
  // not say. The candidate with nothing left over is the better read of the label.
  if (winners.length > 1) {
    const fewest = Math.min(...winners.map((x) => x.extra));
    winners = winners.filter((x) => x.extra === fewest);
  }
  return winners.length === 1 ? winners[0].c : null;
}

// A literal can match project data by COINCIDENCE. PacifiCorp asks "Will the net metering
// facility interconnect to a switchgear?", "…include a parallel blocking scheme?", "…serve
// more than one customer?" — four separate questions whose answer is "No", which is also
// this project's hasBattery and exportLimiting. Binding any of them would be actively
// wrong: a later project with a battery would flip its answer about a switchgear. But
// REPORTING them as ambiguous is a hard blocker in the trust gate, and it kept the
// PacifiCorp recipe out of trust over a question that has nothing to do with the fields it
// collided with.
//
// A label that is SUBSTANTIVE and shares nothing with any candidate's name is strong
// evidence the control is a portal constant, not project data. A thin or missing label is
// not evidence of anything, so that case still blocks exactly as before.
const LABEL_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "is", "are", "will", "do", "does", "you", "your",
  "this", "that", "for", "and", "or", "be", "on", "at", "it", "if", "any", "please", "select",
]);
export function labelRulesOutAllCandidates(label: string, candidates: string[]): boolean {
  const text = String(label || "").toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !LABEL_STOPWORDS.has(w));
  if (new Set(words).size < 3) return false; // too thin to conclude anything
  return candidates.every((c) => fieldNameTokens(c).every((t) => !text.includes(t)));
}

// Steps bound to a field name the project data does not define. The LLM planner CHOOSES
// the field a fill binds to (autoLearnAdapter sets `step.field = fillReq.field` verbatim),
// and an invented key resolves to "" on every replay forever: resolveValue returns empty,
// the step returns false, and it is SKIPPED IN SILENCE. Found live — the PacifiCorp recipe
// binds `descriptionOfService`, which no resolver produces, so that select could never fill
// on any project, and the blank it left changed the portal's branching two pages later.
export function deadFieldBindings(steps: RecipeStep[], projectFields: Record<string, string>): string[] {
  const known = new Set(Object.keys(projectFields ?? {}));
  const out: string[] = [];
  for (const step of steps ?? []) {
    const field = String(step.field ?? "");
    // A field the resolver DOES define but which is empty for THIS project is fine — the
    // next project may have it. Only a key that cannot exist at all is dead.
    if (field && !known.has(field)) out.push(`${field} (${String(step.note ?? step.action).slice(0, 40)})`);
  }
  return out;
}

export function convertLiteralsToBoundFields(
  steps: RecipeStep[],
  projectFields: Record<string, string>,
): LiteralBindingResult {
  const norm = (v: string): string => String(v || "").toLowerCase().replace(/\s+/g, " ").trim();

  // value -> the project field key(s) holding exactly that value. Skip very short values
  // (<2 chars) and the volatile todayDate helper — not stable identifying data.
  const valueToFields = new Map<string, string[]>();
  for (const [key, raw] of Object.entries(projectFields)) {
    if (key === "todayDate") continue;
    const nv = norm(raw);
    if (nv.length < 2) continue;
    const arr = valueToFields.get(nv) ?? [];
    if (!arr.includes(key)) arr.push(key);
    valueToFields.set(nv, arr);
  }

  const bound: LiteralBindingResult["bound"] = [];
  const ambiguous: LiteralBindingResult["ambiguous"] = [];
  const portalConstants: Array<{ value: string; note?: string }> = [];
  const out = steps.map((step) => {
    const bindable = (step.action === "fill" || step.action === "select") && !!step.value && !step.field && !step.sensitive;
    if (!bindable) return step;
    // A DATE never matches by value (todayDate is skipped above as volatile), so it would
    // otherwise stay frozen and replay a stale — eventually PAST — date onto a live
    // application. Rebind it by the control's label to a field recomputed every replay.
    const dateField = dateFieldForLiteral(`${step.selector?.label ?? ""} ${step.note ?? ""}`, step.value as string);
    if (dateField) {
      bound.push({ value: step.value as string, field: dateField, note: step.note });
      const next: RecipeStep = { ...step, field: dateField };
      delete next.value;
      return next;
    }
    const matches = valueToFields.get(norm(step.value as string));
    if (!matches || matches.length === 0) return step; // portal-specific literal — keep as-is
    if (matches.length === 1) {
      bound.push({ value: step.value as string, field: matches[0], note: step.note });
      // Replace the frozen literal with a reusable binding (resolveValue() at replay reads
      // fieldValues[field]); drop the literal so it can never be replayed verbatim.
      const next: RecipeStep = { ...step, field: matches[0] };
      delete next.value;
      return next;
    }
    // The control's LABEL usually settles it — "Energy Storage" is hasBattery, not
    // exportLimiting, even though both hold "No".
    const picked = disambiguateByLabel(`${step.selector?.label ?? ""} ${step.note ?? ""}`, matches);
    if (picked) {
      bound.push({ value: step.value as string, field: picked, note: step.note });
      const next: RecipeStep = { ...step, field: picked };
      delete next.value;
      return next;
    }
    // A substantive label that shares nothing with any candidate means this control is a
    // portal constant that merely collided with project data — keep the literal, and do
    // NOT report an ambiguity that would block the recipe forever.
    if (labelRulesOutAllCandidates(`${step.selector?.label ?? ""} ${step.note ?? ""}`, matches)) {
      portalConstants.push({ value: step.value as string, note: step.note });
      return step;
    }
    ambiguous.push({ value: step.value as string, candidates: matches, note: step.note });
    return step; // leave literal; caller forces a draft
  });

  return { steps: out, bound, ambiguous, portalConstants };
}

// ---------------------------------------------------------------------------
// PATCH-BY-DEMONSTRATION merge. After an auto-learn leaves the browser open at
// the review screen, the operator's hand-made fixes (the fields the learner
// missed) arrive as captured RecipeSteps. Merge them into the learned recipe
// BEFORE its terminal steps — replay executes steps in order and stops at the
// stopForReview / isFinalSubmit marker, so a step appended after the terminal
// tail would never replay. Literal values that match the patching project's
// data are converted to reusable field bindings (same pass the learner uses)
// so the patch replays every future project's own data, not this project's.
// ---------------------------------------------------------------------------
export function appendHumanPatchSteps(
  db: AppDb,
  recipeId: string,
  newSteps: RecipeStep[],
  projectFields: Record<string, string>,
): PortalRecipe {
  const recipe = getPortalRecipe(db, recipeId);
  // DEFENSE IN DEPTH: the capture script already refuses submit/pay clicks, but a
  // mislabeled button can slip through (a real run recorded a bare "Submit" click).
  // Patches merge BEFORE the terminal stop markers — replayable position — so a
  // submit/pay click here would make replay file the application. Drop them at the
  // merge chokepoint too; fills/selects/uploads are always safe to keep.
  // The captured LABEL (note) is matched broadly — incl. the payment phrasings the
  // capture-side OFF_LIMITS blocks, so the two lists can't drift apart on pay intents.
  const SUBMIT_PAY = /\b(submit|pay|payment|pay now|checkout|finalize|place order|confirm submission|complete submission|file application)\b/i;
  newSteps = newSteps.filter((st) => {
    // The submit-observed pseudo-step is a SIGNAL, never a replayable step. Its marker
    // note (__human_submit_observed__) defeats \b-based matching (underscores are word
    // chars), so drop it explicitly — it carries an empty selector and would throw
    // "no usable selector" at replay if it ever merged.
    if ((st.note || "").includes("human_submit_observed")) return false;
    if (st.action !== "click") return true;
    const label = (st.note || "").replace(/^human-patch:?\s*/i, "");
    if (SUBMIT_PAY.test(label)) return false;
    // Selector content is only trusted as a signal when the button had NO accessible
    // label (icon-only <button id="btnSubmitFinal">): a labeled "Next" button inside a
    // '#submit-wizard-step' container is legitimate navigation and must merge.
    if (!label && SUBMIT_PAY.test(JSON.stringify(st.selector || {}))) return false;
    return true;
  });
  if (!newSteps.length) return recipe;
  // SENSITIVE steps: the capture ships the typed value in-memory ONLY so it can be bound
  // to a project field key here (account/meter numbers live in project data). Bind on a
  // unique match, then ALWAYS strip the literal before anything is persisted — a secret
  // must never land in steps_json, matched or not.
  newSteps = newSteps.map((st) => {
    if (!st.sensitive || !st.value) return st;
    const { steps: [bound] } = convertLiteralsToBoundFields([{ ...st, sensitive: undefined }], projectFields);
    const next: RecipeStep = { ...st, field: bound.field || st.field };
    delete next.value;
    return next;
  });
  const steps = [...(recipe.steps || [])];
  // Split off the trailing terminal markers (stopForReview and/or the recorded
  // final-submit) so patches land before them, in replayable position.
  let cut = steps.length;
  while (cut > 0) {
    const tailStep = steps[cut - 1] as RecipeStep & { isFinalSubmit?: boolean };
    if (tailStep.action === "stopForReview" || tailStep.isFinalSubmit === true) cut--;
    else break;
  }
  const { steps: bound } = convertLiteralsToBoundFields(newSteps, projectFields);
  const merged = [...steps.slice(0, cut), ...bound, ...steps.slice(cut)];
  // One idempotent notes marker with the TOTAL patched count — steps stream in one at a
  // time as the human works, so a per-call append would spam the notes field.
  const totalPatched = merged.filter((st) => (st.note || "").startsWith("human-patch")).length;
  const baseNotes = (recipe.notes || "").replace(/\s*\[human-patch:[^\]]*\]/g, "").trim();
  return savePortalRecipeSteps(db, recipeId, merged, {
    status: recipe.status as PortalRecipeStatus,
    notes: `${baseNotes} [human-patch: ${totalPatched} step(s) demonstrated at review]`.trim(),
  });
}
