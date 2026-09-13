// RECORD A FILING YOU JUST MADE IN THE PORTAL.
//
// Automation never presses final submit — a person does, in the portal, under their licence. This
// is where that fact gets written down: which track, the number the portal gave back, and when it
// actually went in. From that moment the monitor tracks it through to issuance and the client's
// page shows the filing date.
//
//   npx tsx scripts/mark-submitted.ts --project <id|address> --track electrical --app 194-26-001471-ELEC
//   npx tsx scripts/mark-submitted.ts --project 773 --track building --app 187-26-000305-STR --date 2026-09-09
//   npx tsx scripts/mark-submitted.ts --project 773               (show what is outstanding)
//
//   --track   nem | building | electrical | combo | permit | mpu
//   --app     the application/tracking number the portal issued  (--permit, --confirmation too)
//   --date    when it really went in. Omit for today.
//   --by      who filed it. Defaults to your OS user.
//   --url     the portal's own tracking page for this filing
//
// Dry run by default; --apply writes.
import os from "node:os";
import { openDatabase } from "../backend/src/db";
import { markTrackSubmitted, getSubmittalTracks } from "../backend/src/submittalTracks";

const argv = process.argv.slice(2);
const flag = (name: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]).trim() : "";
};
const apply = argv.includes("--apply");
const want = flag("project");
const track = flag("track");

const db = await openDatabase();

if (!want) {
  console.error("\nWhich project? --project <id or part of the address>\n");
  db.close();
  process.exit(1);
}

const matches = db.query<{ id: string; project_address: string; status: string }>(
  `SELECT id, project_address, status FROM projects
    WHERE archived_at = '' AND (id = ? OR lower(project_address) LIKE ?)
    ORDER BY updated_at DESC`,
  [want, `%${want.toLowerCase()}%`],
);
if (!matches.length) {
  console.error(`\nNo project matches "${want}".\n`);
  db.close();
  process.exit(1);
}
if (matches.length > 1) {
  console.error(`\n"${want}" matches ${matches.length} projects — name one:\n`);
  for (const m of matches) console.error(`  ${m.id}  ${m.project_address}  (${m.status})`);
  console.error("");
  db.close();
  process.exit(1);
}
const project = matches[0];

const { getProjectDetail } = await import("../backend/src/repository");
const detail = getProjectDetail(db, project.id);

// No track named: show what this project still owes, which is the question you usually have.
if (!track) {
  console.log(`\n${project.project_address}  (${project.status})\n`);
  for (const t of getSubmittalTracks(db, detail.project)) {
    const when = t.submittedAt ? `filed ${String(t.submittedAt).slice(0, 10)}` : "NOT FILED";
    console.log(`  ${String(t.type).padEnd(11)} ${String(t.status).padEnd(22)} ${when.padEnd(18)} ${t.applicationNumber || ""}`);
  }
  console.log(`\nRecord one with:  --track <type> --app <number> [--date YYYY-MM-DD] --apply\n`);
  db.close();
  process.exit(0);
}

const input = {
  applicationNumber: flag("app"),
  permitNumber: flag("permit"),
  confirmationNumber: flag("confirmation"),
  trackingUrl: flag("url"),
  submittedAt: flag("date"),
  submittedBy: flag("by") || `${os.userInfo().username} (filed in the portal)`,
};

if (!input.applicationNumber && !input.permitNumber && !input.confirmationNumber) {
  // The number is the whole point: without it the monitor has nothing to look up and the client
  // has nothing to quote back to the jurisdiction.
  console.error("\nRefusing: none of --app / --permit / --confirmation given. The number the portal\n"
    + "issued is what the monitor tracks and what the client quotes back to the AHJ.\n");
  db.close();
  process.exit(1);
}

console.log(`\n${project.project_address}`);
console.log(`  track        ${track}`);
console.log(`  application  ${input.applicationNumber || "-"}`);
if (input.permitNumber) console.log(`  permit       ${input.permitNumber}`);
if (input.confirmationNumber) console.log(`  confirmation ${input.confirmationNumber}`);
console.log(`  filed        ${input.submittedAt || "today"}`);
console.log(`  by           ${input.submittedBy}`);

if (!apply) {
  console.log("\nDry run. Nothing was written. Re-run with --apply.\n");
  db.close();
  process.exit(0);
}

try {
  markTrackSubmitted(db, detail.project, track as never, input);
} catch (err) {
  console.error(`\nRefused: ${err instanceof Error ? err.message : String(err)}\n`);
  db.close();
  process.exit(1);
}
console.log("\nRecorded. The monitor will check it on the next sweep, and the client's tracker now\n"
  + "shows the filing date. Check now with:  npx tsx scripts/check-permits-now.ts --all\n");
db.close();
