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
//      fetchFormTemplate cache refresh must not write through into the repo);
//   4. takes the process OFF THE NETWORK (#125): see OFFLINE below.
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

// OFFLINE. Staging runs its own form acquisition, and that downloaded public blanks LIVE — the
// Oregon BCD 440-5952 from www.oregon.gov, Portland's electrical application from portland.gov —
// in some two dozen suites that stage a job. When oregon.gov was slow or blocked the CI runner,
// seven of them failed "Submission staging blocked: required document(s) not attached … Solar
// prescriptive checklist" on a PR that touched none of it (#125). The staging gate was right to
// block; the tests were wrong to depend on a state website.
//
// So every request that would leave the machine is REFUSED here, the way a network outage
// refuses it — deterministically, every run, instead of only on the day the site is down. The
// exceptions are the public blanks staging NEEDS to clear its document gate (the 5952 on an
// Oregon prescriptive job; Marion County's B-01S / E-01 where the county issues; Coos County's
// and Tigard's applications): each is served from its committed fixture (backend/test/fixtures,
// provenance in bcd-5952-2024.md and curated-forms.md) for its real URL — the same bytes the site
// answered with. Loopback still reaches the real fetch (suites that boot the server use 127.0.0.1).
// A test that installs its own fetch stub after this import still wins (gatesProper, …), and
// an unserved form now reads as a download failure, exactly as it does offline.
const fixture = (name: string) => fs.readFileSync(path.join(REPO, "backend", "test", "fixtures", name));
export const OFFLINE_SERVED = new Map<string, Buffer>([
  ["https://www.oregon.gov/bcd/Formslibrary/5952.pdf", fixture("bcd-5952-2024.pdf")],
  ["https://www.co.marion.or.us/PW/BuildingInspection/Documents/B-01S%20Solar%20Prescriptive%20Installation%20Application%20Filleable.pdf", fixture("marion-b-01s.pdf")],
  ["https://www.co.marion.or.us/PW/BuildingInspection/Documents/E-01%20Renewable%20Energy%20Permit%20Application.pdf", fixture("marion-e-01.pdf")],
  ["https://co.coos.or.us/files/5bb0a81e5/electrical_permit.pdf", fixture("coos-electrical.pdf")],
  ["https://www.tigard-or.gov/home/showpublisheddocument/42/639007759919470000", fixture("tigard-building.pdf")],
  ["https://www.tigard-or.gov/home/showpublisheddocument/44/637615268530600000", fixture("tigard-electrical.pdf")],
]);
const realFetch = globalThis.fetch;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"]);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  let host = "";
  try { host = new URL(url).hostname; } catch { /* not a URL: let the real fetch say so */ }
  if (!host || LOOPBACK.has(host)) return realFetch(input, init);
  const body = OFFLINE_SERVED.get(url);
  if (body) return new Response(new Uint8Array(body), { headers: { "Content-Type": "application/pdf" } });
  throw new TypeError(`fetch failed: unit tests are offline (backend/test/_isolate.ts) — refused ${url}`);
}) as typeof fetch;

// Best-effort removal. An open SQLite handle can hold a file on Windows; a leftover
// temp dir is harmless, a leftover folder in the repo was the bug.
process.on("exit", () => {
  if (process.env.KEEP_TEST_DATA === "1") return;
  try { process.chdir(os.tmpdir()); } catch { /* ignore */ }
  try { fs.rmSync(ISOLATED_CWD, { recursive: true, force: true }); } catch { /* ignore */ }
});
