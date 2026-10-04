// THE ENTRY PAGES' EMAIL CHECK IS THE SHARED PREDICATE (#92).
//
// parser.html, dashboard.js and new-project.html validate the homeowner email box at save with
// frontend/parser-review.js (looksLikeEmail / firstEmail / emailToSave), a browser copy of
// shared/src/emailAddress.ts. This pins the copy to the original on every case below, so the
// two cannot drift, and pins emailToSave's inline refusal (which never echoes the typed value).
// Synthetic values only. Run: npx tsx backend/test/emailAddressMirror.test.ts
import "./_isolate";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { REPO } from "./_isolate";
import { firstEmail, looksLikeEmail } from "../../shared/src/emailAddress";

const sandbox: { window: Record<string, unknown> } = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(REPO, "frontend", "parser-review.js"), "utf8"), sandbox, { filename: "parser-review.js" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PR = sandbox.window.ParserReview as any;

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` ${detail}` : ""}`); }
};

const CASES: unknown[] = [
  "jordan@example.com", "  jordan.sample+nem@mail.example.org ", "Jordan Sample", "owner phone 555-0100",
  "jordan at example dot com", "jordan@", "@example.com", "jordan@example", "mailto:jordan@example.com",
  "<jordan@example.com>", "jordan@example.com.", "Jordan <jordan@example.com>", "jordan:x@example.com", "", undefined, null, 42,
];
for (const v of CASES) {
  run(`looksLikeEmail agrees (${JSON.stringify(v)})`, PR.looksLikeEmail(v) === looksLikeEmail(v));
  run(`firstEmail agrees (${JSON.stringify(v)})`, PR.firstEmail(v) === firstEmail(v));
}

const box = (value: string) => {
  const el = { value, validity: "", reported: false, setCustomValidity(m: string) { el.validity = m; }, reportValidity() { el.reported = true; return !el.validity; } };
  return el;
};
{
  const el = box("Jordan Sample");
  run("emailToSave refuses a name (null)", PR.emailToSave(el) === null);
  run("…flags the box inline with 'not an email address'", el.validity === "not an email address" && el.reported);
  run("…never echoing the typed value", !el.validity.includes("Jordan"));
}
{
  const el = box(" mailto:jordan@example.com ");
  run("emailToSave saves a real address unwrapped and clears the flag", PR.emailToSave(el) === "jordan@example.com" && el.validity === "");
  run("a blank box saves nothing and is not flagged", PR.emailToSave(box("  ")) === "");
}

{
  // new-project.html submits through a <form>: the browser checks validity BEFORE "submit" fires,
  // so the page must clear the flag on edit or a corrected address can never be submitted.
  const page = fs.readFileSync(path.join(REPO, "frontend", "new-project.html"), "utf8");
  run("new-project clears the email flag on every edit", /homeownerEmail\.addEventListener\("input",[^\n]*setCustomValidity\(""\)/.test(page));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
