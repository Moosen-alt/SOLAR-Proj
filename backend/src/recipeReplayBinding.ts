// A RECIPE REPLAY NEVER PUTS ANOTHER PROJECT'S DATA INTO THIS APPLICATION.
//
// Measured on the two complete Coos Bay recipes on Oregon ePermitting (2026-09-25): the
// structural recipe's "Description of Work" (243 characters) and "Additional Comments" carried
// the learn job's DC/AC kW, module count and make as LITERALS; building height, stories, areas,
// dwelling units and number of buildings were literals; its agency-specific questions were
// identified only by the donor agency's control ids (…_COOS_BAY_rdo_0_0_1 behind a bare "No");
// and step 47 was a human-patch click on the link "187-26-000309-STR" — Coos Bay's own FILED
// RECORD. Replayed for another project, that last step opens a previous customer's record.
//
// This runs on EVERY recipe replay (the entity's own recipe and a borrowed one) in the backend,
// before the steps reach the adapter, and returns the steps the run may execute plus a named
// account of every change. It is pure: no DB, no browser.
//
//   R1 RECORD LINKS — a click/check whose target names a specific permit record number never
//      replays (own or borrowed). Stripped with a named reason.
//   R2 PROJECT LITERALS — a free-text fill under a project-specific label (description of work,
//      comments, building height, stories, areas, dwelling units, buildings) binds to THIS
//      project's value (resolveRecipeFieldValues already derives each key; an empty value is a
//      blank the reviewer sees, never the learn job's answer). Any other free-text literal that
//      carries system figures (kW, watts, a "(19) Make Model" module count) is blanked.
//   R3 AGENCY (the address-version / jurisdiction row) — bound to the issuing agency the per-job
//      lookup found for THIS AHJ and track (fieldValues.issuingAgency). The replay re-ranks a
//      live address-version step ([data-al-row]) by that agency (portal-bot addressVersion —
//      the SAME issuingAgencyRow parse this file asks), so a borrowed recipe binds whenever the
//      agency is a city or a county. A BORROWED recipe REFUSES, named, when the agency is
//      unknown, is neither a city nor a county, names both (ambiguous), or when the step is a
//      LITERAL recorded row (tr:has-text("CITY APPLICATIONS")…) the replay clicks as recorded and
//      that row is the other kind. (Until 2026-09-27 the live ranking preferred CITY rows for
//      structural and COUNTY rows for electrical whatever the agency, so a county-issued
//      structural permit — City of Jefferson's — could only be refused.)
//   R4 DONOR-AGENCY IDENTITY (borrowed, different agency) — CSS fallbacks naming the donor's
//      agency code or a positional service-list index are stripped; a step whose only identity
//      was such an id behind a bare answer ("Yes"/"No") is stripped (the required-field sweep
//      then stops the run for a human instead of answering someone else's question).
//   R5 STATE VOCABULARY GUIDANCE (Oregon BCD, cited in permitProcess.STATE_PERMIT_RULES):
//      Category of Construction = the structure type (never "Other"), Type of Work = Alteration
//      for an existing building, and the "Other Category" free text is left empty.
//   R6 FEE-TIER QUANTITY (close M1) — a kVA fee-tier box (feeBracketQuantity:<min>-<max>) is the
//      SAME ROW when its numeric bounds agree with one of THIS project's tier keys (5.01-15 ≡ 5-15;
//      an open lower bound ≡ 0): the step is rebound to this project's key. A BORROWED recipe's tier
//      box that matches none of this project's tiers types BLANK (its recorded quantity was the
//      donor project's size), never the donor's "1"; the step and its key are kept so the coverage
//      check still reports a tier with no recorded box.
//   R7 VALUATION (leak sweep 2026-09-28) — a Job Value / Valuation / Estimated Cost box bound to the
//      contract price (jobValue / contractAmount) or frozen as a figure binds to THIS project's
//      declaredValuation (the operator formula the PDF application files). A contract-price box keeps
//      the contract.
//   R8 COMPANY ATTESTATIONS (leak sweep 2026-09-28) — a check/select answering a fact about the
//      installer company replays only on the job of the company that recorded it (step.companyFactOf);
//      elsewhere a check is not replayed and a select replays blank, named for a person.
//   R9 LICENCE KIND (licences skeptic L2) — a step bound to a licence number / expiry key whose LABEL
//      names a different licence kind (licenceKinds.kindForSlot, the one predicate) reads the label
//      kind's key for THIS job ("CSL Number" bound to the generic ccbLicenseNumber takes this client's
//      construction supervisor licence) — or replays BLANK, named for a person, when the kind has no
//      key or this client holds none. Never another kind's number.
//   R10 ONE CONTACT, ONE IDENTITY (live Corvallis electrical, 2026-09-28) — a fill/select inside a
//      contact dialog belongs to the section that opened it (the Add New / Select from Account /
//      Edit click before it); a step bound to the OTHER identity's key is rebound to this one's
//      matching key (an Applicant dialog's homeownerName → installerContactName; an Owner dialog's
//      installerEmail → homeownerEmail), a contact literal binds to this identity's key, and a part
//      the identity lacks (an Owner's business name) replays blank. Unknown section: untouched.
import type { CitedFact, ProjectRecord, RecipeStep } from "../../shared/src/types";
import { stateRulesFor } from "./permitProcess";
import { feeBracketFieldKey, parseFeeBracketFieldKey, sameFeeTier, tierBoundsFromLabel } from "../../portal-bot/src/feeBracketQuantity";
import { issuingAgencyRow } from "../../portal-bot/src/addressVersion";
import { DECLARED_VALUATION_FIELD, rebindsToValuation } from "./valuation";
import { companyFactStamp, isCompanyAttestationStep } from "../../shared/src/companyFacts";
import { mountKindForProject } from "./codeReviewRules";
import { licenceKeyForLabel, licenceKindWords } from "../../shared/src/licenceKinds";
import {
  contactFieldKind, contactKeyFor, contactKeyForRole, contactRoleOfStep, type ContactRole, type ContactTrack,
} from "../../shared/src/contactRoles";
export { sameFeeTier };

