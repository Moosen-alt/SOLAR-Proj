// SYNTHETIC REPLICA WIZARDS — the portal SHAPES the bot fails on in production, with no
// customer data in them.
//
// Three bases, each modelled on a platform the production runs actually hit:
//   accela     — ASP.NET WebForms: every advance a full postback, the Cap/WorkLocation address
//                search an ASYNC UpdatePanel postback on the SAME URL (search -> results grid ->
//                Select a row -> Continue Application; the grid nested in a layout table and
//                each row carrying parcel + owner of record), a record-type CheckBoxList
//                (Oregon's cbListServices), two contact blocks
//                that share every label, an autopostback select that re-renders its panel, an
//                attachment, and a read-only CapConfirm review whose "Continue Application"
//                FILES the application.
//   powerclerk — per-field autosave on blur (a value never blurred is never saved), a
//                manufacturer -> model cascade that loads ~600ms later, a County select whose
//                options arrive late, a contact block that RE-RENDERS from saved state after each
//                save (so an uncommitted value is wiped), a date picker that stays open until
//                Escape, per-slot uploads, and a terms-checkbox Submit page (plus a Pay button).
//   spa        — an unknown-shape Angular-like wizard: one URL, hash routes, generated
//                mat-input-N ids, a role=combobox listbox for State, client-side validation,
//                and a "Submit Application" review step.
//
// Each base has seven mutations (see MUTATIONS) that model how a portal drifts between the
// learn and the replay. Every control carries a LOGICAL key that never changes across
// mutations — that key, not the id or label, is what the scoreboard compares on.
//
// Platform-owned hooks (Accela's termAccept / StreetNo4Search / WorkLocationEdit_btnSearch,
// the ctl00_PlaceHolderMain prefix) are marked stableId: those ids are the platform's, they
// do not drift per jurisdiction, and the engine's deterministic passes key on them.
import type { SynthProject } from "./syntheticProjects";

export type Flavor = "accela" | "powerclerk" | "spa";
export const FLAVORS: Flavor[] = ["accela", "powerclerk", "spa"];

export type Mutation =
  | "base"
  | "ids_renamed"
  | "sections_reordered"
  | "extra_readonly_page"
  | "one_page_fewer"
  | "relabelled"
  | "duplicate_label_pair"
  | "slow_x3";
export const MUTATIONS: Mutation[] = [
  "base", "ids_renamed", "sections_reordered", "extra_readonly_page",
  "one_page_fewer", "relabelled", "duplicate_label_pair", "slow_x3",
];

export interface Opt { value: string; text: string }

/** Which project document a file slot is expected to receive. */
export type DocKey = "plan_set" | "sld" | "site_plan";

export type MatchMode = "exact" | "ci" | "digits" | "prefix3" | "date_future" | "option";

export interface Expect {
  value: (p: SynthProject, docs: Record<DocKey, string>) => string;
  match: MatchMode;
}

export interface Ctl {
  key: string;
  kind: "text" | "textarea" | "select" | "radio" | "checklist" | "checkbox" | "file" | "date" | "combo";
  label: string;
  section: string;
  id: string;
  name: string;
  options?: Opt[];
  /** Options come from CASCADE[parent's value] once the parent is chosen (after a delay). */
  cascadeFrom?: string;
  /** Options arrive only after delays.lateOptions (PowerClerk County). */
  lateOptions?: boolean;
  /** Accela: a change fires an async postback that re-renders the panel. */
  autopostback?: boolean;
  required?: boolean;
  /** No <label> (Accela's street-number range pair); watermark only. */
  unlabeled?: boolean;
  watermark?: string;
  expect?: Expect;
  /** A decoy that must stay empty; anything written into it is a wrong-box write. */
  mustStayEmpty?: boolean;
  /** The label the "relabelled" mutation gives this control. */
  relabel?: string;
  /** A platform id that does not drift (see header). */
  stableId?: boolean;
  /** Shown only once another control holds a value (Accela ASI dependent field). */
  dependsOn?: { key: string; value: string };
}

export type PageKind = "login" | "dashboard" | "disclaimer" | "worklocation" | "form" | "readonly" | "review";

export interface PageSpec {
  slug: string;
  title: string;
  heading: string;
  kind: PageKind;
  sections: string[];
  controls: Ctl[];
  /** Read-only body copy for notice/review pages. */
  note?: string;
}

