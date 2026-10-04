// WHEN A PORTAL PRINTS THE FORMAT IT WANTS, USE IT.
//
// PacifiCorp's account field is labelled "Customer's account number - please use this format:
// xxxxxxxx xxx x". The bill prints "90000000-004 0" and intake stored "90000000-0040", so the
// submission was rejected with that field named. The digits were right the whole time; only
// the grouping was wrong, and the portal had already said what the grouping should be.
//
// This is deliberately conservative. It re-groups the SAME characters and never invents,
// drops or reorders one: if the value does not have exactly as many alphanumerics as the mask
// has slots, the original is returned untouched. Getting an account number subtly wrong is
// worse than leaving it in the format we were given, because a wrong-but-plausible number can
// attach a filing to somebody else's account.

/** Pull a format mask out of a label, e.g. "…format: xxxxxxxx xxx x" -> "xxxxxxxx xxx x". */
export function extractFormatMask(label: string): string {
  const m = String(label || "").match(/format\s*:?\s*([xX#0-9]+(?:[ \-/.]+[xX#0-9]+)+)/);
  if (!m) return "";
  const mask = m[1].trim();
  // A mask has to be mostly placeholder characters; "format: 2024 or later" is not a mask.
  const slots = (mask.match(/[xX#]/g) || []).length;
  return slots >= 4 ? mask : "";
}

/**
 * Re-group `value` to match a mask stated in `label`. Returns the value unchanged when there
 * is no mask, when the mask does not fit, or when it would alter the characters themselves.
 */
export function applyFormatHint(value: string, label: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  const mask = extractFormatMask(label);
  if (!mask) return raw;

  const chars = raw.replace(/[^A-Za-z0-9]/g, "");
  const slots = (mask.match(/[xX#]/g) || []).length;
  // Only a value that fits the mask exactly is re-grouped. Too few or too many characters
  // means this is not the thing the mask describes, and padding or truncating an account
  // number is how a filing lands on the wrong account.
  if (chars.length !== slots) return raw;

  let out = "";
  let i = 0;
  for (const ch of mask) {
    if (/[xX#]/.test(ch)) { out += chars[i++]; continue; }
    out += ch; // the separator the portal asked for
  }
  return out;
}