/** A main-page click that opens a contact section's dialog. */
const CONTACT_OPENER = /\b(?:add new|select from account|edit|add (?:a |new )?contact)\b/i;

export interface ReplayBindingChange {
  index: number;
  kind: "stripped" | "rebound" | "blanked" | "fallbacks_stripped" | "vocabulary";
  label: string;
  reason: string;
}
export interface ReplayBinding {
  steps: RecipeStep[];
  /** For each returned step, its index in the recipe as stored (heals map back through this). */
  originalIndex: number[];
  /** Keys added to the field-value dictionary (e.g. the blank key, the issuing agency). */
  fieldValues: Record<string, string>;
  changes: ReplayBindingChange[];
  /** Set only for a BORROWED recipe that cannot be bound to this project: do not borrow. */
  refusal: string | null;
}

/** A permit record number: 187-26-000309-STR, 555-26-002978-ELEC, BLD2024-00123, B-24-001234. */
export const RECORD_NUMBER = /\b(?:[A-Z0-9]{2,5}-\d{2}-\d{4,7}(?:-[A-Z]{2,6})?|[A-Z]{2,5}\d{2,4}-\d{3,7}|[A-Z]{1,3}-\d{2}-\d{5,7})\b/;
export const REPLAY_BLANK_FIELD = "__replayBlank";

const PROJECT_LITERAL_BINDINGS: Array<{ re: RegExp; field: string }> = [
  { re: /description of work|work description|project description|scope of work|describe (the )?work/i, field: "workDescription" },
  { re: /additional comments|^\*?comments:?$/i, field: "workDescription" },
  { re: /building height.*(feet|ft)/i, field: "buildingHeightFeet" },
  { re: /building height.*(inch|in\b)/i, field: "buildingHeightInches" },
  { re: /number of stories|^\*?stories:?$/i, field: "numberOfStories" },
  { re: /new building area/i, field: "newBuildingArea" },
  { re: /existing building area/i, field: "existingBuildingArea" },
  { re: /dwelling units/i, field: "dwellingUnits" },
  { re: /number of buildings/i, field: "numberOfBuildings" },
];
/** Free text that carries a system's figures: "8.36 kW", "440W", "(19) ZNShine …". */
const SYSTEM_FIGURES = /\b\d+(?:\.\d+)?\s*kW\b|\b\d{3}\s?W\b|\(\d+\)\s*[A-Za-z]/i;

const labelOf = (s: RecipeStep): string => String(s.selector?.label || s.selector?.name || s.selector?.text || s.note || "").trim();
const cssOf = (s: RecipeStep): string[] => [s.selector?.css ?? "", ...(s.selector?.fallbacks ?? []).map((f) => f.css ?? "")].filter(Boolean);

