// A REINSPECTION FEE IS NOT AN OPEN QUESTION. IT IS THE PRICE OF SOMETHING THAT HAS NOT HAPPENED.
//
// The rule that an unpriced CONDITIONAL charge nulls a total was written for a real case and is
// still right for it: a plan review that is mandatory above some threshold is an open question
// about THIS filing, the answer changes the bill today, and the smaller confident number is the
// dangerous one. Salem's "Electrical Plan Review (when required or requested)" is that.
//
// But every jurisdiction researched for the active six also publishes OVERAGE fees — a
// reinspection when one fails, a charge for revising plans after submittal, checksheets beyond
// the two the review includes. Under one undifferentiated rule those nulled every total:
// Portland, Salem and Lincoln City could not produce a number at all. And the ground truth is
// sitting in the operator's filing cabinet — their paid $762.93 City of Portland receipt, four
// bills from three bureaus, contains NOT ONE overage charge, because the filing went through.
//
// So the split, and the direction of its default: HOLD unless the wording is unmistakably about
// extra work beyond what the permit covers. The fixture strings below are the LIVE ones, copied
// out of the rows this research pass actually wrote.
import { chargeIsFutureContingent } from "../src/feeSchedules";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// 1. MUST PASS — released. Real labels and conditions from the live rows.
// ---------------------------------------------------------------------------
console.log("\n1. CHARGED ONLY IF SOMETHING GOES WRONG — RELEASED");
{
  const overage: [string, string][] = [
    ["Reinspection Fee - fee charged per inspection", ""],
    ["Re-inspection Fee Electrical | $52.00 | $52.00 Per hour", ""],
    ["Additional Plan Review Fee: For changes, additions, or revisions to plans", "Only if plans are changed, added to, or revised after submittal"],
    ["Each additional inspection | $ | 228.00", "Printed within the Renewable Energy section; applies only to inspections beyond those included with the permit"],
    ["Additional checksheet fee - per checksheet | $ | 324.00", "Applies only beyond the 2 checksheets allowed with the plan review fee"],
  ];
  for (const [label, condition] of overage) {
    check(`1a. "${label.slice(0, 48)}…"`, chargeIsFutureContingent(condition, label), `condition="${condition.slice(0, 40)}"`);
  }
  check("1b. the condition alone carries it when the label does not",
    chargeIsFutureContingent("Charged for each re-inspection required", "Inspection Fee"));
  check("1c. and the label alone carries it when the condition is empty",
    chargeIsFutureContingent("", "Reinspection Fee - fee charged per inspection"));
}

// ---------------------------------------------------------------------------
// 2. MUST EXCLUDE — these are questions about THIS filing and must keep holding.
//    A filter list fails both ways; this half is the one that costs money.
// ---------------------------------------------------------------------------
console.log("\n2. AN OPEN QUESTION ABOUT THIS FILING — STILL HELD");
{
  const held: [string, string][] = [
    ["Electrical Plan Review (when required or requested) | 25% | 25% Each", "Required for systems above the threshold or when the reviewer requests it"],
    ["Building Plan Review Fee | 65% | 65% Each | Percent of building permit", "Applies to structural permits"],
    ["Structural Plan Review Fees (Residential and Commercial)", "65% of the permit fee"],
    ["Solar Generation System Over 25 KVA (Plan Review Required)", "Systems over 25 kVA require plan review"],
    ["Fire - Plan Review", "Charged when the fire bureau reviews the filing"],
    ["Land Use Plan Review Res", ""],
    ["Additional Structural Plan Review for systems over 25 kVA", "Applies to systems above 25 kVA"],
  ];
  for (const [label, condition] of held) {
    check(`2a. still held: "${label.slice(0, 48)}…"`, !chargeIsFutureContingent(condition, label), `condition="${condition.slice(0, 40)}"`);
  }
  // THE WORD "ADDITIONAL" IS NOT A CLASSIFIER. Portland prints an overage fee whose text says
  // "additional" three lines from a mandatory review whose text also says "additional". If a
  // bare "additional" released a charge, the second one stops holding and a real mandatory
  // review silently vanishes from every total.
  check("2b. THE TRAP: a bare \"additional\" does not release anything on its own",
    !chargeIsFutureContingent("Applies to systems above 25 kVA", "Additional Structural Plan Review"));
  check("2c. nor does an empty condition and an empty label",
    !chargeIsFutureContingent("", "") && !chargeIsFutureContingent(undefined, undefined));
}

