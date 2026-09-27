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
import { detectChallengeFrame, detectSecondFactor, sleep, smartWait, waitForElement } from "../safeAction";
import { resolveHeadless } from "../browser";

export interface Credential {
  username: string;
  password: string;
}

export type LoginStatus =
  | "logged_in" // a form was filled and submitted, and the session is POSITIVELY proven (see the poll in performLogin)
  | "already_authenticated" // no login form present AND a positive authenticated signal (logout/session valid)
  | "no_credential" // a login form is present but no credential was supplied
  | "still_on_login" // filled + submitted, and the portal is STILL showing a login page (bad creds, or an unfinished two-step)
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
  // Okta's password step ("Verify with your password") submits with a bare "Verify". Exact, so
  // "Verify with something else" — the factor picker, never ours — can never match it.
  { role: "button", name: "Verify", exact: true },
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

/**
 * CONTROLS A LOGIN NEVER CLICKS — whatever candidate list matched them.
 *
 * Tyler's sign-in (Okta, on identity.tylerportico.com) puts, beside its Email box and Next
 * button: "Sign in with Google/Microsoft/Apple…" social buttons, "Keep me signed in", "Help",
 * "Unlock account" and "Create an account"; its password page adds "Verify with something else",
 * "Forgot password?" and "Back to sign in". The candidate lists are loose on purpose (a
 * non-exact {role:button, name:"Sign In"} matches "Sign in with Google"; {name:"Continue"}
 * matches "Continue with Google"; the href-based reveal matches Okta's /help/login), so a
 * control is judged by what IT is, after it matched and before it is clicked:
 *
 *   - SOCIAL: a third-party consumer identity provider ("… with Google", an icon button named
 *     only "Microsoft", Okta's `social-auth-*` buttons, `/sso/idps/` routing). Clicking one hands
 *     the flow to a DIFFERENT identity — and the portal password could then be typed into that
 *     provider's form (a secret to a third party; see thirdPartyIdentityHost for the backstop).
 *   - ALWAYS: help, unlock, forgot/reset password, keep me signed in / remember me, "verify with
 *     something else" (the factor picker — a second factor is a human's, rule 1), "back to sign
 *     in", "trouble signing in". None of them ever advances a login.
 *   - SIGN-UP: create an account / register / sign up — UNLESS the same control also offers the
 *     login ("Login or Register" is Wilsonville's real reveal link and must keep working).
 *   - Any checkbox or radio: "Keep me signed in" is one, and a login has no business ticking it.
 *
 * ONE vocabulary, passed as sources into every in-page check, so the reveal pass, the Next pick,
 * the submit pick and the described-control pass cannot disagree about it.
 */
const SOCIAL_IDP_SOURCE = "\\b(with|using|via)\\s+(google|microsoft|apple|facebook|linkedin|github|twitter|amazon|yahoo|paypal)\\b|^(google|microsoft|apple|facebook|linkedin|github|twitter|amazon|yahoo|paypal)$";
const NEVER_ALWAYS_SOURCE = "\\bhelp\\b|\\bunlock\\b|\\bforgot\\b|\\breset (your |my )?password\\b|\\bkeep me (signed|logged) in\\b|\\bremember me\\b|\\bstay signed in\\b|verify with something else|\\bback to (sign|log)[\\s-]?in\\b|\\btrouble (signing|logging)\\b|can'?t (sign|log)[\\s-]?in";
const NEVER_SIGNUP_SOURCE = "\\bcreate (an |your |a new |new )?account\\b|\\bregist(er|ration)\\b|\\bsign[\\s-]?up\\b|\\bnew account\\b|\\benroll\\b";
const LOGIN_WORD_SOURCE = "\\blog[\\s-]?(in|on)\\b|\\blogin\\b|\\blogon\\b|\\bsign[\\s-]?in\\b|\\bsignin\\b";
// A LOGIN NEVER FOLLOWS A PAYMENT LINK (production 2026-09-27, City of Tigard OR). The reveal's
// href catch-all (a[href*=login|account|signin]) clicked a link on the EnerGov self-service home
// that led to Tyler PAYMENTS' sign-in (redirect_uri …/payments/checkout/signin-centralcallback):
// the same Tyler identity, so the portal's credential would have signed in to the checkout app and
// the learn would have started there. Rule 1 territory, and never the permit portal's login.
const NEVER_PAY_HREF_SOURCE = "(^|/)(payments?|checkout|cart|billing|invoices?|pay)(/|$)|^https?://(www\\.)?(pay|payments?|checkout|billing)[.-]";
const NEVER_HREF_SOURCE = `/sso/idps/|accounts\\.google\\.|facebook\\.com|appleid\\.apple\\.com|login\\.live\\.com|github\\.com/login|linkedin\\.com/oauth|/help(/|$)|/signin/(unlock|forgot|register)|/(register|signup|sign-up)(/|$)|forgot-?password|reset-?password|${NEVER_PAY_HREF_SOURCE}`;
const NEVER_CLICK_PATTERNS = {
  social: SOCIAL_IDP_SOURCE,
  always: NEVER_ALWAYS_SOURCE,
  signup: NEVER_SIGNUP_SOURCE,
  login: LOGIN_WORD_SOURCE,
  href: NEVER_HREF_SOURCE,
};

