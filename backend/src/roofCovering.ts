// WHAT IS THE ROOF COVERED WITH — ONE PREDICATE.
//
// Tile roofs are coming (FL / CA / AZ, operator heads-up 2026-09-26) and the backend had no tile
// handling at all: bcdChecklistFacts left a tile roof's roofing row blank, permitPath's Oregon
// screen only knew membranes (so a tile roof in Oregon cleared the screen and routed
// PRESCRIPTIVE — the wrong application), and nothing asked how a tile roof is attached.
//
// Every module that asks "what covering is this?" asks it here, so the BCD 5952 row, the permit
// path screen and the gate cannot disagree (one question, one predicate). Order matters: TILE is
// tested FIRST, because the plan-set wording that shows up on tile jobs routinely carries a
// shingle / shake / flat word too ("concrete shake tile", "flat tile", "tile shingle") — and a
// tile roof must never collapse into composition shingle or wood shake.

export type RoofFamily = "tile" | "membrane" | "metal" | "composition" | "wood" | "unknown";

export interface RoofCovering {
  family: RoofFamily;
  /** Tile only: "Concrete", "Clay", "S-tile", "Flat tile", or a " / "-join ("Concrete / S-tile").
   *  "" when the documents name tile without a subtype. */
  subtype: string;
}

const TILE = /\b(?:s[-\s]?tiles?|tiles?|barrel|spanish\s+tile|mission\s+tile)\b/i;
const MEMBRANE = /\b(tpo|epdm|pvc|membrane|torch|built[-\s]?up|bur|tar|gravel|foam|spf|rolled|mod(ified)?[-\s]?bit(umen)?)\b/i;

/** Tile subtype words found in the text (material, then profile). */
export function tileSubtype(text: string): string {
  const t = String(text ?? "");
  const parts: string[] = [];
  if (/\bconcrete\b/i.test(t)) parts.push("Concrete");
  if (/\b(clay|terra[-\s]?cotta)\b/i.test(t)) parts.push("Clay");
  if (/\bs[-\s]?tiles?\b|\bspanish\s+tile\b|\bbarrel\b|\bmission\s+tile\b/i.test(t)) parts.push("S-tile");
  else if (/\bflat\s+(?:concrete\s+|clay\s+)?tiles?\b/i.test(t)) parts.push("Flat tile");
  return parts.join(" / ");
}

export function classifyRoofCovering(material: unknown, subtypeHint: unknown = ""): RoofCovering {
  const m = String(material ?? "").trim();
  const hint = String(subtypeHint ?? "").trim();
  const both = `${m} ${hint}`;
  if (TILE.test(both)) return { family: "tile", subtype: tileSubtype(both) };
  if (!m) return { family: "unknown", subtype: "" };
  if (MEMBRANE.test(m)) return { family: "membrane", subtype: "" };
  if (/metal|standing[-\s]?seam|corrugated/i.test(m)) return { family: "metal", subtype: "" };
  if (/compos|asphalt|comp\b|shingle/i.test(m) && !/\b(wood|cedar|shake)\b/i.test(m)) return { family: "composition", subtype: "" };
  if (/\b(wood|cedar|shake)\b/i.test(m)) return { family: "wood", subtype: "" };
  return { family: "unknown", subtype: "" };
}

/** OREGON'S ROOFING ROW (ORSC / BCD 440-5952): "roofing is metal, single-layer wood shingles or
 *  shakes, or no more than two layers of composition shingles". true = the covering qualifies,
 *  false = it does not (tile, membrane, a third comp layer, a second wood layer), null = unknown
 *  (no material, or a layer count the documents do not state). bcdChecklistFacts fills the
 *  checklist row from it and permitPath's Oregon screen routes on it — the same answer twice. */
export function oregonRoofingRowQualifies(material: unknown, subtype: unknown, layers: unknown): boolean | null {
  const covering = classifyRoofCovering(material, subtype).family;
  const m = String(layers ?? "").trim().match(/^\s*(\d+(?:\.\d+)?)/);
  const n = m ? Number(m[1]) : null;
  if (!String(material ?? "").trim() && covering !== "tile") return null;
  if (covering === "tile" || covering === "membrane") return false;
  if (covering === "metal") return true;
  if (covering === "composition") return n == null ? null : n <= 2;
  if (covering === "wood") return n == null ? null : n <= 1;
  return null;
}

export type TileAttachmentMethod = "tile hook" | "tile-replacement mount" | "comp-out";

/** How a tile roof is attached, from the plan text: a tile hook (the tile is notched / lifted and
 *  a hook passes under it), a tile-replacement mount (a tile is swapped for a flashed metal
 *  replacement tile), or a comp-out (tiles removed and the mount flashed onto a composition patch).
 *  Every method found is returned with its quote — more than one is a question, not a pick. */
export function tileAttachmentFromText(text: string): Array<{ method: TileAttachmentMethod; quote: string }> {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const out: Array<{ method: TileAttachmentMethod; quote: string }> = [];
  const probe = (method: TileAttachmentMethod, re: RegExp) => {
    const m = re.exec(t);
    if (m) out.push({ method, quote: t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim() });
  };
  probe("tile hook", /\btile[-\s]+hooks?\b|\bhook\s+(?:mount|attachment)s?\s+(?:for|on)\s+tile\b/i);
  probe("tile-replacement mount", /\btile[-\s]+replacement(?:\s+(?:mounts?|flashings?|bases?|tiles?))?\b|\breplacement\s+tile\s+(?:mounts?|flashings?)\b/i);
  probe("comp-out", /\bcomp[-\s]?outs?\b|\bcomposition\s+(?:shingle\s+)?(?:patch|cut[-\s]?out)\b/i);
  return out;
}

/** A normalised method from a parsed field value ("Tile Hook", "tile replacement", "comp out"). */
export function tileAttachmentMethodOf(value: unknown): TileAttachmentMethod | "" {
  const hits = tileAttachmentFromText(String(value ?? ""));
  return hits.length === 1 ? hits[0].method : "";
}

/** Typical installed weight of a tile covering (psf) — the floor a structural calc's roof dead
 *  load must reach before it can be said to include the tile. Concrete / clay tile weigh roughly
 *  9-12 psf; composition shingle ~2-4. A stated roof dead load under this on a tile job reads
 *  like a shingle-roof calc. */
export const TILE_MIN_ROOF_DEAD_LOAD_PSF = 9;

/** Roof (not PV) dead loads stated in the text: "ROOF DEAD LOAD: 15 PSF", "ROOF DL = 10 psf",
 *  "EXISTING ROOFING 10 PSF". PV / module / array dead loads are excluded. */
export function statedRoofDeadLoads(text: string): Array<{ psf: number; quote: string }> {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const out: Array<{ psf: number; quote: string }> = [];
  const re = /\b(?:(?:existing\s+)?roof(?:ing)?\s+(?:dead\s+load|d\.?\s?l\.?)|existing\s+roofing(?:\s+weight)?|roof\s+(?:covering|tile)\s+(?:weight|load))\s*[:=]?\s*(\d+(?:\.\d+)?)\s*psf\b/gi;
  for (const m of t.matchAll(re)) {
    const before = t.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
    if (/\b(pv|module|array|panel)s?\s*$/i.test(before)) continue;
    out.push({ psf: Number(m[1]), quote: t.slice(Math.max(0, (m.index ?? 0) - 20), (m.index ?? 0) + m[0].length + 20).trim() });
  }
  return out;
}
