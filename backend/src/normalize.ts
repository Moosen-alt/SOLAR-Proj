import type { ParserPayload, ProjectRecord, ProjectStatus } from "../../shared/src/types";
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
    parserSnapshot: payload,
    createdAt,
    updatedAt,
  };
}

export function parserField(payload: ParserPayload, fieldName: string): string {
  return first(payload, fieldAliases[fieldName] ?? [fieldName]);
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

