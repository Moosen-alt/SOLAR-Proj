// Public (unauthenticated) permit-status fetchers for the most common AHJ portal platforms.
//
// These run as plain HTTP requests — no Playwright, no login required. They complement
// the authenticated browser scrape (checkStatus on adapters) and the email tracker.
// Failure is silent: if the fetch fails or returns nothing useful, the caller falls back
// to the next strategy.
//
// Platform detection is by URL pattern so the operator only needs to paste the portal URL
// when setting up a permit_check_target — no manual platform selection required.
//
// SAFETY: read-only fetches only. Never submits, modifies, or pays.

export type PortalPlatform =
  | "accela"
  | "energov"
  | "projectdox"
  | "opengov"
  | "civicplus"
  | "solarapp"
  | "public_url" // generic — strip HTML and return text
  | "unknown";

/** Detect which platform a portal URL belongs to. */
export function detectPlatform(portalUrl: string): PortalPlatform {
  const u = portalUrl.toLowerCase();
  if (u.includes("accela.com") || u.includes("/Cap/Cap")) return "accela";
  if (u.includes("energov") || u.includes("tyler") || u.includes("selfservice#/permit")) return "energov";
  if (u.includes("projectdox") || u.includes("avolve")) return "projectdox";
  if (u.includes("opengov.com") || u.includes("ogov.com")) return "opengov";
  if (u.includes("civicplus") || u.includes("mgoconnect") || u.includes("mycivil")) return "civicplus";
  if (u.includes("gosolarapp") || u.includes("solarapp")) return "solarapp";
  if (u.startsWith("http")) return "public_url";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Accela Citizen Access (ACA) — most common in OR/WA/CA
// ---------------------------------------------------------------------------
// Permit numbers on Oregon ePermitting look like: 24-001234-STR, 24-001234-RS, etc.
// Accela's capID URL format splits the number into three parts.
// For jurisdictions that store the direct CapDetail link in portal_url, a plain
// GET is enough. For ones that only have the base URL, we attempt a search POST.

function parseAccelaCapId(permitNumber: string): { capID1: string; capID2: string; capID3: string } | null {
  // Try three-part dash split: "24CAP-00000-03DS7" → capID1=24CAP, capID2=00000, capID3=03DS7
  const parts = permitNumber.trim().split("-");
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    return { capID1: parts[0], capID2: parts[1], capID3: parts[2] };
  }
  // Oregon format "24-001234-STR": capID1=24, capID2=001234, capID3=STR
  if (parts.length === 3) {
    return { capID1: parts[0], capID2: parts[1], capID3: parts[2] };
  }
  return null;
}

function accelaBaseUrl(portalUrl: string): string {
  // Extract the base up to the agency path segment, e.g.
  // "https://aca-oregon.accela.com/oregon/Cap/CapHome.aspx?..."
  // → "https://aca-oregon.accela.com/oregon"
  try {
    const u = new URL(portalUrl);
    const segs = u.pathname.split("/").filter(Boolean);
    const agencyIdx = segs.findIndex((s) => /^[A-Z_]{2,20}$/i.test(s));
    const agencyPath = agencyIdx >= 0 ? "/" + segs.slice(0, agencyIdx + 1).join("/") : "";
    return `${u.protocol}//${u.host}${agencyPath}`;
  } catch {
    return portalUrl.replace(/\/Cap\/.*$/, "").replace(/\?.*$/, "");
  }
}

async function fetchAccelaStatus(portalUrl: string, applicationNumbers: string[]): Promise<string | null> {
  const base = accelaBaseUrl(portalUrl);

  // Strategy 1: if the tracking URL IS the CapDetail page, fetch it directly.
  // This is the best path — the operator pasted the exact public record link.
  // Preserve the full query string (includes agencyCode, TabName, Module, capIDs).
  if (portalUrl.toLowerCase().includes("capdetail.aspx")) {
    const text = await htmlToText(portalUrl);
    if (text && text.length > 40) return text;
  }

  // Strategy 2: construct a CapDetail URL from the application/permit number.
  // Try to extract agencyCode from the portalUrl if present.
  let agencyCodeParam = "";
  try {
    const u = new URL(portalUrl);
    const code = u.searchParams.get("agencyCode");
    if (code) agencyCodeParam = `&agencyCode=${encodeURIComponent(code)}`;
  } catch { /* ignore */ }

  for (const num of applicationNumbers) {
    if (!num) continue;
    const capId = parseAccelaCapId(num);
    if (capId) {
      const detailUrl = `${base}/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=${encodeURIComponent(capId.capID1)}&capID2=${encodeURIComponent(capId.capID2)}&capID3=${encodeURIComponent(capId.capID3)}${agencyCodeParam}`;
      const text = await htmlToText(detailUrl);
      if (text && text.length > 100) return text;
    }
  }

  // Strategy 3: public record search page (works on some ACA configurations).
  for (const num of applicationNumbers) {
    if (!num) continue;
    const searchUrl = `${base}/Cap/CapHome.aspx?module=Building&TabName=Building&capCapId=${encodeURIComponent(num)}`;
    const text = await htmlToText(searchUrl);
    if (text && text.length > 100) return text;
  }

  return null;
}

