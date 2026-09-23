// ---------------------------------------------------------------------------
// ON-SCREEN CAPTIONS FOR THE ACT 4 RECORDING.
//
// Injected by the recorder with context.addInitScript, never served by the portal: the
// fictional portal stays a portal, and the narration is visibly the recorder's.
//
// Built so the replay engine cannot trip over it:
//   · a CLOSED shadow root, so no querySelectorAll the engine runs can see its text or
//     mistake it for a field, a modal or a button;
//   · pointer-events:none, so it never intercepts a click (Playwright's hit test passes
//     through it);
//   · an id/class that matches none of clearPageOverlays' scrim selectors.
// The page gets bottom padding equal to the bar so nothing the engine needs sits under it.
//
// What it says comes from three places: a headline per page (by pathname), a live "now"
// line driven by the page's own focus/change events (so it narrates whatever the engine is
// actually doing, without hooking the engine), and a final message the recorder sets once
// the engine has stopped.
// ---------------------------------------------------------------------------

export interface CaptionScene {
  headline: string;
  sub: string;
}

export const CAPTION_FOOTER =
  "Fictional portal running on this laptop. The replay engine and the stop-before-submit are the product's real code.";

export const FINAL_CAPTION =
  "Stopped at the review screen. A person reviews and submits — the automation cannot click submit.";

export const CAPTION_SCENES: Record<string, CaptionScene> = {
  "/": { headline: "Act 4 · The real replay engine, on a portal that isn't real", sub: "Demo Utility Co is fictional and runs only on this laptop. Watch the product file a synthetic project into it — and stop before submit." },
  "/intro": { headline: "Act 4 · The real replay engine, on a portal that isn't real", sub: "Demo Utility Co is fictional and runs only on this laptop. Watch the product file a synthetic project into it — and stop before submit." },
  "/login": { headline: "Step 1 of 6 · Sign in", sub: "The product's own login flow finds the form and signs in — with a fixture-only test login, not a stored credential." },
  "/home": { headline: "Step 2 of 6 · Open a new application", sub: "From here the engine replays a recorded recipe: steps captured once, replayed for every project after." },
  "/apply/customer": { headline: "Step 3 of 6 · Customer information", sub: "Every value is bound from the project record (a synthetic homeowner), not from what was typed when the recipe was recorded." },
  "/apply/service": { headline: "Step 4 of 6 · Service address", sub: "Street, city, state and ZIP come from the same project record." },
  "/apply/system": { headline: "Step 5 of 6 · Generation system", sub: "Manufacturer first, then its model list loads — the engine waits for the cascade and takes only an exact model." },
  "/apply/documents": { headline: "Step 6 of 6 · Documents", sub: "The project's own plan set and one-line diagram, attached from its document set." },
  "/apply/review": { headline: "Review screen reached", sub: "The engine reads the summary back against the project, then stops." },
  "/apply/submit": { headline: "SUBMITTED — this must never appear in a demo recording", sub: "The recorder refuses to keep any video that reaches this page." },
};

/** The init script, as a string for context.addInitScript({ content }). */
export function captionInitScript(scenes: Record<string, CaptionScene> = CAPTION_SCENES, footer = CAPTION_FOOTER): string {
  return `(() => {
  if (window.__demoCaption) return;
  const SCENES = ${JSON.stringify(scenes)};
  const FOOTER = ${JSON.stringify(footer)};
  const SECRET = /account|meter|password|ssn/i;
  let els = null;
  let pending = null;
  const state = { headline: "", sub: "", now: "", tone: "normal" };
  const paint = () => {
    if (!els) return;
    els.headline.textContent = state.headline;
    els.sub.textContent = state.sub;
    els.now.textContent = state.now;
    els.bar.setAttribute("data-tone", state.tone);
  };
  const labelFor = (el) => {
    if (!el) return "";
    const id = el.id;
    let text = "";
    if (id) { const l = document.querySelector('label[for="' + id + '"]'); if (l) text = l.textContent || ""; }
    if (!text && el.closest) { const l = el.closest("label"); if (l) text = l.textContent || ""; }
    return (text || el.name || id || "").replace(/\\*/g, "").replace(/\\s+/g, " ").trim();
  };
  const mount = () => {
    if (els || !document.body) return;
    const host = document.createElement("div");
    host.id = "__demo_recording_captions";
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = \`
<style>
  .bar { font-family: "Segoe UI", system-ui, Arial, sans-serif; background: rgba(12,12,16,.9); color: #fff;
         padding: 12px 28px 10px; border-top: 3px solid #ffd23f; }
  .bar[data-tone="final"] { border-top-color: #57d27a; background: rgba(10,30,16,.94); }
  .bar[data-tone="alarm"] { border-top-color: #ff4d4d; background: rgba(60,0,0,.94); }
  .headline { font-size: 24px; font-weight: 700; line-height: 1.25; }
  .sub { font-size: 16px; opacity: .92; margin-top: 3px; line-height: 1.35; }
  .now { font-size: 15px; color: #ffd23f; margin-top: 5px; min-height: 20px; font-family: Consolas, "Cascadia Mono", monospace; }
  .bar[data-tone="final"] .now { color: #9ff0b5; }
  .footer { font-family: "Segoe UI", system-ui, Arial, sans-serif; background: #000; color: #cfcfd6; font-size: 13px;
            padding: 5px 28px; letter-spacing: .01em; }
</style>
<div class="bar" data-tone="normal"><div class="headline"></div><div class="sub"></div><div class="now"></div></div>
<div class="footer"></div>\`;
    els = {
      bar: root.querySelector(".bar"), headline: root.querySelector(".headline"),
      sub: root.querySelector(".sub"), now: root.querySelector(".now"),
    };
    root.querySelector(".footer").textContent = FOOTER;
    document.documentElement.appendChild(host);
    const pad = document.createElement("style");
    pad.textContent = "body { padding-bottom: 170px !important; } html { scroll-padding-bottom: 170px; }";
    document.head && document.head.appendChild(pad);
    const scene = SCENES[location.pathname];
    if (scene && !state.headline) { state.headline = scene.headline; state.sub = scene.sub; }
    if (pending) { Object.assign(state, pending); pending = null; }
    paint();
  };
  window.__demoCaption = {
    set: (headline, sub, now, tone) => {
      const next = { headline: headline || "", sub: sub || "", now: now || "", tone: tone || "normal" };
      if (!els) { pending = next; mount(); }
      Object.assign(state, next);
      paint();
    },
  };
  const say = (now) => { state.now = now; paint(); };
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!t || !/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.type === "file") return;
    const label = labelFor(t);
    if (label) say("\\u25B6 Filling \\u201C" + label + "\\u201D");
  }, true);
  const onValue = (e) => {
    const t = e.target;
    if (!t || !/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    const label = labelFor(t);
    if (t.type === "file") {
      const f = t.files && t.files[0];
      if (f) say("\\u2714 Attached " + f.name + " to \\u201C" + label + "\\u201D");
      return;
    }
    if (t.type === "password") { say("\\u2714 " + label + " entered (hidden)"); return; }
    const shown = SECRET.test(t.id + " " + label) ? "bound by name \\u2014 sensitive" : String(t.value || "").slice(0, 60);
    say("\\u2714 " + label + " \\u2192 " + shown);
  };
  // fill() dispatches "input"; selects and file inputs dispatch "change". Both narrate.
  document.addEventListener("input", onValue, true);
  document.addEventListener("change", onValue, true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();`;
}
