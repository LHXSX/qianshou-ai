---
description: "Start the unsigned Windows x64 Qianshou controller preview and understand its voice, workspace and companion requirements."
---

# Qianshou Agent — Windows quick start

English | [中文](QUICK_START.windows.zh.md)

This guide is for the Windows x64 controller, product version 0.2.1 preview. The ZIP contains Electron, Node, pnpm and the workbench runtime; you do not need a separate Node installation or source checkout. The controller is the computer where you talk to the CEO and manage tasks. Install the separate companion on a computer that receives remote work.

## Before starting

The target is Windows 10 or Windows 11 on an x64 processor. [Electron 44.0.0's platform requirements](https://github.com/electron/electron/blob/v44.0.0/README.md#platform-support) specify Windows 10 or later; this package does not provide Windows ARM64 or 32-bit binaries. This is an unsigned portable preview. Windows device launch, microphone, speakers and remote-control acceptance have not been completed; the download entry is marked unverified for this platform.

You need your own supported model API credentials for cloud conversations. Project-specific tools such as Git, OpenSSH, GitHub CLI and language SDKs are separate installations when your tasks require them. The application does not supply accounts, API credit or credentials.

## Open the controller

1. Download `qianshou-agent-0.2.1-win32-x64.zip` from the controller section of the [official downloads page](https://qianshousuanli.com/#/downloads#qianshou-agent). Compare its SHA-256 with the page before running it. Do not select the Windows companion when you need the main workbench.
2. Use Extract All and keep the entire extracted `qianshou-agent-0.2.1-win32-x64` folder together in a writable local directory. Choose a short location such as `C:\Qianshou`; deeply nested folders can exceed Windows path limits. Open `QianshouAgent.exe` inside it. Running the executable inside the ZIP or copying only the EXE omits required runtime files. You may create a shortcut to the extracted EXE.
3. Windows may warn about the unsigned publisher. Verify the official source and checksum first. If device policy blocks unsigned applications, use your administrator's approved process; the app does not require disabling Windows security.
4. In Settings, configure your provider and model, select a workspace, and send a text task. Confirm that your message, execution record and final reply appear in the main conversation. A successful window launch alone does not verify the API credentials or a tool's access to your project.

The controller uses `127.0.0.1:3081`. If the port is occupied, the app reports an error and leaves the existing service alone. Finish work and close the other controller, or configure a different permitted local port; port 3080 is reserved. No public network bind is enabled by launching the EXE.

## Work, voice and other computers

Windows command tasks use the existing PowerShell provider: an explicit configured executable takes priority, followed by detected PowerShell 7 and Windows PowerShell 5.1 as a fallback. WSL and Git Bash are not required for that provider. Tell the agent when a project specifically needs CMD, Bash or a separate SDK; installing the workbench does not install those tools. PowerShell 5.1 may mishandle non-ASCII input to native commands, so validate such tasks with the selected shell.

Start with text chat. System read-aloud depends on voices installed in Windows and available through the speech API. This ZIP has no ready-to-use Windows speech-recognition resources and no MLX installer: continuous microphone conversation and dictation need a separately configured compatible recognizer. See the [Windows voice guide](voice/README.windows.md); opening the microphone or seeing the animated character does not prove recognition or speech playback works. The bundled 3D character is a functional sample, not a completed custom appearance.

For remote work, open Devices in the controller and create a pairing code. Send the companion download and pairing instructions to the other computer's owner. They install the matching companion, enter the controller's reachable address and code, and authorize the workspace and requested access. Screen, mouse and keyboard control additionally requires a separately installed and configured RustDesk on the participating computers and the remote owner's permission. Pairing alone does not grant desktop access.

The local address `127.0.0.1` points to the computer using it; it is not an address to send to another device. LAN or public-network collaboration needs a reachable authenticated HTTPS/WSS address, such as a correctly configured HTTPS gateway over your network or VPN. Keep the pairing code private and check its expiry. A copied invitation does not prove the remote computer can connect.

## Data, updates and troubleshooting

The default data directory is `%USERPROFILE%\.local\share\qianshou-agent\home`. Existing data stays in this directory when you replace or move the extracted application. Local desktop configuration is `%USERPROFILE%\.local\share\qianshou-agent\desktop\config.json`; the `QIANSHOU_HOME` override or configured `home` selects a different data directory. The packaged app always uses its bundled runtime, even when older source or Node overrides exist.

To update, finish active tasks, quit the controller, extract the new ZIP into a separate folder and launch that folder's EXE. Keep a private backup of the data directory before changing versions, and do not run two controllers against the same home. Deleting an extracted application folder does not delete the data directory. Quitting terminates only the backend tree started by that controller; an unconfirmed Windows shutdown produces an error instead of reporting success.

If launch fails, keep the error message and the log path shown by the app. Logs are under `home\desktop-logs`; review them for project details before sharing, even though authentication URL tokens are redacted. A missing-runtime error usually requires extracting the complete ZIP again. The Help menu opens the bundled usage and voice guides. Bundled licenses and runtime inventory are under `resources`, including `runtime\versions.json` and `RUNTIME_PACKAGES.json`.

Each user must configure their own model provider and API credentials. This public application includes no shared LLM key or model quota; the CEO, employees and automatic routing use the user’s configured provider. Missing credentials do not fall back to an operator-funded account.

## In-app updates

Open Help → Check for updates. After startup, the app checks in the background and downloads authenticated releases. Downloads do not interrupt existing tasks; restarting is unavailable while the CEO, employees, background processes or device tasks have work pending. When the window shows Ready to update, choose Restart and update. Conversations, projects, provider configuration and your own API keys remain in place.

Version 0.2.1 is the first release with this update entry. Install it normally from the official site once when upgrading an older app. Later releases do not require a manual download every time. Network failures, cancellation and failed verification leave the current version running. Once a new release begins accessing user data, it never automatically falls back to an older release.
