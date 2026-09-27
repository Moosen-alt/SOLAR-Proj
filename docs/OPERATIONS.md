# Operations runbook: day one

This runbook covers running the production server on the office desktop so that it survives a power cut, keeps its backups off the machine, and tells someone when something breaks. Every step gives the exact command and how to confirm it worked.

Written 2026-09-24, from the ops audit in `.probe/volume/assess_ops.result.md` and the list in `.probe/volume/DAY1-OF-100.md`. All commands run in **PowerShell** from the install folder, `C:\Users\isobl\SOLAR-Proj`, unless the step says otherwise. Steps marked **(admin)** need PowerShell opened with **Run as administrator**.

> **Nothing in this runbook is installed yet.** The scripts are built and tested with `-WhatIf` and dry runs only. Production is not touched until the operator runs these steps.

## 0. Where things stand, and the order to fix them

| # | Problem today | Fix (section) | Verified by |
|---|---|---|---|
| 1 | The server listens on every network interface, with no login, and Node is allowed on the **Public** firewall profile | Turn auth on, add an admin password, set `AUTH_SECRET`, bind to localhost or restrict the firewall (§4) | preflight `ACCESS` = PASS |
| 2 | The box lost power 5 times in 12 days. Nothing restarts the server; it was dark for 2 h 23 min on 09-24 | UPS, BIOS power-on, automatic sign-in (§2), autostart task (§3) | restart drill (§3.4) |
| 3 | Nobody is told when the server is down, jobs fail, or backups stop | Watchdog task plus a heartbeat service outside the box (§6) | `--test-alert` arrives; ARMED message arrives |
| 4 | Every backup is on this machine. `SESSION_ENCRYPTION_KEY` is in no backup at all | Off-box copy (§5.2), key escrow (§5.3), restore drill (§5.4) | restore drill = PASS with `--no-dotenv` |
| 5 | Up to 24 h of work can be lost | `BACKUP_INTERVAL_HOURS=2` (§5.1) | preflight `BACKUP_INTERVAL_HOURS` = PASS |
| 6 | Customer links point at `http://localhost:4173` | `PUBLIC_BASE_URL` (§4.5) | preflight `PUBLIC_BASE_URL` = PASS |

**One check for all of it:**

```powershell
npx tsx scripts/ops/preflight.ts
```

This command only reads. It checks `.env`, the users table and the backup folders, and prints PASS, WARN or FAIL for each item. It never prints a secret. Run it before you start, and again after each section. Today it should FAIL on most lines.

**Every `.env` change needs a server restart.** This document asks for one restart after §4 and §5.1, done together. With autostart installed (§3), restart like this:

```powershell
Invoke-RestMethod http://127.0.0.1:4173/health | Select-Object ok, jobs   # 1. jobs.running should be 0 before you restart
# 2. click the server window (title "Solar Autopilot Server - pinned ...") and press Ctrl+C,
#    then close the window. Also confirm nobody is mid-review in a portal window.
# 3. the supervisor starts it again within ~30 s. Check:
Get-Content data\logs\autostart.log -Tail 3
Invoke-RestMethod http://127.0.0.1:4173/health | Select-Object ok, version
```

Without autostart, restart by double-clicking `.probe\start-prod-pinned.cmd` after closing the window.

**What an outage costs.** When the server stops mid-run, portal jobs that were running (`prepare_submission`, `auto_learn`, `autopilot`) are not re-run on their own. At the next start they are marked failed and each one opens a **"Background job failed"** review item. For each item, a person checks the portal for a half-filled draft before staging that filing again. With `JOB_CONCURRENCY=4`, one outage can leave up to 4 of these.

---

## 1. Before anything: a baseline

```powershell
npx tsx scripts/ops/preflight.ts            # save this output; it is the "before"
git -C .probe\prod-pinned rev-parse --short HEAD   # the pinned build production runs (0c466bb on 2026-09-24)
Invoke-RestMethod http://127.0.0.1:4173/health | Format-List ok, version, db, jobs
```

