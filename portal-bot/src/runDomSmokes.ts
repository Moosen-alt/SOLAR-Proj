// A CHAIN THAT CAN HANG IS NOT A SAFETY NET.
//
// `portal:test:dom` is sixty smokes joined with `&&`. One that hangs takes the other
// fifty-nine with it, silently: replica.dom.smoke sat for fifty minutes on 2026-09-08 with
// four orphaned browsers behind it, and the run had to be killed, which is where orphaned
// browsers come from in the first place.
//
// This runs the same list, each smoke in its own process with its own time budget, and
// prints one line per smoke and a summary at the end. A hang becomes a reported TIMEOUT on
// one row instead of an absent answer for all of them.
//
//   npx tsx portal-bot/src/runDomSmokes.ts                 # all of them
//   npx tsx portal-bot/src/runDomSmokes.ts --from replica  # resume at the first match
//   npx tsx portal-bot/src/runDomSmokes.ts --only combobox --timeout 240
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PKG = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const CHAIN = String(PKG.scripts?.["portal:test:dom"] ?? "");
const SMOKES = CHAIN.split("&&")
  .map((part) => part.trim().replace(/^tsx\s+/, ""))
  .filter((p) => p.endsWith(".ts"));

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = arg("only");
const from = arg("from");
// Per-smoke budget. Generous — the point is to bound a hang, not to police slowness.
const TIMEOUT_MS = Number(arg("timeout") ?? 300) * 1000;

let list = SMOKES;
if (from) {
  const i = list.findIndex((s) => s.includes(from));
  if (i >= 0) list = list.slice(i);
}
if (only) list = list.filter((s) => s.includes(only));

const runOne = (file: string): Promise<{ code: number | null; timedOut: boolean; tail: string }> =>
  new Promise((resolve) => {
    const child = spawn("npx", ["tsx", file], { shell: true });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // The BANNER is the truth, not the exit code — a piped or wrapped run reports the
      // status of whatever ran last. Keep the tail so a failure is diagnosable from here.
      const lines = out.split("\n").filter((l) => l.trim());
      resolve({ code, timedOut, tail: lines.slice(-6).join("\n") });
    });
  });

console.log(`running ${list.length} dom smoke(s), ${TIMEOUT_MS / 1000}s each\n`);
const failed: string[] = [];
const hung: string[] = [];
for (let i = 0; i < list.length; i++) {
  const file = list[i];
  const name = path.basename(file);
  const t0 = Date.now();
  const res = await runOne(file);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (res.timedOut) {
    hung.push(name);
    console.log(`${String(i + 1).padStart(2)}/${list.length} TIMEOUT ${name} (${secs}s)`);
  } else if (res.code === 0) {
    console.log(`${String(i + 1).padStart(2)}/${list.length} ok      ${name} (${secs}s)`);
  } else {
    failed.push(name);
    console.log(`${String(i + 1).padStart(2)}/${list.length} FAIL    ${name} (${secs}s)`);
    console.log(res.tail.split("\n").map((l) => `        ${l}`).join("\n"));
  }
}

console.log(`\n${list.length - failed.length - hung.length}/${list.length} passed`);
if (failed.length) console.log(`FAILED: ${failed.join(", ")}`);
if (hung.length) console.log(`TIMED OUT: ${hung.join(", ")}`);
process.exit(failed.length || hung.length ? 1 : 0);
