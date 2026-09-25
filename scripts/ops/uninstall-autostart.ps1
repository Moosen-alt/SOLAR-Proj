<#
.SYNOPSIS
  Removes the "SolarAutopilot-Server" scheduled task. Does NOT stop a server that is running now:
  close its window (or Ctrl+C in it) yourself when you mean to.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\ops\uninstall-autostart.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$TaskName = "SolarAutopilot-Server")
$ErrorActionPreference = "Stop"
# Import-Module has no -WhatIf; clear the preference so auto-loading under -WhatIf prints no "New Alias" noise.
$savedWhatIf = $WhatIfPreference; $WhatIfPreference = $false
Import-Module ScheduledTasks -ErrorAction SilentlyContinue
$WhatIfPreference = $savedWhatIf
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Output "'$TaskName' is not installed - nothing to remove."; exit 0 }
if ($PSCmdlet.ShouldProcess("Task Scheduler", "Unregister scheduled task '$TaskName'")) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Removed '$TaskName'. A server already running keeps running; nothing restarts it any more."
  Write-Output "Note: the supervisor window (powershell, minimized) may still be open - close it to stop automatic restarts right now."
} else {
  Write-Output "Nothing removed (-WhatIf)."
}
