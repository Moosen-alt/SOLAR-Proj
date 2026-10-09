// #238: the human-review queue is an edit door too. applyVerifiedField wrote only the source field
// (inverterModel → invModel) and never dropped the stale derived alias, so a verified "Sunny Boy"
// left inverterModel "Enphase" — and that alias, now differing from its source, read as operator-set
// and survived every later edit. Also pins the read-only report of snapshots diverged before the fix.
// Run:
//   tsx backend/test/reviewQueueAliases.test.ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-queue-aliases-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createProject, updateProject, humanVerify, listDivergedAliasProjects } = await import("../src/repository");
const { isMlpeDesignForProject } = await import("../src/codeReviewRules");
const { MICRO_SUPERSEDED_KEY } = await import("../src/normalize");
const db = await openDatabase();

let failed = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`ok   - ${name}`);
  else { failed++; console.log(`FAIL - ${name}${detail === undefined ? "" : ` (got ${JSON.stringify(detail)})`}`); }
};

const base = {
  owner: "Test Owner", street: "100 Example St", city: "Testville", state: "OR", zip: "97000",
  ahj: "City of Testville", utility: "Test Utility", dcKw: 8, acKw: 7.6,
  moduleMake: "TestSolar", moduleModel: "TS-400", moduleQty: "20", busRating: "200",
};

// A pending review item on one field, the way QC queues one (the operator's fix-it door).
let reviewSeq = 0;
const queueReview = (projectId: string, fieldName: string, parserValue: string): string => {
  const itemId = `review-${fieldName}-${projectId.slice(0, 8)}-${++reviewSeq}`;
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO human_review_items
       (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [itemId, projectId, "critical", fieldName, parserValue, "", "", "pending", "test", ts, ts],
  );
  return itemId;
};

let healthyPid = "";

// 1) MUST-PASS — the #238 probe: a verified inverter edit moves the derived aliases with it.
{
  const created = createProject(db, { ...base, invModel: "Enphase IQ8M-72-2-US", invQty: "20" });
  const pid = created.project.id;
  check("probe setup: design is MLPE", isMlpeDesignForProject(created.project));
  const itemId = queueReview(pid, "inverterModel", "Enphase IQ8M-72-2-US");
  const verified = humanVerify(db, pid, { reviewItemId: itemId, action: "edit", fieldValue: "Sunny Boy SB7.7-1SP-US-41" });
  const s = verified.project.parserSnapshot;
  check("verified edit lands on invModel", s.invModel === "Sunny Boy SB7.7-1SP-US-41", s.invModel);
  check("verified edit moves inverterModel", s.inverterModel === "Sunny Boy SB7.7-1SP-US-41", s.inverterModel);
  check("verified design is no longer MLPE", !isMlpeDesignForProject(verified.project));
  // …and the alias is an echo again, so a later source edit moves it too (it used to stick forever).
  const later = updateProject(db, pid, { invModel: "Sunny Boy SB6.0-1SP-US-41" });
  check("later invModel edit still moves inverterModel", later.project.parserSnapshot.inverterModel === "Sunny Boy SB6.0-1SP-US-41", later.project.parserSnapshot.inverterModel);
}

// 2) Quantity too, and an approve (no typed value) goes through the same door.
{
  const created = createProject(db, { ...base, invModel: "Enphase IQ8M-72-2-US", invQty: "20" });
  const pid = created.project.id;
  const itemId = queueReview(pid, "inverterQty", "1");
  const verified = humanVerify(db, pid, { reviewItemId: itemId, action: "approve" });
  healthyPid = pid;
  check("approved invQty moves inverterQuantity", verified.project.parserSnapshot.inverterQuantity === "1", verified.project.parserSnapshot.inverterQuantity);
}

