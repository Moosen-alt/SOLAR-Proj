<#
.SYNOPSIS
  Registers the "SolarAutopilot-Watchdog" scheduled task: every -EveryMinutes it runs
  `scripts\ops\watchdog.ts --once` from the install folder (so it reads the live .env: SMTP_*,
  WATCHDOG_ALERT_TO, WATCHDOG_WEBHOOK_URL, WATCHDOG_HEARTBEAT_URL).

.DESCRIPTION
  DEFAULT: RUNS WHETHER OR NOT ANYONE IS LOGGED ON (logon type S4U), starting at boot. That is the
  point: after a power cut the machine boots, nobody logs on, the server (which needs a desktop)
  stays down - and this is what tells someone. S4U runs with no visible window and needs an
  ELEVATED PowerShell to register. It has no network credentials: SMTP and HTTPS webhooks work;
  a password-protected network share would not (the watchdog does not need one).

  -Interactive instead runs only while the operator is logged on (a console window flashes every
  run). Use it only if you cannot run elevated.

  Before relying on it:  npx tsx scripts/ops/watchdog.ts --test-alert   (must reach your phone)
  Safe to re-run; -WhatIf prints the plan and registers nothing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-watchdog.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = "SolarAutopilot-Watchdog",
  [ValidateRange(1, 60)][int]$EveryMinutes = 5,
  [switch]$Interactive
)
$ErrorActionPreference = "Stop"
# Import-Module has no -WhatIf; clear the preference so auto-loading under -WhatIf prints no "New Alias" noise.
$savedWhatIf = $WhatIfPreference; $WhatIfPreference = $false
Import-Module ScheduledTasks -ErrorAction SilentlyContinue
Import-Module (Join-Path $PSScriptRoot "OpsTasks.psm1") -Force
$WhatIfPreference = $savedWhatIf

$repo = Get-OpsRepoRoot
$node = Get-OpsNodePath
if (-not $node) { throw "node.exe not found on PATH or in Program Files\nodejs." }
$tsx = Join-Path $repo "node_modules\tsx\dist\cli.mjs"
$script = Join-Path $PSScriptRoot "watchdog.ts"
if (-not (Test-Path $tsx)) { throw "tsx not found at $tsx - run npm install in $repo first." }

$user = Get-OpsUser
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$tsx`" `"$script`" --once" -WorkingDirectory $repo
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
if ($Interactive) {
  $first = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
} else {
  $first = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
}
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$task = New-ScheduledTask -Action $action -Trigger @($first, $repeat) -Settings $settings -Principal $principal `
  -Description "Solar Autopilot watchdog: polls /health, job failures and backups every $EveryMinutes min and alerts by email/webhook. Installed by scripts\ops\install-watchdog.ps1."

$notes = @(
  "log: $(Join-Path $repo 'data\ops\watchdog.log')   state: $(Join-Path $repo 'data\ops\watchdog-state.json')",
  "set WATCHDOG_INTERVAL_SECONDS=$($EveryMinutes * 60) in .env so the watchdog knows its own cadence (gap detection)"
)
if (-not $Interactive -and -not (Test-OpsIsAdmin)) {
  $notes += "this PowerShell is NOT elevated - registering an S4U/at-startup task will be refused. Re-run as Administrator, or pass -Interactive."
}
if (Get-OpsTaskOrNull $TaskName) { $notes += "a task named '$TaskName' already exists and will be REPLACED" }
Show-OpsTaskPlan -TaskName $TaskName -Task $task -Notes $notes

if ($PSCmdlet.ShouldProcess("Task Scheduler ($user)", "Register scheduled task '$TaskName'")) {
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  if (-not (Get-OpsTaskOrNull $TaskName)) { throw "Registration reported success but '$TaskName' is not in Task Scheduler." }
  Write-Output "Registered '$TaskName'."
  Write-Output "Verify:  Start-ScheduledTask -TaskName '$TaskName'; then Get-Content '$(Join-Path $repo 'data\ops\watchdog.log')' -Tail 5"
  Write-Output "         (the first run sends an ARMED message to every channel)"
} else {
  Write-Output "Nothing registered (-WhatIf)."
}
