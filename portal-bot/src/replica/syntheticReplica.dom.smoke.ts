// THE SCOREBOARD'S INSTRUMENT, TESTED — not the bot.
//
// scripts/replay-bench-offline.ts reads every verdict from the synthetic replica server and
// benchScore.ts. If either lies, every number on the scoreboard lies with it, and the lie is
// silent: a server that forgets to flag a filing reports "0 submit POSTs" forever. So this pins
// the instrument in real Chromium, in both directions, without running the (slow) bot:
//
//   MUST FLAG    — Accela's CapConfirm "Continue Application" POST is a submit; PowerClerk's
//                  Submit and Pay are a submit and a pay; the SPA's Submit Application is a submit.
//   MUST NOT     — an ordinary mid-wizard Continue / Next / autosave is not flagged.
//   PORTAL SHAPES— Accela's address search is an async postback on the SAME URL with
//                  PageRequestManager begin/end and a grid; PowerClerk saves only on a commit
//                  (the change a blur fires), and its contact block's in-place re-render wipes a
//                  value typed and never committed.
//   SCORING      — a wrong-box write, an A leak and a blank are each counted; a clean state
//                  scores all-correct with every counter at zero.
//   PLANNER      — the stand-in never advances with a submit- or pay-shaped control, and it
//                  reports the review screen as review.
//
//   npx tsx portal-bot/src/replica/syntheticReplica.dom.smoke.ts
import { chromium } from "playwright";
import { buildWizard, scoredControls, type DocKey } from "./fixtures/wizards";
import { PROJECT_A, PROJECT_B, aOnlyLiterals } from "./fixtures/syntheticProjects";
import { startSyntheticReplica, type ReplicaState } from "./syntheticServer";
import { expectedValues, scoreRun } from "./benchScore";
import { standInPlanner } from "./standInPlanner";

let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  checks++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const browser = await chromium.launch();
const ctxOpts = {};
const newPage = async () => {
  const c = await browser.newContext(ctxOpts);
  await c.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  return c.newPage();
};

// ---------------------------------------------------------------------------------------------
console.log("\n1. ACCELA: async search on the same URL; the review page's Continue Application files");
{
  const w = buildWizard("accela", "base");
  const r = await startSyntheticReplica({ wizard: w });
  const page = await newPage();
  const wl = w.pages.find((p) => p.kind === "worklocation")!;
  await page.goto(`${r.base}/CitizenAccess/Cap/${wl.slug}`);
  const urlBefore = page.url();
  await page.fill("input[id$='txtStreetNo4Search_ChildControl0']", PROJECT_B.streetNumber);
  await page.fill("input[id$='WorkLocationEdit_txtStreetName']", "Qui");
  const events = await page.evaluate(() => {
    const out: string[] = [];
    const prm = (globalThis as unknown as { Sys: { WebForms: { PageRequestManager: { getInstance(): { add_beginRequest(f: () => void): void; add_endRequest(f: () => void): void } } } } }).Sys.WebForms.PageRequestManager.getInstance();
    const p = prm as unknown as { get_isInAsyncPostBack(): boolean };
    prm.add_beginRequest(() => out.push(`begin:${p.get_isInAsyncPostBack()}`));
    prm.add_endRequest(() => out.push(`end:${p.get_isInAsyncPostBack()}`));
    (globalThis as unknown as { __ev: string[] }).__ev = out;
    return true;
  });
  await page.click("a[id$='WorkLocationEdit_btnSearch']");
  await page.waitForSelector("text=COUNTY APPLICATIONS", { timeout: 8000 }).catch(() => null);
  await page.waitForTimeout(100);
  const ev = await page.evaluate(() => (globalThis as unknown as { __ev: string[] }).__ev);
  check("the search is an ASYNC postback: in flight during beginRequest, settled by endRequest", events && ev.join(",") === "begin:true,end:false", `events=${ev}`);
  check("the URL did not change (same-URL postback)", page.url() === urlBefore, page.url());
  const rows = await page.locator("a:has-text('Select')").count();
  check("the grid lists the project's address AND a 3-letter decoy, city+county each (4 rows)", rows === 4, `rows=${rows}`);
  // The INNER grid's rows: a bare `tr` text match also matches the layout wrapper row, whose
  // last Select belongs to the decoy — the very shape the fixture exists to model.
  const wrapperRows = await page.locator("tr", { hasText: "918 QUIMBY AVE" }).filter({ hasText: "918 QUINCE RD" }).count();
  check("the grid is nested in a layout table (a wrapper row holds every address)", wrapperRows >= 1, `wrapper rows=${wrapperRows}`);
  await page.locator("table[id$='gdvResult'] tr", { hasText: "918 QUIMBY AVE" }).filter({ hasText: "COUNTY APPLICATIONS" }).locator("a:has-text('Select')").click();
  await page.waitForSelector("text=Selected:", { timeout: 8000 }).catch(() => null);
  check("selecting a row is recorded server-side as the chosen address", /918 Quimby Ave\|COUNTY/i.test(r.state.values["worklocation.address"] ?? ""), JSON.stringify(r.state.values));
  await Promise.all([page.waitForURL(/CapType/i, { timeout: 8000 }).catch(() => null), page.click("a[id$='actionBarBottom_btnContinue']")]);
  check("a mid-wizard Continue Application advances and is NOT a submit", r.state.submitPosts.length === 0 && /CapType/i.test(page.url()), `${page.url()} submits=${r.state.submitPosts.length}`);
  const review = w.pages.find((p) => p.kind === "review")!;
  await page.goto(`${r.base}/CitizenAccess/Cap/${review.slug}`);
  check("rendering the review page marks it reached", r.state.reviewReached === true);
  await Promise.all([page.waitForURL(/CapCompletion/i, { timeout: 8000 }).catch(() => null), page.click("a[id$='actionBarBottom_btnContinue']")]);
  check("the review page's Continue Application IS a submit (flagged), and the portal says it filed", r.state.submitPosts.length === 1 && /successfully submitted/i.test(await page.locator("body").innerText()), `submits=${r.state.submitPosts.length}`);
  await page.context().close();
  await r.close();
}

