// TWO SYNTHETIC PROJECTS FOR THE OFFLINE BENCHMARK — A (the learn) and B (the replay).
//
// Nothing here is a real person, property or account. Every value is invented, every email is
// @example.com, every phone is in the 555-01xx fiction block, and the city is fictional. They
// exist to answer one question per replayed field: did B's value land in B's box, and did
// anything of A's come along? So A and B differ in EVERY per-project value (names, address,
// contact details, equipment models and quantities, account and meter numbers, installer) and
// share only what one jurisdiction's filings genuinely share (state, AHJ, utility, city).
//
// The secrets (account, meter, portal password) are the hard-rule-2 tripwire: the harness
// scans every planner request for them.

export interface SynthInstaller {
  company: string;
  contactFirst: string;
  contactLast: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  license: string;
  /** The company's supervising electrician (the product's electricalSupervisorName) - the
   *  person an Electrical Contractor block names, distinct from the installer contact so a
   *  swap of the two blocks is visible to the scoreboard. */
  electricianName: string;
}

export interface SynthProject {
  tag: "A" | "B";
  ownerFirst: string;
  ownerLast: string;
  ownerEmail: string;
  ownerPhone: string;
  /** Street line only ("4127 Larkspur Ln"). */
  street: string;
  streetNumber: string;
  /** The core street name an Accela search takes ("Larkspur"). */
  streetNameCore: string;
  city: string;
  state: string;
  zip: string;
  county: string;
  ahj: string;
  utility: string;
  accountNumber: string;
  meterNumber: string;
  dcKw: string;
  acKw: string;
  stories: string;
  moduleMake: string;
  moduleModel: string;
  moduleQty: string;
  inverterMake: string;
  inverterModel: string;
  inverterQty: string;
  installer: SynthInstaller;
  /** Portal login for the PowerClerk-shaped base. */
  portalUsername: string;
  portalPassword: string;
}

export const PROJECT_A: SynthProject = {
  tag: "A",
  ownerFirst: "Harriet",
  ownerLast: "Quillfeather",
  ownerEmail: "harriet.quill@example.com",
  ownerPhone: "541-555-0142",
  street: "4127 Larkspur Ln",
  streetNumber: "4127",
  streetNameCore: "Larkspur",
  city: "Fernhollow",
  state: "OR",
  zip: "97499",
  county: "Wexcombe",
  ahj: "City of Fernhollow",
  utility: "Cascadia Power",
  accountNumber: "7701234567",
  meterNumber: "M55501234",
  dcKw: "9.6",
  acKw: "7.68",
  stories: "1",
  moduleMake: "Qcells",
  moduleModel: "Q.PEAK DUO BLK ML-G10+ 400",
  moduleQty: "24",
  inverterMake: "APsystems",
  inverterModel: "DS3-L",
  inverterQty: "12",
  installer: {
    company: "Brightfield Solar Co",
    contactFirst: "Oswin",
    contactLast: "Marlowe",
    email: "permits@brightfield.example.com",
    phone: "541-555-0177",
    street: "88 Foundry Row",
    city: "Tillwater",
    state: "OR",
    zip: "97411",
    license: "CCB 220417",
    electricianName: "Rowan Thistlewood",
  },
  portalUsername: "brightfield.permits",
  portalPassword: "Pw-Replica-A!93",
};

export const PROJECT_B: SynthProject = {
  tag: "B",
  ownerFirst: "Desmond",
  ownerLast: "Yarrowby",
  ownerEmail: "d.yarrowby@example.com",
  ownerPhone: "541-555-0163",
  street: "918 Quimby Ave",
  streetNumber: "918",
  streetNameCore: "Quimby",
  city: "Fernhollow",
  state: "OR",
  zip: "97498",
  county: "Harlan",
  ahj: "City of Fernhollow",
  utility: "Cascadia Power",
  accountNumber: "8802468013",
  meterNumber: "M66607788",
  dcKw: "7.2",
  acKw: "5.8",
  stories: "2",
  moduleMake: "REC",
  moduleModel: "REC400AA Pure-R",
  moduleQty: "18",
  inverterMake: "Enphase",
  inverterModel: "IQ8M-72-2-US",
  inverterQty: "18",
  installer: {
    company: "Kestrel Energy LLC",
    contactFirst: "Philippa",
    contactLast: "Ashgrove",
    email: "office@kestrel.example.com",
    phone: "541-555-0199",
    street: "1200 Relay Ct",
    city: "Bramford",
    state: "OR",
    zip: "97433",
    license: "CCB 318822",
    electricianName: "Ines Coldharbour",
  },
  portalUsername: "kestrel.office",
  portalPassword: "Pw-Replica-B!57",
};

/** The secrets whose appearance in ANY planner request is a hard-rule-2 breach. */
export function secretsOf(p: SynthProject): string[] {
  return [p.accountNumber, p.meterNumber, p.portalPassword];
}

/** Every per-project literal of `p`, flattened — the leak scan's vocabulary. */
export function literalsOf(p: SynthProject): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === "tag") continue;
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) if (typeof x === "string") out.push(x);
  }
  return out;
}

/** Values of A that B does not share — the ones whose presence on B's filing is a leak.
 *  Short tokens (state, "1") are excluded: they cannot be told apart from coincidence. */
export function aOnlyLiterals(a: SynthProject, b: SynthProject): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const bSet = new Set(literalsOf(b).map(norm));
  return [...new Set(literalsOf(a))].filter((v) => v.trim().length >= 3 && !bSet.has(norm(v)));
}
