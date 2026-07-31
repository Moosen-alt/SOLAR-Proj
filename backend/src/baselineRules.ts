import type { ParserPayload, QcStatus, Severity } from "../../shared/src/types";
import type { EffectiveCodeContext } from "./codeProfiles";

export interface BaselineRuleDefinition {
  id: string;
  ruleType: "qc" | "correction" | "monitor";
  name: string;
  jurisdictionScope: string;
  utilityScope: string;
  source: string;
  severity: Severity;
  trigger: string;
  action: string;
}

export interface BaselineQcResult {
  ruleId: string;
  ruleName: string;
  qcStatus: QcStatus;
  severity: Severity;
  message: string;
  fieldName?: string;
}

export const baselineRuleDefinitions: BaselineRuleDefinition[] = [
  {
    id: "or-nem-residential-25kw",
    ruleType: "qc",
    name: "Oregon residential NEM size screen",
    jurisdictionScope: "Oregon",
    utilityScope: "PGE/Pacific Power/general Oregon public utility",
    source: "OAR 860-039-0010",
    severity: "warning",
    trigger: "Residential net metering facility over 25 kW DC",
    action: "Flag for non-standard NEM review or commercial/non-residential confirmation.",
  },
  {
    id: "or-nem-tier1-export-25kw",
    ruleType: "qc",
    name: "Oregon Tier 1 export screen",
    jurisdictionScope: "Oregon",
    utilityScope: "PGE/Pacific Power/general Oregon public utility",
    source: "OAR 860-039-0030",
    severity: "warning",
    trigger: "Export capacity over 25 kW or generation over 50 kW",
    action: "Flag likely Tier 2/3 utility review path before submission.",
  },
  {
    id: "or-nem-manual-disconnect",
    ruleType: "qc",
    name: "Oregon NEM manual disconnect",
    jurisdictionScope: "Oregon",
    utilityScope: "PGE/Pacific Power/general Oregon public utility",
    source: "OAR 860-039-0005",
    severity: "warning",
    trigger: "AC disconnect requirement not identified",
    action: "Confirm lockable load-break disconnect or documented utility exception.",
  },
  {
    id: "or-prescriptive-snow-70",
    ruleType: "qc",
    name: "Oregon prescriptive snow limit",
    jurisdictionScope: "Oregon",
    utilityScope: "",
    source: "Oregon BCD Form 440-5952",
    severity: "warning",
    trigger: "Ground snow load over 70 psf or missing",
    action: "Route to engineered path or human structural review.",
  },
  {
    id: "or-prescriptive-deadload-4_5",
    ruleType: "qc",
    name: "Oregon prescriptive dead load limit",
    jurisdictionScope: "Oregon",
    utilityScope: "",
    source: "Oregon BCD Form 440-5952",
    severity: "warning",
    trigger: "PV system dead load over 4.5 psf or missing",
    action: "Route to engineered path or verify stamped structural basis.",
  },
  {
    id: "or-prescriptive-roof-framing",
    ruleType: "qc",
    name: "Oregon prescriptive roof framing",
    jurisdictionScope: "Oregon",
    utilityScope: "",
    source: "Oregon BCD Form 440-5952",
    severity: "warning",
    trigger: "Rafter/truss spacing missing or over 24 inches",
    action: "Require engineered path or verified framing exception.",
  },
  {
    id: "or-fire-pathways",
    ruleType: "qc",
    name: "Oregon PV firefighter pathways",
    jurisdictionScope: "Oregon",
    utilityScope: "",
    source: "Oregon BCD PV Pathways Technical Bulletin",
    severity: "warning",
    trigger: "Rooftop PV with no pathway/site plan evidence",
    action: "Confirm site plan shows required firefighter access and escape pathways.",
  },
  {
    id: "portland-submittal-docs",
    ruleType: "qc",
    name: "Portland solar submittal documents",
    jurisdictionScope: "Portland",
    utilityScope: "",
    source: "Portland Solar Permits",
    severity: "warning",
    trigger: "Portland project missing site/fire/framing/cross-section/racking evidence",
    action: "Flag missing plan sheets before DevHub submission.",
  },
  {
    id: "portland-ready-for-issue",
    ruleType: "monitor",
    name: "Portland ready for issue status",
    jurisdictionScope: "Portland",
    utilityScope: "",
    source: "Portland Solar Permits pre-issuance section",
    severity: "info",
    trigger: "Pre-issuance complete / ready to issue / fees due",
    action: "Flag ready_for_issue and queue human fee/payment/download step.",
  },
  {
    id: "pacpower-ul1741sb",
    ruleType: "qc",
    name: "Pacific Power UL 1741 SB inverter settings",
    jurisdictionScope: "Oregon",
    utilityScope: "Pacific Power/PacifiCorp",
    source: "Pacific Power Customer Generation",
    severity: "warning",
    trigger: "Pacific Power project lacks UL 1741 SB / inverter settings evidence",
    action: "Confirm inverter spec/settings package before NEM submission.",
  },
  {
    id: "pacpower-meter-photo",
    ruleType: "qc",
    name: "Pacific Power meter photo requirement",
    jurisdictionScope: "Oregon",
    utilityScope: "Pacific Power/PacifiCorp",
    source: "Pacific Power Customer Generation",
    severity: "warning",
    trigger: "Pacific Power project missing meter evidence",
    action: "Require meter number/photo before application.",
  },
  {
    id: "pge-powerclerk-docs",
    ruleType: "qc",
    name: "PGE interconnection package",
    jurisdictionScope: "Oregon",
    utilityScope: "PGE",
    source: "PGE Interconnection Resource Library",
    severity: "warning",
    trigger: "PGE project missing SLD/site/spec package evidence",
    action: "Confirm SLD, site/plot plan, equipment specs, and utility bill/meter data.",
  },
];

