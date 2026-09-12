// RUN THE FEE RESEARCHER AT REAL JURISDICTIONS, AND WRITE DOWN WHAT IT ACTUALLY READ.
//
//   npx tsx scripts/research-fee-schedules.ts --db <path> [--out findings.json]
//   npx tsx scripts/research-fee-schedules.ts --db <path> --only "coos county"
//   npx tsx scripts/research-fee-schedules.ts --db <path> --list
//
// --db IS REQUIRED AND HAS NO DEFAULT. Every other script in this directory falls back to
// backend/data/autopilot.sqlite, which is right for a seed the operator asked for and wrong
// for this: a research pass spends LLM calls, opens browser windows and overwrites seeded
// rows, and it must not be possible to do that to the live database by forgetting a flag.
// Point it at a COPY, read the report, and apply what you believe with
// scripts/apply-fee-findings.ts.
//
// WHY THIS IS NOT `fee-sheet --research`: that flag deliberately SKIPS any jurisdiction that
// already has a schedule row, because re-researching a stored schedule spends a call to learn
// what is already on file. That is the right rule for pricing a project and the wrong one for
// measuring the researcher — the two jurisdictions worth checking hardest are exactly the two
// a human has already answered by hand, since agreement or disagreement with a known-good row
// is the only evidence we have about whether the researcher can be trusted anywhere else.
//
// WHAT IT RECORDS, per jurisdiction, is more than the fee:
//   · the row BEFORE and AFTER, so agreement with a hand-entered answer is visible;
//   · every document the researcher actually retrieved, and whether a HEADED BROWSER was
//     needed to get it (a site that 403s every script is a fact about that jurisdiction that
//     the next person to look will otherwise rediscover from scratch);
//   · whether the stored quote appears, character for character, in bytes we retrieved.
//     A fee whose quote is in nothing we read is the exact shape a hallucinated fee has.
//
// The findings JSON it writes is a REPLAY ARTIFACT, not a log. apply-fee-findings.ts applies
// exactly the findings printed in the report — re-running research against the live database
// would apply different findings than the ones a person read and approved.
import fs from "node:fs";
import path from "node:path";
import type { FeeScheduleFinding, FeeScheduleRecord, FeeTrack, FeeDocumentLedger } from "../backend/src/feeSchedules";

export interface HarvestTarget {
  state: string;
  ahj?: string;
  utility?: string;
  track: FeeTrack;
  /** Why this jurisdiction is on the list — printed, so the run explains itself. */
  why: string;
}

/** The jurisdictions this build actually files in: every complete portal recipe, plus the
 *  county the City of Coos Bay's own schedule points at for the electrical permit. */
export const DEFAULT_TARGETS: HarvestTarget[] = [
  {
    state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", track: "permit",
    why: "Complete Accela recipe (structural + electrical). A human has already read this one by hand — agreement or disagreement is the measurement.",
  },
  {
    state: "OR", ahj: "Coos County", track: "permit",
    why: "THE HEADLINE. The City's schedule says a separate Electrical Permit 'may also be required through the county', and the county's bracketed renewable-energy line is the table Coos Bay's recipe freezes as a literal '1'.",
  },
  {
    state: "IL", utility: "Ameren Illinois", ahj: "City of Springfield", track: "nem",
    why: "Complete PowerClerk recipe. Known good: $50 Level 1 — and a MAILED CHECK within 15 business days, which earlier research dropped.",
  },
  {
    state: "OR", utility: "Pacific Power", ahj: "City of Coos Bay", track: "nem",
    why: "Complete recipe. A sourced $0 is the expected answer (OAR 860-039-0045) and is a real finding, not a gap.",
  },
  {
    state: "OR", utility: "Portland General Electric", ahj: "City of Salem", track: "nem",
    why: "Complete recipe. Same expectation as Pacific Power, and a second reading of the same state rule.",
  },
  {
    state: "IL", utility: "Commonwealth Edison (ComEd)", ahj: "City of Evanston", track: "nem",
    why: "A real project's utility; its recipe needs re-recording but the fee is a fee either way.",
  },
];

