// ---------------------------------------------------------------------------
// MAKE THE KIT PORTABLE. Run this before the server, every launch.
//
// project_documents.stored_path is an ABSOLUTE path, written when the document
// was saved. That is fine for a server that lives at one path forever, and fatal
// for a kit that travels: the moment this folder is copied to E:\ or to another
// user's Desktop, every stored_path points at a directory that does not exist on
// this machine.
//
// The failure is silent and it looks like a product bug, which is what makes it
// worth a dedicated script. projectDocsByType does:
//
//     if (t && p && !out[t] && fs.existsSync(p)) out[t] = p;
//
// so an unresolvable path is not an error — the document simply stops existing.
// The board still lists 8 documents (those rows are read straight from the DB),
// but the required-document gate reports every one of them missing, and the demo
// shows a wall of red asserting the site plan is not attached while the site plan
// is sitting right there in the documents list. Measured, not theorised: that is
// exactly what this kit did before this script existed.
//
// The repair is mechanical. Every document lives at
//   <kit>/backend/data/project-documents/<project_id>/<basename>
// so we rebuild the path from THIS folder and keep the basename. Idempotent:
// running it when everything already resolves rewrites nothing.
// ---------------------------------------------------------------------------
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const KIT = process.cwd();
const DB_FILE = path.join(KIT, "backend", "data", "autopilot.sqlite");
const DOCS_DIR = path.join(KIT, "backend", "data", "project-documents");

if (!fs.existsSync(DB_FILE)) {
  console.error(`No database at ${DB_FILE}. Run this from the kit folder.`);
  process.exit(1);
}

const db = new Database(DB_FILE);
const rows = db.prepare("SELECT id, project_id, stored_path FROM project_documents").all();
const update = db.prepare("UPDATE project_documents SET stored_path = ? WHERE id = ?");

let fixed = 0, already = 0, missing = 0;
const fixMissing = [];

for (const r of rows) {
  const want = path.join(DOCS_DIR, r.project_id, path.basename(r.stored_path));
  if (r.stored_path === want && fs.existsSync(want)) { already++; continue; }
  if (!fs.existsSync(want)) { missing++; fixMissing.push(want); continue; }
  update.run(want, r.id);
  fixed++;
}

// A row whose FILE is genuinely absent is a different problem from a row whose
// PATH is stale, and conflating them is how the silent failure survived. Say so.
console.log(`[kit] document paths: ${fixed} repaired, ${already} already correct, ${missing} file missing`);
if (missing) {
  console.error(`[kit] ${missing} document file(s) are not on disk — the kit is incomplete, not just relocated:`);
  for (const p of fixMissing.slice(0, 5)) console.error(`        ${p}`);
  process.exitCode = 1;
}

db.close();
