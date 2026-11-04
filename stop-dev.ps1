$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$StatePath = Join-Path $ProjectRoot '.dev-runtime\processes.json'
$NgrokDomain = 'thrill-snowdrop-primer.ngrok-free.dev'

if (-not (Test-Path $StatePath)) {
  Write-Host 'No start-dev.ps1 terminal ownership record found; no processes were stopped.'
  return
}
$state = Get-Content $StatePath -Raw | ConvertFrom-Json
if ($state.project -ne $ProjectRoot) { throw 'Runtime ownership record points to a different project; refusing to stop processes.' }
$processes = @(Get-CimInstance Win32_Process)
$owned = @{}
foreach ($pidValue in @($state.ownedTerminalPids)) {
  $pidValue = [int]$pidValue
  $process = $processes | Where-Object ProcessId -eq $pidValue | Select-Object -First 1
  if (-not $process -or $process.Name -notmatch '^(pwsh|powershell)(\.exe)?$') { continue }
  # Only stop terminals that still run a command for this project or the configured tunnel.
  if (-not ($process.CommandLine.Contains($ProjectRoot) -or $process.CommandLine.Contains($NgrokDomain))) { continue }
  $owned[$pidValue] = $true
}
do {
  $added = $false
  foreach ($process in $processes) {
    if ($owned.ContainsKey([int]$process.ParentProcessId) -and -not $owned.ContainsKey([int]$process.ProcessId)) {
      $owned[[int]$process.ProcessId] = $true
      $added = $true
    }
  }
} while ($added)

$roots = @($state.ownedTerminalPids | ForEach-Object { [int]$_ } | Where-Object { $owned.ContainsKey($_) })
$ordered = [System.Collections.Generic.List[int]]::new()
function Add-ProcessTree([int]$ParentPid) {
  foreach ($child in $processes | Where-Object { [int]$_.ParentProcessId -eq $ParentPid -and $owned.ContainsKey([int]$_.ProcessId) }) {
    Add-ProcessTree ([int]$child.ProcessId)
  }
  if (-not $ordered.Contains($ParentPid)) { $ordered.Add($ParentPid) }
}
foreach ($rootPid in $roots) { Add-ProcessTree $rootPid }
foreach ($pidValue in $ordered) {
  Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $StatePath -Force
Write-Host "Stopped only the $($ordered.Count) process(es) owned by this project's start-dev.ps1 session. PostgreSQL container and data volume were preserved."
