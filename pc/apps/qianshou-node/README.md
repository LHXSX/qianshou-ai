---
description: "Built-in inline execution and lifecycle reporting for the Qianshou development node."
kind: "reference"
---

# Qianshou development node

English | [中文](README.zh.md)

## Summary

The [daemon](node-daemon.mts) connects an explicitly authorized device to the Edge scheduler. It starts paused and uses measured host supply plus an explicit task scope. This source entry does not establish an installed desktop release or an autonomous agent executor.

## Execution

The [offer handler](execute-offer.ts) accepts inline text for `word_count` and its `text.transform` alias. It rejects unsupported task types, null inline input and file references before reporting execution. It never fetches `code_url`. The transport separately enforces the configured task scope and running mode.

The daemon passes each admitted offer to the order-acceptance agent. That agent subtracts `startedAtMs` from its own clock, which defaults to `Date.now`; the start sample must come from that same clock. `execute-offer.ts` still measures its own elapsed pair with `performance.now()`.

That handler sends `shard_progress` with zero progress and the original assignment credentials before running. Its result carries elapsed milliseconds measured with a monotonic clock. A result send receipt means `sent-awaiting-verification`; Shanghai owns acceptance, execution accounting and settlement. Repeated successful deliveries of the same assignment are deduplicated by the existing transport.

Execution or result submission failure sends `EDGE_EXECUTION_FAILED` without raw exception or task text. Failure to send progress or the failure frame propagates to the connection owner. Cancelled connections cannot send a late completion. Built-in execution is synchronous; it does not provide mid-computation cancellation or a model planning loop.

## Verification and limits

The [tests](tests/execute-offer.spec.ts) exercise the real transport over a test-owned local socket and compare outgoing progress and result frames with an [expected transcript](tests/expected/execution-success.json). They cover measured duration, unsupported input, cancellation, duplicate successful delivery and result-size failure. They do not prove a production database update, packaged application installation or business settlement.

Supply probing describes installed tools and packages. This handler does not execute every capability advertised by those probes; capability advertisement and executor coverage still require separate reconciliation.

## Local status surface

The [status endpoint](node-status-server.ts) publishes what this node is doing, on `127.0.0.1` only, so the owner's own surface (and later the PC client) reads machine data instead of parsing terminal output. `GET /status` returns the [snapshot](node-status.ts): connection state and reason, uptime, the running shards, received/accepted/succeeded/failed/rejected counters, the last refusal, and recent results with their polled-verification outcome. `POST /command` takes the owner's two commands, `{"command":"tasks"}` and `{"command":"abort","target":"<shardId>"|"all","reason":"..."}`. The abort sends the existing refusal frame carrying `EDGE_CANCELED_BY_OWNER`, records `canceled-by-owner`, and is never counted as a failure or given a retry.

Binding the loopback address is a hard requirement rather than a default: `startNodeStatusSurface` has no host parameter at all, non-loopback peers are refused by an explicit authorization check, browser-originated requests are refused outright, and an optional owner proof is read from `QIANSHOU_NODE_OWNER_PROOF` only. The snapshot reports estimated earnings as unavailable instead of guessing, because the dispatch frame carries no price field.

## Further exploration

- [Execution reporting decision](../../.agents/notes/implemented/bug-fix/2026-09-19-node-execution-reporting.md).
- [Compute core](../../packages/host/compute-core/README.md).
