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
import { addCommunication } from "./crm";
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
    const client = db.get<{ company_name?: string; business_email?: string }>(
      "SELECT company_name, business_email FROM clients WHERE id = ?",
      [project.clientId],
    );
    const to = (client?.business_email || "").trim();
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

    let delivered = false;
    if (smtpConfigured()) {
      try {
        await sendEmail(to, subject, body);
        delivered = true;
      } catch (err) {
        logger.warn("notify", `client email send failed (${to}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Always on the record — the project timeline shows what the client was told.
    addCommunication(db, {
      projectId: project.id,
      direction: "outbound",
      channel: "email",
      subject: `${delivered ? "[sent]" : "[draft — SMTP not configured or send failed]"} ${subject}`,
      body,
      loggedBy: "client-notifier (automated)",
    });
    addAuditLog(db, project.id, "system", "client-notifier", delivered ? "client.notified" : "client.notification_drafted", {
      outcome: evt.outcome, targetType: evt.targetType, to: to.replace(/(.).+(@.*)/, "$1***$2"),
    });
    logger.info("notify", `${delivered ? "sent" : "drafted"} client update (${evt.outcome}) for project ${project.id}`);
  } catch (err) {
    logger.warn("notify", `client notification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
