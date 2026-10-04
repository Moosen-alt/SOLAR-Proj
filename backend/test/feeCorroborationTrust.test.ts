// CORROBORATION CANNOT BE ASSERTED BY A FILE — the untrusted-input half of the
// dimension feeEvidencePairing.test.ts pins from the trusted side.
//
// A bracket's `corroboration` means one narrow thing: a machine fetched the cited
// document and found THIS row's label and its fee printed together on one line.
// It is shown to an operator beside the amount, as that amount's evidence, and it
// is the only machine-written field in this table that looks like a check.
//
// THE DEFECT THIS SUITE EXISTS FOR. saveFeeSchedule used to normalise every
// incoming bracket as TRUSTED, on the strength of a comment asserting its input
// "has already been through corroborateBrackets". That was false for one caller:
// scripts/apply-fee-findings.ts replays a findings JSON file into a live database
// in a process that fetches nothing and never runs corroborateBrackets. So a
// findings file opened in a text editor could assert
//     "corroboration": { "corroborated": true, "matchedLine": <anything> }
// and that sentence would be stored and later printed next to the fee AS THE
// EVIDENCE FOR IT. Nothing about confidence was wrong (the row stays 'seeded',
// hard rule 3 intact) — what was destroyed was the meaning of corroboration.
//
// THE FIX IS A KEY, NOT A PROMISE: saveFeeSchedule stores corroboration only for
// a caller that hands over the FeeDocumentLedger it was derived from, and it
// re-derives from that ledger rather than believing the brackets. A ledger is
// something only a process that actually retrieved bytes can produce.
//
// [1] runs the REAL script as a child process against a hand-forged findings
//     file, then reads the row back through the real seams.
// [2] pins the repository function directly, both ways.
// [3] pins researchFeeSchedule's own wiring: it must OWN the ledger it gives the
//     researcher, or every caller that does not pass one (scripts/fee-sheet.ts)
//     silently loses corroboration on real passes.
// [4] the SECOND thing the same replay asserted without standing: a finding with no
//     DISCIPLINE, written to the undifferentiated row, which outranks and hides
//     every split row under the same key. Measured on a copy of the live database,
//     that turned one project's $335 permit total into $200 with the county's
//     electrical permit simply absent. Same script, same spawnSync harness.
//
// Browser-free, network-free. Run: tsx backend/test/feeCorroborationTrust.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(HERE, "../../..");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const APPLY_SCRIPT = path.join(REPO_ROOT, "scripts", "apply-fee-findings.ts");

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-corroboration-trust-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.AUTOPILOT_AUTO_START = "0";
  process.env.SEED_TEST_INSTALLER = "false";

  const { openDatabase } = await import("../src/db");
  const {
    saveFeeSchedule, getFeeSchedule, getFeeSchedulesForKey, feeScheduleProfileKey, feeForProject,
    researchFeeSchedule, newFeeDocumentLedger,
  } = await import("../src/feeSchedules");
  type Finding = import("../src/feeSchedules").FeeScheduleFinding;
  type Ledger = import("../src/feeSchedules").FeeDocumentLedger;
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  // The sentence a hand-editor would put in `matchedLine`. Deliberately something
  // no document prints and no derivation could ever produce, so finding it
  // anywhere downstream is unambiguous proof it was believed rather than checked.
  const FORGED_LINE = "p1  Solar permits are FREE in this county | $0.00  [typed by hand, never fetched]";
  const SOURCE_URL = "https://example-county.gov/fees/2026-schedule.pdf";
  const SOURCE_QUOTE = "Renewable energy, electrical: 0 through 25 kVA $42.00; over 25 kVA $88.00.";
  const LABEL_SMALL = "Renewable energy 0 to 25 KVA";
  const LABEL_LARGE = "Renewable energy over 25 KVA";

  const forgedCorroboration = (): Record<string, unknown> => ({
    // All three fields populated ON PURPOSE. normalizeCorroboration's own
    // whitelist discards `corroborated: true` with no matchedLine or no
    // sourceUrl, so a lazier forgery would be refused by a guard that predates
    // this fix and the suite would pass without it -- which is precisely the
    // "fixture that proves nothing" this round is correcting.
    corroborated: true,
    matchedLine: FORGED_LINE,
    sourceUrl: SOURCE_URL,
    checkedAt: "2026-09-14T00:00:00.000Z",
    via: "http",
  });

  // =========================================================================
  // [1] THE PRODUCTION PATH: the real script, run as the operator runs it.
  // =========================================================================
  const AHJ = "City of Handedited";
  const findingsPath = path.join(dir, "findings.json");
  fs.writeFileSync(findingsPath, JSON.stringify({
    generatedAt: "2026-09-14T00:00:00.000Z",
    database: "/tmp/a-scratch-copy.sqlite",
    findings: [{
      state: "OR", ahj: AHJ, utility: "", track: "permit",
      finding: {
        found: true, reason: "", basis: "system_kw",
        brackets: [
          { minKw: 0, maxKw: 25, feeUsd: 42, label: LABEL_SMALL, corroboration: forgedCorroboration() },
          { minKw: 25.01, maxKw: null, feeUsd: 88, label: LABEL_LARGE, corroboration: forgedCorroboration() },
        ],
        notes: "CORROBORATED 2/2 bracket(s) against the fetched document - each one's label and fee found together on one printed line.",
        paymentMethod: "portal",
        sourceUrl: SOURCE_URL,
        sourceQuote: SOURCE_QUOTE,
        sourceKind: "official",
        quoteVerified: true,
      },
    }],
  }, null, 2), "utf8");

  const applied = spawnSync(
    process.execPath,
    [TSX_CLI, APPLY_SCRIPT, findingsPath, "--db", process.env.AUTOPILOT_DB_PATH as string],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 180_000 },
  );
  const out = `${applied.stdout ?? ""}\n${applied.stderr ?? ""}`;
  check("the real apply script ran", applied.status === 0, `exit ${applied.status} :: ${out.slice(-600)}`);
  check("...and applied the finding (stripping corroboration is not a refusal)",
    /saved as SEEDED/.test(out), out.slice(-600));
  // ASCII on purpose: this is read out of a child process's stdout on Windows.
  check("...and told the operator, before writing, what it was dropping",
    out.includes("CORROBORATION IS NOT REPLAYED") && out.includes("claims 2 corroborated bracket(s)"),
    out.slice(-600));

  const key = feeScheduleProfileKey({ state: "OR", ahj: AHJ }, "permit");
  const row = getFeeSchedule(db, key, "permit");
  check("the row is stored", !!row && row.brackets.length === 2, JSON.stringify(row?.brackets));
  check("...as 'seeded' -- confidence was never the thing at risk here (hard rule 3)",
    row?.confidence === "seeded", row?.confidence);
  check("A HAND-WRITTEN CORROBORATION CLAIM IS NOT STORED",
    !!row && row.brackets.every((b) => b.corroboration === undefined),
    JSON.stringify(row?.brackets.map((b) => b.corroboration)));
  check("...and the forged sentence is nowhere in the stored row",
    !!row && !JSON.stringify(row).includes("typed by hand"), row?.notes);
  check("...the research run's stale 'CORROBORATED n/m' note segment is dropped too",
    !!row && !/CORROBORATED\s+2\/2/.test(row.notes), row?.notes);
  check("...and the row SAYS why it is uncorroborated, rather than going quiet",
    !!row && row.notes.includes("APPLIED FROM A FINDINGS FILE"), row?.notes);

  // The seam an operator actually reads. `bracketQuote` is the one quote allowed
  // beside an amount, and `corroborated` is the flag printed with it.
  const project = {
    state: "OR", ahj: AHJ, utility: "Pacific Power",
    systemSizeAcKw: 8, systemSizeDcKw: 10, parserSnapshot: {},
  } as never;
  const quoted = feeForProject(db, project, "permit");
  check("the fee still prices the job -- the strip costs evidence, not the number",
    quoted?.feeUsd === 42, JSON.stringify(quoted?.feeUsd));
  check("THE FORGED LINE IS NEVER PRINTED AS THE EVIDENCE FOR THE AMOUNT",
    !!quoted && !quoted.bracketQuote.includes("typed by hand"), quoted?.bracketQuote);
  check("...and the quote screen reports it as NOT corroborated",
    quoted?.corroborated === false, JSON.stringify(quoted?.corroborated));

  // =========================================================================
  // [2] THE REPOSITORY FUNCTION ITSELF, both ways.
  // =========================================================================
  const base = (over: Partial<Finding>): Finding => ({
    found: true, reason: "", basis: "system_kw", brackets: [], notes: "",
    sourceUrl: SOURCE_URL, sourceQuote: SOURCE_QUOTE, sourceKind: "official", ...over,
  });
  const printedPage = [
    "2 page(s). Rows are read BY COORDINATE - cells sharing a printed line, left to right.",
    `p1  ${LABEL_SMALL} | $42.00`,
    `p1  ${LABEL_LARGE} | $88.00`,
  ].join("\n");
  const ledgerOf = (body: string): Ledger => {
    const l = newFeeDocumentLedger();
    l.evidence.push({ url: SOURCE_URL, via: "http", status: 200, kind: "pdf", bytes: 2048, handed: 3 });
    l.corpus.push(body);
    return l;
  };
  const forgedBrackets = () => ([
    { minKw: 0, maxKw: 25, feeUsd: 42, label: LABEL_SMALL, corroboration: forgedCorroboration() },
  ] as never);

  const NO_LEDGER = { state: "OR", ahj: "City of Noledger", track: "permit" as const };
  const noLedger = saveFeeSchedule(db, NO_LEDGER, base({ brackets: forgedBrackets() }));
  const noLedgerRow = getFeeSchedule(db, feeScheduleProfileKey(NO_LEDGER, "permit"), "permit");
  check("saveFeeSchedule with NO ledger saves the fee", noLedger.saved, noLedger.reason);
  check("...and strips the corroboration claim that arrived with it",
    noLedgerRow?.brackets[0]?.corroboration === undefined,
    JSON.stringify(noLedgerRow?.brackets[0]?.corroboration));

  // THE GUARD FOR THE TRUSTED PATH IS UNCHANGED. Hand over the ledger and
  // corroboration is re-derived and kept -- and it is re-derived, not believed:
  // the forged line above is replaced by the line actually printed in the corpus.
  const WITH_LEDGER = { state: "OR", ahj: "City of Withledger", track: "permit" as const };
  const withLedger = saveFeeSchedule(
    db, WITH_LEDGER, base({ brackets: forgedBrackets() }), { corroborateAgainst: ledgerOf(printedPage) },
  );
  const withLedgerRow = getFeeSchedule(db, feeScheduleProfileKey(WITH_LEDGER, "permit"), "permit");
  check("saveFeeSchedule WITH the ledger it read still stores corroboration",
    withLedger.saved && withLedgerRow?.brackets[0]?.corroboration?.corroborated === true,
    JSON.stringify(withLedgerRow?.brackets[0]?.corroboration));
  check("...from the PRINTED row, not from what the caller claimed",
    withLedgerRow?.brackets[0]?.corroboration?.matchedLine === `p1 ${LABEL_SMALL} | $42.00`,
    withLedgerRow?.brackets[0]?.corroboration?.matchedLine);
  check("...and the row is STILL 'seeded' -- a machine check is not a promotion",
    withLedgerRow?.confidence === "seeded", withLedgerRow?.confidence);

  // =========================================================================
  // [3] researchFeeSchedule OWNS THE LEDGER IT HANDS THE RESEARCHER.
  //
  // scripts/fee-sheet.ts calls it without one. If the save were handed
  // `options.ledger` rather than the ledger the researcher actually wrote into,
  // every such pass would store uncorroborated brackets -- the feature alive in
  // one caller and dead in the other, which is the exact class of defect this
  // round is repairing.
  // =========================================================================
  const REAL_PASS = { state: "OR", ahj: "City of Realpass", track: "permit" };
  const retrievingResearcher = async (_input: unknown, options?: { ledger?: Ledger }): Promise<Finding> => {
    // Exactly what openFeeDocument does: push the evidence row and the text it
    // handed the model onto the ledger it was given.
    options?.ledger?.evidence.push({ url: SOURCE_URL, via: "http", status: 200, kind: "pdf", bytes: 2048, handed: 3 });
    options?.ledger?.corpus.push(printedPage);
    return base({ brackets: [{ minKw: 0, maxKw: 25, feeUsd: 42, label: LABEL_SMALL }] });
  };
  const realPass = await researchFeeSchedule(db, REAL_PASS, { researcher: retrievingResearcher });
  const realRow = getFeeSchedule(db, feeScheduleProfileKey(REAL_PASS, "permit"), "permit");
  check("a research pass that opened a document stores corroboration WITHOUT the caller passing a ledger",
    realPass.saved && realRow?.brackets[0]?.corroboration?.corroborated === true,
    JSON.stringify([realPass.reason, realRow?.brackets[0]?.corroboration]));

  // The other arm: a researcher that fetched NOTHING cannot corroborate itself,
  // however confidently its brackets arrive.
  const EMPTY_PASS = { state: "OR", ahj: "City of Emptypass", track: "permit" };
  const claimingResearcher = async (): Promise<Finding> => base({ brackets: forgedBrackets() });
  const emptyPass = await researchFeeSchedule(db, EMPTY_PASS, { researcher: claimingResearcher });
  const emptyRow = getFeeSchedule(db, feeScheduleProfileKey(EMPTY_PASS, "permit"), "permit");
  check("a researcher that retrieved nothing cannot corroborate its own numbers",
    emptyPass.saved && emptyRow?.brackets[0]?.corroboration === undefined,
    JSON.stringify(emptyRow?.brackets[0]?.corroboration));

  // =========================================================================
  // [4] THE SAME REPLAY PATH, AND THE OTHER THING IT WAS SILENTLY DESTROYING.
  //
  // Found by running the real script end-to-end against a COPY of the live
  // database rather than a scratch one, which is the only reason it was visible:
  // fee_schedules is keyed (profile_key, track, DISCIPLINE), the findings file had
  // no discipline field at all, and "" is NOT a wildcard — it is the
  // undifferentiated row, which feeSchedules.applicableSchedules returns ALONE
  // ("An undifferentiated row answers for everything and is the whole answer").
  //
  // MEASURED, on a copy of the live database, applying an ordinary two-row
  // findings file for Coos Bay / Coos County:
  //     before   Drew Example's permit total  $335.00
  //              = Coos County ELECTRICAL $135.00 + City of Coos Bay STRUCTURAL $200.00
  //     after    $200.00, ONE line. The county's electrical permit left the quote
  //              entirely; both split rows were still in the table, untouched and
  //              unreachable behind the new "" row. Nothing was printed.
  //
  // Same shape as the corroboration defect above — a replay asserting something it
  // has no standing to assert — so it is pinned in the same suite, through the same
  // real script. The rows are SEEDED HERE THROUGH saveFeeSchedule, never raw SQL:
  // a fixture built by INSERT can pin a shape nothing in production can write.
  // =========================================================================
  const SPLIT = { state: "OR", ahj: "City of Splitpermit", track: "permit" as const };
  const SPLIT_KEY = feeScheduleProfileKey(SPLIT, "permit");
  // Each row's quote NAMES ITS OWN FEE. evaluateSchedule refuses a single-bracket
  // line whose stored evidence quotes a different amount (FEE_CONFLICT_MARKER), so
  // re-using this file's $42/$88 quote would make the fixture unpriceable for a
  // reason that has nothing to do with what [4] is pinning.
  saveFeeSchedule(db, { ...SPLIT, discipline: "electrical" }, base({
    sourceQuote: "Electrical permit, 0 through 25 kVA | $111.00",
    brackets: [{ minKw: 0, maxKw: 25, feeUsd: 111, label: "Electrical permit, 0-25 kVA" }] as never,
  }));
  saveFeeSchedule(db, { ...SPLIT, discipline: "structural" }, base({
    basis: "flat", sourceQuote: "Structural permit, flat | $222.00",
    brackets: [{ feeUsd: 222, label: "Structural permit, flat" }] as never,
  }));
  const splitProject = {
    state: "OR", ahj: SPLIT.ahj, utility: "Pacific Power",
    systemSizeAcKw: 8, systemSizeDcKw: 10, parserSnapshot: {},
  } as never;
  check("[4] fixture: the jurisdiction files TWO separate permits, totalling $333",
    feeForProject(db, splitProject, "permit")?.feeUsd === 333,
    JSON.stringify(feeForProject(db, splitProject, "permit")?.feeUsd));

  /** One findings row, written and applied exactly as an operator would. */
  const applyOne = (name: string, ahj: string, discipline: string | null, feeUsd: number): string => {
    const p = path.join(dir, `findings-${name}.json`);
    fs.writeFileSync(p, JSON.stringify({
      generatedAt: "2026-09-15T00:00:00.000Z",
      database: "/tmp/a-scratch-copy.sqlite",
      findings: [{
        state: "OR", ahj, utility: "", track: "permit",
        ...(discipline === null ? {} : { discipline }),
        finding: {
          found: true, reason: "", basis: "system_kw",
          brackets: [{ minKw: 0, maxKw: 25, feeUsd, label: `Replayed line, $${feeUsd}`, corroboration: forgedCorroboration() }],
          notes: "", paymentMethod: "portal",
          sourceUrl: SOURCE_URL, sourceQuote: `Replayed line, 0 through 25 kVA | $${feeUsd}.00`,
          sourceKind: "official", quoteVerified: true,
        },
      }],
    }, null, 2), "utf8");
    const r = spawnSync(
      process.execPath,
      [TSX_CLI, APPLY_SCRIPT, p, "--db", process.env.AUTOPILOT_DB_PATH as string],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 180_000 },
    );
    return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  };

  // --- (a) NO DISCIPLINE, against a jurisdiction that files separately. --------
  // ASCII assertions only: this is read out of a child process's stdout on Windows.
  const blind = applyOne("blind", SPLIT.ahj, null, 999);
  check("[4a] a discipline-less finding against a split-permit jurisdiction is REFUSED",
    blind.includes("REFUSED") && blind.includes("SEPARATE permit(s)"), blind.slice(-900));
  check("[4a] ...it says nothing was written, and names the repair",
    blind.includes("Nothing was written.") && blind.includes("THE REPAIR") && blind.includes('"electrical"'),
    blind.slice(-900));
  check("[4a] ...and it did NOT save", !/saved as SEEDED/.test(blind), blind.slice(-900));
  const afterBlind = getFeeSchedulesForKey(db, SPLIT_KEY, "permit");
  check("[4a] NO UNDIFFERENTIATED ROW WAS CREATED to shadow the two real ones",
    afterBlind.length === 2 && afterBlind.every((r) => !!r.discipline),
    JSON.stringify(afterBlind.map((r) => [r.discipline, r.brackets.map((b) => b.feeUsd)])));
  check("[4a] THE QUOTE IS UNCHANGED — no permit vanished from the customer's total",
    feeForProject(db, splitProject, "permit")?.feeUsd === 333,
    JSON.stringify(feeForProject(db, splitProject, "permit")?.feeUsd));

  // --- (b) THE SAME FILE, one word added. -------------------------------------
  const named = applyOne("named", SPLIT.ahj, "electrical", 444);
  check("[4b] naming the discipline lets the finding through", /saved as SEEDED/.test(named), named.slice(-900));
  const elec = getFeeSchedule(db, SPLIT_KEY, "permit", "electrical");
  const struct = getFeeSchedule(db, SPLIT_KEY, "permit", "structural");
  check("[4b] ...onto the ELECTRICAL row", elec?.brackets[0]?.feeUsd === 444, JSON.stringify(elec?.brackets));
  check("[4b] ...leaving the structural permit alone", struct?.brackets[0]?.feeUsd === 222, JSON.stringify(struct?.brackets));
  check("[4b] ...still two rows, still no undifferentiated one",
    getFeeSchedulesForKey(db, SPLIT_KEY, "permit").length === 2,
    JSON.stringify(getFeeSchedulesForKey(db, SPLIT_KEY, "permit").map((r) => r.discipline)));
  check("[4b] ...and corroboration is STILL stripped — the discipline door is not a trust door",
    elec?.brackets[0]?.corroboration === undefined && elec?.confidence === "seeded",
    JSON.stringify([elec?.confidence, elec?.brackets[0]?.corroboration]));

  // --- (c) THE ORDINARY CASE MUST NOT HAVE MOVED. -----------------------------
  // A jurisdiction with no split rows is exactly what every findings file written
  // before this guard was aimed at, and it still applies with no discipline.
  const FRESH = { state: "OR", ahj: "City of Nosplit", track: "permit" as const };
  const fresh = applyOne("fresh", FRESH.ahj, null, 555);
  check("[4c] a discipline-less finding against a key with NO split rows still applies",
    /saved as SEEDED/.test(fresh) && !/REFUSED/.test(fresh), fresh.slice(-900));
  const freshRow = getFeeSchedule(db, feeScheduleProfileKey(FRESH, "permit"), "permit", "");
  check("[4c] ...as the undifferentiated row, as before",
    freshRow?.brackets[0]?.feeUsd === 555, JSON.stringify(freshRow?.brackets));

  if (failures) {
    console.error(`\nfeeCorroborationTrust: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nfeeCorroborationTrust: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
