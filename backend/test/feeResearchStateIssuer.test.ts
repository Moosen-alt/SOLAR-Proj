// FEE RESEARCH FOLLOWS THE PERMIT'S ISSUER, NOT THE AHJ (issue #56).
//
// Owner's Los Lunas run (2026-10-03, after #45): the permit tracks resolved to New Mexico CID (the
// state issues building + electrical permits where the village has no building department —
// permitProcess.stateTradeIssuerFor / trackIssuer), but fee research was still queued for "Village
// of Los Lunas (permit/structural)" and "(permit/electrical)", and the fee card read "Permit (AHJ) —
// Village of Los Lunas · ESTIMATE $150.00 … no schedule bracket resolved". The village's own charge
// is only a zoning / site-development review fee.
//
// Pinned here (synthetic projects and synthetic schedules — no network, no API key):
//   1. Research targets: a CID-served project researches CID for building and electrical (one
//      researchKey per state, shared by every CID-served AHJ), and the AHJ ONLY for its zoning /
//      site-development review line. Albuquerque (its own issuer) targets Albuquerque only.
//   2. The real enqueue (ensureFeeSchedulesResearched) carries those targets in the job payload, and
//      a second CID-served AHJ does not re-queue CID.
//   3. The fee sheet / payment quote name the issuer on the permit line, add the local review line,
//      and the sheet's total includes it. No review fee on file = no number (never a fabricated
//      bracket, never the valuation heuristic) and the total says unknown.
//   4. Anything researched still lands 'seeded' (rule 3) — the save path is unchanged.
//
// Run: npx tsx backend/test/feeResearchStateIssuer.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord } from "../../shared/src/types";

