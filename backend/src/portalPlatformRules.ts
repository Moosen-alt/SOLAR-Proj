// WHICH PORTAL FAMILY IS THIS URL — the single pattern table, shared.
//
// Lifted out of portalProcessImport.ts so the knowledge-base funnel can use it too.
// portalProcessImport imports knowledgeBase, so knowledgeBase importing it back would be
// a cycle (CLAUDE.md's jobQueue/repository rule, same shape); a neutral module with no
// project imports is the fix rather than a second copy of the table that drifts.
//
// The label is human-facing (KB portal_platform) and also tells the learn engine which
// known portal family it is walking into: an AHJ on a platform we have already driven
// needs an entry URL and a login, not a fresh auto-learn.

/** Platform, inferred from the URL host. */
const PLATFORM_HOST_RULES: Array<[RegExp, string]> = [
  [/energov|tylerhost|tylertech/i, "Tyler EnerGov (CSS Self Service)"],
  [/aca[-.].*accela|accela\.com|citizenaccess/i, "Accela Citizen Access"],
  [/viewpointcloud|\.viewpoint/i, "ViewPoint Cloud (OpenGov)"],
  [/opengov\.com|portal\.opengov/i, "OpenGov"],
  [/momentum\./i, "Momentum"],
  [/etrakit|aspgov/i, "eTRAKiT"],
  [/smartgovcommunity|smartgov/i, "SmartGov"],
  [/citizenserve/i, "Citizenserve"],
  [/revize|civicplus|\.civicgov/i, "CivicPlus / Revize"],
  [/bsaonline/i, "BS&A Online"],
  [/maintstar/i, "MaintStar"],
  [/rhythm.*infor|infor.*rhythm/i, "Infor Rhythm"],
  [/permitwizard|dcra\.dc\.gov|access\.dc\.gov/i, "DC Access / PermitWizard"],
  [/ibuild/i, "iBuild"],
  [/projectdox|avolve/i, "ProjectDox (Avolve)"],
  [/solarapp/i, "SolarAPP+"],
  [/\.govconnect|govconnect/i, "GovConnect"],
  [/powerclerk/i, "PowerClerk (utility interconnection)"],
];

export function inferPlatform(url: string): string {
  for (const [re, label] of PLATFORM_HOST_RULES) if (re.test(url)) return label;
  try { return `Unknown (${new URL(url).hostname})`; } catch { return "Unknown"; }
}

export function isRecognizedPlatform(platform: string): boolean {
  return Boolean(platform) && !platform.startsWith("Unknown");
}

/** True when the value is a bare URL and nothing else — i.e. never a portal NAME. */
export function looksLikeBareUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test((value || "").trim());
}
