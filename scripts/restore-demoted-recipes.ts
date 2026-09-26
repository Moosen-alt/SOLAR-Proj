// RESTORE RECIPES A RUN DEMOTED FOR SOMETHING THAT WAS NOT THE RECIPE'S FAULT.
//
// Operator ruling (2026-09-24, docs/HANDOFF.md): the demoted NEM recipes are RESTORED once the
// keep-and-flag classifier lands (portalRecipes.demoteOnReplayFailure), then proven with one
// supervised replay each. Before that fix a failed replay demoted its recipe on
// /recipe step failed/ with no classifier at all — PGE 481c00f4 on a closed browser, PacifiCorp
// 6282e671 on a document-gate refusal — and nothing recorded the demotion.
//
// THE DECISION IS READ FROM THE RECORD, NEVER GUESSED. For every needs_rerecord recipe:
//   1. Find the event that demoted it. New demotions carry a `portal_recipe.demoted` audit row
//      (runId + failureText). Legacy ones (before that row existed) are the failed RecipeAdapter
//      runs whose result says `recipeStale: true` — the old code set it only in the branch that
//      demoted — matched to the recipe by the run's recipe_id when recorded, otherwise by the
//      recipe the run NAMES (its portalName is "Recipe: <ahj|utility> (...)"), the project's
//      state, and the track's scope (nem ↔ utility). The LATEST such event is the demotion.
//   2. Refuse when anything later speaks for the recipe: a human (or gate) mark for re-record
//      (`portal_recipe.marked_for_rerecord`), a re-record or stale-sweep marker in its notes
//      ("[recording interrupted", "[re-record abandoned", "[prev-recipe:"), or no run event at all
//      (a sweep- or human-demoted recipe was never a run's verdict to undo).
//   3. Re-classify the demoting run's OWN failing-step message with the CURRENT classifier
//      (replayFailureBlamesRecipe). "recipe" (drift) stays demoted. "not_recipe" is restored;
//      "unknown" is restored AND flagged for a human — the ruling is keep-and-flag.
//   4. Refuse when another complete recipe already holds the same key and discipline.
// A restore sets status 'complete' (auto_submit_enabled stays 0 — there is no arm), stamps a
// note, and writes a `portal_recipe.restored` audit row naming the run and the reason.
//
// DRY RUN BY DEFAULT, AND THE DRY RUN IS READ-ONLY AT THE DATABASE LEVEL (trust skeptic M5): it
// opens the file with better-sqlite3 readonly — never through openDatabase(), which migrates and
// seeds whatever it opens (a dry run on a production copy used to apply a migration, write two
// knowledge_events rows and refresh 387 KB rows). --apply opens the file plainly (no migrations, no
// seeds either) and REFUSES a database whose schema is older than this code's: the operator's next
// step is openDatabase, so the live DB must already be at this build's schema — i.e. --apply runs
// only AFTER the re-pin, on the migrated live DB (or on a migrated copy to rehearse). A live WAL
// database may refuse a readonly open; dry-run on a .backup copy.
//   AUTOPILOT_DB_PATH=<copy> npx tsx scripts/restore-demoted-recipes.ts            # report only (readonly)
//   AUTOPILOT_DB_PATH=<db>   npx tsx scripts/restore-demoted-recipes.ts --apply    # write (schema must be current)
//   add --json for a machine-readable report.
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AppDb, currentSchemaVersion, latestSchemaVersion } from "../backend/src/db";
import { recipeDisciplineForTrack } from "../backend/src/portalChannel";
import { replayFailureBlamesRecipe, upsertRecipeNote, type ReplayFailureAttribution } from "../backend/src/portalRecipes";
import { extractStageFailureMessage } from "../backend/src/repository";
import { addAuditLog } from "../backend/src/audit";
import { nowIso } from "../backend/src/time";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const json = (v: unknown): Record<string, unknown> => { try { return JSON.parse(s(v) || "{}") as Record<string, unknown>; } catch { return {}; } };

export interface DemotionEvent {
  source: "audit" | "legacy_run";
  runId: string | null;
  at: string;
  failureText: string;
  projectId: string | null;
}

