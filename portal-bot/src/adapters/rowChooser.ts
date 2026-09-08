// ---------------------------------------------------------------------------
// WHEN EVERY BUTTON SAYS THE SAME WORD, THE CHOICE IS IN THE ROW.
//
// Des Moines (PermitTrax) offers its permit types as a list, and every one of the twelve
// rows carries an identically-labelled button:
//
//   [SELECT]  01) RESIDENTIAL MECHANICAL PERMIT   Mechanical permit for new construction...
//   [SELECT]  03) RESIDENTIAL ELECTRICAL PERMIT   Electrical permit for new construction...
//   [SELECT]  05) RESIDENTIAL ROOFTOP PHOTOVOLTAIC PERMIT  You can apply for a RESIDENTIAL
//                                                 SOLAR permit...
//   [SELECT]  10) COMMERCIAL ELECTRICAL PERMIT    ...
//   [SELECT]  11) DEMOLITION PERMIT               ...
//
// The engine saw twelve controls all reading "SELECT", picked one with nothing to go on,
// and spent three runs wandering. There WAS a right answer on the page — row 5 says
// "RESIDENTIAL SOLAR" in plain words — and nothing was reading it, because the meaning
// lives in the row and not on the control.
//
// This is the same invariant that has already been fixed twice in narrower forms: a radio
// has no innerText and its label is a sibling; a control's identity can live in a tooltip
// or the menu it opens. Third form, so it gets a module.
//
// PICKING THE WRONG ROW FILES THE WRONG PERMIT — the exact mistake PROGRAM_EXCLUDE and the
// record-type guard exist to prevent — so a row that contradicts the filing is refused
// outright rather than ranked low, and an unrecognised list is left alone rather than
// guessed at.
// ---------------------------------------------------------------------------

/** One row of a repeated-control chooser. */
export interface RowChoice {
  /** Learn-time marker, for clicking the exact control that was scanned. */
  key: string;
  /** The control's own label — identical across the group, which is the whole problem. */
  control: string;
  /** The row's text, which is where the meaning is. */
  text: string;
}

/**
 * Runs INSIDE the page. Finds groups of controls sharing one short label and tags each with
 * its row text. Requires at least three, so an ordinary pair of buttons is never mistaken
 * for a chooser.
 */
