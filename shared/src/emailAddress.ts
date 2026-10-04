// "IS THERE AN OWNER EMAIL ON FILE" — ONE predicate (#71).
//
// The homeowner-email box on every entry page (parser, dashboard, new project) saves its raw
// `.value`; nothing enforced `type="email"`, so a name typed (or autofilled) into it was stored as
// the email. Every reader then asked only "is the string non-empty": the reviewer's
// `reviewer.submit.homeowner-email` callout stayed silent, the intake link did not ask, and the
// recipe field resolution / PowerClerk adapter would have typed the name into the utility's Email
// box. Every door now asks this instead, so a non-email reads exactly like no email.
//
// Deliberately loose — a shape check, not RFC 5322: one "@", something before it, a dotted domain
// after it, no whitespace. It exists to tell an address from a name or a phone number, never to
// reject an unusual but real address. It does refuse what would be wrong TYPED into an Email box
// as-is (#92): a "mailto:" link, angle brackets, a colon, a trailing dot. firstEmail unwraps the
// first two, since the address inside them is real.

const EMAIL_SHAPE = /^[^\s@<>:]+@[^\s@<>:]+\.[^\s@<>:.]+$/;

/** "mailto:a@b.co" / "<a@b.co>" → "a@b.co"; anything else trimmed as-is. */
const unwrap = (value: string): string => value.trim().replace(/^mailto:/i, "").replace(/^<([^<>]*)>$/, "$1").trim();

/** True when `value` (trimmed) has the shape of an email address. */
export function looksLikeEmail(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return EMAIL_SHAPE.test(value.trim());
}

/** The first of `values` that looks like an email address, trimmed; "" when none does. */
export function firstEmail(...values: unknown[]): string {
  for (const v of values) if (typeof v === "string" && looksLikeEmail(unwrap(v))) return unwrap(v);
  return "";
}
