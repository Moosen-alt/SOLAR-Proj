import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = "backend/data/autopilot.sqlite";
const { openDatabase } = await import("./backend/src/db");
const db = await openDatabase();
const rows = db.prepare(
  "SELECT portal_type, portal_url, username_reference, notes, last_login_ok_at, last_login_note FROM portal_credentials WHERE portal_url LIKE '%miami%' OR portal_type LIKE '%miami%'",
).all() as Array<Record<string, unknown>>;
for (const r of rows) console.log(JSON.stringify(r, null, 1));
console.log("rows:", rows.length);
const kb = db.prepare("SELECT profile_key, portal_url, notes FROM permit_utility_knowledge WHERE profile_key LIKE '%miami%' OR portal_url LIKE '%miami%'").all() as Array<Record<string, unknown>>;
for (const k of kb) console.log("KB:", k.profile_key, "->", k.portal_url);
