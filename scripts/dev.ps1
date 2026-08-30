<#
.SYNOPSIS
    Launch the Mythic Proportion DEV stack: Vite (HMR) + FastAPI over ./dev-vault.

.DESCRIPTION
    Boots two processes and wires them together:

      * the FastAPI backend (`mythic serve`) on 127.0.0.1:8766, over the
        throwaway ./dev-vault -- your real ./my-vault is never touched;
      * the Vite dev server on http://localhost:5173, which proxies /api to
        that backend (see web/vite.config.ts).

    Open http://localhost:5173/app/. Frontend edits hot-reload; the backend
    runs as a child process and is stopped when you Ctrl+C this script, so no
    orphaned servers are left behind.

.EXAMPLE
    .\scripts\dev.ps1
.EXAMPLE
    .\scripts\dev.ps1 -Force      # kill whatever is holding 5173 / 8766 first
.EXAMPLE
    .\scripts\dev.ps1 -Empty      # create dev-vault without demo seed content
#>
[CmdletBinding()]
param(
    [int]    $Port    = 5173,
    [int]    $ApiPort = 8766,
    [string] $Vault   = "dev-vault",
    [switch] $Force,
    [switch] $Empty
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

# --- dev vault -----------------------------------------------------------
if (-not (Test-Path $vaultPath)) {
    Write-Host "vault: creating dev vault at $vaultPath" -ForegroundColor Cyan
    mythic init $vaultPath
    if ($LASTEXITCODE -ne 0) { throw "mythic init failed (exit $LASTEXITCODE)." }

    $demo = Join-Path $root "demo-vault"
    if (-not $Empty -and (Test-Path $demo)) {
        Write-Host "vault: seeding from demo-vault" -ForegroundColor Cyan
        $wikiSrc = Join-Path $demo "wiki"
        if (Test-Path $wikiSrc) {
            Copy-Item $wikiSrc -Destination $vaultPath -Recurse -Force
        }
        foreach ($f in @("index.md", "hot.md", "schema.md")) {
            $src = Join-Path $demo $f
            if (Test-Path $src) { Copy-Item $src -Destination (Join-Path $vaultPath $f) -Force }
        }
    }
} else {
    Write-Host "vault: $vaultPath" -ForegroundColor DarkGray
}

# --- ports ---------------------------------------------------------------
Assert-PortFree -Port $Port    -Label "vite"        -Force:$Force
Assert-PortFree -Port $ApiPort -Label "dev backend" -Force:$Force

Install-WebDeps -RepoRoot $root

# --- backend -------------------------------------------------------------
$logPath = Join-Path $root "web\dev_backend.log"
$apiBase = "http://127.0.0.1:$ApiPort"

Write-Host "backend: starting on $apiBase over $Vault (log: web\dev_backend.log)" -ForegroundColor Cyan
$backend = Start-Process -FilePath "mythic" `
    -ArgumentList @("serve", "--vault", $vaultPath, "--host", "127.0.0.1", "--port", "$ApiPort", "--no-browser") `
    -WorkingDirectory $root `
    -RedirectStandardOutput $logPath `
    -RedirectStandardError  "$logPath.err" `
    -PassThru -NoNewWindow

try {
    if (-not (Wait-ForBackend -BaseUrl $apiBase)) {
        throw "Backend did not answer $apiBase/api/config within 30s. See web\dev_backend.log(.err).`n" +
              "Is the web extra installed?  pip install -e `".[web]`""
    }
    Write-Host "backend: ready" -ForegroundColor Green

    Write-Host ""
    Write-Host "  DEV  ->  http://localhost:$Port/app/   (vault: $Vault)" -ForegroundColor Green
    Write-Host "  Ctrl+C stops both the Vite server and the backend." -ForegroundColor DarkGray
    Write-Host ""

    # Foreground, so Ctrl+C lands here and the finally block runs.
    $env:MYTHIC_DEV_API = $apiBase
    Push-Location (Join-Path $root "web")
    try {
        npm run dev -- --port $Port
    } finally {
        Pop-Location
    }
} finally {
    # Both ports were verified free before we bound them, so anything holding
    # them now is ours -- sweep the trees rather than just the two parents, or
    # a node/uvicorn child survives and the next launch trips Assert-PortFree.
    if ($backend -and -not $backend.HasExited) {
        Write-Host "backend: stopping (PID $($backend.Id))" -ForegroundColor Yellow
        Stop-ProcessTree -ProcessId $backend.Id
    }
    Clear-Port -Port $ApiPort
    Clear-Port -Port $Port
    Write-Host "dev: stopped." -ForegroundColor DarkGray
}
