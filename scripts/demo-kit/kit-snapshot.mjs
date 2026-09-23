// ---------------------------------------------------------------------------
// A DEMO YOU CAN RUN TWICE.
//
// A good demo is one where the presenter clicks things: captures a confirmation on the
// Submit project, pastes a permit status on the Track project, uploads a blank form. Every
// one of those clicks changes the database, and the next audience would see the last
// audience's demo. Deleting rows by hand is how a demo drifts — the later-stage projects
// also teach the knowledge base (a Salem timeline "learned" from simulated filings), which no
// row-level reset removes.
//
// So the reset is a SNAPSHOT, not a cleanup: the whole mutable state of the kit — the
// database and the four data folders the product writes into — is saved once, when the kit
// is known-good, and restored wholesale.
//
//   node kit-snapshot.mjs save      after a verified build (server STOPPED)
//   node kit-snapshot.mjs restore   before every showing   (server STOPPED)
//   node kit-snapshot.mjs status    what the snapshot holds
//
// Run from the kit folder. RESET-DEMO.cmd runs `restore` and then starts the demo.
// ---------------------------------------------------------------------------
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const KIT = process.cwd();
const DATA = path.join(KIT, "backend", "data");
const DB_FILE = path.join(DATA, "autopilot.sqlite");
const SNAP = path.join(DATA, "pristine");
const SNAP_DB = path.join(SNAP, "autopilot.sqlite");
const MANIFEST = path.join(SNAP, "SNAPSHOT.json");
// Every folder the running product writes into. `backups` and `logs` are deliberately absent:
// they are the product's own housekeeping, not demo state.
const DIRS = ["filled", "project-documents", "ahj-forms", "page-images"];

const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1); };

function kitPort() {
  try {
    const env = fs.readFileSync(path.join(KIT, ".env"), "utf8");
    const m = /^PORT=(\d+)/m.exec(env);
    return m ? Number(m[1]) : 4270;
  } catch { return 4270; }
}

// SQLite under a live server is a moving target, and a restore underneath one leaves the
// server holding a deleted file. Refuse rather than guess.
function serverRunning(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(800, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function summarize(dbFile) {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT homeowner_name AS owner, ahj, status FROM projects ORDER BY created_at").all();
    const clients = db.prepare("SELECT company_name FROM clients").all().map((r) => r.company_name);
    return { projects: rows, clients };
  } finally { db.close(); }
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
  else fs.mkdirSync(to, { recursive: true });
}

async function save() {
  if (!fs.existsSync(DB_FILE)) die(`No database at ${DB_FILE}. Run this from the kit folder.`);
  if (await serverRunning(kitPort())) die("The demo server is running. Close its window first, then save.");
  const summary = summarize(DB_FILE);
  // The same guard the kit's whole existence rests on: a snapshot is only ever of a kit that
  // holds nothing but the demo company.
  if (summary.clients.length !== 1 || summary.clients[0] !== "Solaris Demo Co") {
    die(`Refusing to snapshot: this database's clients are ${JSON.stringify(summary.clients)}, not only "Solaris Demo Co".`);
  }
  fs.rmSync(SNAP, { recursive: true, force: true });
  fs.mkdirSync(SNAP, { recursive: true });
  // VACUUM INTO writes a consistent, WAL-free copy — no -wal/-shm to forget.
  const db = new Database(DB_FILE, { fileMustExist: true });
  try { db.prepare("VACUUM INTO ?").run(SNAP_DB); } finally { db.close(); }
  for (const d of DIRS) copyDir(path.join(DATA, d), path.join(SNAP, d));
  const manifest = { savedAt: new Date().toISOString(), dbSha256: sha256(SNAP_DB), dirs: DIRS, ...summary };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`\n  Snapshot saved: ${summary.projects.length} projects.`);
  for (const p of summary.projects) console.log(`    ${p.status.padEnd(22)} ${p.owner} — ${p.ahj}`);
}

async function restore() {
  if (!fs.existsSync(SNAP_DB) || !fs.existsSync(MANIFEST)) {
    die("There is no snapshot in this kit (backend/data/pristine). It was never saved — rebuild the kit or run `node kit-snapshot.mjs save` on a known-good kit.");
  }
  if (await serverRunning(kitPort())) die("The demo server is running. Close its window first, then reset.");
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  if (sha256(SNAP_DB) !== manifest.dbSha256) die("The snapshot database does not match its manifest — the snapshot is damaged. Rebuild the kit.");
  for (const f of ["autopilot.sqlite", "autopilot.sqlite-wal", "autopilot.sqlite-shm"]) fs.rmSync(path.join(DATA, f), { force: true });
  fs.copyFileSync(SNAP_DB, DB_FILE);
  for (const d of DIRS) copyDir(path.join(SNAP, d), path.join(DATA, d));
  const now = summarize(DB_FILE);
  console.log(`\n  Demo reset to the snapshot from ${manifest.savedAt.slice(0, 16).replace("T", " ")} UTC: ${now.projects.length} projects.`);
}

function status() {
  if (!fs.existsSync(MANIFEST)) { console.log("\n  No snapshot saved in this kit."); return; }
  const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  console.log(`\n  Snapshot from ${m.savedAt}: ${m.projects.length} projects, client ${m.clients.join(", ")}`);
  for (const p of m.projects) console.log(`    ${p.status.padEnd(22)} ${p.owner} — ${p.ahj}`);
}

const cmd = process.argv[2];
if (cmd === "save") await save();
else if (cmd === "restore") await restore();
else if (cmd === "status") status();
else die("Usage: node kit-snapshot.mjs save | restore | status   (run from the kit folder, server stopped)");
