import "dotenv/config";
import { validate, portalCredentialCreateSchema, portalCredentialUpdateSchema, autoLearnSchema, codeProfileResearchSchema, codeProfileVerifySchema, reviewSubjectSchema } from "./validation";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./db";
import { HttpError } from "./httpError";
import { llmUsageForProject, runWithLlmContext } from "./llmAccounting";
import { parseJson } from "./json";
import { collectDiagnostics, logErrorBlock, logger, requestLogger, startupBanner } from "./logger";
import { buildInfo, publicBuildInfo, versionString } from "./buildInfo";
import { checkConcurrencyConfig, readConcurrencyConfig } from "./concurrencyConfig";
import { findLearnedProfileForProject, retractCorrectionLearning, saveVerifiedAhjProfile, saveVerifiedUtilityProfile } from "./knowledgeBase";
import {
  listPortalRecipes,
  getPortalRecipe,
  startPortalRecording,
  savePortalRecipeSteps,
  markPortalRecipeForRerecord,
  clearPortalRecipeFlag,
  deletePortalRecipe,
  resolveRecipeFieldValues,
  finishPortalRecipe,
  promoteRecordingIfEligible,
  findAnyRecipeForProject,
  assertOperatorPortalUrlFits,
} from "./portalRecipes";
import { trackSafeUrl } from "./portalChannel";
import { listPortalPauses, pausePortal, resumePortal } from "./portalPause";
import {
  listPortalCredentials,
  createPortalCredential,
  updatePortalCredential,
  deletePortalCredential,
} from "./portalCredentials";
import {
  listProjectDocuments,
  saveProjectDocument,
  getProjectDocumentFile,
  deleteProjectDocument,
} from "./projectDocuments";
import { buildUtilityPackage } from "./docSplitter";
import { buildSubmittalEmailDraft } from "./applicationDocs";
import type { EvidenceTopic } from "./projectEvidence";
import { createClient, deleteClient, getClient, listClients, updateClient } from "./clients";
import { enqueueJob, getJob, inFlightJobCount, listJobs, processNextJob, startJobWorker } from "./jobQueue";
import { isPublicJobType } from "./publicJobTypes";
import { createUser, getUserWorkload, listUsers, updateUser, assignProjectToUser } from "./users";
import { listBackups, runBackup, startBackupScheduler } from "./backup";
import { startArtifactRetention } from "./artifactRetention";
import { startMonitorScheduler } from "./scheduler";
import { startAhjFormRefreshScheduler, startKbLinkCheckScheduler } from "./ahjFormRefresh";
import { startCecSyncScheduler, primeCecCache, syncCecEquipment } from "./cecEquipment";
import { extractZipToWorkdir } from "./batchZip";
import { AUTH_ENABLED, currentUser, login, logout, me, requireAuth, seedAdminUser, entitlementGate, requestOrg, createApiKey, ADMIN_ROLES } from "./auth";
import { PRODUCTS, PRODUCT_KEYS, grantProduct, revokeProduct, orgEntitlements, productsForEdition } from "./entitlements";
import { requestScope, orgFilter, orgClause, reqOrgFilter, assertInScope, auditCrossOrgAccess } from "./scope";
import type { RequestScope } from "./scope";
import { DEFAULT_ORG_ID } from "./db";
import { ensureStatusShareToken, statusShareUrl } from "./clientNotifier";
import { listCodeProfiles, getCodeProfile, saveResearchedCodeProfile, saveVerifiedCodeProfile, codeProfileKey } from "./codeProfiles";
import { applyCorrectionApproval } from "./correctionAgent";
import { runStandaloneReview, getReviewSubmission, listReviewSubmissions, reviewSubjectToProject } from "./reviewSubject";
import { renderReviewerReportHtml } from "./reviewerEngine";
import { REVIEW_PACKS } from "./reviewPacks";
import { getAutopilotState, maybeResumeAutopilot, runAutopilotApproval } from "./autopilot";
import { computeNextStep } from "./nextStep";
import {
  addCommunication,
  createCustomer,
  deleteCustomer,
  getCustomer,
  listCommunications,
  listCustomers,
  undeliveredCommunications,
  updateCustomer,
} from "./crm";
import { clientPortalPayload, clientPortalUrl, ensureClientPortalToken, publicProjectStatusPayload, trackLabel } from "./clientPortal";
import { scanStaleStatusClassifications } from "./permitMonitor";
import { getKpiReport } from "./kpi";
import {
  ahjFormRegistry,
  buildFilledFormsForProject,
  fetchFormTemplate,
  filledFormPath,
  inspectFormFields,
  matchingForms,
} from "./ahjForms";
import { acquireFromBytes, ensureAhjFormTemplate, templateProvenance } from "./ahjFormAuto";
import { createSignature, deleteSignature, getSignatureImage, listSignatures, setDefaultSignature } from "./signatures";
import { addAuditLog } from "./audit";
import { buildAuthUrl, exchangeCodeForTokens, gmailStatus, pollGmail } from "./gmail";
import { imapStatus, pollImap, upsertImapSource } from "./emailPoller";
import { answerPortalQuestions, createIntakeRequest, getIntakeRequestPublic, submitIntakeRequest, portalQuestionStatus } from "./intakeRequests";
import { createCredentialRequest, getCredentialRequestPublic, listCredentialRequests, submitCredentialRequest } from "./credentialRequests";
import { ensureHeartbeat, sseBroadcast, sseSubscribe, setSseOrgResolver } from "./events";
import {
  addManualCorrection,
  draftLatestCorrectionResponse,
  recordDesignRevisionsReceived,
  reopenCorrectionOnPortal,
  resolveCorrection,
  listOverdueCorrections,
  setCorrectionsSlaDays,
  addProjectNote,
  assignProjectClient,
  captureConfirmation,
  markCorrectionResubmitted,
  createPermitCheckTarget,
  createProject,
  updateProject,
  setProjectStatusByOperator,
  researchAndSaveAhj,
  researchAndSaveUtility,
  deleteProject,
  configureEmailTrackingSource,
  getEmailTrackerStatus,
  getHistoricalFailureReport,
  getApplicationDocumentPackage,
  getInstallerActionPacket,
  getKnowledgeBase,
  getLiveProjectReadinessReport,
  getOperationsActionQueue,
  getOperationsBrief,
  getOperationsDailyReport,
  getProjectCommunicationDrafts,
  getProjectDetail,
  getProjectHandoffPacket,
  getProjectList,
  getProjectProcessMap,
  getProjectRunbook,
  getSubmitGateReport,
  getProjectTimelineReport,
  getReviewerReport,
  getReviewerReportWithVision,
  getReviewerReportHtml,
  readStageResults,
  humanVerify,
  suggestReviewValues,
  importKnowledgeFromMbox,
  importKnowledgeFromMboxFile,
  prepareSubmission,
  recordPermitStatusCheck,
  rerunQc,
  syncOperationsPlan,
  updateOperationStep,
  runEmailTracker,
  runProjectWorkflow,
  runDuePermitChecks,
  createRunApproval,
  finalSubmitJobPayload,
} from "./repository";
import { getSubmittalTracks, markTrackSubmitted } from "./submittalTracks";
import { ahjProcessKnowledgeStatus, AHJ_PROCESS_REFERENCE_ENV } from "./processProfiles";
import { enqueueStageSteps } from "./autoStageSteps";
import type { ClientResolution, ParserExtractionResponse, SubmittalTrackType } from "../../shared/src/types";

const app = express();

// Startup credential-key gate. Portal logins + email creds are encrypted at rest
// with SESSION_ENCRYPTION_KEY; booting with it unset or left at the shipped
// placeholder means either a crash the first time a credential is touched, or
// (worse) data encrypted under a guessable key. Fail fast on those two footguns
// only — any real value (including CI's fake key) passes; a short key just warns.
(function assertEncryptionKey(): void {
  const key = process.env.SESSION_ENCRYPTION_KEY;
  if (!key || key === "replace-with-a-long-random-secret") {
    logger.error(
      "security",
      "SESSION_ENCRYPTION_KEY is unset or still the default placeholder — refusing to start. Set it to a long random secret (e.g. `openssl rand -base64 48`) before running. Credentials are encrypted at rest with this key.",
    );
    process.exit(1);
  }
  if (key.length < 24) {
    logger.warn(
      "security",
      "SESSION_ENCRYPTION_KEY is short (<24 chars) — use a long random secret so the scrypt-derived credential key is not brute-forceable from a leaked DB.",
    );
  }
})();

// Startup AHJ-knowledge gate. backend/data/reference-ahj-processes.json holds the 381
// seeded jurisdiction process profiles, and it is the ONLY place the system knows that
// (say) Coos Bay files separate building + electrical permits and wants a prescriptive
// checklist. Booting without it does not fail loudly — it makes every jurisdiction look
// like one we have no requirements for, so nothing is demanded, missingBlocking comes
// back empty and the packet card prints "Every required document is attached". Measured
// against the live database with the file unreachable, that is exactly what happened to
// the two Coos Bay permits that stalled on "Intake Requirements Needed".
//
// A server that cannot answer "what does this AHJ require?" must not answer it wrongly
// for weeks. Fail fast, the way the credential-key gate above does, and name the cause:
// the repo's own .dockerignore excludes `backend/data`, so the Docker/Fly images never
// carry this file and mount an empty volume over the directory — a container that has
// silently been in this state since it was first built will now refuse to start and say
// why. Loads and COUNTS the profiles rather than stat-ing the path, so a truncated or
// malformed file fails the gate too.
(function assertAhjProcessKnowledge(): void {
  const knowledge = ahjProcessKnowledgeStatus();
  if (knowledge.status !== "resolved") {
    logger.error(
      "ahj-knowledge",
      `The AHJ process reference could not be read — refusing to start. Without it no jurisdiction's required documents can be resolved and every document verdict silently reads as "nothing is missing". Restore backend/data/reference-ahj-processes.json, or set ${AHJ_PROCESS_REFERENCE_ENV} to its absolute path (Docker/Fly: .dockerignore excludes backend/data, so ship the file into the image or mount it and point this env var at it). Cause: ${knowledge.error || "unknown"}`,
      { triedPaths: knowledge.triedPaths },
    );
    process.exit(1);
  }
  logger.info("ahj-knowledge", `AHJ process reference loaded: ${knowledge.profileCount} jurisdiction profiles.`, { path: knowledge.path });
})();

const db = await openDatabase();
const frontendDir = path.resolve(process.cwd(), "frontend");
const port = Number(process.env.PORT || 4173);
// What code is running — from the EXECUTING code's own git commit (pinned production runs
// .probe/prod-pinned with cwd = the live folder), computed once. See buildInfo.ts.
const BUILD = buildInfo();
logger.info("build", `Running ${BUILD.label}`, {
  version: BUILD.version, sha: BUILD.sha, commitDate: BUILD.commitDate, dirty: BUILD.dirty,
  pinned: BUILD.pinned, source: BUILD.source, codeRoot: BUILD.codeRoot,
});
const dbPath = path.resolve(process.cwd(), process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite");

const asyncHandler =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };

// Turn raw Anthropic SDK errors into clean, actionable messages for the UI. Each one is marked
// OPERATOR-FACING (details.operatorFacing) so the 5xx error handler at the bottom of this file
// shows it instead of its generic "Internal error" (close-2 item 8: "credit balance is too low →
// add credits" used to be written here and then replaced before it reached the dashboard). The
// fallback carries the SDK's first line only, with any key-shaped token scrubbed; a stack never.
const OPERATOR_FACING = { operatorFacing: true } as const;
function normalizeLlmError(err: unknown): HttpError {
  const status = (err as { status?: number })?.status;
  const raw = (err as { message?: string })?.message || String(err);
  if (status === 401 || /authentication_error|invalid x-api-key/i.test(raw)) {
    return new HttpError(502, "Claude rejected the API key (401). Set a valid, active ANTHROPIC_API_KEY in your .env (it must start with 'sk-ant-'). A placeholder or expired key will be rejected — AI-assist stays off and the parser uses regex/OCR only.", OPERATOR_FACING);
  }
  if (status === 429 || /rate_limit/i.test(raw)) {
    return new HttpError(502, "Claude is rate-limited (429). Wait a moment and try again.", OPERATOR_FACING);
  }
  if (/credit|billing|insufficient|quota/i.test(raw)) {
    return new HttpError(502, "Claude rejected the request: your Anthropic account has no credit/billing (\"credit balance is too low\"). The API key is valid, but you must add credits at console.anthropic.com → Settings → Billing before AI-assist can run. Until then the parser uses regex/OCR only.", OPERATOR_FACING);
  }
  const firstLine = raw.split(/\r?\n/)[0].replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…").slice(0, 200);
  return new HttpError(502, `AI-assist failed: ${firstLine}`, OPERATOR_FACING);
}

// CORS: when ALLOWED_ORIGINS is set (comma-separated), restrict to those origins
// for internet-facing deploys. Unset = reflect any origin (same-origin SPA default).
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors(
    allowedOrigins.length
      ? { origin: allowedOrigins, credentials: true }
      : undefined,
  ),
);
// Behind the documented same-host reverse proxy (Caddy), req.ip must reflect the
// CLIENT (login brute-force lockout keys on it), not 127.0.0.1 — otherwise one
// attacker locks every user out and the lock never actually keys on the attacker.
app.set("trust proxy", process.env.TRUST_PROXY ?? "loopback");
app.use(requestLogger);
// Global JSON cap kept modest — an 80MB parser mounted before the auth gate let an
// unauthenticated request burn memory/CPU on this box. The one legitimately large
// JSON body (the pasted-mbox import) gets its own per-route parser below.
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// Lightweight security headers (no extra deps). Safe for a same-origin app.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

// Auth gate (no-op unless AUTH_ENABLED=true). Must run before static so
// unauthenticated requests for the dashboard are redirected to /login.
seedAdminUser(db);

// Teach the event bus how to attribute an event to a tenant. Injected here so
// events.ts (imported by nearly everything) stays free of a database dependency.
setSseOrgResolver((projectId) => {
  const row = db.get<{ org_id?: string }>("SELECT org_id FROM projects WHERE id = ?", [projectId]);
  return row ? String(row.org_id || DEFAULT_ORG_ID) : null;
});
app.post("/api/auth/login", (req, res) => login(db, req, res));
app.post("/api/auth/logout", (req, res) => logout(req, res));
app.get("/api/auth/me", (req, res) => me(db, req, res));
app.get("/login", (_req, res) => res.sendFile(path.join(frontendDir, "login.html")));
// Public client intake page (tokenized, no login) — served before the auth gate.
app.get("/intake", (_req, res) => res.sendFile(path.join(frontendDir, "intake.html")));
// The one-time secure credential link (onboarding guide S4) - the page the customer opens.
app.get("/credentials", (_req, res) => res.sendFile(path.join(frontendDir, "credentials.html")));
// Public read-only client status page (tokenized link, no login).
app.get("/status", (_req, res) => res.sendFile(path.join(frontendDir, "status.html")));
// The per-CLIENT tracker: one stable link listing every job we are filing for that company.
app.get("/portal", (_req, res) => res.sendFile(path.join(frontendDir, "portal.html")));
app.use(requireAuth(db));
// Licensing: an org reaches only the routes of the products it holds. Deny-by-default,
// driven by the product registry in entitlements.ts.
app.use(entitlementGate(db));
// AHJ-facing review gate — AFTER the auth gate so anonymous visitors are sent to
// /login (the page's data calls are auth-gated regardless).
app.get("/review", (_req, res) => res.sendFile(path.join(frontendDir, "review.html")));

// ---------------------------------------------------------------------------
// TENANT SCOPE GUARDS. One registration per addressable root resource, covering
// every current AND future subroute beneath it — /api/projects/:id alone has 57.
// Threading an org id through the ~70 getProjectDetail call sites would have made
// every one of them a place to forget; this is a single place that cannot be
// forgotten, because a new route inherits it by virtue of its path.
//
// Out-of-scope resolves to 404, not 403 — the convention review_submissions
// already uses, so an id you don't own is indistinguishable from one that doesn't
// exist and can't be used to probe for existence.
//
// Scope is enforced HERE, at the edge, rather than in the data layer, precisely so
// background work (scheduler, job queue, permit monitor) can keep running as system
// with no request and no principal to fake.
// ---------------------------------------------------------------------------
function scopeGuard(table: string, label: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const scope = requestScope(db, req);
    if (scope.crossOrg) {
      auditCrossOrgAccess(db, scope, "read", { table, id: req.params.id, path: req.originalUrl });
      return next();
    }
    const row = db.get<{ org_id?: string }>(`SELECT org_id FROM ${table} WHERE id = ?`, [String(req.params.id)]);
    // A missing row falls through so the handler produces its own, more specific 404.
    if (!row) return next();
    try {
      assertInScope(scope, row.org_id, label);
    } catch (err) {
      next(err);
      return;
    }
    next();
  };
}

/**
 * Same guard for a CHILD row, which carries no org of its own and reaches one through
 * its project. Child tables deliberately have no org_id — denormalising it onto fifteen
 * of them would create fifteen ways to drift — so the join IS the scope check.
 */
