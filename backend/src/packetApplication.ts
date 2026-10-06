import type { ParserLlmExtraction } from "../../shared/src/types";
import { CONTRACT_PRICE_LABEL, VALUATION_BOX_LABEL, isValuationBoxLabel, parseMoney } from "./valuation";

// THE PACKET'S OWN APPLICATION PAGE (#201). Installers often bind the city's signed permit
// application (an e-signature form with a text layer) or the customer contract into the plan
// set. That page STATES the job's contract price (or its declared valuation) and the homeowner's
// phone — the things the reviewer otherwise calls out as missing ("using a per-watt estimate",
// "Homeowner phone missing"), and the estimate is what the 40% valuation and every
// valuation-laddered fee then key on. This reads them deterministically off the text the parser
// page already posts (/api/parser/llm-extract), page by page, so each value cites its page. A
// stated CONTRACT price fills jobValue; a stated Job Value / Valuation is the declared valuation
// and is recorded as statedValuation, never as jobValue (see CONTRACT PRICE vs DECLARED VALUATION).
//
// MUST-EXCLUDE: a BLANK application template ("Job Value ________") fills nothing — a value
// must follow its label directly; underscores, a later number on the page, or a phone number
// are never read as it. Two DIFFERENT stated values (two application pages that disagree) fill
// nothing either: that is review, not a pick (the structuralIntake add() rule).
//
// RACKING comes from the racking CALLOUTS (a known rail/racking product named on the site plan
// or attachment detail: "UNIRAC SOLARMOUNT RACKING", attachments "UNIRAC FLASHLOC"), never from
// a title block. Precedent matching (permitPrecedents.ts, #147) keys on it.
//
// Rule 2: the homeowner phone is contact data (allowed form data), not a listed secret. Nothing
// here reaches an LLM (it runs on the model's RESPONSE) and nothing here is logged.

interface PlanPage { page: number | null; text: string; raw: string }

/** The parser page joins pages as "--- PAGE n ---" (OCR pages "--- OCR PAGE n ---"). `raw` keeps
 *  the page's line breaks (the heading rule reads lines); `text` is whitespace-collapsed. */
export function splitPlanPages(planText: string): PlanPage[] {
  const marker = /---\s*(?:OCR\s+)?PAGE\s+(\d+)\s*---/gi;
  const hits = [...planText.matchAll(marker)];
  const page = (n: number | null, raw: string): PlanPage => ({ page: n, raw, text: raw.replace(/\s+/g, " ") });
  if (!hits.length) return [page(null, planText)];
  return hits.map((m, i) => page(Number(m[1]), planText.slice(m.index! + m[0].length, i + 1 < hits.length ? hits[i + 1].index : planText.length)));
}

// THE PAGE IS AN APPLICATION BY ITS HEADING, not by a passing mention: a cover sheet's general
// notes ("CONTRACTOR SHALL SUBMIT THE BUILDING PERMIT APPLICATION") are no application. The heading
// opens the page or a line of its own (optionally after "CITY OF …"); with no page markers the line
// rule alone applies. A permit application is also a FORM: it carries an owner box and a
// contractor / applicant box.
const HEADING_PREFIX = String.raw`^\s*(?:(?:CITY|COUNTY|TOWN|VILLAGE|TOWNSHIP|STATE)\s+OF\s+[A-Z][A-Z .'-]{0,40}?\s+)?`;
const PERMIT_APPLICATION_HEADING = new RegExp(HEADING_PREFIX + String.raw`(?:(?:RESIDENTIAL|COMMERCIAL|BUILDING|ELECTRICAL|SOLAR|PV|PHOTOVOLTAIC|CONSTRUCTION|COMBINATION)\s+)*(?:PERMIT\s+APPLICATION|APPLICATION\s+FOR\s+(?:A\s+)?(?:(?:BUILDING|ELECTRICAL|SOLAR|CONSTRUCTION)\s+)?PERMIT)\b`, "i");
// A SOLAR sales / installation contract — never a utility's net-metering or interconnection
// agreement, nor a generic "customer agreement".
const CONTRACT_HEADING = new RegExp(HEADING_PREFIX + String.raw`(?:(?:SOLAR|PV|PHOTOVOLTAIC)\s+(?:(?:ENERGY|POWER)\s+)?(?:SYSTEM\s+)?(?:INSTALLATION|PURCHASE|SALES)\s+(?:AGREEMENT|CONTRACT)|HOME\s+IMPROVEMENT\s+CONTRACT)\b`, "i");
const FORM_OWNER_BOX = /\b(?:PROPERTY\s+|HOME\s?)?OWNER\b/i;
const FORM_PARTY_BOX = /\b(?:CONTRACTOR|APPLICANT)\b/i;