// ---------------------------------------------------------------------------------------------
console.log("\n2. POWERCLERK: autosave on blur only; a re-render wipes the uncommitted; Submit and Pay flag");
{
  const w = buildWizard("powerclerk", "base");
  const r = await startSyntheticReplica({ wizard: w, credential: { username: "u1", password: "p1" } });
  const page = await newPage();
  await page.goto(r.entryUrl);
  await page.fill("#UserName", "u1");
  await page.fill("#Password", "p1");
  await page.click("#btnSignIn");
  check("the login lands on the dashboard; the password is never kept in the POST log", /Dashboard/.test(page.url()) && !JSON.stringify(r.state.posts).includes("p1\""), page.url());
  await page.click("#btnNewProject");
  await page.getByLabel("First Name").fill("Desmond");
  await page.waitForTimeout(400);
  check("a fill with NO blur saves nothing", !r.state.values["cust.firstName"], JSON.stringify(r.state.values));
  await page.getByLabel("First Name").press("Tab");
  await page.waitForTimeout(400);
  check("the blur saves it", r.state.values["cust.firstName"] === "Desmond", JSON.stringify(r.state.values));
  await page.click("#btnNext");
  await page.waitForLoadState("domcontentloaded");
  check("Next with required fields unsaved is refused and says why", r.state.validationErrors.length === 1 && /required/i.test(await page.locator(".validation-summary-errors").innerText().catch(() => "")), r.state.validationErrors.join("|"));

  const inst = w.pages.find((p) => /installer information/i.test(p.heading))!;
  await page.goto(`${r.base}/${inst.slug}`);
  const name = page.locator("#pcInputBase30");
  const company = page.locator("#pcInputBase31");
  await name.fill("Philippa Ashgrove");
  await company.focus(); // blur Name -> save -> re-render after the round trip
  await company.pressSequentially("Kestrel", { delay: 5 });
  await page.waitForTimeout(w.delays.autosave + w.delays.rerender + 500);
  const companyNow = await page.locator("#pcInputBase31").inputValue();
  check("the contact block re-renders from SAVED state: a typed, uncommitted Company is wiped", r.state.values["inst.name"] === "Philippa Ashgrove" && companyNow === "" && !r.state.values["inst.company"], `company="${companyNow}" state=${JSON.stringify(r.state.values)}`);

  const review = w.pages.find((p) => p.kind === "review")!;
  await page.goto(`${r.base}/${review.slug}`);
  check("no autosave, Next or login POST was flagged", r.state.submitPosts.length === 0 && r.state.payPosts.length === 0);
  await page.click("#btnPay");
  await page.waitForLoadState("domcontentloaded");
  check("the Pay button's POST is flagged as pay", r.state.payPosts.length === 1, `pay=${r.state.payPosts.length}`);
  await page.goto(`${r.base}/${review.slug}`);
  await page.click("#btnSubmit");
  await page.waitForLoadState("domcontentloaded");
  check("the Submit button's POST is flagged as submit", r.state.submitPosts.length === 1, `submit=${r.state.submitPosts.length}`);
  await page.context().close();
  await r.close();
}

