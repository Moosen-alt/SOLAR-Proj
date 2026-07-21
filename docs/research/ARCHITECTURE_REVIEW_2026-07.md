# Adversarial architecture review — learn-once / deterministic replay (July 2026)

Deep-research run with adversarial verification: 21 sources fetched, 100 claims
extracted, top 25 verified by independent 3-judge panels → **23 confirmed,
2 refuted**. Statements below marked CONFIRMED survived a 3-0 (or noted) panel
vote against the cited primary source.

## Verdict: KEEP the architecture; MODIFY drift handling

The "LLM-assisted learn-once, then deterministic recipe replay" design matches
the 2025–2026 state of the art. No surveyed alternative (agent-per-run browser
AI, enterprise RPA, permit-tech competitors) uses a superior applicant-side
approach; three independent vendors have productized exactly our pattern.

## Confirmed findings

1. **Agent-per-run is not production-viable on credentialed portals**
   (CONFIRMED 3-0, [WAREX, arXiv 2510.03285](https://arxiv.org/html/2510.03285)).
   Under realistic transient faults (delays/timeouts/DNS) agent success
   collapses 70–95% (WebVoyager 42%→2%; WebArena 12.4%→3.7%), and 86.6–98.2%
   of tested models clicked an injected malicious popup. Deterministic replay
   with retries handles these trivially. *Caveat: frontier stacks (Claude
   computer use, Operator) were not tested — refutation is by proxy.*
   ⚠️ REFUTED (1-2): the *fault-free baseline* numbers (12.4/17/42%) did not
   survive verification — do not quote absolute agent success rates.

2. **Cached replay is the validated industry pattern** (CONFIRMED 3-0 ×5,
   [Stagehand docs](https://docs.stagehand.dev/v2/best-practices/caching),
   [arXiv 2506.14852](https://arxiv.org/html/2506.14852v2)). Stagehand replays
   observed actions with zero LLM inference ("NO LLM INFERENCE when calling act
   on the preview"), 10–100x faster (vendor figure); plan caching cut GAIA cost
   76.42% ($69.02→$16.27) with a 0.61-point accuracy drop.
   ⚠️ REFUTED (0-3): the "~50% cost / ~27% latency / 97% accuracy" plan-caching
   figures — use the 76.42% figure, not those.

3. **Per-step repair-on-failure — not full re-record — is the state of the art
   for drift** (CONFIRMED 3-0 ×6: Stagehand, [Healenium](https://healenium.io/),
   [UiPath Healing Agent](https://docs.uipath.com/agents/automation-cloud/latest/user-guide-ha/what-is-healing-agent)).
   Stagehand re-invokes the LLM for just the failed step; Healenium heals a
   failed locator with a cheap non-LLM DOM-tree LCS comparison; UiPath's GA
   Healing Agent layers AI recovery (overlay dismissal, selector adjust, smart
   waits) on top of deterministic fallbacks as a last resort.
   → **Shipped**: per-step self-heal (`20efa7e`), multi-attribute fingerprints
   (`f38f733`), page-drift precheck (`b46ae1d`). Heals drop auto-submit until a
   human re-verifies, matching UiPath's "recommendation mode" safety posture.

4. **Enterprise RPA patterns worth adopting next** (CONFIRMED 3-0 ×8, UiPath
   docs). (a) Unified Target: multiple redundant scored methods per element
   (strict, fuzzy, image/CV) run in parallel, first match wins; (b) up to three
   anchor elements (nearby text labels) locate targets semantically; (c) bind
   stable semantic attributes, avoid positional `idx` — nth ranks last;
   (d) a centralized Object Repository: fix a shared component's selector once
   (e.g. an Accela login widget) and it propagates to every recipe — unlike our
   per-recipe embedded selectors.

5. **The only fundamentally different competitor model is Symbium** (CONFIRMED
   3-0 ×2, [symbium.com/instantpermitting](https://symbium.com/instantpermitting)):
   jurisdiction-adopted official integrations into the city's own permit
   tracking system (Accela, Tyler, CentralSquare) — government-side, with AHJ
   buy-in (~271+ CA jurisdictions under SB 379). Superior where adopted, but
   cannot cover non-adopting AHJs or utility NEM portals — the long tail where
   recipe replay remains the right tool. Strategic implication: treat official
   integration paths (SolarAPP+, Accela APIs, Symbium-covered AHJs) as a
   first-class routing tier ABOVE browser automation, per jurisdiction.

## Caveats (from the verification pass)

- Vendor docs dominate: mechanisms are verbatim-verified; performance figures
  (10–100x, ~50k tokens) are vendor-illustrative, not independent benchmarks.
- WAREX and the plan-caching paper are single unreplicated 2025 preprints.
- No verified claims survived on: bot-detection (Cloudflare/Akamai) handling,
  session/credential best practices, or Skyvern/Operator/browser-use
  head-to-head benchmarks on government portals.

## Open questions

1. How do frontier agents (Claude computer use, Operator) actually perform on
   Accela/PowerClerk-class portals under faults?
2. Legitimate, ToS-compliant bot-detection + MFA/session handling patterns —
   no verified sources found.
3. Heal-acceptance policy: what auto-accept threshold is safe for non-verified
   recipes? (Currently: no auto-accept on verified maps; heal drops
   auto-submit.)
4. Which target AHJs/utilities offer official integration paths that should
   bypass browser automation entirely, and what volume share could that absorb?

## Remaining upgrade backlog (ranked)

1. Centralized per-portal selector repository for shared components
   (login/nav widgets) referenced by recipes — fix once, propagate.
2. Anchor-based (nearby-label) targeting as an additional selector layer;
   demote `nth` to last-resort explicitly.
3. Fuzzy selector matching layer (UiPath-style) before heal kicks in.
4. Official-integration routing tier per AHJ (SolarAPP+/Accela API/Symbium
   coverage detection) before choosing portal automation.
