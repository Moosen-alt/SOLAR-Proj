// ---------------------------------------------------------------------------
// THE CONSENT BANNER IS NOT NAVIGATION, AND DECLINING IS THE DEFAULT.
//
// Des Moines (PermitTrax) walked into /citizen/CookiePolicy/ on three separate runs and
// spent its whole budget there. The run's own log finally named the control it followed:
//
//   navigate_chosen page 2  label: "SELECT"  dashboard: true  ->  /citizen/CookiePolicy/
//   navigate_chosen page 3  label: "Close"
//
// "SELECT" is the granular-choice button on the cookie consent banner. The legal-page
// exclusion added earlier could never have caught it: the label carries no legal wording,
// and a planner looking at a dashboard full of buttons has no way to know that one of them
// is a privacy dialog rather than a way forward.
//
// Two things are true at once, and the fix has to honour both:
//
//   1. The banner blocks the run. Every portal shows one now, and since each portal got its
//      own fresh browser profile, EVERY visit is a first visit.
//   2. It asks a real question about the operator's privacy. Clicking "Accept" to get on
//      with the job answers that question on their behalf, in the direction that suits us
//      and not them.
//
// So this declines. Reject / Decline / Necessary-only if the banner offers one; failing
// that a plain Close or dismiss, which consents to nothing; and if the only way through is
// "Accept", it does NOTHING and leaves the banner standing. A run blocked by a consent
// dialog is a much smaller problem than a bot that accepts tracking for someone else — and
// the overlay neutraliser already handles a banner that merely covers a control.
//
// Self-contained by necessity: serialized across the CDP boundary, no module scope.
// ---------------------------------------------------------------------------

/** What the pass did, for the run log. Empty when no consent banner was present. */
export interface ConsentOutcome {
  /** The control that was tagged, or "" when nothing was clicked. */
  clicked: string;
  /** "declined" | "closed" | "accept-only-refused" | "" */
  how: string;
}

/**
 * Runs INSIDE the page. Finds a cookie/consent banner and tags the most privacy-preserving
 * control on it as `data-al-consent`. Returns what it chose and why.
 */
export function planConsentDismissal(): ConsentOutcome {
  const none: ConsentOutcome = { clicked: "", how: "" };
  document.querySelectorAll("[data-al-consent]").forEach((n) => n.removeAttribute("data-al-consent"));

  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    return r.width > 2 && r.height > 2 && st.visibility !== "hidden" && st.display !== "none";
  };

  // A consent banner says what it is. Requiring the WORDING keeps this off ordinary dialogs.
  const CONSENT_TEXT = /\bcookies?\b|\bconsent\b|\btracking\b|privacy preferences|we use .{0,30}cookies/i;
  // Ordered by how little is given away.
  const DECLINE = [
    /^(reject|decline)( all)?( cookies)?$/i,
    /^(only )?(strictly )?necessary( cookies)?( only)?$/i,
    /^essential( cookies)?( only)?$/i,
    /^(use )?necessary cookies only$/i,
    /\breject all\b|\bdecline all\b/i,
    /^\s*(reject|decline|deny|refuse)\b/i,
  ];
  // Closing consents to nothing, which beats accepting.
  const CLOSE = [/^(close|dismiss|no thanks|not now|×|x)$/i, /^close\b/i];
  // Never clicked. Listed so the intent is unmistakable to the next reader.
  const ACCEPT = /^(accept|allow|agree|ok|got it|i understand|continue)\b|\ballow all\b|\baccept all\b/i;

  const candidates = Array.from(document.querySelectorAll(
    "[id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i], [aria-label*=cookie i], [role=dialog], .modal, [class*=banner i]",
  )).filter(visible);

  for (const banner of candidates) {
    const text = ((banner as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
    if (!text || !CONSENT_TEXT.test(text)) continue;

    const controls = Array.from(banner.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]"))
      .filter(visible)
      .map((el) => ({
        el,
        label: ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ").trim(),
      }))
      .filter((c) => c.label && c.label.length < 40);
    if (!controls.length) continue;

    for (const pattern of DECLINE) {
      const hit = controls.find((c) => pattern.test(c.label));
      if (hit) { hit.el.setAttribute("data-al-consent", "1"); return { clicked: hit.label, how: "declined" }; }
    }
    for (const pattern of CLOSE) {
      const hit = controls.find((c) => pattern.test(c.label));
      if (hit) { hit.el.setAttribute("data-al-consent", "1"); return { clicked: hit.label, how: "closed" }; }
    }
    // Only an affirmative on offer. Consenting on the operator's behalf is not ours to do.
    if (controls.some((c) => ACCEPT.test(c.label))) {
      return { clicked: "", how: "accept-only-refused" };
    }
  }
  return none;
}
