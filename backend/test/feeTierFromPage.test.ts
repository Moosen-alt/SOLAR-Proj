// THE kVA TIER IS DECIDED FROM THE PAGE'S OWN LABELS — the pure half.
//
// Live run 99baa5d0 (2026-09-27, City of Jefferson OR, 12.913 kVA AC, the Coos Bay electrical
// recipe borrowed onto MARION COUNTY's services page, no Marion schedule on file): the recorded
// "5.01kva through 15kva" box was left blank by R6 and the run clicked Continue into "Please
// select at least 1 electrical service for purchase". The page prints the bounds in every box
// label; the decision needs no schedule. This pins:
//
//   1. tierBoundsFromLabel — the ONE portal-label grammar — on Marion's six labels verbatim
//      (wind rows read as wind, "solar generation over 25 kva (enter total # of kva)" as an open
//      tier that takes the kVA number), and on the Coos schedule spellings.
//   2. AGREEMENT with pdfTables.parseBracketRow on every spelling the PDF grammar can read: the
//      two grammars must never disagree about a bound (feeBracketFieldForLabel and the replay
//      binding used to hand labels to parseBracketRow; now they read the leaf grammar).
//   3. decideFeeTier: 12.913 → "5.01kva through 15kva" = "1"; 4.55 → "5kva or less"; 20 → 15.01–25;
//      30 → "over 25 kva" gets "30" (the label asks for the number), NEVER the wind 25.01–50 box.
//      MUST-EXCLUDE: no rating → nothing chosen, reason names it; a stored schedule that disagrees
//      → nothing chosen; two containing tiers → nothing chosen; a page with no solar tier box →
//      nothing chosen.
//   4. feeBracketQuantityFields always emits feeTierRatingKw (AC first, DC fallback, "" when
//      neither) — with or without a schedule on file.
//
//   npx tsx backend/test/feeTierFromPage.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MARION = {
  le5: "Renewable energy for electrical systems- 5kva or less:",
  t5_15: "Renewable energy for electrical systems- 5.01kva through 15kva:",
  t15_25: "Renewable energy for electrical systems- 15.01kva through 25kva:",
  wind25_50: "Renewable energy for wind systems- 25.01kva through 50kva (Plan review may be required):",
  wind50_100: "Renewable energy for wind systems- 50.01kva through 100kva (Plan review required):",
  over25: "Renewable Energy - solar generation over 25 kva (enter total # of kva) (Plan review required):",
};
const NOT_TIERS = [
  "Services/feeders 200 amps or less:",
  "Residential wiring - enter total sq. footage including attached garage:",
  "Temp services/feeders 201 amps to 400 amps:",
  "Additional Comments:",
  "Project includes any of the following:",
];

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-tier-page-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  const { openDatabase } = await import("../src/db");
  const { feeBracketQuantityFields, feeBracketFieldForLabel } = await import("../src/feeBracketFields");
  const { parseBracketRow } = await import("../src/pdfTables");
  const leaf = await import("../../portal-bot/src/feeBracketQuantity");
  const { tierBoundsFromLabel, tierLabelKind, tierAsksForKva, decideFeeTier, sameFeeTier, FEE_TIER_RATING_FIELD, feeBracketFieldKey } = leaf;
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`  ok   - ${name}`);
    else { failures++; console.error(`  FAIL - ${name}${detail ? `\n         ${detail}` : ""}`); }
  };
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // ── 1. the grammar on Marion's labels, verbatim ────────────────────────────────────────────
  check("Marion '5kva or less' → max 5", eq(tierBoundsFromLabel(MARION.le5), { minKw: null, maxKw: 5 }), JSON.stringify(tierBoundsFromLabel(MARION.le5)));
  check("Marion '5.01kva through 15kva' → 5.01–15", eq(tierBoundsFromLabel(MARION.t5_15), { minKw: 5.01, maxKw: 15 }), JSON.stringify(tierBoundsFromLabel(MARION.t5_15)));
  check("Marion '15.01kva through 25kva' → 15.01–25", eq(tierBoundsFromLabel(MARION.t15_25), { minKw: 15.01, maxKw: 25 }), JSON.stringify(tierBoundsFromLabel(MARION.t15_25)));
  check("Marion 'solar generation over 25 kva' → 25.01 and above (open)", eq(tierBoundsFromLabel(MARION.over25), { minKw: 25.01, maxKw: null }), JSON.stringify(tierBoundsFromLabel(MARION.over25)));
  check("  ...and it asks for the kVA number", tierAsksForKva(MARION.over25) && !tierAsksForKva(MARION.t5_15));
  check("Marion wind rows read as WIND, the solar rows as solar", tierLabelKind(MARION.wind25_50) === "wind" && tierLabelKind(MARION.wind50_100) === "wind"
    && tierLabelKind(MARION.t5_15) === "solar" && tierLabelKind(MARION.over25) === "solar" && tierLabelKind(MARION.le5) === "solar");
  check("Coos schedule spellings: '5.01 KVA to 15 KVA' and '5 KVA or less' and '15.01 KVA to 25 KVA'",
    eq(tierBoundsFromLabel("5.01 KVA to 15 KVA"), { minKw: 5.01, maxKw: 15 }) && eq(tierBoundsFromLabel("5 KVA or less"), { minKw: null, maxKw: 5 })
    && eq(tierBoundsFromLabel("15.01 KVA to 25 KVA"), { minKw: 15.01, maxKw: 25 }));
  check("'25 kVA or more' / 'above 25 kva' / '25.01 kva and up' read as open tiers",
    eq(tierBoundsFromLabel("Solar 25 kVA or more"), { minKw: 25, maxKw: null }) && eq(tierBoundsFromLabel("PV systems above 25 kva"), { minKw: 25.01, maxKw: null })
    && eq(tierBoundsFromLabel("PV 25.01 kva and up"), { minKw: 25.01, maxKw: null }));
  for (const l of NOT_TIERS) check(`not a tier: ${JSON.stringify(l.slice(0, 50))}`, tierBoundsFromLabel(l) === null, JSON.stringify(tierBoundsFromLabel(l)));
  // A SELECT OPTION's wording is a tier phrase too ("75 KVA or larger separately derived system"):
  // the grammar reads it as an open tier, which is right for the phrase — the page reader only
  // ever hands it TEXT INPUT labels, so an option never reaches it.
  check("'75 KVA or larger' is an open tier phrase (only text-input labels are ever read, so an option never gets here)",
    eq(tierBoundsFromLabel("04-Installation of 75 KVA or larger separately derived system"), { minKw: 75, maxKw: null }));
  check("feeBracketFieldForLabel keys the Marion labels numerically (recorded step ↔ page)",
    feeBracketFieldForLabel(MARION.t5_15) === "feeBracketQuantity:5.01-15" && feeBracketFieldForLabel(MARION.le5) === "feeBracketQuantity:-5"
    && feeBracketFieldForLabel(MARION.over25) === "feeBracketQuantity:25.01-" && feeBracketFieldForLabel("5.01 KVA to 15 KVA") === "feeBracketQuantity:5.01-15",
    [MARION.t5_15, MARION.le5, MARION.over25].map(feeBracketFieldForLabel).join(" | "));
  check("services/feeders <=200A still keys to its own family, never a kVA tier", feeBracketFieldForLabel("Services/feeders 200 amps or less:") === "feeLineQuantity:servicesFeeders200A");

  // ── 2. agreement with the PDF grammar wherever the PDF grammar reads a bound ────────────────
  const corpus = [
    ...Object.values(MARION), "5.01 KVA to 15 KVA", "5 KVA or less", "15.01 KVA to 25 KVA", "25.01 KVA to 50 KVA",
    "Renewable energy systems 5 kva or less", "Renewable energy systems 5.01 to 15 kva", "Solar PV 15.01 kVA – 25 kVA",
    "Services or feeders 200 amps or less", "Limited energy",
  ];
  let disagreements: string[] = [];
  for (const l of corpus) {
    const pdf = parseBracketRow({ row: { page: 1, y: 0, cells: [l], xs: [0], height: 10 }, matched: [], label: l, money: [], continuations: [], section: "" } as never);
    const pdfKey = feeBracketFieldKey(pdf.minKw ?? null, pdf.maxKw ?? null);
    if (!pdfKey) continue; // the PDF grammar reads no bound here — nothing to agree on
    const leafB = tierBoundsFromLabel(l);
    const leafKey = leafB ? feeBracketFieldKey(leafB.minKw, leafB.maxKw) : "";
    if (leafKey !== pdfKey) disagreements.push(`${JSON.stringify(l)}: pdf=${pdfKey} leaf=${leafKey}`);
  }
  check("the leaf grammar agrees with pdfTables.parseBracketRow on every spelling the PDF grammar reads", disagreements.length === 0, disagreements.join("\n         "));
  disagreements = [];

  // ── 3. the decision ────────────────────────────────────────────────────────────────────────
  const boxes = Object.entries(MARION).map(([id, label]) => ({ id, label }));
  const d1 = decideFeeTier({ boxes, ratingKw: 12.913 });
  check("MUST-PASS 12.913 kVA → '5.01kva through 15kva' = \"1\"", d1.chosen?.id === "t5_15" && d1.chosen?.value === "1", JSON.stringify(d1));
  const d2 = decideFeeTier({ boxes, ratingKw: 4.55 });
  check("MUST-PASS 4.55 kVA → '5kva or less' = \"1\"", d2.chosen?.id === "le5" && d2.chosen?.value === "1", JSON.stringify(d2));
  const d3 = decideFeeTier({ boxes, ratingKw: 20 });
  check("MUST-PASS 20 kVA → '15.01kva through 25kva' = \"1\"", d3.chosen?.id === "t15_25" && d3.chosen?.value === "1", JSON.stringify(d3));
  const d4 = decideFeeTier({ boxes, ratingKw: 30 });
  check("MUST-PASS 30 kVA → 'solar generation over 25 kva (enter total # of kva)' gets \"30\" — never the wind 25.01–50 box",
    d4.chosen?.id === "over25" && d4.chosen?.value === "30", JSON.stringify(d4));
  check("  ...the family read excludes the wind rows", d4.family.every((f) => !/wind/i.test(f.label)) && d4.family.length === 4, d4.family.map((f) => f.id).join(","));
  check("boundary: exactly 15 kVA is the 5.01–15 tier, 15.01 is the next (inclusive bounds, the way the table prints them)",
    decideFeeTier({ boxes, ratingKw: 15 }).chosen?.id === "t5_15" && decideFeeTier({ boxes, ratingKw: 15.01 }).chosen?.id === "t15_25");
  const d5 = decideFeeTier({ boxes, ratingKw: null });
  check("MUST-EXCLUDE no rating → NOT guessed, the reason names it", d5.chosen === null && /no AC \(or DC\) system size/.test(d5.reason), JSON.stringify(d5.reason));
  const d6 = decideFeeTier({ boxes, ratingKw: 12.913, scheduleTierKey: "feeBracketQuantity:15.01-25" });
  check("MUST-EXCLUDE a stored schedule that puts the job in another tier → NOT typed, the disagreement named",
    d6.chosen === null && /stored fee schedule/.test(d6.reason) && /15.01–25/.test(d6.reason), JSON.stringify(d6.reason));
  const d7 = decideFeeTier({ boxes, ratingKw: 12.913, scheduleTierKey: "feeBracketQuantity:5.01-15" });
  check("a stored schedule that AGREES changes nothing", d7.chosen?.id === "t5_15" && d7.chosen?.value === "1");
  const d8 = decideFeeTier({ boxes: [...boxes, { id: "dup", label: "Solar systems 10 kva through 20 kva:" }], ratingKw: 12.913 });
  check("MUST-EXCLUDE two tiers containing the rating → NOT guessed, both named", d8.chosen === null && /2 of the tiers/.test(d8.reason) && /10 kva through 20 kva/.test(d8.reason), JSON.stringify(d8.reason));
  const d9 = decideFeeTier({ boxes: [{ id: "a", label: "Services/feeders 200 amps or less:" }, { id: "w", label: MARION.wind25_50 }], ratingKw: 12.913 });
  check("MUST-EXCLUDE a page with no solar tier box → nothing decided, and the wind box is never it", d9.chosen === null && d9.family.length === 0, JSON.stringify(d9.reason));
  const d10 = decideFeeTier({ boxes, ratingKw: 250 });
  check("250 kVA lands in the open 'over 25' tier with the number", d10.chosen?.id === "over25" && d10.chosen?.value === "250");
  check("sameFeeTier: 5–15 ≡ 5.01–15; open lower ≡ 0; 5.01–15 ≢ 15.01–25",
    sameFeeTier({ minKw: 5, maxKw: 15 }, { minKw: 5.01, maxKw: 15 }) && sameFeeTier({ minKw: null, maxKw: 5 }, { minKw: 0, maxKw: 5 })
    && !sameFeeTier({ minKw: 5.01, maxKw: 15 }, { minKw: 15.01, maxKw: 25 }));

  // ── 4. the rating travels with the field values, schedule or not ───────────────────────────
  const base = { state: "OR", ahj: "City of Jefferson", utility: "Pacific Power", parserSnapshot: null } as never;
  const fAc = feeBracketQuantityFields(db, { ...base, systemSizeAcKw: 12.913, systemSizeDcKw: 15.91 });
  check("feeTierRatingKw = the AC size when present (no schedule on file for this AHJ)", fAc[FEE_TIER_RATING_FIELD] === "12.913", JSON.stringify(fAc));
  check("  ...and no bracket keys are invented without a schedule", Object.keys(fAc).every((k) => !k.startsWith("feeBracketQuantity:")), Object.keys(fAc).join(","));
  const fDc = feeBracketQuantityFields(db, { ...base, systemSizeAcKw: null, systemSizeDcKw: 15.91 });
  check("feeTierRatingKw falls back to DC when AC is missing", fDc[FEE_TIER_RATING_FIELD] === "15.91", JSON.stringify(fDc));
  const fNone = feeBracketQuantityFields(db, { ...base, systemSizeAcKw: null, systemSizeDcKw: null });
  check("feeTierRatingKw is \"\" (defined, empty) with no size — the adapter refuses to guess", fNone[FEE_TIER_RATING_FIELD] === "", JSON.stringify(fNone));

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? "\nfeeTierFromPage: all checks passed." : `\nfeeTierFromPage: ${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