function childScopeGuard(table: string, label: string, param = "id") {
  return (req: Request, res: Response, next: NextFunction) => {
    const scope = requestScope(db, req);
    const rowId = String(req.params[param] ?? "");
    if (scope.crossOrg) {
      auditCrossOrgAccess(db, scope, "read", { table, id: rowId, path: req.originalUrl });
      return next();
    }
    const row = db.get<{ org_id?: string }>(
      `SELECT p.org_id FROM ${table} c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
      [rowId],
    );
    // Missing row (or one with no project) falls through to the handler's own 404.
    if (!row) return next();
    try {
      assertInScope(scope, row.org_id, label);
    } catch (err) {
      next(err);
      return;
    }
    next();
  };
}

/**
 * Check a row id that arrives in a request BODY rather than the path, where no mounted
 * guard can reach it. No-op when the id is absent.
 */
function assertRefInScope(scope: RequestScope, table: string, rawId: unknown, label: string): void {
  const rowId = typeof rawId === "string" ? rawId.trim() : "";
  if (!rowId || scope.crossOrg) return;
  const row = db.get<{ org_id?: string }>(`SELECT org_id FROM ${table} WHERE id = ?`, [rowId]);
  if (!row) throw new HttpError(404, `${label} not found.`);
  assertInScope(scope, row.org_id, label);
}

app.use("/api/projects/:id", scopeGuard("projects", "Project"));
app.use("/api/clients/:id", scopeGuard("clients", "Client"));
app.use("/api/customers/:id", scopeGuard("customers", "Customer"));
app.use("/api/corrections/:id", childScopeGuard("corrections", "Correction"));
app.use("/api/portal-runs/:id", childScopeGuard("portal_runs", "Portal run"));

// LLM-6: model calls made while serving a project-scoped request are attributed to that
// project (and its org) in llm_calls. AFTER the scope guard, so an out-of-scope request has
// already been refused; a missing project attributes nothing.
app.use("/api/projects/:id", (req: Request, _res: Response, next: NextFunction) => {
  const row = db.get<{ org_id?: string }>("SELECT org_id FROM projects WHERE id = ?", [String(req.params.id)]);
  if (!row) return next();
  runWithLlmContext({ projectId: String(req.params.id), orgId: row.org_id ?? null, jobId: null }, next);
});

app.use(express.static(frontendDir));

// Liveness AND readiness in one unauthenticated endpoint, because a monitor that only
// learns "the process is up" tells you nothing: the failure that matters on an unattended
// server is work silently piling up while the port still answers. Reports the few numbers
// worth paging on — the database answers, jobs are moving, and nothing is stuck.
// No secrets or PII: counts and ages only.
app.get("/health", (_req, res) => {
  const out: Record<string, unknown> = { ok: true, service: "Solar Submission Autopilot", version: versionString(BUILD), build: publicBuildInfo(BUILD) };
  try {
    db.get<{ one: number }>("SELECT 1 AS one"); // a DB that has gone away is the loudest failure
    out.db = "ok";
    const pending = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE status = 'pending'")?.n ?? 0;
    const running = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_queue WHERE status = 'running'")?.n ?? 0;
    const failed24h = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM job_queue WHERE status = 'failed' AND COALESCE(finished_at, created_at) >= ?",
      [new Date(Date.now() - 24 * 3600_000).toISOString()],
    )?.n ?? 0;
    const oldest = db.get<{ created_at: string }>(
      "SELECT created_at FROM job_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1",
    )?.created_at;
    const oldestPendingAgeSec = oldest ? Math.max(0, Math.round((Date.now() - Date.parse(oldest)) / 1000)) : 0;
    out.jobs = { pending, running, failed24h, oldestPendingAgeSec, inFlightThisProcess: inFlightJobCount() };
    out.uptimeSec = Math.round(process.uptime());
    // A queue that is long AND not draining is the shape worth alerting on — a big backlog
    // is fine while work is flowing. Reported as a WARNING, not as unhealthy: /health is
    // also the startup and load-balancer probe, and a stuck queue is a reason to page
    // someone, not to pull a working server out of rotation (or to fail a boot, which is
    // exactly what conflating the two did to the test suite).
    if (pending > 0 && running === 0 && oldestPendingAgeSec > 900) {
      out.warning = "Jobs are pending but nothing is running — the worker may be stuck.";
    }
  } catch (err) {
    out.ok = false;
    out.db = "error";
    out.error = err instanceof Error ? err.message.slice(0, 200) : String(err);
  }
  res.status(out.ok ? 200 : 503).json(out);
});

// Full runtime diagnostics — paste this output to troubleshoot. No secrets/PII.
app.get("/api/diagnostics", (req, res) => {
  requireAdmin(req);
  res.json(collectDiagnostics(db, { build: BUILD, port, dbPath }));
});

app.post("/api/projects", (req, res) => {
  const payload = req.body?.parserPayload ?? req.body?.payload ?? req.body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "Project payload must be an object.");
  }
  // A PROJECT MAY NOT BE BORN WITHOUT A CLIENT.
  //
  // Every downstream decision keys off the client: which CCB/licence goes on the
  // permit application, which portal credentials log in, which business address the
  // AHJ sees. Created client-less, none of that is answerable — and the operator does
  // not find out at intake, they find out four stages later as the `needs_client`
  // staging blocker (autopilot.ts) after QC, the reviewer gate and doc-building have
  // all run against a project that could never have been filed.
  //
  // ENFORCED AT THE ROUTE EDGE ONLY, deliberately. createProject() itself stays
  // permissive so the smoke run, the fixtures and any import that legitimately builds
  // a project before its client is known keep working, and so the existing
  // `needs_client` path still catches stored rows that predate this gate. Nothing
  // retro-fixes an existing client-less row.
  const scope = requestScope(db, req);
  const clientId = String(payload.clientId ?? "").trim();
  if (!clientId) {
    throw new HttpError(400, "Pick the client this project is filed for before saving. Every filing carries that client's CCB/contractor licence and portal login, so a project cannot be created without one — choose one in the Client / Contractor picker, or create the client first under Clients.", { needsClient: true });
  }
  const { clause, params } = orgClause(orgFilter(scope), "org_id");
  const client = db.get<{ id: string }>(`SELECT id FROM clients WHERE id = ?${clause}`, [clientId, ...params]);
  if (!client) {
    throw new HttpError(400, `No client "${clientId}" exists here. Pick the client this project is filed for from the Client / Contractor list, or create it first under Clients.`, { needsClient: true });
  }
  const created = createProject(db, payload, scope.orgId);
  // THE LOCAL PIPELINE RUNS ITSELF from here (operator ruling 2026-09-21): a freshly parsed
  // project queues QC -> doc package -> reviewer gate automatically, stopping cold at
  // ready_to_stage. Staging is still a person's action. After the response, never blocking it.
  try { enqueueStageSteps(db, created.project.id); } catch { /* the chain is a convenience, not the save */ }
  res.status(201).json(created);
});

app.put("/api/projects/:id", (req, res) => {
  const payload = req.body?.parserPayload ?? req.body?.payload ?? req.body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "Project payload must be an object.");
  }
  const updated = updateProject(db, String(req.params.id), payload);
  // A re-save from the parser is the repair door for a qc_failed project — the operator fixed
  // the intake, so the chain gets a fresh start. Guarded inside: only statuses the chain owns
  // (parsed/qc_passed/ready_to_stage) do anything; a submitted project no-ops.
  try { enqueueStageSteps(db, String(req.params.id)); } catch { /* ditto */ }
  res.json(updated);
});

app.get("/api/projects", (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  const offset = req.query.offset ? Number(req.query.offset) : 0;
  const search = req.query.search ? String(req.query.search) : undefined;
  const status = req.query.status ? String(req.query.status) : undefined;
  const userId = req.query.userId ? String(req.query.userId) : undefined;
  const clientId = req.query.clientId ? String(req.query.clientId) : undefined;
  const sort = (req.query.sort as string | undefined);
  const validSorts = ["updated_desc", "created_desc", "name_asc", "status_asc"] as const;
  type SortOption = typeof validSorts[number];
  const sortVal = validSorts.includes(sort as SortOption) ? (sort as SortOption) : undefined;
  res.json(getProjectList(db, { limit, offset, search, status, userId, clientId, includeArchived: req.query.includeArchived === "true", sort: sortVal, orgId: reqOrgFilter(db, req) }));
});

// --- Clients (contractor profiles + licensing) ---
app.get("/api/clients", (req, res) => {
  res.json({ clients: listClients(db, reqOrgFilter(db, req)) });
});

app.get("/api/clients/:id", (req, res) => {
  res.json(getClient(db, String(req.params.id)));
});

app.post("/api/clients", (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  res.status(201).json(createClient(db, payload, requestScope(db, req).orgId));
});

app.put("/api/clients/:id", (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  res.json(updateClient(db, String(req.params.id), payload));
});

app.delete("/api/clients/:id", (req, res) => {
  res.json(deleteClient(db, String(req.params.id)));
});

// Logo upload — accepts base64-encoded image in body { logoBase64, logoMime }.
// Capped at 400 KB encoded (≈ 300 KB raw) to keep SQLite rows reasonable.
app.put("/api/clients/:id/logo", (req, res) => {
  const MAX_B64 = 400 * 1024;
  const logoBase64 = String(req.body?.logoBase64 || "").trim();
  const logoMime = ["image/png", "image/jpeg", "image/webp"].includes(String(req.body?.logoMime))
    ? String(req.body.logoMime)
    : "image/png";
  if (!logoBase64) throw new HttpError(400, "logoBase64 is required.");
  if (logoBase64.length > MAX_B64) throw new HttpError(413, "Logo too large — max 300 KB (400 KB encoded).");
  db.run("UPDATE clients SET logo_base64 = ?, logo_mime = ?, updated_at = ? WHERE id = ?", [
    logoBase64, logoMime, new Date().toISOString(), String(req.params.id),
  ]);
  res.json({ ok: true });
});

app.delete("/api/clients/:id/logo", (req, res) => {
  db.run("UPDATE clients SET logo_base64 = NULL, logo_mime = 'image/png', updated_at = ? WHERE id = ?", [
    new Date().toISOString(), String(req.params.id),
  ]);
  res.json({ ok: true });
});

app.post("/api/projects/:id/client", (req, res) => {
  const clientId = req.body?.clientId === null ? null : String(req.body?.clientId || "").trim() || null;
  const assigned = assignProjectClient(db, String(req.params.id), clientId);
  maybeResumeAutopilot(db, String(req.params.id), "a client was assigned to the project"); // clears needsClient/CCB blockers
  res.json(assigned);
});

// --- Per-client portal credentials (encrypted; plaintext never returned) ---
app.get("/api/clients/:id/portal-credentials", (req, res) => {
  res.json({ credentials: listPortalCredentials(db, String(req.params.id)) });
});
app.post("/api/clients/:id/portal-credentials", (req, res) => {
  const body = validate(portalCredentialCreateSchema, req.body);
  res.status(201).json(createPortalCredential(db, String(req.params.id), body));
});
app.put("/api/clients/:id/portal-credentials/:credId", (req, res) => {
  const body = validate(portalCredentialUpdateSchema, req.body);
  res.json(updatePortalCredential(db, String(req.params.id), String(req.params.credId), body));
});
app.delete("/api/clients/:id/portal-credentials/:credId", (req, res) => {
  res.json(deletePortalCredential(db, String(req.params.id), String(req.params.credId)));
});

// --- AHJ PDF forms (fetch official form, fill, attach) ---
app.get("/api/ahj-forms", (req, res) => {
  const ahj = String(req.query.ahj || "").trim();
  const matches = ahj ? matchingForms(ahj) : ahjFormRegistry;
  res.json({
    forms: matches.map((def) => ({
      id: def.id,
      formName: def.formName,
      matchJurisdictions: def.matchJurisdictions,
      sourceUrl: def.sourceUrl,
      version: def.version,
      status: def.status,
      mappedTextFields: Object.keys(def.textFields).length,
      mappedCheckboxes: Object.keys(def.checkboxes ?? {}).length,
      notes: def.notes ?? [],
    })),
  });
});

// Vision-detect the signature lines on a built-in REGISTRY form (e.g. Portland
// electrical) and store them so the operator's signature is stamped there too.
app.post("/api/ahj-forms/:formId/detect-signatures", asyncHandler(async (req, res) => {
  const def = ahjFormRegistry.find((d) => d.id === String(req.params.formId));
  if (!def) throw new HttpError(404, "Registry form not found.");
  const bytes = await fetchFormTemplate(def);
  const { buildOverlayMapForPdf } = await import("./ahjFormAuto");
  const { saveRegistrySignatureOverride } = await import("./ahjForms");
  const { createLLMProvider } = await import("./llm");
  let overlay;
  try {
    overlay = await buildOverlayMapForPdf(createLLMProvider(), { ahj: def.formName, state: "", formName: def.formName, bytes });
  } catch (err) {
    throw normalizeLlmError(err);
  }
  const sigs = overlay?.signatureFields || [];
  saveRegistrySignatureOverride(db, def.id, sigs);
  res.json({ formId: def.id, signatureCount: sigs.length, signatures: sigs });
}));

// Inspect a fillable PDF's AcroForm field names — used to map a new form once.
app.post("/api/ahj-forms/inspect", asyncHandler(async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) throw new HttpError(400, "url is required.");
  const def = { id: "inspect", formName: "inspect", matchJurisdictions: [], sourceUrl: url, version: "", status: "verified" as const, textFields: {} };
  const bytes = await fetchFormTemplate(def);
  const result = await inspectFormFields(bytes);
  res.json(result);
}));

app.post("/api/projects/:id/filled-forms", asyncHandler(async (req, res) => {
  const detail = getProjectDetail(db, String(req.params.id));
  res.json(await buildFilledFormsForProject(db, detail.project));
}));

app.get("/api/projects/:id/filled-forms/:formId", (req, res) => {
  const formId = String(req.params.formId);
  const file = filledFormPath(String(req.params.id), formId);
  if (!fs.existsSync(file)) throw new HttpError(404, "Filled form not found. Build it first.");
  // Name the download — without Content-Disposition the browser saves the raw form-id hash
  // with no extension, which the operator can't open ("are these downloads even real?").
  // A filled form comes from the built-in registry (formId = def.id) OR a stored
  // ahj_form_templates row (formId = template id) — resolve against BOTH; a naming
  // lookup failure must never 500 the download (the old query hit a nonexistent
  // ahj_forms table, so every AHJ-form download returned a JSON error instead of
  // the PDF — the "downloaded file won't open" bug).
  let base = "";
  const registryDef = ahjFormRegistry.find((def) => def.id === formId);
  if (registryDef) {
    base = registryDef.formName;
  } else {
    try {
      const formRow = db.get<{ ahj_name?: string; original_filename?: string }>(
        "SELECT ahj_name, original_filename FROM ahj_form_templates WHERE id = ?", [formId.replace(/^tmpl-/, "")],
      );
      base = String(formRow?.original_filename || (formRow?.ahj_name ? `${formRow.ahj_name} application` : ""));
    } catch { /* fall through to the generic name */ }
  }
  base = (base || "permit-application").replace(/\.pdf$/i, "");
  const safeName = `${base} - filled.pdf`.replace(/[^A-Za-z0-9 ()._-]+/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.type("application/pdf").sendFile(file);
});

// Auto-acquire the AHJ's official permit PDF (web research → download → field
// map → store), then re-fill. Falls back to "upload the blank PDF" when no form
// is found. This is the deliberate, opt-in step behind the "Find official form
// (AI)" button so the web search cost is only paid on demand.
app.post("/api/projects/:id/find-ahj-form", asyncHandler(async (req, res) => {
  const detail = getProjectDetail(db, String(req.params.id));
  const explicitType = String(req.body?.formType || "").trim();
  const { createLLMProvider } = await import("./llm");
  const llm = createLLMProvider();
  let ensure;
  let additional: Array<{ formType: string; status: string; message: string }> = [];
  try {
    if (explicitType) {
      // Operator asked for one specific form type — honor it exactly.
      ensure = await ensureAhjFormTemplate(db, llm, detail.project, explicitType);
    } else {
      // Default: acquire the AHJ's FULL needed set (application(s) + any
      // required checklist, per process profile + KB required docs).
      const { ensureAhjFormsForProject } = await import("./ahjFormAuto");
      const all = await ensureAhjFormsForProject(db, llm, detail.project);
      ensure = all.results[0] ?? { status: "not_found" as const, message: "No forms needed/found." };
      additional = all.results.slice(1).map((r) => ({ formType: r.formType, status: r.status, message: r.message }));
    }
  } catch (err) {
    throw normalizeLlmError(err);
  }
  addAuditLog(db, String(req.params.id), "system", "ahj form acquisition", "ahj_form.find", { status: ensure.status, formName: ensure.formName || "", ahj: detail.project.ahj, permitType: ensure.permitType || "", additional: additional.map((a) => `${a.formType}:${a.status}`) });
  const filled = await buildFilledFormsForProject(db, detail.project);
  res.json({ ensure, additional, filled });
}));

// Manual KB link-freshness sweep: probe stored portal URLs (rotating batch),
// mark ok/unknown/dead, and re-research a capped number of dead ones so the
// KB heals itself when an AHJ/utility moves its portal.
app.post("/api/kb/check-links", asyncHandler(async (req, res) => {
  const { checkKnowledgeLinks } = await import("./ahjFormRefresh");
  const { createLLMProvider } = await import("./llm");
  const limit = req.body?.limit != null ? Number(req.body.limit) : undefined;
  const summary = await checkKnowledgeLinks(db, createLLMProvider(), { limit: Number.isFinite(limit) ? limit : undefined });
  addAuditLog(db, null, "human", "operator", "kb.link_check", { ...summary });
  res.json({ summary });
}));

// Draft a permit submittal email for email-submittal AHJs (e.g. City of Hillsboro).
// Deterministic — subject "<company> - BLD, ELE Permit submittal - <customer> - <address>".
app.get("/api/projects/:id/submittal-email", (req, res) => {
  const detail = getProjectDetail(db, String(req.params.id));
  let companyName = "";
  if (detail.project.clientId) {
    try {
      const client = getClient(db, detail.project.clientId);
      companyName = client.companyName || client.legalBusinessName || client.dba || "";
    } catch { /* no client */ }
  }
  // Fold in what the form-finder learned about this AHJ (submission method /
  // platform), so email-submittal AHJs are detected even when the seeded profile
  // doesn't say "email" — the learned KB profile does.
  const learned = findLearnedProfileForProject(
    db,
    { state: detail.project.state, ahj: detail.project.ahj, utility: detail.project.utility },
    { requireDocs: false },
  );
  res.json(buildSubmittalEmailDraft(detail.project, {
    companyName,
    learnedMethod: learned?.submissionMethod || "",
    learnedPlatform: learned?.portalPlatform || "",
  }));
});

// --- Live Gmail polling (read-only) ---
app.get("/api/gmail/status", (_req, res) => {
  res.json(gmailStatus());
});

app.get("/api/gmail/auth-url", (_req, res) => {
  res.json({ url: buildAuthUrl() });
});

// One-time OAuth callback: exchanges the code and returns the refresh token to
// store in GMAIL_REFRESH_TOKEN. Shown as plain text so it's easy to copy.
app.get("/api/gmail/oauth/callback", asyncHandler(async (req, res) => {
  const code = String(req.query.code || "");
  if (!code) throw new HttpError(400, "Missing authorization code.");
  const { refreshToken } = await exchangeCodeForTokens(code);
  res.type("html").send(
    `<h2>Gmail authorized</h2>` +
      (refreshToken
        ? `<p>Add this to your environment and restart the server:</p><pre>GMAIL_REFRESH_TOKEN=${refreshToken}</pre>`
        : `<p>No refresh token returned. Revoke access in your Google account and try again with prompt=consent.</p>`),
  );
}));

app.post("/api/gmail/poll", asyncHandler(async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query : undefined;
  res.json(await pollGmail(db, query));
}));

// --- IMAP polling (generic IMAP/IMAPS for corporate/Exchange inboxes) ---
app.get("/api/imap/status", (_req, res) => {
  res.json(imapStatus());
});

app.post("/api/imap/poll", asyncHandler(async (_req, res) => {
  res.json(await pollImap(db));
}));

// List active IMAP sources stored in DB (credentials redacted).
app.get("/api/imap/sources", (_req, res) => {
  const rows = db.query(
    `SELECT id, label, imap_host, imap_port, imap_secure, imap_user, imap_mailbox,
            imap_max_messages, recipient_tag, client_id, active,
            last_checked_at, last_message_count, last_matched_count, last_error
     FROM email_tracking_sources WHERE source_type = 'imap' ORDER BY created_at`,
  );
  res.json(rows);
});

// Add or update an IMAP source. Password encrypted server-side; never returned.
app.post("/api/imap/sources", asyncHandler(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const id = upsertImapSource(db, {
    id: typeof b.id === "string" ? b.id : undefined,
    label: String(b.label ?? ""),
    host: String(b.host ?? ""),
    port: b.port ? Number(b.port) : undefined,
    secure: b.secure !== false,
    user: String(b.user ?? ""),
    password: typeof b.password === "string" ? b.password : undefined,
    mailbox: typeof b.mailbox === "string" ? b.mailbox : undefined,
    maxMessages: b.maxMessages ? Number(b.maxMessages) : undefined,
    recipientTag: typeof b.recipientTag === "string" ? b.recipientTag : undefined,
    clientId: typeof b.clientId === "string" ? b.clientId : undefined,
    active: b.active !== false,
  });
  res.json({ id });
}));

// Deactivate an IMAP source (soft delete — retains history).
app.delete("/api/imap/sources/:id", (req, res) => {
  const now = new Date().toISOString();
  db.run(
    "UPDATE email_tracking_sources SET active = 0, updated_at = ? WHERE id = ? AND source_type = 'imap'",
    [now, req.params.id],
  );
  res.json({ ok: true });
});

// --- Client intake links (collect valuation + homeowner contact from the installer) ---

// Operator: create (or reuse) a shareable intake link for a project.
app.post("/api/projects/:id/intake-request", asyncHandler(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createIntakeRequest(db, String(req.params.id), {
    fields: Array.isArray(b.fields) ? (b.fields as ("jobValue" | "homeownerEmail" | "homeownerPhone")[]) : undefined,
    createdBy: typeof b.createdBy === "string" ? b.createdBy : undefined,
    expiresInDays: typeof b.expiresInDays === "number" ? b.expiresInDays : 30,
  });
  // Absolute URL so the operator can copy/paste it straight into an email.
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({ ...result, url: `${base}${result.path}` });
}));

// Operator: which portal per-job questions are still unanswered for this project
// (and which the installer said "I'm not sure" about). Drives the dashboard's
// "N portal questions unanswered" blocker chip next to the readiness indicators.
app.get("/api/projects/:id/portal-questions", asyncHandler(async (req, res) => {
  res.json(await portalQuestionStatus(db, String(req.params.id)));
}));

// The parser page is the intake surface: answers posted here get the SAME rigid validation
// as the public token path (only open questions, only the portal's own options), written
// through answerPortalQuestions so the snapshot and the v17 columns stay in step.
app.post("/api/projects/:id/portal-questions", asyncHandler(async (req, res) => {
  const out = await answerPortalQuestions(db, String(req.params.id), (req.body ?? {}).answers ?? {});
  // Answers re-run QC; like /qc and /human-verify, the chain continues from wherever QC left it.
  try { enqueueStageSteps(db, String(req.params.id)); } catch { /* convenience, never the answers */ }
  res.json(out);
}));

// THE ONE-TIME SECURE CREDENTIAL LINK (onboarding guide §4). The operator mints a link for a
// client naming the portals we need logins for; the customer opens it once, types the
// credentials, and they land encrypted through the ordinary writer. Public routes sit under
// /api/public/ so they are exempt from the session gate BY THE SAME RULE the intake link uses -
// the TOKEN is the authorization, and it is single-use and expiring.
app.post("/api/clients/:id/credential-requests", (req, res) => {
  const body = (req.body ?? {}) as { portals?: unknown[]; ttlHours?: number };
  const made = createCredentialRequest(db, String(req.params.id), (body.portals ?? []) as never, {
    createdBy: requestScope(db, req).userId || "",
    ttlHours: Number(body.ttlHours) || undefined,
  });
  const base = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  res.json({ ...made, url: `${base}/credentials?token=${made.token}` });
});

app.get("/api/clients/:id/credential-requests", (req, res) => {
  res.json({ requests: listCredentialRequests(db, String(req.params.id)) });
});

// Public (no auth): the customer's view of what we are asking for, and the one-time write.
app.get("/api/public/credential-request/:token", (req, res) => {
  res.json(getCredentialRequestPublic(db, String(req.params.token)));
});

app.post("/api/public/credential-request/:token", (req, res) => {
  const body = (req.body ?? {}) as { portals?: unknown[] };
  res.json(submitCredentialRequest(db, String(req.params.token), (body.portals ?? []) as never));
});

// Public (no auth): read an intake request by token.
app.get("/api/intake/:token", asyncHandler(async (req, res) => {
  res.json(getIntakeRequestPublic(db, String(req.params.token)));
}));

// ---------------------------------------------------------------------------
// Jurisdiction code profiles (review gate) — onboarding + verification.
// Research is LLM web-search grounded and lands as confidence "seeded"; a human
// verifies the values against the cited official sources before the review gate
// treats them as authoritative ("verify locally" phrasing until then).
// ---------------------------------------------------------------------------
app.get("/api/code-profiles", (_req, res) => {
  res.json({ profiles: listCodeProfiles(db) });
});

app.get("/api/code-profiles/resolve", (req, res) => {
  const state = String(req.query.state || "").trim();
  const ahj = String(req.query.ahj || "").trim();
  if (!state) throw new HttpError(400, "state is required.");
  res.json({ profile: getCodeProfile(db, { state, ahj }) });
});

app.post("/api/code-profiles/research", asyncHandler(async (req, res) => {
  const b = validate(codeProfileResearchSchema, req.body);
  const { createLLMProvider } = await import("./llm");
  const llm = createLLMProvider();
  const research = await llm.researchJurisdictionCodes({ ahj: b.ahj, state: b.state });
  const saved = saveResearchedCodeProfile(db, research.profile);
  addAuditLog(db, null, "llm", "code-profile research", "code_profile.researched", {
    key: codeProfileKey(b), state: b.state, ahj: b.ahj, webGrounded: research.webGrounded,
  });
  res.json({ profile: saved, webGrounded: research.webGrounded, notes: research.notes, needsHumanVerification: true });
}));

app.put("/api/code-profiles/verify", (req, res) => {
  const b = validate(codeProfileVerifySchema, req.body);
  const saved = saveVerifiedCodeProfile(db, {
    key: "", confidence: "verified", updatedAt: "",
    state: b.state, ahj: b.ahj,
    adoptedCodes: b.adoptedCodes, amendments: b.amendments,
    designCriteria: b.designCriteria, prescriptive: b.prescriptive,
    fireSetbacks: b.fireSetbacks.map((f) => ({ ...f })), citations: b.citations,
  }, currentUser(db, req)?.email || "operator");
  res.json({ profile: saved });
});

// ---------------------------------------------------------------------------
// Standalone review gate — the sellable POST /api/review surface. Same engine
// as the internal reviewer, packaged for AHJ tenants: a small ReviewSubject DTO
// (+ optional plan-set PDF) in, a ReviewerReport with jurisdiction-adopted code
// citations out. Until the multi-tenant phase lands, submissions are scoped to
// the default org.
// ---------------------------------------------------------------------------
const reviewOrgId = (req: Request): string => requestOrg(db, req).id;

// Per-org daily review quota (in-memory; resets at UTC midnight). LLM vision
// reviews cost real money — a runaway integration must not burn the month's
// budget in an afternoon. REVIEW_DAILY_LIMIT=0 disables.
const reviewQuota = new Map<string, { day: string; count: number }>();
function checkReviewQuota(orgId: string): void {
  const limit = Number(process.env.REVIEW_DAILY_LIMIT ?? 200);
  if (!Number.isFinite(limit) || limit <= 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const rec = reviewQuota.get(orgId);
  if (!rec || rec.day !== day) {
    reviewQuota.set(orgId, { day, count: 1 });
    return;
  }
  rec.count++;
  if (rec.count > limit) throw new HttpError(429, `Daily review limit reached (${limit}). Try again tomorrow or contact support to raise it.`);
}

app.get("/api/review/work-types", (_req, res) => {
  res.json({ workTypes: REVIEW_PACKS });
});

app.post("/api/review", asyncHandler(async (req, res) => {
  const subject = validate(reviewSubjectSchema, req.body);
  const orgId = reviewOrgId(req);
  checkReviewQuota(orgId);
  const { submission, report, ai } = await runStandaloneReview(db, orgId, subject);
  res.status(201).json({ submissionId: submission.id, report, aiSummary: ai?.summary || "", aiNotes: ai?.notes || "" });
}));

// Plan-set upload variant: raw PDF body + the subject JSON in x-review-subject.
app.post(
  "/api/review/upload",
  express.raw({ type: ["application/pdf", "application/octet-stream"], limit: process.env.DOC_UPLOAD_LIMIT || "100mb" }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, "Plan-set PDF body required.");
    let rawSubject: unknown = {};
    try { rawSubject = JSON.parse(String(req.headers["x-review-subject"] || "{}")); } catch { throw new HttpError(400, "x-review-subject header must be JSON."); }
    const subject = validate(reviewSubjectSchema, rawSubject);
    const filename = String(req.query.filename || "planset.pdf").trim();
    const orgId = reviewOrgId(req);
    checkReviewQuota(orgId);
    const { submission, report, ai } = await runStandaloneReview(db, orgId, subject, { buffer: req.body, filename });
    res.status(201).json({ submissionId: submission.id, report, aiSummary: ai?.summary || "", aiNotes: ai?.notes || "" });
  }),
);

app.get("/api/review/submissions", (req, res) => {
  res.json({ submissions: listReviewSubmissions(db, reviewOrgId(req)).map((sub) => ({
    id: sub.id, workType: sub.workType, state: sub.state, ahj: sub.ahj, status: sub.status, createdAt: sub.createdAt,
    blockers: sub.report ? sub.report.findings.filter((f) => f.severity === "blocker").length : 0,
    findings: sub.report ? sub.report.findings.length : 0,
  })) });
});

app.get("/api/review/submissions/:id", (req, res) => {
  const sub = getReviewSubmission(db, reviewOrgId(req), String(req.params.id));
  if (!sub) throw new HttpError(404, "Review submission not found.");
  if (String(req.query.format) === "html" && sub.report) {
    const subjectRow = db.get<{ subject_json?: string }>("SELECT subject_json FROM review_submissions WHERE id = ?", [sub.id]);
    const subject = validate(reviewSubjectSchema, JSON.parse(String(subjectRow?.subject_json || "{}")));
    res.setHeader("Content-Type", "text/html");
    res.send(renderReviewerReportHtml(reviewSubjectToProject(subject, sub.id), sub.report));
    return;
  }
  res.json(sub);
});

// ---------------------------------------------------------------------------
// Org / licensing administration (full-edition admins only): create review-gate
// tenant orgs, their users, and API keys (key plaintext returned exactly once).
// ---------------------------------------------------------------------------
function requireAdmin(req: Request): void {
  if (!AUTH_ENABLED) return; // local single-operator use
  const user = currentUser(db, req);
  // Admin administration belongs to the operator's own org: an admin/superadmin whose
  // org holds the autopilot. A tenant who bought one tool can never administer orgs,
  // no matter what role their own row claims.
  if (!user || !ADMIN_ROLES.has(user.role) || !orgEntitlements(db, user.orgId).has("autopilot")) {
    throw new HttpError(403, "Admin access required.");
  }
}

app.get("/api/orgs", (req, res) => {
  requireAdmin(req);
  const orgs = db.query<Record<string, unknown>>("SELECT id, name, edition, created_at FROM orgs ORDER BY created_at");
  res.json({ orgs: orgs.map((o) => ({ ...o, products: [...orgEntitlements(db, String(o.id))].sort() })) });
});

/** The products a licence can carry, for the admin UI. */
app.get("/api/products", (req, res) => {
  requireAdmin(req);
  res.json({ products: PRODUCTS.map((p) => ({ key: p.key, label: p.label })) });
});

app.post("/api/orgs", (req, res) => {
  requireAdmin(req);
  const name = String(req.body?.name || "").trim();
  const edition = String(req.body?.edition || "review_gate") === "full" ? "full" : "review_gate";
  if (!name) throw new HttpError(400, "name is required.");
  // Products may be named explicitly; otherwise they're implied by the legacy edition
  // so existing callers (and the review-gate flow) keep working unchanged.
  const requested = Array.isArray(req.body?.products) ? req.body.products.map((p: unknown) => String(p)) : null;
  const products = requested?.length ? requested : productsForEdition(edition);
  const unknown = products.filter((p: string) => !PRODUCT_KEYS.includes(p));
  if (unknown.length) throw new HttpError(400, `Unknown product(s): ${unknown.join(", ")}. Known: ${PRODUCT_KEYS.join(", ")}.`);
  const orgId = `org-${crypto.randomUUID().slice(0, 8)}`;
  db.run("INSERT INTO orgs (id, name, edition, created_at) VALUES (?, ?, ?, ?)", [orgId, name, edition, new Date().toISOString()]);
  for (const product of products) grantProduct(db, orgId, product);
  addAuditLog(db, null, "human", currentUser(db, req)?.email || "operator", "org.created", { orgId, name, edition, products });
  res.status(201).json({ org: { id: orgId, name, edition, products } });
});

/** Grant or revoke a product on an org — how a tool gets sold to an existing tenant. */
app.put("/api/orgs/:id/products", (req, res) => {
  requireAdmin(req);
  const orgId = String(req.params.id);
  if (!db.get("SELECT id FROM orgs WHERE id = ?", [orgId])) throw new HttpError(404, "Org not found.");
  const products = Array.isArray(req.body?.products) ? req.body.products.map((p: unknown) => String(p)) : [];
  const unknown = products.filter((p: string) => !PRODUCT_KEYS.includes(p));
  if (unknown.length) throw new HttpError(400, `Unknown product(s): ${unknown.join(", ")}. Known: ${PRODUCT_KEYS.join(", ")}.`);
  for (const product of PRODUCT_KEYS) {
    if (products.includes(product)) grantProduct(db, orgId, product);
    else revokeProduct(db, orgId, product);
  }
  addAuditLog(db, null, "human", currentUser(db, req)?.email || "operator", "org.products_changed", { orgId, products });
  res.json({ orgId, products });
});

app.post("/api/orgs/:id/users", (req, res) => {
  requireAdmin(req);
  const orgId = String(req.params.id);
  if (!db.get("SELECT id FROM orgs WHERE id = ?", [orgId])) throw new HttpError(404, "Org not found.");
  const name = String(req.body?.name || "").trim() || "Reviewer";
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) throw new HttpError(400, "email and password are required.");
  if (db.get("SELECT id FROM users WHERE email = ?", [email])) throw new HttpError(409, "A user with that email already exists.");
  const userId = crypto.randomUUID();
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  db.run(
    "INSERT INTO users (id, name, email, role, color, active, created_at, password_hash, org_id) VALUES (?, ?, ?, 'operator', '#0ea5e9', 1, ?, ?, ?)",
    [userId, name, email, new Date().toISOString(), `${salt.toString("hex")}:${hash.toString("hex")}`, orgId],
  );
  addAuditLog(db, null, "human", currentUser(db, req)?.email || "operator", "org.user_created", { orgId, email });
  res.status(201).json({ user: { id: userId, name, email, orgId } });
});

app.post("/api/orgs/:id/api-keys", (req, res) => {
  requireAdmin(req);
  const orgId = String(req.params.id);
  if (!db.get("SELECT id FROM orgs WHERE id = ?", [orgId])) throw new HttpError(404, "Org not found.");
  const created = createApiKey(db, orgId, String(req.body?.name || "api key"));
  addAuditLog(db, null, "human", currentUser(db, req)?.email || "operator", "org.api_key_created", { orgId, keyId: created.id });
  res.status(201).json({ id: created.id, key: created.key, note: "Store this key now — it is shown only once." });
});

// Shareable read-only report link (e.g. the AHJ forwards a pre-review to an applicant).
app.post("/api/review/submissions/:id/share", (req, res) => {
  const sub = getReviewSubmission(db, reviewOrgId(req), String(req.params.id));
  if (!sub) throw new HttpError(404, "Review submission not found.");
  let token = String(db.get<{ share_token?: string }>("SELECT share_token FROM review_submissions WHERE id = ?", [sub.id])?.share_token || "");
  if (!token) {
    token = crypto.randomBytes(18).toString("base64url");
    db.run("UPDATE review_submissions SET share_token = ? WHERE id = ?", [token, sub.id]);
  }
  const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4173}`).replace(/\/+$/, "");
  res.json({ url: `${base}/api/public/review/${token}` });
});

