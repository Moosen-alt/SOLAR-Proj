// ---------------------------------------------------------------------------
// ONE LINK PER COMPANY, LISTING EVERY JOB WE ARE FILING FOR THEM.
//
// The per-project status page (/status?token=) has existed for a while and works, but it mints
// one token per PROJECT. A company with fifteen jobs needs fifteen links, and a new one every
// time we open a job — which is why it was never a tracker, only a notification footer.
//
// This is the same idea keyed on the CLIENT. The token is minted once and NEVER ROTATED, on the
// operator's explicit instruction: the point is a link a company bookmarks and keeps. The cost
// is written down here rather than discovered later — a link forwarded to the wrong person
// cannot be killed, because there is nothing to rotate it to. If that ever matters, the fix is
// to add rotation, and every link already sent dies with it.
//
// WHAT THIS DELIBERATELY DOES NOT CARRY:
//
//   · Correction TEXT. It is raw scraped portal prose or forwarded AHJ email, and carries
//     homeowner names, phone numbers and examiners' direct lines. The client learns a correction
//     landed and that we are on it. The wording stays internal. (required_action is internal for
//     the same reason — it names sheets and people.)
//   · Anything belonging to another client. This is the one real risk of a per-client link: the
//     per-project token leaks one address if it escapes, this one would leak a company's whole
//     book of work. Everything below filters on client_id, and clientPortal.test.ts asserts it.
//   · Internal review state, QC findings, fees, credentials, documents. A tracker answers
//     "where is my permit", not "what does your system think".
//   · ARCHIVED projects. Repeated staging passes at one address are normal internally and read
//     as separate jobs on a tracker — the first live render showed one company fifteen cards
//     for about eight real jobs. See projectArchive.ts; the rows are hidden, never deleted.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import type { AppDb } from "./db";
import type { ProjectStatus } from "../../shared/src/types";
import { formatProjectAddress } from "./clientNotifier";
import { logger } from "./logger";

/**
 * PLAIN ENGLISH FOR EVERY STATUS, not most of them.
 *
 * status.html covers ten of the twenty and renders the rest as an undifferentiated "In
 * progress", which on a tracker reads as "nothing is happening" for states where quite a lot is.
 * This map is exhaustive by construction — ProjectStatus is a closed union, and the Record type
 * below stops compiling if a status is added without a public wording.
 *
 * The wording is for the CLIENT, so it says what it means for them, not what our pipeline is
 * doing. "waiting_on_designer" is their action, and saying so is the difference between a
 * tracker and a progress bar.
 */
export const PUBLIC_STATUS_TEXT: Record<ProjectStatus, string> = {
  intake_uploaded: "Received — plan set being read",
  parsed: "Plan set read — running checks",
  qc_failed: "Checks found a problem — our team is on it",
  qc_passed: "Checks passed — preparing the application",
  ready_to_stage: "Ready to file",
  submit_staging: "Filling out the application",
  awaiting_human_submit: "Prepared — waiting on final submission",
  submitted: "Submitted — awaiting agency review",
  correction_received: "Correction requested — being addressed",
  correction_triaged: "Correction being addressed",
  waiting_on_designer: "Waiting on a revised plan set from your designer",
  ready_to_resubmit: "Revision ready to re-file",
  resubmit_staging: "Re-filing the corrected application",
  awaiting_human_resubmit: "Revision prepared — waiting on final submission",
  ready_for_issue: "Permit ready for issue — fees or pickup may be due",
  issued: "Permit issued",
  approved: "Under review by the jurisdiction",
  nem_approved: "Interconnection approved",
  handoff_ready: "Approved — ready for installation",
  blocked: "Paused — our team is resolving something",
};

export interface ClientPortalTrack {
  type: string;
  label: string;
  statusLabel: string;
  outcome: string;
  lastCheckedAt: string | null;
  applicationNumber: string;
  permitNumber: string;
  /** When the filing ACTUALLY went in — null when it has not. See the query below. */
  submittedAt: string | null;
  /** The jurisdiction's receipt, when it is a different string from the application number. */
  confirmationNumber: string;
}

