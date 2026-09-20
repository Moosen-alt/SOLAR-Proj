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
import { findApplicationProfile, describePermitType, permitStructureForProject } from "./applicationDocs";
import { findAhjProcessProfile } from "./processProfiles";
import { recipeProfileKey } from "./portalRecipes";
import { detectPlatform } from "./publicPermitStatus";
import { HttpError } from "./httpError";
import { nowIso } from "./time";
import { randomUUID } from "node:crypto";

interface Row { [key: string]: unknown }
const s = (v: unknown): string => (v == null ? "" : String(v));

const TRACK_LABELS: Record<SubmittalTrackType, string> = {
  nem: "Utility net metering (NEM) / interconnection",
  building: "Building permit (BLD)",
  electrical: "Electrical permit (ELE)",
  combo: "Building + electrical permit (combo)",
  permit: "AHJ permit",
  mpu: "Main panel / service upgrade permit (MPU)",
};

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
  if (permitStructureForProject(project) === "separate") {
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

function channelFor(track: SubmittalTrackType, project: ProjectRecord): string {
  if (track === "nem") {
    const u = (project.utility || "").toLowerCase();
    if (/pge|portland general(?!\s*electric\s*pac)/.test(u)) return "PowerClerk (PGE NEM portal)";
      if (/pacificorp|pacific power/.test(u)) return "Pacific Power NEM portal (PowerClerk: pacificorpnetmetering.powerclerk.com)";
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
    issued: "Permit issued",
  };
  return permitLabels[status];
}

function nextActionFor(status: SubmittalTrackStatus, channel: string, type: SubmittalTrackType): string {
  // Accela (Oregon ePermitting) instant-issues most ELECTRICAL/renewable-energy permits
  // right after the fee is paid and the final submit is clicked — the approval arrives by
  // email, which the email tracker already detects. Set that expectation on those tracks.
  const isAccela = /accela|epermitting/i.test(channel);
  const isElectricalLike = type === "electrical" || type === "combo" || type === "permit" || type === "mpu";
  const accelaInstantNote = isAccela && isElectricalLike
    ? " On Accela this electrical/renewable-energy permit is usually issued instantly once fees are paid and the final submit is clicked — watch for the approval email."
    : "";
  switch (status) {
    case "not_started": return `Stage in ${channel}, submit manually, then record the number here.${accelaInstantNote}`;
    case "staged": return `Review the staged portal, submit manually, then mark it submitted below.${accelaInstantNote}`;
    case "submitted": return `Add the public status URL so the poller can track it to approval.${accelaInstantNote}`;
    case "in_review": return "Tracking — the poller is checking the portal for status changes.";
    case "correction": return "A correction was requested — resolve it and resubmit.";
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
export function getSubmittalTracks(db: AppDb, project: ProjectRecord): SubmittalTrack[] {
  return requiredTracks(project).map((type) => {
    const state = readTrackState(db, project.id, type);
    const status = deriveStatus(state);
    const category = categoryFor(type);
    const channel = channelFor(type, project);

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
    let kbPortalUrl: string | undefined;
    if (!recipeRow || !s(recipeRow.portal_url)) {
      const kbField = scopeType === "utility" ? "utility" : "ahj";
      const kbVal = scopeType === "utility" ? project.utility : project.ahj;
      const kbRow = kbVal
        ? db.get<Row>(`SELECT portal_url FROM permit_utility_knowledge WHERE ${kbField} = ? AND portal_url IS NOT NULL AND portal_url != '' LIMIT 1`, [kbVal])
        : null;
      if (kbRow) {
        kbPortalUrl = s(kbRow.portal_url) || undefined;
      } else {
        // Fall back to applicationDocs profile sourceUrl (built-in AHJ/utility definitions).
        const appProfile = findApplicationProfile(project);
        if (appProfile?.sourceUrl) kbPortalUrl = appProfile.sourceUrl;
      }
    }

    return {
      type,
      label: TRACK_LABELS[type],
      category,
      channel,
      status,
      statusLabel: state.statusLabel || statusLabelFor(status, category),
      nextAction: nextActionFor(status, channel, type),
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
      input.portalName ?? (track ? channelFor(track, project) : ""),
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
