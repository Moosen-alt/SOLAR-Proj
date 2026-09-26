// A LOGIN MET MID-RUN, ON THE ACCELA REPLICA (production, 2026-09-25, city-of-jefferson).
//
// The operator watched a learn "logging in then out over and over": it started on a non-portal
// page, so the login pass said no_login_required and the stored credential was never used; when
// Accela's Login.aspx appeared mid-run the learner treated it as a form, pressed "Sign In" with
// EMPTY boxes (advance_timed_out 90 s, advance_did_nothing), the wrong-module re-entry sent it
// back, and it repeated for six minutes filling nothing. Engine invariants, each asserted here:
//
//   (a) a login form met at ANY point (after navigation, after a redirect, after a session drop)
//       runs the login pass with the credential bound to THAT host, once per host per run;
//       a host with no credential stops named, with nothing typed into its form;
//   (b) "Sign In" is never an advance while its credential boxes are empty;
//   (c) the wrong-module re-entry is capped (2) and the cap ends the run, named;
//   (d) a walk that never reaches a fillable page stops within a stated budget.
//
// Synthetic replica and projects only (no real portal, no customer data).
// Run: npx tsx portal-bot/src/replica/learnLoginMidRun.dom.smoke.ts
import "../smokeArtifactDirs";
import { learnPortal } from "../index";
import { buildWizard } from "./fixtures/wizards";
import { PROJECT_A } from "./fixtures/syntheticProjects";
import { startSyntheticReplica, type AccelaLoginMode } from "./syntheticServer";
import { standInPlanner } from "./standInPlanner";
import type { LearnPlanRequest, LearnPlanResponse } from "../adapters/autoLearnAdapter";
import type { ProjectRecord } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.ANTHROPIC_API_KEY = "";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const P = PROJECT_A;
const ONLY = process.env.SMOKE_ONLY || "";
const CRED = { username: P.portalUsername, password: P.portalPassword };
const fields: Record<string, string> = {
  homeownerFirstName: P.ownerFirst, homeownerLastName: P.ownerLast, homeownerName: `${P.ownerFirst} ${P.ownerLast}`,
  homeownerEmail: P.ownerEmail, homeownerPhone: P.ownerPhone, street: P.street, city: P.city, state: P.state, zip: P.zip, county: P.county,
  installerFirstName: P.installer.contactFirst, installerLastName: P.installer.contactLast, installerCompanyName: P.installer.company,
  installerEmail: P.installer.email, installerPhone: P.installer.phone, installerContactName: `${P.installer.contactFirst} ${P.installer.contactLast}`,
  workDescription: `Roof-mounted residential solar PV system, ${P.dcKw} kW DC / ${P.acKw} kW AC`, systemSizeDcKw: P.dcKw, numberOfStories: P.stories,
  moduleQty: P.moduleQty, moduleQuantity: P.moduleQty, inverterQty: P.inverterQty, moduleMake: P.moduleMake, moduleModel: P.moduleModel, inverterMake: P.inverterMake, inverterModel: P.inverterModel,
};
const project = {
  id: "smoke-login", ahj: P.ahj, utility: P.utility, state: P.state, city: P.city, zip: P.zip, address: `${P.street}, ${P.city}, ${P.state} ${P.zip}`, projectAddress: `${P.street}, ${P.city}, ${P.state} ${P.zip}`,
  homeownerName: `${P.ownerFirst} ${P.ownerLast}`,
} as unknown as ProjectRecord;

/** The production planner picked "Sign In" as the page's advance; the stand-in never would. */
const signInPicker = (inner: (r: LearnPlanRequest) => Promise<LearnPlanResponse>) => async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
  const i = req.fields.findIndex((f) => /^\s*sign\s*in\s*$/i.test(String(f.label ?? "")));
  if (i >= 0) return { fills: [], advanceSelectorIndex: i, atReview: false, notes: "smoke: the production planner's choice" };
  return inner(req);
};

