// BCD 440-5952 (5/24/COM) uses malformed AcroForm radio groups: one group
// contains the Yes widgets for FIVE different questions. Selecting an option
// would clear other rows. Recover only independently supported answers as
// overlays after flattening, using widget rectangles (or row-specific labels
// for flat copies). This is a runtime repair for UNVERIFIED stored maps only.
import type { PDFDocument } from "pdf-lib";
import type { OverlayField } from "./ahjForms";
import type { PrescriptiveCriterionKey, PrescriptiveLimitInputs } from "./permitPath";
import { checkboxPlacement, type LabelItem } from "./formTextLayer";

const canonical = (s: string): string => s.toLowerCase().replace(/[^a-z0-9. ]/g, " ").replace(/\s+/g, " ").trim();

// Full statements, not keyword matches. Additional qualifications or changed
// thresholds must not accidentally inherit the generic evaluator's answer.
const SUPPORTED = new Map<string, PrescriptiveCriterionKey>([
  ["Ground snow load at the site does not exceed 70 pounds per square foot (psf):", "snowLoad"],
  ["Wind exposure for structure is limited to Wind Exposure Category B or C:", "windExposure"],
  ["Structure is of conventional light-frame construction", "lightFrame"],
  ["Total weight of the PV panel system, including modules and racking, will not exceed 4.5 psf:", "deadLoad"],
].map(([text, key]) => [canonical(text), key as PrescriptiveCriterionKey]));

const COMPOUND = new Map([
  ["PV panel system and attachments will be designed to withstand applicable gravity and wind loads at the site and installed in accordance with the manufacturer’s installation instructions:", "designInstallation"],
  ["Supporting roof framing is one of the following: ( check one ) Pre-engineered trusses are spaced less than or equal to 24 inches on center (o.c.); or Rafters are spaced less than or equal to 24 inches o.c. and framing complies with R324.4.1 Exception 1.4 through 1.6", "framing"],
  ["Roofing materials are metal or single-layer-wood shingles or shakes, or not more than two layers of composition shingle:", "roofing"],
  ["Module height will be no more than 18 inches from the top of the module to the roof surface and comply with Figures R324.4.1(2) and R324.4.1(3) accordingly: (continued) Page 1 of 2", "heightFigures"],
  ["PV modules or racking will be attached to the roof using one of the following methods: ( check one ) Attachment Method 1 1. Direct attachment to the roof framing or blocking; and 2. Attachment spacing a. Less than or equal to 24 inches in any direction; or b. Greater than 24 inches and less than or equal to 48 inches in any direction where all of the following exist: 1. Ground snow load is less than or equal to 36 psf. 2. Attachments are not located within 3 feet of a roof edge, hip, eave, or ridge. 3. Basic design wind speed a. Less than or equal to 120 mph in Wind Exposure Category B; or b. Less than or equal to 110 mph in Wind Exposure Category C. Attachment Method 2 1. Direct attachment to standing seam metal roofing panels; and 2. Attachment clamps comply with all of the following requirements: a. Allowable uplift capacity of the clamps is not less than: 115 pounds, where clamp spacing is greater than or equal to 48 inches o.c.; or 75 pounds, where clamp spacing is less than 48 inches o.c. b. Clamp spacing along a panel seam will be greater than or equal to 24 and less than or equal to 60 inches o.c. c. Parallel to seam clamp spacing multiplied by the perpendicular clamp spacing will be less than or equal to 10 square feet. 3. Metal roofing panels comply with all the following: 1. Panel thickness is minimum 26-gauge steel. 2. Panel width is less than or equal to 18 inches. 3. Attached with minimum #10 screws at 24 inches o.c. 1 4. Installed over minimum / 2 -inch nominal wood structural panel sheathing that is fastened to framing with 8d nails at 6 inches o.c. at panel edges and 12 inches o.c. field nailing.", "attachments"],
].map(([text, key]) => [canonical(text), key]));

