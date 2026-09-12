// WHAT THIS JOB COSTS, WHERE THAT NUMBER CAME FROM, AND WHO IS SUPPOSED TO PAY IT.
//
//   npx tsx scripts/fee-sheet.ts --project <id-or-homeowner-name>
//   npx tsx scripts/fee-sheet.ts --client <id>                  every OPEN project
//   npx tsx scripts/fee-sheet.ts --project <id> --json          the structure, for a paste
//   npx tsx scripts/fee-sheet.ts --project <id> --research      look a missing schedule up
//   npx tsx scripts/fee-sheet.ts --project <id> --db backend/data/copy.sqlite
//
// THE POINT IS THE BRACKET, NOT ONLY THE TOTAL. Coos Bay's recorded Accela application fills a
// line item labelled "Renewable energy for electrical systems- 5.01kva through 15kva" with a
// quantity frozen from the project the recipe was learned on. Replay a 20 kW job through it
// and the city bills the 5.01–15 kVA bracket — the wrong one, quietly, on a real filing.
// A recipe cannot compute a field nobody has written the schedule for. Knowing the schedule is
// what turns that frozen literal into a computed one, which is why every line below prints the
// bracket the job fell in and what matched it, and not only a dollar amount.
//
// EVERY LINE CARRIES ITS PROVENANCE, because somebody is going to quote a customer off this
// output. A number with no source is worse than no number: nothing on screen separates a fee
// read off the portal's own review screen from 1.5% of an estimated valuation, and both print
// as money. So each line names its source, its confidence and its payment method, and where
// there is no number it says UNKNOWN and what would produce one. An unknown NEVER prints as
// $0.00 — zero is an answer ("this utility charges nothing for residential NEM"), unknown is
// the absence of one, and the difference is a customer's invoice.
//
// WHO PAYS IS PART OF THE FEE. The onboarding guide (S3.7) promises fee responsibility is
// agreed PER PORTAL at kickoff — "a payment method on file in your portal account, or a person
// on your side completing payment; mailed-check fees are yours to send" — and that agreement
// lives on each credential as `fee_responsibility`. This sheet is where the promise becomes
// concrete: the agreement prints beside the amount, and prints NOT AGREED when nobody made
// one. Recording an agreement authorises nothing. Automation never pays a portal fee under any
// value of that column (hard safety rule 1); the money is always moved by a person.
//
// READ-ONLY, AND IT TAKES WORK TO BE. `buildProjectFeeSheet` is built from FRESH quotes, and
// `buildPaymentQuote` persists a `submission_payments` row every time it is called — which is
// right for the payment screen and wrong for a report, because a report that writes to the
// thing it reports on cannot be run twice with confidence. So the sheet is built inside a
// transaction this file deliberately ROLLS BACK: the numbers are computed by exactly the
// production code path, and nothing it wrote survives. The published-schedule detail
// (`feeForProject`) writes nothing to begin with.
//
// The one exception is `--research`, a deliberate write and never implied by another flag: it
// spends an LLM call per jurisdiction that has no schedule at all, and lands what it finds as
// `seeded` — researched, unverified, and not safe to quote a customer from until a person has
// checked it against the jurisdiction's own published page. It cannot overwrite a
// human-verified row (`saveFeeSchedule` refuses, and files the finding in the notes instead).
//
// "Read-only" is also not true of a RUN, and the distinction matters before you quote it:
// `openDatabase()` calls `seedInitialKnowledgeBase()` on every open (backend/src/db.ts), which
// bumps `updated_at` on a few hundred knowledge rows without changing their content. If those
// timestamps must not move, point `--db` at a copy.
//
// NEVER PRINTS A SECRET: no password, no encrypted blob, no account or meter number. A portal
// appears as its host, and nothing here decrypts anything.
//
// The same structure is served by `GET /api/projects/:id/fee-sheet` and drawn by the
// dashboard's fee panel, so the CLI, the API and the screen cannot disagree about a fee.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDb } from "../backend/src/db";
import type { ProjectFeeSheet, ProjectFeeSheetLine, ProjectRecord } from "../shared/src/types";
import { buildProjectFeeSheet } from "../backend/src/submissionFees";
import { feeForProject, findFeeScheduleForProject } from "../backend/src/feeSchedules";
import type { ProjectFeeResolution } from "../backend/src/feeSchedules";
import { listPortalCredentials } from "../backend/src/portalCredentials";
import { resolveTrack, matchCredential, hostOf } from "./coverage-report";

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export type FeeTrack = "permit" | "nem";
export const FEE_TRACKS: FeeTrack[] = ["permit", "nem"];