/** A schedule row flattened for the report and for replay. */
function summarise(row: FeeScheduleRecord | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    basis: row.basis,
    confidence: row.confidence,
    paymentMethod: row.paymentMethod,
    brackets: row.brackets.map((b) => ({ minKw: b.minKw, maxKw: b.maxKw, feeUsd: b.feeUsd, label: b.label })),
    sourceUrl: row.sourceUrl,
    sourceQuote: row.sourceQuote,
    sourceKind: row.sourceKind,
  };
}

const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return ""; } };

/** Is the host the jurisdiction's/utility's OWN domain, a state's, or somebody's blog?
 *  Advisory only — it is printed, never used to refuse a finding. A state rule on
 *  oregon.gov is the right source for "the utility may not charge for this" and is not
 *  the utility's own domain. */
export function classifyHost(host: string): string {
  const h = host.toLowerCase();
  if (!h) return "no url";
  if (/\.gov$|\.us$|\.gov\.[a-z]{2}$/.test(h)) return "government domain";
  if (/\.org$/.test(h)) return "org domain";
  if (/\.com$/.test(h)) return "commercial domain (a utility's own site is one — check the name)";
  return "other";
}

const bar = (s: string): string => `\n${s}\n${"─".repeat(Math.min(96, s.length + 8))}`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3).trim();
    const at = args.indexOf(`--${name}`);
    if (at >= 0) { const next = args[at + 1]; if (next && !next.startsWith("--")) return next.trim(); }
    return "";
  };

  if (args.includes("--list")) {
    for (const t of DEFAULT_TARGETS) console.log(`${t.track.padEnd(7)} ${t.state}  ${t.track === "nem" ? t.utility : t.ahj}\n        ${t.why}`);
    return;
  }

  const dbPath = flag("db");
  if (!dbPath) {
    console.error(
      "--db is required and has no default.\n\n"
      + "  This spends LLM calls, opens browser windows, and overwrites 'seeded' rows. Point it\n"
      + "  at a COPY of the database, never the live one:\n\n"
      + "    cp backend/data/autopilot.sqlite /tmp/scratch.sqlite\n"
      + "    npx tsx scripts/research-fee-schedules.ts --db /tmp/scratch.sqlite --out findings.json\n\n"
      + "  Then read the report and apply what you believe:\n"
      + "    npx tsx scripts/apply-fee-findings.ts findings.json --db backend/data/autopilot.sqlite\n",
    );
    process.exit(1);
  }
  const only = flag("only").toLowerCase();
  const outPath = flag("out");

  await import("dotenv/config");
  process.env.AUTOPILOT_DB_PATH = dbPath;
  // A tool loop that opens documents outlasts a single chat turn by a wide margin, and a
  // clock that runs out comes back on the SAME channel as "this jurisdiction publishes
  // nothing". Give a harvest room, and say what was given.
  if (!process.env.FEE_RESEARCH_TIMEOUT_MS) process.env.FEE_RESEARCH_TIMEOUT_MS = "600000";

  const { openDatabase } = await import("../backend/src/db");
  const {
    researchFeeSchedule, getFeeSchedule, feeScheduleProfileKey, newFeeDocumentLedger,
  } = await import("../backend/src/feeSchedules");
  const db = await openDatabase();

  const targets = DEFAULT_TARGETS.filter(
    (t) => !only || `${t.state} ${t.ahj || ""} ${t.utility || ""}`.toLowerCase().includes(only),
  );
  if (!targets.length) { console.error(`Nothing matches --only "${only}".`); process.exit(1); }

  console.log(`Database: ${dbPath}`);
  console.log(`Research ceiling: ${Number(process.env.FEE_RESEARCH_TIMEOUT_MS) / 1000}s per jurisdiction.`);
  console.log(`${targets.length} jurisdiction(s). Each spends one web-grounded LLM call and may open a real browser window.`);

  const findings: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    const who = target.track === "nem" ? target.utility : target.ahj;
    const key = feeScheduleProfileKey(target, target.track);
    const before = getFeeSchedule(db, key, target.track);
    console.log(bar(`${target.track.toUpperCase()}  ${target.state}  ${who}`));
    console.log(`  why: ${target.why}`);
    console.log(`  before: ${before ? `${before.confidence}, basis ${before.basis}, ${before.brackets.length} bracket(s), ${before.sourceUrl || "no url"}` : "(no row)"}`);

    const ledger: FeeDocumentLedger = newFeeDocumentLedger();
    const startedAt = Date.now();
    const outcome = await researchFeeSchedule(db, target, { ledger });
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const finding: FeeScheduleFinding | null = outcome.finding;
    const after = getFeeSchedule(db, key, target.track);

    console.log(`  ran ${seconds}s — found=${outcome.found} saved=${outcome.saved}${outcome.refusedVerified ? " REFUSED (row is human-verified)" : ""}`);
    if (outcome.reason) console.log(`  reason: ${outcome.reason}`);
    console.log(`  documents opened: ${ledger.evidence.length}${ledger.evidence.some((e) => e.via === "browser") ? "  ← a HEADED BROWSER was needed" : ""}`);
    for (const e of ledger.evidence) console.log(`      ${e.via.padEnd(7)} ${String(e.status).padEnd(4)} ${e.kind.padEnd(5)} ${e.bytes} bytes  ${e.url}`);
    if (finding?.found) {
      console.log(`  basis: ${finding.basis}   payment: ${finding.paymentMethod || "unknown"}   sourceKind: ${finding.sourceKind || "(unset)"}`);
      console.log(`  host: ${hostOf(finding.sourceUrl)}  (${classifyHost(hostOf(finding.sourceUrl))})`);
      for (const b of finding.brackets) {
        const range = b.minKw != null || b.maxKw != null
          ? `${b.minKw ?? 0}–${b.maxKw ?? "∞"} kVA`
          : b.minValuationUsd != null || b.maxValuationUsd != null ? `$${b.minValuationUsd ?? 0}–${b.maxValuationUsd ?? "∞"}` : "flat";
        console.log(`      ${range.padEnd(18)} $${b.feeUsd.toFixed(2)}   ${b.label || ""}`);
      }
      console.log(`  QUOTE: "${finding.sourceQuote}"`);
      console.log(`  quote found in retrieved bytes: ${finding.quoteVerified ? "YES" : "NO — treat this number as unchecked"}`);
    }

    findings.push({
      state: target.state, ahj: target.ahj || "", utility: target.utility || "", track: target.track,
      why: target.why, seconds,
      outcome: { found: outcome.found, saved: outcome.saved, refusedVerified: outcome.refusedVerified, reason: outcome.reason },
      finding: finding && {
        found: finding.found, reason: finding.reason, basis: finding.basis, brackets: finding.brackets,
        notes: finding.notes, paymentMethod: finding.paymentMethod || "unknown",
        sourceUrl: finding.sourceUrl, sourceQuote: finding.sourceQuote, sourceKind: finding.sourceKind,
        quoteVerified: finding.quoteVerified === true, neededBrowser: finding.neededBrowser === true,
      },
      evidence: ledger.evidence,
      before: summarise(before),
      after: summarise(after),
    });

    if (outPath) fs.writeFileSync(path.resolve(outPath), JSON.stringify({ generatedAt: new Date().toISOString(), database: dbPath, findings }, null, 2));
  }

  if (outPath) {
    console.log(bar("WRITTEN"));
    console.log(`  ${path.resolve(outPath)}`);
    console.log("  Read the report above, then apply what you believe to the live database:");
    console.log(`    npx tsx scripts/apply-fee-findings.ts ${outPath} --db backend/data/autopilot.sqlite`);
  }
  console.log("\n  Everything stored here is SEEDED. Nobody has checked it. Verify against the");
  console.log("  jurisdiction's own page before quoting a customer, then promote it by hand.\n");
  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
