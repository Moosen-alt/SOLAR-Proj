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

// THE STREET LINE, WHOLE. City/state/zip removed, nothing else.
//
// The three parsers above all SUBTRACT, and they are right to: Accela's work-location search
// splits an address across Street No / Direction / Street Name / Suffix boxes, and putting
// "Grant St" in the name box returns zero results. But the same subtraction applied to a
// portal with ONE combined address box is how Miami's iBuild spent a whole walk searching
// "3500 Pan American" and then "Pan American" for a property its own database holds as
// "3500 PAN AMERICAN DR" — the suffix is what the search matches on, and dropping it turns
// a hit into "Property Address not found."
//
// How much of an address to strip depends on how many boxes the portal splits it into. This
// is the un-stripped form, for the portals that ask for the whole thing.
export function parseStreetLine(address: string, city?: string): string {
  let line = streetLine(address);
  if (line && city) {
    const esc = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    line = line.replace(new RegExp(`\\s+${esc}(\\s+[A-Za-z]{2})?(\\s+\\d{5}(-\\d{4})?)?\\s*$`, "i"), "").trim() || line;
  }
  return line;
}

// DOES THIS FORM SPLIT THE ADDRESS, OR ASK FOR IT WHOLE?
//
// The question the truncation correction turns on. Accela's work-location search puts the
// house number, direction, street name and suffix in four separate controls and wants the
// CORE name in the name box; Miami's iBuild has one box and wants the whole line. Same
// project address, opposite right answers, and the only way to tell them apart is the
// controls the page is showing.
//
// Reads split only on a control that could hold a PIECE of a street address: a street/house
// NUMBER box, a street TYPE/SUFFIX control, or a street DIRECTION control. Never on
// "Street Address" or "Property Address", which are the combined case. A bare "Suffix" is
// the street suffix; "Name Suffix" (Jr./Sr.) on a contact block is not, so the bare form
// must match the whole label.
//
// Erring toward "split" is the safe direction: it declines the correction and leaves the
// planner's choice alone, which is today's behaviour.
export function isSplitAddressForm(labels: Array<string | undefined>): boolean {
  return labels.some((raw) => {
    const label = (raw || "").replace(/\s+/g, " ").trim();
    if (!label) return false;
    if (/^suffix$/i.test(label)) return true;
    return /(street|house)\s*(no\.?\b|num\b|number\b)|street\s*(type|suffix|direction)\b/i.test(label);
  });
}

const normalizeAddr = (s: string): string => (s || "").toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();

/** A planner fill, as far as this correction cares. */
export interface AddressFillCandidate { value: string; field?: string }

// A COMBINED ADDRESS BOX GETS THE WHOLE STREET LINE.
//
// The planner is offered `street` (whole), `streetNumber`, `streetNameCore` (suffix and
// leading direction removed) and `streetNameSearchPortion` (first three characters) — a
// dictionary written for Accela's split form, with nothing in it that says which one a
// single search box wants. On Miami it picked the split-form keys and the search failed
// every time, then failed differently as it picked a shorter one.
//
// So decide it here instead of hoping: on a page with no separate street-number box and no
// street-type/direction control, a fill holding a TRUNCATION of the street line is expanded
// to the whole line and rebound to `street` (a recipe is shared across projects — the value
// must stay bound, never frozen as this project's literal).
//
// Only ever an EXPANSION. The correction is refused unless the full line actually contains
// what the planner chose, so this can add the missing "DR" but can never swap one address
// for another. Split forms are left completely alone: their core-name behaviour is
// live-verified against Oregon ePermitting and is correct there.
export function correctTruncatedAddressFill(
  fill: AddressFillCandidate,
  ctx: { fullStreetLine: string; projectAddress: string; splitForm: boolean },
): AddressFillCandidate | null {
  if (ctx.splitForm) return null;
  const full = (ctx.fullStreetLine || "").trim();
  if (!full) return null;
  const value = (fill.value ?? "").trim();
  const fullNorm = normalizeAddr(full);
  if (!value && fill.field !== "streetNameCore" && fill.field !== "streetNameSearchPortion") return null;
  if (value && normalizeAddr(value) === fullNorm) return null; // already whole

  const core = parseStreetName(ctx.projectAddress);
  const number = parseStreetNumber(ctx.projectAddress);
  const truncations = [core, core.slice(0, 3), `${number} ${core}`, `${number} ${core.slice(0, 3)}`]
    .map(normalizeAddr)
    .filter((t) => t.length > 0 && t !== fullNorm);

  const byKey = fill.field === "streetNameCore" || fill.field === "streetNameSearchPortion";
  const byValue = value.length > 0 && truncations.includes(normalizeAddr(value));
  if (!byKey && !byValue) return null;
  // Expansion only: whatever the planner chose has to be part of the whole line.
  if (value && !fullNorm.includes(normalizeAddr(value))) return null;
  return { value: full, field: "street" };
}
