import "dotenv/config";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./db";
import { HttpError } from "./httpError";
import { collectDiagnostics, logErrorBlock, logger, requestLogger, startupBanner } from "./logger";
import { findLearnedProfileForProject, saveVerifiedAhjProfile, saveVerifiedUtilityProfile } from "./knowledgeBase";
import {
  listPortalRecipes,
  getPortalRecipe,
  startPortalRecording,
  savePortalRecipeSteps,
  markPortalRecipeForRerecord,
  deletePortalRecipe,
  resolveRecipeFieldValues,
} from "./portalRecipes";
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
import { enqueueJob, getJob, listJobs, processNextJob, startJobWorker } from "./jobQueue";
import { createUser, getUserWorkload, listUsers, updateUser, assignProjectToUser } from "./users";
import { listBackups, runBackup, startBackupScheduler } from "./backup";
import { startMonitorScheduler } from "./scheduler";
import { startAhjFormRefreshScheduler } from "./ahjFormRefresh";
import { extractZipToWorkdir } from "./batchZip";
import { AUTH_ENABLED, login, logout, me, requireAuth, seedAdminUser } from "./auth";
import {
  addCommunication,
  createCustomer,
  deleteCustomer,
  getCustomer,
  listCommunications,
  listCustomers,
  updateCustomer,
} from "./crm";
import { getKpiReport, touchProjectMetrics } from "./kpi";
import { classifyDoc, extractPdfText } from "./batchImport";
import {
  ahjFormRegistry,
  buildFilledFormsForProject,
  fetchFormTemplate,
  filledFormPath,
  inspectFormFields,
  matchingForms,
} from "./ahjForms";
import { acquireFromBytes, ensureAhjFormTemplate } from "./ahjFormAuto";
import { createSignature, deleteSignature, getSignatureImage, listSignatures, setDefaultSignature } from "./signatures";
import { addAuditLog } from "./audit";
import { buildAuthUrl, exchangeCodeForTokens, gmailStatus, pollGmail } from "./gmail";
import { imapStatus, pollImap, upsertImapSource } from "./emailPoller";
import { createIntakeRequest, getIntakeRequestPublic, missingIntakeFields, submitIntakeRequest } from "./intakeRequests";
import { ensureHeartbeat, sseBroadcast, sseSubscribe } from "./events";
import { detectPlatform, publicPermitStatusCheck } from "./publicPermitStatus";
import {
  addManualCorrection,
  draftLatestCorrectionResponse,
  listOverdueCorrections,
  setCorrectionsSlaDays,
  addProjectNote,
  assignProjectClient,
  captureConfirmation,
  createPermitCheckTarget,
  createProject,
  updateProject,
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
  getOperationsBoard,
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
} from "./repository";
import { getSubmittalTracks, markTrackSubmitted } from "./submittalTracks";
import type { SubmittalTrackType } from "../../shared/src/types";

const app = express();
const db = await openDatabase();
const frontendDir = path.resolve(process.cwd(), "frontend");
const port = Number(process.env.PORT || 4173);
const APP_VERSION = "0.1.0-beta";
const dbPath = path.resolve(process.cwd(), process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite");

const asyncHandler =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };

// Turn raw Anthropic SDK errors into clean, actionable messages for the UI.
function normalizeLlmError(err: unknown): HttpError {
  const status = (err as { status?: number })?.status;
  const raw = (err as { message?: string })?.message || String(err);
  if (status === 401 || /authentication_error|invalid x-api-key/i.test(raw)) {
    return new HttpError(502, "Claude rejected the API key (401). Set a valid, active ANTHROPIC_API_KEY in your .env (it must start with 'sk-ant-'). A placeholder or expired key will be rejected — AI-assist stays off and the parser uses regex/OCR only.");
  }
  if (status === 429 || /rate_limit/i.test(raw)) {
    return new HttpError(502, "Claude is rate-limited (429). Wait a moment and try again.");
  }
  if (/credit|billing|insufficient|quota/i.test(raw)) {
    return new HttpError(502, "Claude rejected the request: your Anthropic account has no credit/billing. The API key is valid, but you must add credits at console.anthropic.com → Settings → Billing before AI-assist can run. Until then the parser uses regex/OCR only.");
  }
  return new HttpError(502, `AI-assist failed: ${raw.slice(0, 200)}`);
}

