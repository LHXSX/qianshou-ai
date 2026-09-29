# Qianshou Companion

English | [中文](README.zh.md)

Qianshou Companion is the standalone controlled-device application for Qianshou Agent. It connects outbound to a coordinator, advertises locally selected workspaces, and executes received tasks only after a local user approves them. Browser identity and device identity use separate authentication, and the companion opens no listening port.

## Start and pair

Install workspace dependencies at the repository root and build the coordinator package, then run `pnpm build` and `pnpm start` in this directory. On macOS with Python 3 available, `pnpm package:mac` creates `dist/千手协作端.app` using Electron from `apps/desktop/node_modules/electron`; this is an ad-hoc signed local application, not an Apple-notarized release. Windows and Linux share the Electron source; portable packages can be assembled without running their binaries, while target-system startup and operation still require separate validation.

The macOS packager writes the product version from this directory's `package.json` into the application metadata, including `CFBundleShortVersionString` and `CFBundleVersion`. Product versions use three numeric components and are independent of the bundled Electron runtime version.

All release packagers emit `name: qianshou-companion` and `distribution: bundled` in the shipped application metadata. The updater requires these markers and a valid product version; it stays disabled for source launches or unreadable metadata. This explicit boundary also supports the macOS `Electron` executable name, which Electron's `app.isPackaged` filename heuristic treats as development.

## Portable Windows and Linux packages

After `pnpm build`, run `python3 scripts/package-portable.py win32 linux` using Python 3 and curl. The script downloads Electron 44.0.0 x64 directly from the official GitHub release, compares both release API SHA-256 digests and `SHASUMS256.txt`, checks the reachable application import graph, and produces a Windows ZIP and Linux tar.gz under `dist/portable`. It retains at least 4 GiB of free disk space and refuses to overwrite an existing final archive. Reuse verified runtime downloads through the adjacent `runtime-cache` directory, or pass `--output` to choose another build directory.

Each archive includes bilingual startup instructions, original runtime licenses, `BUILD_MANIFEST.json`, and a per-file checksum index. Adjacent release manifests record the outer archive SHA-256. Windows users extract the complete directory and launch `QianshouCompanion.exe`; Linux users extract it and launch `./start-qianshou.sh` in a graphical desktop session. The packages are explicitly marked **packaged, not launch-validated on the target operating system**, and provide no signed installer; updates are available through the Help menu. Linux requires compatible Electron desktop libraries, a usable Chromium sandbox, and secure secret storage; the launcher never disables the sandbox. The Windows executable retains the runtime's file icon and includes the product icon separately as `qianshou.png`.

All platform packagers use `scripts/bundle_files.py` to copy only the reachable JavaScript graph and required static assets. Packaging fails when a runtime import still depends on the repository or a missing chunk; stale build files are excluded. The standalone `peer` and `executor` modules can be imported from a temporary directory without workspace dependencies to verify bundle isolation.

Select the directories permitted for file tasks in the companion. Generate a five-minute single-use pairing code in the controller's device page, enter the coordinator address, device name, and code in the companion, then connect. Subsequent connections use a device credential encrypted by operating-system secure storage; the controller retains only its SHA-256 digest. The companion does not automatically connect at startup. Disconnect and local pairing removal are always available; removing local state does not revoke an old controller-side identity, which should also be revoked from the controller device page.

`http://127.0.0.1:3081` is for testing both applications on the same machine. Different machines require a reachable HTTPS endpoint with a valid certificate, converted to WSS by the companion. The application never disables TLS verification, opens router ports, or installs a VPN. The coordinator retains its local bind by default; actual remote access requires a separately configured, authenticated network entry.

For the Guangzhou relay, the controller owner imports the private relay configuration and enables the relay in Devices. The recipient only receives the public HTTPS address and a fresh pairing code; they do not receive the relay registration credential. Pairing and local task approval remain required. This relay carries device tasks and receipts; RustDesk desktop streaming remains a separate connection.

The Mac packager accepts `QIANSHOU_COMPANION_MAC_OUTPUT` for an isolated release application path, rejects empty or whitespace-only values, and refuses to overwrite that explicit output.

## Packaged loopback acceptance

After the standard web CLI and the companion have been built and the Mac companion installed, run `node scripts/verify-packaged-loopback.mjs` from this directory. The script copies the installed companion modules into an isolated temporary directory, launches `apps/cli/lib/bin.js --profile web --host 127.0.0.1 --port 0 --no-open` with a fresh `DSH_HOME`, and exchanges its launch URL for an authenticated browser cookie without printing either credential. It exercises authenticated HTTP pairing, the real device WebSocket route, command and file-read receipts after explicit test-harness approval, cancellation before execution, and device revocation. The script removes its temporary home, workspace, credentials, listener, and child process, and writes `dist/PACKAGED_LOOPBACK_RECEIPT.json`. It invokes no model and imports no user API credentials. This validates one-machine packaged runtime behavior; it does not validate GUI approval, another operating system, cross-machine networking, or a RustDesk desktop session.

