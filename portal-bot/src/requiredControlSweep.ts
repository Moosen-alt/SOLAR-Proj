// WHAT DID THIS FILING LEAVE BLANK? — the one question replay must never get wrong.
//
// This was a private method inside recipeAdapter, which meant the only way to find out
// whether it worked was to drive a live government portal and look at a screenshot
// afterwards. It did not work, and that is exactly how the failure was found: the first
// live replay benchmark scored PacifiCorp `replayed_clean` — "every recorded step ran and
// nothing was left blank" — on a page that was, in the portal's own red lettering, telling
// us two required fields were missing.
//
// The two misses, both general and neither PacifiCorp's fault:
//
//   1. A COMPLAINT IN A ROW THAT HOLDS MORE THAN ONE CONTROL WAS DISCARDED. The sweep
//      attributed "This field is required." only to a container holding exactly ONE control
//      — a bound added for good reason (a bare div ancestor is the whole page on some
//      layouts, and one complaint then blamed every control on it). But "Qty [18]
//      [Please select...]" is one row with two controls, which is the ordinary shape of
//      every quantity-plus-model row in every equipment table there is. The bound threw the
//      evidence away. Proximity, not container arity, is what ties a message to a field —
//      it is how a person reads the page.
//
//   2. AN ASTERISK OUTSIDE A <label for> WAS INVISIBLE. Requiredness was read from
//      `label[for=id]` only, so "Total System Export (kW) *" rendered as a plain div above
//      its input carried no requirement at all. Captions are written a dozen ways; the
//      asterisk is the marker, wherever it sits.
//
// And a floor under both: A VISIBLE COMPLAINT THE SWEEP CANNOT ATTRIBUTE IS STILL REPORTED.
// Attribution is heuristic and will meet a layout that defeats it. The portal saying "this
// field is required" is not heuristic — it is the portal refusing the filing. Losing that
// because we could not name the field is how an incomplete application reaches a reviewer
// wearing a clean bill of health.
import type { Page } from "playwright";

/** A visible required control that is still empty, named as the page names it. */
export interface EmptyRequired {
  name: string;
  /** How we know it was required — for the operator's report, and for arguing with it. */
  why: "attribute" | "asterisk" | "complaint" | "unattributed-complaint" | "radio-group";
}

/**
 * Every visible required control still empty on the current page.
 *
 * Deliberately conservative about FALSE positives: a warning that fires on a correctly
 * filled page trains the operator to ignore the warning, which is worse than not having
 * one. Every widening below is paired with a bound, and the smoke drives both directions.
 */
