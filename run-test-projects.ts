// TEST HARNESS: run real historical projects from the operator's manual-work archive
// (E:\INFINITY SOLAR DOCS) through intake -> parse -> QC -> reviewer gate, and record
// ACCURACY and SPEED per stage. Read-only against the archive; writes to a COPY of the
// live DB so the real one is never polluted but the learned KB/code profiles are present.
// Never touches a portal. Run: npx tsx run-test-projects.ts [limit] [--offset N]
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "L:/INFINITY SOLAR DOCS";              // fuller archive: 102 customer folders
const ARCHIVE = `${ROOT}/01 - CUSTOMERS`;
const TRACKER = `${ROOT}/08 - TRACKERS & DATA/Seamus Projects - 1776869677626.csv`;
const LIMIT = Number(process.argv[2] || 8);
const OFFSET = Number((process.argv.find((a) => a.startsWith("--offset=")) || "--offset=0").split("=")[1]);

// Work on a COPY of the live DB: real AHJ/code knowledge, zero pollution.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "testrun-"));
const liveDb = path.resolve("backend/data/autopilot.sqlite");
const scratchDb = path.join(scratch, "test.sqlite");
if (fs.existsSync(liveDb)) fs.copyFileSync(liveDb, scratchDb);
process.env.AUTOPILOT_DB_PATH = scratchDb;
process.env.PROJECT_DOCS_DIR = path.join(scratch, "docs");
process.env.AUTOPILOT_AUTO_START = "0";   // never auto-stage against a portal
process.env.PORTAL_AUTOSEED = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("./backend/src/db");
const { extractPdfText } = await import("./backend/src/batchImport");
const { createLLMProvider } = await import("./backend/src/llm");
const { createProject, rerunQc, getProjectDetail, buildReviewerReportFor } = await import("./backend/src/repository");
const { saveProjectDocument } = await import("./backend/src/projectDocuments");

const db = await openDatabase();
const llm = createLLMProvider();

// The plan set is the PDF named like the folder ("Abby Johnson - Happy Valley, OR.pdf").
// Fall back to the largest PDF, which is the plan set in every sampled folder.
function pickPlanSet(dir: string): string | null {
  const pdfs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => ({ f, full: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }));
  if (!pdfs.length) return null;
  const owner = path.basename(dir).split(" - ")[0].toLowerCase().replace(/[^a-z]/g, "");
  const named = pdfs.filter((p) => p.f.toLowerCase().replace(/[^a-z]/g, "").startsWith(owner));
  const pool = named.length ? named : pdfs;
  return pool.sort((a, b) => b.size - a.size)[0].full;
}

// REAL GROUND TRUTH: the operator's CRM export. It carries the values that were actually
// filed — street, city, state, zip, AHJ and system size — which is far stronger than the
// folder name (owner/city only). Joined to a folder by owner name.
interface TruthRow { owner: string; street: string; city: string; state: string; zip: string; ahj: string; sizeKw: string; value: string }
function loadTracker(): TruthRow[] {
  if (!fs.existsSync(TRACKER)) return [];
  const text = fs.readFileSync(TRACKER, "utf8").replace(/^﻿/, "");
  // Minimal CSV reader: quoted fields may contain commas.
  const rows: string[][] = [];
  let cur: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { cur.push(cell); cell = ""; }
    else if (c === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || cur.length) { cur.push(cell); rows.push(cur); }
  const head = rows.shift() ?? [];
  const idx = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const iOwner = idx("Account title"), iStreet = idx("Site Address Street"), iCity = idx("Site Address City");
  const iState = idx("Site Address State"), iZip = idx("Site Address Zipcode"), iAhj = idx("AHJ");
  const iSize = idx("Project size"), iVal = idx("Project value");
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  return rows.filter((r) => get(r, iOwner)).map((r) => ({
    owner: get(r, iOwner), street: get(r, iStreet), city: get(r, iCity), state: get(r, iState),
    zip: get(r, iZip), ahj: get(r, iAhj), sizeKw: get(r, iSize), value: get(r, iVal),
  }));
}
const TRACKER_ROWS = loadTracker();
function truthFor(owner: string): TruthRow | null {
  const key = owner.toLowerCase().replace(/[^a-z]/g, "");
  return TRACKER_ROWS.find((t) => t.owner.toLowerCase().replace(/[^a-z]/g, "") === key)
    ?? TRACKER_ROWS.find((t) => key.length > 5 && t.owner.toLowerCase().replace(/[^a-z]/g, "").includes(key.slice(0, 8)))
    ?? null;
}

