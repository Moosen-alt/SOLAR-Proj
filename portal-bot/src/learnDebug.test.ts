import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Tests for the per-run learn debug bundle. All filesystem work is pointed at a
// temp dir via AUTOLEARN_RUN_DIR so the repo's data/ is never touched.
// Run: npm run portal:test:unit

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "learn-debug-test-"));
process.env.AUTOLEARN_RUN_DIR = tmpBase;
delete process.env.AUTOLEARN_RUN_DEBUG;

const { LearnRunDebug } = await import("./learnDebug");

function test(name: string, fn: () => void | Promise<void>): [string, () => void | Promise<void>] {
  return [name, fn];
}

const tests: Array<[string, () => void | Promise<void>]> = [
  test("start() creates the run folder with a manifest + config snapshot", () => {
    const dbg = LearnRunDebug.start("City of Testville Portal", { maxPages: 18 });
    assert.ok(dbg, "recorder should start");
    assert.ok(fs.existsSync(dbg!.dir), "run dir exists");
    const manifest = JSON.parse(fs.readFileSync(path.join(dbg!.dir, "run.json"), "utf8"));
    assert.equal(manifest.portalName, "City of Testville Portal");
    assert.equal(manifest.finished, false);
    assert.equal(manifest.maxPages, 18);
    assert.ok(manifest.config && typeof manifest.config.node === "string", "config snapshot present");
    assert.ok(!JSON.stringify(manifest).includes("sk-ant-"), "no secrets in manifest");
  }),

  test("events append as JSONL and artifacts write as JSON", () => {
    const dbg = LearnRunDebug.start("evt-portal")!;
    dbg.event({ type: "page", trace: "p1 form fields=10" });
    dbg.event({ type: "recovery_attempt", n: 1 });
    dbg.writeJson("p001-plan.json", { page: 1, decisions: [] });
    const lines = fs.readFileSync(path.join(dbg.dir, "events.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.type, "page");
    assert.ok(typeof first.t === "string" && typeof first.ms === "number", "events are timestamped");
    assert.ok(fs.existsSync(path.join(dbg.dir, "p001-plan.json")), "artifact written");
  }),

  test("finalize() completes the manifest and the FIRST summary wins", () => {
    const dbg = LearnRunDebug.start("fin-portal")!;
    dbg.finalize({ outcome: "failed", ok: false, message: "specific failure" });
    dbg.finalize({ outcome: "ok", ok: true, message: "generic overwrite attempt" });
    const manifest = JSON.parse(fs.readFileSync(path.join(dbg.dir, "run.json"), "utf8"));
    assert.equal(manifest.finished, true);
    assert.equal(manifest.outcome, "failed", "first finalize wins");
    assert.equal(manifest.message, "specific failure");
    assert.ok(typeof manifest.durationMs === "number");
  }),

  test("screenshot()/trace tolerate fake pages with no Playwright surface", async () => {
    const dbg = LearnRunDebug.start("fake-page-portal")!;
    await dbg.screenshot(null, "p001-before");
    await dbg.screenshot({} as unknown, "p001-before");
    await dbg.startTrace({} as unknown);
    await dbg.stopTrace({} as unknown);
    assert.ok(true, "no throw on fakes");
  }),

  test("AUTOLEARN_RUN_DEBUG=0 disables the recorder entirely", () => {
    process.env.AUTOLEARN_RUN_DEBUG = "0";
    try {
      assert.equal(LearnRunDebug.start("disabled-portal"), null);
    } finally {
      delete process.env.AUTOLEARN_RUN_DEBUG;
    }
  }),

  test("retention pruning keeps only the newest AUTOLEARN_RUN_KEEP runs", () => {
    process.env.AUTOLEARN_RUN_KEEP = "3";
    try {
      // A fresh base so runs created by earlier tests don't skew the count.
      const pruneBase = fs.mkdtempSync(path.join(os.tmpdir(), "learn-debug-prune-"));
      process.env.AUTOLEARN_RUN_DIR = pruneBase;
      // Pre-seed old runs with name-sortable timestamps (runIds sort chronologically).
      for (let i = 0; i < 5; i++) {
        fs.mkdirSync(path.join(pruneBase, `2020-01-0${i + 1}_00-00-00_old_${i}`), { recursive: true });
      }
      LearnRunDebug.start("prune-portal");
      const remaining = fs.readdirSync(pruneBase).sort();
      assert.equal(remaining.length, 3, `expected 3 dirs, got: ${remaining.join(", ")}`);
      assert.ok(remaining[2].includes("prune-portal"), "the new run survives pruning");
      fs.rmSync(pruneBase, { recursive: true, force: true });
    } finally {
      delete process.env.AUTOLEARN_RUN_KEEP;
      process.env.AUTOLEARN_RUN_DIR = tmpBase;
    }
  }),
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   - ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL - ${name}`);
    console.error(err);
  }
}

fs.rmSync(tmpBase, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} learn-debug test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} learn-debug tests passed.`);
