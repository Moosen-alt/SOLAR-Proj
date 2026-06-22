import { createWriteStream } from "node:fs";
import { unlink, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppDb } from "./db";
import { logger } from "./logger";
import { runEmailTracker } from "./repository";

// IMAP polling — generic IMAP/IMAPS inbox polling for corporate email accounts
// (Outlook/Exchange/self-hosted), complementing the Gmail OAuth path in gmail.ts.
//
// Enabled when EMAIL_IMAP_HOST is set in environment. Reuses the existing email
// tracker / correction-bucket pipeline unchanged — this is just a fetch adapter.
//
// SECURITY:
//   - Credentials come from env only (EMAIL_IMAP_HOST/USER/PASS); never source code.
//   - Raw email bodies are never stored or logged — only the parsed/classified output.
//   - The MBOX temp file is deleted immediately after the tracker run.

function imapConfig() {
  const host = process.env.EMAIL_IMAP_HOST;
  const user = process.env.EMAIL_IMAP_USER;
  const pass = process.env.EMAIL_IMAP_PASS;
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(process.env.EMAIL_IMAP_PORT ?? 993),
    secure: process.env.EMAIL_IMAP_TLS !== "false",
    user,
    pass,
    mailbox: process.env.EMAIL_IMAP_MAILBOX || "INBOX",
    maxMessages: Number(process.env.EMAIL_IMAP_MAX_MESSAGES ?? 100),
  };
}

export function imapStatus(): { configured: boolean; host: string | null; mailbox: string } {
  const cfg = imapConfig();
  return { configured: cfg !== null, host: cfg?.host ?? null, mailbox: cfg?.mailbox ?? "INBOX" };
}

// Fetch recent messages from the IMAP inbox and write them as an MBOX file.
// Returns the path and message count. The caller is responsible for deleting the file.
async function fetchImapToMbox(cfg: NonNullable<ReturnType<typeof imapConfig>>): Promise<{ filePath: string; count: number }> {
  // Dynamic import to keep startup fast when IMAP is unconfigured.
  const { ImapFlow } = await import("imapflow");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "solar-imap-"));
  const mboxPath = path.join(tmpDir, "inbox.mbox");
  const out = createWriteStream(mboxPath, { encoding: "utf8" });
  let count = 0;

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    disableAutoIdle: true,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      // Fetch the newest N messages by sequence (descending). ENVELOPE is cheapest;
      // we need the full RFC822 body for MBOX, so SOURCE is required.
      const mailbox = client.mailbox;
      const total = mailbox && typeof mailbox === "object" && "exists" in mailbox ? (mailbox.exists as number) : 0;
      if (total === 0) return { filePath: mboxPath, count: 0 };
      const startSeq = Math.max(1, total - cfg.maxMessages + 1);

      for await (const msg of client.fetch(`${startSeq}:*`, { source: true })) {
        if (!msg.source) continue;
        const raw = msg.source.toString("utf8");
        out.write(`From imap@local ${new Date().toUTCString()}\n`);
        out.write(raw.replace(/\r\n/g, "\n").replace(/\n(From )/g, "\n>$1"));
        out.write("\n\n");
        count++;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => null);
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }

  return { filePath: mboxPath, count };
}

export async function pollImap(db: AppDb): Promise<{ fetched: number; matches: number; errors: string[] }> {
  const cfg = imapConfig();
  if (!cfg) throw new Error("IMAP not configured (EMAIL_IMAP_HOST/USER/PASS not set).");

  const { filePath, count } = await fetchImapToMbox(cfg);
  const errors: string[] = [];
  let matches = 0;
  try {
    if (count > 0) {
      const result = await runEmailTracker(db, { filePath });
      matches = result.matches?.length ?? 0;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    logger.warn("imap", `Tracker run failed: ${msg}`);
  } finally {
    await unlink(filePath).catch(() => null);
    // Clean up the temp dir too.
    const dir = path.dirname(filePath);
    await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true })).catch(() => null);
  }

  return { fetched: count, matches, errors };
}
