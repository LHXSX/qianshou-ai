---
description: "Package map for the web GUI host half: the HTTP and SPA servers, workspace-directory picking implementations, the open-in-app launch routes, and the plugin inventory projection."
kind: "package-group"
---

# host/ — web-GUI host half

English | [中文](README.zh.md)

## Summary

The `host/` group serves the web GUI, opens local applications and directory pickers, exposes plugin inventory, coordinates paired remote devices, and transcribes short recordings locally. Browser transport lives in [`client/`](../client/README.md); the composed [`apps/cli`](../../apps/cli/README.md) loads Host capabilities alongside the Web client. Package READMEs define each capability's configuration and limits. Picker backends replace one another behind one shared interface.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package README owns its Host contract and configuration.

| Package | Role | ctx key |
|---|---|---|
| [`webserver/`](webserver/README.md) | Browser HTTP server: named routes, upgrades, index taps, and the fallback seat | `ctx.webServer` |
| [`frontend-static/`](frontend-static/README.md) | SPA dist server on the webserver fallback seat | consumes `ctx.webServer` |
| [`directory-picker/`](directory-picker/README.md) | Workspace-directory picking seam: capability contract and error vocabulary | `ctx.directoryPicker` |
| [`directory-picker-native/`](directory-picker-native/README.md) | Native-OS-chooser backend for operators at the host display | registers `ctx.directoryPicker` |
| [`directory-picker-browse/`](directory-picker-browse/README.md) | In-app directory-browser backend, including for remote clients | registers `ctx.directoryPicker` |
| [`directory-picker-auto/`](directory-picker-auto/README.md) | Host-adaptive chooser that mounts the matching backend at boot | mounts a backend |
| [`open-in-app/`](open-in-app/README.md) | Application probe, icon, and launch routes opening the workspace directory in an installed application | consumes `ctx.webServer` |
| [`plugin-inventory/`](plugin-inventory/README.md) | Read-only projection of current Loader entries | Remote `pluginInventory/list` |
| [`remote-devices/`](remote-devices/README.md) | Paired-device coordination and locally approved remote task receipts | `ctx.remoteDevices` |
| [`connections/`](connections/README.md) | Read-only SSH/GitHub connections, real probes and explicit employee grants | `ctx.connections` |
| [`compute-core/`](compute-core/README.md) | Authenticated compute reads, task admission, local execution and plugin trust planning | `ctx.computeCore` |
| [`compute-api/`](compute-api/README.md) | Evidence-scoped read-only edge-compute v8 HTTP control-plane adapter | consumed by compute plugins |
| [`plugin-lifecycle/`](plugin-lifecycle/README.md) | Transactional staging, activation, disablement, rollback and removal for verified capability plugins | deployment lifecycle API |
| [`platform-foundation/`](platform-foundation/README.md) | Shared agent, node and device identity, capability heartbeat and bounded event records | process-local directory API |
| [`node-contributor/`](node-contributor/README.md) | Redacted local capability contribution, autonomous admission, lease binding and pending earnings references | provider-neutral controller |
| [`platform-observability-contract/`](platform-observability-contract/README.md) | Cross-platform mobile capability sync and bounded observability records | metadata contract |
| [`voice-local/`](voice-local/README.md) | Bounded local Chinese audio-to-text requests | consumes `ctx.connection` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem references for the transport and the workspace records, then the layering decision behind the Web client.

- [HTTP server subsystem](../../docs/subsystems/web-server.md) — the webserver's routes, matching order, and config.
- [Workspace subsystem](../../docs/subsystems/workspace.md) — the workspace records the directory picker feeds.
- [Remote-device subsystem](../../docs/subsystems/remote-devices.md) — paired identities and finite task coordination.
- [Web config-tree boot and transport layering](../../.agents/notes/implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md) — ownership of the Web transport layers.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
