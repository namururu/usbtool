# Portable Codex CLI for Windows PowerShell

This folder is meant to be copied to the root of a USB drive and run from PowerShell.

It keeps the moving pieces inside the USB folder:

- `tools/node`: portable Node.js for Windows x64
- `tools/python`: optional portable Python embeddable runtime
- `tools/npm-global`: npm global packages, including `@openai/codex`
- `tools/npm-cache`: npm cache
- `data/codex-home`: Codex config, login/session data, history, and related state
- `workspaces`: default place to clone or copy projects for debugging

## First Setup

Open PowerShell in this folder:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\Install-UsbCodex.ps1
```

Optional Python runtime:

```powershell
.\Install-PythonRuntime.ps1
```

Then start Codex:

```powershell
.\Start-Codex.ps1
```

On the first run, sign in using the Codex/ChatGPT login flow shown by the CLI.

## Daily Use

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\Start-Codex.ps1
```

## CLI Status Line

The Codex TUI status bar can show context, 5-hour, and weekly limits. Setup enables this automatically, and you can reapply it any time:

```powershell
.\Set-CodexStatusLine.ps1
```

This writes `[tui] status_line` to `data\codex-home\config.toml`. It affects the interactive CLI/TUI opened by `.\Start-Codex.ps1`; the local GUI uses `codex exec`, so it does not receive the TUI status bar directly.

## Local GUI

The experimental portable GUI runs a localhost-only web cockpit that calls the USB Codex CLI.

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\Start-CodexGui.ps1
```

It opens `http://127.0.0.1:41731` by default.

Use the `ログイン` button on first run. It opens a PowerShell window for `codex login` while keeping `CODEX_HOME` on the USB drive.

For temporary sharing with another trusted machine on the same LAN, use:

```powershell
.\Start-CodexGui.ps1 -Lan
```

or double-click `start-lan.bat`. The launcher prints a Share URL such as `http://192.168.x.x:41731` and a short password. Anyone with that URL and password can operate the GUI and Codex session, so share it only on trusted networks and stop the GUI when finished.

The GUI sends the first prompt with the Japanese/autonomy base instructions. Follow-up prompts resume the same recorded Codex session for that workspace, so only your new message is sent.

This is not a full embedded TUI. It is a chat-like wrapper over `codex exec` and `codex exec resume`. Use `Start-Codex.ps1` when you need the native interactive terminal UI.

The GUI can select Codex permission modes:

- `workspace-write`: normal working mode
- `danger-full-access`: full filesystem/network access through the Codex sandbox option
- `bypass`: passes `--dangerously-bypass-approvals-and-sandbox`
- `read-only`: inspection-only mode

## Local Agent API

For automation from another local Codex session or a LAN client, use the JSON API instead of clicking the GUI:

```text
GET  /api/agent
POST /api/agent/run
GET  /api/agent/jobs/{id}
GET  /api/agent/jobs/{id}/events
POST /api/agent/jobs/{id}/stop
GET  /api/agent/files/artifacts
GET  /api/agent/files/images
GET  /api/agent/files/uploads
```

Start with `GET /api/agent`; it returns the endpoint list and example request bodies.

For a compact AI-facing guide, see `AGENT_API_KISWAHILI.md`.

To launch Codex inside a specific project:

```powershell
.\Start-Codex.ps1 -Workspace "D:\path\to\project"
```

To pass arguments through to Codex:

```powershell
.\Start-Codex.ps1 -CodexArgs @("--help")
.\Start-Codex.ps1 -CodexArgs @("exec", "explain this repo")
```

## Update Codex

```powershell
.\Update-Codex.ps1
```

## Self Update Channel

This folder is split into public app files and private local state.

Commit and publish:

- `gui/`
- `*.ps1`
- `*.bat`
- `README.md`
- `VERSION`
- `update.json`
- `.portable-update-include`
- `.gitignore`

Never commit:

- `data/`
- `tools/`
- `workspaces/`
- `dist/`
- `.tmp/`

Build a release zip:

```powershell
.\Build-UpdateZip.ps1 -WriteManifest
```

Publish `dist/portable-codex-usb.zip` and `dist/update.json` to a public GitHub release.

Configure USB clients by setting `manifestUrl` in `update.json`, or with:

```powershell
$env:PORTABLE_CODEX_UPDATE_MANIFEST = "https://github.com/YOUR_NAME/portable-codex-usb/releases/latest/download/update.json"
```

`start.bat` checks for updates before launching the GUI. The updater refuses to overwrite `data`, `tools`, `workspaces`, `dist`, and `.tmp`.

## Clean Local USB State

Remove GUI history, uploaded files, generated images, logs, and temporary files while keeping login/auth:

```powershell
.\Clean-UsbCodex.ps1
```

Preview first:

```powershell
.\Clean-UsbCodex.ps1 -WhatIf
```

Also remove Codex auth/session state:

```powershell
.\Clean-UsbCodex.ps1 -Auth
```

Also remove workspaces:

```powershell
.\Clean-UsbCodex.ps1 -Workspaces
```

Remove everything local except the app and runtime:

```powershell
.\Clean-UsbCodex.ps1 -All
```

## Build A Clean Carry Folder

For a clean USB copy, do not copy the development folder directly. Build a carry folder:

```powershell
.\Build-UsbCarry.ps1 -CleanOutput -IncludeRuntime
```

Output:

```text
usb\portable-codex-usb
```

Options:

- `-IncludeRuntime`: include minimal `node.exe`, native `codex.exe`, and `tools\python` when installed
- `-FullRuntime`: with `-IncludeRuntime`, include full Node/npm and npm-installed Codex CLI instead
- `-IncludeAuth`: include `data\codex-home` login/session state
- `-IncludeWorkspaces`: include `workspaces`

Default output excludes `.git`, `dist`, `.tmp`, GUI logs, upload cache, generated images, and local history.

## Security Notes

If you keep `data/codex-home` on the USB drive, the USB drive may contain login/session material after you sign in. Treat it like a password-bearing device.

For borrowed or shared PCs, prefer signing out when you are done. If the CLI version does not provide a logout command, move or delete `data/codex-home` after backing up any config you need.

## Troubleshooting

- If PowerShell blocks scripts, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` in that same terminal.
- If `codex` is not found, run `.\Install-UsbCodex.ps1`.
- If login behaves strangely across PCs, rename `data/codex-home` to force a fresh login.
- Some corporate networks block npm or Node downloads. In that case, run setup once on a network that allows `nodejs.org` and `npmjs.com`, then carry the prepared USB folder.
