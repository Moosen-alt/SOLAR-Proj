# Access plan — get every portal we CAN log into to 95%

The operator's framing, adopted as the target:

> Fleet-wide 95% is not the goal. **For the portals we can log into, 95%.** Wrong URLs get
> found and replaced. Wrong credentials get flagged for a human to fix, then re-fired.
> MFA/CAPTCHA opens a real window, a human clicks past it, and the run resumes.

That makes ACCESS a pipeline with three fixable inputs rather than a wall, and it makes the
sellable number honest: **per-portal replay reliability >=95% on supported portals**, where
supported = we can authenticate AND the recipe passed a replay self-test.

Measured starting point (`data/learn-benchmark/latest.json`, 2026-09-08): 57 measured,
access 23 (40.4%). Blockers: 10 MFA/CAPTCHA, 9 credential refused, 9 login-form-not-recognised
(mostly wrong URLs), 3 WAF, 2 dead host, 1 no credential.

---

## Track A — Wrong URLs: find and replace (highest value, lowest risk)

Six corrections are already browser-verified in `docs/HANDOFF.md` (each opened read-only, no
credentials, page title and login/apply controls recorded). One of them —
`snohomishcountywa.gov` — currently resolves to **facebook.com**.

**A1. Apply them to `portal_credentials.portal_url`, ONE AT A TIME.**
Between each: `npm run learn:benchmark -- --host <new-host>` and read the rung.
Batching is what turns one wrong replacement into a silent wrong-portal learn — exactly the
`gilbertaz` failure already on record, where the stored URL points at `/f/permitext` and the
bot dutifully learns a *Permit Extension Request*.

Per row, re-check CLAUDE.md rule 5 (a permit track must never resolve a utility URL). All six
are AHJ permit-track credentials and all six replacements are permit portals.

**A2. Resolve the four still-unknown URLs** — `business.ct.gov`, `permitwizard.dcra.dc.gov`,
`www.miramarfl.gov`, `www.palmbayfl.gov` — the same way: read the jurisdiction's own site for
the link it gives applicants, then verify in a real browser before it is stored. A search
result is not evidence; the first Akron candidate returned "Page Can Not Be Found".

**A3. Make a wrong URL impossible to learn silently.** `looksNotLikeAPortal` already refuses a
social host. Extend the same refusal to a page with no login AND no application entry, so a
city information page is reported as a bad stored URL instead of scoring
`login form not recognised` and looking like an engine defect.

> **Exit test.** `login form not recognised` **9 -> <=2**. Access **40.4% -> ~48%**.

---

## Track B — Wrong credentials: flag for a human, then re-fire

The data already exists and nothing surfaces it. `portalCredentials.ts` computes
`stale = last_login_failed_at > last_login_ok_at` (a later success clears it by itself), and
`staleCredentials(db, clientId)` at `:376` returns the list. The learn benchmark honours the
flag by SKIPPING those portals — which is correct, and means a dead credential silently
removes a portal from the fleet forever.

**B1. Surface the work list.** Print it at the end of every learn/replay benchmark: host,
username, when it last worked, and the portal's own refusal wording. That last field matters —
"password expired" and "account locked" need different human actions.

**B2. Operator UI.** A "Credentials needing attention" panel in the dashboard: the same list,
each row with an edit control and a **Re-test** button that re-fires a single-host learn and
clears `stale` on success. `esc()` everything; the route is deny-by-default and must be
scoped or `routeScope.test.ts` fails until it is.

**B3. Distinguish refusal from lockout.** Record the portal's wording alongside the flag.
Nine refusals today are one bucket; some are expired passwords, some are locked accounts, and
one is an account that no longer exists. A human fixing them needs to know which.

> **Exit test.** Every refused credential appears in one list with its reason, and a corrected
> credential is re-tested from the UI without a developer. Access **+up to 10 rows**.

---

## Track C — MFA / CAPTCHA: headed handoff, human clicks past, run resumes

**This is not CAPTCHA solving and must never become it.** The automation never answers a
challenge. It opens a real window, waits for a person, and continues from where it stopped.

Most of the machinery exists:

- `autoLearn.ts:682` already relaunches HEADED once when `looksBotBlocked(...)` — proven live
  on gosolarapp.org. Trigger, budget-carry and "too little budget left" guard are all written.
- `autoLearn.ts:481` is a **patch-by-demonstration** sink: with a headed browser left open,
  every fix the operator makes by hand is captured into the recipe in replayable position.
- `promoteOnHumanSubmit` (`:493`) already promotes a recording when the human submits.
- The learn already detects the challenge and returns `pauseReason: "mfa_captcha"`.

**C1. Extend the headed retry trigger from bot-block to challenge.** Same code path, one more
condition: `looksBotBlocked(msg) || learn.pauseReason === "mfa_captcha"`. Gate on
`PORTAL_HEADED_CHALLENGE=1` and on a display existing, so a server never waits for a human who
cannot arrive.

**C2. Wait for the human, then resume — do not restart.** On the headed attempt, when the
challenge is detected: surface it (console + `onProgress`), then poll for the challenge to
CLEAR (its frame/element gone, or an authenticated signal appears), up to a generous
`PORTAL_CHALLENGE_WAIT_MS` (default ~5 min). On clear, continue the walk from that page.
Restarting the learn would re-trigger the challenge and waste the human's work.

**C3. Say what is being asked, in the operator's words.** "Ameren is asking for a one-time
code — clear it in the window and the run will carry on." A silent parked browser is
indistinguishable from a hang; that mistake has cost this project hours already.

**C4. Never in the benchmark by default.** A 59-portal sweep must stay unattended.
`--headed-challenge` opts a targeted run in; the sweep records MFA rows as portal-owned as it
does today.

> **Exit test.** `npm run learn:benchmark -- --host <mfa-host> --headed-challenge` opens a real
> window, prints what is being asked, waits, and after a human clears it the run continues past
> login and records steps. Up to **10 rows** become reachable — with a person present.

---

## Track D — The number, once A-C land

Re-baseline and report per-portal, worst-first:

- **Supported portals** = access works AND the recipe passed a replay self-test.
- **Reliability** = k-of-N clean per portal, `summarizeReliability()` (already written).
- 95% is asserted **per supported portal**, never as a fleet average. A 95% mean over five
  portals is compatible with one failing every other run, and the operator meets one portal.

> **Exit test.** `npm run replay:benchmark -- --repeat 3` reports every supported portal at
> >=95%, or names the one that is not and why.

---

## Order, and the one thing that could waste a day

A -> B -> C. Track A is data with a verified answer already in hand; B is surfacing data that
already exists; C is real engineering on top of a mechanism that already works.

**The risk in C:** the challenge-cleared detector. "The CAPTCHA frame disappeared" and "the
login succeeded" are not the same event, and getting it wrong means either resuming into a
still-blocked page or waiting out the full timeout on a portal the human already cleared.
Kill it early: write the detector against the two challenge shapes already captured in the
learn debug bundles before wiring any resume logic.
