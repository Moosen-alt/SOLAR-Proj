// ONE ANSWER TO "CAN A PERSON SEE THIS CONTROL" AND "MAY THE ENGINE DRIVE IT".
//
// Two notions of visible coexisted and each call site picked one. Playwright's isVisible() counts
// an opacity:0 control and a 1x1 control as VISIBLE (both can receive events); the diagnostic a
// human reads called them hidden. A styled widget's real <input> is exactly that shape, so every
// new call site was a new door onto the same failure:
//   - 391b3b3: Ameren's terms box — the click landed on the concealed input, nothing listened;
//     the handler is on the LABEL. Click what a person clicks.
//   - c56a732, afba4a3, 90ed1c3: Ameren 73/75 -> 2/75 three separate ways in one day — name
//     scoring picked the visible decoration, a strict check fired rescues that swapped the hidden
//     input out, and the force decision asked Playwright instead of us.
//   - 14d1cef: a dropdown widget's BACKING input is meant to be invisible; its face is the control.
//   - d09b131: among duplicates, the one a person can see.
// And an off-screen (left:-9999px) control read as visible to BOTH old checks.
//
// So there are two questions, answered together by one in-page function:
//   visible — a person can see it: a real box (> 2x2 px), not display:none / visibility:hidden /
//             opacity 0 (its own or an ancestor's), not clipped away (clip-path inset(50%),
//             clip rect(0..), an overflow-hidden ancestor collapsed to <= 2px), not off the
//             scrollable document.
//   usable  — the engine may drive it, and HOW: `via: "self"` when it is visible; `via: "label"`
//             for a concealed checkbox/radio whose <label> a person can see (click the label, or
//             drive the input with force); `via: "widget-face"` for a dropdown widget's hidden
//             backing input whose visible face is the control. Never usable when disabled
//             (itself, a disabled <fieldset>, aria-disabled) or aria-hidden / inert (commonly the
//             page behind an open modal).
// An element that cannot be read at all is reported `known: false` — never as a confident
// "hidden" or "visible" (an unknown must not read as reassurance).
import type { ElementHandle, Locator } from "playwright";

export type UsableVia = "self" | "label" | "widget-face" | "none";

export interface VisibilityVerdict {
  /** False when the element could not be read (detached, evaluate threw). */
  known: boolean;
  visible: boolean;
  usable: boolean;
  via: UsableVia;
  /** Why it is not visible / not usable (empty when visible and usable via self). */
  reasons: string[];
}

/**
 * Runs IN THE PAGE. Self-contained: no helper declared inside it, so bundlers add no __name
 * wrappers and it needs no shim (visibility.dom.smoke.ts runs it in a page WITHOUT the shim).
 */
