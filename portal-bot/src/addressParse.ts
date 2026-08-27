// Street-address parsing for portal address-search forms (Accela ACA and kin), pure and
// browser-free so BOTH sides of a recipe can share it: the learn/stage adapters that fill
// the search form live, and the backend's resolveRecipeFieldValues that binds the same
// values at replay (a recorded recipe must never replay the LEARN project's address).
// Live-verified against Oregon ePermitting (originally in oregonEPermitting.ts).

// The street LINE only — the part before the first comma. projectAddress is stored as
// "925 N Grant St, Lafayette, OR, 97127"; everything after the first comma is city/state/zip
// and must not leak into the street-number/name/direction parsing (it returns zero results).
function streetLine(address: string): string {
  return (address || "").split(",")[0].trim();
}

export function parseStreetNumber(address: string): string {
  return streetLine(address).split(/\s+/)[0] ?? "";
}

const STREET_DIRECTIONS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west"]);
const STREET_SUFFIXES = new Set([
  "st", "street", "ave", "avenue", "blvd", "boulevard", "rd", "road", "dr", "drive",
  "ln", "lane", "ct", "court", "way", "pl", "place", "ter", "terrace", "cir", "circle",
  "hwy", "highway", "pkwy", "parkway", "loop", "trl", "trail",
]);
const clean = (w: string) => w.toLowerCase().replace(/[.,]/g, "");

// Accela's "Street Name" search field wants the CORE name only — e.g. "925 N Grant St" must
// be searched as "Grant" (the leading direction and trailing street-type suffix belong in
// separate fields). Including them returns zero results, which silently breaks the flow.
export function parseStreetName(address: string): string {
  const parts = streetLine(address).split(/\s+/);
  parts.shift(); // remove street number
  if (parts.length > 1 && STREET_DIRECTIONS.has(clean(parts[0]))) parts.shift(); // leading direction
  const unitKeywords = new Set(["apt", "unit", "ste", "suite", "#"]);
  const unitIdx = parts.findIndex((p) => unitKeywords.has(p.toLowerCase()));
  let core = unitIdx === -1 ? parts : parts.slice(0, unitIdx);
  // strip trailing street-type suffix and/or trailing direction (e.g. "Grant St", "Main St NW")
  while (core.length > 1 && (STREET_SUFFIXES.has(clean(core[core.length - 1])) || STREET_DIRECTIONS.has(clean(core[core.length - 1])))) {
    core = core.slice(0, -1);
  }
  return core.join(" ");
}

// Leading directional (N/S/E/W) of the street, for Accela's separate direction dropdown.
export function parseStreetDirection(address: string): string {
  const parts = streetLine(address).split(/\s+/);
  parts.shift(); // street number
  return parts.length > 1 && STREET_DIRECTIONS.has(clean(parts[0])) ? parts[0].toUpperCase().replace(/[.,]/g, "") : "";
}