// Fallback ground truth from the folder name: "Dennis Moore - Falls City OR".
function groundTruth(folder: string): { owner: string; city: string; state: string } {
  const [ownerRaw, locRaw = ""] = folder.split(" - ");
  const loc = locRaw.replace(/,/g, " ").trim().split(/\s+/);
  const state = (loc[loc.length - 1] || "").toUpperCase();
  return { owner: ownerRaw.trim(), city: loc.slice(0, -1).join(" ").trim(), state: /^[A-Z]{2}$/.test(state) ? state : "" };
}

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const val = (fields: Record<string, { value?: string }>, k: string) => String(fields?.[k]?.value ?? "").trim();

// SYNTHETIC utility data. A plan set legitimately does not carry the utility account or
// meter number (they come from a bill), so every project stops at the reviewer gate on
// those. Fill them with OBVIOUSLY FAKE values so the rest of the gate can be exercised —
// prefixed TEST- so a stray value can never be mistaken for a real account on a filing.
function syntheticUtilityData(seed: number): Record<string, string> {
  const n = String(100000000 + (seed * 7919) % 899999999);
  return {
    account: `TEST-${n}`,
    meter: `TEST-M${n.slice(0, 8)}`,
    homeownerEmail: "test.homeowner@example.invalid",
    homeownerPhone: "541-555-0100",
    jobValue: "30000",
  };
}

// RANDOM sample by default so a run is not always the same alphabetical head — pass
// --seed=N to reproduce one. --all runs the whole archive.
const SEED = Number((process.argv.find((a) => a.startsWith("--seed=")) || "--seed=1").split("=")[1]);
const ALL = process.argv.includes("--all");
const allFolders = fs.readdirSync(ARCHIVE, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "COMPLETED" && d.name.includes(" - "))
  .map((d) => d.name).sort();
