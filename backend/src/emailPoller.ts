import { createWriteStream } from "node:fs";
import { unlink, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppDb } from "./db";
import { logger } from "./logger";
import { runEmailTracker } from "./repository";
import { encryptStorageState, decryptStorageState } from "../../portal-bot/src/cryptoStorage";

// IMAP email polling — supports two source modes:
//
//   1. Global env-var source (EMAIL_IMAP_HOST/USER/PASS) — the central TML inbox.
//      Scanned on every poll tick; no DB row required.
//
//   2. DB-driven sources (email_tracking_sources rows with source_type='imap') —
//      per-client or additional inboxes, each with independently encrypted credentials.
//      A non-empty recipient_tag filters to emails whose To:/CC: contain the tag,
//      letting one shared inbox serve many clients (permits+acme@tml.com → acme).
//
// The forwarding pattern (clients set a 2-min Outlook/Gmail rule → central TML inbox)
// means most setups need only the global env source. Per-client DB rows are for
// clients whose AHJ emails go to a dedicated address we poll directly.
//
// SECURITY:
//   - Global credentials from env only; per-source credentials stored only as
//     AES-256-GCM encrypted blobs (keyed by SESSION_ENCRYPTION_KEY). Never plaintext.
//   - Raw email bodies are never stored or logged — only parsed/classified output.
//   - The MBOX temp file is deleted immediately after the tracker run.

interface ImapSourceConfig {
  sourceId?: string; // DB row id; undefined for the env-based source
  label: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
  maxMessages: number;
  recipientTag: string; // empty = accept all; non-empty = filter To:/CC: lines
}

// ---------------------------------------------------------------------------
// Env-based global IMAP config (central TML inbox)
// ---------------------------------------------------------------------------

function envImapConfig(): ImapSourceConfig | null {
  const host = process.env.EMAIL_IMAP_HOST;
  const user = process.env.EMAIL_IMAP_USER;
  const pass = process.env.EMAIL_IMAP_PASS;
  if (!host || !user || !pass) return null;
  return {
    label: "central (env)",
    host,
    port: Number(process.env.EMAIL_IMAP_PORT ?? 993),
    secure: process.env.EMAIL_IMAP_TLS !== "false",
    user,
    pass,
    mailbox: process.env.EMAIL_IMAP_MAILBOX || "INBOX",
    maxMessages: Number(process.env.EMAIL_IMAP_MAX_MESSAGES ?? 100),
    recipientTag: "",
  };
}

export function imapStatus(): { configured: boolean; host: string | null; mailbox: string } {
  const cfg = envImapConfig();
  return { configured: cfg !== null, host: cfg?.host ?? null, mailbox: cfg?.mailbox ?? "INBOX" };
}

// ---------------------------------------------------------------------------
// DB-driven IMAP sources
// ---------------------------------------------------------------------------

interface ImapSourceRow {
  id: string;
  label: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  imap_user: string;
  imap_pass_encrypted: string;
  imap_mailbox: string;
  imap_max_messages: number;
  recipient_tag: string;
}

function dbImapSources(db: AppDb): ImapSourceConfig[] {
  const rows = db.query<ImapSourceRow>(
    `SELECT id, label, imap_host, imap_port, imap_secure, imap_user,
            imap_pass_encrypted, imap_mailbox, imap_max_messages, recipient_tag
     FROM email_tracking_sources
     WHERE source_type = 'imap' AND active = 1 AND imap_host != ''
     ORDER BY created_at`,
  );

  return rows.flatMap((row) => {
    if (!row.imap_pass_encrypted) return [];
    let pass: string;
    try {
      const dec = decryptStorageState(row.imap_pass_encrypted) as { password?: string };
      pass = dec.password ?? "";
    } catch {
      logger.warn("imap", `Failed to decrypt credentials for source ${row.id} (${row.label}) — skipping`);
      return [];
    }
    if (!pass) return [];
    return [
      {
        sourceId: row.id,
        label: row.label || row.id,
        host: row.imap_host,
        port: row.imap_port || 993,
        secure: row.imap_secure !== 0,
        user: row.imap_user,
        pass,
        mailbox: row.imap_mailbox || "INBOX",
        maxMessages: row.imap_max_messages || 100,
        recipientTag: row.recipient_tag || "",
      } satisfies ImapSourceConfig,
    ];
  });
}

// ---------------------------------------------------------------------------
// Credential management for DB sources
// ---------------------------------------------------------------------------

export function encryptImapPassword(password: string): string {
  return encryptStorageState({ password });
}

