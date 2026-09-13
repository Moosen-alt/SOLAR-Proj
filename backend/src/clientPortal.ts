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
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import type { AppDb } from "./db";
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
export const PUBLIC_STATUS_TEXT: Record<string, string> = {
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
       FROM projects WHERE client_id = ? ORDER BY updated_at DESC`,
    [clientId],
  );
  if (!projects.length) return { company: String(client.company_name || ""), projects: [] };

  // One query for every track rather than one per project. Scoped by the project ids we just
  // read, which are already client-filtered — the tenancy guarantee is that filter and nothing
  // downstream is allowed to widen it.
  const ids = projects.map((p) => String(p.id));
  const placeholders = ids.map(() => "?").join(",");
  const targets = db.query<Record<string, unknown>>(
    `SELECT project_id, target_type, latest_status_label, latest_outcome, last_checked_at,
            application_number, permit_number
       FROM permit_check_targets WHERE project_id IN (${placeholders})`,
    ids,
  );
  const byProject = new Map<string, ClientPortalTrack[]>();
  for (const t of targets) {
    const pid = String(t.project_id);
    const type = String(t.target_type || "permit");
    const list = byProject.get(pid) || [];
    list.push({
      type,
      label: type === "nem" ? "Utility interconnection (NEM)" : "Building/electrical permit",
      statusLabel: String(t.latest_status_label || ""),
      outcome: String(t.latest_outcome || ""),
      lastCheckedAt: t.last_checked_at ? String(t.last_checked_at) : null,
      applicationNumber: String(t.application_number || ""),
      permitNumber: String(t.permit_number || ""),
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
        status: PUBLIC_STATUS_TEXT[statusKey] || "In progress",
        updatedAt: String(p.updated_at || ""),
        tracks: byProject.get(String(p.id)) || [],
      };
    }),
  };
}
