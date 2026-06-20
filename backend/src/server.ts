import "dotenv/config";
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./db";
import { HttpError } from "./httpError";
import { createClient, deleteClient, getClient, listClients, updateClient } from "./clients";
import { enqueueJob, getJob, listJobs, processNextJob, startJobWorker } from "./jobQueue";
import { createUser, getUserWorkload, listUsers, updateUser, assignProjectToUser } from "./users";
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
import { buildAuthUrl, exchangeCodeForTokens, gmailStatus, pollGmail } from "./gmail";
import {
  addManualCorrection,
  listOverdueCorrections,
  setCorrectionsSlaDays,
  addProjectNote,
  assignProjectClient,
  captureConfirmation,
  createPermitCheckTarget,
  createProject,
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
  getReviewerReportHtml,
  humanVerify,
  importKnowledgeFromMbox,
  prepareSubmission,
  recordPermitStatusCheck,
  rerunQc,
  syncOperationsPlan,
  updateOperationStep,
  runEmailTracker,
  runProjectWorkflow,
  runDuePermitChecks,
} from "./repository";

const app = express();
const db = await openDatabase();
const frontendDir = path.resolve(process.cwd(), "frontend");
const port = Number(process.env.PORT || 4173);

const asyncHandler =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };

app.use(cors());
app.use(express.json({ limit: "80mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(express.static(frontendDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "Solar Submission Autopilot", mode: "local-prototype" });
});

app.post("/api/projects", (req, res) => {
  const payload = req.body?.parserPayload ?? req.body?.payload ?? req.body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "Project payload must be an object.");
  }
  res.status(201).json(createProject(db, payload));
});

