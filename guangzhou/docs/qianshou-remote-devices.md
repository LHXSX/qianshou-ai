# Qianshou Agent cross-device collaboration design

English | [中文](qianshou-remote-devices.zh.md)

This document records the implementation boundary and remote deployment path as of 2026-09-13. The user wants a macOS controller to coordinate Windows, macOS, and Linux devices for both development tasks and interactive desktop control. The delivered source includes the controller coordinator and standalone Qianshou Companion; external devices, network entry, and desktop permissions still require target-machine acceptance.

## Two separate channels

Development tasks use a TLS WebSocket initiated by the companion: Qianshou browser → authenticated Connection API → device coordinator → selected companion's local approval → execution and receipt. Browser authentication remains the existing Harness session mechanism; devices receive separate pairing codes and persistent credentials rather than browser cookies. Both applications launch independently. Cleartext WS is permitted only for same-machine loopback validation; remote endpoints require WSS.

Desktop access uses already installed RustDesk: local approval of a `desktop` task → launch RustDesk and return its public ID → launch RustDesk on the controller with that ID → RustDesk handles target confirmation, screen, and input transport. This stage neither embeds RustDesk source nor sets or transmits passwords. In self-hosted RustDesk, hbbs handles ID/rendezvous and hbbr provides relay; Pro administration features must not be described as OSS built-ins. See the official [self-hosting guide](https://rustdesk.com/docs/en/self-host/), [client guide](https://rustdesk.com/docs/en/client/), and [license](https://github.com/rustdesk/rustdesk/blob/master/LICENCE).

## Implemented minimal duplex protocol

[remote-devices](../packages/host/remote-devices/README.md) documents the HTTP interface and frame types. The existing controller port registers `/qianshou-device`, rejects browser Origin headers, and requires first-frame authentication within five seconds. Pairing codes expire after five minutes and are single-use. Persistent credentials are random; the controller stores only SHA-256 digests. Electron safeStorage encrypts companion credentials, rejecting Linux's `basic_text` backend. Revocation prevents both existing connections and credential replay from continuing.

Directory listing, reading, writing, commands, and desktop requests all require individual companion approval. Only the local file picker adds authorized workspaces, and remote IDs must match them. File operations reject traversal, absolute paths, and symlinks. Commands have an initial working directory but retain local-user privileges, so the UI displays the entire command and explicitly does not claim shell sandboxing. Cancellation and disconnect terminate the owned process group, and commands expire after five minutes.

Stable task IDs, complete output snapshots, acknowledgments, and immutable terminal states govern result delivery. Reconnection resends unfinished tasks, while companion ID deduplication prevents automatic re-execution; restarting a companion marks unfinished work interrupted. Connection-local sequences prevent older output from replacing newer snapshots, and replaced connections cannot report results. Atomic controller state stores private credential digests and task receipts without exposing secrets in device lists.

## Why the existing SDK is not the remote device client

The repository's [SDK Client](../packages/sdk/client/README.md) manages Harness sessions through stdio JSON-RPC to a local subprocess. Initialization, session prompts, and shutdown are not network device registration, pairing, or lease protocols. Session Controller supports session cancellation, while SDK process shutdown is not arbitrary per-task cancellation for shared sessions. Existing browser Gateway reconnect behavior also does not establish durable cross-machine task deduplication.

A later stage can start a local Harness runtime on each companion and submit planning tasks to genuine remote sessions with filesystem and shell capabilities bound to that same machine. Session ownership, cancellation, durable receipts, and model configuration must be wired together; a remote shell must not silently share a nominal workspace with controller-local file tools. The current five finite task kinds are implemented. Automatic assignment of director subagents to remote Harness sessions remains subsequent integration.

## Platform and network choices

Start with one target behind a private overlay or authenticated HTTPS reverse proxy. Tailscale provides private device connectivity and default-deny policy, but Tailscale SSH server support is Linux and specific macOS CLI configurations, not Windows. Windows development work may use official OpenSSH Server or this companion's outbound channel. See [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh), [access policy](https://tailscale.com/docs/reference/syntax/policy-file), and [Microsoft OpenSSH installation](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse).

Public deployment requires an explicit controller domain, valid TLS certificate, device pairing procedure, reverse-proxy access control, and audit retention policy. This implementation does not automatically bind publicly or configure forwarding. Device mTLS certificates, signed remote updates, unattended policy, and shell sandboxing are future enhancements. The implemented device credential is random and protected by TLS; it must not be described as implemented mTLS.

macOS desktop control requires system screen recording and accessibility permission. Linux Wayland and login-screen limitations require validation against the actual target session. Windows login state, UAC, and background session behavior also require testing. See the official [RustDesk macOS](https://rustdesk.com/docs/en/client/mac/) and [Linux](https://rustdesk.com/docs/en/client/linux/) guides. The application does not bypass system permission boundaries.

If an embedded browser desktop becomes required, Apache Guacamole is an option: browser, web service, and guacd translate to RDP/VNC/SSH, but this does not automatically replace a reverse device client behind NAT. Its Apache-2.0 license differs from RustDesk's AGPL-3.0. See [Guacamole architecture](https://guacamole.apache.org/doc/gug/guacamole-architecture.html) and [official license](https://github.com/apache/guacamole-server/blob/main/LICENSE). A custom WebRTC screen protocol is deferred because capture, input authorization, codecs, signaling, and TURN are required beyond a video channel; see [WebRTC TURN](https://webrtc.org/getting-started/turn-server).

## Validation phases

Phase one is the current local delivery: two real WebSocket endpoints exercise pairing, no execution before approval, bounded file access, command output and cancellation, browser-Origin rejection, one-time pairing, revocation, and reconnect deduplication, alongside startup checks for both Electron applications. These tests prove local code paths, not public connectivity or installation on another operating system.

Phase two validates each selected target: the user supplies target and network entry, installs the companion, chooses a workspace, pairs over TLS, runs a test with verifiable output, and checks cancel/reconnect behavior. Then use existing or installed RustDesk with target-user permission and test screen, keyboard, mouse, and disconnect. Record application version, target OS, connection method, and results without storing passwords or private keys.

Phase three extends actual remote Harness sessions, real subagent dispatch, capability groups, and configurable approval before considering mTLS, OS sandboxing, signing/upgrades, or embedded Guacamole. Missing target addresses and operating-system permissions are external acceptance dependencies, not work the code has automatically completed.
