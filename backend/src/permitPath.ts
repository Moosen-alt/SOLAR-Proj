// ---------------------------------------------------------------------------
// Permit path resolver — prescriptive vs engineered (non-prescriptive).
//
// This is the single most consequential routing decision on an Oregon (and most
// western-state) residential rooftop solar permit. The AHJ publishes TWO solar
// applications and you upload exactly ONE:
//
//   - PRESCRIPTIVE application  → the project meets the prescriptive code, NO plan
//     review, REDUCED permit fee. Upload only when the structural screen passes.
//   - STRUCTURAL (engineered) application → the project does NOT meet prescriptive
//     code, WILL require plan review, FULL structural fees, and a PE-stamped plan
//     set + structural engineering letter/calcs must be attached.
//
//   "Please upload only the application that pertains to your project — DO NOT
//    upload both." (City of Keizer / Marion County guidance.)
//
// We deduce the path from the parsed structural data + stamp recommendation, let
// the operator override it from the UI, and feed the result into doc generation
// (which application to build) and the reviewer (what engineered docs to collect).
// ---------------------------------------------------------------------------

import type { ProjectRecord } from "../../shared/src/types";

export type PermitPath = "prescriptive" | "engineered" | "unknown";

export interface PermitPathResolution {
  path: PermitPath;
  /** Where the decision came from — an explicit operator choice always wins. */
  source: "operator" | "parser" | "structural-screen" | "default";
  /** Human-readable reasons, surfaced in the docs + reviewer so the call is auditable. */
  basis: string[];
  /** True when the path is engineered → stamped plans + structural letter are required. */
  needsEngineeredDocs: boolean;
  /** The documents an engineered submittal must include (client/engineer-provided). */
  requiredEngineeredDocs: string[];
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function snap(project: ProjectRecord, key: string): string {
  return clean((project.parserSnapshot || {})[key]);
}

function num(project: ProjectRecord, key: string): number | null {
  const raw = snap(project, key).replace(/[^0-9.\-]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Documents an engineered (non-prescriptive) submittal must carry. These are
 * provided by the installer / engineer (the autopilot does not produce a wet
 * stamp) — the reviewer collects them and flags any that aren't already uploaded.
 */
export const ENGINEERED_REQUIRED_DOCS = [
  "PE-stamped structural plan set (wet/digital stamp on the structural sheets)",
  "Structural engineering letter or stamped calculations (PE-sealed)",
];

// Does the parsed evidence show a stamped structural plan / engineering letter is
// already in hand? Looks across the structural/stamp text + the split-page mapping
// + any uploaded-document filenames captured on the snapshot.
export function hasStampedStructuralEvidence(project: ProjectRecord): boolean {
  const blob = [
    snap(project, "stampRecommendation"),
    snap(project, "structuralText"),
    snap(project, "structuralNotesText"),
    snap(project, "splitPagesText"),
    snap(project, "reviewFlags"),
    snap(project, "uploadedDocumentNames"),
    snap(project, "documentInventoryText"),
  ].join("\n").toLowerCase();
  // "stamped" / "wet stamp" / "PE stamp" / "sealed" / "engineer of record" / "structural letter".
  const hasStamp = /\b(wet[-\s]?stamp|stamped|p\.?e\.? stamp|pe[-\s]?stamp|sealed by|engineer(?:'s)? seal|engineer of record|structural letter|stamped calc)/i.test(blob);
  // Avoid a false positive when the text only says a stamp is NOT included / is needed.
  const onlyNeeds = /(no stamp|stamp (?:is )?(?:not|missing|needed|required|pending)|without (?:a )?stamp|unstamped)/i.test(blob)
    && !/stamped (?:plan|set|sheet|calc)/i.test(blob);
  return hasStamp && !onlyNeeds;
}

/**
 * Resolve a project's permit path across all signals:
 *   1. Operator override (snapshot.permitPathOverride) — always wins.
 *   2. Parser hint (snapshot.permitPath) when it explicitly says prescriptive/engineered.
 *   3. Stamp recommendation that calls for a stamp/engineering → engineered.
 *   4. Structural prescriptive screen (snow ≤70, dead load ≤4.5, rafter spacing ≤24,
 *      wind B/C). Any failure → engineered. Microinverter roof mounts that pass the
 *      screen → prescriptive.
 *   5. Default for a standard residential roof mount → prescriptive.
 */
export function resolvePermitPath(project: ProjectRecord): PermitPathResolution {
  const basis: string[] = [];
  const finalize = (path: PermitPath, source: PermitPathResolution["source"]): PermitPathResolution => ({
    path,
    source,
    basis,
    needsEngineeredDocs: path === "engineered",
    requiredEngineeredDocs: path === "engineered" ? ENGINEERED_REQUIRED_DOCS : [],
  });

  // 1. Operator override — explicit dropdown choice is authoritative.
  const override = snap(project, "permitPathOverride").toLowerCase();
  if (/engineer|structural|non.?prescriptive/.test(override)) {
    basis.push("Operator selected the engineered / non-prescriptive path.");
    return finalize("engineered", "operator");
  }
  if (/prescriptive/.test(override)) {
    basis.push("Operator selected the prescriptive path.");
    return finalize("prescriptive", "operator");
  }

  // 2. Parser hint when it explicitly states the path.
  const hint = snap(project, "permitPath").toLowerCase();
  if (/engineer|non.?prescriptive/.test(hint)) {
    basis.push("Parser identified an engineered / non-prescriptive permit path.");
    return finalize("engineered", "parser");
  }

  // 3. Stamp recommendation calling for a stamp / engineering review.
  const stampText = `${snap(project, "stampRecommendation")} ${snap(project, "reviewFlags")}`.toLowerCase();
  const callsForStamp = /(requires?|needs?|recommend|must).{0,30}(stamp|engineer|pe seal|sealed|calc)/.test(stampText)
    || /engineered path|non.?prescriptive|structural review required/.test(stampText);
  const explicitlyNoStamp = /(no stamp|stamp not required|prescriptive ok|prescriptive path)/.test(stampText);
  if (callsForStamp && !explicitlyNoStamp) {
    basis.push(`Stamp recommendation indicates engineering is required: "${snap(project, "stampRecommendation") || snap(project, "reviewFlags")}".`);
    return finalize("engineered", "parser");
  }

  // 4. Structural prescriptive screen — any breach routes to engineered.
  const snow = num(project, "snow");
  const deadLoad = num(project, "deadLoad");
  const spacing = num(project, "roofRafterSpacing");
  const wind = snap(project, "wind");
  const screenFailures: string[] = [];
  if (snow != null && snow > 70) screenFailures.push(`ground snow load ${snow} psf > 70 psf prescriptive limit`);
  if (deadLoad != null && deadLoad > 4.5) screenFailures.push(`PV dead load ${deadLoad} psf > 4.5 psf prescriptive limit`);
  if (spacing != null && spacing > 24) screenFailures.push(`rafter spacing ${spacing} in > 24 in prescriptive limit`);
  if (wind && !/\b(B|C)\b/i.test(wind)) screenFailures.push(`wind exposure "${wind}" outside prescriptive B/C`);
  if (screenFailures.length) {
    basis.push(`Structural prescriptive screen failed: ${screenFailures.join("; ")}.`);
    return finalize("engineered", "structural-screen");
  }

  // 5. Default — a standard residential roof mount that clears the screen is prescriptive.
  const mounting = snap(project, "mounting").toLowerCase();
  const isGroundMount = /ground[-\s]?mount|pole[-\s]?mount/.test(mounting);
  if (isGroundMount) {
    basis.push("Ground/pole mount — typically engineered (verify against the AHJ's prescriptive scope).");
    return finalize("engineered", "structural-screen");
  }
  const hasMicro = Boolean(snap(project, "pvMicroModel") || snap(project, "pvMicroMake"));
  if (hasMicro) basis.push("Microinverter roof mount clearing the structural screen — prescriptive path.");
  else basis.push("Roof mount clears the prescriptive structural screen — prescriptive path (verify the structural inputs were parsed).");
  // If we never saw any structural inputs at all, mark it unknown so the UI nudges
  // the operator to confirm rather than silently assuming prescriptive.
  const sawStructuralInputs = snow != null || deadLoad != null || spacing != null || Boolean(wind);
  if (!sawStructuralInputs && !hasMicro) {
    basis.push("No structural inputs were parsed — confirm the path with the dropdown before building docs.");
    return finalize("unknown", "default");
  }
  return finalize("prescriptive", "default");
}

// ---------------------------------------------------------------------------
// Prescriptive structural criteria — the itemized screen the AHJ's prescriptive
// checklist asks. Each row answers Yes / No / [verify] straight from the parsed
// structural data, so the generated checklist stops shipping hardcoded [verify].
// Thresholds default to the Oregon residential prescriptive solar limits (which
// match the seeded jurisdiction code profile) and can be overridden per-AHJ.
// ---------------------------------------------------------------------------

export interface PrescriptiveLimitInputs {
  maxGroundSnowPsf?: number;
  maxPvDeadLoadPsf?: number;
  maxRafterSpacingIn?: number;
  allowedWindExposures?: string[];
  /** Ultimate design wind speed cap (mph) by exposure — prescriptive tables. */
  maxWindSpeedMphExpC?: number;
  maxWindSpeedMphExpB?: number;
  /** Max module height above the roof surface (in.) to stay in the array tables. */
  maxModuleHeightIn?: number;
  /** Max existing roofing layers under the array. */
  maxRoofLayers?: number;
}

export type PrescriptiveAnswer = "Yes" | "No" | "[verify]";

/** Stable identifiers for each criterion row — the PDF form-fill bridge binds
 *  checklist checkboxes to these (computed.presc<Key>Yes / ...No), so they must
 *  never be renamed once templates reference them. */
export type PrescriptiveCriterionKey =
  | "roofMount"
  | "lightFrame"
  | "riskCategory"
  | "snowLoad"
  | "windExposure"
  | "windSpeed"
  | "rafterSpacing"
  | "deadLoad"
  | "moduleHeight"
  | "roofLayers";

export interface PrescriptiveCriterion {
  key: PrescriptiveCriterionKey;
  label: string;
  answer: PrescriptiveAnswer;
  detail: string;
}

/** The criterion keys + default labels, for building the mapper's source list.
 *  Derived from an empty evaluation so labels stay in lockstep with the rows. */
export function prescriptiveCriterionCatalog(): Array<{ key: PrescriptiveCriterionKey; label: string }> {
  const empty = { parserSnapshot: {} } as unknown as ProjectRecord;
  return evaluatePrescriptiveCriteria(empty).map(({ key, label }) => ({ key, label }));
}

const OREGON_PRESCRIPTIVE_DEFAULTS: Required<PrescriptiveLimitInputs> = {
  maxGroundSnowPsf: 70,
  maxPvDeadLoadPsf: 4.5,
  maxRafterSpacingIn: 24,
  allowedWindExposures: ["B", "C"],
  maxWindSpeedMphExpC: 120,
  maxWindSpeedMphExpB: 135,
  maxModuleHeightIn: 18,
  maxRoofLayers: 1,
};

function yesNoFlag(raw: string): PrescriptiveAnswer {
  const v = raw.toLowerCase();
  if (!v) return "[verify]";
  if (/\b(yes|y|true|conventional|light[-\s]?frame)\b/.test(v)) return "Yes";
  if (/\b(no|n|false)\b/.test(v)) return "No";
  return "[verify]";
}

/** Evaluate every prescriptive-screen criterion from parsed data (Yes/No/[verify]). */
export function evaluatePrescriptiveCriteria(
  project: ProjectRecord,
  limits: PrescriptiveLimitInputs = {},
): PrescriptiveCriterion[] {
  const L = { ...OREGON_PRESCRIPTIVE_DEFAULTS, ...limits };
  const rows: PrescriptiveCriterion[] = [];

  // Numeric "<= limit" criterion: Yes when parsed and within, No when over, else verify.
  const maxRow = (key: PrescriptiveCriterionKey, label: string, snapKey: string, limit: number, unit: string): void => {
    const n = num(project, snapKey);
    if (n == null) rows.push({ key, label, answer: "[verify]", detail: `${label} not parsed` });
    else rows.push({ key, label, answer: n <= limit ? "Yes" : "No", detail: `${n} ${unit} (limit ${limit} ${unit})` });
  };

  // Roof-mounted PV.
  const mounting = snap(project, "mounting").toLowerCase();
  rows.push({
    key: "roofMount",
    label: "Roof-mounted PV",
    answer: mounting ? (/roof/.test(mounting) && !/ground|pole/.test(mounting) ? "Yes" : "No") : "[verify]",
    detail: mounting || "mounting not parsed",
  });

  // Conventional light-frame construction.
  const lf = yesNoFlag(snap(project, "lightFrame"));
  rows.push({
    key: "lightFrame",
    label: "Conventional light-frame construction",
    answer: lf,
    detail: snap(project, "lightFrame") || snap(project, "framingType") || "light-frame flag not parsed",
  });

  // Risk category I or II (residential).
  const rc = snap(project, "riskCategory").toUpperCase().replace(/[^IV]/g, "");
  rows.push({
    key: "riskCategory",
    label: "Risk Category I or II",
    answer: rc ? (rc === "I" || rc === "II" ? "Yes" : "No") : "[verify]",
    detail: rc ? `Category ${rc}` : "risk category not parsed",
  });

  maxRow("snowLoad", `Ground snow load <= ${L.maxGroundSnowPsf} psf`, "snow", L.maxGroundSnowPsf, "psf");

  // Wind exposure.
  const wind = snap(project, "wind").toUpperCase().replace(/[^A-D]/g, "");
  rows.push({
    key: "windExposure",
    label: `Wind exposure ${L.allowedWindExposures.join(" or ")}`,
    answer: wind ? (L.allowedWindExposures.includes(wind) ? "Yes" : "No") : "[verify]",
    detail: wind ? `Exposure ${wind}` : "wind exposure not parsed",
  });

  // Ultimate design wind speed vs exposure-specific cap.
  const windSpeed = num(project, "windSpeed");
  const speedCap = wind === "B" ? L.maxWindSpeedMphExpB : L.maxWindSpeedMphExpC;
  if (windSpeed == null) rows.push({ key: "windSpeed", label: "Ultimate design wind speed within prescriptive cap", answer: "[verify]", detail: "wind speed not parsed" });
  else rows.push({
    key: "windSpeed",
    label: "Ultimate design wind speed within prescriptive cap",
    answer: windSpeed <= speedCap ? "Yes" : "No",
    detail: `${windSpeed} mph (limit ${speedCap} mph for Exp ${wind || "C"})`,
  });

  maxRow("rafterSpacing", `Rafter/truss spacing <= ${L.maxRafterSpacingIn} in. o.c.`, "roofRafterSpacing", L.maxRafterSpacingIn, "in");
  maxRow("deadLoad", `PV dead load <= ${L.maxPvDeadLoadPsf} psf`, "deadLoad", L.maxPvDeadLoadPsf, "psf");
  maxRow("moduleHeight", `Module height above roof <= ${L.maxModuleHeightIn} in.`, "moduleHeightAboveRoof", L.maxModuleHeightIn, "in");
  maxRow("roofLayers", `Existing roofing layers <= ${L.maxRoofLayers}`, "roofLayers", L.maxRoofLayers, "layer(s)");

  return rows;
}

/** One-line human callout summarizing the path + its fee/review implications. */
export function permitPathCallout(res: PermitPathResolution): string {
  if (res.path === "prescriptive") {
    return "Prescriptive path — upload ONLY the prescriptive application. Meets prescriptive code, no plan review, reduced permit fee. Do NOT also upload the structural application.";
  }
  if (res.path === "engineered") {
    return "Engineered (non-prescriptive) path — upload ONLY the structural application. Requires plan review, full structural fees, and a PE-stamped plan set + structural engineering letter/calcs. Do NOT also upload the prescriptive application.";
  }
  return "Permit path not yet confirmed — choose prescriptive vs engineered before building the AHJ application. They are mutually exclusive; upload only one.";
}
