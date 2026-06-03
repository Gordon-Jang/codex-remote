param(
    [ValidateSet("menu", "start", "stop", "status", "open", "folder")]
    [string]$Action = "menu"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$LocalHostName = "127.0.0.1"
$Port = 8765
$LocalUrl = "http://${LocalHostName}:$Port"
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
$EnvPath = Join-Path $Root ".env"
$EnvExamplePath = Join-Path $Root ".env.example"

function Write-Section {
    param([string]$Text)
    Write-Host ""
    Write-Host "=== $Text ==="
}

function New-RemoteToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Read-FileBestEffort {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return ""
    }

    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $reader = New-Object System.IO.StreamReader($stream)
            try {
                return $reader.ReadToEnd()
            } finally {
                $reader.Dispose()
            }
        } finally {
            $stream.Dispose()
        }
    } catch {
        return ""
    }
}

function Ensure-EnvToken {
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

    if (-not (Test-Path -LiteralPath $EnvPath)) {
        if (Test-Path -LiteralPath $EnvExamplePath) {
            Copy-Item -LiteralPath $EnvExamplePath -Destination $EnvPath
        } else {
            @(
                "CODEX_REMOTE_TOKEN="
                "CODEX_REMOTE_HOST=127.0.0.1"
                "CODEX_REMOTE_PORT=8765"
                "CODEX_REMOTE_RUNNER=mock"
            ) | Set-Content -LiteralPath $EnvPath -Encoding UTF8
        }
    }

    $content = Get-Content -LiteralPath $EnvPath -Raw
    $tokenLine = [regex]::Match($content, "(?m)^CODEX_REMOTE_TOKEN=(.*)$")
    $tokenValue = ""
    if ($tokenLine.Success) {
        $tokenValue = $tokenLine.Groups[1].Value.Trim().Trim('"').Trim("'")
    }

    if ($tokenLine.Success -and -not [string]::IsNullOrWhiteSpace($tokenValue)) {
        return
    }

    $generatedValue = New-RemoteToken
    if ($tokenLine.Success) {
        $content = [regex]::Replace($content, "(?m)^CODEX_REMOTE_TOKEN=.*$", "CODEX_REMOTE_TOKEN=$generatedValue")
        Set-Content -LiteralPath $EnvPath -Value $content -Encoding UTF8
    } else {
        Add-Content -LiteralPath $EnvPath -Value "CODEX_REMOTE_TOKEN=$generatedValue" -Encoding UTF8
    }

    Write-Host "CODEX_REMOTE_TOKEN was missing, so a new token was generated in .env."
}

function Get-TokenStatus {
    if (-not (Test-Path -LiteralPath $EnvPath)) {
        return "missing .env"
    }

    $content = Get-Content -LiteralPath $EnvPath -Raw
    $match = [regex]::Match($content, "(?m)^CODEX_REMOTE_TOKEN=(.*)$")
    if (-not $match.Success) {
        return "missing token line"
    }

    $value = $match.Groups[1].Value.Trim().Trim('"').Trim("'")
    if ([string]::IsNullOrWhiteSpace($value)) {
        return "empty"
    }

    return "configured ($($value.Length) chars)"
}

function Ensure-NodeModules {
    if (Test-Path -LiteralPath (Join-Path $Root "node_modules")) {
        return
    }

    Write-Host "node_modules not found. Running npm install..."
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) {
        $npm = Get-Command npm -ErrorAction Stop
    }

    & $npm.Source install
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed with exit code $LASTEXITCODE."
    }
}

function Ensure-Cloudflared {
    New-Item -ItemType Directory -Force -Path $ToolsDir, $RuntimeDir | Out-Null

    if (-not (Test-Path -LiteralPath $Cloudflared)) {
        $url = "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-amd64.exe"
        Write-Host "cloudflared.exe not found. Downloading $CloudflaredVersion..."
        Invoke-WebRequest -Uri $url -OutFile $Cloudflared
    }

    $hash = (Get-FileHash -LiteralPath $Cloudflared -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $CloudflaredHash) {
        throw "cloudflared checksum mismatch. Delete tools\cloudflared.exe and start again after verifying the download source."
    }
}

function Get-LocalListener {
    try {
        return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -eq $LocalHostName -or $_.LocalAddress -eq "0.0.0.0" -or $_.LocalAddress -eq "::" -or $_.LocalAddress -eq "::1" } |
            Select-Object -First 1
    } catch {
        return $null
    }
}

function Get-ProcessCommandLine {
    param([int]$ProcessId)
    try {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
        if ($processInfo) {
            return [string]$processInfo.CommandLine
        }
    } catch {
    }
    return ""
}

