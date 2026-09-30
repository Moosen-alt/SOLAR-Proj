# AGENTS.md

Instructions for AI coding agents (Claude, Codex, Cursor, or anything else) working in this repository.

**Read these first, every task:**

1. [CONSTITUTION.md](CONSTITUTION.md): binding rules. Roles, the GitHub board, how to claim, file,
   PR and escalate.
2. [CLAUDE.md](CLAUDE.md): architecture, commands, and the **hard safety rules**. They apply to
   every agent, not only Claude.
3. Your manual: [docs/agents/worker.md](docs/agents/worker.md), or
   [docs/agents/fable.md](docs/agents/fable.md) if you are the lead.

## The project

SOLAR-Proj automates residential solar permit and utility interconnection (NEM) submissions: parse
plan sets → QC → reviewer gate → build and fill AHJ documents → stage the portal application → a
human verifies and submits. It is a Node/TypeScript monorepo:

| Path | What |
| --- | --- |
| `backend/src` | Express API + SQLite (better-sqlite3): all business logic |
| `portal-bot/src` | Playwright automation: auto-learn, recipes, replay, human capture |
| `frontend/` | Single-page vanilla-JS dashboard |
| `shared/src/types.ts` | The one shared type surface. Add types here first. |
| `backend/test`, `portal-bot/**/*.test.ts` | Plain tsx test scripts, discovered from disk |
| `scripts/` | Test runners and operator tools |

## Setup

```bash
npm ci            # Node 22
npm run typecheck
node scripts/doctor.mjs   # checks the environment and prints the fix for anything wrong
```

If npm skips install scripts (newer npm versions do by default), `better-sqlite3` and `esbuild` break.
Use `npm ci --allow-scripts=better-sqlite3,esbuild`.

## Tests

```bash
npm run backend:test:unit                         # every backend suite
npm run backend:test:unit -- --only tenancy       # suites whose path contains "tenancy"
npm run portal:test:unit
npm run smoke                                     # end-to-end on a scratch database
npm run portal:test:dom                           # real-Chromium smokes (needs a browser)
```

A new test needs **no registration**: create `backend/test/<name>.test.ts` or
`portal-bot/**/<name>.test.ts` and the runner finds it. Tests are plain scripts: print `ok   - …`
or `FAIL - …` per check and exit non-zero on failure. Tests set `AUTOPILOT_DB_PATH` to a temp file
**before** importing `../src/db`.

## Your loop (details in the constitution, §5)

1. Fresh `main`, then `npm ci`. Read the issue and everything it points to.
2. `/claim <your-id>` on the issue; wait for the bot's 🔒.
3. Branch `agent/<issue#>-<slug>` from `main`. Stay in scope; file new issues for anything else.
4. Add a regression test that fails without your change. Typecheck and run the affected suites.
5. Open one PR into `main` from the template, with `Closes #<issue>` and your agent id.
6. Don't merge. Fix CI if it fails. If you can't finish, `/release <your-id> <why>`.

## Never

- Run anything against a live utility or AHJ portal, use real credentials, touch production data,
  or send real email.
- Put secrets, credentials, account/meter numbers or real homeowner data anywhere.
- Push to `main`, force-push `main`, merge your own PR, or apply the `owner-approved` label.
- Weaken, skip or delete a test that pins a hard safety rule.
- Edit `CONSTITUTION.md`, `AGENTS.md`, `CLAUDE.md` or `docs/HANDOFF.md` in a feature PR.
- Post an unsigned comment. Everyone shares the owner's GitHub account, and unsigned means "owner".