// Deterministic shuffle (mulberry32) so a seed reproduces the exact sample.
let rnd = SEED >>> 0;
const next = () => { rnd = (rnd + 0x6D2B79F5) >>> 0; let t = rnd; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const shuffled = [...allFolders];
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const folders = ALL ? allFolders : shuffled.slice(OFFSET, OFFSET + LIMIT);
console.log(`archive: ${allFolders.length} projects — running ${folders.length}${ALL ? " (all)" : ` (random, seed ${SEED})`}
`);

const results: Record<string, unknown>[] = [];
for (const folder of folders) {
  const dir = path.join(ARCHIVE, folder);
  const gt = groundTruth(folder);
  const row: Record<string, unknown> = { folder, gt };
  const t0 = Date.now();
  try {
    const planSet = pickPlanSet(dir);
    if (!planSet) { row.error = "no PDF in folder"; results.push(row); continue; }
    row.planSet = path.basename(planSet);

    const tExtract = Date.now();
    const planText = await extractPdfText(planSet, 30);
    row.msExtract = Date.now() - tExtract;
    row.planTextChars = planText.length;
    if (planText.length < 200) row.warn = "little/no text layer (scanned?)";

    const tLlm = Date.now();
    const ex = await llm.extractProjectFields({ planText, defaultState: gt.state || "OR" });
    row.msLlm = Date.now() - tLlm;
    row.provider = ex.provider;
    const f = ex.fields as Record<string, { value?: string }>;
    row.lowConfidence = ex.lowConfidenceFields?.length ?? 0;

    const got = {
      owner: val(f, "owner") || val(f, "homeownerName"),
      street: val(f, "street") || val(f, "projectAddress"),
      city: val(f, "city"), state: val(f, "state"), zip: val(f, "zip"),
      ahj: val(f, "ahj"), utility: val(f, "utility"),
      dcKw: val(f, "dcKw"), acKw: val(f, "acKw"),
      moduleMake: val(f, "moduleMake"), moduleModel: val(f, "moduleModel"),
      // Microinverter systems (Enphase / APsystems) report pvMicro* instead of inv*.
      invMake: val(f, "invMake") || val(f, "pvMicroMake") || val(f, "inverterMake"),
      invModel: val(f, "invModel") || val(f, "pvMicroModel") || val(f, "inverterModel"),
      moduleQty: val(f, "moduleQty"), mainBreaker: val(f, "mainBreaker"), busRating: val(f, "busRating"),
    };
    row.got = got;
    // ACCURACY vs the folder name (the one ground truth we can trust for every project).
    row.ownerMatch = Boolean(got.owner) && norm(got.owner).includes(norm(gt.owner).slice(0, 6));
    row.cityMatch = Boolean(got.city) && norm(got.city) === norm(gt.city);
    row.stateMatch = got.state.toUpperCase() === gt.state;
    // Score against the CRM's FILED values where we have them — the real accuracy signal.
    const truth = truthFor(gt.owner);
    if (truth) {
      const num = (v: string) => Number(String(v).replace(/[^0-9.]/g, "")) || 0;
      // The CRM writes addresses long-form ("15622 Southeast Vivian Way") while plan sets
      // use postal abbreviations ("15622 SE Vivian Way"). Both are correct, so canonicalise
      // directionals and street types before comparing — otherwise the harness reports a
      // miss on a perfect extraction and sends us hunting a bug that does not exist.
      const ABBREV: Record<string, string> = {
        southeast: "se", southwest: "sw", northeast: "ne", northwest: "nw",
        south: "s", north: "n", east: "e", west: "w",
        street: "st", avenue: "ave", boulevard: "blvd", road: "rd", drive: "dr",
        lane: "ln", court: "ct", place: "pl", terrace: "ter", circle: "cir",
        parkway: "pkwy", highway: "hwy", trail: "trl",
      };
      const streetKey = (v: string) => String(v).toLowerCase().replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/).filter(Boolean).map((w) => ABBREV[w] ?? w).join(" ").trim();
      // "City of Happy Valley" and "Happy Valley city" are the same jurisdiction: compare
      // the distinctive tokens, dropping the boilerplate.
      const ahjKey = (v: string) => new Set(String(v).toLowerCase().replace(/[^a-z\s]/g, " ")
        .split(/\s+/).filter((w) => w && !["city", "county", "of", "town", "the"].includes(w)));
      const sameAhj = (a: string, b: string): boolean => {
        const A = ahjKey(a), B = ahjKey(b);
        if (!A.size || !B.size) return false;
        for (const t of A) if (!B.has(t)) return false;
        for (const t of B) if (!A.has(t)) return false;
        return true;
      };
      row.truth = { street: truth.street, city: truth.city, state: truth.state, zip: truth.zip, ahj: truth.ahj, sizeKw: truth.sizeKw };
      // Only score a field the CRM ACTUALLY carries. An empty tracker cell is missing
      // ground truth, not a wrong extraction — counting it as a miss understates accuracy
      // and (worse) invents bugs to chase. Unscorable fields are reported separately.
      const scorable = (v: string) => Boolean(String(v ?? "").trim());
      row.unscorable = ["street", "city", "state", "zip", "ahj", "sizeKw"]
        .filter((k) => !scorable((truth as unknown as Record<string, string>)[k === "sizeKw" ? "sizeKw" : k]));
      row.vsTruth = {
        street: Boolean(got.street) && streetKey(got.street) === streetKey(truth.street),
        city: Boolean(got.city) && norm(got.city) === norm(truth.city),
        state: Boolean(got.state) && got.state.toUpperCase() === truth.state.toUpperCase(),
        zip: Boolean(got.zip) && got.zip.replace(/\D/g, "").slice(0, 5) === truth.zip.replace(/\D/g, "").slice(0, 5),
        // AHJ naming legitimately varies ("Beaverton" vs "City of Beaverton") — token match.
        ahj: Boolean(got.ahj) && Boolean(truth.ahj) && sameAhj(got.ahj, truth.ahj),
        // kW within 2% covers rounding between DC nameplate conventions.
        sizeKw: num(got.dcKw) > 0 && num(truth.sizeKw) > 0 && Math.abs(num(got.dcKw) - num(truth.sizeKw)) / num(truth.sizeKw) <= 0.02,
      };
      for (const k of row.unscorable as string[]) delete (row.vsTruth as Record<string, boolean>)[k];
    } else {
      row.truth = null;
    }
    // COMPLETENESS of the fields a permit/NEM filing actually needs.
    const required = ["owner", "street", "city", "state", "zip", "ahj", "utility", "dcKw", "moduleMake", "moduleModel", "invMake", "invModel", "moduleQty"];
    row.missing = required.filter((k) => !String((got as Record<string, string>)[k] || "").trim());

    const payload: Record<string, unknown> = { ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v?.value ?? ""])) };
    payload.owner = got.owner || gt.owner;
    payload.city = payload.city || gt.city;
    payload.state = payload.state || gt.state;
    // Synthetic ONLY where the plan set cannot supply it — never overwrite an extracted
    // value, so this can never flatter the extraction's accuracy score.
    const synth = syntheticUtilityData(folders.indexOf(folder) + 1);
    for (const [k, v] of Object.entries(synth)) if (!String(payload[k] ?? "").trim()) payload[k] = v;
    row.synthesized = Object.keys(synth).filter((k) => payload[k] === synth[k as keyof typeof synth]);
    const detail = createProject(db, payload as never);
    row.projectId = detail.project.id;

    saveProjectDocument(db, detail.project.id, {
      docType: "plan_set", filename: path.basename(planSet),
      contentType: "application/pdf", buffer: fs.readFileSync(planSet), source: "upload",
    });

    const tQc = Date.now();
    rerunQc(db, detail.project.id);
    row.msQc = Date.now() - tQc;
    const after = getProjectDetail(db, detail.project.id);
    row.qcFails = after.qcResults.filter((q) => q.qcStatus === "fail").length;
    row.qcWarns = after.qcResults.filter((q) => q.qcStatus === "warning").length;

    const tRev = Date.now();
    const report = buildReviewerReportFor(db, after.project);
    row.msReviewer = Date.now() - tRev;
    const blockers = report.findings.filter((x) => x.severity === "blocker");
    row.blockers = blockers.length;
    row.blockerTitles = blockers.map((b) => `${b.id}: ${b.message ?? b.title}`).slice(0, 8);
    row.atReviewGate = blockers.length === 0;
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
  }
  row.msTotal = Date.now() - t0;
  results.push(row);
  const r = row as Record<string, unknown>;
  const vt = r.vsTruth as Record<string, boolean> | undefined;
  const vtStr = vt ? Object.entries(vt).map(([k, v]) => `${k}=${v ? "Y" : "n"}`).join(" ") : "no-crm-row";
  const gate = r.error ? "ERR" : (r.atReviewGate ? "AT-GATE" : `blocked(${r.blockers ?? "?"})`);
  console.log(`${folder.slice(0, 28).padEnd(28)} | ${String(r.msTotal).padStart(6)}ms | ${String(gate).padEnd(11)} | ${vtStr} | missing=${(r.missing as string[] | undefined)?.length ?? "-"} ${r.error ? "| " + String(r.error).slice(0, 80) : ""}`);
}

