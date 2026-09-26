// ---------------------------------------------------------------------------
// Submittal tracks — a project's independent permit/interconnection filings.
//
// A residential solar project usually needs MORE than one filing:
//   - the UTILITY net-metering (NEM) / interconnection application — this is the
//     utility submission (PowerClerk, etc.), NOT a permit.
//   - an AHJ permit, which is EITHER one combined building+electrical permit
//     (combo) OR two separate filings: building (BLD) and electrical (ELE).
//
// Each track is submitted to its own portal and tracked independently from
// "not started" → staged → submitted → in review → issued. This module derives
// the required tracks for a project and reads/writes their status, reusing the
// existing submissions + permit_check_targets tables (which already drive the
// status poller) rather than introducing a parallel store.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type {
  PermitCheckOutcome,
  ProjectRecord,
  StageDetail,
  SubmittalTrack,
  SubmittalTrackStatus,
  SubmittalTrackType,
} from "../../shared/src/types";
import { findApplicationProfile, describePermitType, permitStructureAnswer, permitStructureIsCitedOrVerified, type PermitPrerequisiteStep, type PermitStructureAnswer } from "./applicationDocs";
import { findAhjProcessProfile, jurisdictionKind, jurisdictionKindsCompatible } from "./processProfiles";
import { recipeProfileKey } from "./portalRecipes";
import { detectPlatform } from "./publicPermitStatus";
import { HttpError } from "./httpError";
import { isInformationalPageUrl, isUtilityPlatformUrl, portalHostOf, trackSafeUrl } from "./portalChannel";
import { permitAnswerForTrack, permitProcessFor } from "./permitProcess";
import { utilityTrackPresentation } from "./utilityFilingLookup";
import { nowIso } from "./time";
import { randomUUID } from "node:crypto";

interface Row { [key: string]: unknown }
const s = (v: unknown): string => (v == null ? "" : String(v));

// The TYPE's name — used where a track is named in notes and stage details. What a card is TITLED
// comes from permitTrackLabel() / utilityTrackPresentation: a permit card says what the ONE structure answer settled, and the
// utility card says what the utility's program IS (utilityFilingLookup) — "net metering" only
// where that is known, never by default.
const TRACK_LABELS: Record<SubmittalTrackType, string> = {
  nem: "Utility interconnection",
  building: "Building permit (BLD)",
  electrical: "Electrical permit (ELE)",
  combo: "Building + electrical permit (combo)",
  permit: "AHJ permit",
  mpu: "Main panel / service upgrade permit (MPU)",
};

/** The card title. A single permit track whose structure is NOT settled is the one filing the
 *  operator must still confirm — "Building + electrical permit (combo)" on it was a template
 *  default dressed as a fact (Waltham files fire review + building + wires). */
function permitTrackLabel(type: SubmittalTrackType, answer: PermitStructureAnswer): string {
  if (type === "combo" || type === "permit") {
    if (answer.structure === "combo") return "Building + electrical permit (combo)";
    return "AHJ permit — one permit or separate building + electrical not yet confirmed";
  }
  if ((type === "building" || type === "electrical") && !permitStructureIsCitedOrVerified(answer)) {
    return `${TRACK_LABELS[type]} — per the operator's seeded note, not confirmed on an agency page`;
  }
  return TRACK_LABELS[type];
}

/** A track as the tracks panel receives it: the shared SubmittalTrack plus the evidence behind
 *  its title and channel (declared here — shared/src/types.ts is not this module's to change). */
export interface SubmittalTrackView extends SubmittalTrack {
  /** Permit tracks: the ONE permit-structure answer's basis line. */
  structureBasis?: string;
  /** Permit tracks: steps at another office BEFORE this filing (fire review, zoning), each cited. */
  prerequisites?: PermitPrerequisiteStep[];
  /** How the channel is known: "cited" (per-job lookup), "verified", "profile", "researched", "unknown". */
  channelBasis?: string;
}

/** Every submittal track, derived from the label Record so it cannot go stale: adding a
 *  member to SubmittalTrackType fails the compile until TRACK_LABELS names it, and this
 *  list picks it up for free. Callers holding a track as a loose string (a portal run's
 *  permit_type column) narrow through this. */
export const SUBMITTAL_TRACK_TYPES = Object.keys(TRACK_LABELS) as SubmittalTrackType[];

// Main-panel / service-upgrade scope detection — mirrors the reviewer's MPU callout.
// Keyed on upgrade language (not "derate", a 705.12 remedy that isn't itself an MPU).
function hasMpuScope(project: ProjectRecord): boolean {
  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  const text = [
    snap.projectDescriptionText, snap.description, snap.scopeText, snap.electricalCalcText,
    snap.sitePlanNotesText, snap.mpu, snap.serviceUpgrade,
  ].map((v) => (v == null ? "" : String(v))).join(" ").toLowerCase();
  return /\bmpu\b|main panel upgrade|main service panel upgrade|service (panel )?upgrade|\bmsp upgrade\b|panel upgrade|meter.?main upgrade/.test(text);
}

// Some AHJs fold the MPU into the electrical/combination permit (e.g. Beaverton:
// "alteration (MPU, et cetera) can go under one electric trade permit"). When the AHJ
// note says so, the MPU does NOT get its own track. Otherwise it does, so it's tracked.
function mpuFoldedIntoElectrical(project: ProjectRecord): boolean {
  const ahj = findAhjProcessProfile(project);
  const notes = `${ahj?.reviewerNotes || ""} ${ahj?.otherRequirements || ""}`.toLowerCase();
  return /\bmpu\b|panel upgrade|alteration/.test(notes) && /under one (electric|combination)|one electric trade permit|on (the )?electric(al)? (trade )?(permit|form)/.test(notes);
}

/** Map a permit track to the permit_check_targets.target_type used by the poller. */
function targetTypeFor(track: SubmittalTrackType): "permit" | "nem" {
  return track === "nem" ? "nem" : "permit";
}

function hasUtility(project: ProjectRecord): boolean {
  return Boolean((project.utility || "").trim());
}

/**
 * The tracks a project must file. NEM whenever there's a utility, plus the AHJ
 * permit(s): one combo permit, or separate building + electrical when the AHJ
 * files them apart. "unknown" structure defaults to a single combo permit (the
 * common case) so the operator always has at least one actionable permit track.
 */
