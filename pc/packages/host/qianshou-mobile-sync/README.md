---
description: "PC-side session port for the Qianshou phone relay: owner-checked reads and text admission into the original Session, admitted at most once."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-mobile-sync

English | [中文](README.zh.md)

## Summary

The phone is a window onto this PC's Sessions, not a second place where work runs. This package registers the PC at the relay for whichever account is signed in, answers the five forwarded read operations, and admits one phone text command into the original Session at most once. The Session log stays the sole history; this package stores only which requests were claimed and what could be proven about them.

## Table of Contents

- [The owner is checked on both sides of every Session touch](#the-owner-is-checked-on-both-sides-of-every-session-touch)
- [One command is admitted at most once](#one-command-is-admitted-at-most-once)
- [Identity and storage](#identity-and-storage)
- [Configuration](#configuration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="the-owner-is-checked-on-both-sides-of-every-session-touch"></a>
## The owner is checked on both sides of every Session touch

Each forwarded request names the account the relay verified for the phone. That principal is compared against the account signed in on this PC before the Session is touched and again afterwards, and a mismatch is an explicit `PC_WINDOW_OWNER_CHANGED` refusal rather than a silent pass. A signed-out PC refuses with `PC_WINDOW_NOT_SIGNED_IN`. Signing out or switching accounts revokes every binding before the old registration leaves the relay.

A binding names four axes together: account, PC, original Session and phone. All four take part in the storage key, so two accounts or two PCs cannot collide. A binding for another PC is unknown to this one. `access` answers `unauthorized` for an unknown or revoked binding, so the phone can offer re-pairing instead of reading an error, while a changed owner still refuses.

<a id="one-command-is-admitted-at-most-once"></a>
## One command is admitted at most once

The phone's `requestId` is the idempotency key of the whole port. A request is claimed durably before the Session is touched, which assigns its position in the binding's receipt stream and derives the request identity the Session sees. The same id with the same body returns the stored receipt; the same id with a different body is `PC_WINDOW_REQUEST_CONFLICT`. Two concurrent retries of one command collapse into a single admission.

Only a Session durability barrier turns a claim into `received`. When admission fails, this package asks the Session log whether the request already arrived, because the log is the only proof either way: an admission that happened before the failure is reported as `received`, and an unprovable attempt stays `uncertain` with a recorded reason. `uncertain` never permits an automatic resend, and a received outcome is never overwritten by a later failure reason. Only the ids a `sync` page reports in `notReceivedIds` were never claimed here and may be sent again.

Re-pairing the same phone restores a revoked binding without rewinding its receipt cursor, so a reconnect cannot replay an already admitted command as a new one.

<a id="identity-and-storage"></a>
## Identity and storage

This PC's identity is an opaque id: a configured value wins, otherwise the private file beneath `DSH_HOME` is read strictly, and only a missing file causes one UUID to be generated and written owner-only. A malformed, foreign or oversized identity file is refused, because silently generating a replacement would register this machine as a different PC at the relay.

The dedicated SQLite database carries its own application id and refuses any other file, including the session-connect database. It holds bindings and receipts only: no Session history, no message text and no credential. Command bodies are kept as SHA-256 digests, which is enough to detect a changed body under a reused id.

<a id="configuration"></a>
## Configuration

`relayUrl` defaults to the Guangzhou gateway host plus the mobile-PC relay prefix. `pcId`, `pcIdPath` and `path` default to empty, which resolves the identity file and the database beneath `$DSH_HOME/qianshou/mobile-sync`.

`accountPollMs` defaults to 2000 and reads the account snapshot on an interval because the account plugin publishes no change event. `pollWaitMs` defaults to 25000 and must stay below `requestTimeoutMs`, which defaults to 40000; loading refuses the reverse at once. `reconnectMinMs` and `reconnectMaxMs` default to 1000 and 30000. `replyCacheSize` defaults to 256, so a relay redelivery is answered without re-executing. `maxBindings` defaults to 100, `maxReceipts` to 10000, `maxRequests` to 8, and `sessionTimeoutMs` to 15000.

When `serveInbound` is true this PC does not long-poll. It registers `POST /api/qianshou/account/adopt-browser`, `POST /api/qianshou/account/state` and the five `/api/qianshou/mobile/pc-window/*` routes Guangzhou already forwards, and it keeps a paused Shanghai worker heartbeat whose `window_origin` is `https://pc.qianshousuanli.com` or `https://pc-win.qianshousuanli.com`. The acknowledged worker id is the binding `pcId`. Device-only bootstrap selects the newest non-blank Session. Phone text is admitted into that Session as an ordinary user message. A task assignment on the worker socket is refused. `accountOrigin` defaults to `https://qianshousuanli.com`. An empty `windowOrigin` follows this process's operating system.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Local admission receipts do not establish a deployed phone client or actual device pairing.

</details>

<a id="model-experience"></a>
## Model Experience

### Admitted companion commands

#### What the model sees

An admitted command becomes an ordinary `user` message in the original Session, indistinguishable from one typed on this PC. Nothing else here reaches a model: bindings, receipts, cursors and the status Remote are never part of a model request.

#### Token effect

An admitted command consumes ordinary conversation tokens for its text. Reads, receipts and status add none.

#### KV Cache effect

An admitted message extends the Session context like any other user message. No other operation alters the context or its KV cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The `/pc/*` relay endpoints this link calls are this package's proposal and are not served by the deployed gateway yet, so no end-to-end phone-to-PC run has been accepted. Tests cover owner checks, idempotent admission, identity resolution, storage, relay-link reconnect and backoff, reply caching, registration transitions, and account-watch poll delivery.
- `cancel` is parsed and then refused with `PC_WINDOW_ACTION_UNSUPPORTED`; interrupting a running turn from a phone needs a cancel port first.
- A receipt proves admission, never task completion, and a missing receipt never implies non-delivery.
