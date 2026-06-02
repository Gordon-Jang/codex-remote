$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
}

$EnvContent = Get-Content ".env"
$TokenLine = $EnvContent | Where-Object { $_ -match '^CODEX_REMOTE_TOKEN=' } | Select-Object -First 1
if (-not $TokenLine -or $TokenLine -match '^CODEX_REMOTE_TOKEN=\s*$') {
    $Bytes = New-Object byte[] 32
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $Rng.GetBytes($Bytes)
    } finally {
        $Rng.Dispose()
    }
    $Token = [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    if ($TokenLine) {
        $EnvContent = $EnvContent -replace '^CODEX_REMOTE_TOKEN=\s*$', "CODEX_REMOTE_TOKEN=$Token"
    } else {
        $EnvContent += "CODEX_REMOTE_TOKEN=$Token"
    }
    $EnvContent | Set-Content ".env" -Encoding UTF8
    Write-Host "Configured .env with a new CODEX_REMOTE_TOKEN."
}

if (-not (Test-Path "node_modules")) {
    npm install
}

npm start