export interface Delays {
  /** Accela async postback / SPA step post round trip. */
  postback: number;
  /** PowerClerk make -> model cascade. */
  cascade: number;
  /** PowerClerk County options. */
  lateOptions: number;
  /** PowerClerk autosave round trip. */
  autosave: number;
  /** PowerClerk contact block re-render after a save. */
  rerender: number;
  /** SPA route render. */
  render: number;
}

export interface Wizard {
  flavor: Flavor;
  mutation: Mutation;
  name: string;
  pages: PageSpec[];
  delays: Delays;
  /** Present when the portal has a login page. */
  login?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Equipment catalogue (certified names differ from plan-set names, as on PowerClerk).
// ---------------------------------------------------------------------------------------------

export const MODULE_MAKES: Opt[] = [
  { value: "", text: "Please select..." },
  { value: "HQC", text: "Hanwha Q CELLS" },
  { value: "REC", text: "REC Solar" },
  { value: "CSI", text: "Canadian Solar Inc" },
];
export const INVERTER_MAKES: Opt[] = [
  { value: "", text: "Please select..." },
  { value: "APS", text: "Altenergy Power System" },
  { value: "ENP", text: "Enphase Energy Inc." },
  { value: "SEG", text: "SolarEdge Technologies" },
];
export const CASCADE: Record<string, Opt[]> = {
  HQC: [{ value: "HQC-400", text: "Q.PEAK DUO BLK ML-G10+ 400" }, { value: "HQC-405", text: "Q.PEAK DUO BLK ML-G10+ 405" }],
  REC: [{ value: "REC-400", text: "REC400AA Pure-R" }, { value: "REC-410", text: "REC410AA Pure-R" }],
  CSI: [{ value: "CSI-395", text: "CS6R-395MS" }],
  APS: [{ value: "APS-DS3L", text: "DS3-L {240V}" }, { value: "APS-DS3S", text: "DS3-S {240V}" }],
  ENP: [{ value: "ENP-IQ8M", text: "IQ8M-72-2-US [240V]" }, { value: "ENP-IQ8P", text: "IQ8PLUS-72-2-US [240V]" }],
  SEG: [{ value: "SEG-SE7600", text: "SE7600H-US" }],
};
const MAKE_CODE: Record<string, string> = { qcells: "HQC", rec: "REC", apsystems: "APS", enphase: "ENP" };
const makeCode = (make: string) => MAKE_CODE[make.toLowerCase().replace(/[^a-z]/g, "")] ?? "";
const modelCode = (make: string, model: string): string => {
  const opts = CASCADE[makeCode(make)] ?? [];
  const m = model.trim().toLowerCase();
  return opts.find((o) => o.text.toLowerCase().startsWith(m))?.value ?? "";
};

export const STATES: Opt[] = [
  { value: "", text: "--Select--" }, { value: "OR", text: "Oregon" }, { value: "WA", text: "Washington" },
  { value: "CA", text: "California" }, { value: "ID", text: "Idaho" },
];
export const COUNTIES: Opt[] = [
  { value: "", text: "Please select..." }, { value: "Wexcombe", text: "Wexcombe" },
  { value: "Harlan", text: "Harlan" }, { value: "Lindow", text: "Lindow" },
];

const ex = (value: Expect["value"], match: MatchMode = "ci"): Expect => ({ value, match });
const fullName = (f: string, l: string) => `${f} ${l}`;

// ---------------------------------------------------------------------------------------------
// ACCELA-SHAPED BASE
// ---------------------------------------------------------------------------------------------

const PM = "ctl00_PlaceHolderMain_";
const pmName = (id: string) => id.replace(/_/g, "$");

function accelaCtl(c: Omit<Ctl, "name"> & { name?: string }): Ctl {
  return { ...c, name: c.name ?? pmName(c.id) };
}

function accelaBase(): PageSpec[] {
  const wl = `${PM}WorkLocationEdit_`;
  return [
    {
      slug: "CapApplyDisclaimer.aspx?module=Building", title: "Accela Citizen Access", heading: "General Disclaimer",
      kind: "disclaimer", sections: ["Terms"],
      note: "By continuing you acknowledge the agency's general disclaimer for online permit applications.",
      controls: [accelaCtl({ key: "disclaimer.accept", kind: "checkbox", label: "I have read and accepted the above terms.", section: "Terms", id: `${PM}termAccept`, stableId: true, required: true })],
    },
    {
      slug: "WorkLocation.aspx?module=Building", title: "Accela Citizen Access", heading: "Step 1: Enter Work Site Location",
      kind: "worklocation", sections: ["Work Location"],
      note: "Enter JUST the exact street number and a portion of the street name. For example, enter 1234 pin instead of 1234 Pine St.",
      controls: [
        accelaCtl({ key: "worklocation.streetNumber", kind: "text", label: "Street No.", section: "Work Location", id: `${wl}txtStreetNo4Search_ChildControl0`, unlabeled: true, watermark: "From", stableId: true, expect: ex((p) => p.streetNumber, "exact") }),
        accelaCtl({ key: "worklocation.streetNumberTo", kind: "text", label: "Street No. To", section: "Work Location", id: `${wl}txtStreetNo4Search_ChildControl1`, unlabeled: true, watermark: "To", stableId: true }),
        accelaCtl({ key: "worklocation.streetName", kind: "text", label: "Street Name:", section: "Work Location", id: `${wl}txtStreetName`, watermark: "First 3 characters only", stableId: true, expect: ex((p) => p.streetNameCore, "prefix3") }),
        accelaCtl({ key: "worklocation.address", kind: "text", label: "Selected address", section: "Work Location", id: `${wl}hdnSelected`, stableId: true, expect: ex((p) => `${p.street}|COUNTY`, "ci") }),
      ],
    },
    {
      slug: "CapType.aspx?module=Building", title: "Accela Citizen Access", heading: "Select a Record Type",
      kind: "form", sections: ["Building"],
      controls: [accelaCtl({
        // Oregon ePermitting renders record types as an ASP.NET CheckBoxList (cbListServices).
        key: "recordType", kind: "checklist", label: "Record Type", section: "Building", id: `${PM}cbListServices`, required: true,
        options: [
          { value: "Building/Residential/Addition/NA", text: "Residential - Building Addition" },
          { value: "Building/Residential/Electrical/NA", text: "Residential - Electrical" },
          { value: "Building/Residential/Mechanical/NA", text: "Residential - Mechanical" },
          { value: "Building/Commercial/Electrical/NA", text: "Commercial - Electrical" },
        ],
        expect: ex(() => "Building/Residential/Electrical/NA", "exact"),
      })],
    },
    {
      slug: "CapEdit.aspx?stepNumber=2&pageNumber=1", title: "Accela Citizen Access", heading: "Step 2: Contacts",
      kind: "form", sections: ["Applicant", "Property Owner"],
      controls: [
        accelaCtl({ key: "applicant.firstName", kind: "text", label: "First Name:", section: "Applicant", id: `${PM}ApplicantEdit_txtFirstName`, required: true, expect: ex((p) => p.installer.contactFirst) }),
        accelaCtl({ key: "applicant.lastName", kind: "text", label: "Last Name:", section: "Applicant", id: `${PM}ApplicantEdit_txtLastName`, required: true, expect: ex((p) => p.installer.contactLast) }),
        accelaCtl({ key: "applicant.business", kind: "text", label: "Business Name:", section: "Applicant", id: `${PM}ApplicantEdit_txtBusinessName`, expect: ex((p) => p.installer.company) }),
        accelaCtl({ key: "applicant.email", kind: "text", label: "E-mail:", section: "Applicant", id: `${PM}ApplicantEdit_txtEmail`, required: true, expect: ex((p) => p.installer.email) }),
        accelaCtl({ key: "applicant.phone", kind: "text", label: "Phone Number:", section: "Applicant", id: `${PM}ApplicantEdit_txtPhone1`, required: true, expect: ex((p) => p.installer.phone, "digits") }),
        accelaCtl({ key: "owner.firstName", kind: "text", label: "First Name:", section: "Property Owner", id: `${PM}OwnerEdit_txtFirstName`, required: true, expect: ex((p) => p.ownerFirst) }),
        accelaCtl({ key: "owner.lastName", kind: "text", label: "Last Name:", section: "Property Owner", id: `${PM}OwnerEdit_txtLastName`, required: true, expect: ex((p) => p.ownerLast) }),
        accelaCtl({ key: "owner.email", kind: "text", label: "E-mail:", section: "Property Owner", id: `${PM}OwnerEdit_txtEmail`, relabel: "Email Address:", expect: ex((p) => p.ownerEmail) }),
        accelaCtl({ key: "owner.phone", kind: "text", label: "Phone Number:", section: "Property Owner", id: `${PM}OwnerEdit_txtPhone1`, expect: ex((p) => p.ownerPhone, "digits") }),
      ],
    },
    {
      slug: "CapEdit.aspx?stepNumber=2&pageNumber=2", title: "Accela Citizen Access", heading: "Step 2: Additional Information",
      kind: "form", sections: ["Solar Project Information"],
      controls: [
        accelaCtl({ key: "asi.workDescription", kind: "textarea", label: "Description of Work:", section: "Solar Project Information", id: `${PM}AppSpecInfo_ASI_1_0`, relabel: "Scope of Work:", required: true, expect: ex((p) => `Roof-mounted residential solar PV system, ${p.dcKw} kW DC / ${p.acKw} kW AC`) }),
        accelaCtl({ key: "asi.dcKw", kind: "text", label: "System Size (kW DC):", section: "Solar Project Information", id: `${PM}AppSpecInfo_ASI_1_1`, required: true, expect: ex((p) => p.dcKw, "exact") }),
        accelaCtl({ key: "asi.moduleQty", kind: "text", label: "Total Number of Modules:", section: "Solar Project Information", id: `${PM}AppSpecInfo_ASI_1_2`, required: true, expect: ex((p) => p.moduleQty, "exact") }),
        accelaCtl({
          key: "asi.occupancy", kind: "select", label: "Occupancy Type:", section: "Solar Project Information", id: `${PM}AppSpecInfo_ASI_1_3`, autopostback: true, required: true,
          options: [{ value: "", text: "--Select--" }, { value: "SFD", text: "Single Family Dwelling" }, { value: "DUP", text: "Duplex" }, { value: "COM", text: "Commercial" }],
          expect: ex(() => "SFD", "exact"),
        }),
        accelaCtl({ key: "asi.stories", kind: "text", label: "Number of Stories:", section: "Solar Project Information", id: `${PM}AppSpecInfo_ASI_1_4`, required: true, dependsOn: { key: "asi.occupancy", value: "SFD" }, expect: ex((p) => p.stories, "exact") }),
      ],
    },
    {
      slug: "CapEdit.aspx?stepNumber=3&pageNumber=1", title: "Accela Citizen Access", heading: "Step 3: Attachments",
      kind: "form", sections: ["Attachment"],
      note: "Upload all plan pages as ONE PDF under Plans - Construction.",
      controls: [accelaCtl({ key: "attach.plans", kind: "file", label: "Plans - Construction", section: "Attachment", id: `${PM}attachmentEdit_fileUpload`, required: true, expect: ex((_p, d) => d.plan_set, "ci") })],
    },
    {
      slug: "CapConfirm.aspx", title: "Accela Citizen Access", heading: "Step 4: Review",
      kind: "review", sections: [],
      note: "Please review all information below. Click the Edit buttons to make changes to sections or Continue Application to move on.",
      controls: [],
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// POWERCLERK-SHAPED BASE
// ---------------------------------------------------------------------------------------------

function pcCtl(n: number, c: Omit<Ctl, "id" | "name">): Ctl {
  return { ...c, id: `pcInputBase${n}`, name: `pcInputBase${n}` };
}

function powerClerkBase(): PageSpec[] {
  const cust = "Customer Information";
  const inst = "Installer/Equipment Contractor";
  const elec = "Electrical Contractor";
  const mod = "PV Module Information";
  const inv = "Inverter Information";
  return [
    { slug: "Account/Login", title: "PowerClerk - Sign In", heading: "Sign In", kind: "login", sections: [], controls: [] },
    {
      slug: "Dashboard", title: "PowerClerk - My Projects", heading: "My Projects", kind: "dashboard", sections: [],
      note: "Programs: Residential Net Metering Interconnection (Cascadia Power).", controls: [],
    },
    {
      slug: "MvcProjects/EditProject/~customer-information", title: "PowerClerk - Customer Information", heading: "Customer Information",
      kind: "form", sections: [cust],
      controls: [
        pcCtl(10, { key: "cust.firstName", kind: "text", label: "First Name", section: cust, required: true, expect: ex((p) => p.ownerFirst) }),
        pcCtl(11, { key: "cust.lastName", kind: "text", label: "Last Name", section: cust, required: true, expect: ex((p) => p.ownerLast) }),
        pcCtl(12, { key: "cust.email", kind: "text", label: "Email", section: cust, required: true, relabel: "E-mail Address", expect: ex((p) => p.ownerEmail) }),
        pcCtl(13, { key: "cust.phone", kind: "text", label: "Phone", section: cust, required: true, expect: ex((p) => p.ownerPhone, "digits") }),
        pcCtl(14, { key: "cust.street", kind: "text", label: "Service Address", section: cust, required: true, expect: ex((p) => p.street) }),
        pcCtl(15, { key: "cust.city", kind: "text", label: "City", section: cust, required: true, expect: ex((p) => p.city) }),
        pcCtl(16, { key: "cust.state", kind: "select", label: "State", section: cust, required: true, options: STATES, expect: ex((p) => p.state, "exact") }),
        pcCtl(17, { key: "cust.zip", kind: "text", label: "Zip Code", section: cust, required: true, expect: ex((p) => p.zip, "exact") }),
        pcCtl(18, { key: "cust.county", kind: "select", label: "County", section: cust, required: true, lateOptions: true, options: COUNTIES, expect: ex((p) => p.county, "exact") }),
        // Not required at Next: the learner never types a secret (it records the step bound by
        // name, value ""), so a portal that refused Next without them would stop every learn on
        // page one and hide the rest of the wizard. Still SCORED — replay must bind them.
        pcCtl(19, { key: "cust.account", kind: "text", label: "Utility Account Number", section: cust, expect: ex((p) => p.accountNumber, "exact") }),
        pcCtl(20, { key: "cust.meter", kind: "text", label: "Meter Number", section: cust, expect: ex((p) => p.meterNumber, "exact") }),
      ],
    },
    {
      slug: "MvcProjects/EditProject/~installer-information", title: "PowerClerk - Installer Information", heading: "Installer Information",
      kind: "form", sections: [inst, elec],
      controls: [
        pcCtl(30, { key: "inst.name", kind: "text", label: "Name", section: inst, required: true, expect: ex((p) => fullName(p.installer.contactFirst, p.installer.contactLast)) }),
        pcCtl(31, { key: "inst.company", kind: "text", label: "Company", section: inst, required: true, expect: ex((p) => p.installer.company) }),
        pcCtl(32, { key: "inst.email", kind: "text", label: "Email", section: inst, required: true, expect: ex((p) => p.installer.email) }),
        pcCtl(33, { key: "inst.phone", kind: "text", label: "Phone", section: inst, required: true, expect: ex((p) => p.installer.phone, "digits") }),
        // The electrical contractor's NAME is the supervising electrician, not the installer contact:
        // distinct values, so a replay that swaps the two same-labelled blocks scores wrong_box.
        // Company/email/phone stay the installer's (the product has no separate electrical
        // company), and the scoreboard prints those pairs as a known blind spot.
        pcCtl(40, { key: "elec.name", kind: "text", label: "Name", section: elec, required: true, expect: ex((p) => p.installer.electricianName) }),
        pcCtl(41, { key: "elec.company", kind: "text", label: "Company", section: elec, required: true, expect: ex((p) => p.installer.company) }),
        pcCtl(42, { key: "elec.email", kind: "text", label: "Email", section: elec, expect: ex((p) => p.installer.email) }),
        pcCtl(43, { key: "elec.phone", kind: "text", label: "Phone", section: elec, expect: ex((p) => p.installer.phone, "digits") }),
      ],
    },
    {
      slug: "MvcProjects/EditProject/~system-specifications", title: "PowerClerk - PV System Specification", heading: "PV System Specification",
      kind: "form", sections: [mod, inv, "Project Dates"],
      controls: [
        pcCtl(50, { key: "mod.make", kind: "select", label: "Manufacturer", section: mod, required: true, options: MODULE_MAKES, expect: ex((p) => makeCode(p.moduleMake), "exact") }),
        pcCtl(51, { key: "mod.model", kind: "select", label: "Model", section: mod, required: true, cascadeFrom: "mod.make", options: [{ value: "", text: "Please select..." }], expect: ex((p) => modelCode(p.moduleMake, p.moduleModel), "exact") }),
        pcCtl(52, { key: "mod.qty", kind: "text", label: "Quantity", section: mod, required: true, relabel: "Number of Modules", expect: ex((p) => p.moduleQty, "exact") }),
        pcCtl(60, { key: "inv.make", kind: "select", label: "Manufacturer", section: inv, required: true, options: INVERTER_MAKES, expect: ex((p) => makeCode(p.inverterMake), "exact") }),
        pcCtl(61, { key: "inv.model", kind: "select", label: "Model", section: inv, required: true, cascadeFrom: "inv.make", options: [{ value: "", text: "Please select..." }], expect: ex((p) => modelCode(p.inverterMake, p.inverterModel), "exact") }),
        pcCtl(62, { key: "inv.qty", kind: "text", label: "Quantity", section: inv, required: true, expect: ex((p) => p.inverterQty, "exact") }),
        pcCtl(70, { key: "dates.inService", kind: "date", label: "Estimated In-Service Date", section: "Project Dates", required: true, expect: ex(() => "", "date_future") }),
      ],
    },
    {
      slug: "MvcProjects/EditProject/~attachments", title: "PowerClerk - Attachments", heading: "Attachments",
      kind: "form", sections: ["Required Documents"],
      controls: [
        pcCtl(80, { key: "doc.sld", kind: "file", label: "One-Line Diagram *", section: "Required Documents", required: true, expect: ex((_p, d) => d.sld, "ci") }),
        pcCtl(81, { key: "doc.sitePlan", kind: "file", label: "Site Plan *", section: "Required Documents", required: true, expect: ex((_p, d) => d.site_plan, "ci") }),
      ],
    },
    {
      slug: "MvcProjects/EditProject/~review-and-submit", title: "PowerClerk - Review & Submit", heading: "Review & Submit",
      kind: "review", sections: ["Terms"],
      note: "Please review all information below. I understand that my form will not be submitted until I click Submit.",
      controls: [pcCtl(90, { key: "terms.accept", kind: "checkbox", label: "Click to Accept Terms and Conditions", section: "Terms" })],
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// SPA (Angular-like, unknown shape) BASE
// ---------------------------------------------------------------------------------------------

function spaCtl(n: number, form: string, c: Omit<Ctl, "id" | "name">): Ctl {
  return { ...c, id: `mat-input-${n}`, name: form };
}

function spaBase(): PageSpec[] {
  return [
    {
      slug: "applicant", title: "Permit Portal", heading: "Applicant", kind: "form", sections: ["Applicant (Contractor)"],
      controls: [
        spaCtl(1, "contractorFirstName", { key: "app.firstName", kind: "text", label: "First name", section: "Applicant (Contractor)", required: true, expect: ex((p) => p.installer.contactFirst) }),
        spaCtl(2, "contractorLastName", { key: "app.lastName", kind: "text", label: "Last name", section: "Applicant (Contractor)", required: true, expect: ex((p) => p.installer.contactLast) }),
        spaCtl(3, "contractorCompany", { key: "app.company", kind: "text", label: "Company", section: "Applicant (Contractor)", required: true, expect: ex((p) => p.installer.company) }),
        spaCtl(4, "contractorEmail", { key: "app.email", kind: "text", label: "Email", section: "Applicant (Contractor)", required: true, expect: ex((p) => p.installer.email) }),
        spaCtl(5, "contractorPhone", { key: "app.phone", kind: "text", label: "Phone", section: "Applicant (Contractor)", required: true, expect: ex((p) => p.installer.phone, "digits") }),
      ],
    },
    {
      slug: "property", title: "Permit Portal", heading: "Property", kind: "form", sections: ["Property Owner", "Site Address"],
      controls: [
        spaCtl(6, "ownerFirstName", { key: "prop.firstName", kind: "text", label: "First name", section: "Property Owner", required: true, expect: ex((p) => p.ownerFirst) }),
        spaCtl(7, "ownerLastName", { key: "prop.lastName", kind: "text", label: "Last name", section: "Property Owner", required: true, expect: ex((p) => p.ownerLast) }),
        spaCtl(8, "ownerEmail", { key: "prop.email", kind: "text", label: "Email", section: "Property Owner", expect: ex((p) => p.ownerEmail) }),
        spaCtl(9, "siteStreet", { key: "site.street", kind: "text", label: "Street address", section: "Site Address", required: true, expect: ex((p) => p.street) }),
        spaCtl(10, "siteCity", { key: "site.city", kind: "text", label: "City", section: "Site Address", required: true, expect: ex((p) => p.city) }),
        // OPTIONAL on purpose: a required mat-select the extractor cannot see would stop every SPA
        // walk here and hide every later page from the scoreboard. Its blank still fails the
        // strict all-correct score, so nothing is hidden.
        spaCtl(11, "siteState", { key: "site.state", kind: "combo", label: "State", section: "Site Address", options: STATES, expect: ex((p) => p.state, "exact") }),
        spaCtl(12, "siteZip", { key: "site.zip", kind: "text", label: "ZIP", section: "Site Address", required: true, relabel: "Postal code", expect: ex((p) => p.zip, "exact") }),
      ],
    },
    {
      slug: "system", title: "Permit Portal", heading: "System", kind: "form", sections: ["System Details"],
      controls: [
        spaCtl(13, "dcKw", { key: "sys.dcKw", kind: "text", label: "System size (kW DC)", section: "System Details", required: true, expect: ex((p) => p.dcKw, "exact") }),
        spaCtl(14, "moduleCount", { key: "sys.moduleQty", kind: "text", label: "Number of modules", section: "System Details", required: true, relabel: "Module count", expect: ex((p) => p.moduleQty, "exact") }),
        spaCtl(15, "moduleMake", { key: "sys.moduleMake", kind: "text", label: "Module manufacturer", section: "System Details", required: true, expect: ex((p) => p.moduleMake) }),
        spaCtl(16, "moduleModel", { key: "sys.moduleModel", kind: "text", label: "Module model", section: "System Details", required: true, expect: ex((p) => p.moduleModel) }),
        spaCtl(17, "inverterMake", { key: "sys.inverterMake", kind: "text", label: "Inverter manufacturer", section: "System Details", required: true, expect: ex((p) => p.inverterMake) }),
        spaCtl(18, "inverterModel", { key: "sys.inverterModel", kind: "text", label: "Inverter model", section: "System Details", required: true, expect: ex((p) => p.inverterModel) }),
        spaCtl(19, "inverterCount", { key: "sys.inverterQty", kind: "text", label: "Number of inverters", section: "System Details", required: true, expect: ex((p) => p.inverterQty, "exact") }),
      ],
    },
    {
      slug: "documents", title: "Permit Portal", heading: "Documents", kind: "form", sections: ["Documents"],
      controls: [spaCtl(20, "planSet", { key: "docs.planSet", kind: "file", label: "Plan set (PDF)", section: "Documents", required: true, expect: ex((_p, d) => d.plan_set, "ci") })],
    },
    {
      slug: "review", title: "Permit Portal", heading: "Review your application", kind: "review", sections: [],
      note: "Please review all information below before you submit.", controls: [],
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

const BASE_DELAYS: Record<Flavor, Delays> = {
  accela: { postback: 700, cascade: 0, lateOptions: 0, autosave: 0, rerender: 0, render: 0 },
  powerclerk: { postback: 0, cascade: 600, lateOptions: 1500, autosave: 250, rerender: 300, render: 0 },
  spa: { postback: 300, cascade: 0, lateOptions: 0, autosave: 0, rerender: 0, render: 400 },
};

function renameId(flavor: Flavor, c: Ctl): Ctl {
  if (c.stableId) return c;
  if (flavor === "accela") {
    // A jurisdiction's build renames its user controls; the platform prefix stays.
    const id = c.id.replace(/ApplicantEdit_/, "ContactEdit1_").replace(/OwnerEdit_/, "ContactEdit2_")
      .replace(/AppSpecInfo_ASI_1_/, "AppSpecInfoEdit_ASI_7_").replace(/attachmentEdit_/, "AttachmentsEdit_").replace(/cbListServices/, "chkRecordTypes");
    return { ...c, id, name: pmName(id) };
  }
  if (flavor === "powerclerk") {
    const n = Number(c.id.replace(/\D+/g, "")) + 37;
    return { ...c, id: `pcInputBase${n}`, name: `pcInputBase${n}` };
  }
  const n = Number(c.id.replace(/\D+/g, "")) + 11;
  return { ...c, id: `mat-input-${n}`, name: `${c.name}V2` };
}

function readonlyPage(flavor: Flavor): PageSpec {
  if (flavor === "accela") {
    return {
      slug: "CapEdit.aspx?stepNumber=2&pageNumber=3", title: "Accela Citizen Access", heading: "Step 2: Licensed Professional",
      kind: "readonly", sections: [], controls: [],
      note: "The licensed professional on your account will be attached to this record. No changes are needed on this page.",
    };
  }
  if (flavor === "powerclerk") {
    return {
      slug: "MvcProjects/EditProject/~program-information", title: "PowerClerk - Program Information", heading: "Program Information",
      kind: "readonly", sections: [], controls: [],
      note: "This program accepts residential systems up to 25 kW AC. Continue to the next section.",
    };
  }
  return {
    slug: "notice", title: "Permit Portal", heading: "Before you continue", kind: "readonly", sections: [], controls: [],
    note: "Inspections are scheduled after the permit is issued. Continue to the next step.",
  };
}

function duplicateSection(flavor: Flavor, page: PageSpec): PageSpec {
  const dupOf = (labelRe: RegExp) => page.controls.find((c) => labelRe.test(c.label));
  const phone = dupOf(/phone/i);
  const email = dupOf(/e-?mail/i);
  const sec = flavor === "accela" ? "Emergency Contact" : flavor === "powerclerk" ? "Alternate Contact" : "Secondary Contact";
  const extras: Ctl[] = [];
  let n = 0;
  for (const src of [phone, email]) {
    if (!src) continue;
    n++;
    const id = flavor === "accela" ? `${PM}EmergencyEdit_txt${n}` : flavor === "powerclerk" ? `pcInputBase${95 + n}` : `mat-input-${60 + n}`;
    extras.push({ key: `decoy.${n}`, kind: "text", label: src.label, section: sec, id, name: flavor === "accela" ? pmName(id) : flavor === "spa" ? `secondary${n}` : id, mustStayEmpty: true });
  }
  return { ...page, sections: [sec, ...page.sections], controls: [...extras, ...page.controls] };
}

/** Build one concrete wizard: a base shape with one mutation applied. */
export function buildWizard(flavor: Flavor, mutation: Mutation): Wizard {
  let pages = flavor === "accela" ? accelaBase() : flavor === "powerclerk" ? powerClerkBase() : spaBase();
  const delays = { ...BASE_DELAYS[flavor] };
  const formIdx = () => pages.map((p, i) => ({ p, i })).filter((x) => x.p.kind === "form");
  const reviewIdx = () => pages.findIndex((p) => p.kind === "review");

  switch (mutation) {
    case "base":
      break;
    case "ids_renamed":
      pages = pages.map((p) => ({ ...p, controls: p.controls.map((c) => renameId(flavor, c)) }));
      break;
    case "sections_reordered":
      pages = pages.map((p) => {
        if (p.kind !== "form" || p.sections.length < 2) {
          // Single-section form: move the last control to the front.
          if (p.kind === "form" && p.controls.length > 2 && !p.controls.some((c) => c.dependsOn || c.cascadeFrom)) {
            return { ...p, controls: [p.controls[p.controls.length - 1], ...p.controls.slice(0, -1)] };
          }
          return p;
        }
        const order = [...p.sections].reverse();
        const controls = order.flatMap((s) => p.controls.filter((c) => c.section === s));
        return { ...p, sections: order, controls };
      });
      break;
    case "extra_readonly_page": {
      // After the first real form page.
      const first = formIdx()[0]?.i ?? 1;
      pages = [...pages.slice(0, first + 1), readonlyPage(flavor), ...pages.slice(first + 1)];
      break;
    }
    case "one_page_fewer": {
      // Drop the page right before review (the upload page on every base), so a recipe
      // learned on the full wizard lands on the review screen one page early.
      const r = reviewIdx();
      pages = [...pages.slice(0, r - 1), ...pages.slice(r)];
      break;
    }
    case "relabelled":
      pages = pages.map((p) => ({ ...p, controls: p.controls.map((c) => (c.relabel ? { ...c, label: c.relabel } : c)) }));
      break;
    case "duplicate_label_pair": {
      const target = flavor === "accela" ? pages.findIndex((p) => /contacts/i.test(p.heading))
        : flavor === "powerclerk" ? pages.findIndex((p) => /customer information/i.test(p.heading))
          : pages.findIndex((p) => p.slug === "property");
      pages = pages.map((p, i) => (i === target ? duplicateSection(flavor, p) : p));
      break;
    }
    case "slow_x3":
      for (const k of Object.keys(delays) as Array<keyof Delays>) delays[k] = delays[k] * 3;
      break;
  }
  return { flavor, mutation, name: `${flavor}/${mutation}`, pages, delays, login: flavor === "powerclerk" };
}

/** Every scored control in the wizard, in page order. */
export function scoredControls(w: Wizard): Ctl[] {
  return w.pages.flatMap((p) => p.controls.filter((c) => c.expect));
}