// AGGREGATE — the number that matters: how many reached the reviewer gate cleanly.
const done = results.filter((r) => !r.error);
const atGate = done.filter((r) => r.atReviewGate).length;
const scored = results.filter((r) => r.vsTruth) as Array<Record<string, Record<string, boolean>>>;
const fieldTally: Record<string, { ok: number; n: number }> = {};
for (const r of scored) for (const [k, v] of Object.entries(r.vsTruth)) {
  fieldTally[k] = fieldTally[k] || { ok: 0, n: 0 };
  fieldTally[k].n++; if (v) fieldTally[k].ok++;
}
console.log(`
=== ${results.length} projects | ${done.length} parsed | ${atGate} reached the review gate cleanly | ${results.length - done.length} errored`);
if (scored.length) {
  console.log(`=== accuracy vs CRM (${scored.length} with a tracker row): ` +
    Object.entries(fieldTally).map(([k, v]) => `${k} ${v.ok}/${v.n}`).join("  "));
}
const llmMs = done.map((r) => Number(r.msLlm || 0)).filter(Boolean);
if (llmMs.length) console.log(`=== llm mean ${Math.round(llmMs.reduce((a, b) => a + b, 0) / llmMs.length)}ms of ${Math.round(done.reduce((a, b) => a + Number(b.msTotal || 0), 0) / done.length)}ms total`);

const out = path.resolve("data/test-run-report.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), count: results.length, results }, null, 2));
console.log(`\nreport: ${out}`);
try { db.close(); } catch { /* ignore */ }
process.exit(0);
