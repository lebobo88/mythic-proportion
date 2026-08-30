<#
.SYNOPSIS
    Launch the Mythic Proportion PROD server: built assets + FastAPI over ./my-vault.

.DESCRIPTION
    Builds the React frontend into src/mythic_proportion/web/static_next/ (when
    stale) and serves your real vault at http://127.0.0.1:8765/ --
    `/app/` is the React UI, `/` the original vanilla-JS SPA.

    Safe to run alongside .\scripts\dev.ps1: different port, different vault.

.EXAMPLE
    .\scripts\prod.ps1
.EXAMPLE
    .\scripts\prod.ps1 -SkipBuild      # serve the existing build as-is
#>
[CmdletBinding()]
param(
    [int]    $Port  = 8765,
    [string] $Vault = "my-vault",
    [switch] $SkipBuild,
    [switch] $Force,
    [switch] $NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_lib.ps1"

$root = Get-RepoRoot
Set-Location $root
Enter-Venv -RepoRoot $root
Import-DotEnv -RepoRoot $root
Show-ProviderStatus

$vaultPath = if ([System.IO.Path]::IsPathRooted($Vault)) { $Vault } else { Join-Path $root $Vault }

# --- vault ---------------------------------------------------------------
# Deliberately NOT auto-created: this is the real vault, and silently
# conjuring an empty one would hide a wrong -Vault argument.
if (-not (Test-Path $vaultPath)) {
    throw "No vault at $vaultPath. Create it first:`n    mythic init $vaultPath"
}

Assert-PortFree -Port $Port -Label "prod server" -Force:$Force

# --- build ---------------------------------------------------------------
function Test-BuildStale {
    param([Parameter(Mandatory)][string] $RepoRoot)

    $indexHtml = Join-Path $RepoRoot "src\mythic_proportion\web\static_next\index.html"
    if (-not (Test-Path $indexHtml)) { return $true }

    $builtAt = (Get-Item $indexHtml).LastWriteTimeUtc
    $sources = @("web\src", "web\public", "web\index.html", "web\vite.config.ts", "web\package.json") |
        ForEach-Object { Join-Path $RepoRoot $_ } |
        Where-Object   { Test-Path $_ } |
        ForEach-Object { Get-ChildItem $_ -Recurse -File -ErrorAction SilentlyContinue }

    foreach ($f in $sources) {
        if ($f.LastWriteTimeUtc -gt $builtAt) { return $true }
    }
    return $false
}

if ($SkipBuild) {
    Write-Host "build: skipped (-SkipBuild)" -ForegroundColor DarkGray
} elseif (Test-BuildStale -RepoRoot $root) {
    Install-WebDeps -RepoRoot $root
    Write-Host "build: frontend is stale, running npm run build..." -ForegroundColor Cyan
    Push-Location (Join-Path $root "web")
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "build: up to date" -ForegroundColor DarkGray
}

# --- serve ---------------------------------------------------------------
Write-Host ""
Write-Host "  PROD ->  http://127.0.0.1:$Port/app/   (vault: $Vault)" -ForegroundColor Green
Write-Host ""

$serveArgs = @("serve", "--vault", $vaultPath, "--host", "127.0.0.1", "--port", "$Port")
if ($NoBrowser) { $serveArgs += "--no-browser" }
mythic @serveArgs
