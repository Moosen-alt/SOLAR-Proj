// A GROUPED ACCOUNT / METER NUMBER NEVER LANDS IN A CORRECTION SAMPLE (#277, rule 2).
//
// redact() (knowledgeBase.ts — behind redactSample and redactEmailText) scrubbed only a bare
// \b\d{5,}\b run, so an account or meter number written in groups ("80 000 1234",
// "1234-5678-90") passed straight into historical_failure_examples.sample. It now reads digits
// with separators IGNORED, as wordingNamesProject does, and keeps the shapes a reviewer must
// still read: dates, code sections, dimensions, ratings.
//
// redact() feeds enrichMboxLearningWithLlm -> the triage model, so this is a rule-2 model path.
// It scrubs before clean() folds newlines (a numbered letter's "2." must not join the line above),
// and the mbox dedupe signature no longer hashes the redacted body, so a mailbox imported before
// this change is not imported twice (legacy signature looked up alongside).
//
// KILL (verified red by hand): drop the GROUPED_DIGITS replace (restore the \b\d{5,}\b line) →
// every MUST-PASS check fails; drop the readableChunk test → the date/section/letter checks fail;
// scrub after clean() → the numbered-letter check fails; drop the legacy signature from the
// dedupe lookup → the cross-version re-import check fails.
//
// All numbers are synthetic.
//
//   npx tsx backend/test/knowledgeBaseRedactGroupedDigits.test.ts
import "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