export function scanRowChoices(): RowChoice[] {
  const vis = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    return r.width > 2 && r.height > 2 && st.visibility !== "hidden" && st.display !== "none";
  };
  document.querySelectorAll("[data-al-row]").forEach((n) => n.removeAttribute("data-al-row"));

  const controls = Array.from(document.querySelectorAll("button, a[role=button], input[type=button], input[type=submit], [role=button]"))
    .filter(vis)
    .map((el) => ({
      el,
      label: ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim(),
    }))
    .filter((c) => c.label && c.label.length <= 24);

  const byLabel = new Map<string, Array<{ el: Element; label: string }>>();
  for (const c of controls) {
    const k = c.label.toLowerCase();
    if (!byLabel.has(k)) byLabel.set(k, []);
    byLabel.get(k)!.push(c);
  }

  const out: RowChoice[] = [];
  let n = 0;
  for (const group of byLabel.values()) {
    // Three or more identical controls is a list; two is a pair of ordinary buttons.
    if (group.length < 3) continue;
    for (const c of group) {
      // Climb until the ancestor holds meaningfully more text than the control itself —
      // that is the row. Bounded so a deep tree cannot walk to <body>.
      let row: Element | null = c.el.parentElement;
      let text = "";
      for (let depth = 0; row && depth < 6; depth++) {
        const t = ((row as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
        if (t.length > c.label.length + 12) { text = t; break; }
        row = row.parentElement;
      }
      if (!text || text.length > 400) continue;
      const key = "row" + String(n++);
      c.el.setAttribute("data-al-row", key);
      out.push({ key, control: c.label, text: text.slice(0, 220) });
    }
  }
  return out;
}

/** A row naming a different trade, scale or transaction is never our filing. */
export const ROW_REFUSE =
  /\bcommercial\b|\bdemolition\b|\bdemo\b|\bfire\b|\bsign\b|\bfence\b|\bpool\b|\btemporary\b|\bre-?roof\b|\bright[\s-]?of[\s-]?way\b|\bexisting\b|\brenewal\b/i;

/** Most specific reading of "this is a residential solar permit" first. */
export const ROW_PREFER: RegExp[] = [
  /photovoltaic|\bsolar\b|\bpv\b/i,
  /\bsolar\b.{0,20}\belectrical\b|\belectrical\b.{0,20}\bsolar\b/i,
  /residential.{0,30}electrical|electrical.{0,30}residential/i,
  /\belectrical\b/i,
  /residential.{0,30}building|building.{0,30}residential/i,
];

/**
 * Choose the row that matches the filing, or undefined when nothing does.
 *
 * Refusal beats ranking: a commercial or demolition row is out even if it also says
 * "electrical", because filing under it would be the wrong permit, not merely a worse one.
 */
export function chooseRow(rows: RowChoice[], discipline?: string): RowChoice | undefined {
  const eligible = rows.filter((r) => !ROW_REFUSE.test(r.text));
  if (!eligible.length) return undefined;
  const wantsElectrical = /elec/i.test(String(discipline || ""));
  const ladder = wantsElectrical
    ? [ROW_PREFER[0], ROW_PREFER[1], ROW_PREFER[2], ROW_PREFER[3], ROW_PREFER[4]]
    : ROW_PREFER;
  for (const pattern of ladder) {
    const hit = eligible.find((r) => pattern.test(r.text));
    if (hit) return hit;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// A SEARCH THAT RETURNS RESULTS IS ANSWERED BY CLICKING A RESULT.
//
// Miami's iBuild Property Search finds the parcel and renders one row:
//
//   <td style="text-decoration: underline; color:darkblue;">3500 PAN AMERICAN DR</td>
//
// No <a>. No <button>. No onclick attribute — the grid binds the handler in script. So the
// row is invisible to the field extractor, the planner is never offered it, and the only
// submit-shaped things on the page are two <input type=submit id="btnSubmit"> that are
// display:none. The walk clicked one of those four times and stopped.
//
// The replay-side matcher already existed but required `tr.querySelector("a")` — a rule
// written for Accela, whose rows carry a "Select" link. A Telerik/Kendo/DataTables grid has
// none, and the row itself is the target.
//
// PICKING THE WRONG ROW FILES AGAINST THE WRONG PROPERTY, which is worse than not filing, so
// the same discipline as chooseRow applies: every word of the wanted address must appear in
// the row, and more than one surviving row is a refusal rather than a guess.
// ---------------------------------------------------------------------------

/** The row this pass chose, and how it will be clicked. */
export interface AddressRowPick {
  /** Row text, trimmed — for the recipe note and the run log. */
  text: string;
  /** What inside the row is actually clickable. */
  via: "link" | "button" | "cell" | "row";
  /** How many rows matched before disambiguation. >1 with a pick means `prefer` decided. */
  matched: number;
}

/**
 * Runs INSIDE the page. Marks the one results row matching `want` with data-al-rowpick="1"
 * and returns what it found; returns null when nothing matches or the choice is ambiguous.
 *
 * `prefer` is the Accela city/county tiebreak: the same address appears once per issuing
 * jurisdiction, a structural permit files with the city and an electrical one with the
 * county. Omitted, several matches are refused outright.
 */
export function markAddressRow(args: { want: string; prefer?: "city" | "county" }): AddressRowPick | null {
  // No nested function declarations — esbuild's keepNames wraps them as __name(…) and the
  // evaluate throws into a swallowed catch, which reads as "found nothing".
  const DIRECTIONS: Record<string, string> = {
    n: "north", s: "south", e: "east", w: "west",
    ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
  };
  const TYPES: Record<string, string> = {
    st: "street", ave: "avenue", av: "avenue", rd: "road", dr: "drive", ln: "lane",
    ct: "court", blvd: "boulevard", pl: "place", ter: "terrace", cir: "circle",
    hwy: "highway", pkwy: "parkway", way: "way", loop: "loop", trl: "trail",
  };
  const expand = (s: string): string[] => {
    const out: string[] = [];
    for (const raw of (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
      if (!raw) continue;
      out.push(DIRECTIONS[raw] || TYPES[raw] || raw);
    }
    return out;
  };
  const vis = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    return r.width > 2 && r.height > 2 && st.visibility !== "hidden" && st.display !== "none";
  };

  const wantWords = expand(args.want);
  if (wantWords.length < 2) return null;

  document.querySelectorAll("[data-al-rowpick]").forEach((n) => n.removeAttribute("data-al-rowpick"));

  const candidates = Array.from(document.querySelectorAll("tbody tr, table tr, [role='row'], ul li, ol li"));
  const hits: Array<{ el: Element; text: string }> = [];
  for (const el of candidates) {
    // A header is a label for the rows, not one of them — and its sort links are the only
    // <a>s in Miami's grid, so letting one through would click "sort by Address".
    if (el.closest("thead") || (el as HTMLElement).tagName === "TH") continue;
    if (el.querySelector("th") && !el.querySelector("td")) continue;
    if (!vis(el)) continue;
    // CELLS CONCATENATE WITH NOTHING BETWEEN THEM. tr.textContent on Miami's grid reads
    // "3500 PAN AMERICAN DRCITY OF MIAMI" — the suffix and the next column fuse into
    // "drcity" and the word "drive" never appears, so the row can never match. Join the
    // cells; fall back to textContent only for a row that has none.
    const cells = Array.from(el.querySelectorAll("td, th, [role='cell'], [role='gridcell']"))
      .map((c) => (c.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0);
    const text = (cells.length ? cells.join(" ") : (el.textContent || "")).replace(/\s+/g, " ").trim();
    if (text.length < 8 || text.length > 400) continue;
    const words = expand(text);
    let all = true;
    for (const w of wantWords) if (words.indexOf(w) < 0) { all = false; break; }
    if (all) hits.push({ el, text });
  }
  if (!hits.length) return null;

  // A row nested inside another matching row (grid-in-grid layouts) would count twice;
  // keep the INNERMOST, which is the one a person would click.
  const innermost = hits.filter((h) => !hits.some((o) => o !== h && h.el.contains(o.el)));
  const pool = innermost.length ? innermost : hits;

  let chosen = pool[0];
  if (pool.length > 1) {
    if (!args.prefer) return null; // ambiguous — a person should choose
    const wantCounty = args.prefer === "county";
    const matching = pool.filter((h) => /county/i.test(h.text) === wantCounty);
    if (matching.length !== 1) return null;
    chosen = matching[0];
  }

  // What inside the row actually takes the click. A link or button when there is one;
  // otherwise the cell the portal styled to look clickable — underline, pointer cursor, or
  // a colour it gave nothing else; otherwise the row.
  let target: Element = chosen.el;
  let via: AddressRowPick["via"] = "row";
  const link = Array.from(chosen.el.querySelectorAll("a[href]")).find((a) => vis(a));
  const button = Array.from(chosen.el.querySelectorAll("button, input[type='submit'], input[type='button'], [role='button']")).find((b) => vis(b));
  if (link) { target = link; via = "link"; }
  else if (button) { target = button; via = "button"; }
  else {
    const cell = Array.from(chosen.el.querySelectorAll("td, [role='cell'], [role='gridcell']")).find((c) => {
      if (!vis(c)) return false;
      const st = getComputedStyle(c as HTMLElement);
      return st.cursor === "pointer" || /underline/.test(st.textDecorationLine || st.textDecoration || "");
    });
    if (cell) { target = cell; via = "cell"; }
  }

  target.setAttribute("data-al-rowpick", "1");
  return { text: chosen.text.slice(0, 120), via, matched: pool.length };
}