function hasHeading(p: PlanPage, heading: RegExp): boolean {
  if (p.page != null && heading.test(p.text.slice(0, 160))) return true;
  return p.raw.split(/\r?\n/).some((line) => heading.test(line));
}
const isPermitApplicationPage = (p: PlanPage) =>
  hasHeading(p, PERMIT_APPLICATION_HEADING) && FORM_OWNER_BOX.test(p.text) && FORM_PARTY_BOX.test(p.text);
const isContractPage = (p: PlanPage) => hasHeading(p, CONTRACT_HEADING);

// CONTRACT PRICE vs DECLARED VALUATION (valuation.ts, operator ruling 2026-09-21). jobValue is the
// CONTRACT the client pays; the valuation filed is the operator formula OF it. A "Job Value" /
// "Valuation of work" / "Project cost" box on the city's application states the declared
// VALUATION — writing it into jobValue would file 40% of it. So only a CONTRACT_PRICE_LABEL amount
// fills jobValue; a valuation-box amount is recorded as statedValuation (evidence for review, never
// a filing input). The same label predicates the portal planner and the replay rebind ask.
//
// The number must follow its label with nothing but ":", "#", "$", "($)" or spaces between — a
// blank template line ("Job Value ________") never reaches a later number on the page — and a
// fee / minimum note after it ("$1,000 minimum", "$50 fee") is not a stated value.
const AMOUNT = String.raw`\s*(?:\(\s*\$\s*\))?\s*[:#]?\s*\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d{3,7}(?:\.\d{2})?)(?![\d,]|\s*[-.)]\s*\d{3,4}\b)(?!\s*(?:MIN(?:IMUM)?|MAX(?:IMUM)?|OR\s+(?:MORE|LESS)|AND\s+(?:UP|OVER|ABOVE)|FEE|PER\b|\/))`;
const CONTRACT_MONEY = new RegExp(String.raw`(?:\bTOTAL\s+)?(?:${CONTRACT_PRICE_LABEL.source})${AMOUNT}`, "gi");
// "Valuation of work" is a common application wording the portal predicate does not spell out;
// isValuationBoxLabel still has the final word on every match (a "contract" label never passes).
const VALUATION_MONEY = new RegExp(String.raw`(?:\bVALUATION\s+OF\s+(?:THE\s+)?(?:WORK|CONSTRUCTION|PROJECT|IMPROVEMENTS?)\b|${VALUATION_BOX_LABEL.source})${AMOUNT}`, "gi");

// THE HOMEOWNER'S PHONE, from a permit application only, and only inside the OWNER's part of it:
// walking back from the phone label, the nearest party word AND the nearest party HEADING (a party
// word not followed by ":" — "Owner: Pat" inside a contractor block is a field, not a heading) must
// both be the owner's. A contractor / applicant / agent / installer phone never qualifies, and a
// toll-free number is a company's, never a homeowner's.
const PHONE = String.raw`(\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4})(?!\d)`;
const PHONE_LABEL_AT = new RegExp(String.raw`\b(?:PHONE|TEL(?:EPHONE)?|CELL|MOBILE)(?:\s*(?:NUMBER|NO\.?|#))?\s*[:#]?\s*${PHONE}`, "gi");
const PARTY_WORD = /\b(PROPERTY\s+OWNER|HOME\s?OWNER|OWNER|CONTRACTOR|APPLICANT|AGENT|INSTALLER|DESIGNER|ENGINEER)\b/gi;
const TOLL_FREE = /^(?:800|833|844|855|866|877|888)$/;

function ownerPhoneAt(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 300), at);
  const parties = [...before.matchAll(PARTY_WORD)].map((m) => ({
    owner: /OWNER/i.test(m[1]),
    heading: !/^\s*:/.test(before.slice(m.index! + m[0].length)),
  }));
  const nearest = parties.at(-1);
  const nearestHeading = parties.filter((x) => x.heading).at(-1);
  return Boolean(nearest?.owner && nearestHeading?.owner);
}

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : raw.trim();
}

