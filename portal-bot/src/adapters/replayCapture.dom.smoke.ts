// R4 — REPLAY'S DIAGNOSTIC CAPTURES GO THROUGH THE SANITIZER, KEEP EVERY FRAME AND THE TARGET
// CONTROL, AND LAND IN REPLAY_CAPTURE_DIR.
//
// A local fixture page (127.0.0.1) carries a PRE-FILLED 11-digit account number in the main
// document and its County select inside an iframe — the shape of the real PowerClerk captures
// that could not be diagnosed offline (the control was in a frame the capture never saved).
//
//   MUST-EXCLUDE  the 11-digit value appears in NO file the replay wrote (raw page.content()
//                 wrote it into every failure capture).
//   MUST-PASS     a failing step's capture includes the iframe and its County control; a select
//                 miss on the framed County records the control's markup and its option list;
//                 every file is under REPLAY_CAPTURE_DIR.
//
//   npx tsx portal-bot/src/adapters/replayCapture.dom.smoke.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";

const CAPTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "replay-capture-smoke-"));
process.env.REPLAY_CAPTURE_DIR = CAPTURE_DIR;
delete process.env.REPLAY_RUN_DIR;
const { RecipeAdapter } = await import("./recipeAdapter");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const SECRET = "84201937465";
const STARTED = Date.now();
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/html" });
  if (url.pathname === "/frame") {
    res.end(`<!doctype html><html><body><label for="county">County</label><select id="county" name="county"><option value="">Please select...</option><option value="HAR">Harlan</option><option value="WEX">Wexcombe</option></select></body></html>`);
    return;
  }
  res.end(`<!doctype html><html><head><title>Service Details</title></head><body><h2>Service Details</h2>
    <label for="acct">Utility Account Number</label><input id="acct" name="acct" value="${SECRET}">
    <label for="city">City</label><input id="city" name="city">
    <iframe name="countyFrame" src="/frame" style="width:400px;height:80px"></iframe>
    <button type="button">Next</button></body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const recipe = (steps: RecipeStep[]): PortalRecipe => ({
  id: "capture-smoke", scopeType: "utility", profileKey: "or||cascadia", state: "OR", ahj: "", utility: "Cascadia Power",
  portalPlatform: "fixture", portalUrl: `${base}/`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps,
});

const browser = await chromium.launch();
async function run(steps: RecipeStep[], values: Record<string, string>) {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  const adapter = new RecipeAdapter(recipe(steps), values, {});
  (adapter as unknown as { page: unknown }).page = page;
  const result = await adapter.fillApplication({} as ProjectRecord);
  await ctx.close();
  return result;
}
const allFiles = (dir: string): string[] => fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? allFiles(path.join(dir, d.name)) : [path.join(dir, d.name)]))
  : [];

console.log("\n1. A failing step: the capture is sanitized, keeps the iframe, and lands in REPLAY_CAPTURE_DIR");
{
  await run([
    { action: "goto", value: `${base}/`, note: "open" },
    { action: "fill", selector: { label: "Meter Reading Box" }, note: "Meter Reading Box", field: "city" },
    { action: "stopForReview" },
  ], { city: "Fernhollow" });
  const files = allFiles(path.join(CAPTURE_DIR, "replay-failures"));
  const json = files.filter((f) => f.endsWith(".json"));
  check("a failure capture was written under REPLAY_CAPTURE_DIR", json.length >= 1, `files=${files.map((f) => path.basename(f)).join(",")}`);
  const cap = json.length ? JSON.parse(fs.readFileSync(json[0], "utf8")) as { frames: Array<{ url: string; html: string }> } : { frames: [] };
  check("every frame is kept — the iframe's County control is in the capture", cap.frames.length >= 2 && cap.frames.some((f) => /\/frame$/.test(f.url) && /id="county"/.test(f.html)), `frames=${cap.frames.map((f) => f.url).join(",")}`);
}

console.log("\n2. A select miss on the framed County: the target control's markup and options are recorded");
{
  await run([
    { action: "goto", value: `${base}/`, note: "open" },
    { action: "select", selector: { label: "County", frame: "countyFrame" }, note: "County", field: "county" },
    { action: "stopForReview" },
  ], { county: "Nowhere County" });
  const miss = allFiles(path.join(CAPTURE_DIR, "replay-failures")).filter((f) => /miss-County.*\.json$/.test(path.basename(f)));
  check("a select-miss capture was written", miss.length >= 1, allFiles(CAPTURE_DIR).map((f) => path.basename(f)).join(","));
  const cap = miss.length ? JSON.parse(fs.readFileSync(miss[0], "utf8")) as { target: { outerHTML: string; options: string[] } | null } : { target: null };
  check("the target control's own markup is recorded", !!cap.target && /<select[^>]*id="county"/.test(cap.target.outerHTML), JSON.stringify(cap.target).slice(0, 200));
  check("with its option list", !!cap.target && cap.target.options.includes("Harlan") && cap.target.options.includes("Wexcombe"), JSON.stringify(cap.target?.options));
}

console.log("\n3. MUST-EXCLUDE: the pre-filled 11-digit value is in no file replay wrote");
{
  const files = allFiles(CAPTURE_DIR);
  const leaking = files.filter((f) => !f.endsWith(".png") && fs.readFileSync(f, "utf8").includes(SECRET));
  check("no capture file contains the pre-filled account number", files.length > 0 && leaking.length === 0, `leaking=${leaking.map((f) => path.basename(f)).join(",")}`);
  const cwdData = path.join(process.cwd(), "data", "replay-failures");
  const strays = allFiles(cwdData).filter((f) => fs.statSync(f).mtimeMs >= STARTED);
  check("nothing fell back to data/", strays.length === 0, strays.join(","));
}

await browser.close();
server.close();
fs.rmSync(CAPTURE_DIR, { recursive: true, force: true });
if (failures) { console.error(`\nreplayCapture: ${failures} check(s) FAILED`); process.exit(1); }
console.log("\nreplayCapture: all checks passed (real Chromium, local fixture)");
process.exit(0);
