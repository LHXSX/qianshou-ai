---
description: "Provider-neutral bridge for an autonomous Qianshou node and the dispatch control plane."
kind: "package-library"
---

# Qianshou scheduling client

English | [中文](README.zh.md)

## Summary

`SchedulingClient` is the narrow adapter seam between an autonomous agent and a dispatch centre. It combines a deployment-owned authenticated transport with the already verified read-only compute API. It defines versioned heartbeat, offer, accept/reject, progress, result metadata and revoke frames without opening sockets or guessing undocumented routes.

## Table of Contents

- [Control-plane boundary](#control-plane-boundary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="control-plane-boundary"></a>
## Control-plane boundary

The `qianshou.scheduler.control.v1` frames contain task and asset metadata only. Input/output bytes, local paths, credentials, prices and upload URLs remain on the node or a future transfer adapter. `readCatalogue()` uses [the compute API client](../compute-api/README.md) to query `/api/v8/auth/me`, `/api/v8/developer/task-types`, and `/api/v8/workloads` without a node connection. It returns identity and task-type objects plus the unwrapped, read-only workload array. It sends no write requests. The transport owns TLS, token exchange, endpoint allow-list and reconnect policy.

Decision records are idempotent per `(taskId, attempt)`. Repeating an identical accept/reject does not send a second frame; conflicting decisions fail closed. A later adapter may persist this map and verify signed offers/revokes before dispatching to the resident loop.

<a id="model-experience"></a>
## Model Experience

None. The client exposes methods to a host composition; it registers no model tools.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- No production WebSocket/HTTP implementation, lease signature verifier, durable idempotency store, remote cancellation, media upload, payment or settlement is included. Endpoint expansion requires current API source evidence and contract fixtures first.

<a id="dev-note"></a>
### Dev Note

Keep this package provider-neutral and small. Shanghai remains a control-plane location; media transfer belongs to the contributing node, Guangzhou service or workbench.
