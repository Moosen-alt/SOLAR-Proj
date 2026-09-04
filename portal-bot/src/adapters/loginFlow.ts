// Shared, portal-AGNOSTIC login flow used by every adapter (auto-learn, recipe replay,
// and the hand-coded portals). It is heuristic, not portal-specific, so it logs in to:
//   - Known portals: PowerClerk (#UserName / #Password / #LoginButton — verified live),
//     Oregon ePermitting / Accela (#txtLoginEmail / #txtLoginPassword / #hlLogin), and
//   - UNKNOWN portals: any standard login form, found by a prioritized candidate list
//     that falls back to generic id/name/placeholder/type heuristics.
//
// It also handles the "reveal login" pattern (Accela and many portals show only a
// "Log In" link on the landing page; the form appears after clicking it).
//
// SECURITY: never logs the username or password. On MFA/CAPTCHA it stops for a human and
// never attempts to solve it. It only fills + clicks the login control — nothing else.

import type { Page, Frame, Locator } from "playwright";
import type { RecipeSelector } from "../../../shared/src/types";
import { detectChallengeFrame, sleep, smartWait, waitForElement } from "../safeAction";

export interface Credential {
  username: string;
  password: string;
}

export type LoginStatus =
  | "logged_in" // a form was filled and submitted, and the form is now gone
  | "already_authenticated" // no login form present AND a positive authenticated signal (logout/session valid)
  | "no_credential" // a login form is present but no credential was supplied
  | "still_on_login" // filled + submitted, but the form is still showing (bad creds)
  | "mfa_captcha" // a challenge appeared — a human must finish
  | "no_username_field" // a password field exists but no username field could be found
  | "no_submit_control" // fields filled but no login button/link could be found
  | "login_form_unrecognized" // no login form found, but NO proof of a session either — do not proceed as logged in
  | "no_login_required" // the page IS the application form: a public submission portal with no account at all
  | "error";

export interface LoginResult {
  ok: boolean;
  status: LoginStatus;
  message: string;
}

// How long to wait for a login to resolve (AJAX login + JS redirect) before concluding
// the credentials were rejected. PowerClerk's redirect can take several seconds.
const LOGIN_RESULT_TIMEOUT_MS = 15000;

// --- Prioritized candidate selectors (known portals first, then generic heuristics) ---

// Username / email / user-id field. PowerClerk's #UserName has NO name attribute and is
// type=text, so id- and placeholder-based candidates are essential.
const USERNAME_CANDIDATES: RecipeSelector[] = [
  { css: "#UserName" }, // PowerClerk (verified live)
  { css: "#username" }, // Accela ACA AngularUI login (in an iframe — verified live)
  { css: "#txtLoginEmail" }, // Accela ACA (newer)
  { css: "#txtUserName, #txtUserId, #ctl00_PlaceHolderMain_LoginBox_txtUserId" }, // Accela (classic)
  { css: 'input[id*="loginid" i], input[id*="txtlogin" i]' }, // eTRAKiT (#ucLogin_txtLoginId — verified live)
  { label: "Username" },
  { label: "User Name" }, // eTRAKiT et al. label the field "User Name:"
  { label: "Email" },
  { label: "User ID" },
  { css: 'input[type="email"]' },
  { css: 'input[placeholder*="@"]' }, // PowerClerk placeholder "example@company.com"
  { css: 'input[id*="user" i], input[id*="email" i], input[id*="userid" i], input[id*="login" i]' },
  { css: 'input[name*="user" i], input[name*="email" i], input[name*="login" i]' },
];

const PASSWORD_CANDIDATES: RecipeSelector[] = [
  { css: "#Password" }, // PowerClerk (verified live)
  { css: "#passwordRequired" }, // Accela ACA AngularUI login (in an iframe — verified live)
  { css: "#txtLoginPassword, #ctl00_PlaceHolderMain_LoginBox_txtPassword" }, // Accela
  { css: 'input[type="password"]' }, // universal — the common case
  // Password fields that are NOT type=password: some ASP.NET/Telerik skins render the
  // password box as type=text with a password-ish id/name/placeholder. These are safe to
  // match by attribute; the table-layout case with NO password-ish attribute (eTRAKiT's
  // RadTextBox) is handled by the adjacent-label fallback below, not here.
  { css: 'input[id*="pass" i], input[name*="pass" i], input[id*="pwd" i], input[name*="pwd" i]' },
  { label: "Password" },
  { placeholder: "Password" },
];

const SUBMIT_CANDIDATES: RecipeSelector[] = [
  { css: "#LoginButton" }, // PowerClerk (verified live — a <button> with NO type)
  { css: "#hlLogin, #btnLogin, #ctl00_PlaceHolderMain_LoginBox_btnLogin" }, // Accela
  { css: 'input[id*="btnlogin" i], input[id*="loginbutton" i]' }, // eTRAKiT (#ucLogin_btnLogin — an <input type=button> with __doPostBack)
  { css: 'button[id*="login_submit" i], button[id*="btnsubmit" i]' }, // Momentum/Liferay portlet (verified live)
  { role: "button", name: "Log In" }, // PowerClerk button text (verified)
  { role: "button", name: "Sign In" },
  { role: "button", name: "Login" },
  { role: "link", name: "Log In" }, // Accela's login control is an <a>
  { role: "link", name: "Login" },
  { css: 'input[type="submit"], button[type="submit"]' },
  // Citizenserve's login control is <a href="javascript:ajaxLogin();">Submit</a> — no
  // "login" token anywhere on it (verified live). Generic submit-ish wording, checked after
  // the login-specific candidates so a page with both still prefers the explicit one.
  { role: "button", name: "Submit" },
  { role: "link", name: "Submit" },
  { role: "button", name: "Continue" },
  { role: "link", name: "Continue" },
  { css: 'button[id*="login" i], a[id*="login" i], input[id*="login" i]' },
];

// Identifier-first ("two-step") login: the first page asks only for the email/username and
// a Continue/Next button reveals the password step. OpenGov's portal works this way, as do
// most SSO front doors. These advance step 1 — deliberately narrow so they can never be
// confused with the final submit.
const NEXT_STEP_CANDIDATES: RecipeSelector[] = [
  { role: "button", name: "Continue" },
  { role: "button", name: "Next" },
  { role: "link", name: "Continue" },
  { role: "link", name: "Next" },
  { css: 'button[id*="continue" i], button[id*="next" i]' },
  { css: 'input[type="submit"], button[type="submit"]' },
];

// Triggers that REVEAL a hidden login form (portal shows only a "Log In" link until clicked).
const REVEAL_TRIGGERS: RecipeSelector[] = [
  { css: '#ctl00_HeaderNavigation_btnLogin' }, // Accela header "Login"
  { role: "link", name: "Login" },
  { role: "link", name: "Log In" },
  { role: "link", name: "Sign In" },
  // "Logon" is not "Log In". Bonney Lake WA offers exactly that word and nothing else, and
  // the run reported the login unrecognised while standing next to it. ASP.NET municipal
  // sites use it constantly.
  { role: "link", name: "Logon" },
  { role: "link", name: "Log On" },
  { role: "button", name: "Logon" },
  { role: "link", name: "My Account" }, // some portals hide the form behind "My Account"
  { role: "button", name: "Login" },
  { role: "button", name: "Log In" },
  // "Sign In" existed as a LINK but not as a BUTTON, so a portal rendering it as a button
  // was never revealed — an asymmetry with no reason behind it, found while sweeping the
  // reveal list against live portals.
  { role: "button", name: "Sign In" },
  { role: "button", name: "My Account" },
  // SSO HAND-OFF. Some portals' login page holds no fields at all — only a button that
  // hands off to an identity provider ("Login using Secure Portal" on OpenGov, verified
  // live; "Sign in with…" elsewhere). The real form lives on the far side.
  { role: "button", name: "Login using" },
  { role: "button", name: "Sign in with" },
  { role: "button", name: "Secure Portal" },
  { role: "link", name: "Login using" },
  // href-based, but never a SIGN-OUT link (…/account/logout contains "account"): excluding
  // logout/signout keeps a reveal-trigger from clicking the very control that proves we're
  // already signed in.
  { css: 'a[href*="login" i]:not([href*="logout" i]), a[id*="login" i]:not([id*="logout" i]), a[href*="signin" i], a[href*="account" i]:not([href*="logout" i]):not([href*="signout" i])' },
];

