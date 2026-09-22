# Registers the native messaging host on Windows so the extension's update button
# can run the installer itself.
#
#   powershell -File install\native-host\register-windows.ps1
#   powershell -File install\native-host\register-windows.ps1 -Remove
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$HostName = 'com.sloemo.ad_zapper_updater'
$Target = if ($env:AD_ZAPPER_DIR) { $env:AD_ZAPPER_DIR } else { Join-Path $env:LOCALAPPDATA 'Ad Zapper' }
$HostCmd = Join-Path $Target 'install\native-host\ad-zapper-host.cmd'
$Manifest = Join-Path $env:LOCALAPPDATA 'Ad Zapper\native-host\com.sloemo.ad_zapper_updater.json'
$ExtensionId = if ($env:AD_ZAPPER_EXTENSION_ID) { $env:AD_ZAPPER_EXTENSION_ID } else { 'cpphobhbpoecbnicbeajhdcdkjdmahjf' }
$Key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $HostName

if ($Remove) {
  Remove-Item $Key -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $Manifest -Force -ErrorAction SilentlyContinue
  Write-Host 'Ad Zapper native updater unregistered'
  exit 0
}

if (-not (Test-Path $HostCmd)) { throw "cannot register: no host at $HostCmd" }

New-Item -ItemType Directory -Force -Path (Split-Path $Manifest) | Out-Null
@{
  name = $HostName
  description = 'Ad Zapper updater: runs the installer when the update button is clicked'
  path = $HostCmd
  type = 'stdio'
  allowed_origins = @('chrome-extension://' + $ExtensionId + '/')
} | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $Manifest

New-Item -Path $Key -Force | Out-Null
Set-ItemProperty -Path $Key -Name '(Default)' -Value $Manifest

Write-Host "registered $HostName -> $HostCmd"
Write-Host "extension id allowed: $ExtensionId"