/** Statuses whose filings are done paying; everything else is an OPEN project for `--client`.
 *  Deliberately narrow — "approved"/"nem_approved" close the NEM side while the permit may
 *  still be unfiled, so they stay open here. `--all` includes the closed ones anyway. */
export const CLOSED_STATUSES = new Set(["issued", "handoff_ready"]);

/** The kickoff fee agreement for one track, joined in by this layer: the engine's sheet says
 *  HOW a fee is paid (portal / mailed check), the credential says WHO agreed to pay it. */
export interface TrackAgreement {
  /** '' | 'card-on-file' | 'customer-pays' | 'mailed-check' | 'keelix-pays'. '' = NOT AGREED. */
  whoPays: string;
  /** The portal where that money actually changes hands, by host. */
  portalHost: string;
}

export interface FeeSheetPresentation {
  project: { id: string; homeownerName: string; state: string; ahj: string; utility: string; status: string };
  /** Exactly what `GET /api/projects/:id/fee-sheet` returns and the dashboard draws. */
  sheet: ProjectFeeSheet;
  /** Per track, the published schedule line behind the number — read-only, and the only
   *  place the jurisdiction's own wording appears. Null when no schedule is stored. */
  schedules: Record<FeeTrack, ProjectFeeResolution | null>;
  agreements: Record<FeeTrack, TrackAgreement>;
}

// ---------------------------------------------------------------------------------------
// Who pays this portal's fees (guide S3.7).
// ---------------------------------------------------------------------------------------

const FEE_RESPONSIBILITY_PROSE: Record<string, string> = {
  "card-on-file": "a payment method on file in the customer's own portal account",
  "customer-pays": "a person on the customer's side completes the payment",
  "mailed-check": "the customer mails a paper check — there is nothing online to complete",
  "keelix-pays": "we pay it and re-bill; still a person, never automation",
};

export function feeResponsibilityProse(value: string): string {
  const v = s(value).trim();
  if (!v) return "nobody has agreed this portal's fees yet (guide S3.7) — record it on the credential";
  return FEE_RESPONSIBILITY_PROSE[v] || v;
}

/** Found through the portal THIS TRACK would actually be filed in, resolved by the same
 *  track-scoped lookup production uses — so a permit track can never read a utility portal's
 *  agreement (safety rule 5, inherited from `resolveTrack`'s permit-safe URL filter). */
export function feeAgreementFor(db: AppDb, project: ProjectRecord, track: FeeTrack): TrackAgreement {
  if (!project.clientId) return { whoPays: "", portalHost: "" };
  const spec = {
    state: s(project.state),
    ahj: s(project.ahj) || s(project.city),
    utility: s(project.utility),
    discipline: s(project.permitType).toLowerCase() === "electrical" ? "electrical" : "",
    source: "project",
  };
  let portalUrl = "";
  try {
    portalUrl = s(resolveTrack(db, spec, track).portalUrl);
  } catch {
    portalUrl = ""; // a recipe lookup that cannot answer is not a reason to fail the report
  }
  if (!portalUrl) return { whoPays: "", portalHost: "" };
  const { row } = matchCredential(listPortalCredentials(db, project.clientId), portalUrl);
  return { whoPays: s(row?.feeResponsibility), portalHost: hostOf(portalUrl) };
}

// ---------------------------------------------------------------------------------------
// Building the sheet without writing.
// ---------------------------------------------------------------------------------------

/** Thrown to roll the reporting transaction back. Never escapes this file. */
const ROLLBACK = Symbol("fee-sheet read-only rollback");

/** Run `buildProjectFeeSheet` — the production path, quote-row writes and all — and then undo
 *  every write it made. A report must not create the `submission_payments` rows an operator
 *  has not asked for, and must not refresh the basis text on rows that already exist. */