// 3) MUST-EXCLUDE — a human-verified value is never overwritten by a derivation, and an alias set
//    on its own is not touched by a verify on its source's neighbour.
{
  const created = createProject(db, {
    ...base, invMake: "Enphase", invModel: "IQ8M-72-2-US", invQty: "20",
    inverterManufacturer: "Enphase Energy Inc. (operator)",
  });
  const pid = created.project.id;
  const itemId = queueReview(pid, "inverterModel", "IQ8M-72-2-US");
  const verified = humanVerify(db, pid, { reviewItemId: itemId, action: "edit", fieldValue: "IQ8A-72-2-US" });
  check("operator-set inverterManufacturer survives a verify", verified.project.parserSnapshot.inverterManufacturer === "Enphase Energy Inc. (operator)", verified.project.parserSnapshot.inverterManufacturer);
  const unrelated = updateProject(db, pid, { zip: "97001" });
  check("verified invModel survives an unrelated edit", unrelated.project.parserSnapshot.invModel === "IQ8A-72-2-US", unrelated.project.parserSnapshot.invModel);
  check("its alias stays with it", unrelated.project.parserSnapshot.inverterModel === "IQ8A-72-2-US", unrelated.project.parserSnapshot.inverterModel);

  // A review item on the CANONICAL key itself: the verified value is the edit, so the derivation
  // from invQty ("20") must not win over it.
  const qtyItem = queueReview(pid, "inverterQuantity", "20");
  const v2 = humanVerify(db, pid, { reviewItemId: qtyItem, action: "edit", fieldValue: "18" });
  check("verified canonical value is not overwritten by its derivation", v2.project.parserSnapshot.inverterQuantity === "18", v2.project.parserSnapshot.inverterQuantity);
}

