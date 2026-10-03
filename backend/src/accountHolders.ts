// WHO THE INTERCONNECTION APPLICATION NAMES (operator ruling 2026-09-28, a joint PGE account).
//
// A utility bill's customer block can list more than one account holder ("ROBIN L SAMPLE / DURWOOD
// W SAMPLE"). The ruling: "Durwood is good seeing as they're listed. If they're not listed then
// primary name on the bill will apply for the NEM." So:
//   - the plan-set owner is the NEM applicant whenever they are one of the holders the bill lists
//     (named as the bill prints them — the utility matches its own spelling);
//   - otherwise the bill's PRIMARY (first-listed) holder is;
//   - no bill holder on file: the homeowner (the fallback resolveRecipeFieldValues always had).
// The permit tracks keep the property owner; only the utility's customer block reads this.
const TITLE = /^(?:mr|mrs|ms|miss|dr|prof|rev)\.?\s+/i;

const nameTokens = (s: string): string[] =>
  String(s ?? "").toLowerCase().replace(/[.,]/g, " ").replace(/[^a-z\s'-]/g, " ").split(/\s+/)
    .filter((t) => t && !/^(mr|mrs|ms|miss|dr|prof|rev|jr|sr|ii|iii|iv)$/.test(t));

/** The same person: same surname, and the FIRST given names agree (equal, or one is the other's
 *  initial). A middle initial never stands in for a given name ("Lance Sample" is not "Robin L
 *  Sample"), and a shared surname alone is a spouse. */
function samePerson(a: string, b: string): boolean {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (x.length < 2 || y.length < 2) return false;
  if (x[x.length - 1] !== y[y.length - 1]) return false;
  const [gx, gy] = [x[0], y[0]];
  return gx === gy || (gx.length === 1 && gy.startsWith(gx)) || (gy.length === 1 && gx.startsWith(gy));
}

// IS THIS BILL READ A HOLDER AT ALL? (#28, a live PNM bill read as "Pnm.Com".)
// A bill prints more than the customer block: the utility's name and logo, its website, a
// payment email, phone numbers, the remit-to address and a dozen labels. Any of them can come
// back as "the account holder" — from the text parser's top-of-bill name fallback or from the
// vision read — and downstream every reader trusted it: the reviewer gate told the operator the
// NEM application would name "Pnm.Com", and nemApplicantName would have put it there. So a read
// is a holder only when it is none of those. A rejected read is treated as NO holder (the field
// stays empty and the reviewer asks to verify), never as a name. Mirrored for the parser page in
// frontend/parser-review.js isBillHolderName — keep the two in step (billHolderName.test pins both).
const TLD = "com|net|org|gov|edu|us|coop|biz|info|energy|co|io";
const WEB = new RegExp(`@|https?:|\\bwww\\.|[a-z0-9-]\\.(?:${TLD})\\b`, "i");
// Labels a bill prints near the customer block. Whole phrases, so a person named "Bill" or
// "Service" still passes; a read that CONTAINS one ("Account Summary for J SAMPLE") is a label
// line, not a clean holder, and is rejected too: verify beats a wrong name on an application.
const BILL_BOILERPLATE = new RegExp([
  "account (?:summary|number|no|holder|name|information|activity|balance|details?)",
  "service (?:address|location|period|agreement|for|from|to)",
  "amount (?:due|enclosed|paid)", "(?:payment|total) due", "due (?:date|by)",
  "billing (?:date|period|summary|address|statement)", "statement (?:date|period)", "bill date",
  "your (?:balance|bill|account|usage|energy)", "customer (?:service|name|number|care|information)",
  "remit(?:tance)?", "pay (?:online|by|your bill)", "p\\.? ?o\\.? box", "presort", "postage", "questions",
  "meter (?:number|reading|read)", "kwh", "(?:electric|energy|utility) (?:bill|service|statement|usage)",
  "new charges", "previous balance", "current charges", "autopay", "paperless", "thank you",
].map((p) => `\\b${p}\\b`).join("|"), "i");
const words = (s: string): string[] => String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** True when `value` can be a utility bill's account holder: a person or business, not the
 *  utility's web address / email / phone / an address or number line / the utility's own name
 *  (`utility`, the project's utility, whole words either way: "EXAMPLE UTILITY" on an Example
 *  Utility job, but never "Japsen" on an APS job) / bill boilerplate. */
export function isBillHolderName(value: string | null | undefined, utility?: string | null): boolean {
  const v = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!/[a-z]/i.test(v)) return false;
  if (WEB.test(v) || /\d/.test(v) || BILL_BOILERPLATE.test(v)) return false;
  const u = words(String(utility ?? ""));
  if (u.length) {
    const h = words(v);
    if (h.every((t) => u.includes(t)) || u.every((t) => h.includes(t))) return false;
  }
  return true;
}

/** The account holders a bill's customer block lists, in printed order. "A / B", "A & B", "A and B",
 *  "A; B" and one per line all split; "JOHN & JANE SMITH" gives "JOHN SMITH", "JANE SMITH" (a
 *  given-name-only part takes the shared surname of the last full name). A "SMITH, JOHN" block
 *  stays one person. */
export function billHoldersOf(text: string | null | undefined): string[] {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const parts = raw
    .split(/\s*(?:\/|&|\+|;|\n|\band\b)\s*/i)
    .map((p) => p.replace(TITLE, "").trim())
    .filter(Boolean);
  if (parts.length <= 1) return parts;
  const last = parts[parts.length - 1].split(/\s+/);
  const surname = last.length >= 2 ? last[last.length - 1] : "";
  return parts.map((p) => (surname && p.split(/\s+/).length === 1 ? `${p} ${surname}` : p));
}

/** Is this person one of the holders the bill lists? Returns that holder as the bill prints it. */
export function listedHolderFor(billHolderText: string | null | undefined, person: string | null | undefined): string | null {
  const who = String(person ?? "").trim();
  if (!who) return null;
  return billHoldersOf(billHolderText).find((h) => samePerson(who, h)) ?? null;
}

/** The name the NEM application's customer block carries (the ruling above). */
export function nemApplicantName(billHolderText: string | null | undefined, homeownerName: string | null | undefined, utility?: string | null): string {
  // A read that is not a holder at all (isBillHolderName) is no holder: the homeowner, never "Pnm.Com".
  if (!isBillHolderName(billHolderText, utility)) billHolderText = "";
  const holders = billHoldersOf(billHolderText);
  const owner = String(homeownerName ?? "").trim();
  if (!holders.length) return owner;
  // ONE holder: the bill's name exactly as printed (title and all — the account-name field should
  // match the bill; the first/last split drops the title), whoever the plan set names.
  if (holders.length === 1) return String(billHolderText ?? "").replace(/\s+/g, " ").trim();
  return listedHolderFor(billHolderText, owner) ?? holders[0];
}