// Reveal triggers already clicked on a given page, so repeated reveal attempts walk to the
// NEXT candidate instead of clicking the same dead control forever. Measured live on
// OpenGov: the header "Login" link is still present on the login page it navigates to, so
// the retry loop re-clicked it every pass and never reached the SSO hand-off button below
// it. Keyed per Page and discarded with it.
const triedTriggers = new WeakMap<object, Set<string>>();
const triggerKey = (sel: RecipeSelector): string => JSON.stringify(sel);

// Positive proof of an authenticated session — a control that only appears once logged in.
// Used to distinguish a genuinely valid persistent session from "we simply failed to find
// the login form" (a portal that shows a public landing page). Never treats the mere
// ABSENCE of a login form as success.
// Only a SIGN-OUT control is used as the positive signal: it appears when logged in and
// essentially never on a public login landing. (Deliberately NOT "My Account"/"Dashboard" —
// those also appear as login prompts on public pages, which is the false-positive we are
// avoiding.) Covered variants: logout / log out / logoff / log off / signout / sign out /
// sign off, by href, id, and visible text.
const AUTHENTICATED_SIGNALS: RecipeSelector[] = [
  { css: 'a[href*="logout" i], a[href*="log-out" i], a[href*="logoff" i], a[href*="signout" i], a[href*="sign-out" i], a[href*="signoff" i], a[id*="logout" i], a[id*="signout" i], button[id*="logout" i], button[id*="signout" i]' },
];
async function authenticatedSignalPresent(page: Page): Promise<boolean> {
  if (await firstVisible(page, AUTHENTICATED_SIGNALS)) return true;
  // Text fallback: a visible sign-out control the css selectors above missed.
  try {
    const byText = page.getByText(/^\s*(log\s?-?\s?out|sign\s?-?\s?out|log\s?off|sign\s?off)\s*$/i).first();
    if ((await byText.count().catch(() => 0)) > 0 && (await byText.isVisible().catch(() => false))) return true;
  } catch { /* ignore */ }
  return false;
}

// Find a login input by an ADJACENT visual label — for table-layout ASP.NET portals whose
// "User Name:" / "Password:" labels are laid out in a sibling cell and associated to the
// input by neither `for=`, wrapping `<label>`, nor aria (so getByLabel cannot see them).
// eTRAKiT's password box is a Telerik RadTextBox: type=text, id "RadTextBox2" with no
// password token — the ONLY signal is the "Password:" text just before it. Generic: match a
// short visible element whose text is the label, then take the nearest input AFTER it in
// document order. Password-kind only accepts type=password or type=text (never a checkbox).
async function findInputByAdjacentLabel(page: Page, kind: "user" | "pass"): Promise<Locator | null> {
  try {
    const id = await (page as unknown as { evaluate: (fn: (k: string) => string | null, arg: string) => Promise<string | null> }).evaluate((k: string) => {
      const isVis = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const re = k === "pass" ? /^\s*password\s*:?\s*$/i : /^\s*(user\s*name|username|user\s*id|e-?mail(\s*address)?|login)\s*:?\s*$/i;
      const labels = (Array.from(document.querySelectorAll("td, th, label, span, div, b, strong, p")) as HTMLElement[])
        .filter((e) => isVis(e) && re.test((e.textContent || "")) && (e.textContent || "").trim().length < 24);
      const inputs = (Array.from(document.querySelectorAll("input")) as HTMLInputElement[]).filter((e) => {
        const t = (e.getAttribute("type") || "text").toLowerCase();
        if (!isVis(e)) return false;
        return k === "pass" ? (t === "password" || t === "text") : (t === "text" || t === "email" || t === "");
      });
      if (!labels.length || !inputs.length) return null;
      const all = Array.from(document.querySelectorAll("*"));
      const order = new Map<Element, number>(); all.forEach((el, i) => order.set(el, i));
      for (const lab of labels) {
        const li = order.get(lab) ?? -1;
        let best: HTMLInputElement | null = null; let bestDelta = Infinity;
        for (const inp of inputs) { const ii = order.get(inp) ?? -1; const d = ii - li; if (d > 0 && d < bestDelta) { bestDelta = d; best = inp; } }
        if (best && best.id) return best.id;
      }
      return null;
    }, kind);
    return id ? page.locator(`[id="${id}"]`).first() : null;
  } catch { return null; }
}

// Build a Playwright locator from a portable selector descriptor (mirrors the adapters'
// own locator()). Standalone so it has no adapter-state dependency.
export function buildLocator(pageOrFrame: Page | Frame, sel: RecipeSelector): Locator | null {
  if (!sel) return null;
  // scope is Page, Frame, or FrameLocator — all expose the same locator API; use any internally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope: any = sel.frame ? (pageOrFrame as any).frameLocator(`iframe[name="${sel.frame}"]`) : pageOrFrame;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let loc: any;
  // sel.role is stored as a string; cast to the ARIA role union expected by getByRole.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const role = sel.role as any;
  if (sel.role && sel.name) loc = scope.getByRole(role, { name: sel.name, exact: sel.exact });
  else if (sel.label) loc = scope.getByLabel(sel.label, { exact: sel.exact });
  else if (sel.placeholder) loc = scope.getByPlaceholder(sel.placeholder, { exact: sel.exact });
  else if (sel.testId) loc = scope.getByTestId(sel.testId);
  else if (sel.text) loc = scope.getByText(sel.text, { exact: sel.exact });
  else if (sel.css) loc = scope.locator(sel.css);
  else if (sel.role) loc = scope.getByRole(role);
  else return null;
  return (typeof sel.nth === "number" ? loc.nth(sel.nth) : loc.first()) as Locator;
}

// Return the first candidate locator that resolves to a visible element, else null.
// Frame-aware: searches the main document AND every same-origin iframe, because some
// portals (Accela ACA's AngularUI login) render the login form inside an iframe.
// page.frames() includes the main frame first, so the main document is still tried first.
//
// A HIDDEN DUPLICATE MUST NOT MASK THE REAL FIELD. Responsive portals ship the same login
// twice — a desktop portlet and a hidden mobile one — and testing only `.first()` matched
// the hidden copy and concluded the portal had no login form at all (measured live on
// Momentum: two password inputs, one visible, engine reported none). So when a candidate
// resolves to several elements, scan them and take the first VISIBLE one.
const MAX_CANDIDATE_SCAN = 10;
/**
 * Every visible match of ONE selector, across the main document and every frame, up to a
 * cap. firstVisible answers "is there one"; this answers "which ones", which is what a
 * reveal pass needs when a portal renders the same control more than once — see the note in
 * revealLoginForm about duplicate ids.
 */