app.get("/api/public/review/:token", (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!token) throw new HttpError(404, "Unknown report link.");
  const row = db.get<Record<string, unknown>>("SELECT id, org_id, subject_json, report_json FROM review_submissions WHERE share_token = ? AND share_token != ''", [token]);
  if (!row) throw new HttpError(404, "Unknown report link.");
  const subject = validate(reviewSubjectSchema, JSON.parse(String(row.subject_json || "{}")));
  const report = JSON.parse(String(row.report_json || "null"));
  if (!report) throw new HttpError(404, "Report unavailable.");
  res.setHeader("Content-Type", "text/html");
  res.send(renderReviewerReportHtml(reviewSubjectToProject(subject, String(row.id)), report));
});

// ---------------------------------------------------------------------------
// Client status sharing — a tokenized, read-only page the client (installer)
// can check any time, and the link included in automated client update emails.
// The payload is deliberately sanitized: address + status labels + track
// history only. Never account/meter numbers, credentials, documents, or raw
// scraped portal text.
// ---------------------------------------------------------------------------
app.post("/api/projects/:id/share-status", (req, res) => {
  const projectId = String(req.params.id);
  getProjectDetail(db, projectId); // 404 if missing
  const token = ensureStatusShareToken(db, projectId);
  addAuditLog(db, projectId, "human", currentUser(db, req)?.email || "operator", "client.status_link_shared", {});
  res.json({ token, url: statusShareUrl(token) });
});

// The payload is built in clientPortal.ts, next to the per-client tracker that publishes the same
// facts — see publicProjectStatusPayload. It used to be assembled inline here, and the "Recent
// updates" card was `permitStatusChecks.slice(0, 12)`: one line per CHECK rather than per change,
// with nothing naming which of the project's filings each line was about.
app.get("/api/public/status/:token", (req, res) => {
  const payload = publicProjectStatusPayload(db, String(req.params.token || ""));
  if (!payload) throw new HttpError(404, "Unknown status link.");
  res.json(payload);
});

// Public (no auth): a solar company's own tracking page. The token is on the CLIENT row, so one
// link covers every job we file for them — see backend/src/clientPortal.ts for what it carries
// and, more importantly, what it deliberately does not (correction text, other clients, any
// internal review state).
app.get("/api/public/portal/:token", (req, res) => {
  const payload = clientPortalPayload(db, String(req.params.token || ""));
  if (!payload) throw new HttpError(404, "Unknown tracking link.");
  res.json(payload);
});

// Mint (or re-read) a company's stable tracking link. Operator-only; the link itself is public.
app.post("/api/clients/:id/portal-link", (req, res) => {
  const clientId = String(req.params.id);
  const token = ensureClientPortalToken(db, clientId);
  addAuditLog(db, null, "human", currentUser(db, req)?.email || "operator", "client.portal_link_shared", { clientId });
  res.json({ url: clientPortalUrl(token) });
});

// Public (no auth): submit answers for an intake request.
app.post("/api/intake/:token", asyncHandler(async (req, res) => {
  const result = submitIntakeRequest(db, String(req.params.token), (req.body ?? {}) as Record<string, unknown>);
  sseBroadcast({ type: "intake_submitted", projectId: result.projectId, message: "Client submitted intake details — valuation/contact/portal answers updated." });
  res.json(result);
}));

// --- Server-Sent Events (live background notifications) ---
// Frontend subscribes here to receive typed events: correction_received,
// permit_issued, nem_approved, run_paused, run_failed, etc. No sensitive data.
app.get("/api/events", (req, res) => {
  const scope = requestScope(db, req);
  sseSubscribe(res, { orgId: scope.orgId, crossOrg: scope.crossOrg });
  ensureHeartbeat();
});

app.get("/api/ops-actions", (req, res) => {
  res.json(getOperationsActionQueue(db, reqOrgFilter(db, req)));
});

app.get("/api/ops-report", (req, res) => {
  res.json(getOperationsDailyReport(db, reqOrgFilter(db, req)));
});

app.get("/api/knowledge-base", (_req, res) => {
  res.json(getKnowledgeBase(db));
});

app.get("/api/email-tracker", (req, res) => {
  res.json(getEmailTrackerStatus(db, reqOrgFilter(db, req)));
});

app.post("/api/email-tracker/sources", (req, res) => {
  res.status(201).json(configureEmailTrackingSource(db, { ...(req.body || {}), orgId: requestOrg(db, req).id }));
});

app.post("/api/email-tracker/run", asyncHandler(async (req, res) => {
  // orgId comes from the SESSION, never the body — otherwise a caller could post
  // {orgId:"..."} and fuzzy-match their inbound email against another tenant's
  // projects, which is a write (status checks, corrections, status transitions).
  res.json(await runEmailTracker(db, { ...(req.body || {}), orgId: requestOrg(db, req).id }));
}));

app.post("/api/knowledge-base/import-mbox", express.json({ limit: process.env.MBOX_JSON_LIMIT || "200mb" }), asyncHandler(async (req, res) => {
  const mboxText = String(req.body?.mboxText || "");
  if (!mboxText.trim()) throw new HttpError(400, "mboxText is required.");
  res.status(201).json(
    await importKnowledgeFromMbox(db, {
      mboxText,
      // The historical-failure rows this writes are org-scoped: the org is the SESSION's,
      // never a body field.
      orgId: requestScope(db, req).orgId,
      sourceLabel: req.body?.sourceLabel || "Imported MBOX",
      defaultState: req.body?.defaultState,
      defaultAhj: req.body?.defaultAhj,
      defaultUtility: req.body?.defaultUtility,
    }),
  );
}));

app.post("/api/knowledge-base/import-mbox-file", asyncHandler(async (req, res) => {
  // Stream the upload straight to a temp file, then import via the same on-disk
  // streaming path that the "Import Path" button uses. We deliberately do NOT
  // buffer the body with express.raw + Buffer.toString("utf8"): a mbox larger
  // than ~512MB exceeds Node's maximum string length and throws
  // "Cannot create a string longer than 0x1fffffe8 characters" — which is why
  // a 1GB upload failed while the local-path import (which streams) worked.
  const os = await import("node:os");
  const { pipeline } = await import("node:stream/promises");
  const { Transform } = await import("node:stream");

  const maxBytes = Number(process.env.MBOX_IMPORT_MAX_BYTES || 2 * 1024 * 1024 * 1024); // 2 GB default
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "solar-mbox-upload-"));
  const tmpFile = path.join(tmpDir, "upload.mbox");

  try {
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          cb(new HttpError(413, `Uploaded MBOX exceeds the ${Math.round(maxBytes / (1024 ** 3))} GB limit. Paste the file's full local path and click Import Path instead.`));
          return;
        }
        cb(null, chunk);
      },
    });
    await pipeline(req, limiter, fs.createWriteStream(tmpFile));

    const stat = await fs.promises.stat(tmpFile);
    if (stat.size === 0) throw new HttpError(400, "Uploaded MBOX file was empty or unreadable.");

    res.status(201).json(
      await importKnowledgeFromMboxFile(db, {
        filePath: tmpFile,
        orgId: requestScope(db, req).orgId,
        sourceLabel: String(req.header("x-source-label") || req.query.sourceLabel || "Imported MBOX file"),
        defaultState: req.query.defaultState ? String(req.query.defaultState) : undefined,
        defaultAhj: req.query.defaultAhj ? String(req.query.defaultAhj) : undefined,
        defaultUtility: req.query.defaultUtility ? String(req.query.defaultUtility) : undefined,
      }),
    );
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}));