/**
 * What to call one filing track on a client's page.
 *
 * THE BUG THIS FIXES: every non-NEM track was labelled "Building/electrical permit", so a
 * project with separate structural and electrical permits showed two identical rows and the
 * client had to read the -STR/-ELEC suffix to tell which of their permits had been issued. The
 * discipline was in permit_check_targets.permit_type the whole time.
 *
 * An unknown discipline returns the bare "Permit". Replacing one confident guess with a
 * different confident guess is not a fix — if we do not know whether it is the structural or the
 * electrical permit, the page must not say. The application number is displayed beside it and
 * carries the jurisdiction's own suffix.
 */
export function trackLabel(targetType: string, permitType: string): string {
  if (targetType === "nem" || permitType === "nem") return "Utility interconnection (NEM)";
  switch ((permitType || "").trim().toLowerCase()) {
    case "electrical": return "Electrical permit";
    // The fee layer calls this "structural" and permit_type calls it "building"; they are the
    // same trade. "Building permit" is the phrase a client will recognise.
    case "building":
    case "structural": return "Building permit";
    case "combo": return "Combination building & electrical permit";
    // "permit" is the legacy default the column shipped with — a placeholder, not a discipline.
    default: return "Permit";
  }
}

/**
 * WHO IS WAITING ON WHOM — the one thing a status badge never said.
 *
 * The classifier's labels are written for an operator reading a queue, and two of them invert the
 * meaning when a client reads them cold:
 *
 *   · "In review" does not say WHO is reviewing. A client reads it as "someone is working on it"
 *     and has no idea that the someone is the city and there is nothing to chase.
 *   · "Action needed before review" names an action and not its owner. The commit that added it
 *     (Coos Bay's real "Intake Requirements Needed", which had been classified as "In review"
 *     while the permit sat stalled) fixed the classifier so we stopped telling ourselves the city
 *     was reviewing. On the client page it still read as THEIR action — and it is ours.
 *
 * So every wording here answers the question the label left open, in the string itself, because
 * the badge is one span and there is nowhere else to put it. "In review by the jurisdiction" and
 * "Waiting on us — ..." are the two halves of the contrast, and every other state picks a side.
 *
 * THE OUTCOME IS NOT TOUCHED, only the words. Both public pages colour their badges from the raw
 * outcome (status.html's GOOD/WARN sets, portal.html's cls()), so a `needs_human_review` row stays
 * amber and keeps drawing the eye — which is right, because something is stuck. Changing the
 * outcome to make the wording nicer would also change what the monitor and the handoff gate think
 * happened.
 *
 * UNKNOWN LABELS PASS THROUGH UNCHANGED. Legacy rows hold labels no current classifier emits;
 * inventing a client wording for a string we cannot interpret is how a page states a fact it does
 * not have.
 */
const PUBLIC_CHECK_LABELS = new Map<string, string>([
  // Waiting on THEM.
  ["waiting::in review", "In review by the jurisdiction"],
  ["reviewed_by_ahj::reviewed by ahj", "Reviewed by the jurisdiction"],
  ["ready_for_issue::ready for issue", "Approved — ready for issue"],
  ["ready_for_issue::ready for issue - fee/payment needed", "Approved — fee due before issue"],
  ["issued::permit issued", "Permit issued"],
  ["nem_approved::nem / interconnection approved", "Interconnection approved"],
  // Waiting on US. Never phrased as something the client must do — a correction and an intake
  // shortfall are both our work, and telling a client to act on one is a wrong instruction.
  ["correction_flagged::correction flagged", "Correction requested — we are on it"],
  ["needs_human_review::action needed before review", "Waiting on us — the jurisdiction wants more before review"],
  ["needs_human_review::no status text", "Waiting on us — checking the jurisdiction by hand"],
  ["needs_human_review::needs human review", "Waiting on us — reading the jurisdiction's latest update"],
]);

export function publicCheckLabel(outcome: string, statusLabel: string): string {
  const label = String(statusLabel || "").replace(/\s+/g, " ").trim();
  if (!label) return "";
  const key = `${String(outcome || "").trim()}::${label.toLowerCase()}`;
  return PUBLIC_CHECK_LABELS.get(key) || label;
}

export interface ClientPortalUpdate {
  at: string;
  body: string;
}

