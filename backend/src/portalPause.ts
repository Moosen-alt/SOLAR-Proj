// Per-portal legal kill-switch.
//
// When a utility or AHJ sends a cease-and-desist, blocks our IP, or starts bot-blocking,
// the lawful response is to STOP driving automation against that portal immediately —
// not to keep retrying. An operator pauses the portal here; every subsequent staging run
// for that portal resolves to a manual handoff (see resolvePortalChannel's `portalPaused`
// tier) instead of opening a browser. Resuming is an equally deliberate operator action.
//
// A pause is keyed one of two ways:
//   - "profile": a specific jurisdiction, keyed by the same recipeProfileKey the router
//                uses (state|ahj|utility), so the pause lines up exactly with routing.
//   - "platform": an entire platform token (e.g. "powerclerk", "accela"), to halt every
//                jurisdiction on that platform at once after a platform-wide notice.
import type { AppDb } from "./db";
import { id } from "./ids";
import { text as s } from "./json";
import { recipeProfileKey } from "./portalRecipes";
import { nowIso } from "./time";

export type PortalPauseKind = "profile" | "platform";

export interface PortalPause {
  id: string;
  kind: PortalPauseKind;
  pauseKey: string;
  reason: string;
  pausedBy: string;
  createdAt: string;
}

type Row = Record<string, unknown>;

function mapPause(row: Row): PortalPause {
  return {
    id: s(row.id),
    kind: s(row.kind) === "platform" ? "platform" : "profile",
    pauseKey: s(row.pause_key),
    reason: s(row.reason),
    pausedBy: s(row.paused_by),
    createdAt: s(row.created_at),
  };
}

export interface PortalIdentity {
  scopeType: "ahj" | "utility";
  state?: string;
  ahj?: string;
  utility?: string;
  platform?: string;
}

// The active pause covering this portal identity, if any. Matches a profile-level pause
// on the exact routing key, OR a platform-level pause on the portal's platform token.
export function findActivePortalPause(db: AppDb, identity: PortalIdentity): PortalPause | null {
  const profileKey = recipeProfileKey(identity);
  const platform = (identity.platform || "").toLowerCase().trim();
  const row = db.get<Row>(
    `SELECT * FROM portal_pauses
       WHERE (kind = 'profile' AND pause_key = ?)
          OR (kind = 'platform' AND ? != '' AND pause_key = ?)
       ORDER BY created_at DESC LIMIT 1`,
    [profileKey, platform, platform],
  );
  return row ? mapPause(row) : null;
}

export function isPortalPaused(db: AppDb, identity: PortalIdentity): boolean {
  return findActivePortalPause(db, identity) !== null;
}

export function listPortalPauses(db: AppDb): PortalPause[] {
  return db.query<Row>("SELECT * FROM portal_pauses ORDER BY created_at DESC").map(mapPause);
}

// Pause a portal. For kind="profile" supply the jurisdiction (scopeType + state/ahj/utility);
// for kind="platform" supply `platform`. Idempotent on the resolved pause key.
export function pausePortal(
  db: AppDb,
  input: { kind: PortalPauseKind; identity?: PortalIdentity; platform?: string; reason?: string; pausedBy?: string },
): PortalPause {
  const pauseKey =
    input.kind === "platform"
      ? (input.platform || "").toLowerCase().trim()
      : recipeProfileKey(input.identity ?? { scopeType: "ahj" });
  if (!pauseKey) {
    throw new Error("portal pause requires a platform token (platform kind) or a jurisdiction identity (profile kind).");
  }
  const existing = db.get<Row>("SELECT * FROM portal_pauses WHERE kind = ? AND pause_key = ?", [input.kind, pauseKey]);
  const now = nowIso();
  if (existing) {
    db.run("UPDATE portal_pauses SET reason = ?, paused_by = ?, created_at = ? WHERE id = ?", [
      s(input.reason),
      s(input.pausedBy),
      now,
      s(existing.id),
    ]);
    return mapPause(db.get<Row>("SELECT * FROM portal_pauses WHERE id = ?", [s(existing.id)])!);
  }
  const pauseId = id();
  db.run(
    "INSERT INTO portal_pauses (id, kind, pause_key, reason, paused_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [pauseId, input.kind, pauseKey, s(input.reason), s(input.pausedBy), now],
  );
  return mapPause(db.get<Row>("SELECT * FROM portal_pauses WHERE id = ?", [pauseId])!);
}

export function resumePortal(db: AppDb, pauseId: string): { resumed: boolean } {
  const existing = db.get<Row>("SELECT id FROM portal_pauses WHERE id = ?", [pauseId]);
  if (!existing) return { resumed: false };
  db.run("DELETE FROM portal_pauses WHERE id = ?", [pauseId]);
  return { resumed: true };
}