export function buildProjectFeeSheetReadOnly(db: AppDb, project: ProjectRecord): ProjectFeeSheet {
  let sheet: ProjectFeeSheet | null = null;
  try {
    db.transaction(() => {
      sheet = buildProjectFeeSheet(db, project);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  if (!sheet) throw new Error("buildProjectFeeSheet produced nothing inside the reporting transaction.");
  return sheet;
}

export function buildFeeSheetPresentation(db: AppDb, project: ProjectRecord): FeeSheetPresentation {
  const sheet = buildProjectFeeSheetReadOnly(db, project);
  const schedules = {} as Record<FeeTrack, ProjectFeeResolution | null>;
  const agreements = {} as Record<FeeTrack, TrackAgreement>;
  for (const track of FEE_TRACKS) {
    schedules[track] = feeForProject(db, project, track);
    agreements[track] = feeAgreementFor(db, project, track);
  }
  return {
    project: {
      id: project.id,
      homeownerName: s(project.homeownerName),
      state: s(project.state),
      ahj: s(project.ahj),
      utility: s(project.utility),
      status: s(project.status),
    },
    sheet,
    schedules,
    agreements,
  };
}

// ---------------------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------------------

export function money(v: number | null | undefined): string {
  return v == null ? "UNKNOWN" : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Confidence is the field most likely to be skimmed, so it never prints as a bare word. */
export const CONFIDENCE_NOTE: Record<string, string> = {
  actual: "ACTUAL — the portal's own calculated fee, typed in by a person",
  verified: "VERIFIED — a person checked this against the published schedule",
  seeded: "SEEDED — researched, NOT YET CHECKED BY ANYONE. Verify before quoting a customer.",
  estimated: "ESTIMATED — a method, not a fact. Trued up from the portal's fee screen.",
  unknown: "UNKNOWN — there is no number here",
};

const SOURCE_NOTE: Record<string, string> = {
  actual: "the portal's fee screen, entered by the operator",
  published_schedule: "the jurisdiction's published fee schedule",
  learned_history: "the median of real fees we have seen here before",
  valuation_estimate: "a percentage of the project valuation",
  unknown: "nowhere yet",
};

const PAYMENT_METHOD_NOTE: Record<string, string> = {
  portal: "paid in the portal — by a person, at the portal's own checkout",
  mailed_check: "PAID BY MAILED PAPER CHECK — no portal can take it; somebody posts it",
  none: "no fee is charged, so there is nothing to pay",
  unknown: "how it is paid is not recorded",
};

const TRACK_LABEL: Record<FeeTrack, string> = { permit: "PERMIT (AHJ)", nem: "NEM (utility)" };

const BASIS_NOTE: Record<string, string> = {
  flat: "a flat fee — no bracket to fall in",
  system_kw: "matched on the system's kW rating",
  valuation: "matched on the project valuation",
  per_kw: "priced per kW of system",
  unknown: "the schedule does not say what it brackets on",
};

function wrap(text: string, width: number, pad: string): string {
  const words = s(text).split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const w of words) {
    if (current && current.length + w.length + 1 > width) { out.push(current); current = w; }
    else current = current ? `${current} ${w}` : w;
  }
  if (current) out.push(current);
  return out.join(`\n${pad}`);
}

export function renderFeeLine(
  line: ProjectFeeSheetLine,
  schedule: ProjectFeeResolution | null,
  agreement: TrackAgreement,
  billingRequired: boolean,
): string {
  const pad = "      ";
  const cont = pad + " ".repeat(14);
  const row = (label: string, value: string): string => `${pad}${label.padEnd(14)}${value}`;
  const out: string[] = [];
  const track = line.track as FeeTrack;
  out.push(`  ${TRACK_LABEL[track]}   ${line.jurisdiction || "(no jurisdiction on the project)"}`);
  out.push(row("Fee", money(line.feeUsd)));
  out.push(row("From", wrap(`${SOURCE_NOTE[line.source] || line.source} — ${line.basis}`, 64, cont)));
  out.push(row(
    "Bracket",
    line.bracketLabel
      ? `${line.bracketLabel}${schedule ? `   (${BASIS_NOTE[schedule.basis] || schedule.basis})` : ""}`
      : schedule
        ? "— the schedule is on file but no bracket matched this project"
        : "— no schedule on file, so no bracket was resolved",
  ));
  // The published sentence, but only when the engine's own basis text has not already
  // quoted it — the same sentence twice reads as two sources.
  if (schedule?.sourceQuote && !line.basis.includes(schedule.sourceQuote)) {
    out.push(row("As published", `"${wrap(schedule.sourceQuote, 62, cont)}"`));
  }
  if (schedule?.matchedName && line.jurisdiction && schedule.matchedName.toLowerCase() !== line.jurisdiction.toLowerCase()) {
    out.push(row("Filed under", `${schedule.matchedName}  (this project says "${line.jurisdiction}")`));
  }
  out.push(row("Schedule", line.sourceUrl || schedule?.sourceUrl || "— no source URL on file"));
  out.push(row("Confidence", CONFIDENCE_NOTE[line.confidence] || line.confidence));
  out.push(row("Who pays", agreement.whoPays || "NOT AGREED"));
  out.push(row("", wrap(feeResponsibilityProse(agreement.whoPays), 64, cont)));
  out.push(row("How", wrap(PAYMENT_METHOD_NOTE[line.paymentMethod] || line.paymentMethod, 64, cont)));
  if (agreement.portalHost) out.push(row("Portal", agreement.portalHost));
  out.push(row("Service fee", billingRequired ? money(line.serviceFeeUsd) : `${money(line.serviceFeeUsd)}  (not collected — this client is not billed per submission)`));
  out.push(row("Track total", money(line.totalUsd)));
  return out.join("\n");
}

export function renderFeeSheet(view: FeeSheetPresentation): string {
  const { project, sheet } = view;
  const out: string[] = [];
  const head = `${project.homeownerName || "(unnamed)"}  ${project.id.slice(0, 8)}  ${[project.state, project.ahj, project.utility].filter(Boolean).join(" | ")}  (${project.status})`;
  out.push("");
  out.push(`── ${head} ${"─".repeat(Math.max(0, 78 - head.length))}`);
  for (const line of sheet.lines) {
    out.push("");
    out.push(renderFeeLine(line, view.schedules[line.track as FeeTrack] ?? null, view.agreements[line.track as FeeTrack] ?? { whoPays: "", portalHost: "" }, sheet.billingRequired));
  }
  out.push("");
  out.push(`  JURISDICTION FEES   ${money(sheet.jurisdictionFeesUsd)}   (permit + NEM, owed to the AHJ and the utility)`);
  out.push(`  SERVICE FEES        ${money(sheet.serviceFeesUsd)}   (ours, ${sheet.billingRequired ? "per submission — two tracks, two fees" : `not collected: billing mode "${sheet.billingMode || "monthly/none"}"`})`);
  out.push(`  PROJECT TOTAL       ${money(sheet.totalUsd)}`);
  if (sheet.totalUsd == null) {
    out.push("  The total is UNKNOWN because at least one fee is. It is not a zero and it is not");
    out.push("  a partial sum — do not put a number in front of this customer yet.");
  }
  if (sheet.unknowns.length) {
    out.push("");
    out.push("  STILL UNKNOWN — what would resolve it:");
    for (const u of sheet.unknowns) out.push(`    · ${wrap(u, 70, "      ")}`);
  }
  if (sheet.outOfPortalPayments.length) {
    out.push("");
    out.push("  NOT PAYABLE IN ANY PORTAL:");
    for (const p of sheet.outOfPortalPayments) out.push(`    · ${wrap(p, 70, "      ")}`);
  }
  const seeded = sheet.lines.filter((l) => l.confidence === "seeded");
  if (seeded.length) {
    out.push("");
    out.push(`  ${seeded.length} fee(s) above are SEEDED: research found them and nobody has checked them.`);
    out.push("  Verify against the jurisdiction's own published schedule before quoting a customer.");
  }
  if (FEE_TRACKS.some((t) => !view.agreements[t]?.whoPays)) {
    out.push("");
    out.push("  Fee responsibility is unagreed on at least one portal (guide S3.7). Close it at");
    out.push("  kickoff: record card-on-file / customer-pays / mailed-check / keelix-pays on the");
    out.push("  credential. Automation never pays a portal fee under any of them.");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------
// CLI — runs only when invoked directly, so a test can import the builder without a run
// happening. Windows-safe: compare resolved paths case-insensitively.
// ---------------------------------------------------------------------------------------
const invokedDirectly = ((): boolean => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  await import("dotenv/config");
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3).trim();
    const at = args.indexOf(`--${name}`);
    if (at >= 0) {
      const next = args[at + 1];
      if (next && !next.startsWith("--")) return next.trim();
    }
    return "";
  };
  const asJson = args.includes("--json");
  const wantResearch = args.includes("--research");
  const includeClosed = args.includes("--all");
  // openDatabase() reads AUTOPILOT_DB_PATH when it is CALLED, so setting it here — after the
  // static imports above — still decides which file is opened. An explicit --db beats the
  // environment so a copy can be priced without touching the live one.
  process.env.AUTOPILOT_DB_PATH = flag("db") || process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

  const { openDatabase } = await import("../backend/src/db");
  const { getProjectDetail } = await import("../backend/src/repository");
  const db = await openDatabase();
  const say = (line = ""): void => { if (!asJson) console.log(line); };
  const fail = (message: string): never => { console.error(message); db.close(); process.exit(1); };

  const projectArg = flag("project");
  const clientArg = flag("client");
  if (!projectArg && !clientArg) {
    fail(
      "Name what to price: --project <id-or-homeowner-name>, or --client <id> for every open project.\n" +
      "  npx tsx scripts/fee-sheet.ts --project <id> [--json] [--research] [--db <path>]\n" +
      "  npx tsx scripts/fee-sheet.ts --client <id> [--all]",
    );
  }

  // Found by id first, then by a case-insensitive homeowner-name substring: an operator
  // answering "what does this job cost?" off a ticket has a name, not a uuid.
  const projectIds: string[] = [];
  if (projectArg) {
    const rows = db.query<{ id: string; homeowner_name: string; status: string }>(
      "SELECT id, homeowner_name, status FROM projects WHERE id = ? OR lower(homeowner_name) LIKE ? ORDER BY updated_at DESC",
      [projectArg, `%${projectArg.toLowerCase()}%`],
    );
    if (!rows.length) fail(`No project matches "${projectArg}" by id or homeowner name.`);
    const exact = rows.find((r) => r.id === projectArg);
    if (!exact && rows.length > 1) {
      fail(`"${projectArg}" matches ${rows.length} projects — name one:\n` + rows.map((r) => `  ${r.id}  ${r.homeowner_name}  (${r.status})`).join("\n"));
    }
    projectIds.push(exact?.id ?? rows[0].id);
  } else {
    const rows = db.query<{ id: string; status: string }>(
      "SELECT id, status FROM projects WHERE client_id = ? ORDER BY updated_at DESC",
      [clientArg],
    );
    if (!rows.length) fail(`No projects for client "${clientArg}". Check the id with: npx tsx scripts/coverage-report.ts --client ${clientArg}`);
    for (const r of rows) if (includeClosed || !CLOSED_STATUSES.has(r.status)) projectIds.push(r.id);
    if (!projectIds.length) fail(`Every project for "${clientArg}" is issued or handed off. Re-run with --all to price them anyway.`);
  }

  // --research: the one write, and it is never implicit. Only jurisdictions with NO schedule
  // row at all are looked up — re-researching a stored schedule spends a call to learn what
  // is already on file, and a human-verified row would refuse the write anyway.
  if (wantResearch) {
    const { researchFeeSchedule } = await import("../backend/src/feeSchedules");
    say("--research SPENDS AN LLM CALL for each jurisdiction with no schedule on file, and what");
    say("           it finds lands as SEEDED: researched, unverified, and NOT safe to quote a");
    say("           customer from until a person has checked it against the jurisdiction's own");
    say("           published page. It never overwrites a human-verified schedule.");
    say("");
    const done = new Set<string>();
    for (const projectId of projectIds) {
      const { project } = getProjectDetail(db, projectId);
      for (const track of FEE_TRACKS) {
        const who = track === "nem" ? s(project.utility) : s(project.ahj);
        if (!who) { say(`  skip ${track}: this project has no ${track === "nem" ? "utility" : "AHJ"} to look up.`); continue; }
        const key = `${s(project.state).toUpperCase()}|${track}|${who.toLowerCase()}`;
        if (done.has(key)) continue;
        done.add(key);
        if (findFeeScheduleForProject(db, project, track)) { say(`  have  ${track} schedule for ${who} — not spending a call.`); continue; }
        say(`  look up ${track} schedule for ${who}…`);
        try {
          const outcome = await researchFeeSchedule(db, { state: project.state, ahj: project.ahj, utility: project.utility, track });
          say(`          ${outcome.found ? (outcome.saved ? "saved as seeded" : outcome.refusedVerified ? "refused: a human-verified row already stands; the finding went to its notes" : "found but not saved") : "nothing usable found"} — ${outcome.reason || ""}`.trimEnd());
        } catch (err) {
          say(`          research failed: ${(err as Error).message}`);
        }
      }
    }
    say("");
  }

  const views: FeeSheetPresentation[] = [];
  for (const projectId of projectIds) {
    const { project } = getProjectDetail(db, projectId);
    views.push(buildFeeSheetPresentation(db, project));
  }

  if (asJson) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), database: process.env.AUTOPILOT_DB_PATH, sheets: views }, null, 2));
  } else {
    for (const view of views) console.log(renderFeeSheet(view));
    console.log("");
    console.log(`  ${views.length} project(s) priced.${wantResearch ? " --research wrote seeded schedule rows; everything else was rolled back." : " Read-only: the quote rows this built were rolled back."}`);
    console.log("  The portal's own fee checkout is always completed by a person — never by automation.");
  }
  db.close();
}
