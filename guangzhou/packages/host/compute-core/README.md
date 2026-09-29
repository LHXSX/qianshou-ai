---
description: "Read Qianshou compute capabilities, save planning drafts and run local task plugins with verified files."
kind: "package-reference"
---

# Qianshou compute core

English | [中文](README.zh.md)

## Summary

Read an authenticated compute catalogue, save bounded local plans, publish an approved plan through the core developer-task route, and inspect workload progress. Run an already-admitted task through an exact local plugin version with verified input and output files. Cancellation drains execution before temporary files are removed. Catalogue entries do not establish online nodes, prices, spending quotes or settlement.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-compute-core` in a Host composition that supplies the authenticated Connection service. Mount `@deepseek-ai/dsh-compute-core/tools` separately when an agent may inspect capabilities and save local plans. The bridge does not add these tools automatically or start another agent loop. The real Loader composition test exercises the mount, local routes, persistence, a native capability contribution and result consumption.

`POST /api/qianshou/compute/plans/confirm` stores an owner `approved` or `declined` decision on an existing local draft. It does not quote, submit, or charge. `POST /api/qianshou/compute/plans/publish` posts an approved draft to `POST /api/v8/developer/tasks` and stores the returned workload identity. Drafts written before `authorization` or `workloadId` existed read as `pending` and `null`.

Configuration is owned by [the plugin entry](src/index.ts). Catalogue reads use the logged-in `accountSession` access token when that service is present; `tokenEnv` remains an explicit override for fixtures and profiles without an account plugin.

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | empty | Core HTTPS origin; empty disables remote reads. |
| `tokenEnv` | `QIANSHOU_CORE_TOKEN` | Optional access-token environment override. Logged-in `accountSession` tokens are used first. |
| `statePath` | `$DSH_HOME/qianshou/compute-plans.json` | Private draft path; task metadata uses a `.tasks` sibling. |
| `timeoutMs` | `15000` | Complete upstream request timeout. |
| `maxResponseBytes` | `1048576` | Upstream JSON byte ceiling. |
| `maxRequestBytes` | `65536` | Local route JSON byte ceiling. |
| `maxDrafts` | `100` | Retained local draft limit. |
| `maxStoreBytes` | `4194304` | Byte limit for each local store. |
| `maxTaskRecords` | `1000` | Retained local attempt limit. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation and provider responsibilities</summary>

The [service](src/service.ts) combines bounded core reads and local persistence with a managed native execution path. Capability plugins register exact versions in the [executor registry](src/executor.ts). The [local runner](src/local-task-runner.ts) stages authorized input streams in a private random directory, invokes that executor, verifies output files and waits for the result consumer before cleanup. Native and transfer providers must stop all their child work before returning. Local paths and credentials stay outside the browser-safe [protocol](src/protocol.ts).

The [assignment verifier](src/envelope-security.ts) binds the `qianshou.task.assignment.v1` signing domain, envelope, attempt, lease and dispatch-issued timestamp. Only its frozen process-local credentials reach the [coordinator](src/employee-task-coordinator.ts); copying a `verified` flag cannot grant admission. Trusted keys and node authorization remain the dispatch adapter's responsibility. Public package entries share the same verifier registry through a multi-entry build.

The [transport connector](src/node-transport.ts) parses authenticated offers and uses an explicitly bounded, sequential delivery queue. Invalid frames, queue overflow and consumer failure close the session; close drains any current delivery. Outgoing frames are rebuilt from allowed fields. A concrete transport still owns TLS, the actual worker protocol and endpoints. The [capability manifest](src/capability-manifest.ts) checks metadata and matching executor versions without loading downloaded code.

The [resident task loop](src/resident-loop.ts) is a transport-neutral, pull-based tick seam for an idle agent. Each tick emits a redacted heartbeat, then serially hands verified offers to the coordinator with `interactionPolicy: 'autonomous'`; overlapping ticks are drained in order and `close()` rejects new work. A host adapter supplies the timer, resource observer, offer queue and network heartbeat. This seam does not open sockets, prompt a person, or execute plugin code.

The [node lease boundary](src/node-lease.ts) gives one task attempt an explicit owner node, expiry, revocation and idempotency key. Only the owner may accept or complete a lease, only the dispatch authority may revoke it, and acceptance after expiry is rejected. The state machine is pure and immutable; it is a contract for a future transport/persistence adapter and carries no media bytes, local paths, credentials, prices or upload URLs.

The [plugin-market planner](src/plugin-market.ts) verifies a parsed manifest, package digest, host range, explicit permissions and a deployment-supplied signature before returning a frozen staging plan. It never downloads, unpacks, loads or executes package code; a deployment adapter owns the later transactional install and process isolation. GPU and local-model permissions are marked for native review, while Shanghai remains a metadata-only control plane.

After the Host build, run `node --test packages/host/compute-core/tests/public-artifacts.test.mjs` from the repository root to check Ed25519 assignment verification across built public entries. This consumes built artifacts; source behavior tests run separately. No runtime `./invariant` is published because each registry and store owns its state without a second independent projection.

</details>

-----

### Result asset acceptance

[`result-assets.ts`](src/result-assets.ts) turns verified local output files into an immutable `qianshou.result-assets.v1` manifest. It reuses the workspace verifier for SHA-256, byte size, regular-file ownership and aggregate limits, then requires one trusted capability descriptor per output. Descriptors declare a bounded MIME type and optional opaque `evidence://`, `artifact://`, or `urn:` semantic references (with optional digests). Asset IDs are deterministic for `(taskId, idempotencyKey, name, sha256)`, so retries can be deduplicated by a future transfer provider. The manifest keeps local paths only for the node-side reader; no media bytes or evidence are sent to Shanghai, and this package performs no upload, object-store lookup, or settlement.


