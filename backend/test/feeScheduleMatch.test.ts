// "MATCHES THE PUBLISHED SCHEDULE" — a machine check, labelled as one (operator 2026-09-27).
//
// The fee panel showed "Permit (AHJ) — City of Coos Bay: provisional — not verified" and the
// operator asked "can we just have it verify itself or something?". Part of the answer is
// already computed and thrown away: when fee research re-reads the cited schedule and finds the
// amount's line printed in it (label and fee on one row), the resolution says `corroborated` —
// and the quote seam dropped the flag, so a machine-checked amount wore the same bare
// "provisional" as an unchecked one.
//
// What this pins:
//   1. The quote carries `permitFeeCorroborated` + the printed line (`permitFeeEvidenceQuote`) on
//      the published_schedule tier ONLY; the sheet line carries them as `corroborated` /
//      `evidenceQuote`. A guessed-valuation walk does not earn it (the TABLE line is printed, the
//      computed amount is not).
//   2. The confidence stays "seeded" and the total's weakest-line grade is unchanged.
//   3. The dashboard (the REAL renderer, lifted from frontend/dashboard.js) labels a corroborated
//      seeded line "matches the published schedule" with the printed line and the link, never
//      "verified"; an uncorroborated one keeps "provisional — not verified"; an estimate stays an
//      estimate; everything interpolated is escaped.
//   5. On the REAL schedule module: the badge needs a printed row naming THIS permit; a row
//      naming another trade — plumbing, mechanical, wind — never earns it (skeptic MF4: "Permit
//      fee" $160 vs "Plumbing permit fee"), and an exact-label row earns it only when that label
//      itself names this permit (fees-close2: "Residential permit", a bare "5 KVA or less" do not).
//   6. The heading above the row (fees-close2, skeptic M1p): kept at corroboration time, stored,
//      read with the row — a wind/plumbing/generator heading never earns it; a solar/renewable
//      heading over a bare size row does. M2-M5, M9, M10 shapes as MUST-EXCLUDE with controls.
// Kill: drop the flag at the seam (permitFeeCorroborated = false) -> section 1 and 3a FAIL.
// Kill (MF4 + fees-close2 positive naming): corroborationNamesThisPermit returns true for any
// corroborated line -> 5a, 5c, 5d, 5e, 5f, 6a, 6e-6j, 6m, 6o, 6p FAIL (measured: 15 failures).
// Kill (fees-close2 heading): corroborateBrackets records heading "" -> 6b, 6c, 6d FAIL (measured:
// 3 failures; 6a stays excluded — positive naming alone holds the wind row out).
// Kill (fees-close2, skeptic M8): buildPaymentQuote ignores evidenceVerdict "other_permit" (the
// plumbing row back under "Published as") -> 5g FAILS (measured: 1 failure).
// Kill (no false accusation): on NEM, a trade word or "electric" read as another permit BEFORE
// the interconnection test -> 6q, 6r, 6s FAIL. Kill (merged heading): a line with a "|" is never
// a heading -> 6w FAILS (the wind row files under the renewable heading and badges).
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "./_isolate";
import type { ProjectRecord, PublishedFeeResult } from "../../shared/src/types";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-match-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
process.env.SUBMISSION_SERVICE_FEE_USD = "0";
const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { buildPaymentQuote, buildProjectFeeSheet, registerFeeScheduleLookup, recordActualPermitFee } = await import("../src/submissionFees");
const db = await openDatabase();
const client = createClient(db, { companyName: "Match Solar", billingMode: "monthly" });
const now = new Date().toISOString();
const mk = (id: string, ahj: string): ProjectRecord => {
  db.run(
    `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
     VALUES (?, ?, 'Test Owner', 'OR', ?, 'Pacific Power', 4.2, 3.072, 'ready_to_stage', '{}', ?, ?)`,
    [id, client.id, ahj, now, now],
  );
  return { id, clientId: client.id, state: "OR", ahj, utility: "Pacific Power", systemSizeDcKw: 4.2, systemSizeAcKw: 3.072, totalExportKw: null, parserSnapshot: {} } as unknown as ProjectRecord;
};

const SCHEDULE = "https://co.coos.or.us/files/community_development_fees.pdf";
const PRINTED = "5 KVA or less | $135.00";
let permitAnswer: PublishedFeeResult | null = null;
registerFeeScheduleLookup((_db, _p, track) => (track === "nem"
  ? { feeUsd: 0, sourceUrl: "https://pacificpower.example/tier1", confidence: "seeded", corroborated: false, bracketQuote: "", paymentMethod: "none" }
  : permitAnswer));