const sheetOf = (p: { page: number | null }, what: string) => (p.page != null ? `Page ${p.page} (${what})` : what);

interface StatedReading<T> { value: T; page: number | null; excerpt: string }
export interface PacketApplicationRead {
  /** The CONTRACT price (a contract-labelled amount) — the snapshot's jobValue. */
  jobValue?: StatedReading<number>;
  /** A Job Value / Valuation box amount: the DECLARED valuation the application states. */
  statedValuation?: StatedReading<number>;
  homeownerPhone?: StatedReading<string>;
}

function amounts(p: PlanPage, re: RegExp, accept: (label: string) => boolean): StatedReading<number>[] {
  const out: StatedReading<number>[] = [];
  for (const m of p.text.matchAll(re)) {
    const amount = parseMoney(m[1]);
    // A job is thousands of dollars; a bare "Job value 100" is a page artefact, not a stated value.
    if (amount == null || amount < 1000 || amount > 5_000_000) continue;
    if (!accept(p.text.slice(Math.max(0, m.index! - 20), m.index! + m[0].length - m[1].length))) continue;
    out.push({ value: amount, page: p.page, excerpt: m[0].slice(0, 100) });
  }
  return out;
}

/** One stated value across the packet, or nothing (none, or two pages that disagree: review). */
function single<T>(readings: StatedReading<T>[]): StatedReading<T> | undefined {
  return new Set(readings.map((r) => r.value)).size === 1 ? readings[0] : undefined;
}

/** The stated contract price, declared valuation and homeowner phone on the packet's own
 *  permit application / solar contract page(s). */
export function readPacketApplication(planText: string): PacketApplicationRead {
  const contract: StatedReading<number>[] = [];
  const valuation: StatedReading<number>[] = [];
  const phones: StatedReading<string>[] = [];
  for (const p of splitPlanPages(planText)) {
    const application = isPermitApplicationPage(p);
    if (!application && !isContractPage(p)) continue;
    contract.push(...amounts(p, CONTRACT_MONEY, () => true));
    if (application) valuation.push(...amounts(p, VALUATION_MONEY, isValuationBoxLabel));
    if (!application) continue;
    for (const m of p.text.matchAll(PHONE_LABEL_AT)) {
      if (!ownerPhoneAt(p.text, m.index!)) continue;
      const digits = m[1].replace(/\D/g, "");
      if (digits.length !== 10 || TOLL_FREE.test(digits.slice(0, 3))) continue;
      const start = Math.max(0, m.index! - 20);
      phones.push({ value: formatPhone(m[1]), page: p.page, excerpt: p.text.slice(start, m.index! + m[0].length).trim().slice(0, 100) });
    }
  }
  const out: PacketApplicationRead = {};
  const c = single(contract); if (c) out.jobValue = c;
  const v = single(valuation); if (v) out.statedValuation = v;
  const ph = single(phones); if (ph) out.homeownerPhone = ph;
  return out;
}

// Known racking / attachment products, matched on the callout text and written in the
// manufacturer's own casing. A product NOT in this list is left to the model's reading.
const RACKING_PRODUCTS: { re: RegExp; value: string }[] = [
  { re: /\bUNIRAC\s+SOLAR\s?MOUNT\b/i, value: "Unirac SolarMount" },
  { re: /\bUNIRAC\s+NXT(?:\s+U\s?MOUNT)?\b/i, value: "Unirac NXT Umount" },
  { re: /\bUNIRAC\s+SUN\s?FRAME\b/i, value: "Unirac SunFrame" },
  { re: /\bIRON\s?RIDGE\s+XR\s?-?(10|100|1000)\b/i, value: "IronRidge XR$1" },
  { re: /\bSNAP\s?N\s?RACK\s+ULTRA\s?RAIL\b/i, value: "SnapNrack Ultra Rail" },
  { re: /\bSNAP\s?N\s?RACK\s+(?:SERIES\s+)?100\b/i, value: "SnapNrack Series 100" },
  { re: /\bK2\s+(?:SYSTEMS\s+)?CROSS\s?RAIL\b/i, value: "K2 CrossRail" },
  { re: /\bECO\s?FASTEN\s+CLICK\s?FIT\b/i, value: "EcoFasten ClickFit" },
];
const ATTACHMENT_PRODUCTS: { re: RegExp; value: string }[] = [
  { re: /\bUNIRAC\s+FLASH\s?LOC\b/i, value: "Unirac FlashLoc" },
  { re: /\bIRON\s?RIDGE\s+FLASH\s?FOOT\s?2\b/i, value: "IronRidge FlashFoot2" },
  { re: /\bIRON\s?RIDGE\s+QUICK\s?BOLT\b|\bQUICK\s?BOLT\b/i, value: "QuickBOLT" },
  { re: /\bSNAP\s?N\s?RACK\s+UMBRELLA\b/i, value: "SnapNrack Umbrella" },
];

