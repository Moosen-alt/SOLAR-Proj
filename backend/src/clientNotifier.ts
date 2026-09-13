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
//   4. ALWAYS record the communication in the CRM (channel "email", status in
//      the body header: sent vs drafted) so the project timeline shows exactly
//      what the client was told and when.
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
import { addAuditLog } from "./audit";
import { logger } from "./logger";

// Outcomes worth telling a client about, with plain-language templates.
const CLIENT_NOTIFY_OUTCOMES: Record<string, { subject: string; line: string }> = {
  issued: {
    subject: "Permit issued",
    line: "The building/electrical permit has been ISSUED. Installation can be scheduled.",
  },
  ready_for_issue: {
    subject: "Permit ready for issue",
    line: "The permit is READY FOR ISSUE — the jurisdiction may require fee payment or pickup before it is released.",
  },
  nem_approved: {
    subject: "Interconnection (NEM) approved",
    line: "The utility interconnection / NEM application has been APPROVED. The permission-to-operate path is open.",
  },
  correction_flagged: {
    subject: "Correction requested",
    line: "The reviewing agency requested a CORRECTION on this application. Our team is triaging it and will follow up with the fix.",
  },
};

export function shouldNotifyClient(outcome: string, previousOutcome: string | null | undefined): boolean {
  if (!(outcome in CLIENT_NOTIFY_OUTCOMES)) return false;
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
  evt: { outcome: string; statusLabel: string; targetType: string },
): Promise<void> {
  try {
    if (process.env.CLIENT_NOTIFICATIONS === "0" || process.env.CLIENT_NOTIFICATIONS === "false") return;
    const template = CLIENT_NOTIFY_OUTCOMES[evt.outcome];
    if (!template || !project.clientId) return;
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
    const track = evt.targetType === "nem" ? "Interconnection (NEM)" : "Permit";
    const address = formatProjectAddress(project);
    const subject = `${template.subject} — ${address || project.homeownerName || project.id}`;
    const body = [
      `Hi ${client?.company_name || "there"},`,
      ``,
      `Update on your solar project at ${address || "the project site"}:`,
      ``,
      `${track} status: ${evt.statusLabel || evt.outcome}`,
      template.line,
      ``,
      `Live status page (no login needed): ${link}`,
      ``,
      `— Solar Submission Autopilot (automated update; reply to reach the team)`,
    ].join("\n");

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