## 2. Power: UPS, power-on after a cut, automatic sign-in

### 2.1 UPS

Buy a line-interactive UPS of about 1500 VA / 900 W, with a **USB** data cable. That size runs a desktop and monitor for roughly 10–20 minutes. Plug the desktop and monitor into the **battery** outlets, not the surge-only ones, and connect the USB cable.

Windows treats a USB UPS as a battery, so the same power settings as a laptop apply:

```powershell
Get-CimInstance Win32_Battery | Format-List Name, EstimatedChargeRemaining, BatteryStatus   # must list the UPS (empty today)
# When the UPS runs low, shut down cleanly (3 = shut down). Critical level: 20 %.
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BATTERY BATACTIONCRIT 3
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BATTERY BATLEVELCRIT 20
powercfg /setactive SCHEME_CURRENT
powercfg /query SCHEME_CURRENT SUB_BATTERY BATACTIONCRIT    # "Current DC Power Setting Index: 0x00000003"
```

**How to confirm:** unplug the UPS from the wall for 30 seconds. The desktop must stay on, and `BatteryStatus` must change from 2 (on AC) to 1 (discharging). Then plug it back in.

Honest limit: a UPS shutdown still ends the Node process abruptly, because the server drains its jobs only on Ctrl+C. The database survives this; it came through all 5 power cuts intact. In-flight portal jobs become review items (see "What an outage costs" in §0). The UPS is for riding out short cuts, which were most of the 5.

Sleep on mains is already off. To confirm:

```powershell
powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE   # "Current AC Power Setting Index: 0x00000000"
```

### 2.2 Power on after a cut (BIOS)

A desktop stays off after a power cut unless the firmware says otherwise. This machine is a Lenovo (model 90V6000KUS). Restart it, press **F1** at the logo, and look under **Power** for **After Power Loss** (the name varies). Set it to **Power On**, then save and exit.

**How to confirm:** at a quiet moment, shut Windows down, switch off at the wall, wait 10 s and switch back on. The machine must boot by itself.

### 2.3 Automatic sign-in, then lock

The server has to run on the **operator's desktop**, not as a hidden service. Production runs with `PORTAL_HEADLESS=false`: the review window a person checks and submits from, and every MFA or CAPTCHA pause, need a visible browser. So after a power cut the server only comes back once this account is signed in.

For that to happen with nobody at the desk:

```powershell
winget install Microsoft.Sysinternals.Autologon   # or download Autologon from learn.microsoft.com/sysinternals
Autologon64.exe                                    # enter this account's user name, domain and password; click Enable
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' | Select-Object AutoAdminLogon, DefaultUserName
# AutoAdminLogon must be 1 and DefaultUserName this account
```

Autologon keeps the password encrypted in LSA, not in plain text. The trade-off is that anyone who can touch the machine gets this desktop. So lock the screen two minutes after each sign-in. The server keeps running while the screen is locked, and a person unlocks it to review.

```powershell
schtasks /create /tn "SolarAutopilot-LockAfterLogon" /sc onlogon /delay 0002:00 /tr "rundll32.exe user32.dll,LockWorkStation"
schtasks /query /tn "SolarAutopilot-LockAfterLogon"
```

**If you will not enable automatic sign-in:** the server returns only when someone signs in. The watchdog (§6) still runs at boot without a sign-in and alerts that the server is down, so at least someone hears about it.

Windows Update restarts the machine too. Set **Settings → Windows Update → Advanced options → Active hours** to cover the working day. Autostart handles the restarts that do happen.

## 3. Autostart: the server comes back by itself

### 3.1 What gets installed

