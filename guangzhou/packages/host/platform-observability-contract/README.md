---
description: "Provider-neutral mobile capability sync and bounded observability records for Qianshou agents."
kind: "package-reference"
---

# Qianshou platform observability contract

English | [中文](README.zh.md)

## Summary

This small Host package defines one metadata contract for iOS, Android, desktop and Web agent surfaces. It validates capability heartbeats, cursor-based sync requests and redacted observability events. It carries no credentials, paths, media bytes, push transport, payment or execution authority.

## Table of Contents

- [Use this package](#use-this-package)
- [Ownership](#ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>

## Use this package

Call `parseMobileCapabilityHeartbeat` at the control-plane boundary and `parseMobileSyncRequest` for bounded cursor paging. Agents report `surface` and policy-owned `acceptance`; `autonomous` permits the scheduler to consider a lease while `policy-paused` and `policy-reject` remain deterministic policy outcomes. Call `parseObservabilityEvent` before forwarding diagnostics; attribute keys reject secrets, paths and media fields.

<a id="ownership"></a>

## Ownership

Platform foundation owns identity. Dispatch owns authenticated leases and task execution. Client adapters own OS lifecycle and local notification APIs. A deployment may map these records to APNs, FCM, desktop IPC or WebSocket without changing this contract.

<a id="model-experience"></a>

## Model Experience

None. The package exposes no tools, prompts or model calls.

### KV Cache impact

None.

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- Sync is a versioned metadata contract; durable cursors, replay windows and push delivery require a separately verified adapter.
- Acceptance state is a policy input, not an authorization or payment decision.
- Observability events are bounded diagnostics; logs and metrics storage remain deployment concerns.

<a id="dev-note"></a>

## Dev Note

Keep mobile and diagnostics records provider-neutral. Never add tokens, local paths, binary payloads or payment fields to these envelopes.
