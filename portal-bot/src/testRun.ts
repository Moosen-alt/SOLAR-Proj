/**
 * Standalone portal test harness.
 *
 * Lets you watch a portal adapter fill a real portal in a visible browser,
 * WITHOUT setting up a full project in the database. The bot always stops at
 * the final review screen — it never clicks final submit.
 *
 * USAGE:
 *   1. Capture a login session for the portal (one time):
 *        npx playwright codegen --save-storage=accela-session.json https://aca-oregon.accela.com/oregon/
 *        # (log in manually in the window that opens, then close it)
 *
 *   2. Point this script at that session and a sample project JSON:
 *        npx tsx portal-bot/src/testRun.ts accela ./accela-session.json ./sample-project.json
 *        npx tsx portal-bot/src/testRun.ts powerclerk ./pge-session.json ./sample-project.json
 *
 *   If you omit the project file, a built-in sample project is used.
 *   Files to upload are read from the project's `uploadFiles` array (absolute
 *   paths). Leave it empty to skip uploads while testing field-fill.
 */
import fs from "node:fs";
import type { ProjectRecord } from "../../shared/src/types";
import { OregonEPermittingAdapter } from "./adapters/oregonEPermitting";
import { PowerClerkAdapter } from "./adapters/powerClerk";
import type { PortalAdapter } from "./adapter";

const SAMPLE_PROJECT: ProjectRecord & { uploadFiles?: string[] } = {
  id: "test-project",
  clientId: null,
  homeownerName: "Jeffery Bienvenu",
  projectAddress: "1227 Trent",
  city: "Keizer",
  state: "OR",
  zip: "97303",
  ahj: "Marion County",
  utility: "PGE",
  accountNumber: "4036870000",
  meterNumber: "41 306 707",
  systemSizeDcKw: 9.89,
  systemSizeAcKw: 7.6,
  totalExportKw: 7.6,
  interconnectionMethod: "Load Breaker",
  status: "ready_to_stage",
  currentStage: "submission",
  parserConfidenceSummary: "",
  parserSnapshot: {
    installerCompanyName: "TML INTERNATIONAL LLC",
    installerEmail: "permit@infinitysolarusa.com",
    installerPhone: "(800) 818-0598",
    homeownerPhone: "(541) 364-9960",
    homeownerEmail: "contact.ces@gmail.com",
    inverterManufacturer: "Tesla",
    inverterModel: "1538000",
    inverterQuantity: "1",
    mainServiceRating: "200",
    hasBattery: "No",
    pvArrays: [
      { quantity: "11", moduleManufacturer: "SEG Solar", moduleModel: "SEG-430", tilt: "27", azimuth: "181" },
      { quantity: "12", moduleManufacturer: "SEG Solar", moduleModel: "SEG-430", tilt: "27", azimuth: "271" },
    ],
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function main(): Promise<void> {
  const [portal, sessionPath, projectPath] = process.argv.slice(2);

  if (!portal || !["accela", "powerclerk"].includes(portal)) {
    console.error("Usage: tsx portal-bot/src/testRun.ts <accela|powerclerk> [session.json] [project.json]");
    process.exit(1);
  }

  if (sessionPath && !fs.existsSync(sessionPath)) {
    console.error(`Session file not found: ${sessionPath}`);
    console.error("Capture one with: npx playwright codegen --save-storage=session.json <portal-url>");
    process.exit(1);
  }

  const project: ProjectRecord & { uploadFiles?: string[] } =
    projectPath && fs.existsSync(projectPath)
      ? (JSON.parse(fs.readFileSync(projectPath, "utf8")) as ProjectRecord & { uploadFiles?: string[] })
      : SAMPLE_PROJECT;

  const files = Array.isArray(project.uploadFiles) ? project.uploadFiles : [];

  const adapter: PortalAdapter = portal === "accela" ? new OregonEPermittingAdapter() : new PowerClerkAdapter();

  console.log(`\n▶ Testing ${adapter.portalName}`);
  console.log(`  Session: ${sessionPath ?? "(none — you must log in manually if prompted)"}`);
  console.log(`  Project: ${project.homeownerName} @ ${project.projectAddress}`);
  console.log(`  Files:   ${files.length} to upload`);
  console.log(`  Browser will open VISIBLE. The bot stops at the review page — it never submits.\n`);

  const step = async (label: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    process.stdout.write(`  • ${label} ... `);
    const r = await fn();
    console.log(r.ok ? `ok — ${r.message}` : `FAILED — ${r.message}`);
    return r.ok;
  };

  // headless:false so you can watch and take over for the final submit
  if (!(await step("login", () => adapter.login({ storageStatePath: sessionPath, headless: false })))) return;
  if (!(await step("openSubmission", () => adapter.openSubmission(project)))) return;
  if (!(await step("fillApplication", () => adapter.fillApplication(project)))) return;
  if (files.length > 0) await step("uploadFiles", () => adapter.uploadFiles(project, files));
  await step("stopAtReview", () => adapter.stopAtReview(project));

  console.log("\n✅ Bot stopped at the review screen. Verify everything, then click submit MANUALLY.");
  console.log("   The browser stays open. Press Ctrl+C here when you're done.\n");

  // Keep the process alive so the browser stays open for manual review/submit
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Test run error:", err);
  process.exit(1);
});
