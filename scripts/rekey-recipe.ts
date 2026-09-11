// MOVE A RECIPE TO THE KEY PRODUCTION ACTUALLY RESOLVES.
//
// The verified Ameren recipe (v21, 79 steps, "Auto-learned and verified") was banked by the
// benchmark under an AHJ-scoped key — "il|benchmark amerenillinoisinterconnect powerclerk
// com|ameren illinois" — while a REAL NEM project resolves scopeType "utility" and therefore
// the key "il|unknown|ameren illinois", which holds v6 (75 steps, "Auto-learned but NOT
// verified"). Production could never see the recipe the benchmark verified. Commit 07c79eb
// fixed the NEXT learn's banking; this script moves the EXISTING verified row so an honest
// live test can replay it today.
//
// It refuses to make things worse:
//   - a COMPLETE occupant of the target key with MORE steps or an affirmative "verified"
//     note is never overwritten or demoted (CLAUDE.md rule 3's spirit);
//   - a recipe whose portal_url is not a utility platform is never re-keyed onto a utility
//     key (rule 5 — that would put a PERMIT recipe where the NEM track resolves it);
//   - a recipe whose OWN state/utility resolve a different utility key is refused — you
//     cannot file Ameren's recipe under ComEd's key by typo. (Known limit: a row whose
//     stored utility SPELLING diverges from the target's is refused too; acceptable, since
//     findRecipeByNameAlias bridges spelling at lookup time.)
//
// A worse COMPLETE occupant (fewer steps, unverified — the Ameren v6 case) is demoted to
// needs_rerecord only under the explicit --demote-existing flag.
//
// THIS SCRIPT WRITES THE LIVE DB BY DEFAULT — that is its purpose. Run --dry-run FIRST:
//
//   npx tsx scripts/rekey-recipe.ts --id <recipeId> --to-utility "<state>|<utility>" --dry-run
//   npx tsx scripts/rekey-recipe.ts --id <recipeId> --to-utility "<state>|<utility>" [--demote-existing]
//
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDb } from "../backend/src/db";
import { recipeProfileKey, mergeRecipeNotes, recipeNoteSegments, findCompleteRecipeForProject } from "../backend/src/portalRecipes";
import { isUtilityPlatformUrl } from "../backend/src/portalChannel";
import { nowIso } from "../backend/src/time";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** Does this notes column AFFIRMATIVELY claim verification? "Auto-learned but NOT verified"
 *  and "unverified" both contain the word — the opposite claim wearing the same letters —
 *  so a substring test on "verified" would protect exactly the rows that need replacing. */
export function notesSayVerified(notes: unknown): boolean {
  return recipeNoteSegments(notes).some((seg) => {
    const t = seg.toLowerCase();
    if (!t.includes("verified")) return false;
    return !/\bnot\s+verified\b/.test(t) && !/\bunverified\b/.test(t);
  });
}

const stepCount = (row: Row): number => {
  try { return (JSON.parse(s(row.steps_json) || "[]") as unknown[]).length; } catch { return 0; }
};

const describeRow = (row: Row): string => {
  const firstNote = recipeNoteSegments(row.notes)[0] ?? "(no notes)";
  return [
    `id       ${s(row.id)}`,
    `key      ${s(row.profile_key)}   scope=${s(row.scope_type)}   discipline=${s(row.discipline) || "(none)"}`,
    `status   ${s(row.status)}   v${Number(row.version ?? 1)}   ${stepCount(row)} step(s)`,
    `portal   ${s(row.portal_url)}`,
    `notes    ${firstNote}`,
  ].join("\n  ");
};

export interface RekeyResult {
  action: "moved" | "noop" | "refused" | "dry-run";
  reason?: string;
  targetKey?: string;
  /** Occupant ids demoted to needs_rerecord (empty unless --demote-existing did work). */
  demoted?: string[];
}

