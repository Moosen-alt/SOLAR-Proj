// FAIL-CLOSED ROUTE REGISTRY.
//
// Tenant isolation is only as good as the newest route. The guards in server.ts cover
// whole path prefixes, so most new routes inherit scoping automatically — but a route
// added at a NEW top-level path (say /api/invoices) would be reachable by every tenant
// with no scoping at all, and nothing would say so.
//
// This test enumerates every route registered in server.ts and requires each one to be
// accounted for: either it sits under a path-mounted scope guard, or it is a list/global
// route whose handler is known to take a tenant filter, or it is deliberately unscoped
// and named here WITH A REASON. A new route matching none of those fails this test.
//
// It reads the source rather than booting the app, so it stays fast and has no ports,
// no database, and no ordering dependence on the rest of the suite.
// Run: tsx backend/test/routeScope.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SERVER = path.resolve(process.cwd(), "backend/src/server.ts");
const source = fs.readFileSync(SERVER, "utf8");

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Every app.<verb>("<path>" registration, including the multi-line express.raw forms.
const ROUTE_RE = /app\.(get|post|put|delete|patch)\(\s*(?:\[)?\s*"([^"]+)"/g;
const routes: Array<{ verb: string; path: string }> = [];
for (const m of source.matchAll(ROUTE_RE)) routes.push({ verb: m[1], path: m[2] });
const apiRoutes = routes.filter((r) => r.path.startsWith("/api/"));

// ---------------------------------------------------------------------------
// 1. Path prefixes covered by a scope guard registered with app.use(...).
//    Parsed from the source so this test tracks the guards rather than duplicating them.
// ---------------------------------------------------------------------------
const GUARD_RE = /app\.use\("(\/api\/[^"]+)",\s*(?:child)?[sS]copeGuard\(/g;
const guardedPrefixes = [...source.matchAll(GUARD_RE)].map((m) => m[1].replace(/\/:id$/, ""));
run("scope guards are registered", guardedPrefixes.length >= 5, `found ${JSON.stringify(guardedPrefixes)}`);

// ---------------------------------------------------------------------------
// 2. Routes that are NOT under a guard and must therefore be justified.
//
//    Each entry needs a reason. Adding a route here is a deliberate act that shows up
//    in review — which is the point.
// ---------------------------------------------------------------------------
const UNSCOPED_BY_DESIGN: Record<string, string> = {
  // Public, token-authorized. The token IS the capability; scoping by session would
  // break the whole point (a homeowner has no login).
  "/api/public/status/:token": "tokenized public status page",
  "/api/public/review/:token": "tokenized shared review report",
  // The one-time secure credential link (onboarding guide S4). Unscoped BY DESIGN: the
  // customer supplying the logins has no account here. The TOKEN is the authorization and it
  // is stronger than the siblings above - single-use (spent on first successful submit),
  // expiring (72h default), write-only (the GET reveals only which portals we asked about,
  // never anything submitted), and it can only write credentials for the portals the request
  // itself named. An unknown, spent and expired token all return the SAME message so a prober
  // learns nothing. See backend/src/credentialRequests.ts and credentialRequest.test.ts.
  "/api/public/credential-request/:token": "one-time, expiring, write-only credential drop box - the token IS the authorization",
  "/api/intake/:token": "tokenized public client intake link",
  // The per-CLIENT tracker. Unscoped by session for the same reason as its siblings — the solar
  // company has no login here (onboarding guide S8) — but the token resolves to exactly one
  // clients.id and every query below it filters on that id, so the token IS the tenancy
  // boundary rather than merely bypassing one. Asserted in clientPortal.test.ts, which fails if
  // another company's project reaches the payload. Note this token is STABLE and unrotatable by
  // design, so it is a permanent bearer credential for one company's project list.
  "/api/public/portal/:token": "tokenized per-client tracking page - the token resolves to one client_id and filters on it",

  // Auth surface — must be reachable before you have an identity.
  "/api/auth/login": "establishes the session",
  "/api/auth/logout": "ends the session",
  "/api/auth/me": "reports the current session",

  // Org/licence administration. Gated by requireAdmin (role + autopilot entitlement),
  // which is a stronger check than org scoping.
  "/api/orgs": "admin-gated org administration",
  "/api/orgs/:id/users": "admin-gated org administration",
  "/api/orgs/:id/api-keys": "admin-gated org administration",
  "/api/orgs/:id/products": "admin-gated licence administration",
  "/api/products": "admin-gated product registry",
  "/api/admin/backup": "admin-gated operations",
  "/api/admin/backups": "admin-gated operations",
  "/api/admin/cec-sync": "admin-gated operations",
  "/api/diagnostics": "admin-gated operations",

  // Deliberately SHARED knowledge. A jurisdiction's code cycle or an AHJ's portal quirk
  // is the product's core asset and is learned once for everyone. Reachable only by
  // autopilot-entitled orgs via the licensing gate. See CLAUDE.md.
  "/api/knowledge-base": "shared knowledge base (see CLAUDE.md shared-knowledge policy)",
  "/api/code-profiles": "shared jurisdiction code profiles",
  "/api/ahj-forms": "shared AHJ form registry",
  "/api/ahj-templates": "shared AHJ form templates",
  "/api/portal-recipes": "shared portal automation recipes",
  "/api/kb": "shared knowledge base",
  "/api/cec-equipment": "shared CEC equipment listings",

  // Stateless tools — no tenant data at rest, gated by product entitlement.
  "/api/tools": "stateless form-filler tool; holds no tenant data",
  "/api/review": "review gate; rows are org-scoped inside reviewSubject.ts",

  // Health/infra.
  "/health": "liveness probe",
  "/api/events": "SSE stream; per-subscriber org filtering lives in events.ts",

  // Accounted for by other means than a path guard.
  "/api/jobs/:id": "handler asserts job.orgId is in scope",
  "/api/signatures/:id/default": "handler passes requestScope().orgId to setDefaultSignature",
  "/api/signatures/:id": "handler passes requestScope().orgId to deleteSignature",
  "/api/signatures/:id/image": "handler passes reqOrgFilter to getSignatureImage",
  "/api/communications": "subject id arrives in the body; checked with assertRefInScope",
  "/api/learn-runs": "portal debug bundles are operator artifacts; admin-gated",

  // Learns into the SHARED knowledge base only — creates no projects, clients or
  // documents (verified: no createProject/saveProjectDocument in batchImport.ts).
  "/api/batch-import": "shared-knowledge learning; creates no tenant rows",

  // Operator-level integrations and global background triggers. Reachable only by
  // autopilot-entitled orgs; in the service-bureau model that is the operator alone.
  "/api/gmail": "operator-level mail integration",
  "/api/imap": "operator-level mail integration",
  "/api/email-tracker/sources": "creates a source stamped with the caller's org",
  "/api/email-tracker/run": "takes the org from the session, never the body",
  "/api/permit-monitor/run": "global background sweep; runs as system",
  "/api/nem-monitor/run": "global background sweep; runs as system",
  "/api/portal-pauses": "global automation kill-switches",
  "/api/users/:id": "role changes are authorized inside updateUser against the session actor",

  // Stateless: takes a payload, returns a result, stores nothing.
  "/api/parser": "stateless parse/extract; holds no tenant data",
};

