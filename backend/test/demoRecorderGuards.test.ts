// THE ACT 4 RECORDER: RIGHT GATE, RIGHT PROJECT, NOTHING LEFT BEHIND.
//
// scripts/demo-record-portal.ts records the real replay engine stopping at a fictional portal's
// review screen. Three defects, each pinned here:
//
//   1. WRONG GATE. The recipe's final-submit note said "submit/pay-like"; executeClick tests
//      "<name> <note>" against PAY_FEE_REPLAY_GATE FIRST and `\bpay\b` matched, so the FEE gate
//      stopped the engine while the captions credit the guided-manual final-submit rule.
//      MUST PASS: the demo recipe's final submit, through the engine's REAL executeClick, is
//      refused by the guided-manual rule. MUST DISCRIMINATE: the old wording reads as the fee
//      gate, and a non-final "Submit" click as another gate — or the probe proves nothing.
//   2. ANY PROJECT. --project took any id from any database. MUST REFUSE: a database with a
//      client other than Solaris Demo Co, a database with no demo company, a project of another
//      company, a demo project whose ZIP is not 99999. MUST PASS: a demo project at 99999.
//   3. TEMP LEFT BEHIND. The DB copy lived in a temp dir removed only on the happy path. MUST
//      PASS: a run that throws after the copy (browser launch fails) leaves no demo-record-* dir.
//      And a refused run never creates one at all (the guard runs before the copy).
//
// The recorder's CLI is SPAWNED (it runs main() on import); guards and the probe are imported.
// Everything lives in a temp dir; this process chdirs there before importing the backend.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = process.cwd();
const TSX_CLI = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const RECORDER = path.join(REPO, "scripts", "demo-record-portal.ts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-recorder-guards-"));
process.chdir(root);
process.env.AUTOPILOT_DB_PATH = path.join(root, "guards.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(root, "project-documents");
process.env.BACKUP_DIR = path.join(root, "backups");
process.env.AUTOPILOT_LOG_FILE = "";
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
process.env.BACKGROUND_WORKERS = "off";
process.env.CLIENT_NOTIFICATIONS = "off";
delete process.env.ANTHROPIC_API_KEY;

const { RecipeAdapter, PAY_FEE_REPLAY_GATE } = await import("../../portal-bot/src/adapters/recipeAdapter");
const { probeClickGates, preflightFinalSubmitSteps } = await import("../../scripts/demo-portal/gateProbe");
const { demoPortalRecipe } = await import("../../scripts/demo-portal/recipe");
const { demoOnlyDatabaseProblem, demoProjectProblem } = await import("../../scripts/demo-portal/guards");
const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

// ---- 1. which gate the ENGINE answers with ----------------------------------------------
{
  const recipe = demoPortalRecipe("http://127.0.0.1:9");
  const pre = await preflightFinalSubmitSteps(new RecipeAdapter(recipe, {}, {}, { autoSubmit: false }), recipe.steps, PAY_FEE_REPLAY_GATE);
  check("1a. the demo recipe's final submit is refused by the guided-manual final-submit rule",
    pre.observations.length === 1 && pre.observations[0].gate === "final-submit-guided-manual" && !pre.clickAttempted,
    JSON.stringify(pre.observations));
  check("1b. ...and not by the fee gate", pre.observations.every((o) => !o.feeGateMatched));

  const oldSteps = recipe.steps.map((s) => s.isFinalSubmit ? { ...s, note: `BLOCKED — human clicked a submit/pay-like control ("Submit application") here; not replayable.` } : s);
  const old = await preflightFinalSubmitSteps(new RecipeAdapter({ ...recipe, steps: oldSteps }, {}, {}, { autoSubmit: false }), oldSteps, PAY_FEE_REPLAY_GATE);
  check("1c. DISCRIMINATES: the recorder's 'submit/pay-like' wording is attributed to the FEE gate",
    old.observations.length === 1 && old.observations[0].gate === "fee-gate", JSON.stringify(old.observations));

  // A non-final click whose note says Submit: the submit-keyword block, which is neither of the two.
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
  const probe = probeClickGates(adapter, PAY_FEE_REPLAY_GATE);
  let clicked = false;
  try {
    await (adapter as unknown as { executeClick: (s: unknown, sc: unknown, p: boolean) => Promise<boolean> })
      .executeClick({ action: "click", selector: { css: "#x" }, note: "Submit" }, { click: async () => { clicked = true; } }, false);
  } finally { probe.restore(); }
  check("1d. DISCRIMINATES: an unflagged 'Submit' click is reported as another gate, never guessed into the two",
    probe.observations.length === 1 && probe.observations[0].gate === "other-refusal" && !clicked, JSON.stringify(probe.observations));
  check("1e. restore() leaves the engine's shared regex and the adapter uninstrumented",
    !Object.prototype.hasOwnProperty.call(PAY_FEE_REPLAY_GATE, "test") && !Object.prototype.hasOwnProperty.call(adapter, "executeClick"));
}

// ---- 1f. the recorder's own --selftest (the save gate + the same preflight, via its CLI) --------
{
  const r = spawnSync(process.execPath, [TSX_CLI, RECORDER, "--selftest"], { cwd: root, encoding: "utf8", timeout: 180_000, env: { ...process.env } });
  const out = String(r.stdout ?? "");
  check("1f. demo-record-portal --selftest passes, including the gate checks",
    r.status === 0 && /selftest passed/.test(out) && /refused by the guided-manual final-submit rule \(engine: final-submit-guided-manual\)/.test(out),
    `status=${r.status} ${out.split("\n").filter((l) => /FAIL/.test(l)).join(" | ")}`);
}

// ---- 2. the demo-only / demo-project guards, on rows written by the real paths --------------
const db = await openDatabase();
const demo = createClient(db, { companyName: "Solaris Demo Co", ccbLicenseNumber: "000000" });
const mk = (clientId: string, owner: string, zip: string) => createProject(db, {
  clientId, owner, street: "1 Test Way", city: "Salem", state: "OR", zip,
  ahj: "City of Salem", utility: "Portland General Electric", dcKw: "7", acKw: "5",
} as never).project;
const demoOk = mk(demo.id, "Demo Ok", "99999");
const demoWrongZip = mk(demo.id, "Demo Wrong Zip", "97301");
check("2a. a demo-only database passes", demoOnlyDatabaseProblem(db) === null, String(demoOnlyDatabaseProblem(db)));
check("2b. a demo project at ZIP 99999 passes", demoProjectProblem(db, demoOk.id) === null, String(demoProjectProblem(db, demoOk.id)));
check("2c. a demo-company project with a real ZIP is refused", /99999/.test(String(demoProjectProblem(db, demoWrongZip.id))));
check("2d. an unknown project id is refused", /does not exist/.test(String(demoProjectProblem(db, "no-such-project"))));
const real = createClient(db, { companyName: "Real Installer LLC", ccbLicenseNumber: "123456" });
const realProject = mk(real.id, "Real Homeowner", "99999");
check("2e. a second client makes the database not-demo", /besides/.test(String(demoOnlyDatabaseProblem(db))));
check("2f. another company's project is refused even at ZIP 99999", /does not belong/.test(String(demoProjectProblem(db, realProject.id))));
db.close();
{
  process.env.AUTOPILOT_DB_PATH = path.join(root, "no-demo.sqlite");
  const d = await openDatabase();
  createClient(d, { companyName: "Real Installer LLC", ccbLicenseNumber: "123456" });
  check("2g. a database with no demo company at all is refused", /no "Solaris Demo Co" company/.test(String(demoOnlyDatabaseProblem(d))));
  d.close();
}

// ---- 3. the CLI: refusal before any copy; cleanup after a thrown error --------------------------
const makeKit = (name: string): { kit: string; tmp: string } => {
  const kit = path.join(root, name);
  fs.mkdirSync(path.join(kit, "backend", "data"), { recursive: true });
  const tmp = path.join(root, `${name}-TEMP`); // the child's TEMP: where its demo-record-* dir would land
  fs.mkdirSync(tmp, { recursive: true });
  return { kit, tmp };
};
async function seedKit(kitDb: string, withOtherClient: boolean): Promise<string> {
  process.env.AUTOPILOT_DB_PATH = kitDb;
  const d = await openDatabase();
  const c = createClient(d, { companyName: "Solaris Demo Co", ccbLicenseNumber: "000000" });
  const p = createProject(d, {
    clientId: c.id, owner: "Kit Homeowner", street: "2 Test Way", city: "Salem", state: "OR", zip: "99999",
    ahj: "City of Salem", utility: "Portland General Electric", dcKw: "7", acKw: "5",
  } as never).project;
  if (withOtherClient) createClient(d, { companyName: "Real Installer LLC", ccbLicenseNumber: "123456" });
  d.close();
  return p.id;
}
const runRecorder = (kit: string, tmp: string, projectId: string) => spawnSync(process.execPath,
  [TSX_CLI, RECORDER, "--out", path.join(kit, "act4.webm"), "--project", projectId], {
    cwd: kit, encoding: "utf8", timeout: 240_000,
    env: {
      ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, AUTOPILOT_LOG_FILE: "",
      // A browser launch cannot succeed: there is no Chromium in this folder. That is the
      // thrown-after-the-copy exit path, reached without ever opening a browser.
      PLAYWRIGHT_BROWSERS_PATH: path.join(root, "no-browsers-here"),
      AUTOPILOT_DB_PATH: "",
    },
  });
const leftovers = (tmp: string): string[] => fs.readdirSync(tmp).filter((f) => f.startsWith("demo-record-"));
{
  const k = makeKit("kit-refused");
  const pid = await seedKit(path.join(k.kit, "backend", "data", "autopilot.sqlite"), true);
  const r = runRecorder(k.kit, k.tmp, pid);
  check("3a. a kit DB holding a non-demo client is REFUSED (exit 2) before recording",
    r.status === 2 && /REFUSED: .*besides "Solaris Demo Co"/.test(String(r.stderr ?? "")), `status=${r.status} stderr=${String(r.stderr ?? "").slice(-300)}`);
  check("3b. ...and nothing was copied to temp (the guard runs before the copy)", leftovers(k.tmp).length === 0, leftovers(k.tmp).join(", "));
  check("3c. ...and no video was written", !fs.existsSync(path.join(k.kit, "act4.webm")));
}
{
  const k = makeKit("kit-throws");
  const pid = await seedKit(path.join(k.kit, "backend", "data", "autopilot.sqlite"), false);
  const r = runRecorder(k.kit, k.tmp, pid);
  const err = String(r.stderr ?? "") + String(r.stdout ?? "");
  check("3d. a demo kit run that throws after the copy (no browser to launch) exits non-zero",
    r.status !== 0 && r.status !== null && !/REFUSED/.test(String(r.stderr ?? "")), `status=${r.status} tail=${err.slice(-300)}`);
  check("3e. ...it got past the guards and the preflight (so the copy really happened)", /preflight: the engine refuses the final submit by final-submit-guided-manual/.test(err), err.slice(-400));
  check("3f. ...and the temp dir with the DB copy is gone (finally ran)", leftovers(k.tmp).length === 0, leftovers(k.tmp).join(", "));
  check("3g. ...and no video was written", !fs.existsSync(path.join(k.kit, "act4.webm")));
}

process.chdir(REPO);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp; best effort */ }
console.log(failures ? `\ndemoRecorderGuards: ${failures} FAILED` : "\ndemoRecorderGuards: all checks passed");
process.exit(failures ? 1 : 0);