app.post("/api/knowledge-base/import-mbox-path", asyncHandler(async (req, res) => {
  const filePath = String(req.body?.filePath || "").trim().replace(/^"(.*)"$/, "$1");
  if (!filePath) throw new HttpError(400, "Paste the full local MBOX file path before importing.");
  const resolved = path.resolve(filePath);
  // LFI guard: this endpoint reads an operator-supplied absolute path. Constrain it to mailbox
  // file types so it can't be used to read the app's .env, the SQLite DB, SSH keys, /etc/passwd,
  // etc. (none of which carry these extensions). Optionally confine it to MBOX_IMPORT_BASE_DIR.
  const ext = path.extname(resolved).toLowerCase();
  const ALLOWED_MBOX_EXT = new Set([".mbox", ".eml", ".txt", ".gz"]);
  if (!ALLOWED_MBOX_EXT.has(ext)) {
    throw new HttpError(400, "MBOX import only accepts .mbox, .eml, .txt, or .gz files.");
  }
  const baseDir = process.env.MBOX_IMPORT_BASE_DIR ? path.resolve(process.env.MBOX_IMPORT_BASE_DIR) : null;
  if (baseDir && resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    throw new HttpError(400, `MBOX path must be inside ${baseDir}.`);
  }
  if (!fs.existsSync(resolved)) throw new HttpError(404, `MBOX file path was not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new HttpError(400, "MBOX path must point to a file.");
  // Streamed line-by-line from disk — no size cap; multi-GB exports are fine.
  res.status(201).json(
    await importKnowledgeFromMboxFile(db, {
      filePath: resolved,
      orgId: requestScope(db, req).orgId,
      sourceLabel: req.body?.sourceLabel || path.basename(resolved),
      defaultState: req.body?.defaultState,
      defaultAhj: req.body?.defaultAhj,
      defaultUtility: req.body?.defaultUtility,
    }),
  );
}));

app.get("/api/projects/:id", (req, res) => {
  res.json(getProjectDetail(db, req.params.id));
});

app.delete("/api/projects/:id", (req, res) => {
  res.json(deleteProject(db, req.params.id));
});

// Model spend for ONE project: per-label calls, tokens and ESTIMATED cost from llm_calls.
// Under /api/projects/:id, so it inherits the tenant scope guard (foreign org -> 404). There is
// deliberately no cross-org rollup route.
app.get("/api/projects/:id/llm-usage", (req, res) => {
  const exists = db.get<{ id: string }>("SELECT id FROM projects WHERE id = ?", [String(req.params.id)]);
  if (!exists) throw new HttpError(404, "Project not found.");
  res.json(llmUsageForProject(db, String(req.params.id)));
});

app.get("/api/projects/:id/historical-failures", (req, res) => {
  res.json(getHistoricalFailureReport(db, req.params.id));
});

app.get("/api/projects/:id/ops-plan", (req, res) => {
  res.json(syncOperationsPlan(db, req.params.id));
});

app.get("/api/projects/:id/ops-brief", (req, res) => {
  res.json(getOperationsBrief(db, req.params.id));
});

app.get("/api/projects/:id/runbook", (req, res) => {
  res.json(getProjectRunbook(db, req.params.id));
});

app.get("/api/projects/:id/handoff-packet", (req, res) => {
  res.json(getProjectHandoffPacket(db, req.params.id));
});

app.get("/api/projects/:id/communication-drafts", (req, res) => {
  res.json(getProjectCommunicationDrafts(db, req.params.id));
});

app.get("/api/projects/:id/live-readiness", (req, res) => {
  res.json(getLiveProjectReadinessReport(db, req.params.id));
});

app.get("/api/projects/:id/timeline", (req, res) => {
  res.json(getProjectTimelineReport(db, req.params.id));
});

app.get("/api/projects/:id/process-map", (req, res) => {
  res.json(getProjectProcessMap(db, req.params.id));
});

app.get("/api/projects/:id/installer-actions", (req, res) => {
  res.json(getInstallerActionPacket(db, req.params.id));
});

app.get("/api/projects/:id/submit-gate", (req, res) => {
  res.json(getSubmitGateReport(db, req.params.id));
});

// THE NEXT STEP — one answer to "what is needed next, and from whom" (backend/src/nextStep.ts).
// Read-only. Under /api/projects/:id, so it inherits the project scope guard (out-of-scope 404).
app.get("/api/projects/:id/next-step", (req, res) => {
  res.json({ nextStep: computeNextStep(db, String(req.params.id)) });
});

app.post("/api/projects/:id/ops-plan/sync", (req, res) => {
  res.json(syncOperationsPlan(db, req.params.id));
});

app.post("/api/projects/:id/ops-steps/:stepId", (req, res) => {
  res.json(updateOperationStep(db, req.params.id, req.params.stepId, req.body || {}));
});

app.post("/api/projects/:id/notes", (req, res) => {
  res.status(201).json(addProjectNote(db, req.params.id, req.body || {}));
});

app.post("/api/projects/:id/workflow", (req, res) => {
  const out = runProjectWorkflow(db, req.params.id);
  // runProjectWorkflow re-runs QC; continue the chain the same way the other QC doors do.
  try { enqueueStageSteps(db, String(req.params.id)); } catch { /* convenience, never the workflow */ }
  res.json(out);
});

// OPERATOR STATUS OVERRIDE — the audited way to move a project the pipeline got wrong, and
// the only writer for `blocked` / the only way back out of it.
//
// Scope: under /api/projects/:id, so it sits behind requireAuth + entitlementGate and inherits
// the mounted tenancy guard (CLAUDE.md rule 6) — another tenant's project id resolves 404 here
// before the handler runs, exactly like every other subroute. No new top-level path, so
// routeScope.test.ts accounts for it automatically rather than by exemption.
//
// The refusals (reason required, unknown status, handoff_ready is computed) live in
// setProjectStatusByOperator with the write itself, not here, so a second caller cannot reach
// the UPDATE without passing them. This route only names the actor.
//
// Returns the refreshed ProjectDetail rather than {ok:true} — the same shape the other project
// POSTs return, so the dashboard re-renders the moved project without a follow-up GET.
app.post("/api/projects/:id/status", (req, res) => {
  const detail = setProjectStatusByOperator(
    db,
    String(req.params.id),
    String(req.body?.status ?? ""),
    String(req.body?.reason ?? ""),
    currentUser(db, req)?.email || "operator",
  );
  res.json(detail);
});

app.get("/api/projects/:id/application-docs", (req, res) => {
  const pkg = getApplicationDocumentPackage(db, req.params.id);
  if (req.query.format === "html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(pkg.html);
    return;
  }
  res.json(pkg);
});

// Page-load read of what the automatic chain already produced (docs, reviewer gate,
// historical check). Writes nothing — see readStageResults.
app.get("/api/projects/:id/stage-results", asyncHandler(async (req, res) => {
  res.json(await readStageResults(db, String(req.params.id)));
}));

app.get("/api/projects/:id/reviewer-report", asyncHandler(async (req, res) => {
  if (req.query.format === "html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(await getReviewerReportHtml(db, String(req.params.id)));
    return;
  }
  // ?vision=1 runs the Claude-vision verification pass over weak findings (used
  // by the "Run Reviewer Gate" button). Default stays text-only so the many
  // internal callers (workflow, submit gate) don't pay vision cost on every load.
  if (String(req.query.vision || "") === "1") {
    // ?refresh=1 clears cached vision verdicts so all pages are re-checked.
    if (String(req.query.refresh || "") === "1") {
      db.run("DELETE FROM reviewer_vision_cache WHERE project_id = ?", [String(req.params.id)]);
    }
    res.json(await getReviewerReportWithVision(db, String(req.params.id)));
    return;
  }
  res.json(getReviewerReport(db, String(req.params.id)));
}));

// Renders the source plan-set page behind a reviewer-gate evidence topic so the
// report's "screenshot crop slot" shows the actual sheet. 404 (handled as a soft
// fallback by the report's <img onerror>) when no plan-set PDF is stored.
app.get("/api/projects/:id/evidence-image", asyncHandler(async (req, res) => {
  const { renderEvidenceImage } = await import("./pageImages");
  const topic = String(req.query.topic || "") as EvidenceTopic;
  const hint = String(req.query.hint || "");
  const excerpt = String(req.query.excerpt || "");
  if (!topic) throw new HttpError(400, "topic is required.");
  const png = await renderEvidenceImage(db, String(req.params.id), topic, hint, excerpt);
  if (!png) throw new HttpError(404, "No source page image available for this evidence yet.");
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=600");
  res.send(png);
}));

app.post("/api/projects/:id/qc", (req, res) => {
  const detail = rerunQc(db, req.params.id);
  // "For it to auto go anyway" (operator, 2026-09-21): a HAND-RUN QC used to strand the
  // project at qc_passed under a banner promising automatic motion — the chain only enqueued
  // on save/upload/split. Whoever runs QC, the chain continues from wherever QC left it.
  try { enqueueStageSteps(db, String(req.params.id)); } catch { /* convenience, never the QC */ }
  res.json(detail);
});

app.get("/api/corrections/overdue", (req, res) => {
  res.json(listOverdueCorrections(db, reqOrgFilter(db, req)));
});

app.patch("/api/corrections/:id/sla", (req, res) => {
  const slaDays = Number(req.body?.slaDays);
  if (!Number.isInteger(slaDays) || slaDays < 1) throw new HttpError(400, "slaDays must be a positive integer.");
  setCorrectionsSlaDays(db, req.params.id, slaDays);
  res.json({ ok: true });
});

app.post("/api/projects/:id/corrections", asyncHandler(async (req, res) => {
  const correctionText = String(req.body?.correctionText || "").trim();
  if (!correctionText) throw new HttpError(400, "correctionText is required.");
  addManualCorrection(db, String(req.params.id), correctionText, req.body?.source || "manual");
  // Generate the advisory AI draft reply (human reviews before sending). The
  // correction-handling agent (data-update proposals + richer bucket) runs
  // asynchronously as a correction_triage job enqueued by addManualCorrection.
  res.status(201).json(await draftLatestCorrectionResponse(db, String(req.params.id), correctionText));
}));

// Operator approves the correction agent's proposed data updates: apply them
// through updateProject and mark the correction human_approved. Optional
// `fields` limits which proposals to apply.
//
// The same approval also applies the correction's JURISDICTION proposals (a design requirement
// the AHJ stated, e.g. "Ground snow load 36 psf") to that AHJ's code profile — as seeded, with a
// citation to the comment, never over a verified row (correctionAgent.applyJurisdictionProposals).
// They are selected by id ("jurisdiction:<criterion>") in `fields`. When the approval selects
// ONLY jurisdiction values and there is no project work, the project apply below is skipped: it
// would refuse (409 "no selected data updates") after the jurisdiction write already happened.
app.post("/api/corrections/:id/apply", (req, res) => {
  const fields = Array.isArray(req.body?.fields) ? (req.body.fields as unknown[]).map(String) : undefined;
  res.json(applyCorrectionApproval(db, String(req.params.id), fields, currentUser(db, req)?.email || "operator"));
});

// THE DESIGNER WAIT ENDS HERE, AND ONLY BY A PERSON SAYING SO. A `B_designer_fix` triage
// applied above parks the project at `waiting_on_designer`; this is its only exit (short of the
// audited status override), and it deliberately has no automatic trigger — a revised document
// landing on the project is NOT evidence the revisions are complete, so nothing in the upload
// path may call it. Moves the project to `ready_to_resubmit`, where the full re-QC and every
// staging gate still apply.
//
// Nothing here submits, closes the correction, or enqueues a run: the ready_to_resubmit banner
// tells the operator to click 3 · Prepare Submittal themselves.
//
// Scope: a subroute of /api/corrections/:id, so it inherits the child scope guard (another
// tenant's correction 404s before the handler runs) and the deny-by-default entitlement gate —
// no new top-level path, so routeScope.test.ts accounts for it without an exemption. The
// refusals live in the repository function with the write, not here; this route names the actor.
app.post("/api/corrections/:id/revisions-received", (req, res) => {
  res.json(recordDesignRevisionsReceived(
    db,
    String(req.params.id),
    currentUser(db, req)?.email || "operator",
  ));
});

// Reopen the SUSPENDED filing's correction form on the live portal (the portal half of
// the correction flow). Binds the ORIGINAL application from the project's tracking
// target; the chooser refuses cancellation/withdraw forms and ambiguity; revised docs
// stage through the attach-time gate; automation STOPS for operator review — the
// resubmit click stays human (recorded via /resolve with resubmitted:true). Optional
// body.targetId picks the filing when more than one is tracked. Sits under the
// /api/corrections/:id child scope guard + the autopilot entitlement (wildcard-only,
// never API-key reachable) like its sibling actions.
app.post("/api/corrections/:id/reopen-portal", asyncHandler(async (req, res) => {
  res.json(await reopenCorrectionOnPortal(db, String(req.params.id), {
    targetId: req.body?.targetId ? String(req.body.targetId) : undefined,
  }));
}));

// Close a correction (first writer of closed_at/resubmitted). `resubmitted: true`
// records that the corrected package was resubmitted, completing cycle-time KPIs.
app.post("/api/corrections/:id/resolve", (req, res) => {
  const correction = resolveCorrection(db, String(req.params.id), {
    resubmitted: Boolean(req.body?.resubmitted),
    // The REAL actor, as revisions-received records it — not a hard-coded "human"/"correction".
    actor: { type: "human", name: currentUser(db, req)?.email || "operator" },
  });
  maybeResumeAutopilot(db, correction.projectId, "a correction was resolved"); // closing the last correction makes the project re-stageable
  res.json(correction);
});

// "This was not a real rejection — stop learning from it" (L4). Deletes the failure pattern this
// correction taught the knowledge base and rebuilds the shared rollup; sticky, so a later triage
// or resolve cannot learn it back. Scope: a subroute of /api/corrections/:id, so the child scope
// guard 404s another tenant's correction before this runs, and the deny-by-default entitlement
// gate applies — no new top-level path (routeScope.test.ts accounts for it by prefix).
app.post("/api/corrections/:id/retract-learning", (req, res) => {
  const correctionId = String(req.params.id);
  const correction = db.get<{ project_id: string }>("SELECT project_id FROM corrections WHERE id = ?", [correctionId]);
  if (!correction) throw new HttpError(404, "Correction not found.");
  const removed = retractCorrectionLearning(db, correctionId);
  addAuditLog(db, correction.project_id, "human", currentUser(db, req)?.email || "operator", "correction.learning_retracted", {
    correctionId, removedRows: removed,
  });
  res.json({ ok: true, correctionId, removedRows: removed });
});

app.post("/api/projects/:id/permit-targets", (req, res) => {
  res.status(201).json(createPermitCheckTarget(db, req.params.id, req.body || {}));
});

// Onboard a new AHJ with the LLM (easy "add a jurisdiction" workflow for new
// hires): research requirements + portal + docs and save them to the KB.
app.post("/api/knowledge-base/research-ahj", asyncHandler(async (req, res) => {
  const ahj = String(req.body?.ahj || "").trim();
  const state = String(req.body?.state || "").trim();
  const utility = req.body?.utility ? String(req.body.utility).trim() : undefined;
  if (!ahj) throw new HttpError(400, "ahj is required.");
  try {
    res.status(201).json(await researchAndSaveAhj(db, { ahj, state, utility }));
  } catch (err) {
    throw normalizeLlmError(err);
  }
}));

// Human-verified AHJ profile — a coordinator confirming/correcting the AI's guess
// (e.g. "Hillsboro uses email + ProjectDox, not Accela"). Outranks AI research.
app.post("/api/knowledge-base/ahj-profile", (req, res) => {
  const b = req.body || {};
  if (!String(b.ahj || "").trim()) throw new HttpError(400, "ahj is required.");
  // RULE 5 AT THE KB WRITE: a person verifying an AHJ can still paste the utility's portal (the
  // Happy Valley row had PowerClerk in portal_url). A verified row outranks everything, so a wrong
  // one here would pin the permit track to the NEM portal. The entity half is the person's call.
  if (b.portalUrl && !trackSafeUrl("permit", String(b.portalUrl))) {
    throw new HttpError(409, `${String(b.portalUrl)} is a utility interconnection portal — it belongs on the utility's profile, not the AHJ's.`, { hostRefused: true, code: "track_conflict" });
  }
  const profile = saveVerifiedAhjProfile(db, {
    state: String(b.state || ""),
    ahj: String(b.ahj),
    utility: b.utility ? String(b.utility) : undefined,
    portalName: b.portalName ? String(b.portalName) : undefined,
    portalPlatform: b.portalPlatform ? String(b.portalPlatform) : undefined,
    portalUrl: b.portalUrl ? String(b.portalUrl) : undefined,
    submissionMethod: b.submissionMethod ? String(b.submissionMethod) : undefined,
    requiredDocuments: Array.isArray(b.requiredDocuments) ? b.requiredDocuments.map(String) : undefined,
    notes: b.notes ? String(b.notes) : undefined,
    // WHO verified comes from the session, never the body.
    verifiedBy: requestScope(db, req).userId || "human",
  });
  res.status(201).json({ saved: true, profileKey: profile.profileKey, profile });
});

// Onboard a new UTILITY with the LLM — the same easy "add a utility" workflow used for
// AHJs: research the NEM/interconnection portal + required docs + smart-inverter/disconnect
// rules and save them to the KB so the utility is known next time.
app.post("/api/knowledge-base/research-utility", asyncHandler(async (req, res) => {
  const utility = String(req.body?.utility || "").trim();
  const state = String(req.body?.state || "").trim();
  const ahj = req.body?.ahj ? String(req.body.ahj).trim() : undefined;
  if (!utility) throw new HttpError(400, "utility is required.");
  try {
    res.status(201).json(await researchAndSaveUtility(db, { utility, state, ahj }));
  } catch (err) {
    throw normalizeLlmError(err);
  }
}));

// Human-verified utility NEM profile — a coordinator confirming/correcting the AI's
// guess, or teaching a utility from scratch (e.g. "Idaho Power uses PowerClerk; smart
// inverter settings = Yes"). Outranks AI research.
app.post("/api/knowledge-base/utility-profile", (req, res) => {
  const b = req.body || {};
  if (!String(b.utility || "").trim()) throw new HttpError(400, "utility is required.");
  if (b.portalUrl && !trackSafeUrl("nem", String(b.portalUrl))) {
    throw new HttpError(409, `${String(b.portalUrl)} is an AHJ permit portal — it belongs on the AHJ's profile, not the utility's.`, { hostRefused: true, code: "track_conflict" });
  }
  const profile = saveVerifiedUtilityProfile(db, {
    state: String(b.state || ""),
    utility: String(b.utility),
    ahj: b.ahj ? String(b.ahj) : undefined,
    portalName: b.portalName ? String(b.portalName) : undefined,
    portalPlatform: b.portalPlatform ? String(b.portalPlatform) : undefined,
    portalUrl: b.portalUrl ? String(b.portalUrl) : undefined,
    submissionMethod: b.submissionMethod ? String(b.submissionMethod) : undefined,
    requiredDocuments: Array.isArray(b.requiredDocuments) ? b.requiredDocuments.map(String) : undefined,
    smartInverterSettings: b.smartInverterSettings ? String(b.smartInverterSettings) : undefined,
    meterAggregation: b.meterAggregation ? String(b.meterAggregation) : undefined,
    acDisconnectRule: b.acDisconnectRule ? String(b.acDisconnectRule) : undefined,
    exportLimitNote: b.exportLimitNote ? String(b.exportLimitNote) : undefined,
    notes: b.notes ? String(b.notes) : undefined,
    // WHO verified comes from the session, never the body.
    verifiedBy: requestScope(db, req).userId || "human",
  });
  res.status(201).json({ saved: true, profileKey: profile.profileKey, profile });
});

// ---------------------------------------------------------------------------
// Portal record/replay recipes — teach the bot a new AHJ or utility portal by
// recording the steps once; admins can list, delete, and re-record. The recorder
// (npm run portal:record) drives a headed browser on the operator's machine and
// posts the captured steps to PUT …/steps.
// ---------------------------------------------------------------------------
app.get("/api/portal-recipes", (_req, res) => {
  res.json({ recipes: listPortalRecipes(db) });
});
app.get("/api/portal-recipes/:id", (req, res) => {
  res.json(getPortalRecipe(db, String(req.params.id)));
});
app.post("/api/portal-recipes/record", (req, res) => {
  const b = req.body || {};
  const scopeType = String(b.scopeType) === "utility" ? "utility" : "ahj";
  // An operator-supplied portal URL is judged like every other (rule 5 both ways + the entity).
  if (b.portalUrl) {
    assertOperatorPortalUrlFits(db, {
      track: scopeType === "utility" ? "nem" : "permit",
      state: b.state ? String(b.state) : "",
      name: scopeType === "utility" ? String(b.utility ?? "") : String(b.ahj ?? ""),
      url: String(b.portalUrl),
    });
  }
  res.status(201).json(
    startPortalRecording(db, {
      scopeType,
      state: b.state ? String(b.state) : undefined,
      ahj: b.ahj ? String(b.ahj) : undefined,
      utility: b.utility ? String(b.utility) : undefined,
      portalPlatform: b.portalPlatform ? String(b.portalPlatform) : undefined,
      portalUrl: b.portalUrl ? String(b.portalUrl) : undefined,
      createdBy: b.createdBy ? String(b.createdBy) : undefined,
    }),
  );
});
app.put("/api/portal-recipes/:id/steps", (req, res) => {
  const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
  res.json(savePortalRecipeSteps(db, String(req.params.id), steps, {
    status: req.body?.status,
    notes: req.body?.notes ? String(req.body.notes) : undefined,
  }));
});
// Close the review browsers for one client + track. Fire-and-forget (a wedged Chromium
// shutdown must never hang the operator's HTTP response), sanitized clientId (a raw
// "../.." from the request body would otherwise prefix-match EVERY tracked browser and
// close all clients' in-progress review sessions), verified against the clients table.
function closeReviewBrowsers(clientId: string, scope: "utility" | "ahj"): void {
  const safeClientId = clientId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeClientId || !db.get("SELECT id FROM clients WHERE id = ?", [safeClientId])) return;
  const profileBase = process.env.PORTAL_PROFILES_DIR || path.join(process.cwd(), "portal-profiles");
  void import("../../portal-bot/src/index")
    .then(({ closeStagingBrowsersForTrack }) => closeStagingBrowsersForTrack(path.join(profileBase, safeClientId), scope))
    .catch(() => { /* browser close is best-effort — it may already be closed */ });
}

// Human verified/fixed the captured fill in the review browser → promote the recording to a
// replayable "complete" recipe and close the left-open review browser for that client profile.
app.post("/api/portal-recipes/:id/finish", asyncHandler(async (req, res) => {
  const recipe = finishPortalRecipe(db, String(req.params.id), req.body?.finishedBy ? String(req.body.finishedBy) : undefined);
  const clientId = req.body?.clientId ? String(req.body.clientId) : "";
  if (clientId) closeReviewBrowsers(clientId, recipe.scopeType === "utility" ? "utility" : "ahj");
  addAuditLog(db, null, "human", "operator", "portal_recipe.finished", { recipeId: recipe.id, profileKey: recipe.profileKey });
  res.json(recipe);
}));
app.post("/api/portal-recipes/:id/rerecord", (req, res) => {
  // A HUMAN's decision — audited with who made it, so a run-driven demotion (which has its own
  // door, demoteOnReplayFailure) and a person's re-record can never be confused later.
  const user = currentUser(db, req);
  res.json(markPortalRecipeForRerecord(db, String(req.params.id), {
    actor: user?.name || "operator", actorType: "human", reason: String(req.body?.reason ?? "").slice(0, 240),
  }));
});
// A HUMAN CLEARS THE KEEP-AND-FLAG FLAG (trust skeptic M4): the operator looked at the run the
// flag names and the recipe stays replayable. Audited with who cleared it. The recipe's flag is
// returned with every recipe (flagReason / flaggedAt on GET /api/portal-recipes).
app.post("/api/portal-recipes/:id/clear-flag", (req, res) => {
  const user = currentUser(db, req);
  res.json(clearPortalRecipeFlag(db, String(req.params.id), {
    actor: user?.name || user?.email || String(req.body?.actor ?? "").trim() || "operator",
    note: String(req.body?.note ?? "").slice(0, 240),
  }));
});
app.delete("/api/portal-recipes/:id", (req, res) => {
  res.json(deletePortalRecipe(db, String(req.params.id)));
});
// Hybrid: trust a recorded portal for one-click approve-submit (must have been recorded
// through the final application submit). Off by default; fee payment is never automated.
// THERE IS NO STANDING PER-RECIPE ARM (operator ruling 2026-09-24). Automation may click a final
// submit only in a run a named person approved (Approve & Submit on the filing — see
// repository.maySubmitAutomatically), so arming a recipe is refused; DISarming is always allowed
// (it clears a legacy arm, which no decision reads any more). 404 for a recipe that is not there.
app.put("/api/portal-recipes/:id/auto-submit", (req, res) => {
  const recipe = getPortalRecipe(db, String(req.params.id));
  const enabled = req.body?.enabled === true || String(req.body?.enabled) === "true";
  if (enabled) {
    throw new HttpError(409,
      "Recipes are no longer armed for auto-submit. A final submit happens only in a run a named person approves: "
      + "use Approve & Submit on the filing (with PORTAL_ALLOW_FINAL_SUBMIT=1 on the server). Nothing was changed.",
      { noStandingArm: true, recipeId: recipe.id });
  }
  db.run("UPDATE portal_recipes SET auto_submit_enabled = 0, updated_at = ? WHERE id = ?", [new Date().toISOString(), recipe.id]);
  const user = currentUser(db, req);
  addAuditLog(db, null, "human", user?.name || "operator", "portal_recipe.auto_submit_toggled", { recipeId: recipe.id, enabled: false, orgId: user?.orgId ?? null });
  res.json({ ok: true, autoSubmitEnabled: false });
});

// ── Per-portal legal kill-switch ───────────────────────────────────────────────────────────
// Pause a jurisdiction (or a whole platform) so staging routes it to a manual handoff instead
// of driving automation — the lawful response to a cease-and-desist or bot-block.
app.get("/api/portal-pauses", (_req, res) => {
  res.json({ pauses: listPortalPauses(db) });
});
app.post("/api/portal-pauses", (req, res) => {
  const body = req.body ?? {};
  const kind = String(body.kind) === "platform" ? "platform" : "profile";
  const pause = pausePortal(db, {
    kind,
    platform: body.platform,
    identity: kind === "profile"
      ? {
          scopeType: String(body.scopeType) === "utility" ? "utility" : "ahj",
          state: body.state,
          ahj: body.ahj,
          utility: body.utility,
        }
      : undefined,
    reason: body.reason,
    pausedBy: body.pausedBy,
  });
  addAuditLog(db, null, "human", "operator", "portal.paused", { kind: pause.kind, pauseKey: pause.pauseKey, reason: pause.reason });
  res.status(201).json(pause);
});
app.delete("/api/portal-pauses/:id", (req, res) => {
  const result = resumePortal(db, String(req.params.id));
  if (result.resumed) addAuditLog(db, null, "human", "operator", "portal.resumed", { pauseId: String(req.params.id) });
  res.json(result);
});

// Resolved project+client field values — the recorder uses these to auto-bind a typed
// value to its field key (so the recipe replays each future project's own data).
app.get("/api/projects/:id/staging-field-values", (req, res) => {
  const detail = getProjectDetail(db, String(req.params.id));
  const portalType = String(req.query.portalType || "");
  res.json({ fieldValues: resolveRecipeFieldValues(db, detail.project, portalType) });
});
// Launch a headed portal-record session on this machine. The recorder
// (portal-bot/src/recordRecipe.ts) opens a Playwright browser AND blocks on
// stdin waiting for the operator to type `save` — so it must run in a real,
// visible terminal window, not a detached/stdio-ignored process (that exits
// instantly on stdin EOF and the browser closes). We write a small launcher
// script in the project root and open it in the OS terminal. Only works when
// the server runs on the operator's own machine.
app.post("/api/projects/:id/launch-record", (req, res) => {
  const detail = getProjectDetail(db, String(req.params.id));
  const p = detail.project;
  const b = (req.body || {}) as Record<string, string>;
  const scope = String(b.scope || "ahj") === "utility" ? "utility" : "ahj";
  const name = scope === "utility" ? (p.utility || "") : (p.ahj || "");
  // The recorder opens THIS URL in a live browser: judged before any window opens.
  if (b.portalUrl) {
    assertOperatorPortalUrlFits(db, { track: scope === "utility" ? "nem" : "permit", state: p.state, name, url: String(b.portalUrl) });
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || scope;
  // The server is started from the project root (`tsx backend/src/server.ts`),
  // so process.cwd() IS the root where `npm run portal:record` resolves.
  const root = process.cwd();
  const port = process.env.PORT || 4173;
  const q = (s: string): string => `"${String(s).replace(/(["\\])/g, "\\$1")}"`;
  const cmdline = [
    "npm", "run", "portal:record", "--",
    "--scope", scope,
    ...(scope === "ahj" ? ["--ahj", q(p.ahj || "")] : ["--utility", q(p.utility || "")]),
    ...(p.state ? ["--state", p.state] : []),
    ...(b.portalUrl ? ["--url", q(b.portalUrl)] : []),
    "--project", p.id,
    "--api", `http://localhost:${port}`,
    "--profile", `./.portal-profiles/${slug}`,
  ].join(" ");

  try {
    if (process.platform === "win32") {
      const bat = path.join(root, "_record-session.bat");
      fs.writeFileSync(bat, `@echo off\r\ncd /d "%~dp0"\r\ntitle Portal Recorder - ${(name || scope).replace(/[<>|&]/g, "")}\r\n${cmdline}\r\necho.\r\necho Recording session ended - you can close this window.\r\npause\r\n`);
      // `start "" <bat>` opens a NEW console window that stays interactive.
      spawn("cmd.exe", ["/c", "start", "", bat], { cwd: root, detached: true, stdio: "ignore", windowsHide: false }).unref();
    } else if (process.platform === "darwin") {
      const cmd = path.join(root, "_record-session.command");
      fs.writeFileSync(cmd, `#!/bin/bash\ncd "$(dirname "$0")"\n${cmdline}\necho\necho "Recording session ended - you can close this window."\n`, { mode: 0o755 });
      spawn("open", [cmd], { cwd: root, detached: true, stdio: "ignore" }).unref();
    } else {
      // Linux: try common terminal emulators, best-effort.
      const sh = path.join(root, "_record-session.sh");
      fs.writeFileSync(sh, `#!/bin/bash\ncd "$(dirname "$0")"\n${cmdline}\necho\necho "Recording session ended."\nexec bash\n`, { mode: 0o755 });
      const terminals = ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
      const tryTerm = (i: number): void => {
        if (i >= terminals.length) return;
        const child = spawn(terminals[i], ["-e", "bash", sh], { cwd: root, detached: true, stdio: "ignore" });
        child.on("error", () => tryTerm(i + 1));
        child.unref();
      };
      tryTerm(0);
    }
    res.json({ ok: true, message: `Opening a recorder window + browser for ${name || scope}. In that window: complete the application up to (NOT including) the final submit, then type save and press Enter.` });
  } catch (err) {
    res.json({ ok: false, message: `Couldn't auto-open a terminal (${err instanceof Error ? err.message : String(err)}). Use "Download record.bat" instead — double-click it in your SOLAR-Proj folder.` });
  }
});
// LLM-assisted field binding: for fill/select steps the recorder couldn't auto-bind by
// exact match, ask the model which project/client field each typed value corresponds to.
// Called ONCE at save-time (not per keystroke). Returns the steps array with `field` filled in.
// Autonomous portal learning — drive an unknown AHJ/utility portal with the LLM,
// fill it to the review screen, record a recipe, and verify the fill. Never submits.
// Runs OFF the request path as a background job (like prepare-submission): a live
// LLM-driven browser pass routinely takes minutes, which hung — or got proxy-killed —
// as a synchronous request. Returns 202 + jobId; the client polls /api/jobs/:id and
// reads the learn verdict from job.result. Progress still streams over SSE
// (autolearn_progress, emitted by the job handler).
app.post("/api/projects/:id/auto-learn", (req, res) => {
  const b = validate(autoLearnSchema, req.body);
  const scope = b.scope === "utility" || b.scope === "nem" ? "utility" : "ahj";
  const portalUrl = (b.portalUrl || "").trim();
  if (!portalUrl) throw new HttpError(400, "portalUrl is required to auto-learn a portal.");
  const projectId = String(req.params.id);
  // Fail fast on a bad project id — a 404 at enqueue time beats a failed job later.
  if (!db.get<{ id?: string }>("SELECT id FROM projects WHERE id = ?", [projectId])) {
    throw new HttpError(404, "Project not found.");
  }
  // RULE 5 BOTH WAYS + THE ENTITY, AT ENQUEUE — a 409 now beats a job that fails later (and
  // autoLearnPortal asks the same question again at its own door). The project's own recipe for
  // this key is not evidence for the URL being judged.
  {
    const lp = getProjectDetail(db, projectId).project;
    const own = findAnyRecipeForProject(db, { scopeType: scope, state: lp.state, ahj: lp.ahj, utility: lp.utility });
    assertOperatorPortalUrlFits(db, {
      track: scope === "utility" ? "nem" : "permit", state: lp.state,
      name: scope === "utility" ? lp.utility : lp.ahj, url: portalUrl, excludeRecipeIds: own ? [own.id] : [],
    });
  }
  // maxRetries 0: a failed learn must NOT auto-relaunch browsers on a timer — the
  // operator reads the verdict/bundle and decides.
  const job = enqueueJob(db, "auto_learn", {
    scope,
    portalUrl,
    createdBy: b.createdBy ?? "operator",
    permitType: b.permitType,
  }, { projectId, priority: 7, maxRetries: 0 });
  processNextJob(db).catch((err) => {
    logger.warn("auto-learn", `learn job error: ${err instanceof Error ? err.message : String(err)}`);
  });
  res.status(202).json({ jobId: job.id });
});

