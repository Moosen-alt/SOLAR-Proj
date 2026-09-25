<#
.SYNOPSIS
  Registers the "SolarAutopilot-Server" scheduled task: at logon (and every few minutes after, in
  case the supervisor itself died) it runs run-prod-supervised.ps1, which starts
  .probe\start-prod-pinned.cmd when nothing serves the port and restarts it whenever it exits.

.DESCRIPTION
  RUNS AS YOU, AT LOGON, ON YOUR DESKTOP - ON PURPOSE. Production runs with PORTAL_HEADLESS=false:
  the review window a human verifies and submits from, and every MFA/CAPTCHA pause, need a visible
  browser on this desktop. A task running as SYSTEM or "whether logged on or not" runs in an
  invisible session where none of that can be seen. So:
    * after a power cut the server comes back when the operator account LOGS ON. For it to come
      back with nobody at the desk, enable automatic sign-in for this account and set the BIOS to
      power on after AC loss (docs/OPERATIONS.md, section 2).
    * it never starts a second copy: if something already listens on -Port (for example the
      window you started by hand), the supervisor waits and takes over only when that exits.

  Safe to re-run: -Force replaces an existing task of the same name.
  Try it first with -WhatIf: it prints the full plan and registers nothing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-autostart.ps1 -WhatIf
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-autostart.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = "SolarAutopilot-Server",
  [int]$Port = 4173,
  [string]$StartScript = "",
  [ValidateRange(1, 60)][int]$RepeatMinutes = 5,
  [ValidateRange(5, 600)][int]$PollSeconds = 30
)
$ErrorActionPreference = "Stop"
# Import-Module has no -WhatIf; clear the preference so auto-loading under -WhatIf prints no "New Alias" noise.
$savedWhatIf = $WhatIfPreference; $WhatIfPreference = $false
Import-Module ScheduledTasks, NetTCPIP -ErrorAction SilentlyContinue
Import-Module (Join-Path $PSScriptRoot "OpsTasks.psm1") -Force
$WhatIfPreference = $savedWhatIf

$repo = Get-OpsRepoRoot
if (-not $StartScript) { $StartScript = Join-Path $repo ".probe\start-prod-pinned.cmd" }
$supervisor = Join-Path $PSScriptRoot "run-prod-supervised.ps1"
if (-not (Test-Path $StartScript)) { throw "Start script not found: $StartScript" }
if (-not (Test-Path $supervisor)) { throw "Supervisor not found: $supervisor" }

$user = Get-OpsUser
$argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$supervisor`" -Port $Port -PollSeconds $PollSeconds -StartScript `"$StartScript`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argLine -WorkingDirectory $repo
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
# Re-launch the supervisor if it was killed; IgnoreNew makes this a no-op while it runs.
$again = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger @($atLogon, $again) -Settings $settings -Principal $principal `
  -Description "Solar Autopilot production server (pinned). Starts .probe\start-prod-pinned.cmd when port $Port is free; restarts it when it exits; never a second copy. Installed by scripts\ops\install-autostart.ps1."

$notes = @(
  "port $Port, start script $StartScript",
  "log: $(Join-Path $repo 'data\logs\autostart.log')"
)
$listening = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($listening) { $notes += "port $Port is listening right now - the task will NOT start a second copy; it takes over when that server exits" }
if (Get-OpsTaskOrNull $TaskName) { $notes += "a task named '$TaskName' already exists and will be REPLACED" }
Show-OpsTaskPlan -TaskName $TaskName -Task $task -Notes $notes

if ($PSCmdlet.ShouldProcess("Task Scheduler ($user)", "Register scheduled task '$TaskName'")) {
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  $check = Get-OpsTaskOrNull $TaskName
  if (-not $check) { throw "Registration reported success but '$TaskName' is not in Task Scheduler." }
  Write-Output "Registered '$TaskName' (state: $($check.State))."
  Write-Output "Verify:  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
  Write-Output "Start now without logging off:  Start-ScheduledTask -TaskName '$TaskName'"
  Write-Output "Then:    Get-Content '$(Join-Path $repo 'data\logs\autostart.log')' -Tail 5"
} else {
  Write-Output "Nothing registered (-WhatIf)."
}
