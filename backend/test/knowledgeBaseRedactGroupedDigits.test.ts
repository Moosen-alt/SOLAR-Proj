// A GROUPED ACCOUNT / METER NUMBER NEVER LANDS IN A CORRECTION SAMPLE (#277, rule 2).
//
// redact() (knowledgeBase.ts — behind redactSample and redactEmailText) scrubbed only a bare
// \b\d{5,}\b run, so an account or meter number written in groups ("80 000 1234",
// "1234-5678-90") passed straight into historical_failure_examples.sample. It now reads digits
// with separators IGNORED, as wordingNamesProject does, and keeps the shapes a reviewer must
// still read: dates, code sections, dimensions, ratings.
//
// KILL (verified red by hand): drop the GROUPED_DIGITS replace (restore the \b\d{5,}\b line) →
// every MUST-PASS check fails; drop the READABLE_DIGIT_RUN test → the date and "690.12" checks fail.
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
  ];
  for (const [label, input] of readable) {
    const out = kb.redactEmailText(input);
    check(`MUST-EXCLUDE: ${label} stays readable`, out === input, out);
  }

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

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
