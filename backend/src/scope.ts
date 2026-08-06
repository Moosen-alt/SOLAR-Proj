import type { Request } from "express";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { currentUser, requestOrg, ROLE_SUPERADMIN } from "./auth";
import { HttpError } from "./httpError";
import { addAuditLog } from "./audit";

// WHO IS ASKING, and what they are allowed to see.
//
// Resolved once per request and cached on the request object, because the pieces
// (api key → org, cookie → user → org, entitlements) each cost a query and handlers
// used to re-resolve them ad hoc.
//
// The convention throughout the data layer is that an org filter of `null` means
// "no filter" — the superadmin bypass — and any string means "exactly this org".
// That is deliberately explicit: a function taking `string | null` cannot silently
// forget to scope the way an optional trailing `orgId?` can.

export interface RequestScope {
  /** The tenant this request belongs to. */
  orgId: string;
  /** True for the operator/owner: reads are unrestricted across every org. */
  crossOrg: boolean;
  userId: string;
  role: string;
}

const CACHE = Symbol.for("solar.requestScope");

export function requestScope(db: AppDb, req: Request): RequestScope {
  const cached = (req as unknown as Record<symbol, RequestScope>)[CACHE];
  if (cached) return cached;
  const user = currentUser(db, req);
  const org = requestOrg(db, req);
  const scope: RequestScope = {
    orgId: org.id || DEFAULT_ORG_ID,
    crossOrg: user?.role === ROLE_SUPERADMIN,
    userId: user?.id || "",
    role: user?.role || "",
  };
  (req as unknown as Record<symbol, RequestScope>)[CACHE] = scope;
  return scope;
}

/**
 * The org id to filter reads by, or null when the caller may read across tenants.
 * Pass the result straight into a scoped repository function.
 */
export function orgFilter(scope: RequestScope): string | null {
  return scope.crossOrg ? null : scope.orgId;
}

/** Convenience for routes that only need the filter. */
export function reqOrgFilter(db: AppDb, req: Request): string | null {
  return orgFilter(requestScope(db, req));
}

/**
 * Build a SQL predicate for an org column. Returns an empty clause when unscoped so
 * callers can interpolate it unconditionally.
 *
 *   const { clause, params } = orgClause(filter, "p.org_id");
 *   db.query(`SELECT * FROM projects p WHERE 1=1 ${clause}`, [...params]);
 */
export function orgClause(orgId: string | null, column = "org_id"): { clause: string; params: string[] } {
  return orgId ? { clause: ` AND ${column} = ?`, params: [orgId] } : { clause: "", params: [] };
}

/**
 * Record that a superadmin reached across tenants. Cross-org access is legitimate —
 * the operator runs the service bureau — but it should never be invisible.
 */
export function auditCrossOrgAccess(db: AppDb, scope: RequestScope, action: string, details: Record<string, unknown>): void {
  if (!scope.crossOrg) return;
  addAuditLog(db, null, "human", scope.userId || "superadmin", `crossorg.${action}`, details);
}

/**
 * Assert a row the caller fetched actually belongs to them. Throws 404 rather than
 * 403 — the same convention review_submissions already uses, so an out-of-scope id is
 * indistinguishable from a nonexistent one and cannot be used to probe for existence.
 */
export function assertInScope(scope: RequestScope, rowOrgId: string | null | undefined, what = "Record"): void {
  if (scope.crossOrg) return;
  if ((rowOrgId || DEFAULT_ORG_ID) !== scope.orgId) throw new HttpError(404, `${what} not found.`);
}
