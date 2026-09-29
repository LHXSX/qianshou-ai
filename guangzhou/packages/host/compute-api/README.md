---
description: "Read-only adapter for the documented edge-compute v8 HTTP control plane."
kind: "package-library"
---

# @deepseek-ai/dsh-host-compute-api

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

This package gives host plugins one bounded, authenticated client for the edge-compute v8 control-plane GET routes proven by the current platform source inventory. It reads identity, task-type catalogues, workloads, shard metadata and result metadata. It does not submit workloads, quote prices, cancel jobs, download media, or implement scheduling and settlement.

<a id="table-of-contents"></a>
## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Create `createComputeApiClient({ baseUrl, accessToken, maxResponseBytes })` from a deployment-owned credential provider. The client sends only `GET` requests under `/api/v8`, adds a bearer token, bounds response bytes, validates the endpoint's JSON container, and maps upstream failures to stable errors. The client retains the supplied credential in memory but never persists or logs it; create a new client after credential rotation.

Methods map to `GET /api/v8/auth/me`, `/developer/task-types`, `/workloads`, `/workloads/{id}`, `/workloads/{id}/shards`, and `/workloads/{id}/result`. `workloads()` returns the unwrapped, frozen array of shallow-frozen records, including an empty array when no tasks are visible. It rejects object wrappers and non-object entries with `COMPUTE_API_RESPONSE_INVALID`. Other methods retain object-only validation. Fields remain opaque platform-owned data; callers select display-safe fields before forwarding results to a UI or log.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/index.ts` owns URL validation, path-safe identifiers, request headers, bounded streaming reads, endpoint-specific JSON validation, and error mapping. A caller supplies `fetch` in tests or a deployment transport; TLS, proxy policy, credential refresh, retries and rate limits remain outside this package. No media bytes cross this control-plane adapter.

<a id="model-experience"></a>
## Model Experience

None. This package registers no tools, prompts, model calls or session events.

#### KV Cache effect

None.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Write routes (`quote`, `estimate`, workload creation and cancellation) are intentionally absent until their complete idempotency, budget and refund contracts are verified.
- The documented download route is absent so media transfer stays with a node, Guangzhou service or workbench asset adapter.
- No real endpoint, credential, network or production acceptance is claimed by unit tests.

<a id="dev-note"></a>
### Dev Note

The [workload list decision](../../../.agents/notes/implemented/bug-fix/2026-09-15-qianshou-workload-list-response.md) records the source revision and verified response declaration. Expand endpoints only with source evidence and tests; source inspection and fixture tests do not establish production acceptance.
