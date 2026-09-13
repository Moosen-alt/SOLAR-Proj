// WHAT ONE PROJECT'S CLIENT OWES US, printed for a person.
//
//   npx tsx scripts/invoice.ts --project <id-or-homeowner-name>
//
// Two amounts, never added together. A jurisdiction fee WE advanced is a pass-through we
// recover at cost; our submission fee is revenue. A bookkeeper posts those to different
// places, so a blended total would be wrong even with the arithmetic right.
//
// Reads only. backend/src/invoices.ts never writes, and unlike the payment screen (which
// persists a quote row as a side effect of being opened) asking for an invoice cannot create
// the thing it reports.
//
// WHAT IT WILL MOSTLY SAY TODAY: "not invoiceable — no fee responsibility on file". That is
// the feature working. The agreement lives on the portal credential (guide S3.7) and most are
// still unset; until one is recorded, nothing says whose money a fee was.
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1] ?? "") : "";
};
const projectArg = arg("project");
if (!projectArg) {
  console.error("\nName the project: npx tsx scripts/invoice.ts --project <id-or-homeowner-name>\n");
  process.exit(1);
}

const { openDatabase } = await import("../backend/src/db");
const { buildProjectInvoice } = await import("../backend/src/invoices");
const repo = await import("../backend/src/repository");

const db = await openDatabase();

// Accept an id or a homeowner name, like fee-sheet does — nobody types a uuid from memory.
const row = db.get<{ id: string }>(
  "SELECT id FROM projects WHERE id = ? OR homeowner_name LIKE ? ORDER BY created_at DESC LIMIT 1",
  [projectArg, `%${projectArg}%`],
);
if (!row) { console.error(`\nNo project matches ${JSON.stringify(projectArg)}.\n`); process.exit(1); }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const project = (repo as any).getProjectDetail(db, row.id)?.project;
if (!project) { console.error(`\nCould not load project ${row.id}.\n`); process.exit(1); }

const inv = buildProjectInvoice(db, project);
const money = (v: number): string => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const line = (s = ""): void => console.log(s);

const head = `${inv.homeownerName || "(unnamed)"}  ${inv.projectId.slice(0, 8)}  ${inv.jurisdiction}`;
line();
line(`── INVOICE  ${head} ${"─".repeat(Math.max(0, 76 - head.length))}`);
line(`   Bill to:  ${inv.clientName || "(no client assigned)"}   (billing: ${inv.billingMode})`);
line();

const reimbursements = inv.lines.filter((l) => l.kind === "reimbursement");
const services = inv.lines.filter((l) => l.kind === "service");

if (reimbursements.length) {
  line("  FEES WE ADVANCED — recovered at cost, not revenue");
  for (const l of reimbursements) {
    line(`      ${money(l.amountUsd).padStart(11)}   ${l.description}${l.provisional ? "   [PROVISIONAL]" : ""}`);
    // The split: one rooftop can owe a city and a county separately, and the sum is a number
    // no published schedule contains.
    for (const c of l.composition) {
      const who = c.collectedVia ? `${c.authority} (filed via ${c.collectedVia})` : c.authority;
      // Fall back to the TRACK, not the word "permit" — a NEM line labelled "permit: Pacific
      // Power" is wrong on a document that goes to a customer.
      const what = c.discipline || (l.track === "nem" ? "interconnection" : "permit");
      line(`      ${(c.amountUsd == null ? "—" : money(c.amountUsd)).padStart(11)}     ${what}: ${who}`);
      if (c.sourceUrl) line(`                      ${c.sourceUrl}`);
    }
    if (l.reconciliation) line(`                    ! ${l.reconciliation}`);
    if (l.paymentReference) line(`                      ref ${l.paymentReference}`);
  }
  line();
}

if (services.length) {
  line("  OUR SERVICE FEES");
  for (const l of services) line(`      ${money(l.amountUsd).padStart(11)}   ${l.description}`);
  line();
}

const provisional = reimbursements.filter((l) => l.provisional);
line(`  REIMBURSEMENT DUE   ${money(inv.reimbursementTotalUsd)}   (fees we paid on the client's behalf)`);
if (provisional.length) {
  line(`                      ${money(provisional.reduce((t, l) => t + l.amountUsd, 0))} of that is PROVISIONAL — read from the`);
  line(`                      jurisdiction's published schedule, not yet from the portal's own fee screen.`);
  line(`                      Recording the real fee replaces it and trues up the invoice.`);
}
line(`  SERVICE FEES DUE    ${money(inv.serviceTotalUsd)}   (ours)`);
line(`  These are reported separately on purpose — one is a pass-through, the other is revenue.`);

if (inv.notInvoiceable.length) {
  line();
  line("  NOT ON THIS INVOICE — and why:");
  for (const x of inv.notInvoiceable) {
    line(`    · [${x.track}] ${x.reason}`);
    line(`      -> ${x.resolution}`);
    if (x.amountSeenUsd != null) line(`      (amount seen but not charged: ${money(x.amountSeenUsd)})`);
  }
}

line();
line("  Nothing here was written to the database. Fee responsibility is recorded on the portal");
line("  credential; automation never pays a portal fee under any of them.");
line();
