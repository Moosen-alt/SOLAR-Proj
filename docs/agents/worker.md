# Worker manual

You take one issue from the board to a reviewed-and-ready pull request. The
[constitution](../../CONSTITUTION.md) binds you; this manual is how to do it well. Read
[AGENTS.md](../../AGENTS.md) and the hard safety rules in [CLAUDE.md](../../CLAUDE.md) first.

## 0. If you are a Claude Code cloud session

- Your launch message gives your **agent id** (`worker-<n>`) and usually **your issue**. That issue
  is yours; claim it first (step 2).
- **Nobody is watching this chat.** Never ask a question here and wait. Questions and findings go on
  the issue, signed. When you're done, stop.
- The branch your session was started on is your work branch. Push there.
- Open the PR with **base `main`**. Your environment may default to another base branch; set it
  explicitly.
- Don't subscribe to PR activity or schedule check-ins. Fable reviews on its own cycle; if changes are
  requested, the issue goes back on the board for a worker (maybe you, maybe not) to pick up.

## 1. Pick an issue (skip if you were handed one)

Search open issues labeled `bot-safe`, in this order:

1. `status:changes-requested` (a PR waiting on fixes: finishing beats starting)
2. `status:ready` + `first-wave`
3. `status:ready` by priority, `P0` → `P3`, smaller `size:*` first

Skip `type:epic`, `owner-action`, and anything whose `Depends on:` line lists an open issue.

## 2. Claim it

Post a comment whose whole first line is `/claim <agent-id>` (for example `/claim worker-3`). The
board bot answers within a minute or two. Re-read the issue's comments:

- **🔒 Claimed by `<your id>`**: it's yours.
- **⛔**: taken or not claimable. Read the reason and pick another.
- **No answer after about 3 minutes**: comment `[worker-<n>] board bot did not answer /claim` and
  pick another issue. Never work an issue you don't hold.

## 3. Understand before you change anything

Read the whole issue, its epic, the issues in `Depends on:`, the files under Pointers, and the
CLAUDE.md sections for the code you'll touch ("Architecture notes" has the traps). For a bug,
**reproduce it first**: write the failing test before the fix.

If the issue is wrong (already fixed on `main`, impossible as written, or really needs a live portal
or an owner decision), don't improvise. `/release <id> <what you found>` and stop, so Fable can
fix the issue.

## 4. Implement

- Work on your branch (`agent/<issue#>-<slug>` from current `main`, or your session's branch).
- Make the smallest change that meets every acceptance criterion. Match the surrounding code: its
  naming, idiom and comment density. This codebase comments the *why* heavily; keep that up where
  you add non-obvious logic.
- The hard safety rules are not yours to trade off. If meeting the criteria seems to require
  bending one, stop and `/release` with the conflict explained.
- In shared hot files (`shared/src/types.ts`, `backend/src/db.ts`, `package.json`), add next to
  related code, not at the end, so parallel PRs don't collide.
- Migrations: next version number on current `main`.

## 5. Test

- **Regression test:** `backend/test/<name>.test.ts`, or next to the code in `portal-bot/`. Follow
  an existing test's shape: set `AUTOPILOT_DB_PATH` (and friends) to temp paths **before** importing
  `../src/db`, print `ok   - <check>` or `FAIL - <check>`, and exit non-zero on failure. No
  registration needed; the runner discovers it.
- **Prove it bites:** run your new test without your fix once and confirm it fails. Say so in the PR.
- **Run:** `npm run typecheck`; `npm run backend:test:unit -- --only <names>` for the affected
  suites; `npm run portal:test:unit` if you touched `portal-bot/`; `npm run smoke` if you touched the
  pipeline (`repository.ts`, `autopilot`, `jobQueue`, stage transitions). Run the whole backend
  suite if you touched `db.ts`, `repository.ts` or `shared/src/types.ts`.
- **Synthetic data only.** No real names, addresses, account or meter numbers, credentials, or live
  portal URLs in tests or fixtures.

## 6. Commit and open the PR

Commit messages: an imperative subject of 72 characters or fewer, and a body that explains *why*.
End with these trailers, plus any attribution lines your environment requires:

```
Refs: #<issue>
Agent: <agent-id>
```

Open **one** PR into `main`:

- Title: an imperative summary of the change.
- Body: the repository's PR template, filled in. `Closes #<issue>` on the first line, the commands
  you ran with their results, the safety checklist honestly ticked, your agent id.
- If the issue is labeled `safety-critical`, say which rule the change touches and point at the test
  that pins it.

## 7. After the PR

- Check CI when it finishes, usually within minutes. **Red because of your change:** fix it and push.
  **Red because of something else:** comment on the PR, linking or filing the P0. Don't hack around it.
- Don't merge, don't request reviewers, don't ping anyone.
- If you were handed a single issue, you're done: stop. Otherwise go back to step 1.

## 8. Fixing a PR after review (`status:changes-requested`)

Claim the issue as usual. Check out the PR's existing branch, read **every** review comment, and
address each one (or reply on the PR explaining why not). Push to the same branch; the push moves the
issue back to review. Then summarize on the PR, in one signed comment, what changed.

## 9. What you find along the way

Found a bug or gap outside your issue? File it (Bug or Task template, signed, labeled, "found while
working #<n>"). Don't fix it in your PR. Scope creep is the most common reason a good PR gets sent
back.

## 10. Comment style

Signed, short, factual. Good:

> [worker-3] Reproduced: `feeEvidencePairing.test.ts` fails on main at "pairs surcharge rows"
> because `pairEvidence` drops rows with a null `source_url`. Fix + test in #57.

Not good: greetings, restating the issue, "working on it!", or anything addressed to the owner.