/** These are the recognized printed form's limits, not a different AHJ profile
 *  or the caller's previously cached prescriptive evaluation. */
export const BCD_5952_LIMITS: PrescriptiveLimitInputs = {
  maxGroundSnowPsf: 70, allowedWindExposures: ["B", "C"], maxPvDeadLoadPsf: 4.5,
};

export interface ChecklistRecovery {
  recognized: boolean;
  overlays: OverlayField[];
  omittedTextFields: string[];
  textFieldOverrides: Record<string, string>;
}

/** Recover independent rows; compound answers use all their parsed facts. */
export function recoverBcd5952Checklist(
  doc: PDFDocument,
  items: LabelItem[],
  existingOverlays: OverlayField[] = [],
  textFields: Record<string, string> = {},
  checkboxSources: string[] = [],
): ChecklistRecovery {
  const empty = (): ChecklistRecovery => ({ recognized: false, overlays: [], omittedTextFields: [], textFieldOverrides: {} });
  const text = items.map((i) => i.str).join(" ");
  if (!/440-5952\s*\(5\/24\/COM\)/i.test(text)
    || !text.includes("Prescriptive Rooftop-Mounted Solar Photovoltaic")
    || !text.includes("Installation Checklist")) return empty();

  const yesItems = items.filter((i) => /^Yes$/i.test(i.str.trim()));
  const noItems = items.filter((i) => /^No$/i.test(i.str.trim()));
  if (yesItems.length !== 9 || noItems.length !== 9) return empty();
  const pairs: Array<{ yes: LabelItem; no: LabelItem }> = [];
  for (const yes of yesItems) {
    const no = noItems.filter((i) => i.page === yes.page && Math.abs(i.y - yes.y) < 1
      && i.x > yes.x + yes.width && i.x < yes.x + 80);
    if (no.length !== 1 || pairs.some((p) => p.no === no[0])) return empty();
    pairs.push({ yes, no: no[0] });
  }

  const pages = doc.getPages();
  const formFields = doc.getForm().getFields();
  // PDF page references, not field names/export values, locate the widgets.
  const widgets = formFields.flatMap((f) => f.acroField.getWidgets().map((w) => ({
    rect: w.getRectangle(), page: pages.findIndex((p) => p.ref === w.P()),
  })));
  const sources = [...Object.values(textFields), ...checkboxSources,
    ...existingOverlays.flatMap((f) => [f.source, f.onlyIf?.source ?? ""])];
  const overlays: OverlayField[] = [];
  const recognizedRows = new Set<string>();

  for (const { yes, no } of pairs) {
    // The pair belongs to the immediately preceding bullet. Include all of
    // that bullet's lines, so a compound suffix cannot disappear in matching.
    const bullets = items.filter((i) => i.page === yes.page && i.str.trim() === "•" && i.x < 75);
    const preceding = bullets.filter((i) => i.y >= yes.y - 1).sort((a, b) => a.y - b.y);
    const bullet = preceding[0];
    if (!bullet || bullet.y - yes.y > 18) continue;
    const below = bullets.filter((i) => i.y < bullet.y - 1).sort((a, b) => b.y - a.y)[0];
    const rowText = items.filter((i) => i.page === yes.page && i.y <= bullet.y + 1
      && i.y > (below?.y ?? 0) + 1 && i.x > bullet.x + 6 && !/^(Yes|No)$/i.test(i.str.trim()))
      .sort((a, b) => Math.abs(a.y - b.y) < 1 ? a.x - b.x : b.y - a.y)
      .map((i) => i.str).join(" ");
    const simpleKey = SUPPORTED.get(canonical(rowText));
    const key = simpleKey ?? COMPOUND.get(canonical(rowText.split("PART IV")[0]));
    if (!key) continue;
    recognizedRows.add(key);
    const cap = key.charAt(0).toUpperCase() + key.slice(1);
    const prefix = simpleKey ? "presc" : "bcd";
    // Explicit maps win. Recovery adds missing rows; it does not rewrite maps.
    if (sources.some((s) => s.startsWith(`computed.${prefix}${cap}`))) continue;
    if (existingOverlays.some((f) => f.page === yes.page && Math.abs(f.y - yes.y) < 12
      && f.x > yes.x - 30 && f.x < no.x + no.width)) continue;

    const positions = [yes, no].map((caption) => {
      const near = widgets.filter(({ rect: r, page }) => page === caption.page
        && r.width >= 7 && r.width <= 15 && r.height >= 7 && r.height <= 15
        && caption.x - r.x - r.width >= 0 && caption.x - r.x - r.width < 10
        && Math.abs(r.y + r.height / 2 - caption.y) < 6);
      if (near.length === 1) {
        const r = near[0].rect;
        return { x: r.x + (r.width - 6) / 2, y: r.y + (r.height - 9) / 2 + 1 };
      }
      if (near.length > 1) return null;
      // Known BCD print geometry: 11-point square, caption 6.3 points to
      // its right. Unlike a page-wide Yes anchor this is specific to this row.
      return checkboxPlacement(items, { page: caption.page, anchor: caption.str,
        rowY: caption.y, rowTolerance: 1, boxGap: 15 });
    });
    if (positions.some((p) => p == null)) continue;
    positions.forEach((p, i) => overlays.push({ source: `computed.${prefix}${cap}${i ? "No" : "Yes"}`,
      page: yes.page, x: p!.x, y: p!.y, size: 9 }));
  }

  // The form's two little "check one" squares are misdeclared as text fields.
  // A stale mapper put the WORD Yes into the rafter square based only on
  // spacing; the printed statement also requires code-exception compliance.
  const omittedTextFields = Object.entries(textFields).filter(([name, source]) =>
    /^computed\.presc/.test(source)
    && /^(Preengineered trusses are spaced|Rafters are spaced)/i.test(name)
    && formFields.some((f) => f.getName() === name && f.acroField.getWidgets().some((w) => {
      const r = w.getRectangle(); return r.width <= 14 && r.height <= 14;
    }))).map(([name]) => name);
  // This PDF misnames the City widget "State  Oregon". Repair only the known
  // auto-mapping error; verified templates never opt into this recovery.
  const textFieldOverrides: Record<string, string> = {};
  if (textFields["State  Oregon"] === "project.state") textFieldOverrides["State  Oregon"] = "project.city";
  if (textFields["Installation address"] === "project.projectAddress") textFieldOverrides["Installation address"] = "computed.streetAddress";
  // A mapper's guessed listing agency is not project evidence.
  textFieldOverrides["Listing agency"] = "snapshot.moduleListingAgency";
  // These four square widgets are text fields in the official PDF. Draw a
  // single X at the widget rather than placing a word inside the small square.
  const subchoices: Record<string, string> = {
    "Preengineered trusses are spaced less than or equal to 24 inches on center oc or": "truss",
    "Rafters are spaced less than or equal to 24 inches oc and framing complies with R32441 Exception 14": "rafter",
    "check one": "method1", "undefined_4": "method2",
  };
  for (const [name, key] of Object.entries(subchoices)) {
    if (!recognizedRows.has(key.startsWith("method") ? "attachments" : "framing")) continue;
    const field = formFields.find(f => f.getName() === name);
    if (!field) continue;
    if (!omittedTextFields.includes(name)) omittedTextFields.push(name);
    for (const w of field.acroField.getWidgets()) {
      const r = w.getRectangle();
      const page = pages.findIndex(p => p.ref === w.P());
      if (page < 0 || r.width > 14 || r.height > 14) continue;
      overlays.push({ source: `computed.bcd${key[0].toUpperCase() + key.slice(1)}Yes`, page,
        x: r.x + (r.width - 6) / 2, y: r.y + (r.height - 9) / 2 + 1, size: 9 });
    }
  }
  return { recognized: true, overlays, omittedTextFields, textFieldOverrides };
}