/** A racking value that is a title-block / project-description string, not a product. */
export function looksLikeTitleBlock(value: unknown): boolean {
  return /\bPHOTOVOLTAIC\s+SYSTEM\b|\bRESIDENCE\b|\b\d+(?:\.\d+)?\s*KW\s*(?:DC|AC)\b|\bPROJECT\b/i.test(String(value ?? ""));
}

function productCallout(text: string, products: { re: RegExp; value: string }[]): { value: string; excerpt: string; page: number | null } | null {
  const found = new Map<string, { excerpt: string; page: number | null }>();
  for (const p of splitPlanPages(text)) {
    for (const prod of products) {
      const m = prod.re.exec(p.text);
      if (!m) continue;
      const value = prod.value.replace("$1", m[1] ?? "");
      if (!found.has(value)) found.set(value, { excerpt: p.text.slice(m.index, m.index + 100), page: p.page });
    }
  }
  if (found.size !== 1) return null; // none, or two products named: the model's reading stands for review
  const [[value, at]] = [...found];
  return { value, ...at };
}

/** Supplement the text intake with the packet's own application page and racking callouts. */
export function supplementPacketApplication(result: ParserLlmExtraction, planText: string): ParserLlmExtraction {
  const fields = { ...result.fields };
  const conflicts = [...(result.conflicts ?? [])];
  const app = readPacketApplication(planText);
  // The page's labelled value is the explicit reading (structuralIntake's explicitLabel case) and
  // fills the field; a DIFFERENT value the model read is not dropped silently — both readings go
  // to review as a structured conflict.
  const fill = (key: string, read: StatedReading<string | number> | undefined, what: string, same: (a: unknown, b: unknown) => boolean) => {
    if (!read) return;
    const prior = fields[key];
    if (prior?.value != null && prior.value !== "" && !same(prior.value, read.value)) {
      conflicts.push({ field: key, note: `The packet's ${what} states a different value than the text read.`, readings: [
        { value: read.value, source: "plan_set", sheet: sheetOf(read, what), excerpt: read.excerpt },
        { value: String(prior.value), source: prior.evidence?.source ?? "plan_set", sheet: prior.evidence?.sheet, excerpt: prior.evidence?.excerpt },
      ] });
    }
    fields[key] = { value: read.value, confidence: 0.95, evidence: { source: "plan_set", sheet: sheetOf(read, what), excerpt: read.excerpt } };
  };
  const sameMoney = (a: unknown, b: unknown) => parseMoney(a) === parseMoney(b);
  const samePhone = (a: unknown, b: unknown) => String(a).replace(/\D/g, "").slice(-10) === String(b).replace(/\D/g, "").slice(-10);
  fill("jobValue", app.jobValue, "contract price", sameMoney);
  fill("statedValuation", app.statedValuation, "permit application (stated valuation)", sameMoney);
  fill("homeownerPhone", app.homeownerPhone, "permit application", samePhone);
  const racking = productCallout(planText, RACKING_PRODUCTS);
  if (racking) {
    fields.rackingSystem = { value: racking.value, confidence: 0.95,
      evidence: { source: "plan_set", sheet: sheetOf(racking, "racking callout"), excerpt: racking.excerpt } };
  } else if (looksLikeTitleBlock(fields.rackingSystem?.value)) {
    delete fields.rackingSystem;
  }
  const attachment = productCallout(planText, ATTACHMENT_PRODUCTS);
  if (attachment && !(fields.attachmentHardware?.value)) {
    fields.attachmentHardware = { value: attachment.value, confidence: 0.95,
      evidence: { source: "plan_set", sheet: sheetOf(attachment, "attachment callout"), excerpt: attachment.excerpt } };
  }
  return { ...result, fields, ...(conflicts.length ? { conflicts } : {}) };
}
