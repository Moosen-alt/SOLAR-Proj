// WHICH PROJECTS CARRY A CANONICAL ALIAS THAT DISAGREES WITH ITS SOURCE? (#238)
//
//   npx tsx scripts/diverged-aliases.ts            # every org
//   npx tsx scripts/diverged-aliases.ts --org <id> # one org (or --org=<id>)
//
// Before #225 (updateProject) and #238 (the review queue), editing invModel/invQty/… left the
// derived inverterModel/inverterQuantity/… behind. Such a stored alias now differs from its source,
// so every edit door keeps it as if an operator had set it — and nothing can tell the two apart.
// This lists them for a person to review. READ-ONLY: it never writes. To fix a row, edit the
// project and send the alias itself (or the source, after clearing the alias).
//
// Prints 8-char project ids and equipment/rating values only; the homeowner phone alias is not
// part of the report (divergedAliases skips it).
import "dotenv/config";

// A BARE --org IS A MISTAKE, NOT "EVERY ORG" (#270). It used to map to null, which reads across all
// tenants — the opposite of what the operator asked for. Both spellings (`--org <id>`, `--org=<id>`)
// are read; an empty id, a repeated --org, or any argument this script doesn't know is a usage error,
// so nothing an operator mistypes can widen the read. Refused before the database is opened.
const usage = (why: string): never => {
  console.error(`${why}\nusage: npx tsx scripts/diverged-aliases.ts [--org <id> | --org=<id>]   (omit --org for every org)`);
  process.exit(2);
};
const argv = process.argv.slice(2);
let orgId: string | null = null;
let orgSeen = false;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  let value: string | undefined;
  if (arg === "--org") value = argv[++i];
  else if (arg.startsWith("--org=")) value = arg.slice("--org=".length);
  else usage(`unknown argument: ${arg}`);
  if (orgSeen) usage("--org given more than once");
  if (value === undefined || value.trim() === "" || value.startsWith("--")) usage("--org needs an org id");
  orgSeen = true;
  orgId = value!.trim();
}

process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";
const { openDatabase } = await import("../backend/src/db");
const { listDivergedAliasProjects } = await import("../backend/src/repository");

const db = await openDatabase();
const rows = listDivergedAliasProjects(db, orgId);
if (!rows.length) console.log("No project has a canonical alias that differs from its source.");
for (const row of rows) {
  console.log(`${row.projectId.slice(0, 8)}  [${row.status}]`);
  for (const a of row.aliases) console.log(`    ${a.key.padEnd(22)} stored "${a.stored}"  ≠  derived "${a.derived}"`);
}
console.log(`\n${rows.length} project(s) to review. Nothing was changed.`);
db.close();
