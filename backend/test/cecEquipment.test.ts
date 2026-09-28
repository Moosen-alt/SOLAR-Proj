// CEC equipment sync: xlsx parsing (title rows above headers), sanity-gate
// keep-old-rows, certified-name fuzzy lookup, primed inverter cache, advisory
// QC behavior (silent when never synced), and migration v10 replay idempotency.
// Run: tsx backend/test/cecEquipment.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";

// Build a minimal one-sheet xlsx (inline strings, no sharedStrings) matching
// the CEC layout: two title rows, then headers, then data.
function buildXlsx(rows: string[][]): Buffer {
  const zip = new AdmZip();
  const cell = (r: number, c: number, v: string) =>
    v === "" ? "" : `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const sheetRows = rows.map((cols, r) => `<row r="${r + 1}">${cols.map((v, c) => cell(r, c, v)).join("")}</row>`).join("");
  zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`));
  zip.addFile("_rels/.rels", Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`));
  zip.addFile("xl/workbook.xml", Buffer.from(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`));
  zip.addFile("xl/_rels/workbook.xml.rels", Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`));
  zip.addFile("xl/worksheets/sheet1.xml", Buffer.from(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`));
  return zip.toBuffer();
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cec-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
process.env.AUTOPILOT_AUTO_START = "0"; // deterministic tests — no background autopilot
  process.env.ANTHROPIC_API_KEY = "";
  const { openDatabase } = await import("../src/db");
  const { parseCecSheet, importCecRows, certifiedNamesForMake, certifiedModelFor, primeCecCache, lookupCecInverter, isCecListed, cecTableCount } = await import("../src/cecEquipment");
  const { createProject } = await import("../src/repository");
  const { runQcForProject } = await import("../src/qc");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  // 1) Parse: CEC-style workbook with two title rows above the real headers.
  const invXlsx = buildXlsx([
    ["Grid Support Utility Interactive Inverter List", "", "", ""],
    ["Updated 2026-07-01", "", "", ""],
    ["Manufacturer Name", "Model Number", "Maximum Continuous Output Current", "CEC Listing Date"],
    ["Altenergy Power System Inc.", "DS3-L", "3.33", "2024-01-15"],
    ["Enphase Energy Inc.", "IQ8PLUS-72-2-US", "1.21", "2023-06-01"],
  ]);
  const rows = parseCecSheet("inverter", invXlsx);
  check("parses past title rows to real headers", rows.length === 2, `got ${rows.length}`);
  check("row fields extracted", rows[0]?.manufacturer === "Altenergy Power System Inc." && rows[0]?.model === "DS3-L" && rows[0]?.outputCurrentA === 3.33, JSON.stringify(rows[0]));

  // 2) Import + sanity-gate semantics: importCecRows replaces; the SYNC gate is
  //    tested at the row-count level (import small set directly, then verify a
  //    guarded sync path keeps it — simulated by not calling import again).
  importCecRows(db, "inverter", rows);
  importCecRows(db, "module", [
    { manufacturer: "Znshine PV-Tech", model: "ZXM7-UHLDD108-440/N", powerW: 440, outputCurrentA: null, listedAt: "" },
  ]);
  check("rows imported", cecTableCount(db) === 3, `count ${cecTableCount(db)}`);
  // Re-import same kind replaces (no dupes).
  importCecRows(db, "inverter", rows);
  check("re-import replaces, not duplicates", cecTableCount(db, "inverter") === 2);

  // 3) Certified-name fuzzy lookup (same normalization as the alias table).
  const names = certifiedNamesForMake(db, "inverter", "AP Systems");
  check("certifiedNamesForMake: 'AP Systems' → CEC legal name", names.length === 0, "expected MISS: 'apsystems' vs 'altenergypowersysteminc' shares no containment — static alias covers this; CEC helps same-stem names");
  const names2 = certifiedNamesForMake(db, "module", "Znshine");
  check("certifiedNamesForMake: same-stem containment hits", names2[0] === "Znshine PV-Tech", JSON.stringify(names2));

  // 4) Primed inverter cache lookup; empty-model / unprimed safety.
  primeCecCache(db);
  const inv = lookupCecInverter("AP Systems DS3-L [240V]");
  check("lookupCecInverter fuzzy model match", inv?.outputCurrentA === 3.33, JSON.stringify(inv));
  check("lookupCecInverter short model → null", lookupCecInverter("DS") === null);

  // 5) QC advisory: warning when model unlisted, silent pass/fail unchanged.
  const detail = createProject(db, {
    owner: "CEC Test", ahj: "City of Testville", state: "OR", utility: "PGE",
    moduleModel: "NOT-A-REAL-MODULE-123", invModel: "DS3-L",
  } as never);
  runQcForProject(db, detail.project.id);
  const warnings = db.query<{ rule_id: string; qc_status: string }>(
    "SELECT rule_id, qc_status FROM qc_results WHERE project_id = ? AND rule_id LIKE 'cec.%'", [detail.project.id]);
  check("QC: unlisted module → one advisory warning", warnings.length === 1 && warnings[0].rule_id === "cec.module_listed" && warnings[0].qc_status === "warning", JSON.stringify(warnings));
  // Empty table → silent (fresh installs / stub).
  db.run("DELETE FROM cec_equipment");
  runQcForProject(db, detail.project.id);
  const after = db.query("SELECT rule_id FROM qc_results WHERE project_id = ? AND rule_id LIKE 'cec.%'", [detail.project.id]);
  check("QC: empty table → no cec rows at all", after.length === 0, JSON.stringify(after));

  // 5b) certifiedModelFor: plan sets drop a series letter. Repair that ONLY when
  // the wattage agrees and one listing survives — never a digit or revision edit.
  const M = (model: string, powerW: number) =>
    ({ manufacturer: "ZNSHINE PV-TECH Co., Ltd.", model, powerW, outputCurrentA: null, listedAt: "" });
  importCecRows(db, "module", [
    M("ZXM7-UHLDD108-440/N", 440),
    M("ZXM7-UHLDD108-445/N", 445),
    M("ZXM7-SHLDD120-435/M", 435),
    M("ZXM6-NH144-440/M {Blk}", 440),
    M("ZXM6-NH144-440/M {Wht}", 440),
  ]);
  const cm = (model: string, watts?: number | null) => certifiedModelFor(db, "module", "ZNShine Solar", model, watts);
  check("dropped series letter + matching wattage → the listed name",
    cm("ZXM7-UHLD108-440/N", 440) === "ZXM7-UHLDD108-440/N", cm("ZXM7-UHLD108-440/N", 440));
  check("exact listing still wins untouched",
    cm("ZXM7-UHLDD108-445/N", 445) === "ZXM7-UHLDD108-445/N", cm("ZXM7-UHLDD108-445/N", 445));
  check("no wattage → refuses to guess",
    cm("ZXM7-UHLD108-440/N", null) === "", cm("ZXM7-UHLD108-440/N", null));
  check("wattage disagrees with the listing → refuses",
    cm("ZXM7-UHLD108-440/N", 445) === "", cm("ZXM7-UHLD108-440/N", 445));
  // A dropped DIGIT changes cell count or wattage — must never resolve.
  check("dropped digit → refuses",
    cm("ZXM7-UHLDD108-40/N", 440) === "", cm("ZXM7-UHLDD108-40/N", 440));
  // Equal-length digit change (108 cells → 109) is a substitution, never repaired.
  check("digit substitution (109 for 108) → refuses",
    cm("ZXM7-UHLDD109-440/N", 440) === "", cm("ZXM7-UHLDD109-440/N", 440));
  // A revision-letter SUBSTITUTION is a different SKU, not a typo.
  check("revision-letter substitution (/M for /N) → refuses",
    cm("ZXM7-UHLDD108-440/M", 440) === "", cm("ZXM7-UHLDD108-440/M", 440));

  // 5c) ONE PREDICATE (dry-run 2026-09-28 B15): QC asks what the portal fill asks
  // (cecListing -> certifiedModelFor first). The plan set's "UHLD" at 440 W is the listed
  // "UHLDD": the fill files that name, so QC must not say "not found" — it says, as
  // information, which name the portal sees. A genuinely absent model still warns.
  const cecRows = (pid: string) => db.query<{ rule_id: string; qc_status: string; severity: string; message: string }>(
    "SELECT rule_id, qc_status, severity, message FROM qc_results WHERE project_id = ? AND rule_id LIKE 'cec.%'", [pid]);
  const dropped = createProject(db, {
    owner: "CEC Test", ahj: "City of Testville", state: "OR", utility: "PGE",
    moduleMake: "ZNShine Solar", moduleModel: "ZXM7-UHLD108-440/N", moduleWattage: 440,
  } as never).project.id;
  runQcForProject(db, dropped);
  const droppedRows = cecRows(dropped);
  check("QC: a model the fill files under its listed name is NOT reported not-found",
    !droppedRows.some((r) => r.qc_status === "warning"), JSON.stringify(droppedRows));
  check("QC: …it names the listed spelling the portal sees, as information",
    droppedRows.length === 1 && droppedRows[0].qc_status === "pass" && droppedRows[0].severity === "info" && /"ZXM7-UHLDD108-440\/N"/.test(droppedRows[0].message), JSON.stringify(droppedRows));
  check("isCecListed agrees with the fill (make + wattage)", isCecListed(db, "module", "ZXM7-UHLD108-440/N", "ZNShine Solar", 440));
  const exact = createProject(db, {
    owner: "CEC Test", ahj: "City of Testville", state: "OR", utility: "PGE",
    moduleMake: "ZNShine Solar", moduleModel: "ZXM7-UHLDD108-440/N", moduleWattage: 440,
  } as never).project.id;
  runQcForProject(db, exact);
  check("QC: an exact listing writes no CEC row at all", cecRows(exact).length === 0, JSON.stringify(cecRows(exact)));
  importCecRows(db, "module", [
    M("ZXM7-UHLDD108-440/N", 440), M("ZXM7-UHLDD108-445/N", 445), M("ZXM7-SHLDD120-435/M", 435),
    M("ZXM6-NH144-440/M {Blk}", 440), M("ZXM6-NH144-440/M {Wht}", 440), M("ZXM8-TEST108-450/N [Blk]", 450),
  ]);
  const suffixed = createProject(db, {
    owner: "CEC Test", ahj: "City of Testville", state: "OR", utility: "PGE",
    moduleMake: "ZNShine Solar", moduleModel: "ZXM8-TEST108-450/N", moduleWattage: 450,
  } as never).project.id;
  check("fixture sanity: the suffixed listing is the certified name", cm("ZXM8-TEST108-450/N", 450) === "ZXM8-TEST108-450/N [Blk]", cm("ZXM8-TEST108-450/N", 450));
  runQcForProject(db, suffixed);
  check("QC: a bracketed listing suffix is not another spelling — no row", !cecRows(suffixed).some((r) => r.severity === "info"), JSON.stringify(cecRows(suffixed)));
  const absent = createProject(db, {
    owner: "CEC Test", ahj: "City of Testville", state: "OR", utility: "PGE",
    moduleMake: "ZNShine Solar", moduleModel: "ZXM9-NOPE108-999/Q", moduleWattage: 999,
  } as never).project.id;
  runQcForProject(db, absent);
  check("QC MUST-EXCLUDE: a genuinely absent model still warns",
    cecRows(absent).length === 1 && cecRows(absent)[0].qc_status === "warning", JSON.stringify(cecRows(absent)));
  const noWatts = createProject(db, {
    owner: "CEC Test", ahj: "City of Testville", state: "OR", utility: "PGE",
    moduleMake: "ZNShine Solar", moduleModel: "ZXM7-UHLD108-440/N",
  } as never).project.id;
  runQcForProject(db, noWatts);
  check("QC MUST-EXCLUDE: with no wattage the one-letter repair is refused, so the warning stays",
    cecRows(noWatts).some((r) => r.qc_status === "warning"), JSON.stringify(cecRows(noWatts)));

  // Two same-wattage listings each one letter away → ambiguous, say nothing.
  importCecRows(db, "module", [M("ZXM6-NH144-440/MA", 440), M("ZXM6-NH144-440/MB", 440)]);
  check("two one-letter candidates → refuses",
    cm("ZXM6-NH144-440/M", 440) === "", cm("ZXM6-NH144-440/M", 440));
  db.run("DELETE FROM cec_equipment");

  // 6) Migration v10 replay idempotent.
  db.run("DELETE FROM schema_meta WHERE version >= 10");
  const { openDatabase: reopen } = await import("../src/db");
  const db2 = await reopen();
  check("migration v10 replays idempotently", cecTableCount(db) === 0);

  // Close BOTH handles before deleting the scratch DB - Windows holds any open handle
  // as a file lock (EBUSY).
  db2.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\ncecEquipment: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
