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
//
// CORROBORATION IS NOT REPLAYABLE, AND THIS IS THE PATH THAT PROVED IT.
// A bracket's `corroboration` means "a machine fetched the cited document and found THIS
// row's label and fee printed together on one line". This script fetches nothing. It reads a
// JSON file — an ordinary text file a person can open in an editor — so anything it forwarded
// would be a corroboration claim asserted BY HAND, and it would then be printed beside the
// amount as that amount's evidence. saveFeeSchedule now refuses to store corroboration unless
// the caller hands over the retrieval ledger it was derived from, which a file replay cannot
// produce; this script hands over none, so applied brackets land UNCORROBORATED. That is a
// real loss and it is announced, not swallowed: the count is printed before anything is
// written, and the research run's own "CORROBORATED n/m" note segment is dropped rather than
// carried onto a row whose brackets no longer say that. Re-corroborating an applied row means
// re-reading the document, which is researchFeeSchedule's job, not this script's.
//
// A FINDING WITH NO DISCIPLINE IS REFUSED WHERE THE JURISDICTION FILES SEPARATE PERMITS.
// fee_schedules is keyed (profile_key, track, DISCIPLINE) and "" is not a wildcard — it is
// the undifferentiated row, which feeSchedules.applicableSchedules returns ALONE, ignoring
// every split row beside it. The findings file never carried a discipline, so a replay for
// a city that files structural and electrical separately quietly demoted both to
// unreachable: measured on a copy of the live database, Christopher Ivy's Coos Bay permit
// total went $335.00 -> $200.00 and the county's $135.00 electrical permit left the quote
// with nothing printed anywhere. A findings ROW may now carry "discipline"; one that does
// not, aimed at a key that already holds split rows, writes nothing and prints the repair.
//
// --resolve-conflicts IS THE HUMAN GESTURE THAT CLOSES AN UNRESOLVED FEE CONFLICT.
// A conflicted row holds two contradictory published tables and refuses to price anything
// until somebody picks one; saveFeeSchedule refuses every ordinary write over it, including
// the automated research pass, precisely so that a later pass returning ONE of the two
// numbers cannot answer the question by winning the race. Passing this flag says a person
// read both candidates and chose. It is a separate flag for the same reason --db is
// required with no default: it must be impossible to do by forgetting one. Every conflicted
// row it is about to overwrite is printed, with both candidates, before anything is written.
import fs from "node:fs";
import path from "node:path";

interface StoredFinding {
  state: string; ahj: string; utility: string; track: "permit" | "nem";
  /** WHICH PERMIT THIS IS, and the findings file had no way to say it.
   *  fee_schedules is keyed (profile_key, track, DISCIPLINE), and an empty
   *  discipline is not "any" — it is its own row, the undifferentiated one, which
   *  applicableSchedules() treats as the WHOLE answer for the jurisdiction. See
   *  the guard in main() for the measured consequence. Optional because every
   *  findings file written before this line lacks it; blank is refused rather
   *  than guessed wherever guessing would cost a permit. */
  discipline?: string;
  finding: {
    found: boolean; reason: string; basis: string; brackets: Array<Record<string, unknown>>;
    notes: string; paymentMethod?: string; sourceUrl: string; sourceQuote: string; sourceKind: string;
    quoteVerified?: boolean; neededBrowser?: boolean;
  } | null;
}

/** Would this have been STORED as corroboration had the path been trusted?
 *  Deliberately the same shape normalizeCorroboration accepts (true + a matched
 *  line + a URL), so the count printed below is the count of claims that would
 *  otherwise have reached a fee field — not every stray `corroboration` key. */
function isCorroborationClaim(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const c = raw as Record<string, unknown>;
  return c.corroborated === true && !!String(c.matchedLine ?? "").trim() && !!String(c.sourceUrl ?? "").trim();
}

// KB/fee notes are " | "-joined SEGMENTS (feeSchedules.mergeNotes), so a stale
// claim is removed by segment, never by rewriting the blob.
const CORROBORATED_SEGMENT = /^CORROBORATED\s+\d/i;

/** Drop the research run's "CORROBORATED n/m bracket(s)…" segment on the way in.
 *  It was true of the row that run wrote against its own copy of the database;
 *  it is NOT true of the row this script is about to write, whose brackets carry
 *  no corroboration at all. A sentence in notes that contradicts the field next
 *  to it is exactly how a machine check gets read as a human one. The negative
 *  segment ("NO BRACKET CORROBORATED…") is kept — it is still accurate. */
