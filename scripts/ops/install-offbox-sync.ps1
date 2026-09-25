<#
.SYNOPSIS
  Registers the "SolarAutopilot-OffboxSync" scheduled task: every -IntervalHours (1-4 is the
  recommended range) it runs `scripts\ops\offbox-sync.ts`, which copies new database snapshots
  (each hash-verified) and the document mirror from BACKUP_DIR to a SECOND destination.

.DESCRIPTION
  The destination is -Destination, else BACKUP_SECOND_DIR from the live .env. Use a folder that
  leaves this machine by itself: a OneDrive / Google Drive / Dropbox folder that the desktop client
  syncs, or a network share. Where production writes its backups today (BACKUP_DIR) does not change.

  DEFAULT: runs whether or not anyone is logged on (S4U, no window; register from an ELEVATED
  PowerShell). S4U has no network credentials, so a PASSWORD-PROTECTED network share will fail -
  use a cloud-synced folder, or pass -Interactive (runs only while the operator is logged on,
  with their credentials; a console window flashes each run).

  The interval here is how often the copy leaves the box. How often a snapshot is TAKEN is the
  server's BACKUP_INTERVAL_HOURS (docs/OPERATIONS.md, section 5).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\ops\install-offbox-sync.ps1 -IntervalHours 2 -Destination "D:\OneDrive\SolarBackups" -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = "SolarAutopilot-OffboxSync",
  [ValidateRange(1, 24)][int]$IntervalHours = 2,
  [string]$Destination = "",
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
$script = Join-Path $PSScriptRoot "offbox-sync.ts"
if (-not (Test-Path $tsx)) { throw "tsx not found at $tsx - run npm install in $repo first." }

$argLine = "`"$tsx`" `"$script`""
if ($Destination) { $argLine += " --to `"$Destination`"" }
$user = Get-OpsUser
$action = New-ScheduledTaskAction -Execute $node -Argument $argLine -WorkingDirectory $repo
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)
if ($Interactive) {
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
} else {
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
}
# The first copy of a 2 GB document mirror can take a while; later runs are incremental.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$task = New-ScheduledTask -Action $action -Trigger @($repeat) -Settings $settings -Principal $principal `
  -Description "Solar Autopilot off-box backup: copies snapshots (sha256-verified) and documents to a second destination every $IntervalHours h. Installed by scripts\ops\install-offbox-sync.ps1."

$notes = @(
  "destination: $(if ($Destination) { $Destination } else { 'BACKUP_SECOND_DIR from .env (must be set)' })",
  "status for the watchdog: <BACKUP_DIR>\.offbox-status.json; set WATCHDOG_OFFBOX_MAX_AGE_HOURS >= BACKUP_INTERVAL_HOURS + $IntervalHours"
)
if ($IntervalHours -gt 4) { $notes += "an interval over 4 h means up to $IntervalHours h of work exists only on this machine" }
if ($Destination -and $Destination.StartsWith("\\") -and -not $Interactive) { $notes += "a network share under S4U has no credentials - it only works if the share needs none. Prefer a cloud-synced folder or -Interactive." }
if (-not $Interactive -and -not (Test-OpsIsAdmin)) { $notes += "this PowerShell is NOT elevated - registering an S4U task will be refused. Re-run as Administrator, or pass -Interactive." }
if (Get-OpsTaskOrNull $TaskName) { $notes += "a task named '$TaskName' already exists and will be REPLACED" }
Show-OpsTaskPlan -TaskName $TaskName -Task $task -Notes $notes

if ($PSCmdlet.ShouldProcess("Task Scheduler ($user)", "Register scheduled task '$TaskName'")) {
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  if (-not (Get-OpsTaskOrNull $TaskName)) { throw "Registration reported success but '$TaskName' is not in Task Scheduler." }
  Write-Output "Registered '$TaskName'."
  Write-Output "Verify:  Start-ScheduledTask -TaskName '$TaskName'; wait for it to finish, then"
  Write-Output "         npx tsx scripts/ops/restore-drill.ts --from <destination>   (must end RESTORE DRILL: PASS)"
} else {
  Write-Output "Nothing registered (-WhatIf)."
}