async function visibleMatches(page: Page, sel: RecipeSelector, max: number): Promise<Locator[]> {
  const out: Locator[] = [];
  const scopes: Array<Page | Frame> = typeof page.frames === "function" ? page.frames() : [page];
  for (const scope of scopes) {
    try {
      const all = buildLocatorAll(scope, sel);
      if (!all) continue;
      const total = await all.count();
      for (let i = 0; i < Math.min(total, MAX_CANDIDATE_SCAN) && out.length < max; i++) {
        const nth = all.nth(i);
        if (await nth.isVisible().catch(() => false)) out.push(nth);
      }
    } catch { /* malformed selector or cross-origin frame */ }
    if (out.length >= max) break;
  }
  return out;
}

async function firstVisible(page: Page, candidates: RecipeSelector[]): Promise<Locator | null> {
  const scopes: Array<Page | Frame> = typeof page.frames === "function" ? page.frames() : [page];
  for (const sel of candidates) {
    for (const scope of scopes) {
      try {
        // An explicit nth in the selector means the caller wants exactly that element.
        if (typeof sel.nth === "number") {
          const pinned = buildLocator(scope, sel);
          if (pinned && (await pinned.count()) > 0 && (await pinned.isVisible().catch(() => false))) return pinned;
          continue;
        }
        const all = buildLocatorAll(scope, sel);
        if (!all) continue;
        const total = await all.count();
        for (let i = 0; i < Math.min(total, MAX_CANDIDATE_SCAN); i++) {
          const nth = all.nth(i);
          if (await nth.isVisible().catch(() => false)) return nth;
        }
      } catch {
        // malformed selector or cross-origin frame — try the next scope/candidate
      }
    }
  }
  return null;
}

// buildLocator, but WITHOUT the trailing .first() — so callers can scan every match.
function buildLocatorAll(pageOrFrame: Page | Frame, sel: RecipeSelector): Locator | null {
  if (!sel) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope: any = sel.frame ? (pageOrFrame as any).frameLocator(`iframe[name="${sel.frame}"]`) : pageOrFrame;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const role = sel.role as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let loc: any;
  if (sel.role && sel.name) loc = scope.getByRole(role, { name: sel.name, exact: sel.exact });
  else if (sel.label) loc = scope.getByLabel(sel.label, { exact: sel.exact });
  else if (sel.placeholder) loc = scope.getByPlaceholder(sel.placeholder, { exact: sel.exact });
  else if (sel.testId) loc = scope.getByTestId(sel.testId);
  else if (sel.text) loc = scope.getByText(sel.text, { exact: sel.exact });
  else if (sel.css) loc = scope.locator(sel.css);
  else if (sel.role) loc = scope.getByRole(role);
  else return null;
  return loc as Locator;
}

// Is a password field present? The reliable structural signal that we're on a login form.
// Falls back to the adjacent-label scan for portals whose password box is not type=password
// and carries no password-ish attribute (eTRAKiT's Telerik RadTextBox).
export async function loginFormPresent(page: Page): Promise<boolean> {
  if (await firstVisible(page, PASSWORD_CANDIDATES)) return true;
  return (await findInputByAdjacentLabel(page, "pass")) !== null;
}

// Locate the username / password field, trying the prioritized candidates first and the
// adjacent-label scan as a last resort. One place so loginFormPresent and performLogin agree.
async function findUsernameField(page: Page): Promise<Locator | null> {
  return (await firstVisible(page, USERNAME_CANDIDATES))
    ?? (await findInputByAdjacentLabel(page, "user"))
    ?? (await findInputBeforePassword(page));
}

// LAST RESORT, PURELY STRUCTURAL: the visible text/email input immediately BEFORE the
// password field. Login forms put the identifier first, so position identifies it even when
// nothing else does — and some portals give the field nothing else to go on. ComEd's
// interconnection portal (verified live) renders both inputs with no id, no name, no
// placeholder and no aria-label, and its <label for="username"> points at an id that does
// not exist on the page, so every attribute- and label-based route fails.
async function findInputBeforePassword(page: Page): Promise<Locator | null> {
  try {
    const idx = await (page as unknown as { evaluate: (fn: () => number) => Promise<number> }).evaluate(() => {
      const vis = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const inputs = (Array.from(document.querySelectorAll("input")) as HTMLInputElement[]).filter(vis);
      const pwAt = inputs.findIndex((e) => (e.getAttribute("type") || "").toLowerCase() === "password");
      if (pwAt <= 0) return -1;
      // Walk backwards to the nearest field a person would type an identifier into.
      for (let i = pwAt - 1; i >= 0; i--) {
        const t = (inputs[i].getAttribute("type") || "text").toLowerCase();
        if (t === "text" || t === "email" || t === "tel") {
          // Index among ALL visible inputs, so the locator below can address it.
          return i;
        }
      }
      return -1;
    });
    if (idx < 0) return null;
    // Re-resolve by the same visible-input ordering the page evaluation used.
    const all = page.locator("input:visible");
    const loc = all.nth(idx);
    return (await loc.count()) > 0 ? loc : null;
  } catch { return null; }
}
async function findPasswordField(page: Page): Promise<Locator | null> {
  return (await firstVisible(page, PASSWORD_CANDIDATES)) ?? (await findInputByAdjacentLabel(page, "pass"));
}

// If no login form is visible, click a "Log In" trigger to reveal one (Accela pattern).
// Returns true if a form became present after revealing.
/**
 * WHAT THE LAST REVEAL PASS ACTUALLY TRIED.
 *
 * Wilsonville failed as "login form was not recognised" and its bundle held exactly one
 * event: the verdict. The captured page proved the control was in the DOM —
 * `<a id="link-LoginUnderGreetings" href="" ng-click="vm.login()">Login or Register</a>` —
 * and I still could not tell whether the reveal never matched it, matched and could not
 * click it, or clicked it and got no form. Three different bugs, one indistinguishable
 * symptom, and no way to choose between them without driving the portal again.
 *
 * So the pass leaves a trail. Read by the adapter into the run's event log; last-write-wins
 * per page, which is all a diagnosis needs.
 */
const revealTrail = new WeakMap<object, string[]>();

/** The trail from the most recent revealLoginForm on this page, oldest first. */
export function lastRevealTrail(page: Page): string[] {
  return revealTrail.get(page as unknown as object) ?? [];
}