export function rekeyRecipe(
  db: AppDb,
  opts: { recipeId: string; toState: string; toUtility: string; demoteExisting?: boolean; dryRun?: boolean; log?: (line: string) => void },
): RekeyResult {
  const log = opts.log ?? (() => {});
  const refuse = (reason: string): RekeyResult => { log(`REFUSED: ${reason}`); return { action: "refused", reason }; };

  // Exact id first; a unique prefix is accepted so operators can paste the short form.
  let row = db.get<Row>("SELECT * FROM portal_recipes WHERE id = ?", [opts.recipeId]);
  if (!row) {
    const matches = db.query<Row>("SELECT * FROM portal_recipes WHERE id LIKE ?", [`${opts.recipeId}%`]);
    if (matches.length === 1) row = matches[0];
    else if (matches.length > 1) return refuse(`recipe id prefix "${opts.recipeId}" matches ${matches.length} rows — use the full id.`);
  }
  if (!row) return refuse(`no portal_recipes row with id ${opts.recipeId}.`);

  log(`Recipe to re-key:\n  ${describeRow(row)}`);

  const targetKey = recipeProfileKey({ scopeType: "utility", state: opts.toState, utility: opts.toUtility, ahj: "" });
  log(`Target utility key: ${targetKey}`);

  // The row's OWN identity must resolve the same key — this is what stops a typo from
  // filing one utility's recipe under another utility's key.
  const selfKey = recipeProfileKey({ scopeType: "utility", state: s(row.state), utility: s(row.utility), ahj: "" });
  if (selfKey !== targetKey) {
    return refuse(
      `this recipe's own state/utility ("${s(row.state)}" / "${s(row.utility)}") resolve utility key "${selfKey}", `
      + `not the requested "${targetKey}" — re-keying it there would hand one utility's steps to another's projects.`,
    );
  }

  // ALREADY THERE — but "there" means production can actually see it. A hand-moved row
  // still carrying its AHJ or a permit discipline sits on the right key and is STILL
  // invisible: the NEM lookup (repository.ts:5355) passes no discipline, so only
  // discipline='' rows match. "No-op" must not describe that state.
  if (s(row.profile_key) === targetKey && s(row.scope_type) === "utility" && s(row.ahj) === "" && s(row.discipline) === "") {
    log(`No-op: recipe already sits on ${targetKey} with scope utility, no ahj, no discipline.`);
    logResolution(db, row, opts, log);
    return { action: "noop", targetKey };
  }

  // RULE 5: a permit-portal recipe must never be resolvable from the utility track. The
  // same predicate the product uses to keep a permit track off a utility portal decides
  // here, so the script cannot drift from the rule.
  if (!isUtilityPlatformUrl(s(row.portal_url))) {
    return refuse(
      `recipe portal_url "${s(row.portal_url) || "(empty)"}" is NOT a utility platform (isUtilityPlatformUrl). `
      + `Re-keying a permit recipe onto a utility key would recreate the cross-track hazard safety rule 5 exists for.`,
    );
  }

  // Who already lives on the target key? portal_recipes carries UNIQUE(profile_key,
  // discipline) — the system's model is ONE row per slot, its status saying whether it is
  // trusted. So the (targetKey, '') slot the mover needs can hold exactly one row, and any
  // occupant of THAT slot must be judged: a better complete one refuses the move, anything
  // else needs --demote-existing and is moved ASIDE (a retired key) — demoting in place
  // would still collide with the unique index.
  const occupants = db.query<Row>("SELECT * FROM portal_recipes WHERE profile_key = ? AND id != ?", [targetKey, s(row.id)]);
  const slotOccupants = occupants.filter((o) => s(o.discipline) === "");
  const mydepth = stepCount(row);
  for (const occ of slotOccupants.filter((o) => s(o.status) === "complete")) {
    const better = stepCount(occ) > mydepth || notesSayVerified(occ.notes);
    if (better) {
      return refuse(
        `a COMPLETE recipe already sits on ${targetKey} and is the better row — id ${s(occ.id)} `
        + `(v${Number(occ.version ?? 1)}, ${stepCount(occ)} step(s)${notesSayVerified(occ.notes) ? ", notes say verified" : ""}) `
        + `vs this row's ${mydepth} step(s). Never auto-overwrite the better row (CLAUDE.md rule 3's spirit).`,
      );
    }
  }
  if (slotOccupants.length && !opts.demoteExisting) {
    return refuse(
      `a worse recipe occupies the ${targetKey} slot — `
      + slotOccupants.map((o) => `id ${s(o.id)} (v${Number(o.version ?? 1)}, ${s(o.status)}, ${stepCount(o)} step(s), unverified)`).join(", ")
      + `. Pass --demote-existing to mark it needs_rerecord (moved aside to a retired key) and proceed. Nothing was changed.`,
    );
  }
  for (const occ of occupants.filter((o) => s(o.discipline) !== "")) {
    // A row on this key with a permit discipline never matches the NEM lookup (which passes
    // no discipline), so it neither blocks the slot nor competes — but it is worth a line.
    log(`Note: occupant with discipline "${s(occ.discipline)}" on target key left untouched: id ${s(occ.id)} (status ${s(occ.status)}).`);
  }

  const now = nowIso();
  const demoted: string[] = [];
  for (const occ of slotOccupants) {
    // A retired key is deliberately OUT OF GRAMMAR: profile keys are "state|ahj|utility",
    // and no lookup ever computes a fourth segment, so the row keeps its steps and notes as
    // evidence but can never again be resolved as this utility's recipe. Deleting it would
    // destroy the record of how far that walk got (the deeperDraft lesson).
    const retiredKey = `${targetKey}|retired ${s(occ.id).slice(0, 8)}`;
    const demoteNote = `Demoted to needs_rerecord and retired off "${targetKey}" by rekey-recipe: superseded by the verified re-keyed recipe ${s(row.id).slice(0, 8)} (${mydepth} steps) — this row was never verified.`;
    log(`${opts.dryRun ? "[dry-run] would demote" : "Demoting"} occupant ${s(occ.id)} (v${Number(occ.version ?? 1)}, ${s(occ.status)}, ${stepCount(occ)} step(s)) to needs_rerecord at retired key "${retiredKey}".`);
    if (!opts.dryRun) {
      db.run(
        "UPDATE portal_recipes SET status = 'needs_rerecord', profile_key = ?, notes = ?, updated_at = ? WHERE id = ?",
        [retiredKey, mergeRecipeNotes(occ.notes, demoteNote), now, s(occ.id)],
      );
    }
    demoted.push(s(occ.id));
  }

  const rekeyNote =
    `Re-keyed from "${s(row.profile_key)}" (scope ${s(row.scope_type)}${s(row.discipline) ? `, discipline ${s(row.discipline)}` : ""}) `
    + `to the utility key production resolution actually looks up — see 07c79eb.`;
  log(`${opts.dryRun ? "[dry-run] would move" : "Moving"} recipe ${s(row.id)} -> profile_key=${targetKey}, scope_type=utility, ahj='', discipline=''.`);
  if (opts.dryRun) {
    log("--dry-run: nothing written.");
    return { action: "dry-run", targetKey, demoted };
  }
  // discipline is cleared along with the ahj: '' is what utility/NEM recipes carry (db.ts),
  // and the NEM lookup passes no discipline — a moved row keeping "electrical" would sit on
  // the right key and STILL never be found, the same invisibility this script exists to end.
  db.run(
    "UPDATE portal_recipes SET profile_key = ?, scope_type = 'utility', ahj = '', discipline = '', notes = ?, updated_at = ? WHERE id = ?",
    [targetKey, mergeRecipeNotes(row.notes, rekeyNote), now, s(row.id)],
  );
  const moved = db.get<Row>("SELECT * FROM portal_recipes WHERE id = ?", [s(row.id)])!;
  log(`Moved:\n  ${describeRow(moved)}`);
  logResolution(db, moved, opts, log);
  return { action: "moved", targetKey, demoted };
}

