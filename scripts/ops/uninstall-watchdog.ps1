<#
.SYNOPSIS
  Removes the "SolarAutopilot-Watchdog" scheduled task (and, with -IncludeOffboxSync, the
  "SolarAutopilot-OffboxSync" task). The state and log files under data\ops are left in place.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\ops\uninstall-watchdog.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = "SolarAutopilot-Watchdog",
  [switch]$IncludeOffboxSync,
  [string]$OffboxTaskName = "SolarAutopilot-OffboxSync"
)
$ErrorActionPreference = "Stop"
# Import-Module has no -WhatIf; clear the preference so auto-loading under -WhatIf prints no "New Alias" noise.
$savedWhatIf = $WhatIfPreference; $WhatIfPreference = $false
Import-Module ScheduledTasks -ErrorAction SilentlyContinue
$WhatIfPreference = $savedWhatIf
$names = @($TaskName)
if ($IncludeOffboxSync) { $names += $OffboxTaskName }
foreach ($name in $names) {
  if (-not (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)) { Write-Output "'$name' is not installed - nothing to remove."; continue }
  if ($PSCmdlet.ShouldProcess("Task Scheduler", "Unregister scheduled task '$name'")) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Output "Removed '$name'."
  } else {
    Write-Output "Nothing removed for '$name' (-WhatIf)."
  }
}
