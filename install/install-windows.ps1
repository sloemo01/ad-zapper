# Walks you from a cloned folder to a loaded extension in Chrome: checks the
# checkout, opens chrome://extensions with the folder path on your clipboard,
# waits while you click Load unpacked, then opens a page and says what to look
# for, including the debugger bar.
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
    Say "This is not a full checkout of the repository. Clone or download it again, then rerun."
    exit 1
  }
}

$null = Get-Content (Join-Path $Root 'manifest.json') -Raw | ConvertFrom-Json
$sets = Get-ChildItem (Join-Path $Root 'rules\*.json')
foreach ($set in $sets) { $null = Get-Content $set.FullName -Raw | ConvertFrom-Json }
Say "2/3  manifest and $($sets.Count) rule sets parse."

# 3. Clipboard, then the extension page
if ($DryRun) {
  Say "3/3  dry run: clipboard and browser left alone."
  Say ""
  Say "Would have opened chrome://extensions with this path on the clipboard:"
  Say "  $Root"
  exit 0
}

Set-Clipboard -Value $Root
Start-Process $chrome -ArgumentList 'chrome://extensions'
Say "3/3  chrome://extensions is open, and the folder path is on your clipboard."
Say ""
Say "In Chrome, four steps:"
Say "  1. Developer mode, the toggle at the top right."
Say "  2. Load unpacked, top left. In the folder dialog, paste the path (Ctrl+V) into"
Say "     the File name box and press Enter, then Select Folder."
Say "  3. Chrome shows a dialog listing what the extension can do, Debugger among the"
Say "     entries. That permission is what lets one layer inspect requests on the sites"
Say "     that need it. Click Add extension."
Say "  4. The card appears. Pin the toolbar icon if you want the counter in view."
Say ""
Say "Press Enter once the card is showing, and this opens a page to test it on."
[void](Read-Host)
Start-Process $chrome -ArgumentList 'https://www.youtube.com/'
Say ""
Say "Chrome is on YouTube. What to look for:"
Say "  - the toolbar icon counts up once ads are stopped."
Say "  - a bar under the address bar reading ""Ad Zapper started debugging this browser""."
Say "    That is the deep block attaching. It only shows on sites that need it, and it"
Say "    goes away on its own."
Say "  - DevTools (Ctrl+Shift+J) shows [yt-ad-zapper] lines on YouTube and [ad-zapper:deep]"
Say "    lines anywhere the deep block attached."