function Get-ProjectCloudflaredProcesses {
    $target = [System.IO.Path]::GetFullPath($Cloudflared)
    return Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object {
        try {
            $_.Path -and ([System.IO.Path]::GetFullPath($_.Path) -ieq $target)
        } catch {
            $false
        }
    }
}

function Read-TunnelUrlFile {
    if (-not (Test-Path -LiteralPath $UrlFile)) {
        return $null
    }

    $value = (Get-Content -LiteralPath $UrlFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($value -match "^https://[a-z0-9-]+\.trycloudflare\.com/?$") {
        return $value.TrimEnd("/")
    }

    return $null
}

function Get-TunnelUrlFromLogs {
    $text = (Read-FileBestEffort $CloudflaredOut) + "`n" + (Read-FileBestEffort $CloudflaredErr)
    $matches = [regex]::Matches($text, "https://[a-z0-9-]+\.trycloudflare\.com")
    if ($matches.Count -gt 0) {
        return $matches[$matches.Count - 1].Value
    }

    return $null
}

function Test-TunnelUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $false
    }

    $baseUrl = $Url.TrimEnd("/")
    try {
        $response = Invoke-WebRequest -Uri "$baseUrl/api/health" -TimeoutSec 15 -MaximumRedirection 3 -UseBasicParsing
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
            return $true
        }
    } catch {
    }

    try {
        $response = Invoke-WebRequest -Uri $baseUrl -TimeoutSec 15 -MaximumRedirection 3 -UseBasicParsing
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
    } catch {
        return $false
    }
}

function Wait-ForLocalService {
    for ($i = 0; $i -lt 20; $i++) {
        $listener = Get-LocalListener
        if ($listener) {
            return $listener
        }
        Start-Sleep -Milliseconds 500
    }

    return $null
}

function Wait-ForTunnelUrl {
    for ($i = 0; $i -lt 60; $i++) {
        $url = Get-TunnelUrlFromLogs
        if ($url) {
            $url | Set-Content -LiteralPath $UrlFile -Encoding UTF8
            return $url
        }
        Start-Sleep -Seconds 1
    }

    throw "Cloudflare Quick Tunnel URL was not found in cloudflared logs."
}

function Start-LocalService {
    Ensure-EnvToken
    Ensure-NodeModules

    $listener = Get-LocalListener
    if ($listener) {
        Write-Host "Local service already running on $LocalUrl (PID $($listener.OwningProcess))."
        return
    }

    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) {
        $node = Get-Command node -ErrorAction Stop
    }

    Write-Host "Starting local Codex Remote service..."
    Start-Process -FilePath $node.Source -ArgumentList @("server.js") -WorkingDirectory $Root -RedirectStandardOutput $ServerOut -RedirectStandardError $ServerErr -WindowStyle Hidden | Out-Null

    $listener = Wait-ForLocalService
    if (-not $listener) {
        $errText = Read-FileBestEffort $ServerErr
        if ($errText.Trim()) {
            Write-Host ""
            Write-Host "Latest server error log:"
            Write-Host $errText.Trim()
        }
        throw "Codex Remote is not listening on $LocalUrl."
    }

    Write-Host "Local service started on $LocalUrl (PID $($listener.OwningProcess))."
}