// ── 1. THE SEAM CARRIES THE FLAG ───────────────────────────────────────────────────────────
permitAnswer = { feeUsd: 135, bracketLabel: PRINTED, sourceUrl: SCHEDULE, confidence: "seeded", corroborated: true, bracketQuote: PRINTED, paymentMethod: "portal", matchedName: "Coos County" };
const matched = mk("match-1", "Coos County");
const q = buildPaymentQuote(db, matched, "permit");
check("1a. a corroborated seeded schedule amount is flagged on the quote", q.permitFeeCorroborated === true, JSON.stringify(q.permitFeeCorroborated));
check("1b. …with the printed line that supports THIS amount", q.permitFeeEvidenceQuote === PRINTED, q.permitFeeEvidenceQuote);
check("1c. …and its confidence is still 'seeded' (a qualifier, never a promotion)", q.permitFeeConfidence === "seeded", q.permitFeeConfidence);
check("1d. the basis names the match and never calls it human-verified",
  /matches the published schedule/.test(q.permitFeeBasis) && /CORROBORATED/.test(q.permitFeeBasis) && !/\(human-verified\)/.test(q.permitFeeBasis), q.permitFeeBasis);
const sheet = buildProjectFeeSheet(db, matched);
const permitLine = sheet.lines.find((l) => l.track === "permit")!;
check("1e. the fee-sheet line carries corroborated + evidenceQuote", permitLine.corroborated === true && permitLine.evidenceQuote === PRINTED, JSON.stringify(permitLine));
check("1f. the total still takes the weakest line: seeded", sheet.totalConfidence === "seeded", sheet.totalConfidence);

permitAnswer = { ...permitAnswer, corroborated: false };
const unmatched = mk("match-2", "Coos County");
const qu = buildPaymentQuote(db, unmatched, "permit");
check("1g. an uncorroborated seeded amount is NOT flagged", qu.permitFeeCorroborated === false && /researched, not yet human-verified/.test(qu.permitFeeBasis), qu.permitFeeBasis);

permitAnswer = { ...permitAnswer, corroborated: true, valuationEstimated: true };
const guessed = mk("match-3", "Coos County");
const qg = buildPaymentQuote(db, guessed, "permit");
check("1h. a guessed-valuation walk of a corroborated table does not earn the match (the amount is not printed)",
  qg.permitFeeCorroborated === false && qg.permitFeeConfidence === "estimated", `${qg.permitFeeCorroborated} ${qg.permitFeeConfidence}`);

permitAnswer = { ...permitAnswer, valuationEstimated: false };
const trued = mk("match-4", "Coos County");
recordActualPermitFee(db, trued, "permit", 190, "operator");
const qa = buildPaymentQuote(db, trued, "permit");
check("1i. an operator-entered actual never carries the schedule's match flag", qa.permitFeeSource === "actual" && qa.permitFeeCorroborated === false, `${qa.permitFeeSource} ${qa.permitFeeCorroborated}`);

