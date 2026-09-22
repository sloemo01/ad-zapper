# Gets Chrome to a loaded Ad Zapper, from a clone or from nothing.
#
# Inside a checkout it uses that folder. Anywhere else (a downloaded copy, or a
# fresh machine) it fetches the newest main from GitHub into a permanent folder
# and installs from there. Then it opens chrome://extensions with the folder
# path on your clipboard, waits while you click Load unpacked, and opens a page
# to check it on.
#
# Usage:
#   install-windows.ps1                 # install, from a clone or by download
#   install-windows.ps1 -Download       # force a fresh download
#   install-windows.ps1 -DownloadOnly   # fetch and check it, stop before Chrome
#   install-windows.ps1 -DryRun         # report only, no downloads, no browser
#
# $env:AD_ZAPPER_DIR overrides where the downloaded copy lives.
#
param(
  [switch]$DryRun,
  [switch]$Download,
  [switch]$DownloadOnly,
  [switch]$UpdateOnly
)

$ErrorActionPreference = 'Stop'
$Repo = 'sloemo01/ad-zapper'
$Ref = 'main'
$Rev = 'installer rev 3, 2026-09-22'
$Target = if ($env:AD_ZAPPER_DIR) { $env:AD_ZAPPER_DIR } else { Join-Path $env:LOCALAPPDATA 'Ad Zapper' }

function Say($message) { Write-Host $message }

Say "Ad Zapper installer"
Say "  ($Rev)"
Say ""

