import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { runEmailTracker } from "./repository";
import type { EmailTrackerRunResult } from "../../shared/src/types";

// =============================================================================
// Live Gmail polling.
//
// Fetches recent messages from a work Gmail inbox via the Gmail REST API, writes
// them to a temporary MBOX file, and runs them through the EXISTING email
// tracker/matcher — so all classification and project-matching logic is reused
// unchanged. Read-only (gmail.readonly scope); never sends or modifies mail.
//
// SETUP (one time):
//   1. Create a Google Cloud project, enable the Gmail API.
//   2. Create an OAuth 2.0 Client (type "Web application") with redirect URI
//      <APP_URL>/api/gmail/oauth/callback.
//   3. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in the environment.
//   4. Open /api/gmail/auth-url, authorize, and copy the returned refresh token
//      into GMAIL_REFRESH_TOKEN.
// =============================================================================

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function clientId(): string {
  const v = process.env.GMAIL_CLIENT_ID;
  if (!v) throw new HttpError(400, "GMAIL_CLIENT_ID is not set. Complete the Gmail OAuth setup first.");
  return v;
}

function clientSecret(): string {
  const v = process.env.GMAIL_CLIENT_SECRET;
  if (!v) throw new HttpError(400, "GMAIL_CLIENT_SECRET is not set. Complete the Gmail OAuth setup first.");
  return v;
}

function redirectUri(): string {
  return process.env.GMAIL_REDIRECT_URI || `http://localhost:${process.env.PORT || 4173}/api/gmail/oauth/callback`;
}

export function gmailStatus(): { configured: boolean; authorized: boolean; redirectUri: string } {
  return {
    configured: Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET),
    authorized: Boolean(process.env.GMAIL_REFRESH_TOKEN),
    redirectUri: redirectUri(),
  };
}

// One-time consent URL. access_type=offline + prompt=consent ensures a refresh
// token is returned.
export function buildAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// Exchanges the one-time auth code for tokens. Returns the refresh token to be
// stored in GMAIL_REFRESH_TOKEN.
export async function exchangeCodeForTokens(code: string): Promise<{ refreshToken: string | null; accessToken: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; error_description?: string };
  if (!res.ok) throw new HttpError(502, `Gmail token exchange failed: ${data.error_description || res.status}`);
  return { refreshToken: data.refresh_token ?? null, accessToken: data.access_token ?? "" };
}

async function getAccessToken(): Promise<string> {
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!refreshToken) throw new HttpError(400, "GMAIL_REFRESH_TOKEN is not set. Authorize via /api/gmail/auth-url first.");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new HttpError(502, `Gmail token refresh failed: ${data.error_description || res.status}. The refresh token may be revoked — re-authorize.`);
  }
  return data.access_token;
}

interface GmailListResponse {
  messages?: { id: string }[];
  error?: { message?: string };
}

// Fetches recent messages and writes them to a temp MBOX file. Returns the path
// and the number of messages written. Default query pulls the last 30 days.
export async function fetchGmailToMbox(query = "newer_than:30d", maxResults = 100): Promise<{ filePath: string; count: number }> {
  const token = await getAccessToken();
  const auth = { Authorization: `Bearer ${token}` };

  const listRes = await fetch(`${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`, { headers: auth });
  const list = (await listRes.json().catch(() => ({}))) as GmailListResponse;
  if (!listRes.ok) throw new HttpError(502, `Gmail list failed: ${list.error?.message || listRes.status}`);

  const ids = (list.messages ?? []).map((m) => m.id);
  const mboxPath = path.join(os.tmpdir(), `gmail-${Date.now()}.mbox`);
  const out = fs.createWriteStream(mboxPath, { encoding: "utf8" });
  let count = 0;

  for (const id of ids) {
    const msgRes = await fetch(`${GMAIL_API}/messages/${id}?format=raw`, { headers: auth });
    if (!msgRes.ok) continue;
    const msg = (await msgRes.json().catch(() => ({}))) as { raw?: string };
    if (!msg.raw) continue;
    // Gmail returns the full RFC822 message base64url-encoded.
    const rfc822 = Buffer.from(msg.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    // MBOX separator line + escape any lines that start with "From " in the body.
    out.write(`From gmail@local ${new Date().toUTCString()}\n`);
    out.write(rfc822.replace(/\r\n/g, "\n").replace(/\n(From )/g, "\n>$1"));
    out.write("\n\n");
    count += 1;
  }

  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  return { filePath: mboxPath, count };
}

// Polls Gmail and runs the fetched messages through the existing email tracker.
export async function pollGmail(db: AppDb, query?: string): Promise<EmailTrackerRunResult & { fetched: number }> {
  const { filePath, count } = await fetchGmailToMbox(query);
  try {
    const result = await runEmailTracker(db, { filePath });
    return { ...result, fetched: count };
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}
