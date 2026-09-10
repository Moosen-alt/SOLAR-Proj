// BACKFILL: THE DRAFTS CREATED BEFORE THE LEDGER EXISTED.
//
// The ledger cannot see backwards, and the run bundles that WERE the record have been pruned
// (a batch of fixture runs evicted every live-portal bundle in this repo inside an hour). So
// this reconstructs the 2026-09-09/10 live runs from what still survives: the recipe rows'
// version counts and notes, the credential store's last_login_ok_at, and this session's own
//record of which portals were driven.
//
// It is deliberately CONSERVATIVE and says so in each note: it records that a run happened
// and therefore a draft MAY exist, rather than claiming a specific draft id it cannot prove.
// The operator finds them by date in the portal's own application list.
//
//   npx tsx scripts/backfill-draft-ledger.ts [--dry-run]
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const dryRun = process.argv.includes("--dry-run");
const { openDatabase } = await import("../backend/src/db");
const { recordDraftTouch, readDraftLedger, draftLedgerPath } = await import("../backend/src/draftLedger");

const db = await openDatabase();

// Portals this session actually drove, with what is known about each. Where a portal-assigned
// reference was observed on screen it is recorded; otherwise the field is left empty rather
// than guessed.
const KNOWN_LIVE_RUNS: Array<{
  host: string; portalUrl: string; runs: number; purpose: string; refs?: string[]; note: string;
}> = [
  {
    host: "amerenillinoisinterconnect.powerclerk.com",
    portalUrl: "https://amerenillinoisinterconnect.powerclerk.com/MvcAccount/Login",
    runs: 11,
    purpose: "benchmark learn + replay self-test",
    note: "NEM. ~11 learn runs on 2026-09-09/10, several with --self-test which replays in a fresh session and can mint a SECOND draft per run. All stopped at Step 7 Payment; none submitted, no fee paid. Expect roughly a dozen-plus draft interconnection applications.",
  },
  {
    host: "apps.miami.gov",
    portalUrl: "https://apps.miami.gov/iBuildPortal/",
    runs: 4,
    purpose: "benchmark learn",
    refs: ["BD26-021147-001", "BD26-021282-001"],
    note: "PERMIT. Four learn runs on 2026-09-09. Each 'Start Application' mints a real iBuild intake with a Process Number; two were observed on screen and are listed. All stopped at Job Category / Job Sub-Category; none submitted.",
  },
  {
    host: "permiteyes.us",
    portalUrl: "https://permiteyes.us/bellingham/userindex.php",
    runs: 2,
    purpose: "benchmark learn",
    note: "PERMIT (Bellingham MA). Single-page application; the walk filled ~60 of 176 fields. One run pressed Enter on the filled form, which posted and was REJECTED server-side (bounced to about:blank). The operator audited the account read-only afterwards and confirmed the applications list was EMPTY - nothing filed, and no draft appears to persist here.",
  },
  {
    host: "interconnect.comed.com",
    portalUrl: "https://interconnect.comed.com/applications",
    runs: 1,
    purpose: "benchmark learn",
    note: "NEM. One learn run 2026-09-09. The walk re-opened the New Application drawer without advancing inside it; whether ComEd persists a drawer-opened application as a draft is unconfirmed - check and tell us, it changes how we treat that portal.",
  },
  {
    host: "apps.lakestevenswa.gov",
    portalUrl: "https://apps.lakestevenswa.gov/citizen/Home/LIVE/PERMIT",
    runs: 2,
    purpose: "benchmark learn",
    note: "PERMIT. Two runs; selecting the permit type navigated to about:blank, so a draft may or may not have been created before the page died.",
  },
  {
    host: "(fleet sweep)",
    portalUrl: "",
    runs: 54,
    purpose: "full accessible-fleet sweep",
    note: "One sweep on 2026-09-09 attempted all 54 measured portals; 26 authenticated. Any portal where the walk reached an application form may hold a draft. Per-portal detail was in the run bundles, which have since been pruned - this is the honest limit of the reconstruction.",
  },
];

const existing = readDraftLedger();
const alreadyBackfilled = existing.some((r) => r.purpose === "backfill-marker");

console.log(`\nBACKFILL of live-portal drafts predating the ledger`);
console.log(`ledger: ${draftLedgerPath()}`);
if (alreadyBackfilled) {
  console.log(`\n  Already backfilled — the ledger carries a backfill marker. Not writing again.\n`);
  process.exit(0);
}

let planned = 0;
for (const r of KNOWN_LIVE_RUNS) {
  console.log(`\n  ${r.host}  x${r.runs}  (${r.purpose})`);
  if (r.refs?.length) console.log(`      observed reference(s): ${r.refs.join(", ")}`);
  console.log(`      ${r.note}`);
  planned += 1;
  if (dryRun) continue;
  recordDraftTouch({
    at: "2026-09-09T00:00:00.000Z",
    host: r.host,
    portalUrl: r.portalUrl,
    account: r.host === "(fleet sweep)" ? "" : "permit@infinitysolarusa.com",
    projectId: `backfill-${r.host}`,
    purpose: `BACKFILL: ${r.purpose} x${r.runs}`,
    portalReference: (r.refs ?? []).join(","),
    note: r.note,
  });
}

if (!dryRun) {
  recordDraftTouch({
    at: new Date().toISOString(), host: "", portalUrl: "", account: "",
    projectId: "backfill-marker", purpose: "backfill-marker",
    note: "Reconstructed 2026-09-09/10 live runs after the fact; bundles for them had already been pruned.",
  });
  console.log(`\n  Wrote ${planned} backfill entries. Read them with: npx tsx scripts/draft-ledger.ts\n`);
} else {
  console.log(`\n  --dry-run: nothing written. ${planned} entries would be recorded.\n`);
}
