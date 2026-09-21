# Puts Ad Zapper in front of you in Chrome, with the folder path on the
# clipboard so "Load unpacked" is one paste away. Everything it can check, it
# checks first; the two clicks Chrome requires are the only manual part.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1 [-DryRun]
#
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Say($message) { Write-Host $message }

Say "Ad Zapper installer"
Say ""

# 1. Chrome
$candidates = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path $_) }
$chrome = $candidates | Select-Object -First 1

if (-not $chrome) {
  if ($DryRun) {
    Say "1/3  Chrome is not in the usual places (fine for a dry run)."
  } else {
    Say "1/3  Chrome is not in the usual places."
    Say "Install Google Chrome first, or load the folder by hand: chrome://extensions,"
    Say "Developer mode, Load unpacked, then pick:"
    Say "  $Root"
    exit 1
  }
} else {
  Say "1/3  Chrome found at $chrome"
}

# 2. The folder has to be a working extension
foreach ($relative in @('manifest.json', 'rules\dnr_1.json', 'src\background.js')) {
  if (-not (Test-Path (Join-Path $Root $relative))) {
    Say "missing $relative"
    Say "This is not a full checkout of the repository. Download or clone it again, then rerun."
    exit 1
  }
}

$null = Get-Content (Join-Path $Root 'manifest.json') -Raw | ConvertFrom-Json
$sets = Get-ChildItem (Join-Path $Root 'rules\*.json')
foreach ($set in $sets) { $null = Get-Content $set.FullName -Raw | ConvertFrom-Json }
Say "2/3  manifest and $($sets.Count) rule sets parse."

# 3. Clipboard and browser
if ($DryRun) {
  Say "3/3  dry run: clipboard and browser left alone."
} else {
  Set-Clipboard -Value $Root
  Start-Process $chrome -ArgumentList 'chrome://extensions'
  Say "3/3  the folder path is on your clipboard and chrome://extensions is open."
}

Say ""
Say "Three clicks left, in Chrome:"
Say "  1. Turn on Developer mode, top right."
Say "  2. Click Load unpacked, then paste the path (Ctrl+V) and press Select Folder."
Say "  3. Open any site and check the counter on the toolbar icon."
Say ""
Say "Chrome asks about the debugger permission. One layer of the extension uses it on"
Say "the sites that need it; declining costs only that layer."
