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
  | "already_authenticated" // no login form present (persistent session still valid)
  | "no_credential" // a login form is present but no credential was supplied
  | "still_on_login" // filled + submitted, but the form is still showing (bad creds)
  | "mfa_captcha" // a challenge appeared — a human must finish
  | "no_username_field" // a password field exists but no username field could be found
  | "no_submit_control" // fields filled but no login button/link could be found
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
  { label: "Username" },
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
  { css: 'input[type="password"]' }, // universal
];

const SUBMIT_CANDIDATES: RecipeSelector[] = [
  { css: "#LoginButton" }, // PowerClerk (verified live — a <button> with NO type)
  { css: "#hlLogin, #btnLogin, #ctl00_PlaceHolderMain_LoginBox_btnLogin" }, // Accela
  { role: "button", name: "Log In" }, // PowerClerk button text (verified)
  { role: "button", name: "Sign In" },
  { role: "button", name: "Login" },
  { role: "link", name: "Log In" }, // Accela's login control is an <a>
  { role: "link", name: "Login" },
  { css: 'input[type="submit"], button[type="submit"]' },
  { css: 'button[id*="login" i], a[id*="login" i], input[id*="login" i]' },
];

// Triggers that REVEAL a hidden login form (portal shows only a "Log In" link until clicked).
const REVEAL_TRIGGERS: RecipeSelector[] = [
  { css: '#ctl00_HeaderNavigation_btnLogin' }, // Accela header "Login"
  { role: "link", name: "Login" },
  { role: "link", name: "Log In" },
  { role: "link", name: "Sign In" },
  { role: "button", name: "Login" },
  { role: "button", name: "Log In" },
  { css: 'a[href*="login" i], a[id*="login" i]' },
];

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
async function firstVisible(page: Page, candidates: RecipeSelector[]): Promise<Locator | null> {
  const scopes: Array<Page | Frame> = typeof page.frames === "function" ? page.frames() : [page];
  for (const sel of candidates) {
    for (const scope of scopes) {
      const loc = buildLocator(scope, sel);
      if (!loc) continue;
      try {
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
      } catch {
        // malformed selector or cross-origin frame — try the next scope/candidate
      }
    }
  }
  return null;
}

// Is a password field present? The reliable structural signal that we're on a login form.
export async function loginFormPresent(page: Page): Promise<boolean> {
  return (await firstVisible(page, PASSWORD_CANDIDATES)) !== null;
}

// If no login form is visible, click a "Log In" trigger to reveal one (Accela pattern).
// Returns true if a form became present after revealing.
export async function revealLoginForm(page: Page): Promise<boolean> {
  if (await loginFormPresent(page)) return true;
  const trigger = await firstVisible(page, REVEAL_TRIGGERS);
  if (!trigger) return false;
  try {
    await trigger.click();
    await smartWait(page, 3000);
  } catch {
    return false;
  }
  return loginFormPresent(page);
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
    let present = await loginFormPresent(page);
    if (!present) present = await revealLoginForm(page);

    // 2) No form yet. Distinguish "session valid (redirected off the login page)" from
    //    "form just hasn't rendered". If we're STILL on a login/sign-in URL, the form is
    //    almost certainly mid-render — poll a few seconds before concluding anything, so
    //    we never mistake an unrendered login page for an authenticated session.
    if (!present) {
      const url = (typeof page.url === "function" ? page.url() : "").toLowerCase();
      const onLoginUrl = /login|sign-?in|account\/(login|signin)|logon/.test(url);
      if (onLoginUrl) {
        const deadline = Date.now() + 8000;
        while (!present && Date.now() < deadline) {
          await smartWait(page, 1500);
          present = await loginFormPresent(page);
          if (!present) present = await revealLoginForm(page);
        }
      }
    }

    // 3) Still no form. If we're STILL on a login URL, do NOT claim an authenticated
    //    session — that's a detection miss (e.g. an iframed/odd login form), not success.
    //    Only conclude "authenticated" when we're off any login URL.
    if (!present) {
      const url = (typeof page.url === "function" ? page.url() : "").toLowerCase();
      if (/login|sign-?in|account\/(login|signin)|logon/.test(url)) {
        return { ok: false, status: "still_on_login", message: "On a login page but the login form could not be located (it may be inside an iframe or use an unusual layout). Record this portal manually." };
      }
      return { ok: true, status: "already_authenticated", message: "No login form present — using the existing session." };
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

    // 5) Fill username + password.
    const userLoc = await firstVisible(page, USERNAME_CANDIDATES);
    if (!userLoc) {
      return { ok: false, status: "no_username_field", message: "Found a password field but could not locate the username/email field — the portal layout is unusual. Record it manually." };
    }
    await waitForElement(userLoc);
    await userLoc.fill(credential.username);

    const passLoc = await firstVisible(page, PASSWORD_CANDIDATES);
    if (!passLoc) {
      return { ok: false, status: "no_username_field", message: "Password field disappeared after filling the username — record this portal manually." };
    }
    await waitForElement(passLoc);
    await passLoc.fill(credential.password);

    // 6) Submit.
    const submitLoc = await firstVisible(page, SUBMIT_CANDIDATES);
    if (!submitLoc) {
      return { ok: false, status: "no_submit_control", message: "Filled the login form but could not find the Log In button — record this portal manually." };
    }
    const loginUrl: string = typeof page.url === "function" ? page.url() : "";
    await waitForElement(submitLoc);
    await submitLoc.click();

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

    // 8) Timed out with the form still showing → credentials were rejected (or login stalled).
    return { ok: false, status: "still_on_login", message: "Still on the login form after submitting — the stored username/password was likely rejected. Verify the credential for this portal, then retry." };
  } catch (err) {
    return { ok: false, status: "error", message: `Login failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