export async function revealLoginForm(page: Page): Promise<boolean> {
  const trail: string[] = [];
  revealTrail.set(page as unknown as object, trail);
  if (await loginFormPresent(page)) return true;
  let tried = triedTriggers.get(page as unknown as object);
  if (!tried) { tried = new Set<string>(); triedTriggers.set(page as unknown as object, tried); }
  for (const sel of REVEAL_TRIGGERS) {
    const key = triggerKey(sel);
    if (tried.has(key)) continue;
    // EVERY VISIBLE MATCH, NOT JUST THE FIRST.
    //
    // Wilsonville's login is <a id="link-LoginUnderGreetings" href="" ng-click="vm.login()">
    // and that id appears THREE times in its DOM — once inside a closed dropdown-menu, once
    // in an ng-if block, once in a welcome tile. The href/id CSS candidate matched, the
    // first visible match refused the click, and the whole candidate was abandoned: the run
    // reported "the portal's login form was not recognised" while the control that works sat
    // two matches away.
    //
    // Duplicate ids and repeated controls are ordinary in server-rendered and Angular
    // portals. A candidate is exhausted only when every visible match has refused.
    const triggers = await visibleMatches(page, sel, 4);
    if (!triggers.length) { trail.push(`no-match ${key}`); continue; }
    tried.add(key);
    let clickedOne = false;
    for (let ti = 0; ti < triggers.length; ti++) {
    const trigger = triggers[ti];
    try {
      // TIME-BOXED, BECAUSE THE BUDGET AROUND THIS IS SECONDS.
      //
      // A bare click() takes Playwright's 30s default. Wilsonville's reveal trail shows one
      // href-matched candidate eating exactly that — "click-failed ...: locator.click:
      // Timeout 30000ms exceeded" — inside a reveal loop whose whole settle budget is 4 to
      // 8 seconds. One control that will not accept a click starved every trigger after it,
      // and the run reported "the portal's login form was not recognised" having never
      // reached the trigger that would have worked. The 39.8s run was one wait.
      //
      // A control that does not take a click in three seconds is not going to.
      await trigger.click({ timeout: 3000 });
      await smartWait(page, 3000);
      clickedOne = true;
    } catch (err) {
      // KEEP THE TAIL, NOT THE HEAD. Playwright leads with an echo of the selector and puts
      // the actionability verdict last — "element is not visible", "intercepts pointer
      // events", "element is outside of the viewport". Truncating from the front spent the
      // whole budget re-printing a selector already named two words earlier, and left the
      // one useful clause off the end. Cost a live run to learn.
      const why = String((err as Error)?.message || err).replace(/\s+/g, " ");
      trail.push(`click-failed ${key} #${ti}: ${why.length > 200 ? `...${why.slice(-200)}` : why}`);
      // COVERED, NOT MISSING. A modal backdrop or consent overlay above the control is a
      // different problem from a control we cannot find, and it is the commoner one on a
      // portal that greets you with a dialog. Neutralise what is on top and try once more.
      if (/intercepts pointer events|element is not (visible|stable)/i.test(why)) {
        // READ THE DIALOG BEFORE DISABLING IT. What is in the way is quite often the next
        // step — Wilsonville's "You are being redirected to Tyler Identity login... Continue"
        // — and neutralising it disables the control that carries the flow forward.
        const continued = await clickLoginContinuation(page);
        if (continued) {
          trail.push(`continued through dialog: ${continued.slice(0, 90)}`);
          clickedOne = true;
          if (await loginFormPresent(page)) { trail.push("dialog continuation -> form appeared"); return true; }
          tried.clear();
          tried.add(key);
          return false;
        }
        const cleared = await neutralizeOverlayOver(page, trigger);
        if (cleared) {
          trail.push(`neutralised overlay: ${cleared}`);
          try {
            await trigger.click({ timeout: 3000 });
            await smartWait(page, 3000);
            clickedOne = true;
            if (await loginFormPresent(page)) { trail.push(`clicked ${key} #${ti} after clearing -> form appeared`); return true; }
            trail.push(`clicked ${key} #${ti} after clearing -> no form`);
            continue;
          } catch (err2) {
            trail.push(`still blocked after clearing: ${String((err2 as Error)?.message || err2).replace(/\s+/g, " ").slice(-120)}`);
            // LAST RESORT: dispatch the click on the element itself.
            //
            // Wilsonville re-asserts its modal as fast as it is neutralised — Angular
            // re-renders the backdrop — so hit-testing can never succeed no matter how many
            // times the cover is disabled. A DOM click fires the element's own handler
            // (ng-click, onclick, an anchor's default) without asking what is on top.
            //
            // Deliberately confined to the LOGIN REVEAL and to a control already resolved by
            // login-specific selectors, after a real click has failed on interception. It is
            // never used on a form control, an advance, or anything that files: bypassing
            // hit-testing is exactly the sort of thing that must not become a general habit,
            // because elsewhere "something is covering it" is information worth respecting.
            const dispatched = await (trigger as unknown as { evaluate: (fn: (el: Element) => boolean) => Promise<boolean> })
              .evaluate((el) => { (el as HTMLElement).click(); return true; }).catch(() => false);
            if (dispatched) {
              await smartWait(page, 3000);
              clickedOne = true;
              if (await loginFormPresent(page)) { trail.push(`dispatched click on ${key} #${ti} -> form appeared`); return true; }
              trail.push(`dispatched click on ${key} #${ti} -> no form`);
            }
          }
        }
      }
      continue; // this match refused — try the next MATCH before giving up on the candidate
    }
    if (await loginFormPresent(page)) { trail.push(`clicked ${key} #${ti} -> form appeared`); return true; }
    trail.push(`clicked ${key} #${ti} -> no form`);
    }
    // Every visible match of this candidate has been tried. If one of them actually took a
    // click, hand back so the caller can re-look; the page may have changed under us.
    if (clickedOne) return false;
  }

  // A HAND-OFF THAT STALLED. Before the described-control pass, take any "click here if
  // you are not forwarded" escape hatch: Tyler's SSO stub offers one and never forwards on
  // its own, so the run stalls on a page that has no fields to find.
  const forwardKey = "forwarding-interstitial";
  if (!tried.has(forwardKey)) {
    const forwarded = await followForwardingInterstitial(page);
    trail.push(forwarded ? `forwarding-interstitial clicked ${JSON.stringify(forwarded)}` : "no forwarding interstitial");
    if (forwarded) {
      tried.add(forwardKey);
      if (await loginFormPresent(page)) return true;
      // New page, new controls — the worded triggers have never seen them.
      tried.clear();
      tried.add(forwardKey);
      return false;
    }
  }

  // LAST: a control that is a login without SAYING so — an icon-only dropdown toggle named
  // only by its tooltip, or by the menu it opens. See markDescribedLoginControl. Tried
  // after every worded trigger, so a portal with a plain "Log In" link never reaches here.
  const describedKey = "described-login-control";
  if (!tried.has(describedKey)) {
    const described = await markDescribedLoginControl(page);
    trail.push(described ? `described-control found: ${described.slice(0, 60)}` : "no described login control");
    if (described) {
      tried.add(describedKey);
      try {
        await page.locator("[data-al-login-reveal]").first().click({ timeout: 5000 });
        await smartWait(page, 3000);
      } catch {
        return false;
      }
      // The toggle usually only OPENS a menu; the sign-in item inside it is a second click,
      // and that item DOES say what it is. So hand the worded triggers a fresh pass — the
      // menu's contents are controls they have never seen, and the whole reason they were
      // marked "tried" was that those controls did not exist a moment ago.
      if (await loginFormPresent(page)) return true;
      tried.clear();
      tried.add(describedKey);
      return false;
    }
  }
  return false;
}

