// THE REAL-RUN GUARD AND THE MASK'S VALUE LIST, WITHOUT A BROWSER.
//
// scripts/demo-record-portal.ts --real-run records a real, unfiled project on a real portal
// with the values masked on screen. The pixel proof lives in the DOM smoke
// (scripts/demoMaskReplica.dom.smoke.ts, real Chromium + OCR); this pins the two pure pieces
// in the fast unit chain so a regression is caught before anyone opens a browser:
//
//   1. realRunRefusals — MUST REFUSE: no --i-am-present; PORTAL_ALLOW_FINAL_SUBMIT set to
//      anything (even "0"); a run approval; headless; masking off; an invalid recipe shape; and
//      WITHOUT --real-run, any non-loopback host. MUST PASS: the supervised shape, and a
//      loopback host without --real-run (the fictional recording).
//   2. piiMaskValues / piiHitsInText — MUST INCLUDE: the full name, the last name alone, the
//      street line, "<number> <street>", the email's local part, the login name. MUST EXCLUDE:
//      the state code, a bare street number, stop words (Ave, Energy, LLC), an equipment model.
//      And the hit counter, which the smoke's verdict rests on, reads a spaced account number
//      and an upper-cased last name, and does not read a name inside a longer word.
//   3. ONE MATCHER, UNICODE-AWARE (piiTextMatcher: NFKD, marks stripped, \p{L}\p{N}, the
//      page and Node built from the same source). MUST INCLUDE: a Cyrillic name and its
//      tokens, a CJK name, 'Zoë', 'José', 'Nguyễn'; 'Jose' in text matches 'José'; '山田太郎'
//      inside '山田太郎様'. MUST EXCLUDE: 'Иван' inside 'Иванов', 'Desmond' inside 'Desmondia'
//      (a cased-letter boundary). And ocrBlindValues names the values a Latin OCR engine
//      cannot read, so "0 hits" on them is never reported as proof.
//   4. piiRawSourceStrings — the raw fields the recorder's review-stop audit looks for beside
//      the matcher's list, each WHOLE, never through the matcher (so a value the list builder
//      drops is still audited). MUST EXCLUDE: tokens, an equipment model, a 3-digit number.
//
//   npx tsx backend/test/demoRealRunGuard.test.ts
import { realRunRefusals, recipeTargetHosts } from "../../scripts/lib/realRunGuard";
import { PII_MATCHER, piiMaskValues, piiMaskShapesFor, piiRawSourceStrings } from "../../scripts/lib/piiMask";
import { ocrBlindValues, piiHitsInText } from "../../scripts/lib/ocrFrames";

let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  checks++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

