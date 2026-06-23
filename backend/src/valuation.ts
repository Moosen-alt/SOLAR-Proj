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
// NOTE: the valuation METHOD (full contract, contract × 0.4 per OAR 918-050-0180,
// racking + labor, prescriptive flat fee, etc.) varies by installer and AHJ, so it
// is NOT computed here — the operator decides it and supplies the final number as
// jobValue. The bot just places that figure on the application unchanged.
//
// Per-watt rate is configurable via PERMIT_VALUATION_PER_WATT (default $3.00/W).

const DEFAULT_PER_WATT_RATE = 3.0;

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
export function resolveValuation(
  snapshot: ParserPayload | null | undefined,
  systemSizeDcKw: number | null | undefined,
): ValuationResult {
  const rate = valuationPerWattRate();
  const snap = snapshot || {};

  // 1. Client-provided contract / installed cost — the authoritative number.
  const contract = parseMoney(snap.jobValue);
  if (contract != null) {
    return {
      value: contract,
      method: "contract",
      perWattRate: rate,
      basis: "Client-provided contract / installed cost.",
    };
  }

  // 2. Per-watt estimate fallback from DC system size.
  const dcKw = typeof systemSizeDcKw === "number" && Number.isFinite(systemSizeDcKw)
    ? systemSizeDcKw
    : parseMoney(snap.systemSizeDcKw);
  if (dcKw != null && dcKw > 0) {
    const estimate = Math.round(dcKw * 1000 * rate);
    return {
      value: estimate,
      method: "per_watt_estimate",
      perWattRate: rate,
      basis: `Estimated at $${rate.toFixed(2)}/W × ${dcKw} kW DC. Confirm against the actual contract value before final submit.`,
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