## Operations and permissions

The `list`, `read`, and `write` tasks accept relative paths within an approved directory and reject traversal and symbolic links. File reads and writes are limited to 512,000 bytes and listings to 1,000 entries. Writes replace files through temporary files and do not create directories automatically. Other local processes with filesystem access may still modify those directories; workspace validation is not operating-system isolation.

The `command` task displays the full command for individual local approval. The workspace is only its initial working directory: commands run with the signed-in local user's permissions and can access other locations that user can access. This version does not claim shell sandboxing. One task executes at a time, commands have a five-minute timeout, and the last 100,000 output characters are retained. Cancellation, disconnection, and exit terminate the owned command/process group. A cancellation request is distinct from a confirmed terminal receipt.

After local approval, a `desktop` task opens an already installed RustDesk and attempts to return its public connection ID. The controller opens its own RustDesk using that ID. RustDesk handles desktop streaming, input, and remote access confirmation; the companion neither sets passwords nor bypasses confirmation or system screen permissions. On macOS, both `/Applications` and the current user’s `~/Applications` are searched. Missing RustDesk causes an explicit task failure. macOS requires user-granted screen recording and accessibility permissions; Linux Wayland and login-screen support follows RustDesk's official limitations.

## Connection and results

Stable task IDs suppress duplicates, complete output snapshots are transported, and receipts leave the outbox only after acknowledgment. Disconnection never automatically re-executes commands. After a companion process restart, unfinished tasks become `interrupted`; reconnecting synchronizes status. Device revocation invalidates the old credential immediately. Authentication failures and connection replacement stop retries so an old instance cannot fight a newer connection.

See [remote-devices](../../packages/host/remote-devices/README.md) for the protocol and [remote collaboration design](../../docs/qianshou-remote-devices.md) for implementation choices and external validation. Local automated tests exercise two real WebSocket endpoints and the executor; they do not establish installation, connectivity, or desktop-control acceptance on another Windows/Linux device.

## Download delivery from the controller

After packaging, run `python3 scripts/prepare-downloads.py --output "$DSH_HOME/qianshou/companion-downloads"` with an explicit runtime home. This stages existing verified Windows/Linux archives and a ZIP of the signed local Mac app, then publishes `manifest.json`. It retains at least 4 GiB free space and refuses to overwrite a different existing archive. Restart or rebuild the coordinator after first installing its download-route code; later archive updates are read from the manifest without restarting.

The controller's **Devices → Companion downloads and setup** section offers authenticated downloads, checksums and platform instructions. The owner downloads the archive and sends the complete file to the other computer. The recipient does not need the owner's browser session, API key, source checkout, Node.js or Python. macOS users extract the ZIP and move the app to Applications; the ad-hoc build is not Apple-notarized, so the recipient must establish trust through the system's own opening flow. Windows users run the fully extracted `QianshouCompanion.exe`; Linux users use the extracted graphical-session launcher and must satisfy its desktop/sandbox/key-store dependencies.

Pairing instructions require a fresh code and a non-loopback HTTPS origin. The page says that connectivity remains unverified until the other computer actually connects; it never turns `127.0.0.1`, a browser authentication token, or a private download link into a recipient address. The application opens no public entry or router port. After pairing, verify a directory-list task and its local approval/result before using commands or desktop control. RustDesk and operating-system permissions remain separate prerequisites.


## Preview release verification

Version 0.2.1 archives declare the preview channel and preserve DeepSeek MIT, ws MIT and Electron/Chromium notices. Mac signing is ad-hoc and is not Apple notarization. Run `node scripts/verify-packaged-loopback.mjs <companion-app-resources> <controller-cli> <bundled-node>` to use the final controller runtime instead of the default source CLI. This isolated test starts a fresh ephemeral HTTP service, imports packaged companion modules outside the repository, and checks pairing, local approval, execution, receipts, cancellation, revocation and owned cleanup. It does not open either GUI, use a model key, or establish cross-machine/network acceptance.

## In-app updates

Help → Check for updates opens the same update window as the controller. Releases download and authenticate in the background. Choose Restart and update once local approvals, task execution and record writes are idle. Preparation temporarily refuses new work; cancellation or expiry releases that hold. Updates use a separate directory, preserve device authorizations and receive no controller or operator LLM keys. Version 0.2.1 is the first release with in-app updates; older releases require one normal installation. See the [shared updater](../qianshou-updater/README.md) for verification and process-switching behavior.
