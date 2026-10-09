// A SECRET GROUPED BY ANY DASH NEVER REACHES THE PLANNER (#286, rule 2).
//
// redactSecretValues (shared/src/portalSafety.ts) is the planner and design-digest scrub. Its
// separator class read only the ASCII hyphen and U+2013, so "acct 1234—5678—90" (em dash),
// U+2011 (non-breaking hyphen, what a PDF text layer often yields) and U+2212 (minus) came back
// unchanged and went to the model. It now reads U+2010-2015 and U+2212 too, as
// wordingNamesProject does; whitespace (a line wrap, a CRLF wrap) was already a separator and is
// pinned here so it stays one.
//
// KILL (verified red by hand): restore "[\\s\\-\\u2013.#/]*" in redactSecretValues → every
// non-ASCII, non-U+2013 dash MUST-PASS check (and the digest check) fails.
//
// All numbers are synthetic.
//
//   npx tsx backend/test/redactSecretValuesDashes.test.ts
import "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

async function main(): Promise<void> {
  const { redactSecretValues } = await import("../../shared/src/portalSafety");
  const { designNotesDigest, projectSecretValues } = await import("../src/autoLearn");
  const { wordingNamesProject } = await import("../src/ahjReviewRules");
  const digits = (s: string): string => s.replace(/\D/g, "");

  const ACCOUNT = "1234567890";
  const METER = "80000100";
  const secrets = [ACCOUNT, METER];

  // MUST-PASS: every dash form, alone and mixed, and a wrapped number.
  const dashes: Array<[string, string]> = [
    ["ASCII hyphen", "-"],
    ["U+2010 hyphen", "‐"],
    ["U+2011 non-breaking hyphen", "‑"],
    ["U+2012 figure dash", "‒"],
    ["U+2013 en dash", "–"],
    ["U+2014 em dash", "—"],
    ["U+2015 horizontal bar", "―"],
    ["U+2212 minus", "−"],
  ];
  for (const [label, d] of dashes) {
    const text = `acct 1234${d}5678${d}90 on the bill`;
    const out = redactSecretValues(text, secrets);
    check(`MUST-PASS: ${label}-grouped account is redacted`, out === "acct [redacted] on the bill", out);
    const spaced = `meter #80 ${d} 000 ${d} 100 per photo`;
    const outSpaced = redactSecretValues(spaced, secrets);
    check(`MUST-PASS: ${label} with spaces around it is redacted`, outSpaced === "meter #[redacted] per photo", outSpaced);
  }
  const wraps: Array<[string, string]> = [
    ["line wrap", "acct 12345\n67890 on the bill"],
    ["CRLF wrap", "acct 12345\r\n67890 on the bill"],
    ["wrap after a dash", "acct 1234—\n5678—90 on the bill"],
    ["CRLF wrap inside a dash group", "acct 1234‑\r\n5678−90 on the bill"],
    ["mixed separators", "acct 12.34‒ 56#78/9―0 on the bill"],
  ];
  for (const [label, text] of wraps) {
    const out = redactSecretValues(text, secrets);
    check(`MUST-PASS: ${label} is redacted`, out === "acct [redacted] on the bill", JSON.stringify(out));
  }

  // MUST-EXCLUDE: only the listed secret goes. Code sections, dates, other numbers and a longer
  // run that merely contains the secret's digits stay verbatim.
  const keep: Array<[string, string]> = [
    ["code sections", "Comply with NEC 690.12 and CRC R324.6.1 — rapid shutdown."],
    ["dates, any dash", "Resubmitted 2026–10–08; inspected 2026−10−09; due 10—22—2026."],
    ["the project's other numbers", "37 modules, 12.913 kW AC, ZIP 97140, 200A main, 120/240 V, call 555‑010‑1234."],
    ["another identifier with a dash", "Permit 2026—004417 issued."],
    ["a longer run containing the secret", "Ref 91234—5678—9012 is a different number."],
    ["the secret's digits as a prefix of a longer run", "Ref 1234–5678–9012 is a different number."],
  ];
  for (const [label, text] of keep) {
    const out = redactSecretValues(text, secrets);
    check(`MUST-EXCLUDE: ${label} stay(s) verbatim`, out === text, out);
  }
  const mixed = "Per NEC 690.12, resubmitted 2026—10—08: acct 1234—5678—90, meter 80−000−100, 200A main.";
  const mixedOut = redactSecretValues(mixed, secrets);
  check("MUST-PASS + MUST-EXCLUDE in one line: both secrets go, the section, date and rating stay",
    mixedOut === "Per NEC 690.12, resubmitted 2026—10—08: acct [redacted], meter [redacted], 200A main.", mixedOut);

  // The real model path: the planner's design digest, built from parser text that quotes the
  // meter with em dashes and the account with non-breaking hyphens across a CRLF wrap.
  const project = {
    id: "p-dash", accountNumber: ACCOUNT, meterNumber: METER,
    parserSnapshot: {
      meter: METER, account: ACCOUNT,
      sitePlanNotesText: "Existing main service panel tied to exterior utility meter #80—000—100, new PV AC disconnect within 10' of the utility meter per NEC 690.13",
      electricalCalcText: "Utility account 1234‑5678‑\r\n90 on file; 200A main, 70A fuses in the new PV AC disconnect",
    },
  } as never;
  check("SETUP: projectSecretValues lists the account and the meter",
    projectSecretValues(project).includes(ACCOUNT) && projectSecretValues(project).includes(METER), JSON.stringify(projectSecretValues(project)));
  const digest = designNotesDigest(project);
  check("MUST-PASS: the design digest carries neither dash-grouped secret",
    !digits(digest).includes(METER) && !digits(digest).includes(ACCOUNT) && digest.includes("[redacted]"), digest);
  // (The digest splits sentences on "." itself, so a section is pinned above, not here.)
  check("MUST-EXCLUDE: the digest keeps the disconnect line and the ratings, only the numbers go",
    /disconnect within 10'/i.test(digest) && /200A main/.test(digest) && /70A fuses/.test(digest), digest);

  // wordingNamesProject's own digit test reads the same dashes ("/" aside).
  for (const [label, d] of dashes) {
    check(`wordingNamesProject flags a ${label}-grouped number`, wordingNamesProject(`Meter 123${d}45`, {}));
  }
  check("wordingNamesProject still lets a service voltage through", !wordingNamesProject("Service is 120/240 V", {}));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
