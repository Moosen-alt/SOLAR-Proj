/** Registrable-domain-ish key of a URL: the last two host labels (three under a two-letter
 *  second level such as co.uk), the whole host for an IP or a single-label host, "" when the URL
 *  cannot be parsed. ONE answer for "is this the same site?" — replay's goto gate (rule 5) and the
 *  learner's credential binding both ask it. */
export function siteOfUrl(url: string): string {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return ""; }
  if (!host || /^\d+(\.\d+){3}$/.test(host) || host === "localhost" || !host.includes(".")) return host;
  const parts = host.split(".");
  const n = parts.length >= 3 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join(".");
}

/** The host of a URL, lower-case; "" when it cannot be parsed. */
export function hostOfUrl(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}
