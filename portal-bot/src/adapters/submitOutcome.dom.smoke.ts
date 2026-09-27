// R2 — THE REPLAY FINAL-SUBMIT GATE AT THE CLICK, AND ACCEPTANCE ONLY ON POSITIVE EVIDENCE.
//
// A local fixture portal (127.0.0.1, never a real one) whose review page carries the recipe's
// flagged final submit. The real RecipeAdapter in real Chromium:
//
//   MUST-EXCLUDE  autoSubmit:true with PORTAL_ALLOW_FINAL_SUBMIT unset → the server receives no
//                 POST; an approval for another run → no POST.
//   MUST-PASS     env 1 + a named approval for THIS run + the terminal flagged step after
//                 stopForReview → exactly one POST; a confirmation page reads "accepted".
//   QUIET PAGE    → one POST, outcome "unknown", the run stops for a human — never "accepted
//                 because the page went quiet" (the old poll's `!/EditProject/` fallback).
//   REFUSAL       → "rejected".
//
//   npx tsx portal-bot/src/adapters/submitOutcome.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
// Every artifact this smoke's replays write goes to a temp folder, never data/.
const SMOKE_ARTIFACTS = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "replay-smoke-"));
process.env.REPLAY_CAPTURE_DIR = SMOKE_ARTIFACTS;
process.env.REPLAY_RUN_DIR = nodePath.join(SMOKE_ARTIFACTS, "runs");
process.env.PORTAL_SCREENSHOT_DIR = nodePath.join(SMOKE_ARTIFACTS, "screenshots");
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const posts: string[] = [];
const AFTER: Record<string, string> = {
  accepted: "<h1>Step 5: Record Issuance</h1><p>Your application has been successfully submitted.</p><p>Record Number: FER-26-000123-ELE</p>",
  quiet: "<h1>Step 5</h1><p>Your request is being handled.</p>",
  rejected: "<div role='alert'>Unable to submit: Phone Number is required.</div>",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === "/submit") {
    const mode = url.searchParams.get("mode") || "quiet";
    posts.push(mode);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>Portal</title></head><body>${AFTER[mode] ?? AFTER.quiet}</body></html>`);
    return;
  }
  const mode = url.searchParams.get("mode") || "quiet";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>Portal</title></head><body><h1>Step 4: Review</h1>
    <p>Please review all information below.</p><dl><dt>Name</dt><dd>Desmond Yarrowby</dd></dl>
    <form method="post" action="/submit?mode=${mode}"><button type="submit" id="btnSubmit">Submit Application</button></form></body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const recipeFor = (mode: string): PortalRecipe => ({
  id: "submit-outcome-smoke", scopeType: "ahj", profileKey: "or|fernhollow|", state: "OR", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "fixture", portalUrl: `${base}/review?mode=${mode}`, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [
    { action: "goto", value: `${base}/review?mode=${mode}`, note: "open review" },
    { action: "stopForReview" },
    { action: "click", selector: { css: "#btnSubmit" }, note: "final submit", isFinalSubmit: true } as RecipeStep,
  ],
});

const browser = await chromium.launch();
async function run(mode: string, env: string | undefined, opts: Record<string, unknown>) {
  const prev = process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  if (env === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = env;
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const page = await ctx.newPage();
  const adapter = new RecipeAdapter(recipeFor(mode), {}, {}, opts as never);
  (adapter as unknown as { page: unknown }).page = page;
  posts.length = 0;
  try {
    const result = await adapter.fillApplication({} as ProjectRecord);
    return { result, adapter, posts: [...posts] };
  } finally {
    await ctx.close();
    if (prev === undefined) delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; else process.env.PORTAL_ALLOW_FINAL_SUBMIT = prev;
  }
}
// A fresh run per stage: an approval burns at the bot layer once its run clicks or is refused (portal-run-close-2 C1).
let approvedSeq = 0;
const approvedRun = (): { autoSubmit: boolean; runApproval: { approver: string; runId: string }; runId: string } => { const id = `R-${++approvedSeq}`; return { autoSubmit: true, runApproval: { approver: "A. Person", runId: id }, runId: id }; };

console.log("\n1. MUST-EXCLUDE: the env switch unset");
{
  const r = await run("accepted", undefined, approvedRun());
  check("autoSubmit + approval but PORTAL_ALLOW_FINAL_SUBMIT unset → no POST", r.posts.length === 0, `posts=${r.posts}`);
  check("finalSubmitClicked false", r.adapter.finalSubmitClicked === false);
}
console.log("\n2. MUST-EXCLUDE: an approval for another run");
{
  const r = await run("accepted", "1", { autoSubmit: true, runApproval: { approver: "A. Person", runId: "R2" }, runId: "R" });
  check("an approval for run R2 while in run R → no POST", r.posts.length === 0, `posts=${r.posts}`);
}
console.log("\n3. MUST-PASS: env 1 + this run's approval + terminal flagged step → one POST, accepted");
{
  const r = await run("accepted", "1", approvedRun());
  check("exactly one filing POST", r.posts.length === 1, `posts=${r.posts}`);
  check("outcome accepted on positive evidence", r.adapter.finalSubmitOutcome?.verdict === "accepted", JSON.stringify(r.adapter.finalSubmitOutcome));
  check("the run is ok", r.result.ok === true, String(r.result.message).slice(0, 200));
}
console.log("\n4. A quiet page is UNKNOWN, never accepted");
{
  const r = await run("quiet", "1", approvedRun());
  check("exactly one filing POST (never retried)", r.posts.length === 1, `posts=${r.posts}`);
  check("outcome unknown", r.adapter.finalSubmitOutcome?.verdict === "unknown", JSON.stringify(r.adapter.finalSubmitOutcome));
  check("the run stops for a human, saying so", r.result.ok === false && /outcome unknown — human must verify/.test(String(r.result.message)), String(r.result.message).slice(0, 200));
  check("the click is reported (nothing may click it again)", r.adapter.finalSubmitClicked === true);
}
console.log("\n5. A refusal is REJECTED");
{
  const r = await run("rejected", "1", approvedRun());
  check("outcome rejected", r.adapter.finalSubmitOutcome?.verdict === "rejected", JSON.stringify(r.adapter.finalSubmitOutcome));
  check("the run fails naming the refusal", r.result.ok === false && /REFUSED/.test(String(r.result.message)), String(r.result.message).slice(0, 200));
}

await browser.close();
server.close();
if (failures) { console.error(`\nsubmitOutcome: ${failures} check(s) FAILED`); process.exit(1); }
console.log("\nsubmitOutcome: all checks passed (real Chromium, local fixture)");
process.exit(0);
