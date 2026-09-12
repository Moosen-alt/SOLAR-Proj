process.env.AUTOPILOT_DB_PATH = "backend/data/autopilot.sqlite";
const { openDatabase } = await import("../backend/src/db");
const db = await openDatabase();
const rows = db.query<any>("SELECT id, profile_key, discipline, status, steps_json FROM portal_recipes WHERE profile_key LIKE '%coos%'", []);
for (const r of rows) {
  const steps = JSON.parse(r.steps_json || "[]");
  console.log(`\n=== ${r.profile_key} discipline=${r.discipline||"-"} status=${r.status} steps=${steps.length}`);
  for (const s of steps) {
    const label = String(s?.selector?.label ?? s?.note ?? "");
    if (/kva|kw|renewable|fee|qty|quantity/i.test(label) || /kva/i.test(String(s?.fingerprint?.id ?? ""))) {
      console.log(`  ${s.action} | label=${JSON.stringify(label.slice(0,70))} | field=${s.field ?? "-"} | value=${JSON.stringify(s.value ?? "")} | id=${String(s?.fingerprint?.id ?? "").slice(-28)}`);
    }
  }
}
