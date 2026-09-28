// WHAT A RUNNING JOB IS DOING RIGHT NOW, IN WORDS — job_queue.progress_note (db.ts migration).
//
// The automatic chain (autoStageSteps) names each step as it starts, so the project page can say
// "Checking the AHJ's required official forms… (started HH:MM UTC)" instead of a bare "running":
// on 2026-09-28 a never-seen AHJ's form search took six minutes while the page read "blocked" and
// the operator concluded it was "getting lost finding the forms". A LEAF on purpose: jobQueue
// (the writer's caller) and nextStep (the reader) both import it — nextStep is reached from
// repository, which jobQueue imports statically, so a static nextStep -> jobQueue edge would
// close the circular-import guard's loop (CLAUDE.md).
import type { AppDb, SqlParam } from "./db";
import { nowIso } from "./time";

export interface JobProgressNote { label: string; since: string }

/** Name the step a running job is on. Kept on the finished row (it is the last step it named). */
export function noteJobProgress(db: AppDb, jobId: string, label: string): void {
  const note: JobProgressNote = { label: String(label || "").slice(0, 200), since: nowIso() };
  db.run("UPDATE job_queue SET progress_note = ? WHERE id = ?", [JSON.stringify(note), jobId]);
}

/** The note on a job row, or null (tolerant of a blank, absent or unreadable column). */
export function parseJobProgressNote(raw: SqlParam | unknown): JobProgressNote | null {
  if (raw == null || raw === "") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(String(raw)); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Partial<JobProgressNote>;
  if (!o.label) return null;
  return { label: String(o.label), since: String(o.since || "") };
}