console.log("\n1. realRunRefusals");
{
  const base = { realRun: true, iAmPresent: true, env: {} as Record<string, string | undefined>, runApproval: null, headed: true, maskOn: true, targetHosts: ["powerclerk.example"] };
  check("MUST-PASS: supervised shape passes", realRunRefusals(base).length === 0, realRunRefusals(base).join("; "));
  check("MUST-REFUSE: no --i-am-present", realRunRefusals({ ...base, iAmPresent: false }).some((r) => /--i-am-present/.test(r)));
  for (const v of ["1", "0", "", "true"]) {
    check(`MUST-REFUSE: PORTAL_ALLOW_FINAL_SUBMIT=${JSON.stringify(v)}`, realRunRefusals({ ...base, env: { PORTAL_ALLOW_FINAL_SUBMIT: v } }).some((r) => /PORTAL_ALLOW_FINAL_SUBMIT/.test(r)));
  }
  check("MUST-REFUSE: a run approval", realRunRefusals({ ...base, runApproval: { approver: "x", runId: "y" } }).some((r) => /approval/.test(r)));
  check("MUST-REFUSE: headless", realRunRefusals({ ...base, headed: false }).some((r) => /--headed/.test(r)));
  check("MUST-REFUSE: masking off", realRunRefusals({ ...base, maskOn: false }).some((r) => /masking/.test(r)));
  check("MUST-REFUSE: two flagged final submits", realRunRefusals({ ...base, recipeSteps: [{ action: "click", isFinalSubmit: true }, { action: "stopForReview" }, { action: "click", isFinalSubmit: true }] }).some((r) => /shape/.test(r)));
  check("MUST-PASS: the recorder's shape (stopForReview then one flagged click) is valid", realRunRefusals({ ...base, recipeSteps: [{ action: "goto" }, { action: "fill" }, { action: "stopForReview" }, { action: "click", isFinalSubmit: true, selector: {} }] }).length === 0);
  check("MUST-PASS: no flagged step at all is valid", realRunRefusals({ ...base, recipeSteps: [{ action: "goto" }, { action: "stopForReview" }] }).length === 0);
  const every = realRunRefusals({ realRun: true, iAmPresent: false, env: { PORTAL_ALLOW_FINAL_SUBMIT: "1" }, runApproval: {}, headed: false, maskOn: false });
  check("every refusal is reported at once, not just the first", every.length === 5, `${every.length}: ${every.join(" | ")}`);
  check("MUST-REFUSE: without --real-run, a non-loopback host", realRunRefusals({ ...base, realRun: false, targetHosts: ["127.0.0.1", "pge.example"] }).some((r) => /pge\.example/.test(r)));
  check("MUST-PASS: without --real-run, loopback hosts only (the fictional recording)", realRunRefusals({ ...base, realRun: false, targetHosts: ["127.0.0.1", "localhost"] }).length === 0);
  check("MUST-PASS: without --real-run and no host known yet, nothing is refused", realRunRefusals({ realRun: false, iAmPresent: false, env: {}, runApproval: null, headed: false, maskOn: false }).length === 0);
  const hosts = recipeTargetHosts({ portalUrl: "https://Portal.Example/Account/Login", steps: [{ action: "goto", value: "https://portal.example/MvcProjects/New" }, { action: "goto", value: "http://127.0.0.1:9/x" }, { action: "fill", value: "not a url" }] });
  check("recipeTargetHosts: portal URL + goto hosts, lower-cased, de-duplicated; fills ignored", hosts.join(",") === "portal.example,127.0.0.1", hosts.join(","));
}

console.log("\n2. piiMaskValues and piiHitsInText");
{
  const values = piiMaskValues({
    project: {
      homeownerName: "Desmond Yarrowby", projectAddress: "918 Quimby Ave, Fernhollow, OR 97498", city: "Fernhollow", state: "OR", zip: "97498",
      accountNumber: "8802468013", meterNumber: "M66607788",
      parserSnapshot: { homeownerEmail: "d.yarrowby@example.com", homeownerPhone: "541-555-0163", moduleModel: "REC400AA Pure-R", installerCompanyName: "Kestrel Energy LLC", ubAccountHolderName: "Ada Yarrowby", saId: "1234567890" },
    },
    credential: { username: "kestrel.office" },
    installer: { company: "Kestrel Energy LLC", contactName: "Philippa Ashgrove", email: "office@kestrel.example.com", phone: "541-555-0199", license: "CCB 318822" },
    extra: ["Ines Coldharbour"],
  });
  const has = (v: string) => values.includes(v);
  check("MUST-INCLUDE: full name, last name, first name", has("Desmond Yarrowby") && has("Yarrowby") && has("Desmond"));
  check("MUST-INCLUDE: the street line, '<number> <street>' and the street name", has("918 Quimby Ave") && has("918 Quimby") && has("Quimby"));
  check("MUST-INCLUDE: city, zip, account, meter, phone, SA id", ["Fernhollow", "97498", "8802468013", "M66607788", "541-555-0163", "1234567890"].every(has));
  check("MUST-INCLUDE: the email and its local part; the login name; the company and its distinctive token", has("d.yarrowby@example.com") && has("d.yarrowby") && has("kestrel.office") && has("Kestrel Energy LLC") && has("Kestrel"));
  check("MUST-INCLUDE: the account holder's name from the snapshot, the electrician from extra", has("Ada Yarrowby") && has("Ada") && has("Ines Coldharbour") && has("Coldharbour"));
  check("MUST-EXCLUDE: the state code, the bare street number, stop words", !has("OR") && !has("918") && !values.some((v) => /^(ave|energy|llc|example|com)$/i.test(v)));
  check("MUST-EXCLUDE: an equipment model in the snapshot", !has("REC400AA Pure-R"));
  check("no value is shorter than 3 characters", values.every((v) => v.replace(/[^a-z0-9]/gi, "").length >= 3), values.filter((v) => v.replace(/[^a-z0-9]/gi, "").length < 3).join("|"));

  const text = "Account 8802 4680 13 · phone (541) 555-0163 · YARROWBY, Desmond · Desmondia Ltd · 918 Quimby Ave";
  const hits = piiHitsInText(text, values);
  check("hits: spaced account, bracketed phone, upper-cased last name, first name, street", ["8802468013", "541-555-0163", "Yarrowby", "Desmond", "918 Quimby Ave"].every((v) => hits.includes(v)), hits.join("|"));
  check("MUST-EXCLUDE: a name inside a longer word is not a hit", !piiHitsInText("Desmondia Ltd", values).includes("Desmond"));
  check("MUST-EXCLUDE: text with no values has no hits", piiHitsInText("Customer Information First Name Last Name Email Phone", values).length === 0, piiHitsInText("Customer Information First Name Last Name Email Phone", values).join("|"));
  check("shapes: PowerClerk gets its own list, unknown platforms the generic one, and both cover a dashboard table",
    piiMaskShapesFor("powerclerk") !== piiMaskShapesFor("unknown") && [piiMaskShapesFor("powerclerk"), piiMaskShapesFor("")].every((s) => s.some((r) => new RegExp(r.url, "i").test("https://x/Dashboard") && r.selectors.includes("table"))));
}