/** Prove the point of the exercise: does production's own lookup now find THIS row? */
function logResolution(db: AppDb, row: Row, opts: { toState: string; toUtility: string }, log: (line: string) => void): void {
  try {
    const hit = findCompleteRecipeForProject(db, { scopeType: "utility", state: opts.toState, utility: opts.toUtility });
    if (hit && hit.id === s(row.id)) log(`Production resolution check: findCompleteRecipeForProject -> THIS recipe (${hit.id}).`);
    else if (hit) log(`Production resolution check: findCompleteRecipeForProject -> a DIFFERENT row (${hit.id}, v${hit.version}, ${hit.steps.length} step(s)) — inspect before trusting the live test.`);
    else log(`Production resolution check: findCompleteRecipeForProject found NOTHING complete on this key — the row is ${s(row.status)}, and only status='complete' replays.`);
  } catch (e) {
    log(`Production resolution check skipped: ${String((e as Error)?.message || e)}`);
  }
}

// ---------------------------------------------------------------------------------------
// CLI — runs only when invoked directly, so the test can import rekeyRecipe without side
// effects. Windows-safe: compare resolved paths case-insensitively.
// ---------------------------------------------------------------------------------------
const invokedDirectly = ((): boolean => {
  try {
    return !!process.argv[1]
      && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch { return false; }
})();

if (invokedDirectly) {
  const arg = (name: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? String(process.argv[i + 1] ?? "") : "";
  };
  const recipeId = arg("id");
  const toUtility = arg("to-utility");
  const dryRun = process.argv.includes("--dry-run");
  const demoteExisting = process.argv.includes("--demote-existing");

  const [statePart, ...utilityParts] = toUtility.split("|");
  const utilityPart = utilityParts.join("|");
  if (!recipeId || !statePart || !utilityPart.trim()) {
    console.error(`
Re-key a portal recipe to the utility profile key production actually resolves.

  ALWAYS start with --dry-run — without it this script WRITES THE LIVE DB:

    npx tsx scripts/rekey-recipe.ts --id <recipeId> --to-utility "<state>|<utility>" --dry-run
    npx tsx scripts/rekey-recipe.ts --id <recipeId> --to-utility "<state>|<utility>"
    npx tsx scripts/rekey-recipe.ts --id <recipeId> --to-utility "<state>|<utility>" --demote-existing

  --demote-existing   required when a WORSE complete recipe already occupies the target key;
                      it is marked needs_rerecord with a note saying why.

  e.g. --id 07370f52 --to-utility "il|Ameren Illinois"
`);
    process.exit(1);
  }

  await import("dotenv/config");
  process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";
  const { openDatabase } = await import("../backend/src/db");
  const db = await openDatabase();

  console.log(`\nDB: ${process.env.AUTOPILOT_DB_PATH}${dryRun ? "   (--dry-run: read-only)" : "   (LIVE WRITE)"}\n`);
  const result = rekeyRecipe(db, { recipeId, toState: statePart, toUtility: utilityPart, demoteExisting, dryRun, log: (l) => console.log(l) });
  console.log("");
  process.exit(result.action === "refused" ? 1 : 0);
}
