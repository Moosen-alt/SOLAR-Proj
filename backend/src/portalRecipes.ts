import type { PortalRecipe, PortalRecipeStatus, ProjectRecord, RecipeStep } from "../../shared/src/types";
import { clientStagingOverlay } from "./clients";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { asJson, parseJson, text as s } from "./json";
import { knowledgeProfileKey } from "./knowledgeBase";
import { nowIso } from "./time";

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
    autoSubmitEnabled: Boolean(row.auto_submit_enabled),
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

export function findCompleteRecipeForProject(
  db: AppDb,
  input: { scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string },
): PortalRecipe | null {
  const key = recipeProfileKey(input);
  const row = db.get<Row>("SELECT * FROM portal_recipes WHERE profile_key = ? AND status = 'complete'", [key]);
  return row ? mapRecipe(row) : null;
}

// Like findCompleteRecipeForProject, but matches a recipe of ANY status (recording / needs_rerecord
// / complete), newest first. Used by staging to recover a launchable portal URL even before a recipe
// is verified-complete: a draft/recording recipe still carries the entry URL the operator (or a prior
// auto-learn pass) pointed the recorder at. Without it, a real portal whose only recipe is still a
// draft has no URL to launch and the self-seed can't fire — staging silently falls to the no-op mock.
export function findAnyRecipeForProject(
  db: AppDb,
  input: { scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string },
): PortalRecipe | null {
  const key = recipeProfileKey(input);
  const row = db.get<Row>("SELECT * FROM portal_recipes WHERE profile_key = ? ORDER BY updated_at DESC LIMIT 1", [key]);
  return row ? mapRecipe(row) : null;
}

// Start (or reset) a recording for a portal. Creates a 'recording' stub keyed by
// profile_key; if a recipe already exists for that key, bumps the version and clears
// the steps so the admin re-records cleanly (used for "delete & re-record").
export function startPortalRecording(
  db: AppDb,
  input: { scopeType: "ahj" | "utility"; state?: string; ahj?: string; utility?: string; portalPlatform?: string; portalUrl?: string; createdBy?: string },
): PortalRecipe {
  const scopeType = input.scopeType === "utility" ? "utility" : "ahj";
  if (scopeType === "ahj" && !s(input.ahj).trim()) throw new HttpError(400, "ahj is required for an AHJ recipe.");
  if (scopeType === "utility" && !s(input.utility).trim()) throw new HttpError(400, "utility is required for a utility recipe.");
  // A utility recipe is keyed by utility ONLY (it replays for any AHJ in that utility's
  // territory), so it must NOT carry the originating project's AHJ city — otherwise it
  // gets mislabeled as a city ("PGE shown as City of Dayton"). Null out ahj for utility.
  const ahj = scopeType === "utility" ? "" : s(input.ahj);
  const key = recipeProfileKey(input);
  const existing = db.get<Row>("SELECT * FROM portal_recipes WHERE profile_key = ?", [key]);
  const now = nowIso();
  if (existing) {
    const nextVersion = Number(existing.version ?? 1) + 1;
    db.run(
      `UPDATE portal_recipes SET status = 'recording', version = ?, steps_json = '[]',
         portal_platform = ?, portal_url = ?, updated_at = ? WHERE profile_key = ?`,
      [nextVersion, s(input.portalPlatform), s(input.portalUrl), now, key],
    );
    return getPortalRecipe(db, s(existing.id));
  }
  const recipeId = id();
  db.run(
    `INSERT INTO portal_recipes
      (id, scope_type, profile_key, state, ahj, utility, portal_platform, portal_url, status, version, steps_json, created_by, created_at, updated_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recording', 1, '[]', ?, ?, ?, '')`,
    [recipeId, scopeType, key, s(input.state), ahj, s(input.utility), s(input.portalPlatform), s(input.portalUrl), s(input.createdBy), now, now],
  );
  return getPortalRecipe(db, recipeId);
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
    "UPDATE portal_recipes SET steps_json = ?, status = ?, notes = COALESCE(NULLIF(?, ''), notes), updated_at = ? WHERE id = ?",
    [asJson(steps ?? []), status, s(options.notes), nowIso(), recipeId],
  );
  return getPortalRecipe(db, recipeId);
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
  homeownerName: "Property owner full name",
  projectAddress: "Installation site street address",
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
  installerCompanyName: "Installer/contractor company name",
  installerEmail: "Installer company or contact email address",
  installerPhone: "Installer company phone number",
  installerAddress: "Full installer company address (street, city, state, zip combined)",
  installerStreet: "Installer company street address only",
  installerCityStateZip: "Installer company city, state, zip (no street)",
  installerContactName: "Installer contact person full name",
  ccbLicenseNumber: "CCB (contractor) license number",
  electricalLicenseNumber: "Electrical contractor license number",
  metroCityLicenseNumber: "Metro or city business license number",
  electricalSupervisorName: "Supervising electrician full name",
  electricianLicenseNumber: "Supervising electrician license number",
  authorizedSignerName: "Authorized signer or representative full name",
  authorizedSignerTitle: "Authorized signer's title",
  powerclerkExistingContact: "PowerClerk existing contact ID code",
  accelaContactCode: "Accela contact/license lookup code",
};

// Build the field-substitution map a recipe step's `field` resolves against at replay:
// the project's authoritative fields + the assigned client's licensing overlay (so the
// correct contractor identity is always used) + parser-snapshot extras as fallback.
export function resolveRecipeFieldValues(db: AppDb, project: ProjectRecord, portalType: string): Record<string, string> {
  const snapshot = project.parserSnapshot || {};
  const snapshotFlat: Record<string, string> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (v != null && typeof v !== "object") snapshotFlat[k] = String(v);
  }
  const projectFields: Record<string, string> = {
    homeownerName: project.homeownerName,
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
  };
  const overlay = project.clientId ? clientStagingOverlay(db, project.clientId, portalType) : {};
  // Overlay (client licensing) and explicit project fields win over snapshot.
  return { ...snapshotFlat, ...projectFields, ...overlay };
}
