import type { ExistingSystemInfo, IssuerTrackKey, ParserPayload, ProjectRecord, ProjectStatus, TrackIssuerOverrides } from "../../shared/src/types";
import { nowIso } from "./time";
import { firstEmail } from "../../shared/src/emailAddress";
import { isBillHolderName } from "./accountHolders";

/** THE OPERATOR'S PER-TRACK ISSUER, as it is stored: flat parser-snapshot keys, written by
 *  PUT /api/projects/:id exactly like permitPathOverride / structureTypeOverride (updateProject merges
 *  them into parser_json), so no new column and no new route. "" clears one. Read back only through
 *  trackIssuersFromSnapshot (mapProject / normalizeProject) and permitProcess.trackIssuer. */
export const TRACK_ISSUER_SNAPSHOT_KEYS: Record<IssuerTrackKey, string> = {
  building: "trackIssuerBuilding",
  electrical: "trackIssuerElectrical",
  combo: "trackIssuerCombo",
  mpu: "trackIssuerMpu",
};

/** The operator's per-track issuers on file, or undefined when none is set (so a record without one
 *  carries no key at all — nothing about such a project changes shape). */
export function trackIssuersFromSnapshot(snapshot: ParserPayload | null | undefined): TrackIssuerOverrides | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const out: TrackIssuerOverrides = {};
  for (const [track, key] of Object.entries(TRACK_ISSUER_SNAPSHOT_KEYS) as Array<[IssuerTrackKey, string]>) {
    const raw = (snapshot as Record<string, unknown>)[key];
    const value = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (value) out[track] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

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
    // The bill's holder stands in for the homeowner only when it IS a holder: never the utility's
    // website or its own name off the bill (#28, "Pnm.Com"). An empty name gets asked for.
    if (value && (key !== "ubAccountHolder" || isBillHolderName(value, str(payload, "utility")))) return value;
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

// Canonical keys that canonicalizeSnapshot fills FROM A DIFFERENT parser field (first non-empty
// source wins). Kept as one table because two places must agree on it: the derivation here, and
// updateProject's re-derivation on edit (staleDerivedKeys below). Identity copies (moduleModel,
// batteryModel, serviceType…) have no separate source, so an edit can't leave them stale.
export const CANONICAL_ALIAS_SOURCES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["homeownerPhone", ["ownerPhone"]],
  ["moduleManufacturer", ["moduleMake"]],
  ["moduleWatts", ["moduleWattage"]],
  ["moduleQuantity", ["moduleQty"]],
  ["inverterManufacturer", ["invMake", "pvMicroMake"]],
  ["inverterModel", ["invModel", "pvMicroModel"]],
  ["inverterQuantity", ["invQty", "pvMicroQty"]],
  ["batteryManufacturer", ["batteryMake"]],
  ["batteryQuantity", ["batteryQty"]],
  ["essKwh", ["batteryCapacityKwh"]],
  ["mainServiceRating", ["busRating", "mainBreaker"]],
];

// A DERIVED ALIAS IS AN ECHO OF ITS EVIDENCE, NOT A FACT OF ITS OWN (#225). canonicalizeSnapshot
// never clobbers a present key, so once `inverterModel` is stored it outlives an edit to `invModel`:
// a design corrected from Enphase micros to a Sunny Boy string inverter kept the micro alias, and
// readers that join both fields (codeReviewRules.isMlpeDesign) kept softening its rapid-shutdown
// blocker. Returns the keys of `snapshot` whose stored value is exactly what canonicalization would
// derive from the OTHER evidence in it — those carry no information beyond their sources and must be
// dropped before an edit is merged, so they are re-derived from the merged evidence. A stored value
// that differs from its derivation was provided on its own (the parser emitted the canonical name,
// or an operator set it) and is kept. pvArrays is the same shape: built from moduleQty/moduleModel/
// tilt/azimuth when absent, so a stored copy equal to that build is an echo too.
export function staleDerivedKeys(snapshot: ParserPayload): string[] {
  const out: string[] = [];
  const has = (key: string): boolean => snapshot[key] !== undefined && snapshot[key] !== null && snapshot[key] !== "";
  for (const [key, sources] of CANONICAL_ALIAS_SOURCES) {
    if (has(key) && str(snapshot, key) === first(snapshot, [...sources])) out.push(key);
  }
  if (Array.isArray(snapshot["pvArrays"])) {
    const { pvArrays: stored, ...rest } = snapshot;
    const rebuilt = canonicalizeSnapshot(rest as ParserPayload)["pvArrays"];
    if (rebuilt !== undefined && JSON.stringify(rebuilt) === JSON.stringify(stored)) out.push("pvArrays");
  }
  return out;
}