app.post("/api/portal-recipes/:id/suggest-bindings", asyncHandler(async (req, res) => {
  const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
  const projectId = String(req.body?.projectId || "").trim();
  let fieldValues: Record<string, string> = {};
  if (projectId) {
    try {
      const detail = getProjectDetail(db, projectId);
      const portalType = String(req.body?.portalType || "");
      fieldValues = resolveRecipeFieldValues(db, detail.project, portalType);
    } catch { /* proceed with empty map; all suggestions will be null */ }
  }
  const unbound = steps
    .map((s: Record<string, unknown>, i: number) => ({ s, i }))
    .filter(({ s }: { s: Record<string, unknown> }) => (s.action === "fill" || s.action === "select") && !s.field && s.value)
    .map(({ s, i }: { s: Record<string, unknown>; i: number }) => ({
      index: i,
      action: String(s.action),
      label: s.note ? String(s.note) : (s.selector as Record<string, string>)?.name,
      value: String(s.value),
    }));

  if (unbound.length === 0) return res.json({ steps });

  const { createLLMProvider } = await import("./llm");
  const llm = createLLMProvider();
  let suggestions: Array<{ index: number; field: string | null }> = [];
  try {
    suggestions = await llm.suggestRecipeFieldBindings({ unbound, fieldValues });
  } catch (err) {
    console.error("[suggest-bindings] LLM error:", err instanceof Error ? err.message : String(err));
    return res.json({ steps, warning: "LLM field-binding suggestion failed; steps saved without additional bindings." });
  }
  const byIndex = new Map(suggestions.map((s) => [s.index, s.field]));
  const annotated = steps.map((s: Record<string, unknown>, i: number) => {
    const suggested = byIndex.get(i);
    return suggested && !s.field ? { ...s, field: suggested } : s;
  });
  res.json({ steps: annotated, suggestionsApplied: suggestions.filter((s) => s.field !== null).length });
}));

// Auto-onboard the AHJ on a specific project (used when the docs builder has no
// known/learned profile), then return the refreshed application-doc package.
app.post("/api/projects/:id/research-ahj", asyncHandler(async (req, res) => {
  const detail = getProjectDetail(db, String(req.params.id));
  try {
    const result = await researchAndSaveAhj(db, {
      ahj: detail.project.ahj,
      state: detail.project.state,
      utility: detail.project.utility,
    });
    res.json({ ...result, applicationDocs: getApplicationDocumentPackage(db, String(req.params.id)) });
  } catch (err) {
    throw normalizeLlmError(err);
  }
}));

// THE MANUAL WRITER. The body is passed through as recordPermitStatusCheck's input, so
// `targetId`, `source`, `rawStatusText`, `applicationNumber`, `permitNumber` AND `track` are all
// body fields. `track` carries NO authority: it only words the classification of a reading that
// has no target. What may write a track status (nem_approved / ready_for_issue / issued /
// approved) is decided by provenance — permitMonitor.readingMayFinishTrack: a manual or portal
// reading against an ACTIVE target whose own kind is the outcome's track. A body that names a
// track and no target, or a `source` of "email", gets a needs_human_review row and a human-review
// item, never a status. (A re-check offered by the stale panel below is exactly the trusted shape:
// targetId + source public_url / manual.)
app.post("/api/projects/:id/permit-checks", asyncHandler(async (req, res) => {
  res.status(201).json(await recordPermitStatusCheck(db, String(req.params.id), req.body || {}));
}));

// WHICH OF THIS PROJECT'S STORED READINGS TODAY'S RULES WOULD CHANGE — and how to get a real one.
//
// The monitor's rules move. When they do, every row already in permit_status_checks keeps the
// verdict the OLD rules gave it, and the client page reads stored rows: Coos Bay's stalled
// structural permits were reclassified as "the city is waiting on us" one hour after the last
// check ran, so the customer-facing page went on saying "In review by the jurisdiction" about a
// permit nobody was reviewing. A classifier fix that never reaches the stored rows is invisible.
//
// NOTHING IS REWRITTEN HERE, and this route is deliberately a GET. permit_status_checks is an
// audit trail — email_project_matches.status_check_id is a foreign key into it and correction_id /
// reviewed_by_ahj feed other logic — so rewriting a row would change what we believed at the time.
// The cure is a NEW row from a REAL check, which is the existing POST directly above; each entry
// below carries the exact call that produces one, and `hasPortalUrl` says whether that call can
// fetch anything or will honestly come back with "no status text".
//
// Scope: under /api/projects/:id, so it inherits the tenancy guard (CLAUDE.md rule 6) — no new
// top-level path. getProjectDetail 404s an unknown project before anything is read.
//
// WHO CALLS IT: frontend/dashboard.js — loadStaleReadings() on every project open (in
// selectProject's allSettled batch) and again after recordPermitStatus(), rendered by
// renderPermitMonitor() as the "Readings today's rules would change" panel with a re-check
// control per row. It shipped once with no caller at all, which is the same defect as the bug it
// was written to fix: a classifier correction nobody can act on. If the panel is ever removed,
// remove this route with it rather than leaving it orphaned again.
//
// `checked` is the third answer. scanStaleStatusClassifications never throws; when the pass itself
// fails it returns checked:false with an empty list, and an empty list that means "we could not
// tell" must not reach the operator looking identical to "nothing is stale" — the dashboard prints
// the difference. This is the ONE surface that can say it: the customer pages render a boolean.
app.get("/api/projects/:id/permit-checks/stale", (req, res) => {
  const projectId = String(req.params.id);
  getProjectDetail(db, projectId); // 404 if missing / out of scope
  const scan = scanStaleStatusClassifications(db, [projectId]);
  res.json({
    projectId,
    checked: scan.checked,
    staleReadings: scan.readings.map((s) => ({
      ...s,
      label: trackLabel(s.targetType, s.permitType),
      // The production path, named rather than described. `public_url` is the fetching source for
      // a target that has a portal URL; without one a re-check can only record what a human pastes.
      recheck: {
        method: "POST",
        path: `/api/projects/${projectId}/permit-checks`,
        body: { targetId: s.targetId, source: s.hasPortalUrl ? "public_url" : "manual" },
      },
    })),
  });
});

app.post("/api/permit-monitor/run", asyncHandler(async (req, res) => {
  const targetType = req.body?.targetType || "all";
  res.json(await runDuePermitChecks(db, targetType));
}));

app.post("/api/nem-monitor/run", asyncHandler(async (_req, res) => {
  res.json(await runDuePermitChecks(db, "nem"));
}));

// Users
app.get("/api/users", (req, res) => { res.json(listUsers(db, reqOrgFilter(db, req))); });
app.post("/api/users", (req, res) => {
  if (!req.body?.name || !req.body?.email) throw new HttpError(400, "name and email are required.");
  res.status(201).json(createUser(db, { ...req.body, orgId: requestOrg(db, req).id }));
});
app.put("/api/users/:id", (req, res) => {
  // The actor is the SESSION identity, never anything from the body — updateUser uses
  // it to decide whether a role change is allowed at all.
  const user = currentUser(db, req);
  const actor = user ? { id: user.id, role: user.role, orgId: user.orgId } : null;
  res.json(updateUser(db, req.params.id, req.body || {}, actor));
});
app.get("/api/users/workload", (req, res) => { res.json(getUserWorkload(db, reqOrgFilter(db, req))); });
app.post("/api/projects/:id/assign", (req, res) => {
  assignProjectToUser(db, req.params.id, req.body?.userId || null, requestOrg(db, req).id);
  res.json({ ok: true });
});

// Customers / leads
app.get("/api/customers", (req, res) => {
  res.json(listCustomers(db, { stage: req.query.stage ? String(req.query.stage) : undefined, search: req.query.search ? String(req.query.search) : undefined, orgId: reqOrgFilter(db, req) }));
});
app.get("/api/customers/:id", (req, res) => {
  const customer = getCustomer(db, req.params.id);
  if (!customer) throw new HttpError(404, "Customer not found.");
  res.json(customer);
});
app.post("/api/customers", (req, res) => {
  if (!req.body?.name && !req.body?.email && !req.body?.phone) throw new HttpError(400, "A name, email, or phone is required.");
  res.status(201).json(createCustomer(db, req.body || {}, requestScope(db, req).orgId));
});
app.put("/api/customers/:id", (req, res) => {
  res.json(updateCustomer(db, req.params.id, req.body || {}));
});
app.delete("/api/customers/:id", (req, res) => {
  deleteCustomer(db, req.params.id);
  res.json({ ok: true });
});

// Communication log
app.get("/api/customers/:id/communications", (req, res) => {
  res.json(listCommunications(db, { customerId: req.params.id }));
});
app.get("/api/projects/:id/communications", (req, res) => {
  res.json(listCommunications(db, { projectId: req.params.id }));
});
app.post("/api/communications", (req, res) => {
  if (!req.body?.customerId && !req.body?.projectId) throw new HttpError(400, "customerId or projectId is required.");
  if (!req.body?.body && !req.body?.subject) throw new HttpError(400, "A subject or body is required.");
  // The subject id arrives in the BODY, so no path guard can cover this one — the
  // referenced project/customer has to be checked explicitly or a tenant could log a
  // communication against another company's job.
  const scope = requestScope(db, req);
  assertRefInScope(scope, "projects", req.body?.projectId, "Project");
  assertRefInScope(scope, "customers", req.body?.customerId, "Customer");
  res.status(201).json(addCommunication(db, { ...(req.body || {}), orgId: scope.orgId }));
});