interface Case { name: string; mode: AccelaLoginMode; start: "info" | "segInfo" | "entry"; credential?: typeof CRED; resolver?: "none" | "host"; forceSignIn?: boolean; noProgressBudgetMs?: number }
async function run(c: Case) {
  if (ONLY && !c.name.includes(ONLY)) return null;
  const replica = await startSyntheticReplica({ wizard: buildWizard("accela", "base"), credential: CRED, accelaLogin: c.mode });
  const resolverCalls: string[] = [];
  const inner = standInPlanner(fields, { utility: false });
  const t0 = Date.now();
  try {
    const r = await learnPortal({
      portalName: `smoke ${c.name}`,
      portalUrl: c.start === "info" ? `${replica.base}/info` : c.start === "segInfo" ? `${replica.base}/CitizenAccess/info` : replica.entryUrl,
      project,
      planner: c.forceSignIn ? signInPicker(inner) : inner,
      credential: c.credential,
      headless: true,
      budgetMs: 240_000,
      uploadMode: "combined",
      policyProfile: "none",
      ...(c.resolver ? { credentialForUrl: (u: string) => { resolverCalls.push(u); return c.resolver === "host" && new URL(u).host === new URL(replica.base).host ? CRED : null; } } : {}),
      ...(c.noProgressBudgetMs ? { noProgressBudgetMs: c.noProgressBudgetMs } : {}),
      contactIdentity: { firstName: fields.installerFirstName, lastName: fields.installerLastName, email: fields.installerEmail, phone: fields.installerPhone, street: P.installer.street, city: P.installer.city, state: P.installer.state, zip: P.installer.zip },
      siteContactIdentity: { firstName: fields.homeownerFirstName, lastName: fields.homeownerLastName, email: fields.homeownerEmail, phone: fields.homeownerPhone, street: P.street, city: P.city, state: P.state, zip: P.zip },
      siteIdentity: { city: P.city, zip: P.zip, homeownerName: fields.homeownerName, isElectrical: true },
      hasBattery: false,
    });
    const secs = (Date.now() - t0) / 1000;
    const logins = replica.state.posts.filter((p) => p.kind === "login");
    const emptyLogins = logins.filter((p) => p.fields.passwordEmpty === "yes" || !p.fields.userId);
    const portalValues = Object.keys(replica.state.values).filter((k) => !k.startsWith("__") && String(replica.state.values[k] ?? "").trim());
    const everywhere = JSON.stringify({ steps: r.steps, message: r.message, trace: r.pageTrace });
    console.log(`   [${c.name}] ${secs.toFixed(1)}s stop=${r.stopReason ?? "-"} ok=${r.ok} review=${!!r.reachedReview} logins=${logins.length} (empty ${emptyLogins.length}) portalValues=${portalValues.length} resolverCalls=${resolverCalls.length}\n      msg: ${String(r.message).slice(0, 400)}\n      trace: ${(r.pageTrace ?? []).slice(-6).join(" || ").slice(0, 900)}`);
    return { r, secs, logins, emptyLogins, portalValues, resolverCalls, leaked: everywhere.includes(CRED.password), submits: replica.state.submitPosts.length };
  } finally {
    await replica.close();
  }
}

