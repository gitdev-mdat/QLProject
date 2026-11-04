param(
  [int]$DockerWaitSeconds = 90,
  [int]$DatabaseWaitSeconds = 90,
  [int]$ApiWaitSeconds = 30
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$RuntimeDir = Join-Path $ProjectRoot '.dev-runtime'
$StatePath = Join-Path $RuntimeDir 'processes.json'
$NgrokDomain = 'thrill-snowdrop-primer.ngrok-free.dev'
$ApiHealthUrl = 'http://127.0.0.1:8787/health'

function Get-ListenerProcess([int]$Port) {
  $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($connection) { return Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" }
}

function Find-ProjectProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(pwsh|powershell|node|ngrok)(\.exe)?$' -and
    $_.CommandLine -and $_.CommandLine.Contains($ProjectRoot)
  }
}

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
$state = [ordered]@{ project = $ProjectRoot; startedAt = (Get-Date).ToString('o'); ownedTerminalPids = @() }
if (Test-Path $StatePath) {
  try {
    $prior = Get-Content $StatePath -Raw | ConvertFrom-Json
    if ($prior.project -eq $ProjectRoot) { $state.ownedTerminalPids = @($prior.ownedTerminalPids) }
  } catch { }
}

$docker = Get-Command docker -ErrorAction Stop
$dockerDesktopPaths = @(
  (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Docker\Docker\Docker Desktop.exe')
)
try { docker info --format '{{.ServerVersion}}' 2>$null | Out-Null } catch { }
if ($LASTEXITCODE -ne 0) {
  $desktop = $dockerDesktopPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($desktop) { Start-Process -FilePath $desktop -WindowStyle Minimized }
  $deadline = (Get-Date).AddSeconds($DockerWaitSeconds)
  do {
    Start-Sleep -Seconds 3
    docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
  } while ((Get-Date) -lt $deadline)
  if ($LASTEXITCODE -ne 0) { throw "Docker Engine is unavailable. Start/install Docker Desktop and retry. Docker CLI: $($docker.Source)" }
}

Push-Location $ProjectRoot
try {
  docker compose up -d postgres
  if ($LASTEXITCODE -ne 0) { throw 'docker compose up -d postgres failed.' }
  $dbDeadline = (Get-Date).AddSeconds($DatabaseWaitSeconds)
  $databaseReady = $false
  do {
    docker compose exec -T postgres pg_isready -U muse -d muse_bridge *> $null
    if ($LASTEXITCODE -eq 0) { $databaseReady = $true; break }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $dbDeadline)
  if (-not $databaseReady) { throw 'PostgreSQL did not become ready in time.' }

  # Apply pending migrations only. Never seed, reset, or remove the PostgreSQL volume.
  npm run migrate
  if ($LASTEXITCODE -ne 0) { throw 'Pending migrations failed; API startup was skipped.' }

  if (-not (Get-ListenerProcess 8787)) {
    $command = "Set-Location -LiteralPath '$ProjectRoot'; npm run dev"
    $terminal = Start-Process -FilePath 'pwsh.exe' -ArgumentList @('-NoExit', '-Command', $command) -PassThru
    $state.ownedTerminalPids += [int]$terminal.Id
  }

  $apiDeadline = (Get-Date).AddSeconds($ApiWaitSeconds)
  $apiReady = $false
  do {
    try {
      $response = Invoke-RestMethod -Uri $ApiHealthUrl -TimeoutSec 3
      if ($response.status -eq 'ok' -and $response.database -eq 'connected') { $apiReady = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $apiDeadline)
  if (-not $apiReady) { throw 'API did not report database-connected health in time.' }

  $existingTunnel = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^ngrok(\.exe)?$' -and $_.CommandLine.Contains('http 8787') -and $_.CommandLine.Contains($NgrokDomain)
  } | Select-Object -First 1
  $tunnelTerminal = $null
  if ($existingTunnel) {
    $tunnelParent = Get-CimInstance Win32_Process -Filter "ProcessId=$($existingTunnel.ParentProcessId)"
    if ($tunnelParent -and $tunnelParent.Name -match '^(pwsh|powershell)(\.exe)?$' -and $tunnelParent.CommandLine.Contains($NgrokDomain) -and $tunnelParent.CommandLine.Contains('-NoExit')) {
      $tunnelTerminal = $tunnelParent
    } else {
      # Rehome a live tunnel into a persistent dedicated terminal without creating an overlap.
      Stop-Process -Id ([int]$existingTunnel.ProcessId) -Force
      Start-Sleep -Seconds 1
    }
  }
  if (-not $existingTunnel -or -not $tunnelTerminal) {
    $ngrok = Get-Command ngrok -ErrorAction Stop
    $command = "ngrok http 8787 --url https://$NgrokDomain"
    $terminal = Start-Process -FilePath 'pwsh.exe' -ArgumentList @('-NoExit', '-Command', $command) -PassThru
    $state.ownedTerminalPids += [int]$terminal.Id
  }

  $state.startedAt = (Get-Date).ToString('o')
  $state | ConvertTo-Json -Depth 4 | Set-Content -Path $StatePath -Encoding UTF8
  Write-Host "API: $ApiHealthUrl ($($response.status); database $($response.database))"
  Write-Host "ngrok: https://$NgrokDomain"
} finally { Pop-Location }