// --- Project documents (upload / list / download / delete) -----------------
app.get("/api/projects/:id/documents", (req, res) => {
  res.json({ documents: listProjectDocuments(db, String(req.params.id)) });
});
app.post(
  "/api/projects/:id/documents",
  express.raw({ type: "*/*", limit: process.env.DOC_UPLOAD_LIMIT || "100mb" }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, "File body required.");
    const filename = String(req.query.filename || req.headers["x-filename"] || "upload.bin").trim();
    const docType = String(req.query.docType || req.headers["x-doc-type"] || "").trim();
    const contentType = String(req.headers["content-type"] || "application/octet-stream");
    const saved = saveProjectDocument(db, String(req.params.id), { filename, docType, contentType, buffer: req.body, source: "upload" });
    maybeResumeAutopilot(db, String(req.params.id), "a document was uploaded"); // may clear a missing-document blocker
    // A new document is new evidence for the LOCAL chain too — a project stalled at qc_passed
    // on a missing form re-checks itself instead of waiting for a click (guarded inside: only
    // chain-owned statuses do anything).
    try { enqueueStageSteps(db, String(req.params.id)); } catch { /* convenience, never the upload */ }
    res.status(201).json(saved);
  },
);
app.get("/api/projects/:id/documents/:docId", (req, res) => {
  const file = getProjectDocumentFile(db, String(req.params.id), String(req.params.docId));
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]+/g, "_")}"`);
  res.sendFile(file.path);
});
app.delete("/api/projects/:id/documents/:docId", (req, res) => {
  res.json(deleteProjectDocument(db, String(req.params.id), String(req.params.docId)));
});
// Split the plan set and assemble the upload package. SLD splitting is ONLY needed for
// utility NEM submittals and ProjectDox AHJ portals — standard Accela/EnerGov portals
// receive the full plan set PDF (no splitting needed for those).
// target: nem (utility NEM: meter photo + SLD + site plan + inverter spec) |
//         permit (ProjectDox AHJ: SLD + site plan + structural + specs + labels) |
//         all (everything, for debug). Defaults to nem.
app.post("/api/projects/:id/build-utility-package", asyncHandler(async (req, res) => {
  const target = String(req.query.target || req.body?.target || "nem");
  const pkg = await buildUtilityPackage(db, String(req.params.id), target);
  // New split documents are new evidence — re-drive the local chain so a project stalled on a
  // missing document (the submit gate names them) re-checks itself without a human click.
  try { enqueueStageSteps(db, String(req.params.id)); } catch { /* convenience, never the split */ }
  res.status(201).json(pkg);
}));

// Backups (manual trigger + list; a scheduled snapshot also runs automatically)
// Manual CEC equipment-list sync (weekly scheduler does this automatically).
app.post("/api/admin/cec-sync", asyncHandler(async (req, res) => {
  requireAdmin(req);
  res.json(await syncCecEquipment(db));
}));

app.post("/api/admin/backup", (req, res) => {
  requireAdmin(req);
  res.json(runBackup(db));
});
app.get("/api/admin/backups", (req, res) => {
  requireAdmin(req);
  res.json(listBackups());
});

// KPIs
app.get("/api/kpi", (req, res) => {
  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
  res.json(getKpiReport(db, { startDate, endDate, orgId: reqOrgFilter(db, req) }));
});
// Job queue
app.get("/api/jobs", (req, res) => {
  res.json(listJobs(db, {
    status: req.query.status as string | undefined as any,
    jobType: req.query.jobType as string | undefined as any,
    limit: req.query.limit ? Number(req.query.limit) : 100,
    orgId: reqOrgFilter(db, req),
  }));
});
app.get("/api/jobs/:id", (req, res) => {
  const scope = requestScope(db, req);
  const job = getJob(db, req.params.id);
  if (!job) throw new HttpError(404, "Job not found.");
  assertInScope(scope, job.orgId, "Job");
  res.json(job);
});
app.post("/api/jobs", (req, res) => {
  const { jobType, payload, priority, assignedToUser, projectId, scheduledAt } = req.body || {};
  if (!jobType) throw new HttpError(400, "jobType is required.");
  if (!isPublicJobType(jobType)) throw new HttpError(400, "This jobType cannot be queued through /api/jobs.");
  const scope = requestScope(db, req);
  // A job naming another tenant's project would run against it as system, so the
  // reference is checked before the job is ever queued.
  assertRefInScope(scope, "projects", projectId, "Project");
  // FINAL-SUBMIT AUTHORITY NEVER RIDES THE GENERIC ROUTE (close M1-jobs). The job handler reads
  // autoSubmit / allowFinalSubmit from the payload and the run claims the approval whose id the
  // RUNNING job's payload names — so a body written here, carrying someone's live approval id
  // (GET /api/jobs returns payloads) at a higher priority, was a run that person never approved.
  // Approve & Submit enqueues through POST /api/projects/:id/prepare-submission, which mints the
  // approval for THIS request; through /api/jobs a staging run carries its track and nothing else.
  const jobPayload = jobType === "prepare_submission"
    ? (typeof payload?.track === "string" && payload.track.trim() ? { track: payload.track.trim() } : {})
    : payload || {};
  res.status(201).json(enqueueJob(db, jobType, jobPayload, { priority, assignedToUser, projectId, scheduledAt, orgId: scope.orgId }));
});
// Batch folder scan — enqueues a background job to classify + import all PDFs in a folder
// ---------------------------------------------------------------------------
// AHJ form templates — store blank PDFs, extract field map, wipe raw bytes
// ---------------------------------------------------------------------------

// Upload a blank AHJ application PDF for storage in the moat
app.post(
  "/api/ahj-templates/upload",
  express.raw({ type: "application/pdf", limit: "50mb" }),
  asyncHandler(async (req, res) => {
    const ahjName = String(req.query.ahj || req.headers["x-ahj-name"] || "").trim();
    const state = String(req.query.state || req.headers["x-state"] || "").trim();
    const formType = String(req.query.formType || "permit_application").trim() || "permit_application";
    const filename = String(req.query.filename || req.headers["x-filename"] || "upload.pdf").trim();
    if (!ahjName) throw new HttpError(400, "ahj query param required.");
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, "PDF body required.");
    const bytes = new Uint8Array(req.body);

    // Map the blank form's fields to project data so it can be auto-filled for
    // every project under this AHJ. AcroForm fields are mapped directly; flat/
    // scanned PDFs fall back to vision-derived coordinate overlay.
    const { createLLMProvider } = await import("./llm");
    const llm = createLLMProvider();
    const formName = filename.replace(/\.pdf$/i, "") || `${ahjName} ${formType.replace(/_/g, " ")}`;
    let result;
    try {
      result = await acquireFromBytes(db, llm, { ahj: ahjName, state, formType, formName, bytes, sourceUrl: "" });
    } catch (err) {
      throw normalizeLlmError(err);
    }
    res.status(201).json({
      ahjName, state, formType,
      status: result.status,
      message: result.message,
      fieldCount: result.mappedFields || 0,
      fillable: result.status === "acquired",
    });
  }),
);

// --- Operator signatures (stored once, stamped onto permit forms) ---
app.get("/api/signatures", (req, res) => {
  res.json({ signatures: listSignatures(db, reqOrgFilter(db, req)) });
});

app.post(
  "/api/signatures",
  express.raw({ type: ["image/png", "image/jpeg"], limit: "5mb" }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, "PNG/JPEG image body required.");
    const role = String(req.query.role || "applicant").trim();
    const name = String(req.query.name || "").trim();
    const isDefault = String(req.query.default || "") === "1" || String(req.query.default || "") === "true";
    const mime = String(req.headers["content-type"] || "image/png");
    const view = await createSignature(db, { role, name, bytes: new Uint8Array(req.body), mime, isDefault, orgId: requestScope(db, req).orgId });
    res.status(201).json(view);
  }),
);

app.patch("/api/signatures/:id/default", (req, res) => {
  setDefaultSignature(db, String(req.params.id), requestScope(db, req).orgId);
  res.json({ ok: true });
});

app.delete("/api/signatures/:id", (req, res) => {
  deleteSignature(db, String(req.params.id), requestScope(db, req).orgId);
  res.json({ deleted: true });
});

app.get("/api/signatures/:id/image", (req, res) => {
  const img = getSignatureImage(db, String(req.params.id), reqOrgFilter(db, req));
  res.setHeader("Content-Type", img.mime);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(img.bytes);
});

// --- Standalone form-filler tool (decoupled from projects/DB/LLM) ---------
// Upload any flat AHJ/utility form, place values by coordinate, download filled.
// DOCX is converted to PDF server-side (LibreOffice); overlay draw is server-side
// so the coordinate math is the unit-tested path.
app.post(
  "/api/tools/form-fill/convert",
  express.raw({ type: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword", "application/octet-stream"], limit: "50mb" }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, "DOCX body required.");
    const { convertDocxToPdf } = await import("./formFiller");
    let pdf: Uint8Array;
    try { pdf = await convertDocxToPdf(new Uint8Array(req.body)); }
    catch (err) { throw new HttpError(422, err instanceof Error ? err.message : "Conversion failed."); }
    res.type("application/pdf").send(Buffer.from(pdf));
  }),
);

app.post(
  "/api/tools/form-fill/inspect",
  express.raw({ type: "application/pdf", limit: "50mb" }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, "PDF body required.");
    const { inspectPdf, isPdf } = await import("./formFiller");
    if (!isPdf(req.body)) throw new HttpError(400, "Not a PDF.");
    res.json(await inspectPdf(new Uint8Array(req.body)));
  }),
);

// Batch fill: for each row {url, data}, fetch the blank (cached per URL — many
// rows share one AHJ form), auto-fill by field name, and return all filled PDFs
// zipped. Output stays FILLABLE (autoFillByFieldName sets values, never flattens).
app.post("/api/tools/form-fill/batch", express.json({ limit: "8mb" }), asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) throw new HttpError(400, "rows required.");
  if (rows.length > 200) throw new HttpError(400, "Max 200 rows per batch.");
  const { fetchPdf } = await import("./ahjFormAuto");
  const { autoFillByFieldName, listAcroFields, overlayText, isPdf } = await import("./formFiller");
  const { extractLabels, hasTextLayer, autoPlaceFromData } = await import("./formTextLayer");
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip();
  // Fill a blank from data: AcroForm by field name, else text-layer overlay for
  // flat forms (e.g. the Jackson County refund). Returns filled bytes + how many
  // fields were populated.
  const fillOne = async (blank: Uint8Array, data: Record<string, string>): Promise<{ filled: Uint8Array; count: number }> => {
    if ((await listAcroFields(blank)).length > 0) {
      const { filled, matched, checked } = await autoFillByFieldName(blank, data);
      return { filled, count: matched.length + checked.length };
    }
    const items = await extractLabels(blank);
    if (hasTextLayer(items)) {
      const placements = autoPlaceFromData(items, data);
      return { filled: await overlayText(blank, placements), count: placements.length };
    }
    return { filled: blank, count: 0 };
  };
  // Optional single form used for every row that has no URL of its own (the
  // common case: load one AHJ form at the top, then batch-fill many rows).
  const sharedB64 = String(req.body?.sharedPdfBase64 || "");
  const shared = sharedB64 ? new Uint8Array(Buffer.from(sharedB64, "base64")) : null;
  const blankCache = new Map<string, Uint8Array | null>();
  const results: Array<{ index: number; ok: boolean; filename?: string; matched?: number; error?: string }> = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { url?: string; data?: Record<string, string>; filename?: string };
    const url = String(row?.url || "").trim();
    const data = (row?.data && typeof row.data === "object") ? row.data : {};
    try {
      let blank: Uint8Array | null;
      if (/^https?:\/\//i.test(url)) {
        const cached = blankCache.get(url);
        if (cached === undefined) { blank = await fetchPdf(url); blankCache.set(url, blank); } else { blank = cached; }
      } else {
        blank = shared; // no per-row URL → use the loaded form
      }
      if (!blank || !isPdf(blank)) throw new Error(shared ? "form URL did not return a PDF" : "no form URL and no loaded form");
      const { filled, count } = await fillOne(blank, data);
      let name = String(row.filename || data.permitNumber || `form-${i + 1}`).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.pdf$/i, "");
      let unique = name; let n = 2; while (usedNames.has(unique)) unique = `${name}-${n++}`;
      usedNames.add(unique);
      zip.addFile(`${unique}.pdf`, Buffer.from(filled));
      results.push({ index: i, ok: true, filename: `${unique}.pdf`, matched: count });
    } catch (err) {
      results.push({ index: i, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  res.json({ total: rows.length, filled: okCount, results, zipBase64: okCount ? zip.toBuffer().toString("base64") : "" });
}));

// Fetch a blank form PDF from a direct URL (the operator has the link — e.g. from
// their tracking sheet). Server-side so it dodges browser CORS; validates it's a PDF.
app.post("/api/tools/form-fill/fetch", express.json({ limit: "1mb" }), asyncHandler(async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, "A http(s) URL is required.");
  const { fetchPdf } = await import("./ahjFormAuto");
  const bytes = await fetchPdf(url);
  if (!bytes) throw new HttpError(422, "Could not fetch a PDF from that URL (not reachable, or not a PDF).");
  res.type("application/pdf").send(Buffer.from(bytes));
}));

// Look up an AHJ's form from its website (LLM web-search), then fetch the blank
// PDF — the "grab it from the AHJ site" path when you don't already have the URL.
app.post("/api/tools/form-fill/lookup", express.json({ limit: "1mb" }), asyncHandler(async (req, res) => {
  const ahj = String(req.body?.ahj || "").trim();
  const state = String(req.body?.state || "").trim();
  const formType = String(req.body?.formType || "").trim() || undefined;
  if (!ahj) throw new HttpError(400, "ahj is required.");
  const { createLLMProvider } = await import("./llm");
  const { fetchPdf } = await import("./ahjFormAuto");
  let research;
  try { research = await createLLMProvider().findAhjFormUrl({ ahj, state, formType }); }
  catch (err) { throw normalizeLlmError(err); }
  if (research.provider === "stub") throw new HttpError(422, "Form lookup needs an LLM (set ANTHROPIC_API_KEY). Paste the form URL instead.");
  // Try candidate URLs best-first; return the first that yields a real PDF.
  for (const url of research.candidateUrls || []) {
    const bytes = await fetchPdf(url);
    if (bytes) { res.json({ found: true, formName: research.formName, sourceUrl: url, pdfBase64: Buffer.from(bytes).toString("base64"), notes: research.notes }); return; }
  }
  // None were directly downloadable — hand back what we found so the operator can grab it.
  res.json({ found: false, formName: research.formName, candidateUrls: research.candidateUrls || [], formsPageUrl: research.formsPageUrl || "", notes: research.notes || "No directly-downloadable PDF found." });
}));

// Auto-fill from provided data: AcroForm forms are filled by field name (exact);
// flat forms with a text layer get label-anchored overlay placements returned for
// review; scanned forms fall back to manual placement.
app.post("/api/tools/form-fill/auto", express.json({ limit: "60mb" }), asyncHandler(async (req, res) => {
  const pdfBase64 = String(req.body?.pdfBase64 || "");
  const data = (req.body?.data && typeof req.body.data === "object") ? req.body.data as Record<string, string> : {};
  if (!pdfBase64) throw new HttpError(400, "pdfBase64 required.");
  const bytes = new Uint8Array(Buffer.from(pdfBase64, "base64"));
  const { isPdf, listAcroFields, autoFillByFieldName } = await import("./formFiller");
  if (!isPdf(bytes)) throw new HttpError(400, "pdfBase64 is not a PDF.");
  const acro = await listAcroFields(bytes);
  if (acro.length > 0) {
    const { filled, matched, fieldNames } = await autoFillByFieldName(bytes, data);
    res.json({ mode: "acroform", matched, fieldNames, filledBase64: Buffer.from(filled).toString("base64") });
    return;
  }
  const { extractLabels, hasTextLayer, autoPlaceFromData } = await import("./formTextLayer");
  const items = await extractLabels(bytes);
  if (hasTextLayer(items)) {
    res.json({ mode: "overlay", placements: autoPlaceFromData(items, data) });
    return;
  }
  res.json({ mode: "manual", placements: [], message: "This form has no fillable fields or text layer — place values manually." });
}));

app.post("/api/tools/form-fill/fill", express.json({ limit: "60mb" }), asyncHandler(async (req, res) => {
  const pdfBase64 = String(req.body?.pdfBase64 || "");
  const placements = Array.isArray(req.body?.placements) ? req.body.placements : [];
  if (!pdfBase64) throw new HttpError(400, "pdfBase64 required.");
  const bytes = new Uint8Array(Buffer.from(pdfBase64, "base64"));
  const { overlayText, isPdf } = await import("./formFiller");
  if (!isPdf(bytes)) throw new HttpError(400, "pdfBase64 is not a PDF.");
  const filled = await overlayText(bytes, placements);
  res.type("application/pdf").send(Buffer.from(filled));
}));

// Re-check every stored form's source link now and refresh any that changed.
// Runs automatically on a ~60-day schedule; this is the manual trigger.
app.post("/api/ahj-templates/refresh", asyncHandler(async (_req, res) => {
  const { refreshAhjFormTemplates } = await import("./ahjFormRefresh");
  const { createLLMProvider } = await import("./llm");
  res.json(await refreshAhjFormTemplates(db, createLLMProvider()));
}));

// List stored AHJ templates
app.get("/api/ahj-templates", (req, res) => {
  const state = req.query.state ? String(req.query.state) : null;
  // PROVENANCE TRAVELS WITH THE LISTING. An operator about to fill a stored
  // blank needs three facts the row used to keep to itself: where it came from,
  // what the document says about ITSELF, and whether that is old enough to
  // re-check. Coos County's electrical application says "Revised 12/23/2022"
  // and prints a fee table 1.70x below the adopted schedule — the staleness
  // flag is computed here, server-side, so no date parsing lands in the
  // browser and every surface agrees on what "stale" means.
  const cols = "id, ahj_name, state, form_type, original_filename, field_map, source_url, document_date, retrieved_at, fee_table_found, created_at";
  const rows = state
    ? db.query(`SELECT ${cols} FROM ahj_form_templates WHERE state = ? ORDER BY ahj_name`, [state])
    : db.query(`SELECT ${cols} FROM ahj_form_templates ORDER BY state, ahj_name`);
  res.json(rows.map((r) => ({
    ...r,
    fieldMap: parseJson<Record<string, unknown>>(String(r.field_map ?? ""), {}),
    provenance: templateProvenance(r as Record<string, unknown>),
  })));
});

// Re-map a stored template's fields from its stored blob (AcroForm first, then
// vision overlay) — used after a bad auto-map or to refresh the mapping.
app.post("/api/ahj-templates/:id/remap", asyncHandler(async (req, res) => {
  const row = db.get<{ id: string; ahj_name: string; state: string; form_type: string; pdf_blob: Buffer | null; field_map: string; retrieved_at: string }>(
    "SELECT id, ahj_name, state, form_type, pdf_blob, field_map, retrieved_at FROM ahj_form_templates WHERE id = ?",
    [String(req.params.id)],
  );
  if (!row) throw new HttpError(404, "Template not found.");
  if (!row.pdf_blob) throw new HttpError(410, "PDF blob has been wiped — re-upload the blank to re-map.");
  const map = parseJson<{ formName?: string; sourceUrl?: string }>(row.field_map, {});
  const formName = map.formName || `${row.ahj_name} ${row.form_type.replace(/_/g, " ")}`;
  const { createLLMProvider } = await import("./llm");
  let result;
  try {
    result = await acquireFromBytes(db, createLLMProvider(), {
      ahj: row.ahj_name, state: row.state, formType: row.form_type, formName,
      bytes: new Uint8Array(row.pdf_blob), sourceUrl: map.sourceUrl || "",
      // A re-map re-reads bytes we already had. Stamping "retrieved now" would
      // make a purely local operation look like a fresh trip to the AHJ's site,
      // which is the one claim retrieved_at exists to make honestly.
      retrievedAt: String(row.retrieved_at || ""),
    });
  } catch (err) {
    throw normalizeLlmError(err);
  }
  res.json(result);
}));

// Mark a stored form's mapping verified (or not) — gates real submit. The
// operator does this after previewing the filled PDF.
app.patch("/api/ahj-templates/:id/verify", (req, res) => {
  const row = db.get<{ field_map: string }>("SELECT field_map FROM ahj_form_templates WHERE id = ?", [String(req.params.id)]);
  if (!row) throw new HttpError(404, "Template not found.");
  const map = parseJson<Record<string, unknown>>(row.field_map, {});
  const verified = req.body?.verified !== false; // default true
  map.verified = verified;
  map.verifiedAt = verified ? new Date().toISOString() : undefined;
  db.run("UPDATE ahj_form_templates SET field_map = ?, updated_at = ? WHERE id = ?", [JSON.stringify(map), new Date().toISOString(), String(req.params.id)]);
  res.json({ id: String(req.params.id), verified });
});

// Fully delete a stored template (blob + map).
app.delete("/api/ahj-templates/:id", (req, res) => {
  // SHARED cross-tenant knowledge: one delete removes the template (and any
  // human-verified field map) for EVERY tenant. Admin-only, and a verified map
  // needs the explicit ?force=1 acknowledgement — verified mapping work is the
  // product's asset and must never vanish on a casual click.
  requireAdmin(req);
  const row = db.get<{ id: string; field_map?: string }>("SELECT id, field_map FROM ahj_form_templates WHERE id = ?", [String(req.params.id)]);
  if (!row) throw new HttpError(404, "Template not found.");
  const map = parseJson<Record<string, unknown>>(String(row.field_map || "{}"), {});
  if (map.verified === true && String(req.query.force || "") !== "1") {
    throw new HttpError(409, "This template's field map is HUMAN-VERIFIED. Deleting it destroys that work for every tenant — retry with ?force=1 if you really mean it.");
  }
  db.run("DELETE FROM ahj_form_templates WHERE id = ?", [String(req.params.id)]);
  res.json({ deleted: true });
});

// Wipe the raw PDF blob (keep moat data + field map for submission prep)
app.delete("/api/ahj-templates/:id/blob", (req, res) => {
  db.run("UPDATE ahj_form_templates SET pdf_blob = NULL, updated_at = ? WHERE id = ?", [new Date().toISOString(), req.params.id]);
  res.json({ wiped: true });
});

