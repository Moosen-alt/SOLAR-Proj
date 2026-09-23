/**
 * Copy named AHJ form templates (public blank forms + their field maps) into a demo-kit database.
 *
 *   npx tsx scripts/demo-copy-form-templates.ts --from backend/data/autopilot.sqlite \
 *     --to demo-kit/backend/data/autopilot.sqlite --ids 96a92ac4-77c7-4f75-b42e-1474475e883c[,<id>...]
 *
 * WHY. The kit's Coos Bay projects need the City of Coos Bay Building Permit Application: without
 * it the staging document gate honestly refuses the building track, so no Coos Bay/Pacific Power
 * project can reach the later demo stages, and the original Coos Bay project's "clean" QC once
 * rested on an orphaned filled PDF standing in for it.
 *
 * WHY IT IS SAFE. ahj_form_templates is shared knowledge by design (CLAUDE.md): the pdf_blob is the
 * authority's PUBLIC blank form and field_map maps its fields to project data keys. Three columns
 * could carry tenant data in principle — notes, moat_data, and literal values inside field_map — so
 * a row is refused unless notes is empty and moat_data is {}, and every literal in its field map is
 * printed for a person to see before the kit ships. Rows are copied only by explicit id.
 */
import Database from "better-sqlite3";
import fs from "node:fs";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : "";
  if (!v) { console.error(`Missing --${name}`); process.exit(2); }
  return v;
}

const fromPath = arg("from");
const toPath = arg("to");
const ids = arg("ids").split(",").map((s) => s.trim()).filter(Boolean);
for (const p of [fromPath, toPath]) if (!fs.existsSync(p)) { console.error(`No database at ${p}`); process.exit(2); }

const from = new Database(fromPath, { readonly: true, fileMustExist: true });
const to = new Database(toPath, { fileMustExist: true });

// The target must be a demo kit: only the demo company may exist there.
const clients = (to.prepare("SELECT company_name FROM clients").all() as Array<{ company_name: string }>).map((r) => r.company_name);
if (clients.length !== 1 || clients[0] !== "Solaris Demo Co") {
  console.error(`Refusing: the target's clients are ${JSON.stringify(clients)}, not only "Solaris Demo Co".`);
  process.exit(1);
}

const cols = (db: Database.Database): string[] =>
  (db.prepare("PRAGMA table_info(ahj_form_templates)").all() as Array<{ name: string }>).map((c) => c.name);
const toCols = new Set(cols(to));
const shared = cols(from).filter((c) => toCols.has(c));

let copied = 0;
for (const id of ids) {
  const row = from.prepare(`SELECT ${shared.join(", ")} FROM ahj_form_templates WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) { console.error(`  ! ${id}: not found in the source`); process.exitCode = 1; continue; }
  const notes = String(row.notes ?? "").trim();
  const moat = String(row.moat_data ?? "{}").trim();
  if (notes || (moat && moat !== "{}")) {
    console.error(`  ! ${id}: refused — notes/moat_data are not empty, and they can carry tenant data`);
    process.exitCode = 1;
    continue;
  }
  const literals = [...String(row.field_map ?? "").matchAll(/"lit:([^"]*)"/g)].map((m) => m[1]);
  to.prepare(`INSERT OR REPLACE INTO ahj_form_templates (${shared.join(", ")}) VALUES (${shared.map((c) => `@${c}`).join(", ")})`).run(row);
  copied += 1;
  console.log(`  + ${id}  ${row.ahj_name} / ${row.form_type} / ${row.original_filename}`);
  console.log(`      field-map literals (check these are form text, not a customer's): ${literals.length ? JSON.stringify([...new Set(literals)]) : "none"}`);
}
console.log(`[kit] form templates copied: ${copied} of ${ids.length}`);
