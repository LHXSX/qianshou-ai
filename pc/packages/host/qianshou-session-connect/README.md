---
description: "Revocable device-owner authorization for one existing local Session."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-session-connect

English | [中文](README.zh.md)

## Summary

This private Host package grants access to one ordinary local Session. The authenticated device owner chooses read-only or text sending, a note and a lifetime of 1–1440 minutes. Cloud login, logout and account switching do not change these device-owner grants. Revoke a grant explicitly to end access. Child-agent Sessions cannot be granted. The [owner UI](../../client/ui-qianshou-session-connect/README.md) manages grants without changing the Session's model or permission mode.

## Table of Contents

- [Storage and authority](#storage-and-authority)
- [Text, cursors and receipts](#text-cursors-and-receipts)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="storage-and-authority"></a>
## Storage and authority

`qianshouSessionConnect` exposes owner RPCs for state, create and revoke. A separate `/qianshou-connect` HTTP prefix serves a credential-free browser shell and only read, send and receipt operations. It never issues or accepts an owner cookie as authorization. Bearer secrets arrive through URL fragments, are removed from the address bar and remain in tab-local storage; the database retains their SHA-256 digests. A grant link is returned only when created. Treat the complete link as a secret. Opening a second grant link in the same tab replaces the credential in that document and reloads the new grant; the replaced grant's unconfirmed message is discarded with it.

The new database defaults to `$DSH_HOME/qianshou/session-connect/v1.sqlite`. It contains bounded authorization metadata and hashed command identities, not a copy of the transcript. New directories/files use owner-only POSIX modes. Data is not encrypted at rest, and access under the same OS account is outside this authorization mechanism. Foreign formats are rejected. No old database, cloud token or mobile relay is imported.

An empty `publicOrigin` permits the actual loopback origin and loopback socket peers only. An explicit HTTPS origin requires an independently configured reachable TLS proxy that preserves the matching Host authority; forwarded headers grant no trust. This package does not change the server's bind address or configure a proxy. Request counts, request deadlines and retained grant/receipt counts are deployment configuration. Responses to unread uploads finish before socket closure, with a separate five-second flush limit.

<a id="text-cursors-and-receipts"></a>
## Text, cursors and receipts

Read projects only committed human and assistant text from the existing Session log. It omits tools, reasoning, files and system instructions; it does not redact secrets that a person included in ordinary text. Initial display scans the latest 200 log events, subsequent windows scan at most 200 events, and a response holds at most 25 text messages. Each message is capped at 6000 UTF-8 bytes and the complete serialized response at 240000 bytes. A grant-scoped cursor includes the latest history replacement, so changed history resets the view without looping between pages. A same-grant cursor ahead of the durable tail after restart also resets to the retained window. Histories over 100000 events are refused after inspection; underlying Session inspection still owns log loading and is not a bounded-file streaming implementation.

Text requests accept at most 4096 characters and 12000 UTF-8 bytes. The database claims a stable client request id before delivery. Concurrent identical requests share one operation; a changed body conflicts. The real Agent receives the message only after a final synchronous authorization check and retains its existing permissions. `received` follows the original Session's durability barrier and means admission, not task completion. A cold persisted Inbox insertion is sufficient to recover admission without activating an Agent. `uncertain` never triggers automatic re-execution; the recipient must check the PC. An unclaimed id returns `rejected` and may retry with that same id.

HTTP deadlines release the response while an underlying Session activation may still settle. That operation keeps its service admission slot; late activation rechecks cancellation before enqueueing. Disposal rejects new work, aborts owned operations and waits for pending Session operations before closing SQLite. It does not claim to cancel or roll back already admitted work. In-flight external activation can delay teardown.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Controlled local tests do not establish cross-device delivery; record acceptance for the actual Host, connection, and receiving device separately.

</details>

<a id="model-experience"></a>
## Model Experience

### Explicit text delivery

#### What the model sees

A text-enabled recipient's message becomes an ordinary logged `user/message` in the selected Session. The package adds no hidden prompt, tool schema, account credential or recipient identity. Read-only access and grant management invoke no model.

#### Token effect

Accepted text consumes the selected Session's ordinary input and response tokens when its Agent processes the message. Polling and receipt checks consume no model tokens.

#### KV Cache effect

Delivery appends ordinary input and does not rewrite the existing prompt prefix. Provider cache behavior remains outside this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This is a connection to one reachable PC, not cloud backup, offline multi-writer synchronization or a cross-PC replica. Phone relay, account-owned sharing, live token streaming, attachments, tools and permission approvals are absent from the narrow page. Expiry/revocation cannot erase text already viewed or copied. Active command receipts are never evicted to make room; capacity failure requires reclaimable expired/revoked grants or a configured capacity increase.

The store has no independent durable cache or duplicate transcript, so no runtime invariant companion is published. Local SQLite, real socket and Loader-composed Session/JSONL tests use synthetic data; browser-asset assembly and actual reachable-device operation require separate running-app acceptance. See the [authorization decision](../../../.agents/notes/implemented/architecture/2026-09-21-qianshou-session-connect.md).
