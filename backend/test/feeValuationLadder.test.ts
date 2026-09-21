// A FORMULA IS NOT AN UNKNOWN WHEN THE JURISDICTION PRINTED THE WHOLE FORMULA.
//
// Portland's residential structural permit is a valuation LADDER, and every rung is spelled out
// in the bracket's own label:
//
//   "$25,001 - $50,000 Fee for the first $25,000 | $ 540.78 ... For each additional $1,000 or
//    fraction thereof up to and including $50,000 | $ | 10.26"
//
// The evaluator used to see "for each additional" and refuse outright. That refusal was RIGHT
// while the rest of the sentence went unread — quoting the stored $540.78 alone under-states a
// $30,000 job by $51.30 and a $49,000 job by $246. But it left Bren Trask's real Portland filing
// priced at $450: the 1.5%-of-valuation heuristic, which has never read Portland's fee table.
// The operator's complaint about this exact screen was that PDX fees "can get upward of like
// $1300 sometimes" and ours did not move.
//
// The strings in section 1 are the LIVE labels, copied byte for byte out of the operator's
// fee_schedules row. Writing the fixture from the live shape rather than a tidied one is the
// whole point: a parser tuned to prose nobody publishes proves nothing.
import {
  bracketDescribesFormula,
  evaluateValuationLadder,
  parseValuationLadder,
  type FeeBracket,
} from "../src/feeSchedules";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// THE LIVE ROW. City of Portland / structural / basis=valuation, verbatim.
// ---------------------------------------------------------------------------
const PORTLAND: FeeBracket[] = [
  { feeUsd: 167, minValuationUsd: 1, maxValuationUsd: 500, label: "$1 - $500 | Minimum Fee | $ 167.00" },
  { feeUsd: 167, minValuationUsd: 501, maxValuationUsd: 2000, label: "$501 - $2,000 | Fee for the first $500 | $ 167.00 ... For each additional $100 or fraction thereof up to and including $2,000 | $ | 3.59 (Maximum number of allowable* inspections: 3)" },
  { feeUsd: 220.85, minValuationUsd: 2001, maxValuationUsd: 25000, label: "$2,001 - $25,000 | Fee for the first $2,000 | $ 220.85 ... For each additional $1,000 or fraction thereof up to and including $25,000 | $ | 13.91 (Maximum number of allowable* inspections: 5)" },
  { feeUsd: 540.78, minValuationUsd: 25001, maxValuationUsd: 50000, label: "$25,001 - $50,000 Fee for the first $25,000 | $ 540.78 ... For each additional $1,000 or fraction thereof up to and including $50,000 | $ | 10.26 (Maximum number of allowable* inspections: 6)" },
  { feeUsd: 797.28, minValuationUsd: 50001, maxValuationUsd: 100000, label: "$50,001 - $100,000 Fee for the first $50,000 | $ 797.28 ... For each additional $1,000 or fraction thereof up to and including $100,000 | $ | 6.81 (Maximum number of allowable* inspections: 7)" },
  { feeUsd: 1137.78, minValuationUsd: 100001, maxValuationUsd: null, label: "$100,001 and up | Fee for the first $100,000 | $ 1,137.78 ... For each additional $1,000 or fraction thereof | $ | 5.63" },
];
const TRASK_BRACKET = PORTLAND[3];

console.log("\n1. READING THE LADDER OUT OF THE JURISDICTION'S OWN WORDING");
{
  const l = parseValuationLadder(TRASK_BRACKET);
  check("1a. Trask's bracket yields a ladder at all", l !== null);
  if (l) {
    check("1b. base $540.78 covers the first $25,000", l.baseUsd === 540.78 && l.aboveUsd === 25000, JSON.stringify(l));
    check("1c. $10.26 per $1,000 above it", l.ratePerStepUsd === 10.26 && l.stepUsd === 1000, JSON.stringify(l));
    check('1d. "or fraction thereof" means a part step is charged whole', l.roundUp === true);
    check("1e. and it carries the clause it was read from", l.quote.includes("For each additional $1,000"));
  }

  // The low rung steps by $100, not $1,000. A hardcoded step size would price it 10x wrong.
  const low = parseValuationLadder(PORTLAND[1]);
  check("1f. THE STEP SIZE IS READ, NOT ASSUMED: the $501–$2,000 rung steps by $100 at $3.59",
    low?.stepUsd === 100 && low?.ratePerStepUsd === 3.59 && low?.aboveUsd === 500, JSON.stringify(low));

  // The open top rung has no "up to and including" clause at all.
  const top = parseValuationLadder(PORTLAND[5]);
  check("1g. the open-ended top rung parses without an upper clause",
    top?.baseUsd === 1137.78 && top?.aboveUsd === 100000 && top?.stepUsd === 1000 && top?.ratePerStepUsd === 5.63,
    JSON.stringify(top));

  check("1h. MUST PASS: the flat minimum-fee rung is NOT a ladder and must stay a flat fee",
    parseValuationLadder(PORTLAND[0]) === null);
  check("1i. MUST PASS: every rung this reads is still recognised as a formula by the old detector",
    PORTLAND.slice(1).every((b) => bracketDescribesFormula(b.label)));
}