// (a) MUST-PASS — the production shape: start on a non-portal page, meet Login.aspx mid-run. With
// no resolver the run's own credential is bound to the start URL's host + first path segment
// (close-mustfix L7, the backend's rule), so the start page is inside the portal's /CitizenAccess.
{
  const x = await run({ name: "a-info-then-login", mode: "normal", start: "segInfo", credential: CRED });
  if (x) {
  check("(a) MUST-PASS started off-portal: the mid-run login ran ONCE with the stored credential, and the walk then filled the portal", x.logins.length === 1 && x.emptyLogins.length === 0 && x.portalValues.length >= 3,
    `logins=${x.logins.length} empty=${x.emptyLogins.length} values=${x.portalValues.length} stop=${x.r.stopReason} ${x.r.message.slice(0, 200)}`);
  check("(a) the credential appears nowhere in the steps, the message or the trace (bound by name)", !x.leaked);
  check("(a) no filing POST", x.submits === 0);
  }
}
// (a) MUST-EXCLUDE (close-mustfix L7) — the same run started at /info, OUTSIDE the portal's first
// path segment, with no resolver: the run's own credential is not the login for /CitizenAccess
// (one Accela host serves every city by that segment) -> stops named, nothing typed.
{
  const x = await run({ name: "a-info-other-segment", mode: "normal", start: "info", credential: CRED });
  if (x) {
  check("(a) MUST-EXCLUDE the run's own credential is not typed outside its host + first path segment -> login_needed_no_credential, 0 login POSTs",
    x.r.stopReason === "login_needed_no_credential" && x.logins.length === 0 && !x.leaked, `stop=${x.r.stopReason} logins=${x.logins.length} ${x.r.message.slice(0, 160)}`);
  }
}
// (a) MUST-PASS — a resolver bound to the host is asked for the login page's URL.
{
  const x = await run({ name: "a-resolver", mode: "normal", start: "info", resolver: "host" });
  if (x) {
  check("(a) MUST-PASS the host resolver is asked for the Login.aspx host and its credential logs in", x.resolverCalls.some((u) => /login\.aspx/i.test(u)) && x.logins.length === 1 && x.emptyLogins.length === 0 && x.portalValues.length >= 3,
    `calls=${x.resolverCalls.length} logins=${x.logins.length} values=${x.portalValues.length} stop=${x.r.stopReason}`);
  }
}
// (a) MUST-EXCLUDE — no credential bound to the host: stop named, nothing typed.
{
  const x = await run({ name: "a-no-credential", mode: "normal", start: "info", resolver: "none" });
  if (x) {
  check("(a) MUST-EXCLUDE no credential for the host -> stops named (login_needed_no_credential), 0 login POSTs, in seconds",
    x.r.stopReason === "login_needed_no_credential" && x.logins.length === 0 && x.secs < 90, `stop=${x.r.stopReason} logins=${x.logins.length} ${x.secs.toFixed(1)}s ${x.r.message.slice(0, 160)}`);
  }
}
// (a) MUST-PASS — a session that drops once mid-wizard is logged back in once, and the walk goes on.
{
  const x = await run({ name: "a-session-drops-once", mode: "sessionDropsOnce", start: "entry", credential: CRED });
  if (x) {
  check("(a) MUST-PASS a session drop mid-wizard: logged in again (2 logins total, none empty) and the walk carried on past it",
    x.logins.length === 2 && x.emptyLogins.length === 0 && x.portalValues.length >= 5, `logins=${x.logins.length} empty=${x.emptyLogins.length} values=${x.portalValues.length} stop=${x.r.stopReason}`);
  }
}
// (a) MUST-EXCLUDE — logging in then out over and over: once per host, then a named stop.
{
  const x = await run({ name: "a-session-always-drops", mode: "sessionAlwaysDrops", start: "entry", credential: CRED });
  if (x) {
  check("(a) MUST-EXCLUDE a session that never holds -> login_repeated_on_host, at most 2 logins, none empty, bounded",
    x.r.stopReason === "login_repeated_on_host" && x.logins.length <= 2 && x.emptyLogins.length === 0 && x.secs < 150, `stop=${x.r.stopReason} logins=${x.logins.length} empty=${x.emptyLogins.length} ${x.secs.toFixed(1)}s`);
  }
}
// (b) MUST-EXCLUDE — a login whose secret box is not a password field, and a planner that picks "Sign In".
{
  const x = await run({ name: "b-sign-in-empty", mode: "codeBoxLogin", start: "info", resolver: "none", forceSignIn: true });
  if (x) {
  check("(b) MUST-EXCLUDE 'Sign In' is never pressed with empty credential boxes -> login_advance_with_empty_credentials, 0 login POSTs",
    x.r.stopReason === "login_advance_with_empty_credentials" && x.logins.length === 0, `stop=${x.r.stopReason} logins=${x.logins.length} ${x.r.message.slice(0, 160)}`);
  }
}
// (c) MUST-EXCLUDE — an entry that keeps bouncing to the records home.
{
  const x = await run({ name: "c-wrong-module-cap", mode: "entryBouncesHome", start: "entry", credential: CRED });
  if (x) {
  check("(c) MUST-EXCLUDE the records_home re-entry is capped at 2 and ends the run named (aca_wrong_module_cap), bounded",
    x.r.stopReason === "aca_wrong_module_cap" && x.secs < 150, `stop=${x.r.stopReason} ${x.secs.toFixed(1)}s ${x.r.message.slice(0, 160)}`);
  }
}
// (d) MUST-EXCLUDE — distinct pages forever, nothing fillable: stops within the stated budget.
{
  const budget = 30_000;
  const x = await run({ name: "d-no-fill-maze", mode: "maze", start: "info", noProgressBudgetMs: budget });
  if (x) {
  check(`(d) MUST-EXCLUDE a walk that never reaches a fillable page stops, named (no_fill_progress), within the budget + one page of work (budget ${budget / 1000}s, checked between pages)`,
    x.r.stopReason === "no_fill_progress" && x.secs < budget / 1000 + 75 && /budget 30s/.test(x.r.message), `stop=${x.r.stopReason} ${x.secs.toFixed(1)}s ${x.r.message.slice(0, 160)}`);
  }
}

if (failures) { console.error(`\n${failures} learn-login-mid-run check(s) FAILED.`); process.exit(1); }
console.log("\nAll learn-login-mid-run checks passed (real Chromium, Accela replica).");
process.exit(0);