function Start-QuickTunnel {
    Ensure-Cloudflared

    $existing = Get-ProjectCloudflaredProcesses | Select-Object -First 1
    if ($existing) {
        $url = Read-TunnelUrlFile
        if (-not $url) {
            $url = Get-TunnelUrlFromLogs
            if ($url) {
                $url | Set-Content -LiteralPath $UrlFile -Encoding UTF8
            }
        }

        if ($url -and (Test-TunnelUrl $url)) {
            Write-Host "Cloudflare Quick Tunnel already running (PID $($existing.Id))."
            Write-Host "Public URL: $url"
            return $url
        }

        Write-Host "Existing Cloudflare Quick Tunnel is not publicly reachable. Restarting tunnel..."
        foreach ($process in @(Get-ProjectCloudflaredProcesses)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }

    if (Test-Path -LiteralPath $CloudflaredOut) { Remove-Item -LiteralPath $CloudflaredOut -Force }
    if (Test-Path -LiteralPath $CloudflaredErr) { Remove-Item -LiteralPath $CloudflaredErr -Force }

    Write-Host "Starting Cloudflare Quick Tunnel..."
    Start-Process -FilePath $Cloudflared -ArgumentList @("tunnel", "--url", $LocalUrl, "--no-autoupdate") -WorkingDirectory $Root -RedirectStandardOutput $CloudflaredOut -RedirectStandardError $CloudflaredErr -WindowStyle Hidden | Out-Null

    $url = Wait-ForTunnelUrl
    if (-not (Test-TunnelUrl $url)) {
        throw "Cloudflare Quick Tunnel URL was created but is not publicly reachable yet: $url"
    }
    Write-Host "Public URL: $url"
    return $url
}

function Start-All {
    Write-Section "Start"
    Start-LocalService
    $url = Start-QuickTunnel
    Write-Host ""
    Write-Host "Ready."
    Write-Host "Local URL:  $LocalUrl"
    if ($url) {
        Write-Host "Public URL: $url"
    }
    Write-Host "Token:      $(Get-TokenStatus)"
}

function Stop-All {
    Write-Section "Stop"

    $cloudflaredProcesses = @(Get-ProjectCloudflaredProcesses)
    if ($cloudflaredProcesses.Count -eq 0) {
        Write-Host "Cloudflare Quick Tunnel is not running for this project."
    } else {
        foreach ($process in $cloudflaredProcesses) {
            Write-Host "Stopping Cloudflare Quick Tunnel (PID $($process.Id))..."
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }

    $listener = Get-LocalListener
    if (-not $listener) {
        Write-Host "Local service is not listening on port $Port."
        return
    }

    $ownerPid = [int]$listener.OwningProcess
    $process = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    $commandLine = Get-ProcessCommandLine $ownerPid
    $isNodeService = $process -and ($process.ProcessName -eq "node" -or $commandLine -match "server\.js")

    if (-not $isNodeService) {
        Write-Host "Port $Port is owned by PID $ownerPid, but it does not look like this Node service. Skipped."
        return
    }

    Write-Host "Stopping local Codex Remote service (PID $ownerPid)..."
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped."
}

function Show-Status {
    Write-Section "Status"

    $listener = Get-LocalListener
    if ($listener) {
        $ownerPid = [int]$listener.OwningProcess
        $process = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
        $processName = "unknown"
        if ($process) {
            $processName = $process.ProcessName
        }
        Write-Host "Local service: running on $LocalUrl (PID $ownerPid, $processName)"
    } else {
        Write-Host "Local service: stopped"
    }

    $cloudflaredProcesses = @(Get-ProjectCloudflaredProcesses)
    if ($cloudflaredProcesses.Count -gt 0) {
        $ids = ($cloudflaredProcesses | ForEach-Object { $_.Id }) -join ", "
        Write-Host "Quick Tunnel:  running (PID $ids)"
    } else {
        Write-Host "Quick Tunnel:  stopped"
    }

    $url = Read-TunnelUrlFile
    if (-not $url) {
        $url = Get-TunnelUrlFromLogs
    }
    if ($url) {
        Write-Host "Public URL:    $url"
    } else {
        Write-Host "Public URL:    not found"
    }

    Write-Host "Token:         $(Get-TokenStatus)"
    Write-Host "Project:       $Root"
}

function Open-Remote {
    Write-Section "Open"
    $url = Read-TunnelUrlFile
    if (-not $url) {
        $url = $LocalUrl
    }

    Start-Process $url
    Write-Host "Opened: $url"
}

function Open-Folder {
    Start-Process explorer.exe $Root
}

function Wait-ForEnter {
    Write-Host ""
    Read-Host "Press Enter to continue" | Out-Null
}

function Invoke-MenuAction {
    param([scriptblock]$ScriptBlock)
    try {
        & $ScriptBlock
    } catch {
        Write-Host ""
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    }
    Wait-ForEnter
}

function Show-Menu {
    while ($true) {
        Write-Host ""
        Write-Host "=============================="
        Write-Host " Codex Remote Control"
        Write-Host "=============================="
        Write-Host "1. Start service + Quick Tunnel"
        Write-Host "2. Stop service + Quick Tunnel"
        Write-Host "3. Show status"
        Write-Host "4. Open public URL"
        Write-Host "5. Open project folder"
        Write-Host "0. Exit"
        Write-Host ""

        $choice = Read-Host "Choose a number"
        switch ($choice.Trim()) {
            "1" { Invoke-MenuAction { Start-All } }
            "2" { Invoke-MenuAction { Stop-All } }
            "3" { Invoke-MenuAction { Show-Status } }
            "4" { Invoke-MenuAction { Open-Remote } }
            "5" { Invoke-MenuAction { Open-Folder } }
            "0" { return }
            default {
                Write-Host "Invalid choice."
                Wait-ForEnter
            }
        }
    }
}

try {
    switch ($Action) {
        "menu" { Show-Menu }
        "start" { Start-All }
        "stop" { Stop-All }
        "status" { Show-Status }
        "open" { Open-Remote }
        "folder" { Open-Folder }
    }
} catch {
    Write-Host ""
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