// THE ONE WAY AN EDIT LANDS ON A STORED SNAPSHOT (#225, #238). Every edit door (updateProject, the
// human-review queue's applyVerifiedField) goes through here, so a door can't forget the re-derivation:
// the derived flags (hasExistingSystem/hasBattery) and every alias that merely echoes its source
// (staleDerivedKeys, judged on the snapshot BEFORE the edit) are dropped, then the edit is merged on
// top. The caller canonicalizes the result (directly, or via normalizeProject), which re-derives what
// was dropped from the merged evidence. What the edit itself carries always wins — a human-verified
// value is evidence, never something a derivation overwrites — and an alias stored on its own
// (differs from its source) is kept.
export function mergeEditOverSnapshot(snapshot: ParserPayload, edit: ParserPayload): ParserPayload {
  const kept: Record<string, unknown> = { ...snapshot };
  delete kept["hasExistingSystem"];
  delete kept["hasBattery"];
  for (const key of staleDerivedKeys(snapshot)) delete kept[key];
  return { ...kept, ...edit } as ParserPayload;
}

// Canonical aliases whose stored value DIFFERS from what their sources would derive (#238). Before
// #225 an edit to a source left its alias behind, and a snapshot carries no provenance, so a diverged
// alias may be that legacy staleness OR a value someone set on purpose — only a person can tell. This
// only reports; nothing calls it to rewrite a snapshot.
export function divergedAliases(snapshot: ParserPayload): Array<{ key: string; stored: string; derived: string }> {
  const out: Array<{ key: string; stored: string; derived: string }> = [];
  for (const [key, sources] of CANONICAL_ALIAS_SOURCES) {
    const stored = str(snapshot, key);
    const derived = first(snapshot, [...sources]);
    if (stored && derived && stored !== derived) out.push({ key, stored, derived });
  }
  return out;
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

  // THE EMAIL SLOT IS SAVED AS AN EMAIL ADDRESS OR NOTHING (looksLikeEmail, #71/#92). Every entry
  // page and the parser save through here, so a name typed or autofilled into the email box is
  // dropped at save instead of stored and re-checked at every reader. The one key this rewrites even
  // when present: a non-email in it is not a value worth keeping.
  const email = firstEmail(payload["homeownerEmail"], payload["ownerEmail"]);
  if (email || has("homeownerEmail")) canonical["homeownerEmail"] = email;
  for (const [key, sources] of CANONICAL_ALIAS_SOURCES) set(key, pick([key, ...sources]));
  set("moduleModel", pick(["moduleModel"]));
  set("batteryModel", pick(["batteryModel"]));
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
    ...withTrackIssuers(payload),
    createdAt,
    updatedAt,
  };
}

/** `{ trackIssuers }` when the snapshot carries any, else nothing (see trackIssuersFromSnapshot). */
export function withTrackIssuers(snapshot: ParserPayload | null | undefined): { trackIssuers?: TrackIssuerOverrides } {
  const issuers = trackIssuersFromSnapshot(snapshot);
  return issuers ? { trackIssuers: issuers } : {};
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

