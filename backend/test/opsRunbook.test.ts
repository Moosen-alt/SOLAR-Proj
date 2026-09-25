// THE RUNBOOK NAMES ONLY THINGS THAT EXIST.
//
// docs/OPERATIONS.md is what an operator types from, at 2 a.m., after a power cut. A script path
// that moved, a flag that was renamed, or a setting nothing reads is a command that fails — or
// worse, a setting that silently does nothing. This pins every scripts/ops path, every flag the
// runbook passes to those scripts, and every BACKUP_*/WATCHDOG_*/OFFBOX_* setting it names, against
// the code. MUST-EXCLUDE: a made-up flag or setting is caught (self-check at the bottom).
// Run: npx tsx backend/test/opsRunbook.test.ts
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const doc = fs.readFileSync(path.join(REPO, "docs", "OPERATIONS.md"), "utf8");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");
const codeCorpus = [
  ...fs.readdirSync(path.join(REPO, "scripts", "ops")).map((f) => read(path.join("scripts", "ops", f))),
  read("backend/src/backup.ts"), read("backend/src/offboxBackup.ts"), read("backend/src/auth.ts"),
  read("backend/src/server.ts"), read("backend/src/clientNotifier.ts"),
].join("\n");

/** Every `scripts/ops/<file>` or `scripts\ops\<file>` the runbook mentions. */
const scriptRefs = [...new Set([...doc.matchAll(/scripts[\\/]ops[\\/]([\w.-]+\.(?:ts|ps1|psm1))/g)].map((m) => m[1]))];
check(`the runbook references ${scriptRefs.length} ops scripts, and every one exists`, () => {
  assert.ok(scriptRefs.length >= 8, `only ${scriptRefs.length} found`);
  for (const f of scriptRefs) assert.ok(fs.existsSync(path.join(REPO, "scripts", "ops", f)), `missing scripts/ops/${f}`);
});

/** Flags passed to a named script on the same line: `<script> ... --flag` / `-Flag`. */
function flagsUsedWith(script: string): string[] {
  const out = new Set<string>();
  for (const lineText of doc.split(/\r?\n/)) {
    const i = lineText.indexOf(script);
    if (i < 0) continue;
    const rest = lineText.slice(i + script.length).split("#")[0];
    for (const m of rest.matchAll(/(?:^|\s)(--?[A-Za-z][\w-]*)/g)) out.add(m[1]);
  }
  return [...out];
}
const COMMON = new Set(["-WhatIf", "-ExecutionPolicy", "-File", "-NoProfile", "-Confirm"]);
function assertFlagsExist(script: string, flags: string[]): void {
  const src = read(path.join("scripts", "ops", script));
  for (const f of flags) {
    if (COMMON.has(f)) continue;
    if (f.startsWith("--")) assert.ok(src.includes(`"${f}"`) || src.includes(`--${f.slice(2)}`) || src.includes(`flag("${f.slice(2)}")`), `${script} does not accept ${f}`);
    else assert.ok(new RegExp(`\\$${f.slice(1)}\\b`, "i").test(src), `${script} has no parameter ${f}`);
  }
}
for (const script of scriptRefs.filter((s) => !s.endsWith(".psm1"))) {
  const flags = flagsUsedWith(script);
  check(`${script}: every flag the runbook passes exists (${flags.join(" ") || "none"})`, () => assertFlagsExist(script, flags));
}

const settings = [...new Set([...doc.matchAll(/\b((?:BACKUP|WATCHDOG|OFFBOX)_[A-Z_]+)\b/g)].map((m) => m[1]))];
check(`every BACKUP_/WATCHDOG_/OFFBOX_ setting the runbook names (${settings.length}) is read by the code`, () => {
  const unread = settings.filter((s) => !new RegExp(`(process\\.env|env)\\.${s}\\b|env\\[?"${s}"|"${s}"`).test(codeCorpus));
  assert.deepEqual(unread, []);
});

check("MUST-EXCLUDE (self-check): a made-up flag and a made-up setting are caught", () => {
  assert.throws(() => assertFlagsExist("watchdog.ts", ["--page-the-ceo"]));
  assert.throws(() => assertFlagsExist("install-autostart.ps1", ["-TurboMode"]));
  assert.ok(!new RegExp("(process\\.env|env)\\.WATCHDOG_MADE_UP\\b").test(codeCorpus));
});

if (failures) { console.error(`\n${failures} runbook check(s) FAILED.`); process.exit(1); }
console.log("\nAll runbook checks passed.");