delete process.env.ANTHROPIC_API_KEY;
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SKIP_CODE_RESEARCH = "1";
delete process.env.FEE_RESEARCH;
delete process.env.NEM_FEE_ESTIMATE_USD;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-research-state-issuer-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { openDatabase } = await import("../src/db");
  const { createClient } = await import("../src/clients");
  const { feeResearchTargets, ensureFeeSchedulesResearched, saveFeeSchedule } = await import("../src/feeSchedules");
  const { buildPaymentQuote, buildProjectFeeSheet } = await import("../src/submissionFees");
  const { startJobWorker } = await import("../src/jobQueue");
  const { requiredTracks } = await import("../src/submittalTracks");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   - ${name}`);
  };

  const client = createClient(db, { companyName: "Example Solar", billingMode: "monthly" });
  const now = new Date().toISOString();
  const mkProject = (id: string, ahj: string, city: string): ProjectRecord => {
    const snapshot = { projectDescriptionText: "Install roof-mounted PV system, 12 modules.", ahj, city };
    db.run(
      `INSERT INTO projects (id, client_id, homeowner_name, city, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
       VALUES (?, ?, 'Example Owner', ?, 'NM', ?, 'Example Utility', 8.6, 6.5, 'ready_to_stage', ?, ?, ?)`,
      [id, client.id, city, ahj, JSON.stringify(snapshot), now, now],
    );
    return {
      id, clientId: client.id, homeownerName: "Example Owner", projectAddress: "100 Example Rd", city, state: "NM", zip: "87000", ahj,
      utility: "Example Utility", systemSizeDcKw: 8.6, systemSizeAcKw: 6.5, totalExportKw: null, parserSnapshot: snapshot,
    } as unknown as ProjectRecord;
  };

  const CID = /Construction Industries Division/;
  const valencia = mkProject("p-valencia", "Valencia County", "Los Lunas");
  const village = mkProject("p-village", "Village of Los Lunas", "Los Lunas");
  const abq = mkProject("p-abq", "Albuquerque", "Albuquerque");

  // ---------------------------------------------------------------------------
  // 1) Research targets
  // ---------------------------------------------------------------------------
  const tv = feeResearchTargets(db, valencia, requiredTracks(valencia));
  const permitTv = tv.filter((t) => t.track === "permit" && t.role === "issuer");
  check("1a. Valencia County: building + electrical researched against CID",
    ["structural", "electrical"].every((d) => permitTv.some((t) => t.discipline === d && CID.test(t.ahj))) && permitTv.every((t) => CID.test(t.ahj)),
    JSON.stringify(tv));
  check("1b. Valencia County: no building/electrical research is queued against the county",
    !tv.some((t) => t.track === "permit" && t.role === "issuer" && /Valencia/.test(t.ahj)), JSON.stringify(tv));
  const reviewTv = tv.filter((t) => t.role === "local_review");
  check("1c. Valencia County: ONE local zoning / site review line, researched against the county",
    reviewTv.length === 1 && reviewTv[0].ahj === "Valencia County" && /zoning/i.test(reviewTv[0].focus ?? ""), JSON.stringify(reviewTv));
  check("1d. the CID research is told it is the state's schedule; the review research that CID issues the permits",
    permitTv.every((t) => /state/i.test(t.focus ?? "")) && CID.test(reviewTv[0]?.focus ?? ""), JSON.stringify(tv.map((t) => t.focus)));
  const tl = feeResearchTargets(db, village, requiredTracks(village));
  check("1e. cached by ISSUER: Village of Los Lunas shares Valencia County's CID research keys",
    tl.filter((t) => t.track === "permit" && t.role === "issuer").map((t) => t.researchKey).sort().join() === permitTv.map((t) => t.researchKey).sort().join(),
    JSON.stringify(tl));
  check("1f. Village of Los Lunas: its own review line is the village's",
    tl.some((t) => t.role === "local_review" && t.ahj === "Village of Los Lunas"), JSON.stringify(tl));
  const ta = feeResearchTargets(db, abq, requiredTracks(abq));
  check("1g. Albuquerque (own issuer): every permit target is Albuquerque, no local review line",
    ta.filter((t) => t.track === "permit").length > 0 && ta.filter((t) => t.track === "permit").every((t) => t.ahj === "Albuquerque" && t.role === "issuer"),
    JSON.stringify(ta));
  check("1h. the NEM target is the utility on every project",
    [tv, ta].every((ts) => ts.some((t) => t.track === "nem" && t.utility === "Example Utility")));

  // ---------------------------------------------------------------------------
  // 2) The real enqueue carries the targets (worker flag on, as the server boots it)
  // ---------------------------------------------------------------------------
  clearInterval(startJobWorker(db));
  const payloads = (projectId: string): Array<Record<string, unknown>> =>
    db.query<{ payload: string }>("SELECT payload FROM job_queue WHERE job_type = 'fee_research' AND project_id = ? ORDER BY created_at", [projectId])
      .map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  await ensureFeeSchedulesResearched(db, valencia, requiredTracks(valencia));
  const pv = payloads(valencia.id);
  check("2a. queued: CID for structural + electrical, the county for its review line, the utility for NEM",
    ["structural", "electrical"].every((d) => pv.some((p) => p.discipline === d && CID.test(String(p.ahj))))
      && pv.some((p) => p.role === "local_review" && p.ahj === "Valencia County")
      && !pv.some((p) => p.role !== "local_review" && p.track === "permit" && p.ahj === "Valencia County"),
    JSON.stringify(pv));
  await ensureFeeSchedulesResearched(db, village, requiredTracks(village));
  const pl = payloads(village.id);
  check("2b. a second CID-served AHJ does not re-queue CID (one research per issuer); it queues its own review line",
    !pl.some((p) => CID.test(String(p.ahj))) && pl.some((p) => p.role === "local_review" && p.ahj === "Village of Los Lunas"),
    JSON.stringify(pl));
  await ensureFeeSchedulesResearched(db, abq, requiredTracks(abq));
  const pa = payloads(abq.id);
  check("2c. Albuquerque queues against Albuquerque only",
    pa.filter((p) => p.track === "permit").length > 0 && pa.filter((p) => p.track === "permit").every((p) => p.ahj === "Albuquerque"),
    JSON.stringify(pa));
  // Let the instant-kicked keyless jobs finish before reading fee rows.
  await sleep(500);

  // ---------------------------------------------------------------------------
  // 3) Fee sheet + payment quote — nothing on file
  // ---------------------------------------------------------------------------
  const empty = buildProjectFeeSheet(db, village);
  const permitLine = empty.lines.find((l) => l.track === "permit" && l.role !== "local_review");
  const reviewLine = empty.lines.find((l) => l.role === "local_review");
  check("3a. the permit line names CID (the issuer), not the village", CID.test(permitLine?.jurisdiction ?? ""), JSON.stringify(permitLine?.jurisdiction));
  check("3b. the permit line labels the state issuer", /state/i.test(permitLine?.issuerLabel ?? "") && CID.test(permitLine?.issuerLabel ?? ""), String(permitLine?.issuerLabel));
  check("3c. a local zoning / site review line for the village", reviewLine?.jurisdiction === "Village of Los Lunas" && /zoning/i.test(reviewLine?.issuerLabel ?? ""), JSON.stringify(reviewLine));
  check("3d. no review fee on file → no number (never the valuation heuristic, never a bracket)",
    reviewLine?.feeUsd === null && reviewLine?.source === "unknown" && !reviewLine?.bracketLabel, JSON.stringify(reviewLine));
  check("3e. …so the total is unknown, and the gap is named", empty.totalUsd === null && empty.unknowns.some((u) => /zoning/i.test(u) && /Los Lunas/.test(u)),
    JSON.stringify(empty.unknowns));
  const quote = buildPaymentQuote(db, village, "permit");
  check("3f. the payment quote labels the issuer too", CID.test(quote.permitFeeIssuerLabel ?? ""), String(quote.permitFeeIssuerLabel));
  check("3g. a permit estimate on a CID project says it is CID's, not the village's",
    !/Village of Los Lunas/.test(quote.permitFeeBasis) || quote.permitFeeSource !== "valuation_estimate", quote.permitFeeBasis);

  // ---------------------------------------------------------------------------
  // 4) With schedules on file (synthetic): CID's state schedule + the village's review fee
  // ---------------------------------------------------------------------------
  const cidName = String(permitTv[0]?.ahj ?? "");
  const savedCid = saveFeeSchedule(db, { state: "NM", ahj: cidName, track: "permit" }, {
    found: true, reason: "", basis: "flat",
    brackets: [{ minKw: null, maxKw: null, feeUsd: 111, label: "Residential solar PV permit (synthetic)" }],
    notes: "", sourceUrl: "https://state-agency.example/fees", sourceQuote: "Residential solar PV permit (synthetic) $111", sourceKind: "official",
  } as never);
  const savedVillage = saveFeeSchedule(db, { state: "NM", ahj: "Village of Los Lunas", track: "permit" }, {
    found: true, reason: "", basis: "flat",
    brackets: [{ minKw: null, maxKw: null, feeUsd: 25, label: "Zoning compliance review (synthetic)" }],
    notes: "", sourceUrl: "https://village.example/zoning-fees", sourceQuote: "Zoning compliance review (synthetic) $25", sourceKind: "official",
  } as never);
  check("4a. both synthetic rows saved, seeded (rule 3)",
    savedCid.saved && savedVillage.saved && savedCid.schedule?.confidence === "seeded" && savedVillage.schedule?.confidence === "seeded",
    `${savedCid.reason} ${savedVillage.reason}`);
  process.env.NEM_FEE_ESTIMATE_USD = "0";
  const full = buildProjectFeeSheet(db, village);
  const fp = full.lines.find((l) => l.track === "permit" && l.role !== "local_review");
  const fr = full.lines.find((l) => l.role === "local_review");
  check("4b. the permit line is CID's published schedule ($111), not the village's review fee",
    fp?.feeUsd === 111 && fp?.source === "published_schedule", JSON.stringify(fp));
  check("4c. the permit label says state schedule, cited", /state schedule, cited/.test(fp?.issuerLabel ?? ""), String(fp?.issuerLabel));
  check("4d. the review line is the village's $25", fr?.feeUsd === 25 && fr?.jurisdiction === "Village of Los Lunas", JSON.stringify(fr));
  check("4e. the total includes the review line (111 + 25 + 0 NEM)", full.jurisdictionFeesUsd === 136 && full.totalUsd === 136,
    `${full.jurisdictionFeesUsd} ${full.totalUsd}`);
  const abqSheet = buildProjectFeeSheet(db, abq);
  check("4f. Albuquerque: unchanged — the permit line is Albuquerque's, no review line",
    abqSheet.lines.find((l) => l.track === "permit")?.jurisdiction === "Albuquerque" && !abqSheet.lines.some((l) => l.role === "local_review"),
    JSON.stringify(abqSheet.lines.map((l) => [l.track, l.jurisdiction, l.role])));

  // ---------------------------------------------------------------------------
  // 5) A LEGACY permit/structural row under the AHJ's own key (what a pre-#56 run researched
  //    against the wrong agency) is NOT the zoning review fee: the review line is only the exact
  //    undifferentiated row, and review research is still queued (Helm's review on #61).
  // ---------------------------------------------------------------------------
  const savedLegacy = saveFeeSchedule(db, { state: "NM", ahj: "Valencia County", track: "permit", discipline: "structural" }, {
    found: true, reason: "", basis: "flat",
    brackets: [{ minKw: null, maxKw: null, feeUsd: 300, label: "Building permit (synthetic)" }],
    notes: "", sourceUrl: "https://county.example/building-fees", sourceQuote: "Building permit (synthetic) $300", sourceKind: "official",
  } as never);
  check("5a. the synthetic legacy structural row saved", savedLegacy.saved && savedLegacy.schedule?.discipline === "structural", savedLegacy.reason);
  const legacySheet = buildProjectFeeSheet(db, valencia);
  const lr = legacySheet.lines.find((l) => l.role === "local_review");
  check("5b. a stray structural row under the AHJ key never becomes the review line",
    lr?.jurisdiction === "Valencia County" && lr?.feeUsd === null && lr?.source === "unknown", JSON.stringify(lr));
  check("5c. …and review research for the county is still a target",
    feeResearchTargets(db, valencia, requiredTracks(valencia)).some((t) => t.role === "local_review" && t.ahj === "Valencia County"));
  // The real enqueue, not just the target list: clear the county's earlier review job (it is inside
  // the backoff window from 2a), then ask again with the stray row on file.
  db.run(`DELETE FROM job_queue WHERE job_type = 'fee_research' AND project_id = ? AND payload LIKE '%"role":"local_review"%'`, [valencia.id]);
  await ensureFeeSchedulesResearched(db, valencia, requiredTracks(valencia));
  check("5d. …and ensureFeeSchedulesResearched actually queues the county's review research",
    payloads(valencia.id).some((p) => p.role === "local_review" && p.ahj === "Valencia County"), JSON.stringify(payloads(valencia.id)));
  await sleep(500);
  delete process.env.NEM_FEE_ESTIMATE_USD;

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall fee-research state-issuer checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