/** Upsert an IMAP source row. Pass password only when setting or rotating credentials. */
export function upsertImapSource(
  db: AppDb,
  opts: {
    id?: string;
    label: string;
    host: string;
    port?: number;
    secure?: boolean;
    user: string;
    password?: string;
    mailbox?: string;
    maxMessages?: number;
    recipientTag?: string;
    clientId?: string;
    active?: boolean;
  },
): string {
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
  const now = new Date().toISOString();
  const id = opts.id ?? randomUUID();
  const existing = db.get<{ imap_pass_encrypted?: string }>(
    "SELECT imap_pass_encrypted FROM email_tracking_sources WHERE id = ?",
    [id],
  );

  const encPass = opts.password
    ? encryptStorageState({ password: opts.password })
    : existing?.imap_pass_encrypted ?? "";

  if (existing) {
    db.run(
      `UPDATE email_tracking_sources SET
         label = ?, imap_host = ?, imap_port = ?, imap_secure = ?, imap_user = ?,
         imap_pass_encrypted = ?, imap_mailbox = ?, imap_max_messages = ?,
         recipient_tag = ?, client_id = ?, active = ?, updated_at = ?
       WHERE id = ?`,
      [
        opts.label,
        opts.host,
        opts.port ?? 993,
        opts.secure !== false ? 1 : 0,
        opts.user,
        encPass,
        opts.mailbox ?? "INBOX",
        opts.maxMessages ?? 100,
        opts.recipientTag ?? "",
        opts.clientId ?? null,
        opts.active !== false ? 1 : 0,
        now,
        id,
      ],
    );
  } else {
    db.run(
      `INSERT INTO email_tracking_sources
         (id, source_type, label, file_path, imap_host, imap_port, imap_secure, imap_user,
          imap_pass_encrypted, imap_mailbox, imap_max_messages, recipient_tag, client_id,
          active, created_at, updated_at)
       VALUES (?, 'imap', ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        opts.label,
        opts.host,
        opts.port ?? 993,
        opts.secure !== false ? 1 : 0,
        opts.user,
        encPass,
        opts.mailbox ?? "INBOX",
        opts.maxMessages ?? 100,
        opts.recipientTag ?? "",
        opts.clientId ?? null,
        opts.active !== false ? 1 : 0,
        now,
        now,
      ],
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Core fetch → MBOX → tracker pipeline
// ---------------------------------------------------------------------------

async function fetchImapToMbox(
  cfg: ImapSourceConfig,
): Promise<{ filePath: string; count: number }> {
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
      const mailbox = client.mailbox;
      const total =
        mailbox && typeof mailbox === "object" && "exists" in mailbox
          ? (mailbox.exists as number)
          : 0;
      if (total === 0) return { filePath: mboxPath, count: 0 };
      const startSeq = Math.max(1, total - cfg.maxMessages + 1);

      for await (const msg of client.fetch(`${startSeq}:*`, { source: true, envelope: true })) {
        if (!msg.source) continue;
        const raw = msg.source.toString("utf8");

        // Recipient tag filtering — if configured, skip emails whose To:/CC: headers
        // don't include the tag. Checked on the raw RFC 5322 source so no full parse needed.
        if (cfg.recipientTag) {
          const headerEnd = raw.indexOf("\r\n\r\n");
          const headers = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw.slice(0, 4096);
          const toLines = headers
            .split("\r\n")
            .filter((l) => /^(To|CC|Delivered-To|X-Original-To):/i.test(l));
          const toBlock = toLines.join(" ").toLowerCase();
          if (!toBlock.includes(cfg.recipientTag.toLowerCase())) continue;
        }

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
    await new Promise<void>((resolve, reject) =>
      out.end((err?: Error | null) => (err ? reject(err) : resolve())),
    );
  }

  return { filePath: mboxPath, count };
}

async function runSourcePoll(
  db: AppDb,
  cfg: ImapSourceConfig,
): Promise<{ fetched: number; matches: number; errors: string[] }> {
  const errors: string[] = [];
  let matches = 0;
  let count = 0;
  let filePath: string | null = null;

  try {
    const result = await fetchImapToMbox(cfg);
    filePath = result.filePath;
    count = result.count;

    if (count > 0) {
      const tracked = await runEmailTracker(db, { filePath });
      matches = tracked.matches?.length ?? 0;
    }

    if (cfg.sourceId) {
      const now = new Date().toISOString();
      db.run(
        `UPDATE email_tracking_sources
         SET last_checked_at = ?, last_message_count = ?, last_matched_count = ?,
             last_error = '', updated_at = ?
         WHERE id = ?`,
        [now, count, matches, now, cfg.sourceId],
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    logger.warn("imap", `Poll failed for source "${cfg.label}": ${msg}`);
    if (cfg.sourceId) {
      const now = new Date().toISOString();
      db.run(
        `UPDATE email_tracking_sources SET last_error = ?, updated_at = ? WHERE id = ?`,
        [msg, now, cfg.sourceId],
      );
    }
  } finally {
    if (filePath) {
      await unlink(filePath).catch(() => null);
      const dir = path.dirname(filePath);
      await import("node:fs/promises")
        .then(({ rm }) => rm(dir, { recursive: true, force: true }))
        .catch(() => null);
    }
  }

  return { fetched: count, matches, errors };
}

// ---------------------------------------------------------------------------
// Public API — called by scheduler and server endpoints
// ---------------------------------------------------------------------------

/** Poll all configured IMAP sources (env + active DB rows) in sequence. */
export async function pollImap(
  db: AppDb,
): Promise<{ fetched: number; matches: number; errors: string[]; sources: number }> {
  const sources: ImapSourceConfig[] = [];

  const envCfg = envImapConfig();
  if (envCfg) sources.push(envCfg);

  sources.push(...dbImapSources(db));

  if (sources.length === 0) {
    throw new Error("No IMAP sources configured (set EMAIL_IMAP_HOST/USER/PASS or add a DB source).");
  }

  let totalFetched = 0;
  let totalMatches = 0;
  const allErrors: string[] = [];

  for (const src of sources) {
    const r = await runSourcePoll(db, src);
    totalFetched += r.fetched;
    totalMatches += r.matches;
    allErrors.push(...r.errors);
  }

  return { fetched: totalFetched, matches: totalMatches, errors: allErrors, sources: sources.length };
}
