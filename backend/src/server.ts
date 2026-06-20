import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./db";
import { HttpError } from "./httpError";
import { createClient, deleteClient, getClient, listClients, updateClient } from "./clients";
import {
  ahjFormRegistry,
  buildFilledFormsForProject,
  fetchFormTemplate,
  filledFormPath,
  inspectFormFields,
  matchingForms,
} from "./ahjForms";
import {
  addManualCorrection,
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

app.get("/api/projects", (_req, res) => {
  res.json({ projects: getProjectList(db) });
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

app.post("/api/permit-monitor/run", asyncHandler(async (_req, res) => {
  res.json(await runDuePermitChecks(db));
}));

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
  console.log(`Dashboard: http://localhost:${port}/dashboard.html`);
});