export function visibilityVerdictInPage(el: Element): VisibilityVerdict {
  const reasons: string[] = [];
  if (!el || !el.isConnected) return { known: false, visible: false, usable: false, via: "none", reasons: ["detached"] };
  const win = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;

  // ---- visible: the element's own box and every ancestor's style ----------------------------
  let visible = true;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 2 || rect.height <= 2) { visible = false; reasons.push(`box ${Math.round(rect.width)}x${Math.round(rect.height)}`); }
  if (rect.width > 0 && rect.height > 0 && (rect.right + win.scrollX <= 0 || rect.bottom + win.scrollY <= 0)) { visible = false; reasons.push("off-screen (outside the scrollable document)"); }
  for (let a: Element | null = el; a && a.nodeType === 1; a = a.parentElement) {
    const cs = win.getComputedStyle(a);
    const who = a === el ? "itself" : `ancestor <${a.tagName.toLowerCase()}>`;
    if (cs.display === "none") { visible = false; reasons.push(`display:none (${who})`); break; }
    if (a === el && cs.visibility !== "visible") { visible = false; reasons.push(`visibility:${cs.visibility}`); }
    if (Number(cs.opacity) === 0) { visible = false; reasons.push(`opacity 0 (${who})`); }
    if (/inset\(\s*50%/.test(cs.clipPath || "")) { visible = false; reasons.push(`clip-path ${cs.clipPath} (${who})`); }
    if (/^rect\(/.test(cs.clip || "")) {
      const n = (cs.clip.match(/-?\d+(\.\d+)?/g) || []).map(Number);
      if (n.length === 4 && (n[2] - n[0] <= 2 || n[1] - n[3] <= 2)) { visible = false; reasons.push(`clip ${cs.clip} (${who})`); }
    }
    if (a !== el && /(hidden|clip)/.test(`${cs.overflow} ${cs.overflowX} ${cs.overflowY}`)) {
      const ar = a.getBoundingClientRect();
      if (ar.width <= 2 || ar.height <= 2) { visible = false; reasons.push(`inside a collapsed overflow-hidden ${who}`); }
    }
  }

  // ---- usable: disabled / inert first, then how a concealed control is driven ---------------
  const input = el as HTMLInputElement;
  const disabled = input.disabled === true
    || el.getAttribute("aria-disabled") === "true"
    || !!(el.closest("fieldset[disabled]") && !el.closest("fieldset[disabled] > legend"));
  const ariaHidden = !!el.closest("[aria-hidden='true']");
  const inert = !!el.closest("[inert]");
  if (disabled) reasons.push("disabled");
  if (ariaHidden) reasons.push("aria-hidden");
  if (inert) reasons.push("inert");

  let via: UsableVia = "none";
  if (!disabled && !ariaHidden && !inert) {
    if (visible) via = "self";
    else if (input.type === "checkbox" || input.type === "radio") {
      // A styled checkbox: the real input is concealed, the LABEL is what a person clicks.
      const labels = Array.from(input.labels || []);
      if (labels.some((l) => {
        const r = l.getBoundingClientRect();
        const s = win.getComputedStyle(l);
        return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility === "visible" && Number(s.opacity) !== 0
          && !l.closest("[aria-hidden='true'], [inert]");
      })) via = "label";
    } else {
      // A dropdown widget's backing input: hidden by design; its visible face is the control.
      // (The rule autoLearnAdapter.hasVisibleWidgetFaceInPage applies; visibility.dom.smoke.ts
      // pins the two to the same answer.)
      const wrap = el.closest('[class*="dropdown"], [class*="combobox"], [class*="t-widget"], [class*="k-widget"], [class*="select2"], [class*="chosen"]');
      const face = wrap ? wrap.querySelector('.t-input, .k-input, [class*="-input"], [class*="dropdown-wrap"], [class*="rendered"]') : null;
      if (face && (face as HTMLElement).offsetParent !== null) via = "widget-face";
      else {
        // select2 / chosen keep the native <select> OUTSIDE the widget, as its previous sibling.
        const sib = el.nextElementSibling;
        if (sib && /(^|\s)(select2-container|chosen-container)/.test(sib.className || "") && (sib as HTMLElement).offsetParent !== null) via = "widget-face";
      }
    }
    if (via === "none") reasons.push("not visible, and no visible label or widget face drives it");
  }
  return { known: true, visible, usable: via !== "none", via, reasons };
}

type Target = Locator | ElementHandle<Element> | null | undefined;

/** The verdict for a locator (its FIRST match) or an element handle. Never throws: an element
 *  that cannot be read comes back known:false. */
export async function visibilityOf(target: Target, opts: { timeoutMs?: number } = {}): Promise<VisibilityVerdict> {
  const unknown = (why: string): VisibilityVerdict => ({ known: false, visible: false, usable: false, via: "none", reasons: [why] });
  if (!target) return unknown("no element");
  try {
    const t = target as Locator;
    if (typeof t.first === "function" && typeof t.count === "function") {
      if ((await t.count()) === 0) return unknown("no element matches");
      return await t.first().evaluate(visibilityVerdictInPage, undefined, { timeout: opts.timeoutMs ?? 2_000 });
    }
    return await (target as ElementHandle<Element>).evaluate(visibilityVerdictInPage);
  } catch (e) {
    return unknown(`unreadable: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 120)}`);
  }
}

/** A person can see it. */
export async function isTrulyVisible(target: Target): Promise<boolean> {
  return (await visibilityOf(target)).visible;
}

/** The engine may drive it (visibly, or through its label / widget face). */
export async function isUsable(target: Target): Promise<boolean> {
  return (await visibilityOf(target)).usable;
}
