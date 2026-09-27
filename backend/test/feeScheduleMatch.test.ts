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
//   5. On the REAL schedule module: the badge needs a printed row naming THIS permit (or the
//      schedule's row for exactly this bracket label); a row naming another trade — plumbing,
//      mechanical, wind — never earns it (skeptic MF4: "Permit fee" $160 vs "Plumbing permit fee").
// Kill: drop the flag at the seam (permitFeeCorroborated = false) -> section 1 and 3a FAIL.
// Kill (MF4): resolutionFrom's corroborated back to `!!l.corroboration?.corroborated` -> 5a, 5e,
// 5f FAIL (measured: 3 failures; 5b-5d pass either way, so they guard the gate's reach).
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
  const seenLine = { ...permitLine, feeUsd: 360, confirmRows: [{ id: "row-city", updatedAt: "2026-09-27T20:00:00.000Z" }, { id: "row-county", updatedAt: "2026-09-27T20:00:01.000Z" }] };
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
    `${src}\nreturn confirmFeeLine;`)(st, apiStub, () => true, { prompt: () => "Jane Operator" }, { getItem: () => "", setItem: () => undefined },
    (m: string) => { messages.push(m); }, () => undefined) as (track: string, btn: { disabled: boolean }) => Promise<void>;
  await confirmFeeLine("permit", { disabled: false });
  const sent = calls.find((c) => c.path.endsWith("/confirm"))?.body as { feeUsd?: number; scheduleRows?: unknown } | undefined;
  check("4g. the Confirm click sends the amount it displayed and the rows (with versions) behind it",
    sent?.feeUsd === 360 && JSON.stringify(sent?.scheduleRows) === JSON.stringify(seenLine.confirmRows), JSON.stringify(sent));
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
  save("City of Exactbay", "Residential permit", 180);
  const exact = lineFor("mf4-exact", "City of Exactbay");
  check("5c. MUST-PASS: the schedule's line for EXACTLY this bracket label earns it", exact.corroborated === true, JSON.stringify({ c: exact.corroborated, e: exact.evidenceQuote }));
  save("Kva County", "5 KVA or less", 135, "electrical");
  const kva = lineFor("mf4-kva", "Kva County");
  check("5d. MUST-PASS: an exact-label kVA row ('5 KVA or less | $135.00') earns it", kva.corroborated === true && kva.feeUsd === 135, JSON.stringify({ f: kva.feeUsd, c: kva.corroborated, e: kva.evidenceQuote }));
  save("City of Mechbay", "Mechanical permit", 90);
  const mech = lineFor("mf4-mech", "City of Mechbay");
  check("5e. MUST-EXCLUDE: a line naming another trade never earns it, even as the exact label", mech.corroborated === false, JSON.stringify({ c: mech.corroborated, e: mech.evidenceQuote }));
  save("Wind County", "5 KVA or less", 346, "electrical");
  const wind = lineFor("mf4-wind", "Wind County");
  check("5f. MUST-EXCLUDE: the WIND row carrying the solar bracket's label and fee never earns it", wind.corroborated === false, JSON.stringify({ c: wind.corroborated, e: wind.evidenceQuote }));
}

registerFeeScheduleLookup(null);
db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failures) { console.error(`\nfeeScheduleMatch: ${failures} failure(s)`); process.exit(1); }
console.log("\nfeeScheduleMatch: all checks passed");
