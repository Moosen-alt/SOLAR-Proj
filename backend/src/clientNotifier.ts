// ---------------------------------------------------------------------------
// Client notifier — PORTAL UPDATES DELIVERED TO CLIENTS, not just drafted.
//
// Before this module, every approval/correction produced an operator toast and
// a copy/paste draft, but nothing ever reached the client (installer). Now,
// when a monitored permit/NEM status CHANGES to something the client cares
// about (permit issued, ready for issue/fees, NEM approved, correction, ready
// for install handoff), we:
//   1. build a plain-language update email for the submitting client,
//   2. include their tokenized read-only status link (auto-created on first
//      send) so they can self-serve progress checks,
//   3. SEND it over SMTP when configured (SMTP_HOST + SMTP_FROM), and
//   4. ALWAYS record the communication in the CRM (channel "email", with
//      delivery_status/delivery_detail/recipient as COLUMNS — migration v25;
//      it used to be a prefix inside the subject, which made "what did we fail
//      to send?" unqueryable), and
//   5. record the SAME sentences as a client_update note on the project, so the
//      client's portal and their inbox never carry two wordings for one event.
//      The note is written before the send is attempted, deliberately: it must
//      not go dark just because SMTP is unconfigured.
//
// No SMTP configured → the email is still recorded as a DRAFT communication
// (visible in the dashboard to copy/send by hand), so behaviour degrades
// gracefully instead of silently dropping the update.
//
// PII: client-facing content carries the project address + status labels only —
// never account/meter numbers, credentials, or raw scraped portal text.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { addCommunication, undeliveredCommunications } from "./crm";
import { clientUpdateFor, clientUpdateEmailBody, isClientFacingOutcome, recordClientUpdateNote } from "./clientUpdates";
import { addAuditLog } from "./audit";
import { logger } from "./logger";

export function shouldNotifyClient(outcome: string, previousOutcome: string | null | undefined): boolean {
  // Derived from clientUpdates.ts, never a second copy — see CLIENT_FACING_OUTCOMES there.
  if (!isClientFacingOutcome(outcome)) return false;
  // Only on a CHANGE — the monitor re-checks every few days and must not re-send
  // "permit issued" on every poll of an already-issued permit.
  return outcome !== (previousOutcome || "");
}

// Lazily create the project's read-only status-share token (also used by the
// dashboard's "share status link" action). Idempotent.
export function ensureStatusShareToken(db: AppDb, projectId: string): string {
  const row = db.get<{ status_share_token?: string }>("SELECT status_share_token FROM projects WHERE id = ?", [projectId]);
  const existing = row?.status_share_token ? String(row.status_share_token) : "";
  if (existing) return existing;
  const token = crypto.randomBytes(18).toString("base64url");
  db.run("UPDATE projects SET status_share_token = ?, updated_at = ? WHERE id = ?", [token, new Date().toISOString(), projectId]);
  return token;
}

// projectAddress is often already the FULL "street, city, state" string — appending
// city/state again produced "…, Salem, OR, Salem, OR". Append only what's missing.
export function formatProjectAddress(p: { projectAddress?: string; city?: string; state?: string }): string {
  const base = (p.projectAddress || "").trim();
  const parts = [base];
  if (p.city && !base.toLowerCase().includes(p.city.toLowerCase())) parts.push(p.city);
  if (p.state && !new RegExp(`\\b${p.state}\\b`, "i").test(base)) parts.push(p.state);
  return parts.filter(Boolean).join(", ");
}