// The full login flow. Heuristic and portal-agnostic. Never logs credentials.
export async function performLogin(
  page: Page,
  credential: Credential | undefined,
): Promise<LoginResult> {
  try {
    // 0) Let the page settle — a single domcontentloaded fires before an MVC/SPA login
    //    form is painted, so checking immediately races the render.
    await smartWait(page, 1500);

    // 1) Make sure a login form is actually showing (reveal it if the portal hides it).
    //    But if there is NO form and we already see a signed-in signal, we're authenticated —
    //    return now, before any reveal click could hit a logout/account control by mistake.
    let present = await loginFormPresent(page);
    if (!present && await authenticatedSignalPresent(page)) {
      return { ok: true, status: "already_authenticated", message: "Already signed in (a logout control is present) — using the existing session." };
    }
    if (!present) present = await revealLoginForm(page);

    // 2) No form yet. Give it a settle budget before concluding ANYTHING — a login box is
    //    routinely painted late (Momentum's Liferay login portlet renders after the page
    //    reports networkidle, which made the engine declare the portal formless). The budget
    //    is longer on a login-looking URL, where a form is all but guaranteed to arrive.
    if (!present) {
      const url = (typeof page.url === "function" ? page.url() : "").toLowerCase();
      const onLoginUrl = /login|sign-?in|account\/(login|signin)|logon/.test(url);
      const deadline = Date.now() + (onLoginUrl ? 8000 : 4000);
      while (!present && Date.now() < deadline) {
        await smartWait(page, 1000);
        present = await loginFormPresent(page);
        if (!present) present = await revealLoginForm(page);
      }
    }

    // 2b) IDENTIFIER-FIRST ("two-step") LOGIN. Some portals ask for the email alone, then
    //     reveal the password after a Continue/Next click (OpenGov's portal, and most SSO
    //     front doors). There is no password field yet, so the check above sees "no form"
    //     and the run would stop one click short of the actual login. Deliberately tight, so
    //     a public page's search box + Go button can never be mistaken for a login: it needs
    //     an identifier-shaped field from the specific candidate list (not the loose
    //     adjacent-label fallback), a next-step control, AND login wording on the page/URL.
    let identifierEntered = false;
    if (!present) {
      const idField = await firstVisible(page, USERNAME_CANDIDATES);
      const nextCtl = idField ? await firstVisible(page, NEXT_STEP_CANDIDATES) : null;
      if (idField && nextCtl) {
        const url = (typeof page.url === "function" ? page.url() : "").toLowerCase();
        const loginish = /login|sign-?in|account\/(login|signin)|logon/.test(url)
          || await page.getByText(/sign in|log in|password/i).first().isVisible().catch(() => false);
        if (loginish) {
          if (!credential || !credential.username || !credential.password) {
            return { ok: false, status: "no_credential", message: "This portal asks for the username first (two-step login) but no stored credential was found for this client/portal. Add the portal username + password under the client's logins, then retry." };
          }
          await waitForElement(idField);
          await idField.fill(credential.username);
          await nextCtl.click().catch(() => null);
          // Wait for the password step to paint.
          const deadline = Date.now() + 10000;
          while (!present && Date.now() < deadline) {
            await smartWait(page, 1000);
            present = await loginFormPresent(page);
          }
          identifierEntered = present;
        }
      }
    }

    // 3) Still no form. The mere ABSENCE of a login form is NOT proof of a session — many
    //    portals show a public landing page (or a login box the heuristics didn't match).
    //    Only conclude "already_authenticated" when a POSITIVE signal (a logout/sign-out
    //    control) is present. Otherwise this is an unrecognized login page: return a distinct
    //    status so the caller records/learns the portal instead of "learning" a page it is
    //    not actually logged in to. (This turned a silent false-success on eTRAKiT-style
    //    public landings into an honest failure.)
    if (!present) {
      if (await authenticatedSignalPresent(page)) {
        return { ok: true, status: "already_authenticated", message: "No login form present and a signed-in signal was found — using the existing session." };
      }
      const url = (typeof page.url === "function" ? page.url() : "").toLowerCase();
      const onLoginUrl = /login|sign-?in|account\/(login|signin)|logon/.test(url);

      // SOME PORTALS HAVE NO ACCOUNTS AT ALL.
      //
      // Not every jurisdiction runs a permitting SYSTEM; plenty publish a submission FORM.
      // Gilbert, AZ serves its permit request at gilbertaz.seamlessdocs.com — eight visible
      // fields (Permit Number, Located at, Email, Phone, First/Last Name), no password field
      // anywhere, and nothing to log into. The engine looked for a login, failed to find one,
      // and reported the portal unrecognisable — refusing to fill a form that was sitting
      // open in front of it.
      //
      // This is NOT the eTRAKiT-style false success the branch below guards against. That
      // danger is a LOGGED-OUT landing page being mistaken for a session; the tell is that
      // such a page offers navigation and a search box, not an application. So the bar is a
      // real application-shaped form: several fillable inputs that are not search boxes, on a
      // page that is not itself a login URL. Anything less still fails honestly.
      if (!onLoginUrl) {
        const publicForm = await applicationShapedForm(page);
        if (publicForm) {
          return {
            ok: true,
            status: "no_login_required",
            message: `No login exists on this portal — it publishes the application directly (${publicForm} fillable field(s)). Proceeding without signing in.`,
          };
        }
        // A PUBLIC PORTAL'S FRONT DOOR IS OFTEN A MENU, NOT A FORM.
        //
        // applicationShapedForm asks whether the application is on THIS page, which is how
        // Gilbert works. Two portals in the 2026-09-04 baseline are public in exactly the
        // same sense but arrange it differently: Star ID (iWorq) lists its applications as
        // links — "Electrical", "Plumbing", "Ada County Residential Building" — and Des
        // Moines WA (PermitTrax) offers "CLICK TO APPLY ONLINE". Neither page holds a
        // single input, so both were scored "the portal's login form was not recognised",
        // as though we had failed to find something that does not exist.
        //
        // The guard this sits inside is load-bearing: refusing to proceed without proof of
        // a session is what turned silent false successes on logged-out landing pages into
        // honest failures. So the discriminator is not "does it look public" — it is
        // whether there is ANYWHERE TO LOG IN. If a portal offers no password field and no
        // sign-in or register control anywhere, there is no session to prove, and treating
        // its open door as a locked one is the error. Washington County (Accela) and
        // Wilsonville (Tyler) both fail this test on their "Login" links, which is right:
        // they do have accounts, and their real defect is elsewhere.
        const publicEntry = await publicApplicationEntry(page);
        if (publicEntry) {
          return {
            ok: true,
            status: "no_login_required",
            message: `No login exists on this portal — no password field and no sign-in control anywhere, and it lists its applications directly (${publicEntry}). Proceeding without signing in.`,
          };
        }
      }

      // AN ERROR PAGE IS NOT A LOGIN WE FAILED TO RECOGNISE.
      //
      // Baltimore County answers with a CloudFront block — title "ERROR: The request could
      // not be satisfied", body "403 ERROR ... Request blocked." — and the run reported
      // "the portal's login form was not recognised", owner ENGINE. There is no login form
      // on that page because there is no page: we were refused at the door.
      //
      // It matters twice over. The scorer already knows a WAF block is the portal's, and
      // looksBotBlocked already retries such a run with a real window — but both read the
      // MESSAGE, and the 403 was only ever in the page. Naming it here is what connects the
      // evidence to the machinery that was built for it.
      const errorPage = await detectErrorPage(page);
      if (errorPage) {
        return { ok: false, status: "login_form_unrecognized", message: `The portal did not serve a usable page: ${errorPage}` };
      }
      return {
        ok: false,
        status: onLoginUrl ? "still_on_login" : "login_form_unrecognized",
        message: onLoginUrl
          ? "On a login page but the login form could not be located (it may be inside an iframe or use an unusual layout). Record this portal manually."
          : "Could not find a login form or any signed-in signal on this portal — it likely hides login behind an unrecognized control or a separate page. Record/learn this portal's login manually rather than proceeding as authenticated.",
      };
    }

    // 3) A form is showing but we have nothing to fill it with.
    if (!credential || !credential.username || !credential.password) {
      return { ok: false, status: "no_credential", message: "A login form is present but no stored credential was found for this client/portal. Add the portal username + password under the client's logins, then retry." };
    }

    // 4) A challenge already on the login page → stop for a human.
    const preChallenge = await detectChallengeFrame(page);
    if (preChallenge) {
      return { ok: false, status: "mfa_captcha", message: `Login paused: ${preChallenge}. Complete verification in the browser, then retry.` };
    }

    // 5) Fill username + password (candidate lists first, adjacent-label scan as fallback).
    //    On a two-step login the identifier is already submitted and step 2 usually shows the
    //    password ALONE — so a missing username field there is expected, not a failure.
    const userLoc = await findUsernameField(page);
    if (!userLoc && !identifierEntered) {
      return { ok: false, status: "no_username_field", message: "Found a password field but could not locate the username/email field — the portal layout is unusual. Record it manually." };
    }
    if (userLoc) {
      await waitForElement(userLoc);
      await userLoc.fill(credential.username);
    }

    const passLoc = await findPasswordField(page);
    if (!passLoc) {
      return { ok: false, status: "no_username_field", message: "Password field disappeared after filling the username — record this portal manually." };
    }
    await waitForElement(passLoc);
    await passLoc.fill(credential.password);

    // 6) Submit. When no recognizable button exists, press Enter in the password field
    //    instead of giving up: nearly every login form submits on Enter, and the button is
    //    the part portals render most exotically (Citizenserve's is
    //    <a href="javascript:ajaxLogin();">Submit</a>). If Enter also does nothing, the poll
    //    below reports it honestly rather than claiming a button was missing.
    const loginUrl: string = typeof page.url === "function" ? page.url() : "";
    const submitLoc = await firstVisible(page, SUBMIT_CANDIDATES);
    let submittedVia: "button" | "enter" = "button";
    if (submitLoc) {
      await waitForElement(submitLoc);
      await submitLoc.click();
    } else {
      submittedVia = "enter";
      await passLoc.press("Enter").catch(() => null);
    }

    // 7) Poll for the login to resolve. Many portals (PowerClerk) do an AJAX login + a JS
    //    redirect that takes several seconds, so a single short wait races the redirect and
    //    falsely reports failure. Poll up to LOGIN_RESULT_TIMEOUT_MS for one of:
    //      - a challenge appears (MFA/CAPTCHA) → stop for a human
    //      - the login form is gone, or the URL moved off the login page → success
    const deadline = Date.now() + LOGIN_RESULT_TIMEOUT_MS;
    await smartWait(page, 2000); // let the first navigation/AJAX settle
    while (Date.now() < deadline) {
      const postChallenge = await detectChallengeFrame(page);
      if (postChallenge) {
        return { ok: false, status: "mfa_captcha", message: `MFA/2FA required after login — pausing for human (${postChallenge}). Complete it in the browser window, then retry.` };
      }
      const currentUrl: string = typeof page.url === "function" ? page.url() : "";
      const urlMoved = currentUrl !== loginUrl && !/login/i.test(currentUrl);
      const formGone = !(await loginFormPresent(page));
      if (formGone || urlMoved) {
        return { ok: true, status: "logged_in", message: "Logged in successfully." };
      }
      await sleep(500);
    }

    // 8) Timed out with the form still showing. Say WHICH submit path was taken: with no
    //    recognizable button, "credentials rejected" would be a misleading diagnosis.
    return {
      ok: false,
      status: submittedVia === "enter" ? "no_submit_control" : "still_on_login",
      message: submittedVia === "enter"
        ? "Filled the login form but found no Log In button, and submitting with Enter did not advance the page — record this portal's login control manually."
        : "Still on the login form after submitting — the stored username/password was likely rejected. Verify the credential for this portal, then retry.",
    };
  } catch (err) {
    return { ok: false, status: "error", message: `Login failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Is this page an APPLICATION, rather than a logged-out landing page?
 *
 * The distinction matters because the engine deliberately refuses to proceed when it cannot
 * prove a session — that guard turned a silent false success on eTRAKiT-style public landings
 * into an honest failure, and it must keep doing so. But some jurisdictions genuinely have no
 * accounts: Gilbert, AZ publishes its permit request as a plain form with eight fields and no
 * password anywhere. Failing there refuses to fill a form sitting open in front of us.
 *
 * A landing page offers navigation and a search box. An application offers fields a person
 * types their project into. So: count the inputs that are actually part of a form and are not
 * search/filter boxes, and require several of them. Returns the count when the page looks like
 * an application, 0 otherwise.
 */
async function applicationShapedForm(page: Page): Promise<number> {
  try {
    return await (page as unknown as { evaluate: (fn: () => number) => Promise<number> }).evaluate(() => {
      const vis = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      const SEARCHY = /search|filter|lookup|look up|find\b|query|keyword|zip|postal/i;
      const fields = (Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[])
        .filter(vis)
        .filter((el) => {
          const type = ((el as HTMLInputElement).type || "").toLowerCase();
          // Only fields a person fills in with project data.
          if (["hidden", "submit", "button", "reset", "image", "search"].includes(type)) return false;
          const hay = [
            (el as HTMLInputElement).name,
            el.id,
            (el as HTMLInputElement).placeholder,
            el.getAttribute("aria-label"),
          ].filter(Boolean).join(" ");
          return !SEARCHY.test(hay);
        });
      // A login form is two fields; a search bar is one. An application is several, and a
      // password field anywhere means this is a login page, not a public form.
      if (document.querySelector("input[type=password]")) return 0;
      return fields.length >= 4 ? fields.length : 0;
    });
  } catch {
    return 0;
  }
}

/**
 * Is this a portal with NO ACCOUNTS AT ALL, whose front door is a menu of applications?
 *
 * The sibling of applicationShapedForm, for portals that put the application one click away
 * instead of on the landing page. Returns a short description of the evidence, or "".
 *
 * THE TEST IS THE ABSENCE OF A LOGIN, NOT THE PRESENCE OF LINKS. Every permit portal has
 * links reading "apply"; only a public one has nowhere to sign in. Requiring both — no
 * password field, no sign-in/register control ANYWHERE, and several application entries —
 * is what keeps this from turning a logged-out Accela landing page into a false success,
 * which is the exact failure the surrounding guard exists to prevent.
 *
 * Exported for the DOM smoke, which drives it against markup lifted from the real portals.
 */
export async function publicApplicationEntry(page: Page): Promise<string> {
  try {
    return await (page as unknown as { evaluate: (fn: () => string) => Promise<string> }).evaluate(() => {
      const vis = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const st = getComputedStyle(el as HTMLElement);
        return r.width > 2 && r.height > 2 && st.visibility !== "hidden" && st.display !== "none";
      };
      // 1) Any password field at all — visible or not — means accounts exist here.
      if (document.querySelector("input[type=password]")) return "";

      const controls = Array.from(document.querySelectorAll(
        "a, button, input[type=button], input[type=submit], [role=button], [role=link]",
      ));

      // 2) Any sign-in affordance means accounts exist, even when the form is elsewhere.
      //    Checked against text, id and href, because portals hide it in all three.
      //    "Log out"/"sign out" is deliberately NOT a login affordance — a page offering it
      //    is already signed in, which is a different branch's business.
      const LOGIN_WORD = /\blog[\s-]?in\b|\blogin\b|\bsign[\s-]?in\b|\bsignin\b|\bregister\b|\bcreate an account\b|\bmy account\b/i;
      const LOGOUT_WORD = /\blog[\s-]?out\b|\blogout\b|\bsign[\s-]?out\b|\bsignout\b/i;
      for (const el of controls) {
        const hay = [
          (el as HTMLElement).innerText || "",
          el.getAttribute("aria-label") || "",
          el.id || "",
          (el as HTMLAnchorElement).href || "",
          (el as HTMLInputElement).value || "",
        ].join(" ");
        if (LOGOUT_WORD.test(hay)) continue;
        if (LOGIN_WORD.test(hay)) return "";
      }

      // 3) Now the positive evidence: entries that read as "start an application".
      const APPLY = /\bapply\b|\bapplication\b|\bnew permit\b|\bnew request\b|\bsubmit a\b|\brequest a\b|\bstart\b/i;
      const entries = new Set<string>();
      for (const el of controls) {
        if (!vis(el)) continue;
        const text = ((el as HTMLElement).innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        const href = (el as HTMLAnchorElement).href || "";
        // Either the wording says apply, or the URL does (iWorq's per-permit links read
        // "Electrical" and "Plumbing" — only their /new-permit/ href says what they are).
        if (!APPLY.test(text) && !/new-permit|new-application|newpermit|applyonline|apply-online/i.test(href)) continue;
        if (!text || text.length > 80) continue;
        entries.add(text.toLowerCase());
      }
      if (entries.size < 2) return "";
      return `${entries.size} application entries, e.g. ${Array.from(entries).slice(0, 3).map((s) => `"${s.slice(0, 40)}"`).join(", ")}`;
    });
  } catch {
    return "";
  }
}

/**
 * A CONTROL'S IDENTITY CAN LIVE OUTSIDE ITS TEXT.
 *
 * Every REVEAL_TRIGGER above finds the login control by what it SAYS. Des Moines WA
 * (PermitTrax) has no such control: its sign-in is a Bootstrap dropdown whose toggle is a
 * bare icon — `<button class="dropdown-toggle"><i class="bi-person-circle"></i></button>`
 * — with no text, no aria-label and no login token in its id. The words SIGN IN and
 * REGISTER exist only inside the closed `<ul class="dropdown-menu">` it opens, and the
 * only thing naming the toggle is a tooltip: "Click to Sign In / Register a New Account".
 *
 * That portal was scored "the portal's login form was not recognised" — the engine's
 * fault, correctly, and this is the fault. It is the same shape as an application category
 * hidden in a closed fieldset or a radio with no innerText: PRESENT BUT SHUT. So look for
 * a control described as a login by anything OTHER than its own text — tooltip, title,
 * aria-label, a neighbouring <label>, or the contents of the menu it opens.
 *
 * Deliberately narrow. It considers only controls with no meaningful text of their own,
 * because a control that says what it is has already been handled above, and widening this
 * is how a reveal pass starts clicking things it shouldn't. Sign-out is always excluded.
 *
 * Tags the winner with data-al-login-reveal and returns true. Exported for the DOM smoke.
 */
export async function markDescribedLoginControl(page: Page): Promise<string> {
  try {
    return await (page as unknown as { evaluate: (fn: () => string) => Promise<string> }).evaluate(() => {
      const LOGIN = /\blog[\s-]?in\b|\blogin\b|\bsign[\s-]?in\b|\bsignin\b|\bregister\b|\bmy account\b|\bnew account\b/i;
      const LOGOUT = /\blog[\s-]?out\b|\blogout\b|\bsign[\s-]?out\b|\bsignout\b/i;
      const vis = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const st = getComputedStyle(el as HTMLElement);
        return r.width > 2 && r.height > 2 && st.visibility !== "hidden" && st.display !== "none";
      };
      document.querySelectorAll("[data-al-login-reveal]").forEach((n) => n.removeAttribute("data-al-login-reveal"));

      const controls = Array.from(document.querySelectorAll("button, a, [role=button]")).filter(vis);
      for (const el of controls) {
        const own = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
        // Already-worded controls are REVEAL_TRIGGERS' business, not this pass's.
        if (own.length > 3) continue;

        // Everything that describes this control without being its text.
        const described: string[] = [
          el.getAttribute("title") || "",
          el.getAttribute("data-bs-title") || "",
          el.getAttribute("data-original-title") || "",
          el.getAttribute("aria-label") || "",
        ];
        const describedBy = el.getAttribute("aria-describedby") || el.getAttribute("aria-labelledby") || "";
        for (const id of describedBy.split(/\s+/).filter(Boolean)) {
          described.push(document.getElementById(id)?.textContent || "");
        }
        // A <label> sitting beside it, which is how PermitTrax names its dropdown.
        const parent = el.parentElement;
        if (parent) {
          for (const lab of Array.from(parent.querySelectorAll("label"))) described.push(lab.textContent || "");
          const prev = parent.previousElementSibling;
          if (prev?.tagName === "LABEL") described.push(prev.textContent || "");
        }
        // And the menu this control opens: aria-controls, or a dropdown-menu beside it.
        const controlsId = el.getAttribute("aria-controls");
        if (controlsId) described.push(document.getElementById(controlsId)?.textContent || "");
        const menu = parent?.querySelector(".dropdown-menu, [role=menu], ul");
        if (menu) described.push(menu.textContent || "");

        const hay = described.join(" ").replace(/\s+/g, " ").trim();
        if (!hay || !LOGIN.test(hay)) continue;
        // A menu holding BOTH is a session menu; only skip when sign-out is all there is.
        if (LOGOUT.test(hay) && !LOGIN.test(hay.replace(LOGOUT, ""))) continue;

        el.setAttribute("data-al-login-reveal", "1");
        return hay.slice(0, 90);
      }
      return "";
    });
  } catch {
    return "";
  }
}

/**
 * A PAGE THAT PROMISES TO FORWARD YOU, AND DOESN'T.
 *
 * Wilsonville (Tyler EnerGov) hands off to an identity provider through a stub page whose
 * entire content is "Click here if you are not forwarded within 10 seconds." Waited out to
 * 16 seconds, it never forwards — the automatic hop depends on something that does not
 * happen in our session — so the run sat on a page with no fields at all and reported
 * "the portal's login form was not recognised". It had been offered the way through in
 * plain words and did not take it.
 *
 * This idiom is not Tyler's: SAML and OAuth hand-offs, session bounces and "please wait"
 * pages all ship the same manual escape hatch for exactly this case. Clicking it is what a
 * person does without thinking.
 *
 * Narrow by construction — it matches the FORWARDING SENTENCE, not the word "click", and
 * never a control that also reads as a submit, a payment or a final action. Returns what it
 * clicked, or "".
 *
 * Exported for the DOM smoke.
 */
export async function followForwardingInterstitial(page: Page): Promise<string> {
  try {
    const marked = await (page as unknown as { evaluate: (fn: () => string) => Promise<string> }).evaluate(() => {
      // "if you are not forwarded/redirected", "click here to continue", "press here if
      // the page does not load" — the sentence, not the verb.
      const FORWARD = /(not (being )?(automatically )?(forwarded|redirected|transferred))|((forwarded|redirected)\b[^.]{0,30}\bwithin\b)|(click (here )?to continue)|(continue to (the )?(login|sign[\s-]?in|site|portal))|(if .{0,30}(page|browser) does ?n[o']t (load|redirect|forward))/i;
      // Anything that could COMMIT something is never a "continue" link.
      const NEVER = /\bsubmit\b|\bpay\b|\bpayment\b|\bdelete\b|\bcancel\b|\bwithdraw\b|\bsign out\b|\blog ?out\b/i;
      const vis = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const st = getComputedStyle(el as HTMLElement);
        return r.width > 2 && r.height > 2 && st.visibility !== "hidden" && st.display !== "none";
      };
      document.querySelectorAll("[data-al-forward]").forEach((n) => n.removeAttribute("data-al-forward"));
      for (const el of Array.from(document.querySelectorAll("a, button, [role=button], [role=link]"))) {
        if (!vis(el)) continue;
        const text = ((el as HTMLElement).innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 120) continue;
        if (NEVER.test(text)) continue;
        // The sentence may be on the link itself, or the link may be the bare "here" inside
        // it — so check the containing block too, but only a small one.
        const parentText = (el.parentElement?.innerText || "").replace(/\s+/g, " ").trim();
        const hay = `${text} ${parentText.length <= 200 ? parentText : ""}`;
        // The NEVER-list is checked against the SENTENCE too, not just the link. A bare
        // "here" inside "click here to pay your fees" would otherwise pass, because the
        // link's own two words say nothing dangerous.
        if (NEVER.test(hay)) continue;
        if (!FORWARD.test(hay)) continue;
        el.setAttribute("data-al-forward", "1");
        return text.slice(0, 80);
      }
      return "";
    });
    if (!marked) return "";
    await page.locator("[data-al-forward]").first().click({ timeout: 5000 });
    await smartWait(page, 4000);
    return marked;
  } catch {
    return "";
  }
}

/**
 * SOMETHING IS SITTING ON TOP OF THE LOGIN CONTROL.
 *
 * Wilsonville (Tyler EnerGov) failed as "the portal's login form was not recognised" three
 * runs in a row. Its reveal trail, once it kept the useful end of the error, said exactly
 * what was wrong:
 *
 *   <div class="modal fade ng-isolate-scope in"
 *        ng-style="{'z-index': 1050 + index*10, display: 'block'}"> subtree intercepts
 *        pointer events
 *
 * An Angular modal backdrop over the login link. Not a detection failure at all — the
 * control was found every time and could not be reached.
 *
 * The adapter already solves this for the page walk (neutralizeInterceptor), but the login
 * flow runs before any of that and had no equivalent. It cannot import the adapter's copy
 * either: the adapter imports this module, so that way is a cycle. Hence a small local one.
 *
 * pointer-events:none rather than removal — the overlay stays on the page, exactly as the
 * adapter's version does, so nothing about the portal's own state is destroyed. Best-effort
 * and non-throwing; returns what it neutralised, for the trail.
 */
async function neutralizeOverlayOver(page: Page, loc: Locator): Promise<string> {
  try {
    const box = await (loc as unknown as { boundingBox?: () => Promise<{ x: number; y: number; width: number; height: number } | null> })
      .boundingBox?.().catch(() => null);
    if (!box || box.width < 1 || box.height < 1) return "";
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    return await (page as unknown as { evaluate: (fn: (p: { x: number; y: number }) => string, arg: { x: number; y: number }) => Promise<string> })
      .evaluate((p) => {
        const hit = document.elementFromPoint(p.x, p.y);
        if (!hit) return "";
        const neutralised: string[] = [];
        let node: Element | null = hit;
        // Walk up from whatever is actually under the cursor. Anything POSITIONED or
        // stacked above the flow, and big enough to be a cover rather than a control, is
        // an interceptor. Bounded so a deep tree cannot spin.
        for (let depth = 0; node && depth < 8; depth++) {
          const el = node as HTMLElement;
          const st = getComputedStyle(el);
          const z = Number(st.zIndex) || 0;
          const r = el.getBoundingClientRect();
          const positioned = st.position === "fixed" || st.position === "absolute" || st.position === "sticky";
          const large = r.width * r.height > 40000;
          if ((positioned || z > 0) && large && el.tagName !== "BODY" && el.tagName !== "HTML") {
            el.style.pointerEvents = "none";
            neutralised.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(/\s+/)[0] || "-"}`);
          }
          node = el.parentElement;
        }
        return neutralised.slice(0, 3).join(", ");
      }, { x, y });
  } catch {
    return "";
  }
}