// Routes whose handler takes an explicit tenant filter. Checked by name against the
// source so a handler that stops passing one is caught.
const SCOPED_LIST_ROUTES: Record<string, string> = {
  "/api/projects": "reqOrgFilter",
  "/api/clients": "reqOrgFilter",
  "/api/users": "reqOrgFilter",
  "/api/users/workload": "reqOrgFilter",
  "/api/email-tracker": "reqOrgFilter",
  "/api/customers": "reqOrgFilter",
  "/api/kpi": "reqOrgFilter",
  "/api/corrections/overdue": "reqOrgFilter",
  "/api/jobs": "reqOrgFilter",
  "/api/signatures": "reqOrgFilter",
  "/api/ops-actions": "reqOrgFilter",
  "/api/ops-report": "reqOrgFilter",
};

const topLevel = (p: string): string => {
  const parts = p.split("/").filter(Boolean); // ["api", "projects", ":id", ...]
  return parts.length >= 2 ? `/${parts[0]}/${parts[1]}` : `/${parts.join("/")}`;
};

const unaccounted: string[] = [];
for (const route of apiRoutes) {
  const underGuard = guardedPrefixes.some((g) => route.path.startsWith(`${g}/`));
  if (underGuard) continue;
  if (route.path in UNSCOPED_BY_DESIGN) continue;
  if (route.path in SCOPED_LIST_ROUTES) continue;
  if (topLevel(route.path) in UNSCOPED_BY_DESIGN) continue;
  // Anything under a guarded root that isn't the bare collection is covered above;
  // the bare collection itself must be a declared scoped list.
  unaccounted.push(`${route.verb.toUpperCase()} ${route.path}`);
}

run(
  "every /api route is either guarded, declared scoped, or justified as unscoped",
  unaccounted.length === 0,
  unaccounted.length
    ? `${unaccounted.length} unaccounted route(s):\n           ${unaccounted.join("\n           ")}\n\n` +
      `         Add a scope guard in server.ts, or declare it in this test's\n` +
      `         UNSCOPED_BY_DESIGN map with a one-line reason.`
    : "",
);

// Child guards must stay registered.
for (const expected of ["/api/corrections", "/api/portal-runs"]) {
  run(`${expected}/:id is behind a child scope guard`, guardedPrefixes.includes(expected), `guards: ${guardedPrefixes.join(", ")}`);
}

// The declared list routes must still actually pass a filter. Matched on the handler
// body between this route and the next app.<verb>( registration, so a long handler
// (the project list is ~12 lines) is still covered.
for (const [routePath, helper] of Object.entries(SCOPED_LIST_ROUTES)) {
  const start = source.indexOf(`app.get("${routePath}"`);
  const body = start < 0 ? "" : source.slice(start, source.indexOf("\napp.", start + 10));
  run(`GET ${routePath} passes a tenant filter`, body.includes(helper), `expected ${helper} in:\n${body.slice(0, 300)}`);
}

// The two highest-traffic project routes, asserted explicitly rather than by prefix.
run(
  "GET /api/projects scopes the list by org",
  /getProjectList\(db,\s*\{[^}]*orgId:\s*reqOrgFilter/.test(source),
  "expected getProjectList(db, { ..., orgId: reqOrgFilter(db, req) })",
);
run(
  "POST /api/projects stamps the caller's org",
  /createProject\(db,\s*payload,\s*requestScope\(db,\s*req\)\.orgId\)/.test(source),
  "expected createProject(db, payload, requestScope(db, req).orgId)",
);

// The guards must not have been quietly removed.
for (const expected of ["/api/projects", "/api/clients", "/api/customers"]) {
  run(`${expected}/:id is behind a scope guard`, guardedPrefixes.includes(expected), `guards: ${guardedPrefixes.join(", ")}`);
}

console.log(`\nrouteScope: ${apiRoutes.length} API routes checked`);
console.log(failures === 0 ? "routeScope: all checks passed" : `routeScope: ${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
