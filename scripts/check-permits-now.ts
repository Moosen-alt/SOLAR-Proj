// CHECK THE PORTALS NOW, instead of waiting for the next 15-minute tick.
//
//   npx tsx scripts/check-permits-now.ts            every due target
//   npx tsx scripts/check-permits-now.ts --all      force every ACTIVE target, due or not
//   npx tsx scripts/check-permits-now.ts --permit   permit targets only (or --nem)
//
// Read-only against the portals: it reads status pages. It never submits, never pays, never
// touches a final-submit control. Exactly the call the scheduler makes, on demand.
//
// A status CHANGE still notifies the client through the normal path, so this is not a silent
// tool — if a permit moved to issued while you were looking, the client is told (or the message
// is recorded as undelivered; see scripts/undelivered.ts).
import { openDatabase } from "../backend/src/db";
import { runDuePermitChecks } from "../backend/src/repository";

const argv = process.argv.slice(2);
const type = argv.includes("--permit") ? "permit" : argv.includes("--nem") ? "nem" : "all";
const forceAll = argv.includes("--all");

const db = await openDatabase();

const snapshot = () => db.query<Record<string, unknown>>(
  `SELECT t.id, t.target_type, t.latest_outcome, t.latest_status_label, t.last_checked_at,
          p.project_address
     FROM permit_check_targets t JOIN projects p ON p.id = t.project_id
    WHERE t.active = 1 ORDER BY p.project_address, t.target_type`,
);

const before = snapshot();
if (!before.length) {
  console.log("\nNo active permit/NEM targets. Nothing is being monitored yet.\n");
  db.close();
  process.exit(0);
}

if (forceAll) {
  // Make every active target due. Only the schedule is moved — no status is invented.
  db.run("UPDATE permit_check_targets SET next_check_at = ? WHERE active = 1", [new Date().toISOString()]);
}

console.log(`\n${before.length} active target(s). Sweeping (${type})…\n`);
const out = await runDuePermitChecks(db, type as "permit" | "nem" | "all");

const byId = new Map(before.map((r) => [String(r.id), r]));
let changed = 0;
let rechecked = 0;
console.log(`checked ${out.checked} target(s)\n`);
for (const r of snapshot()) {
  const b = byId.get(String(r.id));
  const movedOutcome = b && b.latest_outcome !== r.latest_outcome;
  const movedClock = b && b.last_checked_at !== r.last_checked_at;
  if (movedOutcome) changed++;
  if (movedClock) rechecked++;
  const addr = String(r.project_address || "").slice(0, 36).padEnd(38);
  const state = movedOutcome
    ? `${b!.latest_outcome || "(none)"} -> ${r.latest_outcome || "(none)"}   ** CHANGED **`
    : `${r.latest_outcome || "(none)"}`;
  console.log(`  ${String(r.target_type).padEnd(6)} ${addr} ${state}${movedClock ? "" : "   [not re-checked this sweep]"}`);
}

// "Unreadable" is not "nothing". A target whose page could not be read keeps its known status
// and its clock does NOT advance, so it stays due rather than looking freshly confirmed.
console.log(`\n${rechecked} re-checked, ${changed} status change(s).`);
if (rechecked < out.checked) {
  console.log(`${out.checked - rechecked} target(s) were read but unreadable — their known status was kept rather than`);
  console.log("overwritten with nothing. NEM portals usually need a login the public scrape does not have.");
}
console.log("");
db.close();
