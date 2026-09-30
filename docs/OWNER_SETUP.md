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
npm ci --allow-scripts=better-sqlite3,esbuild
node scripts/doctor.mjs
```

(Until setup creates `main`, use `git checkout claude/busy-hopper-c2at3x` instead.)

**Why `--allow-scripts`:** your npm skips package install scripts unless you allow them, the same way it
did for Claude Code. `better-sqlite3` (the database) and `esbuild` (what `tsx` runs on) need theirs.
Without them, every script and test fails with errors like "Could not locate the bindings file".

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
Skip it. Fable still refuses to merge on red CI; GitHub just won't enforce it for you.

**c. Pin the Owner Digest,** your one-page report from Fable, at the top of the Issues tab:

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
- Run fewer workers: tell Fable "fleet size 3".

## 4. Talking to the team

You talk to **Fable** only. Fable runs everyone else.

| You want to | Do this |
| --- | --- |
| See what's going on | Read the pinned **Owner Digest** issue |
| Ask for anything | `gh issue create --repo Moosen-alt/SOLAR-Proj --label owner-request --title "..." --body "..."`, or the "Owner request" form on GitHub |
| Answer Fable's question | Reply on that issue in plain words. An unsigned comment from you is always read as the owner |
| Approve a `safety-critical` change | `gh pr edit <number> --repo Moosen-alt/SOLAR-Proj --add-label owner-approved` |
| See what's waiting on you | `gh issue list --repo Moosen-alt/SOLAR-Proj --label status:needs-owner` |
| Pause or resume the bots | Comment `pause` or `resume` on the Owner Digest |
| Change the fleet size | Comment `fleet size 3` (or any number) on the Owner Digest |

**Only you ever add `owner-approved`.** The bots post through your account, so GitHub can't tell
the difference. The constitution forbids them, and Fable treats any bot-applied approval as a breach.

## 5. Your own terminal Claude sessions

- **Live portal work stays with you.** PGE/PAC logins, MFA, and checking a real filing need your home
  IP and your eyes. Bots are never allowed to do it.
- For that kind of work, start Claude in a mode that asks before acting:
  `claude --permission-mode default`
- If your terminal Claude works a board issue, it follows the same rules as any worker: it reads
  `CONSTITUTION.md` and `AGENTS.md`, claims the issue, and signs its comments. Tell it
  "you are worker-local". Unsigned comments are reserved for you.
- To continue a cloud session on your machine: `claude --teleport` inside this folder.

## 6. When something breaks locally

| Symptom | Fix |
| --- | --- |
| `Could not locate the bindings file` (better-sqlite3) | `npm ci --allow-scripts=better-sqlite3,esbuild` |
| `esbuild` / `tsx` errors on every command | same as above |
| `The command line is too long.` | Pull `main`: the old test chain that caused this is gone |
| Tests fail with `fetch failed` / port in use | A test server was left running: `taskkill /F /IM node.exe` (this closes ALL node processes) |
| DOM smokes can't find a browser | `npm run portal:install` |
| Anything else | `node scripts/doctor.mjs --full` |