<a id="further-exploration"></a>
## Further Exploration

- [Connection carrier](../../client/connection/README.md) — authenticated local routes.
- [Executor and assignment decisions](../../../.agents/notes/implemented/architecture/2026-09-14-qianshou-unified-executor.md) — versions, admission and signing.
- [Managed local task decision](../../../.agents/notes/implemented/architecture/2026-09-14-qianshou-managed-local-task.md) — file lifetime and shutdown.

-----

<a id="model-experience"></a>
## Model Experience

### Optional planning tools

#### What the model sees

An explicitly loaded consumer exposes `compute_capabilities`, `compute_plan_draft` and `compute_workload_read`. They return bounded catalogue data, local draft receipts and workload summaries through the existing logged tool path. They do not expose credentials, paid submission, node counts or an execution approval callback. Capability descriptions remain untrusted reference text.

#### Token effect

Three tool schemas join the enabled agent's request. Only the selected catalogue page, bounded goal and requested workload summary add tool-result content. A successful `compute_plan_draft` also persists `qianshou.task-card.v1` observations on `tool/result.meta` so the conversation can replay the plan card.

#### KV Cache effect

Tool definitions remain fixed when catalogue data changes; live data appears in logged results. Loading or unloading the tool consumer changes the agent's schema set.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Deployment integrations retain these obligations:

- Private directories, frozen envelopes and file checks are not an OS sandbox. They cannot prevent a privileged operator or concurrent mutation after inspection; native plugins require process isolation and artifact servers must verify authorized object keys and digests.
- Input and transfer providers own authenticated task access and cancellation. The result consumer must finish reads and uploads before returning because cleanup then deletes the attempt workspace.
- Real worker leases, remote cancellation, input download APIs, artifact uploads, live hardware discovery and H3/image/video plugins are not wired into the resident loop's transport or execution adapters. The loop itself only sequences heartbeats and verified admission.
- Catalogue reads on the shipped web profile use the Shanghai origin and the logged-in account session. Formal quotes, node assignment and settlement remain unmounted. An unknown developer-task POST is never retried automatically. Conversation goals that the catalogue does not accept as `inline` are refused.
- Prices, budget authorization, paid submission, market installation/signing and node settlement require separate verified integrations. Local fixtures do not prove production, mobile-device or store acceptance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
