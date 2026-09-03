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
      const label = ((el as HTMLElement).innerText || el.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim();
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

/** A rebate/incentive/enrolment programme is never the interconnection application. */
export const PROGRAM_EXCLUDE = /rebate|incentive|enroll|enrol|renew|amend|withdraw|cancel|close|back|help/i;

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
export function chooseProgram(groups: ProgramGroup[]): ProgramOption | undefined {
  const ranked = (Array.isArray(groups) ? groups.slice() : []).sort((a, b) => a.area - b.area);
  for (const group of ranked) {
    const eligible = (group.options || []).filter((o) => o && typeof o.label === "string" && !PROGRAM_EXCLUDE.test(o.label));
    for (const re of PROGRAM_PREFER) {
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