/** One line on a client's timeline: a filing, named, and what it moved TO. */
export interface ClientPortalHistoryEntry {
  /** When this state was FIRST seen — the moment it CHANGED, not the last time we looked. */
  at: string;
  /** WHICH filing moved: "Building permit" / "Electrical permit" / "Utility interconnection (NEM)". */
  label: string;
  /** The jurisdiction's own reference for that filing, so two permit rows are never ambiguous. */
  applicationNumber: string;
  /** Client-facing wording — see publicCheckLabel. */
  statusLabel: string;
  /** The raw outcome. For badge STYLING only; the words are in statusLabel. */
  outcome: string;
}

/**
 * How far back to read before collapsing. The rows are one-per-check on every project filed
 * before the write-time transition gate landed, so the newest handful of them can easily all be
 * the same state; reading only twelve would collapse to one line and hide the change that
 * actually happened a month ago.
 */
const HISTORY_SCAN_LIMIT = 200;

/**
 * THE TIMELINE, AS A HISTORY OF CHANGES.
 *
 * The client page reads permit_status_checks, which (until the write-time gate lands in the
 * monitor's persistence path) holds one row per CHECK. On a settled permit that is one row per
 * sweep, and the page showed twelve lines that all said the same thing, in pairs seconds apart —
 * the pairs being one sweep's structural target and then its electrical target.
 *
 * Two things are fixed here and they are separate:
 *
 *   1. CONSECUTIVE IDENTICAL STATES COLLAPSE, per target. Rows from two targets interleave, so
 *      collapsing globally would treat the STR row as "a change" merely because an ELEC row sat
 *      between two identical STR rows. The run's FIRST row survives, because a timeline entry
 *      dated today for a status that has not moved since August is a wrong date, not a fresh
 *      update. A state that returns (A → B → A) is three entries, correctly: it changed back.
 *
 *      This is READ-TIME repair for rows already written. It does not replace the write-time gate
 *      — nothing here can undo the duplicate human_review_items and corrections rows the same
 *      unconditional write produces, and no row is deleted (email_project_matches.status_check_id
 *      is a foreign key into this table).
 *
 *   2. EVERY ENTRY NAMES ITS FILING. The projection used to emit three fields — date, statusLabel,
 *      outcome — so a project with a structural and an electrical permit produced a timeline where
 *      no line said which permit it was about. The discipline was already on the target row and
 *      the join simply never carried it across. Same trackLabel() as the Applications list above,
 *      so a filing cannot be called one thing in one section and another thing in the next.
 *
 * TENANCY: takes a projectId the caller has ALREADY authorized (a share token resolved to exactly
 * one project). It widens nothing and must not grow a "all projects" mode.
 *
 * NEVER SELECTED: raw_status_text and message. They are scraped portal prose and forwarded AHJ
 * email carrying homeowner names and examiners' direct lines — see this file's header.
 */
export function projectStatusHistory(db: AppDb, projectId: string, limit = 12): ClientPortalHistoryEntry[] {
  const clean = String(projectId || "").trim();
  if (!clean) return [];
  // ORDERED BY rowid, NOT id. Collapsing a run needs true INSERT order, and created_at alone does
  // not give it: two checks recorded in the same millisecond tie, and the primary key is a random
  // UUID, so a uuid tiebreak would shuffle them and split a run that never moved. SQLite's rowid
  // is the insertion counter for this table (it has a TEXT primary key, so the implicit rowid is
  // intact). Keep this table ROWID-backed if it is ever redefined.
  const rows = db.query<Record<string, unknown>>(
    `SELECT c.target_id, c.outcome, c.status_label, c.application_number, c.created_at,
            t.target_type, t.permit_type, t.application_number AS target_application_number
       FROM permit_status_checks c
       LEFT JOIN permit_check_targets t ON t.id = c.target_id
      WHERE c.project_id = ?
      ORDER BY c.created_at DESC, c.rowid DESC
      LIMIT ?`,
    [clean, HISTORY_SCAN_LIMIT],
  );

  const entries: ClientPortalHistoryEntry[] = [];
  const lastStateByTarget = new Map<string, string>();
  // Oldest first, so "the first row of a run" is the row that actually recorded the change.
  for (const row of rows.slice().reverse()) {
    const targetKey = String(row.target_id || "");
    const outcome = String(row.outcome || "");
    const rawLabel = String(row.status_label || "");
    const state = `${outcome}::${rawLabel}`;
    if (lastStateByTarget.get(targetKey) === state) continue; // same state, still. Not news.
    lastStateByTarget.set(targetKey, state);
    entries.push({
      at: String(row.created_at || ""),
      label: trackLabel(String(row.target_type || ""), String(row.permit_type || "")),
      applicationNumber: String(row.application_number || row.target_application_number || ""),
      statusLabel: publicCheckLabel(outcome, rawLabel),
      outcome,
    });
  }
  entries.reverse(); // newest first, the way a timeline is read
  return entries.slice(0, Math.max(1, Math.floor(limit || 12)));
}

