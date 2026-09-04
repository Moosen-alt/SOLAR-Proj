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
