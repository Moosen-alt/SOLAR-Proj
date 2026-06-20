/**
 * Standalone portal test harness.
 *
 * FIRST TIME SETUP — log in and save a persistent profile (once per portal):
 *   npm run portal:login -- powerclerk
 *   npm run portal:login -- accela
 *
 *   A browser opens. Log in manually. Close the browser. Done — your login is
 *   saved in portal-profiles/<portal>/ and reused on every run from now on.
 *
 * RUN THE BOT (after login is saved):
 *   npm run portal:test -- powerclerk
 *   npm run portal:test -- accela
 *
 *   A browser opens, fills every field, and stops at the review screen.
 *   Verify everything, then click submit yourself. Press Ctrl+C when done.
 *
 * USE YOUR OWN PROJECT DATA:
 *   npm run portal:test -- powerclerk ./my-project.json
 *
 * The bot NEVER clicks final submit, pays fees, or handles MFA/CAPTCHA.
 */
import fs from "node:fs";
import path from "node:path";
import type { ProjectRecord } from "../../shared/src/types";
import { OregonEPermittingAdapter } from "./adapters/oregonEPermitting";
import { PowerClerkAdapter } from "./adapters/powerClerk";
import type { PortalAdapter, PortalContext } from "./adapter";

const PROFILES_DIR = path.resolve(process.cwd(), "portal-profiles");

const PORTAL_URLS: Record<string, string> = {
  powerclerk: "https://pgenm.powerclerk.com/MvcAccount/Login",
  accela: "https://aca-oregon.accela.com/oregon/Default.aspx",
};

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

// Opens a visible browser so the user can log in and save a persistent profile
async function doLogin(portal: string): Promise<void> {
  const { chromium } = await import("playwright");
  const profileDir = path.join(PROFILES_DIR, portal);
  fs.mkdirSync(profileDir, { recursive: true });

  const url = PORTAL_URLS[portal];
  console.log(`\n▶ Opening ${portal} login page in a persistent browser profile`);
  console.log(`  Profile saved to: ${profileDir}`);
  console.log(`  → Log in manually in the browser window that opens.`);
  console.log(`  → When you reach your dashboard, close the browser window.`);
  console.log(`  → Your login will be reused on every future run.\n`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url);

  // Wait until the user closes the browser window
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await new Promise<void>((resolve) => {
    (context as any).on("close", resolve);
    (page as any).on("close", resolve);
  });

  console.log("\n✅ Browser closed. Your login has been saved.");
  console.log(`   Now run: npm run portal:test -- ${portal}\n`);
}

// Drives the adapter through all steps and stops at the review screen
async function doTest(portal: string, projectPath: string | undefined): Promise<void> {
  const profileDir = path.join(PROFILES_DIR, portal);
  if (!fs.existsSync(profileDir)) {
    console.error(`\n✗ No saved login found for ${portal}.`);
    console.error(`  Run this first: npm run portal:login -- ${portal}\n`);
    process.exit(1);
  }

  const project: ProjectRecord & { uploadFiles?: string[] } =
    projectPath && fs.existsSync(projectPath)
      ? (JSON.parse(fs.readFileSync(projectPath, "utf8")) as ProjectRecord & { uploadFiles?: string[] })
      : SAMPLE_PROJECT;

  const files: string[] = Array.isArray(project.uploadFiles) ? project.uploadFiles : [];

  const adapter: PortalAdapter = portal === "accela"
    ? new OregonEPermittingAdapter()
    : new PowerClerkAdapter();

  const context: PortalContext = {
    userDataDir: profileDir,
    headless: false,
  };

  console.log(`\n▶ Testing ${adapter.portalName}`);
  console.log(`  Profile:  ${profileDir}`);
  console.log(`  Project:  ${project.homeownerName} @ ${project.projectAddress}`);
  console.log(`  Arrays:   ${Array.isArray((project.parserSnapshot as Record<string, unknown>)?.["pvArrays"]) ? ((project.parserSnapshot as Record<string, unknown>)["pvArrays"] as unknown[]).length : 1}`);
  console.log(`  Files:    ${files.length} to upload`);
  console.log(`  The bot stops at the review page — it NEVER submits.\n`);

  const step = async (label: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    process.stdout.write(`  • ${label} ... `);
    const r = await fn();
    if (r.ok) {
      console.log(`ok  ${r.message}`);
    } else {
      console.log(`FAILED\n\n    ${r.message}\n`);
    }
    return r.ok;
  };

  if (!(await step("login", () => adapter.login(context)))) {
    console.log("  ↳ Fix login then re-run. Browser is still open if you want to log in now.\n");
    await new Promise(() => {}); // keep open
  }
  if (!(await step("openSubmission", () => adapter.openSubmission(project)))) return;
  if (!(await step("fillApplication", () => adapter.fillApplication(project)))) return;
  if (files.length > 0) await step("uploadFiles", () => adapter.uploadFiles(project, files));
  await step("stopAtReview", () => adapter.stopAtReview(project));

  console.log("\n✅ Bot stopped at the review screen.");
  console.log("   Verify all fields, then click Submit MANUALLY.");
  console.log("   Press Ctrl+C here when you are done.\n");

  await new Promise(() => {}); // keep browser open
}

async function main(): Promise<void> {
  const [command, arg1, arg2] = process.argv.slice(2);

  if (command === "login") {
    const portal = arg1;
    if (!portal || !PORTAL_URLS[portal]) {
      console.error("Usage: npm run portal:login -- <accela|powerclerk>");
      process.exit(1);
    }
    await doLogin(portal);
    return;
  }

  // Default: test mode
  const portal = command;
  if (!portal || !["accela", "powerclerk"].includes(portal)) {
    console.error("Usage:");
    console.error("  npm run portal:login -- <accela|powerclerk>   (first-time login)");
    console.error("  npm run portal:test  -- <accela|powerclerk> [project.json]");
    process.exit(1);
  }

  await doTest(portal, arg1 ?? arg2);
}

main().catch((err) => {
  console.error("\nTest run error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
