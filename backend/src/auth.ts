import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AppDb, SqlParam } from "./db";

type Row = Record<string, SqlParam>;

// Auth is opt-in so existing local use is never broken. Turn it on by setting
// AUTH_ENABLED=true (plus ADMIN_EMAIL / ADMIN_PASSWORD for the first login).
export const AUTH_ENABLED = String(process.env.AUTH_ENABLED || "").toLowerCase() === "true";

const COOKIE = "sa_session";
const SESSION_HOURS = Number(process.env.AUTH_SESSION_HOURS || 12);

// Signing secret for the session cookie. Never logged.
function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.SESSION_ENCRYPTION_KEY;
  if (s) return s;
  if (!warned) {
    console.warn("[auth] No AUTH_SECRET/SESSION_ENCRYPTION_KEY set — using an ephemeral key. Sessions reset on restart.");
    warned = true;
  }
  return ephemeral;
}
let warned = false;
const ephemeral = crypto.randomBytes(32).toString("hex");

// ---------------------------------------------------------------------------
// Password hashing (scrypt, per-user salt). Stored as "salt:hash" hex.
// ---------------------------------------------------------------------------

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

export function setUserPassword(db: AppDb, userId: string, password: string): void {
  db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(password), userId]);
}

// Create the first admin from env if no user has a password yet.
export function seedAdminUser(db: AppDb): void {
  if (!AUTH_ENABLED) return;
  const withPw = db.get<Row>("SELECT COUNT(*) AS cnt FROM users WHERE password_hash <> ''");
  if (Number(withPw?.cnt ?? 0) > 0) return;
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (!email || !password) {
    console.warn("[auth] AUTH_ENABLED but no admin has a password. Set ADMIN_EMAIL and ADMIN_PASSWORD to seed the first login.");
    return;
  }
  const existing = db.get<Row>("SELECT id FROM users WHERE email = ?", [email]);
  if (existing) {
    setUserPassword(db, String(existing.id), password);
    console.log(`[auth] Set password for existing user ${email}.`);
  } else {
    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO users (id, name, email, role, color, active, created_at, password_hash) VALUES (?, ?, ?, 'admin', '#6366f1', 1, ?, ?)",
      [id, "Admin", email, new Date().toISOString(), hashPassword(password)],
    );
    console.log(`[auth] Seeded admin user ${email}.`);
  }
}

// ---------------------------------------------------------------------------
// Stateless signed session cookie: base64url(userId|expiryMs).hmac
// ---------------------------------------------------------------------------

function sign(value: string): string {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

function makeToken(userId: string): string {
  const payload = Buffer.from(`${userId}|${Date.now() + SESSION_HOURS * 3600_000}`).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readToken(token: string): { userId: string } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (sign(payload) !== sig) return null;
  const [userId, expiry] = Buffer.from(payload, "base64url").toString().split("|");
  if (!userId || !expiry || Date.now() > Number(expiry)) return null;
  return { userId };
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

function currentUser(db: AppDb, req: Request): SessionUser | null {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const parsed = readToken(token);
  if (!parsed) return null;
  const row = db.get<Row>("SELECT id, name, email, role FROM users WHERE id = ? AND active = 1", [parsed.userId]);
  return row ? { id: String(row.id), name: String(row.name), email: String(row.email), role: String(row.role) } : null;
}

// Simple in-memory per-IP login throttle to blunt brute force on the internet-facing
// login. Locks an IP for LOGIN_LOCK_MS after LOGIN_MAX_FAILS consecutive failures;
// resets on success. (For multi-instance later, move this to a shared store.)
const loginAttempts = new Map<string, { fails: number; lockedUntil: number }>();
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS = 15 * 60_000;

// POST /api/auth/login  { email, password }
export function login(db: AppDb, req: Request, res: Response): void {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.lockedUntil > now) {
    res.status(429).json({ error: "Too many failed login attempts. Try again in a few minutes." });
    return;
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const row = db.get<Row>("SELECT id, name, email, role, password_hash FROM users WHERE email = ? AND active = 1", [email]);
  if (!row || !row.password_hash || !verifyPassword(password, String(row.password_hash))) {
    const rec = loginAttempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= LOGIN_MAX_FAILS) { rec.lockedUntil = now + LOGIN_LOCK_MS; rec.fails = 0; }
    loginAttempts.set(ip, rec);
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }
  loginAttempts.delete(ip);
  const token = makeToken(String(row.id));
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: String(process.env.AUTH_COOKIE_SECURE || "").toLowerCase() === "true",
    maxAge: SESSION_HOURS * 3600_000,
  });
  res.json({ user: { id: String(row.id), name: String(row.name), email: String(row.email), role: String(row.role) } });
}

export function logout(_req: Request, res: Response): void {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}

export function me(db: AppDb, req: Request, res: Response): void {
  res.json({ enabled: AUTH_ENABLED, user: AUTH_ENABLED ? currentUser(db, req) : null });
}

// Gate everything except the login page, auth endpoints, health, and static
// assets needed to render the login screen. HTML → redirect; API → 401.
export function requireAuth(db: AppDb) {
  const openPaths = new Set(["/login", "/login.html", "/health", "/api/auth/login", "/styles.css"]);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!AUTH_ENABLED) return next();
    if (openPaths.has(req.path) || req.path.startsWith("/api/auth/")) return next();
    // Public client intake link (tokenized, no login) — the page and its API.
    if (req.path === "/intake" || req.path.startsWith("/api/intake/")) return next();
    if (currentUser(db, req)) return next();
    if (req.path.startsWith("/api/")) {
      res.status(401).json({ error: "Not authenticated." });
      return;
    }
    res.redirect("/login");
  };
}
