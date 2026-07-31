import type { ExistingSystemInfo, ParserPayload, ProjectRecord, ProjectStatus } from "../../shared/src/types";
import { nowIso } from "./time";

function str(payload: ParserPayload, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function num(payload: ParserPayload, key: string): number | null {
  const raw = str(payload, key).replace(/[^0-9.-]/g, "");
  if (!raw) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function first(payload: ParserPayload, keys: string[]): string {
  for (const key of keys) {
    const value = str(payload, key);
    if (value) return value;
  }
  return "";
}

function addressFrom(payload: ParserPayload): string {
  const street = str(payload, "street");
  const city = str(payload, "city");
  const state = str(payload, "state");
  const zip = str(payload, "zip");
  const tail = [city, state, zip].filter(Boolean).join(", ").replace(", ", city && state ? ", " : " ");
  return [street, tail].filter(Boolean).join(", ");
}

function confidenceSummary(payload: ParserPayload): string {
  const flags = payload.reviewFlags;
  const priorities = payload.utilityPriorityFlags;
  const lines: string[] = [];
  if (Array.isArray(flags) && flags.length) lines.push(`${flags.length} parser review flag(s)`);
  if (Array.isArray(priorities) && priorities.length) lines.push(`${priorities.length} utility/electrical priority flag(s)`);
  const readiness = str(payload, "packetReadinessText");
  if (/MISSING/i.test(readiness)) lines.push("packet readiness has missing items");
  return lines.join("; ") || "parser completed without explicit review flags";
}

// Produces the canonical snapshot keys that portal adapters and the AHJ PDF
// form engine read, mapping the parser's short field names to canonical names
// and building a structured pvArrays list. Additive and idempotent: existing
// canonical keys are preserved, so a future parser emitting canonical names
// still works. This is what makes intake "pulled properly" end to end.
export function canonicalizeSnapshot(payload: ParserPayload): ParserPayload {
  const pick = (keys: string[]): string => first(payload, keys);
  const has = (key: string): boolean => payload[key] !== undefined && payload[key] !== null && payload[key] !== "";

  const canonical: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (has(key)) return; // never clobber a value the parser already provided
    if (value === "" || value == null) return;
    canonical[key] = value;
  };

  set("homeownerEmail", pick(["homeownerEmail", "ownerEmail"]));
  set("homeownerPhone", pick(["homeownerPhone", "ownerPhone"]));
  set("moduleManufacturer", pick(["moduleManufacturer", "moduleMake"]));
  set("moduleModel", pick(["moduleModel"]));
  set("moduleWatts", pick(["moduleWatts", "moduleWattage"]));
  set("moduleQuantity", pick(["moduleQuantity", "moduleQty"]));
  set("inverterManufacturer", pick(["inverterManufacturer", "invMake", "pvMicroMake"]));
  set("inverterModel", pick(["inverterModel", "invModel", "pvMicroModel"]));
  set("inverterQuantity", pick(["inverterQuantity", "invQty", "pvMicroQty"]));
  set("batteryManufacturer", pick(["batteryManufacturer", "batteryMake"]));
  set("batteryModel", pick(["batteryModel"]));
  set("batteryQuantity", pick(["batteryQuantity", "batteryQty"]));
  set("essKwh", pick(["essKwh", "batteryCapacityKwh"]));
  set("mainServiceRating", pick(["mainServiceRating", "busRating", "mainBreaker"]));
  set("serviceType", pick(["serviceType"]));
  set("jobValue", pick(["jobValue"]));
  set("pgeSchedule", pick(["pgeSchedule"]));
  set("phase", pick(["phase"]));

  const batteryQty = pick(["batteryQuantity", "batteryQty"]);
  const batteryModel = pick(["batteryModel"]);
  set("hasBattery", batteryModel || (batteryQty && Number(batteryQty) > 0) ? "Yes" : "No");

  // System ADDITION: an existing PV system remains in service alongside the new
  // install. Portals/forms ask "is there existing generation on site?" — answer
  // "Yes" ONLY from affirmative parser evidence. Absence of evidence sets
  // NOTHING (blank, not "No"): a definitive "No" from unparsed data would let a
  // form falsely attest "no existing generation", and a blank flag is safe under
  // both checkbox fill semantics (equals:"Yes" and truthy both leave it unticked).
  const existingEvidence = pick([
    "existingSystem", "existingDcKw", "existingAcKw",
    "existingModuleMake", "existingModuleModel", "existingModuleQty",
    "existingInvMake", "existingInvModel", "existingInvQty",
    "combinedDcKw", "combinedAcKw",
  ]);
  if (existingEvidence && !/^no$/i.test(existingEvidence)) set("hasExistingSystem", "Yes");

  // Build a structured pvArrays list when the parser didn't provide one.
  if (!Array.isArray(payload["pvArrays"])) {
    const qty = pick(["moduleQuantity", "moduleQty"]);
    const model = pick(["moduleModel"]);
    if (qty || model) {
      canonical["pvArrays"] = [
        {
          quantity: qty,
          moduleManufacturer: pick(["moduleManufacturer", "moduleMake"]),
          moduleModel: model,
          tilt: pick(["tilt"]),
          azimuth: pick(["azimuth"]),
        },
      ];
    }
  }

  return { ...payload, ...canonical };
}

// Structured existing-system / NEM-addition view over the snapshot's
// existing*/combined* keys (intake/manual fields — NOT auto-populated by the
// parser beyond what canonicalizeSnapshot already records as raw evidence).
// Returns undefined when the snapshot carries no existing-system evidence, so
// greenfield projects don't grow a noisy empty block.
export function existingSystemFromSnapshot(payload: ParserPayload): ExistingSystemInfo | undefined {
  const pick = (keys: string[]): string => first(payload, keys);
  const numPick = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const v = num(payload, key);
      if (v != null) return v;
    }
    return undefined;
  };
  const hasFlag = pick(["hasExistingSystem", "existingSystem"]);
  const info: ExistingSystemInfo = {};
  const setStr = (key: keyof ExistingSystemInfo, value: string) => {
    if (value) (info as Record<string, unknown>)[key] = value;
  };
  const setNum = (key: keyof ExistingSystemInfo, value: number | undefined) => {
    if (value != null) (info as Record<string, unknown>)[key] = value;
  };
  setNum("existingDcKw", numPick(["existingDcKw"]));
  setNum("existingAcKw", numPick(["existingAcKw"]));
  setStr("existingInverterMake", pick(["existingInverterMake", "existingInvMake"]));
  setStr("existingInverterModel", pick(["existingInverterModel", "existingInvModel"]));
  setNum("existingInverterQty", numPick(["existingInverterQty", "existingInvQty"]));
  setStr("existingModuleMake", pick(["existingModuleMake"]));
  setStr("existingModuleModel", pick(["existingModuleModel"]));
  setStr("existingBatteryMakeModel", pick(["existingBatteryMakeModel"]));
  setNum("combinedDcKw", numPick(["combinedDcKw"]));
  setNum("combinedAcKw", numPick(["combinedAcKw"]));
  setStr("nemTariff", pick(["nemTariff", "existingNemTariff"]));
  setStr("ptoDate", pick(["ptoDate", "existingPtoDate"]));
  setStr("agreementNumber", pick(["existingNemAgreementNumber", "nemAgreementNumber", "agreementNumber"]));
  setStr("applicationNumber", pick(["existingNemApplicationNumber", "nemApplicationNumber"]));
  const em = pick(["exportMode"]).toLowerCase();
  if (em === "export" || em === "non-export-pcs" || em === "ngom") info.exportMode = em;
  const hasEvidence = Object.keys(info).length > 0 || (!!hasFlag && /^yes$/i.test(hasFlag));
  if (!hasEvidence) return undefined;
  info.hasExistingSystem = true;
  return info;
}

