# Owner setup: your terminal, your GitHub settings, and talking to the team

Everything here runs from your own terminal (Windows cmd or PowerShell) in `C:\Users\isobl\SOLAR-Proj`.
Every command is one line and works in both shells.

## 1. Your machine (once)

| Need | Install |
| --- | --- |
| Node.js 22 LTS (CI uses 22; 20+ works) | https://nodejs.org |
| Git | `winget install --id Git.Git -e` |
| GitHub CLI | `winget install --id GitHub.cli -e`, then `gh auth login` |
| Claude Code | `npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code` |

Close and reopen the terminal after installing anything, so PATH picks it up.

## 2. Get the code and check your setup

```
cd C:\Users\isobl\SOLAR-Proj
git fetch origin
git checkout main
git pull
npm ci
node scripts/doctor.mjs
```

(Until setup creates `main`, use `git checkout claude/busy-hopper-c2at3x` instead.)

**Install scripts:** `better-sqlite3` (the database) and `esbuild` (what `tsx` runs on) need their install
scripts. They're approved in `package.json` (`allowScripts`), so plain `npm ci` runs them. If you ever see
"Could not locate the bindings file", run `npm rebuild better-sqlite3 esbuild`.

**The doctor** checks Node, git, the dependencies, the database module, tsx, Playwright, `gh` and
Claude Code, and prints the exact fix for anything wrong. Run `node scripts/doctor.mjs --full` to also
typecheck and run a test. Re-run it whenever something feels off.

## 3. GitHub settings only you can change

Do these once, in order, after setup has created `main`.

**a. Make `main` the default branch.** Until you do, GitHub treats the old session branch as home.

```
gh repo edit Moosen-alt/SOLAR-Proj --default-branch main
```

**b. Protect `main`.** This means nothing merges unless CI passed, and nobody can force-push or delete
`main`. It binds the bots too: they use your account, and this rule applies even to admins.

```
gh api -X PUT repos/Moosen-alt/SOLAR-Proj/branches/main/protection --input .github/branch-protection.json
```

If that answers **403 "Upgrade to GitHub Pro"**: branch protection on private repos needs a paid plan.
Skip it. Helm still refuses to merge on red CI; GitHub just won't enforce it for you.

**c. Pin the Owner Digest,** your one-page report from Helm, at the top of the Issues tab:

```
gh issue list --label owner-digest
gh issue pin <number>
```

**d. Delete the dead branches.** This was blocked from the cloud session, and the branches are superseded by `main`:

```
git push origin --delete claude/project-thread-jxzy3s claude/project-thread-6nbj3b claude/parser-utility-ahj-universal-pim21l codex/claude-continuation-2026-09-16
```

After (a), the old trunk can go too: `git push origin --delete claude/busy-hopper-c2at3x`.

**e. Watch your Actions minutes.** The repo is private, so CI minutes are metered: 2,000 a month on
Free, 3,000 on Pro. A full CI run takes about 25 to 30 minutes serially. Check usage under GitHub →
Settings → Billing and plans → Usage. Your options, cheapest first:

- Let CI run suites side by side once that's proven safe: `gh variable set CI_TEST_CONCURRENCY --body 3 --repo Moosen-alt/SOLAR-Proj`
- Run CI on your own machine instead of GitHub's (free, unlimited): add a self-hosted runner under
  Settings → Actions → Runners, then `gh variable set CI_RUNNER --body self-hosted --repo Moosen-alt/SOLAR-Proj`
- Set a spending limit under Settings → Billing and pay per minute.
- Run fewer workers: tell Helm "fleet size 3".

## 4. Talking to the team

You talk to **Helm** only. Helm runs everyone else.

| You want to | Do this |
| --- | --- |
| See what's going on | Read the pinned **Owner Digest** issue |
| Ask for anything | `gh issue create --repo Moosen-alt/SOLAR-Proj --label owner-request --title "..." --body "..."`, or the "Owner request" form on GitHub |
| Answer Helm's question | Reply on that issue in plain words. An unsigned comment from you is always read as the owner |
| Approve a `safety-critical` change | `gh pr edit <number> --repo Moosen-alt/SOLAR-Proj --add-label owner-approved` |
| See what's waiting on you | `gh issue list --repo Moosen-alt/SOLAR-Proj --label status:needs-owner` |
| Pause or resume the bots | Comment `pause` or `resume` on the Owner Digest |
| Change the fleet size | Comment `fleet size 3` (or any number) on the Owner Digest |

**Only you ever add `owner-approved`.** The bots post through your account, so GitHub can't tell
the difference. The constitution forbids them, and Helm treats any bot-applied approval as a breach.

## 5. Your own terminal Claude sessions

- **Live portal work stays with you.** PGE/PAC logins, MFA, and checking a real filing need your home
  IP and your eyes. Bots are never allowed to do it.
- For that kind of work, start Claude in a mode that asks before acting:
  `claude --permission-mode default`
