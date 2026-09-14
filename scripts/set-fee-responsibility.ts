// WHO PAYS THIS PORTAL'S FEES — agreed per portal at kickoff (onboarding guide S3.7).
//
//   npx tsx scripts/set-fee-responsibility.ts --to keelix-pays                    (dry run, all)
//   npx tsx scripts/set-fee-responsibility.ts --to keelix-pays --apply
//   npx tsx scripts/set-fee-responsibility.ts --to card-on-file --host aca-oregon.accela.com --apply
//   npx tsx scripts/set-fee-responsibility.ts                                     (show the current state)
//
//   keelix-pays    we advance the fee and re-bill it at cost   -> REIMBURSEMENT on the invoice
//   card-on-file   their card is on the portal account         -> not ours to recover
//   customer-pays  they pay the jurisdiction directly          -> not ours to recover
//   mailed-check   they post a cheque                          -> not ours to recover
//
// RECORDING AN AGREEMENT AUTHORISES NOTHING. Automation never pays a portal fee under any value
// of this — a person does, in the portal. This only decides how the money is reported.
//
// Only credentials whose value is currently BLANK are changed unless --overwrite is given: an
// agreement somebody already recorded is not ours to quietly replace.
import { openDatabase } from "../backend/src/db";
import { FEE_RESPONSIBILITY_VALUES, updatePortalCredential } from "../backend/src/portalCredentials";

const argv = process.argv.slice(2);
const flag = (n: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]).trim() : "";
};
const to = flag("to");
const host = flag("host").toLowerCase();
const apply = argv.includes("--apply");
const overwrite = argv.includes("--overwrite");

const db = await openDatabase();

const rows = db.query<{ id: string; client_id: string; portal_url: string; portal_type: string; fee_responsibility: string }>(
  `SELECT c.id, c.client_id, c.portal_url, c.portal_type, c.fee_responsibility
     FROM portal_credentials c ORDER BY c.portal_url`,
);

if (!to) {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.fee_responsibility || "(unagreed)", (by.get(r.fee_responsibility || "(unagreed)") || 0) + 1);
  console.log(`\n${rows.length} portal credential(s):\n`);
  for (const [k, n] of by) console.log(`  ${k.padEnd(16)} ${n}`);
  console.log(`\nSet one with:  --to <${FEE_RESPONSIBILITY_VALUES.join("|")}> [--host <portal host>] --apply\n`);
  db.close();
  process.exit(0);
}

if (!(FEE_RESPONSIBILITY_VALUES as readonly string[]).includes(to)) {
  console.error(`\n"${to}" is not one of: ${FEE_RESPONSIBILITY_VALUES.join(", ")}\n`);
  db.close();
  process.exit(1);
}

const targets = rows.filter((r) => {
  if (host && !String(r.portal_url || "").toLowerCase().includes(host)) return false;
  if (!overwrite && String(r.fee_responsibility || "").trim()) return false;
  return true;
});

if (!targets.length) {
  console.log(`\nNothing to change${host ? ` for "${host}"` : ""}. `
    + `${overwrite ? "" : "Credentials that already carry an agreement are left alone (--overwrite to replace them)."}\n`);
  db.close();
  process.exit(0);
}

console.log(`\n${apply ? "Setting" : "Would set"} fee responsibility to "${to}" on ${targets.length} credential(s):\n`);
for (const t of targets.slice(0, 12)) {
  console.log(`  ${String(t.portal_url || t.portal_type).slice(0, 62).padEnd(64)} ${t.fee_responsibility || "(unagreed)"} -> ${to}`);
}
if (targets.length > 12) console.log(`  … and ${targets.length - 12} more`);

if (!apply) {
  console.log("\nDry run. Nothing was written. Re-run with --apply.\n");
  db.close();
  process.exit(0);
}

let changed = 0;
for (const t of targets) {
  // Through updatePortalCredential, not raw SQL: it validates the value and leaves the stored
  // secret untouched (a credential update must never blank a password it was not given).
  updatePortalCredential(db, t.client_id, t.id, { feeResponsibility: to });
  changed++;
}
console.log(`\n${changed} credential(s) updated.\n`);
console.log("NOTE: this changes how FUTURE fees are reported. An agreement is stamped onto a\n"
  + "payment row when a real fee is recorded, so rows already quoted keep what they had —\n"
  + "see `npx tsx scripts/invoice.ts --project <id>` for what is still not invoiceable.\n");
db.close();
