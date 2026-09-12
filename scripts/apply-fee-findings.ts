// APPLY THE FINDINGS A PERSON HAS READ — exactly those, and nothing else.
//
//   npx tsx scripts/apply-fee-findings.ts <findings.json> --db backend/data/autopilot.sqlite
//   npx tsx scripts/apply-fee-findings.ts <findings.json> --db <path> --dry-run
//
// scripts/research-fee-schedules.ts runs against a COPY and writes a findings file. This
// replays that file into a database named explicitly. The two halves are separate on purpose:
// re-running research against the live database would spend fresh LLM calls and apply
// whatever THOSE returned, which is not what anybody read and approved. The unit of approval
// is a finding, so the unit of application is a finding.
//
// --db IS REQUIRED. No default, not even the obvious one: this writes fee rows that end up in
// front of a customer, and it must be impossible to do that by forgetting a flag.
//
// EVERY GUARANTEE STILL BELONGS TO saveFeeSchedule, which this calls rather than reimplements:
//   · no source URL and no source quote means nothing is stored;
//   · everything lands 'seeded' — research never promotes itself (hard rule 3);
//   · a human-verified row is NEVER overwritten. The finding goes to that row's notes and the
//     row does not move, so the disagreement is visible instead of silent.
// This script adds one rule of its own: a finding whose quote was not found in bytes the
// researcher retrieved is REPORTED as such before it is applied, because an unchecked quote
// and a checked one are indistinguishable once they are both sitting in a fee field.
import fs from "node:fs";
import path from "node:path";

interface StoredFinding {
  state: string; ahj: string; utility: string; track: "permit" | "nem";
  finding: {
    found: boolean; reason: string; basis: string; brackets: Array<Record<string, unknown>>;
    notes: string; paymentMethod?: string; sourceUrl: string; sourceQuote: string; sourceKind: string;
    quoteVerified?: boolean; neededBrowser?: boolean;
  } | null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3).trim();
    const at = args.indexOf(`--${name}`);
    if (at >= 0) { const next = args[at + 1]; if (next && !next.startsWith("--")) return next.trim(); }
    return "";
  };
  const file = args.find((a) => !a.startsWith("--") && a !== flag("db")) || "";
  const dbPath = flag("db");
  const dryRun = args.includes("--dry-run");

  if (!file || !dbPath) {
    console.error(
      "Usage: npx tsx scripts/apply-fee-findings.ts <findings.json> --db <path> [--dry-run]\n\n"
      + "  Both are required. The findings file comes from:\n"
      + "    npx tsx scripts/research-fee-schedules.ts --db <a copy> --out findings.json\n",
    );
    process.exit(1);
  }
  if (!fs.existsSync(file)) { console.error(`No such findings file: ${path.resolve(file)}`); process.exit(1); }

  await import("dotenv/config");
  process.env.AUTOPILOT_DB_PATH = dbPath;
  const { openDatabase } = await import("../backend/src/db");
  const { saveFeeSchedule, getFeeSchedule, feeScheduleProfileKey } = await import("../backend/src/feeSchedules");
  const db = await openDatabase();

  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { generatedAt?: string; database?: string; findings?: StoredFinding[] };
  const rows = Array.isArray(parsed.findings) ? parsed.findings : [];
  console.log(`\n  findings file: ${path.resolve(file)}`);
  console.log(`  researched:    ${parsed.generatedAt || "(undated)"} against ${parsed.database || "(unnamed database)"}`);
  console.log(`  applying to:   ${dbPath}${dryRun ? "   (--dry-run: nothing will be written)" : ""}\n`);

  let applied = 0; let refused = 0; let skipped = 0;
  for (const row of rows) {
    const who = row.track === "nem" ? row.utility : row.ahj;
    const f = row.finding;
    if (!f || !f.found) { console.log(`  skip    ${row.track.padEnd(7)} ${row.state} ${who} — research found nothing to store.`); skipped++; continue; }

    const key = feeScheduleProfileKey(row, row.track);
    const existing = getFeeSchedule(db, key, row.track);
    const head = `${row.track.padEnd(7)} ${row.state} ${who}`;
    const fees = f.brackets.map((b) => `$${Number(b.feeUsd).toFixed(2)}`).join(" / ");
    console.log(`  ${head}`);
    console.log(`      ${f.basis}, ${f.brackets.length} line(s): ${fees}   payment ${f.paymentMethod || "unknown"}`);
    console.log(`      ${f.sourceUrl}`);
    if (f.quoteVerified === false) {
      console.log("      ⚠ THE QUOTE WAS NOT FOUND in any document the researcher retrieved. Check it by hand.");
    }
    if (existing?.confidence === "verified") {
      console.log("      a human has verified this row — it will not be overwritten; the finding goes to its notes.");
    }
    if (dryRun) { console.log("      (dry run)"); continue; }

    const outcome = saveFeeSchedule(
      db,
      { state: row.state, ahj: row.ahj, utility: row.utility, track: row.track },
      {
        found: true, reason: "", basis: f.basis as never, brackets: f.brackets as never,
        notes: f.notes, paymentMethod: f.paymentMethod, sourceUrl: f.sourceUrl,
        sourceQuote: f.sourceQuote, sourceKind: f.sourceKind,
      },
    );
    if (outcome.saved) { applied++; console.log("      saved as SEEDED."); }
    else if (outcome.refusedVerified) { refused++; console.log("      refused (human-verified) — finding recorded in notes."); }
    else { skipped++; console.log(`      not saved: ${outcome.reason}`); }
  }

  console.log(`\n  ${applied} applied, ${refused} refused against a human-verified row, ${skipped} skipped.`);
  console.log("  Everything applied is SEEDED. Promote a row only after a person has read the");
  console.log("  jurisdiction's own published page:  markFeeScheduleVerified(db, key, track, who).\n");
  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
