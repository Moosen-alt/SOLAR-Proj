// A DETERMINISTIC STAND-IN FOR THE LLM PLANNER — offline benchmark only.
//
// The production planner is an LLM call (backend/src/autoLearn.ts buildPortalPlanner). The
// offline scoreboard cannot make one (no key, no cost, no nondeterminism), so this answers the
// same LearnPlanRequest from label + section alone, the way a competent model reads a form:
// "First Name" under an Owner/Customer heading is the homeowner's; under Applicant/Installer/
// Contractor it is the installer's; a bare "Name" under a contractor heading is the contact.
//
// It is GENERIC on purpose — no replica ids, no page names — so a score it earns is the
// ENGINE's score on those shapes, not a fixture-tuned one. It receives exactly the
// projectFields buildPortalPlanner produces (secrets already stripped), binds every fill to
// the key it came from (`field`), never advances with a submit/pay-shaped control, and on a
// review screen reports atReview with the submit recorded (never clicked by the engine).
//
// Everything that reads its output must say it was used: STAND_IN_PLANNER_ID.
import type { ExtractedField, LearnPlanRequest, LearnPlanResponse } from "../adapters/autoLearnAdapter";

export const STAND_IN_PLANNER_ID = "deterministic-label-map/v1 (no LLM)";

const OWNERISH = /owner|customer|property|homeowner|site contact|account holder/i;
const INSTALLERISH = /applicant|contractor|installer|company|licensed/i;

interface Rule { re: RegExp; keys: (ctx: { owner: boolean; installer: boolean; utility: boolean; section: string }) => string[] }

const RULES: Rule[] = [
  { re: /first\s*name/i, keys: (c) => (c.installer && !c.owner ? ["installerFirstName"] : c.utility ? ["ubAccountHolderFirstName", "homeownerFirstName"] : ["homeownerFirstName"]) },
  { re: /last\s*name/i, keys: (c) => (c.installer && !c.owner ? ["installerLastName"] : c.utility ? ["ubAccountHolderLastName", "homeownerLastName"] : ["homeownerLastName"]) },
  { re: /^\s*(full\s*)?name\s*\*?:?\s*$/i, keys: (c) => (/electric/i.test(c.section) ? ["electricalSupervisorName"] : c.installer ? ["installerContactName"] : ["homeownerName"]) },
  { re: /company|business\s*name/i, keys: () => ["installerCompanyName"] },
  { re: /e-?\s*mail/i, keys: (c) => (c.installer && !c.owner ? ["installerEmail"] : c.utility ? ["ubAccountHolderEmail", "homeownerEmail"] : ["homeownerEmail"]) },
  { re: /phone/i, keys: (c) => (c.installer && !c.owner ? ["installerPhone"] : c.utility ? ["ubAccountHolderPhone", "homeownerPhone"] : ["homeownerPhone"]) },
  { re: /service\s*address|street\s*address|^\s*address\s*\*?:?\s*$|address\s*line/i, keys: () => ["street"] },
  { re: /^\s*city\b/i, keys: () => ["city"] },
  { re: /^\s*state\b/i, keys: () => ["state"] },
  { re: /zip|postal/i, keys: () => ["zip"] },
  { re: /county/i, keys: () => ["county"] },
  { re: /description\s*of\s*work|scope\s*of\s*work|work\s*description/i, keys: () => ["workDescription"] },
  { re: /system\s*size.*(kw|dc)|kw\s*dc/i, keys: () => ["systemSizeDcKw"] },
  { re: /number\s*of\s*stories|stories/i, keys: () => ["numberOfStories"] },
  { re: /module\s*manufacturer/i, keys: () => ["moduleMake", "moduleManufacturer"] },
  { re: /module\s*model/i, keys: () => ["moduleModel"] },
  { re: /inverter\s*manufacturer/i, keys: () => ["inverterMake"] },
  { re: /inverter\s*model/i, keys: () => ["inverterModel"] },
  { re: /number\s*of\s*inverters|inverter\s*(count|quantity)/i, keys: () => ["inverterQty"] },
  { re: /(total\s*)?number\s*of\s*modules|module\s*(count|quantity)/i, keys: () => ["moduleQuantity", "moduleQty"] },
  { re: /^\s*manufacturer\s*\*?:?\s*$/i, keys: (c) => (/inverter/i.test(c.section) ? ["inverterMake"] : /module|pv\s*module|panel/i.test(c.section) ? ["moduleMake"] : []) },
  { re: /^\s*model\s*\*?:?\s*$/i, keys: (c) => (/inverter/i.test(c.section) ? ["inverterModel"] : /module|pv\s*module|panel/i.test(c.section) ? ["moduleModel"] : []) },
  { re: /^\s*(quantity|number\s*of\s*units)\s*\*?:?\s*$/i, keys: (c) => (/inverter/i.test(c.section) ? ["inverterQty"] : /module|panel/i.test(c.section) ? ["moduleQuantity", "moduleQty"] : []) },
  { re: /in[-\s]?service|commission|installation\s*date|energiz/i, keys: () => ["estimatedCommissioningDate"] },
];

