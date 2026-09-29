# Qianshou Agent 0.2.1 Preview

This download is the Apple Silicon controller for macOS 13.5 or later. Optional MLX neural voice requires macOS 15 or later. It contains Electron, Node.js, pnpm, the complete Harness runtime and the Qianshou interface. It does not require a source checkout or a separate Node installation. The engine keeps its upstream version, 0.1.5-rc.2; the Qianshou product version is 0.2.1.

1. Extract the ZIP, move 千手智能体.app to Applications, and open it. This preview is ad-hoc signed and has not been notarized by Apple. If macOS blocks it, confirm that it came from the official download page, then use System Settings → Privacy & Security → Open Anyway. Do not disable Gatekeeper globally.
2. Configure your own model provider and API key in the application. No account or key is included. Existing local Qianshou data is reused from `~/.local/share/qianshou-agent/home`; a fresh user starts with an empty profile. The application opens its own loopback service on port 3081 and will report a conflict rather than stop another program.
3. Send a text task first. System speech output can use the installed macOS voices. Microphone transcription and Serena neural speech require optional local resources: open the application's package contents, then follow `Contents/Resources/app/voice/README.md`. Installing resources is a separate download; this preview does not silently download model weights.
4. For another computer, download the separate Qianshou Companion for that computer's OS. Use Devices in the controller to create a pairing invitation; the other user enters it, reviews the controller identity and authorizes local workspaces. Keep both applications open. Remote desktop additionally requires RustDesk on both devices. Pairing does not grant permission to all files or install RustDesk automatically.

The controller binds only to 127.0.0.1. For LAN or public-network coordination, expose the coordinator through an authenticated HTTPS/WSS deployment or trusted VPN and use its reachable address in the invitation; `127.0.0.1` on another computer points to that computer itself. Do not expose an unauthenticated port to the Internet.

A separate Windows x64 controller archive is available from the official download page; this release does not provide a Linux controller. The Windows controller has not been launched on a Windows target system. Windows/Linux companion archives have structural and checksum verification, but have not been launched on those target systems. The sample VRM character verifies interactive animation; it is not final commissioned character artwork. Neural voice latency depends on local hardware and does not include model reasoning latency.

The root DeepSeek MIT license and dependency licenses remain inside the application. Runtime versions and the package inventory are in `Contents/Resources/runtime/versions.json` and `Contents/Resources/RUNTIME_PACKAGES.json`. Removing the application does not delete the user's local data. Keep a backup before changing versions; do not run two controllers against the same home concurrently.

Each user must configure their own model provider and API credentials. The public application includes no shared LLM key or model quota. The CEO, employees and automatic model routing all use that user’s configured provider; missing credentials do not fall back to an operator-funded account.

## In-app updates

Open Help → Check for updates. After startup, the app checks in the background and downloads authenticated releases. Downloads do not interrupt existing tasks; restarting is unavailable while the CEO, employees, background processes or device tasks have work pending. When the window shows Ready to update, choose Restart and update. Conversations, projects, provider configuration and your own API keys remain in place.

Version 0.2.1 is the first release with this update entry. Install it normally from the official site once when upgrading an older app. Later releases do not require a manual download every time. Network failures, cancellation and failed verification leave the current version running. Once a new release begins accessing user data, it never automatically falls back to an older release.
