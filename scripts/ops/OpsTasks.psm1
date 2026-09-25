# Shared helpers for the ops installers (install-autostart / install-watchdog / install-offbox-sync).
# Everything here only BUILDS or DESCRIBES a scheduled task - nothing registers, starts or stops one.
# Registration happens in each installer, behind $PSCmdlet.ShouldProcess, so -WhatIf is honoured
# (preference variables do not reliably cross into a script module, so ShouldProcess stays there).
# ASCII only: Windows PowerShell 5.1 reads a BOM-less script as the ANSI code page.

function Get-OpsRepoRoot {
  # scripts\ops\ -> repo root
  return (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
}

function Get-OpsUser {
  return "$env:USERDOMAIN\$env:USERNAME"
}

function Test-OpsIsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-OpsNodePath {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $default = Join-Path $env:ProgramFiles "nodejs\node.exe"
  if (Test-Path $default) { return $default }
  return $null
}

function Show-OpsTaskPlan {
  param(
    [string]$TaskName,
    [Microsoft.Management.Infrastructure.CimInstance]$Task,
    [string[]]$Notes = @()
  )
  Write-Output ""
  Write-Output "Scheduled task plan: $TaskName"
  foreach ($a in $Task.Actions) {
    Write-Output ("  action     {0} {1}" -f $a.Execute, $a.Arguments)
    Write-Output ("  in folder  {0}" -f $a.WorkingDirectory)
  }
  foreach ($t in $Task.Triggers) {
    $kind = $t.CimClass.CimClassName -replace "^MSFT_Task", "" -replace "Trigger$", ""
    $rep = if ($t.Repetition -and $t.Repetition.Interval) { " repeating every $($t.Repetition.Interval)" } else { "" }
    Write-Output ("  trigger    {0}{1}" -f $kind, $rep)
  }
  Write-Output ("  runs as    {0} (logon type {1}, run level {2})" -f $Task.Principal.UserId, $Task.Principal.LogonType, $Task.Principal.RunLevel)
  Write-Output ("  instances  {0} (a second trigger while one is running is ignored)" -f $Task.Settings.MultipleInstances)
  $limit = if ($Task.Settings.ExecutionTimeLimit -eq "PT0S") { "none" } else { $Task.Settings.ExecutionTimeLimit }
  Write-Output ("  time limit {0}" -f $limit)
  foreach ($n in $Notes) { Write-Output "  NOTE       $n" }
  Write-Output ""
}

function Get-OpsTaskOrNull([string]$TaskName) {
  return (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
}

Export-ModuleMember -Function Get-OpsRepoRoot, Get-OpsUser, Test-OpsIsAdmin, Get-OpsNodePath, Show-OpsTaskPlan, Get-OpsTaskOrNull
