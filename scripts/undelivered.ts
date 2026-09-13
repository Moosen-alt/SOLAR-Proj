// WHAT DID WE FAIL TO TELL A CLIENT?
//
// Written after finding three real client emails on the live database that had sat undelivered
// since 2026-09-01 — one of them a correction request. The bot saw the portals move, wrote the
// right message, and could not send it, because SMTP was never configured. Nothing counted them.
//
//   npx tsx scripts/undelivered.ts              list what is stranded
//   npx tsx scripts/undelivered.ts --send        actually re-send them (needs SMTP configured)
//
// --send is deliberately NOT the default. This script exists because messages went out late;
// the fix for that is not a tool that mails your clients the moment you run it to look.
import { openDatabase } from "../backend/src/db";
import { undeliveredCommunications } from "../backend/src/crm";
import { resendCommunication } from "../backend/src/clientNotifier";

const send = process.argv.includes("--send");

const db = await openDatabase();
const stranded = undeliveredCommunications(db);

if (!stranded.length) {
  console.log("\nNothing stranded. Every automated client message is recorded as delivered.\n");
  db.close();
  process.exit(0);
}

console.log(`\n${stranded.length} client message(s) were never delivered\n`);
for (const c of stranded) {
  const who = c.recipient || "(recipient not recorded — resolved live on re-send)";
  console.log(`  ${c.occurredAt.slice(0, 10)}  ${c.deliveryStatus.toUpperCase().padEnd(6)}  ${c.subject}`);
  console.log(`              to ${who}`);
  console.log(`              ${c.deliveryDetail || "(no reason recorded)"}`);
  console.log(`              project ${c.projectId ?? "(none)"}\n`);
}

if (!send) {
  const smtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
  console.log(smtp
    ? "SMTP is configured. Re-send these with:  npx tsx scripts/undelivered.ts --send\n"
    : "SMTP is NOT configured (SMTP_HOST / SMTP_FROM). Set both, plus PUBLIC_BASE_URL — without\n"
      + "the last one every status link in these messages points at localhost and is dead on\n"
      + "arrival. Then re-send with:  npx tsx scripts/undelivered.ts --send\n");
  db.close();
  process.exit(0);
}

if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) {
  console.error("Refusing to re-send: SMTP_HOST / SMTP_FROM are not set, so every attempt would\n"
    + "re-record the same failure. Set them first.\n");
  db.close();
  process.exit(1);
}
if (!process.env.PUBLIC_BASE_URL) {
  // Sending is not reversible. A message whose only call to action is a dead localhost link is
  // worse than one that is still waiting: the client reads it, clicks, gets nothing, and the row
  // now says "sent".
  console.error("Refusing to re-send: PUBLIC_BASE_URL is not set, so the status link in every one\n"
    + "of these messages would point at localhost. Set it first.\n");
  db.close();
  process.exit(1);
}

let ok = 0;
let failed = 0;
for (const c of stranded) {
  const result = await resendCommunication(db, c);
  if (result.delivered) { ok++; console.log(`  sent    ${c.subject} -> ${result.to}`); }
  else { failed++; console.log(`  FAILED  ${c.subject} -> ${result.to}: ${result.detail}`); }
}
console.log(`\n${ok} sent, ${failed} still stranded.\n`);
db.close();
process.exit(failed === 0 ? 0 : 1);