export function requiredTracks(project: ProjectRecord): SubmittalTrackType[] {
  const tracks: SubmittalTrackType[] = [];
  if (hasUtility(project)) tracks.push("nem");

  // Resolve combo vs separate across all signals (AHJ process notes/flags included),
  // so AHJs like Beaverton that file SEPARATE building + electrical permits split into
  // two permit tracks instead of one mislabelled "combo".
  // THE ONE ANSWER (permitStructureAnswer): "separate" only when a cited page, a person, a
  // hand-written profile, the operator's own unhedged note or a cited state rule says so.
  if (permitStructureAnswer(project).structure === "separate") {
    tracks.push("building", "electrical");
  } else {
    tracks.push("combo");
  }

  // A main panel / service upgrade gets its OWN tracked permit when it's in scope and
  // the AHJ doesn't fold it into the electrical/combination permit. Not every project
  // has one — it only appears when the bot detects MPU scope.
  if (hasMpuScope(project) && !mpuFoldedIntoElectrical(project)) {
    tracks.push("mpu");
  }
  return tracks;
}

/** A permit track's portal as the per-job lookup found it (cited): this track's own permit, or —
 *  for the single combo/unknown filing — the one portal every looked-up permit agrees on. A URL
 *  that is a utility portal (rule 5) or an information page is never a permit channel. */
function lookedUpPermitPortal(project: ProjectRecord, track: SubmittalTrackType): { url: string; sourceUrl: string; recordType: string } | null {
  const lk = permitProcessFor(project);
  if (!lk?.permits?.length) return null;
  const own = permitAnswerForTrack(project, track);
  const pool = own ? [own] : track === "combo" || track === "permit" ? lk.permits : [];
  const found = pool
    .map((p) => ({ p, url: typeof p.portalUrl?.value === "string" ? p.portalUrl.value.trim() : "" }))
    .filter(({ p, url }) => url && /^https?:\/\//i.test(p.portalUrl.sourceUrl || "") && trackSafeUrl(track, url) && !isInformationalPageUrl(url));
  if (!found.length || new Set(found.map((f) => portalHostOf(f.url))).size !== 1) return null;
  const recordTypes = [...new Set(found.map(({ p }) => (typeof p.recordType?.value === "string" ? p.recordType.value.trim() : "")).filter(Boolean))];
  return { url: found[0].url, sourceUrl: found[0].p.portalUrl.sourceUrl, recordType: recordTypes.length === 1 ? recordTypes[0] : "" };
}

/** The AHJ's knowledge-base row, EXACT name (a fuzzy bridge is how a county inherits a city). */
function kbAhjRow(db: AppDb | null, project: ProjectRecord): Row | null {
  if (!db || !(project.ahj || "").trim()) return null;
  try {
    const row = db.get<Row>(
      `SELECT ahj, portal_url, portal_name, submission_method, verified_at FROM permit_utility_knowledge
        WHERE ahj = ? AND (utility IS NULL OR utility = '') AND (state = '' OR UPPER(state) = UPPER(?))
        ORDER BY (verified_at IS NOT NULL AND verified_at != '') DESC, updated_at DESC LIMIT 1`,
      [project.ahj, project.state || ""],
    );
    if (!row || !jurisdictionKindsCompatible(jurisdictionKind(project.ahj), jurisdictionKind(s(row.ahj)))) return null;
    return row;
  } catch {
    return null;
  }
}

/**
 * WHERE THIS TRACK IS FILED, and how that is known. A portal / "no portal, paper" / record type
 * the per-job lookup FOUND reaches the card (new-AHJ e2e: Iowa City's EnerGov URL and Waltham's
 * "paper drop-off" were found, and the tracks still said "Unknown — verify"). Order: the lookup
 * (cited) → the AHJ's hand-written / seeded profile → the AHJ's knowledge-base row (a person's
 * verified row, else research — said as such) → unknown.
 */
function channelResolution(db: AppDb | null, track: SubmittalTrackType, project: ProjectRecord): { channel: string; basis: string; portalUrl: string } {
  if (track === "nem") {
    const u = utilityTrackPresentation(db, project);
    return { channel: u.channel, basis: u.basis, portalUrl: u.portalUrl };
  }
  const found = lookedUpPermitPortal(project, track);
  if (found) {
    return {
      channel: `Online portal: ${found.url}${found.recordType ? ` — record type "${found.recordType}"` : ""} (per-job lookup, cited: ${found.sourceUrl})`,
      basis: "cited",
      portalUrl: found.url,
    };
  }
  // The lookup looked and found NO online portal (its words, e.g. "applications must be dropped
  // off in person"): that is a finding, shown as one — not a cited quote, so "verify".
  const noPortal = (permitProcessFor(project)?.permits ?? [])
    .map((p) => (p.portalUrl?.value ? "" : s(p.portalUrl?.notFound).trim()))
    // Negations of an online filing only — "only paper application PDFs found" is a search
    // report, not a statement that there is no portal.
    .find((nf) => /\bno online (?:application )?portal\b|\bno (?:application )?portal (?:exists|is available|available)\b|\bdoes not (?:have|offer|use) an? (?:online )?(?:application )?portal\b|\bnot (?:accepted|available|submitted) online\b|\bno online (?:application|submission|filing)\b|\b(?:must|are to) be (?:dropped off|submitted in[- ]person|mailed)\b|\bin[- ]person (?:only|drop[- ]?off|submittal)\b|\bdrop[- ]off only\b/i.test(nf));
  if (noPortal) {
    return { channel: `No online application portal found — ${noPortal.slice(0, 200)} (per-job lookup; verify on the AHJ site)`, basis: "researched", portalUrl: "" };
  }
  const profile = findApplicationProfile(project);
  const method = describePermitType(profile).submissionMethod || "";
  if (method && !/^\s*unknown/i.test(method)) {
    const seeded = profile.id.startsWith("process-");
    return { channel: seeded ? `${method} (seeded AHJ profile — verify)` : method, basis: "profile", portalUrl: "" };
  }
  const kb = kbAhjRow(db, project);
  if (kb) {
    const verified = s(kb.verified_at).trim() !== "";
    const url = s(kb.portal_url).trim();
    const safeUrl = url && trackSafeUrl(track, url) && !isInformationalPageUrl(url) ? url : "";
    const how = s(kb.submission_method).trim() || s(kb.portal_name).trim();
    if (safeUrl || how) {
      return {
        channel: `${how || "Online portal"}${safeUrl ? `: ${safeUrl}` : ""} (${verified ? "verified by a person" : "researched — verify on the AHJ site"})`,
        basis: verified ? "verified" : "researched",
        portalUrl: safeUrl,
      };
    }
  }
  return { channel: "Unknown — verify on the AHJ site", basis: "unknown", portalUrl: "" };
}

/** A tracking target's portal_name: the found portal's host, else the channel without its
 *  evidence parenthetical — a name, not the card's sentence. */
function targetPortalName(track: SubmittalTrackType, project: ProjectRecord, db: AppDb | null): string {
  const r = channelResolution(db, track, project);
  return r.portalUrl ? portalHostOf(r.portalUrl) : r.channel.replace(/s*([^)]*)s*$/, "");
}

