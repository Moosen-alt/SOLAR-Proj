// ---------------------------------------------------------------------------
// APPLICATION PROGRAMME CHOICE — the screen between "new application" and a form.
//
// Some portals answer the entry click with a drawer/dialog whose FIRST screen is not a
// form but a CHOICE of which programme to apply under. ComEd's Intellio Connect offers
// "Distributed Generation" and "Distributed Generation Rebates"; no field exists until one
// is picked, so a learn that ignores the choice reports "nothing fillable" while standing
// on it (live: 6 pages, 4 planner calls, no steps recorded).
//
// Two invariants, both learned the hard way:
//
//   SCOPE BY THE TIGHTEST GROUPING, NEVER BY DOCUMENT. The live page carried ~80 elements
//   matching [class*='drawer'] (drawer__title, drawer__content, ...) and the first attempt
//   took "the last visible panel" — an element holding no controls at all, so the pass
//   found nothing and returned silently. Worse, a document-wide scan finds the HEADER's
//   application-category switcher, whose label is the SAME TEXT as the real option; picking
//   it opens a menu instead of an application. So: consider each visible candidate
//   container, keep those offering >= 2 distinct options, and prefer the SMALLEST — the
//   radiogroup itself rather than the drawer that contains it, let alone the page.
//
//   A REBATE IS NOT AN INTERCONNECTION. Choosing the wrong programme files the wrong thing
//   entirely — the wrong-permit-type mistake in another costume — so a rebate/incentive
//   option is never eligible, and a drawer offering nothing that reads as an interconnection
//   or generation application is REFUSED rather than guessed at.
//
// Exported as one module (not inlined in the adapter) so the smoke test drives the SAME
// code the live run does. The previous version duplicated the logic into the test, and the
// hand-written fixture drifted from the portal: the test passed while the live run failed.
// ---------------------------------------------------------------------------

/** One selectable programme inside a candidate container. */
export interface ProgramOption {
  /** Learn-time marker attribute value, for clicking the exact element that was scanned. */
  key: string;
  label: string;
  /** True when the control (or a descendant) carries role=radio — see programSelector. */
  radio: boolean;
}

/** A visible container that offers two or more distinct options. */
export interface ProgramGroup {
  /** Rendered area in px^2; the tightest qualifying grouping wins. */
  area: number;
  options: ProgramOption[];
}

/**
 * Runs INSIDE the page (passed to page.evaluate). Self-contained by necessity: it is
 * serialized across the CDP boundary and cannot close over module scope.
 *
 * Tags every option it finds with data-al-prog so the caller can click the exact element
 * that was scanned rather than re-resolving by text.
 */
