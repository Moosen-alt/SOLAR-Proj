// ---------------------------------------------------------------------------
// PERMIT / NEM TURNAROUND SAMPLES (L2).
//
// The knowledge base's "average timeline" used to be a running average updated on EVERY status
// check, measured from the project's first submissions row of ANY track (falling back to its
// created_at). A permit sitting in review for three weeks, polled daily, contributed twenty-one
// samples; a NEM approval was measured from the permit's filing. So the number measured the
// monitor's polling cadence (Coos Bay 5.6 days, Hood River County 0.0), and got worse the more
// often we looked.
//
// A sample is now ONE row per (project, track, milestone):
//   - written on the FIRST reading of that milestone (INSERT OR IGNORE on the UNIQUE key — a
//     re-check of an issued permit is a no-op, and so is a boot backfill replaying history);
//   - start_at = the earliest submitted_at of a submission of the SAME track (the filing a
//     person actually sent). No submitted_at, no sample: never created_at, never a staging or
//     failed row, never another track's filing;
//   - milestones kept apart (reviewed / issued / correction_flagged), never averaged together;
//   - NEM samples key to the UTILITY profile (state|—|utility, the key the utility resolver
//     reads), permit samples to the same state|ahj|utility profile the permit learn writes.
// The KB's timeline fields are DERIVED from this table (knowledgeBase.rebuildKnowledgeRollup),
// so deleting a project, or a demo reset, drops its samples and the figure with them.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { PermitCheckOutcome, SubmittalTrackType } from "../../shared/src/types";
import { id } from "./ids";
import { text } from "./json";
import { isLearningExcluded, knowledgeProfileKey, recomputeTimelineFromSamples } from "./knowledgeBase";
import { outcomeFinishesTrack, SUBMITTAL_TRACK_TYPES, trackPermitTypes } from "./submittalTracks";
import { nowIso } from "./time";

type Row = Record<string, unknown>;

export type TimelineMilestone = "reviewed" | "issued" | "correction_flagged";
/** A submittal track, or "permit" for an AHJ target tagged to no track (unattributed). */
export type SampleTrack = SubmittalTrackType | "permit";

/** Which track a tracking target speaks for — the same permit_type families isTrackDone uses. */
export function trackForTarget(targetType: string, permitType: string): SampleTrack {
  if (targetType === "nem") return "nem";
  const tagged = SUBMITTAL_TRACK_TYPES.find((t) => t !== "nem" && trackPermitTypes(t).includes(permitType));
  return tagged ?? "permit";
}

/** The milestone one reading reaches on its own kind of target, or null. "issued" means the
 *  outcome that FINISHES the track (outcomeFinishesTrack — issued on a permit target,
 *  nem_approved on a NEM one); review-complete is an AHJ fact, so only a permit target has it. */
export function milestoneFor(track: SampleTrack, targetType: string, outcome: PermitCheckOutcome | string): TimelineMilestone | null {
  if (outcome === "correction_flagged") return "correction_flagged";
  if (outcomeFinishesTrack(track === "permit" ? "combo" : track, outcome, targetType)) return "issued";
  if (targetType === "permit" && (outcome === "reviewed_by_ahj" || outcome === "ready_for_issue")) return "reviewed";
  return null;
}

/** Earliest real filing time for ONE track: a submissions row of that track that a person
 *  actually sent (submitted_at set, not failed). null when there is none. */
export function earliestSubmittedAt(db: AppDb, projectId: string, track: SampleTrack): string | null {
  let filter: string;
  let params: string[] = [];
  if (track === "nem") {
    filter = "(submission_type = 'interconnection' OR permit_type = 'nem')";
  } else if (track === "permit") {
    filter = "submission_type <> 'interconnection' AND permit_type <> 'nem'";
  } else {
    const types = trackPermitTypes(track);
    filter = `submission_type <> 'interconnection' AND permit_type IN (${types.map(() => "?").join(", ")})`;
    params = types;
  }
  const row = db.get<Row>(
    `SELECT MIN(submitted_at) AS start_at FROM submissions
      WHERE project_id = ? AND submitted_at IS NOT NULL AND TRIM(submitted_at) <> '' AND status <> 'failed'
        AND ${filter}`,
    [projectId, ...params],
  );
  return text(row?.start_at) || null;
}

/**
 * Record the turnaround sample one status reading earns, if any. Returns true when a NEW sample
 * was written (and the profile's derived timeline recomputed).
 */