- A scheduled task, **`SolarAutopilot-Server`**. It runs at your sign-in, and again every 5 minutes in case the supervisor itself was killed. A second copy of the task never runs alongside the first (the trigger is ignored while one is running).
- The task runs `scripts\ops\run-prod-supervised.ps1`, a loop that does the following:
  - **Starts `.probe\start-prod-pinned.cmd`** only when **nothing listens on port 4173**, and no pinned server process is still starting up. So it **never starts a second copy**. If you started the server by hand, the loop waits, and takes over when that server exits.
  - **Restarts the server when it exits.**
  - **Doesn't hang on `pause`.** It runs the start script with input from NUL, so the script's trailing `pause` returns at once.
  - **Backs off in a crash loop.** After five exits in a row, each under a minute, it waits 5 minutes between attempts.
  - **Logs** to `data\logs\autostart.log`.

### 3.2 Try it without installing anything

```powershell
powershell -ExecutionPolicy Bypass -File scripts\ops\install-autostart.ps1 -WhatIf
```

This prints the full task definition and ends with `Nothing registered (-WhatIf).` Check that the action points at `run-prod-supervised.ps1` with `-Port 4173`, and that the triggers are `Logon` and `Time repeating every PT5M`.

### 3.3 Install

Installing for your own account does not need admin.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\ops\install-autostart.ps1
Get-ScheduledTask -TaskName SolarAutopilot-Server | Get-ScheduledTaskInfo    # LastTaskResult / NextRunTime
Start-ScheduledTask -TaskName SolarAutopilot-Server                          # start the supervisor now
Get-Content data\logs\autostart.log -Tail 5
```

If the server is already running, the log says `port 4173 is already listening - not starting a second copy`. That is correct: the supervisor is now watching.

### 3.4 Restart drill (do it once, out of hours)

1. **Server crash.** Close the server window.
   - Within about 30 s, `Get-Content data\logs\autostart.log -Tail 3` shows `server exited after ...`, then `port 4173 is free - starting ...`.
   - Within about a minute, `Invoke-RestMethod http://127.0.0.1:4173/health` returns `ok : True`.
2. **Reboot.** Run `Restart-Computer`.
   - With automatic sign-in, `/health` answers within about 5 minutes of power-on, with nobody touching the machine.
3. **Power cut** (after §2): switch off at the wall with the UPS removed from the circuit, or pull the UPS input for longer than its runtime. Then restore power.
   - The machine powers on, signs in and locks, and the server returns.
   - The watchdog (§6) reports the gap as `NOTICE [gap] The watchdog did not run from ... to ...`.

**To remove autostart:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\ops\uninstall-autostart.ps1
```

This removes the task but does not stop a running server. Close the minimized supervisor window as well, to stop restarts right away.

## 4. Lock it down: login, secrets, network

Do all of §4 and §5.1 in one `.env` edit, followed by one restart. Open `.env` in Notepad: `notepad .env`.

### 4.1 Create a login before turning auth on

The one user today has **no password**, and its role is **operator**, not admin (read from the 2026-09-24 snapshot). Turning auth on without seeding a password locks everyone out.

The seed runs at startup only while **no** user has a password:

- If `ADMIN_EMAIL` matches an existing user, it sets that user's password **and leaves its role alone**. Pointing it at today's operator account therefore gives a login that every admin page refuses (diagnostics, manual backup, products).
- If `ADMIN_EMAIL` matches no user, it creates a **new account with role admin**.

So **use a new address**:

```ini
AUTH_ENABLED=true
ADMIN_EMAIL=<a NEW address, e.g. admin@yourcompany.com - not the existing operator's>
ADMIN_PASSWORD=<a long passphrase - also store it in the password manager>
```

Before restarting, preflight's `admin login` line must read `WARN ... creates a NEW admin account <address>`. It reads **FAIL** if `ADMIN_EMAIL` points at the operator account.

After the restart:

1. Sign in once at `http://127.0.0.1:4173/login` with the new address.
2. **Delete the `ADMIN_PASSWORD=` line** from `.env`; it is no longer read. preflight warns until you do.
3. Rerun preflight. `admin login` must read PASS.

The old operator account stays without a password, so it cannot sign in. That is harmless.