console.log("\n3. Unicode: ONE matcher for the value list, the page and the OCR counter");
{
  const values = piiMaskValues({
    project: { homeownerName: "Zoë Müller-Ålesund", accountNumber: "8802 4680 13", parserSnapshot: { electricalSupervisorName: "Иван Петров", installerContactName: "山田太郎", ubAccountHolderName: "José Ñañez", homeownerPhone: "(541) 555-0163" } },
    installer: { company: "Ñu Solar Ltd" },
    extra: ["Nguyễn Văn An", "Desmond Yarrowby"],
  });
  const has = (v: string) => values.includes(v);
  check("MUST-INCLUDE: a Cyrillic name and its tokens", has("Иван Петров") && has("Иван") && has("Петров"));
  check("MUST-INCLUDE: a CJK name; a 3-letter accented first name ('Zoë'); accented tokens (José, Ñañez, Nguyễn, Văn)", has("山田太郎") && has("Zoë") && has("José") && has("Ñañez") && has("Nguyễn") && has("Văn"));
  check("MUST-INCLUDE: the whole accented company ('Ñu Solar Ltd') stays a value", has("Ñu Solar Ltd"));
  check("MUST-EXCLUDE: a 2-letter accented token is not a value; 'Ltd' and 'Solar' are stop words", !has("Ñu") && !has("Ltd") && !has("Solar"));
  const m = PII_MATCHER;
  check("normalize: NFKD + marks stripped + \\p{L}\\p{N}, each kept char mapped to its ORIGINAL index",
    m.normalize("Zoë-Ñu 12").norm === "zoenu12" && m.normalize("Zoë-Ñu 12").map.join() === "0,1,2,4,5,7,8" && m.normalize("山田太郎").norm === "山田太郎", JSON.stringify(m.normalize("Zoë-Ñu 12")));
  check("ranges: a Cyrillic value is found in Cyrillic text; 'Jose' in the page matches the value 'José'; a spaced account matches",
    m.ranges("Holder: Иван Петров.", [m.prepare("Иван Петров")]).join() === "8,19" && m.ranges("Jose Nanez", [m.prepare("José Ñañez")]).length === 1 && m.ranges("Acct 8802 4680 13", [m.prepare("8802468013")]).length === 1);
  check("ranges MUST-EXCLUDE: 'Иван' inside 'Иванов' and 'Desmond' inside 'Desmondia' are not matches (cased-letter boundary)",
    m.ranges("Иванов", [m.prepare("Иван")]).length === 0 && m.ranges("Desmondia Ltd", [m.prepare("Desmond")]).length === 0);
  check("ranges: an uncased script has no word spaces — '山田太郎' inside '山田太郎様' IS a match", m.ranges("山田太郎様", [m.prepare("山田太郎")]).length === 1);
  const hits = piiHitsInText("Contact: Иван Петров · Jose · ZOE MULLER-ALESUND · Иванов · Desmondia", values);
  check("piiHitsInText: reads the Cyrillic name, the accent-stripped 'Jose' and 'ZOE MULLER-ALESUND' as hits", ["Иван Петров", "Иван", "Петров", "José", "Zoë Müller-Ålesund", "Zoë"].every((v) => hits.includes(v)), hits.join("|"));
  check("piiHitsInText MUST-EXCLUDE: 'Иванов' is not 'Иван'; 'Desmondia' is not 'Desmond'", !piiHitsInText("Иванов", values).includes("Иван") && !piiHitsInText("Desmondia", values).includes("Desmond"));
  const blind = ocrBlindValues(values);
  check("ocrBlindValues: the Cyrillic and CJK values are OCR-blind (a Latin engine cannot read them); accented Latin values are not",
    ["Иван Петров", "Иван", "Петров", "山田太郎"].every((v) => blind.includes(v)) && !blind.includes("José") && !blind.includes("Zoë Müller-Ålesund") && !blind.includes("8802 4680 13"), blind.join("|"));
}

