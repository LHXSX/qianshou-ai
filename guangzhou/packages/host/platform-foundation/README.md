---
description: "Shared identity, capability and event records for Qianshou host plugins."
kind: "package-reference"
---

# Qianshou platform foundation

English | [中文](README.zh.md)

## Summary

This small Host package gives independent plugins one vocabulary for agent, node and paired-device identities, capability advertisements, heartbeats and bounded control-plane events. It reuses existing `SessionId`, `ComputeNodeId`, `DeviceId` and node capability records. It contains no model runner, media bytes, transport, payment or plugin implementation.

## Table of Contents

- [Use this package](#use-this-package)
- [Ownership](#ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>

## Use this package

Register a validated participant with `PlatformDirectory.register`, update its liveness with `heartbeat`, and publish transport-decoded events with `publish`. `parsePlatformEvent` is the wire admission function. `registrationFromNodeHeartbeat` converts the existing `qianshou.node.v1` heartbeat without copying paths or credentials. The directory is process-local and returns cloned snapshots; a deployment may persist or transmit those snapshots through its own adapter.

<a id="ownership"></a>

## Ownership

Identity issuance remains with Session, compute dispatch or paired-device authentication. Capability implementations own execution and output files. Transport adapters own TLS, authentication and retries. This package only validates shared metadata and isolates event-listener failures so one observer cannot stop control-plane publication.

<a id="model-experience"></a>

## Model Experience

None. The package registers no tools, prompts, model calls or user-facing UI.

### KV Cache impact

None.

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- The directory is process-local; crash recovery and durable participant leases belong to a deployment adapter.
- Event signatures, replay windows and network delivery are intentionally absent until a dispatch transport contract is verified.
- Capability records describe availability but do not authorize execution or spending.

<a id="dev-note"></a>

## Dev Note

Keep this package metadata-only. Add a transport, persistence or execution adapter as a separate package with its own evidence and lifecycle tests.