**If some account already has a password but none is admin** (preflight: `... can sign in, but no ADMIN account has a password`), the seed will not run again. Instead, promote one account while the server is stopped (§7 step 5), then start it:

```powershell
node -e 'const D=require(`better-sqlite3`);const d=new D(`backend/data/autopilot.sqlite`);console.log(d.prepare(`UPDATE users SET role=''admin'' WHERE email=?`).run(process.argv[1]).changes);d.close()' you@yourcompany.com
# prints 1 when one account was promoted
```

Run this from the install folder. If `.env` sets `AUTOPILOT_DB_PATH`, use that path instead of `backend/data/autopilot.sqlite`.

### 4.2 Give the session cookie its own secret

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then in `.env`:

```ini
AUTH_SECRET=<paste the output>
```

Without this, cookies are signed with `SESSION_ENCRYPTION_KEY`. **Never change `SESSION_ENCRYPTION_KEY` itself**: the 83 saved portal logins are encrypted under it (see §5.3).

### 4.3 Final submit

`PORTAL_ALLOW_FINAL_SUBMIT=1` is set today. By the operator's ruling (HANDOFF, 2026-09-24, confirmed 2026-09-26) it **stays on** for dashboard Approve & auto-submit. The switch alone submits nothing: the bot clicks a portal's final submit only when a named person approved exactly that run from the dashboard (the approval is claimed by id and burned if any gate refuses), this switch is on, AND the recipe has a valid shape with one terminal submit click after the review stop (`mayClickFinalSubmit` / `automaticSubmitRefusals`). The per-recipe "trusted for auto-submit" toggle is not part of the gate. Fees, CAPTCHA and MFA are never automated.

preflight treats it as follows:

- **FAIL** while auth is off: anyone on the network could approve a filing into a real submission.
- **WARN** once auth is on.

To turn it off (DAY1 blocker 1), delete the line and restart.

### 4.4 Who can reach the server

The server listens on `0.0.0.0:4173`. The firewall rule **"Node.js JavaScript Runtime"** allows it on the **Public** profile, and the active network is Public. Choose one of two options.

**A. Only this desk (recommended until customers need links).** In `.env`:

```ini
SERVER_HOST=127.0.0.1
```

After the restart, only this machine can reach it. **How to confirm:** from another device on the same network, open `http://<this-pc-ip>:4173/health` (find the IP with `ipconfig`); it must fail to connect. On this machine, `Invoke-RestMethod http://127.0.0.1:4173/health` still works.

Customer links (§4.5) then need a tunnel to reach `127.0.0.1:4173`, for example Cloudflare Tunnel, which gives an `https://` address without opening a port. That is not set up or tested in this repo. Test it before giving a link to a customer.

**B. Other machines on the office network need it.** Keep `SERVER_HOST` unset. **(admin)** Make the network Private and take Node off the Public profile:

```powershell
Get-NetConnectionProfile | Format-Table Name, InterfaceAlias, NetworkCategory
Set-NetConnectionProfile -InterfaceAlias "<alias from above>" -NetworkCategory Private
Get-NetFirewallRule -DisplayName "Node.js JavaScript Runtime" | Where-Object { $_.Profile -match "Public" } | Disable-NetFirewallRule
Get-NetFirewallRule -DisplayName "Node.js JavaScript Runtime" | Format-Table Profile, Direction, Action, Enabled
# every row whose Profile includes Public must show Enabled = False
```

**How to confirm auth is on (either option), after the restart:**

```powershell
Invoke-RestMethod http://127.0.0.1:4173/health | Select-Object ok                   # /health stays open: True
try { Invoke-WebRequest http://127.0.0.1:4173/api/projects -UseBasicParsing | Out-Null; "OPEN - auth is NOT on" }
catch { "status " + $_.Exception.Response.StatusCode.value__ }                        # must print: status 401
```

### 4.5 Public address for customer links