export function scanProgramGroups(): ProgramGroup[] {
  const vis = (e: Element): boolean => {
    const r = (e as HTMLElement).getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  // Deliberately broad — the point is a revealed panel, not one vendor's class names.
  const CONTAINER = [
    "mat-button-toggle-group",
    "[role='radiogroup']",
    "[role='listbox']",
    // A CHOICE IS NOT ALWAYS IN A DRAWER. Prince George's County (Momentum) asks which kind
    // of thing you are applying for on a PLAIN PAGE: <fieldset><legend>Pick a record
    // type.</legend> with two radios. Scoping only to revealed panels made that invisible,
    // and the learn clicked "Save & Continue" nine times against a gate it never answered.
    "fieldset",
    "mat-drawer",
    "mat-sidenav",
    "mat-dialog-container",
    "[role='dialog']",
    ".cdk-overlay-pane",
    ".modal.show",
    "[class*='drawer']",
    "[class*='new-application']",
  ].join(", ");
  const CONTROL = [
    "mat-button-toggle",
    "[role='radio']",
    "[role='option']",
    "input[type='radio']",
    "button",
    "a[role='button']",
  ].join(", ");

  const groups: ProgramGroup[] = [];
  let n = 0;
  for (const panel of Array.from(document.querySelectorAll(CONTAINER))) {
    if (!vis(panel)) continue;
    const rect = (panel as HTMLElement).getBoundingClientRect();
    const options: ProgramOption[] = [];
    for (const el of Array.from(panel.querySelectorAll(CONTROL))) {
      if (!vis(el)) continue;
      // AN <input> HAS NO innerText. A radio's name lives in its <label for=...>, which is a
      // SIBLING, not a descendant — so reading innerText returned "" and every radio-based
      // chooser was skipped silently. Momentum's is exactly this shape. Resolve the label
      // the way a browser's accessibility tree does: explicit label, wrapping label,
      // aria-label, aria-labelledby, then the control's own text.
      const labelFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const wrapping = el.closest("label");
      const labelledBy = (el.getAttribute("aria-labelledby") || "")
        .split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      const label = (
        (el as HTMLElement).innerText ||
        (labelFor as HTMLElement | null)?.innerText ||
        (wrapping && wrapping !== el ? (wrapping as HTMLElement).innerText : "") ||
        el.getAttribute("aria-label") ||
        labelledBy ||
        ""
      ).replace(/\s+/g, " ").trim();
      if (!label || label.length > 60) continue;
      // A toggle and the <button> inside it both match; keep the OUTER one, so the offered
      // list reads like what a person sees rather than each option twice.
      if (options.some((o) => o.label === label)) continue;
      // The role lives on the INNER button (the outer mat-button-toggle is
      // role="presentation"), so look at the element AND its descendants — otherwise the
      // recorded step falls back to a bare text match that collides with page chrome.
      const radio =
        el.getAttribute("role") === "radio" ||
        (el as HTMLInputElement).type === "radio" ||
        !!el.querySelector("[role='radio'], input[type='radio']");
      const key = "ap" + String(n++);
      (el as HTMLElement).setAttribute("data-al-prog", key);
      options.push({ key, label, radio });
    }
    if (options.length >= 2) groups.push({ area: Math.round(rect.width * rect.height), options });
  }
  return groups;
}

/**
 * A rebate/incentive/enrolment programme is never the interconnection application.
 *
 * EVERY TERM IS ANCHORED ON WORD BOUNDARIES, and that is the whole point of this comment.
 * The list was written as bare substrings, which quietly refused the likeliest name a
 * solar programme can have:
 *
 *   "Renewable Energy Interconnection"  matched `renew`   -> EXCLUDED
 *   "Renewable Energy Systems"          matched `renew`   -> EXCLUDED
 *   "Solar Photovoltaic - Renewable"    matched `renew`   -> EXCLUDED
 *   "Backflow Prevention"               matched `back`    -> EXCLUDED
 *   "Enclosed Structure Permit"         matched `close`   -> EXCLUDED
 *   "Closed Loop Geothermal"            matched `close`   -> EXCLUDED
 *
 * On any portal calling its programme "Renewable Energy …" — which is what a great many
 * utilities call exactly the thing we are filing — the chooser found NO eligible option
 * and the learn could not enter the application at all. An exclusion list that rejects the
 * target is worse than no exclusion list, because it fails in the direction that looks
 * like a portal problem.
 *
 * "renew" must therefore match Renew and Renewal and never Renewable.
 *
 * "close" is narrower still: the ACTION, never the adjective. "Close Out Permit" is a
 * lifecycle transaction and excluded; "Closed Loop Geothermal" is the name of a thing you
 * can apply for and is not. Bare "Closed" as a programme option does not occur — you do
 * not start a closed application — so nothing is lost by requiring the verb.
 */
export const PROGRAM_EXCLUDE =
  /\brebate|\bincentive|\benrol{1,2}(ment)?\b|\brenew(al|als|ing)?\b|\bamend|\bwithdraw|\bcancel|\bclose\b|\bclosing\b|close[\s-]?out|\bback\b|\bhelp/i;

/** Most specific reading of "this is the interconnection application" first. */
export const PROGRAM_PREFER: RegExp[] = [
  /interconnect|net.?meter|\bnem\b/i,
  /solar|photovoltaic|\bpv\b/i,
  /distributed generation|\bdg\b/i,
  /generation/i,
];

/**
 * Picks the programme from the scanned groups, tightest qualifying container first.
 * Returns undefined when nothing reads as an interconnection/generation application —
 * an unrecognised drawer is left alone, never guessed at.
 */
/**
 * What an AHJ calls the thing you are applying for. The utility list above is useless on a
 * permit portal: Prince George's County offers "City Requests" and "Licenses & Permits", and
 * a chooser that only knows interconnection words refuses both — correctly by its own rules,
 * and uselessly for the run it is on.
 */
export const PROGRAM_PREFER_PERMIT: RegExp[] = [
  /licen[cs]e.{0,4}(and|&|\/).{0,4}permit|permit.{0,4}(and|&|\/).{0,4}licen[cs]e/i,
  /\bbuilding\b|\bconstruction\b|\btrade\b|\belectrical\b/i,
  /\bpermit(s)?\b/i,
  /\blicen[cs]e(s)?\b/i,
];

/**
 * Picks the programme from the scanned groups, tightest qualifying container first.
 *
 * `discipline` is the track this run is on (the project's permitType — "electrical",
 * "structural", or empty for a utility run). It decides which VOCABULARY leads: an
 * interconnection application and a building permit are different questions, and a chooser
 * that knows only one of them refuses the other. Both lists are still tried, so a portal
 * that words things unusually is not lost — only the ORDER changes.
 *
 * Returns undefined when nothing reads as something we came here to apply for; an
 * unrecognised choice is left alone rather than guessed at.
 */
export function chooseProgram(groups: ProgramGroup[], discipline?: string): ProgramOption | undefined {
  const permitTrack = /elec|struct|build|permit|mech|plumb/i.test(String(discipline || ""));
  const lists = permitTrack
    ? [...PROGRAM_PREFER_PERMIT, ...PROGRAM_PREFER]
    : [...PROGRAM_PREFER, ...PROGRAM_PREFER_PERMIT];
  const ranked = (Array.isArray(groups) ? groups.slice() : []).sort((a, b) => a.area - b.area);
  for (const group of ranked) {
    const eligible = (group.options || []).filter((o) => o && typeof o.label === "string" && !PROGRAM_EXCLUDE.test(o.label));
    for (const re of lists) {
      const hit = eligible.find((o) => re.test(o.label));
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Every distinct label that was offered, for a diagnosable refusal. */
export function offeredLabels(groups: ProgramGroup[]): string[] {
  const seen: string[] = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const o of g.options || []) {
      if (o && typeof o.label === "string" && !seen.includes(o.label)) seen.push(o.label);
    }
  }
  return seen;
}

/**
 * How the choice is recorded for replay. BY LABEL, never by position — a programme chosen
 * by index is the mechanical-permit mistake in another costume. Scoped by role where the
 * DOM gives one, because the bare text "Distributed Generation" also matches the header's
 * category switcher on ComEd's own page.
 */
export function programSelector(pick: ProgramOption): {
  text?: string;
  role?: string;
  name?: string;
  fallbacks: Array<{ role?: string; name?: string; text?: string }>;
} {
  if (pick.radio) {
    return {
      role: "radio",
      name: pick.label,
      fallbacks: [{ role: "button", name: pick.label }, { text: pick.label }],
    };
  }
  return {
    text: pick.label,
    fallbacks: [{ role: "button", name: pick.label }, { role: "radio", name: pick.label }],
  };
}
