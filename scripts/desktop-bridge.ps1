param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("screenshot", "focus", "paste", "send-enter", "click")]
    [string]$Action,

    [string]$TextFile = "",
    [string]$OutDir = "",
    [double]$X = -1,
    [double]$Y = -1
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class CodexRemoteNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
'@

$MouseLeftDown = 0x0002
$MouseLeftUp = 0x0004

function Write-Result($Value) {
    $Value | ConvertTo-Json -Compress -Depth 4
}

function Get-CodexWindow {
    $window = Get-Process Codex -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*Codex*" } |
        Sort-Object StartTime -Descending |
        Select-Object -First 1

    if (-not $window) {
        throw "Codex window not found."
    }
    return $window
}

function Focus-CodexWindow($Window) {
    $handle = [IntPtr]$Window.MainWindowHandle
    [CodexRemoteNative]::ShowWindow($handle, 9) | Out-Null
    Start-Sleep -Milliseconds 200
    [CodexRemoteNative]::SetForegroundWindow($handle) | Out-Null
    Start-Sleep -Milliseconds 400
}

function Focus-CodexInput($Window) {
    $bounds = Get-WindowBounds $Window
    $x = [int]($bounds.Left + ($bounds.Width * 0.52))
    $y = [int]($bounds.Top + ($bounds.Height * 0.91))
    Click-ScreenPoint $x $y
}

function Click-ScreenPoint($X, $Y) {
    [CodexRemoteNative]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 100
    [CodexRemoteNative]::mouse_event($MouseLeftDown, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [CodexRemoteNative]::mouse_event($MouseLeftUp, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 250
}

function Get-WindowBounds($Window) {
    $rect = New-Object CodexRemoteNative+RECT
    $ok = [CodexRemoteNative]::GetWindowRect([IntPtr]$Window.MainWindowHandle, [ref]$rect)
    if (-not $ok) {
        throw "Failed to read Codex window bounds."
    }

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) {
        throw "Codex window bounds are invalid."
    }

    return @{
        Left = $rect.Left
        Top = $rect.Top
        Width = $width
        Height = $height
    }
}

try {
    $window = Get-CodexWindow
    Focus-CodexWindow $window

    if ($Action -eq "focus") {
        Write-Result @{
            ok = $true
            action = $Action
            processId = $window.Id
            title = $window.MainWindowTitle
        }
        exit 0
    }

    if ($Action -eq "screenshot") {
        if (-not $OutDir) {
            throw "OutDir is required for screenshot."
        }
        New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

        $bounds = Get-WindowBounds $window
        $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
            $name = "codex-{0}.png" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff")
            $path = Join-Path $OutDir $name
            $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }

        Write-Result @{
            ok = $true
            action = $Action
            file = $name
            path = $path
            width = $bounds.Width
            height = $bounds.Height
            title = $window.MainWindowTitle
        }
        exit 0
    }

    if ($Action -eq "paste") {
        if (-not $TextFile -or -not (Test-Path $TextFile)) {
            throw "TextFile is required for paste."
        }
        $text = Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8
        if ($null -eq $text) {
            $text = ""
        }
        Focus-CodexInput $window
        [System.Windows.Forms.SendKeys]::SendWait("^a")
        Start-Sleep -Milliseconds 100
        [System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE}")
        Start-Sleep -Milliseconds 100
        [System.Windows.Forms.Clipboard]::SetText($text)
        [System.Windows.Forms.SendKeys]::SendWait("^v")

        Write-Result @{
            ok = $true
            action = $Action
            chars = $text.Length
            title = $window.MainWindowTitle
        }
        exit 0
    }

    if ($Action -eq "send-enter") {
        Focus-CodexInput $window
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

        Write-Result @{
            ok = $true
            action = $Action
            title = $window.MainWindowTitle
        }
        exit 0
    }

    if ($Action -eq "click") {
        if ($X -lt 0 -or $X -gt 1 -or $Y -lt 0 -or $Y -gt 1) {
            throw "Click coordinates must be between 0 and 1."
        }
        $bounds = Get-WindowBounds $window
        $screenX = [int]($bounds.Left + ($bounds.Width * $X))
        $screenY = [int]($bounds.Top + ($bounds.Height * $Y))
        Click-ScreenPoint $screenX $screenY

        Write-Result @{
            ok = $true
            action = $Action
            x = $X
            y = $Y
            screenX = $screenX
            screenY = $screenY
            title = $window.MainWindowTitle
        }
        exit 0
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
