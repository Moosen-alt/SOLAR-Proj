// LOCAL ENVIRONMENT DOCTOR — checks that this machine can run SOLAR-Proj and the agent workflow,
// and prints the exact command that fixes each problem.
//
//   node scripts/doctor.mjs          fast checks (a few seconds)
//   node scripts/doctor.mjs --full   also runs typecheck and one unit test
//
// Plain .mjs on purpose, not .ts: the most common local breakage is esbuild (which tsx runs on)
// or better-sqlite3 failing to install, and a doctor that needs tsx could not diagnose its own
// problem. Works on Windows (cmd / PowerShell), macOS and Linux. Changes nothing; it only reads.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));
const FULL = process.argv.includes("--full");
const WIN = process.platform === "win32";
const INSTALL = "npm ci";

const results = [];
const ok = (name, detail) => results.push({ level: "ok", name, detail });
const warn = (name, detail, fix) => results.push({ level: "warn", name, detail, fix });
const bad = (name, detail, fix) => results.push({ level: "FIX", name, detail, fix });

/** Run a command. A bare name (npm, gh, claude) goes through the shell on Windows so its .cmd shim
 *  resolves; an absolute path (node itself) never does, because the shell would split
 *  "C:\Program Files\nodejs\node.exe" at the space. */
const run = (cmd, args, opts = {}) => {
  const shell = WIN && !path.isAbsolute(cmd);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell, timeout: opts.timeout ?? 30_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), error: r.error };
};
const has = (cmd) => { const r = run(cmd, ["--version"]); return r.code === 0 ? r.out.split(/\r?\n/)[0] : null; };

// --- Tools -------------------------------------------------------------------------------------
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) bad("Node.js", `v${process.versions.node}; this project needs 20 or newer (CI uses 22)`, "Install Node 22 LTS from https://nodejs.org, then reopen the terminal");
else if (major !== 22) warn("Node.js", `v${process.versions.node}; works, but CI uses 22, so a result here may differ from CI`, "Optional: install Node 22 LTS from https://nodejs.org");
else ok("Node.js", `v${process.versions.node}`);

const npmV = has("npm");
npmV ? ok("npm", npmV) : bad("npm", "not found on PATH", "Reinstall Node.js (npm ships with it)");

const gitV = has("git");
if (!gitV) bad("git", "not found on PATH", WIN ? "winget install --id Git.Git -e   (then reopen the terminal)" : "Install git");
else {
  ok("git", gitV);
  const who = run("git", ["config", "user.email"]).out;
  who ? ok("git identity", who) : warn("git identity", "user.email is not set, so commits will be refused", 'git config --global user.name "Your Name"  and  git config --global user.email you@example.com');
}

// --- The repository ----------------------------------------------------------------------------
if (gitV) {
  const origin = run("git", ["remote", "get-url", "origin"]).out;
  /moosen-alt\/solar-proj/i.test(origin) ? ok("git remote", origin) : warn("git remote", `origin is "${origin || "(none)"}", expected github.com/Moosen-alt/SOLAR-Proj`, "git remote set-url origin https://github.com/Moosen-alt/SOLAR-Proj.git");
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  const hasMain = run("git", ["ls-remote", "--exit-code", "--heads", "origin", "main"], { timeout: 20_000 }).code === 0;
  if (hasMain && branch !== "main") warn("branch", `you are on "${branch}"; the trunk is main`, "git fetch origin  &&  git checkout main  &&  git pull");
  else ok("branch", `${branch}${hasMain ? "" : " (origin has no main yet; that's expected until setup creates it)"}`);
  const dirty = run("git", ["status", "--porcelain"]).out;
  dirty ? warn("working tree", `${dirty.split(/\r?\n/).length} uncommitted change(s)`, "git status   (commit, stash, or discard before pulling)") : ok("working tree", "clean");
}

