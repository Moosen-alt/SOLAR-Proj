// MONTHLY STATEMENT for one client, from the filings we captured as submitted — READ-ONLY.
//
//   npx tsx scripts/billing/statement.ts --client tml --month 2026-09 [--out statement.csv]
//                                        [--permit 100 --ia 50 --ia-only 75 --cap 200 --multiplier 1]
//                                        [--passthrough]
//
// Until billing lives in the product, this is the invoice's line list: one line per filing captured
// as submitted in the month (the confirmation number is the billing event), priced by the rate card
// in scripts/billing/rateCard.ts with the per-project lifetime cap applied against earlier months;
// then the month's corrections as $0 lines (the statement shows the work); then the agency /
// utility fees RECORDED against the client's projects in the month, listed for pass-through at cost.
//
// The pass-through section is a LIST, not a charge, until "who paid" is recorded on the fee: today
// permit_fee_history knows the receipt (jurisdiction, permit number, amount paid, date) but not
// whether Keel or the client's card paid it. --passthrough adds the section's total to the invoice
// total; without it the section prints with a "confirm who paid" flag and is excluded.
//
// Opens the live database read-only (better-sqlite3 { readonly: true }); never the product's
// openDatabase (which runs migrations). Customer names and addresses go to the CSV for the client's
// own invoice, never to a commit.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { LIST_RATE_CARD, monthBounds, monthLines, type Filing, type RateCard } from "./rateCard";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const clientArg = arg("client");
const month = arg("month");
if (!clientArg || !month) {
  console.error("usage: npx tsx scripts/billing/statement.ts --client <id or name part> --month YYYY-MM [--out file.csv] [--permit 100 --ia 50 --ia-only 75 --cap 200 --multiplier 1] [--passthrough]");
  process.exit(2);
}
const card: RateCard = {
  permitUsd: Number(arg("permit", String(LIST_RATE_CARD.permitUsd))),
  interconnectionUsd: Number(arg("ia", String(LIST_RATE_CARD.interconnectionUsd))),
  interconnectionOnlyUsd: Number(arg("ia-only", String(LIST_RATE_CARD.interconnectionOnlyUsd))),
  projectCapUsd: Number(arg("cap", String(LIST_RATE_CARD.projectCapUsd))),
  multiplier: Number(arg("multiplier", "1")),
};
const { start, end } = monthBounds(month);

const dbPath = process.env.AUTOPILOT_DB_PATH || path.join(process.cwd(), "backend", "data", "autopilot.sqlite");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

type ClientRow = { id: string; company_name: string; billing_contact_email: string; billing_mode: string };
const client = db.prepare("SELECT id, company_name, billing_contact_email, billing_mode FROM clients WHERE id = ?").get(clientArg) as ClientRow | undefined
  ?? (db.prepare("SELECT id, company_name, billing_contact_email, billing_mode FROM clients WHERE lower(company_name) LIKE ? ORDER BY company_name LIMIT 1").get(`%${clientArg.toLowerCase()}%`) as ClientRow | undefined);
if (!client) { console.error(`no client matches "${clientArg}"`); process.exit(2); }

type ProjectRow = { id: string; homeowner_name: string; project_address: string; city: string; state: string; zip: string; ahj: string; utility: string };
const projects = db.prepare("SELECT id, homeowner_name, project_address, city, state, zip, ahj, utility FROM projects WHERE client_id = ?").all(client.id) as ProjectRow[];
const projectById = new Map(projects.map((p) => [p.id, p]));
const ids = projects.map((p) => p.id);
const inList = ids.length ? `(${ids.map(() => "?").join(",")})` : "('')";

// EVERY submitted filing on the client's projects, any month — the cap is per project for its lifetime.
type SubRow = { project_id: string; submission_type: string; permit_type: string; application_number: string; permit_number: string; confirmation_number: string; submitted_at: string; submitted_by: string; notes: string };
const subs = db.prepare(
  `SELECT project_id, submission_type, permit_type, application_number, permit_number, confirmation_number, submitted_at, submitted_by, notes
   FROM submissions WHERE status = 'submitted' AND submitted_at IS NOT NULL AND submitted_at != '' AND project_id IN ${inList}
   ORDER BY submitted_at`,
).all(...ids) as SubRow[];
const filings: Filing[] = subs.map((s) => ({
  projectId: s.project_id,
  kind: s.submission_type === "interconnection" ? "interconnection" : "permit",
  permitType: s.submission_type === "interconnection" ? "" : String(s.permit_type || "permit"),
  number: String(s.application_number || s.permit_number || s.confirmation_number || "").trim(),
  submittedAt: String(s.submitted_at),
  note: String(s.submitted_by || s.notes || "").replace(/\s+/g, " ").slice(0, 80),
}));
const lines = monthLines(filings, card, start, end);

// Corrections handled in the month: $0 lines.
type CorrRow = { project_id: string; created_at: string; closed_at: string; correction_bucket: string; resubmitted: number };
const corrections = db.prepare(
  `SELECT project_id, created_at, closed_at, correction_bucket, resubmitted FROM corrections
   WHERE project_id IN ${inList} AND ((closed_at >= ? AND closed_at < ?) OR (closed_at IS NULL AND created_at >= ? AND created_at < ?)) ORDER BY created_at`,
).all(...ids, start, end, start, end) as CorrRow[];

