# Shared helpers for scripts/dev.ps1 and scripts/prod.ps1.
#
# Dot-source this from a launcher script:  . "$PSScriptRoot\_lib.ps1"

Set-StrictMode -Version Latest

function Get-RepoRoot {
    <#  The repository root, resolved from this file's own location so the
        launchers work from any working directory. #>
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Enter-Venv {
    <#  Activate .venv unless we are already inside a virtualenv. The CLI
        entry point is `mythic` (see pyproject [project.scripts]); it only
        exists on PATH once the venv is active. #>
    param([Parameter(Mandatory)][string] $RepoRoot)

    if ($env:VIRTUAL_ENV) {
        Write-Host "venv: already active ($env:VIRTUAL_ENV)" -ForegroundColor DarkGray
        return
    }
    $activate = Join-Path $RepoRoot ".venv\Scripts\Activate.ps1"
    if (-not (Test-Path $activate)) {
        throw "No virtualenv at $RepoRoot\.venv. Create one and install the app:`n" +
              "    python -m venv .venv`n" +
              "    .\.venv\Scripts\Activate.ps1`n" +
              "    pip install -e `".[web,dev]`""
    }
    . $activate
    Write-Host "venv: activated" -ForegroundColor DarkGray
}

function Import-DotEnv {
    <#  Load `.env` from the repo root into this process's environment.

        Credentials are env-only by design in this app: `AUTHHUB_API_KEY` and
        `ANTHROPIC_API_KEY` are read straight from os.environ at client-build
        time (see config.py: authhub_api_key) and are deliberately NOT
        accepted by `POST /api/config` or stored in `.mythic.toml`. `.env` is
        gitignored, so this gives the launchers a place to pick a key up from
        without it ever reaching a committed file.

        Format: KEY=value per line; `#` comments and blank lines ignored;
        surrounding single/double quotes stripped. A variable already set in
        the real environment always wins -- `.env` never overrides an
        explicit export. #>
    param([Parameter(Mandatory)][string] $RepoRoot)

    $envFile = Join-Path $RepoRoot ".env"
    if (-not (Test-Path $envFile)) { return }

    $loaded = @()
    foreach ($line in Get-Content $envFile) {
        $trimmed = $line.Trim()
        if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }

        $split = $trimmed.IndexOf("=")
        if ($split -lt 1) { continue }

        $name  = $trimmed.Substring(0, $split).Trim()
        $value = $trimmed.Substring($split + 1).Trim()
        if ($value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
             ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        # An explicit export in the shell wins over the file.
        if ([Environment]::GetEnvironmentVariable($name)) { continue }

        [Environment]::SetEnvironmentVariable($name, $value)
        $loaded += $name
    }

    if ($loaded.Count -gt 0) {
        # Names only -- never echo a value.
        Write-Host "env: loaded $($loaded -join ', ') from .env" -ForegroundColor DarkGray
    }
}

function Show-ProviderStatus {
    <#  One line saying whether an LLM credential is present, so a missing key
        surfaces at launch instead of as a mid-session "LLM not configured"
        error from compile/query/index-graph. Never prints the key. #>

    if ($env:MYTHIC_LOCAL -eq "true" -or $env:MYTHIC_LLM_PROVIDER -eq "ollama") {
        Write-Host "llm: local (Ollama) -- no cloud credential needed" -ForegroundColor DarkGray
        return
    }
    if ($env:AUTHHUB_API_KEY) {
        Write-Host "llm: AUTHHUB_API_KEY present" -ForegroundColor DarkGray
    } elseif ($env:ANTHROPIC_API_KEY) {
        Write-Host "llm: ANTHROPIC_API_KEY present" -ForegroundColor DarkGray
    } else {
        Write-Host "llm: no API key set -- ingest will REFUSE to run (it will not" -ForegroundColor Yellow
        Write-Host "     half-ingest your files), and query/index-graph will fail." -ForegroundColor Yellow
        Write-Host "     Put AUTHHUB_API_KEY=... in .env (see .env.example), then relaunch." -ForegroundColor Yellow
    }
}

function Get-PortOwners {
    <#  PIDs listening on $Port, or an empty array. #>
    param([Parameter(Mandatory)][int] $Port)

    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    } catch {
        return @()
    }
    return @($conns | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Assert-PortFree {
    <#  Fail loudly on an occupied port, or free it with -Force.

        Orphaned dev servers accumulating across long sessions have repeatedly
        confounded live measurement in this project (see HANDOFF.md), so the
        default is to stop and name the offending PIDs rather than to drift to
        another port or silently attach to someone else's server. #>
    param(
        [Parameter(Mandatory)][int] $Port,
        [Parameter(Mandatory)][string] $Label,
        [switch] $Force
    )

    # @( ) at the call site: StrictMode unrolls a returned empty array to
    # $null, which has no .Count.
    $owners = @(Get-PortOwners -Port $Port)
    if ($owners.Count -eq 0) { return }

    if (-not $Force) {
        $desc = @($owners | ForEach-Object {
            $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
            if ($p) { "PID $_ ($($p.ProcessName))" } else { "PID $_" }
        })
        throw "Port $Port ($Label) is already in use by $($desc -join ', ').`n" +
              "Stop it, or re-run with -Force to kill it."
    }

    foreach ($procId in $owners) {
        Write-Host "port $Port ($Label): killing PID $procId" -ForegroundColor Yellow
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
}

function Stop-ProcessTree {
    <#  Kill a process and every descendant. `mythic serve` and `npm run dev`
        each sit at the top of a small tree (uvicorn workers, node); killing
        only the parent is how orphans holding a port survive a teardown. #>
    param([Parameter(Mandatory)][int] $ProcessId)

    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue)
    foreach ($c in $children) { Stop-ProcessTree -ProcessId ([int] $c.ProcessId) }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Clear-Port {
    <#  Free a port we are known to own (Assert-PortFree confirmed it was free
        before we bound it), as a belt-and-braces teardown step. #>
    param([Parameter(Mandatory)][int] $Port)

    foreach ($procId in @(Get-PortOwners -Port $Port)) {
        Stop-ProcessTree -ProcessId ([int] $procId)
    }
}

function Install-WebDeps {
    <#  `npm install`, but only when node_modules is missing -- this is the hot
        path on every launch. #>
    param([Parameter(Mandatory)][string] $RepoRoot)

    $web = Join-Path $RepoRoot "web"
    if (Test-Path (Join-Path $web "node_modules")) { return }

    Write-Host "web: node_modules missing, running npm install..." -ForegroundColor Cyan
    Push-Location $web
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }
}

function Wait-ForBackend {
    <#  Poll the backend until /api/config answers, so the first proxied
        request from the browser never races the server's startup. #>
    param(
        [Parameter(Mandatory)][string] $BaseUrl,
        [int] $TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $res = Invoke-WebRequest -Uri "$BaseUrl/api/config" -UseBasicParsing -TimeoutSec 3
            if ($res.StatusCode -eq 200) { return $true }
        } catch {
            Start-Sleep -Milliseconds 400
        }
    }
    return $false
}