export async function sweepEmptyRequiredControls(page: Page): Promise<EmptyRequired[]> {
  if (!page || typeof page.evaluate !== "function") return [];
  return await page.evaluate(() => {
    // TWO GRADES OF COMPLAINT, BECAUSE ONE OF THEM IS ALSO ORDINARY PROSE.
    //
    // "This field is required" is a portal refusing a filing. "Please select an option" is
    // equally often the INSTRUCTION above a group — and portals are full of instructions.
    // Treating the second as evidence manufactures blanks on correct pages, and this sweep
    // now gates two things that must not be jammed: a benchmark verdict, and
    // pageIsPassThrough, which decides whether replay may click on. So the soft phrasings
    // must LOOK like errors — an alert role, an error-ish class, or red text — to count.
    const HARD = /this field is required|required field|field is (mandatory|required)|must be (provided|entered|selected)|cannot be (blank|empty)|is required\b/i;
    const SOFT = /please (select|enter|choose|provide|complete)/i;
    // A LEGEND IS NOT A COMPLAINT. Nearly every form carries one — "All Information
    // indicated with a red * (asterisk) is required" — and it matches `is required` exactly
    // as a real validation message does, while referring to no field at all. Ameren's live
    // run reported that sentence as a blank required field: a fabricated gap, on a page that
    // may have been complete. Legends describe the form's notation; complaints name a
    // failure. The tell is the notation talk.
    const LEGEND = /asterisk|marked with|indicat(e|es|ed|ing)|denotes?|all information|all fields|fields? marked|red \*|^\s*\*|\*\s*=|means required/i;
    const COMPLAINT = new RegExp(`${HARD.source}|${SOFT.source}`, "i");
    const PLACEHOLDER = /^(please\s+)?(select|choose)\b\.{0,3}$/i;
    const out: Array<{ name: string; why: string }> = [];
    const push = (name: string, why: string): void => {
      const clean = String(name || "").replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 70);
      if (clean && !out.some((o) => o.name === clean)) out.push({ name: clean, why });
    };

    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return !!r && (r.width > 0 || r.height > 0);
    };

    // ---- the controls in play -------------------------------------------------------
    const controls = (Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[])
      .filter((el) => {
        const t = (el.getAttribute("type") || "").toLowerCase();
        if (["hidden", "submit", "button", "checkbox", "radio", "image", "reset"].includes(t)) return false;
        return visible(el);
      });

    // ---- complaint messages, attributed by PROXIMITY --------------------------------
    // Leaf-most matching elements only: an ancestor whose text merely CONTAINS the message
    // is the container, not the message, and using it puts the anchor in the wrong place.
    const complaints = (Array.from(document.querySelectorAll("span, div, p, li, label, strong, em, small, td")) as HTMLElement[])
      .filter((el) => {
        const own = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (!own || own.length > 120 || !COMPLAINT.test(own)) return false;
        if (LEGEND.test(own)) return false;
        if (Array.from(el.children).some((c) => COMPLAINT.test(((c as HTMLElement).innerText || "")))) return false;
        if (!visible(el)) return false;
        if (HARD.test(own)) return true;
        // Soft phrasing: only an element DRESSED as an error counts. Anything else is the
        // page telling a person what to do, not evidence that they failed to do it.
        const marks = `${el.className || ""} ${el.id || ""} ${el.getAttribute("role") || ""} ${el.getAttribute("aria-live") || ""}`;
        if (/error|invalid|danger|warning|alert|validation|required/i.test(marks)) return true;
        const rgb = (getComputedStyle(el).color || "").match(/\d+/g) || [];
        const r = Number(rgb[0] || 0), g = Number(rgb[1] || 0), b = Number(rgb[2] || 0);
        return r > 110 && r > g * 1.6 && r > b * 1.6;
      });

    // IS THIS CONTROL ANSWERED? Needed before attribution, not after — see below.
    const emptyish = new Set<HTMLElement>();
    for (const el of controls) {
      const raw = ((el as HTMLInputElement).value || "").trim();
      const shown = (el.tagName || "").toLowerCase() === "select"
        ? ((((el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex] || {}).textContent) || "").trim()
        : raw;
      if (!raw || PLACEHOLDER.test(shown) || /^--/.test(shown)) emptyish.add(el);
    }

    const claimed = new Set<HTMLElement>();
    for (const c of complaints) {
      const cr = c.getBoundingClientRect();
      // AN EMPTY FIELD IS THE ONLY THING "THIS FIELD IS REQUIRED" CAN MEAN.
      //
      // Pure proximity gave the message to the wrong control and lost it: on PacifiCorp's
      // "Qty [18] [Please select...]" row the complaint sits under the row, and the QUANTITY
      // is fractionally nearer than the empty model select beside it. Attributed to a field
      // that already has a value, the complaint evaporates — which is precisely what the
      // live run did, and why a filing missing its module model scored `replayed_clean`.
      // So: consider answered controls only if no unanswered one is in range.
      let best: HTMLElement | null = null;
      let bestD = Infinity;
      for (const pass of [0, 1]) {
        for (const el of controls) {
          if (pass === 0 && !emptyish.has(el)) continue;
          const er = el.getBoundingClientRect();
          // A validation message sits BELOW or beside its field, never far above it, and
          // never in another column. Both bounds keep one complaint from claiming a page.
          const dy = cr.top - er.bottom;
          if (dy < -40 || dy > 90) continue;
          if (Math.abs(cr.left - er.left) > 420) continue;
          const d = Math.abs(dy) + Math.abs(cr.left - er.left) / 8;
          if (d < bestD) { bestD = d; best = el; }
        }
        if (best) break;
      }
      if (best) { claimed.add(best); continue; }
      // COULD NOT ATTRIBUTE IT — say so rather than drop it. The portal is refusing the
      // filing; not knowing which field is a reason to report harder, not to go quiet.
      push(`portal reports "${(c.innerText || "").replace(/\s+/g, " ").trim().slice(0, 48)}" (field could not be identified)`, "unattributed-complaint");
    }

    // ---- requiredness and emptiness -------------------------------------------------
    for (const el of controls) {
      const id = el.getAttribute("id") || "";
      const forLbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const wrapLbl = el.closest("label");
      const byAria = (el.getAttribute("aria-labelledby") || "")
        .split(/\s+/).filter(Boolean)
        .map((r) => (document.getElementById(r) || { textContent: "" }).textContent || "").join(" ");
      const labelText = [
        (forLbl && (forLbl as HTMLElement).textContent) || "",
        byAria,
        (wrapLbl && wrapLbl !== (el as unknown as Element) && (wrapLbl as HTMLElement).textContent) || "",
        el.getAttribute("aria-label") || "",
      ].map((s) => s.replace(/\s+/g, " ").trim()).find(Boolean) || "";

      // THE ASTERISK NEED NOT LIVE IN A <label>. When the control's own small container
      // holds exactly one control, that container's text is this control's caption
      // whatever element it happens to be written in.
      const container = el.closest('[class*="form-group"], [class*="field"], [class*="row"], li, tr, dd, p, div');
      const ownsOne = !!container && container.querySelectorAll("input, select, textarea").length === 1;
      const containerText = ownsOne ? ((container as HTMLElement).innerText || "").replace(/\s+/g, " ").trim() : "";
      const asterisk = /\*/.test(labelText) || (containerText.length <= 160 && /\*/.test(containerText));

      const required = el.hasAttribute("required")
        || el.getAttribute("aria-required") === "true"
        || asterisk
        || claimed.has(el);
      if (!required) continue;

      // "Filled" must mean filled. A native select resting on its placeholder reports that
      // option's text as .value, and a custom combobox is an input whose .value IS the
      // placeholder — both read as non-empty and blessed unanswered controls.
      const raw = ((el as HTMLInputElement).value || "").trim();
      const shown = (el.tagName || "").toLowerCase() === "select"
        ? ((((el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex] || {}).textContent) || "").trim()
        : raw;
      if (raw && !PLACEHOLDER.test(shown) && !/^--/.test(shown)) continue;

      const name = labelText
        || (containerText && containerText.length <= 90 ? containerText : "")
        || el.getAttribute("aria-label")
        || el.getAttribute("placeholder")
        || el.getAttribute("name")
        || "(unlabelled control)";
      push(name, claimed.has(el) ? "complaint" : el.hasAttribute("required") || el.getAttribute("aria-required") === "true" ? "attribute" : "asterisk");
    }

    // ---- unanswered required radio GROUPS -------------------------------------------
    // A single unchecked radio is not a blank; a group where nothing is checked is exactly
    // one. PGE's required "disconnect within 10 feet" pair sat unanswered while this sweep
    // reported a clean page.
    const radios = (Array.from(document.querySelectorAll("input[type=radio]")) as HTMLInputElement[])
      .filter((el) => visible(el) || !!el.closest("label"));
    const groups = new Map<string, HTMLInputElement[]>();
    for (const r of radios) {
      const key = r.getAttribute("name") || (r.getAttribute("id") || "").replace(/_\d+$/, "");
      if (!key) continue;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
    }
    for (const [, members] of groups) {
      if (members.length < 2 || members.some((r) => r.checked)) continue;
      let cont: HTMLElement | null = members[0].parentElement;
      while (cont && cont !== document.body && !members.every((r) => cont!.contains(r))) cont = cont.parentElement;
      if (!cont || cont === document.body) continue;
      const text = (cont.innerText || "").replace(/\s+/g, " ").trim();
      if (!/\*/.test(text.slice(0, 200)) && !COMPLAINT.test(text)) continue;
      push(text.replace(/\s*\*\s*/g, " ").trim(), "radio-group");
    }

    return out.slice(0, 14);
  }).catch(() => [] as Array<{ name: string; why: string }>) as EmptyRequired[];
}