// ---------------------------------------------------------------------------
// EnerGov / Tyler Technologies Citizen Self-Service (CSS)
// ---------------------------------------------------------------------------
// CSS portals have a public permit-lookup URL like:
// https://energov.[city].gov/EnerGovProd/selfservice#/permit/<number>
// The hash fragment is client-side routed so a plain fetch won't execute JS,
// but the API behind it is often at: /api/permit/search?permitNumber=<n>
// We try both.

async function fetchEnerGovStatus(portalUrl: string, applicationNumbers: string[]): Promise<string | null> {
  for (const num of applicationNumbers) {
    if (!num) continue;

    // Try the REST API endpoint that the CSS SPA calls.
    const apiBase = portalUrl.replace(/#.*$/, "").replace(/\/selfservice.*$/, "");
    const apiUrl = `${apiBase}/api/permit/search?permitNumber=${encodeURIComponent(num)}&pageNumber=1&pageSize=5`;
    try {
      const res = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json) return JSON.stringify(json).slice(0, 3000);
      }
    } catch { /* try next */ }

    // Fallback: plain HTML fetch to the search URL.
    const searchUrl = `${apiBase}/selfservice#/permit/${encodeURIComponent(num)}`;
    const text = await htmlToText(searchUrl);
    if (text && text.length > 80) return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SolarAPP+ — instant solar permit approvals
// ---------------------------------------------------------------------------
// Permits issued via SolarAPP+ carry a SolarAPP+ application ID. The status
// API is publicly accessible when a project_id is known:
// https://api.gosolarapp.org/v1/projects/{id}/status  (requires API key)
// Fallback: their public portal shows status at gosolarapp.org

async function fetchSolarAppStatus(portalUrl: string, applicationNumbers: string[]): Promise<string | null> {
  // SolarAPP+ portal is mostly gated; plain HTML fetch is our best bet.
  return htmlToText(portalUrl);
}

// ---------------------------------------------------------------------------
// Generic public URL — parse HTML and return visible text (cheerio-powered)
// ---------------------------------------------------------------------------
export async function htmlToText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; permit-status-bot/1.0)" },
    });
    if (!res.ok) return null;
    const html = await res.text();

    const { load } = await import("cheerio");
    const $ = load(html);

    // Remove noise: scripts, styles, navigation chrome, cookie banners.
    $("script, style, noscript, nav, header, footer, iframe, svg").remove();
    $("[class*='nav' i], [class*='menu' i], [class*='cookie' i], [class*='banner' i], [id*='nav' i], [id*='menu' i]").remove();

    // Try to extract the most status-relevant section first.
    const statusSelectors = [
      "[class*='status' i]",
      "[id*='status' i]",
      "[class*='permit' i]",
      "[id*='permit' i]",
      "[class*='record' i]",
      "[class*='detail' i]",
      "main",
      "article",
      "[role='main']",
      "table",
    ];

    for (const sel of statusSelectors) {
      const el = $(sel).first();
      if (el.length) {
        const t = el.text().replace(/\s+/g, " ").trim();
        if (t.length > 80) return t.slice(0, 8000);
      }
    }

    const bodyText = $("body").text().replace(/\s+/g, " ").trim();
    return bodyText.slice(0, 8000) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
/** Try every applicable public (unauthenticated) check strategy for the given
 *  portal URL and application/permit numbers. Returns the raw status text to
 *  feed into classifyPermitStatusText(), or null if nothing useful was found. */
export async function publicPermitStatusCheck(
  portalUrl: string,
  applicationNumbers: string[],
): Promise<string | null> {
  if (!portalUrl || !applicationNumbers.some(Boolean)) return null;
  const platform = detectPlatform(portalUrl);

  switch (platform) {
    case "accela":
      return fetchAccelaStatus(portalUrl, applicationNumbers);
    case "energov":
      return fetchEnerGovStatus(portalUrl, applicationNumbers);
    case "solarapp":
      return fetchSolarAppStatus(portalUrl, applicationNumbers);
    case "projectdox":
      // ProjectDox has no public API; rely on authenticated scrape + email.
      return null;
    case "opengov":
    case "civicplus":
    case "public_url":
      return htmlToText(portalUrl);
    default:
      return null;
  }
}
