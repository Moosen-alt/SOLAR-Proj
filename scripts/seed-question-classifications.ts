// THE OPERATOR'S BUSINESS CALLS ON THE TRIAGE QUEUE, RECORDED WITH THEIR REASONS.
//
// portal_question_overrides is what `npm run portal:triage` writes, one keypress at a time.
// These fourteen were decided in conversation instead, so they are written here rather than
// retyped — but with the reasoning beside each one, because a classification with no reason
// is indistinguishable from a guess, and guessing is the exact thing the question bank exists
// to stop.
//
// PER-JOB    the answer changes from job to job. It must come from the project or be asked at
//            intake; a per-job answer left frozen is ranked worst by auditFrozenAnswers, which
//            is the correct visible outcome for one we cannot yet derive.
// PORTAL-CONSTANT  this operator's answer is always the same, so the recorded answer is safe to
//            keep replaying.
//
// TWO QUESTIONS ARE DELIBERATELY NOT HERE. Both Accela recipes carry a checkbox whose recorded
// label is the bare word "No" — the recorder captured the OPTION's own text, not the question
// above it, so there is nothing to classify. They sit at:
//    structural, step 29: between "contacts: continue" and "Category of Construction"
//    electrical, step 44: between "Additional Comments:" and "*Other Category of Construction:"
// They are different questions that share a label, and portal_question_overrides is keyed
// (profile_key, label_norm) — so ONE override would silently answer for BOTH. They stay
// unclassified until a person reads the page. The generalising fix is on the recorder: a
// yes/no control should be captured under its QUESTION, not under its option.
//
//   npx tsx scripts/seed-question-classifications.ts [--dry-run]
import "dotenv/config";
process.env.AUTOPILOT_DB_PATH = process.env.AUTOPILOT_DB_PATH || "backend/data/autopilot.sqlite";

const dryRun = process.argv.includes("--dry-run");
const { openDatabase } = await import("../backend/src/db");
const { setPortalQuestionOverride, getPortalQuestionOverrides, normalizeQuestionLabel } =
  await import("../backend/src/portalQuestionBank");

const db = await openDatabase();

const ACCELA = "or|city of coos bay|pacific power";
const AMEREN = "il|unknown|ameren illinois";
const PACIFICORP = "or|unknown|pacific power";
const PGE = "or|unknown|portland general electric";

interface Call {
  key: string;
  label: string;
  classification: "portal-constant" | "per-job";
  why: string;
}

const CALLS: Call[] = [
  // ── Accela (City of Coos Bay) ────────────────────────────────────────────────────────
  {
    key: ACCELA, label: "Residential - Structural", classification: "portal-constant",
    why: "The record type IS the discipline, and the discipline is already part of the recipe's key. A structural recipe files a structural record type every time; there is no job on which this differs.",
  },
  {
    key: ACCELA, label: "Residential - Electrical", classification: "portal-constant",
    why: "Same: the electrical recipe files the electrical record type every time.",
  },
  {
    key: ACCELA, label: "Project includes any of the following:", classification: "portal-constant",
    why: "Accela is asking about hazardous/commercial scope flags. Residential rooftop PV answers 01-Not Applicable on every job. This holds as long as the work mix stays residential rooftop — if a commercial filing is ever added, re-triage this one.",
  },

  // ── PacifiCorp (Pacific Power) ───────────────────────────────────────────────────────
  {
    key: PACIFICORP, label: "Will the net metering facility interconnect to a switchgear?", classification: "portal-constant",
    why: "A site fact in principle, and No on every standard residential interconnection this operator files. Operator's call, taken deliberately rather than by default.",
  },
  {
    key: PACIFICORP, label: "Will the net metering facility include a parallel blocking scheme?", classification: "portal-constant",
    why: "A design fact, and No on a standard residential net-metering system. Operator's call.",
  },
  {
    key: PACIFICORP, label: "Will the output of this generation system serve more than one customer?", classification: "portal-constant",
    why: "A site fact, and No on a single-family rooftop. Operator's call.",
  },
  {
    key: PACIFICORP, label: "Please make your selection regarding meter aggregation below", classification: "per-job",
    why: "THE ONE SITE FACT THAT REALLY VARIES. The operator flagged meter aggregation as genuinely per-job — sometimes a customer aggregates meters and sometimes not — and elected to answer it by hand each time rather than have it derived. Marked per-job so the recorded 'No Aggregation' shows up as a frozen per-job answer in the audit and on the review screen, which is what 'we do this one manually' should look like.",
  },

  // ── Portland General Electric ────────────────────────────────────────────────────────
  {
    key: PGE, label: "policy default: Do you propose to limit the export capacity? → No", classification: "portal-constant",
    why: "Export limiting is a design election, and this operator does not propose it — a full-export residential net-metering system every time. Note this is a POLICY DEFAULT step, which already carries its answer in its own label.",
  },
  {
    key: PGE, label: "Please make your selection regarding meter aggregation", classification: "per-job",
    why: "Same call as PacifiCorp's aggregation question, and the same reason — answered by hand per job.",
  },

  // ── Ameren Illinois ──────────────────────────────────────────────────────────────────
  {
    key: AMEREN, label: "Application Level", classification: "per-job",
    why: "THE HIGHEST-STAKES ONE IN THE QUEUE. Level is size-dependent: Level 1 covers 25 kW export / 50 kW nameplate and costs $50; Level 2 is $100 plus $1/kVA. A frozen 'Level 1' on a larger system files the wrong review level AND under-states the fee, and the field looks answered either way. There is no binding that produces the portal's own words ('Level 1'/'Level 2') yet, so marking it per-job does not fix it today — it makes it VISIBLE, ranked worst by auditFrozenAnswers, until a derived key exists.",
  },
  {
    key: AMEREN, label: "Application Type", classification: "per-job",
    why: "'Existing Customer without Generation' is wrong for any retrofit at a site that already has PV, and we already parse that: hasExistingSystem is a real binding this can be wired to.",
  },
  {
    // TRUNCATED ON PURPOSE, and it must be. The recorder caps a captured label at 80
    // characters, so what the bank holds ends mid-word at "please provid". An override is
    // keyed on the STORED label, not on the portal's full sentence — writing the complete
    // question here matched nothing and left this one in the queue looking unanswered.
    key: AMEREN, label: "Have you submitted a Pre-Application for this project site? If so, please provid", classification: "per-job",
    why: "A project fact. Practically always No — the pre-application is an optional $300 step — but it is not a property of the portal, and a job that did submit one has an ID to quote.",
  },
  {
    key: AMEREN, label: "Do you want to be considered for the volt-watt pilot?", classification: "portal-constant",
    why: "A business policy election, not a fact about the job. This operator's answer is the same on every application.",
  },
  {
    key: AMEREN, label: "Does the local municipality require an inspection before Ameren approval?", classification: "per-job",
    why: "A jurisdiction fact that varies across Ameren's territory. Derivable from the AHJ once somebody records which municipalities require it; per-job keeps it honest and visible until then.",
  },
];