// Rewrite a stored snapshot behind the edit doors' back — the shape the pre-#225/#238 bug left.
const forceSnapshot = (pid: string, patch: Record<string, unknown>) => {
  const row = db.get<{ parser_json: string }>("SELECT parser_json FROM projects WHERE id = ?", [pid])!;
  db.run("UPDATE projects SET parser_json = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(row.parser_json), ...patch }), pid]);
};

// 4) MUST-PASS — Helm ruling on #238: a human verify on a field wins on that field. A canonical alias
//    that diverged from its source (operator-set, or a legacy row) must not outvote the verify.
{
  // a) operator-set canonical inverterModel
  const created = createProject(db, { ...base, invModel: "Enphase IQ8M-72-2-US", invQty: "20", inverterModel: "Enphase IQ8M (operator)" });
  const pid = created.project.id;
  check("ruling setup: operator-set inverterModel is stored", created.project.parserSnapshot.inverterModel === "Enphase IQ8M (operator)", created.project.parserSnapshot.inverterModel);
  const itemId = queueReview(pid, "inverterModel", "Enphase IQ8M-72-2-US");
  const v = humanVerify(db, pid, { reviewItemId: itemId, action: "edit", fieldValue: "Sunny Boy SB7.7-1SP-US-41" });
  check("verify overrides an operator-set inverterModel", v.project.parserSnapshot.inverterModel === "Sunny Boy SB7.7-1SP-US-41", v.project.parserSnapshot.inverterModel);
  check("…and MLPE is no longer softened", !isMlpeDesignForProject(v.project));
}
{
  // b) legacy pre-#225 row: invModel edited, inverterModel left behind on Enphase
  const created = createProject(db, { ...base, invModel: "Enphase IQ8M-72-2-US", invQty: "20" });
  const pid = created.project.id;
  forceSnapshot(pid, { invModel: "Sunny Boy SB7.7-1SP-US-41" });
  const itemId = queueReview(pid, "inverterModel", "Sunny Boy SB7.7-1SP-US-41");
  const v = humanVerify(db, pid, { reviewItemId: itemId, action: "approve", fieldValue: "Sunny Boy SB7.7-1SP-US-41" });
  check("verify heals a legacy diverged inverterModel", v.project.parserSnapshot.inverterModel === "Sunny Boy SB7.7-1SP-US-41", v.project.parserSnapshot.inverterModel);
  check("…and the legacy row is no longer MLPE", !isMlpeDesignForProject(v.project));
}
{
  // c) the inverterMake → invMake → inverterManufacturer class
  const created = createProject(db, { ...base, invMake: "Enphase", invModel: "IQ8M-72-2-US", inverterManufacturer: "Enphase Energy (operator)" });
  const pid = created.project.id;
  const itemId = queueReview(pid, "inverterMake", "Enphase");
  const v = humanVerify(db, pid, { reviewItemId: itemId, action: "edit", fieldValue: "SMA" });
  check("verify on inverterMake writes inverterManufacturer", v.project.parserSnapshot.inverterManufacturer === "SMA", v.project.parserSnapshot.inverterManufacturer);
  // MUST-EXCLUDE: a SECONDARY source is not a statement about the alias (mainServiceRating ← busRating first).
  const mb = queueReview(pid, "mainBreaker", "200");
  const v2 = humanVerify(db, pid, { reviewItemId: mb, action: "edit", fieldValue: "150" });
  check("verify on mainBreaker leaves mainServiceRating on busRating", v2.project.parserSnapshot.mainServiceRating === "200", v2.project.parserSnapshot.mainServiceRating);
}

// 5) The read-only report of snapshots diverged by the old bug: listed, never rewritten.
{
  const created = createProject(db, { ...base, invModel: "Enphase IQ8M-72-2-US", invQty: "20", ownerPhone: "555-0100" });
  const pid = created.project.id;
  // Simulate a pre-#238 snapshot: source edited, alias left behind (and a changed phone).
  forceSnapshot(pid, { invModel: "Sunny Boy SB7.7-1SP-US-41", ownerPhone: "555-0199" });
  const before = db.get<{ parser_json: string; updated_at: string }>("SELECT parser_json, updated_at FROM projects WHERE id = ?", [pid])!;

  const report = listDivergedAliasProjects(db, null);
  const hit = report.find((r) => r.projectId === pid);
  const inv = hit?.aliases.find((a) => a.key === "inverterModel");
  check("report lists the diverged inverterModel", inv?.stored === "Enphase IQ8M-72-2-US" && inv?.derived === "Sunny Boy SB7.7-1SP-US-41", hit);
  check("report leaves the phone alias out entirely", !hit?.aliases.some((a) => a.key === "homeownerPhone") && !JSON.stringify(report).includes("555-"), hit);
  check("report skips a project whose aliases agree", !!healthyPid && !report.some((r) => r.projectId === healthyPid), report.map((r) => r.projectId));
  const after = db.get<{ parser_json: string; updated_at: string }>("SELECT parser_json, updated_at FROM projects WHERE id = ?", [pid])!;
  check("report writes nothing", after.parser_json === before.parser_json && after.updated_at === before.updated_at);

  // Org filter: a diverged project in a SECOND org.
  const otherOrg = "org-238-other";
  db.run("INSERT INTO orgs (id, name, edition, created_at) VALUES (?, ?, ?, ?)", [otherOrg, "Other Test Org", "full", new Date().toISOString()]);
  const other = createProject(db, { ...base, invModel: "Enphase IQ8M-72-2-US", invQty: "20" }, otherOrg).project.id;
  forceSnapshot(other, { invModel: "Sunny Boy SB6.0-1SP-US-41" });
  const ids = (rows: Array<{ projectId: string }>) => rows.map((r) => r.projectId);
  const byDefault = ids(listDivergedAliasProjects(db));
  check("default call includes the default-org row", byDefault.includes(pid), byDefault);
  check("default call excludes the other org's row", !byDefault.includes(other), byDefault);
  check("explicit default-org filter matches the default call", JSON.stringify(ids(listDivergedAliasProjects(db, DEFAULT_ORG_ID))) === JSON.stringify(byDefault));
  const byOther = ids(listDivergedAliasProjects(db, otherOrg));
  check("other-org filter sees only its own row", byOther.length === 1 && byOther[0] === other, byOther);
  const all = ids(listDivergedAliasProjects(db, null));
  check("null filter includes both orgs", all.includes(pid) && all.includes(other), all);
}

// 6) #270 — a micro-PARSED design (pvMicro*, no inv*). Only a PERSON's statement (the review-queue
//    verify, or corrections-apply via updateProject's explicit humanInverterEdit option) supersedes the
//    pvMicro* evidence, and it is recorded on the snapshot; PUT-shaped saves (the parser, API keys) —
//    inverterModel included — never do, nor does a model naming the ESS (Helm rulings on PR #274).
const MICRO = { ...base, pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US", pvMicroQty: "20" };
const SUNNY = "Sunny Boy SB7.7-1SP-US-41";
const snapshotOf = (pid: string) => JSON.parse(db.get<{ parser_json: string }>("SELECT parser_json FROM projects WHERE id = ?", [pid])!.parser_json);
{
  const created = createProject(db, MICRO);
  const pid = created.project.id;
  check("micro setup: inverterModel derives from pvMicroModel", created.project.parserSnapshot.inverterModel === "IQ8PLUS-72-2-US", created.project.parserSnapshot.inverterModel);
  check("micro setup: design is MLPE", isMlpeDesignForProject(created.project));
  const itemId = queueReview(pid, "inverterModel", "IQ8PLUS-72-2-US");
  const v = humanVerify(db, pid, { reviewItemId: itemId, action: "edit", fieldValue: SUNNY });
  check("MUST-PASS: a human verify to Sunny Boy on a micro-parsed design turns MLPE off", !isMlpeDesignForProject(v.project), v.project.parserSnapshot);
  check("…the statement is recorded, by the review queue, about that model", (v.project.parserSnapshot[MICRO_SUPERSEDED_KEY] as { model?: string; door?: string })?.model === SUNNY && (v.project.parserSnapshot[MICRO_SUPERSEDED_KEY] as { door?: string }).door === "review_queue", v.project.parserSnapshot[MICRO_SUPERSEDED_KEY]);
  check("…the parser's pvMicro* evidence is kept", v.project.parserSnapshot.pvMicroModel === "IQ8PLUS-72-2-US" && v.project.parserSnapshot.pvMicroQty === "20", v.project.parserSnapshot);
  const qtyItem = queueReview(pid, "inverterQty", "20");
  const v2 = humanVerify(db, pid, { reviewItemId: qtyItem, action: "edit", fieldValue: "1" });
  check("…and a later inverterQty verify keeps it off", !isMlpeDesignForProject(v2.project), v2.project.parserSnapshot);
  // A parser re-save sends the stored fields back (its form is filled from the snapshot) — with the
  // marker stripped or, forged/echoed, ignored. Either way the person's statement stands.
  const { [MICRO_SUPERSEDED_KEY]: _m, ...resent } = snapshotOf(pid);
  const resaved = updateProject(db, pid, { ...resent, pvMicroModel: "IQ8PLUS-72-2-US", pvMicroQty: "20", inverterModel: resent.invModel, inverterMake: resent.invMake ?? "" });
  check("MUST-PASS: a parser re-save after the verify keeps MLPE off", !isMlpeDesignForProject(resaved.project), resaved.project.parserSnapshot);
  const echoed = updateProject(db, pid, { ...snapshotOf(pid), [MICRO_SUPERSEDED_KEY]: { model: "something else", door: "parser" } });
  check("…a re-sent marker can't move the stored one", (echoed.project.parserSnapshot[MICRO_SUPERSEDED_KEY] as { model?: string })?.model === SUNNY && !isMlpeDesignForProject(echoed.project), echoed.project.parserSnapshot[MICRO_SUPERSEDED_KEY]);
}
{
  // PUT /api/projects/:id is NOT a human door: the parser sends inverterModel on every save.
  const pid = createProject(db, MICRO).project.id;
  const put = updateProject(db, pid, { inverterModel: SUNNY, invModel: SUNNY });
  check("MUST-EXCLUDE: a PUT-shaped save naming inverterModel → Sunny Boy keeps MLPE and records nothing", isMlpeDesignForProject(put.project) && put.project.parserSnapshot[MICRO_SUPERSEDED_KEY] === undefined, put.project.parserSnapshot);
  // Corrections-apply (a person's approval) passes the explicit option.
  const pid2 = createProject(db, MICRO).project.id;
  const applied = updateProject(db, pid2, { inverterModel: SUNNY }, { humanInverterEdit: true });
  check("MUST-PASS: a human-only caller (humanInverterEdit) naming Sunny Boy turns MLPE off", !isMlpeDesignForProject(applied.project), applied.project.parserSnapshot);
  check("…recorded by the correction-apply door", (applied.project.parserSnapshot[MICRO_SUPERSEDED_KEY] as { door?: string })?.door === "correction_apply", applied.project.parserSnapshot[MICRO_SUPERSEDED_KEY]);
  check("…pvMicroModel kept", applied.project.parserSnapshot.pvMicroModel === "IQ8PLUS-72-2-US", applied.project.parserSnapshot.pvMicroModel);
  // Marker strip on updateProject: a payload can't plant one on a project that has none.
  const pid3 = createProject(db, MICRO).project.id;
  const planted = updateProject(db, pid3, { invModel: SUNNY, inverterModel: SUNNY, [MICRO_SUPERSEDED_KEY]: { model: SUNNY, door: "review_queue" } });
  check("MUST-EXCLUDE: updateProject strips a planted marker", planted.project.parserSnapshot[MICRO_SUPERSEDED_KEY] === undefined && isMlpeDesignForProject(planted.project), planted.project.parserSnapshot);
}
{
  // Helm re-review blocker 1 — the parser's PW3 + expansion shape. The parser writes the ESS into inv*
  // (and inverterModel) and keeps the micro in pvMicro*; essInverterModel never reaches the project.
  const PW3X = "POWERWALL 3 (13.5 KWH) + EXPANSION (13.5 KWH)";
  // parser.html: essInverterModel = normalizeTeslaPowerwallModel(batteryModel) → "Powerwall 3" lands in invModel.
  const shape = { ...MICRO, invMake: "Tesla", invModel: "Powerwall 3", inverterModel: "Powerwall 3", invQty: "1", batteryMake: "Tesla", batteryModel: PW3X, batteryQty: "2" };
  const created = createProject(db, shape).project;
  check("MUST-EXCLUDE: the parser's PW3 + expansion create is MLPE", isMlpeDesignForProject(created), created.parserSnapshot);
  const resaved = updateProject(db, created.id, shape);
  check("MUST-EXCLUDE: …its parser re-save keeps MLPE", isMlpeDesignForProject(resaved.project), resaved.project.parserSnapshot);
  const item = queueReview(created.id, "inverterModel", "Powerwall 3");
  const approved = humanVerify(db, created.id, { reviewItemId: item, action: "approve" });
  check("MUST-EXCLUDE: …a review-queue APPROVE of the parser's Powerwall model keeps MLPE and records nothing", isMlpeDesignForProject(approved.project) && approved.project.parserSnapshot[MICRO_SUPERSEDED_KEY] === undefined, approved.project.parserSnapshot);
  const item2 = queueReview(created.id, "inverterModel", "Powerwall 3");
  const typed = humanVerify(db, created.id, { reviewItemId: item2, action: "edit", fieldValue: "Tesla Powerwall 3" });
  check("MUST-EXCLUDE: …a person typing 'Tesla Powerwall 3' keeps MLPE and records nothing", isMlpeDesignForProject(typed.project) && typed.project.parserSnapshot[MICRO_SUPERSEDED_KEY] === undefined, typed.project.parserSnapshot);
  // Same, with only the battery model to go on (no Tesla invMake).
  const plain = createProject(db, { ...MICRO, batteryMake: "Tesla", batteryModel: "Powerwall 3", batteryQty: "1" }).project;
  const item3 = queueReview(plain.id, "inverterModel", "IQ8PLUS-72-2-US");
  const typed2 = humanVerify(db, plain.id, { reviewItemId: item3, action: "edit", fieldValue: "Tesla Powerwall 3" });
  check("MUST-EXCLUDE: 'Tesla Powerwall 3' on a micro + Powerwall 3 battery design keeps MLPE (family match on batteryModel)", isMlpeDesignForProject(typed2.project) && typed2.project.parserSnapshot[MICRO_SUPERSEDED_KEY] === undefined, typed2.project.parserSnapshot);
}
{
  // MUST-EXCLUDE: the parser's keys are not a person's statement.
  const pid = createProject(db, MICRO).project.id;
  const parserShaped = updateProject(db, pid, { invModel: "Powerwall 3", invMake: "Tesla", batteryMake: "Tesla", batteryModel: "Powerwall 3", batteryQty: "1" });
  check("MUST-EXCLUDE: a parser-shaped micro + Powerwall 3 re-save stays MLPE", isMlpeDesignForProject(parserShaped.project), parserShaped.project.parserSnapshot);
  check("…and records nothing", parserShaped.project.parserSnapshot[MICRO_SUPERSEDED_KEY] === undefined, parserShaped.project.parserSnapshot[MICRO_SUPERSEDED_KEY]);
  const pw3 = createProject(db, { ...base, pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US", pvMicroQty: "10", invMake: "Tesla", invModel: "Powerwall 3", invQty: "1", invOutputW: "1.21", batteryMake: "Tesla", batteryModel: "Powerwall 3", batteryQty: "1" }).project;
  check("MUST-EXCLUDE: a NEW project in the parser's micro + Powerwall shape is MLPE", isMlpeDesignForProject(pw3), pw3.parserSnapshot);
  const forged = createProject(db, { ...MICRO, invModel: SUNNY, [MICRO_SUPERSEDED_KEY]: { model: SUNNY, door: "review_queue" } }).project;
  check("MUST-EXCLUDE: a new project can't arrive carrying a marker", forged.parserSnapshot[MICRO_SUPERSEDED_KEY] === undefined && isMlpeDesignForProject(forged), forged.parserSnapshot);
}
{
  // MUST-EXCLUDE: a real micro design with no verify stays MLPE — through an unrelated edit, an
  // approve of its micro model, and verifies that only correct the micro's spelling.
  const pid = createProject(db, MICRO).project.id;
  const unrelated = updateProject(db, pid, { zip: "97002" });
  check("MUST-EXCLUDE: unverified micro design stays MLPE after an unrelated edit", isMlpeDesignForProject(unrelated.project), unrelated.project.parserSnapshot);
  const itemId = queueReview(pid, "inverterModel", "IQ8PLUS-72-2-US");
  const v = humanVerify(db, pid, { reviewItemId: itemId, action: "approve" });
  check("MUST-EXCLUDE: approving the micro model keeps it MLPE", isMlpeDesignForProject(v.project), v.project.parserSnapshot);
  for (const [read, fixed] of [["HMS-2OOO-4T", "HMS-2000-4T"], ["M215-60-2LL-S2", "M215-60-2LL-S22"], ["DS3-D", "DS3D"]]) {
    const p = createProject(db, { ...base, pvMicroMake: "Testmicro", pvMicroModel: read, pvMicroQty: "10" }).project.id;
    const item = queueReview(p, "inverterModel", read);
    const fixedUp = humanVerify(db, p, { reviewItemId: item, action: "edit", fieldValue: fixed });
    check(`MUST-EXCLUDE: verifying '${read}' → '${fixed}' (a spelling fix of the micro) keeps it MLPE`, isMlpeDesignForProject(fixedUp.project) && fixedUp.project.parserSnapshot[MICRO_SUPERSEDED_KEY] === undefined, fixedUp.project.parserSnapshot);
  }
  const qtyOnly = createProject(db, { ...base, pvMicroQty: "20" }).project;
  check("MUST-EXCLUDE: pvMicroQty alone stays MLPE", isMlpeDesignForProject(qtyOnly), qtyOnly.parserSnapshot);
}

// 7) #270 — '' is an org id that matches nothing, never "every org"; the script refuses a bare --org.
{
  check("empty-string org filter matches nothing", listDivergedAliasProjects(db, "").length === 0, listDivergedAliasProjects(db, "").length);
  check("…while null still reads every org", listDivergedAliasProjects(db, null).length >= 2);
  const script = path.resolve(import.meta.dirname, "../../scripts/diverged-aliases.ts");
  const scratchDb = path.join(tmpDir, "script-must-not-open.sqlite");
  const runScript = (args: string[], dbPath: string) => spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    encoding: "utf8", env: { ...process.env, AUTOPILOT_DB_PATH: dbPath }, timeout: 60_000,
  });
  const refused = [
    ["--org"], ["--org", ""], ["--org", "  "], ["--org", "--verbose"],
    ["--org="], ["--org= "], ["--verbose"], ["--orgs=acme"], ["acme"], ["--org=a", "--org=b"],
  ];
  for (const args of refused) {
    const run = runScript(args, scratchDb);
    check(`script ${JSON.stringify(args)} exits with a usage error`, run.status === 2 && /usage:/.test(run.stderr), { status: run.status, stderr: run.stderr.slice(0, 300) });
    check(`script ${JSON.stringify(args)} never opens the database`, !fs.existsSync(scratchDb));
  }
  // Both spellings of a real org id read ONLY that org (the = form used to fall through to every org).
  const otherOrg = "org-238-other";
  const short = (orgId: string) => db.query<{ id: string }>("SELECT id FROM projects WHERE org_id = ?", [orgId]).map((r) => r.id.slice(0, 8));
  const otherIds = short(otherOrg);
  const defaultIds = short(DEFAULT_ORG_ID);
  for (const args of [[`--org=${otherOrg}`], ["--org", otherOrg]]) {
    const run = runScript(args, process.env.AUTOPILOT_DB_PATH!);
    const listed = (run.stdout.match(/^[0-9a-f]{8}(?=\s)/gm) ?? []);
    check(`script ${JSON.stringify(args)} lists only that org's projects`,
      run.status === 0 && listed.length > 0 && listed.every((p) => otherIds.includes(p)) && !listed.some((p) => defaultIds.includes(p)),
      { status: run.status, listed, stderr: run.stderr.slice(0, 300) });
  }
}

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
if (failed) { console.log(`\nreviewQueueAliases: ${failed} check(s) FAILED`); process.exit(1); }
console.log("\nreviewQueueAliases: all checks passed");
