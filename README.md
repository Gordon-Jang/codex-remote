# Codex Remote

A small local web console for controlling and observing a Codex desktop session from a phone through a secure tunnel.

## Project status

This project still works for its original use case, but it is **not the approach I would recommend for a new Codex remote-control setup**.

The basic design is a compatibility bridge around the visible Codex Desktop window: take screenshots, focus the window, paste text, send keys, and translate browser clicks back into Win32 coordinates. That was useful when there was no clean browser/mobile control path. Today there are better ways to solve most of the same problem.

### Main drawbacks

- It controls Codex through the GUI instead of through a stable protocol. Window layout, focus behavior, DPI scaling, dialogs, app changes, or a renamed window can break automation.
- Screenshot-based interaction is slower and less reliable than a real web/CLI/API interface.
- The Windows desktop bridge is Windows-specific and requires an active interactive desktop session.
- Cloudflare Quick Tunnel is convenient, but the public URL is temporary and exposing an authenticated terminal or desktop-control bridge to the public internet increases the consequences of a leaked token.
- Reading Codex session files is useful for observation, but those files are implementation details rather than a remote-control API and can change between Codex versions.
- The interactive terminal makes the project much more powerful, but it also means the web console can effectively act with the permissions of the local Windows user.
- This repo solves remote access specifically for Codex Desktop, while SSH, Tailscale, RDP, browser-native agent UIs, and remote agent hosts solve the more general problem and are usually better maintained.

### Better approaches now

For most users, one of these is a better starting point:

- Use a browser-native Codex/agent UI instead of remotely clicking the desktop window. Projects such as [codex-web-ui](https://github.com/friuns2/codex-web-ui) are closer to the actual problem.
- Use a broader agent harness such as [Omnigent](https://github.com/omnigent-ai/omnigent) when you want browser/mobile access, remote sessions, multiple coding agents, sandboxes, and orchestration in one system.
- Run Codex CLI on the machine where the code lives and access that machine through SSH or Tailscale. This removes the screenshot/mouse/keyboard layer entirely.
- If what you really need is full remote desktop control, use a mature remote-desktop product instead of building a Codex-specific one.

In short: if your goal is simply "use Codex from my phone", this repository is now a fairly indirect way to do it.

### What is different about this implementation?

This project still has a few deliberate differences from the larger alternatives:

- It controls the **existing visible Codex Desktop session** instead of creating a separate browser-native agent session.
- It intentionally does **not write to Codex App internal session storage**.
- The desktop bridge is small and easy to inspect compared with a full remote-agent platform.
- It can behave like a minimal pair of remote hands: see the Codex window, paste text, press Enter, or click a point.
- The default runner is deliberately harmless `mock`; shell execution has to be enabled intentionally.
- It does not try to become a general multi-agent platform, cloud IDE, or remote desktop product.

### If you still choose to use it

The main reason to keep using this project is not that it is technically superior. It is that you may specifically want to remote-control the exact Codex Desktop session already running on your Windows machine without patching Codex or moving your workflow into another platform.

For a personal machine, a known network path, a strong token, and a user who understands the limitations, this can still be a small and understandable solution. You get less abstraction and less infrastructure, at the cost of more brittleness.

If you do not need that exact behavior, use one of the approaches above instead.

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