async function main(): Promise<void> {
  const { openDatabase } = await import("../src/db");
  const kb = await import("../src/knowledgeBase");
  const { classifyCorrection } = await import("../src/corrections");

  // MUST-PASS: identifier-shaped runs are gone, whatever groups them.
  const grouped: Array<[string, string]> = [
    ["space-grouped account", "Account 80 000 1234 does not match the bill."],
    ["dash-grouped account", "Account no. 1234-5678-90 does not match."],
    ["dot-grouped meter", "Meter 9876.5432.10 is not on the one-line."],
    ["#-grouped service agreement", "SA#1234#5678 on the application."],
    ["en-dash-grouped meter", "Meter 4321–8765 per the photo."],
    ["mixed separators", "ESI ID 1008 9012-3456.78 is required."],
    ["Unicode-dash-grouped meter", "Meter 1234\u20105678 and 2345\u20116789 and 3456\u20127890 and 4567\u20148901 and 5678\u22129012."],
    ["implausible ISO date shape", "Account 1234-56-78 on the bill."],
    ["implausible US date shape", "Account 99-99-9999 on the bill."],
    ["line-wrapped account", "Account 1234\n5678 on the bill."],
    ["line-wrapped account, trailing space", "Account 4455 \n6677 on the bill."],
    ["line-wrapped meter, three lines", "Meter 44\n556\n677 on the photo."],
    ["year then short count is not a reference", "Account 2023 12 on file."],
    ["dotted 4.3 run", "Meter 1234.567 on the photo."],
    ["section-shaped 3-level run with 3-digit tail", "Meter 123.456.789 on the photo."],
    ["bare long run (prior behaviour kept)", "Account 8000012345 is wrong."],
    ["letter-prefixed run", "Ref ACCT00012345 on file."],
  ];
  for (const [label, input] of grouped) {
    const out = kb.redactEmailText(input);
    const digits = (out.match(/\d/g) || []).length;
    check(`MUST-PASS: ${label} is redacted`, out.includes("[number]") && digits < 5, out);
  }

  // MUST-EXCLUDE: readable shapes stay verbatim.
  const readable: Array<[string, string]> = [
    ["code section with subsections", "Comply with NEC 690.12(B)(2) rapid shutdown."],
    ["IRC section", "Provide the R324.6 roof access pathway."],
    ["ISO date", "Resubmitted 2026-10-08 after review."],
    ["dotted date", "Received 10.08.2026 at the counter."],
    ["dimension", "Keep a 10 FT setback from the ridge."],
    ["breaker rating", "The 200A main breaker must be derated."],
    ["system size", "System is 7.6 kW DC."],
    ["spacing", "Attachments at 48 IN O.C. max."],
    ["service voltage", "Service is 120/240 V single phase."],
    ["code edition", "Per the 2023 NEC and 2022 CEC."],
    ["multi-level section", "Per CRC R324.6.1 and IBC 1507.3.1."],
    ["standard edition", "Inverter listed to IEEE 1547-2018 and UL 1741."],
    ["section then year", "Per NEC 690.12 2023 edition."],
    ["sentence-ending section", "Label per NEC 690.56. 2026 rules apply."],
    ["date then time", "Inspection set for 2026-10-08 10:30 AM."],
    ["section then a count", "Per NEC 690.12 2 disconnects are required."],
    ["edition then a count", "Listed to IEEE 1547-2018 2 inverters on site."],
    ["dash-joined section range", "See NEC 690.12-690.15 for shutdown."],
    ["section wrapped onto a date", "Per NEC 690.56\n2026-10-08 notice."],
  ];
  for (const [label, input] of readable) {
    const out = kb.redactEmailText(input);
    check(`MUST-EXCLUDE: ${label} stays readable`, out === input.replace(/\s+/g, " "), out);
  }

  // wordingNamesProject reads the same dashes, so the shared-table guard stays in step.
  const { wordingNamesProject } = await import("../src/ahjReviewRules");
  for (const dash of ["\u2010", "\u2011", "\u2012", "\u2014", "\u2212"]) {
    check(`wordingNamesProject flags a U+${dash.charCodeAt(0).toString(16).toUpperCase()}-grouped number`, wordingNamesProject(`Meter 123${dash}45`, {}));
  }

  // A realistic numbered correction letter: a list number on the next line must not join the
  // section / edition / date that ends the line above it.
  const letter = [
    "CORRECTION NOTICE 2026-10-08",
    "1. Provide the roof access pathway per CRC R324.6.1",
    "2. Provide placards per NEC 690.56",
    "3. Inverter must be listed to IEEE 1547-2018",
    "4. Resubmit by 10.22.2026",
    "5. Account 80 000 1234 does not match the bill",
  ].join("\n");
  const letterOut = kb.redactEmailText(letter);
  for (const keep of ["2026-10-08", "R324.6.1", "690.56", "1547-2018", "10.22.2026", "2. Provide", "4. Resubmit", "5. Account"]) {
    check(`MUST-EXCLUDE: the numbered letter keeps "${keep}"`, letterOut.includes(keep), letterOut);
  }
  check("MUST-PASS: …while its account number is redacted", !letterOut.includes("80 000 1234") && letterOut.includes("Account [number]"), letterOut);

  // LINE-WRAP FUZZ: a grouped number a line break splits is still one number once clean()
  // rejoins it. Separators carry no "-" or "." and no group starts with 1 or 2, so no date,
  // section, edition or year can form: every 5+ digit run must go. (Deterministic PRNG.)
  let seed = 277;
  const rnd = (n: number): number => { // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const wrapSeps = ["\n", " \n", "\n ", "\t\n", " ", "#", "–", "−", " \n "];
  let wrapped = 0, survivors = 0; const examples: string[] = [];
  for (let i = 0; i < 20000; i++) {
    const groups = 2 + rnd(4);
    let num = "", digits = 0, hasBreak = false;
    for (let g = 0; g < groups; g++) {
      const len = 1 + rnd(4);
      let d = String(3 + rnd(7));
      for (let k = 1; k < len; k++) d += String(rnd(10));
      const sep = g ? wrapSeps[rnd(wrapSeps.length)] : "";
      if (sep.includes("\n")) hasBreak = true;
      num += sep + d; digits += len;
    }
    if (digits < 5 || !hasBreak) continue;
    wrapped++;
    const out = kb.redactEmailText(`Account ${num} is wrong.`);
    if (/\d(?:[\s#–−]*\d){4,}/.test(out)) { survivors++; if (examples.length < 5) examples.push(JSON.stringify(num)); }
  }
  check(`line-wrap fuzz: no 5+ digit survivor across ${wrapped} wrapped numbers`, wrapped > 5000 && survivors === 0, `${survivors} survived, e.g. ${examples.join(", ")}`);

  // MUST-PASS: a wrap whose next line is a 1-3 digit tail before "." or ")" looks like a list
  // item to GROUPED_DIGITS, so only the pass after clean() catches it.
  const listShapedTails: Array<[string, string]> = [
    ["tail before \". Please\"", "The meter number on the photo is 9535-\n70. Please resubmit."],
    ["tail before \")\"", "The meter number on the photo is 9535-\n70) on the bill."],
    ["tail before a final \".\"", "The meter number on the photo is 9535-\n70."],
    ["tail before a final \")\"", "(meter 9535-\n70)"],
    ["3-digit tail before \".\"", "Account 4455\n667. Please resubmit."],
    ["1-digit tail before \")\"", "Account 4455\n7) on file."],
  ];
  for (const [label, input] of listShapedTails) {
    const out = kb.redactEmailText(input);
    check(`MUST-PASS: line-wrapped number with a list-shaped ${label} is redacted`, out.includes("[number]") && !/\d(?:[\s\-#–−]*\d){4,}/.test(out), out);
  }
  // ...and the same as a fuzz: the last line is a 1-3 digit tail followed by "." or ")".
  const tailSuffixes = [". Please resubmit.", ") on the bill.", ".", ")"];
  let tailWrapped = 0, tailSurvivors = 0; const tailExamples: string[] = [];
  for (let i = 0; i < 5000; i++) {
    const groups = 1 + rnd(3);
    let num = "", digits = 0;
    for (let g = 0; g < groups; g++) {
      const len = 1 + rnd(4);
      let d = String(3 + rnd(7));
      for (let k = 1; k < len; k++) d += String(rnd(10));
      num += (g ? wrapSeps[rnd(wrapSeps.length)] : "") + d; digits += len;
    }
    const tailLen = 1 + rnd(3);
    let tail = String(3 + rnd(7));
    for (let k = 1; k < tailLen; k++) tail += String(rnd(10));
    num += ["-\n", "\n", " \n", "–\n"][rnd(4)] + tail; digits += tailLen;
    if (digits < 5) continue;
    tailWrapped++;
    const out = kb.redactEmailText(`Meter ${num}${tailSuffixes[rnd(tailSuffixes.length)]}`);
    if (/\d(?:[\s\-#–−]*\d){4,}/.test(out)) { tailSurvivors++; if (tailExamples.length < 5) tailExamples.push(JSON.stringify(num)); }
  }
  check(`line-wrap fuzz: no 5+ digit survivor across ${tailWrapped} wraps onto a list-shaped tail`, tailWrapped > 2000 && tailSurvivors === 0, `${tailSurvivors} survived, e.g. ${tailExamples.join(", ")}`);

  // A phone keeps its own tag (the grouped rule runs after it).
  check("a phone number is still tagged [phone]", kb.redactEmailText("Call 555-010-1234 today.") === "Call [phone] today.", kb.redactEmailText("Call 555-010-1234 today."));

  // The real write path: a correction excerpt with a grouped account number, learned into
  // historical_failure_examples.sample.
  const db = await openDatabase();
  const now = new Date().toISOString();
  db.run("INSERT INTO orgs (id, name, edition, created_at) VALUES ('org-redact', 'org-redact', 'full', ?)", [now]);
  db.run(
    `INSERT INTO projects (id, org_id, homeowner_name, city, state, ahj, utility, status, parser_json, created_at, updated_at)
     VALUES ('proj-redact', 'org-redact', 'T Test', 'Coos Bay', 'OR', 'City of Coos Bay', 'Pacific Power', 'parsed', '{}', ?, ?)`,
    [now, now],
  );
  const project = {
    id: "proj-redact", clientId: null, homeownerName: "T Test", projectAddress: "1 Main St", city: "Coos Bay", state: "OR", zip: "97420",
    ahj: "City of Coos Bay", utility: "Pacific Power", accountNumber: "", meterNumber: "", systemSizeDcKw: 5, systemSizeAcKw: 5,
    totalExportKw: null, interconnectionMethod: "", status: "parsed", currentStage: "", parserConfidenceSummary: "",
    parserSnapshot: {}, createdAt: now, updatedAt: now,
  } as never as Parameters<typeof kb.learnFromCorrection>[1];
  const correctionText = "The account number 80 000 1234 does not match the utility bill; meter 1234-5678-90 missing. Resubmitted 2026-10-08 per NEC 690.12(B)(2).";
  kb.learnFromCorrection(db, project, null, classifyCorrection(correctionText), correctionText, "manual");
  const rows = db.query<{ sample: string }>("SELECT sample FROM historical_failure_examples");
  check("SETUP: the correction wrote a historical failure row", rows.length === 1, String(rows.length));
  const sample = rows[0]?.sample ?? "";
  check("the stored sample carries neither grouped number", !sample.includes("80 000 1234") && !sample.includes("1234-5678-90") && !/\d{4}[-\s]\d{4}/.test(sample), sample);
  check("…and keeps the date and the code section readable", sample.includes("2026-10-08") && sample.includes("690.12(B)(2)"), sample);

  // CROSS-VERSION RE-IMPORT: a mailbox imported before this change carries the OLD signature —
  // the body as the old redact() read it. Frozen copy of that formula, as main had it:
  const crypto = await import("node:crypto");
  const legacySeed = (body: string): string => body.replace(/\s+/g, " ").trim()
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b\d{2,6}\s+[A-Z0-9 .'-]{3,60}\s+(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|LN|LANE|CT|COURT|PL|PLACE|WAY|BLVD|CIR|CIRCLE)\b(?:[, ]+[A-Z .'-]{2,40})?/gi, "[address]")
    .replace(/\b\d{5,}\b/g, "[number]")
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, "[phone]")
    .slice(0, 240).slice(0, 180);
  const LABEL = "synthetic.mbox";
  const SUBJECT = "Pacific Power PowerClerk correction required";
  const DATE = "Mon, 15 Jun 2026 10:00:00 -0700";
  const BODY = "Correction required. Pacific Power PowerClerk application account 80 000 1234 does not match the bill and the meter photo is missing. Please revise and resubmit.";
  const mbox = `From reviewer@example.com Mon Jun 15 10:00:00 2026\nSubject: ${SUBJECT}\nDate: ${DATE}\n\n${BODY}\n`;
  const legacySig = crypto.createHash("sha256").update(`${LABEL}|${SUBJECT}|${DATE}|${legacySeed(BODY)}`).digest("hex");
  const classified = await kb.classifyMboxMessages({ mboxText: mbox, sourceLabel: LABEL });
  check("the classified message carries the pre-change signature as legacySourceSignature",
    classified.messages[0]?.legacySourceSignature === legacySig, String(classified.messages[0]?.legacySourceSignature));
  check("…and a new signature that does not hash the redacted body", Boolean(classified.messages[0]?.sourceSignature) && classified.messages[0]?.sourceSignature !== legacySig);

  const count = (table: string): number => Number(db.get<{ c: number }>(`SELECT COUNT(*) c FROM ${table}`)?.c ?? 0);
  const first = await kb.importMboxKnowledge(db, { orgId: "org-redact", mboxText: mbox, sourceLabel: LABEL });
  check("SETUP: the first import wrote one learning record and one failure row",
    first.learningEvents === 1 && first.failureExamplesImported === 1, JSON.stringify({ e: first.learningEvents, f: first.failureExamplesImported }));
  // Turn that import into one made BEFORE the upgrade: its rows carry the legacy signature.
  db.run("UPDATE mbox_learning_records SET source_signature = ?", [legacySig]);
  const before = { records: count("mbox_learning_records"), failures: count("historical_failure_examples"), shared: db.query<{ c: string }>("SELECT common_corrections_json c FROM permit_utility_knowledge").map((r) => r.c).join("|") };
  const again = await kb.importMboxKnowledge(db, { orgId: "org-redact", mboxText: mbox, sourceLabel: LABEL });
  check("re-importing the pre-upgrade mailbox is recognised as a duplicate", again.duplicateMessages === 1 && again.learningEvents === 0, JSON.stringify({ d: again.duplicateMessages, e: again.learningEvents }));
  check("…writes no new learning record or failure row", count("mbox_learning_records") === before.records && count("historical_failure_examples") === before.failures,
    JSON.stringify({ records: count("mbox_learning_records"), failures: count("historical_failure_examples"), before }));
  check("…and leaves the shared rollup unchanged", db.query<{ c: string }>("SELECT common_corrections_json c FROM permit_utility_knowledge").map((r) => r.c).join("|") === before.shared);
  const third = await kb.importMboxKnowledge(db, { orgId: "org-redact", mboxText: mbox.replace(BODY, `${BODY} Second notice.`), sourceLabel: LABEL });
  check("positive control: a genuinely different message still imports", third.learningEvents === 1, JSON.stringify({ e: third.learningEvents, d: third.duplicateMessages }));

  // THE EMAIL TRACKER re-reads the whole watched mailbox on every run; email_project_matches is
  // what stops it filing the same email twice on a live project (status checks, corrections).
  // A match written before this change carries the legacy signature and must still count.
  const R = await import("../src/repository");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const pid = R.createProject(db, {
    owner: "Wynema Probe", state: "OR", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
    street: "77 Harbor View Rd", city: "Coos Bay", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
  } as never).project.id;
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  const mailFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "redact-tracker-")), "watched.mbox");
  const TSUBJECT = "City of Coos Bay building permit corrections required";
  const TDATE = "Wed, 17 Jun 2026 10:00:00 -0700";
  const TBODY = "Corrections required for the solar building permit for Wynema Probe at 77 Harbor View Rd, Coos Bay, OR 97420. Provide the rafter span calculations and resubmit. Utility account 80 000 1234 on the application does not match the bill.";
  fs.writeFileSync(mailFile, `From sender@example.gov Wed Jun 17 10:00:00 2026\nSubject: ${TSUBJECT}\nDate: ${TDATE}\n\n${TBODY}\n`);
  const TLABEL = "watched.mbox";
  const source = R.configureEmailTrackingSource(db, { filePath: mailFile, label: TLABEL }).sources.find((x) => x.label === TLABEL)!;
  const trackerRows = () => ({
    matches: Number(db.get<{ c: number }>("SELECT COUNT(*) c FROM email_project_matches WHERE project_id = ?", [pid])?.c ?? 0),
    checks: Number(db.get<{ c: number }>("SELECT COUNT(*) c FROM permit_status_checks WHERE project_id = ?", [pid])?.c ?? 0),
    corrections: Number(db.get<{ c: number }>("SELECT COUNT(*) c FROM corrections WHERE project_id = ?", [pid])?.c ?? 0),
    learned: count("mbox_learning_records"),
  });
  const firstRun = await R.runEmailTracker(db, { sourceId: source.id });
  const afterFirst = trackerRows();
  check("SETUP: the tracker matched the email to the project and filed a status check",
    firstRun.projectMatches === 1 && afterFirst.matches === 1 && afterFirst.checks >= 1, JSON.stringify({ firstRun, afterFirst }));
  // Make that run one from BEFORE the upgrade: every stored signature in the legacy form.
  const trackerLegacy = crypto.createHash("sha256").update(`${TLABEL}|${TSUBJECT}|${TDATE}|${legacySeed(TBODY)}`).digest("hex");
  db.run("UPDATE email_project_matches SET source_signature = ? WHERE project_id = ?", [trackerLegacy, pid]);
  db.run("UPDATE mbox_learning_records SET source_signature = ? WHERE source_label = ?", [trackerLegacy, TLABEL]);
  const secondRun = await R.runEmailTracker(db, { sourceId: source.id });
  check("re-running the tracker over a pre-upgrade match skips it as a duplicate",
    secondRun.skippedDuplicates === 1 && secondRun.projectMatches === 0, JSON.stringify(secondRun));
  check("…and files no second match, status check, correction or learning record",
    JSON.stringify(trackerRows()) === JSON.stringify(afterFirst), JSON.stringify({ now: trackerRows(), afterFirst }));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
