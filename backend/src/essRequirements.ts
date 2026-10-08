// ---------------------------------------------------------------------------
// BATTERY / ESS — WHAT A STORAGE JOB OWES ON THE PERMIT SIDE (issue #246).
//
// Before this, a battery added no document row and no step: it showed only in fees
// (batteryServiceFeeder) and one reviewer warning. Two answers live here:
//
//   1. essDocumentRows()  — the ESS spec sheet (UL 9540) and the ESS installation detail
//      (NEC 706 / IRC R328: location, clearances, disconnect), pushed by requiredDocuments().
//   2. essPermitStep()    — does this AHJ want a fire review or a separate ESS permit? Read ONLY
//      from what is on file: the per-job lookup's cited permits (discipline "other") and cited
//      prerequisites, and the AHJ's seeded process notes, quoted as notes. Nothing on file is said
//      as "not on file, verify" — never assumed either way.
//
// BOTH ARE GATED ON batteryStatus() === "yes" — the one battery predicate the fee line and the
// portal's own battery declaration read. A no-battery job and an UNKNOWN one (never parsed) get
// exactly what they always got: silence about a battery is not a battery.
//
// A STEP, NOT A TRACK (Helm's scope ruling on #246, option B). No SubmittalTrackType is added, so
// nothing here can stage a portal run; the step is display on the permit card. Read-only: no db
// write, no LLM call.
// ---------------------------------------------------------------------------

import type { ProjectRecord } from "../../shared/src/types";
import type { RequiredDocItem } from "./requiredDocuments";
import { batteryStatus } from "./batteryServiceFeeder";
import { permitProcessFor } from "./permitProcess";
import { findAhjProcessProfile } from "./processProfiles";

/** Does this project carry battery storage? The one predicate, batteryStatus() === "yes" (which
 *  already reads a placeholder model as no evidence — isPlaceholderBatteryModel). */
export function projectHasBattery(project: Pick<ProjectRecord, "parserSnapshot">): boolean {
  return batteryStatus(project.parserSnapshot as Record<string, unknown> | undefined) === "yes";
}

/** The two rows a storage job adds to the required set. The spec sheet blocks like the module and
 *  inverter sheets; the installation detail is advisory, because it often sits on the site plan or
 *  the one-line rather than a sheet of its own, and a title match cannot prove it absent. */
export function essDocumentRows(): RequiredDocItem[] {
  return [
    { docType: "battery_spec", label: "Battery / ESS spec sheet (UL 9540)", why: "A storage job: the AHJ reviews the ESS listing (UL 9540 / 9540A) and ratings from its cut sheet.", lane: "permit", blocking: true },
    { docType: "ess_detail", label: "ESS installation detail (NEC 706 / IRC R328)", why: "A storage job: the ESS location, clearances, disconnect and fire separation (NEC 706, IRC R328) — on its own sheet or on the site plan / one-line.", lane: "permit", blocking: false },
  ];
}

export interface EssStepEntry {
  /** In the source's words. */
  step: string;
  /** "" for a seeded process note (not a page). */
  sourceUrl: string;
  quote: string;
  basis: "lookup_permit" | "lookup_prerequisite" | "process_note";
  /** Does the source itself name storage? false: a cited FIRE permit/review that never says it
   *  covers the battery — shown hedged, never as the ESS requirement. */
  namesStorage: boolean;
}
export interface EssPermitStep {
  /** "cited": a cited lookup answer names storage; "fire_review_unconfirmed": a cited fire
   *  permit/review is on file but never says it covers the battery; "process_note": only the seeded
   *  notes mention storage; "not_on_file": nothing on file says either way. */
  status: "cited" | "fire_review_unconfirmed" | "process_note" | "not_on_file";
  entries: EssStepEntry[];
  /** One line for the card. */
  summary: string;
}

const ESS_WORDS = /\bbatter(?:y|ies)\b|\bess\b|energy[\s-]*storage|\bpowerwall\b/i;
const FIRE_WORDS = /\bfire\b/i;
const citedOk = (url: unknown, quote: unknown) => /^https?:\/\//i.test(String(url ?? "")) && String(quote ?? "").trim().length >= 8;

