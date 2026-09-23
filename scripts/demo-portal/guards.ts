// ---------------------------------------------------------------------------
// REFUSALS SHARED BY THE DEMO SCRIPTS.
//
// Pure checks over a database handle or a code tree, so each can be proven to refuse without a
// browser, a portal or a seeding run. No backend module is imported here (callers load this
// ahead of their network trap).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

/** The one company every demo script creates, and the only one a demo database may hold. */
export const DEMO_COMPANY = "Solaris Demo Co";
/** Every demo project's ZIP — deliberately invalid, so no demo row reads as a real filing. */
export const DEMO_ZIP = "99999";

export interface ReadDb {
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null | undefined;
}

/** A demo database holds the demo company and NOTHING ELSE. Any other client means real
 *  customers live here (production, or a copy of it). */
export function demoOnlyDatabaseProblem(db: ReadDb): string | null {
  const demo = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM clients WHERE company_name = ?", [DEMO_COMPANY]);
  const others = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM clients WHERE company_name IS NULL OR company_name <> ?", [DEMO_COMPANY]);
  const nDemo = Number(demo?.n ?? 0);
  const nOther = Number(others?.n ?? 0);
  if (nDemo === 0) return `this database has no "${DEMO_COMPANY}" company — it is not a demo kit database.`;
  if (nOther > 0) return `this database holds ${nOther} client(s) besides "${DEMO_COMPANY}" — it is not a demo-only database, and real customers may live here.`;
  return null;
}

/** The project must exist, belong to the demo company, and carry the demo ZIP. A --project id
 *  copied from a production board must be impossible to record against. */
export function demoProjectProblem(db: ReadDb, projectId: string): string | null {
  const row = db.get<{ company_name: string | null; zip: string | null }>(
    "SELECT c.company_name AS company_name, p.zip AS zip FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = ?",
    [projectId],
  );
  if (!row) return `project ${projectId} does not exist in this database.`;
  if (String(row.company_name ?? "") !== DEMO_COMPANY) return `project ${projectId} does not belong to "${DEMO_COMPANY}" — only a synthetic demo project may be recorded.`;
  if (String(row.zip ?? "").trim() !== DEMO_ZIP) return `project ${projectId} does not carry the demo ZIP ${DEMO_ZIP} — only a synthetic demo project may be recorded.`;
  return null;
}

/** The offline gates a demo seeding run depends on, by the marker each file must carry. */
export const OFFLINE_GATE_MARKERS: Array<{ file: string; marker: string; what: string }> = [
  { file: path.join("backend", "src", "autopilot.ts"), marker: "portalAutomationDisabled", what: "PORTAL_AUTOMATION=off stops the autopilot before any portal" },
  { file: path.join("backend", "src", "ahjForms.ts"), marker: "documentFetchDisabled", what: "DOCUMENT_FETCH=off stops form downloads" },
];

/** Null when every gate is present in the code tree at `codeRoot`; otherwise what is missing. */
export function offlineGatesProblem(codeRoot: string): string | null {
  const missing: string[] = [];
  for (const g of OFFLINE_GATE_MARKERS) {
    const file = path.join(codeRoot, g.file);
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { missing.push(`${g.file} is missing`); continue; }
    if (!text.includes(g.marker)) missing.push(`${g.file} lacks ${g.marker} (${g.what})`);
  }
  return missing.length
    ? `the backend code this script runs (${codeRoot}) lacks the offline gates: ${missing.join("; ")}. Update that tree before seeding a demo with it.`
    : null;
}
