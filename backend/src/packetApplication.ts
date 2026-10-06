import type { ParserLlmExtraction } from "../../shared/src/types";
import { parseMoney } from "./valuation";

// THE PACKET'S OWN APPLICATION PAGE (#201). Installers often bind the city's signed permit
// application (an e-signature form with a text layer) or the customer contract into the plan
// set. That page STATES the job's contract value and the homeowner's phone — the two things the
// reviewer otherwise calls out as missing ("using a per-watt estimate", "Homeowner phone
// missing"), and the estimate is what the 40% valuation and every valuation-laddered fee then
// key on. This reads them deterministically off the text the parser page already posts
// (/api/parser/llm-extract), page by page, so the value cites its source page.
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

interface PlanPage { page: number | null; text: string }

/** The parser page joins pages as "--- PAGE n ---" (OCR pages "--- OCR PAGE n ---"). */
export function splitPlanPages(planText: string): PlanPage[] {
  const marker = /---\s*(?:OCR\s+)?PAGE\s+(\d+)\s*---/gi;
  const hits = [...planText.matchAll(marker)];
  if (!hits.length) return [{ page: null, text: planText.replace(/\s+/g, " ") }];
  return hits.map((m, i) => ({
    page: Number(m[1]),
    text: planText.slice(m.index! + m[0].length, i + 1 < hits.length ? hits[i + 1].index : planText.length).replace(/\s+/g, " "),
  }));
}

// A permit application or a contract page — its heading, not a passing mention in plan notes.
const APPLICATION_PAGE = /\b(?:(?:BUILDING|ELECTRICAL|SOLAR|PV|RESIDENTIAL|PHOTOVOLTAIC|CONSTRUCTION)\s+)*PERMIT\s+APPLICATION\b|\bAPPLICATION\s+FOR\s+(?:A\s+)?(?:BUILDING|ELECTRICAL|SOLAR|CONSTRUCTION)?\s*PERMIT\b|\b(?:SOLAR|PV|HOME\s+IMPROVEMENT|INSTALLATION|PURCHASE|CUSTOMER)\s+(?:INSTALLATION\s+|PURCHASE\s+|SALES\s+)?(?:AGREEMENT|CONTRACT)\b/i;

// "Job value $27,500" / "Contract Price: 27,500.00" / "Valuation of work $ 31,200". The number
// must follow the label with nothing but ":", "#", "$" or spaces between — a blank template
// line ("Job Value ________") never reaches a later number on the page.
const MONEY_LABEL = String.raw`(?:(?:TOTAL\s+)?(?:JOB|PROJECT|CONTRACT|CONSTRUCTION)\s+(?:VALUE|VALUATION|PRICE|AMOUNT|COST)|(?:VALUATION|VALUE)\s+OF\s+(?:THE\s+)?WORK|TOTAL\s+(?:CONTRACT\s+)?(?:PRICE|COST)\s+OF\s+(?:THE\s+)?(?:SYSTEM|PROJECT|WORK))`;
const MONEY = new RegExp(String.raw`\b${MONEY_LABEL}\s*(?:\(\s*\$\s*\))?\s*[:#]?\s*(\$\s*)?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d{3,7}(?:\.\d{2})?)(?![\d,]|\s*[-.)]\s*\d{3,4}\b)`, "gi");

// The homeowner's phone: an OWNER-labelled phone ("Owner phone", "Property owner telephone #"),
// or a "Phone" inside the page's OWNER block (from an owner heading to the next contractor /
// applicant heading) — never the contractor's or the applicant's.
const PHONE = String.raw`(\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4})(?!\d)`;
const PHONE_LABEL = String.raw`(?:PHONE|TEL(?:EPHONE)?|CELL|MOBILE)(?:\s*(?:NUMBER|NO\.?|#))?\s*[:#]?\s*`;
const OWNER_PHONE = new RegExp(String.raw`\b(?:PROPERTY\s+)?(?:HOME\s?)?OWNER(?:'?S)?\s+${PHONE_LABEL}${PHONE}`, "gi");
const OWNER_BLOCK = /\b(?:PROPERTY\s+OWNER|HOMEOWNER|OWNER)(?:\s+(?:INFORMATION|INFO|DETAILS))?\b\s*[:-]?([\s\S]{0,300})/gi;
const BLOCK_END = /\b(?:CONTRACTOR|APPLICANT|AGENT|INSTALLER|DESIGNER|ENGINEER|COMPANY)\b/i;
const BLOCK_PHONE = new RegExp(String.raw`\b${PHONE_LABEL}${PHONE}`, "i");

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : raw.trim();
}

const sheetOf = (p: { page: number | null }, what: string) => (p.page != null ? `Page ${p.page} (${what})` : what);

export interface PacketApplicationRead {
  jobValue?: { value: number; page: number | null; excerpt: string };
  homeownerPhone?: { value: string; page: number | null; excerpt: string };
}

/** The stated contract value and homeowner phone on the packet's application / contract page(s). */
export function readPacketApplication(planText: string): PacketApplicationRead {
  const values: { value: number; page: number | null; excerpt: string }[] = [];
  const phones: { value: string; page: number | null; excerpt: string }[] = [];
  for (const p of splitPlanPages(planText)) {
    if (!APPLICATION_PAGE.test(p.text)) continue;
    for (const m of p.text.matchAll(MONEY)) {
      const amount = parseMoney(m[2]);
      // A job is thousands of dollars; a bare "Job value 100" is a page artefact, not a contract.
      if (amount == null || amount < 1000 || amount > 5_000_000) continue;
      values.push({ value: amount, page: p.page, excerpt: m[0].slice(0, 100) });
    }
    const pagePhones: { value: string; excerpt: string }[] = [];
    for (const m of p.text.matchAll(OWNER_PHONE)) pagePhones.push({ value: formatPhone(m[1]), excerpt: m[0] });
    if (!pagePhones.length) {
      for (const b of p.text.matchAll(OWNER_BLOCK)) {
        const m = BLOCK_PHONE.exec(b[1].split(BLOCK_END)[0]);
        if (m) pagePhones.push({ value: formatPhone(m[1]), excerpt: m[0] });
      }
    }
    for (const ph of pagePhones) phones.push({ ...ph, page: p.page, excerpt: ph.excerpt.slice(0, 100) });
  }
  const out: PacketApplicationRead = {};
  if (new Set(values.map((v) => v.value)).size === 1) out.jobValue = values[0];
  if (new Set(phones.map((v) => v.value)).size === 1) out.homeownerPhone = phones[0];
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
  const app = readPacketApplication(planText);
  if (app.jobValue) {
    fields.jobValue = { value: app.jobValue.value, confidence: 0.95,
      evidence: { source: "plan_set", sheet: sheetOf(app.jobValue, "permit application / contract"), excerpt: app.jobValue.excerpt } };
  }
  if (app.homeownerPhone) {
    fields.homeownerPhone = { value: app.homeownerPhone.value, confidence: 0.95,
      evidence: { source: "plan_set", sheet: sheetOf(app.homeownerPhone, "permit application / contract"), excerpt: app.homeownerPhone.excerpt } };
  }
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
  return { ...result, fields };
}
