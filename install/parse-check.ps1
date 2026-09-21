# Checks that install-windows.ps1 is valid PowerShell without running it.
# Used by CI, which has no Windows machine.
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PSScriptRoot 'install-windows.ps1'), [ref]$null, [ref]$errors)
if ($errors.Count -gt 0) {
  $errors | ForEach-Object { Write-Host $_ }
  exit 1
}
Write-Host 'install-windows.ps1 parses'
