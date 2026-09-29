---
description: "Enable an optional authenticated relay for companion computers on other networks."
---

# Connect through a collaboration relay

English | [中文](README.zh.md)

## Summary

The relay lets a companion reach your running desktop controller through a dedicated HTTPS address. It carries the existing device connection; pairing codes, approved workspaces and local task approval still apply. The relay is off each time the app starts. A direct coordinator address remains available.

## Table of Contents

- [Enable and share](#enable-and-share)
- [Stop or recover](#stop-or-recover)
- [Security and verification](#security-and-verification)
- [Dev Note](#dev-note)

<a id="enable-and-share"></a>
## Enable and share

Use the relay-capable 0.2.1 or newer desktop controller and obtain your dedicated registration JSON from the relay administrator. A browser or an older desktop shell cannot start this connection. The public installer does not include a registration token.

1. Open **Devices → Public collaboration relay → Import registration**. Select the original JSON in the native file dialog. The app validates it and stores an encrypted copy through the operating system credential service.
2. Select **Enable relay**. Wait for **Relay connected**, which means FRPC reports the expected device route as running. **Connecting** alone does not prove registration or remote reachability.
3. Select **Copy relay address**, or select **Use the connected relay address** in the setup instructions below. Generate a fresh one-time pairing code and copy the full recipient instructions. Send the address, pairing code and public companion download instructions to the recipient; keep the registration JSON private.
4. The recipient installs Companion, enters the address and pairing code, and selects an allowed workspace. Verify that the device becomes online, send a directory-list task, and have the recipient approve and inspect the result.

The controller must remain open and connected to the Internet. Each device task still requires recipient approval. Remote desktop additionally uses RustDesk and its separate local permissions; this relay does not carry a general desktop or arbitrary TCP tunnel.

<a id="stop-or-recover"></a>
## Stop or recover

**Disable relay** closes this relay connection and disconnects its remote peers; it does not stop unrelated local agent tasks or the controller backend. In-flight companion tasks can be interrupted by the lost device connection. Closing the app stops its owned FRPC process and removes its temporary plaintext configuration. Each new app launch requires another explicit enable action.

If connection stays pending, check Internet access and the administrator-issued registration, then disable and enable again. A missing or mismatched runtime requires the complete current installer. Unavailable OS credential encryption prevents import; the app does not fall back to plaintext. If a saved registration cannot be decrypted, import the original JSON again. Disable the relay before replacing a registration. A shutdown error means cleanup could not be confirmed and is shown explicitly.

Direct invitations remain independent. An entered HTTPS address is syntax-checked but not asserted reachable until a companion actually connects. A generated pairing code remains valid for five minutes and one use.

<a id="security-and-verification"></a>
## Security and verification

The desktop renderer sees only the public endpoint, enabled/configured flags, connection phase and finite error codes. A trusted main-frame IPC call opens the native import dialog; the renderer cannot select a file path, executable or forwarding target. Encrypted registration lives under the desktop user-data `relay` directory. FRPC reads a private transient configuration only during an enabled connection. No registration token is bundled, copied into invitations, or written to logs.

The pinned FRPC executable and ISRG roots are SHA-256 checked against the target resource manifest before execution. TLS peer verification is mandatory. The local gateway binds only to loopback and forwards only an exact native `GET` WebSocket upgrade for `/qianshou-device` to the backend owned by this app. It rejects browser Origin headers, other paths and ordinary HTTP. The authenticated FRPC status interface binds only to a separate loopback port and is never exposed through the relay.

Contributor checks are `node --test apps/qianshou-desktop/relay/tests/relay.test.mjs` and the existing desktop entry tests. The opt-in `tests/public.test.mjs` runs with `node --import tsx/esm --test`, an administrator-provided `QIANSHOU_RELAY_ENROLLMENT` path and an optional `QIANSHOU_RELAY_RECEIPT` output path. It creates an isolated coordinator and companion, exercises actual public TLS, local approval and file result, and checks disable/shutdown cleanup. Its AES fixture establishes encrypted persistence behavior; it does not establish Electron OS-vault or Windows device acceptance. See the [relay decision](../../../.agents/notes/implemented/feature/2026-09-14-qianshou-dedicated-relay.md).

<a id="dev-note"></a>
## Dev Note

None.
