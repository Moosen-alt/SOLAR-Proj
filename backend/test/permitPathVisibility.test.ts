// THE OPERATOR COULD SEE THE PERMIT PATH'S CONCLUSION BUT NEVER ITS EVIDENCE.
//
// Prescriptive and engineered are mutually exclusive — the AHJ takes exactly one
// application — so resolvePermitPath decides which application is built, which fee
// schedule applies and whether a PE stamp is required. Until now that resolution reached
// the operator only as a sentence folded into `permitType` and as bullets inside the
// generated cover/manifest MARKDOWN: you could read what was decided, but not what decided
// it, and a misparsed wind speed or a misread stamp recommendation travelled all the way
// into the filing with nothing on the project screen to catch it.
//
// The operator ruling for Coos Bay (2026-09-19) kept the STRICT split and asked for
// visibility only: the resolved path, the evidence it came from, and the existing operator
// override, on the project screen. This file holds that surface in place — the package
// carries the resolution STRUCTURALLY, and the dashboard renders path + source + evidence
// with an escape on every interpolation and a link to the override that already exists.
//
// NO PATH LOGIC IS TESTED HERE beyond "the package reports what resolvePermitPath decided".
// The split itself is permitPath.ts's business and is not re-litigated.
//
// Run: tsx backend/test/permitPathVisibility.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "permit-path-vis-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.MONITOR_INTERVAL_MINUTES = "0";

const { openDatabase } = await import("../src/db");
const { createProject, getProjectDetail } = await import("../src/repository");
const { buildApplicationDocumentPackage } = await import("../src/applicationDocs");
const { resolvePermitPath } = await import("../src/permitPath");

let failures = 0;
const check = (name: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${name}`); }
  catch (err) { failures++; console.error(`  FAIL - ${name}\n         ${(err as Error).message}`); }
};

const db = await openDatabase();

// Built from the live Coos Bay shape: a coastal microinverter roof mount. The ruling this
// panel serves is the Coos Bay strict split, so the fixture is a Coos Bay project.
const mk = (owner: string, snapshot: Record<string, string>): string => {
  const { project } = createProject(db, {
    owner, street: `${owner} Way`, city: "Coos Bay", state: "OR", zip: "97420",
    ahj: "City of Coos Bay", utility: "Pacific Power", dcKw: "3.52", acKw: "3.072",
    ...snapshot,
  });
  return project.id;
};

const pkgFor = (projectId: string) => {
  const detail = getProjectDetail(db, projectId);
  return buildApplicationDocumentPackage(detail.project, null);
};

const prescriptiveId = mk("Prescriptive Owner", {
  mounting: "roof-mounted", pvMicroMake: "AP Systems", pvMicroModel: "DS3-L",
  snow: "25", deadLoad: "3.1", roofRafterSpacing: "24", wind: "B", windSpeed: "98",
});
const overriddenId = mk("Override Owner", { permitPathOverride: "engineered" });
const screenFailId = mk("Coastal Owner", {
  mounting: "roof-mounted", pvMicroMake: "AP Systems", pvMicroModel: "DS3-L",
  snow: "25", deadLoad: "3.1", roofRafterSpacing: "24", wind: "C", windSpeed: "150",
});
const undecidedId = mk("Undecided Owner", { mounting: "" });

check("the package reports the path STRUCTURALLY, not only inside prose", () => {
  const pkg = pkgFor(prescriptiveId);
  assert.ok(pkg.permitPath, "ApplicationDocumentPackage.permitPath is absent — the screen has nothing to render");
  assert.equal(pkg.permitPath!.path, "prescriptive");
  assert.ok(typeof pkg.permitPath!.source === "string" && pkg.permitPath!.source.length > 0);
  assert.ok(Array.isArray(pkg.permitPath!.basis));
});

check("what the package reports is exactly what resolvePermitPath decided", () => {
  for (const id of [prescriptiveId, overriddenId, screenFailId, undecidedId]) {
    const detail = getProjectDetail(db, id);
    const truth = resolvePermitPath(detail.project);
    const reported = pkgFor(id).permitPath!;
    assert.equal(reported.path, truth.path, `${id}: package says ${reported.path}, resolver says ${truth.path}`);
    assert.equal(reported.source, truth.source, `${id}: package says ${reported.source}, resolver says ${truth.source}`);
    assert.deepEqual(reported.basis, truth.basis, `${id}: evidence differs from the resolver's`);
  }
});