// ---------------------------------------------------------------------------
// 3. AND THE FLAG HAS TO SURVIVE THE TRIP. A classifier nothing downstream reads is decoration.
//
// Driven through the quote seam production loads through, so this checks the CONSUMER: an
// overage fee must not be listed as something an operator has to go and resolve, while a
// genuinely unanswered charge must still be.
// ---------------------------------------------------------------------------
console.log("\n3. THE CONSUMERS ACTUALLY SKIP IT");
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-overage-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "t.sqlite");
  process.env.BACKUP_DIR = path.join(dir, "backups");
  process.env.SEED_TEST_INSTALLER = "false";
  process.env.AUTOPILOT_AUTO_START = "0";

  const { openDatabase } = await import("../src/db");
  const { createClient } = await import("../src/clients");
  const { buildProjectFeeSheet, registerFeeScheduleLookup } = await import("../src/submissionFees");
  const db = await openDatabase();
  const client = createClient(db, { companyName: "Overage Solar", billingMode: "monthly" });
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
     VALUES ('ov-1', ?, 'Overage Owner', 'OR', 'City of Portland', 'PGE', 7.5, 6, 'ready_to_stage', '{}', ?, ?)`,
    [client.id, now, now],
  );
  const project = {
    id: "ov-1", clientId: client.id, state: "OR", ahj: "City of Portland", utility: "PGE",
    systemSizeDcKw: 7.5, systemSizeAcKw: 6, totalExportKw: null, parserSnapshot: {},
  } as never;

  registerFeeScheduleLookup(((_db: unknown, _p: unknown, track: string) => (track !== "permit" ? null : {
    feeUsd: 592.08,
    bracketLabel: "structural",
    bracketQuote: "structural",
    sourceUrl: "https://www.portland.gov/ppd/documents/building-and-other-permits-fee-schedule",
    sourceQuote: "Portland Permitting & Development",
    confidence: "seeded",
    corroborated: false,
    matchedName: "City of Portland",
    reason: "",
    charges: [
      { label: "Renewable structural permit", kind: "permit", amountUsd: 592.08, partOfLineFee: true, conditional: false, reason: "", quote: "", sourceUrl: "" },
      { label: "Plan Review/Process Fee", kind: "plan_review", amountUsd: 384.85, partOfLineFee: false, conditional: false, reason: "", quote: "", sourceUrl: "" },
      { label: "Reinspection Fee - fee charged per inspection", kind: "other", amountUsd: null, partOfLineFee: false, conditional: true, futureContingent: true, reason: "NOT PART OF THIS QUOTE — charged only if it happens.", quote: "", sourceUrl: "" },
      { label: "Fire - Plan Review", kind: "fire_review", amountUsd: null, partOfLineFee: false, conditional: true, reason: "CONDITIONAL CHARGE UNRESOLVED — confirm whether this filing incurs it.", quote: "", sourceUrl: "" },
    ],
  })) as never);

  const sheet = buildProjectFeeSheet(db, project);
  const joined = sheet.unknowns.join(" || ");
  check("3a. the OVERAGE fee is not something an operator is sent to resolve",
    !/Reinspection/i.test(joined), joined.slice(0, 200));
  check("3b. MUST PASS: the genuinely unanswered review still IS",
    /Fire - Plan Review/i.test(joined), joined.slice(0, 200) || "(unknowns empty)");
  const perm = sheet.lines.find((l) => l.track === "permit");
  check("3c. and the overage charge is still LISTED, so its price is visible",
    (perm?.charges ?? []).some((c) => /Reinspection/i.test(c.label) && c.futureContingent === true),
    JSON.stringify((perm?.charges ?? []).map((c) => `${c.label}:${String(c.futureContingent)}`)));

  registerFeeScheduleLookup(null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\nfeeOverageCharges: ${failures} check(s) FAILED` : "\nfeeOverageCharges: all checks passed");
if (failures) process.exit(1);