function channelFor(track: SubmittalTrackType, project: ProjectRecord, db: AppDb | null = null): string {
  return channelResolution(db, track, project).channel;
}

/**
 * The permit_type values (on submissions and permit_check_targets) that belong to one track.
 *
 *  - combo / permit are one filing: legacy rows created before per-track support carry
 *    permit_type 'permit', and the trackless stage still records its run that way.
 *  - building / structural are one trade. The fee layer, the discipline recipes and the
 *    operator's own target tags say "structural"; the track says "building" (clientPortal's
 *    trackLabel already names both "Building permit"). Unfolded, a project whose building
 *    permit was tagged 'structural' read "building: not started" forever and could never hand
 *    off — and handoff_ready cannot be set by hand.
 */
export function trackPermitTypes(track: SubmittalTrackType): string[] {
  if (track === "combo" || track === "permit") return ["combo", "permit"];
  if (track === "building") return ["building", "structural"];
  return [track];
}

/**
 * Does this ONE reading finish this track, on this kind of target? The outcome half of
 * isTrackDone below (which also reads the target's history and the project's other targets).
 *
 *  - an AHJ permit track is done at `issued` — NOT `ready_for_issue`, which is "approved, pay
 *    the issuance fee": a person still owes the jurisdiction money and there is no permit card.
 *  - the NEM track is done at `nem_approved`.
 *  - an outcome counts ONLY on a target of its own kind. A utility target whose text happened
 *    to classify as "issued", or a permit target reading "nem_approved", has not finished that
 *    track — the same rule updateProjectForPermitOutcome applies before it writes a status.
 */
export function outcomeFinishesTrack(track: SubmittalTrackType, outcome: PermitCheckOutcome | string | null, targetType: string): boolean {
  if (track === "nem") return targetType === "nem" && outcome === "nem_approved";
  return targetType === "permit" && outcome === "issued";
}

/**
 * Has this one tracking target FINISHED the track? Its newest reading is not the whole answer.
 *
 * The monitor polls a target forever, and after issuance the jurisdiction's text moves on:
 * "Record Status: Finaled", "Status: Closed", "Status: Complete" classify needs_human_review,
 * "Final Approved" reviewed_by_ahj, "Inspections in progress" waiting. Judged on latest_outcome
 * alone, a FINALED permit read "not done" and the project could never hand off. So: the target
 * is done when it has EVER read the track's done outcome and no correction was read AFTER that
 * (a correction after issuance re-opens the filing; the same target reading issued again after
 * the correction closes it). ready_for_issue is still not done — it never is.
 *
 * Only readings that changed something are rows in permit_status_checks (shouldRecordStatusCheck),
 * and an issued / correction transition always is one. created_at ties (same millisecond) break
 * on rowid, i.e. insertion order.
 */
