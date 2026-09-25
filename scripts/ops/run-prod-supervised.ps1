<#
.SYNOPSIS
  Keeps the pinned production server running: starts it when nothing is serving the port,
  restarts it when it exits, and never starts a second copy.

.DESCRIPTION
  This is what the "SolarAutopilot-Server" scheduled task runs (see install-autostart.ps1). It is
  a loop, not a one-shot:

    every -PollSeconds:
      * something already LISTENS on -Port        -> do nothing (someone started it by hand; fine)
      * a server process is already starting up    -> do nothing (it has not bound the port yet;
        (command line matches -ProcessPattern)        a second copy would migrate the DB and then
                                                      die with EADDRINUSE)
      * otherwise                                  -> run -StartScript and wait for it to exit,
                                                      then loop (= restart after a crash)

  NO 'pause' DEPENDENCY. .probe\start-prod-pinned.cmd ends with 'pause' so a human can read the
  last lines. Under a scheduled task nobody presses a key, so the script is run with its input
  redirected from NUL: 'pause' reads end-of-input and returns at once, the window closes, and this
  loop sees the exit and restarts the server.

  CRASH LOOP GUARD. Five exits in a row that each lasted under a minute (a bad .env, a broken
  pin) back off to one attempt every 5 minutes instead of hammering the database with migrations.

  Log: -LogFile (default <repo>\data\logs\autostart.log). Never logs customer data; it has none.

.PARAMETER DryRun
  Report what it would do on each cycle; start nothing. Use with -MaxCycles.

.PARAMETER MaxCycles / MaxStarts
  Test hooks: stop after that many poll cycles / completed starts. 0 = forever (the default).
#>
[CmdletBinding()]
param(
  [string]$StartScript = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) ".probe\start-prod-pinned.cmd"),
  [int]$Port = 4173,
  [string]$ProcessPattern = "*prod-pinned*server.ts*",
  [int]$PollSeconds = 30,
  [string]$LogFile = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "data\logs\autostart.log"),
  [switch]$DryRun,
  [int]$MaxCycles = 0,
  [int]$MaxStarts = 0
)

$ErrorActionPreference = "Stop"

function Write-Log([string]$Message) {
  $line = "{0} [autostart:{1}] {2}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Port, $Message
  Write-Output $line
  try {
    $dir = Split-Path $LogFile -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -Path $LogFile -Value $line -Encoding utf8
  } catch { }
}

function Test-PortListening([int]$P) {
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    # No match is an error record, not an exception: SilentlyContinue turns it into $null.
    $c = Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue
    return [bool]$c
  }
  # Get-NetTCPConnection unavailable: fall back to netstat.
  $hit = netstat -ano -p TCP | Select-String -Pattern (":{0}\s+\S+\s+LISTENING" -f $P)
  return [bool]$hit
}

function Test-ServerProcessRunning([string]$Pattern) {
  if (-not $Pattern) { return $false }
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -like $Pattern }
    return [bool]$procs
  } catch { return $false }
}

if (-not (Test-Path $StartScript)) {
  Write-Log "START SCRIPT NOT FOUND: $StartScript - nothing can be started. Fix the path and reinstall the task."
  exit 2
}

Write-Log "supervisor up (pid $PID): start script $StartScript; poll ${PollSeconds}s$(if ($DryRun) { '; DRY RUN' })"
$cycles = 0
$starts = 0
$fastExits = 0
$lastState = ""

while ($true) {
  $cycles++
  if (Test-PortListening $Port) {
    if ($lastState -ne "listening") { Write-Log "port $Port is already listening - not starting a second copy"; $lastState = "listening" }
  } elseif (Test-ServerProcessRunning $ProcessPattern) {
    if ($lastState -ne "starting") { Write-Log "a server process is already running but not listening yet - waiting, not starting a second copy"; $lastState = "starting" }
  } elseif ($DryRun) {
    Write-Log "would start: $StartScript (port $Port is free)"
    $lastState = "dry"
  } else {
    $lastState = "started"
    Write-Log "port $Port is free - starting $StartScript"
    $began = Get-Date
    # Outer quotes are stripped by cmd /c; '< NUL' makes the trailing 'pause' return immediately.
    $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"`"$StartScript`" < NUL`"" -WorkingDirectory (Split-Path $StartScript -Parent) -PassThru -WindowStyle Minimized
    $null = $proc.Handle   # Windows PowerShell 5.1 reports no ExitCode unless the handle is opened before exit
    $proc.WaitForExit()
    $ran = (Get-Date) - $began
    $starts++
    Write-Log ("server exited after {0:N0}s (exit code {1})" -f $ran.TotalSeconds, $proc.ExitCode)
    if ($ran.TotalSeconds -lt 60) { $fastExits++ } else { $fastExits = 0 }
    if ($MaxStarts -gt 0 -and $starts -ge $MaxStarts) { Write-Log "MaxStarts reached - supervisor stopping"; exit 0 }
    if ($fastExits -ge 5) {
      Write-Log "CRASH LOOP: $fastExits exits in a row under a minute each - backing off 5 minutes. Check data\logs\backend.log."
      Start-Sleep -Seconds 300
      $fastExits = 0
      continue
    }
  }
  if ($MaxCycles -gt 0 -and $cycles -ge $MaxCycles) { Write-Log "MaxCycles reached - supervisor stopping"; exit 0 }
  Start-Sleep -Seconds $PollSeconds
}
