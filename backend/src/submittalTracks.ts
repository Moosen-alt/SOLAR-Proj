// ---------------------------------------------------------------------------
// Submittal tracks — a project's independent permit/interconnection filings.
//
// A residential solar project usually needs MORE than one filing:
//   - NEM / interconnection with the utility (PowerClerk, etc.)
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
  SubmittalTrack,
  SubmittalTrackStatus,
  SubmittalTrackType,
} from "../../shared/src/types";
import { findApplicationProfile, describePermitType } from "./applicationDocs";
import { HttpError } from "./httpError";
import { nowIso } from "./time";
import { randomUUID } from "node:crypto";

interface Row { [key: string]: unknown }
const s = (v: unknown): string => (v == null ? "" : String(v));

const TRACK_LABELS: Record<SubmittalTrackType, string> = {
  nem: "Utility NEM / interconnection",
  building: "Building permit (BLD)",
  electrical: "Electrical permit (ELE)",
  combo: "Building + electrical permit (combo)",
  permit: "AHJ permit",
};

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

  const profile = findApplicationProfile(project);
  const info = describePermitType(profile);
  if (info.structure === "separate") {
    tracks.push("building", "electrical");
  } else {
    tracks.push("combo");
  }
  return tracks;
}

function channelFor(track: SubmittalTrackType, project: ProjectRecord): string {
  if (track === "nem") {
    const u = (project.utility || "").toLowerCase();
    if (/pge|pacific|portland general|pacificorp/.test(u)) return "PowerClerk / utility NEM portal";
    return "Utility NEM portal";
  }
  const profile = findApplicationProfile(project);
  return describePermitType(profile).submissionMethod || "AHJ portal";
}

// PermitCheckOutcome → track status. Issued-family wins; corrections surface next.
function statusFromOutcome(outcome: PermitCheckOutcome | null): SubmittalTrackStatus | null {
  switch (outcome) {
    case "issued":
    case "ready_for_issue":
    case "nem_approved":
      return "issued";
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
}

// Read the latest submission + tracking target for one track. Legacy rows created
// before per-track support carry permit_type='permit'; fold those into the combo/
// permit track so existing projects still show their submission status.
function readTrackState(db: AppDb, projectId: string, track: SubmittalTrackType): TrackState {
  const permitTypes = track === "combo" || track === "permit" ? ["combo", "permit"] : [track];
  const placeholders = permitTypes.map(() => "?").join(",");

  const submission = db.get<Row>(
    `SELECT * FROM submissions
      WHERE project_id = ? AND permit_type IN (${placeholders})
      ORDER BY created_at DESC LIMIT 1`,
    [projectId, ...permitTypes],
  );

  // Tracking target: prefer one tagged with this permit_type, else fall back to the
  // matching target_type (so NEM and permit targets created before this feature map in).
  const target =
    db.get<Row>(
      `SELECT * FROM permit_check_targets
        WHERE project_id = ? AND permit_type IN (${placeholders}) AND active = 1
        ORDER BY updated_at DESC LIMIT 1`,
      [projectId, ...permitTypes],
    ) ||
    db.get<Row>(
      `SELECT * FROM permit_check_targets
        WHERE project_id = ? AND permit_type = '' AND target_type = ? AND active = 1
        ORDER BY updated_at DESC LIMIT 1`,
      [projectId, targetTypeFor(track)],
    );

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
  };
}

function deriveStatus(state: TrackState): SubmittalTrackStatus {
  const fromOutcome = statusFromOutcome(state.outcome);
  if (fromOutcome === "issued") return "issued";
  if (fromOutcome === "correction") return "correction";
  // Submitted to the portal already?
  if (state.submissionStatus === "submitted") {
    return fromOutcome === "in_review" || state.trackingUrl ? "in_review" : "submitted";
  }
  if (state.submissionStatus === "awaiting_human_submit" || state.submissionStatus === "staged") {
    return "staged";
  }
  if (fromOutcome) return fromOutcome; // a target exists even without a submission row
  return "not_started";
}

const STATUS_LABELS: Record<SubmittalTrackStatus, string> = {
  not_started: "Not started",
  staged: "Staged — awaiting manual submit",
  submitted: "Submitted",
  in_review: "In review at AHJ/utility",
  correction: "Correction requested",
  issued: "Issued / approved",
};

/** Build the full submittal-track view for a project: every required track + status. */
export function getSubmittalTracks(db: AppDb, project: ProjectRecord): SubmittalTrack[] {
  return requiredTracks(project).map((type) => {
    const state = readTrackState(db, project.id, type);
    const status = deriveStatus(state);
    return {
      type,
      label: TRACK_LABELS[type],
      channel: channelFor(type, project),
      status,
      statusLabel: state.statusLabel || STATUS_LABELS[status],
      applicationNumber: state.applicationNumber,
      permitNumber: state.permitNumber,
      confirmationNumber: state.confirmationNumber,
      trackingUrl: state.trackingUrl,
      submittedAt: state.submittedAt,
      lastCheckedAt: state.lastCheckedAt,
      outstanding: status !== "issued",
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
  },
): void {
  if (!requiredTracks(project).includes(type)) {
    throw new HttpError(400, `This project does not require a "${type}" submittal track.`);
  }
  const ts = nowIso();
  const applicationNumber = (input.applicationNumber || "").trim();
  const permitNumber = (input.permitNumber || "").trim();
  const confirmationNumber = (input.confirmationNumber || "").trim();
  const trackingUrl = (input.trackingUrl || "").trim();

  db.transaction(() => {
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
        ts,
        (input.submittedBy || "").trim(),
        (input.notes || `${TRACK_LABELS[type]} submitted manually by operator.`),
        ts,
      ],
    );

    // Ensure a tracking target so the poller follows this track. Reuse an existing
    // active target of the same permit_type; otherwise create one.
    const existing = db.get<Row>(
      `SELECT id FROM permit_check_targets
        WHERE project_id = ? AND permit_type = ? AND active = 1 LIMIT 1`,
      [project.id, type],
    );
    if (existing) {
      db.run(
        `UPDATE permit_check_targets
           SET application_number = COALESCE(NULLIF(?, ''), application_number),
               permit_number = COALESCE(NULLIF(?, ''), permit_number),
               tracking_url = COALESCE(NULLIF(?, ''), tracking_url),
               updated_at = ?
         WHERE id = ?`,
        [applicationNumber, permitNumber, trackingUrl, ts, s(existing.id)],
      );
    } else {
      const frequency = 7;
      db.run(
        `INSERT INTO permit_check_targets
          (id, project_id, jurisdiction, portal_name, portal_url, application_number, permit_number,
           check_frequency_days, active, last_checked_at, next_check_at, latest_outcome, latest_status_label,
           notes, target_type, permit_type, portal_platform, tracking_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, NULL, '', ?, ?, ?, '', ?, ?, ?)`,
        [
          randomUUID(),
          project.id,
          type === "nem" ? project.utility || "" : project.ahj || "",
          channelFor(type, project),
          trackingUrl,
          applicationNumber,
          permitNumber,
          frequency,
          ts, // next_check_at — check on the next poll tick
          `${TRACK_LABELS[type]} tracking`,
          targetTypeFor(type),
          type,
          trackingUrl,
          ts,
          ts,
        ],
      );
    }
  });
}