export function normalizeProject(
  id: string,
  payload: ParserPayload,
  status: ProjectStatus = "parsed",
  createdAt = nowIso(),
): ProjectRecord {
  const updatedAt = nowIso();
  return {
    id,
    clientId: typeof payload["client_id"] === "string" ? (payload["client_id"] as string)
      : typeof payload["clientId"] === "string" ? (payload["clientId"] as string)
      : null,
    homeownerName: first(payload, ["owner", "homeownerName", "ubAccountHolder"]),
    projectAddress: addressFrom(payload),
    city: str(payload, "city"),
    state: str(payload, "state"),
    zip: str(payload, "zip"),
    ahj: str(payload, "ahj"),
    utility: str(payload, "utility"),
    accountNumber: first(payload, ["account", "ubAccountNumber"]),
    meterNumber: first(payload, ["meter", "ubMeterNumber"]),
    systemSizeDcKw: num(payload, "dcKw"),
    systemSizeAcKw: num(payload, "acKw"),
    totalExportKw: num(payload, "exportKw"),
    interconnectionMethod: str(payload, "interco"),
    status,
    currentStage: status === "parsed" ? "Parsed by front-end engine" : status,
    parserConfidenceSummary: confidenceSummary(payload),
    parserSnapshot: canonicalizeSnapshot(payload),
    existingSystem: existingSystemFromSnapshot(payload),
    createdAt,
    updatedAt,
  };
}

export function parserField(payload: ParserPayload, fieldName: string): string {
  return first(payload, fieldAliases[fieldName] ?? [fieldName]);
}

// Lower-case and collapse every run of non-alphanumerics to a single space, then trim.
// The canonical token-normalizer for fuzzy matching (search, historical failures,
// process profiles) — previously re-implemented locally in several modules.
export function normalizeTokens(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Lower-case and strip every non-alphanumeric character (no separators). Used to
// compare identifiers/model numbers ignoring punctuation and spacing.
export function compactAlnum(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export const fieldAliases: Record<string, string[]> = {
  homeownerName: ["owner", "homeownerName", "ubAccountHolder"],
  projectAddress: ["street"],
  utility: ["utility"],
  ahj: ["ahj"],
  accountNumber: ["account", "ubAccountNumber"],
  meterNumber: ["meter", "ubMeterNumber"],
  systemSizeDcKw: ["dcKw"],
  systemSizeAcKw: ["acKw"],
  totalExportKw: ["exportKw"],
  moduleMake: ["moduleMake"],
  moduleModel: ["moduleModel"],
  moduleWattage: ["moduleWattage"],
  moduleQty: ["moduleQty"],
  inverterMake: ["invMake", "pvMicroMake"],
  inverterModel: ["invModel", "pvMicroModel"],
  inverterQty: ["invQty", "pvMicroQty"],
  inverterOutput: ["invOutputW", "pvMicroOutputW"],
  batteryModel: ["batteryModel"],
  gatewayModel: ["gatewayModel"],
  interconnectionMethod: ["interco"],
  busRating: ["busRating"],
  mainBreaker: ["mainBreaker"],
  pvBreaker: ["pvBreaker"],
  permitPath: ["permitPath"],
  locates: ["locateCalloutText"],
  splitPages: ["splitPagesText"],
  utilityPacketBaseName: ["utilityPacketBaseName"],
};

