# Codex Desktop Bridge Design

## Goal

Add a narrow Windows desktop bridge to Codex Remote so the phone console can interact with the local Codex desktop window without exposing arbitrary shell, mouse, or keyboard control.

## Scope

The first version supports four Codex-only actions:

- Capture a screenshot of the Codex window.
- Focus the Codex window.
- Paste text into the currently focused Codex input.
- Send Enter as a separate action.

Paste and send stay separate. Sending Enter is never bundled into paste.

## Server Design

The Express server adds authenticated `/api/desktop/codex/*` endpoints. Each endpoint calls a local PowerShell bridge script with a fixed action name. Free-form shell commands, arbitrary process names, coordinates, and arbitrary key sequences are not accepted.

The bridge script finds a visible `Codex` process window, restores and focuses it, then performs the requested action through Win32 APIs and `System.Windows.Forms`.

Screenshots are written under `runtime/screenshots/` and served back only through authenticated `/api` routes.

## Client Design

The web UI adds a `桌面桥` tab with:

- Screenshot refresh.
- Focus Codex.
- Paste text to Codex.
- Send Enter.

The send button prompts for confirmation before calling the API.

## Safety Rules

- Existing `CODEX_REMOTE_TOKEN` authentication applies to every desktop bridge endpoint.
- Enter is a separate endpoint and UI action.
- No arbitrary keyboard input beyond paste text and Enter.
- No mouse control.
- No non-Codex window control.
- Paste text is capped by the server.

## Verification

Verify with:

- `node --check server.js`
- PowerShell parser check for `scripts/desktop-bridge.ps1`
- API smoke tests for auth failure and action shape
- Browser check that the new tab loads and controls are present
