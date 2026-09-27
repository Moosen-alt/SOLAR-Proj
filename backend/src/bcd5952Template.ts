import { createHash } from "node:crypto";

/** The value size on BCD 440-5952's text boxes (its printed labels are 10-11 pt). */
export const BCD_5952_VALUE_PT = 10;
/** The checklist's data text fields, by their AcroForm names (the two "check one" squares that are
 *  misdeclared as text fields are not data fields and are drawn as X overlays instead). */
export const BCD_5952_TEXT_FIELDS = [
  "Property owner name", "Phone number", "Installation address", "State  Oregon", "ZIP", "Structure description",
  "Contractors name", "Phone number_2", "Email address", "BCD license", "CCB license",
  "PART IV  PV MODULES", "Model number", "Listing agency",
] as const;

/** Exact official revision only. A revised PDF must be inspected before these
 * widget names/coordinates are reused. Contains sources, never customer data. */
export function bcd5952Template(bytes: Uint8Array, sourceUrl: string) {
  if (createHash("sha256").update(bytes).digest("hex") !== "2490f9a571c1048e0338688fb0536c69b0dcd7aed34f623bb5b735b059e032cd") return null;
  return {
    formName: "Oregon BCD 5952 Prescriptive Solar Installation Checklist",
    sourceUrl, fillMode: "acroform" as const,
    textFields: {
      "Property owner name": "project.homeownerName", "Phone number": "computed.homeownerPhone",
      "Installation address": "computed.streetAddress", "State  Oregon": "project.city", ZIP: "project.zip",
      "Structure description": "snapshot.structureDescription", "Contractors name": "client.installerCompanyName",
      "Phone number_2": "client.installerPhone", "Email address": "client.installerEmail",
      "BCD license": "snapshot.bcdLicenseNumber", "CCB license": "client.ccbLicenseNumber",
      "PART IV  PV MODULES": "snapshot.moduleMake", "Model number": "snapshot.moduleModel",
      "Listing agency": "snapshot.moduleListingAgency",
    },
    checkboxes: {
      Contractor: { source: "computed.installerRole", equals: "contractor" },
      "Owner If owner skip to Part III": { source: "computed.installerRole", equals: "owner" },
    },
    // "Building department:" is the department that REVIEWS the permit — the structural permit's
    // issuing agency when the per-job lookup cites one (Marion County for a City of Jefferson job),
    // else the AHJ (ahjForms computed.buildingDepartment).
    overlayFields: [{ source: "computed.buildingDepartment", page: 0, x: 270, y: 693.82, size: 10 }],
    // The blank declares auto-size (0 Tf) on its 18-pt-tall boxes, which set every value at 14 pt
    // beside 10-11 pt labels — the "janky" look on Michael Sheridan's checklist. One size for all;
    // a value too wide for its box at 10 pt falls back to fit (ahjForms.fillLoadedForm).
    fieldFontSizes: Object.fromEntries(BCD_5952_TEXT_FIELDS.map((name) => [name, BCD_5952_VALUE_PT])),
    signatureFields: [],
    notes: "Exact BCD 440-5952 (5/24/COM) geometry. Independent structural answers are recovered at fill time from evidenced project facts. Installer role uses an explicit project role, otherwise the assigned contractor identity. Unknowns remain blank. Review before filing.",
  };
}
