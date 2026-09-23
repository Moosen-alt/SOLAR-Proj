/**
 * Copy the published fee schedules into a demo-kit database.
 *
 *   npx tsx scripts/demo-copy-fee-schedules.ts --from backend/data/autopilot.sqlite \
 *     --to demo-kit/backend/data/autopilot.sqlite
 *
 * WHY THE KIT NEEDS THIS. Fee schedules are learned by LLM research, and the kit runs with no
 * API key on purpose — so every fee_research job in the kit correctly refuses, and every fee
 * sheet in the demo read "NEM / interconnection — UNKNOWN" and a 1.5%-of-valuation permit
 * ESTIMATE, for utilities whose real answer ($0, by Oregon rule) production already knows.
 *
 * WHY IT IS SAFE TO COPY. fee_schedules is shared knowledge (CLAUDE.md): each row is a
 * jurisdiction's or utility's PUBLISHED schedule with its public source URL and quote. It has
 * no project, client, org or homeowner column — nothing in it can put a real customer in
 * front of a prospect. Rows keep their `seeded`/`verified` confidence as-is.
 *
 * Idempotent: rows are keyed by id, and a re-run replaces them with the source's current copy.
 */
import Database from "better-sqlite3";
import fs from "node:fs";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : "";
  if (!v) { console.error(`Missing --${name} <sqlite path>`); process.exit(2); }
  if (!fs.existsSync(v)) { console.error(`No database at ${v}`); process.exit(2); }
  return v;
}

const from = new Database(arg("from"), { readonly: true });
const to = new Database(arg("to"));

const cols = (db: Database.Database): string[] =>
  (db.prepare("PRAGMA table_info(fee_schedules)").all() as Array<{ name: string }>).map((c) => c.name);
const fromCols = cols(from);
const toCols = new Set(cols(to));
if (!fromCols.length || !toCols.size) {
  console.error("fee_schedules is missing on one side — start the server once against the kit DB so migrations run.");
  process.exit(1);
}
// Only columns both schemas have: a kit built on an older migration must still take the rows.
const shared = fromCols.filter((c) => toCols.has(c));
const rows = from.prepare(`SELECT ${shared.join(", ")} FROM fee_schedules`).all() as Array<Record<string, unknown>>;
const insert = to.prepare(
  `INSERT OR REPLACE INTO fee_schedules (${shared.join(", ")}) VALUES (${shared.map((c) => `@${c}`).join(", ")})`,
);
to.transaction(() => { for (const r of rows) insert.run(r); })();

const byTrack = to.prepare("SELECT track, COUNT(*) AS n FROM fee_schedules GROUP BY track").all();
console.log(`[kit] fee schedules copied: ${rows.length} — now in kit:`, byTrack);