export interface RestoreDecision {
  recipeId: string;
  profileKey: string;
  version: number;
  label: string;
  restore: boolean;
  flag: boolean;
  reason: string;
  event: DemotionEvent | null;
  attribution: ReplayFailureAttribution | null;
}

const RE_RECORD_MARKERS = /\[recording interrupted|\[re-record abandoned|\[prev-recipe:/i;

/** The event that demoted this recipe, from the record: a demotion audit row or a legacy run. */
export function findDemotionEvent(db: AppDb, recipe: Row): DemotionEvent | null {
  const recipeId = s(recipe.id);
  const events: DemotionEvent[] = [];
  for (const a of db.query<Row>(
    "SELECT project_id, details, created_at FROM audit_logs WHERE action = 'portal_recipe.demoted' ORDER BY created_at",
  )) {
    const d = json(a.details);
    if (s(d.recipeId) !== recipeId) continue;
    events.push({ source: "audit", runId: s(d.runId) || null, at: s(a.created_at), failureText: s(d.failureText), projectId: s(a.project_id) || null });
  }
  // Legacy: the old code wrote recipeStale:true only in the branch that demoted the recipe.
  const scopeUtility = s(recipe.scope_type) === "utility";
  const name = (s(recipe.ahj) || s(recipe.utility) || s(recipe.profile_key)).trim().toLowerCase();
  // THE RUN'S TRACK MUST BE THIS RECIPE'S DISCIPLINE (trust skeptic M6). An AHJ holds one recipe
  // per discipline (structural / electrical / combo); a legacy run names only the AHJ, so its
  // permit_type (building → structural, electrical, combo — the one mapper the stage uses) says
  // which sibling it replayed. A trackless run ('permit' / '') could only have replayed a legacy
  // '' row, and a '' recipe beside disciplined siblings is ambiguous — refused, never guessed.
  const siblingKeys = scopeUtility ? 0 : Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_recipes WHERE profile_key = ?", [s(recipe.profile_key)])?.n ?? 0);
  const disciplineMatches = (permitType: string): boolean => {
    if (scopeUtility) return true;
    const runDiscipline = recipeDisciplineForTrack(permitType);
    const own = s(recipe.discipline);
    if (runDiscipline) return own === runDiscipline;
    // trackless legacy run: only a '' recipe, and only when it is the sole recipe on its key
    return own === "" && siblingKeys <= 1;
  };
  // THE DATABASE MAY BE OLDER THAN THIS CODE (close M5-real-schema). The dry run is for a .backup
  // of production taken under the pinned server — schema v34, before migration v35 added
  // portal_runs.recipe_id. Asking for the column there threw "no such column: pr.recipe_id" and
  // the dry run exited 1. Its absence means no run recorded its recipe: every run is matched the
  // legacy way (by the recipe it names), which is exactly what those runs need. Still readonly.
  const runColumns = new Set(db.query<{ name: string }>("PRAGMA table_info(portal_runs)").map((c) => s(c.name)));
  const recipeIdColumn = runColumns.has("recipe_id") ? "pr.recipe_id" : "NULL AS recipe_id";
  const runs = db.query<Row>(
    `SELECT pr.id, pr.project_id, pr.permit_type, pr.started_at, pr.finished_at, pr.result_json, ${recipeIdColumn}, p.state
       FROM portal_runs pr LEFT JOIN projects p ON p.id = pr.project_id
      WHERE pr.status = 'failed'
        AND json_extract(pr.result_json, '$.actor') = 'RecipeAdapter'
        AND json_extract(pr.result_json, '$.recipeStale') = 1
      ORDER BY pr.started_at`,
  );
  for (const r of runs) {
    const result = json(r.result_json);
    let matches: boolean;
    if (s(r.recipe_id)) {
      matches = s(r.recipe_id) === recipeId;
    } else {
      const named = (s(result.portalName).match(/^Recipe:\s*(.+?)\s*\([^()]*\)\s*$/)?.[1] ?? "").trim().toLowerCase();
      const trackIsUtility = s(r.permit_type) === "nem";
      matches = Boolean(named) && named === name
        && trackIsUtility === scopeUtility
        && disciplineMatches(s(r.permit_type))
        && s(r.state).trim().toLowerCase() === s(recipe.state).trim().toLowerCase()
        && s(r.started_at) >= s(recipe.created_at);
    }
    if (!matches) continue;
    // The same demotion already read from its audit row (which carries the exact text) — not twice.
    if (events.some((e) => e.source === "audit" && e.runId === s(r.id))) continue;
    events.push({
      source: "legacy_run", runId: s(r.id), at: s(r.finished_at) || s(r.started_at),
      failureText: extractStageFailureMessage(result), projectId: s(r.project_id) || null,
    });
  }
  events.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  return events.length ? events[events.length - 1] : null;
}

/** Decide, for every needs_rerecord recipe, whether a restore is warranted — and why. */
export function planRecipeRestores(db: AppDb): RestoreDecision[] {
  const out: RestoreDecision[] = [];
  for (const recipe of db.query<Row>("SELECT * FROM portal_recipes WHERE status = 'needs_rerecord' ORDER BY updated_at DESC")) {
    const base = {
      recipeId: s(recipe.id), profileKey: s(recipe.profile_key), version: Number(recipe.version ?? 1),
      label: `${s(recipe.scope_type)} ${s(recipe.scope_type) === "utility" ? s(recipe.utility) : s(recipe.ahj)} (${s(recipe.state)})`,
    };
    const decide = (restore: boolean, reason: string, event: DemotionEvent | null, attribution: ReplayFailureAttribution | null = null, flag = false): void => {
      out.push({ ...base, restore, flag, reason, event, attribution });
    };
    const event = findDemotionEvent(db, recipe);
    if (!event) { decide(false, "no run demoted it (no demotion audit row and no stale-flagged replay of it) — a sweep or a person did; not a run's verdict to undo", null); continue; }
    if (RE_RECORD_MARKERS.test(s(recipe.notes))) { decide(false, "its notes show a re-record or stale-recording sweep — the replayed steps are not what is in the row now", event); continue; }
    const humanMark = db.query<Row>(
      "SELECT created_at, actor_name, details FROM audit_logs WHERE action = 'portal_recipe.marked_for_rerecord' ORDER BY created_at DESC",
    ).find((a) => s(json(a.details).recipeId) === base.recipeId && s(a.created_at) >= event.at);
    if (humanMark) { decide(false, `marked for re-record by ${s(humanMark.actor_name) || "a person"} at ${s(humanMark.created_at)}, after the run — a human decision is never undone here`, event); continue; }
    const verdict = replayFailureBlamesRecipe(event.failureText);
    if (verdict.attribution === "recipe") { decide(false, `the current classifier still blames the recipe: ${verdict.reason}`, event, verdict.attribution); continue; }
    const rival = db.get<Row>(
      "SELECT id FROM portal_recipes WHERE profile_key = ? AND discipline = ? AND status = 'complete' AND id != ? LIMIT 1",
      [s(recipe.profile_key), s(recipe.discipline), base.recipeId],
    );
    if (rival) { decide(false, `another complete recipe (${s(rival.id).slice(0, 8)}) already holds this key — restoring would put two on it`, event, verdict.attribution); continue; }
    decide(true, verdict.attribution === "unknown"
      ? `nobody can attribute the failure (${verdict.reason}) — restored AND flagged for a human (keep-and-flag)`
      : `not the recipe's fault: ${verdict.reason}`, event, verdict.attribution, verdict.attribution === "unknown");
  }
  return out;
}

/** Apply the restores a plan approved. Only a row still needs_rerecord at the planned version moves. */
export function applyRecipeRestores(db: AppDb, plan: RestoreDecision[], actor = "restore-demoted-recipes script"): string[] {
  const restored: string[] = [];
  for (const d of plan.filter((p) => p.restore)) {
    const row = db.get<Row>("SELECT notes FROM portal_recipes WHERE id = ? AND status = 'needs_rerecord' AND version = ?", [d.recipeId, d.version]);
    if (!row) continue;
    const now = nowIso();
    const note = `[restored ${now.slice(0, 10)}: demoted by run ${s(d.event?.runId).slice(0, 8) || "?"} on "${s(d.event?.failureText).slice(0, 120)}" — ${d.reason}]`;
    db.transaction(() => {
      db.run(
        `UPDATE portal_recipes SET status = 'complete', auto_submit_enabled = 0,
           flag_reason = CASE WHEN ? = 1 THEN ? ELSE flag_reason END,
           flagged_at = CASE WHEN ? = 1 THEN ? ELSE flagged_at END,
           notes = ?, updated_at = ?
         WHERE id = ? AND status = 'needs_rerecord' AND version = ?`,
        [d.flag ? 1 : 0, `Restored after an unattributed replay failure — prove it with one supervised replay: ${s(d.event?.failureText).slice(0, 160)}`,
          d.flag ? 1 : 0, now, upsertRecipeNote(row.notes, "restored", note), now, d.recipeId, d.version],
      );
      addAuditLog(db, d.event?.projectId ?? null, "human", actor, "portal_recipe.restored", {
        recipeId: d.recipeId, version: d.version, runId: d.event?.runId ?? null, evidence: d.event?.source ?? null,
        failureText: s(d.event?.failureText).slice(0, 300), attribution: d.attribution, flagged: d.flag, reason: d.reason,
      });
    });
    restored.push(d.recipeId);
  }
  return restored;
}

/**
 * OPEN WITHOUT MIGRATING OR SEEDING. Dry run: readonly at the SQLite level (a write anywhere throws).
 * --apply: a plain read-write handle, refused unless the file is already at this build's schema —
 * the operator's next openDatabase() must find nothing to migrate.
 */
export function openForScript(dbPath: string, apply: boolean): AppDb {
  const probe = new AppDb(new Database(dbPath, { readonly: true, fileMustExist: true }));
  const have = currentSchemaVersion(probe);
  const want = latestSchemaVersion();
  if (!apply) return probe;
  probe.close();
  if (have !== want) {
    console.error(`Refusing --apply: ${dbPath} is at schema v${have}, this code expects v${want}. Run --apply only after the re-pin (the server has migrated the live DB), or on a migrated copy. Nothing was written.`);
    process.exit(2);
  }
  const rw = new Database(dbPath, { fileMustExist: true });
  rw.pragma("busy_timeout = 5000");
  return new AppDb(rw);
}

// ---------------------------------------------------------------------------------------------
// CLI — only when invoked directly (the test imports the functions without side effects).
// ---------------------------------------------------------------------------------------------
const invokedDirectly = ((): boolean => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch { return false; }
})();

if (invokedDirectly) {
  const apply = process.argv.includes("--apply");
  const asJson = process.argv.includes("--json");
  if (!process.env.AUTOPILOT_DB_PATH) {
    console.error("Set AUTOPILOT_DB_PATH to the database to read (for production: a .backup copy first).");
    process.exit(2);
  }
  const dbPath = path.resolve(process.env.AUTOPILOT_DB_PATH);
  const db = openForScript(dbPath, apply);
  const plan = planRecipeRestores(db);
  if (asJson) {
    console.log(JSON.stringify({ apply, db: process.env.AUTOPILOT_DB_PATH, plan }, null, 2));
  } else {
    console.log(`${apply ? "APPLYING" : "DRY RUN (no writes; add --apply)"} — ${plan.length} needs_rerecord recipe(s) in ${process.env.AUTOPILOT_DB_PATH}`);
    for (const d of plan) {
      const ev = d.event ? `${d.event.source} ${s(d.event.runId).slice(0, 8)} @ ${d.event.at}: "${d.event.failureText.slice(0, 140)}"` : "(no demoting run)";
      console.log(`\n${d.restore ? (d.flag ? "RESTORE+FLAG" : "RESTORE") : "keep demoted"}  ${d.recipeId.slice(0, 8)}  ${d.label}  v${d.version}\n  event:  ${ev}\n  reason: ${d.reason}`);
    }
    const n = plan.filter((d) => d.restore).length;
    console.log(`\n${n} of ${plan.length} would be restored.`);
  }
  if (apply) {
    const restored = applyRecipeRestores(db, plan);
    console.log(`Restored ${restored.length}: ${restored.map((r) => r.slice(0, 8)).join(", ") || "(none)"}`);
  }
  process.exit(0);
}