console.log("\n4. piiRawSourceStrings: what the review-stop audit looks for BESIDES the matcher's list");
{
  const src = {
    project: {
      homeownerName: "Zoë Müller-Ålesund", projectAddress: "918 Quimby Ave, Fernhollow, OR 97498", city: "Fernhollow", state: "OR", zip: "97498", accountNumber: "8802 4680 13",
      parserSnapshot: { electricalSupervisorName: "Иван Петров", installerContactName: "山田太郎", moduleModelName: "REC400AA Pure-R", serviceAccountSuffix: "918", ownerSignature: "✍✍✍", utilityName: "Pacific Gas" },
    },
    credential: { username: "kestrel.office" },
    installer: { company: "Ñu Solar Ltd", contactName: "Ines Coldharbour", phone: "(541) 555-0163" },
    extra: ["Solar"],
  };
  const raw = piiRawSourceStrings(src);
  const has = (v: string) => raw.includes(v);
  check("MUST-INCLUDE: each source field WHOLE — the Cyrillic and CJK names, the accented owner, the address, city, zip, account, login, company, contact, phone",
    ["Иван Петров", "山田太郎", "Zoë Müller-Ålesund", "918 Quimby Ave, Fernhollow, OR 97498", "Fernhollow", "97498", "8802 4680 13", "kestrel.office", "Ñu Solar Ltd", "Ines Coldharbour", "(541) 555-0163"].every(has), raw.join("|"));
  check("MUST-EXCLUDE: no tokens (the audit's raw substring finds the whole value), an equipment model, a non-PII snapshot key, a 3-digit number, a 2-letter state, a lone stop word",
    !has("Иван") && !has("Zoë") && !has("REC400AA Pure-R") && !has("Pacific Gas") && !has("918") && !has("OR") && !has("Solar"), raw.join("|"));
  // Independence from the matcher: a value the matcher reduces to nothing is dropped from the
  // mask's list, and is exactly what the audit must still look for.
  check("INDEPENDENT of the matcher: a value it reduces to nothing ('✍✍✍') is not a mask value but IS a raw source string",
    !piiMaskValues(src).includes("✍✍✍") && has("✍✍✍"));
}

console.log(`\n${checks - failures}/${checks} demoRealRunGuard check(s) passed.`);
if (failures) { console.error(`demoRealRunGuard: ${failures} FAILED`); process.exit(1); }
