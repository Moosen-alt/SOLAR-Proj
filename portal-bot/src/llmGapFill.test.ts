// OPTION MEMBERSHIP PROVES AN ANSWER IS ALLOWED, NOT THAT IT IS TRUE.
//
// isGrounded is the last check before the gap-fill types a value onto a live application. Two
// holes let a guess through, both found by an outside review and reproduced here before the
// fix:
//   - free text trusted the planner's BINDING as proof of its ANSWER: naming systemSizeKw was
//     enough, so "999" was accepted against a project whose system is 8 kW;
//   - a select was accepted purely because the value appeared in the portal's option list, so
//     "Yes" passed for battery installation on a project recording hasBattery: No.
//
// The fix checks the claim instead of trusting it, while still allowing the REFORMATTINGS the
// old fall-through existed for — a date written the portal's way, an account number with its
// dashes stripped, a size the portal wants in watts.
//
//   npx tsx portal-bot/src/llmGapFill.test.ts
import assert from "node:assert/strict";
import { isGrounded } from "./llmGapFill";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

type Field = Parameters<typeof isGrounded>[0];
const text = (label: string): Field => ({ label, fieldType: "text", selector: {} } as unknown as Field);
const select = (label: string, options: string[]): Field =>
  ({ label, fieldType: "select", options, selector: {} } as unknown as Field);
const radio = (label: string): Field => ({ label, fieldType: "radio", selector: {} } as unknown as Field);

const project: Record<string, string> = {
  systemSizeKw: "8",
  hasBattery: "No",
  homeownerName: "Alice Anderson",
  accountNumber: "16-0001",
  mountType: "roof",
  installDate: "2026-09-10",
};

// ---- the two demonstrated holes --------------------------------------------------
check("MUST NOT: a planner binding is not proof of the planner's answer (999 vs 8 kW)", () => {
  assert.equal(isGrounded(text("System Size (kW)"), "999", "systemSizeKw", project), false,
    "999 was accepted against a project whose system is 8 kW — the binding was trusted, not checked");
});

check("MUST NOT: an option that exists is not an option that is true (battery Yes vs No)", () => {
  assert.equal(isGrounded(select("Energy Storage Installed?", ["Yes", "No"]), "Yes", "hasBattery", project), false,
    "Yes passed because the portal offers it — declaring storage the customer does not own");
});

check("MUST NOT: a radio bound to a project field cannot contradict it", () => {
  assert.equal(isGrounded(radio("Battery?"), "Yes", "hasBattery", project), false);
});

check("MUST NOT: free text bound to a name cannot be a different name", () => {
  assert.equal(isGrounded(text("Owner"), "Bob Baker", "homeownerName", project), false);
});

check("MUST NOT: a combobox with no options still cannot invent a value", () => {
  assert.equal(isGrounded(select("Utility", []), "Some Other Utility", "utility", project), false);
});

// ---- the legitimate cases that must keep working ---------------------------------
check("MUST STILL PASS: the project's own value", () => {
  assert.equal(isGrounded(text("System Size (kW)"), "8", "systemSizeKw", project), true);
  assert.equal(isGrounded(select("Energy Storage Installed?", ["Yes", "No"]), "No", "hasBattery", project), true);
});

check("MUST STILL PASS: a unit conversion the portal asks for (8 kW -> 8000 W)", () => {
  assert.equal(isGrounded(text("System Size (W)"), "8000", "systemSizeKw", project), true,
    "a portal wanting watts where the project records kilowatts is a reformatting, not a guess");
});

check("MUST STILL PASS: an account number with its punctuation stripped (Ameren wants 160001)", () => {
  assert.equal(isGrounded(text("Docket Number"), "160001", "accountNumber", project), true);
});

check("MUST STILL PASS: a date written the portal's way", () => {
  assert.equal(isGrounded(text("Install Date"), "09/10/2026", "installDate", project), true);
});

check("MUST STILL PASS: an option that spells the project's value out in full", () => {
  assert.equal(isGrounded(select("Mount Type", ["Roof Mounted", "Ground Mounted"]), "Roof Mounted", "mountType", project), true);
  assert.equal(isGrounded(select("Storage?", ["Yes, I have storage", "No, I do not have storage"]),
    "No, I do not have storage", "hasBattery", project), true);
});

check("MUST STILL PASS: an unbound answer that traces to some project value", () => {
  // No mappedKey — the old scan over project values still applies.
  assert.equal(isGrounded(text("Applicant"), "Alice Anderson", undefined, project), true);
});

check("MUST STILL PASS: a checkbox with no binding is grounded by the control existing", () => {
  assert.equal(isGrounded(radio("I agree"), "Yes", undefined, project), true);
});

console.log(failures === 0
  ? "\nAll gap-fill grounding checks passed."
  : `\n${failures} gap-fill grounding check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