app.get("/api/projects", (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  const offset = req.query.offset ? Number(req.query.offset) : 0;
  const search = req.query.search ? String(req.query.search) : undefined;
  const status = req.query.status ? String(req.query.status) : undefined;
  const userId = req.query.userId ? String(req.query.userId) : undefined;
  const sort = (req.query.sort as string | undefined);
  const validSorts = ["updated_desc", "created_desc", "name_asc", "status_asc"] as const;
  type SortOption = typeof validSorts[number];
  const sortVal = validSorts.includes(sort as SortOption) ? (sort as SortOption) : undefined;
  res.json(getProjectList(db, { limit, offset, search, status, userId, sort: sortVal }));
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

app.post("/api/projects/:id/client", (req, res) => {
  const clientId = req.body?.clientId === null ? null : String(req.body?.clientId || "").trim() || null;
  res.json(assignProjectClient(db, String(req.params.id), clientId));
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

app.post("/api/knowledge-base/import-mbox-file", express.raw({ type: "*/*", limit: process.env.MBOX_IMPORT_LIMIT || "1gb" }), asyncHandler(async (req, res) => {
  const body = req.body;
  const mboxText = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  if (!mboxText.trim()) throw new HttpError(400, "Uploaded MBOX file was empty or unreadable.");
  res.status(201).json(
    await importKnowledgeFromMbox(db, {
      mboxText,
      sourceLabel: String(req.header("x-source-label") || req.query.sourceLabel || "Imported MBOX file"),
      defaultState: req.query.defaultState ? String(req.query.defaultState) : undefined,
      defaultAhj: req.query.defaultAhj ? String(req.query.defaultAhj) : undefined,
      defaultUtility: req.query.defaultUtility ? String(req.query.defaultUtility) : undefined,
    }),
  );
}));

app.post("/api/knowledge-base/import-mbox-path", asyncHandler(async (req, res) => {
  const filePath = String(req.body?.filePath || "").trim();
  if (!filePath) throw new HttpError(400, "Paste the full local MBOX file path before importing.");
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new HttpError(404, `MBOX file path was not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new HttpError(400, "MBOX path must point to a file.");
  const maxBytes = Number(process.env.MBOX_IMPORT_MAX_BYTES || 1024 * 1024 * 1024);
  if (Number.isFinite(maxBytes) && stat.size > maxBytes) {
    throw new HttpError(413, `MBOX file is too large for this local import limit (${Math.round(maxBytes / 1024 / 1024)} MB).`);
  }
  const mboxText = fs.readFileSync(resolved, "utf8");
  if (!mboxText.trim()) throw new HttpError(400, "MBOX file was empty or unreadable.");
  res.status(201).json(
    await importKnowledgeFromMbox(db, {
      mboxText,
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

app.get("/api/projects/:id/reviewer-report", (req, res) => {
  if (req.query.format === "html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(getReviewerReportHtml(db, req.params.id));
    return;
  }
  res.json(getReviewerReport(db, req.params.id));
});

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

app.post("/api/projects/:id/corrections", (req, res) => {
  const correctionText = String(req.body?.correctionText || "").trim();
  if (!correctionText) throw new HttpError(400, "correctionText is required.");
  res.status(201).json(addManualCorrection(db, req.params.id, correctionText, req.body?.source || "manual"));
});

app.post("/api/projects/:id/permit-targets", (req, res) => {
  res.status(201).json(createPermitCheckTarget(db, req.params.id, req.body || {}));
});

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
    const formType = String(req.query.formType || "permit_application").trim();
    const filename = String(req.query.filename || req.headers["x-filename"] || "upload.pdf").trim();
    if (!ahjName) throw new HttpError(400, "ahj query param required.");
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, "PDF body required.");

    const { extractPdfText } = await import("./batchImport");
    const tmp = path.join("/tmp", `ahj-tmpl-${Date.now()}.pdf`);
    fs.writeFileSync(tmp, req.body);
    let extractedText = "";
    try { extractedText = await extractPdfText(tmp); } catch { /* ignore */ }
    fs.unlinkSync(tmp);

    // LLM extracts the field structure / form positions
    const { createLLMProvider } = await import("./llm");
    const llm = createLLMProvider();
    const fieldMap = await llm.extractFields({ text: extractedText, source: "ahj_form_template", ahjName, state });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO ahj_form_templates (id, ahj_name, state, form_type, original_filename, pdf_blob, moat_data, field_map, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, '', ?, ?)`,
      [id, ahjName, state, formType, filename, req.body, JSON.stringify(fieldMap), now, now],
    );
    res.status(201).json({ id, ahjName, state, formType, fieldCount: Object.keys(fieldMap).length });
  }),
);

// List stored AHJ templates
app.get("/api/ahj-templates", (req, res) => {
  const state = req.query.state ? String(req.query.state) : null;
  const rows = state
    ? db.query("SELECT id, ahj_name, state, form_type, original_filename, field_map, created_at FROM ahj_form_templates WHERE state = ? ORDER BY ahj_name", [state])
    : db.query("SELECT id, ahj_name, state, form_type, original_filename, field_map, created_at FROM ahj_form_templates ORDER BY state, ahj_name");
  res.json(rows.map((r) => ({ ...r, fieldMap: JSON.parse(String(r.field_map || "{}")) })));
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
  const noteRows = db.query<{ content: string }>(
    `SELECT pn.content FROM project_notes pn
     JOIN projects p ON p.id = pn.project_id
     WHERE p.ahj LIKE ? AND pn.content LIKE '%application%'
     ORDER BY pn.created_at DESC LIMIT 20`,
    [`%${ahjName}%`],
  );

  const { createLLMProvider } = await import("./llm");
  const llm = createLLMProvider();
  const result = await llm.synthesizeKnowledge({
    ahjName,
    state: state || "",
    utility: utility || "",
    pastApplicationTexts: noteRows.map((r) => r.content),
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

// Check folder scan job status + get full result
app.get("/api/batch-import/jobs", (req, res) => {
  res.json(listJobs(db, { jobType: "folder_scan", limit: 20 }));
});

app.post("/api/projects/:id/prepare-submission", asyncHandler(async (req, res) => {
  res.json(await prepareSubmission(db, String(req.params.id)));
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

app.post("/api/portal-runs/:id/capture-confirmation", (req, res) => {
  res.json(captureConfirmation(db, req.params.id, req.body || {}));
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

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const bodyParserStatus = typeof (err as { status?: unknown })?.status === "number" ? Number((err as { status: number }).status) : null;
  const bodyParserType = String((err as { type?: unknown })?.type || "");
  const httpError =
    err instanceof HttpError
      ? err
      : bodyParserStatus === 413 || bodyParserType === "entity.too.large"
        ? new HttpError(413, `Upload is too large for the current local import limit. Increase MBOX_IMPORT_LIMIT or use a smaller export.`)
        : new HttpError(bodyParserStatus && bodyParserStatus >= 400 && bodyParserStatus < 600 ? bodyParserStatus : 500, err instanceof Error ? err.message : "Unknown error.");
  if (httpError.status >= 500) console.error(err);
  res.status(httpError.status).json({
    error: httpError.message,
    details: httpError.details,
  });
});

app.listen(port, () => {
  console.log(`Solar Submission Autopilot running at http://localhost:${port}`);
  console.log(`Parser: http://localhost:${port}/parser`);
  console.log(`Dashboard: http://localhost:${port}/  (or /dashboard)`);
  startJobWorker(db);
});