export interface ClientPortalProject {
  id: string;
  address: string;
  ahj: string;
  utility: string;
  /** The raw status key, for styling. */
  statusKey: string;
  /** The client-facing wording. */
  status: string;
  updatedAt: string;
  tracks: ClientPortalTrack[];
  /** What we have told this client about this job, newest first. */
  updates: ClientPortalUpdate[];
}

export interface ClientPortalPayload {
  company: string;
  projects: ClientPortalProject[];
}

/**
 * The company's stable tracking token. Minted once; every later call returns the same value, so
 * a link already sent keeps working. NOT a rotation point by design — see the header.
 */
export function ensureClientPortalToken(db: AppDb, clientId: string): string {
  const row = db.get<{ portal_share_token?: string }>(
    "SELECT portal_share_token FROM clients WHERE id = ?", [clientId],
  );
  if (!row) throw new Error(`No such client: ${clientId}`);
  const existing = String(row.portal_share_token || "").trim();
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString("base64url");
  db.run("UPDATE clients SET portal_share_token = ? WHERE id = ?", [token, clientId]);
  logger.info("portal", "minted a client tracking link", { clientId });
  return token;
}

export function clientPortalUrl(token: string): string {
  const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4173}`).replace(/\/+$/, "");
  return `${base}/portal?token=${encodeURIComponent(token)}`;
}

/**
 * Resolve a tracking token to everything that company can see. Returns null for an unknown token.
 *
 * THE BLANK TOKEN IS THE DANGEROUS CASE. `portal_share_token` defaults to '' on every client row,
 * so a plain equality match against an empty string would hand the first never-shared client's
 * entire book of work to anyone who hit /portal with no token at all. Guarded here AND in the
 * SQL, because one of the two will eventually be edited by someone who did not read this.
 */
export function clientPortalPayload(db: AppDb, token: string): ClientPortalPayload | null {
  const clean = String(token || "").trim();
  if (!clean) return null;

  const client = db.get<{ id?: string; company_name?: string }>(
    "SELECT id, company_name FROM clients WHERE portal_share_token = ? AND portal_share_token != ''",
    [clean],
  );
  if (!client?.id) return null;
  const clientId = String(client.id);

  const projects = db.query<Record<string, unknown>>(
    `SELECT id, homeowner_name, project_address, city, state, ahj, utility, status, updated_at
       FROM projects WHERE client_id = ? AND archived_at = '' ORDER BY updated_at DESC`,
    [clientId],
  );
  if (!projects.length) return { company: String(client.company_name || ""), projects: [] };

  // One query for every track rather than one per project. Scoped by the project ids we just
  // read, which are already client-filtered — the tenancy guarantee is that filter and nothing
  // downstream is allowed to widen it.
  const ids = projects.map((p) => String(p.id));
  const placeholders = ids.map(() => "?").join(",");
  const targets = db.query<Record<string, unknown>>(
    `SELECT project_id, target_type, permit_type, latest_status_label, latest_outcome, last_checked_at,
            application_number, permit_number
       FROM permit_check_targets WHERE project_id IN (${placeholders})`,
    ids,
  );
  // THE ONE NOTE TYPE. project_notes also holds pm_note, blocker, handoff and system_note —
  // where an operator writes things like "client is chasing, do not mention the re-inspection
  // fee yet". Filtering on client_update is the whole safety property here; selecting the table
  // would publish the lot.
  const notes = db.query<Record<string, unknown>>(
    `SELECT project_id, body, created_at FROM project_notes
      WHERE project_id IN (${placeholders}) AND note_type = 'client_update'
      ORDER BY created_at DESC`,
    ids,
  );
  const updatesByProject = new Map<string, ClientPortalUpdate[]>();
  for (const n of notes) {
    const pid = String(n.project_id);
    const list = updatesByProject.get(pid) || [];
    list.push({ at: String(n.created_at || ""), body: String(n.body || "") });
    updatesByProject.set(pid, list);
  }

  // WHEN EACH TRACK WAS ACTUALLY FILED.
  //
  // `submitted` ONLY. Automation never presses final submit (CLAUDE.md rule 1), so a staged
  // application sits at `awaiting_human_submit` with every field filled and nothing filed. A date
  // on one of those would tell a client the jurisdiction has their permit when we do, and that a
  // review clock is running when it is not. Five live projects are in that state right now.
  //
  // MIN(submitted_at), because one filing is recorded as two or three rows on the live database
  // and taking the latest would walk a client's filing date forward on any re-record.
  //
  // Keyed by (project_id, application_number) — the same scoping as migration v28. Application
  // numbers are unique within a jurisdiction, not globally.
  const filings = db.query<Record<string, unknown>>(
    `SELECT project_id, application_number,
            MIN(submitted_at) AS submitted_at,
            MIN(confirmation_number) AS confirmation_number
       FROM submissions
      WHERE project_id IN (${placeholders})
        AND status = 'submitted' AND submitted_at IS NOT NULL AND submitted_at != ''
        AND application_number != ''
      GROUP BY project_id, application_number`,
    ids,
  );
  const filingKey = (projectId: string, app: string): string => `${projectId}::${app}`;
  const filingByKey = new Map<string, { submittedAt: string; confirmationNumber: string }>();
  for (const f of filings) {
    filingByKey.set(filingKey(String(f.project_id), String(f.application_number)), {
      submittedAt: String(f.submitted_at || ""),
      confirmationNumber: String(f.confirmation_number || ""),
    });
  }

  const byProject = new Map<string, ClientPortalTrack[]>();
  for (const t of targets) {
    const pid = String(t.project_id);
    const type = String(t.target_type || "permit");
    const list = byProject.get(pid) || [];
    const applicationNumber = String(t.application_number || "");
    const filing = filingByKey.get(filingKey(pid, applicationNumber));
    // PowerClerk's confirmation number IS the application number. Printing both would be the same
    // string twice on one line, which reads as a page that does not know what it is showing.
    const confirmation = filing && filing.confirmationNumber !== applicationNumber
      ? filing.confirmationNumber : "";
    list.push({
      type,
      label: trackLabel(type, String(t.permit_type || "")),
      // The badge says who the next move belongs to, not just what the queue is called. An
      // operator-facing "Action needed before review" on a client's page reads as THEIR action
      // when the action is ours — see publicCheckLabel.
      statusLabel: publicCheckLabel(String(t.latest_outcome || ""), String(t.latest_status_label || "")),
      outcome: String(t.latest_outcome || ""),
      lastCheckedAt: t.last_checked_at ? String(t.last_checked_at) : null,
      applicationNumber,
      permitNumber: String(t.permit_number || ""),
      submittedAt: filing?.submittedAt || null,
      confirmationNumber: confirmation,
    });
    byProject.set(pid, list);
  }

  return {
    company: String(client.company_name || ""),
    projects: projects.map((p) => {
      const statusKey = String(p.status || "");
      return {
        id: String(p.id),
        address: formatProjectAddress({
          projectAddress: String(p.project_address || ""),
          city: String(p.city || ""),
          state: String(p.state || ""),
        } as never) || String(p.homeowner_name || "Solar project"),
        ahj: String(p.ahj || ""),
        utility: String(p.utility || ""),
        statusKey,
        // The MAP is exhaustive and the compiler enforces that; the LOOKUP still tolerates a
        // value the database holds that the union does not, which is a different risk and is
        // what the fallback is for.
        status: PUBLIC_STATUS_TEXT[statusKey as ProjectStatus] || "In progress",
        updatedAt: String(p.updated_at || ""),
        tracks: byProject.get(String(p.id)) || [],
        updates: updatesByProject.get(String(p.id)) || [],
      };
    }),
  };
}