// ── 3. THE DASHBOARD'S REAL RENDERER ───────────────────────────────────────────────────────
const dashboard = fs.readFileSync(process.env.DASHBOARD_JS_PATH || path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const lift = (name: string): string => {
  const re = new RegExp(`^(?:async )?function ${name}\\(|^const ${name} = `, "m");
  const m = re.exec(dashboard);
  if (!m) throw new Error(`dashboard.js: could not find ${name}`);
  const isConst = m[0].startsWith("const");
  let i = isConst ? m.index + m[0].length : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
  let depth = 0;
  for (; i < dashboard.length; i++) {
    const ch = dashboard[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  return dashboard.slice(m.index, i) + (isConst ? ";" : "");
};
const NAMES = ["esc", "httpUrl", "portalHostname", "feeMoney", "FEE_SOURCE_TEXT", "FEE_CONFIDENCE", "feeConfidenceKey", "FEE_PAYMENT_METHOD", "renderFeeCharges", "feeFaceSourceHtml", "feeComparisonHtml", "feePortalRecordsHtml", "renderFeeSheetLine"];
// eslint-disable-next-line no-new-func
const lib = new Function("state", `${NAMES.map(lift).join("\n\n")}\nreturn { ${NAMES.join(", ")} };`)({ selectedProjectId: "p1" }) as Record<string, any>;
const face = (html: string): string => html.split("<details")[0];
const words = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const badge = (html: string): string => /<span class="badge [^"]*">([^<]*)<\/span>/.exec(face(html))?.[1] ?? "";

{
  const html = lib.renderFeeSheetLine(permitLine);
  check("3a. a corroborated seeded line is labelled 'matches the published schedule'", badge(html) === "matches the published schedule", badge(html));
  check("3b. …with the printed line on the face", words(face(html)).includes(`Printed in the schedule as: “${PRINTED}”`), words(face(html)).slice(0, 400));
  check("3c. …and the schedule linked", face(html).includes(`<a href="${SCHEDULE}"`));
  check("3d. MUST-EXCLUDE: a machine check is never labelled 'verified'", !/(?<!not )\bverified\b/i.test(badge(html)), badge(html));
}
{
  const html = lib.renderFeeSheetLine({ ...permitLine, corroborated: false });
  check("3e. an uncorroborated seeded line keeps 'provisional — not verified'", badge(html) === "provisional — not verified", badge(html));
  check("3f. …and prints no 'Printed in the schedule' claim", !/Printed in the schedule/.test(html));
}
{
  const html = lib.renderFeeSheetLine({ ...permitLine, confidence: "estimated", corroborated: true });
  check("3g. corroboration never upgrades an estimate", badge(html) === "estimate", badge(html));
}
{
  const html = lib.renderFeeSheetLine({ ...permitLine, confidence: "verified", corroborated: true });
  check("3h. a person-verified line still reads 'verified' (the flag does not demote it)", badge(html) === "verified", badge(html));
}
{
  const html = lib.renderFeeSheetLine({ ...permitLine, evidenceQuote: `<img src=x onerror="alert(1)">`, jurisdiction: `<b>Coos</b>` });
  check("3i. the printed line and the jurisdiction are escaped", !/<img /.test(html) && !/<b>Coos/.test(html) && /&lt;img src=x/.test(html), face(html).slice(0, 300));
}

// ── 4. THE CONFIRM CONTROL (feeConfirm.test drives the route; this is the card) ─────────────
{
  check("4a. the sheet marks a seeded published-schedule line confirmable", permitLine.confirmable === true, JSON.stringify(permitLine.confirmable));
  const html = lib.renderFeeSheetLine(permitLine);
  check("4b. a confirmable line draws the Confirm control on the face, keyed by track", /<button[^>]*data-fee-confirm="permit"/.test(face(html)));
  const actualLine = buildProjectFeeSheet(db, trued).lines.find((l) => l.track === "permit")!;
  check("4c. an actual is not confirmable and draws no Confirm control", actualLine.confirmable === false && !/data-fee-confirm/.test(lib.renderFeeSheetLine(actualLine)));
  const v = lib.renderFeeSheetLine({ ...permitLine, confidence: "verified", confirmable: false, verifiedBy: `<i>Jane</i>`, verifiedAt: "2026-09-27T20:00:00.000Z" });
  check("4d. a person-verified line names the person (escaped) and draws no Confirm control",
    /Verified by &lt;i&gt;Jane&lt;\/i&gt; on 2026-09-27/.test(face(v)) && !/data-fee-confirm/.test(v), face(v).slice(0, 400));
  const s = lib.renderFeeSheetLine({ ...permitLine, corroborated: true, verifiedBy: "Jane" });
  check("4e. MUST-EXCLUDE: a name never appears beside a line that is not person-verified", !/Verified by/.test(s));
  // Another org's card: the server sends no name (skeptic MF3) — the face still says a person
  // verified it, and when, without naming anyone.
  const anon = lib.renderFeeSheetLine({ ...permitLine, confidence: "verified", confirmable: false, verifiedBy: "", verifiedAt: "2026-09-27T20:00:00.000Z" });
  check("4f. a person-verified line with no name sent reads 'Human-verified on <date>' and names nobody",
    /Human-verified on 2026-09-27 against the published schedule/.test(words(face(anon))) && !/Verified by/.test(anon), words(face(anon)).slice(0, 300));
}

// ── 4g. THE CONFIRM CLICK SENDS WHAT THE PERSON SAW (skeptic MF2; feeConfirm.test drives the
// server side). The real confirmFeeLine, lifted with its browser surroundings stubbed.
{
  const calls: Array<{ path: string; body: unknown }> = [];
  const messages: string[] = [];
  const dialogs: string[] = [];
  const seenLine = { ...permitLine, feeUsd: 360, jurisdiction: "City of Coos Bay", confirmRows: [
    { id: "row-city", updatedAt: "2026-09-27T20:00:00.000Z", kind: "bracket", authority: "City of Coos Bay", discipline: "structural", bracketLabel: "Solar PV installation permit", feeUsd: 200 },
    { id: "row-pointer", updatedAt: "2026-09-27T20:00:00.500Z", kind: "delegation", authority: "City of Coos Bay", discipline: "electrical", bracketLabel: "", feeUsd: null, collectedBy: "or|coos county|unknown", collectedByAuthority: "Coos County" },
    { id: "row-county", updatedAt: "2026-09-27T20:00:01.000Z", kind: "bracket", authority: "Coos County", discipline: "electrical", bracketLabel: "5.01 KVA to 15 KVA", feeUsd: 160 },
  ] };
  const st = { selectedProjectId: "p1", feeSheet: { lines: [seenLine] }, authMe: { enabled: true, user: { name: "Jane Operator" } } };
  const apiStub = async (p: string, opts: { body?: string } = {}) => {
    calls.push({ path: p, body: opts.body ? JSON.parse(opts.body) : null });
    if (p.endsWith("/confirm")) {
      const err = new Error("The fee changed since you looked — reload and confirm again.") as Error & { details?: unknown };
      err.details = { changed: true };
      throw err;
    }
    return { feeSheet: { lines: [{ ...seenLine, feeUsd: 440 }] } };
  };
  const src = [lift("money"), lift("httpUrl"), lift("confirmFeeLine")].join("\n\n");
  // eslint-disable-next-line no-new-func
  const confirmFeeLine = new Function("state", "api", "confirm", "window", "localStorage", "showMessage", "renderFeeSheetPanel",
    `${src}\nreturn confirmFeeLine;`)(st, apiStub, (m: string) => { dialogs.push(m); return true; }, { prompt: () => "Jane Operator" }, { getItem: () => "", setItem: () => undefined },
    (m: string) => { messages.push(m); }, () => undefined) as (track: string, btn: { disabled: boolean }) => Promise<void>;
  await confirmFeeLine("permit", { disabled: false });
  const sent = calls.find((c) => c.path.endsWith("/confirm"))?.body as { feeUsd?: number; scheduleRows?: unknown } | undefined;
  check("4g. the Confirm click sends the amount it displayed and the rows (with versions) behind it",
    sent?.feeUsd === 360 && JSON.stringify(sent?.scheduleRows) === JSON.stringify(seenLine.confirmRows), JSON.stringify(sent));
  // THE DIALOG NAMES EXACTLY WHAT GETS VERIFIED (fees-close2): each line's authority, bracket and
  // amount, and the hop — and says the other brackets of those schedules are NOT being verified.
  const dialog = dialogs.join("\n");
  check("4i. the Confirm dialog names each item a click would verify — 'Coos County — 5.01 KVA to 15 KVA — $160.00' — and the hop",
    dialog.includes("City of Coos Bay — Solar PV installation permit — $200.00") && dialog.includes("Coos County — 5.01 KVA to 15 KVA — $160.00")
      && /City of Coos Bay — its electrical permit is collected by Coos County/.test(dialog) && /only these/i.test(dialog),
    dialog.slice(0, 600));
  check("4h. on 409 'changed since you looked' it reloads the sheet (now $440) and says so — it does not retry on its own",
    calls.filter((c) => c.path.endsWith("/confirm")).length === 1 && calls.some((c) => /\/fee-sheet$/.test(c.path)) && (st.feeSheet.lines[0] as { feeUsd: number }).feeUsd === 440
      && /changed since you looked/.test(messages.join(" ")), JSON.stringify({ calls: calls.map((c) => c.path), messages }));
}

// ── 5. THE BADGE NEEDS THE SAME PERMIT, ON THE REAL SCHEDULE MODULE (skeptic MF4) ───────────
// corroborateBrackets pairs a bracket's label and fee on one printed line by SUBSTRING, so a
// researched "Permit fee" $160 paired with the printed "Plumbing permit fee | $160.00" and the
// sheet said "matches the published schedule" over a plumbing fee. The badge now also asks: does
// the printed line name THIS permit (solar / PV / electrical / building per the track), or is it
// the schedule's line for exactly this bracket label? A line naming another trade never earns it.
registerFeeScheduleLookup(null);
{
  const F = await import("../src/feeSchedules");
  const DOC = "https://example.gov/fees.pdf";
  const corpus = [
    "p3  Plumbing permit fee | $160.00",
    "p3  Solar photovoltaic permit | $250.00",
    "p3  Residential permit | $180.00",
    "p3  Mechanical permit | $90.00",
    "p8  Wind generation 5 KVA or less | $346.00",
    "p8  5 KVA or less | $135.00",
  ].join("\n");
  const ledger = { evidence: [{ url: DOC, via: "http", title: "Fee schedule", kind: "pdf" }], corpus: [corpus] } as never;
  const save = (ahj: string, label: string, fee: number, discipline = "") => F.saveFeeSchedule(db, { state: "OR", ahj, track: "permit", ...(discipline ? { discipline } : {}) } as never, {
    found: true, reason: "", basis: "flat", brackets: [{ feeUsd: fee, label }], notes: "", paymentMethod: "portal",
    sourceUrl: DOC, sourceQuote: `${label} $${fee}`, sourceKind: "official",
  } as never, { corroborateAgainst: ledger });
  const lineFor = (id: string, ahj: string) => buildProjectFeeSheet(db, mk(id, ahj)).lines.find((l) => l.track === "permit")!;
  const stored = (ahj: string) => JSON.parse(String(db.get<{ brackets_json: string }>("SELECT brackets_json FROM fee_schedules WHERE ahj = ?", [ahj])?.brackets_json ?? "[]"))[0]?.corroboration?.corroborated === true;

  save("City of Genericbay", "Permit fee", 160);
  const generic = lineFor("mf4-generic", "City of Genericbay");
  check("5a. MUST-EXCLUDE: 'Permit fee' $160 paired with 'Plumbing permit fee | $160.00' does NOT read 'matches the published schedule'",
    generic.feeUsd === 160 && generic.corroborated === false && generic.confidence === "seeded" && badge(lib.renderFeeSheetLine(generic)) === "provisional — not verified",
    JSON.stringify({ f: generic.feeUsd, c: generic.corroborated, conf: generic.confidence, e: generic.evidenceQuote }));
  check("5a'. …the stored bracket's own pairing is left as it was (evidence only; the gate is the badge's)", stored("City of Genericbay"));
  save("City of Solarbay", "Solar photovoltaic permit", 250);
  const solar = lineFor("mf4-solar", "City of Solarbay");
  check("5b. MUST-PASS: a printed line naming the solar PV permit earns the badge", solar.corroborated === true && badge(lib.renderFeeSheetLine(solar)) === "matches the published schedule",
    JSON.stringify({ c: solar.corroborated, e: solar.evidenceQuote }));
  // POSITIVE NAMING ONLY (fees-close2): the "exact bracket label" shortcut applies only when that
  // label itself names this permit — "Residential permit" and a bare "5 KVA or less" name no solar
  // permit, so being printed verbatim earns nothing. Unsure -> "provisional".
  save("City of Exactbay", "Residential permit", 180);
  const exact = lineFor("mf4-exact", "City of Exactbay");
  check("5c. MUST-EXCLUDE: the exact-label row 'Residential permit | $180.00' names no solar permit — no badge", exact.corroborated === false, JSON.stringify({ c: exact.corroborated, e: exact.evidenceQuote }));
  save("Kva County", "5 KVA or less", 135, "electrical");
  const kva = lineFor("mf4-kva", "Kva County");
  check("5d. MUST-EXCLUDE: a bare kVA row with no heading naming solar ('5 KVA or less | $135.00') — no badge", kva.corroborated === false && kva.feeUsd === 135, JSON.stringify({ f: kva.feeUsd, c: kva.corroborated, e: kva.evidenceQuote }));
  save("City of Mechbay", "Mechanical permit", 90);
  const mech = lineFor("mf4-mech", "City of Mechbay");
  check("5e. MUST-EXCLUDE: a line naming another trade never earns it, even as the exact label", mech.corroborated === false, JSON.stringify({ c: mech.corroborated, e: mech.evidenceQuote }));
  save("Wind County", "5 KVA or less", 346, "electrical");
  const wind = lineFor("mf4-wind", "Wind County");
  check("5f. MUST-EXCLUDE: the WIND row carrying the solar bracket's label and fee never earns it", wind.corroborated === false, JSON.stringify({ c: wind.corroborated, e: wind.evidenceQuote }));

  // THE EVIDENCE LINE, NOT ONLY THE BADGE (skeptic M8): a row naming ANOTHER permit is never offered
  // as this fee's published line — the basis says the research may have priced the wrong permit.
  // A row that names nothing is still shown, marked; a row naming this permit is "Published as".
  check("5g. MUST-EXCLUDE (M8): the plumbing row is not presented as the fee's published source; the basis warns instead",
    !/Plumbing/i.test(generic.basis + generic.evidenceQuote) && /names ANOTHER permit/.test(generic.basis) && /wrong permit/.test(generic.basis),
    JSON.stringify({ e: generic.evidenceQuote, b: generic.basis.slice(0, 400) }));
  check("5h. a row naming no permit is shown MARKED ('Printed as … does not itself name this permit')",
    /Printed as: "p8 5 KVA or less \| \$135\.00" — that line does not itself name this permit/.test(kva.basis) && !/Published as/.test(kva.basis), kva.basis.slice(0, 300));
  check("5i. MUST-PASS: a row naming this permit is still 'Published as' it",
    /Published as: "p3 Solar photovoltaic permit \| \$250\.00"/.test(solar.basis), solar.basis.slice(0, 300));
}

// ── 6. THE HEADING ABOVE THE ROW, AND POSITIVE NAMING (fees-close2; skeptic M1p) ──────────────
// The production Tigard schedule prints a heading on its own line ("p21 Wind generation systems")
// and bare size rows under it, each with a trailing date cell ("5.01 to 15 kva | $210.00 |
// 7/1/2012"). The row alone names nothing; the HEADING says whose table it is. corroborateBrackets
// keeps the nearest heading above the matched row on the same page (FeeBracketCorroboration.heading),
// it survives the DB round-trip, and the badge reads row + heading: another trade in either never
// earns it; the pair must NAME THIS PERMIT (solar/PV/photovoltaic for building; renewable/solar/PV
// for electrical; interconnection for NEM).
// Kill (fees-close2): corroborateBrackets records heading "" -> 6b, 6c, 6d FAIL (the renewable and
// solar tables' bare rows lose their badge) while 6a stays excluded (positive naming alone holds it).
{
  const F = await import("../src/feeSchedules");
  const DOC = "https://example.gov/tigardish.pdf";
  const TIGARD_PROD = [
    "p21 Electrical Permit Fees",
    "p21 Description | Fee | Effective",
    "p21 Wind generation systems",
    "p21 5 kva or less | $90.00 | 7/1/2012",
    "p21 5.01 to 15 kva | $210.00 | 7/1/2012",
    "p21 Renewable electrical energy systems",
    "p21 5 kva or less | $100.70 | 7/1/2012",
    "p21 5.01 to 15 kva | $133.56 | 7/1/2012",
    "p22 Solar photovoltaic systems",
    "p22 Up to 10 kW | $175.00 | 7/1/2012",
    "p22 Plumbing permits",
    "p22 Solar water heater | $88.00 | 7/1/2012",
  ];
  const saveOn = (rows: string[], who: { ahj?: string; utility?: string; track?: "permit" | "nem" }, label: string, fee: number, discipline = "") => F.saveFeeSchedule(db,
    { state: "OR", track: who.track ?? "permit", ...(who.ahj ? { ahj: who.ahj } : {}), ...(who.utility ? { utility: who.utility } : {}), ...(discipline ? { discipline } : {}) } as never, {
      found: true, reason: "", basis: "flat", brackets: [{ feeUsd: fee, label }], notes: "", paymentMethod: "portal",
      sourceUrl: DOC, sourceQuote: `${label} $${fee}`, sourceKind: "official",
    } as never, { corroborateAgainst: { evidence: [{ url: DOC, via: "http", title: "Fee schedule", kind: "pdf" }], corpus: [rows.join("\n")] } as never });
  const lineOf = (id: string, ahj: string, track: "permit" | "nem" = "permit") => buildProjectFeeSheet(db, mk(id, ahj)).lines.find((l) => l.track === track)!;
  const storedCorr = (ahj: string) => JSON.parse(String(db.get<{ brackets_json: string }>("SELECT brackets_json FROM fee_schedules WHERE ahj = ?", [ahj])?.brackets_json ?? "[]"))[0]?.corroboration ?? {};
  const show = (l: { feeUsd: number | null; corroborated: boolean; evidenceQuote: string }) => JSON.stringify({ f: l.feeUsd, c: l.corroborated, e: l.evidenceQuote });

  saveOn(TIGARD_PROD, { ahj: "Windy Prodbay" }, "5.01 to 15 kva", 210, "electrical");
  const wind = lineOf("m1p-wind", "Windy Prodbay");
  check("6a. MUST-EXCLUDE (M1p): the production-shaped WIND row '5.01 to 15 kva | $210.00 | 7/1/2012' under 'Wind generation systems' does not badge",
    wind.feeUsd === 210 && wind.corroborated === false, show(wind));
  saveOn(TIGARD_PROD, { ahj: "Renew Prodbay" }, "5.01 to 15 kva", 133.56, "electrical");
  const renew = lineOf("m1p-renew", "Renew Prodbay");
  check("6b. MUST-PASS: the same production shape under 'Renewable electrical energy systems' badges (the heading names the permit)",
    renew.feeUsd === 133.56 && renew.corroborated === true, show(renew));
  check("6c. …the heading is stored with the bracket's corroboration and survives the DB read",
    storedCorr("Renew Prodbay").heading === "Renewable electrical energy systems" && storedCorr("Windy Prodbay").heading === "Wind generation systems",
    JSON.stringify([storedCorr("Renew Prodbay"), storedCorr("Windy Prodbay")]));
  saveOn(TIGARD_PROD, { ahj: "Solar Prodbay" }, "Up to 10 kW", 175, "structural");
  const solarRow = lineOf("m1p-solar", "Solar Prodbay");
  check("6d. MUST-PASS: a bare size row under a SOLAR heading badges on the building track", solarRow.corroborated === true, show(solarRow));
  saveOn(TIGARD_PROD, { ahj: "Thermal Prodbay" }, "Solar water heater", 88);
  const thermal = lineOf("m1p-thermal", "Thermal Prodbay");
  check("6e. MUST-EXCLUDE: 'Solar water heater' under a PLUMBING heading does not badge (the heading's trade wins)", thermal.corroborated === false, show(thermal));

  const one = (ahj: string, rows: string[], label: string, fee: number, discipline = "") => { saveOn(rows, { ahj }, label, fee, discipline); return lineOf(`m-${ahj}`, ahj); };
  const ev = one("City of Evbay", ["p3  EV charger electrical permit fee | $160.00", "p3  Solar PV permit fee | $250.00"], "Permit fee", 160, "electrical");
  check("6f. MUST-EXCLUDE (M2): 'Permit fee' $160 paired with 'EV charger electrical permit fee' — generic electrical is not this permit", ev.corroborated === false, show(ev));
  const shed = one("City of Shedbay", ["p3  Accessory building permit (shed) | $95.00", "p3  Building permit - solar | $210.00"], "Building permit", 95);
  check("6g. MUST-EXCLUDE (M3): 'Building permit' $95 paired with 'Accessory building permit (shed)' — generic building is not this permit", shed.corroborated === false, show(shed));
  const com = one("City of Combay", ["p3  Commercial solar PV permit | $500.00", "p3  Residential solar PV permit | $250.00"], "Solar PV permit", 500);
  check("6h. MUST-EXCLUDE (M4): 'Commercial solar PV permit' does not badge a residential job's fee", com.corroborated === false, show(com));
  const therm = one("City of Thermbay", ["p3  Solar thermal system permit fee | $120.00", "p3  Solar photovoltaic system permit fee | $250.00"], "system permit fee", 120);
  check("6i. MUST-EXCLUDE (M5): 'Solar thermal system permit fee' is not a PV permit", therm.corroborated === false, show(therm));
  const split = one("City of Splitbay", ["p3  Solar PV permit - structural | $210.00", "p3  Solar PV permit - electrical | $150.00"], "Solar PV permit", 210, "electrical");
  check("6j. MUST-EXCLUDE (M10): an ELECTRICAL line paired with 'Solar PV permit - structural' does not badge", split.corroborated === false, show(split));
  const splitE = one("City of Splitbay2", ["p3  Solar PV permit - structural | $210.00", "p3  Solar PV permit - electrical | $150.00"], "Solar PV permit - electrical", 150, "electrical");
  check("6k. MUST-PASS: the ELECTRICAL line paired with 'Solar PV permit - electrical' badges", splitE.corroborated === true, show(splitE));
  const bs = one("City of Bldgsolar", ["p3  Building permit (solar) | $210.00", "p3  Plumbing permit | $210.00"], "Building permit", 210, "structural");
  check("6l. MUST-PASS: 'Building permit' paired with 'Building permit (solar)' on the building track badges", bs.corroborated === true, show(bs));

  // NEM: an interconnection line, never a city's building-permit application.
  saveOn(["p2  Building permit application fee | $150.00", "p2  Interconnection application fee | $100.00"], { utility: "Nembay Power", track: "nem" }, "Application fee", 150);
  saveOn(["p2  Building permit application fee | $150.00", "p2  Interconnection application fee | $100.00"], { utility: "Nembay Power2", track: "nem" }, "Application fee", 100);
  const nemOf = (id: string, utility: string) => {
    db.run(`INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
      VALUES (?, ?, 'Test Owner', 'OR', 'City of Nembay', ?, 4.2, 3.072, 'ready_to_stage', '{}', ?, ?)`, [id, client.id, utility, now, now]);
    return buildProjectFeeSheet(db, { id, clientId: client.id, state: "OR", ahj: "City of Nembay", utility, systemSizeDcKw: 4.2, systemSizeAcKw: 3.072, totalExportKw: null, parserSnapshot: {} } as unknown as ProjectRecord)
      .lines.find((l) => l.track === "nem")!;
  };
  const nemBad = nemOf("m9-bad", "Nembay Power");
  check("6m. MUST-EXCLUDE (M9): NEM 'Application fee' $150 paired with 'Building permit application fee' does not badge", nemBad.feeUsd === 150 && nemBad.corroborated === false, show(nemBad));
  const nemOk = nemOf("m9-ok", "Nembay Power2");
  check("6n. MUST-PASS: NEM 'Application fee' $100 paired with 'Interconnection application fee' badges", nemOk.feeUsd === 100 && nemOk.corroborated === true, show(nemOk));

  // THE PREDICATE ITSELF, on shapes the save path does not produce.
  const named = (matchedLine: string, heading: string, discipline: string, track: "permit" | "nem" = "permit") =>
    F.corroborationNamesThisPermit({ corroboration: { corroborated: true, matchedLine, heading, sourceUrl: DOC, checkedAt: "", via: "http" }, bracketLabel: "", discipline } as never, track);
  check("6o. the predicate: a generic kVA row under a WIND heading is out, under a SOLAR heading is in, with no heading is out",
    !named("5.01 to 15 kva | $210.00", "Wind generation systems", "electrical") && named("5.01 to 15 kva | $160.00", "Solar photovoltaic installations", "electrical")
      && !named("5.01 to 15 kva | $160.00", "", "electrical"));
  check("6p. the predicate: a standby-GENERATOR heading never earns the badge on the permit track", !named("Residential solar and generator | $150.00", "Generators", "electrical"));

  // THE ACCUSATION IS MADE ONLY WHERE IT IS TRUE. "other_permit" makes the quote say the amount
  // "may be the wrong permit's" (5g) — so a utility named "… Gas and Electric", a residential-and-
  // commercial heading, the utility's own word "Electric", or a mixed "solar and wind" row must
  // never read as another permit. Controls, then the M-shapes' verdicts.
  const verdict = (matchedLine: string, heading: string, discipline: string, track: "permit" | "nem" = "permit") =>
    F.corroborationVerdict({ corroboration: { corroborated: true, matchedLine, heading, sourceUrl: DOC, checkedAt: "", via: "http" }, bracketLabel: "", discipline } as never, track);
  const v = {
    pge: verdict("Interconnection application fee | $145.00", "Pacific Gas and Electric Company — Rule 21", "", "nem"),
    nemRes: verdict("Net energy metering application | $0.00", "Residential and Small Commercial customers", "", "nem"),
    rule21: verdict("Electric Rule 21 application | $145.00", "", "", "nem"),
    nemMixed: verdict("Interconnection application (solar, wind, fuel cell) | $50.00", "", "", "nem"),
    resCom: verdict("Residential/Commercial Solar PV permit | $250.00", "", ""),
    mixed: verdict("5.01 to 15 kva | $160.00", "Solar and wind energy systems", "electrical"),
    gasPipe: verdict("Gas piping permit | $120.00", "", ""),
    m4: verdict("Commercial solar PV permit | $500.00", "", ""),
    m5: verdict("Solar thermal system permit fee | $120.00", "", ""),
    nonRes: verdict("Non-residential solar PV permit | $500.00", "", ""),
  };
  check("6q. MUST-PASS: NEM interconnection under 'Pacific Gas and Electric Company' names the permit (gas is a utility's name, not a trade)", v.pge === "names_permit", JSON.stringify(v));
  check("6r. MUST-PASS: NEM net metering under 'Residential and Small Commercial customers' names the permit", v.nemRes === "names_permit" && v.nemMixed === "names_permit", JSON.stringify(v));
  check("6s. MUST-EXCLUDE (no false accusation): 'Electric Rule 21 application' is unnamed, never 'another permit'", v.rule21 === "unnamed", JSON.stringify(v));
  check("6t. MUST-PASS: 'Residential/Commercial Solar PV permit' names this permit (the residential scope is named)", v.resCom === "names_permit", JSON.stringify(v));
  check("6u. a mixed 'Solar and wind' heading earns no badge and accuses nothing (unnamed); 'Gas piping' is another trade",
    v.mixed === "unnamed" && v.gasPipe === "other_permit", JSON.stringify(v));
  check("6v. MUST-EXCLUDE: commercial-only, non-residential and solar-THERMAL rows name another permit", v.m4 === "other_permit" && v.nonRes === "other_permit" && v.m5 === "other_permit", JSON.stringify(v));

  // A HEADING THE EXTRACTOR KEPT WITH EMPTY CELLS BESIDE IT ("Wind generation systems | |") is
  // still the heading — skipping it would walk up to the renewable table's heading and badge wind.
  saveOn([
    "p21 Renewable electrical energy systems",
    "p21 5.01 to 15 kva | $133.56 | 7/1/2012",
    "p21 Wind generation systems |  |",
    "p21 Description | Fee | Effective",
    "p21 5.01 to 15 kva | $210.00 | 7/1/2012",
  ], { ahj: "Merged Windbay" }, "5.01 to 15 kva", 210, "electrical");
  const merged = lineOf("m1p-merged", "Merged Windbay");
  check("6w. MUST-EXCLUDE: a wind row under a merged-cell heading 'Wind generation systems |  |' does not badge, and that heading is the one stored",
    merged.corroborated === false && storedCorr("Merged Windbay").heading === "Wind generation systems", JSON.stringify({ c: merged.corroborated, h: storedCorr("Merged Windbay").heading }));
}

registerFeeScheduleLookup(null);
db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failures) { console.error(`\nfeeScheduleMatch: ${failures} failure(s)`); process.exit(1); }
console.log("\nfeeScheduleMatch: all checks passed");