/** "Marion County" → county; "City of Coos Bay" → city; otherwise unknown. A NAME-kind filter for
 *  fee-schedule matching (feeSchedules). R3's address-row question is asked of
 *  portal-bot addressVersion.issuingAgencyRow — the parse the replay ranks the grid with. */
export function agencyKind(name: string): "county" | "city" | "" {
  const n = String(name ?? "").toLowerCase();
  if (/\bcounty\b/.test(n)) return "county";
  if (/\b(city|town|village)\b/.test(n)) return "city";
  return "";
}
/** Accela agency code convention seen on Oregon ePermitting: "Marion County" → MARION_CO,
 *  "Coos County" → COOS_CO, "City of Coos Bay" → COOS_BAY. "" when it cannot be derived. */
export function agencyCodeFor(name: string): string {
  const n = String(name ?? "").trim();
  if (!n) return "";
  const county = /^(.+?)\s+county\b/i.exec(n);
  if (county) return `${county[1].trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_CO`;
  const city = /^(?:city|town|village) of\s+(.+)$/i.exec(n);
  if (city) return city[1].trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return "";
}
/** The agency code an ASI control id carries: …AppSpec7E1D9A3EEdit_COOS_BAY_ddl_1_0 → COOS_BAY. */
export function agencyCodeInCss(css: string): string {
  const m = /AppSpec[0-9A-F]+Edit_([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*?)_(?:ddl|txt|rdo|chk|cb|lbl|dt)_\d/.exec(css);
  return m ? m[1] : "";
}
/** The tier key a recorded kVA box label names ("…- 5.01kva through 15kva:" → 5.01-15), or "".
 *  The ONE portal-label grammar (feeBracketQuantity.tierBoundsFromLabel) — the same reading the
 *  replay adapter makes of the live page and feeBracketFields makes of a recorded label. */
function tierKeyForLabel(label: string): string {
  const b = tierBoundsFromLabel(label);
  return b ? feeBracketFieldKey(b.minKw, b.maxKw) : "";
}
const hasKey = (o: Record<string, string>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const POSITIONAL_SERVICE_LIST = /cbListServices_\d+|rptAgency_ctl\d+/i;

export function bindRecipeForReplay(input: {
  steps: RecipeStep[];
  portalUrl?: string;
  project: Pick<ProjectRecord, "state" | "ahj"> & { city?: string; parserSnapshot?: Record<string, unknown>; clientId?: string | null };
  fieldValues: Record<string, string>;
  track: string | null | undefined;
  /** Set when the recipe was learned for ANOTHER entity (findBorrowableRecipe). */
  borrowed: { learnedFor: string; discipline: string } | null;
  /** The issuing agency the per-job lookup found for this AHJ and track (permitProcess). */
  agency: CitedFact<string> | null;
}): ReplayBinding {
  const changes: ReplayBindingChange[] = [];
  const steps: RecipeStep[] = [];
  const originalIndex: number[] = [];
  const fieldValues: Record<string, string> = { [REPLAY_BLANK_FIELD]: "" };
  const agencyName = String(input.agency?.value ?? "").trim();
  if (agencyName) fieldValues.issuingAgency = agencyName;
  const targetCode = agencyCodeFor(agencyName);
  const snapshot = input.project.parserSnapshot ?? {};
  const guidance = stateRulesFor(input.project.state).applicationInfoGuidance?.value ?? null;
  // A NEW STRUCTURE (ground / pole / carport) is not an alteration of an existing building. The one
  // mount predicate (codeReviewRules.mountKindForProject: `mounting`, then `mountType`, then the
  // design text) — this read only the dead mountType key, so it was never true.
  const mount = mountKindForProject({ ...input.project, parserSnapshot: snapshot } as ProjectRecord);
  const groundMount = mount === "ground" || mount === "carport";
  const newConstruction = /new construction|new (home|dwelling|building)/i.test(String(snapshot.constructionType ?? snapshot.workType ?? ""));
  // The recipe's OWN vocabulary for a structure type (a CoC select whose answer is not "Other").
  const structureVocab = input.steps.find((s) => s.action === "select" && /category of construction/i.test(labelOf(s))
    && String(s.value ?? "").trim() && !/^other$/i.test(String(s.value ?? "").trim()) && /dwelling|family|residential/i.test(String(s.value)))?.value ?? "";
  const residentialSingle = /single|one|1\b|two|duplex|family|dwelling|sfd|residential/i.test(String(snapshot.structureDescription ?? snapshot.occupancy ?? snapshot.structureType ?? "residential"));
  let refusal: string | null = null;
  let sawAgencyRow = false;
  // R10's open contact block (see there). A utility interconnection reads "applicant" as the customer.
  let contactBlock: { role: ContactRole | null; label: string } | null = null;
  const contactTrack: ContactTrack = String(input.track ?? "").toLowerCase() === "nem" ? "nem" : "permit";
  // The agency as the address-version row reads it — the one parse (portal-bot addressVersion)
  // the replay's live ranking asks too, so "will the replay rank by it" has one answer.
  const agencyRow = issuingAgencyRow(agencyName, { city: input.project.city });

  input.steps.forEach((original, index) => {
    let step: RecipeStep = { ...original, selector: original.selector ? { ...original.selector, fallbacks: original.selector.fallbacks ? [...original.selector.fallbacks] : undefined } : original.selector };
    const label = labelOf(step);
    const note = String(step.note ?? "");
    const record = (kind: ReplayBindingChange["kind"], reason: string) => changes.push({ index, kind, label: label.slice(0, 60), reason });

    // R1 — never open a specific filed record.
    if ((step.action === "click" || step.action === "check") && !step.isFinalSubmit) {
      const hay = [step.selector?.name, step.selector?.text, step.selector?.label, note].map((v) => String(v ?? "")).join(" ");
      const m = RECORD_NUMBER.exec(hay);
      if (m) {
        record("stripped", `clicks the specific filed record ${m[0]} — replaying it would open a previous customer's record`);
        return;
      }
    }

    // R8 — a COMPANY ATTESTATION (workers'-comp exemption, "no employees", insurance type, "I'm a
    // contractor", one company's licence option) is answered only for the company whose job recorded
    // it (step.companyFactOf, stamped at learn). On any other company's job — or an unstamped legacy
    // step — it is left for a person: a check is not replayed, a select replays blank. Never the
    // learn company's sworn answer on someone else's application.
    if (isCompanyAttestationStep(step)) {
      const own = Boolean(step.companyFactOf) && step.companyFactOf === companyFactStamp(input.project.clientId);
      if (!own) {
        const why = `a company attestation ("${label.slice(0, 50)}") recorded on ${step.companyFactOf ? "another company's" : "a"} job — left for a person, never another company's answer`;
        if (step.action === "check") {
          record("stripped", why);
          return;
        }
        step = { ...step, value: "", field: REPLAY_BLANK_FIELD, operatorItem: why };
        record("blanked", why);
      }
    }

    // R3 — the agency / jurisdiction row.
    const isAgencyRow = /data-al-row\s*=/.test(step.selector?.css ?? "") || /^address version:/i.test(note) || /^work location: select .*row/i.test(note);
    if (isAgencyRow) {
      sawAgencyRow = true;
      if (input.borrowed) {
        if (!agencyName) {
          refusal = refusal ?? `the ${input.borrowed.learnedFor} recipe selects the issuing agency (its address-version row "${note.replace(/^address version:\s*/i, "").slice(0, 40)}"), and the agency that issues ${input.project.ahj}'s ${input.track ?? "permit"} permits is not known — the per-job lookup found none, so that selection cannot be bound to this project`;
        } else {
          const kind = agencyRow.kind;
          // A LIVE address-version step is re-ranked on the page by fieldValues.issuingAgency
          // (recipeAdapter.pickAddressVersionLive → addressVersion). A literal recorded row is
          // clicked exactly as recorded, so its own kind must already be the agency's.
          const liveRanked = /data-al-row\s*=/.test(step.selector?.css ?? "");
          const literalCss = cssOf(step).join(" ");
          const literalKind = /COUNTY APPLICATIONS/i.test(literalCss) ? "county" : /CITY APPLICATIONS/i.test(literalCss) ? "city" : "";
          if (agencyRow.ambiguous) {
            refusal = refusal ?? `${input.project.ahj}'s ${input.track ?? "permit"} permits are issued by "${agencyName}", which names both a city and a county, so the address-version row cannot be bound to one of them — borrowing the ${input.borrowed.learnedFor} recipe would guess the agency`;
          } else if (!kind) {
            // Close M2: an agency that is neither a city nor a county ("Oregon Building Codes
            // Division", "State of Oregon") cannot be matched to the city/county row the replay
            // picks — borrowing would click the DONOR's row with nothing bound.
            refusal = refusal ?? `${input.project.ahj}'s ${input.track ?? "permit"} permits are issued by ${agencyName}, which is neither a city nor a county, so the replay's address-version row (city or county) cannot be bound to it — borrowing the ${input.borrowed.learnedFor} recipe would select ${input.borrowed.learnedFor}'s agency row`;
          } else if (!liveRanked && literalKind !== kind) {
            refusal = refusal ?? `${input.project.ahj}'s ${input.track ?? "permit"} permits are issued by ${agencyName} (a ${kind}), but the ${input.borrowed.learnedFor} recipe's address-version step clicks a recorded ${literalKind ? `${literalKind.toUpperCase()} row` : "row"} that the replay does not re-rank — borrowing it could file with the wrong agency`;
          }
          // Otherwise bound: the replay ranks the live grid by the agency and stops, named, if
          // the grid offers no row naming it and its pick would be the other kind.
        }
      }
      if (agencyName) {
        // APPENDED, never replaced: the adapter reads the recorded note (county/electrical) as a
        // live-ranking signal, and the discipline detector reads it too.
        step.note = `${note || "address version"} — issuing agency: ${agencyName} (${input.agency?.origin === "lookup" ? "per-job lookup" : input.agency?.origin ?? "lookup"})`;
        if (step.selector?.fallbacks?.length) step.selector.fallbacks = step.selector.fallbacks.filter((f) => !(f.role === "link" && /^select$/i.test(String(f.name ?? ""))));
        record("rebound", `agency row bound to ${agencyName}`);
      }
    }

    // R4 — the donor agency's identity (borrowed only, different agency).
    if (input.borrowed && step.selector) {
      const donorCode = cssOf(step).map(agencyCodeInCss).find(Boolean) ?? "";
      const foreignCode = donorCode && donorCode !== targetCode;
      const beforeCss = cssOf(step).length;
      const keep = (css: string | undefined) => !css || (!POSITIONAL_SERVICE_LIST.test(css) && !(foreignCode && agencyCodeInCss(css) === donorCode));
      if (step.selector.fallbacks) step.selector.fallbacks = step.selector.fallbacks.filter((f) => keep(f.css));
      if (step.selector.css && !keep(step.selector.css)) delete step.selector.css;
      if (cssOf(step).length < beforeCss) {
        const bareAnswer = /^(yes|no|n\/?a)$/i.test(String(step.selector.label ?? step.selector.name ?? "").trim())
          && !step.selector.css && !step.selector.testId && !step.selector.placeholder;
        if (bareAnswer && foreignCode) {
          record("stripped", `its question was identified only by ${donorCode}'s control id behind a bare "${step.selector.label ?? step.selector.name}" — never answer another agency's question; the required-field sweep stops for a person`);
          return;
        }
        record("fallbacks_stripped", foreignCode ? `CSS fallbacks naming ${donorCode} (the donor agency) or a positional list index were dropped` : "positional service-list fallback dropped");
      }
    }

    // R5 — state vocabulary guidance (Category of Construction / Type of Work).
    if (guidance) {
      if (step.action === "select" && /^\*?category of construction:?$/i.test(label) && /^other$/i.test(String(step.value ?? "").trim())) {
        if (structureVocab && residentialSingle) {
          step.value = String(structureVocab);
          record("vocabulary", `Category of Construction = the structure type ("${structureVocab}"), not "Other" (state guidance)`);
        } else {
          step = { ...step, value: "", field: REPLAY_BLANK_FIELD };
          record("vocabulary", "Category of Construction must be the structure type, not \"Other\" (state guidance) — left for a person");
        }
      } else if (step.action === "select" && /^\*?type of work:?$/i.test(label) && /^new$/i.test(String(step.value ?? "").trim()) && !groundMount && !newConstruction) {
        step.value = guidance.typeOfWorkExisting;
        record("vocabulary", `Type of Work = ${guidance.typeOfWorkExisting} for an existing building (state guidance)`);
      } else if ((step.action === "fill") && /other category of construction/i.test(label)) {
        step = { ...step, value: "", field: REPLAY_BLANK_FIELD, optional: true };
        record("blanked", "\"Other Category of Construction\" applies only when the category is Other (state guidance: solar is not Other)");
      }
    }

    // R6 — the kVA fee-tier quantity box.
    if (step.action === "fill" && step.field !== REPLAY_BLANK_FIELD) {
      const recordedKey = step.field && parseFeeBracketFieldKey(step.field)
        ? step.field
        : (!step.field ? tierKeyForLabel(label) : "");
      const recorded = recordedKey ? parseFeeBracketFieldKey(recordedKey) : null;
      if (recorded && !hasKey(input.fieldValues, recordedKey)) {
        const same = Object.keys(input.fieldValues).find((k) => {
          const b = parseFeeBracketFieldKey(k);
          return Boolean(b && sameFeeTier(b, recorded));
        });
        if (same) {
          step = { ...step, field: same };
          record("rebound", `fee-tier box bound to this project's tier ${same.replace(/^feeBracketQuantity:/, "")} (recorded as ${recordedKey.replace(/^feeBracketQuantity:/, "")})`);
        } else if (input.borrowed) {
          step = { ...step, field: recordedKey };
          fieldValues[recordedKey] = "";
          record("blanked", `fee-tier box ${recordedKey.replace(/^feeBracketQuantity:/, "")} matches none of this project's tiers — the recorded quantity was ${input.borrowed.learnedFor}'s project, so it is left blank for a person`);
        }
      }
    }

    // R7 — a Job Value / Valuation / Estimated Cost box takes THIS project's declared valuation
    // (valuation.ts: the operator formula, the figure the PDF files), never the contract price the
    // learn run bound (jobValue / contractAmount — both complete Coos Bay recipes' "Job Value($):")
    // and never a frozen figure. A box labelled contract price keeps the contract.
    if (step.action === "fill" && step.field !== REPLAY_BLANK_FIELD && hasKey(input.fieldValues, DECLARED_VALUATION_FIELD)
        && rebindsToValuation(`${label} ${note}`, step.field)) {
      const was = step.field ? `the contract price (${step.field})` : "a recorded figure";
      step = { ...step, field: DECLARED_VALUATION_FIELD };
      delete step.value;
      record("rebound", `valuation box bound to this project's declared valuation, not ${was}`);
    }

    // R9 — a licence step reads the kind its LABEL names (licenceKeyForLabel — the replay adapter asks
    // the same question of the same label, so the two cannot disagree).
    if ((step.action === "fill" || step.action === "select") && step.field && step.field !== REPLAY_BLANK_FIELD) {
      const lic = licenceKeyForLabel(step.field, label);
      if (lic) {
        const was = step.field;
        const value = lic.key ? String(input.fieldValues[lic.key] ?? "").trim() : "";
        if (!lic.key || !value) {
          const why = `"${label.slice(0, 50)}" asks for the ${licenceKindWords(lic.labelKind)}${lic.key ? ", and none is on file for this job's company" : ", which has no key of its own"} — left blank for a person, never the ${was} number`;
          step = { ...step, value: "", field: REPLAY_BLANK_FIELD, operatorItem: why };
          record("blanked", why);
        } else {
          const same = value === String(input.fieldValues[was] ?? "").trim();
          step = { ...step, field: lic.key };
          if (!same) record("rebound", `"${label.slice(0, 50)}" asks for the ${licenceKindWords(lic.labelKind)} — bound to ${lic.key}, not ${was}`);
        }
      }
    }

    // R10 — ONE CONTACT, ONE IDENTITY. A main-page click that opens a contact section (Add New,
    // Select from Account, Edit) opens a block; every dialog (framed) fill/select until the next
    // main-page step belongs to it. Its identity is the section's: the step's own role mark, the
    // section control id, or the recorded section heading (shared contactRoles — the learner's
    // pass and dialog guard ask the same predicates). A box bound to the OTHER identity's key
    // replays this identity's matching key; a literal under a contact label binds to it; a part
    // this identity does not have (an Owner block's business name) replays blank. A block whose
    // section says nothing is left exactly as recorded — never guessed.
    {
      const inFrame = Boolean(original.selector?.frame);
      const words = `${original.selector?.name ?? ""} ${original.selector?.text ?? ""} ${original.selector?.label ?? ""} ${note}`;
      const opener = original.action === "click" && !inFrame && CONTACT_OPENER.test(words);
      if (opener) {
        contactBlock = { role: contactRoleOfStep(original, { track: contactTrack }), label: label.slice(0, 40) };
      } else if (!inFrame) {
        contactBlock = null;
      } else if (contactBlock && (step.action === "fill" || step.action === "select") && step.field !== REPLAY_BLANK_FIELD && !step.sensitive) {
        const role = contactBlock.role ?? contactRoleOfStep(original, { track: contactTrack });
        if (role) {
          const who = role === "company" ? "the filing company" : "the property owner";
          if (step.field) {
            const want = contactKeyForRole(step.field, role);
            if (want === null) {
              const why = `"${label.slice(0, 40)}" in ${who}'s contact block was bound to ${step.field}, a part ${who} does not have — replayed blank`;
              step = { ...step, value: "", field: REPLAY_BLANK_FIELD };
              record("blanked", why);
            } else if (want && want !== step.field) {
              const was = step.field;
              step = { ...step, field: want };
              delete step.value;
              record("rebound", `"${label.slice(0, 40)}" in ${who}'s contact block (${contactBlock.label}) bound to ${want}, not ${was} — one contact, one identity`);
            }
          } else if (step.action === "fill" && String(step.value ?? "").trim()) {
            const kind = contactFieldKind(label);
            const key = kind ? contactKeyFor(role, kind) : undefined;
            if (key && hasKey(input.fieldValues, key)) {
              step = { ...step, field: key };
              delete step.value;
              record("rebound", `"${label.slice(0, 40)}" in ${who}'s contact block bound to ${key} (the recorded answer was the learn project's)`);
            } else if (kind && key === null) {
              step = { ...step, value: "", field: REPLAY_BLANK_FIELD };
              record("blanked", `"${label.slice(0, 40)}" in ${who}'s contact block is a part ${who} does not have — replayed blank`);
            }
          }
        }
      }
    }

    // R2 — project-specific free text.
    if (step.action === "fill" && step.field !== REPLAY_BLANK_FIELD) {
      const known = step.field && Object.prototype.hasOwnProperty.call(input.fieldValues, step.field);
      const literal = String(step.value ?? "").trim();
      if (!known) {
        const binding = PROJECT_LITERAL_BINDINGS.find((b) => b.re.test(label) || b.re.test(note));
        if (binding && Object.prototype.hasOwnProperty.call(input.fieldValues, binding.field)) {
          step = { ...step, field: binding.field };
          record("rebound", `bound to this project's ${binding.field}${literal ? " (the recorded answer was the learn project's)" : ""}`);
        } else if (literal && SYSTEM_FIGURES.test(literal)) {
          step = { ...step, value: "", field: REPLAY_BLANK_FIELD };
          record("blanked", "a free-text literal carrying the learn project's system figures");
        }
      }
    }

    steps.push(step);
    originalIndex.push(index);
  });

  // Close M2: a borrowed recipe with NO address-version step still files with SOME agency (the
  // portal picks it from the donor's other choices); with this AHJ's issuing agency unknown there is
  // nothing to check that choice against, so the borrow is refused rather than assumed.
  if (input.borrowed && !sawAgencyRow && !agencyName) {
    refusal = refusal ?? `the issuing agency for ${input.project.ahj}'s ${input.track ?? "permit"} permits is not known (the per-job lookup found none), and the ${input.borrowed.learnedFor} recipe has no agency row to bind — the agency it files with cannot be checked against this project`;
  }
  return { steps, originalIndex, fieldValues, changes, refusal };
}

/** One operator-readable line for the run message. */
export function describeReplayBinding(b: ReplayBinding): string {
  if (!b.changes.length) return "";
  const n = (k: ReplayBindingChange["kind"]) => b.changes.filter((c) => c.kind === k).length;
  const parts = [
    n("stripped") ? `${n("stripped")} step(s) not replayed` : "",
    n("rebound") ? `${n("rebound")} bound to this project` : "",
    n("blanked") ? `${n("blanked")} left blank` : "",
    n("vocabulary") ? `${n("vocabulary")} answered per state guidance` : "",
    n("fallbacks_stripped") ? `${n("fallbacks_stripped")} donor-specific selector(s) dropped` : "",
  ].filter(Boolean);
  const stripped = b.changes.filter((c) => c.kind === "stripped").map((c) => c.reason).slice(0, 2);
  return ` Replay binding: ${parts.join(", ")}.${stripped.length ? ` ${stripped.join(" ")}` : ""}`;
}
