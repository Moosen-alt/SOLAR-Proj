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
export async function revealLoginForm(page: Page): Promise<boolean> {
  if (await loginFormPresent(page)) return true;
  let tried = triedTriggers.get(page as unknown as object);
  if (!tried) { tried = new Set<string>(); triedTriggers.set(page as unknown as object, tried); }
  for (const sel of REVEAL_TRIGGERS) {
    const key = triggerKey(sel);
    if (tried.has(key)) continue;
    const trigger = await firstVisible(page, [sel]);
    if (!trigger) continue;
    tried.add(key);
    try {
      await trigger.click();
      await smartWait(page, 3000);
    } catch {
      continue; // this control wasn't clickable — try the next kind
    }
    if (await loginFormPresent(page)) return true;
    // Clicked something that didn't produce a form; the next call tries the next trigger.
    return false;
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