// Agency / utility fees recorded against the client's projects in the month (receipt components).
type FeeRow = { project_id: string; track: string; fee_usd: number; source: string; recorded_at: string; ahj: string; utility: string };
const fees = db.prepare(
  `SELECT project_id, track, fee_usd, source, recorded_at, ahj, utility FROM permit_fee_history
   WHERE project_id IN ${inList} AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at`,
).all(...ids, start, end) as FeeRow[];
const receiptOf = (source: string): { permitNumber: string; receiptNumber: string; paidAt: string; total: number } | null => {
  const m = /^receipt_component:(\{.*\})$/.exec(String(source || ""));
  if (!m) return null;
  try { const j = JSON.parse(m[1]) as Record<string, unknown>; return { permitNumber: String(j.permitNumber || ""), receiptNumber: String(j.receiptNumber || ""), paidAt: String(j.paidAt || ""), total: Number(j.totalPaidUsd ?? j.authorityAmountUsd ?? 0) }; } catch { return null; }
};

const usd = (n: number): string => `$${n.toFixed(2)}`;
const addr = (p: ProjectRow | undefined): string => p ? [p.project_address, p.city, p.state, p.zip].filter(Boolean).join(", ") : "";
const label = (l: { kind: string; permitType: string }): string => l.kind === "interconnection" ? "Interconnection / NEM" : `Permit (${l.permitType || "permit"})`;

const csv: string[][] = [["section", "date", "homeowner", "address", "agency / utility", "filing", "number", "list", "billed", "running total", "note"]];
let serviceTotal = 0;
for (const l of lines) {
  const p = projectById.get(l.projectId);
  serviceTotal += l.billedUsd;
  csv.push(["filing", l.submittedAt.slice(0, 10), p?.homeowner_name || "", addr(p), l.kind === "interconnection" ? (p?.utility || "") : (p?.ahj || ""), label(l), l.number, l.listUsd.toFixed(2), l.billedUsd.toFixed(2), l.runningUsd.toFixed(2), l.note]);
}
for (const c of corrections) {
  const p = projectById.get(c.project_id);
  csv.push(["correction", String(c.closed_at || c.created_at).slice(0, 10), p?.homeowner_name || "", addr(p), p?.ahj || "", `Correction handled (${c.correction_bucket || "unclassified"})${c.resubmitted ? ", resubmitted" : ""}`, "", "0.00", "0.00", "", "included"]);
}
let passTotal = 0;
for (const f of fees) {
  const p = projectById.get(f.project_id);
  const r = receiptOf(f.source);
  const amount = r?.total ?? Number(f.fee_usd || 0);
  passTotal += amount;
  csv.push(["agency fee", String(f.recorded_at).slice(0, 10), p?.homeowner_name || "", addr(p), f.track === "nem" ? (f.utility || p?.utility || "") : (f.ahj || p?.ahj || ""), `Agency fee at cost (${f.track})`, r?.permitNumber || r?.receiptNumber || "", amount.toFixed(2), flag("passthrough") ? amount.toFixed(2) : "0.00", "", flag("passthrough") ? `paid ${r?.paidAt || ""}`.trim() : "confirm who paid — not charged"]);
}
const invoiceTotal = serviceTotal + (flag("passthrough") ? passTotal : 0);
csv.push(["total", "", "", "", "", "", "", "", invoiceTotal.toFixed(2), "", flag("passthrough") ? "filings + agency fees at cost" : "filings only"]);

const esc = (v: string): string => /[",\n]/.test(v) ? `"${v.replace(/"/g, "\"\"")}"` : v;
const out = arg("out");
if (out) fs.writeFileSync(out, csv.map((row) => row.map(esc).join(",")).join("\n") + "\n");

console.log(`STATEMENT — ${client.company_name} — ${month}${client.billing_contact_email ? ` — bill to ${client.billing_contact_email}` : ""}`);
console.log(`rate card: $${card.permitUsd}/permit, $${card.interconnectionUsd}/IA ($${card.interconnectionOnlyUsd} on its own), cap $${card.projectCapUsd}/project, x${card.multiplier}`);
console.log(`filings captured as submitted this month: ${lines.length} on ${new Set(lines.map((l) => l.projectId)).size} project(s)`);
for (const l of lines) {
  const p = projectById.get(l.projectId);
  console.log(`  ${l.submittedAt.slice(0, 10)}  ${(p?.homeowner_name || "").padEnd(22).slice(0, 22)}  ${label(l).padEnd(22)}  ${(l.number || "(no number)").padEnd(20)}  list ${usd(l.listUsd).padStart(8)}  billed ${usd(l.billedUsd).padStart(8)}  project so far ${usd(l.runningUsd)}`);
}
console.log(`corrections handled ($0): ${corrections.length}`);
console.log(`agency / utility fees recorded this month: ${fees.length}, ${usd(passTotal)} — ${flag("passthrough") ? "charged at cost" : "NOT charged (who paid is not recorded yet; pass --passthrough once confirmed)"}`);
console.log(`SERVICE TOTAL ${usd(serviceTotal)}${flag("passthrough") ? `  + AGENCY FEES ${usd(passTotal)}` : ""}  =  INVOICE ${usd(invoiceTotal)}`);
if (out) console.log(`csv -> ${out}`);
