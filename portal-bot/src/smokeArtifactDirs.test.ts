// A HAND-RUN SMOKE MUST NOT WRITE INTO, OR PRUNE, data/.
//
// Pins smokeArtifactDirs.ts (foundation verdict, caveat b):
//   MUST-PASS: env absent -> every artifact var points under the OS temp folder, never data/;
//              a var already set elsewhere (the runner's per-smoke folder) is left untouched.
//   MUST-EXCLUDE: a var pointing INSIDE <cwd>/data (a developer shell that exported
//              AUTOLEARN_RUN_DIR=data/learn-runs) is overridden, as the runner does.
//   DISCOVERY: every learn-driving DOM smoke under portal-bot/src (it imports the learner or its
//              debug-bundle writer) imports smokeArtifactDirs BEFORE that import. A new smoke
//              that forgets it fails here, not by evicting a real bundle.
//
//   npx tsx portal-bot/src/smokeArtifactDirs.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSmokeArtifactDirs, SMOKE_ARTIFACT_ENV } from "./smokeArtifactDirs";

let failures = 0;
let passes = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); passes++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA = path.join(REPO, "data");
const under = (p: string, dir: string): boolean => {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
};

check("MUST-PASS: with no artifact env at all, every var points under the OS temp folder, none under data/", () => {
  const env: Record<string, string | undefined> = {};
  const r = defaultSmokeArtifactDirs(env, { cwd: REPO });
  assert.equal(r.set.length, SMOKE_ARTIFACT_ENV.length);
  for (const k of SMOKE_ARTIFACT_ENV) {
    assert.ok(env[k], `${k} unset`);
    assert.ok(under(env[k]!, os.tmpdir()), `${k}=${env[k]} is not under ${os.tmpdir()}`);
    assert.ok(!under(env[k]!, DATA), `${k}=${env[k]} is under data/`);
  }
  if (r.root) fs.rmSync(r.root, { recursive: true, force: true });
});

check("MUST-PASS: a var the runner already set elsewhere is untouched (and nothing else is created when all are set)", () => {
  const env: Record<string, string | undefined> = {};
  for (const k of SMOKE_ARTIFACT_ENV) env[k] = path.join(os.tmpdir(), "runner-owned", k);
  const before = { ...env };
  const r = defaultSmokeArtifactDirs(env, { cwd: REPO });
  assert.deepEqual(env, before);
  assert.equal(r.root, null);
});

check("MUST-EXCLUDE: a var pointing inside data/ (absolute or relative) is redirected to temp; an empty one counts as unset", () => {
  const env: Record<string, string | undefined> = {
    AUTOLEARN_RUN_DIR: "data/learn-runs",
    REPLAY_RUN_DIR: path.join(DATA, "replay-runs"),
    REPLAY_CAPTURE_DIR: "",
    PORTAL_SCREENSHOT_DIR: path.join(os.tmpdir(), "kept-screens"),
    POWERCLERK_DEBUG_DIR: DATA,
  };
  const r = defaultSmokeArtifactDirs(env, { cwd: REPO });
  assert.deepEqual([...r.set].sort(), ["AUTOLEARN_RUN_DIR", "POWERCLERK_DEBUG_DIR", "REPLAY_CAPTURE_DIR", "REPLAY_RUN_DIR"]);
  for (const k of r.set) assert.ok(!under(env[k]!, DATA), `${k} still under data/`);
  assert.equal(env.PORTAL_SCREENSHOT_DIR, path.join(os.tmpdir(), "kept-screens"));
  if (r.root) fs.rmSync(r.root, { recursive: true, force: true });
});

check("MUST-EXCLUDE: a sibling folder whose name merely STARTS with 'data' is not data/", () => {
  const env: Record<string, string | undefined> = {};
  for (const k of SMOKE_ARTIFACT_ENV) env[k] = path.join(REPO, "data-export", k);
  assert.equal(defaultSmokeArtifactDirs(env, { cwd: REPO }).set.length, 0);
});