Every link a customer receives is built from `PUBLIC_BASE_URL`: the one-time credential link, and the `/status` and `/portal` pages in update emails. Today it is `http://localhost:4173`. Because it is *set*, the server's own "not set" warning never fires, and every link is dead off this machine. Set it to the `https://` address customers will actually reach:

```ini
PUBLIC_BASE_URL=https://<your public address>
```

`scripts/onboard-company.ts` warns in every dry run while this is unset or localhost. Three drafts from before this fix still carry frozen localhost links. After setting the URL, resend them with `npx tsx scripts/undelivered.ts --send`, which rebuilds each link at send time.

### 4.6 Confirm §4

```powershell
npx tsx scripts/ops/preflight.ts
```

Every line under `ACCESS` and `LINKS` must read PASS, except `PORTAL_ALLOW_FINAL_SUBMIT`, which is WARN while it stays on.

## 5. Backups: more often, off the box, and proven

Where production backs up today does not change: `BACKUP_DIR=E:/SOLAR-Proj-Backups`, an internal disk in this same machine. The steps below add to it.

### 5.1 Snapshot every 2 hours, and keep 7 days

```ini
BACKUP_INTERVAL_HOURS=2
BACKUP_KEEP=84
```

Any value from 1 to 4 works. `BACKUP_KEEP` must be at least 168 ÷ interval to keep 7 days: 84 at 2 h, 168 at 1 h, 42 at 4 h. At about 30 MB per snapshot, 84 snapshots is about 2.5 GB on E:. These settings take effect at the §4 restart.

**How to confirm:** the preflight `BACKUP_INTERVAL_HOURS` and `BACKUP_KEEP` lines read PASS. Two hours after the restart, a new `autopilot-<stamp>.sqlite` appears in `E:\SOLAR-Proj-Backups`.

### 5.2 A second copy that leaves the machine

Pick a folder that leaves the box by itself: a OneDrive, Google Drive or Dropbox folder that the desktop client syncs, or a network share. The first copy is about 2.3 GB (snapshots plus the 2.2 GB document mirror); later copies are incremental.

In `.env`:

```ini
BACKUP_SECOND_DIR=C:\Users\isobl\OneDrive\SolarBackups
BACKUP_SECOND_KEEP=24
WATCHDOG_OFFBOX_MAX_AGE_HOURS=8
```

Adjust the folder path. `BACKUP_SECOND_KEEP=24` keeps 2 days at 2 h (about 0.7 GB of snapshots), which suits a free cloud tier.

There are two parts. The first works with the build production runs today.

- **`scripts/ops/offbox-sync.ts`**, run by a scheduled task. It does four things:
  - Copies each snapshot with a SHA-256 checksum, and re-hashes the copy before accepting it.
  - Mirrors the document tree. Without it, a restore returns every plan set as a 404.
  - Rotates old copies away.
  - Refuses to copy a source snapshot that no longer matches its checksum.
- **The server itself**, after the next re-pin (§7). The newer build writes a `.sha256` next to every snapshot, and copies each new snapshot to `BACKUP_SECOND_DIR` as soon as it is taken. A failed second copy never fails the main backup, and is logged to `backend.log`.

The sync does not copy `portal-profiles\`: those browser sessions only work on this machine and this Windows account. After a restore elsewhere, the portals are signed into again using the saved passwords, which need §5.3.

```powershell
npx tsx scripts/ops/offbox-sync.ts --dry-run          # what would copy
npx tsx scripts/ops/offbox-sync.ts                    # first real copy (can take a while)
# must end: OFFBOX SYNC: OK

