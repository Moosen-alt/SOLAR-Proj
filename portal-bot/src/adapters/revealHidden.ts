// ---------------------------------------------------------------------------
// PRESENT BUT SHUT — the fourth time, so this time as a rule.
//
// A control the portal requires is routinely in the page and not visible, because the thing
// CONTAINING it is closed. It has cost four separate fixes:
//
//   Accela        a record type inside an unticked category checkbox
//   Momentum      a collapsed nav, then "Licenses & Permits" — a gate the run skipped as
//                 hidden on three consecutive pages, clicked advance, and never moved. Four
//                 pages of budget spent re-reading the same URL.
//   PermitTrax    SIGN IN inside a closed dropdown behind a text-less icon
//   ComEd         a programme choice inside a drawer, and a radio with no innerText
//
// The engine's rule was: not visible, skip. That is right for a decorative or genuinely
// dead input — a display:none date field once cost 137 seconds of Playwright waiting — and
// wrong for the common case, where invisible means "nobody has opened this yet".
//
// So: before skipping, look for what is holding it shut and open that. Bounded, best-effort,
// and it never invents a control — if nothing plausibly opens the container, the field is
// skipped exactly as before.
//
// The page-side function is self-contained by necessity: it is serialized across the CDP
// boundary and cannot close over module scope.
// ---------------------------------------------------------------------------

/** What a reveal attempt found, for the run log. Empty `opener` means nothing was tried. */
export interface HiddenRevealPlan {
  /** Human-readable description of the control that should open the container. */
  opener: string;
  /** Why the field was invisible, for the trail. */
  why: string;
}

/**
 * Runs INSIDE the page. Finds the element tagged `data-al-hidden-target`, works out what is
 * concealing it, and tags the control that would open it as `data-al-reveal`.
 *
 * Returns a plan describing what it tagged, or empty strings when nothing plausible exists —
 * which is the honest answer for a field that is simply not meant to be filled.
 */
export function planHiddenReveal(): HiddenRevealPlan {
  const target = document.querySelector("[data-al-hidden-target]");
  const none: HiddenRevealPlan = { opener: "", why: "" };
  if (!target) return none;
  document.querySelectorAll("[data-al-reveal]").forEach((n) => n.removeAttribute("data-al-reveal"));

  const concealed = (el: Element): boolean => {
    const st = getComputedStyle(el as HTMLElement);
    if (st.display === "none" || st.visibility === "hidden") return true;
    if ((el as HTMLElement).hasAttribute("hidden")) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width < 2 || r.height < 2;
  };

  // Walk up to the nearest ancestor that is actually the thing hiding it.
  let container: Element | null = target.parentElement;
  let why = "";
  for (let depth = 0; container && depth < 10; depth++) {
    if (container.tagName === "DETAILS" && !(container as HTMLDetailsElement).open) { why = "inside a closed <details>"; break; }
    if (concealed(container)) { why = `inside a hidden <${container.tagName.toLowerCase()}>`; break; }
    container = container.parentElement;
  }
  if (!container || !why) return none;

  const describe = (el: Element): string =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} "${((el as HTMLElement).innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40)}"`;

  const tag = (el: Element, note: string): HiddenRevealPlan => {
    el.setAttribute("data-al-reveal", "1");
    return { opener: `${describe(el)} (${note})`, why };
  };

  // 1. A <details> is opened by its own <summary>.
  if (container.tagName === "DETAILS") {
    const summary = container.querySelector("summary");
    if (summary) return tag(summary, "summary of a closed details");
  }

  const id = container.id;
  // 2. Something that explicitly says it controls this container. The strongest signal
  //    there is, and the one an accessible portal provides on purpose.
  if (id) {
    const byControls = document.querySelector(`[aria-controls="${CSS.escape(id)}"]`);
    if (byControls) return tag(byControls, "aria-controls");
    const byTarget = document.querySelector(
      `[data-bs-target="#${CSS.escape(id)}"], [data-target="#${CSS.escape(id)}"], a[href="#${CSS.escape(id)}"]`,
    );
    if (byTarget) return tag(byTarget, "data-target/href");
  }

  // 3. A collapsed toggle immediately before the container — the shape a hand-rolled
  //    accordion takes when nobody wired up aria.
  const prev = container.previousElementSibling;
  if (prev) {
    const toggle = prev.matches("button, summary, [role=button], a")
      ? prev
      : prev.querySelector("button, summary, [role=button], a");
    if (toggle && !concealed(toggle)) return tag(toggle, "toggle preceding the hidden container");
  }

  // 4. A toggle inside the container's own header, for the layout where the opener sits
  //    inside the thing it opens.
  const header = container.querySelector(":scope > button, :scope > summary, :scope > [role=button], :scope > .card-header, :scope > .panel-heading");
  if (header && !concealed(header)) {
    const btn = header.matches("button, summary, [role=button]") ? header : header.querySelector("button, [role=button]");
    if (btn && !concealed(btn)) return tag(btn, "toggle in the container's header");
  }

  return { opener: "", why };
}

/**
 * THE INPUT IS HIDDEN ON PURPOSE AND THE LABEL IS ITS HANDLE.
 *
 * A different shape from a closed container, and the commoner one. Momentum's record-type
 * gate is a plain visible fieldset:
 *
 *   <fieldset><legend>Pick a record type.</legend>
 *     <input id="radio-license" class="input-radio" type="radio" name="radio-options">
 *     <label for="radio-license">Licenses &amp; Permits</label>
 *
 * Nothing conceals it. The NATIVE input is styled out of sight — the universal way to draw
 * a custom radio or checkbox — and the label is what a person clicks. isVisible() is false,
 * so the run skipped the gate on three consecutive pages, clicked advance, and never moved.
 * planHiddenReveal found no opener because there is no closed container to open.
 *
 * Tags the visible label as `data-al-reveal` and returns its text. Restricted to radios and
 * checkboxes: those are the controls this styling trick applies to, and a hidden text input
 * with a visible label is a genuinely different situation that should still be skipped.
 */
export function planLabelProxy(): string {
  const target = document.querySelector("[data-al-hidden-target]") as HTMLInputElement | null;
  if (!target) return "";
  const type = (target.type || "").toLowerCase();
  if (type !== "radio" && type !== "checkbox") return "";
  document.querySelectorAll("[data-al-reveal]").forEach((n) => n.removeAttribute("data-al-reveal"));

  const visible = (el: Element | null): boolean => {
    if (!el) return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    return r.width > 2 && r.height > 2 && st.visibility !== "hidden" && st.display !== "none";
  };

  // The explicit association first — it is the one the browser itself uses.
  const byFor = target.id ? document.querySelector(`label[for="${CSS.escape(target.id)}"]`) : null;
  const wrapping = target.closest("label");
  for (const label of [byFor, wrapping]) {
    if (!visible(label)) continue;
    label!.setAttribute("data-al-reveal", "1");
    return ((label as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 60);
  }
  return "";
}
