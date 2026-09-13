// THE LINK YOU SEND A SOLAR COMPANY ONCE.
//
//   npx tsx scripts/client-portal-link.ts                      list every client and their link
//   npx tsx scripts/client-portal-link.ts --client "TML"       one client, by name or id
//
// The token is minted on first use and never changes, so running this again prints the same URL
// — that is the point, and it means this is safe to run whenever you have lost the email.
import { openDatabase } from "../backend/src/db";
import { ensureClientPortalToken, clientPortalUrl, clientPortalPayload } from "../backend/src/clientPortal";

const argv = process.argv.slice(2);
const want = (() => {
  const i = argv.indexOf("--client");
  return i >= 0 ? String(argv[i + 1] || "").trim().toLowerCase() : "";
})();

const db = await openDatabase();
const clients = db.query<{ id: string; company_name: string }>(
  "SELECT id, company_name FROM clients ORDER BY company_name",
);
const matched = want
  ? clients.filter((c) => c.id.toLowerCase() === want || String(c.company_name || "").toLowerCase().includes(want))
  : clients;

if (!matched.length) {
  console.error(want ? `\nNo client matches "${want}".\n` : "\nNo clients on file.\n");
  db.close();
  process.exit(1);
}

if (!process.env.PUBLIC_BASE_URL) {
  console.warn("\nPUBLIC_BASE_URL is not set, so the links below point at localhost and will not\n"
    + "work off this machine. Set it in .env before sending one to anybody.\n");
}

for (const c of matched) {
  const token = ensureClientPortalToken(db, c.id);
  const payload = clientPortalPayload(db, token);
  const n = payload ? payload.projects.length : 0;
  console.log(`\n${c.company_name}`);
  console.log(`  ${n} project${n === 1 ? "" : "s"}`);
  console.log(`  ${clientPortalUrl(token)}`);
}
console.log("\nThis link is stable — the same URL keeps working as new projects are added.\n");
db.close();