app.use(cors());
app.use(requestLogger);
app.use(express.json({ limit: "80mb" }));
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
app.post("/api/auth/login", (req, res) => login(db, req, res));
app.post("/api/auth/logout", (req, res) => logout(req, res));
app.get("/api/auth/me", (req, res) => me(db, req, res));
app.get("/login", (_req, res) => res.sendFile(path.join(frontendDir, "login.html")));
// Public client intake page (tokenized, no login) — served before the auth gate.
app.get("/intake", (_req, res) => res.sendFile(path.join(frontendDir, "intake.html")));
app.use(requireAuth(db));

app.use(express.static(frontendDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "Solar Submission Autopilot", version: APP_VERSION });
});

// Full runtime diagnostics — paste this output to troubleshoot. No secrets/PII.
app.get("/api/diagnostics", (_req, res) => {
  res.json(collectDiagnostics(db, { version: APP_VERSION, port, dbPath }));
});

app.post("/api/projects", (req, res) => {
  const payload = req.body?.parserPayload ?? req.body?.payload ?? req.body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "Project payload must be an object.");
  }
  res.status(201).json(createProject(db, payload));
});

app.put("/api/projects/:id", (req, res) => {
  const payload = req.body?.parserPayload ?? req.body?.payload ?? req.body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "Project payload must be an object.");
  }
  res.json(updateProject(db, String(req.params.id), payload));
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
  res.json(getProjectList(db, { limit, offset, search, status, userId, clientId, sort: sortVal }));
});

// --- Clients (contractor profiles + licensing) ---
app.get("/api/clients", (_req, res) => {
  res.json({ clients: listClients(db) });
});

app.get("/api/clients/:id", (req, res) => {
  res.json(getClient(db, String(req.params.id)));
});

app.post("/api/clients", (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  res.status(201).json(createClient(db, payload));
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
  res.json(assignProjectClient(db, String(req.params.id), clientId));
});

// --- Per-client portal credentials (encrypted; plaintext never returned) ---
app.get("/api/clients/:id/portal-credentials", (req, res) => {
  res.json({ credentials: listPortalCredentials(db, String(req.params.id)) });
});
app.post("/api/clients/:id/portal-credentials", (req, res) => {
  res.status(201).json(createPortalCredential(db, String(req.params.id), req.body || {}));
});
app.put("/api/clients/:id/portal-credentials/:credId", (req, res) => {
  res.json(updatePortalCredential(db, String(req.params.id), String(req.params.credId), req.body || {}));
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
  const file = filledFormPath(String(req.params.id), String(req.params.formId));
  if (!fs.existsSync(file)) throw new HttpError(404, "Filled form not found. Build it first.");
  res.type("application/pdf").sendFile(file);
});

