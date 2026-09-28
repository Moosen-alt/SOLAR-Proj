// ONE CONTACT, ONE IDENTITY — the shared predicates and the replay binder (R10).
//
// Live City of Corvallis (Accela) electrical learn, 2026-09-28: the Applicant's Contact
// Information dialog was filed with the HOMEOWNER's full name, mailing address and e-mail beside
// the COMPANY's business name and office phone. The same portal's building recipe, learned an hour
// earlier and approved by the operator, binds every box of that dialog to the installer's keys.
//
//   MUST PASS
//     1. contactSectionRole: Applicant / Contractor / Licensed Professional / Permit Applicant /
//        Inspection Contact → the filing company (permit track); Owner / Property Owner / Site
//        Contact → the owner; on a utility interconnection "Applicant" is the customer.
//     2. planContactSections reads HEADINGS: Corvallis Step 4 (Licensed Professional look-up,
//        Inspection Contact, "Optional additional inspection contact") → only Inspection Contact 1
//        gets an identity (the company); Step 2's Applicant (whose instruction says "To add
//        additional contacts") is not "optional".
//     3. contactFieldKind reads the Corvallis dialog's labels.
//     4. R10: an Applicant dialog step bound to a homeowner key replays the installer key; an
//        Owner dialog step bound to an installer key replays the owner's; an Owner dialog's
//        business box replays blank; a literal under a contact label binds to the section's key.
//
//   MUST EXCLUDE
//     - "Owner/Applicant", "Contact Information", "Billing Contact", "Engineer of Record" name no
//       identity; a dialog opened from a section whose heading says nothing is left as recorded;
//       main-page steps and non-contact keys are never touched.
//
// KILLS (each run by hand; each turns this file red):
//   (a) recipeReplayBinding R10: `if (false && step.field)` — the rebind branch never runs.
//   (b) contactRoles.planContactSections: drop the isOptionalExtraSection line.
//   (c) contactRoles.contactSectionRole: drop `(track === "permit" && APPLICANT.test(h))`.
//
//   npx tsx backend/test/contactIdentity.test.ts
import {
  contactFieldKind, contactKeyForRole, contactKeyRole, contactRoleOfStep, contactSectionRole,
  isContactOpener, isOptionalExtraSection, planContactSections,
} from "../../shared/src/contactRoles";
import { bindRecipeForReplay, REPLAY_BLANK_FIELD } from "../src/recipeReplayBinding";
import type { RecipeStep } from "../../shared/src/types";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   ${name}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Section headings.
// ─────────────────────────────────────────────────────────────────────────────
const COMPANY = ["Applicant", "Applicant Info", "Applicant Information", "Contractor", "Contractor Information",
  "Licensed Professional", "Permit Applicant", "Inspection Contact", "Electrical Contractor", "Installer Information"];
const OWNER = ["Owner", "Property Owner", "Owner Information", "Site Contact", "Homeowner", "Customer Information"];
const NONE = ["Owner/Applicant", "Applicant or Owner", "Contact Information", "Billing Contact", "Emergency Contact",
  "Engineer of Record", "Designer", "Project Info", "Tenant", "", "Subcontractor agreement terms"];
for (const h of COMPANY) check(`MUST PASS company section: ${JSON.stringify(h)}`, contactSectionRole(h) === "company", String(contactSectionRole(h)));
for (const h of OWNER) check(`MUST PASS owner section: ${JSON.stringify(h)}`, contactSectionRole(h) === "owner", String(contactSectionRole(h)));
for (const h of NONE) check(`MUST EXCLUDE (names no identity): ${JSON.stringify(h)}`, contactSectionRole(h) === null, String(contactSectionRole(h)));
check("utility interconnection: 'Applicant' is the CUSTOMER (as the section-email pass reads it)",
  contactSectionRole("Applicant Information", { track: "nem" }) === "owner" && contactSectionRole("Installer Information", { track: "nem" }) === "company");

// ─────────────────────────────────────────────────────────────────────────────
// 2. Heading order, never position (Corvallis Step 2 and Step 4, their own instruction text).
// ─────────────────────────────────────────────────────────────────────────────
const STEP2 = [{
  heading: "Applicant", canAdd: true,
  text: "The applicant is the responsible party for this permit and will receive permit correspondence by email. You may add one contact below. To add additional contacts, please call or email us after submitting your application.",
}];
const p2 = planContactSections(STEP2);
check("Step 2: the Applicant (whose instruction says 'To add additional contacts') is the company — not 'optional'",
  p2[0].role === "company" && !isOptionalExtraSection(STEP2[0].text), JSON.stringify(p2));