- If your terminal Claude works a board issue, it follows the same rules as any worker: it reads
  `CONSTITUTION.md` and `AGENTS.md`, claims the issue, and signs its comments. Tell it
  "you are worker-local". Unsigned comments are reserved for you.
- **Its queue is the `local-only` label.** Helm puts that on anything that needs your machine or
  your eyes; cloud bots can't claim those. To see it: `gh issue list --repo Moosen-alt/SOLAR-Proj --label local-only` (ready, or
  changes-requested when its PR was sent back).
  To hand your terminal one: tell it "work issue #N as worker-local".
- To continue a cloud session on your machine: `claude --teleport` inside this folder.

## 6. When something breaks locally

| Symptom | Fix |
| --- | --- |
| `Could not locate the bindings file` (better-sqlite3) | `npm ci` |
| `esbuild` / `tsx` errors on every command | same as above |
| `The command line is too long.` | Pull `main`: the old test chain that caused this is gone |
| Tests fail with `fetch failed` / port in use | A test server was left running: `taskkill /F /IM node.exe` (this closes ALL node processes) |
| DOM smokes can't find a browser | `npm run portal:install` |
| Anything else | `node scripts/doctor.mjs --full` |

## 7. Automatic updates (pull `main` and restart when idle)

`scripts/local-auto-update.mjs` keeps this checkout on current `main` so you never have to
`git pull` by hand. Every 15 minutes, if `main` has moved and nothing is in progress, it:
snapshots the database into `BACKUP_DIR` (`autopilot-pre-update-<sha>-<time>.sqlite` plus its
`.sha256`; the normal backup rotation never deletes these, and the updater keeps the newest 3),
stops this install's server, fast-forwards, runs `npm ci` only when `package-lock.json` changed,
restarts `npm start` in its own minimized window, and waits for `/health` to report the new commit.

The first update closes the `cmd /k "npm start"` window you started by hand and replaces it with a
minimized window titled "SOLAR-Proj server"; read the server's output there from then on.

**It does nothing (and says why in the log) when:**

- the checkout is not on `main`, has changes to tracked files, or has commits `main` doesn't have;
- anything is in progress: a background job running or due, a portal run queued, running, staged
  or paused for you (review window, MFA/CAPTCHA), a filing `awaiting_human_submit`, or a lookup in
  flight. It tries again 15 minutes later. A staged filing therefore holds updates until you submit
  or discard it: that is on purpose, since a restart would close the window you submit from;
- the supervised server (`run-prod-supervised.ps1`) is running: that loop owns restarts;
- the pause file exists (below), or the database snapshot fails;
- a previous cycle already failed on the same `main` commit (pull, `npm ci` or server stop). It
  records that in `data\auto-update.failed` and waits for `main` to move rather than bouncing the
  server every 15 minutes. Delete that file to make it try the same commit again.

If the pull or `npm ci` fails, it puts the checkout back on the old commit and restarts the old
server. If the new server doesn't come up on the new commit within 3 minutes, it logs
`HEALTH CHECK FAILED` and leaves it for you (no automatic rollback: the new version's migrations
may already have run; the pre-update snapshot is the way back). It starts the server again only if
one was running before the update.

Do not set `BUILD_SHA`, `APP_VERSION` or `BUILD_DATE` in this install's `.env`. With those set
`/health` reports the stamped build instead of the checkout's commit, and the updater only accepts
a commit read from git, so every update would be logged `HEALTH CHECK FAILED`.

Because it updates this folder in place, **never use `C:\Users\isobl\SOLAR-Proj` for branch work**:
agents (your terminal Claude included) work in their own `git worktree`.

**See what it would do** (changes nothing, logs nothing; it does `git fetch`):

```
node scripts/local-auto-update.mjs --dry-run
```

**Install** (once, from a normal, non-admin terminal; it runs as you, only while you're logged in,
because the server window and the portal browser need your desktop):

```
schtasks /Create /TN "SolarAutopilot-AutoUpdate" /SC MINUTE /MO 15 /IT /F /TR "cmd /c cd /d C:\Users\isobl\SOLAR-Proj && node scripts\local-auto-update.mjs"
```

A console flashes briefly every 15 minutes while it checks. A cycle holds `data\auto-update.lock`
until it finishes and refreshes it before every step, so the next scheduled run skips instead of
overlapping. A lock untouched for 45 minutes (a crashed cycle) is treated as stale and taken over.

| To | Command |
| --- | --- |
| Run one cycle now | `schtasks /Run /TN "SolarAutopilot-AutoUpdate"` |
| Pause (keeps the task) | `type nul > data\auto-update.pause` |
| Resume | `del data\auto-update.pause` |
| Disable / re-enable the task | `schtasks /Change /TN "SolarAutopilot-AutoUpdate" /DISABLE` (or `/ENABLE`) |
| Remove it | `schtasks /Delete /TN "SolarAutopilot-AutoUpdate" /F` |
| Read the log | `type data\logs\auto-update.log` |

The log has one line per action: from-sha → to-sha, skip reasons, timings. It never contains
customer data.