check("importing the module applied the defaults to this process (process.env points outside data/)", () => {
  for (const k of SMOKE_ARTIFACT_ENV) {
    assert.ok(process.env[k], `${k} unset after import`);
    assert.ok(!under(process.env[k]!, DATA), `${k}=${process.env[k]} is under data/`);
  }
});

// DISCOVERY: every learn-driving DOM smoke imports the defaults before the learner.
// A static import of the learner or its debug-bundle writer, or a dynamic import() of either.
const LEARN_IMPORT = /^import\b[^;]*from\s+["'][^"']*\/(autoLearnAdapter|learnDebug)["']|import\(\s*["'][^"']*\/(autoLearnAdapter|learnDebug)["']\s*\)/m;
const DEFAULTS_IMPORT = /^import\s+["'][^"']*\/smokeArtifactDirs["'];?/m;
const smokes: string[] = [];
const walk = (dir: string): void => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/(\.dom\.smoke|Dom\.smoke)\.ts$/.test(e.name)) smokes.push(full);
  }
};
walk(path.join(REPO, "portal-bot", "src"));
const learnDriving = smokes.filter((f) => LEARN_IMPORT.test(fs.readFileSync(f, "utf8")));
check(`DISCOVERY: every learn-driving DOM smoke (${learnDriving.length} of ${smokes.length} smokes) imports smokeArtifactDirs before the learner`, () => {
  assert.ok(learnDriving.length > 0, "found no learn-driving smoke — the discovery regex is broken");
  const offenders: string[] = [];
  for (const f of learnDriving) {
    const src = fs.readFileSync(f, "utf8");
    const d = DEFAULTS_IMPORT.exec(src);
    const l = LEARN_IMPORT.exec(src);
    if (!d || !l || d.index > l.index) offenders.push(path.relative(REPO, f));
  }
  assert.deepEqual(offenders, [], `these smokes can write into data/learn-runs when run by hand:\n           ${offenders.join("\n           ")}`);
});

// DISCOVERY (unit tests): a plain .test.ts that CONSTRUCTS the learner writes a debug bundle too
// (LearnRunDebug.start runs in the constructor) and prunes data/learn-runs to its newest 20.
// acaCustomDomain.test and typedUploadCards.test landed 20 fixture folders there on 2026-09-26
// and pushed real bundles out. Such a test imports smokeArtifactDirs before the learner, or
// points AUTOLEARN_RUN_DIR somewhere itself (autoLearnAdapter.test's scratch base).
const CONSTRUCTS_LEARNER = /\bnew\s+AutoLearnAdapter\s*\(|\bLearnRunDebug\.start\s*\(|\blearnPortal\s*\(/;
const OWN_RUN_DIR = /process\.env\.AUTOLEARN_RUN_DIR\s*=(?!=)/;
const unitTests: string[] = [];
const walkTests = (dir: string): void => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkTests(full);
    else if (/\.test\.ts$/.test(e.name)) unitTests.push(full);
  }
};
walkTests(path.join(REPO, "portal-bot", "src"));
const constructing = unitTests.filter((f) => CONSTRUCTS_LEARNER.test(fs.readFileSync(f, "utf8")));
check(`DISCOVERY: every unit test that constructs the learner (${constructing.length} of ${unitTests.length}) keeps its debug bundle out of data/`, () => {
  assert.ok(constructing.length >= 2, "found fewer than 2 learner-constructing tests — the discovery regex is broken");
  const offenders: string[] = [];
  for (const f of constructing) {
    const src = fs.readFileSync(f, "utf8");
    if (OWN_RUN_DIR.test(src)) continue;
    const d = DEFAULTS_IMPORT.exec(src);
    const l = LEARN_IMPORT.exec(src);
    if (!d || (l && d.index > l.index)) offenders.push(path.relative(REPO, f));
  }
  assert.deepEqual(offenders, [], `these unit tests write into data/learn-runs:\n           ${offenders.join("\n           ")}`);
});

console.log(failures === 0
  ? `\nAll ${passes} smoke-artifact-dir checks passed.`
  : `\n${failures} of ${passes + failures} smoke-artifact-dir check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