function targetFinishedTrack(db: AppDb, track: SubmittalTrackType, target: Row): boolean {
  const done = track === "nem" ? "nem_approved" : "issued";
  const targetType = s(target.target_type);
  if (!outcomeFinishesTrack(track, done, targetType)) return false; // wrong kind of target
  const latest = s(target.latest_outcome);
  if (latest === "correction_flagged") return false;
  if (latest === done) return true;
  const last = db.get<Row>(
    `SELECT outcome FROM permit_status_checks
      WHERE target_id = ? AND outcome IN (?, 'correction_flagged')
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [s(target.id), done],
  );
  return s(last?.outcome) === done;
}

/**
 * Which active tracking targets speak for one track.
 *
 *  - `own`: the newest-updated target TAGGED with this track's permit_type family.
 *  - otherwise the POOL: active targets of this track's kind (permit / nem) that are tagged to
 *    NO track in `required` — untagged ones (the dashboard's add-target form sends no
 *    permitType, so they carry ''), and ones tagged to a track this project does not require
 *    (a 'building' tag on a combo project). `poolDemand` is how many required tracks of this
 *    kind have no tagged target of their own and so draw on the pool.
 */
function trackTargets(db: AppDb, projectId: string, track: SubmittalTrackType, required: readonly SubmittalTrackType[]): { own: Row | null; pool: Row[]; poolDemand: number } {
  const active = db.query<Row>(
    "SELECT * FROM permit_check_targets WHERE project_id = ? AND active = 1 ORDER BY updated_at DESC, created_at DESC",
    [projectId],
  );
  const tagged = (t: SubmittalTrackType): Row | null => active.find((r) => trackPermitTypes(t).includes(s(r.permit_type))) ?? null;
  const own = tagged(track);
  const kind = targetTypeFor(track);
  const claimed = new Set([...required, track].flatMap(trackPermitTypes));
  const pool = active.filter((r) => s(r.target_type) === kind && !claimed.has(s(r.permit_type)));
  const poolDemand = [...new Set([...required, track])].filter((t) => targetTypeFor(t) === kind && !tagged(t)).length;
  return { own, pool, poolDemand };
}

/**
 * IS THIS TRACK DONE? The ONE answer — read by the tracks panel (getSubmittalTracks) and by the
 * installer handoff (repository.handoffBlockers → triggerHandoffIfReady). Two readers that
 * answered it differently let the panel say "1/3 issued" while the project handed off.
 *
 *  - A track with its own tagged target is judged by that target (targetFinishedTrack: ever
 *    issued / approved on its own kind of target, no correction since).
 *  - A track with none draws on the pool (trackTargets). ONE UNATTRIBUTED TARGET NEVER FINISHES
 *    TWO TRACKS: the pool finishes the tracks that draw on it only when it holds at least one
 *    target per such track AND every target in it is finished. Before this, on a multi-permit
 *    project the '' fallback resolved building AND electrical to the same newest-polled target,
 *    so the electrical permit's "issued" handed off a project whose building permit was still in
 *    plan review. We cannot tell which unattributed filing is which, so none may be unfinished.
 *
 * `required` is the full list of tracks being judged together (it decides which tags are
 * claimed and how many tracks draw on the pool).
 */
export function isTrackDone(db: AppDb, projectId: string, track: SubmittalTrackType, required: readonly SubmittalTrackType[]): boolean {
  const { own, pool, poolDemand } = trackTargets(db, projectId, track, required);
  if (own) return targetFinishedTrack(db, track, own);
  if (pool.length === 0 || pool.length < poolDemand) return false;
  return pool.every((r) => targetFinishedTrack(db, track, r));
}

// PermitCheckOutcome → track status. Issued-family wins; corrections surface next.
//
// ready_for_issue is NOT issued. It is the AHJ saying "approved, pay the issuance fee" — the
// project reads fees-due at the same moment, and folding it into "issued" made this track read
// "Permit issued / Done", count toward "N/M issued" and drop out of `outstanding` while the
// permit could not yet be downloaded and a person still had to pay.
//
// "issued" is decided by isTrackDone BEFORE this runs (deriveStatus); here an issued-family
// newest reading that isTrackDone did not accept — the wrong kind of target, or one pooled
// target that cannot finish two tracks — is a filing still under review, not a finished track.
function statusFromOutcome(outcome: PermitCheckOutcome | null): SubmittalTrackStatus | null {
  switch (outcome) {
    case "issued":
    case "nem_approved":
      return "in_review";
    case "ready_for_issue":
      return "ready_for_issue";
    case "correction_flagged":
      return "correction";
    case "reviewed_by_ahj":
    case "waiting":
      return "in_review";
    default:
      return null;
  }
}

interface TrackState {
  submissionStatus: string | null;
  submittedAt: string | null;
  applicationNumber: string;
  permitNumber: string;
  confirmationNumber: string;
  trackingUrl: string;
  outcome: PermitCheckOutcome | null;
  statusLabel: string;
  lastCheckedAt: string | null;
  /** isTrackDone's verdict for this track (the ONE "is this track done" rule). */
  done: boolean;
}

// Read the latest submission + tracking target for one track. Legacy rows created
// before per-track support carry permit_type='permit'; fold those into the combo/
// permit track so existing projects still show their submission status (trackPermitTypes).
function readTrackState(db: AppDb, projectId: string, track: SubmittalTrackType, required: readonly SubmittalTrackType[]): TrackState {
  const permitTypes = trackPermitTypes(track);
  const placeholders = permitTypes.map(() => "?").join(",");

  const submission = db.get<Row>(
    `SELECT * FROM submissions
      WHERE project_id = ? AND permit_type IN (${placeholders})
      ORDER BY created_at DESC LIMIT 1`,
    [projectId, ...permitTypes],
  );

  // Tracking target: the one tagged with this track, else the newest of the pool (untagged,
  // or tagged to a track this project does not require) — the same resolution isTrackDone
  // judges, so what the panel shows is the target the verdict came from.
  const { own, pool } = trackTargets(db, projectId, track, required);
  const target = own ?? pool[0] ?? null;

  return {
    submissionStatus: submission ? s(submission.status) : null,
    submittedAt: submission && submission.submitted_at != null ? s(submission.submitted_at) : null,
    applicationNumber: s(submission?.application_number) || s(target?.application_number),
    permitNumber: s(submission?.permit_number) || s(target?.permit_number),
    confirmationNumber: s(submission?.confirmation_number),
    trackingUrl: s(target?.tracking_url),
    outcome: target?.latest_outcome ? (s(target.latest_outcome) as PermitCheckOutcome) : null,
    statusLabel: s(target?.latest_status_label),
    lastCheckedAt: target?.last_checked_at != null ? s(target.last_checked_at) : null,
    done: isTrackDone(db, projectId, track, required),
  };
}

/**
 * The tracks among `tracks` that are NOT done, judged together (they are the `required` list
 * isTrackDone attributes targets against). Empty means every one is done.
 */
export function unfinishedTracks(db: AppDb, projectId: string, tracks: readonly SubmittalTrackType[]): SubmittalTrackType[] {
  return tracks.filter((t) => !isTrackDone(db, projectId, t, tracks));
}

/**
 * On a MULTI-PERMIT project (more than one permit track among `tracks`): active PERMIT targets
 * attributed to none of them (untagged, or tagged to a track the project does not require) that
 * have not finished — judged by the same targetFinishedTrack rule. isTrackDone consults that pool
 * only when a track has no target of its own; this catches the rest: every permit track tagged
 * and issued, plus an unattributed permit the monitor is still polling in review (an MPU filed
 * without an MPU track, a dashboard-added target). With several permits in play we cannot say
 * which filing that is, so the handoff waits for it too.
 *
 * Deliberately NOT applied to a single-permit project: there the pool rule already covers the
 * one permit track, and nothing in the app can deactivate or delete one tracking target, so a
 * stale stray target would strand the handoff with no remedy but SQL.
 */
export function unfinishedUnattributedTargets(db: AppDb, projectId: string, tracks: readonly SubmittalTrackType[]): number {
  if (tracks.filter((t) => targetTypeFor(t) === "permit").length < 2) return 0;
  const claimed = new Set(tracks.flatMap(trackPermitTypes));
  const active = db.query<Row>("SELECT * FROM permit_check_targets WHERE project_id = ? AND active = 1 AND target_type = 'permit'", [projectId]);
  return active.filter((r) => !claimed.has(s(r.permit_type)) && !targetFinishedTrack(db, "permit", r)).length;
}

function deriveStatus(state: TrackState): SubmittalTrackStatus {
  if (state.done) return "issued";
  const fromOutcome = statusFromOutcome(state.outcome);
  if (fromOutcome === "ready_for_issue") return "ready_for_issue";
  if (fromOutcome === "correction") return "correction";
  // Submitted to the portal already?
  if (state.submissionStatus === "submitted") {
    return fromOutcome === "in_review" || state.trackingUrl ? "in_review" : "submitted";
  }
  if (state.submissionStatus === "awaiting_human_submit" || state.submissionStatus === "staged") {
    return "staged";
  }
  // paused_for_human / failed runs staged NOTHING on the portal — the track genuinely
  // has not started; the portal-runs panel carries the pause/failure banner.
  if (fromOutcome) return fromOutcome; // a target exists even without a submission row
  return "not_started";
}

function categoryFor(type: SubmittalTrackType): "utility" | "permit" {
  return type === "nem" ? "utility" : "permit";
}

// Status wording differs by category — a utility NEM filing is "approved (PTO)",
// an AHJ permit is "issued". Keeps the operator's mental model correct.
function statusLabelFor(status: SubmittalTrackStatus, category: "utility" | "permit"): string {
  if (category === "utility") {
    const utilityLabels: Record<SubmittalTrackStatus, string> = {
      not_started: "Not started",
      staged: "Staged — awaiting manual submit",
      submitted: "Submitted to utility",
      in_review: "Under utility review",
      correction: "Utility correction requested",
      ready_for_issue: "Approved — fee due",
      issued: "Approved — PTO granted",
    };
    return utilityLabels[status];
  }
  const permitLabels: Record<SubmittalTrackStatus, string> = {
    not_started: "Not started",
    staged: "Staged — awaiting manual submit",
    submitted: "Submitted to AHJ",
    in_review: "Under AHJ review",
    correction: "Correction requested",
    ready_for_issue: "Ready for issue — fee due",
    issued: "Permit issued",
  };
  return permitLabels[status];
}

function nextActionFor(status: SubmittalTrackStatus, channel: string, type: SubmittalTrackType, prerequisites: PermitPrerequisiteStep[] = []): string {
  const base = nextActionCore(status, channel, type);
  // A PREREQUISITE OFFICE IS ITS OWN STEP, BEFORE this filing (Waltham: "ALL Plans need to go to
  // Fire Prevention Prior to Building Department drop off"). Said first, cited, until filed.
  if (!prerequisites.length || !(status === "not_started" || status === "staged")) return base;
  const steps = prerequisites.map((p, i) => `(${i + 1}) ${p.step} [${p.sourceUrl}]`).join(" ");
  return `FIRST, at another office: ${steps}. THEN: ${base}`;
}

function nextActionCore(status: SubmittalTrackStatus, channel: string, type: SubmittalTrackType): string {
  // Accela (Oregon ePermitting) instant-issues most ELECTRICAL/renewable-energy permits
  // right after the fee is paid and the final submit is clicked — the approval arrives by
  // email, which the email tracker already detects. Set that expectation on those tracks.
  const isAccela = /accela|epermitting/i.test(channel);
  const isElectricalLike = type === "electrical" || type === "combo" || type === "permit" || type === "mpu";
  const accelaInstantNote = isAccela && isElectricalLike
    ? " On Accela this electrical/renewable-energy permit is usually issued instantly once fees are paid and the final submit is clicked — watch for the approval email."
    : "";
  switch (status) {
    // An unresolved channel arrives as "Unknown — verify on the AHJ site"; "Stage in Unknown"
    // read as a broken template on the project page.
    case "not_started": return /^\s*(unknown|$)|not yet identified/i.test(channel)
      ? (type === "nem"
        ? "Find where this utility takes interconnection applications (its interconnection / contractor page), stage it there, submit manually, then record the number here."
        : "Stage in the AHJ portal (not yet identified — verify it on the AHJ's website), submit manually, then record the number here.")
      : `Stage in ${channel}, submit manually, then record the number here.${accelaInstantNote}`;
    case "staged": return `Review the staged portal, submit manually, then mark it submitted below.${accelaInstantNote}`;
    case "submitted": return `Add the public status URL so the poller can track it to approval.${accelaInstantNote}`;
    case "in_review": return "Tracking — the poller is checking the portal for status changes.";
    case "correction": return "A correction was requested — resolve it and resubmit.";
    case "ready_for_issue": return "Approved — a person pays the issuance fee in the portal (automation never pays fees); the poller then watches for the issued permit.";
    case "issued": return "Done — issued / approved.";
  }
}

// Capture fields differ by category: a utility NEM application has no AHJ "permit
// number" (its final artifact is the PTO/approval, captured as confirmation), while
// an AHJ permit issues a permit number.
function captureFieldsFor(type: SubmittalTrackType): SubmittalTrack["captureFields"] {
  if (categoryFor(type) === "utility") {
    return [
      { key: "applicationNumber", label: "Interconnection / case #", placeholder: "e.g. APP-2026-0042" },
      { key: "confirmationNumber", label: "Confirmation / PTO #", placeholder: "submission or PTO reference" },
      { key: "trackingUrl", label: "Public status URL", placeholder: "no-login status link, if any" },
    ];
  }
  return [
    { key: "applicationNumber", label: "Application / record #", placeholder: "e.g. 24-001234-STR" },
    { key: "permitNumber", label: "Permit # (once issued)", placeholder: "issued permit number" },
    { key: "confirmationNumber", label: "Confirmation #", placeholder: "submission confirmation" },
    { key: "trackingUrl", label: "Public status URL", placeholder: "no-login record link (e.g. Accela CapDetail)" },
  ];
}

/** Build the full submittal-track view for a project: every required track + status. */
export function getSubmittalTracks(db: AppDb, project: ProjectRecord): SubmittalTrackView[] {
  const required = requiredTracks(project);
  const answer = permitStructureAnswer(project);
  const utility = required.includes("nem") ? utilityTrackPresentation(db, project) : null;
  return required.map((type) => {
    const state = readTrackState(db, project.id, type, required);
    const status = deriveStatus(state);
    const category = categoryFor(type);
    const resolved = channelResolution(db, type, project);
    const channel = resolved.channel;
    // Prerequisites precede the building-side filing (the one that goes to the other office's
    // stamp first); on a single-permit project, that one permit.
    const prerequisites = category === "permit" && type !== "electrical" && type !== "mpu" ? answer.prerequisites : [];

    // Look up recipe for this track so the UI can show the linear record-portal flow.
    const scopeType = category === "utility" ? "utility" : "ahj";
    const profileKey = recipeProfileKey({ scopeType, state: project.state, ahj: project.ahj, utility: project.utility });
    const recipeRow = db.get<Row>(
      "SELECT id, status, portal_url FROM portal_recipes WHERE profile_key = ? ORDER BY version DESC LIMIT 1",
      [profileKey],
    );

    // Fallback portal URL when no recipe exists yet — used by the credential-matching
    // chip so the operator can store a login before recording. Try in order:
    // 1. KB profile (user-accumulated knowledge from previous projects)
    // 2. applicationDocs profile (built-in AHJ/utility definitions)
    //
    // A found portal (the per-job lookup's, or the utility lookup's, cited) comes first. Every
    // candidate must be SOMEWHERE AN APPLICATION IS FILED on THIS track: a profile's sourceUrl is
    // often an information page (portland.gov/ppd/solar-development/solar-permits), and a KB
    // row can hold the other track's portal (rule 5).
    const fitsHere = (u: string) => Boolean(u) && Boolean(trackSafeUrl(type, u)) && !isInformationalPageUrl(u);
    let kbPortalUrl: string | undefined;
    if (!recipeRow || !s(recipeRow.portal_url)) {
      if (fitsHere(resolved.portalUrl)) kbPortalUrl = resolved.portalUrl;
      const kbField = scopeType === "utility" ? "utility" : "ahj";
      const kbVal = scopeType === "utility" ? project.utility : project.ahj;
      const kbRow = !kbPortalUrl && kbVal
        ? db.get<Row>(`SELECT portal_url FROM permit_utility_knowledge WHERE ${kbField} = ? AND portal_url IS NOT NULL AND portal_url != '' LIMIT 1`, [kbVal])
        : null;
      if (kbRow && fitsHere(s(kbRow.portal_url))) {
        kbPortalUrl = s(kbRow.portal_url);
      } else if (!kbPortalUrl) {
        // Fall back to applicationDocs profile sourceUrl (built-in AHJ/utility definitions).
        const appProfile = findApplicationProfile(project);
        if (appProfile?.sourceUrl && fitsHere(appProfile.sourceUrl)) kbPortalUrl = appProfile.sourceUrl;
      }
    }

    return {
      type,
      label: type === "nem" ? (utility?.label ?? TRACK_LABELS.nem) : permitTrackLabel(type, answer),
      category,
      channel,
      channelBasis: resolved.basis,
      ...(category === "permit" ? { structureBasis: answer.basis, prerequisites } : {}),
      status,
      // The portal's own words — unless they say "issued" of a track isTrackDone did not accept
      // (one pooled target cannot finish two tracks), where they would contradict the status.
      statusLabel: (!state.done && (state.outcome === "issued" || state.outcome === "nem_approved") ? "" : state.statusLabel)
        || statusLabelFor(status, category),
      nextAction: nextActionFor(status, channel, type, prerequisites),
      captureFields: captureFieldsFor(type),
      applicationNumber: state.applicationNumber,
      permitNumber: state.permitNumber,
      confirmationNumber: state.confirmationNumber,
      trackingUrl: state.trackingUrl,
      submittedAt: state.submittedAt,
      lastCheckedAt: state.lastCheckedAt,
      outstanding: status !== "issued",
      hasRecipe: !!recipeRow,
      recipeStatus: recipeRow ? s(recipeRow.status) : undefined,
      recipePortalUrl: (recipeRow ? s(recipeRow.portal_url) : undefined) || kbPortalUrl,
      recipeId: recipeRow ? s(recipeRow.id) : undefined,
      recipeScopeType: scopeType,
    };
  });
}

/**
 * Record that the operator manually submitted one track, capturing its numbers and
 * (optionally) the public tracking URL. Writes a `submitted` submission row tagged
 * with the track's permit_type and ensures a permit_check_target exists so the
 * poller follows it through to issuance. The system NEVER auto-submits — this is the
 * human confirming a submit they performed.
 */
export function markTrackSubmitted(
  db: AppDb,
  project: ProjectRecord,
  type: SubmittalTrackType,
  input: {
    applicationNumber?: string;
    permitNumber?: string;
    confirmationNumber?: string;
    trackingUrl?: string;
    submittedBy?: string;
    notes?: string;
    /** WHEN IT ACTUALLY WENT IN. Defaults to now, which is right when the operator files in the
     *  portal and records it in the same sitting. File on Monday and record on Wednesday and the
     *  default is wrong in the one field the client tracker exists to report — their review clock
     *  would appear to start two days late. ISO date or datetime. */
    submittedAt?: string;
  },
): void {
  if (!requiredTracks(project).includes(type)) {
    throw new HttpError(400, `This project does not require a "${type}" submittal track.`);
  }
  const ts = nowIso();
  // THE FILING DATE IS VALIDATED, NEVER COERCED. An unparseable string stored here reaches a
  // client's page as a confident wrong fact about the only date that matters to them, and a
  // future one says a jurisdiction received something it has not. Both refuse.
  //
  // The skew allowance exists because "now" from a browser whose clock runs a little fast is not
  // somebody claiming to have filed tomorrow, and refusing it is a support call for nothing.
  const FUTURE_SKEW_MS = 5 * 60_000;
  const submittedAt = ((): string => {
    const raw = (input.submittedAt || "").trim();
    if (!raw) return ts;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `Could not read "${raw}" as a filing date. Use YYYY-MM-DD, or leave it blank for today.`);
    }
    if (parsed.getTime() > Date.now() + FUTURE_SKEW_MS) {
      throw new HttpError(400, `That filing date is in the future (${raw}). A permit cannot have been submitted tomorrow.`);
    }
    return parsed.toISOString();
  })();
  const applicationNumber = (input.applicationNumber || "").trim();
  const permitNumber = (input.permitNumber || "").trim();
  const confirmationNumber = (input.confirmationNumber || "").trim();
  const trackingUrl = (input.trackingUrl || "").trim();
  // Refused before anything is written — the same rule ensureCheckTarget enforces inside the
  // transaction below, checked here too so the refusal is the whole answer rather than a
  // rollback of a half-written submission.
  refuseUtilityUrlOnPermitTarget(targetTypeFor(type), trackingUrl);

  db.transaction(() => {
    // If a staged run left an awaiting_human_submit submission for this track, the
    // operator's manual submit RESOLVES it — update that row in place rather than
    // inserting a second one, so the track never counts as both staged and submitted.
    const awaiting = db.get<Row>(
      `SELECT id FROM submissions
        WHERE project_id = ? AND permit_type = ? AND status = 'awaiting_human_submit'
        ORDER BY created_at DESC LIMIT 1`,
      [project.id, type],
    );
    if (awaiting) {
      db.run(
        `UPDATE submissions
           SET status = 'submitted', application_number = ?, permit_number = ?,
               confirmation_number = ?, submitted_at = ?, submitted_by = ?, notes = ?
         WHERE id = ?`,
        [
          applicationNumber,
          permitNumber,
          confirmationNumber,
          submittedAt,
          (input.submittedBy || "").trim(),
          (input.notes || `${TRACK_LABELS[type]} submitted manually by operator.`),
          s(awaiting.id),
        ],
      );
    } else {
      db.run(
        `INSERT INTO submissions
          (id, project_id, portal_profile_id, submission_type, permit_type, status,
           application_number, permit_number, confirmation_number, submitted_at, submitted_by,
           screenshots_path, notes, created_at)
         VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, '', ?, ?)`,
        [
          randomUUID(),
          project.id,
          null,
          type === "nem" ? "interconnection" : "permit",
          type,
          applicationNumber,
          permitNumber,
          confirmationNumber,
          submittedAt,
          (input.submittedBy || "").trim(),
          (input.notes || `${TRACK_LABELS[type]} submitted manually by operator.`),
          ts,   // created_at is when the ROW was written; submitted_at is when it was FILED
        ],
      );
    }

    // Close out the staged portal run for this track too, so the autopilot approve
    // gate (which keys on an awaiting_human_submit run) can't re-submit a filing the
    // human already completed in the portal.
    db.run(
      `UPDATE portal_runs SET status = 'submitted', finished_at = ?
        WHERE project_id = ? AND permit_type = ? AND status = 'awaiting_human_submit'`,
      [ts, project.id, type],
    );

    // Advance the project once every staged track is resolved — mirrors
    // captureConfirmation. Only post-staging statuses advance: a manual submit recorded
    // on a project that never staged must not skip the pre-stage pipeline.
    // A second arm of this test used to also accept the submit-staging status. That status
    // was removed from ProjectStatus (2026-09-19) because it had zero writers anywhere, so
    // the arm was unreachable. `awaiting_human_submit` is the only post-staging status a
    // manual submit can be recorded against.
    if (project.status === "awaiting_human_submit") {
      const stillAwaiting = db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM submissions WHERE project_id = ? AND status = 'awaiting_human_submit'",
        [project.id],
      );
      const remaining = Number(stillAwaiting?.n ?? 0);
      db.run("UPDATE projects SET status = ?, current_stage = ?, stage_detail = ?, updated_at = ? WHERE id = ?", [
        remaining > 0 ? "awaiting_human_submit" : "submitted",
        remaining > 0
          ? `${TRACK_LABELS[type]} submitted; ${remaining} track(s) still awaiting human submit.`
          : `${TRACK_LABELS[type]} submitted manually. Tracking approval.`,
        // Same two states captureConfirmation records, from the manual-submit door — a project
        // half-filed here must not read any differently from one half-filed there.
        (remaining > 0 ? "submitted_partial" : "submitted_all") satisfies StageDetail,
        ts,
        project.id,
      ]);
    }

    // Ensure a tracking target so the poller follows this track. THE ONE CREATOR —
    // see ensureCheckTarget below; this door and captureConfirmation's and the
    // operator's "add target" all go through it so a re-run supersedes, never appends.
    ensureCheckTarget(db, project, {
      track: type,
      applicationNumber,
      permitNumber,
      portalUrl: trackingUrl,
      trackingUrl,
      notes: `${TRACK_LABELS[type]} tracking`,
      nextCheckAt: ts, // check on the next poll tick
    });
  });
}

// ---------------------------------------------------------------------------
// ensureCheckTarget — THE ONE PLACE A permit_check_targets ROW IS BORN.
//
// Three doors record that a filing went out, and until this function existed two
// of them wrote their own INSERT and the third wrote nothing at all:
//
//   1. markTrackSubmitted (above)          — the operator's "mark this track submitted".
//   2. createPermitCheckTarget (repository)— the operator's "add target" form.
//   3. captureConfirmation (repository)    — the human's confirmation after they clicked
//                                            the portal's final submit. CREATED NO TARGET,
//                                            so a filing confirmed through the normal panel
//                                            was never polled again. On the live database
//                                            every target was hand-added by the operator
//                                            60-90 seconds AFTER each confirmation
//                                            (audit: submission.confirmation_captured at
//                                            16:42:00 → permit_target.created at 16:43:05).
//
// DEDUPE, because re-running an action must SUPERSEDE, not append. The live database
// records the same portal run (b364128a, project ec5c36d3) captured TWICE, five minutes
// apart. A second confirmation must not mint a second target: two rows for one filing
// poll the same application twice, and the poller would report a filing as both "issued"
// and "waiting" depending on which row was read.
//
// MATCH ORDER (active rows only — a deactivated target is deliberately retired):
//   (a) FILING IDENTITY — same target_type, and any non-empty identifier we carry
//       (application OR permit number) equals any non-empty identifier the row carries.
//       The cross-match matters on real rows: Accela writes the same string into BOTH
//       columns (187-26-000309-STR) while PowerClerk leaves permit_number empty.
//   (b) TRACK IDENTITY — same non-empty permit_type. A project files ONE live building
//       permit at a time; a new number for that track is a correction or a refiling, and
//       the right answer is to update the row rather than leave a sibling polling a dead
//       application forever. (This is exactly what markTrackSubmitted did before the
//       extraction, preserved deliberately.)
//
// What a reuse NEVER touches: last_checked_at, latest_outcome, latest_status_label.
// Nothing was checked, and aging a reading that never happened is the lie
// markCorrectionResubmitted already refuses to tell.
// ---------------------------------------------------------------------------

export interface EnsureCheckTargetInput {
  /** The submittal track, when the caller knows it. Supplies permit_type, target_type
   *  and the portal_name default. Omit it and the caller must say targetType itself. */
  track?: SubmittalTrackType;
  /** Override when there is no track (the operator's add-target form). */
  targetType?: "permit" | "nem";
  /** Override when there is no track. '' is honest — it means "discipline unknown". */
  permitType?: string;
  applicationNumber?: string;
  permitNumber?: string;
  jurisdiction?: string;
  portalName?: string;
  portalUrl?: string;
  trackingUrl?: string;
  notes?: string;
  checkFrequencyDays?: number;
  /** When the poller should first look. Defaults to NOW — a filing just confirmed is due
   *  on the next sweep, not in check_frequency_days' time. The operator's add-target form
   *  passes its own value so that path stays byte-identical to what it did before. */
  nextCheckAt?: string;
}

export interface EnsureCheckTargetResult {
  targetId: string;
  /** False means an existing active target was reused — the caller must not audit a create. */
  created: boolean;
  /** WHICH rule matched, so an operator reading an audit row can tell a filing-number hit
   *  from a track-level one. "none" accompanies created:true. */
  matchedOn: "application_number" | "permit_type" | "none";
}

// RULE 5 AT THE ONE CREATOR. A permit target whose URL is a utility interconnection portal is
// the wrong-system filing bug in waiting: the permit monitor, the correction reopen and the
// knowledge learner all treat a permit target's URL as the AHJ's. Production row 99ea32c3 came
// in through the add-target form; the mark-submitted door (the track card's "Public status URL")
// wrote the same row from a building/electrical/combo track until this guard sat here, where
// every door passes. captureConfirmation passes no URL, so it is never refused.
//
// THE MESSAGE NAMES A CONTROL THAT EXISTS. It used to say "add it as a NEM target (target type:
// NEM)", and nothing on the page lets an operator pick a target type. The place a utility status
// link belongs is the NEM track card's "Public status URL" (captureFields below), saved with
// "Save & track".
export const UTILITY_URL_ON_PERMIT_TARGET_MESSAGE =
  "That URL is a utility interconnection portal, not a permit portal, so it was not saved on a permit. "
  + "Record it on the utility interconnection track card (the card under \"Utility\") instead: open \"I submitted it → capture #\" "
  + `(or "Update numbers / status link"), paste it into "Public status URL" and click "Save & track". `
  + "The permit's tracking target takes the AHJ's permit portal URL.";

export function refuseUtilityUrlOnPermitTarget(targetType: "permit" | "nem", ...urls: Array<string | null | undefined>): void {
  if (targetType === "nem") return;
  if (urls.some((u) => isUtilityPlatformUrl((u || "").trim()))) {
    throw new HttpError(400, UTILITY_URL_ON_PERMIT_TARGET_MESSAGE);
  }
}

export function ensureCheckTarget(
  db: AppDb,
  project: ProjectRecord,
  input: EnsureCheckTargetInput,
): EnsureCheckTargetResult {
  const ts = nowIso();
  const track = input.track;
  const targetType: "permit" | "nem" = input.targetType ?? (track ? targetTypeFor(track) : "permit");
  const permitType = (input.permitType ?? (track ?? (targetType === "nem" ? "nem" : ""))).trim();
  const applicationNumber = (input.applicationNumber || "").trim();
  const permitNumber = (input.permitNumber || "").trim();
  const trackingUrl = (input.trackingUrl || "").trim();
  const portalUrl = (input.portalUrl || "").trim();
  refuseUtilityUrlOnPermitTarget(targetType, portalUrl, trackingUrl);

  const candidates = db.query<Row>(
    "SELECT * FROM permit_check_targets WHERE project_id = ? AND active = 1 ORDER BY created_at ASC",
    [project.id],
  );
  const mine = [applicationNumber, permitNumber].filter(Boolean);
  let matchedOn: EnsureCheckTargetResult["matchedOn"] = "none";
  let existing: Row | undefined;
  if (mine.length) {
    existing = candidates.find((row) => {
      if (s(row.target_type) !== targetType) return false;
      const theirs = [s(row.application_number).trim(), s(row.permit_number).trim()].filter(Boolean);
      return theirs.some((t) => mine.includes(t));
    });
    if (existing) matchedOn = "application_number";
  }
  if (!existing && permitType) {
    existing = candidates.find((row) => s(row.permit_type).trim() === permitType);
    if (existing) matchedOn = "permit_type";
  }

  if (existing) {
    db.run(
      `UPDATE permit_check_targets
         SET application_number = COALESCE(NULLIF(?, ''), application_number),
             permit_number = COALESCE(NULLIF(?, ''), permit_number),
             tracking_url = COALESCE(NULLIF(?, ''), tracking_url),
             portal_url = COALESCE(NULLIF(?, ''), portal_url),
             updated_at = ?
       WHERE id = ?`,
      [applicationNumber, permitNumber, trackingUrl, portalUrl, ts, s(existing.id)],
    );
    return { targetId: s(existing.id), created: false, matchedOn };
  }

  const frequency = Math.max(1, Math.floor(Number(input.checkFrequencyDays || 7)));
  const targetId = randomUUID();
  db.run(
    `INSERT INTO permit_check_targets
      (id, project_id, jurisdiction, portal_name, portal_url, application_number, permit_number,
       check_frequency_days, active, last_checked_at, next_check_at, latest_outcome, latest_status_label,
       notes, target_type, permit_type, portal_platform, tracking_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, NULL, '', ?, ?, ?, ?, ?, ?, ?)`,
    [
      targetId,
      project.id,
      input.jurisdiction ?? (targetType === "nem" ? project.utility || "" : project.ahj || ""),
      input.portalName ?? (track ? targetPortalName(track, project, db) : ""),
      portalUrl,
      applicationNumber,
      permitNumber,
      frequency,
      input.nextCheckAt ?? ts,
      input.notes ?? "",
      targetType,
      permitType,
      // Auto-detected from the URL, the way the operator's add-target form has always done
      // it, so the status-check strategy is chosen without anyone picking a platform.
      portalUrl ? detectPlatform(portalUrl) : "unknown",
      trackingUrl,
      ts,
      ts,
    ],
  );
  return { targetId, created: true, matchedOn: "none" };
}