// Get the stored PDF blob for a template
app.get("/api/ahj-templates/:id/pdf", (req, res) => {
  const row = db.get<{ pdf_blob: Buffer | null; original_filename: string }>(
    "SELECT pdf_blob, original_filename FROM ahj_form_templates WHERE id = ?",
    [req.params.id],
  );
  if (!row) throw new HttpError(404, "Template not found.");
  if (!row.pdf_blob) throw new HttpError(410, "PDF blob has been wiped. Only field map is available.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${row.original_filename}"`);
  res.send(row.pdf_blob);
});

app.post("/api/batch-import/scan", (req, res) => {
  const { folderPath, defaultState, defaultAhj, defaultUtility, useLlm } = req.body || {};
  if (!folderPath) throw new HttpError(400, "folderPath is required.");
  if (!fs.existsSync(folderPath)) throw new HttpError(404, `Folder not found: ${folderPath}`);
  if (!fs.statSync(folderPath).isDirectory()) throw new HttpError(400, "Path must be a directory.");
  const job = enqueueJob(db, "folder_scan", { folderPath, defaultState, defaultAhj, defaultUtility, useLlm: !!useLlm }, { priority: 2, maxRetries: 1, orgId: requestScope(db, req).orgId });
  res.status(201).json(job);
});

// Upload a .zip of past-project PDFs: extract it server-side, then kick off the
// same folder scan against the extracted directory.
app.post(
  "/api/batch-import/upload-zip",
  express.raw({ type: "*/*", limit: process.env.BATCH_ZIP_LIMIT || "2gb" }),
  (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new HttpError(400, "Uploaded zip was empty or unreadable.");
    }
    const label = String(req.query.label || "batch");
    let extracted;
    try {
      extracted = extractZipToWorkdir(body, label);
    } catch (err) {
      throw new HttpError(400, `Could not read that zip file. ${(err as Error).message || ""}`.trim());
    }
    if (extracted.pdfCount === 0) {
      throw new HttpError(400, `Zip extracted (${extracted.totalEntries} entries) but contained no PDF files.`);
    }
    const job = enqueueJob(
      db,
      "folder_scan",
      {
        folderPath: extracted.folderPath,
        defaultState: req.query.defaultState ? String(req.query.defaultState) : undefined,
        defaultAhj: req.query.defaultAhj ? String(req.query.defaultAhj) : undefined,
        defaultUtility: req.query.defaultUtility ? String(req.query.defaultUtility) : undefined,
        useLlm: String(req.query.useLlm || "") === "true",
      },
      // The scan writes org-scoped historical-failure rows under the JOB's org, so the job
      // must carry the caller's — /scan above already did; this one fell back to the default.
      { priority: 2, maxRetries: 1, orgId: requestScope(db, req).orgId },
    );
    res.status(201).json({ ...job, extractedPdfCount: extracted.pdfCount, folderPath: extracted.folderPath });
  },
);

// Check folder scan job status + get full result
app.get("/api/batch-import/jobs", (req, res) => {
  res.json(listJobs(db, { jobType: "folder_scan", limit: 20 }));
});

// LLM-assisted parser extraction. The browser does the PDF text / OCR extraction
// (pdf.js + Tesseract) and posts the raw text here; Claude returns structured
// fields with confidences which the parser merges into the form. Account/meter
// numbers may be returned (the project record needs them to fill forms) but are
// never logged here.
app.post("/api/parser/llm-extract", asyncHandler(async (req, res) => {
  const planText = typeof req.body?.planText === "string" ? req.body.planText : "";
  const utilityBillText = typeof req.body?.utilityBillText === "string" ? req.body.utilityBillText : "";
  const meterText = typeof req.body?.meterText === "string" ? req.body.meterText : "";
  const structuralLetterText = typeof req.body?.structuralLetterText === "string" ? req.body.structuralLetterText : "";
  const defaultState = typeof req.body?.defaultState === "string" ? req.body.defaultState : undefined;
  if (!planText.trim() && !utilityBillText.trim() && !meterText.trim() && !structuralLetterText.trim()) {
    throw new HttpError(400, "Provide at least one of planText, utilityBillText, meterText, or structuralLetterText.");
  }
  const { createLLMProvider } = await import("./llm");
  const llm = createLLMProvider();
  try {
    const result = await llm.extractProjectFields({ planText, utilityBillText, meterText, structuralLetterText, defaultState });
    const { supplementStructuralIntake } = await import("./structuralIntake");
    const extraction = supplementStructuralIntake(result, planText);
    // WHICH COMPANY IS THIS? The prompt has always read the title-block installer and
    // always dropped it. Resolve it here, on the response the parser page already
    // waits for, so the (still required) client picker can fill itself instead of
    // asking the coordinator to pick blind. Tenancy-scoped with the same org filter
    // every other read uses — suggesting another tenant's company would be exactly
    // the cross-company error this feature exists to prevent. A resolution failure
    // must never take down a parse that otherwise worked.
    let clientResolution: ClientResolution | undefined;
    try {
      const { resolveClientForExtraction } = await import("./clientMatch");
      clientResolution = resolveClientForExtraction(db, extraction.fields, reqOrgFilter(db, req), planText);
    } catch (err) {
      logger.warn("parser", "client resolution failed — parse returned without a client suggestion", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    res.json({ ...extraction, clientResolution } satisfies ParserExtractionResponse);
  } catch (err) {
    throw normalizeLlmError(err);
  }
}));

// IMAGE-ONLY PLAN SET (a scan with no text layer): the PDF itself is posted; its key sheets are
// rendered and read by vision, capped (scannedPlanSet.ts). A plan set WITH a usable text layer
// is refused here (409) — the text path reads it. The response names every vision-read field.
app.post(
  "/api/parser/plan-scan-extract",
  express.raw({ type: ["application/pdf", "application/octet-stream"], limit: process.env.DOC_UPLOAD_LIMIT || "100mb" }),
  asyncHandler(async (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : null;
    if (!bytes || bytes.length < 5 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new HttpError(400, "Post the plan-set PDF as the request body (application/pdf).");
    const defaultState = typeof req.query.defaultState === "string" ? req.query.defaultState : undefined;
    const { createLLMProvider } = await import("./llm");
    const { readPlanSetForExtraction } = await import("./scannedPlanSet");
    try {
      const read = await readPlanSetForExtraction(createLLMProvider(), bytes, { defaultState });
      if (read.mode === "text" || !read.extraction) throw new HttpError(409, `This plan set has a text layer (${read.textChars} characters over ${read.pageCount} page(s)); the text parser reads it.`);
      // A name read off an IMAGE is not in any text layer: it may suggest a client, never pre-select one.
      let clientResolution: ClientResolution | undefined;
      try {
        const { installerIdentityFromExtraction, resolveClientFromPlanSet } = await import("./clientMatch");
        clientResolution = resolveClientFromPlanSet(db, { ...installerIdentityFromExtraction(read.extraction.fields), companyNameInText: false }, reqOrgFilter(db, req));
      } catch { /* a resolution failure never takes down the read */ }
      res.json({ ...read.extraction, clientResolution } satisfies ParserExtractionResponse);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw normalizeLlmError(err);
    }
  }),
);

// Vision-based extraction from the actual document IMAGES (utility bill, meter
// photo). Far more accurate for account/meter numbers than in-browser OCR text.
// Account/meter values flow back to populate the project record but are never logged.
app.post("/api/parser/vision-extract", asyncHandler(async (req, res) => {
  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  const cleaned = images
    .filter((i: unknown): i is { kind: string; base64: string; mimeType: string } =>
      Boolean(i) && typeof (i as { base64?: unknown }).base64 === "string")
    .map((i: { kind?: string; base64: string; mimeType?: string }) => ({
      kind: (["utility_bill", "meter_photo", "plan_page"].includes(String(i.kind)) ? i.kind : "utility_bill") as "utility_bill" | "meter_photo" | "plan_page",
      base64: i.base64,
      mimeType: (["image/png", "image/jpeg", "image/webp"].includes(String(i.mimeType)) ? i.mimeType : "image/jpeg") as "image/png" | "image/jpeg" | "image/webp",
    }))
    .slice(0, 4);
  if (!cleaned.length) throw new HttpError(400, "Provide at least one image with base64 data.");
  const defaultState = typeof req.body?.defaultState === "string" ? req.body.defaultState : undefined;
  const { createLLMProvider } = await import("./llm");
  const llm = createLLMProvider();
  try {
    const result = await llm.extractProjectFieldsFromImages({ images: cleaned, defaultState });
    res.json(result);
  } catch (err) {
    throw normalizeLlmError(err);
  }
}));

// --- Per-submission payment gate (the Payment screen at the start of the flow) ---
// Quote = real permit fees (portal-calculated actual > learned history > valuation
// estimate) + the client's service fee. Staging is blocked for per-submission
// clients until the track's payment is marked paid or waived. This bills the
// CLIENT — the AHJ/utility portal's own fee checkout is never automated.
app.get("/api/projects/:id/payment-quote", asyncHandler(async (req, res) => {
  const { buildPaymentQuote } = await import("./submissionFees");
  const detail = getProjectDetail(db, String(req.params.id));
  const { paidFeeReceiptsForProject } = await import("./feeReceipts");
  res.json({ quote: buildPaymentQuote(db, detail.project, String(req.query.track || "")),
    receipts: paidFeeReceiptsForProject(db, detail.project.id) });
}));

app.post("/api/projects/:id/payment/mark-paid", asyncHandler(async (req, res) => {
  const { markSubmissionPaid } = await import("./submissionFees");
  const detail = getProjectDetail(db, String(req.params.id));
  const quote = markSubmissionPaid(db, detail.project, String(req.body?.track || ""), {
    paymentReference: typeof req.body?.paymentReference === "string" ? req.body.paymentReference : "",
    actualPermitFeeUsd: req.body?.actualPermitFeeUsd,
  });
  addAuditLog(db, detail.project.id, "human", "operator", "payment.marked_paid", {
    track: quote.track, totalUsd: quote.totalUsd, reference: quote.payment?.paymentReference || "",
  });
  maybeResumeAutopilot(db, detail.project.id, "a fee payment was recorded"); // clears the 402 gate
  res.json({ quote });
}));

app.post("/api/projects/:id/payment/waive", asyncHandler(async (req, res) => {
  const { waiveSubmissionPayment } = await import("./submissionFees");
  const detail = getProjectDetail(db, String(req.params.id));
  const quote = waiveSubmissionPayment(db, detail.project, String(req.body?.track || ""));
  addAuditLog(db, detail.project.id, "human", "operator", "payment.waived", { track: quote.track });
  maybeResumeAutopilot(db, detail.project.id, "a fee was waived"); // clears the 402 gate
  res.json({ quote });
}));

// True-up: record the REAL portal-calculated fee (from the portal's fee/review
// screen) without marking paid — the quote total updates and the fee feeds the
// per-AHJ fee history for future quotes.
app.post("/api/projects/:id/payment/record-fee", asyncHandler(async (req, res) => {
  const { recordActualPermitFee } = await import("./submissionFees");
  const detail = getProjectDetail(db, String(req.params.id));
  const quote = recordActualPermitFee(db, detail.project, String(req.body?.track || ""), req.body?.actualPermitFeeUsd, "operator");
  addAuditLog(db, detail.project.id, "human", "operator", "payment.fee_recorded", {
    track: quote.track, permitFeeUsd: quote.permitFeeUsd,
  });
  res.json({ quote });
}));

// THE FEE SHEET — "what does this job cost, and where did that number come from?"
//
// Both tracks in one answer: the amount, the schedule line it fell in, the published page it
// was read from, the confidence, how it is paid, and — explicitly — what is still unknown. A
// fee with no number is reported UNKNOWN and never as $0, because zero is an answer ("this
// utility charges nothing") and a customer gets invoiced off this screen.
//
// Distinct from /payment-quote above, which is the per-submission BILLING gate and is shown
// only to clients on per-submission billing. The fee sheet is the money FACTS, and every
// project has them regardless of how the client is invoiced.
//
// GET, and read-only in intent — but note `buildProjectFeeSheet` builds from fresh quotes and
// `buildPaymentQuote` persists a `submission_payments` row, which is the same write the
// payment screen has always made on load. `scripts/fee-sheet.ts` rolls that write back; this
// route deliberately does not, so the dashboard's two fee panels stay consistent with each
// other. Nothing here pays anything: the portal's own checkout is always a human's (rule 1).
app.get("/api/projects/:id/fee-sheet", asyncHandler(async (req, res) => {
  const { buildProjectFeeSheet } = await import("./submissionFees");
  const detail = getProjectDetail(db, String(req.params.id));
  res.json({ feeSheet: buildProjectFeeSheet(db, detail.project) });
}));

// What the assigned client owes for this project: fees we ADVANCED and re-bill, kept apart
// from our own service fee, because one is a pass-through and the other is revenue. Reads
// only — unlike the payment-quote route below it, asking for an invoice never creates a row.
app.get("/api/projects/:id/invoice", asyncHandler(async (req, res) => {
  const { buildProjectInvoice } = await import("./invoices");
  const detail = getProjectDetail(db, String(req.params.id));
  res.json({ invoice: buildProjectInvoice(db, detail.project) });
}));

app.post("/api/projects/:id/prepare-submission", (req, res) => {
  // Optional track scopes staging to one filing (nem | building | electrical | combo);
  // omitted = the legacy combined stage.
  const projectId = String(req.params.id);
  const rawTrack = String(req.body?.track || "").trim();
  const track = SUBMITTAL_TRACK_TYPES.includes(rawTrack as SubmittalTrackType) ? (rawTrack as SubmittalTrackType) : undefined;
  // Hybrid: operator-approved auto-submit. Only honored backend-side when the resolved
  // recipe is trusted (auto_submit_enabled); otherwise it falls back to guided-manual.
  const autoSubmit = req.body?.autoSubmit === true || String(req.body?.autoSubmit) === "true";
  // Operator-delegated final submit — the CRM's "Submit" button for a hand-coded adapter.
  // Recorded in the audit trail BEFORE the run, with the approver's identity, exactly as
  // autopilot/approve does: a filing must always be attributable to a person.
  const allowFinalSubmit = req.body?.allowFinalSubmit === true || String(req.body?.allowFinalSubmit) === "true";
  // APPROVE & SUBMIT: A NAMED PERSON APPROVES THIS RUN. The approval row is the only thing that
  // lets the run click the portal's final submit (repository.maySubmitAutomatically also needs
  // PORTAL_ALLOW_FINAL_SUBMIT=1, a complete recipe and its one flagged terminal submit). The
  // approver is the signed-in user when auth is on — never a body-supplied name then; with auth off
  // it is the name the dashboard sends, and "dashboard" (no name) is not a person: no approval is
  // recorded and the run stops at review like any other.
  // THE APPROVAL IS BOUND TO THIS REQUEST (trust skeptic M1): the job carries the flag AND the
  // approval's id only when this request minted one; a request that named nobody is enqueued as
  // an ordinary run (autoSubmit false) — it can never pick up an approval someone else minted.
  let approval: { id: string } | null = null;
  if (autoSubmit || allowFinalSubmit) {
    const user = currentUser(db, req);
    if (AUTH_ENABLED && !user) throw new HttpError(401, "Sign in to approve a final submit.");
    const approverName = AUTH_ENABLED ? String(user?.name || user?.email || "").trim() : String(req.body?.approverName || "").trim();
    if (approverName) {
      approval = createRunApproval(db, { projectId, track: track ?? "permit", approver: approverName, approverUserId: user?.id ?? null });
    } else {
      addAuditLog(db, projectId, "human", "dashboard", "portal.final_submit_not_approved", {
        track: track ?? "permit", reason: "no named approver — the run will stop at review",
      });
    }
  }
  // Staging runs OFF the request path as a background job: a live portal pass can take
  // many seconds (sometimes minutes), which would otherwise hang or time out the HTTP
  // request. Enqueue + kick the worker, return 202 with the jobId; the client polls
  // /api/jobs/:id and refetches the project once it's done. SSE still fires on completion.
  const job = enqueueJob(db, "prepare_submission", finalSubmitJobPayload({ track, autoSubmit, allowFinalSubmit, approval }), { projectId, priority: 7, maxRetries: 0 });
  processNextJob(db)
    .then(() => {
      // Check the JOB first: a staging-gate 409 (QC/docs/CCB/permit-path/host conflict)
      // throws BEFORE any portal_run is recorded, so detail.portalRuns[0] is a STALE run
      // from an earlier stage — reading it here used to broadcast a generic (or even a
      // false-success) message while the real reason sat unseen in the job row.
      const finishedJob = getJob(db, job.id);
      if (finishedJob?.status === "failed") {
        const reason = (finishedJob.error || "Staging failed — see server log.").replace(/^(Http)?Error:\s*/i, "");
        logger.warn("prepare-submission", `staging blocked/failed: ${reason}`, { projectId });
        sseBroadcast({ type: "run_failed", projectId, message: `Staging failed: ${reason}` });
        return;
      }
      // processNextJob claims the single highest-priority pending job — under concurrent
      // load that may have been a DIFFERENT job (or the background worker already claimed
      // THIS one). If our job isn't done yet, do NOT read the project's newest portal run:
      // it belongs to an EARLIER stage and would broadcast a false success/failure. The
      // dashboard's /api/jobs poller reports this job when it actually finishes.
      if (finishedJob?.status !== "done") return;
      const detail = getProjectDetail(db, projectId);
      const run = detail.portalRuns?.[0];
      if (!run) return;
      if (run.pauseReason === "mfa_captcha") {
        sseBroadcast({ type: "run_paused", projectId, message: "Portal requires attention — MFA or CAPTCHA detected. Complete it in the browser, then resume.", data: { pauseReason: run.pauseReason } });
      } else if (run.status === "failed") {
        const why = run.errorMessage || "see the run log on the project for details";
        sseBroadcast({ type: "run_failed", projectId, message: `Portal run failed: ${why}` });
      } else if (run.status === "awaiting_human_submit" || run.status === "paused_for_human") {
        sseBroadcast({ type: "run_complete", projectId, message: "Portal staged — verify and submit manually." });
      }
    })
    .catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      sseBroadcast({ type: "run_failed", projectId, message: `Staging failed: ${reason}` });
      logger.warn("prepare-submission", `staging error: ${reason}`, { projectId });
    });
  sseBroadcast({ type: "staging_started", projectId, message: "Staging started — preparing the portal application." });
  res.status(202).json({ jobId: job.id, state: getAutopilotState(db, projectId) });
});

// AUTOPILOT — autonomous run to the approval gate. Start enqueues Segment A (QC →
// build → reviewer-gate → stage) as a background job so it survives HTTP timeouts.
app.post("/api/projects/:id/autopilot/start", (req, res) => {
  const projectId = String(req.params.id);
  const rawTrack = String(req.body?.track || "").trim();
  const track = SUBMITTAL_TRACK_TYPES.includes(rawTrack as SubmittalTrackType) ? rawTrack : undefined;
  // DEDUPE: an autopilot job may already be queued (createProject auto-start or
  // an auto-resume). Two queued Segment A jobs would stage the same project
  // TWICE against a live portal — return the in-flight job instead.
  const pendingAutopilot = db.get<{ id?: string }>(
    "SELECT id FROM job_queue WHERE project_id = ? AND job_type = 'autopilot' AND status IN ('pending','running') LIMIT 1",
    [projectId],
  );
  if (pendingAutopilot?.id) {
    res.status(202).json({ jobId: String(pendingAutopilot.id), state: getAutopilotState(db, projectId), deduped: true });
    return;
  }
  // maxRetries 0: staging drives a live portal and is NOT idempotent portal-side
  // (a timer/orphan re-run could create a duplicate application draft). Failures
  // escalate via job_failed; recovery is the event-driven auto-resume path.
  // origin:"operator" is what makes this chain resumable: maybeResumeAutopilot only
  // relaunches a chain a person started (autopilot.ts autopilotOriginResumable).
  const job = enqueueJob(db, "autopilot", { track, origin: "operator" }, { projectId, priority: 7, maxRetries: 0 });
  // Kick the worker immediately so Segment A starts without waiting for the poll
  // interval. The claim is atomic, so the background worker can't double-process
  // it. The outcome broadcast happens in the job handler (jobQueue.ts) so every
  // path — route kick, worker drain, auto-start, auto-resume — announces it.
  processNextJob(db)
    .catch((err) => logger.warn("autopilot", `segment A error: ${err instanceof Error ? err.message : String(err)}`));
  sseBroadcast({ type: "autopilot_started", projectId, message: "Autopilot started — running QC, build, reviewer gate, and staging." });
  res.status(202).json({ jobId: job.id, state: getAutopilotState(db, projectId) });
});

// The single regulatory-submission gate. Auth-gated and audit-logged with the
// approver's identity. Only a staged (awaiting_human_submit), blocker-free project
// can be approved.
app.post("/api/projects/:id/autopilot/approve", asyncHandler(async (req, res) => {
  const projectId = String(req.params.id);
  const rawTrack = String(req.body?.track || "").trim();
  const track = SUBMITTAL_TRACK_TYPES.includes(rawTrack as SubmittalTrackType) ? (rawTrack as SubmittalTrackType) : undefined;
  const user = currentUser(db, req);
  // When auth is ON, the audit trail's approver MUST be the authenticated session identity —
  // never a body-supplied name (which would let the caller forge who authorized a real filing).
  // When auth is OFF there is no identity, so fall back to the body/"dashboard" label.
  if (AUTH_ENABLED && !user) throw new HttpError(401, "Sign in to approve a submission.");
  const approverName = AUTH_ENABLED
    ? (user?.name || "authenticated user")
    : (String(req.body?.approverName || "").trim() || "dashboard");
  const state = await runAutopilotApproval(db, projectId, { approverUserId: user?.id ?? null, approverName, track });
  if (state.phase === "submitted") {
    sseBroadcast({ type: "run_complete", projectId, message: "Approved & submitted — confirmation captured." });
  } else {
    sseBroadcast({ type: "run_complete", projectId, message: "Approval recorded — complete the final submit in the portal." });
  }
  res.json({ state });
}));

app.get("/api/projects/:id/autopilot", (req, res) => {
  res.json({ state: getAutopilotState(db, String(req.params.id)) });
});

app.post("/api/projects/:id/human-verify", (req, res) => {
  const reviewItemId = String(req.body?.reviewItemId || "").trim();
  const action = String(req.body?.action || "").trim();
  if (!reviewItemId) throw new HttpError(400, "reviewItemId is required.");
  if (!["approve", "edit", "reject"].includes(action)) throw new HttpError(400, "action must be approve, edit, or reject.");
  const verifyResult = humanVerify(db, req.params.id, {
    reviewItemId,
    action: action as "approve" | "edit" | "reject",
    fieldValue: req.body?.fieldValue,
    notes: req.body?.notes,
  });
  maybeResumeAutopilot(db, String(req.params.id), "a human review item was verified"); // may unblock QC
  // humanVerify re-runs QC, so a verified item can carry a project to qc_passed. /qc already
  // continues the chain from wherever QC leaves it; this door did not, so the last verified
  // item passed QC and then nothing built. Deduped, and a no-op at any status the chain skips.
  try { enqueueStageSteps(db, String(req.params.id)); } catch { /* convenience, never the verify */ }
  res.json(verifyResult);
});

// Equipment-spec auto-fill: look up the inverter's rated output from its model
// (datasheet knowledge first, web search fallback), derive a suggested PV breaker,
// and pre-fill the pending inverterOutput / pvBreaker review items for human approval.
app.post("/api/projects/:id/autofill-specs", asyncHandler(async (req, res) => {
  const detail = getProjectDetail(db, String(req.params.id));
  const snap = (detail.project.parserSnapshot || {}) as Record<string, unknown>;
  // Projects parsed before the API key was configured (stub mode) have an empty
  // invModel — let the operator type the model/qty inline instead of hitting a
  // dead 400. An explicit override always wins over the snapshot.
  const bodyModel = String((req.body as Record<string, unknown>)?.modelOverride || "").trim();
  const bodyQty = Number((req.body as Record<string, unknown>)?.qtyOverride || 0);
  const model = bodyModel || String(snap.invModel || snap.pvMicroModel || "").trim();
  const qtyRaw = bodyQty > 0 ? bodyQty : Number(snap.invQty || snap.pvMicroQty || 0);
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : undefined;
  if (!model) throw new HttpError(400, "No inverter model found. Type the inverter/microinverter model in the field above the button, then try Auto-fill again.");

  const { createLLMProvider } = await import("./llm");
  const llm = createLLMProvider();
  // Pass the AC nameplate + service voltage so the lookup can derive the continuous
  // output current when the model/part number can't be resolved (the AC nameplate IS
  // the inverter's continuous output) — this is what unblocks Tesla part numbers etc.
  const acNameplateKw = detail.project.systemSizeAcKw != null && Number(detail.project.systemSizeAcKw) > 0
    ? Number(detail.project.systemSizeAcKw)
    : undefined;
  const voltageRaw = String(snap.voltage || "").replace(/[^0-9.]/g, "");
  const serviceVoltageV = voltageRaw && Number(voltageRaw) > 0 ? Number(voltageRaw) : undefined;
  let spec;
  try {
    spec = await llm.lookupInverterSpec({ inverterModel: model, inverterQty: qty, acNameplateKw, serviceVoltageV });
  } catch (err) {
    throw normalizeLlmError(err);
  }
  const suggestions: Record<string, string> = {};
  // The "Inverter output (A)" review item wants the SYSTEM TOTAL current used for
  // PV-breaker sizing — for microinverters that's per-unit × qty. totalContinuousCurrentA
  // already equals the per-unit value for a single string inverter (qty 1), so it's
  // correct in both cases. Fall back to per-unit only if the total wasn't computed.
  const inverterOutputA = spec.totalContinuousCurrentA ?? spec.outputCurrentA;
  if (inverterOutputA != null) suggestions.inverterOutput = String(inverterOutputA);
  if (spec.derivedPvBreakerA != null) suggestions.pvBreaker = String(spec.derivedPvBreakerA);
  const applied = Object.keys(suggestions).length ? suggestReviewValues(db, String(req.params.id), suggestions) : 0;
  res.json({ spec, suggestions, applied, detail: getProjectDetail(db, String(req.params.id)) });
}));

app.post("/api/portal-runs/:id/capture-confirmation", (req, res) => {
  res.json(captureConfirmation(db, req.params.id, req.body || {}));
});

// The HUMAN's record that a reopened correction form was actually resubmitted in the portal.
// Closes the corrections it answers (the single closer, resolveOpenCorrectionsOnResubmit),
// returns the project to `submitted`, and pulls the filing's tracking check forward.
//
// Rule 1: automation NEVER clicks the portal's resubmit and never asserts that a person did —
// the reopen stops at the review screen and this route exists because only the operator can
// say what happened next. Nothing but the dashboard button calls it.
//
// Scope: /api/portal-runs/:id, so it inherits the child scope guard registered at :372 (a
// foreign tenant's run 404s, never 403s) and sits behind the same deny-by-default
// entitlementGate as its capture-confirmation sibling — no new top-level path.
app.post("/api/portal-runs/:id/mark-resubmitted", (req, res) => {
  res.json(markCorrectionResubmitted(db, String(req.params.id), req.body || {}));
});

// Save a public AHJ portal tracking URL (no login required) for a portal run or
// permit check target. Operators paste the CapDetail / record-detail URL after
// submission so the system can surface it for unauthenticated status checks.
// Serve the auto-captured review-page screenshot for a portal run (or auto-learn recipe).
app.get("/api/projects/:id/portal-runs/:runId/review-screenshot", (req, res) => {
  const projectId = String(req.params.id);
  const runId = String(req.params.runId);
  // Check portal_runs first (for recipe-replay runs that generate portal_run records).
  const run = db.get<{ screenshots_path: string; project_id: string }>(
    "SELECT screenshots_path, project_id FROM portal_runs WHERE id = ?",
    [runId],
  );
  if (run && run.project_id === projectId && run.screenshots_path && fs.existsSync(run.screenshots_path)) {
    res.setHeader("Content-Type", "image/png");
    res.sendFile(run.screenshots_path);
    return;
  }
  // Fall back to portal_recipes (auto-learn stores recipe id; screenshot path in notes).
  const recipe = db.get<{ notes: string; ahj: string; utility: string }>(
    "SELECT notes, ahj, utility FROM portal_recipes WHERE id = ?",
    [runId],
  );
  if (recipe) {
    const match = recipe.notes.match(/\[screenshot:([^\]]+)\]/);
    if (match) {
      const screenshotPath = match[1];
      if (fs.existsSync(screenshotPath)) {
        res.setHeader("Content-Type", "image/png");
        res.sendFile(screenshotPath);
        return;
      }
    }
  }
  res.status(404).json({ error: "No review screenshot available." });
});

// ---------------------------------------------------------------------------
// Learn-run debug bundles — one folder per auto-learn run under data/learn-runs/<runId>:
// run.json manifest, events.jsonl timeline, per-page plan sidecars + screenshots,
// Playwright trace.zip, llm-calls.json, verdict.json, result.json, review.png.
// These two endpoints are the troubleshooting handoff: list the runs, download one
// zipped, and paste/send the zip when asking for help with a failed learn.
// ---------------------------------------------------------------------------
const learnRunsBase = (): string =>
  process.env.AUTOLEARN_RUN_DIR ? path.resolve(process.env.AUTOLEARN_RUN_DIR) : path.resolve(process.cwd(), "data", "learn-runs");
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

app.get("/api/learn-runs", (req, res) => {
  requireAdmin(req); // portal debug bundles: operator artifacts, not tenant rows
  const base = learnRunsBase();
  let names: string[] = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse(); // newest first — runIds start with the timestamp
  } catch { names = []; }
  const runs = names.map((name) => {
    let manifest: Record<string, unknown> = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(base, name, "run.json"), "utf8")) as Record<string, unknown>; } catch { /* partial/legacy run */ }
    return { runId: name, ...manifest };
  });
  res.json({ runs, note: "Download a bundle at /api/learn-runs/<runId>/bundle.zip ('latest' works too) and send it when reporting a learn problem." });
});

app.get("/api/learn-runs/:runId/bundle.zip", asyncHandler(async (req, res) => {
  requireAdmin(req); // portal debug bundles: operator artifacts, not tenant rows
  const base = learnRunsBase();
  let runId = String(req.params.runId);
  if (runId === "latest") {
    try {
      const names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
      runId = names[names.length - 1] || "";
    } catch { runId = ""; }
  }
  // Strict id charset + existence check — never resolves outside data/learn-runs.
  if (!runId || !SAFE_RUN_ID.test(runId)) throw new HttpError(404, "Unknown learn run.");
  const dir = path.join(base, runId);
  if (!fs.existsSync(path.join(dir, "run.json"))) throw new HttpError(404, "Unknown learn run.");
  const { default: AdmZip } = await import("adm-zip");
  const zip = new AdmZip();
  zip.addLocalFolder(dir, runId);
  const buf = zip.toBuffer();
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="learn-run-${runId}.zip"`);
  res.send(buf);
}));