function notesWithoutStaleCorroboration(notes: string, claimed: boolean): string {
  const segments = String(notes ?? "").split(" | ").map((s) => s.trim()).filter(Boolean)
    .filter((s) => !CORROBORATED_SEGMENT.test(s));
  if (claimed) {
    segments.push(
      "APPLIED FROM A FINDINGS FILE: the corroboration recorded by the research run was NOT re-checked "
      + "by this process (it fetched no document), so these brackets are stored uncorroborated.",
    );
  }
  return segments.join(" | ");
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
  const resolveConflicts = args.includes("--resolve-conflicts");

  if (!file || !dbPath) {
    console.error(
      "Usage: npx tsx scripts/apply-fee-findings.ts <findings.json> --db <path> [--dry-run] [--resolve-conflicts]\n\n"
      + "  The file and --db are required. The findings file comes from:\n"
      + "    npx tsx scripts/research-fee-schedules.ts --db <a copy> --out findings.json\n\n"
      + "  --resolve-conflicts  overwrite rows holding an UNRESOLVED FEE CONFLICT. Only pass it\n"
      + "                       when you have read both candidates and picked; without it such a\n"
      + "                       row refuses the write and keeps refusing to price a job.\n",
    );
    process.exit(1);
  }
  if (!fs.existsSync(file)) { console.error(`No such findings file: ${path.resolve(file)}`); process.exit(1); }

  await import("dotenv/config");
  process.env.AUTOPILOT_DB_PATH = dbPath;
  const { openDatabase } = await import("../backend/src/db");
  const {
    saveFeeSchedule, getFeeSchedule, getFeeSchedulesForKey, feeScheduleProfileKey,
    feeDiscipline, conflictSummary,
  } = await import("../backend/src/feeSchedules");
  const db = await openDatabase();

  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { generatedAt?: string; database?: string; findings?: StoredFinding[] };
  const rows = Array.isArray(parsed.findings) ? parsed.findings : [];
  console.log(`\n  findings file: ${path.resolve(file)}`);
  console.log(`  researched:    ${parsed.generatedAt || "(undated)"} against ${parsed.database || "(unnamed database)"}`);
  console.log(`  applying to:   ${dbPath}${dryRun ? "   (--dry-run: nothing will be written)" : ""}\n`);

  let applied = 0; let refused = 0; let skipped = 0; let shadowing = 0;
  for (const row of rows) {
    const who = row.track === "nem" ? row.utility : row.ahj;
    const f = row.finding;
    if (!f || !f.found) { console.log(`  skip    ${row.track.padEnd(7)} ${row.state} ${who} — research found nothing to store.`); skipped++; continue; }

    const key = feeScheduleProfileKey(row, row.track);
    const discipline = feeDiscipline(row.discipline);
    // Asked for at the row's OWN grain. Looking the existing row up without the
    // discipline would report a human-verified ELECTRICAL row as absent while
    // writing a structural one, and the two guards below would then be answering
    // about a row nobody was touching.
    const existing = getFeeSchedule(db, key, row.track, discipline);
    const head = `${row.track.padEnd(7)} ${row.state} ${who}`;
    const fees = f.brackets.map((b) => `$${Number(b.feeUsd).toFixed(2)}`).join(" / ");
    console.log(`  ${head}`);
    console.log(`      ${f.basis}, ${f.brackets.length} line(s): ${fees}   payment ${f.paymentMethod || "unknown"}`);
    console.log(`      ${f.sourceUrl}`);
    if (f.quoteVerified === false) {
      console.log("      ⚠ THE QUOTE WAS NOT FOUND in any document the researcher retrieved. Check it by hand.");
    }
    // Printed BEFORE the dry-run bail: the dry run is what an operator reads to
    // decide, so it must show the same loss the real run will take. ASCII on
    // purpose — this line is asserted on in a spawned child's stdout.
    const claimedCorroborated = f.brackets.filter((b) => isCorroborationClaim(b?.corroboration)).length;
    if (claimedCorroborated) {
      console.log(`      NOTE: the file claims ${claimedCorroborated} corroborated bracket(s). CORROBORATION IS NOT REPLAYED`);
      console.log("            from a file - this process fetched no document - so these land UNCORROBORATED.");
    }
    if (existing?.confidence === "verified") {
      console.log("      a human has verified this row — it will not be overwritten; the finding goes to its notes.");
    }
    if (existing?.status === "conflicted") {
      // Printed whether or not the flag was passed: somebody running without it
      // should see what they would have been overwriting, and somebody running
      // with it should see it one last time before it goes.
      console.log(`      ⚠ UNRESOLVED FEE CONFLICT on this row — ${conflictSummary(existing)}`);
      console.log(resolveConflicts
        ? "        --resolve-conflicts was passed: this finding will REPLACE both candidates."
        : "        it will NOT be overwritten. Read both candidates; re-run with --resolve-conflicts to pick this one.");
    }
    console.log(`      discipline: ${discipline || "(none given — the undifferentiated row)"}`);
    // feeDiscipline() folds anything outside its enum to "" — silently, because
    // it normalises rows from a dozen producers. Here that silence would print
    // "add a discipline" at an operator who just did, so say which word was not
    // understood. Not a refusal on its own: "" is a legitimate answer, and the
    // guard below decides whether it is a safe one HERE.
    const rawDiscipline = String(row.discipline ?? "").trim();
    if (rawDiscipline && !discipline) {
      console.log(`      NOTE: "${rawDiscipline}" is not a discipline this table knows`
        + " (structural / electrical / combo) - it was read as none.");
    }

    // AN UNDIFFERENTIATED ROW IS NOT A NEUTRAL PLACE TO PUT A FEE — IT OUTRANKS
    // EVERY SPLIT ROW UNDER THE SAME KEY.
    //
    // feeSchedules.applicableSchedules: "An undifferentiated row answers for
    // everything and is the whole answer" — it returns that row ALONE and never
    // looks at the discipline rows beside it. The findings file has no discipline
    // field (scripts/research-fee-schedules.ts never wrote one), so every replay
    // landed on discipline "", and MEASURED on a copy of the live database that
    // is not a cosmetic duplicate:
    //
    //   before   Christopher Ivy, Coos Bay — permit total $335.00
    //            = Coos County ELECTRICAL $135.00 + City of Coos Bay STRUCTURAL $200.00
    //   after    an ordinary two-row findings file applied
    //   after    permit total $200.00 — ONE line, the electrical permit gone from
    //            the quote entirely. Both split rows still sat in the table,
    //            untouched and unreachable.
    //
    // $135 of a county permit disappearing from a customer's number with nothing
    // printed is the same class of silent wrongness as a frozen fee-bracket
    // quantity, so the replay refuses rather than guesses. It cannot infer the
    // discipline — a file saying "Coos County, permit, $135/$160/$265" is equally
    // the electrical table and a jurisdiction that publishes one schedule — and
    // picking wrong writes a real fee onto the wrong permit. Naming it is one word
    // in the file, so the repair is printed with the refusal.
    //
    // Printed BEFORE the dry-run bail, and refused on a dry run too: a dry run an
    // operator reads to decide must show the same outcome the real run will take.
    if (!discipline) {
      const split = getFeeSchedulesForKey(db, key, row.track).filter((r) => r.discipline);
      if (split.length) {
        shadowing++;
        console.log(`      REFUSED: ${who} already files this track as ${split.length} SEPARATE permit(s), and this`);
        console.log("               finding names no discipline. An undifferentiated row is not stored alongside");
        console.log("               them - it REPLACES them as the whole answer, so a permit would vanish from");
        console.log("               the quote with nothing printed. Nothing was written.");
        for (const s of split) {
          const lines = s.brackets.map((b) => `$${b.feeUsd.toFixed(2)}`).join(" / ") || "(no fee line)";
          console.log(`                 would have shadowed: discipline "${s.discipline}" (${s.confidence}) ${lines}`);
        }
        console.log(`               THE REPAIR: add "discipline": "${split[0].discipline}" (or the right one of `
          + `${split.map((s) => `"${s.discipline}"`).join(", ")}) to this findings row and re-run.`);
        continue;
      }
    }
    if (dryRun) { console.log("      (dry run)"); continue; }

    // NO LEDGER IS PASSED, and that is the guard: saveFeeSchedule strips every
    // corroboration claim on these brackets rather than trusting a file for it.
    const outcome = saveFeeSchedule(
      db,
      { state: row.state, ahj: row.ahj, utility: row.utility, track: row.track, discipline },
      {
        found: true, reason: "", basis: f.basis as never, brackets: f.brackets as never,
        notes: notesWithoutStaleCorroboration(f.notes, claimedCorroborated > 0),
        paymentMethod: f.paymentMethod, sourceUrl: f.sourceUrl,
        sourceQuote: f.sourceQuote, sourceKind: f.sourceKind,
        resolvesConflict: resolveConflicts,
      },
    );
    if (outcome.saved) { applied++; console.log("      saved as SEEDED."); }
    else if (outcome.refusedVerified) { refused++; console.log("      refused (human-verified) — finding recorded in notes."); }
    else if (outcome.refusedConflicted) { refused++; console.log("      refused (unresolved conflict) — finding recorded in notes."); }
    else { skipped++; console.log(`      not saved: ${outcome.reason}`); }
  }

  console.log(`\n  ${applied} applied, ${refused} refused against a human-verified row, ${skipped} skipped`
    + `${shadowing ? `, ${shadowing} REFUSED for naming no discipline against a split-permit jurisdiction` : ""}.`);
  if (shadowing) {
    console.log(`  Those ${shadowing} finding(s) wrote NOTHING. Add a "discipline" to each and re-run — see the`);
    console.log("  repair printed beside each one. This is not a warning you can apply through.");
  }
  console.log("  Everything applied is SEEDED. Promote a row only after a person has read the");
  console.log("  jurisdiction's own published page:  markFeeScheduleVerified(db, key, track, who).\n");
  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