// A LABEL THAT MATCHES NO QUESTION IS AN ORPHAN, AND ORPHANS ARE SILENT.
//
// The first run of this script wrote the Pre-Application question under the portal's FULL
// sentence. The recorder caps a captured label at 80 characters, so the bank holds a version
// ending mid-word at "please provid" — the override matched nothing, the question stayed in
// the triage queue looking unanswered, and a row that answers no question sat in a shared
// table for the next reader to puzzle over. Nothing reported any of that.
//
// So every label is checked against the questions the bank actually extracts before it is
// written. A miss is named with the nearest stored label, which is the thing you need to see.
const { extractPortalQuestions } = await import("../backend/src/portalQuestionBank");
const { getPortalRecipe } = await import("../backend/src/portalRecipes");
const knownLabels = new Map<string, Set<string>>();
for (const row of db.query<{ id: string; profile_key: string }>("SELECT id, profile_key FROM portal_recipes WHERE status = 'complete'")) {
  const set = knownLabels.get(row.profile_key) ?? new Set<string>();
  try {
    for (const q of extractPortalQuestions(db, getPortalRecipe(db, row.id))) set.add(q.labelNorm);
  } catch (err) {
    console.error(`  ! could not read ${row.profile_key}: ${err instanceof Error ? err.message : String(err)}`);
  }
  knownLabels.set(row.profile_key, set);
}

console.log(`\nRecording ${CALLS.length} classification(s) into portal_question_overrides${dryRun ? "  (--dry-run)" : ""}\n`);

let written = 0;
let unchanged = 0;
let orphans = 0;
for (const call of CALLS) {
  const norm = normalizeQuestionLabel(call.label);
  const known = knownLabels.get(call.key);
  if (known && !known.has(norm)) {
    orphans++;
    // Compare on a SHORT prefix. The mismatches worth catching are a truncated label and a
    // typo near the end — both of which share an opening and diverge later, so a long prefix
    // finds nothing exactly when the hint would have helped.
    const near = [...known].filter((l) => l.slice(0, 12) === norm.slice(0, 12));
    console.error(`  ORPHAN  ${call.label.slice(0, 62)}`);
    console.error(`      no question under "${call.key}" carries this label — NOT written.`);
    if (near.length) console.error(`      did you mean: ${near.map((l) => JSON.stringify(l)).join(", ")}`);
    continue;
  }
  const existing = getPortalQuestionOverrides(db, call.key).get(normalizeQuestionLabel(call.label));
  const state = !existing
    ? "new"
    : existing.classification === call.classification ? "unchanged" : `CHANGING from ${existing.classification}`;
  console.log(`  ${call.classification.padEnd(15)} ${call.label.slice(0, 62).padEnd(62)} ${state}`);
  console.log(`      ${call.why.slice(0, 150)}${call.why.length > 150 ? "…" : ""}`);
  if (state === "unchanged") { unchanged++; continue; }
  // setPortalQuestionOverride is POSITIONAL — (db, profileKey, label, classification, binding).
  // An object argument typechecks clean here and writes "[object Object]" into the label.
  if (!dryRun) setPortalQuestionOverride(db, call.key, call.label, call.classification);
  written++;
}

console.log(`\n  ${dryRun ? "would write" : "wrote"} ${written}, left ${unchanged} unchanged${orphans ? `, REFUSED ${orphans} orphan(s) — see above` : ""}.`);
console.log(`  The two bare-"No" Accela checkboxes stay unclassified on purpose — see the header.\n`);