/**
 * A DIALOG IN THE WAY MAY BE THE NEXT STEP, NOT AN OBSTRUCTION.
 *
 * Wilsonville cost five live runs before its captured page gave the answer away. The modal
 * that kept intercepting the login click was not a cover at all:
 *
 *   "You are being redirected to Tyler Identity login page for authorization purposes.
 *    Once authenticated, you will be logged into CSS."
 *   <button id="modalOkBtn" ng-click="ok()">Continue</button>
 *
 * The login click had worked on every one of those runs. It opened a confirmation dialog
 * with a Continue button, and the engine spent its budget trying to click THROUGH the thing
 * it was supposed to press — the capture shows pointer-events:none set on the very dialog
 * that held the way forward.
 *
 * So an intercepting overlay gets read before it gets neutralised. Deliberately narrow:
 *
 *   - the dialog must SAY it is a continuation to a login or authorisation, so an arbitrary
 *     announcement or a survey prompt is not "continued" into;
 *   - it must NOT be a cookie or consent dialog. Those are a decision about the user's
 *     privacy, not a step in a filing, and pressing their affirmative button is exactly the
 *     wrong default;
 *   - the button must be a plain affirmative — Continue, OK, Proceed — never Accept, which
 *     is consent wording, and never anything that reads as filing or paying.
 */
