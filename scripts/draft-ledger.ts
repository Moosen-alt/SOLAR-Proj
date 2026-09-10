// WHAT WE HAVE LEFT ON REAL PORTALS, SO SOMEBODY CAN GO CLEAN IT UP.
//
// Learn and benchmark runs log into the operator's real portal accounts and start real
// applications. They never submit — but the drafts stay, under the operator's licence, and
// nothing deletes them. This prints every live portal touch we have recorded, grouped by
// portal and account, so the drafts can be found and cancelled by hand.
//
//   npx tsx scripts/draft-ledger.ts              # everything, newest portal first
//   npx tsx scripts/draft-ledger.ts --host miami # one portal
//   npx tsx scripts/draft-ledger.ts --since 2026-09-10
//
// Read-only. Prints no secrets: accounts appear as their username reference, which is what
// the credential store holds in the clear anyway, and no field value is ever shown.
import "dotenv/config";

const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1] ?? "") : "";
};

const { readDraftLedger, draftLedgerPath } = await import("../backend/src/draftLedger");

const hostFilter = arg("host").toLowerCase();
const since = arg("since");

const all = readDraftLedger();
const rows = all
  .filter((r) => r.purpose !== "annotation")
  .filter((r) => !hostFilter || (r.host || "").toLowerCase().includes(hostFilter))
  .filter((r) => !since || r.at >= since);

// Annotations carry a portal reference discovered after the fact; fold them onto their project.
const refByProject = new Map<string, string[]>();
for (const r of all) {
  if (!r.portalReference || !r.projectId) continue;
  const list = refByProject.get(r.projectId) ?? [];
  if (!list.includes(r.portalReference)) list.push(r.portalReference);
  refByProject.set(r.projectId, list);
}

console.log(`\nDRAFTS WE MAY HAVE LEFT ON LIVE PORTALS`);
console.log(`ledger: ${draftLedgerPath()}`);
if (!all.length) {
  console.log(`\n  The ledger is empty. That means either nothing has run since it was added,`);
  console.log(`  or a run predates it — the ledger cannot see backwards. Check data/learn-runs/`);
  console.log(`  bundles for older runs, but note bundles are pruned and the live-portal ones`);
  console.log(`  from 2026-09-09 have already been evicted by later fixture runs.\n`);
  process.exit(0);
}

const byHost = new Map<string, typeof rows>();
for (const r of rows) {
  const k = r.host || "(unknown host)";
  byHost.set(k, [...(byHost.get(k) ?? []), r]);
}

const sorted = Array.from(byHost.entries()).sort((a, b) => {
  const at = a[1][a[1].length - 1]?.at ?? "";
  const bt = b[1][b[1].length - 1]?.at ?? "";
  return bt.localeCompare(at);
});

for (const [host, touches] of sorted) {
  const accounts = Array.from(new Set(touches.map((t) => t.account).filter(Boolean)));
  console.log(`\n─── ${host}  (${touches.length} run${touches.length === 1 ? "" : "s"})`);
  if (accounts.length) console.log(`    account(s): ${accounts.join(", ")}`);
  const url = touches.find((t) => t.portalUrl)?.portalUrl;
  if (url) console.log(`    portal: ${url}`);
  for (const t of touches.slice(-12)) {
    const refs = refByProject.get(t.projectId) ?? [];
    const ref = t.portalReference ? [t.portalReference] : refs;
    console.log(
      `    ${t.at.slice(0, 19).replace("T", " ")}  ${String(t.purpose).padEnd(18)}` +
      `${ref.length ? ` ref=${ref.join(",")}` : " ref=(none captured)"}`,
    );
    if (t.note) console.log(`        ${t.note}`);
    if (t.bundleDir) console.log(`        bundle: ${t.bundleDir}`);
  }
  if (touches.length > 12) console.log(`    ... and ${touches.length - 12} earlier run(s)`);
}

const withRef = rows.filter((r) => r.portalReference || (refByProject.get(r.projectId) ?? []).length).length;
console.log(`\n──────────────────────────────────────────────────────────────`);
console.log(`  ${rows.length} live portal run(s) recorded across ${byHost.size} portal(s).`);
console.log(`  ${withRef} carry a portal-assigned reference; the rest must be found by date`);
console.log(`  in the portal's own "my applications" list, under the account above.`);
console.log(`\n  Every one of these stopped before submitting. They are DRAFTS, not filings.`);
console.log(`  Cancelling them is safe and is the operator's call.\n`);