# -UpdateOnly is what the background task runs: fetch the newest source, compare it
# with what is installed, swap only when it is newer, and leave a marker file in the
# folder saying which version is now there. The extension reads that marker and
# reloads itself into it. Chrome is never touched by this path.
if ($UpdateOnly) {
  # Ask for the version first: a few hundred bytes from the API instead of the
  # whole archive when there is nothing new.
  $remote = $null
  try {
    $remote = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/contents/manifest.json?ref=$Ref" -Headers @{ Accept = 'application/vnd.github.raw' } -UseBasicParsing) | ConvertFrom-Json
  } catch { }
  if (-not $remote) {
    try { $remote = (Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$Repo/$Ref/manifest.json" -UseBasicParsing).Content | ConvertFrom-Json } catch { }
  }
  $oldInstalled = $null
  $oldManifest = Join-Path $Target 'manifest.json'
  if (Test-Path $oldManifest) { $oldInstalled = (Get-Content $oldManifest -Raw | ConvertFrom-Json).version }
  $noopStamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  if ($remote -and $remote.version -and $oldInstalled -and -not ([version]$remote.version -gt [version]$oldInstalled)) {
    Set-Content -Path (Join-Path $Target 'update.json') -Value "{`"version`": `"$oldInstalled`", `"at`": `"$noopStamp`"}" -Encoding ASCII
    Say "up to date ($oldInstalled), nothing downloaded"
    exit 0
  }
  $tmp = Join-Path $env:TEMP ("ad-zapper-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'src.zip'
    Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$Ref" -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $inner) { Say "the archive did not contain the expected folder"; exit 1 }
    $newManifest = Join-Path $inner.FullName 'manifest.json'
    if (-not (Test-Path $newManifest)) { Say "the download has no manifest.json"; exit 1 }
    $newVersion = (Get-Content $newManifest -Raw | ConvertFrom-Json).version
    if (-not $newVersion) { Say "the downloaded manifest has no version"; exit 1 }
    foreach ($file in Get-ChildItem (Join-Path $inner.FullName 'rules') -Filter *.json) {
      Get-Content $file.FullName -Raw | ConvertFrom-Json | Out-Null
    }
    $oldVersion = $null
    $oldManifest = Join-Path $Target 'manifest.json'
    if (Test-Path $oldManifest) { $oldVersion = (Get-Content $oldManifest -Raw | ConvertFrom-Json).version }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $newer = $true
    if ($oldVersion) { $newer = ([version]$newVersion -gt [version]$oldVersion) }
    if (-not $newer) {
      Set-Content -Path (Join-Path $Target 'update.json') -Value "{""version"": ""$oldVersion"", ""at"": ""$stamp""}" -Encoding ASCII
      Say "up to date ($oldVersion)"
      exit 0
    }
    $parent = Split-Path -Parent $Target
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
    Move-Item $inner.FullName $Target
    Set-Content -Path (Join-Path $Target 'update.json') -Value "{""version"": ""$newVersion"", ""at"": ""$stamp""}" -Encoding ASCII
    Register-NativeHost $Target
    Say "updated $oldVersion -> $newVersion"
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

# 1. Where does the extension come from?
$Src = $null
if ($PSScriptRoot) {
  $candidate = Join-Path $PSScriptRoot '..'
  if (Test-Path (Join-Path $candidate 'manifest.json')) {
    $Src = (Resolve-Path $candidate).Path
  }
}

$needDownload = $Download -or $DownloadOnly -or (-not $Src)

if ($DryRun) {
  if ($needDownload) {
    Say "1/4  dry run: would download github.com/$Repo ($Ref) into:"
    Say "       $Target"
  } else {
    Say "1/4  dry run: would use the checkout at $Src"
  }
} elseif ($needDownload) {
  Say "1/4  fetching the newest $Ref from github.com/$Repo ..."
  $tmp = Join-Path $env:TEMP ("ad-zapper-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'src.zip'
    Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$Ref" -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $inner) { Say "the archive did not contain the expected folder"; exit 1 }
    $parent = Split-Path -Parent $Target
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
    Move-Item $inner.FullName $Target
    $Src = $Target
    Say "      downloaded into $Src"
  } catch {
    Say "the download failed: $($_.Exception.Message)"
    Say "Check the network, then rerun, or install from a clone:"
    Say "  git clone https://github.com/$Repo.git"
    Say "  cd ad-zapper"
    Say "  powershell -NoProfile -ExecutionPolicy Bypass -File install\install-windows.ps1"
    exit 1
  } finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }
} else {
  Say "1/4  using the checkout at $Src"
}

# The extension cannot write files, so it cannot replace the folder Chrome loaded.
# This registers a small native host that can: the update button asks it to run the
# -UpdateOnly path above, then the extension reads the marker and reloads into it.
function Register-NativeHost([string]$Dir) {
  if ($env:AD_ZAPPER_NO_NATIVE_HOST) { return }
  $script = Join-Path $Dir 'install\native-host\register-windows.ps1'
  if (-not (Test-Path $script)) { return }
  try {
    $env:AD_ZAPPER_DIR = $Dir
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script | Out-Null
    Say "native updater registered for $Dir"
  } catch {
    Say "native updater not registered; the update button will copy a command instead"
  }
}

# 2. The folder has to be a working extension
if ($DryRun) {
  Say "2/4  dry run: manifest and rule sets left unchecked."
} else {
  foreach ($relative in @('manifest.json', 'rules\dnr_1.json', 'src\background.js')) {
    if (-not (Test-Path (Join-Path $Src $relative))) {
      Say "missing $relative"
      Say "That folder is not a complete copy of the extension."
      exit 1
    }
  }
  $null = Get-Content (Join-Path $Src 'manifest.json') -Raw | ConvertFrom-Json
  $sets = Get-ChildItem (Join-Path $Src 'rules\*.json')
  foreach ($set in $sets) { $null = Get-Content $set.FullName -Raw | ConvertFrom-Json }
  Say "2/4  manifest and $($sets.Count) rule sets parse."
}

if ($DownloadOnly) {
  Say ""
  Say "Done. The extension is ready to load from:"
  Say "  $Src"
  exit 0
}

Register-NativeHost $Src

# 3. Chrome
$candidates = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path $_) }
$chrome = $candidates | Select-Object -First 1

if (-not $chrome) {
  if ($DryRun) {
    Say "3/4  Chrome is not in the usual places (fine for a dry run)."
  } else {
    Say "3/4  Chrome is not in the usual places."
    Say "Install Google Chrome, then load the folder by hand: chrome://extensions, Developer"
    Say "mode, Load unpacked, and pick:"
    Say "  $Src"
    exit 1
  }
} else {
  Say "3/4  Chrome found at $chrome"
}

if ($DryRun) {
  Say "4/4  dry run: clipboard and browser left alone."
  exit 0
}

Set-Clipboard -Value $Src
Start-Process $chrome -ArgumentList 'chrome://extensions'
Say "4/4  chrome://extensions is open, and the folder path is on your clipboard."
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
Say "To update later, use the update button in the extension, or run this script again with"
Say "-UpdateOnly. That replaces the folder with the newest version and the extension reloads"
Say "itself into it."
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
