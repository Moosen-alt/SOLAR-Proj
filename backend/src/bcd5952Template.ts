import { createHash } from "node:crypto";

/** Exact official revision only. A revised PDF must be inspected before these
 * widget names/coordinates are reused. Contains sources, never customer data. */
export function bcd5952Template(bytes: Uint8Array, sourceUrl: string) {
  if (createHash("sha256").update(bytes).digest("hex") !== "2490f9a571c1048e0338688fb0536c69b0dcd7aed34f623bb5b735b059e032cd") return null;
  return {
    formName: "Oregon BCD 5952 Prescriptive Solar Installation Checklist",
    sourceUrl, fillMode: "acroform" as const,
    textFields: {
      "Property owner name": "project.homeownerName", "Phone number": "snapshot.homeownerPhone",
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
    overlayFields: [{ source: "project.ahj", page: 0, x: 270, y: 693.82, size: 10 }],
    signatureFields: [],
    notes: "Exact BCD 440-5952 (5/24/COM) geometry. Independent structural answers are recovered at fill time from evidenced project facts. Installer role uses an explicit project role, otherwise the assigned contractor identity. Unknowns remain blank. Review before filing.",
  };
}