/** The fire review / separate ESS permit, as the AHJ's records on file say it — null on a job that
 *  has no battery (or an unknown one). */
export function essPermitStep(project: ProjectRecord): EssPermitStep | null {
  if (!projectHasBattery(project)) return null;
  const entries: EssStepEntry[] = [];
  const lk = permitProcessFor(project);

  // 1. A cited permit of its own (discipline "other": a fire / ESS permit beside building + electrical).
  for (const p of lk?.permits ?? []) {
    if (p.discipline !== "other") continue;
    const recordType = typeof p.recordType?.value === "string" ? p.recordType.value.trim() : "";
    const agency = typeof p.issuingAgency?.value === "string" ? p.issuingAgency.value.trim() : "";
    const words = `${p.label || ""} ${recordType} ${agency}`;
    if (!ESS_WORDS.test(words) && !FIRE_WORDS.test(words)) continue;
    const cite = [p.recordType, p.issuingAgency, p.portalUrl, p.documents].find((f) => f && citedOk(f.sourceUrl, f.quote));
    if (!cite) continue; // an uncited permit is not a fact
    const quote = String(cite.quote).trim();
    const step = `${(p.label || recordType || "Separate permit").trim()}${agency ? ` — issued by ${agency}` : ""}${recordType && recordType !== p.label ? ` (record type: ${recordType})` : ""}`;
    entries.push({ step, sourceUrl: String(cite.sourceUrl), quote, basis: "lookup_permit", namesStorage: ESS_WORDS.test(`${words} ${quote}`) });
  }

  // 2. A cited prerequisite at another office that names storage or fire review.
  for (const pre of lk?.prerequisites ?? []) {
    const step = typeof pre?.value === "string" ? pre.value.trim() : "";
    if (!step || !citedOk(pre.sourceUrl, pre.quote)) continue;
    const quote = String(pre.quote).trim();
    if (!ESS_WORDS.test(`${step} ${quote}`) && !FIRE_WORDS.test(step)) continue;
    entries.push({ step, sourceUrl: String(pre.sourceUrl), quote, basis: "lookup_prerequisite", namesStorage: ESS_WORDS.test(`${step} ${quote}`) });
  }

  // 3. The AHJ's seeded process notes, per sentence/clause (as mpuNeedsOwnPermit reads them, but on
  //    sentence boundaries so "NEC 706.10" stays whole): a clause that names storage is quoted as the
  //    operator's note — never turned into a conclusion.
  const ahj = findAhjProcessProfile(project);
  const notes = `${ahj?.reviewerNotes || ""} | ${ahj?.otherRequirements || ""}`;
  for (const segment of notes.split(/(?<=[.!?])\s+|[;|\n]+/).map((x) => x.trim().replace(/[.!?]+$/, "")).filter(Boolean)) {
    if (!ESS_WORDS.test(segment)) continue;
    if (entries.some((e) => e.step.toLowerCase() === segment.toLowerCase())) continue;
    entries.push({ step: segment, sourceUrl: "", quote: segment, basis: "process_note", namesStorage: true });
  }

  const status: EssPermitStep["status"] = entries.some((e) => e.basis !== "process_note" && e.namesStorage) ? "cited"
    : entries.some((e) => e.basis !== "process_note") ? "fire_review_unconfirmed"
      : entries.length ? "process_note" : "not_on_file";
  const summary = {
    cited: "Battery/ESS: a fire review or separate ESS permit for the storage is on file for this AHJ (cited) — file it alongside this permit.",
    fire_review_unconfirmed: "Battery/ESS: a cited fire permit or review is on file, but whether it covers the battery is not stated — verify with the AHJ / fire marshal.",
    process_note: "Battery/ESS: only the seeded process notes mention storage (unverified, not a cited page) — confirm with the AHJ whether a fire review or separate ESS permit applies.",
    not_on_file: "Battery/ESS: whether this AHJ wants a fire review or a separate ESS permit is not on file — verify with the AHJ / fire marshal before filing.",
  }[status];
  return { status, entries, summary };
}
