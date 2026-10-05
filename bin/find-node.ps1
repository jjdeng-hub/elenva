# find-node.ps1 -- locate a Node.js executable on Windows and print its path.
#
# Called by the dev launcher .cmd (repo root) only when "where node" failed --
# i.e. Node is installed but not visible on PATH (stale PATH after an install
# or update, or a non-standard install location / version manager).
#
# Prints one absolute path on success (exit 0); prints nothing and exits 1
# when Node cannot be found. Keep this file ASCII-only (no BOM needed).

$ErrorActionPreference = "SilentlyContinue"
$candidates = @()

# 1) PATH lookup (may have failed in the caller, but re-check here anyway)
$onPath = Get-Command node.exe
if ($onPath) { $candidates += $onPath.Source }

# 2) Registry -- the official installer records its location here; this works
#    even when the PATH seen by this process is stale.
foreach ($hive in @("HKLM:\SOFTWARE\Node.js", "HKCU:\SOFTWARE\Node.js")) {
  $item = Get-ItemProperty -Path $hive -Name InstallPath
  if ($item.InstallPath) { $candidates += (Join-Path $item.InstallPath "node.exe") }
}

# 3) Common install locations
$candidates += "$env:ProgramFiles\nodejs\node.exe"
$candidates += "${env:ProgramFiles(x86)}\nodejs\node.exe"
$candidates += "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
$candidates += "$env:USERPROFILE\scoop\shims\node.exe"
$candidates += "$env:LOCALAPPDATA\Volta\bin\node.exe"
$candidates += "$env:ProgramData\chocolatey\bin\node.exe"

# 4) Version managers (nvm-windows, fnm)
$globs = @(
  "$env:APPDATA\nvm\v*\node.exe",
  "$env:LOCALAPPDATA\fnm\node-versions\*\installation\node.exe",
  "$env:APPDATA\fnm\node-versions\*\installation\node.exe"
)
foreach ($pattern in $globs) {
  $candidates += @(Get-ChildItem $pattern | Sort-Object FullName -Descending | ForEach-Object { $_.FullName })
}

foreach ($candidate in $candidates) {
  if ($candidate -and (Test-Path $candidate -PathType Leaf)) {
    Write-Output $candidate
    exit 0
  }
}
exit 1
