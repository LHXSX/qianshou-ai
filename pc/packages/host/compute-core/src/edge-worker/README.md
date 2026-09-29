# Isolated Edge worker transport

English | [中文](README.zh.md)

This module speaks the audited Edge WebSocket protocol against an explicitly isolated service reached through a literal loopback origin. It does not install an app, download code, execute tasks, create accounts, or authorize production spending. The Host supplies authenticated identity, measured hardware, execution policy and an autonomous session callback.

## Contract and Host ownership

Use `EdgeWorkerConnection` from [connection.ts](connection.ts), with the DTOs in [types.ts](types.ts). `connect(signal?)` sends hello/auth and starts paused. After the Host establishes task authorization, `updateMode('running')` permits offers. `onOffer(offer, signal)` receives task data and an abort signal. The Host independently checks its allowed workload, input scope, tools and workspace before creating an isolated agent session. Network capability labels or a code URL are not authorization.

The actual route is `/api/v8/ws/worker`, subprotocol `edgecompute.v8`, frame version `8.0`. `client_version: 8.0.0` names the core wire protocol, not the agent product release. The source baseline is the Shanghai V8 source snapshot, with `platform_v8/protocol/ws_schema.py` and `services/artifact_lease.py` defining the native assignment and lease. The worker identity comes from `auth_ok` and must match the configured owner account. An optional previously acknowledged `workerId` supports reconnecting the same node.

A task identity is `{workerId, workloadId, shardId, attempt}`. Native attempts start at zero. The opaque server token stays in a private map and is never included in the offer, agent prompt, result receipt or public events. It is not a signature over the agent's full capability envelope. Empty execution-model/capability/version strings remain empty. `codeUrl` and `codeSha256` remain untrusted task data; this transport never fetches or runs them.

`reportProgress(identity, fraction)` uses the original lease. `complete(identity, {inlineOutputUtf8, elapsedMs})` sends the existing raw inline-output form and returns `sent-awaiting-verification`. It does not claim server acceptance, result retrieval or settlement. The Host then queries the authoritative workload and retrieves results. Session IDs and tool-call provenance belong to Host evidence and are not invented server fields. Artifact uploads are not implemented here.

## Cancellation and lifecycle

The Host must honor every callback's AbortSignal. Closing or losing the connection aborts active sessions; `close()` drains them. A legacy `shard_cancel` has no attempt. The adapter closes with `EDGE_CANCEL_RECONCILIATION_REQUIRED` instead of guessing which local attempt to cancel. A conflicting active attempt also requires reconciliation. The same delivered tuple invokes the callback at most once during a connection; the Host needs persistent reconciliation across connections.

Changing to paused updates future-supply heartbeat state. It does not cancel an executing lease. This first adapter handles bounded isolated test sessions and does not implement production reconnection, capability publication, account login UI, or durable result outbox. An injected `onOffer` that ignores cancellation can prevent `close()` from draining.

## Validation and evidence

Run `node node_modules/typescript/bin/tsc -p packages/host/compute-core/tests/edge-worker/tsconfig.json` and `node node_modules/vitest/vitest.mjs run packages/host/compute-core/tests/edge-worker` from the repository root. Focused tests cover native attempt zero, identity binding, private tokens, raw output, duplicate offers, mismatched owner, scope rejection and cancel drain. The repository test aliases resolve the existing atomic-write dependency used by supply errors.

The separately authorized Shanghai environment uses its own SQLite database, Redis, storage and newly registered accounts. Actual HTTP identity/catalogue/workload/quote and WebSocket authentication/heartbeat passed across SSH. A separate fixed-script transport probe reached authoritative DONE with raw result bytes; that probe is explicitly not autonomous-agent acceptance. The zero-budget test creates a zero-value ESCROW_RELEASE record while balances remain zero. No production database, credentials or real ledger data are copied.

Source defects required two isolated candidate repairs: optional Film admission/planner dependencies are imported only under their original task predicates; Film still calls the original authorization and missing dependencies fail closed. Nine focused Python tests pass. The original production source remains untouched. Further SQLite diagnostics, an empty developer catalogue and missing optional Writing modules remain recorded integration limits. Production capability authorization, signed full-envelope mapping and commercial settlement are unverified.
