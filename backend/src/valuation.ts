import type { ParserPayload } from "../../shared/src/types";

// Project valuation for AHJ permit fees.
//
// AHJs compute building/electrical permit fees from a "construction valuation"
// (a.k.a. job value). The most defensible number is the installer's actual
// contract / installed price — only the client knows it. When the client hasn't
// provided it yet, we fall back to a per-watt estimate (system DC watts ×
// configurable $/watt) so a submittal always has a usable figure. The estimate
// is clearly labelled and the client can override it with the true contract value.
//
// THE OPERATOR'S OWN FORMULA (ruling 2026-09-21, from their working spreadsheet):
//
//     valuation = contract × 0.4  +  battery adder × battery quantity
//     adder: AP Systems $7,000 · Tesla $8,500 · anything else $0
//
// verbatim from the sheet: `=A2*$F$1 + IF(B2="AP Systems", 7000, IF(B2="Tesla", 8500, 0)) * C2`
// with F1 = 0.4 — which is also the OAR 918-050-0180 fraction this file's old note only
// gestured at. Checked against their live rows: $25,232.40 × 0.4 = $10,092.96, the sheet's own
// D2. The contract price is what the CLIENT pays; the valuation is what goes on the permit
// application, and the two were being conflated — jobValue was placed on applications
// unchanged, overstating the valuation 2.5× and with it every valuation-laddered fee.
//
// Rates are env-tunable, defaults are the operator's sheet:
//   PERMIT_VALUATION_CONTRACT_FACTOR (default 0.4)  ·  PERMIT_VALUATION_PER_WATT ($3.00/W,
// used to ESTIMATE the contract when none is on file — the formula then applies on top).

const DEFAULT_PER_WATT_RATE = 3.0;
const DEFAULT_CONTRACT_FACTOR = 0.4;

/** Battery adders by manufacturer, from the operator's sheet. Matching is lenient on
 *  spelling ("APSystems", "AP Systems", "Tesla Energy") and strict on everything else:
 *  an unknown battery make adds $0 rather than a guessed adder. */
const BATTERY_ADDERS: { pattern: RegExp; adderUsd: number; label: string }[] = [
  { pattern: /\bap\s*systems?\b|\bapsystems?\b/i, adderUsd: 7000, label: "AP Systems" },
  { pattern: /\btesla\b/i, adderUsd: 8500, label: "Tesla" },
];

export function valuationContractFactor(): number {
  const raw = Number(process.env.PERMIT_VALUATION_CONTRACT_FACTOR);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_CONTRACT_FACTOR;
}

export type ValuationMethod = "contract" | "per_watt_estimate" | "unavailable";

export interface ValuationResult {
  value: number | null;
  method: ValuationMethod;
  perWattRate: number;
  /** Human-readable explanation of how the value was derived. */
  basis: string;
}

