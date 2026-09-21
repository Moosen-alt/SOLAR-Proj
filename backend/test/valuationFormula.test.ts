// THE CONTRACT IS WHAT THE CLIENT PAYS. THE VALUATION IS WHAT GOES ON THE PERMIT.
//
// The two were conflated: jobValue was placed on applications unchanged, overstating every
// valuation 2.5x, and with it every valuation-laddered fee. The operator's ruling (2026-09-21)
// is their own working spreadsheet, verbatim:
//
//     =A2*$F$1 + IF(B2="AP Systems", 7000, IF(B2="Tesla", 8500, 0)) * C2      (F1 = 0.4)
//
// checked against the sheet's own rows: $25,232.40 x 0.4 = $10,092.96 = its D2. The fixtures
// below are the operator's real numbers, not invented ones.
import { resolveValuation, valuationContractFactor } from "../src/valuation";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

delete process.env.PERMIT_VALUATION_CONTRACT_FACTOR;
delete process.env.PERMIT_VALUATION_PER_WATT;

console.log("\n1. THE SHEET'S OWN ROWS COMPUTE TO THE SHEET'S OWN ANSWERS");
{
  const sheetRow = resolveValuation({ jobValue: "25232.40" } as never, null);
  check("1a. $25,232.40 x 0.4 = $10,092.96 — the sheet's D2, to the cent",
    sheetRow.value === 10092.96 && sheetRow.method === "contract", `${sheetRow.value} ${sheetRow.method}`);

  const connie = resolveValuation({ jobValue: "56156.78" } as never, 9.84);
  check("1b. Connie's real contract $56,156.78 -> valuation $22,462.71",
    connie.value === 22462.71, String(connie.value));
  check("1c. and the basis SAYS the formula — an operator reading it can recompute it",
    /40% of contract \$56,156\.78/.test(connie.basis), connie.basis);
  check("1d. MUST PASS: contract-derived is method 'contract' — deterministic arithmetic on a real figure is not an estimate",
    connie.method === "contract");
}

console.log("\n2. BATTERY ADDERS — THE IF() HALF OF THE FORMULA");
{
  const ap = resolveValuation({ jobValue: "50000", batteryManufacturer: "AP Systems", batteryQuantity: "2" } as never, null);
  check("2a. AP Systems x2: 20,000 + 2 x 7,000 = $34,000", ap.value === 34000, String(ap.value));
  const tesla = resolveValuation({ jobValue: "50000", batteryManufacturer: "Tesla", batteryQuantity: "1" } as never, null);
  check("2b. Tesla x1: 20,000 + 8,500 = $28,500", tesla.value === 28500, String(tesla.value));
  const teslaSpelled = resolveValuation({ jobValue: "50000", batteryModel: "Tesla Powerwall 3", batteryQuantity: "1" } as never, null);
  check("2c. the make can live in the MODEL field — 'Tesla Powerwall 3' still adds $8,500",
    teslaSpelled.value === 28500, String(teslaSpelled.value));
  const apsSquished = resolveValuation({ jobValue: "50000", batteryManufacturer: "APSystems", batteryQuantity: "1" } as never, null);
  check("2d. 'APSystems' (no space) is AP Systems", apsSquished.value === 27000, String(apsSquished.value));

  // The honest edges.
  const unknown = resolveValuation({ jobValue: "50000", batteryManufacturer: "Enphase", batteryQuantity: "2" } as never, null);
  check("2e. MUST EXCLUDE: an unknown battery make adds $0, never a guessed adder",
    unknown.value === 20000, String(unknown.value));
  const noQty = resolveValuation({ jobValue: "50000", batteryManufacturer: "Tesla" } as never, null);
  check("2f. a recorded battery with no count defaults to 1 — a battery on file with a zeroed adder would contradict the sheet",
    noQty.value === 28500, String(noQty.value));
  const none = resolveValuation({ jobValue: "50000" } as never, null);
  check("2g. no battery, no adder — the sheet's 'None' rows", none.value === 20000, String(none.value));
}

console.log("\n3. THE PER-WATT FALLBACK ESTIMATES THE CONTRACT, THEN THE FORMULA APPLIES");
{
  const est = resolveValuation({} as never, 9.84);
  // 9.84 kW x $3/W = $29,520 contract estimate -> x0.4 = $11,808.
  check("3a. 9.84 kW: 40% of the $29,520 per-watt contract estimate = $11,808",
    est.value === 11808 && est.method === "per_watt_estimate", `${est.value} ${est.method}`);
  check("3b. and the basis names BOTH steps, so the reviewer comment teaches the arithmetic",
    /40% of an ESTIMATED contract/.test(est.basis) && /\$29,520/.test(est.basis), est.basis);
  check("3c. MUST PASS: still labelled an estimate — the formula does not launder a guess into a fact",
    est.method === "per_watt_estimate" && /Confirm against the actual contract/.test(est.basis));

  const nothing = resolveValuation({} as never, null);
  check("3d. nothing to compute from stays null — never a zero", nothing.value === null && nothing.method === "unavailable");
}

console.log("\n4. THE FACTOR IS TUNABLE, WITH THE SHEET AS THE DEFAULT");
{
  check("4a. default factor is the sheet's F1 = 0.4", valuationContractFactor() === 0.4);
  process.env.PERMIT_VALUATION_CONTRACT_FACTOR = "0.5";
  check("4b. env override works", valuationContractFactor() === 0.5
    && resolveValuation({ jobValue: "1000" } as never, null).value === 500);
  process.env.PERMIT_VALUATION_CONTRACT_FACTOR = "7";
  check("4c. a factor above 1 is refused — a multiplier that INFLATES a contract is a typo, not a policy",
    valuationContractFactor() === 0.4);
  delete process.env.PERMIT_VALUATION_CONTRACT_FACTOR;
}

console.log(failures ? `\nvaluationFormula: ${failures} check(s) FAILED` : "\nvaluationFormula: all checks passed");
if (failures) process.exit(1);