export async function clickLoginContinuation(page: Page): Promise<string> {
  try {
    const marked = await (page as unknown as { evaluate: (fn: () => string) => Promise<string> }).evaluate(() => {
      const CONTINUATION = /redirect|being taken|authoriz|authentic|continue to (the )?(login|sign)|identity (provider|login)|you will be logged/i;
      const CONSENT = /\bcookie|\bconsent\b|\btracking\b|privacy preferences|we use .{0,20}cookies/i;
      const AFFIRM = /^(continue|ok|okay|proceed|next)$/i;
      const vis = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const st = getComputedStyle(el as HTMLElement);
        return r.width > 2 && r.height > 2 && st.visibility !== "hidden" && st.display !== "none";
      };
      document.querySelectorAll("[data-al-continue]").forEach((n) => n.removeAttribute("data-al-continue"));
      const dialogs = Array.from(document.querySelectorAll(
        "[role=dialog], [role=alertdialog], .modal, .modal-dialog, .modal-content, .mat-dialog-container, .cdk-overlay-pane",
      )).filter(vis);
      for (const dlg of dialogs) {
        const text = ((dlg as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
        if (!text || !CONTINUATION.test(text)) continue;
        if (CONSENT.test(text)) continue;
        for (const btn of Array.from(dlg.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]"))) {
          if (!vis(btn)) continue;
          const label = ((btn as HTMLElement).innerText || (btn as HTMLInputElement).value || btn.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ").trim();
          if (!AFFIRM.test(label)) continue;
          btn.setAttribute("data-al-continue", "1");
          return `${label} — ${text.slice(0, 90)}`;
        }
      }
      return "";
    });
    if (!marked) return "";
    await page.locator("[data-al-continue]").first().click({ timeout: 4000 });
    await smartWait(page, 4000);
    return marked;
  } catch {
    return "";
  }
}

/**
 * IS THIS AN ERROR OR BLOCK PAGE RATHER THAN A PORTAL?
 *
 * Baltimore County's stored URL answers with a CloudFront refusal — title "ERROR: The
 * request could not be satisfied", body "403 ERROR ... Request blocked." The run reported
 * "the portal's login form was not recognised" and the benchmark filed it under ENGINE.
 * There was no login form because there was no page.
 *
 * The scorer already treats a WAF block as the portal's problem, and looksBotBlocked
 * already retries such a run with a real window. Both read the run's MESSAGE, and the 403
 * lived only in the page — so naming it here is what connects evidence already on screen to
 * machinery already written for it.
 *
 * Deliberately anchored on the TITLE and the first stretch of body text: a permit portal
 * whose page happens to contain the word "error" further down is not a blocked request.
 */
export async function detectErrorPage(page: Page): Promise<string> {
  try {
    return await (page as unknown as { evaluate: (fn: () => string) => Promise<string> }).evaluate(() => {
      const BLOCK = /request could not be satisfied|\b403\b|\b404\b|\b50[0-9]\b|access denied|forbidden|request blocked|service unavailable|temporarily unavailable|under maintenance|site maintenance|page not found|bad gateway/i;
      const title = (document.title || "").replace(/\s+/g, " ").trim();
      const head = ((document.body?.innerText || "").replace(/\s+/g, " ").trim()).slice(0, 260);
      // A real portal has controls. A block page is prose and nothing else — requiring both
      // the wording AND an absence of form controls keeps this off a working page that
      // merely mentions an error.
      const controls = document.querySelectorAll("input, select, textarea, button").length;
      if (!BLOCK.test(title) && !BLOCK.test(head)) return "";
      if (controls > 6) return "";
      return `${title || "(untitled)"} — ${head.slice(0, 120)}`;
    });
  } catch {
    return "";
  }
}
