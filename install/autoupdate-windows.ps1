#Requires -Version 5
<#
.SYNOPSIS
  Puts Ad Zapper's updater on a schedule, or takes it off again.

.DESCRIPTION
  Chrome never updates an extension that did not come from the Web Store, so
  something on the machine has to. This registers a scheduled task that runs the
  installer's -UpdateOnly path every six hours: it fetches the newest source,
  swaps the folder only when there is something newer, and writes update.json
  into the folder. The extension reads that marker and reloads itself into it.

.EXAMPLE
  .\install\autoupdate-windows.ps1 -Install
  .\install\autoupdate-windows.ps1 -Status
  .\install\autoupdate-windows.ps1 -Remove
  .\install\autoupdate-windows.ps1 -RunNow
#>
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$Status,
  [switch]$RunNow,
  [string]$Target = "$env:LOCALAPPDATA\Ad Zapper"
)

$ErrorActionPreference = 'Stop'
$taskName = 'AdZapperUpdater'
$installer = Join-Path $Target 'install\install-windows.ps1'

function Say([string]$text) { Write-Host $text }

if (-not ($Install -or $Remove -or $Status -or $RunNow)) { $Install = $true }

if ($Install) {
  if (-not (Test-Path $installer)) {
    Say "no installer at $installer (point -Target at the extension folder)"
    exit 1
  }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$installer`" -UpdateOnly"
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 6)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description 'Keeps Ad Zapper up to date' -Force | Out-Null
  Say 'Auto-update registered.'
  Say "  checks   every 6 hours"
  Say "  runs     $installer -UpdateOnly"
  Say "  remove   $PSCommandPath -Remove"
  exit 0
}

if ($Remove) {
  try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Say 'Auto-update removed. The extension keeps working; it just stops updating itself.'
  } catch {
    Say 'Nothing to remove: no scheduled task by that name.'
  }
  exit 0
}

if ($Status) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Say ("registered:   " + ($(if ($task) { 'yes' } else { 'no' })))
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    Say ("last run:     " + $info.LastRunTime)
    Say ("last result:  " + $info.LastTaskResult)
    Say ("next run:     " + $info.NextRunTime)
  }
  Say ("installer:    " + (Test-Path $installer))
  $marker = Join-Path $Target 'update.json'
  if (Test-Path $marker) { Say ("marker:       " + (Get-Content $marker -Raw).Trim()) } else { Say 'marker:       none yet' }
  exit 0
}

if ($RunNow) {
  if (-not (Test-Path $installer)) {
    Say "no installer at $installer"
    exit 1
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -UpdateOnly
  exit $LASTEXITCODE
}