export function recordTimelineSample(
  db: AppDb,
  project: { id: string; state: string; ahj: string; city: string; utility: string },
  target: Row | null | undefined,
  reading: { outcome: PermitCheckOutcome | string; createdAt: string },
): boolean {
  if (!target) return false; // no target = no track = nothing to measure against
  if (isLearningExcluded(db, project.id)) return false;
  const targetType = text(target.target_type);
  const track = trackForTarget(targetType, text(target.permit_type));
  const milestone = milestoneFor(track, targetType, reading.outcome);
  if (!milestone) return false;
  const exists = db.get<Row>(
    "SELECT 1 AS one FROM permit_timeline_samples WHERE project_id = ? AND track = ? AND milestone = ?",
    [project.id, track, milestone],
  );
  if (exists) return false;
  // THE FIRST TRANSITION, not the look that happens to write the sample. The target's recorded
  // history (permit_status_checks: a row per change) decides end_at — its FIRST reading of this
  // milestone — so a sample that could only be written later (submitted_at captured after the
  // permit issued) still ends when the milestone was first read, never at a routine re-poll.
  // When no reading BEFORE that one observed a state — the target's first-ever reading already
  // shows the milestone, or everything before it was unreadable (needs_human_review: a portal
  // error page, "No status text available") — the transition was never observed (tracking, or
  // the first readable page, came after it happened): the reading's time is only when we first
  // looked, so there is no sample. Production: both electrical samples (Coos Bay, Coos County)
  // were an error page followed by "issued". No recorded row → nothing to measure.
  const targetId = text(target.id);
  if (!targetId) return false;
  const history = db.query<Row>(
    "SELECT outcome, created_at FROM permit_status_checks WHERE target_id = ? ORDER BY created_at ASC, rowid ASC",
    [targetId],
  );
  const firstAt = history.findIndex((row) => milestoneFor(track, targetType, text(row.outcome)) === milestone);
  if (firstAt < 0) return false;
  const observedBefore = history.slice(0, firstAt).some((row) => {
    const outcome = text(row.outcome);
    return outcome !== "needs_human_review" && outcome !== "no_change" && outcome !== "";
  });
  if (!observedBefore) return false;
  const endAt = text(history[firstAt].created_at);
  const startAt = earliestSubmittedAt(db, project.id, track);
  if (!startAt) return false;
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return false;
  const ahj = text(target.jurisdiction) || project.ahj || project.city;
  if (track === "nem" ? !project.utility.trim() : !ahj.trim()) return false;
  const key =
    track === "nem"
      ? knowledgeProfileKey({ state: project.state, ahj: "", utility: project.utility })
      : knowledgeProfileKey({ state: project.state, ahj, utility: project.utility });
  const days = Math.round(((endMs - startMs) / 86400000) * 10) / 10;
  db.run(
    `INSERT OR IGNORE INTO permit_timeline_samples
       (id, project_id, profile_key, track, milestone, start_at, end_at, days, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id(), project.id, key, track, milestone, startAt, endAt, days, nowIso()],
  );
  recomputeTimelineFromSamples(db, key);
  return true;
}

/**
 * Re-derive turnaround from the RECORDED history, for rows written before samples existed.
 *
 * Replays every recorded status transition (permit_status_checks — a row per change, never per
 * look) through recordTimelineSample in created_at order, so the first reading of a milestone wins
 * the UNIQUE key exactly as it would have live; then recomputes every profile that carries a
 * timeline or timeline notes — a legacy polling average with no samples behind it is cleared,
 * per-poll notes are dropped, seeded and imported notes are kept. Idempotent. NOT run at boot:
 * it rewrites shared rows, so running it on production is an operator decision
 * (scripts/audit-learned-provenance.ts shows the result on a copy first).
 */
export function backfillTimelineSamples(db: AppDb): { replayed: number; samplesWritten: number; profilesRecomputed: string[] } {
  const checks = db.query<Row>(
    // Aliased: t.* carries its own project_id / created_at, which would shadow the CHECK's.
    `SELECT t.*, c.project_id AS check_project_id, c.outcome AS check_outcome, c.created_at AS check_created_at
       FROM permit_status_checks c JOIN permit_check_targets t ON t.id = c.target_id
      WHERE c.outcome IN ('reviewed_by_ahj', 'ready_for_issue', 'issued', 'nem_approved', 'correction_flagged')
      ORDER BY c.created_at ASC, c.rowid ASC`,
  );
  let samplesWritten = 0;
  for (const c of checks) {
    const p = db.get<Row>("SELECT id, state, ahj, city, utility FROM projects WHERE id = ?", [text(c.check_project_id)]);
    if (!p) continue;
    const project = { id: text(p.id), state: text(p.state), ahj: text(p.ahj), city: text(p.city), utility: text(p.utility) };
    if (recordTimelineSample(db, project, c, { outcome: text(c.check_outcome), createdAt: text(c.check_created_at) })) samplesWritten++;
  }
  const keys = [
    ...new Set([
      ...db.query<Row>("SELECT profile_key FROM permit_utility_knowledge WHERE timeline_sample_count > 0 OR average_timeline_days IS NOT NULL OR timeline_notes_json <> '[]'").map((r) => text(r.profile_key)),
      ...db.query<Row>("SELECT DISTINCT profile_key FROM permit_timeline_samples").map((r) => text(r.profile_key)),
    ]),
  ].filter(Boolean);
  for (const key of keys) recomputeTimelineFromSamples(db, key);
  return { replayed: checks.length, samplesWritten, profilesRecomputed: keys };
}
