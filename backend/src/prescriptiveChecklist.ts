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

/** Recognize the known nine-row form and recover its four standalone criteria.
 *  Framing, roofing, module-height/figure compliance, attachments, and the
 *  manufacturer's design/installation commitment need facts the evaluator
 *  does not establish. They deliberately remain unmapped. */
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
    const key = SUPPORTED.get(canonical(rowText));
    if (!key) continue;
    const cap = key.charAt(0).toUpperCase() + key.slice(1);
    // Explicit maps win. Recovery adds missing rows; it does not rewrite maps.
    if (sources.some((s) => s.startsWith(`computed.presc${cap}`))) continue;
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
    positions.forEach((p, i) => overlays.push({ source: `computed.presc${cap}${i ? "No" : "Yes"}`,
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
  if (textFields["Listing agency"] === "lit:UL") omittedTextFields.push("Listing agency");
  return { recognized: true, overlays, omittedTextFields, textFieldOverrides };
}
