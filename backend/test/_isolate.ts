// TEST DATA ISOLATION. Import this FIRST — before any ../src module, static or dynamic:
//
//     import "./_isolate";
//
// The backend resolves its data folders off process.cwd() at MODULE LOAD:
//   backend/data/filled            ahjForms.ts / generatedDocFiles.ts  (no env override)
//   backend/data/project-documents projectDocuments.ts (PROJECT_DOCS_DIR)
//   backend/data/page-images       pageImages.ts      (PAGE_IMAGE_CACHE_DIR)
//   data/logs/backend.log          logger.ts          (AUTOPILOT_LOG_FILE)
// A test run from the repo root with only AUTOPILOT_DB_PATH pointed at a temp dir
// therefore wrote its generated/filled PDFs and uploads into the LIVE server's data
// folders — 1,795 orphan project-documents folders (1.1 GB) and 656 orphan filled
// folders (296 MB) for projects that never existed in production.
//
// This module runs before the test body (ESM evaluates imports in order), so it:
//   1. chdirs into a fresh temp dir, so every cwd-relative path — including FILLED_DIR,
//      which has no env override — lands there;
//   2. points the env-overridable folders there too (a parent shell exporting the
//      live values must not win);
//   3. keeps the READ-ONLY reference data reachable: the two reference JSONs via their
//      env overrides, and the cached blank form templates copied (not linked — a
//      fetchFormTemplate cache refresh must not write through into the repo).
// A test that sets its own env after this import still wins (it runs later).
// Anything cwd-relative the TEST ITSELF reads must use REPO, not a bare relative path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root, captured before the chdir. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The temp dir this process now runs in (its backend/data is the test's data root). */
export const ISOLATED_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-test-"));

const data = path.join(ISOLATED_CWD, "backend", "data");
fs.mkdirSync(data, { recursive: true });

const repoData = path.join(REPO, "backend", "data");
const templates = path.join(repoData, "ahj-forms");
if (fs.existsSync(templates)) fs.cpSync(templates, path.join(data, "ahj-forms"), { recursive: true });

process.env.CODE_PROFILE_REFERENCE_PATH = path.join(repoData, "reference-code-profiles.json");
process.env.AHJ_PROCESS_REFERENCE_PATH = path.join(repoData, "reference-ahj-processes.json");
process.env.PROJECT_DOCS_DIR = path.join(data, "project-documents");
process.env.PAGE_IMAGE_CACHE_DIR = path.join(data, "page-images");
process.env.BACKUP_DIR = path.join(data, "backups");
process.env.AUTOPILOT_LOG_FILE = ""; // explicitly disabled (logger.ts checks === "")
// Never inherit a live DB path from the parent shell; the test sets its own afterwards.
process.env.AUTOPILOT_DB_PATH = path.join(data, "test.sqlite");

process.chdir(ISOLATED_CWD);

// Best-effort removal. An open SQLite handle can hold a file on Windows; a leftover
// temp dir is harmless, a leftover folder in the repo was the bug.
process.on("exit", () => {
  if (process.env.KEEP_TEST_DATA === "1") return;
  try { process.chdir(os.tmpdir()); } catch { /* ignore */ }
  try { fs.rmSync(ISOLATED_CWD, { recursive: true, force: true }); } catch { /* ignore */ }
});
