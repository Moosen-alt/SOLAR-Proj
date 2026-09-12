// HARVEST ONE JURISDICTION'S DOCUMENT PAGE — the applications AND the fee table, in one pass.
//
// The operator's point, made runnable: the page you grab the building apps from is often the
// page that tells you what they cost, because the application itself prints the fee table.
// Coos County's solar page is the proof — electrical application, structural application and
// prescriptive checklist on one page, with the renewable-energy brackets printed on page 1 of
// the electrical application.
//
// DRY RUN BY DEFAULT. It downloads, maps and reads everything, then prints exactly what it
// WOULD store and writes nothing. Add --apply when you have read the numbers and believe them.
//
//   npx tsx scripts/harvest-jurisdiction.ts --state OR --ahj "Coos County"
//   npx tsx scripts/harvest-jurisdiction.ts --state OR --ahj "Coos County" --page https://co.coos.or.us/solar-installations
//   npx tsx scripts/harvest-jurisdiction.ts --state OR --ahj "Coos County" --apply
//
//   --state <XX>       required
//   --ahj "<name>"     required (permit fees are keyed (state, AHJ))
//   --utility "<name>" context only — it steers the page hunt, it is never the fee's key
//   --page <url>       skip the page hunt
//   --max <n>          documents to download this pass (default 10)
//   --apply            actually write templates + the fee schedule
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : "";
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const state = arg("state");
const ahj = arg("ahj");
const utility = arg("utility");
const pageUrl = arg("page");
const apply = flag("apply");
const max = Number(arg("max")) > 0 ? Number(arg("max")) : undefined;

if (!state || !ahj) {
  console.error("Usage: npx tsx scripts/harvest-jurisdiction.ts --state OR --ahj \"Coos County\" [--utility X] [--page <url>] [--max n] [--apply]");
  process.exit(2);
}

const { openDatabase } = await import("../backend/src/db");
const { createLLMProvider } = await import("../backend/src/llm");
const { harvestJurisdiction } = await import("../backend/src/jurisdictionHarvest");

const db = await openDatabase();
const llm = createLLMProvider();

const pad = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

console.log(`\n=== HARVEST ${ahj}, ${state} ${apply ? "(APPLY — writing)" : "(dry run — writing nothing)"} ===`);

const report = await harvestJurisdiction(db, { state, ahj, utility, pageUrl }, { apply, llm, maxDocuments: max });

console.log(`\nPage:     ${report.pageUrl || "(none found)"}`);
console.log(`How:      ${report.pageHow}`);
if (report.pageReason) console.log(`Note:     ${report.pageReason}`);
console.log(`Anchors:  ${report.anchorsSeen} seen — ${report.kept.length} kept, ${report.unsure.length} unsure, ${report.skippedCount} skipped`);

if (report.unsure.length) {
  console.log(`\n-- UNSURE (matched on wording, not fetched — look at these yourself) --`);
  for (const l of report.unsure) console.log(`   ${pad(l.text || "(no text)", 52)} ${l.href}\n     ${l.why}`);
}
if (report.nearMisses.length) {
  console.log(`\n-- SKIPPED BUT PAPER-SHAPED (${report.nearMisses.length} of ${report.skippedCount} skipped) --`);
  for (const l of report.nearMisses) console.log(`   ${pad(l.text || "(no text)", 52)} ${l.href}`);
}

console.log(`\n-- DOCUMENTS (${report.documents.length}) --`);
for (const d of report.documents) {
  console.log(`\n * ${d.linkText || d.filename}`);
  console.log(`   url        ${d.url}`);
  console.log(`   fetched    ${d.fetched ? `yes (HTTP ${d.status}, via ${d.via}, ${d.bytes} bytes ${d.contentType || "?"})` : `NO — ${d.reason}`}`);
  console.log(`   form_type  ${d.formType}`);
  console.log(`   dated      ${d.documentDate || "(the document states no date)"}${d.documentDateIso ? `  [${d.documentDateIso}]` : ""}${d.documentStale ? "  ** STALE **" : ""}`);
  console.log(`   form       ${d.form.action}${d.form.mappedFields != null ? ` — ${d.form.mappedFields} mapped of ${d.form.acroFields ?? "?"} AcroForm field(s)` : ""}`);
  console.log(`              ${d.form.note}`);
  if (d.fee.found) {
    console.log(`   fee table  FOUND — basis ${d.fee.basis}, ${d.fee.brackets.length} bracket(s)`);
    for (const b of d.fee.brackets) console.log(`                ${pad(String(b.label || ""), 54)} $${b.feeUsd.toFixed(2)}`);
    console.log(`   quote      ${d.fee.quote.slice(0, 300)}`);
  } else {
    console.log(`   fee table  none — ${d.fee.reason}`);
  }
  for (const u of d.fee.unreadableRows) console.log(`   unreadable ${u}`);
}

console.log(`\n-- FEE SCHEDULE (${report.fee.profileKey}, permit) --`);
console.log(`   action     ${report.fee.action}`);
console.log(`   reason     ${report.fee.reason || "(none)"}`);
for (const c of report.fee.candidates) {
  console.log(`   ${c.tag} [${c.origin}] ${c.name}`);
  console.log(`      ${c.sourceUrl || "(no url)"}  ${c.documentDate ? `states "${c.documentDate}"` : "undated"}`);
  for (const b of c.brackets) console.log(`        ${pad(String(b.label || ""), 54)} $${b.feeUsd.toFixed(2)}`);
}
if (report.fee.conflict) {
  console.log(`\n   !! CONFLICT: ${report.fee.conflict.summary}`);
  if (report.fee.conflict.ratioNote) console.log(`      ${report.fee.conflict.ratioNote}`);
  console.log(`      A fee with two candidate values is a question for a human, not an answer.`);
  console.log(`      Stored conflicted, feeForProject refuses to answer until somebody picks a source.`);
}
for (const w of report.warnings) console.log(`   warn       ${w}`);

if (!apply) console.log(`\nDry run: nothing was written. Re-run with --apply once the numbers above look right.\n`);
else console.log(`\nWritten. Templates land UNVERIFIED and the schedule lands 'seeded' — a human still verifies both.\n`);

db.close();