export function valuationPerWattRate(): number {
  const raw = Number(process.env.PERMIT_VALUATION_PER_WATT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PER_WATT_RATE;
}

/** Parse a money-ish value ("$31,500", "31500", 31500) into a positive number. */
export function parseMoney(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? input : null;
  if (typeof input !== "string") return null;
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * Resolve the valuation to put on a permit application.
 * Prefers a client-provided contract value; otherwise estimates from system size.
 */
// THE 40% FORMULA IS COMPANY PRACTICE, NOT AN OREGON RULE — and it applies in every
// state. A multi-state readiness audit (2026-09-22) flagged the fraction as an Oregon
// ruling leaking into other states' declared-value boxes, and a state gate was written
// and then removed on the operator's ruling the same day: "the 15200 is the valuation
// and is treated correctly… it's what we do at our company and it's normal." The
// operator owns this one — it is their licence on the application and their established
// method with their AHJs. Recorded here so the next audit does not re-raise it as a bug.
export function resolveValuation(
  snapshot: ParserPayload | null | undefined,
  systemSizeDcKw: number | null | undefined,
): ValuationResult {
  const rate = valuationPerWattRate();
  const factor = valuationContractFactor();
  const snap = snapshot || {};

  // The battery half of the formula, shared by both branches. Quantity defaults to 1 when a
  // battery model is on file with no count — a recorded battery with a zeroed adder would be
  // the formula quietly disagreeing with the sheet it came from.
  const batteryMake = String((snap as Record<string, unknown>).batteryManufacturer ?? (snap as Record<string, unknown>).batteryMake ?? "").trim();
  const batteryModel = String((snap as Record<string, unknown>).batteryModel ?? "").trim();
  const rawQty = Number(String((snap as Record<string, unknown>).batteryQuantity ?? "").replace(/\D/g, ""));
  const batteryQty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : (batteryMake || batteryModel ? 1 : 0);
  const adder = BATTERY_ADDERS.find((a) => a.pattern.test(`${batteryMake} ${batteryModel}`));
  const batteryUsd = adder && batteryQty > 0 ? adder.adderUsd * batteryQty : 0;
  const batteryNote = batteryUsd > 0 ? ` + ${batteryQty} × $${adder!.adderUsd.toLocaleString()} (${adder!.label} battery)` : "";

  // 1. Client-provided contract / installed cost — the authoritative INPUT. The valuation on
  //    the application is the operator's formula OF it, never the contract itself.
  const contract = parseMoney(snap.jobValue);
  if (contract != null) {
    const value = Math.round((contract * factor + batteryUsd) * 100) / 100;
    return {
      value,
      method: "contract",
      perWattRate: rate,
      basis: `${Math.round(factor * 100)}% of contract $${contract.toLocaleString()}${batteryNote} (operator valuation formula).`,
    };
  }

  // 2. Per-watt CONTRACT estimate fallback, with the same formula applied on top — the
  //    per-watt rate approximates what the client pays, not what the permit is valued at.
  const dcKw = typeof systemSizeDcKw === "number" && Number.isFinite(systemSizeDcKw)
    ? systemSizeDcKw
    : parseMoney(snap.systemSizeDcKw);
  if (dcKw != null && dcKw > 0) {
    const contractEstimate = Math.round(dcKw * 1000 * rate);
    const value = Math.round((contractEstimate * factor + batteryUsd) * 100) / 100;
    return {
      value,
      method: "per_watt_estimate",
      perWattRate: rate,
      basis: `${Math.round(factor * 100)}% of an ESTIMATED contract ($${rate.toFixed(2)}/W × ${dcKw} kW DC ≈ $${contractEstimate.toLocaleString()})${batteryNote}. Confirm against the actual contract value before final submit.`,
    };
  }

  // 3. Nothing to compute from.
  return {
    value: null,
    method: "unavailable",
    perWattRate: rate,
    basis: "No contract value provided and system size unknown — cannot determine valuation.",
  };
}

/**
 * THE VALUATION AS AN APPLICATION BOX TAKES IT — whole dollars, "" when there is nothing to
 * compute from. The SAME number the PDF side files (ahjForms computed.declaredValuation /
 * estimatedJobValue round resolveValuation's value exactly this way); the portal recipes resolve
 * `declaredValuation` through here so a portal's Job Value box and the PDF application can never
 * state two different valuations for one job.
 */
export function filingValuationText(
  snapshot: ParserPayload | null | undefined,
  systemSizeDcKw: number | string | null | undefined,
): string {
  const v = resolveValuation(snapshot, Number(systemSizeDcKw) || null);
  return v.value != null && v.value > 0 ? String(Math.round(v.value)) : "";
}

// WHICH BOX WANTS THE VALUATION, AND WHICH WANTS THE CONTRACT (leak sweep 2026-09-28).
//
// The planner's only dollar figure used to be jobValue — the CONTRACT the client pays — so every
// portal "Job Value" / "Valuation" / "Estimated Cost" box learned from it filed the contract, 2.5x
// the valuation the PDF, the fee sheet and the invoice state (a 51,866.60 contract filed where the
// application says 20,747). One label predicate, asked by the planner hint, the learn-time
// correction and the replay rebind alike: a box that asks what the WORK is worth takes the
// valuation; a box that says CONTRACT keeps the contract price.
export const CONTRACT_PRICE_LABEL = /\bcontract(?:ed)?\s*(?:price|amount|value|sum|total|cost)\b/i;
const MENTIONS_CONTRACT = /\bcontract(?:ed)?\b/i;
export const VALUATION_BOX_LABEL = /\bjob\s*valu(?:e|ation)\b|\bvaluation\b|\bestimated\s*(?:project\s*|job\s*|construction\s*|total\s*)?(?:cost|value)\b|\bconstruction\s*(?:value|cost)\b|\bproject\s*(?:value|valuation|cost)\b|\bvalue\s*of\s*(?:the\s*)?(?:work|construction|improvements?|installation|project)\b|\bcost\s*of\s*(?:the\s*)?(?:work|construction|improvements?|installation|project)\b|\bdeclared\s*value\b/i;
/** True when a portal box's label asks for the work's VALUATION. A label that names a CONTRACT
 *  ("Contract Price", "Job Value (contract)") is never one — that box keeps the contract. */
export function isValuationBoxLabel(label: string): boolean {
  const l = String(label ?? "");
  return VALUATION_BOX_LABEL.test(l) && !MENTIONS_CONTRACT.test(l);
}
/** The resolver key a valuation box binds to, and the contract keys it must never be. */
export const DECLARED_VALUATION_FIELD = "declaredValuation";
const CONTRACT_PRICE_KEYS = new Set(["jobValue", "contractAmount"]);
/** Does a fill under `label`, bound to `field` ("" = an unbound literal), belong on the declared
 *  valuation instead? True for a valuation box carrying the contract keys or a frozen literal
 *  (the learn project's figure); false for any other binding and for a contract-price box. */
export function rebindsToValuation(label: string, field: string | null | undefined): boolean {
  if (!isValuationBoxLabel(label)) return false;
  const f = String(field ?? "").trim();
  return !f || CONTRACT_PRICE_KEYS.has(f);
}
