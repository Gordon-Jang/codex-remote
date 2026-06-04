# Codex Remote

A small local web console for controlling and observing a Codex desktop session from a phone through a secure tunnel.

## Features

- Token-based login for mobile access.
- Read-only browsing of local Codex session files under `%USERPROFILE%\.codex`.
- Remote task panel with safe `mock` runner by default.
- Windows desktop bridge for the Codex window:
  - Capture Codex window screenshots.
  - Focus the Codex window.
  - Paste text into the Codex input box with UTF-8 support.
  - Send Enter as a separate action.
  - Click inside the Codex window by selecting a point on the screenshot.

## Safety Model

This project intentionally does not write to Codex App internal session storage. Desktop bridge actions are limited to the Codex window and require the configured bearer token. The default runner is `mock`, so remote tasks do not execute shell commands unless you deliberately configure a trusted wrapper.

Do not commit `.env`, screenshots, runtime files, tunnel logs, or generated tool binaries.

## One-Click Windows Control

On Windows, use the two double-click scripts:

- `CodexRemote-Control.bat` starts everything directly.
- `CodexRemote-Stop.bat` stops the local service and this project's Quick Tunnel.

The start script:

- Starts or reuses the local service.
- Starts or reuses Cloudflare Quick Tunnel.
- Checks whether the saved public URL is reachable.
- Restarts this project's Quick Tunnel if the old `trycloudflare.com` URL expired.
- Shows the local URL, public URL, and token status without printing the token value.

The scripts preserve an existing `.env` token. The start script generates a token only when `.env` is missing or `CODEX_REMOTE_TOKEN` is empty. To stop from a shell instead of double-clicking:

```powershell
.\manage-codex-remote.ps1 -Action stop
```

## Start Locally

```powershell
npm install
Copy-Item .env.example .env
node -e "console.log('CODEX_REMOTE_TOKEN=' + require('crypto').randomBytes(32).toString('base64url'))"
```

Paste the generated `CODEX_REMOTE_TOKEN=...` line into `.env`, then:

```powershell
npm start
```

Open `http://127.0.0.1:8765`.

## Cloudflare Quick Tunnel

For temporary account-free HTTPS access:

```powershell
.\start-cloudflare-quick-tunnel.ps1
```

The script prints a temporary `https://*.trycloudflare.com` URL and writes it to `runtime\quick-tunnel-url.txt`. Quick Tunnel URLs are not stable across tunnel restarts. For long-term use, create a named Cloudflare Tunnel or use another trusted private networking option.

## Interactive Terminal

The Run tab includes an authenticated terminal bridge. On Windows it defaults to:

```text
cmd.exe /Q /K "chcp 65001>nul"
```

Start the terminal from the web UI, then send commands to the local process. This can launch local CLI agents such as `claude`, `codex`, `gemini`, or a trusted wrapper script if those commands are already installed and available in `PATH`.

You can override the terminal process in `.env`:

```text
CODEX_REMOTE_TERMINAL_COMMAND=cmd.exe
CODEX_REMOTE_TERMINAL_ARGS=/Q /K "chcp 65001>nul"
```

Do not expose this through a public tunnel unless the token is strong and private. The terminal bridge can control the local machine as the current Windows user.

## Runners

`CODEX_REMOTE_RUNNER=mock` is the safe default.

`powershell-echo` is only for smoke testing.

`command` runs `CODEX_REMOTE_COMMAND` with the prompt path in `CODEX_REMOTE_PROMPT_FILE`. Use this only with a trusted local Codex CLI or agent wrapper.

## Desktop Bridge Notes

The desktop bridge is Windows-specific. It uses PowerShell, Win32 APIs, and `System.Windows.Forms` to interact with the visible Codex desktop window. Screenshot clicks are translated from relative screenshot coordinates to positions inside the current Codex window bounds.