const STEP4 = [
  { heading: "Licensed Professional", canAdd: false, text: "To find a Contractor in our database, click the Look Up button and enter the search criteria." },
  { heading: "Inspection Contact", canAdd: true, text: "Inspection contacts receive all inspection results via email. To add a contact, click Select from Account or Add New." },
  { heading: "Inspection Contact", canAdd: true, text: "Optional additional inspection contact. To add a contact, click Select from Account or Add New." },
];
const p4 = planContactSections(STEP4);
check("Step 4: the Licensed Professional look-up is not an Add New section (left to its CCB look-up)", p4[0].role === null && /look-up/.test(p4[0].why), JSON.stringify(p4[0]));
check("Step 4: Inspection Contact 1 = the filing company", p4[1].role === "company", JSON.stringify(p4[1]));
check("Step 4: the OPTIONAL second Inspection Contact stays empty", p4[2].role === null && /optional/.test(p4[2].why), JSON.stringify(p4[2]));
const repeat = planContactSections([STEP4[1], { heading: "Inspection Contact", canAdd: true, text: "" }]);
check("a repeated heading is left empty even when it does not say 'optional'", repeat[1].role === null && /repeat/.test(repeat[1].why), JSON.stringify(repeat));
const swapped = planContactSections([{ heading: "Site Contact", canAdd: true }, { heading: "Applicant", canAdd: true }]);
check("order comes from the heading: Site Contact first on the page is still the OWNER", swapped[0].role === "owner" && swapped[1].role === "company", JSON.stringify(swapped));

// ─────────────────────────────────────────────────────────────────────────────
// 3. Box kinds (the Corvallis dialog) and keys.
// ─────────────────────────────────────────────────────────────────────────────
const KINDS: Array<[string, string | null]> = [
  ["Full Name:", "fullName"], ["Name of Business:", "business"], ["Mailing Address:", "street"], ["City:", "city"],
  ["State:", "state"], ["Zip:", "zip"], ["E-mail:", "email"], ["Contact Phone:", "phone"], ["First Name:", "firstName"],
  ["Last Name:", "lastName"], ["Organization Name", "business"], ["Address Line 1", "street"],
  ["Type:", null], ["Fax:", null], ["Address Line 2", null], ["Street No.:", null], ["Street Name:", null], ["Title", null],
  // MUST EXCLUDE (skeptic, Oregon ePermitting's real contact dialog — the approved Coos Bay recipe
  // left "Secondary Phone:" blank): only the PRIMARY phone / e-mail is the identity's.
  ["Primary Phone:", "phone"], ["Secondary Phone:", null], ["Alternate Phone", null], ["Phone 2", null], ["Other Phone:", null],
  ["Secondary E-mail:", null], ["Address Line 1:", "street"],
];
for (const [label, kind] of KINDS) check(`box kind ${JSON.stringify(label)} → ${kind}`, contactFieldKind(label) === kind, String(contactFieldKind(label)));
check("key roles both ways, phone segments included",
  contactKeyRole("homeownerName")?.role === "owner" && contactKeyRole("installerContactName")?.kind === "fullName"
    && contactKeyForRole("homeownerPhoneArea", "company") === "installerPhoneArea"
    && contactKeyForRole("installerEmail", "owner") === "homeownerEmail"
    && contactKeyForRole("installerCompanyName", "owner") === null
    && contactKeyForRole("ccbLicenseNumber", "company") === undefined);
check("a step's own role mark: the learner's '[applicant]', an ACA section control id, a recorded heading",
  contactRoleOfStep({ note: "contact: email [applicant]" }) === "company"
    && contactRoleOfStep({ note: "contact(site contact): add new" }) === "owner"
    && contactRoleOfStep({ selector: { css: "#ctl00_PlaceHolderMain_Applicant_9479Edit_btnAddNew" } }) === "company"
    && contactRoleOfStep({ fingerprint: { id: "ctl00_PlaceHolderMain_Contact1_9483Edit_btnAddNew" } }) === null
    && contactRoleOfStep({ fingerprint: { section: "Owner" } }) === "owner");