powershell -ExecutionPolicy Bypass -File scripts\ops\install-offbox-sync.ps1 -IntervalHours 2 -WhatIf
powershell -ExecutionPolicy Bypass -File scripts\ops\install-offbox-sync.ps1 -IntervalHours 2   # (admin)
Start-ScheduledTask -TaskName SolarAutopilot-OffboxSync
Get-Content E:\SOLAR-Proj-Backups\.offbox-status.json    # "ok": true and a recent "at"
```

The task runs without a sign-in and without a window (Windows "S4U" mode). That mode has no network password, so a **password-protected network share will fail**. Use a cloud-synced folder, or install with `-Interactive`, which runs only while you are signed in.

### 5.3 Escrow the encryption key

`SESSION_ENCRYPTION_KEY` encrypts all 83 saved portal logins, and **it is in no backup**. Restore the database onto any other machine without it, and every saved login is unreadable. Every portal password would have to be collected from the customers again. Store it now:

```powershell
Select-String -Path .env -Pattern '^SESSION_ENCRYPTION_KEY='   # copy the value; then clear the screen (cls)
```

Put it in the company password manager as **"Solar Autopilot - SESSION_ENCRYPTION_KEY (production)"**, with a second person given access. Store the admin password (§4.1) and `AUTH_SECRET` there too.

`AUTH_SECRET` matters less. Losing it only signs everyone out.

### 5.4 Restore drill (monthly, and after any backup change)

The drill restores the newest off-box snapshot into a temporary folder. It never touches the live database. It checks six things:

1. The checksum matches.
2. `integrity_check` passes.
3. The row counts look right.
4. Every document file is in the mirror.
5. **The saved logins decrypt with the key.**
6. This build can open the database.

To test the **escrowed** key rather than the copy in `.env`, paste the key from the password manager into the shell and pass `--no-dotenv`:

```powershell
$env:SESSION_ENCRYPTION_KEY = "<paste from the password manager>"
npx tsx scripts/ops/restore-drill.ts --no-dotenv --from "C:\Users\isobl\OneDrive\SolarBackups"
Remove-Item Env:\SESSION_ENCRYPTION_KEY
```

It must end with `RESTORE DRILL: PASS`, and the `logins` line must read `PASS  logins  83 of 83 saved login(s) decrypt with the key from the shell environment`.

- `FAIL logins 0 of 83` means the escrowed key is wrong. Fix the escrow today.
- Exit codes: 0 PASS, 1 FAIL, 3 PASS WITH WARNINGS.

For reference, the drill run read-only on 2026-09-24 against the newest snapshot on E: gave `PASS WITH 2 WARNING(S)`:

- **PASS:** integrity ok; schema v34 → v35; 244 of 244 documents present.
- **WARN:** no checksum, because the pinned build predates checksums.
- **WARN:** no key supplied.

**Once a quarter, run the drill on a different computer.** Copy the repo, run `npm install`, and point `--from` at the synced folder. That is the real test that the box can die.

## 6. Watchdog: someone is told

### 6.1 What it watches

`scripts/ops/watchdog.ts` runs every 5 minutes as a scheduled task, outside the server process. It sends one message when something breaks, a reminder every 6 hours while it stays broken, and one **RECOVERED** message when it clears.

| Check | Alerts when |
|---|---|
| server | `/health` doesn't answer, or returns an error, 2 polls in a row |
| queue | `/health` reports jobs pending but nothing running (a stuck worker) |
| job-failures | `/health` shows more permanently failed jobs than at the last poll. The first rise is sent at once; further rises within the next hour are added up and sent as one message ("N failed since <time>"), so a sustained failure run is a few messages an hour at most, never one per poll |
| backup | the newest snapshot is older than `BACKUP_INTERVAL_HOURS` × 1.5 + 1 h, or the last snapshot attempt failed |
| offbox | the newest off-box snapshot is older than `WATCHDOG_OFFBOX_MAX_AGE_HOURS`, or the last sync reported a problem |
| gap | the watchdog itself didn't run for 15 min or more (the machine was off); reported once it is back |

Messages are fixed sentences with counts and times. **No customer name or address is ever included**, and nothing the server or a job wrote is copied into a message.

### 6.2 Where alerts go

**Email** uses the product's own `SMTP_*` settings, the same ones client emails use. Add the recipients:

```ini
WATCHDOG_ALERT_TO=you@yourcompany.com, second.person@yourcompany.com
WATCHDOG_INTERVAL_SECONDS=300
```

**Phone push (optional, free):** install the ntfy app, subscribe to a long random topic name, and add:

```ini
WATCHDOG_WEBHOOK_URL=https://ntfy.sh/<long-random-topic>
WATCHDOG_WEBHOOK_FORMAT=text
```

Any service that accepts a POST also works (Slack, Discord, or an SMS bridge); use the default `json` format for those.

**When the whole machine is off, it cannot send anything itself.** For that, create a free check at healthchecks.io with a period of 5 minutes and a grace of 15 minutes, set it to alert your phone, and add its ping URL:

```ini
WATCHDOG_HEARTBEAT_URL=https://hc-ping.com/<uuid>
```

The watchdog pings it after every run. If the pings stop, healthchecks.io alerts you.

### 6.3 Test, then install

```powershell
npx tsx scripts/ops/watchdog.ts --print-config          # shows channels: ["email", "webhook"]
npx tsx scripts/ops/watchdog.ts --test-alert            # MUST arrive on every channel
npx tsx scripts/ops/watchdog.ts --once --dry-run        # evaluates everything, sends nothing
powershell -ExecutionPolicy Bypass -File scripts\ops\install-watchdog.ps1 -WhatIf
powershell -ExecutionPolicy Bypass -File scripts\ops\install-watchdog.ps1          # (admin)
Start-ScheduledTask -TaskName SolarAutopilot-Watchdog
Get-Content data\ops\watchdog.log -Tail 5               # "poll: server up ... alerts=1", then "deliver email: sent"
```

The first run sends one **ARMED** message with the current picture: server up or down, jobs that failed in the last 24 hours, and the age of the newest snapshot. Failed jobs from before that window are not counted. The ops audit found 30 unseen failures in all, so clear the review queue once by hand.

The task starts at boot and runs whether or not anyone is signed in, so it can report a server that did not come back.

- **If you can't run elevated:** install with `-Interactive`. It then runs only while you are signed in, and a console window flashes on each run.
- **To remove it:** `scripts\ops\uninstall-watchdog.ps1` (add `-IncludeOffboxSync` to remove the sync task too).

## 7. Deploying a new version (re-pin)

Production runs a pinned checkout, `.probe\prod-pinned`, so edits in the development tree cannot leak into it. Two things are **not** pinned: `frontend\` and `node_modules\` are served from the development tree. A frontend edit there goes live at once, against the older backend. Re-pin to keep the two close.

1. **Pick a commit that passed.** Run `npm run smoke` and `npm run backend:test:unit` on it in the development tree. Read the **last test's banner**, not the exit code.
2. **Record the rollback point:**

   ```powershell
   $old = git -C .probe\prod-pinned rev-parse --short HEAD; "rollback to: $old"
   ```

3. **Wait for quiet.** `Invoke-RestMethod http://127.0.0.1:4173/health | Select-Object -ExpandProperty jobs` must show `running : 0`. Nobody should be mid-review in a portal window.
4. **Take a named restore point.** Named snapshots are never rotated away:

   ```powershell
   $snap = Get-ChildItem E:\SOLAR-Proj-Backups\autopilot-2*.sqlite | Sort-Object LastWriteTime | Select-Object -Last 1
   Copy-Item $snap.FullName "E:\SOLAR-Proj-Backups\autopilot-pre-repin-$old.sqlite"
   ```