/** Why this matched control must never be clicked by a login, or "" when it may be. */
async function neverClickReason(loc: Locator): Promise<string> {
  try {
    return await (loc as unknown as { evaluate: (fn: (el: Element, p: typeof NEVER_CLICK_PATTERNS) => string, arg: typeof NEVER_CLICK_PATTERNS) => Promise<string> })
      .evaluate((el, p) => {
        // Fully inline — no named helper (see the note in authenticatedSignalPresent).
        const type = ((el as HTMLInputElement).type || "").toLowerCase();
        if (el.tagName === "INPUT" && (type === "checkbox" || type === "radio")) return "a checkbox/radio";
        const role = (el.getAttribute("role") || "").toLowerCase();
        if (role === "checkbox" || role === "radio" || role === "switch") return "a checkbox/radio";
        const name = String((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ").trim();
        const cls = String((el as HTMLElement).className || "");
        const a = el.closest("a");
        const href = String((a && a.getAttribute("href")) || el.getAttribute("href") || "").split(/[?#]/)[0];
        if (new RegExp(p.social, "i").test(name) || /social-auth/i.test(cls)) return `a third-party sign-in ("${name.slice(0, 40)}")`;
        if (new RegExp(p.href, "i").test(href)) return `an account-chore / identity-provider / payment link (${href.slice(0, 60)})`;
        if (new RegExp(p.always, "i").test(name)) return `an account-chore control ("${name.slice(0, 40)}")`;
        if (new RegExp(p.signup, "i").test(name) && !new RegExp(p.login, "i").test(name)) return `a sign-up control ("${name.slice(0, 40)}")`;
        return "";
      }, NEVER_CLICK_PATTERNS);
  } catch {
    return "";
  }
}

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
/**
 * ONE LOGIN-URL TEST, USED EVERYWHERE.
 *
 * This predicate existed in FOUR copies. Three of them read
 * `/login|sign-?in|account\/(login|signin)|logon/`; the success poll read a bare `/login/i`.
 * That single disagreement is what let a submitted login "succeed" by landing on a SECOND
 * login page: Baltimore County correctly followed www.baltimorecountymd.gov ->
 * cityworkspro.baltimorecountymd.gov, arrived at `/auth/signin`, and the poll's `/login/i`
 * saw a URL that had moved and did not contain the word "login" — so it reported the run
 * logged in and the walk went off to plan fills on a sign-in form.
 *
 * A predicate with four spellings has four behaviours.
 *
 * `register` IS DELIBERATELY NOT IN HERE. It was, for exactly one commit, on the reasoning
 * that a "create an account" page is a login page for our purposes — and that was a clean
 * regression, because this predicate gates far more than the success poll. It is what
 * loginWordingPresent returns true on from the URL ALONE (satisfying the two-step-login
 * branch), and it is what sets `onLoginUrl` (suppressing the no_login_required path). Since
 * USERNAME_CANDIDATES includes {label:"Email"} and input[type=email], and
 * NEXT_STEP_CANDIDATES includes the catch-all button[type=submit], an ordinary ACCOUNT-LESS
 * PUBLIC APPLICATION FORM satisfied every structural clause the moment its URL carried the
 * word. Verified over ONE identical form — 8 fields, an Email input, a "Submit Request"
 * button, no password field anywhere — served at two paths:
 *     /permits/apply                      -> ok=true,  no_login_required (the walk proceeds)
 *     /permits/register-a-solar-project   -> ok=false, no_credential
 * So the operator was told to supply a username and password for a portal that has no
 * accounts — and worse, WITH a credential the two-step branch would have typed the username
 * into that Email field and clicked "Submit Request", filing a stranger's permit request.
 * It also matched every post-login landing containing the substring — /registered/home,
 * /RegisteredUser/Dashboard, /Account/Home?registered=true — each of which would then make
 * the success poll unable to conclude logged_in.
 *
 * The real hazard `register` was added for (step 1 of a registration wizard read as a public
 * form) is closed by isRegistrationUrl below, at the ONE site where that hazard lives.
 *
 * DELIBERATELY NOT widened to auth/sso/idp/oauth: real post-login URLs read
 * `/authenticated/home` and `/sso/dashboard`, and a URL regex is only ever a cheap
 * pre-filter here. The discriminator that carries the weight is loginPageShape.
 */
export function looksLikeLoginUrl(url: string): boolean {
  return /login|sign-?in|account\/(login|signin)|logon/i.test(url || "");
}

/**
 * IS THIS URL A "CREATE AN ACCOUNT" PAGE?
 *
 * Separate from looksLikeLoginUrl ON PURPOSE — see the note above for what happened when the
 * word lived in the shared predicate. This one is consulted at exactly ONE site: the
 * application-shaped-form wave-through in performLogin, and only in conjunction with a
 * POSITIVE account signal on the page (accountAffordancePresent). Either half alone is wrong:
 * a register-shaped URL alone condemns Gilbert-style public forms ("register a solar
 * project"), and an account signal alone is on half the permit portals in the fleet.
 *
 * WORD-BOUNDED, because a bare `register` substring also matches "registered", and
 * /registered/home, /RegisteredUser/Dashboard and /Account/Home?registered=true are POST-login
 * landings — the last place we want to start doubting a session.
 */
export function isRegistrationUrl(url: string): boolean {
  return /\bregist(er|ration)\b/i.test(url || "");
}

/** Does this page SAY it is a login? Title, then visible copy. Both traced Cloudpermit pages
 *  were titled "Cloudpermit - Log In" — including the one we recorded as signed in — so the
 *  title is checked first and is often the only thing that still says so after a re-render. */
async function loginWordingPresent(page: Page): Promise<boolean> {
  if (looksLikeLoginUrl(typeof page.url === "function" ? page.url() : "")) return true;
  const title = await page.title().catch(() => "");
  if (/log\s?-?\s?in|sign\s?-?\s?in|logon|log on/i.test(title || "")) return true;
  return await page.getByText(/sign in|log in|password|logon/i).first().isVisible().catch(() => false);
}

/**
 * IS THE PAGE IN FRONT OF US A LOGIN PAGE?
 *
 * The engine had no such question. It had only `loginFormPresent`, which asks exactly one
 * thing — is a password field visible — and on an IDENTIFIER-FIRST login (Cloudpermit, Okta,
 * Microsoft, essentially every SSO front door) step 1 has no password field at all. So "the
 * password field is gone" is the NORMAL state of a login that has not happened, and the
 * success poll was reading it as proof of a session.
 *
 * Cost, measured: us.cloudpermit.com/gov/login was stamped `last_login_ok_at` "login
 * accepted" and counted in the fleet's "26 accessible", having never logged in. The recipe
 * then bound installerEmail to `#input-email-new` — a LOGIN FIELD — because the walk was
 * handed a login form and asked to plan fills on it. That is also how a credential ends up
 * typed into a field the planner chose.
 *
 * Two ways a page says it is a login, matching the two ways portals build them:
 *   A) STRUCTURAL — an identifier-shaped field plus either a password field or a next-step
 *      control, on a page whose wording is about signing in. This catches the two-step page
 *      that has no password anywhere.
 *   B) POSITIONAL — a login/sign-in/logon URL with no signed-in signal on it. A page that
 *      is genuinely behind the login shows a sign-out control and is excluded by that.
 *      (NOT a register URL — see looksLikeLoginUrl for what happened when it was one.)
 *
 * Returns the evidence (for the run's message and the bundle), or "" when the page is not a
 * login.
 *
 * EXPORTED FOR THE DOM SMOKE — NOT FOR THE WALK, WHICH NEVER CALLS IT.
 *
 * This comment used to claim it was "exported so the walk can refuse to hand a login page to
 * the field planner", presented as the thing that closes the Cloudpermit hazard. No such
 * caller exists: outside this file the only importer is loginProof.dom.smoke.ts. The hazard
 * IS closed — but by a different mechanism, and a comment that names a guard which is not
 * there is precisely how it reopens: the next reader deletes the real guard believing this
 * one covers it.
 *
 * WHERE THE PROTECTION ACTUALLY LIVES, and what must not change:
 *   1. performLogin refuses to return a SUCCESS status for a page it cannot prove a session
 *      on — it returns still_on_login / login_form_unrecognized instead (step 7/8 below).
 *   2. autoLearnAdapter.ts gates the whole walk on a three-status ALLOWLIST:
 *          if (result.status === "logged_in" || result.status === "already_authenticated"
 *              || result.status === "no_login_required")       // ~autoLearnAdapter.ts:2498
 *      and returns `ok: false` for everything else (~autoLearnAdapter.ts:2518) BEFORE any
 *      field extraction or planning happens. That allowlist is the guard. Widening it, or
 *      turning it into a denylist ("everything except mfa_captcha"), is what would let a
 *      login form reach the field planner again — which is how the recipe came to bind
 *      installerEmail to `#input-email-new`, a login field.
 * loginProof.dom.smoke.ts pins (1) end to end; routeScope-style structural tests do not pin
 * (2), so the line above is the one to grep for before touching that status handling.
 *
 * NOT WIRED INTO THE WALK INSTEAD, deliberately: the walk's login call already holds this
 * answer in performLogin's status, and a second, independently computed refusal at the top
 * of the walk is two predicates that can disagree — the exact failure mode recorded in the
 * looksLikeLoginUrl note above, where one predicate in four spellings had four behaviours.
 */
export async function loginPageShape(page: Page): Promise<string> {
  try {
    // A) structural.
    const idField = await firstVisible(page, USERNAME_CANDIDATES, { fillable: true });
    if (idField) {
      const pwField = await firstVisible(page, PASSWORD_CANDIDATES, { fillable: true });
      const nextCtl = pwField ? null : await firstVisible(page, NEXT_STEP_CANDIDATES);
      if ((pwField || nextCtl) && await loginWordingPresent(page)) {
        return pwField
          ? "an identifier field, a password field and sign-in wording"
          : "an identifier field, a next-step control and sign-in wording, and no password field — an identifier-first login still on step 1";
      }
    }
    // B) positional.
    const url = typeof page.url === "function" ? page.url() : "";
    if (looksLikeLoginUrl(url) && !(await authenticatedSignalPresent(page))) {
      let path = url;
      try { path = new URL(url).pathname || url; } catch { /* not an absolute URL */ }
      return `a login URL (${path.slice(0, 60)}) with no signed-in signal on the page`;
    }
    return "";
  } catch {
    return "";
  }
}

async function authenticatedSignalPresent(page: Page): Promise<boolean> {
  if (await firstVisible(page, AUTHENTICATED_SIGNALS)) return true;
  // TEXT FALLBACK: a visible sign-out CONTROL the css selectors above missed.
  //
  // This was `^(log out|sign out|log off|sign off)$` — anchored to the exact phrase, on any
  // element. Both halves of that were wrong for the commonest authenticated page in this
  // fleet. ASP.NET portals authenticate by __doPostBack to the SAME URL and render sign-out
  // as `<a onclick="doLogout()">Log Off Account</a>`: no logout token in href or id (so the
  // css candidates miss it), and one word too long for the ^...$ anchor (so the fallback
  // missed it too). With no URL move and no chrome signal, the success poll burned its whole
  // 15s and returned still_on_login — a login that used to work, now failing.
  //
  // So: a BOUNDED CONTAINS (under 30 characters) rather than an exact match. Two tightenings
  // pay for the loosening, because widening a POSITIVE session signal is the dangerous
  // direction — a false one is banked as knowledge:
  //   - CONTROLS ONLY (a/button/role=button/role=link/role=menuitem/input buttons/[onclick]),
  //     never bare prose. The old version matched any element, so "…click Log Out when you
  //     are finished" in a help paragraph would now qualify if prose were still in scope.
  //   - instructional wording excluded: "How to log out", "Need help signing out?" are
  //     documentation links on a PUBLIC page, and reading one as a session is the eTRAKiT
  //     false-success this whole module exists to prevent.
  try {
    return await (page as unknown as { evaluate: (fn: () => boolean) => Promise<boolean> }).evaluate(() => {
      // NO HOISTED HELPER OF ANY KIND inside an in-page callback: the bundler's keepNames
      // transform wraps anything it can name — `const vis = (el) => …` included — as
      // `__name(fn, "vis")`, and `__name` does not exist in the browser. Verified in real
      // Chromium (see autoLearnAdapter.waitForAutosaveIndicator). Everything below is inline
      // for that reason, and the DOM smokes' __name shim would hide the break if it were not.
      const controls = Array.from(document.querySelectorAll(
        "a, button, [role=button], [role=link], [role=menuitem], input[type=button], input[type=submit], [onclick]",
      ));
      for (const el of controls) {
        const r = (el as HTMLElement).getBoundingClientRect();
        const st = getComputedStyle(el as HTMLElement);
        // A sign-out hidden inside a CLOSED account dropdown is not a signal a human could
        // see, and is not treated as one — that case is carried by submittedIdentityEchoed.
        if (!(r.width > 2 && r.height > 2 && st.visibility !== "hidden" && st.display !== "none")) continue;
        const text = String(
          (el as HTMLElement).innerText
          || (el as HTMLInputElement).value
          || el.getAttribute("aria-label")
          || el.getAttribute("title")
          || "",
        ).replace(/\s+/g, " ").trim();
        // AN ACCOUNT MENU THAT SAYS IT HOLDS SIGN-OUT. Tyler EnerGov self-service keeps "Log Out"
        // inside a CLOSED greeting dropdown whose visible toggle reads the person's name and is
        // labelled "User dropdown menu to update profile, view invoices, or logout" — while the
        // logged-out toggle is "Guest dropdown menu to login or register" (production
        // 2026-09-27, City of Tigard: a person finished the login by hand in the open window and
        // the run still said "no signed-in signal"). Read from the toggle's OWN label, only when
        // that label names a menu/dropdown AND a sign-out, and never a sign-in/register menu.
        const label = String(el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        if (label && label.length < 140 && /\b(menu|dropdown)\b/i.test(label)
          && /(log|sign)\s?-?\s?(out|off)\b/i.test(label)
          && !/\b(log|sign)\s?-?\s?(in|on)\b|\blogin\b|\bregister\b|\bhow\b|\bhelp\b|\bfaq\b|\?/i.test(label)) return true;
        if (!text || text.length >= 30) continue;
        if (/\bhow\b|\bhelp\b|\bfaq\b|\?/i.test(text)) continue;
        if (/(log|sign)\s?-?\s?(out|off)\b/i.test(text)) return true;
      }
      return false;
    });
  } catch { /* cross-origin or a page mid-navigation */ }
  return false;
}

/**
 * THE SECOND POSITIVE SESSION SIGNAL — ONE THAT DOES NOT DEPEND ON PORTAL CHROME.
 *
 * The poll's rule is right and stays: a session must be PROVEN, never inferred from the
 * absence of a password field. But as written, proof meant a visible sign-out control or a
 * URL move, and a portal that authenticates by postback to the same URL and hides sign-out in
 * a closed account dropdown has neither. It logged in perfectly and we reported
 * still_on_login. ASP.NET __doPostBack logins are common in this fleet, so that costs real
 * portals every run.
 *
 * The extra signal: the password field is GONE *and* the identifier we just submitted is now
 * rendered as page TEXT. A logged-out page cannot show it — we typed it into an input, and an
 * input's value is not innerText. ASP.NET's LoginName control renders exactly the username
 * that was submitted, which is what makes this the natural companion to the case above.
 *
 * WHAT IT REFUSES, because each of these echoes the identifier while NOT being a session:
 *   - a refusal — "We could not find an account for you@example.com", "Invalid password for…"
 *     — which is a login page re-rendered, not a dashboard;
 *   - an OTP / magic-link step — "We sent a code to you@example.com" — where the password
 *     field is legitimately gone, no error word appears anywhere, and detectChallengeFrame
 *     sees nothing because a plain code box is not a CAPTCHA iframe. Reading that as a
 *     session is the Cloudpermit incident wearing a different hat.
 * Any line that mentions the identifier in one of those contexts vetoes the whole signal,
 * rather than merely being skipped: a page holding both is not one we should be guessing on.
 *
 * Matched by case-insensitive indexOf on the FULL submitted username, never by a regex built
 * from it (emails carry `.` and `+`). The email LOCAL PART is deliberately not accepted —
 * "Welcome, permit" is a much weaker coincidence than the whole address, and a false
 * "logged in" is the failure this file is atoning for. Never logs the username.
 */
async function submittedIdentityEchoed(page: Page, username: string): Promise<boolean> {
  const needle = String(username || "").trim();
  if (needle.length < 4) return false;
  try {
    return await (page as unknown as { evaluate: (fn: (n: string) => boolean, arg: string) => Promise<boolean> })
      .evaluate((n) => {
        // Fully inline — no named helper. See the note in authenticatedSignalPresent.
        const low = n.toLowerCase();
        const lines = String((document.body && (document.body as HTMLElement).innerText) || "").split("\n");
        let echoed = false;
        for (const raw of lines) {
          const line = raw.trim();
          if (!line || line.toLowerCase().indexOf(low) < 0) continue;
          if (/invalid|incorrect|not found|could ?n[o']t (find|locate)|cannot find|does ?n[o']t exist|no account|failed|unrecogni|try again|error|denied|locked|expired|\bcode\b|verif|one[\s-]?time|2fa|two[\s-]?factor|\bsent\b|check your (e-?mail|inbox|phone)/i.test(line)) return false;
          echoed = true;
        }
        return echoed;
      }, needle);
  } catch {
    return false;
  }
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

/** CAN A PASSWORD ACTUALLY BE TYPED INTO THIS? A username/password candidate that resolves to
 *  a <label>, a wrapper div or a heading is not a near miss — it is a login that fails with
 *  "Element is not an <input>, <textarea>, <select> or [contenteditable]" and gets recorded as
 *  a refused credential.
 *
 *  Measured live on Snohomish County's PDS portal, whose markup is as plain as it gets —
 *  input#username_ID[name=username] and input#password_ID[name=password] — and which still
 *  failed, because `{ label: "Username" }` is tried before the id/name selectors and matched
 *  something that is not a field. The reliable candidate was four entries further down the
 *  list and never got its turn. */
async function isFillable(loc: Locator): Promise<boolean> {
  try {
    return await loc.evaluate((el: Element) => {
      const tag = el.tagName.toLowerCase();
      if (tag === "textarea" || tag === "select") return true;
      if (tag === "input") {
        const t = ((el as HTMLInputElement).getAttribute("type") || "text").toLowerCase();
        return !["checkbox", "radio", "button", "submit", "reset", "file", "image", "hidden"].includes(t);
      }
      return (el as HTMLElement).isContentEditable === true;
    });
  } catch { return false; }
}

/** @param opts.fillable Require the match to be something a value can be TYPED into. Only the
 *  username/password lookups want this: firstVisible is shared with the submit and next-step
 *  candidates, and a Log In button is not fillable — gating those the same way makes every
 *  login control unfindable, which is what the login smokes caught within a minute. */
async function firstVisible(
  page: Page,
  candidates: RecipeSelector[],
  opts: { fillable?: boolean; clickable?: boolean } = {},
): Promise<Locator | null> {
  const scopes: Array<Page | Frame> = typeof page.frames === "function" ? page.frames() : [page];
  // opts.clickable: the match is about to be CLICKED — skip anything on the never-click list
  // (social sign-in, help, unlock, create-account, keep-me-signed-in…). See NEVER_CLICK_PATTERNS.
  const ok = async (loc: Locator): Promise<boolean> =>
    (!opts.fillable || await isFillable(loc)) && (!opts.clickable || !(await neverClickReason(loc)));
  for (const sel of candidates) {
    for (const scope of scopes) {
      try {
        // An explicit nth in the selector means the caller wants exactly that element.
        if (typeof sel.nth === "number") {
          const pinned = buildLocator(scope, sel);
          if (pinned && (await pinned.count()) > 0 && (await pinned.isVisible().catch(() => false))
              && await ok(pinned)) return pinned;
          continue;
        }
        const all = buildLocatorAll(scope, sel);
        if (!all) continue;
        const total = await all.count();
        for (let i = 0; i < Math.min(total, MAX_CANDIDATE_SCAN); i++) {
          const nth = all.nth(i);
          if (await nth.isVisible().catch(() => false) && await ok(nth)) return nth;
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
//
// FILLABLE, like findPasswordField (production 2026-09-27, City of Tigard, run eyg3): Okta's
// authenticator chooser labels a BUTTON "Select Password." — getByLabel("Password") matched it,
// so a page with no password box at all read as a login form, the run went on to its password
// step and stopped there. A password box is something a password can be typed into.
export async function loginFormPresent(page: Page): Promise<boolean> {
  if (await firstVisible(page, PASSWORD_CANDIDATES, { fillable: true })) return true;
  return (await findInputByAdjacentLabel(page, "pass")) !== null;
}

// Locate the username / password field, trying the prioritized candidates first and the
// adjacent-label scan as a last resort. One place so loginFormPresent and performLogin agree.
async function findUsernameField(page: Page): Promise<Locator | null> {
  return (await firstVisible(page, USERNAME_CANDIDATES, { fillable: true }))
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
  return (await firstVisible(page, PASSWORD_CANDIDATES, { fillable: true })) ?? (await findInputByAdjacentLabel(page, "pass"));
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
    const matched = await visibleMatches(page, sel, 4);
    // A match on the never-click list (a social "Sign in with Google", Okta's /help/login, "Unlock
    // account", "Create an account") is not a reveal, whichever candidate caught it.
    const triggers: Locator[] = [];
    for (const m of matched) {
      const why = await neverClickReason(m);
      if (why) trail.push(`never-click ${key}: ${why}`);
      else triggers.push(m);
    }
    if (!triggers.length) { trail.push(matched.length ? `only never-click matches ${key}` : `no-match ${key}`); continue; }
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

/**
 * IS STEP 1 OF AN IDENTIFIER-FIRST LOGIN IN FRONT OF US? (the portal-test-prep blocker B2)
 *
 * Tyler's sign-in (Okta on identity.tylerportico.com, "Sign in to community access services")
 * shows an Email box and a Next button and NO password box. loginFormPresent asks only "is a
 * password box visible", so performLogin used to run the REVEAL pass first — and the reveal list
 * would click Okta's "Sign in with Google/Microsoft…" (a non-exact {button, "Sign In"} match) or
 * its /help/login link (the href catch-all) long before the two-step branch was ever reached.
 * Whichever form that click led to was then filled with the portal's credential.
 *
 * So the identifier step is recognised BEFORE any reveal click: an identifier-shaped field from
 * the specific candidate list, a next-step control that is not on the never-click list, sign-in
 * wording, and no password box.
 *
 * preReveal adds one more condition, for the call made BEFORE the reveal pass: no worded reveal
 * trigger (a "Log In" / "Sign In" link or button, never-click matches dropped, the Next control
 * itself excluded) is visible. On Okta's page 1 every such match is a social / help / unlock /
 * create-account control and drops out. On a LANDING page with a header "Log In" link and a
 * newsletter Email + Subscribe box, the header link is still there — so the old order stands
 * (reveal the real form first) and the username is never typed into the newsletter box.
 */
async function identifierFirstStep(
  page: Page,
  opts: { preReveal?: boolean } = {},
): Promise<{ idField: Locator; nextCtl: Locator } | null> {
  if (await loginFormPresent(page)) return null;
  const idField = await firstVisible(page, USERNAME_CANDIDATES, { fillable: true });
  if (!idField) return null;
  const nextCtl = await firstVisible(page, NEXT_STEP_CANDIDATES, { clickable: true });
  if (!nextCtl) return null;
  if (!(await loginWordingPresent(page))) return null;
  if (opts.preReveal && await wordedRevealTriggerVisible(page, nextCtl)) return null;
  return { idField, nextCtl };
}

/**
 * THE AUTHENTICATOR CHOOSER THAT OFFERS THE PASSWORD — select it (production 2026-09-27, City of
 * Tigard OR, run eyg3).
 *
 * Okta Identity Engine, after the identifier (or straight away when it remembers the account),
 * may ask "Verify it's you with a security method — Select from the following options" and list
 * the authenticators the account may use FIRST: "Email" and "Password" (buttons labelled "Select
 * Email." / "Select Password."). detectSecondFactor reads that heading as a factor screen, so the
 * run parked where it held the answer in hand.
 *
 * Choosing "Password" is the LOGIN, not a second factor: it opens the password step the stored
 * credential is for. So: on a page with NO password box that reads as an authenticator chooser,
 * a control whose own name is exactly "Password" / "Select Password" is clicked — once per page
 * state, never anything else. Email, phone, SMS, Okta Verify, security keys, security questions
 * are never clicked (rule 1: a second factor is a person's), and a chooser with no Password
 * option — the SECOND-factor list shown after a password — stays a park.
 *
 * Returns what was clicked, or "". Never types.
 */
const AUTHENTICATOR_CHOOSER_TEXT = /verify it'?s you with a security method|select (an|a) (authenticator|security method|verification method)|choose (an|a) (authenticator|security method|verification method)|select from the following options/i;
const PASSWORD_AUTHENTICATOR_NAME = /^\s*(select\s+)?password\.?\s*$/i;
const choosersClicked = new WeakMap<object, number>();
async function choosePasswordAuthenticator(page: Page): Promise<string> {
  try {
    if (await loginFormPresent(page)) return "";
    const clicks = choosersClicked.get(page as unknown as object) ?? 0;
    if (clicks >= 2) return "";
    const text = await (page as unknown as { evaluate: (fn: () => string) => Promise<string> })
      .evaluate(() => String((document.body && (document.body as HTMLElement).innerText) || "").replace(/\s+/g, " ").slice(0, 4000))
      .catch(() => "");
    if (!AUTHENTICATOR_CHOOSER_TEXT.test(text)) return "";
    for (const role of ["button", "link"] as const) {
      for (const scope of (typeof page.frames === "function" ? page.frames() : [page]) as Array<Page | Frame>) {
        const all = scope.getByRole(role, { name: PASSWORD_AUTHENTICATOR_NAME });
        const n = await all.count().catch(() => 0);
        for (let i = 0; i < Math.min(n, 4); i++) {
          const c = all.nth(i);
          if (!(await c.isVisible().catch(() => false))) continue;
          if (await neverClickReason(c)) continue;
          choosersClicked.set(page as unknown as object, clicks + 1);
          await c.click({ timeout: 3000 }).catch(() => null);
          return `the "Password" option of the identity provider's authenticator chooser`;
        }
      }
    }
  } catch { /* a chooser we cannot read is left to the park */ }
  return "";
}

/** Wait (bounded) for a password box to paint after a click that should open one. */
async function passwordBoxWithin(page: Page, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await smartWait(page, 800);
    if (await loginFormPresent(page)) return true;
  }
  return false;
}

/** A worded REVEAL_TRIGGER (role + name) that a reveal pass would click, other than `except`. */
async function wordedRevealTriggerVisible(page: Page, except: Locator): Promise<boolean> {
  const exceptHandle = await except.elementHandle().catch(() => null);
  for (const sel of REVEAL_TRIGGERS) {
    if (!sel.role || !sel.name) continue;
    for (const m of await visibleMatches(page, sel, 4)) {
      if (exceptHandle) {
        const same = await m.evaluate((el, other) => el === other, exceptHandle).catch(() => false);
        if (same) continue;
      }
      if (!(await neverClickReason(m))) return true;
    }
  }
  return false;
}

/**
 * NEVER TYPE THE PORTAL'S CREDENTIAL INTO A THIRD PARTY'S SIGN-IN.
 *
 * The backstop to the never-click list: if any path ever lands the login on a consumer identity
 * provider's own page (Google, Microsoft consumer, Apple, Facebook…), the portal's password is
 * not typed there. A permit portal's credential belongs to the permit portal and its own identity
 * host (identity.tylerportico.com is Tyler's — not on this list).
 */
const CONSUMER_IDP_HOST = /(^|\.)(google\.com|live\.com|appleid\.apple\.com|apple\.com|facebook\.com|github\.com|linkedin\.com|amazon\.com|yahoo\.com|twitter\.com|x\.com|paypal\.com)$/i;
async function thirdPartyIdentityHost(loc: Locator | null): Promise<string> {
  if (!loc) return "";
  const host = await loc.evaluate(() => location.hostname).catch(() => "");
  return host && CONSUMER_IDP_HOST.test(host) ? host : "";
}
function refusedThirdParty(host: string): LoginResult {
  return {
    ok: false,
    status: "login_form_unrecognized",
    message: `The login landed on ${host}, a third-party sign-in (a social identity provider), not this portal's own login. Nothing was typed there: the portal's credential is never entered into another company's sign-in. Record this portal's login manually.`,
  };
}

export interface LoginOptions {
  /** How long to hold the window open at a second-factor screen for a PERSON to complete it.
   *  Omitted: PORTAL_PROFILE_WAIT_MS (default 15 min, kept under the run ceiling) when the
   *  browser is HEADED, 0 when it is headless — nobody can complete a factor in a window no one
   *  can see, so a headless run returns mfa_captcha at once, as it always has. */
  parkMs?: number;
  /** Told once when the run parks: the named reason and the bound. Never carries a credential. */
  onPark?: (info: { reason: string; waitMs: number }) => void;
}

export async function resolveParkMs(page: Page, opts: LoginOptions): Promise<number> {
  if (typeof opts.parkMs === "number" && Number.isFinite(opts.parkMs)) return Math.max(0, opts.parkMs);
  if (/^(off|0|false|no)$/i.test(String(process.env.PORTAL_LOGIN_PARK ?? "").trim())) return 0;
  // A page with no browser context behind it is a test double: nobody is at its window.
  if (typeof (page as unknown as { context?: unknown }).context !== "function") return 0;
  const read = await (page as unknown as { evaluate: (fn: () => string) => Promise<unknown> })
    .evaluate(() => navigator.userAgent).catch(() => "");
  const ua = typeof read === "string" && /^Mozilla\//.test(read) ? read : "";
  // AN UNREADABLE PAGE IS NOT A HEADLESS ONE. The park is decided right after a Next / Verify
  // click, often while the page is navigating — the read then throws ("execution context was
  // destroyed") and an empty answer used to mean "headless": no park, and the headed window the
  // person was watching closed on them. With no reading, the process setting answers (browser.ts's
  // resolveHeadless — the same one that launched the window).
  if (ua ? /headless/i.test(ua) : resolveHeadless()) return 0;
  // Read at CALL time (browser.ts reads PORTAL_PROFILE_WAIT_MS once at import).
  const wait = Number(process.env.PORTAL_PROFILE_WAIT_MS ?? 15 * 60 * 1000);
  // index.ts force-closes the browser at PORTAL_RUN_MAX_MS (default 25 min); a park that
  // outlives it would be ended mid-wait with a confusing error, so leave room for the walk.
  const ceiling = Math.max(60_000, Number(process.env.PORTAL_RUN_MAX_MS ?? 25 * 60_000));
  const bounded = Math.min(Number.isFinite(wait) && wait > 0 ? wait : 15 * 60 * 1000, Math.max(30_000, ceiling - 5 * 60_000));
  return Math.max(0, bounded);
}

/**
 * IS A SESSION PROVEN? One predicate for the post-submit poll AND the second-factor park, so the
 * two can never disagree about what "logged in" means.
 *
 * Order matters. A sign-out control is checked FIRST: a factor screen never has one, and a real
 * post-login page that merely mentions "two-factor" (an account-settings banner) must not be read
 * as a challenge. After that, a second-factor screen or a challenge vetoes the weaker proofs —
 * Okta renders the full submitted username at the top of its factor pages with the password box
 * gone, which submittedIdentityEchoed alone would read as a session.
 */
async function sessionProof(page: Page, loginUrl: string, username: string): Promise<string> {
  if (await authenticatedSignalPresent(page)) return "a sign-out control is now present — a positive signed-in signal";
  if (await detectSecondFactor(page)) return "";
  if (await challengeBeyondPasswordStep(page)) return "";
  const currentUrl: string = typeof page.url === "function" ? page.url() : "";
  // Only a move to a non-login URL can prove anything; the shape check is the expensive half,
  // so it is asked only once the cheap half has already agreed.
  if (currentUrl !== loginUrl && !looksLikeLoginUrl(currentUrl) && !(await loginPageShape(page))) {
    return "the portal moved off the login page to an application page";
  }
  // THE POSTBACK CASE: no URL move and no sign-out control we can see, because the portal
  // authenticates in place and keeps sign-out inside a closed account menu. See
  // submittedIdentityEchoed.
  if (await submittedIdentityEchoed(page, username) && !(await loginFormPresent(page))) {
    return "the password field is gone and the portal is now rendering the submitted account identifier as page text — a positive signed-in signal";
  }
  return "";
}

/**
 * detectChallengeFrame, minus a READING on a page that still shows a password box.
 *
 * A structural hit (a CAPTCHA / MFA frame) always counts. A reading — the page title or visible
 * text matched a challenge word — does not, while a password field is visible: that page is the
 * password step (Okta's is headed "Verify with your password"; identity hosts title every page
 * "… Authentication"), or its wrong-password re-render, which is a FAILED login and must stay
 * one. Measured on the replica: without this, the poll read the password page's title during the
 * 400 ms before the redirect as MFA — the good login stopped, the bad one parked.
 * The same rule as step 4 (pre-fill), and it keeps the park's invariant: never on a password page.
 */
async function challengeBeyondPasswordStep(page: Page): Promise<string> {
  // STRUCTURAL-ONLY on a password page — not "full detection, then drop a reading": the full
  // detector returns its FIRST hit, and the title reading comes first, so a password page titled
  // "… Authentication" that ALSO carried a real CAPTCHA frame would have hidden the frame and
  // been filled and submitted (then read as a refused credential).
  const passwordStep = await loginFormPresent(page);
  return (await detectChallengeFrame(page, { structuralOnly: passwordStep })) ?? "";
}

/**
 * A SECOND FACTOR IS A PERSON'S — SO WAIT FOR ONE, WITH THE WINDOW OPEN (the blocker B3).
 *
 * The run used to return mfa_captcha the moment a factor screen appeared, and index.ts's finally
 * closed the browser — so on a headed supervised learn the operator never got to enter the code
 * in the very window that asked for it, and every Tyler learn would end at its login.
 *
 * Now, on a headed run, it PARKS: it names the reason (console + onPark), then only WATCHES —
 * never types a code, never presses "Send me an email" / "Send push", never picks a factor (rule
 * 1) — until the SAME session proof the poll uses says the portal moved on, bounded by
 * PORTAL_PROFILE_WAIT_MS. Only ever entered on a page with NO password box (detectSecondFactor's
 * load-bearing clause), so the person at the window is never asked for the password; a wrong
 * password re-renders the password box and stays a failed login.
 */
async function parkForSecondFactor(
  page: Page,
  reason: string,
  username: string,
  opts: LoginOptions,
): Promise<LoginResult> {
  const why = `a second factor / verification challenge (MFA or CAPTCHA) is waiting for a person (${reason}) — this is NOT a refused credential`;
  const parkedAt: string = typeof page.url === "function" ? page.url() : "";
  const held = await holdForPerson(page, {
    reason,
    opts,
    // The SAME session proof the poll uses: the person completed it when the portal moved on.
    cleared: () => sessionProof(page, parkedAt, username).catch(() => ""),
  });
  if (held.status === "headless") {
    return { ok: false, status: "mfa_captcha", message: `Login paused: ${why}. Complete it in a visible browser window, then retry.` };
  }
  if (held.status === "resumed") {
    console.warn("[login] RESUMED — the second factor was completed in the window; continuing.");
    return { ok: true, status: "logged_in", message: `Logged in after a person completed the second factor in the open window (${held.proof}).` };
  }
  const minutes = Math.max(1, Math.round(held.waitMs / 60_000));
  return {
    ok: false,
    status: "mfa_captcha",
    message: held.status === "closed"
      ? `Login paused: ${why}. The browser window was closed before the portal moved on; retry once it can be completed.`
      : `Login paused: ${why}. The window was held open ${minutes} min for a person to complete it and the portal did not move on; retry once it is completed.`,
  };
}

/**
 * ONE HOLD FOR A PERSON — the login's second-factor / CAPTCHA park and the learner's mid-walk
 * challenge gate both wait here, so "the run waits with the window open" means one thing.
 *
 * On a HEADED run (resolveParkMs > 0) it announces the park once (console + opts.onPark — the
 * dashboard hears "Complete the MFA/CAPTCHA in the open browser window" through index.ts), then
 * only WATCHES: every ~3 s it asks `cleared()` until that names a proof, the window is closed,
 * or the bound (PORTAL_PROFILE_WAIT_MS, capped under the run ceiling) runs out. It never types,
 * clicks, requests a code or picks a factor (rule 1): the person does all of that in the window.
 * A HEADLESS run returns "headless" at once — nobody can complete anything in a window no one
 * can see, so it pauses immediately, as it always has.
 *
 * NOT the drawn-signature stop: that one is a HAND-OFF (the run ends and index.ts leaves the
 * window open for the person to sign and submit); this one RESUMES the run from where it was.
 */
export async function holdForPerson(
  page: Page,
  args: { reason: string; opts: LoginOptions; cleared: () => Promise<string>; pollMs?: number; maxWaitMs?: number },
): Promise<{ status: "resumed" | "expired" | "closed" | "headless"; proof: string; waitMs: number }> {
  let waitMs = await resolveParkMs(page, args.opts);
  if (typeof args.maxWaitMs === "number") waitMs = Math.min(waitMs, Math.max(0, args.maxWaitMs));
  if (!waitMs) return { status: "headless", proof: "", waitMs: 0 };
  const minutes = Math.max(1, Math.round(waitMs / 60_000));
  const notice = `PAUSED — needs-human (mfa): ${args.reason}. Complete the MFA/CAPTCHA in the open browser window; waiting up to ${minutes} min. The bot does not type or request a code.`;
  try { args.opts.onPark?.({ reason: `mfa_captcha: complete the MFA/CAPTCHA in the open browser window — ${args.reason}`, waitMs }); } catch { /* a notifier must never change the outcome */ }
  console.warn(`[login] ${notice}`);
  const pollMs = Math.max(250, args.pollMs ?? 3000);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    if (typeof page.isClosed === "function" && page.isClosed()) return { status: "closed", proof: "", waitMs };
    const proof = await args.cleared().catch(() => "");
    if (proof) return { status: "resumed", proof, waitMs };
  }
  return { status: "expired", proof: "", waitMs };
}

// The full login flow. Heuristic and portal-agnostic. Never logs credentials.
export async function performLogin(
  page: Page,
  credential: Credential | undefined,
  opts: LoginOptions = {},
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
    // 1b) STEP 1 OF AN IDENTIFIER-FIRST LOGIN IS DECIDED BEFORE ANY REVEAL CLICK (B2) — see
    //     identifierFirstStep. The reveal pass never runs on a page that is already the login.
    let idFirst = present ? null : await identifierFirstStep(page, { preReveal: true });
    // 1c) AN AUTHENTICATOR CHOOSER OFFERING THE PASSWORD (the identity provider remembered the
    //     account) — also decided before any reveal click. See choosePasswordAuthenticator.
    if (!present && !idFirst && await choosePasswordAuthenticator(page)) present = await passwordBoxWithin(page, 10000);
    if (!present && !idFirst) present = await revealLoginForm(page);

    // 2) No form yet. Give it a settle budget before concluding ANYTHING — a login box is
    //    routinely painted late (Momentum's Liferay login portlet renders after the page
    //    reports networkidle, which made the engine declare the portal formless). The budget
    //    is longer on a login-looking URL, where a form is all but guaranteed to arrive.
    //    A LATE-PAINTING identifier step (Okta's widget renders after load) is looked for on
    //    every pass BEFORE the reveal runs again, for the same reason as 1b.
    if (!present && !idFirst) {
      const onLoginUrl = looksLikeLoginUrl(typeof page.url === "function" ? page.url() : "");
      const deadline = Date.now() + (onLoginUrl ? 8000 : 4000);
      while (!present && !idFirst && Date.now() < deadline) {
        await smartWait(page, 1000);
        present = await loginFormPresent(page);
        if (!present) idFirst = await identifierFirstStep(page, { preReveal: true });
        if (!present && !idFirst && await choosePasswordAuthenticator(page)) present = await passwordBoxWithin(page, 10000);
        if (!present && !idFirst) present = await revealLoginForm(page);
      }
    }

    // 2b) IDENTIFIER-FIRST ("two-step") LOGIN. Some portals ask for the email alone, then
    //     reveal the password after a Continue/Next click (OpenGov's portal, Tyler's Okta, and
    //     most SSO front doors). There is no password field yet, so the check above sees "no
    //     form" and the run would stop one click short of the actual login. Deliberately tight,
    //     so a public page's search box + Go button can never be mistaken for a login: it needs
    //     an identifier-shaped field from the specific candidate list (not the loose
    //     adjacent-label fallback), a next-step control that is not on the never-click list, AND
    //     login wording on the page/URL.
    let identifierEntered = false;
    if (!present) {
      const step = idFirst ?? await identifierFirstStep(page);
      if (step) {
        if (!credential || !credential.username || !credential.password) {
          return { ok: false, status: "no_credential", message: "This portal asks for the username first (two-step login) but no stored credential was found for this client/portal. Add the portal username + password under the client's logins, then retry." };
        }
        const foreign = await thirdPartyIdentityHost(step.idField);
        if (foreign) return refusedThirdParty(foreign);
        await waitForElement(step.idField);
        await step.idField.fill(credential.username);
        await step.nextCtl.click().catch(() => null);
        // Wait for the password step to paint — or for a SECOND FACTOR, which some identity
        // providers ask for straight after the identifier (Okta with password-optional
        // policies: "Verify with your email"). That is a person's to complete: park (B3).
        let deadline = Date.now() + 10000;
        while (!present && Date.now() < deadline) {
          await smartWait(page, 1000);
          present = await loginFormPresent(page);
          if (!present) {
            // The password may sit behind an authenticator chooser (Okta "Verify it's you with a
            // security method": Email / Password) — selecting Password is the login, not a factor.
            if (await choosePasswordAuthenticator(page)) { deadline = Math.max(deadline, Date.now() + 10000); continue; }
            const factor = await detectSecondFactor(page);
            if (factor) return await parkForSecondFactor(page, factor, credential.username, opts);
          }
        }
        identifierEntered = present;
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
      // A SECOND FACTOR ALREADY IN FRONT OF US. An identity provider that remembers the account
      // and its password can open straight on a factor screen (a second-factor chooser without a
      // Password option, a code box, a push). That is a person's to complete — the same park as
      // after a submit — never "a login form we could not recognise".
      //
      // Only on a page that is not itself an application: no login action has been taken here, so
      // a public form that merely MENTIONS "a verification code will be emailed" must still reach
      // the no-login-required path below, never a park.
      {
        const factor = await detectSecondFactor(page);
        if (factor && !(await applicationShapedForm(page))) return await parkForSecondFactor(page, factor, credential?.username ?? "", opts);
      }
      const hereUrl: string = typeof page.url === "function" ? page.url() : "";
      const onLoginUrl = looksLikeLoginUrl(hereUrl);

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
          // IS THIS STEP 1 OF A REGISTRATION WIZARD WEARING A PUBLIC FORM'S CLOTHES?
          //
          // The one login-family page that passes applicationShapedForm: "create an account"
          // step 1 asks for first name, last name, email, phone and company, and holds no
          // password field at all — the password is chosen on step 2. Waved through as
          // no_login_required, the walk would then plan project fills onto a signup form and
          // bank the result as this jurisdiction's recipe.
          //
          // BOTH HALVES ARE REQUIRED, and that is the whole design. The previous attempt at
          // this put `register` into looksLikeLoginUrl, where the URL alone was enough — and
          // an ordinary account-less public form at /permits/register-a-solar-project was
          // condemned as an unprovable login, telling the operator to supply credentials for
          // a portal that has no accounts (see the note on looksLikeLoginUrl). Permit portals
          // say "register a solar project" as readily as "register an account", so the URL is
          // only ever half the evidence. The other half is a POSITIVE account signal on the
          // page — a password field, or a sign-in / create-account control — which is exactly
          // the test publicApplicationEntry already applies one branch below.
          const registrationWizard = isRegistrationUrl(hereUrl) ? await accountAffordancePresent(page) : "";
          if (registrationWizard) {
            // login_form_unrecognized, not no_credential: accounts demonstrably exist here and
            // we failed to reach the place they are USED. That scores owner=engine in the
            // learn benchmark, which is the honest owner — the next day's work is "follow the
            // account affordance to the login", not "go find a password".
            return {
              ok: false,
              status: "login_form_unrecognized",
              message: `This page is step 1 of a REGISTRATION wizard, not a public application: its URL says register and the page offers ${registrationWizard}. A password step that is not on this page means there is nothing here to prove a session with, so nothing was filled. Create the account by hand and store its username + password under the client's logins, or record this portal's login manually.`,
            };
          }
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
      // LAST, once everything else has declined: is the stored URL even pointing at a
      // portal? See looksNotLikeAPortal. A newsletter signup has no login form to find, and
      // calling that a detector failure sends the next day's work at the wrong thing.
      const notAPortal = await looksNotLikeAPortal(page);
      if (notAPortal) {
        return { ok: false, status: "no_credential", message: `The stored portal URL for this jurisdiction appears to be wrong: it lands on ${notAPortal}. Correct the URL on the client's portal login, then retry.` };
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
    //
    //    A STRUCTURAL challenge (a CAPTCHA / MFA frame) stops, as it always has. A READING — the
    //    page title or some visible text matched a challenge word — does NOT stop a page with a
    //    fillable password box in front of us: that page is the password step. Okta's is headed
    //    "Verify with your password"; an identity host titles its pages "Authentication"; a
    //    stop there was a false stop one field short of the login (an uncertain reading must not
    //    stop a legitimate step). If a real challenge follows the submit, the poll below sees it.
    //
    //    A REAL challenge here (a CAPTCHA widget on the login form) PARKS on a headed run, like a
    //    second factor after the submit: the window stays open for the person, who solves it and
    //    signs in; the same session proof resumes the run. Nothing is typed under it — the
    //    password is never entered beneath an unsolved CAPTCHA. Headless: paused at once.
    const preChallenge = await challengeBeyondPasswordStep(page);
    if (preChallenge) return await parkForSecondFactor(page, `${preChallenge} on the login form — solve it and sign in`, credential.username, opts);

    // 5) Fill username + password (candidate lists first, adjacent-label scan as fallback).
    //    On a two-step login the identifier is already submitted and step 2 usually shows the
    //    password ALONE — so a missing username field there is expected, not a failure.
    //
    //    THE REMEMBERED IDENTIFIER. An identity provider that already knows the account (Okta
    //    with "Keep me signed in", or a person who typed the email earlier in this profile) opens
    //    straight on the password step: the identifier is RENDERED AS TEXT above a lone password
    //    box ("SeamusEricson@…" / "Verify with your password"), and there is no username box to
    //    fill. Proceed with the password only when the identifier shown is THIS credential's
    //    username — a page remembering some other account never gets this portal's password.
    const userLoc = await findUsernameField(page);
    if (!userLoc && !identifierEntered) {
      if (await submittedIdentityEchoed(page, credential.username)) {
        identifierEntered = true;
      } else {
        return { ok: false, status: "no_username_field", message: "Found a password field but could not locate the username/email field, and the page does not show this portal's stored username as the account being signed in — the portal layout is unusual, or the sign-in remembered a different account. Nothing was typed. Record it manually, or sign out of the other account in the browser." };
      }
    }
    // Never on a third party's sign-in (see thirdPartyIdentityHost) — checked before EITHER
    // field is typed, on the frame each field actually lives in.
    {
      const foreign = (await thirdPartyIdentityHost(userLoc)) || (await thirdPartyIdentityHost(await findPasswordField(page)));
      if (foreign) return refusedThirdParty(foreign);
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
    const submitLoc = await firstVisible(page, SUBMIT_CANDIDATES, { clickable: true });
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
    //      - a POSITIVE proof of session → success
    //
    // A SESSION IS PROVEN BY A POSITIVE SIGNED-IN SIGNAL, NOT BY THE ABSENCE OF A PASSWORD
    // FIELD.
    //
    // This poll used to read `if (formGone || urlMoved) return logged_in`, where formGone is
    // `!loginFormPresent(page)` and loginFormPresent asks exactly one question: is a password
    // field visible. On an identifier-first login — Cloudpermit, Okta, Microsoft, most SSO —
    // step 1 HAS no password field, so "the password field is gone" is the normal state of a
    // login that has not happened.
    //
    // us.cloudpermit.com is the measured case. Both traced pages were titled "Cloudpermit -
    // Log In", `portal_credentials` was stamped `last_login_ok_at` "login accepted", the
    // portal was counted in the fleet's "26 accessible", and the walk then spent its budget
    // planning fills on the login form — which is how the recipe came to bind installerEmail
    // to `#input-email-new`, and how a credential ends up typed into a field the planner
    // chose. Baltimore County is the same bug through the URL clause: it moved to a SECOND
    // login at `/auth/signin`, which the old bare `/login/i` did not recognise as a login URL.
    //
    // The engine already stated the correct rule 150 lines above, in the already_authenticated
    // path — "the mere ABSENCE of a login form is NOT proof of a session" — and
    // authenticatedSignalPresent was already written. The poll simply never called it.
    //
    // So: success needs a sign-out control (a control that exists only once signed in), OR a
    // move to a URL that is not a login URL AND a page that is not shaped like a login. Both
    // halves of the second clause are load-bearing: the URL alone is what Baltimore beat, and
    // the shape alone would never fire on a portal that re-renders its login in place.
    //
    // KNOWN AND ACCEPTED COST: a portal that logs in without moving its URL and without
    // rendering any sign-out control now times out as still_on_login instead of being called
    // logged_in on no evidence. That is the trade the incident demands — a false "logged in"
    // is banked as knowledge and spends LLM budget on a login form; a false "still on login"
    // is a line in the run log that names exactly what it could not prove.
    //
    // The proof itself lives in sessionProof, shared with the second-factor park. A SECOND
    // FACTOR (detectSecondFactor — by what the page says and holds, so Tyler's Okta on its own
    // domain is seen; B6) or a challenge frame is handed to parkForSecondFactor: a headed run
    // waits there for a person, a headless one returns mfa_captcha at once — never the
    // "credential likely rejected" timeout that marked a good login stale.
    const deadline = Date.now() + LOGIN_RESULT_TIMEOUT_MS;
    await smartWait(page, 2000); // let the first navigation/AJAX settle
    while (Date.now() < deadline) {
      const proof = await sessionProof(page, loginUrl, credential.username);
      if (proof) return { ok: true, status: "logged_in", message: `Logged in successfully (${proof}).` };
      const challenge = (await detectSecondFactor(page)) || (await challengeBeyondPasswordStep(page));
      if (challenge) return await parkForSecondFactor(page, challenge, credential.username, opts);
      await sleep(500);
    }

    // 8) Timed out with no proof of a session. Three different failures reach here and they
    //    need three different fixes, so say which one it is.
    const endShape = await loginPageShape(page);
    const formStillThere = await loginFormPresent(page);
    const endUrl: string = typeof page.url === "function" ? page.url() : "";
    if (endUrl !== loginUrl && endShape) {
      // A SECOND LOGIN IS NOT A LOGGED-IN PAGE. Baltimore County's run followed
      // www.baltimorecountymd.gov -> cityworkspro.baltimorecountymd.gov — the right hop, same
      // registrable domain, same permit track — and landed on ANOTHER login, where it clicked
      // sign-in on an empty form and looped. Naming the hand-off is the difference between
      // "the credential was refused" (send someone to check a password) and "the portal
      // needs a second account" (send someone to add one).
      return {
        ok: false,
        status: "still_on_login",
        message: `The login submitted and the portal handed off to ANOTHER login page (${endShape}). No session was established. If this portal fronts a separate system, that system needs its own stored credential; otherwise record the login manually.`,
      };
    }
    if (!formStillThere && endShape) {
      // THE UNFINISHED TWO-STEP — the Cloudpermit shape. The password field is gone and we
      // are still standing on a login page. Reusing still_on_login deliberately: the learn
      // benchmark keys its login-failure rung on that exact status (learnBenchmark.ts), and a
      // new status would be scored by the catch-all instead. The message carries the
      // distinction.
      return {
        ok: false,
        status: "still_on_login",
        message: `Submitted the login but the portal is STILL showing a login page (${endShape}) and no signed-in signal appeared — an unfinished identifier-first/two-step login, not a session. Nothing was learned and no application page was reached; record this portal's login manually.`,
      };
    }
    // Say WHICH submit path was taken: with no recognizable button, "credentials rejected"
    // would be a misleading diagnosis.
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
 * DOES THIS PAGE SAY, ANYWHERE, THAT ACCOUNTS EXIST HERE?
 *
 * The positive half of the registration-wizard guard in performLogin. publicApplicationEntry
 * computes the same thing inside itself, but it CONFLATES the answer with its own verdict —
 * it returns "" both when a sign-in control exists and when there simply are not enough
 * application entries — so it cannot be asked this question. Hence a separate, smaller scan
 * that answers only this and returns the evidence it found.
 *
 * VOCABULARY IS NARROWER THAN publicApplicationEntry'S ON PURPOSE. A bare `register` is NOT
 * an account signal here: this runs only on pages whose URL already says register, and permit
 * portals say "Register a Solar Project" / "Register your equipment" as a matter of course.
 * Counting that word would re-condemn the account-less public forms that the fix to
 * looksLikeLoginUrl exists to protect. `sign up` is out for the same reason — "Sign up for
 * email updates" sits in the footer of every municipal site in the fleet. What is left is
 * wording that only an account system produces: somewhere to sign in, or an explicit
 * create/my-account control. `create account` is included because publicApplicationEntry's
 * `create an account` misses the canonical button label, which has no "an" in it.
 *
 * Exported for the DOM smoke.
 */
export async function accountAffordancePresent(page: Page): Promise<string> {
  try {
    return await (page as unknown as { evaluate: (fn: () => string) => Promise<string> }).evaluate(() => {
      // Fully inline, no named helpers — see the note in authenticatedSignalPresent.
      if (document.querySelector("input[type=password]")) return "a password field";
      const controls = Array.from(document.querySelectorAll(
        "a, button, input[type=button], input[type=submit], [role=button], [role=link]",
      ));
      for (const el of controls) {
        const hay = [
          (el as HTMLElement).innerText || "",
          el.getAttribute("aria-label") || "",
          el.id || "",
          (el as HTMLAnchorElement).href || "",
          (el as HTMLInputElement).value || "",
        ].join(" ").replace(/\s+/g, " ").trim();
        // A sign-OUT control means this page is already behind the login — a different
        // branch's business, and never evidence for this one.
        if (/\blog[\s-]?out\b|\blogout\b|\bsign[\s-]?out\b|\bsignout\b/i.test(hay)) continue;
        const hit = hay.match(/\blog[\s-]?in\b|\blogin\b|\bsign[\s-]?in\b|\bsignin\b|\bcreate (an?|your) account\b|\bcreate account\b|\bnew account\b|\bmy account\b|\baccount registration\b|\bregister (for )?an account\b/i);
        if (hit) return `a "${hit[0].slice(0, 40)}" control`;
      }
      return "";
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
    return await (page as unknown as { evaluate: (fn: (socialSrc: string) => string, arg: string) => Promise<string> }).evaluate((socialSrc) => {
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
        // THE MENU THIS CONTROL OPENS IS EVIDENCE ABOUT THE MENU, NOT ABOUT THE CONTROL.
        //
        // This pass used to pour the attached menu's whole text into the same haystack as the
        // control's own describers — and then a PowerClerk NAVIGATION dropdown (the program
        // picker: "Recently visited / All programs / Register for programs") matched \bregister\b,
        // got tagged as a login reveal, and every run opened it at start, burned the 3s reveal
        // wait, and re-entered the settle loop. The operator watched it happen live.
        //
        // The general invariant: a control is a login reveal because IT is described as one —
        // its title, aria-label, labels, or the element its aria points at. A menu's contents
        // may only CONFIRM a control that already qualifies (and veto a pure session menu);
        // bulk menu text must never ESTABLISH the match, because any nav menu on any portal can
        // contain the word "register" three links down.
        const ownHay = described.join(" ").replace(/\s+/g, " ").trim();

        const menuTexts: string[] = [];
        const controlsId = el.getAttribute("aria-controls");
        if (controlsId) menuTexts.push(document.getElementById(controlsId)?.textContent || "");
        const menu = parent?.querySelector(".dropdown-menu, [role=menu], ul");
        if (menu) menuTexts.push(menu.textContent || "");
        const menuHay = menuTexts.join(" ").replace(/\s+/g, " ").trim();

        if (!ownHay || !LOGIN.test(ownHay)) continue;
        // A SOCIAL sign-in icon ("Sign in with Google" as the aria-label of a logo button) is
        // described as a login and is not ours to click — the social half of NEVER_CLICK_PATTERNS,
        // which the worded pass applies too. ONLY the social half: PermitTrax's tooltip "Click to
        // Sign In / Register a New Account" names register and IS the reveal.
        if (new RegExp(socialSrc, "i").test(ownHay) || /social-auth/i.test(String((el as HTMLElement).className || ""))) continue;
        const hay = `${ownHay} ${menuHay}`.trim();
        // A menu holding BOTH is a session menu; only skip when sign-out is all there is.
        if (LOGOUT.test(hay) && !LOGIN.test(hay.replace(LOGOUT, ""))) continue;

        el.setAttribute("data-al-login-reveal", "1");
        return hay.slice(0, 90);
      }
      return "";
    }, SOCIAL_IDP_SOURCE);
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
      // Cloudflare's interstitial says none of the usual words. Canton TX serves
      // "Attention Required! | Cloudflare" and the run called it an unrecognised login —
      // the same miss as Baltimore County's 403, in a different dialect. looksBotBlocked
      // already knows the word "cloudflare"; it never saw it, because the challenge lives
      // in the page and the scorer reads the message.
      const BLOCK = /request could not be satisfied|\b403\b|\b404\b|\b50[0-9]\b|access denied|forbidden|request blocked|service unavailable|temporarily unavailable|under maintenance|site maintenance|page not found|bad gateway|attention required|checking your browser|cloudflare|ddos protection|\bray id\b|verify you are (a )?human|enable javascript and cookies/i;
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

/**
 * THE PORTAL'S OWN ERROR PAGE, MET DURING ENTRY. Live run 99baa5d0 (Oregon ePermitting, 2026-09-27):
 * the recipe's entry goto (Dashboard.aspx) was answered with aca-oregon.accela.com/oregon/
 * Error.aspx?ErrorId=… — Accela's own error page, BLANK, tab still loading — and the run spent
 * 50.9 s on it: `load` waited on a page that never finished, then the interactive-controls wait
 * burned its budget on a page with no controls. A blank error page says none of detectErrorPage's
 * words; its URL does. So this reads BOTH: an error-shaped URL (…/Error.aspx, /error, /oops,
 * ?ErrorId=), or detectErrorPage's block wording (extended with "technical difficulties" / "an
 * error has occurred" / "unexpected error"), on a page with no more than a handful of controls.
 * Returns a short description, or "" for a page that is not an error page — and a real
 * application page (inputs, selects) is never one, whatever its URL says.
 */
export async function portalErrorPage(page: Page): Promise<string> {
  try {
    const url = typeof page.url === "function" ? String(page.url() ?? "") : "";
    const errorUrl = /\/error(?:page)?\.(?:aspx|html?|php|jsp)\b|\/(?:error|oops|unavailable|maintenance)(?:\/|$|\?)|[?&]errorid=/i.test(url);
    const shape = await (page as unknown as { evaluate: (fn: () => { controls: number; words: string; blank: boolean }) => Promise<{ controls: number; words: string; blank: boolean }> }).evaluate(() => {
      const WORDS = /technical difficulties|an error has occurred|error has occurred|unexpected error|something went wrong|request could not be satisfied|service unavailable|temporarily unavailable|under maintenance|bad gateway|server error|runtime error|we('re| are) sorry/i;
      const controls = document.querySelectorAll("input:not([type=hidden]), select, textarea, button, [role=button]").length;
      const text = ((document.body?.innerText || "") + " " + (document.title || "")).replace(/\s+/g, " ").trim();
      const m = WORDS.exec(text);
      return { controls, words: m ? m[0] : "", blank: text.replace(/[^a-z]/gi, "").length < 20 };
    }).catch(() => ({ controls: 99, words: "", blank: false }));
    if (shape.controls > 6) return "";
    if (errorUrl) return `the portal's error page (${url.replace(/^https?:\/\//, "").slice(0, 60)}${shape.words ? `: "${shape.words}"` : shape.blank ? ", blank" : ""})`;
    if (shape.words) return `the portal's error page ("${shape.words}")`;
    return "";
  } catch {
    return "";
  }
}

/**
 * IS THIS A PERMIT PORTAL AT ALL, OR JUST A PAGE THE URL POINTS AT?
 *
 * Bulk-reading the fleet's login-failure captures found several stored URLs that do not
 * reach a portal:
 *
 *   Miramar FL     public.govdelivery.com/accounts/FLMIRAMAR/subscribers/  a newsletter signup
 *   Las Cruces NM  /directories-resources/permits-licenses-and-...          a directory page
 *   Gilbert AZ     /f/permitext                                             a permit EXTENSION form
 *
 * Every one of them was scored "the portal's login form was not recognised", owner ENGINE.
 * There is no login form on a newsletter signup page, and no amount of detector work will
 * conjure one. It is stored operator data pointing somewhere wrong, and naming it as such
 * turns a mysterious engine failure into a one-line fix somebody can actually make.
 *
 * DELIBERATELY LAST AND DELIBERATELY TIMID. It runs only after the login detector, the
 * public-application check and the error-page check have all declined, so a real portal has
 * had every chance to identify itself. It requires the page to show NO permit vocabulary at
 * all — not merely little — because a portal that mentions permits once is still a portal,
 * and a false accusation here sends someone to edit a URL that was correct.
 */
export async function looksNotLikeAPortal(page: Page): Promise<string> {
  try {
    return await (page as unknown as { evaluate: (fn: () => string) => Promise<string> }).evaluate(() => {
      const text = ((document.body?.innerText || "") + " " + document.title).replace(/\s+/g, " ").trim();
      if (!text || text.length < 40) return "";
      // Any of these and it is plausibly a portal; say nothing.
      const PORTAL = /\bpermit|\blicen[cs]e|\bapplication\b|\binspection|\bplan review\b|\bcontractor\b|\bparcel\b|\bzoning\b|\bbuilding department\b/i;
      if (PORTAL.test(text)) return "";
      // And it must positively read as something else, rather than merely being terse.
      const NOT_PORTAL: Array<[RegExp, string]> = [
        [/\bsubscribe\b|\bsubscriber\b|\bnewsletter\b|\bmailing list\b|email updates/i, "a newsletter or subscription signup"],
        [/\bdirectory\b|\bindex of\b|\bsite ?map\b/i, "a directory or index page"],
        [/\bcontact us\b|\bstaff directory\b|\bphone directory\b/i, "a contact page"],
        [/\bnews\b|\bpress release|\bcalendar of events\b/i, "a news or events page"],
        [/\bpay (your )?(water|utility|tax|bill)\b/i, "a utility or tax payment page"],
      ];
      for (const [re, what] of NOT_PORTAL) {
        if (re.test(text)) return `${what} — the stored URL does not reach a permit portal (${(document.title || "").slice(0, 50)})`;
      }
      return "";
    });
  } catch {
    return "";
  }
}
