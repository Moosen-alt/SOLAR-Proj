// LIVE PROBE (not a unit test): replay every real permit_check_targets row through
// ensureCheckTarget on a READ-ONLY BACKUP of the operator's database, and report whether a
// re-confirmation would duplicate or mis-match any filing — plus any rule-5 row (a permit target
// whose URL is a utility interconnection portal).
//
// Moved out of backend/test/trackingTruth.test.ts: a unit test that reads production rows goes red
// whenever the operator's data moves (a fourth target on 1fb3dc39 did exactly that) and skips on
// every other machine. The unit test now pins the same behaviour on a synthetic project.
//
// The live file is never opened for writing: better-sqlite3's online backup reads it read-only and
// the replay runs on the copy. Prints 8-character project ids only — no names, no addresses.
// Always exits 0; read the summary line.
//
//   npx tsx scripts/trackingTruth.live-probe.ts [path/to/autopilot.sqlite]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const livePath = path.resolve(process.argv[2] || "backend/data/autopilot.sqlite");
if (!fs.existsSync(livePath)) {
  console.log(`trackingTruth live probe: NOT RUN — no database at ${livePath}`);
  process.exit(0);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracking-truth-live-"));
const copy = path.join(tmp, "live-copy.sqlite");
const src = new Database(livePath, { readonly: true });
await src.backup(copy);
src.close();

process.env.AUTOPILOT_DB_PATH = copy;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTOPILOT_LOG_FILE = "";
delete process.env.ANTHROPIC_API_KEY;
const { openDatabase } = await import("../backend/src/db");
const { ensureCheckTarget } = await import("../backend/src/submittalTracks");
const { isUtilityPlatformUrl } = await import("../backend/src/portalChannel");
const db = await openDatabase();

interface Row { [k: string]: unknown }
const s = (v: unknown): string => (v == null ? "" : String(v));
const projects = db.query<Row>("SELECT DISTINCT project_id FROM permit_check_targets WHERE active = 1").map((r) => s(r.project_id));
let targets = 0, created = 0, mismatched = 0, rule5 = 0;
for (const projectId of projects) {
  const before = db.query<Row>("SELECT * FROM permit_check_targets WHERE project_id = ? AND active = 1 ORDER BY created_at ASC", [projectId]);
  const project = db.get<Row>("SELECT id, ahj, utility FROM projects WHERE id = ?", [projectId]);
  const record = { id: projectId, ahj: s(project?.ahj), utility: s(project?.utility) } as never;
  const notes: string[] = [];
  for (const t of before) {
    targets++;
    if (s(t.target_type) !== "nem" && (isUtilityPlatformUrl(s(t.portal_url)) || isUtilityPlatformUrl(s(t.tracking_url)))) {
      rule5++;
      notes.push(`target ${s(t.id).slice(0, 8)} is a PERMIT target on a utility interconnection URL (rule 5) — not replayed`);
      continue;
    }
    const result = ensureCheckTarget(db, record, {
      targetType: s(t.target_type) === "nem" ? "nem" : "permit",
      permitType: s(t.permit_type),
      applicationNumber: s(t.application_number),
      permitNumber: s(t.permit_number),
    });
    if (result.created) { created++; notes.push(`target ${s(t.id).slice(0, 8)}: replay CREATED a duplicate`); }
    else if (result.targetId !== s(t.id)) { mismatched++; notes.push(`target ${s(t.id).slice(0, 8)}: replay matched ${result.targetId.slice(0, 8)} (${result.matchedOn}) instead of its own row`); }
  }
  console.log(`${projectId.slice(0, 8)}  ${before.length} active target(s)${notes.length ? "\n    " + notes.join("\n    ") : "  ok"}`);
}
try { db.close(); } catch { /* best effort */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold the file */ }
console.log(`\ntrackingTruth live probe: ${projects.length} project(s), ${targets} active target(s) — ${created} duplicate(s) created, ${mismatched} mis-matched, ${rule5} rule-5 permit target(s) on a utility URL.`);
process.exit(0);