// Auto-acquire the AHJ's official permit PDF (web research → download → field
// map → store), then re-fill. Falls back to "upload the blank PDF" when no form
// is found. This is the deliberate, opt-in step behind the "Find official form
// (AI)" button so the web search cost is only paid on demand.
app.post("/api/projects/:id/find-ahj-form", asyncHandler(async (req, res) => {
  const detail = getProjectDetail(db, String(req.params.id));
  const formType = String(req.body?.formType || "permit_application").trim() || "permit_application";
  const { createLLMProvider } = await import("./llm");
  const llm = createLLMProvider();
  let ensure;
  try {
    ensure = await ensureAhjFormTemplate(db, llm, detail.project, formType);
  } catch (err) {
    throw normalizeLlmError(err);
  }
  addAuditLog(db, String(req.params.id), "system", "ahj form acquisition", "ahj_form.find", { status: ensure.status, formName: ensure.formName || "", ahj: detail.project.ahj, permitType: ensure.permitType || "" });
  const filled = await buildFilledFormsForProject(db, detail.project);
  res.json({ ensure, filled });
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

// Operator: which submittal fields are still missing for a project.
app.get("/api/projects/:id/intake-missing", (req, res) => {
  res.json({ missing: missingIntakeFields(db, String(req.params.id)) });
});

// Operator: create (or reuse) a shareable intake link for a project.
app.post("/api/projects/:id/intake-request", asyncHandler(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = createIntakeRequest(db, String(req.params.id), {
    fields: Array.isArray(b.fields) ? (b.fields as ("jobValue" | "homeownerEmail" | "homeownerPhone")[]) : undefined,
    createdBy: typeof b.createdBy === "string" ? b.createdBy : undefined,
    expiresInDays: typeof b.expiresInDays === "number" ? b.expiresInDays : 30,
  });
  // Absolute URL so the operator can copy/paste it straight into an email.
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({ ...result, url: `${base}${result.path}` });
}));

// Public (no auth): read an intake request by token.
app.get("/api/intake/:token", asyncHandler(async (req, res) => {
  res.json(getIntakeRequestPublic(db, String(req.params.token)));
}));

// Public (no auth): submit answers for an intake request.
app.post("/api/intake/:token", asyncHandler(async (req, res) => {
  const result = submitIntakeRequest(db, String(req.params.token), (req.body ?? {}) as Record<string, unknown>);
  sseBroadcast({ type: "email_matched", projectId: result.projectId, message: "Client submitted intake details — valuation/contact updated." });
  res.json(result);
}));

// --- Server-Sent Events (live background notifications) ---
// Frontend subscribes here to receive typed events: correction_received,
// permit_issued, nem_approved, run_paused, run_failed, etc. No sensitive data.
app.get("/api/events", (req, res) => {
  sseSubscribe(res);
  ensureHeartbeat();
});

app.get("/api/ops-board", (_req, res) => {
  res.json(getOperationsBoard(db));
});

app.get("/api/ops-actions", (_req, res) => {
  res.json(getOperationsActionQueue(db));
});

app.get("/api/ops-report", (_req, res) => {
  res.json(getOperationsDailyReport(db));
});

app.get("/api/knowledge-base", (_req, res) => {
  res.json(getKnowledgeBase(db));
});

app.get("/api/email-tracker", (_req, res) => {
  res.json(getEmailTrackerStatus(db));
});

app.post("/api/email-tracker/sources", (req, res) => {
  res.status(201).json(configureEmailTrackingSource(db, req.body || {}));
});

app.post("/api/email-tracker/run", asyncHandler(async (req, res) => {
  res.json(await runEmailTracker(db, req.body || {}));
}));

app.post("/api/knowledge-base/import-mbox", asyncHandler(async (req, res) => {
  const mboxText = String(req.body?.mboxText || "");
  if (!mboxText.trim()) throw new HttpError(400, "mboxText is required.");
  res.status(201).json(
    await importKnowledgeFromMbox(db, {
      mboxText,
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
  if (!fs.existsSync(resolved)) throw new HttpError(404, `MBOX file path was not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new HttpError(400, "MBOX path must point to a file.");
  // Streamed line-by-line from disk — no size cap; multi-GB exports are fine.
  res.status(201).json(
    await importKnowledgeFromMboxFile(db, {
      filePath: resolved,
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
  res.json(runProjectWorkflow(db, req.params.id));
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
  res.json(rerunQc(db, req.params.id));
});

app.get("/api/corrections/overdue", (_req, res) => {
  res.json(listOverdueCorrections(db));
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
  // Generate the advisory AI draft reply (human reviews before sending).
  res.status(201).json(await draftLatestCorrectionResponse(db, String(req.params.id), correctionText));
}));

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
app.post("/api/portal-recipes/:id/rerecord", (req, res) => {
  res.json(markPortalRecipeForRerecord(db, String(req.params.id)));
});
app.delete("/api/portal-recipes/:id", (req, res) => {
  res.json(deletePortalRecipe(db, String(req.params.id)));
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

app.post("/api/projects/:id/permit-checks", asyncHandler(async (req, res) => {
  res.status(201).json(await recordPermitStatusCheck(db, String(req.params.id), req.body || {}));
}));

app.post("/api/permit-monitor/run", asyncHandler(async (req, res) => {
  const targetType = req.body?.targetType || "all";
  res.json(await runDuePermitChecks(db, targetType));
}));

app.post("/api/nem-monitor/run", asyncHandler(async (_req, res) => {
  res.json(await runDuePermitChecks(db, "nem"));
}));

// Detect portal platform from a URL (called as the operator pastes a portal URL
// into the permit target form — shows them what strategy will be used).
app.get("/api/permit-status/detect-platform", (req, res) => {
  const url = String(req.query.url || "");
  if (!url) { res.status(400).json({ error: "url query param required" }); return; }
  res.json({ platform: detectPlatform(url), url });
});

// Ad-hoc public status check for a single target: useful for "check now" button.
app.post("/api/permit-status/public-check", asyncHandler(async (req, res) => {
  const { portalUrl, applicationNumbers } = req.body || {};
  if (!portalUrl) throw new HttpError(400, "portalUrl is required.");
  const result = await publicPermitStatusCheck(String(portalUrl), Array.isArray(applicationNumbers) ? applicationNumbers : []);
  res.json({ platform: detectPlatform(String(portalUrl)), rawStatusText: result });
}));

// Users
app.get("/api/users", (_req, res) => { res.json(listUsers(db)); });
app.post("/api/users", (req, res) => {
  if (!req.body?.name || !req.body?.email) throw new HttpError(400, "name and email are required.");
  res.status(201).json(createUser(db, req.body));
});
app.put("/api/users/:id", (req, res) => {
  res.json(updateUser(db, req.params.id, req.body || {}));
});
app.get("/api/users/workload", (_req, res) => { res.json(getUserWorkload(db)); });
app.post("/api/projects/:id/assign", (req, res) => {
  assignProjectToUser(db, req.params.id, req.body?.userId || null);
  res.json({ ok: true });
});

// Customers / leads
app.get("/api/customers", (req, res) => {
  res.json(listCustomers(db, { stage: req.query.stage ? String(req.query.stage) : undefined, search: req.query.search ? String(req.query.search) : undefined }));
});
app.get("/api/customers/:id", (req, res) => {
  const customer = getCustomer(db, req.params.id);
  if (!customer) throw new HttpError(404, "Customer not found.");
  res.json(customer);
});
app.post("/api/customers", (req, res) => {
  if (!req.body?.name && !req.body?.email && !req.body?.phone) throw new HttpError(400, "A name, email, or phone is required.");
  res.status(201).json(createCustomer(db, req.body || {}));
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
  res.status(201).json(addCommunication(db, req.body || {}));
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
    res.status(201).json(saveProjectDocument(db, String(req.params.id), { filename, docType, contentType, buffer: req.body, source: "upload" }));
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
  res.status(201).json(await buildUtilityPackage(db, String(req.params.id), target));
}));

// Backups (manual trigger + list; a scheduled snapshot also runs automatically)
app.post("/api/admin/backup", (_req, res) => {
  res.json(runBackup(db));
});
app.get("/api/admin/backups", (_req, res) => {
  res.json(listBackups());
});

// KPIs
app.get("/api/kpi", (req, res) => {
  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
  res.json(getKpiReport(db, { startDate, endDate }));
});
app.post("/api/projects/:id/metrics/refresh", (req, res) => {
  touchProjectMetrics(db, req.params.id);
  res.json({ ok: true });
});

// Job queue
app.get("/api/jobs", (req, res) => {
  res.json(listJobs(db, {
    status: req.query.status as string | undefined as any,
    jobType: req.query.jobType as string | undefined as any,
    limit: req.query.limit ? Number(req.query.limit) : 100,
  }));
});
app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(db, req.params.id);
  if (!job) throw new HttpError(404, "Job not found.");
  res.json(job);
});
app.post("/api/jobs", (req, res) => {
  const { jobType, payload, priority, assignedToUser, projectId, scheduledAt } = req.body || {};
  if (!jobType) throw new HttpError(400, "jobType is required.");
  res.status(201).json(enqueueJob(db, jobType, payload || {}, { priority, assignedToUser, projectId, scheduledAt }));
});
app.post("/api/jobs/process-next", asyncHandler(async (_req, res) => {
  const processed = await processNextJob(db);
  res.json({ processed });
}));

// MBOX streaming import via job queue (for large files)
app.post("/api/mbox/enqueue", (req, res) => {
  const { filePath, sourceLabel, defaultState, defaultAhj, defaultUtility } = req.body || {};
  if (!filePath) throw new HttpError(400, "filePath is required.");
  const job = enqueueJob(db, "mbox_import", { filePath, sourceLabel, defaultState, defaultAhj, defaultUtility }, { priority: 3, maxRetries: 1 });
  res.status(201).json(job);
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
app.get("/api/signatures", (_req, res) => {
  res.json({ signatures: listSignatures(db) });
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
    const view = await createSignature(db, { role, name, bytes: new Uint8Array(req.body), mime, isDefault });
    res.status(201).json(view);
  }),
);

app.patch("/api/signatures/:id/default", (req, res) => {
  setDefaultSignature(db, String(req.params.id));
  res.json({ ok: true });
});

app.delete("/api/signatures/:id", (req, res) => {
  deleteSignature(db, String(req.params.id));
  res.json({ deleted: true });
});

app.get("/api/signatures/:id/image", (req, res) => {
  const img = getSignatureImage(db, String(req.params.id));
  res.setHeader("Content-Type", img.mime);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(img.bytes);
});

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
  const rows = state
    ? db.query("SELECT id, ahj_name, state, form_type, original_filename, field_map, created_at FROM ahj_form_templates WHERE state = ? ORDER BY ahj_name", [state])
    : db.query("SELECT id, ahj_name, state, form_type, original_filename, field_map, created_at FROM ahj_form_templates ORDER BY state, ahj_name");
  res.json(rows.map((r) => ({ ...r, fieldMap: JSON.parse(String(r.field_map || "{}")) })));
});

// Re-map a stored template's fields from its stored blob (AcroForm first, then
// vision overlay) — used after a bad auto-map or to refresh the mapping.
app.post("/api/ahj-templates/:id/remap", asyncHandler(async (req, res) => {
  const row = db.get<{ id: string; ahj_name: string; state: string; form_type: string; pdf_blob: Buffer | null; field_map: string }>(
    "SELECT id, ahj_name, state, form_type, pdf_blob, field_map FROM ahj_form_templates WHERE id = ?",
    [String(req.params.id)],
  );
  if (!row) throw new HttpError(404, "Template not found.");
  if (!row.pdf_blob) throw new HttpError(410, "PDF blob has been wiped — re-upload the blank to re-map.");
  let map: { formName?: string; sourceUrl?: string } = {};
  try { map = JSON.parse(row.field_map || "{}"); } catch { /* ignore */ }
  const formName = map.formName || `${row.ahj_name} ${row.form_type.replace(/_/g, " ")}`;
  const { createLLMProvider } = await import("./llm");
  let result;
  try {
    result = await acquireFromBytes(db, createLLMProvider(), {
      ahj: row.ahj_name, state: row.state, formType: row.form_type, formName,
      bytes: new Uint8Array(row.pdf_blob), sourceUrl: map.sourceUrl || "",
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
  let map: Record<string, unknown> = {};
  try { map = JSON.parse(row.field_map || "{}"); } catch { map = {}; }
  const verified = req.body?.verified !== false; // default true
  map.verified = verified;
  map.verifiedAt = verified ? new Date().toISOString() : undefined;
  db.run("UPDATE ahj_form_templates SET field_map = ?, updated_at = ? WHERE id = ?", [JSON.stringify(map), new Date().toISOString(), String(req.params.id)]);
  res.json({ id: String(req.params.id), verified });
});

// Fully delete a stored template (blob + map).
app.delete("/api/ahj-templates/:id", (req, res) => {
  const row = db.get<{ id: string }>("SELECT id FROM ahj_form_templates WHERE id = ?", [String(req.params.id)]);
  if (!row) throw new HttpError(404, "Template not found.");
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

// Synthesize AHJ knowledge from past project history using Claude
app.post("/api/knowledge-base/synthesize-ahj", asyncHandler(async (req, res) => {
  const { ahjName, state, utility } = req.body || {};
  if (!ahjName) throw new HttpError(400, "ahjName required.");

  // Pull correction patterns and application texts for this AHJ
  const corrRows = db.query<{ correction_text: string }>(
    `SELECT DISTINCT c.correction_text FROM corrections c
     JOIN projects p ON p.id = c.project_id
     WHERE p.ahj LIKE ? AND (? = '' OR p.state = ?)
     ORDER BY c.created_at DESC LIMIT 50`,
    [`%${ahjName}%`, state || "", state || ""],
  );
  const noteRows = db.query<{ body: string }>(
    `SELECT pn.body FROM project_notes pn
     JOIN projects p ON p.id = pn.project_id
     WHERE p.ahj LIKE ? AND pn.body LIKE '%application%'
     ORDER BY pn.created_at DESC LIMIT 20`,
    [`%${ahjName}%`],
  );

  const { createLLMProvider } = await import("./llm");
  const llm = createLLMProvider();
  const result = await llm.synthesizeKnowledge({
    ahjName,
    state: state || "",
    utility: utility || "",
    pastApplicationTexts: noteRows.map((r) => r.body),
    correctionPatterns: corrRows.map((r) => r.correction_text),
  });

  // Persist synthesized knowledge into ahj_library
  const existing = db.get<{ id: string }>("SELECT id FROM ahj_library WHERE ahj_name LIKE ? AND state = ?", [`%${ahjName}%`, state || ""]);
  if (existing) {
    db.run(
      "UPDATE ahj_library SET required_documents = ?, known_rejection_patterns = ?, notes = ? WHERE id = ?",
      [result.requiredDocuments.join("; "), result.commonRejectionReasons.join("; "), result.tips.join("; "), existing.id],
    );
  }

  res.json(result);
}));

app.post("/api/batch-import/scan", (req, res) => {
  const { folderPath, defaultState, defaultAhj, defaultUtility, useLlm } = req.body || {};
  if (!folderPath) throw new HttpError(400, "folderPath is required.");
  if (!fs.existsSync(folderPath)) throw new HttpError(404, `Folder not found: ${folderPath}`);
  if (!fs.statSync(folderPath).isDirectory()) throw new HttpError(400, "Path must be a directory.");
  const job = enqueueJob(db, "folder_scan", { folderPath, defaultState, defaultAhj, defaultUtility, useLlm: !!useLlm }, { priority: 2, maxRetries: 1 });
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
      { priority: 2, maxRetries: 1 },
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
  const defaultState = typeof req.body?.defaultState === "string" ? req.body.defaultState : undefined;
  if (!planText.trim() && !utilityBillText.trim() && !meterText.trim()) {
    throw new HttpError(400, "Provide at least one of planText, utilityBillText, or meterText.");
  }
  const { createLLMProvider } = await import("./llm");
  const llm = createLLMProvider();
  try {
    const result = await llm.extractProjectFields({ planText, utilityBillText, meterText, defaultState });
    res.json(result);
  } catch (err) {
    throw normalizeLlmError(err);
  }
}));

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

app.post("/api/projects/:id/prepare-submission", asyncHandler(async (req, res) => {
  // Optional track scopes staging to one filing (nem | building | electrical | combo);
  // omitted = the legacy combined stage.
  const rawTrack = String(req.body?.track || "").trim();
  const track = SUBMITTAL_TRACK_TYPES.includes(rawTrack as SubmittalTrackType) ? (rawTrack as SubmittalTrackType) : undefined;
  const result = await prepareSubmission(db, String(req.params.id), track);
  const run = result.portalRuns?.[0];
  if (run) {
    if (run.pauseReason === "mfa_captcha") {
      sseBroadcast({ type: "run_paused", projectId: String(req.params.id), message: "Portal requires attention — MFA or CAPTCHA detected. Complete it in the browser, then resume.", data: { pauseReason: run.pauseReason } });
    } else if (run.status === "failed") {
      sseBroadcast({ type: "run_failed", projectId: String(req.params.id), message: "Portal run failed — see run log for details." });
    } else if (run.status === "awaiting_human_submit" || run.status === "paused_for_human") {
      sseBroadcast({ type: "run_complete", projectId: String(req.params.id), message: "Portal staged — verify and submit manually." });
    }
  }
  res.json(result);
}));

app.post("/api/projects/:id/human-verify", (req, res) => {
  const reviewItemId = String(req.body?.reviewItemId || "").trim();
  const action = String(req.body?.action || "").trim();
  if (!reviewItemId) throw new HttpError(400, "reviewItemId is required.");
  if (!["approve", "edit", "reject"].includes(action)) throw new HttpError(400, "action must be approve, edit, or reject.");
  res.json(
    humanVerify(db, req.params.id, {
      reviewItemId,
      action: action as "approve" | "edit" | "reject",
      fieldValue: req.body?.fieldValue,
      notes: req.body?.notes,
    }),
  );
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
  let spec;
  try {
    spec = await llm.lookupInverterSpec({ inverterModel: model, inverterQty: qty });
  } catch (err) {
    throw normalizeLlmError(err);
  }
  const suggestions: Record<string, string> = {};
  if (spec.outputCurrentA != null) suggestions.inverterOutput = String(spec.outputCurrentA);
  if (spec.derivedPvBreakerA != null) suggestions.pvBreaker = String(spec.derivedPvBreakerA);
  const applied = Object.keys(suggestions).length ? suggestReviewValues(db, String(req.params.id), suggestions) : 0;
  res.json({ spec, suggestions, applied, detail: getProjectDetail(db, String(req.params.id)) });
}));

app.post("/api/portal-runs/:id/capture-confirmation", (req, res) => {
  res.json(captureConfirmation(db, req.params.id, req.body || {}));
});

// Save a public AHJ portal tracking URL (no login required) for a portal run or
// permit check target. Operators paste the CapDetail / record-detail URL after
// submission so the system can surface it for unauthenticated status checks.
app.put("/api/portal-runs/:id/tracking-url", (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) throw new HttpError(400, "url is required.");
  db.run(
    "UPDATE portal_runs SET tracking_url = ? WHERE id = ?",
    [url, String(req.params.id)],
  );
  res.json({ ok: true, trackingUrl: url });
});

app.put("/api/permit-check-targets/:id/tracking-url", (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) throw new HttpError(400, "url is required.");
  db.run(
    "UPDATE permit_check_targets SET tracking_url = ?, updated_at = ? WHERE id = ?",
    [url, new Date().toISOString(), String(req.params.id)],
  );
  res.json({ ok: true, trackingUrl: url });
});

// Per-permit submittal tracks — NEM + building/electrical (or combo), each tracked
// independently through to issuance.
app.get("/api/projects/:id/submittal-tracks", (req, res) => {
  const detail = getProjectDetail(db, String(req.params.id));
  res.json({ tracks: getSubmittalTracks(db, detail.project) });
});

const SUBMITTAL_TRACK_TYPES: SubmittalTrackType[] = ["nem", "building", "electrical", "combo", "permit"];
app.post("/api/projects/:id/submittal-tracks/:type/mark-submitted", (req, res) => {
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
  });
  res.status(201).json({ ok: true, tracks: getSubmittalTracks(db, getProjectDetail(db, String(req.params.id)).project) });
});

app.get("/parser", (_req, res) => {
  res.sendFile(path.join(frontendDir, "parser.html"));
});

// Friendly aliases so a new hire can land on the dashboard at "/" or "/dashboard".
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
  res.status(httpError.status).json({
    error: httpError.message,
    details: httpError.details,
  });
});

// Crash visibility — never die silently.
process.on("unhandledRejection", (reason) => logErrorBlock("unhandledRejection", reason));
process.on("uncaughtException", (err) => logErrorBlock("uncaughtException", err));

const server = app.listen(port, () => {
  const diag = collectDiagnostics(db, { version: APP_VERSION, port, dbPath });
  startupBanner(diag, { base: `http://localhost:${port}` });
  startJobWorker(db);
  startBackupScheduler(db);
  startMonitorScheduler(db);
  startAhjFormRefreshScheduler(db);
});

// Graceful shutdown so the DB/WAL flushes cleanly on deploy restarts.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info("server", `${sig} received — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