// The ONE opener predicate (learner, replay, replay binder).
for (const w of ["Add New", "Select from Account", "Edit", "advance: Select from Account", "Add Contact", "contact(applicant): add new"]) {
  check(`MUST PASS contact opener: ${JSON.stringify(w)}`, isContactOpener(w));
}
for (const w of ["Look Up", "Continue Application »", "Continue", "Credit card", "Edited by", "Search", "Add Additional Contact Address"]) {
  check(`MUST EXCLUDE contact opener: ${JSON.stringify(w)}`, !isContactOpener(w));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. R10 — the replay rebinds a mis-bound Applicant dialog.
// ─────────────────────────────────────────────────────────────────────────────
const F = "ACADialogFrame";
const fv: Record<string, string> = {
  installerContactName: "Casey Contact", installerCompanyName: "Fernhollow Solar LLC", installerStreet: "1 Industry Way",
  installerCity: "Springfield", installerState: "OR", installerZip: "97477", installerEmail: "permits@fernhollow.example",
  installerPhone: "555-010-0100", installerPhoneArea: "555", installerPhoneLine: "0100",
  homeownerName: "Robin Resident", homeownerEmail: "robin@example.com", homeownerPhone: "555-010-0199",
  street: "9 Elm St", city: "Springfield", state: "OR", zip: "97478", ccbLicenseNumber: "123456",
};
const bind = (steps: RecipeStep[], track = "electrical") =>
  bindRecipeForReplay({ steps, project: { state: "OR", ahj: "City of Fernhollow" }, fieldValues: fv, track, borrowed: null, agency: null });
const dlg = (label: string, field?: string, value?: string): RecipeStep =>
  ({ action: "fill", selector: { label, frame: F }, ...(field ? { field } : {}), ...(value ? { value } : {}), note: label });

// The electrical learn's shape: Select from Account in the Applicant section, the account picker,
// then the Contact Information dialog with the homeowner's keys (what the mixed fill amounts to).
const applicant: RecipeStep[] = [
  { action: "click", selector: { role: "link", name: "Select from Account", fallbacks: [{ css: "#ctl00_PlaceHolderMain_Applicant_9479Edit_btnSelectFromAccount" }] }, note: "Select from Account" },
  { action: "check", selector: { label: "Associated Contact", frame: F }, note: "Associated Contact" },
  { action: "click", selector: { role: "button", name: "Continue", frame: F }, note: "advance: Continue" },
  dlg("Full Name:", "homeownerName"),
  dlg("Name of Business:", "installerCompanyName"),
  dlg("Mailing Address:", "street"),
  dlg("City:", "city"),
  { action: "select", selector: { label: "State:", frame: F }, field: "state", note: "State:" },
  dlg("Zip:", "zip"),
  dlg("E-mail:", "homeownerEmail"),
  dlg("Contact Phone:", "installerPhone"),
  { action: "click", selector: { role: "button", name: "Continue", frame: F }, note: "advance: Continue" },
  { action: "click", selector: { role: "link", name: "Continue Application »" }, note: "advance: Continue Application »" },
  // A main-page step after the dialog is never a contact box.
  { action: "fill", selector: { label: "Owner Name:" }, field: "homeownerName", note: "Owner Name:" },
];
const b1 = bind(applicant);
const fieldOf = (b: ReturnType<typeof bind>, label: string, nth = 0) => b.steps.filter((s) => s.selector?.label === label)[nth]?.field;
check("R10 MUST PASS: the Applicant dialog's Full Name replays installerContactName (was homeownerName)", fieldOf(b1, "Full Name:") === "installerContactName", String(fieldOf(b1, "Full Name:")));
check("R10 MUST PASS: Mailing Address / City / State / Zip replay the company's", fieldOf(b1, "Mailing Address:") === "installerStreet" && fieldOf(b1, "City:") === "installerCity" && fieldOf(b1, "State:") === "installerState" && fieldOf(b1, "Zip:") === "installerZip",
  JSON.stringify(["Mailing Address:", "City:", "State:", "Zip:"].map((l) => fieldOf(b1, l))));
check("R10 MUST PASS: E-mail replays installerEmail (was homeownerEmail)", fieldOf(b1, "E-mail:") === "installerEmail", String(fieldOf(b1, "E-mail:")));
check("R10: the steps already on the company's keys are unchanged", fieldOf(b1, "Name of Business:") === "installerCompanyName" && fieldOf(b1, "Contact Phone:") === "installerPhone");
check("R10 MUST EXCLUDE: the main-page Owner Name after the dialog keeps homeownerName", fieldOf(b1, "Owner Name:") === "homeownerName");
check("R10: each rebind is named", b1.changes.filter((c) => c.kind === "rebound" && /one contact, one identity/.test(c.reason)).length === 6, JSON.stringify(b1.changes));

// An Owner (site contact) dialog: company keys become the owner's; the business box replays blank.
const owner: RecipeStep[] = [
  { action: "click", selector: { role: "button", name: "Add New" }, note: "contact(site contact): add new" },
  dlg("Full Name:", "installerContactName"),
  dlg("Name of Business:", "installerCompanyName"),
  dlg("E-mail:", "installerEmail"),
  { action: "fill", selector: { css: "input[id*='Phone' i]", nth: 0, frame: F }, field: "installerPhoneArea", note: "contact: phone (area) [site contact]" },
];
const b2 = bind(owner);
check("R10 MUST PASS (Owner dialog): Full Name → homeownerName, E-mail → homeownerEmail, phone segment → homeownerPhoneArea",
  b2.steps[1].field === "homeownerName" && b2.steps[3].field === "homeownerEmail" && b2.steps[4].field === "homeownerPhoneArea",
  JSON.stringify(b2.steps.map((s) => s.field)));
check("R10 MUST PASS (Owner dialog): the business box replays BLANK, never the company's name", b2.steps[2].field === REPLAY_BLANK_FIELD && b2.steps[2].value === "", JSON.stringify(b2.steps[2]));

// A literal typed by hand in the Applicant dialog (human patch after an Edit) binds to the section's key.
const patched = bind([
  { action: "click", selector: { css: "#ctl00_PlaceHolderMain_Applicant_9479Edit_gdvContactList_ctl02_btnEdit" }, note: "human-patch: Edit" },
  dlg("Full Name:", undefined, "Casey Contact"),
  dlg("Mailing Address:", undefined, "1 Industry Way"),
]);
check("R10: a hand-typed literal in the Applicant dialog binds to the company's key (never replays the learn job's text)",
  patched.steps[1].field === "installerContactName" && patched.steps[1].value === undefined && patched.steps[2].field === "installerStreet",
  JSON.stringify(patched.steps.map((s) => [s.field, s.value])));

// MUST EXCLUDE: a dialog opened from a section whose heading says nothing is left as recorded.
const unknown = bind([
  { action: "click", selector: { role: "button", name: "Add New", fallbacks: [{ css: "#ctl00_PlaceHolderMain_Contact1_9483Edit_btnAddNew" }] }, note: "Add New" },
  dlg("Full Name:", "homeownerName"),
  dlg("E-mail:", "installerEmail"),
]);
check("R10 MUST EXCLUDE: an unknown section's dialog is untouched (never guessed)",
  unknown.steps[1].field === "homeownerName" && unknown.steps[2].field === "installerEmail" && unknown.changes.length === 0, JSON.stringify(unknown.changes));
// MUST EXCLUDE: a framed step with no opener before it (a non-contact dialog) is untouched.
const bare = bind([dlg("Full Name:", "homeownerName"), dlg("E-mail:", "homeownerEmail")]);
check("R10 MUST EXCLUDE: framed steps with no contact opener before them are untouched", bare.changes.length === 0);
// On a utility interconnection "Applicant" is the customer: an Applicant dialog keeps the owner's keys.
const nem = bind([
  { action: "click", selector: { role: "button", name: "Add New" }, note: "contact(applicant): add new" },
  dlg("Full Name:", "homeownerName"),
], "nem");
check("R10 on the NEM track: an Applicant dialog is the customer's — homeownerName stays", nem.steps[1].field === "homeownerName" && nem.changes.length === 0, JSON.stringify(nem.changes));

console.log(failures === 0 ? "\ncontactIdentity: all checks passed." : `\ncontactIdentity: ${failures} check(s) FAILED.`);
if (failures) process.exitCode = 1;
