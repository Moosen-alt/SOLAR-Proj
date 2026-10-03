// A HOMEOWNER EMAIL WITH NO "@" IS NOT AN EMAIL ON FILE (#71).
//
// The parser page's "Homeowner email" box saves its raw value; nothing enforced type="email". A
// project was stored with the homeowner's NAME in the email slot, and every reader asked only "is
// the string non-empty": the reviewer's `reviewer.submit.homeowner-email` callout stayed silent,
// the intake link did not ask for it, and the recipe field values carried the name as the NEM
// applicant's email (ubAccountHolderEmail / homeownerEmail) — the next learn or replay would have
// typed it into the utility's Email box.
//
// One predicate (shared/src/emailAddress looksLikeEmail) now answers "is there an owner email on
// file" at every door. A non-email reads exactly like no email: the callout fires (still a
// callout, never a blocker), the intake link asks, and the recipe values are blank, not the name.
// A real address is unaffected.
//
// Synthetic values only. Run: npx tsx backend/test/homeownerEmailOnFile.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "homeowner-email-on-file-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { createProject, getProjectDetail } = await import("../src/repository");
const { buildReviewerReport } = await import("../src/reviewerEngine");
const { resolveRecipeFieldValues } = await import("../src/portalRecipes");
const intake = await import("../src/intakeRequests");
const { looksLikeEmail, firstEmail } = await import("../../shared/src/emailAddress");

const db = await openDatabase();
intake.setPortalQuestionSource(() => []);

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` ${detail}` : ""}`); }
};
const throws = (fn: () => unknown): { status?: number; message: string } | null => {
  try { fn(); return null; } catch (err) {
    return { status: (err as { status?: number }).status, message: (err as Error).message || String(err) };
  }
};

const BASE = {
  owner: "Jordan Sample", street: "1 Example Way", city: "Los Lunas", state: "NM", zip: "87031",
  ahj: "Village of Los Lunas", utility: "PNM", dcKw: "6.4", homeownerPhone: "505-555-0100", jobValue: "24500",
};
const NOT_AN_EMAIL = ["Jordan Sample", "owner phone 555-0100", "jordan at example dot com", "jordan@", "@example.com", "jordan@example"];
const make = (over: Record<string, string>) => createProject(db, { ...BASE, ...over } as never).project.id;
const project = (id: string) => getProjectDetail(db, id).project;
const emailFinding = (id: string) => buildReviewerReport(project(id)).findings.find((f) => f.id === "reviewer.submit.homeowner-email");
const values = (id: string) => resolveRecipeFieldValues(db, project(id), "powerclerk", "nem") as Record<string, string>;

console.log("\n[0] the predicate");
run("a real address looks like an email", looksLikeEmail("jordan@example.com") && looksLikeEmail("  jordan.sample+nem@mail.example.org "));
for (const v of NOT_AN_EMAIL) run(`a non-email does not (${JSON.stringify(v)})`, !looksLikeEmail(v));
run("non-strings do not", !looksLikeEmail(undefined) && !looksLikeEmail(null) && !looksLikeEmail(42));
run("firstEmail skips non-emails and trims", firstEmail("Jordan Sample", " jordan@example.com ") === "jordan@example.com" && firstEmail("Jordan Sample", "") === "");

console.log("\n[1] a name in the email slot reads as no email at every door");
for (const bad of NOT_AN_EMAIL) {
  const id = make({ homeownerEmail: bad });
  const f = emailFinding(id);
  run(`reviewer: the homeowner-email callout fires (${JSON.stringify(bad)})`, Boolean(f));
  run("…as a callout, never a blocker", f?.severity === "callout", JSON.stringify(f?.severity));
  run("…and never echoes the stored value", Boolean(f) && !JSON.stringify(f).includes(bad));
  run("intake: missingIntakeFields asks for the email", intake.missingIntakeFields(db, id).includes("homeownerEmail"));
  const v = values(id);
  run("recipe values: homeownerEmail is blank, not the stored value", v.homeownerEmail === "", JSON.stringify(v.homeownerEmail === bad ? "<the stored value>" : v.homeownerEmail));
  run("recipe values: ubAccountHolderEmail is blank, not the stored value", v.ubAccountHolderEmail === "");
}

console.log("\n[2] the intake link asks, prefills nothing, and refuses a non-email answer");
{
  const id = make({ homeownerEmail: "Jordan Sample" });
  const req = await intake.createIntakeRequest(db, id);
  run("the request carries homeownerEmail", req.fields.includes("homeownerEmail"));
  const pubReq = intake.getIntakeRequestPublic(db, req.token);
  const pub = pubReq.fields.find((f) => f.key === "homeownerEmail");
  run("…required, with no prefilled value", pub?.required === true && pub?.value === "", JSON.stringify(pub?.required));
  const others = Object.fromEntries(req.fields.filter((k) => k !== "homeownerEmail").map((k) => [k, k === "jobValue" ? "24500" : "505-555-0100"]));
  // Whatever per-job questions the AHJ's process asks are not this test's subject: answer each.
  for (const q of pubReq.questions) others[q.key] = q.options[0];
  const skipped = throws(() => intake.submitIntakeRequest(db, req.token, { ...others }));
  run("a post without the email is a 400 (the stored non-email does not satisfy it)", skipped?.status === 400, JSON.stringify(skipped));
  const bad = throws(() => intake.submitIntakeRequest(db, req.token, { ...others, homeownerEmail: "owner phone 555-0100" }));
  run("a non-email answer is a 400", bad?.status === 400, JSON.stringify(bad?.status));
  run("…which never echoes the answer", Boolean(bad) && !bad!.message.includes("555-0100"));
  run("…and writes nothing", project(id).parserSnapshot?.homeownerEmail === "Jordan Sample");
  const ok = throws(() => intake.submitIntakeRequest(db, req.token, { ...others, homeownerEmail: "jordan@example.com" }));
  run("a real address is accepted", ok === null, JSON.stringify(ok));
  run("…and lands on the project", project(id).parserSnapshot?.homeownerEmail === "jordan@example.com");
  run("…after which the callout is silent", !emailFinding(id));
}

console.log("\n[3] a real address is unaffected");
{
  const id = make({ homeownerEmail: "jordan@example.com" });
  run("reviewer: no homeowner-email callout", !emailFinding(id));
  run("intake: not asked", !intake.missingIntakeFields(db, id).includes("homeownerEmail"));
  const v = values(id);
  run("recipe values carry it", v.homeownerEmail === "jordan@example.com" && v.ubAccountHolderEmail === "jordan@example.com");
  const empty = make({});
  const f = emailFinding(empty);
  run("an empty email still fires the missing callout", f?.title === "Homeowner email missing");
}

console.log("\n[4] the bill's own account-holder email wins only when it is an email");
{
  const id = make({ homeownerEmail: "jordan@example.com", ubAccountHolderEmail: "Jordan Sample" });
  run("a non-email bill value falls through to the homeowner's address", values(id).ubAccountHolderEmail === "jordan@example.com");
  const id2 = make({ homeownerEmail: "jordan@example.com", ubAccountHolderEmail: "holder@example.com" });
  run("a real bill address is kept", values(id2).ubAccountHolderEmail === "holder@example.com");
}

fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
