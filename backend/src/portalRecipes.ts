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
    "UPDATE portal_recipes SET steps_json = ?, status = ?, structure_sig = ?, notes = COALESCE(NULLIF(?, ''), notes), updated_at = ? WHERE id = ?",
    [asJson(steps ?? []), status, recipeStructureSignature(steps ?? []), s(options.notes), nowIso(), recipeId],
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

  // Derive split first/last from full homeowner name so portals with separate
  // first/last inputs get proper field bindings instead of LLM-guessed literals.
  const hoFullName = (project.homeownerName || "").trim();
  const hoNameParts = hoFullName.split(/\s+/);
  const homeownerFirstName = hoNameParts[0] || "";
  const homeownerLastName = hoNameParts.slice(1).join(" ") || "";

  // Street-only address (no city/state/zip) for portals that split the address.
  const streetOnly = (project.projectAddress || "").split(",")[0].trim();

  const projectFields: Record<string, string> = {
    homeownerName: project.homeownerName,
    homeownerFirstName,
    homeownerLastName,
    homeownerEmail: String(snapshotFlat.homeownerEmail || snapshotFlat.ownerEmail || ""),
    homeownerPhone: String(snapshotFlat.homeownerPhone || snapshotFlat.ownerPhone || ""),
    street: streetOnly || project.projectAddress,
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
      put(`${p}Azimuth`, arr.azimuth);
      put(`${p}Tilt`, arr.tilt);
    });
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

  // Precedence: snapshot scalars → derived equipment aliases → explicit project fields →
  // client licensing overlay → derived installer name split (each later layer wins).
  return { ...snapshotFlat, ...equipment, ...projectFields, ...overlay, ...installerSplit };
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
  const out = steps.map((step) => {
    const bindable = (step.action === "fill" || step.action === "select") && !!step.value && !step.field && !step.sensitive;
    if (!bindable) return step;
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
    ambiguous.push({ value: step.value as string, candidates: matches, note: step.note });
    return step; // leave literal; caller forces a draft
  });

  return { steps: out, bound, ambiguous };
}
