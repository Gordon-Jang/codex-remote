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

if (-not $Existing) {
    if (Test-Path -LiteralPath $CloudflaredOut) { Remove-Item -LiteralPath $CloudflaredOut -Force }
    if (Test-Path -LiteralPath $CloudflaredErr) { Remove-Item -LiteralPath $CloudflaredErr -Force }
    Start-Process -FilePath $Cloudflared -ArgumentList @("tunnel", "--url", "http://127.0.0.1:8765", "--no-autoupdate") -WorkingDirectory $Root -RedirectStandardOutput $CloudflaredOut -RedirectStandardError $CloudflaredErr -WindowStyle Hidden | Out-Null
}

for ($i = 0; $i -lt 60; $i++) {
    $Text = ""
    if (Test-Path -LiteralPath $CloudflaredOut) { $Text += Get-Content -LiteralPath $CloudflaredOut -Raw }
    if (Test-Path -LiteralPath $CloudflaredErr) { $Text += "`n" + (Get-Content -LiteralPath $CloudflaredErr -Raw) }

    $Match = [regex]::Match($Text, "https://[a-z0-9-]+\.trycloudflare\.com")
    if ($Match.Success) {
        $Match.Value | Set-Content -LiteralPath $UrlFile -Encoding UTF8
        Write-Host $Match.Value
        exit 0
    }
    Start-Sleep -Seconds 1
}

throw "Cloudflare Quick Tunnel URL was not found in cloudflared logs."
