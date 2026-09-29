---
description: "Provider-neutral mobile agent shell for lifecycle, cursor sync, task cards and policy-owned unattended acceptance."
kind: "package-library"
---

# Qianshou mobile agent shell

English | [中文](README.zh.md)

## Summary

This Client package defines a small provider-neutral port for iOS, Android, desktop and Web shells. It combines the existing platform heartbeat and cursor contracts with the existing authorization types and compute task-card projection. The shell owns local lifecycle facts and deterministic task-card policy decisions; embedding adapters own login, authenticated sync and native OS APIs.

It does not open APNs or FCM, submit workloads, move media, store tokens, process payments or grant entitlements. A decision of `accept` is a policy result for the scheduler adapter, not proof that a task was accepted or executed.

## Table of Contents

- [Use this package](#use-this-package)
- [Product boundary reference](#product-boundary-reference)
- [Further exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Construct `MobileAgentShell` with an explicit `MobileAuthPort`, capability reader, metadata sync adapter and `MobileAcceptancePolicy`. Call `setSurface` and `setOnline` from the OS host, call `createHeartbeat` when the host sends a heartbeat, and call `sync` for an authenticated cursor page. Pass event-delivered or cached task-card data to `receiveTaskCard`; it parses the existing `qianshou.task-card.v1` projection before evaluating policy.

The package exports a library from `lib/index.js`; it has no Cordis plugin registration or browser plugin entry. The [build configuration](tsdown.config.ts) uses the Client-phase library preset, as recorded in the [build decision](../../../.agents/notes/implemented/bug-fix/2026-09-15-mobile-shell-library-build.md).

The policy requires a deliberate choice for background operation, maximum local concurrency and whether an unquoted card can be accepted. Quoted cards require the existing card authorization to be `approved`; an expired quote, unavailable capability, missing authentication, offline state, suspended surface or full capacity holds the card. `markTaskStarted` and `markTaskFinished` only account for the shell-owned capacity counter and never execute work.

`MobileAgentShell.sync` validates `qianshou.mobile.sync.v1`, checks the acknowledgement identity and monotonic revision, then commits the returned cursor and running-task count. The supplied adapter decides whether transport is HTTPS, WebSocket, IPC or another mechanism. Durable cursors, push delivery and server-side lease authority remain outside this package.

<a id="product-boundary-reference"></a>
## Product boundary reference

Coze's public materials present a light conversational entry, reusable templates and workflows, and plugins as tool collections that can be added to Agents or workflow nodes. Its plugin documentation also separates local-device connections from Web and mobile viewing, and its terms place plugin review and third-party API obligations on the platform and plugin users. Qianshou borrows the interaction boundary of “entry plus composable capability plus status panel” while keeping execution on desktop/shared nodes, Shanghai on the control plane, and unattended acceptance behind an explicit local policy. This package contains no Coze code, SDK or provider-specific protocol and does not claim Coze compatibility.

Sources reviewed 2026-09-15: [Coze Gallery](https://www.coze.cn/gallery), [Coze plugin overview](https://docs.coze.cn/guides_plugin), [Coze plugin creation](https://docs.coze.cn/create-plugin), and [Coze terms](https://docs.coze.cn/guides_terms-of-service).

<a id="further-exploration"></a>
## Further exploration

- [Platform observability contract](../../host/platform-observability-contract/README.md): heartbeat, cursor and bounded diagnostic records.
- [Compute task-card projection](../ui-compute/README.md): control-plane card fields and result states.
- [Authorization types](../../credentials/authorization/README.md): user-facing authorization flow vocabulary.

<a id="model-experience"></a>
## Model Experience

None. This package exposes no model tools, prompts or session events.

### Token effect

None. Mobile lifecycle and task-card decisions do not assemble model requests.

### KV Cache effect

None. The shell does not hold or modify a model context.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Native Keychain or Keystore storage, OAuth UI, APNs and FCM registration, WorkManager and BGProcessingTask scheduling remain embedding concerns.
- Real workload submission, authenticated lease handling, result retrieval, media transfer, payment, entitlement reconciliation and push replay are not implemented here.
- iOS and Android foreground, background, termination, thermal, battery, network and store-review acceptance require real-device and channel evidence.

<a id="dev-note"></a>
### Dev Note

No runtime invariant is published. The shell is a pure client adapter with explicit ports; parser, lifecycle, policy and stale-ack behavior are covered by the package client tests.