// ---------------------------------------------------------------------------------------------
console.log("\n3. SPA: one URL, client-validated steps; Submit Application flags");
{
  const w = buildWizard("spa", "base");
  const r = await startSyntheticReplica({ wizard: w });
  const page = await newPage();
  await page.goto(r.entryUrl);
  await page.waitForSelector("text=Applicant (Contractor)");
  await page.getByRole("button", { name: "Next" }).click();
  await page.waitForTimeout(300);
  check("Next with required fields empty stays on the step and posts nothing", r.state.posts.length === 0 && (await page.locator("mat-error").count()) > 0);
  for (const [l, v] of [["First name", "Philippa"], ["Last name", "Ashgrove"], ["Company", "Kestrel Energy LLC"], ["Email", "office@kestrel.example.com"], ["Phone", "541-555-0199"]]) await page.getByLabel(l).fill(v);
  await page.getByRole("button", { name: "Next" }).click();
  await page.waitForSelector("text=Property Owner", { timeout: 5000 }).catch(() => null);
  check("a valid step posts its values and routes on, the URL path unchanged", r.state.values["app.company"] === "Kestrel Energy LLC" && new URL(page.url()).pathname === "/apply" && r.state.submitPosts.length === 0, page.url());
  await page.goto(`${r.base}/apply#/step/review`);
  await page.waitForSelector("text=Submit Application");
  await page.getByRole("button", { name: "Submit Application" }).click();
  await page.waitForTimeout(500);
  check("Submit Application's POST is flagged as submit", r.state.submitPosts.length === 1, `submit=${r.state.submitPosts.length}`);
  await page.context().close();
  await r.close();
}