const ADVANCE = /^\s*(next|continue|continue application|save\s*(and|&)\s*continue|proceed)\b/i;
const NEVER_ADVANCE = /submit|pay|fee|finish\s*later|resume\s*later|save\s*(and|&)\s*(exit|resume)|cancel|delete|withdraw|sign\s*out|log\s*out|search|select|clear|back|previous/i;
const FINAL_SUBMIT = /^\s*(submit( application)?|continue application)\b/i;
const ENTRY = /start\s*(a\s*)?new\s*application|new\s*application|apply\s*(now|online)?$|create\s*(a\s*)?new\s*(project|application)/i;
const TERMS = /i have read|i accept|accept (the )?terms|terms and conditions|i agree|i certify/i;

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** An option the value names — by text, by compacted containment either way. */
function pickOption(options: string[] | undefined, value: string): string {
  if (!options?.length) return value;
  const v = compact(value);
  if (!v) return value;
  const real = options.filter((o) => compact(o) && !/^(please\s*select|--\s*select|select)/i.test(o.trim()));
  return real.find((o) => compact(o) === v)
    ?? real.find((o) => compact(o).startsWith(v))
    ?? real.find((o) => compact(o).includes(v) || (compact(o).length >= 4 && v.includes(compact(o))))
    ?? value;
}

export function standInPlanner(projectFields: Record<string, string>, opts: { utility: boolean }) {
  return async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
    const fields = req.fields;
    const fills: LearnPlanResponse["fills"] = [];
    const filled = new Set(req.alreadyFilledLabels.map((l) => l.trim().toLowerCase()));
    const fillable = (f: ExtractedField) => f.fieldType !== "button" && f.fieldType !== "file" && !f.disabled;
    fields.forEach((f, i) => {
      if (!fillable(f)) return;
      const label = String(f.label ?? "");
      const section = String(f.section ?? "");
      if (f.fieldType === "checkbox") {
        // A terms gate, or the record type this electrical job files under.
        if (TERMS.test(label) || /^\s*residential\s*[-–]\s*electrical\s*$/i.test(label)) fills.push({ selectorIndex: i, value: "true" });
        return;
      }
      if (f.fieldType === "radio") {
        if (/^\s*residential\s*[-–]\s*electrical\s*$/i.test(label)) fills.push({ selectorIndex: i, value: "true" });
        return;
      }
      if (f.fieldType === "select" && /occupancy/i.test(label)) {
        const opt = (f.options ?? []).find((o) => /single\s*family/i.test(o));
        if (opt) fills.push({ selectorIndex: i, value: opt });
        return;
      }
      const ctx = { owner: OWNERISH.test(section), installer: INSTALLERISH.test(section), utility: opts.utility, section };
      for (const rule of RULES) {
        if (!rule.re.test(label)) continue;
        const key = rule.keys(ctx).find((k) => String(projectFields[k] ?? "").trim());
        if (!key) break;
        const raw = String(projectFields[key]);
        const value = f.fieldType === "select" ? pickOption(f.options, raw) : raw;
        if (filled.has(label.trim().toLowerCase()) && fields.filter((x) => x.label === f.label).length === 1) break;
        fills.push({ selectorIndex: i, value, field: key });
        break;
      }
    });

    const buttons = fields.map((f, i) => ({ f, i })).filter((x) => x.f.fieldType === "button" || !!x.f.href);
    const text = `${req.pageTitle} ${req.bodyText}`;
    const hasInputs = fields.some((f) => fillable(f) && !(f.fieldType === "checkbox" && TERMS.test(f.label)));
    const submit = buttons.find((b) => FINAL_SUBMIT.test(b.f.label) && !/pay|fee/i.test(b.f.label));
    const looksReview = /review|confirm/i.test(text) && !!submit && !hasInputs;
    if (looksReview) {
      return { fills, atReview: true, finalSubmitSelectorIndex: submit!.i, notes: `${STAND_IN_PLANNER_ID}: review screen` };
    }
    const advance = buttons.find((b) => ADVANCE.test(b.f.label) && !NEVER_ADVANCE.test(b.f.label.replace(/continue application/i, "")) && !b.f.disabled);
    if (req.isDashboard || !hasInputs) {
      const entry = buttons.find((b) => ENTRY.test(b.f.label));
      if (entry && !advance) return { fills, navigateSelectorIndex: entry.i, atReview: false, notes: `${STAND_IN_PLANNER_ID}: entry` };
    }
    return { fills, advanceSelectorIndex: advance?.i, atReview: false, notes: STAND_IN_PLANNER_ID };
  };
}
