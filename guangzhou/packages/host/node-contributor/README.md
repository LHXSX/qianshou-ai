---
description: "Run an explicitly enabled Qianshou compute contributor with redacted inventory, autonomous admission and lease-bound earnings references."
kind: "package-library"
---

# Qianshou node contributor

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-host-node-contributor` is the provider-neutral controller for a local agent that has explicitly enabled compute contribution. It inventories self-tested capabilities, publishes a minimal heartbeat, admits verified offers autonomously under the existing contributor policy, binds each accepted attempt to a node lease, and emits a pending billing ledger reference only after core acceptance evidence exists.

The package composes `compute-core`, `dispatch-adapter`, `platform-foundation` and `billing-contract`. It does not create another queue, execute a model, open a socket, upload files, read credentials, settle money or connect to a production node.

## Table of Contents

- [Control-plane boundary](#control-plane-boundary)
- [Authorization and shutdown](#authorization-and-shutdown)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="control-plane-boundary"></a>
## Control-plane boundary

`inventory()` exposes capability IDs, versions and plugin digests plus bounded capacity. The advertised projection has explicit privacy guarantees and contains no user file list, local path, prompt, credential, media byte or upload URL. A concrete dispatch adapter owns authentication and transport; Shanghai receives control metadata only.

`acceptOffer()` requires the process-local verification credential minted by `compute-core` and checks exact task, attempt, expiry, owner and idempotency bindings in the node lease. Capability data scope and input/output byte limits are checked before the shared `EmployeeTaskCoordinator` and `ComputeTaskStore` admit work. Accepted work is marked autonomous and has no human approval callback.

`pause()` and `revoke()` publish local state only after the existing task store commits the transition. A refused transition preserves the previous visible state and lease. The host must stop and drain execution before reporting a pause or revoke; this controller owns no executor. `reportCompleted()` forwards a core-confirmed pending earnings reference without mutating a ledger or initiating payment.

<a id="authorization-and-shutdown"></a>
## Authorization and shutdown

The constructor copies the owner's authorization limits. `acceptOffer()` combines them with the current per-offer policy using the stricter limits; an offer cannot broaden the owner's authorization. Either policy being `OFF` refuses new work. Foreground or voice activity and unavailable resource facts are checked by the existing contribution policy. A temporary refusal remains retryable when the host becomes idle.

A controller configured `OFF` publishes an empty capability advertisement and remains `DISABLED`. Installed capability descriptors remain available for local inspection. Per-offer restrictions apply to that invitation; replacing the owner's saved authorization requires closing the controller and constructing one with the new settings. Disabling future admission does not cancel an already admitted task.

`close()` rejects new operations, closes the shared coordinator and waits for in-flight transport callbacks. Late completion cannot restore an online state. The caller retains any already committed task record for reconciliation; shutdown does not manufacture a cancellation or completion receipt. Transport adapters must bound and finish their callbacks because this controller cannot abort them.

<a id="model-experience"></a>
## Model Experience

This package exposes no model tools and never joins the CEO conversation. A resident host may call `advertise()` and `acceptOffer()` from its background loop. User activity, voice activity, resource ceilings and concurrency remain the existing `ContributorPolicy` decision inputs.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The package has no production transport, authentication key store, input transfer, output upload, sandbox or native capability implementation.
- Inventory readers and dispatch adapters are deployment-owned and must provide trusted local facts; unavailable resource facts must fail closed before admission.
- Earnings are references to a core-confirmed pending ledger entry. Pricing, settlement, refunds, tax and withdrawal remain owned by the commercial system.
- Tests use a local temporary task store and fake transport. They prove policy, lease, scope, privacy and lifecycle boundaries, not real node or payment acceptance.

<a id="dev-note"></a>
### Dev Note

Keep this package as orchestration only. Extend `compute-core` or the billing/dispatch contracts first when a new wire field, durable state or settlement transition is required.