5. **Stop the server so the supervisor cannot restart it:**

   ```powershell
   Disable-ScheduledTask -TaskName SolarAutopilot-Server
   Stop-ScheduledTask -TaskName SolarAutopilot-Server
   # press Ctrl+C in the server window and close it; then confirm nothing listens:
   Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue   # must print nothing
   ```

6. **Move the pin:**

   ```powershell
   git -C .probe\prod-pinned checkout --detach <commit>
   ```

7. **Start and confirm:**

   ```powershell
   Enable-ScheduledTask -TaskName SolarAutopilot-Server
   Start-ScheduledTask -TaskName SolarAutopilot-Server
   Invoke-RestMethod http://127.0.0.1:4173/health | Select-Object ok, version, build
   git -C .probe\prod-pinned rev-parse --short HEAD     # the new commit
   npx tsx scripts/ops/preflight.ts
   ```

   The build pinned today (`0c466bb`) reports only `version : 0.1.0-beta` and no `build` field. Newer builds carry `build.sha`, which must match the `rev-parse` output.

   The first start of a newer build may apply database migrations; the backend log shows them. A **second** start while one is already running would apply migrations and then die with `EADDRINUSE`. The supervisor prevents that, which is one reason not to double-click the start script while the task is installed.

8. **Roll back** if needed: repeat steps 5–7 with `$old`. If a migration must be undone, restore the named snapshot from step 4. Run the restore drill on it first, and ask before overwriting the live database.