check("THE EVIDENCE IS CARRIED, not summarized away", () => {
  // An operator override and a screen failure must each say WHY in their own words —
  // a panel with an empty evidence list is the state this round existed to remove.
  const overridden = pkgFor(overriddenId).permitPath!;
  assert.equal(overridden.path, "engineered");
  assert.equal(overridden.source, "operator");
  assert.ok(overridden.basis.some((b) => /operator/i.test(b)), JSON.stringify(overridden.basis));

  const coastal = pkgFor(screenFailId).permitPath!;
  assert.equal(coastal.source, "structural-screen");
  assert.ok(coastal.basis.some((b) => /wind speed/i.test(b)),
    `the screen's own reason is missing: ${JSON.stringify(coastal.basis)}`);
});

check("an UNDECIDED path is reported as undecided, never defaulted into a path", () => {
  const undecided = pkgFor(undecidedId).permitPath!;
  assert.equal(undecided.path, "unknown", `an input-less project resolved ${undecided.path}`);
  assert.ok(undecided.basis.length, "an undecided path with no explanation reads as an oversight");
});

check("mutating the returned basis cannot reach back into the resolver's array", () => {
  const pkg = pkgFor(prescriptiveId);
  pkg.permitPath!.basis.push("INJECTED");
  const fresh = pkgFor(prescriptiveId);
  assert.ok(!fresh.permitPath!.basis.includes("INJECTED"), "the package hands out a live reference to the resolution");
});

// ═══════════════════════════════════════════════════════════════════════════════
// The screen. Source assertions — the same shape correctionDesignerWait.test.ts uses to
// hold a frontend surface in place without a browser.
// ═══════════════════════════════════════════════════════════════════════════════

const dashboard = fs.readFileSync(path.resolve(process.cwd(), "frontend/dashboard.js"), "utf8");

check("the project screen renders the path panel", () => {
  assert.match(dashboard, /function renderPermitPathPanel\(/,
    "renderPermitPathPanel is gone — the resolved path is invisible on the project screen again");
  assert.match(dashboard, /\$\("applicationDocs"\)\.innerHTML = `\s*\n\s*\$\{renderPermitPathPanel\(pkg\)\}/,
    "the panel exists but is not rendered into the project screen — a function with no production caller");
});

check("the panel shows the path, WHO decided it, and the evidence", () => {
  const panel = dashboard.slice(dashboard.indexOf("function renderPermitPathPanel("), dashboard.indexOf("function gotoPermitPathOverride("));
  assert.ok(panel.length > 400, "renderPermitPathPanel could not be isolated");
  assert.match(panel, /res\.source/, "the panel never says who decided the path");
  assert.match(panel, /res\.basis/, "the panel never shows the evidence sentences");
  assert.match(panel, /Resolved path/, "the panel never names the resolved path");
});

check("every interpolation into innerHTML is escaped", () => {
  const panel = dashboard.slice(dashboard.indexOf("function renderPermitPathPanel("), dashboard.indexOf("function gotoPermitPathOverride("));
  // Basis strings come from the plan set (stamp-recommendation text is quoted verbatim into
  // them), so an unescaped one is an injection straight off an uploaded PDF.
  const interpolations = [...panel.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
  const unescaped = interpolations.filter((expr) =>
    !expr.startsWith("esc(") && !expr.startsWith("bandHead(")
    && !/^basis\.length \?/.test(expr) && !/^res\.source === "operator" \?/.test(expr)
    && !/\besc\(/.test(expr));
  assert.deepEqual(unescaped, [], `unescaped interpolation(s) in the path panel: ${JSON.stringify(unescaped)}`);
});

check("the panel reuses the EXISTING override instead of adding a second one", () => {
  assert.match(dashboard, /function gotoPermitPathOverride\(/, "the jump to the override is gone");
  assert.match(dashboard, /gotoPermitPathOverride[\s\S]{0,400}\$\("manualPermitPath"\)/,
    "the panel no longer points at the existing manualPermitPath control");
  const html = fs.readFileSync(path.resolve(process.cwd(), "frontend/dashboard.html"), "utf8");
  assert.equal((html.match(/id="manualPermitPath"/g) || []).length, 1,
    "there is no longer exactly one permit-path override control on the page");
  assert.match(dashboard, /data-goto-permit-path[\s\S]{0,4000}addEventListener\("click", gotoPermitPathOverride\)/,
    "the panel's override button is rendered but never wired");
});

check("a package that predates the field says so rather than rendering blank", () => {
  const panel = dashboard.slice(dashboard.indexOf("function renderPermitPathPanel("), dashboard.indexOf("function gotoPermitPathOverride("));
  assert.match(panel, /if \(!res\)/, "an absent resolution is not handled");
  assert.match(panel, /rebuild the AHJ docs/i,
    "an absent resolution renders nothing, which reads as \"no path concerns\" — an unknown must never read as reassurance");
});

if (failures) {
  console.error(`\npermitPathVisibility: ${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\npermitPathVisibility: all checks passed.");