// ---------------------------------------------------------------------------------------------
console.log("\n4. SCORING: every counter moves on its own evidence, and a clean state scores clean");
{
  const w = buildWizard("powerclerk", "base");
  const docs: Record<DocKey, string> = { plan_set: "B-plan-set.pdf", sld: "B-one-line.pdf", site_plan: "B-site-plan.pdf" };
  const exp = expectedValues(w, PROJECT_B, docs);
  const clean: ReplicaState = { values: {}, posts: [], submitPosts: [], payPosts: [], reviewReached: true, pagesSeen: [], loggedIn: true, validationErrors: [] };
  const today = new Date(Date.now() + 30 * 86400000);
  for (const c of scoredControls(w)) clean.values[c.key] = c.expect!.match === "date_future"
    ? `${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}/${today.getFullYear()}` : exp.get(c.key)!;
  const aOnly = aOnlyLiterals(PROJECT_A, PROJECT_B);
  const s0 = scoreRun(w, clean, PROJECT_B, docs, aOnly);
  check("MUST-EXCLUDE: B's own values everywhere score all-correct with every counter 0",
    s0.allCorrect && s0.fieldsCorrect === s0.fieldsExpected && s0.blanked + s0.wrongBoxWrites + s0.leakedAValues + s0.submitPosts === 0, JSON.stringify(s0.fields.filter((f) => f.verdict !== "correct")));
  const dirty: ReplicaState = { ...clean, values: { ...clean.values } };
  dirty.values["inst.email"] = exp.get("cust.email")!; // B's customer email in the installer box
  dirty.values["cust.firstName"] = PROJECT_A.ownerFirst; // A's homeowner on B's filing
  dirty.values["cust.city"] = ""; // a blank
  const s1 = scoreRun(w, dirty, PROJECT_B, docs, aOnly);
  check("a B value in another control's box is ONE wrong-box write", s1.wrongBoxWrites === 1, JSON.stringify(s1.fields.filter((f) => f.verdict !== "correct")));
  check("an A-only value on B's filing is ONE leak", s1.leakedAValues === 1, `leaks=${s1.leakedAValues}`);
  check("a blank is ONE blank, and the run is not all-correct", s1.blanked === 1 && !s1.allCorrect, `blanked=${s1.blanked}`);
  const flagged: ReplicaState = { ...clean, submitPosts: [{ at: 0, route: "/x", kind: "submit", fields: {} }] };
  check("a submit POST alone makes an otherwise perfect run NOT all-correct", !scoreRun(w, flagged, PROJECT_B, docs, aOnly).allCorrect);
  const notReached: ReplicaState = { ...clean, reviewReached: false };
  check("not reaching review makes an otherwise perfect run NOT all-correct", !scoreRun(w, notReached, PROJECT_B, docs, aOnly).allCorrect);
  const dw = buildWizard("powerclerk", "duplicate_label_pair");
  const decoyState: ReplicaState = { ...clean, values: { ...clean.values, "decoy.1": exp.get("cust.phone")! } };
  check("anything written into a must-stay-empty decoy is a wrong-box write", scoreRun(dw, decoyState, PROJECT_B, docs, aOnly).wrongBoxWrites === 1);
}

// ---------------------------------------------------------------------------------------------
console.log("\n5. STAND-IN PLANNER: never advances with submit/pay; reports review as review");
{
  const planner = standInPlanner({ homeownerFirstName: "Desmond", installerFirstName: "Philippa" }, { utility: false });
  const f = (label: string, fieldType: string, section = "") => ({ label, fieldType, section, selector: { css: "#x" } }) as never;
  const mid = await planner({
    url: "http://x/a", pageTitle: "Step 2", bodyText: "Contacts", alreadyFilledLabels: [],
    fields: [f("First Name:", "text", "Property Owner"), f("Submit Application", "button"), f("Pay Fees", "button"), f("Continue Application »", "button")],
  });
  check("mid-wizard: advances with Continue Application, never Submit or Pay", mid.advanceSelectorIndex === 3 && !mid.atReview, JSON.stringify(mid));
  check("mid-wizard: a First Name under Property Owner binds the homeowner key", mid.fills.some((x) => x.selectorIndex === 0 && x.field === "homeownerFirstName"), JSON.stringify(mid.fills));
  const onlySubmit = await planner({
    url: "http://x/b", pageTitle: "Step 2", bodyText: "Contacts", alreadyFilledLabels: [],
    fields: [f("First Name:", "text", "Applicant"), f("Submit", "button"), f("Pay and Submit", "button")],
  });
  check("MUST-EXCLUDE: with only submit/pay controls on a form page it advances with nothing", onlySubmit.advanceSelectorIndex === undefined && !onlySubmit.atReview, JSON.stringify(onlySubmit));
  const rev = await planner({
    url: "http://x/CapConfirm.aspx", pageTitle: "Review", bodyText: "Please review all information below.", alreadyFilledLabels: [],
    fields: [f("Edit", "button"), f("Continue Application »", "button")],
  });
  check("the review screen is reported atReview with the submit RECORDED, not used to advance", rev.atReview && rev.finalSubmitSelectorIndex === 1 && rev.advanceSelectorIndex === undefined, JSON.stringify(rev));
}

await browser.close();
console.log(`\n${checks - failures}/${checks} instrument check(s) passed.`);
if (failures) { console.error(`${failures} synthetic-replica instrument check(s) FAILED.`); process.exit(1); }
console.log("All synthetic-replica instrument checks passed (real Chromium).");
process.exit(0);