## 8. Routine

| When | What | Look for |
|---|---|---|
| Daily (10 s) | glance at the phone or email | silence, or RECOVERED after any PROBLEM |
| Weekly | `npx tsx scripts/ops/preflight.ts` | `no FAIL` |
| Weekly | the dashboard's review queue | no "Background job failed" item older than a day |
| Monthly | restore drill with `--no-dotenv` (§5.4) | `RESTORE DRILL: PASS`, all logins decrypt |
| Quarterly | restore drill on another computer; UPS runtime test | PASS; the UPS holds for more than 10 min |

## 9. Reference: settings this runbook adds or uses

| Setting | Default | Meaning |
|---|---|---|
| `AUTH_ENABLED` | off | `true` requires a login for everything except `/health`, `/login` and the public token pages |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | – | seed the first password (only while no user has one); delete the password line afterwards |
| `AUTH_SECRET` | the session key | signs login cookies |
| `SERVER_HOST` | `0.0.0.0` | `127.0.0.1` = this machine only |
| `PUBLIC_BASE_URL` | localhost | the base of every link a customer receives |
| `BACKUP_DIR` | `backend/data/backups` | where snapshots are written first (production: `E:/SOLAR-Proj-Backups`) |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | 24 / 14 | snapshot cadence and how many to keep |
| `BACKUP_SECOND_DIR` / `BACKUP_SECOND_KEEP` | off / `BACKUP_KEEP` | the off-box copy |
| `OFFBOX_SETTLE_SECONDS` | 120 | the sync skips a snapshot younger than this, since it may still be being written |
| `WATCHDOG_ALERT_TO` | – | email recipients (uses the `SMTP_*` settings) |
| `WATCHDOG_WEBHOOK_URL` / `_FORMAT` | – / `json` | push or SMS bridge; `text` for ntfy.sh |
| `WATCHDOG_HEARTBEAT_URL` | – | dead-man's switch outside the box |
| `WATCHDOG_DOWN_AFTER` | 2 | failed polls before "server down" |
| `WATCHDOG_REPEAT_HOURS` | 6 | reminder cadence while still broken (0 = never) |
| `WATCHDOG_INTERVAL_SECONDS` | 300 | the task's cadence (used to detect gaps) |
| `WATCHDOG_BACKUP_MAX_AGE_HOURS` | interval × 1.5 + 1 | snapshot age that alerts |
| `WATCHDOG_OFFBOX_MAX_AGE_HOURS` | backup max + 6 | off-box age that alerts |
| `WATCHDOG_HEALTH_URL` | `http://127.0.0.1:<PORT>/health` | what the watchdog polls |

Logs and state:

- `data\logs\backend.log`: the server; `[backup]` lines land here too from the next re-pin.
- `data\logs\autostart.log`: the supervisor.
- `data\ops\watchdog.log`: every poll, alert and delivery.
- `data\ops\watchdog-state.json`: the watchdog's state.
- `<BACKUP_DIR>\.last-backup.json` and `.offbox-status.json`: backup and sync status.