// --- Dependencies ------------------------------------------------------------------------------
if (!fs.existsSync(path.join(ROOT, "node_modules"))) {
  bad("node_modules", "missing: dependencies are not installed", INSTALL);
} else {
  ok("node_modules", "present");
  try {
    const Database = require("better-sqlite3");
    new Database(":memory:").prepare("select 1 as x").get();
    ok("better-sqlite3", "native module loads");
  } catch (e) {
    bad("better-sqlite3", `does not load: ${String(e.message).split("\n")[0]}`,
      `${INSTALL}   (its install script builds the native part; npm skips install scripts unless allowed)`);
  }
  try {
    require("esbuild").transformSync("const a: number = 1", { loader: "ts" });
    ok("esbuild", "works (tsx depends on it)");
  } catch (e) {
    bad("esbuild", `does not work: ${String(e.message).split("\n")[0]}`, INSTALL);
  }
  const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsx)) bad("tsx", "missing", INSTALL);
  else {
    const r = run(process.execPath, [tsx, "-e", "console.log('tsx-ok')"]);
    r.out.includes("tsx-ok") ? ok("tsx", "runs TypeScript") : bad("tsx", `cannot run: ${r.out.split(/\r?\n/)[0]}`, INSTALL);
  }
  try {
    const exe = require("playwright").chromium.executablePath();
    fs.existsSync(exe) ? ok("Playwright Chromium", "installed (DOM smokes and live portal work)")
      : warn("Playwright Chromium", "not installed; only needed for `npm run portal:test:dom` and live portal work", "npm run portal:install");
  } catch {
    warn("Playwright Chromium", "playwright package not loadable", INSTALL);
  }
}

// --- Optional tools for the owner and the agent workflow -----------------------------------------
fs.existsSync(path.join(ROOT, ".env")) ? ok(".env", "present (only needed to run the server)")
  : warn(".env", "missing; only needed to run the server, not for tests", WIN ? "copy .env.example .env   (then fill in the values)" : "cp .env.example .env");

const ghV = has("gh");
if (!ghV) warn("GitHub CLI (gh)", "not installed; used for the owner commands in docs/OWNER_SETUP.md", WIN ? "winget install --id GitHub.cli -e   then: gh auth login" : "Install https://cli.github.com, then: gh auth login");
else run("gh", ["auth", "status"]).code === 0 ? ok("GitHub CLI (gh)", `${ghV}, signed in`) : warn("GitHub CLI (gh)", "installed but not signed in", "gh auth login");

const claudeV = has("claude");
claudeV ? ok("Claude Code", claudeV) : warn("Claude Code", "not on PATH", "npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code");

// --- Optional: the real thing ------------------------------------------------------------------
if (FULL && !results.some((r) => r.level === "FIX" && ["node_modules", "tsx", "esbuild", "better-sqlite3"].includes(r.name))) {
  const t = run("npm", ["run", "typecheck"], { timeout: 300_000 });
  t.code === 0 ? ok("typecheck", "clean") : bad("typecheck", "errors (see `npm run typecheck`)", "npm run typecheck");
  const u = run("npm", ["run", "backend:test:unit", "--", "--only", "schedulerState"], { timeout: 300_000 });
  u.code === 0 ? ok("unit test runner", "a backend suite runs and passes") : bad("unit test runner", "a sample suite failed (see output of the fix command)", "npm run backend:test:unit -- --only schedulerState");
}

// --- Report ------------------------------------------------------------------------------------
const width = Math.max(...results.map((r) => r.name.length));
console.log(`\nSOLAR-Proj doctor (${process.platform}, ${ROOT})\n`);
for (const r of results) {
  console.log(`  ${r.level.padEnd(4)} ${r.name.padEnd(width)}  ${r.detail}`);
  if (r.fix) console.log(`  ${"".padEnd(4)} ${"".padEnd(width)}  -> ${r.fix}`);
}
const fixes = results.filter((r) => r.level === "FIX").length;
const warns = results.filter((r) => r.level === "warn").length;
console.log(`\n${fixes ? `${fixes} thing(s) to FIX` : "Nothing to fix"}${warns ? `, ${warns} warning(s)` : ""}.${FULL ? "" : " Run with --full to also typecheck and run a test."}\n`);
process.exit(fixes ? 1 : 0);