console.log("\n2. THE LADDER AND THE BRACKET MUST BE THE SAME MONEY");
{
  // The label says the first $25,000 costs $540.78 while the bracket charges $600. Two readings
  // of one schedule that disagree — the condition this file already refuses to quote through.
  const disagreeing: FeeBracket = { ...TRASK_BRACKET, feeUsd: 600 };
  check("2a. a label whose base contradicts the bracket's own fee yields NO ladder",
    parseValuationLadder(disagreeing) === null);

  check("2b. a label with a base and no per-step clause is not a ladder",
    parseValuationLadder({ feeUsd: 540.78, label: "$25,001 - $50,000 Fee for the first $25,000 | $ 540.78" }) === null);
  check("2c. a label with a per-step clause and no base is not a ladder",
    parseValuationLadder({ feeUsd: 10.26, label: "For each additional $1,000 or fraction thereof | $ | 10.26" }) === null);
  check("2d. a bracket with no label at all is not a ladder", parseValuationLadder({ feeUsd: 540.78 }) === null);
}

console.log("\n3. WALKING IT — THE NUMBERS, EXACTLY");
{
  const l = parseValuationLadder(TRASK_BRACKET)!;

  // BREN TRASK, the real project: jobValue $30,000. 540.78 + ceil(5000/1000) x 10.26 = 592.08.
  check("3a. THE REAL ONE: Trask's $30,000 job is $592.08, not the stored $540.78",
    evaluateValuationLadder(l, 30000) === 592.08, String(evaluateValuationLadder(l, 30000)));

  // "or fraction thereof" — one dollar over a step boundary buys a WHOLE step.
  check("3b. $30,001 crosses into a sixth step: $602.34",
    evaluateValuationLadder(l, 30001) === 602.34, String(evaluateValuationLadder(l, 30001)));
  check("3c. $30,500 is the same sixth step — half a step is charged whole",
    evaluateValuationLadder(l, 30500) === 602.34, String(evaluateValuationLadder(l, 30500)));

  check("3d. at the bracket floor exactly, nothing is above the base",
    evaluateValuationLadder(l, 25000) === 540.78, String(evaluateValuationLadder(l, 25000)));
  check("3e. below the base it does not go NEGATIVE",
    evaluateValuationLadder(l, 10) === 540.78, String(evaluateValuationLadder(l, 10)));
  check("3f. the top of the bracket: $50,000 is 25 steps, $797.28 — and note it MEETS the next rung's base",
    evaluateValuationLadder(l, 50000) === 797.28, String(evaluateValuationLadder(l, 50000)));

  // THE ROUNDING IS READ FROM THE WORDING. Without "or fraction thereof" a part step is free.
  const floored = { ...l, roundUp: false };
  check("3g. MUST PASS: without those words a part step is NOT charged — $30,500 stays at 5 steps",
    evaluateValuationLadder(floored, 30500) === 592.08, String(evaluateValuationLadder(floored, 30500)));

  check("3h. NO VALUATION, NO NUMBER — a ladder with nothing to walk returns null, never a base",
    evaluateValuationLadder(l, null) === null, String(evaluateValuationLadder(l, null)));

  // The low rung, to prove the $100 step is actually used in arithmetic and not just parsed.
  const low = parseValuationLadder(PORTLAND[1])!;
  check("3i. $1,000 on the $100-step rung: 167 + 5 x 3.59 = $184.95",
    evaluateValuationLadder(low, 1000) === 184.95, String(evaluateValuationLadder(low, 1000)));
}

console.log("\n4. WHAT MUST STILL REFUSE");
{
  // The kVA formulas. Residential systems are 3–15 kVA so these rungs are nearly dead, and their
  // stored feeUsd means different things row to row — Tigard stores the RATE with the base named
  // only in prose, Portland electrical stores a rate with no base at all, Coos County stores the
  // base. Turning "we found a formula" into "we can price a formula" across all of those is how a
  // fee engine starts guessing. This fix is for the valuation ladder and nothing else.
  const kva: FeeBracket[] = [
    { feeUsd: 7.42, label: "Solar generation systems in excess of 25 kva — Each additional kva over 25 ($7.42 per kva, added to the 15.01–25 kva base of $200.34)" },
    { feeUsd: 15.52, label: "Solar Generation System Over 25 KVA (Plan Review Required) — Each kva over 25.012 up to 100 kva ($15.52 per kva)" },
    { feeUsd: 265, label: "Solar Generation greater than 25 KVA — 25 KVA rate plus each additional KVA | $265.00 + $10 per add'l kva up to a maximum of 100 kva" },
  ];
  for (const b of kva) {
    check(`4a. still refuses: "${String(b.label).slice(0, 52)}…"`, parseValuationLadder(b) === null);
    check("4b. …and is still detected as a formula, so the refusal path is the one it takes",
      bracketDescribesFormula(b.label));
  }
}

console.log(failures ? `\nfeeValuationLadder: ${failures} check(s) FAILED` : "\nfeeValuationLadder: all checks passed");
if (failures) process.exit(1);