app.put("/api/portal-runs/:id/tracking-url", (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) throw new HttpError(400, "url is required.");
  db.run(
    "UPDATE portal_runs SET tracking_url = ? WHERE id = ?",
    [url, String(req.params.id)],
  );
  res.json({ ok: true, trackingUrl: url });
});

// Per-permit submittal tracks — NEM + building/electrical (or combo), each tracked
// independently through to issuance.
app.get("/api/projects/:id/submittal-tracks", (req, res) => {
  const detail = getProjectDetail(db, String(req.params.id));
  res.json({ tracks: getSubmittalTracks(db, detail.project) });
});

const SUBMITTAL_TRACK_TYPES: SubmittalTrackType[] = ["nem", "building", "electrical", "combo", "permit", "mpu"];
app.post("/api/projects/:id/submittal-tracks/:type/mark-submitted", asyncHandler(async (req, res) => {
  const type = String(req.params.type) as SubmittalTrackType;
  if (!SUBMITTAL_TRACK_TYPES.includes(type)) throw new HttpError(400, "Unknown submittal track type.");
  const detail = getProjectDetail(db, String(req.params.id));
  const b = req.body || {};
  markTrackSubmitted(db, detail.project, type, {
    applicationNumber: b.applicationNumber ? String(b.applicationNumber) : undefined,
    permitNumber: b.permitNumber ? String(b.permitNumber) : undefined,
    confirmationNumber: b.confirmationNumber ? String(b.confirmationNumber) : undefined,
    trackingUrl: b.trackingUrl ? String(b.trackingUrl) : undefined,
    submittedBy: b.submittedBy ? String(b.submittedBy) : undefined,
    notes: b.notes ? String(b.notes) : undefined,
    // Blank means today, which is the same-sitting case. Supplied means the filing really went
    // in on that day and is being recorded later — the client's review clock runs from it.
    submittedAt: b.submittedAt ? String(b.submittedAt) : undefined,
  });
  // The operator just SUBMITTED this track by hand from the staged review browser — that
  // manual submit is the strongest verification the captured fill works. If the track's
  // recipe is still a draft "recording" (auto-learn left it pending human verification),
  // promote it to a replayable "complete" and close the left-open review browser.
  try {
    const scoped = type === "nem"
      ? { scopeType: "utility" as const, state: detail.project.state, utility: detail.project.utility }
      : { scopeType: "ahj" as const, state: detail.project.state, ahj: detail.project.ahj, utility: detail.project.utility };
    const draft = findAnyRecipeForProject(db, scoped);
    if (draft) {
      // Eligibility-guarded (reached-review) promotion — a paused/partial or stale
      // abandoned recording must NOT be silently promoted by an unrelated manual submit.
      promoteRecordingIfEligible(db, draft.id, {
        finishedBy: b.submittedBy ? String(b.submittedBy) : "operator (marked track submitted)",
        via: "mark_submitted",
        projectId: detail.project.id,
      });
    }
    if (detail.project.clientId) {
      // Track-scoped close: marking the NEM track submitted must not destroy the permit
      // track's still-open review browser (or vice versa). Fire-and-forget.
      closeReviewBrowsers(detail.project.clientId, type === "nem" ? "utility" : "ahj");
    }
  } catch { /* promotion/close are best-effort — marking submitted must never fail on them */ }
  res.status(201).json({ ok: true, tracks: getSubmittalTracks(db, getProjectDetail(db, String(req.params.id)).project) });
}));

app.get("/parser", (_req, res) => {
  res.sendFile(path.join(frontendDir, "parser.html"));
});

// Friendly aliases so a new hire can land on the dashboard at "/" or "/dashboard".
app.get("/new-project", (_req, res) => {
  res.sendFile(path.join(frontendDir, "new-project.html"));
});

app.get("/fill-form", (_req, res) => {
  res.sendFile(path.join(frontendDir, "fill-form.html"));
});

// Standalone form-filler tool (upload any form, place values, download filled).
app.get("/tools/form-filler", (_req, res) => {
  res.sendFile(path.join(frontendDir, "form-filler.html"));
});

app.get(["/", "/dashboard"], (_req, res) => {
  res.sendFile(path.join(frontendDir, "dashboard.html"));
});

app.use((_req, _res, next) => {
  next(new HttpError(404, "Route not found."));
});

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const bodyParserStatus = typeof (err as { status?: unknown })?.status === "number" ? Number((err as { status: number }).status) : null;
  const bodyParserType = String((err as { type?: unknown })?.type || "");
  const httpError =
    err instanceof HttpError
      ? err
      : bodyParserStatus === 413 || bodyParserType === "entity.too.large"
        ? new HttpError(413, `Upload is too large. For a big .zip of project PDFs, raise BATCH_ZIP_LIMIT in your .env (default 2gb) or unzip it locally and use the "Scan Folder" path instead. For a big .mbox file, paste its full local path and click Import Path.`)
        : new HttpError(bodyParserStatus && bodyParserStatus >= 400 && bodyParserStatus < 600 ? bodyParserStatus : 500, err instanceof Error ? err.message : "Unknown error.");
  // 5xx are real bugs — print a copy-pasteable block. 4xx are client errors — one line.
  if (httpError.status >= 500) logErrorBlock("http", err, { route: `${req.method} ${req.path}`, status: httpError.status });
  else logger.warn("http", `${httpError.status} ${req.method} ${req.path}`, { reason: httpError.message });
  // A 5xx whose message was WRITTEN FOR THE OPERATOR (normalizeLlmError: "add credits", "rate-
  // limited", "rejected the API key") reaches the dashboard as written; the generic line stands in
  // only when no safe message exists (an uncaught Error's message may carry a path or a stack).
  const operatorFacing = err instanceof HttpError && httpError.details?.operatorFacing === true;
  res.status(httpError.status).json({
    error: httpError.status >= 500 && !operatorFacing ? "Internal error. Details are in the server log." : httpError.message,
    details: httpError.details,
  });
});

// Crash visibility — never die silently.
process.on("unhandledRejection", (reason) => logErrorBlock("unhandledRejection", reason));
process.on("uncaughtException", (err) => {
  // Log, then EXIT. Swallowing left a zombie process in an unknown state serving
  // real filings; the systemd unit (Restart=always, see SERVER_SETUP) restarts a
  // clean one, and migrations/orphan recovery handle the rest on boot.
  logErrorBlock("uncaughtException", err);
  setTimeout(() => process.exit(1), 250).unref();
});

const server = app.listen(port, process.env.SERVER_HOST || "0.0.0.0", () => {
  const diag = collectDiagnostics(db, { build: BUILD, port, dbPath });
  startupBanner(diag, { base: `http://localhost:${port}` });
  // Exposure warning: app.listen(port) binds all interfaces. With auth OFF that serves all
  // customer PII + the credential/approve endpoints to anyone who can reach the port. Loud
  // warning so an operator doesn't unknowingly expose it; the fix is AUTH_ENABLED=true (and a
  // reverse proxy / firewall), or binding to loopback only.
  if (!AUTH_ENABLED && !["127.0.0.1", "::1", "localhost"].includes(process.env.SERVER_HOST || "")) {
    logger.warn("security", "AUTH_ENABLED is off and the server listens on all interfaces — anyone who can reach this port has full access to customer data and the approve/credential endpoints. Set AUTH_ENABLED=true (with ADMIN_EMAIL/ADMIN_PASSWORD) before exposing it beyond localhost.");
  }
  // Do the concurrency numbers agree? Raising JOB_CONCURRENCY without raising the profile
  // wait arms a permanent-failure mode that no test catches and no portal reports (see
  // concurrencyConfig.ts). Stated at boot, while an operator is still looking.
  for (const warning of checkConcurrencyConfig(readConcurrencyConfig())) {
    logger.warn("concurrency", warning.message);
  }
  // Clear browsers orphaned by a previous crash/deploy BEFORE the worker starts claiming
  // jobs. An orphan still holds its profile's OS lock, so without this the first run for
  // that client+portal fails to launch and stays failing until a human kills the process.
  // Safe here and only here: nothing of ours is in flight at startup.
  // AWAITED, and the worker starts only after it finishes. Fire-and-forget made the comment
  // above a lie: the scan takes seconds, the worker would already be claiming jobs, and the
  // reaper could SIGKILL a browser this very process had just launched — killing a live
  // portal submission and escalating it to a human for nothing. (The reaper also refuses to
  // kill anything younger than this process, so the two guards are belt and braces.)
  if (process.env.BACKGROUND_WORKERS !== "off") void (async () => {
    try {
      const { reapOrphanedProfileBrowsers } = await import("../../portal-bot/src/browser");
      const profileBase = process.env.PORTAL_PROFILES_DIR || path.join(process.cwd(), "portal-profiles");
      const killed = await reapOrphanedProfileBrowsers(profileBase);
      if (killed > 0) logger.warn("portal", `Reaped ${killed} orphaned portal browser(s) left by a previous run — their profiles are free again.`);
    } catch { /* cleanup is best-effort; never block startup */ }
    startJobWorker(db);
  })();
  // A COUNT AT BOOT. The drafts that went unnoticed for twelve days accumulated while the
  // process was already running, so the per-event warning above is the primary channel — but a
  // restart is when somebody is actually looking at the log, and a backlog should greet them.
  try {
    const stranded = undeliveredCommunications(db);
    if (stranded.length) {
      const oldest = stranded[0];
      logger.warn("notify", `${stranded.length} client message(s) were never delivered — oldest ${oldest.occurredAt.slice(0, 10)} "${oldest.subject}". Run: npx tsx scripts/undelivered.ts`);
    }
  } catch { /* never block startup on a report */ }
  if (process.env.BACKGROUND_WORKERS === "off") return;
  startBackupScheduler(db);
  startArtifactRetention();
  startMonitorScheduler(db);
  startAhjFormRefreshScheduler(db);
  startKbLinkCheckScheduler(db);
  startCecSyncScheduler(db);
  primeCecCache(db);
});

// Graceful shutdown so the DB/WAL flushes cleanly on deploy restarts — and so a
// deploy does NOT kill a live portal browser mid-staging: while this process has
// jobs in flight (a staging/learn run driving a real portal), exit is held until
// they finish or the drain window elapses. The window is bounded so a hung run
// can't wedge a deploy forever (systemd's TimeoutStopSec remains the backstop).
const SHUTDOWN_DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS ?? 5 * 60_000);
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) { process.exit(0); } // second signal = operator insists
    shuttingDown = true;
    server.close(() => { /* stop accepting new work; exit is decided below */ });
    const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
    const inFlight = inFlightJobCount();
    if (inFlight > 0) {
      logger.info("server", `${sig} received — draining ${inFlight} in-flight job(s) before exit (up to ${Math.round(SHUTDOWN_DRAIN_MS / 1000)}s; send the signal again to force)`);
    } else {
      logger.info("server", `${sig} received — shutting down`);
    }
    const poll = setInterval(() => {
      if (inFlightJobCount() === 0 || Date.now() >= deadline) {
        if (inFlightJobCount() > 0) logger.warn("server", "drain window elapsed with jobs still in flight — exiting; orphan recovery will escalate them on next boot");
        clearInterval(poll);
        process.exit(0);
      }
    }, 500);
    poll.unref();
    // With nothing in flight this exits on the first poll tick (~500ms).
  });
}