let warnedLocalhostBase = false;
export function statusShareUrl(token: string): string {
  const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4173}`).replace(/\/+$/, "");
  // A client-facing email carrying a localhost link is dead on arrival — say so
  // once, loudly, instead of letting every notification quietly ship broken links.
  if (!process.env.PUBLIC_BASE_URL && !warnedLocalhostBase) {
    warnedLocalhostBase = true;
    console.warn("[notify] PUBLIC_BASE_URL is not set — client-facing status links will point at localhost and will not work off this machine. Set PUBLIC_BASE_URL in .env.");
  }
  return `${base}/status?token=${encodeURIComponent(token)}`;
}

function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

async function sendEmail(to: string, subject: string, textBody: string): Promise<void> {
  const { default: nodemailer } = await import("nodemailer");
  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
  });
  await transporter.sendMail({ from: process.env.SMTP_FROM, to, subject, text: textBody });
}

/**
 * Re-send one message that never left. Used by scripts/undelivered.ts after SMTP is configured,
 * so a backlog written during an outage is not simply lost.
 *
 * THE RECIPIENT IS RE-RESOLVED, not replayed. Rows backfilled from the old subject-line prefix
 * carry no recipient at all, and an address recorded weeks ago may since have been corrected —
 * this is exactly the window in which somebody fixes the address that caused the failure. The
 * stored one is the fallback, not the source of truth.
 *
 * Never throws: a failure re-stamps the row and is reported, so a bad address in a backlog of
 * twenty cannot stop the other nineteen.
 */
export async function resendCommunication(
  db: AppDb,
  comm: { id: string; projectId: string | null; recipient: string; subject: string; body: string },
): Promise<{ delivered: boolean; to: string; detail: string }> {
  let to = "";
  try {
    const project = comm.projectId
      ? db.get<{ client_id?: string }>("SELECT client_id FROM projects WHERE id = ?", [comm.projectId])
      : null;
    if (project?.client_id) {
      const client = db.get<{ business_email?: string; updates_inbox?: string }>(
        "SELECT business_email, updates_inbox FROM clients WHERE id = ?", [project.client_id],
      );
      to = (client?.updates_inbox || "").trim() || (client?.business_email || "").trim();
    }
  } catch { /* fall through to the stored address */ }
  to = to || comm.recipient.trim();

  if (!to) {
    const detail = "No recipient: the project has no client, or the client has neither an updates inbox nor a business email.";
    db.run("UPDATE communications SET delivery_status = 'failed', delivery_detail = ? WHERE id = ?", [detail, comm.id]);
    return { delivered: false, to: "(none)", detail };
  }
  try {
    await sendEmail(to, comm.subject, comm.body);
    db.run(
      "UPDATE communications SET delivery_status = 'sent', delivery_detail = '', recipient = ? WHERE id = ?",
      [to, comm.id],
    );
    logger.info("notify", `re-sent a stranded client message to ${to} (${comm.subject})`);
    return { delivered: true, to, detail: "" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    db.run(
      "UPDATE communications SET delivery_status = 'failed', delivery_detail = ?, recipient = ? WHERE id = ?",
      [detail, to, comm.id],
    );
    logger.warn("notify", `re-send failed for ${to}: ${detail}`);
    return { delivered: false, to, detail };
  }
}

/** Notify the submitting client of a status change. Never throws — a delivery
 *  problem must never break the monitor tick that detected the change. */
export async function notifyClientOfStatusChange(
  db: AppDb,
  project: ProjectRecord,
  evt: { outcome: string; statusLabel: string; targetType: string; permitNumber?: string; applicationNumber?: string },
): Promise<void> {
  try {
    if (process.env.CLIENT_NOTIFICATIONS === "0" || process.env.CLIENT_NOTIFICATIONS === "false") return;
    if (!project.clientId) return;
    // THE SHARED INBOX IS THE ONE FIELD WHOSE ENTIRE PURPOSE IS THIS MESSAGE.
    //
    // The onboarding guide asks for it as REQUIRED, in these words: "Shared inbox for Keelix
    // updates — where we send confirmations, status updates and corrections. A shared inbox,
    // not one person's." Migration v18 added the column, the intake template collects it and
    // INTAKE_CHECKLIST.md documents it — and this function sent to business_email, so every
    // status update went to the general company address the customer was explicitly told it
    // would not go to. A contract term that the software quietly does not honour.
    //
    // business_email stays as the fallback, because an update reaching the wrong inbox beats
    // an update nobody gets.
    const client = db.get<{ company_name?: string; business_email?: string; updates_inbox?: string }>(
      "SELECT company_name, business_email, updates_inbox FROM clients WHERE id = ?",
      [project.clientId],
    );
    const to = (client?.updates_inbox || "").trim() || (client?.business_email || "").trim();
    if (!to) return;

    const token = ensureStatusShareToken(db, project.id);
    const link = statusShareUrl(token);
    const address = formatProjectAddress(project);

    // ONE VOICE, TWO CHANNELS. These sentences are also what the client's portal shows as a
    // note, rendered from the same object — see clientUpdates.ts. Two copies of client-facing
    // prose drift, and the client then reads one wording in their inbox and a different one on
    // the page, for the same event, on the same day.
    const update = clientUpdateFor(db, project, evt.outcome, {
      targetType: evt.targetType,
      permitNumber: evt.permitNumber,
      applicationNumber: evt.applicationNumber,
    });
    if (!update) return;   // not a client-facing outcome; that gate lives in clientUpdates.ts
    const subject = `${update.subject} — ${address || project.homeownerName || project.id}`;
    const body = clientUpdateEmailBody(update, {
      company: String(client?.company_name || ""),
      address,
      statusLine: evt.statusLabel || evt.outcome,
      link,
    });

    // The same words, on the page. Written BEFORE the send is attempted, deliberately: the
    // portal note must not depend on SMTP being configured, or both channels go dark together
    // — which is exactly what happened to the emails for twelve days.
    try {
      recordClientUpdateNote(db, project.id, update);
    } catch (err) {
      logger.warn("notify", `could not record the client note: ${err instanceof Error ? err.message : String(err)}`);
    }

    // THE TWO WAYS THIS DOES NOT ARRIVE ARE DIFFERENT PROBLEMS, so they are recorded as
    // different statuses. "draft" means we never tried — SMTP_HOST/SMTP_FROM are unset, which is
    // a deployment step nobody has done. "failed" means we tried and the server refused, which
    // is an incident with an error message worth keeping. They used to share one subject-line
    // string, and the deployment step went undone for twelve days behind it.
    let deliveryStatus = "draft";
    let deliveryDetail = "SMTP is not configured (SMTP_HOST / SMTP_FROM are unset), so no send was attempted.";
    if (smtpConfigured()) {
      try {
        await sendEmail(to, subject, body);
        deliveryStatus = "sent";
        deliveryDetail = "";
      } catch (err) {
        deliveryStatus = "failed";
        deliveryDetail = err instanceof Error ? err.message : String(err);
        logger.warn("notify", `client email send failed (${to}): ${deliveryDetail}`);
      }
    }
    const delivered = deliveryStatus === "sent";
    // Always on the record — the project timeline shows what the client was told. The subject is
    // the subject: delivery state is in its own column, so "what did we fail to send?" is a
    // query, and a stranded row still holds exactly what we would send if we re-tried.
    addCommunication(db, {
      projectId: project.id,
      direction: "outbound",
      channel: "email",
      subject,
      body,
      loggedBy: "client-notifier (automated)",
      deliveryStatus,
      deliveryDetail,
      recipient: to,
    });
    addAuditLog(db, project.id, "system", "client-notifier", delivered ? "client.notified" : "client.notification_drafted", {
      outcome: evt.outcome, targetType: evt.targetType, to: to.replace(/(.).+(@.*)/, "$1***$2"),
    });
    if (delivered) {
      logger.info("notify", `sent client update (${evt.outcome}) for project ${project.id}`);
    } else {
      // WARN, WITH THE RUNNING TOTAL. An INFO line saying "drafted" is what this used to be, and
      // it scrolled past three times without anyone reading it. A number that only goes up is
      // harder to ignore than an event that looks the same every time.
      const stranded = undeliveredCommunications(db).length;
      logger.warn("notify", `client update NOT delivered (${deliveryStatus}) for project ${project.id}: ${deliveryDetail} — ${stranded} message(s) now waiting. Run: npx tsx scripts/undelivered.ts`);
    }
  } catch (err) {
    logger.warn("notify", `client notification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
