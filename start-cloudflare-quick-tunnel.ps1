$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$CloudflaredVersion = "2026.5.2"
$CloudflaredHash = "20b9638f685333d623798e733effbad2487093f15ba592f6c7752360ff3b7ab7"
$ToolsDir = Join-Path $Root "tools"
$RuntimeDir = Join-Path $Root "runtime"
$Cloudflared = Join-Path $ToolsDir "cloudflared.exe"
$CloudflaredOut = Join-Path $Root "cloudflared.out.log"
$CloudflaredErr = Join-Path $Root "cloudflared.err.log"
$ServerOut = Join-Path $Root "codex-remote.out.log"
$ServerErr = Join-Path $Root "codex-remote.err.log"
$UrlFile = Join-Path $RuntimeDir "quick-tunnel-url.txt"

New-Item -ItemType Directory -Force -Path $ToolsDir, $RuntimeDir | Out-Null

if (-not (Test-Path -LiteralPath $Cloudflared)) {
    $Url = "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-amd64.exe"
    Invoke-WebRequest -Uri $Url -OutFile $Cloudflared
}

$Hash = (Get-FileHash -LiteralPath $Cloudflared -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Hash -ne $CloudflaredHash) {
    throw "cloudflared checksum mismatch."
}

if (-not (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $Root -RedirectStandardOutput $ServerOut -RedirectStandardError $ServerErr -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 2
}

if (-not (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)) {
    throw "Codex Remote is not listening on 127.0.0.1:8765."
}

$Existing = Get-Process cloudflared -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $Cloudflared } |
    Select-Object -First 1

function Read-FileBestEffort {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    try { return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop } catch { return "" }
}

function Get-TunnelUrlFromLogs {
    $Text = (Read-FileBestEffort $CloudflaredOut) + "`n" + (Read-FileBestEffort $CloudflaredErr)
    $Matches = [regex]::Matches($Text, "https://[a-z0-9-]+\.trycloudflare\.com")
    if ($Matches.Count -gt 0) { return $Matches[$Matches.Count - 1].Value }
    return $null
}

function Test-TunnelUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return $false }
    $BaseUrl = $Url.TrimEnd("/")
    try {
        $Response = Invoke-WebRequest -Uri "$BaseUrl/api/health" -TimeoutSec 15 -MaximumRedirection 3 -UseBasicParsing
        return ($Response.StatusCode -ge 200 -and $Response.StatusCode -lt 500)
    } catch {
        return $false
    }
}

if ($Existing) {
    $ExistingUrl = $null
    if (Test-Path -LiteralPath $UrlFile) {
        $ExistingUrl = (Get-Content -LiteralPath $UrlFile -Raw -ErrorAction SilentlyContinue).Trim()
    }
    if (-not $ExistingUrl) {
        $ExistingUrl = Get-TunnelUrlFromLogs
    }
    if ($ExistingUrl -and (Test-TunnelUrl $ExistingUrl)) {
        $ExistingUrl | Set-Content -LiteralPath $UrlFile -Encoding UTF8
        Write-Host $ExistingUrl
        exit 0
    }

    Stop-Process -Id $Existing.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Cloudflared } | Select-Object -First 1)) {
    if (Test-Path -LiteralPath $CloudflaredOut) { Remove-Item -LiteralPath $CloudflaredOut -Force }
    if (Test-Path -LiteralPath $CloudflaredErr) { Remove-Item -LiteralPath $CloudflaredErr -Force }
    Start-Process -FilePath $Cloudflared -ArgumentList @("tunnel", "--url", "http://127.0.0.1:8765", "--no-autoupdate") -WorkingDirectory $Root -RedirectStandardOutput $CloudflaredOut -RedirectStandardError $CloudflaredErr -WindowStyle Hidden | Out-Null
}

for ($i = 0; $i -lt 60; $i++) {
    $Url = Get-TunnelUrlFromLogs
    if ($Url) {
        if (-not (Test-TunnelUrl $Url)) {
            throw "Cloudflare Quick Tunnel URL was created but is not publicly reachable yet: $Url"
        }
        $Url | Set-Content -LiteralPath $UrlFile -Encoding UTF8
        Write-Host $Url
        exit 0
    }
    Start-Sleep -Seconds 1
}

throw "Cloudflare Quick Tunnel URL was not found in cloudflared logs."