function str(payload: ParserPayload, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function num(payload: ParserPayload, key: string): number | null {
  const cleaned = str(payload, key).replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function result(
  ruleId: string,
  ruleName: string,
  qcStatus: QcStatus,
  severity: Severity,
  message: string,
  fieldName?: string,
): BaselineQcResult {
  return { ruleId, ruleName, qcStatus, severity, message, fieldName };
}

export function evaluateBaselineRules(payload: ParserPayload, ctx?: EffectiveCodeContext): BaselineQcResult[] {
  const out: BaselineQcResult[] = [];
  const state = str(payload, "state").toUpperCase();
  const ahj = str(payload, "ahj");
  const utility = str(payload, "utility");
  const utilityUpper = utility.toUpperCase();
  const dcKw = num(payload, "dcKw");
  // System additions: NEM program caps apply to the TOTAL generation on the
  // service, so screen on the combined (new + existing) size when present.
  const combinedDcKw = num(payload, "combinedDcKw");
  const screenDcKw = combinedDcKw != null && (dcKw == null || combinedDcKw > dcKw) ? combinedDcKw : dcKw;
  const combinedNote = screenDcKw !== dcKw ? " (combined new + existing system size)" : "";
  const exportKw = num(payload, "exportKw");
  const snow = num(payload, "snow");
  const deadLoad = num(payload, "deadLoad");
  const rafterSpacing = num(payload, "roofRafterSpacing");
  const wind = str(payload, "wind");
  const split = `${str(payload, "splitPagesText")}\n${str(payload, "utilityDownloadChecklistText")}`;
  const notes = `${str(payload, "utilityUploadNotesText")}\n${str(payload, "projectDescriptionText")}\n${str(payload, "sitePlanNotesText")}`;
  const isOregon = state === "OR" || /oregon|portland|hillsboro|beaverton|gresham|clackamas|washington county/i.test(ahj);
  const isPortland = /portland/i.test(ahj);
  const isPacific = /pacific|pacificorp/i.test(utility);
  const isPge = /\bPGE\b|portland general/i.test(utility);

  // PRESCRIPTIVE-PATH SCREENS — data-driven when a jurisdiction code context is
  // provided (the per-AHJ adopted-codes profile), so any state/county with limits
  // recorded gets the same screening Oregon always had. Without a context, the
  // legacy behavior is preserved exactly: Oregon regex + the historical constants.
  // The Oregon NEM PROGRAM rules below (25 kW residential cap, manual disconnect)
  // stay Oregon-gated — they are OAR 860-039 utility-program policy, not adopted
  // building-code data. Rule IDs keep their legacy "or-…" form for Oregon (blocker
  // gating, QC history, and the goldens key off them) and use "<state>-…" elsewhere.
  const limits = ctx
    ? ctx.prescriptive
    : isOregon
      ? { maxGroundSnowPsf: 70, maxPvDeadLoadPsf: 4.5, maxRafterSpacingIn: 24, allowedWindExposures: ["B", "C"], maxExportKwWithoutStudy: 25 }
      : {};
  const jurisLabel = ctx && !(state === "OR" || /oregon/i.test(ahj)) ? (ctx.ahj || ctx.state || "the jurisdiction") : "Oregon";
  const idPrefix = (ctx ? (ctx.state || "jurisdiction") : "OR").toLowerCase() === "or" ? "or" : (ctx?.state || "jurisdiction").toLowerCase();
  const prescriptiveIds = idPrefix === "or"
    ? { snow: "or-prescriptive-snow-70", dead: "or-prescriptive-deadload-4_5", framing: "or-prescriptive-roof-framing", wind: "or-prescriptive-wind-exposure", fire: "or-fire-pathways", export: "or-nem-tier1-export-25kw" }
    : { snow: `${idPrefix}-prescriptive-snow`, dead: `${idPrefix}-prescriptive-deadload`, framing: `${idPrefix}-prescriptive-roof-framing`, wind: `${idPrefix}-prescriptive-wind-exposure`, fire: `${idPrefix}-fire-pathways`, export: `${idPrefix}-export-study-screen` };

  if (isOregon && screenDcKw != null && screenDcKw > 25) {
    out.push(result(
      "or-nem-residential-25kw",
      "Oregon residential NEM size screen",
      "warning",
      "warning",
      `DC size is ${screenDcKw} kW${combinedNote}. Confirm this is not a residential OAR 860-039 net metering project capped at 25 kW.`,
      "dcKw",
    ));
  }

  // Export-study screen: threshold from the jurisdiction profile (Oregon Tier 1 = 25 kW
  // export / 50 kW DC). The DC arm stays at 2x the export limit, matching the legacy 25/50 pair.
  const exportLimit = limits.maxExportKwWithoutStudy;
  if (exportLimit != null && ((screenDcKw != null && screenDcKw > exportLimit * 2) || (exportKw != null && exportKw > exportLimit))) {
    out.push(result(
      prescriptiveIds.export,
      idPrefix === "or" ? "Oregon Tier 1 export screen" : `${jurisLabel} export/interconnection study screen`,
      "warning",
      "warning",
      idPrefix === "or"
        ? `Generation/export may exceed Tier 1 screens (${screenDcKw ?? "?"} kW DC${combinedNote} / ${exportKw ?? "?"} kW export). Confirm Tier 2/3 utility path.`
        : `Generation/export may exceed the ${exportLimit} kW screen (${screenDcKw ?? "?"} kW DC${combinedNote} / ${exportKw ?? "?"} kW export). Confirm the utility study path.`,
      "exportKw",
    ));
  }

  if (isOregon && !/yes|required|provided|shown|lockable|visible/i.test(str(payload, "acDiscReq"))) {
    out.push(result(
      "or-nem-manual-disconnect",
      "Oregon NEM manual disconnect",
      "warning",
      "warning",
      "AC/manual disconnect requirement was not clearly identified. Confirm lockable load-break disconnect or documented utility exception.",
      "acDiscReq",
    ));
  }

  if (limits.maxGroundSnowPsf != null && (snow == null || snow > limits.maxGroundSnowPsf)) {
    out.push(result(
      prescriptiveIds.snow,
      `${jurisLabel} prescriptive snow limit`,
      "warning",
      "warning",
      snow == null ? "Ground snow load is missing for prescriptive-path screening." : `Ground snow load ${snow} psf exceeds ${jurisLabel} prescriptive ${limits.maxGroundSnowPsf} psf screen.`,
      "snow",
    ));
  }

  if (limits.maxPvDeadLoadPsf != null && (deadLoad == null || deadLoad > limits.maxPvDeadLoadPsf)) {
    out.push(result(
      prescriptiveIds.dead,
      `${jurisLabel} prescriptive dead load limit`,
      "warning",
      "warning",
      deadLoad == null ? "PV dead load is missing for prescriptive-path screening." : `PV dead load ${deadLoad} psf exceeds ${jurisLabel} prescriptive ${limits.maxPvDeadLoadPsf} psf screen.`,
      "deadLoad",
    ));
  }

  if (limits.maxRafterSpacingIn != null && (rafterSpacing == null || rafterSpacing > limits.maxRafterSpacingIn)) {
    out.push(result(
      prescriptiveIds.framing,
      `${jurisLabel} prescriptive roof framing`,
      "warning",
      "warning",
      rafterSpacing == null ? "Roof framing spacing is missing." : `Roof framing spacing ${rafterSpacing} inches exceeds ${jurisLabel} prescriptive ${limits.maxRafterSpacingIn} inch screen.`,
      "roofRafterSpacing",
    ));
  }

  const allowedWind = limits.allowedWindExposures;
  if (allowedWind && allowedWind.length && wind && !allowedWind.some((w) => new RegExp(`\\b${w}\\b`, "i").test(wind))) {
    out.push(result(
      prescriptiveIds.wind,
      `${jurisLabel} prescriptive wind exposure`,
      "warning",
      "warning",
      `Wind exposure "${wind}" should be ${allowedWind.join(" or ")} for the prescriptive path.`,
      "wind",
    ));
  }

  // Fire pathway screen follows the prescriptive screens: any jurisdiction with
  // prescriptive limits recorded (or legacy Oregon) expects pathway evidence.
  const firePathwayScreen = Object.values(limits).some((v) => v != null && (!Array.isArray(v) || v.length > 0));
  if (firePathwayScreen && !hasAny(`${split}\n${notes}`, [/fire/i, /pathway/i, /access path/i, /escape path/i, /site.*plan/i])) {
    out.push(result(
      prescriptiveIds.fire,
      `${jurisLabel} PV firefighter pathways`,
      "warning",
      "warning",
      "No site/fire pathway evidence found. Confirm required firefighter access and escape pathways are shown.",
      "splitPagesText",
    ));
  }

  if (isPortland) {
    const missing: string[] = [];
    if (!hasAny(split, [/site/i, /plot/i])) missing.push("site/plot plan");
    if (!hasAny(`${split}\n${notes}`, [/fire/i, /pathway/i, /access path/i])) missing.push("fire access path");
    if (!hasAny(split, [/roof/i, /framing/i])) missing.push("roof framing/roof plan");
    if (!hasAny(split, [/section/i, /cross/i])) missing.push("roof cross-section");
    if (!hasAny(split, [/rack/i, /mount/i, /attachment/i])) missing.push("racking attachment");
    if (missing.length) {
      out.push(result(
        "portland-submittal-docs",
        "Portland solar submittal documents",
        "warning",
        "warning",
        `Portland package may be missing: ${missing.join(", ")}.`,
        "splitPagesText",
      ));
    }
  }

  if (isPacific && !hasAny(`${split}\n${notes}`, [/UL\s*1741\s*SB/i, /inverter settings/i, /smart inverter/i])) {
    out.push(result(
      "pacpower-ul1741sb",
      "Pacific Power UL 1741 SB inverter settings",
      "warning",
      "warning",
      "Pacific Power project lacks clear UL 1741 SB / inverter settings evidence.",
      "utilityUploadNotesText",
    ));
  }

  if (isPacific && !str(payload, "meter") && !str(payload, "ubMeterNumber")) {
    out.push(result(
      "pacpower-meter-photo",
      "Pacific Power meter photo requirement",
      "warning",
      "warning",
      "Pacific Power application should include meter evidence; no meter number was captured.",
      "meter",
    ));
  }

  if (isPge) {
    const pgeMissing: string[] = [];
    if (!hasAny(split, [/SLD/i, /3-line/i, /single line/i])) pgeMissing.push("SLD/3-line");
    if (!hasAny(split, [/site/i, /plot/i])) pgeMissing.push("site/plot plan");
    if (!hasAny(split, [/module/i])) pgeMissing.push("module spec");
    if (!hasAny(split, [/inverter/i, /microinverter/i])) pgeMissing.push("inverter spec");
    if (!str(payload, "account") && !str(payload, "ubAccountNumber")) pgeMissing.push("utility account");
    if (pgeMissing.length) {
      out.push(result(
        "pge-powerclerk-docs",
        "PGE interconnection package",
        "warning",
        "warning",
        `PGE package may be missing: ${pgeMissing.join(", ")}.`,
        "utilityDownloadChecklistText",
      ));
    }
  }

  // EXISTING-SYSTEM / NEM-ADDITION SCREENS (advisory — warnings only, never a
  // blocker). Additions must disclose the existing system on interconnection
  // applications; screen for the disclosure data being present and for the CA
  // NEM1/NEM2 grandfathering expansion allowance.
  const hasExisting = /^yes$/i.test(str(payload, "hasExistingSystem")) || /^yes$/i.test(str(payload, "existingSystem"));
  if (hasExisting) {
    const existingDcKw = num(payload, "existingDcKw");
    const existingInvMake = str(payload, "existingInvMake") || str(payload, "existingInverterMake");
    const existingInvModel = str(payload, "existingInvModel") || str(payload, "existingInverterModel");
    const disclosureMissing: string[] = [];
    if (existingDcKw == null) disclosureMissing.push("existing system DC size (existingDcKw)");
    if (!existingInvMake || !existingInvModel) disclosureMissing.push("existing inverter make/model");
    if (combinedDcKw == null) disclosureMissing.push("combined (existing + new) DC size (combinedDcKw)");
    if (disclosureMissing.length) {
      out.push(result(
        "existing-system-disclosure",
        "Existing-system disclosure",
        "warning",
        "warning",
        `Addition to an existing system: interconnection applications must disclose the existing system, but these are missing: ${disclosureMissing.join(", ")}. Enter them from the plan set / prior NEM paperwork.`,
        "existingDcKw",
      ));
    }

    const agreementNumber =
      str(payload, "existingNemAgreementNumber") || str(payload, "nemAgreementNumber") || str(payload, "agreementNumber");
    if (!agreementNumber) {
      out.push(result(
        "existing-system-nem-agreement",
        "Existing NEM agreement number",
        "warning",
        "warning",
        "Addition to an existing system: the NEM/interconnection application usually asks for the EXISTING interconnection agreement number, and none was captured. Pull it from the prior PTO letter / NEM agreement.",
        "existingNemAgreementNumber",
      ));
    }

    // CA NEM1/NEM2 grandfathering: a legacy-tariff system generally keeps its
    // grandfathered status only within a ONE-TIME expansion allowance of
    // max(1 kW, 10% of the existing size). A larger addition can move the whole
    // system to the current tariff (NEM3/NBT). Advisory only.
    const nemTariff = str(payload, "nemTariff") || str(payload, "existingNemTariff");
    if (/nem\s*-?\s*[12]\b|nem\s*-?\s*2\.0|nem\s*-?\s*1\.0/i.test(nemTariff) && existingDcKw != null && combinedDcKw != null) {
      const additionKw = combinedDcKw - existingDcKw;
      const allowanceKw = Math.max(1, 0.10 * existingDcKw);
      if (additionKw > allowanceKw) {
        out.push(result(
          "existing-system-nem-grandfathering",
          "NEM grandfathering expansion allowance",
          "warning",
          "warning",
          `Existing system is on ${nemTariff}: the addition of ${additionKw.toFixed(2)} kW DC exceeds the one-time expansion allowance of ${allowanceKw.toFixed(2)} kW (greater of 1 kW / 10% of the existing ${existingDcKw} kW). The expansion may forfeit grandfathered NEM status and move the whole system to the current tariff — confirm with the utility before submitting.`,
          "combinedDcKw",
        ));
      }
    }
  }

  return out;
}

