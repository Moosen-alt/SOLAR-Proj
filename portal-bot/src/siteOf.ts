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

/**
 * MAY THE CREDENTIAL SAVED FOR `storedUrl` BE TYPED AT `targetUrl`? The backend's rule
 * (selectCredentialUrlsFor, backend/src/portalCredentials.ts) for one stored URL, minus its
 * operator alias table: the hosts are equal (or one is a subdomain of the other), and when the
 * stored URL carries a first path segment the target carries the SAME one — Accela, Tyler, iWorQ
 * and SmartGov serve every jurisdiction from one host and tell them apart by that segment
 * (aca-prod.accela.com/SANDIEGO vs /LASCRUCES). The registrable domain (siteOfUrl) is NOT this
 * question: it made accela.com one site, so a run's own login went to every city on it.
 * siteOf.test.ts pins this against the backend's function over a table.
 */
export function sameCredentialScope(targetUrl: string, storedUrl: string): boolean {
  const host = (u: string): string => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
  const seg = (u: string): string => { try { return (new URL(u).pathname.split("/").filter(Boolean)[0] ?? "").toLowerCase(); } catch { return ""; } };
  const a = host(targetUrl);
  const b = host(storedUrl);
  if (!a || !b) return false;
  if (!(a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`))) return false;
  const stored = seg(storedUrl);
  return stored === "" || seg(targetUrl) === stored;
}

/** The host of a URL, lower-case; "" when it cannot be parsed. */
export function hostOfUrl(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}
