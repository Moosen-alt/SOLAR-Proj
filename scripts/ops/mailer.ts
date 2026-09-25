// OPS ALERT DELIVERY — email through the product's OWN SMTP settings, plus an optional webhook.
//
// Email uses exactly the six variables backend/src/clientNotifier.ts reads (SMTP_HOST, SMTP_PORT,
// SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE) with the same defaults, so configuring client email
// configures alerts too and there is one set of credentials to rotate. It is re-implemented here
// rather than imported because clientNotifier pulls in the database layer, and a watchdog must
// keep working when the database is exactly what broke. backend/test/opsWatchdog.test.ts pins the
// variable names against clientNotifier.ts so the two cannot drift apart.
//
// The webhook is for phone push / SMS bridges: WATCHDOG_WEBHOOK_URL receives a POST per alert
// batch. WATCHDOG_WEBHOOK_FORMAT=json (default) sends {subject, text}; =text sends the plain text
// with the subject as a "Title" header, which is what ntfy.sh expects (free phone push:
// https://ntfy.sh/<your-private-topic>).

export const SMTP_ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_SECURE"] as const;

export interface Delivery {
  channel: "email" | "webhook";
  ok: boolean;
  /** Error CODE or HTTP status only — never a server's free text. */
  detail: string;
}

export function smtpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM);
}

export function alertRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.WATCHDOG_ALERT_TO || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

/** Channels that are configured enough to try. */
export function configuredChannels(env: NodeJS.ProcessEnv = process.env): ("email" | "webhook")[] {
  const out: ("email" | "webhook")[] = [];
  if (smtpConfigured(env) && alertRecipients(env).length) out.push("email");
  if (env.WATCHDOG_WEBHOOK_URL) out.push("webhook");
  return out;
}

export async function sendAlertEmail(subject: string, text: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Same transport construction as clientNotifier.ts sendEmail().
  const { default: nodemailer } = await import("nodemailer");
  const port = Number(env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE === "true" || port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || "" } : undefined,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
  await transporter.sendMail({ from: env.SMTP_FROM, to: alertRecipients(env).join(", "), subject, text });
}

export async function postWebhook(subject: string, text: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const asText = String(env.WATCHDOG_WEBHOOK_FORMAT || "json").toLowerCase() === "text";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(String(env.WATCHDOG_WEBHOOK_URL), {
      method: "POST",
      headers: asText ? { "Content-Type": "text/plain; charset=utf-8", Title: subject.replace(/[^\x20-\x7e]/g, "") } : { "Content-Type": "application/json" },
      body: asText ? text : JSON.stringify({ subject, text }),
      signal: ctrl.signal,
    });
    if (res.status >= 300) throw Object.assign(new Error(`HTTP ${res.status}`), { code: `HTTP_${res.status}` });
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

/** Try every configured channel. The batch counts as delivered if ANY channel accepted it. */
export async function deliver(subject: string, text: string, env: NodeJS.ProcessEnv = process.env): Promise<Delivery[]> {
  const results: Delivery[] = [];
  const code = (err: unknown): string => {
    const e = err as { code?: string; responseCode?: number };
    return String(e?.code || (e?.responseCode ? `SMTP_${e.responseCode}` : "ERROR"));
  };
  for (const channel of configuredChannels(env)) {
    try {
      if (channel === "email") await sendAlertEmail(subject, text, env);
      else await postWebhook(subject, text, env);
      results.push({ channel, ok: true, detail: "sent" });
    } catch (err) {
      results.push({ channel, ok: false, detail: code(err) });
    }
  }
  return results;
}
