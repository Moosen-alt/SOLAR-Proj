// Measure what resolveRecipeFieldValues / buildPortalPlanner put in projectFields for project
// 53266857 (City of Jefferson OR, live run 99baa5d0) — on a .backup COPY of the production DB,
// every data dir pointed at scratch. The copy is discarded afterwards.
//   node node_modules/tsx/dist/cli.mjs .probe/live-run-jefferson/measure-planner.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "planner-measure-"));
const copy = path.join(scratch, "autopilot-copy.sqlite");
const src = new Database(process.env.PROD_DB || "C:/Users/isobl/SOLAR-Proj/backend/data/autopilot.sqlite", { readonly: true, fileMustExist: true });
await src.backup(copy);
src.close();
process.env.AUTOPILOT_DB_PATH = copy;
process.env.PROJECT_DOCS_DIR = path.join(scratch, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(scratch, "profiles");
process.env.BACKUP_DIR = path.join(scratch, "backups");
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../../backend/src/db");
const repo = await import("../../backend/src/repository");
const { buildPortalPlanner } = await import("../../backend/src/autoLearn");
const db = await openDatabase();
const detail = repo.getProjectDetail(db, "53266857-b6ac-41a3-a46e-96779c6901bd");
const project = detail.project;
const built = buildPortalPlanner(db, project, { portalType: "accela", scopeType: "ahj", permitType: "electrical" });
const pf = built.projectFields;
const entries = Object.entries(pf).map(([k, v]) => [k, String(v)] as const).sort((a, b) => b[1].length - a[1].length);
const json = JSON.stringify(pf);
console.log(`projectFields: ${entries.length} keys, ${json.length} chars as JSON`);
console.log("largest values:");
for (const [k, v] of entries.slice(0, 25)) console.log(`  ${k}: ${v.length} chars  ${JSON.stringify(v.slice(0, 90))}`);
console.log("keys over 200 chars:", entries.filter(([, v]) => v.length > 200).map(([k, v]) => `${k}(${v.length})`).join(", ") || "none");
console.log("feeTierRatingKw:", JSON.stringify(pf.feeTierRatingKw), "systemSizeAcKw:", JSON.stringify(pf.systemSizeAcKw));
console.log("tier keys:", Object.keys(pf).filter((k) => k.startsWith("feeBracketQuantity:")).join(",") || "none");
db.close();
fs.rmSync(scratch, { recursive: true, force: true });
