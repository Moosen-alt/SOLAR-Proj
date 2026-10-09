// SAFETY RULE 2 — which values on a project are secrets. A LEAF module (types and the db handle
// only): the planner (autoLearn), the evidence reader (projectEvidence) and the vision pass
// (reviewerVision) all scrub with these, and reaching them through autoLearn pulled the
// Playwright / llm / portalRecipes graph into every reader and made an import cycle (#260 review).
import type { ProjectRecord } from "../../shared/src/types";
import type { AppDb } from "./db";

// Which parser/field keys hold a secret. ONE predicate for the planner's key filter and for
// collecting the values to redact from free text. Who HOLDS the account (ubAccountHolder*) is
// identity the portal asks for, not a secret (see buildPortalPlanner).
const PLANNER_SECRET_KEY = /acc(oun)?t|meter|ssn|social|passw|agreement\s*num|application\s*num|agreementnumber|applicationnumber|\besi\b|esiid|service\s*agreement/i;
const PLANNER_IDENTITY_KEY = /^ubAccountHolder/i;
export function isPlannerSecretKey(k: string): boolean {
  return PLANNER_SECRET_KEY.test(k) && !PLANNER_IDENTITY_KEY.test(k);
}

/** Every known secret on the project: the canonical account/meter plus any parser-snapshot
 *  value under a secret key (the parser's own aliases: "account", "meter", "ubMeterNumber"...). */
export function projectSecretValues(project: Pick<ProjectRecord, "accountNumber" | "meterNumber" | "parserSnapshot">): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const s = v == null ? "" : String(v).trim();
    if (s.length >= 4) out.add(s);
  };
  add(project.accountNumber);
  add(project.meterNumber);
  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(snap)) {
    if ((typeof v === "string" || typeof v === "number") && isPlannerSecretKey(k)) add(v);
  }
  return [...out];
}

/** The same values read straight off the project row, for a caller that holds only the id.
 *  null when the row or its parser snapshot cannot be read — the caller fails closed. */
export function projectSecretValuesById(db: AppDb, projectId: string): string[] | null {
  try {
    const row = db.get<{ account_number: string; meter_number: string; parser_json: string }>(
      "SELECT account_number, meter_number, parser_json FROM projects WHERE id = ?", [projectId]);
    if (!row) return null;
    const parserSnapshot = row.parser_json ? JSON.parse(row.parser_json) : {};
    return projectSecretValues({ accountNumber: row.account_number, meterNumber: row.meter_number, parserSnapshot });
  } catch {
    return null;
  }
}
